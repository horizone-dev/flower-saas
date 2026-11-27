import { describe, expect, it } from 'vitest';
import { LOCALE_COOKIE, MESSAGES, direction, localeOf, t } from './i18n';

describe('storefront messages', () => {
  it('Arabic has exactly the keys English has — no screen can show a missing string', () => {
    expect(Object.keys(MESSAGES.ar).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });
  it('no message is empty', () => {
    for (const loc of ['en', 'ar'] as const)
      for (const [k, v] of Object.entries(MESSAGES[loc]))
        expect(v.trim().length, `${loc}.${k}`).toBeGreaterThan(0);
  });
  it('t() returns the message and substitutes {placeholders}; an unknown key falls back to the key itself', () => {
    expect(t('en', 'cart.itemCount', { count: 3 })).toContain('3');
    expect(t('ar', 'cart.itemCount', { count: 3 })).toContain('3');
    expect(t('en', 'no.such.key' as never)).toBe('no.such.key');
  });
  it('every placeholder used in English is used in Arabic too', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[])
      expect(ph(MESSAGES.ar[k]), k).toEqual(ph(MESSAGES.en[k]));
  });
  it('locale comes from the cookie value, defaults to English, and Arabic is right-to-left', () => {
    expect(LOCALE_COOKIE).toBe('lang');
    expect(localeOf('ar')).toBe('ar');
    expect(localeOf('fr')).toBe('en');
    expect(localeOf(undefined)).toBe('en');
    expect(direction('ar')).toBe('rtl');
    expect(direction('en')).toBe('ltr');
  });
});
