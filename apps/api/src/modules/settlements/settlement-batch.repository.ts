import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { currencyExponent } from '@flower/money';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { isPgError } from '../../common/errors/pg-error.js';
import {
  assertPaymentEligible,
  autoMatchByProviderReference,
  type SettlementMatchScope,
} from './settlement-matching.repository.js';
import { parseAndValidateSettlementCsv, type NormalizedCsvLine } from './settlement-csv.js';

const PG_UNIQUE_VIOLATION = '23505';

export interface SettlementBatchRow {
  id: string;
  tenantId: string;
  companyId: string;
  branchId: string;
  providerCredentialId: string;
  externalSettlementId: string;
  providerSettlementDate: Date;
  grossSettlementMinor: bigint;
  providerFeeMinor: bigint;
  netBankMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  state: string;
  version: number;
  journalEntryId: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

export interface SettlementLineRow {
  id: string;
  batchId: string;
  externalLineId: string | null;
  providerReference: string | null;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  matchedPaymentId: string | null;
  lineKind: string;
  createdAt: Date;
}

function versionConflictError(expected: number, current: number): DomainError {
  return new DomainError(
    'SETTLEMENT_VERSION_CONFLICT',
    `settlement batch changed elsewhere (expected version ${expected}, now ${current})`,
    409,
  );
}

function totalMismatchError(): DomainError {
  return new DomainError(
    'SETTLEMENT_TOTAL_MISMATCH',
    'grossSettlementMinor must equal netBankMinor + providerFeeMinor',
    422,
  );
}

interface ScopeInput {
  tenantId: string;
  companyId: string;
  branchId: string;
}

/**
 * Task 3b.7 Checkpoint C — the DRAFT SettlementBatch/Line application
 * service. Every mutation locks `settlement_batch` FIRST (the serialization
 * root — no Line-first locking, no Payment lock for matching), verifies
 * DRAFT + `expectedVersion`, performs its child mutation, then increments
 * `Batch.version` EXACTLY ONCE. NO SettlementApplication is ever inserted
 * here, NO journal is posted, NO `finalizedAt`/`state` transition is ever
 * performed — the DB triggers frozen in Checkpoint B (`fn_check_settlement_
 * batch_provider_credential_scope`, the FINALIZED-immutability trigger, the
 * two-phase Application/Batch state gate) remain the authoritative backstop
 * underneath every write this repository performs; nothing here weakens or
 * duplicates them.
 */
@Injectable()
export class SettlementBatchRepository {
  constructor(
    private readonly companyFinancialConfig: CompanyFinancialConfigRepository,
    private readonly audit: AuditWriter,
  ) {}

  // ══════════════════════ create ═══════════════════════════════════════════

  async createInTx(
    tx: ScopedTx,
    input: ScopeInput & {
      providerCredentialId: string;
      externalSettlementId: string;
      providerSettlementDate: string;
      grossSettlementMinor: bigint;
      providerFeeMinor: bigint;
      netBankMinor: bigint;
      currencyCode: string;
      actorUserId: string | null;
    },
  ): Promise<SettlementBatchRow> {
    if (input.grossSettlementMinor <= 0n) {
      throw new DomainError('VALIDATION_FAILED', 'grossSettlementMinor must be > 0', 400);
    }
    if (input.providerFeeMinor < 0n || input.netBankMinor < 0n) {
      throw new DomainError('VALIDATION_FAILED', 'providerFeeMinor/netBankMinor must be >= 0', 400);
    }
    if (input.grossSettlementMinor !== input.netBankMinor + input.providerFeeMinor) {
      throw totalMismatchError();
    }

    const branchRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "branch"
       WHERE "id" = ${input.branchId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid`;
    if (!branchRows[0]) {
      throw new NotFoundError('branch', 'SETTLEMENT_NOT_FOUND');
    }

    const credRows = await tx.$queryRaw<
      { id: string; tenantId: string; companyId: string | null; branchId: string | null }[]
    >`
      SELECT "id", "tenantId", "companyId", "branchId" FROM "provider_credential"
       WHERE "id" = ${input.providerCredentialId}::uuid`;
    const cred = credRows[0];
    if (!cred || cred.tenantId !== input.tenantId) {
      throw new NotFoundError('provider credential', 'SETTLEMENT_NOT_FOUND');
    }
    if (cred.companyId !== input.companyId || cred.branchId !== input.branchId) {
      throw new DomainError(
        'SETTLEMENT_BRANCH_MISMATCH',
        'providerCredentialId is not scoped to this exact company/branch',
        422,
      );
    }

    const { defaultCurrency } = await this.companyFinancialConfig.lockCurrencyOnly(
      tx,
      input.companyId,
    );
    if (input.currencyCode !== defaultCurrency) {
      throw new DomainError(
        'SETTLEMENT_CURRENCY_MISMATCH',
        `currencyCode must equal the company's own default currency (${defaultCurrency})`,
        422,
      );
    }
    const exponent = currencyExponent(defaultCurrency);

    const created = await tx.settlementBatch
      .create({
        data: {
          tenantId: input.tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          providerCredentialId: input.providerCredentialId,
          externalSettlementId: input.externalSettlementId,
          providerSettlementDate: new Date(`${input.providerSettlementDate}T00:00:00.000Z`),
          grossSettlementMinor: input.grossSettlementMinor,
          providerFeeMinor: input.providerFeeMinor,
          netBankMinor: input.netBankMinor,
          currencyCode: defaultCurrency,
          currencyExponent: exponent,
          ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
        },
      })
      .catch((err: unknown) => {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw new DomainError(
            'SETTLEMENT_EXTERNAL_ID_CONFLICT',
            'this provider credential has already reported a settlement with this externalSettlementId',
            409,
          );
        }
        throw err;
      });

    await this.audit.record(tx, {
      action: 'settlement.created',
      resourceType: 'settlement_batch',
      resourceId: created.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      after: {
        providerCredentialId: input.providerCredentialId,
        externalSettlementId: input.externalSettlementId,
        grossSettlementMinor: input.grossSettlementMinor.toString(),
        currencyCode: defaultCurrency,
      },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    return created as SettlementBatchRow;
  }

  // ══════════════════════ lock + verify (shared by every mutation) ═════════

  private async lockDraftBatch(
    tx: ScopedTx,
    input: ScopeInput & { id: string; expectedVersion: number },
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

  private matchScopeOf(batch: SettlementBatchRow): SettlementMatchScope {
    return {
      tenantId: batch.tenantId,
      companyId: batch.companyId,
      branchId: batch.branchId,
      providerCredentialId: batch.providerCredentialId,
      currencyCode: batch.currencyCode,
      currencyExponent: batch.currencyExponent,
    };
  }

  private async bumpVersion(tx: ScopedTx, id: string): Promise<void> {
    await tx.$executeRaw`UPDATE "settlement_batch" SET version = version + 1 WHERE "id" = ${id}::uuid`;
  }

  // ══════════════════════ edit ═══════════════════════════════════════════

  async editInTx(
    tx: ScopedTx,
    input: ScopeInput & {
      id: string;
      expectedVersion: number;
      providerSettlementDate?: string;
      grossSettlementMinor?: bigint;
      providerFeeMinor?: bigint;
      netBankMinor?: bigint;
      actorUserId: string | null;
    },
  ): Promise<SettlementBatchRow> {
    const batch = await this.lockDraftBatch(tx, input);

    const gross = input.grossSettlementMinor ?? batch.grossSettlementMinor;
    const fee = input.providerFeeMinor ?? batch.providerFeeMinor;
    const net = input.netBankMinor ?? batch.netBankMinor;
    if (input.grossSettlementMinor !== undefined) {
      if (gross <= 0n)
        throw new DomainError('VALIDATION_FAILED', 'grossSettlementMinor must be > 0', 400);
      if (fee < 0n || net < 0n) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'providerFeeMinor/netBankMinor must be >= 0',
          400,
        );
      }
      if (gross !== net + fee) throw totalMismatchError();
    }
    const providerSettlementDate = input.providerSettlementDate
      ? new Date(`${input.providerSettlementDate}T00:00:00.000Z`)
      : batch.providerSettlementDate;

    await tx.settlementBatch.update({
      where: { id: input.id },
      data: {
        providerSettlementDate,
        grossSettlementMinor: gross,
        providerFeeMinor: fee,
        netBankMinor: net,
        version: { increment: 1 },
      },
    });

    await this.audit.record(tx, {
      action: 'settlement.updated',
      resourceType: 'settlement_batch',
      resourceId: input.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      after: {
        changeKind: 'BATCH_EDITED',
        grossSettlementMinor: gross.toString(),
        currencyCode: batch.currencyCode,
      },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    return this.mustFindById(tx, input.id);
  }

  private async mustFindById(tx: ScopedTx, id: string): Promise<SettlementBatchRow> {
    const rows = await tx.$queryRaw<SettlementBatchRow[]>`
      SELECT "id", "tenantId", "companyId", "branchId", "providerCredentialId",
             "externalSettlementId", "providerSettlementDate", "grossSettlementMinor",
             "providerFeeMinor", "netBankMinor", "currencyCode", "currencyExponent",
             "state", "version", "journalEntryId", "createdAt", "finalizedAt"
        FROM "settlement_batch" WHERE "id" = ${id}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundError('settlement batch', 'SETTLEMENT_NOT_FOUND');
    return row;
  }

  // ══════════════════════ manual line add ═══════════════════════════════

  async addLineInTx(
    tx: ScopedTx,
    input: ScopeInput & {
      batchId: string;
      expectedVersion: number;
      externalLineId: string | null;
      providerReference: string | null;
      amountMinor: bigint;
      actorUserId: string | null;
    },
  ): Promise<{ batch: SettlementBatchRow; line: SettlementLineRow }> {
    const batch = await this.lockDraftBatch(tx, { ...input, id: input.batchId });
    if (input.amountMinor <= 0n) {
      throw new DomainError('VALIDATION_FAILED', 'amountMinor must be > 0', 400);
    }

    const line = await tx.settlementLine
      .create({
        data: {
          tenantId: batch.tenantId,
          companyId: batch.companyId,
          branchId: batch.branchId,
          batchId: batch.id,
          externalLineId: input.externalLineId,
          providerReference: input.providerReference,
          amountMinor: input.amountMinor,
          currencyCode: batch.currencyCode,
          currencyExponent: batch.currencyExponent,
          lineKind: 'SETTLEMENT',
        },
      })
      .catch((err: unknown) => {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw new DomainError(
            'SETTLEMENT_EXTERNAL_LINE_ID_CONFLICT',
            'this externalLineId already exists in this settlement batch',
            409,
          );
        }
        throw err;
      });

    await this.bumpVersion(tx, batch.id);

    await this.audit.record(tx, {
      action: 'settlement.updated',
      resourceType: 'settlement_batch',
      resourceId: batch.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      after: { changeKind: 'LINE_ADDED', lineId: line.id },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    return { batch: await this.mustFindById(tx, batch.id), line: line as SettlementLineRow };
  }

  // ══════════════════════ normalized CSV import (all-or-nothing) ═══════════

  async importCsvInTx(
    tx: ScopedTx,
    input: ScopeInput & {
      batchId: string;
      expectedVersion: number;
      csvContent: string;
      actorUserId: string | null;
    },
  ): Promise<{ batch: SettlementBatchRow; insertedLineIds: string[] }> {
    // Parsed + fully validated BEFORE any lock/write is taken — a malformed
    // file never even reaches the batch lock.
    const parsed: NormalizedCsvLine[] = parseAndValidateSettlementCsv(input.csvContent);

    const batch = await this.lockDraftBatch(tx, { ...input, id: input.batchId });

    const incomingExternalIds = parsed
      .map((l) => l.externalLineId)
      .filter((v): v is string => v !== null);
    if (incomingExternalIds.length > 0) {
      const existing = await tx.$queryRaw<{ externalLineId: string }[]>`
        SELECT "externalLineId" FROM "settlement_line"
         WHERE "batchId" = ${batch.id}::uuid
           AND "externalLineId" = ANY(${incomingExternalIds})`;
      if (existing[0]) {
        throw new DomainError(
          'SETTLEMENT_EXTERNAL_LINE_ID_CONFLICT',
          `externalLineId "${existing[0].externalLineId}" already exists in this settlement batch`,
          409,
        );
      }
    }

    const insertedLineIds: string[] = [];
    for (const row of parsed) {
      const line = await tx.settlementLine
        .create({
          data: {
            tenantId: batch.tenantId,
            companyId: batch.companyId,
            branchId: batch.branchId,
            batchId: batch.id,
            externalLineId: row.externalLineId,
            providerReference: row.providerReference,
            amountMinor: row.amountMinor,
            currencyCode: batch.currencyCode,
            currencyExponent: batch.currencyExponent,
            lineKind: 'SETTLEMENT',
          },
        })
        .catch((err: unknown) => {
          if (isPgError(err, PG_UNIQUE_VIOLATION)) {
            throw new DomainError(
              'SETTLEMENT_EXTERNAL_LINE_ID_CONFLICT',
              'this externalLineId already exists in this settlement batch',
              409,
            );
          }
          throw err;
        });
      insertedLineIds.push(line.id);
    }

    // ONE version bump for the whole command, never once per row.
    await this.bumpVersion(tx, batch.id);

    await this.audit.record(tx, {
      action: 'settlement.updated',
      resourceType: 'settlement_batch',
      resourceId: batch.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      after: { changeKind: 'CSV_IMPORTED', lineCount: insertedLineIds.length },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    return { batch: await this.mustFindById(tx, batch.id), insertedLineIds };
  }

  // ══════════════════════ auto-match (invoked once per newly-added line) ═══

  /** Attempts a providerReference auto-match for a single, already-inserted,
   *  still-unmatched line. Silent no-op if no eligible candidate resolves —
   *  never throws for "no match found" (only for a genuine ambiguity, which
   *  is structurally unreachable given the DB's own unique index). */
  async tryAutoMatchInTx(
    tx: ScopedTx,
    batch: SettlementBatchRow,
    line: SettlementLineRow,
  ): Promise<SettlementLineRow> {
    if (line.matchedPaymentId !== null || line.providerReference === null) return line;
    const candidate = await autoMatchByProviderReference(
      tx,
      this.matchScopeOf(batch),
      line.providerReference,
    );
    if (candidate === null) return line;
    await tx.settlementLine.update({
      where: { id: line.id },
      data: { matchedPaymentId: candidate },
    });
    return { ...line, matchedPaymentId: candidate };
  }

  // ══════════════════════ explicit match / unmatch ═══════════════════════

  private async findLineOrThrow(
    tx: ScopedTx,
    batchId: string,
    lineId: string,
  ): Promise<SettlementLineRow> {
    const rows = await tx.$queryRaw<SettlementLineRow[]>`
      SELECT "id", "batchId", "externalLineId", "providerReference", "amountMinor",
             "currencyCode", "currencyExponent", "matchedPaymentId", "lineKind", "createdAt"
        FROM "settlement_line" WHERE "id" = ${lineId}::uuid AND "batchId" = ${batchId}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundError('settlement line', 'SETTLEMENT_LINE_NOT_FOUND');
    return row;
  }

  async matchLineInTx(
    tx: ScopedTx,
    input: ScopeInput & {
      batchId: string;
      lineId: string;
      expectedVersion: number;
      proposedPaymentId: string;
      actorUserId: string | null;
    },
  ): Promise<{ batch: SettlementBatchRow; line: SettlementLineRow }> {
    const batch = await this.lockDraftBatch(tx, { ...input, id: input.batchId });
    const line = await this.findLineOrThrow(tx, batch.id, input.lineId);

    if (line.matchedPaymentId === input.proposedPaymentId) {
      // idempotent no-op — no version bump, no duplicate audit.
      return { batch, line };
    }
    if (line.matchedPaymentId !== null) {
      throw new DomainError(
        'SETTLEMENT_LINE_ALREADY_MATCHED',
        'this line is already matched to a different Payment — unmatch it first',
        409,
      );
    }

    await assertPaymentEligible(tx, this.matchScopeOf(batch), input.proposedPaymentId);

    await tx.settlementLine.update({
      where: { id: line.id },
      data: { matchedPaymentId: input.proposedPaymentId },
    });
    await this.bumpVersion(tx, batch.id);

    await this.audit.record(tx, {
      action: 'settlement.match_changed',
      resourceType: 'settlement_line',
      resourceId: line.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      before: { matchedPaymentId: line.matchedPaymentId },
      after: { matchedPaymentId: input.proposedPaymentId },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    return {
      batch: await this.mustFindById(tx, batch.id),
      line: { ...line, matchedPaymentId: input.proposedPaymentId },
    };
  }

  async unmatchLineInTx(
    tx: ScopedTx,
    input: ScopeInput & {
      batchId: string;
      lineId: string;
      expectedVersion: number;
      actorUserId: string | null;
    },
  ): Promise<{ batch: SettlementBatchRow; line: SettlementLineRow }> {
    const batch = await this.lockDraftBatch(tx, { ...input, id: input.batchId });
    const line = await this.findLineOrThrow(tx, batch.id, input.lineId);

    if (line.matchedPaymentId === null) {
      // idempotent no-op — no version bump, no duplicate audit.
      return { batch, line };
    }

    const previousPaymentId = line.matchedPaymentId;
    await tx.settlementLine.update({
      where: { id: line.id },
      data: { matchedPaymentId: null },
    });
    await this.bumpVersion(tx, batch.id);

    await this.audit.record(tx, {
      action: 'settlement.match_changed',
      resourceType: 'settlement_line',
      resourceId: line.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      before: { matchedPaymentId: previousPaymentId },
      after: { matchedPaymentId: null },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    return {
      batch: await this.mustFindById(tx, batch.id),
      line: { ...line, matchedPaymentId: null },
    };
  }

  // ══════════════════════ operational reads (no lock, no audit) ═══════════

  async listInTx(
    tx: ScopedTx,
    input: ScopeInput & { cursor: string | null; limit: number },
  ): Promise<{ items: SettlementBatchRow[]; nextCursor: string | null; hasMore: boolean }> {
    const rows = await tx.$queryRaw<SettlementBatchRow[]>`
      SELECT "id", "tenantId", "companyId", "branchId", "providerCredentialId",
             "externalSettlementId", "providerSettlementDate", "grossSettlementMinor",
             "providerFeeMinor", "netBankMinor", "currencyCode", "currencyExponent",
             "state", "version", "journalEntryId", "createdAt", "finalizedAt"
        FROM "settlement_batch"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid
         AND "id" > ${input.cursor ?? '00000000-0000-0000-0000-000000000000'}::uuid
       ORDER BY "id" ASC
       LIMIT ${input.limit + 1}`;
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async detailInTx(
    tx: ScopedTx,
    input: ScopeInput & { id: string },
  ): Promise<{
    batch: SettlementBatchRow;
    lines: SettlementLineRow[];
    lineCount: number;
    matchedCount: number;
    unmatchedCount: number;
  }> {
    const batchRows = await tx.$queryRaw<SettlementBatchRow[]>`
      SELECT "id", "tenantId", "companyId", "branchId", "providerCredentialId",
             "externalSettlementId", "providerSettlementDate", "grossSettlementMinor",
             "providerFeeMinor", "netBankMinor", "currencyCode", "currencyExponent",
             "state", "version", "journalEntryId", "createdAt", "finalizedAt"
        FROM "settlement_batch"
       WHERE "id" = ${input.id}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "branchId" = ${input.branchId}::uuid`;
    const batch = batchRows[0];
    if (!batch) throw new NotFoundError('settlement batch', 'SETTLEMENT_NOT_FOUND');

    const lines = await tx.$queryRaw<SettlementLineRow[]>`
      SELECT "id", "batchId", "externalLineId", "providerReference", "amountMinor",
             "currencyCode", "currencyExponent", "matchedPaymentId", "lineKind", "createdAt"
        FROM "settlement_line" WHERE "batchId" = ${input.id}::uuid ORDER BY "createdAt" ASC`;
    const matchedCount = lines.filter((l) => l.matchedPaymentId !== null).length;

    return {
      batch,
      lines,
      lineCount: lines.length,
      matchedCount,
      unmatchedCount: lines.length - matchedCount,
    };
  }
}
