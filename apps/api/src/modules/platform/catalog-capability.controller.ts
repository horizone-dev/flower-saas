import { Body, Controller, Get, Headers, Param, Patch, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { capabilityKeySchema } from '@flower/shared-types';
import { NoStepUp, PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx, type RequestContext } from '../../common/context/index.js';
import { NotFoundError } from '../../common/errors/domain-error.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { PlatformCatalogCapabilityService } from './catalog-capability.service.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function assertTenantId(id: string): void {
  if (!UUID_RE.test(id)) throw new NotFoundError('tenant');
}

const patchSchema = z.object({
  changes: z
    .array(
      z.object({
        capabilityKey: capabilityKeySchema,
        enabled: z.boolean(),
        config: z.unknown().optional(),
      }),
    )
    .min(1),
  reason: z.string().min(1).max(500).optional(),
});

/** Parse an `If-Match` header value into a non-negative integer version, or
 *  `null` (missing / malformed / `*`). The service turns `null` into `428`. */
function parseIfMatch(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** `GET /v1/platform/business-type-templates` — the curated preset list (spec §K.1). */
@Controller('platform/business-type-templates')
@PlatformRealm()
export class BusinessTypeTemplateController {
  constructor(private readonly svc: PlatformCatalogCapabilityService) {}

  @Get()
  @RequirePermission('platform:tenants:view')
  list() {
    return this.svc.listTemplates();
  }
}

/**
 * `/v1/platform/tenants/:tenantId/catalog-capabilities` — the Super-Admin
 * catalog-capability configuration surface (task 3.1 / spec §K).
 *   - GET  : `platform:catalog_capability:manage`, NO step-up (owner R-7)
 *   - PATCH: `platform:catalog_capability:manage` + fresh step-up (enforced by
 *     `STEP_UP_PERMISSIONS`); `If-Match` required (spec §L); `changes` only —
 *     NO `applyTemplateKey` / `merge` / `replace` (owner §9 — Task 3.10).
 */
@Controller('platform/tenants/:tenantId/catalog-capabilities')
@PlatformRealm()
export class PlatformTenantCatalogCapabilityController {
  constructor(private readonly svc: PlatformCatalogCapabilityService) {}

  @Get()
  @RequirePermission('platform:catalog_capability:manage')
  @NoStepUp()
  async get(
    @Param('tenantId') tenantId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    assertTenantId(tenantId);
    const view = await this.svc.getTenant(tenantId);
    void reply.header('etag', `"${view.aggregateVersion}"`);
    return view;
  }

  @Patch()
  @RequirePermission('platform:catalog_capability:manage')
  async patch(
    @Param('tenantId') tenantId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(patchSchema)) dto: z.infer<typeof patchSchema>,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    assertTenantId(tenantId);
    const view = await this.svc.patch({
      tenantId,
      expectedVersion: parseIfMatch(ifMatch),
      changes: dto.changes,
      reason: dto.reason ?? null,
      actorPlatformUserId: ctx.platformUserId,
    });
    void reply.header('etag', `"${view.aggregateVersion}"`);
    return view;
  }
}
