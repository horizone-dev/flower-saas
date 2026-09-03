import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildRealtimeApp } from './app.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('realtime gateway', () => {
  it('GET /healthz -> 200 ok', async () => {
    app = await buildRealtimeApp({ redisHealthy: async () => true });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', role: 'realtime' });
  });

  it('GET /readyz -> 503 when Redis is down, 200 when up', async () => {
    app = await buildRealtimeApp({ redisHealthy: async () => false });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await app.close();
    app = await buildRealtimeApp({ redisHealthy: async () => true });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });

  it('WS: connect -> ack -> echo -> close', async () => {
    let connects = 0;
    let closes = 0;
    app = await buildRealtimeApp({
      redisHealthy: async () => true,
      onConnect: () => (connects += 1),
      onClose: () => (closes += 1),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'ping' })));
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string };
        messages.push(msg);
        if (msg.type === 'echo') {
          clearTimeout(timer);
          ws.close(1000);
        }
      });
      ws.addEventListener('close', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });

    // the server-side close handler fires just after the client's close event
    for (let i = 0; i < 20 && closes === 0; i++) await new Promise((r) => setTimeout(r, 25));

    expect(messages[0]).toMatchObject({ type: 'ack', topicsAvailable: false });
    expect(messages[1]).toMatchObject({ type: 'echo' });
    expect(connects).toBe(1);
    expect(closes).toBe(1);
  });
});
