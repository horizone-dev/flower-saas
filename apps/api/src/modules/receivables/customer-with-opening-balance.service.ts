import { Injectable } from '@nestjs/common';
import {
  CustomerWithOpeningBalanceRepository,
  type CreateCustomerWithOpeningBalanceInput,
  type CreateCustomerWithOpeningBalanceResult,
} from './customer-with-opening-balance.repository.js';

/** Thin pass-through, mirroring every other Checkpoint E/F service. */
@Injectable()
export class CustomerWithOpeningBalanceService {
  constructor(private readonly repo: CustomerWithOpeningBalanceRepository) {}

  create(
    input: CreateCustomerWithOpeningBalanceInput,
  ): Promise<CreateCustomerWithOpeningBalanceResult> {
    return this.repo.createForBranchScoped(input);
  }
}
