import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  CATALOG_CAPABILITY_KEYS,
  CAPABILITY_REQUIRED_ENTITLEMENT,
  type CapabilityKey,
  type TemplateApplyMode,
} from '@flower/shared-types';
import { requestHash } from '../../common/idempotency/canonical-hash.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RedisService } from '../../common/redis/redis.module.js';
import {
  PlatformCatalogCapabilityRepository,
  type CapabilityChange,
  type TenantCapabilityState,
} from './catalog-capability.repository.js';
import { TenantConfigRepository } from './tenant-config.repository.js';

interface CapabilityView {
  capabilityKey: CapabilityKey;
  enabled: boolean;
  config: unknown;
  sourceKind: string | null;
  sourceTemplateKey: string | null;
  sourceTemplateVersion: number | null;
  overriddenAt: string | null;
  requiredEntitlement: string | null;
  inert: boolean;
}

interface TenantCapabilityView {
  tenantId: string;
  businessTypeKey: string | null;
  businessTypeAppliedVersion: number | null;
  businessTypeAppliedAt: string | null;
  aggregateVersion: number;
  capabilities: CapabilityView[];
}

@Injectable()
export class PlatformCatalogCapabilityService {
  constructor(
    private readonly repo: PlatformCatalogCapabilityRepository,
    private readonly tenantConfig: TenantConfigRepository,
    private readonly redis: RedisService,
  ) {}

  private get client(): Redis | null {
    return this.redis.get();
  }

  async listTemplates(): Promise<{
    data: {
      key: string;
      version: number;
      nameEn: string;
      nameAr: string;
      status: string;
      capabilities: { capabilityKey: string; enabled: boolean; config: unknown }[];
    }[];
  }> {
    const templates = await this.repo.listTemplates();
    return {
      data: templates.map((t) => ({
        key: t.key,
        version: t.version,
        nameEn: t.nameEn,
        nameAr: t.nameAr,
        status: t.status,
        capabilities: t.capabilities.map((c) => ({
          capabilityKey: c.capabilityKey,
          enabled: c.enabled,
          config: c.config ?? null,
        })),
      })),
    };
  }

  async getTenant(tenantId: string): Promise<TenantCapabilityView> {
    const [state, entitled] = await Promise.all([
      this.repo.getTenantState(tenantId),
      this.entitledModules(tenantId),
    ]);
    return this.shape(state, entitled);
  }

  async patch(input: {
    tenantId: string;
    expectedVersion: number | null;
    changes: CapabilityChange[];
    reason: string | null;
    actorPlatformUserId: string | null;
  }): Promise<TenantCapabilityView> {
    const state = await this.repo.patch(input);
    return this.shape(state, await this.entitledModules(input.tenantId));
  }

  /**
   * Task 3.10 — explicit Super-Admin re-apply of a Business-Type CAPABILITY
   * preset (`merge` / `replace`). Two independent guards (owner D-3):
   *   - `Idempotency-Key` — protects duplicate transport/request execution: a
   *     replayed key returns the stored response WITHOUT re-executing (Redis
   *     guard, 24h TTL, the same pattern as tenant provisioning). Best-effort
   *     when Redis is down.
   *   - `If-Match` on `catalogCapabilityVersion` — the hard guard against stale
   *     operator intent / a lost update vs a concurrent `PATCH` or re-apply
   *     (`428` missing, `409` stale — enforced in the repo, in the tenant-lock
   *     transaction).
   * `templateKey` MAY differ from the tenant's current `businessTypeKey` (owner
   * D-4). Emits NO outbox event (owner D-2).
   *
   * Owner strict-review fix — the cached replay is now fingerprinted, reusing
   * the SAME canonical fingerprint primitive as the tenant-realm
   * `IdempotencyInterceptor` (`requestHash`/`canonicalize` from
   * `canonical-hash.ts` — no second idempotency subsystem). Canonical mutation
   * identity = route + tenant + acting principal + `{templateKey, mode}` — the
   * `If-Match` value is deliberately EXCLUDED (matching the tenant-realm
   * interceptor's own hash, which never includes arbitrary headers): a
   * fingerprint-confirmed replay returns the cached response directly and
   * NEVER re-validates the original `If-Match` against the now-advanced DB
   * version (e.g. `If-Match "5"` → applied → v6; the exact same replay must
   * return the cached v6 success, not fail because the DB is now at 6). A
   * SAME key + DIFFERENT `{templateKey, mode}` is a deterministic
   * `409 IDEMPOTENCY_KEY_REUSED` — it never returns the previous response. A
   * FRESH key always reaches `repo.reapply()`, whose own `If-Match` check is
   * unchanged (`428` missing / `409 CATALOG_CAPABILITY_VERSION_CONFLICT` stale).
   */
  async reapply(input: {
    tenantId: string;
    templateKey: string;
    mode: TemplateApplyMode;
    expectedVersion: number | null;
    idempotencyKey: string;
    actorPlatformUserId: string | null;
  }): Promise<TenantCapabilityView> {
    const idemKey = `idem:template-apply:${input.tenantId}:${input.idempotencyKey}`;
    const fingerprint = requestHash({
      method: 'POST',
      routePattern: '/v1/platform/tenants/:tenantId/apply-business-type-template',
      pathParams: { tenantId: input.tenantId },
      query: {},
      scope: 'platform:catalog_capability:apply',
      tenantId: input.tenantId,
      principalId: input.actorPlatformUserId ?? '',
      body: { templateKey: input.templateKey, mode: input.mode },
    });

    const cachedRaw = await this.client?.get(idemKey).catch(() => null);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as {
        fingerprint: string;
        response: TenantCapabilityView;
      };
      if (cached.fingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'this Idempotency-Key was already used for a different request',
          409,
        );
      }
      return cached.response;
    }

    const state = await this.repo.reapply({
      tenantId: input.tenantId,
      templateKey: input.templateKey,
      mode: input.mode,
      expectedVersion: input.expectedVersion,
      actorPlatformUserId: input.actorPlatformUserId,
    });
    const view = this.shape(state, await this.entitledModules(input.tenantId));

    await this.client
      ?.set(idemKey, JSON.stringify({ fingerprint, response: view }), 'EX', 60 * 60 * 24)
      .catch(() => undefined);
    return view;
  }

  private async entitledModules(tenantId: string): Promise<ReadonlySet<string>> {
    const ent = await this.tenantConfig.entitlements(tenantId);
    return new Set(ent.filter((e) => e.enabled).map((e) => e.moduleKey));
  }

  private shape(state: TenantCapabilityState, entitled: ReadonlySet<string>): TenantCapabilityView {
    const byKey = new Map(state.capabilities.map((c) => [c.capabilityKey, c]));
    const capabilities: CapabilityView[] = CATALOG_CAPABILITY_KEYS.map((key) => {
      const row = byKey.get(key);
      const requiredEntitlement = CAPABILITY_REQUIRED_ENTITLEMENT[key] ?? null;
      return {
        capabilityKey: key,
        enabled: row?.enabled ?? false,
        config: row?.config ?? null,
        sourceKind: row?.sourceKind ?? null,
        sourceTemplateKey: row?.sourceTemplateKey ?? null,
        sourceTemplateVersion: row?.sourceTemplateVersion ?? null,
        overriddenAt: row?.overriddenAt ? row.overriddenAt.toISOString() : null,
        requiredEntitlement,
        inert: requiredEntitlement !== null && !entitled.has(requiredEntitlement),
      };
    });
    return {
      tenantId: state.tenantId,
      businessTypeKey: state.businessTypeKey,
      businessTypeAppliedVersion: state.businessTypeAppliedVersion,
      businessTypeAppliedAt: state.businessTypeAppliedAt
        ? state.businessTypeAppliedAt.toISOString()
        : null,
      aggregateVersion: state.aggregateVersion,
      capabilities,
    };
  }
}
