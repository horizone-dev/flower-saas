import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { applyBusinessTypeTemplateSchema, capabilityKeySchema } from '@flower/shared-types';
import { NoStepUp, PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx, type RequestContext } from '../../common/context/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
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

const IDEM_KEY_RE = /^[A-Za-z0-9._~:-]{8,200}$/;

/**
 * `POST /v1/platform/tenants/:tenantId/apply-business-type-template` — task 3.10,
 * owner D-1…D-4. An explicit, audited Super-Admin **re-apply** of a Business-Type
 * CAPABILITY preset (`merge` / `replace`, `PHASE-3.1-CAPABILITY-SPEC.md` §J).
 * NEVER creates a catalog entity / price / inventory (owner D-7). NEVER emits an
 * outbox event (owner D-2).
 *   - `platform:catalog_capability:manage` + **fresh step-up** (default —
 *     `platform:catalog_capability:manage` is in `STEP_UP_PERMISSIONS`).
 *   - `Idempotency-Key` **required** — replayed key returns the stored response
 *     without re-executing (owner D-3).
 *   - `If-Match: "<catalogCapabilityVersion>"` **required** — missing → `428`,
 *     stale → `409 CATALOG_CAPABILITY_VERSION_CONFLICT` (owner D-3).
 *   - `templateKey` MAY differ from the tenant's current `businessTypeKey`
 *     (owner D-4) — a successful logical apply re-stamps the primary preset.
 */
@Controller('platform/tenants/:tenantId/apply-business-type-template')
@PlatformRealm()
export class PlatformTenantApplyTemplateController {
  constructor(private readonly svc: PlatformCatalogCapabilityService) {}

  @Post()
  @HttpCode(200)
  @RequirePermission('platform:catalog_capability:manage')
  async apply(
    @Param('tenantId') tenantId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodBody(applyBusinessTypeTemplateSchema))
    dto: z.infer<typeof applyBusinessTypeTemplateSchema>,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    assertTenantId(tenantId);
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new DomainError('IDEMPOTENCY_KEY_MISSING', 'Idempotency-Key header is required', 400);
    }
    if (!IDEM_KEY_RE.test(key)) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be 8–200 chars of [A-Za-z0-9._~:-]',
        400,
      );
    }
    const view = await this.svc.reapply({
      tenantId,
      templateKey: dto.templateKey,
      mode: dto.mode,
      expectedVersion: parseIfMatch(ifMatch),
      idempotencyKey: key,
      actorPlatformUserId: ctx.platformUserId,
    });
    void reply.header('etag', `"${view.aggregateVersion}"`);
    return view;
  }
}
