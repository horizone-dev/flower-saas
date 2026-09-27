import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `CustomerInvoiceArRepository`
// exactly): PARTICIPATES in the caller's already-open transaction, never
// opens its own.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { resolveReceiptAccountKeyForTender } from '../payments/tender-account-mapping.js';
import type { TenderMethod } from '../payments/tender.js';
import { assertCustomerAccountEntryReferenceShape } from './customer-account-entry.js';
import {
  computeInvoiceCoverage,
  assertInvoicePaymentStatusTransition,
  type InvoicePaymentStatus3b6,
} from './invoice-payment-status.js';

export interface RecordPaymentReceivedInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerCompanyAccountId: string;
  paymentId: string;
  method: TenderMethod;
  amountMinor: bigint;
  actorUserId?: string | null;
}

export interface RecordPaymentReceivedResult {
  journalEntryId: string;
}

export interface ApplyInvoiceAllocationEffectsInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerCompanyAccountId: string;
  paymentAllocationId: string;
  customerReceivableId: string;
  invoiceId: string;
  amountMinor: bigint;
  actorUserId?: string | null;
}

export interface ApplyOpeningApplicationEffectsInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerCompanyAccountId: string;
  customerReceivableId: string;
  paymentId: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  actorUserId?: string | null;
}

export interface ApplyOpeningApplicationEffectsResult {
  applicationId: string;
  journalEntryId: string;
}

/**
 * Task 3b.6 Checkpoint D (D17/D18) — the ONE centralized place that turns an
 * already-created, authoritative Payment/PaymentAllocation/
 * CustomerReceivablePaymentApplication into the frozen customer-account
 * effects: CustomerAccountEntry chronology, `CustomerCompanyAccount`
 * projection reduction, Invoice payment-status derivation, and the
 * allocation-side GL journal. Reused UNCHANGED by every producer (local
 * invoice payment, Multi Payment, provider webhook capture, recovery
 * replay, the new customer-level receipt) — never duplicated per call site.
 *
 * Never creates a `Payment` itself. Participates in the CALLER's already-open
 * `ScopedTx` — never commits.
 *
 * Checkpoint D hardening pass — the receipt-side GL leg
 * (`Dr <tender account> / Cr LIABILITY.UNAPPLIED_RECEIPTS`, sourceKind
 * `customer_receipt_payment`) is now implemented in
 * `recordPaymentReceivedInTx`, using the frozen tender->account mapping in
 * `tender-account-mapping.ts`. Combined with the two allocation-side legs
 * below, every customer-attributable canonical Payment now produces a
 * complete, balanced GL chain: receipt (Dr tender asset / Cr Unapplied
 * Receipts) then application (Dr Unapplied Receipts / Cr AR) — the SAME
 * `LIABILITY.UNAPPLIED_RECEIPTS` account nets to exactly the Payment's own
 * unallocated remainder (proven in the integration suite).
 */
@Injectable()
export class CustomerReceiptEffectsRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * CustomerAccountEntry(PAYMENT) — at most one per Payment (DB-enforced,
   * `customer_account_entry.paymentId` UNIQUE). Called exactly once, by
   * construction, at the point a customer-attributable Payment is created —
   * never on replay (the shared Idempotency-Key infrastructure short-circuits
   * a replayed request before this code path is ever reached again, D26).
   *
   * Checkpoint D hardening pass — ALSO posts the receipt-side GL journal
   * exactly once: `sourceKind='customer_receipt_payment'`,
   * `sourceId=paymentId` (PostingEngine's own tenant/company/sourceKind/
   * sourceId uniqueness is the exactly-once backstop on replay — identical
   * to every other journal in this schema). `Dr <tender account
   * (resolveReceiptAccountKeyForTender)> / Cr LIABILITY.UNAPPLIED_RECEIPTS`
   * — the debit account is NEVER Revenue or Accounts Receivable.
   */
  async recordPaymentReceivedInTx(
    tx: ScopedTx,
    input: RecordPaymentReceivedInput,
  ): Promise<RecordPaymentReceivedResult> {
    assertCustomerAccountEntryReferenceShape('PAYMENT', { paymentId: input.paymentId });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'PAYMENT',
        paymentId: input.paymentId,
      },
    });

    const journal = await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'customer_receipt_payment',
      sourceId: input.paymentId,
      lines: [
        {
          accountKey: resolveReceiptAccountKeyForTender(input.method),
          direction: 'debit',
          amountMinor: input.amountMinor,
        },
        {
          accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS',
          direction: 'credit',
          amountMinor: input.amountMinor,
        },
      ],
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    return { journalEntryId: journal.journalEntryId };
  }

  /**
   * The Invoice-origin allocation leg (D17/D23). Assumes the caller already
   * inserted the `PaymentAllocation` row (id given) — this method never
   * creates one itself, so it can be reused identically by both the existing
   * single-Invoice producers (which already insert their own allocation) and
   * the new FIFO customer-receipt path (which inserts one per queue item).
   *
   * Locks `CustomerCompanyAccount` FOR UPDATE (idempotent re-lock if the
   * caller already holds it earlier in the same transaction — Postgres row
   * locks are transaction-scoped, so re-acquiring the SAME row's lock in the
   * SAME transaction never blocks). Reduces `currentOutstandingMinor` by the
   * EXACT amount actually allocated (never the gross receipt amount, D19).
   * Never touches `advanceBalanceMinor`. Never increments `version` (that
   * field is scoped exclusively to credit-CONFIGURATION optimistic
   * concurrency, Checkpoint C hardening precedent).
   */
  async applyInvoiceAllocationEffectsInTx(
    tx: ScopedTx,
    input: ApplyInvoiceAllocationEffectsInput,
  ): Promise<{ journalEntryId: string }> {
    await this.lockCustomerCompanyAccount(tx, input.customerCompanyAccountId);

    assertCustomerAccountEntryReferenceShape('PAYMENT_ALLOCATION', {
      paymentAllocationId: input.paymentAllocationId,
    });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'PAYMENT_ALLOCATION',
        paymentAllocationId: input.paymentAllocationId,
      },
    });

    await tx.customerCompanyAccount.update({
      where: { id: input.customerCompanyAccountId },
      data: { currentOutstandingMinor: { decrement: input.amountMinor } },
    });

    const journal = await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'payment_allocation',
      sourceId: input.paymentAllocationId,
      lines: [
        {
          accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS',
          direction: 'debit',
          amountMinor: input.amountMinor,
        },
        {
          accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
          direction: 'credit',
          amountMinor: input.amountMinor,
        },
      ],
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.recomputeInvoicePaymentStatusInTx(tx, input.invoiceId);

    return { journalEntryId: journal.journalEntryId };
  }

  /**
   * The Opening-Receivable-origin leg (D6/D24) — the new source-of-truth
   * addition. Creates the `CustomerReceivablePaymentApplication` row itself
   * (no existing producer ever creates one), then the matching chronology
   * entry, projection reduction, and GL journal. No CustomerAdvance is ever
   * created on this path (frozen: a direct AR collection is never
   * misclassified as a customer liability).
   */
  async applyOpeningApplicationEffectsInTx(
    tx: ScopedTx,
    input: ApplyOpeningApplicationEffectsInput,
  ): Promise<ApplyOpeningApplicationEffectsResult> {
    await this.lockCustomerCompanyAccount(tx, input.customerCompanyAccountId);

    const application = await tx.customerReceivablePaymentApplication.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        paymentId: input.paymentId,
        customerReceivableId: input.customerReceivableId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        currencyExponent: input.currencyExponent,
        ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
      },
    });

    assertCustomerAccountEntryReferenceShape('OPENING_RECEIVABLE_PAYMENT_APPLIED', {
      customerReceivablePaymentApplicationId: application.id,
    });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'OPENING_RECEIVABLE_PAYMENT_APPLIED',
        customerReceivablePaymentApplicationId: application.id,
      },
    });

    await tx.customerCompanyAccount.update({
      where: { id: input.customerCompanyAccountId },
      data: { currentOutstandingMinor: { decrement: input.amountMinor } },
    });

    const journal = await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'opening_receivable_payment_application',
      sourceId: application.id,
      lines: [
        {
          accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS',
          direction: 'debit',
          amountMinor: input.amountMinor,
        },
        {
          accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
          direction: 'credit',
          amountMinor: input.amountMinor,
        },
      ],
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'receivable.opening_payment_applied',
      resourceType: 'customer_receivable_payment_application',
      resourceId: application.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      actorUserId: input.actorUserId ?? null,
      after: {
        customerReceivableId: input.customerReceivableId,
        paymentId: input.paymentId,
        amountMinor: input.amountMinor.toString(),
        currencyCode: input.currencyCode,
      },
    });

    return { applicationId: application.id, journalEntryId: journal.journalEntryId };
  }

  /**
   * D21 — recomputes authoritative Invoice coverage (PaymentAllocation +
   * CustomerAdvanceApplication against this Invoice's own CustomerReceivable,
   * if one exists) and advances `invoicePaymentStatus` through the frozen
   * Checkpoint-A graph. Called for EVERY Invoice that receives a
   * PaymentAllocation — customer-linked AND walk-in alike (walk-in's
   * `advanceAppliedMinor` is structurally always `0n`, per Checkpoint A's own
   * documented invariant — no walk-in-specific branch needed here either).
   * A same-state result is a harmless no-op (no UPDATE issued).
   */
  async recomputeInvoicePaymentStatusInTx(tx: ScopedTx, invoiceId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ totalAmountMinor: bigint; invoicePaymentStatus: string }[]>`
      SELECT "totalAmountMinor", "invoicePaymentStatus" FROM "invoice" WHERE "id" = ${invoiceId}::uuid`;
    const invoice = rows[0];
    if (!invoice) {
      throw new RangeError(`recomputeInvoicePaymentStatusInTx: invoice ${invoiceId} not found`);
    }

    const allocatedRows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total
        FROM "payment_allocation" WHERE "invoiceId" = ${invoiceId}::uuid`;
    const paymentAllocatedMinor = allocatedRows[0]!.total;

    const receivableRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_receivable" WHERE "invoiceId" = ${invoiceId}::uuid`;
    let advanceAppliedMinor = 0n;
    if (receivableRows[0]) {
      const advRows = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM("amountMinor"), 0)::bigint AS total
          FROM "customer_advance_application" WHERE "customerReceivableId" = ${receivableRows[0].id}::uuid`;
      advanceAppliedMinor = advRows[0]!.total;
    }

    const { status: nextStatus } = computeInvoiceCoverage({
      invoiceTotalMinor: invoice.totalAmountMinor,
      paymentAllocatedMinor,
      advanceAppliedMinor,
    });

    const currentStatus = invoice.invoicePaymentStatus as InvoicePaymentStatus3b6;
    assertInvoicePaymentStatusTransition(currentStatus, nextStatus);
    if (currentStatus !== nextStatus) {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { invoicePaymentStatus: nextStatus },
      });
    }
  }

  /** Re-acquiring a lock this SAME transaction already holds is a harmless
   *  no-op in Postgres — never a second logical lock acquisition. */
  private async lockCustomerCompanyAccount(tx: ScopedTx, accountId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "customer_company_account" WHERE "id" = ${accountId}::uuid FOR UPDATE`;
  }
}
