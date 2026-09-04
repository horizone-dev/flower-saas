import 'reflect-metadata';
import { z } from 'zod';
import { createLogger, installShutdown, parseEnv } from '@flower/service-runtime';
import { bootstrapWorker } from './bootstrap.js';

/**
 * BullMQ processor host (FC-3 / OD-P2-8). A **separate process** from `apps/api`
 * — its own startup, shutdown, health and restart boundary. It boots a Nest
 * application context over `@flower/backend` and runs the same authoritative
 * services `apps/api` does (CLAUDE.md rule 1).
 *
 * Phase 2-core task 2.3: the framework only — a trivial probe processor. The
 * outbox dispatcher is task 2.4; domain job processors land in their own phases.
 */
async function main(): Promise<void> {
  const env = parseEnv(
    z.object({ WORKER_METRICS_PORT: z.coerce.number().int().positive().default(3011) }),
  );
  const log = createLogger('worker', env.LOG_LEVEL, env.NODE_ENV === 'development');

  const runtime = await bootstrapWorker({
    redisHost: env.REDIS_HOST,
    redisPort: env.REDIS_PORT,
    metricsPort: env.WORKER_METRICS_PORT,
    logger: log,
  });

  installShutdown(log, () => runtime.stop());

  log.info(
    { metricsPort: env.WORKER_METRICS_PORT, processors: runtime.registry.registeredQueues },
    'worker started',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start worker: ${String(err)}\n`);
  process.exit(1);
});
