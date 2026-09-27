import { Injectable } from '@nestjs/common';
import {
  OpeningBalanceHttpRepository,
  type CreateOpeningBalanceHttpInput,
} from './opening-balance.http.repository.js';
import type { CreateOpeningBalanceResult } from './opening-balance.repository.js';

/** Thin pass-through, mirroring `PaymentAdvanceConversionService`. */
@Injectable()
export class OpeningBalanceService {
  constructor(private readonly repo: OpeningBalanceHttpRepository) {}

  create(input: CreateOpeningBalanceHttpInput): Promise<CreateOpeningBalanceResult> {
    return this.repo.createForBranchScoped(input);
  }
}
