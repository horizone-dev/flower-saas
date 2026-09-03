import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startTestStack,
  withTenantContext,
  currentTenantGuc,
  runIsolationProbes,
  assertNoLeaks,
  pg,
  type TestStack,
} from '../src/index.js';

/**
 * Task 0.11 "done when": the harness spins a stack up and down and its self-test
 * is green. Proves — against REAL Postgres + Redis + MinIO containers — that:
 *   - the stack starts and every service is reachable,
 *   - `withTenantContext` isolates rows via RLS + `SET LOCAL` (the 0.6 pattern),
 *   - an unscoped query returns zero rows (fails closed),
 *   - `runIsolationProbes` detects a deliberate leak.
 */
describe('@flower/testing — harness self-test', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    stack = await startTestStack();

    // A tiny RLS fixture (same posture as tooling/spikes/rls).
    const admin = new pg.Client({ connectionString: stack.postgres.url });
    await admin.connect();
    await admin.query(`
      CREATE TABLE t_row (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        note text NOT NULL
      );
      ALTER TABLE t_row ENABLE ROW LEVEL SECURITY;
      ALTER TABLE t_row FORCE ROW LEVEL SECURITY;
      CREATE POLICY t_row_iso ON t_row
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
    `);
    tenantA = (await admin.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    tenantB = (await admin.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    await admin.query("SELECT set_config('app.tenant_id', $1, false)", [tenantA]);
    await admin.query("INSERT INTO t_row(tenant_id, note) VALUES ($1,'A1'),($1,'A2')", [tenantA]);
    await admin.query("SELECT set_config('app.tenant_id', $1, false)", [tenantB]);
    await admin.query("INSERT INTO t_row(tenant_id, note) VALUES ($1,'B1')", [tenantB]);
    await admin.end();

    // App-role pool (NOSUPERUSER NOBYPASSRLS).
    const su = new pg.Client({ connectionString: stack.postgres.url });
    await su.connect();
    await su.query(
      "CREATE ROLE app_role LOGIN PASSWORD 'app_role' NOSUPERUSER NOBYPASSRLS; " +
        'GRANT SELECT, INSERT ON t_row TO app_role;',
    );
    await su.end();
    pool = new pg.Pool({
      host: stack.postgres.host,
      port: stack.postgres.port,
      user: 'app_role',
      password: 'app_role',
      database: 'flower_test',
      max: 4,
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await stack?.stop();
  });

  it('starts Postgres + Redis + MinIO and they are reachable', async () => {
    expect(stack.postgres.url).toMatch(/^postgres/);
    expect(stack.redis.url).toMatch(/^redis/);
    const res = await fetch(`${stack.minio.endpoint}/minio/health/live`);
    expect(res.status).toBe(200);
  });

  it('withTenantContext isolates rows per tenant', async () => {
    const a = await withTenantContext(pool, tenantA, async (c) =>
      c.query('SELECT note FROM t_row'),
    );
    expect(a.rows.map((r) => r.note).sort()).toEqual(['A1', 'A2']);

    const b = await withTenantContext(pool, tenantB, async (c) =>
      c.query('SELECT note FROM t_row'),
    );
    expect(b.rows.map((r) => r.note)).toEqual(['B1']);
  });

  it('an unscoped query returns zero rows and does not bleed the GUC', async () => {
    await withTenantContext(pool, tenantA, async (c) => c.query('SELECT 1'));
    expect(await currentTenantGuc(pool)).toBe('');
    const { rows } = await pool.query('SELECT * FROM t_row');
    expect(rows).toHaveLength(0);
  });

  it('runIsolationProbes detects a deliberate cross-tenant leak', async () => {
    const run = await runIsolationProbes([
      {
        name: 'read t_row as the wrong tenant (RLS-protected -> 0 rows -> "404")',
        axis: 'tenant',
        attempt: async () => {
          const r = await withTenantContext(pool, tenantB, async (c) =>
            c.query('SELECT * FROM t_row WHERE note = $1', ['A1']),
          );
          return r.rows.length === 0 ? 404 : 200;
        },
      },
      {
        name: 'simulated leaky endpoint returning another tenant row',
        axis: 'tenant',
        attempt: async () => 200,
      },
    ]);
    expect(run.leaks.map((l) => l.name)).toEqual([
      'simulated leaky endpoint returning another tenant row',
    ]);
    expect(() => assertNoLeaks(run)).toThrow(/1 leak/);
  });
});
