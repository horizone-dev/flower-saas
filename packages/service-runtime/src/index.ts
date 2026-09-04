import { createServer, type Server } from 'node:http';
import { Redis } from 'ioredis';
import type { JobsOptions } from 'bullmq';
import pino, { type Logger } from 'pino';
import { z } from 'zod';

/**
 * Bootstrap plumbing shared by the non-API runtime roles (worker / scheduler /
 * realtime): env parsing, pino logger, Redis connect/health, a tiny health HTTP
 * server, graceful shutdown. NO domain/business logic (CLAUDE.md rule 1).
 *
 * `worker` / `scheduler` / `realtime` stay **separate processes** from
 * `apps/api` (OD-P2-8 / FC-3); they reuse the authoritative domain modules via
 * `@flower/backend`, not by co-locating the runtime — see the ADR-0013
 * amendment.
 */

/**
 * Re-exported so a consumer never needs a direct `pino` dependency just to type
 * a logger parameter (`createLogger` / `createRootLogger` already return one).
 */
export type { Logger };

const baseEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
});

export function parseEnv<T extends z.ZodTypeAny>(
  extra: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> & z.infer<typeof baseEnv> {
  const schema = baseEnv.and(extra);
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data as z.infer<T> & z.infer<typeof baseEnv>;
}

export function createLogger(name: string, level: string, pretty: boolean): Logger {
  const opts = { level, name, redact: ['*.password', '*.secret', '*.token'] };
  return pretty
    ? pino({
        ...opts,
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      })
    : pino(opts);
}

export function createRedis(host: string, port: number): Redis {
  return new Redis({
    host,
    port,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
}

/**
 * A Redis connection tuned for **BullMQ** (worker / scheduler). BullMQ's blocking
 * commands require `maxRetriesPerRequest: null`; it also duplicates this
 * connection internally for its blocking consumers. Pass one shared instance to
 * every `Queue` / `Worker` in a process and close it last on shutdown.
 */
export function createBullConnection(host: string, port: number): Redis {
  return new Redis({
    host,
    port,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
}

/**
 * The default retry / backoff policy for a queued job (constraint 5). Shared by
 * `apps/worker` (which stamps it via `jobOptions` at enqueue time and reads it
 * back to decide when a job has exhausted its attempts) and `apps/scheduler`
 * (which stamps its repeatable-job template with it) — one policy, defined once,
 * so the two processes can never register a job under different retry rules.
 */
export interface RetryPolicy {
  /** total tries, including the first (BullMQ `attempts`) */
  readonly attempts: number;
  /** exponential backoff base delay in ms (BullMQ `backoff.delay`) */
  readonly backoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 5, backoffMs: 1_000 };

export function jobOptions(policy: RetryPolicy = DEFAULT_RETRY_POLICY): JobsOptions {
  return {
    attempts: policy.attempts,
    backoff: { type: 'exponential', delay: policy.backoffMs },
    removeOnComplete: { count: 1_000 },
    removeOnFail: false, // keep the failed record; a dead-letter queue carries the summary
  };
}

/**
 * Establish the connection at boot (lazyConnect). Resolves true once `ready`,
 * false if it cannot connect within `timeoutMs`. Never throws — a service starts
 * in a degraded state and its reconnect handler recovers.
 */
export async function connectRedis(redis: Redis, timeoutMs = 5000): Promise<boolean> {
  const status = (): string => redis.status;
  if (status() === 'ready') return true;
  const canConnect = ['wait', 'close', 'end'].includes(status());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      canConnect
        ? redis.connect()
        : new Promise<void>((resolve) => redis.once('ready', () => resolve())),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('timeout')), timeoutMs);
      }),
    ]);
    return status() === 'ready';
  } catch {
    return false;
  } finally {
    // don't leave the timeout timer holding the event loop open on the happy path (F12)
    if (timer) clearTimeout(timer);
  }
}

/** Ping Redis with a hard timeout; never throws. */
export async function redisHealthy(redis: Redis, timeoutMs = 1000): Promise<boolean> {
  if (redis.status !== 'ready') {
    const connected = await connectRedis(redis, timeoutMs);
    if (!connected) return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('timeout')), timeoutMs);
      }),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface HealthServerOptions {
  /** optional `/metrics` payload (queue depths, DLQ count, …) — served as JSON */
  metrics?: () => Promise<Record<string, unknown>>;
}

/**
 * A tiny health server (no web framework — worker/scheduler serve no REST).
 * `/healthz` = process is up. `/readyz` = deps reachable (200 / 503).
 * `/metrics` = an optional operational snapshot (200, or 503 if it throws).
 */
export function startHealthServer(
  port: number,
  role: string,
  checkReady: () => Promise<Record<string, 'ok' | 'down'>>,
  options: HealthServerOptions = {},
): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', role }));
      return;
    }
    if (url === '/readyz') {
      checkReady()
        .then((checks) => {
          const down = Object.values(checks).includes('down');
          res.writeHead(down ? 503 : 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: down ? 'down' : 'ok', role, checks }));
        })
        .catch((err: unknown) => {
          // a readiness probe must always answer — a throwing check means "not ready" (F11)
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'down', role, error: String(err) }));
        });
      return;
    }
    if (url === '/metrics' && options.metrics) {
      options
        .metrics()
        .then((snapshot) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ role, ...snapshot }));
        })
        .catch((err: unknown) => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ role, error: String(err) }));
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${url}` } }),
    );
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    process.stderr.write(
      `health server (${role}) failed to bind :${port}: ${err.code ?? err.message}\n`,
    );
    process.exit(1);
  });
  server.listen(port);
  return server;
}

/**
 * Wire SIGINT / SIGTERM to a graceful `close`. `close` should drain in-flight
 * work (a BullMQ `worker.close()` waits for the running job) and then release
 * every connection. If `close` does not resolve within `graceMs` the process is
 * force-exited non-zero — a stuck drain must never wedge an orchestrator's
 * rollout. A second signal during shutdown also force-exits.
 */
export function installShutdown(
  logger: Logger,
  close: () => Promise<void>,
  graceMs = 25_000,
): void {
  let shuttingDown = false;
  const handler = (signal: string): void => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal during shutdown — forcing exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal, graceMs }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error({ graceMs }, 'graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, graceMs);
    timer.unref();
    close()
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}
