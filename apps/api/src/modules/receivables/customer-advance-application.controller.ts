import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { CustomerAdvanceApplicationService } from './customer-advance-application.service.js';
import type { ApplyCustomerAdvanceResult } from './customer-advance-application.repository.js';
import {
  createCustomerAdvanceApplicationSchema,
  type CreateCustomerAdvanceApplicationDto,
} from './dto/create-customer-advance-application.dto.js';

/** BigInt -> decimal-digit string. Never exposes an internal account key or
 *  journal id (E36). */
function serializeApplicationResult(result: ApplyCustomerAdvanceResult): {
  applicationId: string;
  advanceId: string;
  customerReceivableId: string;
  amountMinor: string;
  remainingAdvanceMinor: string;
  receivableOutstandingMinor: string;
  invoicePaymentStatus: string | null;
} {
  return {
    applicationId: result.applicationId,
    advanceId: result.advanceId,
    customerReceivableId: result.customerReceivableId,
    amountMinor: result.amountMinor.toString(),
    remainingAdvanceMinor: result.remainingAdvanceMinor.toString(),
    receivableOutstandingMinor: result.receivableOutstandingMinor.toString(),
    invoicePaymentStatus: result.invoicePaymentStatus,
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/customers/:customerId/advances/:advanceId/applications`
 * — task 3b.6 Checkpoint E (E11-E13). Explicit, user-directed only — no
 * auto-FIFO. Supports BOTH an Invoice-origin and an Opening-origin target
 * receivable generically. Reuses `receivables:advance:apply` (E6).
 */
@Controller(
  'companies/:companyId/branches/:branchId/customers/:customerId/advances/:advanceId/applications',
)
export class CustomerAdvanceApplicationController {
  constructor(private readonly applications: CustomerAdvanceApplicationService) {}

  @Post()
  @RequirePermission('receivables:advance:apply')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'receivables.advance_application' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Param('advanceId') advanceId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createCustomerAdvanceApplicationSchema))
    dto: CreateCustomerAdvanceApplicationDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    assertUuid(advanceId, 'advance');
    if (!idempotencyKeyHeader) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const result = await this.applications.apply({
      companyId,
      branchId,
      customerId,
      advanceId,
      customerReceivableId: dto.customerReceivableId,
      amountMinor: BigInt(dto.amountMinor),
    });
    return serializeApplicationResult(result);
  }
}
