import { describe, it, expect } from 'vitest';
import { Quantity } from './quantity.js';
import { UomRegistry, FractionalUnitError, UomFamilyMismatchError } from './uom.js';

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

describe('UomRegistry — item-specific & pack conversions', () => {
  it('1 carton = 12 pieces (barcode pack conversion at receiving)', () => {
    const reg = new UomRegistry({
      units: [{ code: 'carton', family: 'COUNT', perBase: { num: 12n, den: 1n }, maxDecimals: 0 }],
      conversions: [{ from: 'carton', to: 'piece', num: 12 }],
    });
    expect(reg.convert(Quantity.parse('2'), 'carton', 'piece').toString()).toBe('24');
    // reverse direction works too
    expect(reg.convert(Quantity.parse('36'), 'piece', 'carton').toString()).toBe('3');
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
      units: [{ code: 'wrap', family: 'COUNT', perBase: { num: 2n, den: 5n }, maxDecimals: 2 }],
      conversions: [{ from: 'sheet', to: 'wrap', num: 5, den: 2 }],
    });
    expect(reg.convert(Quantity.parse('2'), 'sheet', 'wrap').toString()).toBe('5');
  });
});

describe('UomRegistry — per-unit decimal rules', () => {
  const reg = new UomRegistry();

  it('allows 1.5 m of ribbon', () => {
    expect(() => reg.assertPermitted(Quantity.parse('1.5'), 'meter')).not.toThrow();
  });
  it('allows 0.25 of a foam block', () => {
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
