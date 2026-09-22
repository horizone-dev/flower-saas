/**
 * Task 3b.5 Checkpoint A — pure Payment/Allocation invariant. NO DB.
 *
 * Frozen for 3b.5 (owner contract round 2/3, §3): exactly one
 * `PaymentAllocation` per `Payment`, and
 *   allocation.amountMinor === payment.amountMinor
 *   allocation.currencyCode === payment.currencyCode
 *   allocation.currencyExponent === payment.currencyExponent
 *   allocation.{tenantId,companyId,branchId} === payment.{...}
 *
 * This function does NOT check overpayment against the Invoice's
 * outstanding balance — that requires the locked Invoice state
 * (`computeAvailableToCollect`, checked by the caller under the lock) and
 * is out of scope for this pure pairwise assertion. Future 3b.6+
 * multi-invoice fan-out changes how many Allocation rows exist per Payment,
 * not this pairwise equality contract.
 *
 * Error convention: this module throws plain `RangeError`, matching the
 * repository's established pure-module convention (`tax-arithmetic.ts`,
 * `document-discount-allocation.ts` — no `DomainError`/HTTP status in a
 * DB/HTTP-free module). The future service layer is expected to surface a
 * failure here as `PAYMENT_ALLOCATION_MISMATCH` (409) — documented as the
 * intended code, not constructed here.
 */
export interface PaymentAllocationCandidate {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
}

export interface PaymentForAllocation {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
}

export function assertPaymentAllocationMatchesPayment(
  allocation: PaymentAllocationCandidate,
  payment: PaymentForAllocation,
): void {
  if (
    allocation.tenantId !== payment.tenantId ||
    allocation.companyId !== payment.companyId ||
    allocation.branchId !== payment.branchId
  ) {
    throw new RangeError(
      'PaymentAllocation scope (tenant/company/branch) does not match its Payment',
    );
  }
  if (allocation.currencyCode !== payment.currencyCode) {
    throw new RangeError(
      `PaymentAllocation currency ${allocation.currencyCode} does not match Payment currency ${payment.currencyCode}`,
    );
  }
  if (allocation.currencyExponent !== payment.currencyExponent) {
    throw new RangeError(
      `PaymentAllocation exponent ${allocation.currencyExponent} does not match Payment exponent ${payment.currencyExponent}`,
    );
  }
  if (allocation.amountMinor !== payment.amountMinor) {
    throw new RangeError(
      `PaymentAllocation amount ${allocation.amountMinor} does not equal Payment amount ${payment.amountMinor} ` +
        '(3b.5: exactly one Allocation per Payment, full amount)',
    );
  }
}
