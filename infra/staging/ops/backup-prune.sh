#!/bin/sh
# Retention for SCHEDULED backups only:   backup-prune.sh <dir> scheduled <keep>
# Keeps the newest <keep> VERIFIED dumps and deletes the older ones (and their sidecars). "Verified" = a file named exactly
# scheduled-YYYYMMDDTHHMMSSZ.dump whose .sha256 sidecar matches. Refuses a keep below 3. Never touches pre-migrate dumps (they are the rollback
# points), partial files, unverified or foreign files, and never deletes the newest verified dump. A directory with fewer verified dumps than
# <keep> is left alone. The caller (backup-loop.sh) only prunes AFTER a new backup succeeded, so a failing backup never erodes the history.
set -eu

DIR="${1:?usage: backup-prune.sh <dir> scheduled <keep>}"
PREFIX="${2:?usage: backup-prune.sh <dir> scheduled <keep>}"
KEEP="${3:?usage: backup-prune.sh <dir> scheduled <keep>}"
[ "$PREFIX" = "scheduled" ] || { echo "refused: only 'scheduled' backups are pruned (pre-migrate dumps are rollback points and are kept)" >&2; exit 2; }
case "$KEEP" in '' | *[!0-9]*) echo "refused: keep must be a whole number" >&2; exit 2 ;; esac
[ "$KEEP" -ge 3 ] || { echo "refused: keep must be at least 3 (got $KEEP)" >&2; exit 2; }
[ -d "$DIR" ] || { echo "refused: $DIR is not a directory" >&2; exit 2; }

VERIFIED=""
for f in "$DIR"/scheduled-????????T??????Z.dump; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  if [ -f "$f.sha256" ] && (cd "$DIR" && sha256sum -c "$b.sha256" > /dev/null 2>&1); then
    VERIFIED="$VERIFIED
$f"
  else
    echo "kept (not verified, never pruned): $b"
  fi
done

# oldest first: the timestamp in the name sorts chronologically
SORTED="$(printf '%s\n' "$VERIFIED" | sed '/^$/d' | sort)"
N=0
[ -z "$SORTED" ] || N="$(printf '%s\n' "$SORTED" | wc -l | tr -d ' ')"
if [ "$N" -le "$KEEP" ]; then
  echo "nothing to prune: $N verified scheduled dump(s), keep $KEEP"
  exit 0
fi
DEL=$((N - KEEP))
printf '%s\n' "$SORTED" | head -n "$DEL" | while IFS= read -r f; do
  rm -f -- "$f" "$f.sha256"
  echo "pruned: $(basename "$f")"
done
echo "kept the newest $KEEP verified scheduled dumps"
