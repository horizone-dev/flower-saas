/**
 * DISPLAY-ONLY money helpers for the till. The server owns every price, tax and total (CLAUDE.md rule 1); money travels as integer minor
 * units in a decimal STRING. This module only (a) formats such a string for a human and (b) turns what a cashier TYPED (e.g. cash handed
 * over) back into integer minor units. No floating point is used anywhere (rule 15); amounts are `bigint`.
 */

const DIGITS = /^-?\d+$/;

/** minor units + exponent → "1,234.50" (exponent 0 → "1,234"). Throws on a malformed amount: a till must never show a guessed figure. */
export function formatMinor(minor: string | bigint, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) throw new RangeError('exponent');
  const text = typeof minor === 'bigint' ? minor.toString() : minor;
  if (!DIGITS.test(text)) throw new RangeError(`not an integer minor-unit amount: ${text}`);
  const negative = text.startsWith('-');
  const digits = (negative ? text.slice(1) : text).padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const frac = exponent === 0 ? '' : digits.slice(digits.length - exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** "AED 1,234.50" */
export function formatMoney(minor: string | bigint, exponent: number, currency: string): string {
  return `${currency} ${formatMinor(minor, exponent)}`;
}

/**
 * What the cashier typed ("12", "12.5", "12.50", "٣" is NOT accepted) → integer minor units, or `null` when it is not a valid non-negative
 * amount with at most `exponent` decimals. Never rounds: "12.505" with exponent 2 is refused, not silently shortened.
 */
export function parseAmountInput(text: string, exponent: number): bigint | null {
  const t = text.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > exponent) return null;
  const minor = BigInt(whole + frac.padEnd(exponent, '0'));
  return minor;
}

/** a decimal quantity string ("2", "1.5") — positive, at most 4 decimals — as the API demands */
export function isValidQuantity(q: string): boolean {
  return /^\d+(\.\d{1,4})?$/.test(q) && /[1-9]/.test(q);
}
