import { describe, expect, it } from 'vitest';
import {
  computeAvailableToCollect,
  computeAvailableToCollectFromOutstanding,
} from './available-to-collect.js';

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

describe('available-to-collect over the CANONICAL outstanding (task 3b.8 Integration Closure, F1)', () => {
  it('outstanding 100, nothing reserved -> 100', () => {
    expect(computeAvailableToCollectFromOutstanding(100n, 0n)).toBe(100n);
  });

  it('outstanding 100, reserved 60 -> 40', () => {
    expect(computeAvailableToCollectFromOutstanding(100n, 60n)).toBe(40n);
  });

  it('outstanding fully reserved -> 0', () => {
    expect(computeAvailableToCollectFromOutstanding(100n, 100n)).toBe(0n);
  });

  it('a fully closed receivable (outstanding 0) has nothing to collect', () => {
    expect(computeAvailableToCollectFromOutstanding(0n, 0n)).toBe(0n);
  });

  it('FLOORS at 0 — never throws — when a reservation made BEFORE a CreditNote / advance application now exceeds the outstanding', () => {
    expect(computeAvailableToCollectFromOutstanding(40n, 60n)).toBe(0n);
    expect(computeAvailableToCollectFromOutstanding(0n, 60n)).toBe(0n);
  });

  it('a NEGATIVE (corrupted, over-covered) outstanding fails closed to 0 — nothing is ever collectable against it', () => {
    expect(computeAvailableToCollectFromOutstanding(-1n, 0n)).toBe(0n);
    expect(computeAvailableToCollectFromOutstanding(-500n, 20n)).toBe(0n);
  });

  it('a negative reservation is a programming error and rejects', () => {
    expect(() => computeAvailableToCollectFromOutstanding(100n, -1n)).toThrow(RangeError);
  });

  it('large BigInt values are safe (no precision loss)', () => {
    const huge = 9_223_372_036_854_775_000n;
    expect(computeAvailableToCollectFromOutstanding(huge, huge - 1n)).toBe(1n);
    expect(computeAvailableToCollectFromOutstanding(huge, huge)).toBe(0n);
  });

  it('agrees EXACTLY with the frozen 3b.5 formula wherever that formula is defined (no CreditNote / advance application)', () => {
    for (const total of [0n, 1n, 100n, 2_000n]) {
      for (const confirmed of [0n, 1n, 40n, 100n, 2_000n]) {
        for (const reserved of [0n, 1n, 60n, 100n, 2_000n]) {
          if (confirmed + reserved > total) continue; // the frozen formula throws here
          expect(computeAvailableToCollectFromOutstanding(total - confirmed, reserved)).toBe(
            computeAvailableToCollect(total, confirmed, reserved),
          );
        }
      }
    }
  });
});
