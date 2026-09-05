import 'reflect-metadata';
import { z } from 'zod';
import { createLogger, installShutdown, parseEnv } from '@flower/service-runtime';
import { bootstrapScheduler } from './bootstrap.js';

/**
 * Repeatable / cron job registrar (FC-3 / OD-P2-8). Runs as a SINGLETON — an
 * advisory-lock leader election is added when a repeatable job's correctness
 * depends on exactly-one-registrar (Phase 2 remainder). It only *enqueues* jobs;
 * `apps/worker` runs them. A **separate process** from `apps/api` — its own
 * startup, shutdown, health and restart boundary.
 *
 * Phase 2-core task 2.3: the framework only — a trivial probe schedule. Task
 * 2.8 adds the `stream-retention` sweep schedule (realtime-Stream `XTRIM`).
 */
async function main(): Promise<void> {
  const env = parseEnv(
    z.object({
      SCHEDULER_METRICS_PORT: z.coerce.number().int().positive().default(3012),
      /** how often to enqueue the realtime-Stream retention sweep, ms (task
       *  2.8). A missed sweep is harmless — the next one still trims everything
       *  past the time floor — so this is a low-frequency maintenance cadence.
       *  Default 1h. */
      STREAM_RETENTION_SWEEP_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(60 * 60 * 1000),
    }),
  );
  const log = createLogger('scheduler', env.LOG_LEVEL, env.NODE_ENV === 'development');

  const runtime = await bootstrapScheduler({
    redisHost: env.REDIS_HOST,
    redisPort: env.REDIS_PORT,
    metricsPort: env.SCHEDULER_METRICS_PORT,
    logger: log,
    retentionSweepMs: env.STREAM_RETENTION_SWEEP_INTERVAL_MS,
  });

  installShutdown(log, () => runtime.stop());

  log.info(
    { metricsPort: env.SCHEDULER_METRICS_PORT, schedules: runtime.registeredSchedules },
    'scheduler started (schedules registered)',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start scheduler: ${String(err)}\n`);
  process.exit(1);
});
