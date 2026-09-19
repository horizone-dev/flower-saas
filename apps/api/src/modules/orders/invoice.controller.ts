import { Controller, Get, Param } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { InvoiceService } from './invoice.service.js';
import type { InvoiceRow } from './invoice.repository.js';

function serializeInvoice(row: InvoiceRow): Omit<
  InvoiceRow,
  'subtotalAmountMinor' | 'documentDiscountAmountMinor' | 'taxTotalAmountMinor' | 'totalAmountMinor'
> & {
  subtotalAmountMinor: string;
  documentDiscountAmountMinor: string;
  taxTotalAmountMinor: string;
  totalAmountMinor: string;
} {
  return {
    ...row,
    subtotalAmountMinor: row.subtotalAmountMinor.toString(),
    documentDiscountAmountMinor: row.documentDiscountAmountMinor.toString(),
    taxTotalAmountMinor: row.taxTotalAmountMinor.toString(),
    totalAmountMinor: row.totalAmountMinor.toString(),
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/invoices` — task 3b.3
 * Checkpoint C. READ ONLY — `orders:view` (no `invoices:*` permission exists,
 * frozen decision). No POST/PATCH/DELETE route exists anywhere in this
 * module; an Invoice is only ever produced by the internal
 * `InvoiceIssuanceRepository.issueFinalInvoice` primitive (Checkpoint C,
 * never routed from a controller).
 */
@Controller('companies/:companyId/branches/:branchId/invoices')
export class InvoiceController {
  constructor(private readonly invoices: InvoiceService) {}

  @Get(':id')
  @RequirePermission('orders:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async get(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'invoice');
    const invoice = await this.invoices.get({ companyId, branchId, invoiceId: id });
    return serializeInvoice(invoice);
  }
}
