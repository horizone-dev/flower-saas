import { Injectable } from '@nestjs/common';
import {
  ReceivablesReportRepository,
  type ReceivablesBranchReport,
  type ReceivablesCompanyReport,
} from './receivables-report.repository.js';

/**
 * Task 3b.10 Checkpoint D — thin pass-through over {@link ReceivablesReportRepository}, exactly like the Trial Balance and
 * Tender Totals services. The report has NO period and NO historical `asOf` input, so there is nothing to validate here:
 * the repository owns the identifier, cursor and limit rules (the customer-account read model's convention). NOT
 * registered in any Nest module and NOT reachable over HTTP — a controller and its permission matrix are a later,
 * separately approved checkpoint.
 */
@Injectable()
export class ReceivablesReportService {
  constructor(private readonly repo: ReceivablesReportRepository) {}

  branchReport(input: {
    companyId: string;
    branchId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<ReceivablesBranchReport> {
    return this.repo.getBranchReportScoped(input);
  }

  companyReport(input: {
    companyId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<ReceivablesCompanyReport> {
    return this.repo.getCompanyReportScoped(input);
  }
}
