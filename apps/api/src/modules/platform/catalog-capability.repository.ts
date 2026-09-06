import { Injectable } from '@nestjs/common';
import { runPlatform, type Prisma, type PrismaClient, type ScopedTx } from '@flower/db';
import {
  CATALOG_CAPABILITY_KEYS,
  checkCapabilityConfig,
  isCapabilityKey,
  type CapabilityKey,
} from '@flower/shared-types';
import { DbService } from '../../common/data/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';

export interface TemplateRow {
  key: string;
  version: number;
  nameEn: string;
  nameAr: string;
  status: string;
  capabilities: { capabilityKey: string; enabled: boolean; config: unknown }[];
}

export interface TenantCapabilityRow {
  capabilityKey: string;
  enabled: boolean;
  config: unknown;
  sourceKind: string;
  sourceTemplateKey: string | null;
  sourceTemplateVersion: number | null;
  overriddenAt: Date | null;
  lastChangedBy: string | null;
}

export interface TenantCapabilityState {
  tenantId: string;
  businessTypeKey: string | null;
  businessTypeAppliedVersion: number | null;
  businessTypeAppliedAt: Date | null;
  aggregateVersion: number;
  capabilities: TenantCapabilityRow[];
}

export interface CapabilityChange {
  capabilityKey: CapabilityKey;
  enabled: boolean;
  config?: unknown;
}

export interface ApplyTemplateInput {
  tenantId: string;
  businessTypeKey: string;
  actorPlatformUserId: string | null;
  now: Date;
}

/**
 * The GENERIC initial Business-Type template apply (spec §I). Runs inside a
 * caller-supplied **platform** transaction (`tx`) — currently only provisioning.
 *
 * IDENTICAL for every one of the 35 presets, `CUSTOM` included. There is NO
 * `if (businessTypeKey === 'CUSTOM')` / `switch` on the key — here or anywhere
 * (spec §2 / §I.3 / HG3-1-GENERIC-APPLY). The only per-preset difference is the
 * set of template capability rows — data, not code.
 *
 *   1. resolve the template — 422 UNKNOWN_BUSINESS_TYPE / 422 BUSINESS_TYPE_NOT_ACTIVE
 *   2. read its normalized capability rows
 *   3. snapshot each into `tenant_catalog_capability` (`sourceKind = 'TEMPLATE'`,
 *      provenance stamped, `config` = NULL — always, task 3.1 §E)
 *   4. stamp `tenant.businessType*` + `catalogCapabilityVersion = 1`
 *   5. one `catalog.template_applied` audit row
 *
 * Does NOT open a transaction and does NOT catch — a failure anywhere rolls the
 * caller's whole transaction back (no partial capability rows).
 */
export async function applyBusinessTypeTemplate(
  tx: ScopedTx,
  audit: AuditWriter,
  input: ApplyTemplateInput,
): Promise<{ appliedCapabilityKeys: string[]; templateVersion: number }> {
  const template = await tx.businessTypeTemplate.findUnique({
    where: { key: input.businessTypeKey },
    select: {
      key: true,
      version: true,
      status: true,
      capabilities: { select: { capabilityKey: true, enabled: true, config: true } },
    },
  });
  if (!template) {
    throw new DomainError(
      'UNKNOWN_BUSINESS_TYPE',
      `"${input.businessTypeKey}" is not a known Business Type`,
      422,
    );
  }
  if (template.status !== 'ACTIVE') {
    throw new DomainError(
      'BUSINESS_TYPE_NOT_ACTIVE',
      `Business Type "${input.businessTypeKey}" is not available (deprecated)`,
      422,
    );
  }

  for (const cap of template.capabilities) {
    await tx.tenantCatalogCapability.create({
      data: {
        tenantId: input.tenantId,
        capabilityKey: cap.capabilityKey,
        enabled: cap.enabled,
        // `config` is always NULL in task 3.1; snapshot it faithfully if a
        // future template row ever carries one (spec §I step 3).
        ...(cap.config != null ? { config: cap.config as Prisma.InputJsonValue } : {}),
        sourceKind: 'TEMPLATE',
        sourceTemplateKey: template.key,
        sourceTemplateVersion: template.version,
        appliedAt: input.now,
        appliedBy: input.actorPlatformUserId,
        lastChangedBy: input.actorPlatformUserId,
      },
    });
  }

  await tx.tenant.update({
    where: { id: input.tenantId },
    data: {
      businessTypeKey: template.key,
      businessTypeAppliedVersion: template.version,
      businessTypeAppliedAt: input.now,
      catalogCapabilityVersion: 1,
    },
  });

  const appliedCapabilityKeys = template.capabilities.map((c) => c.capabilityKey);
  await audit.record(tx, {
    action: 'catalog.template_applied',
    resourceType: 'business_type_template',
    resourceId: template.key,
    tenantId: input.tenantId,
    actorPlatformUserId: input.actorPlatformUserId,
    reason: JSON.stringify({
      templateKey: template.key,
      templateVersion: template.version,
      appliedCapabilityKeys,
    }),
  });

  return { appliedCapabilityKeys, templateVersion: template.version };
}

/**
 * Platform-realm data access for the catalog-capability configuration surface
 * (task 3.1). Cross-tenant by nature — every write is audited. Reachable only
 * from the `platform` module.
 */
@Injectable()
export class PlatformCatalogCapabilityRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditWriter,
  ) {}
  private get platform(): PrismaClient {
    return this.db.platformClient();
  }

  /** All Business-Type templates + their normalized capability rows (spec §K.1). */
  listTemplates(): Promise<TemplateRow[]> {
    return runPlatform(this.platform, (tx) =>
      tx.businessTypeTemplate.findMany({
        orderBy: { key: 'asc' },
        select: {
          key: true,
          version: true,
          nameEn: true,
          nameAr: true,
          status: true,
          capabilities: {
            orderBy: { capabilityKey: 'asc' },
            select: { capabilityKey: true, enabled: true, config: true },
          },
        },
      }),
    );
  }

  /** A tenant's full capability state (spec §K.2). */
  getTenantState(tenantId: string): Promise<TenantCapabilityState> {
    return runPlatform(this.platform, (tx) => this.readState(tx, tenantId));
  }

  private async readState(tx: ScopedTx, tenantId: string): Promise<TenantCapabilityState> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        businessTypeKey: true,
        businessTypeAppliedVersion: true,
        businessTypeAppliedAt: true,
        catalogCapabilityVersion: true,
      },
    });
    if (!tenant) throw new NotFoundError('tenant');
    const capabilities = await tx.tenantCatalogCapability.findMany({
      where: { tenantId },
      orderBy: { capabilityKey: 'asc' },
      select: {
        capabilityKey: true,
        enabled: true,
        config: true,
        sourceKind: true,
        sourceTemplateKey: true,
        sourceTemplateVersion: true,
        overriddenAt: true,
        lastChangedBy: true,
      },
    });
    return {
      tenantId,
      businessTypeKey: tenant.businessTypeKey,
      businessTypeAppliedVersion: tenant.businessTypeAppliedVersion,
      businessTypeAppliedAt: tenant.businessTypeAppliedAt,
      aggregateVersion: tenant.catalogCapabilityVersion,
      capabilities,
    };
  }

  /**
   * Apply a change-set to a tenant's capability configuration (spec §K.3 / §L).
   * ONE transaction: lock the tenant row → check `If-Match` → per-row upsert of
   * only the real changes → bump the aggregate version → one audit row. A stale
   * `If-Match`, a validation failure, or a no-op leaves NO write and NO audit row.
   */
  async patch(input: {
    tenantId: string;
    expectedVersion: number | null;
    changes: CapabilityChange[];
    reason: string | null;
    actorPlatformUserId: string | null;
  }): Promise<TenantCapabilityState> {
    const { tenantId, expectedVersion, changes, reason, actorPlatformUserId } = input;

    if (changes.length === 0) {
      throw new DomainError('VALIDATION_FAILED', '`changes` must not be empty', 400);
    }
    const seen = new Set<string>();
    for (const c of changes) {
      if (!isCapabilityKey(c.capabilityKey)) {
        throw new DomainError(
          'UNKNOWN_CAPABILITY_KEY',
          `"${c.capabilityKey}" is not a known capability key`,
          422,
        );
      }
      if (seen.has(c.capabilityKey)) {
        throw new DomainError(
          'DUPLICATE_CAPABILITY_KEY',
          `capability "${c.capabilityKey}" appears more than once`,
          422,
        );
      }
      seen.add(c.capabilityKey);
      const cfg = checkCapabilityConfig(c.capabilityKey, c.config ?? null);
      if (!cfg.ok) throw new DomainError(cfg.code, cfg.message, 422);
    }

    return runPlatform(this.platform, async (tx) => {
      // lock the tenant row for the whole transaction — serializes concurrent
      // PATCHes for this tenant (spec §L.3).
      const locked = await tx.$queryRaw<{ v: number }[]>`
        SELECT "catalogCapabilityVersion" AS v FROM "tenant" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError('tenant');
      const current = locked[0]!.v;

      if (expectedVersion === null) {
        throw new DomainError(
          'PRECONDITION_REQUIRED',
          'If-Match (the current aggregateVersion) is required',
          428,
        );
      }
      if (expectedVersion !== current) {
        throw new DomainError(
          'CATALOG_CAPABILITY_VERSION_CONFLICT',
          `the capability set changed elsewhere (expected ${expectedVersion}, now ${current})`,
          409,
        );
      }

      const existing = await tx.tenantCatalogCapability.findMany({
        where: { tenantId, capabilityKey: { in: changes.map((c) => c.capabilityKey) } },
        select: { capabilityKey: true, enabled: true, config: true, sourceKind: true },
      });
      const byKey = new Map(existing.map((r) => [r.capabilityKey, r]));

      const realChanges: { key: string; from: boolean | null; to: boolean }[] = [];
      const now = new Date();

      for (const c of changes) {
        const prior = byKey.get(c.capabilityKey);
        const priorConfig = JSON.stringify(prior?.config ?? null);
        const nextConfig = JSON.stringify(c.config ?? null);
        const noChange =
          prior !== undefined && prior.enabled === c.enabled && priorConfig === nextConfig;
        if (noChange) continue;

        realChanges.push({ key: c.capabilityKey, from: prior?.enabled ?? null, to: c.enabled });

        if (prior === undefined) {
          await tx.tenantCatalogCapability.create({
            data: {
              tenantId,
              capabilityKey: c.capabilityKey,
              enabled: c.enabled,
              sourceKind: 'MANUAL',
              lastChangedBy: actorPlatformUserId,
            },
          });
        } else {
          await tx.tenantCatalogCapability.update({
            where: { tenantId_capabilityKey: { tenantId, capabilityKey: c.capabilityKey } },
            data: {
              enabled: c.enabled,
              sourceKind: 'MANUAL',
              lastChangedBy: actorPlatformUserId,
              // stamp overriddenAt the first time a TEMPLATE row diverges (§H.2)
              ...(prior.sourceKind === 'TEMPLATE' ? { overriddenAt: now } : {}),
            },
          });
        }
      }

      if (realChanges.length === 0) {
        // no-op — no write, no version bump, no audit row (spec §L.3 / §O.3)
        return this.readState(tx, tenantId);
      }

      await tx.tenant.update({
        where: { id: tenantId },
        data: { catalogCapabilityVersion: { increment: 1 } },
      });

      await this.audit.record(tx, {
        action: 'tenant.catalog_capability_changed',
        resourceType: 'tenant_catalog_capability',
        resourceId: tenantId,
        tenantId,
        actorPlatformUserId,
        reason: JSON.stringify({
          reason,
          aggregateVersionFrom: current,
          aggregateVersionTo: current + 1,
          changes: realChanges.map((r) => ({
            capabilityKey: r.key,
            enabledFrom: r.from,
            enabledTo: r.to,
          })),
        }),
      });

      return this.readState(tx, tenantId);
    });
  }
}

/** the 16-key registry, re-exported for convenience. */
export const ALL_CAPABILITY_KEYS: readonly CapabilityKey[] = CATALOG_CAPABILITY_KEYS;
