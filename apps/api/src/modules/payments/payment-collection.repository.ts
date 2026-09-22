import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `InvoiceIssuanceRepository`'s
// and `TaxFinalizationService`'s own precedent exactly, task 3b.3/3b.4): this
// is an internal primitive that must PARTICIPATE in a caller's already-open
// transaction, never open its own — its public
// `captureSynchronousTendersInTx(tx: ScopedTx, ...)` contract requires this
// type directly. No raw Prisma model access happens here outside
// `tx.<model>`/`tx.$queryRaw` calls on the caller-supplied, already-scoped
// `tx`.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { computeAvailableToCollect } from './available-to-collect.js';
import { assertPaymentAttemptOrderBinding } from './order-binding.js';
import { isProviderBackedTender, type TenderMethod } from './tender.js';
import type { PaymentEventType } from './payment-events.js';

export interface SynchronousTenderInput {
  /** CASH | BANK_TRANSFER | OTHER_MANUAL | CARD_TERMINAL — ONLINE_GATEWAY
   *  and any provider-backed tender are rejected by `isProviderBackedTender`
   *  below. */
  method: TenderMethod;
  amountMinor: bigint;
  /**
   * INTERNAL TRUST-BOUNDARY FIELD ONLY (owner final integrity pass, item 1).
   * The public DTO (`create-payment.dto.ts`) has NO field that can populate
   * this — `PaymentController`/`PaymentRepository` never set it, so every
   * real HTTP-originated call reaches this primitive with it `undefined`.
   * It exists on this internal contract SOLELY so the primitive's own
   * runtime check below (`isProviderBackedTender`) has a real value to
   * classify, rather than a hardcoded `null` that would silently ignore
   * provider metadata an internal caller constructs directly (a future
   * checkpoint, a test, a refactor) without going through the DTO/HTTP
   * layer at all. A TypeScript excess-property check on an object literal
   * is not a runtime control — this field being present and checked is.
   * `CARD_TERMINAL` + a non-null value here is provider-backed and is
   * unconditionally rejected; `CARD_TERMINAL` with it absent/null is local.
   * No `ProviderCredential` lookup happens here — that is Checkpoint E's.
   */
  providerCredentialId?: string | null;
}

export interface CaptureSynchronousTendersInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  invoiceId: string;
  /** the intended TOTAL of this payment operation — must equal the exact
   *  sum of every `tenders[].amountMinor` (owner Checkpoint D contract §D2). */
  amountMinor: bigint;
  /** at least one tender; Checkpoint C's single-tender behavior is exactly
   *  the `tenders.length === 1` case of this same primitive. */
  tenders: readonly SynchronousTenderInput[];
  createdByUserId: string | null;
  actingUserId: string | null;
  /** preserved on every created PaymentAttempt as historical context only —
   *  never re-validated here (the HTTP idempotency layer already guarantees
   *  single execution of the WHOLE request per key). */
  idempotencyKey: string;
}

export interface CapturedTenderResult {
  paymentId: string;
  paymentAttemptId: string;
  paymentAllocationId: string;
  method: TenderMethod;
  amountMinor: bigint;
}

export interface CaptureSynchronousTendersResult {
  /** NULL for a single-tender request; one server-generated value shared by
   *  every component Payment/PaymentAttempt when `tenders.length > 1`
   *  (owner Checkpoint D contract §D6). Correlation only — no entity/table
   *  of its own. */
  paymentGroupId: string | null;
  invoiceId: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  /** same order as `input.tenders` — never incidental DB row order (§D8). */
  payments: CapturedTenderResult[];
  remainingAvailableToCollectMinor: bigint;
}

/** @deprecated shape-compatible alias kept only so existing Checkpoint C
 *  call sites/tests that named this type keep compiling unchanged. */
export type CaptureSingleTenderInput = Omit<
  CaptureSynchronousTendersInput,
  'tenders' | 'amountMinor'
> & {
  method: TenderMethod;
  amountMinor: bigint;
};
export interface CaptureSingleTenderResult {
  paymentId: string;
  paymentAttemptId: string;
  paymentAllocationId: string;
  invoiceId: string;
  method: TenderMethod;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  remainingAvailableToCollectMinor: bigint;
}

/**
 * Task 3b.5 Checkpoint D — the internal-only synchronous capture primitive,
 * generalized from Checkpoint C to accept N>=1 locally-confirmable tenders
 * in ONE caller-owned transaction. NOT HTTP-exposed by itself —
 * `PaymentRepository` opens the caller transaction and delegates here,
 * mirroring `InvoiceIssuanceRepository.issueFinalInvoice` /
 * `TaxFinalizationService` exactly. Participates in the CALLER's
 * already-open `ScopedTx` — never opens or commits its own transaction.
 *
 * Fixed lock order (owner Checkpoint C contract §C2, reused verbatim,
 * frozen for E/F too): lock the Invoice ONCE, load the Order ONCE, compute
 * confirmed+reserved amounts ONCE under that lock, validate the ENTIRE
 * tender set, and only then write — one attempt/event/Payment/Allocation
 * per tender, all inside the same transaction the caller already owns.
 *
 * Checkpoint C's single-tender behavior is exactly the `tenders.length ===
 * 1` case of this primitive — `captureSingleTenderInTx` below is now a
 * thin, shape-preserving delegate so every existing Checkpoint C call site
 * and test keeps compiling and behaving identically, unchanged.
 */
@Injectable()
export class PaymentCollectionRepository {
  constructor(
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async captureSynchronousTendersInTx(
    tx: ScopedTx,
    input: CaptureSynchronousTendersInput,
  ): Promise<CaptureSynchronousTendersResult> {
    // ── D5/D12: validate the ENTIRE tender set BEFORE any write. Explicit
    //    semantic checks mapped to their own DomainError codes — never a
    //    string-match against a pure module's RangeError message. ─────────
    if (input.tenders.length === 0) {
      throw new DomainError(
        'PAYMENT_INVALID_AMOUNT',
        'a payment requires at least one tender component',
        422,
      );
    }
    if (input.amountMinor <= 0n) {
      throw new DomainError('PAYMENT_INVALID_AMOUNT', 'amountMinor must be > 0', 422);
    }
    let sum = 0n;
    for (const [index, tender] of input.tenders.entries()) {
      if (tender.amountMinor <= 0n) {
        throw new DomainError(
          'PAYMENT_INVALID_AMOUNT',
          `tenders[${index}].amountMinor must be > 0`,
          422,
        );
      }
      // A provider-backed tender (ONLINE_GATEWAY always; CARD_TERMINAL only
      // when `providerCredentialId` is actually present) can never be
      // smuggled into the atomic synchronous path, full stop — checked
      // against the REAL field value, not a hardcoded `null`, so an internal
      // caller that constructs this object directly (bypassing the DTO/HTTP
      // layer entirely) cannot silently defeat this classification.
      if (isProviderBackedTender(tender.method, tender.providerCredentialId ?? null)) {
        throw new DomainError(
          'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
          `tenders[${index}] (${tender.method}${
            tender.providerCredentialId ? ', provider-backed' : ''
          }) requires the async PaymentAttempt/provider flow and cannot participate in a synchronous atomic payment`,
          422,
        );
      }
      sum += tender.amountMinor;
    }
    if (sum !== input.amountMinor) {
      throw new DomainError(
        'PAYMENT_MULTI_PAYMENT_SUM_MISMATCH',
        `tender amounts sum to ${sum}, which does not equal the intended payment amount ${input.amountMinor}`,
        422,
      );
    }

    // ── 1. lock the target Invoice in EXACT trusted tenant/company/branch
    //      scope — a wrong company/branch never matches this WHERE clause,
    //      regardless of DB RLS (which is tenant-only, Checkpoint B §1). ────
    const invoiceRows = await tx.$queryRaw<
      {
        id: string;
        orderId: string;
        currencyCode: string;
        currencyExponent: number;
        totalAmountMinor: bigint;
      }[]
    >`
      SELECT "id", "orderId", "currencyCode", "currencyExponent", "totalAmountMinor"
        FROM "invoice"
       WHERE "id" = ${input.invoiceId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    const invoice = invoiceRows[0];
    if (!invoice) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');

    // ── 2. load (not lock — an issued Order's commercial fields are already
    //      immutable, 3b.3 Checkpoint C triggers) the Order this Invoice was
    //      issued from, ONCE — every component tender's PaymentAttempt binds
    //      to this SAME snapshot (§D19), never re-read per tender. ─────────
    const orderRows = await tx.$queryRaw<
      { id: string; commercialSnapshotFingerprint: string; version: number }[]
    >`
      SELECT "id", "commercialSnapshotFingerprint", "version"
        FROM "order"
       WHERE "id" = ${invoice.orderId}::uuid`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');

    // ── 3/4/5. confirmed allocations + active provider-backed reservations,
    //      computed ONCE under the Invoice lock above — then the frozen
    //      pure formula, checked against the REQUEST TOTAL (not per-tender). ─
    const confirmedRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total
        FROM "payment_allocation"
       WHERE "invoiceId" = ${invoice.id}::uuid`;
    const confirmedAmountMinor = confirmedRows[0]!.total;

    const reservedRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(pa."amountMinor"), 0)::bigint AS total
        FROM "payment_attempt" pa
       WHERE pa."targetInvoiceId" = ${invoice.id}::uuid
         AND pa."providerCredentialId" IS NOT NULL
         AND pa."state" IN ('PENDING', 'REQUIRES_ACTION', 'AUTHORIZED')
         AND NOT EXISTS (SELECT 1 FROM "payment" p WHERE p."sourceAttemptId" = pa."id")`;
    const activeReservedAmountMinor = reservedRows[0]!.total;

    const availableToCollect = computeAvailableToCollect(
      invoice.totalAmountMinor,
      confirmedAmountMinor,
      activeReservedAmountMinor,
    );

    if (input.amountMinor > availableToCollect) {
      throw new DomainError(
        'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
        `requested amount ${input.amountMinor} exceeds the currently available ${availableToCollect}`,
        409,
      );
    }

    // ── D6: mint exactly one server-side group id, ONLY when there is more
    //    than one tender — a single-tender request keeps paymentGroupId
    //    NULL, unchanged from Checkpoint C. Uses the schema's own `uuidv7()`
    //    generator (no application-side UUID convention exists anywhere
    //    else in this codebase — every id is DB-generated) so the group id
    //    is time-ordered exactly like every other id in this schema. ───────
    let paymentGroupId: string | null = null;
    if (input.tenders.length > 1) {
      const groupRows = await tx.$queryRaw<{ id: string }[]>`SELECT uuidv7() AS id`;
      paymentGroupId = groupRows[0]!.id;
    }

    // ── D19: the SAME binding snapshot is asserted for every component —
    //    never re-read per tender. Pure RangeError mapped to a DomainError
    //    at this service boundary, exactly like Checkpoint C. ─────────────
    try {
      assertPaymentAttemptOrderBinding({
        expectedFingerprint: order.commercialSnapshotFingerprint,
        liveFingerprint: order.commercialSnapshotFingerprint,
        expectedVersion: order.version,
        liveVersion: order.version,
      });
    } catch (err) {
      if (err instanceof RangeError) {
        throw new DomainError('ORDER_COMMERCIAL_STATE_CHANGED', err.message, 409);
      }
      throw err;
    }

    // ── D7: one attempt/event/Payment/Allocation per tender, in REQUEST
    //    ORDER, all inside this same transaction. Any failure here rolls
    //    back everything already written in this call — no partial Multi
    //    Payment (the caller's transaction is the only commit boundary). ──
    const payments: CapturedTenderResult[] = [];
    for (const tender of input.tenders) {
      const attemptRows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "payment_attempt"
          ("tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "paymentGroupId", "method",
           "amountMinor", "currencyCode", "currencyExponent", "state",
           "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
           "idempotencyKey", "createdByUserId", "actingUserId", "updatedAt")
        VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
                ${order.id}::uuid, ${invoice.id}::uuid, ${paymentGroupId}::uuid, ${tender.method},
                ${tender.amountMinor}, ${invoice.currencyCode}, ${invoice.currencyExponent}, 'PENDING',
                ${order.commercialSnapshotFingerprint}, ${order.version},
                ${input.idempotencyKey}, ${input.createdByUserId}::uuid, ${input.actingUserId}::uuid, now())
        RETURNING "id"`;
      const attemptId = attemptRows[0]!.id;

      await tx.$queryRaw`
        UPDATE "payment_attempt" SET "state" = 'CAPTURED', "updatedAt" = now()
         WHERE "id" = ${attemptId}::uuid`;
      await tx.$queryRaw`
        INSERT INTO "payment_attempt_event"
          ("tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", "source")
        VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
                ${attemptId}::uuid, 'PENDING', 'CAPTURED', 'USER')`;

      // ── owner §G4/§G7 — a REAL PaymentAttempt state transition
      //    (PENDING -> CAPTURED), co-committed with the transition itself. ──
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
          invoiceId: invoice.id,
          paymentGroupId,
          method: tender.method,
          fromState: 'PENDING',
          toState: 'CAPTURED',
        },
      });

      const paymentRows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "payment"
          ("tenantId", "companyId", "branchId", "paymentGroupId", "sourceAttemptId", "method",
           "amountMinor", "currencyCode", "currencyExponent", "createdByUserId", "actingUserId")
        VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
                ${paymentGroupId}::uuid, ${attemptId}::uuid, ${tender.method},
                ${tender.amountMinor}, ${invoice.currencyCode}, ${invoice.currencyExponent},
                ${input.createdByUserId}::uuid, ${input.actingUserId}::uuid)
        RETURNING "id"`;
      const paymentId = paymentRows[0]!.id;

      const allocationRows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "payment_allocation"
          ("tenantId", "companyId", "branchId", "paymentId", "invoiceId",
           "amountMinor", "currencyCode", "currencyExponent")
        VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
                ${paymentId}::uuid, ${invoice.id}::uuid,
                ${tender.amountMinor}, ${invoice.currencyCode}, ${invoice.currencyExponent})
        RETURNING "id"`;
      const allocationId = allocationRows[0]!.id;

      // ── owner §G3/§G6 — exactly one audit + one outbox row per immutable
      //    Payment created, co-committed with Payment+Allocation. ──────────
      await this.audit.record(tx, {
        action: 'payment.recorded',
        resourceType: 'payment',
        resourceId: paymentId,
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        after: {
          invoiceId: invoice.id,
          paymentGroupId,
          method: tender.method,
          amountMinor: tender.amountMinor.toString(),
          currencyCode: invoice.currencyCode,
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
          invoiceId: invoice.id,
          paymentGroupId,
          method: tender.method,
          amountMinor: tender.amountMinor.toString(),
          currencyCode: invoice.currencyCode,
          currencyExponent: invoice.currencyExponent,
        },
      });

      payments.push({
        paymentId,
        paymentAttemptId: attemptId,
        paymentAllocationId: allocationId,
        method: tender.method,
        amountMinor: tender.amountMinor,
      });
    }

    return {
      paymentGroupId,
      invoiceId: invoice.id,
      amountMinor: input.amountMinor,
      currencyCode: invoice.currencyCode,
      currencyExponent: invoice.currencyExponent,
      payments,
      remainingAvailableToCollectMinor: availableToCollect - input.amountMinor,
    };
  }

  /**
   * @deprecated Checkpoint C shape-compatible delegate — every existing
   * Checkpoint C call site/test keeps working unchanged; internally this is
   * now exactly the `tenders.length === 1` case of
   * {@link captureSynchronousTendersInTx}.
   */
  async captureSingleTenderInTx(
    tx: ScopedTx,
    input: CaptureSingleTenderInput,
  ): Promise<CaptureSingleTenderResult> {
    const result = await this.captureSynchronousTendersInTx(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      invoiceId: input.invoiceId,
      amountMinor: input.amountMinor,
      tenders: [{ method: input.method, amountMinor: input.amountMinor }],
      createdByUserId: input.createdByUserId,
      actingUserId: input.actingUserId,
      idempotencyKey: input.idempotencyKey,
    });
    const only = result.payments[0]!;
    return {
      paymentId: only.paymentId,
      paymentAttemptId: only.paymentAttemptId,
      paymentAllocationId: only.paymentAllocationId,
      invoiceId: result.invoiceId,
      method: only.method,
      amountMinor: only.amountMinor,
      currencyCode: result.currencyCode,
      currencyExponent: result.currencyExponent,
      remainingAvailableToCollectMinor: result.remainingAvailableToCollectMinor,
    };
  }
}
