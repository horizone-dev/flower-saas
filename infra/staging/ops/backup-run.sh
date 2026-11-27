#!/bin/sh
# One VERIFIED logical backup of the application database.
#   backup-run.sh [scheduled|pre-migrate]
# Environment: PGHOST PGUSER PGDATABASE (and PGPASSWORD) as for any libpq tool; BACKUP_DIR (default /backups); BACKUP_MIN_BYTES (default 4096).
# The dump is written to a .partial file, must be readable by `pg_restore --list` and larger than a floor, and only then is it renamed into place
# with a SHA-256 sidecar. A failed or interrupted run leaves no half-written file under a final name. Nothing here prints a secret.
set -eu

PREFIX="${1:-scheduled}"
DIR="${BACKUP_DIR:-/backups}"
case "$PREFIX" in
  scheduled | pre-migrate) ;;
  *)
    echo "refused: unknown backup prefix '$PREFIX' (scheduled | pre-migrate)" >&2
    exit 2
    ;;
esac
: "${PGHOST:?refused: PGHOST is required}" "${PGUSER:?refused: PGUSER is required}" "${PGDATABASE:?refused: PGDATABASE is required}"
[ -d "$DIR" ] || { echo "refused: backup directory $DIR does not exist" >&2; exit 2; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$DIR/$PREFIX-$TS.dump"
PART="$FINAL.partial"
[ ! -e "$FINAL" ] || { echo "refused: $FINAL already exists (two backups in one second)" >&2; exit 4; }
trap 'rm -f "$PART"' EXIT INT TERM

pg_dump -Fc -f "$PART"
pg_restore --list "$PART" > /dev/null
SIZE="$(wc -c < "$PART" | tr -d ' ')"
if [ "$SIZE" -lt "${BACKUP_MIN_BYTES:-4096}" ]; then
  echo "refused: the dump is only $SIZE bytes (floor ${BACKUP_MIN_BYTES:-4096}) — treating it as a failed backup" >&2
  exit 3
fi
mv "$PART" "$FINAL"
(cd "$DIR" && sha256sum "$(basename "$FINAL")" > "$(basename "$FINAL").sha256")
echo "backup verified: $FINAL ($SIZE bytes)"
