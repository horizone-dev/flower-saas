import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import { DomainError, ForbiddenError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { PolicyEngine } from '../access/policy-engine.js';
import { CustomerRepository, type CustomerRow } from '../customers/customer.repository.js';
import {
  OpeningBalanceRepository,
  type CreateOpeningBalanceResult,
} from './opening-balance.repository.js';

export interface CreateCustomerWithOpeningBalanceInput {
  companyId: string;
  branchId: string;
  displayName: string;
  phone?: string | null;
  email?: string | null;
  openingBalance?: {
    type: 'RECEIVABLE' | 'ADVANCE';
    amountMinor: bigint;
    effectiveDate: string;
    note?: string | null;
  } | null;
}

export interface CreateCustomerWithOpeningBalanceResult {
  customer: CustomerRow;
  openingBalance: CreateOpeningBalanceResult | null;
}

const OPENING_BALANCE_PERMISSION = 'receivables:opening_balance:manage';

/**
 * Task 3b.6 Checkpoint F (F19/F20/F21) — the Customer-creation-with-optional-
 * embedded-Opening-Balance primitive. A WHOLLY SEPARATE route/repository
 * from the frozen 3b.2 `CustomerController.create` — that route, its DTO,
 * its controller and `CustomerRepository`/`CustomerService`'s own public
 * surface are completely untouched (3b.2 explicitly forbids
 * `PostingEngineService`/any GL call anywhere in `CustomerModule` — F19's
 * capability therefore lives here, in `ReceivablesModule`, which already
 * legitimately owns PostingEngine).
 *
 * F21 — a caller with only `customers:manage` (this route's own declared
 * permission) may create a plain Customer through this route with NO
 * `openingBalance`. The MOMENT `openingBalance` is present, the caller MUST
 * ALSO hold `receivables:opening_balance:manage` (and satisfy its step-up
 * requirement) — reusing `PolicyEngine.can` (the SAME pure decision engine
 * `PermissionGuard` itself calls) rather than hand-rolling a duplicate
 * check. This runs BEFORE any transaction opens — a denial leaves zero
 * trace (F21 "reject the whole request before financial mutation").
 *
 * F20 — atomicity: `CustomerRepository.createForCompany(tx, …)` and
 * `OpeningBalanceRepository.createInTx(tx, …)` both run inside the SAME
 * `this.scoped` transaction as this repository's own — a failure in either
 * (including PostingEngine's own accounting-period gate) rolls back the
 * WHOLE thing, including the Customer/CustomerCompanyAccount just created.
 * No compensation logic exists or is needed.
 */
@Injectable()
export class CustomerWithOpeningBalanceRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly customers: CustomerRepository,
    private readonly openingBalance: OpeningBalanceRepository,
    private readonly audit: AuditWriter,
    private readonly policy: PolicyEngine,
  ) {
    super(db);
  }

  async createForBranchScoped(
    input: CreateCustomerWithOpeningBalanceInput,
  ): Promise<CreateCustomerWithOpeningBalanceResult> {
    const { tenantId } = requireTenantContext();
    const ctx = getContext();
    const actorUserId = ctx?.userId ?? null;

    if (input.openingBalance) {
      if (!ctx) throw new ForbiddenError('no request context', 'MISSING_PERMISSION');
      const decision = this.policy.can(ctx, OPENING_BALANCE_PERMISSION, {
        companyId: input.companyId,
        branchId: input.branchId,
      });
      if (!decision.allowed) {
        // Final Hardening §16 — distinguish a genuine missing-step-up denial
        // from a missing-permission denial (the SAME two reasons
        // `PermissionGuard` itself distinguishes for a route-declared
        // permission) rather than collapsing both into one generic code.
        if (decision.reason === 'STEP_UP_REQUIRED') {
          throw new DomainError('STEP_UP_REQUIRED', 'a fresh step-up is required', 403);
        }
        throw new ForbiddenError(
          'creating a Customer with an opening balance requires receivables:opening_balance:manage',
          'MISSING_PERMISSION',
        );
      }
    }

    return this.scoped(async (tx) => {
      const created = await this.customers.createForCompany(tx, {
        tenantId,
        companyId: input.companyId,
        displayName: input.displayName,
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        createdByUserId: actorUserId,
      });
      await this.audit.record(tx, {
        action: 'customer.created',
        resourceType: 'customer',
        resourceId: created.customer.id,
        tenantId,
        companyId: input.companyId,
      });
      await this.audit.record(tx, {
        action: 'customer.company_account_created',
        resourceType: 'customer_company_account',
        resourceId: created.companyAccount.id,
        tenantId,
        companyId: input.companyId,
      });

      let openingBalanceResult: CreateOpeningBalanceResult | null = null;
      if (input.openingBalance) {
        openingBalanceResult = await this.openingBalance.createInTx(tx, {
          tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          customerId: created.customer.id,
          type: input.openingBalance.type,
          amountMinor: input.openingBalance.amountMinor,
          effectiveDate: input.openingBalance.effectiveDate,
          note: input.openingBalance.note ?? null,
          actorUserId,
        });
      }

      return { customer: created.customer, openingBalance: openingBalanceResult };
    });
  }
}
