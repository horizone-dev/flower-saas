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
    default:
      // TypeScript's exhaustiveness check over the closed `RoundingMode`
      // union cannot protect a caller that casts an untyped runtime value
      // (e.g. a DB-persisted string) to this type — found during Task 3b.4's
      // adversarial review (Checkpoint F): without this guard, an
      // out-of-vocabulary `mode` left `roundUp` unassigned, which the
      // `roundUp ? ... : ...` ternary below silently coerced to `false`
      // (falsy `undefined`) — i.e. silently rounding DOWN instead of failing
      // closed. Fail loudly instead; every legitimate caller always passes
      // one of the 5 literal modes, so this can never fire for real input.
      throw new RangeError(`divRound: unrecognized rounding mode ${String(mode)}`);
  }

  const result = roundUp ? q + 1n : q;
  return negative ? -result : result;
}
