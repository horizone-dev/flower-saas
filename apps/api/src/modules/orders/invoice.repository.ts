import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { NotFoundError } from '../../common/errors/domain-error.js';

export interface InvoiceRow {
  id: string;
  tenantId: string;
  companyId: string;
  branchId: string;
  orderId: string;
  invoiceNumber: string;
  issuedAt: Date;
  invoiceDate: Date;
  customerDisplayNameSnapshot: string | null;
  currencyCode: string;
  currencyExponent: number;
  subtotalAmountMinor: bigint;
  documentDiscountAmountMinor: bigint;
  taxTotalAmountMinor: bigint;
  totalAmountMinor: bigint;
  invoicePaymentStatus: string;
  createdAt: Date;
}

/**
 * Task 3b.3 Checkpoint C — Invoice READ ONLY. No write method exists anywhere
 * in this file — an Invoice row is only ever produced by
 * `InvoiceIssuanceRepository.issueFinalInvoice` (internal, not HTTP-exposed).
 * Branch-scoped throughout (`Invoice.branchId` was set to the confirmed
 * Order's `originBranchId` at issuance) — same non-disclosing 404 discipline
 * as `OrderRepository`.
 */
@Injectable()
export class InvoiceRepository extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }

  async getForBranchScoped(input: {
    companyId: string;
    branchId: string;
    invoiceId: string;
  }): Promise<InvoiceRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const row = await tx.invoice.findFirst({
        where: {
          id: input.invoiceId,
          tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
        },
      });
      if (!row) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');
      return row as InvoiceRow;
    });
  }
}
