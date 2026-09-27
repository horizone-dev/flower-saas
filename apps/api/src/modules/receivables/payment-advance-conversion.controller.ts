import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { PaymentAdvanceConversionService } from './payment-advance-conversion.service.js';
import type { ConvertPaymentToAdvanceResult } from './payment-advance-conversion.repository.js';
import {
  createPaymentAdvanceConversionSchema,
  type CreatePaymentAdvanceConversionDto,
} from './dto/create-payment-advance-conversion.dto.js';

/** BigInt -> decimal-digit string, mirroring every other Money-response
 *  serializer in this repository exactly. Never exposes an internal
 *  account key or journal id. */
function serializeConversionResult(result: ConvertPaymentToAdvanceResult): {
  advanceId: string;
  sourcePaymentId: string;
  amountMinor: string;
  remainingPaymentUnallocatedMinor: string;
  advanceBalanceMinor: string;
} {
  return {
    advanceId: result.advanceId,
    sourcePaymentId: result.sourcePaymentId,
    amountMinor: result.amountMinor.toString(),
    remainingPaymentUnallocatedMinor: result.remainingPaymentUnallocatedMinor.toString(),
    advanceBalanceMinor: result.advanceBalanceMinor.toString(),
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/customers/:customerId/advances/from-payment`
 * — task 3b.6 Checkpoint E (E3/E4/E7). Explicit-only: a confirmed Payment
 * never becomes an Advance automatically (E2) — this is the ONLY path.
 * Reuses the frozen `receivables:advance:apply` permission for this
 * operation too (E6 — the frozen contract names no separate "conversion"
 * key, and this operation is the same owner/admin/manager risk tier as
 * applying an Advance, never a routine Cashier/Sales action).
 */
@Controller('companies/:companyId/branches/:branchId/customers/:customerId/advances/from-payment')
export class PaymentAdvanceConversionController {
  constructor(private readonly conversions: PaymentAdvanceConversionService) {}

  @Post()
  @RequirePermission('receivables:advance:apply')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'receivables.advance_conversion' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createPaymentAdvanceConversionSchema)) dto: CreatePaymentAdvanceConversionDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    if (!idempotencyKeyHeader) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const result = await this.conversions.convert({
      companyId,
      branchId,
      customerId,
      paymentId: dto.paymentId,
      amountMinor: BigInt(dto.amountMinor),
    });
    return serializeConversionResult(result);
  }
}
