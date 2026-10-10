import { Injectable } from '@nestjs/common';
import {
  CustomerLiabilitiesReportRepository,
  type LiabilitiesBranchReport,
  type LiabilitiesCompanyReport,
} from './customer-liabilities-report.repository.js';

/**
 * Task 3b.10 Checkpoint E — thin pass-through over {@link CustomerLiabilitiesReportRepository}, exactly like the Receivables
 * and Tender Totals services. The report has NO period and NO historical `asOf` input, so there is nothing to validate here:
 * the repository owns the identifier, cursor and limit rules (the customer-account read model's convention). NOT
 * registered in any Nest module and NOT reachable over HTTP — a controller and its permission matrix are a later,
 * separately approved checkpoint.
 */
@Injectable()
export class CustomerLiabilitiesReportService {
  constructor(private readonly repo: CustomerLiabilitiesReportRepository) {}

  branchReport(input: {
    companyId: string;
    branchId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<LiabilitiesBranchReport> {
    return this.repo.getBranchReportScoped(input);
  }

  companyReport(input: {
    companyId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<LiabilitiesCompanyReport> {
    return this.repo.getCompanyReportScoped(input);
  }
}
