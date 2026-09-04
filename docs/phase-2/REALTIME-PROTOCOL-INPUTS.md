# Phase 2 — realtime protocol design inputs

> Recorded 2026-09-03 from the post-Phase-0 ultra-review (findings **F8**, **F9**).
> These are **not bugs to hot-fix in Phase 0** — `packages/realtime-client` is a
> Phase 0 seed whose transport and wire protocol are specified and built in
> **Phase 2** (ROADMAP "Phase 2 — realtime core"). They are captured here so the
> Phase 2 protocol work resolves them deliberately rather than rediscovering them.
>
> Nothing consumes `EventReducer` / `ResumeTracker` at runtime yet, so there is no
> live defect.
>
> **Status (2026-09-04):** the protocol is now designed —
> [`../decisions/ADR-0017.md`](../decisions/ADR-0017.md) (Phase 2-core Task 2.0).
> See **"Resolution — ADR-0017"** below. The seed's doc comments are aligned in
> Task 2.0; the `EventReducer` **logic** is rewritten in Task 2.6 against the
> frozen acceptance suite.

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

## Resolution — ADR-0017 (2026-09-04, Phase 2-core Task 2.0; clarified 2026-09-04)

The owner's Phase 2-core decisions (OD-P2-3, OD-P2-4, constraint FC-1) and the
2026-09-04 clarification resolve F8 and F9. Full detail in
[`../decisions/ADR-0017.md`](../decisions/ADR-0017.md); the F8/F9 analysis above is
retained as the record of the problem.

**F8 — `seq` is never an "am I behind?" input, at any granularity.** `seq` stays
**per-tenant-global** and is used for logical ordering / diagnostics only. The
**Redis Stream entry ID / retained-stream position is the single correctness basis
for resume and retention-gap detection.** Resync is triggered **only** when the
client's **scanned Stream cursor** falls below the stream's first retained entry.
There is **no** resync from `tenantHighWaterSeq − clientLastSeq`, no per-topic
`seq` delta, no `DEFAULT_MAX_SEQ_GAP` — a tenant-global `seq` is advanced by
unrelated branch/topic activity, so any arithmetic distance check would re-create
F8. The heartbeat may carry the current Stream tail ID **and** an informational
tenant high-water `seq`, but resync eligibility is `scannedCursor` vs
`XINFO STREAM` first-id, never arithmetic distance.

**Scanned vs applied cursor.** A client subscribed to a subset of topics still
advances a **scanned Stream cursor** across **every** stream entry the gateway
reads on its behalf — including entries for topics it is not subscribed to and
entries whose payload is filtered out. So unrelated tenant activity (a burst on
another branch) never leaves the client permanently behind: its scanned cursor
tracks the stream tail even while it receives zero payloads. The gateway filters
_payload delivery_, not _cursor advancement_, and reports the scanned cursor in
each frame + the heartbeat.

**F9 — stale path.** Scanned cursor and resource state are separated: the
**scanned cursor advances for every event read from the stream**, including
`duplicate` / `stale` / not-for-me results; `versionByResource` advances only on a
genuinely newer `resourceVersion`. A `stale` event can therefore never feed a
false gap.

**`seq` immutability (FC-1).** `seq` (and `event_id`) are assigned once by the
dispatcher, persisted to the `outbox` row before `XADD`, and reused verbatim on any
crash-induced republish.

**Fanout (OD-P2-4).** `outbox → durable Stream per tenant → relay → Redis Pub/Sub
→ every gateway instance`. A consumer group is never the socket-broadcast path.
Live delivery is at-least-once; duplicates are suppressed by `event_id`.

The Phase-0 seed (`packages/realtime-client/src/index.ts`) is updated to match:
the `RealtimeEvent`/`EventReducer` **doc comments** in Task 2.0 (this task), the
**reducer logic** in Task 2.6.

## Acceptance for Phase 2 (frozen — the CI `realtime` job, tasks 2.5 / 2.6)

1. **F8** — normal cross-topic interleaving over a long run (per-topic `seq`
   deltas of hundreds) → **zero** false `gap-needs-resync`.
2. **F9** — a reordered delivery where a higher-`seq` message carries a lower
   `resourceVersion` (result `stale`), followed by an in-order event → **no**
   false resync; the scanned cursor advanced past the stale event.
3. **Unrelated-tenant-activity, no false resync (owner clarification).** Client
   subscribed **only** to branch A; thousands of events for **branch B**; branch A
   receives **none**; heartbeat tenant high-water advances greatly →
   - **no** full resync;
   - the client's **scanned Stream cursor advances** to ≈ the stream tail despite
     zero delivered payloads;
   - a reconnect **within retention** resumes correctly from the scanned cursor;
   - **no `tenantHighWaterSeq − clientLastSeq` comparison exists in any path.**
4. **Retention gap** — a client reconnecting with a scanned cursor below the
   stream's retained floor (genuinely offline > retention) → resync **is**
   triggered; afterwards its scanned cursor is the current stream tail.
5. **Within-retention reconnect** — a client disconnects, N events land, it
   reconnects with its stored scanned cursor → it receives exactly those N
   authorized events, in order, none applied twice.
6. **FC-1** — kill the dispatcher between `XADD` and the `dispatched_at` update →
   on restart the row republishes → both stream entries carry the **identical
   `event_id` and `seq`**; the reducer applies it once.
7. **Multi-gateway fanout (≥ 2 instances)** — a client on each gateway instance,
   both authorized for the same branch, both receive the same event.
8. **Isolation** — a branch-X client never receives a branch-Y event; a tenant-B
   client never receives a tenant-A event; a client cannot subscribe to an
   arbitrary topic string; a scope-narrowing token refresh stops the
   now-unauthorized topic.
9. **Revocation** — session revoke closes the socket on **every** gateway
   instance in < 5s.
10. **Fault injection** — kill the gateway / dispatcher / relay / Redis connection
    mid-stream → the client reconnects and converges to the REST-authoritative
    state.
