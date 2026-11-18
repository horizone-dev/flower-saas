/**
 * The shopper's cart — a plain list of lines, held in the browser only. Adding to a cart never reserves or consumes stock (CLAUDE.md rule 24): this
 * is a wish list the shop has not seen. Nothing here decides a price, a tax or an availability: a line carries the unit price the catalog showed
 * when it was added (or `null` when the shop hides the price), and `estimateSubtotal` is an INDICATIVE figure for display, computed with exact
 * integers. Whatever is read back from browser storage is untrusted and is validated line by line.
 */

export const MAX_LINE_QUANTITY = 20;

export interface CartLine {
  variantId: string;
  productId: string;
  productSlug: string;
  productNameEn: string;
  productNameAr: string | null;
  variantNameEn: string;
  variantNameAr: string | null;
  /** integer minor units as a digit string, or null when the product hides its price */
  unitPriceMinor: string | null;
  currency: string;
  exponent: number;
  quantity: number;
}

export type Cart = readonly CartLine[];

const isQuantity = (n: number): boolean => Number.isInteger(n) && n > 0;
const clamp = (n: number): number => Math.min(n, MAX_LINE_QUANTITY);

/** add `quantity` of a variant; the same variant merges into its existing line. An invalid quantity leaves the cart unchanged. */
export function addLine(cart: Cart, line: Omit<CartLine, 'quantity'>, quantity: number): Cart {
  if (!isQuantity(quantity)) return cart;
  const existing = cart.find((l) => l.variantId === line.variantId);
  if (existing) {
    return cart.map((l) =>
      l.variantId === line.variantId ? { ...l, quantity: clamp(l.quantity + quantity) } : l,
    );
  }
  return [...cart, { ...line, quantity: clamp(quantity) }];
}

/** set a line's quantity; zero or less removes it; an unknown variant changes nothing */
export function setQuantity(cart: Cart, variantId: string, quantity: number): Cart {
  if (!cart.some((l) => l.variantId === variantId)) return cart;
  if (!Number.isInteger(quantity)) return cart;
  if (quantity <= 0) return removeLine(cart, variantId);
  return cart.map((l) => (l.variantId === variantId ? { ...l, quantity: clamp(quantity) } : l));
}

export function removeLine(cart: Cart, variantId: string): Cart {
  return cart.filter((l) => l.variantId !== variantId);
}

export function clearCart(): Cart {
  return [];
}

export function cartCount(cart: Cart): number {
  return cart.reduce((n, l) => n + l.quantity, 0);
}

export interface SubtotalEstimate {
  amountMinor: string;
  currency: string;
  exponent: number;
  /** lines whose price the shop hides — left out of the sum */
  hiddenPriceLines: number;
}

/**
 * An indicative subtotal of the priced lines (before VAT, discounts, delivery). `null` when there is nothing to add up or the lines are not all in one
 * currency — never an invented total. The shop confirms the real price.
 */
export function estimateSubtotal(cart: Cart): SubtotalEstimate | null {
  const priced = cart.filter((l) => l.unitPriceMinor !== null);
  if (priced.length === 0) return null;
  const first = priced[0]!;
  if (priced.some((l) => l.currency !== first.currency || l.exponent !== first.exponent))
    return null;
  const total = priced.reduce((sum, l) => sum + BigInt(l.unitPriceMinor!) * BigInt(l.quantity), 0n);
  return {
    amountMinor: total.toString(),
    currency: first.currency,
    exponent: first.exponent,
    hiddenPriceLines: cart.length - priced.length,
  };
}

// ── browser storage (untrusted) ─────────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

function parseLine(raw: unknown): CartLine | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!str(r['variantId']) || !str(r['productId']) || !str(r['productSlug'])) return null;
  if (!str(r['productNameEn']) || !str(r['variantNameEn']) || !str(r['currency'], 8)) return null;
  const ar = (v: unknown): string | null | undefined =>
    v === null || v === undefined ? null : str(v) ? v : undefined;
  const productNameAr = ar(r['productNameAr']);
  const variantNameAr = ar(r['variantNameAr']);
  if (productNameAr === undefined || variantNameAr === undefined) return null;
  const price = r['unitPriceMinor'];
  if (price !== null && !(typeof price === 'string' && /^\d{1,18}$/.test(price))) return null;
  const exponent = r['exponent'];
  if (typeof exponent !== 'number' || !Number.isInteger(exponent) || exponent < 0 || exponent > 4)
    return null;
  const quantity = r['quantity'];
  if (typeof quantity !== 'number' || !isQuantity(quantity)) return null;
  return {
    variantId: r['variantId'],
    productId: r['productId'],
    productSlug: r['productSlug'],
    productNameEn: r['productNameEn'],
    productNameAr,
    variantNameEn: r['variantNameEn'],
    variantNameAr,
    unitPriceMinor: price,
    currency: r['currency'],
    exponent,
    quantity: clamp(quantity),
  };
}

/** a cart read back from storage: malformed lines are dropped, a repeated variant keeps its first line, quantities are clamped */
export function parseCart(raw: unknown): Cart {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CartLine[] = [];
  for (const item of raw.slice(0, 100)) {
    const line = parseLine(item);
    if (!line || seen.has(line.variantId)) continue;
    seen.add(line.variantId);
    out.push(line);
  }
  return out;
}

export function serializeCart(cart: Cart): string {
  return JSON.stringify(cart);
}
