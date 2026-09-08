import { Injectable } from '@nestjs/common';
import type { IdentifierCodeType } from '@flower/shared-types';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import {
  IdentifierRepository,
  type CreateIdentifierInput,
  type IdentifierResolution,
  type ItemIdentifierRow,
} from './identifier.repository.js';

/**
 * Task 3.5 / 3.6 identifier orchestration. The ONLY business decisions here are
 * the capability gates:
 *   - a **BARCODE / QR** write (create / reactivate) requires the
 *     `identifiers.barcode_qr` catalog capability enabled (task 3.5);
 *   - creating **pack metadata**, and reactivating an identifier that CARRIES
 *     pack metadata, additionally requires `multi_uom` (task 3.6 §K / FC-5);
 *   - a **SKU** write, and a plain (no-pack) BARCODE / QR reactivate, keep exact
 *     Task 3.5 behaviour;
 *   - every **read** (`catalog:view`) is unaffected by capability state — an
 *     ACTIVE pack identifier stays readable / scannable when `multi_uom` is off;
 *   - a **deactivate** is always allowed.
 *
 * Neither capability has a required entitlement module, so only `assertEnabled`
 * is ever called. Business Type is never consulted (HG3-NO-BT-BRANCH). All data
 * access / concurrency / audit lives in the repository.
 */
@Injectable()
export class IdentifierService {
  constructor(
    private readonly repo: IdentifierRepository,
    private readonly caps: CatalogCapabilityService,
  ) {}

  resolve(value: string): Promise<IdentifierResolution> {
    return this.repo.resolveByValue(value);
  }

  listForVariant(variantId: string): Promise<ItemIdentifierRow[]> {
    return this.repo.listForTarget('VARIANT', variantId);
  }

  async create(input: CreateIdentifierInput): Promise<ItemIdentifierRow> {
    await this.assertBarcodeQrCapability(input.codeType);
    if (input.pack) await this.caps.assertEnabled('multi_uom');
    return this.repo.create(input);
  }

  deactivateOrDelete(id: string): Promise<{ status: 'deactivated' | 'deleted' }> {
    // always allowed — never capability-gated (owner "CAPABILITY")
    return this.repo.deactivateOrDelete(id);
  }

  async reactivate(id: string): Promise<ItemIdentifierRow> {
    const { codeType, hasPack } = await this.repo.peekForReactivate(id);
    await this.assertBarcodeQrCapability(codeType);
    if (hasPack) await this.caps.assertEnabled('multi_uom');
    return this.repo.reactivate(id);
  }

  private async assertBarcodeQrCapability(codeType: IdentifierCodeType): Promise<void> {
    if (codeType !== 'SKU') {
      await this.caps.assertEnabled('identifiers.barcode_qr');
    }
  }
}
