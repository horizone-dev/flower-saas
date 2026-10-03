import { describe, expect, it } from 'vitest';
import {
  assertCustomerAccountEntryReferenceShape,
  CUSTOMER_ACCOUNT_ENTRY_KINDS,
  type CustomerAccountEntryKind,
} from './customer-account-entry.js';

describe('CUSTOMER_ACCOUNT_ENTRY_KINDS (3b.6 Checkpoint A + D additive extension + task 3b.8 additive kinds)', () => {
  it("is exactly the 8-kind 3b.6 vocabulary (7 frozen + Checkpoint D's additive 8th) plus task 3b.8's additive kinds, no more, no less", () => {
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).toEqual([
      'INVOICE',
      'PAYMENT',
      'PAYMENT_ALLOCATION',
      'OPENING_RECEIVABLE_PAYMENT_APPLIED',
      'ADVANCE',
      'ADVANCE_APPLIED',
      'OPENING_RECEIVABLE',
      'OPENING_ADVANCE',
      // task 3b.8 (migration 44's `customer_account_entry_kind_chk` reserved exactly these 3)
      'CANCELLATION_CHARGE',
      'CREDIT_NOTE',
      'REFUND',
      // task 3b.8 Integration Closure (migration 46) — a Payment applied to a
      // CANCELLATION_CHARGE receivable; the legacy
      // `OPENING_RECEIVABLE_PAYMENT_APPLIED` stays frozen for opening-balance history
      'CANCELLATION_CHARGE_PAYMENT_APPLIED',
    ]);
  });

  it('keeps the legacy opening-receivable payment kind AND the new charge payment kind as two DISTINCT kinds', () => {
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).toContain('OPENING_RECEIVABLE_PAYMENT_APPLIED');
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).toContain('CANCELLATION_CHARGE_PAYMENT_APPLIED');
    expect('OPENING_RECEIVABLE_PAYMENT_APPLIED').not.toBe('CANCELLATION_CHARGE_PAYMENT_APPLIED');
  });

  it('never includes a kind no task has added (SETTLEMENT_DISCOUNT / WRITE_OFF — no 3b.8 concept requires either)', () => {
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).not.toContain('SETTLEMENT_DISCOUNT');
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).not.toContain('WRITE_OFF');
  });
});

describe('assertCustomerAccountEntryReferenceShape (3b.6 Checkpoint A)', () => {
  const exactlyOneReferenceCase: Array<
    [CustomerAccountEntryKind, keyof Parameters<typeof assertCustomerAccountEntryReferenceShape>[1]]
  > = [
    ['INVOICE', 'customerReceivableId'],
    ['OPENING_RECEIVABLE', 'customerReceivableId'],
    ['PAYMENT', 'paymentId'],
    ['PAYMENT_ALLOCATION', 'paymentAllocationId'],
    ['OPENING_RECEIVABLE_PAYMENT_APPLIED', 'customerReceivablePaymentApplicationId'],
    ['ADVANCE', 'customerAdvanceId'],
    ['OPENING_ADVANCE', 'customerAdvanceId'],
    ['ADVANCE_APPLIED', 'customerAdvanceApplicationId'],
    // task 3b.8 additive kinds
    ['CANCELLATION_CHARGE', 'customerReceivableId'],
    ['CREDIT_NOTE', 'creditNoteId'],
    ['REFUND', 'customerAdvanceRefundApplicationId'],
    // task 3b.8 Integration Closure — same sole reference column as the legacy
    // opening-receivable payment kind, but its own kind
    ['CANCELLATION_CHARGE_PAYMENT_APPLIED', 'customerReceivablePaymentApplicationId'],
  ];

  for (const [kind, column] of exactlyOneReferenceCase) {
    it(`${kind}: accepts exactly ${column} populated, nothing else`, () => {
      expect(() =>
        assertCustomerAccountEntryReferenceShape(kind, { [column]: 'id-1' }),
      ).not.toThrow();
    });

    it(`${kind}: rejects when ${column} is missing`, () => {
      expect(() => assertCustomerAccountEntryReferenceShape(kind, {})).toThrow(RangeError);
    });

    it(`${kind}: rejects when ${column} is an empty string`, () => {
      expect(() => assertCustomerAccountEntryReferenceShape(kind, { [column]: '' })).toThrow(
        RangeError,
      );
    });
  }

  it('rejects a second reference column populated alongside the required one', () => {
    expect(() =>
      assertCustomerAccountEntryReferenceShape('PAYMENT', {
        paymentId: 'pay-1',
        paymentAllocationId: 'alloc-1', // must never coexist
      }),
    ).toThrow(RangeError);
  });

  it('rejects a reference column belonging to a wholly different entryKind', () => {
    expect(() =>
      assertCustomerAccountEntryReferenceShape('ADVANCE', {
        customerAdvanceApplicationId: 'app-1', // wrong column for ADVANCE
      }),
    ).toThrow(RangeError);
  });

  it('INVOICE and OPENING_RECEIVABLE both use customerReceivableId, but are distinguished purely by entryKind here (Checkpoint B enforces the cross-table sourceType match)', () => {
    expect(() =>
      assertCustomerAccountEntryReferenceShape('INVOICE', { customerReceivableId: 'recv-1' }),
    ).not.toThrow();
    expect(() =>
      assertCustomerAccountEntryReferenceShape('OPENING_RECEIVABLE', {
        customerReceivableId: 'recv-2',
      }),
    ).not.toThrow();
  });

  it('rejects an unrecognized entryKind', () => {
    expect(() =>
      assertCustomerAccountEntryReferenceShape('SETTLEMENT_DISCOUNT' as CustomerAccountEntryKind, {
        paymentId: 'x',
      }),
    ).toThrow(RangeError);
  });
});
