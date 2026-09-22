import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `PaymentCollectionRepository`
// exactly, task 3b.5 Checkpoint E): these are internal primitives that
// PARTICIPATE in a caller's already-open transaction, never open their own.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { computeAvailableToCollect } from './available-to-collect.js';
import { assertPaymentAttemptOrderBinding } from './order-binding.js';
import { isProviderBackedTender, type TenderMethod } from './tender.js';
import { assertPaymentAttemptTransition } from './payment-attempt-state.js';
import type { PaymentProviderInitiationState } from './payment-provider.port.js';
import type { PaymentEventType } from './payment-events.js';

/** The client-semantic fields that identify "this logical request" for the
 *  DB-fallback idempotency check (owner recovery-pass §6) — every field a
 *  retry must match exactly for an existing row to be treated as a genuine
 *  replay, rather than a different request that merely reused the same
 *  Idempotency-Key. Deliberately excludes `providerCredentialId` — that is
 *  a server-resolved identity, never part of the client's own request. */
export interface SemanticAsyncAttemptRequest {
  companyId: string;
  branchId: string;
  invoiceId: string;
  /** ONLINE_GATEWAY, or CARD_TERMINAL only when provider-backed — checked
   *  here via `isProviderBackedTender(method, providerCredentialId)`, the
   *  SAME frozen Checkpoint A classification C/D's synchronous path uses
   *  for the opposite (local-only) restriction. */
  method: TenderMethod;
  providerKey: string;
  amountMinor: bigint;
}

export interface FindExistingAttemptInput extends SemanticAsyncAttemptRequest {
  tenantId: string;
  createdByUserId: string | null;
  idempotencyKey: string;
}

export interface ReserveAsyncAttemptInput extends SemanticAsyncAttemptRequest {
  tenantId: string;
  providerCredentialId: string;
  createdByUserId: string | null;
  actingUserId: string | null;
  idempotencyKey: string;
}

export interface ReservedAsyncAttempt {
  paymentAttemptId: string;
  invoiceId: string;
  method: TenderMethod;
  providerKey: string;
  /** the ORIGINAL provider account/config this attempt is bound to — a
   *  recovered attempt's provider call MUST reuse this exact value, never a
   *  freshly-resolved one (owner recovery-pass §7). */
  providerCredentialId: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  state: PaymentProviderInitiationState;
  /** true when this call discovered and reused an already-reserved attempt
   *  from a prior (partial or complete) execution of this SAME logical
   *  request, rather than inserting a new row — see the Checkpoint E
   *  migration `20260924120000_payments_provider_reference_uniqueness`
   *  doc comment for exactly why this can legitimately happen even though
   *  the shared HTTP idempotency store also exists. When `true` AND
   *  `state === 'PENDING'`, the caller MUST retry provider initiation using
   *  this SAME attempt's identity (owner recovery-pass §3) rather than
   *  treat it as already resolved; when `true` and `state !== 'PENDING'`
   *  the result is already durably resolved and the provider must NOT be
   *  called again. */
  reused: boolean;
}

interface AttemptRow {
  id: string;
  state: string;
  method: string;
  providerKey: string;
  providerCredentialId: string | null;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  targetInvoiceId: string;
  companyId: string;
  branchId: string;
}

function toReservedAttempt(row: AttemptRow, reused: boolean): ReservedAsyncAttempt {
  return {
    paymentAttemptId: row.id,
    invoiceId: row.targetInvoiceId,
    method: row.method as TenderMethod,
    providerKey: row.providerKey,
    // guaranteed non-null: every row reachable through this repository's
    // own lookups/inserts is a provider-backed async attempt.
    providerCredentialId: row.providerCredentialId!,
    amountMinor: row.amountMinor,
    currencyCode: row.currencyCode,
    currencyExponent: row.currencyExponent,
    state: row.state as PaymentProviderInitiationState,
    reused,
  };
}

/**
 * DB-fallback recovery is discovery, never blind trust (owner recovery-pass
 * §6): an existing row found only by `(tenantId, createdByUserId,
 * idempotencyKey)` must still match the CURRENT request's own semantic
 * identity before it is treated as "the same request, safe to recover."
 * Every field a client-controlled input can vary is compared; scope fields
 * already baked into the lookup's own WHERE clause (tenantId,
 * createdByUserId) are not re-checked here.
 */
function assertSameSemanticRequest(existing: AttemptRow, input: SemanticAsyncAttemptRequest): void {
  const same =
    existing.companyId === input.companyId &&
    existing.branchId === input.branchId &&
    existing.targetInvoiceId === input.invoiceId &&
    existing.method === input.method &&
    existing.providerKey === input.providerKey &&
    existing.amountMinor === input.amountMinor;
  if (!same) {
    throw new DomainError(
      'IDEMPOTENCY_KEY_REUSED',
      'this Idempotency-Key was already used for a different async payment-attempt request',
      409,
    );
  }
}

export interface ApplyProviderInitiationResultInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  paymentAttemptId: string;
  invoiceId: string;
  resultState: PaymentProviderInitiationState;
  providerReference?: string | null;
}

export interface AppliedProviderInitiationResult {
  paymentAttemptId: string;
  state: PaymentProviderInitiationState;
  providerReference: string | null;
  /** whether a real state CHANGE occurred (false for a same-state /
   *  no-op result, owner §E15) — the caller uses this to decide whether a
   *  `PaymentAttemptEvent` was written. */
  transitioned: boolean;
}

/**
 * Task 3b.5 Checkpoint E — the async PaymentAttempt reservation primitives.
 * Two independent phases, EACH participating in a caller-owned transaction
 * that the caller opens/commits separately (never opened here) — the
 * external provider call that must happen BETWEEN them is entirely outside
 * this class's concern (owner §E8/§E11): this file never calls a provider
 * adapter, never imports the registry.
 */
@Injectable()
export class PaymentAttemptReservationRepository {
  constructor(
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  /**
   * Recovery discovery step (owner recovery-pass §3/§6) — a cheap,
   * lock-free lookup the orchestration runs BEFORE deciding whether it even
   * needs to resolve a (possibly-current, possibly-different)
   * `ProviderCredential` at all. Returns `null` when no attempt exists yet
   * for this `(tenantId, createdByUserId, idempotencyKey)` triple — the
   * orchestration then proceeds to resolve config and call
   * {@link reserveAsyncAttemptInTx} normally. Returns the existing attempt
   * (`reused: true`) when one is found AND its semantic identity matches
   * this request exactly; throws `IDEMPOTENCY_KEY_REUSED` (fails closed,
   * never overwrites, never proceeds) when one is found but does NOT match.
   *
   * Never re-resolves or rebinds `providerCredentialId` — the returned
   * value is always the ORIGINAL credential the attempt was created with
   * (owner recovery-pass §7).
   */
  async findExistingForRecoveryInTx(
    tx: ScopedTx,
    input: FindExistingAttemptInput,
  ): Promise<ReservedAsyncAttempt | null> {
    if (!input.createdByUserId) return null;
    const existing = await this.lookupByIdempotencyKey(
      tx,
      input.tenantId,
      input.createdByUserId,
      input.idempotencyKey,
    );
    if (!existing) return null;
    assertSameSemanticRequest(existing, input);
    return toReservedAttempt(existing, true);
  }

  private async lookupByIdempotencyKey(
    tx: ScopedTx,
    tenantId: string,
    createdByUserId: string,
    idempotencyKey: string,
  ): Promise<AttemptRow | null> {
    const rows = await tx.$queryRaw<AttemptRow[]>`
      SELECT "id", "state", "method", "providerKey", "providerCredentialId",
             "amountMinor", "currencyCode", "currencyExponent", "targetInvoiceId",
             "companyId", "branchId"
        FROM "payment_attempt"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "createdByUserId" = ${createdByUserId}::uuid
         AND "idempotencyKey" = ${idempotencyKey}`;
    return rows[0] ?? null;
  }

  /**
   * PHASE 1 (owner §E8/§E9) — reserve before any provider call. Idempotent
   * at the DB level (owner §E18 finding; migration
   * `20260924120000_payments_provider_reference_uniqueness`): a repeat
   * invocation with the SAME `(tenantId, createdByUserId, idempotencyKey)`
   * discovers and returns the existing reservation rather than creating a
   * second one — required because this phase's commit can outlive the
   * overall HTTP request/response cycle that the shared idempotency store
   * actually protects (see that migration's doc comment for the full
   * reasoning). The Invoice lock is taken ONLY on the create path — a pure
   * reuse never needs it. Callers that already ran
   * {@link findExistingForRecoveryInTx} and got `null` still reach this
   * method's own lookup below — it is the race-safe backstop for two
   * concurrent identical retries both passing that earlier check before
   * either has inserted.
   */
  async reserveAsyncAttemptInTx(
    tx: ScopedTx,
    input: ReserveAsyncAttemptInput,
  ): Promise<ReservedAsyncAttempt> {
    // ── idempotent reuse lookup — FIRST, before any lock/validation, so a
    //    retry of an already-reserved request is never rejected merely
    //    because current availability has since changed. A row found here
    //    is verified against the CURRENT request's own semantic identity
    //    before being trusted as a genuine replay (owner recovery-pass §6)
    //    — a mismatch fails closed as `IDEMPOTENCY_KEY_REUSED`, never
    //    silently accepted, never overwritten, never routed to a provider
    //    call. ─────────────────────────────────────────────────────────────
    if (input.createdByUserId) {
      const existing = await this.lookupByIdempotencyKey(
        tx,
        input.tenantId,
        input.createdByUserId,
        input.idempotencyKey,
      );
      if (existing) {
        assertSameSemanticRequest(existing, input);
        return toReservedAttempt(existing, true);
      }
    }

    if (input.amountMinor <= 0n) {
      throw new DomainError('PAYMENT_INVALID_AMOUNT', 'amountMinor must be > 0', 422);
    }
    if (!isProviderBackedTender(input.method, input.providerCredentialId)) {
      throw new DomainError(
        'PAYMENT_METHOD_NOT_ALLOWED_FOR_ASYNC_ATTEMPT',
        `method ${input.method} is not a provider-backed tender and cannot be used to create an async PaymentAttempt`,
        422,
      );
    }

    // ── 1. lock the target Invoice in EXACT trusted scope — mirrors
    //      `PaymentCollectionRepository` exactly (frozen C/D query). ───────
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

    // ── 2. load the Order this Invoice was issued from. ───────────────────
    const orderRows = await tx.$queryRaw<
      { id: string; commercialSnapshotFingerprint: string; version: number }[]
    >`
      SELECT "id", "commercialSnapshotFingerprint", "version"
        FROM "order"
       WHERE "id" = ${invoice.orderId}::uuid`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');

    // ── 3/4/5. the SAME frozen reservation formula (owner §E9, reused
    //      verbatim from C/D — no reservation table). ─────────────────────
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

    // ── 10/11. insert PENDING — `ON CONFLICT DO NOTHING` on the Checkpoint
    //      E idempotency-reuse unique index is the race-safe backstop for
    //      two concurrent identical retries both passing the lookup above
    //      before either has inserted (the Invoice `FOR UPDATE` lock above
    //      already serializes DIFFERENT requests against the SAME invoice,
    //      but two IDENTICAL requests naturally target the same invoice
    //      too, so this second guard is still required). ──────────────────
    const insertedRows = await tx.$queryRaw<AttemptRow[]>`
      INSERT INTO "payment_attempt"
        ("tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "paymentGroupId",
         "method", "providerKey", "providerCredentialId",
         "amountMinor", "currencyCode", "currencyExponent", "state",
         "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
         "idempotencyKey", "createdByUserId", "actingUserId", "updatedAt")
      VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
              ${order.id}::uuid, ${invoice.id}::uuid, NULL,
              ${input.method}, ${input.providerKey}, ${input.providerCredentialId}::uuid,
              ${input.amountMinor}, ${invoice.currencyCode}, ${invoice.currencyExponent}, 'PENDING',
              ${order.commercialSnapshotFingerprint}, ${order.version},
              ${input.idempotencyKey}, ${input.createdByUserId}::uuid, ${input.actingUserId}::uuid, now())
      ON CONFLICT ("tenantId", "createdByUserId", "idempotencyKey")
        WHERE "providerCredentialId" IS NOT NULL
        DO NOTHING
      RETURNING "id", "state", "method", "providerKey", "providerCredentialId",
                "amountMinor", "currencyCode", "currencyExponent", "targetInvoiceId",
                "companyId", "branchId"`;

    const inserted = insertedRows[0];
    if (inserted) {
      // ── owner §G5/§G7 — a NEW async reservation is a durable, audited
      //    fact (no outbox event — creating a PENDING reservation is not a
      //    "state transition" and G4 explicitly scopes
      //    `attempt_state_changed` to real transitions only). ─────────────
      await this.audit.record(tx, {
        action: 'payment_attempt.reserved',
        resourceType: 'payment_attempt',
        resourceId: inserted.id,
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        after: {
          invoiceId: inserted.targetInvoiceId,
          method: inserted.method,
          providerKey: inserted.providerKey,
          amountMinor: inserted.amountMinor.toString(),
        },
      });
      return toReservedAttempt(inserted, false);
    }

    // lost a race against a concurrent retry using the SAME key — fetch what
    // it created and verify it is genuinely the SAME semantic request before
    // trusting it (owner recovery-pass §6 applies here too: two concurrent
    // requests racing under an identical key are not guaranteed to carry an
    // identical body).
    const race = input.createdByUserId
      ? await this.lookupByIdempotencyKey(
          tx,
          input.tenantId,
          input.createdByUserId,
          input.idempotencyKey,
        )
      : null;
    if (!race) {
      throw new DomainError(
        'PAYMENT_ATTEMPT_RESERVATION_RACE_UNRESOLVED',
        'a concurrent identical reservation request could not be resolved',
        409,
      );
    }
    assertSameSemanticRequest(race, input);
    return toReservedAttempt(race, true);
  }

  /**
   * PHASE 2 (owner §E14) — apply a provider-initiation result. Opens in a
   * NEW transaction the caller owns, always strictly AFTER the external
   * provider call has already returned. Never creates Payment/Allocation.
   * Never applies a state the frozen transition graph forbids (illegal
   * transitions fail closed via `assertPaymentAttemptTransition`, reused
   * verbatim from Checkpoint A).
   */
  async applyProviderInitiationResultInTx(
    tx: ScopedTx,
    input: ApplyProviderInitiationResultInput,
  ): Promise<AppliedProviderInitiationResult> {
    // ── 1/2. lock Invoice then PaymentAttempt, in that fixed order (matches
    //      every other payments-module lock order in this repository). ────
    const invoiceRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
        FROM "invoice"
       WHERE "id" = ${input.invoiceId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    if (!invoiceRows[0]) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');

    const attemptRows = await tx.$queryRaw<
      {
        id: string;
        state: string;
        targetInvoiceId: string;
        orderId: string;
        providerReference: string | null;
        orderCommercialSnapshotFingerprintAtCreation: string;
        orderVersionAtCreation: number;
        method: string;
        paymentGroupId: string | null;
      }[]
    >`
      SELECT "id", "state", "targetInvoiceId", "orderId", "providerReference",
             "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
             "method", "paymentGroupId"
        FROM "payment_attempt"
       WHERE "id" = ${input.paymentAttemptId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    const attempt = attemptRows[0];
    if (!attempt) throw new NotFoundError('payment attempt', 'PAYMENT_ATTEMPT_NOT_FOUND');

    // ── 4. attempt still targets this Invoice. ─────────────────────────────
    if (attempt.targetInvoiceId !== input.invoiceId) {
      throw new DomainError(
        'PAYMENT_ATTEMPT_INVOICE_MISMATCH',
        'this PaymentAttempt no longer targets the expected Invoice',
        409,
      );
    }

    // ── 5. Order fingerprint + version binding, reused verbatim. ──────────
    const orderRows = await tx.$queryRaw<
      { commercialSnapshotFingerprint: string; version: number }[]
    >`
      SELECT "commercialSnapshotFingerprint", "version"
        FROM "order"
       WHERE "id" = ${attempt.orderId}::uuid`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');
    try {
      assertPaymentAttemptOrderBinding({
        expectedFingerprint: attempt.orderCommercialSnapshotFingerprintAtCreation,
        liveFingerprint: order.commercialSnapshotFingerprint,
        expectedVersion: attempt.orderVersionAtCreation,
        liveVersion: order.version,
      });
    } catch (err) {
      if (err instanceof RangeError) {
        throw new DomainError('ORDER_COMMERCIAL_STATE_CHANGED', err.message, 409);
      }
      throw err;
    }

    const fromState = attempt.state as PaymentProviderInitiationState;

    // ── E15: a same-state result is a no-op — no transition check, no
    //      event, providerReference may still be set. ─────────────────────
    if (fromState === input.resultState) {
      if (input.providerReference !== undefined && input.providerReference !== null) {
        await tx.$queryRaw`
          UPDATE "payment_attempt"
             SET "providerReference" = ${input.providerReference}, "updatedAt" = now()
           WHERE "id" = ${attempt.id}::uuid`;
      }
      return {
        paymentAttemptId: attempt.id,
        state: fromState,
        providerReference: input.providerReference ?? attempt.providerReference,
        transitioned: false,
      };
    }

    // ── 6. legal-state-for-this-result check — the frozen Checkpoint A
    //      transition graph, reused verbatim (CAPTURED is structurally
    //      unreachable here since `resultState`'s TYPE excludes it). ──────
    try {
      assertPaymentAttemptTransition(fromState, input.resultState);
    } catch (err) {
      if (err instanceof RangeError) {
        throw new DomainError('PAYMENT_ATTEMPT_INVALID_TRANSITION', err.message, 409);
      }
      throw err;
    }

    // ── 7/8. set providerReference (set-once trigger enforces the DB
    //      invariant) and perform the transition, in one UPDATE. ──────────
    await tx.$queryRaw`
      UPDATE "payment_attempt"
         SET "state" = ${input.resultState},
             "providerReference" = COALESCE(${input.providerReference ?? null}, "providerReference"),
             "updatedAt" = now()
       WHERE "id" = ${attempt.id}::uuid`;

    // ── 9. append-only transition event, source = SYSTEM. ──────────────────
    await tx.$queryRaw`
      INSERT INTO "payment_attempt_event"
        ("tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", "source")
      VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
              ${attempt.id}::uuid, ${fromState}, ${input.resultState}, 'SYSTEM')`;

    // ── owner §G4/§G7 — a REAL PaymentAttempt state transition,
    //    co-committed with the transition itself. Never for the same-state
    //    no-op case above (already returned before reaching here). ────────
    await this.audit.record(tx, {
      action: 'payment_attempt.state_changed',
      resourceType: 'payment_attempt',
      resourceId: attempt.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      before: { state: fromState },
      after: { state: input.resultState },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'payment_attempt',
      aggregateId: attempt.id,
      eventType: 'payments.attempt_state_changed' satisfies PaymentEventType,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      payload: {
        paymentAttemptId: attempt.id,
        invoiceId: input.invoiceId,
        paymentGroupId: attempt.paymentGroupId,
        method: attempt.method,
        fromState,
        toState: input.resultState,
      },
    });

    return {
      paymentAttemptId: attempt.id,
      state: input.resultState,
      providerReference: input.providerReference ?? attempt.providerReference,
      transitioned: true,
    };
  }
}
