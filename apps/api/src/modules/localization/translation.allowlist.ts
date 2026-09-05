/**
 * The closed set of (entityType, field) pairs `TranslationService` will ever
 * read or write. Never derived from client input — a request naming an entity
 * type or field outside this table is rejected before any DB access, so no
 * client-controlled string ever reaches a table/column name or dynamic SQL
 * identifier (owner rule 7). Grows as later phases add translatable content
 * (catalog product/category names are the obvious next entries, Phase 3) —
 * never opened up to an arbitrary string.
 */
export const TRANSLATABLE_ENTITY_FIELDS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    branch: new Set(['name']),
    company: new Set(['legalNameEn', 'legalNameAr']),
  });

export function isTranslatable(entityType: string, field: string): boolean {
  return TRANSLATABLE_ENTITY_FIELDS[entityType]?.has(field) ?? false;
}
