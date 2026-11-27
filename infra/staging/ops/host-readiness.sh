#!/usr/bin/env bash
# READ-ONLY readiness check of a running staging stack, for the host (by hand, or from cron with the output mailed on failure):
#   bash infra/staging/ops/host-readiness.sh <env-file>
# It changes nothing and prints no secret (it reads only the three host names from the env file). Exit 0 only if EVERY check passes;
# a check that cannot be evaluated FAILS (fail closed): "I could not look" is never "ok".
#   1  every long-running service is running, and every service that has a healthcheck is healthy
#   2  the API's /readyz reports ok (the route is internal: it is not reachable through the public hosts)
#   3  a verified scheduled backup finished within MAX_BACKUP_AGE_S (default 93600 = 26 h)
#   4  the four application containers run from an IMMUTABLE image reference (name@sha256:… or sha256:…), never a tag
#   5  every container's log is rotated (json-file with max-size and max-file)
#   6  the disk that holds Docker's data has at least MIN_FREE_PCT free (default 20)
#   7  the TLS certificate of each public host is valid for at least MIN_CERT_DAYS more days (default 14), checked over the real port 443
#   8  the system clock is synchronised (token expiry and TOTP depend on it)
set -u
ENVF="${1:-}"
[ -n "$ENVF" ] || { echo "usage: host-readiness.sh <env-file>" >&2; exit 2; }
PROJECT="${COMPOSE_PROJECT_NAME:-flower-staging}"
MAX_BACKUP_AGE_S="${MAX_BACKUP_AGE_S:-93600}"
MIN_FREE_PCT="${MIN_FREE_PCT:-20}"
MIN_CERT_DAYS="${MIN_CERT_DAYS:-14}"
DOCKER_DATA_DIR="${DOCKER_DATA_DIR:-/var/lib/docker}"
TLS_PORT="${TLS_PORT:-443}"
PASS=0
FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
[ -f "$ENVF" ] || { echo "refused: env file not found: $ENVF" >&2; exit 2; }
command -v docker > /dev/null 2>&1 || { echo "refused: docker is not available" >&2; exit 2; }
case "$MAX_BACKUP_AGE_S$MIN_FREE_PCT$MIN_CERT_DAYS" in *[!0-9]*) echo "refused: thresholds must be whole numbers" >&2; exit 2 ;; esac
# the env file is read by pattern, never sourced or evaluated
envval() { sed -n "s/^$1=//p" "$ENVF" | head -1 | tr -d '\r"'"'"; }
DC() { docker compose -p "$PROJECT" "$@"; }

# 1. services
LONG="postgres redis minio api pos owner-web caddy backup-scheduler"
WITH_HC="postgres redis api pos owner-web backup-scheduler"
PS="$(DC ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' 2> /dev/null)"
if [ -z "$PS" ]; then
  bad "services: no containers found for project $PROJECT (is the stack up?)"
else
  for s in $LONG; do
    line="$(printf '%s\n' "$PS" | grep -E "^$s\|" | head -1)"
    state="$(printf '%s' "$line" | cut -d'|' -f2)"
    health="$(printf '%s' "$line" | cut -d'|' -f3 | tr -d '\r')"
    if [ -z "$line" ]; then bad "service $s: not found"
    elif [ "$state" != "running" ]; then bad "service $s: state is '$state', not running"
    elif printf ' %s ' "$WITH_HC" | grep -q " $s " && [ "$health" != "healthy" ]; then bad "service $s: running but health is '${health:-none}'"
    else ok "service $s: running${health:+, $health}"; fi
  done
fi

# 2. readiness (all four dependency checks inside the API)
READY="$(DC exec -T api node -e "fetch('http://127.0.0.1:3001/readyz').then(async r=>console.log((await r.json()).status))" 2> /dev/null | tr -d '\r')"
[ "$READY" = "ok" ] && ok "api /readyz: ok" || bad "api /readyz: '${READY:-no answer}', not ok"

# 3. backup freshness
LAST="$(DC exec -T backup-scheduler cat /backups/.last-backup-ok 2> /dev/null | tr -d '\r\n')"
NOW="$(date -u +%s)"
case "$LAST" in
  '' | *[!0-9]*) bad "backup: no .last-backup-ok (no verified scheduled backup has finished)" ;;
  *) AGE=$((NOW - LAST))
     if [ "$AGE" -lt 0 ]; then bad "backup: the last success is in the future (clock problem)"
     elif [ "$AGE" -le "$MAX_BACKUP_AGE_S" ]; then ok "backup: last verified backup ${AGE}s ago (limit ${MAX_BACKUP_AGE_S}s)"
     else bad "backup: last verified backup ${AGE}s ago, older than ${MAX_BACKUP_AGE_S}s"; fi ;;
esac

# 4. immutable application images, 5. rotated logs
for s in api pos owner-web migrate seed roles; do
  cid="$(DC ps -a -q "$s" 2> /dev/null | head -1)"
  if [ -z "$cid" ]; then
    # the one-shot jobs may have been removed; the three long-running application containers must exist
    case "$s" in api | pos | owner-web) bad "image $s: container not found" ;; esac
    continue
  fi
  ref="$(docker inspect -f '{{.Config.Image}}' "$cid" 2> /dev/null)"
  if printf '%s' "$ref" | grep -Eq '^([^[:space:]@]+@)?sha256:[0-9a-f]{64}$'; then ok "image $s: immutable reference"
  else bad "image $s: '${ref:-unknown}' is not an immutable reference (tag, or unreadable)"; fi
done
ALL="$(DC ps -a -q 2> /dev/null)"
if [ -z "$ALL" ]; then bad "logs: no containers to inspect"
else
  LOGBAD=0
  for cid in $ALL; do
    cfg="$(docker inspect -f '{{.Name}} {{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}' "$cid" 2> /dev/null)"
    set -- $cfg
    if [ "${2:-}" != "json-file" ] || [ -z "${3:-}" ] || [ -z "${4:-}" ] || [ "${3:-}" = "<no" ]; then bad "logs: ${1:-$cid} is not rotated ('${cfg:-unreadable}')"; LOGBAD=1; fi
  done
  [ "$LOGBAD" -eq 0 ] && ok "logs: every container uses json-file with max-size and max-file"
fi

# 6. disk
USED="$(df -P "$DOCKER_DATA_DIR" 2> /dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 }')"
case "$USED" in
  '' | *[!0-9]*) bad "disk: cannot read the usage of $DOCKER_DATA_DIR" ;;
  *) FREE=$((100 - USED))
     if [ "$FREE" -ge "$MIN_FREE_PCT" ]; then ok "disk: ${FREE}% free on $DOCKER_DATA_DIR (limit ${MIN_FREE_PCT}%)"
     else bad "disk: only ${FREE}% free on $DOCKER_DATA_DIR (limit ${MIN_FREE_PCT}%)"; fi ;;
esac

# 7. TLS, over the real port, per public host
command -v openssl > /dev/null 2>&1 || bad "tls: openssl is not available (cannot check certificates)"
if command -v openssl > /dev/null 2>&1; then
  SECS=$((MIN_CERT_DAYS * 86400))
  for key in POS_HOST OWNER_HOST OPS_HOST; do
    host="$(envval "$key")"
    case "$host" in '' | *[!a-zA-Z0-9.-]*) bad "tls: $key is missing or not a host name in the env file"; continue ;; esac
    cert="$(printf '' | openssl s_client -servername "$host" -connect "$host:$TLS_PORT" 2> /dev/null)"
    if printf '%s' "$cert" | openssl x509 -noout -checkend "$SECS" > /dev/null 2>&1; then ok "tls: $host certificate valid for at least $MIN_CERT_DAYS more days"
    else bad "tls: $host certificate is expired, expires within $MIN_CERT_DAYS days, or could not be read over port $TLS_PORT"; fi
  done
fi

# 8. clock
SYNC="$(timedatectl show -p NTPSynchronized --value 2> /dev/null | tr -d '\r\n')"
[ "$SYNC" = "yes" ] && ok "clock: synchronised" || bad "clock: NTPSynchronized is '${SYNC:-unknown}'"

echo "### host readiness: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
