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
