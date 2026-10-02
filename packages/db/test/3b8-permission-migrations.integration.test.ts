import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(pkgDir, 'prisma', 'migrations');
const PRISMA_CLI = path.join(pkgDir, 'node_modules/prisma/build/index.js');
const M44 = '20261005120000_phase_3b8_credit_refund_core';
const M45 = '20261006120000_phase_3b8_cancellation_charge_permission';

/**
 * Task 3b.8 HARD GATE (HG18 / HG1) — the two PERMISSION migrations proven as real UPGRADES of a populated
 * database that already has tenants with built-in system roles:
 *
 *   migration 44  registers credit_notes:view / credit_notes:issue / refunds:view / refunds:execute and
 *                 backfills them to the owner / admin / accountant / manager SYSTEM roles;
 *   migration 45  registers cancellation_charges:issue and backfills it to owner / admin / accountant /
 *                 manager ONLY.
 *
 * The FROZEN matrix (owner decision): cashier / sales / every other built-in role receive NONE of them, a
 * tenant's own CUSTOM (non-system) role that merely shares a built-in key never receives them, and neither
 * migration touches `orders:cancel` (orders:* belong to the task 3b.3 migration — an accountant never gets
 * orders:cancel from them). `role` / `role_permission` are FORCE-RLS tables: both migrations toggle FORCE
 * off to backfill across tenants and MUST turn it back on. Both are idempotent (ON CONFLICT DO NOTHING).
 */
const TENANT_A = 'a1000000-9111-7111-8111-111111111111';
const TENANT_B = 'a1000000-9222-7222-8222-222222222222';
const TENANT_CUSTOM = 'a1000000-9333-7333-8333-333333333333';
const uid = (): string => crypto.randomUUID();
const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function migrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
function addMigration(dir: string, name: string): void {
  fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dir, 'prisma', 'migrations', name), {
    recursive: true,
  });
}
function makeWorkDir(prefix: string, names: string[]): string {
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
function prisma(args: string[], cwd: string, url: string): string {
  return execFileSync('node', [PRISMA_CLI, ...args], {
    cwd,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
}

const SYSTEM_ROLES = [
  'owner',
  'admin',
  'manager',
  'supervisor',
  'cashier',
  'sales',
  'florist',
  'storekeeper',
  'purchase_staff',
  'accountant',
  'dispatcher',
  'driver',
  'receptionist',
];
const FROZEN: Record<string, string[]> = {
  'credit_notes:view': ['owner', 'admin', 'manager', 'accountant'],
  'credit_notes:issue': ['owner', 'admin', 'manager', 'accountant'],
  'refunds:view': ['owner', 'admin', 'manager', 'accountant'],
  'refunds:execute': ['owner', 'admin', 'manager', 'accountant'],
  'cancellation_charges:issue': ['owner', 'admin', 'manager', 'accountant'],
};

describe('packages/db — Task 3b.8 permission migrations 44 + 45: real upgrades of a populated database', () => {
  const names = migrationNames();
  const before44 = names.filter((n) => n < M44);
  let c: StartedPostgreSqlContainer;
  let url = '';
  let pool: pg.Pool;
  let dir = '';
  let after44: Record<string, string[]> = {};
  let after45: Record<string, string[]> = {};
  let registry44: pg.QueryResultRow[] = [];
  let registry45: pg.QueryResultRow[] = [];
  let force44: pg.QueryResultRow[] = [];
  let force45: pg.QueryResultRow[] = [];
  let upgrade44Out = '';
  let upgrade45Out = '';
  let secondDeploy = '';
  let rowsBefore: { id: string; roleId: string; permissionKey: string }[] = [];
  let rowsAfter44Old: { id: string; roleId: string; permissionKey: string }[] = [];
  const reapplied = { before: 0, after: 0 };
  let migRowsBefore45: pg.QueryResultRow[] = [];
  let migRowsAfter45: pg.QueryResultRow[] = [];

  const matrix = async (): Promise<Record<string, string[]>> => {
    const rows = await pool.query<{ tenant: string; key: string; isSystem: boolean; perm: string }>(
      `SELECT r."tenantId" AS tenant, r."key", r."isSystem", rp."permissionKey" AS perm
         FROM role r JOIN role_permission rp ON rp."roleId" = r.id
        WHERE rp."permissionKey" = ANY($1::text[])`,
      [Object.keys(FROZEN)],
    );
    const out: Record<string, string[]> = {};
    for (const r of rows.rows) {
      const k = `${r.tenant === TENANT_CUSTOM ? 'custom' : 'system'}:${r.perm}`;
      (out[k] ??= []).push(r.key);
    }
    for (const k of Object.keys(out)) out[k]!.sort();
    return out;
  };
  const registryRows = async (): Promise<pg.QueryResultRow[]> =>
    (
      await pool.query(
        `SELECT key, realm, "groupKey", "addedInPhase" FROM permission_registry
          WHERE key = ANY($1::text[]) ORDER BY key`,
        [Object.keys(FROZEN)],
      )
    ).rows;
  const forceFlags = async (): Promise<pg.QueryResultRow[]> =>
    (
      await pool.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('role','role_permission') AND relkind = 'r' ORDER BY relname`,
      )
    ).rows;

  beforeAll(async () => {
    expect(before44, 'the 43 migrations that precede migration 44').toHaveLength(43);
    c = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    url = c.getConnectionUri();
    pool = new pg.Pool({ connectionString: url });

    dir = makeWorkDir('perm43', before44);
    prisma(['migrate', 'deploy'], dir, url);

    // ── a populated database at migration 43: two tenants with the full built-in role set (each already
    //    holding the older keys), plus a tenant whose roles merely SHARE built-in keys but are CUSTOM ──
    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT_A, 'perm-a'],
      [TENANT_B, 'perm-b'],
      [TENANT_CUSTOM, 'perm-custom'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [id, slug],
      );
      for (const key of SYSTEM_ROLES) {
        const roleId = uid();
        await pool.query(
          `INSERT INTO role (id, "tenantId", key, name, "isSystem", "updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
          [roleId, id, key, id !== TENANT_CUSTOM],
        );
        await pool.query(
          `INSERT INTO role_permission (id, "tenantId", "roleId", "permissionKey") VALUES (uuidv7(), $1, $2, 'users:view')`,
          [id, roleId],
        );
      }
    }
    rowsBefore = (
      await pool.query(`SELECT id, "roleId", "permissionKey" FROM role_permission ORDER BY id`)
    ).rows;

    // ── migration 44 on top ────────────────────────────────────────────────────────────────────────
    addMigration(dir, M44);
    upgrade44Out = prisma(['migrate', 'deploy'], dir, url);
    after44 = await matrix();
    registry44 = await registryRows();
    force44 = await forceFlags();
    rowsAfter44Old = (
      await pool.query(
        `SELECT id, "roleId", "permissionKey" FROM role_permission WHERE "permissionKey" = 'users:view' ORDER BY id`,
      )
    ).rows;

    // ── migration 45 on top ────────────────────────────────────────────────────────────────────────
    migRowsBefore45 = (
      await pool.query(
        `SELECT id, checksum, finished_at, migration_name, rolled_back_at, applied_steps_count
           FROM _prisma_migrations ORDER BY migration_name`,
      )
    ).rows;
    addMigration(dir, M45);
    upgrade45Out = prisma(['migrate', 'deploy'], dir, url);
    after45 = await matrix();
    registry45 = await registryRows();
    force45 = await forceFlags();

    // ── idempotency: replay migration 45's own SQL — ON CONFLICT DO NOTHING, nothing changes ─────────
    const count = async (): Promise<number> =>
      Number((await pool.query(`SELECT count(*)::int AS n FROM role_permission`)).rows[0].n);
    reapplied.before = await count();
    await pool.query(fs.readFileSync(path.join(MIGRATIONS_DIR, M45, 'migration.sql'), 'utf8'));
    reapplied.after = await count();

    secondDeploy = prisma(['migrate', 'deploy'], dir, url);
    migRowsAfter45 = (
      await pool.query(
        `SELECT id, checksum, finished_at, migration_name, rolled_back_at, applied_steps_count
           FROM _prisma_migrations ORDER BY migration_name`,
      )
    ).rows;
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    await c?.stop();
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // best-effort: a Windows handle on the throwaway Prisma work dir must never fail the suite
    }
  }, 120_000);

  const ofKey = (m: Record<string, string[]>, perm: string): string[] => m[`system:${perm}`] ?? [];

  it('applies exactly ONE migration per step on a populated database (44, then 45)', () => {
    expect([...upgrade44Out.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1])).toEqual([
      M44,
    ]);
    expect([...upgrade45Out.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1])).toEqual([
      M45,
    ]);
  });

  it('migration 44 registers the four credit-note / refund keys (TENANT realm, phase 3) and grants them to owner / admin / manager / accountant — and NO ONE else', () => {
    expect(registry44.map((r) => r['key'])).toEqual([
      'credit_notes:issue',
      'credit_notes:view',
      'refunds:execute',
      'refunds:view',
    ]);
    for (const r of registry44) {
      expect(r['realm'], String(r['key'])).toBe('TENANT');
      expect(r['addedInPhase'], String(r['key'])).toBe(3);
    }
    for (const perm of [
      'credit_notes:view',
      'credit_notes:issue',
      'refunds:view',
      'refunds:execute',
    ]) {
      // BOTH built-in tenants, exactly the four roles each — cashier / sales / the rest get nothing
      expect(ofKey(after44, perm), perm).toEqual([...FROZEN[perm]!, ...FROZEN[perm]!].sort());
    }
    expect(Object.keys(after44).some((k) => k.endsWith('cancellation_charges:issue'))).toBe(false);
  });

  it("migration 45 registers cancellation_charges:issue and grants it to owner / admin / manager / accountant ONLY; 44's grants are untouched", () => {
    expect(registry45.map((r) => r['key'])).toEqual([
      'cancellation_charges:issue',
      'credit_notes:issue',
      'credit_notes:view',
      'refunds:execute',
      'refunds:view',
    ]);
    const charge = registry45.find((r) => r['key'] === 'cancellation_charges:issue')!;
    expect(charge['realm']).toBe('TENANT');
    expect(charge['addedInPhase']).toBe(3);
    expect(ofKey(after45, 'cancellation_charges:issue')).toEqual(
      [...FROZEN['cancellation_charges:issue']!, ...FROZEN['cancellation_charges:issue']!].sort(),
    );
    for (const perm of [
      'credit_notes:view',
      'credit_notes:issue',
      'refunds:view',
      'refunds:execute',
    ]) {
      expect(ofKey(after45, perm), perm).toEqual(ofKey(after44, perm));
    }
  });

  it('the FROZEN matrix holds for the complete set of built-in roles: cashier / sales / supervisor / florist / storekeeper / purchase_staff / dispatcher / driver / receptionist hold NONE of the five 3b.8 keys', () => {
    const holders = new Set(Object.values(after45).flat());
    for (const role of SYSTEM_ROLES) {
      expect(holders.has(role), role).toBe(
        ['owner', 'admin', 'manager', 'accountant'].includes(role),
      );
    }
  });

  it("neither migration grants orders:cancel — the accountant's credit_notes / refunds / charges authorities never imply the right to cancel an order", async () => {
    const r = await pool.query(
      `SELECT r.key FROM role r JOIN role_permission rp ON rp."roleId" = r.id
        WHERE rp."permissionKey" LIKE 'orders:%' GROUP BY r.key`,
    );
    expect(r.rows).toEqual([]); // the 3b.3 migration is not part of this chain's seeded data
    // and the 3b.8 migrations' own SQL never names it
    for (const m of [M44, M45]) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m, 'migration.sql'), 'utf8');
      const executable = sql.replace(/--.*$/gm, '');
      expect(executable, m).not.toMatch(/orders:cancel|orders:manage|orders:view/);
    }
  });

  it("a tenant's CUSTOM (non-system) role that merely shares a built-in key receives NOTHING from either migration", () => {
    expect(Object.keys(after45).filter((k) => k.startsWith('custom:'))).toEqual([]);
  });

  it('every pre-existing role_permission row survives both upgrades untouched (id, role, key)', () => {
    expect(rowsAfter44Old).toEqual(rowsBefore);
  });

  it('role and role_permission are FORCE-RLS again after each backfill (the migrations toggle FORCE off only for the backfill)', () => {
    for (const flags of [force44, force45]) {
      expect(flags).toEqual([
        { relname: 'role', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'role_permission', relrowsecurity: true, relforcerowsecurity: true },
      ]);
    }
  });

  it('migration 45 is idempotent — replaying its SQL changes no row (ON CONFLICT DO NOTHING) — and there is never a duplicate (role, key)', async () => {
    expect(reapplied.after).toBe(reapplied.before);
    const dupes = await pool.query(
      `SELECT "roleId", "permissionKey", count(*) FROM role_permission GROUP BY 1,2 HAVING count(*) > 1`,
    );
    expect(dupes.rows).toEqual([]);
  });

  it('a second deploy is a no-op and the earlier _prisma_migrations rows are bit-for-bit untouched; both migrations match their files', () => {
    expect(secondDeploy).toMatch(/No pending migrations to apply/);
    expect(migRowsAfter45.filter((r) => r['migration_name'] !== M45)).toEqual(migRowsBefore45);
    for (const r of migRowsAfter45) {
      expect(r['checksum'], String(r['migration_name'])).toBe(
        sha256(path.join(MIGRATIONS_DIR, String(r['migration_name']), 'migration.sql')),
      );
      expect(r['finished_at']).not.toBeNull();
      expect(r['rolled_back_at']).toBeNull();
    }
  });
});
