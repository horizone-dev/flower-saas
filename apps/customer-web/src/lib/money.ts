/** "12000" with exponent 2 → "120.00" (display only: exact integer arithmetic, no floating point, no rounding) */
export function formatMinor(minor: string | bigint, exponent: number): string {
  const raw = typeof minor === 'bigint' ? minor.toString() : minor;
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
