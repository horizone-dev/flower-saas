import { describe, expect, it } from 'vitest';
import { InvalidScopeIdError, runScoped } from '../src/index.js';

/**
 * A tenant / branch scope id that is not a UUID is refused BEFORE the transaction opens, with a TYPED error (stable `code`) and a
 * message that never contains the rejected value. No database is needed: the guard runs first, so the client is never touched.
 */
const NEVER = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the database client must not be touched');
    },
  },
) as never;
const UUID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';

describe('runScoped — non-UUID scope ids', () => {
  it('a bad tenantId rejects with InvalidScopeIdError before any database access', async () => {
    for (const bad of ['', 'not-a-uuid', "x'; DROP TABLE y;--", '4111111111111111', `${UUID}0`]) {
      const e = await runScoped(NEVER, { tenantId: bad }, async () => 1).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(InvalidScopeIdError);
      expect(e).toMatchObject({
        code: 'INVALID_SCOPE_ID',
        field: 'tenantId',
        name: 'InvalidScopeIdError',
      });
      expect((e as Error).message).toBe('runScoped: tenantId is not a UUID');
      expect((e as Error).message).not.toContain(bad || 'zz-never');
    }
  });

  it('a bad branchId rejects likewise; an empty / null branchId is allowed (no narrowing) and then reaches the client', async () => {
    const e = await runScoped(NEVER, { tenantId: UUID, branchId: 'nope' }, async () => 1).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'INVALID_SCOPE_ID', field: 'branchId' });
    const scopes: Array<{ tenantId: string; branchId?: string | null }> = [
      { tenantId: UUID, branchId: null },
      { tenantId: UUID, branchId: '' },
      { tenantId: UUID }, // omitted
    ];
    for (const scope of scopes) {
      const touched = await runScoped(NEVER, scope, async () => 1).catch((x: unknown) => x);
      expect((touched as Error).message).toBe('the database client must not be touched'); // got past the guard
    }
  });
});
