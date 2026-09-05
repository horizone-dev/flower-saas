import { describe, it, expect } from 'vitest';
import { getCurrency, isKnownCurrency } from '@flower/money';
import {
  GCC_COUNTRIES,
  GCC_CURRENCIES,
  GCC_TAX_CONFIGS,
  GCC_TAX_RATES,
  TAX_CATEGORIES,
} from './gcc-reference-data.js';

describe('GCC reference seed data', () => {
  it('every seeded currency exponent agrees with @flower/money (no drift)', () => {
    for (const c of GCC_CURRENCIES) {
      expect(isKnownCurrency(c.code)).toBe(true);
      expect(getCurrency(c.code).exponent).toBe(c.exponent);
    }
  });

  it('the 3-decimal GCC currencies (KWD/BHD/OMR) are exactly the ones with exponent 3', () => {
    const threeDecimal = GCC_CURRENCIES.filter((c) => c.exponent === 3)
      .map((c) => c.code)
      .sort();
    expect(threeDecimal).toEqual(['BHD', 'KWD', 'OMR']);
  });

  it('every country references a currency that is actually seeded', () => {
    const codes = new Set(GCC_CURRENCIES.map((c) => c.code));
    for (const country of GCC_COUNTRIES) {
      expect(codes.has(country.defaultCurrencyCode)).toBe(true);
    }
  });

  it('Qatar and Kuwait are regime NONE with zero seeded tax rates (never a synthetic 0% rate)', () => {
    for (const code of ['QA', 'KW']) {
      const cfg = GCC_TAX_CONFIGS.find((c) => c.countryCode === code);
      expect(cfg?.regime).toBe('NONE');
      expect(GCC_TAX_RATES.some((r) => r.countryCode === code)).toBe(false);
    }
  });

  it('every VAT-regime country has at least a STANDARD rate row, correctly effective-dated', () => {
    for (const cfg of GCC_TAX_CONFIGS.filter((c) => c.regime === 'VAT')) {
      const standardRows = GCC_TAX_RATES.filter(
        (r) => r.countryCode === cfg.countryCode && r.taxCategoryKey === 'STANDARD',
      );
      expect(standardRows.length).toBeGreaterThan(0);
      // at most one open-ended (effectiveTo: null) STANDARD row per country —
      // otherwise two "currently in force" rates would be ambiguous.
      expect(standardRows.filter((r) => r.effectiveTo === null)).toHaveLength(1);
    }
  });

  it("Saudi Arabia's rate change is modelled as two adjoining STANDARD windows, not a mutation", () => {
    const sa = GCC_TAX_RATES.filter(
      (r) => r.countryCode === 'SA' && r.taxCategoryKey === 'STANDARD',
    );
    expect(sa).toHaveLength(2);
    const [first, second] = sa.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    expect(first).toMatchObject({
      rateBps: 500,
      effectiveFrom: '2018-01-01',
      effectiveTo: '2020-06-30',
    });
    expect(second).toMatchObject({ rateBps: 1500, effectiveFrom: '2020-07-01', effectiveTo: null });
  });

  it("Bahrain's rate change is modelled the same way", () => {
    const bh = GCC_TAX_RATES.filter(
      (r) => r.countryCode === 'BH' && r.taxCategoryKey === 'STANDARD',
    );
    expect(bh).toHaveLength(2);
    const [first, second] = bh.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    expect(first).toMatchObject({
      rateBps: 500,
      effectiveFrom: '2019-01-01',
      effectiveTo: '2021-12-31',
    });
    expect(second).toMatchObject({ rateBps: 1000, effectiveFrom: '2022-01-01', effectiveTo: null });
  });

  it('every tax rate references a category that is actually seeded', () => {
    const keys = new Set(TAX_CATEGORIES.map((c) => c.key));
    for (const rate of GCC_TAX_RATES) {
      expect(keys.has(rate.taxCategoryKey)).toBe(true);
    }
  });

  it('all six GCC countries are seeded', () => {
    expect(GCC_COUNTRIES.map((c) => c.code).sort()).toEqual(['AE', 'BH', 'KW', 'OM', 'QA', 'SA']);
  });
});
