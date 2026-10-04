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
import { computeCommercialSnapshotFingerprintByVersion } from './commercial-snapshot.js';
import { CustomerInvoiceArRepository } from '../receivables/customer-invoice-ar.repository.js';
import type { AuthorizedCreditOverride } from '../receivables/credit-override-authorization.service.js';
import type { PaymentIntent } from '../receivables/payment-intent.js';

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
  /**
   * Task 3b.6 Checkpoint C — required for every issuance, no default, no
   * inference from payment presence/absence (CREDIT is not, and never
   * becomes, a tender). Gates ONLY whether the credit-limit hard gate runs at
   * issuance for a customer-linked Order — it never gates AR creation itself
   * (both intents create AR for a customer-linked Invoice; see
   * `receivables/payment-intent.ts`). For a walk-in Order (no `customerId`)
   * this value is structurally inert — no 3b.6 AR/GL path is ever entered —
   * but is still required, so a caller can never omit an explicit choice.
   */
  paymentIntent: PaymentIntent;
  /**
   * Task 3b.6 Checkpoint C — an OPTIONAL, structurally-opaque, pre-authorized
   * one-sale credit-limit override. Only ever meaningful when
   * `paymentIntent = 'ON_CREDIT'` AND the credit-limit gate would otherwise
   * deny the sale. Producible ONLY by
   * `CreditOverrideAuthorizationService.authorize` (permission + step-up +
   * reason already verified there) — never a raw boolean, never constructible
   * by this primitive's caller directly.
   */
  creditOverride?: AuthorizedCreditOverride;
  // 3b.9-credit-exposure:begin
  /**
   * Task 3b.9 (owner ruling: the credit limit applies to the RESULTING receivable exposure, not the
   * gross invoice total, for atomic customer sales) — an OPTIONAL, INTERNAL, TRUSTED amount: the
   * receivable exposure this sale will actually ADD (invoice total − same-sale tenders − same-sale
   * advances). When present, the credit-limit gate evaluates it INSTEAD of the invoice total; when
   * omitted (every other caller) the gate keeps the frozen invoice-total basis, unchanged. It only
   * changes the gate's basis — the receivable is still booked for the FULL invoice total.
   *
   * It is computed by the 3b.9 atomic-sale orchestrator, which then PROVES the committed receivable
   * equals it (and rolls the whole sale back otherwise). It is not on any DTO and must never be
   * derived from a request; it must be 0 ≤ value ≤ the invoice total.
   */
  finalSaleOutstandingMinor?: bigint;
  // 3b.9-credit-exposure:end
  actorUserId?: string | null;
}

export interface IssueFinalInvoiceResult {
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  /** null for a walk-in (no-customer) Invoice — no 3b.6 AR was ever created. */
  customerReceivableId: string | null;
  /** null for a walk-in Invoice, or for PAY_NOW (the credit gate never ran). */
  creditAuthorizationMode: 'NORMAL' | 'OVERRIDE' | null;
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
 *
 * Task 3b.6 Checkpoint C — for a customer-linked Order, the credit-limit hard
 * gate runs (via `CustomerInvoiceArRepository.lockAndAuthorizeCredit`) BEFORE
 * document-number allocation / the Order's DRAFT->CONFIRMED transition, so a
 * denied credit sale burns no gapless number and mutates nothing; the
 * CustomerReceivable/CustomerAccountEntry/projection/journal/audit are then
 * written AFTER the Invoice row exists (they reference `invoiceId`), still
 * inside this SAME transaction — a rollback anywhere undoes all of it
 * atomically. A walk-in Order (`customerId === null`) never enters any of
 * this — zero 3b.6 rows, zero 3b.6 journal (3b.9 owns walk-in accounting).
 */
@Injectable()
export class InvoiceIssuanceRepository {
  constructor(
    private readonly audit: AuditWriter,
    // injected as a class token so a test can swap in a fake via `overrideProvider`.
    private readonly clock: SystemClock,
    private readonly customerInvoiceAr: CustomerInvoiceArRepository,
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
        commercialSnapshotFingerprintVersion: number;
        taxPriceMode: string;
        taxRoundingScope: string;
        taxRoundingMode: string;
      }[]
    >`
      SELECT "id", "tenantId", "companyId", "status", "version", "commercialSnapshotFingerprint",
             "customerId", "kind", "currencyCode", "currencyExponent", "documentDiscountMode",
             "documentDiscountBps", "documentDiscountAmountMinor", "documentDiscountReason",
             "originBranchId", "fulfillingBranchId", "commercialSnapshotFingerprintVersion",
             "taxPriceMode", "taxRoundingScope", "taxRoundingMode"
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
    //       LOCKED, persisted state — reusing the ONE shared version-dispatch
    //       helper (`computeCommercialSnapshotFingerprintByVersion`, Task
    //       3b.4 §C9), dispatching on the Order's OWN persisted
    //       `commercialSnapshotFingerprintVersion` — never a second hashing
    //       implementation, never assuming the latest version — and require
    //       it to match BOTH the stored column AND the caller's expectation.
    //       Finalized tax fields (`priceTaxMode`/`roundingScope`/
    //       `roundingMode`/`lineTaxAmountMinor` on OrderLine, Task 3b.4-owned)
    //       are deliberately excluded — they were never part of the frozen
    //       fingerprint contract (`commercial-snapshot.ts`) and do not exist
    //       yet at this point in the transaction (written in step 7, below).
    const recomputedFingerprint = computeCommercialSnapshotFingerprintByVersion(
      order.commercialSnapshotFingerprintVersion,
      {
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
      },
      {
        taxPriceMode: order.taxPriceMode,
        taxRoundingScope: order.taxRoundingScope,
        taxRoundingMode: order.taxRoundingMode,
      },
    );
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
    // Checkpoint E adversarial finding (§E15): a `Set`-only comparison is
    // insufficient — a malicious caller could supply a DUPLICATE entry for
    // one real line (inflating `input.lines.length` beyond the real line
    // count) while still covering every real id, which `suppliedIds.size`
    // alone cannot detect (`Set` silently dedupes). Comparing the RAW array
    // length against the real line count closes that gap; the existing
    // `Set`-based checks remain for the "wrong id" / "missing id" cases.
    if (
      input.lines.length !== lineIds.size ||
      lineIds.size !== suppliedIds.size ||
      [...lineIds].some((id) => !suppliedIds.has(id))
    ) {
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

    // ── 3b. POLICY-UNIFORMITY HARD GATE (Task 3b.4 Checkpoint D, §D12-A) —
    //       every supplied line's policy fields must equal the Order's OWN
    //       frozen, immutable fiscal policy (Task 3b.4 Checkpoint C). The
    //       Order's policy is document-wide and set once at creation; no
    //       per-line override, no normalization, no silent correction —
    //       fails BEFORE any tax-field write, number allocation, Invoice, or
    //       audit. ─────────────────────────────────────────────────────────
    for (const l of input.lines) {
      if (
        l.priceTaxMode !== order.taxPriceMode ||
        l.roundingScope !== order.taxRoundingScope ||
        l.roundingMode !== order.taxRoundingMode
      ) {
        throw new DomainError(
          'ORDER_LINE_TAX_POLICY_MISMATCH',
          `order line ${l.orderLineId}'s finalized tax policy does not match the order's own frozen fiscal policy`,
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
    // Task 3b.4 Checkpoint D (§D12-B) — mode-conditional expected total,
    // replacing the pre-3b.4 EXCLUSIVE-only placeholder. TAX_INCLUSIVE tax is
    // already contained within `subtotalAmountMinor` (each line's commercial
    // amount is the tax-inclusive amount tax was EXTRACTED from) — adding
    // `taxTotalAmountMinor` again would double-count it. The Order's own
    // frozen `taxPriceMode` (Task 3b.4 Checkpoint C) is authoritative; this
    // primitive never computes a tax amount itself, only validates the
    // caller-supplied totals are internally consistent with it.
    const expectedTotal =
      order.taxPriceMode === 'TAX_INCLUSIVE'
        ? input.totals.subtotalAmountMinor - input.totals.documentDiscountAmountMinor
        : input.totals.subtotalAmountMinor -
          input.totals.documentDiscountAmountMinor +
          input.totals.taxTotalAmountMinor;
    if (expectedTotal !== input.totals.totalAmountMinor) {
      throw new DomainError(
        'ORDER_FINALIZED_TOTALS_INVALID',
        order.taxPriceMode === 'TAX_INCLUSIVE'
          ? 'finalized totalAmountMinor != subtotal - documentDiscount (TAX_INCLUSIVE — tax is already contained in the subtotal)'
          : 'finalized totalAmountMinor != subtotal - documentDiscount + taxTotal',
        422,
      );
    }

    // ── 4a. customer-linked credit-limit hard gate (Task 3b.6 Checkpoint C) —
    //       runs on the now-STRUCTURALLY-VALIDATED `input.totals.totalAmountMinor`
    //       (never the raw, unverified caller value) and BEFORE document-number
    //       allocation / the Order's DRAFT->CONFIRMED transition, so a denied
    //       credit sale burns no gapless number. Walk-in (`customerId === null`)
    //       skips this entirely — `creditResult` stays `null`, and every
    //       downstream 3b.6 branch below is gated on that same null check. ──
    // 3b.9-credit-exposure:begin
    const finalSaleOutstandingMinor =
      input.finalSaleOutstandingMinor ?? input.totals.totalAmountMinor;
    if (
      input.finalSaleOutstandingMinor !== undefined &&
      (typeof input.finalSaleOutstandingMinor !== 'bigint' ||
        input.finalSaleOutstandingMinor < 0n ||
        input.finalSaleOutstandingMinor > input.totals.totalAmountMinor)
    ) {
      throw new DomainError(
        'ORDER_CREDIT_EXPOSURE_INVALID',
        'the credit exposure must be an exact amount between 0 and the invoice total',
        422,
      );
    }
    // 3b.9-credit-exposure:end
    const creditResult = order.customerId
      ? await this.customerInvoiceAr.lockAndAuthorizeCredit(tx, {
          tenantId: input.tenantId,
          companyId: input.companyId,
          customerId: order.customerId,
          paymentIntent: input.paymentIntent,
          proposedAmountMinor: finalSaleOutstandingMinor,
          ...(input.creditOverride !== undefined ? { creditOverride: input.creditOverride } : {}),
        })
      : null;

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

    // ── 12. customer-linked AR: CustomerReceivable + CustomerAccountEntry +
    //       outstanding projection + invoice_ar journal + audit (Task 3b.6
    //       Checkpoint C) — `creditResult` is null for a walk-in Order, so
    //       this entire block (and its GL journal) never runs for one. ──────
    let customerReceivableId: string | null = null;
    let creditAuthorizationMode: 'NORMAL' | 'OVERRIDE' | null = null;
    if (creditResult) {
      const receivable = await this.customerInvoiceAr.createReceivableForInvoice(tx, {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: order.originBranchId,
        customerCompanyAccountId: creditResult.account.id,
        invoiceId: invoice.id,
        totalAmountMinor: input.totals.totalAmountMinor,
        taxTotalAmountMinor: input.totals.taxTotalAmountMinor,
        currencyCode: order.currencyCode,
        currencyExponent: order.currencyExponent,
        creditAuthorized: creditResult.creditAuthorized,
        authorizationMode: creditResult.authorizationMode,
        ...(input.creditOverride !== undefined ? { creditOverride: input.creditOverride } : {}),
        actorUserId: input.actorUserId ?? null,
      });
      customerReceivableId = receivable.customerReceivableId;
      creditAuthorizationMode = creditResult.authorizationMode;
    }

    return {
      orderId: order.id,
      orderNumber,
      invoiceId: invoice.id,
      invoiceNumber,
      customerReceivableId,
      creditAuthorizationMode,
    };
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
