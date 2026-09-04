import { describe, expect, it } from 'vitest';
import { runIsolationProbes, assertNoLeaks, crossBoundaryCases } from './probes.js';
import { inParallel, summarize, expectAtMostSucceed } from './concurrency.js';

describe('probe harness (pure)', () => {
  it('flags any non-denied status as a leak', async () => {
    const run = await runIsolationProbes([
      { name: 'cross-tenant read by id', axis: 'tenant', attempt: async () => 404 },
      { name: 'cross-branch order list', axis: 'branch', attempt: async () => 200 },
      { name: 'cross-tenant mutation', axis: 'tenant', attempt: async () => 403 },
    ]);
    expect(run.ok).toBe(false);
    expect(run.leaks.map((l) => l.name)).toEqual(['cross-branch order list']);
  });

  it('treats an error during the attempt as a leak candidate', async () => {
    const run = await runIsolationProbes([
      {
        name: 'boom',
        axis: 'tenant',
        attempt: async () => {
          throw new Error('network');
        },
      },
    ]);
    expect(run.ok).toBe(false);
    expect(run.leaks[0]?.error).toMatch(/network/);
  });

  it('assertNoLeaks passes clean and throws a summary otherwise', async () => {
    const clean = await runIsolationProbes([
      { name: 'ok', axis: 'tenant', attempt: async () => 403 },
    ]);
    expect(() => assertNoLeaks(clean)).not.toThrow();

    const leaky = await runIsolationProbes([
      { name: 'leak', axis: 'branch', attempt: async () => 200 },
    ]);
    expect(() => assertNoLeaks(leaky)).toThrow(/1 leak/);
  });

  it('honours a custom expectDenied set', async () => {
    const run = await runIsolationProbes([
      { name: 'expects 401', axis: 'customer', attempt: async () => 401, expectDenied: [401] },
    ]);
    expect(run.ok).toBe(true);
  });

  it('accepts an explicit {status, leaked} verdict for list/filter endpoints', async () => {
    const run = await runIsolationProbes([
      // a scoped list legitimately answers 200 but returned none of the victim's rows
      {
        name: 'cross-tenant list (empty)',
        axis: 'tenant',
        attempt: async () => ({ status: 200, leaked: false }),
      },
      // ...this one returned a victim row
      {
        name: 'cross-tenant list (leaked row)',
        axis: 'tenant',
        attempt: async () => ({ status: 200, leaked: true }),
      },
    ]);
    expect(run.ok).toBe(false);
    expect(run.leaks.map((l) => l.name)).toEqual(['cross-tenant list (leaked row)']);
  });

  it('crossBoundaryCases builds id / param / nested-URL attempts', async () => {
    const calls: string[] = [];
    const cases = crossBoundaryCases({
      resource: 'orders',
      axis: 'tenant',
      victimId: 'abc',
      fetchAs: async (p) => {
        calls.push(p);
        return 404;
      },
    });
    await runIsolationProbes(cases);
    expect(calls).toEqual(['/v1/orders/abc', '/v1/orders?id=abc', '/v1/orders/abc/detail']);
  });
});

describe('concurrency helpers (pure)', () => {
  it('inParallel + summarize', async () => {
    const settled = await inParallel(5, async (i) => {
      if (i === 2) throw new Error('x');
      return i;
    });
    const s = summarize(settled);
    expect(s.fulfilledCount).toBe(4);
    expect(s.rejectedCount).toBe(1);
  });

  it('expectAtMostSucceed catches an oversell', async () => {
    // capacity 3, 10 buyers, everyone "succeeds" -> must throw
    await expect(
      expectAtMostSucceed({
        n: 10,
        capacity: 3,
        attempt: async (i) => i,
        isSuccess: () => true,
      }),
    ).rejects.toThrow(/oversell/);
  });

  it('expectAtMostSucceed passes when the cap is respected', async () => {
    const r = await expectAtMostSucceed({
      n: 10,
      capacity: 3,
      attempt: async (i) => i,
      isSuccess: (v) => v < 3,
    });
    expect(r.succeeded).toBe(3);
  });
});
