import { describe, it, expect } from 'vitest';
import {
  outboxLagWarnings,
  DEFAULT_OUTBOX_LAG_THRESHOLDS,
  type OutboxLagSnapshot,
} from './metrics.js';

function snap(over: Partial<OutboxLagSnapshot> = {}): OutboxLagSnapshot {
  return {
    undispatched: 0,
    oldestUndispatchedAgeMs: 0,
    withFailures: 0,
    worstTenantId: null,
    ...over,
  };
}

describe('outboxLagWarnings (bounded, threshold-triggered — the only place a tenant id surfaces)', () => {
  it('emits nothing while the backlog is within thresholds', () => {
    expect(outboxLagWarnings(snap({ undispatched: 10, oldestUndispatchedAgeMs: 1_000 }))).toEqual(
      [],
    );
  });

  it('flags an oversized backlog with the most-behind tenant id (for a log line, not a metric)', () => {
    const w = outboxLagWarnings(
      snap({
        undispatched: DEFAULT_OUTBOX_LAG_THRESHOLDS.maxUndispatched + 1,
        worstTenantId: 'tenant-x',
      }),
    );
    expect(w).toEqual([
      {
        code: 'OUTBOX_BACKLOG_HIGH',
        tenantId: 'tenant-x',
        value: DEFAULT_OUTBOX_LAG_THRESHOLDS.maxUndispatched + 1,
      },
    ]);
  });

  it('flags a too-old oldest item', () => {
    const w = outboxLagWarnings(
      snap({
        undispatched: 1,
        oldestUndispatchedAgeMs: DEFAULT_OUTBOX_LAG_THRESHOLDS.maxOldestAgeMs + 1,
        worstTenantId: 'tenant-y',
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]!.code).toBe('OUTBOX_OLDEST_TOO_OLD');
  });

  it('can flag both conditions at once', () => {
    const w = outboxLagWarnings(
      snap({
        undispatched: 10_000,
        oldestUndispatchedAgeMs: 60 * 60_000,
        worstTenantId: 't',
      }),
    );
    expect(w.map((x) => x.code).sort()).toEqual(['OUTBOX_BACKLOG_HIGH', 'OUTBOX_OLDEST_TOO_OLD']);
  });

  it('honours a custom threshold set', () => {
    expect(
      outboxLagWarnings(snap({ undispatched: 6 }), { maxUndispatched: 5, maxOldestAgeMs: 10 }),
    ).toHaveLength(1);
  });

  it('a warning object never carries anything beyond {code, tenantId, value} — no unbounded label surface', () => {
    const w = outboxLagWarnings(snap({ undispatched: 10_000, worstTenantId: 't' }));
    expect(Object.keys(w[0]!).sort()).toEqual(['code', 'tenantId', 'value']);
  });
});
