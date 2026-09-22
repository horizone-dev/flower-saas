import { Injectable } from '@nestjs/common';
import { PaymentRepository, type CreatePaymentInput } from './payment.repository.js';
import type { CaptureSynchronousTendersResult } from './payment-collection.repository.js';

/** Thin pass-through, mirroring `OrderService`/`InvoiceService`. */
@Injectable()
export class PaymentService {
  constructor(private readonly repo: PaymentRepository) {}

  createPayment(input: CreatePaymentInput): Promise<CaptureSynchronousTendersResult> {
    return this.repo.createPaymentForBranchScoped(input);
  }
}
