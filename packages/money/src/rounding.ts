/** Rounding modes for dividing bigints. HALF_UP is the project default (ADR-0006). */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP' | 'HALF_DOWN';

/**
 * Divide `numerator / denominator` (both bigint, denominator > 0) and round the
 * quotient to an integer using `mode`. Sign-aware (half-up rounds away from zero).
 */
export function divRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be > 0');

  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = n / denominator;
  const r = n % denominator;
  if (r === 0n) return negative ? -q : q;

  const twice = r * 2n;
  let roundUp: boolean;
  switch (mode) {
    case 'DOWN':
      roundUp = false;
      break;
    case 'UP':
      roundUp = true;
      break;
    case 'HALF_DOWN':
      roundUp = twice > denominator;
      break;
    case 'HALF_UP':
      roundUp = twice >= denominator;
      break;
    case 'HALF_EVEN':
      roundUp = twice > denominator || (twice === denominator && q % 2n === 1n);
      break;
  }

  const result = roundUp ? q + 1n : q;
  return negative ? -result : result;
}
