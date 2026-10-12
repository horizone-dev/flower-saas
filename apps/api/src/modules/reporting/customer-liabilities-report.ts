import { DomainError } from '../../common/errors/domain-error.js';
import { computePaymentConsumption } from '../receivables/payment-consumption.js';
import { computeAdvanceBalance } from '../receivables/receivable-balance.js';
import { minorUnitsToWire } from './report-money.js';

/**
 * Task 3b.10 Checkpoint E — the PURE customer-liabilities current-state arithmetic. NO DB, NO HTTP, NO Prisma types, NO
 * clock. Exact `bigint` minor units only — no float, no FX, no rounding.
 *
 * TWO financially separate liabilities, each with its OWN source figures and its OWN general-ledger control — they are
 * never netted, never summed, never compared with one another:
 *
 *   CUSTOMER ADVANCES (GL `LIABILITY.CUSTOMER_ADVANCES`) — every figure is the frozen `computeAdvanceBalance`
 *   (`receivables/receivable-balance.ts`), called once per cell whose components the one SQL statement summed:
 *     book liability      = principal − Σ CustomerAdvanceApplication − Σ CustomerAdvanceRefundApplication
 *     pending reservation = Σ RefundAttemptEntitlementReservation of a PENDING RefundAttempt
 *     available           = book liability − pending reservation
 *   A pending reservation reduces AVAILABLE only: it moves neither the book liability nor the GL until the refund is
 *   actually posted (SUCCEEDED), so the GL control compares the BOOK liability — never the available figure.
 *
 *   UNAPPLIED RECEIPTS (GL `LIABILITY.UNAPPLIED_RECEIPTS`) — per customer-attributable Payment, the frozen 3-term capacity
 *   the database itself enforces (`fn_lock_and_validate_payment_capacity`):
 *     unapplied = receipt − Σ PaymentAllocation − Σ CustomerReceivablePaymentApplication − Σ CustomerAdvance(sourcePaymentId)
 *   which is exactly the frozen `computePaymentConsumption` with both draws on receivables in its first term. A
 *   CustomerAdvanceApplication, a CreditNote, a Refund and a settlement never consume a receipt.
 *
 * Both helpers are linear in their components, so the figure of a sum equals the sum of the figures; their validation
 * (a negative component, an over-consumed Payment) applies to every cell and fails the report closed.
 */

/** the frozen `customer_advance_source_type_chk` set (migration 20261005120000) — pinned equal to the database CHECK */
export const ADVANCE_SOURCE_TYPES = ['PAYMENT', 'OPENING', 'CREDIT_NOTE'] as const;
export type AdvanceSourceType = (typeof ADVANCE_SOURCE_TYPES)[number];

/**
 * Pagination convention of the per-customer rows — the SAME convention as the customer-account read model
 * (`customer-account-read.repository.ts`: `DEFAULT_LIST_LIMIT = 50`, `MAX_LIST_LIMIT = 200`, `INVALID_LIMIT`,
 * `INVALID_CURSOR`; module-private there, pinned equal to it by the Checkpoint E structural pins).
 */
export const LIABILITIES_REPORT_DEFAULT_LIMIT = 50;
export const LIABILITIES_REPORT_MAX_LIMIT = 200;

export const LIABILITIES_REPORT_NOTE =
  'Current customer liabilities at the snapshot instant asOf: customer advances (book liability, pending refund reservation, available balance) and unapplied customer receipts are two separate liabilities, each reconciled to its own general-ledger account and never netted. It is not sales, not receipts, not revenue and not settled money, and it is not a historical figure.';

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
export function parseLiabilitiesLimit(limit: unknown): number {
  if (limit === undefined) return LIABILITIES_REPORT_DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new DomainError('INVALID_LIMIT', 'limit must be a positive integer', 400);
  }
  return limit > LIABILITIES_REPORT_MAX_LIMIT ? LIABILITIES_REPORT_MAX_LIMIT : limit;
}

/** the cursor is the last emitted customerId — `undefined` → the first page; anything but a uuid → `400 INVALID_CURSOR` */
export function parseLiabilitiesCursor(cursor: unknown): string | null {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || !UUID_RE.test(cursor)) {
    throw new DomainError('INVALID_CURSOR', 'cursor is not a valid cursor', 400);
  }
  return cursor.toLowerCase();
}

/** one (source type) aggregate of advances — the components the SQL summed (exact bigint) */
export interface AdvanceCell {
  /** a plain string so an unknown / forbidden value can be represented and rejected */
  readonly sourceType: string;
  readonly count: number;
  readonly principal: bigint;
  /** Σ CustomerAdvanceApplication */
  readonly applied: bigint;
  /** Σ CustomerAdvanceRefundApplication (an ACTUAL refund) */
  readonly refunded: bigint;
  /** Σ entitlement reservation of a PENDING RefundAttempt */
  readonly reserved: bigint;
}
export interface AdvanceCustomerCell extends AdvanceCell {
  readonly customerId: string;
}

/** one aggregate of customer-attributable Payments — the components the SQL summed (exact bigint) */
export interface UnappliedCell {
  readonly paymentCount: number;
  /** payments that currently hold an unapplied remainder > 0 */
  readonly paymentCountWithUnapplied: number;
  readonly original: bigint;
  /** Σ PaymentAllocation */
  readonly allocated: bigint;
  /** Σ CustomerReceivablePaymentApplication */
  readonly receivableApplied: bigint;
  /** Σ CustomerAdvance(sourceType = PAYMENT, sourcePaymentId) */
  readonly converted: bigint;
}
export interface UnappliedCustomerCell extends UnappliedCell {
  readonly customerId: string;
}

export interface AdvanceFigures {
  readonly advanceCount: number;
  readonly originalAdvanceMinor: string;
  readonly appliedMinor: string;
  readonly actuallyRefundedMinor: string;
  readonly bookLiabilityMinor: string;
  readonly pendingRefundReservationMinor: string;
  readonly availableMinor: string;
}
export interface AdvanceSourceTypeRow extends AdvanceFigures {
  readonly sourceType: AdvanceSourceType;
}
export interface AdvanceReconciliation {
  readonly sourceBookLiabilityMinor: string;
  readonly glCustomerAdvancesLiabilityMinor: string;
  readonly differenceMinor: string;
  readonly reconciled: boolean;
}
export interface UnappliedFigures {
  readonly paymentCount: number;
  readonly paymentCountWithUnapplied: number;
  readonly originalReceiptMinor: string;
  readonly paymentAllocationMinor: string;
  readonly receivablePaymentApplicationMinor: string;
  /** Σ PaymentAllocation + Σ CustomerReceivablePaymentApplication */
  readonly allocatedToReceivablesMinor: string;
  readonly convertedToAdvanceMinor: string;
  readonly unappliedReceiptMinor: string;
}
export interface UnappliedReconciliation {
  readonly sourceUnappliedMinor: string;
  readonly glUnappliedReceiptsLiabilityMinor: string;
  readonly differenceMinor: string;
  readonly reconciled: boolean;
}

export interface AdvanceBlock extends AdvanceFigures {
  readonly bySourceType: readonly AdvanceSourceTypeRow[];
  readonly reconciliation: AdvanceReconciliation;
}
export interface UnappliedBlock extends UnappliedFigures {
  readonly reconciliation: UnappliedReconciliation;
}
export interface LiabilityBlocks {
  readonly note: string;
  readonly advances: AdvanceBlock;
  readonly unappliedReceipts: UnappliedBlock;
}
export interface LiabilityCustomerRow {
  readonly customerId: string;
  readonly advances: AdvanceFigures;
  readonly unappliedReceipts: UnappliedFigures;
}

const INTEGRITY_MESSAGE =
  'a customer advance or receipt is inconsistent with its own source documents — no report is returned';
const integrity = (): DomainError =>
  new DomainError('REPORT_LIABILITIES_SOURCE_INTEGRITY', INTEGRITY_MESSAGE, 500);

interface AdvanceSum {
  count: number;
  principal: bigint;
  applied: bigint;
  refunded: bigint;
  reserved: bigint;
  book: bigint;
  available: bigint;
}
const zeroAdvance = (): AdvanceSum => ({
  count: 0,
  principal: 0n,
  applied: 0n,
  refunded: 0n,
  reserved: 0n,
  book: 0n,
  available: 0n,
});

/** the frozen advance helper, with its `RangeError` mapped to the report's fail-closed domain error (non-disclosing) */
function addAdvance(into: AdvanceSum, cell: AdvanceCell): void {
  let balance: ReturnType<typeof computeAdvanceBalance>;
  try {
    balance = computeAdvanceBalance({
      principalMinor: cell.principal,
      appliedMinor: cell.applied,
      refundedMinor: cell.refunded,
      reservedMinor: cell.reserved,
    });
  } catch (e) {
    if (e instanceof RangeError) throw integrity();
    throw e;
  }
  // the helper tolerates an over-consumed (negative) state so a read model can REPORT it; a report fails closed
  if (balance.bookedRemainingMinor < 0n || balance.availableMinor < 0n) throw integrity();
  into.count += cell.count;
  into.principal += balance.principalMinor;
  into.applied += balance.appliedMinor;
  into.refunded += balance.refundedMinor;
  into.reserved += balance.reservedMinor;
  into.book += balance.bookedRemainingMinor;
  into.available += balance.availableMinor;
}

interface UnappliedSum {
  count: number;
  countWithUnapplied: number;
  original: bigint;
  allocated: bigint;
  receivableApplied: bigint;
  converted: bigint;
  unapplied: bigint;
}
const zeroUnapplied = (): UnappliedSum => ({
  count: 0,
  countWithUnapplied: 0,
  original: 0n,
  allocated: 0n,
  receivableApplied: 0n,
  converted: 0n,
  unapplied: 0n,
});

/** the frozen Payment-capacity helper, both draws on receivables in its first term (the DB's own 3-term formula) */
function addUnapplied(into: UnappliedSum, cell: UnappliedCell): void {
  let remaining: bigint;
  try {
    remaining = computePaymentConsumption({
      paymentAmountMinor: cell.original,
      allocatedToInvoicesMinor: cell.allocated + cell.receivableApplied,
      convertedToAdvanceMinor: cell.converted,
    }).remainingMinor;
  } catch (e) {
    if (e instanceof RangeError) throw integrity();
    throw e;
  }
  if (cell.allocated < 0n || cell.receivableApplied < 0n) throw integrity();
  into.count += cell.paymentCount;
  into.countWithUnapplied += cell.paymentCountWithUnapplied;
  into.original += cell.original;
  into.allocated += cell.allocated;
  into.receivableApplied += cell.receivableApplied;
  into.converted += cell.converted;
  into.unapplied += remaining;
}

function advanceFigures(sum: AdvanceSum): AdvanceFigures {
  return {
    advanceCount: sum.count,
    originalAdvanceMinor: minorUnitsToWire(sum.principal),
    appliedMinor: minorUnitsToWire(sum.applied),
    actuallyRefundedMinor: minorUnitsToWire(sum.refunded),
    bookLiabilityMinor: minorUnitsToWire(sum.book),
    pendingRefundReservationMinor: minorUnitsToWire(sum.reserved),
    availableMinor: minorUnitsToWire(sum.available),
  };
}

function unappliedFigures(sum: UnappliedSum): UnappliedFigures {
  return {
    paymentCount: sum.count,
    paymentCountWithUnapplied: sum.countWithUnapplied,
    originalReceiptMinor: minorUnitsToWire(sum.original),
    paymentAllocationMinor: minorUnitsToWire(sum.allocated),
    receivablePaymentApplicationMinor: minorUnitsToWire(sum.receivableApplied),
    allocatedToReceivablesMinor: minorUnitsToWire(sum.allocated + sum.receivableApplied),
    convertedToAdvanceMinor: minorUnitsToWire(sum.converted),
    unappliedReceiptMinor: minorUnitsToWire(sum.unapplied),
  };
}

/**
 * One scope's blocks (a branch, or the whole company) from its source cells and the TWO general-ledger nets
 * (credit − debit, a liability) of EXACTLY the authoritative journals of each account in the same scope.
 *
 * The two controls are INDEPENDENT: each difference is judged on its own, so an Advance difference of +X and an Unapplied
 * difference of −X can never net to a pass — either failing control fails the report closed
 * (`500 REPORT_LIABILITIES_GL_MISMATCH`, naming only the control). The pending reservation is never part of the GL figure.
 */
export function buildLiabilityBlocks(
  advanceCells: readonly AdvanceCell[],
  unappliedCells: readonly UnappliedCell[],
  glAdvancesNetMinor: bigint,
  glUnappliedNetMinor: bigint,
): LiabilityBlocks {
  const byType = new Map<AdvanceSourceType, AdvanceSum>(
    ADVANCE_SOURCE_TYPES.map((t) => [t, zeroAdvance()]),
  );
  const advTotal = zeroAdvance();
  for (const cell of advanceCells) {
    const slot = byType.get(cell.sourceType as AdvanceSourceType);
    if (slot === undefined) throw integrity(); // a closed set, never an "else PAYMENT"
    addAdvance(slot, cell);
    addAdvance(advTotal, cell);
  }
  const unTotal = zeroUnapplied();
  for (const cell of unappliedCells) addUnapplied(unTotal, cell);

  const advanceDifference = advTotal.book - glAdvancesNetMinor;
  const unappliedDifference = unTotal.unapplied - glUnappliedNetMinor;
  const failing = [
    ...(advanceDifference !== 0n ? ['customerAdvances'] : []),
    ...(unappliedDifference !== 0n ? ['unappliedReceipts'] : []),
  ];
  if (failing.length > 0) {
    throw new DomainError(
      'REPORT_LIABILITIES_GL_MISMATCH',
      `the current ${failing.join(' and ')} disagree with the general-ledger liability of their own journals — no report is returned`,
      500,
    );
  }
  return {
    note: LIABILITIES_REPORT_NOTE,
    advances: {
      ...advanceFigures(advTotal),
      bySourceType: ADVANCE_SOURCE_TYPES.map((t) => ({
        sourceType: t,
        ...advanceFigures(byType.get(t)!),
      })),
      reconciliation: {
        sourceBookLiabilityMinor: minorUnitsToWire(advTotal.book),
        glCustomerAdvancesLiabilityMinor: minorUnitsToWire(glAdvancesNetMinor),
        differenceMinor: minorUnitsToWire(advanceDifference),
        reconciled: true,
      },
    },
    unappliedReceipts: {
      ...unappliedFigures(unTotal),
      reconciliation: {
        sourceUnappliedMinor: minorUnitsToWire(unTotal.unapplied),
        glUnappliedReceiptsLiabilityMinor: minorUnitsToWire(glUnappliedNetMinor),
        differenceMinor: minorUnitsToWire(unappliedDifference),
        reconciled: true,
      },
    },
  };
}

/**
 * The per-customer rows of one page, from the advance cells (customer, source type) and the unapplied cells (customer)
 * the SQL summed — in customerId order, each customer carrying BOTH liabilities (zero-filled where it holds only one).
 * Financial identifiers only: no name, phone, e-mail, address or note.
 */
export function buildCustomerLiabilityRows(
  advanceCells: readonly AdvanceCustomerCell[],
  unappliedCells: readonly UnappliedCustomerCell[],
): LiabilityCustomerRow[] {
  const advances = new Map<string, AdvanceSum>();
  for (const cell of advanceCells) {
    let sum = advances.get(cell.customerId);
    if (sum === undefined) {
      sum = zeroAdvance();
      advances.set(cell.customerId, sum);
    }
    addAdvance(sum, cell);
  }
  const unapplied = new Map<string, UnappliedSum>();
  for (const cell of unappliedCells) {
    let sum = unapplied.get(cell.customerId);
    if (sum === undefined) {
      sum = zeroUnapplied();
      unapplied.set(cell.customerId, sum);
    }
    addUnapplied(sum, cell);
  }
  const ids = [...new Set([...advances.keys(), ...unapplied.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return ids.map((customerId) => ({
    customerId,
    advances: advanceFigures(advances.get(customerId) ?? zeroAdvance()),
    unappliedReceipts: unappliedFigures(unapplied.get(customerId) ?? zeroUnapplied()),
  }));
}
