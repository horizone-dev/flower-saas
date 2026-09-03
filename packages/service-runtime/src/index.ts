import { createServer, type Server } from 'node:http';
import { Redis } from 'ioredis';
import pino, { type Logger } from 'pino';
import { z } from 'zod';

/**
 * Bootstrap plumbing shared by the non-API runtime roles (worker / scheduler /
 * realtime): env parsing, pino logger, Redis connect/health, a tiny health HTTP
 * server, graceful shutdown. NO domain/business logic (CLAUDE.md rule 1). Phase 2
 * folds these processes onto the apps/api domain modules — see ADR-0013.
 */

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
 * Establish the connection at boot (lazyConnect). Resolves true once `ready`,
 * false if it cannot connect within `timeoutMs`. Never throws — a service starts
 * in a degraded state and its reconnect handler recovers.
 */
export async function connectRedis(redis: Redis, timeoutMs = 5000): Promise<boolean> {
  const status = (): string => redis.status;
  if (status() === 'ready') return true;
  const canConnect = ['wait', 'close', 'end'].includes(status());
  try {
    await Promise.race([
      canConnect
        ? redis.connect()
        : new Promise<void>((resolve) => redis.once('ready', () => resolve())),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return status() === 'ready';
  } catch {
    return false;
  }
}

/** Ping Redis with a hard timeout; never throws. */
export async function redisHealthy(redis: Redis, timeoutMs = 1000): Promise<boolean> {
  if (redis.status !== 'ready') {
    const connected = await connectRedis(redis, timeoutMs);
    if (!connected) return false;
  }
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * A tiny health server (no web framework — worker/scheduler serve no REST).
 * `/healthz` = process is up. `/readyz` = deps reachable (200 / 503).
 */
export function startHealthServer(
  port: number,
  role: string,
  checkReady: () => Promise<Record<string, 'ok' | 'down'>>,
): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', role }));
      return;
    }
    if (url === '/readyz') {
      void checkReady().then((checks) => {
        const down = Object.values(checks).includes('down');
        res.writeHead(down ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: down ? 'down' : 'ok', role, checks }));
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

export function installShutdown(logger: Logger, close: () => Promise<void>): void {
  const handler = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}
