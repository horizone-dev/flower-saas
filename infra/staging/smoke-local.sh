#!/usr/bin/env bash
# LOCAL staging smoke test (Docker Desktop; nothing remote, no real credential). Repeatable evidence for the release checks:
#   bash infra/staging/smoke-local.sh <api-image> <migrate-image> <pos-image> <owner-image>
# The API/migrate images must contain the approved R-1 behaviour (SECRETS_PROVIDER=disabled), otherwise production mode cannot boot.
# It generates RANDOM disposable secrets into infra/staging/.env.smoke (git-ignored), starts the stack on 8080/8443 with Caddy's internal CA,
# runs the operator bootstrap + two tenants, the Owner Web enrolment browser spec over HTTPS, and prints PASS/FAIL per check. It tears the
# stack down (this project only) at the end unless KEEP=1.
set -uo pipefail
cd "$(dirname "$0")"
API=${1:?api image}; MIG=${2:?migrate image}; POS=${3:?pos image}; OWN=${4:?owner image}
C="docker compose -f docker-compose.staging.yml --env-file .env.smoke"
R="--resolve ops.flower.localhost:8443:127.0.0.1 --resolve pos.flower.localhost:8443:127.0.0.1 --resolve owner.flower.localhost:8443:127.0.0.1"
PW='violet-meadow-slow-river-47!'
OPPW='tangerine-orbit-quiet-harbor-82'
FAILS=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; FAILS=$((FAILS+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', expected '$3')"; fi; }
J()    { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)$1??'')}catch{console.log('')}})"; }
psqlq(){ $C exec -T postgres psql -U postgres -d flower -At -c "$1" | tr -d '\r'; }

node -e "
const r=()=>require('crypto').randomBytes(18).toString('hex');
const e=['POS_HOST=pos.flower.localhost','OWNER_HOST=owner.flower.localhost','OPS_HOST=ops.flower.localhost','ADMIN_CIDR=172.16.0.0/12','HTTP_PORT=8080','HTTPS_PORT=8443','CADDYFILE=./Caddyfile.local',
'API_IMAGE=$API','POS_IMAGE=$POS','OWNER_IMAGE=$OWN','MIGRATE_IMAGE=$MIG','MIGRATION_MODE=check',
'POSTGRES_SUPERUSER_PASSWORD='+r(),'POSTGRES_DB=flower','APP_DB_PASSWORD='+r(),'PLATFORM_DB_PASSWORD='+r(),'REDIS_PASSWORD='+r(),'MINIO_ROOT_USER=flower_minio','MINIO_ROOT_PASSWORD='+r(),'AUTH_JWT_SECRET='+r(),'SECRETS_PROVIDER=disabled'];
require('fs').writeFileSync('.env.smoke',e.join('\n')+'\n')"
echo "== config"; node preflight.mjs .env.smoke --local >/dev/null && ok "preflight accepts the generated env" || bad "preflight"
node check-release.mjs .env.smoke >/dev/null && ok "start order / ports / healthchecks / workflows" || bad "check-release"

echo "== read-only migration check, then deploy (backup -> migrate -> roles -> seed -> api -> web -> proxy)"
MIGRATION_MODE=check $C run --rm migrate 2>&1 | grep -q '"mode":"check"' && ok "check mode lists pending approved migrations" || bad "check mode"
MIGRATION_MODE=deploy timeout 560 $C up -d --wait >/dev/null 2>&1 && ok "whole stack healthy in production mode" || bad "stack did not become healthy"
chk "all four readiness checks ok" "$($C exec -T api node -e "fetch('http://127.0.0.1:3001/readyz').then(async r=>console.log((await r.json()).status))" | tr -d '\r')" "ok"

echo "== HTTPS and exposure"
chk "http redirects to https" "$(curl -s -o /dev/null -w '%{http_code}' $R http://pos.flower.localhost:8080/login)" "308"
HDR=$(curl -sk $R -D - -o /dev/null https://pos.flower.localhost:8443/login | tr -d '\r')
echo "$HDR" | grep -qi '^strict-transport-security' && ok "HSTS header" || bad "HSTS header"
chk "platform realm hidden on the shop host" "$(curl -sk $R -X POST -H 'content-type: application/json' -d '{}' -o /dev/null -w '%{http_code}' https://pos.flower.localhost:8443/v1/platform/auth/login)" "404"
for p in 5432 6379 9000 3001; do (curl -s -m 2 http://127.0.0.1:$p/ -o /dev/null && bad "port $p open") || ok "port $p not published"; done
for v in tls1_3 tls1_2; do MSYS_NO_PATHCONV=1 docker run --rm --network flower-staging_default alpine/openssl s_client -connect caddy:443 -servername pos.flower.localhost -$v </dev/null 2>&1 | grep -q "Cipher is [A-Z]" && ok "$v accepted" || bad "$v"; done
# a REFUSED handshake makes s_client exit non-zero, which `pipefail` would turn into a failed pipeline: capture the output first
TLS11=$(MSYS_NO_PATHCONV=1 docker run --rm --network flower-staging_default alpine/openssl s_client -connect caddy:443 -servername pos.flower.localhost -tls1_1 </dev/null 2>&1 || true)
echo "$TLS11" | grep -qF "Cipher is (NONE)" && ok "tls1_1 refused" || bad "tls1_1 not refused"

echo "== first operator (TOTP) and two tenants through the operator host"
chk "bootstrap CLI refuses without a terminal" "$($C --profile bootstrap run --rm -T bootstrap-operator --email a@b.co --name x 2>&1 | grep -c 'cannot run unattended')" "1"
cat > .smoke-boot.mjs <<'EOF'
import { createPrismaClient } from '@flower/db';
import { authenticator } from 'otplib';
import { PasswordService } from '/app/dist/common/crypto/password.service.js';
import { TotpService } from '/app/dist/common/crypto/totp.service.js';
import { bootstrapPlatformOperator } from '/app/dist/tooling/platform-operator-bootstrap.js';
import { PlatformOperatorBootstrapRepository } from '/app/dist/tooling/platform-operator-bootstrap.repository.js';
const prisma = createPrismaClient({ connectionString: process.env.PLATFORM_DATABASE_URL });
const totp = new TotpService(); const pw = new PasswordService(); const secret = totp.generateSecret();
await bootstrapPlatformOperator({ hashPassword: (p) => pw.hash(p), verifyTotp: (c, s) => totp.verify(c, s), repo: new PlatformOperatorBootstrapRepository(prisma) },
  { email: 'ops@flower-ops.example', name: 'Ops Lead', password: process.env.OP_PW, totpSecret: secret, totpCode: authenticator.generate(secret) });
console.log(JSON.stringify({ secret })); await prisma.$disconnect();
EOF
docker cp .smoke-boot.mjs flower-staging-api-1:/app/boot.mjs
SECRET=$($C exec -T -e OP_PW="$OPPW" api node boot.mjs 2>&1 | tail -1 | J .secret)
code(){ $C exec -T api node -e "import('otplib').then(m=>console.log(m.authenticator.generate('$1')))" | tr -d '\r\n'; }
TOKEN=$(curl -sk $R -X POST -H 'content-type: application/json' -d "{\"email\":\"ops@flower-ops.example\",\"password\":\"$OPPW\",\"code\":\"$(code "$SECRET")\"}" https://ops.flower.localhost:8443/v1/platform/auth/login | J .accessToken)
[ ${#TOKEN} -gt 100 ] && ok "operator signs in with password AND code" || bad "operator login"
chk "operator login without the code is refused" "$(curl -sk $R -X POST -H 'content-type: application/json' -d "{\"email\":\"ops@flower-ops.example\",\"password\":\"$OPPW\"}" -o /dev/null -w '%{http_code}' https://ops.flower.localhost:8443/v1/platform/auth/login)" "401"
PLAN=$(psqlq "select pv.id from plan_version pv join plan p on p.id=pv.\"planId\" where p.key='starter' and pv.status='PUBLISHED' limit 1")
for n in one two; do
  INV=$(curl -sk $R -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "idempotency-key: smoke-$n-$RANDOM" -d "{\"slug\":\"pilot-$n\",\"name\":\"Pilot $n\",\"region\":\"AE\",\"companyCountryCode\":\"AE\",\"businessTypeKey\":\"FLOWER_FLORIST\",\"planVersionId\":\"$PLAN\",\"ownerEmail\":\"owner@pilot-$n.example\"}" https://ops.flower.localhost:8443/v1/platform/tenants | J .setPasswordToken)
  chk "tenant $n: owner invite redeemed once" "$(curl -sk $R -o /dev/null -X POST -H 'content-type: application/json' -d "{\"token\":\"$INV\",\"newPassword\":\"$PW\"}" -w '%{http_code}' https://pos.flower.localhost:8443/v1/auth/set-password)" "201"
done

echo "== Owner Web authenticator enrolment in a real browser over HTTPS"
node -e "require('fs').writeFileSync('.smoke-creds.json',JSON.stringify({slug:'pilot-one',owner2:{email:'owner@pilot-one.example',password:'$PW'}}))"
CLI=$(cd ../../apps/pos-pwa && node -e "console.log(require('module').createRequire(process.cwd()+'/package.json').resolve('@playwright/test/cli'))")
(cd ../../apps/pos-pwa && E2E_CREDS_FILE=../../infra/staging/.smoke-creds.json OWNER_BASE_URL=https://owner.flower.localhost:8443 node "$CLI" test -c playwright.staging.config.ts 2>&1 | tr -d '\033' | grep -E "passed|failed") | grep -q "2 passed" && ok "browser: enrolment + HttpOnly/Secure cookie + sign-in with code (2 tests)" || bad "browser spec"
chk "tenant one owner has exactly one CONFIRMED authenticator" "$(psqlq "select string_agg(f.status,',') from mfa_factor f join \"user\" u on u.id=f.\"userId\" join tenant t on t.id=u.\"tenantId\" where t.slug='pilot-one'")" "CONFIRMED"
chk "browser sign-out revoked the server sessions (no session of tenant one's owner left active except the expiry test's)" "$(psqlq "select (count(*) filter (where s.\"revokedAt\" is null) <= 1)::text from session s join \"user\" u on u.id=s.\"userId\" join tenant t on t.id=u.\"tenantId\" where t.slug='pilot-one'")" "true"
AS=$(psqlq "select f.\"secretRef\" from mfa_factor f join \"user\" u on u.id=f.\"userId\" join tenant t on t.id=u.\"tenantId\" where t.slug='pilot-one' limit 1")
chk "the authenticator secret appears in NO service log" "$($C logs 2>&1 | grep -c "$AS")" "0"

echo "== tenant isolation with real data"
S1=$AS; CH=$(curl -sk $R -X POST -H 'content-type: application/json' -d "{\"workspaceSlug\":\"pilot-one\",\"email\":\"owner@pilot-one.example\",\"password\":\"$PW\"}" https://pos.flower.localhost:8443/v1/auth/login | J .mfaChallenge)
T1=$(curl -sk $R -X POST -H 'content-type: application/json' -d "{\"mfaChallenge\":\"$CH\",\"code\":\"$(code "$S1")\"}" https://pos.flower.localhost:8443/v1/auth/mfa/verify | J .accessToken)
T2=$(curl -sk $R -X POST -H 'content-type: application/json' -d "{\"workspaceSlug\":\"pilot-two\",\"email\":\"owner@pilot-two.example\",\"password\":\"$PW\"}" https://pos.flower.localhost:8443/v1/auth/login | J .accessToken)
C1=$(psqlq "select c.id from company c join tenant t on t.id=c.\"tenantId\" where t.slug='pilot-one' limit 1"); B1=$(psqlq "select b.id from branch b join tenant t on t.id=b.\"tenantId\" where t.slug='pilot-one' limit 1")
C2=$(psqlq "select c.id from company c join tenant t on t.id=c.\"tenantId\" where t.slug='pilot-two' limit 1"); B2=$(psqlq "select b.id from branch b join tenant t on t.id=b.\"tenantId\" where t.slug='pilot-two' limit 1")
[ ${#T1} -gt 100 ] && [ ${#T2} -gt 100 ] && ok "both owners have sessions" || bad "owner sessions (T1=${#T1} T2=${#T2})"
chk "tenant one creates a customer" "$(curl -sk $R -X POST -H "authorization: Bearer $T1" -H 'content-type: application/json' -H "idempotency-key: iso-$RANDOM" -d '{"displayName":"TENANT-ONE-SECRET-CUSTOMER","phone":"+971500000001"}' -o /dev/null -w '%{http_code}' https://pos.flower.localhost:8443/v1/companies/$C1/customers)" "201"
chk "tenant one sees its customer" "$(curl -sk $R -H "authorization: Bearer $T1" https://pos.flower.localhost:8443/v1/companies/$C1/customers | grep -c TENANT-ONE-SECRET)" "1"
chk "tenant TWO's owner reading tenant one's customers sees nothing of it" "$(curl -sk $R -H "authorization: Bearer $T2" https://pos.flower.localhost:8443/v1/companies/$C1/customers | grep -c TENANT-ONE-SECRET)" "0"
chk "tenant two -> tenant one receipt identity is refused (404)" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' https://pos.flower.localhost:8443/v1/companies/$C1/branches/$B1/receipt-identity)" "404"
chk "tenant two -> tenant one sales report is refused (404)" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' "https://pos.flower.localhost:8443/v1/companies/$C1/reports/sales?from=2026-11-01&to=2026-11-15")" "404"
chk "cross-paired company/branch is refused (404)" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' https://pos.flower.localhost:8443/v1/companies/$C1/branches/$B2/receipt-identity)" "404"
chk "positive control: tenant two reads its OWN receipt identity" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' https://pos.flower.localhost:8443/v1/companies/$C2/branches/$B2/receipt-identity)" "200"

echo "== backup and restore into a NEW database"
MIGRATION_MODE=check $C run --rm backup 2>&1 | grep -q "backup verified" && ok "backup job: verified dump" || bad "backup job"
PGPW=$(grep ^POSTGRES_SUPERUSER_PASSWORD .env.smoke | cut -d= -f2)
MSYS_NO_PATHCONV=1 docker run --rm --network flower-staging_default -v flower-staging_flower-staging-backups:/backups -e PGPASSWORD=$PGPW postgres:17 sh -ec 'f=$(ls -1t /backups/*.dump | head -1); psql -h postgres -U postgres -d postgres -qc "DROP DATABASE IF EXISTS flower_restore" -c "CREATE DATABASE flower_restore" >/dev/null 2>&1; pg_restore -h postgres -U postgres -d flower_restore --no-owner "$f"' >/dev/null 2>&1
FP="select (select count(*) from tenant)||'/'||(select count(*) from \"user\")||'/'||(select count(*) from customer)||'/'||(select count(*) from mfa_factor)||'/'||(select count(*) from _prisma_migrations)"
LIVE=$(psqlq "$FP"); REST=$($C exec -T postgres psql -U postgres -d flower_restore -At -c "$FP" | tr -d '\r')
chk "restored database fingerprint equals the live one ($LIVE)" "$REST" "$LIVE"

echo
if [ "${KEEP:-0}" != "1" ]; then $C down -v >/dev/null 2>&1; echo "stack removed (project flower-staging only)"; fi
if [ $FAILS -eq 0 ]; then echo "SMOKE RESULT: ALL CHECKS PASSED"; else echo "SMOKE RESULT: $FAILS CHECK(S) FAILED"; exit 1; fi
