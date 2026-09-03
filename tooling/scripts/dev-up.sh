#!/usr/bin/env bash
# One-command local infra: bring up the flower-saas stack and wait for health.
set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ ! -f .env ]]; then
  echo "no .env found — copying .env.example -> .env"
  cp .env.example .env
fi

echo "starting the flower-saas infrastructure stack..."
docker compose up -d

# `--wait` on `up` is flaky for the one-shot init service; use our own poller.
bash tooling/scripts/wait-healthy.sh "${1:-120}"

cat <<'EOF'

flower-saas infra is up:
  postgres   localhost:5432   (flower / flower_local_dev / flower)
  redis      localhost:6379
  minio      localhost:9000   console localhost:9001
  clamav     localhost:3310
  mailpit    localhost:1025   web ui localhost:8025

next:  pnpm --filter @flower/db migrate:deploy   (apply migrations)
       pnpm seed                                 (seed app_meta)
       pnpm dev                                  (run the apps)
EOF
