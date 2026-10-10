import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  RequirePermission,
  RequireAllPermissions,
  RequireAllBranches,
} from '../../common/auth/index.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { SalesFinancialReportService } from './sales-financial-report.service.js';
import { periodQuery } from './reporting-query.js';

/**
 * GET /v1/companies/:companyId/reports/sales and /v1/companies/:companyId/branches/:branchId/reports/sales
 *
 * Task 3b.10 Checkpoint F — READ-ONLY public wiring of a frozen report. A thin controller: the guard pipeline decides access
 * BEFORE any report query runs (permission — all of orders:view + credit_notes:view + receivables:view, company scope, branch scope); the
 * company-wide route additionally requires unrestricted branch authority (`@RequireAllBranches`), so a branch-restricted
 * caller never reads an aggregate spanning branches. No business logic lives here: the frozen service validates the query and
 * produces the response, which is returned untouched.
 */
@Controller('companies/:companyId')
export class SalesFinancialReportController {
  constructor(private readonly service: SalesFinancialReportService) {}

  @Get('reports/sales')
  @RequirePermission('orders:view')
  @RequireAllPermissions('credit_notes:view', 'receivables:view')
  @RequireAllBranches()
  @ScopedParam({ company: 'companyId' })
  company(@Param('companyId') companyId: string, @Query() query: Record<string, unknown>) {
    return this.service.companyReport({ companyId, ...periodQuery(query) });
  }

  @Get('branches/:branchId/reports/sales')
  @RequirePermission('orders:view')
  @RequireAllPermissions('credit_notes:view', 'receivables:view')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  branch(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.branchReport({ companyId, branchId, ...periodQuery(query) });
  }
}
