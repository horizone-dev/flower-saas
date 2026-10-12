import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermission, RequireAllBranches } from '../../common/auth/index.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { TrialBalanceService } from './trial-balance.service.js';
import { periodQuery } from './reporting-query.js';

/**
 * GET /v1/companies/:companyId/reports/trial-balance
 *
 * Task 3b.10 Checkpoint F — READ-ONLY public wiring of the frozen Trial Balance. The complete sealed ledger of the company
 * (every branch's journals), so the route is company-wide: `accounting:view`, company scope AND unrestricted branch
 * authority, all decided by the guard pipeline before any report query runs. A thin controller; the frozen service validates
 * the civil period and produces the response, returned untouched.
 */
@Controller('companies/:companyId')
export class TrialBalanceController {
  constructor(private readonly service: TrialBalanceService) {}

  @Get('reports/trial-balance')
  @RequirePermission('accounting:view')
  @RequireAllBranches()
  @ScopedParam({ company: 'companyId' })
  get(@Param('companyId') companyId: string, @Query() query: Record<string, unknown>) {
    return this.service.get({ companyId, ...periodQuery(query) });
  }
}
