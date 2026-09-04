/**
 * Realtime client primitives (ARCHITECTURE §13-14, ADR-0009, ADR-0017).
 *
 * Phase 0 seed: the pure, deterministic parts — the resume-tracker and the
 * idempotent event reducer. The WebSocket transport (connect / auth / topic
 * subscribe / reconnect) is built in Phase 2-core task 2.5; this reducer's logic
 * is rewritten against the frozen acceptance suite in task 2.6.
 *
 * The F8/F9 open questions are now RESOLVED — `docs/decisions/ADR-0017.md`
 * (2026-09-04). Summary of what task 2.6 must implement here:
 *   - the resume cursor is the Redis Stream entry id, NOT `seq`. Two cursors:
 *     the SCANNED stream cursor (persisted; advances across EVERY stream entry
 *     the gateway reads, incl. entries for topics this client is not subscribed
 *     to) and the per-resource APPLIED mark (UI ordering only);
 *   - `seq` is a logical ordering / diagnostic value ONLY. There is NO arithmetic
 *     `seq`-distance resync trigger at any granularity — not per-topic, and NOT
 *     `tenantHighWaterSeq - clientLastSeq` (tenant-global `seq` means unrelated
 *     branch activity advances the high-water; comparing it would re-create F8);
 *   - the scanned cursor advances for EVERY consumed event, including
 *     `duplicate` / `stale` / not-for-me (that was F9);
 *   - resync is triggered ONLY when the scanned cursor falls below the stream's
 *     retained floor (`XINFO STREAM` first-id > scannedCursor). `DEFAULT_MAX_SEQ_GAP`
 *     and any high-water arithmetic are removed.
 * The code below is unchanged in task 2.0 (docs-only); it still carries the
 * Phase-0 gap logic and MUST NOT be relied on until task 2.6.
 */

export interface RealtimeEvent {
  eventId: string;
  /**
   * per-tenant-global monotonic sequence number (ARCHITECTURE §13-14, ADR-0017).
   * Assigned ONCE by the outbox dispatcher and immutable — a crash-induced
   * re-publish carries the identical `seq`. Logical ordering / diagnostics ONLY:
   * it is NOT the resume cursor (that is the Redis Stream entry id) and it is
   * NEVER an input to a resync decision — no per-topic delta, no
   * `tenantHighWaterSeq - clientLastSeq` check (ADR-0017 §3, §7).
   */
  seq: number;
  tenantId: string;
  branchId: string;
  type: string;
  resourceType: string;
  resourceId: string;
  /** monotonically increasing per resource */
  resourceVersion: number;
  occurredAt: string;
}

export type ApplyDecision = 'applied' | 'duplicate' | 'stale' | 'gap-needs-resync';

/**
 * Phase-0 seed value only. Per ADR-0017 (§3, §7) every arithmetic `seq`-distance
 * resync trigger is REMOVED in task 2.6 — per-topic delta and tenant-high-water
 * delta alike. Resync is decided solely by the scanned Redis Stream cursor vs the
 * stream's retained range. This constant does not survive task 2.6.
 */
export const DEFAULT_MAX_SEQ_GAP = 500;

/**
 * Tracks the last applied `seq` per topic and the last applied `resourceVersion`
 * per resource, and decides what to do with an incoming event:
 *   - `duplicate`        already seen this eventId
 *   - `stale`            an older resourceVersion than we hold -> ignore
 *   - `gap-needs-resync` seq jumped further than maxSeqGap -> caller must resync
 *   - `applied`          apply it and advance the trackers
 */
export class EventReducer {
  private readonly seenEventIds = new Set<string>();
  private readonly lastSeqByTopic = new Map<string, number>();
  private readonly versionByResource = new Map<string, number>();

  constructor(private readonly maxSeqGap: number = DEFAULT_MAX_SEQ_GAP) {}

  private topicKey(e: RealtimeEvent): string {
    return `${e.tenantId}:${e.branchId}:${e.resourceType}`;
  }
  private resourceKey(e: RealtimeEvent): string {
    return `${e.tenantId}:${e.resourceType}:${e.resourceId}`;
  }

  lastSeq(topicKey: string): number | undefined {
    return this.lastSeqByTopic.get(topicKey);
  }

  offer(e: RealtimeEvent): ApplyDecision {
    // TASK 2.6 (ADR-0017): rewrite this method —
    //   * drop the `prevSeq + maxSeqGap` gap test entirely — there is no
    //     arithmetic `seq`-distance resync trigger at any granularity (F8);
    //   * the position marker is the SCANNED Redis Stream entry id, tracked by
    //     the transport layer and advanced across EVERY scanned entry (incl.
    //     `stale` / `duplicate` / not-for-me — F9);
    //   * `versionByResource` still gates payload application;
    //   * resync is decided by the transport (scanned cursor < retained floor),
    //     never here.
    // Until then this still carries the Phase-0 logic and is not wired live.
    if (this.seenEventIds.has(e.eventId)) return 'duplicate';

    const tk = this.topicKey(e);
    const prevSeq = this.lastSeqByTopic.get(tk);
    if (prevSeq !== undefined && e.seq > prevSeq + this.maxSeqGap) {
      return 'gap-needs-resync';
    }

    const rk = this.resourceKey(e);
    const prevVersion = this.versionByResource.get(rk);
    if (prevVersion !== undefined && e.resourceVersion <= prevVersion) {
      // still record the eventId so a later duplicate is caught
      this.seenEventIds.add(e.eventId);
      return 'stale';
    }

    this.seenEventIds.add(e.eventId);
    this.versionByResource.set(rk, e.resourceVersion);
    if (prevSeq === undefined || e.seq > prevSeq) this.lastSeqByTopic.set(tk, e.seq);
    return 'applied';
  }

  /** After a REST resync of a topic, set the high-water mark so old events are dropped. */
  markResynced(topicKey: string, seq: number): void {
    this.lastSeqByTopic.set(topicKey, seq);
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
