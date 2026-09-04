import { Injectable } from '@nestjs/common';
import { MODULE_OF_PERMISSION } from '@flower/permissions';
import { DomainError, ForbiddenError, NotFoundError } from '../../common/errors/domain-error.js';
import {
  requireTenantContext,
  type RequestContext,
  type ScopeSet,
} from '../../common/context/index.js';
import {
  AccessRepository,
  type GrantInput,
  type RoleRow,
  type ScopeInput,
  type UserListRow,
} from './access.repository.js';
import { PolicyService, type AccessPreview, type ProposedAccess } from './policy.service.js';
import { SessionAccessRefresher } from './session-access.refresher.js';

/**
 * Who is performing an access-admin mutation, and the constraints that apply to
 * them. A **tenant-realm** caller (Owner / Admin) supplies `heldPermissions` —
 * they can never grant a key they do not themselves hold, or a scope id outside
 * their own scope. A **platform-realm** Super Admin's authority is the platform
 * permission (`platform:tenant_users:manage` / `platform:tenant_roles:manage`,
 * both step-up), so `heldPermissions` is `null` and scope is `'ALL'` — but the
 * realm / entitlement / no-future-key checks still apply, and the write is fully
 * audited.
 */
export interface AdminActor {
  tenantId: string;
  heldPermissions: ReadonlySet<string> | null;
  companyScope: ScopeSet;
  branchScope: ScopeSet;
  /** enabled feature modules for the **target** tenant */
  entitledModules: ReadonlySet<string>;
  /** the acting tenant user id, if any (recorded as `permission_grant.granted_by`) */
  actingUserId: string | null;
}

/** The `AdminActor` for a tenant-realm caller (Owner / Admin acting in their own
 *  tenant) — carries their held permissions and scope for the escalation guard. */
export function tenantActorFromContext(ctx: RequestContext): AdminActor {
  const c = requireTenantContext();
  return {
    tenantId: c.tenantId,
    heldPermissions: ctx.effectivePermissions,
    companyScope: ctx.companyScope,
    branchScope: ctx.branchScope,
    entitledModules: ctx.entitlements,
    actingUserId: ctx.userId,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Role / grant / scope administration (PHASE-1-PLAN §1.9 + §1.11). Every
 * mutation: (1) passes the escalation guard, (2) writes its `audit_log` row in
 * the mutation transaction (in the repo), (3) refreshes the affected users' live
 * sessions so it takes effect on their next request.
 */
@Injectable()
export class AccessAdminService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly policy: PolicyService,
    private readonly refresher: SessionAccessRefresher,
  ) {}

  listRoles(tenantId: string): Promise<RoleRow[]> {
    return this.repo.listRoles(tenantId);
  }

  listUsers(tenantId: string): Promise<UserListRow[]> {
    return this.repo.listUsers(tenantId);
  }

  getUser(
    tenantId: string,
    userId: string,
  ): Promise<{
    accountType: string;
    permissions: string[];
    companyScope: ScopeSet;
    branchScope: ScopeSet;
  }> {
    return this.policy.resolveForUser(userId, tenantId).then((r) => ({
      accountType: r.accountType,
      permissions: [...r.effectivePermissions].sort(),
      companyScope: r.companyScope,
      branchScope: r.branchScope,
    }));
  }

  preview(tenantId: string, userId: string, proposed: ProposedAccess): Promise<AccessPreview> {
    return this.policy.preview(userId, proposed, tenantId);
  }

  async createRole(
    actor: AdminActor,
    input: { key: string; name: string; permissionKeys: string[] },
  ): Promise<{ id: string }> {
    if (/^platform([:_]|$)/i.test(input.key)) {
      throw new ForbiddenError('the "platform" key prefix is reserved', 'RESERVED_ROLE_KEY');
    }
    await this.assertGrantable(actor, input.permissionKeys);
    try {
      return await this.repo.createRole(actor.tenantId, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('ROLE_KEY_TAKEN', `a role "${input.key}" already exists`, 409);
      }
      throw err;
    }
  }

  async setRolePermissions(
    actor: AdminActor,
    roleId: string,
    permissionKeys: string[],
  ): Promise<void> {
    const role = await this.repo.roleById(actor.tenantId, roleId);
    if (!role) throw new NotFoundError('role');
    if (role.isSystem) {
      throw new ForbiddenError('system roles are managed by the platform', 'SYSTEM_ROLE_READONLY');
    }
    await this.assertGrantable(actor, permissionKeys);
    await this.repo.replaceRolePermissions(actor.tenantId, roleId, permissionKeys);
    await this.refresher.refreshUsers(
      actor.tenantId,
      await this.repo.userIdsWithRole(actor.tenantId, roleId),
    );
  }

  async setUserRoles(actor: AdminActor, userId: string, roleIds: string[]): Promise<void> {
    const unique = [...new Set(roleIds)];
    if (!(await this.repo.userExists(actor.tenantId, userId))) throw new NotFoundError('user');
    if ((await this.repo.countRoles(actor.tenantId, unique)) !== unique.length) {
      throw new NotFoundError('role');
    }
    await this.assertGrantable(actor, await this.repo.permissionsForRoles(unique, actor.tenantId));
    await this.repo.setUserRoles(actor.tenantId, userId, unique);
    await this.refresher.refreshUser(actor.tenantId, userId);
  }

  async setUserGrants(actor: AdminActor, userId: string, grants: GrantInput[]): Promise<void> {
    if (!(await this.repo.userExists(actor.tenantId, userId))) throw new NotFoundError('user');
    // Only ALLOW grants can escalate; a DENY only ever removes access.
    await this.assertGrantable(
      actor,
      grants.filter((g) => g.effect === 'ALLOW').map((g) => g.permissionKey),
    );
    await this.repo.replaceUserGrants(actor.tenantId, userId, grants, actor.actingUserId);
    await this.refresher.refreshUser(actor.tenantId, userId);
  }

  async setUserScope(actor: AdminActor, userId: string, scope: ScopeInput): Promise<void> {
    if (!(await this.repo.userExists(actor.tenantId, userId))) throw new NotFoundError('user');
    if (!scope.companyScopeAll) assertIdsWithin(actor.companyScope, scope.companyIds, 'company');
    if (!scope.branchScopeAll) assertIdsWithin(actor.branchScope, scope.branchIds, 'branch');
    await this.repo.setUserScope(actor.tenantId, userId, scope);
    await this.refresher.refreshUser(actor.tenantId, userId);
  }

  /**
   * The escalation guard. `keys` is every permission key the mutation would add
   * (role permission set, assigned roles' union, or ALLOW grants).
   */
  private async assertGrantable(actor: AdminActor, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const unique = [...new Set(keys)];

    // 1 — must be a known TENANT-realm permission. A platform key or a
    //     not-yet-seeded future key is not grantable (by anyone, any realm).
    const known = await this.repo.tenantRealmPermissionKeys(unique, actor.tenantId);
    const notTenant = unique.filter((k) => !known.has(k));
    if (notTenant.length > 0) {
      throw new ForbiddenError(
        `not a grantable tenant permission: ${notTenant.sort().join(', ')}`,
        'PERMISSION_NOT_GRANTABLE',
      );
    }

    // 2 — the key's feature module must be entitled for the target tenant.
    const notEntitled = unique.filter((k) => {
      const mod = MODULE_OF_PERMISSION[k];
      return mod !== undefined && !actor.entitledModules.has(mod);
    });
    if (notEntitled.length > 0) {
      throw new ForbiddenError(
        `module not entitled for: ${notEntitled.sort().join(', ')}`,
        'MODULE_NOT_ENTITLED',
      );
    }

    // 3 — no privilege escalation: a tenant admin must hold every key they add.
    //     A platform Super Admin's authority is the platform permission itself.
    if (actor.heldPermissions !== null) {
      const held = actor.heldPermissions;
      const notHeld = unique.filter((k) => !held.has(k));
      if (notHeld.length > 0) {
        throw new ForbiddenError(
          `cannot grant a permission you do not hold: ${notHeld.sort().join(', ')}`,
          'PRIVILEGE_ESCALATION',
        );
      }
    }
  }
}

function assertIdsWithin(
  scope: ScopeSet,
  ids: readonly string[],
  axis: 'company' | 'branch',
): void {
  if (scope === 'ALL') return;
  const allowed = new Set(scope);
  const outside = ids.filter((id) => !allowed.has(id));
  if (outside.length > 0) {
    throw new ForbiddenError(
      `${axis} outside your own scope: ${outside.join(', ')}`,
      'SCOPE_OUT_OF_RANGE',
    );
  }
}
