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
  it('records every migration as applied, in order', async () => {
    const { rows } = await pool.query<{ migration_name: string; finished_at: Date | null }>(
      'SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at',
    );
    const names = rows.map((r) => r.migration_name);
    expect(names[0]).toMatch(/_baseline$/);
    expect(names.some((n) => n.endsWith('_phase_1_identity_tenancy_rbac'))).toBe(true);
    expect(names.some((n) => n.endsWith('_security_event_view'))).toBe(true);
    expect(names.some((n) => n.endsWith('_phase_2_core_infra'))).toBe(true);
    expect(names.some((n) => n.endsWith('_idempotency_claim_token'))).toBe(true);
    expect(names.some((n) => /_outbox_dispatcher$/.test(n))).toBe(true);
    expect(names.some((n) => /_outbox_dispatcher_least_privilege$/.test(n))).toBe(true);
    expect(names.some((n) => n.endsWith('_catalog_capability_foundation'))).toBe(true);
    expect(names.at(-1)).toMatch(/_catalog_core$/);
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
  it('creates flower_app (NOSUPERUSER, NOBYPASSRLS), flower_platform (BYPASSRLS), flower_migrate, flower_dispatcher (BYPASSRLS)', async () => {
    const { rows } = await pool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'flower\\_%'`);
    const byName = Object.fromEntries(rows.map((r) => [r.rolname, r]));
    expect(byName[DB_ROLES.app]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    expect(byName[DB_ROLES.platform]).toMatchObject({ rolsuper: false, rolbypassrls: true });
    expect(byName[DB_ROLES.migrate]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    // task 2.4 remediation (concern #3): a dedicated, narrowly-grants role for
    // the dispatcher — BYPASSRLS (it must scan every tenant's outbox rows,
    // same reason flower_platform needs it) but see the describe block below
    // for proof its GRANTs are narrowed to exactly outbox + outbox_tenant_seq.
    expect(byName[DB_ROLES.dispatcher]).toMatchObject({ rolsuper: false, rolbypassrls: true });
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

  // ── Phase 2-core schema (task 2.1) ─────────────────────────────────────────
  describe('Phase 2-core infra schema', () => {
    it('idempotency_key is NOT partitioned and carries the principal-scoped unique key', async () => {
      const kind = await pool.query<{ relkind: string }>(
        `SELECT relkind FROM pg_class WHERE relname = 'idempotency_key'`,
      );
      expect(kind.rows[0]?.relkind, 'idempotency_key must be a plain table (r)').toBe('r');
      const uniq = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idempotency_key_tenantId_scope_principalId_key_key'`,
      );
      expect(uniq.rows[0]?.indexdef).toMatch(/"tenantId", scope, "principalId", key/);
      // task 2.2 hardening: an opaque per-claim lease token
      const claim = await pool.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'idempotency_key' AND column_name = 'claimToken'`,
      );
      expect(claim.rows[0]).toMatchObject({ data_type: 'uuid', is_nullable: 'YES' });
    });

    it('the idempotency unique is per-principal — same (scope,key) for another principal is a new row (FC-2)', async () => {
      const P1 = '11111111-1111-7111-8111-111111111111';
      const P2 = '22222222-2222-7222-8222-222222222222';
      await pool.query(
        `INSERT INTO idempotency_key ("tenantId","scope","principalId","key","requestHash","expiresAt")
         VALUES ($1,'orders.create',$2,'idem-1','h', now() + interval '1 day')`,
        [TENANT_A, P1],
      );
      // same (tenant, scope, key), different principal -> allowed
      await expect(
        pool.query(
          `INSERT INTO idempotency_key ("tenantId","scope","principalId","key","requestHash","expiresAt")
           VALUES ($1,'orders.create',$2,'idem-1','h', now() + interval '1 day')`,
          [TENANT_A, P2],
        ),
      ).resolves.toBeTruthy();
      // same (tenant, scope, principal, key) -> unique violation
      await expect(
        pool.query(
          `INSERT INTO idempotency_key ("tenantId","scope","principalId","key","requestHash","expiresAt")
           VALUES ($1,'orders.create',$2,'idem-1','h', now() + interval '1 day')`,
          [TENANT_A, P1],
        ),
      ).rejects.toThrow(/duplicate key value/i);
      await pool.query(`DELETE FROM idempotency_key WHERE key = 'idem-1'`);
    });

    it('outbox gains the dispatcher columns + a partial work-queue index', async () => {
      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'outbox' AND column_name = ANY($1)`,
        [['seq', 'attempts', 'availableAt', 'lastError']],
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
        'attempts',
        'availableAt',
        'lastError',
        'seq',
      ]);
      const idx = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox_default' AND indexname = 'outbox_default_availableAt_idx'`,
      );
      expect(idx.rowCount, 'partial index must propagate to the default partition').toBe(1);
    });

    it('audit_log gains nullable hash-chain columns (unwritten in core — OD-P2-1)', async () => {
      const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'audit_log' AND column_name IN ('prevHash','entryHash')`,
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.is_nullable).toBe('YES');
    });

    it('company gains the legal-entity fiscal columns (country is the fiscal source, not tenant.region)', async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'company' AND column_name = ANY($1)`,
        [['countryCode', 'defaultCurrency', 'fiscalConfig']],
      );
      expect(rows.map((r) => r.column_name).sort()).toEqual([
        'countryCode',
        'defaultCurrency',
        'fiscalConfig',
      ]);
      const fk = await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'company_countryCode_fkey' AND contype = 'f'`,
      );
      expect(fk.rowCount).toBe(1);
    });

    it('flower_app has SELECT-only on the localization reference tables', async () => {
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.app}`);
        await expect(c.query('SELECT count(*) FROM country')).resolves.toBeTruthy();
        await expect(c.query('SELECT count(*) FROM tax_rate')).resolves.toBeTruthy();
        await expect(
          c.query(
            `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
             VALUES ('ZZ','Z','Z','ZZ','ZZZ','FRI_SAT', now())`,
          ),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
    });

    it('country_tax_config.regime rejects a value outside VAT|NONE (no VAT is modelled, not a 0% rate)', async () => {
      await pool.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('QAR', 2, 'ر.ق', 'Qatari Riyal', 'ريال قطري') ON CONFLICT (code) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
         VALUES ('QA','Qatar','قطر','QA','QAR','FRI_SAT', now())
         ON CONFLICT (code) DO NOTHING`,
      );
      await expect(
        pool.query(
          `INSERT INTO country_tax_config ("countryCode","effectiveFrom","regime")
           VALUES ('QA', '2026-01-01', 'ZERO_RATED')`,
        ),
      ).rejects.toThrow(/country_tax_config_regime_chk/i);
      await expect(
        pool.query(
          `INSERT INTO country_tax_config ("countryCode","effectiveFrom","regime")
           VALUES ('QA', '2026-01-01', 'NONE')`,
        ),
      ).resolves.toBeTruthy();
      await pool.query(`DELETE FROM country_tax_config WHERE "countryCode" = 'QA'`);
    });
  });

  // ── task 2.4 — outbox dispatcher schema ────────────────────────────────────
  describe('outbox dispatcher schema (task 2.4)', () => {
    it('outbox gains the optional envelope columns (branch/resourceVersion/actorSummary)', async () => {
      const cols = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'outbox' AND column_name = ANY($1)`,
        [['branchId', 'resourceVersion', 'actorSummary']],
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
        'actorSummary',
        'branchId',
        'resourceVersion',
      ]);
      for (const r of cols.rows) expect(r.is_nullable).toBe('YES');
    });

    it('outbox carries the two dispatcher partial indexes, propagated to the default partition', async () => {
      const unstamped = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox_default' AND indexname = 'outbox_default_tenantId_createdAt_id_idx'`,
      );
      expect(unstamped.rowCount, 'unstamped-work index must propagate').toBe(1);
      expect(unstamped.rows[0]?.indexdef).toMatch(
        /WHERE \(\(seq IS NULL\) AND \("dispatchedAt" IS NULL\)\)/,
      );

      const readyToPublish = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox_default' AND indexname = 'outbox_default_availableAt_idx1'`,
      );
      expect(readyToPublish.rowCount, 'ready-to-publish index must propagate').toBe(1);
      expect(readyToPublish.rows[0]?.indexdef).toMatch(
        /WHERE \(\(seq IS NOT NULL\) AND \("dispatchedAt" IS NULL\)\)/,
      );
    });

    it('outbox_tenant_seq is the durable per-tenant seq allocator — flower_app has NO privilege at all', async () => {
      const pk = await pool.query(
        `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'outbox_tenant_seq'::regclass AND i.indisprimary`,
      );
      expect(pk.rows.map((r) => r.attname)).toEqual(['tenantId']);

      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.app}`);
        await expect(c.query('SELECT count(*) FROM outbox_tenant_seq')).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
    });

    it('outbox_tenant_seq: an UPDATE ... RETURNING next_seq - 1 allocates strictly increasing, gap-tolerant values', async () => {
      const tenant = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
      await pool.query(
        `INSERT INTO outbox_tenant_seq ("tenantId") VALUES ($1) ON CONFLICT ("tenantId") DO NOTHING`,
        [tenant],
      );
      const allocate = async (): Promise<bigint> => {
        const { rows } = await pool.query<{ allocated: string }>(
          `UPDATE outbox_tenant_seq SET "nextSeq" = "nextSeq" + 1
            WHERE "tenantId" = $1 RETURNING "nextSeq" - 1 AS allocated`,
          [tenant],
        );
        return BigInt(rows[0]!.allocated);
      };
      const a = await allocate();
      const b = await allocate();
      const c = await allocate();
      expect(b).toBe(a + 1n);
      expect(c).toBe(b + 1n);
      await pool.query(`DELETE FROM outbox_tenant_seq WHERE "tenantId" = $1`, [tenant]);
    });
  });

  // ── flower_dispatcher — least privilege (task 2.4 remediation, concern #3) ─
  // The dispatcher runs BYPASSRLS (it must scan every tenant's outbox rows —
  // there is no single app.tenant_id to scope a request to), but its GRANTs
  // must be narrowed to exactly `outbox` + `outbox_tenant_seq`. These prove
  // that narrowing holds — including that BYPASSRLS alone grants nothing
  // without an explicit table GRANT.
  describe('flower_dispatcher — least privilege', () => {
    async function asDispatcher<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.dispatcher}`);
        return await fn(c);
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
    }

    it('can SELECT + UPDATE outbox, and SELECT + INSERT + UPDATE outbox_tenant_seq', async () => {
      await asDispatcher(async (c) => {
        await expect(c.query('SELECT count(*) FROM outbox')).resolves.toBeTruthy();
        await expect(
          c.query(`UPDATE outbox SET attempts = attempts WHERE false`),
        ).resolves.toBeTruthy();
        await expect(c.query('SELECT count(*) FROM outbox_tenant_seq')).resolves.toBeTruthy();

        const tenant = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
        await expect(
          c.query(
            `INSERT INTO outbox_tenant_seq ("tenantId") VALUES ($1)
               ON CONFLICT ("tenantId") DO UPDATE SET "nextSeq" = outbox_tenant_seq."nextSeq" + 1`,
            [tenant],
          ),
        ).resolves.toBeTruthy();
      });
      await pool.query(`DELETE FROM outbox_tenant_seq WHERE "tenantId" = $1`, [
        'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
      ]);
    });

    it('cannot INSERT or DELETE outbox — dispatch only claims/updates rows apps/api already wrote', async () => {
      await asDispatcher(async (c) => {
        await expect(
          c.query(
            `INSERT INTO outbox (id, "aggregateType", "aggregateId", "eventType", payload, "createdAt")
             VALUES (uuidv7(), 'x', 'x', 'x', '{}'::jsonb, now())`,
          ),
        ).rejects.toThrow(/permission denied/i);
        await expect(c.query(`DELETE FROM outbox WHERE false`)).rejects.toThrow(
          /permission denied/i,
        );
      });
    });

    it('cannot DELETE outbox_tenant_seq', async () => {
      await asDispatcher(async (c) => {
        await expect(c.query(`DELETE FROM outbox_tenant_seq WHERE false`)).rejects.toThrow(
          /permission denied/i,
        );
      });
    });

    it('cannot read or write ANY other table — no cross-tenant business-table access despite BYPASSRLS', async () => {
      await asDispatcher(async (c) => {
        await expect(c.query('SELECT count(*) FROM "user"')).rejects.toThrow(/permission denied/i);
        await expect(c.query('SELECT count(*) FROM tenant')).rejects.toThrow(/permission denied/i);
        await expect(c.query('SELECT count(*) FROM audit_log')).rejects.toThrow(
          /permission denied/i,
        );
        await expect(c.query('SELECT count(*) FROM plan')).rejects.toThrow(/permission denied/i);
        await expect(c.query('SELECT count(*) FROM platform_user')).rejects.toThrow(
          /permission denied/i,
        );
        await expect(c.query(`UPDATE "user" SET status = 'DISABLED' WHERE false`)).rejects.toThrow(
          /permission denied/i,
        );
      });
    });
  });

  // ── task 3.1 — catalog capability & Business-Type template foundation ──────
  // docs/phase-3/PHASE-3.1-CAPABILITY-SPEC.md §F / §G / §N.
  describe('catalog capability foundation schema (task 3.1)', () => {
    const CAP_KEYS = [
      'strategy.stocked',
      'strategy.bom',
      'strategy.custom',
      'variants',
      'multi_uom',
      'identifiers.barcode_qr',
      'branch_pricing',
      'channel.pos',
      'channel.customer_web',
      'inventory.tracked',
      'inventory.lot_batch',
      'inventory.expiry',
      'purchasing',
      'production',
      'delivery',
      'customer_ordering',
    ];

    it('creates the three tables with the frozen columns (no template_payload jsonb)', async () => {
      const cols = async (table: string): Promise<Record<string, string>> => {
        const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = $1`,
          [table],
        );
        return Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
      };

      const tpl = await cols('business_type_template');
      expect(Object.keys(tpl).sort()).toEqual(
        ['createdAt', 'key', 'nameAr', 'nameEn', 'status', 'updatedAt', 'version'].sort(),
      );
      expect(tpl['template_payload'], 'no giant template_payload jsonb (D2-3)').toBeUndefined();

      const tplCap = await cols('business_type_template_capability');
      expect(Object.keys(tplCap).sort()).toEqual(
        [
          'capabilityKey',
          'config',
          'createdAt',
          'enabled',
          'id',
          'templateKey',
          'updatedAt',
        ].sort(),
      );
      expect(tplCap['config']).toBe('YES'); // nullable — always NULL in task 3.1

      const tenantCap = await cols('tenant_catalog_capability');
      expect(Object.keys(tenantCap).sort()).toEqual(
        [
          'appliedAt',
          'appliedBy',
          'capabilityKey',
          'config',
          'createdAt',
          'enabled',
          'id',
          'lastChangedBy',
          'overriddenAt',
          'sourceKind',
          'sourceTemplateKey',
          'sourceTemplateVersion',
          'tenantId',
          'updatedAt',
          'version',
        ].sort(),
      );
      expect(tenantCap['config']).toBe('YES');
      expect(tenantCap['sourceKind']).toBe('NO');
      expect(tenantCap['sourceTemplateKey']).toBe('YES');
    });

    it('adds the four additive tenant columns (3 nullable + catalogCapabilityVersion NOT NULL DEFAULT 0)', async () => {
      const { rows } = await pool.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'tenant' AND column_name = ANY($1)`,
        [
          [
            'businessTypeKey',
            'businessTypeAppliedVersion',
            'businessTypeAppliedAt',
            'catalogCapabilityVersion',
          ],
        ],
      );
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(byName['businessTypeKey']?.is_nullable).toBe('YES');
      expect(byName['businessTypeAppliedVersion']?.is_nullable).toBe('YES');
      expect(byName['businessTypeAppliedAt']?.is_nullable).toBe('YES');
      expect(byName['catalogCapabilityVersion']?.is_nullable).toBe('NO');
      expect(byName['catalogCapabilityVersion']?.column_default).toBe('0');
    });

    it('normalizes capabilities: UNIQUE (templateKey, capabilityKey) + UNIQUE (tenantId, capabilityKey)', async () => {
      const idx = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1)`,
        [['business_type_template_capability', 'tenant_catalog_capability']],
      );
      const defs = idx.rows.map((r) => r.indexdef);
      expect(
        defs.some((d) =>
          /UNIQUE.*business_type_template_capability.*templateKey.*capabilityKey/s.test(d),
        ),
      ).toBe(true);
      expect(
        defs.some((d) => /UNIQUE.*tenant_catalog_capability.*tenantId.*capabilityKey/s.test(d)),
      ).toBe(true);
      expect(defs.some((d) => /tenant_catalog_capability_tenantId_idx/.test(d))).toBe(true);
    });

    it('CHECK constraints: status, sourceKind, and the closed 16-key capabilityKey registry', async () => {
      const { rows } = await pool.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'c' AND conrelid::regclass::text = ANY($1)`,
        [
          [
            'business_type_template',
            'business_type_template_capability',
            'tenant_catalog_capability',
          ],
        ],
      );
      const byName = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
      expect(byName['business_type_template_status_chk']).toMatch(/ACTIVE.*DEPRECATED/s);
      expect(byName['tenant_catalog_capability_sourceKind_chk']).toMatch(/TEMPLATE.*MANUAL/s);
      for (const table of [
        'business_type_template_capability_capabilityKey_chk',
        'tenant_catalog_capability_capabilityKey_chk',
      ]) {
        const def = byName[table];
        expect(def, `${table} missing`).toBeTruthy();
        for (const k of CAP_KEYS) expect(def).toContain(`'${k}'`);
      }
    });

    it('a capabilityKey outside the closed registry is rejected by the DB CHECK', async () => {
      await expect(
        pool.query(
          `INSERT INTO business_type_template (key, version, "nameEn", "nameAr", "updatedAt")
           VALUES ('X_TMP', 1, 'x', 'x', now())`,
        ),
      ).resolves.toBeTruthy();
      await expect(
        pool.query(
          `INSERT INTO business_type_template_capability ("templateKey", "capabilityKey", enabled, "updatedAt")
           VALUES ('X_TMP', 'category_template.flowers', true, now())`,
        ),
      ).rejects.toThrow(/capabilityKey_chk/i);
      await pool.query(`DELETE FROM business_type_template WHERE key = 'X_TMP'`);
    });

    it('tenant.businessTypeKey -> business_type_template.key with ON DELETE RESTRICT', async () => {
      const { rows } = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tenant_businessTypeKey_fkey'`,
      );
      expect(rows[0]?.def).toMatch(
        /FOREIGN KEY .*"businessTypeKey".* REFERENCES business_type_template\(key\).*ON DELETE RESTRICT/s,
      );
    });

    it('flower_app is SELECT-only on all three configuration tables', async () => {
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.app}`);
        // reads succeed (reference tables have no GUC requirement)
        await expect(c.query('SELECT count(*) FROM business_type_template')).resolves.toBeTruthy();
        await expect(
          c.query('SELECT count(*) FROM business_type_template_capability'),
        ).resolves.toBeTruthy();
        // writes are denied at the DB
        await expect(
          c.query(
            `INSERT INTO business_type_template (key, version, "nameEn", "nameAr", "updatedAt")
             VALUES ('ZZ', 1, 'z', 'z', now())`,
          ),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          c.query(
            `INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
             VALUES ('ZZ','variants',true, now())`,
          ),
        ).rejects.toThrow(/permission denied/i);
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
        await expect(
          c.query(
            `INSERT INTO tenant_catalog_capability ("tenantId","capabilityKey",enabled,"sourceKind","updatedAt")
             VALUES ($1,'variants',true,'MANUAL', now())`,
            [TENANT_A],
          ),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        await c.query(`SELECT set_config('app.tenant_id', '', false)`).catch(() => {});
        c.release();
      }
    });

    it('tenant_catalog_capability has RLS ENABLE + FORCE, isolates tenants, fails closed with no GUC', async () => {
      // seed one row per tenant via the superuser pool (bypasses RLS)
      for (const t of [TENANT_A, TENANT_B]) {
        await pool.query(
          `INSERT INTO tenant_catalog_capability ("tenantId","capabilityKey",enabled,"sourceKind","updatedAt")
           VALUES ($1,'strategy.stocked',true,'TEMPLATE', now())
           ON CONFLICT ("tenantId","capabilityKey") DO NOTHING`,
          [t],
        );
      }
      const meta = await pool.query<{ rls: boolean; force: boolean; policies: number }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*) FROM pg_policies p WHERE p.tablename = 'tenant_catalog_capability') AS policies
           FROM pg_class c WHERE c.relname = 'tenant_catalog_capability'`,
      );
      expect(meta.rows[0]?.rls).toBe(true);
      expect(meta.rows[0]?.force).toBe(true);
      expect(Number(meta.rows[0]?.policies)).toBeGreaterThanOrEqual(1);

      const asTenant = async (tid: string | null): Promise<number> => {
        const c = await pool.connect();
        try {
          await c.query(`SET ROLE ${DB_ROLES.app}`);
          if (tid) await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tid]);
          return Number(
            (await c.query('SELECT count(*)::int AS n FROM tenant_catalog_capability')).rows[0].n,
          );
        } finally {
          await c.query('RESET ROLE').catch(() => {});
          await c.query(`SELECT set_config('app.tenant_id', '', false)`).catch(() => {});
          c.release();
        }
      };
      expect(await asTenant(TENANT_A)).toBe(1); // only its own row
      expect(await asTenant(null)).toBe(0); // fails closed, no error
      await pool.query(
        `DELETE FROM tenant_catalog_capability WHERE "capabilityKey" = 'strategy.stocked'`,
      );
    });

    it('business_type_template* are RLS-exempt (readable with no GUC)', async () => {
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.app}`);
        // no app.tenant_id set — reference data is not tenant-scoped
        await expect(c.query('SELECT count(*) FROM business_type_template')).resolves.toBeTruthy();
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
      const rls = await pool.query<{ relname: string; rls: boolean }>(
        `SELECT relname, relrowsecurity AS rls FROM pg_class
          WHERE relname IN ('business_type_template','business_type_template_capability')`,
      );
      for (const r of rls.rows) expect(r.rls, `${r.relname} must be RLS-exempt`).toBe(false);
    });

    it('no Variant / UOM / Pricing / Inventory / Order table exists (HG3-NO-PREMATURE-DOMAIN)', async () => {
      const { rows } = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      const present = new Set(rows.map((r) => r.tablename));
      // product / category / product_type are created by task 3.2 (below) — the
      // rest stay forbidden through Phase 3a.
      for (const forbidden of [
        'attribute_definition',
        'attribute_option',
        'product_attribute_value',
        'variant',
        'option_group',
        'option_value',
        'variant_option_value',
        'item_identifier',
        'uom',
        'uom_conversion',
        'company_variant_uom_price',
        'branch_variant_uom_price',
        'branch_variant_availability',
        'inventory_item',
        'branch_inventory_balance',
        'inventory_movement',
        'stock_reservation',
        'order',
        'order_line',
        'payment',
        'journal_entry',
      ]) {
        expect(present.has(forbidden), `${forbidden} must NOT exist yet`).toBe(false);
      }
    });
  });

  // ── task 3.2 — generic catalog core (Category / Product Type / Product) ────
  // docs/phase-3/PHASE-3-PLAN.md §C.3. Tenant-safe composite FKs + RLS + the
  // narrowed security_event view + the built-in system-role backfill.
  describe('generic catalog core schema (task 3.2)', () => {
    const CAT_A = '0000aaaa-0000-7000-8000-00000000ca11';
    const CAT_B = '0000bbbb-0000-7000-8000-00000000cb22';

    it('creates exactly category / product_type / product — no other new table', async () => {
      const cols = async (table: string): Promise<Record<string, string>> => {
        const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = $1`,
          [table],
        );
        return Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
      };

      const cat = await cols('category');
      expect(Object.keys(cat).sort()).toEqual(
        [
          'id',
          'tenantId',
          'parentId',
          'slug',
          'nameEn',
          'nameAr',
          'sortOrder',
          'status',
          'version',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      expect(cat['parentId']).toBe('YES');
      expect(cat['nameAr']).toBe('YES');
      expect(cat['nameEn']).toBe('NO');

      const pt = await cols('product_type');
      expect(Object.keys(pt).sort()).toEqual(
        [
          'id',
          'tenantId',
          'key',
          'nameEn',
          'nameAr',
          'status',
          'version',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      // owner R-4 — NO behaviour column on product_type
      expect(pt['defaultFulfilmentStrategy']).toBeUndefined();
      expect(pt['fulfilmentStrategy']).toBeUndefined();

      const p = await cols('product');
      expect(Object.keys(p).sort()).toEqual(
        [
          'id',
          'tenantId',
          'categoryId',
          'productTypeId',
          'slug',
          'nameEn',
          'nameAr',
          'description',
          'fulfilmentStrategy',
          'hidePrice',
          'status',
          'version',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      // owner §11 / HG3-CATALOG-SCOPE-SEPARATION — no money / company / branch /
      // stock / media / tax / attribute / variant / uom / identifier column
      for (const forbidden of [
        'companyId',
        'branchId',
        'price',
        'priceMinor',
        'currency',
        'currencyCode',
        'stock',
        'quantity',
        'inventoryBalance',
        'media',
        'mediaJson',
        'taxCategory',
        'taxCategoryKey',
      ]) {
        expect(p[forbidden], `product.${forbidden} must not exist`).toBeUndefined();
      }
    });

    it('pg_trgm is installed with GIN trigram indexes on product name(s)', async () => {
      const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
      expect(ext.rowCount).toBe(1);
      const idx = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'product' AND indexname LIKE '%trgm%'`,
      );
      const defs = idx.rows.map((r) => r.indexdef).join('\n');
      expect(defs).toMatch(/gin.*"nameEn" gin_trgm_ops/is);
      expect(defs).toMatch(/gin.*"nameAr" gin_trgm_ops/is);
    });

    it('every new table has RLS ENABLE + FORCE + a policy; no-GUC → zero rows', async () => {
      const meta = await pool.query<{
        relname: string;
        rls: boolean;
        force: boolean;
        policies: number;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.relname = ANY($1)`,
        [['category', 'product_type', 'product']],
      );
      expect(meta.rows).toHaveLength(3);
      for (const r of meta.rows) {
        expect(r.rls, `${r.relname} RLS`).toBe(true);
        expect(r.force, `${r.relname} FORCE`).toBe(true);
        expect(Number(r.policies), `${r.relname} policy`).toBeGreaterThanOrEqual(1);
      }

      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.app}`);
        for (const t of ['category', 'product_type', 'product']) {
          const n = Number((await c.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n);
          expect(n, `${t} with no GUC`).toBe(0);
        }
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
    });

    it('flower_app has full tenant-scoped DML (NOT SELECT-only — these are Owner-written)', async () => {
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE ${DB_ROLES.app}`);
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
        const ins = await c.query(
          `INSERT INTO "category" ("tenantId","slug","nameEn","updatedAt")
           VALUES ($1,'app-write-test','App write', now()) RETURNING id`,
          [TENANT_A],
        );
        expect(ins.rowCount).toBe(1);
        await c.query(`DELETE FROM "category" WHERE id = $1`, [ins.rows[0].id]);
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        await c.query(`SELECT set_config('app.tenant_id', '', false)`).catch(() => {});
        c.release();
      }
    });

    it('TENANT-SAFE composite FKs: the DB rejects a cross-tenant category parent / product ref', async () => {
      // seed a category in each tenant (superuser pool bypasses RLS)
      await pool.query(
        `INSERT INTO "category" (id,"tenantId","slug","nameEn","updatedAt")
         VALUES ($1,$2,'root-a','Root A', now()), ($3,$4,'root-b','Root B', now())
         ON CONFLICT (id) DO NOTHING`,
        [CAT_A, TENANT_A, CAT_B, TENANT_B],
      );
      const ptA = (
        await pool.query(
          `INSERT INTO "product_type" (id,"tenantId","key","nameEn","updatedAt")
           VALUES (uuidv7(),$1,'TYPE_A','Type A', now()) RETURNING id`,
          [TENANT_A],
        )
      ).rows[0].id as string;

      // tenant A category cannot point its parent at tenant B's category
      await expect(
        pool.query(
          `INSERT INTO "category" (id,"tenantId","parentId","slug","nameEn","updatedAt")
           VALUES (uuidv7(),$1,$2,'child-x','Child', now())`,
          [TENANT_A, CAT_B],
        ),
      ).rejects.toThrow(/category_tenant_parent_fkey|violates foreign key/i);

      // tenant A product cannot reference tenant B's category
      await expect(
        pool.query(
          `INSERT INTO "product" (id,"tenantId","categoryId","slug","nameEn","fulfilmentStrategy","updatedAt")
           VALUES (uuidv7(),$1,$2,'prod-x','Prod','STOCKED', now())`,
          [TENANT_A, CAT_B],
        ),
      ).rejects.toThrow(/product_tenant_category_fkey|violates foreign key/i);

      // tenant B product cannot reference tenant A's product type
      await expect(
        pool.query(
          `INSERT INTO "product" (id,"tenantId","categoryId","productTypeId","slug","nameEn","fulfilmentStrategy","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,'prod-y','Prod','STOCKED', now())`,
          [TENANT_B, CAT_B, ptA],
        ),
      ).rejects.toThrow(/product_tenant_product_type_fkey|violates foreign key/i);

      // the same-tenant reference is fine
      await expect(
        pool.query(
          `INSERT INTO "product" (id,"tenantId","categoryId","productTypeId","slug","nameEn","fulfilmentStrategy","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,'prod-ok','Prod','STOCKED', now())`,
          [TENANT_A, CAT_A, ptA],
        ),
      ).resolves.toBeTruthy();

      await pool.query(`DELETE FROM "product" WHERE "tenantId" IN ($1,$2)`, [TENANT_A, TENANT_B]);
      await pool.query(`DELETE FROM "product_type" WHERE id = $1`, [ptA]);
      await pool.query(`DELETE FROM "category" WHERE id IN ($1,$2)`, [CAT_A, CAT_B]);
    });

    it('root-slug uniqueness (partial index) + sibling-slug uniqueness', async () => {
      await pool.query(
        `INSERT INTO "category" (id,"tenantId","slug","nameEn","updatedAt")
         VALUES ($1,$2,'dup-root','R', now())`,
        [CAT_A, TENANT_A],
      );
      // second root with the same slug in the same tenant → rejected
      await expect(
        pool.query(
          `INSERT INTO "category" (id,"tenantId","slug","nameEn","updatedAt")
           VALUES (uuidv7(),$1,'dup-root','R2', now())`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/category_root_slug_key|duplicate key/i);
      // a child with slug 'dup-root' under CAT_A is allowed (different scope)
      const child = (
        await pool.query(
          `INSERT INTO "category" (id,"tenantId","parentId","slug","nameEn","updatedAt")
           VALUES (uuidv7(),$1,$2,'dup-root','child', now()) RETURNING id`,
          [TENANT_A, CAT_A],
        )
      ).rows[0].id as string;
      // but a SECOND child with the same slug under the same parent → rejected
      await expect(
        pool.query(
          `INSERT INTO "category" (id,"tenantId","parentId","slug","nameEn","updatedAt")
           VALUES (uuidv7(),$1,$2,'dup-root','child2', now())`,
          [TENANT_A, CAT_A],
        ),
      ).rejects.toThrow(/category_tenantId_parentId_slug_key|duplicate key/i);

      await pool.query(`DELETE FROM "category" WHERE id IN ($1,$2)`, [CAT_A, child]);
    });

    it('CHECK constraints: status enums, fulfilment strategy, slug + product-type key shape', async () => {
      const { rows } = await pool.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'c' AND conrelid::regclass::text = ANY($1)`,
        [['category', 'product_type', 'product']],
      );
      const byName = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
      expect(byName['category_status_chk']).toMatch(/ACTIVE.*ARCHIVED/s);
      expect(byName['product_status_chk']).toMatch(/DRAFT.*ACTIVE.*ARCHIVED/s);
      expect(byName['product_fulfilment_strategy_chk']).toMatch(/STOCKED.*BOM.*CUSTOM/s);
      expect(byName['product_type_key_chk']).toBeTruthy();

      await expect(
        pool.query(
          `INSERT INTO "product_type" (id,"tenantId","key","nameEn","updatedAt")
           VALUES (uuidv7(),$1,'bad key','x', now())`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/product_type_key_chk/i);
    });

    it('security_event view is NARROWED — no ordinary catalog CRUD, keeps catalog.template_applied', async () => {
      const { rows } = await pool.query<{ definition: string }>(
        `SELECT pg_get_viewdef('security_event'::regclass, true) AS definition`,
      );
      const def = rows[0]!.definition;
      // the old broad `catalog.%` prefix match is gone…
      expect(def).not.toMatch(/catalog\.%/);
      // …replaced by an exact match on the one security-significant catalog action
      expect(def).toMatch(/catalog\.template_applied/);
    });

    it('built-in system-role backfill is applied and idempotent (owner R-1)', async () => {
      // seed a minimal tenant with owner/admin/manager + a custom role
      const T = '0000cccc-0000-7000-8000-00000000cc33';
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1,'bf','bf','AE','ACTIVE','00000000-0000-7000-8000-000000000002', now())
         ON CONFLICT (id) DO NOTHING`,
        [T],
      );
      const roleIds: Record<string, string> = {};
      for (const [key, isSystem] of [
        ['owner', true],
        ['admin', true],
        ['manager', true],
        ['custom_role', false],
      ] as const) {
        const r = await pool.query(
          `INSERT INTO role (id,"tenantId",key,name,"isSystem","updatedAt")
           VALUES (uuidv7(),$1,$2,$2,$3, now()) RETURNING id`,
          [T, key, isSystem],
        );
        roleIds[key] = r.rows[0].id;
      }
      // re-run the migration's exact backfill statements — FORCE-toggle so a
      // NOBYPASSRLS owner can write cross-tenant, then the two idempotent
      // INSERT ... SELECT ... ON CONFLICT DO NOTHING.
      const backfill = `
        ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;
        INSERT INTO "role_permission" ("id","tenantId","roleId","permissionKey")
        SELECT uuidv7(), r."tenantId", r."id", k.key
          FROM "role" r CROSS JOIN (VALUES ('catalog:view'),('catalog:manage')) AS k(key)
         WHERE r."isSystem" = true AND r."key" IN ('owner','admin')
        ON CONFLICT ("roleId","permissionKey") DO NOTHING;
        INSERT INTO "role_permission" ("id","tenantId","roleId","permissionKey")
        SELECT uuidv7(), r."tenantId", r."id", 'catalog:view'
          FROM "role" r
         WHERE r."isSystem" = true AND r."key" = 'manager'
        ON CONFLICT ("roleId","permissionKey") DO NOTHING;
        ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
        ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;`;
      await pool.query(backfill);
      await pool.query(backfill); // twice — must not create duplicates

      const perms = async (roleId: string): Promise<string[]> =>
        (
          await pool.query<{ permissionKey: string }>(
            `SELECT "permissionKey" FROM "role_permission" WHERE "roleId" = $1 ORDER BY "permissionKey"`,
            [roleId],
          )
        ).rows.map((r) => r.permissionKey);

      expect(await perms(roleIds['owner']!)).toEqual(['catalog:manage', 'catalog:view']);
      expect(await perms(roleIds['admin']!)).toEqual(['catalog:manage', 'catalog:view']);
      expect(await perms(roleIds['manager']!)).toEqual(['catalog:view']);
      expect(await perms(roleIds['custom_role']!)).toEqual([]); // untouched

      // the FORCE toggle restored FORCE on both tables
      const force = await pool.query<{ relname: string; f: boolean }>(
        `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY($1)`,
        [['role', 'role_permission']],
      );
      for (const r of force.rows) expect(r.f, `${r.relname} FORCE restored`).toBe(true);

      await pool.query(`DELETE FROM "role_permission" WHERE "tenantId" = $1`, [T]);
      await pool.query(`DELETE FROM "role" WHERE "tenantId" = $1`, [T]);
      await pool.query(`DELETE FROM "tenant" WHERE id = $1`, [T]);
    });

    it('catalog:view / catalog:manage are registered in permission_registry (owner R-1)', async () => {
      const { rows } = await pool.query<{ key: string; realm: string; addedInPhase: number }>(
        `SELECT key, realm, "addedInPhase" FROM permission_registry WHERE key = ANY($1) ORDER BY key`,
        [['catalog:manage', 'catalog:view']],
      );
      // seed.ts is NOT run in migration.test — their presence proves the
      // MIGRATION registered them.
      expect(rows.map((r) => r.key)).toEqual(['catalog:manage', 'catalog:view']);
      for (const r of rows) {
        expect(r.realm).toBe('TENANT');
        expect(r.addedInPhase).toBe(3);
      }
    });
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
