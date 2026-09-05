import { describe, it, expect } from 'vitest';
import {
  Quantity,
  QuantityOverflowError,
  QUANTITY_MAX_SCALED,
  QUANTITY_MIN_SCALED,
} from './quantity.js';
import { quantityDtoSchema, parseQuantity } from './schema.js';

describe('Quantity — parsing & representation (NUMERIC(18,4))', () => {
  it('parses whole numbers and fractions up to 4 dp', () => {
    expect(Quantity.parse('12').scaled).toBe(120_000n);
    expect(Quantity.parse('1.5').scaled).toBe(15_000n);
    expect(Quantity.parse('0.25').scaled).toBe(2_500n);
    expect(Quantity.parse('0.0001').scaled).toBe(1n);
    expect(Quantity.parse('-3.75').scaled).toBe(-37_500n);
  });
  it('rejects more than 4 decimal places', () => {
    expect(() => Quantity.parse('1.00005')).toThrow(/4 decimal places/);
  });
  it('round-trips toString (trailing zeros trimmed) and toFixed4', () => {
    expect(Quantity.parse('1.5').toString()).toBe('1.5');
    expect(Quantity.parse('12').toString()).toBe('12');
    expect(Quantity.parse('1.5').toFixed4()).toBe('1.5000');
    expect(Quantity.parse('-0.005').toString()).toBe('-0.005');
  });
  it('reports the decimal places actually used', () => {
    expect(Quantity.parse('12').usedDecimals).toBe(0);
    expect(Quantity.parse('1.5').usedDecimals).toBe(1);
    expect(Quantity.parse('0.25').usedDecimals).toBe(2);
    expect(Quantity.parse('1.2340').usedDecimals).toBe(3);
  });
});

describe('Quantity — storable NUMERIC(18,4) range', () => {
  it('accepts the exact bounds', () => {
    expect(Quantity.ofScaled(QUANTITY_MAX_SCALED).scaled).toBe(QUANTITY_MAX_SCALED);
    expect(Quantity.ofScaled(QUANTITY_MIN_SCALED).scaled).toBe(QUANTITY_MIN_SCALED);
  });
  it('rejects a value past the bounds (construction and arithmetic overflow)', () => {
    expect(() => Quantity.ofScaled(QUANTITY_MAX_SCALED + 1n)).toThrow(QuantityOverflowError);
    expect(() => Quantity.ofScaled(QUANTITY_MAX_SCALED).add(Quantity.parse('1'))).toThrow(
      QuantityOverflowError,
    );
    expect(() => Quantity.parse('100000000000000')).toThrow(QuantityOverflowError); // 15 integer digits
  });
  it('a number factor that has already lost precision is rejected', () => {
    expect(() => Quantity.parse('1').mulInt(2 ** 53 + 1)).toThrow(/safe integer/);
  });
});

describe('Quantity — arithmetic (exact)', () => {
  it('adds / subtracts / multiplies by an integer', () => {
    expect(Quantity.parse('1.5').add(Quantity.parse('0.25')).toString()).toBe('1.75');
    expect(Quantity.parse('10').subtract(Quantity.parse('2.5')).toString()).toBe('7.5');
    expect(Quantity.parse('1.5').mulInt(3).toString()).toBe('4.5');
  });
  it('compares and equals', () => {
    expect(Quantity.parse('1.5').compare(Quantity.parse('1.5'))).toBe(0);
    expect(Quantity.parse('1').compare(Quantity.parse('1.0001'))).toBe(-1);
    expect(Quantity.parse('1.5').equals(Quantity.ofScaled(15000n))).toBe(true);
  });
});

describe('Quantity — scaleBy (generic exact ratio multiply)', () => {
  it('multiplies by a rational, rounding the scale-4 result', () => {
    // a recipe scaled ×2.5
    expect(Quantity.parse('4').scaleBy(5, 2).toString()).toBe('10');
    // a 1.05 wastage factor on 10 stems -> 10.5 -> not a domain rule, just the math
    expect(Quantity.parse('10').scaleBy(105, 100).toString()).toBe('10.5');
  });
  it('honours the rounding mode; default is HALF_UP', () => {
    // 1 / 3 = 0.3333... at scale 4
    expect(Quantity.parse('1').scaleBy(1, 3).toString()).toBe('0.3333');
    expect(Quantity.parse('1').scaleBy(1, 3, 'UP').toString()).toBe('0.3334');
  });
  it('rejects a non-positive denominator', () => {
    expect(() => Quantity.parse('1').scaleBy(1, 0)).toThrow(/> 0/);
    expect(() => Quantity.parse('1').scaleBy(1, -2)).toThrow(/> 0/);
  });
});

describe('Quantity — DTO', () => {
  it('toDTO / fromDTO round-trip via the fixed-4 string', () => {
    const q = Quantity.parse('1.5');
    expect(q.toDTO()).toEqual({ amount: '1.5000' });
    expect(Quantity.fromDTO(q.toDTO()).equals(q)).toBe(true);
  });
  it('quantityDtoSchema accepts a decimal string, rejects a number and >4 dp', () => {
    expect(quantityDtoSchema.safeParse({ amount: '1.5000' }).success).toBe(true);
    expect(quantityDtoSchema.safeParse({ amount: '12' }).success).toBe(true);
    expect(quantityDtoSchema.safeParse({ amount: 1.5 }).success).toBe(false);
    expect(quantityDtoSchema.safeParse({ amount: '1.00005' }).success).toBe(false);
  });
  it('quantityDtoSchema rejects a value outside the NUMERIC(18,4) range', () => {
    expect(quantityDtoSchema.safeParse({ amount: '100000000000000' }).success).toBe(false);
  });
  it('parseQuantity validates and constructs', () => {
    expect(parseQuantity({ amount: '2.5' }).equals(Quantity.parse('2.5'))).toBe(true);
    expect(() => parseQuantity({ amount: 'x' })).toThrow();
  });
});
