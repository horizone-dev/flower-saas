/**
 * Task 3b.5 Checkpoint A — pure exact-BigInt "available to collect" math.
 * NO DB access, NO Number()/parseFloat, NO floating-point money arithmetic.
 *
 * Frozen formula (owner contract round 3, §1/§2):
 *   availableToCollect = invoiceTotal - confirmedAmount - activeReservedAmount
 *
 * The caller is responsible for computing `confirmedAmount` (sum of
 * `PaymentAllocation.amountMinor`) and `activeReservedAmount` (sum of
 * provider-backed `PaymentAttempt.amountMinor` in an ACTIVE reservation
 * state with no confirmed Payment) under an Invoice row lock — this module
 * performs no DB sum itself.
 */
export function computeAvailableToCollect(
  invoiceTotalMinor: bigint,
  confirmedAmountMinor: bigint,
  activeReservedAmountMinor: bigint,
): bigint {
  if (invoiceTotalMinor < 0n) {
    throw new RangeError('computeAvailableToCollect: invoiceTotalMinor must be >= 0');
  }
  if (confirmedAmountMinor < 0n) {
    throw new RangeError('computeAvailableToCollect: confirmedAmountMinor must be >= 0');
  }
  if (activeReservedAmountMinor < 0n) {
    throw new RangeError('computeAvailableToCollect: activeReservedAmountMinor must be >= 0');
  }
  if (confirmedAmountMinor + activeReservedAmountMinor > invoiceTotalMinor) {
    throw new RangeError(
      'computeAvailableToCollect: confirmedAmountMinor + activeReservedAmountMinor exceeds ' +
        `invoiceTotalMinor (${confirmedAmountMinor} + ${activeReservedAmountMinor} > ${invoiceTotalMinor}) ` +
        '— this represents a corrupted invariant that must never occur under a correctly-locked caller',
    );
  }
  const available = invoiceTotalMinor - confirmedAmountMinor - activeReservedAmountMinor;
  // guaranteed by the guard above, asserted defensively rather than trusted silently
  if (available < 0n) {
    throw new RangeError(
      'computeAvailableToCollect: computed a negative result — invariant violated',
    );
  }
  return available;
}
