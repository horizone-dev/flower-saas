import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  JwtService,
  InMemorySessionStore,
  SessionAuthenticator,
  type SessionData,
} from '@flower/backend';
import { GatewayHub } from './gateway/hub.js';
import { buildRealtimeApp } from './app.js';

/**
 * `apps/realtime`'s WS auth/ack/event/close flow, fast and mocked-Redis — the
 * multi-gateway-instance / cross-tenant / cross-branch / revoke / dedup
 * demonstrations run against **real** Redis in `gateway.integration.test.ts`.
 */

const BACKEND_CONFIG = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  AUTH_JWT_SECRET: 'test-only-jwt-secret-at-least-32-chars-long',
  AUTH_ACCESS_TOKEN_TTL_SECONDS: 600,
};

/** A minimal Pub/Sub stand-in — `GatewayHub` only ever calls these three
 *  methods on the client it's given. */
function fakeSubscriberRedis(): Redis {
  const listeners: Array<(channel: string, message: string) => void> = [];
  const fake = {
    subscribe: async () => 1,
    unsubscribe: async () => 1,
    on: (event: string, cb: (channel: string, message: string) => void) => {
      if (event === 'message') listeners.push(cb);
    },
    // test-only helper — not part of the ioredis surface
    emitMessage: (channel: string, message: string) => {
      for (const l of listeners) l(channel, message);
    },
  };
  return fake as unknown as Redis;
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
    expiresAt: Date.now() + 60_000,
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

async function issueToken(jwt: JwtService, s: SessionData): Promise<string> {
  return jwt.sign({ sub: s.userId ?? s.platformUserId ?? 'x', sid: s.sessionId, aud: 'tenant' });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('realtime gateway', () => {
  it('GET /healthz -> 200 ok', async () => {
    const jwt = new JwtService(BACKEND_CONFIG);
    const store = new InMemorySessionStore();
    app = await buildRealtimeApp({
      redisHealthy: async () => true,
      authenticator: new SessionAuthenticator(jwt, store),
      hub: new GatewayHub(fakeSubscriberRedis(), fakeSubscriberRedis()),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', role: 'realtime' });
  });

  it('GET /readyz -> 503 when Redis is down, 200 when up', async () => {
    const jwt = new JwtService(BACKEND_CONFIG);
    const store = new InMemorySessionStore();
    app = await buildRealtimeApp({
      redisHealthy: async () => false,
      authenticator: new SessionAuthenticator(jwt, store),
      hub: new GatewayHub(fakeSubscriberRedis(), fakeSubscriberRedis()),
    });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await app.close();
    app = await buildRealtimeApp({
      redisHealthy: async () => true,
      authenticator: new SessionAuthenticator(jwt, store),
      hub: new GatewayHub(fakeSubscriberRedis(), fakeSubscriberRedis()),
    });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });

  it('WS: a valid token (query string) connects and gets an ack carrying tenant/branch scope', async () => {
    const jwt = new JwtService(BACKEND_CONFIG);
    const store = new InMemorySessionStore();
    const base = session();
    const s = session({ access: { ...base.access!, branchScope: ['b1', 'b2'] } });
    await store.set(s);
    const token = await issueToken(jwt, s);

    let connects = 0;
    let closes = 0;
    app = await buildRealtimeApp({
      redisHealthy: async () => true,
      authenticator: new SessionAuthenticator(jwt, store),
      hub: new GatewayHub(fakeSubscriberRedis(), fakeSubscriberRedis()),
      onConnect: () => (connects += 1),
      onClose: () => (closes += 1),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string };
        messages.push(msg);
        clearTimeout(timer);
        ws.close(1000);
      });
      ws.addEventListener('close', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });

    for (let i = 0; i < 20 && closes === 0; i++) await new Promise((r) => setTimeout(r, 25));

    expect(messages[0]).toMatchObject({
      type: 'ack',
      tenantId: s.tenantId,
      branchScope: ['b1', 'b2'],
    });
    expect(connects).toBe(1);
    expect(closes).toBe(1);
  });

  it('WS: a missing token is closed immediately with an UNAUTHORIZED error, never left connected', async () => {
    const jwt = new JwtService(BACKEND_CONFIG);
    const store = new InMemorySessionStore();
    let authFailed: string | undefined;
    app = await buildRealtimeApp({
      redisHealthy: async () => true,
      authenticator: new SessionAuthenticator(jwt, store),
      hub: new GatewayHub(fakeSubscriberRedis(), fakeSubscriberRedis()),
      onAuthFailed: (reason) => (authFailed = reason),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const { code, messages } = await new Promise<{ code: number; messages: unknown[] }>(
      (resolve, reject) => {
        const collected: unknown[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => reject(new Error('timeout')), 4000);
        ws.addEventListener('message', (event) => {
          collected.push(JSON.parse(String(event.data)));
        });
        ws.addEventListener('close', (event) => {
          clearTimeout(timer);
          resolve({ code: event.code, messages: collected });
        });
        ws.addEventListener('error', () => reject(new Error('ws error')));
      },
    );

    expect(messages[0]).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    expect(code).toBe(4000);
    expect(authFailed).toBe('missing token');
  });

  it('WS: an invalid token is rejected the same way (never authenticated, never registered)', async () => {
    const jwt = new JwtService(BACKEND_CONFIG);
    const store = new InMemorySessionStore();
    app = await buildRealtimeApp({
      redisHealthy: async () => true,
      authenticator: new SessionAuthenticator(jwt, store),
      hub: new GatewayHub(fakeSubscriberRedis(), fakeSubscriberRedis()),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=not-a-real-token`);
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    expect(closeCode).toBe(4000);
  });
});
