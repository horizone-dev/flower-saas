import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENDPOINTS,
  composeUp,
  composeDown,
  resetAndSeed,
  measureLatency,
  type Endpoint,
  type SpikeSeed,
} from '../src/harness.js';
import { createSpikeClient, runScoped, readTenantGuc, type PrismaClient } from '../src/scoped.js';

const KEEP = process.env['KEEP_SPIKE'] === '1';

/**
 * Task 0.6 — the HARD RLS / connection-pooling gate (ADR-0010).
 *
 * Proves tenant isolation holds for the candidate pattern (Prisma interactive
 * transaction + `set_config('app.tenant_id', $1, true)`) under:
 *   - a direct connection
 *   - PgBouncer in transaction-pool mode
 *   - PgBouncer in session-pool mode
 *
 * A failure here is NOT to be worked around by weakening RLS — it triggers the
 * Kysely fallback for scope-critical reads (ADR-0010).
 */
describe('RLS + PgBouncer spike', () => {
  let seed: SpikeSeed;

  beforeAll(async () => {
    composeUp();
    const direct = ENDPOINTS.find((e) => e.label === 'direct')!;
    seed = await resetAndSeed(direct.adminUrl);
  }, 180_000);

  afterAll(() => {
    if (!KEEP) composeDown();
  });

  describe.each(ENDPOINTS)('endpoint: $label', (endpoint: Endpoint) => {
    let prisma: PrismaClient;

    beforeAll(() => {
      prisma = createSpikeClient(endpoint.appUrl);
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('a scoped read sees ONLY the acting tenant', async () => {
      const aRows = await runScoped(prisma, seed.tenantA, (tx) => tx.spikeRow.findMany());
      expect(aRows).toHaveLength(seed.countA);
      expect(aRows.every((r) => r.secret.startsWith('A-'))).toBe(true);

      const bRows = await runScoped(prisma, seed.tenantB, (tx) => tx.spikeRow.findMany());
      expect(bRows).toHaveLength(seed.countB);
      expect(bRows.every((r) => r.secret.startsWith('B-'))).toBe(true);
    });

    it('a scoped read CANNOT reach the other tenant by id', async () => {
      const bId = (await runScoped(prisma, seed.tenantB, (tx) => tx.spikeRow.findMany()))[0]!.id;
      const stolen = await runScoped(prisma, seed.tenantA, (tx) =>
        tx.spikeRow.findUnique({ where: { id: bId } }),
      );
      expect(stolen).toBeNull();
    });

    it('an UNSCOPED query (no GUC) returns ZERO rows — fails closed, never leaks', async () => {
      const rows = await prisma.spikeRow.findMany();
      expect(rows).toHaveLength(0);
      const tenants = await prisma.spikeTenant.findMany();
      expect(tenants).toHaveLength(0);
    });

    it('the GUC does NOT bleed onto a pooled connection after a scoped txn', async () => {
      await runScoped(prisma, seed.tenantA, (tx) => tx.spikeRow.findMany());
      // new statement, no transaction -> SET LOCAL must have been discarded
      expect(await readTenantGuc(prisma)).toBe('');
      const rows = await prisma.spikeRow.findMany();
      expect(rows).toHaveLength(0);
    });

    it('WITH CHECK blocks inserting a row for another tenant', async () => {
      await expect(
        runScoped(prisma, seed.tenantA, (tx) =>
          tx.spikeRow.create({ data: { tenantId: seed.tenantB, secret: 'cross-tenant write' } }),
        ),
      ).rejects.toThrow();
    });

    it('interleaved concurrent tenants stay isolated (20x A||B)', async () => {
      const work = Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? runScoped(prisma, seed.tenantA, (tx) => tx.spikeRow.findMany())
          : runScoped(prisma, seed.tenantB, (tx) => tx.spikeRow.findMany()),
      );
      const results = await Promise.all(work);
      results.forEach((rows, i) => {
        const expected = i % 2 === 0 ? seed.countA : seed.countB;
        const prefix = i % 2 === 0 ? 'A-' : 'B-';
        expect(rows).toHaveLength(expected);
        expect(rows.every((r) => r.secret.startsWith(prefix))).toBe(true);
      });
    });

    it('records wrapper latency for the ADR', async () => {
      const scoped = await measureLatency(
        () => runScoped(prisma, seed.tenantA, (tx) => tx.spikeRow.findMany()),
        40,
      );
      const bare = await measureLatency(() => prisma.$queryRaw`SELECT 1`, 40);
      console.log(
        `[latency] ${endpoint.label}: scoped p50=${scoped.p50}ms p95=${scoped.p95}ms | bare SELECT 1 p50=${bare.p50}ms`,
      );
      expect(scoped.p50).toBeGreaterThan(0);
    });
  });
});
