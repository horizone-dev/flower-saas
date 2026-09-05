import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import { TranslationRepository } from './translation.repository.js';
import { isTranslatable } from './translation.allowlist.js';

const DEFAULT_FALLBACK_LOCALE = 'en';

/**
 * `translate`/`setTranslation` never accept an arbitrary client-controlled
 * table/column name — `entityType`/`field` are checked against the fixed
 * allowlist (`translation.allowlist.ts`) before any DB access; an unlisted
 * pair is rejected with a typed error, never silently ignored or coerced
 * (owner rule 7). `entityId` and `locale` are plain data values (not
 * identifiers), fine to pass through as query parameters.
 *
 * Fallback rule: requested locale → configured fallback locale (`en` unless a
 * tenant configures otherwise — no such per-tenant override exists yet, so this
 * is currently always `en`) → the caller-supplied default text (the entity's
 * own base-language field value, e.g. `branch.name` itself).
 */
@Injectable()
export class TranslationService {
  constructor(private readonly repo: TranslationRepository) {}

  async translate(
    entityType: string,
    entityId: string,
    field: string,
    locale: string,
    defaultText: string,
    fallbackLocale: string = DEFAULT_FALLBACK_LOCALE,
  ): Promise<string> {
    this.assertTranslatable(entityType, field);
    const direct = await this.repo.get(entityType, entityId, field, locale);
    if (direct !== null) return direct;
    if (locale !== fallbackLocale) {
      const fallback = await this.repo.get(entityType, entityId, field, fallbackLocale);
      if (fallback !== null) return fallback;
    }
    return defaultText;
  }

  async setTranslation(
    entityType: string,
    entityId: string,
    field: string,
    locale: string,
    value: string,
  ): Promise<void> {
    this.assertTranslatable(entityType, field);
    await this.repo.upsert(entityType, entityId, field, locale, value);
  }

  private assertTranslatable(entityType: string, field: string): void {
    if (!isTranslatable(entityType, field)) {
      throw new DomainError(
        'ENTITY_FIELD_NOT_TRANSLATABLE',
        `"${entityType}.${field}" is not a translatable entity/field`,
        422,
      );
    }
  }
}
