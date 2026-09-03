# Phase 2 — realtime protocol design inputs

> Recorded 2026-09-03 from the post-Phase-0 ultra-review (findings **F8**, **F9**).
> These are **not bugs to hot-fix in Phase 0** — `packages/realtime-client` is a
> Phase 0 seed whose transport and wire protocol are specified and built in
> **Phase 2** (ROADMAP "Phase 2 — realtime core"). They are captured here so the
> Phase 2 protocol work resolves them deliberately rather than rediscovering them.
>
> Nothing consumes `EventReducer` / `ResumeTracker` at runtime yet, so there is no
> live defect. Do not change `packages/realtime-client/src/index.ts` for these
> until the Phase 2 realtime protocol is designed.

## Context

`ARCHITECTURE.md §13–14` says every realtime event carries
`seq` — **"per tenant, monotonic"** — and the client tracks `last_seq` **per
topic** to decide when a gap is too large to replay (`gap-needs-resync` →
full REST resync). Retention window is 24h / N events (Z-7).

The Phase 0 seed (`packages/realtime-client/src/index.ts`) implements:

- `ResumeTracker` / `EventReducer` — pure, deterministic.
- `EventReducer.offer(e)` → `applied | duplicate | stale | gap-needs-resync`.
- topic key = `tenantId:branchId:resourceType`; `lastSeqByTopic` per that key;
  gap test = `e.seq > prevSeq + maxSeqGap` (default `maxSeqGap = 500`).
- resource key = `tenantId:resourceType:resourceId`; `versionByResource` gates
  out-of-order updates by `resourceVersion`.

## F8 — `seq` granularity vs the gap check

**Observation.** If `seq` is genuinely **per-tenant-global** (as §13–14 states),
then a single topic (`tenant:branch:resourceType`) only ever sees a _sparse
subset_ of the tenant's `seq` values. Two consecutive events **on one topic** can
legitimately be `seq = 100` and `seq = 900` when 799 events landed on other
topics in between. The current per-topic test `900 > 100 + 500` then returns
`gap-needs-resync` and forces a full REST resync **even though no event was
lost**. Under any real cross-topic interleaving this misfires routinely.

**The decision Phase 2 must make — pick one, then make code + docs + gateway agree:**

1. **`seq` stays per-tenant-global.** Then the "am I behind?" signal must be a
   **per-tenant high-water mark** (from the heartbeat's tenant `seq`), not a
   per-topic delta. Per-topic tracking is only for _ordering/resume position_, and
   the resync trigger is `tenantHighWater - clientTenantHighWater > maxGap` or
   "the Redis Stream no longer holds my position" (retention-based), not an
   arithmetic per-topic delta.
2. **`seq` becomes per-topic-monotonic** (contiguous within a topic). Then the
   current per-topic `prevSeq + maxSeqGap` test is correct, but the outbox
   dispatcher / stream publisher must allocate `seq` per topic, and §13–14 +
   `RealtimeEvent.seq` doc must be updated to say "per topic".

**Recommendation to evaluate first:** option 1 (keep `seq` per-tenant — it matches
the single-Redis-Stream-per-tenant design in §13–14) and drive resync off
retention position + the heartbeat high-water mark, not a per-topic arithmetic gap.
Retire `maxSeqGap` as the primary trigger.

## F9 — `stale` path does not advance the topic seq mark

**Observation.** `EventReducer.offer` returns `stale` when
`e.resourceVersion <= prevVersion` (an out-of-order/older update for a resource).
It records the `eventId` (so a later duplicate is caught) but **does not update
`lastSeqByTopic`**, even when the stale event's `seq` is _higher_ than the current
per-topic mark. A subsequent in-order event can then satisfy
`e.seq > prevSeq + maxSeqGap` against a stale-lagging `prevSeq` and trigger a
**false `gap-needs-resync`**.

**The decision Phase 2 must make:** separate the two concerns explicitly —

- **stream position** (`lastSeqByTopic`, or the per-tenant high-water mark):
  advance it for **every accepted-from-the-stream event**, including ones whose
  resource-level effect is `stale`/`duplicate`. Seeing an event ≠ applying its
  payload.
- **resource state** (`versionByResource`): advance only on a genuine newer
  `resourceVersion`.
  A `stale`/`duplicate` result should still move the position marker forward
  (position = "how far down the stream I've consumed"), so it never feeds a false
  gap. This interacts with whichever F8 option is chosen.

## Acceptance for Phase 2

The Phase 2 realtime suite (TESTING-STRATEGY: "resume-from-seq; dedup;
out-of-order; reconnect after retention gap → resync") must include:

- normal cross-topic interleaving over a long run → **zero** false
  `gap-needs-resync` (covers F8);
- a reordered delivery where a higher-`seq` message carries a lower
  `resourceVersion`, followed by an in-order event → **no** false resync
  (covers F9);
- a genuine retention-gap reconnect → resync **is** triggered.
