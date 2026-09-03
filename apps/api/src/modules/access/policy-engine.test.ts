import { describe, it, expect } from 'vitest';
import { RequestContext, type RequestContextInit } from '../../common/context/index.js';
import { PolicyEngine } from './policy-engine.js';

const engine = new PolicyEngine();

const ctx = (over: Partial<RequestContextInit> = {}): RequestContext =>
  new RequestContext({
    requestId: 'r',
    tenantId: 't1',
    userId: 'u1',
    accountType: 'USER',
    mfaLevel: 'MFA',
    branchScope: [],
    companyScope: [],
    effectivePermissions: [],
    entitlements: [],
    ...over,
  });

describe('PolicyEngine.can — truth table', () => {
  it('ALLOW: holds the permission, no target', () => {
    expect(engine.can(ctx({ effectivePermissions: ['users:view'] }), 'users:view')).toEqual({
      allowed: true,
    });
  });

  it('DENY MISSING_PERMISSION: does not hold the key', () => {
    expect(engine.can(ctx({ effectivePermissions: ['users:view'] }), 'roles:manage')).toMatchObject(
      {
        allowed: false,
        reason: 'MISSING_PERMISSION',
      },
    );
  });

  it('DENY NOT_TENANT_SCOPED: no tenant / platform realm', () => {
    expect(engine.can(ctx({ tenantId: null }), 'users:view')).toMatchObject({
      allowed: false,
      reason: 'NOT_TENANT_SCOPED',
    });
    expect(engine.can(ctx({ accountType: 'PLATFORM' }), 'users:view')).toMatchObject({
      allowed: false,
      reason: 'NOT_TENANT_SCOPED',
    });
  });

  it('DENY MODULE_NOT_ENTITLED: has the key but the module is off', () => {
    const c = ctx({ effectivePermissions: ['recipe:manage'], entitlements: [] });
    expect(engine.can(c, 'recipe:manage')).toMatchObject({
      allowed: false,
      reason: 'MODULE_NOT_ENTITLED',
      detail: 'production_bom',
    });
  });
  it('ALLOW when the module IS entitled', () => {
    const c = ctx({ effectivePermissions: ['recipe:manage'], entitlements: ['production_bom'] });
    expect(engine.can(c, 'recipe:manage')).toEqual({ allowed: true });
  });

  it('DENY STEP_UP_REQUIRED: sensitive key without a fresh step-up', () => {
    const c = ctx({ effectivePermissions: ['users:manage'], mfaLevel: 'MFA' });
    expect(engine.can(c, 'users:manage')).toMatchObject({
      allowed: false,
      reason: 'STEP_UP_REQUIRED',
    });
    const stepped = ctx({ effectivePermissions: ['users:manage'], mfaLevel: 'STEP_UP' });
    expect(engine.can(stepped, 'users:manage')).toEqual({ allowed: true });
  });

  it('company scope: in-scope allows, out-of-scope denies, ALL allows', () => {
    const perm = 'settings:tenant:manage';
    const base = { effectivePermissions: [perm], mfaLevel: 'STEP_UP' as const };
    expect(engine.can(ctx({ ...base, companyScope: ['c1'] }), perm, { companyId: 'c1' })).toEqual({
      allowed: true,
    });
    expect(
      engine.can(ctx({ ...base, companyScope: ['c1'] }), perm, { companyId: 'c2' }),
    ).toMatchObject({ allowed: false, reason: 'COMPANY_OUT_OF_SCOPE' });
    expect(engine.can(ctx({ ...base, companyScope: 'ALL' }), perm, { companyId: 'c9' })).toEqual({
      allowed: true,
    });
  });

  it('branch scope: out-of-scope denies', () => {
    const c = ctx({ effectivePermissions: ['users:view'], branchScope: ['b1'] });
    expect(engine.can(c, 'users:view', { branchId: 'b2' })).toMatchObject({
      allowed: false,
      reason: 'BRANCH_OUT_OF_SCOPE',
    });
    expect(engine.can(c, 'users:view', { branchId: 'b1' })).toEqual({ allowed: true });
  });

  it('per-branch overlay narrows: in-scope branch but the key is not in the overlay', () => {
    const c = ctx({
      effectivePermissions: ['users:view', 'users:manage'],
      mfaLevel: 'STEP_UP',
      branchScope: ['dubai', 'sharjah'],
      perBranchOverlay: new Map([['sharjah', new Set(['users:view'])]]),
    });
    // Dubai: no overlay -> full set
    expect(engine.can(c, 'users:manage', { branchId: 'dubai' })).toEqual({ allowed: true });
    // Sharjah: overlay allows only users:view
    expect(engine.can(c, 'users:view', { branchId: 'sharjah' })).toEqual({ allowed: true });
    expect(engine.can(c, 'users:manage', { branchId: 'sharjah' })).toMatchObject({
      allowed: false,
      reason: 'MISSING_PERMISSION',
    });
  });
});
