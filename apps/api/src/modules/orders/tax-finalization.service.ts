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
import { NotFoundError } from '../../common/errors/domain-error.js';
import {
  InvoiceIssuanceRepository,
  type IssueFinalInvoiceResult,
} from './invoice-issuance.repository.js';
import {
  computeCanonicalTotals,
  type CanonicalLineTax,
  type CanonicalTotals,
} from './canonical-totals.js';
import type { AuthorizedCreditOverride } from '../receivables/credit-override-authorization.service.js';
import type { PaymentIntent } from '../receivables/payment-intent.js';

/** the trusted scope + order identity {@link TaxFinalizationService.prepareFinalization} needs */
export interface PrepareFinalizationInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  orderId: string;
}

/** the output of the ONE canonical computation over the locked order + lines */
export interface PreparedFinalization {
  orderId: string;
  lines: CanonicalLineTax[];
  totals: CanonicalTotals;
}

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
  /** Task 3b.6 Checkpoint C — passed through verbatim to `issueFinalInvoice`;
   *  see its own doc comment for the frozen contract (no default, no
   *  inference). */
  paymentIntent: PaymentIntent;
  creditOverride?: AuthorizedCreditOverride;
  // 3b.9-credit-exposure:begin
  /** Task 3b.9 — passed through verbatim to `issueFinalInvoice`; see its doc comment (internal,
   *  trusted, optional; omitted = the frozen invoice-total gate basis). */
  finalSaleOutstandingMinor?: bigint;
  // 3b.9-credit-exposure:end
  actorUserId?: string | null;
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

  /**
   * The one-shot finalization: {@link prepareFinalization} then
   * {@link issuePrepared}, in this order, on the caller's `tx`. Behaviour is
   * unchanged from before the split (task 3b.9 Checkpoint C) — the two halves
   * exist so an orchestrator can validate a payment plan against the FINAL total
   * BEFORE any invoice / order number is allocated, while still using exactly
   * the same computation and the same issuance call.
   */
  async finalizeAndIssueInvoice(
    tx: ScopedTx,
    input: FinalizeAndIssueInvoiceInput,
  ): Promise<IssueFinalInvoiceResult> {
    const prepared = await this.prepareFinalization(tx, input);
    return this.issuePrepared(tx, prepared, input);
  }

  /**
   * Steps 1-9 of the finalization: lock the authoritative Order + its lines and
   * run the ONE canonical computation over the locked, persisted rows. Writes
   * NOTHING and allocates NO number — it is safe to call, inspect the totals,
   * and then fail or proceed to {@link issuePrepared} inside the same
   * transaction (re-locking an already-held row is a no-op).
   */
  async prepareFinalization(
    tx: ScopedTx,
    input: PrepareFinalizationInput,
  ): Promise<PreparedFinalization> {
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

    // ── 3-9. the ONE canonical, pure computation (task 3b.9 Checkpoint A —
    //        extracted verbatim from this method's former inline steps 3-9:
    //        commercial reconstruction, document-discount allocation, tax
    //        reference handling + LINE/DOCUMENT rounding, finalized line-tax
    //        snapshot, mode-conditional totals). The read-only totals preview
    //        calls the SAME function; no tax formula lives in this file. The
    //        inputs are exactly the locked, persisted rows read above — the
    //        Order's own frozen fiscal policy and each line's own frozen
    //        tax-reference snapshot, never live configuration. ──────────────
    const { lines: finalizedLines, totals } = computeCanonicalTotals(
      order,
      lineRows.map((l) => ({
        id: l.id,
        linePosition: l.linePosition,
        quantity: l.quantity.toFixed(4),
        unitPriceAmountMinor: l.unitPriceAmountMinor,
        unitPriceCurrencyCode: l.unitPriceCurrencyCode,
        discountAmountMinor: l.discountAmountMinor,
        rateBps: l.rateBps,
      })),
    );

    return { orderId: order.id, lines: finalizedLines, totals };
  }

  /**
   * Step 10 of the finalization: delegate to the existing internal issuance
   * primitive, SAME tx — it independently revalidates status / version /
   * fingerprint / line coverage / policy-uniformity / totals against the locked
   * rows before writing anything. `prepared` must be the result of
   * {@link prepareFinalization} for THIS order (anything else fails closed).
   */
  async issuePrepared(
    tx: ScopedTx,
    prepared: PreparedFinalization,
    input: FinalizeAndIssueInvoiceInput,
  ): Promise<IssueFinalInvoiceResult> {
    if (prepared.orderId !== input.orderId) {
      throw new RangeError(
        `issuePrepared: the prepared finalization is for order ${prepared.orderId}, not ${input.orderId}`,
      );
    }
    return this.issuance.issueFinalInvoice(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      orderId: input.orderId,
      expectedVersion: input.expectedVersion,
      commercialSnapshotFingerprint: input.commercialSnapshotFingerprint,
      lines: prepared.lines,
      totals: prepared.totals,
      paymentIntent: input.paymentIntent,
      ...(input.creditOverride !== undefined ? { creditOverride: input.creditOverride } : {}),
      // 3b.9-credit-exposure:begin
      ...(input.finalSaleOutstandingMinor !== undefined
        ? { finalSaleOutstandingMinor: input.finalSaleOutstandingMinor }
        : {}),
      // 3b.9-credit-exposure:end
      actorUserId: input.actorUserId ?? null,
    });
  }
}
