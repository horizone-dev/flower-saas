/**
 * A small bounded "recently seen `event_id`" cache, one per tenant this
 * gateway instance currently holds a live socket for. A relay restart may
 * re-publish an already-delivered live event (ADR-0017 §4 — "duplicate live
 * delivery is acceptable... suppressed downstream by `event_id`"); this is
 * that suppression point, before fan-out to individual sockets (cheaper than
 * deduping per-socket, and sufficient — every socket for a tenant sees the
 * same live stream).
 *
 * Bounded FIFO, not a TTL cache — simplest correct structure for "don't grow
 * unboundedly, forget the oldest first" with no wall-clock dependency to get
 * wrong in a test.
 */
export class RecentEventIds {
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly capacity = 500) {}

  /** Returns `true` the first time an id is seen, `false` on every repeat. */
  offer(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    this.order.push(eventId);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
