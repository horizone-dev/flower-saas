import { Injectable } from '@nestjs/common';
import type { Prisma } from '@flower/db';
import { runScoped, type ScopedTx } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';

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

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  isActive: boolean;
  permissionKeys: string[];
}

export interface UserListRow {
  id: string;
  email: string;
  accountType: string;
  status: string;
  roleKeys: string[];
}

export interface GrantInput {
  permissionKey: string;
  effect: 'ALLOW' | 'DENY';
  reason: string;
}

export interface ScopeInput {
  companyScopeAll: boolean;
  companyIds: string[];
  branchScopeAll: boolean;
  branchIds: string[];
  perBranchOverlay?: Record<string, string[]> | null | undefined;
}

const asJson = (v: Record<string, unknown>): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/**
 * Reads + writes the RBAC state for a tenant, tenant-scoped through RLS (raw
 * Prisma is allowed here — this is a `.repository.ts`). Every method takes an
 * explicit `tenantId`: the tenant realm passes its own (from the request
 * context, via `AccessAdminService`), the platform realm passes the target
 * tenant's. Write methods write their `audit_log` row inside the same
 * transaction as the mutation (amendment 2).
 */
@Injectable()
export class AccessRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditWriter,
  ) {}

  private run<T>(tenantId: string | undefined, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    const tid = tenantId ?? requireTenantContext().tenantId;
    return runScoped(this.db.appClient(), { tenantId: tid }, fn);
  }

  // ── reads ────────────────────────────────────────────────────────────────
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

  /** Permission keys held by a set of roles (for permission-preview + escalation). */
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

  async listRoles(tenantId?: string): Promise<RoleRow[]> {
    return this.run(tenantId, async (tx) => {
      const rows = await tx.role.findMany({
        orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
        select: {
          id: true,
          key: true,
          name: true,
          isSystem: true,
          isActive: true,
          permissions: { select: { permissionKey: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        isSystem: r.isSystem,
        isActive: r.isActive,
        permissionKeys: r.permissions.map((p) => p.permissionKey).sort(),
      }));
    });
  }

  async listUsers(tenantId?: string): Promise<UserListRow[]> {
    return this.run(tenantId, async (tx) => {
      const rows = await tx.user.findMany({
        orderBy: { email: 'asc' },
        select: {
          id: true,
          email: true,
          accountType: true,
          status: true,
          roles: { select: { role: { select: { key: true } } } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        accountType: r.accountType,
        status: r.status,
        roleKeys: r.roles.map((ur) => ur.role.key).sort(),
      }));
    });
  }

  async entitledModules(tenantId?: string): Promise<string[]> {
    return this.run(tenantId, async (tx) => {
      const rows = await tx.tenantEntitlement.findMany({
        where: { enabled: true },
        select: { moduleKey: true },
      });
      return rows.map((e) => e.moduleKey);
    });
  }

  async roleById(
    tenantId: string,
    roleId: string,
  ): Promise<{ id: string; key: string; isSystem: boolean } | null> {
    return this.run(tenantId, (tx) =>
      tx.role.findUnique({
        where: { id: roleId },
        select: { id: true, key: true, isSystem: true },
      }),
    );
  }

  /** How many of `roleIds` actually exist in this tenant (RLS-scoped). */
  async countRoles(tenantId: string, roleIds: readonly string[]): Promise<number> {
    if (roleIds.length === 0) return 0;
    return this.run(tenantId, (tx) => tx.role.count({ where: { id: { in: [...roleIds] } } }));
  }

  async userExists(tenantId: string, userId: string): Promise<boolean> {
    return this.run(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { id: true } }).then((u) => u !== null),
    );
  }

  /** The subset of `keys` registered as TENANT-realm permissions. A platform key
   *  or an unknown/future key is simply absent from the result. */
  async tenantRealmPermissionKeys(
    keys: readonly string[],
    tenantId?: string,
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    return this.run(tenantId, async (tx) => {
      const rows = await tx.permissionRegistry.findMany({
        where: { key: { in: [...keys] }, realm: 'TENANT' },
        select: { key: true },
      });
      return new Set(rows.map((r) => r.key));
    });
  }

  /** Ids of users who currently hold `roleId` — their sessions need refreshing
   *  after the role's permissions change. */
  async userIdsWithRole(tenantId: string, roleId: string): Promise<string[]> {
    return this.run(tenantId, async (tx) => {
      const rows = await tx.userRole.findMany({ where: { roleId }, select: { userId: true } });
      return [...new Set(rows.map((r) => r.userId))];
    });
  }

  // ── writes (audit row committed in the same transaction) ─────────────────
  async createRole(
    tenantId: string,
    input: { key: string; name: string; permissionKeys: string[] },
  ): Promise<{ id: string }> {
    return this.run(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, key: input.key, name: input.name, isSystem: false },
        select: { id: true },
      });
      if (input.permissionKeys.length > 0) {
        await tx.rolePermission.createMany({
          data: input.permissionKeys.map((permissionKey) => ({
            tenantId,
            roleId: role.id,
            permissionKey,
          })),
        });
      }
      await this.audit.record(tx, {
        action: 'role.created',
        resourceType: 'role',
        resourceId: role.id,
        tenantId,
        after: { key: input.key, permissionKeys: input.permissionKeys },
      });
      return role;
    });
  }

  async replaceRolePermissions(
    tenantId: string,
    roleId: string,
    permissionKeys: string[],
  ): Promise<void> {
    await this.run(tenantId, async (tx) => {
      const before = await tx.rolePermission.findMany({
        where: { roleId },
        select: { permissionKey: true },
      });
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (permissionKeys.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionKeys.map((permissionKey) => ({ tenantId, roleId, permissionKey })),
        });
      }
      await this.audit.record(tx, {
        action: 'role.permissions_changed',
        resourceType: 'role',
        resourceId: roleId,
        tenantId,
        before: { permissionKeys: before.map((b) => b.permissionKey).sort() },
        after: { permissionKeys: [...permissionKeys].sort() },
      });
    });
  }

  async setUserRoles(tenantId: string, userId: string, roleIds: string[]): Promise<void> {
    await this.run(tenantId, async (tx) => {
      const before = await tx.userRole.findMany({ where: { userId }, select: { roleId: true } });
      await tx.userRole.deleteMany({ where: { userId } });
      if (roleIds.length > 0) {
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ tenantId, userId, roleId })),
        });
      }
      await this.audit.record(tx, {
        action: 'user.roles_changed',
        resourceType: 'user',
        resourceId: userId,
        tenantId,
        before: { roleIds: before.map((b) => b.roleId).sort() },
        after: { roleIds: [...roleIds].sort() },
      });
    });
  }

  async replaceUserGrants(
    tenantId: string,
    userId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ): Promise<void> {
    await this.run(tenantId, async (tx) => {
      const before = await tx.permissionGrant.findMany({
        where: { userId },
        select: { permissionKey: true, effect: true },
      });
      await tx.permissionGrant.deleteMany({ where: { userId } });
      if (grants.length > 0) {
        await tx.permissionGrant.createMany({
          data: grants.map((g) => ({
            tenantId,
            userId,
            permissionKey: g.permissionKey,
            effect: g.effect,
            reason: g.reason,
            grantedByUserId,
          })),
        });
      }
      await this.audit.record(tx, {
        action: 'user.grants_changed',
        resourceType: 'user',
        resourceId: userId,
        tenantId,
        before: { grants: before },
        after: {
          grants: grants.map((g) => ({ permissionKey: g.permissionKey, effect: g.effect })),
        },
      });
    });
  }

  async setUserScope(tenantId: string, userId: string, scope: ScopeInput): Promise<void> {
    const overlay = scope.perBranchOverlay ?? null;
    await this.run(tenantId, async (tx) => {
      const before = await tx.dataScopeAssignment.findUnique({
        where: { userId },
        select: {
          companyScopeAll: true,
          companyIds: true,
          branchScopeAll: true,
          branchIds: true,
        },
      });
      await tx.dataScopeAssignment.upsert({
        where: { userId },
        create: {
          tenantId,
          userId,
          companyScopeAll: scope.companyScopeAll,
          companyIds: scope.companyIds,
          branchScopeAll: scope.branchScopeAll,
          branchIds: scope.branchIds,
          ...(overlay ? { perBranchOverlay: asJson(overlay) } : {}),
        },
        update: {
          companyScopeAll: scope.companyScopeAll,
          companyIds: scope.companyIds,
          branchScopeAll: scope.branchScopeAll,
          branchIds: scope.branchIds,
          // send `{}` to clear it — a nullable-Json SQL NULL needs the Prisma
          // runtime sentinel, which `@flower/db` exposes as a type only.
          ...(overlay ? { perBranchOverlay: asJson(overlay) } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'user.scope_changed',
        resourceType: 'user',
        resourceId: userId,
        tenantId,
        before: before ?? undefined,
        after: {
          companyScopeAll: scope.companyScopeAll,
          companyIds: scope.companyIds,
          branchScopeAll: scope.branchScopeAll,
          branchIds: scope.branchIds,
        },
      });
    });
  }
}
