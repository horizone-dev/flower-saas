import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Server } from 'node:http';
import { parseEnv, createRedis, redisHealthy, startHealthServer, createLogger } from './index.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('@flower/service-runtime', () => {
  it('parseEnv merges base + extra and applies defaults', () => {
    const env = parseEnv(z.object({ METRICS_PORT: z.coerce.number().default(3011) }), {});
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.METRICS_PORT).toBe(3011);
    expect(env.NODE_ENV).toBe('development');
  });

  it('parseEnv throws on an invalid value', () => {
    expect(() => parseEnv(z.object({}), { REDIS_PORT: 'nope' })).toThrow(/Invalid environment/);
  });

  it('redisHealthy resolves false when Redis is unreachable (never throws)', async () => {
    const redis = createRedis('127.0.0.1', 59944);
    await expect(redisHealthy(redis, 500)).resolves.toBe(false);
    redis.disconnect();
  });

  it('health server: /healthz 200, /readyz reflects checks, unknown path 404', async () => {
    const port = 34110;
    servers.push(startHealthServer(port, 'test-role', async () => ({ redis: 'down' })));
    await new Promise((r) => setTimeout(r, 50));

    const h = await get(port, '/healthz');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ status: 'ok', role: 'test-role' });

    const r = await get(port, '/readyz');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ status: 'down', checks: { redis: 'down' } });

    const nf = await get(port, '/nope');
    expect(nf.status).toBe(404);
  });

  it('createLogger returns a usable logger', () => {
    const log = createLogger('x', 'silent', false);
    expect(typeof log.info).toBe('function');
  });
});
