import { Injectable } from '@nestjs/common';
import { parseReportDateRange } from './report-date-range.js';
import {
  TenderTotalsReportRepository,
  type TenderTotalsBranchReport,
  type TenderTotalsCompanyReport,
} from './tender-totals-report.repository.js';

/**
 * Task 3b.10 Checkpoint C — thin pass-through over {@link TenderTotalsReportRepository}, exactly like the Trial Balance
 * service: it validates the civil period with the shared Checkpoint A contract and applies NO cap of its own (no 90-day
 * rule, no document limit — those are the Sales report's). NOT registered in any Nest module and NOT reachable over
 * HTTP — a controller and its permission matrix are a later, separately approved checkpoint.
 */
@Injectable()
export class TenderTotalsReportService {
  constructor(private readonly repo: TenderTotalsReportRepository) {}

  async branchReport(input: {
    companyId: string;
    branchId: string;
    from: unknown;
    to: unknown;
  }): Promise<TenderTotalsBranchReport> {
    const { from, to } = parseReportDateRange(input);
    return this.repo.getBranchReportScoped({ ...input, from, to });
  }

  async companyReport(input: {
    companyId: string;
    from: unknown;
    to: unknown;
  }): Promise<TenderTotalsCompanyReport> {
    const { from, to } = parseReportDateRange(input);
    return this.repo.getCompanyReportScoped({ ...input, from, to });
  }
}
