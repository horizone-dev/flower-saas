import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `InvoiceIssuanceRepository`/
// `CustomerInvoiceArRepository`/`PostingEngineService` exactly): this is an
// internal primitive that must PARTICIPATE in the caller's already-open
// transaction, never open its own.
import type { ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { assertCustomerReceivableSourceShape } from '../receivables/customer-receivable-source.js';
import { assertCustomerAccountEntryReferenceShape } from '../receivables/customer-account-entry.js';

export interface ResolvedCancellationChargeTax {
  currencyCode: string;
  currencyExponent: number;
  accountingDate: string;
  taxCategoryKey: string;
  rateBps: number | null;
  priceTaxMode: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
  roundingMode: 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP' | 'HALF_DOWN';
  netAmountMinor: bigint;
  taxAmountMinor: bigint;
  totalAmountMinor: bigint;
}

export interface IssueCancellationChargeInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  orderId: string;
  /** Task 3b.8 Checkpoint D — set when issued against an already-invoiced
   *  Order (composite-FK-proven at the DB that this Invoice's own `orderId`
   *  equals `orderId` above); `null`/omitted for the pre-invoice path
   *  (Checkpoint C, unchanged). */
  invoiceId?: string | null;
  customerCompanyAccountId: string;
  reasonCode: string;
  note: string | null;
  actorUserId?: string | null;
}

export interface IssueCancellationChargeResult {
  cancellationChargeId: string;
  cancellationChargeNumber: string;
  customerReceivableId: string;
  journalEntryId: string;
}

/**
 * Task 3b.8 Checkpoint C — the CancellationCharge financial-document atomic-
 * write primitive. NOT HTTP-exposed. Called only from
 * `OrderRepository.cancelForBranchScoped`, which resolves
 * `ResolvedCancellationChargeTax` itself BEFORE opening its write
 * transaction (via `LocalizationService`, which cannot participate in an
 * already-open `tx` — mirrors `OrderRepository.resolveLines`'s own "resolve,
 * snapshot, then act" discipline exactly; `TaxResolutionService` is
 * deliberately never used here since it resolves via a catalog VARIANT,
 * which a CancellationCharge has none of).
 *
 * Allocates the `CANCELLATION_CHARGE` document number, inserts the immutable
 * `CancellationCharge`, creates `CustomerReceivable`(CANCELLATION_CHARGE) +
 * `CustomerAccountEntry`(CANCELLATION_CHARGE), posts the GL journal (Dr AR /
 * Cr `REVENUE.CANCELLATION_CHARGE` / Cr `LIABILITY.TAX_PAYABLE` iff tax > 0
 * — NEVER `LIABILITY.REFUND_PAYABLE`), and audits — all inside the CALLER's
 * transaction. Does NOT touch the `Order` row itself; the caller performs
 * the DRAFT/HELD -> CANCELLED transition itself, in the same transaction,
 * immediately after this returns.
 */
@Injectable()
export class CancellationChargeRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
  ) {}

  async issueCancellationCharge(
    tx: ScopedTx,
    resolved: ResolvedCancellationChargeTax,
    input: IssueCancellationChargeInput,
  ): Promise<IssueCancellationChargeResult> {
    const cancellationChargeNumber = await this.allocateNumber(tx, input.tenantId, input.companyId);

    const accountingDate = new Date(`${resolved.accountingDate}T00:00:00.000Z`);
    const charge = await tx.cancellationCharge.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        orderId: input.orderId,
        invoiceId: input.invoiceId ?? null,
        cancellationChargeNumber,
        netAmountMinor: resolved.netAmountMinor,
        taxAmountMinor: resolved.taxAmountMinor,
        totalAmountMinor: resolved.totalAmountMinor,
        currencyCode: resolved.currencyCode,
        currencyExponent: resolved.currencyExponent,
        taxCategoryKey: resolved.taxCategoryKey,
        rateBps: resolved.rateBps,
        priceTaxMode: resolved.priceTaxMode,
        roundingMode: resolved.roundingMode,
        reasonCode: input.reasonCode,
        note: input.note,
        accountingDate,
        createdByUserId: input.actorUserId ?? null,
      },
    });

    assertCustomerReceivableSourceShape({
      sourceType: 'CANCELLATION_CHARGE',
      cancellationChargeId: charge.id,
    });
    const receivable = await tx.customerReceivable.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        sourceType: 'CANCELLATION_CHARGE',
        cancellationChargeId: charge.id,
      },
    });

    assertCustomerAccountEntryReferenceShape('CANCELLATION_CHARGE', {
      customerReceivableId: receivable.id,
    });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'CANCELLATION_CHARGE',
        customerReceivableId: receivable.id,
      },
    });

    await tx.customerCompanyAccount.update({
      where: { id: input.customerCompanyAccountId },
      data: { currentOutstandingMinor: { increment: resolved.totalAmountMinor } },
    });

    // Dr Accounts Receivable (total) / Cr Cancellation Charge Revenue (net) /
    // Cr Tax Payable (tax, only if > 0 — never a fake zero-value line, §14).
    // NEVER `LIABILITY.REFUND_PAYABLE`.
    const lines = [
      {
        accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
        direction: 'debit' as const,
        amountMinor: resolved.totalAmountMinor,
      },
      ...(resolved.netAmountMinor > 0n
        ? [
            {
              accountKey: 'REVENUE.CANCELLATION_CHARGE',
              direction: 'credit' as const,
              amountMinor: resolved.netAmountMinor,
            },
          ]
        : []),
      ...(resolved.taxAmountMinor > 0n
        ? [
            {
              accountKey: 'LIABILITY.TAX_PAYABLE',
              direction: 'credit' as const,
              amountMinor: resolved.taxAmountMinor,
            },
          ]
        : []),
    ];
    const journal = await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'cancellation_charge',
      sourceId: charge.id,
      lines,
      accountingDate: resolved.accountingDate,
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'cancellation_charge.issued',
      resourceType: 'cancellation_charge',
      resourceId: charge.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      actorUserId: input.actorUserId ?? null,
      after: {
        orderId: input.orderId,
        cancellationChargeNumber,
        totalAmountMinor: resolved.totalAmountMinor.toString(),
        currencyCode: resolved.currencyCode,
        customerReceivableId: receivable.id,
      },
    });

    return {
      cancellationChargeId: charge.id,
      cancellationChargeNumber,
      customerReceivableId: receivable.id,
      journalEntryId: journal.journalEntryId,
    };
  }

  /**
   * `document_number_counter` allocator — identical shape/guarantees to
   * `InvoiceIssuanceRepository.allocateNumber` (`INSERT ... ON CONFLICT DO
   * UPDATE ... RETURNING`, never `MAX()+1`, increments inside the CALLER's
   * transaction so a rollback rolls the increment back with it). Format
   * `CC-NNNNNN`, minimum 6-digit zero padding.
   */
  private async allocateNumber(tx: ScopedTx, tenantId: string, companyId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ allocated: bigint }[]>`
      INSERT INTO "document_number_counter" ("tenantId", "companyId", "documentType", "nextNumber")
      VALUES (${tenantId}::uuid, ${companyId}::uuid, 'CANCELLATION_CHARGE', 2)
      ON CONFLICT ("tenantId", "companyId", "documentType")
      DO UPDATE SET "nextNumber" = "document_number_counter"."nextNumber" + 1
      RETURNING "nextNumber" - 1 AS allocated`;
    const n = rows[0]!.allocated;
    return `CC-${n.toString().padStart(6, '0')}`;
  }
}
