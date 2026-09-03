import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

export interface RealtimeDeps {
  /** returns true when Redis (the outbox-stream source) is reachable */
  redisHealthy: () => Promise<boolean>;
  onConnect?: () => void;
  onClose?: () => void;
}

/**
 * Builds the realtime gateway Fastify app (ARCHITECTURE §13-14, ADR-0009).
 * Phase 0: /healthz, /readyz, and a /ws endpoint that acks on connect and echoes
 * messages. NO topic authorization — that lands in Phase 2 (re-runs the guard
 * pipeline on every subscribe). No business logic here.
 */
export async function buildRealtimeApp(deps: RealtimeDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get('/healthz', () => ({ status: 'ok', role: 'realtime' }));

  app.get('/readyz', async (_req, reply) => {
    const ok = await deps.redisHealthy();
    void reply.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'down', role: 'realtime', checks: { redis: ok ? 'ok' : 'down' } };
  });

  app.get('/ws', { websocket: true }, (socket) => {
    deps.onConnect?.();
    socket.send(
      JSON.stringify({ type: 'ack', protocol: 'flower-realtime/0', topicsAvailable: false }),
    );
    socket.on('message', (raw: Buffer) => {
      socket.send(JSON.stringify({ type: 'echo', received: raw.toString().slice(0, 256) }));
    });
    socket.on('close', () => deps.onClose?.());
  });

  return app;
}
