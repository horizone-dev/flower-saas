import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../common/context/index.js';
import { PolicyEngine } from '../access/policy-engine.js';
import {
  CreditOverrideAuthorizationService,
  CREDIT_OVERRIDE_REASON_MAX_LENGTH,
} from './credit-override-authorization.service.js';

/**
 * Task 3b.6 Checkpoint C — the one-sale credit-override authorization gate.
 * Pure unit tests: `PolicyEngine`/`RequestContext` are both directly
 * constructible with no HTTP/DB (mirrors `policy-engine.test.ts`'s own
 * no-I/O style) — no fake public endpoint is created anywhere to exercise
 * this (C11).
 */
describe('CreditOverrideAuthorizationService.authorize (task 3b.6 Checkpoint C)', () => {
  const service = new CreditOverrideAuthorizationService(new PolicyEngine());

  function ctx(
    overrides: Partial<ConstructorParameters<typeof RequestContext>[0]> = {},
  ): RequestContext {
    return new RequestContext({
      requestId: 'req-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      accountType: 'OWNER',
      mfaLevel: 'STEP_UP',
      companyScope: 'ALL',
      branchScope: 'ALL',
      effectivePermissions: ['customers:credit:override'],
      ...overrides,
    });
  }

  it('C27/C29: an Owner with the permission, step-up, and a reason is authorized', () => {
    const result = service.authorize(ctx(), 'owner approved a one-time exception');
    expect(result.actorUserId).toBe('user-1');
    expect(result.reason).toBe('owner approved a one-time exception');
  });

  it('C26: missing customers:credit:override permission is rejected (MISSING_PERMISSION)', () => {
    expect(() => service.authorize(ctx({ effectivePermissions: [] }), 'reason')).toThrow(
      /credit-limit override denied/i,
    );
  });

  it('C27: missing step-up (mfaLevel != STEP_UP) is rejected — customers:credit:override now requires it', () => {
    expect(() => service.authorize(ctx({ mfaLevel: 'MFA' }), 'reason')).toThrow(
      /credit-limit override denied/i,
    );
    expect(() => service.authorize(ctx({ mfaLevel: 'NONE' }), 'reason')).toThrow(
      /credit-limit override denied/i,
    );
  });

  it('C28: an empty or whitespace-only reason is rejected', () => {
    expect(() => service.authorize(ctx(), '')).toThrow(/non-empty reason is required/i);
    expect(() => service.authorize(ctx(), '   ')).toThrow(/non-empty reason is required/i);
    expect(() => service.authorize(ctx(), null)).toThrow(/non-empty reason is required/i);
    expect(() => service.authorize(ctx(), undefined)).toThrow(/non-empty reason is required/i);
    try {
      service.authorize(ctx(), '');
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('CREDIT_OVERRIDE_REASON_REQUIRED');
    }
  });

  it('the reason is trimmed before being carried into the decision', () => {
    const result = service.authorize(ctx(), '  spaced reason  ');
    expect(result.reason).toBe('spaced reason');
  });

  it('a non-tenant-scoped (PLATFORM) context is rejected — this is a tenant-realm-only permission', () => {
    expect(() =>
      service.authorize(ctx({ accountType: 'PLATFORM', tenantId: null }), 'reason'),
    ).toThrow(/credit-limit override denied/i);
  });

  it('the branded decision cannot be constructed except through this service — its brand key is an unexported Symbol, not a string literal', () => {
    // `Object.keys`/`JSON.stringify`/a spread `{...result}` all see ONLY the
    // two plain string-keyed properties — the Symbol-keyed brand is
    // invisible to every one of those, exactly like a real object this
    // service produced. No other module can construct a value with that
    // Symbol property at all (the Symbol itself is never exported), so no
    // plain object literal — however it is shaped — can ever satisfy the
    // `AuthorizedCreditOverride` type from outside this file.
    const result = service.authorize(ctx(), 'reason');
    expect(Object.keys(result).sort()).toEqual(['actorUserId', 'reason']);
    expect(Object.getOwnPropertySymbols(result)).toHaveLength(1);
  });

  it('C6 (hardening): reason is bounded — too long is rejected, exactly at the boundary is accepted', () => {
    const tooLong = 'x'.repeat(CREDIT_OVERRIDE_REASON_MAX_LENGTH + 1);
    expect(() => service.authorize(ctx(), tooLong)).toThrow(/at most 255 characters/i);
    try {
      service.authorize(ctx(), tooLong);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('CREDIT_OVERRIDE_REASON_TOO_LONG');
    }
    const atBoundary = 'x'.repeat(CREDIT_OVERRIDE_REASON_MAX_LENGTH);
    expect(() => service.authorize(ctx(), atBoundary)).not.toThrow();
  });
});
