import { z } from 'zod';
import {
  connectRedis,
  createLogger,
  createRedis,
  installShutdown,
  parseEnv,
  redisHealthy,
} from '@flower/service-runtime';
import { buildRealtimeApp } from './app.js';

/**
 * WebSocket / SSE gateway entrypoint (ADR-0009). Distinct runtime role,
 * co-deployable with apps/api until socket volume warrants a split. The Redis
 * Streams consumer that fans out outbox events is Phase 2.
 */
async function main(): Promise<void> {
  const env = parseEnv(
    z.object({
      REALTIME_PORT: z.coerce.number().int().positive().default(3002),
      API_HOST: z.string().default('0.0.0.0'),
    }),
  );
  const log = createLogger('realtime', env.LOG_LEVEL, env.NODE_ENV === 'development');
  const redis = createRedis(env.REDIS_HOST, env.REDIS_PORT);
  await connectRedis(redis);

  const app = await buildRealtimeApp({
    redisHealthy: () => redisHealthy(redis),
    onConnect: () => log.debug('ws connected'),
    onClose: () => log.debug('ws closed'),
  });

  installShutdown(log, async () => {
    await app.close();
    redis.disconnect();
  });

  await app.listen({ port: env.REALTIME_PORT, host: env.API_HOST });
  const ok = await redisHealthy(redis);
  log.info({ port: env.REALTIME_PORT, redis: ok ? 'ok' : 'down' }, 'realtime gateway started');
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start realtime: ${String(err)}\n`);
  process.exit(1);
});
