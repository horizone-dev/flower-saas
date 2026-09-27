import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import {
  PaymentAdvanceConversionRepository,
  type ConvertPaymentToAdvanceResult,
} from './payment-advance-conversion.repository.js';

export interface ConvertPaymentToAdvanceHttpInput {
  companyId: string;
  branchId: string;
  customerId: string;
  paymentId: string;
  amountMinor: bigint;
}

/**
 * Task 3b.6 Checkpoint E (E7/E8) — opens the caller transaction (`this.scoped`,
 * exactly like `CustomerReceiptRepository`) and delegates to
 * `PaymentAdvanceConversionRepository.convertInTx`. `companyId`/`branchId`/
 * `customerId` are the trusted, already-`@ScopedParam`-validated route
 * params; `tenantId` and the actor id come exclusively from `RequestContext`
 * — never the request body.
 */
@Injectable()
export class PaymentAdvanceConversionHttpRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly conversion: PaymentAdvanceConversionRepository,
  ) {
    super(db);
  }

  async convertForBranchScoped(
    input: ConvertPaymentToAdvanceHttpInput,
  ): Promise<ConvertPaymentToAdvanceResult> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped((tx) =>
      this.conversion.convertInTx(tx, {
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerId: input.customerId,
        paymentId: input.paymentId,
        amountMinor: input.amountMinor,
        actorUserId,
      }),
    );
  }
}
