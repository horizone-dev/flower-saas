import { describe, expect, it } from 'vitest';
import {
  computeCreditExposure,
  computeAvailableCredit,
  evaluateCreditAuthorization,
  type CreditAccountState,
} from './credit-exposure.js';

function state(over: Partial<CreditAccountState> = {}): CreditAccountState {
  return {
    creditEnabled: true,
    creditLimitMinor: 1000n,
    receivableOutstandingMinor: 0n,
    ...over,
  };
}

describe('computeCreditExposure (3b.6 Checkpoint A)', () => {
  it('equals receivableOutstandingMinor exactly', () => {
    expect(computeCreditExposure(state({ receivableOutstandingMinor: 300n }))).toBe(300n);
  });

  it('an unapplied Advance does not reduce exposure — there is no advance input at all', () => {
    // the type itself has no advance field — exposure is purely a function
    // of receivableOutstandingMinor, proving structurally that an advance
    // cannot influence this computation.
    expect(computeCreditExposure(state({ receivableOutstandingMinor: 500n }))).toBe(500n);
  });

  it('rejects a negative receivableOutstandingMinor', () => {
    expect(() => computeCreditExposure(state({ receivableOutstandingMinor: -1n }))).toThrow(
      RangeError,
    );
  });

  it('zero outstanding is zero exposure', () => {
    expect(computeCreditExposure(state({ receivableOutstandingMinor: 0n }))).toBe(0n);
  });
});

describe('computeAvailableCredit (3b.6 Checkpoint A)', () => {
  it('creditEnabled=false -> null (not 0 — disabled is not "zero ceiling")', () => {
    expect(computeAvailableCredit(state({ creditEnabled: false, creditLimitMinor: 1000n }))).toBe(
      null,
    );
  });

  it('creditLimitMinor=null -> null (no numeric ceiling)', () => {
    expect(computeAvailableCredit(state({ creditLimitMinor: null }))).toBe(null);
  });

  it('creditLimit 1000, exposure 300 -> available 700', () => {
    expect(
      computeAvailableCredit(state({ creditLimitMinor: 1000n, receivableOutstandingMinor: 300n })),
    ).toBe(700n);
  });

  it('exposure exactly at limit -> available 0', () => {
    expect(
      computeAvailableCredit(state({ creditLimitMinor: 1000n, receivableOutstandingMinor: 1000n })),
    ).toBe(0n);
  });

  it('exposure exceeding limit clamps to 0, never negative', () => {
    expect(
      computeAvailableCredit(state({ creditLimitMinor: 1000n, receivableOutstandingMinor: 1500n })),
    ).toBe(0n);
  });
});

describe('evaluateCreditAuthorization (3b.6 Checkpoint A)', () => {
  it('DISABLED when creditEnabled=false, regardless of limit/exposure', () => {
    expect(
      evaluateCreditAuthorization(state({ creditEnabled: false, creditLimitMinor: 1000n }), 100n),
    ).toEqual({ outcome: 'DISABLED' });
  });

  it('ALLOWED when creditLimitMinor is null (no numeric ceiling)', () => {
    expect(evaluateCreditAuthorization(state({ creditLimitMinor: null }), 999_999_999n)).toEqual({
      outcome: 'ALLOWED',
    });
  });

  it('ALLOWED when projected exposure is exactly the limit (boundary, not exceeded)', () => {
    expect(
      evaluateCreditAuthorization(
        state({ creditLimitMinor: 1000n, receivableOutstandingMinor: 900n }),
        100n,
      ),
    ).toEqual({ outcome: 'ALLOWED' });
  });

  it('LIMIT_EXCEEDED when projected exposure exceeds the limit by 1', () => {
    expect(
      evaluateCreditAuthorization(
        state({ creditLimitMinor: 1000n, receivableOutstandingMinor: 900n }),
        101n,
      ),
    ).toEqual({
      outcome: 'LIMIT_EXCEEDED',
      creditLimitMinor: 1000n,
      projectedExposureMinor: 1001n,
    });
  });

  it('a PAY_NOW shortfall already reflected in receivableOutstandingMinor blocks a LATER ON_CREDIT proposal', () => {
    // simulates: a PAY_NOW invoice for 900 short-paid, leaving 900 real
    // outstanding (never authorized as credit, but still real exposure) —
    // a later ON_CREDIT proposal for 200 against a 1000 limit must fail.
    const afterShortfall = state({ creditLimitMinor: 1000n, receivableOutstandingMinor: 900n });
    expect(evaluateCreditAuthorization(afterShortfall, 200n)).toMatchObject({
      outcome: 'LIMIT_EXCEEDED',
    });
  });

  it('rejects a negative proposed amount', () => {
    expect(() => evaluateCreditAuthorization(state(), -1n)).toThrow(RangeError);
  });
});
