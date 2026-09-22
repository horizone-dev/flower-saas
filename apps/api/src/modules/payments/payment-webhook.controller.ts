import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/index.js';
import { getRawBody } from '../../common/http/raw-body.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { PaymentWebhookService } from './payment-webhook.service.js';

function normalizedHeaders(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && value.length > 0) out[key] = value[0]!;
  }
  return out;
}

/**
 * `POST /v1/webhooks/payments/:endpointId` — task 3b.5 Checkpoint F, the
 * generic provider webhook route (owner §F2). `endpointId` is
 * `PaymentWebhookEndpoint.id` — an opaque routing token, never trusted
 * business input. `@Public()` (no `payments:collect`/`payments:view`/any
 * new permission, owner §F31) — the security gate is cryptographic
 * provider-signature verification inside `PaymentWebhookService`, not
 * human authorization. The body is NEVER trusted for
 * tenantId/companyId/branchId/providerCredentialId/providerKey/
 * paymentAttemptId/amount/currency until the adapter has authenticated and
 * normalized it (owner §F2) — this controller never reads `request.body`
 * at all, only the raw bytes.
 *
 * A single fixed `202` on success (owner §F12) — the provider-facing
 * response never includes a Payment id, Invoice balance, internal user
 * data, credential detail, or exception internal. An authentication
 * failure (unknown endpoint OR invalid signature — indistinguishable,
 * owner §F3/§F8) surfaces as `PaymentWebhookService`'s own
 * `ForbiddenError`, handled by the existing global exception filter.
 */
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly service: PaymentWebhookService) {}

  @Post(':endpointId')
  @HttpCode(202)
  @Public()
  async receive(
    @Param('endpointId') endpointId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ received: true }> {
    assertUuid(endpointId, 'endpoint');
    await this.service.handle({
      endpointId,
      rawBody: getRawBody(request) ?? Buffer.alloc(0),
      headers: normalizedHeaders(request),
    });
    return { received: true };
  }
}
