/**
 * Rounding modes for dividing bigints (a local copy of `@flower/money`'s — both
 * are leaf packages with no runtime dependencies and the same 20-line pure
 * function; a shared package for one function is not worth the coupling).
 * `HALF_UP` is the generic default.
 */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP' | 'HALF_DOWN';

/**
 * A division that could not be performed **exactly** — the numerator is not an
 * integer multiple of the denominator, so any result would silently lose
 * precision. Raised by `divRoundExact` / `Quantity.scaleByExact` /
 * `UomRegistry.convertExact`. Task 3.6 uses the exact path for a printed
 * pack-identity snapshot (`item_identifier.packBaseQty`): if the base quantity
 * is not exactly representable at scale 4, the identifier is rejected rather
 * than rounded.
 */
export class InexactError extends RangeError {
  constructor(numerator: bigint, denominator: bigint) {
    super(`${numerator} / ${denominator} is not exact — result would lose precision`);
    this.name = 'InexactError';
  }
}

/**
 * Divide `numerator / denominator` (denominator > 0) and return the exact
 * integer quotient, or throw `InexactError` if there is any remainder. No
 * rounding, no rounding mode — exact or reject.
 */
export function divRoundExact(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be > 0');
  if (numerator % denominator !== 0n) throw new InexactError(numerator, denominator);
  return numerator / denominator;
}

/**
 * Divide `numerator / denominator` (denominator > 0) and round the quotient to
 * an integer using `mode`. Sign-aware (half-up rounds away from zero).
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
