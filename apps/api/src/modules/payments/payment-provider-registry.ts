import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import type { PaymentProvider } from './payment-provider.port.js';

/**
 * Task 3b.5 Checkpoint E — the smallest repository-consistent
 * `providerKey -> PaymentProvider` registry (owner §E3).
 *
 * - exact key lookup only (no prefix/fuzzy match)
 * - unknown provider fails closed (`PAYMENT_PROVIDER_NOT_REGISTERED`, 500 —
 *   this can only mean a caller reached here with a `providerKey` the
 *   provider-config resolution step should already have prevented, since
 *   that step matches against a real, ACTIVE `ProviderCredential.provider`
 *   value; a legitimately-configured provider with no registered adapter is
 *   an operator/deployment error, not a client input error)
 * - `register` throws synchronously on a duplicate key — this is called
 *   only at module-construction time (or explicitly by a test), so a
 *   duplicate fails fast at startup/construction, never silently overwrites
 * - no runtime arbitrary module loading, no client-controlled adapter class
 *   name anywhere in this file — `providerKey` is only ever used as a Map
 *   lookup key, never as a module specifier/constructor name
 * - holds no secrets — an adapter instance may internally use
 *   `SecretsService`, but this registry itself stores no credential
 *   material of any kind
 *
 * Production may register zero concrete adapters (owner §E3) — this class
 * still constructs and functions with an empty registry; `resolve` simply
 * fails closed for every `providerKey` until an operator wires a real
 * adapter for it (a decision explicitly deferred past this checkpoint).
 * Tests register deterministic fake providers via `register`.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly adapters = new Map<string, PaymentProvider>();

  register(providerKey: string, adapter: PaymentProvider): void {
    if (this.adapters.has(providerKey)) {
      throw new Error(
        `PaymentProviderRegistry: providerKey "${providerKey}" is already registered`,
      );
    }
    this.adapters.set(providerKey, adapter);
  }

  resolve(providerKey: string): PaymentProvider {
    const adapter = this.adapters.get(providerKey);
    if (!adapter) {
      throw new DomainError(
        'PAYMENT_PROVIDER_NOT_REGISTERED',
        `no PaymentProvider adapter is registered for providerKey "${providerKey}"`,
        500,
      );
    }
    return adapter;
  }
}
