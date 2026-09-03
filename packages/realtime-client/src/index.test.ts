import { describe, it, expect } from 'vitest';
import { EventReducer, reconnectDelayMs } from './index.js';

function evt(over: Partial<Parameters<EventReducer['offer']>[0]> = {}) {
  return {
    eventId: 'e1',
    seq: 1,
    tenantId: 't1',
    branchId: 'b1',
    type: 'order.updated',
    resourceType: 'order',
    resourceId: 'o1',
    resourceVersion: 1,
    occurredAt: '2026-09-03T00:00:00Z',
    ...over,
  };
}

describe('EventReducer', () => {
  it('applies a fresh event and advances the seq high-water mark', () => {
    const r = new EventReducer();
    expect(r.offer(evt({ eventId: 'a', seq: 5 }))).toBe('applied');
    expect(r.lastSeq('t1:b1:order')).toBe(5);
  });

  it('drops a duplicate eventId', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', seq: 1, resourceVersion: 1 }));
    expect(r.offer(evt({ eventId: 'a', seq: 1, resourceVersion: 1 }))).toBe('duplicate');
  });

  it('ignores an out-of-order (stale) resourceVersion', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', seq: 2, resourceVersion: 3 }));
    expect(r.offer(evt({ eventId: 'b', seq: 3, resourceVersion: 2 }))).toBe('stale');
    // a newer version still applies
    expect(r.offer(evt({ eventId: 'c', seq: 4, resourceVersion: 4 }))).toBe('applied');
  });

  it('flags a seq gap beyond the retention window as needing a resync', () => {
    const r = new EventReducer(500);
    r.offer(evt({ eventId: 'a', seq: 10 }));
    expect(
      r.offer(evt({ eventId: 'z', seq: 10 + 501, resourceId: 'o2', resourceVersion: 1 })),
    ).toBe('gap-needs-resync');
    // after a resync the high-water mark moves and subsequent events apply
    r.markResynced('t1:b1:order', 600);
    expect(r.offer(evt({ eventId: 'z2', seq: 601, resourceId: 'o3', resourceVersion: 1 }))).toBe(
      'applied',
    );
  });

  it('isolates topics by tenant + branch + resourceType', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', seq: 100, branchId: 'b1' }));
    // a different branch has its own seq track
    expect(r.lastSeq('t1:b2:order')).toBeUndefined();
  });
});

describe('reconnectDelayMs', () => {
  it('grows exponentially and is capped, with full jitter', () => {
    expect(reconnectDelayMs(0, 0)).toBe(0);
    expect(reconnectDelayMs(0, 0.999, { baseMs: 500 })).toBe(499);
    expect(reconnectDelayMs(3, 1 - 1e-9, { baseMs: 500 })).toBe(3999); // 500 * 8
    expect(reconnectDelayMs(20, 1 - 1e-9, { maxMs: 30_000 })).toBe(29_999);
  });
});
