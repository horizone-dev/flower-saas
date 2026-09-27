/**
 * Task 3b.6 Checkpoint A — pure canonical-Payment capacity arithmetic. NO
 * DB, NO locking. The cross-table concurrency backstop this arithmetic
 * feeds (locking the `Payment` row before any `PaymentAllocation`/
 * `CustomerAdvance` insert against it) is a Checkpoint B/D/E concern; this
 * module only ever answers "would this proposed consumption fit."
 *
 * Error convention: plain `RangeError`, matching every other pure module in
 * this repository.
 *
 * Frozen invariant (3b.6 architecture-freeze, this session): a single
 * `Payment`'s money can be consumed by `PaymentAllocation` rows and/or
 * `CustomerAdvance` rows funded from it, but the combined total drawn from
 * one Payment can never exceed that Payment's own `amountMinor` — this is
 * exactly what prevents the same receipt money from being both allocated to
 * an Invoice AND turned into an Advance.
 */

export interface PaymentConsumptionState {
  readonly paymentAmountMinor: bigint;
  /** sum of every existing PaymentAllocation drawn from this Payment */
  readonly allocatedToInvoicesMinor: bigint;
  /** sum of every existing CustomerAdvance funded from this Payment */
  readonly convertedToAdvanceMinor: bigint;
}

export interface PaymentConsumptionResult {
  readonly consumedMinor: bigint;
  readonly remainingMinor: bigint;
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} must be >= 0 (got ${value})`);
  }
}

export function computePaymentConsumption(
  state: PaymentConsumptionState,
): PaymentConsumptionResult {
  assertNonNegative(state.paymentAmountMinor, 'paymentAmountMinor');
  assertNonNegative(state.allocatedToInvoicesMinor, 'allocatedToInvoicesMinor');
  assertNonNegative(state.convertedToAdvanceMinor, 'convertedToAdvanceMinor');

  const consumedMinor = state.allocatedToInvoicesMinor + state.convertedToAdvanceMinor;
  if (consumedMinor > state.paymentAmountMinor) {
    throw new RangeError(
      `computePaymentConsumption: allocatedToInvoicesMinor + convertedToAdvanceMinor ` +
        `(${consumedMinor}) exceeds paymentAmountMinor (${state.paymentAmountMinor}) — this ` +
        'represents a corrupted invariant that must never occur under a correctly-locked caller',
    );
  }
  return { consumedMinor, remainingMinor: state.paymentAmountMinor - consumedMinor };
}

/**
 * Pure capacity check for a PROPOSED new draw (a new `PaymentAllocation` or
 * a new `CustomerAdvance` funding) against the Payment's CURRENT
 * consumption state — never mutates `state`, always answers against a
 * freshly-supplied snapshot the caller obtained under its own row lock.
 */
export function wouldExceedPaymentCapacity(
  state: PaymentConsumptionState,
  proposedAmountMinor: bigint,
): boolean {
  assertNonNegative(proposedAmountMinor, 'proposedAmountMinor');
  const { remainingMinor } = computePaymentConsumption(state);
  return proposedAmountMinor > remainingMinor;
}

/**
 * Throws a plain `RangeError` when the proposed draw would exceed the
 * Payment's remaining capacity — the future service-layer caller is
 * expected to surface this as `PAYMENT_OVER_ALLOCATED` (409) or equivalent.
 */
export function assertPaymentCapacity(
  state: PaymentConsumptionState,
  proposedAmountMinor: bigint,
): void {
  if (wouldExceedPaymentCapacity(state, proposedAmountMinor)) {
    const { remainingMinor } = computePaymentConsumption(state);
    throw new RangeError(
      `proposed amount ${proposedAmountMinor} exceeds the Payment's remaining capacity ` +
        `${remainingMinor}`,
    );
  }
}
