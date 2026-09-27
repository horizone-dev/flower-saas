import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `PaymentCollectionRepository`
// exactly): PARTICIPATES in the caller's already-open transaction, never
// opens its own.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { isProviderBackedTender, type TenderMethod } from '../payments/tender.js';
import type { PaymentEventType } from '../payments/payment-events.js';
import { allocateFifo, type OpenReceivable } from './receivable-fifo-allocation.js';
import { CustomerReceiptEffectsRepository } from './customer-receipt-effects.repository.js';

export interface CollectCustomerReceiptInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerId: string;
  amountMinor: bigint;
  method: TenderMethod;
  createdByUserId: string | null;
  actingUserId: string | null;
  idempotencyKey: string;
}

export interface CustomerReceiptAllocationResult {
  receivableId: string;
  sourceType: 'INVOICE' | 'OPENING';
  amountMinor: bigint;
}

export interface CollectCustomerReceiptResult {
  paymentId: string;
  paymentAttemptId: string;
  customerCompanyAccountId: string;
  amountMinor: bigint;
  allocatedAmountMinor: bigint;
  unallocatedAmountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  allocations: CustomerReceiptAllocationResult[];
}

interface CandidateRow {
  id: string;
  sourceType: string;
  createdAt: Date;
  invoiceId: string | null;
}

/**
 * Task 3b.6 Checkpoint D (D10-D16) — the customer-level canonical-receipt
 * primitive: locally-confirmed tenders ONLY, FIFO fan-out across a single
 * customer's combined open-receivable queue (Invoice-origin AND
 * Opening-origin, one deterministic `createdAt ASC, id ASC` order), never a
 * provider/async path. NOT HTTP-exposed directly — `CustomerReceiptRepository`
 * opens the caller transaction and delegates here, mirroring
 * `PaymentCollectionRepository`'s own relationship to `PaymentRepository`.
 *
 * Fixed lock order (owner Checkpoint D contract §D13/§D15, reusing the
 * frozen B15 hierarchy verbatim): lock each coverage anchor (the underlying
 * `invoice` row for an INVOICE-sourced candidate, the `customer_receivable`
 * row itself for OPENING) in FIFO order, THEN lock `CustomerCompanyAccount`,
 * THEN create the Payment (which becomes the capacity-lock authority for
 * every allocation/application drawn from it). Initial candidate discovery
 * is UNLOCKED (only to determine the canonical lock order); every actual
 * outstanding figure is recomputed from authoritative DB facts AFTER its
 * anchor is locked — never trusted from the pre-lock read (D15).
 */
@Injectable()
export class CustomerReceiptCollectionRepository {
  constructor(
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly effects: CustomerReceiptEffectsRepository,
  ) {}

  async collectInTx(
    tx: ScopedTx,
    input: CollectCustomerReceiptInput,
  ): Promise<CollectCustomerReceiptResult> {
    if (input.amountMinor <= 0n) {
      throw new DomainError('PAYMENT_INVALID_AMOUNT', 'amountMinor must be > 0', 422);
    }
    // D11 hardening (final freeze pass) — CARD_TERMINAL is UNCONDITIONALLY
    // rejected here, never resolved from a branch/provider-config lookup.
    //
    // Evidence (re-inspected against every existing 3b.5 production call
    // site of `isProviderBackedTender`): `ProviderCredential.provider` is a
    // bare PSP identity string (e.g. "stripe"/"tap"), shared across every
    // platform integration domain (payments, WhatsApp BSP, AI providers) —
    // it carries NO `method`/`tenderMethod`/`capability` column anywhere,
    // and `nonSecretConfig` (an opaque, platform-wide JSON blob) is never
    // read for any method-binding purpose by any payments code. Every real
    // call site that resolves a `providerCredentialId` to feed
    // `isProviderBackedTender` does so ONLY after the CALLER explicitly
    // declares a `providerKey` intent (`payment-attempt-reservation
    // .repository.ts`'s `ReserveAsyncAttemptInput` requires it, resolved via
    // `ProviderConfigRepository.resolveForBranchScoped(companyId, branchId,
    // providerKey)`) — the system never autonomously infers "is CARD_TERMINAL
    // provider-backed for this branch" from credential EXISTENCE alone. The
    // frozen synchronous invoice-payment path (`SynchronousTenderInput`,
    // `create-payment.dto.ts`) resolves this identical question the OPPOSITE
    // way: no `providerCredentialId` field exists on that contract at all,
    // so CARD_TERMINAL is unconditionally treated as local there, by
    // construction — that existing contract is left completely unchanged.
    //
    // For this NEW endpoint, a branch-wide "does ANY active provider
    // credential exist" query (this method's prior implementation) does NOT
    // answer the real question — it would misclassify a branch with an
    // active ONLINE_GATEWAY-only integration (or ANY other payments-domain
    // provider) as CARD_TERMINAL-provider-backed, and there is no way to
    // ask "is THIS credential specifically wired for card-terminal use" at
    // all. The public request body deliberately carries no
    // `providerCredentialId`/`providerKey` (D10 — never accepted from the
    // caller), so there is no trusted signal to resolve a specific
    // credential from here either. Per owner instruction: do not guess: the
    // safe, evidence-based rule is unconditional rejection until a future
    // explicit, trusted terminal/provider-selection mechanism is designed.
    if (input.method === 'CARD_TERMINAL' || isProviderBackedTender(input.method, null)) {
      throw new DomainError(
        'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
        `${input.method} requires the async PaymentAttempt/provider flow and cannot participate in a synchronous customer receipt`,
        422,
      );
    }

    // ── 1. join-gated CustomerCompanyAccount resolution (mirrors
    //      `CustomerInvoiceArRepository`'s own `lockAccount` join-gate exactly
    //      — a wrong customerId can never resolve a different company's
    //      account). NOT locked yet — locking happens AFTER the coverage
    //      anchors, per the canonical order. ─────────────────────────────────
    const accountRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT cca."id"
        FROM "customer_company_account" cca
        INNER JOIN "customer" c ON c."tenantId" = cca."tenantId" AND c."id" = cca."customerId"
       WHERE cca."tenantId" = ${input.tenantId}::uuid
         AND cca."companyId" = ${input.companyId}::uuid
         AND cca."customerId" = ${input.customerId}::uuid`;
    const account = accountRows[0];
    if (!account) {
      throw new DomainError(
        'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND',
        'this customer is not associated with the current company',
        404,
      );
    }

    // ── 2. company operating currency (a manual local receipt is always
    //      recorded in the company's own default currency — no per-tender
    //      currency choice exists anywhere in this schema). ─────────────────
    const currencyRows = await tx.$queryRaw<{ currencyCode: string; currencyExponent: number }[]>`
      SELECT co."defaultCurrency" AS "currencyCode", cur."exponent" AS "currencyExponent"
        FROM "company" co
        INNER JOIN "currency" cur ON cur."code" = co."defaultCurrency"
       WHERE co."id" = ${input.companyId}::uuid AND co."tenantId" = ${input.tenantId}::uuid`;
    const currency = currencyRows[0];
    if (!currency) throw new NotFoundError('company', 'COMPANY_NOT_FOUND');

    // ── 3. UNLOCKED candidate discovery — same-branch ONLY (D33: operational
    //      application is same-branch only; Owner tenant-wide visibility
    //      never authorizes a cross-branch write). Deterministic FIFO order
    //      (createdAt ASC, id ASC) fixes the lock-acquisition order below. ──
    const candidates = await tx.$queryRaw<CandidateRow[]>`
      SELECT cr."id", cr."sourceType", cr."createdAt", cr."invoiceId"
        FROM "customer_receivable" cr
       WHERE cr."tenantId" = ${input.tenantId}::uuid
         AND cr."companyId" = ${input.companyId}::uuid
         AND cr."branchId" = ${input.branchId}::uuid
         AND cr."customerCompanyAccountId" = ${account.id}::uuid
       ORDER BY cr."createdAt" ASC, cr."id" ASC`;

    // ── 4. lock each coverage anchor, IN FIFO ORDER, then recompute its
    //      authoritative outstanding under that lock (D15 — never trust the
    //      pre-lock read; a candidate fully covered by a concurrent
    //      transaction between discovery and lock acquisition is skipped). ──
    const openReceivables: OpenReceivable[] = [];
    const sourceById = new Map<
      string,
      { sourceType: 'INVOICE' | 'OPENING'; invoiceId: string | null }
    >();
    for (const candidate of candidates) {
      let outstandingMinor: bigint;
      if (candidate.sourceType === 'INVOICE') {
        const rows = await tx.$queryRaw<{ totalAmountMinor: bigint }[]>`
          SELECT "totalAmountMinor" FROM "invoice" WHERE "id" = ${candidate.invoiceId}::uuid FOR UPDATE`;
        const invoice = rows[0];
        if (!invoice) continue; // defensive — cannot happen under B8's own FK
        const allocRows = await tx.$queryRaw<{ total: bigint }[]>`
          SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM "payment_allocation" WHERE "invoiceId" = ${candidate.invoiceId}::uuid`;
        const advRows = await tx.$queryRaw<{ total: bigint }[]>`
          SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM "customer_advance_application" WHERE "customerReceivableId" = ${candidate.id}::uuid`;
        outstandingMinor = invoice.totalAmountMinor - allocRows[0]!.total - advRows[0]!.total;
      } else {
        const rows = await tx.$queryRaw<{ openingAmountMinor: bigint }[]>`
          SELECT "openingAmountMinor" FROM "customer_receivable" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;
        const receivable = rows[0];
        if (!receivable) continue;
        const advRows = await tx.$queryRaw<{ total: bigint }[]>`
          SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM "customer_advance_application" WHERE "customerReceivableId" = ${candidate.id}::uuid`;
        const payAppRows = await tx.$queryRaw<{ total: bigint }[]>`
          SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM "customer_receivable_payment_application" WHERE "customerReceivableId" = ${candidate.id}::uuid`;
        outstandingMinor = receivable.openingAmountMinor - advRows[0]!.total - payAppRows[0]!.total;
      }

      if (outstandingMinor <= 0n) continue; // fully covered since discovery — skip

      sourceById.set(candidate.id, {
        sourceType: candidate.sourceType as 'INVOICE' | 'OPENING',
        invoiceId: candidate.invoiceId,
      });
      openReceivables.push({ id: candidate.id, createdAt: candidate.createdAt, outstandingMinor });
    }

    // ── 5. lock CustomerCompanyAccount — AFTER every coverage anchor, BEFORE
    //      Payment (canonical order, unchanged). ────────────────────────────
    await tx.$queryRaw`SELECT "id" FROM "customer_company_account" WHERE "id" = ${account.id}::uuid FOR UPDATE`;

    // ── 6. Checkpoint A's own frozen, pure FIFO arithmetic — this repository
    //      only adapts DB rows into its input shape and its output back into
    //      DB writes; the allocation logic itself is never re-implemented. ──
    const fifoResult = allocateFifo(input.amountMinor, openReceivables);

    // ── 7. CUSTOMER_RECEIPT PaymentAttempt -> CAPTURED -> event -> Payment. ─
    const attemptRows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "payment_attempt"
        ("tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
         "method", "amountMinor", "currencyCode", "currencyExponent", "state",
         "idempotencyKey", "createdByUserId", "actingUserId", "updatedAt")
      VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid, 'CUSTOMER_RECEIPT',
              ${account.id}::uuid, ${input.method}, ${input.amountMinor}, ${currency.currencyCode},
              ${currency.currencyExponent}, 'PENDING', ${input.idempotencyKey},
              ${input.createdByUserId}::uuid, ${input.actingUserId}::uuid, now())
      RETURNING "id"`;
    const attemptId = attemptRows[0]!.id;

    await tx.$queryRaw`
      UPDATE "payment_attempt" SET "state" = 'CAPTURED', "updatedAt" = now() WHERE "id" = ${attemptId}::uuid`;
    await tx.$queryRaw`
      INSERT INTO "payment_attempt_event"
        ("tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", "source")
      VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
              ${attemptId}::uuid, 'PENDING', 'CAPTURED', 'USER')`;

    await this.audit.record(tx, {
      action: 'payment_attempt.state_changed',
      resourceType: 'payment_attempt',
      resourceId: attemptId,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      before: { state: 'PENDING' },
      after: { state: 'CAPTURED' },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'payment_attempt',
      aggregateId: attemptId,
      eventType: 'payments.attempt_state_changed' satisfies PaymentEventType,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      payload: {
        paymentAttemptId: attemptId,
        customerCompanyAccountId: account.id,
        method: input.method,
        fromState: 'PENDING',
        toState: 'CAPTURED',
      },
    });

    const paymentRows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "payment"
        ("tenantId", "companyId", "branchId", "sourceAttemptId", "method",
         "amountMinor", "currencyCode", "currencyExponent", "createdByUserId", "actingUserId")
      VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
              ${attemptId}::uuid, ${input.method}, ${input.amountMinor}, ${currency.currencyCode},
              ${currency.currencyExponent}, ${input.createdByUserId}::uuid, ${input.actingUserId}::uuid)
      RETURNING "id"`;
    const paymentId = paymentRows[0]!.id;

    await this.audit.record(tx, {
      action: 'payment.recorded',
      resourceType: 'payment',
      resourceId: paymentId,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      after: {
        customerCompanyAccountId: account.id,
        method: input.method,
        amountMinor: input.amountMinor.toString(),
        currencyCode: currency.currencyCode,
      },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'payment',
      aggregateId: paymentId,
      eventType: 'payments.payment_recorded' satisfies PaymentEventType,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      payload: {
        paymentId,
        customerCompanyAccountId: account.id,
        method: input.method,
        amountMinor: input.amountMinor.toString(),
        currencyCode: currency.currencyCode,
        currencyExponent: currency.currencyExponent,
      },
    });

    // ── 8. CustomerAccountEntry(PAYMENT) + receipt GL — exactly once. ───────
    await this.effects.recordPaymentReceivedInTx(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      customerCompanyAccountId: account.id,
      paymentId,
      method: input.method,
      amountMinor: input.amountMinor,
      actorUserId: input.createdByUserId,
    });

    // ── 9. apply the FIFO plan — Invoice-origin via PaymentAllocation,
    //      Opening-origin via CustomerReceivablePaymentApplication. Never
    //      auto-creates a CustomerAdvance for any remainder (D16). ──────────
    const allocations: CustomerReceiptAllocationResult[] = [];
    for (const allocation of fifoResult.allocations) {
      const source = sourceById.get(allocation.receivableId)!;
      if (source.sourceType === 'INVOICE') {
        const allocRows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "payment_allocation"
            ("tenantId", "companyId", "branchId", "paymentId", "invoiceId",
             "amountMinor", "currencyCode", "currencyExponent")
          VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
                  ${paymentId}::uuid, ${source.invoiceId}::uuid,
                  ${allocation.amountMinor}, ${currency.currencyCode}, ${currency.currencyExponent})
          RETURNING "id"`;
        await this.effects.applyInvoiceAllocationEffectsInTx(tx, {
          tenantId: input.tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          customerCompanyAccountId: account.id,
          paymentAllocationId: allocRows[0]!.id,
          customerReceivableId: allocation.receivableId,
          invoiceId: source.invoiceId!,
          amountMinor: allocation.amountMinor,
          actorUserId: input.createdByUserId,
        });
      } else {
        await this.effects.applyOpeningApplicationEffectsInTx(tx, {
          tenantId: input.tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          customerCompanyAccountId: account.id,
          customerReceivableId: allocation.receivableId,
          paymentId,
          amountMinor: allocation.amountMinor,
          currencyCode: currency.currencyCode,
          currencyExponent: currency.currencyExponent,
          actorUserId: input.createdByUserId,
        });
      }
      allocations.push({
        receivableId: allocation.receivableId,
        sourceType: source.sourceType,
        amountMinor: allocation.amountMinor,
      });
    }

    return {
      paymentId,
      paymentAttemptId: attemptId,
      customerCompanyAccountId: account.id,
      amountMinor: input.amountMinor,
      allocatedAmountMinor: input.amountMinor - fifoResult.unallocatedAmountMinor,
      unallocatedAmountMinor: fifoResult.unallocatedAmountMinor,
      currencyCode: currency.currencyCode,
      currencyExponent: currency.currencyExponent,
      allocations,
    };
  }
}
