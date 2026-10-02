import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `CancellationChargeRepository`/
// `CustomerInvoiceArRepository`/`PostingEngineService` exactly): this is an
// internal primitive that must PARTICIPATE in the caller's already-open
// transaction, never open its own.
import type { ScopedTx, Prisma } from '@flower/db';
import { Money } from '@flower/money';
import { Quantity } from '@flower/uom';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { allocateDocumentDiscount } from './document-discount-allocation.js';
import { coverageSourceOfApplication, type CoverageSource } from './credit-note-coverage-source.js';
import { assertCustomerAccountEntryReferenceShape } from '../receivables/customer-account-entry.js';
import { computeFullCancellationResolution } from '../receivables/invoice-payment-status.js';

export interface IssueCreditNoteForFullCancellationInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  orderId: string;
  invoiceId: string;
  customerCompanyAccountId: string;
  reasonCode: string;
  note: string | null;
  accountingDate: string;
  actorUserId?: string | null;
}

export interface IssueCreditNoteForFullCancellationResult {
  creditNoteId: string;
  creditNoteNumber: string;
  arReductionMinor: bigint;
  advanceExcessMinor: bigint;
  nextInvoicePaymentStatus: 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
}

interface OrderLineForCredit {
  id: string;
  linePosition: number;
  quantity: Prisma.Decimal;
  unitPriceAmountMinor: bigint;
  unitPriceCurrencyCode: string;
  discountAmountMinor: bigint;
  priceTaxMode: string | null;
  lineTaxAmountMinor: bigint | null;
}

/**
 * Task 3b.8 Checkpoint D — the post-invoice, FULL-order cancellation
 * CreditNote issuance atomic-write primitive. NOT HTTP-exposed. Called only
 * from `OrderRepository`'s post-invoice cancellation path, inside the
 * CALLER's already-open transaction (same "internal primitive" discipline as
 * every other 3b.8 repository).
 *
 * Scope frozen for this checkpoint (owner-approved narrowing): FULL order
 * only (every OrderLine credited at its full remaining quantity — no partial
 * line/quantity selection), no split resolution (the full paid portion
 * becomes ONE pool of CREDIT_NOTE-sourced Advance(s), never pre-split across
 * refund/credit in this same call — a later, separate Refund request draws
 * from the resulting Advance), no cancellation-charge policy engine (reuses
 * Checkpoint C's ad-hoc amount/reasonCode input, called separately by the
 * caller), SETTLED invoices are out of scope entirely (the caller rejects
 * before this is ever invoked).
 *
 * Every `CreditNoteLine` amount is re-derived ONLY from each OrderLine's own
 * already-immutable frozen snapshot (`unitPriceAmountMinor`/`quantity`/
 * `discountAmountMinor`/`lineTaxAmountMinor`, all frozen once the Order is
 * numbered) plus a deterministic re-run of `allocateDocumentDiscount` over
 * those SAME frozen inputs — never a live tax/catalog re-resolution. Since
 * `quantityCredited == quantity` for every line (full cancellation), the
 * proportional `qC/qO` ratio is always exactly 1 — `taxCreditedMinor` is
 * simply each line's own frozen `lineTaxAmountMinor` reused verbatim.
 *
 * Monetary resolution (`arReductionMinor`/`advanceExcessMinor`,
 * ADR-0019 §19) is computed from the invoice's ACTUAL coverage (every
 * `PaymentAllocation` + `CustomerAdvanceApplication` row targeting it) —
 * never the nominal total. For a full cancellation every coverage row is
 * released in its ENTIRETY (there is nothing left to partially unwind), each
 * funding exactly ONE new `CustomerAdvance(sourceType='CREDIT_NOTE')` via its
 * own `CreditNoteCoverageRelease` row (frozen 1:1, §10 of the 3b.8-A
 * architecture) — no LIFO partial-walk is needed at this scope (that only
 * matters for a PARTIAL cancellation, out of scope here).
 */
@Injectable()
export class CreditNoteRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
  ) {}

  async issueCreditNoteForFullCancellation(
    tx: ScopedTx,
    input: IssueCreditNoteForFullCancellationInput,
  ): Promise<IssueCreditNoteForFullCancellationResult> {
    // ── 1. lock + load every OrderLine, ORDER BY linePosition ASC (same
    //      discipline as `TaxFinalizationService`) — the Order itself is
    //      already locked by the caller before this is invoked. ───────────
    await tx.$queryRaw`SELECT "id" FROM "order_line" WHERE "orderId" = ${input.orderId}::uuid FOR UPDATE`;
    const lineRows = (await tx.orderLine.findMany({
      where: { orderId: input.orderId },
      orderBy: { linePosition: 'asc' },
      select: {
        id: true,
        linePosition: true,
        quantity: true,
        unitPriceAmountMinor: true,
        unitPriceCurrencyCode: true,
        discountAmountMinor: true,
        priceTaxMode: true,
        lineTaxAmountMinor: true,
      },
    })) as unknown as OrderLineForCredit[];

    // ── 2. full-quantity commercial reconstruction — IDENTICAL frozen
    //      formula `TaxFinalizationService` uses: gross = unitPrice ×
    //      quantity, net-of-line-discount = gross − discountAmountMinor. ───
    const afterLineDiscount = lineRows.map((l) => {
      const quantityStr = l.quantity.toFixed(4);
      const gross = Money.ofMinor(l.unitPriceAmountMinor, l.unitPriceCurrencyCode).mulRatio(
        Quantity.parse(quantityStr).scaled,
        10_000n,
      );
      return {
        orderLineId: l.id,
        linePosition: l.linePosition,
        quantity: quantityStr,
        grossCreditedMinor: gross.amountMinor,
        discountCreditedMinor: l.discountAmountMinor,
        amountAfterLineDiscount: gross.subtract(
          Money.ofMinor(l.discountAmountMinor, l.unitPriceCurrencyCode),
        ).amountMinor,
        priceTaxMode: l.priceTaxMode,
        taxCreditedMinor: l.lineTaxAmountMinor ?? 0n,
      };
    });

    // ── 3. document-discount re-derivation — deterministic replay of the
    //      SAME Checkpoint B helper over the SAME frozen inputs; never
    //      persisted anywhere on `order_line` itself (§11 of the 3b.8-A
    //      architecture). ───────────────────────────────────────────────
    const orderRows = await tx.$queryRaw<
      { documentDiscountAmountMinor: bigint; currencyCode: string; currencyExponent: number }[]
    >`SELECT "documentDiscountAmountMinor", "currencyCode", "currencyExponent" FROM "order" WHERE "id" = ${input.orderId}::uuid`;
    const order = orderRows[0]!;
    const allocation = allocateDocumentDiscount(
      afterLineDiscount.map((l) => ({
        linePosition: l.linePosition,
        commercialAmountAfterLineDiscountMinor: l.amountAfterLineDiscount,
      })),
      order.documentDiscountAmountMinor,
      order.currencyCode,
    );
    const documentDiscountShareByPosition = new Map(
      allocation.lines.map((l) => [l.linePosition, l.documentDiscountShareMinor]),
    );

    const creditNoteLines = afterLineDiscount.map((l) => {
      const documentDiscountShareCreditedMinor = documentDiscountShareByPosition.get(
        l.linePosition,
      )!;
      const netAfterDocumentDiscountCreditedMinor =
        l.amountAfterLineDiscount - documentDiscountShareCreditedMinor;
      const lineTotalCreditedMinor =
        l.priceTaxMode === 'TAX_INCLUSIVE'
          ? netAfterDocumentDiscountCreditedMinor
          : netAfterDocumentDiscountCreditedMinor + l.taxCreditedMinor;
      return {
        orderLineId: l.orderLineId,
        quantityCredited: l.quantity,
        grossCreditedMinor: l.grossCreditedMinor,
        discountCreditedMinor: l.discountCreditedMinor,
        documentDiscountShareCreditedMinor,
        netAfterDocumentDiscountCreditedMinor,
        taxCreditedMinor: l.taxCreditedMinor,
        lineTotalCreditedMinor,
      };
    });

    const subtotalAmountMinor = creditNoteLines.reduce(
      (acc, l) => acc + l.netAfterDocumentDiscountCreditedMinor,
      0n,
    );
    const taxTotalAmountMinor = creditNoteLines.reduce((acc, l) => acc + l.taxCreditedMinor, 0n);
    const totalAmountMinor = creditNoteLines.reduce((acc, l) => acc + l.lineTotalCreditedMinor, 0n);

    // ── 4. actual coverage (never the nominal total, ADR-0019 §19) —
    //      every PaymentAllocation + CustomerAdvanceApplication row
    //      targeting this Invoice's own CustomerReceivable. ───────────────
    const coverage = await this.loadCoverageSources(tx, input.invoiceId);
    const paidMinor = coverage.reduce((acc, c) => acc + c.amountMinor, 0n);
    const resolution = computeFullCancellationResolution({
      invoiceTotalMinor: totalAmountMinor,
      paidMinor,
    });

    // ── 5. allocate the gapless CREDIT_NOTE number, insert the immutable
    //      CreditNote + its lines. ──────────────────────────────────────
    const creditNoteNumber = await this.allocateNumber(tx, input.tenantId, input.companyId);
    const accountingDate = new Date(`${input.accountingDate}T00:00:00.000Z`);
    const creditNote = await tx.creditNote.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        invoiceId: input.invoiceId,
        creditNoteNumber,
        issuedAt: new Date(),
        accountingDate,
        currencyCode: order.currencyCode,
        currencyExponent: order.currencyExponent,
        reasonCode: input.reasonCode,
        note: input.note,
        subtotalAmountMinor,
        taxTotalAmountMinor,
        totalAmountMinor,
        arReductionMinor: resolution.arReductionMinor,
        advanceExcessMinor: resolution.advanceExcessMinor,
        createdByUserId: input.actorUserId ?? null,
      },
    });

    await tx.creditNoteLine.createMany({
      data: creditNoteLines.map((l) => ({
        tenantId: input.tenantId,
        companyId: input.companyId,
        creditNoteId: creditNote.id,
        orderLineId: l.orderLineId,
        quantityCredited: l.quantityCredited,
        grossCreditedMinor: l.grossCreditedMinor,
        discountCreditedMinor: l.discountCreditedMinor,
        documentDiscountShareCreditedMinor: l.documentDiscountShareCreditedMinor,
        netAfterDocumentDiscountCreditedMinor: l.netAfterDocumentDiscountCreditedMinor,
        taxCreditedMinor: l.taxCreditedMinor,
        lineTotalCreditedMinor: l.lineTotalCreditedMinor,
        currencyCode: order.currencyCode,
        currencyExponent: order.currencyExponent,
      })),
    });

    // ── 6. CREDIT_NOTE chronology entry — ONLY when arReductionMinor > 0
    //      (§ schema doc comment: "a Credit Note whose full amount became
    //      Advance excess writes no CREDIT_NOTE entry"). ──────────────────
    if (resolution.arReductionMinor > 0n) {
      assertCustomerAccountEntryReferenceShape('CREDIT_NOTE', { creditNoteId: creditNote.id });
      await tx.customerAccountEntry.create({
        data: {
          tenantId: input.tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          customerCompanyAccountId: input.customerCompanyAccountId,
          entryKind: 'CREDIT_NOTE',
          creditNoteId: creditNote.id,
        },
      });
    }

    // ── 7. release every coverage source in FULL, each funding exactly ONE
    //      new CustomerAdvance(sourceType='CREDIT_NOTE') (frozen 1:1). ─────
    for (const source of coverage) {
      await this.releaseOneCoverageSource(tx, {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        creditNoteId: creditNote.id,
        customerCompanyAccountId: input.customerCompanyAccountId,
        currencyCode: creditNote.currencyCode,
        currencyExponent: creditNote.currencyExponent,
        actorUserId: input.actorUserId ?? null,
        source,
      });
    }

    // ── 8. customer-level projections — AR reduction decreases
    //      `currentOutstandingMinor` by exactly the still-unpaid remainder
    //      (the SAME value that was never decremented by any Payment/Advance
    //      application); `advanceBalanceMinor` is incremented inside step 7,
    //      per released source, mirroring `payment-advance-conversion`'s own
    //      precedent exactly. ─────────────────────────────────────────────
    if (resolution.arReductionMinor > 0n) {
      await tx.customerCompanyAccount.update({
        where: { id: input.customerCompanyAccountId },
        data: { currentOutstandingMinor: { decrement: resolution.arReductionMinor } },
      });
    }

    // ── 9. GL — the mirror-image of `invoice_ar`'s own posting (Dr/Cr
    //      reversed): Dr REVENUE.SALES (total − tax) + Dr LIABILITY.TAX_PAYABLE
    //      (tax) / Cr ASSET.ACCOUNTS_RECEIVABLE (arReduction) + Cr
    //      LIABILITY.CUSTOMER_ADVANCES (advanceExcess) — this SAME journal
    //      is what funds every CREDIT_NOTE-sourced Advance created in step 7
    //      (no second, separate journal per Advance — § schema doc comment:
    //      "no GL is attached to the creation of this Advance"). ───────────
    // Revenue is the NET (ex-tax) amount — the very amount the Invoice credited
    // (`customer-invoice-ar.repository.ts`: revenue = total − tax). It is NOT
    // `subtotalAmountMinor`: under TAX_INCLUSIVE a line's net-after-discount
    // already CONTAINS its tax, so debiting revenue by the subtotal AND tax by
    // the extracted tax would exceed the credit side (total) by exactly the tax
    // and the journal would be rejected. Under TAX_EXCLUSIVE total − tax ==
    // subtotal, so that mode is unchanged.
    const revenueAmountMinor = totalAmountMinor - taxTotalAmountMinor;
    const lines = [
      ...(revenueAmountMinor > 0n
        ? [
            {
              accountKey: 'REVENUE.SALES',
              direction: 'debit' as const,
              amountMinor: revenueAmountMinor,
            },
          ]
        : []),
      ...(taxTotalAmountMinor > 0n
        ? [
            {
              accountKey: 'LIABILITY.TAX_PAYABLE',
              direction: 'debit' as const,
              amountMinor: taxTotalAmountMinor,
            },
          ]
        : []),
      ...(resolution.arReductionMinor > 0n
        ? [
            {
              accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
              direction: 'credit' as const,
              amountMinor: resolution.arReductionMinor,
            },
          ]
        : []),
      ...(resolution.advanceExcessMinor > 0n
        ? [
            {
              accountKey: 'LIABILITY.CUSTOMER_ADVANCES',
              direction: 'credit' as const,
              amountMinor: resolution.advanceExcessMinor,
            },
          ]
        : []),
    ];
    const journal = await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'credit_note',
      sourceId: creditNote.id,
      lines,
      accountingDate: input.accountingDate,
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });
    void journal;

    await this.audit.record(tx, {
      action: 'credit_note.issued',
      resourceType: 'credit_note',
      resourceId: creditNote.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      actorUserId: input.actorUserId ?? null,
      after: {
        orderId: input.orderId,
        invoiceId: input.invoiceId,
        creditNoteNumber,
        totalAmountMinor: totalAmountMinor.toString(),
        arReductionMinor: resolution.arReductionMinor.toString(),
        advanceExcessMinor: resolution.advanceExcessMinor.toString(),
        currencyCode: order.currencyCode,
      },
    });

    return {
      creditNoteId: creditNote.id,
      creditNoteNumber,
      arReductionMinor: resolution.arReductionMinor,
      advanceExcessMinor: resolution.advanceExcessMinor,
      nextInvoicePaymentStatus: resolution.nextStatus,
    };
  }

  /**
   * Every `PaymentAllocation` + `CustomerAdvanceApplication` row targeting
   * this Invoice's own `CustomerReceivable` — the authoritative coverage
   * sources (never the nominal total). Tags each `CustomerAdvanceApplication`
   * row by its underlying `CustomerAdvance.sourceType` (`PAYMENT` / `OPENING`
   * / `CREDIT_NOTE`) per `CreditNoteCoverageRelease`'s own frozen `sourceKind`
   * shape rules. A CREDIT_NOTE-sourced advance has no Payment of its own, so
   * the one release that funded it (frozen 1:1) is LEFT JOINed to supply its
   * authoritative ultimate provenance — `coverageSourceOfApplication` carries
   * that forward exactly (never invented, never taken from the request) and
   * fails closed when it is missing or inconsistent (task 3b.8 F3).
   */
  private async loadCoverageSources(tx: ScopedTx, invoiceId: string): Promise<CoverageSource[]> {
    const allocations = await tx.$queryRaw<
      { id: string; paymentId: string; amountMinor: bigint }[]
    >`SELECT "id", "paymentId", "amountMinor" FROM "payment_allocation" WHERE "invoiceId" = ${invoiceId}::uuid`;

    const sources: CoverageSource[] = allocations.map((a) => ({
      sourceKind: 'PAYMENT_ALLOCATION',
      sourcePaymentAllocationId: a.id,
      sourceAdvanceApplicationId: null,
      sourcePaymentId: a.paymentId,
      amountMinor: a.amountMinor,
    }));

    const receivableRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_receivable" WHERE "invoiceId" = ${invoiceId}::uuid`;
    const receivableId = receivableRows[0]?.id;
    if (receivableId) {
      const applications = await tx.$queryRaw<
        {
          id: string;
          amountMinor: bigint;
          advanceSourceType: string;
          advanceSourcePaymentId: string | null;
          fundingKind: string | null;
          fundingPaymentId: string | null;
        }[]
      >`
        SELECT caa."id", caa."amountMinor",
               ca."sourceType" AS "advanceSourceType", ca."sourcePaymentId" AS "advanceSourcePaymentId",
               fr."sourceKind" AS "fundingKind", fr."sourcePaymentId" AS "fundingPaymentId"
          FROM "customer_advance_application" caa
          JOIN "customer_advance" ca ON ca."id" = caa."customerAdvanceId"
          LEFT JOIN "credit_note_coverage_release" fr ON fr."customerAdvanceId" = ca."id"
         WHERE caa."customerReceivableId" = ${receivableId}::uuid`;
      for (const a of applications) sources.push(coverageSourceOfApplication(a));
    }

    return sources;
  }

  /**
   * One `CreditNoteCoverageRelease` + exactly one new
   * `CustomerAdvance(sourceType='CREDIT_NOTE')` (frozen 1:1) + its own
   * `ADVANCE` chronology entry + the `advanceBalanceMinor` projection bump —
   * mirrors `PaymentAdvanceConversionRepository`'s own Advance-creation shape
   * exactly, minus its separate GL call (this Advance is funded by the ONE
   * CreditNote journal already posted by the caller, step 9).
   */
  private async releaseOneCoverageSource(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      branchId: string;
      creditNoteId: string;
      customerCompanyAccountId: string;
      currencyCode: string;
      currencyExponent: number;
      actorUserId: string | null;
      source: CoverageSource;
    },
  ): Promise<void> {
    const advance = await tx.customerAdvance.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        sourceType: 'CREDIT_NOTE',
        amountMinor: input.source.amountMinor,
        currencyCode: input.currencyCode,
        currencyExponent: input.currencyExponent,
        ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
      },
    });

    await tx.creditNoteCoverageRelease.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        creditNoteId: input.creditNoteId,
        sourceKind: input.source.sourceKind,
        sourcePaymentAllocationId: input.source.sourcePaymentAllocationId,
        sourceAdvanceApplicationId: input.source.sourceAdvanceApplicationId,
        sourcePaymentId: input.source.sourcePaymentId,
        releasedAmountMinor: input.source.amountMinor,
        currencyCode: input.currencyCode,
        currencyExponent: input.currencyExponent,
        customerAdvanceId: advance.id,
      },
    });

    assertCustomerAccountEntryReferenceShape('ADVANCE', { customerAdvanceId: advance.id });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'ADVANCE',
        customerAdvanceId: advance.id,
      },
    });

    await tx.customerCompanyAccount.update({
      where: { id: input.customerCompanyAccountId },
      data: { advanceBalanceMinor: { increment: input.source.amountMinor } },
    });
  }

  /**
   * `document_number_counter` allocator — identical shape/guarantees to
   * `CancellationChargeRepository.allocateNumber`. Format `CN-NNNNNN`.
   */
  private async allocateNumber(tx: ScopedTx, tenantId: string, companyId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ allocated: bigint }[]>`
      INSERT INTO "document_number_counter" ("tenantId", "companyId", "documentType", "nextNumber")
      VALUES (${tenantId}::uuid, ${companyId}::uuid, 'CREDIT_NOTE', 2)
      ON CONFLICT ("tenantId", "companyId", "documentType")
      DO UPDATE SET "nextNumber" = "document_number_counter"."nextNumber" + 1
      RETURNING "nextNumber" - 1 AS allocated`;
    const n = rows[0]!.allocated;
    return `CN-${n.toString().padStart(6, '0')}`;
  }
}
