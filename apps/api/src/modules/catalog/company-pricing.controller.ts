import { Body, Controller, Get, Headers, Param, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { replaceCompanyPricesSchema } from '@flower/shared-types';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';
import {
  CompanyPricingRepository,
  type CompanyPriceSetView,
  type ResolvedCompanyPrice,
} from './company-pricing.repository.js';

/** Replace-set body — SELL price only, max 100 tiers (`replaceCompanyPricesSchema`
 *  is `.strict()` at every level: a stray `purchase` field — D-6 — or any unknown
 *  key is a deterministic 400). */
const putPricesSchema = replaceCompanyPricesSchema;

/** Resolve query — ONLY `uomCode`. `.strict()` ⇒ `branchId` (or anything else)
 *  is a deterministic 400 (D-10 — no `branchId` until Task 3.8). */
const resolveQuerySchema = z.object({ uomCode: z.string().min(1).max(40) }).strict();

function parseResolveQuery(raw: Record<string, string>): { uomCode: string } {
  const r = resolveQuerySchema.safeParse(raw);
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
 * `/v1/catalog/companies/:companyId/variants/:variantId/prices` — Task 3.7
 * company per-UOM SELL pricing. `pricing:manage` writes / `catalog:view` reads;
 * every route is `@ScopedParam({ company: 'companyId' })` (company scope is the
 * guard-pipeline step — RLS is tenant-level).
 *
 *  - `PUT` is a replace-set guarded by the dedicated `company_variant_price_set`
 *    version (`If-Match` — NOT `variant.version`; `"0"` = create). `PUT []`
 *    unprices (deletes rows, keeps the aggregate, bumps the version).
 *  - `GET` returns the company's own stored rows + the aggregate version.
 *  - `GET …/resolve?uomCode=` returns the effective company sell price or an
 *    explicit `{ price: null, reason }` (a missing price is `200`, never `422`).
 *
 * No `Idempotency-Key` (D2-9 — a versioned replace-set). No `branchId` (Task
 * 3.8). No `purchase` in the wire contract (D-6). No realtime / outbox (Task
 * 3.10 — audit only).
 */
@Controller('catalog/companies/:companyId/variants/:variantId/prices')
export class CompanyPricingController {
  constructor(private readonly repo: CompanyPricingRepository) {}

  @Put()
  @RequirePermission('pricing:manage')
  @ScopedParam({ company: 'companyId' })
  async replace(
    @Param('companyId') companyId: string,
    @Param('variantId') variantId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(putPricesSchema)) dto: z.infer<typeof putPricesSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CompanyPriceSetView> {
    assertUuid(companyId, 'company');
    assertUuid(variantId, 'variant');
    const out = await this.repo.replace(
      companyId,
      variantId,
      dto.prices.map((p) => ({ uomCode: p.uomCode, sell: p.sell })),
      requireIfMatch(parseIfMatch(ifMatch)),
    );
    void reply.header('etag', `"${out.version}"`);
    return out;
  }

  @Get()
  @RequirePermission('catalog:view')
  @ScopedParam({ company: 'companyId' })
  async get(
    @Param('companyId') companyId: string,
    @Param('variantId') variantId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CompanyPriceSetView> {
    assertUuid(companyId, 'company');
    assertUuid(variantId, 'variant');
    const out = await this.repo.getForCompanyVariant(companyId, variantId);
    void reply.header('etag', `"${out.version}"`);
    return out;
  }

  @Get('resolve')
  @RequirePermission('catalog:view')
  @ScopedParam({ company: 'companyId' })
  async resolve(
    @Param('companyId') companyId: string,
    @Param('variantId') variantId: string,
    @Query() raw: Record<string, string>,
  ): Promise<ResolvedCompanyPrice> {
    assertUuid(companyId, 'company');
    assertUuid(variantId, 'variant');
    const { uomCode } = parseResolveQuery(raw);
    return this.repo.resolve(companyId, variantId, uomCode);
  }
}
