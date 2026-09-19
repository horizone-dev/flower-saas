import { Module } from '@nestjs/common';
import { SystemClock } from '../../common/clock/clock.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CustomerModule } from '../customers/customer.module.js';
import { OrderRepository } from './order.repository.js';
import { OrderService } from './order.service.js';
import { OrderCreateFingerprintProvider } from './order-create-fingerprint.provider.js';
import { OrderController } from './order.controller.js';
import { InvoiceIssuanceRepository } from './invoice-issuance.repository.js';
import { InvoiceRepository } from './invoice.repository.js';
import { InvoiceService } from './invoice.service.js';
import { InvoiceController } from './invoice.controller.js';

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
 * Checkpoint C adds `InvoiceIssuanceRepository` (the internal-only
 * `issueFinalInvoice` primitive — deliberately NOT wired to any controller,
 * exactly like `AccountingModule`'s `PostingEngineService`) and
 * `InvoiceController` (READ ONLY — no write route exists anywhere in this
 * module).
 */
@Module({
  imports: [CatalogModule, CustomerModule],
  controllers: [OrderController, InvoiceController],
  providers: [
    OrderRepository,
    OrderService,
    OrderCreateFingerprintProvider,
    SystemClock,
    InvoiceIssuanceRepository,
    InvoiceRepository,
    InvoiceService,
  ],
})
export class OrderModule {}
