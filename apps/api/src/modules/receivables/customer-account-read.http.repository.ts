import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import {
  CustomerAccountReadRepository,
  type ReadScopeInput,
  type CustomerAccountSummary,
  type ReceivableRow,
  type AdvanceRow,
  type UnappliedReceiptRow,
  type StatementLine,
  type StatementOpeningState,
} from './customer-account-read.repository.js';

type BranchScoped = Omit<ReadScopeInput, 'tenantId'>;

/**
 * Task 3b.6 Checkpoint G — opens the caller transaction (`this.scoped`,
 * exactly like every other HTTP repository in this module) and delegates to
 * `CustomerAccountReadRepository`. `companyId`/`branchId`/`customerId` are
 * the trusted, already-`@ScopedParam`-validated route params; `tenantId`
 * comes exclusively from `RequestContext` — never the request body/query.
 */
@Injectable()
export class CustomerAccountReadHttpRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly read: CustomerAccountReadRepository,
  ) {
    super(db);
  }

  async getSummary(input: BranchScoped): Promise<CustomerAccountSummary> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.read.getSummary(tx, { tenantId, ...input }));
  }

  async listReceivables(
    input: BranchScoped & { cursor?: string; limit?: number; asOf?: string },
  ): Promise<{ data: ReceivableRow[]; nextCursor: string | null }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.read.listReceivables(tx, { tenantId, ...input }));
  }

  async listAdvances(
    input: BranchScoped & { cursor?: string; limit?: number },
  ): Promise<{ data: AdvanceRow[]; nextCursor: string | null }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.read.listAdvances(tx, { tenantId, ...input }));
  }

  async listUnappliedReceipts(
    input: BranchScoped & { cursor?: string; limit?: number },
  ): Promise<{ data: UnappliedReceiptRow[]; nextCursor: string | null }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.read.listUnappliedReceipts(tx, { tenantId, ...input }));
  }

  async getStatement(
    input: BranchScoped & { from?: string; to?: string; cursor?: string; limit?: number },
  ): Promise<{
    data: StatementLine[];
    nextCursor: string | null;
    openingState: StatementOpeningState | null;
  }> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.read.getStatement(tx, { tenantId, ...input }));
  }
}
