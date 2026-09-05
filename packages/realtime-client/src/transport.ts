import { EventReducer, reconnectDelayMs, type RealtimeEvent } from './reducer.js';

/** The minimum WebSocket surface this transport needs — matches the standard
 *  `WebSocket` (browser + Node ≥ 22 global) so no runtime dependency is
 *  required, and a fake is trivial to inject for tests. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Where the client persists its scanned Stream cursor — the ONLY correctness
 *  cursor (ADR-0017 §3; CURSOR RULE #1). Implementations: `localStorage`
 *  (web), a file/db row (POS PWA / node), or an in-memory `Map` for tests. */
export interface CursorStore {
  get(): string | null | Promise<string | null>;
  set(cursor: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

export function inMemoryCursorStore(): CursorStore {
  let cursor: string | null = null;
  return {
    get: () => cursor,
    set: (c) => {
      cursor = c;
    },
    clear: () => {
      cursor = null;
    },
  };
}

/** The wire envelope a server `event`/replay frame carries — a structural
 *  mirror of `apps/worker`'s `OutboxEnvelope` (never imported directly; that
 *  cross-package coupling is exactly what the wire protocol exists to
 *  avoid). Field names are the ADR-0017 §3 snake_case wire shape. */
export interface WireEnvelope {
  readonly event_id: string;
  readonly seq: string;
  readonly tenant_id: string;
  readonly branch_id: string | null;
  readonly type: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly resource_version: string | null;
  readonly occurred_at: string;
  readonly [key: string]: unknown;
}

function toRealtimeEvent(e: WireEnvelope): RealtimeEvent {
  return {
    eventId: e.event_id,
    seq: Number(e.seq),
    tenantId: e.tenant_id,
    branchId: e.branch_id,
    type: e.type,
    resourceType: e.resource_type,
    resourceId: e.resource_id,
    resourceVersion: e.resource_version === null ? null : Number(e.resource_version),
    occurredAt: e.occurred_at,
  };
}

export interface RealtimeClientOptions {
  /** the `ws://…/ws` URL, without the token — this transport appends
   *  `?token=` itself so a fresh token from `getToken` is used on every
   *  (re)connect, not a stale one baked into a fixed URL. */
  url: string;
  getToken: () => string | Promise<string>;
  cursorStore: CursorStore;
  /** called for every event the reducer decided to `applied` — payload is
   *  never business truth (ADR-0017 §8): the intended use is "invalidate /
   *  refetch the affected resource over REST", never "trust this payload". */
  onEvent: (event: RealtimeEvent) => void;
  /** the client's REST-authoritative bootstrap/refetch hook, called on
   *  resync — before the transport persists the server-provided tail. */
  onResyncRequired: () => void | Promise<void>;
  onRevoked?: (reason: string) => void;
  onStateChange?: (state: ConnectionState) => void;
  createWebSocket?: (url: string) => WebSocketLike;
  reconnect?: { baseMs?: number; maxMs?: number };
  /** debounces repeated `applied` events for the SAME resource within this
   *  window into a single `onEvent` call — a request-storm guard for a
   *  REST-refetch-on-invalidate consumer (AUTHORITATIVE STATE: "coalesce /
   *  debounce duplicate invalidations where useful"). `0` disables it. */
  coalesceMs?: number;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

const DEFAULT_WS_FACTORY = (url: string): WebSocketLike =>
  new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url);

/**
 * The real WS transport (task 2.6): connect → auth (the token is carried in
 * the URL, matching `apps/realtime`'s `auth/token.ts`) → on `ack`, send
 * `resume` with the persisted cursor → apply `event` frames through the
 * `EventReducer` → on `resync-required`, reset the reducer, run the
 * consumer's REST bootstrap, then persist the server-given tail → reconnect
 * with jittered backoff (`reconnectDelayMs`) on any close.
 */
export class RealtimeClient {
  private readonly reducer = new EventReducer();
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly coalesced = new Map<string, RealtimeEvent>();
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: RealtimeClientOptions) {}

  start(): void {
    this.stopped = false;
    void this.connectOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.ws?.close(1000, 'client stop');
    this.ws = null;
  }

  private async connectOnce(): Promise<void> {
    this.opts.onStateChange?.('connecting');
    const token = await this.opts.getToken();
    const factory = this.opts.createWebSocket ?? DEFAULT_WS_FACTORY;
    const sep = this.opts.url.includes('?') ? '&' : '?';
    const ws = factory(`${this.opts.url}${sep}token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.addEventListener('message', (event) => {
      this.handleMessage(String(event.data));
    });
    ws.addEventListener('close', () => this.handleClose());
    ws.addEventListener('error', () => {
      /* the 'close' event still fires — reconnect is scheduled there */
    });
  }

  private handleClose(): void {
    this.opts.onStateChange?.('closed');
    this.ws = null;
    if (this.stopped) return;
    const delay = reconnectDelayMs(this.attempt, Math.random(), this.opts.reconnect);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => void this.connectOnce(), delay);
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const type = (msg as { type?: unknown }).type;

    switch (type) {
      case 'ack':
        this.attempt = 0;
        this.opts.onStateChange?.('open');
        void this.sendResume();
        return;
      case 'event':
        this.handleEventFrame(msg as { cursor?: unknown; event?: unknown });
        return;
      case 'heartbeat':
        this.persistCursorIfString((msg as { cursor?: unknown }).cursor);
        return;
      case 'resumed':
        this.persistCursorIfString((msg as { cursor?: unknown }).cursor);
        return;
      case 'resync-required':
        void this.handleResyncRequired(msg as { cursor?: unknown });
        return;
      case 'refreshed':
        return; // ack of our own refresh_token — nothing to do here
      case 'revoked':
        this.opts.onRevoked?.(String((msg as { reason?: unknown }).reason ?? ''));
        return;
      case 'error':
        void this.handleError();
        return;
      default:
        return;
    }
  }

  private async sendResume(): Promise<void> {
    const cursor = await this.opts.cursorStore.get();
    this.ws?.send(JSON.stringify({ type: 'resume', cursor }));
  }

  private handleEventFrame(msg: { cursor?: unknown; event?: unknown }): void {
    const cursor = msg.cursor;
    const wire = msg.event as WireEnvelope | undefined;
    if (wire === undefined || typeof wire !== 'object') return;

    const event = toRealtimeEvent(wire);
    const decision = this.reducer.offer(event);
    if (decision === 'applied') this.emitApplied(event);
    // The scanned cursor advances for EVERY scanned entry this frame
    // represents — including `stale`/`duplicate` (F9) — never gated on the
    // reducer's decision.
    this.persistCursorIfString(cursor);
  }

  private emitApplied(event: RealtimeEvent): void {
    const coalesceMs = this.opts.coalesceMs ?? 0;
    if (coalesceMs <= 0) {
      this.opts.onEvent(event);
      return;
    }
    const key = `${event.tenantId}:${event.resourceType}:${event.resourceId}`;
    this.coalesced.set(key, event);
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const pending = [...this.coalesced.values()];
      this.coalesced.clear();
      for (const e of pending) this.opts.onEvent(e);
    }, coalesceMs);
  }

  private async handleResyncRequired(msg: { cursor?: unknown }): Promise<void> {
    this.reducer.reset();
    await this.opts.onResyncRequired();
    this.persistCursorIfString(msg.cursor);
  }

  /** A resume attempt failed (a transient server error, or a cursor the
   *  server rejected outright) — clear the persisted cursor defensively so
   *  the next attempt (this reconnect or the next one) starts from a clean
   *  `null` cursor and gets a normal `resync-required` bootstrap, rather
   *  than looping on the same bad value forever. */
  private async handleError(): Promise<void> {
    await this.opts.cursorStore.clear();
  }

  private persistCursorIfString(cursor: unknown): void {
    if (typeof cursor === 'string') void this.opts.cursorStore.set(cursor);
  }
}
