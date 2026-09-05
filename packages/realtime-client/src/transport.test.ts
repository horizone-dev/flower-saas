import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RealtimeClient,
  inMemoryCursorStore,
  type RealtimeClientOptions,
  type WebSocketLike,
  type WireEnvelope,
} from './transport.js';

/** A fully test-controllable fake of the standard `WebSocket` surface. */
class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  private listeners: Record<string, Array<(...a: never[]) => void>> = {};

  addEventListener(type: string, listener: (...a: never[]) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.emit('close');
  }

  emit(type: string, data?: unknown): void {
    for (const l of this.listeners[type] ?? []) l(data as never);
  }

  emitMessage(msg: unknown): void {
    this.emit('message', { data: JSON.stringify(msg) });
  }
}

function envelope(over: Partial<WireEnvelope> = {}): WireEnvelope {
  return {
    event_id: 'e1',
    seq: '1',
    tenant_id: 't1',
    branch_id: 'b1',
    type: 'order.updated',
    resource_type: 'order',
    resource_id: 'o1',
    resource_version: '1',
    occurred_at: '2026-09-03T00:00:00Z',
    ...over,
  };
}

describe('RealtimeClient', () => {
  let sockets: FakeWebSocket[] = [];
  afterEach(() => {
    sockets = [];
    vi.useRealTimers();
  });

  function build(overrides: Partial<RealtimeClientOptions> = {}) {
    const events: unknown[] = [];
    const resyncs: number[] = [];
    const revocations: string[] = [];
    const cursorStore = inMemoryCursorStore();
    const client = new RealtimeClient({
      url: 'ws://example.invalid/ws',
      getToken: () => 'tok',
      cursorStore,
      onEvent: (e) => events.push(e),
      onResyncRequired: () => {
        resyncs.push(1);
      },
      onRevoked: (reason) => revocations.push(reason),
      createWebSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      ...overrides,
    });
    return { client, events, resyncs, revocations, cursorStore };
  }

  it('sends resume with the persisted cursor once the server acks', async () => {
    const { client, cursorStore } = build();
    await cursorStore.set('100-0');
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({ type: 'ack', tenantId: 't1', branchScope: 'ALL' });
    await flush();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resume', cursor: '100-0' })]);
    await client.stop();
  });

  it('sends resume with cursor null when nothing is persisted yet (first connection)', async () => {
    const { client } = build();
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({ type: 'ack' });
    await flush();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resume', cursor: null })]);
    await client.stop();
  });

  it('applies an event frame, calls onEvent, and persists the frame cursor', async () => {
    const { client, events, cursorStore } = build();
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({ type: 'event', cursor: '200-0', event: envelope({ event_id: 'a' }) });
    await flush();
    expect(events).toHaveLength(1);
    expect(await cursorStore.get()).toBe('200-0');
    await client.stop();
  });

  it('a duplicate event_id is not re-applied, but the cursor still advances (F9 semantics)', async () => {
    const { client, events, cursorStore } = build();
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({ type: 'event', cursor: '200-0', event: envelope({ event_id: 'a' }) });
    ws.emitMessage({ type: 'event', cursor: '201-0', event: envelope({ event_id: 'a' }) });
    await flush();
    expect(events).toHaveLength(1); // applied exactly once
    expect(await cursorStore.get()).toBe('201-0'); // scanned position still advanced
    await client.stop();
  });

  it('a heartbeat frame persists the cursor without calling onEvent', async () => {
    const { client, events, cursorStore } = build();
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({ type: 'heartbeat', cursor: '300-0' });
    await flush();
    expect(events).toHaveLength(0);
    expect(await cursorStore.get()).toBe('300-0');
    await client.stop();
  });

  it('resync-required resets the reducer, runs the REST bootstrap, then persists the given tail', async () => {
    const { client, events, resyncs, cursorStore } = build();
    client.start();
    await flush();
    const ws = sockets[0]!;

    // establish a resource version high-water mark
    ws.emitMessage({
      type: 'event',
      cursor: '1-0',
      event: envelope({ event_id: 'a', resource_version: '5' }),
    });
    await flush();
    expect(events).toHaveLength(1);

    ws.emitMessage({ type: 'resync-required', cursor: '999-0' });
    await flush();
    expect(resyncs).toHaveLength(1);
    expect(await cursorStore.get()).toBe('999-0');

    // after reset, an OLDER version for the same resource is no longer
    // "stale" against a forgotten mark — REST is authoritative now.
    ws.emitMessage({
      type: 'event',
      cursor: '1000-0',
      event: envelope({ event_id: 'b', resource_version: '2' }),
    });
    await flush();
    expect(events).toHaveLength(2);
    await client.stop();
  });

  it('an error response clears the persisted cursor so the next attempt starts clean', async () => {
    const { client, cursorStore } = build();
    await cursorStore.set('bad-cursor-value');
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({ type: 'error', code: 'INVALID_CURSOR', message: 'nope' });
    await flush();
    expect(await cursorStore.get()).toBeNull();
    await client.stop();
  });

  it('a revoked frame notifies the consumer', async () => {
    const { client, revocations } = build();
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({ type: 'revoked', reason: 'session revoked' });
    await flush();
    expect(revocations).toEqual(['session revoked']);
    await client.stop();
  });

  it('reconnects with backoff after a close, and stop() prevents it', async () => {
    vi.useFakeTimers();
    const { client } = build({ reconnect: { baseMs: 100, maxMs: 200 } });
    client.start();
    await flush();
    expect(sockets).toHaveLength(1);

    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets.length).toBeGreaterThanOrEqual(2); // reconnected

    await client.stop();
    const countAfterStop = sockets.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets.length).toBe(countAfterStop); // no further reconnect after stop()
  });

  it('coalesces repeated applied events for the same resource within the debounce window', async () => {
    vi.useFakeTimers();
    const { client, events } = build({ coalesceMs: 50 });
    client.start();
    await flush();
    const ws = sockets[0]!;
    ws.emitMessage({
      type: 'event',
      cursor: '1-0',
      event: envelope({ event_id: 'a', resource_version: '1' }),
    });
    ws.emitMessage({
      type: 'event',
      cursor: '2-0',
      event: envelope({ event_id: 'b', resource_version: '2' }),
    });
    ws.emitMessage({
      type: 'event',
      cursor: '3-0',
      event: envelope({ event_id: 'c', resource_version: '3' }),
    });
    await vi.advanceTimersByTimeAsync(100);
    // three applied updates to the SAME resource, coalesced into one callback
    expect(events).toHaveLength(1);
    await client.stop();
  });
});

/** Flush the microtask queue — every handler above is `async` internally.
 *  Deliberately `queueMicrotask`-based, not `setTimeout`-based: it must keep
 *  working once a test switches to `vi.useFakeTimers()` (which mocks
 *  `setTimeout` but not the microtask queue). */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => queueMicrotask(() => resolve())).then(
    () => new Promise<void>((resolve) => queueMicrotask(() => resolve())),
  );
}
