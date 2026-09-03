import { z } from 'zod';
import {
  createLogger,
  createRedis,
  installShutdown,
  parseEnv,
  connectRedis,
  redisHealthy,
  startHealthServer,
} from '@flower/service-runtime';
import { QUEUES, buildQueues } from './queues.js';

/**
 * BullMQ processor host. Phase 0 stub: connect to Redis, register the queue set,
 * expose health. Phase 2 wraps this in a NestJS application context and attaches
 * the apps/api domain modules as processors.
 */
async function main(): Promise<void> {
  const env = parseEnv(
    z.object({ WORKER_METRICS_PORT: z.coerce.number().int().positive().default(3011) }),
  );
  const log = createLogger('worker', env.LOG_LEVEL, env.NODE_ENV === 'development');
  const connection = createRedis(env.REDIS_HOST, env.REDIS_PORT);
  await connectRedis(connection);
  const queues = buildQueues(connection);

  const health = startHealthServer(env.WORKER_METRICS_PORT, 'worker', async () => ({
    redis: (await redisHealthy(connection)) ? 'ok' : 'down',
  }));

  installShutdown(log, async () => {
    health.close();
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
    connection.disconnect();
  });

  const ok = await redisHealthy(connection);
  log.info(
    { metricsPort: env.WORKER_METRICS_PORT, queues: QUEUES.length, redis: ok ? 'ok' : 'down' },
    'worker started',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start worker: ${String(err)}\n`);
  process.exit(1);
});
