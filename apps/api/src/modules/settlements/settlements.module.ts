import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { SettlementBatchRepository } from './settlement-batch.repository.js';
import { SettlementBatchHttpRepository } from './settlement-batch.http.repository.js';
import { SettlementBatchService } from './settlement-batch.service.js';
import { SettlementBatchController } from './settlement-batch.controller.js';

/**
 * `settlements` module (task 3b.7 Checkpoint C). Imports `AccountingModule`
 * for `CompanyFinancialConfigRepository` (the sole authoritative Money/
 * currency basis for a new Batch — mirrors `ReceivablesModule`'s own
 * precedent of reusing it unmodified). NO finalization service, NO
 * PostingEngineService dependency — nothing in this checkpoint posts a
 * journal.
 */
@Module({
  imports: [AccountingModule],
  controllers: [SettlementBatchController],
  providers: [SettlementBatchRepository, SettlementBatchHttpRepository, SettlementBatchService],
})
export class SettlementsModule {}
