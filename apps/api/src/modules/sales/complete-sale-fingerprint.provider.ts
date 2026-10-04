import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SemanticFingerprintProvider } from '../../common/idempotency/index.js';
import { getContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { parseIfMatch, requireIfMatch } from '../catalog/catalog-write.helpers.js';
import { completeSaleSchema } from './dto/complete-sale.dto.js';

/**
 * Task 3b.9 Checkpoint E — the `orders.complete_sale` idempotency fingerprint.
 *
 * The shared interceptor's DEFAULT fingerprint is `(method, route, path params, query,
 * scope, tenant, principal, body)` — it does NOT include request HEADERS, so an
 * `If-Match` (the expected order version) would silently NOT be part of the request's
 * identity: the same key with a changed `If-Match` would replay the original response.
 * That is wrong for a command whose precondition is the `If-Match`. This provider is
 * the repository's established, opt-in, route-specific extension
 * (`@Idempotent({ semanticFingerprintProvider })`, precedent `OrderCreateFingerprintProvider`)
 * — the generic idempotency module is not touched.
 *
 * The fingerprint is the NORMALIZED semantic request, not the raw bytes:
 *
 *   - the expected order version, parsed by the SAME helper the handler uses
 *     (`If-Match: 3`, `"3"` and `W/"3"` are one precondition);
 *   - tenders in REQUEST order (the order the Payments are created in);
 *   - advance applications sorted by advance id (the frozen plan spends them in
 *     ascending id order, so their request order carries no meaning);
 *   - the credit reason, trimmed, `null` when absent (a reason is semantic input even
 *     though it grants nothing);
 *   - the route's company / branch / order and the tenant.
 *
 * It runs BEFORE any idempotency claim is taken, so a missing / malformed `If-Match`
 * (428) or an invalid body (400) surfaces as an ordinary request failure and never
 * creates or poisons an idempotency-store row.
 *
 * SECURITY: `tenantId` comes only from `getContext()`; `companyId` / `branchId` are route
 * params already authorised by `PermissionGuard` (`@ScopedParam`) before any interceptor
 * runs. Nothing here is ever read from the body.
 */
@Injectable()
export class CompleteSaleFingerprintProvider implements SemanticFingerprintProvider {
  async computeSemanticBody(req: FastifyRequest): Promise<unknown> {
    const { tenantId } = getContext() ?? {};
    if (!tenantId) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const params = req.params as Record<string, string> | undefined;
    const companyId = params?.['companyId'];
    const branchId = params?.['branchId'];
    const orderId = params?.['orderId'];
    if (!companyId || !branchId || !orderId) {
      throw new DomainError(
        'SALE_ROUTE_PARAMS_MISSING',
        'companyId, branchId and orderId path parameters are required',
        400,
      );
    }

    const rawIfMatch = req.headers['if-match'];
    const expectedVersion = requireIfMatch(
      parseIfMatch(Array.isArray(rawIfMatch) ? rawIfMatch[0] : rawIfMatch),
    );

    const parsed = completeSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'invalid complete-sale request body', 400, [
        { field: 'body', issue: parsed.error.message },
      ]);
    }
    const dto = parsed.data;

    return {
      tenantId,
      companyId,
      branchId,
      orderId,
      expectedVersion,
      paymentIntent: dto.paymentIntent,
      tenders: dto.tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor })),
      advanceApplications: [...dto.advanceApplications]
        .map((a) => ({ advanceId: a.advanceId, amountMinor: a.amountMinor }))
        .sort((x, y) => (x.advanceId < y.advanceId ? -1 : x.advanceId > y.advanceId ? 1 : 0)),
      creditLimitExceptionReason:
        dto.creditLimitExceptionReason === undefined ? null : dto.creditLimitExceptionReason.trim(),
    };
  }
}
