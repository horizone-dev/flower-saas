import { OPTION_GROUP_KEY_RE, variantOptionSignature } from '@flower/shared-types';
import { DomainError } from '../../common/errors/domain-error.js';

/** One option selection sent for a variant — an id pair, never a label. */
export interface VariantOptionInput {
  optionGroupId: string;
  optionValueId: string;
}

/** `^[A-Z][A-Z0-9_]{1,63}$` — a tenant-defined, immutable option-group key. */
export function assertValidOptionGroupKey(key: string): void {
  if (!OPTION_GROUP_KEY_RE.test(key)) {
    throw new DomainError(
      'INVALID_OPTION_GROUP_KEY',
      'option group key must match ^[A-Z][A-Z0-9_]{1,63}$',
      422,
      [{ field: 'key', issue: 'invalid format' }],
    );
  }
}

/**
 * Validate a variant's option selections against the product's option groups
 * (owner L-8): exactly one value from EVERY group, no missing group, no extra
 * group, no duplicate group, and each value must belong to its stated group.
 * Returns the deterministic canonical signature (owner L-7) — server-derived,
 * never client-supplied.
 *
 * `groups` — the product's option groups (id + the set of valid value ids).
 * `selections` — the client input `{ optionGroupId, optionValueId }[]`.
 */
export function resolveVariantCombination(
  groups: { id: string; valueIds: ReadonlySet<string> }[],
  selections: readonly VariantOptionInput[],
): { signature: string; pairs: VariantOptionInput[] } {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  for (const sel of selections) {
    if (seen.has(sel.optionGroupId)) {
      throw new DomainError(
        'DUPLICATE_VARIANT_OPTION_GROUP',
        `option group ${sel.optionGroupId} is selected more than once`,
        422,
      );
    }
    seen.add(sel.optionGroupId);
    const group = groupById.get(sel.optionGroupId);
    if (!group) {
      throw new DomainError(
        'VARIANT_OPTION_GROUP_NOT_ON_PRODUCT',
        `option group ${sel.optionGroupId} is not an option group of this product`,
        422,
      );
    }
    if (!group.valueIds.has(sel.optionValueId)) {
      throw new DomainError(
        'VARIANT_OPTION_VALUE_NOT_IN_GROUP',
        `option value ${sel.optionValueId} does not belong to option group ${sel.optionGroupId}`,
        422,
      );
    }
  }
  const missing = groups.filter((g) => !seen.has(g.id)).map((g) => g.id);
  if (missing.length > 0) {
    throw new DomainError(
      'VARIANT_COMBINATION_INCOMPLETE',
      `every option group must be selected exactly once — missing: ${missing.join(', ')}`,
      422,
    );
  }
  const pairs = selections.map((s) => ({
    optionGroupId: s.optionGroupId,
    optionValueId: s.optionValueId,
  }));
  return { signature: variantOptionSignature(pairs), pairs };
}

/** A denormalised display label for an explicit variant — the option-value
 *  labels in group order, joined with " / ". Falls back to `fallback` when empty. */
export function deriveVariantName(
  labelledSelections: { groupSortOrder: number; groupKey: string; labelEn: string }[],
  fallback: string,
): string {
  if (labelledSelections.length === 0) return fallback;
  return [...labelledSelections]
    .sort((a, b) => a.groupSortOrder - b.groupSortOrder || a.groupKey.localeCompare(b.groupKey))
    .map((s) => s.labelEn)
    .join(' / ');
}
