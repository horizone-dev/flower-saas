import { describe, expect, it } from 'vitest';
import {
  requiresCreditGate,
  computeCreditAuthorizedFlag,
  PAYMENT_INTENTS,
  ALWAYS_CREATES_CUSTOMER_AR_WHEN_LINKED,
} from './payment-intent.js';

describe('PAYMENT_INTENTS (3b.6 Checkpoint A)', () => {
  it('is exactly two values, no CREDIT tender, no third value', () => {
    expect(PAYMENT_INTENTS).toEqual(['PAY_NOW', 'ON_CREDIT']);
    expect(PAYMENT_INTENTS).not.toContain('CREDIT');
  });
});

describe('requiresCreditGate (3b.6 Checkpoint A)', () => {
  it('PAY_NOW never requires the credit gate', () => {
    expect(requiresCreditGate('PAY_NOW')).toBe(false);
  });

  it('ON_CREDIT always requires the credit gate', () => {
    expect(requiresCreditGate('ON_CREDIT')).toBe(true);
  });
});

describe('computeCreditAuthorizedFlag (3b.6 Checkpoint A)', () => {
  it('PAY_NOW -> always false, regardless of the (ignored) gate result', () => {
    expect(computeCreditAuthorizedFlag('PAY_NOW', true)).toBe(false);
    expect(computeCreditAuthorizedFlag('PAY_NOW', false)).toBe(false);
  });

  it('ON_CREDIT -> true only when the gate allowed it', () => {
    expect(computeCreditAuthorizedFlag('ON_CREDIT', true)).toBe(true);
    expect(computeCreditAuthorizedFlag('ON_CREDIT', false)).toBe(false);
  });
});

describe('AR creation is intent-independent (3b.6 architecture-freeze correction)', () => {
  it('both PAY_NOW and ON_CREDIT always create customer AR when the Invoice is customer-linked', () => {
    expect(ALWAYS_CREATES_CUSTOMER_AR_WHEN_LINKED).toBe(true);
  });
});
