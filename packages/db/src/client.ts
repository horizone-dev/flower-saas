import { PrismaPg } from '@prisma/adapter-pg';
import {
  summarizePrismaLogEvent,
  type PrismaLogEventLike,
  type SafePrismaLog,
} from '@flower/safe-logging';
import { PrismaClient } from '../generated/client/index.js';

export { PrismaClient };
export type { Prisma } from '../generated/client/index.js';

export interface CreateClientOptions {
  /** postgres connection string (direct, not pooled — see ADR-0010 / Task 0.6) */
  connectionString: string;
  /** Prisma log levels that are surfaced (as SANITIZED events — see `onLogEvent`) */
  log?: ('query' | 'info' | 'warn' | 'error')[];
  /**
   * Receives every Prisma log event AFTER `@flower/safe-logging` reduced it to an allowlisted record (level, operation,
   * source location, Prisma code, one templated line — never the arguments, the rejected value or the SQL parameters).
   * Default: one JSON line on stderr. Prisma's own console output is never used: its `error` text quotes the rejected value.
   */
  onLogEvent?: (event: SafePrismaLog) => void;
}

const PINO_LEVEL: Record<SafePrismaLog['level'], number> = {
  query: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/** the default sink: a pino-shaped JSON line on stderr carrying only the sanitized record */
function stderrSink(event: SafePrismaLog): void {
  const { level, message, ...fields } = event;
  process.stderr.write(
    `${JSON.stringify({ level: PINO_LEVEL[level], time: Date.now(), name: 'prisma', msg: message, prisma: fields })}
`,
  );
}

interface EventSource {
  $on(eventType: string, callback: (event: PrismaLogEventLike) => void): unknown;
}

/**
 * Build a PrismaClient over a `pg` driver adapter (Prisma 7). One client is shared
 * by api / worker / scheduler. Scoped queries wrap this in an interactive
 * transaction that issues `SET LOCAL app.tenant_id` — that extension lands with
 * the guard pipeline in Phase 1 (verdict: ADR-0010 / Task 0.6).
 */
export function createPrismaClient(opts: CreateClientOptions): PrismaClient {
  const adapter = new PrismaPg({ connectionString: opts.connectionString });
  const levels = opts.log ?? ['warn', 'error'];
  const sink = opts.onLogEvent ?? stderrSink;
  // Event emission (not Prisma's default stdout logging): every event is sanitized below before it can reach any output.
  // The handlers are registered on THIS base client, before any `$extends` — extended clients do not expose `$on`.
  const client = new PrismaClient({
    adapter,
    log: levels.map((level) => ({ emit: 'event' as const, level })),
  });
  for (const level of levels) {
    (client as unknown as EventSource).$on(level, (event) => {
      try {
        sink(summarizePrismaLogEvent(level, event));
      } catch {
        // logging must never break a query, and must never fall back to printing the raw event
      }
    });
  }
  return client;
}

/** Read `DATABASE_URL` from the environment or throw. */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}
