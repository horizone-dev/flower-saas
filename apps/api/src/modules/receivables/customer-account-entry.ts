/**
 * Task 3b.6 Checkpoint A — pure `CustomerAccountEntry` kind/reference-XOR
 * validation. NO DB — Checkpoint B owns enforcing the equivalent
 * cross-table `sourceType` pairing (e.g. `INVOICE` entries only referencing
 * a `CustomerReceivable` whose OWN `sourceType = 'INVOICE'`) via a trigger,
 * since a plain PostgreSQL CHECK constraint cannot query a referenced
 * table. This module only validates the pure semantic shape: exactly one
 * reference column populated, matching `entryKind`.
 *
 * Frozen final entryKind vocabulary (3b.6 architecture-freeze, this
 * session): `INVOICE`, `PAYMENT`, `PAYMENT_ALLOCATION`, `ADVANCE`,
 * `ADVANCE_APPLIED`, `OPENING_RECEIVABLE`, `OPENING_ADVANCE`. This is the
 * complete, closed set of kinds 3b.6 code ever produces — later tasks add
 * their own kinds to this same taxonomy (e.g. 3b.7's `SETTLEMENT_DISCOUNT`,
 * 3b.8's `CREDIT_NOTE`/`REFUND`/`WRITE_OFF`), never invented here.
 *
 * Task 3b.6 Checkpoint D (pre-D architecture-review correction) added the 8th
 * kind, `OPENING_RECEIVABLE_PAYMENT_APPLIED` — purely additive, exactly the
 * kind of later-task extension this module's own doc anticipated. No
 * existing kind's reference column or behavior changes.
 *
 * Task 3b.8 Checkpoint C added the 9th kind, `CANCELLATION_CHARGE` — the
 * exact vocabulary migration 44's own `customer_account_entry_kind_chk` /
 * `customer_account_entry_reference_xor_chk` already reserved (grouped with
 * `INVOICE`/`OPENING_RECEIVABLE` under the SAME `customerReceivableId`
 * reference column; the DB trigger separately requires the referenced
 * receivable's own `sourceType = 'CANCELLATION_CHARGE'`). Purely additive —
 * no existing kind's reference column or behavior changes.
 *
 * Task 3b.8 Checkpoint D adds the final 2 kinds migration 44's own CHECK
 * already reserved (`creditNoteId` for `CREDIT_NOTE`, written only when
 * `CreditNote.arReductionMinor > 0`; `customerAdvanceRefundApplicationId` for
 * `REFUND`, one entry per `CustomerAdvanceRefundApplication` row — mirrors
 * `paymentAllocationId`'s own one-entry-per-row precedent for a fan-out).
 * `ADVANCE`/`ADVANCE_APPLIED` are REUSED UNCHANGED for a CREDIT_NOTE-sourced
 * Advance / its later application — no new kind needed for either.
 *
 * Task 3b.8 Integration Closure adds the 12th kind,
 * `CANCELLATION_CHARGE_PAYMENT_APPLIED` — a Payment applied to a
 * CANCELLATION_CHARGE receivable (the DB payment-application target is OPENING +
 * CANCELLATION_CHARGE). It shares the legacy `OPENING_RECEIVABLE_PAYMENT_APPLIED`
 * sole reference column (`customerReceivablePaymentApplicationId`) but is its OWN
 * kind: the legacy kind stays FROZEN, unchanged and unrenamed, for
 * opening-receivable payment history, and the DB cross-table trigger
 * structurally keeps the two apart (each kind may only reference an application
 * whose own target receivable has the matching sourceType). Advance application
 * to a charge keeps the generic `ADVANCE_APPLIED` (target-agnostic, per the
 * frozen schema).
 *
 * `CustomerAccountEntry` is chronology/history ONLY — never a receipt,
 * allocation, receivable-principal, advance, or PostingEngine-idempotency
 * authority. It exists purely so the customer statement can show a source
 * financial fact in order; every reference column points AT an
 * authoritative record, never duplicates its value.
 */

export type CustomerAccountEntryKind =
  | 'INVOICE'
  | 'PAYMENT'
  | 'PAYMENT_ALLOCATION'
  | 'OPENING_RECEIVABLE_PAYMENT_APPLIED'
  | 'ADVANCE'
  | 'ADVANCE_APPLIED'
  | 'OPENING_RECEIVABLE'
  | 'OPENING_ADVANCE'
  | 'CANCELLATION_CHARGE'
  | 'CREDIT_NOTE'
  | 'REFUND'
  | 'CANCELLATION_CHARGE_PAYMENT_APPLIED';

export const CUSTOMER_ACCOUNT_ENTRY_KINDS: readonly CustomerAccountEntryKind[] = Object.freeze([
  'INVOICE',
  'PAYMENT',
  'PAYMENT_ALLOCATION',
  'OPENING_RECEIVABLE_PAYMENT_APPLIED',
  'ADVANCE',
  'ADVANCE_APPLIED',
  'OPENING_RECEIVABLE',
  'OPENING_ADVANCE',
  'CANCELLATION_CHARGE',
  'CREDIT_NOTE',
  'REFUND',
  'CANCELLATION_CHARGE_PAYMENT_APPLIED',
]);

/** The one reference field each entryKind must populate — everything else must be absent. */
export type CustomerAccountEntryReferences = {
  readonly customerReceivableId?: string;
  readonly paymentId?: string;
  readonly paymentAllocationId?: string;
  readonly customerAdvanceId?: string;
  readonly customerAdvanceApplicationId?: string;
  readonly customerReceivablePaymentApplicationId?: string;
  readonly creditNoteId?: string;
  readonly customerAdvanceRefundApplicationId?: string;
};

const REFERENCE_COLUMN_FOR_KIND: Readonly<
  Record<CustomerAccountEntryKind, keyof CustomerAccountEntryReferences>
> = Object.freeze({
  INVOICE: 'customerReceivableId',
  OPENING_RECEIVABLE: 'customerReceivableId',
  CANCELLATION_CHARGE: 'customerReceivableId',
  PAYMENT: 'paymentId',
  PAYMENT_ALLOCATION: 'paymentAllocationId',
  OPENING_RECEIVABLE_PAYMENT_APPLIED: 'customerReceivablePaymentApplicationId',
  CANCELLATION_CHARGE_PAYMENT_APPLIED: 'customerReceivablePaymentApplicationId',
  ADVANCE: 'customerAdvanceId',
  OPENING_ADVANCE: 'customerAdvanceId',
  ADVANCE_APPLIED: 'customerAdvanceApplicationId',
  CREDIT_NOTE: 'creditNoteId',
  REFUND: 'customerAdvanceRefundApplicationId',
});

const ALL_REFERENCE_COLUMNS: readonly (keyof CustomerAccountEntryReferences)[] = Object.freeze([
  'customerReceivableId',
  'paymentId',
  'paymentAllocationId',
  'customerAdvanceId',
  'customerAdvanceApplicationId',
  'customerReceivablePaymentApplicationId',
  'creditNoteId',
  'customerAdvanceRefundApplicationId',
]);

/**
 * Throws a plain `RangeError` unless exactly the ONE reference column
 * required by `entryKind` is populated (a non-empty string) and every
 * other reference column is absent/undefined. This is the pure half of the
 * "one authoritative source financial fact produces at most one matching
 * chronology entry" invariant — the DB-level cross-table `sourceType`
 * pairing (e.g. an `INVOICE` entry's `customerReceivableId` must point at a
 * receivable whose own `sourceType` really is `'INVOICE'`) is Checkpoint
 * B's own trigger-based responsibility, not re-derived here.
 */
export function assertCustomerAccountEntryReferenceShape(
  entryKind: CustomerAccountEntryKind,
  references: CustomerAccountEntryReferences,
): void {
  const requiredColumn = REFERENCE_COLUMN_FOR_KIND[entryKind];
  if (requiredColumn === undefined) {
    throw new RangeError(`unrecognized CustomerAccountEntry entryKind: ${String(entryKind)}`);
  }

  const requiredValue = references[requiredColumn];
  if (!requiredValue) {
    throw new RangeError(
      `CustomerAccountEntry(${entryKind}) requires a non-empty ${requiredColumn}`,
    );
  }

  for (const column of ALL_REFERENCE_COLUMNS) {
    if (column === requiredColumn) continue;
    if (references[column] !== undefined) {
      throw new RangeError(
        `CustomerAccountEntry(${entryKind}) must not populate ${column} — only ${requiredColumn} ` +
          'may be set (exactly one authoritative reference per entry)',
      );
    }
  }
}
