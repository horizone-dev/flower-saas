import { Money } from '@flower/money';

/**
 * Task 3b.4 Checkpoint B — pure document-discount allocation. NO DB, NO
 * HTTP, NO Prisma, NO tax arithmetic, NO tax-status input of any kind.
 *
 * Reuses `@flower/money`'s `Money.allocate` verbatim (frozen contract,
 * docs/phase-3 3b.4) — an exact largest-remainder proportional split that
 * already guarantees: the parts sum EXACTLY to the amount distributed, a
 * zero weight always yields a zero part, and the residual only ever lands
 * on a part whose weighted share had a non-zero fractional remainder. This
 * module does not reimplement any of that — it only (a) picks the correct
 * weights, (b) canonicalizes their order by `linePosition` (the array order
 * `Money.allocate` uses for its own deterministic tie-break), and (c)
 * derives the commercial "after document discount" amount per line.
 *
 * **All commercial lines participate identically** — there is no tax-status
 * input anywhere in this module (no `rateBps`, no `priceTaxMode`, no
 * category). A line's tax shape never affects its document-discount
 * eligibility; only its `commercialAmountAfterLineDiscountMinor` does (a
 * zero-commercial line receives a zero share, naturally, via
 * `Money.allocate`'s own zero-weight guarantee — never a special case here).
 */

export interface DocumentDiscountLineInput {
  /** 1-based, unique — the same `order_line.linePosition` already frozen by
   *  Task 3b.3. The sole tie-break/ordering authority; the input array's own
   *  order is never semantic (proof: test R). */
  readonly linePosition: number;
  /** post line-discount, pre document-discount commercial amount — the
   *  `Money.allocate` weight. Never a taxable base, never tax-conditional. */
  readonly commercialAmountAfterLineDiscountMinor: bigint;
}

export interface DocumentDiscountLineResult {
  readonly linePosition: number;
  readonly documentDiscountShareMinor: bigint;
  readonly commercialAmountAfterDocumentDiscountMinor: bigint;
}

export interface DocumentDiscountAllocationResult {
  /** sorted by `linePosition` ascending — deterministic regardless of the
   *  input array's order. */
  readonly lines: readonly DocumentDiscountLineResult[];
}

/**
 * Allocate `documentDiscountAmountMinor` across `lines` proportionally to
 * each line's `commercialAmountAfterLineDiscountMinor`, via
 * `Money.allocate`. `currencyCode` is required only to construct the
 * `Money` instance `Money.allocate` is a method of — it plays no role in
 * the arithmetic itself (which is pure BigInt).
 *
 * Frozen invariants (proved for `0 <= D <= W`, §B4/B8):
 *   - `Σ documentDiscountShareMinor === documentDiscountAmountMinor`
 *   - `0 <= documentDiscountShareMinor[i] <= commercialAmountAfterLineDiscountMinor[i]` for every line
 *   - `commercialAmountAfterDocumentDiscountMinor[i] >= 0` for every line
 *   - `Σ commercialAmountAfterDocumentDiscountMinor === W - D`
 */
export function allocateDocumentDiscount(
  lines: readonly DocumentDiscountLineInput[],
  documentDiscountAmountMinor: bigint,
  currencyCode: string,
): DocumentDiscountAllocationResult {
  const seen = new Set<number>();
  for (const l of lines) {
    if (!Number.isInteger(l.linePosition) || l.linePosition <= 0) {
      throw new RangeError(
        `allocateDocumentDiscount: linePosition must be a positive integer (got ${l.linePosition})`,
      );
    }
    if (seen.has(l.linePosition)) {
      throw new RangeError(`allocateDocumentDiscount: duplicate linePosition ${l.linePosition}`);
    }
    seen.add(l.linePosition);
    if (l.commercialAmountAfterLineDiscountMinor < 0n) {
      throw new RangeError(
        `allocateDocumentDiscount: line ${l.linePosition} has a negative commercial amount`,
      );
    }
  }
  if (documentDiscountAmountMinor < 0n) {
    throw new RangeError('allocateDocumentDiscount: documentDiscountAmountMinor must be >= 0');
  }

  const sorted = [...lines].sort((a, b) => a.linePosition - b.linePosition);
  const totalWeight = sorted.reduce((acc, l) => acc + l.commercialAmountAfterLineDiscountMinor, 0n);

  if (documentDiscountAmountMinor > totalWeight) {
    throw new RangeError(
      `allocateDocumentDiscount: documentDiscountAmountMinor (${documentDiscountAmountMinor}) exceeds the total eligible commercial amount (${totalWeight})`,
    );
  }

  if (documentDiscountAmountMinor === 0n) {
    // nothing to distribute — skip Money.allocate entirely (also sidesteps
    // its own "weight total must be > 0" guard when every line is zero).
    return {
      lines: sorted.map((l) => ({
        linePosition: l.linePosition,
        documentDiscountShareMinor: 0n,
        commercialAmountAfterDocumentDiscountMinor: l.commercialAmountAfterLineDiscountMinor,
      })),
    };
  }

  // documentDiscountAmountMinor > 0 here, and we already know it is <= totalWeight,
  // so totalWeight > 0 necessarily — Money.allocate's "weight total must be > 0" can never fire.
  const shares = Money.ofMinor(documentDiscountAmountMinor, currencyCode)
    .allocate(sorted.map((l) => l.commercialAmountAfterLineDiscountMinor))
    .map((m) => m.amountMinor);

  return {
    lines: sorted.map((l, i) => ({
      linePosition: l.linePosition,
      documentDiscountShareMinor: shares[i]!,
      commercialAmountAfterDocumentDiscountMinor:
        l.commercialAmountAfterLineDiscountMinor - shares[i]!,
    })),
  };
}
