#!/usr/bin/env bash
# LOCAL-ONLY rollback rehearsal of the staging stack (Docker Desktop; nothing remote, no real credential, DISPOSABLE resources only).
#
#   OUT=<empty work dir OUTSIDE the repo> bash infra/staging/rollback-rehearsal-local.sh <api-image> <migrate-image> <pos-image> <owner-image>
#
# <...-image> = the four images of "set A" (tags are fine; their immutable IDs are recorded and every deployment uses the IDs).
# Set B is built here as a thin derivation of set A (labels on api/pos/owner; the migrate image additionally carries ONE clearly labelled TEST
# migration and its manifest). The API image of set A must carry the UNAPPROVED R-1 candidate (SECRETS_PROVIDER=disabled) — this is a LOCAL
# REHEARSAL, not a production approval.
#
# Phases (PHASES="1 2 ..." runs a subset against the state kept in $OUT; KEEP=1 keeps the stack for the next run):
#   1 prepare   random disposable env, preflight, build set B, record the immutable IDs of A and B
#   2 deploy A  health, database state, tenant isolation, journal seed
#   3 backup    quiesce, pre-migration backup (verified), fingerprint of the live database
#   4 deploy B  deploy set B, check mode lists exactly the test migration, apply ONLY that, B health and writes, A refuses the migrated database
#   5 restore   restore the pre-migration dump into a NEW database, fingerprint must equal the pre-migration fingerprint
#   6 redeploy  redeploy set A from the recorded IDs against the restored database
#   7 verify    health, data integrity, journal balance, tenant isolation, fingerprints, then teardown (this compose project only)
set -uo pipefail
cd "$(dirname "$0")"
A_API=${1:?api image (set A)}; A_MIG=${2:?migrate image (set A)}; A_POS=${3:?pos image (set A)}; A_OWN=${4:?owner image (set A)}
OUT=${OUT:?set OUT to an empty working directory outside the repository}
PHASES=${PHASES:-1 2 3 4 5 6 7}
mkdir -p "$OUT"
OUTW=$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")
ENVF="$OUTW/.env.rollback"
RR=rollback-rehearsal
TESTM=20271231120000_local_rollback_rehearsal_test_only
PGIMG=$(grep -vE '^[[:space:]]*(#|$)' postgres-image.pin | head -1 | tr -d '\r')
C="docker compose -f docker-compose.staging.yml --env-file $ENVF"
H=https://pos.flower.localhost:8443
R="--resolve ops.flower.localhost:8443:127.0.0.1 --resolve pos.flower.localhost:8443:127.0.0.1 --resolve owner.flower.localhost:8443:127.0.0.1"
PW='violet-meadow-slow-river-47!'
OPPW='tangerine-orbit-quiet-harbor-82'
BK=flower-staging_flower-staging-backups
NET=flower-staging_default
FAILS=0; PASSES=0; DEVS=0
ok()   { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
bad()  { echo "  FAIL  $1"; FAILS=$((FAILS+1)); }
dev()  { echo "  DEVIATION (explained, NOT a pass)  $1"; DEVS=$((DEVS+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', expected '$3')"; fi; }
info() { echo "  INFO  $1"; }
J()    { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)$1??'')}catch{console.log('')}})"; }
want() { [[ " $PHASES " == *" $1 "* ]]; }
ikey() { echo "rbk-$RANDOM-$RANDOM-$RANDOM"; }   # the API requires an Idempotency-Key of 8..200 chars [A-Za-z0-9._~:-]
STATE="$OUT/state.env"; touch "$STATE"
st_set() { grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null; printf '%s=%q\n' "$1" "$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
# shellcheck disable=SC1090
source "$STATE"
DB() { grep -E '^POSTGRES_DB=' "$OUT/.env.rollback" | cut -d= -f2; }
psqlq() { $C exec -T postgres psql -U postgres -d "$1" -X -At -c "$2" 2>&1 | tr -d '\r'; }
psqlf() { local db=$1 f=$2; shift 2; $C exec -T postgres psql -U postgres -d "$db" -X -q "$@" -f - < "$f" 2>&1 | tr -d '\r'; }
fp()    { $C exec -T postgres psql -U postgres -d "$1" -X -q -f - < $RR/fingerprint.sql 2>/dev/null | tr -d '\r' > "$2"; }
jcheck(){ $C exec -T postgres psql -U postgres -d "$1" -X -q -f - < $RR/journal-check.sql 2>&1 | tr -d '\r'; }
login() { curl -sk $R -X POST -H 'content-type: application/json' -d "{\"workspaceSlug\":\"$1\",\"email\":\"$2\",\"password\":\"$PW\"}" $H/v1/auth/login | J .accessToken; }
code()  { $C exec -T api node -e "import('otplib').then(m=>console.log(m.authenticator.generate('$1')))" | tr -d '\r\n'; }
img_of() { docker inspect -f '{{.Image}}' "$($C ps -a -q "$1" | head -1)" 2>/dev/null; }
rec_id() { node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(r.images[process.argv[2]].id)" "$1" "$2"; }

echo "== rollback rehearsal (LOCAL ONLY, disposable) — phases: $PHASES — out: $OUT"
echo "   PostgreSQL image (the reviewed pin): $PGIMG"

# refuse to mix with anything that already exists in this compose project
if want 1; then
  [ -z "$(docker ps -a -q --filter label=com.docker.compose.project=flower-staging)" ] && [ -z "$(docker volume ls -q --filter label=com.docker.compose.project=flower-staging)" ] \
    || { echo "STOP: resources of the compose project flower-staging already exist; remove them (this project only) and retry"; exit 2; }
fi

# ───────────────────────────── 1 prepare ─────────────────────────────
if want 1; then
  echo "== 1 prepare"
  node -e "
const r=()=>require('crypto').randomBytes(18).toString('hex');
const e=['POS_HOST=pos.flower.localhost','OWNER_HOST=owner.flower.localhost','OPS_HOST=ops.flower.localhost','ADMIN_CIDR=172.16.0.0/12','HTTP_PORT=8080','HTTPS_PORT=8443','CADDYFILE=./Caddyfile.local',
'API_IMAGE=$A_API','POS_IMAGE=$A_POS','OWNER_IMAGE=$A_OWN','MIGRATE_IMAGE=$A_MIG','POSTGRES_IMAGE=$PGIMG','MIGRATION_MODE=check',
'POSTGRES_SUPERUSER_PASSWORD='+r(),'POSTGRES_DB=flower','APP_DB_PASSWORD='+r(),'PLATFORM_DB_PASSWORD='+r(),'REDIS_PASSWORD='+r(),'MINIO_ROOT_USER=flower_minio','MINIO_ROOT_PASSWORD='+r(),'AUTH_JWT_SECRET='+r(),'SECRETS_PROVIDER=disabled'];
require('fs').writeFileSync('$ENVF',e.join('\n')+'\n')"
  # record set A (tags -> immutable IDs) BEFORE anything is deployed
  node release-images.mjs "$ENVF" --out "$OUTW/release-A.json" >/dev/null && ok "set A recorded as immutable image IDs" || bad "record set A"
  # build set B: a thin derivation of A; the migrate image additionally carries ONE test migration + its manifest
  W="$OUT/build-b"; rm -rf "$W"; mkdir -p "$W/mig"
  MSYS_NO_PATHCONV=1 docker run --rm --entrypoint cat "$A_MIG" /repo/infra/migrate/approved-migrations.json > "$W/approved-A.json" || { echo "STOP: cannot read the set A manifest"; exit 2; }
  [ -s "$W/approved-A.json" ] || { echo "STOP: the set A manifest is empty"; exit 2; }
  cp $RR/test-migration.sql "$W/mig/migration.sql"
  node $RR/make-set-b-manifest.mjs "$(cygpath -m "$W")/approved-A.json" "$(cygpath -m "$W")/mig/migration.sql" "$TESTM" "$(cygpath -m "$W")/approved-B.json" | sed 's/^/   /'
  LBL='LABEL org.flower.rehearsal="LOCAL ROLLBACK REHEARSAL set B — not a release"'
  printf 'FROM %s\n%s\n' "$A_API" "$LBL" > "$W/Dockerfile.api"
  printf 'FROM %s\n%s\n' "$A_POS" "$LBL" > "$W/Dockerfile.pos"
  printf 'FROM %s\n%s\n' "$A_OWN" "$LBL" > "$W/Dockerfile.owner"
  printf 'FROM %s\nCOPY --chown=node:node mig/migration.sql /repo/packages/db/prisma/migrations/%s/migration.sql\nCOPY --chown=node:node approved-B.json /repo/infra/migrate/approved-migrations.json\n%s\n' "$A_MIG" "$TESTM" "$LBL" > "$W/Dockerfile.migrate"
  for x in api pos owner migrate; do docker build -q -f "$(cygpath -m "$W")/Dockerfile.$x" -t "flower/rehearsal-$x:set-B" "$(cygpath -m "$W")" >/dev/null && ok "built set B $x image" || { bad "build set B $x"; exit 2; }; done
  cp "$ENVF" "$OUT/.env.setB"
  node $RR/env-set.mjs "$OUTW/.env.setB" API_IMAGE=flower/rehearsal-api:set-B POS_IMAGE=flower/rehearsal-pos:set-B OWNER_IMAGE=flower/rehearsal-owner:set-B MIGRATE_IMAGE=flower/rehearsal-migrate:set-B >/dev/null
  node release-images.mjs "$OUTW/.env.setB" --out "$OUTW/release-B.json" >/dev/null && ok "set B recorded as immutable image IDs" || bad "record set B"
  for k in API_IMAGE POS_IMAGE OWNER_IMAGE MIGRATE_IMAGE; do
    a=$(rec_id "$OUTW/release-A.json" $k); b=$(rec_id "$OUTW/release-B.json" $k)
    [ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ] && ok "$k differs between sets (A ${a:7:12} / B ${b:7:12})" || bad "$k is not distinct between A and B"
  done
  # deploy A by its immutable IDs from here on
  node $RR/env-set.mjs "$ENVF" --from-release "$OUTW/release-A.json" >/dev/null
  node preflight.mjs "$ENVF" --local >/dev/null && ok "preflight accepts the env with immutable image IDs + the pinned PostgreSQL image" || bad "preflight"
  node check-release.mjs "$ENVF" >/dev/null && ok "check-release (start order, ports, healthchecks, one PostgreSQL image) passes" || bad "check-release"
fi

# ───────────────────────────── 2 deploy A ─────────────────────────────
if want 2; then
  echo "== 2 deploy set A (immutable IDs)"
  MIGRATION_MODE=check $C run --rm migrate 2>&1 | grep -q '"mode":"check"' && ok "check mode (read-only) on the empty database" || bad "check mode"
  MIGRATION_MODE=deploy timeout 600 $C up -d --wait >/dev/null 2>&1 && ok "whole stack healthy in production mode (set A)" || bad "stack did not become healthy"
  chk "all readiness checks ok" "$($C exec -T api node -e "fetch('http://127.0.0.1:3001/readyz').then(async r=>console.log((await r.json()).status))" | tr -d '\r')" "ok"
  for pair in "api:API_IMAGE" "pos:POS_IMAGE" "owner-web:OWNER_IMAGE" "migrate:MIGRATE_IMAGE" "roles:MIGRATE_IMAGE" "seed:MIGRATE_IMAGE"; do
    chk "running/last container of '${pair%%:*}' uses the recorded immutable ID of set A" "$(img_of "${pair%%:*}")" "$(rec_id "$OUTW/release-A.json" "${pair##*:}")"
  done
  DBN=$(DB)
  chk "approved migrations applied and finished (49)" "$(psqlq "$DBN" "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")" "49"
  chk "no test-migration object exists on set A" "$(psqlq "$DBN" "select coalesce(to_regclass('public.rollback_rehearsal_probe')::text,'none')")" "none"
  chk "the app roles are not superusers and cannot bypass RLS" "$(psqlq "$DBN" "select count(*) from pg_roles where rolname in ('flower_app') and (rolsuper or rolbypassrls)")" "0"

  echo "-- first operator (TOTP) and two tenants through the operator host"
  cat > "$OUT/boot.mjs" <<'EOF'
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
  docker cp "$OUTW/boot.mjs" flower-staging-api-1:/app/boot.mjs
  SECRET=$($C exec -T -e OP_PW="$OPPW" api node boot.mjs 2>&1 | tail -1 | J .secret)
  [ ${#SECRET} -ge 16 ] && st_set OP_SECRET "$SECRET" || bad "operator bootstrap"
  TOKEN=$(curl -sk $R -X POST -H 'content-type: application/json' -d "{\"email\":\"ops@flower-ops.example\",\"password\":\"$OPPW\",\"code\":\"$(code "$SECRET")\"}" https://ops.flower.localhost:8443/v1/platform/auth/login | J .accessToken)
  [ ${#TOKEN} -gt 100 ] && ok "operator signs in with password AND code" || bad "operator login"
  PLAN=$(psqlq "$DBN" "select pv.id from plan_version pv join plan p on p.id=pv.\"planId\" where p.key='starter' and pv.status='PUBLISHED' limit 1")
  for n in one two; do
    INV=$(curl -sk $R -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "idempotency-key: $(ikey)" -d "{\"slug\":\"pilot-$n\",\"name\":\"Pilot $n\",\"region\":\"AE\",\"companyCountryCode\":\"AE\",\"businessTypeKey\":\"FLOWER_FLORIST\",\"planVersionId\":\"$PLAN\",\"ownerEmail\":\"owner@pilot-$n.example\"}" https://ops.flower.localhost:8443/v1/platform/tenants | J .setPasswordToken)
    chk "tenant $n: owner invite redeemed once" "$(curl -sk $R -o /dev/null -X POST -H 'content-type: application/json' -d "{\"token\":\"$INV\",\"newPassword\":\"$PW\"}" -w '%{http_code}' $H/v1/auth/set-password)" "201"
  done
fi

# ───────────────── shared checks (used by phases 2, 4 and 7) ─────────────────
refresh() {   # sessions of both tenants (a fresh password login; owners are not MFA-mandatory)
  T1=$(login pilot-one owner@pilot-one.example); T2=$(login pilot-two owner@pilot-two.example)
  [ ${#T1} -gt 100 ] && [ ${#T2} -gt 100 ] && ok "$1: both owners can sign in" || bad "$1: owner sign-in (T1=${#T1} T2=${#T2})"
}
ids() {
  DBN=$(DB)
  C1=$(psqlq "$DBN" "select c.id from company c join tenant t on t.id=c.\"tenantId\" where t.slug='pilot-one' limit 1"); B1=$(psqlq "$DBN" "select b.id from branch b join tenant t on t.id=b.\"tenantId\" where t.slug='pilot-one' limit 1")
  C2=$(psqlq "$DBN" "select c.id from company c join tenant t on t.id=c.\"tenantId\" where t.slug='pilot-two' limit 1"); B2=$(psqlq "$DBN" "select b.id from branch b join tenant t on t.id=b.\"tenantId\" where t.slug='pilot-two' limit 1")
}
iso_checks() {   # $1 = label; needs T1 T2 C1 B1 C2 B2
  local L=$1
  chk "$L: tenant one sees its customer" "$(curl -sk $R -H "authorization: Bearer $T1" $H/v1/companies/$C1/customers | grep -c TENANT-ONE-SECRET)" "1"
  chk "$L: tenant two sees its customer" "$(curl -sk $R -H "authorization: Bearer $T2" $H/v1/companies/$C2/customers | grep -c TENANT-TWO-SECRET)" "1"
  chk "$L: tenant TWO reading tenant one's customers sees nothing of it" "$(curl -sk $R -H "authorization: Bearer $T2" $H/v1/companies/$C1/customers | grep -c TENANT-ONE-SECRET)" "0"
  chk "$L: tenant ONE reading tenant two's customers sees nothing of it" "$(curl -sk $R -H "authorization: Bearer $T1" $H/v1/companies/$C2/customers | grep -c TENANT-TWO-SECRET)" "0"
  chk "$L: tenant two -> tenant one receipt identity is refused (404)" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' $H/v1/companies/$C1/branches/$B1/receipt-identity)" "404"
  chk "$L: tenant two -> tenant one trial balance is refused (404)" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' "$H/v1/companies/$C1/reports/trial-balance?from=2026-11-01&to=2026-11-30")" "404"
  chk "$L: tenant one -> tenant two trial balance is refused (404)" "$(curl -sk $R -H "authorization: Bearer $T1" -o /dev/null -w '%{http_code}' "$H/v1/companies/$C2/reports/trial-balance?from=2026-11-01&to=2026-11-30")" "404"
  chk "$L: cross-paired company/branch is refused (404)" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' $H/v1/companies/$C1/branches/$B2/receipt-identity)" "404"
  chk "$L: positive control: tenant two reads its OWN receipt identity" "$(curl -sk $R -H "authorization: Bearer $T2" -o /dev/null -w '%{http_code}' $H/v1/companies/$C2/branches/$B2/receipt-identity)" "200"
}
tb_checks() {    # $1 = label: the ledger as the APPLICATION reports it
  chk "$1: tenant one trial balance (API) balances: debit/credit/accounts-with-movement" "$(curl -sk $R -H "authorization: Bearer $T1" "$H/v1/companies/$C1/reports/trial-balance?from=2026-11-01&to=2026-11-30" | node $RR/tb-summary.mjs)" "22500/22500/3"
  chk "$1: tenant two trial balance (API) balances" "$(curl -sk $R -H "authorization: Bearer $T2" "$H/v1/companies/$C2/reports/trial-balance?from=2026-11-01&to=2026-11-30" | node $RR/tb-summary.mjs)" "22500/22500/3"
}
unbalanced_refused() {   # $1 = label  $2 = database
  local out; out=$(psqlf "$2" $RR/journal-unbalanced.sql -v slug=pilot-one -v src="rb-unbalanced-$RANDOM")
  grep -q "is unbalanced" <<<"$out" && ok "$1: the database REFUSES an unbalanced sealed journal entry" || bad "$1: unbalanced entry was not refused ($(echo "$out" | tail -1 | cut -c1-120))"
}
img_checks() {   # $1 = label  $2 = release record
  for pair in "api:API_IMAGE" "pos:POS_IMAGE" "owner-web:OWNER_IMAGE" "migrate:MIGRATE_IMAGE" "roles:MIGRATE_IMAGE" "seed:MIGRATE_IMAGE"; do
    chk "$1: '${pair%%:*}' runs the recorded immutable ID" "$(img_of "${pair%%:*}")" "$(rec_id "$2" "${pair##*:}")"
  done
}

# ───────────────────── 2b data, isolation, journal on set A ─────────────────────
if want 2; then
  echo "== 2b set A: data, tenant isolation and a real ledger"
  DBN=$(DB); ids; st_set C1 "$C1"; st_set C2 "$C2"
  refresh "set A"
  curlc() { curl -sk $R -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -H "idempotency-key: $(ikey)" -d "$2" -o /dev/null -w '%{http_code}' $H/v1/companies/$3/customers; }
  chk "set A: tenant one creates a customer" "$(curlc "$T1" '{"displayName":"TENANT-ONE-SECRET-CUSTOMER","phone":"+971500000001"}' $C1)" "201"
  chk "set A: tenant two creates a customer" "$(curlc "$T2" '{"displayName":"TENANT-TWO-SECRET-CUSTOMER","phone":"+971500000002"}' $C2)" "201"
  iso_checks "set A"
  psqlf "$DBN" $RR/journal-seed.sql -v slug=pilot-one -v src=rb-one | grep -q "seeded pilot-one" && ok "set A: ledger seeded for tenant one (2 sealed balanced entries, database posting protocol)" || bad "journal seed one"
  psqlf "$DBN" $RR/journal-seed.sql -v slug=pilot-two -v src=rb-two | grep -q "seeded pilot-two" && ok "set A: ledger seeded for tenant two" || bad "journal seed two"
  chk "set A: ledger = 4 entries / 10 lines / 0 unsealed / 0 unbalanced / 0 empty / net 0" "$(jcheck "$DBN")" "4/10/0/0/0/0"
  tb_checks "set A"
  unbalanced_refused "set A" "$DBN"
  chk "set A: the refused unbalanced attempt persisted nothing" "$(jcheck "$DBN")" "4/10/0/0/0/0"
fi

# ───────────────────────────── 3 backup ─────────────────────────────
if want 3; then
  echo "== 3 pre-migration backup (writers quiesced)"
  DBN=$(DB)
  $C stop caddy pos owner-web api >/dev/null 2>&1
  chk "no application connection remains on the database" "$(psqlq "$DBN" "select count(*) from pg_stat_activity where datname='$DBN' and usename in ('flower_app','flower_platform')")" "0"
  BOUT=$(MIGRATION_MODE=check $C run --rm backup 2>&1)
  grep -q "backup verified" <<<"$BOUT" && ok "backup job: dump written and readable (pg_restore --list)" || bad "backup job ($(echo "$BOUT" | tail -2 | tr '\n' ' ' | cut -c1-160))"
  DUMP=$(echo "$BOUT" | grep -oE '/backups/pre-migrate-[0-9TZ]+\.dump' | tail -1); st_set DUMP "$DUMP"
  DSHA=$(MSYS_NO_PATHCONV=1 docker run --rm -v $BK:/backups:ro alpine sha256sum "$DUMP" | cut -d' ' -f1); st_set DSHA "$DSHA"
  DSIZE=$(MSYS_NO_PATHCONV=1 docker run --rm -v $BK:/backups:ro alpine stat -c %s "$DUMP"); st_set DSIZE "$DSIZE"
  info "pre-migration dump: $DUMP  ${DSIZE} bytes  sha256 ${DSHA:0:16}…"
  TOC=$(MSYS_NO_PATHCONV=1 docker run --rm -v $BK:/backups:ro "$PGIMG" pg_restore --list "$DUMP" 2>/dev/null)
  [ "$(grep -c 'TABLE DATA' <<<"$TOC")" -gt 100 ] && ok "independent check (pinned PostgreSQL image): dump TOC lists $(grep -c 'TABLE DATA' <<<"$TOC") table-data entries" || bad "dump TOC too small"
  grep -qE 'TABLE DATA public journal_entry ' <<<"$TOC" && ok "the dump contains the ledger tables (journal_entry data)" || bad "journal_entry data missing from the dump"; grep -qE 'TABLE DATA public journal_line ' <<<"$TOC" && ok "the dump contains journal_line data" || bad "journal_line data missing from the dump"
  detail() {
    $C exec -T postgres psql -U postgres -d "$1" -X -q -v ON_ERROR_STOP=1 -f - < $RR/schema-detail.sql 2>"$2.err" | tr -d '\r' > "$2"
    for a in column index constraint policy trigger function grant rls; do grep -q "^$a " "$2" || { bad "schema detail listing is incomplete (no '$a' lines in $2; see $2.err)"; return 1; }; done
  }
  detail "$DBN" "$OUT/detail0.txt"
  fp "$DBN" "$OUT/fp0.tsv"; FP0N=$(grep -c . "$OUT/fp0.tsv")
  [ "$FP0N" -gt 100 ] && ok "fingerprint FP0 of the live database taken ($FP0N lines, file sha256 $(sha256sum "$OUT/fp0.tsv" | cut -c1-16)…)" || bad "fingerprint FP0 too small ($FP0N lines)"
  JC0=$(jcheck "$DBN"); st_set JC0 "$JC0"; chk "ledger at backup time" "$JC0" "4/10/0/0/0/0"
  info "row counts at backup: tenants $(psqlq "$DBN" 'select count(*) from tenant'), users $(psqlq "$DBN" 'select count(*) from "user"'), customers $(psqlq "$DBN" 'select count(*) from customer'), migrations $(psqlq "$DBN" 'select count(*) from _prisma_migrations')"
fi

# ───────────────── helpers for phases 4–7 ─────────────────
CB="docker compose -f docker-compose.staging.yml --env-file $OUTW/.env.B"
mkcust() { curl -sk $R -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -H "idempotency-key: $(ikey)" -d "{\"displayName\":\"$2\",\"phone\":\"$4\"}" -o /dev/null -w '%{http_code}' $H/v1/companies/$3/customers; }
fpcount() { awk -F'\t' -v t="$2" '$1=="T" && $2==t {print $3}' "$1"; }
fpdiff() {   # $1 $2 = fingerprint files -> the differing T/S keys (count only; the md5s are in the files)
  diff "$1" "$2" | grep -E '^[<>]' | awk -F'\t' '{print substr($1,1,1) " " substr($1,3) " " $2 " (count " $3 ")"}' | sed 's/^< /A-side: /;s/^> /B-side: /' | cut -c1-110
}
# A strict schema-fingerprint difference is only EXPLAINED when every differing line is a CHECK constraint, the pair is identical once parentheses and
# spaces are removed, AND PostgreSQL itself, given the pre-migration deparsed text, produces exactly the restored definition (parse-normalisation).
# Anything else stays a FAIL. $1 = pre-migration detail file, $2 = restored detail file, $3 = restored database.
explain_check_diff() {
  local L R l relcon rel con def def2 reparsed n=0
  L=$(diff "$1" "$2" | grep -E '^< ' | sed 's/^< //'); R=$(diff "$1" "$2" | grep -E '^> ' | sed 's/^> //')
  [ -n "$L" ] && [ -n "$R" ] || return 1
  [ "$(grep -c . <<<"$L")" = "$(grep -c . <<<"$R")" ] || return 1
  while IFS= read -r l; do [[ "$l" == "constraint "*" [c "* ]] || return 1; done <<<"$L"
  while IFS= read -r l; do [[ "$l" == "constraint "*" [c "* ]] || return 1; done <<<"$R"
  [ "$(sed 's/[() ]//g' <<<"$L" | sort)" = "$(sed 's/[() ]//g' <<<"$R" | sort)" ] || return 1
  while IFS= read -r l; do
    relcon=${l#constraint }; relcon=${relcon%% \[*}; rel=${relcon%%.*}; con=${relcon#*.}; def=${l#*\] }
    def2=$(grep -F "constraint $relcon [" <<<"$R" | head -1); def2=${def2#*\] }
    reparsed=$($C exec -T postgres psql -U postgres -d "$3" -X -At -v rel="$rel" -v d="$def" -f - <<'SQL' 2>&1 | tr -d '\r' | tail -1
CREATE TEMP TABLE rr_t AS SELECT * FROM public.:"rel" WITH NO DATA;
SELECT format('ALTER TABLE rr_t ADD CONSTRAINT rr_probe %s', :'d') \gexec
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'rr_t'::regclass AND conname = 'rr_probe';
SQL
)
    [ "$reparsed" = "$def2" ] || return 1
    echo "        explained: $relcon"; echo "          pre-migration : $def"; echo "          restored      : $def2"
    n=$((n+1))
  done <<<"$L"
  [ "$n" -ge 1 ]
}
sha_of() { MSYS_NO_PATHCONV=1 docker run --rm -v $BK:/backups:ro alpine sha256sum "$1" | cut -d' ' -f1; }

# ───────────────────────────── 4 deploy B ─────────────────────────────
if want 4; then
  echo "== 4 deploy set B (immutable IDs); apply ONLY the explicitly permitted test migration"
  DBN=$(DB)
  cp "$ENVF" "$OUT/.env.B"
  node $RR/env-set.mjs "$OUTW/.env.B" --from-release "$OUTW/release-B.json" >/dev/null && ok "set B env points at the recorded immutable IDs of set B" || bad "set B env"
  node preflight.mjs "$OUTW/.env.B" --local >/dev/null && ok "preflight accepts the set B env" || bad "preflight (set B)"
  echo "-- negative controls: the runner must refuse anything not in the approved manifest"
  X="$OUT/build-x"; rm -rf "$X"; mkdir -p "$X"
  echo "SELECT 1;" > "$X/migration.sql"
  printf 'FROM flower/rehearsal-migrate:set-B\nCOPY --chown=node:node migration.sql /repo/packages/db/prisma/migrations/20271231130000_unapproved_extra/migration.sql\n' > "$X/Dockerfile.extra"
  printf 'FROM flower/rehearsal-migrate:set-B\nCOPY --chown=node:node migration.sql /repo/packages/db/prisma/migrations/%s/migration.sql\n' "$TESTM" > "$X/Dockerfile.tamper"
  docker build -q -f "$(cygpath -m "$X")/Dockerfile.extra" -t flower/rehearsal-migrate-extra:neg "$(cygpath -m "$X")" >/dev/null && \
  docker build -q -f "$(cygpath -m "$X")/Dockerfile.tamper" -t flower/rehearsal-migrate-tamper:neg "$(cygpath -m "$X")" >/dev/null || bad "build negative-control images"
  MIGRATE_IMAGE=flower/rehearsal-migrate-extra:neg MIGRATION_MODE=check $CB run --rm --no-deps migrate >"$OUT/neg-extra.out" 2>&1; chk "an UNLISTED extra migration is refused (exit code 2)" "$?" "2"
  info "refusal: $(tr -d '\r' < "$OUT/neg-extra.out" | grep -i 'refus\|not approved\|unlisted\|extra' | tail -1 | cut -c1-200)"
  MIGRATE_IMAGE=flower/rehearsal-migrate-tamper:neg MIGRATION_MODE=check $CB run --rm --no-deps migrate >"$OUT/neg-tamper.out" 2>&1; chk "a CHANGED (tampered) test migration is refused (exit code 2)" "$?" "2"
  info "refusal: $(tr -d '\r' < "$OUT/neg-tamper.out" | grep -i 'refus\|changed\|checksum\|differs' | tail -1 | cut -c1-200)"
  echo "-- read-only check mode with set B lists exactly the permitted migration"
  CK=$(MIGRATION_MODE=check $CB run --rm --no-deps migrate 2>&1 | tr -d '\r' | tail -1)
  chk "check mode: approved=50, applied=49, pending = [the one test migration]" "$CK" "{\"ok\":true,\"mode\":\"check\",\"approved\":50,\"applied\":49,\"pending\":[\"$TESTM\"]}"
  echo "-- deploy set B"
  MIGRATION_MODE=deploy timeout 600 $CB up -d --wait >"$OUT/up-b.log" 2>&1 && ok "set B stack healthy in production mode" || bad "set B stack did not become healthy ($(tr -d '\r' < "$OUT/up-b.log" | tail -2 | tr '\n' ' ' | cut -c1-200))"
  chk "all readiness checks ok (set B)" "$($CB exec -T api node -e "fetch('http://127.0.0.1:3001/readyz').then(async r=>console.log((await r.json()).status))" | tr -d '\r')" "ok"
  img_checks "set B" "$OUTW/release-B.json"
  chk "migrations applied: 50 (49 approved + the one test migration)" "$(psqlq "$DBN" "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")" "50"
  chk "the 49 approved migrations are untouched (only the test migration was added)" "$(psqlq "$DBN" "select count(*) from _prisma_migrations where migration_name <> '$TESTM'")" "49"
  chk "the test migration is the newest" "$(psqlq "$DBN" "select migration_name from _prisma_migrations order by started_at desc limit 1")" "$TESTM"
  chk "test object exists: probe table has its 1 row" "$(psqlq "$DBN" "select count(*) from rollback_rehearsal_probe")" "1"
  chk "test migration changed data: both customers carry the marker" "$(psqlq "$DBN" "select count(*) from customer where \"rehearsalMarker\"='migrated-by-set-B'")" "2"
  ids; refresh "set B"; st_set BTOK "$T1"
  chk "set B: tenant one writes a B-era customer (must NOT survive the rollback)" "$(mkcust "$T1" B-ERA-CUSTOMER-ONE "$C1" +971500000003)" "201"
  chk "set B: customers now 3" "$(psqlq "$DBN" "select count(*) from customer")" "3"
  iso_checks "set B"
  tb_checks "set B"
  chk "set B: ledger still balanced" "$(jcheck "$DBN")" "4/10/0/0/0/0"
  fp "$DBN" "$OUT/fpB.tsv"
  info "fingerprint set A-side(FP0) vs set B live differs in: $(fpdiff "$OUT/fp0.tsv" "$OUT/fpB.tsv" | tr '\n' ';' | cut -c1-600)"
  echo "-- set A's migrate runner against the B-migrated database (why redeploy-in-place is NOT the rollback)"
  MIGRATION_MODE=check $C run --rm --no-deps migrate >"$OUT/a-vs-b.out" 2>&1; chk "set A's runner REFUSES the migrated database (drift, exit code 2)" "$?" "2"
  info "refusal: $(tr -d '\r' < "$OUT/a-vs-b.out" | tail -1 | cut -c1-220)"
fi

# ───────────────────────────── 5 restore ─────────────────────────────
if want 5; then
  echo "== 5 restore the PRE-MIGRATION dump into a NEW database"
  DBN=$(DB); NEWDB=flower_restored
  $CB stop caddy pos owner-web api >/dev/null 2>&1
  chk "no application connection remains (B quiesced)" "$(psqlq "$DBN" "select count(*) from pg_stat_activity where datname='$DBN' and usename in ('flower_app','flower_platform')")" "0"
  chk "the pre-migration dump is byte-identical to when it was taken (sha256)" "$(sha_of "$DUMP")" "$DSHA"
  chk "the restore target does not exist yet" "$(psqlq postgres "select count(*) from pg_database where datname='$NEWDB'")" "0"
  PGPW=$(grep ^POSTGRES_SUPERUSER_PASSWORD "$OUT/.env.rollback" | cut -d= -f2)
  MSYS_NO_PATHCONV=1 docker run --rm --network $NET -v $BK:/backups:ro -e PGPASSWORD="$PGPW" "$PGIMG" sh -ec "psql -h postgres -U postgres -d postgres -qc 'CREATE DATABASE $NEWDB' && pg_restore -h postgres -U postgres -d $NEWDB --no-owner --exit-on-error '$DUMP'" >"$OUT/restore.log" 2>&1
  chk "pg_restore into the NEW database finished without any error (--exit-on-error)" "$?" "0"
  info "restore log: $(tr -d '\r' < "$OUT/restore.log" | wc -l) line(s) $(tr -d '\r' < "$OUT/restore.log" | head -2 | tr '\n' ' ' | cut -c1-160)"
  fp "$NEWDB" "$OUT/fp1.tsv"
  if cmp -s "$OUT/fp0.tsv" "$OUT/fp1.tsv"; then ok "BACKUP FINGERPRINT: restored database == pre-migration database ($(grep -c . "$OUT/fp1.tsv") lines: every table's count+row-hash and every schema aspect: columns, indexes, constraints, policies, triggers, functions, grants, RLS flags)"; else
    detail "$NEWDB" "$OUT/detail1.txt"; FPS="$(fpdiff "$OUT/fp0.tsv" "$OUT/fp1.tsv" | tr '\n' ';' | cut -c1-300)"
    echo "        strict fingerprint differs in: $FPS"; echo "        row-level difference (< pre-migration, > restored), first 16 lines:"; diff "$OUT/detail0.txt" "$OUT/detail1.txt" | head -16 | cut -c1-300 | sed 's/^/        /'
    if explain_check_diff "$OUT/detail0.txt" "$OUT/detail1.txt" "$NEWDB"; then
      dev "strict fingerprint differs ONLY in the parenthesisation of the CHECK constraint(s) above (PostgreSQL re-parses the dumped text and flattens nested AND); every table row-hash and every other schema aspect is identical"
    else
      bad "restored fingerprint DIFFERS from the pre-migration fingerprint and the difference is NOT explained: $FPS"
    fi
  fi
  chk "restored: ledger = 4 entries / 10 lines / 0 unsealed / 0 unbalanced / 0 empty / net 0" "$(jcheck "$NEWDB")" "$JC0"
  unbalanced_refused "restored" "$NEWDB"
  chk "restored: migrations 49, none of them the test migration" "$(psqlq "$NEWDB" "select count(*) from _prisma_migrations where migration_name <> '$TESTM'")/$(psqlq "$NEWDB" "select count(*) from _prisma_migrations")" "49/49"
  chk "restored: the B-only table does not exist" "$(psqlq "$NEWDB" "select coalesce(to_regclass('public.rollback_rehearsal_probe')::text,'none')")" "none"
  chk "restored: the B-only column does not exist" "$(psqlq "$NEWDB" "select count(*) from information_schema.columns where table_name='customer' and column_name='rehearsalMarker'")" "0"
  chk "restored: the B-era customer is gone, the 2 original customers are back" "$(psqlq "$NEWDB" "select count(*) from customer where \"displayName\" like 'B-ERA%'")/$(psqlq "$NEWDB" "select count(*) from customer")" "0/2"
  chk "the migrated database was left untouched for forensics (still 50 migrations)" "$(psqlq "$DBN" "select count(*) from _prisma_migrations")" "50"
fi

# ───────────────────────────── 6 redeploy A ─────────────────────────────
if want 6; then
  echo "== 6 redeploy set A by the RECORDED immutable IDs against the restored database"
  node $RR/env-set.mjs "$ENVF" --from-release "$OUTW/release-A.json" >/dev/null && node $RR/env-set.mjs "$ENVF" POSTGRES_DB=flower_restored >/dev/null && ok "env: set A recorded IDs + POSTGRES_DB=flower_restored" || bad "env switch"
  node preflight.mjs "$ENVF" --local >/dev/null && ok "preflight accepts the rollback env" || bad "preflight (rollback env)"
  $C exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL' 2>&1 | tr -d '\r' | grep -q '^OK$' && ok "Redis (sessions, rate limits, caches) flushed BEFORE set A serves traffic: Redis is not part of the database backup" || bad "Redis flush"
  MIGRATION_MODE=deploy timeout 600 $C up -d --wait >"$OUT/up-a2.log" 2>&1 && ok "set A stack healthy again (production mode, restored database)" || bad "set A redeploy did not become healthy ($(tr -d '\r' < "$OUT/up-a2.log" | tail -2 | tr '\n' ' ' | cut -c1-200))"
  chk "the API now points at the restored database" "$($C exec -T api sh -c 'printenv DATABASE_URL' | tr -d '\r' | grep -c '/flower_restored$')" "1"
  img_checks "set A redeployed" "$OUTW/release-A.json"
fi

# ───────────────────────────── 7 verify + teardown ─────────────────────────────
if want 7; then
  echo "== 7 final verification on the rolled-back stack"
  DBN=$(DB)
  chk "readiness (all checks ok)" "$($C exec -T api node -e "fetch('http://127.0.0.1:3001/readyz').then(async r=>console.log((await r.json()).status))" | tr -d '\r')" "ok"
  chk "approved migrations applied (49), test migration absent" "$(psqlq "$DBN" "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")/$(psqlq "$DBN" "select count(*) from _prisma_migrations where migration_name='$TESTM'")" "49/0"
  chk "set A's runner is content with the restored database (check: nothing pending)" "$(MIGRATION_MODE=check $C run --rm --no-deps migrate 2>&1 | tr -d '\r' | tail -1)" '{"ok":true,"mode":"check","approved":49,"applied":49,"pending":[]}'
  for t in tenant user customer journal_entry journal_line account accounting_period; do
    chk "data integrity: $t row count equals the pre-migration count" "$(psqlq "$DBN" "select count(*) from \"$t\"")" "$(fpcount "$OUT/fp0.tsv" $t)"
  done
  ids
  chk "company ids unchanged by the rollback" "$C1/$C2" "$(grep '^C1=' "$STATE" | cut -d= -f2 | tr -d "'")/$(grep '^C2=' "$STATE" | cut -d= -f2 | tr -d "'")"
  refresh "rolled back"
  iso_checks "rolled back"
  chk "journal: balanced, sealed, nothing orphaned (database)" "$(jcheck "$DBN")" "$JC0"
  tb_checks "rolled back"
  unbalanced_refused "rolled back" "$DBN"
  chk "the B-era customer is still gone (API view, tenant one)" "$(curl -sk $R -H "authorization: Bearer $T1" $H/v1/companies/$C1/customers | grep -c B-ERA-CUSTOMER)" "0"
  chk "the migrated database survived the redeploy untouched, kept for forensics (flower: still 50 migrations, test table present)" "$(psqlq flower "select count(*) from _prisma_migrations")/$(psqlq flower "select count(*) from rollback_rehearsal_probe")" "50/1"
  chk "the app roles are not superusers and cannot bypass RLS" "$(psqlq "$DBN" "select count(*) from pg_roles where rolname in ('flower_app') and (rolsuper or rolbypassrls)")" "0"
  chk "backup file still byte-identical (sha256 $(echo "$DSHA" | cut -c1-16)…, ${DSIZE} bytes)" "$(sha_of "$DUMP")" "$DSHA"
  fp "$DBN" "$OUT/fp2.tsv"
  if cmp -s "$OUT/fp0.tsv" "$OUT/fp2.tsv"; then ok "FINGERPRINT after redeploy == pre-migration fingerprint (the seed/roles jobs changed nothing)"; else info "fingerprint after redeploy differs from FP0 in: $(fpdiff "$OUT/fp0.tsv" "$OUT/fp2.tsv" | tr '\n' ';' | cut -c1-700)"; fi
  info "DB-level fingerprint of the RESTORED copy (before redeploy) vs FP0 is the equality proof (phase 5); this line is the post-redeploy drift report"
  . "$STATE"; chk "a session token issued in the B era is rejected after the rollback (401)" "$(curl -sk $R -H "authorization: Bearer $BTOK" -o /dev/null -w '%{http_code}' $H/v1/companies/$C1/customers)" "401"
  if [ "${KEEP:-0}" != "1" ]; then
    $C down -v --remove-orphans >/dev/null 2>&1
    docker rmi flower/rehearsal-api:set-B flower/rehearsal-pos:set-B flower/rehearsal-owner:set-B flower/rehearsal-migrate:set-B flower/rehearsal-migrate-extra:neg flower/rehearsal-migrate-tamper:neg >/dev/null 2>&1
    chk "teardown: no container of the compose project flower-staging remains" "$(docker ps -a -q --filter label=com.docker.compose.project=flower-staging | wc -l | tr -d ' ')" "0"
    chk "teardown: no volume of the compose project flower-staging remains" "$(docker volume ls -q --filter label=com.docker.compose.project=flower-staging | wc -l | tr -d ' ')" "0"
    chk "teardown: no network of the compose project flower-staging remains" "$(docker network ls -q --filter label=com.docker.compose.project=flower-staging | wc -l | tr -d ' ')" "0"
  else info "KEEP=1: stack left running (project flower-staging)"; fi
fi

echo
echo "REHEARSAL RESULT (phases $PHASES): $PASSES passed, $FAILS failed, $DEVS explained deviation(s)"
[ "$FAILS" -eq 0 ]
