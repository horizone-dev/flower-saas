import { Injectable } from '@nestjs/common';
import {
  CATALOG_CAPABILITY_KEYS,
  CAPABILITY_OF_STRATEGY,
  CAPABILITY_REQUIRED_ENTITLEMENT,
  type CapabilityKey,
  type FulfilmentStrategy,
} from '@flower/shared-types';
import { getContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { CatalogCapabilityRepository } from './catalog-capability.repository.js';

export interface CapabilitySnapshotEntry {
  enabled: boolean;
  config: unknown;
}

/**
 * The runtime catalog-capability helper (spec §15). Reads ONLY
 * `tenant_catalog_capability` (through `CatalogCapabilityRepository`, so RLS
 * scopes it to the request tenant). It NEVER branches on
 * `tenant.business_type_key` — the Business Type is a preset/provenance concept
 * only (D0-3 / HG3-NO-BT-BRANCH).
 *
 * A disabled-capability failure is a DOMAIN error (`CAPABILITY_NOT_ENABLED`,
 * HTTP 409) — deliberately distinct from an authentication (401) or permission
 * (403) failure.
 *
 * Task 3.1 exposes the helper; it does NOT wire product-create enforcement —
 * Task 3.2 calls `assertEnabled(...)` there.
 */
@Injectable()
export class CatalogCapabilityService {
  constructor(private readonly repo: CatalogCapabilityRepository) {}

  async isEnabled(key: CapabilityKey): Promise<boolean> {
    return (await this.repo.enabledKeys()).has(key);
  }

  async assertEnabled(key: CapabilityKey): Promise<void> {
    if (!(await this.isEnabled(key))) {
      throw new DomainError(
        'CAPABILITY_NOT_ENABLED',
        `catalog capability "${key}" is not enabled for this tenant`,
        409,
      );
    }
  }

  /**
   * The entitlement half of the "usable" contract (spec §D). Reuses the canonical
   * entitlement mechanism — the session-resolved `ctx.entitlements` set and the
   * shared `CAPABILITY_REQUIRED_ENTITLEMENT` map — and throws the SAME
   * `MODULE_NOT_ENTITLED` (403) domain error the guard pipeline emits. NOT a
   * parallel entitlement architecture (owner §6). A capability with no required
   * entitlement is a no-op here.
   *
   * Deliberately distinct from `assertEnabled` (409 `CAPABILITY_NOT_ENABLED`):
   * a disabled capability and an un-entitled module are different failures.
   */
  assertEntitledFor(key: CapabilityKey): void {
    const mod = CAPABILITY_REQUIRED_ENTITLEMENT[key];
    if (mod === undefined) return;
    const entitled = getContext()?.entitlements ?? new Set<string>();
    if (!entitled.has(mod)) {
      throw new DomainError(
        'MODULE_NOT_ENTITLED',
        `module "${mod}" is not enabled for this tenant`,
        403,
      );
    }
  }

  /**
   * The full gate a `fulfilment_strategy` must pass on product create / a DRAFT
   * strategy change / activate (owner §5 / §6): the strategy's capability must be
   * enabled (409) AND its module entitled (403). Checked in that order so a
   * disabled strategy always reports `CAPABILITY_NOT_ENABLED`. Business Type is
   * NEVER consulted.
   */
  async assertStrategyAllowed(strategy: FulfilmentStrategy): Promise<void> {
    const key = CAPABILITY_OF_STRATEGY[strategy];
    await this.assertEnabled(key);
    this.assertEntitledFor(key);
  }

  /** The full 16-key snapshot (missing rows -> `{ enabled: false, config: null }`). */
  async snapshot(): Promise<Map<CapabilityKey, CapabilitySnapshotEntry>> {
    const state = await this.repo.ownState();
    const byKey = new Map(state.rows.map((r) => [r.capabilityKey, r]));
    const out = new Map<CapabilityKey, CapabilitySnapshotEntry>();
    for (const key of CATALOG_CAPABILITY_KEYS) {
      const row = byKey.get(key);
      out.set(key, { enabled: row?.enabled ?? false, config: row?.config ?? null });
    }
    return out;
  }

  /** The `GET /v1/catalog/capabilities` view (spec §K.4) — thin: no provenance,
   *  no actor ids; includes `inert` computed against the caller's entitlements. */
  async ownView(): Promise<{
    businessTypeKey: string | null;
    businessTypeAppliedVersion: number | null;
    businessTypeAppliedAt: string | null;
    aggregateVersion: number;
    capabilities: { capabilityKey: CapabilityKey; enabled: boolean; inert: boolean }[];
  }> {
    const state = await this.repo.ownState();
    const entitled = getContext()?.entitlements ?? new Set<string>();
    const byKey = new Map(state.rows.map((r) => [r.capabilityKey, r]));
    return {
      businessTypeKey: state.businessTypeKey,
      businessTypeAppliedVersion: state.businessTypeAppliedVersion,
      businessTypeAppliedAt: state.businessTypeAppliedAt
        ? state.businessTypeAppliedAt.toISOString()
        : null,
      aggregateVersion: state.aggregateVersion,
      capabilities: CATALOG_CAPABILITY_KEYS.map((key) => {
        const mod = CAPABILITY_REQUIRED_ENTITLEMENT[key];
        return {
          capabilityKey: key,
          enabled: byKey.get(key)?.enabled ?? false,
          inert: mod !== undefined && !entitled.has(mod),
        };
      }),
    };
  }
}
