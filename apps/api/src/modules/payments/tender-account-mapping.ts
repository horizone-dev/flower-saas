import type { TenderMethod } from './tender.js';

/**
 * Task 3b.6 Checkpoint D hardening pass — the frozen `TenderMethod ->
 * receipt AccountKey` mapping (owner instruction: "use existing account
 * keys where they exist... do NOT invent new account keys"). Inspected
 * directly against `packages/db/src/accounting-reference-data.ts` (task
 * 3b.1's frozen 14/15-account CoA) — every key referenced below already
 * exists there:
 *
 *   ASSET.CASH_ON_HAND       (default code 1000)
 *   ASSET.BANK               (default code 1100)
 *   ASSET.PAYMENT_CLEARING   (default code 1200)
 *
 * Semantic rationale (owner instruction, verbatim reasoning):
 *   - CASH          -> confirmed cash physically becomes cash-on-hand.
 *   - BANK_TRANSFER -> confirmed bank transfer is already bank money.
 *   - CARD_TERMINAL -> funds require later settlement/reconciliation, so
 *                      the controlled clearing bucket, never Bank directly.
 *   - ONLINE_GATEWAY-> same reasoning as CARD_TERMINAL (always
 *                      provider-backed) — Payment Clearing.
 *   - OTHER_MANUAL  -> lacks enough information to claim Cash or Bank
 *                      specifically, so the safe controlled bucket
 *                      (Payment Clearing) is used, never Revenue/AR.
 *
 * This is the ONLY leg of the receipt journal this mapping decides — the
 * OTHER leg is always `LIABILITY.UNAPPLIED_RECEIPTS`, never Revenue, never
 * Accounts Receivable (owner instruction: "Do NOT use Revenue or AR as the
 * receipt debit account" — trivially satisfied since neither ever appears
 * as a value here).
 */
const TENDER_RECEIPT_ACCOUNT_KEY: Readonly<Record<TenderMethod, string>> = Object.freeze({
  CASH: 'ASSET.CASH_ON_HAND',
  BANK_TRANSFER: 'ASSET.BANK',
  CARD_TERMINAL: 'ASSET.PAYMENT_CLEARING',
  ONLINE_GATEWAY: 'ASSET.PAYMENT_CLEARING',
  OTHER_MANUAL: 'ASSET.PAYMENT_CLEARING',
});

/** Throws a plain `RangeError` for any value outside the frozen `TenderMethod`
 *  vocabulary — mirrors every other pure module's error convention in this
 *  repository. */
export function resolveReceiptAccountKeyForTender(method: TenderMethod): string {
  const key = TENDER_RECEIPT_ACCOUNT_KEY[method];
  if (!key) {
    throw new RangeError(
      `resolveReceiptAccountKeyForTender: unrecognized tender method ${String(method)}`,
    );
  }
  return key;
}
