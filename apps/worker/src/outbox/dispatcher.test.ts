import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@flower/service-runtime';
import { OutboxDispatcher } from './dispatcher.js';

const { allocateTenantSeq, discoverUnstampedTenants } = vi.hoisted(() => ({
  allocateTenantSeq: vi.fn(),
  discoverUnstampedTenants: vi.fn(),
}));
vi.mock('./seq-allocator.js', () => ({ allocateTenantSeq, discoverUnstampedTenants }));

const { publishReadyBatch } = vi.hoisted(() => ({ publishReadyBatch: vi.fn() }));
vi.mock('./publisher.js', () => ({ publishReadyBatch }));

/**
 * `OutboxDispatcher.tick()` orchestration in isolation (constraint 4/7/9 —
 * "one failing tenant does not block another"). Mocked collaborators: the
 * real-database half of this guarantee (a genuine Postgres error never
 * corrupts the connection pool for a later tenant) is covered by
 * `dispatcher.integration.test.ts`.
 */
describe('OutboxDispatcher.tick() — per-tenant isolation', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const fakeDb = {} as never;
  const fakeRedis = {} as never;

  beforeEach(() => {
    allocateTenantSeq.mockReset();
    discoverUnstampedTenants.mockReset();
    publishReadyBatch.mockReset();
    publishReadyBatch.mockResolvedValue({ published: 0, failed: 0 });
  });

  it('a rejected allocation for one tenant does not stop tick(), other tenants still get tried', async () => {
    discoverUnstampedTenants.mockResolvedValue(['tenant-bad', 'tenant-ok']);
    allocateTenantSeq.mockImplementation((_db: unknown, tenantId: string) =>
      tenantId === 'tenant-bad'
        ? Promise.reject(new Error('SIMULATED_ALLOCATION_FAILURE'))
        : Promise.resolve({ leader: true, stamped: 3 }),
    );

    const dispatcher = new OutboxDispatcher({ db: fakeDb, redis: fakeRedis, logger: log });
    const result = await dispatcher.tick(); // must not throw

    expect(allocateTenantSeq).toHaveBeenCalledTimes(2);
    expect(allocateTenantSeq).toHaveBeenCalledWith(fakeDb, 'tenant-bad', expect.any(Number));
    expect(allocateTenantSeq).toHaveBeenCalledWith(fakeDb, 'tenant-ok', expect.any(Number));
    expect(result.tenantsTried).toBe(2);
    expect(result.stamped).toBe(3); // only tenant-ok's stamps counted
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-bad' }),
      expect.any(String),
    );
  });

  it('the publish phase still runs even when every tenant allocation failed', async () => {
    discoverUnstampedTenants.mockResolvedValue(['tenant-bad-1', 'tenant-bad-2']);
    allocateTenantSeq.mockRejectedValue(new Error('SIMULATED_ALLOCATION_FAILURE'));
    publishReadyBatch.mockResolvedValue({ published: 5, failed: 1 });

    const dispatcher = new OutboxDispatcher({ db: fakeDb, redis: fakeRedis, logger: log });
    const result = await dispatcher.tick();

    expect(publishReadyBatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ tenantsTried: 2, stamped: 0, published: 5, failed: 1 });
  });

  it('start()/stop(): a tick that throws is caught and logged — the loop keeps running, not crashes the process', async () => {
    discoverUnstampedTenants.mockRejectedValue(new Error('SIMULATED_DISCOVERY_FAILURE'));
    const dispatcher = new OutboxDispatcher({
      db: fakeDb,
      redis: fakeRedis,
      logger: log,
      tickIntervalMs: 10,
    });
    dispatcher.start();
    await new Promise((r) => setTimeout(r, 30));
    await dispatcher.stop();
    expect(log.error).toHaveBeenCalled();
  });
});
