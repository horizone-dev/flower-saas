import { DomainError } from '../../common/errors/domain-error.js';
import { isTenderMethod, TENDER_METHODS, type TenderMethod } from '../payments/tender.js';
import { resolveReceiptAccountKeyForTender } from '../payments/tender-account-mapping.js';
import { minorUnitsToWire } from './report-money.js';
import { TENDER_ACCOUNT_KEYS, TENDER_SOURCE_KINDS } from './tender-totals-report.sql.js';

/**
 * Task 3b.10 Checkpoint C — the PURE Tender Totals arithmetic. NO DB, NO HTTP, NO Prisma types, NO clock.
 * Exact `bigint` minor units only.
 *
 * The report is SOURCE-DERIVED from the two frozen money-movement documents whose sealed journal falls in the
 * period — recorded `Payment` rows (receipts) and actual `Refund` rows — and it presents them SEPARATELY:
 *
 *   receipts   how much was recorded, per tender method (the full frozen `TenderMethod` vocabulary, zero-filled,
 *              one row per method — methods are NEVER merged because they share a GL account). A Payment is a
 *              receipt once: a PaymentAllocation, a CustomerAdvance, a settlement or a provider attempt is never
 *              a second receipt, and `CREDIT` is never a tender.
 *   refunds    the actual Refund rows only (never a CreditNote, never a pending / failed RefundAttempt), per method.
 *   netTenderMovement
 *              the one EXPLICIT net: receipts − refunds, signed, in total and per method. Receipts and refunds are
 *              in the same single company currency and the same frozen method vocabulary, so the subtraction is
 *              exact. It is TENDER MOVEMENT only — see {@link TENDER_NET_NOTE}.
 *   reconciliation
 *              the source-derived figures against the GL lines of EXACTLY those journals, at the narrowest truthful
 *              accounting grouping: methods that post to one account share ONE control, never a whole-account balance.
 *              Any difference fails the report closed.
 *
 * Out of scope here, deliberately: AR / CustomerAdvance / unapplied-receipt BALANCES, settlement batches, provider
 * attempt status, sales revenue, CreditNote revenue, X / Z shifts — a Payment is never revenue and no figure claims
 * to measure more than its own source document states (CLAUDE.md rule 21).
 */

export const TENDER_NET_NOTE =
  'Tender movement only: recorded receipts minus actual refunds, by accounting postingDate. It is not revenue, not net sales, not a financial result of any kind and not settled money.';

export type TenderStream = 'CUSTOMER' | 'ANONYMOUS';

/** one (branch, stream, method) receipt aggregate (exact bigint) */
export interface TenderReceiptRow {
  readonly stream: TenderStream;
  /** a plain string so an unknown / forbidden value can be represented and rejected */
  readonly method: string;
  readonly count: number;
  readonly total: bigint;
}

/** one (branch, method, credit account) refund aggregate (exact bigint) */
export interface TenderRefundRow {
  readonly method: string;
  /** the frozen credit account of the refund's own journal; `null` = no mapping exists (fails closed) */
  readonly accountKey: string | null;
  readonly count: number;
  readonly total: bigint;
}

export interface TenderBranchAggregate {
  readonly branchId: string;
  readonly receipts: readonly TenderReceiptRow[];
  readonly refunds: readonly TenderRefundRow[];
}

export interface TenderGlAggregate {
  readonly branchId: string;
  readonly sourceKind: string;
  readonly accountKey: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface ReconciliationControl {
  readonly sourceMinor: string;
  readonly glMinor: string;
  readonly differenceMinor: string;
  readonly reconciled: boolean;
}

export interface TenderTotalsBlocks {
  readonly receipts: {
    readonly receiptCount: number;
    readonly receiptTotalMinor: string;
    readonly byMethod: readonly {
      readonly method: TenderMethod;
      readonly receiptCount: number;
      readonly receiptTotalMinor: string;
    }[];
  };
  readonly refunds: {
    readonly refundCount: number;
    readonly refundTotalMinor: string;
    readonly byMethod: readonly {
      readonly method: TenderMethod;
      readonly refundCount: number;
      readonly refundTotalMinor: string;
    }[];
  };
  readonly netTenderMovement: {
    readonly note: string;
    readonly netMovementMinor: string;
    readonly byMethod: readonly {
      readonly method: TenderMethod;
      readonly netMovementMinor: string;
    }[];
  };
  readonly reconciliation: {
    readonly reconciled: boolean;
    readonly receipts: {
      readonly cashOnHand: ReconciliationControl;
      readonly bank: ReconciliationControl;
      readonly paymentClearing: ReconciliationControl;
      readonly unappliedReceipts: ReconciliationControl;
    };
    readonly refunds: {
      readonly cashOnHand: ReconciliationControl;
      readonly bank: ReconciliationControl;
      readonly paymentClearing: ReconciliationControl;
      readonly customerAdvances: ReconciliationControl;
    };
  };
}

/** Add branch aggregates together (the company aggregate is the exact sum of its branches). */
export function sumTenderAggregates(
  branchId: string,
  rows: readonly TenderBranchAggregate[],
): TenderBranchAggregate {
  return {
    branchId,
    receipts: rows.flatMap((r) => r.receipts),
    refunds: rows.flatMap((r) => r.refunds),
  };
}

function assertExactCount(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be an integer >= 0 (got ${String(value)})`);
  }
}

function assertNonNegative(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError(`${label} must be an exact bigint >= 0 (got ${String(value)})`);
  }
}

function control(source: bigint, gl: bigint): ReconciliationControl {
  const difference = source - gl;
  return {
    sourceMinor: minorUnitsToWire(source),
    glMinor: minorUnitsToWire(gl),
    differenceMinor: minorUnitsToWire(difference),
    reconciled: difference === 0n,
  };
}

/** Σ GL (debit − credit) or (credit − debit) of one account over the given source kinds. */
function glNet(
  gl: readonly TenderGlAggregate[],
  kinds: readonly string[],
  accountKey: string,
  side: 'credit' | 'debit',
): bigint {
  let net = 0n;
  for (const row of gl) {
    if (row.accountKey !== accountKey || !kinds.includes(row.sourceKind)) continue;
    net += side === 'credit' ? row.credit - row.debit : row.debit - row.credit;
  }
  return net;
}

const RECEIPT_KINDS: readonly string[] = [
  TENDER_SOURCE_KINDS.customerReceipt,
  TENDER_SOURCE_KINDS.walkInSale,
];
const REFUND_KINDS: readonly string[] = [TENDER_SOURCE_KINDS.refund];
const CUSTOMER_RECEIPT_KINDS: readonly string[] = [TENDER_SOURCE_KINDS.customerReceipt];

function requireMethod(method: string, label: string): TenderMethod {
  if (typeof method !== 'string' || !isTenderMethod(method)) {
    throw new RangeError(`${label}: "${String(method)}" is not a frozen tender method`);
  }
  return method;
}

/**
 * Build one scope's blocks (a branch, or the whole company) from its aggregate and its GL rows — and enforce the
 * reconciliation: any difference between a source-derived figure and the GL lines of those same journals fails the
 * report closed (`500 REPORT_TENDER_GL_MISMATCH`).
 */
export function buildTenderTotalsBlocks(
  aggregate: TenderBranchAggregate,
  gl: readonly TenderGlAggregate[],
): TenderTotalsBlocks {
  // ── receipts, per frozen method (zero-filled, one row per method, never merged) ─────────────
  const receiptByMethod = new Map<TenderMethod, { count: number; total: bigint }>(
    TENDER_METHODS.map((m) => [m, { count: 0, total: 0n }]),
  );
  let customerReceiptTotal = 0n;
  for (const r of aggregate.receipts) {
    const method = requireMethod(r.method, 'receipt');
    assertExactCount(r.count, 'receipt count');
    assertNonNegative(r.total, 'receipt total');
    const slot = receiptByMethod.get(method)!;
    slot.count += r.count;
    slot.total += r.total;
    if (r.stream === 'CUSTOMER') customerReceiptTotal += r.total;
  }

  // ── refunds, per frozen method, and per frozen credit account ───────────────────────────────
  const refundByMethod = new Map<TenderMethod, { count: number; total: bigint }>(
    TENDER_METHODS.map((m) => [m, { count: 0, total: 0n }]),
  );
  const refundByAccount = new Map<string, bigint>();
  for (const r of aggregate.refunds) {
    const method = requireMethod(r.method, 'refund');
    assertExactCount(r.count, 'refund count');
    assertNonNegative(r.total, 'refund total');
    if (r.accountKey === null) {
      throw new DomainError(
        'REPORT_TENDER_SOURCE_INTEGRITY',
        'a refund has no frozen credit-account mapping — no report is returned',
        500,
      );
    }
    const slot = refundByMethod.get(method)!;
    slot.count += r.count;
    slot.total += r.total;
    refundByAccount.set(r.accountKey, (refundByAccount.get(r.accountKey) ?? 0n) + r.total);
  }

  const receiptRows = TENDER_METHODS.map((method) => ({
    method,
    receiptCount: receiptByMethod.get(method)!.count,
    receiptTotalMinor: minorUnitsToWire(receiptByMethod.get(method)!.total),
  }));
  const refundRows = TENDER_METHODS.map((method) => ({
    method,
    refundCount: refundByMethod.get(method)!.count,
    refundTotalMinor: minorUnitsToWire(refundByMethod.get(method)!.total),
  }));
  const netRows = TENDER_METHODS.map((method) => ({
    method,
    netMovementMinor: minorUnitsToWire(
      receiptByMethod.get(method)!.total - refundByMethod.get(method)!.total,
    ),
  }));
  const receiptCount = TENDER_METHODS.reduce((n, m) => n + receiptByMethod.get(m)!.count, 0);
  const receiptTotal = TENDER_METHODS.reduce((n, m) => n + receiptByMethod.get(m)!.total, 0n);
  const refundCount = TENDER_METHODS.reduce((n, m) => n + refundByMethod.get(m)!.count, 0);
  const refundTotal = TENDER_METHODS.reduce((n, m) => n + refundByMethod.get(m)!.total, 0n);

  // ── the controls: one per frozen account, grouped from the frozen mapping (never repeated) ───
  const receiptsToAccount = (accountKey: string): bigint =>
    TENDER_METHODS.filter((m) => resolveReceiptAccountKeyForTender(m) === accountKey).reduce(
      (n, m) => n + receiptByMethod.get(m)!.total,
      0n,
    );
  const receiptDebit = (accountKey: string): bigint =>
    glNet(gl, RECEIPT_KINDS, accountKey, 'debit');
  const refundCredit = (accountKey: string): bigint =>
    glNet(gl, REFUND_KINDS, accountKey, 'credit');

  const receiptControls = {
    cashOnHand: control(
      receiptsToAccount(TENDER_ACCOUNT_KEYS.cashOnHand),
      receiptDebit(TENDER_ACCOUNT_KEYS.cashOnHand),
    ),
    bank: control(
      receiptsToAccount(TENDER_ACCOUNT_KEYS.bank),
      receiptDebit(TENDER_ACCOUNT_KEYS.bank),
    ),
    paymentClearing: control(
      receiptsToAccount(TENDER_ACCOUNT_KEYS.paymentClearing),
      receiptDebit(TENDER_ACCOUNT_KEYS.paymentClearing),
    ),
    unappliedReceipts: control(
      customerReceiptTotal,
      glNet(gl, CUSTOMER_RECEIPT_KINDS, TENDER_ACCOUNT_KEYS.unappliedReceipts, 'credit'),
    ),
  };
  const refundControls = {
    cashOnHand: control(
      refundByAccount.get(TENDER_ACCOUNT_KEYS.cashOnHand) ?? 0n,
      refundCredit(TENDER_ACCOUNT_KEYS.cashOnHand),
    ),
    bank: control(
      refundByAccount.get(TENDER_ACCOUNT_KEYS.bank) ?? 0n,
      refundCredit(TENDER_ACCOUNT_KEYS.bank),
    ),
    paymentClearing: control(
      refundByAccount.get(TENDER_ACCOUNT_KEYS.paymentClearing) ?? 0n,
      refundCredit(TENDER_ACCOUNT_KEYS.paymentClearing),
    ),
    customerAdvances: control(
      refundTotal,
      glNet(gl, REFUND_KINDS, TENDER_ACCOUNT_KEYS.customerAdvances, 'debit'),
    ),
  };
  // an account the frozen refund mapping never produces cannot be reconciled — fail closed
  for (const accountKey of refundByAccount.keys()) {
    if (
      accountKey !== TENDER_ACCOUNT_KEYS.cashOnHand &&
      accountKey !== TENDER_ACCOUNT_KEYS.bank &&
      accountKey !== TENDER_ACCOUNT_KEYS.paymentClearing
    ) {
      throw new DomainError(
        'REPORT_TENDER_SOURCE_INTEGRITY',
        'a refund names a credit account outside the frozen mapping — no report is returned',
        500,
      );
    }
  }
  const controls = [...Object.values(receiptControls), ...Object.values(refundControls)];
  if (controls.some((c) => !c.reconciled)) {
    throw new DomainError(
      'REPORT_TENDER_GL_MISMATCH',
      'a tender source document disagrees with the general-ledger lines of its own journal — no report is returned',
      500,
    );
  }

  return {
    receipts: {
      receiptCount,
      receiptTotalMinor: minorUnitsToWire(receiptTotal),
      byMethod: receiptRows,
    },
    refunds: {
      refundCount,
      refundTotalMinor: minorUnitsToWire(refundTotal),
      byMethod: refundRows,
    },
    netTenderMovement: {
      note: TENDER_NET_NOTE,
      netMovementMinor: minorUnitsToWire(receiptTotal - refundTotal),
      byMethod: netRows,
    },
    reconciliation: {
      reconciled: true,
      receipts: receiptControls,
      refunds: refundControls,
    },
  };
}
