/**
 * Task 3b.9 Checkpoint D — the PURE authority metadata of a completed sale.
 *
 * Checkpoint D adds no HTTP route, so nothing here enforces anything: this module
 * only DESCRIBES which registered permission keys the composed effects of a sale
 * correspond to, so the public route (Checkpoint E) can gate each one separately.
 * No new permission is introduced — every key below is already in the registry
 * (`@flower/permissions`; a test pins that).
 *
 * The three authorities are INDEPENDENT axes (CLAUDE.md rule 13):
 *
 *   payments:collect            local tenders are captured (a cashier's authority)
 *   receivables:advance:apply   a CustomerAdvance is spent against the sale
 *   customers:credit:override   the credit-limit override was actually USED
 *
 * Spending an advance NEVER inherits `payments:collect` (an advance-only sale
 * captures no tender and requires only `receivables:advance:apply`), and
 * `payments:collect` never grants advance use. The credit override is reported
 * only when the server found it NECESSARY and the frozen
 * `CreditOverrideAuthorizationService.authorize` accepted it — a reason alone is
 * never an authority.
 *
 * PURE: no DB, no clock, no side effect.
 */
export const SALE_PAYMENT_COLLECTION_AUTHORITY = 'payments:collect' as const;
export const SALE_ADVANCE_APPLICATION_AUTHORITY = 'receivables:advance:apply' as const;
export const SALE_CREDIT_OVERRIDE_AUTHORITY = 'customers:credit:override' as const;

export interface SaleAuthorityRequirements {
  /** at least one local tender is captured */
  readonly paymentCollection: boolean;
  /** at least one CustomerAdvance is applied */
  readonly advanceApplication: boolean;
  /** the credit-limit override was necessary AND authorized for this sale */
  readonly creditOverride: boolean;
  /** the registered permission keys the above correspond to — sorted, no duplicates */
  readonly permissionKeys: readonly string[];
}

export interface SaleAuthorityInput {
  readonly tenderCount: number;
  readonly advanceCount: number;
  readonly creditOverrideUsed: boolean;
}

export function saleAuthorityRequirements(input: SaleAuthorityInput): SaleAuthorityRequirements {
  if (
    !Number.isInteger(input.tenderCount) ||
    input.tenderCount < 0 ||
    !Number.isInteger(input.advanceCount) ||
    input.advanceCount < 0
  ) {
    throw new RangeError('saleAuthorityRequirements: counts must be non-negative integers');
  }
  const paymentCollection = input.tenderCount > 0;
  const advanceApplication = input.advanceCount > 0;
  const creditOverride = input.creditOverrideUsed === true;
  const permissionKeys = [
    ...(paymentCollection ? [SALE_PAYMENT_COLLECTION_AUTHORITY] : []),
    ...(advanceApplication ? [SALE_ADVANCE_APPLICATION_AUTHORITY] : []),
    ...(creditOverride ? [SALE_CREDIT_OVERRIDE_AUTHORITY] : []),
  ].sort();
  return Object.freeze({
    paymentCollection,
    advanceApplication,
    creditOverride,
    permissionKeys: Object.freeze(permissionKeys),
  });
}
