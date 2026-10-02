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
 *
 * Task 3b.8 Integration Closure (F1): this frozen formula only knows the
 * allocation draw on an invoice, so NO production path calls it any more — the
 * direct-payment paths (synchronous capture, async reservation, webhook capture)
 * all use {@link computeAvailableToCollectFromOutstanding} over the canonical
 * receivable balance, which also honours a CreditNote AR reduction and a
 * CustomerAdvance application. It is retained, unchanged and still tested, as the
 * documented special case of that function for an invoice with neither.
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

/**
 * Task 3b.8 Integration Closure (F1) — "available to collect" over the CANONICAL
 * receivable remaining balance (`receivable-balance.ts`):
 *
 *   availableToCollect = max(0, outstanding − activeReservedAmount)
 *   outstanding        = invoiceTotal − Σ PaymentAllocation − Σ CustomerAdvanceApplication
 *                        − Σ CreditNote.arReductionMinor
 *
 * `outstanding` is computed by the caller (under the Invoice row lock) through
 * `loadInvoiceBalance`, so a direct payment is capped by exactly the figure the
 * customer-account read model reports and the DB coverage backstop enforces —
 * never by `total − allocations` alone, which ignores the two draws that reduce
 * an invoice receivable without an allocation.
 *
 * The result is FLOORED at zero instead of throwing (the frozen
 * {@link computeAvailableToCollect} rejects confirmed + reserved > total as a
 * corrupted invariant). After a CreditNote or an advance application, a provider
 * attempt that was legitimately reserved BEFORE it may now exceed what is still
 * outstanding — a legal state, not corruption: such an invoice simply has nothing
 * left to collect. A non-positive outstanding (closed, or corrupted over-covered)
 * therefore fails closed to 0.
 */
export function computeAvailableToCollectFromOutstanding(
  outstandingMinor: bigint,
  activeReservedAmountMinor: bigint,
): bigint {
  if (activeReservedAmountMinor < 0n) {
    throw new RangeError(
      'computeAvailableToCollectFromOutstanding: activeReservedAmountMinor must be >= 0',
    );
  }
  if (outstandingMinor <= 0n) return 0n;
  const available = outstandingMinor - activeReservedAmountMinor;
  return available > 0n ? available : 0n;
}
