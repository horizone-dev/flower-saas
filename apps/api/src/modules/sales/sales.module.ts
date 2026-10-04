import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AccountingModule } from '../accounting/accounting.module.js';
import { OrderModule } from '../orders/order.module.js';
import { PaymentModule } from '../payments/payment.module.js';
import { ReceivablesModule } from '../receivables/receivables.module.js';
import { AtomicWalkInSaleService } from './atomic-walk-in-sale.service.js';
import { CompleteSaleAuthorityGuard } from './complete-sale-authority.guard.js';
import { CompleteSaleFingerprintProvider } from './complete-sale-fingerprint.provider.js';
import { OrderTotalsPreviewRepository } from './order-totals-preview.repository.js';
import { OrderTotalsPreviewService } from './order-totals-preview.service.js';
import { SalesApplicationService } from './sales-application.service.js';
import { SalesController } from './sales.controller.js';
import { WalkInSaleJournalRepository } from './walk-in-sale-journal.repository.js';

/**
 * `sales` module (task 3b.9 — the atomic walk-in sale; Checkpoint E wires its public surface).
 *
 * It imports the FIVE modules that own the frozen collaborators and re-declares NONE of them,
 * so Nest never creates a competing instance:
 *
 *   OrderModule         → `TaxFinalizationService`            (additive export)
 *   PaymentModule       → `PaymentCollectionRepository`       (additive export)
 *   ReceivablesModule   → `CustomerInvoiceArRepository`, `CreditOverrideAuthorizationService`
 *                         (already exported) and `CustomerAdvanceApplicationRepository`
 *                         (additive export)
 *   AccountingModule    → `PostingEngineService`, `CompanyFinancialConfigRepository`
 *                         (already exported — for `WalkInSaleJournalRepository`)
 *   AccessModule        → `PolicyEngine` (for `CompleteSaleAuthorityGuard`, the SAME engine the
 *                         global guard pipeline uses)
 *
 * `AuditWriter` / `OutboxWriter` / `DbService` come from the global audit and db modules.
 * No module imports `SalesModule`, so there is no cycle and no `forwardRef`.
 *
 * The financial orchestration stays in the frozen `AtomicWalkInSaleService`;
 * `SalesApplicationService` is only the thin dispatch / event / response facade, and
 * `SalesController` the thin HTTP surface.
 */
@Module({
  imports: [OrderModule, PaymentModule, ReceivablesModule, AccountingModule, AccessModule],
  controllers: [SalesController],
  providers: [
    AtomicWalkInSaleService,
    WalkInSaleJournalRepository,
    SalesApplicationService,
    OrderTotalsPreviewRepository,
    OrderTotalsPreviewService,
    CompleteSaleFingerprintProvider,
    CompleteSaleAuthorityGuard,
  ],
})
export class SalesModule {}
