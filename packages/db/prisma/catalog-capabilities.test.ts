import { describe, it, expect } from 'vitest';
import { CATALOG_CAPABILITY_KEYS, type CapabilityKey } from '@flower/shared-types';
import {
  BUSINESS_TYPE_TEMPLATES,
  BUSINESS_TYPE_BASELINE,
  BUSINESS_TYPE_TEMPLATE_VERSION,
} from './catalog-capabilities.js';

const byKey = Object.fromEntries(BUSINESS_TYPE_TEMPLATES.map((t) => [t.key, t]));
const caps = (key: string): Set<string> => new Set(byKey[key]?.capabilities ?? []);

describe('Business-Type preset templates (task 3.1 — spec §B / §C)', () => {
  it('seeds exactly the 35 curated presets, Jewellery + Mobile excluded', () => {
    expect(BUSINESS_TYPE_TEMPLATES).toHaveLength(35);
    const keys = BUSINESS_TYPE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(35);
    expect(keys).toContain('CUSTOM');
    expect(keys.some((k) => /JEWEL|JEWELLERY|ACCESSOR/i.test(k))).toBe(false);
    expect(keys.some((k) => /MOBILE|PHONE/i.test(k))).toBe(false);
    expect(BUSINESS_TYPE_TEMPLATE_VERSION).toBe(1);
  });

  it('every template capability belongs to the closed 16-key registry', () => {
    const known = new Set<string>(CATALOG_CAPABILITY_KEYS);
    for (const t of BUSINESS_TYPE_TEMPLATES) {
      for (const c of t.capabilities) expect(known.has(c), `${t.key}: ${c}`).toBe(true);
      // config is never present in the data — it is written as null (spec §E)
      expect(new Set(t.capabilities).size).toBe(t.capabilities.length); // no dupes
    }
  });

  it('CUSTOM is a normal row with the exact 3-key minimal set (spec §C.2) — no baseline', () => {
    expect([...caps('CUSTOM')].sort()).toEqual(
      ['branch_pricing', 'channel.pos', 'strategy.stocked'].sort(),
    );
    // CUSTOM has no name/shape that marks it special beyond its key
    expect(byKey['CUSTOM']?.nameEn).toBeTruthy();
  });

  it('every non-CUSTOM preset is a superset of the 8-key baseline (spec §C.1)', () => {
    for (const t of BUSINESS_TYPE_TEMPLATES) {
      if (t.key === 'CUSTOM') continue;
      for (const b of BUSINESS_TYPE_BASELINE) {
        expect(caps(t.key).has(b), `${t.key} missing baseline ${b}`).toBe(true);
      }
    }
    expect([...BUSINESS_TYPE_BASELINE].sort()).toEqual(
      [
        'branch_pricing',
        'channel.pos',
        'identifiers.barcode_qr',
        'inventory.tracked',
        'multi_uom',
        'purchasing',
        'strategy.stocked',
        'variants',
      ].sort(),
    );
  });

  it('the frozen owner adjustments (spec §5) are applied exactly', () => {
    // PERFUME_ATTAR / CANDLE_HOME_FRAGRANCE: + strategy.bom + production
    expect(caps('PERFUME_ATTAR').has('strategy.bom')).toBe(true);
    expect(caps('PERFUME_ATTAR').has('production')).toBe(true);
    expect(caps('CANDLE_HOME_FRAGRANCE').has('strategy.bom')).toBe(true);
    expect(caps('CANDLE_HOME_FRAGRANCE').has('production')).toBe(true);
    // PLANT_NURSERY: + strategy.custom (not strategy.bom)
    expect(caps('PLANT_NURSERY').has('strategy.custom')).toBe(true);
    expect(caps('PLANT_NURSERY').has('strategy.bom')).toBe(false);
    // CLEANING_SUPPLIES: + strategy.bom + production + inventory.expiry
    expect(caps('CLEANING_SUPPLIES').has('strategy.bom')).toBe(true);
    expect(caps('CLEANING_SUPPLIES').has('production')).toBe(true);
    expect(caps('CLEANING_SUPPLIES').has('inventory.expiry')).toBe(true);
    // MULTI_CATEGORY_RETAIL: deliberately NOT bom / custom
    expect(caps('MULTI_CATEGORY_RETAIL').has('strategy.bom')).toBe(false);
    expect(caps('MULTI_CATEGORY_RETAIL').has('strategy.custom')).toBe(false);
    expect(caps('MULTI_CATEGORY_RETAIL').has('inventory.lot_batch')).toBe(true);
    expect(caps('MULTI_CATEGORY_RETAIL').has('inventory.expiry')).toBe(true);
  });

  it('B2B / trade presets ship channel.customer_web + customer_ordering OFF (spec §C.4 / R-2)', () => {
    for (const key of [
      'WHOLESALE_DISTRIBUTION',
      'ELECTRICAL_PLUMBING',
      'BUILDING_MATERIALS',
      'PACKAGING_DISPOSABLES',
    ]) {
      expect(caps(key).has('channel.customer_web'), `${key}`).toBe(false);
      expect(caps(key).has('customer_ordering'), `${key}`).toBe(false);
      expect(caps(key).has('delivery'), `${key}`).toBe(true);
    }
  });

  it('a full resolved example matches the spec table verbatim (FLOWER_FLORIST)', () => {
    const expected: CapabilityKey[] = [
      ...BUSINESS_TYPE_BASELINE,
      'strategy.bom',
      'strategy.custom',
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ];
    expect([...caps('FLOWER_FLORIST')].sort()).toEqual([...new Set(expected)].sort());
  });
});
