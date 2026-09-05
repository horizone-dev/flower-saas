import type { Redis } from 'ioredis';
import { liveChannel, revokeChannel, streamKey, type SessionData } from '@flower/backend';
import { isAuthorized, type RelayedEnvelope } from '../auth/topics.js';
import { RecentEventIds } from './dedup.js';
import { compareStreamIds, isValidStreamId, STREAM_ID_ZERO } from './cursor.js';

/** The minimum a WebSocket connection needs to support — deliberately not the
 *  full `ws`/Fastify type, so this file stays easy to unit-test with a fake. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** A buffered live event, held for a connection mid-replay (task 2.6's
 *  race-free handoff) until the replay-to-live transition drains it. */
interface BufferedLive {
  readonly cursor: string;
  readonly envelope: RelayedEnvelope;
}

export interface Connection {
  readonly socket: GatewaySocket;
  session: SessionData;
  /** `true` from the moment a `resume` call starts snapshotting the replay
   *  boundary until it finishes draining the buffer below — while `true`,
   *  `deliverLive` buffers instead of delivering *for this connection only*
   *  (task 2.6 race-free replay→live handoff). */
  replaying: boolean;
  liveBuffer: BufferedLive[];
}

export type ResumeOutcome =
  | { readonly type: 'resumed'; readonly cursor: string }
  | { readonly type: 'resync-required'; readonly cursor: string }
  | { readonly type: 'error'; readonly code: 'INVALID_CURSOR'; readonly message: string };

export interface ResumeOptions {
  /** entries fetched (and re-authorized) per `XRANGE` round trip. Small in
   *  tests to force a real yield point between every entry — see
   *  `handoff-race.integration.test.ts`. */
  readonly chunkSize?: number;
  /** called between chunks, after the yield-to-event-loop — a test hook, so a
   *  concurrent `refresh_token` (or any other queued socket message) can be
   *  proven to land deterministically mid-replay, not by timing luck. */
  readonly onYield?: () => void | Promise<void>;
}

const DEFAULT_RESUME_CHUNK_SIZE = 200;

/**
 * Per-gateway-instance socket registry + Redis Pub/Sub fanout (ADR-0017 §4/§9,
 * SECURITY.md "Realtime" row). One instance per running `apps/realtime`
 * process. Holds **no** business logic — only topic authorization
 * (tenant + branch, via `isAuthorized`) and delivery.
 *
 * `SUBSCRIBE`s to a tenant's `rt:live:{tenantId}` channel only while this
 * instance holds ≥1 socket for that tenant, and to a session's
 * `rt:revoke:{sessionId}` channel only while this instance holds ≥1 socket for
 * that session — both exactly matching ADR-0017 §4/§9's "each SUBSCRIBEs for
 * tenants/sessions it holds sockets for".
 *
 * Task 2.6 adds `resume()` — the race-free replay→live handoff. Two Redis
 * connections are required: `subscriber` (Pub/Sub only, as in task 2.5) and
 * `commands` (plain request/response — `XRANGE`/`XINFO STREAM` for replay;
 * these cannot share a connection with `subscriber` once it is in
 * subscriber mode).
 */
export class GatewayHub {
  private readonly byTenant = new Map<string, Set<Connection>>();
  private readonly bySession = new Map<string, Set<Connection>>();
  private readonly dedupByTenant = new Map<string, RecentEventIds>();
  private readonly subscriber: Redis;
  private readonly commands: Redis;
  private readonly resumeDefaults: ResumeOptions;

  /**
   * `resumeDefaults` is deliberately **not** reachable from the wire protocol
   * (a client can never influence its own chunk size or yield timing) — it
   * exists so a test can deterministically control the replay loop's pacing
   * (a small `chunkSize` + an `onYield` hook the test itself gates), instead
   * of relying on real network timing to *maybe* land a concurrent
   * `refresh_token` mid-replay. Production callers omit it.
   */
  constructor(subscriber: Redis, commands: Redis, resumeDefaults: ResumeOptions = {}) {
    this.subscriber = subscriber;
    this.commands = commands;
    this.resumeDefaults = resumeDefaults;
    this.subscriber.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });
  }

  private handleMessage(channel: string, message: string): void {
    if (channel.startsWith('rt:live:')) {
      this.deliverLive(channel.slice('rt:live:'.length), message);
    } else if (channel.startsWith('rt:revoke:')) {
      this.handleRevoke(channel.slice('rt:revoke:'.length), message);
    }
  }

  /**
   * Every `rt:live:{tenantId}` message the task 2.6 relay publishes is a
   * `{cursor, event}` transport wrapper — the Redis Stream entry id
   * alongside the trusted envelope verbatim (task 2.4 dispatcher → task 2.5
   * relay → here, never re-derived along the way). Dedup by `event_id` once
   * per tenant (suppresses a relay-restart re-publish for every socket at
   * once), then deliver to every locally-connected, authorized socket for
   * that tenant — **except** a socket mid-replay, which buffers instead
   * (task 2.6 race-free handoff, see `resume()`).
   *
   * A socket that does **not** get the payload (filtered by
   * `isAuthorized`, or a not-yet-mature `dedup.offer`) still needs its
   * scanned position to move — ADR-0017 §6a: "the gateway... advances the
   * scanned cursor... reports it in every frame". So an unauthorized entry
   * still gets a lightweight `heartbeat` frame carrying the cursor, never
   * silently nothing (hard gate #13 — isolation must not strand a cursor).
   */
  private deliverLive(tenantId: string, raw: string): void {
    const conns = this.byTenant.get(tenantId);
    if (!conns || conns.size === 0) return;

    let wrapper: { cursor?: unknown; event?: unknown };
    try {
      wrapper = JSON.parse(raw) as { cursor?: unknown; event?: unknown };
    } catch {
      return; // malformed — never crash the gateway over one bad message
    }
    const cursor = typeof wrapper.cursor === 'string' ? wrapper.cursor : null;
    const envelope = wrapper.event as RelayedEnvelope | undefined;
    if (cursor === null || envelope === undefined || typeof envelope !== 'object') return;

    const eventId = typeof envelope['event_id'] === 'string' ? envelope['event_id'] : undefined;
    if (eventId !== undefined) {
      const dedup = this.dedupByTenant.get(tenantId);
      if (dedup && !dedup.offer(eventId)) return; // a duplicate live delivery — drop
    }

    for (const conn of conns) {
      if (conn.replaying) {
        conn.liveBuffer.push({ cursor, envelope });
        continue;
      }
      if (isAuthorized(conn.session, envelope)) {
        // Nested, never flattened: the envelope carries its own `type` field
        // (the domain event type, e.g. "tenant.provisioned") that would
        // otherwise silently collide with — and overwrite — this WS
        // message's own wrapper `type: 'event'` under a flat spread.
        conn.socket.send(JSON.stringify({ type: 'event', cursor, event: envelope }));
      } else {
        conn.socket.send(JSON.stringify({ type: 'heartbeat', cursor }));
      }
    }
  }

  /** Revocation (<5s gate, ADR-0017 §9): close every socket this instance
   *  holds for the revoked session. */
  private handleRevoke(sessionId: string, reason: string): void {
    const conns = this.bySession.get(sessionId);
    if (!conns) return;
    for (const conn of [...conns]) {
      conn.socket.send(JSON.stringify({ type: 'revoked', reason }));
      conn.socket.close(4001, 'session revoked');
    }
  }

  /**
   * Register a newly-authenticated socket. Call once, right after a
   * successful `SessionAuthenticator.authenticate`, and **await** it before
   * telling the client it is connected (an `ack`) — `SUBSCRIBE` must actually
   * complete on the wire first, or an event published in the tiny window
   * between "authenticated" and "subscribed" would be silently missed (Redis
   * Pub/Sub never queues for a not-yet-subscribed client). This was a real
   * race found by this module's own integration suite, not a theoretical one.
   */
  async register(session: SessionData, socket: GatewaySocket): Promise<Connection> {
    if (session.tenantId === null) {
      throw new Error('GatewayHub.register: a tenant-realm session is required (tenantId is null)');
    }
    const conn: Connection = { socket, session, replaying: false, liveBuffer: [] };
    await this.addToTenant(session.tenantId, conn);
    await this.addToSession(session.sessionId, conn);
    return conn;
  }

  /** Call on socket close (client-initiated or a revoke-triggered close). */
  unregister(conn: Connection): void {
    if (conn.session.tenantId !== null) this.removeFromTenant(conn.session.tenantId, conn);
    this.removeFromSession(conn.session.sessionId, conn);
  }

  /**
   * Re-run authorization for an already-connected socket with a freshly
   * verified session (ADR-0017 §9 — "re-run on every ... token refresh").
   * Delivery always checks `isAuthorized` against the connection's *current*
   * `session` (never a cached topic list), so a narrower `branchScope` here
   * stops unauthorized delivery on the very next live event — no separate
   * "unsubscribe" step is needed for that guarantee. Tenant/session channel
   * membership is still migrated defensively, in case a refresh ever changes
   * either (not expected in current practice, but never assumed). This same
   * mutation of `conn.session` is what `resume()`'s mid-replay authorization
   * re-checks observe (task 2.6 requirement: scope narrowing during replay
   * stops delivery immediately).
   */
  async reauthorize(conn: Connection, newSession: SessionData): Promise<void> {
    if (newSession.tenantId === null) {
      throw new Error(
        'GatewayHub.reauthorize: a tenant-realm session is required (tenantId is null)',
      );
    }
    const tenantChanged = newSession.tenantId !== conn.session.tenantId;
    const sessionChanged = newSession.sessionId !== conn.session.sessionId;

    if (tenantChanged && conn.session.tenantId !== null) {
      this.removeFromTenant(conn.session.tenantId, conn);
    }
    if (sessionChanged) this.removeFromSession(conn.session.sessionId, conn);

    conn.session = newSession;

    if (tenantChanged) await this.addToTenant(newSession.tenantId, conn);
    if (sessionChanged) await this.addToSession(newSession.sessionId, conn);
  }

  /**
   * Resume a connection from its persisted scanned cursor (task 2.6,
   * ADR-0017 §3/§6a-c/§7). `XRANGE`/`XINFO STREAM` are **always** issued
   * against `rt:stream:{conn.session.tenantId}` — the authenticated tenant,
   * never a client-supplied value (CURSOR RULES, "no client-supplied
   * tenant/branch/topic may influence Stream selection").
   *
   * - no cursor (first connection) → `resync-required` with the current
   *   tail; **never** replay an arbitrary historical Stream to a new client
   *   (CURSOR RULE #8).
   * - a syntactically invalid cursor → `error` (CURSOR RULE #4 — "rejected",
   *   distinct from the recovery-path `resync-required` responses below).
   * - a cursor **ahead of** the current tail → `resync-required` with the
   *   tail (CURSOR RULE #5 — never silently accepted).
   * - a cursor **below** the retained floor → `resync-required` with the
   *   tail (CURSOR RULE #6).
   * - a cursor within retention → the race-free replay→live handoff below,
   *   then `resumed` with the boundary reached (CURSOR RULE #7).
   *
   * **Race-free replay→live handoff.** By the time `resume` is called the
   * socket is already `register()`ed — i.e. already `SUBSCRIBE`d to
   * `rt:live:{tenantId}` (step 1-2 of the required algorithm are already
   * done by `register()`). This method:
   *   3. snapshots the current tail as the replay boundary;
   *   4. `XRANGE (cursor boundary`, in chunks, each chunk re-authorized
   *      against `conn.session` **as it is at that moment** — a yield point
   *      between chunks (`onYield`, default a real event-loop tick) is where
   *      a concurrent `refresh_token` message is processed and mutates
   *      `conn.session` (see `reauthorize`), so a scope change genuinely
   *      takes effect between chunks, not just in theory;
   *   5. the scanned cursor advances for every entry scanned, whether
   *      delivered or filtered (`deliveredDuringReplay` only gates
   *      duplicate suppression, not cursor advancement — the final
   *      `resumed` cursor is the boundary itself, reached regardless of
   *      filtering);
   *   6. (folded into 4 — authorization is re-checked per entry, not cached);
   *   7. any live event `deliverLive` buffered *for this connection* while
   *      `replaying` was `true` is drained here, skipping anything already
   *      delivered during replay (by `event_id`) and re-authorizing against
   *      the current session;
   *   8. `replaying` is cleared — the connection is back to normal live
   *      delivery, exactly where the buffer left off (no gap, no double
   *      delivery — proven by `handoff-race.integration.test.ts`, which
   *      publishes a live event to the tenant's Stream at the exact moment
   *      between the boundary snapshot and the buffer drain).
   */
  async resume(
    conn: Connection,
    rawCursor: string | null | undefined,
    opts: ResumeOptions = {},
  ): Promise<ResumeOutcome> {
    const tenantId = conn.session.tenantId;
    if (tenantId === null) {
      throw new Error('GatewayHub.resume: a tenant-realm session is required (tenantId is null)');
    }
    const key = streamKey(tenantId);

    if (rawCursor === null || rawCursor === undefined || rawCursor === '') {
      const { tail } = await this.streamBounds(key);
      return { type: 'resync-required', cursor: tail };
    }
    if (!isValidStreamId(rawCursor)) {
      return { type: 'error', code: 'INVALID_CURSOR', message: 'cursor is not a valid Stream id' };
    }

    const { tail, floor } = await this.streamBounds(key);

    if (compareStreamIds(rawCursor, tail) > 0) {
      return { type: 'resync-required', cursor: tail }; // ahead of the tail — never silently accepted
    }
    if (floor !== null && compareStreamIds(rawCursor, floor) < 0) {
      return { type: 'resync-required', cursor: tail }; // below the retained floor
    }

    return this.replayThenHandoff(conn, key, rawCursor, tail, { ...this.resumeDefaults, ...opts });
  }

  private async replayThenHandoff(
    conn: Connection,
    key: string,
    rawCursor: string,
    boundary: string,
    opts: ResumeOptions,
  ): Promise<ResumeOutcome> {
    const chunkSize = opts.chunkSize ?? DEFAULT_RESUME_CHUNK_SIZE;
    const deliveredDuringReplay = new Set<string>();

    conn.replaying = true;
    conn.liveBuffer = [];

    try {
      let from = rawCursor;
      for (;;) {
        const batch = (await this.commands.xrange(
          key,
          `(${from}`,
          boundary,
          'COUNT',
          chunkSize,
        )) as [string, string[]][];
        if (batch.length === 0) break;

        for (const [id, fields] of batch) {
          from = id;
          const envelope = parseEnvelopeFields(fields);
          if (envelope && isAuthorized(conn.session, envelope)) {
            deliverOnce(conn, deliveredDuringReplay, id, envelope);
          }
        }

        const exhausted = batch.length < chunkSize;
        if (exhausted) break;
        await yieldToEventLoop();
        await opts.onYield?.();
      }
    } finally {
      // Drain whatever `deliverLive` buffered for this connection while it
      // was replaying — re-authorized against the CURRENT session (a
      // refresh during replay applies here too), deduped against what
      // replay already delivered. Always runs, even if the loop above
      // throws, so a connection is never left permanently stuck buffering.
      for (const buffered of conn.liveBuffer) {
        if (deliveredDuringReplay.has(buffered.envelope['event_id'] as string)) continue;
        if (isAuthorized(conn.session, buffered.envelope)) {
          deliverOnce(conn, deliveredDuringReplay, buffered.cursor, buffered.envelope);
        }
      }
      conn.liveBuffer = [];
      conn.replaying = false;
    }

    return { type: 'resumed', cursor: boundary };
  }

  /** `XINFO STREAM` — the tail (`last-generated-id`) and the retained floor
   *  (`recorded-first-entry-id`, `null` if the stream is empty or does not
   *  exist yet). Never throws on a not-yet-created stream (a tenant with no
   *  outbox activity yet) — that is simply an empty stream at `0-0`. */
  private async streamBounds(key: string): Promise<{ tail: string; floor: string | null }> {
    let raw: unknown[];
    try {
      raw = (await this.commands.call('XINFO', 'STREAM', key)) as unknown[];
    } catch {
      return { tail: STREAM_ID_ZERO, floor: null };
    }
    const info = new Map<string, unknown>();
    for (let i = 0; i + 1 < raw.length; i += 2) info.set(raw[i] as string, raw[i + 1]);
    const tail =
      typeof info.get('last-generated-id') === 'string'
        ? (info.get('last-generated-id') as string)
        : STREAM_ID_ZERO;
    const length = Number(info.get('length') ?? 0);
    const floor =
      length > 0 && typeof info.get('recorded-first-entry-id') === 'string'
        ? (info.get('recorded-first-entry-id') as string)
        : null;
    return { tail, floor };
  }

  /** Test/observability helper — how many tenant / session channels this
   *  instance currently holds a live subscription for. */
  get subscribedTenantCount(): number {
    return this.byTenant.size;
  }
  get subscribedSessionCount(): number {
    return this.bySession.size;
  }

  private async addToTenant(tenantId: string, conn: Connection): Promise<void> {
    let set = this.byTenant.get(tenantId);
    if (!set) {
      set = new Set();
      this.byTenant.set(tenantId, set);
      this.dedupByTenant.set(tenantId, new RecentEventIds());
      await this.subscriber.subscribe(liveChannel(tenantId));
    }
    set.add(conn);
  }

  private async addToSession(sessionId: string, conn: Connection): Promise<void> {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
      await this.subscriber.subscribe(revokeChannel(sessionId));
    }
    set.add(conn);
  }

  private removeFromTenant(tenantId: string, conn: Connection): void {
    const set = this.byTenant.get(tenantId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.byTenant.delete(tenantId);
      this.dedupByTenant.delete(tenantId);
      // fire-and-forget: unsubscribing late is harmless (delivery is already
      // gated on `byTenant`, updated synchronously above) — and by the time
      // this runs (socket close) the connection may already be tearing down.
      this.subscriber.unsubscribe(liveChannel(tenantId)).catch(() => {});
    }
  }

  private removeFromSession(sessionId: string, conn: Connection): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.bySession.delete(sessionId);
      this.subscriber.unsubscribe(revokeChannel(sessionId)).catch(() => {});
    }
  }
}

function parseEnvelopeFields(fields: string[]): RelayedEnvelope | null {
  const idx = fields.indexOf('event');
  if (idx < 0) return null;
  const raw = fields[idx + 1];
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as RelayedEnvelope;
  } catch {
    return null;
  }
}

function deliverOnce(
  conn: Connection,
  deliveredDuringReplay: Set<string>,
  cursor: string,
  envelope: RelayedEnvelope,
): void {
  const eventId = typeof envelope['event_id'] === 'string' ? envelope['event_id'] : undefined;
  if (eventId !== undefined) {
    if (deliveredDuringReplay.has(eventId)) return;
    deliveredDuringReplay.add(eventId);
  }
  conn.socket.send(JSON.stringify({ type: 'event', cursor, event: envelope }));
}

/** A macrotask-based yield — lets any already-arrived-but-not-yet-dispatched
 *  socket 'message' event (a concurrent `refresh_token`, most notably) run
 *  before the next replay chunk starts. A microtask-only yield
 *  (`Promise.resolve()`) is not sufficient: WS frame parsing is I/O-driven. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
