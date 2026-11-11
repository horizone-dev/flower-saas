import { currencyExponent, isKnownCurrency } from '@flower/money';
import { isFiscalDate } from '@flower/shared-types';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertValidIanaTimezone } from '../accounting/posting-date.js';
import { REFUND_METHODS, type RefundMethod } from './anonymous-credit-note-plan.js';

/**
 * Phase 3B closure — F-1 / F-2 (RB-1 reporting supplement). The PURE core of the anonymous credit-note SUMMARY: the period contract, the
 * parsing of the one database statement's JSON, and the assembly of the response with its LEDGER RECONCILIATION. No database, no clock, no
 * float, no framework: exact `bigint` minor units only.
 *
 * WHY A SUPPLEMENT: the frozen Sales and Tender Totals reports (Task 3b.10 B / C, owner rulings 3b.10-SR / TT) select ONLY their own source
 * kinds, by contract, and are byte-pinned. Anonymous credit notes and their refunds are journalled under two NEW source kinds
 * (`anonymous_credit_note`, `anonymous_credit_note_refund`) that those reports never see — so their figures exclude anonymous credits while the
 * general ledger includes them. This summary is the complete, ledger-reconciled account of exactly those two kinds, plus the ADJUSTMENTS to
 * subtract from the frozen reports' figures (no overlap, hence no double counting). The frozen reports are NOT changed here; the exact
 * amendment that would fold this into them is prepared for owner approval (PHASE-3B-CLOSURE-EVIDENCE.md).
 *
 * Period authority = the sealed journal's `postingDate` for every ledger figure (as in the frozen reports). Document figures use the note's
 * `accountingDate` (which IS its issuance journal's posting date). A cash / bank refund belongs to the period of its EXECUTION JOURNAL; a
 * manual card / other refund posts nothing, so it belongs to the company-timezone civil date of its attestation.
 */

export const SUMMARY_MAX_DAYS = 90n;
/** v1 density limit: notes issued in one period (company or branch); above it the summary is rejected, never truncated */
export const SUMMARY_MAX_NOTES = 25_000;

export const REFUND_STATUSES = ['PENDING', 'EXECUTED', 'FAILED'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const AGEING_BUCKETS = ['0-1 days', '2-7 days', '8-30 days', '31+ days'] as const;

// ───────────────────────── the period ─────────────────────────

/** days since 0000-03-01 of a validated civil date — the standard days-from-civil algorithm, pure integer arithmetic */
function civilDay(date: string): bigint {
  const y0 = BigInt(date.slice(0, 4));
  const m = BigInt(date.slice(5, 7));
  const d = BigInt(date.slice(8, 10));
  const y = m <= 2n ? y0 - 1n : y0;
  const era = y / 400n;
  const yoe = y - era * 400n;
  const doy = (153n * (m > 2n ? m - 3n : m + 9n) + 2n) / 5n + d - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146097n + doe;
}

function requireCivilDate(field: 'from' | 'to', value: unknown): string {
  if (typeof value !== 'string' || !isFiscalDate(value) || value.startsWith('0000-')) {
    throw new DomainError(
      'INVALID_DATE',
      `"${field}" must be a civil calendar date in YYYY-MM-DD form (no time, no timezone)`,
      400,
      [{ field, issue: 'not a civil YYYY-MM-DD date' }],
    );
  }
  return value;
}

/** a civil period, both bounds inclusive, at most 90 days — the same contract as the frozen Sales report */
export function parseSummaryPeriod(input: { from?: unknown; to?: unknown }): {
  from: string;
  to: string;
} {
  const from = requireCivilDate('from', input.from);
  const to = requireCivilDate('to', input.to);
  if (from > to) throw new DomainError('INVALID_DATE_RANGE', '"from" must not be after "to"', 400);
  if (civilDay(to) - civilDay(from) + 1n > SUMMARY_MAX_DAYS) {
    throw new DomainError(
      'REPORT_RANGE_TOO_LARGE',
      `a period may span at most ${SUMMARY_MAX_DAYS} calendar days (both bounds inclusive)`,
      400,
      [{ field: 'period', issue: `longer than ${SUMMARY_MAX_DAYS} days` }],
    );
  }
  return { from, to };
}

/** strict query: exactly `from` and `to` — anything else is refused, so a client never believes a filter was applied that was not */
export function summaryQuery(raw: unknown): { from: unknown; to: unknown } {
  const q = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(q)) {
    if (k !== 'from' && k !== 'to')
      throw new DomainError('VALIDATION_FAILED', 'unsupported query parameter', 400);
  }
  return { from: q['from'], to: q['to'] };
}

// ───────────────────────── exact money ─────────────────────────

const INTEGER_TEXT = /^-?\d+$/;
export function minor(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !INTEGER_TEXT.test(value)) {
    throw new DomainError(
      'REPORT_DATA_INVALID',
      `the anonymous credit-note summary read a non-integer value for ${label}`,
      500,
    );
  }
  return BigInt(value);
}
const count = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DomainError(
      'REPORT_DATA_INVALID',
      `the anonymous credit-note summary read an invalid count for ${label}`,
      500,
    );
  }
  return value;
};

// ───────────────────────── the database statement's JSON ─────────────────────────

export interface SummaryJson {
  readonly company: { defaultCurrency: string | null; accountingTimezone: string | null } | null;
  readonly candidateNotes: number;
  readonly creditNotes: { count: number; total: string; tax: string };
  readonly cohort: readonly { method: string; status: string; count: number; total: string }[];
  readonly executedEvent: readonly { method: string; count: number; total: string }[];
  readonly pendingAgeing: readonly { bucket: string; count: number; total: string }[];
  readonly atPeriodEnd: { pendingCount: number; pendingTotal: string };
  readonly gl: readonly { key: string; kind: string; debit: string; credit: string }[];
  readonly execJournalInPeriod: readonly { method: string; count: number; total: string }[];
  readonly integrity: {
    notesWithoutIssuanceJournalCount: number;
    notesWithoutIssuanceJournalTotal: string;
    executedCashBankWithoutJournalCount: number;
    executedCashBankWithoutJournalTotal: string;
    orphanJournals: number;
  };
  readonly clearing: { issuedToDate: string; executedToDate: string; glToDate: string };
}

// ───────────────────────── the response ─────────────────────────

export interface Check {
  readonly sourceMinor: string;
  readonly glMinor: string;
  readonly differenceMinor: string;
  readonly reconciled: boolean;
}
export interface Counted {
  readonly count: number;
  readonly totalMinor: string;
}

export interface AnonymousCreditNoteSummary {
  readonly companyId: string;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly accountingTimezone: string;
  readonly from: string;
  readonly to: string;
  readonly scope: { readonly level: 'COMPANY' | 'BRANCH'; readonly branchId: string | null };
  readonly notice: string;
  readonly creditNotes: {
    readonly count: number;
    readonly creditedNetExTaxMinor: string;
    readonly creditedTaxMinor: string;
    readonly creditedTotalMinor: string;
  };
  /** the refund lines of the notes ISSUED in the period, by their CURRENT status (a cohort view) */
  readonly refundsOfNotesIssuedInPeriod: {
    readonly issued: Counted;
    readonly pending: Counted;
    readonly executed: Counted;
    readonly failed: Counted;
    /** credit still owed: Σ note totals − Σ (pending + executed) lines — what a failed, unreplaced line leaves */
    readonly unallocatedMinor: string;
    readonly byMethod: readonly {
      readonly method: RefundMethod;
      readonly issued: Counted;
      readonly pending: Counted;
      readonly executed: Counted;
      readonly failed: Counted;
    }[];
  };
  /** refunds whose EXECUTION falls in the period (the cash-out / attestation event lens) */
  readonly refundsExecutedInPeriod: {
    readonly count: number;
    readonly totalMinor: string;
    readonly byMethod: readonly { method: RefundMethod; count: number; totalMinor: string }[];
  };
  readonly pendingRefunds: {
    /** refund lines of notes issued up to `to` that were still unresolved at the END of `to` (company-timezone civil date) */
    readonly atPeriodEnd: Counted;
    /** lines PENDING right now (read time), by age since issue */
    readonly ageingNow: readonly { bucket: string; count: number; totalMinor: string }[];
  };
  /** SUBTRACT these from the frozen reports' figures for the same period and scope — the frozen reports never include them */
  readonly adjustmentsToFrozenReports: {
    readonly sales: {
      readonly creditNoteCount: number;
      readonly netSalesExTaxMinor: string;
      readonly outputTaxMinor: string;
      readonly totalMinor: string;
    };
    readonly tender: {
      readonly executedRefundsMinor: string;
      readonly byMethod: readonly { method: RefundMethod; executedRefundsMinor: string }[];
    };
  };
  readonly reconciliation: {
    /** true ONLY if every ledger check and every integrity count agree; never true when a figure disagrees with the ledger */
    readonly reconciled: boolean;
    readonly ledger: {
      readonly revenueSalesReversal: Check;
      readonly outputTaxReversal: Check;
      readonly paymentClearingIssuance: Check;
      readonly paymentClearingExecution: Check;
      readonly cashOnHandPaidOut: Check;
      readonly bankPaidOut: Check;
      /** an account other than the five frozen ones appeared on an anonymous journal */
      readonly unexpectedAccounts: readonly string[];
    };
    readonly integrity: {
      readonly notesWithoutIssuanceJournal: Counted;
      readonly executedCashBankWithoutJournal: Counted;
      readonly journalsWithoutSource: number;
    };
    /** cumulative to the end of the period: the in-flight refund balance the documents imply vs the ledger's PAYMENT_CLEARING effect */
    readonly paymentClearingAtPeriodEnd: Check;
  };
}

const EXPECTED_ACCOUNTS = new Set([
  'REVENUE.SALES',
  'LIABILITY.TAX_PAYABLE',
  'ASSET.PAYMENT_CLEARING',
  'ASSET.CASH_ON_HAND',
  'ASSET.BANK',
]);

export const SUMMARY_NOTICE =
  'The frozen Sales report and the frozen Tender Totals report do NOT include anonymous credit notes or their refunds. ' +
  'Subtract adjustmentsToFrozenReports from their figures for the same period and scope; this summary reconciles those adjustments to the general ledger.';

const check = (source: bigint, gl: bigint): Check => ({
  sourceMinor: source.toString(),
  glMinor: gl.toString(),
  differenceMinor: (source - gl).toString(),
  reconciled: source === gl,
});

export function resolveCompany(row: SummaryJson['company']): {
  currencyCode: string;
  currencyExponent: number;
  accountingTimezone: string;
} {
  const bad = (m: string): never => {
    throw new DomainError('REPORT_COMPANY_NOT_CONFIGURED', m, 409);
  };
  if (row === null) return bad('the company has no accounting configuration');
  if (!row.defaultCurrency || !isKnownCurrency(row.defaultCurrency))
    return bad('the company has no supported accounting currency');
  if (!row.accountingTimezone) return bad('the company has no accounting timezone');
  try {
    assertValidIanaTimezone(row.accountingTimezone);
  } catch {
    return bad("the company's accounting timezone is not a valid IANA timezone");
  }
  return {
    currencyCode: row.defaultCurrency,
    currencyExponent: currencyExponent(row.defaultCurrency),
    accountingTimezone: row.accountingTimezone,
  };
}

export function buildSummary(
  json: SummaryJson,
  header: {
    companyId: string;
    branchId: string | null;
    from: string;
    to: string;
  },
): AnonymousCreditNoteSummary {
  const company = resolveCompany(json.company);
  const noteTotal = minor(json.creditNotes.total, 'creditNotes.total');
  const noteTax = minor(json.creditNotes.tax, 'creditNotes.tax');
  if (noteTax > noteTotal || noteTax < 0n)
    throw new DomainError('REPORT_DATA_INVALID', 'a credit-note tax total exceeds its total', 500);
  const noteNet = noteTotal - noteTax;

  // cohort: method × status
  const cell = (
    method: RefundMethod | null,
    status: RefundStatus | null,
  ): { c: number; t: bigint } => {
    let c = 0;
    let t = 0n;
    for (const r of json.cohort) {
      if ((method === null || r.method === method) && (status === null || r.status === status)) {
        c += count(r.count, 'cohort.count');
        t += minor(r.total, 'cohort.total');
      }
    }
    return { c, t };
  };
  const counted = (x: { c: number; t: bigint }): Counted => ({
    count: x.c,
    totalMinor: x.t.toString(),
  });
  for (const r of json.cohort) {
    if (
      !(REFUND_METHODS as readonly string[]).includes(r.method) ||
      !(REFUND_STATUSES as readonly string[]).includes(r.status)
    )
      throw new DomainError(
        'REPORT_DATA_INVALID',
        'an unknown refund method or status was read',
        500,
      );
  }
  const nonFailed = cell(null, 'PENDING').t + cell(null, 'EXECUTED').t;

  const execByMethod = REFUND_METHODS.map((m) => {
    const rows = json.executedEvent.filter((r) => r.method === m);
    return {
      method: m,
      count: rows.reduce((a, r) => a + count(r.count, 'executedEvent.count'), 0),
      total: rows.reduce((a, r) => a + minor(r.total, 'executedEvent.total'), 0n),
    };
  });
  const execTotal = execByMethod.reduce((a, r) => a + r.total, 0n);

  // ledger checks (period)
  const glNet = (key: string, kind: string, side: 'debit' | 'credit'): bigint =>
    json.gl
      .filter((g) => g.key === key && g.kind === kind)
      .reduce(
        (a, g) =>
          a +
          (side === 'debit'
            ? minor(g.debit, 'gl.debit') - minor(g.credit, 'gl.credit')
            : minor(g.credit, 'gl.credit') - minor(g.debit, 'gl.debit')),
        0n,
      );
  const execJ = (method: string): bigint =>
    json.execJournalInPeriod
      .filter((r) => r.method === method)
      .reduce((a, r) => a + minor(r.total, 'execJournalInPeriod.total'), 0n);
  const execJTotal = execJ('CASH') + execJ('BANK_TRANSFER');
  const NOTE = 'anonymous_credit_note';
  const REFUND = 'anonymous_credit_note_refund';

  const unexpected = [...new Set(json.gl.map((g) => g.key))]
    .filter((k) => !EXPECTED_ACCOUNTS.has(k))
    .sort();
  const ledger = {
    revenueSalesReversal: check(noteNet, glNet('REVENUE.SALES', NOTE, 'debit')),
    outputTaxReversal: check(noteTax, glNet('LIABILITY.TAX_PAYABLE', NOTE, 'debit')),
    paymentClearingIssuance: check(noteTotal, glNet('ASSET.PAYMENT_CLEARING', NOTE, 'credit')),
    paymentClearingExecution: check(execJTotal, glNet('ASSET.PAYMENT_CLEARING', REFUND, 'debit')),
    cashOnHandPaidOut: check(execJ('CASH'), glNet('ASSET.CASH_ON_HAND', REFUND, 'credit')),
    bankPaidOut: check(execJ('BANK_TRANSFER'), glNet('ASSET.BANK', REFUND, 'credit')),
    unexpectedAccounts: unexpected,
  };
  const i = json.integrity;
  const integrity = {
    notesWithoutIssuanceJournal: {
      count: count(i.notesWithoutIssuanceJournalCount, 'integrity.notes'),
      totalMinor: minor(i.notesWithoutIssuanceJournalTotal, 'integrity.notesTotal').toString(),
    },
    executedCashBankWithoutJournal: {
      count: count(i.executedCashBankWithoutJournalCount, 'integrity.executed'),
      totalMinor: minor(
        i.executedCashBankWithoutJournalTotal,
        'integrity.executedTotal',
      ).toString(),
    },
    journalsWithoutSource: count(i.orphanJournals, 'integrity.orphans'),
  };
  const clearing = check(
    -(
      minor(json.clearing.issuedToDate, 'clearing.issued') -
      minor(json.clearing.executedToDate, 'clearing.executed')
    ),
    minor(json.clearing.glToDate, 'clearing.gl'),
  );
  const reconciled =
    Object.values(ledger)
      .filter((v): v is Check => typeof v === 'object' && !Array.isArray(v))
      .every((c) => c.reconciled) &&
    ledger.unexpectedAccounts.length === 0 &&
    integrity.notesWithoutIssuanceJournal.count === 0 &&
    integrity.executedCashBankWithoutJournal.count === 0 &&
    integrity.journalsWithoutSource === 0 &&
    clearing.reconciled;

  const ageing = AGEING_BUCKETS.map((b) => {
    const rows = json.pendingAgeing.filter((r) => r.bucket === b);
    return {
      bucket: b as string,
      count: rows.reduce((a, r) => a + count(r.count, 'ageing.count'), 0),
      totalMinor: rows.reduce((a, r) => a + minor(r.total, 'ageing.total'), 0n).toString(),
    };
  });

  return {
    companyId: header.companyId,
    currencyCode: company.currencyCode,
    currencyExponent: company.currencyExponent,
    accountingTimezone: company.accountingTimezone,
    from: header.from,
    to: header.to,
    scope: { level: header.branchId === null ? 'COMPANY' : 'BRANCH', branchId: header.branchId },
    notice: SUMMARY_NOTICE,
    creditNotes: {
      count: count(json.creditNotes.count, 'creditNotes.count'),
      creditedNetExTaxMinor: noteNet.toString(),
      creditedTaxMinor: noteTax.toString(),
      creditedTotalMinor: noteTotal.toString(),
    },
    refundsOfNotesIssuedInPeriod: {
      issued: counted(cell(null, null)),
      pending: counted(cell(null, 'PENDING')),
      executed: counted(cell(null, 'EXECUTED')),
      failed: counted(cell(null, 'FAILED')),
      unallocatedMinor: (noteTotal - nonFailed).toString(),
      byMethod: REFUND_METHODS.map((m) => ({
        method: m,
        issued: counted(cell(m, null)),
        pending: counted(cell(m, 'PENDING')),
        executed: counted(cell(m, 'EXECUTED')),
        failed: counted(cell(m, 'FAILED')),
      })),
    },
    refundsExecutedInPeriod: {
      count: execByMethod.reduce((a, r) => a + r.count, 0),
      totalMinor: execTotal.toString(),
      byMethod: execByMethod.map((r) => ({
        method: r.method,
        count: r.count,
        totalMinor: r.total.toString(),
      })),
    },
    pendingRefunds: {
      atPeriodEnd: {
        count: count(json.atPeriodEnd.pendingCount, 'atPeriodEnd.count'),
        totalMinor: minor(json.atPeriodEnd.pendingTotal, 'atPeriodEnd.total').toString(),
      },
      ageingNow: ageing,
    },
    adjustmentsToFrozenReports: {
      sales: {
        creditNoteCount: count(json.creditNotes.count, 'creditNotes.count'),
        netSalesExTaxMinor: noteNet.toString(),
        outputTaxMinor: noteTax.toString(),
        totalMinor: noteTotal.toString(),
      },
      tender: {
        executedRefundsMinor: execTotal.toString(),
        byMethod: execByMethod.map((r) => ({
          method: r.method,
          executedRefundsMinor: r.total.toString(),
        })),
      },
    },
    reconciliation: {
      reconciled,
      ledger,
      integrity,
      paymentClearingAtPeriodEnd: clearing,
    },
  };
}
