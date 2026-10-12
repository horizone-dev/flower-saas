import { Injectable } from '@nestjs/common';
import { parseSalesReportRange } from './sales-report-range.js';
import {
  SalesFinancialReportRepository,
  type SalesFinancialBranchReport,
  type SalesFinancialCompanyReport,
} from './sales-financial-report.repository.js';

/**
 * Task 3b.10 Checkpoint B — thin pass-through over {@link SalesFinancialReportRepository}, exactly like
 * the Trial Balance service, except that it applies the Sales 90-day period cap FIRST (the same pure helper the
 * repository applies again — the repository is the only door to the database, so no caller can bypass the rule).
 * NOT registered in any Nest module and NOT
 * reachable over HTTP — a controller and its permission matrix (`orders:view` + `credit_notes:view` +
 * `receivables:view`, ALL of) are a later, separately approved checkpoint.
 */
@Injectable()
export class SalesFinancialReportService {
  constructor(private readonly repo: SalesFinancialReportRepository) {}

  async branchReport(input: {
    companyId: string;
    branchId: string;
    from: unknown;
    to: unknown;
  }): Promise<SalesFinancialBranchReport> {
    const { from, to } = parseSalesReportRange(input);
    return this.repo.getBranchReportScoped({ ...input, from, to });
  }

  async companyReport(input: {
    companyId: string;
    from: unknown;
    to: unknown;
  }): Promise<SalesFinancialCompanyReport> {
    const { from, to } = parseSalesReportRange(input);
    return this.repo.getCompanyReportScoped({ ...input, from, to });
  }
}
