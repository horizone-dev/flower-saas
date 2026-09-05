import { describe, it, expect } from 'vitest';
import { EventReducer, reconnectDelayMs, type RealtimeEvent } from './reducer.js';

function evt(over: Partial<RealtimeEvent> = {}): RealtimeEvent {
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
  it('applies a fresh event', () => {
    const r = new EventReducer();
    expect(r.offer(evt({ eventId: 'a' }))).toBe('applied');
  });

  it('drops a duplicate eventId (hard gate #3)', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', resourceVersion: 1 }));
    expect(r.offer(evt({ eventId: 'a', resourceVersion: 1 }))).toBe('duplicate');
  });

  it('a stale (out-of-order) resourceVersion is ignored, a newer one still applies', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', resourceVersion: 3 }));
    expect(r.offer(evt({ eventId: 'b', resourceVersion: 2 }))).toBe('stale');
    expect(r.offer(evt({ eventId: 'c', resourceVersion: 4 }))).toBe('applied');
  });

  it('a null resourceVersion is always applied (no version to gate on) — dedup by eventId still holds', () => {
    const r = new EventReducer();
    expect(r.offer(evt({ eventId: 'a', resourceVersion: null }))).toBe('applied');
    expect(r.offer(evt({ eventId: 'a', resourceVersion: null }))).toBe('duplicate');
  });

  it('resource state is isolated per tenant + resourceType + resourceId, not per branch or topic', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', resourceId: 'o1', resourceVersion: 5 }));
    // a DIFFERENT resource, same tenant/type — its own independent version track
    expect(r.offer(evt({ eventId: 'b', resourceId: 'o2', resourceVersion: 1 }))).toBe('applied');
    // the original resource still gates on its own high-water mark
    expect(r.offer(evt({ eventId: 'c', resourceId: 'o1', resourceVersion: 3 }))).toBe('stale');
  });

  it('reset() forgets a seen eventId — the exact same event is no longer a duplicate', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', resourceVersion: 5 }));
    r.reset();
    expect(r.offer(evt({ eventId: 'a', resourceVersion: 5 }))).toBe('applied');
  });

  it('reset() forgets resource-version high-water marks — a lower version applies fresh (post-resync semantics)', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', resourceVersion: 5 }));
    r.reset();
    // no mark survives the reset, so a version lower than the pre-reset
    // high-water mark is not "stale" against anything anymore.
    expect(r.offer(evt({ eventId: 'z', resourceVersion: 1 }))).toBe('applied');
  });

  // ── F8 (hard gate #1): no arithmetic seq-distance resync trigger exists ──
  it('F8 — heavy cross-topic seq interleaving never triggers a resync; there is no such decision to make', () => {
    const r = new EventReducer();
    // per-topic seq deltas of hundreds/thousands — exactly what used to
    // misfire the retired `gap-needs-resync` check.
    expect(r.offer(evt({ eventId: 'a', seq: 100, resourceId: 'o1', resourceVersion: 1 }))).toBe(
      'applied',
    );
    expect(r.offer(evt({ eventId: 'b', seq: 100_900, resourceId: 'o1', resourceVersion: 2 }))).toBe(
      'applied',
    ); // a seq delta of 100,800 on the same resource — no gap concept exists to misfire
    // the reducer's return type doesn't even have a resync variant anymore —
    // this is a structural guarantee, not just a behavioural one (see the
    // ApplyDecision type in reducer.ts).
  });

  // ── F9 (hard gate #2): a stale event never regresses/blocks anything ────
  it('F9 — a stale event does not prevent a later genuinely-newer event from applying', () => {
    const r = new EventReducer();
    r.offer(evt({ eventId: 'a', seq: 10, resourceVersion: 5 }));
    // a reordered delivery: higher seq, but an OLDER resourceVersion
    expect(r.offer(evt({ eventId: 'b', seq: 20, resourceVersion: 3 }))).toBe('stale');
    // an in-order event right after — must apply cleanly, not be blocked by
    // the stale one (the Phase-0 seed's F9 bug: the stale path never
    // advanced its position marker, so this could false-positive a gap; that
    // marker doesn't exist in this reducer at all anymore)
    expect(r.offer(evt({ eventId: 'c', seq: 21, resourceVersion: 6 }))).toBe('applied');
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
