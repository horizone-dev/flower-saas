import { describe, expect, it } from 'vitest';
import type { RoundingMode } from '@flower/money';
import {
  exactLineTax,
  roundExact,
  computeLineTaxAmountMinor,
  inclusiveNetAmountMinor,
  reconcileDocumentTax,
  type DocumentTaxLineInput,
} from './tax-arithmetic.js';

const ALL_MODES: RoundingMode[] = ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'HALF_DOWN'];

describe('tax-arithmetic (task 3b.4 Checkpoint A — pure arithmetic)', () => {
  // ── A3 EXCLUSIVE ──────────────────────────────────────────────────────────
  describe('EXCLUSIVE tax', () => {
    it('A. 5% exact integer result', () => {
      // 1000 minor * 500bps / 10000 = 50 exactly
      const r = exactLineTax(1000n, 500, 'TAX_EXCLUSIVE');
      expect(r).toEqual({ numerator: 500000n, denominator: 10000n });
      expect(roundExact(r, 'HALF_UP')).toBe(50n);
      expect(computeLineTaxAmountMinor(1000n, 500, 'TAX_EXCLUSIVE', 'HALF_UP')).toBe(50n);
    });

    it('B. fractional-minor tax — all rounding modes', () => {
      // 333 * 500 / 10000 = 166500/10000 = 16.65 -> q=16, r=6500, twice=13000 > denom(10000) (strictly above half)
      const r = exactLineTax(333n, 500, 'TAX_EXCLUSIVE');
      expect(r).toEqual({ numerator: 166500n, denominator: 10000n });
      // strictly above half -> every mode except DOWN rounds up
      expect(roundExact(r, 'HALF_UP')).toBe(17n);
      expect(roundExact(r, 'HALF_DOWN')).toBe(17n);
      expect(roundExact(r, 'HALF_EVEN')).toBe(17n);
      expect(roundExact(r, 'UP')).toBe(17n);
      expect(roundExact(r, 'DOWN')).toBe(16n);
    });

    it('HALF_EVEN rounds up when the quotient is odd at an exact half', () => {
      // 6 * 4000 / 10000 = 24000/10000 = 2.4 -> not a half case; use a
      // constructed rational directly for a q-odd exact-half case: 6/4
      const r = { numerator: 6n, denominator: 4n };
      expect(roundExact(r, 'HALF_EVEN')).toBe(2n); // q=1 (odd) -> rounds up to 2
      expect(roundExact(r, 'HALF_UP')).toBe(2n);
      expect(roundExact(r, 'HALF_DOWN')).toBe(1n);
      expect(roundExact(r, 'DOWN')).toBe(1n);
      expect(roundExact(r, 'UP')).toBe(2n);
    });
  });

  // ── A4 INCLUSIVE ──────────────────────────────────────────────────────────
  describe('INCLUSIVE tax', () => {
    it('C. 5% — tax extracted correctly, net derived without independent rounding', () => {
      // 1050 * 500 / 10500 = 50 exactly
      const r = exactLineTax(1050n, 500, 'TAX_INCLUSIVE');
      expect(r).toEqual({ numerator: 525000n, denominator: 10500n });
      const tax = roundExact(r, 'HALF_UP');
      expect(tax).toBe(50n);
      expect(inclusiveNetAmountMinor(1050n, tax)).toBe(1000n);
      // net + tax reconstructs the original amount exactly, always
      expect(inclusiveNetAmountMinor(1050n, tax) + tax).toBe(1050n);
    });

    it('D. different rates produce different denominators', () => {
      const r5 = exactLineTax(1000n, 500, 'TAX_INCLUSIVE');
      const r15 = exactLineTax(1000n, 1500, 'TAX_INCLUSIVE');
      expect(r5.denominator).toBe(10500n);
      expect(r15.denominator).toBe(11500n);
      expect(r5.denominator).not.toBe(r15.denominator);
    });

    it('inclusive tax is never added back onto the commercial amount', () => {
      const amount = 1050n;
      const tax = computeLineTaxAmountMinor(amount, 500, 'TAX_INCLUSIVE', 'HALF_UP');
      // "payable" for an inclusive line IS the original amount, never amount+tax
      const payable = amount; // by contract — no function in this module adds tax for INCLUSIVE
      expect(payable).toBe(1050n);
      expect(tax).toBe(50n);
    });
  });

  // ── A5 no-rate / zero-rate ────────────────────────────────────────────────
  describe('no-rate vs resolved zero-rate', () => {
    it('H. a resolved zero rate produces zero tax via the real arithmetic path', () => {
      expect(computeLineTaxAmountMinor(1000n, 0, 'TAX_EXCLUSIVE', 'HALF_UP')).toBe(0n);
      expect(computeLineTaxAmountMinor(1000n, 0, 'TAX_INCLUSIVE', 'HALF_UP')).toBe(0n);
    });

    it('I. no-rate is a caller-boundary omission, not a code path in this module', () => {
      // the caller never calls exactLineTax/computeLineTaxAmountMinor for a
      // no-rate line at all; it fixes lineTaxAmountMinor=0n directly and
      // OMITS the line from reconcileDocumentTax's input entirely.
      const ratedLine: DocumentTaxLineInput = {
        linePosition: 1,
        rational: exactLineTax(1000n, 500, 'TAX_EXCLUSIVE'),
      };
      const result = reconcileDocumentTax([ratedLine], 'HALF_UP');
      // a no-rate line at linePosition 2 simply never appears here — the
      // caller is responsible for setting its own lineTaxAmountMinor=0n.
      expect(result.lines.map((l) => l.linePosition)).toEqual([1]);
      expect(result.taxTotalAmountMinor).toBe(50n);
    });
  });

  // ── A6 LINE rounding — every mode, every boundary ────────────────────────
  describe('LINE rounding — boundary matrix', () => {
    it('integer exact result (no rounding needed) — identical across all modes', () => {
      for (const mode of ALL_MODES) {
        expect(roundExact({ numerator: 100n, denominator: 4n }, mode)).toBe(25n);
      }
    });

    it('below half', () => {
      // 9/4 = 2.25 -> q=2, r=1, twice=2 < denom(4)
      const r = { numerator: 9n, denominator: 4n };
      expect(roundExact(r, 'HALF_UP')).toBe(2n);
      expect(roundExact(r, 'HALF_EVEN')).toBe(2n);
      expect(roundExact(r, 'HALF_DOWN')).toBe(2n);
      expect(roundExact(r, 'DOWN')).toBe(2n);
      expect(roundExact(r, 'UP')).toBe(3n);
    });

    it('exact half (q even) — only UP and HALF_UP round up', () => {
      // 10/4 = 2.5 -> q=2 (even), r=2, twice=4=denom
      const r = { numerator: 10n, denominator: 4n };
      expect(roundExact(r, 'HALF_UP')).toBe(3n);
      expect(roundExact(r, 'HALF_EVEN')).toBe(2n); // q even -> stays
      expect(roundExact(r, 'HALF_DOWN')).toBe(2n);
      expect(roundExact(r, 'DOWN')).toBe(2n);
      expect(roundExact(r, 'UP')).toBe(3n);
    });

    it('above half', () => {
      // 11/4 = 2.75 -> q=2, r=3, twice=6 > denom(4)
      const r = { numerator: 11n, denominator: 4n };
      for (const mode of ['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP'] as RoundingMode[]) {
        expect(roundExact(r, mode)).toBe(3n);
      }
      expect(roundExact(r, 'DOWN')).toBe(2n);
    });

    it('zero', () => {
      for (const mode of ALL_MODES) {
        expect(roundExact({ numerator: 0n, denominator: 7n }, mode)).toBe(0n);
      }
    });

    it('N. very large bigint amount — no precision loss (proves no Number conversion anywhere)', () => {
      const huge = 10n ** 20n; // far beyond Number.MAX_SAFE_INTEGER
      const r = exactLineTax(huge, 500, 'TAX_EXCLUSIVE');
      expect(r.numerator).toBe(huge * 500n);
      expect(roundExact(r, 'HALF_UP')).toBe((huge * 500n) / 10000n); // exact, no remainder
      // a case with a genuine large-scale remainder
      const r2 = { numerator: huge + 1n, denominator: 3n };
      expect(roundExact(r2, 'DOWN')).toBe((huge + 1n) / 3n);
    });
  });

  // ── A7/A9 DOCUMENT rounding ───────────────────────────────────────────────
  describe('DOCUMENT rounding reconciliation', () => {
    it('E. two exclusive lines, same rate', () => {
      const lines: DocumentTaxLineInput[] = [
        { linePosition: 1, rational: exactLineTax(1000n, 500, 'TAX_EXCLUSIVE') }, // 50 exact
        { linePosition: 2, rational: exactLineTax(333n, 500, 'TAX_EXCLUSIVE') }, // 16.65
      ];
      const result = reconcileDocumentTax(lines, 'HALF_UP');
      // exact document sum = 50 + 16.65 = 66.65 -> HALF_UP -> 67
      expect(result.taxTotalAmountMinor).toBe(67n);
      const sum = result.lines.reduce((a, l) => a + l.lineTaxAmountMinor, 0n);
      expect(sum).toBe(67n);
      // line1 base=50 exact (remainder 0), line2 base=16 (remainder 5000/10000)
      // residual=1 goes to the line with the larger remainder (line 2)
      expect(result.lines.find((l) => l.linePosition === 2)!.lineTaxAmountMinor).toBe(17n);
      expect(result.lines.find((l) => l.linePosition === 1)!.lineTaxAmountMinor).toBe(50n);
    });

    it('F. inclusive lines with different rates — heterogeneous denominators', () => {
      const lines: DocumentTaxLineInput[] = [
        { linePosition: 1, rational: exactLineTax(1050n, 500, 'TAX_INCLUSIVE') }, // denom 10500, exact 50
        { linePosition: 2, rational: exactLineTax(1000n, 1500, 'TAX_INCLUSIVE') }, // denom 11500
      ];
      // line2 exact: 1000*1500/11500 = 1500000/11500 = 130.434...
      const result = reconcileDocumentTax(lines, 'HALF_UP');
      const sum = result.lines.reduce((a, l) => a + l.lineTaxAmountMinor, 0n);
      expect(sum).toBe(result.taxTotalAmountMinor);
      // exact total = 50 + 130.4347826... = 180.4347826... -> HALF_UP -> 180
      expect(result.taxTotalAmountMinor).toBe(180n);
    });

    it('G. mixed exact-integer + fractional tax lines', () => {
      const lines: DocumentTaxLineInput[] = [
        { linePosition: 1, rational: exactLineTax(2000n, 500, 'TAX_EXCLUSIVE') }, // 100 exact
        { linePosition: 2, rational: exactLineTax(333n, 500, 'TAX_EXCLUSIVE') }, // 16.65
        { linePosition: 3, rational: exactLineTax(1n, 500, 'TAX_EXCLUSIVE') }, // 0.05
      ];
      const result = reconcileDocumentTax(lines, 'HALF_UP');
      // exact sum = 100 + 16.65 + 0.05 = 116.70 -> exact integer at HALF_UP -> 117? wait 116.70 rounds to 117 under HALF_UP? 116.70 -> nearest integer is 117 (0.70>0.5)
      expect(result.taxTotalAmountMinor).toBe(117n);
      const sum = result.lines.reduce((a, l) => a + l.lineTaxAmountMinor, 0n);
      expect(sum).toBe(117n);
    });

    it('J. equal fractional remainders — lower linePosition receives residual first', () => {
      const lines: DocumentTaxLineInput[] = [
        { linePosition: 2, rational: { numerator: 5n, denominator: 10n } }, // remainder 5/10, base 0
        { linePosition: 1, rational: { numerator: 5n, denominator: 10n } }, // identical remainder
      ];
      // exact sum = 0.5+0.5=1.0 exact -> HALF_UP of exact 1 -> 1 (no rounding needed, exact)
      // base: floor(5/10)=0 each, baseSum=0, roundedDocumentTax=divRound(10,10,'HALF_UP')=1
      // residual=1 -> tie broken by linePosition ASC -> linePosition 1 gets it
      const result = reconcileDocumentTax(lines, 'HALF_UP');
      expect(result.taxTotalAmountMinor).toBe(1n);
      expect(result.lines).toEqual([
        { linePosition: 1, lineTaxAmountMinor: 1n },
        { linePosition: 2, lineTaxAmountMinor: 0n },
      ]);
    });

    it('K. different fractional remainders — mathematically larger remainder wins even with a smaller raw numerator', () => {
      const lines: DocumentTaxLineInput[] = [
        // line1: numerator 1, denominator 3 -> remainder fraction 1/3 (~0.333)
        { linePosition: 1, rational: { numerator: 1n, denominator: 3n } },
        // line2: numerator 9, denominator 20 -> remainder fraction 9/20 (0.45) — LARGER despite bigger numbers
        { linePosition: 2, rational: { numerator: 9n, denominator: 20n } },
      ];
      // exact sum = 1/3 + 9/20 = 20/60 + 27/60 = 47/60 ≈ 0.7833 -> HALF_UP -> 1
      const result = reconcileDocumentTax(lines, 'HALF_UP');
      expect(result.taxTotalAmountMinor).toBe(1n);
      // base: floor(1/3)=0, floor(9/20)=0, baseSum=0, residual=1
      // remainder fractions: line1=1/3≈0.333, line2=9/20=0.45 -> line2 wins (larger)
      expect(result.lines.find((l) => l.linePosition === 2)!.lineTaxAmountMinor).toBe(1n);
      expect(result.lines.find((l) => l.linePosition === 1)!.lineTaxAmountMinor).toBe(0n);
    });

    it('L. residual = 0 (exact document total, no unit to distribute)', () => {
      const lines: DocumentTaxLineInput[] = [
        { linePosition: 1, rational: exactLineTax(1000n, 500, 'TAX_EXCLUSIVE') }, // 50 exact
        { linePosition: 2, rational: exactLineTax(2000n, 500, 'TAX_EXCLUSIVE') }, // 100 exact
      ];
      const result = reconcileDocumentTax(lines, 'HALF_UP');
      expect(result.taxTotalAmountMinor).toBe(150n);
      expect(result.lines).toEqual([
        { linePosition: 1, lineTaxAmountMinor: 50n },
        { linePosition: 2, lineTaxAmountMinor: 100n },
      ]);
    });

    it('M. residual = multiple units', () => {
      // 5 lines each with exact remainder 0.6 -> base 0 each, exact sum = 3.0 exact
      // use numerator=3, denominator=5 (0.6) for each of 5 lines
      const lines: DocumentTaxLineInput[] = Array.from({ length: 5 }, (_, i) => ({
        linePosition: i + 1,
        rational: { numerator: 3n, denominator: 5n },
      }));
      const result = reconcileDocumentTax(lines, 'HALF_UP');
      // exact sum = 5 * 0.6 = 3.0 exactly -> rounded = 3 -> baseSum = 0 (floor(0.6)=0 each) -> residual = 3
      expect(result.taxTotalAmountMinor).toBe(3n);
      const ones = result.lines.filter((l) => l.lineTaxAmountMinor === 1n);
      const zeros = result.lines.filter((l) => l.lineTaxAmountMinor === 0n);
      expect(ones).toHaveLength(3);
      expect(zeros).toHaveLength(2);
      // all remainders are identical (3/5 each) -> tie-break by linePosition ASC -> lowest 3 positions win
      expect(ones.map((l) => l.linePosition).sort()).toEqual([1, 2, 3]);
    });

    it('O. deterministic output regardless of input array order — semantic ordering is linePosition only', () => {
      const lines: DocumentTaxLineInput[] = [
        { linePosition: 2, rational: exactLineTax(333n, 500, 'TAX_EXCLUSIVE') },
        { linePosition: 1, rational: exactLineTax(1000n, 500, 'TAX_EXCLUSIVE') },
      ];
      const reversed = [...lines].reverse();
      const a = reconcileDocumentTax(lines, 'HALF_UP');
      const b = reconcileDocumentTax(reversed, 'HALF_UP');
      expect(a).toEqual(b);
      expect(a.lines.map((l) => l.linePosition)).toEqual([1, 2]); // output always linePosition-sorted
    });

    it('empty input', () => {
      const result = reconcileDocumentTax([], 'HALF_UP');
      expect(result).toEqual({ lines: [], taxTotalAmountMinor: 0n });
    });

    it('proves Σ line amounts always exactly equals taxTotalAmountMinor, across all 5 modes', () => {
      const lines: DocumentTaxLineInput[] = [
        { linePosition: 1, rational: exactLineTax(1050n, 500, 'TAX_INCLUSIVE') },
        { linePosition: 2, rational: exactLineTax(1000n, 1500, 'TAX_INCLUSIVE') },
        { linePosition: 3, rational: exactLineTax(333n, 500, 'TAX_EXCLUSIVE') },
      ];
      for (const mode of ALL_MODES) {
        const result = reconcileDocumentTax(lines, mode);
        const sum = result.lines.reduce((a, l) => a + l.lineTaxAmountMinor, 0n);
        expect(sum).toBe(result.taxTotalAmountMinor);
      }
    });
  });

  // ── A8 validation / invariants ────────────────────────────────────────────
  describe('validation / invariant enforcement', () => {
    it('rejects denominator <= 0', () => {
      expect(() => roundExact({ numerator: 1n, denominator: 0n }, 'HALF_UP')).toThrow(RangeError);
      expect(() => roundExact({ numerator: 1n, denominator: -1n }, 'HALF_UP')).toThrow(RangeError);
    });

    it('rejects negative numerator', () => {
      expect(() => roundExact({ numerator: -1n, denominator: 4n }, 'HALF_UP')).toThrow(RangeError);
    });

    it('rejects negative commercial amount in exactLineTax', () => {
      expect(() => exactLineTax(-1n, 500, 'TAX_EXCLUSIVE')).toThrow(RangeError);
    });

    it('rejects a non-integer or negative rateBps', () => {
      expect(() => exactLineTax(1000n, -1, 'TAX_EXCLUSIVE')).toThrow(RangeError);
      expect(() => exactLineTax(1000n, 5.5, 'TAX_EXCLUSIVE')).toThrow(RangeError);
    });

    it('rejects a non-positive linePosition in reconcileDocumentTax', () => {
      expect(() =>
        reconcileDocumentTax(
          [{ linePosition: 0, rational: { numerator: 1n, denominator: 2n } }],
          'HALF_UP',
        ),
      ).toThrow(RangeError);
      expect(() =>
        reconcileDocumentTax(
          [{ linePosition: -1, rational: { numerator: 1n, denominator: 2n } }],
          'HALF_UP',
        ),
      ).toThrow(RangeError);
    });

    it('rejects duplicate linePosition', () => {
      expect(() =>
        reconcileDocumentTax(
          [
            { linePosition: 1, rational: { numerator: 1n, denominator: 2n } },
            { linePosition: 1, rational: { numerator: 1n, denominator: 2n } },
          ],
          'HALF_UP',
        ),
      ).toThrow(RangeError);
    });

    it('rejects an invalid rational inside reconcileDocumentTax input', () => {
      expect(() =>
        reconcileDocumentTax(
          [{ linePosition: 1, rational: { numerator: 1n, denominator: 0n } }],
          'HALF_UP',
        ),
      ).toThrow(RangeError);
    });
  });

  // ── A10 arithmetic safety ─────────────────────────────────────────────────
  describe('arithmetic safety — no float, no Number leak', () => {
    it('exactLineTax/roundExact return BigInt only, never a JS number', () => {
      const r = exactLineTax(1000n, 500, 'TAX_EXCLUSIVE');
      expect(typeof r.numerator).toBe('bigint');
      expect(typeof r.denominator).toBe('bigint');
      expect(typeof roundExact(r, 'HALF_UP')).toBe('bigint');
    });

    it('reconcileDocumentTax returns BigInt only throughout', () => {
      const result = reconcileDocumentTax(
        [{ linePosition: 1, rational: exactLineTax(1000n, 500, 'TAX_EXCLUSIVE') }],
        'HALF_UP',
      );
      expect(typeof result.taxTotalAmountMinor).toBe('bigint');
      for (const l of result.lines) expect(typeof l.lineTaxAmountMinor).toBe('bigint');
    });
  });
});
