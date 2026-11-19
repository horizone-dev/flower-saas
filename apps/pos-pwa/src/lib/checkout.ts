import type { PosCompleteSaleInput, PosCompleteSaleResponse, PosTender } from '@flower/api-client';
import { saleFingerprint } from './credit-plan';
import { tendersFingerprint } from './tender';

/**
 * CHECKOUT ATTEMPT STATE — what makes a retry SAFE. A till on a flaky network must be able to press "Pay" again after a timeout without ever
 * selling twice or creating a second order. Both server calls are idempotent (`Idempotency-Key`): this module owns the keys.
 *
 *  - the ORDER-create key lives as long as the cart/customer fingerprint is unchanged (a retry replays the same order);
 *  - the COMPLETE-SALE key is bound to the exact tenders (a retry of the SAME payment replays; a DIFFERENT payment gets a new key — the server
 *    would otherwise answer an idempotency conflict);
 *  - once a draft order exists and the cart changes, the same draft is UPDATED (PATCH) instead of leaving orphan drafts behind;
 *  - after a successful sale the attempt is finished: the next sale starts a fresh attempt.
 *
 * Pure: the id generator is injected, so tests are deterministic.
 */

export interface CheckoutAttempt {
  /** cart + customer fingerprint the draft order currently reflects (`null` until the order is created) */
  orderFingerprint: string | null;
  createKey: string;
  orderId: string | null;
  orderVersion: number | null;
  /** tendersFingerprint → Idempotency-Key */
  completeKeys: Readonly<Record<string, string>>;
  sale: PosCompleteSaleResponse | null;
}

export function newAttempt(uuid: () => string): CheckoutAttempt {
  return {
    orderFingerprint: null,
    createKey: uuid(),
    orderId: null,
    orderVersion: null,
    completeKeys: {},
    sale: null,
  };
}

export type OrderStep = 'CREATE' | 'UPDATE' | 'REUSE' | 'FINISHED';

/** what must be done to make the server's draft order match the cart now */
export function orderStep(attempt: CheckoutAttempt, fingerprint: string): OrderStep {
  if (attempt.sale) return 'FINISHED';
  if (attempt.orderId === null) return 'CREATE';
  return attempt.orderFingerprint === fingerprint ? 'REUSE' : 'UPDATE';
}

export function withOrder(
  attempt: CheckoutAttempt,
  order: { id: string; version: number },
  fingerprint: string,
): CheckoutAttempt {
  return {
    ...attempt,
    orderId: order.id,
    orderVersion: order.version,
    orderFingerprint: fingerprint,
  };
}

/** the key for completing THIS payment: the same tenders always get the same key; different tenders get a new one */
export function completeKeyFor(
  attempt: CheckoutAttempt,
  tenders: readonly PosTender[],
  uuid: () => string,
): { attempt: CheckoutAttempt; key: string } {
  const fp = tendersFingerprint(tenders);
  const existing = attempt.completeKeys[fp];
  if (existing) return { attempt, key: existing };
  const key = uuid();
  return { attempt: { ...attempt, completeKeys: { ...attempt.completeKeys, [fp]: key } }, key };
}

/**
 * the key for completing THIS sale: bound to the WHOLE request (intent, tenders, advances, credit reason). The same payment always gets the same
 * key (a retry replays); any change gets a new one; an earlier payment's key is kept, so going back to it replays it.
 */
export function completeKeyForSale(
  attempt: CheckoutAttempt,
  request: PosCompleteSaleInput,
  uuid: () => string,
): { attempt: CheckoutAttempt; key: string } {
  const fp = saleFingerprint(request);
  const existing = attempt.completeKeys[fp];
  if (existing) return { attempt, key: existing };
  const key = uuid();
  return { attempt: { ...attempt, completeKeys: { ...attempt.completeKeys, [fp]: key } }, key };
}

export function withSale(attempt: CheckoutAttempt, sale: PosCompleteSaleResponse): CheckoutAttempt {
  return { ...attempt, sale };
}

/** the cashier-facing reading of an API error code at checkout (the code itself stays visible for support) */
export function checkoutErrorMessage(
  code: string,
  status: number,
  /** what the attempted sale used — lets a bare 403 name the authority that is probably missing */
  ctx?: { usedAdvance?: boolean; usedCredit?: boolean },
): string {
  switch (code) {
    // ── customer credit (frozen sale contract; the server decides every one of these) ──
    case 'CUSTOMER_CREDIT_DISABLED':
      return 'Credit is not enabled for this customer. Take payment now, or ask the owner to enable credit.';
    case 'CUSTOMER_CREDIT_LIMIT_EXCEEDED':
      return 'This sale would go over the customer’s credit limit. Take a part payment now, or ask the owner to approve an exception.';
    case 'SALE_ON_CREDIT_FULLY_COVERED':
      return 'The advance and payment already cover the whole total — choose Pay now instead of On credit.';
    case 'SALE_CREDIT_REQUIRES_CUSTOMER':
    case 'SALE_ADVANCE_REQUIRES_CUSTOMER':
    case 'SALE_ORDER_NOT_CUSTOMER_LINKED':
    case 'SALE_CUSTOMER_INVALID':
      return 'Select the customer before selling on credit or using an advance.';
    case 'STEP_UP_REQUIRED':
      return 'This needs a fresh verification code. Confirm your identity with your verification code, then try again.';
    case 'CREDIT_OVERRIDE_DENIED':
      return 'Only an owner can approve a credit-limit exception.';
    case 'CREDIT_OVERRIDE_REASON_REQUIRED':
      return 'Enter the reason for the credit exception.';
    case 'CREDIT_OVERRIDE_REASON_TOO_LONG':
      return 'The reason for the credit exception is too long.';
    case 'CUSTOMER_CREDIT_CURRENCY_MISMATCH':
      return 'The customer’s credit account uses a different currency.';
    // ── advances ──
    case 'CUSTOMER_ADVANCE_NOT_FOUND':
    case 'CUSTOMER_ADVANCE_APPLICATION_INVALID':
    case 'SALE_ADVANCE_INVALID':
      return 'That advance is no longer available (it may have been used elsewhere). Reload the customer account and choose again.';
    case 'SALE_DUPLICATE_ADVANCE':
      return 'The same advance was entered twice.';
    case 'CUSTOMER_ADVANCE_APPLICATION_CROSS_BRANCH_NOT_ALLOWED':
      return 'This advance belongs to another branch and cannot be used here.';
    case 'ORDER_VERSION_CONFLICT':
    case 'ORDER_VERSION_REQUIRED':
    case 'ORDER_INVALID_STATE_TRANSITION':
      return 'This order was changed or already completed elsewhere. Check the sales list before retrying.';
    case 'SALE_OVERPAYMENT_NOT_ALLOWED':
    case 'PAYMENT_INVALID_AMOUNT':
    case 'SALE_NOT_FULLY_RESOLVED':
      return 'The payment does not match the order total. Check the amounts.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This payment was already submitted with different details. Start the payment again.';
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'This sale is still being processed. Wait a few seconds, then check the sales list.';
    case 'SALE_ZERO_TOTAL_NOT_SUPPORTED':
      return 'A zero-value sale cannot be completed here.';
    case 'NO_OPEN_ACCOUNTING_PERIOD':
    case 'ACCOUNTING_PERIOD_CLOSED':
      return 'The accounting period for today is not open. Ask the owner to open it — no sale can be recorded until then.';
    case 'ORDER_COMPANY_ACCOUNTING_TIMEZONE_NOT_CONFIGURED':
      return 'The accounting setup of this shop is incomplete. Ask the owner to finish it.';
    case 'ORDER_LINE_TAX_NOT_CONFIGURED':
      return 'A product in the cart has no VAT category. Remove it and ask the owner to set the VAT category (Standard, Zero-rated or Exempt) in Owner Web.';
    case 'ORDER_LINE_QUANTITY_INVALID':
    case 'ORDER_LINE_UOM_INVALID':
      return 'A cart line is invalid (quantity or unit). Fix the cart and try again.';
    default:
      break;
  }
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403 && ctx?.usedAdvance)
    return 'Applying a customer advance needs a manager. Ask a manager to apply it, or take payment another way.';
  if (status === 403) return 'You are not allowed to do this. Ask a manager.';
  if (status === 429) return 'Too many requests — wait a moment and try again.';
  if (status >= 500 || status === 0) {
    return 'The server could not confirm the sale. Do NOT hand over the goods — check the sales list before retrying.';
  }
  return 'The sale could not be completed.';
}
