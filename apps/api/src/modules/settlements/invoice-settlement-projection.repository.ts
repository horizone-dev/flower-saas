import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import {
  assertInvoiceSettlementStatusTransition,
  type InvoiceSettlementStatus3b7,
} from '../receivables/invoice-payment-status.js';

/**
 * Task 3b.7 Checkpoint D — the ONE reusable live Invoice PAID->SETTLED
 * projection. Called from THREE places, never duplicated:
 *   - Settlement finalization (Call Site A — `settlement-finalization.
 *     repository.ts`), for every stable affected Invoice, in the SAME
 *     transaction as the atomic Batch FINALIZED transition.
 *   - `CustomerReceiptEffectsRepository.recomputeInvoicePaymentStatusInTx`'s
 *     own tail (Call Sites B/C combined — see that file's doc comment for
 *     why hooking there covers every PaymentAllocation AND
 *     CustomerAdvanceApplication producer with a single additive call).
 *
 * A projection ONLY — never creates a Payment/Allocation/Application, never
 * changes a receivable/advance/customer-account amount, never posts GL,
 * never mutates a `SettlementBatch`/`SettlementApplication`. Read-only
 * queries (no `FOR UPDATE`) — the caller's own transaction already holds
 * whatever lock this call's context requires (the Invoice row itself, for
 * Call Site A; nothing new for Call Sites B/C, which only ever read further
 * financial facts, never lock anything this function's SELECTs would
 * conflict with).
 *
 * Forward-only (3b.7 scope): PAID -> SETTLED only. UNPAID/PARTIAL are left
 * untouched; an already-SETTLED invoice is an idempotent no-op. Never
 * SETTLED -> PAID (reversal/refund is a future 3b.8+ concept).
 */
@Injectable()
export class InvoiceSettlementProjectionRepository {
  async recomputeInTx(tx: ScopedTx, invoiceId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ invoicePaymentStatus: string }[]>`
      SELECT "invoicePaymentStatus" FROM "invoice" WHERE "id" = ${invoiceId}::uuid`;
    const invoice = rows[0];
    if (!invoice) return; // defensive — caller context always guarantees existence
    const current = invoice.invoicePaymentStatus as InvoiceSettlementStatus3b7;
    // forward-only: only a financially-PAID invoice can ever become SETTLED;
    // UNPAID/PARTIAL are left untouched, an already-SETTLED invoice is a
    // harmless no-op (never re-derives, never regresses).
    if (current !== 'PAID') return;

    // ── direct PaymentAllocation coverage ──────────────────────────────────
    const allocations = await tx.$queryRaw<{ paymentId: string }[]>`
      SELECT DISTINCT "paymentId" FROM "payment_allocation" WHERE "invoiceId" = ${invoiceId}::uuid`;
    for (const a of allocations) {
      if (!(await this.isPaymentSettlementFinal(tx, a.paymentId))) return; // leave PAID
    }

    // ── CustomerAdvanceApplication coverage, via this Invoice's OWN
    //    INVOICE-sourced CustomerReceivable (never the OPENING-only
    //    CustomerReceivablePaymentApplication path — that table structurally
    //    can never reach an Invoice, per its own DB trigger). Each covering
    //    advance's finality follows its FUNDING source: PAYMENT / OPENING, or —
    //    task 3b.8 Integration Closure F2 — CREDIT_NOTE, traced through its
    //    CreditNoteCoverageRelease provenance (`isAdvanceSettlementFinal`). ─────
    const receivableRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_receivable"
       WHERE "invoiceId" = ${invoiceId}::uuid AND "sourceType" = 'INVOICE'`;
    const receivable = receivableRows[0];
    if (receivable) {
      const advanceApplications = await tx.$queryRaw<{ customerAdvanceId: string }[]>`
        SELECT DISTINCT "customerAdvanceId" FROM "customer_advance_application"
         WHERE "customerReceivableId" = ${receivable.id}::uuid`;
      for (const app of advanceApplications) {
        if (!(await this.isAdvanceSettlementFinal(tx, app.customerAdvanceId))) return; // leave PAID
      }
    }

    // every coverage component (vacuously true if there are none) is
    // settlement-final — promote PAID -> SETTLED, exactly once.
    assertInvoiceSettlementStatusTransition(current, 'SETTLED');
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { invoicePaymentStatus: 'SETTLED' },
    });
  }

  /**
   * Task 3b.8 Integration Closure (F2) — the settlement-finality of ONE
   * CustomerAdvance that covers an Invoice, dispatched by what FUNDED it. A pure
   * dispatch over the frozen per-Payment predicate below — it introduces no new
   * finality rule:
   *   PAYMENT      -> the funding Payment's own finality (3b.7, unchanged).
   *   OPENING      -> immediately final: an opening balance has no Payment to
   *                   settle (3b.7, unchanged).
   *   CREDIT_NOTE  -> traced through its single CreditNoteCoverageRelease (see
   *                   {@link isCreditNoteAdvanceSettlementFinal}).
   *   anything else -> NOT final: fail closed, the Invoice stays PAID.
   */
  private async isAdvanceSettlementFinal(
    tx: ScopedTx,
    customerAdvanceId: string,
  ): Promise<boolean> {
    const advanceRows = await tx.$queryRaw<
      { sourceType: string; sourcePaymentId: string | null }[]
    >`SELECT "sourceType", "sourcePaymentId" FROM "customer_advance" WHERE "id" = ${customerAdvanceId}::uuid`;
    const advance = advanceRows[0];
    if (!advance) return true; // defensive — the application's FK guarantees the advance exists
    switch (advance.sourceType) {
      case 'OPENING':
        return true; // immediately settlement-final
      case 'PAYMENT':
        return (
          advance.sourcePaymentId !== null &&
          (await this.isPaymentSettlementFinal(tx, advance.sourcePaymentId))
        );
      case 'CREDIT_NOTE':
        return this.isCreditNoteAdvanceSettlementFinal(tx, customerAdvanceId);
      default:
        return false;
    }
  }

  /**
   * A CREDIT_NOTE-sourced advance has NO funding Payment of its own
   * (`sourcePaymentId` is NULL) — it is funded by exactly ONE
   * `CreditNoteCoverageRelease` (the 1:1 `customerAdvanceId` link), the append-only
   * provenance of which prior coverage the CreditNote converted into it. Its
   * finality IS the finality of that source, by the release's own kind:
   *   PAYMENT_ALLOCATION  -> `sourcePaymentId` = the released allocation's Payment.
   *   ADVANCE_APPLICATION -> `sourcePaymentId` = the underlying PAYMENT-sourced
   *                          advance's own Payment (the application's source is
   *                          inherited, never re-derived).
   *   OPENING_ADVANCE     -> the underlying advance was an OPENING advance —
   *                          immediately final (`sourcePaymentId` is NULL).
   * Both Payment-traced kinds then use the SAME `isPaymentSettlementFinal`
   * (CASH / BANK_TRANSFER final; OTHER_MANUAL never; a provider Payment only once
   * the WHOLE Payment is covered by FINALIZED settlements). A missing release or
   * an unrecognized kind fails closed (not final).
   */
  private async isCreditNoteAdvanceSettlementFinal(
    tx: ScopedTx,
    customerAdvanceId: string,
  ): Promise<boolean> {
    const releaseRows = await tx.$queryRaw<
      { sourceKind: string; sourcePaymentId: string | null }[]
    >`SELECT "sourceKind", "sourcePaymentId" FROM "credit_note_coverage_release"
       WHERE "customerAdvanceId" = ${customerAdvanceId}::uuid`;
    const release = releaseRows[0];
    if (!release) return false;
    switch (release.sourceKind) {
      case 'OPENING_ADVANCE':
        return true;
      case 'PAYMENT_ALLOCATION':
      case 'ADVANCE_APPLICATION':
        return (
          release.sourcePaymentId !== null &&
          (await this.isPaymentSettlementFinal(tx, release.sourcePaymentId))
        );
      default:
        return false;
    }
  }

  /**
   * The frozen per-Payment settlement-finality predicate (item 23 of the
   * Checkpoint D spec), reused identically for BOTH direct PaymentAllocation
   * coverage and Payment-funded CustomerAdvance coverage:
   *   CASH / BANK_TRANSFER          -> final immediately.
   *   OTHER_MANUAL                  -> never final in 3b.7.
   *   ONLINE_GATEWAY / CARD_TERMINAL -> final only when the ENTIRE source
   *     Payment is fully settlement-final:
   *       SUM(SettlementApplication.amountMinor for that Payment WHERE
   *           parent SettlementBatch.state = 'FINALIZED') = Payment.amountMinor
   *     — never a per-Invoice numeric shortcut (a partially-settled Payment
   *     never makes ANY of its covered Invoices settlement-final, even if
   *     the settled portion alone would exceed that one Invoice's own
   *     allocation).
   */
  /**
   * Task 3b.8 Checkpoint D (provider-stub reconciliation) — promoted from
   * `private` to `public` so `RefundAttemptReservationRepository` can reuse
   * this EXACT frozen predicate for the schema's own
   * `PROVIDER_REFUND_REQUIRES_FULL_SETTLEMENT` gate (`RefundAttempt`'s own
   * doc comment) — never a duplicate arithmetic implementation. No behavior
   * change to either of this method's existing 3b.7 callers.
   */
  async isPaymentSettlementFinal(tx: ScopedTx, paymentId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ method: string; amountMinor: bigint }[]>`
      SELECT "method", "amountMinor" FROM "payment" WHERE "id" = ${paymentId}::uuid`;
    const payment = rows[0];
    if (!payment) return false; // defensive
    if (payment.method === 'CASH' || payment.method === 'BANK_TRANSFER') return true;
    if (payment.method === 'OTHER_MANUAL') return false;
    // ONLINE_GATEWAY / CARD_TERMINAL — provider-backed.
    const sumRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(sa."amountMinor"), 0)::bigint AS total
        FROM "settlement_application" sa
        JOIN "settlement_batch" sb ON sb."id" = sa."batchId"
       WHERE sa."paymentId" = ${paymentId}::uuid AND sb."state" = 'FINALIZED'`;
    return sumRows[0]!.total === payment.amountMinor;
  }
}
