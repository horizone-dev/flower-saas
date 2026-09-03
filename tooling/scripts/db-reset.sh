#!/usr/bin/env bash
# Destroy and recreate ONLY the flower-saas postgres data, then re-apply migrations.
# Never touches any other project's data.
set -euo pipefail

cd "$(dirname "$0")/../.."

read -r -p "This wipes the flower-saas postgres volume. Continue? [y/N] " ans
[[ "${ans:-N}" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }

echo "stopping postgres + removing its volume..."
docker compose rm -sf postgres
docker volume rm -f flower-saas_flower-pg-data 2>/dev/null || true

echo "recreating postgres..."
docker compose up -d postgres
bash tooling/scripts/wait-healthy.sh 60

echo "applying migrations..."
pnpm --filter @flower/db migrate:deploy

echo "done. run 'pnpm seed' to reseed."
