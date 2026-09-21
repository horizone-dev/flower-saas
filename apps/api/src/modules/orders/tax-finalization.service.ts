import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `PostingEngineService`'s and
// `InvoiceIssuanceRepository`'s own precedent exactly): this is an internal
// primitive that must PARTICIPATE in a caller's already-open transaction,
// never open its own — its public `finalizeAndIssueInvoice(tx: ScopedTx,
// ...)` contract requires this type directly, and no raw Prisma model access
// happens here outside `tx.<model>`/`tx.$queryRaw` calls on the caller-
// supplied, already-scoped `tx`.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { ScopedTx } from '@flower/db';
import { Money, type RoundingMode } from '@flower/money';
import { Quantity } from '@flower/uom';
import { NotFoundError } from '../../common/errors/domain-error.js';
import {
  InvoiceIssuanceRepository,
  type IssueFinalInvoiceResult,
  type FinalizedLineTax,
  type FinalizedTotals,
} from './invoice-issuance.repository.js';
import { allocateDocumentDiscount } from './document-discount-allocation.js';
import { exactLineTax, roundExact, reconcileDocumentTax } from './tax-arithmetic.js';

export interface FinalizeAndIssueInvoiceInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  orderId: string;
  expectedVersion: number;
  /** the caller's own expectation of the Order's current
   *  `commercialSnapshotFingerprint` — verified unchanged by
   *  `InvoiceIssuanceRepository.issueFinalInvoice`, never re-derived here. */
  commercialSnapshotFingerprint: string;
}

/**
 * Task 3b.4 Checkpoint D — the internal-only tax-finalization primitive.
 * Bridges Checkpoint A (pure tax arithmetic) + Checkpoint B (pure
 * document-discount allocation) + Checkpoint C (frozen Order fiscal policy)
 * into the Task 3b.3 Checkpoint C `InvoiceIssuanceRepository.issueFinalInvoice`
 * contract, inside the SAME caller-owned `ScopedTx` — never its own
 * transaction, mirroring `issueFinalInvoice` and `PostingEngineService`
 * exactly. NOT HTTP-exposed — no controller anywhere calls this; a future
 * task (3b.9 or another internal orchestration layer) is the eventual caller.
 *
 * AUTHORITATIVE INPUTS ONLY (§D3): every commercial/fiscal value used here
 * comes from the LOCKED, persisted `order`/`order_line` rows — quantity, unit
 * price, line discount, document discount, rateBps, tax category,
 * priceTaxMode, roundingScope, roundingMode, currency/exponent, linePosition.
 * The caller supplies ONLY control/concurrency context
 * ({@link FinalizeAndIssueInvoiceInput}) — never a computed tax amount, never
 * a policy value. Live Catalog/UOM/TaxResolution/CountryTaxConfig are NEVER
 * re-consulted — the Order's own frozen fiscal policy (Task 3b.4 Checkpoint
 * C) and each OrderLine's own frozen tax-reference snapshot (Task 3b.3) are
 * the sole authorities.
 */
@Injectable()
export class TaxFinalizationService {
  constructor(private readonly issuance: InvoiceIssuanceRepository) {}

  async finalizeAndIssueInvoice(
    tx: ScopedTx,
    input: FinalizeAndIssueInvoiceInput,
  ): Promise<IssueFinalInvoiceResult> {
    // ── 1. lock the authoritative Order (same tenant/company/branch scope
    //      `issueFinalInvoice` itself uses) — its OWN frozen fiscal policy is
    //      the sole source for every line's priceTaxMode/roundingScope/
    //      roundingMode; never re-resolved from CountryTaxConfig. ──────────
    const orderRows = await tx.$queryRaw<
      {
        id: string;
        currencyCode: string;
        currencyExponent: number;
        documentDiscountAmountMinor: bigint;
        taxPriceMode: string;
        taxRoundingScope: string;
        taxRoundingMode: string;
      }[]
    >`
      SELECT "id", "currencyCode", "currencyExponent", "documentDiscountAmountMinor",
             "taxPriceMode", "taxRoundingScope", "taxRoundingMode"
        FROM "order"
       WHERE "id" = ${input.orderId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "originBranchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');

    // ── 2. lock + load every OrderLine, ORDER BY linePosition ASC (§D2/§D4) ─
    await tx.$queryRaw`SELECT "id" FROM "order_line" WHERE "orderId" = ${order.id}::uuid FOR UPDATE`;
    const lineRows = await tx.orderLine.findMany({
      where: { orderId: order.id },
      orderBy: { linePosition: 'asc' },
      select: {
        id: true,
        linePosition: true,
        quantity: true,
        unitPriceAmountMinor: true,
        unitPriceCurrencyCode: true,
        discountAmountMinor: true,
        rateBps: true,
      },
    });

    // ── 3. commercial reconstruction (§D4) — the IDENTICAL frozen formula
    //      Task 3b.3 uses at create/PATCH time and
    //      `InvoiceIssuanceRepository`'s own subtotal-recomputation reuses:
    //      gross = unitPrice × quantity (exact BigInt via `Money.mulRatio`),
    //      net-of-line-discount = gross − lineDiscountAmountMinor. Never
    //      re-priced from live Catalog, never re-resolved UOM. ─────────────
    const afterLineDiscount = lineRows.map((l) => {
      const gross = Money.ofMinor(l.unitPriceAmountMinor, l.unitPriceCurrencyCode).mulRatio(
        Quantity.parse(l.quantity.toFixed(4)).scaled,
        10_000n,
      );
      return {
        id: l.id,
        linePosition: l.linePosition,
        rateBps: l.rateBps,
        amountMinor: gross.subtract(Money.ofMinor(l.discountAmountMinor, l.unitPriceCurrencyCode))
          .amountMinor,
      };
    });

    // ── 4. document-discount allocation (§D5) — the frozen Checkpoint B
    //      helper, ALL lines participate identically regardless of tax
    //      status; no allocation is persisted separately. ──────────────────
    const allocation = allocateDocumentDiscount(
      afterLineDiscount.map((l) => ({
        linePosition: l.linePosition,
        commercialAmountAfterLineDiscountMinor: l.amountMinor,
      })),
      order.documentDiscountAmountMinor,
      order.currencyCode,
    );
    const afterDocumentDiscountByPosition = new Map(
      allocation.lines.map((l) => [l.linePosition, l.commercialAmountAfterDocumentDiscountMinor]),
    );

    // ── 5/6/7. tax reference handling + LINE/DOCUMENT rounding (§D6-D9) ────
    const priceTaxMode = order.taxPriceMode as 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
    const roundingMode = order.taxRoundingMode as RoundingMode;
    const ratedLines = afterLineDiscount.filter((l) => l.rateBps !== null);

    const lineTaxByPosition = new Map<number, bigint>();
    for (const l of afterLineDiscount) {
      if (l.rateBps === null) lineTaxByPosition.set(l.linePosition, 0n); // §D6 no-rate
    }

    if (order.taxRoundingScope === 'LINE') {
      for (const l of ratedLines) {
        const amount = afterDocumentDiscountByPosition.get(l.linePosition)!;
        const rational = exactLineTax(amount, l.rateBps!, priceTaxMode);
        lineTaxByPosition.set(l.linePosition, roundExact(rational, roundingMode));
      }
    } else {
      // DOCUMENT scope (§D9) — exact rationals for every rated line
      // (including a resolved zero-rate — its rational is simply value 0,
      // never distinguished here from any other rate), reconciled once via
      // the frozen Checkpoint A helper, mapped back by linePosition.
      const documentInputs = ratedLines.map((l) => ({
        linePosition: l.linePosition,
        rational: exactLineTax(
          afterDocumentDiscountByPosition.get(l.linePosition)!,
          l.rateBps!,
          priceTaxMode,
        ),
      }));
      const reconciled = reconcileDocumentTax(documentInputs, roundingMode);
      for (const r of reconciled.lines) {
        lineTaxByPosition.set(r.linePosition, r.lineTaxAmountMinor);
      }
    }

    // ── 8. finalized line-tax snapshot (§D10) — exactly one entry per
    //      persisted OrderLine, no duplicate/missing ids, no caller policy. ─
    const finalizedLines: FinalizedLineTax[] = afterLineDiscount.map((l) => ({
      orderLineId: l.id,
      priceTaxMode: order.taxPriceMode,
      roundingScope: order.taxRoundingScope,
      roundingMode: order.taxRoundingMode,
      lineTaxAmountMinor: lineTaxByPosition.get(l.linePosition)!,
    }));

    // ── 9. finalized totals (§D11) — frozen semantics, mode-conditional. ───
    const subtotalAmountMinor = afterLineDiscount.reduce((acc, l) => acc + l.amountMinor, 0n);
    const taxTotalAmountMinor = finalizedLines.reduce((acc, l) => acc + l.lineTaxAmountMinor, 0n);
    const totalAmountMinor =
      priceTaxMode === 'TAX_EXCLUSIVE'
        ? subtotalAmountMinor - order.documentDiscountAmountMinor + taxTotalAmountMinor
        : subtotalAmountMinor - order.documentDiscountAmountMinor;
    const totals: FinalizedTotals = {
      subtotalAmountMinor,
      documentDiscountAmountMinor: order.documentDiscountAmountMinor,
      taxTotalAmountMinor,
      totalAmountMinor,
      currencyCode: order.currencyCode,
      currencyExponent: order.currencyExponent,
    };

    // ── 10. delegate to the existing internal issuance primitive, SAME tx —
    //       it independently revalidates status/version/fingerprint/line
    //       coverage/policy-uniformity/totals before writing anything. ─────
    return this.issuance.issueFinalInvoice(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      orderId: input.orderId,
      expectedVersion: input.expectedVersion,
      commercialSnapshotFingerprint: input.commercialSnapshotFingerprint,
      lines: finalizedLines,
      totals,
    });
  }
}
