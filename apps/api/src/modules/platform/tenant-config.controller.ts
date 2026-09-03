import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { ENTITLEMENT_MODULES, LIMIT_KEYS, limitKeySchema } from '@flower/shared-types';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx, type RequestContext } from '../../common/context/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { TenantConfigRepository } from './tenant-config.repository.js';
import { EntitlementService } from './entitlement.service.js';

const overrideLimitSchema = z.object({
  value: z.number().int().nonnegative(),
  reason: z.string().min(3).max(500),
});
const overrideEntitlementSchema = z.object({
  moduleKey: z.enum(ENTITLEMENT_MODULES),
  enabled: z.boolean(),
});

/** Per-tenant entitlement + limit overrides (Super Admin). Reason mandatory,
 *  audited (task 1.14 wires the audit_log write). */
@Controller('platform/tenants/:tenantId')
@PlatformRealm()
export class TenantConfigController {
  constructor(
    private readonly config: TenantConfigRepository,
    private readonly entitlements: EntitlementService,
  ) {}

  @Get('config')
  @RequirePermission('platform:tenants:view')
  async get(@Param('tenantId') tenantId: string) {
    const [ent, lim] = await Promise.all([
      this.config.entitlements(tenantId),
      this.config.limits(tenantId),
    ]);
    return {
      entitlements: ent,
      limits: lim.map((l) => ({
        limitKey: l.limitKey,
        value: Number(l.value),
        isOverride: l.isOverride,
      })),
    };
  }

  @Put('limits/:limitKey')
  @RequirePermission('platform:limits:manage')
  async overrideLimit(
    @Param('tenantId') tenantId: string,
    @Param('limitKey') limitKey: string,
    @Body(new ZodBody(overrideLimitSchema)) dto: z.infer<typeof overrideLimitSchema>,
    @Ctx() ctx: RequestContext,
  ) {
    const key = limitKeySchema.parse(limitKey);
    void LIMIT_KEYS;
    await this.config.overrideLimit(
      tenantId,
      key,
      BigInt(dto.value),
      dto.reason,
      ctx.platformUserId,
    );
    return { status: 'ok', limitKey: key, value: dto.value };
  }

  @Put('entitlements')
  @RequirePermission('platform:entitlements:manage')
  async overrideEntitlement(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(overrideEntitlementSchema)) dto: z.infer<typeof overrideEntitlementSchema>,
  ) {
    await this.entitlements.setEnabled(tenantId, dto.moduleKey, dto.enabled);
    return { status: 'ok' };
  }
}
