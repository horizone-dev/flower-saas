import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  JwtService,
  RedisSessionStore,
  SessionAuthenticator,
  streamKey,
  type SessionData,
} from '@flower/backend';
import { createRedis } from '@flower/service-runtime';
import { startTestStack, type TestStack } from '@flower/testing';
import { createSessionRedis } from './auth/redis.js';
import { GatewayHub, type ResumeOptions } from './gateway/hub.js';
import { buildRealtimeApp } from './app.js';

/**
 * Task 2.6 — resume / replay / the race-free replay→live handoff, against
 * **real** Redis (Testcontainers), a real Stream (`XADD` directly — the same
 * shape the task 2.4 dispatcher writes), and real `buildRealtimeApp`
 * instances. `apps/worker`'s relay/dispatcher are never imported here (the
 * relay's own tests already cover it publishing `{cursor, event}`
 * verbatim) — this file's job is the gateway's `resume()` contract:
 * CURSOR RULES #1-#8, the F8/F9 resolution, the race-free handoff, and
 * authorization-during-replay.
 */
describe('realtime gateway resume/replay (integration — Redis)', () => {
  let stack: TestStack;
  let rawRedis: Redis;
  let sessionWriter: RedisSessionStore;
  let jwt: JwtService;
  const apps: FastifyInstance[] = [];
  const sockets: WebSocket[] = [];
  const rawRedisConns: Redis[] = [];

  const BACKEND_CONFIG = {
    NODE_ENV: 'test' as const,
    LOG_LEVEL: 'silent' as const,
    AUTH_JWT_SECRET: 'resume-integration-test-jwt-secret-32chars',
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 600,
  };

  beforeAll(async () => {
    stack = await startTestStack({ services: ['redis'] });
    const url = new URL(stack.redis.url);
    const host = url.hostname;
    const port = Number(url.port);

    rawRedis = createRedis(host, port);
    await rawRedis.connect();
    rawRedisConns.push(rawRedis);

    const writerClient = createSessionRedis(host, port);
    await writerClient.connect();
    rawRedisConns.push(writerClient);
    sessionWriter = new RedisSessionStore(writerClient);
    jwt = new JwtService(BACKEND_CONFIG);
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(rawRedisConns.map((c) => c.quit()));
    await stack?.stop();
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    await Promise.allSettled(apps.splice(0).map((a) => a.close()));
  });

  async function bootGateway(resumeDefaults: ResumeOptions = {}): Promise<{
    app: FastifyInstance;
    port: number;
    commandsClient: Redis;
  }> {
    const url = new URL(stack.redis.url);
    const host = url.hostname;
    const port = Number(url.port);

    const sessionClient = createSessionRedis(host, port);
    await sessionClient.connect();
    rawRedisConns.push(sessionClient);
    const subscriberClient = createRedis(host, port);
    await subscriberClient.connect();
    rawRedisConns.push(subscriberClient);
    const commandsClient = createRedis(host, port);
    await commandsClient.connect();
    rawRedisConns.push(commandsClient);

    const authenticator = new SessionAuthenticator(jwt, new RedisSessionStore(sessionClient));
    const hub = new GatewayHub(subscriberClient, commandsClient, resumeDefaults);

    const app = await buildRealtimeApp({ redisHealthy: async () => true, authenticator, hub });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apps.push(app);
    const addr = app.server.address();
    const gwPort = typeof addr === 'object' && addr ? addr.port : 0;
    return { app, port: gwPort, commandsClient };
  }

  function session(over: Partial<SessionData> = {}): SessionData {
    const tenantId = over.tenantId ?? randomUUID();
    return {
      sessionId: randomUUID(),
      realm: 'tenant',
      familyId: randomUUID(),
      tenantId,
      userId: randomUUID(),
      platformUserId: null,
      accountType: 'USER',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'NONE',
      stepUpUntil: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: {
        effectivePermissions: [],
        companyScope: 'ALL',
        branchScope: 'ALL',
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
      ...over,
    };
  }

  async function login(s: SessionData): Promise<string> {
    await sessionWriter.set(s);
    return jwt.sign({ sub: s.userId ?? 'x', sid: s.sessionId, aud: 'tenant' });
  }

  interface Client {
    ws: WebSocket;
    messages: Record<string, unknown>[];
    waitFor(
      predicate: (m: Record<string, unknown>) => boolean,
      timeoutMs?: number,
    ): Promise<Record<string, unknown>>;
    send(msg: unknown): void;
  }

  function connect(port: number, token: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      sockets.push(ws);
      const messages: Record<string, unknown>[] = [];
      const waiters: Array<{
        predicate: (m: Record<string, unknown>) => boolean;
        resolve: (m: Record<string, unknown>) => void;
      }> = [];
      const timer = setTimeout(() => reject(new Error('connect timeout')), 5000);

      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        messages.push(msg);
        for (const w of [...waiters]) {
          if (w.predicate(msg)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(msg);
          }
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      });

      const client: Client = {
        ws,
        messages,
        waitFor(predicate, timeoutMs = 5000) {
          const already = messages.find(predicate);
          if (already) return Promise.resolve(already);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('waitFor timed out')), timeoutMs);
            waiters.push({
              predicate,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          });
        },
        send(msg) {
          ws.send(JSON.stringify(msg));
        },
      };

      client
        .waitFor((m) => m['type'] === 'ack')
        .then(() => {
          clearTimeout(timer);
          resolve(client);
        })
        .catch(reject);
    });
  }

  function envelope(over: Record<string, unknown>): Record<string, unknown> {
    return {
      event_id: randomUUID(),
      seq: '1',
      branch_id: null,
      type: 'test.event',
      resource_type: 'tenant',
      resource_id: randomUUID(),
      resource_version: null,
      occurred_at: new Date().toISOString(),
      actor_summary: null,
      ...over,
    };
  }

  async function xadd(tenantId: string, env: Record<string, unknown>): Promise<string> {
    const id = await rawRedis.xadd(streamKey(tenantId), '*', 'event', JSON.stringify(env));
    return id!;
  }

  function eventOf(m: Record<string, unknown>): Record<string, unknown> {
    return m['event'] as Record<string, unknown>;
  }

  /** A promise plus its own resolver — for deterministically gating the
   *  server's replay loop at a chosen point (see the scope-narrowing and
   *  handoff-race tests), never relying on real-network timing luck. */
  function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // ── CURSOR RULE #8 — no cursor / first connection ──────────────────────
  it('no cursor (first connection) => resync-required with the current tail, never a historical replay', async () => {
    const tenantId = randomUUID();
    const s = session({ tenantId });
    const token = await login(s);

    // pre-existing historical data the brand-new client must NOT see.
    const historyId = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'history' }));

    const gw = await bootGateway();
    const client = await connect(gw.port, token);
    client.send({ type: 'resume', cursor: null });

    const resp = await client.waitFor((m) => m['type'] === 'resync-required');
    expect(resp['cursor']).toBe(historyId); // the tail — a real value, not a placeholder
    await sleep(200);
    expect(client.messages.some((m) => m['type'] === 'event')).toBe(false);
  });

  // ── CURSOR RULE #4 — malformed cursor ───────────────────────────────────
  it('a malformed cursor is rejected as a protocol error, not treated as a recovery path', async () => {
    const tenantId = randomUUID();
    const s = session({ tenantId });
    const token = await login(s);
    const gw = await bootGateway();
    const client = await connect(gw.port, token);

    client.send({ type: 'resume', cursor: 'not-a-stream-id' });
    const resp = await client.waitFor((m) => m['type'] === 'error');
    expect(resp['code']).toBe('INVALID_CURSOR');
  });

  // ── CURSOR RULE #5 — a cursor ahead of the tail is never silently accepted ─
  it('a cursor ahead of the current tail is never silently accepted', async () => {
    const tenantId = randomUUID();
    const s = session({ tenantId });
    const token = await login(s);
    await xadd(tenantId, envelope({ tenant_id: tenantId }));
    const gw = await bootGateway();
    const client = await connect(gw.port, token);

    client.send({ type: 'resume', cursor: '99999999999999-0' });
    const resp = await client.waitFor((m) => m['type'] === 'resync-required');
    expect(resp['cursor']).toBeDefined();
  });

  // ── CURSOR RULE #6 — below the retained floor ───────────────────────────
  it('a cursor below the retained floor => resync-required', async () => {
    const tenantId = randomUUID();
    const s = session({ tenantId });
    const token = await login(s);
    const idOld = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'old' }));
    const idNew = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'new' }));
    // simulate the retention window having passed for idOld — task 2.6 does
    // not implement the XTRIM scheduler itself, but a test may still exercise
    // the resulting state directly.
    await rawRedis.xtrim(streamKey(tenantId), 'MINID', idNew);

    const gw = await bootGateway();
    const client = await connect(gw.port, token);
    client.send({ type: 'resume', cursor: idOld });
    const resp = await client.waitFor((m) => m['type'] === 'resync-required');
    expect(resp['cursor']).toBe(idNew);
  });

  // ── CURSOR RULE #7 — exact replay within retention ──────────────────────
  it('a cursor within retention replays exactly, in order, none applied twice, ending at the boundary', async () => {
    const tenantId = randomUUID();
    const branchId = randomUUID();
    const base = session();
    const s = session({ tenantId, access: { ...base.access!, branchScope: [branchId] } });
    const token = await login(s);

    const id0 = await xadd(
      tenantId,
      envelope({ tenant_id: tenantId, branch_id: branchId, type: 'baseline' }),
    );
    const gw = await bootGateway();
    const client = await connect(gw.port, token);

    const id1 = await xadd(
      tenantId,
      envelope({ tenant_id: tenantId, branch_id: branchId, type: 'e1' }),
    );
    const id2 = await xadd(
      tenantId,
      envelope({ tenant_id: tenantId, branch_id: branchId, type: 'e2' }),
    );

    client.send({ type: 'resume', cursor: id0 });
    const resumed = await client.waitFor((m) => m['type'] === 'resumed');

    const delivered = client.messages
      .filter((m) => m['type'] === 'event')
      .map((m) => eventOf(m)['type']);
    expect(delivered).toEqual(['e1', 'e2']);
    expect(client.messages.filter((m) => m['type'] === 'event').map((m) => m['cursor'])).toEqual([
      id1,
      id2,
    ]);
    expect(resumed['cursor']).toBe(id2);
  });

  // ── F8/F9 — replay authorization filters, scanned cursor still reaches
  //    the full boundary despite filtering (hard gate #13) ────────────────
  it('replay filters unauthorized branches but the resumed cursor still reaches the full boundary', async () => {
    const tenantId = randomUUID();
    const branchMine = randomUUID();
    const branchOther = randomUUID();
    const base = session();
    const s = session({ tenantId, access: { ...base.access!, branchScope: [branchMine] } });
    const token = await login(s);

    const id0 = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'baseline' }));
    const gw = await bootGateway();
    const client = await connect(gw.port, token);

    await xadd(tenantId, envelope({ tenant_id: tenantId, branch_id: branchMine, type: 'mine' }));
    const idOther = await xadd(
      tenantId,
      envelope({ tenant_id: tenantId, branch_id: branchOther, type: 'other' }),
    );

    client.send({ type: 'resume', cursor: id0 });
    const resumed = await client.waitFor((m) => m['type'] === 'resumed');

    const delivered = client.messages
      .filter((m) => m['type'] === 'event')
      .map((m) => eventOf(m)['type']);
    expect(delivered).toEqual(['mine']); // 'other' was scanned but never delivered
    expect(resumed['cursor']).toBe(idOther); // yet the scanned position reached the full boundary
  });

  // ── scope narrowing DURING replay stops delivery immediately (hard gate #9) ─
  it('scope narrowing during replay immediately stops delivery to the now-unauthorized branch — deterministic, not timing-based', async () => {
    const tenantId = randomUUID();
    const branchA = randomUUID();
    const branchB = randomUUID();
    const base = session();
    const wide = session({
      tenantId,
      access: { ...base.access!, branchScope: [branchA, branchB] },
    });
    const wideToken = await login(wide);

    const id0 = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'baseline' }));
    const idA = await xadd(
      tenantId,
      envelope({ tenant_id: tenantId, branch_id: branchA, type: 'entryA' }),
    );
    const idB = await xadd(
      tenantId,
      envelope({ tenant_id: tenantId, branch_id: branchB, type: 'entryB' }),
    );
    void idA;

    // chunkSize: 1 forces a yield point between EVERY entry; `onYield` is
    // gated by a deferred the test resolves only once it has confirmed (via
    // the 'refreshed' response) that the narrower session actually took
    // effect — no reliance on real-network race timing.
    const proceed = deferred<void>();
    const gw = await bootGateway({
      chunkSize: 1,
      onYield: () => proceed.promise,
    });
    const client = await connect(gw.port, wideToken);

    client.send({ type: 'resume', cursor: id0 });
    await client.waitFor((m) => m['type'] === 'event' && eventOf(m)['type'] === 'entryA');
    // the server is now paused inside onYield, about to fetch entryB's chunk.

    const narrow = session({
      tenantId,
      sessionId: randomUUID(),
      access: { ...wide.access!, branchScope: [branchA] },
    });
    const narrowToken = await login(narrow);
    client.send({ type: 'refresh_token', token: narrowToken });
    await client.waitFor((m) => m['type'] === 'refreshed');

    proceed.resolve(); // only now does the server proceed to entryB's chunk

    const resumed = await client.waitFor((m) => m['type'] === 'resumed');
    const delivered = client.messages
      .filter((m) => m['type'] === 'event')
      .map((m) => eventOf(m)['type']);
    expect(delivered).toEqual(['entryA']); // entryB never delivered
    expect(resumed['cursor']).toBe(idB); // but the scanned cursor still reached the boundary
  });

  // ── tenant isolation — a client can never resume/replay another tenant's stream ─
  it("a client can never resume another tenant's stream — XRANGE is always keyed on the authenticated tenant", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const secretForA = await xadd(
      tenantA,
      envelope({ tenant_id: tenantA, type: 'tenant-a-secret' }),
    );
    void secretForA;

    const sB = session({ tenantId: tenantB });
    const tokenB = await login(sB);
    const gw = await bootGateway();
    const client = await connect(gw.port, tokenB);

    // there is no tenantId field in the wire protocol's resume message at
    // all — sending one (or any other extra field) must have zero effect;
    // the server only ever knows `conn.session.tenantId`.
    client.send({ type: 'resume', cursor: null, tenantId: tenantA, tenant_id: tenantA });
    const resp = await client.waitFor((m) => m['type'] === 'resync-required');

    // tenant B's OWN stream is empty — its tail must be the zero id, proving
    // the resume targeted tenant B's stream, not tenant A's (which has a real
    // entry and thus a real, non-zero tail).
    expect(resp['cursor']).toBe('0-0');
    expect(client.messages.some((m) => m['type'] === 'event')).toBe(false);
  });

  // ── HARD REQUIREMENT: race-free replay -> live handoff ──────────────────
  it('a live event published exactly during the replay-to-live transition is delivered exactly once — not zero, not twice', async () => {
    const tenantId = randomUUID();
    const id0 = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'baseline' }));
    const s = session({ tenantId });
    const token = await login(s);

    // The risk this test targets: a genuinely NEW event — published live,
    // beyond anything the replay's XRANGE will ever scan (its boundary is
    // snapshotted before this event exists) — arrives while this connection
    // is still `replaying`. A naive implementation would either drop it
    // (never replayed, since it's past the boundary; never delivered live,
    // since live delivery was suspended for this connection — genuine loss)
    // or, if delivery weren't suspended at all, race the replay's own
    // in-flight sends. `deliverLive`'s per-connection buffering is what
    // prevents both: it holds the event until the handoff, then drains it.
    //
    // `chunkSize: 1` + a test-gated `onYield` create a deterministic pause
    // exactly at "replay has finished scanning history, about to drain the
    // live buffer and flip `replaying` back to false" — proving there is
    // genuinely no gap there, not merely that one usually doesn't appear.
    const proceed = deferred<void>();
    let yieldCount = 0;
    const gw = await bootGateway({
      chunkSize: 1,
      onYield: async () => {
        yieldCount++;
        await proceed.promise;
      },
    });
    const client = await connect(gw.port, token);

    // One more historical entry (already in the Stream before `resume` is
    // called) so the replay loop's first chunk has something to deliver and
    // therefore a real `onYield` pause point before it re-checks for more
    // (finds none) and moves on to draining the buffer.
    await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'historical' }));

    client.send({ type: 'resume', cursor: id0 });
    await client.waitFor((m) => m['type'] === 'event' && eventOf(m)['type'] === 'historical');
    // The server is now paused in `onYield`, between scanning `historical`
    // and finding nothing further to replay.

    // Publish a live event for this tenant right now, while `conn.replaying`
    // is still true (this connection subscribed to `rt:live:{tenantId}` at
    // `register()`, well before `resume` was ever called) — `deliverLive`
    // must buffer it, never deliver it directly and never drop it.
    const pub = createRedis(
      new URL(stack.redis.url).hostname,
      Number(new URL(stack.redis.url).port),
    );
    await pub.connect();
    const liveEnvelope = envelope({ tenant_id: tenantId, type: 'live-during-handoff' });
    await pub.publish(
      `rt:live:${tenantId}`,
      JSON.stringify({ cursor: '999999999999-0', event: liveEnvelope }),
    );
    await pub.disconnect();

    // give the buffered publish a moment to actually land in conn.liveBuffer
    // before releasing the replay loop.
    await sleep(150);
    proceed.resolve();

    const resumed = await client.waitFor((m) => m['type'] === 'resumed');
    void resumed;

    await sleep(200); // let any genuine double-delivery arrive if the handoff were racy
    const liveDeliveries = client.messages.filter(
      (m) => m['type'] === 'event' && eventOf(m)['event_id'] === liveEnvelope['event_id'],
    );
    expect(liveDeliveries).toHaveLength(1); // exactly once — not zero, not twice
    expect(yieldCount).toBeGreaterThanOrEqual(1); // the pause genuinely happened
  });

  // ── fault injection: Redis connection loss during replay ────────────────
  it('a Redis connection loss mid-replay fails that resume safely (no crash, no hang) and a fresh resume afterward still converges', async () => {
    const tenantId = randomUUID();
    const id0 = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'baseline' }));
    await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'e1' }));
    const id2 = await xadd(tenantId, envelope({ tenant_id: tenantId, type: 'e2' }));
    const s = session({ tenantId });
    const token = await login(s);

    // chunkSize 1 gives a real pause point between e1 and e2 in which to cut
    // the gateway's own Redis "commands" connection — a genuine mid-replay
    // connection failure, not a simulated error.
    const gw = await bootGateway({ chunkSize: 1 });
    const client = await connect(gw.port, token);

    client.send({ type: 'resume', cursor: id0 });
    await client.waitFor((m) => m['type'] === 'event' && eventOf(m)['type'] === 'e1');
    gw.commandsClient.disconnect(); // hard connection loss, mid-replay

    // the in-flight resume must fail safely — no server crash, no hang —
    // either an explicit error or the promise settling some other way; what
    // matters is the gateway process stays alive and serves the NEXT request.
    await sleep(500);
    expect(gw.app.server.listening).toBe(true);

    // recovery: reconnect and prove a fresh resume still converges correctly.
    await gw.commandsClient.connect();
    const client2 = await connect(gw.port, token);
    client2.send({ type: 'resume', cursor: id0 });
    const resumed2 = await client2.waitFor((m) => m['type'] === 'resumed', 8_000);
    const delivered2 = client2.messages
      .filter((m) => m['type'] === 'event')
      .map((m) => eventOf(m)['type']);
    expect(delivered2).toEqual(['e1', 'e2']);
    expect(resumed2['cursor']).toBe(id2);
  });
});
