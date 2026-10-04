import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@flower/permissions';
import {
  SALE_ADVANCE_APPLICATION_AUTHORITY,
  SALE_CREDIT_OVERRIDE_AUTHORITY,
  SALE_PAYMENT_COLLECTION_AUTHORITY,
  saleAuthorityRequirements,
} from './sale-authority.js';

describe('saleAuthorityRequirements (task 3b.9 Checkpoint D — pure authority metadata)', () => {
  it('every key is an ALREADY-REGISTERED permission — Checkpoint D invents none', () => {
    const registered = new Set<string>(ALL_PERMISSIONS as readonly string[]);
    for (const key of [
      SALE_PAYMENT_COLLECTION_AUTHORITY,
      SALE_ADVANCE_APPLICATION_AUTHORITY,
      SALE_CREDIT_OVERRIDE_AUTHORITY,
    ]) {
      expect(registered.has(key), key).toBe(true);
    }
  });

  it('a tender-only sale needs payment collection and nothing else', () => {
    expect(
      saleAuthorityRequirements({ tenderCount: 2, advanceCount: 0, creditOverrideUsed: false }),
    ).toEqual({
      paymentCollection: true,
      advanceApplication: false,
      creditOverride: false,
      permissionKeys: ['payments:collect'],
    });
  });

  it('an ADVANCE-ONLY sale needs receivables:advance:apply and NEVER inherits payments:collect', () => {
    const r = saleAuthorityRequirements({
      tenderCount: 0,
      advanceCount: 1,
      creditOverrideUsed: false,
    });
    expect(r.paymentCollection).toBe(false);
    expect(r.permissionKeys).toEqual(['receivables:advance:apply']);
    expect(r.permissionKeys).not.toContain('payments:collect');
  });

  it('tender + advance + override reports all three, sorted, once each', () => {
    const r = saleAuthorityRequirements({
      tenderCount: 3,
      advanceCount: 2,
      creditOverrideUsed: true,
    });
    expect(r.permissionKeys).toEqual([
      'customers:credit:override',
      'payments:collect',
      'receivables:advance:apply',
    ]);
  });

  it('a pure credit sale (no tender, no advance, no override) needs none of them', () => {
    expect(
      saleAuthorityRequirements({ tenderCount: 0, advanceCount: 0, creditOverrideUsed: false })
        .permissionKeys,
    ).toEqual([]);
  });

  it('the result is frozen and a malformed count fails closed', () => {
    const r = saleAuthorityRequirements({
      tenderCount: 1,
      advanceCount: 1,
      creditOverrideUsed: false,
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.permissionKeys)).toBe(true);
    expect(() =>
      saleAuthorityRequirements({ tenderCount: -1, advanceCount: 0, creditOverrideUsed: false }),
    ).toThrow(RangeError);
    expect(() =>
      saleAuthorityRequirements({ tenderCount: 1.5, advanceCount: 0, creditOverrideUsed: false }),
    ).toThrow(RangeError);
    expect(() =>
      saleAuthorityRequirements({
        tenderCount: 0,
        advanceCount: Number.NaN,
        creditOverrideUsed: false,
      }),
    ).toThrow(RangeError);
  });
});
