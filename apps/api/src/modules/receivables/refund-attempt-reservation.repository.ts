import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `RefundExecutionRepository`/
// `CreditNoteRepository` exactly): this is an internal primitive that must
// PARTICIPATE in the caller's already-open transaction, never open its own.
import type { ScopedTx } from '@flower/db';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { InvoiceSettlementProjectionRepository } from '../settlements/invoice-settlement-projection.repository.js';
import { assertCustomerAccountEntryReferenceShape } from './customer-account-entry.js';
import { assertRefundAttemptTransition, type RefundAttemptState } from './refund-attempt-state.js';

export interface ReserveProviderRefundAttemptInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerId: string;
  customerAdvanceId: string;
  requestedAmountMinor: bigint;
  idempotencyKey: string;
}

export interface ReservedProviderRefundAttempt {
  refundAttemptId: string;
  state: RefundAttemptState;
  providerKey: string;
  providerCredentialId: string;
  sourcePaymentId: string;
  requestedAmountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  /** true when this call discovered and reused an already-reserved attempt
   *  from a prior (partial or complete) execution of this SAME logical
   *  request — mirrors `ReservedAsyncAttempt.reused` (payments Checkpoint E)
   *  exactly. */
  reused: boolean;
}

export interface ApplyProviderRefundAttemptResultInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  refundAttemptId: string;
  resultState: 'SUCCEEDED' | 'FAILED';
  providerReference: string | null;
  method: 'CARD_TERMINAL' | 'ONLINE_GATEWAY';
  reasonCode: string;
  accountingDate: string;
  actorUserId: string | null;
  failureCode?: string | null;
}

export interface ApplyProviderRefundAttemptResultResult {
  refundAttemptId: string;
  state: RefundAttemptState;
  refundId: string | null;
}

/**
 * Task 3b.8 Checkpoint D (provider-stub reconciliation) — the durable
 * persist-before-provider-I/O foundation for CARD_TERMINAL/ONLINE_GATEWAY
 * refunds. Mirrors `PaymentAttemptReservationRepository`'s own two-phase
 * shape exactly (recovery-discovery, then reserve-if-not-found; apply-result
 * as a SEPARATE later phase). INTERNAL ONLY: no public route calls either
 * method here — `RefundRepository` rejects CARD_TERMINAL/ONLINE_GATEWAY with
 * `501 REFUND_PROVIDER_NOT_IMPLEMENTED` before any transaction and does not
 * inject this class — so it is exercised directly by tests until the
 * provider-integration checkpoint wires it in.
 *
 * `PaymentProvider.refund(...)`/`getStatus(...)` are NEVER called from
 * anywhere in this file — their request/response shapes are undefined
 * anywhere in this repository (`payment-provider.port.ts`'s own doc comment:
 * "shape deferred to a future refund task" / "deferred to F+"), and
 * inventing either would be a Payment-module port-design decision outside
 * this checkpoint's authorized scope. `reserveProviderRefundAttemptInTx`
 * persists the PENDING attempt durably and returns; the provider-integration
 * checkpoint's caller is what will perform the (not yet definable)
 * provider call, outside any transaction, using this attempt's own identity.
 *
 * `applyProviderRefundAttemptResultInTx` is the SEPARATE confirmation-phase
 * primitive a future `getStatus`/webhook integration would call once that
 * contract exists — fully implemented and tested here (directly, as an
 * internal primitive, exactly like `InvoiceIssuanceRepository.
 * issueFinalInvoice`) so the "Refund row is NEVER created before confirmed
 * provider success" invariant is proven correct NOW, even though no live
 * caller exists yet.
 */
@Injectable()
export class RefundAttemptReservationRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
    private readonly settlementProjection: InvoiceSettlementProjectionRepository,
  ) {}

  async reserveProviderRefundAttemptInTx(
    tx: ScopedTx,
    input: ReserveProviderRefundAttemptInput,
  ): Promise<ReservedProviderRefundAttempt> {
    // ── 0. transaction-scoped advisory lock, keyed by (tenantId,
    //      idempotencyKey) — serializes any two concurrent calls carrying
    //      the SAME Idempotency-Key, without a new DB unique constraint
    //      (`refund_attempt.idempotencyKey` has no unique index — migration
    //      44 never added one, unlike `payment_attempt`'s own dedicated
    //      Checkpoint E uniqueness migration). Released automatically at
    //      COMMIT/ROLLBACK — never held across transactions. ──────────────
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.tenantId}:${input.idempotencyKey}`}, 0))`;

    // ── 1. recovery discovery — an existing row with this EXACT
    //      idempotencyKey, within this tenant, is either a genuine replay
    //      (same semantics — reuse it) or a key-reuse conflict (different
    //      semantics — reject). ──────────────────────────────────────────
    const existingRows = await tx.$queryRaw<
      {
        id: string;
        state: string;
        providerKey: string;
        providerCredentialId: string;
        sourcePaymentId: string;
        requestedAmountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
      }[]
    >`
      SELECT "id", "state", "providerKey", "providerCredentialId", "sourcePaymentId",
             "requestedAmountMinor", "currencyCode", "currencyExponent"
        FROM "refund_attempt"
       WHERE "tenantId" = ${input.tenantId}::uuid AND "idempotencyKey" = ${input.idempotencyKey}`;
    const existing = existingRows[0];
    if (existing) {
      const reservationRows = await tx.$queryRaw<{ customerAdvanceId: string }[]>`
        SELECT "customerAdvanceId" FROM "refund_attempt_entitlement_reservation"
         WHERE "refundAttemptId" = ${existing.id}::uuid`;
      const sameAdvance = reservationRows.some(
        (r) => r.customerAdvanceId === input.customerAdvanceId,
      );
      if (!sameAdvance || existing.requestedAmountMinor !== input.requestedAmountMinor) {
        throw new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'this Idempotency-Key was already used for a different refund request',
          409,
        );
      }
      return {
        refundAttemptId: existing.id,
        state: existing.state as RefundAttemptState,
        providerKey: existing.providerKey,
        providerCredentialId: existing.providerCredentialId,
        sourcePaymentId: existing.sourcePaymentId,
        requestedAmountMinor: existing.requestedAmountMinor,
        currencyCode: existing.currencyCode,
        currencyExponent: existing.currencyExponent,
        reused: true,
      };
    }

    // ── 2. join-gated CustomerCompanyAccount + locked CustomerAdvance —
    //      identical shape to `RefundExecutionRepository`'s own local path. ─
    const accountRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT cca."id"
        FROM "customer_company_account" cca
        INNER JOIN "customer" c ON c."tenantId" = cca."tenantId" AND c."id" = cca."customerId"
       WHERE cca."tenantId" = ${input.tenantId}::uuid
         AND cca."companyId" = ${input.companyId}::uuid
         AND cca."customerId" = ${input.customerId}::uuid
       FOR UPDATE OF cca`;
    const account = accountRows[0];
    if (!account) {
      throw new DomainError(
        'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND',
        'this customer is not associated with the current company',
        404,
      );
    }

    const advanceRows = await tx.$queryRaw<
      {
        id: string;
        sourceType: string;
        amountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
      }[]
    >`
      SELECT "id", "sourceType", "amountMinor", "currencyCode", "currencyExponent"
        FROM "customer_advance"
       WHERE "id" = ${input.customerAdvanceId}::uuid
         AND "customerCompanyAccountId" = ${account.id}::uuid
         AND "branchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    const advance = advanceRows[0];
    if (!advance) throw new NotFoundError('customer_advance', 'CUSTOMER_ADVANCE_NOT_FOUND');
    if (advance.sourceType !== 'CREDIT_NOTE') {
      throw new DomainError(
        'REFUND_SOURCE_NOT_CREDIT_NOTE',
        'only a CREDIT_NOTE-sourced customer advance can be refunded in this task',
        422,
      );
    }

    // ── 3. authoritative credential/Payment provenance — NEVER caller-
    //      supplied, NEVER invented. Chain: CustomerAdvance (1:1) ->
    //      CreditNoteCoverageRelease.sourcePaymentId -> Payment.sourceAttemptId
    //      -> PaymentAttempt.providerCredentialId/providerKey. This is the
    //      SAME credential the ORIGINAL capture used — never a freshly
    //      re-resolved "current" one (mirrors `createIntent`'s own frozen
    //      "a recovered attempt reuses the ORIGINAL credential" contract). ──
    const chainRows = await tx.$queryRaw<
      {
        sourcePaymentId: string | null;
        providerCredentialId: string | null;
        providerKey: string | null;
        paymentMethod: string | null;
      }[]
    >`
      SELECT r."sourcePaymentId", pa."providerCredentialId", pa."providerKey", p."method" AS "paymentMethod"
        FROM "credit_note_coverage_release" r
        LEFT JOIN "payment" p ON p.id = r."sourcePaymentId"
        LEFT JOIN "payment_attempt" pa ON pa.id = p."sourceAttemptId"
       WHERE r."customerAdvanceId" = ${advance.id}::uuid`;
    const chain = chainRows[0];
    if (!chain || !chain.sourcePaymentId) {
      throw new DomainError(
        'REFUND_ADVANCE_HAS_NO_PAYMENT_PROVENANCE',
        'this advance has no underlying Payment to refund against (OPENING_ADVANCE-sourced releases can never fund a Refund)',
        422,
      );
    }
    if (!chain.providerCredentialId || !chain.providerKey) {
      throw new DomainError(
        'REFUND_SOURCE_PAYMENT_NOT_PROVIDER_BACKED',
        'the original Payment behind this advance was not provider-backed (CASH/BANK_TRANSFER/OTHER_MANUAL) — a provider-backed refund has no credential to execute against; request a CASH/BANK_TRANSFER refund instead',
        422,
      );
    }

    // ── 4. PROVIDER_REFUND_REQUIRES_FULL_SETTLEMENT — the schema's own
    //      frozen gate (`RefundAttempt`'s own doc comment), reusing the
    //      EXACT 3b.7 predicate, never a duplicate arithmetic
    //      implementation. ─────────────────────────────────────────────────
    const settlementFinal = await this.settlementProjection.isPaymentSettlementFinal(
      tx,
      chain.sourcePaymentId,
    );
    if (!settlementFinal) {
      throw new DomainError(
        'PROVIDER_REFUND_REQUIRES_FULL_SETTLEMENT',
        'a provider-backed refund requires the source Payment to be fully settlement-final',
        409,
      );
    }

    // ── 5. available remaining balance — identical formula to the local
    //      refund path. ─────────────────────────────────────────────────────
    const appliedRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total
        FROM "customer_advance_application" WHERE "customerAdvanceId" = ${advance.id}::uuid`;
    const refundedRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total
        FROM "customer_advance_refund_application" WHERE "customerAdvanceId" = ${advance.id}::uuid`;
    const reservedRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(rr."amountMinor"), 0)::bigint AS total
        FROM "refund_attempt_entitlement_reservation" rr
        JOIN "refund_attempt" ra ON ra.id = rr."refundAttemptId"
       WHERE rr."customerAdvanceId" = ${advance.id}::uuid AND ra."state" = 'PENDING'`;
    const consumed = appliedRows[0]!.total + refundedRows[0]!.total + reservedRows[0]!.total;
    const available = advance.amountMinor - consumed;
    if (input.requestedAmountMinor > available) {
      throw new DomainError(
        'REFUND_EXCEEDS_AVAILABLE_ADVANCE',
        `requested refund amount ${input.requestedAmountMinor} exceeds this advance's available balance ${available}`,
        409,
      );
    }

    // ── 6. durable PENDING attempt — persisted BEFORE any provider call
    //      (none is ever made by this checkpoint's own code). ──────────────
    const attempt = await tx.refundAttempt.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        sourcePaymentId: chain.sourcePaymentId,
        requestedAmountMinor: input.requestedAmountMinor,
        currencyCode: advance.currencyCode,
        currencyExponent: advance.currencyExponent,
        providerCredentialId: chain.providerCredentialId,
        providerKey: chain.providerKey,
        idempotencyKey: input.idempotencyKey,
      },
    });

    await tx.refundAttemptEntitlementReservation.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        refundAttemptId: attempt.id,
        creditNoteCoverageReleaseId: (
          await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "credit_note_coverage_release" WHERE "customerAdvanceId" = ${advance.id}::uuid`
        )[0]!.id,
        customerAdvanceId: advance.id,
        amountMinor: input.requestedAmountMinor,
        currencyCode: advance.currencyCode,
        currencyExponent: advance.currencyExponent,
      },
    });

    return {
      refundAttemptId: attempt.id,
      state: 'PENDING',
      providerKey: chain.providerKey,
      providerCredentialId: chain.providerCredentialId,
      sourcePaymentId: chain.sourcePaymentId,
      requestedAmountMinor: input.requestedAmountMinor,
      currencyCode: advance.currencyCode,
      currencyExponent: advance.currencyExponent,
      reused: false,
    };
  }

  /**
   * The confirmation phase — called ONLY once a real `getStatus`/webhook
   * contract exists and reports a definitive outcome (never by this
   * checkpoint's own stub path). `SUCCEEDED` creates the immutable `Refund`
   * (mirrors `RefundExecutionRepository`'s own local-path tail exactly:
   * `CustomerAdvanceRefundApplication` + `CustomerAccountEntry(REFUND)` +
   * `advanceBalanceMinor` decrement + GL); `FAILED` releases the reservation
   * (no financial effect — the entitlement reservation's own `state='PENDING'`
   * exclusion in the available-balance SUM above means a FAILED/SUCCEEDED
   * attempt's reservation no longer holds capacity hostage).
   */
  async applyProviderRefundAttemptResultInTx(
    tx: ScopedTx,
    input: ApplyProviderRefundAttemptResultInput,
  ): Promise<ApplyProviderRefundAttemptResultResult> {
    const attemptRows = await tx.$queryRaw<
      {
        state: string;
        requestedAmountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
        sourcePaymentId: string;
      }[]
    >`
      SELECT "state", "requestedAmountMinor", "currencyCode", "currencyExponent", "sourcePaymentId"
        FROM "refund_attempt"
       WHERE "id" = ${input.refundAttemptId}::uuid AND "tenantId" = ${input.tenantId}::uuid
       FOR UPDATE`;
    const attempt = attemptRows[0];
    if (!attempt) throw new NotFoundError('refund_attempt', 'REFUND_ATTEMPT_NOT_FOUND');

    const currentState = attempt.state as RefundAttemptState;
    if (currentState !== 'PENDING') {
      // already durably resolved — idempotent no-op (never a second
      // provider-success Refund creation, never a FAILED->SUCCEEDED flip).
      const resultingRows = await tx.$queryRaw<{ resultingRefundId: string | null }[]>`
        SELECT "resultingRefundId" FROM "refund_attempt" WHERE "id" = ${input.refundAttemptId}::uuid`;
      return {
        refundAttemptId: input.refundAttemptId,
        state: currentState,
        refundId: resultingRows[0]?.resultingRefundId ?? null,
      };
    }
    assertRefundAttemptTransition(currentState, input.resultState);

    if (input.resultState === 'FAILED') {
      await tx.refundAttempt.update({
        where: { id: input.refundAttemptId },
        data: {
          state: 'FAILED',
          providerReference: input.providerReference,
          failureCode: input.failureCode ?? null,
        },
      });
      return { refundAttemptId: input.refundAttemptId, state: 'FAILED', refundId: null };
    }

    // ── SUCCEEDED — the money-out fact is created ONLY here, never earlier. ─
    const reservationRows = await tx.$queryRaw<{ customerAdvanceId: string }[]>`
      SELECT "customerAdvanceId" FROM "refund_attempt_entitlement_reservation"
       WHERE "refundAttemptId" = ${input.refundAttemptId}::uuid`;
    const customerAdvanceId = reservationRows[0]!.customerAdvanceId;

    const advanceRows = await tx.$queryRaw<{ customerCompanyAccountId: string }[]>`
      SELECT "customerCompanyAccountId" FROM "customer_advance" WHERE "id" = ${customerAdvanceId}::uuid FOR UPDATE`;
    const customerCompanyAccountId = advanceRows[0]!.customerCompanyAccountId;

    const refund = await tx.refund.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        sourcePaymentId: attempt.sourcePaymentId,
        sourceRefundAttemptId: input.refundAttemptId,
        amountMinor: attempt.requestedAmountMinor,
        currencyCode: attempt.currencyCode,
        currencyExponent: attempt.currencyExponent,
        method: input.method,
        reasonCode: input.reasonCode,
        accountingDate: new Date(`${input.accountingDate}T00:00:00.000Z`),
        createdByUserId: input.actorUserId ?? null,
      },
    });

    await tx.refundAttempt.update({
      where: { id: input.refundAttemptId },
      data: {
        state: 'SUCCEEDED',
        providerReference: input.providerReference,
        resultingRefundId: refund.id,
      },
    });

    const application = await tx.customerAdvanceRefundApplication.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerAdvanceId,
        refundId: refund.id,
        amountMinor: attempt.requestedAmountMinor,
        currencyCode: attempt.currencyCode,
        currencyExponent: attempt.currencyExponent,
      },
    });

    assertCustomerAccountEntryReferenceShape('REFUND', {
      customerAdvanceRefundApplicationId: application.id,
    });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId,
        entryKind: 'REFUND',
        customerAdvanceRefundApplicationId: application.id,
      },
    });

    await tx.customerCompanyAccount.update({
      where: { id: customerCompanyAccountId },
      data: { advanceBalanceMinor: { decrement: attempt.requestedAmountMinor } },
    });

    // Dr LIABILITY.CUSTOMER_ADVANCES / Cr ASSET.PAYMENT_CLEARING — a
    // provider-backed payout is not yet confirmed cash/bank (mirrors
    // `ASSET.PAYMENT_CLEARING`'s own existing role as the in-flight-provider-
    // settlement clearing account, never `ASSET.CASH_ON_HAND`/`ASSET.BANK`,
    // which are reserved for already-realized local tender).
    await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'refund',
      sourceId: refund.id,
      lines: [
        {
          accountKey: 'LIABILITY.CUSTOMER_ADVANCES',
          direction: 'debit',
          amountMinor: attempt.requestedAmountMinor,
        },
        {
          accountKey: 'ASSET.PAYMENT_CLEARING',
          direction: 'credit',
          amountMinor: attempt.requestedAmountMinor,
        },
      ],
      accountingDate: input.accountingDate,
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'refund.completed',
      resourceType: 'refund',
      resourceId: refund.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      actorUserId: input.actorUserId ?? null,
      after: {
        customerAdvanceId,
        amountMinor: attempt.requestedAmountMinor.toString(),
        currencyCode: attempt.currencyCode,
        method: input.method,
        refundAttemptId: input.refundAttemptId,
      },
    });

    return { refundAttemptId: input.refundAttemptId, state: 'SUCCEEDED', refundId: refund.id };
  }
}
