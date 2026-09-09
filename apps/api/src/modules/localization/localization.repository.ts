import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { NotFoundError } from '../../common/errors/domain-error.js';

export interface CountryRow {
  code: string;
  nameEn: string;
  nameAr: string;
  region: string;
  defaultCurrencyCode: string;
  weekendModel: string;
  active: boolean;
}
export interface CurrencyRow {
  code: string;
  exponent: number;
  symbol: string;
  nameEn: string;
  nameAr: string;
}
export interface LocaleRow {
  code: string;
  nameEn: string;
  nameAr: string;
  direction: string;
}
export interface TaxRateRow {
  taxCategoryKey: string;
  rateBps: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}
export interface TaxRegimeRow {
  regime: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}
export interface CompanyProfileRow {
  id: string;
  countryCode: string | null;
  defaultCurrency: string | null;
  fiscalConfig: unknown;
}

/**
 * Read-only access to the platform-global localization/fiscal reference tables
 * (`country` / `currency` / `country_tax_config` / `tax_category` / `tax_rate` /
 * `locale`) plus a tenant's own `company` row. These reference tables carry no
 * `tenant_id` and are RLS-exempt by design (ARCHITECTURE §"localization
 * reference data"); running through `ScopedRepository.scoped()` still connects
 * as `flower_app` (SELECT-only on these tables, per the task 2.1 migration's
 * explicit `REVOKE INSERT, UPDATE, DELETE ... FROM flower_app`) — the correct,
 * least-privilege path, even though the GUC it sets plays no role for a table
 * with no RLS policy on it. `company` reads go through the same `scoped()` call
 * and are RLS-protected as usual.
 */
@Injectable()
export class LocalizationRepository extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }

  /** Every active country — no tenant/company filter, deliberately: this table
   *  has no tenant dimension, so there is no tenant-scoped variant to leak. */
  findActiveCountries(): Promise<CountryRow[]> {
    return this.scoped((tx) =>
      tx.country.findMany({
        where: { active: true },
        orderBy: { code: 'asc' },
        select: {
          code: true,
          nameEn: true,
          nameAr: true,
          region: true,
          defaultCurrencyCode: true,
          weekendModel: true,
          active: true,
        },
      }),
    );
  }

  findCurrencies(): Promise<CurrencyRow[]> {
    return this.scoped((tx) =>
      tx.currency.findMany({
        orderBy: { code: 'asc' },
        select: { code: true, exponent: true, symbol: true, nameEn: true, nameAr: true },
      }),
    );
  }

  findLocales(): Promise<LocaleRow[]> {
    return this.scoped((tx) =>
      tx.locale.findMany({
        orderBy: { code: 'asc' },
        select: { code: true, nameEn: true, nameAr: true, direction: true },
      }),
    );
  }

  /** The tax regime in force for `countryCode` at `at` (CURSOR RULE-style
   *  effective-dating: `effectiveFrom <= at AND (effectiveTo IS NULL OR
   *  effectiveTo >= at)`). At most one row is ever in force for a given date —
   *  callers do not need to reason about overlapping ranges. */
  findTaxRegime(countryCode: string, at: Date): Promise<TaxRegimeRow | null> {
    return this.scoped((tx) =>
      tx.countryTaxConfig.findFirst({
        where: {
          countryCode,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        },
        orderBy: { effectiveFrom: 'desc' },
        select: { regime: true, effectiveFrom: true, effectiveTo: true },
      }),
    );
  }

  /** Every tax-category rate in force for `countryCode` at `at`. Empty for a
   *  `NONE`-regime country (Qatar / Kuwait) — no `TaxRate` rows are ever seeded
   *  for them; this is never a "0%" rate, it is the absence of one. */
  findTaxRates(countryCode: string, at: Date): Promise<TaxRateRow[]> {
    return this.scoped((tx) =>
      tx.taxRate.findMany({
        where: {
          countryCode,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        },
        orderBy: { taxCategoryKey: 'asc' },
        select: { taxCategoryKey: true, rateBps: true, effectiveFrom: true, effectiveTo: true },
      }),
    );
  }

  /**
   * The `tax_rate` rows in force for ONE `(countryCode, taxCategoryKey)` on the
   * civil calendar date `onDate` (`YYYY-MM-DD`), newest `effectiveFrom` first.
   * Task 3.9.
   *
   * A **`$queryRaw` with an explicit `::date` cast**, NOT a Prisma `Date`-typed
   * filter: `"effectiveFrom" <= $3::date` is a pure `DATE` vs `DATE` comparison,
   * immune to the DB session `TimeZone` and to any `TIMESTAMPTZ`-vs-`DATE`
   * implicit-cast drift a `Date` filter value can cause near a civil-date
   * boundary. `onDate` is a canonical `YYYY-MM-DD` civil date validated at the
   * controller and passed straight through — no `Date`, no timezone.
   *
   * The caller (`LocalizationService.resolveTaxRate`) fails CLOSED on `> 1` row
   * (CHECK 1). `orderBy effectiveFrom desc` is kept only for a stable error
   * message — it is NEVER used to pick a winner.
   */
  findTaxRatesForCategory(
    countryCode: string,
    taxCategoryKey: string,
    onDate: string,
  ): Promise<TaxRateRow[]> {
    return this.scoped(
      (tx) =>
        tx.$queryRaw<TaxRateRow[]>`
        SELECT "taxCategoryKey", "rateBps", "effectiveFrom", "effectiveTo"
          FROM "tax_rate"
         WHERE "countryCode" = ${countryCode}
           AND "taxCategoryKey" = ${taxCategoryKey}
           AND "effectiveFrom" <= ${onDate}::date
           AND ("effectiveTo" IS NULL OR "effectiveTo" >= ${onDate}::date)
         ORDER BY "effectiveFrom" DESC`,
    );
  }

  /**
   * The `country_tax_config` rows in force for `countryCode` on the civil
   * calendar date `onDate` (`YYYY-MM-DD`), newest first. Task 3.9. Same
   * `::date`-cast raw-SQL predicate as {@link findTaxRatesForCategory}
   * (DB-session-timezone immune, no `Date`). The caller fails CLOSED on `> 1`
   * row.
   */
  findCountryTaxRegimeOn(countryCode: string, onDate: string): Promise<TaxRegimeRow[]> {
    return this.scoped(
      (tx) =>
        tx.$queryRaw<TaxRegimeRow[]>`
        SELECT "regime", "effectiveFrom", "effectiveTo"
          FROM "country_tax_config"
         WHERE "countryCode" = ${countryCode}
           AND "effectiveFrom" <= ${onDate}::date
           AND ("effectiveTo" IS NULL OR "effectiveTo" >= ${onDate}::date)
         ORDER BY "effectiveFrom" DESC`,
    );
  }

  /** A company's own row — RLS already restricts this to the caller's tenant;
   *  the controller additionally declares `@ScopedParam({ company: 'companyId' })`
   *  so the guard pipeline rejects a companyId outside the caller's own scope
   *  before this ever runs (defense in depth, not the only check). */
  async findCompanyProfile(companyId: string): Promise<CompanyProfileRow> {
    const company = await this.scoped((tx: ScopedTx) =>
      tx.company.findUnique({
        where: { id: companyId },
        select: { id: true, countryCode: true, defaultCurrency: true, fiscalConfig: true },
      }),
    );
    if (!company) throw new NotFoundError('company');
    return company;
  }
}
