#!/usr/bin/env bash
# Tests for host-readiness.sh WITHOUT a host and without Docker: `docker`, `openssl`, `df` and `timedatectl` are replaced by shims that
# answer from files, so every pass and every failure path (and the fail-closed "could not look" paths) is exercised.
#   bash infra/staging/ops/host-readiness.sh is run as a black box; nothing outside a temporary directory is touched.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/host-readiness.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
S="$T/shim"
mkdir -p "$S/state"
PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

DG='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
cat > "$S/docker" << 'SHIM'
#!/usr/bin/env bash
ST="$(dirname "$0")/state"
args="$*"
case "$args" in
  *"ps -a --format"*) cat "$ST/ps.txt" 2> /dev/null ;;
  *"exec -T api node"*) cat "$ST/readyz.txt" 2> /dev/null || exit 1 ;;
  *"exec -T backup-scheduler cat"*) cat "$ST/last-backup.txt" 2> /dev/null || exit 1 ;;
  *"ps -a -q "*) svc="${args##*ps -a -q }"; [ -f "$ST/missing-$svc" ] || echo "cid-$svc" ;;
  *"ps -a -q"*) for f in api pos owner-web migrate seed roles postgres redis; do echo "cid-$f"; done ;;
  inspect*) cid="${args##* }"; svc="${cid#cid-}"
    case "$args" in
      *".Config.Image"*) cat "$ST/image-$svc.txt" 2> /dev/null || exit 1 ;;
      *".HostConfig.LogConfig.Type"*) cat "$ST/log-$svc.txt" 2> /dev/null || echo "/$svc json-file 10m 5" ;;
    esac ;;
  *) exit 1 ;;
esac
SHIM
cat > "$S/openssl" << 'SHIM'
#!/usr/bin/env bash
ST="$(dirname "$0")/state"
case "$1" in
  s_client) host=""; while [ $# -gt 0 ]; do [ "$1" = "-servername" ] && host="$2"; shift; done; echo "CERT-$host" ;;
  x509) read -r line; host="${line#CERT-}"; [ "$(cat "$ST/tls-$host.txt" 2> /dev/null)" = "valid" ] ;;
  *) exit 1 ;;
esac
SHIM
cat > "$S/df" << 'SHIM'
#!/usr/bin/env bash
ST="$(dirname "$0")/state"
u="$(cat "$ST/df.txt" 2> /dev/null)"
[ -n "$u" ] || exit 1
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/x 1000 500 500 $u /var/lib/docker"
SHIM
cat > "$S/timedatectl" << 'SHIM'
#!/usr/bin/env bash
cat "$(dirname "$0")/state/ntp.txt" 2> /dev/null || exit 1
SHIM
chmod +x "$S"/*

ENVF="$T/env"
printf 'POS_HOST=pos.t.test\nOWNER_HOST=owner.t.test\nOPS_HOST=ops.t.test\nPOSTGRES_SUPERUSER_PASSWORD=never-printed-secret-0123456789\n' > "$ENVF"
reset() {
  rm -f "$S"/state/*
  {
    for s in postgres redis minio api pos owner-web caddy backup-scheduler; do
      case "$s" in minio | caddy) echo "$s|running|" ;; *) echo "$s|running|healthy" ;; esac
    done
    echo "migrate|exited|"; echo "seed|exited|"; echo "roles|exited|"
  } > "$S/state/ps.txt"
  echo ok > "$S/state/readyz.txt"
  date -u +%s > "$S/state/last-backup.txt"
  for s in api pos owner-web migrate seed roles; do echo "flower/$s@$DG" > "$S/state/image-$s.txt"; done
  echo '40%' > "$S/state/df.txt"
  for h in pos owner ops; do echo valid > "$S/state/tls-$h.t.test.txt"; done
  echo yes > "$S/state/ntp.txt"
}
run() { PATH="$S:$PATH" bash "$SUT" "${1:-$ENVF}" > "$T/out" 2>&1; RC=$?; }
expect_fail() { # <name> <substring that must be in a FAIL line>
  run
  if [ $RC -ne 0 ] && grep -E "^FAIL " "$T/out" | grep -qF -- "$2"; then ok "$1"; else bad "$1 (rc=$RC; wanted a FAIL line containing '$2'): $(grep -E '^FAIL' "$T/out" | head -3 | tr '\n' '|')"; fi
}

echo "== all good"
reset; run
if [ $RC -eq 0 ] && grep -q "FAIL=0" "$T/out" && ! grep -q "^FAIL " "$T/out"; then ok "every check passes (rc 0): $(grep -c '^PASS' "$T/out") PASS lines"; else bad "the all-good stack was not accepted (rc=$RC): $(grep -E '^FAIL' "$T/out" | head -3)"; fi
if grep -qE "never-printed-secret|password" "$T/out"; then bad "the output contains a secret"; else ok "no secret in the output"; fi

echo "== services"
reset; echo "" > "$S/state/ps.txt"; expect_fail "no containers at all (stack down) fails closed" "no containers found"
reset; sed -i 's/^api|running|healthy/api|exited|/' "$S/state/ps.txt"; expect_fail "a stopped api fails" "service api: state is 'exited'"
reset; sed -i 's/^redis|running|healthy/redis|running|unhealthy/' "$S/state/ps.txt"; expect_fail "an unhealthy redis fails" "service redis: running but health is 'unhealthy'"
reset; sed -i 's/^backup-scheduler|running|healthy/backup-scheduler|running|starting/' "$S/state/ps.txt"; expect_fail "a scheduler that is still 'starting' fails" "service backup-scheduler"
reset; sed -i '/^caddy|/d' "$S/state/ps.txt"; expect_fail "a missing caddy fails" "service caddy: not found"
reset; sed -i 's/^minio|running|/minio|restarting|/' "$S/state/ps.txt"; expect_fail "a restarting minio fails" "service minio: state is 'restarting'"
reset; sed -i 's/^postgres|running|healthy/postgres|running|/' "$S/state/ps.txt"; expect_fail "a postgres with no health value fails (a healthcheck that does not report is not healthy)" "service postgres"

echo "== readiness"
reset; echo degraded > "$S/state/readyz.txt"; expect_fail "readyz 'degraded' fails" "api /readyz: 'degraded'"
reset; rm "$S/state/readyz.txt"; expect_fail "no answer from readyz fails" "no answer"

echo "== backup freshness"
reset; echo $(( $(date -u +%s) - 93700 )) > "$S/state/last-backup.txt"; expect_fail "a backup 26.03 h old fails" "older than 93600s"
reset; echo $(( $(date -u +%s) - 93500 )) > "$S/state/last-backup.txt"; run; if [ $RC -eq 0 ]; then ok "a backup 25.97 h old passes"; else bad "25.97 h old should pass"; fi
reset; rm "$S/state/last-backup.txt"; expect_fail "no .last-backup-ok fails" "no .last-backup-ok"
reset; echo abc > "$S/state/last-backup.txt"; expect_fail "a garbage .last-backup-ok fails" "no .last-backup-ok"
reset; echo $(( $(date -u +%s) + 7200 )) > "$S/state/last-backup.txt"; expect_fail "a backup time in the future fails (clock problem)" "in the future"

echo "== immutable images"
reset; echo "flower/api:alpha" > "$S/state/image-api.txt"; expect_fail "an api on a tag fails" "image api: 'flower/api:alpha' is not an immutable reference"
reset; echo "$DG" > "$S/state/image-pos.txt"; run; if [ $RC -eq 0 ]; then ok "a bare image id is accepted"; else bad "a bare image id should pass"; fi
reset; echo "flower/owner-web@sha256:abc" > "$S/state/image-owner-web.txt"; expect_fail "a short digest fails" "image owner-web"
reset; rm "$S/state/image-seed.txt"; expect_fail "an unreadable image reference fails" "image seed"
reset; touch "$S/state/missing-api"; expect_fail "a missing api container fails" "image api: container not found"

echo "== log rotation"
reset; echo "/api json-file <no value> <no value>" > "$S/state/log-api.txt"; expect_fail "a container without max-size fails" "logs: /api is not rotated"
reset; echo "/redis local 10m 5" > "$S/state/log-redis.txt"; expect_fail "a container on the local driver fails" "logs: /redis is not rotated"
reset; echo "/pos json-file 10m" > "$S/state/log-pos.txt"; expect_fail "a container without max-file fails" "logs: /pos is not rotated"

echo "== disk"
reset; echo '81%' > "$S/state/df.txt"; expect_fail "81% used (19% free) fails" "only 19% free"
reset; echo '80%' > "$S/state/df.txt"; run; if [ $RC -eq 0 ]; then ok "80% used (20% free) passes (boundary)"; else bad "80% used should pass"; fi
reset; rm "$S/state/df.txt"; expect_fail "an unreadable df fails" "cannot read the usage"

echo "== TLS"
reset; echo expired > "$S/state/tls-pos.t.test.txt"; expect_fail "an expiring POS certificate fails" "tls: pos.t.test"
reset; rm "$S/state/tls-ops.t.test.txt"; expect_fail "an unreadable OPS certificate fails" "tls: ops.t.test"
reset; sed -i '/^OWNER_HOST=/d' "$ENVF"; expect_fail "a missing OWNER_HOST in the env file fails" "OWNER_HOST is missing"
printf 'POS_HOST=pos.t.test\nOWNER_HOST=owner.t.test\nOPS_HOST=ops.t.test\nPOSTGRES_SUPERUSER_PASSWORD=never-printed-secret-0123456789\n' > "$ENVF"
printf 'POS_HOST=pos.t.test;rm -rf x\nOWNER_HOST=owner.t.test\nOPS_HOST=ops.t.test\n' > "$ENVF.inj"
reset; run "$ENVF.inj"; if [ $RC -ne 0 ] && grep -q "POS_HOST is missing or not a host name" "$T/out"; then ok "a host value with shell characters is refused, not evaluated"; else bad "an injected host value was not refused (rc=$RC)"; fi

echo "== clock"
reset; echo no > "$S/state/ntp.txt"; expect_fail "an unsynchronised clock fails" "NTPSynchronized is 'no'"
reset; rm "$S/state/ntp.txt"; expect_fail "no timedatectl answer fails" "NTPSynchronized is 'unknown'"

echo "== argument handling"
PATH="$S:$PATH" bash "$SUT" > /dev/null 2>&1; [ $? -eq 2 ] && ok "no argument: usage, exit 2" || bad "no argument should exit 2"
PATH="$S:$PATH" bash "$SUT" "$T/nope" > /dev/null 2>&1; [ $? -eq 2 ] && ok "a missing env file: refused, exit 2" || bad "a missing env file should exit 2"
MAX_BACKUP_AGE_S=abc PATH="$S:$PATH" bash "$SUT" "$ENVF" > /dev/null 2>&1; [ $? -eq 2 ] && ok "a non-numeric threshold: refused, exit 2" || bad "a non-numeric threshold should exit 2"

echo "### host-readiness tests: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
