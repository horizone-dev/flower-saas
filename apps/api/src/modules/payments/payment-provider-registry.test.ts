import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import type { PaymentProvider } from './payment-provider.port.js';

function stubAdapter(): PaymentProvider {
  return {
    createIntent: async () => ({ state: 'PENDING' }),
    authorize: async () => ({}),
    capture: async () => ({}),
    refund: async () => ({}),
    getStatus: async () => ({}),
    verifyWebhook: async () => ({ providerEventId: 'unused', eventType: 'unused' }),
  };
}

describe('PaymentProviderRegistry (task 3b.5 Checkpoint E, unit)', () => {
  it('resolves an adapter registered under an exact key', () => {
    const registry = new PaymentProviderRegistry();
    const adapter = stubAdapter();
    registry.register('fake', adapter);
    expect(registry.resolve('fake')).toBe(adapter);
  });

  it('fails closed for an unknown providerKey', () => {
    const registry = new PaymentProviderRegistry();
    expect(() => registry.resolve('unknown')).toThrow(DomainError);
    try {
      registry.resolve('unknown');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('PAYMENT_PROVIDER_NOT_REGISTERED');
      expect((err as DomainError).status).toBe(500);
    }
  });

  it('fails fast on a duplicate providerKey registration', () => {
    const registry = new PaymentProviderRegistry();
    registry.register('fake', stubAdapter());
    expect(() => registry.register('fake', stubAdapter())).toThrow(/already registered/);
  });

  it('never invokes an unregistered adapter — production may start with zero adapters', () => {
    const registry = new PaymentProviderRegistry();
    expect(() => registry.resolve('tap')).toThrow(DomainError);
  });

  it('an empty-key lookup is never confused with a registered key', () => {
    const registry = new PaymentProviderRegistry();
    registry.register('tap', stubAdapter());
    expect(() => registry.resolve('')).toThrow(DomainError);
  });
});
