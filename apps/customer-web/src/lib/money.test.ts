import { describe, expect, it } from 'vitest';
import { formatMinor } from './money';

describe('formatMinor — display only, exact integers', () => {
  it('formats 2- and 3-decimal currencies with thousands separators', () => {
    expect(formatMinor('12000', 2)).toBe('120.00');
    expect(formatMinor('5', 2)).toBe('0.05');
    expect(formatMinor('1234567', 2)).toBe('12,345.67');
    expect(formatMinor('12345', 3)).toBe('12.345');
    expect(formatMinor('0', 0)).toBe('0');
    expect(formatMinor('1500', 0)).toBe('1,500');
  });
  it('accepts a bigint and never loses precision', () => {
    expect(formatMinor(9007199254740993n, 2)).toBe('90,071,992,547,409.93');
  });
});
