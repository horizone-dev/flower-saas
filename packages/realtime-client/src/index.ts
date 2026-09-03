/**
 * Realtime client primitives (ARCHITECTURE §13-14, ADR-0009).
 *
 * Phase 0 seed: the pure, deterministic parts — the resume-tracker and the
 * idempotent event reducer. The WebSocket transport (connect / auth / topic
 * subscribe / reconnect) is built in Phase 2.
 */

export interface RealtimeEvent {
  eventId: string;
  /** per-tenant monotonic sequence number */
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

/** How far behind `seq` a client may fall before a full REST resync is required. */
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
