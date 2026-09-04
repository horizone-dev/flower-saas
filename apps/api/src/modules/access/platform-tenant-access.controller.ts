import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { AccessAdminService, type AdminActor } from './access-admin.service.js';
import { AccessRepository } from './access.repository.js';
import {
  createRoleSchema,
  grantsSchema,
  previewSchema,
  rolePermissionsSchema,
  scopeSchema,
  userRolesSchema,
} from './access.schemas.js';

/**
 * `/v1/platform/tenants/:tenantId/...` — the Super Admin Web's tenant-RBAC
 * surface (PHASE-1-PLAN §1.11). Platform realm; `platform:tenant_roles:manage` /
 * `platform:tenant_users:manage` (both step-up — a platform account always logs
 * in with mandatory TOTP → STEP_UP). OD7 read-only applies to an *impersonated*
 * session, not to a normal platform session: a Super Admin here can mutate.
 * The escalation guard still bars a platform-realm key, a not-entitled key and a
 * not-yet-seeded future key; every write is audited as a PLATFORM actor.
 *
 * An impersonation token is tenant-realm, so `AuthGuard` rejects it on these
 * routes (401) before the handler runs.
 */
@Controller('platform/tenants/:tenantId')
@PlatformRealm()
export class PlatformTenantAccessController {
  constructor(
    private readonly access: AccessAdminService,
    private readonly repo: AccessRepository,
  ) {}

  private async actor(tenantId: string): Promise<AdminActor> {
    return {
      tenantId,
      heldPermissions: null, // authority is the platform permission
      companyScope: 'ALL',
      branchScope: 'ALL',
      entitledModules: new Set(await this.repo.entitledModules(tenantId)),
      actingUserId: null,
    };
  }

  // ── roles ────────────────────────────────────────────────────────────────
  @Get('roles')
  @RequirePermission('platform:tenant_roles:manage')
  listRoles(@Param('tenantId') tenantId: string) {
    return this.access.listRoles(tenantId);
  }

  @Post('roles')
  @RequirePermission('platform:tenant_roles:manage')
  async createRole(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(createRoleSchema)) dto: z.infer<typeof createRoleSchema>,
  ) {
    return this.access.createRole(await this.actor(tenantId), dto);
  }

  @Put('roles/:roleId/permissions')
  @RequirePermission('platform:tenant_roles:manage')
  async setRolePermissions(
    @Param('tenantId') tenantId: string,
    @Param('roleId') roleId: string,
    @Body(new ZodBody(rolePermissionsSchema)) dto: z.infer<typeof rolePermissionsSchema>,
  ) {
    await this.access.setRolePermissions(await this.actor(tenantId), roleId, dto.permissionKeys);
    return { status: 'ok' };
  }

  // ── users ────────────────────────────────────────────────────────────────
  @Get('users')
  @RequirePermission('platform:tenant_users:manage')
  listUsers(@Param('tenantId') tenantId: string) {
    return this.access.listUsers(tenantId);
  }

  @Get('users/:userId')
  @RequirePermission('platform:tenant_users:manage')
  getUser(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    return this.access.getUser(tenantId, userId);
  }

  @Put('users/:userId/roles')
  @RequirePermission('platform:tenant_users:manage')
  async setUserRoles(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body(new ZodBody(userRolesSchema)) dto: z.infer<typeof userRolesSchema>,
  ) {
    await this.access.setUserRoles(await this.actor(tenantId), userId, dto.roleIds);
    return { status: 'ok' };
  }

  @Put('users/:userId/grants')
  @RequirePermission('platform:tenant_users:manage')
  async setUserGrants(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body(new ZodBody(grantsSchema)) dto: z.infer<typeof grantsSchema>,
  ) {
    await this.access.setUserGrants(await this.actor(tenantId), userId, dto.grants);
    return { status: 'ok' };
  }

  @Put('users/:userId/scope')
  @RequirePermission('platform:tenant_users:manage')
  async setUserScope(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body(new ZodBody(scopeSchema)) dto: z.infer<typeof scopeSchema>,
  ) {
    await this.access.setUserScope(await this.actor(tenantId), userId, {
      companyScopeAll: dto.companyScopeAll,
      companyIds: dto.companyIds,
      branchScopeAll: dto.branchScopeAll,
      branchIds: dto.branchIds,
      perBranchOverlay: dto.perBranchOverlay ?? null,
    });
    return { status: 'ok' };
  }

  @Post('users/:userId/access-preview')
  @RequirePermission('platform:tenant_users:manage')
  preview(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body(new ZodBody(previewSchema)) dto: z.infer<typeof previewSchema>,
  ) {
    return this.access.preview(tenantId, userId, dto);
  }
}
