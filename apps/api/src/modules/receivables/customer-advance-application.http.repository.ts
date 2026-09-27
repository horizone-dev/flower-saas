import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import {
  CustomerAdvanceApplicationRepository,
  type ApplyCustomerAdvanceResult,
} from './customer-advance-application.repository.js';

export interface ApplyCustomerAdvanceHttpInput {
  companyId: string;
  branchId: string;
  customerId: string;
  advanceId: string;
  customerReceivableId: string;
  amountMinor: bigint;
}

/**
 * Task 3b.6 Checkpoint E (E11/E13) — opens the caller transaction, mirroring
 * `PaymentAdvanceConversionHttpRepository` exactly.
 */
@Injectable()
export class CustomerAdvanceApplicationHttpRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly application: CustomerAdvanceApplicationRepository,
  ) {
    super(db);
  }

  async applyForBranchScoped(
    input: ApplyCustomerAdvanceHttpInput,
  ): Promise<ApplyCustomerAdvanceResult> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped((tx) =>
      this.application.applyInTx(tx, {
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerId: input.customerId,
        advanceId: input.advanceId,
        customerReceivableId: input.customerReceivableId,
        amountMinor: input.amountMinor,
        actorUserId,
      }),
    );
  }
}
