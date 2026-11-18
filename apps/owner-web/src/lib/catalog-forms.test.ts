import { describe, expect, it } from 'vitest';
import {
  availabilityByVariant,
  exponentForCurrency,
  formatMinor,
  parseMoneyInput,
  readinessOf,
  slugify,
  vatActivationBlocker,
} from './catalog-forms';

describe('slugify — a stable, valid slug from a product name', () => {
  it('lower-cases, hyphenates and strips accents/symbols; always returns something usable', () => {
    expect(slugify('Red Rose — 60cm!')).toBe('red-rose-60cm');
    expect(slugify('  Tulip   (Dutch) ')).toBe('tulip-dutch');
    expect(slugify('وردة')).toMatch(/^item$/); // nothing latin left: a neutral base (the caller adds a unique suffix)
    expect(slugify('')).toBe('item');
  });
});

describe('parseMoneyInput — text to integer minor units (no floating point)', () => {
  it('parses exactly, honours the currency exponent, refuses anything ambiguous', () => {
    expect(parseMoneyInput('7.50', 2)).toBe('750');
    expect(parseMoneyInput('10', 2)).toBe('1000');
    expect(parseMoneyInput('0.5', 2)).toBe('50');
    expect(parseMoneyInput('1,250.25', 2)).toBe('125025');
    expect(parseMoneyInput('2.500', 3)).toBe('2500');
    expect(parseMoneyInput('0.01', 2)).toBe('1');
    expect(parseMoneyInput('0', 2)).toBe('0');
    for (const bad of ['', ' ', '-1', '1.234', '1.2.3', 'abc', '1e3', '.', '1,2', '٧.٥']) {
      expect(parseMoneyInput(bad, 2), bad).toBeNull();
    }
    expect(parseMoneyInput('2.5000', 3)).toBeNull(); // more decimals than the currency allows
  });
});

describe('currency exponent and display', () => {
  it('KWD / BHD / OMR are 3-decimal, the rest of the GCC is 2', () => {
    for (const c of ['KWD', 'BHD', 'OMR']) expect(exponentForCurrency(c)).toBe(3);
    for (const c of ['AED', 'SAR', 'QAR']) expect(exponentForCurrency(c)).toBe(2);
    expect(exponentForCurrency(null)).toBe(2);
  });
  it('formats minor units back exactly', () => {
    expect(formatMinor('750', 2)).toBe('7.50');
    expect(formatMinor('5', 2)).toBe('0.05');
    expect(formatMinor('2500', 3)).toBe('2.500');
    expect(formatMinor('123456789', 2)).toBe('1,234,567.89');
  });
});

describe('readinessOf — what a product still needs before it can be sold', () => {
  const v = (
    o: Partial<{
      status: string;
      baseUomCode: string | null;
      hasPrice: boolean;
      taxCategoryKey: string | null;
    }> = {},
  ) => ({
    id: 'v',
    status: 'DRAFT',
    baseUomCode: 'piece',
    hasPrice: true,
    taxCategoryKey: 'STANDARD' as string | null,
    ...o,
  });
  it('lists the missing steps in the order the owner must do them', () => {
    expect(
      readinessOf('DRAFT', [v({ baseUomCode: null, hasPrice: false, taxCategoryKey: null })]),
    ).toEqual([
      'Set the unit of measure',
      'Set a selling price',
      'Set the VAT category (Standard, Zero-rated or Exempt)',
      'Activate the product',
      'Activate the variant',
    ]);
    expect(readinessOf('DRAFT', [v()])).toEqual(['Activate the product', 'Activate the variant']);
    expect(readinessOf('ACTIVE', [v({ status: 'ACTIVE' })])).toEqual([]);
    expect(readinessOf('DRAFT', [])).toEqual(['Add a variant']);
  });

  it('F-6: a missing VAT category is a blocking step; zero-rated and exempt are legitimate classifications', () => {
    expect(readinessOf('ACTIVE', [v({ status: 'ACTIVE', taxCategoryKey: null })])).toEqual([
      'Set the VAT category (Standard, Zero-rated or Exempt)',
    ]);
    for (const k of ['ZERO_RATED', 'EXEMPT', 'REDUCED', 'STANDARD']) {
      expect(readinessOf('ACTIVE', [v({ status: 'ACTIVE', taxCategoryKey: k })])).toEqual([]);
    }
    // blank is missing too
    expect(readinessOf('ACTIVE', [v({ status: 'ACTIVE', taxCategoryKey: '  ' })])).toHaveLength(1);
  });
});

describe('vatActivationBlocker — a variant with no VAT category must not be activated', () => {
  it('refuses a missing category with a message the owner can act on; accepts any explicit category', () => {
    expect(vatActivationBlocker(null)).toMatch(/VAT category/);
    expect(vatActivationBlocker('')).toMatch(/VAT category/);
    expect(vatActivationBlocker('ZERO_RATED')).toBeNull();
    expect(vatActivationBlocker('EXEMPT')).toBeNull();
    expect(vatActivationBlocker('STANDARD')).toBeNull();
  });
});

describe('availabilityByVariant — the flag per variant for a branch (no row = available)', () => {
  it('defaults to available and marks explicit rows', () => {
    const m = availabilityByVariant([
      { variantId: 'a', available: false, explicit: true },
      { variantId: 'b', available: true, explicit: true },
    ]);
    expect(m.get('a')).toEqual({ available: false, explicit: true });
    expect(m.get('missing')).toBeUndefined();
  });
});
