import { Injectable } from '@nestjs/common';
import {
  PaymentAdvanceConversionHttpRepository,
  type ConvertPaymentToAdvanceHttpInput,
} from './payment-advance-conversion.http.repository.js';
import type { ConvertPaymentToAdvanceResult } from './payment-advance-conversion.repository.js';

/** Thin pass-through, mirroring `CustomerReceiptService`. */
@Injectable()
export class PaymentAdvanceConversionService {
  constructor(private readonly repo: PaymentAdvanceConversionHttpRepository) {}

  convert(input: ConvertPaymentToAdvanceHttpInput): Promise<ConvertPaymentToAdvanceResult> {
    return this.repo.convertForBranchScoped(input);
  }
}
