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
  | 'OPENING_ADVANCE';

export const CUSTOMER_ACCOUNT_ENTRY_KINDS: readonly CustomerAccountEntryKind[] = Object.freeze([
  'INVOICE',
  'PAYMENT',
  'PAYMENT_ALLOCATION',
  'OPENING_RECEIVABLE_PAYMENT_APPLIED',
  'ADVANCE',
  'ADVANCE_APPLIED',
  'OPENING_RECEIVABLE',
  'OPENING_ADVANCE',
]);

/** The one reference field each entryKind must populate — everything else must be absent. */
export type CustomerAccountEntryReferences = {
  readonly customerReceivableId?: string;
  readonly paymentId?: string;
  readonly paymentAllocationId?: string;
  readonly customerAdvanceId?: string;
  readonly customerAdvanceApplicationId?: string;
  readonly customerReceivablePaymentApplicationId?: string;
};

const REFERENCE_COLUMN_FOR_KIND: Readonly<
  Record<CustomerAccountEntryKind, keyof CustomerAccountEntryReferences>
> = Object.freeze({
  INVOICE: 'customerReceivableId',
  OPENING_RECEIVABLE: 'customerReceivableId',
  PAYMENT: 'paymentId',
  PAYMENT_ALLOCATION: 'paymentAllocationId',
  OPENING_RECEIVABLE_PAYMENT_APPLIED: 'customerReceivablePaymentApplicationId',
  ADVANCE: 'customerAdvanceId',
  OPENING_ADVANCE: 'customerAdvanceId',
  ADVANCE_APPLIED: 'customerAdvanceApplicationId',
});

const ALL_REFERENCE_COLUMNS: readonly (keyof CustomerAccountEntryReferences)[] = Object.freeze([
  'customerReceivableId',
  'paymentId',
  'paymentAllocationId',
  'customerAdvanceId',
  'customerAdvanceApplicationId',
  'customerReceivablePaymentApplicationId',
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
