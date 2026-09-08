import { describe, it, expect } from 'vitest';
import { Quantity } from './quantity.js';
import { divRoundExact, InexactError } from './rounding.js';
import {
  UomRegistry,
  InexactConversionError,
  UomFamilyMismatchError,
  UomConversionUnavailableError,
  BUILTIN_UOMS,
  UOM_CODE_RE,
  canonicalUomCode,
  isBuiltinUom,
} from './uom.js';

describe('@flower/uom — built-in registry exposure (Task 3.6 OD-6)', () => {
  it('BUILTIN_UOMS lists exactly the ten built-ins, all lowercase, all matching UOM_CODE_RE', () => {
    const codes = BUILTIN_UOMS.map((u) => u.code).sort();
    expect(codes).toEqual(
      [
        'centimeter',
        'dozen',
        'gram',
        'kilogram',
        'liter',
        'meter',
        'milliliter',
        'millimeter',
        'piece',
        'stem',
      ].sort(),
    );
    for (const u of BUILTIN_UOMS) {
      expect(u.code).toBe(u.code.toLowerCase());
      expect(UOM_CODE_RE.test(u.code)).toBe(true);
    }
    // no EACH built-in
    expect(BUILTIN_UOMS.some((u) => u.family === 'EACH')).toBe(false);
  });

  it('isBuiltinUom is exact on the canonical code', () => {
    expect(isBuiltinUom('piece')).toBe(true);
    expect(isBuiltinUom('meter')).toBe(true);
    expect(isBuiltinUom('PIECE')).toBe(false); // caller must canonicalize first
    expect(isBuiltinUom('box')).toBe(false);
    expect(isBuiltinUom('toString')).toBe(false); // prototype pollution guard
  });
});

describe('@flower/uom — canonicalUomCode + UOM_CODE_RE (Task 3.6 MC-1)', () => {
  it('trims + ASCII-lowercases', () => {
    expect(canonicalUomCode('  BOX ')).toBe('box');
    expect(canonicalUomCode('Carton')).toBe('carton');
    expect(canonicalUomCode('BAG-25KG')).toBe('bag-25kg');
  });
  it('accepts the frozen example set', () => {
    for (const c of ['piece', 'stem', 'box', 'carton', 'bag-25kg', 'bottle-100ml', 'roll.large']) {
      expect(UOM_CODE_RE.test(c), c).toBe(true);
    }
  });
  it('rejects a slash — a UOM code is a REST path segment', () => {
    expect(UOM_CODE_RE.test('box/12')).toBe(false);
    expect(UOM_CODE_RE.test(canonicalUomCode('BOX/12'))).toBe(false);
  });
  it('rejects a leading digit, empty, too long, uppercase, spaces', () => {
    expect(UOM_CODE_RE.test('1box')).toBe(false);
    expect(UOM_CODE_RE.test('')).toBe(false);
    expect(UOM_CODE_RE.test('x'.repeat(33))).toBe(false);
    expect(UOM_CODE_RE.test('Box')).toBe(false);
    expect(UOM_CODE_RE.test('a b')).toBe(false);
  });
});

describe('@flower/uom — divRoundExact / InexactError', () => {
  it('returns the exact quotient', () => {
    expect(divRoundExact(120n, 10n)).toBe(12n);
    expect(divRoundExact(0n, 5n)).toBe(0n);
  });
  it('throws InexactError on any remainder — never rounds', () => {
    expect(() => divRoundExact(125n, 10n)).toThrow(InexactError);
    expect(() => divRoundExact(7n, 2n)).toThrow(InexactError);
  });
  it('rejects a non-positive denominator', () => {
    expect(() => divRoundExact(10n, 0n)).toThrow(RangeError);
  });
});

describe('@flower/uom — Quantity.scaleByExact', () => {
  it('exact ratio → exact result', () => {
    expect(Quantity.parse('1').scaleByExact(12n).toString()).toBe('12');
    expect(Quantity.parse('3').scaleByExact(288n).toString()).toBe('864');
  });
  it('inexact ratio → throws, no rounding', () => {
    // 1 unit * 25 / 3 = 8.333... → not exact at scale 4
    expect(() => Quantity.parse('1').scaleByExact(25n, 3n)).toThrow(InexactError);
  });
});

describe('@flower/uom — UomRegistry.convertExact (Task 3.6 pack identity)', () => {
  const reg = new UomRegistry({
    units: [
      { code: 'box', family: 'EACH', perBase: { num: 1n, den: 1n }, maxDecimals: 0 },
      { code: 'carton', family: 'EACH', perBase: { num: 1n, den: 1n }, maxDecimals: 0 },
      { code: 'bunch', family: 'EACH', perBase: { num: 1n, den: 1n }, maxDecimals: 0 },
    ],
    conversions: [
      { from: 'box', to: 'piece', num: 12 },
      { from: 'carton', to: 'piece', num: 288 },
      { from: 'bunch', to: 'stem', num: 7, den: 2 }, // 3.5 stems per bunch
    ],
  });

  it('exact base-anchored pack conversions', () => {
    expect(reg.convertExact(Quantity.parse('1'), 'box', 'piece').toString()).toBe('12');
    expect(reg.convertExact(Quantity.parse('1'), 'carton', 'piece').toString()).toBe('288');
    expect(reg.convertExact(Quantity.parse('2'), 'carton', 'piece').toString()).toBe('576');
  });

  it('the frozen 617-style nested-pack proof (base-anchored, no graph)', () => {
    // 2 carton + 3 box + 5 piece, base = piece: 2*288 + 3*12 + 5 = 617
    const total = reg
      .convertExact(Quantity.parse('2'), 'carton', 'piece')
      .add(reg.convertExact(Quantity.parse('3'), 'box', 'piece'))
      .add(Quantity.parse('5'));
    expect(total.toString()).toBe('617');
  });

  it('identity when from == to', () => {
    expect(reg.convertExact(Quantity.parse('4'), 'piece', 'piece').toString()).toBe('4');
  });

  it('a non-exact result throws InexactConversionError — never HALF_UP', () => {
    // 1 bunch = 3.5 stem is exact; 1 stem -> bunch = 2/7 = 0.2857... → inexact
    expect(() => reg.convertExact(Quantity.parse('1'), 'stem', 'bunch')).toThrow(
      InexactConversionError,
    );
    // convert() would silently round it
    expect(reg.convert(Quantity.parse('1'), 'stem', 'bunch').toString()).toBe('0.2857');
  });

  it('same-family perBase math still applies (built-ins)', () => {
    expect(new UomRegistry().convertExact(Quantity.parse('1'), 'kilogram', 'gram').toString()).toBe(
      '1000',
    );
  });

  it('cross-family with no explicit rule still throws UomFamilyMismatchError', () => {
    expect(() => reg.convertExact(Quantity.parse('1'), 'meter', 'gram')).toThrow(
      UomFamilyMismatchError,
    );
  });
});

describe('@flower/uom — EACH never auto-converts by perBase (Task 3.6 scope check)', () => {
  // Two distinct EACH units, both perBase 1/1 — the ONLY reason they could look
  // "1:1 convertible". They must NOT be, absent an explicit conversion.
  const mkReg = (conversions: { from: string; to: string; num: number; den?: number }[] = []) =>
    new UomRegistry({
      units: [
        { code: 'crate', family: 'EACH', perBase: { num: 1n, den: 1n }, maxDecimals: 0 },
        { code: 'pallet', family: 'EACH', perBase: { num: 1n, den: 1n }, maxDecimals: 0 },
        { code: 'halfdozen', family: 'COUNT', perBase: { num: 6n, den: 1n }, maxDecimals: 0 },
      ],
      conversions,
    });

  it('A. EACH A → EACH B, no explicit conversion → unresolvable in convert() AND convertExact()', () => {
    const reg = mkReg();
    expect(() => reg.convert(Quantity.parse('1'), 'crate', 'pallet')).toThrow(
      UomConversionUnavailableError,
    );
    expect(() => reg.convertExact(Quantity.parse('1'), 'crate', 'pallet')).toThrow(
      UomConversionUnavailableError,
    );
    // and the reverse direction
    expect(() => reg.convertExact(Quantity.parse('1'), 'pallet', 'crate')).toThrow(
      UomConversionUnavailableError,
    );
  });

  it('B. EACH A → EACH B with an explicit conversion → resolves using THAT ratio, not 1:1', () => {
    const reg = mkReg([{ from: 'pallet', to: 'crate', num: 40 }]);
    expect(reg.convert(Quantity.parse('2'), 'pallet', 'crate').toString()).toBe('80');
    expect(reg.convertExact(Quantity.parse('2'), 'pallet', 'crate').toString()).toBe('80');
    // reverse direction of the same explicit row
    expect(reg.convertExact(Quantity.parse('80'), 'crate', 'pallet').toString()).toBe('2');
  });

  it('C. physical same-family units still use the perBase fallback', () => {
    const reg = new UomRegistry();
    expect(reg.convert(Quantity.parse('2.5'), 'kilogram', 'gram').toString()).toBe('2500');
    expect(reg.convertExact(Quantity.parse('3'), 'meter', 'millimeter').toString()).toBe('3000');
  });

  it('D. COUNT units still follow the frozen discrete perBase semantics', () => {
    const reg = mkReg();
    expect(reg.convert(Quantity.parse('2'), 'dozen', 'piece').toString()).toBe('24');
    expect(reg.convertExact(Quantity.parse('2'), 'halfdozen', 'piece').toString()).toBe('12');
    // a tenant COUNT unit vs a built-in COUNT unit resolves without an explicit row
    expect(reg.convertExact(Quantity.parse('1'), 'halfdozen', 'dozen')).toBeDefined();
  });

  it('E. isSameFamilyResolvable agrees with convert()/convertExact() on every case above', () => {
    const reg = mkReg();
    // EACH pair: NOT resolvable (matches the throw in A)
    expect(reg.isSameFamilyResolvable('crate', 'pallet')).toBe(false);
    // physical + COUNT: resolvable (matches C / D)
    expect(reg.isSameFamilyResolvable('kilogram', 'gram')).toBe(true);
    expect(reg.isSameFamilyResolvable('halfdozen', 'piece')).toBe(true);
    expect(reg.isSameFamilyResolvable('halfdozen', 'dozen')).toBe(true);
    // cross-family + identity: NOT resolvable
    expect(reg.isSameFamilyResolvable('meter', 'gram')).toBe(false);
    expect(reg.isSameFamilyResolvable('crate', 'crate')).toBe(false);
  });
});

describe('@flower/uom — isSameFamilyResolvable (redundant-conversion guard)', () => {
  it('built-in same-family pair is resolvable → an explicit row would be redundant', () => {
    const reg = new UomRegistry();
    expect(reg.isSameFamilyResolvable('kilogram', 'gram')).toBe(true);
    expect(reg.isSameFamilyResolvable('dozen', 'piece')).toBe(true);
  });
  it('tenant physical/COUNT unit vs a built-in of the same family is resolvable', () => {
    const reg = new UomRegistry({
      units: [
        { code: 'halfdozen', family: 'COUNT', perBase: { num: 6n, den: 1n }, maxDecimals: 0 },
      ],
    });
    expect(reg.isSameFamilyResolvable('halfdozen', 'piece')).toBe(true);
  });
  it('EACH vs anything, cross-family, unknown, and identity are NOT redundant', () => {
    const reg = new UomRegistry({
      units: [{ code: 'box', family: 'EACH', perBase: { num: 1n, den: 1n }, maxDecimals: 0 }],
    });
    expect(reg.isSameFamilyResolvable('box', 'piece')).toBe(false);
    expect(reg.isSameFamilyResolvable('meter', 'gram')).toBe(false);
    expect(reg.isSameFamilyResolvable('nope', 'piece')).toBe(false);
    expect(reg.isSameFamilyResolvable('piece', 'piece')).toBe(false);
  });
});
