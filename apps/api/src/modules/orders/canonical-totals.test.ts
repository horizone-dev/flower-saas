import { describe, expect, it } from 'vitest';
import { Money, type RoundingMode } from '@flower/money';
import { Quantity } from '@flower/uom';
import {
  computeCanonicalTotals,
  toOrderTotalsPreview,
  type CanonicalTotalsLineInput,
  type CanonicalTotalsOrderInput,
  type CanonicalTotalsResult,
} from './canonical-totals.js';
import { allocateDocumentDiscount } from './document-discount-allocation.js';
import { exactLineTax, roundExact, reconcileDocumentTax } from './tax-arithmetic.js';

/**
 * Task 3b.9 Checkpoint A (A1) — the canonical totals computation.
 *
 * Proves, three ways, that extracting steps 3–9 of
 * `TaxFinalizationService.finalizeAndIssueInvoice` into `computeCanonicalTotals`
 * changed no amount:
 *   1. hand-computed GOLDEN cases (inclusive/exclusive, zero tax, line +
 *      document discount, percentage + fixed discount, exact rounding in every
 *      mode, 2- and 3-decimal currencies, fractional UOM quantities);
 *   2. a DIFFERENTIAL test against `legacyReference` below — a verbatim copy of
 *      the pre-extraction algorithm (commit 9e00528, `tax-finalization.service.ts`
 *      lines 114–208), run over a seeded matrix of ~1,200 orders; and
 *   3. the properties a preview needs (determinism, input-order independence,
 *      no input mutation, bounded string-only wire shape).
 * The database-level proof (a persisted invoice carries exactly these numbers)
 * is the existing `tax-finalization.service.integration.test.ts`, which runs
 * unchanged against the refactored service.
 */

// ── the FROZEN pre-extraction reference (do not "improve" — it is the oracle) ──
function legacyReference(
  order: CanonicalTotalsOrderInput,
  lineRows: readonly CanonicalTotalsLineInput[], // already ORDER BY linePosition ASC, as the DB query returned them
): CanonicalTotalsResult {
  const afterLineDiscount = lineRows.map((l) => {
    const gross = Money.ofMinor(l.unitPriceAmountMinor, l.unitPriceCurrencyCode).mulRatio(
      Quantity.parse(l.quantity).scaled,
      10_000n,
    );
    return {
      id: l.id,
      linePosition: l.linePosition,
      rateBps: l.rateBps,
      amountMinor: gross.subtract(Money.ofMinor(l.discountAmountMinor, l.unitPriceCurrencyCode))
        .amountMinor,
    };
  });
  const allocation = allocateDocumentDiscount(
    afterLineDiscount.map((l) => ({
      linePosition: l.linePosition,
      commercialAmountAfterLineDiscountMinor: l.amountMinor,
    })),
    order.documentDiscountAmountMinor,
    order.currencyCode,
  );
  const afterDocumentDiscountByPosition = new Map(
    allocation.lines.map((l) => [l.linePosition, l.commercialAmountAfterDocumentDiscountMinor]),
  );
  const priceTaxMode = order.taxPriceMode as 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
  const roundingMode = order.taxRoundingMode as RoundingMode;
  const ratedLines = afterLineDiscount.filter((l) => l.rateBps !== null);
  const lineTaxByPosition = new Map<number, bigint>();
  for (const l of afterLineDiscount) {
    if (l.rateBps === null) lineTaxByPosition.set(l.linePosition, 0n);
  }
  if (order.taxRoundingScope === 'LINE') {
    for (const l of ratedLines) {
      const amount = afterDocumentDiscountByPosition.get(l.linePosition)!;
      const rational = exactLineTax(amount, l.rateBps!, priceTaxMode);
      lineTaxByPosition.set(l.linePosition, roundExact(rational, roundingMode));
    }
  } else {
    const documentInputs = ratedLines.map((l) => ({
      linePosition: l.linePosition,
      rational: exactLineTax(
        afterDocumentDiscountByPosition.get(l.linePosition)!,
        l.rateBps!,
        priceTaxMode,
      ),
    }));
    const reconciled = reconcileDocumentTax(documentInputs, roundingMode);
    for (const r of reconciled.lines) {
      lineTaxByPosition.set(r.linePosition, r.lineTaxAmountMinor);
    }
  }
  const finalizedLines = afterLineDiscount.map((l) => ({
    orderLineId: l.id,
    priceTaxMode: order.taxPriceMode,
    roundingScope: order.taxRoundingScope,
    roundingMode: order.taxRoundingMode,
    lineTaxAmountMinor: lineTaxByPosition.get(l.linePosition)!,
  }));
  const subtotalAmountMinor = afterLineDiscount.reduce((acc, l) => acc + l.amountMinor, 0n);
  const taxTotalAmountMinor = finalizedLines.reduce((acc, l) => acc + l.lineTaxAmountMinor, 0n);
  const totalAmountMinor =
    priceTaxMode === 'TAX_EXCLUSIVE'
      ? subtotalAmountMinor - order.documentDiscountAmountMinor + taxTotalAmountMinor
      : subtotalAmountMinor - order.documentDiscountAmountMinor;
  return {
    lines: finalizedLines,
    totals: {
      subtotalAmountMinor,
      documentDiscountAmountMinor: order.documentDiscountAmountMinor,
      taxTotalAmountMinor,
      totalAmountMinor,
      currencyCode: order.currencyCode,
      currencyExponent: order.currencyExponent,
    },
  };
}

// ── builders ────────────────────────────────────────────────────────────────
const policy = (over: Partial<CanonicalTotalsOrderInput> = {}): CanonicalTotalsOrderInput => ({
  currencyCode: 'AED',
  currencyExponent: 2,
  documentDiscountAmountMinor: 0n,
  taxPriceMode: 'TAX_EXCLUSIVE',
  taxRoundingScope: 'LINE',
  taxRoundingMode: 'HALF_UP',
  ...over,
});
let seq = 0;
const line = (
  position: number,
  over: Partial<CanonicalTotalsLineInput> = {},
): CanonicalTotalsLineInput => ({
  id: `line-${++seq}`,
  linePosition: position,
  quantity: '1.0000',
  unitPriceAmountMinor: 1000n,
  unitPriceCurrencyCode: 'AED',
  discountAmountMinor: 0n,
  rateBps: 500,
  ...over,
});
const taxes = (r: CanonicalTotalsResult): bigint[] => r.lines.map((l) => l.lineTaxAmountMinor);

describe('computeCanonicalTotals — hand-computed golden cases', () => {
  it('TAX_EXCLUSIVE 5%: 2 x 12.50 = 25.00, tax 1.25, total 26.25', () => {
    const r = computeCanonicalTotals(policy(), [
      line(1, { quantity: '2.0000', unitPriceAmountMinor: 1250n }),
    ]);
    expect(r.totals).toEqual({
      subtotalAmountMinor: 2500n,
      documentDiscountAmountMinor: 0n,
      taxTotalAmountMinor: 125n,
      totalAmountMinor: 2625n,
      currencyCode: 'AED',
      currencyExponent: 2,
    });
    expect(taxes(r)).toEqual([125n]);
  });

  it('TAX_INCLUSIVE 5%: 10.50 contains 0.50 of tax and the total is the tax-inclusive amount (never double-counted)', () => {
    const r = computeCanonicalTotals(policy({ taxPriceMode: 'TAX_INCLUSIVE' }), [
      line(1, { unitPriceAmountMinor: 1050n }),
    ]);
    expect(r.totals.subtotalAmountMinor).toBe(1050n);
    expect(r.totals.taxTotalAmountMinor).toBe(50n);
    expect(r.totals.totalAmountMinor).toBe(1050n);
  });

  it('TAX_INCLUSIVE extraction rounds the exact rational: 10.00 @5% -> 47.619.. -> 48', () => {
    const r = computeCanonicalTotals(policy({ taxPriceMode: 'TAX_INCLUSIVE' }), [
      line(1, { unitPriceAmountMinor: 1000n }),
    ]);
    expect(r.totals.taxTotalAmountMinor).toBe(48n);
    expect(r.totals.totalAmountMinor).toBe(1000n);
  });

  it('zero tax: a line with no resolved rate (null) carries exactly 0 tax, in both modes', () => {
    for (const taxPriceMode of ['TAX_EXCLUSIVE', 'TAX_INCLUSIVE']) {
      const r = computeCanonicalTotals(policy({ taxPriceMode }), [
        line(1, { unitPriceAmountMinor: 777n, rateBps: null }),
      ]);
      expect(r.totals.taxTotalAmountMinor).toBe(0n);
      expect(r.totals.totalAmountMinor).toBe(777n);
    }
  });

  it('zero tax: a RESOLVED zero rate (0 bps) is indistinguishable in result from no rate', () => {
    const r = computeCanonicalTotals(policy(), [
      line(1, { unitPriceAmountMinor: 777n, rateBps: 0 }),
    ]);
    expect(r.totals.taxTotalAmountMinor).toBe(0n);
    expect(r.totals.totalAmountMinor).toBe(777n);
  });

  it('line discount + document discount, EXCLUSIVE 5% LINE HALF_UP (exact proportional allocation)', () => {
    // L1: 3 x 10.00 = 30.00 - 3.00 (10%) = 27.00 ; L2: 1 x 20.00 ; subtotal 47.00
    // document discount 4.70 (10%): L1 2.70, L2 2.00 -> 24.30 / 18.00
    // tax: 24.30 x 5% = 1.215 -> 1.22 ; 18.00 x 5% = 0.90 ; total tax 2.12
    const r = computeCanonicalTotals(policy({ documentDiscountAmountMinor: 470n }), [
      line(1, { quantity: '3.0000', unitPriceAmountMinor: 1000n, discountAmountMinor: 300n }),
      line(2, { unitPriceAmountMinor: 2000n }),
    ]);
    expect(r.totals.subtotalAmountMinor).toBe(4700n);
    expect(taxes(r)).toEqual([122n, 90n]);
    expect(r.totals.taxTotalAmountMinor).toBe(212n);
    expect(r.totals.totalAmountMinor).toBe(4700n - 470n + 212n);
  });

  it('the same order under DOCUMENT rounding reconciles to one rounded document tax (exact 2.115 -> 2.12)', () => {
    const r = computeCanonicalTotals(
      policy({ documentDiscountAmountMinor: 470n, taxRoundingScope: 'DOCUMENT' }),
      [
        line(1, { quantity: '3.0000', unitPriceAmountMinor: 1000n, discountAmountMinor: 300n }),
        line(2, { unitPriceAmountMinor: 2000n }),
      ],
    );
    expect(r.totals.taxTotalAmountMinor).toBe(212n);
    expect(r.totals.totalAmountMinor).toBe(4442n);
    expect(taxes(r).reduce((a, b) => a + b, 0n)).toBe(212n);
  });

  it('percentage and fixed line discounts, then a document discount (EXCLUSIVE and INCLUSIVE)', () => {
    // L1 30.00 less 15% (4.50) = 25.50 ; L2 15.00 less fixed 2.50 = 12.50 ; subtotal 38.00
    // document discount 3.80 (10%): L1 2.55, L2 1.25 -> 22.95 / 11.25
    const lines = [
      line(1, { quantity: '3.0000', unitPriceAmountMinor: 1000n, discountAmountMinor: 450n }),
      line(2, { quantity: '1.0000', unitPriceAmountMinor: 1500n, discountAmountMinor: 250n }),
    ];
    const excl = computeCanonicalTotals(policy({ documentDiscountAmountMinor: 380n }), lines);
    expect(excl.totals.subtotalAmountMinor).toBe(3800n);
    expect(taxes(excl)).toEqual([115n, 56n]); // 1.1475 -> 1.15 ; 0.5625 -> 0.56
    expect(excl.totals.totalAmountMinor).toBe(3800n - 380n + 171n);

    const incl = computeCanonicalTotals(
      policy({ documentDiscountAmountMinor: 380n, taxPriceMode: 'TAX_INCLUSIVE' }),
      lines,
    );
    expect(taxes(incl)).toEqual([109n, 54n]); // 22.95 x 5/105 = 1.0929 ; 11.25 x 5/105 = 0.5357
    expect(incl.totals.totalAmountMinor).toBe(3800n - 380n);
  });

  it('exact rounding on a half-way tax (KWD, 3 decimals): 187.5 fils in every rounding mode', () => {
    // 3 x 1.250 KWD = 3.750 KWD ; 5% = 187.5 fils exactly
    const expected: Record<RoundingMode, bigint> = {
      HALF_UP: 188n,
      HALF_EVEN: 188n, // 187 is odd -> rounds to the even neighbour 188
      HALF_DOWN: 187n,
      DOWN: 187n,
      UP: 188n,
    };
    for (const [mode, tax] of Object.entries(expected)) {
      const r = computeCanonicalTotals(
        policy({ currencyCode: 'KWD', currencyExponent: 3, taxRoundingMode: mode }),
        [
          line(1, {
            quantity: '3.0000',
            unitPriceAmountMinor: 1250n,
            unitPriceCurrencyCode: 'KWD',
          }),
        ],
      );
      expect(r.totals.taxTotalAmountMinor, mode).toBe(tax);
      expect(r.totals.totalAmountMinor, mode).toBe(3750n + tax);
      expect(r.totals.currencyExponent).toBe(3);
    }
  });

  it('a half-way tax whose floor is EVEN rounds down under HALF_EVEN (186.5 -> 186) but up under HALF_UP', () => {
    // 3 x 1.246 KWD = 3.738 ; 5% = 186.9 -> not half-way; use unit 1243: 3729 x 5% = 186.45.. avoid:
    // choose gross 3730 fils: 3730 x 500 / 10000 = 186.5
    const base = (mode: string) =>
      computeCanonicalTotals(
        policy({ currencyCode: 'KWD', currencyExponent: 3, taxRoundingMode: mode }),
        [line(1, { unitPriceAmountMinor: 3730n, unitPriceCurrencyCode: 'KWD' })],
      ).totals.taxTotalAmountMinor;
    expect(base('HALF_EVEN')).toBe(186n);
    expect(base('HALF_UP')).toBe(187n);
  });

  it('fractional UOM quantities are priced exactly then rounded HALF_UP once: 0.3333 x 30.00 = 9.999 -> 10.00', () => {
    const r = computeCanonicalTotals(policy(), [
      line(1, { quantity: '0.3333', unitPriceAmountMinor: 3000n, rateBps: null }),
      line(2, { quantity: '0.2500', unitPriceAmountMinor: 1999n, rateBps: null }),
    ]);
    expect(r.totals.subtotalAmountMinor).toBe(1000n + 500n); // 999.9 -> 1000 ; 499.75 -> 500
  });

  it('multiple lines keep one finalized snapshot each, carrying the order own policy verbatim', () => {
    const p = policy({ taxRoundingScope: 'DOCUMENT', taxRoundingMode: 'HALF_EVEN' });
    const r = computeCanonicalTotals(p, [line(1), line(2), line(3)]);
    expect(r.lines).toHaveLength(3);
    for (const l of r.lines) {
      expect(l.priceTaxMode).toBe('TAX_EXCLUSIVE');
      expect(l.roundingScope).toBe('DOCUMENT');
      expect(l.roundingMode).toBe('HALF_EVEN');
    }
  });
});

// ── the differential matrix ─────────────────────────────────────────────────
/** a tiny deterministic PRNG (mulberry32) — the matrix is reproducible */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CURRENCIES: [string, number][] = [
  ['AED', 2],
  ['SAR', 2],
  ['KWD', 3],
  ['BHD', 3],
  ['OMR', 3],
];
const MODES: string[] = ['TAX_EXCLUSIVE', 'TAX_INCLUSIVE'];
const SCOPES = ['LINE', 'DOCUMENT'];
const ROUNDINGS: RoundingMode[] = ['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'DOWN', 'UP'];
const RATES: (number | null)[] = [null, 0, 100, 500, 1500, 2000, 2500, 10_000];

function randomCase(rand: () => number): {
  order: CanonicalTotalsOrderInput;
  lines: CanonicalTotalsLineInput[];
} {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const [currencyCode, currencyExponent] = pick(CURRENCIES);
  const lineCount = 1 + Math.floor(rand() * 6);
  const lines: CanonicalTotalsLineInput[] = [];
  let subtotal = 0n;
  for (let i = 1; i <= lineCount; i += 1) {
    const qtyScaled = 1 + Math.floor(rand() * 500_000); // 0.0001 .. 50.0000
    const quantity = `${Math.floor(qtyScaled / 10_000)}.${String(qtyScaled % 10_000).padStart(4, '0')}`;
    const unit = BigInt(1 + Math.floor(rand() * 500_000));
    const gross = Money.ofMinor(unit, currencyCode).mulRatio(
      BigInt(qtyScaled),
      10_000n,
    ).amountMinor;
    const discount = BigInt(Math.floor(rand() * Number(gross) * (rand() < 0.5 ? 0 : 1)));
    subtotal += gross - discount;
    lines.push({
      id: `m-${i}`,
      linePosition: i,
      quantity,
      unitPriceAmountMinor: unit,
      unitPriceCurrencyCode: currencyCode,
      discountAmountMinor: discount,
      rateBps: pick(RATES),
    });
  }
  const docDiscount = rand() < 0.5 ? 0n : BigInt(Math.floor(rand() * Number(subtotal)));
  return {
    order: {
      currencyCode,
      currencyExponent,
      documentDiscountAmountMinor: docDiscount,
      taxPriceMode: pick(MODES),
      taxRoundingScope: pick(SCOPES),
      taxRoundingMode: pick(ROUNDINGS),
    },
    lines,
  };
}

function outcome<T>(fn: () => T): { ok: T } | { err: string } {
  try {
    return { ok: fn() };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

describe('computeCanonicalTotals — differential equivalence with the pre-extraction algorithm', () => {
  it('is identical to the frozen reference over a seeded matrix of 1,200 orders (every mode x scope x rounding x currency)', () => {
    const rand = prng(0x3b09a);
    const seen = { exclusive: 0, inclusive: 0, line: 0, document: 0, kwd: 0, discounted: 0 };
    for (let n = 0; n < 1200; n += 1) {
      const { order, lines } = randomCase(rand);
      const expected = outcome(() => legacyReference(order, lines));
      const actual = outcome(() => computeCanonicalTotals(order, lines));
      expect(actual, `case ${n}`).toEqual(expected);
      if ('ok' in actual) {
        if (order.taxPriceMode === 'TAX_EXCLUSIVE') seen.exclusive += 1;
        else seen.inclusive += 1;
        if (order.taxRoundingScope === 'LINE') seen.line += 1;
        else seen.document += 1;
        if (order.currencyExponent === 3) seen.kwd += 1;
        if (order.documentDiscountAmountMinor > 0n) seen.discounted += 1;
      }
    }
    // the matrix genuinely exercised each dimension (no vacuous pass)
    expect(seen.exclusive).toBeGreaterThan(300);
    expect(seen.inclusive).toBeGreaterThan(300);
    expect(seen.line).toBeGreaterThan(300);
    expect(seen.document).toBeGreaterThan(300);
    expect(seen.kwd).toBeGreaterThan(300);
    expect(seen.discounted).toBeGreaterThan(300);
  });

  it('reproduces the reference when the reference itself rejects (same error, same message)', () => {
    const order = policy({ documentDiscountAmountMinor: 10_000n }); // more than the subtotal
    const lines = [line(1)];
    const expected = outcome(() => legacyReference(order, lines));
    expect('err' in expected).toBe(true);
    expect(outcome(() => computeCanonicalTotals(order, lines))).toEqual(expected);
  });

  it('is independent of the caller input order (shuffled == the reference over position-sorted rows)', () => {
    const rand = prng(77);
    for (let n = 0; n < 200; n += 1) {
      const { order, lines } = randomCase(rand);
      const shuffled = [...lines].reverse();
      expect(outcome(() => computeCanonicalTotals(order, shuffled))).toEqual(
        outcome(() => legacyReference(order, lines)),
      );
    }
  });
});

describe('computeCanonicalTotals — preview properties', () => {
  const order = policy({ documentDiscountAmountMinor: 100n });
  const lines = [
    line(1, { quantity: '2.5000', unitPriceAmountMinor: 4321n }),
    line(2, { unitPriceAmountMinor: 999n, rateBps: null }),
  ];

  it('is deterministic: repeated computation yields the identical result', () => {
    const first = computeCanonicalTotals(order, lines);
    for (let i = 0; i < 20; i += 1) expect(computeCanonicalTotals(order, lines)).toEqual(first);
  });

  it('never mutates its inputs (a preview must have no side effect on what it reads)', () => {
    const o = structuredClone(order);
    const l = structuredClone(lines);
    computeCanonicalTotals(o, l);
    expect(o).toEqual(order);
    expect(l).toEqual(lines);
  });

  it('rejects a duplicate linePosition instead of silently merging two lines', () => {
    // pin THIS function's own guard — allocateDocumentDiscount rejects a duplicate too, but with a
    // different message and only after commercial reconstruction
    expect(() => computeCanonicalTotals(order, [line(1), line(1)])).toThrow(
      'computeCanonicalTotals: duplicate linePosition 1',
    );
  });

  it('the line taxes always sum to the document tax total, and totals follow the mode formula', () => {
    const rand = prng(5);
    for (let n = 0; n < 300; n += 1) {
      const c = randomCase(rand);
      const r = outcome(() => computeCanonicalTotals(c.order, c.lines));
      if ('err' in r) continue;
      const t = r.ok.totals;
      expect(t.taxTotalAmountMinor).toBe(r.ok.lines.reduce((a, l) => a + l.lineTaxAmountMinor, 0n));
      expect(t.totalAmountMinor).toBe(
        c.order.taxPriceMode === 'TAX_EXCLUSIVE'
          ? t.subtotalAmountMinor - t.documentDiscountAmountMinor + t.taxTotalAmountMinor
          : t.subtotalAmountMinor - t.documentDiscountAmountMinor,
      );
    }
  });
});

describe('toOrderTotalsPreview — the bounded wire shape (OD-4)', () => {
  const o = {
    id: '00000000-0000-7000-8000-000000000001',
    version: 7,
    taxPriceMode: 'TAX_INCLUSIVE',
  };
  const result = computeCanonicalTotals(policy({ taxPriceMode: 'TAX_INCLUSIVE' }), [
    line(1, { unitPriceAmountMinor: 1050n }),
  ]);

  it('carries the order id + version, the currency and EXACT money as decimal-digit strings', () => {
    expect(toOrderTotalsPreview(o, result)).toEqual({
      orderId: o.id,
      version: 7,
      currencyCode: 'AED',
      currencyExponent: 2,
      priceTaxMode: 'TAX_INCLUSIVE',
      subtotalAmountMinor: '1050',
      documentDiscountAmountMinor: '0',
      taxTotalAmountMinor: '50',
      totalAmountMinor: '1050',
    });
  });

  it('is JSON-serialisable (no BigInt) and exposes no other field — no fingerprint, scope id or per-line data', () => {
    const preview = toOrderTotalsPreview(o, result);
    expect(() => JSON.stringify(preview)).not.toThrow();
    expect(Object.keys(preview).sort()).toEqual([
      'currencyCode',
      'currencyExponent',
      'documentDiscountAmountMinor',
      'orderId',
      'priceTaxMode',
      'subtotalAmountMinor',
      'taxTotalAmountMinor',
      'totalAmountMinor',
      'version',
    ]);
    for (const k of [
      'subtotalAmountMinor',
      'documentDiscountAmountMinor',
      'taxTotalAmountMinor',
      'totalAmountMinor',
    ] as const) {
      expect(preview[k]).toMatch(/^-?\d+$/);
    }
  });

  it('every money field carries ITS OWN value (subtotal, discount, tax and total all differ here)', () => {
    // subtotal 10.00, document discount 1.00 -> 9.00 taxed at 5% = 0.45 -> total 9.45
    const r = computeCanonicalTotals(policy({ documentDiscountAmountMinor: 100n }), [
      line(1, { unitPriceAmountMinor: 1000n }),
    ]);
    const preview = toOrderTotalsPreview(
      { id: 'o1', version: 3, taxPriceMode: 'TAX_EXCLUSIVE' },
      r,
    );
    expect(preview.subtotalAmountMinor).toBe('1000');
    expect(preview.documentDiscountAmountMinor).toBe('100');
    expect(preview.taxTotalAmountMinor).toBe('45');
    expect(preview.totalAmountMinor).toBe('945');
  });

  it('large amounts keep every digit (a JS number would round them)', () => {
    const big = computeCanonicalTotals(policy(), [
      line(1, { unitPriceAmountMinor: 900_719_925_474_099n, rateBps: null }),
    ]);
    expect(toOrderTotalsPreview(o, big).totalAmountMinor).toBe('900719925474099');
  });
});
