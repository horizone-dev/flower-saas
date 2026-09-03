import { describe, it, expect } from 'vitest';
import { runIsolationProbes, inParallel, withTenantContext } from './index.js';

describe('@flower/testing — probe harness (Phase 0 skeleton)', () => {
  it('flags a probe that did NOT return a denied status as a leak', async () => {
    const { results, leaks } = await runIsolationProbes([
      { name: 'cross-tenant read by id', axis: 'tenant', attempt: async () => 404 },
      { name: 'cross-branch order list', axis: 'branch', attempt: async () => 200 },
      { name: 'cross-tenant mutation', axis: 'tenant', attempt: async () => 403 },
    ]);
    expect(results).toHaveLength(3);
    expect(leaks.map((l) => l.name)).toEqual(['cross-branch order list']);
  });

  it('honours a custom expectDenied set', async () => {
    const { leaks } = await runIsolationProbes([
      { name: 'expects 401', axis: 'customer', attempt: async () => 401, expectDenied: [401] },
    ]);
    expect(leaks).toHaveLength(0);
  });

  it('inParallel runs N tasks and settles all', async () => {
    const settled = await inParallel(5, async (i) => {
      if (i === 2) throw new Error('boom');
      return i;
    });
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(4);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
  });

  it('withTenantContext passes the value through (placeholder)', async () => {
    await expect(withTenantContext('t1', async () => 42)).resolves.toBe(42);
  });
});
