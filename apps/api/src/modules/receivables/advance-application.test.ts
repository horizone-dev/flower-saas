import { describe, expect, it } from 'vitest';
import {
  computeAdvanceAvailable,
  applyAdvance,
  type AdvanceAvailabilityState,
} from './advance-application.js';

function advance(over: Partial<AdvanceAvailabilityState> = {}): AdvanceAvailabilityState {
  return { advancePrincipalMinor: 100n, appliedSoFarMinor: 0n, ...over };
}

describe('computeAdvanceAvailable (3b.6 Checkpoint A)', () => {
  it('no applications yet -> full principal available', () => {
    expect(computeAdvanceAvailable(advance())).toBe(100n);
  });

  it('partially applied -> remaining available', () => {
    expect(computeAdvanceAvailable(advance({ appliedSoFarMinor: 60n }))).toBe(40n);
  });

  it('fully applied -> zero available', () => {
    expect(computeAdvanceAvailable(advance({ appliedSoFarMinor: 100n }))).toBe(0n);
  });

  it('rejects a corrupted state where applied exceeds principal', () => {
    expect(() => computeAdvanceAvailable(advance({ appliedSoFarMinor: 101n }))).toThrow(RangeError);
  });

  it('rejects negative inputs', () => {
    expect(() => computeAdvanceAvailable(advance({ advancePrincipalMinor: -1n }))).toThrow(
      RangeError,
    );
    expect(() => computeAdvanceAvailable(advance({ appliedSoFarMinor: -1n }))).toThrow(RangeError);
  });
});

describe('applyAdvance (3b.6 Checkpoint A)', () => {
  it('Advance 100, invoice outstanding 80, apply 50 -> advance 50 / invoice 30', () => {
    const r = applyAdvance({
      advance: advance(),
      targetReceivableOutstandingMinor: 80n,
      proposedApplicationAmountMinor: 50n,
    });
    expect(r).toEqual({ newAdvanceAvailableMinor: 50n, newReceivableOutstandingMinor: 30n });
  });

  it('Advance 100, invoice 80, apply 80 -> advance 20 / invoice 0', () => {
    const r = applyAdvance({
      advance: advance(),
      targetReceivableOutstandingMinor: 80n,
      proposedApplicationAmountMinor: 80n,
    });
    expect(r).toEqual({ newAdvanceAvailableMinor: 20n, newReceivableOutstandingMinor: 0n });
  });

  it('Advance 100, invoice 80, apply 81 -> rejected (exceeds invoice outstanding)', () => {
    expect(() =>
      applyAdvance({
        advance: advance(),
        targetReceivableOutstandingMinor: 80n,
        proposedApplicationAmountMinor: 81n,
      }),
    ).toThrow(RangeError);
  });

  it('Advance 100 already applied 60, attempt apply 50 -> rejected (exceeds available 40)', () => {
    expect(() =>
      applyAdvance({
        advance: advance({ appliedSoFarMinor: 60n }),
        targetReceivableOutstandingMinor: 1000n,
        proposedApplicationAmountMinor: 50n,
      }),
    ).toThrow(RangeError);
  });

  it('Advance 0 -> cannot apply any positive amount', () => {
    expect(() =>
      applyAdvance({
        advance: advance({ advancePrincipalMinor: 0n }),
        targetReceivableOutstandingMinor: 100n,
        proposedApplicationAmountMinor: 1n,
      }),
    ).toThrow(RangeError);
  });

  it('rejects a zero or negative proposed application amount', () => {
    expect(() =>
      applyAdvance({
        advance: advance(),
        targetReceivableOutstandingMinor: 100n,
        proposedApplicationAmountMinor: 0n,
      }),
    ).toThrow(RangeError);
    expect(() =>
      applyAdvance({
        advance: advance(),
        targetReceivableOutstandingMinor: 100n,
        proposedApplicationAmountMinor: -1n,
      }),
    ).toThrow(RangeError);
  });

  it('applying exactly the available amount against exactly the outstanding amount zeroes both', () => {
    const r = applyAdvance({
      advance: advance({ advancePrincipalMinor: 50n }),
      targetReceivableOutstandingMinor: 50n,
      proposedApplicationAmountMinor: 50n,
    });
    expect(r).toEqual({ newAdvanceAvailableMinor: 0n, newReceivableOutstandingMinor: 0n });
  });

  it('produces no PaymentAllocation-shaped output at all — the result type has no such field', () => {
    const r = applyAdvance({
      advance: advance(),
      targetReceivableOutstandingMinor: 10n,
      proposedApplicationAmountMinor: 10n,
    });
    expect(Object.keys(r).sort()).toEqual(
      ['newAdvanceAvailableMinor', 'newReceivableOutstandingMinor'].sort(),
    );
  });
});
