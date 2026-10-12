import { describe, expect, it } from 'vitest';
import type { DomainError } from '../../common/errors/domain-error.js';
import {
  computeReceivableBalance,
  RECEIVABLE_SOURCE_TYPES,
} from '../receivables/receivable-balance.js';
import {
  assertAsOf,
  buildCustomerRows,
  buildReceivablesBlocks,
  parseReceivablesCursor,
  parseReceivablesLimit,
  RECEIVABLES_REPORT_DEFAULT_LIMIT,
  RECEIVABLES_REPORT_MAX_LIMIT,
  RECEIVABLES_REPORT_NOTE,
  type ReceivablesCell,
} from './receivables-report.js';

const cell = (
  sourceType: string,
  o: Partial<Omit<ReceivablesCell, 'sourceType'>> = {},
): ReceivablesCell => ({
  sourceType,
  count: o.count ?? 1,
  original: o.original ?? 0n,
  paidByPayment: o.paidByPayment ?? 0n,
  paidByAdvance: o.paidByAdvance ?? 0n,
  credited: o.credited ?? 0n,
});

describe('Receivables current-state — pure arithmetic (task 3b.10 Checkpoint D)', () => {
  it('zero-fills EVERY frozen source type, in the frozen order, with the frozen balance equation', () => {
    const b = buildReceivablesBlocks([], 0n);
    expect(b.bySourceType.map((r) => r.sourceType)).toEqual([...RECEIVABLE_SOURCE_TYPES]);
    for (const r of b.bySourceType) {
      expect(r).toMatchObject({
        receivableCount: 0,
        originalMinor: '0',
        paidByPaymentMinor: '0',
        paidByAdvanceMinor: '0',
        creditedMinor: '0',
        outstandingMinor: '0',
      });
    }
    expect(b).toMatchObject({
      receivableCount: 0,
      outstandingMinor: '0',
      reconciliation: {
        sourceOutstandingMinor: '0',
        glAccountsReceivableMinor: '0',
        differenceMinor: '0',
        reconciled: true,
      },
    });
    expect(b.note).toBe(RECEIVABLES_REPORT_NOTE);
  });

  it('outstanding = original − paid by payment − paid by advance − credited, per source type and in total', () => {
    const cells = [
      cell('INVOICE', {
        count: 3,
        original: 10_000n,
        paidByPayment: 4_000n,
        paidByAdvance: 1_000n,
        credited: 500n,
      }),
      cell('OPENING', { count: 1, original: 2_000n, paidByPayment: 500n, paidByAdvance: 250n }),
      cell('CANCELLATION_CHARGE', { count: 2, original: 300n }),
    ];
    // 4 500 + 1 250 + 300 = 6 050
    const b = buildReceivablesBlocks(cells, 6_050n);
    expect(b).toMatchObject({
      receivableCount: 6,
      originalMinor: '12300',
      paidByPaymentMinor: '4500',
      paidByAdvanceMinor: '1250',
      creditedMinor: '500',
      outstandingMinor: '6050',
    });
    expect(b.bySourceType.map((r) => [r.sourceType, r.outstandingMinor])).toEqual([
      ['INVOICE', '4500'],
      ['OPENING', '1250'],
      ['CANCELLATION_CHARGE', '300'],
    ]);
  });

  it('is DIFFERENTIALLY equal to the frozen computeReceivableBalance over randomized receivables', () => {
    // a deterministic LCG — the property test needs no randomness source and is reproducible
    let seed = 0x2f6e2b1;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const receivables = Array.from({ length: 1 + next(12) }, () => {
        const sourceType = RECEIVABLE_SOURCE_TYPES[next(3)]!;
        const original = BigInt(1 + next(1_000_000));
        // a valid (never over-covered) split of `original`
        const pay = BigInt(next(Number(original) + 1));
        const adv = BigInt(next(Number(original - pay) + 1));
        const crd = sourceType === 'INVOICE' ? BigInt(next(Number(original - pay - adv) + 1)) : 0n;
        return { sourceType, original, pay, adv, crd };
      });
      const oracle = receivables.map((r) =>
        computeReceivableBalance({
          sourceType: r.sourceType,
          principalMinor: r.original,
          paidByPaymentMinor: r.pay,
          paidByAdvanceMinor: r.adv,
          creditedMinor: r.crd,
        }),
      );
      const cells = RECEIVABLE_SOURCE_TYPES.map((t) => {
        const rows = receivables.filter((r) => r.sourceType === t);
        return cell(t, {
          count: rows.length,
          original: rows.reduce((n, r) => n + r.original, 0n),
          paidByPayment: rows.reduce((n, r) => n + r.pay, 0n),
          paidByAdvance: rows.reduce((n, r) => n + r.adv, 0n),
          credited: rows.reduce((n, r) => n + r.crd, 0n),
        });
      });
      const expectedOutstanding = oracle.reduce((n, o) => n + o.outstandingMinor, 0n);
      const b = buildReceivablesBlocks(cells, expectedOutstanding);
      expect(b.outstandingMinor).toBe(expectedOutstanding.toString());
      expect(b.originalMinor).toBe(oracle.reduce((n, o) => n + o.originalMinor, 0n).toString());
      expect(b.paidByPaymentMinor).toBe(
        oracle.reduce((n, o) => n + o.paidByPaymentMinor, 0n).toString(),
      );
      expect(b.paidByAdvanceMinor).toBe(
        oracle.reduce((n, o) => n + o.paidByAdvanceMinor, 0n).toString(),
      );
      expect(b.creditedMinor).toBe(oracle.reduce((n, o) => n + o.creditedMinor, 0n).toString());
      expect(b.receivableCount).toBe(receivables.length);
    }
  });

  it('the CreditNote EXCESS is never subtracted again: only the AR reduction is `credited` (the cell carries nothing else)', () => {
    // a 1 000 invoice paid 600; a full CreditNote: arReduction 400 (the unpaid remainder), advanceExcess 600 (paid portion)
    const b = buildReceivablesBlocks(
      [cell('INVOICE', { original: 1_000n, paidByPayment: 600n, credited: 400n })],
      0n,
    );
    expect(b.creditedMinor).toBe('400');
    expect(b.outstandingMinor).toBe('0');
    // subtracting the credit note TOTAL (1 000) would over-cover the receivable and fail closed
    expect(() =>
      buildReceivablesBlocks(
        [cell('INVOICE', { original: 1_000n, paidByPayment: 600n, credited: 1_000n })],
        -600n,
      ),
    ).toThrowError(expect.objectContaining({ code: 'REPORT_RECEIVABLES_SOURCE_INTEGRITY' }));
  });

  it('exact bigint money beyond Number.MAX_SAFE_INTEGER, and a KWD-sized figure', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const b = buildReceivablesBlocks(
      [cell('INVOICE', { original: big * 3n, paidByPayment: big })],
      big * 2n,
    );
    expect(b.outstandingMinor).toBe((big * 2n).toString());
    expect(b.originalMinor).toBe((big * 3n).toString());
    // KWD (3 decimals): 12.345 KWD = 12345 minor — nothing is rounded or scaled
    expect(
      buildReceivablesBlocks([cell('OPENING', { original: 12_345n, paidByAdvance: 345n })], 12_000n)
        .outstandingMinor,
    ).toBe('12000');
  });

  it('a GL difference fails the report closed — a figure is never returned with a failed control', () => {
    for (const gl of [0n, 1n, -1n, 6_049n, 6_051n]) {
      expect(() =>
        buildReceivablesBlocks([cell('INVOICE', { original: 7_000n, paidByPayment: 950n })], gl),
      ).toThrowError(
        expect.objectContaining({ code: 'REPORT_RECEIVABLES_GL_MISMATCH', status: 500 }),
      );
    }
    // the sign of the control: GL net = debit − credit, source outstanding positive
    expect(
      buildReceivablesBlocks([cell('INVOICE', { original: 7_000n, paidByPayment: 950n })], 6_050n)
        .reconciliation,
    ).toEqual({
      sourceOutstandingMinor: '6050',
      glAccountsReceivableMinor: '6050',
      differenceMinor: '0',
      reconciled: true,
    });
  });

  it('every malformed cell is a fail-closed integrity error, never a thrown RangeError or a silent figure', () => {
    const integrity = expect.objectContaining({
      code: 'REPORT_RECEIVABLES_SOURCE_INTEGRITY',
      status: 500,
    });
    // an unknown source type — never defaulted to OPENING
    expect(() => buildReceivablesBlocks([cell('GIFT', { original: 1n })], 1n)).toThrowError(
      integrity,
    );
    // a CreditNote reduction on a non-INVOICE receivable
    expect(() =>
      buildReceivablesBlocks([cell('OPENING', { original: 10n, credited: 1n })], 9n),
    ).toThrowError(integrity);
    // a negative component
    expect(() =>
      buildReceivablesBlocks([cell('INVOICE', { original: 10n, paidByPayment: -1n })], 11n),
    ).toThrowError(integrity);
    // an over-covered (negative outstanding) receivable
    expect(() =>
      buildReceivablesBlocks([cell('INVOICE', { original: 10n, paidByPayment: 11n })], -1n),
    ).toThrowError(integrity);
    // the message names no identifier
    try {
      buildReceivablesBlocks([cell('GIFT', { original: 1n })], 1n);
    } catch (e) {
      expect((e as DomainError).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });

  it('per-customer rows: one row per customer in customerId order, each the helper-folded sum of that customer’s cells; zero-outstanding customers stay', () => {
    const rows = buildCustomerRows([
      {
        customerId: 'bbbbbbbb-0000-4000-8000-000000000002',
        ...cell('INVOICE', { original: 500n, paidByPayment: 500n }),
      },
      {
        customerId: 'aaaaaaaa-0000-4000-8000-000000000001',
        ...cell('INVOICE', { count: 2, original: 900n, paidByAdvance: 100n, credited: 200n }),
      },
      { customerId: 'aaaaaaaa-0000-4000-8000-000000000001', ...cell('OPENING', { original: 50n }) },
    ]);
    expect(rows).toEqual([
      {
        customerId: 'aaaaaaaa-0000-4000-8000-000000000001',
        receivableCount: 3,
        originalMinor: '950',
        paidByPaymentMinor: '0',
        paidByAdvanceMinor: '100',
        creditedMinor: '200',
        outstandingMinor: '650',
      },
      {
        customerId: 'bbbbbbbb-0000-4000-8000-000000000002',
        receivableCount: 1,
        originalMinor: '500',
        paidByPaymentMinor: '500',
        paidByAdvanceMinor: '0',
        creditedMinor: '0',
        outstandingMinor: '0',
      },
    ]);
    // no PII, no aging, no balance label other than the frozen ones
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        'creditedMinor',
        'customerId',
        'originalMinor',
        'outstandingMinor',
        'paidByAdvanceMinor',
        'paidByPaymentMinor',
        'receivableCount',
      ]);
    }
  });

  it('the pagination convention: default 50, max 200, a non-positive / fractional / non-number limit is INVALID_LIMIT, a non-uuid cursor INVALID_CURSOR', () => {
    expect(RECEIVABLES_REPORT_DEFAULT_LIMIT).toBe(50);
    expect(RECEIVABLES_REPORT_MAX_LIMIT).toBe(200);
    expect(parseReceivablesLimit(undefined)).toBe(50);
    expect(parseReceivablesLimit(1)).toBe(1);
    expect(parseReceivablesLimit(200)).toBe(200);
    expect(parseReceivablesLimit(5_000)).toBe(200);
    for (const bad of [0, -1, 1.5, Number.NaN, '10', null]) {
      expect(() => parseReceivablesLimit(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_LIMIT', status: 400 }),
      );
    }
    expect(parseReceivablesCursor(undefined)).toBeNull();
    expect(parseReceivablesCursor('AAAAAAAA-0000-4000-8000-000000000001')).toBe(
      'aaaaaaaa-0000-4000-8000-000000000001',
    );
    for (const bad of ['', 'nope', '123', 5, null, 'aaaaaaaa-0000-4000-8000-00000000000z']) {
      expect(() => parseReceivablesCursor(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }),
      );
    }
  });

  it('asOf is accepted only as the database timestamp format (ISO-8601 UTC with milliseconds)', () => {
    expect(assertAsOf('2026-10-06T12:34:56.789Z')).toBe('2026-10-06T12:34:56.789Z');
    for (const bad of [
      '2026-10-06',
      '2026-10-06T12:34:56Z',
      '2026-10-06 12:34:56.789',
      5,
      null,
      undefined,
    ]) {
      expect(() => assertAsOf(bad)).toThrow(RangeError);
    }
  });
});
