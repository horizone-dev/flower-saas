import type { ConfigureCustomerCreditInput } from '@flower/api-client';
import { parseMoneyInput } from './catalog-forms';
import { percentOfTotal } from './reports';

/**
 * Pure helpers for the Owner Web customer-credit and receivables pages. NO financial rule lives here: the server decides whether credit is allowed,
 * what the exposure and the available credit are, and which invoices are open. These only turn form text into the strict wire body, choose
 * wording, and format a display ratio with exact integer arithmetic. Every refusal a helper mirrors is advisory — the server always has the last word.
 */

export type CreditChangePlan =
  { ok: true; input: ConfigureCustomerCreditInput } | { ok: false; error: string };

/**
 * The credit form → the body the server accepts (exactly `creditEnabled` and, optionally, a positive `creditLimitMinor`). A blank limit sends no
 * limit key: the server then keeps whatever limit is stored (there is no way to clear one). The currency is never sent — the server uses the company's.
 */
export function planCreditChange(args: {
  enabled: boolean;
  limitText: string;
  exponent: number;
}): CreditChangePlan {
  const text = args.limitText.trim();
  if (text === '') return { ok: true, input: { creditEnabled: args.enabled } };
  const minor = parseMoneyInput(text, args.exponent);
  if (minor === null) {
    return {
      ok: false,
      error: `Enter the limit as a number with at most ${args.exponent} decimals, e.g. 2500.00.`,
    };
  }
  if (BigInt(minor) <= 0n)
    return { ok: false, error: 'The credit limit must be greater than zero.' };
  return { ok: true, input: { creditEnabled: args.enabled, creditLimitMinor: minor } };
}

export type CreditUtilisation =
  | { state: 'OFF' | 'NO_CEILING'; percent: null }
  | { state: 'WITHIN' | 'AT_OR_OVER'; percent: string };

/**
 * How much of the limit the SERVER's exposure uses — a display ratio only. The authoritative "available credit" is the server's own figure and is
 * shown beside it. No limit stored = no numeric ceiling (never a percentage); credit off = off.
 */
export function creditUtilisation(args: {
  enabled: boolean;
  limitMinor: string | null;
  exposureMinor: string;
}): CreditUtilisation {
  if (!args.enabled) return { state: 'OFF', percent: null };
  if (args.limitMinor === null) return { state: 'NO_CEILING', percent: null };
  const percent = percentOfTotal(args.exposureMinor, args.limitMinor);
  return BigInt(args.exposureMinor) >= BigInt(args.limitMinor)
    ? { state: 'AT_OR_OVER', percent }
    : { state: 'WITHIN', percent };
}

export function creditStateLabel(args: { enabled: boolean; limitMinor: string | null }): string {
  if (!args.enabled) return 'Credit is OFF';
  return args.limitMinor === null ? 'Credit is ON — no limit set' : 'Credit is ON — with a limit';
}

/** one clear sentence per refusal the credit PATCH can return; an unknown code is shown as-is so nothing is hidden */
export function creditSaveMessage(code: string, status: number): string {
  switch (code) {
    case 'CUSTOMER_CREDIT_VERSION_CONFLICT':
      return 'These credit settings were changed by someone else since you opened the page. Reload to see the current values, then make your change again.';
    case 'MISSING_PERMISSION':
      return 'Your account does not have permission to change customer credit (it needs the “manage customer credit” permission).';
    case 'IMPERSONATION_READ_ONLY':
      return 'This is a read-only session: credit settings cannot be changed while viewing as another user.';
    case 'MODULE_NOT_ENTITLED':
      return 'Customer credit is not enabled for this workspace.';
    case 'CUSTOMER_CREDIT_LIMIT_INVALID':
      return 'The credit limit must be a positive amount.';
    case 'CUSTOMER_CREDIT_CONFIG_INVALID':
      return 'The credit settings are not valid for this company’s currency. Check the limit and try again.';
    case 'CUSTOMER_CREDIT_CURRENCY_MISMATCH':
      return 'The stored limit is in a different currency from the company’s current currency. Enter the limit again to set it in the current currency.';
    case 'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND':
    case 'CUSTOMER_NOT_FOUND':
    case 'NOT_FOUND':
      return 'This customer was not found for this company.';
    case 'CUSTOMER_ARCHIVED':
      return 'This customer is archived.';
    case 'VALIDATION_FAILED':
      return 'The credit settings were not accepted. Check the values and try again.';
    default:
      return `${code}${status ? ` (${status})` : ''}`;
  }
}

/** the age of an open receivable since its source date — the server's `ageDays`; the contract has no due date or terms, so this is NOT "overdue" */
export function receivableAgeLabel(ageDays: number): string {
  if (ageDays <= 0) return 'today';
  return ageDays === 1 ? '1 day' : `${ageDays} days`;
}

export const RECEIVABLE_AGE_NOTE =
  'Age is counted from the invoice date. The system records no due date or payment terms yet, so it cannot say which balances are overdue.';

/** UNPAID when nothing has been paid on it, PART PAID when some has — from the server's own original and outstanding figures (no arithmetic) */
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

/** plain words for a statement entry kind; a kind with no wording here is shown from its own name, never hidden */
export function statementLabel(kind: string): string {
  const known = STATEMENT_LABEL[kind];
  if (known) return known;
  const words = kind.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** the statement entries where money received was applied against what the customer owed (the payment and allocation history) */
export function isPaymentEntry(kind: string): boolean {
  return kind === 'PAYMENT_ALLOCATION' || kind === 'OPENING_RECEIVABLE_PAYMENT_APPLIED';
}

/**
 * The customers on ONE report page who owe something, largest balance first. The server pages by customer id, so this orders a page for reading
 * only — it never changes a figure and never claims to be a company-wide ranking.
 */
export function owingCustomers<T extends { outstandingMinor: string }>(rows: readonly T[]): T[] {
  return rows
    .filter((r) => BigInt(r.outstandingMinor) > 0n)
    .sort((a, b) => {
      const d = BigInt(b.outstandingMinor) - BigInt(a.outstandingMinor);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
}
