/**
 * POS selling contracts — structural MIRRORS of the Phase 3 backend responses a till needs (orders, totals, complete-sale, invoice, customers,
 * org lists). They are read-only descriptions of what the server already returns; nothing here is a business rule. Money is always an
 * integer-minor-units DECIMAL STRING (the server never sends a JS number for money — rule 15); the client only displays it.
 */

export type OrderStatus = 'DRAFT' | 'HELD' | 'CONFIRMED' | 'CANCELLED' | (string & {});

export interface PosOrderRow {
  id: string;
  companyId: string;
  originBranchId: string;
  fulfillingBranchId: string;
  posTerminalId: string | null;
  customerId: string | null;
  kind: string;
  status: OrderStatus;
  currencyCode: string;
  currencyExponent: number;
  documentDiscountMode: string;
  documentDiscountAmountMinor: string;
  orderNumber: string | null;
  /** `TAX_EXCLUSIVE` | `TAX_INCLUSIVE` — how the order's unit prices relate to VAT */
  taxPriceMode?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PosOrderLineRow {
  id: string;
  orderId: string;
  linePosition: number;
  productId: string;
  variantId: string;
  /** decimal string, up to 4 dp */
  quantity: string;
  unitPriceAmountMinor: string;
  unitPriceCurrencyCode: string;
  discountMode: string;
  discountAmountMinor: string;
  taxCategoryKey: string | null;
  rateBps: number | null;
  lineTaxAmountMinor: string | null;
  productNameEnSnapshot: string;
  productNameArSnapshot: string | null;
  variantNameEnSnapshot: string;
  variantNameArSnapshot: string | null;
  skuSnapshot: string | null;
  selectedUomCode: string;
  uomDisplayLabelSnapshot: string;
}

export interface OrderInvoiceSummary {
  invoiceId: string;
  invoiceNumber: string;
  /** civil date YYYY-MM-DD */
  invoiceDate: string;
  totalAmountMinor: string;
  invoicePaymentStatus: string;
}

export interface PosOrderWithLines {
  order: PosOrderRow;
  lines: PosOrderLineRow[];
  issuedInvoice?: OrderInvoiceSummary | null;
}

export interface PosOrderPage {
  data: PosOrderRow[];
  nextCursor: string | null;
}

/** one cart line as the server accepts it: NO price, NO tax, NO totals — the server prices every line itself */
export interface PosOrderLineInput {
  productId: string;
  variantId: string;
  selectedUomCode: string;
  /** decimal string, > 0, up to 4 dp */
  quantity: string;
}

export interface PosCreateOrderInput {
  customerId?: string;
  lines: PosOrderLineInput[];
}

export interface PosUpdateOrderInput {
  customerId?: string | null;
  lines?: PosOrderLineInput[];
}

export interface OrderTotalsPreview {
  orderId: string;
  version: number;
  currencyCode: string;
  currencyExponent: number;
  priceTaxMode: string;
  subtotalAmountMinor: string;
  documentDiscountAmountMinor: string;
  taxTotalAmountMinor: string;
  totalAmountMinor: string;
}

export type PosTenderMethod = 'CASH' | 'CARD_TERMINAL' | 'BANK_TRANSFER' | 'OTHER_MANUAL';

export interface PosTender {
  method: PosTenderMethod;
  /** positive integer minor units, as a decimal string */
  amountMinor: string;
}

/** one CustomerAdvance spent against THIS sale (the target receivable is the sale's own; currency is never a client field) */
export interface PosSaleAdvanceApplication {
  advanceId: string;
  amountMinor: string;
}

/**
 * The body of `complete-sale`. The order's persisted customer decides the anonymous or customer path (there is no mode flag and no customer
 * field). `ON_CREDIT` leaves the unpaid remainder as the customer's receivable; `advanceApplications` spends the customer's advances;
 * `creditLimitExceptionReason` is a REASON ONLY — the server decides whether an override is needed and whether the actor may grant it
 * (owner permission + step-up); a reason alone authorises nothing.
 */
export interface PosCompleteSaleInput {
  paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
  tenders: PosTender[];
  advanceApplications?: PosSaleAdvanceApplication[];
  creditLimitExceptionReason?: string;
}

/** `GET …/customers/:customerId/account/summary` (receivables:view) — every money value is a decimal STRING in minor units */
export interface PosCustomerAccountSummary {
  customerCompanyAccountId: string;
  currencyCode: string;
  currencyExponent: number;
  branchFinancials: {
    receivableOutstandingMinor: string;
    advanceAvailableMinor: string;
    unappliedReceiptMinor: string;
    openReceivableCount: number;
    openAdvanceCount: number;
  };
  credit: {
    scope: string;
    creditEnabled: boolean;
    creditLimitMinor: string | null;
    creditExposureMinor: string;
    availableCreditMinor: string | null;
    projectionIntegrity: string;
  };
  asOf: string;
}

/** `GET …/customers/:customerId/account/advances` row — `availableAmountMinor` is what may be applied NOW */
export interface PosCustomerAdvanceRow {
  customerAdvanceId: string;
  /** where the advance came from (display only — the till never branches on it) */
  sourceType: string;
  sourcePaymentId: string | null;
  originalAmountMinor: string;
  appliedAmountMinor: string;
  reservedAmountMinor: string;
  availableAmountMinor: string;
  currencyCode: string;
  currencyExponent: number;
  openingEffectiveDate: string | null;
  createdAt: string;
}

export interface PosCustomerAdvancePage {
  data: PosCustomerAdvanceRow[];
  nextCursor: string | null;
}

/** `GET …/customers/:customerId/account/receivables` — OPEN receivables only (every row has something outstanding); money = decimal STRINGS in minor units */
export interface PosCustomerReceivableRow {
  customerReceivableId: string;
  /** INVOICE for a sale on credit; any other value is an opening balance or another charge (shown generically — the till never branches on it) */
  sourceType: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  sourceDate: string;
  originalAmountMinor: string;
  paidByPaymentMinor: string;
  paidByAdvanceMinor: string;
  outstandingMinor: string;
  currencyCode: string;
  currencyExponent: number;
  createdAt: string;
  openingNote: string | null;
  ageDays: number;
}

export interface PosCustomerReceivablePage {
  data: PosCustomerReceivableRow[];
  nextCursor: string | null;
}

/** `GET …/account/statement` line — three server-computed effects; `refs` are server ids (payment, allocation, receivable, advance …) */
export interface PosCustomerStatementLine {
  customerAccountEntryId: string;
  entryKind: string;
  financialDate: string;
  occurredAt: string;
  receivableEffectMinor: string;
  advanceEffectMinor: string;
  unappliedReceiptEffectMinor: string;
  refs: Record<string, string | null>;
}

export interface PosCustomerStatementOpening {
  asOfDate: string;
  receivableOutstandingMinor: string;
  advanceAvailableMinor: string;
  unappliedReceiptMinor: string;
}

export interface PosCustomerStatementPage {
  data: PosCustomerStatementLine[];
  nextCursor: string | null;
  openingState: PosCustomerStatementOpening | null;
}

/** money received from the customer that is not (yet) allocated to an invoice or an advance */
export interface PosCustomerUnappliedReceiptRow {
  paymentId: string;
  method: string;
  receiptPurpose: string;
  originalAmountMinor: string;
  consumedAmountMinor: string;
  unappliedAmountMinor: string;
  currencyCode: string;
  currencyExponent: number;
  createdAt: string;
}

export interface PosCustomerUnappliedReceiptPage {
  data: PosCustomerUnappliedReceiptRow[];
  nextCursor: string | null;
}

/**
 * The ONLY tender methods the frozen collection contract accepts. Card is deliberately NOT one of them (the contract cannot tell a local
 * terminal from a provider-integrated one for this route), so the till never offers it for a collection.
 */
export type PosCollectMethod = 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL';

/** the body of `POST …/customers/:customerId/receipts`: the amount and how it was tendered — the server picks the invoices (oldest first) */
export interface PosCustomerReceiptInput {
  amountMinor: string;
  method: PosCollectMethod;
}

export interface PosCustomerReceiptResult {
  paymentId: string;
  paymentAttemptId: string;
  amountMinor: string;
  allocatedAmountMinor: string;
  unallocatedAmountMinor: string;
  currencyCode: string;
  currencyExponent: number;
  allocations: { receivableId: string; sourceType: string; amountMinor: string }[];
}

export interface PosCompleteSaleResponse {
  order: { id: string; orderNumber: string };
  invoice: {
    id: string;
    invoiceNumber: string;
    currencyCode: string;
    currencyExponent: number;
    subtotalAmountMinor: string;
    documentDiscountAmountMinor: string;
    taxTotalAmountMinor: string;
    totalAmountMinor: string;
    paymentStatus: string;
  };
  paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
  outstandingMinor: string;
  paymentGroupId: string | null;
  payments: {
    paymentId: string;
    paymentAttemptId: string;
    paymentAllocationId: string;
    method: string;
    amountMinor: string;
  }[];
  advanceApplications: { applicationId: string; advanceId: string; amountMinor: string }[];
  customerReceivableId: string | null;
}

export interface PosInvoiceRow {
  id: string;
  companyId: string;
  branchId: string;
  orderId: string;
  invoiceNumber: string;
  issuedAt: string;
  invoiceDate: string;
  customerDisplayNameSnapshot: string | null;
  currencyCode: string;
  currencyExponent: number;
  subtotalAmountMinor: string;
  documentDiscountAmountMinor: string;
  taxTotalAmountMinor: string;
  totalAmountMinor: string;
  invoicePaymentStatus: string;
}

export interface PosCustomerRow {
  id: string;
  displayName: string;
  phoneE164: string | null;
  emailNormalized: string | null;
  status: string;
  version: number;
}

export interface PosCustomerPage {
  data: PosCustomerRow[];
  nextCursor: string | null;
}

export interface OrgCompanyRow {
  id: string;
  legalNameEn: string;
  legalNameAr?: string | null;
  trn?: string | null;
  registeredAddress?: string | null;
  defaultCurrency?: string | null;
  countryCode?: string | null;
}

export interface OrgBranchRow {
  id: string;
  companyId: string;
  name: string;
  timezone?: string;
}

/**
 * The Sales Financial Report (`GET .../reports/sales`) — a read-only mirror of the server's frozen response. Every amount is an integer-minor-units
 * string (never a JS number). The server needs three read permissions (orders / returns / receivables views) and unrestricted branch authority for
 * the company-wide route. This mirror carries ONLY the issued-invoice figures: the frozen HG17 guard keeps return-document wording out of client
 * code, so the server's returns blocks are deliberately not mirrored (and not shown). It is invoiced sales by accounting date: not stock, not profit.
 */
export interface SalesReport {
  companyId: string;
  currencyCode: string;
  currencyExponent: number;
  accountingTimezone: string;
  /** inclusive civil dates, YYYY-MM-DD */
  from: string;
  to: string;
  invoices: {
    invoiceCount: number;
    invoicedSubtotalMinor: string;
    lineDiscountMinor: string;
    documentDiscountMinor: string;
    outputTaxMinor: string;
    invoicedTotalMinor: string;
    salesNetExTaxMinor: string;
  };
  currentPaymentStatusBreakdown: {
    note: string;
    statuses: { status: string; count: number; invoiceTotalMinor: string }[];
  };
  reconciliation: { reconciled: boolean };
  /** company-wide route only */
  byBranch?: ({ branchId: string } & Pick<SalesReport, 'invoices'>)[];
  /** branch route only */
  branchId?: string;
}

/** the seller identity printed on a receipt (read with the cashier's own `orders:view` + company/branch scope) */
export interface ReceiptIdentity {
  companyId: string;
  branchId: string;
  branchName: string;
  legalNameEn: string;
  legalNameAr: string | null;
  trn: string | null;
  registeredAddress: string | null;
  countryCode: string | null;
  currency: string | null;
}

/**
 * `GET /v1/companies/:companyId/customers/:id/account` — the customer's COMPANY-level credit configuration. `version` is the optimistic-concurrency
 * token the credit PATCH requires (`If-Match`). `creditLimitMinor` is `null` when no limit is stored: with credit enabled that means NO numeric
 * ceiling (the server's rule, not the client's).
 */
export interface CustomerCreditAccount {
  id: string;
  customerId: string;
  companyId: string;
  creditEnabled: boolean;
  creditLimitMinor: string | null;
  creditLimitCurrencyCode: string | null;
  creditLimitCurrencyExponent: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * `PATCH …/customers/:id/account/credit` body. The server accepts exactly these two keys; there is NO way to clear a stored limit (an omitted
 * `creditLimitMinor` keeps whatever is stored), and the currency is always the company's — the client never sends one.
 */
export interface ConfigureCustomerCreditInput {
  creditEnabled: boolean;
  /** a positive integer in minor units, as a digit string */
  creditLimitMinor?: string;
}

export interface ReceivablesFiguresBlock {
  receivableCount: number;
  originalMinor: string;
  paidByPaymentMinor: string;
  paidByAdvanceMinor: string;
  creditedMinor: string;
  outstandingMinor: string;
}

/** one customer's aggregate in the receivables report — identifiers and money only (the name is read separately from the customer route) */
export interface ReceivablesCustomerRow extends ReceivablesFiguresBlock {
  customerId: string;
}

export interface ReceivablesReconciliationBlock {
  sourceOutstandingMinor: string;
  glAccountsReceivableMinor: string;
  differenceMinor: string;
  reconciled: boolean;
}

/** `GET …/reports/receivables` (company or one branch) — the CURRENT state at `asOf`, never a historical period; no due dates or terms exist in it */
export interface ReceivablesReport extends ReceivablesFiguresBlock {
  companyId: string;
  currencyCode: string;
  currencyExponent: number;
  accountingTimezone: string;
  asOf: string;
  customerId: string | null;
  /** present on the one-branch report */
  branchId?: string;
  note: string;
  reconciliation: ReceivablesReconciliationBlock;
  /** present on the company report: one row per branch holding a receivable */
  byBranch?: (ReceivablesFiguresBlock & {
    branchId: string;
    reconciliation: ReceivablesReconciliationBlock;
  })[];
  customers: { rows: ReceivablesCustomerRow[]; nextCursor: string | null };
}
