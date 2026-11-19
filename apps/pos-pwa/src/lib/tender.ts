import type { PosTender } from '@flower/api-client';
import { formatMinor } from './money-display';

/**
 * TENDER PLANNING — turns "how the customer pays" into the `tenders` the API accepts. The SERVER decides the total and refuses any tenders
 * that do not add up to it; this only builds the request and the change figure the cashier hands back (integer minor units, no floats).
 *
 *  CASH   one CASH tender for the full total (the customer may hand over MORE; the difference is change, never a payment amount)
 *  CARD   one CARD_TERMINAL tender for the full total (a manual card-slip entry: no card data ever enters this application)
 *  SPLIT  a partial CARD_TERMINAL amount + CASH for the rest
 */

export type PayMode = 'CASH' | 'CARD' | 'SPLIT';

export interface TenderInput {
  /** the SERVER's total for the order (from the totals preview) */
  totalMinor: bigint;
  mode: PayMode;
  /** what the customer handed over in cash (CASH / SPLIT) */
  cashTenderedMinor: bigint | null;
  /** the part paid by card (SPLIT only) */
  cardMinor: bigint | null;
}

export type TenderRefusal =
  'TOTAL_NOT_POSITIVE' | 'CASH_TENDER_REQUIRED' | 'CASH_TENDER_SHORT' | 'SPLIT_CARD_INVALID';

export type TenderPlan =
  | {
      ok: true;
      tenders: PosTender[];
      cashDueMinor: bigint;
      cardMinor: bigint;
      changeDueMinor: bigint;
    }
  | { ok: false; reason: TenderRefusal };

export function planTenders(i: TenderInput): TenderPlan {
  if (i.totalMinor <= 0n) return { ok: false, reason: 'TOTAL_NOT_POSITIVE' };

  if (i.mode === 'CARD') {
    return {
      ok: true,
      tenders: [{ method: 'CARD_TERMINAL', amountMinor: i.totalMinor.toString() }],
      cashDueMinor: 0n,
      cardMinor: i.totalMinor,
      changeDueMinor: 0n,
    };
  }

  let cardMinor = 0n;
  if (i.mode === 'SPLIT') {
    if (i.cardMinor === null || i.cardMinor <= 0n || i.cardMinor >= i.totalMinor) {
      return { ok: false, reason: 'SPLIT_CARD_INVALID' };
    }
    cardMinor = i.cardMinor;
  }
  const cashDue = i.totalMinor - cardMinor;
  if (i.cashTenderedMinor === null) return { ok: false, reason: 'CASH_TENDER_REQUIRED' };
  if (i.cashTenderedMinor < cashDue) return { ok: false, reason: 'CASH_TENDER_SHORT' };

  const tenders: PosTender[] = [{ method: 'CASH', amountMinor: cashDue.toString() }];
  if (cardMinor > 0n) tenders.push({ method: 'CARD_TERMINAL', amountMinor: cardMinor.toString() });
  return {
    ok: true,
    tenders,
    cashDueMinor: cashDue,
    cardMinor,
    changeDueMinor: i.cashTenderedMinor - cashDue,
  };
}

/** a stable fingerprint of a tender list (the idempotency key is bound to the exact payment) */
export function tendersFingerprint(tenders: readonly PosTender[]): string {
  return tenders.map((t) => `${t.method}:${t.amountMinor}`).join('|');
}

/** the quick cash buttons: the exact amount first, then the next round notes above it (display only; exponent-aware) */
export function quickCashAmounts(dueMinor: bigint, exponent: number): bigint[] {
  if (dueMinor <= 0n) return [];
  const unit = 10n ** BigInt(exponent);
  const out = new Set<bigint>([dueMinor]);
  for (const note of [5n, 10n, 20n, 50n, 100n, 200n, 500n, 1000n]) {
    const n = note * unit;
    const up = ((dueMinor + n - 1n) / n) * n;
    if (up > dueMinor) out.add(up);
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 5);
}

/**
 * THE CHANGE AID. The sale contract is EXACT-TENDER: the server records the cash that STAYS in the till (the CASH tender equals the cash part of
 * the total) and has no concept of cash handed over or change. What the customer physically handed over, and the change given back, are therefore
 * NEVER recorded — this is a counting aid for the cashier at the moment of the sale, shown on screen only, never printed on the invoice.
 * (Recording cash-handed-over/change would be a change to the frozen payment/cash-movement contracts and needs an owner + accountant decision.)
 */
export interface ChangeAid {
  handedOver: string;
  recordedCash: string;
  change: string;
}

export function changeAid(
  plan: TenderPlan,
  handedOverMinor: bigint | null,
  exponent: number,
): ChangeAid | null {
  if (!plan.ok || handedOverMinor === null || plan.changeDueMinor <= 0n) return null;
  return {
    handedOver: formatMinor(handedOverMinor, exponent),
    recordedCash: formatMinor(plan.cashDueMinor, exponent),
    change: formatMinor(plan.changeDueMinor, exponent),
  };
}
