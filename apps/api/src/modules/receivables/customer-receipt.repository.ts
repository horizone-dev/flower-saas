import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import {
  CustomerReceiptCollectionRepository,
  type CollectCustomerReceiptResult,
} from './customer-receipt-collection.repository.js';
import type { TenderMethod } from '../payments/tender.js';

export interface CreateCustomerReceiptInput {
  companyId: string;
  branchId: string;
  customerId: string;
  amountMinor: bigint;
  method: TenderMethod;
  idempotencyKey: string;
}

/**
 * Task 3b.6 Checkpoint D (D10) — opens the caller transaction (`this.scoped`,
 * exactly like `PaymentRepository`) and delegates to
 * `CustomerReceiptCollectionRepository.collectInTx`. `companyId`/`branchId`
 * are the trusted, already-`@ScopedParam`-validated route params; `tenantId`
 * and the actor ids come exclusively from `RequestContext` — never the
 * request body.
 */
@Injectable()
export class CustomerReceiptRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly collection: CustomerReceiptCollectionRepository,
  ) {
    super(db);
  }

  async createReceiptForBranchScoped(
    input: CreateCustomerReceiptInput,
  ): Promise<CollectCustomerReceiptResult> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped((tx) =>
      this.collection.collectInTx(tx, {
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerId: input.customerId,
        amountMinor: input.amountMinor,
        method: input.method,
        createdByUserId: actorUserId,
        actingUserId: actorUserId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
}
