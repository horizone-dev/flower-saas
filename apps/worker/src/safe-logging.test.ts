import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@flower/service-runtime';
import { OutboxDispatcher } from './outbox/dispatcher.js';
import { RealtimeRelay } from './realtime-relay/relay-loop.js';

const { allocateTenantSeq, discoverUnstampedTenants } = vi.hoisted(() => ({
  allocateTenantSeq: vi.fn(),
  discoverUnstampedTenants: vi.fn(),
}));
vi.mock('./outbox/seq-allocator.js', () => ({ allocateTenantSeq, discoverUnstampedTenants }));
const { publishReadyAcrossTenants } = vi.hoisted(() => ({ publishReadyAcrossTenants: vi.fn() }));
vi.mock('./outbox/publisher.js', () => ({ publishReadyAcrossTenants }));
const { relayTick } = vi.hoisted(() => ({ relayTick: vi.fn() }));
vi.mock('./realtime-relay/relay.js', () => ({ relayTick }));

/**
 * Task 3b.11 S-1 — worker / scheduler / realtime logging, through the REAL `createLogger` of `@flower/service-runtime`
 * (the single logger factory of those three runtimes) and the REAL worker error paths (`OutboxDispatcher`,
 * `RealtimeRelay`). Synthetic secrets only.
 */

function pan(): string {
  let body = '999999';
  while (body.length < 15) body += String(randomInt(0, 10));
  const ok = (d: string): boolean => {
    let s = 0;
    let dbl = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = d.charCodeAt(i) - 48;
      if (dbl) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      s += n;
      dbl = !dbl;
    }
    return s % 10 === 0;
  };
  for (let c = 0; c <= 9; c++) if (ok(body + String(c))) return body + String(c);
  throw new Error('unreachable');
}

/** an error shaped like a Prisma 7 validation error (name, code, meta, message + excerpt carrying the value) */
function prismaLike(value: string): Error {
  const message = `\nInvalid \`tx.outbox.update()\` invocation in\nC:/ci/flower/apps/worker/src/outbox/x.ts:10:5\n\n  9 await tx.outbox.update({\n→ 10   where: { id: "${value}" },\n\nInconsistent column data: invalid input syntax for type uuid: "${value}"`;
  const e = Object.assign(new Error(message), {
    code: 'P2007',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Outbox',
      driverAdapterError: { cause: { originalCode: '22P02', originalMessage: `uuid: "${value}"` } },
    },
  });
  e.name = 'PrismaClientKnownRequestError';
  return e;
}

function realLogger(role: string): {
  log: ReturnType<typeof createLogger>;
  text: () => string;
  records: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const log = createLogger(role, 'trace', false, {
    write: (s: string) => void chunks.push(s),
  } as never);
  return {
    log,
    text: () => chunks.join(''),
    records: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
  };
}

describe('worker / scheduler / realtime — the real logger factory', () => {
  for (const role of ['worker', 'scheduler', 'realtime']) {
    it(`${role}: err / other keys / first-argument errors / interpolated messages never carry the raw value`, () => {
      const secret = pan();
      const { log, text, records } = realLogger(role);
      log.error(
        { err: prismaLike(secret), tenantId: 't-1' },
        'outbox dispatcher: seq allocation failed for tenant',
      );
      log.error({ failure: prismaLike(secret) }, 'under another key');
      log.error(prismaLike(secret));
      log.warn(`candidate failed for "${secret}" (${secret})`);
      expect(text()).not.toContain(secret);
      const first = records()[0]!;
      expect(first['name']).toBe(role);
      expect(first['tenantId']).toBe('t-1');
      expect(first['err']).toMatchObject({
        type: 'PrismaClientKnownRequestError',
        code: 'P2007',
        sqlstate: '22P02',
        operation: 'tx.outbox.update()',
      });
    });
  }
});

describe('worker — real OutboxDispatcher and RealtimeRelay error paths', () => {
  it('a poisoned tenant allocation is logged with the safe shape and the loop continues', async () => {
    const secret = pan();
    const { log, text, records } = realLogger('worker');
    discoverUnstampedTenants.mockResolvedValue(['bad', 'ok']);
    allocateTenantSeq.mockImplementation((_db: unknown, id: string) =>
      id === 'bad'
        ? Promise.reject(prismaLike(secret))
        : Promise.resolve({ leader: true, stamped: 1 }),
    );
    publishReadyAcrossTenants.mockResolvedValue({ published: 0, failed: 0 });
    const dispatcher = new OutboxDispatcher({ db: {} as never, redis: {} as never, logger: log });
    const result = await dispatcher.tick();
    expect(result.stamped).toBe(1); // behaviour unchanged: the other tenant is still served
    expect(text()).not.toContain(secret);
    const rec = records().find(
      (r) => r['msg'] === 'outbox dispatcher: seq allocation failed for tenant',
    )!;
    expect(rec['level']).toBe(50);
    expect(rec['tenantId']).toBe('bad');
    expect((rec['err'] as { code: string }).code).toBe('P2007');
  });

  it('a failing dispatcher tick and a failing relay tick are logged safely', async () => {
    const secret = pan();
    const { log, text, records } = realLogger('worker');
    discoverUnstampedTenants.mockRejectedValue(prismaLike(secret));
    const dispatcher = new OutboxDispatcher({
      db: {} as never,
      redis: {} as never,
      logger: log,
      tickIntervalMs: 5,
    });
    dispatcher.start();
    relayTick.mockRejectedValue(prismaLike(secret));
    const relay = new RealtimeRelay({ redis: {} as never, logger: log, tickIntervalMs: 5 });
    relay.start();
    await new Promise((r) => setTimeout(r, 40));
    await dispatcher.stop();
    await relay.stop();
    const msgs = records().map((r) => r['msg']);
    expect(msgs).toContain('outbox dispatcher tick failed');
    expect(msgs).toContain('realtime relay tick failed');
    expect(text()).not.toContain(secret);
  });
});

describe('every non-API runtime builds its logger through the one safe factory', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const APPS = resolve(HERE, '../../');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (p.endsWith('.ts') && !/\.test\.ts$/.test(p)) out.push(p);
    }
    return out;
  };

  it('worker, scheduler and realtime call createLogger(…) in main.ts, and no app constructs a pino logger of its own', () => {
    for (const app of ['worker', 'scheduler', 'realtime']) {
      const main = readFileSync(join(APPS, app, 'src/main.ts'), 'utf8');
      expect(main, `${app} main.ts`).toMatch(/createLogger\(\s*'/);
    }
    for (const app of ['worker', 'scheduler', 'realtime', 'api']) {
      for (const file of walk(join(APPS, app, 'src'))) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bpino\s*\(/);
      }
    }
  });
});
