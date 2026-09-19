import { Module } from '@nestjs/common';
import { SystemClock } from '../../common/clock/clock.js';
import { AccountRepository } from './account.repository.js';
import { AccountService } from './account.service.js';
import { AccountingPeriodRepository } from './accounting-period.repository.js';
import { AccountingPeriodService } from './accounting-period.service.js';
import { CompanyFinancialConfigRepository } from './company-financial-config.repository.js';
import { PostingEngineService } from './posting-engine.service.js';
import { AccountingController } from './accounting.controller.js';

/**
 * `accounting` module (task 3b.1 — CoA + Posting Engine + Accounting Periods).
 * `PostingEngineService` is provided here (for future domains — orders/
 * payments, tasks 3b.2+ — to inject) but has NO controller: it is an internal
 * primitive only, never HTTP-exposed (docs/phase-3/PHASE-3B-PLAN.md §J/§N).
 * `AuditWriter` / `DbService` are `@Global()` (`AuditModule` / `DbModule`,
 * already imported at the app root) — not re-declared here.
 */
@Module({
  controllers: [AccountingController],
  providers: [
    AccountRepository,
    AccountService,
    AccountingPeriodRepository,
    AccountingPeriodService,
    CompanyFinancialConfigRepository,
    PostingEngineService,
    SystemClock,
  ],
  // `CompanyFinancialConfigRepository` is exported additively for task 3b.2's
  // `CustomerModule` to reuse `lockCurrencyOnly` — no behavior change to any
  // task 3b.1 consumer (still resolved from this same provider instance).
  exports: [PostingEngineService, CompanyFinancialConfigRepository],
})
export class AccountingModule {}
