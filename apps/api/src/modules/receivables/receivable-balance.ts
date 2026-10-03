/**
 * Task 3b.8 Integration Closure — the ONE canonical, pure customer-receivable /
 * customer-advance balance arithmetic. NO DB, NO HTTP, NO Prisma types.
 *
 * WHY THIS EXISTS: every consumer that needs "how much does this receivable
 * still owe" or "how much of this advance is still spendable" — the
 * customer-account read model (summary / open-receivables list / advances
 * list / projection-integrity), FIFO receipt collection, and CustomerAdvance
 * application — used to carry its OWN copy of the formula, each written when
 * only INVOICE and OPENING receivables and only applications-against-an-advance
 * existed. Task 3b.8 added a third receivable source (`CANCELLATION_CHARGE`), a
 * CreditNote that reduces an invoice receivable without any allocation, and two
 * new draws on an advance (refund applications, PENDING provider-refund
 * reservations); each copy silently mishandled them ("anything not INVOICE is
 * OPENING" -> `null - bigint` -> a 500). Every consumer now calls THESE
 * functions, so a future source type or consumer cannot drift.
 *
 * Money is `bigint` minor units throughout — no `number`, no float (CLAUDE.md
 * rule 15).
 *
 * Error convention: a plain `RangeError`, like every other pure module here
 * (`advance-application.ts`, `receivable-fifo-allocation.ts`).
 *
 * ── RECEIVABLE (by source type) ────────────────────────────────────────────
 *   outstanding = principal − paidByPayment − paidByAdvance − credited
 *
 *   INVOICE             principal   = Invoice.totalAmountMinor
 *                       paidByPayment = Σ PaymentAllocation(invoice)
 *                       paidByAdvance = Σ CustomerAdvanceApplication(receivable)
 *                       credited      = Σ CreditNote.arReductionMinor(invoice)
 *   OPENING             principal   = CustomerReceivable.openingAmountMinor
 *                       paidByPayment = Σ CustomerReceivablePaymentApplication
 *                       paidByAdvance = Σ CustomerAdvanceApplication
 *                       credited      = 0 (a CreditNote only ever reduces an Invoice)
 *   CANCELLATION_CHARGE principal   = CancellationCharge.totalAmountMinor
 *                       paidByPayment = Σ CustomerReceivablePaymentApplication
 *                       paidByAdvance = Σ CustomerAdvanceApplication
 *                       credited      = 0
 *
 *   `credited` is the CreditNote's `arReductionMinor` ONLY — the still-unpaid
 *   remainder that was simply reversed. The already-PAID portion of a
 *   cancelled invoice stays represented by its (immutable) PaymentAllocation /
 *   CustomerAdvanceApplication rows and is released into a CREDIT_NOTE
 *   CustomerAdvance, so it must NOT be subtracted a second time here
 *   (`arReduction + paid = total`, so a fully cancelled invoice is exactly 0).
 *   This is also exactly what the maintained `currentOutstandingMinor`
 *   projection does at CreditNote issuance (`decrement arReductionMinor`).
 *
 * ── ADVANCE ────────────────────────────────────────────────────────────────
 *   consumed        = Σ application + Σ refund application + Σ PENDING reservation
 *                     (exactly what the DB `fn_lock_and_validate_advance_capacity`
 *                      backstop enforces)
 *   bookedRemaining = principal − applied − refunded
 *                     (exactly the advance's contribution to the maintained
 *                      `CustomerCompanyAccount.advanceBalanceMinor` projection —
 *                      a PENDING reservation does NOT move that projection;
 *                      only a completed Refund / application does)
 *   available       = principal − consumed  (what may be applied / refunded NOW)
 */

export const RECEIVABLE_SOURCE_TYPES = Object.freeze([
  'INVOICE',
  'OPENING',
  'CANCELLATION_CHARGE',
] as const);

export type ReceivableSourceType = (typeof RECEIVABLE_SOURCE_TYPES)[number];

export function isReceivableSourceType(value: string): value is ReceivableSourceType {
  return (RECEIVABLE_SOURCE_TYPES as readonly string[]).includes(value);
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} must be >= 0 (got ${value})`);
  }
}

export interface ReceivableBalanceInput {
  /** The raw `customer_receivable.sourceType` — validated here (a closed set),
   *  never defaulted: an unrecognized value is rejected, not treated as OPENING. */
  readonly sourceType: string;
  /** The principal authored by this receivable's OWN source document; `null`
   *  means that document could not be resolved (a data error) — rejected, never
   *  silently coerced to a number. */
  readonly principalMinor: bigint | null;
  readonly paidByPaymentMinor: bigint;
  readonly paidByAdvanceMinor: bigint;
  /** INVOICE only — Σ CreditNote.arReductionMinor. Must be 0 for every other source. */
  readonly creditedMinor: bigint;
}

export interface ReceivableBalance {
  readonly sourceType: ReceivableSourceType;
  readonly originalMinor: bigint;
  readonly paidByPaymentMinor: bigint;
  readonly paidByAdvanceMinor: bigint;
  readonly creditedMinor: bigint;
  /** May be NEGATIVE for a corrupted (over-covered) state — a consumer decides
   *  (`<= 0n` is "closed"); this function never throws for it so a READ model
   *  can report the corruption (`projectionIntegrity`) instead of failing. */
  readonly outstandingMinor: bigint;
}

export function computeReceivableBalance(input: ReceivableBalanceInput): ReceivableBalance {
  if (!isReceivableSourceType(input.sourceType)) {
    throw new RangeError(`unrecognized CustomerReceivable sourceType: ${String(input.sourceType)}`);
  }
  const sourceType = input.sourceType;
  if (input.principalMinor === null) {
    throw new RangeError(
      `CustomerReceivable(${sourceType}) has no resolvable principal — its source document is missing`,
    );
  }
  assertNonNegative(input.principalMinor, 'principalMinor');
  assertNonNegative(input.paidByPaymentMinor, 'paidByPaymentMinor');
  assertNonNegative(input.paidByAdvanceMinor, 'paidByAdvanceMinor');
  assertNonNegative(input.creditedMinor, 'creditedMinor');
  if (sourceType !== 'INVOICE' && input.creditedMinor !== 0n) {
    throw new RangeError(
      `CustomerReceivable(${sourceType}) cannot carry a CreditNote reduction (got ${input.creditedMinor}) — ` +
        'a CreditNote only ever reduces an INVOICE receivable',
    );
  }

  return {
    sourceType,
    originalMinor: input.principalMinor,
    paidByPaymentMinor: input.paidByPaymentMinor,
    paidByAdvanceMinor: input.paidByAdvanceMinor,
    creditedMinor: input.creditedMinor,
    outstandingMinor:
      input.principalMinor -
      input.paidByPaymentMinor -
      input.paidByAdvanceMinor -
      input.creditedMinor,
  };
}

export interface AdvanceBalanceInput {
  readonly principalMinor: bigint;
  /** Σ CustomerAdvanceApplication */
  readonly appliedMinor: bigint;
  /** Σ CustomerAdvanceRefundApplication */
  readonly refundedMinor: bigint;
  /** Σ RefundAttemptEntitlementReservation of a PENDING RefundAttempt */
  readonly reservedMinor: bigint;
}

export interface AdvanceBalance extends AdvanceBalanceInput {
  readonly consumedMinor: bigint;
  readonly bookedRemainingMinor: bigint;
  /** May be NEGATIVE for a corrupted (over-consumed) state — see
   *  `ReceivableBalance.outstandingMinor`. */
  readonly availableMinor: bigint;
}

export function computeAdvanceBalance(input: AdvanceBalanceInput): AdvanceBalance {
  assertNonNegative(input.principalMinor, 'principalMinor');
  assertNonNegative(input.appliedMinor, 'appliedMinor');
  assertNonNegative(input.refundedMinor, 'refundedMinor');
  assertNonNegative(input.reservedMinor, 'reservedMinor');

  const consumedMinor = input.appliedMinor + input.refundedMinor + input.reservedMinor;
  return {
    principalMinor: input.principalMinor,
    appliedMinor: input.appliedMinor,
    refundedMinor: input.refundedMinor,
    reservedMinor: input.reservedMinor,
    consumedMinor,
    bookedRemainingMinor: input.principalMinor - input.appliedMinor - input.refundedMinor,
    availableMinor: input.principalMinor - consumedMinor,
  };
}
