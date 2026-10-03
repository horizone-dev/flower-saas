import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `CreditNoteRepository`/
// `CancellationChargeRepository`/`PostingEngineService` exactly): this is an
// internal primitive that must PARTICIPATE in the caller's already-open
// transaction, never open its own.
import type { ScopedTx } from '@flower/db';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { assertCustomerAccountEntryReferenceShape } from './customer-account-entry.js';

export interface ExecuteLocalRefundInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerId: string;
  customerAdvanceId: string;
  requestedAmountMinor: bigint;
  method: 'CASH' | 'BANK_TRANSFER';
  reasonCode: string;
  accountingDate: string;
  actorUserId: string | null;
}

export interface ExecuteLocalRefundResult {
  refundId: string;
  amountMinor: bigint;
  currencyCode: string;
}

const LOCAL_REFUND_CASH_OR_BANK_ACCOUNT: Readonly<Record<'CASH' | 'BANK_TRANSFER', string>> =
  Object.freeze({
    CASH: 'ASSET.CASH_ON_HAND',
    BANK_TRANSFER: 'ASSET.BANK',
  });

/**
 * Task 3b.8 Checkpoint D — the separate, later, explicit Refund execution
 * primitive (ADR-0019 §19/§27 — "account credit is not a refund"; the
 * CreditNote issuance path NEVER creates a `Refund` itself, only a
 * CREDIT_NOTE-sourced `CustomerAdvance`). NOT HTTP-exposed directly (called
 * only via `RefundRepository`). Supports CASH/BANK_TRANSFER ONLY in this
 * checkpoint — both are "final immediately" local tenders with an existing,
 * complete GL account mapping and no provider dependency. CARD_TERMINAL/
 * ONLINE_GATEWAY/OTHER_MANUAL are rejected by `RefundRepository` before this
 * is ever called (provider-backed refunds additionally need the
 * `PaymentProvider.refund`/`getStatus` contract, which is not yet defined —
 * see `RefundAttemptReservationRepository` for the internal foundation that
 * will serve them).
 *
 * A `Refund` is immutable, append-only, provider-independent here
 * (`sourceRefundAttemptId = null` — `Refund`'s own schema doc comment: "NULL
 * for a local synchronous Refund"). Drains a SPECIFIC CREDIT_NOTE-sourced
 * `CustomerAdvance` (never a cross-advance pool, never a split across
 * multiple advances in one call — owner-approved narrowing, mirrors
 * `CreditNoteRepository`'s own "no split resolution" scope). An
 * OPENING_ADVANCE-sourced release can never fund a Refund (the schema's own
 * frozen rule — no Payment provenance exists to satisfy the entitlement).
 */
@Injectable()
export class RefundExecutionRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
  ) {}

  async executeLocalRefundInTx(
    tx: ScopedTx,
    input: ExecuteLocalRefundInput,
  ): Promise<ExecuteLocalRefundResult> {
    // ── 1. join-gated CustomerCompanyAccount resolution — NEVER a client-
    //      supplied account id, derived only from the trusted route
    //      (tenantId, companyId, customerId). ─────────────────────────────
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

    // ── 2. lock the target CustomerAdvance, proven to belong to THIS
    //      customer's own account AND to the ROUTE's branch — a wrong-
    //      customer/wrong-advance id can never be reached, and neither can an
    //      Advance that lives in a SIBLING branch (Branch is THE operational
    //      data boundary, CLAUDE.md rule 8; the exact rule
    //      `CustomerAdvanceApplicationRepository` already enforces: "an
    //      operator scoped to a different branch cannot reach in"). Without
    //      this predicate a branch-B-scoped operator could drain branch A's
    //      Advance through branch B's URL and the cash would be booked to
    //      branch B. Non-disclosing: the same 404 as an unknown id. ─────────
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

    // ── 3. the 1:1 funding CreditNoteCoverageRelease — resolves the
    //      authoritative `sourcePaymentId` (never caller-supplied) and
    //      rejects an OPENING_ADVANCE-sourced release (no Payment
    //      provenance — the schema's own frozen entitlement rule). ────────
    const releaseRows = await tx.$queryRaw<
      { sourceKind: string; sourcePaymentId: string | null }[]
    >`
      SELECT "sourceKind", "sourcePaymentId" FROM "credit_note_coverage_release"
       WHERE "customerAdvanceId" = ${advance.id}::uuid`;
    const release = releaseRows[0];
    if (!release || !release.sourcePaymentId) {
      throw new DomainError(
        'REFUND_ADVANCE_HAS_NO_PAYMENT_PROVENANCE',
        'this advance has no underlying Payment to refund against (OPENING_ADVANCE-sourced releases can never fund a Refund)',
        422,
      );
    }

    // ── 4. available remaining balance — consumed by an ADVANCE_APPLIED
    //      application, a prior REFUND against this SAME advance, OR a
    //      currently-PENDING provider-backed `RefundAttempt`'s own
    //      reservation (cross-path consistency with
    //      `RefundAttemptReservationRepository` — a PENDING provider attempt
    //      holds capacity hostage exactly like an already-completed local
    //      refund, preventing this synchronous path from double-spending the
    //      SAME advance). Never re-derived from a stored running total. ─────
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

    // ── 5. the immutable money-out fact — sourceRefundAttemptId = null
    //      (local, synchronous; never a provider-backed row). ─────────────
    const refund = await tx.refund.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        sourcePaymentId: release.sourcePaymentId,
        amountMinor: input.requestedAmountMinor,
        currencyCode: advance.currencyCode,
        currencyExponent: advance.currencyExponent,
        method: input.method,
        reasonCode: input.reasonCode,
        accountingDate: new Date(`${input.accountingDate}T00:00:00.000Z`),
        createdByUserId: input.actorUserId ?? null,
      },
    });

    const application = await tx.customerAdvanceRefundApplication.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerAdvanceId: advance.id,
        refundId: refund.id,
        amountMinor: input.requestedAmountMinor,
        currencyCode: advance.currencyCode,
        currencyExponent: advance.currencyExponent,
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
        customerCompanyAccountId: account.id,
        entryKind: 'REFUND',
        customerAdvanceRefundApplicationId: application.id,
      },
    });

    // ── 6. projection — draining an Advance decreases `advanceBalanceMinor`
    //      only (mirrors `customer-advance-application.repository.ts`'s own
    //      ADVANCE_APPLIED precedent exactly); `currentOutstandingMinor` is
    //      untouched (a Refund never affects outstanding AR). ─────────────
    await tx.customerCompanyAccount.update({
      where: { id: account.id },
      data: { advanceBalanceMinor: { decrement: input.requestedAmountMinor } },
    });

    // ── 7. GL — Dr LIABILITY.CUSTOMER_ADVANCES (the liability is settled) /
    //      Cr ASSET.CASH_ON_HAND or ASSET.BANK (real cash leaves the
    //      business). NEVER `LIABILITY.REFUND_PAYABLE` (reserved for a
    //      recognized-but-not-yet-paid-out refund liability — not this
    //      synchronous, already-paid-out local refund). ────────────────────
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
          amountMinor: input.requestedAmountMinor,
        },
        {
          accountKey: LOCAL_REFUND_CASH_OR_BANK_ACCOUNT[input.method],
          direction: 'credit',
          amountMinor: input.requestedAmountMinor,
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
        customerAdvanceId: advance.id,
        amountMinor: input.requestedAmountMinor.toString(),
        currencyCode: advance.currencyCode,
        method: input.method,
      },
    });

    return {
      refundId: refund.id,
      amountMinor: input.requestedAmountMinor,
      currencyCode: advance.currencyCode,
    };
  }
}
