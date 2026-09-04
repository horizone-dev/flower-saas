/**
 * Realtime Redis key/channel naming (task 2.4 / 2.5, ADR-0017 §3–4, §9).
 *
 * Shared here — not duplicated in `apps/worker` (the dispatcher + relay,
 * publishers) and `apps/realtime` (the gateway, subscriber) — because those two
 * processes must agree on the exact same channel string without importing from
 * each other (that cross-app import is exactly what `@flower/backend` exists to
 * avoid, FC-3). Every name here is on the **unprefixed** realtime Redis
 * connection (`@flower/service-runtime`'s `createRedis`) in every process —
 * deliberately a *different* connection/convention from session storage's
 * `flower:`-`keyPrefix`'d connection (see `redis-session-store.ts`'s doc
 * comment for why the two must never be conflated).
 */

/** The durable per-tenant Redis Stream the task 2.4 dispatcher `XADD`s to and
 *  the task 2.5 relay `XREADGROUP`s from. Kept here as the canonical name;
 *  `apps/worker/src/outbox/envelope.ts`'s `streamKey` is the same string —
 *  not re-pointed at this export because the outbox dispatcher predates this
 *  module and nothing outside `apps/worker` needs `streamKey` (only the relay,
 *  in the same app, does), whereas `liveChannel` genuinely crosses the
 *  worker/realtime process boundary. */
export function streamKey(tenantId: string): string {
  return `rt:stream:${tenantId}`;
}

/** The Redis Pub/Sub channel the task 2.5 relay `PUBLISH`es a tenant's live
 *  events to; every gateway instance `SUBSCRIBE`s to it only while it holds at
 *  least one live socket for that tenant (OI-P2-4 — per-tenant granularity,
 *  owner-approved 2026-09-04; each gateway instance filters delivery to a
 *  socket's authorized branch/resource scope **locally**, after receiving the
 *  trusted envelope — never by asking Redis to filter). */
export function liveChannel(tenantId: string): string {
  return `rt:live:${tenantId}`;
}

/** The Redis Pub/Sub channel a gateway instance `SUBSCRIBE`s to for exactly one
 *  live session, so a revoke (`RedisSessionStore.revoke`) closes that session's
 *  socket(s) on every gateway instance holding one, within the <5s gate. */
export function revokeChannel(sessionId: string): string {
  return `rt:revoke:${sessionId}`;
}
