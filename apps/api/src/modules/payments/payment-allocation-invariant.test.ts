import { describe, expect, it } from 'vitest';
import {
  assertPaymentAllocationMatchesPayment,
  type PaymentAllocationCandidate,
  type PaymentForAllocation,
} from './payment-allocation-invariant.js';

const basePayment: PaymentForAllocation = {
  amountMinor: 500n,
  currencyCode: 'AED',
  currencyExponent: 2,
  tenantId: 't1',
  companyId: 'c1',
  branchId: 'b1',
};

const baseAllocation: PaymentAllocationCandidate = { ...basePayment };

describe('payment-allocation-invariant (task 3b.5 Checkpoint A — pure pairwise assertion)', () => {
  it('exact match is accepted', () => {
    expect(() => assertPaymentAllocationMatchesPayment(baseAllocation, basePayment)).not.toThrow();
  });

  it('amount mismatch rejects', () => {
    expect(() =>
      assertPaymentAllocationMatchesPayment({ ...baseAllocation, amountMinor: 400n }, basePayment),
    ).toThrow(RangeError);
  });

  it('currency mismatch rejects', () => {
    expect(() =>
      assertPaymentAllocationMatchesPayment(
        { ...baseAllocation, currencyCode: 'SAR' },
        basePayment,
      ),
    ).toThrow(RangeError);
  });

  it('exponent mismatch rejects', () => {
    expect(() =>
      assertPaymentAllocationMatchesPayment(
        { ...baseAllocation, currencyExponent: 3 },
        basePayment,
      ),
    ).toThrow(RangeError);
  });

  it('scope (tenant/company/branch) mismatch rejects', () => {
    expect(() =>
      assertPaymentAllocationMatchesPayment({ ...baseAllocation, branchId: 'b2' }, basePayment),
    ).toThrow(RangeError);
    expect(() =>
      assertPaymentAllocationMatchesPayment({ ...baseAllocation, companyId: 'c2' }, basePayment),
    ).toThrow(RangeError);
    expect(() =>
      assertPaymentAllocationMatchesPayment({ ...baseAllocation, tenantId: 't2' }, basePayment),
    ).toThrow(RangeError);
  });
});
