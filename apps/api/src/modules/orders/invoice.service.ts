import { Injectable } from '@nestjs/common';
import { InvoiceRepository, type InvoiceRow } from './invoice.repository.js';

/** Thin pass-through, mirroring `OrderService`/`CustomerService`. */
@Injectable()
export class InvoiceService {
  constructor(private readonly repo: InvoiceRepository) {}

  get(input: { companyId: string; branchId: string; invoiceId: string }): Promise<InvoiceRow> {
    return this.repo.getForBranchScoped(input);
  }
}
