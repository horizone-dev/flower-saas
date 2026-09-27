import { describe, expect, it } from 'vitest';
import {
  computePaymentConsumption,
  wouldExceedPaymentCapacity,
  assertPaymentCapacity,
  type PaymentConsumptionState,
} from './payment-consumption.js';

function state(over: Partial<PaymentConsumptionState> = {}): PaymentConsumptionState {
  return {
    paymentAmountMinor: 100n,
    allocatedToInvoicesMinor: 0n,
    convertedToAdvanceMinor: 0n,
    ...over,
  };
}

describe('computePaymentConsumption (3b.6 Checkpoint A)', () => {
  it('Payment 100: allocated 60 + advance 40 -> consumed 100, remaining 0', () => {
    const r = computePaymentConsumption(
      state({ allocatedToInvoicesMinor: 60n, convertedToAdvanceMinor: 40n }),
    );
    expect(r).toEqual({ consumedMinor: 100n, remainingMinor: 0n });
  });

  it('Payment 100: nothing consumed -> remaining 100', () => {
    const r = computePaymentConsumption(state());
    expect(r).toEqual({ consumedMinor: 0n, remainingMinor: 100n });
  });

  it('rejects a corrupted state where consumption already exceeds the Payment amount', () => {
    expect(() =>
      computePaymentConsumption(
        state({ allocatedToInvoicesMinor: 60n, convertedToAdvanceMinor: 60n }),
      ),
    ).toThrow(RangeError);
  });

  it('rejects negative inputs', () => {
    expect(() => computePaymentConsumption(state({ paymentAmountMinor: -1n }))).toThrow(RangeError);
    expect(() => computePaymentConsumption(state({ allocatedToInvoicesMinor: -1n }))).toThrow(
      RangeError,
    );
    expect(() => computePaymentConsumption(state({ convertedToAdvanceMinor: -1n }))).toThrow(
      RangeError,
    );
  });

  it('zero-amount Payment (if Money rules ever permit it) consumes and remains at zero', () => {
    const r = computePaymentConsumption(state({ paymentAmountMinor: 0n }));
    expect(r).toEqual({ consumedMinor: 0n, remainingMinor: 0n });
  });
});

describe('wouldExceedPaymentCapacity / assertPaymentCapacity (3b.6 Checkpoint A)', () => {
  it('Payment 100, allocated 60: proposing advance 60 would exceed capacity -> rejected', () => {
    const s = state({ allocatedToInvoicesMinor: 60n });
    expect(wouldExceedPaymentCapacity(s, 60n)).toBe(true);
    expect(() => assertPaymentCapacity(s, 60n)).toThrow(RangeError);
  });

  it('Payment 100, allocated 100: proposing allocation 1 would exceed capacity -> rejected', () => {
    const s = state({ allocatedToInvoicesMinor: 100n });
    expect(wouldExceedPaymentCapacity(s, 1n)).toBe(true);
    expect(() => assertPaymentCapacity(s, 1n)).toThrow(RangeError);
  });

  it('proposing exactly the remaining capacity is allowed (boundary)', () => {
    const s = state({ allocatedToInvoicesMinor: 60n });
    expect(wouldExceedPaymentCapacity(s, 40n)).toBe(false);
    expect(() => assertPaymentCapacity(s, 40n)).not.toThrow();
  });

  it('proposing zero is always allowed', () => {
    const s = state({ allocatedToInvoicesMinor: 100n });
    expect(wouldExceedPaymentCapacity(s, 0n)).toBe(false);
  });

  it('rejects a negative proposed amount', () => {
    expect(() => wouldExceedPaymentCapacity(state(), -1n)).toThrow(RangeError);
  });
});
