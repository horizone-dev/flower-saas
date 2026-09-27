/**
 * Task 3b.6 Checkpoint A — pure, deterministic FIFO allocation across a
 * customer's open receivables. NO DB, NO locking (the caller locks the
 * target Invoice rows, in the SAME order this module returns, before ever
 * calling this — see the 3b.6 architecture-freeze lock-order decision).
 *
 * Error convention: plain `RangeError`, matching every other pure module in
 * this repository.
 *
 * Deterministic ordering (3b.6 architecture-freeze, this session): oldest
 * `createdAt` first, with `id` as a stable tie-breaker for two receivables
 * sharing the exact same timestamp — never raw input/DB-return order. This
 * module sorts a COPY of the input array; it never mutates its arguments.
 */

export interface OpenReceivable {
  readonly id: string;
  readonly createdAt: Date;
  readonly outstandingMinor: bigint;
}

export interface ReceivableAllocation {
  readonly receivableId: string;
  readonly amountMinor: bigint;
}

export interface FifoAllocationResult {
  readonly allocations: readonly ReceivableAllocation[];
  readonly unallocatedAmountMinor: bigint;
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} must be >= 0 (got ${value})`);
  }
}

/** Oldest-first, id-tie-broken — never DB/array return order. Pure sort, no mutation. */
function sortFifo(receivables: readonly OpenReceivable[]): OpenReceivable[] {
  return [...receivables].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Allocates `receiptAmountMinor` across `openReceivables`, oldest-first,
 * never exceeding either the receipt amount or any single receivable's own
 * `outstandingMinor`. A receivable with `outstandingMinor === 0n` is
 * skipped entirely (never produces a zero-amount allocation row). Returns
 * the allocations plus whatever portion of the receipt could not be
 * consumed by any open receivable — that remainder is never itself turned
 * into an Advance by this function; that is always a separate, explicit
 * caller decision (3b.6 architecture-freeze: "never a silent side effect of
 * an over-payment").
 */
export function allocateFifo(
  receiptAmountMinor: bigint,
  openReceivables: readonly OpenReceivable[],
): FifoAllocationResult {
  assertNonNegative(receiptAmountMinor, 'receiptAmountMinor');
  for (const [index, r] of openReceivables.entries()) {
    assertNonNegative(r.outstandingMinor, `openReceivables[${index}].outstandingMinor`);
  }

  const ordered = sortFifo(openReceivables);
  const allocations: ReceivableAllocation[] = [];
  let remaining = receiptAmountMinor;

  for (const receivable of ordered) {
    if (remaining === 0n) break;
    if (receivable.outstandingMinor === 0n) continue; // skip — nothing to allocate
    const amount =
      receivable.outstandingMinor < remaining ? receivable.outstandingMinor : remaining;
    allocations.push({ receivableId: receivable.id, amountMinor: amount });
    remaining -= amount;
  }

  return { allocations, unallocatedAmountMinor: remaining };
}
