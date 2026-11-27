import { describe, expect, it } from 'vitest';
import { PALETTES, bloomSpec } from './bloom';

describe('bloomSpec — the placeholder artwork (the catalog contract has no images)', () => {
  it('is deterministic: the same id always draws the same bloom', () => {
    expect(bloomSpec('prd-red-roses')).toEqual(bloomSpec('prd-red-roses'));
  });
  it('stays inside the drawable ranges for any id, including odd ones', () => {
    for (const id of ['a', 'prd-x', 'ورد', '', 'x'.repeat(500), '🌸']) {
      const b = bloomSpec(id);
      expect(b.petals).toBeGreaterThanOrEqual(5);
      expect(b.petals).toBeLessThanOrEqual(9);
      expect(b.rotation).toBeGreaterThanOrEqual(0);
      expect(b.rotation).toBeLessThan(360);
      expect(PALETTES).toContainEqual(b.palette);
    }
  });
  it('different products do not all look the same', () => {
    const looks = new Set(
      [
        'prd-red-roses',
        'prd-spring-tulips',
        'prd-blush-peonies',
        'prd-white-lilies',
        'prd-orchid',
      ].map((id) => JSON.stringify(bloomSpec(id))),
    );
    expect(looks.size).toBeGreaterThan(2);
  });
});
