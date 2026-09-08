import { Injectable } from '@nestjs/common';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import { UomRepository, type CreateUomInput, type UomListEntry } from './uom.repository.js';
import {
  UomConversionRepository,
  type EffectiveConversionRow,
  type ProductConversionEntry,
  type StoredProductConversionRow,
  type VariantConversionEntry,
} from './uom-conversion.repository.js';
import { VariantRepository, type VariantWithOptions } from './variant.repository.js';
import { isBuiltinUom, requireUomCode } from './uom.helpers.js';

/**
 * The `multi_uom` catalog-capability gate for task 3.6 (owner §K). It guards:
 *   - tenant custom-UOM create / update / delete;
 *   - variant / product scoped conversion writes;
 *   - setting a variant base UOM to a TENANT-CUSTOM code (a built-in base needs
 *     no capability — basic catalog stays usable when `multi_uom` is off).
 * It NEVER guards a read (`GET /uoms`, `GET …/conversions`, scan resolve) or a
 * built-in base-UOM assignment. `multi_uom` needs no entitlement module, so only
 * `assertEnabled` is called. Business Type is never consulted (HG3-NO-BT-BRANCH).
 * All data access / concurrency / audit stays in the repositories.
 */
@Injectable()
export class UomService {
  constructor(
    private readonly repo: UomRepository,
    private readonly caps: CatalogCapabilityService,
  ) {}

  list(): Promise<UomListEntry[]> {
    return this.repo.list();
  }

  get(code: string): Promise<UomListEntry> {
    return this.repo.get(code);
  }

  async create(input: CreateUomInput): Promise<UomListEntry> {
    await this.caps.assertEnabled('multi_uom');
    return this.repo.create(input);
  }

  async updateNames(
    code: string,
    expectedVersion: number,
    input: { nameEn?: string | undefined; nameAr?: string | null | undefined },
  ): Promise<UomListEntry> {
    await this.caps.assertEnabled('multi_uom');
    return this.repo.updateNames(code, expectedVersion, input);
  }

  async remove(code: string, expectedVersion: number): Promise<void> {
    await this.caps.assertEnabled('multi_uom');
    return this.repo.remove(code, expectedVersion);
  }
}

@Injectable()
export class VariantUomService {
  constructor(
    private readonly variants: VariantRepository,
    private readonly conversions: UomConversionRepository,
    private readonly caps: CatalogCapabilityService,
  ) {}

  async setBaseUom(
    variantId: string,
    expectedVersion: number,
    rawCode: string,
  ): Promise<VariantWithOptions> {
    const code = requireUomCode(rawCode);
    // built-in base → no capability; tenant-custom base → multi_uom required (FC-4)
    if (!isBuiltinUom(code)) await this.caps.assertEnabled('multi_uom');
    return this.variants.setBaseUom(variantId, expectedVersion, code);
  }

  getVariantConversions(variantId: string): Promise<{
    variantVersion: number;
    baseUomCode: string | null;
    rows: EffectiveConversionRow[];
  }> {
    return this.conversions.getVariantEffective(variantId);
  }

  async replaceVariantConversions(
    variantId: string,
    expectedVersion: number,
    entries: VariantConversionEntry[],
  ): Promise<{ variantVersion: number; rows: EffectiveConversionRow[] }> {
    await this.caps.assertEnabled('multi_uom');
    return this.conversions.replaceVariantConversions(variantId, expectedVersion, entries);
  }

  getProductConversions(
    productId: string,
  ): Promise<{ productVersion: number; rows: StoredProductConversionRow[] }> {
    return this.conversions.getProductStored(productId);
  }

  async replaceProductConversions(
    productId: string,
    expectedVersion: number,
    entries: ProductConversionEntry[],
  ): Promise<{ productVersion: number; rows: StoredProductConversionRow[] }> {
    await this.caps.assertEnabled('multi_uom');
    return this.conversions.replaceProductConversions(productId, expectedVersion, entries);
  }
}
