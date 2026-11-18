#!/usr/bin/env node
/**
 * Runs the idempotent reference-data seed (permission registry, Starter plan, GCC currencies/countries/tax categories and rates,
 * business-type templates) with the migration-level URL. Fails closed: it refuses SEED_PLATFORM_ADMIN_EMAIL (that creates a credential-less DEV
 * super-admin; production uses the bootstrap-platform-operator procedure instead).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const refuse = (reason) => {
  console.error(JSON.stringify({ ok: false, refused: reason }));
  process.exit(2);
};
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) refuse('MIGRATION_DATABASE_URL is required');
if (process.env.SEED_PLATFORM_ADMIN_EMAIL)
  refuse(
    'SEED_PLATFORM_ADMIN_EMAIL must not be set (dev-only); use the platform-operator bootstrap',
  );

const root = process.env.REPO_ROOT ?? process.cwd();
const dbPkgDir = process.env.DB_PACKAGE_DIR ?? path.join(root, 'packages/db');
// tsx is a dependency of @flower/db: load it as an ESM loader from the db package directory
execFileSync('node', ['--import', 'tsx', 'prisma/seed.ts'], {
  cwd: dbPkgDir,
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
});
console.log(JSON.stringify({ ok: true, seeded: true }));
