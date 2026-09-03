import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client/index.js';

export { PrismaClient };
export type { Prisma } from '../generated/client/index.js';

export interface CreateClientOptions {
  /** postgres connection string (direct, not pooled — see ADR-0010 / Task 0.6) */
  connectionString: string;
  /** pino/console-style log levels forwarded to Prisma */
  log?: ('query' | 'info' | 'warn' | 'error')[];
}

/**
 * Build a PrismaClient over a `pg` driver adapter (Prisma 7). One client is shared
 * by api / worker / scheduler. Scoped queries wrap this in an interactive
 * transaction that issues `SET LOCAL app.tenant_id` — that extension lands with
 * the guard pipeline in Phase 1 (verdict: ADR-0010 / Task 0.6).
 */
export function createPrismaClient(opts: CreateClientOptions): PrismaClient {
  const adapter = new PrismaPg({ connectionString: opts.connectionString });
  return new PrismaClient({ adapter, log: opts.log ?? ['warn', 'error'] });
}

/** Read `DATABASE_URL` from the environment or throw. */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}
