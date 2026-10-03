import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { SystemClock } from '../../common/clock/clock.js';
import { derivePostingDate } from '../accounting/posting-date.js';
import {
  RefundExecutionRepository,
  type ExecuteLocalRefundResult,
} from './refund-execution.repository.js';

export interface CreateRefundInput {
  companyId: string;
  branchId: string;
  customerId: string;
  customerAdvanceId: string;
  requestedAmountMinor: bigint;
  method: 'CASH' | 'CARD_TERMINAL' | 'BANK_TRANSFER' | 'ONLINE_GATEWAY' | 'OTHER_MANUAL';
  reasonCode: string;
}

const PROVIDER_REFUND_METHODS: ReadonlySet<string> = new Set(['CARD_TERMINAL', 'ONLINE_GATEWAY']);

/**
 * Task 3b.8 Checkpoint D — `POST .../advances/:advanceId/refunds` entry
 * point. Mirrors `CustomerReceiptRepository`'s own thin
 * "resolve-then-open-tx-then-delegate" shape.
 *
 * `method` is narrowed FIRST, as a pure check on the request itself, before
 * any DB access, transaction, lock or reservation:
 *   - `CASH`/`BANK_TRANSFER` delegate to `RefundExecutionRepository.
 *     executeLocalRefundInTx` — fully implemented, synchronous, immutable.
 *   - `OTHER_MANUAL` is rejected outright, per `Refund`'s own schema doc
 *     comment ("refund EXECUTION is application-layer-unsupported in
 *     initial 3b.8 — no exact financial account mapping exists for it").
 *   - `CARD_TERMINAL`/`ONLINE_GATEWAY` are rejected with `501
 *     REFUND_PROVIDER_NOT_IMPLEMENTED` and are COMPLETELY side-effect free:
 *     no `RefundAttempt`, no entitlement reservation, no `Refund`, no
 *     advance-balance mutation, no journal. `PaymentProvider.refund`/
 *     `getStatus` have no defined request/response shape anywhere in this
 *     repository ("shape deferred to a future refund task" / "deferred to
 *     F+"), so a durable PENDING attempt created now could never be
 *     executed or reconciled — it would only hold advance capacity hostage.
 *     This class deliberately does NOT inject
 *     `RefundAttemptReservationRepository`, so the public route
 *     structurally cannot create an attempt. The internal reservation/
 *     reconciliation foundation (`RefundAttemptReservationRepository`,
 *     `ProviderRefundEventInboxRepository`) stays intact and directly
 *     tested for the future provider-integration checkpoint to wire in.
 *
 * The route's `@Idempotent` claim is acquired before this runs and released
 * (`IdempotencyRepository.release` deletes the PENDING row) when this throws,
 * so a rejected provider request also leaves no idempotency-key reservation.
 */
@Injectable()
export class RefundRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly clock: SystemClock,
    private readonly execution: RefundExecutionRepository,
  ) {
    super(db);
  }

  async createRefundForBranchScoped(input: CreateRefundInput): Promise<ExecuteLocalRefundResult> {
    if (input.method === 'OTHER_MANUAL') {
      throw new DomainError(
        'REFUND_METHOD_NOT_SUPPORTED',
        'OTHER_MANUAL refund execution has no exact financial account mapping and is not supported in this task',
        422,
      );
    }
    if (PROVIDER_REFUND_METHODS.has(input.method)) {
      throw new DomainError(
        'REFUND_PROVIDER_NOT_IMPLEMENTED',
        `${input.method} refund execution requires a provider-backed flow (PaymentProvider.refund/getStatus) that is not yet implemented — nothing was reserved or recorded`,
        501,
      );
    }

    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;

    // ── CASH/BANK_TRANSFER — fully synchronous, local. Accounting date is
    //    resolved BEFORE the write transaction opens ("resolve, snapshot,
    //    then act"), today in the company's own accounting timezone. ────────
    const timezoneRows = await this.scoped(
      (tx) =>
        tx.$queryRaw<{ accountingTimezone: string | null }[]>`
          SELECT "accountingTimezone" FROM "company" WHERE "id" = ${input.companyId}::uuid AND "tenantId" = ${tenantId}::uuid`,
    );
    const timezone = timezoneRows[0]?.accountingTimezone;
    if (!timezoneRows[0]) throw new NotFoundError('company');
    if (!timezone) {
      throw new DomainError(
        'ORDER_COMPANY_ACCOUNTING_TIMEZONE_NOT_CONFIGURED',
        'this company has no accounting timezone configured — required to derive the civil date for the refund',
        409,
      );
    }
    const accountingDate = derivePostingDate(this.clock.now(), timezone);

    return this.scoped((tx) =>
      this.execution.executeLocalRefundInTx(tx, {
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerId: input.customerId,
        customerAdvanceId: input.customerAdvanceId,
        requestedAmountMinor: input.requestedAmountMinor,
        method: input.method as 'CASH' | 'BANK_TRANSFER',
        reasonCode: input.reasonCode,
        accountingDate,
        actorUserId,
      }),
    );
  }
}
