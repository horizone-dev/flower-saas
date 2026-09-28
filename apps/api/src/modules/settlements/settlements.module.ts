import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { SettlementBatchRepository } from './settlement-batch.repository.js';
import { SettlementBatchHttpRepository } from './settlement-batch.http.repository.js';
import { SettlementBatchService } from './settlement-batch.service.js';
import { SettlementBatchController } from './settlement-batch.controller.js';
import { SettlementFinalizationRepository } from './settlement-finalization.repository.js';
import { InvoiceSettlementProjectionRepository } from './invoice-settlement-projection.repository.js';
import { HistoricalSettlementReconciliationRepository } from './historical-settlement-reconciliation.repository.js';

/**
 * `settlements` module (task 3b.7 Checkpoints C + D + E). Imports
 * `AccountingModule` for `CompanyFinancialConfigRepository` (Checkpoint C's
 * currency basis) and `PostingEngineService` (Checkpoint D's settlement
 * journal). `InvoiceSettlementProjectionRepository` is exported additively
 * (Checkpoint D) so `ReceivablesModule` can inject it into
 * `CustomerReceiptEffectsRepository`'s own tail hook — the SAME reusable
 * projection Checkpoint D's own finalization path also calls, never
 * duplicated.
 *
 * Checkpoint E additive provider: `HistoricalSettlementReconciliationRepository`
 * — registered here for DI-based testability ONLY. Deliberately NOT
 * exported, NOT wired to any controller, and never instantiated by
 * `AppModule` bootstrap on its own — the one sanctioned on-demand
 * invocation path is `apps/api/src/scripts/reconcile-historical-settlements.ts`
 * (built into `dist/scripts/…js` by the normal production build, run via
 * plain `node` — no `tsx`/devDependency at runtime), a standalone script
 * that constructs it directly (see that file's own doc comment for why it
 * does not boot the full Nest HTTP application).
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
    HistoricalSettlementReconciliationRepository,
  ],
  exports: [InvoiceSettlementProjectionRepository],
})
export class SettlementsModule {}
