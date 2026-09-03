/**
 * Locale + RTL helpers (ARCHITECTURE §45). GCC launch locales are en + ar with
 * full RTL. Message catalogs and CLDR wiring are added per phase; this is the
 * Phase 0 seed.
 */

export const SUPPORTED_LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** BCP-47 aware: 'ar', 'ar-AE', 'AR_ae' -> true. */
export function isRtlLocale(locale: string): boolean {
  const lang = locale.toLowerCase().replace('_', '-').split('-')[0] ?? '';
  return RTL_LANGUAGES.has(lang);
}

export function textDirection(locale: string): 'rtl' | 'ltr' {
  return isRtlLocale(locale) ? 'rtl' : 'ltr';
}

/** GCC country -> default locale + currency (localization module seeds this properly). */
export const GCC_COUNTRY_DEFAULTS: Record<string, { locale: Locale; currency: string }> = {
  AE: { locale: 'ar', currency: 'AED' },
  SA: { locale: 'ar', currency: 'SAR' },
  QA: { locale: 'ar', currency: 'QAR' },
  KW: { locale: 'ar', currency: 'KWD' },
  BH: { locale: 'ar', currency: 'BHD' },
  OM: { locale: 'ar', currency: 'OMR' },
};

export function resolveLocale(candidate: string | undefined): Locale {
  if (candidate && isSupportedLocale(candidate)) return candidate;
  const short = candidate?.toLowerCase().split('-')[0];
  if (short && isSupportedLocale(short)) return short;
  return DEFAULT_LOCALE;
}
