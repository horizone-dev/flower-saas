import { Injectable } from '@nestjs/common';
import { SettlementBatchHttpRepository } from './settlement-batch.http.repository.js';
import type { SettlementBatchRow, SettlementLineRow } from './settlement-batch.repository.js';

/** Thin pass-through, mirroring `OpeningBalanceService`/`PaymentAdvanceConversionService`. */
@Injectable()
export class SettlementBatchService {
  constructor(private readonly repo: SettlementBatchHttpRepository) {}

  create(input: Parameters<SettlementBatchHttpRepository['createForBranchScoped']>[0]) {
    return this.repo.createForBranchScoped(input);
  }

  edit(input: Parameters<SettlementBatchHttpRepository['editForBranchScoped']>[0]) {
    return this.repo.editForBranchScoped(input);
  }

  addLine(input: Parameters<SettlementBatchHttpRepository['addLineForBranchScoped']>[0]) {
    return this.repo.addLineForBranchScoped(input);
  }

  importCsv(input: Parameters<SettlementBatchHttpRepository['importCsvForBranchScoped']>[0]) {
    return this.repo.importCsvForBranchScoped(input);
  }

  matchLine(input: Parameters<SettlementBatchHttpRepository['matchLineForBranchScoped']>[0]) {
    return this.repo.matchLineForBranchScoped(input);
  }

  unmatchLine(input: Parameters<SettlementBatchHttpRepository['unmatchLineForBranchScoped']>[0]) {
    return this.repo.unmatchLineForBranchScoped(input);
  }

  list(input: Parameters<SettlementBatchHttpRepository['listForBranchScoped']>[0]) {
    return this.repo.listForBranchScoped(input);
  }

  detail(input: Parameters<SettlementBatchHttpRepository['detailForBranchScoped']>[0]): Promise<{
    batch: SettlementBatchRow;
    lines: SettlementLineRow[];
    lineCount: number;
    matchedCount: number;
    unmatchedCount: number;
  }> {
    return this.repo.detailForBranchScoped(input);
  }

  finalize(input: Parameters<SettlementBatchHttpRepository['finalizeForBranchScoped']>[0]) {
    return this.repo.finalizeForBranchScoped(input);
  }
}
