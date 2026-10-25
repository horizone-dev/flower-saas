import { describe, expect, it } from 'vitest';
import { isSafeError, serializeSafeError, type SafeError } from './safe-error.js';
import { leaked, makeSecrets, prismaLikeError } from './test-support.js';

const ALLOWED_KEYS = new Set([
  'type',
  'code',
  'sqlstate',
  'operation',
  'model',
  'target',
  'message',
  'frames',
  'cause',
  'errors',
]);
const walkKeys = (e: SafeError, out: Set<string> = new Set()): Set<string> => {
  for (const k of Object.keys(e)) out.add(k);
  if (e.cause) walkKeys(e.cause, out);
  for (const x of e.errors ?? []) walkKeys(x, out);
  return out;
};

describe('serializeSafeError — Prisma-shaped errors', () => {
  it('keeps classification and diagnostics, and none of the request-controlled value (P2007)', () => {
    const s = makeSecrets();
    const out = serializeSafeError(prismaLikeError({ value: s.pan }));
    expect(out.type).toBe('PrismaClientKnownRequestError');
    expect(out.code).toBe('P2007');
    expect(out.sqlstate).toBe('22P02');
    expect(out.operation).toBe('tx.user.findUnique()');
    expect(out.model).toBe('User');
    expect(out.message).toBe('Prisma P2007 on tx.user.findUnique()');
    expect(out.frames.length).toBe(3);
    expect(out.frames[1]).toBe(
      'AccessRepository.loadUser (apps/api/src/modules/access/access.repository.ts:81:34)',
    );
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });

  it('never emits the stack header, the source excerpt, the arguments dump or the raw meta', () => {
    const s = makeSecrets();
    const text = JSON.stringify(serializeSafeError(prismaLikeError({ value: s.token })));
    for (const forbidden of [
      'Inconsistent column data',
      'where:',
      'originalMessage',
      'driverAdapterError',
      'invalid input syntax',
      'async loadUser',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(leaked(text, s)).toEqual([]);
  });

  it('handles other Prisma codes, including constraint targets, without the value', () => {
    const s = makeSecrets();
    const e = prismaLikeError({ code: 'P2002', value: s.email, sqlstate: '23505' }) as Error & {
      meta: Record<string, unknown>;
    };
    e.meta = {
      modelName: 'Customer',
      target: ['email', 'tenantId'],
      driverAdapterError: {
        cause: { originalCode: '23505', originalMessage: `duplicate key value (${s.email})` },
      },
    };
    const out = serializeSafeError(e);
    expect(out.code).toBe('P2002');
    expect(out.sqlstate).toBe('23505');
    expect(out.target).toEqual(['email', 'tenantId']);
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });

  it('drops a hostile operation or target that is not identifier-shaped', () => {
    const s = makeSecrets();
    const e = prismaLikeError({ value: 'x' }) as Error & { meta: Record<string, unknown> };
    e.message = `Invalid \`${s.token} with spaces\` invocation in\nfile.ts:1:1\n\nreason`;
    e.meta = { target: [s.person, 'ok_column'], modelName: s.password };
    const out = serializeSafeError(e);
    expect(out.operation).toBeUndefined();
    expect(out.model).toBeUndefined();
    expect(out.target).toEqual(['ok_column']);
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });
});

describe('serializeSafeError — plain errors', () => {
  it('templates the message: quoted values, e-mails, tokens and digit runs are replaced, the sentence survives', () => {
    const s = makeSecrets();
    const out = serializeSafeError(new Error(`runScoped: tenantId is not a UUID: "${s.pan}"`));
    expect(out.message).toBe('runScoped: tenantId is not a UUID: "…"');
    const unquoted = serializeSafeError(
      new RangeError(`amount rejected (got ${s.pan}) for ${s.email} using ${s.token}`),
    );
    expect(unquoted.type).toBe('RangeError');
    expect(unquoted.message).toBe('amount rejected (got #) for <email> using <token>');
    expect(leaked(JSON.stringify([out, unquoted]), s)).toEqual([]);
  });

  it('uses only the first line of a multi-line message', () => {
    const s = makeSecrets();
    const out = serializeSafeError(
      new Error(`first line is safe\nsecond line holds ${s.person}\nthird ${s.password}`),
    );
    expect(out.message).toBe('first line is safe');
  });

  it('drops arbitrary enumerable properties (request bodies, response data, inputs)', () => {
    const s = makeSecrets();
    const e = Object.assign(new Error('boom'), {
      details: [{ field: 'x', issue: s.person }],
      input: { password: s.password },
      response: { status: 400, data: { card: s.pan } },
      config: { headers: { authorization: `Bearer ${s.token}` } },
      code: 'ECONNRESET',
    });
    const out = serializeSafeError(e);
    expect(out.code).toBe('ECONNRESET');
    expect([...walkKeys(out)].every((k) => ALLOWED_KEYS.has(k))).toBe(true);
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });

  it('accepts numeric and rejects hostile codes', () => {
    const s = makeSecrets();
    expect(serializeSafeError(Object.assign(new Error('x'), { code: 42 })).code).toBe('42');
    expect(
      serializeSafeError(Object.assign(new Error('x'), { code: s.password })).code,
    ).toBeUndefined();
    expect(
      serializeSafeError(Object.assign(new Error('x'), { code: 'lower case' })).code,
    ).toBeUndefined();
  });
});

describe('serializeSafeError — causes, aggregates and odd values', () => {
  it('sanitizes a nested cause chain, depth-limited', () => {
    const s = makeSecrets();
    let e: Error = new Error(`level4 ${s.password}`);
    for (let i = 3; i >= 0; i--) e = Object.assign(new Error(`level${i} "${s.pan}"`), { cause: e });
    const out = serializeSafeError(e);
    let depth = 0;
    for (let c: SafeError | undefined = out; c; c = c.cause) depth++;
    expect(depth).toBeLessThanOrEqual(4);
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });

  it('sanitizes AggregateError members and caps them', () => {
    const s = makeSecrets();
    const members = Array.from({ length: 9 }, (_, i) =>
      prismaLikeError({ value: i % 2 ? s.pan : s.token }),
    );
    const out = serializeSafeError(new AggregateError(members, `many failed: "${s.person}"`));
    expect(out.type).toBe('AggregateError');
    expect(out.errors?.length).toBe(5);
    expect(out.errors?.[0]?.code).toBe('P2007');
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });

  it('survives circular causes, throwing getters and proxies without throwing', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(() => serializeSafeError(a)).not.toThrow();
    const hostile = new Error('h');
    Object.defineProperty(hostile, 'code', {
      get: () => {
        throw new Error('getter');
      },
    });
    Object.defineProperty(hostile, 'stack', {
      get: () => {
        throw new Error('getter');
      },
    });
    expect(serializeSafeError(hostile).message).toBe('h');
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        has() {
          throw new Error('trap');
        },
      },
    );
    expect(() => serializeSafeError(proxy)).not.toThrow();
    expect(serializeSafeError(proxy).type).toBe('object');
  });

  it('serializes non-Error values as a classified, templated stub', () => {
    const s = makeSecrets();
    expect(serializeSafeError(`failed for "${s.person}" with ${s.pan}`)).toMatchObject({
      type: 'string',
      message: 'failed for "…" with #',
      frames: [],
    });
    expect(serializeSafeError({ secret: s.password, nested: { pan: s.pan } })).toMatchObject({
      type: 'object',
      message: '[non-error object]',
    });
    expect(serializeSafeError(null)).toMatchObject({
      type: 'object',
      message: '[non-error value]',
    });
    expect(serializeSafeError(12345678)).toMatchObject({ type: 'number' });
    const asObject = serializeSafeError({ message: `x "${s.pan}"`, name: 'CustomFailure' });
    expect(asObject.type).toBe('CustomFailure');
    expect(asObject.message).toBe('x "…"');
  });

  it('is idempotent, and only trusts objects it produced itself', () => {
    const e = serializeSafeError(new Error('x'));
    expect(serializeSafeError(e)).toBe(e);
    expect(isSafeError(e)).toBe(true);
    const s = makeSecrets();
    const spoof = { type: 'Error', message: `spoofed "${s.password}"`, frames: [] };
    expect(isSafeError(spoof)).toBe(false);
    expect(leaked(JSON.stringify(serializeSafeError(spoof)), s)).toEqual([]);
  });
});

describe('serializeSafeError — stack frames', () => {
  it('keeps only repo-relative frame locations, never the header', () => {
    const s = makeSecrets();
    const e = new Error(`header ${s.pan}`);
    e.stack = [
      `Error: header ${s.pan}`,
      '    at Service.run (C:\\work\\flower\\apps\\api\\src\\modules\\x\\service.ts:10:5)',
      '    at async Object.<anonymous> (file:///home/ci/flower/packages/db/src/y.ts:1:2)',
      `    at evil (${s.password}.js:1:1)`,
      '    at node:internal/process/task_queues:105:5',
    ].join('\n');
    const out = serializeSafeError(e);
    expect(out.frames).toContain('Service.run (apps/api/src/modules/x/service.ts:10:5)');
    expect(out.frames).toContain('async Object.<anonymous> (packages/db/src/y.ts:1:2)');
    expect(out.frames).toContain('node:internal/process/task_queues:105:5');
    expect(out.frames.some((f) => f.includes('evil'))).toBe(false);
    expect(leaked(JSON.stringify(out), s)).toEqual([]);
  });

  it('caps the number of frames', () => {
    const e = new Error('deep');
    e.stack = [
      'Error: deep',
      ...Array.from({ length: 50 }, (_, i) => `    at f${i} (packages/x/y.ts:${i}:1)`),
    ].join('\n');
    expect(serializeSafeError(e).frames.length).toBe(12);
  });
});

describe('serializeSafeError — property test: no secret survives anywhere in a generated error', () => {
  it('200 randomized errors with secrets in message, stack header, meta, cause, extra props and quotes', () => {
    for (let i = 0; i < 200; i++) {
      const s = makeSecrets();
      const pick = s.all[i % s.all.length]!;
      const style = i % 4;
      const base =
        style === 0
          ? prismaLikeError({ value: pick })
          : style === 1
            ? new Error(`bad "${pick}" value`)
            : style === 2
              ? new TypeError(`x ${s.all[[0, 1, 2, 3, 4, 7][i % 6]!]}`) // unquoted: only values the template recognises by SHAPE
              : new AggregateError([new Error(`'${pick}'`)], `agg "${pick}"`);
      const e = Object.assign(base, {
        extra: pick,
        cause: new Error(`cause "${pick}"`),
        meta: { v: pick },
      });
      const text = JSON.stringify(serializeSafeError(e));
      expect(leaked(text, s), `iteration ${i} style ${style}`).toEqual([]);
    }
  });
});

describe('serializeSafeError — documented limitation', () => {
  it('an UNQUOTED plain-word value inside a non-database message survives the template (bounded claim)', () => {
    // The template recognises values by shape (quotes, digit runs, tokens, e-mails). Words with no shape cannot be told apart
    // from the sentence. This is why database errors are BUILT from allowlisted fields, why object properties are dropped,
    // and why this package never claims universal protection.
    expect(serializeSafeError(new Error('failed for Zorblax Quimby')).message).toBe(
      'failed for Zorblax Quimby',
    );
  });
});

describe('serializeSafeError — remaining edge cases', () => {
  it('a Prisma code is a CODE, never an SQLSTATE', () => {
    const e = Object.assign(new Error('x'), { code: 'P2002', clientVersion: '7.10.0' });
    e.name = 'PrismaClientKnownRequestError';
    const out = serializeSafeError(e);
    expect(out.code).toBe('P2002');
    expect(out.sqlstate).toBeUndefined();
  });

  it('is total: a value whose very type check throws still yields the fixed fallback', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    expect(serializeSafeError(hostile)).toMatchObject({
      type: 'Error',
      message: '[unserializable error]',
      frames: [],
    });
  });
});
