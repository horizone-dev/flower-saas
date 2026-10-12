import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermission, RequireAllBranches } from '../../common/auth/index.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { ReceivablesReportService } from './receivables-report.service.js';
import { pageQuery } from './reporting-query.js';

/**
 * GET /v1/companies/:companyId/reports/receivables and /v1/companies/:companyId/branches/:branchId/reports/receivables
 *
 * Task 3b.10 Checkpoint F — READ-ONLY public wiring of a frozen report. A thin controller: the guard pipeline decides access
 * BEFORE any report query runs (permission `receivables:view`, company scope, branch scope); the
 * company-wide route additionally requires unrestricted branch authority (`@RequireAllBranches`), so a branch-restricted
 * caller never reads an aggregate spanning branches. No business logic lives here: the frozen service validates the query and
 * produces the response, which is returned untouched.
 */
@Controller('companies/:companyId')
export class ReceivablesReportController {
  constructor(private readonly service: ReceivablesReportService) {}

  @Get('reports/receivables')
  @RequirePermission('receivables:view')
  @RequireAllBranches()
  @ScopedParam({ company: 'companyId' })
  company(@Param('companyId') companyId: string, @Query() query: Record<string, unknown>) {
    return this.service.companyReport({ companyId, ...pageQuery(query) });
  }

  @Get('branches/:branchId/reports/receivables')
  @RequirePermission('receivables:view')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  branch(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.branchReport({ companyId, branchId, ...pageQuery(query) });
  }
}
