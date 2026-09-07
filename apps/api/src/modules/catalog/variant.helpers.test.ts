import { describe, expect, it } from 'vitest';
import {
  assertValidOptionGroupKey,
  deriveVariantName,
  resolveVariantCombination,
} from './variant.helpers.js';

const thrown = (fn: () => unknown): { code?: string; status?: number } | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as { code?: string; status?: number };
  }
};

const groups = [
  { id: 'g-colour', valueIds: new Set(['v-red', 'v-blue']) },
  { id: 'g-size', valueIds: new Set(['v-s', 'v-m']) },
];

describe('variant.helpers — resolveVariantCombination (owner L-7 / L-8)', () => {
  it('accepts a complete combination and returns an insertion-order-independent signature', () => {
    const a = resolveVariantCombination(groups, [
      { optionGroupId: 'g-colour', optionValueId: 'v-red' },
      { optionGroupId: 'g-size', optionValueId: 'v-m' },
    ]);
    const b = resolveVariantCombination(groups, [
      { optionGroupId: 'g-size', optionValueId: 'v-m' },
      { optionGroupId: 'g-colour', optionValueId: 'v-red' },
    ]);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toBe('g-colour=v-red|g-size=v-m');
  });

  it('rejects a missing group (incomplete combination)', () => {
    const e = thrown(() =>
      resolveVariantCombination(groups, [{ optionGroupId: 'g-colour', optionValueId: 'v-red' }]),
    );
    expect(e?.code).toBe('VARIANT_COMBINATION_INCOMPLETE');
    expect(e?.status).toBe(422);
  });

  it('rejects an extra group not on the product', () => {
    expect(
      thrown(() =>
        resolveVariantCombination(groups, [
          { optionGroupId: 'g-colour', optionValueId: 'v-red' },
          { optionGroupId: 'g-size', optionValueId: 'v-m' },
          { optionGroupId: 'g-style', optionValueId: 'v-x' },
        ]),
      )?.code,
    ).toBe('VARIANT_OPTION_GROUP_NOT_ON_PRODUCT');
  });

  it('rejects a duplicate group', () => {
    expect(
      thrown(() =>
        resolveVariantCombination(groups, [
          { optionGroupId: 'g-colour', optionValueId: 'v-red' },
          { optionGroupId: 'g-colour', optionValueId: 'v-blue' },
        ]),
      )?.code,
    ).toBe('DUPLICATE_VARIANT_OPTION_GROUP');
  });

  it('rejects a value that does not belong to its stated group', () => {
    expect(
      thrown(() =>
        resolveVariantCombination(groups, [
          { optionGroupId: 'g-colour', optionValueId: 'v-m' },
          { optionGroupId: 'g-size', optionValueId: 'v-m' },
        ]),
      )?.code,
    ).toBe('VARIANT_OPTION_VALUE_NOT_IN_GROUP');
  });

  it('a no-group product yields the empty signature (default variant only)', () => {
    expect(resolveVariantCombination([], []).signature).toBe('');
  });
});

describe('variant.helpers — misc', () => {
  it('assertValidOptionGroupKey enforces ^[A-Z][A-Z0-9_]{1,63}$', () => {
    expect(() => assertValidOptionGroupKey('COLOUR')).not.toThrow();
    const e = thrown(() => assertValidOptionGroupKey('lower'));
    expect(e?.code).toBe('INVALID_OPTION_GROUP_KEY');
    expect(e?.status).toBe(422);
  });

  it('deriveVariantName joins labels in group order, falls back when empty', () => {
    expect(
      deriveVariantName(
        [
          { groupSortOrder: 1, groupKey: 'COLOUR', labelEn: 'Red' },
          { groupSortOrder: 0, groupKey: 'SIZE', labelEn: 'Medium' },
        ],
        'Fallback',
      ),
    ).toBe('Medium / Red');
    expect(deriveVariantName([], 'Fallback')).toBe('Fallback');
  });
});
