#!/usr/bin/env node
/**
 * Verifies the migration runner image against a DISPOSABLE PostgreSQL container (never any real database).
 *   node infra/migrate/verify.mjs [image-tag]     default image: flower/migrate:mvp-check
 * Needs Docker. Creates a throwaway network + a container of the PostgreSQL image in infra/staging/postgres-image.pin
 * (flower-migrate-verify-*) and removes them at the end.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PG_PINNED, readPostgresPin } from '../staging/postgres-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const image = process.argv[2] ?? 'flower/migrate:mvp-check';
// The runner is verified on the SAME PostgreSQL image staging will run (infra/staging/postgres-image.pin), never on a floating tag.
const pgImage = readPostgresPin();
if (pgImage === null || !PG_PINNED.test(pgImage)) {
  console.error(
    'refused: infra/staging/postgres-image.pin must hold postgres:17.<minor>@sha256:<64 hex>',
  );
  process.exit(2);
}
const id = randomBytes(3).toString('hex');
const net = `flower-migrate-verify-${id}`;
const pgName = `flower-migrate-verify-pg-${id}`;
const pgPass = randomBytes(12).toString('hex');
const work = mkdtempSync(path.join(tmpdir(), 'flower-migrate-verify-'));
const results = [];
const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const dbUrl = (db) => `postgres://postgres:${pgPass}@${pgName}:5432/${db}`;
let n = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ← ${detail}`}`);
}
function runner(args, env = {}, mounts = []) {
  const a = ['run', '--rm', '--network', net];
  for (const [k, v] of Object.entries(env)) a.push('-e', `${k}=${v}`);
  for (const m of mounts) a.push('-v', m);
  a.push(image, ...args);
  try {
    const out = docker(a);
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}
const psql = (db, sql) =>
  docker(['exec', pgName, 'psql', '-U', 'postgres', '-d', db, '-At', '-c', sql]).trim();
const freshDb = () => {
  const name = `v${++n}`;
  docker(['exec', pgName, 'psql', '-U', 'postgres', '-c', `CREATE DATABASE ${name}`]);
  return name;
};
const json = (s) => {
  const line = s
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .pop();
  return line ? JSON.parse(line) : {};
};

// the approved migrations exactly as committed at HEAD (what CI would build the image from)
const manifest = JSON.parse(
  readFileSync(path.join(root, 'infra/migrate/approved-migrations.json'), 'utf8'),
);
function writeApproved(dir) {
  for (const name of Object.keys(manifest.migrations)) {
    mkdirSync(path.join(dir, name), { recursive: true });
    const sql = execFileSync(
      'git',
      ['show', `HEAD:packages/db/prisma/migrations/${name}/migration.sql`],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    writeFileSync(path.join(dir, name, 'migration.sql'), sql);
  }
  writeFileSync(
    path.join(dir, 'migration_lock.toml'),
    execFileSync('git', ['show', 'HEAD:packages/db/prisma/migrations/migration_lock.toml'], {
      cwd: root,
    }),
  );
}
const approvedDir = path.join(work, 'approved');
mkdirSync(approvedDir);
writeApproved(approvedDir);
// the verified folder is mounted OVER the folder Prisma applies, so what is checked is exactly what would be applied
const mnt = (dir) => [`${dir}:/repo/packages/db/prisma/migrations:ro`];
const dep = (db, extra = {}) => ({
  MIGRATION_DATABASE_URL: dbUrl(db),
  MIGRATION_MODE: 'deploy',
  ...extra,
});

try {
  docker(['network', 'create', net]);
  docker([
    'run',
    '-d',
    '--name',
    pgName,
    '--network',
    net,
    '-e',
    `POSTGRES_PASSWORD=${pgPass}`,
    pgImage,
  ]);
  for (let i = 0; i < 60; i++) {
    try {
      docker(['exec', pgName, 'pg_isready', '-U', 'postgres']);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`\nmigration runner verification — image ${image}, disposable ${pgName}\n`);

  // S1 — missing configuration
  let r = runner(['node', 'infra/migrate/migrate.mjs']);
  check(
    'S1 no MIGRATION_DATABASE_URL → refused (exit 2), nothing attempted',
    r.code === 2 && /MIGRATION_DATABASE_URL is required/.test(r.err),
    `${r.code} ${r.err}`,
  );
  r = runner(['node', 'infra/migrate/migrate.mjs'], {
    MIGRATION_DATABASE_URL: dbUrl('postgres'),
    MIGRATION_MODE: 'yolo',
  });
  check('S1b an unknown MIGRATION_MODE → refused', r.code === 2, `${r.code}`);

  // S2 — default mode is read-only
  let db = freshDb();
  r = runner(
    ['node', 'infra/migrate/migrate.mjs'],
    { MIGRATION_DATABASE_URL: dbUrl(db) },
    mnt(approvedDir),
  );
  check(
    'S2 default mode = check: reports pending, exit 0, writes NOTHING',
    r.code === 0 &&
      json(r.out).mode === 'check' &&
      json(r.out).pending.length === 49 &&
      psql(db, `SELECT to_regclass('public._prisma_migrations') IS NULL`) === 't',
    `${r.code} ${r.out} ${r.err}`,
  );

  // S2b — deploy mode refuses to verify one folder and apply another
  db = freshDb();
  r = runner(
    ['node', 'infra/migrate/migrate.mjs'],
    { MIGRATION_DATABASE_URL: dbUrl(db), MIGRATION_MODE: 'deploy', MIGRATIONS_DIR: '/elsewhere' },
    ['' + approvedDir + ':/elsewhere:ro'],
  );
  check(
    'S2b deploy with a verified folder that is NOT the folder Prisma applies → refused',
    r.code === 2 &&
      /folder Prisma applies/.test(r.err) &&
      psql(db, `SELECT to_regclass('public._prisma_migrations') IS NULL`) === 't',
    `${r.code} ${r.err}`,
  );

  // S3 — an unapproved extra folder (a draft) is refused and nothing is applied
  const extraDir = path.join(work, 'extra');
  mkdirSync(extraDir);
  writeApproved(extraDir);
  mkdirSync(path.join(extraDir, '20261299000000_mvp_f1_draft'));
  writeFileSync(path.join(extraDir, '20261299000000_mvp_f1_draft', 'migration.sql'), 'SELECT 1;\n');
  db = freshDb();
  r = runner(['node', 'infra/migrate/migrate.mjs'], dep(db), mnt(extraDir));
  check(
    'S3 an unapproved/DRAFT migration folder → refused (exit 2); database untouched',
    r.code === 2 &&
      /20261299000000_mvp_f1_draft/.test(r.err) &&
      psql(db, `SELECT to_regclass('public._prisma_migrations') IS NULL`) === 't',
    `${r.code} ${r.err}`,
  );

  // S4 — a changed approved migration is refused
  const tamperDir = path.join(work, 'tamper');
  mkdirSync(tamperDir);
  writeApproved(tamperDir);
  appendFileSync(
    path.join(tamperDir, Object.keys(manifest.migrations)[3], 'migration.sql'),
    '\n-- tampered\n',
  );
  db = freshDb();
  r = runner(['node', 'infra/migrate/migrate.mjs'], dep(db), mnt(tamperDir));
  check(
    'S4 a modified approved migration → refused (hash mismatch); database untouched',
    r.code === 2 &&
      json(r.err).changed?.length === 1 &&
      psql(db, `SELECT to_regclass('public._prisma_migrations') IS NULL`) === 't',
    `${r.code} ${r.err}`,
  );

  // S5 — the migrations baked INTO the image. Built from a tree with uncommitted migrations (a developer worktree) they must be REFUSED; built from a
  // clean committed tree (CI) they equal the manifest and apply. Either way nothing unapproved can be applied.
  db = freshDb();
  r = runner(['node', 'infra/migrate/migrate.mjs'], {
    MIGRATION_DATABASE_URL: dbUrl(db),
    MIGRATION_MODE: 'deploy',
  });
  const j5 = json(r.err);
  const untouched = psql(db, `SELECT to_regclass('public._prisma_migrations') IS NULL`) === 't';
  if (r.code === 2 && (j5.extra ?? []).length >= 1) {
    check(
      'S5 image built from a tree with uncommitted migrations → refused; nothing applied',
      untouched,
      JSON.stringify(j5),
    );
    console.log('      (refused extras: ' + j5.extra.join(', ') + ')');
  } else {
    check(
      'S5 image built from a clean committed tree → baked migrations equal the manifest and apply (49)',
      r.code === 0 && json(r.out).appliedNow === 49,
      r.code + ' ' + r.out + ' ' + r.err,
    );
  }

  // S6/S7 — the approved migrations apply once; a re-run is a no-op
  db = freshDb();
  r = runner(['node', 'infra/migrate/migrate.mjs'], dep(db), mnt(approvedDir));
  const applied = psql(
    db,
    `SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || '/' || count(*) FROM _prisma_migrations`,
  );
  check(
    'S6 deploy applies the 49 approved migrations (all finished exactly once)',
    r.code === 0 && json(r.out).appliedNow === 49 && applied === '49/49',
    `${r.code} ${r.out} ${r.err} ${applied}`,
  );
  check(
    'S6b the schema is real: roles exist and flower_app cannot bypass RLS',
    psql(
      db,
      `SELECT count(*) FROM pg_roles WHERE rolname IN ('flower_app','flower_platform','flower_migrate')`,
    ) === '3' && psql(db, `SELECT rolbypassrls FROM pg_roles WHERE rolname='flower_app'`) === 'f',
  );
  r = runner(['node', 'infra/migrate/migrate.mjs'], dep(db), mnt(approvedDir));
  check(
    'S7 re-running is a no-op (exit 0, nothing to apply)',
    r.code === 0 && /nothing to apply/.test(r.out),
    `${r.code} ${r.out}`,
  );

  // S8 — concurrent runners: exactly one applies, the other is locked out, no duplicate or failed row
  db = freshDb();
  const launch = () =>
    new Promise((resolve) => {
      const a = ['run', '--rm', '--network', net];
      for (const [k, v] of Object.entries(dep(db))) a.push('-e', `${k}=${v}`);
      for (const m of mnt(approvedDir)) a.push('-v', m);
      a.push(image);
      const c = spawn('docker', a);
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (err += d));
      c.on('close', (code) => resolve({ code, out, err }));
    });
  const [a, b] = await Promise.all([launch(), launch()]);
  const codes = [a.code, b.code].sort();
  const rows = psql(
    db,
    `SELECT count(*) || '/' || count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || '/' || count(DISTINCT migration_name) FROM _prisma_migrations`,
  );
  check(
    'S8 two concurrent runners: one applies (0), the other exits 3 (or no-op 0); 49 rows, all finished, no duplicates',
    (codes.join() === '0,3' || codes.join() === '0,0') && rows === '49/49/49',
    `${codes} ${rows} | ${a.err.slice(0, 120)} | ${b.err.slice(0, 120)}`,
  );

  // S9 — database drift: an applied migration that is not approved, or an unfinished one
  db = freshDb();
  runner(['node', 'infra/migrate/migrate.mjs'], dep(db), mnt(approvedDir));
  psql(
    db,
    `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('${randomBytes(8).toString('hex')}', 'x', '20261299000000_unknown_applied', now(), 1)`,
  );
  r = runner(
    ['node', 'infra/migrate/migrate.mjs'],
    { MIGRATION_DATABASE_URL: dbUrl(db) },
    mnt(approvedDir),
  );
  check(
    'S9 an applied-but-unapproved (and unfinished) migration in the database → refused (drift)',
    r.code === 2 && /20261299000000_unknown_applied/.test(r.err),
    `${r.code} ${r.err}`,
  );

  // S10 — seed
  db = freshDb();
  runner(['node', 'infra/migrate/migrate.mjs'], dep(db), mnt(approvedDir));
  r = runner(['node', 'infra/migrate/seed.mjs'], { MIGRATION_DATABASE_URL: dbUrl(db) });
  const cats = psql(db, `SELECT string_agg(key, ',' ORDER BY key) FROM tax_category`);
  check(
    'S10 seed loads reference data (countries, tax categories incl. ZERO_RATED / EXEMPT / STANDARD, plan, registry); idempotent',
    r.code === 0 &&
      /EXEMPT/.test(cats) &&
      /STANDARD/.test(cats) &&
      /ZERO_RATED/.test(cats) &&
      Number(psql(db, 'SELECT count(*) FROM country')) >= 6,
    `${r.code} ${r.err.slice(0, 200)} ${cats}`,
  );
  r = runner(['node', 'infra/migrate/seed.mjs'], { MIGRATION_DATABASE_URL: dbUrl(db) });
  check(
    'S10b a second seed run succeeds (idempotent)',
    r.code === 0,
    `${r.code} ${r.err.slice(0, 200)}`,
  );
  r = runner(['node', 'infra/migrate/seed.mjs'], {
    MIGRATION_DATABASE_URL: dbUrl(db),
    SEED_PLATFORM_ADMIN_EMAIL: 'dev@example.test',
  });
  check('S11 the seed refuses the dev-only SEED_PLATFORM_ADMIN_EMAIL', r.code === 2, `${r.code}`);
  check(
    'S11b no platform user was created by the seed',
    psql(db, 'SELECT count(*) FROM platform_user') === '0',
  );

  // S12 — application role passwords
  r = runner(['node', 'infra/migrate/provision-db-roles.mjs'], {
    MIGRATION_DATABASE_URL: dbUrl(db),
    APP_DB_PASSWORD: 'short',
    PLATFORM_DB_PASSWORD: 'short',
  });
  check('S12 short / missing passwords → refused', r.code === 2, `${r.code}`);
  const appPw = randomBytes(18).toString('hex');
  const platPw = randomBytes(18).toString('hex');
  r = runner(['node', 'infra/migrate/provision-db-roles.mjs'], {
    MIGRATION_DATABASE_URL: dbUrl(db),
    APP_DB_PASSWORD: appPw,
    PLATFORM_DB_PASSWORD: platPw,
  });
  check(
    'S12b both roles get LOGIN with their own password; neither is superuser; only flower_platform bypasses RLS',
    r.code === 0 &&
      json(r.out).roles?.length === 2 &&
      json(r.out).roles.every((x) => x.rolcanlogin && !x.rolsuper) &&
      json(r.out).roles.find((x) => x.rolname === 'flower_app').rolbypassrls === false,
    `${r.code} ${r.out} ${r.err}`,
  );
  const probe = `const {createRequire}=require('module');const pg=createRequire('/repo/packages/db/package.json')('pg');(async()=>{const c=new pg.Client({connectionString:process.env.U});await c.connect();const who=(await c.query('select current_user u')).rows[0].u;let denied=false;try{await c.query('select 1 from platform_credential limit 1')}catch(e){denied=/permission denied/.test(e.message)}console.log(JSON.stringify({who,denied}));await c.end()})()`;
  r = runner(['node', '-e', probe], { U: `postgres://flower_app:${appPw}@${pgName}:5432/${db}` });
  check(
    'S12c the application role logs in with its password and CANNOT read the platform identity realm',
    r.code === 0 && json(r.out).who === 'flower_app' && json(r.out).denied === true,
    `${r.code} ${r.out} ${r.err.slice(0, 150)}`,
  );
  db = freshDb();
  r = runner(['node', 'infra/migrate/provision-db-roles.mjs'], {
    MIGRATION_DATABASE_URL: dbUrl(db),
    APP_DB_PASSWORD: appPw,
    PLATFORM_DB_PASSWORD: platPw,
  });
  check(
    'S12d provisioning before the migrations → refused (role missing)',
    r.code === 2,
    `${r.code}`,
  );
} catch (e) {
  check('verification harness itself', false, String(e.message ?? e).slice(0, 300));
} finally {
  try {
    docker(['rm', '-f', pgName]);
  } catch {
    /* ignore */
  }
  try {
    docker(['network', 'rm', net]);
  } catch {
    /* ignore */
  }
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
