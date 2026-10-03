import { describe, expect, it } from 'vitest';
import {
  RECEIVABLE_SOURCE_TYPES,
  computeAdvanceBalance,
  computeReceivableBalance,
  isReceivableSourceType,
} from './receivable-balance.js';

/**
 * Task 3b.8 Integration Closure — the ONE canonical, pure receivable/advance
 * balance arithmetic. Every consumer (customer-account read model, FIFO
 * receipt collection, CustomerAdvance application) calls THESE functions; this
 * file is the executable definition of the formulas.
 */
describe('computeReceivableBalance (canonical, by receivable source type)', () => {
  it('INVOICE: principal - payment allocations - advance applications - CreditNote AR reduction', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'INVOICE',
        principalMinor: 2000n,
        paidByPaymentMinor: 800n,
        paidByAdvanceMinor: 300n,
        creditedMinor: 0n,
      }),
    ).toEqual({
      sourceType: 'INVOICE',
      originalMinor: 2000n,
      paidByPaymentMinor: 800n,
      paidByAdvanceMinor: 300n,
      creditedMinor: 0n,
      outstandingMinor: 900n,
    });
  });

  it('INVOICE fully AR-reversed by a CreditNote (nothing was paid): outstanding 0 — never collectible', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'INVOICE',
        principalMinor: 2000n,
        paidByPaymentMinor: 0n,
        paidByAdvanceMinor: 0n,
        creditedMinor: 2000n,
      }).outstandingMinor,
    ).toBe(0n);
  });

  it('INVOICE partly paid then fully cancelled: the paid portion is NOT subtracted twice — arReduction (1200) + paid (800) = total', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'INVOICE',
        principalMinor: 2000n,
        paidByPaymentMinor: 800n,
        paidByAdvanceMinor: 0n,
        creditedMinor: 1200n,
      }).outstandingMinor,
    ).toBe(0n);
  });

  it('INVOICE with a PARTIAL AR reduction (a state a future partial-cancellation task could produce): remaining is exact — total − paid − credited, collectible only up to it', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'INVOICE',
        principalMinor: 2000n,
        paidByPaymentMinor: 500n,
        paidByAdvanceMinor: 0n,
        creditedMinor: 700n,
      }).outstandingMinor,
    ).toBe(800n);
  });

  it('OPENING: openingAmountMinor - receivable payment applications - advance applications', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'OPENING',
        principalMinor: 500n,
        paidByPaymentMinor: 100n,
        paidByAdvanceMinor: 50n,
        creditedMinor: 0n,
      }).outstandingMinor,
    ).toBe(350n);
  });

  it('CANCELLATION_CHARGE: charge total - receivable payment applications - advance applications', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'CANCELLATION_CHARGE',
        principalMinor: 10_500n,
        paidByPaymentMinor: 4000n,
        paidByAdvanceMinor: 500n,
        creditedMinor: 0n,
      }),
    ).toEqual({
      sourceType: 'CANCELLATION_CHARGE',
      originalMinor: 10_500n,
      paidByPaymentMinor: 4000n,
      paidByAdvanceMinor: 500n,
      creditedMinor: 0n,
      outstandingMinor: 6000n,
    });
  });

  it('a receivable whose source principal is missing (NULL) fails closed — NEVER NULL arithmetic, NEVER an OPENING fallback', () => {
    for (const sourceType of ['INVOICE', 'OPENING', 'CANCELLATION_CHARGE']) {
      expect(() =>
        computeReceivableBalance({
          sourceType,
          principalMinor: null,
          paidByPaymentMinor: 0n,
          paidByAdvanceMinor: 0n,
          creditedMinor: 0n,
        }),
      ).toThrow(RangeError);
    }
  });

  it('an unrecognized source type is rejected — "anything that is not INVOICE is OPENING" must never hold', () => {
    for (const sourceType of ['WRITE_OFF', '', 'invoice', 'CREDIT_NOTE']) {
      expect(() =>
        computeReceivableBalance({
          sourceType,
          principalMinor: 100n,
          paidByPaymentMinor: 0n,
          paidByAdvanceMinor: 0n,
          creditedMinor: 0n,
        }),
      ).toThrow(/unrecognized CustomerReceivable sourceType/);
    }
  });

  it('a CreditNote reduction is only meaningful for an INVOICE receivable', () => {
    for (const sourceType of ['OPENING', 'CANCELLATION_CHARGE']) {
      expect(() =>
        computeReceivableBalance({
          sourceType,
          principalMinor: 100n,
          paidByPaymentMinor: 0n,
          paidByAdvanceMinor: 0n,
          creditedMinor: 1n,
        }),
      ).toThrow(RangeError);
    }
  });

  it('negative components are rejected', () => {
    const base = {
      sourceType: 'INVOICE',
      principalMinor: 100n,
      paidByPaymentMinor: 0n,
      paidByAdvanceMinor: 0n,
      creditedMinor: 0n,
    };
    expect(() => computeReceivableBalance({ ...base, principalMinor: -1n })).toThrow(RangeError);
    expect(() => computeReceivableBalance({ ...base, paidByPaymentMinor: -1n })).toThrow(
      RangeError,
    );
    expect(() => computeReceivableBalance({ ...base, paidByAdvanceMinor: -1n })).toThrow(
      RangeError,
    );
    expect(() => computeReceivableBalance({ ...base, creditedMinor: -1n })).toThrow(RangeError);
  });

  it('over-coverage (a corrupted state) is surfaced as a NEGATIVE outstanding, never thrown — read models must report it, not 500', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'INVOICE',
        principalMinor: 100n,
        paidByPaymentMinor: 150n,
        paidByAdvanceMinor: 0n,
        creditedMinor: 0n,
      }).outstandingMinor,
    ).toBe(-50n);
  });

  it('is exact bigint arithmetic beyond Number.MAX_SAFE_INTEGER', () => {
    expect(
      computeReceivableBalance({
        sourceType: 'CANCELLATION_CHARGE',
        principalMinor: 99_999_999_999_999_999n,
        paidByPaymentMinor: 1n,
        paidByAdvanceMinor: 0n,
        creditedMinor: 0n,
      }).outstandingMinor,
    ).toBe(99_999_999_999_999_998n);
  });
});

describe('isReceivableSourceType / RECEIVABLE_SOURCE_TYPES', () => {
  it('is the closed three-value set', () => {
    expect([...RECEIVABLE_SOURCE_TYPES].sort()).toEqual(
      ['CANCELLATION_CHARGE', 'INVOICE', 'OPENING'].sort(),
    );
    expect(isReceivableSourceType('CANCELLATION_CHARGE')).toBe(true);
    expect(isReceivableSourceType('OPENING')).toBe(true);
    expect(isReceivableSourceType('INVOICE')).toBe(true);
    expect(isReceivableSourceType('WRITE_OFF')).toBe(false);
  });
});

describe('computeAdvanceBalance (canonical: applications + refund applications + PENDING reservations)', () => {
  it('a plain advance: nothing consumed', () => {
    expect(
      computeAdvanceBalance({
        principalMinor: 2000n,
        appliedMinor: 0n,
        refundedMinor: 0n,
        reservedMinor: 0n,
      }),
    ).toEqual({
      principalMinor: 2000n,
      appliedMinor: 0n,
      refundedMinor: 0n,
      reservedMinor: 0n,
      consumedMinor: 0n,
      bookedRemainingMinor: 2000n,
      availableMinor: 2000n,
    });
  });

  it('a refund application consumes the advance (booked AND available both fall)', () => {
    const b = computeAdvanceBalance({
      principalMinor: 2000n,
      appliedMinor: 0n,
      refundedMinor: 1500n,
      reservedMinor: 0n,
    });
    expect(b.bookedRemainingMinor).toBe(500n);
    expect(b.availableMinor).toBe(500n);
    expect(b.consumedMinor).toBe(1500n);
  });

  it('a PENDING reservation reduces AVAILABLE but not the BOOKED remainder (the maintained projection is untouched by a reservation)', () => {
    const b = computeAdvanceBalance({
      principalMinor: 2000n,
      appliedMinor: 0n,
      refundedMinor: 0n,
      reservedMinor: 500n,
    });
    expect(b.bookedRemainingMinor).toBe(2000n);
    expect(b.availableMinor).toBe(1500n);
    expect(b.consumedMinor).toBe(500n);
  });

  it('all three consumers together', () => {
    const b = computeAdvanceBalance({
      principalMinor: 2000n,
      appliedMinor: 300n,
      refundedMinor: 200n,
      reservedMinor: 100n,
    });
    expect(b.consumedMinor).toBe(600n);
    expect(b.bookedRemainingMinor).toBe(1500n);
    expect(b.availableMinor).toBe(1400n);
  });

  it('a fully consumed advance has nothing booked and nothing available', () => {
    const b = computeAdvanceBalance({
      principalMinor: 2000n,
      appliedMinor: 500n,
      refundedMinor: 1500n,
      reservedMinor: 0n,
    });
    expect(b.bookedRemainingMinor).toBe(0n);
    expect(b.availableMinor).toBe(0n);
  });

  it('negative components are rejected; over-consumption (corrupted) is surfaced as a negative, never thrown', () => {
    const base = { principalMinor: 100n, appliedMinor: 0n, refundedMinor: 0n, reservedMinor: 0n };
    expect(() => computeAdvanceBalance({ ...base, principalMinor: -1n })).toThrow(RangeError);
    expect(() => computeAdvanceBalance({ ...base, appliedMinor: -1n })).toThrow(RangeError);
    expect(() => computeAdvanceBalance({ ...base, refundedMinor: -1n })).toThrow(RangeError);
    expect(() => computeAdvanceBalance({ ...base, reservedMinor: -1n })).toThrow(RangeError);
    expect(computeAdvanceBalance({ ...base, appliedMinor: 150n }).availableMinor).toBe(-50n);
  });
});
