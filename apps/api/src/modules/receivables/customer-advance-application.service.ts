import { Injectable } from '@nestjs/common';
import {
  CustomerAdvanceApplicationHttpRepository,
  type ApplyCustomerAdvanceHttpInput,
} from './customer-advance-application.http.repository.js';
import type { ApplyCustomerAdvanceResult } from './customer-advance-application.repository.js';

/** Thin pass-through, mirroring `PaymentAdvanceConversionService`. */
@Injectable()
export class CustomerAdvanceApplicationService {
  constructor(private readonly repo: CustomerAdvanceApplicationHttpRepository) {}

  apply(input: ApplyCustomerAdvanceHttpInput): Promise<ApplyCustomerAdvanceResult> {
    return this.repo.applyForBranchScoped(input);
  }
}
