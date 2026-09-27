import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import {
  SettlementBatchRepository,
  type SettlementBatchRow,
  type SettlementLineRow,
} from './settlement-batch.repository.js';
import { parseAndValidateSettlementCsv } from './settlement-csv.js';

/**
 * Task 3b.7 Checkpoint C — opens the caller transaction (`this.scoped`,
 * mirroring every other Checkpoint C/E/F HTTP repository in this codebase)
 * and delegates to `SettlementBatchRepository`. `companyId`/`branchId` are
 * the trusted, already-`@ScopedParam`-validated route params; `tenantId` and
 * the actor id come exclusively from `RequestContext` — never the request
 * body.
 */
@Injectable()
export class SettlementBatchHttpRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly batches: SettlementBatchRepository,
  ) {
    super(db);
  }

  private actorUserId(): string | null {
    return getContext()?.userId ?? null;
  }

  async createForBranchScoped(input: {
    companyId: string;
    branchId: string;
    providerCredentialId: string;
    externalSettlementId: string;
    providerSettlementDate: string;
    grossSettlementMinor: bigint;
    providerFeeMinor: bigint;
    netBankMinor: bigint;
    currencyCode: string;
  }): Promise<SettlementBatchRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) =>
      this.batches.createInTx(tx, { tenantId, ...input, actorUserId: this.actorUserId() }),
    );
  }

  async editForBranchScoped(input: {
    companyId: string;
    branchId: string;
    id: string;
    expectedVersion: number;
    providerSettlementDate?: string;
    grossSettlementMinor?: bigint;
    providerFeeMinor?: bigint;
    netBankMinor?: bigint;
  }): Promise<SettlementBatchRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) =>
      this.batches.editInTx(tx, { tenantId, ...input, actorUserId: this.actorUserId() }),
    );
  }

  async addLineForBranchScoped(input: {
    companyId: string;
    branchId: string;
    batchId: string;
    expectedVersion: number;
    externalLineId: string | null;
    providerReference: string | null;
    amountMinor: bigint;
  }): Promise<{ batch: SettlementBatchRow; line: SettlementLineRow }> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const result = await this.batches.addLineInTx(tx, {
        tenantId,
        ...input,
        actorUserId: this.actorUserId(),
      });
      const line = await this.batches.tryAutoMatchInTx(tx, result.batch, result.line);
      return { batch: result.batch, line };
    });
  }

  async importCsvForBranchScoped(input: {
    companyId: string;
    branchId: string;
    batchId: string;
    expectedVersion: number;
    csvContent: string;
  }): Promise<{ batch: SettlementBatchRow; insertedLineIds: string[] }> {
    // fail fast on a malformed file before ever opening the transaction —
    // `importCsvInTx` re-validates internally too (never trusts a caller).
    parseAndValidateSettlementCsv(input.csvContent);
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) =>
      this.batches.importCsvInTx(tx, { tenantId, ...input, actorUserId: this.actorUserId() }),
    );
  }

  async matchLineForBranchScoped(input: {
    companyId: string;
    branchId: string;
    batchId: string;
    lineId: string;
    expectedVersion: number;
    proposedPaymentId: string;
  }): Promise<{ batch: SettlementBatchRow; line: SettlementLineRow }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) =>
      this.batches.matchLineInTx(tx, { tenantId, ...input, actorUserId: this.actorUserId() }),
    );
  }

  async unmatchLineForBranchScoped(input: {
    companyId: string;
    branchId: string;
    batchId: string;
    lineId: string;
    expectedVersion: number;
  }): Promise<{ batch: SettlementBatchRow; line: SettlementLineRow }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) =>
      this.batches.unmatchLineInTx(tx, { tenantId, ...input, actorUserId: this.actorUserId() }),
    );
  }

  async listForBranchScoped(input: {
    companyId: string;
    branchId: string;
    cursor: string | null;
    limit: number;
  }): Promise<{ items: SettlementBatchRow[]; nextCursor: string | null; hasMore: boolean }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.batches.listInTx(tx, { tenantId, ...input }));
  }

  async detailForBranchScoped(input: { companyId: string; branchId: string; id: string }): Promise<{
    batch: SettlementBatchRow;
    lines: SettlementLineRow[];
    lineCount: number;
    matchedCount: number;
    unmatchedCount: number;
  }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.batches.detailInTx(tx, { tenantId, ...input }));
  }
}
