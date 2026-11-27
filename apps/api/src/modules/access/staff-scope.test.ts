import { describe, expect, it } from 'vitest';
import { ScopeExceedsActorError, assertScopeWithin } from './staff-scope.js';

const C1 = '00000000-0000-7000-8000-0000000000c1';
const C2 = '00000000-0000-7000-8000-0000000000c2';
const B1 = '00000000-0000-7000-8000-0000000000b1';
const B2 = '00000000-0000-7000-8000-0000000000b2';

describe('a tenant-realm inviter can never grant more data scope than they hold', () => {
  it('an ALL-scope owner may grant any company / branch (the repository still checks they belong to the tenant)', () => {
    expect(() =>
      assertScopeWithin(
        { companyScope: 'ALL', branchScope: 'ALL' },
        { companyIds: [C1, C2], branchIds: [B1, B2] },
      ),
    ).not.toThrow();
  });

  it('a restricted actor may grant a subset', () => {
    expect(() =>
      assertScopeWithin(
        { companyScope: [C1], branchScope: [B1, B2] },
        { companyIds: [C1], branchIds: [B2] },
      ),
    ).not.toThrow();
  });

  it('refuses a company or branch outside the actor scope', () => {
    const actor = { companyScope: [C1], branchScope: [B1] } as const;
    expect(() => assertScopeWithin(actor, { companyIds: [C2], branchIds: [B1] })).toThrow(
      ScopeExceedsActorError,
    );
    expect(() => assertScopeWithin(actor, { companyIds: [C1], branchIds: [B1, B2] })).toThrow(
      ScopeExceedsActorError,
    );
  });

  it('a restricted actor can never grant by naming everything: an empty actor scope grants nothing', () => {
    expect(() =>
      assertScopeWithin(
        { companyScope: [], branchScope: [] },
        { companyIds: [C1], branchIds: [B1] },
      ),
    ).toThrow(ScopeExceedsActorError);
  });

  it('comparison is exact and case-insensitive on ids; no prefix or substring matching', () => {
    expect(() =>
      assertScopeWithin(
        { companyScope: [C1.toUpperCase()], branchScope: [B1] },
        { companyIds: [C1], branchIds: [B1] },
      ),
    ).not.toThrow();
    expect(() =>
      assertScopeWithin(
        { companyScope: [C1], branchScope: [B1] },
        { companyIds: [C1.slice(0, -1)], branchIds: [B1] },
      ),
    ).toThrow(ScopeExceedsActorError);
  });
});
