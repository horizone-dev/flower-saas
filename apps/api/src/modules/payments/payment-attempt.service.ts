import { Injectable } from '@nestjs/common';
import {
  PaymentAttemptRepository,
  type CreateAsyncPaymentAttemptInput,
  type AsyncPaymentAttemptResult,
} from './payment-attempt.repository.js';

/** Thin pass-through, mirroring `PaymentService`. */
@Injectable()
export class PaymentAttemptService {
  constructor(private readonly repo: PaymentAttemptRepository) {}

  createAsyncAttempt(input: CreateAsyncPaymentAttemptInput): Promise<AsyncPaymentAttemptResult> {
    return this.repo.createAsyncAttemptForBranchScoped(input);
  }
}
