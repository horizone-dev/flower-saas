import { Injectable } from '@nestjs/common';
import {
  CATALOG_CAPABILITY_KEYS,
  CAPABILITY_REQUIRED_ENTITLEMENT,
  type CapabilityKey,
} from '@flower/shared-types';
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
  ) {}

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
