import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  INVOICE_PAYMENT_STATUSES,
  PAYMENT_STATUS_NOTE,
  buildSalesFinancialBlocks,
  sumAggregates,
  type SalesBranchAggregate,
  type SalesGlAggregate,
  type SalesStatusAggregate,
} from './sales-financial-report.js';

const REV = 'REVENUE.SALES';
const TAX = 'LIABILITY.TAX_PAYABLE';
const CC_REV = 'REVENUE.CANCELLATION_CHARGE';

const agg = (over: Partial<SalesBranchAggregate> = {}): SalesBranchAggregate => ({
  branchId: 'b1',
  invoiceCount: 0,
  invoicedSubtotal: 0n,
  lineDiscount: 0n,
  documentDiscount: 0n,
  outputTax: 0n,
  invoicedTotal: 0n,
  creditNoteCount: 0,
  creditNoteTotal: 0n,
  creditNoteTax: 0n,
  cancellationChargeCount: 0,
  cancellationChargeNet: 0n,
  cancellationChargeTax: 0n,
  cancellationChargeTotal: 0n,
  ...over,
});
const gl = (
  sourceKind: string,
  accountKey: string,
  debit: bigint,
  credit: bigint,
  branchId = 'b1',
): SalesGlAggregate => ({ branchId, sourceKind, accountKey, debit, credit });
const st = (
  status: string,
  count: number,
  total: bigint,
  branchId = 'b1',
): SalesStatusAggregate => ({
  branchId,
  status,
  count,
  total,
});

/** a consistent scope: 2 invoices (10 500 + 21 000, 5 % tax), 1 credit note (5 250, tax 250), 1 charge */
const scope = () => {
  const aggregate = agg({
    invoiceCount: 2,
    invoicedSubtotal: 30_000n,
    lineDiscount: 1_000n,
    documentDiscount: 500n,
    outputTax: 1_500n,
    invoicedTotal: 31_500n,
    creditNoteCount: 1,
    creditNoteTotal: 5_250n,
    creditNoteTax: 250n,
    cancellationChargeCount: 1,
    cancellationChargeNet: 400n,
    cancellationChargeTax: 20n,
    cancellationChargeTotal: 420n,
  });
  const statuses = [st('SETTLED', 1, 10_500n), st('PARTIAL', 1, 21_000n)];
  const ledger = [
    gl('walk_in_sale', REV, 0n, 10_000n),
    gl('walk_in_sale', TAX, 0n, 500n),
    gl('invoice_ar', REV, 0n, 20_000n),
    gl('invoice_ar', TAX, 0n, 1_000n),
    gl('credit_note', REV, 5_000n, 0n),
    gl('credit_note', TAX, 250n, 0n),
    gl('cancellation_charge', CC_REV, 0n, 400n),
    gl('cancellation_charge', TAX, 0n, 20n),
    // an account the controls do not cover (the AR / tender leg) is simply not part of them
    gl('invoice_ar', 'ASSET.ACCOUNTS_RECEIVABLE', 21_000n, 0n),
  ];
  return { aggregate, statuses, ledger };
};

function failure(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error('expected a DomainError');
}

describe('buildSalesFinancialBlocks — the sales figures', () => {
  const { aggregate, statuses, ledger } = scope();
  const blocks = buildSalesFinancialBlocks(aggregate, statuses, ledger);

  it('invoices: exact stored figures, discounts kept apart, net ex-tax = total − tax', () => {
    expect(blocks.invoices).toEqual({
      invoiceCount: 2,
      invoicedSubtotalMinor: '30000',
      lineDiscountMinor: '1000',
      documentDiscountMinor: '500',
      outputTaxMinor: '1500',
      invoicedTotalMinor: '31500',
      salesNetExTaxMinor: '30000', // 31 500 − 1 500
    });
  });

  it('credit notes are shown separately: count, net ex-tax (total − tax), tax, total', () => {
    expect(blocks.creditNotes).toEqual({
      creditNoteCount: 1,
      creditNoteNetExTaxMinor: '5000',
      creditNoteTaxMinor: '250',
      creditNoteTotalMinor: '5250',
    });
  });

  it('the explicit net after credit notes = invoice − credit note, for ex-tax, tax and total', () => {
    expect(blocks.netSalesAfterCreditNotes).toEqual({
      netSalesAfterCreditNotesExTaxMinor: '25000', // 30 000 − 5 000
      netSalesAfterCreditNotesTaxMinor: '1250', // 1 500 − 250
      netSalesAfterCreditNotesTotalMinor: '26250', // 31 500 − 5 250
    });
  });

  it('the invoice figures are NOT mutated by the credit note (the same aggregate, untouched)', () => {
    expect(blocks.invoices.invoicedTotalMinor).toBe('31500');
    expect(blocks.invoices.salesNetExTaxMinor).toBe('30000');
  });

  it('a cancellation charge is its own block and enters no sales figure', () => {
    expect(blocks.cancellationCharges).toEqual({
      cancellationChargeCount: 1,
      cancellationChargeNetExTaxMinor: '400',
      cancellationChargeTaxMinor: '20',
      cancellationChargeTotalMinor: '420',
    });
    expect(blocks.netSalesAfterCreditNotes.netSalesAfterCreditNotesTotalMinor).toBe('26250');
  });

  it('the net after credit notes is signed: credit notes may exceed the period invoices', () => {
    const b = buildSalesFinancialBlocks(
      agg({ creditNoteCount: 1, creditNoteTotal: 1_050n, creditNoteTax: 50n }),
      [],
      [gl('credit_note', REV, 1_000n, 0n), gl('credit_note', TAX, 50n, 0n)],
    );
    expect(b.netSalesAfterCreditNotes).toEqual({
      netSalesAfterCreditNotesExTaxMinor: '-1000',
      netSalesAfterCreditNotesTaxMinor: '-50',
      netSalesAfterCreditNotesTotalMinor: '-1050',
    });
  });

  it('the payment-status breakdown carries the FULL frozen vocabulary, zero-filled; PAID and SETTLED are distinct', () => {
    expect(blocks.currentPaymentStatusBreakdown.note).toBe(PAYMENT_STATUS_NOTE);
    expect(blocks.currentPaymentStatusBreakdown.note).toContain('current at report read time');
    const rows = blocks.currentPaymentStatusBreakdown.statuses;
    expect(rows.map((r) => r.status)).toEqual([...INVOICE_PAYMENT_STATUSES]);
    expect(Object.fromEntries(rows.map((r) => [r.status, [r.count, r.invoiceTotalMinor]]))).toEqual(
      {
        UNPAID: [0, '0'],
        PARTIAL: [1, '21000'],
        PAID: [0, '0'],
        SETTLED: [1, '10500'],
        PARTIALLY_REFUNDED: [0, '0'],
        REFUNDED: [0, '0'],
        CANCELLED: [0, '0'],
        VOID: [0, '0'],
      },
    );
    // PAID is not folded into SETTLED (and vice versa)
    const paid = buildSalesFinancialBlocks(
      agg({ invoiceCount: 2, invoicedTotal: 200n, outputTax: 0n, invoicedSubtotal: 200n }),
      [st('PAID', 1, 100n), st('SETTLED', 1, 100n)],
      [gl('walk_in_sale', REV, 0n, 200n)],
    );
    const by = Object.fromEntries(
      paid.currentPaymentStatusBreakdown.statuses.map((r) => [r.status, r.count]),
    );
    expect(by['PAID']).toBe(1);
    expect(by['SETTLED']).toBe(1);
  });

  it('reconciliation: every control is zero-difference and reconciled for a consistent scope', () => {
    expect(blocks.reconciliation.reconciled).toBe(true);
    const r = blocks.reconciliation;
    expect(r.invoices.salesRevenue).toEqual({
      sourceMinor: '30000',
      glMinor: '30000',
      differenceMinor: '0',
      reconciled: true,
    });
    expect(r.invoices.outputTax).toMatchObject({ sourceMinor: '1500', glMinor: '1500' });
    expect(r.creditNotes.revenueReversal).toMatchObject({ sourceMinor: '5000', glMinor: '5000' });
    expect(r.creditNotes.outputTaxReversal).toMatchObject({ sourceMinor: '250', glMinor: '250' });
    expect(r.cancellationCharges.revenue).toMatchObject({ sourceMinor: '400', glMinor: '400' });
    expect(r.cancellationCharges.outputTax).toMatchObject({ sourceMinor: '20', glMinor: '20' });
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const b = buildSalesFinancialBlocks(
      agg({ invoiceCount: 1, invoicedTotal: big + 5n, invoicedSubtotal: big + 5n, outputTax: 5n }),
      [st('PAID', 1, big + 5n)],
      [gl('walk_in_sale', REV, 0n, big), gl('walk_in_sale', TAX, 0n, 5n)],
    );
    expect(b.invoices.salesNetExTaxMinor).toBe('9007199254740993');
    expect(b.invoices.invoicedTotalMinor).toBe('9007199254740998');
    expect(b.reconciliation.invoices.salesRevenue.differenceMinor).toBe('0');
  });
});

describe('buildSalesFinancialBlocks — the reconciliation FAILS CLOSED', () => {
  const corrupt = (index: number, delta: bigint) => {
    const { aggregate, statuses, ledger } = scope();
    const bad = ledger.map((row, i) =>
      i === index
        ? {
            ...row,
            debit: row.debit === 0n ? 0n : row.debit + delta,
            credit: row.credit === 0n ? 0n : row.credit + delta,
          }
        : row,
    );
    return () => buildSalesFinancialBlocks(aggregate, statuses, bad);
  };

  it.each([
    ['invoice revenue', 0],
    ['invoice output tax', 1],
    ['credit-note revenue reversal', 4],
    ['credit-note output-tax reversal', 5],
    ['cancellation-charge revenue', 6],
    ['cancellation-charge output tax', 7],
  ])(
    'a one-minor-unit disagreement in the %s is REPORT_SALES_GL_MISMATCH (500), no figures',
    (_n, index) => {
      const err = failure(corrupt(index, 1n));
      expect(err.code).toBe('REPORT_SALES_GL_MISMATCH');
      expect(err.status).toBe(500);
    },
  );

  it('a missing GL line (a document with no revenue line) disagrees', () => {
    const { aggregate, statuses, ledger } = scope();
    const err = failure(() =>
      buildSalesFinancialBlocks(
        aggregate,
        statuses,
        ledger.filter((_r, i) => i !== 0),
      ),
    );
    expect(err.code).toBe('REPORT_SALES_GL_MISMATCH');
  });

  it('GL lines of an UNRELATED source kind never participate in the controls', () => {
    const { aggregate, statuses, ledger } = scope();
    const extra = [
      ...ledger,
      gl('manual_adjustment', REV, 0n, 999_999n),
      gl('refund', REV, 0n, 7n),
    ];
    expect(() => buildSalesFinancialBlocks(aggregate, statuses, extra)).not.toThrow();
  });

  it('a revenue line booked into the WRONG source set does not satisfy another set', () => {
    const { aggregate, statuses, ledger } = scope();
    // move the credit-note revenue debit into the cancellation-charge kind
    const moved = ledger.map((r) =>
      r.sourceKind === 'credit_note' && r.accountKey === REV ? { ...r, sourceKind: 'refund' } : r,
    );
    expect(failure(() => buildSalesFinancialBlocks(aggregate, statuses, moved)).code).toBe(
      'REPORT_SALES_GL_MISMATCH',
    );
  });

  it('a status breakdown that does not account for the included invoices fails closed', () => {
    const { aggregate, ledger } = scope();
    const err = failure(() =>
      buildSalesFinancialBlocks(aggregate, [st('SETTLED', 1, 10_500n)], ledger),
    );
    expect(err.code).toBe('REPORT_SALES_SOURCE_INTEGRITY');
  });

  it('an unknown invoice status is rejected', () => {
    const { aggregate, ledger } = scope();
    expect(() =>
      buildSalesFinancialBlocks(aggregate, [st('PAID_IN_FULL', 2, 31_500n)], ledger),
    ).toThrow(RangeError);
  });

  it('a negative aggregate is never normalised', () => {
    expect(() => buildSalesFinancialBlocks(agg({ outputTax: -1n }), [], [])).toThrow(RangeError);
  });
});

describe('sumAggregates — the company aggregate is the exact sum of its branches', () => {
  it('adds every column; no branches is the zero aggregate', () => {
    const a = agg({
      branchId: 'a',
      invoiceCount: 1,
      invoicedTotal: 100n,
      outputTax: 5n,
      creditNoteCount: 2,
      creditNoteTotal: 7n,
    });
    const b = agg({
      branchId: 'b',
      invoiceCount: 3,
      invoicedTotal: 250n,
      outputTax: 12n,
      cancellationChargeNet: 9n,
    });
    expect(sumAggregates('COMPANY', [a, b])).toMatchObject({
      branchId: 'COMPANY',
      invoiceCount: 4,
      invoicedTotal: 350n,
      outputTax: 17n,
      creditNoteCount: 2,
      creditNoteTotal: 7n,
      cancellationChargeNet: 9n,
    });
    expect(sumAggregates('COMPANY', [])).toEqual(agg({ branchId: 'COMPANY' }));
  });
});
