import type { PosOrderLineInput } from '@flower/api-client';
import { isValidQuantity } from './money-display';

/**
 * The till's CART — client state only. It never prices, taxes or totals anything: a line carries the server's unit price for DISPLAY, and the
 * order the API creates from `toOrderLines` is priced, taxed and totalled by the SERVER (the client sends no price, no tax, no total).
 * Adding to the cart never reserves or consumes stock (CLAUDE.md rule 24).
 */

export interface CartLine {
  /** `${variantId}:${uomCode}` — one line per variant + unit of measure */
  key: string;
  productId: string;
  variantId: string;
  uomCode: string;
  name: string;
  variantName: string | null;
  /** the server-resolved sell price per unit, integer minor units — DISPLAY only */
  unitPriceMinor: string;
  /** decimal string, > 0, ≤ 4 dp */
  quantity: string;
}

export interface Cart {
  lines: readonly CartLine[];
}

export const EMPTY_CART: Cart = Object.freeze({ lines: Object.freeze([]) as readonly CartLine[] });

export type CartAction =
  | { type: 'add'; line: Omit<CartLine, 'key' | 'quantity'>; quantity?: string }
  | { type: 'increment'; key: string }
  | { type: 'decrement'; key: string }
  | { type: 'setQuantity'; key: string; quantity: string }
  | { type: 'remove'; key: string }
  | { type: 'clear' };

export const MAX_LINES = 200; // the API's own bound
const SCALE = 10_000n; // 4 decimals

function toScaled(q: string): bigint {
  const [w, f = ''] = q.split('.');
  return BigInt(w!) * SCALE + BigInt(f.padEnd(4, '0'));
}
function fromScaled(s: bigint): string {
  const whole = s / SCALE;
  const frac = (s % SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** quantity + delta, exactly (decimal strings, ≤ 4 dp); the result may be ≤ 0 (the caller removes the line) */
export function addQuantity(q: string, delta: string): bigint {
  return toScaled(q) + toScaled(delta);
}

export function lineKey(variantId: string, uomCode: string): string {
  return `${variantId}:${uomCode}`;
}

export function cartReducer(cart: Cart, a: CartAction): Cart {
  switch (a.type) {
    case 'add': {
      const qty = a.quantity ?? '1';
      if (!isValidQuantity(qty)) return cart;
      const key = lineKey(a.line.variantId, a.line.uomCode);
      const existing = cart.lines.find((l) => l.key === key);
      if (existing) {
        return {
          lines: cart.lines.map((l) =>
            l.key === key ? { ...l, quantity: fromScaled(addQuantity(l.quantity, qty)) } : l,
          ),
        };
      }
      if (cart.lines.length >= MAX_LINES) return cart;
      return { lines: [...cart.lines, { ...a.line, key, quantity: qty }] };
    }
    case 'increment':
      return {
        lines: cart.lines.map((l) =>
          l.key === a.key ? { ...l, quantity: fromScaled(addQuantity(l.quantity, '1')) } : l,
        ),
      };
    case 'decrement': {
      const out: CartLine[] = [];
      for (const l of cart.lines) {
        if (l.key !== a.key) {
          out.push(l);
          continue;
        }
        const next = toScaled(l.quantity) - SCALE; // quantity − 1
        if (next > 0n) out.push({ ...l, quantity: fromScaled(next) });
      }
      return { lines: out };
    }
    case 'setQuantity': {
      if (!isValidQuantity(a.quantity)) return cart;
      return {
        lines: cart.lines.map((l) => (l.key === a.key ? { ...l, quantity: a.quantity } : l)),
      };
    }
    case 'remove':
      return { lines: cart.lines.filter((l) => l.key !== a.key) };
    case 'clear':
      return EMPTY_CART;
  }
}

/** the order lines the API accepts: ids, unit of measure and quantity ONLY */
export function toOrderLines(cart: Cart): PosOrderLineInput[] {
  return cart.lines.map((l) => ({
    productId: l.productId,
    variantId: l.variantId,
    selectedUomCode: l.uomCode,
    quantity: l.quantity,
  }));
}

/** a stable fingerprint of what would be sold (used to decide whether a retry is the SAME checkout) */
export function cartFingerprint(cart: Cart, customerId: string | null): string {
  const lines = [...cart.lines]
    .map((l) => `${l.variantId}|${l.uomCode}|${l.quantity}`)
    .sort()
    .join(';');
  return `${customerId ?? '-'}#${lines}`;
}

export function isEmpty(cart: Cart): boolean {
  return cart.lines.length === 0;
}

/** number of units, for the cart badge (decimal-safe) */
export function unitCount(cart: Cart): string {
  return fromScaled(cart.lines.reduce((s, l) => s + toScaled(l.quantity), 0n));
}

/**
 * An ESTIMATE of the subtotal before VAT and discounts from the server's displayed unit prices — shown to the cashier only as an estimate;
 * the authoritative subtotal, VAT and total come from the server at checkout. Exact when every quantity is whole; otherwise `null`
 * (a fractional line cannot be shown exactly without the server's rounding rule, so no figure is shown rather than a wrong one).
 */
export function estimateSubtotalMinor(cart: Cart): bigint | null {
  let total = 0n;
  for (const l of cart.lines) {
    const q = toScaled(l.quantity);
    if (q % SCALE !== 0n) return null;
    total += BigInt(l.unitPriceMinor) * (q / SCALE);
  }
  return total;
}
