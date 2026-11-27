import { Controller, Get, Param } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { NoStepUp, ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { ReceiptIdentityRepository } from './receipt-identity.repository.js';

/**
 * `GET /v1/companies/:companyId/branches/:branchId/receipt-identity` — F-3. The seller identity a cashier prints on a receipt (legal name,
 * TRN, registered address, branch name). Uses the EXISTING `orders:view` authority (no new permission, no migration) and the caller's own
 * company + branch scope, exactly like the order reads the cashier already uses. Read-only; no audit (a non-secret document header).
 */
@Controller('companies/:companyId/branches/:branchId/receipt-identity')
export class ReceiptIdentityController {
  constructor(private readonly identity: ReceiptIdentityRepository) {}

  @Get()
  @RequirePermission('orders:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async get(@Param('companyId') companyId: string, @Param('branchId') branchId: string) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    return this.identity.getForBranchScoped({ companyId, branchId });
  }
}
