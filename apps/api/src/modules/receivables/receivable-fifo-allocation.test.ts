import { describe, expect, it } from 'vitest';
import { allocateFifo, type OpenReceivable } from './receivable-fifo-allocation.js';

function receivable(id: string, createdAt: string, outstandingMinor: bigint): OpenReceivable {
  return { id, createdAt: new Date(createdAt), outstandingMinor };
}

describe('allocateFifo (3b.6 Checkpoint A)', () => {
  it('receipt 500 exactly covers A(300) + B(200) -> full allocation, zero remainder', () => {
    const A = receivable('A', '2026-01-01T00:00:00Z', 300n);
    const B = receivable('B', '2026-01-02T00:00:00Z', 200n);
    const result = allocateFifo(500n, [B, A]); // deliberately unordered input
    expect(result).toEqual({
      allocations: [
        { receivableId: 'A', amountMinor: 300n },
        { receivableId: 'B', amountMinor: 200n },
      ],
      unallocatedAmountMinor: 0n,
    });
  });

  it('receipt 400 partially covers B -> A full, B partial, zero remainder', () => {
    const A = receivable('A', '2026-01-01T00:00:00Z', 300n);
    const B = receivable('B', '2026-01-02T00:00:00Z', 200n);
    const result = allocateFifo(400n, [A, B]);
    expect(result).toEqual({
      allocations: [
        { receivableId: 'A', amountMinor: 300n },
        { receivableId: 'B', amountMinor: 100n },
      ],
      unallocatedAmountMinor: 0n,
    });
  });

  it('receipt 700 exceeds total open (500) -> both fully allocated, 200 remainder', () => {
    const A = receivable('A', '2026-01-01T00:00:00Z', 300n);
    const B = receivable('B', '2026-01-02T00:00:00Z', 200n);
    const result = allocateFifo(700n, [A, B]);
    expect(result).toEqual({
      allocations: [
        { receivableId: 'A', amountMinor: 300n },
        { receivableId: 'B', amountMinor: 200n },
      ],
      unallocatedAmountMinor: 200n,
    });
  });

  it('same createdAt timestamp: stable id tie-break determines order', () => {
    const sameTime = '2026-01-01T00:00:00Z';
    const B = receivable('B', sameTime, 100n);
    const A = receivable('A', sameTime, 100n);
    // 'A' < 'B' lexically -> A must be consumed first regardless of input order
    const result = allocateFifo(100n, [B, A]);
    expect(result.allocations).toEqual([{ receivableId: 'A', amountMinor: 100n }]);
    expect(result.unallocatedAmountMinor).toBe(0n);
  });

  it('a zero-outstanding receivable is skipped, never produces a zero-amount allocation', () => {
    const zero = receivable('Z', '2026-01-01T00:00:00Z', 0n);
    const A = receivable('A', '2026-01-02T00:00:00Z', 50n);
    const result = allocateFifo(50n, [zero, A]);
    expect(result.allocations).toEqual([{ receivableId: 'A', amountMinor: 50n }]);
  });

  it('no open receivables -> the full amount remains unallocated', () => {
    const result = allocateFifo(100n, []);
    expect(result).toEqual({ allocations: [], unallocatedAmountMinor: 100n });
  });

  it('zero receipt amount -> no allocations, zero remainder', () => {
    const A = receivable('A', '2026-01-01T00:00:00Z', 100n);
    const result = allocateFifo(0n, [A]);
    expect(result).toEqual({ allocations: [], unallocatedAmountMinor: 0n });
  });

  it('rejects a negative receipt amount', () => {
    expect(() => allocateFifo(-1n, [])).toThrow(RangeError);
  });

  it('rejects a negative outstanding amount on an input receivable', () => {
    const bad = receivable('A', '2026-01-01T00:00:00Z', -1n);
    expect(() => allocateFifo(100n, [bad])).toThrow(RangeError);
  });

  it('does not mutate the input array or its elements', () => {
    const A = receivable('A', '2026-01-02T00:00:00Z', 300n);
    const B = receivable('B', '2026-01-01T00:00:00Z', 200n);
    const input = [A, B];
    const inputCopy = [...input];
    allocateFifo(250n, input);
    expect(input).toEqual(inputCopy);
    expect(input[0]).toBe(A); // same object references, same order
    expect(input[1]).toBe(B);
  });
});
