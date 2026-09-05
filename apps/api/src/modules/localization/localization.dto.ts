/**
 * Explicit response shapes for the localization module. Never the raw Prisma
 * row — every field here is deliberately chosen; adding a DB column never
 * silently changes what a client receives.
 */

export interface TaxRateDto {
  taxCategoryKey: string;
  /** basis points (500 = 5.00%) — never a pre-divided float. */
  rateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** `regime: 'NONE'` means "this country has no VAT" — never represented as a
 *  `STANDARD` rate of `0`. `rates` is always empty for a `NONE` regime. */
export interface TaxRegimeDto {
  regime: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  rates: TaxRateDto[];
}

export interface CountryDto {
  code: string;
  nameEn: string;
  nameAr: string;
  region: string;
  defaultCurrencyCode: string;
  weekendModel: string;
  /** the regime in force at the resolution date this DTO was built for. */
  taxRegime: TaxRegimeDto;
}

export interface CurrencyDto {
  code: string;
  exponent: number;
  symbol: string;
  nameEn: string;
  nameAr: string;
}

export interface LocaleDto {
  code: string;
  nameEn: string;
  nameAr: string;
  direction: string;
}

/** `GET /localization/reference` — the full authenticated reference-data
 *  snapshot, resolved as of `at`. */
export interface LocalizationReferenceDto {
  at: string;
  countries: CountryDto[];
  currencies: CurrencyDto[];
  locales: LocaleDto[];
}

/** `GET /localization/companies/:companyId` — one company's resolved fiscal /
 *  locale profile, as of `at`. */
export interface CompanyLocalizationProfileDto {
  companyId: string;
  countryCode: string;
  currency: CurrencyDto;
  taxRegime: TaxRegimeDto;
  weekendModel: string;
  resolvedAt: string;
}
