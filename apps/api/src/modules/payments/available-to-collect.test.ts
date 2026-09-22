import { describe, expect, it } from 'vitest';
import { computeAvailableToCollect } from './available-to-collect.js';

describe('available-to-collect (task 3b.5 Checkpoint A — pure exact-BigInt math)', () => {
  it('100 - 0 - 0 = 100', () => {
    expect(computeAvailableToCollect(100n, 0n, 0n)).toBe(100n);
  });

  it('100 - 40 - 0 = 60', () => {
    expect(computeAvailableToCollect(100n, 40n, 0n)).toBe(60n);
  });

  it('100 - 0 - 60 = 40', () => {
    expect(computeAvailableToCollect(100n, 0n, 60n)).toBe(40n);
  });

  it('100 - 40 - 60 = 0', () => {
    expect(computeAvailableToCollect(100n, 40n, 60n)).toBe(0n);
  });

  it('over-reserved (confirmed + reserved > total) rejects', () => {
    expect(() => computeAvailableToCollect(100n, 40n, 61n)).toThrow(RangeError);
    expect(() => computeAvailableToCollect(100n, 101n, 0n)).toThrow(RangeError);
  });

  it('negative inputs reject', () => {
    expect(() => computeAvailableToCollect(-1n, 0n, 0n)).toThrow(RangeError);
    expect(() => computeAvailableToCollect(100n, -1n, 0n)).toThrow(RangeError);
    expect(() => computeAvailableToCollect(100n, 0n, -1n)).toThrow(RangeError);
  });

  it('large BigInt values are safe (no precision loss)', () => {
    const huge = 9_223_372_036_854_775_000n;
    expect(computeAvailableToCollect(huge, huge - 1n, 1n)).toBe(0n);
  });
});
