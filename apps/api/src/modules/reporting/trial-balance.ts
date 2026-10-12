import { DomainError } from '../../common/errors/domain-error.js';
import { minorUnitsToWire } from './report-money.js';

/**
 * Task 3b.10 Checkpoint A — the PURE Trial Balance algorithm (owner rulings OD-2, A, D).
 * NO DB, NO HTTP, NO Prisma types, NO clock. Exact `bigint` minor units only.
 *
 * A Trial Balance is the complete company general ledger: the caller hands this module
 * the per-account SUMS of every SEALED journal line (it never sees a `sourceKind`, so an
 * unknown or future source kind is part of the report by construction). For each account:
 *
 *   openingNet  = Σ debit(postingDate <  from) − Σ credit(postingDate <  from)
 *   periodDebit = Σ debit(from ≤ postingDate ≤ to)
 *   periodCredit= Σ credit(from ≤ postingDate ≤ to)
 *   closingNet  = openingNet + periodDebit − periodCredit
 *
 * `openingNet` / `closingNet` are signed ONLY internally: a non-negative net is placed on
 * the debit side, a negative net on the credit side (as its absolute value) — so the wire
 * carries two non-negative columns per balance and no sign. Period debits and credits are
 * returned as they are (never netted).
 *
 * Control totals — the six column sums — must satisfy
 *   Σ opening debit == Σ opening credit
 *   Σ period  debit == Σ period  credit
 *   Σ closing debit == Σ closing credit
 * which holds for any complete set of balanced sealed entries. If it does not, the ledger
 * itself is inconsistent and the report FAILS CLOSED ({@link assertTrialBalanceBalanced}) —
 * an unbalanced Trial Balance is never returned.
 *
 * Output money is a decimal STRING of exact minor units; the report's currency code and
 * exponent travel beside it (single company currency — no FX, no rounding).
 */

/** One account's raw sealed sums, exact minor units. Every value is `>= 0`. */
export interface TrialBalanceAccountAggregate {
  readonly accountId: string;
  readonly accountKey: string;
  readonly category: string;
  readonly displayCode: string;
  readonly displayName: string;
  readonly openingDebitMinor: bigint;
  readonly openingCreditMinor: bigint;
  readonly periodDebitMinor: bigint;
  readonly periodCreditMinor: bigint;
}

/** One account row on the wire (all amounts decimal strings of minor units). */
export interface TrialBalanceAccountRow {
  readonly accountId: string;
  readonly accountKey: string;
  readonly category: string;
  readonly displayCode: string;
  readonly displayName: string;
  readonly openingDebitMinor: string;
  readonly openingCreditMinor: string;
  readonly periodDebitMinor: string;
  readonly periodCreditMinor: string;
  readonly closingDebitMinor: string;
  readonly closingCreditMinor: string;
}

export interface TrialBalanceTotals {
  readonly totalOpeningDebitMinor: string;
  readonly totalOpeningCreditMinor: string;
  readonly totalPeriodDebitMinor: string;
  readonly totalPeriodCreditMinor: string;
  readonly totalClosingDebitMinor: string;
  readonly totalClosingCreditMinor: string;
}

/** The balance side a signed net lands on. */
export function placeNetOnSide(net: bigint): { debit: bigint; credit: bigint } {
  return net >= 0n ? { debit: net, credit: 0n } : { debit: 0n, credit: -net };
}

function assertNonNegative(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError(`${label} must be an exact bigint >= 0 (got ${String(value)})`);
  }
}

interface InternalTotals {
  openingDebit: bigint;
  openingCredit: bigint;
  periodDebit: bigint;
  periodCredit: bigint;
  closingDebit: bigint;
  closingCredit: bigint;
}

/** Build the account rows (in the order given) and the control totals, then enforce the invariant. */
export function buildTrialBalance(aggregates: readonly TrialBalanceAccountAggregate[]): {
  accounts: TrialBalanceAccountRow[];
  totals: TrialBalanceTotals;
} {
  const sum: InternalTotals = {
    openingDebit: 0n,
    openingCredit: 0n,
    periodDebit: 0n,
    periodCredit: 0n,
    closingDebit: 0n,
    closingCredit: 0n,
  };

  const accounts = aggregates.map((a): TrialBalanceAccountRow => {
    assertNonNegative(a.openingDebitMinor, 'openingDebitMinor');
    assertNonNegative(a.openingCreditMinor, 'openingCreditMinor');
    assertNonNegative(a.periodDebitMinor, 'periodDebitMinor');
    assertNonNegative(a.periodCreditMinor, 'periodCreditMinor');

    const openingNet = a.openingDebitMinor - a.openingCreditMinor;
    const closingNet = openingNet + a.periodDebitMinor - a.periodCreditMinor;
    const opening = placeNetOnSide(openingNet);
    const closing = placeNetOnSide(closingNet);

    sum.openingDebit += opening.debit;
    sum.openingCredit += opening.credit;
    sum.periodDebit += a.periodDebitMinor;
    sum.periodCredit += a.periodCreditMinor;
    sum.closingDebit += closing.debit;
    sum.closingCredit += closing.credit;

    return {
      accountId: a.accountId,
      accountKey: a.accountKey,
      category: a.category,
      displayCode: a.displayCode,
      displayName: a.displayName,
      openingDebitMinor: minorUnitsToWire(opening.debit),
      openingCreditMinor: minorUnitsToWire(opening.credit),
      periodDebitMinor: minorUnitsToWire(a.periodDebitMinor),
      periodCreditMinor: minorUnitsToWire(a.periodCreditMinor),
      closingDebitMinor: minorUnitsToWire(closing.debit),
      closingCreditMinor: minorUnitsToWire(closing.credit),
    };
  });

  assertTrialBalanceBalanced(sum);

  return {
    accounts,
    totals: {
      totalOpeningDebitMinor: minorUnitsToWire(sum.openingDebit),
      totalOpeningCreditMinor: minorUnitsToWire(sum.openingCredit),
      totalPeriodDebitMinor: minorUnitsToWire(sum.periodDebit),
      totalPeriodCreditMinor: minorUnitsToWire(sum.periodCredit),
      totalClosingDebitMinor: minorUnitsToWire(sum.closingDebit),
      totalClosingCreditMinor: minorUnitsToWire(sum.closingCredit),
    },
  };
}

/**
 * The hard invariant. A violation means the sealed general ledger is not balanced for
 * the requested window — a data-integrity failure, never something to paper over: the
 * report fails closed with a stable domain error (HTTP 500, like every other financial
 * invariant violation in this code base) and returns no figures.
 */
export function assertTrialBalanceBalanced(t: InternalTotals): void {
  const broken: string[] = [];
  if (t.openingDebit !== t.openingCredit) broken.push('opening');
  if (t.periodDebit !== t.periodCredit) broken.push('period');
  if (t.closingDebit !== t.closingCredit) broken.push('closing');
  if (broken.length > 0) {
    throw new DomainError(
      'REPORT_TRIAL_BALANCE_UNBALANCED',
      `the sealed general ledger is not balanced for the requested window (${broken.join(', ')}) — no trial balance is returned`,
      500,
    );
  }
}
