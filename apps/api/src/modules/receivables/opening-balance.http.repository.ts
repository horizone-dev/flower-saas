import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import {
  OpeningBalanceRepository,
  type CreateOpeningBalanceResult,
} from './opening-balance.repository.js';

export interface CreateOpeningBalanceHttpInput {
  companyId: string;
  branchId: string;
  customerId: string;
  type: 'RECEIVABLE' | 'ADVANCE';
  amountMinor: bigint;
  effectiveDate: string;
  note?: string | null;
}

/**
 * Task 3b.6 Checkpoint F — opens the caller transaction (`this.scoped`,
 * exactly like every other Checkpoint E/F HTTP repository in this module)
 * and delegates to `OpeningBalanceRepository.createInTx`. `companyId`/
 * `branchId`/`customerId` are the trusted, already-`@ScopedParam`-validated
 * route params; `tenantId` and the actor id come exclusively from
 * `RequestContext` — never the request body.
 */
@Injectable()
export class OpeningBalanceHttpRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly openingBalance: OpeningBalanceRepository,
  ) {
    super(db);
  }

  async createForBranchScoped(
    input: CreateOpeningBalanceHttpInput,
  ): Promise<CreateOpeningBalanceResult> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped((tx) =>
      this.openingBalance.createInTx(tx, {
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerId: input.customerId,
        type: input.type,
        amountMinor: input.amountMinor,
        effectiveDate: input.effectiveDate,
        note: input.note ?? null,
        actorUserId,
      }),
    );
  }
}
