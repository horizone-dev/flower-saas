import type { ScopedTx } from '@flower/db';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.7 Checkpoint C — the ONE reusable settlement Payment eligibility/
 * matching authority. Both automatic providerReference matching and explicit
 * proposed-payment matching call `assertPaymentEligible` — never a duplicated
 * rule set (frozen Checkpoint A/B eligibility predicate):
 *
 *   Payment.providerKey IS NOT NULL
 *   Payment tenant/company/branch = Batch tenant/company/branch
 *   Payment.sourceAttemptId -> PaymentAttempt.providerCredentialId = Batch.providerCredentialId
 *   Payment currencyCode/currencyExponent = Batch currencyCode/currencyExponent
 *
 * CASH / BANK_TRANSFER / OTHER_MANUAL Payments never carry a `providerKey`
 * (frozen 3b.5 `isProviderBackedTender`), so the first predicate alone
 * already excludes them — no separate `method` check is needed. This is a
 * read-only check: matching is evidence selection, not capacity consumption
 * (Checkpoint B/D's SettlementApplication owns Payment capacity locking) —
 * no `FOR UPDATE` here, ever.
 */
export interface SettlementMatchScope {
  tenantId: string;
  companyId: string;
  branchId: string;
  providerCredentialId: string;
  currencyCode: string;
  currencyExponent: number;
}

interface PaymentEligibilityRow {
  id: string;
  tenantId: string;
  companyId: string;
  branchId: string;
  providerKey: string | null;
  currencyCode: string;
  currencyExponent: number;
  fundingProviderCredentialId: string | null;
}

function notEligible(reason: string): DomainError {
  // deliberately ONE stable code for every reason — never leaks WHICH
  // predicate failed to the caller (matches the frozen error contract).
  return new DomainError('SETTLEMENT_PAYMENT_NOT_ELIGIBLE', reason, 422);
}

/** Re-validates a PROPOSED (or auto-matched candidate) Payment against the
 *  complete frozen eligibility predicate. Throws `SETTLEMENT_PAYMENT_NOT_ELIGIBLE`
 *  (422) on any failure — never partial-trusts a caller-supplied or
 *  join-derived candidate. */
export async function assertPaymentEligible(
  tx: ScopedTx,
  scope: SettlementMatchScope,
  paymentId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<PaymentEligibilityRow[]>`
    SELECT p."id", p."tenantId", p."companyId", p."branchId", p."providerKey",
           p."currencyCode", p."currencyExponent",
           pa."providerCredentialId" AS "fundingProviderCredentialId"
      FROM "payment" p
      JOIN "payment_attempt" pa ON pa."id" = p."sourceAttemptId"
     WHERE p."id" = ${paymentId}::uuid`;
  const row = rows[0];
  if (!row) throw notEligible('payment does not exist');
  if (row.providerKey === null) {
    throw notEligible(
      'payment is not provider-backed (CASH/BANK_TRANSFER/OTHER_MANUAL are never settlement-eligible)',
    );
  }
  if (
    row.tenantId !== scope.tenantId ||
    row.companyId !== scope.companyId ||
    row.branchId !== scope.branchId
  ) {
    throw notEligible('payment scope does not match batch scope');
  }
  if (row.fundingProviderCredentialId !== scope.providerCredentialId) {
    throw notEligible(
      'payment funding providerCredentialId does not match batch providerCredentialId',
    );
  }
  if (row.currencyCode !== scope.currencyCode || row.currencyExponent !== scope.currencyExponent) {
    throw notEligible('payment currency does not match batch currency');
  }
}

/**
 * Deterministic providerReference auto-match. Path:
 *   Batch.providerCredentialId + Line.providerReference
 *     -> payment_attempt (UNIQUE on (providerCredentialId, providerReference)
 *        WHERE both NOT NULL — `20260924120000_payments_provider_reference_uniqueness`)
 *     -> Payment.sourceAttemptId -> eligible Payment
 *
 * The DB unique index already makes true ambiguity structurally impossible;
 * the `rows.length > 1` branch is defensive fail-closed only (never picks
 * arbitrarily, never fuzzy/amount-only matching). Returns `null` (leave
 * unmatched) when no candidate exists — never throws for "no match found".
 */
export async function autoMatchByProviderReference(
  tx: ScopedTx,
  scope: SettlementMatchScope,
  providerReference: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ paymentId: string }[]>`
    SELECT p."id" AS "paymentId"
      FROM "payment_attempt" pa
      JOIN "payment" p ON p."sourceAttemptId" = pa."id"
     WHERE pa."providerCredentialId" = ${scope.providerCredentialId}::uuid
       AND pa."providerReference" = ${providerReference}`;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw notEligible(
      'ambiguous providerReference match — more than one candidate Payment resolved',
    );
  }
  const candidatePaymentId = rows[0]!.paymentId;
  await assertPaymentEligible(tx, scope, candidatePaymentId);
  return candidatePaymentId;
}
