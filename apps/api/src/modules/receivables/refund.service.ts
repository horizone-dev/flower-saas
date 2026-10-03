import { Injectable } from '@nestjs/common';
import { RefundRepository, type CreateRefundInput } from './refund.repository.js';
import type { ExecuteLocalRefundResult } from './refund-execution.repository.js';

/** Thin pass-through, mirroring `CustomerReceiptService`. */
@Injectable()
export class RefundService {
  constructor(private readonly repo: RefundRepository) {}

  createRefund(input: CreateRefundInput): Promise<ExecuteLocalRefundResult> {
    return this.repo.createRefundForBranchScoped(input);
  }
}
