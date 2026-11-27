#!/bin/sh
# Invalidate every session / rate limit / idempotency key after a DATABASE ROLLBACK or RESTORE.
#   flush-redis-sessions.sh <redis-container> <api-container>
# Why: sessions live in Redis, not in the backup. After the database goes back, a token issued in the "new" era would still be accepted by the
# old software (measured: HTTP 200 without the flush, 401 with it). Order of a rollback: stop the API -> restore the database -> THIS ->
# start the previous API. The script REFUSES while the API container is running (a running API would simply re-create sessions from a
# half-restored world). Prints counts only, never a key name.
set -eu

REDIS="${1:?usage: flush-redis-sessions.sh <redis-container> <api-container>}"
API="${2:?usage: flush-redis-sessions.sh <redis-container> <api-container>}"

[ "$(docker inspect -f '{{.State.Running}}' "$REDIS" 2> /dev/null || echo missing)" = "true" ] || { echo "refused: $REDIS is not running" >&2; exit 2; }
API_STATE="$(docker inspect -f '{{.State.Running}}' "$API" 2> /dev/null || echo missing)"
case "$API_STATE" in
  false) ;;
  true) echo "refused: $API is running — stop the API first, then flush, then start the previous API" >&2; exit 2 ;;
  *) echo "refused: container $API not found (pass the API container name so the script can prove it is stopped)" >&2; exit 2 ;;
esac

BEFORE="$(docker exec "$REDIS" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DBSIZE' | tr -d '\r' | tr -dc '0-9')"
docker exec "$REDIS" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL' | tr -d '\r' | grep -qx OK || { echo "FAILED: FLUSHALL was not acknowledged" >&2; exit 1; }
AFTER="$(docker exec "$REDIS" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DBSIZE' | tr -d '\r' | tr -dc '0-9')"
[ "$AFTER" = "0" ] || { echo "FAILED: $AFTER keys remain after FLUSHALL" >&2; exit 1; }
echo "redis flushed: $BEFORE key(s) removed, $AFTER remain; the previous API may now be started"
