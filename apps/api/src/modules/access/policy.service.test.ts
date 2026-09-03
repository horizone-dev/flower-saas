import { describe, it, expect } from 'vitest';
import { PolicyService, UserNotFoundError } from './policy.service.js';
import type { AccessRepository, UserAccessRow } from './access.repository.js';

/** In-memory AccessRepository double — the real DB path is covered by the guard
 *  pipeline integration test (task 1.4). Here we test the resolution algebra. */
function fakeRepo(rows: Record<string, UserAccessRow>, roleMap: Record<string, string[]> = {}) {
  return {
    loadUserAccess: (userId: string) => Promise.resolve(rows[userId] ?? null),
    permissionsForRoles: (roleIds: readonly string[]) =>
      Promise.resolve([...new Set(roleIds.flatMap((r) => roleMap[r] ?? []))]),
  } as unknown as AccessRepository;
}

const OWNER: UserAccessRow = {
  accountType: 'OWNER',
  rolePermissions: ['users:manage', 'roles:manage', 'settings:tenant:manage'],
  grants: [],
  scope: null,
  entitledModules: [],
};

const MANAGER: UserAccessRow = {
  accountType: 'USER',
  rolePermissions: ['users:view', 'audit:view'],
  grants: [],
  scope: {
    companyScopeAll: false,
    companyIds: ['c1'],
    branchScopeAll: false,
    branchIds: ['b1', 'b2'],
    perBranchOverlay: { b2: ['users:view'] },
  },
  entitledModules: [],
};

describe('PolicyService.resolveForUser', () => {
  it('Owner gets ALL/ALL scope regardless of any scope row', () => {
    const svc = new PolicyService(fakeRepo({ o: OWNER }));
    return svc.resolveForUser('o').then((r) => {
      expect(r.companyScope).toBe('ALL');
      expect(r.branchScope).toBe('ALL');
      expect(r.effectivePermissions.has('settings:tenant:manage')).toBe(true);
    });
  });

  it('a branch user keeps its explicit company/branch lists + overlay', async () => {
    const svc = new PolicyService(fakeRepo({ m: MANAGER }));
    const r = await svc.resolveForUser('m');
    expect(r.companyScope).toEqual(['c1']);
    expect(r.branchScope).toEqual(['b1', 'b2']);
    expect(r.perBranchOverlay.get('b2')).toEqual(new Set(['users:view']));
  });

  it('a DENY grant removes a role permission for a branch user too', async () => {
    const svc = new PolicyService(
      fakeRepo({
        m: { ...MANAGER, grants: [{ permissionKey: 'audit:view', effect: 'DENY' }] },
      }),
    );
    const r = await svc.resolveForUser('m');
    expect(r.effectivePermissions.has('audit:view')).toBe(false);
    expect(r.effectivePermissions.has('users:view')).toBe(true);
  });

  it('throws UserNotFoundError for an unknown user', async () => {
    const svc = new PolicyService(fakeRepo({}));
    await expect(svc.resolveForUser('nope')).rejects.toThrow(UserNotFoundError);
  });
});

describe('PolicyService.preview', () => {
  it('shows the permissions a proposed role set would add / remove', async () => {
    const svc = new PolicyService(
      fakeRepo({ m: MANAGER }, { roleAdmin: ['users:view', 'users:manage', 'roles:manage'] }),
    );
    const p = await svc.preview('m', { roleIds: ['roleAdmin'] });
    expect(p.current.permissions).toEqual(['audit:view', 'users:view']);
    expect(p.proposed.permissions).toEqual(['roles:manage', 'users:manage', 'users:view']);
    expect(p.diff.permissionsAdded).toEqual(['roles:manage', 'users:manage']);
    expect(p.diff.permissionsRemoved).toEqual(['audit:view']);
    expect(p.diff.branchScopeChanged).toBe(false);
  });

  it('flags a scope change', async () => {
    const svc = new PolicyService(fakeRepo({ m: MANAGER }));
    const p = await svc.preview('m', { scope: { branchScopeAll: true } });
    expect(p.diff.branchScopeChanged).toBe(true);
    expect(p.proposed.branchScope).toBe('ALL');
  });

  it('does not write (read-only) — repo has no mutation methods invoked', async () => {
    const repo = fakeRepo({ m: MANAGER });
    const svc = new PolicyService(repo);
    await svc.preview('m', {});
    // fakeRepo exposes only reads; a write attempt would be a TypeError
    expect(Object.keys(repo)).toEqual(['loadUserAccess', 'permissionsForRoles']);
  });
});
