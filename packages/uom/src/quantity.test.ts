import { describe, it, expect } from 'vitest';
import { Quantity } from './quantity.js';

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
