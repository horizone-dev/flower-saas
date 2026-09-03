import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx, type RequestContext } from '../../common/context/index.js';

/**
 * `/v1/me/*` — the POS PWA's only consumer (CLAUDE.md rule 2). Phase 1: the
 * current identity + "my access" screen. Auth is required but no special
 * permission — every authenticated user may see their own context.
 */
@Controller('me')
export class MeController {
  @Get()
  @RequirePermission('users:view')
  me(@Ctx() ctx: RequestContext) {
    return {
      userId: ctx.userId,
      platformUserId: ctx.platformUserId,
      accountType: ctx.accountType,
      tenantId: ctx.tenantId,
      mfaLevel: ctx.mfaLevel,
      isImpersonating: ctx.isImpersonating,
    };
  }

  @Get('access')
  @RequirePermission('users:view')
  access(@Ctx() ctx: RequestContext) {
    return {
      accountType: ctx.accountType,
      planKey: ctx.planKey,
      entitledModules: [...ctx.entitlements].sort(),
      companyScope: ctx.companyScope,
      branchScope: ctx.branchScope,
      permissions: [...ctx.effectivePermissions].sort(),
      perBranchOverlay: Object.fromEntries(
        [...ctx.perBranchOverlay].map(([b, keys]) => [b, [...keys].sort()]),
      ),
    };
  }
}
