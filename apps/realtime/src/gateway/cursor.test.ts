import { describe, it, expect } from 'vitest';
import { isValidStreamId, compareStreamIds } from './cursor.js';

describe('isValidStreamId', () => {
  it('accepts well-formed "<ms>-<seq>" ids', () => {
    expect(isValidStreamId('0-0')).toBe(true);
    expect(isValidStreamId('1788553807267-0')).toBe(true);
    expect(isValidStreamId('1788553807267-12')).toBe(true);
  });

  it('rejects malformed cursors (CURSOR RULE #4)', () => {
    expect(isValidStreamId('')).toBe(false);
    expect(isValidStreamId('not-a-cursor')).toBe(false);
    expect(isValidStreamId('123')).toBe(false);
    expect(isValidStreamId('123-')).toBe(false);
    expect(isValidStreamId('-123')).toBe(false);
    expect(isValidStreamId('123-45-67')).toBe(false);
    expect(isValidStreamId('12.5-0')).toBe(false);
    expect(isValidStreamId('1-0; DROP TABLE outbox; --')).toBe(false);
  });
});

describe('compareStreamIds', () => {
  it('orders by millisecond part first', () => {
    expect(compareStreamIds('100-0', '200-0')).toBe(-1);
    expect(compareStreamIds('200-0', '100-0')).toBe(1);
  });

  it('orders by sequence part when the millisecond part ties', () => {
    expect(compareStreamIds('100-0', '100-1')).toBe(-1);
    expect(compareStreamIds('100-5', '100-2')).toBe(1);
  });

  it('is 0 for identical ids', () => {
    expect(compareStreamIds('100-5', '100-5')).toBe(0);
  });

  it('throws on a malformed id rather than guessing', () => {
    expect(() => compareStreamIds('garbage', '100-0')).toThrow();
    expect(() => compareStreamIds('100-0', 'garbage')).toThrow();
  });
});
