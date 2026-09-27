import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { CustomerReceiptService } from './customer-receipt.service.js';
import type { CollectCustomerReceiptResult } from './customer-receipt-collection.repository.js';
import {
  createCustomerReceiptSchema,
  type CreateCustomerReceiptDto,
} from './dto/create-customer-receipt.dto.js';

/**
 * Fastify's JSON serializer cannot encode a native `BigInt` — every
 * BigInt-typed Money field is converted to a decimal-digit STRING here,
 * mirroring `payment.controller.ts`'s `serializePaymentResult` convention
 * exactly. Never exposes an internal PaymentAttempt fingerprint or actor
 * internal — only the bounded receipt fields the frozen contract names
 * (owner Checkpoint D contract §D16).
 */
function serializeReceiptResult(result: CollectCustomerReceiptResult): {
  paymentId: string;
  paymentAttemptId: string;
  amountMinor: string;
  allocatedAmountMinor: string;
  unallocatedAmountMinor: string;
  currencyCode: string;
  currencyExponent: number;
  allocations: { receivableId: string; sourceType: string; amountMinor: string }[];
} {
  return {
    paymentId: result.paymentId,
    paymentAttemptId: result.paymentAttemptId,
    amountMinor: result.amountMinor.toString(),
    allocatedAmountMinor: result.allocatedAmountMinor.toString(),
    unallocatedAmountMinor: result.unallocatedAmountMinor.toString(),
    currencyCode: result.currencyCode,
    currencyExponent: result.currencyExponent,
    allocations: result.allocations.map((a) => ({
      receivableId: a.receivableId,
      sourceType: a.sourceType,
      amountMinor: a.amountMinor.toString(),
    })),
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/customers/:customerId/receipts`
 * — task 3b.6 Checkpoint D (D10-D12). Synchronous/local only (D11) — no
 * provider/ONLINE_GATEWAY route exists here (Checkpoint E). Branch-nested
 * throughout (Branch is THE operational scope, CLAUDE.md rule 8) —
 * `@ScopedParam({ company, branch })` means a wrong-company/wrong-branch
 * caller can never reach this route at all; `customerId` is resolved
 * server-side via the SAME join-gated pattern `CustomerInvoiceArRepository`
 * uses (fails closed 404 on any mismatch — never a caller-supplied account
 * substitution).
 */
@Controller('companies/:companyId/branches/:branchId/customers/:customerId/receipts')
export class CustomerReceiptController {
  constructor(private readonly receipts: CustomerReceiptService) {}

  @Post()
  @RequirePermission('receivables:collect')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'receivables.collect' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('customerId') customerId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createCustomerReceiptSchema)) dto: CreateCustomerReceiptDto,
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
    const result = await this.receipts.createReceipt({
      companyId,
      branchId,
      customerId,
      amountMinor: BigInt(dto.amountMinor),
      method: dto.method,
      idempotencyKey: idempotencyKeyHeader,
    });
    return serializeReceiptResult(result);
  }
}
