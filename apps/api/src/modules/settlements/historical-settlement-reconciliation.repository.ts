import { Injectable } from '@nestjs/common';
import { runScoped, type ScopedTx } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { InvoiceSettlementProjectionRepository } from './invoice-settlement-projection.repository.js';

const SENTINEL_CURSOR = '00000000-0000-0000-0000-000000000000';

/** No repo-wide constant for this exists yet (Checkpoint E) — chosen
 *  conservatively, matching `SettlementBatchRepository.listInTx`'s own
 *  default page size (50) rounded up to a still-small, explicit value. A
 *  caller may request a smaller `limit`; this is the hard ceiling. */
export const HISTORICAL_RECONCILIATION_MAX_BATCH_SIZE = 100;

export interface ReconcileHistoricalSettlementsInput {
  tenantId: string;
  companyId: string;
  /** omit for a company-wide run; the existing maintenance architecture has
   *  no branch-bounded job precedent, so this is accepted only as an
   *  additional filter on the same company-scoped run, never a
   *  substitute for `companyId`. */
  branchId?: string | null;
  /** opaque row cursor — `null` starts from the beginning. */
  cursor: string | null;
  limit: number;
}

export interface ReconcileHistoricalSettlementsResult {
  processedCount: number;
  settledCount: number;
  unchangedCount: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Task 3b.7 Checkpoint E — explicit, on-demand, resumable historical
 * PAID->SETTLED Invoice reconciliation. NEVER wired into `AppModule`
 * bootstrap or any HTTP route (see `src/scripts/reconcile-historical-settlements.ts`
 * for the one sanctioned on-demand invocation path) — this class is a plain
 * `.repository.ts` (ESLint's `no-raw-prisma-in-scoped-modules` already
 * allow-lists that suffix) that opens its OWN `runScoped` transaction per
 * batch, because there is no HTTP `RequestContext` to inherit scope from;
 * this mirrors `ScopedRepository.scoped()`'s own internals (`runScoped(this.
 * db.appClient(), { tenantId, branchId }, fn)`) with explicit, caller-supplied
 * scope instead of a context lookup — the same primitive, not a new one.
 *
 * Reuses `InvoiceSettlementProjectionRepository.recomputeInTx` verbatim —
 * the SAME authority Settlement finalization itself calls (Checkpoint D) —
 * never a second implementation of the PAID->SETTLED predicate, the CASH/
 * BANK_TRANSFER/OPENING-immediate rule, the OTHER_MANUAL exclusion, or the
 * provider-Payment-full-settlement rule.
 *
 * Candidates are `invoice.invoicePaymentStatus = 'PAID'` ONLY, scoped by
 * tenant + company (+ optional branch), cursor-paginated by `id` ascending
 * (keyset pagination — the exact `listInTx` idiom from Checkpoint C's
 * `SettlementBatchRepository`, never OFFSET). A batch that finds the
 * Invoice no longer `PAID` when re-read (a concurrent live write already
 * moved it) is safely skipped, never downgraded, never re-projected twice.
 *
 * Creates NO SettlementBatch/Line/Application, NO Payment/PaymentAttempt/
 * PaymentAllocation, NO CustomerAdvance/CustomerAdvanceApplication, NO
 * JournalEntry — projection reads existing evidence only. Writes exactly
 * ONE bounded `settlement.reconciliation_run` audit row per batch (never a
 * per-Invoice audit row, never `settlement.finalized`). Emits NO outbox
 * event — a historical projection is not a new provider settlement, and
 * there is no existing "maintenance-completed" outbox precedent anywhere
 * in this repo to justify inventing one (see the Checkpoint E report).
 *
 * One batch = one transaction: any unexpected error rolls back everything
 * in that batch, including the summary audit row; the caller retries the
 * exact same `cursor`.
 */
@Injectable()
export class HistoricalSettlementReconciliationRepository {
  constructor(
    private readonly db: DbService,
    private readonly projection: InvoiceSettlementProjectionRepository,
    private readonly audit: AuditWriter,
  ) {}

  async runBatch(
    input: ReconcileHistoricalSettlementsInput,
  ): Promise<ReconcileHistoricalSettlementsResult> {
    const limit = Math.max(1, Math.min(input.limit, HISTORICAL_RECONCILIATION_MAX_BATCH_SIZE));
    return runScoped(
      this.db.appClient(),
      { tenantId: input.tenantId, branchId: input.branchId ?? null },
      (tx) => this.runBatchInTx(tx, { ...input, limit }),
    );
  }

  private async runBatchInTx(
    tx: ScopedTx,
    input: ReconcileHistoricalSettlementsInput & { limit: number },
  ): Promise<ReconcileHistoricalSettlementsResult> {
    const cursor = input.cursor ?? SENTINEL_CURSOR;
    const candidateRows = input.branchId
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "invoice"
           WHERE "tenantId" = ${input.tenantId}::uuid
             AND "companyId" = ${input.companyId}::uuid
             AND "branchId" = ${input.branchId}::uuid
             AND "invoicePaymentStatus" = 'PAID'
             AND "id" > ${cursor}::uuid
           ORDER BY "id" ASC
           LIMIT ${input.limit + 1}`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "invoice"
           WHERE "tenantId" = ${input.tenantId}::uuid
             AND "companyId" = ${input.companyId}::uuid
             AND "invoicePaymentStatus" = 'PAID'
             AND "id" > ${cursor}::uuid
           ORDER BY "id" ASC
           LIMIT ${input.limit + 1}`;

    const hasMore = candidateRows.length > input.limit;
    const pageRows = hasMore ? candidateRows.slice(0, input.limit) : candidateRows;

    let settledCount = 0;
    let unchangedCount = 0;
    for (const row of pageRows) {
      // re-read immediately before projecting — a concurrent live write
      // (a new PaymentAllocation/CustomerAdvanceApplication, or a settlement
      // finalization) may have already moved this Invoice off PAID between
      // the candidate scan and now. Never downgrade, never re-project a
      // non-PAID Invoice; safely skip instead.
      const currentRows = await tx.$queryRaw<{ invoicePaymentStatus: string }[]>`
        SELECT "invoicePaymentStatus" FROM "invoice" WHERE "id" = ${row.id}::uuid`;
      if (currentRows[0]?.invoicePaymentStatus !== 'PAID') {
        unchangedCount += 1;
        continue;
      }

      await this.projection.recomputeInTx(tx, row.id);

      const afterRows = await tx.$queryRaw<{ invoicePaymentStatus: string }[]>`
        SELECT "invoicePaymentStatus" FROM "invoice" WHERE "id" = ${row.id}::uuid`;
      if (afterRows[0]?.invoicePaymentStatus === 'SETTLED') {
        settledCount += 1;
      } else {
        unchangedCount += 1;
      }
    }

    const processedCount = pageRows.length;
    const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

    // exactly one bounded summary row per batch — never per-Invoice, never
    // an Invoice/Payment id array, never PII/provider payload.
    await this.audit.record(tx, {
      action: 'settlement.reconciliation_run',
      resourceType: 'company',
      resourceId: input.companyId,
      tenantId: input.tenantId,
      companyId: input.companyId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      after: {
        processedCount,
        settledCount,
        unchangedCount,
        hasMore,
      },
    });

    return { processedCount, settledCount, unchangedCount, nextCursor, hasMore };
  }
}
