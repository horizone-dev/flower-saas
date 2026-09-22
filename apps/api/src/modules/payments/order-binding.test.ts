import { describe, expect, it } from 'vitest';
import { assertPaymentAttemptOrderBinding } from './order-binding.js';

describe('order-binding (task 3b.5 Checkpoint A — pure fingerprint+version capture gate)', () => {
  it('both fingerprint and version match: accepted', () => {
    expect(() =>
      assertPaymentAttemptOrderBinding({
        expectedFingerprint: 'fp-1',
        liveFingerprint: 'fp-1',
        expectedVersion: 3,
        liveVersion: 3,
      }),
    ).not.toThrow();
  });

  it('fingerprint mismatch (version matching) rejects', () => {
    expect(() =>
      assertPaymentAttemptOrderBinding({
        expectedFingerprint: 'fp-1',
        liveFingerprint: 'fp-2',
        expectedVersion: 3,
        liveVersion: 3,
      }),
    ).toThrow(RangeError);
  });

  it('version mismatch (fingerprint matching) rejects', () => {
    expect(() =>
      assertPaymentAttemptOrderBinding({
        expectedFingerprint: 'fp-1',
        liveFingerprint: 'fp-1',
        expectedVersion: 3,
        liveVersion: 4,
      }),
    ).toThrow(RangeError);
  });

  it('both mismatch rejects', () => {
    expect(() =>
      assertPaymentAttemptOrderBinding({
        expectedFingerprint: 'fp-1',
        liveFingerprint: 'fp-2',
        expectedVersion: 3,
        liveVersion: 4,
      }),
    ).toThrow(RangeError);
  });
});
