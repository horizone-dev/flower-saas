import { describe, it, expect } from 'vitest';
import { isRtlLocale, textDirection, resolveLocale, GCC_COUNTRY_DEFAULTS } from './index.js';

describe('@flower/i18n', () => {
  it('detects RTL for Arabic variants', () => {
    expect(isRtlLocale('ar')).toBe(true);
    expect(isRtlLocale('ar-AE')).toBe(true);
    expect(isRtlLocale('AR_sa')).toBe(true);
    expect(isRtlLocale('en')).toBe(false);
    expect(isRtlLocale('en-GB')).toBe(false);
  });
  it('maps to a text direction', () => {
    expect(textDirection('ar-QA')).toBe('rtl');
    expect(textDirection('en')).toBe('ltr');
  });
  it('resolves a supported locale or falls back to en', () => {
    expect(resolveLocale('ar')).toBe('ar');
    expect(resolveLocale('ar-AE')).toBe('ar');
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });
  it('every GCC country defaults to Arabic + its 2/3-decimal currency', () => {
    for (const { locale } of Object.values(GCC_COUNTRY_DEFAULTS)) {
      expect(locale).toBe('ar');
    }
    expect(GCC_COUNTRY_DEFAULTS['KW']?.currency).toBe('KWD');
  });
});
