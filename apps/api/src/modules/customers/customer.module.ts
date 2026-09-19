import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CustomerRepository } from './customer.repository.js';
import { CustomerService } from './customer.service.js';
import { CustomerCreateFingerprintProvider } from './customer-create-fingerprint.provider.js';
import { CustomerController, CustomerTenantController } from './customer.controller.js';

/**
 * `customers` module (task 3b.2 — CRM/Customer Core). Imports `AccountingModule`
 * only for `CompanyFinancialConfigRepository.lockCurrencyOnly` (task 3b.1's
 * currency-lock primitive, reused unmodified in behaviour — task 3b.2 §11) —
 * never `PostingEngineService`, never any journal/GL call anywhere in this
 * module (task 3b.2 §26/§28). `AuditWriter`/`DbService` are `@Global()`
 * (already imported at the app root) — not re-declared here.
 */
@Module({
  imports: [AccountingModule],
  controllers: [CustomerController, CustomerTenantController],
  providers: [CustomerRepository, CustomerService, CustomerCreateFingerprintProvider],
  // `CustomerRepository` is exported additively for task 3b.3's `OrderModule`
  // to reuse `getForCompany` (the exact Task 3b.2 join-gated company-
  // association check, called INSIDE the Order module's own transaction) —
  // no behavior change to any existing consumer.
  exports: [CustomerRepository],
})
export class CustomerModule {}
