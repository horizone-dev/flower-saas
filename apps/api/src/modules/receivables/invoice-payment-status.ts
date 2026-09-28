/**
 * Task 3b.6 Checkpoint A — pure Invoice coverage/payment-status arithmetic
 * and the 3b.6-owned status transition graph. NO DB, NO HTTP.
 *
 * Error convention: plain `RangeError`, matching every other pure module in
 * this repository (`available-to-collect.ts`, `payment-attempt-state.ts`).
 *
 * Frozen formula (3b.6 architecture-freeze passes, this session):
 *   invoiceOutstanding = invoiceTotalMinor - paymentAllocatedMinor - advanceAppliedMinor
 *   coverage = invoiceTotalMinor - invoiceOutstanding
 *     coverage == 0            -> UNPAID
 *     0 < coverage < total     -> PARTIAL
 *     coverage == total        -> PAID
 * 3b.6 produces no other status — `SETTLED`/`PARTIALLY_REFUNDED`/`REFUNDED`/
 * `CANCELLED`/`VOID` remain reserved in the DB CHECK vocabulary (ADR-0019
 * §2) but have zero producer anywhere in 3b.6 domain code; those states'
 * own owning tasks (3b.7/3b.8) get to add their own reachable edges to this
 * SAME graph later — this module never assumes or blocks their eventual
 * existence, it only refuses to ever produce them itself.
 *
 * The formula applies uniformly to a customer-linked OR a walk-in Invoice
 * — `advanceAppliedMinor` is structurally always `0n` for a walk-in
 * Invoice (no `CustomerCompanyAccount`, hence no `CustomerAdvance` can ever
 * reference it), so no walk-in-specific branch exists in this module.
 */

export type InvoicePaymentStatus3b6 = 'UNPAID' | 'PARTIAL' | 'PAID';

/** Every 3b.6-owned status, for exhaustiveness checks elsewhere. */
export const INVOICE_PAYMENT_STATUSES_3B6: readonly InvoicePaymentStatus3b6[] = Object.freeze([
  'UNPAID',
  'PARTIAL',
  'PAID',
]);

export interface InvoiceCoverageInput {
  readonly invoiceTotalMinor: bigint;
  readonly paymentAllocatedMinor: bigint;
  readonly advanceAppliedMinor: bigint;
}

export interface InvoiceCoverageResult {
  readonly outstandingMinor: bigint;
  readonly coverageMinor: bigint;
  readonly status: InvoicePaymentStatus3b6;
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} must be >= 0 (got ${value})`);
  }
}

export function computeInvoiceCoverage(input: InvoiceCoverageInput): InvoiceCoverageResult {
  assertNonNegative(input.invoiceTotalMinor, 'invoiceTotalMinor');
  assertNonNegative(input.paymentAllocatedMinor, 'paymentAllocatedMinor');
  assertNonNegative(input.advanceAppliedMinor, 'advanceAppliedMinor');

  const coverageMinor = input.paymentAllocatedMinor + input.advanceAppliedMinor;
  if (coverageMinor > input.invoiceTotalMinor) {
    throw new RangeError(
      `computeInvoiceCoverage: paymentAllocatedMinor + advanceAppliedMinor (${coverageMinor}) ` +
        `exceeds invoiceTotalMinor (${input.invoiceTotalMinor}) — this represents a corrupted ` +
        'invariant that must never occur under correctly-locked, correctly-backstopped callers',
    );
  }
  const outstandingMinor = input.invoiceTotalMinor - coverageMinor;

  let status: InvoicePaymentStatus3b6;
  if (coverageMinor === 0n) {
    status = 'UNPAID';
  } else if (coverageMinor === input.invoiceTotalMinor) {
    status = 'PAID';
  } else {
    status = 'PARTIAL';
  }

  return { outstandingMinor, coverageMinor, status };
}

/**
 * The 3b.6-owned transition graph. Deliberately narrow: only the three
 * forward edges a 3b.6 code path can ever produce, plus every same-state
 * no-op (a harmless recomputation, e.g. re-deriving `PARTIAL` after a
 * second partial allocation). Every backward edge (including from `PAID`)
 * and every edge into/out of a non-3b.6 status is illegal here — later
 * tasks (3b.7 `SETTLED`, 3b.8 `PARTIALLY_REFUNDED`/`REFUNDED`/`CANCELLED`/
 * `VOID`) own their own edges into this graph; this module never
 * anticipates them.
 */
const TRANSITIONS: Readonly<Record<InvoicePaymentStatus3b6, readonly InvoicePaymentStatus3b6[]>> =
  Object.freeze({
    UNPAID: ['UNPAID', 'PARTIAL', 'PAID'],
    PARTIAL: ['PARTIAL', 'PAID'],
    PAID: ['PAID'],
  });

export function canTransitionInvoicePaymentStatus(
  from: InvoicePaymentStatus3b6,
  to: InvoicePaymentStatus3b6,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Throws a plain `RangeError` for any edge not in the frozen graph above —
 * in particular `PARTIAL -> UNPAID`, `PAID -> PARTIAL`, `PAID -> UNPAID`,
 * and any attempt to target a non-3b.6 status. The future service-layer
 * caller is expected to surface this as `INVOICE_PAYMENT_STATUS_REGRESSION`
 * (409) or equivalent — documented as the intended shape, not constructed
 * here.
 */
export function assertInvoicePaymentStatusTransition(
  from: InvoicePaymentStatus3b6,
  to: InvoicePaymentStatus3b6,
): void {
  if (!canTransitionInvoicePaymentStatus(from, to)) {
    throw new RangeError(`illegal Invoice payment-status transition ${from} -> ${to}`);
  }
}

/**
 * Task 3b.7 Checkpoint D — the frozen extension point this module's own doc
 * comment anticipated ("3b.7 SETTLED... get to add their own reachable
 * edges to this SAME graph"). A SEPARATE, wider type/graph — the original
 * `InvoicePaymentStatus3b6`/`TRANSITIONS`/`assertInvoicePaymentStatusTransition`
 * above are UNCHANGED (still exactly the 3b.6 coverage-arithmetic graph,
 * still used unmodified by every existing 3b.6 caller). `SETTLED` is
 * FORWARD-ONLY from `PAID` — never a coverage-arithmetic state itself (it
 * layers settlement-finality on top of an already-PAID invoice), so `UNPAID`/
 * `PARTIAL` have no edge to it and `SETTLED` has no edge back to `PAID`.
 */
export type InvoiceSettlementStatus3b7 = InvoicePaymentStatus3b6 | 'SETTLED';

const TRANSITIONS_3B7: Readonly<
  Record<InvoiceSettlementStatus3b7, readonly InvoiceSettlementStatus3b7[]>
> = Object.freeze({
  UNPAID: ['UNPAID'],
  PARTIAL: ['PARTIAL'],
  PAID: ['PAID', 'SETTLED'],
  SETTLED: ['SETTLED'],
});

export function canTransitionInvoiceSettlementStatus(
  from: InvoiceSettlementStatus3b7,
  to: InvoiceSettlementStatus3b7,
): boolean {
  return TRANSITIONS_3B7[from].includes(to);
}

/** Throws for any edge outside the frozen 3b.7 graph — in particular
 *  `SETTLED -> PAID` (3b.7 is forward-only; reversal is a future 3b.8+
 *  concept) and any edge out of `UNPAID`/`PARTIAL` into `SETTLED`. */
export function assertInvoiceSettlementStatusTransition(
  from: InvoiceSettlementStatus3b7,
  to: InvoiceSettlementStatus3b7,
): void {
  if (!canTransitionInvoiceSettlementStatus(from, to)) {
    throw new RangeError(`illegal Invoice settlement-status transition ${from} -> ${to}`);
  }
}
