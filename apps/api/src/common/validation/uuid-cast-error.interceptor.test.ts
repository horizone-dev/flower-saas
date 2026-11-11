import { describe, expect, it } from 'vitest';
import { lastValueFrom, of, throwError } from 'rxjs';
import { InvalidScopeIdError } from '@flower/db';
import { NotFoundError } from '../errors/domain-error.js';
import { UuidCastErrorInterceptor, isUuidCastError } from './uuid-cast-error.interceptor.js';

/** the exact shape Prisma 7 + @prisma/adapter-pg produces (see pg-error.ts) */
const prismaErr = (sqlstate: string, message: string) =>
  Object.assign(new Error('Raw query failed'), {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: sqlstate, message } } },
  });
const run = (err: unknown) =>
  lastValueFrom(
    new UuidCastErrorInterceptor().intercept({} as never, { handle: () => throwError(() => err) }),
  );

describe('UuidCastErrorInterceptor', () => {
  it('maps ONLY a 22P02 uuid-cast error to 404 NOT_FOUND, without echoing the value', async () => {
    const e = prismaErr('22P02', 'invalid input syntax for type uuid: "4111111111111111"');
    expect(isUuidCastError(e)).toBe(true);
    const out = (await run(e).catch((x: unknown) => x)) as NotFoundError;
    expect(out).toBeInstanceOf(NotFoundError);
    expect([out.status, out.code]).toEqual([404, 'NOT_FOUND']);
    expect(JSON.stringify(out) + out.message).not.toContain('4111');
  });

  it('also maps the runScoped pre-flight refusal of a non-UUID tenant / branch id (value never echoed)', async () => {
    for (const label of ['tenantId', 'branchId']) {
      const e = new InvalidScopeIdError(label as 'tenantId' | 'branchId');
      expect(isUuidCastError(e)).toBe(true);
      const out = (await run(e).catch((x: unknown) => x)) as NotFoundError;
      expect([out.status, out.code]).toEqual([404, 'NOT_FOUND']);
      expect(JSON.stringify(out) + out.message).not.toContain('4111');
    }
    // detection is by the typed `code`, NOT by message text: an ordinary Error that merely says the same words is NOT translated
    expect(isUuidCastError(new Error('runScoped: tenantId is not a UUID'))).toBe(false);
    expect(isUuidCastError(new Error('runScoped: bad role "x"'))).toBe(false);
  });

  it('every other error passes through UNCHANGED: other 22P02 types, other SQLSTATEs, domain errors, plain errors', async () => {
    const others: unknown[] = [
      prismaErr('22P02', 'invalid input syntax for type integer: "x"'),
      prismaErr('22P02', 'invalid input value for enum "status"'),
      prismaErr('23505', 'duplicate key value violates unique constraint (type uuid)'),
      prismaErr('40P01', 'deadlock detected'),
      new NotFoundError('thing'),
      new Error('boom'),
      'string',
      null,
    ];
    for (const e of others) {
      expect(isUuidCastError(e)).toBe(false);
      await expect(run(e)).rejects.toBe(e);
    }
  });

  it('a successful response is untouched', async () => {
    const out = await lastValueFrom(
      new UuidCastErrorInterceptor().intercept({} as never, { handle: () => of({ ok: 1 }) }),
    );
    expect(out).toEqual({ ok: 1 });
  });
});
