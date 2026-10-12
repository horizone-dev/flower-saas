import { DomainError } from '../../common/errors/domain-error.js';
import { minorUnitsToWire } from './report-money.js';
import { SALES_ACCOUNT_KEYS, SALES_SOURCE_KINDS } from './sales-financial-report.sql.js';

/**
 * Task 3b.10 Checkpoint B — the PURE Sales Financial Report arithmetic (owner rulings OD-2, OD-5,
 * OD-6). NO DB, NO HTTP, NO Prisma types, NO clock. Exact `bigint` minor units only.
 *
 * The report is SOURCE-DERIVED from the frozen financial documents whose sealed journal falls in the
 * period — issued Invoices, CreditNotes and CancellationCharges — and it presents them SEPARATELY:
 *
 *   invoices             invoiced sales as the invoices state them: subtotal (after line discounts),
 *                        line + document discounts (kept apart), output tax, invoiced total, and
 *                        `salesNetExTaxMinor = invoicedTotal − outputTax` — exactly the revenue the
 *                        invoice's own journal credits (`REVENUE.SALES`, the net-of-discount convention
 *                        frozen by decision `3b.9-ACC`). No gross-plus-contra presentation.
 *   creditNotes          count, total, tax and `net ex-tax = total − tax` of the CreditNotes — never
 *                        subtracted from the invoice figures.
 *   netSalesAfterCreditNotes
 *                        the one EXPLICIT net: invoice figure − credit-note figure, for ex-tax, tax and
 *                        total, in signed `bigint`.
 *   cancellationCharges  its own block (own revenue account, own tax) — never added into sales, credit
 *                        notes or any other figure.
 *   currentPaymentStatusBreakdown
 *                        the stored `invoicePaymentStatus` of the included invoices, per status (the
 *                        full frozen vocabulary, PAID and SETTLED distinct). It is CURRENT at read time —
 *                        period membership is the posting date.
 *   reconciliation       the source-derived figures against the GL lines of EXACTLY those journals:
 *                        revenue and output tax for each of the three document sets. A difference fails
 *                        the report closed — it never returns apparently trustworthy figures.
 *
 * Refunds are not here (Tender reporting), a CustomerAdvance is never revenue, a Payment is never
 * revenue, and no figure claims to measure more than its own source document states (CLAUDE.md
 * rule 21: only a figure whose formula supports a financial-result label may carry one).
 */

/** the frozen ADR-0019 §2 `invoice_payment_status` vocabulary (DB CHECK `invoice_payment_status_chk`) */
export const INVOICE_PAYMENT_STATUSES = [
  'UNPAID',
  'PARTIAL',
  'PAID',
  'SETTLED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
  'VOID',
] as const;
export type InvoicePaymentStatusName = (typeof INVOICE_PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_NOTE =
  'Payment status is current at report read time; period membership is based on accounting postingDate.';

const INVOICE_KINDS: readonly string[] = [
  SALES_SOURCE_KINDS.invoiceCustomer,
  SALES_SOURCE_KINDS.invoiceAnonymous,
];

/** one branch's raw aggregates (exact bigint) */
export interface SalesBranchAggregate {
  readonly branchId: string;
  readonly invoiceCount: number;
  readonly invoicedSubtotal: bigint;
  readonly lineDiscount: bigint;
  readonly documentDiscount: bigint;
  readonly outputTax: bigint;
  readonly invoicedTotal: bigint;
  readonly creditNoteCount: number;
  readonly creditNoteTotal: bigint;
  readonly creditNoteTax: bigint;
  readonly cancellationChargeCount: number;
  readonly cancellationChargeNet: bigint;
  readonly cancellationChargeTax: bigint;
  readonly cancellationChargeTotal: bigint;
}
export interface SalesStatusAggregate {
  readonly branchId: string;
  readonly status: string;
  readonly count: number;
  readonly total: bigint;
}
export interface SalesGlAggregate {
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

export interface SalesFinancialBlocks {
  readonly invoices: {
    readonly invoiceCount: number;
    readonly invoicedSubtotalMinor: string;
    readonly lineDiscountMinor: string;
    readonly documentDiscountMinor: string;
    readonly outputTaxMinor: string;
    readonly invoicedTotalMinor: string;
    readonly salesNetExTaxMinor: string;
  };
  readonly creditNotes: {
    readonly creditNoteCount: number;
    readonly creditNoteNetExTaxMinor: string;
    readonly creditNoteTaxMinor: string;
    readonly creditNoteTotalMinor: string;
  };
  readonly netSalesAfterCreditNotes: {
    readonly netSalesAfterCreditNotesExTaxMinor: string;
    readonly netSalesAfterCreditNotesTaxMinor: string;
    readonly netSalesAfterCreditNotesTotalMinor: string;
  };
  readonly cancellationCharges: {
    readonly cancellationChargeCount: number;
    readonly cancellationChargeNetExTaxMinor: string;
    readonly cancellationChargeTaxMinor: string;
    readonly cancellationChargeTotalMinor: string;
  };
  readonly currentPaymentStatusBreakdown: {
    readonly note: string;
    readonly statuses: readonly {
      readonly status: InvoicePaymentStatusName;
      readonly count: number;
      readonly invoiceTotalMinor: string;
    }[];
  };
  readonly reconciliation: {
    readonly reconciled: boolean;
    readonly invoices: {
      readonly salesRevenue: ReconciliationControl;
      readonly outputTax: ReconciliationControl;
    };
    readonly creditNotes: {
      readonly revenueReversal: ReconciliationControl;
      readonly outputTaxReversal: ReconciliationControl;
    };
    readonly cancellationCharges: {
      readonly revenue: ReconciliationControl;
      readonly outputTax: ReconciliationControl;
    };
  };
}

const zeroAggregate = (branchId: string): SalesBranchAggregate => ({
  branchId,
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
});

/** Add branch aggregates together (the company aggregate is the exact sum of its branches). */
export function sumAggregates(
  branchId: string,
  rows: readonly SalesBranchAggregate[],
): SalesBranchAggregate {
  return rows.reduce<SalesBranchAggregate>(
    (acc, r) => ({
      branchId,
      invoiceCount: acc.invoiceCount + r.invoiceCount,
      invoicedSubtotal: acc.invoicedSubtotal + r.invoicedSubtotal,
      lineDiscount: acc.lineDiscount + r.lineDiscount,
      documentDiscount: acc.documentDiscount + r.documentDiscount,
      outputTax: acc.outputTax + r.outputTax,
      invoicedTotal: acc.invoicedTotal + r.invoicedTotal,
      creditNoteCount: acc.creditNoteCount + r.creditNoteCount,
      creditNoteTotal: acc.creditNoteTotal + r.creditNoteTotal,
      creditNoteTax: acc.creditNoteTax + r.creditNoteTax,
      cancellationChargeCount: acc.cancellationChargeCount + r.cancellationChargeCount,
      cancellationChargeNet: acc.cancellationChargeNet + r.cancellationChargeNet,
      cancellationChargeTax: acc.cancellationChargeTax + r.cancellationChargeTax,
      cancellationChargeTotal: acc.cancellationChargeTotal + r.cancellationChargeTotal,
    }),
    zeroAggregate(branchId),
  );
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

/** Σ GL (credit − debit) or (debit − credit) of one account over the given source kinds. */
function glNet(
  gl: readonly SalesGlAggregate[],
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

/**
 * Build one scope's blocks (a branch, or the whole company) from its aggregate, its status rows and
 * its GL rows — and enforce the reconciliation: any difference between a source-derived figure and the
 * GL lines of those same journals fails the report closed (`500 REPORT_SALES_GL_MISMATCH`).
 */
export function buildSalesFinancialBlocks(
  aggregate: SalesBranchAggregate,
  statuses: readonly SalesStatusAggregate[],
  gl: readonly SalesGlAggregate[],
): SalesFinancialBlocks {
  for (const [label, value] of [
    ['invoicedSubtotal', aggregate.invoicedSubtotal],
    ['lineDiscount', aggregate.lineDiscount],
    ['documentDiscount', aggregate.documentDiscount],
    ['outputTax', aggregate.outputTax],
    ['invoicedTotal', aggregate.invoicedTotal],
    ['creditNoteTotal', aggregate.creditNoteTotal],
    ['creditNoteTax', aggregate.creditNoteTax],
    ['cancellationChargeNet', aggregate.cancellationChargeNet],
    ['cancellationChargeTax', aggregate.cancellationChargeTax],
    ['cancellationChargeTotal', aggregate.cancellationChargeTotal],
  ] as const) {
    assertNonNegative(value, label);
  }

  const salesNetExTax = aggregate.invoicedTotal - aggregate.outputTax;
  const creditNoteNetExTax = aggregate.creditNoteTotal - aggregate.creditNoteTax;

  // the CURRENT payment-status breakdown — the full frozen vocabulary, zero-filled, PAID ≠ SETTLED
  const byStatus = new Map<string, { count: number; total: bigint }>(
    INVOICE_PAYMENT_STATUSES.map((s) => [s, { count: 0, total: 0n }]),
  );
  for (const s of statuses) {
    const slot = byStatus.get(s.status);
    if (slot === undefined) {
      throw new RangeError(`unknown invoice payment status "${s.status}"`);
    }
    slot.count += s.count;
    slot.total += s.total;
  }
  const statusRows = INVOICE_PAYMENT_STATUSES.map((status) => ({
    status,
    count: byStatus.get(status)!.count,
    invoiceTotalMinor: minorUnitsToWire(byStatus.get(status)!.total),
  }));
  // the breakdown must account for exactly the invoices (and the amount) the invoice block states
  const statusCount = statusRows.reduce((n, r) => n + r.count, 0);
  const statusTotal = [...byStatus.values()].reduce((n, r) => n + r.total, 0n);
  if (statusCount !== aggregate.invoiceCount || statusTotal !== aggregate.invoicedTotal) {
    throw new DomainError(
      'REPORT_SALES_SOURCE_INTEGRITY',
      'the invoice payment-status breakdown does not account for the included invoices — no report is returned',
      500,
    );
  }

  const reconciliation = {
    invoices: {
      salesRevenue: control(
        salesNetExTax,
        glNet(gl, INVOICE_KINDS, SALES_ACCOUNT_KEYS.salesRevenue, 'credit'),
      ),
      outputTax: control(
        aggregate.outputTax,
        glNet(gl, INVOICE_KINDS, SALES_ACCOUNT_KEYS.outputTax, 'credit'),
      ),
    },
    creditNotes: {
      revenueReversal: control(
        creditNoteNetExTax,
        glNet(gl, [SALES_SOURCE_KINDS.creditNote], SALES_ACCOUNT_KEYS.salesRevenue, 'debit'),
      ),
      outputTaxReversal: control(
        aggregate.creditNoteTax,
        glNet(gl, [SALES_SOURCE_KINDS.creditNote], SALES_ACCOUNT_KEYS.outputTax, 'debit'),
      ),
    },
    cancellationCharges: {
      revenue: control(
        aggregate.cancellationChargeNet,
        glNet(
          gl,
          [SALES_SOURCE_KINDS.cancellationCharge],
          SALES_ACCOUNT_KEYS.cancellationChargeRevenue,
          'credit',
        ),
      ),
      outputTax: control(
        aggregate.cancellationChargeTax,
        glNet(gl, [SALES_SOURCE_KINDS.cancellationCharge], SALES_ACCOUNT_KEYS.outputTax, 'credit'),
      ),
    },
  };
  const controls = [
    reconciliation.invoices.salesRevenue,
    reconciliation.invoices.outputTax,
    reconciliation.creditNotes.revenueReversal,
    reconciliation.creditNotes.outputTaxReversal,
    reconciliation.cancellationCharges.revenue,
    reconciliation.cancellationCharges.outputTax,
  ];
  if (controls.some((c) => !c.reconciled)) {
    throw new DomainError(
      'REPORT_SALES_GL_MISMATCH',
      'a sales source document disagrees with the general-ledger lines of its own journal — no report is returned',
      500,
    );
  }

  return {
    invoices: {
      invoiceCount: aggregate.invoiceCount,
      invoicedSubtotalMinor: minorUnitsToWire(aggregate.invoicedSubtotal),
      lineDiscountMinor: minorUnitsToWire(aggregate.lineDiscount),
      documentDiscountMinor: minorUnitsToWire(aggregate.documentDiscount),
      outputTaxMinor: minorUnitsToWire(aggregate.outputTax),
      invoicedTotalMinor: minorUnitsToWire(aggregate.invoicedTotal),
      salesNetExTaxMinor: minorUnitsToWire(salesNetExTax),
    },
    creditNotes: {
      creditNoteCount: aggregate.creditNoteCount,
      creditNoteNetExTaxMinor: minorUnitsToWire(creditNoteNetExTax),
      creditNoteTaxMinor: minorUnitsToWire(aggregate.creditNoteTax),
      creditNoteTotalMinor: minorUnitsToWire(aggregate.creditNoteTotal),
    },
    netSalesAfterCreditNotes: {
      netSalesAfterCreditNotesExTaxMinor: minorUnitsToWire(salesNetExTax - creditNoteNetExTax),
      netSalesAfterCreditNotesTaxMinor: minorUnitsToWire(
        aggregate.outputTax - aggregate.creditNoteTax,
      ),
      netSalesAfterCreditNotesTotalMinor: minorUnitsToWire(
        aggregate.invoicedTotal - aggregate.creditNoteTotal,
      ),
    },
    cancellationCharges: {
      cancellationChargeCount: aggregate.cancellationChargeCount,
      cancellationChargeNetExTaxMinor: minorUnitsToWire(aggregate.cancellationChargeNet),
      cancellationChargeTaxMinor: minorUnitsToWire(aggregate.cancellationChargeTax),
      cancellationChargeTotalMinor: minorUnitsToWire(aggregate.cancellationChargeTotal),
    },
    currentPaymentStatusBreakdown: { note: PAYMENT_STATUS_NOTE, statuses: statusRows },
    reconciliation: { reconciled: true, ...reconciliation },
  };
}
