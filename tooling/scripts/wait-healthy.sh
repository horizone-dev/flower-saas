#!/usr/bin/env bash
# Poll `docker compose ps` until every service with a healthcheck is healthy
# (or a one-shot init service has exited 0). Exits non-zero on timeout.
set -euo pipefail

cd "$(dirname "$0")/../.."

TIMEOUT="${1:-120}"
deadline=$(( $(date +%s) + TIMEOUT ))

echo "waiting up to ${TIMEOUT}s for the flower-saas stack to become healthy..."

while true; do
  # "-a" so the one-shot init still shows after it exits. "|" separated (not
  # spaces) so an empty .Health field (services without a healthcheck) does not
  # shift the columns.
  mapfile -t rows < <(docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}')

  pending=()
  for row in "${rows[@]}"; do
    IFS='|' read -r svc state health exitcode <<<"$row"
    case "$svc" in
      minio-init)
        # one-shot: success is "exited" AND exit code 0. A non-zero exit is fatal
        # (bucket creation failed) — do not report the stack healthy.
        if [[ "$state" == "exited" && "$exitcode" == "0" ]]; then
          :
        elif [[ "$state" == "exited" ]]; then
          echo "FATAL: minio-init exited ${exitcode:-?} (bucket setup failed):" >&2
          docker compose logs minio-init >&2 || true
          exit 1
        else
          pending+=("$svc:$state")
        fi
        ;;
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
