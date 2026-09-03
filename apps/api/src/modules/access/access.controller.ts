import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { Ctx, type RequestContext } from '../../common/context/index.js';
import { AccessAdminService } from './access-admin.service.js';

const roleKey = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case');
const permissionKey = z.string().regex(/^[a-z0-9_]+(?::[a-z0-9_]+){1,2}$/);
const uuid = z.string().uuid();

const createRoleSchema = z.object({
  key: roleKey,
  name: z.string().min(1).max(80),
  permissionKeys: z.array(permissionKey).max(200).default([]),
});
const rolePermissionsSchema = z.object({
  permissionKeys: z.array(permissionKey).max(200),
});
const userRolesSchema = z.object({
  roleIds: z.array(uuid).max(50),
});
const grantsSchema = z.object({
  grants: z
    .array(
      z.object({
        permissionKey,
        effect: z.enum(['ALLOW', 'DENY']),
        reason: z.string().min(3).max(280),
      }),
    )
    .max(200),
});
const scopeSchema = z.object({
  companyScopeAll: z.boolean(),
  companyIds: z.array(uuid).max(200).default([]),
  branchScopeAll: z.boolean(),
  branchIds: z.array(uuid).max(500).default([]),
  perBranchOverlay: z.record(z.string().uuid(), z.array(permissionKey)).optional(),
});
const previewSchema = z.object({
  roleIds: z.array(uuid).max(50).optional(),
  grants: z
    .array(z.object({ permissionKey, effect: z.enum(['ALLOW', 'DENY']) }))
    .max(200)
    .optional(),
  scope: z
    .object({
      companyScopeAll: z.boolean().optional(),
      companyIds: z.array(uuid).optional(),
      branchScopeAll: z.boolean().optional(),
      branchIds: z.array(uuid).optional(),
    })
    .optional(),
});

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
    return this.access.listRoles();
  }

  @Post('roles')
  @RequirePermission('roles:manage')
  createRole(
    @Ctx() ctx: RequestContext,
    @Body(new ZodBody(createRoleSchema)) dto: z.infer<typeof createRoleSchema>,
  ) {
    return this.access.createRole(ctx, dto);
  }

  @Put('roles/:roleId/permissions')
  @RequirePermission('roles:manage')
  async setRolePermissions(
    @Ctx() ctx: RequestContext,
    @Param('roleId') roleId: string,
    @Body(new ZodBody(rolePermissionsSchema)) dto: z.infer<typeof rolePermissionsSchema>,
  ) {
    await this.access.setRolePermissions(ctx, roleId, dto.permissionKeys);
    return { status: 'ok' };
  }

  @Get('users/:userId')
  @RequirePermission('users:manage')
  getUser(@Param('userId') userId: string) {
    return this.access.getUser(userId);
  }

  @Put('users/:userId/roles')
  @RequirePermission('users:manage')
  async setUserRoles(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body(new ZodBody(userRolesSchema)) dto: z.infer<typeof userRolesSchema>,
  ) {
    await this.access.setUserRoles(ctx, userId, dto.roleIds);
    return { status: 'ok' };
  }

  @Put('users/:userId/grants')
  @RequirePermission('users:manage')
  async setUserGrants(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body(new ZodBody(grantsSchema)) dto: z.infer<typeof grantsSchema>,
  ) {
    await this.access.setUserGrants(ctx, userId, dto.grants);
    return { status: 'ok' };
  }

  @Put('users/:userId/scope')
  @RequirePermission('users:manage')
  async setUserScope(
    @Ctx() ctx: RequestContext,
    @Param('userId') userId: string,
    @Body(new ZodBody(scopeSchema)) dto: z.infer<typeof scopeSchema>,
  ) {
    await this.access.setUserScope(ctx, userId, {
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
    return this.access.preview(userId, dto);
  }
}
