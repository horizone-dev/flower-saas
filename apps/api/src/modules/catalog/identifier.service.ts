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
 * Task 3.5 identifier orchestration. The ONLY business decision here is the
 * capability gate (owner "CAPABILITY"):
 *   - a **BARCODE / QR** write (create / reactivate) requires the
 *     `identifiers.barcode_qr` catalog capability enabled;
 *   - a **SKU** write does NOT (a SKU is a basic catalog attribute);
 *   - every **read** (`catalog:view`) is unaffected by capability state;
 *   - a **deactivate** is always allowed — disabling the capability must never
 *     leave the owner unable to retire a code.
 *
 * `identifiers.barcode_qr` has no required entitlement module, so only
 * `assertEnabled` is ever called (never `assertEntitledFor`). Business Type is
 * never consulted (HG3-NO-BT-BRANCH). All data access / concurrency / audit
 * lives in the repository.
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
    return this.repo.create(input);
  }

  deactivateOrDelete(id: string): Promise<{ status: 'deactivated' | 'deleted' }> {
    // always allowed — never capability-gated (owner "CAPABILITY")
    return this.repo.deactivateOrDelete(id);
  }

  async reactivate(id: string): Promise<ItemIdentifierRow> {
    const codeType = await this.repo.peekCodeType(id);
    await this.assertBarcodeQrCapability(codeType);
    return this.repo.reactivate(id);
  }

  private async assertBarcodeQrCapability(codeType: IdentifierCodeType): Promise<void> {
    if (codeType !== 'SKU') {
      await this.caps.assertEnabled('identifiers.barcode_qr');
    }
  }
}
