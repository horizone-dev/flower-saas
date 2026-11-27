import type { Locale } from '@flower/i18n';
import type { StoreCategory, StoreMoney, StoreProduct, StoreVariant } from './types';

/**
 * Display helpers over catalog data. They choose, filter and label what the catalog already says; they never decide a price, a tax or an
 * availability (the server's figures are shown as given).
 */

export function displayName(n: { nameEn: string; nameAr: string | null }, locale: Locale): string {
  return locale === 'ar' && n.nameAr ? n.nameAr : n.nameEn;
}
export const variantLabel = displayName;

export function filterProducts(
  products: readonly StoreProduct[],
  categories: readonly StoreCategory[],
  q: { category?: string | undefined; q?: string | undefined },
): StoreProduct[] {
  let out = [...products];
  if (q.category) {
    const cat = categories.find((c) => c.slug === q.category);
    out = cat ? out.filter((p) => p.categoryId === cat.id) : [];
  }
  const needle = q.q?.trim().toLowerCase();
  if (needle) {
    out = out.filter(
      (p) =>
        p.nameEn.toLowerCase().includes(needle) || (p.nameAr ?? '').toLowerCase().includes(needle),
    );
  }
  return out;
}

export function defaultVariant(p: StoreProduct): StoreVariant {
  return p.variants.find((v) => v.isDefault) ?? p.variants[0]!;
}

/** the variant whose option values are EXACTLY the chosen one per group; null for a partial or impossible choice */
export function findVariant(
  p: StoreProduct,
  choice: Readonly<Record<string, string>>,
): StoreVariant | null {
  if (p.optionGroups.length === 0) return p.variants.length === 1 ? p.variants[0]! : null;
  const picked = p.optionGroups.map((g) => choice[g.id]);
  if (picked.some((id) => id === undefined)) return null;
  return (
    p.variants.find(
      (v) =>
        v.optionValueIds.length === picked.length &&
        picked.every((id) => v.optionValueIds.includes(id!)),
    ) ?? null
  );
}

/** the cheapest price among the variants a shopper could actually buy; null when the price is hidden or no variant is priced and available */
export function fromPrice(p: StoreProduct): StoreMoney | null {
  if (p.hidePrice) return null;
  const prices = p.variants.filter((v) => v.available && v.price !== null).map((v) => v.price!);
  if (prices.length === 0) return null;
  return prices.reduce((lo, m) => (BigInt(m.amountMinor) < BigInt(lo.amountMinor) ? m : lo));
}
