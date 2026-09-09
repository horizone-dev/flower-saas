import { Injectable } from '@nestjs/common';
import type {
  TaxCategorySource,
  TaxResolutionReason,
  TaxResolutionResult,
} from '@flower/shared-types';
import { LocalizationService } from '../localization/localization.service.js';
import { TaxCategoryRepository } from './tax-category.repository.js';

/**
 * Task 3.9 — effective tax-category inheritance + effective `tax_rate`
 * resolution for ONE variant, in ONE company's fiscal context.
 *
 * This service owns ONLY:
 *   1. the catalog category precedence `variant.taxCategoryKey ->
 *      product.taxCategoryKey -> NONE` (D1 / §10). There is NO further fallback
 *      — no jurisdiction / company / tenant default tax category exists in the
 *      current model (§9), so `NONE` is a real terminal state.
 *   2. assembling the response.
 *
 * Everything fiscal is delegated to `LocalizationService` (Task 2.7, reused —
 * "no second fiscal architecture"):
 *   - `forCompany(companyId, at)` resolves the AUTHORITATIVE country from
 *     `company.country_code` (never a client value, never branch / POS) and
 *     fails closed: `409 COMPANY_LOCALIZATION_NOT_CONFIGURED` if the company has
 *     no country, `500 TAX_REGIME_NOT_CONFIGURED` if the country has no regime.
 *   - `resolveTaxRate(countryCode, key, at)` selects the single effective
 *     `tax_rate` (deterministic effective-date window; newest `effectiveFrom`
 *     wins a bad-data overlap; a true tie → `500 TAX_RATE_AMBIGUOUS`) and keeps
 *     `REGIME_NONE` vs `NO_RATE_FOR_CATEGORY` distinct from a configured `0`.
 *
 * NEVER computes a taxable amount, tax amount, gross/net, or an
 * inclusive/exclusive transformation (D2-8 — that is Phase 3b). `rateBps` is
 * returned raw. NO audit row (a pure read). Business Type is never read.
 */
@Injectable()
export class TaxResolutionService {
  constructor(
    private readonly repo: TaxCategoryRepository,
    private readonly localization: LocalizationService,
  ) {}

  async resolve(input: {
    companyId: string;
    variantId: string;
    at?: Date | undefined;
  }): Promise<TaxResolutionResult> {
    const at = input.at ?? new Date();

    // 1. catalog category precedence (tenant-scoped read; 404 on unknown variant)
    const ctx = await this.repo.getResolutionContext(input.variantId);
    const resolvedKey = ctx.variantTaxCategoryKey ?? ctx.productTaxCategoryKey ?? null;
    const categorySource: TaxCategorySource =
      ctx.variantTaxCategoryKey !== null
        ? 'VARIANT'
        : ctx.productTaxCategoryKey !== null
          ? 'PRODUCT'
          : 'NONE';

    // 2. authoritative country + regime from company.country_code (fail closed)
    const profile = await this.localization.forCompany(input.companyId, at);
    const countryCode = profile.countryCode;
    const regime = profile.taxRegime.regime === 'NONE' ? 'NONE' : 'VAT';
    const resolvedAt = at.toISOString();

    const base = {
      variantId: input.variantId,
      companyId: input.companyId,
      countryCode,
      regime: regime as 'VAT' | 'NONE',
      resolvedAt,
    };

    // 3a. nothing configured — NEVER 0%, a distinct terminal state.
    // `resolvedKey === null` iff `categorySource === 'NONE'` (this also narrows
    // `resolvedKey` to `string` for the rate resolution below).
    if (resolvedKey === null) {
      return {
        ...base,
        taxCategoryKey: null,
        categorySource,
        rateBps: null,
        effectiveFrom: null,
        effectiveTo: null,
        reason: 'NO_CATEGORY_ASSIGNED',
      };
    }

    // 3b. resolve the effective rate for the resolved category (fiscal module)
    const rr = await this.localization.resolveTaxRate(countryCode, resolvedKey, at);
    const reason: TaxResolutionReason | null = rr.reason;
    return {
      ...base,
      regime: rr.regime,
      taxCategoryKey: resolvedKey,
      categorySource,
      rateBps: rr.rate ? rr.rate.rateBps : null,
      effectiveFrom: rr.rate ? rr.rate.effectiveFrom : null,
      effectiveTo: rr.rate ? rr.rate.effectiveTo : null,
      reason,
    };
  }
}
