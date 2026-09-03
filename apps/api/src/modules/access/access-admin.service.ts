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
} from './access.repository.js';
import { PolicyService, type AccessPreview, type ProposedAccess } from './policy.service.js';
import { SessionAccessRefresher } from './session-access.refresher.js';

/** The isKnownUniqueError shape Prisma throws on a unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Role / grant / scope administration (PHASE-1-PLAN §1.9). Every mutation:
 *   1. passes the **escalation guard** — a tenant admin can never introduce a
 *      platform-realm key, a key the tenant is not entitled to, a key they do not
 *      themselves hold, or a scope id outside their own scope;
 *   2. writes its `audit_log` row inside the mutation's transaction (in the repo);
 *   3. refreshes the affected users' live sessions so it takes effect next request.
 *
 * `roles:manage` / `users:manage` are step-up permissions, enforced by the guard
 * pipeline before this service runs.
 */
@Injectable()
export class AccessAdminService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly policy: PolicyService,
    private readonly refresher: SessionAccessRefresher,
  ) {}

  listRoles(): Promise<RoleRow[]> {
    return this.repo.listRoles();
  }

  getUser(userId: string): Promise<AccessPreview['current'] & { accountType: string }> {
    return this.policy.resolveForUser(userId).then((r) => ({
      accountType: r.accountType,
      permissions: [...r.effectivePermissions].sort(),
      companyScope: r.companyScope,
      branchScope: r.branchScope,
    }));
  }

  preview(userId: string, proposed: ProposedAccess): Promise<AccessPreview> {
    return this.policy.preview(userId, proposed);
  }

  async createRole(
    ctx: RequestContext,
    input: { key: string; name: string; permissionKeys: string[] },
  ): Promise<{ id: string }> {
    if (/^platform([:_]|$)/i.test(input.key)) {
      throw new ForbiddenError('the "platform" key prefix is reserved', 'RESERVED_ROLE_KEY');
    }
    await this.assertGrantable(ctx, input.permissionKeys);
    try {
      return await this.repo.createRole(input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('ROLE_KEY_TAKEN', `a role "${input.key}" already exists`, 409);
      }
      throw err;
    }
  }

  async setRolePermissions(
    ctx: RequestContext,
    roleId: string,
    permissionKeys: string[],
  ): Promise<void> {
    const role = await this.repo.roleById(roleId);
    if (!role) throw new NotFoundError('role');
    if (role.isSystem) {
      throw new ForbiddenError('system roles are managed by the platform', 'SYSTEM_ROLE_READONLY');
    }
    await this.assertGrantable(ctx, permissionKeys);
    await this.repo.replaceRolePermissions(roleId, permissionKeys);
    await this.refresher.refreshUsers(
      requireTenantContext().tenantId,
      await this.repo.userIdsWithRole(roleId),
    );
  }

  async setUserRoles(ctx: RequestContext, userId: string, roleIds: string[]): Promise<void> {
    const unique = [...new Set(roleIds)];
    if (!(await this.repo.userExists(userId))) throw new NotFoundError('user');
    if ((await this.repo.countRoles(unique)) !== unique.length) throw new NotFoundError('role');
    await this.assertGrantable(ctx, await this.repo.permissionsForRoles(unique));
    await this.repo.setUserRoles(userId, unique);
    await this.refresher.refreshUser(requireTenantContext().tenantId, userId);
  }

  async setUserGrants(ctx: RequestContext, userId: string, grants: GrantInput[]): Promise<void> {
    if (!(await this.repo.userExists(userId))) throw new NotFoundError('user');
    // Only ALLOW grants can escalate; a DENY only ever removes access.
    await this.assertGrantable(
      ctx,
      grants.filter((g) => g.effect === 'ALLOW').map((g) => g.permissionKey),
    );
    await this.repo.replaceUserGrants(userId, grants);
    await this.refresher.refreshUser(requireTenantContext().tenantId, userId);
  }

  async setUserScope(ctx: RequestContext, userId: string, scope: ScopeInput): Promise<void> {
    if (!(await this.repo.userExists(userId))) throw new NotFoundError('user');
    if (!scope.companyScopeAll) assertIdsWithin(ctx.companyScope, scope.companyIds, 'company');
    if (!scope.branchScopeAll) assertIdsWithin(ctx.branchScope, scope.branchIds, 'branch');
    await this.repo.setUserScope(userId, scope);
    await this.refresher.refreshUser(requireTenantContext().tenantId, userId);
  }

  /**
   * The escalation guard. `keys` is every permission key the mutation would add
   * (role permission set, assigned roles' union, or ALLOW grants).
   */
  private async assertGrantable(ctx: RequestContext, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const unique = [...new Set(keys)];

    // 1 — must be a known TENANT-realm permission. A platform key or a
    //     not-yet-seeded future key is not grantable.
    const known = await this.repo.tenantRealmPermissionKeys(unique);
    const notTenant = unique.filter((k) => !known.has(k));
    if (notTenant.length > 0) {
      throw new ForbiddenError(
        `not a grantable tenant permission: ${notTenant.sort().join(', ')}`,
        'PERMISSION_NOT_GRANTABLE',
      );
    }

    // 2 — the key's feature module must be entitled for this tenant.
    const notEntitled = unique.filter((k) => {
      const mod = MODULE_OF_PERMISSION[k];
      return mod !== undefined && !ctx.entitlements.has(mod);
    });
    if (notEntitled.length > 0) {
      throw new ForbiddenError(
        `module not entitled for: ${notEntitled.sort().join(', ')}`,
        'MODULE_NOT_ENTITLED',
      );
    }

    // 3 — no privilege escalation: the acting admin must hold every key they add.
    const notHeld = unique.filter((k) => !ctx.effectivePermissions.has(k));
    if (notHeld.length > 0) {
      throw new ForbiddenError(
        `cannot grant a permission you do not hold: ${notHeld.sort().join(', ')}`,
        'PRIVILEGE_ESCALATION',
      );
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
