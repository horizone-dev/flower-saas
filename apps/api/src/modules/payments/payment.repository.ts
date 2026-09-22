import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import {
  PaymentCollectionRepository,
  type CaptureSynchronousTendersResult,
  type SynchronousTenderInput,
} from './payment-collection.repository.js';

export interface CreatePaymentInput {
  companyId: string;
  branchId: string;
  invoiceId: string;
  amountMinor: bigint;
  tenders: readonly SynchronousTenderInput[];
  idempotencyKey: string;
}

/**
 * Task 3b.5 Checkpoint D — opens the caller transaction (`this.scoped`,
 * exactly like every other `ScopedRepository`) and delegates the actual
 * capture logic to
 * `PaymentCollectionRepository.captureSynchronousTendersInTx`, mirroring
 * `OrderRepository`/`InvoiceRepository`'s own thin-wrapper relationship to
 * their internal primitives. `companyId`/`branchId` are passed through
 * EXPLICITLY into the primitive's own WHERE-clause scoping (Checkpoint B §1
 * / Checkpoint C §C4) — trusted values already authorization-validated by
 * `PermissionGuard`'s `@ScopedParam` before this ever runs, never re-derived
 * from anything else. `tenantId` and the actor ids come exclusively from
 * `RequestContext` — never the request body.
 */
@Injectable()
export class PaymentRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly collection: PaymentCollectionRepository,
  ) {
    super(db);
  }

  async createPaymentForBranchScoped(
    input: CreatePaymentInput,
  ): Promise<CaptureSynchronousTendersResult> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped((tx) =>
      this.collection.captureSynchronousTendersInTx(tx, {
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        invoiceId: input.invoiceId,
        amountMinor: input.amountMinor,
        tenders: input.tenders,
        createdByUserId: actorUserId,
        actingUserId: actorUserId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }
}
