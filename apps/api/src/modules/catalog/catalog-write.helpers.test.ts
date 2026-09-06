import { describe, it, expect } from 'vitest';
import {
  assertUuid,
  assertValidProductTypeKey,
  parseIfMatch,
  requireIfMatch,
  resolveSlug,
  slugify,
} from './catalog-write.helpers.js';

/** Run `fn`, return the thrown value (or `undefined` if it didn't throw). */
function thrown(fn: () => unknown): { code?: string; status?: number } | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as { code?: string; status?: number };
  }
}

describe('catalog write helpers', () => {
  it('slugify: latin/digit runs kept, everything else -> single dash, trimmed + truncated', () => {
    expect(slugify('Red Roses — Large!', 63)).toBe('red-roses-large');
    expect(slugify('  Café Déjà Vu  ', 63)).toBe('cafe-deja-vu');
    expect(slugify('A'.repeat(200), 10)).toBe('aaaaaaaaaa');
  });

  it('slugify: an Arabic-only name has no derivable slug (owner §8)', () => {
    expect(thrown(() => slugify('وردة حمراء', 63))?.code).toBe('SLUG_UNDERIVABLE');
  });

  it('resolveSlug: explicit slug is validated; otherwise derived from nameEn', () => {
    expect(resolveSlug('my-slug', 'ignored', 63)).toBe('my-slug');
    expect(resolveSlug(undefined, 'Fresh Tulips', 63)).toBe('fresh-tulips');
    expect(thrown(() => resolveSlug('Bad Slug!', 'x', 63))?.code).toBe('INVALID_SLUG');
    expect(thrown(() => resolveSlug('-leading', 'x', 63))?.code).toBe('INVALID_SLUG');
  });

  it('assertValidProductTypeKey: SCREAMING_SNAKE only', () => {
    assertValidProductTypeKey('CUT_FLOWER');
    assertValidProductTypeKey('PERFUME');
    expect(thrown(() => assertValidProductTypeKey('lower'))?.code).toBe('INVALID_PRODUCT_TYPE_KEY');
    expect(thrown(() => assertValidProductTypeKey('X'))?.code).toBe('INVALID_PRODUCT_TYPE_KEY');
    expect(thrown(() => assertValidProductTypeKey('HAS SPACE'))?.code).toBe(
      'INVALID_PRODUCT_TYPE_KEY',
    );
  });

  it('parseIfMatch: strips weak/quotes; non-numeric -> null', () => {
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('W/"7"')).toBe(7);
    expect(parseIfMatch('5')).toBe(5);
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('*')).toBeNull();
    expect(parseIfMatch('abc')).toBeNull();
  });

  it('requireIfMatch: null -> 428 PRECONDITION_REQUIRED', () => {
    expect(requireIfMatch(4)).toBe(4);
    const err = thrown(() => requireIfMatch(null));
    expect(err?.code).toBe('PRECONDITION_REQUIRED');
    expect(err?.status).toBe(428);
  });

  it('assertUuid: a non-uuid id -> 404 (never a 500 from a bad ::uuid cast)', () => {
    assertUuid('00000000-0000-7000-8000-000000000001', 'category');
    expect(thrown(() => assertUuid('not-a-uuid', 'category'))?.status).toBe(404);
  });
});
