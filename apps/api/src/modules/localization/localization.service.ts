import { Injectable } from '@nestjs/common';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { LocalizationRepository } from './localization.repository.js';
import type {
  CompanyLocalizationProfileDto,
  CountryDto,
  CurrencyDto,
  LocalizationReferenceDto,
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
