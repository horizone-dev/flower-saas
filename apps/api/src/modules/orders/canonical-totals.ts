import { Money, type RoundingMode } from '@flower/money';
import { Quantity } from '@flower/uom';
import { allocateDocumentDiscount } from './document-discount-allocation.js';
import { exactLineTax, roundExact, reconcileDocumentTax } from './tax-arithmetic.js';

/**
 * Task 3b.9 Checkpoint A (A1) — the ONE canonical, pure computation of an
 * order's finalized line tax and document totals.
 *
 * This is a behaviour-preserving extraction of steps 3–9 of
 * `TaxFinalizationService.finalizeAndIssueInvoice` (task 3b.4 Checkpoint D),
 * moved here so that exactly the same code serves BOTH
 *
 *   - final invoice issuance (`TaxFinalizationService` calls it under the
 *     order lock, then hands the result to `InvoiceIssuanceRepository`), and
 *   - the read-only totals preview (`GET …/orders/:orderId/totals`, task 3b.9
 *     Checkpoint E), which calls it with no lock and writes nothing.
 *
 * There is NO second copy of the tax / discount / rounding formula anywhere —
 * `canonical-totals.test.ts` pins equivalence against a verbatim copy of the
 * pre-extraction algorithm, and `task-3b9-checkpoint-a-structural.test.ts`
 * pins that `TaxFinalizationService` contains no tax arithmetic of its own.
 *
 * PURE: value in / value out over BigInt. NO DB, NO Prisma, NO Nest, NO clock,
 * NO catalog / tax-configuration lookup, NO number allocation, NO audit, NO
 * outbox. Every input is a persisted, frozen order / order-line snapshot value
 * (the order's own fiscal policy and each line's own tax-reference snapshot are
 * the sole authorities) — never re-resolved from live configuration.
 *
 * A preview is NEVER authoritative: finalization recomputes under the order
 * lock from the then-current rows, and the order `version` is the optimistic
 * guard between the two.
 */

export interface CanonicalTotalsOrderInput {
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly documentDiscountAmountMinor: bigint;
  readonly taxPriceMode: string;
  readonly taxRoundingScope: string;
  readonly taxRoundingMode: string;
}

export interface CanonicalTotalsLineInput {
  readonly id: string;
  readonly linePosition: number;
  /** the exact fixed-point decimal string `Quantity` parses (4 fractional
   *  places, e.g. `"1.5000"`) — never a JS number. */
  readonly quantity: string;
  readonly unitPriceAmountMinor: bigint;
  readonly unitPriceCurrencyCode: string;
  /** the line discount as an ABSOLUTE minor-unit amount (a percentage or fixed
   *  discount is already resolved to this amount when the draft is written). */
  readonly discountAmountMinor: bigint;
  /** the frozen resolved tax rate in basis points; `null` = no resolved rate
   *  (tax is exactly 0 for that line, never inferred). */
  readonly rateBps: number | null;
}

export interface CanonicalLineTax {
  readonly orderLineId: string;
  readonly priceTaxMode: string;
  readonly roundingScope: string;
  readonly roundingMode: string;
  readonly lineTaxAmountMinor: bigint;
}

export interface CanonicalTotals {
  readonly subtotalAmountMinor: bigint;
  readonly documentDiscountAmountMinor: bigint;
  readonly taxTotalAmountMinor: bigint;
  readonly totalAmountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
}

export interface CanonicalTotalsResult {
  /** exactly one entry per input line, in ascending `linePosition` order. */
  readonly lines: CanonicalLineTax[];
  readonly totals: CanonicalTotals;
}

export function computeCanonicalTotals(
  order: CanonicalTotalsOrderInput,
  lines: readonly CanonicalTotalsLineInput[],
): CanonicalTotalsResult {
  // Determinism: the result never depends on the caller's input order. (The
  // persisted rows are read `ORDER BY linePosition ASC` by every caller — this
  // makes that an enforced property of the computation, not a convention.)
  const ordered = [...lines].sort((a, b) => a.linePosition - b.linePosition);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.linePosition === ordered[i - 1]!.linePosition) {
      throw new RangeError(
        `computeCanonicalTotals: duplicate linePosition ${ordered[i]!.linePosition}`,
      );
    }
  }

  // ── commercial reconstruction (task 3b.4 §D4) — the IDENTICAL frozen formula
  //    task 3b.3 uses at create/PATCH time: gross = unitPrice × quantity (exact
  //    BigInt via `Money.mulRatio`), net-of-line-discount = gross − the line's
  //    own discount amount. Never re-priced from live Catalog, never
  //    re-resolved UOM. ────────────────────────────────────────────────────
  const afterLineDiscount = ordered.map((l) => {
    const gross = Money.ofMinor(l.unitPriceAmountMinor, l.unitPriceCurrencyCode).mulRatio(
      Quantity.parse(l.quantity).scaled,
      10_000n,
    );
    return {
      id: l.id,
      linePosition: l.linePosition,
      rateBps: l.rateBps,
      amountMinor: gross.subtract(Money.ofMinor(l.discountAmountMinor, l.unitPriceCurrencyCode))
        .amountMinor,
    };
  });

  // ── document-discount allocation (§D5) — the frozen Checkpoint B helper, ALL
  //    lines participate identically regardless of tax status. ──────────────
  const allocation = allocateDocumentDiscount(
    afterLineDiscount.map((l) => ({
      linePosition: l.linePosition,
      commercialAmountAfterLineDiscountMinor: l.amountMinor,
    })),
    order.documentDiscountAmountMinor,
    order.currencyCode,
  );
  const afterDocumentDiscountByPosition = new Map(
    allocation.lines.map((l) => [l.linePosition, l.commercialAmountAfterDocumentDiscountMinor]),
  );

  // ── tax reference handling + LINE/DOCUMENT rounding (§D6-D9) ──────────────
  const priceTaxMode = order.taxPriceMode as 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
  const roundingMode = order.taxRoundingMode as RoundingMode;
  const ratedLines = afterLineDiscount.filter((l) => l.rateBps !== null);

  const lineTaxByPosition = new Map<number, bigint>();
  for (const l of afterLineDiscount) {
    if (l.rateBps === null) lineTaxByPosition.set(l.linePosition, 0n); // §D6 no-rate
  }

  if (order.taxRoundingScope === 'LINE') {
    for (const l of ratedLines) {
      const amount = afterDocumentDiscountByPosition.get(l.linePosition)!;
      const rational = exactLineTax(amount, l.rateBps!, priceTaxMode);
      lineTaxByPosition.set(l.linePosition, roundExact(rational, roundingMode));
    }
  } else {
    // DOCUMENT scope (§D9) — exact rationals for every rated line (including a
    // resolved zero-rate), reconciled once via the frozen Checkpoint A helper,
    // mapped back by linePosition.
    const documentInputs = ratedLines.map((l) => ({
      linePosition: l.linePosition,
      rational: exactLineTax(
        afterDocumentDiscountByPosition.get(l.linePosition)!,
        l.rateBps!,
        priceTaxMode,
      ),
    }));
    const reconciled = reconcileDocumentTax(documentInputs, roundingMode);
    for (const r of reconciled.lines) {
      lineTaxByPosition.set(r.linePosition, r.lineTaxAmountMinor);
    }
  }

  // ── finalized line-tax snapshot (§D10) — exactly one entry per input line,
  //    no duplicate/missing ids, no caller-supplied policy. ──────────────────
  const finalizedLines: CanonicalLineTax[] = afterLineDiscount.map((l) => ({
    orderLineId: l.id,
    priceTaxMode: order.taxPriceMode,
    roundingScope: order.taxRoundingScope,
    roundingMode: order.taxRoundingMode,
    lineTaxAmountMinor: lineTaxByPosition.get(l.linePosition)!,
  }));

  // ── finalized totals (§D11) — frozen semantics, mode-conditional. ─────────
  const subtotalAmountMinor = afterLineDiscount.reduce((acc, l) => acc + l.amountMinor, 0n);
  const taxTotalAmountMinor = finalizedLines.reduce((acc, l) => acc + l.lineTaxAmountMinor, 0n);
  const totalAmountMinor =
    priceTaxMode === 'TAX_EXCLUSIVE'
      ? subtotalAmountMinor - order.documentDiscountAmountMinor + taxTotalAmountMinor
      : subtotalAmountMinor - order.documentDiscountAmountMinor;

  return {
    lines: finalizedLines,
    totals: {
      subtotalAmountMinor,
      documentDiscountAmountMinor: order.documentDiscountAmountMinor,
      taxTotalAmountMinor,
      totalAmountMinor,
      currencyCode: order.currencyCode,
      currencyExponent: order.currencyExponent,
    },
  };
}

/**
 * The bounded wire shape of the read-only totals preview (task 3b.9 owner
 * ruling OD-4): the order id + version it was computed for, the currency, the
 * fiscal mode, and the exact money totals as decimal-digit STRINGS (never a JS
 * number — a BigInt cannot be JSON-serialised and a number cannot round-trip
 * one). No per-line breakdown, no fingerprint, no scope identifier.
 */
export interface OrderTotalsPreview {
  readonly orderId: string;
  readonly version: number;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly priceTaxMode: string;
  readonly subtotalAmountMinor: string;
  readonly documentDiscountAmountMinor: string;
  readonly taxTotalAmountMinor: string;
  readonly totalAmountMinor: string;
}

export function toOrderTotalsPreview(
  order: { readonly id: string; readonly version: number; readonly taxPriceMode: string },
  result: CanonicalTotalsResult,
): OrderTotalsPreview {
  const t = result.totals;
  return {
    orderId: order.id,
    version: order.version,
    currencyCode: t.currencyCode,
    currencyExponent: t.currencyExponent,
    priceTaxMode: order.taxPriceMode,
    subtotalAmountMinor: t.subtotalAmountMinor.toString(),
    documentDiscountAmountMinor: t.documentDiscountAmountMinor.toString(),
    taxTotalAmountMinor: t.taxTotalAmountMinor.toString(),
    totalAmountMinor: t.totalAmountMinor.toString(),
  };
}
