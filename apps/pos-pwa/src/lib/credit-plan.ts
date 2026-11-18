import type {
  PosCompleteSaleInput,
  PosCustomerAccountSummary,
  PosCustomerAdvanceRow,
  PosTender,
} from '@flower/api-client';
import { planTenders, type TenderRefusal } from './tender';

/**
 * CUSTOMER CREDIT AND ADVANCE PAYMENTS — builds the body of the FROZEN `complete-sale` contract (task 3b.9) from the cashier's choices.
 *
 * WHAT THIS IS NOT: a second implementation of any rule. The SERVER decides the total, whether the customer may buy on credit, whether the
 * credit limit is exceeded, whether an advance is still available, who may apply an advance (`receivables:advance:apply`) and who may override a
 * limit (`customers:credit:override` + step-up). Every refusal below is an ADVISORY PREVIEW of a rule the server enforces again, so a cashier
 * sees the problem before pressing Pay; if the preview and the server ever disagree, the server wins and its refusal is shown.
 *
 * WHAT IT DOES: integer (BigInt) arithmetic over minor units, no floats, no rounding, no change-making — the sale contract is EXACT:
 *
 *   total = advances applied + paid now (tenders) + on credit
 *
 *  - PAY_NOW   advances + tenders must equal the total; an advance that covers the whole total is an advance-only sale (no tender);
 *  - ON_CREDIT an identified customer; optional advances and an optional deposit tender; the remainder (> 0) is the customer's receivable;
 *  - the request has ONLY `paymentIntent`, `tenders`, `advanceApplications` and (ON_CREDIT only) a credit-exception REASON. No scope, no
 *    customer, no currency, no money authority, no override flag can be expressed (the server's DTO is strict and would refuse them).
 */

export type SettleMode = 'CASH' | 'CARD' | 'SPLIT' | 'CREDIT';

export interface AdvanceChoice {
  advanceId: string;
  /** what the server reported as applicable now (display / advisory only) */
  availableMinor: bigint;
  /** what the cashier chose to spend on THIS sale (0 = not used) */
  applyMinor: bigint;
}

export interface CustomerPaymentInput {
  /** the SERVER's total for the order (from the totals preview) */
  totalMinor: bigint;
  /** an identified customer is attached to the order (credit and advances need one) */
  hasCustomer: boolean;
  advances: readonly AdvanceChoice[];
  mode: SettleMode;
  /** CASH / SPLIT: what the customer handed over in cash */
  cashTenderedMinor: bigint | null;
  /** SPLIT: the part paid by card */
  cardMinor: bigint | null;
  /** CREDIT: an optional amount paid now */
  depositMinor: bigint | null;
  depositMethod: 'CASH' | 'CARD';
  /** CREDIT: the reason for a credit-limit exception (a REASON only — it authorises nothing) */
  creditReason: string | null;
}

export type CreditRefusal =
  | TenderRefusal
  | 'CUSTOMER_REQUIRED'
  | 'ADVANCE_INVALID'
  | 'ADVANCE_DUPLICATE'
  | 'ADVANCE_EXCEEDS_AVAILABLE'
  | 'ADVANCE_EXCEEDS_TOTAL'
  | 'DEPOSIT_INVALID'
  | 'CREDIT_FULLY_COVERED';

export interface PaymentFigures {
  totalMinor: bigint;
  advanceMinor: bigint;
  payNowMinor: bigint;
  creditMinor: bigint;
}

export type CustomerPaymentPlan =
  | {
      ok: true;
      request: PosCompleteSaleInput;
      figures: PaymentFigures;
      /** CASH / SPLIT: the cash that stays in the till; and the counting aid (never recorded) */
      cashDueMinor: bigint;
      changeDueMinor: bigint;
    }
  | { ok: false; reason: CreditRefusal };

export function planCustomerPayment(i: CustomerPaymentInput): CustomerPaymentPlan {
  if (i.totalMinor <= 0n) return { ok: false, reason: 'TOTAL_NOT_POSITIVE' };

  // ── advances: only the ones actually spent, validated, then in the server's canonical (ascending id) order ──
  const chosen = i.advances.filter((a) => a.applyMinor !== 0n);
  if (chosen.some((a) => a.applyMinor < 0n)) return { ok: false, reason: 'ADVANCE_INVALID' };
  if (chosen.length > 0 && !i.hasCustomer) return { ok: false, reason: 'CUSTOMER_REQUIRED' };
  if (new Set(chosen.map((a) => a.advanceId)).size !== chosen.length)
    return { ok: false, reason: 'ADVANCE_DUPLICATE' };
  if (chosen.some((a) => a.applyMinor > a.availableMinor))
    return { ok: false, reason: 'ADVANCE_EXCEEDS_AVAILABLE' };
  const advanceMinor = chosen.reduce((s, a) => s + a.applyMinor, 0n);
  if (advanceMinor > i.totalMinor) return { ok: false, reason: 'ADVANCE_EXCEEDS_TOTAL' };
  const advanceApplications = [...chosen]
    .sort((a, b) => (a.advanceId < b.advanceId ? -1 : a.advanceId > b.advanceId ? 1 : 0))
    .map((a) => ({ advanceId: a.advanceId, amountMinor: a.applyMinor.toString() }));
  const payable = i.totalMinor - advanceMinor;

  const withAdvances = (r: PosCompleteSaleInput): PosCompleteSaleInput =>
    advanceApplications.length > 0 ? { ...r, advanceApplications } : r;

  // ── ON CREDIT ──
  if (i.mode === 'CREDIT') {
    if (!i.hasCustomer) return { ok: false, reason: 'CUSTOMER_REQUIRED' };
    const deposit = i.depositMinor ?? 0n;
    if (deposit < 0n || deposit > payable) return { ok: false, reason: 'DEPOSIT_INVALID' };
    const creditMinor = payable - deposit;
    if (creditMinor <= 0n) return { ok: false, reason: 'CREDIT_FULLY_COVERED' };
    const tenders: PosTender[] =
      deposit > 0n
        ? [
            {
              method: i.depositMethod === 'CARD' ? 'CARD_TERMINAL' : 'CASH',
              amountMinor: deposit.toString(),
            },
          ]
        : [];
    const reason = i.creditReason?.trim() ?? '';
    const request = withAdvances({
      paymentIntent: 'ON_CREDIT',
      tenders,
      ...(reason !== '' ? { creditLimitExceptionReason: reason } : {}),
    });
    return {
      ok: true,
      request,
      figures: { totalMinor: i.totalMinor, advanceMinor, payNowMinor: deposit, creditMinor },
      cashDueMinor: i.depositMethod === 'CASH' ? deposit : 0n,
      changeDueMinor: 0n,
    };
  }

  // ── PAY NOW (cash / card / split) on what the advances left ──
  if (payable === 0n) {
    return {
      ok: true,
      request: withAdvances({ paymentIntent: 'PAY_NOW', tenders: [] }),
      figures: { totalMinor: i.totalMinor, advanceMinor, payNowMinor: 0n, creditMinor: 0n },
      cashDueMinor: 0n,
      changeDueMinor: 0n,
    };
  }
  const tp = planTenders({
    totalMinor: payable,
    mode: i.mode,
    cashTenderedMinor: i.cashTenderedMinor,
    cardMinor: i.cardMinor,
  });
  if (!tp.ok) return { ok: false, reason: tp.reason };
  return {
    ok: true,
    request: withAdvances({ paymentIntent: 'PAY_NOW', tenders: tp.tenders }),
    figures: { totalMinor: i.totalMinor, advanceMinor, payNowMinor: payable, creditMinor: 0n },
    cashDueMinor: tp.cashDueMinor,
    changeDueMinor: tp.changeDueMinor,
  };
}

/**
 * A stable fingerprint of the WHOLE payment — intent, tenders (request order), advances (canonical order) and the credit reason. The
 * Idempotency-Key of `complete-sale` is bound to it: the SAME payment always replays; any change (an amount, a method, an advance, the reason)
 * gets a new key, because the server would otherwise answer an idempotency conflict for a different body under the same key.
 */
export function saleFingerprint(r: PosCompleteSaleInput): string {
  const tenders = r.tenders.map((t) => `${t.method}:${t.amountMinor}`).join(',');
  const advances = [...(r.advanceApplications ?? [])]
    .sort((a, b) => (a.advanceId < b.advanceId ? -1 : a.advanceId > b.advanceId ? 1 : 0))
    .map((a) => `${a.advanceId}:${a.amountMinor}`)
    .join(',');
  return `${r.paymentIntent}|${tenders}|${advances}|${r.creditLimitExceptionReason ?? ''}`;
}

export type CreditAdvisory =
  | { state: 'UNKNOWN' }
  | { state: 'DISABLED' }
  | { state: 'UNLIMITED' }
  | { state: 'WITHIN'; availableMinor: bigint }
  | { state: 'OVER'; availableMinor: bigint; overByMinor: bigint };

/** a PREVIEW of the credit-limit check for the amount that would go on credit — the server decides (and may need an owner exception) */
export function creditAdvisory(
  summary: Pick<PosCustomerAccountSummary, 'credit'> | null,
  creditMinor: bigint,
): CreditAdvisory {
  if (summary === null) return { state: 'UNKNOWN' };
  if (!summary.credit.creditEnabled) return { state: 'DISABLED' };
  if (summary.credit.availableCreditMinor === null) return { state: 'UNLIMITED' };
  const available = BigInt(summary.credit.availableCreditMinor);
  return creditMinor <= available
    ? { state: 'WITHIN', availableMinor: available }
    : { state: 'OVER', availableMinor: available, overByMinor: creditMinor - available };
}

/** the advances the till may offer: only those with something applicable now, in the order the server sent them */
export function availableAdvances(
  rows: readonly Pick<PosCustomerAdvanceRow, 'customerAdvanceId' | 'availableAmountMinor'>[],
): AdvanceChoice[] {
  return rows
    .filter((r) => BigInt(r.availableAmountMinor) > 0n)
    .map((r) => ({
      advanceId: r.customerAdvanceId,
      availableMinor: BigInt(r.availableAmountMinor),
      applyMinor: 0n,
    }));
}

/** the cashier-facing reading of an advisory refusal (the server's own refusals are read in `checkoutErrorMessage`) */
export const CREDIT_REFUSAL_TEXT: Record<CreditRefusal, string> = {
  TOTAL_NOT_POSITIVE: 'The total must be greater than zero.',
  CASH_TENDER_REQUIRED: 'Enter the cash received.',
  CASH_TENDER_SHORT: 'The cash received is less than the amount due.',
  SPLIT_CARD_INVALID: 'Enter a card amount that is more than 0 and less than the amount due.',
  CUSTOMER_REQUIRED: 'Select the customer first — credit and advances need an identified customer.',
  ADVANCE_INVALID: 'An advance amount is not valid.',
  ADVANCE_DUPLICATE: 'The same advance was entered twice.',
  ADVANCE_EXCEEDS_AVAILABLE: 'An advance amount is more than that advance has available.',
  ADVANCE_EXCEEDS_TOTAL: 'The advances are more than the sale total.',
  DEPOSIT_INVALID: 'The amount paid now must be between 0 and what is left to pay.',
  CREDIT_FULLY_COVERED: 'Nothing would be left on credit — choose Cash, Card or Split instead.',
};
