import { Injectable } from '@nestjs/common';
import { Quantity } from '@flower/uom';
import type { ScopedTx } from '@flower/db';
import { ScopedRepository } from '../../common/data/index.js';
import { DbService } from '../../common/data/index.js';
import { requireTenantContext, getContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { SystemClock } from '../../common/clock/clock.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { derivePostingDate } from '../accounting/posting-date.js';
import {
  ANONYMOUS_CREDIT_NOTE_SOURCE_KIND,
  ANONYMOUS_REFUND_EXECUTION_SOURCE_KIND,
  assertWithinTenderCaps,
  executionJournalLines,
  issuanceJournalLines,
  planAnonymousCreditNote,
  validateInitialRefunds,
  type FailureReasonCode,
  type FrozenOrderLine,
  type PriorLineCredit,
  type ReasonCode,
  type RefundMethod,
  type RequestedCreditLine,
} from './anonymous-credit-note-plan.js';

/**
 * Phase 3B closure — RB-1 A2: persistence + the single atomic transaction of the anonymous credit note.
 *
 * LOCK ORDER (the frozen hierarchy, 3b.8 F4): the ORDER row first, then the INVOICE row, then the order lines, then the company
 * document counter. Every database guard of migration `20261105120000` takes the invoice lock first, so concurrent credits and
 * refunds of one invoice serialise; the application re-checks everything UNDER those locks and the database re-proves it
 * independently (cumulative quantity / discount / tax / total per line and invoice; per-tender refund caps; anonymous orders only).
 *
 * Nothing here updates an invoice, an order, a payment or any earlier journal: a reversed sale is identified by these records only
 * (owner decision 3). Money columns are `bigint` minor units; the API layer renders them as strings.
 */

export interface IssueCommand {
  readonly companyId: string;
  readonly branchId: string;
  readonly invoiceId: string;
  readonly reasonCode: ReasonCode;
  readonly note: string | null;
  readonly lines: readonly RequestedCreditLine[];
  readonly refunds: readonly {
    method: RefundMethod;
    amountMinor: bigint;
    reference: string | null;
  }[];
}

export interface RefundView {
  readonly id: string;
  readonly method: string;
  readonly amountMinor: string;
  readonly status: string;
  readonly reference: string | null;
  readonly failureReasonCode: string | null;
  readonly requestedByUserId: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedByUserId: string | null;
}

export interface CreditNoteView {
  readonly id: string;
  readonly creditNoteNumber: string;
  readonly invoiceId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly issuedAt: string;
  readonly accountingDate: string;
  readonly currencyCode: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly subtotalAmountMinor: string;
  readonly taxTotalAmountMinor: string;
  readonly totalAmountMinor: string;
  readonly createdByUserId: string | null;
  readonly lines: readonly {
    orderLineId: string;
    quantityCredited: string;
    grossCreditedMinor: string;
    discountCreditedMinor: string;
    documentDiscountShareCreditedMinor: string;
    netAfterDocumentDiscountCreditedMinor: string;
    taxCreditedMinor: string;
    lineTotalCreditedMinor: string;
  }[];
  readonly refunds: readonly RefundView[];
  /** refund progress — a refund counts as EXECUTED only after its tender execution was attested */
  readonly refundSummary: {
    readonly pendingMinor: string;
    readonly executedMinor: string;
    readonly failedMinor: string;
    /** credit total − pending − executed: the amount that still needs a (replacement) refund line */
    readonly unallocatedMinor: string;
  };
  /** the sale's reversal state, derived from the credit records (the order and invoice rows are never changed) */
  readonly invoiceReversal: {
    readonly status: 'NONE' | 'PARTIAL' | 'FULL';
    readonly creditedTotalMinor: string;
    readonly invoiceTotalMinor: string;
  };
}

interface InvoiceRow {
  id: string;
  orderId: string;
  totalAmountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  customerId: string | null;
  documentDiscountAmountMinor: bigint;
}

const attesterRequired = (): DomainError =>
  new DomainError(
    'ATTESTER_REQUIRED',
    'an authenticated user is required to attest a refund outcome',
    403,
  );

@Injectable()
export class AnonymousCreditNoteRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly postingEngine: PostingEngineService,
    private readonly companyConfig: CompanyFinancialConfigRepository,
    private readonly audit: AuditWriter,
    private readonly clock: SystemClock,
  ) {
    super(db);
  }

  // ───────────────────────── issue ─────────────────────────

  issue(cmd: IssueCommand): Promise<CreditNoteView> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped(async (tx) => {
      const invoice = await this.lockInvoice(tx, tenantId, cmd);
      if (invoice.customerId !== null) {
        throw new DomainError(
          'ANONYMOUS_CREDIT_NOTE_CUSTOMER_LINKED',
          'this invoice belongs to a customer-linked order; use the credit-note path for customers',
          422,
        );
      }
      const { paidByMethod, paidTotal, usedByMethod } = await this.loadTenderSums(tx, invoice.id);
      if (paidTotal !== invoice.totalAmountMinor) {
        throw new DomainError(
          'INVOICE_NOT_FULLY_PAID',
          'only a fully paid sale can be credited',
          422,
        );
      }

      const orderLines = await this.loadOrderLines(tx, invoice.orderId);
      const prior = await this.loadPrior(tx, invoice.id);
      const plan = planAnonymousCreditNote({
        currencyCode: invoice.currencyCode,
        orderDocumentDiscountMinor: invoice.documentDiscountAmountMinor,
        orderLines,
        priorByLine: prior,
        requested: cmd.lines,
      });
      validateInitialRefunds({
        totalAmountMinor: plan.totalAmountMinor,
        refunds: cmd.refunds,
        paidByMethod,
        usedByMethod,
      });

      const config = await this.companyConfig.lockForPosting(tx, cmd.companyId);
      // ONE time source: every timestamp of this transaction (the posting date, `issuedAt`, the refund lines' `createdAt`) is the
      // application's accounting clock, never the database clock, so a document's dates and its journal's posting date can never disagree
      const at = this.clock.now();
      const accountingDate = derivePostingDate(at, config.accountingTimezone);
      const creditNoteNumber = await this.allocateNumber(tx, tenantId, cmd.companyId);

      const noteRows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "anonymous_credit_note"
          ("tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent",
           "reasonCode","note","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","createdByUserId","createdAt")
        VALUES (${tenantId}::uuid, ${cmd.companyId}::uuid, ${cmd.branchId}::uuid, ${invoice.id}::uuid, ${creditNoteNumber}, ${at}::timestamptz,
                ${accountingDate}::date, ${invoice.currencyCode}, ${invoice.currencyExponent}::smallint,
                ${cmd.reasonCode}, ${cmd.note}, ${plan.subtotalAmountMinor}, ${plan.taxTotalAmountMinor}, ${plan.totalAmountMinor},
                ${actorUserId}::uuid, ${at}::timestamptz)
        RETURNING "id"`;
      const noteId = noteRows[0]!.id;

      for (const l of plan.lines) {
        await tx.$executeRaw`
          INSERT INTO "anonymous_credit_note_line"
            ("tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor",
             "documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor",
             "currencyCode","currencyExponent","createdAt")
          VALUES (${tenantId}::uuid, ${cmd.companyId}::uuid, ${noteId}::uuid, ${l.orderLineId}::uuid, ${l.quantityCredited}::numeric,
                  ${l.grossCreditedMinor}, ${l.discountCreditedMinor}, ${l.documentDiscountShareCreditedMinor},
                  ${l.netAfterDocumentDiscountCreditedMinor}, ${l.taxCreditedMinor}, ${l.lineTotalCreditedMinor},
                  ${invoice.currencyCode}, ${invoice.currencyExponent}::smallint, ${at}::timestamptz)`;
      }
      for (const r of cmd.refunds) {
        await this.insertRefund(tx, {
          at,
          tenantId,
          companyId: cmd.companyId,
          branchId: cmd.branchId,
          creditNoteId: noteId,
          invoiceId: invoice.id,
          method: r.method,
          amountMinor: r.amountMinor,
          reference: r.reference,
          currencyCode: invoice.currencyCode,
          currencyExponent: invoice.currencyExponent,
          actorUserId,
        });
      }

      // ONE balanced entry: revenue + tax reversed, the refund booked in flight on PAYMENT_CLEARING (see the plan's doc comment)
      await this.postingEngine.postJournal(tx, {
        tenantId,
        companyId: cmd.companyId,
        branchId: cmd.branchId,
        sourceKind: ANONYMOUS_CREDIT_NOTE_SOURCE_KIND,
        sourceId: noteId,
        accountingDate,
        ...(actorUserId ? { createdByUserId: actorUserId } : {}),
        lines: issuanceJournalLines(plan.totalAmountMinor, plan.taxTotalAmountMinor).map((l) => ({
          ...l,
        })),
      });

      await this.audit.record(tx, {
        action: 'anonymous_credit_note.issued',
        resourceType: 'anonymous_credit_note',
        resourceId: noteId,
        tenantId,
        companyId: cmd.companyId,
        branchId: cmd.branchId,
        after: {
          creditNoteNumber,
          invoiceId: invoice.id,
          reasonCode: cmd.reasonCode,
          totalAmountMinor: plan.totalAmountMinor.toString(),
          taxTotalAmountMinor: plan.taxTotalAmountMinor.toString(),
          currencyCode: invoice.currencyCode,
          lineCount: plan.lines.length,
          refundCount: cmd.refunds.length,
        },
      });
      return this.loadView(tx, noteId);
    });
  }

  // ───────────────────────── add a (replacement) refund line ─────────────────────────

  addRefund(cmd: {
    companyId: string;
    branchId: string;
    creditNoteId: string;
    method: RefundMethod;
    amountMinor: bigint;
    reference: string | null;
  }): Promise<CreditNoteView> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped(async (tx) => {
      const note = await this.loadNoteHeader(tx, tenantId, cmd);
      await this.lockInvoice(tx, tenantId, { ...cmd, invoiceId: note.invoiceId });
      const { paidByMethod, usedByMethod } = await this.loadTenderSums(tx, note.invoiceId);
      assertWithinTenderCaps({
        refunds: [{ method: cmd.method, amountMinor: cmd.amountMinor }],
        paidByMethod,
        usedByMethod,
      });
      const open = await this.nonFailedRefundTotal(tx, cmd.creditNoteId);
      if (open + cmd.amountMinor > note.totalAmountMinor) {
        throw new DomainError(
          'REFUND_EXCEEDS_CREDIT',
          'the refund lines would exceed the credit note total',
          422,
        );
      }
      const refundId = await this.insertRefund(tx, {
        at: this.clock.now(),
        tenantId,
        companyId: cmd.companyId,
        branchId: cmd.branchId,
        creditNoteId: cmd.creditNoteId,
        invoiceId: note.invoiceId,
        method: cmd.method,
        amountMinor: cmd.amountMinor,
        reference: cmd.reference,
        currencyCode: note.currencyCode,
        currencyExponent: note.currencyExponent,
        actorUserId,
      });
      await this.audit.record(tx, {
        action: 'anonymous_credit_note.refund_added',
        resourceType: 'anonymous_credit_note_refund',
        resourceId: refundId,
        tenantId,
        companyId: cmd.companyId,
        branchId: cmd.branchId,
        after: {
          creditNoteId: cmd.creditNoteId,
          method: cmd.method,
          amountMinor: cmd.amountMinor.toString(),
        },
      });
      return this.loadView(tx, cmd.creditNoteId);
    });
  }

  // ───────────────────────── attest the outcome of a refund ─────────────────────────

  /** the tender execution was verified by a user: PENDING → EXECUTED, and cash / bank move out of the in-flight account */
  executeRefund(cmd: {
    companyId: string;
    branchId: string;
    creditNoteId: string;
    refundId: string;
    reference: string | null;
  }): Promise<CreditNoteView> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    // an outcome is always ATTRIBUTED (the database enforces it too): the attestation is the evidence for a manual card / other refund
    if (actorUserId === null) throw attesterRequired();
    return this.scoped(async (tx) => {
      const note = await this.loadNoteHeader(tx, tenantId, cmd);
      await this.lockInvoice(tx, tenantId, { ...cmd, invoiceId: note.invoiceId });
      const refund = await this.lockPendingRefund(tx, tenantId, cmd);
      const config = await this.companyConfig.lockForPosting(tx, cmd.companyId);
      const at = this.clock.now(); // ONE time source: the attestation time and the journal's posting date derive from the same instant
      const accountingDate = derivePostingDate(at, config.accountingTimezone);
      await tx.$executeRaw`
        UPDATE "anonymous_credit_note_refund"
           SET "status" = 'EXECUTED', "resolvedAt" = ${at}::timestamptz, "resolvedByUserId" = ${actorUserId}::uuid,
               "reference" = COALESCE(${cmd.reference}, "reference"), "updatedAt" = ${at}::timestamptz
         WHERE "id" = ${cmd.refundId}::uuid AND "status" = 'PENDING'`;
      const journal = executionJournalLines(refund.method as RefundMethod, refund.amountMinor);
      if (journal !== null) {
        await this.postingEngine.postJournal(tx, {
          tenantId,
          companyId: cmd.companyId,
          branchId: cmd.branchId,
          sourceKind: ANONYMOUS_REFUND_EXECUTION_SOURCE_KIND,
          sourceId: cmd.refundId,
          accountingDate,
          ...(actorUserId ? { createdByUserId: actorUserId } : {}),
          lines: journal.map((l) => ({ ...l })),
        });
      }
      await this.audit.record(tx, {
        action: 'anonymous_credit_note.refund_executed',
        resourceType: 'anonymous_credit_note_refund',
        resourceId: cmd.refundId,
        tenantId,
        companyId: cmd.companyId,
        branchId: cmd.branchId,
        after: {
          creditNoteId: cmd.creditNoteId,
          method: refund.method,
          amountMinor: refund.amountMinor.toString(),
          journalPosted: journal !== null,
        },
      });
      return this.loadView(tx, cmd.creditNoteId);
    });
  }

  /** the tender execution FAILED (declined, no cash, rejected): PENDING → FAILED, no posting; the amount needs a replacement refund line */
  failRefund(cmd: {
    companyId: string;
    branchId: string;
    creditNoteId: string;
    refundId: string;
    reasonCode: FailureReasonCode;
  }): Promise<CreditNoteView> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    if (actorUserId === null) throw attesterRequired();
    return this.scoped(async (tx) => {
      const note = await this.loadNoteHeader(tx, tenantId, cmd);
      await this.lockInvoice(tx, tenantId, { ...cmd, invoiceId: note.invoiceId });
      const refund = await this.lockPendingRefund(tx, tenantId, cmd);
      const at = this.clock.now();
      await tx.$executeRaw`
        UPDATE "anonymous_credit_note_refund"
           SET "status" = 'FAILED', "resolvedAt" = ${at}::timestamptz, "resolvedByUserId" = ${actorUserId}::uuid,
               "failureReasonCode" = ${cmd.reasonCode}, "updatedAt" = ${at}::timestamptz
         WHERE "id" = ${cmd.refundId}::uuid AND "status" = 'PENDING'`;
      await this.audit.record(tx, {
        action: 'anonymous_credit_note.refund_failed',
        resourceType: 'anonymous_credit_note_refund',
        resourceId: cmd.refundId,
        tenantId,
        companyId: cmd.companyId,
        branchId: cmd.branchId,
        after: {
          creditNoteId: cmd.creditNoteId,
          method: refund.method,
          amountMinor: refund.amountMinor.toString(),
          reasonCode: cmd.reasonCode,
        },
      });
      return this.loadView(tx, cmd.creditNoteId);
    });
  }

  // ───────────────────────── read ─────────────────────────

  get(cmd: { companyId: string; branchId: string; creditNoteId: string }): Promise<CreditNoteView> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      await this.loadNoteHeader(tx, tenantId, cmd); // 404 outside the caller's company / branch / tenant
      return this.loadView(tx, cmd.creditNoteId);
    });
  }

  // ───────────────────────── internals ─────────────────────────

  /** ORDER row first, then INVOICE row (the frozen hierarchy). Foreign / unknown invoice → a non-disclosing 404. */
  private async lockInvoice(
    tx: ScopedTx,
    tenantId: string,
    s: { companyId: string; branchId: string; invoiceId: string },
  ): Promise<InvoiceRow> {
    const ordRows = await tx.$queryRaw<{ orderId: string }[]>`
      SELECT "orderId" FROM "invoice"
       WHERE "id" = ${s.invoiceId}::uuid AND "tenantId" = ${tenantId}::uuid AND "companyId" = ${s.companyId}::uuid AND "branchId" = ${s.branchId}::uuid`;
    const orderId = ordRows[0]?.orderId;
    if (!orderId) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');
    await tx.$queryRaw`SELECT "id" FROM "order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const rows = await tx.$queryRaw<InvoiceRow[]>`
      SELECT i."id", i."orderId", i."totalAmountMinor", i."currencyCode", i."currencyExponent",
             o."customerId", i."documentDiscountAmountMinor"
        FROM "invoice" i JOIN "order" o ON o."id" = i."orderId"
       WHERE i."id" = ${s.invoiceId}::uuid FOR UPDATE OF i`;
    const row = rows[0];
    if (!row) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');
    return row;
  }

  private async loadOrderLines(tx: ScopedTx, orderId: string): Promise<FrozenOrderLine[]> {
    await tx.$queryRaw`SELECT "id" FROM "order_line" WHERE "orderId" = ${orderId}::uuid FOR UPDATE`;
    const rows = await tx.$queryRaw<
      {
        id: string;
        linePosition: number;
        quantity: string;
        unitPriceAmountMinor: bigint;
        discountAmountMinor: bigint;
        priceTaxMode: string | null;
        lineTaxAmountMinor: bigint | null;
      }[]
    >`SELECT "id", "linePosition", "quantity"::text AS "quantity", "unitPriceAmountMinor", "discountAmountMinor", "priceTaxMode", "lineTaxAmountMinor"
        FROM "order_line" WHERE "orderId" = ${orderId}::uuid ORDER BY "linePosition" ASC`;
    return rows.map((r) => ({ ...r, quantity: Quantity.parse(r.quantity).toFixed4() }));
  }

  private async loadPrior(tx: ScopedTx, invoiceId: string): Promise<Map<string, PriorLineCredit>> {
    const rows = await tx.$queryRaw<
      { orderLineId: string; q: string; g: bigint; d: bigint; s: bigint; t: bigint }[]
    >`SELECT l."orderLineId", SUM(l."quantityCredited")::text AS q, SUM(l."grossCreditedMinor")::bigint AS g,
             SUM(l."discountCreditedMinor")::bigint AS d, SUM(l."documentDiscountShareCreditedMinor")::bigint AS s,
             SUM(l."taxCreditedMinor")::bigint AS t
        FROM "anonymous_credit_note_line" l JOIN "anonymous_credit_note" n ON n."id" = l."creditNoteId"
       WHERE n."invoiceId" = ${invoiceId}::uuid GROUP BY l."orderLineId"`;
    return new Map(
      rows.map((r) => [
        r.orderLineId,
        {
          quantityScaled: Quantity.parse(r.q).scaled,
          grossMinor: r.g,
          discountMinor: r.d,
          documentDiscountShareMinor: r.s,
          taxMinor: r.t,
        },
      ]),
    );
  }

  private async loadTenderSums(
    tx: ScopedTx,
    invoiceId: string,
  ): Promise<{
    paidByMethod: Map<string, bigint>;
    paidTotal: bigint;
    usedByMethod: Map<string, bigint>;
  }> {
    const paid = await tx.$queryRaw<{ method: string; amount: bigint }[]>`
      SELECT p."method", SUM(pa."amountMinor")::bigint AS amount
        FROM "payment_allocation" pa JOIN "payment" p ON p."id" = pa."paymentId"
       WHERE pa."invoiceId" = ${invoiceId}::uuid GROUP BY p."method"`;
    const used = await tx.$queryRaw<{ method: string; amount: bigint }[]>`
      SELECT r."method", SUM(r."amountMinor")::bigint AS amount
        FROM "anonymous_credit_note_refund" r
       WHERE r."invoiceId" = ${invoiceId}::uuid AND r."status" <> 'FAILED' GROUP BY r."method"`;
    const paidByMethod = new Map(paid.map((r) => [r.method, r.amount]));
    return {
      paidByMethod,
      paidTotal: [...paidByMethod.values()].reduce((a, b) => a + b, 0n),
      usedByMethod: new Map(used.map((r) => [r.method, r.amount])),
    };
  }

  private async allocateNumber(tx: ScopedTx, tenantId: string, companyId: string): Promise<string> {
    // the SAME company counter row as `credit_note` (frozen 3b.8 allocator, verbatim): one gapless series across both kinds
    const rows = await tx.$queryRaw<{ allocated: bigint }[]>`
      INSERT INTO "document_number_counter" ("tenantId", "companyId", "documentType", "nextNumber")
      VALUES (${tenantId}::uuid, ${companyId}::uuid, 'CREDIT_NOTE', 2)
      ON CONFLICT ("tenantId", "companyId", "documentType")
      DO UPDATE SET "nextNumber" = "document_number_counter"."nextNumber" + 1
      RETURNING "nextNumber" - 1 AS allocated`;
    return `CN-${rows[0]!.allocated.toString().padStart(6, '0')}`;
  }

  private async insertRefund(
    tx: ScopedTx,
    r: {
      /** the application's accounting clock — the one time source of the transaction */
      at: Date;
      tenantId: string;
      companyId: string;
      branchId: string;
      creditNoteId: string;
      invoiceId: string;
      method: string;
      amountMinor: bigint;
      reference: string | null;
      currencyCode: string;
      currencyExponent: number;
      actorUserId: string | null;
    },
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "anonymous_credit_note_refund"
        ("tenantId","companyId","branchId","creditNoteId","invoiceId","method","amountMinor","currencyCode","currencyExponent","reference","requestedByUserId","createdAt","updatedAt")
      VALUES (${r.tenantId}::uuid, ${r.companyId}::uuid, ${r.branchId}::uuid, ${r.creditNoteId}::uuid, ${r.invoiceId}::uuid, ${r.method},
              ${r.amountMinor}, ${r.currencyCode}, ${r.currencyExponent}::smallint, ${r.reference}, ${r.actorUserId}::uuid,
              ${r.at}::timestamptz, ${r.at}::timestamptz)
      RETURNING "id"`;
    return rows[0]!.id;
  }

  private async nonFailedRefundTotal(tx: ScopedTx, creditNoteId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ amount: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS amount FROM "anonymous_credit_note_refund"
       WHERE "creditNoteId" = ${creditNoteId}::uuid AND "status" <> 'FAILED'`;
    return rows[0]!.amount;
  }

  private async loadNoteHeader(
    tx: ScopedTx,
    tenantId: string,
    s: { companyId: string; branchId: string; creditNoteId: string },
  ): Promise<{
    invoiceId: string;
    totalAmountMinor: bigint;
    currencyCode: string;
    currencyExponent: number;
  }> {
    const rows = await tx.$queryRaw<
      {
        invoiceId: string;
        totalAmountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
      }[]
    >`SELECT "invoiceId", "totalAmountMinor", "currencyCode", "currencyExponent" FROM "anonymous_credit_note"
       WHERE "id" = ${s.creditNoteId}::uuid AND "tenantId" = ${tenantId}::uuid AND "companyId" = ${s.companyId}::uuid AND "branchId" = ${s.branchId}::uuid`;
    const row = rows[0];
    if (!row) throw new NotFoundError('credit note', 'CREDIT_NOTE_NOT_FOUND');
    return row;
  }

  private async lockPendingRefund(
    tx: ScopedTx,
    tenantId: string,
    s: { companyId: string; branchId: string; creditNoteId: string; refundId: string },
  ): Promise<{ method: string; amountMinor: bigint }> {
    const rows = await tx.$queryRaw<{ method: string; amountMinor: bigint; status: string }[]>`
      SELECT "method", "amountMinor", "status" FROM "anonymous_credit_note_refund"
       WHERE "id" = ${s.refundId}::uuid AND "creditNoteId" = ${s.creditNoteId}::uuid AND "tenantId" = ${tenantId}::uuid
         AND "companyId" = ${s.companyId}::uuid AND "branchId" = ${s.branchId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundError('refund', 'REFUND_NOT_FOUND');
    if (row.status !== 'PENDING') {
      throw new DomainError('REFUND_NOT_PENDING', `this refund is already ${row.status}`, 409);
    }
    return row;
  }

  private async loadView(tx: ScopedTx, creditNoteId: string): Promise<CreditNoteView> {
    const notes = await tx.$queryRaw<
      {
        id: string;
        creditNoteNumber: string;
        invoiceId: string;
        companyId: string;
        branchId: string;
        issuedAt: Date;
        accountingDate: Date;
        currencyCode: string;
        reasonCode: string;
        note: string | null;
        subtotalAmountMinor: bigint;
        taxTotalAmountMinor: bigint;
        totalAmountMinor: bigint;
        createdByUserId: string | null;
      }[]
    >`SELECT "id","creditNoteNumber","invoiceId","companyId","branchId","issuedAt","accountingDate","currencyCode","reasonCode","note",
             "subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","createdByUserId"
        FROM "anonymous_credit_note" WHERE "id" = ${creditNoteId}::uuid`;
    const n = notes[0];
    if (!n) throw new NotFoundError('credit note', 'CREDIT_NOTE_NOT_FOUND');
    const lines = await tx.$queryRaw<
      {
        orderLineId: string;
        quantityCredited: string;
        grossCreditedMinor: bigint;
        discountCreditedMinor: bigint;
        documentDiscountShareCreditedMinor: bigint;
        netAfterDocumentDiscountCreditedMinor: bigint;
        taxCreditedMinor: bigint;
        lineTotalCreditedMinor: bigint;
      }[]
    >`SELECT "orderLineId", "quantityCredited"::text AS "quantityCredited", "grossCreditedMinor", "discountCreditedMinor",
             "documentDiscountShareCreditedMinor", "netAfterDocumentDiscountCreditedMinor", "taxCreditedMinor", "lineTotalCreditedMinor"
        FROM "anonymous_credit_note_line" WHERE "creditNoteId" = ${creditNoteId}::uuid ORDER BY "createdAt", "id"`;
    const refunds = await tx.$queryRaw<
      {
        id: string;
        method: string;
        amountMinor: bigint;
        status: string;
        reference: string | null;
        failureReasonCode: string | null;
        requestedByUserId: string | null;
        createdAt: Date;
        resolvedAt: Date | null;
        resolvedByUserId: string | null;
      }[]
    >`SELECT "id","method","amountMinor","status","reference","failureReasonCode","requestedByUserId","createdAt","resolvedAt","resolvedByUserId"
        FROM "anonymous_credit_note_refund" WHERE "creditNoteId" = ${creditNoteId}::uuid ORDER BY "createdAt", "id"`;
    const sumBy = (status: string): bigint =>
      refunds.filter((r) => r.status === status).reduce((a, r) => a + r.amountMinor, 0n);
    const pending = sumBy('PENDING');
    const executed = sumBy('EXECUTED');

    const inv = await tx.$queryRaw<
      { total: bigint; credited: bigint; ordered: string; creditedQty: string }[]
    >`
      SELECT i."totalAmountMinor" AS total,
             COALESCE((SELECT SUM(l."lineTotalCreditedMinor") FROM "anonymous_credit_note_line" l JOIN "anonymous_credit_note" c ON c."id" = l."creditNoteId" WHERE c."invoiceId" = i."id"), 0)::bigint AS credited,
             COALESCE((SELECT SUM(ol."quantity") FROM "order_line" ol WHERE ol."orderId" = i."orderId"), 0)::text AS ordered,
             COALESCE((SELECT SUM(l."quantityCredited") FROM "anonymous_credit_note_line" l JOIN "anonymous_credit_note" c ON c."id" = l."creditNoteId" WHERE c."invoiceId" = i."id"), 0)::text AS "creditedQty"
        FROM "invoice" i WHERE i."id" = ${n.invoiceId}::uuid`;
    const iv = inv[0]!;
    const orderedQ = Quantity.parse(iv.ordered).scaled;
    const creditedQ = Quantity.parse(iv.creditedQty).scaled;
    const status = creditedQ === 0n ? 'NONE' : creditedQ >= orderedQ ? 'FULL' : 'PARTIAL';

    return {
      id: n.id,
      creditNoteNumber: n.creditNoteNumber,
      invoiceId: n.invoiceId,
      companyId: n.companyId,
      branchId: n.branchId,
      issuedAt: n.issuedAt.toISOString(),
      accountingDate: n.accountingDate.toISOString().slice(0, 10),
      currencyCode: n.currencyCode,
      reasonCode: n.reasonCode,
      note: n.note,
      subtotalAmountMinor: n.subtotalAmountMinor.toString(),
      taxTotalAmountMinor: n.taxTotalAmountMinor.toString(),
      totalAmountMinor: n.totalAmountMinor.toString(),
      createdByUserId: n.createdByUserId,
      lines: lines.map((l) => ({
        orderLineId: l.orderLineId,
        quantityCredited: l.quantityCredited,
        grossCreditedMinor: l.grossCreditedMinor.toString(),
        discountCreditedMinor: l.discountCreditedMinor.toString(),
        documentDiscountShareCreditedMinor: l.documentDiscountShareCreditedMinor.toString(),
        netAfterDocumentDiscountCreditedMinor: l.netAfterDocumentDiscountCreditedMinor.toString(),
        taxCreditedMinor: l.taxCreditedMinor.toString(),
        lineTotalCreditedMinor: l.lineTotalCreditedMinor.toString(),
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        method: r.method,
        amountMinor: r.amountMinor.toString(),
        status: r.status,
        reference: r.reference,
        failureReasonCode: r.failureReasonCode,
        requestedByUserId: r.requestedByUserId,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        resolvedByUserId: r.resolvedByUserId,
      })),
      refundSummary: {
        pendingMinor: pending.toString(),
        executedMinor: executed.toString(),
        failedMinor: sumBy('FAILED').toString(),
        unallocatedMinor: (n.totalAmountMinor - pending - executed).toString(),
      },
      invoiceReversal: {
        status,
        creditedTotalMinor: iv.credited.toString(),
        invoiceTotalMinor: iv.total.toString(),
      },
    };
  }
}
