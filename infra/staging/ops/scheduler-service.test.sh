#!/usr/bin/env bash
# The backup-scheduler SERVICE as Compose defines it (entrypoint, environment names, volumes, healthcheck) in a DISPOSABLE project named
# flower-offhost-probe-stack. Only `postgres` and `backup-scheduler` are started; nothing of the real staging project is touched.
#   bash infra/staging/ops/scheduler-service.test.sh
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGING="$(cd "$HERE/.." && pwd)"
P=flower-offhost-probe-stack
TMP="$(mktemp -d)"
ENVF="$TMP/probe.env"
PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
# docker.exe on Windows (Git Bash) cannot read an MSYS path such as /tmp/x; elsewhere hp() is the identity
hp() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
dc() { docker compose -p "$P" -f "$(hp "$STAGING/docker-compose.staging.yml")" --env-file "$(hp "$ENVF")" "$@"; }
cleanup() { dc down -v --remove-orphans > /dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

PIN="$(grep -vE '^[[:space:]]*(#|$)' "$STAGING/postgres-image.pin" | head -1)"
r() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
D="sha256:$(printf 'a%.0s' $(seq 1 64))"
{
  echo "POS_HOST=pos.probe.test"; echo "OWNER_HOST=owner.probe.test"; echo "OPS_HOST=ops.probe.test"; echo "ADMIN_CIDR=203.0.113.0/24"
  echo "API_IMAGE=flower/api@$D"; echo "POS_IMAGE=flower/pos@$D"; echo "OWNER_IMAGE=flower/owner-web@$D"; echo "MIGRATE_IMAGE=flower/migrate@$D"
  echo "POSTGRES_IMAGE=$PIN"; echo "MIGRATION_MODE=check"; echo "POSTGRES_DB=flower"
  echo "POSTGRES_SUPERUSER_PASSWORD=$(r)"; echo "APP_DB_PASSWORD=$(r)"; echo "PLATFORM_DB_PASSWORD=$(r)"; echo "REDIS_PASSWORD=$(r)"
  echo "MINIO_ROOT_USER=probe"; echo "MINIO_ROOT_PASSWORD=$(r)"; echo "AUTH_JWT_SECRET=$(r)"; echo "SECRETS_PROVIDER=kms"
} > "$ENVF"

echo "### scheduler service test (project $P)"
dc up -d postgres > "$TMP/up.out" 2>&1 || { echo "cannot start postgres:"; tail -8 "$TMP/up.out"; exit 2; }
for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$P-postgres-1" 2> /dev/null)" = "healthy" ] && break; sleep 1; done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$P-postgres-1" 2> /dev/null)" = "healthy" ] || { echo "postgres did not become healthy"; exit 2; }
# "healthy" comes from a socket pg_isready, which the image's temporary init server can also answer: wait (bounded) until the REAL server answers
# over TCP twice in a row before writing anything
tcp_ok=0
for _ in $(seq 1 60); do
  if docker exec "$P-postgres-1" pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1; then tcp_ok=$((tcp_ok + 1)); [ "$tcp_ok" -ge 2 ] && break; else tcp_ok=0; fi
  sleep 1
done
[ "$tcp_ok" -ge 2 ] || { echo "postgres did not answer over TCP within 60 s"; exit 2; }
# a database with real content, so the dump is above the 4096-byte floor like a real one would be
docker exec "$P-postgres-1" psql -U postgres -d flower -v ON_ERROR_STOP=1 -qc "CREATE TABLE filler AS SELECT g AS id, md5(g::text) AS pad FROM generate_series(1, 5000) g" > /dev/null 2>&1

echo "== the service starts, takes a first backup and turns healthy"
dc up -d backup-scheduler > /dev/null 2>&1
S="$P-backup-scheduler-1"
for _ in $(seq 1 120); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$S" 2> /dev/null)" = "healthy" ] && break; sleep 2; done
check "backup-scheduler reports healthy" '[ "$(docker inspect -f "{{.State.Health.Status}}" "$S")" = "healthy" ]'
LOGS="$(docker logs "$S" 2>&1)"
check "its log says 'backup verified: /backups/scheduled-...' and nothing like a password" 'echo "$LOGS" | grep -q "backup verified: /backups/scheduled-" && ! echo "$LOGS" | grep -qiE "password|PGPASSWORD"'
FILES="$(docker exec "$S" ls -1A /backups | tr -d '\r')"
check "the volume holds the dump, its sha256 sidecar and .last-backup-ok" 'echo "$FILES" | grep -qE "^scheduled-[0-9]{8}T[0-9]{6}Z\.dump$" && echo "$FILES" | grep -qE "\.dump\.sha256$" && echo "$FILES" | grep -qx ".last-backup-ok"'
check "the dump verifies with the SERVER image (sha256 -c, pg_restore --list)" 'docker exec "$S" sh -c "cd /backups && sha256sum -c scheduled-*.dump.sha256 && pg_restore --list scheduled-*.dump > /dev/null" > /dev/null 2>&1'
check "the container runs with the restart policy and the rotated json-file log driver" '[ "$(docker inspect -f "{{.HostConfig.RestartPolicy.Name}}/{{.HostConfig.LogConfig.Type}}/{{index .HostConfig.LogConfig.Config \"max-size\"}}/{{index .HostConfig.LogConfig.Config \"max-file\"}}" "$S")" = "unless-stopped/json-file/10m/5" ]'

echo "== the healthcheck COMMAND really detects a stale or missing backup (run by hand, not by waiting 26 hours)"
HC="$(docker inspect -f '{{index .Config.Healthcheck.Test 1}}' "$S")"
check "healthcheck passes now (a fresh .last-backup-ok)" 'docker exec "$S" sh -c "$HC" > /dev/null 2>&1'
docker exec "$S" sh -c 'echo $(( $(date -u +%s) - 93500 )) > /backups/.last-backup-ok'
check "…and still passes at 25.97 h old" 'docker exec "$S" sh -c "$HC" > /dev/null 2>&1'
docker exec "$S" sh -c 'echo $(( $(date -u +%s) - 93700 )) > /backups/.last-backup-ok'
check "…and FAILS at 26.03 h old (unhealthy after 3 retries)" '! docker exec "$S" sh -c "$HC" > /dev/null 2>&1'
docker exec "$S" rm -f /backups/.last-backup-ok
check "…and FAILS when .last-backup-ok is missing" '! docker exec "$S" sh -c "$HC" > /dev/null 2>&1'

echo "== a failing database keeps the history (the service retries, nothing is deleted)"
BEFORE="$(docker exec "$S" sh -c 'ls -1 /backups/scheduled-*.dump | wc -l' | tr -d '\r')"
dc stop postgres > /dev/null 2>&1
docker exec "$S" sh -c 'BACKUP_RUN_ONCE=1 /ops/backup-loop.sh' > "$TMP/fail.out" 2>&1
RC=$?
AFTER="$(docker exec "$S" sh -c 'ls -1 /backups/scheduled-*.dump | wc -l' | tr -d '\r')"
check "with PostgreSQL stopped the cycle fails (exit 1), says BACKUP FAILED, and the dump count is unchanged ($BEFORE -> $AFTER)" '[ $RC -eq 1 ] && grep -q "BACKUP FAILED" "$TMP/fail.out" && [ "$BEFORE" = "$AFTER" ]'
check ".last-backup-failed is recorded and no partial file is left" 'docker exec "$S" sh -c "test -f /backups/.last-backup-failed && ! ls /backups/*.partial > /dev/null 2>&1"'

echo "### scheduler service test: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
