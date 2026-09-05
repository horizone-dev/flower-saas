/**
 * The idempotent event reducer (task 2.6, ADR-0017 §3, §6a-c, §7 — F8/F9
 * resolved). Rewritten against the frozen acceptance suite
 * (`docs/phase-2/REALTIME-PROTOCOL-INPUTS.md`).
 *
 * What changed from the Phase-0 seed, and why:
 *   - **`gap-needs-resync` is gone.** There is no arithmetic `seq`-distance
 *     resync trigger at any granularity — not per-topic, not
 *     `tenantHighWaterSeq - clientLastSeq` (F8). Resync eligibility is
 *     decided by the **transport** (the persisted scanned Stream cursor vs.
 *     the stream's retained floor — see `transport.ts`'s `resume` handling),
 *     never by this reducer.
 *   - **`lastSeqByTopic` is gone.** The "position" concept it tried to serve
 *     is now the scanned Stream cursor, a single value tracked by the
 *     transport from the `cursor` field every server frame carries — not a
 *     per-topic, event-derived value at all. This reducer only ever answers
 *     "should this event's payload be applied", never "am I behind".
 *   - **`resourceVersion` still gates payload application** (`stale` for an
 *     older-or-equal version), exactly as before — that part of the seed was
 *     already correct (this was F9's fix target: a `stale` result must not
 *     block the *position* marker, and since position no longer lives here
 *     at all, that failure mode cannot recur).
 */

export interface RealtimeEvent {
  eventId: string;
  /**
   * Per-tenant-global monotonic sequence number (ADR-0017 §1). Assigned once
   * by the outbox dispatcher and immutable — a crash-induced re-publish
   * carries the identical `seq`. **Logical ordering / diagnostics only**: it
   * is never the resume cursor (that is the Redis Stream entry id, tracked by
   * the transport) and never an input to a resync decision.
   */
  seq: number;
  tenantId: string;
  branchId: string | null;
  type: string;
  resourceType: string;
  resourceId: string;
  /** `null` for an event with no versioned resource state (e.g. a pure
   *  lifecycle signal) — such an event is always `applied` (dedup by
   *  `eventId` still applies). */
  resourceVersion: number | null;
  occurredAt: string;
}

export type ApplyDecision = 'applied' | 'duplicate' | 'stale';

/**
 * Tracks which `eventId`s have been seen and the last applied
 * `resourceVersion` per resource. Deliberately holds **no** notion of
 * "position" or "how far behind" — that is the transport's job.
 */
export class EventReducer {
  private readonly seenEventIds = new Set<string>();
  private readonly versionByResource = new Map<string, number>();

  private resourceKey(e: RealtimeEvent): string {
    return `${e.tenantId}:${e.resourceType}:${e.resourceId}`;
  }

  offer(e: RealtimeEvent): ApplyDecision {
    if (this.seenEventIds.has(e.eventId)) return 'duplicate';
    this.seenEventIds.add(e.eventId);

    if (e.resourceVersion === null) return 'applied';

    const rk = this.resourceKey(e);
    const prevVersion = this.versionByResource.get(rk);
    if (prevVersion !== undefined && e.resourceVersion <= prevVersion) {
      return 'stale';
    }
    this.versionByResource.set(rk, e.resourceVersion);
    return 'applied';
  }

  /** After a resync (or a fresh REST bootstrap): REST is authoritative now,
   *  so every per-resource mark and every remembered `eventId` is discarded —
   *  the next events are judged fresh against the just-fetched state. */
  reset(): void {
    this.seenEventIds.clear();
    this.versionByResource.clear();
  }
}

/** Exponential backoff with full jitter, deterministic given `rand` in [0, 1). */
export function reconnectDelayMs(
  attempt: number,
  rand: number,
  opts: { baseMs?: number; maxMs?: number } = {},
): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const uncapped = base * 2 ** Math.max(0, attempt);
  const ceiling = Math.min(max, uncapped);
  return Math.floor(rand * ceiling);
}
