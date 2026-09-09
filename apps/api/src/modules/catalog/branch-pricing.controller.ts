import { Body, Controller, Get, Headers, Param, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  replaceBranchPricesSchema,
  structuralSetBranchAvailabilitySchema,
  duplicateVariantIds,
  isAscendingByVariantId,
  type BranchVariantPriceSetView,
  type ResolvedBranchPrice,
  type BranchAvailabilityView,
  type BranchAvailabilitySetResult,
  type BranchEffectiveCatalogEntry,
} from '@flower/shared-types';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';
import { BranchPricingService } from './branch-pricing.service.js';

/** Resolve query — ONLY `uomCode`. `.strict()` ⇒ an extra `branchId` (or anything
 *  else) is a deterministic `400`. */
const resolveQuerySchema = z.object({ uomCode: z.string().min(1).max(40) }).strict();

function parseStrictQuery<T extends z.ZodType>(schema: T, raw: Record<string, string>): z.infer<T> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new DomainError(
    'VALIDATION_FAILED',
    'the query string is invalid',
    400,
    r.error.issues.map((i) => {
      const field = i.path.join('.');
      return field ? { field, issue: i.message } : { issue: i.message };
    }),
  );
}

/**
 * `/v1/catalog/branches/:branchId/variants/:variantId/prices` — Task 3.8 branch
 * per-UOM SELL override. `branch_price:manage` + the `branch_pricing` capability
 * for writes / `catalog:view` for reads. Every route is
 * `@ScopedParam({ branch: 'branchId' })` — `requestedBranchId` is authorized
 * against `ctx.branchScope` + the per-branch overlay before any business access;
 * `companyId` is DERIVED from the authorized branch.
 *
 *  - `PUT` is a replace-set guarded by the dedicated `branch_variant_price_set`
 *    version (`If-Match` — NEVER `variant.version`; `"0"` = create; monotonic —
 *    no `DELETE`, BD-4). `PUT { prices: [] }` unprices (deletes rows, keeps the
 *    aggregate, bumps the version). A first empty PUT can create `v1` with NO
 *    company pricing (Correction 2).
 *  - `GET` returns the branch's own override rows + the aggregate version.
 *  - `GET …/resolve?uomCode=` returns the effective price (branch → company →
 *    null) + `branchAvailable` (never changes `price`).
 *
 * No `Idempotency-Key` on the price routes (a versioned replace-set). No
 * `branchId` / `companyId` / `purchase` in the wire contract. No realtime /
 * outbox (Task 3.10 — audit only).
 */
@Controller('catalog/branches/:branchId/variants/:variantId/prices')
export class BranchPricingController {
  constructor(private readonly svc: BranchPricingService) {}

  @Put()
  @RequirePermission('branch_price:manage')
  @ScopedParam({ branch: 'branchId' })
  async replace(
    @Param('branchId') branchId: string,
    @Param('variantId') variantId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(replaceBranchPricesSchema))
    dto: z.infer<typeof replaceBranchPricesSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<BranchVariantPriceSetView> {
    assertUuid(branchId, 'branch');
    assertUuid(variantId, 'variant');
    const out = await this.svc.replacePrices(
      branchId,
      variantId,
      dto.prices.map((p) => ({ uomCode: p.uomCode, sell: p.sell })),
      requireIfMatch(parseIfMatch(ifMatch)),
    );
    void reply.header('etag', `"${out.version}"`);
    return out;
  }

  @Get()
  @RequirePermission('catalog:view')
  @ScopedParam({ branch: 'branchId' })
  async get(
    @Param('branchId') branchId: string,
    @Param('variantId') variantId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<BranchVariantPriceSetView> {
    assertUuid(branchId, 'branch');
    assertUuid(variantId, 'variant');
    const out = await this.svc.getPrices(branchId, variantId);
    void reply.header('etag', `"${out.version}"`);
    return out;
  }

  @Get('resolve')
  @RequirePermission('catalog:view')
  @ScopedParam({ branch: 'branchId' })
  async resolve(
    @Param('branchId') branchId: string,
    @Param('variantId') variantId: string,
    @Query() raw: Record<string, string>,
  ): Promise<ResolvedBranchPrice> {
    assertUuid(branchId, 'branch');
    assertUuid(variantId, 'variant');
    const { uomCode } = parseStrictQuery(resolveQuerySchema, raw);
    return this.svc.resolvePrice(branchId, variantId, uomCode);
  }
}

const availabilityListQuerySchema = z.object({ variantId: z.string().uuid().optional() }).strict();

/**
 * `/v1/catalog/branches/:branchId/availability` — Task 3.8 branch merchandising
 * flag. Writes require `branch_price:manage` (permission) AND `branch_pricing`
 * (capability — checked in `BranchPricingService.setAvailability`, owner ruling
 * 2026-09-09); reads require only `catalog:view` and are never capability-gated.
 * Bulk declarative `PUT` — `Idempotency-Key` (no `If-Match`, no version).
 * Structural DTO validation → `400`; the semantic checks (duplicate `variantId`
 * → `422 BRANCH_AVAILABILITY_DUPLICATE_VARIANT`, non-ascending → `400`, unknown
 * tenant variant → `422`) run here as explicit typed domain errors (Correction H
 * — NOT a Zod refinement).
 */
@Controller('catalog/branches/:branchId/availability')
export class BranchAvailabilityController {
  constructor(private readonly svc: BranchPricingService) {}

  @Put()
  @RequirePermission('branch_price:manage')
  @ScopedParam({ branch: 'branchId' })
  @Idempotent({ scope: 'catalog.branch.availability.set' })
  async set(
    @Param('branchId') branchId: string,
    @Body(new ZodBody(structuralSetBranchAvailabilitySchema))
    dto: z.infer<typeof structuralSetBranchAvailabilitySchema>,
  ): Promise<BranchAvailabilitySetResult> {
    assertUuid(branchId, 'branch');
    // ── semantic validation, AFTER the structural parse (Correction H) ──────
    const dups = duplicateVariantIds(dto.entries);
    if (dups.length > 0) {
      throw new DomainError(
        'BRANCH_AVAILABILITY_DUPLICATE_VARIANT',
        `each variant may appear at most once — duplicated: ${dups.join(', ')}`,
        422,
        [{ field: 'entries', issue: 'duplicate variantId' }],
      );
    }
    if (!isAscendingByVariantId(dto.entries)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'entries must be sorted ascending by variantId (canonical form for deterministic idempotency)',
        400,
        [{ field: 'entries', issue: 'not sorted ascending by variantId' }],
      );
    }
    return this.svc.setAvailability(branchId, dto.entries);
  }

  @Get()
  @RequirePermission('catalog:view')
  @ScopedParam({ branch: 'branchId' })
  async list(
    @Param('branchId') branchId: string,
    @Query() raw: Record<string, string>,
  ): Promise<BranchAvailabilityView[]> {
    assertUuid(branchId, 'branch');
    const { variantId } = parseStrictQuery(availabilityListQuerySchema, raw);
    if (variantId !== undefined) assertUuid(variantId, 'variant');
    return this.svc.getAvailability(branchId, variantId);
  }
}

const effectiveCatalogQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * `/v1/catalog/branches/:branchId/catalog` — Task 3.8 branch-effective price +
 * availability projection for branch / POS bootstrap. `catalog:view`, cursor
 * paginated. Price + availability only — product names / categories / attributes
 * / identifiers / media / inventory come from the existing catalog reads (BD-14).
 */
@Controller('catalog/branches/:branchId/catalog')
export class BranchEffectiveCatalogController {
  constructor(private readonly svc: BranchPricingService) {}

  @Get()
  @RequirePermission('catalog:view')
  @ScopedParam({ branch: 'branchId' })
  async get(
    @Param('branchId') branchId: string,
    @Query() raw: Record<string, string>,
  ): Promise<{ entries: BranchEffectiveCatalogEntry[]; nextCursor: string | null }> {
    assertUuid(branchId, 'branch');
    const q = parseStrictQuery(effectiveCatalogQuerySchema, raw);
    return this.svc.getEffectiveCatalog(branchId, q.cursor, q.limit ?? 50);
  }
}
