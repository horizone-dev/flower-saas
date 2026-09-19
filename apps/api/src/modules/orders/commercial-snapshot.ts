import { createHash } from 'node:crypto';
import { canonicalize } from '../../common/idempotency/canonical-hash.js';

/**
 * Task 3b.3 Checkpoint B — the ONE authoritative canonical commercial
 * fingerprint (§14), mirroring `posting-fingerprint.ts`'s exact
 * `canonicalize()` + SHA-256 pattern (no duplicate implementation). Every
 * field here is either an authorization-surface identity value or a
 * server-resolved snapshot value — never `createdAt`/`updatedAt`/`id`/audit
 * metadata, and never `status` (Hold/Resume never touch this fingerprint —
 * it represents commercial content only, §20/§21).
 *
 * Line ARRAY ORDER is semantic and preserved as-is (the same convention
 * `canonicalize()` already applies everywhere else in this codebase — object
 * KEYS are sorted, array order is not) — the persisted line order is the
 * canonical ordering.
 */
export interface CommercialSnapshotLine {
  productId: string;
  variantId: string;
  quantity: string;
  selectedUomCode: string;
  baseUomCode: string;
  conversionNumerator: string;
  conversionDenominator: string;
  unitPriceAmountMinor: string;
  unitPriceCurrencyCode: string;
  unitPriceCurrencyExponent: number;
  discountMode: string;
  discountBps: number | null;
  discountAmountMinor: string;
  taxCategoryKey: string | null;
  rateBps: number | null;
  effectiveFrom: string | null;
  resolutionSource: string;
}

export interface CommercialSnapshotInput {
  tenantId: string;
  companyId: string;
  originBranchId: string;
  fulfillingBranchId: string;
  customerId: string | null;
  kind: string;
  currencyCode: string;
  lines: readonly CommercialSnapshotLine[];
  documentDiscountMode: string;
  documentDiscountBps: number | null;
  documentDiscountAmountMinor: string;
  documentDiscountReason: string | null;
}

export function computeCommercialSnapshotFingerprint(input: CommercialSnapshotInput): string {
  const canonical = JSON.stringify(
    canonicalize({
      tenantId: input.tenantId,
      companyId: input.companyId,
      originBranchId: input.originBranchId,
      fulfillingBranchId: input.fulfillingBranchId,
      customerId: input.customerId,
      kind: input.kind,
      currencyCode: input.currencyCode,
      lines: input.lines,
      documentDiscountMode: input.documentDiscountMode,
      documentDiscountBps: input.documentDiscountBps,
      documentDiscountAmountMinor: input.documentDiscountAmountMinor,
      documentDiscountReason: input.documentDiscountReason,
    }),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
