import type { BranchEffectiveCatalogEntry, ProductRow } from '@flower/api-client';

/**
 * The POS catalog: product NAMES (catalog read) joined with the branch's EFFECTIVE catalog (which variants are on sale in this branch, and at
 * what server-resolved price). The branch availability flag is the only "stock" signal the backend has today (there is no inventory module
 * yet): an unavailable item cannot be added to the cart; an available one is NOT guaranteed to be in stock — see the MVP readiness report.
 */

export interface TileEntry {
  variantId: string;
  uomCode: string;
  priceMinor: string;
  currency: string;
  exponent: number;
  available: boolean;
}

export interface CatalogTile {
  productId: string;
  name: string;
  nameAr: string | null;
  entries: TileEntry[];
  /** at least one variant is on sale AND priced */
  sellable: boolean;
  /** the lowest resolvable price among the sellable entries, or null */
  fromPriceMinor: string | null;
  currency: string | null;
  exponent: number | null;
  multiVariant: boolean;
}

function entryOf(e: BranchEffectiveCatalogEntry): TileEntry | null {
  // one selling line per variant: the first RESOLVABLE price row (a variant with no resolvable price cannot be sold here)
  const row = e.prices.find((p) => p.resolvable);
  if (!row) return null;
  return {
    variantId: e.variantId,
    uomCode: row.uomCode,
    priceMinor: row.sell.amountMinor,
    currency: row.sell.currency,
    exponent: row.sell.exponent,
    available: e.available,
  };
}

export function buildTiles(
  products: readonly ProductRow[],
  effective: readonly BranchEffectiveCatalogEntry[],
): CatalogTile[] {
  const byProduct = new Map<string, TileEntry[]>();
  for (const e of effective) {
    const entry = entryOf(e);
    if (!entry) continue;
    const list = byProduct.get(e.productId) ?? [];
    list.push(entry);
    byProduct.set(e.productId, list);
  }
  const tiles: CatalogTile[] = [];
  for (const p of products) {
    if (p.status !== 'ACTIVE') continue;
    const entries = byProduct.get(p.id);
    if (!entries || entries.length === 0) continue; // not offered / not priced in this branch
    const sellable = entries.filter((x) => x.available);
    let lowest: TileEntry | null = null;
    for (const s of sellable) {
      if (lowest === null || BigInt(s.priceMinor) < BigInt(lowest.priceMinor)) lowest = s;
    }
    const first = lowest ?? entries[0]!;
    tiles.push({
      productId: p.id,
      name: p.nameEn,
      nameAr: p.nameAr,
      entries,
      sellable: sellable.length > 0,
      fromPriceMinor: lowest ? lowest.priceMinor : null,
      currency: first.currency,
      exponent: first.exponent,
      multiVariant: entries.length > 1,
    });
  }
  return tiles.sort((a, b) => a.name.localeCompare(b.name));
}

/** case-insensitive match on the English and Arabic names, and on the variant names when they are known */
export function filterTiles(
  tiles: readonly CatalogTile[],
  query: string,
  variantNames: Readonly<Record<string, string>> = {},
): CatalogTile[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...tiles];
  return tiles.filter((t) => {
    if (t.name.toLocaleLowerCase().includes(q)) return true;
    if (t.nameAr && t.nameAr.toLocaleLowerCase().includes(q)) return true;
    return t.entries.some((e) => (variantNames[e.variantId] ?? '').toLocaleLowerCase().includes(q));
  });
}
