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
 * Task 3.8 — the `branch_pricing` catalog-capability gate (owner BD-11).
 *
 *   - It guards ONLY branch PRICE writes (`PUT …/prices`, incl. `PUT { prices: [] }`).
 *   - It NEVER guards branch AVAILABILITY writes — branch availability is
 *     foundational branch merchandising control and stays usable even when
 *     branch-specific pricing is disabled.
 *   - It NEVER guards a read.
 *   - Disabling `branch_pricing` blocks new branch-price mutations (409
 *     `CAPABILITY_NOT_ENABLED`) but never hides / destroys existing branch price
 *     rows, and never disables the Task 3.7 company-price-removal integrity guard
 *     (which lives in `CompanyPricingRepository` and runs regardless).
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

  setAvailability(
    branchId: string,
    entries: readonly { variantId: string; available: boolean }[],
  ): Promise<BranchAvailabilitySetResult> {
    // NO capability gate (BD-11).
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
