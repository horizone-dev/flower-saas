import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { SettlementBatchRepository } from './settlement-batch.repository.js';
import { SettlementBatchHttpRepository } from './settlement-batch.http.repository.js';
import { SettlementBatchService } from './settlement-batch.service.js';
import { SettlementBatchController } from './settlement-batch.controller.js';
import { SettlementFinalizationRepository } from './settlement-finalization.repository.js';
import { InvoiceSettlementProjectionRepository } from './invoice-settlement-projection.repository.js';

/**
 * `settlements` module (task 3b.7 Checkpoints C + D). Imports
 * `AccountingModule` for `CompanyFinancialConfigRepository` (Checkpoint C's
 * currency basis) and `PostingEngineService` (Checkpoint D's settlement
 * journal). `InvoiceSettlementProjectionRepository` is exported additively
 * (Checkpoint D) so `ReceivablesModule` can inject it into
 * `CustomerReceiptEffectsRepository`'s own tail hook — the SAME reusable
 * projection Checkpoint D's own finalization path also calls, never
 * duplicated.
 */
@Module({
  imports: [AccountingModule],
  controllers: [SettlementBatchController],
  providers: [
    SettlementBatchRepository,
    SettlementBatchHttpRepository,
    SettlementBatchService,
    SettlementFinalizationRepository,
    InvoiceSettlementProjectionRepository,
  ],
  exports: [InvoiceSettlementProjectionRepository],
})
export class SettlementsModule {}
