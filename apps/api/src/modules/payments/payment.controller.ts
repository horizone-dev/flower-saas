import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { PaymentService } from './payment.service.js';
import type { CaptureSynchronousTendersResult } from './payment-collection.repository.js';
import { createPaymentSchema, type CreatePaymentDto } from './dto/create-payment.dto.js';

/**
 * Fastify's JSON serializer cannot encode a native `BigInt` — every
 * BigInt-typed Money field is converted to a decimal-digit STRING here,
 * mirroring `order.controller.ts`'s `serializeOrder` convention exactly.
 * ONE stable shape for both a single-tender and a Multi Payment request
 * (owner Checkpoint D contract §D3) — `paymentGroupId` is simply `null` in
 * the single-tender case, `payments` always has one entry per tender, in
 * request order. Never exposes a provider credential, internal fingerprint,
 * raw actor internal, or secret — only the bounded receipt fields the
 * frozen contract names.
 */
function serializePaymentResult(result: CaptureSynchronousTendersResult): {
  paymentGroupId: string | null;
  invoiceId: string;
  amountMinor: string;
  currencyCode: string;
  currencyExponent: number;
  payments: {
    paymentId: string;
    paymentAttemptId: string;
    paymentAllocationId: string;
    method: string;
    amountMinor: string;
  }[];
  remainingAvailableToCollectMinor: string;
} {
  return {
    paymentGroupId: result.paymentGroupId,
    invoiceId: result.invoiceId,
    amountMinor: result.amountMinor.toString(),
    currencyCode: result.currencyCode,
    currencyExponent: result.currencyExponent,
    payments: result.payments.map((p) => ({
      paymentId: p.paymentId,
      paymentAttemptId: p.paymentAttemptId,
      paymentAllocationId: p.paymentAllocationId,
      method: p.method,
      amountMinor: p.amountMinor.toString(),
    })),
    remainingAvailableToCollectMinor: result.remainingAvailableToCollectMinor.toString(),
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/invoices/:invoiceId/payments`
 * — task 3b.5 Checkpoint D, synchronous capture for N>=1 locally-confirmable
 * tenders in ONE atomic transaction (Checkpoint C completed to its
 * future-proof shape, never redesigned — a single-tender request is exactly
 * Checkpoint C's own behavior). Branch-nested throughout (Branch is THE
 * operational scope, CLAUDE.md rule 8) — `@ScopedParam({ company:
 * 'companyId', branch: 'branchId' })` means a wrong-company/wrong-branch
 * caller can never reach this route at all, before the controller ever
 * runs; the repository layer additionally includes `companyId`/`branchId`
 * in its own WHERE clause as the actual Invoice-access boundary (Checkpoint
 * B §1 / Checkpoint C §C4 — DB RLS here is tenant-only, never a substitute
 * for this).
 *
 * NO provider/webhook/ONLINE_GATEWAY route exists here (Checkpoint E/F). NO
 * GET/summary route exists here (not required in C/D).
 */
@Controller('companies/:companyId/branches/:branchId/invoices/:invoiceId/payments')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post()
  @RequirePermission('payments:collect')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'payments.create' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createPaymentSchema)) dto: CreatePaymentDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(invoiceId, 'invoice');
    // the global IdempotencyInterceptor already required + shape-validated
    // this header before this handler ever ran (see
    // `IdempotencyInterceptor.intercept`) — this is defensive, not a second
    // validation layer.
    if (!idempotencyKeyHeader) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const result = await this.payments.createPayment({
      companyId,
      branchId,
      invoiceId,
      amountMinor: BigInt(dto.amountMinor),
      tenders: dto.tenders.map((t) => ({ method: t.method, amountMinor: BigInt(t.amountMinor) })),
      idempotencyKey: idempotencyKeyHeader,
    });
    return serializePaymentResult(result);
  }
}
