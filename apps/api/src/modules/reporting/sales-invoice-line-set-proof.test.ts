import { describe, expect, it } from 'vitest';
import {
  computeCommercialSnapshotFingerprintV1,
  computeCommercialSnapshotFingerprintV2,
  type CommercialSnapshotInput,
  type CommercialSnapshotLine,
} from '../orders/commercial-snapshot.js';
import {
  lineDiscountCrossCheckFailures,
  verifyInvoiceLineSets,
  type InvoiceLineSetFacts,
  type InvoiceOrderFacts,
} from './sales-invoice-line-set-proof.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const BRANCH_A = '33333333-3333-4333-8333-333333333333';
const BRANCH_B = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const VARIANT = '66666666-6666-4666-8666-666666666666';
const POLICY = {
  taxPriceMode: 'TAX_EXCLUSIVE',
  taxRoundingScope: 'LINE',
  taxRoundingMode: 'HALF_UP',
} as const;

function snapLine(over: Partial<CommercialSnapshotLine> = {}): CommercialSnapshotLine {
  return {
    productId: PRODUCT,
    variantId: VARIANT,
    quantity: '1.0000',
    selectedUomCode: 'piece',
    baseUomCode: 'piece',
    conversionNumerator: '1',
    conversionDenominator: '1',
    unitPriceAmountMinor: '10000',
    unitPriceCurrencyCode: 'AED',
    unitPriceCurrencyExponent: 2,
    discountMode: 'NONE',
    discountBps: null,
    discountAmountMinor: '0',
    taxCategoryKey: 'STANDARD',
    rateBps: 500,
    effectiveFrom: '2020-01-01',
    resolutionSource: 'VARIANT',
    ...over,
  };
}

/** a line → the positional tuple the statement returns (position first, then the 17 bound columns) */
function tuple(position: number, l: CommercialSnapshotLine): readonly unknown[] {
  return [
    position,
    l.productId,
    l.variantId,
    l.quantity,
    l.selectedUomCode,
    l.baseUomCode,
    l.conversionNumerator,
    l.conversionDenominator,
    l.unitPriceAmountMinor,
    l.unitPriceCurrencyCode,
    l.unitPriceCurrencyExponent,
    l.discountMode,
    l.discountBps,
    l.discountAmountMinor,
    l.taxCategoryKey,
    l.rateBps,
    l.effectiveFrom,
    l.resolutionSource,
  ];
}

function orderInput(lines: readonly CommercialSnapshotLine[]): CommercialSnapshotInput {
  return {
    tenantId: TENANT,
    companyId: COMPANY,
    originBranchId: BRANCH_A,
    fulfillingBranchId: BRANCH_A,
    customerId: null,
    kind: 'WALK_IN',
    currencyCode: 'AED',
    lines,
    documentDiscountMode: 'NONE',
    documentDiscountBps: null,
    documentDiscountAmountMinor: '0',
    documentDiscountReason: null,
  };
}

/** a consistent invoice: the stored fingerprint is the REAL one over the finalized lines */
function invoice(
  lines: readonly CommercialSnapshotLine[],
  opts: { id?: string; branchId?: string; version?: 1 | 2 } = {},
): InvoiceLineSetFacts {
  const version = opts.version ?? 2;
  const input = orderInput(lines);
  const fingerprint =
    version === 2
      ? computeCommercialSnapshotFingerprintV2(input, POLICY)
      : computeCommercialSnapshotFingerprintV1(input);
  const order: InvoiceOrderFacts = {
    tenantId: input.tenantId,
    companyId: input.companyId,
    originBranchId: input.originBranchId,
    fulfillingBranchId: input.fulfillingBranchId,
    customerId: input.customerId,
    kind: input.kind,
    currencyCode: input.currencyCode,
    documentDiscountMode: input.documentDiscountMode,
    documentDiscountBps: input.documentDiscountBps,
    documentDiscountAmountMinor: input.documentDiscountAmountMinor,
    documentDiscountReason: input.documentDiscountReason,
    ...POLICY,
    commercialSnapshotFingerprint: fingerprint,
    commercialSnapshotFingerprintVersion: version,
  };
  return {
    invoiceId: opts.id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    branchId: opts.branchId ?? BRANCH_A,
    order,
    lines: lines.map((l, i) => tuple(i + 1, l)),
  };
}

const discounted = snapLine({
  discountMode: 'AMOUNT',
  discountAmountMinor: '1000',
});

describe('the line-discount authority — the order snapshot fingerprint proves the line set (owner correction 1)', () => {
  it('a consistent invoice verifies and yields its stored line discount, per branch', () => {
    const proof = verifyInvoiceLineSets([
      invoice([discounted, snapLine({ discountMode: 'AMOUNT', discountAmountMinor: '250' })]),
      invoice([discounted], { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ]);
    expect(proof.mismatches).toBe(0);
    expect(proof.lineDiscountByBranch.get(BRANCH_A)).toBe(2_250n);
    expect(proof.verifiedInvoicesByBranch.get(BRANCH_A)).toBe(2);
  });

  it('a version-1 order (the frozen pre-3b.4 shape) verifies through the same shared dispatcher', () => {
    const proof = verifyInvoiceLineSets([invoice([discounted], { version: 1 })]);
    expect(proof.mismatches).toBe(0);
    expect(proof.lineDiscountByBranch.get(BRANCH_A)).toBe(1_000n);
  });

  it('an EXTRA line is detected — with a non-zero discount', () => {
    const f = invoice([discounted]);
    const tampered = {
      ...f,
      lines: [
        ...f.lines,
        tuple(2, snapLine({ discountMode: 'AMOUNT', discountAmountMinor: '500' })),
      ],
    };
    const proof = verifyInvoiceLineSets([tampered]);
    expect(proof.mismatches).toBe(1);
    expect(proof.lineDiscountByBranch.size).toBe(0);
  });

  it('an EXTRA line whose NET amount is zero but whose discount is not is detected (a sum-of-net check would pass it)', () => {
    const f = invoice([discounted]);
    const zeroNet = snapLine({
      unitPriceAmountMinor: '800',
      discountMode: 'AMOUNT',
      discountAmountMinor: '800',
    });
    expect(
      verifyInvoiceLineSets([{ ...f, lines: [...f.lines, tuple(2, zeroNet)] }]).mismatches,
    ).toBe(1);
  });

  it('an EXTRA zero-value line is detected', () => {
    const f = invoice([discounted]);
    const zero = snapLine({ unitPriceAmountMinor: '0' });
    expect(verifyInvoiceLineSets([{ ...f, lines: [...f.lines, tuple(2, zero)] }]).mismatches).toBe(
      1,
    );
  });

  it('a DELETED line, an empty line set and a REORDERED set are detected', () => {
    const two = invoice([discounted, snapLine({ unitPriceAmountMinor: '4000' })]);
    expect(verifyInvoiceLineSets([{ ...two, lines: [two.lines[0]!] }]).mismatches).toBe(1);
    expect(verifyInvoiceLineSets([{ ...two, lines: [] }]).mismatches).toBe(1);
    expect(
      verifyInvoiceLineSets([{ ...two, lines: [two.lines[1]!, two.lines[0]!] }]).mismatches,
    ).toBe(1);
  });

  it('a CHANGED discount, quantity, price, UOM, tax reference or document discount is detected', () => {
    const f = invoice([discounted]);
    const edit = (index: number, value: unknown): InvoiceLineSetFacts => {
      const line = [...f.lines[0]!];
      line[index] = value;
      return { ...f, lines: [line] };
    };
    for (const [index, value] of [
      [13, '999'], // discountAmountMinor
      [12, 1000], // discountBps
      [11, 'PERCENT_BPS'], // discountMode
      [3, '2.0000'], // quantity
      [8, '10001'], // unit price
      [4, 'kg'], // selected UOM
      [6, '2'], // conversion numerator
      [14, 'ZERO'], // tax category
      [15, 0], // rate
      [16, '2021-01-01'], // effective-from
      [1, '77777777-7777-4777-8777-777777777777'], // product
    ] as const) {
      expect(verifyInvoiceLineSets([edit(index, value)]).mismatches, `column ${index}`).toBe(1);
    }
    const doc = { ...f, order: { ...f.order!, documentDiscountAmountMinor: '1' } };
    expect(verifyInvoiceLineSets([doc]).mismatches).toBe(1);
  });

  it('a discount moved between two lines (the sum is unchanged) is detected — a SUM check would pass it', () => {
    const a = snapLine({ discountMode: 'AMOUNT', discountAmountMinor: '600' });
    const b = snapLine({ discountMode: 'AMOUNT', discountAmountMinor: '400' });
    const f = invoice([a, b]);
    const swapped = [
      tuple(1, snapLine({ discountMode: 'AMOUNT', discountAmountMinor: '400' })),
      tuple(2, snapLine({ discountMode: 'AMOUNT', discountAmountMinor: '600' })),
    ];
    expect(verifyInvoiceLineSets([{ ...f, lines: swapped }]).mismatches).toBe(1);
  });

  it('a price and a discount raised by the same amount (net and invoice total unchanged) is detected', () => {
    const f = invoice([discounted]);
    const crafted = snapLine({
      unitPriceAmountMinor: '10100',
      discountMode: 'AMOUNT',
      discountAmountMinor: '1100',
    });
    expect(verifyInvoiceLineSets([{ ...f, lines: [tuple(1, crafted)] }]).mismatches).toBe(1);
  });

  it('a changed stored fingerprint, an unknown fingerprint version, a missing order and a foreign branch all fail', () => {
    const f = invoice([discounted]);
    expect(
      verifyInvoiceLineSets([
        { ...f, order: { ...f.order!, commercialSnapshotFingerprint: 'f'.repeat(64) } },
      ]).mismatches,
    ).toBe(1);
    expect(
      verifyInvoiceLineSets([
        { ...f, order: { ...f.order!, commercialSnapshotFingerprintVersion: 3 } },
      ]).mismatches,
    ).toBe(1);
    expect(verifyInvoiceLineSets([{ ...f, order: null }]).mismatches).toBe(1);
    expect(verifyInvoiceLineSets([{ ...f, branchId: BRANCH_B }]).mismatches).toBe(1);
  });

  it('a malformed line never throws and never contributes a figure', () => {
    const f = invoice([discounted]);
    const bad = [
      { ...f, lines: [[1, 2, 3]] },
      { ...f, lines: [f.lines[0]!.map((v, i) => (i === 13 ? 1000 : v))] },
      { ...f, lines: [f.lines[0]!.map((v, i) => (i === 13 ? '-5' : v))] },
      { ...f, lines: [f.lines[0]!.map((v, i) => (i === 13 ? '10.5' : v))] },
    ];
    for (const b of bad) {
      const proof = verifyInvoiceLineSets([b]);
      expect(proof.mismatches).toBe(1);
      expect(proof.lineDiscountByBranch.size).toBe(0);
    }
  });

  it('only VERIFIED invoices contribute: one bad invoice does not hide inside a good set', () => {
    const good = invoice([discounted], { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    const f = invoice([discounted], { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    const bad = { ...f, lines: [...f.lines, tuple(2, snapLine({ unitPriceAmountMinor: '0' }))] };
    const proof = verifyInvoiceLineSets([good, bad]);
    expect(proof.mismatches).toBe(1);
    expect(proof.lineDiscountByBranch.get(BRANCH_A)).toBe(1_000n); // the good one only
  });

  it('the exact integer discount is carried beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = snapLine({ discountMode: 'AMOUNT', discountAmountMinor: '9007199254740993' });
    const proof = verifyInvoiceLineSets([invoice([huge])]);
    expect(proof.lineDiscountByBranch.get(BRANCH_A)).toBe(9_007_199_254_740_993n);
  });
});

describe('the statement aggregates are cross-checked against the verified lines', () => {
  const proof = verifyInvoiceLineSets([
    invoice([discounted], { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
  ]);

  it('agrees when the count and the discount match', () => {
    expect(
      lineDiscountCrossCheckFailures(
        [{ branchId: BRANCH_A, invoiceCount: 1, lineDiscount: 1_000n }],
        proof,
      ),
    ).toBe(0);
  });

  it('fails on a different discount, a different invoice count, or a branch the aggregates do not know', () => {
    expect(
      lineDiscountCrossCheckFailures(
        [{ branchId: BRANCH_A, invoiceCount: 1, lineDiscount: 999n }],
        proof,
      ),
    ).toBe(1);
    expect(
      lineDiscountCrossCheckFailures(
        [{ branchId: BRANCH_A, invoiceCount: 2, lineDiscount: 1_000n }],
        proof,
      ),
    ).toBe(1);
    expect(lineDiscountCrossCheckFailures([], proof)).toBe(1);
  });

  it('a branch with credit notes only (no invoices) needs no verified lines', () => {
    expect(
      lineDiscountCrossCheckFailures(
        [
          { branchId: BRANCH_A, invoiceCount: 1, lineDiscount: 1_000n },
          { branchId: BRANCH_B, invoiceCount: 0, lineDiscount: 0n },
        ],
        proof,
      ),
    ).toBe(0);
  });
});
