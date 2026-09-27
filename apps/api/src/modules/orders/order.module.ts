import { Module } from '@nestjs/common';
import { SystemClock } from '../../common/clock/clock.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CustomerModule } from '../customers/customer.module.js';
import { LocalizationModule } from '../localization/localization.module.js';
import { ReceivablesModule } from '../receivables/receivables.module.js';
import { OrderRepository } from './order.repository.js';
import { OrderService } from './order.service.js';
import { OrderCreateFingerprintProvider } from './order-create-fingerprint.provider.js';
import { OrderController } from './order.controller.js';
import { InvoiceIssuanceRepository } from './invoice-issuance.repository.js';
import { InvoiceRepository } from './invoice.repository.js';
import { InvoiceService } from './invoice.service.js';
import { InvoiceController } from './invoice.controller.js';
import { TaxFinalizationService } from './tax-finalization.service.js';

/**
 * `orders` module (task 3b.3 — Orders + Invoice + Numbering). Imports
 * `CatalogModule` for `BranchPricingService.resolvePrice` /
 * `TaxResolutionService.resolve` (the frozen Phase 3a authoritative
 * resolution services — this module NEVER reimplements pricing/tax logic)
 * and `CustomerModule` for `CustomerRepository.getForCompany` (the exact
 * Task 3b.2 company-gated association check, reused unmodified — §6).
 * `SystemClock` is declared locally (mirrors `AccountingModule`'s own local
 * declaration — no shared `ClockModule` exists).
 *
 * NO `AccountingModule` import — this module never calls `PostingEngineService`,
 * never writes a journal, never touches `CompanyFinancialConfigRepository`.
 *
 * Checkpoint C (task 3b.3) adds `InvoiceIssuanceRepository` (the internal-only
 * `issueFinalInvoice` primitive — deliberately NOT wired to any controller,
 * exactly like `AccountingModule`'s `PostingEngineService`) and
 * `InvoiceController` (READ ONLY — no write route exists anywhere in this
 * module).
 *
 * Checkpoint C (task 3b.4) additionally imports `LocalizationModule` for
 * `LocalizationService.resolveFiscalPolicyOn` — `OrderRepository` resolves an
 * Order's document-wide fiscal policy ONCE at creation, reusing the SAME
 * civil date already derived for line tax-reference resolution (§C5).
 *
 * Checkpoint D (task 3b.4) adds `TaxFinalizationService` — the internal-only
 * tax-finalization primitive that computes the finalized per-line tax
 * snapshot + document totals from LOCKED persisted state and delegates to
 * `InvoiceIssuanceRepository.issueFinalInvoice` in the SAME transaction.
 * Deliberately NOT wired to any controller — no public confirm/finalize
 * route exists anywhere in this module.
 *
 * Task 3b.6 Checkpoint C adds `ReceivablesModule` — `InvoiceIssuanceRepository`
 * now calls `CustomerInvoiceArRepository` (customer-linked Invoice AR +
 * credit-limit hard gate + `invoice_ar` journal) for every customer-linked
 * issuance. `ReceivablesModule` itself imports `AccountingModule`
 * (`PostingEngineService`), so this module still never imports it directly —
 * the prior "NO `AccountingModule` import" note above now describes a
 * TRANSITIVE dependency's own scope, not this module's.
 */
@Module({
  imports: [CatalogModule, CustomerModule, LocalizationModule, ReceivablesModule],
  controllers: [OrderController, InvoiceController],
  providers: [
    OrderRepository,
    OrderService,
    OrderCreateFingerprintProvider,
    SystemClock,
    InvoiceIssuanceRepository,
    InvoiceRepository,
    InvoiceService,
    TaxFinalizationService,
  ],
})
export class OrderModule {}
