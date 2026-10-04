import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (task 3b.9 Checkpoint E; mirrors the frozen
// `AtomicWalkInSaleService`): the sale-level outbox event must co-commit with the sale in
// the ONE caller transaction, so this facade's two reads and the `…InTx` primitives it
// dispatches to share a single `ScopedTx`. No raw model access happens here outside the two
// `tx.$queryRaw` order reads on that already-scoped `tx`.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { ScopedTx } from '@flower/db';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { requireTenantContext, getContext } from '../../common/context/index.js';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { AtomicWalkInSaleService } from './atomic-walk-in-sale.service.js';
import { toCompleteSaleResponse, type CompleteSaleResponse } from './complete-sale-response.js';
import type { SaleCompletedPayload, SaleEventType } from './sale-events.js';

/** The validated command the controller hands over. Every scope value is trusted (route
 *  pipeline / authenticated session); there is no customer field, no money authority, no
 *  server-owned value (`operationKey`, the credit exposure) anywhere in it. */
export interface CompleteSaleCommand {
  readonly companyId: string;
  readonly branchId: string;
  readonly orderId: string;
  /** the `If-Match` header — never a body value */
  readonly expectedVersion: number;
  readonly paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
  readonly tenders: readonly { readonly method: string; readonly amountMinor: bigint }[];
  readonly advanceApplications: readonly {
    readonly advanceId: string;
    readonly amountMinor: bigint;
  }[];
  readonly creditLimitExceptionReason?: string;
  /** the request `Idempotency-Key` — the established nested operation identity (the same
   *  convention `payments.create` uses); never a second client key */
  readonly idempotencyKey: string;
}

/**
 * Task 3b.9 Checkpoint E — the THIN public application facade.
 *
 * It exists for exactly three things, and owns nothing else:
 *
 *   1. DISPATCH — the ORDER's persisted `customerId` (read under the order lock) selects the
 *      frozen anonymous PAY_NOW primitive or the frozen identified-customer primitive. There
 *      is no client mode flag. An advance request on an anonymous order is refused here with
 *      the frozen plan's own code, because the anonymous primitive's input cannot carry an
 *      advance and silently dropping one would be wrong.
 *   2. THE SALE-LEVEL EVENT — `orders.sale_completed`, enqueued in the SAME transaction as the
 *      sale (never by the controller after commit): the sale and its event commit together or
 *      not at all, and a replay never reaches this code.
 *   3. RESPONSE ASSEMBLY — rendered by the pure `toCompleteSaleResponse`.
 *
 * It contains NO tax or money formula, NO credit or exposure logic, NO payment / receivable /
 * advance / journal write — all of that lives in the frozen `AtomicWalkInSaleService`, which
 * this class only calls. It is not a second orchestrator.
 *
 * ORDER OF LOCKS is unchanged: the order row is the first lock taken (here, `FOR UPDATE`),
 * exactly the frozen primitives' own first step, which then re-lock it as a no-op.
 */
@Injectable()
export class SalesApplicationService extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly atomicSale: AtomicWalkInSaleService,
    private readonly outbox: OutboxWriter,
  ) {
    super(db);
  }

  async completeSale(command: CompleteSaleCommand): Promise<CompleteSaleResponse> {
    const { tenantId } = requireTenantContext();
    const ctx = getContext() ?? null;
    const actorUserId = ctx?.userId ?? null;

    return this.scoped(async (tx) => {
      const customerId = await this.lockOrderAndReadCustomer(tx, tenantId, command);

      const tenders = command.tenders.map((t) => ({
        method: t.method,
        amountMinor: t.amountMinor,
      }));
      const shared = {
        tenantId,
        companyId: command.companyId,
        branchId: command.branchId,
        orderId: command.orderId,
        expectedVersion: command.expectedVersion,
        paymentIntent: command.paymentIntent,
        tenders,
        operationKey: command.idempotencyKey,
        actorUserId,
      };

      let result;
      if (customerId === null) {
        if (command.advanceApplications.length > 0) {
          // the SAME code, message and status the frozen pure plan uses for this rule
          throw new DomainError(
            'SALE_ADVANCE_REQUIRES_CUSTOMER',
            'a CustomerAdvance can only be applied to an identified customer — an anonymous sale cannot use one',
            422,
          );
        }
        result = await this.atomicSale.completeAnonymousPayNowInTx(tx, shared);
      } else {
        result = await this.atomicSale.completeCustomerSaleInTx(tx, {
          ...shared,
          advances: command.advanceApplications.map((a) => ({
            advanceId: a.advanceId,
            amountMinor: a.amountMinor,
          })),
          ...(command.creditLimitExceptionReason !== undefined
            ? { creditLimitExceptionReason: command.creditLimitExceptionReason }
            : {}),
          authorizationContext: ctx,
        });
      }

      await this.enqueueSaleCompleted(tx, tenantId, command, result.invoiceId);
      return toCompleteSaleResponse(result);
    });
  }

  /** lock the order FOR UPDATE in exact tenant / company / origin-branch scope and return its
   *  persisted customer. A foreign / sibling-branch / unknown order is the same non-disclosing
   *  `404 ORDER_NOT_FOUND` the frozen gate gives. */
  private async lockOrderAndReadCustomer(
    tx: ScopedTx,
    tenantId: string,
    command: CompleteSaleCommand,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<{ customerId: string | null }[]>`
      SELECT "customerId" FROM "order"
       WHERE "id" = ${command.orderId}::uuid
         AND "tenantId" = ${tenantId}::uuid
         AND "companyId" = ${command.companyId}::uuid
         AND "originBranchId" = ${command.branchId}::uuid
       FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundError('order', 'ORDER_NOT_FOUND');
    return row.customerId;
  }

  /** `orders.sale_completed` — one coarse, bounded event, co-committed with the sale. Scoped
   *  to the sale's company AND branch (defence in depth), carrying the order's version AFTER the
   *  issuance transition, read from the authoritative row. */
  private async enqueueSaleCompleted(
    tx: ScopedTx,
    tenantId: string,
    command: CompleteSaleCommand,
    invoiceId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ version: number }[]>`
      SELECT "version" FROM "order"
       WHERE "id" = ${command.orderId}::uuid
         AND "tenantId" = ${tenantId}::uuid
         AND "companyId" = ${command.companyId}::uuid
         AND "originBranchId" = ${command.branchId}::uuid`;
    const version = rows[0]?.version;
    if (version === undefined) throw new NotFoundError('order', 'ORDER_NOT_FOUND');
    await this.outbox.enqueue(tx, {
      aggregateType: 'order',
      aggregateId: command.orderId,
      eventType: 'orders.sale_completed' satisfies SaleEventType,
      tenantId,
      companyId: command.companyId,
      branchId: command.branchId,
      resourceVersion: version,
      payload: {
        orderId: command.orderId,
        invoiceId,
      } satisfies SaleCompletedPayload,
    });
  }
}
