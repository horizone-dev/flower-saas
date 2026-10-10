import { DomainError } from '../../common/errors/domain-error.js';
import {
  computeReceivableBalance,
  RECEIVABLE_SOURCE_TYPES,
  type ReceivableBalance,
  type ReceivableSourceType,
} from '../receivables/receivable-balance.js';
import { minorUnitsToWire } from './report-money.js';

/**
 * Task 3b.10 Checkpoint D — the PURE Receivables current-state arithmetic. NO DB, NO HTTP, NO Prisma types, NO clock.
 * Exact `bigint` minor units only — no float, no FX, no rounding.
 *
 * The report is a CURRENT snapshot (it has no date input of any kind) of the frozen customer receivables:
 *
 *   outstanding = original − paidByPayment − paidByAdvance − credited
 *
 * which is EXACTLY the frozen `computeReceivableBalance` (`../receivables/receivable-balance.ts`) — this module never
 * writes the formula a second time: every figure below is produced by CALLING that helper on a (source type) cell whose
 * components the one SQL statement summed. The helper is linear in its components, so the balance of a sum of
 * receivables equals the sum of their balances, and its validation (a closed source-type set, no negative component, no
 * CreditNote reduction on a non-INVOICE receivable) applies to every cell.
 *
 *   original        INVOICE: the Invoice total · OPENING: the authored opening amount · CANCELLATION_CHARGE: the charge total
 *   paidByPayment   INVOICE: Σ PaymentAllocation · OPENING / CANCELLATION_CHARGE: Σ CustomerReceivablePaymentApplication
 *                   (a Payment RECEIPT itself, an unapplied remainder and a Refund are never an AR reduction)
 *   paidByAdvance   Σ CustomerAdvanceApplication (an Advance's CREATION, a pending refund reservation and a Refund are not)
 *   credited        INVOICE only: Σ CreditNote.arReductionMinor — the still-unpaid remainder that was reversed; the
 *                   CreditNote's excess that became a CustomerAdvance is NEVER subtracted again and is not receivable
 *
 * Out of scope here, deliberately: aging / due dates (no due-date contract was ever frozen), historical (`asOf`-input)
 * reconstruction, customer PII, advance balances, unapplied receipts, settlement — and no figure claims to be more than
 * its own source documents state.
 */

/**
 * Pagination convention of the per-customer rows — the SAME convention as the customer-account read model
 * (`customer-account-read.repository.ts`: `DEFAULT_LIST_LIMIT = 50`, `MAX_LIST_LIMIT = 200`, `INVALID_LIMIT`,
 * `INVALID_CURSOR`; module-private there, pinned equal to it by the Checkpoint D structural pins).
 */
export const RECEIVABLES_REPORT_DEFAULT_LIMIT = 50;
export const RECEIVABLES_REPORT_MAX_LIMIT = 200;

export const RECEIVABLES_REPORT_NOTE =
  'Current receivable position at the snapshot instant asOf: the original receivable amount minus the amounts satisfied by payment allocations, customer-advance applications and credit-note AR reductions. It is not sales, not receipts, not revenue and not settled money, and it is not a historical figure.';

/** the current-snapshot instant: an ISO-8601 UTC timestamp the DATABASE derived in the same statement */
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export function assertAsOf(value: unknown): string {
  if (typeof value !== 'string' || !AS_OF_RE.test(value)) {
    throw new RangeError(
      'asOf must be the database snapshot timestamp (ISO-8601 UTC, milliseconds)',
    );
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `undefined` → the default; a non-positive / non-integer value → `400 INVALID_LIMIT`; above the max → the max */
export function parseReceivablesLimit(limit: unknown): number {
  if (limit === undefined) return RECEIVABLES_REPORT_DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new DomainError('INVALID_LIMIT', 'limit must be a positive integer', 400);
  }
  return limit > RECEIVABLES_REPORT_MAX_LIMIT ? RECEIVABLES_REPORT_MAX_LIMIT : limit;
}

/** the cursor is the last emitted customerId — `undefined` → the first page; anything but a uuid → `400 INVALID_CURSOR` */
export function parseReceivablesCursor(cursor: unknown): string | null {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || !UUID_RE.test(cursor)) {
    throw new DomainError('INVALID_CURSOR', 'cursor is not a valid cursor', 400);
  }
  return cursor.toLowerCase();
}

/** one (source type) aggregate of receivables — the components the SQL summed (exact bigint) */
export interface ReceivablesCell {
  /** a plain string so an unknown / forbidden value can be represented and rejected by the frozen helper */
  readonly sourceType: string;
  readonly count: number;
  readonly original: bigint;
  readonly paidByPayment: bigint;
  readonly paidByAdvance: bigint;
  readonly credited: bigint;
}

export interface ReceivablesCustomerCell extends ReceivablesCell {
  readonly customerId: string;
}

export interface ReceivablesFigures {
  readonly receivableCount: number;
  readonly originalMinor: string;
  readonly paidByPaymentMinor: string;
  readonly paidByAdvanceMinor: string;
  readonly creditedMinor: string;
  readonly outstandingMinor: string;
}

export interface ReceivablesSourceTypeRow extends ReceivablesFigures {
  readonly sourceType: ReceivableSourceType;
}

export interface ReceivablesReconciliation {
  readonly sourceOutstandingMinor: string;
  readonly glAccountsReceivableMinor: string;
  readonly differenceMinor: string;
  readonly reconciled: boolean;
}

export interface ReceivablesBlocks extends ReceivablesFigures {
  readonly note: string;
  readonly bySourceType: readonly ReceivablesSourceTypeRow[];
  readonly reconciliation: ReceivablesReconciliation;
}

export interface ReceivablesCustomerRow extends ReceivablesFigures {
  readonly customerId: string;
}

const INTEGRITY_MESSAGE =
  'a customer receivable is inconsistent with its own source documents — no report is returned';

/** the frozen balance helper, with its `RangeError` mapped to the report's fail-closed domain error (non-disclosing) */
function balanceOf(cell: ReceivablesCell): ReceivableBalance {
  let balance: ReceivableBalance;
  try {
    balance = computeReceivableBalance({
      sourceType: cell.sourceType,
      principalMinor: cell.original,
      paidByPaymentMinor: cell.paidByPayment,
      paidByAdvanceMinor: cell.paidByAdvance,
      creditedMinor: cell.credited,
    });
  } catch (e) {
    if (e instanceof RangeError) {
      throw new DomainError('REPORT_RECEIVABLES_SOURCE_INTEGRITY', INTEGRITY_MESSAGE, 500);
    }
    throw e;
  }
  // the helper tolerates an over-covered (negative) outstanding so a read model can REPORT it; a report fails closed
  if (balance.outstandingMinor < 0n) {
    throw new DomainError('REPORT_RECEIVABLES_SOURCE_INTEGRITY', INTEGRITY_MESSAGE, 500);
  }
  return balance;
}

interface Sum {
  count: number;
  original: bigint;
  paidByPayment: bigint;
  paidByAdvance: bigint;
  credited: bigint;
  outstanding: bigint;
}
const zero = (): Sum => ({
  count: 0,
  original: 0n,
  paidByPayment: 0n,
  paidByAdvance: 0n,
  credited: 0n,
  outstanding: 0n,
});

function addCell(into: Sum, cell: ReceivablesCell): void {
  const b = balanceOf(cell);
  into.count += cell.count;
  into.original += b.originalMinor;
  into.paidByPayment += b.paidByPaymentMinor;
  into.paidByAdvance += b.paidByAdvanceMinor;
  into.credited += b.creditedMinor;
  into.outstanding += b.outstandingMinor;
}

function figures(sum: Sum): ReceivablesFigures {
  return {
    receivableCount: sum.count,
    originalMinor: minorUnitsToWire(sum.original),
    paidByPaymentMinor: minorUnitsToWire(sum.paidByPayment),
    paidByAdvanceMinor: minorUnitsToWire(sum.paidByAdvance),
    creditedMinor: minorUnitsToWire(sum.credited),
    outstandingMinor: minorUnitsToWire(sum.outstanding),
  };
}

/**
 * One scope's blocks (a branch, or the whole company) from its source cells and the GL Accounts-Receivable net
 * (debit − credit) of EXACTLY the authoritative AR journals of the same scope. Zero-fills every frozen source type.
 * Any difference between the source outstanding and that GL net fails the report closed
 * (`500 REPORT_RECEIVABLES_GL_MISMATCH`) — an apparently trustworthy figure is never returned with a failed control.
 */
export function buildReceivablesBlocks(
  cells: readonly ReceivablesCell[],
  glNetMinor: bigint,
): ReceivablesBlocks {
  const byType = new Map<ReceivableSourceType, Sum>(
    RECEIVABLE_SOURCE_TYPES.map((t) => [t, zero()]),
  );
  const total = zero();
  for (const cell of cells) {
    const slot = byType.get(cell.sourceType as ReceivableSourceType);
    if (slot === undefined) {
      // an unrecognized source type is rejected by the frozen helper itself (a closed set, never an "else OPENING")
      balanceOf(cell);
      throw new DomainError('REPORT_RECEIVABLES_SOURCE_INTEGRITY', INTEGRITY_MESSAGE, 500);
    }
    addCell(slot, cell);
    addCell(total, cell);
  }
  const difference = total.outstanding - glNetMinor;
  if (difference !== 0n) {
    throw new DomainError(
      'REPORT_RECEIVABLES_GL_MISMATCH',
      'the current receivables disagree with the general-ledger Accounts Receivable of their own journals — no report is returned',
      500,
    );
  }
  return {
    note: RECEIVABLES_REPORT_NOTE,
    ...figures(total),
    bySourceType: RECEIVABLE_SOURCE_TYPES.map((t) => ({
      sourceType: t,
      ...figures(byType.get(t)!),
    })),
    reconciliation: {
      sourceOutstandingMinor: minorUnitsToWire(total.outstanding),
      glAccountsReceivableMinor: minorUnitsToWire(glNetMinor),
      differenceMinor: minorUnitsToWire(difference),
      reconciled: true,
    },
  };
}

/** the per-customer rows of one page, from the (customer, source type) cells the SQL summed — in customerId order */
export function buildCustomerRows(
  cells: readonly ReceivablesCustomerCell[],
): ReceivablesCustomerRow[] {
  const byCustomer = new Map<string, Sum>();
  for (const cell of cells) {
    let sum = byCustomer.get(cell.customerId);
    if (sum === undefined) {
      sum = zero();
      byCustomer.set(cell.customerId, sum);
    }
    addCell(sum, cell);
  }
  return [...byCustomer.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([customerId, sum]) => ({ customerId, ...figures(sum) }));
}
