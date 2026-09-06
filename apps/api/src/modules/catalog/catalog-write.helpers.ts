import { DomainError } from '../../common/errors/domain-error.js';

/** UUID v1–v8 shape — a route/body id that is not one gets a 404 (never a 500
 *  from a bad `::uuid` cast), matching the platform controllers. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function assertUuid(id: string, resource: string): void {
  if (!UUID_RE.test(id)) throw new DomainError('NOT_FOUND', `${resource} not found`, 404);
}

export const SLUG_MAX = { category: 63, product: 128 } as const;

/**
 * Derive a url-safe slug from a name. Latin/digit runs are kept, everything else
 * collapses to a single `-`; leading/trailing `-` trimmed; lower-cased; truncated
 * to `max` and re-trimmed. The result matches `^[a-z0-9][a-z0-9-]{0,max-1}$` — or
 * this throws `SLUG_UNDERIVABLE` (422) if the name has no usable Latin/digit
 * character (an Arabic-only name must supply an explicit slug).
 */
export function slugify(name: string, max: number): string {
  // NFKD folds accented Latin to base letter + combining mark; strip the marks
  // (U+0300–U+036F) so "Déjà" -> "deja", then collapse every other non-[a-z0-9]
  // run to a single `-`.
  const s = name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  if (!s) {
    throw new DomainError(
      'SLUG_UNDERIVABLE',
      'could not derive a slug from the name — supply an explicit slug',
      422,
    );
  }
  return s;
}

export function assertValidSlug(slug: string, max: number): void {
  const re = new RegExp(`^[a-z0-9][a-z0-9-]{0,${max - 1}}$`);
  if (!re.test(slug)) {
    throw new DomainError(
      'INVALID_SLUG',
      `slug must match ^[a-z0-9][a-z0-9-]{0,${max - 1}}$`,
      422,
      [{ field: 'slug', issue: 'invalid format' }],
    );
  }
}

/** Resolve the slug to persist: an explicit one (validated) or one derived from
 *  `nameEn` (owner §8 — an Arabic-only catalog entry still needs a Latin slug). */
export function resolveSlug(explicit: string | undefined, nameEn: string, max: number): string {
  if (explicit !== undefined && explicit !== '') {
    assertValidSlug(explicit, max);
    return explicit;
  }
  return slugify(nameEn, max);
}

const PRODUCT_TYPE_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function assertValidProductTypeKey(key: string): void {
  if (!PRODUCT_TYPE_KEY_RE.test(key)) {
    throw new DomainError(
      'INVALID_PRODUCT_TYPE_KEY',
      'product type key must match ^[A-Z][A-Z0-9_]{1,63}$',
      422,
      [{ field: 'key', issue: 'invalid format' }],
    );
  }
}

/**
 * Parse an `If-Match` header value into a non-negative integer version, or `null`
 * (missing / malformed / `*`). Same shape as the platform catalog-capability
 * controller. A `null` from a route that needs concurrency control becomes a 428.
 */
export function parseIfMatch(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** `If-Match` is mandatory on every catalog `PUT` / lifecycle command / delete
 *  (D2-9 / owner §13 / §14). */
export function requireIfMatch(parsed: number | null): number {
  if (parsed === null) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      'If-Match (the current resource version) is required',
      428,
    );
  }
  return parsed;
}

/** A stale `If-Match` on a catalog aggregate — no write, no audit row. */
export function versionConflict(resource: string, expected: number, current: number): DomainError {
  return new DomainError(
    `${resource.toUpperCase()}_VERSION_CONFLICT`,
    `${resource} changed elsewhere (expected version ${expected}, now ${current})`,
    409,
  );
}
