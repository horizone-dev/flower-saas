import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx, type RequestContext } from '../../common/context/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { ProvisioningService } from './provisioning.service.js';
import { TenantLifecycleService } from './tenant-lifecycle.service.js';
import { TenantRepository } from './tenant.repository.js';

const provisionSchema = z.object({
  slug: z.string().min(2).max(63),
  name: z.string().min(1).max(200),
  region: z.string().length(2),
  // The company's legal-entity country (ISO 3166-1 alpha-2) — the fiscal
  // source of truth (architecture correction 4). Deliberately a separate
  // field from `region`: never derived from it, even though the values may
  // coincide today (task 2.7).
  companyCountryCode: z.string().length(2),
  planVersionId: z.string().uuid(),
  ownerEmail: z.string().email(),
  companyLegalNameEn: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  branchTimezone: z.string().optional(),
});
const lifecycleSchema = z.object({ reason: z.string().min(3).max(500).optional() });

@Controller('platform/tenants')
@PlatformRealm()
export class TenantController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly tenants: TenantRepository,
  ) {}

  @Get()
  @RequirePermission('platform:tenants:view')
  list() {
    return this.tenants.list();
  }

  @Get(':tenantId')
  @RequirePermission('platform:tenants:view')
  async detail(@Param('tenantId') tenantId: string) {
    const t = await this.tenants.get(tenantId);
    if (!t) throw new NotFoundException('tenant not found');
    return t;
  }

  @Post()
  @RequirePermission('platform:tenants:manage')
  @HttpCode(201)
  async provision(
    @Body(new ZodBody(provisionSchema)) dto: z.infer<typeof provisionSchema>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ctx() ctx: RequestContext,
  ) {
    return this.provisioning.provision({
      ...dto,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      actorPlatformUserId: ctx.platformUserId,
    });
  }

  @Post(':tenantId/suspend')
  @RequirePermission('platform:tenants:manage')
  @HttpCode(200)
  suspend(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(lifecycleSchema)) dto: { reason?: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.lifecycle.transition(tenantId, 'suspend', ctx.platformUserId, dto.reason);
  }

  @Post(':tenantId/resume')
  @RequirePermission('platform:tenants:manage')
  @HttpCode(200)
  resume(@Param('tenantId') tenantId: string, @Ctx() ctx: RequestContext) {
    return this.lifecycle.transition(tenantId, 'resume', ctx.platformUserId);
  }

  @Post(':tenantId/terminate')
  @RequirePermission('platform:tenants:manage')
  @HttpCode(200)
  terminate(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(lifecycleSchema)) dto: { reason?: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.lifecycle.transition(tenantId, 'terminate', ctx.platformUserId, dto.reason);
  }
}
