import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `PaymentAttemptReservationRepository`
// exactly, task 3b.5 Checkpoint F): this is an internal primitive that
// PARTICIPATES in a caller's already-open transaction, never opens its own.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { assertPaymentAttemptOrderBinding } from './order-binding.js';
import { canTransitionPaymentAttempt, type PaymentAttemptState } from './payment-attempt-state.js';
import type { WebhookVerifiedTargetState } from './payment-provider.port.js';
import type { PaymentEventType, ProviderEventExceptionReason } from './payment-events.js';

export interface ProcessVerifiedInboxEventInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  inboxId: string;
}

export type ProcessVerifiedInboxEventOutcome =
  /** the event was already terminal (PROCESSED/EXCEPTION) before this call
   *  — a pure no-op, per owner §F14/§F10. */
  | 'ALREADY_TERMINAL'
  /** a legal transition (or same-state no-op) applied, or a durably-scheduled
   *  successful CAPTURED conversion. */
  | 'PROCESSED'
  /** a legitimate verified event that cannot be safely applied — no
   *  PaymentAttempt/Payment/Allocation mutation occurred. */
  | 'EXCEPTION'
  /** another transaction currently holds this inbox row's lock (owner
   *  reliability-pass §2/§3-C) — nothing happened here; the row is still
   *  RECEIVED and will be retried by a later pass. Never a failure. */
  | 'SKIPPED';

/** Everything `finalize`/`finalizeUnlocked` need to write a bounded
 *  `provider_payment_event.exception` audit row (owner §G8) — never the raw
 *  provider payload, only ids/eventType/a closed reason code. */
interface FinalizeContext {
  tenantId: string;
  companyId: string;
  branchId: string;
  inboxId: string;
  eventType: string;
  paymentAttemptId: string | null;
}

/**
 * Task 3b.5 Checkpoint F — the verified-webhook money/state processing
 * primitive (owner §F13-§F24, Checkpoint G audit/outbox completion).
 * Reloads every fact it needs from the DURABLE inbox row and the live
 * `payment_attempt`/`invoice`/`order` rows under lock — NEVER trusts a
 * caller-supplied tenant/company/branch/attempt id/state/amount beyond the
 * `inboxId` itself (owner §F13: "the processor must reload the inbox
 * row... do not trust queue payload").
 *
 * Canonical lock order (owner §F16, preserving C/D/E's own convention
 * exactly): Invoice FIRST, PaymentAttempt SECOND, then re-verify the inbox
 * row itself (also row-locked) is still RECEIVED — Invoice+Attempt locking
 * already serializes every concurrent path that could touch this same
 * money (owner §F26), so no separate inbox-row lock ordering concern
 * exists ahead of them.
 *
 * Checkpoint G additions, all co-committed with the mutation they describe:
 * `payment_attempt.state_changed` + `payments.attempt_state_changed` for
 * every REAL transition (never same-state); `payment.recorded` +
 * `payments.payment_recorded` once per verified CAPTURED conversion;
 * `provider_payment_event.exception` (audit only, reason-coded, no
 * outbox/realtime — an internal reconciliation signal, not a business
 * event) for every EXCEPTION finalization.
 */
@Injectable()
export class WebhookEventProcessorRepository {
  constructor(
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async processVerifiedInboxEventInTx(
    tx: ScopedTx,
    input: ProcessVerifiedInboxEventInput,
  ): Promise<ProcessVerifiedInboxEventOutcome> {
    // ── a cheap, UNLOCKED read of the inbox row purely to learn whether a
    //    correlated attempt exists at all, and if so which Invoice it
    //    targets — no lock is taken yet (owner §F16 item 1: "identify
    //    target Invoice/attempt IDs from verified durable inbox"). The
    //    AUTHORITATIVE, race-safe re-check happens after the locks below. ──
    const inboxPeekRows = await tx.$queryRaw<
      {
        id: string;
        status: string;
        providerCredentialId: string;
        paymentAttemptId: string | null;
        providerReference: string | null;
        targetState: string | null;
        eventType: string;
      }[]
    >`
      SELECT "id", "status", "providerCredentialId", "paymentAttemptId", "providerReference",
             "targetState", "eventType"
        FROM "provider_payment_event"
       WHERE "id" = ${input.inboxId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid`;
    const peek = inboxPeekRows[0];
    if (!peek) return 'EXCEPTION'; // unreachable in practice — caller already knows this id exists
    if (peek.status !== 'RECEIVED') return 'ALREADY_TERMINAL';

    const baseCtx: FinalizeContext = {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      inboxId: peek.id,
      eventType: peek.eventType,
      paymentAttemptId: peek.paymentAttemptId,
    };

    if (!peek.paymentAttemptId) {
      // an unsupported-but-verified event with no PaymentAttempt target
      // (owner §F7) — no money movement is even conceivable; finalize
      // EXCEPTION directly. Still re-verified under a row lock below.
      return this.finalizeUnlocked(tx, baseCtx, 'UNSUPPORTED_TARGET_STATE');
    }

    // ── a cheap, UNLOCKED read of the attempt purely to discover its
    //    targetInvoiceId (needed to know what to lock FIRST) and to prove
    //    correlation (owner §F15) BEFORE taking any lock at all — a
    //    correlation failure needs no lock either. ─────────────────────────
    const attemptPeekRows = await tx.$queryRaw<{ targetInvoiceId: string }[]>`
      SELECT "targetInvoiceId"
        FROM "payment_attempt"
       WHERE "id" = ${peek.paymentAttemptId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid
         AND "providerCredentialId" = ${peek.providerCredentialId}::uuid`;
    const attemptPeek = attemptPeekRows[0];
    if (!attemptPeek) {
      // wrong scope / wrong credential / nonexistent attempt — owner §F15:
      // "Never allow one branch/account's signed event to mutate another
      // credential's attempt."
      return this.finalizeUnlocked(tx, baseCtx, 'UNKNOWN_OR_CROSS_SCOPE_ATTEMPT');
    }

    // ── 3. lock Invoice FIRST. ──────────────────────────────────────────
    const invoiceRows = await tx.$queryRaw<{ id: string; totalAmountMinor: bigint }[]>`
      SELECT "id", "totalAmountMinor"
        FROM "invoice"
       WHERE "id" = ${attemptPeek.targetInvoiceId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    const invoice = invoiceRows[0];
    if (!invoice) return this.finalizeUnlocked(tx, baseCtx, 'UNKNOWN_OR_CROSS_SCOPE_ATTEMPT');

    // ── 4. lock PaymentAttempt SECOND — the authoritative, race-safe read. ─
    const attemptRows = await tx.$queryRaw<
      {
        id: string;
        state: string;
        orderId: string;
        providerCredentialId: string | null;
        providerKey: string | null;
        method: string;
        amountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
        paymentGroupId: string | null;
        providerReference: string | null;
        orderCommercialSnapshotFingerprintAtCreation: string;
        orderVersionAtCreation: number;
      }[]
    >`
      SELECT "id", "state", "orderId", "providerCredentialId", "providerKey", "method",
             "amountMinor", "currencyCode", "currencyExponent", "paymentGroupId",
             "providerReference", "orderCommercialSnapshotFingerprintAtCreation",
             "orderVersionAtCreation"
        FROM "payment_attempt"
       WHERE "id" = ${peek.paymentAttemptId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid
         AND "targetInvoiceId" = ${invoice.id}::uuid
       FOR UPDATE`;
    const attempt = attemptRows[0];
    if (!attempt) return this.finalizeUnlocked(tx, baseCtx, 'UNKNOWN_OR_CROSS_SCOPE_ATTEMPT');

    // ── 5. reload/verify the inbox row itself, now row-locked. Uses
    //      `SKIP LOCKED` (owner reliability-pass §2) so a concurrent
    //      recovery-worker pass (or the immediate post-webhook call racing
    //      it) never BLOCKS waiting for a row another instance is already
    //      handling — it simply moves on. The Invoice+Attempt locks above
    //      already fully serialize any TWO calls that reach that far for
    //      the SAME money (owner §F26); this only spares a caller a wait
    //      when another instance already holds this exact inbox row. ─────
    const inboxRows = await tx.$queryRaw<
      {
        id: string;
        status: string;
        providerCredentialId: string;
        paymentAttemptId: string | null;
        providerReference: string | null;
        targetState: string | null;
        eventType: string;
      }[]
    >`
      SELECT "id", "status", "providerCredentialId", "paymentAttemptId", "providerReference",
             "targetState", "eventType"
        FROM "provider_payment_event"
       WHERE "id" = ${input.inboxId}::uuid
       FOR UPDATE SKIP LOCKED`;
    const inbox = inboxRows[0];
    if (!inbox) {
      // either genuinely gone (unreachable — same row already peeked
      // above) or another transaction currently holds its lock — treat
      // both identically: nothing for THIS call to do right now.
      return 'SKIPPED';
    }
    if (inbox.status !== 'RECEIVED') return 'ALREADY_TERMINAL';

    const ctx: FinalizeContext = { ...baseCtx, eventType: inbox.eventType };

    // ── 6. verify scope/account/attempt correlation (owner §F15) — the
    //      credential the event was verified against must be the EXACT
    //      SAME credential the attempt itself was created with. ──────────
    if (attempt.providerCredentialId !== inbox.providerCredentialId) {
      return this.finalize(tx, ctx, 'EXCEPTION', 'CREDENTIAL_MISMATCH');
    }

    // ── providerReference identity (owner §F15). ───────────────────────
    if (inbox.providerReference) {
      if (attempt.providerReference && attempt.providerReference !== inbox.providerReference) {
        return this.finalize(tx, ctx, 'EXCEPTION', 'PROVIDER_REFERENCE_MISMATCH');
      }
      // NULL -> non-NULL: narrow set-once, legitimate for THIS attempt's
      // own provider intent — applied together with the state write below
      // (never written here ahead of the transition, so an EXCEPTION path
      // below never partially mutates the attempt).
    }

    // ── 7. Order fingerprint + version binding (Checkpoint A, reused
    //      verbatim; no tolerance for drift). ───────────────────────────
    const orderRows = await tx.$queryRaw<
      { commercialSnapshotFingerprint: string; version: number }[]
    >`
      SELECT "commercialSnapshotFingerprint", "version"
        FROM "order"
       WHERE "id" = ${attempt.orderId}::uuid`;
    const order = orderRows[0];
    if (!order) return this.finalize(tx, ctx, 'EXCEPTION', 'ORDER_BINDING_MISMATCH');
    try {
      assertPaymentAttemptOrderBinding({
        expectedFingerprint: attempt.orderCommercialSnapshotFingerprintAtCreation,
        liveFingerprint: order.commercialSnapshotFingerprint,
        expectedVersion: attempt.orderVersionAtCreation,
        liveVersion: order.version,
      });
    } catch (err) {
      if (err instanceof RangeError) {
        return this.finalize(tx, ctx, 'EXCEPTION', 'ORDER_BINDING_MISMATCH');
      }
      throw err;
    }

    const fromState = attempt.state as PaymentAttemptState;
    const targetState = inbox.targetState as WebhookVerifiedTargetState | null;
    if (!targetState) return this.finalize(tx, ctx, 'EXCEPTION', 'UNSUPPORTED_TARGET_STATE');

    if (targetState === 'CAPTURED') {
      return this.applyCapture(tx, {
        invoiceId: invoice.id,
        invoiceTotalMinor: invoice.totalAmountMinor,
        attempt: { ...attempt, state: fromState },
        ctx,
        inboxProviderReference: inbox.providerReference,
      });
    }

    return this.applyNonCaptureTransition(tx, {
      fromState,
      targetState,
      attemptId: attempt.id,
      method: attempt.method,
      paymentGroupId: attempt.paymentGroupId,
      invoiceId: invoice.id,
      ctx,
      inboxProviderReference: inbox.providerReference,
    });
  }

  // ══════════════ F17 — non-capture state transitions ═════════════════════
  private async applyNonCaptureTransition(
    tx: ScopedTx,
    p: {
      fromState: PaymentAttemptState;
      targetState: Exclude<WebhookVerifiedTargetState, 'CAPTURED'>;
      attemptId: string;
      method: string;
      paymentGroupId: string | null;
      invoiceId: string;
      ctx: FinalizeContext;
      inboxProviderReference: string | null;
    },
  ): Promise<ProcessVerifiedInboxEventOutcome> {
    if (p.fromState === p.targetState) {
      // same-state — no fake event, no monetary duplication (owner §F17).
      if (p.inboxProviderReference) {
        await tx.$queryRaw`
          UPDATE "payment_attempt"
             SET "providerReference" = ${p.inboxProviderReference}, "updatedAt" = now()
           WHERE "id" = ${p.attemptId}::uuid`;
      }
      return this.finalize(tx, p.ctx, 'PROCESSED');
    }

    if (!canTransitionPaymentAttempt(p.fromState, p.targetState)) {
      // illegal regression/transition — never mutate, inbox EXCEPTION
      // (owner §F17/§F21).
      return this.finalize(tx, p.ctx, 'EXCEPTION', 'ILLEGAL_TRANSITION');
    }

    await tx.$queryRaw`
      UPDATE "payment_attempt"
         SET "state" = ${p.targetState},
             "providerReference" = COALESCE(${p.inboxProviderReference}, "providerReference"),
             "updatedAt" = now()
       WHERE "id" = ${p.attemptId}::uuid`;
    await tx.$queryRaw`
      INSERT INTO "payment_attempt_event"
        ("tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", "source", "providerPaymentEventId")
      VALUES (${p.ctx.tenantId}::uuid, ${p.ctx.companyId}::uuid, ${p.ctx.branchId}::uuid,
              ${p.attemptId}::uuid, ${p.fromState}, ${p.targetState}, 'WEBHOOK', ${p.ctx.inboxId}::uuid)`;

    await this.auditAndEmitAttemptStateChanged(tx, {
      attemptId: p.attemptId,
      invoiceId: p.invoiceId,
      paymentGroupId: p.paymentGroupId,
      method: p.method,
      fromState: p.fromState,
      toState: p.targetState,
      tenantId: p.ctx.tenantId,
      companyId: p.ctx.companyId,
      branchId: p.ctx.branchId,
    });

    return this.finalize(tx, p.ctx, 'PROCESSED');
  }

  // ══════════════ F18/F19/F20/F21 — verified CAPTURED conversion ══════════
  private async applyCapture(
    tx: ScopedTx,
    p: {
      invoiceId: string;
      invoiceTotalMinor: bigint;
      attempt: {
        id: string;
        state: PaymentAttemptState;
        providerKey: string | null;
        method: string;
        amountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
        paymentGroupId: string | null;
        providerReference: string | null;
      };
      ctx: FinalizeContext;
      inboxProviderReference: string | null;
    },
  ): Promise<ProcessVerifiedInboxEventOutcome> {
    const { attempt } = p;

    // ── F20-B — duplicate CAPTURED fact on an ALREADY-CAPTURED attempt:
    //      PROCESSED idempotent no-op when credential/reference identity
    //      matches (the credential match was already proven by the caller
    //      before reaching here); a mismatched reference is a genuine
    //      conflict, never silently accepted. ─────────────────────────────
    if (attempt.state === 'CAPTURED') {
      const referenceMatches =
        !p.inboxProviderReference ||
        !attempt.providerReference ||
        attempt.providerReference === p.inboxProviderReference;
      return this.finalize(
        tx,
        p.ctx,
        referenceMatches ? 'PROCESSED' : 'EXCEPTION',
        referenceMatches ? undefined : 'DUPLICATE_CAPTURED_MISMATCH',
      );
    }

    // ── F21 / illegal-transition fail-closed (also covers late CAPTURED
    //      after FAILED/CANCELED — both are terminal with no outgoing
    //      edge in the frozen graph). ────────────────────────────────────
    if (!canTransitionPaymentAttempt(attempt.state, 'CAPTURED')) {
      return this.finalize(tx, p.ctx, 'EXCEPTION', 'ILLEGAL_TRANSITION');
    }

    // ── F18 — financial invariant, THIS attempt's own reservation
    //      excluded from "other" active reservations. ──────────────────
    const confirmedRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total
        FROM "payment_allocation"
       WHERE "invoiceId" = ${p.invoiceId}::uuid`;
    const confirmed = confirmedRows[0]!.total;

    const otherActiveRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(pa."amountMinor"), 0)::bigint AS total
        FROM "payment_attempt" pa
       WHERE pa."targetInvoiceId" = ${p.invoiceId}::uuid
         AND pa."id" != ${attempt.id}::uuid
         AND pa."providerCredentialId" IS NOT NULL
         AND pa."state" IN ('PENDING', 'REQUIRES_ACTION', 'AUTHORIZED')
         AND NOT EXISTS (SELECT 1 FROM "payment" p WHERE p."sourceAttemptId" = pa."id")`;
    const otherActive = otherActiveRows[0]!.total;

    if (confirmed + otherActive + attempt.amountMinor > p.invoiceTotalMinor) {
      // fail closed — never silently repair financial state (owner §F23-C).
      return this.finalize(tx, p.ctx, 'EXCEPTION', 'FINANCIAL_INVARIANT_VIOLATION');
    }

    // ── F19 — one transaction: transition, event, Payment, Allocation,
    //      finalize. ────────────────────────────────────────────────────
    await tx.$queryRaw`
      UPDATE "payment_attempt"
         SET "state" = 'CAPTURED',
             "providerReference" = COALESCE(${p.inboxProviderReference}, "providerReference"),
             "updatedAt" = now()
       WHERE "id" = ${attempt.id}::uuid`;
    await tx.$queryRaw`
      INSERT INTO "payment_attempt_event"
        ("tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", "source", "providerPaymentEventId")
      VALUES (${p.ctx.tenantId}::uuid, ${p.ctx.companyId}::uuid, ${p.ctx.branchId}::uuid,
              ${attempt.id}::uuid, ${attempt.state}, 'CAPTURED', 'WEBHOOK', ${p.ctx.inboxId}::uuid)`;

    await this.auditAndEmitAttemptStateChanged(tx, {
      attemptId: attempt.id,
      invoiceId: p.invoiceId,
      paymentGroupId: attempt.paymentGroupId,
      method: attempt.method,
      fromState: attempt.state,
      toState: 'CAPTURED',
      tenantId: p.ctx.tenantId,
      companyId: p.ctx.companyId,
      branchId: p.ctx.branchId,
    });

    const paymentRows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "payment"
        ("tenantId", "companyId", "branchId", "paymentGroupId", "sourceAttemptId", "method",
         "providerKey", "amountMinor", "currencyCode", "currencyExponent", "createdByUserId", "actingUserId")
      VALUES (${p.ctx.tenantId}::uuid, ${p.ctx.companyId}::uuid, ${p.ctx.branchId}::uuid,
              ${attempt.paymentGroupId}::uuid, ${attempt.id}::uuid, ${attempt.method},
              ${attempt.providerKey}, ${attempt.amountMinor}, ${attempt.currencyCode},
              ${attempt.currencyExponent}, NULL, NULL)
      RETURNING "id"`;
    const paymentId = paymentRows[0]!.id;

    await tx.$queryRaw`
      INSERT INTO "payment_allocation"
        ("tenantId", "companyId", "branchId", "paymentId", "invoiceId",
         "amountMinor", "currencyCode", "currencyExponent")
      VALUES (${p.ctx.tenantId}::uuid, ${p.ctx.companyId}::uuid, ${p.ctx.branchId}::uuid,
              ${paymentId}::uuid, ${p.invoiceId}::uuid,
              ${attempt.amountMinor}, ${attempt.currencyCode}, ${attempt.currencyExponent})`;

    // ── owner §G3/§G6 — exactly one audit + one outbox row per immutable
    //    Payment created here. `createdByUserId`/`actingUserId` are NULL
    //    above (a provider-originated capture, never a fabricated human
    //    actor — owner §G6) — `AuditWriter.record` then falls back to
    //    `ctx?.accountType ?? 'SYSTEM'`, and there IS no `RequestContext` at
    //    all on this webhook/recovery-worker path, so this naturally
    //    resolves to `actorAccountType: 'SYSTEM'`, `actorUserId: null` —
    //    the existing system-attribution convention, not a special case
    //    invented here. ────────────────────────────────────────────────────
    await this.audit.record(tx, {
      action: 'payment.recorded',
      resourceType: 'payment',
      resourceId: paymentId,
      tenantId: p.ctx.tenantId,
      companyId: p.ctx.companyId,
      branchId: p.ctx.branchId,
      after: {
        invoiceId: p.invoiceId,
        paymentGroupId: attempt.paymentGroupId,
        method: attempt.method,
        amountMinor: attempt.amountMinor.toString(),
        currencyCode: attempt.currencyCode,
      },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'payment',
      aggregateId: paymentId,
      eventType: 'payments.payment_recorded' satisfies PaymentEventType,
      tenantId: p.ctx.tenantId,
      companyId: p.ctx.companyId,
      branchId: p.ctx.branchId,
      payload: {
        paymentId,
        invoiceId: p.invoiceId,
        paymentGroupId: attempt.paymentGroupId,
        method: attempt.method,
        amountMinor: attempt.amountMinor.toString(),
        currencyCode: attempt.currencyCode,
        currencyExponent: attempt.currencyExponent,
      },
    });

    return this.finalize(tx, p.ctx, 'PROCESSED');
  }

  /** owner §G4/§G7 — shared by both the non-capture and capture paths: one
   *  audit + one outbox row per REAL PaymentAttempt state transition. */
  private async auditAndEmitAttemptStateChanged(
    tx: ScopedTx,
    p: {
      attemptId: string;
      invoiceId: string;
      paymentGroupId: string | null;
      method: string;
      fromState: string;
      toState: string;
      tenantId: string;
      companyId: string;
      branchId: string;
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'payment_attempt.state_changed',
      resourceType: 'payment_attempt',
      resourceId: p.attemptId,
      tenantId: p.tenantId,
      companyId: p.companyId,
      branchId: p.branchId,
      before: { state: p.fromState },
      after: { state: p.toState },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'payment_attempt',
      aggregateId: p.attemptId,
      eventType: 'payments.attempt_state_changed' satisfies PaymentEventType,
      tenantId: p.tenantId,
      companyId: p.companyId,
      branchId: p.branchId,
      payload: {
        paymentAttemptId: p.attemptId,
        invoiceId: p.invoiceId,
        paymentGroupId: p.paymentGroupId,
        method: p.method,
        fromState: p.fromState,
        toState: p.toState,
      },
    });
  }

  private async finalize(
    tx: ScopedTx,
    ctx: FinalizeContext,
    status: 'PROCESSED' | 'EXCEPTION',
    reason?: ProviderEventExceptionReason,
  ): Promise<ProcessVerifiedInboxEventOutcome> {
    await tx.$queryRaw`
      UPDATE "provider_payment_event" SET "status" = ${status} WHERE "id" = ${ctx.inboxId}::uuid`;
    if (status === 'EXCEPTION') {
      // ── owner §G8 — bounded, reason-coded, audit-only (no outbox/
      //    realtime — an internal reconciliation signal, never a raw
      //    provider payload/header/signature). ────────────────────────────
      await this.audit.record(tx, {
        action: 'provider_payment_event.exception',
        resourceType: 'provider_payment_event',
        resourceId: ctx.inboxId,
        tenantId: ctx.tenantId,
        companyId: ctx.companyId,
        branchId: ctx.branchId,
        after: {
          eventType: ctx.eventType,
          reason:
            reason ?? ('UNKNOWN_OR_CROSS_SCOPE_ATTEMPT' satisfies ProviderEventExceptionReason),
          paymentAttemptId: ctx.paymentAttemptId,
        },
      });
    }
    return status;
  }

  /** Finalizes an event before any Invoice/Attempt lock was ever taken
   *  (correlation itself already failed) — still goes through a row lock on
   *  the inbox row alone to stay race-safe against a concurrent duplicate
   *  delivery of the exact same unresolvable event. */
  private async finalizeUnlocked(
    tx: ScopedTx,
    ctx: FinalizeContext,
    reason: ProviderEventExceptionReason,
  ): Promise<ProcessVerifiedInboxEventOutcome> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "provider_payment_event" WHERE "id" = ${ctx.inboxId}::uuid
         AND "tenantId" = ${ctx.tenantId}::uuid
       FOR UPDATE`;
    if (!rows[0] || rows[0].status !== 'RECEIVED') return 'ALREADY_TERMINAL';
    return this.finalize(tx, ctx, 'EXCEPTION', reason);
  }
}
