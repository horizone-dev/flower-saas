import type { Redis } from 'ioredis';
import { liveChannel, revokeChannel, type SessionData } from '@flower/backend';
import { isAuthorized, type RelayedEnvelope } from '../auth/topics.js';
import { RecentEventIds } from './dedup.js';

/** The minimum a WebSocket connection needs to support — deliberately not the
 *  full `ws`/Fastify type, so this file stays easy to unit-test with a fake. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Connection {
  readonly socket: GatewaySocket;
  session: SessionData;
}

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
 */
export class GatewayHub {
  private readonly byTenant = new Map<string, Set<Connection>>();
  private readonly bySession = new Map<string, Set<Connection>>();
  private readonly dedupByTenant = new Map<string, RecentEventIds>();
  private readonly subscriber: Redis;

  constructor(subscriber: Redis) {
    this.subscriber = subscriber;
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

  /** Every `rt:live:{tenantId}` message the relay publishes carries the trusted
   *  envelope verbatim (task 2.4 dispatcher → task 2.5 relay, never re-derived
   *  along the way) — dedup by `event_id` once per tenant, then deliver to
   *  every locally-connected, authorized socket for that tenant. */
  private deliverLive(tenantId: string, raw: string): void {
    const conns = this.byTenant.get(tenantId);
    if (!conns || conns.size === 0) return;

    let envelope: RelayedEnvelope;
    try {
      envelope = JSON.parse(raw) as RelayedEnvelope;
    } catch {
      return; // malformed — never crash the gateway over one bad message
    }

    const eventId = typeof envelope['event_id'] === 'string' ? envelope['event_id'] : undefined;
    if (eventId !== undefined) {
      const dedup = this.dedupByTenant.get(tenantId);
      if (dedup && !dedup.offer(eventId)) return; // a duplicate live delivery — drop
    }

    for (const conn of conns) {
      if (isAuthorized(conn.session, envelope)) {
        // Nested, never flattened: the envelope carries its own `type` field
        // (the domain event type, e.g. "tenant.provisioned") that would
        // otherwise silently collide with — and overwrite — this WS
        // message's own wrapper `type: 'event'` under a flat spread.
        conn.socket.send(JSON.stringify({ type: 'event', event: envelope }));
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
    const conn: Connection = { socket, session };
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
   * either (not expected in current practice, but never assumed).
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
