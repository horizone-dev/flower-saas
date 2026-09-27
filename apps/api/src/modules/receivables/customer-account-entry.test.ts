import { describe, expect, it } from 'vitest';
import {
  assertCustomerAccountEntryReferenceShape,
  CUSTOMER_ACCOUNT_ENTRY_KINDS,
  type CustomerAccountEntryKind,
} from './customer-account-entry.js';

describe('CUSTOMER_ACCOUNT_ENTRY_KINDS (3b.6 Checkpoint A + Checkpoint D additive extension)', () => {
  it("is exactly the frozen 7-kind vocabulary plus Checkpoint D's additive 8th kind, no more, no less", () => {
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).toEqual([
      'INVOICE',
      'PAYMENT',
      'PAYMENT_ALLOCATION',
      'OPENING_RECEIVABLE_PAYMENT_APPLIED',
      'ADVANCE',
      'ADVANCE_APPLIED',
      'OPENING_RECEIVABLE',
      'OPENING_ADVANCE',
    ]);
  });

  it('never includes a later-task kind (SETTLEMENT_DISCOUNT/CREDIT_NOTE/REFUND/WRITE_OFF)', () => {
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).not.toContain('SETTLEMENT_DISCOUNT');
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).not.toContain('CREDIT_NOTE');
    expect(CUSTOMER_ACCOUNT_ENTRY_KINDS).not.toContain('REFUND');
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
