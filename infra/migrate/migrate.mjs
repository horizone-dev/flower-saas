#!/usr/bin/env node
/**
 * Flower SaaS migration runner — a SEPARATE job (the production API image carries the migration files but no Prisma CLI).
 *
 * Fails CLOSED. It will not touch the database unless EVERY check passes:
 *   1. configuration: MIGRATION_DATABASE_URL is required (no default, never read from the app's DATABASE_URL);
 *   2. approval: the migration folder must equal the APPROVED manifest exactly (same names, same SHA-256 of every migration.sql). An extra
 *      folder (a Phase 4 / MVP draft), a missing one, a changed file or a name containing "DRAFT" stops the run — nothing is applied;
 *   3. database drift: every migration already applied must be in the manifest and finished; a failed / unfinished / rolled-back row stops it;
 *   4. single runner: a session-level advisory lock (plus Prisma's own) — a second concurrent runner exits 3 without touching anything.
 * Default MODE is `check` (read-only). Applying needs MIGRATION_MODE=deploy. After applying, it re-verifies that every approved migration is
 * finished exactly once. Pre-deployment backup is the `backup` job in the staging compose (pg_dump + pg_restore --list), a hard dependency.
 *
 * Exit codes: 0 ok · 2 refused (configuration / approval / drift) · 3 another runner holds the lock · 4 apply or verification failed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const rootDir = process.env.REPO_ROOT ?? process.cwd();
// `pg` is a dependency of @flower/db, not hoisted to the repo root (pnpm strict): resolve it from the db package
const pg = createRequire(
  path.join(process.env.DB_PACKAGE_DIR ?? path.join(rootDir, 'packages/db'), 'package.json'),
)('pg');
const LOCK_KEY = 7_201_500_001; // our own advisory-lock key (Prisma uses a different one)
const root = process.env.REPO_ROOT ?? process.cwd();
const migrationsDir =
  process.env.MIGRATIONS_DIR ?? path.join(root, 'packages/db/prisma/migrations');
const manifestPath =
  process.env.MIGRATION_MANIFEST ?? path.join(root, 'infra/migrate/approved-migrations.json');
const mode = process.env.MIGRATION_MODE ?? 'check';
const url = process.env.MIGRATION_DATABASE_URL;

const out = (o) => console.log(JSON.stringify(o));
const refuse = (code, reason, detail = {}) => {
  console.error(JSON.stringify({ ok: false, refused: reason, ...detail }));
  process.exit(code);
};
const sha = (file) =>
  createHash('sha256')
    .update(readFileSync(file).toString('utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

// ── 1. configuration ────────────────────────────────────────────────────────
if (!url || !/^postgres(ql)?:\/\//.test(url))
  refuse(2, 'MIGRATION_DATABASE_URL is required (postgres://…)');
if (!['check', 'deploy'].includes(mode))
  refuse(2, 'MIGRATION_MODE must be "check" or "deploy"', { mode });
if (!existsSync(manifestPath)) refuse(2, 'approved migration manifest not found', { manifestPath });
if (!existsSync(migrationsDir)) refuse(2, 'migrations directory not found', { migrationsDir });

// the folder Prisma will APPLY is <db package>/prisma/migrations. In deploy mode the folder verified below MUST be that very folder, otherwise
// the approval check and the apply could disagree (verified once, applied another). check mode may inspect any folder (read-only).
const prismaApplies = path.join(
  process.env.DB_PACKAGE_DIR ?? path.join(rootDir, 'packages/db'),
  'prisma/migrations',
);
if (
  mode === 'deploy' &&
  existsSync(migrationsDir) &&
  existsSync(prismaApplies) &&
  realpathSync(migrationsDir) !== realpathSync(prismaApplies)
) {
  refuse(
    2,
    'in deploy mode the verified migrations folder must be the folder Prisma applies (packages/db/prisma/migrations)',
    { migrationsDir, prismaApplies },
  );
}

// ── 2. approval: folder == manifest ────────────────────────────────────────
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (
  !manifest ||
  typeof manifest.migrations !== 'object' ||
  Object.keys(manifest.migrations).length === 0
) {
  refuse(2, 'approved migration manifest is empty or malformed');
}
const onDisk = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const approved = Object.keys(manifest.migrations).sort();
const extra = onDisk.filter((n) => !approved.includes(n));
const missing = approved.filter((n) => !onDisk.includes(n));
const drafts = onDisk.filter((n) => /draft/i.test(n));
const changed = onDisk
  .filter((n) => approved.includes(n))
  .filter((n) => {
    const f = path.join(migrationsDir, n, 'migration.sql');
    return !existsSync(f) || sha(f) !== manifest.migrations[n];
  });
if (extra.length || missing.length || drafts.length || changed.length) {
  refuse(2, 'migration folder does not match the approved manifest — nothing was applied', {
    extra,
    missing,
    drafts,
    changed,
  });
}

// ── 3 + 4. database drift, single runner, apply, verify ────────────────────
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
} catch (e) {
  refuse(2, 'cannot connect with MIGRATION_DATABASE_URL', {
    error: String(e.message ?? e).slice(0, 200),
  });
}
const locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
if (!locked) {
  await client.end();
  refuse(3, 'another migration runner holds the lock — exiting without touching the database');
}

async function applied() {
  const t = await client.query(`SELECT to_regclass('public._prisma_migrations') AS t`);
  if (!t.rows[0].t) return [];
  return (
    await client.query(
      'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name',
    )
  ).rows;
}

try {
  const rows = await applied();
  const unknown = rows.map((r) => r.migration_name).filter((n) => !approved.includes(n));
  const unhealthy = rows
    .filter((r) => !r.finished_at || r.rolled_back_at)
    .map((r) => r.migration_name);
  if (unknown.length || unhealthy.length) {
    await client.end();
    refuse(
      2,
      'database drift: applied migrations are not all approved and finished — nothing was applied',
      { unknown, unhealthy },
    );
  }
  const pending = approved.filter((n) => !rows.some((r) => r.migration_name === n));

  if (mode === 'check') {
    out({ ok: true, mode: 'check', approved: approved.length, applied: rows.length, pending });
    await client.end();
    process.exit(0);
  }

  if (pending.length === 0) {
    out({
      ok: true,
      mode: 'deploy',
      note: 'nothing to apply',
      approved: approved.length,
      applied: rows.length,
    });
    await client.end();
    process.exit(0);
  }

  // apply with the SAME Prisma CLI the tests use, from the db package (never `migrate dev`, never `db push`)
  const dbPkgDir = process.env.DB_PACKAGE_DIR ?? path.join(root, 'packages/db');
  const prismaBin = createRequire(path.join(dbPkgDir, 'package.json')).resolve(
    'prisma/build/index.js',
  );
  try {
    execFileSync('node', [prismaBin, 'migrate', 'deploy'], {
      cwd: dbPkgDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch {
    await client.end();
    refuse(
      4,
      'prisma migrate deploy failed — restore from the pre-deployment backup if the schema is partly applied',
      { pending },
    );
  }

  const after = await applied();
  const bad = approved.filter(
    (n) =>
      after.filter((r) => r.migration_name === n && r.finished_at && !r.rolled_back_at).length !==
      1,
  );
  if (bad.length || after.length !== approved.length) {
    await client.end();
    refuse(
      4,
      'post-apply verification failed: not every approved migration is finished exactly once',
      { bad, applied: after.length, approved: approved.length },
    );
  }
  out({ ok: true, mode: 'deploy', appliedNow: pending.length, approved: approved.length });
  await client.end();
  process.exit(0);
} catch (e) {
  try {
    await client.end();
  } catch {
    /* ignore */
  }
  refuse(4, 'unexpected failure', { error: String(e.message ?? e).slice(0, 300) });
}
