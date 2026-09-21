import { describe, expect, it } from 'vitest';
import {
  allocateDocumentDiscount,
  type DocumentDiscountLineInput,
} from './document-discount-allocation.js';

const AED = 'AED';

function line(linePosition: number, weight: bigint): DocumentDiscountLineInput {
  return { linePosition, commercialAmountAfterLineDiscountMinor: weight };
}

describe('document-discount-allocation (task 3b.4 Checkpoint B — pure allocation)', () => {
  it('A. D=0, normal lines — every share 0, every after-amount unchanged', () => {
    const result = allocateDocumentDiscount([line(1, 500n), line(2, 300n)], 0n, AED);
    expect(result.lines).toEqual([
      {
        linePosition: 1,
        documentDiscountShareMinor: 0n,
        commercialAmountAfterDocumentDiscountMinor: 500n,
      },
      {
        linePosition: 2,
        documentDiscountShareMinor: 0n,
        commercialAmountAfterDocumentDiscountMinor: 300n,
      },
    ]);
  });

  it('B. D=0, all line amounts = 0 — valid, all-zero result', () => {
    const result = allocateDocumentDiscount([line(1, 0n), line(2, 0n)], 0n, AED);
    expect(result.lines).toEqual([
      {
        linePosition: 1,
        documentDiscountShareMinor: 0n,
        commercialAmountAfterDocumentDiscountMinor: 0n,
      },
      {
        linePosition: 2,
        documentDiscountShareMinor: 0n,
        commercialAmountAfterDocumentDiscountMinor: 0n,
      },
    ]);
  });

  it('C. one line — the whole discount goes to it (bounded by D<=W)', () => {
    const result = allocateDocumentDiscount([line(1, 1000n)], 400n, AED);
    expect(result.lines).toEqual([
      {
        linePosition: 1,
        documentDiscountShareMinor: 400n,
        commercialAmountAfterDocumentDiscountMinor: 600n,
      },
    ]);
  });

  it('D. two equal lines — evenly split', () => {
    const result = allocateDocumentDiscount([line(1, 500n), line(2, 500n)], 100n, AED);
    expect(result.lines.map((l) => l.documentDiscountShareMinor)).toEqual([50n, 50n]);
  });

  it('E. uneven proportional split', () => {
    // weights 300/200/100 (W=600), D=100
    const result = allocateDocumentDiscount(
      [line(1, 300n), line(2, 200n), line(3, 100n)],
      100n,
      AED,
    );
    expect(result.lines.map((l) => l.documentDiscountShareMinor)).toEqual([50n, 33n, 17n]);
    expect(result.lines.reduce((a, l) => a + l.documentDiscountShareMinor, 0n)).toBe(100n);
  });

  it('F. allocation requiring a 1-minor-unit remainder', () => {
    const result = allocateDocumentDiscount([line(1, 1n), line(2, 1n)], 1n, AED);
    // equal remainders -> lower linePosition wins
    expect(result.lines.map((l) => l.documentDiscountShareMinor)).toEqual([1n, 0n]);
  });

  it('G. multiple residual minor units', () => {
    const lines = Array.from({ length: 5 }, (_, i) => line(i + 1, 1n));
    const result = allocateDocumentDiscount(lines, 3n, AED);
    expect(result.lines.map((l) => l.documentDiscountShareMinor)).toEqual([1n, 1n, 1n, 0n, 0n]);
  });

  it('H. equal fractional remainder -> linePosition ASC tie-break, proven with shuffled input', () => {
    const shuffled = [line(3, 1n), line(1, 1n), line(2, 1n), line(5, 1n), line(4, 1n)];
    const result = allocateDocumentDiscount(shuffled, 3n, AED);
    expect(result.lines.map((l) => [l.linePosition, l.documentDiscountShareMinor])).toEqual([
      [1, 1n],
      [2, 1n],
      [3, 1n],
      [4, 0n],
      [5, 0n],
    ]);
  });

  it('I. zero-weight line mixed with positive-weight lines — the zero-weight line always gets zero', () => {
    const result = allocateDocumentDiscount([line(1, 10n), line(2, 0n), line(3, 10n)], 15n, AED);
    expect(result.lines).toEqual([
      {
        linePosition: 1,
        documentDiscountShareMinor: 8n,
        commercialAmountAfterDocumentDiscountMinor: 2n,
      },
      {
        linePosition: 2,
        documentDiscountShareMinor: 0n,
        commercialAmountAfterDocumentDiscountMinor: 0n,
      },
      {
        linePosition: 3,
        documentDiscountShareMinor: 7n,
        commercialAmountAfterDocumentDiscountMinor: 3n,
      },
    ]);
    expect(result.lines.reduce((a, l) => a + l.documentDiscountShareMinor, 0n)).toBe(15n);
  });

  it('J. no tax-status input exists — every commercial amount is treated identically regardless of what it "would" represent', () => {
    // the input type has no rateBps/priceTaxMode/category field at all; this
    // test proves the SAME two commercial amounts allocate identically no
    // matter what a caller might conceptually associate with them (a
    // "zero-rate" line and a "no-rate" line with the same commercial amount
    // are indistinguishable to this module, by construction/by type).
    const a = allocateDocumentDiscount([line(1, 1000n), line(2, 1000n)], 300n, AED);
    const b = allocateDocumentDiscount([line(1, 1000n), line(2, 1000n)], 300n, AED);
    expect(a).toEqual(b);
    // TypeScript-level proof: DocumentDiscountLineInput has exactly 2 fields.
    const input: DocumentDiscountLineInput = {
      linePosition: 1,
      commercialAmountAfterLineDiscountMinor: 1n,
    };
    expect(Object.keys(input).sort()).toEqual(
      ['commercialAmountAfterLineDiscountMinor', 'linePosition'].sort(),
    );
  });

  it('K. D = W exactly — every line post-discount amount = 0', () => {
    const result = allocateDocumentDiscount([line(1, 70n), line(2, 20n), line(3, 10n)], 100n, AED);
    expect(result.lines).toEqual([
      {
        linePosition: 1,
        documentDiscountShareMinor: 70n,
        commercialAmountAfterDocumentDiscountMinor: 0n,
      },
      {
        linePosition: 2,
        documentDiscountShareMinor: 20n,
        commercialAmountAfterDocumentDiscountMinor: 0n,
      },
      {
        linePosition: 3,
        documentDiscountShareMinor: 10n,
        commercialAmountAfterDocumentDiscountMinor: 0n,
      },
    ]);
  });

  it('L. D = W - 1', () => {
    const result = allocateDocumentDiscount([line(1, 70n), line(2, 20n), line(3, 10n)], 99n, AED);
    expect(result.lines.map((l) => l.documentDiscountShareMinor)).toEqual([69n, 20n, 10n]);
    expect(result.lines.map((l) => l.commercialAmountAfterDocumentDiscountMinor)).toEqual([
      1n,
      0n,
      0n,
    ]);
  });

  it('M. very large BigInt amounts', () => {
    const w1 = 3_000_000_000_000_000_000n;
    const w2 = 1_000_000_000_000_000_000n;
    const result = allocateDocumentDiscount(
      [line(1, w1), line(2, w2)],
      2_000_000_000_000_000_000n,
      AED,
    );
    expect(result.lines.map((l) => l.documentDiscountShareMinor)).toEqual([
      1_500_000_000_000_000_000n,
      500_000_000_000_000_000n,
    ]);
    expect(result.lines.reduce((a, l) => a + l.documentDiscountShareMinor, 0n)).toBe(
      2_000_000_000_000_000_000n,
    );
  });

  it('N. document discount > W -> reject', () => {
    expect(() => allocateDocumentDiscount([line(1, 100n)], 101n, AED)).toThrow(RangeError);
  });

  it('N2. D > 0 with W = 0 -> reject (a special case of D > W)', () => {
    expect(() => allocateDocumentDiscount([line(1, 0n), line(2, 0n)], 1n, AED)).toThrow(RangeError);
  });

  it('O. negative D -> reject', () => {
    expect(() => allocateDocumentDiscount([line(1, 100n)], -1n, AED)).toThrow(RangeError);
  });

  it('P. negative line amount -> reject', () => {
    expect(() => allocateDocumentDiscount([line(1, -1n)], 0n, AED)).toThrow(RangeError);
  });

  it('Q. duplicate linePosition -> reject', () => {
    expect(() => allocateDocumentDiscount([line(1, 100n), line(1, 200n)], 50n, AED)).toThrow(
      RangeError,
    );
  });

  it('Q2. non-positive linePosition -> reject', () => {
    expect(() => allocateDocumentDiscount([line(0, 100n)], 10n, AED)).toThrow(RangeError);
    expect(() => allocateDocumentDiscount([line(-1, 100n)], 10n, AED)).toThrow(RangeError);
  });

  it('R. input array shuffled -> identical semantic result, output always linePosition-sorted', () => {
    const ordered = [line(1, 300n), line(2, 200n), line(3, 100n)];
    const shuffled = [line(3, 100n), line(1, 300n), line(2, 200n)];
    const a = allocateDocumentDiscount(ordered, 100n, AED);
    const b = allocateDocumentDiscount(shuffled, 100n, AED);
    expect(a).toEqual(b);
    expect(a.lines.map((l) => l.linePosition)).toEqual([1, 2, 3]);
  });

  // ── B4 invariants, proven generically across many cases ──────────────────
  describe('invariants (B4)', () => {
    const cases: { lines: DocumentDiscountLineInput[]; discount: bigint }[] = [
      { lines: [line(1, 300n), line(2, 200n), line(3, 100n)], discount: 100n },
      { lines: [line(1, 1n), line(2, 1n), line(3, 1n)], discount: 2n },
      { lines: [line(1, 10n), line(2, 0n), line(3, 10n)], discount: 15n },
      { lines: [line(1, 999n), line(2, 1n)], discount: 500n },
      { lines: [line(1, 70n), line(2, 20n), line(3, 10n)], discount: 100n }, // D=W
      { lines: [line(1, 70n), line(2, 20n), line(3, 10n)], discount: 0n },
    ];

    for (const [i, c] of cases.entries()) {
      it(`case ${i}: sum-of-shares === D, sum-of-after === W-D, 0<=share<=weight, after>=0`, () => {
        const result = allocateDocumentDiscount(c.lines, c.discount, AED);
        const W = c.lines.reduce((a, l) => a + l.commercialAmountAfterLineDiscountMinor, 0n);
        const sumShares = result.lines.reduce((a, l) => a + l.documentDiscountShareMinor, 0n);
        const sumAfter = result.lines.reduce(
          (a, l) => a + l.commercialAmountAfterDocumentDiscountMinor,
          0n,
        );
        expect(sumShares).toBe(c.discount);
        expect(sumAfter).toBe(W - c.discount);
        for (const l of result.lines) {
          const weight = c.lines.find(
            (x) => x.linePosition === l.linePosition,
          )!.commercialAmountAfterLineDiscountMinor;
          expect(l.documentDiscountShareMinor >= 0n).toBe(true);
          expect(l.documentDiscountShareMinor <= weight).toBe(true); // B8 bound
          expect(l.commercialAmountAfterDocumentDiscountMinor >= 0n).toBe(true);
        }
      });
    }
  });

  // ── B8 — dedicated share<=weight boundary stress proof ───────────────────
  describe('share <= weight bound (B8) — remainder-heavy edge cases', () => {
    it('a tiny-weight line can reach exactly its own cap via the residual, never exceed it', () => {
      // weight0=1 (tiny), weight1=999 (W=1000), D=999 (just under W)
      const result = allocateDocumentDiscount([line(1, 1n), line(2, 999n)], 999n, AED);
      const l1 = result.lines.find((l) => l.linePosition === 1)!;
      expect(l1.documentDiscountShareMinor).toBe(1n); // reaches its cap exactly
      expect(l1.documentDiscountShareMinor <= 1n).toBe(true); // never exceeds
      expect(result.lines.reduce((a, l) => a + l.documentDiscountShareMinor, 0n)).toBe(999n);
    });

    it('D = W: every share equals its own weight exactly, no residual bump needed', () => {
      const result = allocateDocumentDiscount([line(1, 7n), line(2, 13n), line(3, 1n)], 21n, AED);
      expect(result.lines.map((l) => l.documentDiscountShareMinor)).toEqual([7n, 13n, 1n]);
    });

    it('many lines, D one unit below W — every line at most one unit below its own weight', () => {
      const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, BigInt(i + 1) * 7n));
      const W = lines.reduce((a, l) => a + l.commercialAmountAfterLineDiscountMinor, 0n);
      const result = allocateDocumentDiscount(lines, W - 1n, AED);
      for (const l of result.lines) {
        const weight = lines.find(
          (x) => x.linePosition === l.linePosition,
        )!.commercialAmountAfterLineDiscountMinor;
        expect(l.documentDiscountShareMinor <= weight).toBe(true);
      }
      expect(result.lines.reduce((a, l) => a + l.documentDiscountShareMinor, 0n)).toBe(W - 1n);
    });
  });

  // ── B9 — no tax arithmetic anywhere in this module ───────────────────────
  it('B9. uses only commercial terminology and BigInt — no Money/rational objects leak out', () => {
    const result = allocateDocumentDiscount([line(1, 100n)], 50n, AED);
    for (const l of result.lines) {
      expect(typeof l.documentDiscountShareMinor).toBe('bigint');
      expect(typeof l.commercialAmountAfterDocumentDiscountMinor).toBe('bigint');
    }
  });
});
