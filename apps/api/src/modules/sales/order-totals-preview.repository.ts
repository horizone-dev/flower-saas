import { Injectable } from '@nestjs/common';
import { requireTenantContext } from '../../common/context/index.js';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import {
  computeCanonicalTotals,
  toOrderTotalsPreview,
  type OrderTotalsPreview,
} from '../orders/canonical-totals.js';

interface PreviewRow {
  id: string;
  version: number;
  currencyCode: string;
  currencyExponent: number;
  documentDiscountAmountMinor: bigint;
  taxPriceMode: string;
  taxRoundingScope: string;
  taxRoundingMode: string;
  lineId: string | null;
  linePosition: number | null;
  quantity: string | null;
  unitPriceAmountMinor: bigint | null;
  unitPriceCurrencyCode: string | null;
  discountAmountMinor: bigint | null;
  rateBps: number | null;
}

/**
 * Task 3b.9 Checkpoint E — the READ-ONLY canonical totals preview
 * (`GET …/orders/:orderId/totals`, owner ruling OD-4).
 *
 * It calls the ONE canonical Checkpoint-A computation (`computeCanonicalTotals`) — the very
 * function `TaxFinalizationService.prepareFinalization` calls under the order lock — over the
 * order's persisted, frozen rows. No tax / discount / rounding formula exists in this file,
 * the controller or the facade.
 *
 * Read-only by construction: ONE `SELECT` (one statement ⇒ ONE snapshot of the order row and
 * its lines, so the returned `version` always belongs to the lines the totals were computed
 * from), NO `FOR UPDATE` / `FOR SHARE` (a preview must never block an edit or a sale), no
 * invoice, no number, no payment, no journal, no audit, no outbox.
 *
 * ADVISORY and VERSION-BOUND: the response carries the `version` it was computed for, and
 * completion ALWAYS recomputes under the order lock from the then-current rows — a preview of
 * version N never authorizes or freezes anything after the order moved to N+1 (`If-Match` on
 * `complete-sale` is the guard).
 *
 * Scope: tenant from the authenticated context only; company / branch are route params already
 * authorised by the guard pipeline, and are ALSO explicit predicates here — DB RLS on `order` is
 * tenant-only and is never the branch boundary.
 */
@Injectable()
export class OrderTotalsPreviewRepository extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }

  async previewForBranchScoped(input: {
    companyId: string;
    branchId: string;
    orderId: string;
  }): Promise<OrderTotalsPreview> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const rows = await tx.$queryRaw<PreviewRow[]>`
        SELECT o."id", o."version", o."currencyCode", o."currencyExponent",
               o."documentDiscountAmountMinor", o."taxPriceMode", o."taxRoundingScope",
               o."taxRoundingMode",
               l."id" AS "lineId", l."linePosition", l."quantity"::text AS "quantity",
               l."unitPriceAmountMinor", l."unitPriceCurrencyCode", l."discountAmountMinor",
               l."rateBps"
          FROM "order" o
          LEFT JOIN "order_line" l
            ON l."orderId" = o."id" AND l."tenantId" = o."tenantId"
         WHERE o."id" = ${input.orderId}::uuid
           AND o."tenantId" = ${tenantId}::uuid
           AND o."companyId" = ${input.companyId}::uuid
           AND o."originBranchId" = ${input.branchId}::uuid
         ORDER BY l."linePosition" ASC`;
      const head = rows[0];
      if (!head) throw new NotFoundError('order', 'ORDER_NOT_FOUND');

      const lines = rows.flatMap((r) =>
        r.lineId === null
          ? []
          : [
              {
                id: r.lineId,
                linePosition: r.linePosition!,
                quantity: r.quantity!,
                unitPriceAmountMinor: r.unitPriceAmountMinor!,
                unitPriceCurrencyCode: r.unitPriceCurrencyCode!,
                discountAmountMinor: r.discountAmountMinor!,
                rateBps: r.rateBps,
              },
            ],
      );

      let result;
      try {
        result = computeCanonicalTotals(head, lines);
      } catch (err) {
        if (err instanceof RangeError) {
          // the same mapping finalization applies when the persisted commercial state can no
          // longer be reconciled — never a raw 500
          throw new DomainError('ORDER_COMMERCIAL_STATE_CHANGED', err.message, 409);
        }
        throw err;
      }
      return toOrderTotalsPreview(head, result);
    });
  }
}
