import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ENTITLEMENT_MODULES, LIMIT_KEYS } from '@flower/shared-types';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { PlanRepository } from './plan.repository.js';

const createPlanSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
});
const createVersionSchema = z.object({
  version: z.number().int().positive(),
  entitlements: z
    .array(z.object({ moduleKey: z.enum(ENTITLEMENT_MODULES), enabled: z.boolean() }))
    .default([]),
  limits: z
    .array(z.object({ limitKey: z.enum(LIMIT_KEYS), value: z.number().int().nonnegative() }))
    .default([]),
});
const entitlementSchema = z.object({
  moduleKey: z.enum(ENTITLEMENT_MODULES),
  enabled: z.boolean(),
});
const limitSchema = z.object({
  limitKey: z.enum(LIMIT_KEYS),
  value: z.number().int().nonnegative(),
});

@Controller('platform/plans')
@PlatformRealm()
export class PlanController {
  constructor(private readonly plans: PlanRepository) {}

  @Get()
  @RequirePermission('platform:plans:manage')
  async list() {
    const rows = await this.plans.listPlans();
    return rows.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      isActive: p.isActive,
      versions: p.versions,
    }));
  }

  @Post()
  @RequirePermission('platform:plans:manage')
  create(@Body(new ZodBody(createPlanSchema)) dto: z.infer<typeof createPlanSchema>) {
    return this.plans.createPlan(dto);
  }

  @Post(':planId/versions')
  @RequirePermission('platform:plans:manage')
  createVersion(
    @Param('planId') planId: string,
    @Body(new ZodBody(createVersionSchema)) dto: z.infer<typeof createVersionSchema>,
  ) {
    return this.plans.createPlanVersion(planId, dto.version, {
      entitlements: dto.entitlements,
      limits: dto.limits.map((l) => ({ limitKey: l.limitKey, value: BigInt(l.value) })),
    });
  }

  @Post('versions/:planVersionId/publish')
  @RequirePermission('platform:plans:manage')
  publish(@Param('planVersionId') planVersionId: string) {
    return this.plans.publishPlanVersion(planVersionId);
  }

  @Put('versions/:planVersionId/entitlements')
  @RequirePermission('platform:entitlements:manage')
  async setEntitlement(
    @Param('planVersionId') planVersionId: string,
    @Body(new ZodBody(entitlementSchema)) dto: z.infer<typeof entitlementSchema>,
  ) {
    await this.plans.setEntitlementDefault(planVersionId, dto.moduleKey, dto.enabled);
    return { status: 'ok' };
  }

  @Put('versions/:planVersionId/limits')
  @RequirePermission('platform:limits:manage')
  async setLimit(
    @Param('planVersionId') planVersionId: string,
    @Body(new ZodBody(limitSchema)) dto: z.infer<typeof limitSchema>,
  ) {
    await this.plans.setLimitDefault(planVersionId, dto.limitKey, BigInt(dto.value));
    return { status: 'ok' };
  }
}
