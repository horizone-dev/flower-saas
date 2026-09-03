import { describe, it, expect } from 'vitest';
import { Money, sumMoney } from './money.js';
import { divRound } from './rounding.js';

describe('divRound', () => {
  it('HALF_UP rounds .5 away from zero', () => {
    expect(divRound(5n, 2n, 'HALF_UP')).toBe(3n);
    expect(divRound(-5n, 2n, 'HALF_UP')).toBe(-3n);
    expect(divRound(4n, 2n, 'HALF_UP')).toBe(2n);
  });
  it('HALF_EVEN rounds .5 to even', () => {
    expect(divRound(5n, 2n, 'HALF_EVEN')).toBe(2n);
    expect(divRound(7n, 2n, 'HALF_EVEN')).toBe(4n);
  });
  it('DOWN / UP truncate toward / away from zero', () => {
    expect(divRound(7n, 2n, 'DOWN')).toBe(3n);
    expect(divRound(7n, 2n, 'UP')).toBe(4n);
  });
});

describe('Money — construction & representation', () => {
  it('parses AED major units (2 decimals)', () => {
    expect(Money.ofMajor('10.50', 'AED').amountMinor).toBe(1050n);
    expect(Money.ofMajor('0.05', 'AED').amountMinor).toBe(5n);
    expect(Money.ofMajor('1000', 'AED').amountMinor).toBe(100000n);
  });
  it('parses KWD major units (3 decimals)', () => {
    expect(Money.ofMajor('1.500', 'KWD').amountMinor).toBe(1500n);
    expect(Money.ofMajor('10.005', 'KWD').amountMinor).toBe(10005n);
    expect(Money.ofMajor('0.001', 'KWD').amountMinor).toBe(1n);
  });
  it('rejects more decimals than the currency allows', () => {
    expect(() => Money.ofMajor('10.005', 'AED')).toThrow(/allows 2/);
    expect(() => Money.ofMajor('1.5005', 'KWD')).toThrow(/allows 3/);
  });
  it('round-trips through the DTO with the correct exponent', () => {
    const kwd = Money.ofMajor('12.345', 'KWD');
    const dto = kwd.toDTO();
    expect(dto).toEqual({ amountMinor: '12345', currency: 'KWD', exponent: 3 });
    expect(Money.fromDTO(dto).equals(kwd)).toBe(true);
  });
  it('formats major-unit strings per currency exponent', () => {
    expect(Money.ofMinor(1050n, 'AED').toString()).toBe('10.50 AED');
    expect(Money.ofMinor(1500n, 'KWD').toString()).toBe('1.500 KWD');
    expect(Money.ofMinor(-5n, 'KWD').toString()).toBe('-0.005 KWD');
  });
  it('rejects unknown currencies', () => {
    expect(() => Money.ofMinor(1n, 'ZZZ')).toThrow(/Unknown currency/);
  });
});

describe('Money — exact arithmetic', () => {
  it('adds / subtracts / negates', () => {
    const a = Money.ofMajor('10.00', 'AED');
    const b = Money.ofMajor('2.50', 'AED');
    expect(a.add(b).toString()).toBe('12.50 AED');
    expect(a.subtract(b).toString()).toBe('7.50 AED');
    expect(b.negate().toString()).toBe('-2.50 AED');
  });
  it('refuses cross-currency arithmetic', () => {
    expect(() => Money.ofMajor('1.00', 'AED').add(Money.ofMajor('1.000', 'KWD'))).toThrow(
      /Currency mismatch/,
    );
  });
  it('mulInt is exact', () => {
    expect(Money.ofMajor('1.99', 'AED').mulInt(3).toString()).toBe('5.97 AED');
  });
  it('sumMoney sums a list', () => {
    const items = [
      Money.ofMajor('1.11', 'AED'),
      Money.ofMajor('2.22', 'AED'),
      Money.ofMajor('3.33', 'AED'),
    ];
    expect(sumMoney(items, 'AED').toString()).toBe('6.66 AED');
  });
});

describe('Money — VAT / percentage (GCC rates)', () => {
  it('UAE 5% on AED 100.00 = AED 5.00', () => {
    expect(Money.ofMajor('100.00', 'AED').percentage(500).toString()).toBe('5.00 AED');
  });
  it('KSA 15% on SAR 200.00 = SAR 30.00', () => {
    expect(Money.ofMajor('200.00', 'SAR').percentage(1500).toString()).toBe('30.00 SAR');
  });
  it('5% on KWD 10.005 rounds HALF_UP at 3 decimals', () => {
    // 10.005 * 0.05 = 0.50025 -> 0.500 KWD
    expect(Money.ofMajor('10.005', 'KWD').percentage(500).toString()).toBe('0.500 KWD');
  });
  it('5% on AED 10.10 = AED 0.51 (0.505 -> half-up)', () => {
    expect(Money.ofMajor('10.10', 'AED').percentage(500).toString()).toBe('0.51 AED');
  });
  it('mulRatio with an explicit denominator', () => {
    expect(Money.ofMajor('10.00', 'AED').mulRatio(1, 3).toString()).toBe('3.33 AED');
    expect(Money.ofMajor('10.00', 'AED').mulRatio(1, 3, 'UP').toString()).toBe('3.34 AED');
  });
});

describe('Money — allocate (split / partial payments, residual rule)', () => {
  it('AED 10.00 split 3 ways sums exactly, residual to the front', () => {
    const parts = Money.ofMajor('10.00', 'AED').allocate([1, 1, 1]);
    expect(parts.map((p) => p.toString())).toEqual(['3.34 AED', '3.33 AED', '3.33 AED']);
    expect(sumMoney(parts, 'AED').toString()).toBe('10.00 AED');
  });
  it('KWD 0.010 split 3 ways (3-decimal residual)', () => {
    const parts = Money.ofMajor('0.010', 'KWD').allocate([1, 1, 1]);
    expect(parts.map((p) => p.toString())).toEqual(['0.004 KWD', '0.003 KWD', '0.003 KWD']);
    expect(sumMoney(parts, 'KWD').toString()).toBe('0.010 KWD');
  });
  it('weighted split preserves the total', () => {
    const parts = Money.ofMajor('100.00', 'AED').allocate([70, 20, 10]);
    expect(sumMoney(parts, 'AED').toString()).toBe('100.00 AED');
    expect(parts[0]!.toString()).toBe('70.00 AED');
  });
  it('negative amounts (a refund split) still sum exactly', () => {
    const parts = Money.ofMajor('-10.00', 'AED').allocate([1, 1, 1]);
    expect(sumMoney(parts, 'AED').toString()).toBe('-10.00 AED');
  });
  it('rejects a zero weight total', () => {
    expect(() => Money.ofMajor('1.00', 'AED').allocate([0, 0])).toThrow(/weight total/);
  });
});

describe('Money — comparison', () => {
  it('compares and equals', () => {
    const a = Money.ofMajor('1.00', 'AED');
    const b = Money.ofMajor('2.00', 'AED');
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(Money.ofMajor('1.00', 'AED'))).toBe(0);
    expect(a.equals(Money.ofMinor(100n, 'AED'))).toBe(true);
  });
});
