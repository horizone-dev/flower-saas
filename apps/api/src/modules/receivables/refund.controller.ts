import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { RefundService } from './refund.service.js';
import type { ExecuteLocalRefundResult } from './refund-execution.repository.js';
import { createRefundSchema, type CreateRefundDto } from './dto/create-refund.dto.js';

/** Fastify's JSON serializer cannot encode a native `BigInt` — mirrors
 *  `serializeReceiptResult`'s own convention exactly. */
function serializeRefundResult(result: ExecuteLocalRefundResult): {
  refundId: string;
  amountMinor: string;
  currencyCode: string;
} {
  return {
    refundId: result.refundId,
    amountMinor: result.amountMinor.toString(),
    currencyCode: result.currencyCode,
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/customers/:customerId/advances/:advanceId/refunds`
 * — task 3b.8 Checkpoint D. The separate, later, explicit money-out action
 * (ADR-0019 §19/§27) — a CreditNote-funded `CustomerAdvance` is drained here,
 * never automatically by the cancellation that created it. Step-up gated
 * (`refunds:execute` is in `STEP_UP_PERMISSIONS`) since this moves real cash/
 * bank value out of the business. Branch-nested (Branch is THE operational
 * scope, CLAUDE.md rule 8); `customerId` is resolved server-side via the SAME
 * join-gated pattern every other receivables route uses.
 */
@Controller(
  'companies/:companyId/branches/:branchId/customers/:customerId/advances/:advanceId/refunds',
)
export class RefundController {
  constructor(private readonly refunds: RefundService) {}

  @Post()
  @RequirePermission('refunds:execute')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'receivables.refund' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Param('advanceId') advanceId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createRefundSchema)) dto: CreateRefundDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(customerId, 'customer');
    assertUuid(advanceId, 'customer_advance');
    if (!idempotencyKeyHeader) {
      // `@Idempotent()` already rejects a missing header before this handler
      // ever runs (mirrors `CustomerReceiptController`'s own defensive-only
      // check exactly) — this should be unreachable in practice.
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const result = await this.refunds.createRefund({
      companyId,
      branchId,
      customerId,
      customerAdvanceId: advanceId,
      requestedAmountMinor: BigInt(dto.requestedAmountMinor),
      method: dto.method,
      reasonCode: dto.reasonCode,
    });
    return serializeRefundResult(result);
  }
}
