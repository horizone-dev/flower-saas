import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { PaymentAttemptService } from './payment-attempt.service.js';
import type { AsyncPaymentAttemptResult } from './payment-attempt.repository.js';
import {
  createPaymentAttemptSchema,
  type CreatePaymentAttemptDto,
} from './dto/create-payment-attempt.dto.js';

/**
 * Bounded, provider-neutral response shape (owner §E19). Deliberately
 * excludes `providerCredentialId`, `providerReference`, `webhookEndpointId`,
 * any secret config, the Order fingerprint/version snapshot, and any raw
 * provider response. No `nextAction` field — no already-accepted
 * architecture defines its shape, so none is invented here.
 */
function serializeAsyncAttempt(result: AsyncPaymentAttemptResult): {
  paymentAttemptId: string;
  invoiceId: string;
  method: string;
  providerKey: string;
  amountMinor: string;
  currencyCode: string;
  currencyExponent: number;
  state: string;
} {
  return {
    paymentAttemptId: result.paymentAttemptId,
    invoiceId: result.invoiceId,
    method: result.method,
    providerKey: result.providerKey,
    amountMinor: result.amountMinor.toString(),
    currencyCode: result.currencyCode,
    currencyExponent: result.currencyExponent,
    state: result.state,
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/invoices/:invoiceId/payment-attempts`
 * — task 3b.5 Checkpoint E, the async provider-initiation route. Entirely
 * separate from `PaymentController`'s synchronous C/D route — this one
 * NEVER creates a `Payment`/`PaymentAllocation` and NEVER produces an
 * authoritative `CAPTURED` result (owned by Checkpoint F's verified webhook
 * path). A single fixed `202 Accepted` for every outcome (resolved or
 * ambiguous) — this endpoint is asynchronous by nature regardless of how
 * quickly a given provider happens to resolve; the response body's `state`
 * field is the actual signal, never the HTTP status code. This uniformity
 * is also what keeps the idempotency-replay contract simple (owner §E17):
 * the SAME status is replayed for the SAME key regardless of which
 * branch produced the original response.
 *
 * NO webhook ingestion route exists here (Checkpoint F). NO GET/summary
 * route exists here (not required in this checkpoint).
 */
@Controller('companies/:companyId/branches/:branchId/invoices/:invoiceId/payment-attempts')
export class PaymentAttemptController {
  constructor(private readonly attempts: PaymentAttemptService) {}

  @Post()
  @HttpCode(202)
  @RequirePermission('payments:collect')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'payment-attempts.create' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createPaymentAttemptSchema)) dto: CreatePaymentAttemptDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(invoiceId, 'invoice');
    // defensive only — the global IdempotencyInterceptor already required
    // this header before this handler ever ran (mirrors
    // `PaymentController.create` exactly).
    if (!idempotencyKeyHeader) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const result = await this.attempts.createAsyncAttempt({
      companyId,
      branchId,
      invoiceId,
      method: dto.method,
      amountMinor: BigInt(dto.amountMinor),
      providerKey: dto.providerKey,
      idempotencyKey: idempotencyKeyHeader,
    });
    return serializeAsyncAttempt(result);
  }
}
