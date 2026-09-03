#!/usr/bin/env bash
# Poll `docker compose ps` until every service with a healthcheck is healthy
# (or a one-shot init service has exited 0). Exits non-zero on timeout.
set -euo pipefail

cd "$(dirname "$0")/../.."

TIMEOUT="${1:-120}"
deadline=$(( $(date +%s) + TIMEOUT ))

echo "waiting up to ${TIMEOUT}s for the flower-saas stack to become healthy..."

while true; do
  # rows: "<service> <state> <health>"
  mapfile -t rows < <(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}')

  pending=()
  for row in "${rows[@]}"; do
    read -r svc state health <<<"$row"
    case "$svc" in
      minio-init)
        [[ "$state" == "exited" ]] || pending+=("$svc:$state") ;;
      *)
        [[ "$health" == "healthy" ]] || pending+=("$svc:${health:-$state}") ;;
    esac
  done

  if [[ ${#pending[@]} -eq 0 && ${#rows[@]} -gt 0 ]]; then
    echo "all services healthy:"
    docker compose ps --format 'table {{.Service}}\t{{.Status}}'
    exit 0
  fi

  if [[ $(date +%s) -ge $deadline ]]; then
    echo "TIMEOUT after ${TIMEOUT}s. Still pending: ${pending[*]:-<none>}" >&2
    docker compose ps --format 'table {{.Service}}\t{{.Status}}' >&2
    docker compose logs --tail 30 >&2 || true
    exit 1
  fi

  sleep 2
done
