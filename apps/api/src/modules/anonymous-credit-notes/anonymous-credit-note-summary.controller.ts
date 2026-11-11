import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequireAllBranches, RequirePermission } from '../../common/auth/index.js';
import { NoStepUp, ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { AnonymousCreditNoteSummaryRepository } from './anonymous-credit-note-summary.repository.js';
import { summaryQuery } from './anonymous-credit-note-summary.js';

/**
 * GET /v1/companies/:companyId/anonymous-credit-note-summary and /v1/companies/:companyId/branches/:branchId/anonymous-credit-note-summary
 *
 * Phase 3B closure — F-1 / F-2. READ-ONLY. The guard pipeline decides access BEFORE any query runs (`credit_notes:view`, company scope,
 * branch scope); the company-wide route additionally needs unrestricted branch authority (`@RequireAllBranches`), so a branch-restricted
 * caller never reads an aggregate spanning branches. No new permission key. The query accepts exactly `from` and `to`.
 */
@Controller('companies/:companyId')
export class AnonymousCreditNoteSummaryController {
  constructor(private readonly repo: AnonymousCreditNoteSummaryRepository) {}

  @Get('anonymous-credit-note-summary')
  @RequirePermission('credit_notes:view')
  @RequireAllBranches()
  @NoStepUp()
  @ScopedParam({ company: 'companyId' })
  company(@Param('companyId') companyId: string, @Query() query: Record<string, unknown>) {
    return this.repo.getCompany({ companyId, ...summaryQuery(query) });
  }

  @Get('branches/:branchId/anonymous-credit-note-summary')
  @RequirePermission('credit_notes:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  branch(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.repo.getBranch({ companyId, branchId, ...summaryQuery(query) });
  }
}
