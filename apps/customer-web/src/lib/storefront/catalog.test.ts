import { describe, expect, it } from 'vitest';
import {
  defaultVariant,
  displayName,
  filterProducts,
  findVariant,
  fromPrice,
  variantLabel,
} from './catalog';
import { DEMO_CATEGORIES, DEMO_PRODUCTS } from './demo-catalog';

const by = (slug: string) => DEMO_PRODUCTS.find((p) => p.slug === slug)!;

describe('demo catalog integrity — it must be a faithful shape of the existing catalog contracts', () => {
  it('has unique ids and slugs, and every product sits in a known category', () => {
    const ids = [
      ...DEMO_PRODUCTS.map((p) => p.id),
      ...DEMO_PRODUCTS.flatMap((p) => p.variants.map((v) => v.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(DEMO_PRODUCTS.map((p) => p.slug)).size).toBe(DEMO_PRODUCTS.length);
    for (const p of DEMO_PRODUCTS)
      expect(
        DEMO_CATEGORIES.some((c) => c.id === p.categoryId),
        p.slug,
      ).toBe(true);
  });
  it('every variant references real option values, has one value per group, and exactly one default exists per product', () => {
    for (const p of DEMO_PRODUCTS) {
      const valueIds = new Set(p.optionGroups.flatMap((g) => g.values.map((v) => v.id)));
      for (const v of p.variants) {
        expect(
          v.optionValueIds.every((id) => valueIds.has(id)),
          v.id,
        ).toBe(true);
        expect(v.optionValueIds.length, v.id).toBe(p.optionGroups.length);
      }
      expect(
        p.variants.filter((v) => v.isDefault),
        p.slug,
      ).toHaveLength(1);
    }
  });
  it('money is integer minor units in one currency with a valid exponent; unpriced variants are explicit nulls', () => {
    for (const p of DEMO_PRODUCTS)
      for (const v of p.variants) {
        if (v.price === null) continue;
        expect(v.price.amountMinor).toMatch(/^\d+$/);
        expect(v.price.currency).toBe('AED');
        expect(v.price.exponent).toBe(2);
      }
  });
  it('covers the cases the screens must handle: a hidden price, an unavailable variant, an unpriced variant, a single-variant product', () => {
    expect(DEMO_PRODUCTS.some((p) => p.hidePrice)).toBe(true);
    expect(DEMO_PRODUCTS.some((p) => p.variants.some((v) => !v.available))).toBe(true);
    expect(DEMO_PRODUCTS.some((p) => p.variants.some((v) => v.price === null))).toBe(true);
    expect(DEMO_PRODUCTS.some((p) => p.variants.length === 1)).toBe(true);
  });
});

describe('filterProducts', () => {
  it('filters by category slug, and returns everything with no filter', () => {
    expect(filterProducts(DEMO_PRODUCTS, DEMO_CATEGORIES, {})).toHaveLength(DEMO_PRODUCTS.length);
    const bouquets = filterProducts(DEMO_PRODUCTS, DEMO_CATEGORIES, { category: 'bouquets' });
    const bouquetId = DEMO_CATEGORIES.find((c) => c.slug === 'bouquets')!.id;
    expect(bouquets.length).toBeGreaterThan(0);
    expect(bouquets.every((p) => p.categoryId === bouquetId)).toBe(true);
    expect(filterProducts(DEMO_PRODUCTS, DEMO_CATEGORIES, { category: 'no-such' })).toEqual([]);
  });
  it('searches names in both languages, case-insensitively and trimmed; a blank query filters nothing', () => {
    const en = filterProducts(DEMO_PRODUCTS, DEMO_CATEGORIES, { q: '  ROSE ' });
    expect(en.length).toBeGreaterThan(0);
    expect(en.every((p) => p.nameEn.toLowerCase().includes('rose'))).toBe(true);
    const ar = by('red-roses').nameAr!;
    expect(
      filterProducts(DEMO_PRODUCTS, DEMO_CATEGORIES, { q: ar.slice(0, 3) }).map((p) => p.slug),
    ).toContain('red-roses');
    expect(filterProducts(DEMO_PRODUCTS, DEMO_CATEGORIES, { q: '   ' })).toHaveLength(
      DEMO_PRODUCTS.length,
    );
    expect(filterProducts(DEMO_PRODUCTS, DEMO_CATEGORIES, { q: 'zzzz-nothing' })).toEqual([]);
  });
});

describe('variants', () => {
  it('findVariant matches exactly the chosen value of every group, and nothing for a partial or impossible choice', () => {
    const p = by('red-roses');
    const v = p.variants[1]!;
    const choice = Object.fromEntries(
      p.optionGroups.map((g) => [
        g.id,
        g.values.find((val) => v.optionValueIds.includes(val.id))!.id,
      ]),
    );
    expect(findVariant(p, choice)?.id).toBe(v.id);
    expect(findVariant(p, {})).toBeNull();
    expect(findVariant(p, { [p.optionGroups[0]!.id]: 'nope' })).toBeNull();
  });
  it('defaultVariant is the flagged one; fromPrice is the cheapest AVAILABLE priced variant, or null when none is shown', () => {
    const p = by('red-roses');
    expect(defaultVariant(p).isDefault).toBe(true);
    const f = fromPrice(p)!;
    const cheapest = p.variants
      .filter((v) => v.available && v.price)
      .map((v) => BigInt(v.price!.amountMinor))
      .sort((a, b) => (a < b ? -1 : 1))[0]!;
    expect(BigInt(f.amountMinor)).toBe(cheapest);
    const hidden = DEMO_PRODUCTS.find((x) => x.hidePrice)!;
    expect(fromPrice(hidden)).toBeNull();
  });
  it('picks the Arabic name when asked and falls back to English when none exists', () => {
    expect(displayName({ nameEn: 'Rose', nameAr: 'وردة' }, 'ar')).toBe('وردة');
    expect(displayName({ nameEn: 'Rose', nameAr: null }, 'ar')).toBe('Rose');
    expect(displayName({ nameEn: 'Rose', nameAr: 'وردة' }, 'en')).toBe('Rose');
    expect(variantLabel({ nameEn: 'Medium', nameAr: null }, 'ar')).toBe('Medium');
  });
});
