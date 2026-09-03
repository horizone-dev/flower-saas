import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import {
  SCHEMA_BASELINE_KEY,
  TENANT_SCOPED_TABLES,
  PLATFORM_GLOBAL_TABLES,
  PARTITIONED_TABLES,
  DB_ROLES,
  createPrismaClient,
  runScoped,
  runPlatform,
  currentTenantGuc,
  type PrismaClient,
} from '../src/index.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Phase 1 (task 1.1) verification: a fresh Postgres 17 -> `prisma migrate deploy`
 * -> the identity/tenancy/RBAC schema WITH RLS + partitioning + the DB roles.
 * Real schema engine, real database (Testcontainers). Nothing mocked or skipped.
 */
const TENANT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

describe('packages/db — Phase 1 migration (identity / tenancy / RBAC / RLS)', () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    url = container.getConnectionUri();
    execFileSync(
      'node',
      [path.join(pkgDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    pool = new pg.Pool({ connectionString: url });

    // shared fixture: a Starter plan version + two tenants, each with one owner
    // user and one audit row (used by the RLS-behaviour and runScoped blocks)
    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002',
               '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT_A, 'ta'],
      [TENANT_B, 'tb'],
    ]) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [id, slug],
      );
      await pool.query(
        `INSERT INTO "user" ("tenantId", email, status, "updatedAt")
         VALUES ($1, $2, 'ACTIVE', now())`,
        [id, `owner@${slug}.com`],
      );
      await pool.query(
        `INSERT INTO audit_log ("tenantId", "actorAccountType", action, "resourceType")
         VALUES ($1, 'SYSTEM', $2, 'x')`,
        [id, `evt-${slug}`],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── migration bookkeeping ──────────────────────────────────────────────────
  it('records both migrations as applied', async () => {
    const { rows } = await pool.query<{ migration_name: string; finished_at: Date | null }>(
      'SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at',
    );
    expect(rows.map((r) => r.migration_name)).toEqual([
      expect.stringMatching(/_baseline$/),
      expect.stringMatching(/_phase_1_identity_tenancy_rbac$/),
    ]);
    expect(rows.every((r) => r.finished_at !== null)).toBe(true);
  });

  it('the app_meta baseline marker still round-trips', async () => {
    await pool.query(
      `INSERT INTO app_meta (key, value, "updatedAt") VALUES ($1, 'v0.4', now())
       ON CONFLICT (key) DO UPDATE SET value = 'v0.4'`,
      [SCHEMA_BASELINE_KEY],
    );
    const { rows } = await pool.query('SELECT value FROM app_meta WHERE key = $1', [
      SCHEMA_BASELINE_KEY,
    ]);
    expect(rows[0].value).toBe('v0.4');
  });

  // ── schema shape ───────────────────────────────────────────────────────────
  it('creates every Phase 1 table', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const present = new Set(rows.map((r) => r.tablename));
    for (const t of [...TENANT_SCOPED_TABLES, ...PLATFORM_GLOBAL_TABLES]) {
      expect(present.has(t), `missing table ${t}`).toBe(true);
    }
  });

  it('uuidv7() produces version-7, time-ordered UUIDs', async () => {
    const one = async (): Promise<string> =>
      (await pool.query<{ v: string }>('SELECT uuidv7() AS v')).rows[0]!.v;
    const a = await one();
    await new Promise((r) => setTimeout(r, 5)); // cross a millisecond boundary
    const b = await one();
    // version nibble (14th char, index 14 past the 3rd dash) is 7
    expect(a[14]).toBe('7');
    expect(b[14]).toBe('7');
    // v7 is lexically sortable by generation time across different milliseconds
    expect(b > a).toBe(true);
  });

  it('audit_log and outbox are range-partitioned with a DEFAULT partition', async () => {
    for (const t of PARTITIONED_TABLES) {
      const parent = await pool.query<{ relkind: string }>(
        'SELECT relkind FROM pg_class WHERE relname = $1',
        [t],
      );
      expect(parent.rows[0]?.relkind, `${t} should be partitioned (p)`).toBe('p');
      const child = await pool.query('SELECT 1 FROM pg_class WHERE relname = $1', [`${t}_default`]);
      expect(child.rowCount, `${t}_default partition should exist`).toBe(1);
    }
  });

  // ── RLS coverage ───────────────────────────────────────────────────────────
  it('every tenant-scoped table has RLS ENABLE + FORCE and an isolation policy', async () => {
    const { rows } = await pool.query<{
      relname: string;
      rls: boolean;
      force: boolean;
      policies: number;
    }>(
      `SELECT c.relname,
              c.relrowsecurity      AS rls,
              c.relforcerowsecurity AS force,
              (SELECT count(*) FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [TENANT_SCOPED_TABLES],
    );
    expect(rows).toHaveLength(TENANT_SCOPED_TABLES.length);
    for (const r of rows) {
      expect(r.rls, `${r.relname}: RLS not enabled`).toBe(true);
      expect(r.force, `${r.relname}: RLS not FORCEd`).toBe(true);
      expect(Number(r.policies), `${r.relname}: no policy`).toBeGreaterThanOrEqual(1);
    }
  });

  it('platform-global tables are RLS-exempt (no policy, RLS off)', async () => {
    const { rows } = await pool.query<{ relname: string; rls: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [PLATFORM_GLOBAL_TABLES],
    );
    for (const r of rows) expect(r.rls, `${r.relname} should be RLS-exempt`).toBe(false);
  });

  // ── DB roles ───────────────────────────────────────────────────────────────
  it('creates flower_app (NOSUPERUSER, NOBYPASSRLS), flower_platform (BYPASSRLS), flower_migrate', async () => {
    const { rows } = await pool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'flower\\_%'`);
    const byName = Object.fromEntries(rows.map((r) => [r.rolname, r]));
    expect(byName[DB_ROLES.app]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    expect(byName[DB_ROLES.platform]).toMatchObject({ rolsuper: false, rolbypassrls: true });
    expect(byName[DB_ROLES.migrate]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it('flower_app has no access to the platform identity realm, and cannot write plan', async () => {
    const c = await pool.connect();
    try {
      await c.query(`SET ROLE ${DB_ROLES.app}`);
      await expect(c.query('SELECT count(*) FROM platform_user')).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        c.query(`INSERT INTO plan (key, name, "updatedAt") VALUES ('x', 'X', now())`),
      ).rejects.toThrow(/permission denied/i);
      // but it CAN read the reference tables it needs for entitlement resolution
      await expect(c.query('SELECT count(*) FROM plan')).resolves.toBeTruthy();
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
  });

  // ── RLS behaviour (the ADR-0010 GO pattern) ────────────────────────────────
  describe('RLS behaviour as flower_app', () => {
    const A = TENANT_A;
    const B = TENANT_B;

    async function asTenant<T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>) {
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.app}`);
        if (tenantId) await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
        return await fn(c);
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        await c.query(`SELECT set_config('app.tenant_id', '', false)`).catch(() => {});
        c.release();
      }
    }

    it('a tenant sees only its own rows (user, tenant, audit_log)', async () => {
      await asTenant(A, async (c) => {
        const users = await c.query('SELECT email FROM "user"');
        expect(users.rows.map((r) => r.email)).toEqual(['owner@ta.com']);
        const tenants = await c.query('SELECT slug FROM tenant');
        expect(tenants.rows.map((r) => r.slug)).toEqual(['ta']);
        const audit = await c.query('SELECT action FROM audit_log');
        expect(audit.rows.map((r) => r.action)).toEqual(['evt-ta']);
      });
    });

    it('a query with no app.tenant_id GUC returns zero rows (fails closed, no error)', async () => {
      await asTenant(null, async (c) => {
        expect((await c.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n).toBe(0);
        expect((await c.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(0);
        expect((await c.query('SELECT count(*)::int AS n FROM tenant')).rows[0].n).toBe(0);
      });
    });

    it('tenant B cannot read, update or delete tenant A rows', async () => {
      await asTenant(B, async (c) => {
        expect((await c.query(`SELECT * FROM "user" WHERE email = 'owner@ta.com'`)).rowCount).toBe(
          0,
        );
        expect(
          (await c.query(`UPDATE "user" SET status = 'DISABLED' WHERE email = 'owner@ta.com'`))
            .rowCount,
        ).toBe(0);
        expect((await c.query(`DELETE FROM audit_log WHERE action = 'evt-ta'`)).rowCount).toBe(0);
      });
      // …and A's row is untouched
      await asTenant(A, async (c) => {
        expect(
          (await c.query(`SELECT status FROM "user" WHERE email = 'owner@ta.com'`)).rows[0].status,
        ).toBe('ACTIVE');
      });
    });

    it('WITH CHECK blocks a cross-tenant INSERT', async () => {
      await asTenant(A, async (c) => {
        await expect(
          c.query(
            `INSERT INTO "user" ("tenantId", email, status, "updatedAt")
             VALUES ($1, 'evil@x.com', 'ACTIVE', now())`,
            [B],
          ),
        ).rejects.toThrow(/row-level security/i);
      });
    });
  });

  // ── runScoped / runPlatform (the production helpers — task 1.2) ─────────────
  describe('runScoped / runPlatform', () => {
    const A = TENANT_A;
    const B = TENANT_B;
    let prisma: PrismaClient;

    beforeAll(() => {
      prisma = createPrismaClient({ connectionString: url });
    });
    afterAll(async () => {
      await prisma?.$disconnect();
    });

    it('scopes reads to the given tenant (drops to flower_app, sets the GUC)', async () => {
      const emails = await runScoped(prisma, { tenantId: A }, (tx) =>
        tx.user.findMany({ select: { email: true } }),
      );
      expect(emails.map((u) => u.email)).toEqual(['owner@ta.com']);
    });

    it('does not let tenant A touch tenant B', async () => {
      const updated = await runScoped(prisma, { tenantId: A }, (tx) =>
        tx.user.updateMany({ where: { email: 'owner@tb.com' }, data: { status: 'DISABLED' } }),
      );
      expect(updated.count).toBe(0);
    });

    it('rejects a non-UUID tenant id before it reaches SQL', async () => {
      await expect(
        runScoped(prisma, { tenantId: "'; DROP TABLE tenant; --" }, async () => 1),
      ).rejects.toThrow(/not a UUID/);
    });

    it('the GUC does not bleed onto the next transaction on the same pool', async () => {
      await runScoped(prisma, { tenantId: A }, async (tx) => {
        expect(await currentTenantGuc(tx)).toBe(A);
      });
      // a bare query (no runScoped) on the pooled connection sees no GUC
      const leaked = await prisma.$queryRaw<{ v: string }[]>`
        SELECT COALESCE(current_setting('app.tenant_id', true), '') AS v`;
      expect(leaked[0]?.v ?? '').toBe('');
    });

    it('runPlatform sees every tenant (BYPASSRLS) — no app.tenant_id set', async () => {
      const { tenants, guc } = await runPlatform(prisma, async (tx) => ({
        tenants: await tx.tenant.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } }),
        guc: await currentTenantGuc(tx),
      }));
      expect(tenants.map((t) => t.slug)).toEqual(['ta', 'tb']);
      expect(guc).toBe('');
    });

    it('concurrent runScoped calls for different tenants stay isolated', async () => {
      const [a, b] = await Promise.all([
        runScoped(prisma, { tenantId: A }, (tx) => tx.user.findMany({ select: { email: true } })),
        runScoped(prisma, { tenantId: B }, (tx) => tx.user.findMany({ select: { email: true } })),
      ]);
      expect(a.map((u) => u.email)).toEqual(['owner@ta.com']);
      expect(b.map((u) => u.email)).toEqual(['owner@tb.com']);
    });
  });
});
