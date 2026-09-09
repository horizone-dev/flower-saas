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
 *   - `resolveCompanyCountry(companyId)` → the AUTHORITATIVE country from
 *     `company.country_code` (never a client value, never branch / POS);
 *     `409 COMPANY_LOCALIZATION_NOT_CONFIGURED` if the company has no country.
 *   - `resolveRegimeOn(country, at)` → the `country_tax_config` regime on the
 *     civil date; `500 TAX_REGIME_NOT_CONFIGURED` / `TAX_REGIME_AMBIGUOUS`.
 *   - `resolveTaxRate(country, key, at)` → THE single effective `tax_rate` on
 *     the civil date: `> 1` in-force row (overlap of ANY shape) →
 *     `500 TAX_RATE_AMBIGUOUS` (CHECK 1 — fail closed, never pick one); keeps
 *     `REGIME_NONE` vs `NO_RATE_FOR_CATEGORY` distinct from a configured `0`.
 *
 * DATE CONTRACT (CHECK 2): the fiscal reference columns are PostgreSQL `DATE`
 * (a civil boundary). `at` (an instant) is reduced to its **UTC calendar date**
 * (`toFiscalDate`) and passed as a `YYYY-MM-DD` string to `::date`-cast raw SQL
 * in the repository, so resolution is deterministic across timezone offsets and
 * DB session timezones (same instant ⇒ same rate, no ±1-day drift). The response
 * `resolvedAt` still echoes the exact instant asked about.
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
    // CHECK 2 — `resolveRegimeOn` / `resolveTaxRate` reduce `at` to its UTC
    // calendar date internally and match via `::date`-cast raw SQL. `at` here is
    // only echoed as `resolvedAt` (the exact instant asked about).
    const resolvedAt = at.toISOString();

    // 1. catalog category precedence (tenant-scoped read; 404 on unknown variant)
    const ctx = await this.repo.getResolutionContext(input.variantId);
    const resolvedKey = ctx.variantTaxCategoryKey ?? ctx.productTaxCategoryKey ?? null;
    const categorySource: TaxCategorySource =
      ctx.variantTaxCategoryKey !== null
        ? 'VARIANT'
        : ctx.productTaxCategoryKey !== null
          ? 'PRODUCT'
          : 'NONE';

    // 2. authoritative country from company.country_code (409 if unconfigured)
    const countryCode = await this.localization.resolveCompanyCountry(input.companyId);

    // 3a. nothing configured — NEVER 0%, a distinct terminal state. Still carries
    // the country + regime (resolved on the civil date, fail closed).
    if (resolvedKey === null) {
      const regime = await this.localization.resolveRegimeOn(countryCode, at);
      return {
        variantId: input.variantId,
        companyId: input.companyId,
        countryCode,
        regime,
        taxCategoryKey: null,
        categorySource,
        rateBps: null,
        effectiveFrom: null,
        effectiveTo: null,
        resolvedAt,
        reason: 'NO_CATEGORY_ASSIGNED',
      };
    }

    // 3b. resolve the effective rate for the resolved category (fiscal module)
    const rr = await this.localization.resolveTaxRate(countryCode, resolvedKey, at);
    const reason: TaxResolutionReason | null = rr.reason;
    return {
      variantId: input.variantId,
      companyId: input.companyId,
      countryCode,
      regime: rr.regime,
      taxCategoryKey: resolvedKey,
      categorySource,
      rateBps: rr.rate ? rr.rate.rateBps : null,
      effectiveFrom: rr.rate ? rr.rate.effectiveFrom : null,
      effectiveTo: rr.rate ? rr.rate.effectiveTo : null,
      resolvedAt,
      reason,
    };
  }
}
