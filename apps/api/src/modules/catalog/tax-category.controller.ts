import { Body, Controller, Get, Headers, Param, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  isFiscalDate,
  setTaxCategorySchema,
  type TaxCategoryAssignmentView,
  type TaxResolutionResult,
} from '@flower/shared-types';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';
import { TaxCategoryRepository } from './tax-category.repository.js';
import { TaxResolutionService } from './tax-resolution.service.js';

/**
 * `?date=YYYY-MM-DD` — **REQUIRED**. A civil calendar date and nothing else: NO
 * time, NO timezone, NO ISO instant. The fiscal reference bounds (`tax_rate`,
 * `country_tax_config`) are PostgreSQL `DATE` (a civil boundary), so resolution
 * takes a civil date directly — there is no instant→date reduction and no
 * timezone anywhere in Task 3.9 (it is a reference resolver, not a transaction
 * clock). A missing `date` or an unknown query key → `400 VALIDATION_FAILED`;
 * a value that is not a real `YYYY-MM-DD` — an ISO instant, a `+04:00` / `Z`
 * offset, `07/01/2026`, `2026-2-3`, an impossible date like `2026-02-30` →
 * `400 INVALID_DATE`. An ISO timestamp is NEVER silently truncated to its date
 * prefix.
 */
const resolveQuerySchema = z.object({ date: z.string() }).strict();

function parseResolveQuery(raw: Record<string, string>): string {
  const r = resolveQuerySchema.safeParse(raw);
  if (!r.success) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'the query string is invalid — `?date=YYYY-MM-DD` is required',
      400,
      r.error.issues.map((i) => {
        const field = i.path.join('.');
        return field ? { field, issue: i.message } : { issue: i.message };
      }),
    );
  }
  if (!isFiscalDate(r.data.date)) {
    throw new DomainError(
      'INVALID_DATE',
      '"date" must be a civil calendar date in YYYY-MM-DD form (no time, no timezone)',
      400,
    );
  }
  return r.data.date;
}

function assignmentEtag(
  reply: FastifyReply,
  row: TaxCategoryAssignmentView,
): TaxCategoryAssignmentView {
  void reply.header('etag', `"${row.version}"`);
  return row;
}

/**
 * `PUT /v1/catalog/products/:productId/tax-category` — assign / reassign / clear
 * (`{ taxCategoryKey: null }`) the product's default VAT tax category (task 3.9).
 * `catalog:manage` (owner O1 — product tax category is catalog metadata),
 * tenant-scoped, `If-Match: "<product.version>"` mandatory. One audit row per
 * success; an ARCHIVED product is blocked (`409 PRODUCT_ARCHIVED`, owner O2). No
 * `Idempotency-Key`, no capability, no realtime / outbox.
 */
@Controller('catalog/products/:productId/tax-category')
export class ProductTaxCategoryController {
  constructor(private readonly repo: TaxCategoryRepository) {}

  @Put()
  @RequirePermission('catalog:manage')
  async set(
    @Param('productId') productId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(setTaxCategorySchema)) dto: z.infer<typeof setTaxCategorySchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TaxCategoryAssignmentView> {
    assertUuid(productId, 'product');
    return assignmentEtag(
      reply,
      await this.repo.setProductTaxCategory(
        productId,
        requireIfMatch(parseIfMatch(ifMatch)),
        dto.taxCategoryKey,
      ),
    );
  }
}

/**
 * `PUT /v1/catalog/variants/:variantId/tax-category` — assign / reassign / clear
 * the variant's VAT tax-category OVERRIDE (task 3.9). `variants:manage` (owner
 * O1 — a variant-owned mutation follows the variant permission boundary),
 * tenant-scoped, `If-Match: "<variant.version>"` mandatory. When cleared the
 * variant inherits `product.taxCategoryKey` (precedence). ARCHIVED variant
 * blocked (`409 VARIANT_ARCHIVED`).
 */
@Controller('catalog/variants/:variantId/tax-category')
export class VariantTaxCategoryController {
  constructor(private readonly repo: TaxCategoryRepository) {}

  @Put()
  @RequirePermission('variants:manage')
  async set(
    @Param('variantId') variantId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(setTaxCategorySchema)) dto: z.infer<typeof setTaxCategorySchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TaxCategoryAssignmentView> {
    assertUuid(variantId, 'variant');
    return assignmentEtag(
      reply,
      await this.repo.setVariantTaxCategory(
        variantId,
        requireIfMatch(parseIfMatch(ifMatch)),
        dto.taxCategoryKey,
      ),
    );
  }
}

/**
 * `GET /v1/catalog/companies/:companyId/variants/:variantId/tax` — the effective
 * tax category (variant -> product -> NONE) + the applicable effective
 * `tax_rate` for the company's AUTHORITATIVE country (`company.country_code`) on
 * a **required** `?date=YYYY-MM-DD` civil calendar date (task 3.9). No time, no
 * timezone, no ISO instant — Task 3.9 is a reference resolver, not a transaction
 * clock, and there is no company / branch / POS / UTC timezone conversion path
 * at all. `catalog:view`, `@ScopedParam({ company: 'companyId' })` (a company
 * outside the caller's scope → `404`, `COMPANY_OUT_OF_SCOPE` masked). Reads Task
 * 2.7 reference data via `TaxResolutionService` / `LocalizationService`.
 * **Returns metadata + `rateBps` only — NEVER a computed tax amount** (D2-8).
 * Missing category / missing rate / regime NONE are `200` with a `reason`, never
 * `422`; `> 1` in-force `tax_rate` for one `(country, category, date)` →
 * `500 TAX_RATE_AMBIGUOUS` (fail closed — CHECK 1). No audit row. No `branchId` /
 * `posTerminalId` — branch is not a tax authority.
 */
@Controller('catalog/companies/:companyId/variants/:variantId/tax')
export class CatalogTaxController {
  constructor(private readonly svc: TaxResolutionService) {}

  @Get()
  @RequirePermission('catalog:view')
  @ScopedParam({ company: 'companyId' })
  resolve(
    @Param('companyId') companyId: string,
    @Param('variantId') variantId: string,
    @Query() raw: Record<string, string>,
  ): Promise<TaxResolutionResult> {
    assertUuid(companyId, 'company');
    assertUuid(variantId, 'variant');
    const date = parseResolveQuery(raw);
    return this.svc.resolve({ companyId, variantId, date });
  }
}
