import { Injectable } from '@nestjs/common';
import type {
  BranchVariantPriceSetView,
  ResolvedBranchPrice,
  BranchAvailabilityView,
  BranchAvailabilitySetResult,
  BranchEffectiveCatalogEntry,
} from '@flower/shared-types';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import { BranchPricingRepository } from './branch-pricing.repository.js';
import type { BranchPriceEntryInput } from './branch-pricing.helpers.js';

/**
 * Task 3.8 — the `branch_pricing` catalog-capability gate (owner ruling
 * 2026-09-09, superseding the earlier BD-11 wording).
 *
 *   - It guards **every branch write** — branch PRICE writes (`PUT …/prices`,
 *     incl. `PUT { prices: [] }`) AND branch AVAILABILITY writes
 *     (`PUT …/availability`). Both require `branch_price:manage` (the permission)
 *     AND `branch_pricing` (this capability).
 *   - It NEVER guards a read (`GET …/prices`, `GET …/prices/resolve`,
 *     `GET …/availability`, `GET …/catalog`) — reads stay ungated so a POS /
 *     Owner client can always see the current state even with the capability off.
 *   - Disabling `branch_pricing` blocks new branch price + availability
 *     mutations (409 `CAPABILITY_NOT_ENABLED`) but never hides / destroys
 *     existing `branch_variant_*` rows, and never disables the Task 3.7
 *     company-price-removal integrity guard (which lives in
 *     `CompanyPricingRepository` and runs regardless).
 *   - The gate is the application-layer `assertEnabled(...)` — it runs inside
 *     the handler, so on a `409` the idempotency interceptor RELEASES the claim
 *     (a non-2xx never marks the key DONE): no business mutation, no audit row,
 *     and a retry after the capability is re-enabled re-executes cleanly.
 *
 * `branch_pricing` needs no entitlement module, so only `assertEnabled` is
 * called. Business Type is never consulted (HG3-NO-BT-BRANCH). All data access /
 * concurrency / audit stays in the repository.
 */
@Injectable()
export class BranchPricingService {
  constructor(
    private readonly repo: BranchPricingRepository,
    private readonly caps: CatalogCapabilityService,
  ) {}

  getPrices(branchId: string, variantId: string): Promise<BranchVariantPriceSetView> {
    return this.repo.getForBranchVariant(branchId, variantId);
  }

  async replacePrices(
    branchId: string,
    variantId: string,
    entries: readonly BranchPriceEntryInput[],
    ifMatch: number,
  ): Promise<BranchVariantPriceSetView> {
    await this.caps.assertEnabled('branch_pricing');
    return this.repo.replace(branchId, variantId, entries, ifMatch);
  }

  resolvePrice(branchId: string, variantId: string, uomCode: string): Promise<ResolvedBranchPrice> {
    return this.repo.resolve(branchId, variantId, uomCode);
  }

  async setAvailability(
    branchId: string,
    entries: readonly { variantId: string; available: boolean }[],
  ): Promise<BranchAvailabilitySetResult> {
    // capability-gated like a branch price write (owner ruling 2026-09-09) —
    // the SAME application-layer pattern used by `replacePrices` above.
    await this.caps.assertEnabled('branch_pricing');
    return this.repo.setAvailability(branchId, entries);
  }

  getAvailability(branchId: string, variantId?: string): Promise<BranchAvailabilityView[]> {
    return this.repo.getAvailability(branchId, variantId);
  }

  getEffectiveCatalog(
    branchId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: BranchEffectiveCatalogEntry[]; nextCursor: string | null }> {
    return this.repo.effectiveCatalog(branchId, cursor, limit);
  }
}
