/**
 * Task 3b.6 Checkpoint H — the frozen business-outbox event vocabulary for
 * customer-account financial mutations that do NOT already ride along on an
 * existing event in the SAME transaction (mirrors `PaymentEventType`'s own
 * role/shape exactly — a plain string-literal union checked at each
 * `outbox.enqueue(... satisfies ReceivablesEventType)` call site, kept
 * local to this module).
 *
 * Deliberately ONE generic event, not one per source table (H7 — "prefer a
 * small bounded vocabulary"): `receivables.customer_account_changed`. Fired
 * by the three STANDALONE commands that have no OTHER outbox event already
 * firing in their own transaction:
 *   - `PaymentAdvanceConversionRepository` (Payment -> Advance)
 *   - `CustomerAdvanceApplicationRepository` (Advance -> Receivable)
 *   - `OpeningBalanceRepository` (Opening Receivable / Opening Advance)
 *
 * Deliberately NOT fired by `CustomerReceiptCollectionRepository`'s own
 * PaymentAllocation/CustomerReceivablePaymentApplication fan-out (H6
 * decision C) — that SAME transaction already enqueues the frozen 3b.5
 * `payments.payment_recorded` event, and any consumer that refetches on
 * that event already sees the post-allocation state (G's read model always
 * recomputes live). A second event there would be pure duplication.
 *
 * Payload carries ONLY trusted identifiers for a consumer to invalidate/
 * refetch (H7) — never a balance/amount, which would itself be a second,
 * competing "financial authority" leaking into the realtime payload.
 */
export type ReceivablesEventType = 'receivables.customer_account_changed';

export type ReceivablesChangeKind =
  | 'ADVANCE_CREATED_FROM_PAYMENT'
  | 'ADVANCE_APPLIED'
  | 'OPENING_RECEIVABLE_CREATED'
  | 'OPENING_ADVANCE_CREATED';

export interface ReceivablesCustomerAccountChangedPayload {
  customerCompanyAccountId: string;
  changeKind: ReceivablesChangeKind;
  sourceType: 'customer_advance' | 'customer_advance_application' | 'customer_receivable';
  sourceId: string;
}
