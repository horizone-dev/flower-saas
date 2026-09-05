import { describe, it, expect } from 'vitest';
import { Money, sumMoney, MoneyOverflowError, MONEY_MAX_MINOR, MONEY_MIN_MINOR } from './money.js';
import { moneyDtoSchema, parseMoney } from './schema.js';
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
  it('negative amount + unequal weights — residual by largest remainder (F2)', () => {
    // -70 / [1,2,3]: exact shares -11.67, -23.33, -35.00. The extra -1 minor unit
    // must go to the part with the largest fractional shortfall (part 0), not the
    // one that already divided evenly (part 2).
    const parts = Money.ofMinor(-70n, 'AED').allocate([1, 2, 3]);
    expect(parts.map((p) => p.amountMinor)).toEqual([-12n, -23n, -35n]);
    expect(sumMoney(parts, 'AED').amountMinor).toBe(-70n);
  });
  it('negative and positive splits of the same magnitude mirror each other here', () => {
    const pos = Money.ofMinor(70n, 'AED')
      .allocate([1, 2, 3])
      .map((p) => p.amountMinor);
    const neg = Money.ofMinor(-70n, 'AED')
      .allocate([1, 2, 3])
      .map((p) => p.amountMinor);
    expect(pos).toEqual([12n, 23n, 35n]);
    expect(neg).toEqual(pos.map((v) => -v));
  });
  it('negative equal-weight split spreads the residual, not all onto one part', () => {
    // -101 / 3 -> -33.67 each: two parts get -34, one gets -33; sums to -101
    const parts = Money.ofMinor(-101n, 'AED')
      .allocate([1, 1, 1])
      .map((p) => p.amountMinor);
    expect(parts.filter((v) => v === -34n)).toHaveLength(2);
    expect(parts.filter((v) => v === -33n)).toHaveLength(1);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(-101n);
  });
  it('3-decimal negative weighted split (KWD) sums exactly', () => {
    const parts = Money.ofMinor(-1000n, 'KWD').allocate([2, 3, 5]);
    expect(sumMoney(parts, 'KWD').amountMinor).toBe(-1000n);
    expect(parts.map((p) => p.amountMinor)).toEqual([-200n, -300n, -500n]);
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

describe('Money — storable BIGINT range', () => {
  it('accepts the exact BIGINT bounds', () => {
    expect(Money.ofMinor(MONEY_MAX_MINOR, 'AED').amountMinor).toBe(MONEY_MAX_MINOR);
    expect(Money.ofMinor(MONEY_MIN_MINOR, 'AED').amountMinor).toBe(MONEY_MIN_MINOR);
  });
  it('rejects a value past the bounds (construction and arithmetic overflow)', () => {
    expect(() => Money.ofMinor(MONEY_MAX_MINOR + 1n, 'AED')).toThrow(MoneyOverflowError);
    expect(() => Money.ofMinor(MONEY_MIN_MINOR - 1n, 'AED')).toThrow(MoneyOverflowError);
    expect(() => Money.ofMinor(MONEY_MAX_MINOR, 'AED').add(Money.ofMinor(1n, 'AED'))).toThrow(
      MoneyOverflowError,
    );
    expect(() => Money.ofMajor('92233720368547758.08', 'AED')).toThrow(MoneyOverflowError);
  });
  it('a huge but in-range minor-unit string is fine (string path, no precision loss)', () => {
    const big = '9007199254740993'; // 2^53 + 1 — unrepresentable as a JS number
    expect(Money.ofMinor(big, 'AED').amountMinor).toBe(9007199254740993n);
  });
  it('a number factor that has already lost precision is rejected', () => {
    expect(() => Money.ofMinor(1n, 'AED').mulInt(2 ** 53 + 1)).toThrow(/safe integer/);
  });
});

describe('Money — abs / min / max / isPositive', () => {
  it('abs / isPositive', () => {
    expect(Money.ofMajor('-3.50', 'AED').abs().toString()).toBe('3.50 AED');
    expect(Money.ofMajor('3.50', 'AED').abs().toString()).toBe('3.50 AED');
    expect(Money.ofMajor('3.50', 'AED').isPositive).toBe(true);
    expect(Money.zero('AED').isPositive).toBe(false);
    expect(Money.ofMajor('-1.00', 'AED').isPositive).toBe(false);
  });
  it('min / max return one of the operands and enforce currency', () => {
    const a = Money.ofMajor('5.00', 'AED');
    const b = Money.ofMajor('9.00', 'AED');
    expect(a.min(b)).toBe(a);
    expect(a.max(b)).toBe(b);
    expect(() => a.min(Money.ofMajor('1.000', 'KWD'))).toThrow(/Currency mismatch/);
  });
});

describe('Money — divmod (pure integer division, no costing behaviour)', () => {
  it('quotient × divisor + remainder === the amount', () => {
    const { quotient, remainder } = Money.ofMinor(1000n, 'AED').divmod(12);
    expect(quotient.amountMinor).toBe(83n);
    expect(remainder.amountMinor).toBe(4n);
    expect(quotient.mulInt(12).add(remainder).amountMinor).toBe(1000n);
  });
  it('negative amount: remainder carries the sign of the dividend', () => {
    const { quotient, remainder } = Money.ofMinor(-7n, 'AED').divmod(2);
    expect([quotient.amountMinor, remainder.amountMinor]).toEqual([-3n, -1n]);
    expect(quotient.mulInt(2).add(remainder).amountMinor).toBe(-7n);
  });
  it('rejects a non-positive divisor', () => {
    expect(() => Money.ofMinor(10n, 'AED').divmod(0)).toThrow(/positive integer/);
    expect(() => Money.ofMinor(10n, 'AED').divmod(-2)).toThrow(/positive integer/);
  });
});

describe('Money — capAllocate (pure FIFO primitive)', () => {
  it('ADR-0019 worked example: 650 across [300, 200, 500] -> [300, 200, 150], remainder 0', () => {
    const { allocations, remainder } = Money.ofMinor(650n, 'AED').capAllocate([
      Money.ofMinor(300n, 'AED'),
      Money.ofMinor(200n, 'AED'),
      Money.ofMinor(500n, 'AED'),
    ]);
    expect(allocations.map((m) => m.amountMinor)).toEqual([300n, 200n, 150n]);
    expect(remainder.amountMinor).toBe(0n);
  });
  it('an over-payment leaves an explicit non-zero remainder (never silently absorbed)', () => {
    const { allocations, remainder } = Money.ofMinor(1200n, 'AED').capAllocate([
      Money.ofMinor(300n, 'AED'),
      Money.ofMinor(200n, 'AED'),
      Money.ofMinor(500n, 'AED'),
    ]);
    expect(allocations.map((m) => m.amountMinor)).toEqual([300n, 200n, 500n]);
    expect(remainder.amountMinor).toBe(200n);
  });
  it('invariant: sum(allocations) + remainder === the amount, and each <= its cap', () => {
    const amount = Money.ofMinor(1234n, 'AED');
    const caps = [500n, 0n, 800n, 100n].map((v) => Money.ofMinor(v, 'AED'));
    const { allocations, remainder } = amount.capAllocate(caps);
    allocations.forEach((a, i) => expect(a.amountMinor).toBeLessThanOrEqual(caps[i]!.amountMinor));
    expect(sumMoney([...allocations, remainder], 'AED').amountMinor).toBe(1234n);
  });
  it('empty caps -> the whole amount is the remainder', () => {
    const { allocations, remainder } = Money.ofMinor(500n, 'AED').capAllocate([]);
    expect(allocations).toEqual([]);
    expect(remainder.amountMinor).toBe(500n);
  });
  it('rejects a negative amount, a negative cap, or a currency mismatch', () => {
    expect(() => Money.ofMinor(-1n, 'AED').capAllocate([])).toThrow(/non-negative/);
    expect(() => Money.ofMinor(10n, 'AED').capAllocate([Money.ofMinor(-1n, 'AED')])).toThrow(
      /non-negative/,
    );
    expect(() => Money.ofMinor(10n, 'AED').capAllocate([Money.ofMinor(1n, 'KWD')])).toThrow(
      /Currency mismatch/,
    );
  });
});

describe('Money — allocate: zero-weight behaviour', () => {
  it('a zero weight always yields a zero part; the residual lands elsewhere', () => {
    const parts = Money.ofMajor('10.01', 'AED')
      .allocate([1, 0, 1])
      .map((p) => p.toString());
    expect(parts).toEqual(['5.01 AED', '0.00 AED', '5.00 AED']);
  });
  it('a single non-zero weight collects everything', () => {
    const parts = Money.ofMajor('10.00', 'AED')
      .allocate([0, 1, 0])
      .map((p) => p.toString());
    expect(parts).toEqual(['0.00 AED', '10.00 AED', '0.00 AED']);
  });
  it('an all-zero weight set is rejected', () => {
    expect(() => Money.ofMajor('1.00', 'AED').allocate([0, 0])).toThrow(/weight total/);
  });
});

describe('moneyDtoSchema / parseMoney', () => {
  it('accepts a well-formed DTO and round-trips through parseMoney', () => {
    const dto = { amountMinor: '12345', currency: 'KWD', exponent: 3 };
    expect(moneyDtoSchema.safeParse(dto).success).toBe(true);
    expect(parseMoney(dto).equals(Money.ofMinor(12345n, 'KWD'))).toBe(true);
  });
  it('rejects a JSON-number amount, a non-integer string, an unknown currency', () => {
    expect(
      moneyDtoSchema.safeParse({ amountMinor: 12345, currency: 'KWD', exponent: 3 }).success,
    ).toBe(false);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10.5', currency: 'AED', exponent: 2 }).success,
    ).toBe(false);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '1', currency: 'ZZZ', exponent: 2 }).success,
    ).toBe(false);
  });
  it('rejects an exponent that disagrees with the currency', () => {
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '1', currency: 'AED', exponent: 3 }).success,
    ).toBe(false);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '1', currency: 'KWD', exponent: 2 }).success,
    ).toBe(false);
  });
  it('rejects an amountMinor string outside the BIGINT range', () => {
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '9223372036854775808', currency: 'AED', exponent: 2 })
        .success,
    ).toBe(false);
  });
});
