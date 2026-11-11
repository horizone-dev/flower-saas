import { describe, expect, it } from 'vitest';
import {
  AGEING_BUCKETS,
  buildSummary,
  minor,
  parseSummaryPeriod,
  resolveCompany,
  summaryQuery,
  type SummaryJson,
} from './anonymous-credit-note-summary.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
};

/** a consistent world: one note (total 10 500, tax 500) fully executed in CASH, one manual-card line pending (1 000) */
const base = (): SummaryJson => ({
  company: { defaultCurrency: 'AED', accountingTimezone: 'Asia/Dubai' },
  candidateNotes: 1,
  creditNotes: { count: 1, total: '10500', tax: '500' },
  cohort: [
    { method: 'CASH', status: 'EXECUTED', count: 1, total: '9500' },
    { method: 'CARD_TERMINAL', status: 'PENDING', count: 1, total: '1000' },
  ],
  executedEvent: [{ method: 'CASH', count: 1, total: '9500' }],
  pendingAgeing: [{ bucket: '0-1 days', count: 1, total: '1000' }],
  atPeriodEnd: { pendingCount: 1, pendingTotal: '1000' },
  gl: [
    { key: 'REVENUE.SALES', kind: 'anonymous_credit_note', debit: '10000', credit: '0' },
    { key: 'LIABILITY.TAX_PAYABLE', kind: 'anonymous_credit_note', debit: '500', credit: '0' },
    { key: 'ASSET.PAYMENT_CLEARING', kind: 'anonymous_credit_note', debit: '0', credit: '10500' },
    {
      key: 'ASSET.PAYMENT_CLEARING',
      kind: 'anonymous_credit_note_refund',
      debit: '9500',
      credit: '0',
    },
    { key: 'ASSET.CASH_ON_HAND', kind: 'anonymous_credit_note_refund', debit: '0', credit: '9500' },
  ],
  execJournalInPeriod: [{ method: 'CASH', count: 1, total: '9500' }],
  integrity: {
    notesWithoutIssuanceJournalCount: 0,
    notesWithoutIssuanceJournalTotal: '0',
    executedCashBankWithoutJournalCount: 0,
    executedCashBankWithoutJournalTotal: '0',
    orphanJournals: 0,
  },
  clearing: { issuedToDate: '10500', executedToDate: '9500', glToDate: '-1000' },
});
const H = { companyId: 'c', branchId: null, from: '2026-06-01', to: '2026-06-30' };
const build = (j: SummaryJson) => buildSummary(j, H);

describe('summary period contract (civil dates, inclusive, ≤ 90 days)', () => {
  it('accepts a civil period and exactly 90 inclusive days; rejects 91', () => {
    expect(parseSummaryPeriod({ from: '2026-06-01', to: '2026-06-01' })).toEqual({
      from: '2026-06-01',
      to: '2026-06-01',
    });
    expect(parseSummaryPeriod({ from: '2026-04-02', to: '2026-06-30' })).toBeTruthy(); // 90 days
    expect(codeOf(() => parseSummaryPeriod({ from: '2026-04-01', to: '2026-06-30' }))).toBe(
      'REPORT_RANGE_TOO_LARGE',
    ); // 91
    // a leap year: 2024-01-01 .. 2024-03-30 is 90 days inclusive, ..03-31 is 91
    expect(parseSummaryPeriod({ from: '2024-01-01', to: '2024-03-30' })).toBeTruthy();
    expect(codeOf(() => parseSummaryPeriod({ from: '2024-01-01', to: '2024-03-31' }))).toBe(
      'REPORT_RANGE_TOO_LARGE',
    );
    // across a year end
    expect(parseSummaryPeriod({ from: '2025-12-15', to: '2026-01-15' })).toBeTruthy();
  });
  it('rejects timestamps, offsets, other formats, impossible dates, missing values and an inverted range — never truncating', () => {
    for (const bad of [
      '2026-06-01T00:00:00Z',
      '2026-06-01 10:00',
      '06/01/2026',
      '2026-6-1',
      '2026-02-30',
      '0000-01-01',
      '',
      20260601,
      null,
      undefined,
    ]) {
      expect(
        codeOf(() => parseSummaryPeriod({ from: bad, to: '2026-06-30' })),
        String(bad),
      ).toBe('INVALID_DATE');
    }
    expect(codeOf(() => parseSummaryPeriod({ from: '2026-06-30', to: '2026-06-01' }))).toBe(
      'INVALID_DATE_RANGE',
    );
  });
  it('accepts exactly the keys from and to', () => {
    expect(summaryQuery({ from: 'a', to: 'b' })).toEqual({ from: 'a', to: 'b' });
    expect(codeOf(() => summaryQuery({ from: 'a', to: 'b', branchId: 'x' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codeOf(() => summaryQuery({ limit: '5' }))).toBe('VALIDATION_FAILED');
  });
});

describe('exact money and company authority fail closed', () => {
  it('reads only integer text; a float, a number, a blank or an exponent is refused', () => {
    expect(minor('-12', 'x')).toBe(-12n);
    for (const bad of ['1.5', 1, '', '1e3', ' 1', null])
      expect(
        codeOf(() => minor(bad, 'x')),
        String(bad),
      ).toBe('REPORT_DATA_INVALID');
  });
  it('a missing, unknown or mistyped company configuration is a named 409', () => {
    expect(codeOf(() => resolveCompany(null))).toBe('REPORT_COMPANY_NOT_CONFIGURED');
    expect(
      codeOf(() => resolveCompany({ defaultCurrency: null, accountingTimezone: 'Asia/Dubai' })),
    ).toBe('REPORT_COMPANY_NOT_CONFIGURED');
    expect(
      codeOf(() => resolveCompany({ defaultCurrency: 'XXX', accountingTimezone: 'Asia/Dubai' })),
    ).toBe('REPORT_COMPANY_NOT_CONFIGURED');
    expect(
      codeOf(() => resolveCompany({ defaultCurrency: 'AED', accountingTimezone: 'Mars/Phobos' })),
    ).toBe('REPORT_COMPANY_NOT_CONFIGURED');
    expect(
      resolveCompany({ defaultCurrency: 'KWD', accountingTimezone: 'Asia/Kuwait' }),
    ).toMatchObject({ currencyExponent: 3 });
  });
});

describe('the response and its ledger reconciliation', () => {
  it('a consistent world reconciles and exposes every lens exactly', () => {
    const s = build(base());
    expect(s.reconciliation.reconciled).toBe(true);
    expect(s.creditNotes).toEqual({
      count: 1,
      creditedNetExTaxMinor: '10000',
      creditedTaxMinor: '500',
      creditedTotalMinor: '10500',
    });
    const r = s.refundsOfNotesIssuedInPeriod;
    expect([r.issued, r.pending, r.executed, r.failed]).toEqual([
      { count: 2, totalMinor: '10500' },
      { count: 1, totalMinor: '1000' },
      { count: 1, totalMinor: '9500' },
      { count: 0, totalMinor: '0' },
    ]);
    expect(r.unallocatedMinor).toBe('0');
    expect(s.refundsExecutedInPeriod).toMatchObject({ count: 1, totalMinor: '9500' });
    expect(s.adjustmentsToFrozenReports.sales).toEqual({
      creditNoteCount: 1,
      netSalesExTaxMinor: '10000',
      outputTaxMinor: '500',
      totalMinor: '10500',
    });
    expect(s.adjustmentsToFrozenReports.tender.executedRefundsMinor).toBe('9500');
    expect(s.pendingRefunds.ageingNow.map((b) => b.bucket)).toEqual([...AGEING_BUCKETS]);
    expect(s.scope).toEqual({ level: 'COMPANY', branchId: null });
    expect(buildSummary(base(), { ...H, branchId: 'b' }).scope).toEqual({
      level: 'BRANCH',
      branchId: 'b',
    });
  });

  it('a failed, unreplaced line is the unallocated credit', () => {
    const j = base();
    const s = build({
      ...j,
      cohort: [
        { method: 'CASH', status: 'EXECUTED', count: 1, total: '9500' },
        { method: 'CASH', status: 'FAILED', count: 1, total: '1000' },
      ],
    });
    expect(s.refundsOfNotesIssuedInPeriod.unallocatedMinor).toBe('1000');
    expect(s.refundsOfNotesIssuedInPeriod.failed).toEqual({ count: 1, totalMinor: '1000' });
  });

  it('reconciliation NEVER reports success when a figure disagrees with the ledger — each mutation flips it', () => {
    const mutate = (f: (j: SummaryJson) => SummaryJson): boolean =>
      build(f(base())).reconciliation.reconciled;
    expect(mutate((j) => j)).toBe(true);
    // revenue reversal: the ledger holds 1 less than the documents say
    expect(
      mutate((j) => ({
        ...j,
        gl: j.gl.map((g) => (g.key === 'REVENUE.SALES' ? { ...g, debit: '9999' } : g)),
      })),
    ).toBe(false);
    // output tax
    expect(
      mutate((j) => ({
        ...j,
        gl: j.gl.map((g) => (g.key === 'LIABILITY.TAX_PAYABLE' ? { ...g, debit: '499' } : g)),
      })),
    ).toBe(false);
    // issuance clearing credit
    expect(
      mutate((j) => ({
        ...j,
        gl: j.gl.map((g) =>
          g.key === 'ASSET.PAYMENT_CLEARING' && g.kind === 'anonymous_credit_note'
            ? { ...g, credit: '10499' }
            : g,
        ),
      })),
    ).toBe(false);
    // execution: cash paid out differs from the executed refunds
    expect(
      mutate((j) => ({
        ...j,
        gl: j.gl.map((g) => (g.key === 'ASSET.CASH_ON_HAND' ? { ...g, credit: '9400' } : g)),
      })),
    ).toBe(false);
    // execution clearing debit
    expect(
      mutate((j) => ({
        ...j,
        gl: j.gl.map((g) =>
          g.key === 'ASSET.PAYMENT_CLEARING' && g.kind === 'anonymous_credit_note_refund'
            ? { ...g, debit: '9400' }
            : g,
        ),
      })),
    ).toBe(false);
    // a bank movement the documents do not explain
    expect(
      mutate((j) => ({
        ...j,
        gl: [
          ...j.gl,
          { key: 'ASSET.BANK', kind: 'anonymous_credit_note_refund', debit: '0', credit: '50' },
        ],
      })),
    ).toBe(false);
    // an account that no anonymous journal may touch
    expect(
      mutate((j) => ({
        ...j,
        gl: [
          ...j.gl,
          { key: 'EXPENSE.MISC', kind: 'anonymous_credit_note', debit: '5', credit: '5' },
        ],
      })),
    ).toBe(false);
    // integrity: a note without its journal, an executed cash refund without its journal, an orphan journal
    expect(
      mutate((j) => ({
        ...j,
        integrity: {
          ...j.integrity,
          notesWithoutIssuanceJournalCount: 1,
          notesWithoutIssuanceJournalTotal: '10500',
        },
      })),
    ).toBe(false);
    expect(
      mutate((j) => ({
        ...j,
        integrity: {
          ...j.integrity,
          executedCashBankWithoutJournalCount: 1,
          executedCashBankWithoutJournalTotal: '9500',
        },
      })),
    ).toBe(false);
    expect(mutate((j) => ({ ...j, integrity: { ...j.integrity, orphanJournals: 1 } }))).toBe(false);
    // the cumulative clearing tie-out
    expect(mutate((j) => ({ ...j, clearing: { ...j.clearing, glToDate: '-999' } }))).toBe(false);
    expect(mutate((j) => ({ ...j, clearing: { ...j.clearing, issuedToDate: '10501' } }))).toBe(
      false,
    );
  });

  it('the differences are exact and signed (source − ledger)', () => {
    const s = build({
      ...base(),
      gl: base().gl.map((g) => (g.key === 'REVENUE.SALES' ? { ...g, debit: '9990' } : g)),
    });
    expect(s.reconciliation.ledger.revenueSalesReversal).toEqual({
      sourceMinor: '10000',
      glMinor: '9990',
      differenceMinor: '10',
      reconciled: false,
    });
  });

  it('corrupt database output fails closed with a named error, never a figure', () => {
    expect(
      codeOf(() => build({ ...base(), creditNotes: { count: 1, total: '10500', tax: '10501' } })),
    ).toBe('REPORT_DATA_INVALID');
    expect(
      codeOf(() =>
        build({
          ...base(),
          cohort: [{ method: 'CHEQUE', status: 'EXECUTED', count: 1, total: '1' }],
        }),
      ),
    ).toBe('REPORT_DATA_INVALID');
    expect(
      codeOf(() =>
        build({
          ...base(),
          cohort: [{ method: 'CASH', status: 'EXECUTED', count: 1, total: '1.5' }],
        }),
      ),
    ).toBe('REPORT_DATA_INVALID');
    expect(codeOf(() => build({ ...base(), company: null }))).toBe('REPORT_COMPANY_NOT_CONFIGURED');
  });

  it('a window with no activity is a clean zero and reconciles (nothing to disagree with)', () => {
    const z: SummaryJson = {
      company: { defaultCurrency: 'AED', accountingTimezone: 'Asia/Dubai' },
      candidateNotes: 0,
      creditNotes: { count: 0, total: '0', tax: '0' },
      cohort: [],
      executedEvent: [],
      pendingAgeing: [],
      atPeriodEnd: { pendingCount: 0, pendingTotal: '0' },
      gl: [],
      execJournalInPeriod: [],
      integrity: {
        notesWithoutIssuanceJournalCount: 0,
        notesWithoutIssuanceJournalTotal: '0',
        executedCashBankWithoutJournalCount: 0,
        executedCashBankWithoutJournalTotal: '0',
        orphanJournals: 0,
      },
      clearing: { issuedToDate: '0', executedToDate: '0', glToDate: '0' },
    };
    const s = build(z);
    expect(s.reconciliation.reconciled).toBe(true);
    expect(s.refundsOfNotesIssuedInPeriod.byMethod).toHaveLength(4);
    expect(s.creditNotes.creditedTotalMinor).toBe('0');
  });
});
