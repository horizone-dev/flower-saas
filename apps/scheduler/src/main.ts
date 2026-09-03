import { Queue } from 'bullmq';
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
import { REPEATABLE_JOBS } from './schedules.js';

/**
 * Cron / repeatable-job registrar (ARCHITECTURE §49). Runs as a SINGLETON — an
 * advisory-lock leader election is added in Phase 2. It only *enqueues* jobs; the
 * worker runs them. No business logic here (CLAUDE.md rule 1).
 */
async function main(): Promise<void> {
  const env = parseEnv(
    z.object({ SCHEDULER_METRICS_PORT: z.coerce.number().int().positive().default(3012) }),
  );
  const log = createLogger('scheduler', env.LOG_LEVEL, env.NODE_ENV === 'development');
  const connection = createRedis(env.REDIS_HOST, env.REDIS_PORT);

  // The scheduler's whole job is to register repeatable jobs on Redis-backed
  // queues. If Redis is unreachable at boot there is nothing useful to do, and
  // there is no retry / leader-election loop yet (Phase 2). Fail fast so the
  // orchestrator restarts the process rather than leaving it idle and silent
  // with no schedules registered — ultra-review F5.
  if (!(await connectRedis(connection))) {
    throw new Error(
      `Redis unreachable at ${env.REDIS_HOST}:${env.REDIS_PORT} — cannot register schedules`,
    );
  }

  const queues = new Map(
    [...new Set(REPEATABLE_JOBS.map((j) => j.queue))].map(
      (name) => [name, new Queue(name, { connection })] as const,
    ),
  );

  const health = startHealthServer(env.SCHEDULER_METRICS_PORT, 'scheduler', async () => ({
    redis: (await redisHealthy(connection)) ? 'ok' : 'down',
  }));

  installShutdown(log, async () => {
    health.close();
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
    connection.disconnect();
  });

  for (const job of REPEATABLE_JOBS) {
    await queues
      .get(job.queue)!
      .upsertJobScheduler(job.schedulerId, { every: job.everyMs }, { name: job.jobName, data: {} });
  }

  log.info(
    { metricsPort: env.SCHEDULER_METRICS_PORT, jobs: REPEATABLE_JOBS.length },
    'scheduler started (schedules registered)',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start scheduler: ${String(err)}\n`);
  process.exit(1);
});
