import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { DbService, type BackendConfig } from '@flower/backend';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { outboxLagSnapshot } from './metrics.js';

/**
 * `outboxLagSnapshot` against a real database (Testcontainers) — task 2.8
 * operational visibility. Proves the snapshot is a set of GLOBAL AGGREGATES
 * (never a per-tenant series) and that it reads through the least-privilege
 * `flower_dispatcher` role (`runDispatcher`), same as the dispatcher itself.
 */
describe('outbox lag snapshot (integration — Postgres)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let db: DbService;

  function dbConfig(): BackendConfig {
    return {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: stack.postgres.url,
      PLATFORM_DATABASE_URL: stack.postgres.url,
      AUTH_JWT_SECRET: 'dev-only-insecure-jwt-secret-change-me-000',
      AUTH_ACCESS_TOKEN_TTL_SECONDS: 600,
    };
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    db = new DbService(dbConfig());
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await stack?.stop();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM outbox');
  });

  async function insert(over: {
    tenantId: string;
    createdAt?: Date;
    dispatchedAt?: Date | null;
    attempts?: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO outbox
         (id, "tenantId", "aggregateType", "aggregateId", "eventType", payload,
          attempts, "dispatchedAt", "createdAt")
       VALUES (uuidv7(), $1::uuid, 'tenant', $1::uuid, 'test.event', '{}'::jsonb,
               $2, $3, COALESCE($4, now()))`,
      [over.tenantId, over.attempts ?? 0, over.dispatchedAt ?? null, over.createdAt ?? null],
    );
  }

  it('an empty / fully-dispatched outbox reports a clean snapshot', async () => {
    await insert({ tenantId: randomUUID(), dispatchedAt: new Date() });
    expect(await outboxLagSnapshot(db)).toEqual({
      undispatched: 0,
      oldestUndispatchedAgeMs: 0,
      withFailures: 0,
      worstTenantId: null,
    });
  });

  it('aggregates undispatched rows across all tenants; a dispatched row is excluded', async () => {
    const tA = randomUUID();
    const tB = randomUUID();
    const old = new Date(Date.now() - 90_000);
    await insert({ tenantId: tA, createdAt: old }); // oldest, no failures
    await insert({ tenantId: tB, createdAt: new Date(Date.now() - 1_000), attempts: 3 });
    await insert({ tenantId: tB, dispatchedAt: new Date() }); // excluded

    const snap = await outboxLagSnapshot(db);
    expect(snap.undispatched).toBe(2);
    expect(snap.withFailures).toBe(1);
    expect(snap.oldestUndispatchedAgeMs).toBeGreaterThanOrEqual(80_000);
    expect(snap.worstTenantId).toBe(tA); // the single most-behind tenant — diagnostic only
  });

  it('the snapshot has a fixed key set regardless of tenant count (O(1) cardinality)', async () => {
    for (let i = 0; i < 5; i++) await insert({ tenantId: randomUUID() });
    const snap = await outboxLagSnapshot(db);
    expect(Object.keys(snap).sort()).toEqual([
      'oldestUndispatchedAgeMs',
      'undispatched',
      'withFailures',
      'worstTenantId',
    ]);
  });
});
