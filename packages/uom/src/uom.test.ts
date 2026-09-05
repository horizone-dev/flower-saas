import { describe, it, expect } from 'vitest';
import { Quantity } from './quantity.js';
import {
  UomRegistry,
  FractionalUnitError,
  UomFamilyMismatchError,
  UomConversionUnavailableError,
  InvalidUomError,
  InvalidUomConversionError,
  type UomDef,
} from './uom.js';

/** A divisible individually-handled item — the `EACH` family (a tenant
 *  registers its own; none are built in). */
const foamBlock: UomDef = {
  code: 'block',
  family: 'EACH',
  perBase: { num: 1n, den: 1n },
  maxDecimals: 2,
};
const wrap: UomDef = {
  code: 'wrap',
  family: 'EACH',
  perBase: { num: 1n, den: 1n },
  maxDecimals: 2,
};
const sheet: UomDef = {
  code: 'sheet',
  family: 'EACH',
  perBase: { num: 1n, den: 1n },
  maxDecimals: 2,
};

describe('UomRegistry — same-family conversion (global ratios)', () => {
  const reg = new UomRegistry();

  it('1.5 m of ribbon = 150 cm = 1500 mm', () => {
    const oneAndAHalfMetres = Quantity.parse('1.5');
    expect(reg.convert(oneAndAHalfMetres, 'meter', 'centimeter').toString()).toBe('150');
    expect(reg.convert(oneAndAHalfMetres, 'meter', 'millimeter').toString()).toBe('1500');
  });
  it('75 cm = 0.75 m (fractional result preserved)', () => {
    expect(reg.convert(Quantity.parse('75'), 'centimeter', 'meter').toString()).toBe('0.75');
  });
  it('2.5 kg = 2500 g', () => {
    expect(reg.convert(Quantity.parse('2.5'), 'kilogram', 'gram').toString()).toBe('2500');
  });
  it('a dozen = 12 pieces', () => {
    expect(reg.convert(Quantity.parse('1'), 'dozen', 'piece').toString()).toBe('12');
  });
  it('refuses cross-family conversion', () => {
    expect(() => reg.convert(Quantity.parse('1'), 'meter', 'gram')).toThrow(UomFamilyMismatchError);
  });
});

describe('UomRegistry — nested pack conversion (generic, multi-level via the family base)', () => {
  it('Piece -> Box(12) -> Carton(144): every pair resolves without a direct conversion', () => {
    const reg = new UomRegistry({
      units: [
        { code: 'box', family: 'COUNT', perBase: { num: 12n, den: 1n }, maxDecimals: 0 },
        { code: 'carton', family: 'COUNT', perBase: { num: 144n, den: 1n }, maxDecimals: 0 },
      ],
    });
    expect(reg.convert(Quantity.parse('1'), 'carton', 'piece').toString()).toBe('144');
    expect(reg.convert(Quantity.parse('1'), 'carton', 'box').toString()).toBe('12');
    expect(reg.convert(Quantity.parse('2'), 'box', 'piece').toString()).toBe('24');
  });
  it('Bottle -> Box(6) -> Carton(24)', () => {
    const reg = new UomRegistry({
      units: [
        { code: 'bottle', family: 'COUNT', perBase: { num: 1n, den: 1n }, maxDecimals: 0 },
        { code: 'perfumeBox', family: 'COUNT', perBase: { num: 6n, den: 1n }, maxDecimals: 0 },
        { code: 'perfumeCarton', family: 'COUNT', perBase: { num: 24n, den: 1n }, maxDecimals: 0 },
      ],
    });
    expect(reg.convert(Quantity.parse('1'), 'perfumeCarton', 'bottle').toString()).toBe('24');
    expect(reg.convert(Quantity.parse('1'), 'perfumeCarton', 'perfumeBox').toString()).toBe('4');
  });
  it('gram -> kg -> Bag(25 kg): a MASS pack level', () => {
    const reg = new UomRegistry({
      units: [{ code: 'bag', family: 'MASS', perBase: { num: 25000n, den: 1n }, maxDecimals: 4 }],
    });
    expect(reg.convert(Quantity.parse('2'), 'bag', 'kilogram').toString()).toBe('50');
    expect(reg.convert(Quantity.parse('2'), 'bag', 'gram').toString()).toBe('50000');
  });
  it('Stem -> Bunch(10) -> Box(120)', () => {
    const reg = new UomRegistry({
      units: [
        { code: 'bunch', family: 'COUNT', perBase: { num: 10n, den: 1n }, maxDecimals: 0 },
        { code: 'flowerBox', family: 'COUNT', perBase: { num: 120n, den: 1n }, maxDecimals: 0 },
      ],
    });
    expect(reg.convert(Quantity.parse('1'), 'flowerBox', 'stem').toString()).toBe('120');
    expect(reg.convert(Quantity.parse('1'), 'flowerBox', 'bunch').toString()).toBe('12');
  });
});

describe('UomRegistry — item-specific conversion overrides generic family math', () => {
  it('a box is generically 12 pieces, but this item ships boxes of 10', () => {
    const reg = new UomRegistry({
      units: [{ code: 'box', family: 'COUNT', perBase: { num: 12n, den: 1n }, maxDecimals: 0 }],
      conversions: [{ from: 'box', to: 'piece', num: 10 }],
    });
    // the explicit conversion wins over perBase (which would give 12)
    expect(reg.convert(Quantity.parse('1'), 'box', 'piece').toString()).toBe('10');
    expect(reg.convert(Quantity.parse('30'), 'piece', 'box').toString()).toBe('3');
  });
  it('1 bunch Baby’s Breath ≈ 10 stems (item-specific)', () => {
    const reg = new UomRegistry({
      units: [{ code: 'bunch', family: 'COUNT', perBase: { num: 10n, den: 1n }, maxDecimals: 0 }],
      conversions: [{ from: 'bunch', to: 'stem', num: 10 }],
    });
    expect(reg.convert(Quantity.parse('3'), 'bunch', 'stem').toString()).toBe('30');
  });
  it('fractional ratio pack: 1 sheet = 2.5 wraps -> num 5 den 2', () => {
    const reg = new UomRegistry({
      units: [sheet, wrap],
      conversions: [{ from: 'sheet', to: 'wrap', num: 5, den: 2 }],
    });
    expect(reg.convert(Quantity.parse('2'), 'sheet', 'wrap').toString()).toBe('5');
  });
});

describe('UomRegistry — EACH family has no generic conversion', () => {
  it('two distinct EACH units with no explicit rule cannot be converted', () => {
    const reg = new UomRegistry({ units: [foamBlock, wrap] });
    expect(() => reg.convert(Quantity.parse('1'), 'block', 'wrap')).toThrow(
      UomConversionUnavailableError,
    );
  });
  it('a discrete COUNT unit and an EACH unit are never silently convertible', () => {
    const reg = new UomRegistry({ units: [foamBlock] });
    expect(() => reg.convert(Quantity.parse('1'), 'block', 'piece')).toThrow(
      UomFamilyMismatchError,
    );
  });
  it('an explicit conversion still bridges an EACH unit to another family', () => {
    // this ribbon roll = 25 m
    const reg = new UomRegistry({
      units: [{ code: 'roll', family: 'EACH', perBase: { num: 1n, den: 1n }, maxDecimals: 2 }],
      conversions: [{ from: 'roll', to: 'meter', num: 25 }],
    });
    expect(reg.convert(Quantity.parse('2'), 'roll', 'meter').toString()).toBe('50');
  });
});

describe('UomRegistry — eager validation', () => {
  it('rejects a conversion referencing an unregistered unit', () => {
    expect(() => new UomRegistry({ conversions: [{ from: 'nope', to: 'piece', num: 2 }] })).toThrow(
      InvalidUomConversionError,
    );
  });
  it('rejects a non-positive conversion ratio', () => {
    expect(
      () => new UomRegistry({ conversions: [{ from: 'piece', to: 'dozen', num: 0 }] }),
    ).toThrow(InvalidUomConversionError);
    expect(
      () => new UomRegistry({ conversions: [{ from: 'piece', to: 'dozen', num: 1, den: 0 }] }),
    ).toThrow(InvalidUomConversionError);
  });
  it('rejects a UomDef with a non-positive perBase', () => {
    expect(
      () =>
        new UomRegistry({
          units: [{ code: 'bad', family: 'MASS', perBase: { num: 0n, den: 1n }, maxDecimals: 2 }],
        }),
    ).toThrow(InvalidUomError);
  });
  it('rejects a COUNT unit that is not discrete', () => {
    expect(
      () =>
        new UomRegistry({
          units: [
            { code: 'halfPiece', family: 'COUNT', perBase: { num: 1n, den: 1n }, maxDecimals: 2 },
          ],
        }),
    ).toThrow(/discrete/);
  });
});

describe('UomRegistry — rounding contract', () => {
  const reg = new UomRegistry({
    units: [{ code: 'carton', family: 'COUNT', perBase: { num: 144n, den: 1n }, maxDecimals: 0 }],
  });
  it('forward pack conversion into base units is exact', () => {
    expect(reg.convert(Quantity.parse('3'), 'carton', 'piece').toString()).toBe('432');
  });
  it('a reverse conversion is lossy; the caller picks the rounding mode', () => {
    // 5 pieces / 144 = 0.03472... cartons
    expect(reg.convert(Quantity.parse('5'), 'piece', 'carton').toString()).toBe('0.0347'); // HALF_UP
    expect(reg.convert(Quantity.parse('5'), 'piece', 'carton', 'DOWN').toString()).toBe('0.0347');
    expect(reg.convert(Quantity.parse('5'), 'piece', 'carton', 'UP').toString()).toBe('0.0348');
  });
  it('piece -> carton -> piece is NOT the identity (documented precision loss)', () => {
    const back = reg.convert(
      reg.convert(Quantity.parse('5'), 'piece', 'carton'),
      'carton',
      'piece',
    );
    expect(back.toString()).toBe('4.9968'); // 0.0347 * 144
    expect(back.equals(Quantity.parse('5'))).toBe(false);
  });
});

describe('UomRegistry — per-unit decimal rules', () => {
  const reg = new UomRegistry({ units: [foamBlock] });

  it('allows 1.5 m of ribbon', () => {
    expect(() => reg.assertPermitted(Quantity.parse('1.5'), 'meter')).not.toThrow();
  });
  it('allows 0.25 of a foam block (EACH, 2 decimals)', () => {
    expect(() => reg.assertPermitted(Quantity.parse('0.25'), 'block')).not.toThrow();
  });
  it('rejects 1.5 gift boxes (piece: 0 decimals)', () => {
    expect(() => reg.assertPermitted(Quantity.parse('1.5'), 'piece')).toThrow(FractionalUnitError);
  });
  it('rejects 0.005 of a block (block: 2 decimals)', () => {
    expect(() => reg.assertPermitted(Quantity.parse('0.005'), 'block')).toThrow(
      FractionalUnitError,
    );
  });
});
