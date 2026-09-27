/**
 * Task 3b.6 Checkpoint A — pure CustomerAdvance availability/application
 * arithmetic. NO DB, NO locking, NO PaymentAllocation is ever produced from
 * this module — applying an Advance never involves a new Payment.
 *
 * Error convention: plain `RangeError`, matching every other pure module in
 * this repository.
 *
 * Frozen invariants (3b.6 architecture-freeze, this session):
 *   advanceAvailable = advancePrincipalMinor - Σ(CustomerAdvanceApplication)
 *   an application amount must be > 0, must never exceed the Advance's own
 *   available balance, and must never exceed the TARGET receivable's own
 *   outstanding amount (both sides bound the same application).
 */

export interface AdvanceAvailabilityState {
  readonly advancePrincipalMinor: bigint;
  readonly appliedSoFarMinor: bigint;
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} must be >= 0 (got ${value})`);
  }
}

export function computeAdvanceAvailable(state: AdvanceAvailabilityState): bigint {
  assertNonNegative(state.advancePrincipalMinor, 'advancePrincipalMinor');
  assertNonNegative(state.appliedSoFarMinor, 'appliedSoFarMinor');
  if (state.appliedSoFarMinor > state.advancePrincipalMinor) {
    throw new RangeError(
      `computeAdvanceAvailable: appliedSoFarMinor (${state.appliedSoFarMinor}) exceeds ` +
        `advancePrincipalMinor (${state.advancePrincipalMinor}) — corrupted invariant`,
    );
  }
  return state.advancePrincipalMinor - state.appliedSoFarMinor;
}

export interface ApplyAdvanceInput {
  readonly advance: AdvanceAvailabilityState;
  readonly targetReceivableOutstandingMinor: bigint;
  readonly proposedApplicationAmountMinor: bigint;
}

export interface ApplyAdvanceResult {
  readonly newAdvanceAvailableMinor: bigint;
  readonly newReceivableOutstandingMinor: bigint;
}

/**
 * Validates and computes the result of applying a proposed amount from an
 * Advance to a target receivable's outstanding balance. Throws (never
 * silently clamps) when the proposal is invalid — a caller must always
 * supply a legal amount, never rely on this function to "fix" an
 * over-large request. No `PaymentAllocation` is created or referenced here.
 */
export function applyAdvance(input: ApplyAdvanceInput): ApplyAdvanceResult {
  assertNonNegative(input.targetReceivableOutstandingMinor, 'targetReceivableOutstandingMinor');
  const available = computeAdvanceAvailable(input.advance);

  if (input.proposedApplicationAmountMinor <= 0n) {
    throw new RangeError(
      `proposedApplicationAmountMinor must be > 0 (got ${input.proposedApplicationAmountMinor})`,
    );
  }
  if (input.proposedApplicationAmountMinor > available) {
    throw new RangeError(
      `proposedApplicationAmountMinor ${input.proposedApplicationAmountMinor} exceeds the ` +
        `Advance's available balance ${available}`,
    );
  }
  if (input.proposedApplicationAmountMinor > input.targetReceivableOutstandingMinor) {
    throw new RangeError(
      `proposedApplicationAmountMinor ${input.proposedApplicationAmountMinor} exceeds the ` +
        `target receivable's own outstanding ${input.targetReceivableOutstandingMinor}`,
    );
  }

  return {
    newAdvanceAvailableMinor: available - input.proposedApplicationAmountMinor,
    newReceivableOutstandingMinor:
      input.targetReceivableOutstandingMinor - input.proposedApplicationAmountMinor,
  };
}
