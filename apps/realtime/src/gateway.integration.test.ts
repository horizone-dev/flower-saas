import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  JwtService,
  RedisSessionStore,
  SessionAuthenticator,
  liveChannel,
  type SessionData,
} from '@flower/backend';
import { createRedis } from '@flower/service-runtime';
import { startTestStack, type TestStack } from '@flower/testing';
import { createSessionRedis } from './auth/redis.js';
import { GatewayHub } from './gateway/hub.js';
import { buildRealtimeApp } from './app.js';

/**
 * The realtime gateway, end to end, against **real** Redis (Testcontainers) —
 * PHASE-2-CORE-PLAN §2.5, ADR-0017 §4/§9. Proves, with genuinely separate
 * `buildRealtimeApp` instances standing in for separate gateway processes
 * (each with its own Redis connections, exactly as two real deployed
 * instances would have), the task 2.5 acceptance demonstrations:
 *
 *   1. two gateway instances both receive an authorized same-branch event
 *   2. tenant-B never receives tenant-A events
 *   3. branch-X-only session never receives branch-Y events
 *   4. arbitrary client-side "subscribe to a topic" requests cannot expand
 *      scope (there is no subscribe-with-topic message in this protocol at
 *      all — delivery is governed only by the authenticated session)
 *   5. token refresh with narrowed scope stops unauthorized delivery
 *      immediately
 *   6. session revoke closes sockets on every gateway instance within <5s
 *   8. a duplicate live event (same event_id) is dropped, delivered once
 *
 * (Demonstration 7 — "a relay restart loses no Stream event" — is a
 * relay-internal guarantee, proven in
 * `apps/worker/src/realtime-relay/relay.test.ts`'s dedicated XAUTOCLAIM
 * crash-recovery test; this file publishes directly to `rt:live:{tenantId}`,
 * exactly what the relay does, without re-importing `apps/worker` code —
 * that cross-app import is exactly what `@flower/backend` exists to avoid.)
 */
describe('realtime gateway (integration — Redis, 2 real instances)', () => {
  let stack: TestStack;
  let sessionWriter: RedisSessionStore;
  let jwt: JwtService;
  const apps: FastifyInstance[] = [];
  const sockets: WebSocket[] = [];
  const rawRedisConns: Redis[] = [];

  const BACKEND_CONFIG = {
    NODE_ENV: 'test' as const,
    LOG_LEVEL: 'silent' as const,
    AUTH_JWT_SECRET: 'integration-test-jwt-secret-at-least-32-chars',
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 600,
  };

  beforeAll(async () => {
    stack = await startTestStack({ services: ['redis'] });
    const url = new URL(stack.redis.url);
    const host = url.hostname;
    const port = Number(url.port);

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

  /** Boots one real, independent gateway "instance" — its own Fastify app,
   *  its own session-lookup Redis connection, its own Pub/Sub subscriber
   *  connection, its own `GatewayHub` — exactly what a second deployed
   *  process would have. */
  async function bootGateway(): Promise<{ app: FastifyInstance; port: number }> {
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
    const hub = new GatewayHub(subscriberClient, commandsClient);

    const app = await buildRealtimeApp({
      redisHealthy: async () => true,
      authenticator,
      hub,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apps.push(app);
    const addr = app.server.address();
    const gwPort = typeof addr === 'object' && addr ? addr.port : 0;
    return { app, port: gwPort };
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
      ws.addEventListener('open', () => {
        // resolved on the first 'ack' message below instead — but keep the
        // timer alive for that.
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

  /** The wrapper message is `{type:'event', event: <envelope>}` — nested,
   *  never flattened, since the envelope carries its own `type` field (the
   *  domain event type) that would otherwise collide with the wrapper's. */
  function eventOf(m: Record<string, unknown>): Record<string, unknown> {
    return m['event'] as Record<string, unknown>;
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

  let fakeCursorCounter = 0;
  /** A synthetic but syntactically-plausible Stream id — these tests publish
   *  directly to `rt:live:{tenantId}` (exactly what the task 2.6 relay does),
   *  bypassing a real Stream entirely, so the exact value never matters here
   *  (resume/replay against a real Stream has its own dedicated suite). */
  function nextFakeCursor(): string {
    return `${Date.now()}-${fakeCursorCounter++}`;
  }

  /** Publish exactly what the task 2.6 relay would — the `{cursor, event}`
   *  transport wrapper — on `rt:live:{tenantId}`, without importing the relay
   *  itself (that cross-app import is exactly what `@flower/backend` exists
   *  to avoid). */
  async function publishLive(
    tenantId: string,
    env: Record<string, unknown>,
    cursor: string = nextFakeCursor(),
  ): Promise<void> {
    const url = new URL(stack.redis.url);
    const pub = createRedis(url.hostname, Number(url.port));
    await pub.connect();
    await pub.publish(liveChannel(tenantId), JSON.stringify({ cursor, event: env }));
    pub.disconnect();
  }

  // ── 1. two gateway instances, both authorized, both receive the event ──
  it('two gateway instances both receive an authorized same-branch event', async () => {
    const tenantId = randomUUID();
    const branchId = randomUUID();
    const s = session({ tenantId, access: { ...session().access!, branchScope: [branchId] } });
    const token = await login(s);

    const gwA = await bootGateway();
    const gwB = await bootGateway();
    const clientA = await connect(gwA.port, token);
    const clientB = await connect(gwB.port, token);

    const env = envelope({ tenant_id: tenantId, branch_id: branchId, type: 'both-gateways' });
    await publishLive(tenantId, env);

    const [msgA, msgB] = await Promise.all([
      clientA.waitFor((m) => m['type'] === 'event'),
      clientB.waitFor((m) => m['type'] === 'event'),
    ]);
    expect(eventOf(msgA)).toMatchObject({ event_id: env['event_id'], branch_id: branchId });
    expect(eventOf(msgB)).toMatchObject({ event_id: env['event_id'], branch_id: branchId });
  });

  // ── 2. tenant isolation ─────────────────────────────────────────────────
  it('tenant B never receives a tenant A event', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const sA = session({ tenantId: tenantA });
    const sB = session({ tenantId: tenantB });
    const tokenA = await login(sA);
    const tokenB = await login(sB);

    const gw = await bootGateway();
    const clientA = await connect(gw.port, tokenA);
    const clientB = await connect(gw.port, tokenB);

    const env = envelope({ tenant_id: tenantA, branch_id: null, type: 'tenant-a-only' });
    await publishLive(tenantA, env);

    await clientA.waitFor((m) => m['type'] === 'event');
    // give a genuinely leaked cross-tenant delivery every chance to arrive
    await sleep(300);
    expect(clientB.messages.some((m) => m['type'] === 'event')).toBe(false);
  });

  // ── 3. branch isolation ────────────────────────────────────────────────
  it('a branch-X-only session never receives a branch-Y event', async () => {
    const tenantId = randomUUID();
    const branchX = randomUUID();
    const branchY = randomUUID();
    const s = session({ tenantId, access: { ...session().access!, branchScope: [branchX] } });
    const token = await login(s);

    const gw = await bootGateway();
    const client = await connect(gw.port, token);

    const envY = envelope({ tenant_id: tenantId, branch_id: branchY, type: 'branch-y-event' });
    await publishLive(tenantId, envY);
    await sleep(300);
    expect(client.messages.some((m) => m['type'] === 'event')).toBe(false);

    const envX = envelope({ tenant_id: tenantId, branch_id: branchX, type: 'branch-x-event' });
    await publishLive(tenantId, envX);
    const received = await client.waitFor((m) => m['type'] === 'event');
    expect(eventOf(received)).toMatchObject({ branch_id: branchX });
  });

  // ── 4. a client cannot expand its own scope by any message ─────────────
  it('a client-sent "subscribe to another topic" message has no effect — delivery is governed only by the session', async () => {
    const tenantId = randomUUID();
    const branchMine = randomUUID();
    const branchOther = randomUUID();
    const s = session({ tenantId, access: { ...session().access!, branchScope: [branchMine] } });
    const token = await login(s);

    const gw = await bootGateway();
    const client = await connect(gw.port, token);

    // there is no 'subscribe' message in this protocol at all — sending one
    // (or anything else) must be silently ignored, never interpreted as a
    // scope-widening request.
    client.send({
      type: 'subscribe',
      topic: `t:${tenantId}:b:${branchOther}:tenant`,
      tenantId,
      branchId: branchOther,
    });
    await sleep(150);

    const envOther = envelope({ tenant_id: tenantId, branch_id: branchOther, type: 'not-mine' });
    await publishLive(tenantId, envOther);
    await sleep(300);
    expect(client.messages.some((m) => m['type'] === 'event')).toBe(false);
  });

  // ── 5. token refresh with narrowed scope stops delivery immediately ────
  it('token refresh with a narrowed branch scope stops delivery to the now-unauthorized branch immediately', async () => {
    const tenantId = randomUUID();
    const branchA = randomUUID();
    const branchB = randomUUID();
    const wide = session({
      tenantId,
      access: { ...session().access!, branchScope: [branchA, branchB] },
    });
    const wideToken = await login(wide);

    const gw = await bootGateway();
    const client = await connect(gw.port, wideToken);

    // baseline: branch B is currently authorized
    const before = envelope({ tenant_id: tenantId, branch_id: branchB, type: 'before-refresh' });
    await publishLive(tenantId, before);
    await client.waitFor((m) => m['type'] === 'event' && eventOf(m)['branch_id'] === branchB);

    // narrow to branch A only, via a NEW session (a real refresh would reuse
    // the identity but a narrower resolved access snapshot — a new session
    // row models that just as validly here)
    const narrow = session({
      tenantId,
      access: { ...wide.access!, branchScope: [branchA] },
    });
    const narrowToken = await login(narrow);
    client.send({ type: 'refresh_token', token: narrowToken });
    await client.waitFor((m) => m['type'] === 'refreshed');

    const after = envelope({ tenant_id: tenantId, branch_id: branchB, type: 'after-refresh' });
    await publishLive(tenantId, after);
    await sleep(300);
    expect(
      client.messages.some(
        (m) => m['type'] === 'event' && eventOf(m)['event_id'] === after['event_id'],
      ),
    ).toBe(false);

    // and branch A still works — the narrowing didn't silently break everything
    const stillWorks = envelope({
      tenant_id: tenantId,
      branch_id: branchA,
      type: 'still-authorized',
    });
    await publishLive(tenantId, stillWorks);
    const received = await client.waitFor(
      (m) => m['type'] === 'event' && eventOf(m)['event_id'] === stillWorks['event_id'],
    );
    expect(received).toBeDefined();
  });

  // ── 6. revoke closes sockets on every gateway instance within <5s ──────
  it('session revoke closes matching sockets on every gateway instance within the 5s gate', async () => {
    const tenantId = randomUUID();
    const s = session({ tenantId });
    const token = await login(s);

    const gwA = await bootGateway();
    const gwB = await bootGateway();
    const clientA = await connect(gwA.port, token);
    const clientB = await connect(gwB.port, token);

    const closedA = new Promise<number>((resolve) => {
      clientA.ws.addEventListener('close', (e) => resolve(e.code));
    });
    const closedB = new Promise<number>((resolve) => {
      clientB.ws.addEventListener('close', (e) => resolve(e.code));
    });

    const revokeStarted = Date.now();
    await sessionWriter.revoke(s.sessionId, 'integration test revoke');

    const [codeA, codeB] = await Promise.all([closedA, closedB]);
    const elapsedMs = Date.now() - revokeStarted;
    expect(elapsedMs).toBeLessThan(5000);
    expect(codeA).toBe(4001);
    expect(codeB).toBe(4001);
  });

  // ── 8. a duplicate live event (same event_id) is dropped, delivered once ─
  it('a duplicate live delivery (same event_id) is dropped — the client receives it exactly once', async () => {
    const tenantId = randomUUID();
    const s = session({ tenantId });
    const token = await login(s);

    const gw = await bootGateway();
    const client = await connect(gw.port, token);

    const env = envelope({ tenant_id: tenantId, branch_id: null, type: 'dup-test' });
    await publishLive(tenantId, env); // first delivery
    await publishLive(tenantId, env); // exact duplicate — same event_id
    await client.waitFor(
      (m) => m['type'] === 'event' && eventOf(m)['event_id'] === env['event_id'],
    );
    await sleep(300); // give a genuine double-delivery every chance to arrive

    const matching = client.messages.filter(
      (m) => m['type'] === 'event' && eventOf(m)['event_id'] === env['event_id'],
    );
    expect(matching).toHaveLength(1);
  });
});
