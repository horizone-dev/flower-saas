import type {
  PosCollectMethod,
  PosCustomerReceiptInput,
  PosCustomerReceiptResult,
  PosCustomerStatementLine,
} from '@flower/api-client';
import { formatMinor } from './money-display';
import type { ReceiptSeller } from './receipt';

/**
 * CUSTOMER ACCOUNT + CREDIT COLLECTION — the POS side of the FROZEN `POST …/customers/:customerId/receipts` contract (task 3b.6 Checkpoint D).
 *
 * WHAT THE SERVER DECIDES (never this module): which invoices the money settles (oldest receivable first, one customer queue), every balance, whether
 * the caller may collect (`receivables:collect`), the idempotent replay, and every identifier. WHAT THIS MODULE DOES: build the request (an amount and a
 * tender method — nothing else can be expressed), preview it, key it so a retry can never collect twice, and ARRANGE the server's answer into a receipt.
 * No financial total that is printed is calculated here.
 *
 * METHODS: the contract accepts CASH, BANK_TRANSFER and OTHER_MANUAL only. CARD is excluded by the contract itself (it cannot tell a local terminal from a
 * provider-integrated one for this route), so the till never offers it for a collection.
 */

export const COLLECT_METHODS: readonly { value: PosCollectMethod; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'OTHER_MANUAL', label: 'Other' },
];

export type CollectRefusal =
  'AMOUNT_REQUIRED' | 'AMOUNT_INVALID' | 'NOTHING_OUTSTANDING' | 'EXCEEDS_OUTSTANDING';

export type CollectionPlan =
  | {
      ok: true;
      request: PosCustomerReceiptInput;
      /** ADVISORY preview only — the receipt and the account show the SERVER's balance */
      remainingAfterMinor: bigint;
    }
  | { ok: false; reason: CollectRefusal };

export function planCollection(i: {
  /** the SERVER's outstanding balance for this customer at this branch */
  outstandingMinor: bigint;
  /** null = nothing entered, undefined = unreadable, otherwise the parsed amount */
  amountMinor: bigint | null | undefined;
  method: PosCollectMethod;
}): CollectionPlan {
  if (i.amountMinor === null) return { ok: false, reason: 'AMOUNT_REQUIRED' };
  if (i.amountMinor === undefined || i.amountMinor <= 0n)
    return { ok: false, reason: 'AMOUNT_INVALID' };
  if (i.outstandingMinor <= 0n) return { ok: false, reason: 'NOTHING_OUTSTANDING' };
  // an excess would not settle anything: the server would keep it as unallocated customer money, which this till does not offer
  if (i.amountMinor > i.outstandingMinor) return { ok: false, reason: 'EXCEEDS_OUTSTANDING' };
  return {
    ok: true,
    request: { amountMinor: i.amountMinor.toString(), method: i.method },
    remainingAfterMinor: i.outstandingMinor - i.amountMinor,
  };
}

export const COLLECT_REFUSAL_TEXT: Record<CollectRefusal, string> = {
  AMOUNT_REQUIRED: 'Enter the amount received.',
  AMOUNT_INVALID: 'Enter a valid amount greater than zero.',
  NOTHING_OUTSTANDING: 'This customer owes nothing at this branch.',
  EXCEEDS_OUTSTANDING: 'That is more than the customer owes. Enter the amount they owe or less.',
};

// ── idempotency ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CollectAttempt {
  /** exact collection (customer + amount + method) → its Idempotency-Key */
  keys: Readonly<Record<string, string>>;
}

export const newCollectAttempt = (): CollectAttempt => ({ keys: {} });

/** the identity of one collection: customer, amount, method */
export function collectFingerprint(customerId: string, r: PosCustomerReceiptInput): string {
  return `${customerId}|${r.amountMinor}|${r.method}`;
}

/**
 * The key for THIS exact collection: a retry always gets the same key (the server replays the first answer, it never collects twice); a changed
 * amount or method is a different collection and gets a new key. After a collection SUCCEEDS the caller starts a fresh attempt, so collecting the same
 * amount again is a second payment on purpose.
 */
export function collectKeyFor(
  attempt: CollectAttempt,
  customerId: string,
  request: PosCustomerReceiptInput,
  uuid: () => string,
): { attempt: CollectAttempt; key: string } {
  const fp = collectFingerprint(customerId, request);
  const existing = attempt.keys[fp];
  if (existing) return { attempt, key: existing };
  const key = uuid();
  return { attempt: { keys: { ...attempt.keys, [fp]: key } }, key };
}

// ── display of server figures (no arithmetic on money) ─────────────────────────────────────────────────────────────

/** UNPAID when nothing has been paid on it, PART PAID when some has — from the server's own original / outstanding figures */
export function receivableStatus(r: {
  originalAmountMinor: string;
  outstandingMinor: string;
}): 'UNPAID' | 'PART PAID' {
  return r.outstandingMinor === r.originalAmountMinor ? 'UNPAID' : 'PART PAID';
}

const STATEMENT_LABEL: Record<string, string> = {
  INVOICE: 'Invoice',
  PAYMENT: 'Payment received',
  PAYMENT_ALLOCATION: 'Payment applied to invoice',
  ADVANCE: 'Advance received',
  ADVANCE_APPLIED: 'Advance applied',
  OPENING_RECEIVABLE: 'Opening balance',
  OPENING_ADVANCE: 'Opening advance',
  OPENING_RECEIVABLE_PAYMENT_APPLIED: 'Payment applied to opening balance',
};

/** plain words for a statement entry kind; a kind this till has no wording for is shown from its own name, never hidden */
export function statementLabel(kind: string): string {
  const known = STATEMENT_LABEL[kind];
  if (known) return known;
  const words = kind.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** the statement entries where money received was applied against what the customer owed (a payment history) */
export function paymentLines(
  lines: readonly PosCustomerStatementLine[],
): PosCustomerStatementLine[] {
  return lines.filter(
    (l) =>
      l.entryKind === 'PAYMENT_ALLOCATION' || l.entryKind === 'OPENING_RECEIVABLE_PAYMENT_APPLIED',
  );
}

// ── the collection receipt ─────────────────────────────────────────────────────────────────────────────────────────

export interface CollectionReceiptInput {
  seller: ReceiptSeller;
  branchName: string | null;
  customerName: string;
  method: PosCollectMethod;
  /** the SERVER's answer to the collection */
  result: PosCustomerReceiptResult;
  /** the open receivables the server listed BEFORE the collection — only to put an invoice number next to each allocation */
  receivables: readonly {
    customerReceivableId: string;
    invoiceNumber: string | null;
    sourceType: string;
  }[];
  /** the SERVER's outstanding balance after the collection (null when it could not be read — then none is shown) */
  balanceAfterMinor: string | null;
  /** the server's clock when the account was re-read (an ISO instant), or null */
  asOf: string | null;
  copy: 'ORIGINAL' | 'COPY';
}

export interface CollectionReceiptModel {
  title: 'PAYMENT RECEIPT';
  copy: 'ORIGINAL' | 'COPY';
  seller: ReceiptSeller;
  branchName: string | null;
  customerName: string;
  /** the server's payment id — the authoritative reference (the server issues no separate receipt number) */
  reference: string;
  date: string | null;
  method: string;
  currency: string;
  exponent: number;
  amount: string;
  allocations: { reference: string; amount: string }[];
  unallocated: string | null;
  balanceAfter: string | null;
}

const methodText = (m: PosCollectMethod): string =>
  COLLECT_METHODS.find((x) => x.value === m)?.label ?? m;

export function buildCollectionReceipt(i: CollectionReceiptInput): CollectionReceiptModel {
  const exp = i.result.currencyExponent;
  const fmt = (m: string): string => formatMinor(m, exp);
  const byId = new Map(i.receivables.map((r) => [r.customerReceivableId, r]));
  return {
    title: 'PAYMENT RECEIPT',
    copy: i.copy,
    seller: i.seller,
    branchName: i.branchName,
    customerName: i.customerName,
    reference: i.result.paymentId,
    date: i.asOf === null ? null : `${i.asOf.slice(0, 10)} ${i.asOf.slice(11, 16)} UTC`,
    method: methodText(i.method),
    currency: i.result.currencyCode,
    exponent: exp,
    amount: fmt(i.result.amountMinor),
    allocations: i.result.allocations.map((a) => {
      const r = byId.get(a.receivableId);
      const reference = r?.invoiceNumber ?? 'Customer account';
      return { reference, amount: fmt(a.amountMinor) };
    }),
    unallocated:
      BigInt(i.result.unallocatedAmountMinor) > 0n ? fmt(i.result.unallocatedAmountMinor) : null,
    balanceAfter: i.balanceAfterMinor === null ? null : fmt(i.balanceAfterMinor),
  };
}

/** fixed-width plain text (thermal printer, tests). Shows only what the SERVER reported; it makes no claim about any cash register or drawer */
export function collectionReceiptText(m: CollectionReceiptModel, width = 42): string[] {
  const out: string[] = [];
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s;
  const pair = (l: string, r: string) =>
    l + ' '.repeat(Math.max(1, width - l.length - r.length)) + r;
  const rule = '-'.repeat(width);
  if (m.seller.name) out.push(center(m.seller.name));
  if (m.branchName) out.push(center(m.branchName));
  if (m.seller.address) out.push(center(m.seller.address));
  if (m.seller.trn) out.push(center(`TRN ${m.seller.trn}`));
  out.push(center(m.title + (m.copy === 'COPY' ? ' (COPY)' : '')));
  out.push(rule);
  out.push(pair('Reference', m.reference.slice(0, 8)));
  if (m.date) out.push(pair('Date', m.date));
  out.push(pair('Customer', m.customerName));
  out.push(rule);
  out.push(pair(`Received (${m.method})`, `${m.currency} ${m.amount}`));
  if (m.allocations.length > 0) {
    out.push('Applied to');
    for (const a of m.allocations) out.push(pair(`  ${a.reference}`, a.amount));
  }
  if (m.unallocated) out.push(pair('Not applied to an invoice', m.unallocated));
  out.push(rule);
  if (m.balanceAfter !== null) out.push(pair('Balance after', `${m.currency} ${m.balanceAfter}`));
  return out;
}

// ── refusals in words ──────────────────────────────────────────────────────────────────────────────────────────────

export function collectErrorMessage(code: string, status: number): string {
  switch (code) {
    case 'PAYMENT_INVALID_AMOUNT':
      return 'The amount is not valid. Enter an amount greater than zero.';
    case 'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT':
    case 'PAYMENT_TENDER_METHOD_UNSUPPORTED':
      return 'That payment method cannot be taken here. Use cash, bank transfer or other.';
    case 'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND':
      return 'This customer has no account at this company. Check the customer.';
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'This payment is already being recorded. Wait a moment, then press Confirm again — it will not be taken twice.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This payment was already recorded with different details. Reload the customer’s account and check what was received.';
    case 'VALIDATION_FAILED':
      return 'Please check the amount and the method.';
    default:
  }
  if (status === 0)
    return 'Connection problem — the payment may or may not have been recorded. Press Confirm again to retry safely (the same payment is never taken twice), or check the customer’s account before taking the money again.';
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return 'You are not allowed to collect payments. Ask a manager.';
  if (status === 404) return 'The customer or the account was not found at this branch.';
  if (status >= 500)
    return 'Something went wrong on the server. Check the customer’s account before taking the money again — the payment may have been recorded.';
  return 'The payment could not be recorded. Check the customer’s account and try again.';
}

/** a statement effect with the SERVER's sign (+ / −) and its exact amount; a zero effect shows a dash */
export function signedMinor(minor: string, exponent: number): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  if (/^0+$/.test(digits)) return '—';
  return `${negative ? '−' : '+'}${formatMinor(digits, exponent)}`;
}
