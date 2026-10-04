import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (task 3b.9 Checkpoint C; mirrors
// `TaxFinalizationService`, `PaymentCollectionRepository` and
// `WalkInSaleJournalRepository` exactly): the composition below must run on ONE
// caller-supplied, already-scoped transaction, so its `…InTx(tx: ScopedTx, …)`
// contract requires this type directly. No raw Prisma model access happens here
// outside `tx.$queryRaw` calls on that already-scoped `tx`.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { ScopedTx } from '@flower/db';
import {
  requireTenantContext,
  getContext,
  type RequestContext,
} from '../../common/context/index.js';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { DomainError, ForbiddenError, NotFoundError } from '../../common/errors/domain-error.js';
import { TaxFinalizationService } from '../orders/tax-finalization.service.js';
import {
  PaymentCollectionRepository,
  type CapturedTenderResult,
} from '../payments/payment-collection.repository.js';
import {
  CreditOverrideAuthorizationService,
  type AuthorizedCreditOverride,
} from '../receivables/credit-override-authorization.service.js';
import { CustomerAdvanceApplicationRepository } from '../receivables/customer-advance-application.repository.js';
import { CustomerInvoiceArRepository } from '../receivables/customer-invoice-ar.repository.js';
import {
  loadAdvanceBalances,
  loadInvoiceBalance,
} from '../receivables/receivable-balance.repository.js';
import { saleAuthorityRequirements, type SaleAuthorityRequirements } from './sale-authority.js';
import { planSale, SalePlanError, type SalePlan } from './sale-plan.js';
import { buildWalkInSaleJournal } from './walk-in-sale-journal.js';
import { WalkInSaleJournalRepository } from './walk-in-sale-journal.repository.js';

/**
 * One requested tender. Money is an exact BigInt; the currency fields are
 * OPTIONAL and default to the order's own currency / exponent — a value that
 * differs from it is rejected by the pure sale plan (`PAYMENT_CURRENCY_MISMATCH`),
 * never converted.
 */
export interface AnonymousSaleTenderInput {
  /** a plain string on purpose: an unknown / forbidden value must reach the pure plan and be rejected */
  readonly method: string;
  readonly amountMinor: bigint;
  readonly currencyCode?: string;
  readonly currencyExponent?: number;
  /** INTERNAL trust-boundary field (no public DTO can set it): a CARD_TERMINAL with one is provider-backed and rejected */
  readonly providerCredentialId?: string | null;
}

export interface CompleteAnonymousPayNowInput {
  /** trusted scope — from the authenticated `RequestContext` / route scope, never a body field */
  readonly companyId: string;
  readonly branchId: string;
  readonly orderId: string;
  /** the order version the client last saw — verified under the order lock, before any financial write */
  readonly expectedVersion: number;
  /** must be `PAY_NOW` — an anonymous sale is paid in full (credit / advances are rejected by the plan) */
  readonly paymentIntent: string;
  readonly tenders: readonly AnonymousSaleTenderInput[];
  /**
   * An OPAQUE operation key, passed through to every PaymentAttempt as historical
   * context only. This is NOT the public idempotency claim / replay (Checkpoint E
   * owns that): nothing here deduplicates on it.
   */
  readonly operationKey: string;
}

export interface CompleteAnonymousPayNowInTxInput extends CompleteAnonymousPayNowInput {
  /** trusted — from the authenticated session, passed by the caller that owns the transaction */
  readonly tenantId: string;
  readonly actorUserId: string | null;
}

export interface CompleteAnonymousPayNowResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly subtotalAmountMinor: bigint;
  readonly documentDiscountAmountMinor: bigint;
  readonly taxTotalAmountMinor: bigint;
  readonly totalAmountMinor: bigint;
  /** the status the frozen projection derived — never hand-written here */
  readonly invoicePaymentStatus: string;
  /** monetary outstanding after the sale — always 0 */
  readonly outstandingMinor: bigint;
  /** null for a single tender; one shared value for every component of a Multi Payment */
  readonly paymentGroupId: string | null;
  /** in request order */
  readonly payments: readonly CapturedTenderResult[];
  readonly journalEntryId: string;
}

/** the same tender shape, for either party — a tender is never anonymous-specific */
export type SaleTenderInput = AnonymousSaleTenderInput;

/** one CustomerAdvance the identified customer asks to spend against this sale */
export interface CustomerSaleAdvanceInput {
  readonly advanceId: string;
  readonly amountMinor: bigint;
  /** OPTIONAL — defaults to the order's own currency / exponent; a different value is rejected, never converted */
  readonly currencyCode?: string;
  readonly currencyExponent?: number;
}

export interface CompleteCustomerSaleInput {
  /** trusted scope — from the authenticated `RequestContext` / route scope, never a body field */
  readonly companyId: string;
  readonly branchId: string;
  readonly orderId: string;
  /** the order version the client last saw — verified under the order lock, before any financial write */
  readonly expectedVersion: number;
  /**
   * `PAY_NOW` or `ON_CREDIT`. There is NO customer field: the order's persisted `customerId`
   * is the only customer there is, and it can never be overridden or switched here.
   */
  readonly paymentIntent: string;
  readonly tenders: readonly SaleTenderInput[];
  readonly advances: readonly CustomerSaleAdvanceInput[];
  /**
   * The internal form of the frozen Checkpoint-E field `creditLimitExceptionReason`. A reason
   * grants NOTHING on its own: the server first determines that the credit-limit gate actually
   * denied the sale, and only then asks the frozen `CreditOverrideAuthorizationService.authorize`
   * (Owner-only + step-up + a bounded reason). There is no boolean override and no `force`.
   */
  readonly creditLimitExceptionReason?: string | null;
  /** OPAQUE — passed through to every PaymentAttempt as historical context; NOT an idempotency claim */
  readonly operationKey: string;
}

export interface CompleteCustomerSaleInTxInput extends CompleteCustomerSaleInput {
  /** trusted — from the authenticated session, passed by the caller that owns the transaction */
  readonly tenantId: string;
  readonly actorUserId: string | null;
  /** the authenticated request context — used ONLY to authorize a necessary credit-limit override */
  readonly authorizationContext: RequestContext | null;
}

export interface CustomerSaleAdvanceApplication {
  readonly applicationId: string;
  readonly advanceId: string;
  readonly amountMinor: bigint;
}

export interface CompleteCustomerSaleResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly customerId: string;
  readonly customerCompanyAccountId: string;
  readonly customerReceivableId: string;
  readonly paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
  /** how the credit gate decided: null for PAY_NOW (no gate), NORMAL within limit, OVERRIDE when the exception was used */
  readonly creditAuthorizationMode: 'NORMAL' | 'OVERRIDE' | null;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly subtotalAmountMinor: bigint;
  readonly documentDiscountAmountMinor: bigint;
  readonly taxTotalAmountMinor: bigint;
  readonly totalAmountMinor: bigint;
  /** the status the frozen projection derived — never hand-written here */
  readonly invoicePaymentStatus: string;
  /** the remaining customer receivable of THIS sale: 0 for PAY_NOW, > 0 for ON_CREDIT */
  readonly outstandingMinor: bigint;
  readonly paymentGroupId: string | null;
  /** real tenders only, in request order — credit is never a Payment */
  readonly payments: readonly CapturedTenderResult[];
  /** in ascending advance-id order — the canonical lock order */
  readonly advanceApplications: readonly CustomerSaleAdvanceApplication[];
  /** the registered permission keys the composed effects correspond to (metadata only — Checkpoint E enforces) */
  readonly authorities: SaleAuthorityRequirements;
}

/** a gate input every party shares */
interface GateInput {
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly orderId: string;
  readonly expectedVersion: number;
}

/** what the pure plan needs from the request, for either party */
interface PlanInput {
  readonly paymentIntent: string;
  readonly tenders: readonly SaleTenderInput[];
}

interface PlanParty {
  readonly customerId: string | null;
  readonly advances: readonly CustomerSaleAdvanceInput[];
}

const ANONYMOUS_PARTY: PlanParty = { customerId: null, advances: [] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LockedOrderRow {
  id: string;
  kind: string;
  status: string;
  version: number;
  customerId: string | null;
  commercialSnapshotFingerprint: string;
  currencyCode: string;
  currencyExponent: number;
}

/**
 * Task 3b.9 Checkpoint C — the internal ANONYMOUS PAY_NOW atomic sale
 * orchestrator. It composes four frozen primitives on ONE transaction:
 *
 *   DRAFT anonymous order
 *     → canonical totals            (`TaxFinalizationService.prepareFinalization`)
 *     → exact plan validation       (`planSale`, pure — BEFORE any number is allocated)
 *     → issued immutable invoice    (`TaxFinalizationService.issuePrepared`)
 *     → synchronous local tenders   (`PaymentCollectionRepository.captureSynchronousTendersInTx`)
 *     → the walk-in journal         (`WalkInSaleJournalRepository`, sourceKind `walk_in_sale`)
 *
 * and commits them together or not at all. It owns NO business arithmetic (no
 * tax, discount, rounding, tender-account or revenue formula), writes no row
 * itself, performs no external I/O, and never opens a transaction of its own
 * except in the single conventional entry point
 * {@link completeAnonymousPayNowForBranchScoped}, which opens exactly ONE scoped
 * transaction around {@link completeAnonymousPayNowInTx}.
 *
 * Observed lock order (pinned by `atomic-walk-in-sale.integration.test.ts`) —
 * the frozen ORDER → INVOICE hierarchy, with no Invoice → Order inversion:
 *
 *   order (FOR UPDATE) → order lines (FOR UPDATE) → company ORDER counter →
 *   company INVOICE counter → [order UPDATE, invoice INSERT] → order (FOR SHARE,
 *   a no-op downgrade) → invoice (FOR UPDATE) → payment_attempt / payment /
 *   payment_allocation inserts → company (FOR SHARE) → accounting period (FOR SHARE)
 *
 * Checkpoint D adds the IDENTIFIED-CUSTOMER path to this SAME service
 * ({@link completeCustomerSaleInTx}): PAY_NOW / ON_CREDIT, with local tenders and
 * CustomerAdvance applications, reusing the frozen 3b.6 AR / credit-gate / advance /
 * receipt primitives. A customer sale NEVER posts the anonymous `walk_in_sale`
 * journal — its accounting is the frozen 3b.6 set (`invoice_ar`, `customer_receipt_payment`,
 * `payment_allocation`, `customer_advance_application`). The anonymous method below is
 * unchanged byte for byte (a content-hash pin proves it).
 *
 * NOT here (later checkpoints): the public HTTP route and DTOs, the idempotency
 * claim / replay, permissions and step-up, the `orders.sale_completed` outbox
 * event, provider execution.
 */
@Injectable()
export class AtomicWalkInSaleService extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly finalization: TaxFinalizationService,
    private readonly collection: PaymentCollectionRepository,
    private readonly walkInJournal: WalkInSaleJournalRepository,
    private readonly invoiceAr: CustomerInvoiceArRepository,
    private readonly advanceApplication: CustomerAdvanceApplicationRepository,
    private readonly creditOverride: CreditOverrideAuthorizationService,
  ) {
    super(db);
  }

  /**
   * The conventional entry point: tenant and actor come from the authenticated
   * `RequestContext`, and exactly ONE scoped transaction wraps the whole sale.
   */
  async completeAnonymousPayNowForBranchScoped(
    input: CompleteAnonymousPayNowInput,
  ): Promise<CompleteAnonymousPayNowResult> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;
    return this.scoped((tx) =>
      this.completeAnonymousPayNowInTx(tx, { ...input, tenantId, actorUserId }),
    );
  }

  /**
   * The whole sale on the CALLER's already-open, already-scoped transaction. Any
   * failure — a domain rejection or an unexpected error — propagates and the
   * caller's rollback removes every effect (numbers, invoice, payments,
   * allocations, journal, audit and outbox rows).
   */
  async completeAnonymousPayNowInTx(
    tx: ScopedTx,
    input: CompleteAnonymousPayNowInTxInput,
  ): Promise<CompleteAnonymousPayNowResult> {
    if (typeof input.operationKey !== 'string' || input.operationKey.trim() === '') {
      throw new DomainError('SALE_OPERATION_KEY_REQUIRED', 'an operation key is required', 422);
    }
    if (typeof input.expectedVersion !== 'number') {
      throw new DomainError(
        'ORDER_VERSION_REQUIRED',
        'the expected order version is required',
        422,
      );
    }
    const scope = {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      orderId: input.orderId,
    };

    // ── 1. ORDER FIRST: lock it in exact trusted scope and gate its state. A wrong
    //      tenant / company / branch matches nothing — the same non-disclosing
    //      `ORDER_NOT_FOUND` every order primitive returns. ──────────────────────
    const order = await this.lockAndGateOrder(tx, input);

    // ── 2. the ONE canonical computation over the locked order + lines. Writes
    //      nothing and allocates no number. ───────────────────────────────────
    const prepared = await this.finalization.prepareFinalization(tx, scope);
    const totals = prepared.totals;

    // ── 3. validate the payment request against the FINAL total BEFORE issuance:
    //      a bad request burns no order / invoice number. ───────────────────────
    const plan = this.planPayment(input, totals);

    // ── 4. issue the immutable invoice (numbers allocated here, inside this tx) ─
    const issued = await this.finalization.issuePrepared(tx, prepared, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      orderId: input.orderId,
      expectedVersion: input.expectedVersion,
      commercialSnapshotFingerprint: order.commercialSnapshotFingerprint,
      paymentIntent: 'PAY_NOW',
      actorUserId: input.actorUserId,
    });
    if (issued.customerReceivableId !== null) {
      throw new DomainError(
        'SALE_ANONYMOUS_INVARIANT_VIOLATED',
        'an anonymous sale produced a customer receivable',
        500,
      );
    }

    // ── 5. synchronous local tenders → Payment + PaymentAllocation (frozen
    //      primitive: one attempt / event / payment / allocation per tender, in
    //      request order; the invoice payment status is derived by it). ─────────
    const captured = await this.collection.captureSynchronousTendersInTx(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      invoiceId: issued.invoiceId,
      amountMinor: plan.tenderTotalMinor,
      tenders: plan.tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor })),
      createdByUserId: input.actorUserId,
      actingUserId: input.actorUserId,
      idempotencyKey: input.operationKey,
    });

    // ── 6. the sale must now be fully covered: zero monetary outstanding, and a
    //      payment status the frozen projection derived (never written here). ────
    const balance = await loadInvoiceBalance(tx, {
      tenantId: input.tenantId,
      invoiceId: issued.invoiceId,
    });
    const statusRows = await tx.$queryRaw<{ invoicePaymentStatus: string }[]>`
      SELECT "invoicePaymentStatus" FROM "invoice" WHERE "id" = ${issued.invoiceId}::uuid`;
    const invoicePaymentStatus = statusRows[0]?.invoicePaymentStatus ?? '';
    if (
      balance.outstandingMinor !== 0n ||
      captured.remainingAvailableToCollectMinor !== 0n ||
      (invoicePaymentStatus !== 'PAID' && invoicePaymentStatus !== 'SETTLED')
    ) {
      throw new DomainError(
        'SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED',
        `an anonymous PAY_NOW sale must be fully covered (outstanding ${balance.outstandingMinor}, status ${invoicePaymentStatus})`,
        500,
      );
    }

    // ── 7. the walk-in journal — the ONLY sale-revenue GL of an anonymous sale,
    //      built by the frozen pure builder and posted by the frozen adapter. ─────
    const journalPlan = buildWalkInSaleJournal({
      invoiceId: issued.invoiceId,
      customerId: null,
      currencyCode: totals.currencyCode,
      currencyExponent: totals.currencyExponent,
      totalAmountMinor: totals.totalAmountMinor,
      taxTotalAmountMinor: totals.taxTotalAmountMinor,
      tenders: plan.tenders,
    });
    const journal = await this.walkInJournal.postWalkInSaleJournalInTx(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      invoiceId: issued.invoiceId,
      plan: journalPlan,
      actorUserId: input.actorUserId,
    });
    if (!journal.created) {
      throw new DomainError(
        'SALE_ANONYMOUS_INVARIANT_VIOLATED',
        'a walk-in journal already existed for a brand-new invoice',
        500,
      );
    }

    return {
      orderId: issued.orderId,
      orderNumber: issued.orderNumber,
      invoiceId: issued.invoiceId,
      invoiceNumber: issued.invoiceNumber,
      currencyCode: totals.currencyCode,
      currencyExponent: totals.currencyExponent,
      subtotalAmountMinor: totals.subtotalAmountMinor,
      documentDiscountAmountMinor: totals.documentDiscountAmountMinor,
      taxTotalAmountMinor: totals.taxTotalAmountMinor,
      totalAmountMinor: totals.totalAmountMinor,
      invoicePaymentStatus,
      outstandingMinor: balance.outstandingMinor,
      paymentGroupId: captured.paymentGroupId,
      payments: captured.payments,
      journalEntryId: journal.journalEntryId,
    };
  }

  /**
   * The conventional entry point of the identified-customer path: tenant, actor and
   * the authorization context come from the authenticated `RequestContext`, and
   * exactly ONE scoped transaction wraps the whole sale.
   */
  async completeCustomerSaleForBranchScoped(
    input: CompleteCustomerSaleInput,
  ): Promise<CompleteCustomerSaleResult> {
    const { tenantId } = requireTenantContext();
    const ctx = getContext() ?? null;
    const actorUserId = ctx?.userId ?? null;
    return this.scoped((tx) =>
      this.completeCustomerSaleInTx(tx, {
        ...input,
        tenantId,
        actorUserId,
        authorizationContext: ctx,
      }),
    );
  }

  /**
   * The whole identified-customer sale on the CALLER's already-open transaction:
   *
   *   order lock + gate (DRAFT, version, WALK_IN, customerId PRESENT) → canonical totals →
   *   pure plan (intent / tenders / advances / PAY_NOW conservation / ON_CREDIT remainder) →
   *   customer pre-flight under the account lock (credit gate; the override only if the
   *   server finds it necessary) → advance pre-check → invoice issuance (frozen: receivable +
   *   `invoice_ar` journal) → advance applications (ascending id) → local tenders →
   *   coverage check.
   *
   * Everything that can be refused is refused BEFORE a number is allocated; everything is
   * on the caller's transaction, so a failure anywhere removes every effect.
   */
  async completeCustomerSaleInTx(
    tx: ScopedTx,
    input: CompleteCustomerSaleInTxInput,
  ): Promise<CompleteCustomerSaleResult> {
    if (typeof input.operationKey !== 'string' || input.operationKey.trim() === '') {
      throw new DomainError('SALE_OPERATION_KEY_REQUIRED', 'an operation key is required', 422);
    }
    if (typeof input.expectedVersion !== 'number') {
      throw new DomainError(
        'ORDER_VERSION_REQUIRED',
        'the expected order version is required',
        422,
      );
    }
    const scope = {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      orderId: input.orderId,
    };

    // ── 1. ORDER FIRST: lock + gate. The customer is the ORDER's persisted customer —
    //      nothing in the request can name or change it. ─────────────────────────
    const order = await this.lockAndGateOrder(tx, input, 'CUSTOMER');
    const customerId = order.customerId;
    if (customerId === null) {
      throw new DomainError(
        'SALE_ORDER_NOT_CUSTOMER_LINKED',
        'a customer sale requires an order linked to a customer',
        409,
      );
    }

    // ── 2. the ONE canonical computation (writes nothing, allocates no number) ──
    const prepared = await this.finalization.prepareFinalization(tx, scope);
    const totals = prepared.totals;

    // ── 3. the pure request plan, against the FINAL total ──────────────────────
    for (const a of input.advances) {
      if (typeof a.advanceId !== 'string' || !UUID_RE.test(a.advanceId)) {
        throw new DomainError('SALE_ADVANCE_INVALID', 'advanceId must be a valid identifier', 422);
      }
    }
    const plan = this.planPayment(input, totals, { customerId, advances: input.advances });
    const intent = plan.intent;

    // ── 3b. the credit EXPOSURE this sale adds (owner ruling): invoice total − same-sale tenders −
    //       same-sale advances. Computed HERE, from the validated plan and the canonical total —
    //       never from the request. This, not the gross invoice total, is what the credit limit
    //       is tested against. ────────────────────────────────────────────────────────────────
    const finalSaleOutstanding = this.finalSaleOutstanding(plan, totals);

    // ── 4. customer pre-flight under the account lock: the frozen credit gate (on the exposure),
    //      and the override ONLY when the server finds it necessary ───────────────────────────
    const preflight = await this.preflightCustomer(
      tx,
      input,
      customerId,
      intent,
      finalSaleOutstanding,
    );

    // ── 5. advance pre-check (the frozen applyInTx re-validates under its locks) ──
    await this.assertAdvancesApplicable(
      tx,
      input,
      preflight.customerCompanyAccountId,
      plan,
      totals,
    );

    // ── 6. issue the invoice (frozen: credit gate again — on the SAME exposure — numbers,
    //      receivable, invoice_ar) ────────────────────────────────────────────────────────
    const issued = await this.finalization.issuePrepared(tx, prepared, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      orderId: input.orderId,
      expectedVersion: input.expectedVersion,
      commercialSnapshotFingerprint: order.commercialSnapshotFingerprint,
      paymentIntent: intent,
      ...(preflight.creditOverride !== undefined
        ? { creditOverride: preflight.creditOverride }
        : {}),
      finalSaleOutstandingMinor: finalSaleOutstanding,
      actorUserId: input.actorUserId,
    });
    if (issued.customerReceivableId === null) {
      throw new DomainError(
        'SALE_CUSTOMER_INVARIANT_VIOLATED',
        'a customer sale produced no customer receivable',
        500,
      );
    }
    const customerReceivableId = issued.customerReceivableId;

    // ── 7. CustomerAdvance applications — the frozen primitive, in ascending id order ──
    const advanceApplications: CustomerSaleAdvanceApplication[] = [];
    for (const a of plan.advances) {
      const applied = await this.advanceApplication.applyInTx(tx, {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerId,
        advanceId: a.advanceId,
        customerReceivableId,
        amountMinor: a.amountMinor,
        actorUserId: input.actorUserId,
      });
      advanceApplications.push({
        applicationId: applied.applicationId,
        advanceId: a.advanceId,
        amountMinor: a.amountMinor,
      });
    }

    // ── 8. synchronous local tenders — REAL tenders only; credit is never a Payment ──
    const captured =
      plan.tenders.length > 0
        ? await this.collection.captureSynchronousTendersInTx(tx, {
            tenantId: input.tenantId,
            companyId: input.companyId,
            branchId: input.branchId,
            invoiceId: issued.invoiceId,
            amountMinor: plan.tenderTotalMinor,
            tenders: plan.tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor })),
            createdByUserId: input.actorUserId,
            actingUserId: input.actorUserId,
            idempotencyKey: input.operationKey,
          })
        : null;

    // ── 9. the sale must now stand exactly as planned ──────────────────────────
    const balance = await loadInvoiceBalance(tx, {
      tenantId: input.tenantId,
      invoiceId: issued.invoiceId,
    });
    const statusRows = await tx.$queryRaw<{ invoicePaymentStatus: string }[]>`
      SELECT "invoicePaymentStatus" FROM "invoice" WHERE "id" = ${issued.invoiceId}::uuid`;
    const invoicePaymentStatus = statusRows[0]?.invoicePaymentStatus ?? '';
    const statusAllowed =
      intent === 'PAY_NOW'
        ? invoicePaymentStatus === 'PAID' || invoicePaymentStatus === 'SETTLED'
        : invoicePaymentStatus === 'UNPAID' || invoicePaymentStatus === 'PARTIAL';
    if (
      balance.outstandingMinor !== finalSaleOutstanding ||
      (captured !== null && captured.remainingAvailableToCollectMinor !== finalSaleOutstanding) ||
      !statusAllowed
    ) {
      throw new DomainError(
        'SALE_PAYMENT_COVERAGE_INVARIANT_VIOLATED',
        `a ${intent} customer sale must end with outstanding ${finalSaleOutstanding} (outstanding ${balance.outstandingMinor}, status ${invoicePaymentStatus})`,
        500,
      );
    }
    // the credit the gate tested is exactly the credit that was committed: the customer's account
    // now stands at (the locked existing outstanding + this sale's final outstanding), no more
    await this.assertExposureProjection(tx, input, preflight, finalSaleOutstanding);

    return {
      orderId: issued.orderId,
      orderNumber: issued.orderNumber,
      invoiceId: issued.invoiceId,
      invoiceNumber: issued.invoiceNumber,
      customerId,
      customerCompanyAccountId: preflight.customerCompanyAccountId,
      customerReceivableId,
      paymentIntent: intent,
      creditAuthorizationMode: issued.creditAuthorizationMode,
      currencyCode: totals.currencyCode,
      currencyExponent: totals.currencyExponent,
      subtotalAmountMinor: totals.subtotalAmountMinor,
      documentDiscountAmountMinor: totals.documentDiscountAmountMinor,
      taxTotalAmountMinor: totals.taxTotalAmountMinor,
      totalAmountMinor: totals.totalAmountMinor,
      invoicePaymentStatus,
      outstandingMinor: balance.outstandingMinor,
      paymentGroupId: captured?.paymentGroupId ?? null,
      payments: captured?.payments ?? [],
      advanceApplications,
      authorities: saleAuthorityRequirements({
        tenderCount: plan.tenders.length,
        advanceCount: plan.advances.length,
        creditOverrideUsed: issued.creditAuthorizationMode === 'OVERRIDE',
      }),
    };
  }

  /**
   * The credit exposure this sale ADDS to the customer's receivable outstanding — the amount the
   * credit limit is tested against (owner ruling: the resulting receivable exposure, not the gross
   * invoice total): invoice total − same-sale tenders − same-sale advances. It is computed from the
   * canonical total and the validated plan (exact BigInt, one currency), never from the request, and
   * must agree with the pure plan's own remainder — otherwise the sale fails closed. PAY_NOW is 0.
   */
  private finalSaleOutstanding(
    plan: SalePlan,
    totals: { totalAmountMinor: bigint; currencyCode: string; currencyExponent: number },
  ): bigint {
    // the remainder is owned by the frozen pure plan (total − tenders − advances); conservation is
    // re-proven here by ADDITION against the canonical total — this module owns no money formula
    const exposure = plan.outstandingMinor;
    if (
      plan.currencyCode !== totals.currencyCode ||
      plan.currencyExponent !== totals.currencyExponent ||
      plan.totalAmountMinor !== totals.totalAmountMinor ||
      exposure < 0n ||
      plan.tenderTotalMinor + plan.advanceTotalMinor + exposure !== totals.totalAmountMinor
    ) {
      throw new DomainError(
        'SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED',
        `the credit exposure ${exposure} does not complete the sale plan (tenders ${plan.tenderTotalMinor}, advances ${plan.advanceTotalMinor}, total ${totals.totalAmountMinor})`,
        500,
      );
    }
    return exposure;
  }

  /**
   * Lock the customer account (the frozen, join-gated lock) and run the frozen credit gate on the
   * sale's EXPOSURE (`exposureMinor` = what this sale leaves owing after its same-sale tenders and
   * advances — never the gross invoice total). The gate is the frozen one: existing outstanding +
   * that exposure against the limit. When it denies the sale, THE SERVER has determined an override
   * is necessary: only then, and only if a reason was supplied, is the frozen `authorize()`
   * consulted (it enforces Owner-only + step-up + a bounded, non-empty reason). A reason when no
   * override is needed is ignored; with no reason the denial stands. The locked existing outstanding
   * is returned so the final postcondition can prove what was committed.
   */
  private async preflightCustomer(
    tx: ScopedTx,
    input: CompleteCustomerSaleInTxInput,
    customerId: string,
    intent: 'PAY_NOW' | 'ON_CREDIT',
    exposureMinor: bigint,
  ): Promise<{
    customerCompanyAccountId: string;
    existingOutstandingMinor: bigint;
    creditOverride?: AuthorizedCreditOverride;
  }> {
    const gate = {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerId,
      paymentIntent: intent,
      proposedAmountMinor: exposureMinor,
    };
    try {
      const allowed = await this.invoiceAr.lockAndAuthorizeCredit(tx, gate);
      return {
        customerCompanyAccountId: allowed.account.id,
        existingOutstandingMinor: allowed.account.currentOutstandingMinor,
      };
    } catch (err) {
      const denied = err instanceof DomainError && err.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED';
      const reason = input.creditLimitExceptionReason;
      if (!denied || reason === undefined || reason === null) throw err;
      // the gate denied the sale (server-determined) and an exception was requested
      if (input.authorizationContext === null) {
        throw new ForbiddenError(
          'credit-limit override denied (no authenticated context)',
          'CREDIT_OVERRIDE_DENIED',
        );
      }
      const creditOverride = this.creditOverride.authorize(input.authorizationContext, reason);
      const overridden = await this.invoiceAr.lockAndAuthorizeCredit(tx, {
        ...gate,
        creditOverride,
      });
      return {
        customerCompanyAccountId: overridden.account.id,
        existingOutstandingMinor: overridden.account.currentOutstandingMinor,
        creditOverride,
      };
    }
  }

  /**
   * POSTCONDITION of the exposure rule: the credit the gate tested is exactly the credit committed.
   * After the invoice, the advances and the tenders, the customer account's stored outstanding (the
   * very column the gate evaluates) must equal the existing outstanding that was locked in the
   * pre-flight plus this sale's final outstanding. The account lock has been held since the
   * pre-flight, so nothing else could have moved it; any difference fails the sale closed and the
   * caller's transaction rolls every effect back.
   */
  private async assertExposureProjection(
    tx: ScopedTx,
    input: CompleteCustomerSaleInTxInput,
    preflight: { customerCompanyAccountId: string; existingOutstandingMinor: bigint },
    finalSaleOutstanding: bigint,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ currentOutstandingMinor: bigint }[]>`
      SELECT "currentOutstandingMinor" FROM "customer_company_account"
       WHERE "id" = ${preflight.customerCompanyAccountId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid`;
    const committed = rows[0]?.currentOutstandingMinor;
    if (committed !== preflight.existingOutstandingMinor + finalSaleOutstanding) {
      throw new DomainError(
        'SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED',
        `the customer account must end at ${preflight.existingOutstandingMinor + finalSaleOutstanding} (existing ${preflight.existingOutstandingMinor} + this sale ${finalSaleOutstanding}), not ${String(committed)}`,
        500,
      );
    }
  }

  /**
   * Refuse a bad advance BEFORE any number is allocated: it must exist for THIS customer's
   * account in THIS branch (a foreign / sibling-branch / other-customer advance is the same
   * non-disclosing 404), carry the sale's currency, and hold enough available balance. The
   * frozen `applyInTx` re-validates all of it under its own locks.
   */
  private async assertAdvancesApplicable(
    tx: ScopedTx,
    input: CompleteCustomerSaleInTxInput,
    customerCompanyAccountId: string,
    plan: SalePlan,
    totals: { currencyCode: string; currencyExponent: number },
  ): Promise<void> {
    for (const a of plan.advances) {
      const [record] = await loadAdvanceBalances(tx, {
        tenantId: input.tenantId,
        companyId: input.companyId,
        customerCompanyAccountId,
        branchId: input.branchId,
        advanceId: a.advanceId,
      });
      if (!record) throw new NotFoundError('customer_advance', 'CUSTOMER_ADVANCE_NOT_FOUND');
      if (
        record.currencyCode !== totals.currencyCode ||
        record.currencyExponent !== totals.currencyExponent
      ) {
        throw new DomainError(
          'PAYMENT_CURRENCY_MISMATCH',
          "the advance's currency does not match the sale's currency",
          422,
        );
      }
      if (record.availableMinor < a.amountMinor) {
        throw new DomainError(
          'CUSTOMER_ADVANCE_APPLICATION_INVALID',
          `the advance has ${record.availableMinor} available, less than the requested ${a.amountMinor}`,
          409,
        );
      }
    }
  }

  /** lock the order FOR UPDATE in exact scope, then gate kind / customer / status / version */
  private async lockAndGateOrder(
    tx: ScopedTx,
    input: GateInput,
    party: 'ANONYMOUS' | 'CUSTOMER' = 'ANONYMOUS',
  ): Promise<LockedOrderRow> {
    const rows = await tx.$queryRaw<LockedOrderRow[]>`
      SELECT "id", "kind", "status", "version", "customerId",
             "commercialSnapshotFingerprint", "currencyCode", "currencyExponent"
        FROM "order"
       WHERE "id" = ${input.orderId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "originBranchId" = ${input.branchId}::uuid
       FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');

    if (order.status !== 'DRAFT') {
      throw new DomainError(
        'ORDER_INVALID_STATE_TRANSITION',
        `a sale can only complete a DRAFT order (currently ${order.status}) — a HELD order must resume first`,
        409,
      );
    }
    if (order.version !== input.expectedVersion) {
      throw new DomainError(
        'ORDER_VERSION_CONFLICT',
        `order changed elsewhere (expected version ${input.expectedVersion}, now ${order.version})`,
        409,
      );
    }
    if (order.kind !== 'WALK_IN') {
      throw new DomainError(
        'SALE_ORDER_KIND_UNSUPPORTED',
        `only a WALK_IN order can complete an atomic sale (this order is ${order.kind})`,
        409,
      );
    }
    if (party === 'ANONYMOUS' && order.customerId !== null) {
      throw new DomainError(
        'SALE_ORDER_CUSTOMER_LINKED',
        'an anonymous sale cannot complete a customer-linked order',
        409,
      );
    }
    if (party === 'CUSTOMER' && order.customerId === null) {
      throw new DomainError(
        'SALE_ORDER_NOT_CUSTOMER_LINKED',
        'a customer sale cannot complete an anonymous order',
        409,
      );
    }
    return order;
  }

  /** map the pure plan's typed failures onto the DomainError the HTTP layer renders */
  private planPayment(
    input: PlanInput,
    totals: { totalAmountMinor: bigint; currencyCode: string; currencyExponent: number },
    party: PlanParty = ANONYMOUS_PARTY,
  ): SalePlan {
    let plan: SalePlan;
    try {
      plan = planSale({
        intent: input.paymentIntent,
        customerId: party.customerId,
        total: {
          amountMinor: totals.totalAmountMinor,
          currencyCode: totals.currencyCode,
          currencyExponent: totals.currencyExponent,
        },
        tenders: input.tenders.map((t) => ({
          method: t.method,
          amountMinor: t.amountMinor,
          currencyCode: t.currencyCode ?? totals.currencyCode,
          currencyExponent: t.currencyExponent ?? totals.currencyExponent,
          ...(t.providerCredentialId !== undefined
            ? { providerCredentialId: t.providerCredentialId }
            : {}),
        })),
        advances: party.advances.map((a) => ({
          advanceId: a.advanceId,
          amountMinor: a.amountMinor,
          currencyCode: a.currencyCode ?? totals.currencyCode,
          currencyExponent: a.currencyExponent ?? totals.currencyExponent,
        })),
      });
    } catch (err) {
      if (err instanceof SalePlanError) {
        throw new DomainError(err.code, err.message, err.httpStatus);
      }
      throw err;
    }
    return plan;
  }
}
