#!/usr/bin/env bash
# Tests for the staging recovery scripts (backup / retention / scheduler / roles bootstrap + restore / Redis flush) against DISPOSABLE containers.
#   bash infra/staging/ops/ops.test.sh
# Creates and removes ONLY resources named flower-offhost-probe-* (containers, one network, one volume). Never touches the staging stack.
# Needs docker and the images pinned in infra/staging (PostgreSQL from postgres-image.pin, Redis from the compose file). No secret is real.
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
HERE="$(cd "$(dirname "$0")" && pwd)"
OPS_MOUNT="$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))" # a Windows path for Docker Desktop, the plain path elsewhere
STAGING="$(cd "$HERE/.." && pwd)"
PGIMG="$(grep -vE '^[[:space:]]*(#|$)' "$STAGING/postgres-image.pin" | head -1)"
REDISIMG="$(grep -E '^[[:space:]]+image: redis' "$STAGING/docker-compose.staging.yml" | head -1 | sed 's/.*image: *//')"
NET=flower-offhost-probe-net
VOL=flower-offhost-probe-backups
SRC=flower-offhost-probe-src
DST=flower-offhost-probe-dst
RED=flower-offhost-probe-redis
API=flower-offhost-probe-api
PW="probe-$(date +%s)-$RANDOM$RANDOM"
PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
# each assertion runs in a SUBSHELL: an `exit` or a failing command inside one assertion fails that assertion only and can never end the whole run
check() { if ( eval "$2" ); then ok "$1"; else bad "$1"; fi; }
cleanup() {
  for c in $SRC $DST $RED $API; do docker rm -f "$c" > /dev/null 2>&1; done
  docker volume rm "$VOL" > /dev/null 2>&1
  docker network rm "$NET" > /dev/null 2>&1
}
trap cleanup EXIT
cleanup
echo "### ops tests: postgres=$PGIMG redis=${REDISIMG:0:40}"
[ -n "$PGIMG" ] && [ -n "$REDISIMG" ] || { echo "cannot read the pinned images"; exit 2; }

docker network create "$NET" > /dev/null || exit 2
docker volume create "$VOL" > /dev/null || exit 2
for n in $SRC $DST; do docker run -d --name "$n" --network "$NET" -e POSTGRES_PASSWORD="$PW" "$PGIMG" > /dev/null || exit 2; done
docker run -d --name "$RED" --network "$NET" -e REDIS_PASSWORD="$PW" "$REDISIMG" sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD"' > /dev/null || exit 2
docker run -d --name "$API" --entrypoint sleep "$PGIMG" 600 > /dev/null || exit 2 # a stand-in "API" container: anything that is running and can be stopped
# Readiness: bounded (90 s) and over TCP. The official image runs a TEMPORARY server on the unix socket only while it initialises, so a socket
# pg_isready can succeed, then fail again when the real server starts (the start-up race that aborted a run); the temporary server does not listen
# on TCP, so a TCP answer means the real server. Two consecutive real queries over TCP are required.
wait_pg() {
  local n="$1" ok_in_a_row=0 i
  for i in $(seq 1 90); do
    if docker exec "$n" pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1 && docker exec "$n" psql -h 127.0.0.1 -U postgres -Atc 'select 1' > /dev/null 2>&1; then
      ok_in_a_row=$((ok_in_a_row + 1)); [ "$ok_in_a_row" -ge 2 ] && return 0
    else ok_in_a_row=0; fi
    sleep 1
  done
  echo "$n did not become ready within 90 s (last log lines follow)"; docker logs --tail 5 "$n" 2>&1 | cut -c1-160
  return 1
}
for n in $SRC $DST; do wait_pg "$n" || exit 2; done

psql_in() { docker exec -i "$1" psql -U postgres -v ON_ERROR_STOP=1 -X -q "${@:2}"; }
psql_val() { docker exec -i "$1" psql -U postgres -At -X "${@:2}" | tr -d '\r'; }
# small named probes so the checks below read as what they test
db_count() { psql_val "$1" -c "SELECT count(*) FROM pg_database WHERE datname = 'flower'"; }
flower_roles() { psql_val "$1" -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'flower\_%'"; }
flower_login_roles() { psql_val "$1" -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'flower\_%' AND rolcanlogin"; }
tenant_owner() { psql_val "$1" -d flower -c "SELECT tableowner FROM pg_tables WHERE tablename = 'tenant'"; }
app_can_select() { psql_val "$1" -d flower -c "SELECT has_table_privilege('flower_app', 'tenant', 'SELECT')"; }
src_counts() { psql_val "$1" -d flower -c "SELECT (SELECT count(*) FROM tenant) || '/' || (SELECT count(*) FROM _prisma_migrations)"; }
# the toolbox: the pinned PostgreSQL client image on the probe network with the ops scripts and the probe volume mounted
tb() { docker run --rm --network "$NET" -v "$OPS_MOUNT:/ops:ro" -v "$VOL:/backups" -e PGHOST="$SRC" -e PGUSER=postgres -e PGPASSWORD="${PGPASSWORD_OVERRIDE:-$PW}" -e PGDATABASE=flower -e BACKUP_MIN_BYTES="${BACKUP_MIN_BYTES:-1}" -e BACKUP_KEEP="${BACKUP_KEEP:-14}" -e BACKUP_RUN_ONCE="${BACKUP_RUN_ONCE:-}" --entrypoint sh "$PGIMG" -c "$1"; }
hp() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
files() { tb "cd /backups && ls -1A | sort" 2> /dev/null | tr -d '\r'; }

echo "== 0. roles bootstrap on the source server, then a small Flower-shaped database"
psql_in $SRC -f - < "$HERE/roles-bootstrap.sql" && ok "roles-bootstrap.sql runs on a fresh cluster" || bad "roles-bootstrap.sql on a fresh cluster"
psql_in $SRC -f - < "$HERE/roles-bootstrap.sql" && ok "roles-bootstrap.sql is idempotent (second run)" || bad "roles-bootstrap.sql second run"
ATTR="$(psql_val $SRC -c "SELECT string_agg(rolname||':'||rolsuper::int||rolbypassrls::int||rolcreatedb::int||rolcreaterole::int||':'||rolcanlogin::int, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'flower\_%'")"
check "attributes: app 0000, dispatcher 0100, migrate 0010, platform 0100, none can log in ($ATTR)" '[ "$ATTR" = "flower_app:0000:0,flower_dispatcher:0100:0,flower_migrate:0010:0,flower_platform:0100:0" ]'
psql_in $SRC -c "CREATE DATABASE flower" > /dev/null
psql_in $SRC -d flower -f - > /dev/null << 'SQL'
CREATE TABLE tenant (id int PRIMARY KEY, name text NOT NULL);
ALTER TABLE tenant OWNER TO flower_migrate;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant USING (id = 1);
GRANT SELECT ON tenant TO flower_app;
INSERT INTO tenant VALUES (1, 'a'), (2, 'b');
CREATE TABLE _prisma_migrations (id serial PRIMARY KEY, migration_name text NOT NULL);
INSERT INTO _prisma_migrations (migration_name) VALUES ('m1'), ('m2'), ('m3');
SQL
check "source database prepared (2 tenants, 3 migrations)" '[ "$(src_counts $SRC)" = "2/3" ]'

echo "== 1. backup-run.sh"
tb "/ops/backup-run.sh scheduled" > /tmp/ops-t1.out 2>&1; RC=$?
check "a scheduled backup succeeds (exit 0) and says 'backup verified'" '[ $RC -eq 0 ] && grep -q "backup verified: /backups/scheduled-" /tmp/ops-t1.out'
F="$(files)"
check "the dump has its sha256 sidecar and no .partial is left" 'echo "$F" | grep -qE "^scheduled-[0-9]{8}T[0-9]{6}Z\.dump$" && echo "$F" | grep -qE "^scheduled-[0-9]{8}T[0-9]{6}Z\.dump\.sha256$" && ! echo "$F" | grep -q "\.partial"'
tb "/ops/backup-run.sh nightly" > /tmp/ops-t1b.out 2>&1; RC=$?
check "an unknown prefix is refused (exit 2)" '[ $RC -eq 2 ] && grep -q "unknown backup prefix" /tmp/ops-t1b.out'
# backup file names have one-second resolution and backup-run.sh REFUSES a second backup in the same second (exit 4). A fast runner can reach this run inside the
# second of the first one and get 4 instead of the 3 asserted below, so wait out that second (the assertions are unchanged; this only removes the race)
sleep 1
BACKUP_MIN_BYTES=999999999 tb "/ops/backup-run.sh scheduled" > /tmp/ops-t1c.out 2>&1; RC=$?
F2="$(files)"
check "a dump below the size floor is refused (exit 3), leaves no partial and no new final file" '[ $RC -eq 3 ] && ! echo "$F2" | grep -q "\.partial" && [ "$(echo "$F2" | grep -c "\.dump$")" = "$(echo "$F" | grep -c "\.dump$")" ]'
PGPASSWORD_OVERRIDE=wrong-password tb "/ops/backup-run.sh scheduled" > /tmp/ops-t1d.out 2>&1; RC=$?
F3="$(files)"
check "a failing pg_dump (wrong password) fails (exit != 0), leaves no partial and no new final file" '[ $RC -ne 0 ] && ! echo "$F3" | grep -q "\.partial" && [ "$(echo "$F3" | grep -c "\.dump$")" = "$(echo "$F" | grep -c "\.dump$")" ]'
check "no password appears in any output" '! grep -q "$PW" /tmp/ops-t1.out /tmp/ops-t1b.out /tmp/ops-t1c.out /tmp/ops-t1d.out'
tb "BACKUP_DIR=/nope /ops/backup-run.sh scheduled" > /tmp/ops-t1e.out 2>&1; RC=$?
check "a missing backup directory is refused (exit 2)" '[ $RC -eq 2 ]'

echo "== 2. backup-prune.sh"
tb "
cd /backups
rm -f scheduled-* pre-migrate-* foreign.txt
for t in 20260101T000000Z 20260102T000000Z 20260103T000000Z 20260104T000000Z 20260105T000000Z 20260106T000000Z; do
  echo \"data \$t\" > scheduled-\$t.dump; sha256sum scheduled-\$t.dump > scheduled-\$t.dump.sha256
done
echo corrupt > scheduled-20260107T000000Z.dump; echo 'deadbeef  scheduled-20260107T000000Z.dump' > scheduled-20260107T000000Z.dump.sha256   # bad sidecar (newest by name)
echo nosidecar > scheduled-20260108T000000Z.dump                                                                                              # no sidecar
echo pm > pre-migrate-20260101T000000Z.dump; sha256sum pre-migrate-20260101T000000Z.dump > pre-migrate-20260101T000000Z.dump.sha256
echo part > scheduled-20260109T000000Z.dump.partial
echo x > foreign.txt
" > /dev/null 2>&1
for k in 2 abc ""; do tb "/ops/backup-prune.sh /backups scheduled '$k'" > /tmp/ops-t2.out 2>&1; check "keep='$k' is refused" '[ $? -ne 0 ] && grep -qiE "refused|usage" /tmp/ops-t2.out'; done
tb "/ops/backup-prune.sh /backups pre-migrate 3" > /tmp/ops-t2.out 2>&1; RC=$?
check "pruning pre-migrate dumps is refused (they are rollback points)" '[ $RC -eq 2 ] && grep -q "pre-migrate" /tmp/ops-t2.out'
tb "/ops/backup-prune.sh /backups scheduled 3" > /tmp/ops-t2.out 2>&1; RC=$?
G="$(files)"
check "keep 3: exit 0 and the 3 OLDEST verified dumps are pruned" '[ $RC -eq 0 ] && grep -q "pruned: scheduled-20260101T000000Z.dump" /tmp/ops-t2.out && grep -q "pruned: scheduled-20260103T000000Z.dump" /tmp/ops-t2.out && ! echo "$G" | grep -qE "scheduled-2026010[123]T000000Z\.dump"'
check "the newest 3 verified dumps (04, 05, 06) and their sidecars are kept" 'for d in 04 05 06; do echo "$G" | grep -qx "scheduled-202601${d}T000000Z.dump" && echo "$G" | grep -qx "scheduled-202601${d}T000000Z.dump.sha256" || exit 1; done'
check "an unverified dump, a dump without a sidecar, a partial, a pre-migrate dump and a foreign file are all untouched" 'echo "$G" | grep -qx "scheduled-20260107T000000Z.dump" && echo "$G" | grep -qx "scheduled-20260108T000000Z.dump" && echo "$G" | grep -qx "scheduled-20260109T000000Z.dump.partial" && echo "$G" | grep -qx "pre-migrate-20260101T000000Z.dump" && echo "$G" | grep -qx "foreign.txt"'
check "the pruned dumps' sidecars are gone too (no orphan sidecars)" '! echo "$G" | grep -qE "scheduled-2026010[123]T000000Z\.dump\.sha256"'
tb "/ops/backup-prune.sh /backups scheduled 3" > /tmp/ops-t2b.out 2>&1
check "a second run has nothing to prune and deletes nothing" '[ "$(files)" = "$G" ] && grep -q "nothing to prune" /tmp/ops-t2b.out'

echo "== 3. backup-loop.sh (one cycle)"
BACKUP_RUN_ONCE=1 BACKUP_KEEP=3 tb "/ops/backup-loop.sh" > /tmp/ops-t3.out 2>&1; RC=$?
H="$(files)"
check "success cycle: exit 0, .last-backup-ok written, a new verified dump exists" '[ $RC -eq 0 ] && echo "$H" | grep -qx ".last-backup-ok" && ! echo "$H" | grep -qx ".last-backup-failed" && [ "$(echo "$H" | grep -cE "^scheduled-[0-9]{8}T[0-9]{6}Z\.dump$")" -ge 4 ]'
check "success cycle pruned back to the newest 3 VERIFIED dumps (the new one + 2 newest old verified; 04 is gone)" '! echo "$H" | grep -qx "scheduled-20260104T000000Z.dump" && echo "$H" | grep -qx "scheduled-20260106T000000Z.dump"'
# seed two extra OLD verified dumps so that MORE than KEEP exist: a prune during the failing cycle would now delete them (the property is tested, not vacuous)
tb "cd /backups; for t in 20250101T000000Z 20250102T000000Z; do echo old-\$t > scheduled-\$t.dump; sha256sum scheduled-\$t.dump > scheduled-\$t.dump.sha256; done" > /dev/null 2>&1
check "setup: more than KEEP (3) verified scheduled dumps exist before the failing cycle" '[ "$(files | grep -cE "^scheduled-[0-9]{8}T[0-9]{6}Z\.dump$")" -gt 3 ]'
BEFORE="$(files | grep -v '^\.last-backup' )"
PGPASSWORD_OVERRIDE=wrong-password BACKUP_RUN_ONCE=1 BACKUP_KEEP=3 tb "sleep 1; /ops/backup-loop.sh" > /tmp/ops-t3b.out 2>&1; RC=$? # sleep 1: a same-second collision with the cycle above would also fail, for the wrong reason (exit 4, not the password)
AFTER="$(files | grep -v '^\.last-backup')"
check "FAILURE cycle: exit 1, .last-backup-failed written, and NOTHING was deleted (the history is intact)" '[ $RC -eq 1 ] && files | grep -qx ".last-backup-failed" && [ "$BEFORE" = "$AFTER" ] && grep -q "BACKUP FAILED" /tmp/ops-t3b.out'
BACKUP_RUN_ONCE=1 BACKUP_KEEP=3 tb "sleep 1; /ops/backup-loop.sh" > /tmp/ops-t3c.out 2>&1
check "a later success clears .last-backup-failed" '! files | grep -qx ".last-backup-failed" && files | grep -qx ".last-backup-ok"'
check "the recorded success time is a recent epoch" 'T=$(tb "cat /backups/.last-backup-ok" | tr -d "\r"); N=$(date -u +%s); [ $((N - T)) -ge 0 ] && [ $((N - T)) -lt 600 ]'

echo "== 4. restore onto a FRESH server (roles first)"
tb "ls /backups/scheduled-*.dump | tail -1" | tr -d '\r' > /tmp/ops-lastdump.txt
LAST="$(basename "$(cat /tmp/ops-lastdump.txt)")"
rm -rf /tmp/ops-restore && mkdir -p /tmp/ops-restore
docker run --rm -v "$VOL:/backups:ro" -v "$(cd /tmp/ops-restore && (pwd -W 2>/dev/null || pwd)):/out" --entrypoint sh "$PGIMG" -c "cp /backups/$LAST /backups/$LAST.sha256 /out/" > /dev/null 2>&1
D=/tmp/ops-restore/$LAST
check "the newest scheduled dump and its sidecar were copied out of the volume (the 'off-host' copy)" '[ -s "$D" ] && [ -s "$D.sha256" ]'
# negative control: without the roles the restore must FAIL
docker cp "$(hp "$D")" $DST:/tmp/control.dump > /dev/null
docker exec $DST createdb -U postgres control > /dev/null
docker exec $DST pg_restore -U postgres -d control --exit-on-error /tmp/control.dump > /tmp/ops-t4a.out 2>&1; RC=$?
check "NEGATIVE CONTROL: pg_restore on a fresh cluster WITHOUT the roles fails ('role ... does not exist')" '[ $RC -ne 0 ] && grep -q "does not exist" /tmp/ops-t4a.out'
docker exec $DST dropdb -U postgres control > /dev/null
# refusals
cp "$D" /tmp/ops-restore/nosidecar.dump
bash "$HERE/restore-offhost.sh" /tmp/ops-restore/nosidecar.dump $DST flower > /tmp/ops-t4b.out 2>&1; RC=$?
check "a dump without a sidecar is refused" '[ $RC -eq 2 ] && grep -q "sha256 sidecar" /tmp/ops-t4b.out'
cp "$D" /tmp/ops-restore/tampered.dump; cp "$D.sha256" /tmp/ops-restore/tampered.dump.sha256; sed -i "s/$LAST/tampered.dump/" /tmp/ops-restore/tampered.dump.sha256; printf 'x' >> /tmp/ops-restore/tampered.dump
bash "$HERE/restore-offhost.sh" /tmp/ops-restore/tampered.dump $DST flower > /tmp/ops-t4c.out 2>&1; RC=$?
check "a tampered dump (hash mismatch) is refused before anything is touched" '[ $RC -eq 2 ] && grep -q "does not match" /tmp/ops-t4c.out'
check "the refused attempts created no database and no roles on the target" '[ "$(db_count $DST)" = "0" ] && [ "$(flower_roles $DST)" = "0" ]'
# happy path
bash "$HERE/restore-offhost.sh" "$D" $DST flower > /tmp/ops-t4d.out 2>&1; RC=$?
check "restore onto the fresh server succeeds (exit 0)" '[ $RC -eq 0 ] && grep -q "restore complete" /tmp/ops-t4d.out'
check "post-checks printed: 1 policy (= the dump), 1 table with row level security, 3 migrations" 'grep -q "policies=1 (dump: 1), tables with row level security=1, applied migrations=3" /tmp/ops-t4d.out'
check "the data came across (2 tenants, 3 migrations) and the four roles exist with login disabled" '[ "$(src_counts $DST)" = "2/3" ] && [ "$(flower_roles $DST)" = "4" ] && [ "$(flower_login_roles $DST)" = "0" ]'
check "ownership and grants survived (tenant owned by flower_migrate; flower_app can SELECT)" '[ "$(tenant_owner $DST)" = "flower_migrate" ] && [ "$(app_can_select $DST)" = "t" ]'
bash "$HERE/restore-offhost.sh" "$D" $DST flower > /tmp/ops-t4e.out 2>&1; RC=$?
check "a second restore into the same database is refused (never restores over data)" '[ $RC -eq 2 ] && grep -q "already exists" /tmp/ops-t4e.out'
# drift
docker exec $DST psql -U postgres -c "ALTER ROLE flower_app BYPASSRLS" > /dev/null
psql_in $DST -f - < "$HERE/roles-bootstrap.sql" > /tmp/ops-t4f.out 2>&1; RC=$?
check "role attribute drift (flower_app given BYPASSRLS) makes the bootstrap FAIL CLOSED" '[ $RC -ne 0 ] && grep -q "flower_app" /tmp/ops-t4f.out && grep -q "differ from the migrations" /tmp/ops-t4f.out'
docker exec $DST psql -U postgres -c "ALTER ROLE flower_app NOBYPASSRLS" > /dev/null

echo "== 5. flush-redis-sessions.sh"
rcli() { docker exec "$RED" sh -c "redis-cli -a \"\$REDIS_PASSWORD\" --no-auth-warning $1" | tr -d '\r'; }
rcli "SET session:abc 1" > /dev/null; rcli "SET session:def 1" > /dev/null; rcli "SET ratelimit:x 5" > /dev/null
bash "$HERE/flush-redis-sessions.sh" $RED $API > /tmp/ops-t5a.out 2>&1; RC=$?
check "while the API container is RUNNING the flush is refused and no key is touched" '[ $RC -eq 2 ] && grep -q "is running" /tmp/ops-t5a.out && [ "$(rcli DBSIZE)" = "3" ]'
bash "$HERE/flush-redis-sessions.sh" $RED flower-offhost-probe-does-not-exist > /tmp/ops-t5b.out 2>&1; RC=$?
check "an unknown API container name is refused (the script must be able to prove the API is stopped)" '[ $RC -eq 2 ] && grep -q "not found" /tmp/ops-t5b.out && [ "$(rcli DBSIZE)" = "3" ]'
docker stop -t 1 $API > /dev/null
bash "$HERE/flush-redis-sessions.sh" $RED $API > /tmp/ops-t5c.out 2>&1; RC=$?
check "with the API stopped the flush succeeds: 3 keys removed, 0 remain" '[ $RC -eq 0 ] && grep -q "3 key(s) removed, 0 remain" /tmp/ops-t5c.out && [ "$(rcli DBSIZE)" = "0" ]'
check "the output names no key and no password" '! grep -qE "session:|ratelimit:|$PW" /tmp/ops-t5a.out /tmp/ops-t5b.out /tmp/ops-t5c.out'
bash "$HERE/flush-redis-sessions.sh" flower-offhost-probe-nope $API > /tmp/ops-t5d.out 2>&1; RC=$?
check "a missing Redis container is refused" '[ $RC -eq 2 ] && grep -q "is not running" /tmp/ops-t5d.out'

[ -n "${OPS_TEST_KEEP_OUT:-}" ] || rm -rf /tmp/ops-restore /tmp/ops-t*.out /tmp/ops-lastdump.txt
echo "### ops tests: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
