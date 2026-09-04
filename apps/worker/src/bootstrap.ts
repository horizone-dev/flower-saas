import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  type Logger,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  createBullConnection,
  createRedis,
  connectRedis,
  redisHealthy,
  startHealthServer,
} from '@flower/service-runtime';
import { DbService } from '@flower/backend';
import type { Server } from 'node:http';
import { WorkerModule } from './worker.module.js';
import { ProcessorRegistry } from './processor-registry.js';
import { probeProcessor } from './processors/probe.processor.js';
import { QUEUES, type QueueName } from './queues.js';
import { OutboxDispatcher, type OutboxDispatcherOptions } from './outbox/dispatcher.js';
import { RealtimeRelay, type RealtimeRelayOptions } from './realtime-relay/relay-loop.js';

export interface WorkerRuntimeOptions {
  readonly redisHost: string;
  readonly redisPort: number;
  readonly metricsPort: number;
  readonly logger: Logger;
  readonly retryPolicy?: RetryPolicy;
  /** fail fast if Redis is not reachable within this window (documented policy) */
  readonly redisConnectTimeoutMs?: number;
  /** outbox dispatcher tuning (task 2.4) — all optional, sane defaults apply */
  readonly outbox?: Partial<Omit<OutboxDispatcherOptions, 'db' | 'redis' | 'logger'>>;
  /** realtime relay tuning (task 2.5) — all optional, sane defaults apply */
  readonly relay?: Partial<Omit<RealtimeRelayOptions, 'redis' | 'logger'>>;
}

export interface WorkerRuntime {
  readonly context: INestApplicationContext;
  readonly registry: ProcessorRegistry;
  readonly connection: Redis;
  readonly dispatcher: OutboxDispatcher;
  readonly relay: RealtimeRelay;
  readonly health: Server;
  stop(): Promise<void>;
}

/**
 * Boot the worker: a Nest application context over `@flower/backend`, a BullMQ
 * connection, the processor registry (Phase 2-core: the probe only) and a health
 * server.
 *
 * **Redis-at-startup policy (constraint 8):** the worker's entire purpose is to
 * consume Redis-backed queues, so if Redis is unreachable at boot it **fails
 * fast** (throws) — the orchestrator restarts the process rather than leaving a
 * silent, job-less worker running. Redis lost *after* boot is handled by
 * ioredis reconnection + the readiness probe flipping to 503.
 */
export async function bootstrapWorker(opts: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const { logger } = opts;
  const retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;

  const context = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
  context.enableShutdownHooks();

  const connection = createBullConnection(opts.redisHost, opts.redisPort);
  if (!(await connectRedis(connection, opts.redisConnectTimeoutMs ?? 5_000))) {
    await context.close();
    connection.disconnect();
    throw new Error(
      `Redis unreachable at ${opts.redisHost}:${opts.redisPort} — the worker cannot consume queues`,
    );
  }

  const registry = new ProcessorRegistry(retryPolicy);
  registry.register({ queue: 'probe', handler: probeProcessor });
  registry.start(connection, logger);

  const metricsQueues = new Map<QueueName, Queue>(
    QUEUES.map((name) => [name, new Queue(name, { connection })] as const),
  );

  // A dedicated connection for XADD (task 2.4) — separate from the BullMQ
  // connection above (different tuning: no blocking commands, fails a command
  // fast rather than queuing it offline, matching the dispatcher's own
  // attempts/backoff loop rather than ioredis retrying silently underneath it).
  // Redis is already known reachable (the fail-fast check above passed).
  //
  // **Explicitly connected — a real bug, found by task 2.5's compiled-runtime
  // smoke test, not a test.** `createRedis` builds a `lazyConnect: true,
  // enableOfflineQueue: false` client. On an EMPTY database the dispatcher's
  // first several ticks never reach an actual `outboxRedis` command at all
  // (`discoverPublishableTenants`/allocation are Postgres-only) — so this gap
  // stayed latent through all of task 2.4's own verification, which always
  // inserted a row *some time after* boot. The task 2.5 relay's very first
  // command (`SCAN`) fires immediately at boot regardless of whether there is
  // any data yet, surfacing it immediately: "Stream isn't writeable and
  // enableOfflineQueue options is false" — `lazyConnect` does not itself
  // guarantee a command issued the instant a tick starts finds a `'ready'`
  // connection. Every dedicated Redis connection this file hands to a loop
  // that `.start()`s immediately at boot must be explicitly connected first.
  const outboxRedis = createRedis(opts.redisHost, opts.redisPort);
  await connectRedis(outboxRedis, opts.redisConnectTimeoutMs ?? 5_000);

  const dispatcher = new OutboxDispatcher({
    db: context.get(DbService),
    redis: outboxRedis,
    logger,
    ...opts.outbox,
  });
  dispatcher.start();

  // A third dedicated connection (task 2.5) — separate from both the BullMQ
  // connection and the outbox dispatcher's XADD connection, matching this
  // file's existing one-connection-per-distinct-workload pattern (independent
  // failure isolation; none of the relay's commands are blocking, so a shared
  // connection would have worked too, but keeping workloads on separate
  // connections avoids any subtle cross-workload pipelining interference).
  const relayRedis = createRedis(opts.redisHost, opts.redisPort);
  await connectRedis(relayRedis, opts.redisConnectTimeoutMs ?? 5_000);
  const relay = new RealtimeRelay({
    redis: relayRedis,
    logger,
    ...opts.relay,
  });
  relay.start();

  const health = startHealthServer(
    opts.metricsPort,
    'worker',
    async () => ({
      redis: (await redisHealthy(connection)) ? 'ok' : 'down',
      outboxRedis: (await redisHealthy(outboxRedis)) ? 'ok' : 'down',
      relayRedis: (await redisHealthy(relayRedis)) ? 'ok' : 'down',
    }),
    {
      metrics: async () => {
        const counts: Record<string, unknown> = {};
        for (const [name, q] of metricsQueues) counts[name] = await q.getJobCounts();
        return { registeredQueues: registry.registeredQueues, queues: counts };
      },
    },
  );

  return {
    context,
    registry,
    connection,
    dispatcher,
    relay,
    health,
    async stop(): Promise<void> {
      health.close();
      await dispatcher.stop();
      await relay.stop();
      await registry.stop();
      await Promise.allSettled([...metricsQueues.values()].map((q) => q.close()));
      await context.close();
      connection.disconnect();
      outboxRedis.disconnect();
      relayRedis.disconnect();
    },
  };
}
