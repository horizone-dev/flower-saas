import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Quantity } from '@flower/uom';
import type { SemanticFingerprintProvider } from '../../common/idempotency/index.js';
import { getContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { createOrderSchema } from './dto/create-order.dto.js';

/**
 * Task 3b.3 Checkpoint B — the Order-create idempotency fingerprint is based
 * on NORMALIZED client-declared commercial intent, not the raw HTTP body, so
 * two raw quantity strings that normalize to the same exact decimal (`"2"`
 * vs `"2.0"` vs `"2.00"`) produce the SAME fingerprint under the same
 * `Idempotency-Key` (mirrors `CustomerCreateFingerprintProvider`'s exact
 * phone/email-normalization rationale — task 3b.2 owner review round).
 *
 * Deliberately does NOT resolve price/tax/UOM-conversion here — this is the
 * idempotency-replay identity of what the CLIENT asked for, computed before
 * any domain transaction opens; the authoritative `commercialSnapshotFingerprint`
 * persisted on the `Order` row itself (`commercial-snapshot.ts`) is a
 * SEPARATE, server-resolved value computed later, inside `OrderRepository`.
 *
 * SECURITY: `tenantId` comes ONLY from `getContext()`; `companyId`/`branchId`
 * come from route params already authorization-validated by `PermissionGuard`
 * (`@ScopedParam`) before any interceptor runs — identical reasoning to
 * `CustomerCreateFingerprintProvider`.
 */
@Injectable()
export class OrderCreateFingerprintProvider implements SemanticFingerprintProvider {
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
    if (!companyId || !branchId) {
      throw new DomainError(
        'ORDER_ROUTE_PARAMS_MISSING',
        'companyId and branchId path parameters are required',
        400,
      );
    }

    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'invalid order create request body', 400, [
        { field: 'body', issue: parsed.error.message },
      ]);
    }

    return {
      tenantId,
      companyId,
      branchId,
      customerId: parsed.data.customerId ?? null,
      lines: parsed.data.lines.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        selectedUomCode: l.selectedUomCode,
        quantity: Quantity.parse(l.quantity).toFixed4(),
        discountMode: l.discountMode,
        discountBps: l.discountBps ?? null,
        discountAmountMinor: l.discountAmountMinor ?? null,
        discountReason: l.discountReason ?? null,
      })),
      documentDiscountMode: parsed.data.documentDiscountMode,
      documentDiscountBps: parsed.data.documentDiscountBps ?? null,
      documentDiscountAmountMinor: parsed.data.documentDiscountAmountMinor ?? null,
      documentDiscountReason: parsed.data.documentDiscountReason ?? null,
    };
  }
}
