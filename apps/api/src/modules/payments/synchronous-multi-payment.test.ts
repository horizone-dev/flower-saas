import { describe, expect, it } from 'vitest';
import {
  validateSynchronousMultiPayment,
  type SynchronousTenderComponent,
} from './synchronous-multi-payment.js';

const AED_EXPONENT = 2;

function component(
  method: SynchronousTenderComponent['method'],
  amountMinor: bigint,
  providerCredentialId: string | null = null,
  currencyCode = 'AED',
  currencyExponent = AED_EXPONENT,
): SynchronousTenderComponent {
  return { method, amountMinor, providerCredentialId, currencyCode, currencyExponent };
}

describe('synchronous-multi-payment (task 3b.5 Checkpoint A — pure atomic-tender validation)', () => {
  it('one tender: accepted', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', 100n)],
      }),
    ).not.toThrow();
  });

  it('multiple tenders summing exactly: accepted (Invoice 175 example)', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 175n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [
          component('CASH', 50n),
          component('CARD_TERMINAL', 100n), // no providerCredentialId -> local
          component('BANK_TRANSFER', 25n),
        ],
      }),
    ).not.toThrow();
  });

  it('sum mismatch rejects', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 175n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', 50n), component('BANK_TRANSFER', 100n)],
      }),
    ).toThrow(RangeError);
  });

  it('zero-amount component rejects', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', 0n), component('CASH', 100n)],
      }),
    ).toThrow(RangeError);
  });

  it('negative-amount component rejects', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', -100n)],
      }),
    ).toThrow(RangeError);
  });

  it('currency mismatch component rejects', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', 100n, null, 'SAR', 2)],
      }),
    ).toThrow(RangeError);
  });

  it('async ONLINE_GATEWAY component rejects', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('ONLINE_GATEWAY', 100n, 'cred-1')],
      }),
    ).toThrow(RangeError);
  });

  it('provider-backed CARD_TERMINAL component rejects', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CARD_TERMINAL', 100n, 'cred-1')],
      }),
    ).toThrow(RangeError);
  });

  it('manual (non-provider) CARD_TERMINAL component is accepted', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CARD_TERMINAL', 100n, null)],
      }),
    ).not.toThrow();
  });

  it('large BigInt component sums are safe', () => {
    const huge = 9_000_000_000_000n;
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: huge,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', huge - 1n), component('CASH', 1n)],
      }),
    ).not.toThrow();
  });

  it('respects an authoritative availableToCollect when provided', () => {
    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', 100n)],
        availableToCollectMinor: 99n,
      }),
    ).toThrow(RangeError);

    expect(() =>
      validateSynchronousMultiPayment({
        intendedPaymentAmountMinor: 100n,
        invoiceCurrencyCode: 'AED',
        invoiceCurrencyExponent: AED_EXPONENT,
        components: [component('CASH', 100n)],
        availableToCollectMinor: 100n,
      }),
    ).not.toThrow();
  });
});
