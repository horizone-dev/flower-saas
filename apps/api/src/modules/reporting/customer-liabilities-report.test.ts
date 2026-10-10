import { describe, expect, it } from 'vitest';
import type { DomainError } from '../../common/errors/domain-error.js';
import { computeAdvanceBalance } from '../receivables/receivable-balance.js';
import { computePaymentConsumption } from '../receivables/payment-consumption.js';
import {
  ADVANCE_SOURCE_TYPES,
  assertAsOf,
  buildCustomerLiabilityRows,
  buildLiabilityBlocks,
  LIABILITIES_REPORT_DEFAULT_LIMIT,
  LIABILITIES_REPORT_MAX_LIMIT,
  LIABILITIES_REPORT_NOTE,
  parseLiabilitiesCursor,
  parseLiabilitiesLimit,
  type AdvanceCell,
  type UnappliedCell,
} from './customer-liabilities-report.js';

const adv = (
  sourceType: string,
  o: Partial<Omit<AdvanceCell, 'sourceType'>> = {},
): AdvanceCell => ({
  sourceType,
  count: o.count ?? 1,
  principal: o.principal ?? 0n,
  applied: o.applied ?? 0n,
  refunded: o.refunded ?? 0n,
  reserved: o.reserved ?? 0n,
});
const un = (o: Partial<UnappliedCell> = {}): UnappliedCell => ({
  paymentCount: o.paymentCount ?? 1,
  paymentCountWithUnapplied: o.paymentCountWithUnapplied ?? 0,
  original: o.original ?? 0n,
  allocated: o.allocated ?? 0n,
  receivableApplied: o.receivableApplied ?? 0n,
  converted: o.converted ?? 0n,
});

describe('Customer liabilities — pure arithmetic (task 3b.10 Checkpoint E)', () => {
  it('zero-fills EVERY frozen advance source type, in the frozen order, and an empty scope is a reconciled zero report', () => {
    expect([...ADVANCE_SOURCE_TYPES]).toEqual(['PAYMENT', 'OPENING', 'CREDIT_NOTE']);
    const b = buildLiabilityBlocks([], [], 0n, 0n);
    expect(b.advances.bySourceType.map((r) => r.sourceType)).toEqual([...ADVANCE_SOURCE_TYPES]);
    for (const r of b.advances.bySourceType) {
      expect(r).toMatchObject({
        advanceCount: 0,
        originalAdvanceMinor: '0',
        bookLiabilityMinor: '0',
        pendingRefundReservationMinor: '0',
        availableMinor: '0',
      });
    }
    expect(b.advances.reconciliation).toEqual({
      sourceBookLiabilityMinor: '0',
      glCustomerAdvancesLiabilityMinor: '0',
      differenceMinor: '0',
      reconciled: true,
    });
    expect(b.unappliedReceipts.reconciliation.reconciled).toBe(true);
    expect(b.note).toBe(LIABILITIES_REPORT_NOTE);
  });

  it('ADVANCE: book = principal − applied − refunded; a pending reservation reduces AVAILABLE only, never the book liability', () => {
    const cells = [
      adv('PAYMENT', { count: 2, principal: 10_000n, applied: 2_500n, refunded: 0n, reserved: 0n }),
      adv('CREDIT_NOTE', {
        count: 1,
        principal: 5_000n,
        applied: 1_000n,
        refunded: 1_200n,
        reserved: 800n,
      }),
      adv('OPENING', { count: 1, principal: 700n }),
    ];
    // book = 15 700 − 3 500 − 1 200 = 11 000; reserved 800; available 10 200 — the GL carries the BOOK figure
    const b = buildLiabilityBlocks(cells, [], 11_000n, 0n);
    expect(b.advances).toMatchObject({
      advanceCount: 4,
      originalAdvanceMinor: '15700',
      appliedMinor: '3500',
      actuallyRefundedMinor: '1200',
      bookLiabilityMinor: '11000',
      pendingRefundReservationMinor: '800',
      availableMinor: '10200',
    });
    expect(b.advances.reconciliation).toEqual({
      sourceBookLiabilityMinor: '11000',
      glCustomerAdvancesLiabilityMinor: '11000',
      differenceMinor: '0',
      reconciled: true,
    });
    const credit = b.advances.bySourceType.find((r) => r.sourceType === 'CREDIT_NOTE')!;
    expect(credit).toMatchObject({
      bookLiabilityMinor: '2800',
      pendingRefundReservationMinor: '800',
      availableMinor: '2000',
    });
    // a GL net that already deducted the reservation (the AVAILABLE figure) is a MISMATCH, never accepted
    expect(() => buildLiabilityBlocks(cells, [], 10_200n, 0n)).toThrowError(/customerAdvances/);
  });

  it('is DIFFERENTIALLY equal to the frozen computeAdvanceBalance over randomized advances', () => {
    let seed = 20_261_006;
    const rnd = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      const cells: AdvanceCell[] = [];
      let book = 0n;
      let reserved = 0n;
      let available = 0n;
      let principalSum = 0n;
      for (let i = 0; i < 1 + rnd(12); i++) {
        const principal = BigInt(rnd(1_000_000));
        const applied = BigInt(rnd(Number(principal) + 1));
        const refunded = BigInt(rnd(Number(principal - applied) + 1));
        const reserved1 = BigInt(rnd(Number(principal - applied - refunded) + 1));
        cells.push(
          adv(ADVANCE_SOURCE_TYPES[rnd(3)]!, { principal, applied, refunded, reserved: reserved1 }),
        );
        const f = computeAdvanceBalance({
          principalMinor: principal,
          appliedMinor: applied,
          refundedMinor: refunded,
          reservedMinor: reserved1,
        });
        book += f.bookedRemainingMinor;
        available += f.availableMinor;
        reserved += reserved1;
        principalSum += principal;
      }
      const b = buildLiabilityBlocks(cells, [], book, 0n);
      expect(b.advances.bookLiabilityMinor).toBe(book.toString());
      expect(b.advances.availableMinor).toBe(available.toString());
      expect(b.advances.pendingRefundReservationMinor).toBe(reserved.toString());
      expect(b.advances.originalAdvanceMinor).toBe(principalSum.toString());
    }
  });

  it('UNAPPLIED: unapplied = receipt − PaymentAllocation − receivable payment application − converted to Advance (the frozen 3-term capacity), differential vs computePaymentConsumption', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      const cells: UnappliedCell[] = [];
      let unapplied = 0n;
      let allocatedTotal = 0n;
      for (let i = 0; i < 1 + rnd(10); i++) {
        const original = BigInt(rnd(1_000_000));
        const allocated = BigInt(rnd(Number(original) + 1));
        const receivableApplied = BigInt(rnd(Number(original - allocated) + 1));
        const converted = BigInt(rnd(Number(original - allocated - receivableApplied) + 1));
        cells.push(un({ original, allocated, receivableApplied, converted }));
        unapplied += computePaymentConsumption({
          paymentAmountMinor: original,
          allocatedToInvoicesMinor: allocated + receivableApplied,
          convertedToAdvanceMinor: converted,
        }).remainingMinor;
        allocatedTotal += allocated + receivableApplied;
      }
      const b = buildLiabilityBlocks([], cells, 0n, unapplied);
      expect(b.unappliedReceipts.unappliedReceiptMinor).toBe(unapplied.toString());
      expect(b.unappliedReceipts.allocatedToReceivablesMinor).toBe(allocatedTotal.toString());
    }
  });

  it('UNAPPLIED components: allocation and receivable application sum into allocatedToReceivables; a conversion to Advance is its own figure; the receipt is counted once', () => {
    const b = buildLiabilityBlocks(
      [],
      [
        un({
          paymentCount: 3,
          paymentCountWithUnapplied: 2,
          original: 9_000n,
          allocated: 3_000n,
          receivableApplied: 1_000n,
          converted: 2_000n,
        }),
      ],
      0n,
      3_000n,
    );
    expect(b.unappliedReceipts).toMatchObject({
      paymentCount: 3,
      paymentCountWithUnapplied: 2,
      originalReceiptMinor: '9000',
      paymentAllocationMinor: '3000',
      receivablePaymentApplicationMinor: '1000',
      allocatedToReceivablesMinor: '4000',
      convertedToAdvanceMinor: '2000',
      unappliedReceiptMinor: '3000',
    });
  });

  it('the two controls are INDEPENDENT: each difference fails on its own, and offsetting differences (+X / −X) can never net to a pass', () => {
    const cells = [adv('PAYMENT', { principal: 1_000n })];
    const unCells = [un({ original: 600n, paymentCountWithUnapplied: 1 })];
    expect(
      buildLiabilityBlocks(cells, unCells, 1_000n, 600n).advances.reconciliation.reconciled,
    ).toBe(true);
    const failing = (a: bigint, u: bigint): DomainError => {
      try {
        buildLiabilityBlocks(cells, unCells, a, u);
      } catch (e) {
        return e as DomainError;
      }
      throw new Error('expected the report to fail closed');
    };
    const onlyAdvance = failing(1_050n, 600n);
    expect(onlyAdvance).toMatchObject({ code: 'REPORT_LIABILITIES_GL_MISMATCH', status: 500 });
    expect(onlyAdvance.message).toContain('customerAdvances');
    expect(onlyAdvance.message).not.toContain('unappliedReceipts');
    const onlyUnapplied = failing(1_000n, 550n);
    expect(onlyUnapplied.message).toContain('unappliedReceipts');
    expect(onlyUnapplied.message).not.toContain('customerAdvances');
    // advance GL +50 and unapplied GL −50: the SUM of the two differences is 0 — each control still fails by itself
    const offsetting = failing(1_050n, 550n);
    expect(offsetting.message).toContain('customerAdvances');
    expect(offsetting.message).toContain('unappliedReceipts');
  });

  it('every malformed cell is a fail-closed integrity error, never a thrown RangeError or a silent figure', () => {
    const integrity = { code: 'REPORT_LIABILITIES_SOURCE_INTEGRITY', status: 500 };
    const calls: (() => unknown)[] = [
      () => buildLiabilityBlocks([adv('GIFT', { principal: 1n })], [], 1n, 0n), // an unknown source type
      () =>
        buildLiabilityBlocks([adv('PAYMENT', { principal: 100n, applied: 150n })], [], -50n, 0n), // over-applied
      () =>
        buildLiabilityBlocks(
          [adv('CREDIT_NOTE', { principal: 100n, applied: 40n, reserved: 70n })],
          [],
          60n,
          0n,
        ), // reservation beyond available
      () => buildLiabilityBlocks([adv('PAYMENT', { principal: -1n })], [], -1n, 0n), // a negative component
      () =>
        buildLiabilityBlocks(
          [],
          [un({ original: 100n, allocated: 80n, converted: 40n })],
          0n,
          -20n,
        ), // over-consumed Payment
      () => buildLiabilityBlocks([], [un({ original: -5n })], 0n, -5n),
    ];
    for (const call of calls) {
      let err: unknown;
      try {
        call();
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject(integrity);
      expect((err as DomainError).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });

  it('exact bigint money beyond Number.MAX_SAFE_INTEGER, and a KWD-sized figure', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const b = buildLiabilityBlocks(
      [adv('OPENING', { principal: big, applied: 1n })],
      [un({ original: big, allocated: 1n, paymentCountWithUnapplied: 1 })],
      big - 1n,
      big - 1n,
    );
    expect(b.advances.bookLiabilityMinor).toBe('9007199254740992');
    expect(b.unappliedReceipts.unappliedReceiptMinor).toBe('9007199254740992');
    const kwd = buildLiabilityBlocks([adv('PAYMENT', { principal: 12_345n })], [], 12_345n, 0n);
    expect(kwd.advances.bookLiabilityMinor).toBe('12345');
  });

  it('per-customer rows merge both liabilities in customerId order: a customer holding only one side is zero-filled on the other', () => {
    const rows = buildCustomerLiabilityRows(
      [
        { customerId: 'bbb', ...adv('PAYMENT', { count: 1, principal: 500n, applied: 100n }) },
        { customerId: 'bbb', ...adv('CREDIT_NOTE', { count: 1, principal: 300n, reserved: 100n }) },
        { customerId: 'ccc', ...adv('OPENING', { count: 1, principal: 50n }) },
      ],
      [
        {
          customerId: 'aaa',
          ...un({ paymentCount: 1, paymentCountWithUnapplied: 1, original: 70n }),
        },
        {
          customerId: 'bbb',
          ...un({
            paymentCount: 2,
            paymentCountWithUnapplied: 1,
            original: 900n,
            allocated: 400n,
            converted: 500n,
          }),
        },
      ],
    );
    expect(rows.map((r) => r.customerId)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(rows[0]!.advances).toMatchObject({
      advanceCount: 0,
      bookLiabilityMinor: '0',
      availableMinor: '0',
    });
    expect(rows[0]!.unappliedReceipts).toMatchObject({ unappliedReceiptMinor: '70' });
    expect(rows[1]!.advances).toMatchObject({
      advanceCount: 2,
      bookLiabilityMinor: '700',
      pendingRefundReservationMinor: '100',
      availableMinor: '600',
    });
    expect(rows[1]!.unappliedReceipts).toMatchObject({
      originalReceiptMinor: '900',
      allocatedToReceivablesMinor: '400',
      convertedToAdvanceMinor: '500',
      unappliedReceiptMinor: '0',
    });
    expect(rows[2]!.unappliedReceipts).toMatchObject({
      paymentCount: 0,
      unappliedReceiptMinor: '0',
    });
    // no PII, no aging, no GL on a customer row
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['advances', 'customerId', 'unappliedReceipts']);
    }
  });

  it('the pagination convention: default 50, max 200, a non-positive / fractional / non-number limit is INVALID_LIMIT, a non-uuid cursor INVALID_CURSOR', () => {
    expect([LIABILITIES_REPORT_DEFAULT_LIMIT, LIABILITIES_REPORT_MAX_LIMIT]).toEqual([50, 200]);
    expect(parseLiabilitiesLimit(undefined)).toBe(50);
    expect(parseLiabilitiesLimit(7)).toBe(7);
    expect(parseLiabilitiesLimit(5_000)).toBe(200);
    for (const bad of [0, -1, 1.5, '10', null, NaN]) {
      expect(() => parseLiabilitiesLimit(bad)).toThrowError(/limit must be a positive integer/);
    }
    expect(parseLiabilitiesCursor(undefined)).toBeNull();
    expect(parseLiabilitiesCursor('0194C0DE-0000-7000-8000-000000000001')).toBe(
      '0194c0de-0000-7000-8000-000000000001',
    );
    for (const bad of ['x', 7, '', null]) {
      expect(() => parseLiabilitiesCursor(bad)).toThrowError(/not a valid cursor/);
    }
  });

  it('asOf is accepted only as the database timestamp format (ISO-8601 UTC with milliseconds)', () => {
    expect(assertAsOf('2026-10-06T12:34:56.789Z')).toBe('2026-10-06T12:34:56.789Z');
    for (const bad of [
      '2026-10-06',
      '2026-10-06T12:34:56Z',
      '2026-10-06 12:34:56.789',
      42,
      null,
      undefined,
    ]) {
      expect(() => assertAsOf(bad)).toThrow(RangeError);
    }
  });
});
