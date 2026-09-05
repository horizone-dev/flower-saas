import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';

/**
 * `translation` is tenant-owned and RLS-protected (task 2.1 migration:
 * `ENABLE + FORCE`) — every read/write here goes through `ScopedRepository`,
 * so a tenant can never resolve another tenant's translation: even if the
 * caller somehow supplied a foreign `entityId`, RLS restricts every row this
 * session can see/write to `tenant_id = current_setting('app.tenant_id')`, and
 * the `tenantId` used to build the lookup key below always comes from
 * `requireTenantContext()` (the authenticated session), never a request field.
 */
@Injectable()
export class TranslationRepository extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }

  get(entityType: string, entityId: string, field: string, locale: string): Promise<string | null> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const row = await tx.translation.findUnique({
        where: {
          tenantId_entityType_entityId_field_locale: {
            tenantId,
            entityType,
            entityId,
            field,
            locale,
          },
        },
        select: { value: true },
      });
      return row?.value ?? null;
    });
  }

  upsert(
    entityType: string,
    entityId: string,
    field: string,
    locale: string,
    value: string,
  ): Promise<void> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      await tx.translation.upsert({
        where: {
          tenantId_entityType_entityId_field_locale: {
            tenantId,
            entityType,
            entityId,
            field,
            locale,
          },
        },
        create: { tenantId, entityType, entityId, field, locale, value },
        update: { value },
      });
      return undefined;
    });
  }
}
