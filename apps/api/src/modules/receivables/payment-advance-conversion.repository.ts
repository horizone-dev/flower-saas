import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors every other 3b.6 internal
// primitive): PARTICIPATES in the caller's already-open transaction, never
// opens its own.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { PaymentCustomerAttributionRepository } from './payment-customer-attribution.repository.js';
import { assertCustomerAccountEntryReferenceShape } from './customer-account-entry.js';
import type { ReceivablesEventType } from './receivables-events.js';

export interface ConvertPaymentToAdvanceInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerId: string;
  paymentId: string;
  amountMinor: bigint;
  actorUserId?: string | null;
}

export interface ConvertPaymentToAdvanceResult {
  advanceId: string;
  sourcePaymentId: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  remainingPaymentUnallocatedMinor: bigint;
  advanceBalanceMinor: bigint;
}

/**
 * Task 3b.6 Checkpoint E (E3/E4/E8) — the explicit "convert some or all of a
 * canonical Payment's remaining unconsumed capacity into a
 * CustomerAdvance(sourceType='PAYMENT')" primitive. NEVER automatic — a
 * confirmed Payment does not become an Advance on its own (E2). Creates NO
 * Payment, NO PaymentAllocation, NO CustomerReceivable — only a new
 * CustomerAdvance row plus its chronology/projection/GL effects.
 *
 * Canonical lock order (B15, reused verbatim — no coverage-anchor tier is
 * involved in this operation at all): CustomerCompanyAccount -> Payment.
 * Attribution resolution (D4's `PaymentCustomerAttributionRepository`) is a
 * plain unlocked read that runs BEFORE any lock is acquired, exactly like
 * every other frozen resolver in this checkpoint chain — it only decides
 * WHICH CustomerCompanyAccount to lock, never itself a lock.
 */
@Injectable()
export class PaymentAdvanceConversionRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
    private readonly attribution: PaymentCustomerAttributionRepository,
    private readonly outbox: OutboxWriter,
  ) {}

  async convertInTx(
    tx: ScopedTx,
    input: ConvertPaymentToAdvanceInput,
  ): Promise<ConvertPaymentToAdvanceResult> {
    if (input.amountMinor <= 0n) {
      throw new DomainError('PAYMENT_INVALID_AMOUNT', 'amountMinor must be > 0', 422);
    }

    // ── 1. trusted scope resolution (unlocked) — the Payment must exist in
    //      EXACTLY this tenant/company/branch; a wrong scope is a plain
    //      404, never disclosing whether a same-id Payment exists
    //      elsewhere. ──────────────────────────────────────────────────────
    const paymentScopeRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "payment"
       WHERE "id" = ${input.paymentId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid`;
    if (!paymentScopeRows[0]) {
      throw new NotFoundError('payment', 'PAYMENT_NOT_FOUND');
    }

    // ── 2. D4's ONE trusted attribution resolver — never a caller-supplied
    //      customerCompanyAccountId (E4). Walk-in resolves to NULL — fails
    //      closed (E31). ──────────────────────────────────────────────────
    const attributed = await this.attribution.resolveInTx(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      paymentId: input.paymentId,
    });
    if (!attributed.customerCompanyAccountId) {
      throw new DomainError(
        'PAYMENT_NOT_CUSTOMER_ATTRIBUTABLE',
        'a walk-in Payment (no resolvable CustomerCompanyAccount) can never fund a CustomerAdvance',
        422,
      );
    }

    // ── 3. join-gate: the resolved account must belong to the TRUSTED route
    //      customerId — a wrong customerId in the URL can never reinterpret
    //      someone else's Payment (E4, "cross-customer conversion:
    //      impossible") — fails closed as a non-disclosing 404. ───────────
    const accountRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_company_account"
       WHERE "id" = ${attributed.customerCompanyAccountId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "customerId" = ${input.customerId}::uuid`;
    const account = accountRows[0];
    if (!account) {
      throw new NotFoundError('payment', 'PAYMENT_NOT_FOUND');
    }

    // ── 4. lock CustomerCompanyAccount FIRST (canonical order: no
    //      coverage-anchor tier exists in this operation, so CCA is the
    //      first real lock), THEN lock Payment and read its authoritative
    //      amount/currency. ──────────────────────────────────────────────
    await tx.$queryRaw`SELECT "id" FROM "customer_company_account" WHERE "id" = ${account.id}::uuid FOR UPDATE`;

    const paymentRows = await tx.$queryRaw<
      { id: string; amountMinor: bigint; currencyCode: string; currencyExponent: number }[]
    >`
      SELECT "id", "amountMinor", "currencyCode", "currencyExponent" FROM "payment"
       WHERE "id" = ${input.paymentId}::uuid FOR UPDATE`;
    const payment = paymentRows[0]!;

    // ── 5. recompute remaining capacity under the lock — the EXACT frozen
    //      3-term formula the DB trigger itself enforces (never recomputed
    //      from request data, E3). ──────────────────────────────────────
    const allocRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM "payment_allocation" WHERE "paymentId" = ${input.paymentId}::uuid`;
    const openingAppRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM "customer_receivable_payment_application" WHERE "paymentId" = ${input.paymentId}::uuid`;
    const advanceRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM "customer_advance" WHERE "sourcePaymentId" = ${input.paymentId}::uuid`;
    const consumed = allocRows[0]!.total + openingAppRows[0]!.total + advanceRows[0]!.total;
    const remaining = payment.amountMinor - consumed;

    if (input.amountMinor > remaining) {
      throw new DomainError(
        'PAYMENT_ADVANCE_CONVERSION_EXCEEDS_CAPACITY',
        `requested conversion amount ${input.amountMinor} exceeds the Payment's remaining unconsumed capacity ${remaining}`,
        409,
      );
    }

    // ── 6. create the CustomerAdvance(sourceType='PAYMENT') — belongs to
    //      the PAYMENT's own branch (E5), not necessarily the route's
    //      (though they are proven identical by the scope check in step 1).
    //      The insert trigger re-validates scope/currency/attribution and
    //      re-locks Payment capacity — a harmless, consistent re-proof under
    //      the SAME already-held lock, never a second logical acquisition. ──
    const advance = await tx.customerAdvance.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: account.id,
        sourceType: 'PAYMENT',
        sourcePaymentId: input.paymentId,
        amountMinor: input.amountMinor,
        currencyCode: payment.currencyCode,
        currencyExponent: payment.currencyExponent,
        ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
      },
    });

    // ── 7. chronology — exactly one ADVANCE entry (DB-unique-enforced). ──
    assertCustomerAccountEntryReferenceShape('ADVANCE', { customerAdvanceId: advance.id });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: account.id,
        entryKind: 'ADVANCE',
        customerAdvanceId: advance.id,
      },
    });

    // ── 8. projection — funding INCREASES the liability balance only.
    //      currentOutstandingMinor / credit configuration / version are
    //      UNTOUCHED (E10, E26) — an unapplied Advance never reduces credit
    //      exposure. ──────────────────────────────────────────────────────
    const updatedAccount = await tx.customerCompanyAccount.update({
      where: { id: account.id },
      data: { advanceBalanceMinor: { increment: input.amountMinor } },
      select: { advanceBalanceMinor: true },
    });

    // ── 9. GL — reclassifies an already-received unapplied liability;
    //      never touches Cash/Bank/Payment Clearing/Revenue/AR (E9). ──────
    await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'customer_advance',
      sourceId: advance.id,
      lines: [
        {
          accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS',
          direction: 'debit',
          amountMinor: input.amountMinor,
        },
        {
          accountKey: 'LIABILITY.CUSTOMER_ADVANCES',
          direction: 'credit',
          amountMinor: input.amountMinor,
        },
      ],
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'receivable.advance_created',
      resourceType: 'customer_advance',
      resourceId: advance.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      actorUserId: input.actorUserId ?? null,
      after: {
        customerCompanyAccountId: account.id,
        sourcePaymentId: input.paymentId,
        amountMinor: input.amountMinor.toString(),
        currencyCode: payment.currencyCode,
      },
    });

    // Checkpoint H (§6/§7) — a standalone command with no OTHER outbox
    // event firing in this transaction (unlike the receipt-collection FIFO
    // path, which already rides on `payments.payment_recorded`). Branch-
    // scoped (this is branch-operational activity, never company-wide) —
    // no balance in the payload, only trusted identifiers for refetch.
    await this.outbox.enqueue(tx, {
      aggregateType: 'customer_advance',
      aggregateId: advance.id,
      eventType: 'receivables.customer_account_changed' satisfies ReceivablesEventType,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      payload: {
        customerCompanyAccountId: account.id,
        changeKind: 'ADVANCE_CREATED_FROM_PAYMENT',
        sourceType: 'customer_advance',
        sourceId: advance.id,
      },
    });

    return {
      advanceId: advance.id,
      sourcePaymentId: input.paymentId,
      amountMinor: input.amountMinor,
      currencyCode: payment.currencyCode,
      currencyExponent: payment.currencyExponent,
      remainingPaymentUnallocatedMinor: remaining - input.amountMinor,
      advanceBalanceMinor: updatedAccount.advanceBalanceMinor,
    };
  }
}
