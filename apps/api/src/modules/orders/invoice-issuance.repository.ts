import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (task 3b.3 Checkpoint C, mirrors task
// 3b.1's `PostingEngineService` exactly): this is an internal primitive that
// must PARTICIPATE in a caller's already-open transaction, never open its
// own — so its public `issueFinalInvoice(tx: ScopedTx, ...)` contract
// requires this type directly. No raw Prisma model access happens here
// outside `tx.<model>`/`tx.$queryRaw` calls on the caller-supplied,
// already-scoped `tx`.
import type { ScopedTx } from '@flower/db';
import { Money } from '@flower/money';
import { Quantity } from '@flower/uom';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { SystemClock } from '../../common/clock/clock.js';
import { derivePostingDate } from '../accounting/posting-date.js';
import { computeCommercialSnapshotFingerprint } from './commercial-snapshot.js';

export interface FinalizedLineTax {
  orderLineId: string;
  priceTaxMode: string;
  roundingScope: string;
  roundingMode: string;
  lineTaxAmountMinor: bigint;
}

export interface FinalizedTotals {
  subtotalAmountMinor: bigint;
  documentDiscountAmountMinor: bigint;
  taxTotalAmountMinor: bigint;
  totalAmountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
}

export interface IssueFinalInvoiceInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  orderId: string;
  expectedVersion: number;
  commercialSnapshotFingerprint: string;
  lines: FinalizedLineTax[];
  totals: FinalizedTotals;
}

export interface IssueFinalInvoiceResult {
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
}

/**
 * Task 3b.3 Checkpoint C — the internal-only final-issuance primitive
 * (docs/phase-3/PHASE-3B-PLAN.md, owner Checkpoint C authorization). NOT
 * HTTP-exposed — no controller anywhere calls this. `issueFinalInvoice`
 * NEVER computes a tax amount or a rounding policy; the caller (Task 3b.4)
 * supplies the complete finalized per-line tax snapshot and document totals.
 * This primitive only VALIDATES structural consistency and PERSISTS the
 * supplied values atomically alongside `DRAFT -> CONFIRMED` + numbering.
 *
 * Participates in the CALLER's already-open `ScopedTx` — never opens or
 * commits its own transaction, mirroring `PostingEngineService.postJournal`
 * exactly. `issuedAt` comes from the injected `Clock`; `invoiceDate` is
 * derived from `Company.accountingTimezone` via the same proven
 * `derivePostingDate` helper Task 3b.1 and Task 3b.3 Checkpoint B both reuse
 * — never UTC, never Branch/POS/client.
 *
 * Write order inside the transaction matters: order_line finalized-tax
 * fields are written BEFORE the parent `order.orderNumber` is set, and the
 * `order` row is updated BEFORE the `invoice` row is inserted — the DB
 * trigger set (migration SQL) allows exactly this sequence and rejects any
 * other, so this method's statement order is not incidental.
 */
@Injectable()
export class InvoiceIssuanceRepository {
  constructor(
    private readonly audit: AuditWriter,
    // injected as a class token so a test can swap in a fake via `overrideProvider`.
    private readonly clock: SystemClock,
  ) {}

  async issueFinalInvoice(
    tx: ScopedTx,
    input: IssueFinalInvoiceInput,
  ): Promise<IssueFinalInvoiceResult> {
    // ── 1. lock + revalidate Order in exact tenant/company/branch scope ────
    const orderRows = await tx.$queryRaw<
      {
        id: string;
        tenantId: string;
        companyId: string;
        status: string;
        version: number;
        commercialSnapshotFingerprint: string;
        customerId: string | null;
        kind: string;
        currencyCode: string;
        currencyExponent: number;
        documentDiscountMode: string;
        documentDiscountBps: number | null;
        documentDiscountAmountMinor: bigint;
        documentDiscountReason: string | null;
        originBranchId: string;
        fulfillingBranchId: string;
      }[]
    >`
      SELECT "id", "tenantId", "companyId", "status", "version", "commercialSnapshotFingerprint",
             "customerId", "kind", "currencyCode", "currencyExponent", "documentDiscountMode",
             "documentDiscountBps", "documentDiscountAmountMinor", "documentDiscountReason",
             "originBranchId", "fulfillingBranchId"
        FROM "order"
       WHERE "id" = ${input.orderId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "originBranchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');

    if (order.status !== 'DRAFT') {
      throw new DomainError(
        'ORDER_INVALID_STATE_TRANSITION',
        `final issuance requires status DRAFT (currently ${order.status}) — a HELD order must resume first`,
        409,
      );
    }
    if (order.version !== input.expectedVersion) {
      throw new DomainError(
        'ORDER_VERSION_CONFLICT',
        `order changed elsewhere (expected version ${input.expectedVersion}, now ${order.version})`,
        409,
      );
    }

    // ── 2. company currency/exponent must still match the order's ──────────
    const companyRows = await tx.$queryRaw<
      { defaultCurrency: string | null; accountingTimezone: string | null }[]
    >`
      SELECT "defaultCurrency", "accountingTimezone" FROM "company"
       WHERE "id" = ${input.companyId}::uuid AND "tenantId" = ${input.tenantId}::uuid`;
    const company = companyRows[0];
    if (!company) throw new NotFoundError('company');
    if (!company.defaultCurrency || company.defaultCurrency !== order.currencyCode) {
      throw new DomainError(
        'ORDER_CURRENCY_MISMATCH',
        "the company's current default currency no longer matches the order's currency",
        409,
      );
    }
    if (!company.accountingTimezone) {
      throw new DomainError(
        'ORDER_COMPANY_ACCOUNTING_TIMEZONE_NOT_CONFIGURED',
        'this company has no accounting timezone configured',
        409,
      );
    }

    // ── 3. lock + read every OrderLine (ORDER BY linePosition ASC — §1) — at
    //      least one must exist, and the supplied finalized tax snapshot must
    //      cover EXACTLY that set. lock the lines FOR UPDATE first (raw —
    //      Prisma has no `.findMany(... FOR UPDATE)`), then read the typed
    //      columns via the ORM against the same already-locked rows within
    //      this same transaction. ─────────────────────────────────────────
    await tx.$queryRaw`SELECT "id" FROM "order_line" WHERE "orderId" = ${order.id}::uuid FOR UPDATE`;
    const lineRows = await tx.orderLine.findMany({
      where: { orderId: order.id },
      orderBy: { linePosition: 'asc' },
      select: {
        id: true,
        productId: true,
        variantId: true,
        quantity: true,
        selectedUomCode: true,
        baseUomCode: true,
        conversionNumerator: true,
        conversionDenominator: true,
        unitPriceAmountMinor: true,
        unitPriceCurrencyCode: true,
        unitPriceCurrencyExponent: true,
        discountMode: true,
        discountBps: true,
        discountAmountMinor: true,
        taxCategoryKey: true,
        rateBps: true,
        effectiveFrom: true,
        resolutionSource: true,
      },
    });
    if (lineRows.length < 1) {
      throw new DomainError('ORDER_HAS_NO_LINES', 'an order with zero lines cannot be issued', 409);
    }

    // ── 3a. AUTHORITATIVE FINGERPRINT RECOMPUTATION (Checkpoint C
    //       final-integrity pass) — comparing the caller-supplied fingerprint
    //       against the Order's OWN stored `commercialSnapshotFingerprint`
    //       column is not sufficient: it never proves that column still
    //       matches the CURRENT persisted Order + OrderLine rows a
    //       raw-SQL/application-bug write could have changed without
    //       recomputing it. Reconstruct the canonical snapshot from the
    //       LOCKED, persisted state — reusing the ONE shared
    //       `computeCommercialSnapshotFingerprint` builder, never a second
    //       hashing implementation — and require it to match BOTH the
    //       stored column AND the caller's expectation. Finalized tax fields
    //       (`priceTaxMode`/`roundingScope`/`roundingMode`/
    //       `lineTaxAmountMinor`, Task 3b.4-owned) are deliberately excluded
    //       — they were never part of the frozen fingerprint contract
    //       (`commercial-snapshot.ts`) and do not exist yet at this point in
    //       the transaction (written in step 7, below).
    const recomputedFingerprint = computeCommercialSnapshotFingerprint({
      tenantId: order.tenantId,
      companyId: order.companyId,
      originBranchId: order.originBranchId,
      fulfillingBranchId: order.fulfillingBranchId,
      customerId: order.customerId,
      kind: order.kind,
      currencyCode: order.currencyCode,
      lines: lineRows.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        quantity: l.quantity.toFixed(4),
        selectedUomCode: l.selectedUomCode,
        baseUomCode: l.baseUomCode,
        conversionNumerator: l.conversionNumerator.toString(),
        conversionDenominator: l.conversionDenominator.toString(),
        unitPriceAmountMinor: l.unitPriceAmountMinor.toString(),
        unitPriceCurrencyCode: l.unitPriceCurrencyCode,
        unitPriceCurrencyExponent: l.unitPriceCurrencyExponent,
        discountMode: l.discountMode,
        discountBps: l.discountBps,
        discountAmountMinor: l.discountAmountMinor.toString(),
        taxCategoryKey: l.taxCategoryKey,
        rateBps: l.rateBps,
        effectiveFrom: l.effectiveFrom ? l.effectiveFrom.toISOString().slice(0, 10) : null,
        resolutionSource: l.resolutionSource,
      })),
      documentDiscountMode: order.documentDiscountMode,
      documentDiscountBps: order.documentDiscountBps,
      documentDiscountAmountMinor: order.documentDiscountAmountMinor.toString(),
      documentDiscountReason: order.documentDiscountReason,
    });
    if (
      recomputedFingerprint !== order.commercialSnapshotFingerprint ||
      recomputedFingerprint !== input.commercialSnapshotFingerprint
    ) {
      throw new DomainError(
        'ORDER_FINGERPRINT_MISMATCH',
        "the order's recomputed commercial snapshot does not match its stored fingerprint and/or the caller-supplied fingerprint",
        409,
      );
    }

    const lineIds = new Set(lineRows.map((l) => l.id));
    const suppliedIds = new Set(input.lines.map((l) => l.orderLineId));
    if (lineIds.size !== suppliedIds.size || [...lineIds].some((id) => !suppliedIds.has(id))) {
      throw new DomainError(
        'ORDER_LINE_TAX_SNAPSHOT_INCOMPLETE',
        "the supplied finalized tax snapshot does not cover exactly the order's current line set",
        422,
      );
    }
    for (const l of input.lines) {
      if (
        l.priceTaxMode === null ||
        l.priceTaxMode === undefined ||
        l.roundingScope === null ||
        l.roundingScope === undefined ||
        l.roundingMode === null ||
        l.roundingMode === undefined ||
        l.lineTaxAmountMinor === null ||
        l.lineTaxAmountMinor === undefined ||
        l.lineTaxAmountMinor < 0n
      ) {
        throw new DomainError(
          'ORDER_LINE_TAX_SNAPSHOT_INCOMPLETE',
          `order line ${l.orderLineId} has an incomplete mandatory finalized tax snapshot`,
          422,
        );
      }
    }

    // ── 4. structural (policy-independent) totals validation — never
    //      re-derives a tax amount, only checks internal consistency ──────
    if (
      input.totals.currencyCode !== order.currencyCode ||
      input.totals.currencyExponent !== order.currencyExponent
    ) {
      throw new DomainError(
        'ORDER_FINALIZED_TOTALS_INVALID',
        'finalized totals currency/exponent must match the order',
        422,
      );
    }
    if (input.totals.documentDiscountAmountMinor !== order.documentDiscountAmountMinor) {
      throw new DomainError(
        'ORDER_FINALIZED_TOTALS_INVALID',
        "finalized documentDiscountAmountMinor must equal the order's own frozen snapshot",
        422,
      );
    }
    const recomputedSubtotal = lineRows.reduce((acc, l) => {
      const gross = Money.ofMinor(l.unitPriceAmountMinor, l.unitPriceCurrencyCode).mulRatio(
        Quantity.parse(l.quantity.toFixed(4)).scaled,
        10_000n,
      );
      return acc.add(gross.subtract(Money.ofMinor(l.discountAmountMinor, l.unitPriceCurrencyCode)));
    }, Money.zero(order.currencyCode));
    if (recomputedSubtotal.amountMinor !== input.totals.subtotalAmountMinor) {
      throw new DomainError(
        'ORDER_FINALIZED_TOTALS_INVALID',
        'finalized subtotal does not match the sum of order_line net amounts',
        422,
      );
    }
    const suppliedTaxSum = input.lines.reduce((acc, l) => acc + l.lineTaxAmountMinor, 0n);
    if (suppliedTaxSum !== input.totals.taxTotalAmountMinor) {
      throw new DomainError(
        'ORDER_FINALIZED_TOTALS_INVALID',
        'finalized taxTotalAmountMinor does not match the sum of supplied line tax amounts',
        422,
      );
    }
    const expectedTotal =
      input.totals.subtotalAmountMinor -
      input.totals.documentDiscountAmountMinor +
      input.totals.taxTotalAmountMinor;
    if (expectedTotal !== input.totals.totalAmountMinor) {
      throw new DomainError(
        'ORDER_FINALIZED_TOTALS_INVALID',
        'finalized totalAmountMinor != subtotal - documentDiscount + taxTotal',
        422,
      );
    }

    // ── 5. no Invoice may already exist for this order (defense-in-depth —
    //      the unique index on invoice.orderId is the ultimate guarantee) ──
    const existingInvoice = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "invoice" WHERE "orderId" = ${order.id}::uuid`;
    if (existingInvoice[0]) {
      throw new DomainError(
        'INVOICE_ALREADY_EXISTS',
        'an invoice already exists for this order',
        409,
      );
    }

    // ── 6. customer display-name snapshot — server-derived, never accepted
    //      from a caller; name only, never phone/email ─────────────────────
    let customerDisplayNameSnapshot: string | null = null;
    if (order.customerId) {
      const custRows = await tx.$queryRaw<{ displayName: string }[]>`
        SELECT "displayName" FROM "customer" WHERE "id" = ${order.customerId}::uuid AND "tenantId" = ${input.tenantId}::uuid`;
      customerDisplayNameSnapshot = custRows[0]?.displayName ?? null;
    }

    // ── 7. write each line's finalized tax snapshot FIRST (order.orderNumber
    //      is still NULL at this point — the freeze trigger does not fire) ─
    for (const l of input.lines) {
      await tx.orderLine.update({
        where: { id: l.orderLineId },
        data: {
          priceTaxMode: l.priceTaxMode,
          roundingScope: l.roundingScope,
          roundingMode: l.roundingMode,
          lineTaxAmountMinor: l.lineTaxAmountMinor,
        },
      });
    }

    // ── 8. allocate the two independent company-scoped gapless numbers ─────
    const orderNumber = await this.allocateNumber(
      tx,
      input.tenantId,
      input.companyId,
      'ORDER',
      'ORD',
    );
    const invoiceNumber = await this.allocateNumber(
      tx,
      input.tenantId,
      input.companyId,
      'INVOICE',
      'INV',
    );

    // ── 9. the one-time issuance transition on Order (trigger-validated) ───
    await tx.order.update({
      where: { id: order.id },
      data: {
        orderNumber,
        status: 'CONFIRMED',
        version: { increment: 1 },
      },
    });

    // ── 10. insert the immutable Invoice (tax-completeness trigger fires) ──
    const issuedAt = this.clock.now();
    // `derivePostingDate` returns a plain "YYYY-MM-DD" string (task 3b.1's
    // `postingDate` writes this via a raw `::date`-cast query; the Prisma ORM
    // `@db.Date` field here needs an actual `Date` — midnight UTC on that
    // civil date, never re-derived through any timezone).
    const invoiceDate = new Date(
      `${derivePostingDate(issuedAt, company.accountingTimezone)}T00:00:00.000Z`,
    );
    const invoice = await tx.invoice.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: order.originBranchId,
        orderId: order.id,
        invoiceNumber,
        issuedAt,
        invoiceDate,
        customerDisplayNameSnapshot,
        currencyCode: order.currencyCode,
        currencyExponent: order.currencyExponent,
        subtotalAmountMinor: input.totals.subtotalAmountMinor,
        documentDiscountAmountMinor: input.totals.documentDiscountAmountMinor,
        taxTotalAmountMinor: input.totals.taxTotalAmountMinor,
        totalAmountMinor: input.totals.totalAmountMinor,
      },
    });

    // ── 11. bounded audit, inside the same transaction ──────────────────────
    await this.audit.record(tx, {
      action: 'order.confirmed',
      resourceType: 'order',
      resourceId: order.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: order.originBranchId,
      after: { orderNumber, status: 'CONFIRMED' },
    });
    await this.audit.record(tx, {
      action: 'invoice.issued',
      resourceType: 'invoice',
      resourceId: invoice.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: order.originBranchId,
      after: { orderId: order.id, invoiceNumber },
    });

    return { orderId: order.id, orderNumber, invoiceId: invoice.id, invoiceNumber };
  }

  /**
   * `document_number_counter` allocator (§5) — `INSERT ... ON CONFLICT DO
   * UPDATE ... RETURNING`, never a Postgres `SEQUENCE`, never `MAX()+1`;
   * increments inside the CALLER's transaction, so a rolled-back issuance
   * rolls the increment back with it (true gaplessness under rollback).
   * Format `PREFIX-NNNNNN`, minimum 6-digit zero padding, no artificial
   * upper bound (`padStart` never truncates).
   */
  private async allocateNumber(
    tx: ScopedTx,
    tenantId: string,
    companyId: string,
    documentType: 'ORDER' | 'INVOICE',
    prefix: string,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ allocated: bigint }[]>`
      INSERT INTO "document_number_counter" ("tenantId", "companyId", "documentType", "nextNumber")
      VALUES (${tenantId}::uuid, ${companyId}::uuid, ${documentType}, 2)
      ON CONFLICT ("tenantId", "companyId", "documentType")
      DO UPDATE SET "nextNumber" = "document_number_counter"."nextNumber" + 1
      RETURNING "nextNumber" - 1 AS allocated`;
    const n = rows[0]!.allocated;
    return `${prefix}-${n.toString().padStart(6, '0')}`;
  }
}
