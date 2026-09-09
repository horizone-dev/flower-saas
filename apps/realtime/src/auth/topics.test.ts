import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { SessionData } from '@flower/backend';
import { isAuthorized } from './topics.js';

function session(over: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: randomUUID(),
    realm: 'tenant',
    familyId: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    platformUserId: null,
    accountType: 'USER',
    posTerminalId: null,
    deviceId: null,
    mfaLevel: 'NONE',
    stepUpUntil: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    revokedAt: null,
    revokeReason: null,
    impersonatorPlatformUserId: null,
    access: {
      effectivePermissions: [],
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    },
    ...over,
  };
}

describe('isAuthorized', () => {
  it('denies a different tenant regardless of branch scope', () => {
    const s = session({ tenantId: 'tenant-a' });
    expect(isAuthorized(s, { tenant_id: 'tenant-b', branch_id: null })).toBe(false);
  });

  it('allows a tenant-global event (branch_id: null) for any authorized (same-tenant) session', () => {
    const s = session({
      tenantId: 'tenant-a',
      access: {
        effectivePermissions: [],
        companyScope: 'ALL',
        branchScope: ['branch-1'],
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    });
    expect(isAuthorized(s, { tenant_id: 'tenant-a', branch_id: null })).toBe(true);
  });

  it("branchScope 'ALL' authorizes any branch in the tenant", () => {
    const s = session({ tenantId: 'tenant-a' }); // default branchScope: 'ALL'
    expect(isAuthorized(s, { tenant_id: 'tenant-a', branch_id: 'any-branch' })).toBe(true);
  });

  it('an explicit branch allow-list only authorizes listed branches', () => {
    const s = session({
      tenantId: 'tenant-a',
      access: {
        effectivePermissions: [],
        companyScope: 'ALL',
        branchScope: ['branch-1', 'branch-2'],
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    });
    expect(isAuthorized(s, { tenant_id: 'tenant-a', branch_id: 'branch-1' })).toBe(true);
    expect(isAuthorized(s, { tenant_id: 'tenant-a', branch_id: 'branch-3' })).toBe(false);
  });

  it('a null access snapshot (no resolved scope yet) authorizes nothing branch-scoped', () => {
    const s = session({ tenantId: 'tenant-a', access: null });
    expect(isAuthorized(s, { tenant_id: 'tenant-a', branch_id: 'branch-1' })).toBe(false);
    // but a tenant-global event still passes — access snapshot only gates branch scope
    expect(isAuthorized(s, { tenant_id: 'tenant-a', branch_id: null })).toBe(true);
  });

  // ── task 3.10 — cumulative company-scope authorization (owner D-1) ──────────
  const scoped = (companyScope: 'ALL' | string[], branchScope: 'ALL' | string[]) =>
    session({
      tenantId: 'tenant-a',
      access: {
        effectivePermissions: [],
        companyScope,
        branchScope,
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    });

  it('company-scoped event: delivered only to a session whose companyScope covers the company', () => {
    const evt = { tenant_id: 'tenant-a', company_id: 'company-a', branch_id: null };
    expect(isAuthorized(scoped('ALL', 'ALL'), evt)).toBe(true); // Owner ALL/ALL
    expect(isAuthorized(scoped(['company-a'], 'ALL'), evt)).toBe(true); // selected-company manager
    expect(isAuthorized(scoped(['company-b'], 'ALL'), evt)).toBe(false); // company B → denied
    expect(isAuthorized(scoped([], 'ALL'), evt)).toBe(false); // no company scope → denied
  });

  it('branch-scoped event carries BOTH company_id + branch_id — BOTH checks must pass', () => {
    const evt = { tenant_id: 'tenant-a', company_id: 'company-a', branch_id: 'branch-a' };
    expect(isAuthorized(scoped(['company-a'], ['branch-a']), evt)).toBe(true);
    // right branch, WRONG company → denied (defence in depth)
    expect(isAuthorized(scoped(['company-b'], ['branch-a']), evt)).toBe(false);
    // right company, wrong branch → denied
    expect(isAuthorized(scoped(['company-a'], ['branch-b']), evt)).toBe(false);
    // Owner ALL/ALL → allowed
    expect(isAuthorized(scoped('ALL', 'ALL'), evt)).toBe(true);
  });

  it('a tenant-global catalog event (no company_id, no branch_id) reaches any same-tenant session', () => {
    const evt = { tenant_id: 'tenant-a', company_id: null, branch_id: null };
    expect(isAuthorized(scoped(['company-x'], ['branch-x']), evt)).toBe(true);
  });

  it('company_id omitted entirely (legacy envelope) is treated as null — not a filter', () => {
    const evt = { tenant_id: 'tenant-a', branch_id: 'branch-a' };
    expect(isAuthorized(scoped('ALL', ['branch-a']), evt)).toBe(true);
  });
});
