import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRootLogger, REDACT_PATHS } from './logger.js';

/**
 * Task 3b.11 S-1 — the API/backend logger factory with its REAL production options (only the destination is replaced, so
 * the serialized output can be read). Synthetic secrets only.
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

function prismaLike(value: string): Error {
  const message = `\nInvalid \`tx.user.findUnique()\` invocation in\nC:/ci/flower/apps/api/src/modules/access/access.repository.ts:81:34\n\n→ 81   where: { id: "${value}" },\n\nInconsistent column data: Invalid input value: invalid input syntax for type uuid: "${value}"`;
  const e = Object.assign(new Error(message), {
    code: 'P2007',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'User',
      driverAdapterError: { cause: { originalCode: '22P02', originalMessage: `uuid: "${value}"` } },
    },
  });
  e.name = 'PrismaClientKnownRequestError';
  return e;
}

function realLogger(): {
  log: ReturnType<typeof createRootLogger>;
  text: () => string;
  records: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const log = createRootLogger({ write: (s: string) => void chunks.push(s) } as never);
  log.level = 'trace'; // the test environment sets LOG_LEVEL=silent
  return {
    log,
    text: () => chunks.join(''),
    records: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
  };
}

describe('createRootLogger — real options, real pino output', () => {
  it('the exception-filter shape: safe err, correlation id, path and route are all preserved', () => {
    const secret = pan();
    const { log, text, records } = realLogger();
    log.error(
      {
        err: prismaLike(secret),
        correlationId: 'corr-9',
        path: '/v1/access/users/[digits]',
        route: '/v1/access/users/:userId',
      },
      'unhandled error',
    );
    const rec = records()[0]!;
    expect(rec['level']).toBe(50);
    expect(rec['msg']).toBe('unhandled error');
    expect(rec['correlationId']).toBe('corr-9');
    expect(rec['route']).toBe('/v1/access/users/:userId');
    expect(rec['err']).toMatchObject({
      type: 'PrismaClientKnownRequestError',
      code: 'P2007',
      sqlstate: '22P02',
      operation: 'tx.user.findUnique()',
      model: 'User',
    });
    expect(text()).not.toContain(secret);
  });

  it('errors under other keys, nested, as the first argument, and in interpolated messages', () => {
    const secret = pan();
    const { log, text } = realLogger();
    log.warn(
      { error: prismaLike(secret), batch: [{ cause: prismaLike(secret) }] },
      `unknown account key "${secret}"`,
    );
    log.error(prismaLike(secret));
    log.error(new Error(`plain "${secret}" ${secret}`), 'with given message');
    log.info('fmt %s', secret);
    expect(text()).not.toContain(secret);
  });

  it('the redact paths still apply', () => {
    const { log, text } = realLogger();
    log.info(
      { req: { headers: { authorization: 'Bearer abc' } }, user: { password: 'pw-123' } },
      'redaction',
    );
    expect(text()).not.toContain('Bearer abc');
    expect(text()).not.toContain('pw-123');
    expect(REDACT_PATHS).toContain('req.headers.authorization');
  });
});
