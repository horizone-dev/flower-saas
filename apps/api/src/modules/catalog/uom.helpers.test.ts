import { describe, it, expect } from 'vitest';
import { effectiveConversions, buildRegistry, toUomDef } from './uom.helpers.js';

/**
 * Task 3b.3 Checkpoint B hardening (§9 F/G) — `effectiveConversions` is the
 * ONE place VARIANT-overrides-PRODUCT precedence is resolved (Task 3.6 §F);
 * `OrderRepository` reuses `loadEffectiveVariantRegistry` (which calls this
 * function unmodified) rather than re-implementing precedence — these tests
 * prove the reused primitive itself is correct, closing the gap that no
 * dedicated unit test previously existed for it.
 */
describe('@flower/catalog uom.helpers — effectiveConversions precedence (task 3.6 §F)', () => {
  const box = {
    code: 'box',
    family: 'EACH' as const,
    perBaseNum: 1n,
    perBaseDen: 1n,
    maxDecimals: 0,
  };
  const piece = {
    code: 'piece',
    family: 'COUNT' as const,
    perBaseNum: 1n,
    perBaseDen: 1n,
    maxDecimals: 0,
  };

  it('F. a VARIANT-scoped conversion overrides a PRODUCT-scoped conversion for the same fromUomCode', () => {
    const variantRows = [{ fromUomCode: 'box', toUomCode: 'piece', num: 10n, den: 1n }];
    const productRows = [{ fromUomCode: 'box', toUomCode: 'piece', num: 12n, den: 1n }];
    const eff = effectiveConversions(variantRows, productRows, 'piece');
    expect(eff).toEqual([{ from: 'box', to: 'piece', num: 10n, den: 1n }]);

    const registry = buildRegistry([toUomDef(box), toUomDef(piece)], eff);
    expect(registry.effectiveRatio('box', 'piece')).toEqual({ num: 10n, den: 1n });
  });

  it('G. a PRODUCT-scoped conversion is inherited ONLY for a fromUomCode the VARIANT does not cover, and only when it targets the variant base', () => {
    const carton = {
      code: 'carton',
      family: 'EACH' as const,
      perBaseNum: 1n,
      perBaseDen: 1n,
      maxDecimals: 0,
    };
    const variantRows = [{ fromUomCode: 'box', toUomCode: 'piece', num: 10n, den: 1n }];
    const productRows = [
      { fromUomCode: 'box', toUomCode: 'piece', num: 12n, den: 1n }, // covered by variant -> ignored
      { fromUomCode: 'carton', toUomCode: 'piece', num: 288n, den: 1n }, // not covered -> inherited
      { fromUomCode: 'carton', toUomCode: 'box', num: 24n, den: 1n }, // does not target the base -> ignored
    ];
    const eff = effectiveConversions(variantRows, productRows, 'piece');
    expect(eff).toEqual(
      expect.arrayContaining([
        { from: 'box', to: 'piece', num: 10n, den: 1n },
        { from: 'carton', to: 'piece', num: 288n, den: 1n },
      ]),
    );
    expect(eff).toHaveLength(2);

    const registry = buildRegistry([toUomDef(box), toUomDef(carton), toUomDef(piece)], eff);
    expect(registry.effectiveRatio('box', 'piece')).toEqual({ num: 10n, den: 1n }); // variant wins
    expect(registry.effectiveRatio('carton', 'piece')).toEqual({ num: 288n, den: 1n }); // product inherited
  });

  it('no VARIANT or PRODUCT rows -> empty effective set, built-in/perBase resolution still applies', () => {
    const eff = effectiveConversions([], [], 'piece');
    expect(eff).toEqual([]);
    const registry = buildRegistry([toUomDef(piece)], eff);
    expect(registry.effectiveRatio('piece', 'piece')).toEqual({ num: 1n, den: 1n });
  });
});
