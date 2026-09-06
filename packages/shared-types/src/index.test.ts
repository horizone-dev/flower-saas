import { describe, it, expect } from 'vitest';
import {
  moneyDtoSchema,
  quantityDtoSchema,
  apiErrorSchema,
  readinessResponseSchema,
  CATALOG_CAPABILITY_KEYS,
  capabilityKeySchema,
  isCapabilityKey,
  CATALOG_CAPABILITY_CONFIG_SCHEMAS,
  checkCapabilityConfig,
  CAPABILITY_REQUIRED_ENTITLEMENT,
  ENTITLEMENT_MODULES,
} from './index.js';

describe('@flower/shared-types schemas', () => {
  it('re-exports the authoritative Money DTO schema (currency + range aware)', () => {
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10500', currency: 'KWD', exponent: 3 }).success,
    ).toBe(true);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10.5', currency: 'AED', exponent: 2 }).success,
    ).toBe(false);
    // exponent must match the currency; 'AED' is exponent 2
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '1', currency: 'AED', exponent: 5 }).success,
    ).toBe(false);
  });

  it('re-exports the Quantity DTO schema', () => {
    expect(quantityDtoSchema.safeParse({ amount: '1.5000' }).success).toBe(true);
    expect(quantityDtoSchema.safeParse({ amount: 1.5 }).success).toBe(false);
  });

  it('validates the API error envelope', () => {
    const parsed = apiErrorSchema.safeParse({
      error: { code: 'ORDER_NOT_FOUND', message: 'Not found', correlationId: '01J' },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a readiness response', () => {
    expect(
      readinessResponseSchema.safeParse({
        status: 'ok',
        checks: { db: 'ok', redis: 'ok', storage: 'ok', migrations: 'ok' },
      }).success,
    ).toBe(true);
  });
});

describe('@flower/shared-types — catalog capabilities (task 3.1)', () => {
  it('the closed registry has exactly the frozen 16 keys, deduped', () => {
    expect(CATALOG_CAPABILITY_KEYS).toHaveLength(16);
    expect(new Set(CATALOG_CAPABILITY_KEYS).size).toBe(16);
    expect([...CATALOG_CAPABILITY_KEYS].sort()).toEqual(
      [
        'branch_pricing',
        'channel.customer_web',
        'channel.pos',
        'customer_ordering',
        'delivery',
        'identifiers.barcode_qr',
        'inventory.expiry',
        'inventory.lot_batch',
        'inventory.tracked',
        'multi_uom',
        'production',
        'purchasing',
        'strategy.bom',
        'strategy.custom',
        'strategy.stocked',
        'variants',
      ].sort(),
    );
  });

  it('does NOT contain template/provenance concepts as capability keys', () => {
    for (const k of CATALOG_CAPABILITY_KEYS) {
      expect(k.startsWith('category_template')).toBe(false);
      expect(k.startsWith('attribute_template')).toBe(false);
      expect(k.startsWith('uom_template')).toBe(false);
    }
  });

  it('capabilityKeySchema + isCapabilityKey accept only registry keys', () => {
    expect(capabilityKeySchema.safeParse('multi_uom').success).toBe(true);
    expect(capabilityKeySchema.safeParse('category_template.flowers').success).toBe(false);
    expect(isCapabilityKey('strategy.bom')).toBe(true);
    expect(isCapabilityKey('nonsense')).toBe(false);
  });

  it('the config-schema registry is EMPTY in task 3.1 (spec §E)', () => {
    expect(Object.keys(CATALOG_CAPABILITY_CONFIG_SCHEMAS)).toHaveLength(0);
  });

  it('checkCapabilityConfig: null OK; a non-null config for an unregistered key is rejected', () => {
    expect(checkCapabilityConfig('multi_uom', null)).toEqual({ ok: true });
    expect(checkCapabilityConfig('multi_uom', undefined)).toEqual({ ok: true });
    const bad = checkCapabilityConfig('inventory.expiry', { policy: 'FEFO' });
    expect(bad).toMatchObject({ ok: false, code: 'CAPABILITY_CONFIG_NOT_SUPPORTED' });
  });

  it('every required-entitlement value is a real ENTITLEMENT_MODULE, and custom_composition exists', () => {
    expect(ENTITLEMENT_MODULES).toContain('custom_composition');
    const mods = new Set<string>(ENTITLEMENT_MODULES);
    for (const [cap, mod] of Object.entries(CAPABILITY_REQUIRED_ENTITLEMENT)) {
      expect(isCapabilityKey(cap)).toBe(true);
      expect(mods.has(mod as string), `${cap} -> ${mod}`).toBe(true);
    }
    expect(CAPABILITY_REQUIRED_ENTITLEMENT['strategy.custom']).toBe('custom_composition');
    expect(CAPABILITY_REQUIRED_ENTITLEMENT['strategy.stocked']).toBeUndefined();
  });
});
