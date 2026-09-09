import { Injectable } from '@nestjs/common';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { LocalizationRepository } from './localization.repository.js';
import type {
  CompanyLocalizationProfileDto,
  CountryDto,
  CurrencyDto,
  LocalizationReferenceDto,
  ResolvedTaxRateDto,
  TaxRegimeDto,
} from './localization.dto.js';

/**
 * Company-level fiscal/locale resolution (task 2.7 — ARCHITECTURE
 * "Localization reference data + service"). `forCompany` resolves from the
 * company's own `country_code` — **never** `tenant.region` (architecture
 * correction 4). Every method is effective-date aware: the tax regime/rate in
 * force is always resolved for the `at` date given, defaulting to now — the
 * authoritative tax-rate truth stays the effective-dated reference data
 * (`Country`/`CountryTaxConfig`/`TaxCategory`/`TaxRate`), never a value cached
 * on `company.fiscal_config` (owner rule 5). This is data + resolution only —
 * the tax-calculation engine (cart → tax lines) is Phase 3, not built here.
 */
@Injectable()
export class LocalizationService {
  constructor(private readonly repo: LocalizationRepository) {}

  /** The full reference-data snapshot for every active country, as of `at`. */
  async reference(at: Date = new Date()): Promise<LocalizationReferenceDto> {
    const [countries, currencies, locales] = await Promise.all([
      this.repo.findActiveCountries(),
      this.repo.findCurrencies(),
      this.repo.findLocales(),
    ]);
    const countryDtos = await Promise.all(countries.map((c) => this.countryDto(c.code, c, at)));
    return {
      at: at.toISOString(),
      countries: countryDtos,
      currencies: currencies.map(currencyDto),
      locales: locales.map((l) => ({
        code: l.code,
        nameEn: l.nameEn,
        nameAr: l.nameAr,
        direction: l.direction,
      })),
    };
  }

  /** One country's resolved profile as of `at` — used by `reference()` and
   *  directly by anything that already knows the country code. */
  async forCountry(code: string, at: Date = new Date()): Promise<CountryDto> {
    const countries = await this.repo.findActiveCountries();
    const country = countries.find((c) => c.code === code);
    if (!country) throw new NotFoundError('country');
    return this.countryDto(code, country, at);
  }

  /** A company's resolved fiscal/locale profile, from `company.country_code`
   *  — never `tenant.region`. Throws a clear, typed error (never a silent
   *  default) if the company has no country configured yet — today that is
   *  only possible for a company created through `OrgController.createCompany`
   *  (a tenant's 2nd+ company), which task 2.7 deliberately does not extend
   *  (see the task report / commit message: extending it would be a scope
   *  expansion beyond the approved plan's "schema-ready, no code needed"
   *  framing for that path). */
  async forCompany(
    companyId: string,
    at: Date = new Date(),
  ): Promise<CompanyLocalizationProfileDto> {
    const company = await this.repo.findCompanyProfile(companyId);
    if (!company.countryCode) {
      throw new DomainError(
        'COMPANY_LOCALIZATION_NOT_CONFIGURED',
        'this company has no country configured yet — its fiscal/locale profile cannot be resolved',
        409,
      );
    }
    const country = await this.forCountry(company.countryCode, at);
    return {
      companyId: company.id,
      countryCode: country.code,
      currency: await this.currencyDtoFor(country.defaultCurrencyCode),
      taxRegime: country.taxRegime,
      weekendModel: country.weekendModel,
      resolvedAt: at.toISOString(),
    };
  }

  /**
   * The AUTHORITATIVE country code for a company, from `company.country_code`
   * only (never `tenant.region`, never a client value). `409
   * COMPANY_LOCALIZATION_NOT_CONFIGURED` if the company has no country. Task 3.9
   * `TaxResolutionService` uses this (not `forCompany`) so tax resolution never
   * depends on `forCompany`'s regime/rate/currency assembly — the regime and
   * rate are resolved on a civil calendar date via `resolveRegimeOn` /
   * `resolveTaxRate`.
   */
  async resolveCompanyCountry(companyId: string): Promise<string> {
    const company = await this.repo.findCompanyProfile(companyId);
    if (!company.countryCode) {
      throw new DomainError(
        'COMPANY_LOCALIZATION_NOT_CONFIGURED',
        'this company has no country configured yet — its fiscal/locale profile cannot be resolved',
        409,
      );
    }
    return company.countryCode;
  }

  /**
   * The single `country_tax_config` regime for `countryCode` on the civil
   * calendar date `onDate` (`YYYY-MM-DD`, passed straight to `::date`-cast SQL —
   * no `Date`, no timezone). FAIL CLOSED: no row → `500 TAX_REGIME_NOT_CONFIGURED`;
   * `> 1` overlapping in-force row (any shape — same/different `effectiveFrom`,
   * finite/open-ended) → `500 TAX_REGIME_AMBIGUOUS` (CHECK 1 — never silently
   * picked).
   */
  async resolveRegimeOn(countryCode: string, onDate: string): Promise<'VAT' | 'NONE'> {
    const rows = await this.repo.findCountryTaxRegimeOn(countryCode, onDate);
    if (rows.length === 0) {
      throw new DomainError(
        'TAX_REGIME_NOT_CONFIGURED',
        `no tax regime is configured for ${countryCode} on ${onDate}`,
        500,
      );
    }
    if (rows.length > 1) {
      throw new DomainError(
        'TAX_REGIME_AMBIGUOUS',
        `more than one tax regime is in force for ${countryCode} on ${onDate} — ambiguous reference data`,
        500,
      );
    }
    return rows[0]!.regime === 'NONE' ? 'NONE' : 'VAT';
  }

  /**
   * The single effective `tax_rate` for `(countryCode, categoryKey)` on the
   * civil calendar date `onDate` (task 3.9 — the fiscal half of tax resolution;
   * the catalog category precedence is `TaxResolutionService`'s).
   *
   * DATE CONTRACT: `tax_rate` / `country_tax_config` `effective_from` /
   * `effective_to` are PostgreSQL `DATE` columns — a civil-calendar boundary,
   * not an instant. `onDate` is a canonical `YYYY-MM-DD` string (validated at
   * the controller) and is passed verbatim to `::date`-cast raw SQL — a pure
   * `DATE` vs `DATE` comparison, immune to the DB session timezone. There is NO
   * instant, NO offset, NO UTC normalization, NO JavaScript `Date` in the
   * rate-window selection, and NO jurisdiction / company / branch / POS
   * timezone. Task 3.9 is a reference resolver, not a transaction clock.
   *
   * Deterministic + FAIL CLOSED:
   *   - no `country_tax_config` on that date → `500 TAX_REGIME_NOT_CONFIGURED`.
   *   - `regime = NONE` (Qatar / Kuwait) → `{ regime: 'NONE', rate: null,
   *     reason: 'REGIME_NONE' }` — the ABSENCE of a VAT law, never a 0% rate.
   *   - VAT, no in-force `tax_rate` row for the category → `{ regime: 'VAT',
   *     rate: null, reason: 'NO_RATE_FOR_CATEGORY' }`.
   *   - VAT, EXACTLY ONE in-force row → `{ regime: 'VAT', rate: {...},
   *     reason: null }` — `rateBps: 0` here (`ZERO_RATED` / `EXEMPT`) is a
   *     REAL configured zero-rate, distinct from the two `null` cases above.
   *   - VAT, **> 1 in-force row → `500 TAX_RATE_AMBIGUOUS`** (CHECK 1, owner
   *     ruling): for one `(country, category, date)` there must be AT MOST ONE
   *     applicable rate. Overlapping in-force windows — whether they share an
   *     `effective_from`, differ on it, are finite, or one is open-ended — are
   *     corrupt reference data and are NEVER silently resolved by picking one.
   * `countryCode` MUST already be authoritative (`company.country_code`) — this
   * method never accepts one from a client.
   */
  async resolveTaxRate(
    countryCode: string,
    categoryKey: string,
    onDate: string,
  ): Promise<ResolvedTaxRateDto> {
    const regime = await this.resolveRegimeOn(countryCode, onDate);
    if (regime === 'NONE') {
      return { regime: 'NONE', rate: null, reason: 'REGIME_NONE' };
    }

    const rows = await this.repo.findTaxRatesForCategory(countryCode, categoryKey, onDate);
    if (rows.length === 0) {
      return { regime: 'VAT', rate: null, reason: 'NO_RATE_FOR_CATEGORY' };
    }
    if (rows.length > 1) {
      // FAIL CLOSED — overlapping in-force windows (any shape) = corrupt
      // reference data; never resolved by silently choosing one (CHECK 1).
      throw new DomainError(
        'TAX_RATE_AMBIGUOUS',
        `more than one tax rate is in force for ${countryCode}/${categoryKey} on ${onDate} — ambiguous reference data`,
        500,
      );
    }
    const r = rows[0]!;
    return {
      regime: 'VAT',
      rate: {
        rateBps: r.rateBps,
        effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
      },
      reason: null,
    };
  }

  private async countryDto(
    code: string,
    country: {
      nameEn: string;
      nameAr: string;
      region: string;
      defaultCurrencyCode: string;
      weekendModel: string;
    },
    at: Date,
  ): Promise<CountryDto> {
    return {
      code,
      nameEn: country.nameEn,
      nameAr: country.nameAr,
      region: country.region,
      defaultCurrencyCode: country.defaultCurrencyCode,
      weekendModel: country.weekendModel,
      taxRegime: await this.taxRegimeDto(code, at),
    };
  }

  private async taxRegimeDto(countryCode: string, at: Date): Promise<TaxRegimeDto> {
    const regime = await this.repo.findTaxRegime(countryCode, at);
    if (!regime) {
      throw new DomainError(
        'TAX_REGIME_NOT_CONFIGURED',
        `no tax regime is configured for ${countryCode} at ${at.toISOString()}`,
        500,
      );
    }
    // A NONE-regime country has no TaxRate rows at all (never a synthetic 0%
    // STANDARD rate) — `rates` is correctly empty in that case, not an error.
    const rates = regime.regime === 'NONE' ? [] : await this.repo.findTaxRates(countryCode, at);
    return {
      regime: regime.regime,
      effectiveFrom: regime.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: regime.effectiveTo ? regime.effectiveTo.toISOString().slice(0, 10) : null,
      rates: rates.map((r) => ({
        taxCategoryKey: r.taxCategoryKey,
        rateBps: r.rateBps,
        effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
      })),
    };
  }

  private async currencyDtoFor(code: string): Promise<CurrencyDto> {
    const currencies = await this.repo.findCurrencies();
    const currency = currencies.find((c) => c.code === code);
    if (!currency) {
      throw new DomainError(
        'CURRENCY_NOT_CONFIGURED',
        `currency ${code} is not in the reference table`,
        500,
      );
    }
    return currencyDto(currency);
  }
}

function currencyDto(c: {
  code: string;
  exponent: number;
  symbol: string;
  nameEn: string;
  nameAr: string;
}): CurrencyDto {
  return {
    code: c.code,
    exponent: c.exponent,
    symbol: c.symbol,
    nameEn: c.nameEn,
    nameAr: c.nameAr,
  };
}
