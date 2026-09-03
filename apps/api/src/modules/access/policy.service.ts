import { Injectable } from '@nestjs/common';
import { resolveEffectivePermissions } from '@flower/permissions';
import type { ScopeSet } from '../../common/context/index.js';
import { AccessRepository, type UserAccessRow } from './access.repository.js';
import type { ResolvedAccess } from './policy.types.js';

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`user ${userId} not found in this tenant`);
    this.name = 'UserNotFoundError';
  }
}

export interface ProposedAccess {
  roleIds?: readonly string[];
  grants?: readonly { permissionKey: string; effect: 'ALLOW' | 'DENY' }[];
  scope?: {
    companyScopeAll?: boolean;
    companyIds?: readonly string[];
    branchScopeAll?: boolean;
    branchIds?: readonly string[];
  };
}

export interface AccessPreview {
  current: { permissions: string[]; companyScope: ScopeSet; branchScope: ScopeSet };
  proposed: { permissions: string[]; companyScope: ScopeSet; branchScope: ScopeSet };
  diff: {
    permissionsAdded: string[];
    permissionsRemoved: string[];
    companyScopeChanged: boolean;
    branchScopeChanged: boolean;
  };
}

@Injectable()
export class PolicyService {
  constructor(private readonly repo: AccessRepository) {}

  /** The full resolved access for a user. `tenantId` is passed at login (before a
   *  request context exists); otherwise it comes from the request context. */
  async resolveForUser(userId: string, tenantId?: string): Promise<ResolvedAccess> {
    const row = await this.repo.loadUserAccess(userId, tenantId);
    if (!row) throw new UserNotFoundError(userId);
    return this.materialise(userId, row);
  }

  /** Permission-preview: what would this user's access be under `proposed`, and
   *  how does it differ from now. Read-only — never writes. */
  async preview(userId: string, proposed: ProposedAccess): Promise<AccessPreview> {
    const currentRow = await this.repo.loadUserAccess(userId);
    if (!currentRow) throw new UserNotFoundError(userId);
    const current = this.materialise(userId, currentRow);

    const proposedRolePerms = proposed.roleIds
      ? await this.repo.permissionsForRoles(proposed.roleIds)
      : currentRow.rolePermissions;

    const proposedRow: UserAccessRow = {
      accountType: currentRow.accountType,
      rolePermissions: proposedRolePerms,
      grants: proposed.grants ? [...proposed.grants] : currentRow.grants,
      scope: proposed.scope
        ? {
            companyScopeAll: proposed.scope.companyScopeAll ?? false,
            companyIds: [...(proposed.scope.companyIds ?? [])],
            branchScopeAll: proposed.scope.branchScopeAll ?? false,
            branchIds: [...(proposed.scope.branchIds ?? [])],
            perBranchOverlay: currentRow.scope?.perBranchOverlay ?? null,
          }
        : currentRow.scope,
      entitledModules: currentRow.entitledModules,
    };
    const next = this.materialise(userId, proposedRow);

    const cur = new Set(current.effectivePermissions);
    const nxt = new Set(next.effectivePermissions);
    return {
      current: {
        permissions: [...cur].sort(),
        companyScope: current.companyScope,
        branchScope: current.branchScope,
      },
      proposed: {
        permissions: [...nxt].sort(),
        companyScope: next.companyScope,
        branchScope: next.branchScope,
      },
      diff: {
        permissionsAdded: [...nxt].filter((k) => !cur.has(k)).sort(),
        permissionsRemoved: [...cur].filter((k) => !nxt.has(k)).sort(),
        companyScopeChanged: scopeKey(current.companyScope) !== scopeKey(next.companyScope),
        branchScopeChanged: scopeKey(current.branchScope) !== scopeKey(next.branchScope),
      },
    };
  }

  private materialise(userId: string, row: UserAccessRow): ResolvedAccess {
    const entitledModules = new Set(row.entitledModules);
    const isOwner = row.accountType === 'OWNER';

    const effectivePermissions = resolveEffectivePermissions({
      rolePermissions: row.rolePermissions,
      directGrants: row.grants.map((g) => [g.permissionKey, g.effect] as const),
      entitledModules,
    });

    // Owner short-circuits scope to ALL/ALL (ARCHITECTURE §6). A DENY grant can
    // still block a specific action, which the resolution above already applied.
    const companyScope: ScopeSet = isOwner
      ? 'ALL'
      : row.scope?.companyScopeAll
        ? 'ALL'
        : Object.freeze([...(row.scope?.companyIds ?? [])]);
    const branchScope: ScopeSet = isOwner
      ? 'ALL'
      : row.scope?.branchScopeAll
        ? 'ALL'
        : Object.freeze([...(row.scope?.branchIds ?? [])]);

    const perBranchOverlay = new Map<string, ReadonlySet<string>>();
    for (const [branchId, keys] of Object.entries(row.scope?.perBranchOverlay ?? {})) {
      perBranchOverlay.set(branchId, new Set(keys));
    }

    return {
      userId,
      accountType: row.accountType,
      effectivePermissions,
      companyScope,
      branchScope,
      perBranchOverlay,
      entitledModules,
    };
  }
}

function scopeKey(s: ScopeSet): string {
  return s === 'ALL' ? 'ALL' : [...s].sort().join(',');
}
