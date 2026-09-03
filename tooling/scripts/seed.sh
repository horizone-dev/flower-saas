#!/usr/bin/env bash
# Seed the local database (Phase 0: an app_meta marker only).
set -euo pipefail
cd "$(dirname "$0")/../.."
exec pnpm --filter @flower/db db:seed
