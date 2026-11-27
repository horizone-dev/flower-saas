#!/bin/sh
# The scheduled-backup service (compose: backup-scheduler). A backup at start, then one every BACKUP_INTERVAL_HOURS (default 24).
#  - success: records the time in $BACKUP_DIR/.last-backup-ok, then prunes (BACKUP_KEEP newest verified scheduled dumps, default 14)
#  - failure: records .last-backup-failed, keeps EVERY existing backup untouched, retries after BACKUP_RETRY_MINUTES (default 15)
# BACKUP_RUN_ONCE=1 runs a single cycle and exits with its result (used by the tests). The container healthcheck reads .last-backup-ok.
set -eu

DIR="${BACKUP_DIR:-/backups}"
OPS="${OPS_DIR:-/ops}"
KEEP="${BACKUP_KEEP:-14}"
INTERVAL=$(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))
RETRY=$(( ${BACKUP_RETRY_MINUTES:-15} * 60 ))

while :; do
  if "$OPS/backup-run.sh" scheduled; then
    date -u +%s > "$DIR/.last-backup-ok"
    rm -f "$DIR/.last-backup-failed"
    "$OPS/backup-prune.sh" "$DIR" scheduled "$KEEP" || echo "prune refused or failed: nothing was deleted" >&2
    WAIT="$INTERVAL"
    RC=0
  else
    echo "BACKUP FAILED at $(date -u +%Y-%m-%dT%H:%M:%SZ): every existing backup is kept untouched; retrying in ${RETRY}s" >&2
    date -u +%s > "$DIR/.last-backup-failed"
    WAIT="$RETRY"
    RC=1
  fi
  [ -z "${BACKUP_RUN_ONCE:-}" ] || exit "$RC"
  sleep "$WAIT"
done
