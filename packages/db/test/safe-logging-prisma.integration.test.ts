import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serializeSafeError, type SafePrismaLog } from '@flower/safe-logging';
import { createPrismaClient, type PrismaClient } from '../src/client.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.11 S-1 — REAL Prisma 7.10 errors and log events against a real PostgreSQL, with SYNTHETIC values only.
 *
 * Proves: (1) a real P2007 error object is reduced to its allowlisted shape by the shared serializer, (2) Prisma's own log
 * events are delivered through the sanitized event path, and (3) none of Prisma's console / stdout / stderr channels prints
 * the rejected value any more (the previously confirmed leak: `prisma:error` + the full message through `console.log`).
 */

function luhnPan(): string {
  let body = '999999';
  while (body.length < 15) body += String(randomInt(0, 10));
  const valid = (d: string): boolean => {
    let sum = 0;
    let dbl = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = d.charCodeAt(i) - 48;
      if (dbl) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  };
  for (let c = 0; c <= 9; c++) if (valid(body + String(c))) return body + String(c);
  throw new Error('unreachable');
}

describe('packages/db — Prisma errors and log events are sanitized (S-1)', () => {
  let container: StartedPostgreSqlContainer;
  let url = '';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    url = container.getConnectionUri();
    execFileSync(
      'node',
      [path.join(pkgDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: pkgDir,
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
      },
    );
  }, 240_000);

  afterAll(async () => {
    await container?.stop();
  });

  /** runs `fn` while recording every console / stdout / stderr write */
  async function capturing<T>(fn: () => Promise<T>): Promise<{ result: T; channels: string[] }> {
    const seen: string[] = [];
    const undo: (() => void)[] = [];
    const wrap = (obj: Record<string, unknown>, key: string, label: string): void => {
      const orig = obj[key] as (...a: unknown[]) => unknown;
      obj[key] = (...a: unknown[]): unknown => {
        seen.push(
          `${label}: ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`,
        );
        return orig.apply(obj, a);
      };
      undo.push(() => {
        obj[key] = orig;
      });
    };
    for (const k of ['log', 'info', 'warn', 'error', 'debug'])
      wrap(console as unknown as Record<string, unknown>, k, `console.${k}`);
    wrap(process.stdout as unknown as Record<string, unknown>, 'write', 'stdout');
    wrap(process.stderr as unknown as Record<string, unknown>, 'write', 'stderr');
    try {
      return { result: await fn(), channels: seen };
    } finally {
      for (const u of undo) u();
    }
  }

  async function failQuery(client: PrismaClient, value: string): Promise<unknown> {
    try {
      await client.user.findUnique({ where: { id: value } });
    } catch (e) {
      return e;
    }
    throw new Error('expected the query to be rejected');
  }

  it('a REAL P2007 error: the shared serializer keeps type / code / SQLSTATE / operation and drops the value', async () => {
    const pan = luhnPan();
    const client = createPrismaClient({ connectionString: url, onLogEvent: () => undefined });
    try {
      const err = await failQuery(client, pan);
      expect((err as Error).message).toContain(pan); // the raw error DOES carry the value — that is what the serializer must remove
      const safe = serializeSafeError(err);
      expect(safe.type).toBe('PrismaClientKnownRequestError');
      expect(safe.code).toBe('P2007');
      expect(safe.sqlstate).toBe('22P02');
      expect(safe.operation).toMatch(/findUnique\(\)$/);
      expect(safe.message).toMatch(/^Prisma P2007 on /);
      expect(safe.frames.length).toBeGreaterThan(0);
      expect(JSON.stringify(safe)).not.toContain(pan);
      expect(Object.keys(safe).sort()).toEqual(
        ['code', 'frames', 'message', 'model', 'operation', 'sqlstate', 'type'].sort(),
      );
    } finally {
      await client.$disconnect();
    }
  }, 120_000);

  it('Prisma log events arrive ONLY as sanitized records (operation, site, code, templated reason) — no value, no excerpt', async () => {
    const pan = luhnPan();
    const events: SafePrismaLog[] = [];
    const client = createPrismaClient({ connectionString: url, onLogEvent: (e) => events.push(e) });
    try {
      const { channels } = await capturing(async () => failQuery(client, pan));
      expect(events.length).toBeGreaterThan(0);
      const err = events.find((e) => e.level === 'error');
      expect(err).toBeDefined();
      expect(err?.operation).toMatch(/findUnique\(\)$/);
      expect(err?.target).toBe('user.findUnique');
      expect(err?.site).toMatch(/\.ts:\d+:\d+$/);
      expect(JSON.stringify(events)).not.toContain(pan);
      expect(JSON.stringify(events)).not.toContain('where:');
      // Prisma's own channels printed nothing at all
      expect(channels).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  }, 120_000);

  it('the DEFAULT sink writes one sanitized JSON line to stderr and nothing to console / stdout (the confirmed leak is closed)', async () => {
    const pan = luhnPan();
    const client = createPrismaClient({ connectionString: url });
    try {
      const { channels } = await capturing(async () => failQuery(client, pan));
      expect(channels.length).toBeGreaterThan(0);
      expect(channels.every((c) => c.startsWith('stderr: '))).toBe(true);
      const joined = channels.join('\n');
      expect(joined).not.toContain(pan);
      const line = JSON.parse(channels[0]!.slice('stderr: '.length)) as {
        level: number;
        name: string;
        msg: string;
        prisma: Record<string, string>;
      };
      expect(line.level).toBe(50);
      expect(line.name).toBe('prisma');
      expect(line.prisma['operation']).toMatch(/findUnique\(\)$/);
      expect(line.prisma['target']).toBe('user.findUnique');
    } finally {
      await client.$disconnect();
    }
  }, 120_000);

  it('events are still delivered after `$extends` (handlers live on the base client) and still sanitized', async () => {
    const pan = luhnPan();
    const events: SafePrismaLog[] = [];
    const base = createPrismaClient({ connectionString: url, onLogEvent: (e) => events.push(e) });
    const extended = base.$extends({}) as unknown as PrismaClient;
    try {
      await capturing(async () => failQuery(extended, pan));
      expect(events.some((e) => e.level === 'error' && e.operation)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(pan);
    } finally {
      await base.$disconnect();
    }
  }, 120_000);

  it('a throwing sink cannot break a query and never falls back to printing the raw event', async () => {
    const pan = luhnPan();
    const client = createPrismaClient({
      connectionString: url,
      onLogEvent: () => {
        throw new Error(`sink exploded ${randomUUID()}`);
      },
    });
    try {
      const { result, channels } = await capturing(async () => failQuery(client, pan));
      expect((result as Error).name).toBe('PrismaClientKnownRequestError'); // the caller still receives the real error
      expect(channels.join('\n')).not.toContain(pan);
    } finally {
      await client.$disconnect();
    }
  }, 120_000);
});
