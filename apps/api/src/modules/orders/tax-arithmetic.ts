import { divRound, type RoundingMode } from '@flower/money';

/**
 * Task 3b.4 Checkpoint A — pure sale-tax arithmetic primitives. NO DB, NO
 * HTTP, NO Prisma, NO `CountryTaxConfig`, NO fingerprint, NO Invoice totals.
 * Every function here is a value-in/value-out pure function over BigInt —
 * reused directly by later checkpoints, never duplicated.
 *
 * Frozen contract this module implements (docs/phase-3 3b.4 pre-flight,
 * approved): `TAX_EXCLUSIVE`/`TAX_INCLUSIVE` price-tax modes, `LINE`/
 * `DOCUMENT` rounding scopes, the existing `@flower/money` `RoundingMode`
 * vocabulary (`HALF_UP`/`HALF_EVEN`/`DOWN`/`UP`/`HALF_DOWN`) reused verbatim
 * via `divRound` — never a second rounding implementation.
 *
 * **Caller boundary (§A5 of the frozen contract)**: a line with NO resolved
 * rate (`rateBps === null` — `TaxResolutionReason` `NO_CATEGORY_ASSIGNED` /
 * `REGIME_NONE` / `NO_RATE_FOR_CATEGORY`) is never passed into
 * {@link exactLineTax} / {@link computeLineTaxAmountMinor} at all — the
 * caller sets `lineTaxAmountMinor = 0n` directly and simply omits that line
 * from a {@link reconcileDocumentTax} call. A **resolved** zero rate
 * (`rateBps === 0`) IS passed in normally and produces the identical `0n`
 * result through the real arithmetic path (numerator `0`) — the two states
 * are indistinguishable by their arithmetic RESULT, and this module makes no
 * attempt to distinguish them; that distinction lives entirely in the
 * already-frozen `order_line.resolutionSource`/`rateBps` tax-reference
 * snapshot, outside this module's concern.
 */

export type PriceTaxMode = 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';

/**
 * An exact, unrounded, immutable rational amount — never reduced to a float
 * at any point. `numerator` is minor-unit-scaled (i.e. `numerator/denominator`
 * is itself a minor-unit amount), `denominator > 0` always.
 */
export interface ExactTaxRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function assertValidRational(r: ExactTaxRational, label: string): void {
  if (r.denominator <= 0n) {
    throw new RangeError(`${label}: denominator must be > 0 (got ${r.denominator})`);
  }
  if (r.numerator < 0n) {
    throw new RangeError(`${label}: numerator must be >= 0 (got ${r.numerator})`);
  }
}

function assertValidRateBps(rateBps: number, label: string): void {
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new RangeError(`${label}: rateBps must be a non-negative integer (got ${rateBps})`);
  }
}

/**
 * The exact (unrounded) tax rational for one already-computed commercial
 * amount (post line-discount AND post document-discount allocation — see
 * Checkpoint B/D) and a **resolved, non-null** rate, under the given
 * price-tax mode.
 *
 * `TAX_EXCLUSIVE`: `exactTax = A × R / 10000` — the amount excludes tax.
 * `TAX_INCLUSIVE`: `exactTax = A × R / (10000 + R)` — the amount already
 * contains tax; this is the rational the tax component is EXTRACTED from,
 * never added.
 */
export function exactLineTax(
  commercialAmountAfterDocumentDiscount: bigint,
  rateBps: number,
  mode: PriceTaxMode,
): ExactTaxRational {
  if (commercialAmountAfterDocumentDiscount < 0n) {
    throw new RangeError('exactLineTax: commercialAmountAfterDocumentDiscount must be >= 0');
  }
  assertValidRateBps(rateBps, 'exactLineTax');
  const rate = BigInt(rateBps);
  const numerator = commercialAmountAfterDocumentDiscount * rate;
  const denominator = mode === 'TAX_EXCLUSIVE' ? 10_000n : 10_000n + rate;
  return { numerator, denominator };
}

/** Round an exact rational to an integer minor-unit amount — a thin, explicit
 *  wrapper over `@flower/money`'s own `divRound`, never a reimplementation. */
export function roundExact(r: ExactTaxRational, roundingMode: RoundingMode): bigint {
  assertValidRational(r, 'roundExact');
  return divRound(r.numerator, r.denominator, roundingMode);
}

/**
 * `LINE` scope, one line, start to finish: exact rational → rounded
 * `lineTaxAmountMinor`. The single call site a `LINE`-scope caller needs.
 */
export function computeLineTaxAmountMinor(
  commercialAmountAfterDocumentDiscount: bigint,
  rateBps: number,
  priceTaxMode: PriceTaxMode,
  roundingMode: RoundingMode,
): bigint {
  return roundExact(
    exactLineTax(commercialAmountAfterDocumentDiscount, rateBps, priceTaxMode),
    roundingMode,
  );
}

/**
 * `TAX_INCLUSIVE` only: the net (tax-excluded) amount, derived as the exact
 * remainder of the ALREADY-ROUNDED authoritative tax — never independently
 * rounded (that would risk `net + tax !== commercialAmount`). Pure
 * derived/reporting value; nothing persists it.
 */
export function inclusiveNetAmountMinor(
  commercialAmountAfterDocumentDiscount: bigint,
  lineTaxAmountMinor: bigint,
): bigint {
  return commercialAmountAfterDocumentDiscount - lineTaxAmountMinor;
}

// ── DOCUMENT rounding reconciliation ────────────────────────────────────────

export interface DocumentTaxLineInput {
  /** 1-based, unique within the call — the SAME `order_line.linePosition`
   *  already frozen by Task 3b.3 (§1). The sole tie-break authority; array
   *  order of the `lines` input is never semantic (proof: test O). */
  readonly linePosition: number;
  readonly rational: ExactTaxRational;
}

export interface DocumentTaxLineResult {
  readonly linePosition: number;
  readonly lineTaxAmountMinor: bigint;
}

export interface DocumentTaxResult {
  /** sorted by `linePosition` ascending — deterministic regardless of the
   *  input array's order. */
  readonly lines: readonly DocumentTaxLineResult[];
  readonly taxTotalAmountMinor: bigint;
}

/**
 * `DOCUMENT` rounding scope (frozen algorithm, docs/phase-3 3b.4 contract):
 * sum every line's exact tax rational EXACTLY (BigInt cross-multiplication,
 * never a float, never assuming a shared denominator — `TAX_INCLUSIVE` lines
 * at different rates have genuinely different denominators), round the
 * document-level exact sum exactly ONCE, then distribute the rounding
 * residual to the lines with the largest exact fractional remainder
 * (compared via BigInt cross-multiplication, never float division),
 * tie-broken by `linePosition` ascending. `Money.allocate` is deliberately
 * NOT used here — its integer-weight proportional model does not represent
 * a set of already-near-exact rationals with heterogeneous denominators.
 *
 * Only lines with a resolved, non-null rate are passed in (§ caller
 * boundary, module doc comment) — a no-rate line is simply absent from
 * `lines` and never appears in the result; the caller sets its
 * `lineTaxAmountMinor = 0n` directly.
 *
 * Invariant, proved and enforced: `0 <= residual <= lines.length` for EVERY
 * one of the 5 `RoundingMode`s, because each mode rounds a non-negative
 * exact value to `⌊x⌋` or `⌊x⌋+1`, and `⌊Σxᵢ⌋ >= Σ⌊xᵢ⌋` always — the
 * residual therefore never needs a line to give a unit back, only ever to
 * receive one.
 */
export function reconcileDocumentTax(
  lines: readonly DocumentTaxLineInput[],
  roundingMode: RoundingMode,
): DocumentTaxResult {
  const seen = new Set<number>();
  for (const l of lines) {
    if (!Number.isInteger(l.linePosition) || l.linePosition <= 0) {
      throw new RangeError(
        `reconcileDocumentTax: linePosition must be a positive integer (got ${l.linePosition})`,
      );
    }
    if (seen.has(l.linePosition)) {
      throw new RangeError(`reconcileDocumentTax: duplicate linePosition ${l.linePosition}`);
    }
    seen.add(l.linePosition);
    assertValidRational(l.rational, `reconcileDocumentTax line ${l.linePosition}`);
  }
  if (lines.length === 0) {
    return { lines: [], taxTotalAmountMinor: 0n };
  }

  // exact document sum as ONE rational, via repeated exact BigInt addition —
  // a/b + c/d = (a*d + c*b) / (b*d). Bounded (<=200 order lines per the
  // frozen create-order DTO limit), so no GCD reduction is needed for
  // correctness (BigInt has no overflow).
  let combinedNum = 0n;
  let combinedDen = 1n;
  for (const l of lines) {
    combinedNum = combinedNum * l.rational.denominator + l.rational.numerator * combinedDen;
    combinedDen = combinedDen * l.rational.denominator;
  }
  const roundedDocumentTax = divRound(combinedNum, combinedDen, roundingMode);

  const base = lines.map((l) => l.rational.numerator / l.rational.denominator); // exact BigInt floor (both operands >= 0)
  const baseSum = base.reduce((a, b) => a + b, 0n);
  const residual = roundedDocumentTax - baseSum;
  if (residual < 0n) {
    throw new RangeError('reconcileDocumentTax: invariant violated — residual is negative');
  }
  if (residual > BigInt(lines.length)) {
    throw new RangeError(
      'reconcileDocumentTax: invariant violated — residual exceeds eligible line count',
    );
  }

  // rank by exact fractional remainder descending, tie-break linePosition ASC
  const ranked = lines
    .map((l, idx) => ({
      idx,
      linePosition: l.linePosition,
      remainder: l.rational.numerator % l.rational.denominator,
      denominator: l.rational.denominator,
    }))
    .sort((a, b) => {
      // compare a.remainder/a.denominator vs b.remainder/b.denominator via
      // cross-multiplication — never a float division.
      const cross = a.remainder * b.denominator - b.remainder * a.denominator;
      if (cross !== 0n) return cross > 0n ? -1 : 1; // larger remainder first
      return a.linePosition - b.linePosition; // stable tie-break
    });

  const amounts = [...base];
  for (let k = 0; k < residual; k++) {
    const target = ranked[k]!.idx;
    amounts[target] = amounts[target]! + 1n;
  }

  const byPosition = lines
    .map((l, i) => ({ linePosition: l.linePosition, lineTaxAmountMinor: amounts[i]! }))
    .sort((a, b) => a.linePosition - b.linePosition);

  const taxTotalAmountMinor = amounts.reduce((a, b) => a + b, 0n);
  if (taxTotalAmountMinor !== roundedDocumentTax) {
    // unreachable if the above logic is correct — a hard invariant check,
    // never expected to fire in practice.
    throw new RangeError(
      'reconcileDocumentTax: invariant violated — sum of line amounts does not equal the rounded document total',
    );
  }

  return { lines: byPosition, taxTotalAmountMinor };
}
