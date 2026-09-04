import { describe, it, expect } from 'vitest';
import { RequestContext } from './request-context.js';
import {
  runWithContext,
  getContext,
  requireContext,
  requireTenantContext,
  replaceContext,
  NoRequestContextError,
  NotTenantScopedError,
} from './context.als.js';

const base = (
  over: Partial<ConstructorParameters<typeof RequestContext>[0]> = {},
): RequestContext => new RequestContext({ requestId: 'req-1', ...over });

describe('RequestContext', () => {
  it('is frozen and normalises defaults', () => {
    const ctx = base();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.tenantId).toBeNull();
    expect(ctx.mfaLevel).toBe('NONE');
    expect(ctx.branchScope).toEqual([]);
    expect(ctx.effectivePermissions.size).toBe(0);
    expect(() => {
      (ctx as { tenantId: string }).tenantId = 'x';
    }).toThrow();
  });

  it('isTenantScoped / isImpersonating reflect the fields', () => {
    expect(base().isTenantScoped).toBe(false);
    expect(base({ tenantId: 't1' }).isTenantScoped).toBe(true);
    expect(base().isImpersonating).toBe(false);
    expect(base({ impersonatorPlatformUserId: 'p1' }).isImpersonating).toBe(true);
  });

  it('singleBranchId is set only for a one-branch scope', () => {
    expect(base({ branchScope: 'ALL' }).singleBranchId).toBeNull();
    expect(base({ branchScope: [] }).singleBranchId).toBeNull();
    expect(base({ branchScope: ['b1', 'b2'] }).singleBranchId).toBeNull();
    expect(base({ branchScope: ['b1'] }).singleBranchId).toBe('b1');
  });

  it('with() layers a patch onto an immutable copy', () => {
    const boot = base({ ip: '1.2.3.4' });
    const authed = boot.with({ tenantId: 't1', userId: 'u1', accountType: 'OWNER' });
    expect(authed).not.toBe(boot);
    expect(authed.ip).toBe('1.2.3.4');
    expect(authed.tenantId).toBe('t1');
    expect(boot.tenantId).toBeNull(); // original untouched
  });

  it('hasPermission checks the effective set', () => {
    const ctx = base({ effectivePermissions: ['users:manage'] });
    expect(ctx.hasPermission('users:manage')).toBe(true);
    expect(ctx.hasPermission('roles:manage')).toBe(false);
  });
});

describe('context ALS', () => {
  it('getContext is undefined outside a request', () => {
    expect(getContext()).toBeUndefined();
  });

  it('requireContext throws (fails closed) outside a request', () => {
    expect(() => requireContext('x')).toThrow(NoRequestContextError);
  });

  it('runWithContext scopes the store and does not leak after it returns', () => {
    runWithContext(base({ tenantId: 't1' }), () => {
      expect(requireContext().tenantId).toBe('t1');
    });
    expect(getContext()).toBeUndefined();
  });

  it('concurrent frames do not see each other', async () => {
    const seen: string[] = [];
    await Promise.all([
      new Promise<void>((resolve) =>
        runWithContext(base({ tenantId: 'A' }), () => {
          setTimeout(() => {
            seen.push(`A:${requireContext().tenantId}`);
            resolve();
          }, 5);
        }),
      ),
      new Promise<void>((resolve) =>
        runWithContext(base({ tenantId: 'B' }), () => {
          setTimeout(() => {
            seen.push(`B:${requireContext().tenantId}`);
            resolve();
          }, 1);
        }),
      ),
    ]);
    expect(seen.sort()).toEqual(['A:A', 'B:B']);
  });

  it('requireTenantContext throws when the context has no tenant', () => {
    runWithContext(base(), () => {
      expect(() => requireTenantContext()).toThrow(NotTenantScopedError);
    });
  });

  it('replaceContext swaps the current frame (auth guard enriching the bootstrap ctx)', () => {
    runWithContext(base({ ip: '9.9.9.9' }), () => {
      replaceContext(requireContext().with({ tenantId: 't1', userId: 'u1' }));
      expect(requireTenantContext().tenantId).toBe('t1');
      expect(requireContext().ip).toBe('9.9.9.9');
    });
  });
});
