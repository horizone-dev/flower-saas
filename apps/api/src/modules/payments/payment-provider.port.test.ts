import { describe, expect, it } from 'vitest';
import {
  isValidPaymentProviderInitiationState,
  PAYMENT_PROVIDER_INITIATION_STATES,
} from './payment-provider.port.js';

describe('payment-provider.port (task 3b.5 Checkpoint E, unit)', () => {
  it('accepts exactly the 5 allowed initiation states', () => {
    for (const s of PAYMENT_PROVIDER_INITIATION_STATES) {
      expect(isValidPaymentProviderInitiationState(s)).toBe(true);
    }
    expect(PAYMENT_PROVIDER_INITIATION_STATES).toEqual([
      'PENDING',
      'REQUIRES_ACTION',
      'AUTHORIZED',
      'FAILED',
      'CANCELED',
    ]);
  });

  it('rejects CAPTURED — the runtime guard a malformed adapter cannot bypass (owner §E12)', () => {
    expect(isValidPaymentProviderInitiationState('CAPTURED')).toBe(false);
  });

  it('rejects the reserved-but-unreachable refund states', () => {
    expect(isValidPaymentProviderInitiationState('PARTIALLY_REFUNDED')).toBe(false);
    expect(isValidPaymentProviderInitiationState('REFUNDED')).toBe(false);
  });

  it('rejects arbitrary/garbage/non-string values', () => {
    expect(isValidPaymentProviderInitiationState('captured')).toBe(false);
    expect(isValidPaymentProviderInitiationState('')).toBe(false);
    expect(isValidPaymentProviderInitiationState(null)).toBe(false);
    expect(isValidPaymentProviderInitiationState(undefined)).toBe(false);
    expect(isValidPaymentProviderInitiationState(42)).toBe(false);
    expect(isValidPaymentProviderInitiationState({})).toBe(false);
  });
});
