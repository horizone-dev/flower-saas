import { Injectable } from '@nestjs/common';
import { runScoped, type ScopedTx } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';

export interface UserAccessRow {
  accountType: 'OWNER' | 'USER';
  /** union of permission keys from the user's active roles */
  rolePermissions: string[];
  /** direct per-user grants */
  grants: { permissionKey: string; effect: 'ALLOW' | 'DENY' }[];
  scope: {
    companyScopeAll: boolean;
    companyIds: string[];
    branchScopeAll: boolean;
    branchIds: string[];
    perBranchOverlay: Record<string, string[]> | null;
  } | null;
  /** module keys the tenant is entitled to (enabled) */
  entitledModules: string[];
}

/**
 * Reads the RBAC state for one user, tenant-scoped through RLS. Every method
 * accepts an explicit `tenantId` (login resolves access before there is a request
 * context) and falls back to the request context otherwise.
 */
@Injectable()
export class AccessRepository {
  constructor(private readonly db: DbService) {}

  private run<T>(tenantId: string | undefined, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    const tid = tenantId ?? requireTenantContext().tenantId;
    return runScoped(this.db.appClient(), { tenantId: tid }, fn);
  }

  async loadUserAccess(userId: string, tenantId?: string): Promise<UserAccessRow | null> {
    return this.run(tenantId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { accountType: true },
      });
      if (!user) return null;

      const [userRoles, grants, scope, entitlements] = await Promise.all([
        tx.userRole.findMany({
          where: { userId, role: { isActive: true } },
          select: { role: { select: { permissions: { select: { permissionKey: true } } } } },
        }),
        tx.permissionGrant.findMany({
          where: { userId },
          select: { permissionKey: true, effect: true },
        }),
        tx.dataScopeAssignment.findUnique({
          where: { userId },
          select: {
            companyScopeAll: true,
            companyIds: true,
            branchScopeAll: true,
            branchIds: true,
            perBranchOverlay: true,
          },
        }),
        tx.tenantEntitlement.findMany({
          where: { enabled: true },
          select: { moduleKey: true },
        }),
      ]);

      const rolePermissions = [
        ...new Set(userRoles.flatMap((ur) => ur.role.permissions.map((p) => p.permissionKey))),
      ];

      return {
        accountType: user.accountType as 'OWNER' | 'USER',
        rolePermissions,
        grants: grants.map((g) => ({
          permissionKey: g.permissionKey,
          effect: g.effect as 'ALLOW' | 'DENY',
        })),
        scope: scope
          ? {
              companyScopeAll: scope.companyScopeAll,
              companyIds: scope.companyIds,
              branchScopeAll: scope.branchScopeAll,
              branchIds: scope.branchIds,
              perBranchOverlay: (scope.perBranchOverlay as Record<string, string[]> | null) ?? null,
            }
          : null,
        entitledModules: entitlements.map((e) => e.moduleKey),
      };
    });
  }

  /** Permission keys held by a set of roles (for permission-preview). */
  async permissionsForRoles(roleIds: readonly string[], tenantId?: string): Promise<string[]> {
    if (roleIds.length === 0) return [];
    return this.run(tenantId, async (tx) => {
      const rows = await tx.rolePermission.findMany({
        where: { roleId: { in: [...roleIds] } },
        select: { permissionKey: true },
      });
      return [...new Set(rows.map((r) => r.permissionKey))];
    });
  }
}
