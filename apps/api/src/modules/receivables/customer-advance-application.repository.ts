import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors every other 3b.6 internal
// primitive): PARTICIPATES in the caller's already-open transaction, never
// opens its own.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { applyAdvance } from './advance-application.js';
import { loadAdvanceBalances, loadReceivableBalances } from './receivable-balance.repository.js';
import { assertCustomerAccountEntryReferenceShape } from './customer-account-entry.js';
import { CustomerReceiptEffectsRepository } from './customer-receipt-effects.repository.js';
import type { ReceivablesEventType } from './receivables-events.js';

export interface ApplyCustomerAdvanceInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerId: string;
  advanceId: string;
  customerReceivableId: string;
  amountMinor: bigint;
  actorUserId?: string | null;
}

export interface ApplyCustomerAdvanceResult {
  applicationId: string;
  advanceId: string;
  customerReceivableId: string;
  amountMinor: bigint;
  remainingAdvanceMinor: bigint;
  receivableOutstandingMinor: bigint;
  invoicePaymentStatus: string | null;
}

/**
 * Task 3b.6 Checkpoint E (E11-E19) — the explicit, user-directed
 * CustomerAdvance -> CustomerReceivable application primitive. Supports an
 * INVOICE-sourced, an OPENING-sourced and (task 3b.8 Integration Closure) a
 * CANCELLATION_CHARGE-sourced target receivable generically (E12/E30) — this
 * code never branches on the Advance's OWN `sourceType` (PAYMENT / OPENING /
 * CREDIT_NOTE), only on the TARGET receivable's. No FIFO, no auto-selection —
 * the caller names the exact receivable (E11). Creates NO PaymentAllocation —
 * no new money is being received (E12).
 *
 * Canonical lock order (B15, reused verbatim): coverage-anchor (the
 * underlying Invoice row for an INVOICE-sourced target, the
 * CustomerReceivable row itself for OPENING) -> CustomerCompanyAccount ->
 * CustomerAdvance — B's own `customer_advance_application` trigger already
 * locks coverage-anchor then CustomerAdvance in exactly this order; this
 * repository inserts the CustomerCompanyAccount lock IN BETWEEN (acquired
 * by application code before the INSERT that fires the trigger), producing
 * the identical global partial order with no cycle risk.
 *
 * B15's schema is deliberately branch-permissive for a CustomerAdvance's own
 * cross-branch use (the DB only enforces tenant+company scope between an
 * application row and its target receivable — see the core-schema
 * migration's own "Same/cross-branch application is intentionally allowed"
 * comment). Task 3b.6 Checkpoint E's OWN frozen policy (E5) is narrower —
 * "No cross-branch advance pooling in 3b.6" — so this repository enforces
 * `advance.branchId === receivable.branchId` itself, in application code,
 * as a genuine business rule the DB does not (yet) structurally require.
 */
@Injectable()
export class CustomerAdvanceApplicationRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
    private readonly receiptEffects: CustomerReceiptEffectsRepository,
    private readonly outbox: OutboxWriter,
  ) {}

  async applyInTx(
    tx: ScopedTx,
    input: ApplyCustomerAdvanceInput,
  ): Promise<ApplyCustomerAdvanceResult> {
    if (input.amountMinor <= 0n) {
      throw new DomainError('PAYMENT_INVALID_AMOUNT', 'amountMinor must be > 0', 422);
    }

    // ── 1. unlocked peeks — decide WHAT to lock and in what order; the
    //      TRUSTED route customerId join-gates the Advance (E4/E35, "wrong
    //      customer: denied"). ──────────────────────────────────────────
    const advancePeekRows = await tx.$queryRaw<
      { id: string; branchId: string; customerCompanyAccountId: string }[]
    >`
      SELECT ca."id", ca."branchId", ca."customerCompanyAccountId"
        FROM "customer_advance" ca
        INNER JOIN "customer_company_account" cca ON cca."id" = ca."customerCompanyAccountId"
       WHERE ca."id" = ${input.advanceId}::uuid
         AND ca."tenantId" = ${input.tenantId}::uuid
         AND ca."companyId" = ${input.companyId}::uuid
         AND cca."customerId" = ${input.customerId}::uuid`;
    const advancePeek = advancePeekRows[0];
    if (!advancePeek) {
      throw new NotFoundError('customer_advance', 'CUSTOMER_ADVANCE_NOT_FOUND');
    }

    const receivablePeekRows = await tx.$queryRaw<
      {
        id: string;
        sourceType: string;
        branchId: string;
        invoiceId: string | null;
        customerCompanyAccountId: string;
      }[]
    >`
      SELECT "id", "sourceType", "branchId", "invoiceId", "customerCompanyAccountId"
        FROM "customer_receivable"
       WHERE "id" = ${input.customerReceivableId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid`;
    const receivablePeek = receivablePeekRows[0];
    if (!receivablePeek) {
      throw new NotFoundError('customer_receivable', 'CUSTOMER_RECEIVABLE_NOT_FOUND');
    }

    // ── E4/E35 — the Advance and the target receivable must belong to the
    //      SAME CustomerCompanyAccount (never cross-customer). ───────────
    if (receivablePeek.customerCompanyAccountId !== advancePeek.customerCompanyAccountId) {
      throw new DomainError(
        'CUSTOMER_ADVANCE_APPLICATION_ACCOUNT_MISMATCH',
        'the target receivable does not belong to the same CustomerCompanyAccount as this Advance',
        409,
      );
    }
    // ── E5 — "No cross-branch advance pooling in 3b.6" — enforced here in
    //      application code (see class doc comment for why the DB alone
    //      does not close this). ────────────────────────────────────────
    if (receivablePeek.branchId !== advancePeek.branchId) {
      throw new DomainError(
        'CUSTOMER_ADVANCE_APPLICATION_CROSS_BRANCH_NOT_ALLOWED',
        'an Advance may only be applied to a receivable in the SAME branch it belongs to',
        409,
      );
    }
    // the trusted route branchId must match where this Advance actually
    // lives — an operator scoped to a different branch cannot reach in.
    if (advancePeek.branchId !== input.branchId) {
      throw new NotFoundError('customer_advance', 'CUSTOMER_ADVANCE_NOT_FOUND');
    }

    // ── 2. lock the coverage anchor FIRST (canonical order), THEN
    //      CustomerCompanyAccount, THEN CustomerAdvance — recomputing every
    //      figure from authoritative, now-locked facts (E13/E14/E15, never
    //      the pre-lock peek). ──────────────────────────────────────────
    // The coverage anchor is the underlying `invoice` row for an INVOICE target
    // and the `customer_receivable` row itself for every NON-invoice target
    // (OPENING / CANCELLATION_CHARGE — the same anchor the DB coverage backstop
    // locks).
    if (receivablePeek.sourceType === 'INVOICE') {
      await tx.$queryRaw`SELECT "id" FROM "invoice" WHERE "id" = ${receivablePeek.invoiceId}::uuid FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT "id" FROM "customer_receivable" WHERE "id" = ${receivablePeek.id}::uuid FOR UPDATE`;
    }

    await tx.$queryRaw`SELECT "id" FROM "customer_company_account" WHERE "id" = ${advancePeek.customerCompanyAccountId}::uuid FOR UPDATE`;

    const advanceRows = await tx.$queryRaw<
      { id: string; currencyCode: string; currencyExponent: number }[]
    >`
      SELECT "id", "currencyCode", "currencyExponent" FROM "customer_advance"
       WHERE "id" = ${input.advanceId}::uuid FOR UPDATE`;
    const advance = advanceRows[0]!;

    // ── 3. recompute Advance-available and receivable-outstanding under
    //      lock (E14/E15) — through the ONE canonical balance loader (task
    //      3b.8 Integration Closure). The receivable formula is by source type
    //      (INVOICE incl. a CreditNote's AR reduction / OPENING /
    //      CANCELLATION_CHARGE — never an "else OPENING" fallthrough); the
    //      advance's `consumed` is applications + refund applications + PENDING
    //      provider-refund reservations, exactly what the DB capacity backstop
    //      enforces, so an over-ask is a clean 409 here and never a raw DB
    //      exception. ──────────────────────────────────────────────────────
    const [receivableBalance] = await loadReceivableBalances(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: advancePeek.customerCompanyAccountId,
      receivableId: receivablePeek.id,
    });
    const [advanceBalance] = await loadAdvanceBalances(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: advancePeek.customerCompanyAccountId,
      advanceId: input.advanceId,
    });
    if (!receivableBalance) {
      throw new NotFoundError('customer_receivable', 'CUSTOMER_RECEIVABLE_NOT_FOUND');
    }
    if (!advanceBalance) {
      throw new NotFoundError('customer_advance', 'CUSTOMER_ADVANCE_NOT_FOUND');
    }
    const receivableOutstandingMinor = receivableBalance.outstandingMinor;

    // ── E14 — Checkpoint A's own frozen, pure validation/arithmetic; never
    //      re-implemented here (`appliedSoFarMinor` is, for this purpose,
    //      everything already CONSUMED from the advance). Throws a plain
    //      RangeError for any invalid proposal, mapped to a bounded DomainError
    //      below. ────────────────────────────────────────────────────────
    let applied: ReturnType<typeof applyAdvance>;
    try {
      applied = applyAdvance({
        advance: {
          advancePrincipalMinor: advanceBalance.principalMinor,
          appliedSoFarMinor: advanceBalance.consumedMinor,
        },
        targetReceivableOutstandingMinor: receivableOutstandingMinor,
        proposedApplicationAmountMinor: input.amountMinor,
      });
    } catch (err) {
      if (err instanceof RangeError) {
        throw new DomainError('CUSTOMER_ADVANCE_APPLICATION_INVALID', err.message, 409);
      }
      throw err;
    }

    // ── 4. INSERT — fires the frozen B trigger, which re-locks the SAME
    //      coverage anchor + re-locks CustomerAdvance and re-validates
    //      capacity — a consistent, harmless re-proof under locks this
    //      code already holds. ──────────────────────────────────────────
    const application = await tx.customerAdvanceApplication.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: advancePeek.branchId,
        customerAdvanceId: input.advanceId,
        customerReceivableId: input.customerReceivableId,
        amountMinor: input.amountMinor,
        currencyCode: advance.currencyCode,
        currencyExponent: advance.currencyExponent,
        ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
      },
    });

    // ── 5. chronology — exactly one ADVANCE_APPLIED entry. ───────────────
    assertCustomerAccountEntryReferenceShape('ADVANCE_APPLIED', {
      customerAdvanceApplicationId: application.id,
    });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: advancePeek.branchId,
        customerCompanyAccountId: advancePeek.customerCompanyAccountId,
        entryKind: 'ADVANCE_APPLIED',
        customerAdvanceApplicationId: application.id,
      },
    });

    // ── 6. projections — BOTH advanceBalanceMinor and
    //      currentOutstandingMinor move by the exact applied amount, in the
    //      SAME transaction (E16). Never touches `version`. ──────────────
    await tx.customerCompanyAccount.update({
      where: { id: advancePeek.customerCompanyAccountId },
      data: {
        advanceBalanceMinor: { decrement: input.amountMinor },
        currentOutstandingMinor: { decrement: input.amountMinor },
      },
    });

    // ── 7. Invoice-target only — recompute status via D's own shared
    //      helper (never duplicated arithmetic, E15/E17). ────────────────
    let invoicePaymentStatus: string | null = null;
    if (receivablePeek.sourceType === 'INVOICE') {
      await this.receiptEffects.recomputeInvoicePaymentStatusInTx(tx, receivablePeek.invoiceId!);
      const invRows2 = await tx.$queryRaw<{ invoicePaymentStatus: string }[]>`
        SELECT "invoicePaymentStatus" FROM "invoice" WHERE "id" = ${receivablePeek.invoiceId}::uuid`;
      invoicePaymentStatus = invRows2[0]!.invoicePaymentStatus;
    }

    // ── 8. GL — Dr Customer Advances / Cr Accounts Receivable ONLY. No
    //      receipt journal, no Cash/Bank/Clearing line, no PaymentAllocation
    //      (E18). ──────────────────────────────────────────────────────
    await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: advancePeek.branchId,
      sourceKind: 'customer_advance_application',
      sourceId: application.id,
      lines: [
        {
          accountKey: 'LIABILITY.CUSTOMER_ADVANCES',
          direction: 'debit',
          amountMinor: input.amountMinor,
        },
        {
          accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
          direction: 'credit',
          amountMinor: input.amountMinor,
        },
      ],
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'receivable.advance_applied',
      resourceType: 'customer_advance_application',
      resourceId: application.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: advancePeek.branchId,
      actorUserId: input.actorUserId ?? null,
      after: {
        customerAdvanceId: input.advanceId,
        customerReceivableId: input.customerReceivableId,
        amountMinor: input.amountMinor.toString(),
        currencyCode: advance.currencyCode,
      },
    });

    // Checkpoint H (§6/§7) — standalone command, no other outbox event in
    // this transaction. Branch-scoped (the application's own branch).
    await this.outbox.enqueue(tx, {
      aggregateType: 'customer_advance_application',
      aggregateId: application.id,
      eventType: 'receivables.customer_account_changed' satisfies ReceivablesEventType,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: advancePeek.branchId,
      payload: {
        customerCompanyAccountId: advancePeek.customerCompanyAccountId,
        changeKind: 'ADVANCE_APPLIED',
        sourceType: 'customer_advance_application',
        sourceId: application.id,
      },
    });

    return {
      applicationId: application.id,
      advanceId: input.advanceId,
      customerReceivableId: input.customerReceivableId,
      amountMinor: input.amountMinor,
      remainingAdvanceMinor: applied.newAdvanceAvailableMinor,
      receivableOutstandingMinor: applied.newReceivableOutstandingMinor,
      invoicePaymentStatus,
    };
  }
}
