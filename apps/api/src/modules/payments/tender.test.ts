import { describe, expect, it } from 'vitest';
import { isProviderBackedTender, isTenderMethod, TENDER_METHODS } from './tender.js';

describe('tender (task 3b.5 Checkpoint A — pure vocabulary)', () => {
  it('accepts exactly the 5 frozen tender methods', () => {
    expect(TENDER_METHODS).toEqual([
      'CASH',
      'CARD_TERMINAL',
      'BANK_TRANSFER',
      'ONLINE_GATEWAY',
      'OTHER_MANUAL',
    ]);
    for (const m of TENDER_METHODS) {
      expect(isTenderMethod(m)).toBe(true);
    }
  });

  it('CREDIT is not a valid tender method', () => {
    expect(isTenderMethod('CREDIT')).toBe(false);
  });

  it('no forbidden tender concept is present', () => {
    for (const forbidden of [
      'CUSTOMER_CREDIT',
      'ADVANCE',
      'WALLET',
      'STORE_CREDIT',
      'LOYALTY',
      'REFUND',
    ]) {
      expect(isTenderMethod(forbidden)).toBe(false);
    }
  });

  describe('isProviderBackedTender', () => {
    it('ONLINE_GATEWAY is always provider-backed', () => {
      expect(isProviderBackedTender('ONLINE_GATEWAY', null)).toBe(true);
      expect(isProviderBackedTender('ONLINE_GATEWAY', 'cred-1')).toBe(true);
    });

    it('CARD_TERMINAL is provider-backed only when a providerCredentialId is present', () => {
      expect(isProviderBackedTender('CARD_TERMINAL', 'cred-1')).toBe(true);
      expect(isProviderBackedTender('CARD_TERMINAL', null)).toBe(false);
    });

    it('CASH / BANK_TRANSFER / OTHER_MANUAL are always local, regardless of a stray credential id', () => {
      expect(isProviderBackedTender('CASH', null)).toBe(false);
      expect(isProviderBackedTender('BANK_TRANSFER', null)).toBe(false);
      expect(isProviderBackedTender('OTHER_MANUAL', null)).toBe(false);
      expect(isProviderBackedTender('CASH', 'cred-1')).toBe(false);
    });
  });
});
