/**
 * The frozen Chart-of-Accounts reference data (task 3b.1). Exactly 14 system
 * accounts, one GL per Company. `key` is the immutable internal posting
 * identity — never business-editable. `defaultDisplayCode`/`defaultDisplayName`
 * seed the owner-editable `displayCode`/`displayName` columns; an owner may
 * rename either later, but `key`/`category` never change and no account may be
 * added, removed, or disabled in V1 (docs/phase-3/PHASE-3B-PLAN.md §C.1).
 *
 * Single source of truth: both new-company provisioning and the existing-
 * company Accounting Setup bootstrap import this same array — never
 * duplicated into migration SQL or any other seed file.
 */

export interface AccountReferenceRow {
  key: string;
  /// ASSET | LIABILITY | EQUITY | REVENUE | CONTRA_REVENUE | EXPENSE — immutable
  category: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'CONTRA_REVENUE' | 'EXPENSE';
  defaultDisplayCode: string;
  defaultDisplayName: string;
}

export const ACCOUNTING_REFERENCE_ACCOUNTS: readonly AccountReferenceRow[] = [
  {
    key: 'ASSET.CASH_ON_HAND',
    category: 'ASSET',
    defaultDisplayCode: '1000',
    defaultDisplayName: 'Cash on Hand',
  },
  { key: 'ASSET.BANK', category: 'ASSET', defaultDisplayCode: '1100', defaultDisplayName: 'Bank' },
  {
    key: 'ASSET.PAYMENT_CLEARING',
    category: 'ASSET',
    defaultDisplayCode: '1200',
    defaultDisplayName: 'Payment Clearing',
  },
  {
    key: 'ASSET.ACCOUNTS_RECEIVABLE',
    category: 'ASSET',
    defaultDisplayCode: '1300',
    defaultDisplayName: 'Accounts Receivable',
  },
  {
    key: 'LIABILITY.CUSTOMER_ADVANCES',
    category: 'LIABILITY',
    defaultDisplayCode: '2000',
    defaultDisplayName: 'Customer Advances',
  },
  {
    key: 'LIABILITY.UNAPPLIED_RECEIPTS',
    category: 'LIABILITY',
    defaultDisplayCode: '2050',
    defaultDisplayName: 'Unapplied Customer Receipts',
  },
  {
    key: 'LIABILITY.TAX_PAYABLE',
    category: 'LIABILITY',
    defaultDisplayCode: '2100',
    defaultDisplayName: 'Tax Payable',
  },
  {
    key: 'LIABILITY.REFUND_PAYABLE',
    category: 'LIABILITY',
    defaultDisplayCode: '2200',
    defaultDisplayName: 'Refund Payable',
  },
  {
    key: 'EQUITY.RETAINED_EARNINGS',
    category: 'EQUITY',
    defaultDisplayCode: '3000',
    defaultDisplayName: 'Retained Earnings',
  },
  // Task 3b.6 Checkpoint B — the opening/migration balance-sheet clearing
  // account (docs/decisions/ADR-0019.md). NOT Revenue, NOT Retained Earnings,
  // NOT Cash, NOT AR, NOT Customer Advances — every opening-balance journal
  // (Dr AR / Cr EQUITY.OPENING_BALANCE for an opening receivable; Dr
  // EQUITY.OPENING_BALANCE / Cr Customer Advances for an opening advance) has
  // its other leg here. No journal is posted in Checkpoint B — this seeds the
  // account only. Code '3100' continues the EQUITY category's own numbering
  // (only prior EQUITY entry is '3000'), following the same one-gap-per-
  // category convention already used by every other category above
  // (1000/1100/1200/1300, 2000/2050/2100/2200, 4000/4100, 4900/4910).
  {
    key: 'EQUITY.OPENING_BALANCE',
    category: 'EQUITY',
    defaultDisplayCode: '3100',
    defaultDisplayName: 'Opening Balance Equity',
  },
  {
    key: 'REVENUE.SALES',
    category: 'REVENUE',
    defaultDisplayCode: '4000',
    defaultDisplayName: 'Sales Revenue',
  },
  {
    key: 'REVENUE.CANCELLATION_CHARGE',
    category: 'REVENUE',
    defaultDisplayCode: '4100',
    defaultDisplayName: 'Cancellation Charge Revenue',
  },
  {
    key: 'CONTRA_REVENUE.SALES_DISCOUNT',
    category: 'CONTRA_REVENUE',
    defaultDisplayCode: '4900',
    defaultDisplayName: 'Sales Discount',
  },
  {
    key: 'CONTRA_REVENUE.SETTLEMENT_DISCOUNT',
    category: 'CONTRA_REVENUE',
    defaultDisplayCode: '4910',
    defaultDisplayName: 'Settlement Discount',
  },
  {
    key: 'EXPENSE.RECEIVABLE_WRITE_OFF',
    category: 'EXPENSE',
    defaultDisplayCode: '5000',
    defaultDisplayName: 'Receivable Write-Off',
  },
  // Task 3b.7 Checkpoint B — the provider settlement fee expense account
  // (docs/decisions/ADR-0019.md follow-on). Debited for the exact
  // `providerFeeMinor` leg of a settlement journal (Dr EXPENSE.PAYMENT_
  // PROCESSING_FEE / Cr ASSET.PAYMENT_CLEARING), omitted entirely when a
  // batch's fee is zero (no zero-valued journal line is ever created). NOT
  // `CONTRA_REVENUE.SETTLEMENT_DISCOUNT` (an unrelated early-payment-discount
  // concept) and NOT `EXPENSE.RECEIVABLE_WRITE_OFF`. '5100' continues the
  // EXPENSE category's own numbering (only prior EXPENSE entry is '5000'),
  // following the same one-gap-per-category convention as every other
  // category above. Backfilled for every existing company by migration
  // `20261003120000_settlement_core_schema`; new-company provisioning picks
  // it up for free (unchanged code, maps this array verbatim).
  {
    key: 'EXPENSE.PAYMENT_PROCESSING_FEE',
    category: 'EXPENSE',
    defaultDisplayCode: '5100',
    defaultDisplayName: 'Payment Processing Fee',
  },
];
