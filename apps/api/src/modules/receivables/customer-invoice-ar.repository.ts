import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `InvoiceIssuanceRepository`/
// `PostingEngineService` exactly): this is an internal primitive that must
// PARTICIPATE in the caller's already-open transaction, never open its own.
import type { ScopedTx } from '@flower/db';
import { DomainError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { evaluateCreditAuthorization } from './credit-exposure.js';
import {
  computeCreditAuthorizedFlag,
  requiresCreditGate,
  type PaymentIntent,
} from './payment-intent.js';
import { assertCustomerReceivableSourceShape } from './customer-receivable-source.js';
import { assertCustomerAccountEntryReferenceShape } from './customer-account-entry.js';
import type { AuthorizedCreditOverride } from './credit-override-authorization.service.js';

export type CreditAuthorizationMode = 'NORMAL' | 'OVERRIDE' | null;

export interface LockedCustomerAccount {
  readonly id: string;
  readonly creditEnabled: boolean;
  readonly creditLimitMinor: bigint | null;
  readonly currentOutstandingMinor: bigint;
}

export interface AuthorizeCreditInput {
  tenantId: string;
  companyId: string;
  customerId: string;
  paymentIntent: PaymentIntent;
  /** the proposed NEW invoice's own totalAmountMinor — the amount that would
   *  be ADDED to `currentOutstandingMinor` if this issuance proceeds. */
  proposedAmountMinor: bigint;
  creditOverride?: AuthorizedCreditOverride;
}

export interface AuthorizeCreditResult {
  account: LockedCustomerAccount;
  creditAuthorized: boolean;
  authorizationMode: CreditAuthorizationMode;
}

export interface CreateReceivableForInvoiceInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerCompanyAccountId: string;
  invoiceId: string;
  totalAmountMinor: bigint;
  taxTotalAmountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  creditAuthorized: boolean;
  authorizationMode: CreditAuthorizationMode;
  creditOverride?: AuthorizedCreditOverride;
  actorUserId?: string | null;
}

export interface CreateReceivableForInvoiceResult {
  customerReceivableId: string;
  journalEntryId: string;
}

/**
 * Task 3b.6 Checkpoint C — the customer-linked-Invoice AR primitive. NOT
 * HTTP-exposed. Called only from `InvoiceIssuanceRepository.issueFinalInvoice`
 * (Task 3b.3's internal-only primitive) for a customer-linked Order — a
 * walk-in Invoice (no `Order.customerId`) never calls this at all (3b.6
 * architecture-freeze: walk-in gets ZERO 3b.6 AR/GL — enforced by the
 * CALLER's own `if (order.customerId)` gate, not duplicated here).
 *
 * Two-phase contract, both phases participating in the caller's `ScopedTx`:
 *   1. `lockAndAuthorizeCredit` — locks `CustomerCompanyAccount` `FOR UPDATE`
 *      (the credit-limit hard gate's authoritative serialization point —
 *      B15's lock-order graph places this tier before Payment/CustomerAdvance,
 *      and no Checkpoint-B trigger ever locks it, so no deadlock risk exists
 *      with any B trigger path) and evaluates the frozen Checkpoint-A
 *      `evaluateCreditAuthorization` against the FRESHLY-LOCKED
 *      `currentOutstandingMinor` — never a stale pre-lock read. Called BEFORE
 *      the caller allocates document numbers / mutates the Order, so a denied
 *      credit sale wastes no gapless number and mutates nothing.
 *   2. `createReceivableForInvoice` — called AFTER the caller's Invoice row
 *      exists (needs `invoiceId`), using the SAME held lock: creates the
 *      `CustomerReceivable`(INVOICE) + `CustomerAccountEntry`(INVOICE),
 *      increments `currentOutstandingMinor` by the exact locked value plus
 *      the new invoice total, posts the `invoice_ar` journal, and audits.
 */
@Injectable()
export class CustomerInvoiceArRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly audit: AuditWriter,
  ) {}

  async lockAndAuthorizeCredit(
    tx: ScopedTx,
    input: AuthorizeCreditInput,
  ): Promise<AuthorizeCreditResult> {
    const account = await this.lockAccount(tx, input.tenantId, input.companyId, input.customerId);

    let creditGateAllowed = false;
    let authorizationMode: CreditAuthorizationMode = null;

    if (requiresCreditGate(input.paymentIntent)) {
      const evaluation = evaluateCreditAuthorization(
        {
          creditEnabled: account.creditEnabled,
          creditLimitMinor: account.creditLimitMinor,
          receivableOutstandingMinor: account.currentOutstandingMinor,
        },
        input.proposedAmountMinor,
      );

      if (evaluation.outcome === 'ALLOWED') {
        creditGateAllowed = true;
        authorizationMode = 'NORMAL';
      } else if (evaluation.outcome === 'DISABLED') {
        // Hardening pass §11 — a credit override authorizes bypassing
        // LIMIT_EXCEEDED only. A customer who was never extended credit at
        // all (`creditEnabled=false`) is an unconditional hard policy block,
        // never overridable by a one-sale exception — ADR-0019 §1 describes
        // the override only in terms of "a sale that would push
        // `current_outstanding` past `credit_limit`", never in terms of
        // extending credit to an un-approved customer. Enabling credit for a
        // customer requires the separate, deliberate `customers:credit:manage`
        // action (Task 3b.2), never a per-sale shortcut.
        throw new DomainError(
          'CUSTOMER_CREDIT_DISABLED',
          'credit is not enabled for this customer at this company',
          422,
        );
      } else if (input.creditOverride) {
        // evaluation.outcome === 'LIMIT_EXCEEDED' — the only overridable case.
        creditGateAllowed = true;
        authorizationMode = 'OVERRIDE';
      } else {
        throw new DomainError(
          'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
          `credit limit ${evaluation.creditLimitMinor} would be exceeded (projected exposure ${evaluation.projectedExposureMinor})`,
          409,
        );
      }
    }

    const creditAuthorized = computeCreditAuthorizedFlag(input.paymentIntent, creditGateAllowed);
    return { account, creditAuthorized, authorizationMode };
  }

  async createReceivableForInvoice(
    tx: ScopedTx,
    input: CreateReceivableForInvoiceInput,
  ): Promise<CreateReceivableForInvoiceResult> {
    assertCustomerReceivableSourceShape({
      sourceType: 'INVOICE',
      invoiceId: input.invoiceId,
      creditAuthorized: input.creditAuthorized,
    });

    const receivable = await tx.customerReceivable.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        sourceType: 'INVOICE',
        invoiceId: input.invoiceId,
        creditAuthorized: input.creditAuthorized,
      },
    });

    assertCustomerAccountEntryReferenceShape('INVOICE', { customerReceivableId: receivable.id });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'INVOICE',
        customerReceivableId: receivable.id,
      },
    });

    // C13 — the exact DB value after the lock acquired in `lockAndAuthorizeCredit`
    // (held continuously since — no other transaction could have mutated this
    // row in between). Checkpoint C only ever increases this projection.
    //
    // Hardening pass §8 — `version` is deliberately NOT incremented here.
    // Evidence: Task 3b.2 introduced `version` when credit CONFIGURATION
    // (`creditEnabled`/`creditLimitMinor`) was the only mutable concern on
    // this row at all — `configureCredit`'s own `expectedVersion`/If-Match
    // check exists to protect a caller editing THAT configuration from a
    // lost update against another concurrent config edit, never against an
    // unrelated financial event. Bumping the SAME `version` here would make
    // an Owner's credit-config PATCH spuriously conflict merely because an
    // unconnected customer purchase happened to post in between — a
    // confusing, incorrect coupling of two independent concerns sharing one
    // row. Column-level partial `UPDATE`s (this one touches only
    // `currentOutstandingMinor`; `configureCredit`'s touches only the credit-
    // config columns + `version`) already make concurrent writes to the two
    // concerns lossless without any shared version field — proven by this
    // hardening pass's own concurrency regression (§8/§9 below). The `FOR
    // UPDATE` lock acquired in `lockAndAuthorizeCredit` remains the
    // authoritative serialization mechanism for the projection itself.
    await tx.customerCompanyAccount.update({
      where: { id: input.customerCompanyAccountId },
      data: {
        currentOutstandingMinor: { increment: input.totalAmountMinor },
      },
    });

    const revenueAmountMinor = input.totalAmountMinor - input.taxTotalAmountMinor;
    const lines = [
      {
        accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
        direction: 'debit' as const,
        amountMinor: input.totalAmountMinor,
      },
      // C14/C16 — omit a zero-value line (the sealed-journal
      // `journal_line_exactly_one_side` CHECK rejects any line whose debit
      // AND credit are both zero) — never a meaningless placeholder line.
      ...(revenueAmountMinor > 0n
        ? [
            {
              accountKey: 'REVENUE.SALES',
              direction: 'credit' as const,
              amountMinor: revenueAmountMinor,
            },
          ]
        : []),
      ...(input.taxTotalAmountMinor > 0n
        ? [
            {
              accountKey: 'LIABILITY.TAX_PAYABLE',
              direction: 'credit' as const,
              amountMinor: input.taxTotalAmountMinor,
            },
          ]
        : []),
    ];
    const journal = await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      sourceKind: 'invoice_ar',
      sourceId: input.invoiceId,
      branchId: input.branchId,
      lines,
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'receivable.created',
      resourceType: 'customer_receivable',
      resourceId: receivable.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      actorUserId: input.actorUserId ?? null,
      after: {
        customerCompanyAccountId: input.customerCompanyAccountId,
        invoiceId: input.invoiceId,
        amountMinor: input.totalAmountMinor.toString(),
        currencyCode: input.currencyCode,
        creditAuthorized: input.creditAuthorized,
        authorizationMode: input.authorizationMode,
      },
    });

    if (input.authorizationMode === 'OVERRIDE' && input.creditOverride) {
      await this.audit.record(tx, {
        action: 'credit_limit.override_used',
        resourceType: 'customer_company_account',
        resourceId: input.customerCompanyAccountId,
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        actorUserId: input.creditOverride.actorUserId,
        reason: input.creditOverride.reason,
        after: { invoiceId: input.invoiceId },
      });
    }

    return { customerReceivableId: receivable.id, journalEntryId: journal.journalEntryId };
  }

  /**
   * Join-gated `FOR UPDATE` lock (C4) — never trusts a caller-supplied
   * account id. Derives the account from `(tenantId, companyId, customerId)`
   * only, joined through `customer` to prove the customer itself belongs to
   * this tenant. Fails closed (404) if the customer has no association with
   * this company — cross-company account substitution is structurally
   * impossible (no other predicate could ever select a different company's
   * row for this customerId).
   */
  private async lockAccount(
    tx: ScopedTx,
    tenantId: string,
    companyId: string,
    customerId: string,
  ): Promise<LockedCustomerAccount> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        creditEnabled: boolean;
        creditLimitMinor: bigint | null;
        currentOutstandingMinor: bigint;
      }[]
    >`
      SELECT cca."id", cca."creditEnabled", cca."creditLimitMinor", cca."currentOutstandingMinor"
        FROM "customer_company_account" cca
        INNER JOIN "customer" c ON c."tenantId" = cca."tenantId" AND c."id" = cca."customerId"
       WHERE cca."tenantId" = ${tenantId}::uuid
         AND cca."companyId" = ${companyId}::uuid
         AND cca."customerId" = ${customerId}::uuid
       FOR UPDATE OF cca`;
    const row = rows[0];
    if (!row) {
      throw new DomainError(
        'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND',
        'this customer is not associated with the current company',
        404,
      );
    }
    return row;
  }
}
