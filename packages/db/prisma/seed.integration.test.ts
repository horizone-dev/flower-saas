import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { CATALOG_CAPABILITY_KEYS } from '@flower/shared-types';
import { BUSINESS_TYPE_TEMPLATES } from './catalog-capabilities.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRISMA = path.join(pkgDir, 'node_modules/prisma/build/index.js');
const TSX = path.join(pkgDir, 'node_modules/tsx/dist/cli.mjs');

/**
 * Task 3.1 — proves the seed actually materialises the 35 Business-Type
 * templates + their normalized capability rows (config ALWAYS null) and the
 * `custom_composition` entitlement default. Real Postgres, real `prisma migrate
 * deploy`, real `tsx prisma/seed.ts`. Nothing mocked.
 */
describe('packages/db — Business-Type template seed (task 3.1)', () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let pool: pg.Pool;

  const runSeed = (): void => {
    execFileSync('node', [TSX, 'prisma/seed.ts'], {
      cwd: pkgDir,
      env: { ...process.env, DATABASE_URL: url, SEED_PLATFORM_ADMIN_EMAIL: '' },
      encoding: 'utf8',
    });
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    url = container.getConnectionUri();
    execFileSync('node', [PRISMA, 'migrate', 'deploy'], {
      cwd: pkgDir,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    runSeed();
    pool = new pg.Pool({ connectionString: url });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('seeds exactly 35 ACTIVE templates at version 1', async () => {
    const { rows } = await pool.query<{ n: string; v: string; s: string }>(
      `SELECT count(*)::text AS n,
              min(version)::text AS v,
              string_agg(DISTINCT status, ',') AS s
         FROM business_type_template`,
    );
    expect(Number(rows[0]!.n)).toBe(35);
    expect(rows[0]!.v).toBe('1');
    expect(rows[0]!.s).toBe('ACTIVE');
  });

  it('is idempotent — a second seed run leaves the same rows', { timeout: 120_000 }, async () => {
    runSeed();
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM business_type_template`,
    );
    expect(n.rows[0]!.n).toBe(35);
    const caps = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM business_type_template_capability`,
    );
    const expectedCaps = BUSINESS_TYPE_TEMPLATES.reduce((s, t) => s + t.capabilities.length, 0);
    expect(caps.rows[0]!.n).toBe(expectedCaps);
  });

  it('every template capability row is enabled=true, config IS NULL, in the closed registry', async () => {
    const { rows } = await pool.query<{ capabilityKey: string; enabled: boolean; config: unknown }>(
      `SELECT "capabilityKey", enabled, config FROM business_type_template_capability`,
    );
    const known = new Set<string>(CATALOG_CAPABILITY_KEYS);
    for (const r of rows) {
      expect(r.enabled).toBe(true);
      expect(r.config).toBeNull();
      expect(known.has(r.capabilityKey)).toBe(true);
    }
  });

  it('every template exposes exactly its §C.3 capability set', async () => {
    for (const t of BUSINESS_TYPE_TEMPLATES) {
      const { rows } = await pool.query<{ capabilityKey: string }>(
        `SELECT "capabilityKey" FROM business_type_template_capability WHERE "templateKey" = $1`,
        [t.key],
      );
      expect(new Set(rows.map((r) => r.capabilityKey))).toEqual(new Set(t.capabilities));
    }
  });

  it('CUSTOM is a normal template row with the 3-key minimal set', async () => {
    const { rows } = await pool.query<{ capabilityKey: string }>(
      `SELECT "capabilityKey" FROM business_type_template_capability WHERE "templateKey" = 'CUSTOM' ORDER BY 1`,
    );
    expect(rows.map((r) => r.capabilityKey)).toEqual([
      'branch_pricing',
      'channel.pos',
      'strategy.stocked',
    ]);
  });

  it('the custom_composition entitlement default is seeded on the Starter plan version', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entitlement_default WHERE "moduleKey" = 'custom_composition'`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('the new platform permission is registered', async () => {
    const { rows } = await pool.query<{ realm: string }>(
      `SELECT realm FROM permission_registry WHERE key = 'platform:catalog_capability:manage'`,
    );
    expect(rows[0]?.realm).toBe('PLATFORM');
  });

  it('task 3.2 — catalog:view / catalog:manage are registered as TENANT keys (owner R-1)', async () => {
    const { rows } = await pool.query<{ key: string; realm: string; addedInPhase: number }>(
      `SELECT key, realm, "addedInPhase" FROM permission_registry
        WHERE key = ANY(ARRAY['catalog:view','catalog:manage']) ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual(['catalog:manage', 'catalog:view']);
    for (const r of rows) {
      expect(r.realm).toBe('TENANT');
      expect(r.addedInPhase).toBe(3);
    }
  });
});
