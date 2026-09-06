import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';

export interface OwnCapabilityRow {
  capabilityKey: string;
  enabled: boolean;
  config: unknown;
}

export interface OwnCapabilityState {
  businessTypeKey: string | null;
  businessTypeAppliedVersion: number | null;
  businessTypeAppliedAt: Date | null;
  aggregateVersion: number;
  rows: OwnCapabilityRow[];
}

/**
 * Tenant-realm read of the caller's OWN catalog-capability configuration. The
 * ONLY table it touches is `tenant_catalog_capability` (spec §15). RLS restricts
 * every read to the request-context tenant — the repository code never names a
 * tenant id (CLAUDE.md rule 5 / 6).
 */
@Injectable()
export class CatalogCapabilityRepository extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }

  /** Full own state — for the `GET /v1/catalog/capabilities` view. */
  ownState(): Promise<OwnCapabilityState> {
    return this.scoped(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({
        select: {
          businessTypeKey: true,
          businessTypeAppliedVersion: true,
          businessTypeAppliedAt: true,
          catalogCapabilityVersion: true,
        },
      });
      const rows = await tx.tenantCatalogCapability.findMany({
        orderBy: { capabilityKey: 'asc' },
        select: { capabilityKey: true, enabled: true, config: true },
      });
      return {
        businessTypeKey: tenant.businessTypeKey,
        businessTypeAppliedVersion: tenant.businessTypeAppliedVersion,
        businessTypeAppliedAt: tenant.businessTypeAppliedAt,
        aggregateVersion: tenant.catalogCapabilityVersion,
        rows,
      };
    });
  }

  /** The enabled-capability-key set — the hot path for the capability service. */
  enabledKeys(): Promise<Set<string>> {
    return this.scoped(async (tx) => {
      const rows = await tx.tenantCatalogCapability.findMany({
        where: { enabled: true },
        select: { capabilityKey: true },
      });
      return new Set(rows.map((r) => r.capabilityKey));
    });
  }
}
