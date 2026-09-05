import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Server } from 'node:http';
import {
  type Logger,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  createBullConnection,
  connectRedis,
  redisHealthy,
  startHealthServer,
  jobOptions,
} from '@flower/service-runtime';
import { SchedulerModule } from './scheduler.module.js';
import { buildRepeatableJobs, type RepeatableJob } from './schedules.js';

export interface SchedulerRuntimeOptions {
  readonly redisHost: string;
  readonly redisPort: number;
  readonly metricsPort: number;
  readonly logger: Logger;
  readonly retryPolicy?: RetryPolicy;
  /** fail fast if Redis is not reachable within this window (documented policy) */
  readonly redisConnectTimeoutMs?: number;
  /** override the registry — tests substitute a short interval for `probe` */
  readonly jobs?: readonly RepeatableJob[];
  /** sweep cadence for the `stream-retention` schedule, ms (task 2.8). Ignored
   *  when `jobs` is supplied. Default `DEFAULT_RETENTION_SWEEP_MS` (1h). */
  readonly retentionSweepMs?: number;
}

export interface SchedulerRuntime {
  readonly context: INestApplicationContext;
  readonly connection: Redis;
  readonly health: Server;
  readonly registeredSchedules: readonly string[];
  stop(): Promise<void>;
}

/**
 * Boot the scheduler: a Nest application context over `@flower/backend` (so it
 * can resolve the same authoritative services `apps/api` / `apps/worker` do —
 * CLAUDE.md rule 1), a BullMQ connection, and the repeatable-job registry
 * (`REPEATABLE_JOBS` — enqueue only, no `Worker`).
 *
 * **Redis-at-startup policy (constraint 8):** the scheduler's entire purpose is
 * registering repeatable jobs on Redis-backed queues, so if Redis is
 * unreachable at boot it **fails fast** (throws) — the orchestrator restarts the
 * process rather than leaving it idle with no schedules registered.
 */
export async function bootstrapScheduler(opts: SchedulerRuntimeOptions): Promise<SchedulerRuntime> {
  const { logger } = opts;
  const retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const jobs = opts.jobs ?? buildRepeatableJobs(opts.retentionSweepMs);

  const context = await NestFactory.createApplicationContext(SchedulerModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
  context.enableShutdownHooks();

  const connection = createBullConnection(opts.redisHost, opts.redisPort);
  if (!(await connectRedis(connection, opts.redisConnectTimeoutMs ?? 5_000))) {
    await context.close();
    connection.disconnect();
    throw new Error(
      `Redis unreachable at ${opts.redisHost}:${opts.redisPort} — cannot register schedules`,
    );
  }

  const queues = new Map(
    [...new Set(jobs.map((j) => j.queue))].map(
      (name) => [name, new Queue(name, { connection })] as const,
    ),
  );

  for (const job of jobs) {
    await queues
      .get(job.queue)!
      .upsertJobScheduler(
        job.schedulerId,
        { every: job.everyMs },
        { name: job.jobName, data: {}, opts: jobOptions(retryPolicy) },
      );
    logger.debug(
      { schedulerId: job.schedulerId, queue: job.queue, everyMs: job.everyMs },
      'schedule registered',
    );
  }

  const health = startHealthServer(opts.metricsPort, 'scheduler', async () => ({
    redis: (await redisHealthy(connection)) ? 'ok' : 'down',
  }));

  return {
    context,
    connection,
    health,
    registeredSchedules: jobs.map((j) => j.schedulerId),
    async stop(): Promise<void> {
      health.close();
      await Promise.allSettled([...queues.values()].map((q) => q.close()));
      await context.close();
      connection.disconnect();
    },
  };
}
