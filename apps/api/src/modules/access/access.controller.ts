import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { Ctx, requireTenantContext, type RequestContext } from '../../common/context/index.js';
import { AccessAdminService, tenantActorFromContext } from './access-admin.service.js';
import {
  createRoleSchema,
  grantsSchema,
  previewSchema,
  rolePermissionsSchema,
  scopeSchema,
  userRolesSchema,
} from './access.schemas.js';

/**
 * `/v1/access` — role / grant / scope administration (PHASE-1-PLAN §1.9). All
 * routes are `roles:manage` or `users:manage` (both step-up). The escalation
 * guard + audit + session refresh live in `AccessAdminService`.
 */
@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessAdminService) {}

  @Get('roles')
  @RequirePermission('roles:manage')
  listRoles() {
    return this.access.listRoles(requireTenantContext().tenantId);
  }

  @Post('roles')
  @RequirePermission('roles:manage')
  createRole(
    @Ctx() ctx: RequestContext,
    @Body(new ZodBody(createRoleSchema)) dto: z.infer<typeof createRoleSchema>,
  ) {
    return this.access.createRole(tenantActorFromContext(ctx), dto);
  }

  @Put('roles/:roleId/permissions')
  @RequirePermission('roles:manage')
  async setRolePermissions(
    @Ctx() ctx: RequestContext,
    @Param('roleId') roleId: string,
    @Body(new ZodBody(rolePermissionsSchema)) dto: z.infer<typeof rolePermissionsSchema>,
  ) {
    await this.access.setRolePermissions(tenantActorFromContext(ctx), roleId, dto.permissionKeys);
    return { status: 'ok' };
  }

  @Get('users/:userId')
  @RequirePermission('users:manage')
  getUser(@Param('userId') userId: string) {
    return this.access.getUser(requireTenantContext().tenantId, userId);
  }

  @Put('users/:userId/roles')
  @RequirePermission('users:manage')
  async setUserRoles(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body(new ZodBody(userRolesSchema)) dto: z.infer<typeof userRolesSchema>,
  ) {
    await this.access.setUserRoles(tenantActorFromContext(ctx), userId, dto.roleIds);
    return { status: 'ok' };
  }

  @Put('users/:userId/grants')
  @RequirePermission('users:manage')
  async setUserGrants(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body(new ZodBody(grantsSchema)) dto: z.infer<typeof grantsSchema>,
  ) {
    await this.access.setUserGrants(tenantActorFromContext(ctx), userId, dto.grants);
    return { status: 'ok' };
  }

  @Put('users/:userId/scope')
  @RequirePermission('users:manage')
  async setUserScope(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body(new ZodBody(scopeSchema)) dto: z.infer<typeof scopeSchema>,
  ) {
    await this.access.setUserScope(tenantActorFromContext(ctx), userId, {
      companyScopeAll: dto.companyScopeAll,
      companyIds: dto.companyIds,
      branchScopeAll: dto.branchScopeAll,
      branchIds: dto.branchIds,
      perBranchOverlay: dto.perBranchOverlay ?? null,
    });
    return { status: 'ok' };
  }

  @Post('users/:userId/preview')
  @RequirePermission('users:manage')
  preview(
    @Param('userId') userId: string,
    @Body(new ZodBody(previewSchema)) dto: z.infer<typeof previewSchema>,
  ) {
    return this.access.preview(requireTenantContext().tenantId, userId, dto);
  }
}
