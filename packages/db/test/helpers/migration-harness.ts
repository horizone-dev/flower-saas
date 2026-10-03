import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Throwaway-Prisma-workdir harness for the real `prisma migrate deploy` UPGRADE suites. The working directories
 * are COPIES of the real migration files in the OS temp dir — the originals are never written. A file in
 * `test/helpers/` is not a test file (no `.test.` in its name).
 */
export const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = path.join(pkgDir, 'prisma', 'migrations');
export const PRISMA_CLI = path.join(pkgDir, 'node_modules/prisma/build/index.js');

export const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function migrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function addMigration(dir: string, name: string): void {
  fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dir, 'prisma', 'migrations', name), {
    recursive: true,
  });
}

/** a minimal Prisma working dir (same schema / migrations layout and DATABASE_URL datasource as the package's
 *  own `prisma7.config.ts`), the schema, and COPIES of the given migrations */
export function makeWorkDir(prefix: string, names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flower-${prefix}-`));
  fs.writeFileSync(
    path.join(dir, 'prisma7.config.ts'),
    [
      'export default {',
      "  schema: 'prisma/schema.prisma',",
      "  migrations: { path: 'prisma/migrations' },",
      "  datasource: { url: process.env['DATABASE_URL'] },",
      '};',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(dir, 'prisma', 'migrations'), { recursive: true });
  fs.copyFileSync(
    path.join(pkgDir, 'prisma', 'schema.prisma'),
    path.join(dir, 'prisma', 'schema.prisma'),
  );
  fs.copyFileSync(
    path.join(MIGRATIONS_DIR, 'migration_lock.toml'),
    path.join(dir, 'prisma', 'migrations', 'migration_lock.toml'),
  );
  for (const n of names) addMigration(dir, n);
  return dir;
}

export function removeWorkDirs(dirs: string[]): void {
  for (const d of dirs) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // best-effort: a Windows handle on a throwaway Prisma work dir must never fail the suite
    }
  }
}

export function prisma(args: string[], cwd: string, url: string): string {
  return execFileSync('node', [PRISMA_CLI, ...args], {
    cwd,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
}

export interface Row {
  [k: string]: unknown;
}

export interface SchemaSnapshot {
  columns: Row[];
  constraints: Row[];
  indexes: Row[];
  triggers: Row[];
  functions: Row[];
  policies: Row[];
  tables: Row[];
  views: Row[];
}

export async function snapshot(pool: pg.Pool): Promise<SchemaSnapshot> {
  const rows = async (text: string): Promise<Row[]> => (await pool.query(text)).rows as Row[];
  return {
    columns: await rows(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
             character_maximum_length, numeric_precision, numeric_scale, ordinal_position
        FROM information_schema.columns WHERE table_schema = 'public'
       ORDER BY table_name, column_name`),
    constraints: await rows(`
      SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype::text AS contype,
             pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' ORDER BY 1, 2`),
    indexes: await rows(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' ORDER BY 1, 2`),
    triggers: await rows(`
      SELECT c.relname AS tbl, t.tgname, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1, 2`),
    functions: await rows(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
             pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' ORDER BY 1`),
    policies: await rows(`
      SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
        FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`),
    tables: await rows(`
      SELECT c.relname, c.relkind::text AS relkind, c.relrowsecurity, c.relforcerowsecurity,
             c.relacl::text AS acl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') ORDER BY 1`),
    views: await rows(
      `SELECT viewname, definition FROM pg_views WHERE schemaname = 'public' ORDER BY 1`,
    ),
  };
}

/** keys whose row differs / exists on only one side, by a caller-chosen key */
export function diff(
  before: Row[],
  after: Row[],
  key: (r: Row) => string,
): { added: string[]; removed: string[]; changed: string[] } {
  const b = new Map(before.map((r) => [key(r), JSON.stringify(r)]));
  const a = new Map(after.map((r) => [key(r), JSON.stringify(r)]));
  return {
    added: [...a.keys()].filter((k) => !b.has(k)).sort(),
    removed: [...b.keys()].filter((k) => !a.has(k)).sort(),
    changed: [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort(),
  };
}

export const migRows = async (p: pg.Pool): Promise<Row[]> =>
  (
    await p.query(
      `SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
         FROM _prisma_migrations ORDER BY migration_name`,
    )
  ).rows as Row[];
