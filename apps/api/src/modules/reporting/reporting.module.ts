import { Module } from '@nestjs/common';
import { TrialBalanceRepository } from './trial-balance.repository.js';
import { TrialBalanceService } from './trial-balance.service.js';
import { TrialBalanceController } from './trial-balance.controller.js';
import { SalesFinancialReportRepository } from './sales-financial-report.repository.js';
import { SalesFinancialReportService } from './sales-financial-report.service.js';
import { SalesFinancialReportController } from './sales-financial-report.controller.js';
import { TenderTotalsReportRepository } from './tender-totals-report.repository.js';
import { TenderTotalsReportService } from './tender-totals-report.service.js';
import { TenderTotalsReportController } from './tender-totals-report.controller.js';
import { ReceivablesReportRepository } from './receivables-report.repository.js';
import { ReceivablesReportService } from './receivables-report.service.js';
import { ReceivablesReportController } from './receivables-report.controller.js';
import { CustomerLiabilitiesReportRepository } from './customer-liabilities-report.repository.js';
import { CustomerLiabilitiesReportService } from './customer-liabilities-report.service.js';
import { CustomerLiabilitiesReportController } from './customer-liabilities-report.controller.js';

/**
 * `reporting` module (task 3b.10 Checkpoint F — public HTTP wiring of the five frozen financial reports). READ-ONLY: no
 * audit, no outbox, no idempotency, no write of any kind. `DbService` is `@Global()` (`DbModule`, imported at the app root).
 */
@Module({
  controllers: [
    TrialBalanceController,
    SalesFinancialReportController,
    TenderTotalsReportController,
    ReceivablesReportController,
    CustomerLiabilitiesReportController,
  ],
  providers: [
    TrialBalanceRepository,
    TrialBalanceService,
    SalesFinancialReportRepository,
    SalesFinancialReportService,
    TenderTotalsReportRepository,
    TenderTotalsReportService,
    ReceivablesReportRepository,
    ReceivablesReportService,
    CustomerLiabilitiesReportRepository,
    CustomerLiabilitiesReportService,
  ],
})
export class ReportingModule {}
