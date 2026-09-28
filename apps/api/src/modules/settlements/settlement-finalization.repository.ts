import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { isPgError } from '../../common/errors/pg-error.js';
import {
  assertPaymentEligible,
  type SettlementMatchScope,
} from './settlement-matching.repository.js';
import { InvoiceSettlementProjectionRepository } from './invoice-settlement-projection.repository.js';
import type { SettlementBatchRow } from './settlement-batch.repository.js';
import type { PaymentEventType } from '../payments/payment-events.js';

const PG_RAISE_EXCEPTION = 'P0001';

interface FinalizeInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  id: string;
  expectedVersion: number;
  actorUserId: string | null;
}

interface LineSnapshotRow {
  id: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  matchedPaymentId: string | null;
}

function versionConflictError(expected: number, current: number): DomainError {
  return new DomainError(
    'SETTLEMENT_VERSION_CONFLICT',
    `settlement batch changed elsewhere (expected version ${expected}, now ${current})`,
    409,
  );
}

/**
 * Task 3b.7 Checkpoint D — the settlement finalization command. A SEPARATE
 * repository from the frozen Checkpoint C `SettlementBatchRepository` (never
 * modified) — composed alongside it by `SettlementBatchHttpRepository`.
 *
 * Full transaction order (item 47 of the spec), never reordered:
 *   SettlementBatch FOR UPDATE
 *   -> read + validate frozen Line snapshot
 *   -> revalidate matched-Payment eligibility (read-only)
 *   -> Discovery #1 (read-only)
 *   -> lock affected Invoice rows, sorted ascending
 *   -> lock matched Payment rows, sorted ascending
 *   -> lock Payment-funded CustomerAdvance rows, sorted ascending
 *   -> Discovery #2 (stable-set check)
 *   -> create SettlementApplications (Batch still DRAFT — Checkpoint B's
 *      two-phase Application/Batch gate requires this)
 *   -> post the settlement JournalEntry
 *   -> ONE atomic DRAFT->FINALIZED transition
 *   -> Invoice settlement projection, for every stable affected Invoice
 *   -> audit
 *   -> outbox
 * Never Payment -> Invoice. Never CustomerAdvance -> a newly-discovered
 * Invoice — Discovery #2 growth aborts/retries instead (never "just locks
 * it").
 */
@Injectable()
export class SettlementFinalizationRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly projection: InvoiceSettlementProjectionRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async finalizeInTx(tx: ScopedTx, input: FinalizeInput): Promise<SettlementBatchRow> {
    // ── 1. lock Batch FIRST, verify scope/DRAFT/version — no write before
    //      this point. ────────────────────────────────────────────────────
    const batch = await this.lockDraftBatch(tx, input);

    // ── 2. frozen Line snapshot, deterministic order. ────────────────────
    const lines = await tx.$queryRaw<LineSnapshotRow[]>`
      SELECT "id", "amountMinor", "currencyCode", "currencyExponent", "matchedPaymentId"
        FROM "settlement_line" WHERE "batchId" = ${batch.id}::uuid ORDER BY "id" ASC`;
    if (lines.length === 0 || lines.some((l) => l.matchedPaymentId === null)) {
      throw new DomainError(
        'SETTLEMENT_UNMATCHED_LINES',
        'every settlement line must be matched to a Payment before finalization',
        422,
      );
    }
    const sum = lines.reduce((acc, l) => acc + l.amountMinor, 0n);
    if (sum !== batch.grossSettlementMinor) {
      throw new DomainError(
        'SETTLEMENT_TOTAL_MISMATCH',
        `sum(line.amountMinor) (${sum}) does not equal grossSettlementMinor (${batch.grossSettlementMinor})`,
        422,
      );
    }

    // ── 3. matched-Payment set, distinct + sorted; never trust anything the
    //      caller supplied — this is entirely re-derived from the DB. ─────
    const matchedPaymentIds = [...new Set(lines.map((l) => l.matchedPaymentId as string))].sort();
    const scope: SettlementMatchScope = {
      tenantId: batch.tenantId,
      companyId: batch.companyId,
      branchId: batch.branchId,
      providerCredentialId: batch.providerCredentialId,
      currencyCode: batch.currencyCode,
      currencyExponent: batch.currencyExponent,
    };
    for (const paymentId of matchedPaymentIds) {
      // read-only — a Payment that became ineligible after draft matching
      // (e.g. a race is structurally impossible here since eligibility
      // predicates never change after Payment creation, but this stays the
      // authoritative re-check, never trusting the DRAFT-time match).
      await assertPaymentEligible(tx, scope, paymentId);
    }

    // ── 4. Discovery #1 — read-only, BEFORE any Invoice/Payment/
    //      CustomerAdvance lock. ─────────────────────────────────────────
    const affectedInvoiceIds1 = await this.discoverAffectedInvoiceIds(tx, matchedPaymentIds);

    // ── 5. lock affected Invoices, sorted ascending — BEFORE any Payment
    //      lock (canonical Invoice -> Payment direction, never reversed). ──
    if (affectedInvoiceIds1.length > 0) {
      await tx.$queryRaw`
        SELECT "id" FROM "invoice" WHERE "id" = ANY(${affectedInvoiceIds1}::uuid[])
         ORDER BY "id" ASC FOR UPDATE`;
    }

    // ── 6. lock matched Payments, sorted ascending. ──────────────────────
    await tx.$queryRaw`
      SELECT "id" FROM "payment" WHERE "id" = ANY(${matchedPaymentIds}::uuid[])
       ORDER BY "id" ASC FOR UPDATE`;

    // ── 7. lock Payment-funded CustomerAdvance rows, sorted ascending —
    //      required because CustomerAdvanceApplication capacity
    //      serialization locks CustomerAdvance, not the funding Payment
    //      (the frozen 3b.6 `fn_lock_and_validate_advance_capacity` trigger,
    //      unchanged, unmodified here). ───────────────────────────────────
    await tx.$queryRaw`
      SELECT "id" FROM "customer_advance"
       WHERE "sourceType" = 'PAYMENT' AND "sourcePaymentId" = ANY(${matchedPaymentIds}::uuid[])
       ORDER BY "id" ASC FOR UPDATE`;

    // ── 8. Discovery #2 — stable-set check, now that every write-serializing
    //      lock this Discovery could possibly race against is held. ──────
    const affectedInvoiceIds2 = await this.discoverAffectedInvoiceIds(tx, matchedPaymentIds);
    const stableSet = new Set(affectedInvoiceIds1);
    if (affectedInvoiceIds2.some((id) => !stableSet.has(id))) {
      // never lock the newly-discovered Invoice now — that would invert the
      // canonical Invoice -> Payment order. Abort; the caller retries from a
      // fresh transaction.
      throw new DomainError(
        'SETTLEMENT_CONCURRENT_COVERAGE_CHANGE',
        'affected-Invoice coverage changed concurrently — retry finalization from a fresh transaction',
        409,
      );
    }

    // ── 9. create SettlementApplications — Batch is STILL DRAFT here
    //      (Checkpoint B's two-phase Application/Batch gate requires the
    //      parent to be DRAFT at insert time). One per Line, in Line-id
    //      order. Every field derived from the Line/Batch — nothing accepted
    //      from HTTP. ───────────────────────────────────────────────────
    for (const line of lines) {
      await this.insertApplication(tx, batch, line);
    }

    // ── 10. post the settlement journal — frozen economic shape (item 17),
    //       accountingDate = Batch.providerSettlementDate, branch dimension
    //       = Batch.branchId on every line, no posTerminalId. ────────────
    const providerSettlementDateStr = batch.providerSettlementDate.toISOString().slice(0, 10);
    const journalLines: {
      accountKey: string;
      direction: 'debit' | 'credit';
      amountMinor: bigint;
    }[] = [];
    if (batch.netBankMinor > 0n) {
      journalLines.push({
        accountKey: 'ASSET.BANK',
        direction: 'debit',
        amountMinor: batch.netBankMinor,
      });
    }
    if (batch.providerFeeMinor > 0n) {
      journalLines.push({
        accountKey: 'EXPENSE.PAYMENT_PROCESSING_FEE',
        direction: 'debit',
        amountMinor: batch.providerFeeMinor,
      });
    }
    journalLines.push({
      accountKey: 'ASSET.PAYMENT_CLEARING',
      direction: 'credit',
      amountMinor: batch.grossSettlementMinor,
    });
    const journal = await this.postingEngine.postJournal(tx, {
      tenantId: batch.tenantId,
      companyId: batch.companyId,
      branchId: batch.branchId,
      sourceKind: 'SETTLEMENT_BATCH',
      sourceId: batch.id,
      accountingDate: providerSettlementDateStr,
      lines: journalLines,
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    // ── 11. ONE atomic DRAFT->FINALIZED transition — the last write before
    //       projection/audit/outbox, and the ONLY Batch UPDATE. ─────────
    const finalizeResult = await tx.$executeRaw`
      UPDATE "settlement_batch"
         SET "state" = 'FINALIZED', "journalEntryId" = ${journal.journalEntryId}::uuid,
             "finalizedAt" = now(), "version" = "version" + 1
       WHERE "id" = ${batch.id}::uuid AND "state" = 'DRAFT' AND "version" = ${input.expectedVersion}`;
    if (finalizeResult === 0) {
      const currentRows = await tx.$queryRaw<{ state: string; version: number }[]>`
        SELECT "state", "version" FROM "settlement_batch" WHERE "id" = ${batch.id}::uuid`;
      const current = currentRows[0]!;
      if (current.state === 'FINALIZED') {
        throw new DomainError(
          'SETTLEMENT_ALREADY_FINALIZED',
          'this settlement batch is already FINALIZED',
          409,
        );
      }
      throw versionConflictError(input.expectedVersion, current.version);
    }

    // ── 12. Invoice settlement projection — the stable, confirmed set,
    //       sorted deterministically, in the SAME transaction. ──────────
    for (const invoiceId of affectedInvoiceIds1) {
      await this.projection.recomputeInTx(tx, invoiceId);
    }

    // ── 13. audit — exactly one bounded event. ───────────────────────────
    await this.audit.record(tx, {
      action: 'settlement.finalized',
      resourceType: 'settlement_batch',
      resourceId: batch.id,
      tenantId: batch.tenantId,
      companyId: batch.companyId,
      branchId: batch.branchId,
      after: {
        grossSettlementMinor: batch.grossSettlementMinor.toString(),
        netBankMinor: batch.netBankMinor.toString(),
        providerFeeMinor: batch.providerFeeMinor.toString(),
        currencyCode: batch.currencyCode,
        matchedPaymentCount: matchedPaymentIds.length,
      },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    // ── 14. outbox — exactly one bounded event. ──────────────────────────
    await this.outbox.enqueue(tx, {
      aggregateType: 'settlement_batch',
      aggregateId: batch.id,
      eventType: 'payments.settlement_finalized' satisfies PaymentEventType,
      tenantId: batch.tenantId,
      companyId: batch.companyId,
      branchId: batch.branchId,
      payload: { settlementBatchId: batch.id },
    });

    const finalRows = await tx.$queryRaw<SettlementBatchRow[]>`
      SELECT "id", "tenantId", "companyId", "branchId", "providerCredentialId",
             "externalSettlementId", "providerSettlementDate", "grossSettlementMinor",
             "providerFeeMinor", "netBankMinor", "currencyCode", "currencyExponent",
             "state", "version", "journalEntryId", "createdAt", "finalizedAt"
        FROM "settlement_batch" WHERE "id" = ${batch.id}::uuid`;
    return finalRows[0]!;
  }

  private async lockDraftBatch(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      branchId: string;
      id: string;
      expectedVersion: number;
    },
  ): Promise<SettlementBatchRow> {
    const rows = await tx.$queryRaw<SettlementBatchRow[]>`
      SELECT "id", "tenantId", "companyId", "branchId", "providerCredentialId",
             "externalSettlementId", "providerSettlementDate", "grossSettlementMinor",
             "providerFeeMinor", "netBankMinor", "currencyCode", "currencyExponent",
             "state", "version", "journalEntryId", "createdAt", "finalizedAt"
        FROM "settlement_batch" WHERE "id" = ${input.id}::uuid FOR UPDATE`;
    const row = rows[0];
    if (
      !row ||
      row.tenantId !== input.tenantId ||
      row.companyId !== input.companyId ||
      row.branchId !== input.branchId
    ) {
      throw new NotFoundError('settlement batch', 'SETTLEMENT_NOT_FOUND');
    }
    if (row.state !== 'DRAFT') {
      throw new DomainError(
        'SETTLEMENT_ALREADY_FINALIZED',
        'this settlement batch is already FINALIZED',
        409,
      );
    }
    if (row.version !== input.expectedVersion) {
      throw versionConflictError(input.expectedVersion, row.version);
    }
    return row;
  }

  /** Path A (direct PaymentAllocation) UNION Path B (Payment-funded
   *  CustomerAdvance -> CustomerAdvanceApplication -> INVOICE-sourced
   *  CustomerReceivable), DISTINCT, sorted ascending. The
   *  CustomerReceivablePaymentApplication -> OPENING path is deliberately
   *  excluded — it can never reach an Invoice (frozen DB trigger). */
  private async discoverAffectedInvoiceIds(
    tx: ScopedTx,
    matchedPaymentIds: string[],
  ): Promise<string[]> {
    if (matchedPaymentIds.length === 0) return [];
    const pathA = await tx.$queryRaw<{ invoiceId: string }[]>`
      SELECT DISTINCT "invoiceId" FROM "payment_allocation"
       WHERE "paymentId" = ANY(${matchedPaymentIds}::uuid[])`;
    const pathB = await tx.$queryRaw<{ invoiceId: string }[]>`
      SELECT DISTINCT cr."invoiceId"
        FROM "customer_advance" ca
        JOIN "customer_advance_application" caa ON caa."customerAdvanceId" = ca."id"
        JOIN "customer_receivable" cr ON cr."id" = caa."customerReceivableId"
       WHERE ca."sourceType" = 'PAYMENT'
         AND ca."sourcePaymentId" = ANY(${matchedPaymentIds}::uuid[])
         AND cr."sourceType" = 'INVOICE'
         AND cr."invoiceId" IS NOT NULL`;
    const ids = new Set<string>();
    for (const r of pathA) ids.add(r.invoiceId);
    for (const r of pathB) ids.add(r.invoiceId);
    return [...ids].sort();
  }

  /** Maps the DB's own capacity-backstop rejection to a stable DomainError;
   *  any other unexpected trigger rejection at this point (eligibility was
   *  already re-verified read-only above, so this should be unreachable in
   *  practice) is wrapped, never leaked as raw trigger text. */
  private async insertApplication(
    tx: ScopedTx,
    batch: SettlementBatchRow,
    line: LineSnapshotRow,
  ): Promise<void> {
    try {
      await tx.settlementApplication.create({
        data: {
          tenantId: batch.tenantId,
          companyId: batch.companyId,
          branchId: batch.branchId,
          batchId: batch.id,
          lineId: line.id,
          paymentId: line.matchedPaymentId!,
          amountMinor: line.amountMinor,
          currencyCode: line.currencyCode,
          currencyExponent: line.currencyExponent,
        },
      });
    } catch (err: unknown) {
      if (isPgError(err, PG_RAISE_EXCEPTION)) {
        const message = err instanceof Error ? err.message : String(err);
        if (/would exceed amountMinor/.test(message)) {
          throw new DomainError(
            'SETTLEMENT_PAYMENT_OVER_CAPACITY',
            'this Payment does not have enough remaining settlement capacity',
            409,
          );
        }
      }
      throw err;
    }
  }
}
