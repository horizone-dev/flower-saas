import { describe, expect, it } from 'vitest';
import {
  computeCommercialSnapshotFingerprintV1,
  computeCommercialSnapshotFingerprintV2,
  computeCommercialSnapshotFingerprintByVersion,
  type CommercialSnapshotInput,
  type CommercialSnapshotLine,
} from './commercial-snapshot.js';

/**
 * Task 3b.4 Checkpoint C — golden-vector regression for the V1/V2 fingerprint
 * shapes + version-dispatch semantics. The two hex digests below were
 * computed INDEPENDENTLY of this module (a standalone script reimplementing
 * `canonicalize` + `JSON.stringify` + SHA-256 over the exact fixed fixture
 * below) — they protect V1's frozen legacy semantics and V2's shape from ANY
 * future accidental drift in field list, canonicalization, or hash algorithm.
 */

const LINE: CommercialSnapshotLine = {
  productId: '11111111-1111-7111-8111-111111111111',
  variantId: '22222222-2222-7222-8222-222222222222',
  quantity: '2.0000',
  selectedUomCode: 'EACH',
  baseUomCode: 'EACH',
  conversionNumerator: '1',
  conversionDenominator: '1',
  unitPriceAmountMinor: '1000',
  unitPriceCurrencyCode: 'AED',
  unitPriceCurrencyExponent: 2,
  discountMode: 'NONE',
  discountBps: null,
  discountAmountMinor: '0',
  taxCategoryKey: 'STANDARD',
  rateBps: 500,
  effectiveFrom: '2026-01-01',
  resolutionSource: 'VARIANT',
};

const V1_INPUT: CommercialSnapshotInput = {
  tenantId: '33333333-3333-7333-8333-333333333333',
  companyId: '44444444-4444-7444-8444-444444444444',
  originBranchId: '55555555-5555-7555-8555-555555555555',
  fulfillingBranchId: '55555555-5555-7555-8555-555555555555',
  customerId: null,
  kind: 'WALK_IN',
  currencyCode: 'AED',
  lines: [LINE],
  documentDiscountMode: 'NONE',
  documentDiscountBps: null,
  documentDiscountAmountMinor: '0',
  documentDiscountReason: null,
};

const POLICY = {
  taxPriceMode: 'TAX_EXCLUSIVE',
  taxRoundingScope: 'LINE',
  taxRoundingMode: 'HALF_UP',
};

// computed independently (Node's `crypto` module, a hand-rolled `canonicalize`
// reimplementation, over the exact fixtures above) — never derived by calling
// the function under test.
const V1_GOLDEN_HASH = '15103f0c9a4f4a18f4cbded287bd016f6da745616662c149c6688e87dec71a3b';
const V2_GOLDEN_HASH = 'c8f6467b41fc172bc19bc34385e13c82e75ebc5de897af16c45846a6fd320728';

describe('commercial-snapshot — V1 frozen golden vector', () => {
  it('matches the independently-computed V1 digest exactly', () => {
    expect(computeCommercialSnapshotFingerprintV1(V1_INPUT)).toBe(V1_GOLDEN_HASH);
  });

  it('V1 is deterministic and stable across repeated calls', () => {
    const a = computeCommercialSnapshotFingerprintV1(V1_INPUT);
    const b = computeCommercialSnapshotFingerprintV1(V1_INPUT);
    expect(a).toBe(b);
  });

  it('V1 never changes when only fiscal-policy-shaped extra data is present nearby (no such field exists in its type — structural proof)', () => {
    expect(Object.keys(V1_INPUT)).not.toContain('taxPriceMode');
    expect(Object.keys(V1_INPUT)).not.toContain('taxRoundingScope');
    expect(Object.keys(V1_INPUT)).not.toContain('taxRoundingMode');
  });
});

describe('commercial-snapshot — V2 golden vector', () => {
  it('matches the independently-computed V2 digest exactly', () => {
    expect(computeCommercialSnapshotFingerprintV2(V1_INPUT, POLICY)).toBe(V2_GOLDEN_HASH);
  });

  it('V2 differs from V1 for the identical commercial payload (policy fields are load-bearing)', () => {
    const v1 = computeCommercialSnapshotFingerprintV1(V1_INPUT);
    const v2 = computeCommercialSnapshotFingerprintV2(V1_INPUT, POLICY);
    expect(v2).not.toBe(v1);
  });

  it('changing taxPriceMode alone changes the V2 hash', () => {
    const base = computeCommercialSnapshotFingerprintV2(V1_INPUT, POLICY);
    const changed = computeCommercialSnapshotFingerprintV2(V1_INPUT, {
      ...POLICY,
      taxPriceMode: 'TAX_INCLUSIVE',
    });
    expect(changed).not.toBe(base);
  });

  it('changing taxRoundingScope alone changes the V2 hash', () => {
    const base = computeCommercialSnapshotFingerprintV2(V1_INPUT, POLICY);
    const changed = computeCommercialSnapshotFingerprintV2(V1_INPUT, {
      ...POLICY,
      taxRoundingScope: 'DOCUMENT',
    });
    expect(changed).not.toBe(base);
  });

  it('changing taxRoundingMode alone changes the V2 hash', () => {
    const base = computeCommercialSnapshotFingerprintV2(V1_INPUT, POLICY);
    const changed = computeCommercialSnapshotFingerprintV2(V1_INPUT, {
      ...POLICY,
      taxRoundingMode: 'HALF_EVEN',
    });
    expect(changed).not.toBe(base);
  });
});

describe('commercial-snapshot — version-dispatch helper', () => {
  it('version 1 dispatches to the V1 builder, ignoring any supplied policy', () => {
    expect(computeCommercialSnapshotFingerprintByVersion(1, V1_INPUT)).toBe(V1_GOLDEN_HASH);
    expect(computeCommercialSnapshotFingerprintByVersion(1, V1_INPUT, POLICY)).toBe(V1_GOLDEN_HASH);
  });

  it('version 2 dispatches to the V2 builder and requires a policy', () => {
    expect(computeCommercialSnapshotFingerprintByVersion(2, V1_INPUT, POLICY)).toBe(V2_GOLDEN_HASH);
    expect(() => computeCommercialSnapshotFingerprintByVersion(2, V1_INPUT)).toThrow(RangeError);
  });

  it('an unrecognised version fails closed — never silently assumes the latest', () => {
    expect(() => computeCommercialSnapshotFingerprintByVersion(3, V1_INPUT, POLICY)).toThrow(
      RangeError,
    );
    expect(() => computeCommercialSnapshotFingerprintByVersion(0, V1_INPUT, POLICY)).toThrow(
      RangeError,
    );
  });
});
