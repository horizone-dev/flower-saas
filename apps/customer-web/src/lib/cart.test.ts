import { describe, expect, it } from 'vitest';
import {
  MAX_LINE_QUANTITY,
  addLine,
  cartCount,
  clearCart,
  estimateSubtotal,
  parseCart,
  removeLine,
  serializeCart,
  setQuantity,
  type CartLine,
} from './cart';

const rose = (over: Partial<CartLine> = {}): Omit<CartLine, 'quantity'> => ({
  variantId: 'v-rose-m',
  productId: 'p-rose',
  productSlug: 'red-roses',
  productNameEn: 'Red roses',
  productNameAr: null,
  variantNameEn: 'Medium',
  variantNameAr: null,
  unitPriceMinor: '12000',
  currency: 'AED',
  exponent: 2,
  ...over,
});

describe('cart — pure operations on a plain list of lines', () => {
  it('adds a line, and adding the same variant again merges the quantity instead of duplicating it', () => {
    let cart = addLine([], rose(), 1);
    cart = addLine(cart, rose(), 2);
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(3);
    expect(cartCount(cart)).toBe(3);
  });

  it('never mutates the cart it was given', () => {
    const before = addLine([], rose(), 1);
    const snapshot = JSON.stringify(before);
    addLine(before, rose(), 1);
    setQuantity(before, 'v-rose-m', 5);
    removeLine(before, 'v-rose-m');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('caps a line at the maximum quantity and ignores a non-positive or fractional add', () => {
    let cart = addLine([], rose(), MAX_LINE_QUANTITY + 50);
    expect(cart[0]!.quantity).toBe(MAX_LINE_QUANTITY);
    cart = addLine(cart, rose(), 5);
    expect(cart[0]!.quantity).toBe(MAX_LINE_QUANTITY);
    expect(addLine([], rose(), 0)).toEqual([]);
    expect(addLine([], rose(), -2)).toEqual([]);
    expect(addLine([], rose(), 1.5)).toEqual([]);
  });

  it('setQuantity changes a line, removes it at zero, and leaves other lines alone', () => {
    let cart = addLine(
      addLine([], rose(), 1),
      rose({ variantId: 'v-tulip', productId: 'p-tulip' }),
      2,
    );
    cart = setQuantity(cart, 'v-rose-m', 4);
    expect(cart.find((l) => l.variantId === 'v-rose-m')!.quantity).toBe(4);
    expect(cart.find((l) => l.variantId === 'v-tulip')!.quantity).toBe(2);
    cart = setQuantity(cart, 'v-rose-m', 0);
    expect(cart.map((l) => l.variantId)).toEqual(['v-tulip']);
    expect(setQuantity(cart, 'unknown', 3)).toEqual(cart);
  });

  it('removeLine and clearCart', () => {
    const cart = addLine(addLine([], rose(), 1), rose({ variantId: 'v2' }), 1);
    expect(removeLine(cart, 'v2').map((l) => l.variantId)).toEqual(['v-rose-m']);
    expect(clearCart()).toEqual([]);
  });
});

describe('estimateSubtotal — an INDICATIVE figure for display only (the shop confirms the real price)', () => {
  it('multiplies exact integer minor units, never floats', () => {
    const cart = addLine([], rose({ unitPriceMinor: '9007199254740993' }), 3);
    expect(estimateSubtotal(cart)).toEqual({
      amountMinor: '27021597764222979',
      currency: 'AED',
      exponent: 2,
      hiddenPriceLines: 0,
    });
  });

  it('counts a hidden-price line separately and leaves it out of the sum', () => {
    let cart = addLine([], rose(), 2);
    cart = addLine(cart, rose({ variantId: 'v-gift', unitPriceMinor: null }), 1);
    expect(estimateSubtotal(cart)).toMatchObject({ amountMinor: '24000', hiddenPriceLines: 1 });
  });

  it('is null for an empty cart, for an all-hidden cart, and for mixed currencies (never a made-up total)', () => {
    expect(estimateSubtotal([])).toBeNull();
    expect(estimateSubtotal(addLine([], rose({ unitPriceMinor: null }), 1))).toBeNull();
    const mixed = addLine(
      addLine([], rose(), 1),
      rose({ variantId: 'v-kwd', currency: 'KWD', exponent: 3 }),
      1,
    );
    expect(estimateSubtotal(mixed)).toBeNull();
  });
});

describe('parseCart — whatever is in browser storage is untrusted', () => {
  it('round-trips a valid cart', () => {
    const cart = addLine(
      addLine([], rose(), 2),
      rose({ variantId: 'v2', unitPriceMinor: null }),
      1,
    );
    expect(parseCart(JSON.parse(serializeCart(cart)))).toEqual(cart);
  });

  it('drops malformed lines, de-duplicates by variant, clamps quantities, and survives non-arrays', () => {
    const good = { ...rose(), quantity: 2 };
    const parsed = parseCart([
      good,
      { ...good, quantity: 3 }, // same variant again: first wins
      { ...good, variantId: 'v-bad-qty', quantity: 0 },
      { ...good, variantId: 'v-frac', quantity: 1.5 },
      { ...good, variantId: 'v-price', unitPriceMinor: '12.50' },
      { ...good, variantId: 'v-exp', exponent: 9 },
      { ...good, variantId: 'v-huge', quantity: 9999 },
      { variantId: 'v-missing' },
      null,
      'text',
      42,
    ]);
    expect(parsed.map((l) => l.variantId)).toEqual(['v-rose-m', 'v-huge']);
    expect(parsed[0]!.quantity).toBe(2);
    expect(parsed[1]!.quantity).toBe(MAX_LINE_QUANTITY);
    expect(parseCart({ not: 'an array' })).toEqual([]);
    expect(parseCart(undefined)).toEqual([]);
    expect(parseCart('x')).toEqual([]);
  });
});
