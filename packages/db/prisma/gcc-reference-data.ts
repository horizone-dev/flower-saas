/**
 * The GCC localization/fiscal reference-data seed (task 2.7). Every value here
 * is documented, with sources and verification status, in
 * `docs/phase-2/GCC-FISCAL-REFERENCE.md` — that file is the record of record;
 * this module is its executable form. **This is a verified platform reference
 * starting point, not a permanent legal/compliance guarantee** — pre-onboarding
 * verification against the current official source is mandatory for every
 * country before any tenant is onboarded in it (architecture correction 4).
 *
 * Deliberately NOT seeded: any Islamic/lunar (Hijri) holiday (Eid al-Fitr, Eid
 * al-Adha, Hijri New Year, Prophet's Birthday, Isra & Mi'raj, Arafat Day) —
 * their Gregorian dates are moon-sighting-dependent and are only ever announced
 * shortly before the observance; inventing or predicting a future date for one
 * would violate the "do not manufacture future dates" rule. Only fixed-Gregorian
 * -date national holidays are seeded, and only for the current calendar year.
 */

export interface CountrySeed {
  code: string;
  nameEn: string;
  nameAr: string;
  region: string;
  defaultCurrencyCode: string;
  weekendModel: 'FRI_SAT' | 'SAT_SUN';
  active: boolean;
}

export interface CurrencySeed {
  code: string;
  exponent: number;
  symbol: string;
  nameEn: string;
  nameAr: string;
}

export interface TaxConfigSeed {
  countryCode: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  regime: 'VAT' | 'NONE';
}

export interface TaxCategorySeed {
  key: string;
  nameEn: string;
  nameAr: string;
  description: string;
}

export interface TaxRateSeed {
  countryCode: string;
  taxCategoryKey: string;
  rateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface LocaleSeed {
  code: string;
  nameEn: string;
  nameAr: string;
  direction: 'ltr' | 'rtl';
}

export interface HolidaySeed {
  countryCode: string;
  onDate: string; // YYYY-MM-DD
  nameEn: string;
  nameAr: string;
  kind: 'NATIONAL';
}

export const GCC_CURRENCIES: readonly CurrencySeed[] = [
  { code: 'AED', exponent: 2, symbol: 'AED', nameEn: 'UAE Dirham', nameAr: 'درهم إماراتي' },
  { code: 'SAR', exponent: 2, symbol: 'SAR', nameEn: 'Saudi Riyal', nameAr: 'ريال سعودي' },
  { code: 'QAR', exponent: 2, symbol: 'QAR', nameEn: 'Qatari Riyal', nameAr: 'ريال قطري' },
  { code: 'KWD', exponent: 3, symbol: 'KWD', nameEn: 'Kuwaiti Dinar', nameAr: 'دينار كويتي' },
  { code: 'BHD', exponent: 3, symbol: 'BHD', nameEn: 'Bahraini Dinar', nameAr: 'دينار بحريني' },
  { code: 'OMR', exponent: 3, symbol: 'OMR', nameEn: 'Omani Rial', nameAr: 'ريال عماني' },
];

export const GCC_COUNTRIES: readonly CountrySeed[] = [
  {
    code: 'AE',
    nameEn: 'United Arab Emirates',
    nameAr: 'الإمارات العربية المتحدة',
    region: 'gcc',
    defaultCurrencyCode: 'AED',
    weekendModel: 'SAT_SUN',
    active: true,
  },
  {
    code: 'SA',
    nameEn: 'Saudi Arabia',
    nameAr: 'المملكة العربية السعودية',
    region: 'gcc',
    defaultCurrencyCode: 'SAR',
    weekendModel: 'FRI_SAT',
    active: true,
  },
  {
    code: 'QA',
    nameEn: 'Qatar',
    nameAr: 'قطر',
    region: 'gcc',
    defaultCurrencyCode: 'QAR',
    weekendModel: 'FRI_SAT',
    active: true,
  },
  {
    code: 'KW',
    nameEn: 'Kuwait',
    nameAr: 'الكويت',
    region: 'gcc',
    defaultCurrencyCode: 'KWD',
    weekendModel: 'FRI_SAT',
    active: true,
  },
  {
    code: 'BH',
    nameEn: 'Bahrain',
    nameAr: 'البحرين',
    region: 'gcc',
    defaultCurrencyCode: 'BHD',
    weekendModel: 'FRI_SAT',
    active: true,
  },
  {
    code: 'OM',
    nameEn: 'Oman',
    nameAr: 'عُمان',
    region: 'gcc',
    defaultCurrencyCode: 'OMR',
    weekendModel: 'FRI_SAT',
    active: true,
  },
];

/**
 * One row per (country, regime) validity window. UAE/Oman have had one regime
 * (`VAT`) since introduction with no rate change to date; Saudi Arabia and
 * Bahrain each have TWO windows because their standard rate changed (modelled
 * as two `TaxRate` rows below, not a mutation of one) while the `regime` itself
 * (`VAT`) never changed — so each of those two countries gets ONE
 * `CountryTaxConfig` row (the regime, open-ended) plus TWO `TaxRate` rows (the
 * two rate periods). Qatar and Kuwait get a `NONE`-regime row and **zero**
 * `TaxRate` rows — `NONE` is a distinct state from "a 0% rate".
 */
export const GCC_TAX_CONFIGS: readonly TaxConfigSeed[] = [
  { countryCode: 'AE', effectiveFrom: '2018-01-01', effectiveTo: null, regime: 'VAT' },
  { countryCode: 'SA', effectiveFrom: '2018-01-01', effectiveTo: null, regime: 'VAT' },
  { countryCode: 'BH', effectiveFrom: '2019-01-01', effectiveTo: null, regime: 'VAT' },
  { countryCode: 'OM', effectiveFrom: '2021-04-16', effectiveTo: null, regime: 'VAT' },
  { countryCode: 'QA', effectiveFrom: '2016-06-01', effectiveTo: null, regime: 'NONE' },
  { countryCode: 'KW', effectiveFrom: '2016-06-01', effectiveTo: null, regime: 'NONE' },
];

export const TAX_CATEGORIES: readonly TaxCategorySeed[] = [
  {
    key: 'STANDARD',
    nameEn: 'Standard rate',
    nameAr: 'المعدل الأساسي',
    description: 'The default taxable rate.',
  },
  {
    key: 'ZERO_RATED',
    nameEn: 'Zero-rated',
    nameAr: 'معدل صفري',
    description: 'Taxable at 0% — distinct from exempt (input VAT is still recoverable).',
  },
  {
    key: 'EXEMPT',
    nameEn: 'Exempt',
    nameAr: 'معفى',
    description: 'Outside the scope of VAT — input VAT is not recoverable.',
  },
];

/**
 * Every rate is stated at basis points (500 = 5.00%). Sources + verification
 * dates for each row are in `GCC-FISCAL-REFERENCE.md` — summarized here only
 * as inline comments for at-a-glance review, not as the record of record.
 */
export const GCC_TAX_RATES: readonly TaxRateSeed[] = [
  // UAE — 5% standard since introduction (Federal Decree-Law No. 8 of 2017),
  // no rate change to date.
  {
    countryCode: 'AE',
    taxCategoryKey: 'STANDARD',
    rateBps: 500,
    effectiveFrom: '2018-01-01',
    effectiveTo: null,
  },
  {
    countryCode: 'AE',
    taxCategoryKey: 'ZERO_RATED',
    rateBps: 0,
    effectiveFrom: '2018-01-01',
    effectiveTo: null,
  },
  {
    countryCode: 'AE',
    taxCategoryKey: 'EXEMPT',
    rateBps: 0,
    effectiveFrom: '2018-01-01',
    effectiveTo: null,
  },

  // Saudi Arabia — 5% from introduction (2018-01-01), raised to 15% effective
  // 2020-07-01 (announced 2020-05-11 in response to COVID-19 fiscal impact).
  {
    countryCode: 'SA',
    taxCategoryKey: 'STANDARD',
    rateBps: 500,
    effectiveFrom: '2018-01-01',
    effectiveTo: '2020-06-30',
  },
  {
    countryCode: 'SA',
    taxCategoryKey: 'STANDARD',
    rateBps: 1500,
    effectiveFrom: '2020-07-01',
    effectiveTo: null,
  },
  {
    countryCode: 'SA',
    taxCategoryKey: 'ZERO_RATED',
    rateBps: 0,
    effectiveFrom: '2018-01-01',
    effectiveTo: null,
  },
  {
    countryCode: 'SA',
    taxCategoryKey: 'EXEMPT',
    rateBps: 0,
    effectiveFrom: '2018-01-01',
    effectiveTo: null,
  },

  // Bahrain — 5% from introduction (2019-01-01), raised to 10% effective
  // 2022-01-01.
  {
    countryCode: 'BH',
    taxCategoryKey: 'STANDARD',
    rateBps: 500,
    effectiveFrom: '2019-01-01',
    effectiveTo: '2021-12-31',
  },
  {
    countryCode: 'BH',
    taxCategoryKey: 'STANDARD',
    rateBps: 1000,
    effectiveFrom: '2022-01-01',
    effectiveTo: null,
  },
  {
    countryCode: 'BH',
    taxCategoryKey: 'ZERO_RATED',
    rateBps: 0,
    effectiveFrom: '2019-01-01',
    effectiveTo: null,
  },
  {
    countryCode: 'BH',
    taxCategoryKey: 'EXEMPT',
    rateBps: 0,
    effectiveFrom: '2019-01-01',
    effectiveTo: null,
  },

  // Oman — 5% since introduction (2021-04-16, Royal Decree 121/2020), no rate
  // change to date.
  {
    countryCode: 'OM',
    taxCategoryKey: 'STANDARD',
    rateBps: 500,
    effectiveFrom: '2021-04-16',
    effectiveTo: null,
  },
  {
    countryCode: 'OM',
    taxCategoryKey: 'ZERO_RATED',
    rateBps: 0,
    effectiveFrom: '2021-04-16',
    effectiveTo: null,
  },
  {
    countryCode: 'OM',
    taxCategoryKey: 'EXEMPT',
    rateBps: 0,
    effectiveFrom: '2021-04-16',
    effectiveTo: null,
  },

  // Qatar, Kuwait: deliberately NO rows — `regime: 'NONE'` above is the
  // complete representation; a rate row (even 0 bps) would misrepresent "no
  // VAT law exists" as "a 0% VAT law exists".
];

export const LOCALES: readonly LocaleSeed[] = [
  { code: 'en', nameEn: 'English', nameAr: 'الإنجليزية', direction: 'ltr' },
  { code: 'ar', nameEn: 'Arabic', nameAr: 'العربية', direction: 'rtl' },
];

/**
 * ONLY fixed-Gregorian-date national holidays, ONLY for the current reference
 * year noted below. No lunar/Islamic holiday is seeded (see file header). This
 * is a minimal, current-year-only starting point — re-seeding for a later year
 * is an operational task, not automated by this module, and is called out
 * explicitly in `GCC-FISCAL-REFERENCE.md` as a pending item, not silently
 * assumed to renew itself.
 */
export const GCC_HOLIDAYS_2026: readonly HolidaySeed[] = [
  {
    countryCode: 'AE',
    onDate: '2026-12-02',
    nameEn: 'UAE National Day',
    nameAr: 'اليوم الوطني الإماراتي',
    kind: 'NATIONAL',
  },
  {
    countryCode: 'SA',
    onDate: '2026-09-23',
    nameEn: 'Saudi National Day',
    nameAr: 'اليوم الوطني السعودي',
    kind: 'NATIONAL',
  },
  {
    countryCode: 'QA',
    onDate: '2026-12-18',
    nameEn: 'Qatar National Day',
    nameAr: 'اليوم الوطني القطري',
    kind: 'NATIONAL',
  },
  {
    countryCode: 'KW',
    onDate: '2026-02-25',
    nameEn: 'Kuwait National Day',
    nameAr: 'اليوم الوطني الكويتي',
    kind: 'NATIONAL',
  },
  {
    countryCode: 'BH',
    onDate: '2026-12-16',
    nameEn: 'Bahrain National Day',
    nameAr: 'اليوم الوطني البحريني',
    kind: 'NATIONAL',
  },
  {
    countryCode: 'OM',
    onDate: '2026-11-18',
    nameEn: 'Oman National Day',
    nameAr: 'اليوم الوطني العماني',
    kind: 'NATIONAL',
  },
];
