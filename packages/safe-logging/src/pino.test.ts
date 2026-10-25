import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { safePinoOptions } from './pino.js';
import { leaked, makeSecrets, prismaLikeError } from './test-support.js';

/** a REAL pino instance with the shared options and an in-memory destination: what a log sink would receive */
function realLogger(extra: Record<string, unknown> = {}): {
  log: pino.Logger;
  lines: () => string[];
  parsed: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const log = pino({ level: 'trace', ...safePinoOptions(), ...extra }, {
    write: (s: string) => void chunks.push(s),
  } as never);
  return {
    log,
    lines: () => chunks.map((c) => c.trim()),
    parsed: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
  };
}

describe('safePinoOptions — real pino output', () => {
  it('err key: safe shape, classification kept, no raw message / stack header / meta', () => {
    const s = makeSecrets();
    const { log, lines, parsed } = realLogger();
    log.error(
      {
        err: prismaLikeError({ value: s.pan }),
        correlationId: 'corr-1',
        path: '/v1/x',
        route: '/v1/:id',
      },
      'unhandled error',
    );
    const rec = parsed()[0]!;
    expect(rec['level']).toBe(50);
    expect(rec['msg']).toBe('unhandled error');
    expect(rec['correlationId']).toBe('corr-1');
    expect(rec['path']).toBe('/v1/x');
    expect(rec['route']).toBe('/v1/:id');
    expect(rec['err']).toMatchObject({
      type: 'PrismaClientKnownRequestError',
      code: 'P2007',
      sqlstate: '22P02',
      operation: 'tx.user.findUnique()',
      message: 'Prisma P2007 on tx.user.findUnique()',
    });
    expect(Object.keys(rec['err'] as object).sort()).toEqual([
      'code',
      'frames',
      'message',
      'model',
      'operation',
      'sqlstate',
      'type',
    ]);
    expect(leaked(lines().join('\n'), s)).toEqual([]);
  });

  it('an Error under ANY other key, and nested in objects and arrays, is serialized safely', () => {
    const s = makeSecrets();
    const { log, lines, parsed } = realLogger();
    log.warn(
      {
        error: prismaLikeError({ value: s.pan }),
        cause: new Error(`x "${s.token}"`),
        failures: [
          new Error(`y ${s.pan}`),
          { inner: { deeper: [prismaLikeError({ value: s.token })] } },
        ],
      },
      'many',
    );
    const rec = parsed()[0]!;
    expect(rec['error']).toMatchObject({ type: 'PrismaClientKnownRequestError', code: 'P2007' });
    expect(rec['cause']).toMatchObject({ type: 'Error', message: 'x "…"' });
    expect(JSON.stringify(rec['failures'])).toContain('P2007');
    expect(leaked(lines().join('\n'), s)).toEqual([]);
  });

  it('an Error as the FIRST ARGUMENT: serialized safely and the raw message is not copied into msg', () => {
    const s = makeSecrets();
    const { log, lines, parsed } = realLogger();
    log.error(prismaLikeError({ value: s.pan }));
    log.error(new Error(`first "${s.password}"`), 'given message');
    log.error(new Error(`only "${s.person}"`));
    const [a, b, c] = parsed();
    expect(a!['msg']).toBe('Prisma P2007 on tx.user.findUnique()');
    expect(b!['msg']).toBe('given message');
    expect(c!['msg']).toBe('only "…"');
    expect((a!['err'] as { code: string }).code).toBe('P2007');
    expect(leaked(lines().join('\n'), s)).toEqual([]);
  });

  it('message strings and %s interpolation arguments are templated (interpolated application messages)', () => {
    const s = makeSecrets();
    const { log, lines, parsed } = realLogger();
    log.warn({ code: 'X' }, `unknown account key "${s.person}" for ${s.email}`);
    log.warn('failed for %s and %s', s.pan, `"${s.token}"`);
    log.info(`plain ${s.pan}`);
    log.warn({ a: 1 }, 'with an Error arg %s', new Error(`boom "${s.password}"`));
    const [m1, m2] = parsed();
    expect(m1!['msg']).toBe('unknown account key "…" for <email>');
    expect(m2!['msg']).toBe('failed for # and "…"');
    expect(leaked(lines().join('\n'), s)).toEqual([]);
  });

  it('child-logger bindings carrying err go through the err serializer', () => {
    const s = makeSecrets();
    const { log, lines, parsed } = realLogger();
    log.child({ err: prismaLikeError({ value: s.pan }), component: 'x' }).info('bound');
    expect(parsed()[0]!['err']).toMatchObject({ code: 'P2007' });
    expect(parsed()[0]!['component']).toBe('x');
    expect(leaked(lines().join('\n'), s)).toEqual([]);
  });

  it('is robust to circular objects and non-plain values, and preserves levels and ordinary fields', () => {
    const { log, parsed } = realLogger();
    const circ: Record<string, unknown> = { n: 1 };
    circ['self'] = circ;
    expect(() =>
      log.info({ circ, when: new Date(0), buf: Buffer.from('ab'), n: 5, ok: true, nothing: null }),
    ).not.toThrow();
    const rec = parsed()[0]!;
    expect(rec['n']).toBe(5);
    expect(rec['ok']).toBe(true);
    expect(rec['nothing']).toBeNull();
    log.trace('t');
    log.debug('d');
    log.fatal('f');
    expect(parsed().map((r) => r['level'])).toEqual([30, 10, 20, 60]);
  });

  it('keeps the redact paths working alongside the shared options', () => {
    const { log, lines } = realLogger({ redact: { paths: ['*.password'], censor: '[redacted]' } });
    log.info({ user: { password: 'x-pass', name: 'ok' } }, 'redaction still applies');
    expect(lines().join('')).toContain('[redacted]');
    expect(lines().join('')).not.toContain('x-pass');
  });
});
