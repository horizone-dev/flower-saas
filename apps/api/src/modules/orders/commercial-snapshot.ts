import { createHash } from 'node:crypto';
import { canonicalize } from '../../common/idempotency/canonical-hash.js';

/**
 * Task 3b.3 Checkpoint B — the authoritative canonical commercial fingerprint
 * (§14), mirroring `posting-fingerprint.ts`'s exact `canonicalize()` + SHA-256
 * pattern (no duplicate implementation). Every field here is either an
 * authorization-surface identity value or a server-resolved snapshot value —
 * never `createdAt`/`updatedAt`/`id`/audit metadata, and never `status`
 * (Hold/Resume never touch this fingerprint — it represents commercial
 * content only, §20/§21).
 *
 * Line ARRAY ORDER is semantic and preserved as-is (the same convention
 * `canonicalize()` already applies everywhere else in this codebase — object
 * KEYS are sorted, array order is not) — the persisted line order is the
 * canonical ordering.
 *
 * Task 3b.4 Checkpoint C — VERSIONED payload dispatch (§C6-C9). Every Order
 * has exactly one of two hash SHAPES, tagged by its own immutable
 * `commercialSnapshotFingerprintVersion` column:
 *   - V1 — the pre-3b.4 shape below, FROZEN FOREVER byte-for-byte. Every
 *     Order that existed before Checkpoint C's migration is permanently V1.
 *   - V2 — the identical V1 payload PLUS the 3 fiscal-policy fields
 *     (`taxPriceMode`/`taxRoundingScope`/`taxRoundingMode`) as top-level
 *     canonical fields. Every Order created from Checkpoint C onward is V2.
 * A caller with an EXISTING persisted Order (PATCH, issuance recompute) MUST
 * use {@link computeCommercialSnapshotFingerprintByVersion} — dispatching on
 * that Order's OWN stored version — never assume the latest shape. A brand
 * new Order always uses {@link computeCommercialSnapshotFingerprintV2}
 * directly. Both versions share the ONE `hashCanonical` primitive — there is
 * no second hashing implementation.
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

/** Task 3b.4 Checkpoint C — the 3 fiscal-policy fields V2 adds on top of the
 *  frozen V1 payload (§C8). Never present in a V1 hash input. */
export interface FiscalPolicySnapshotInput {
  taxPriceMode: string;
  taxRoundingScope: string;
  taxRoundingMode: string;
}

function v1Payload(input: CommercialSnapshotInput): Record<string, unknown> {
  return {
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
  };
}

function hashCanonical(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

/**
 * V1 — FROZEN FOREVER (Task 3b.3's original shape, byte-for-byte identical).
 * Never add a field here — a new concept belongs only in a later version.
 * Every pre-3b.4 Order is permanently V1
 * (`commercialSnapshotFingerprintVersion = 1`).
 */
export function computeCommercialSnapshotFingerprintV1(input: CommercialSnapshotInput): string {
  return hashCanonical(v1Payload(input));
}

/**
 * V2 — the V1 payload plus the 3 fiscal-policy fields resolved once at Order
 * creation (Task 3b.4 §C8). Every Order created from Checkpoint C onward is
 * V2.
 */
export function computeCommercialSnapshotFingerprintV2(
  input: CommercialSnapshotInput,
  policy: FiscalPolicySnapshotInput,
): string {
  return hashCanonical({
    ...v1Payload(input),
    taxPriceMode: policy.taxPriceMode,
    taxRoundingScope: policy.taxRoundingScope,
    taxRoundingMode: policy.taxRoundingMode,
  });
}

/**
 * Version-dispatch helper (§C9) — the ONLY entry point a caller with an
 * EXISTING persisted `commercialSnapshotFingerprintVersion` should use (PATCH,
 * issuance recompute). `policy` is REQUIRED for version 2 and ignored for
 * version 1. An unrecognised version fails closed — never silently assumes
 * the latest shape.
 */
export function computeCommercialSnapshotFingerprintByVersion(
  version: number,
  input: CommercialSnapshotInput,
  policy?: FiscalPolicySnapshotInput,
): string {
  if (version === 1) return computeCommercialSnapshotFingerprintV1(input);
  if (version === 2) {
    if (!policy) {
      throw new RangeError(
        'computeCommercialSnapshotFingerprintByVersion: version 2 requires a fiscal policy snapshot',
      );
    }
    return computeCommercialSnapshotFingerprintV2(input, policy);
  }
  throw new RangeError(
    `computeCommercialSnapshotFingerprintByVersion: unsupported commercialSnapshotFingerprintVersion ${version}`,
  );
}
