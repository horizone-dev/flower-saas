import { Injectable } from '@nestjs/common';
import {
  CustomerReceiptRepository,
  type CreateCustomerReceiptInput,
} from './customer-receipt.repository.js';
import type { CollectCustomerReceiptResult } from './customer-receipt-collection.repository.js';

/** Thin pass-through, mirroring `PaymentService`. */
@Injectable()
export class CustomerReceiptService {
  constructor(private readonly repo: CustomerReceiptRepository) {}

  createReceipt(input: CreateCustomerReceiptInput): Promise<CollectCustomerReceiptResult> {
    return this.repo.createReceiptForBranchScoped(input);
  }
}
