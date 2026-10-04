import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (task 3b.9 Checkpoint B; mirrors
// `PostingEngineService`, `InvoiceIssuanceRepository` and
// `PaymentCollectionRepository` exactly): this is an internal primitive that
// must PARTICIPATE in a caller's already-open transaction, never open its own —
// its public `postWalkInSaleJournalInTx(tx: ScopedTx, ...)` contract requires
// this type directly. No raw Prisma model access happens here outside
// `tx.$queryRaw` calls on the caller-supplied, already-scoped `tx`.
import type { ScopedTx } from '@flower/db';
import { currencyExponent } from '@flower/money';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import {
  DEBIT_ACCOUNT_ORDER,
  REVENUE_ACCOUNT_KEY,
  TAX_PAYABLE_ACCOUNT_KEY,
  WALK_IN_SALE_SOURCE_KIND,
  type WalkInSaleJournalPlan,
} from './walk-in-sale-journal.js';

/**
 * Task 3b.9 Checkpoint B — posts the ONE `walk_in_sale` journal of an issued
 * ANONYMOUS walk-in invoice, by handing the frozen Checkpoint-A plan
 * (`buildWalkInSaleJournal`) to the frozen `PostingEngineService`.
 *
 * This is deliberately a thin adapter. It owns exactly five things:
 *
 *   1. it accepts the CALLER's already-open `ScopedTx` — it never opens,
 *      commits or rolls back a transaction, and performs no external I/O, so a
 *      caller rollback removes the journal completely (Checkpoint C composes
 *      invoice + payment + this journal + audit / outbox in one transaction);
 *   2. it derives the journal's identity and scope from the TRUSTED issued
 *      invoice and its order — tenant / company / branch, the order's POS
 *      terminal (attribution only, never isolation), and the invoice's own
 *      accounting date — never from a client identifier;
 *   3. it fails CLOSED if that context is not an anonymous WALK_IN sale
 *      (a customer-linked sale is booked by the frozen 3b.6 journals and must
 *      never be double-booked here), if the plan is not a frozen Checkpoint-A
 *      plan of this invoice (wrong identity, a line the builder can never emit,
 *      lines that disagree with the issued invoice), or if the invoice currency
 *      is not the company's accounting currency (a structural backstop — the
 *      order / invoice currency FKs already make that state unconstructible);
 *   4. it never lets a zero-value sale reach the posting engine (owner ruling:
 *      `SALE_ZERO_TOTAL_NOT_SUPPORTED`; no complimentary-sale accounting);
 *   5. it invokes `PostingEngineService.postJournal`.
 *
 * It owns NO accounting arithmetic: no tender-account mapping, no revenue / tax
 * formula, no balance computation — those live in the pure builder and the
 * engine. Period (must be OPEN), company currency / timezone, account
 * resolution, balance, sealing, the audit row and `(tenant, company, sourceKind,
 * sourceId)` idempotency all stay in the engine.
 *
 * Replay semantics are the engine's, unchanged: the same invoice with the same
 * plan returns the existing journal (`created: false`, no second journal, no
 * second audit row); the same invoice with a different plan is
 * `JOURNAL_SOURCE_CONFLICT` (409); two concurrent posts serialise on the unique
 * source index — the loser either replays the winner's journal or, if the
 * winner rolled back, posts its own. Exactly one journal exists either way.
 *
 * The posting date is the INVOICE's own accounting date (a civil `YYYY-MM-DD`
 * the issuance derived from the company timezone), passed explicitly, so the
 * journal can never be dated differently from its invoice even when issuance
 * and posting straddle midnight. That date's accounting period must be OPEN.
 */
export interface PostWalkInSaleJournalInput {
  /** from the authenticated `RequestContext` (via the caller) — never a body field */
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  /** the issued invoice the journal books — also the journal's `sourceId` */
  readonly invoiceId: string;
  /** the frozen Checkpoint-A plan (`buildWalkInSaleJournal(...)`) */
  readonly plan: WalkInSaleJournalPlan;
  /** the authenticated actor, recorded as `createdByUserId` (never overwritten) */
  readonly actorUserId?: string | null;
}

export interface PostWalkInSaleJournalResult {
  readonly journalEntryId: string;
  /** `false` = the engine returned the existing identical journal (a replay) */
  readonly created: boolean;
  readonly sourceKind: typeof WALK_IN_SALE_SOURCE_KIND;
  readonly sourceId: string;
  /** the civil accounting date the journal was posted under (the invoice's) */
  readonly accountingDate: string;
}

interface IssuedInvoiceContextRow {
  id: string;
  branchId: string;
  currencyCode: string;
  currencyExponent: number;
  totalAmountMinor: bigint;
  taxTotalAmountMinor: bigint;
  invoiceDate: string;
  customerId: string | null;
  kind: string;
  posTerminalId: string | null;
}

@Injectable()
export class WalkInSaleJournalRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly companyConfig: CompanyFinancialConfigRepository,
  ) {}

  async postWalkInSaleJournalInTx(
    tx: ScopedTx,
    input: PostWalkInSaleJournalInput,
  ): Promise<PostWalkInSaleJournalResult> {
    const { plan } = input;

    // ── 1. the plan must be the frozen Checkpoint-A shape for THIS invoice ────
    //      (structural identity only — no accounting arithmetic is repeated here)
    if (plan.sourceKind !== WALK_IN_SALE_SOURCE_KIND || plan.sourceId !== input.invoiceId) {
      throw new DomainError(
        'WALK_IN_JOURNAL_PLAN_INVALID',
        `the journal plan must be the ${WALK_IN_SALE_SOURCE_KIND} plan of invoice ${input.invoiceId}`,
        500,
      );
    }
    // The only accounts the anonymous-sale builder can emit: a debit on a tender
    // account, a credit on REVENUE.SALES / LIABILITY.TAX_PAYABLE. A line outside
    // that shape (AR, customer advance, unapplied receipt, contra-revenue, …) is
    // not a Checkpoint-A plan and is never handed to the engine. This is an
    // allow-list of the builder's own exported constants — not a second mapping.
    for (const l of plan.lines) {
      const onAllowedAccount =
        l.direction === 'debit'
          ? DEBIT_ACCOUNT_ORDER.includes(l.accountKey)
          : l.accountKey === REVENUE_ACCOUNT_KEY || l.accountKey === TAX_PAYABLE_ACCOUNT_KEY;
      if (!onAllowedAccount || typeof l.amountMinor !== 'bigint' || l.amountMinor <= 0n) {
        throw new DomainError(
          'WALK_IN_JOURNAL_PLAN_INVALID',
          `the journal plan carries a line (${l.direction} ${l.accountKey}) an anonymous walk-in sale never books`,
          500,
        );
      }
    }

    // ── 2. the trusted issued-invoice + order context, in EXACT scope. A wrong
    //      tenant / company / branch matches nothing — the same non-disclosing
    //      `INVOICE_NOT_FOUND` every other invoice-keyed primitive returns. ────
    const rows = await tx.$queryRaw<IssuedInvoiceContextRow[]>`
      SELECT i."id", i."branchId", i."currencyCode", i."currencyExponent",
             i."totalAmountMinor", i."taxTotalAmountMinor",
             i."invoiceDate"::text AS "invoiceDate",
             o."customerId", o."kind", o."posTerminalId"
        FROM "invoice" i
        INNER JOIN "order" o ON o."id" = i."orderId" AND o."tenantId" = i."tenantId"
       WHERE i."id" = ${input.invoiceId}::uuid
         AND i."tenantId" = ${input.tenantId}::uuid
         AND i."companyId" = ${input.companyId}::uuid
         AND i."branchId" = ${input.branchId}::uuid`;
    const invoice = rows[0];
    if (!invoice) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');

    // ── 3. a zero-value sale never reaches the posting engine (owner ruling) ──
    if (invoice.totalAmountMinor === 0n || plan.totalDebitMinor === 0n) {
      throw new DomainError(
        'SALE_ZERO_TOTAL_NOT_SUPPORTED',
        'a zero-value sale is not supported (no balanced journal can be posted for it)',
        422,
      );
    }

    // ── 4. anonymous WALK_IN only — a customer-linked sale uses the frozen 3b.6
    //      AR / receipt / allocation / advance journals; booking revenue here too
    //      would double-count it. The order's `customerId` is the gate: it is
    //      frozen by the order-issuance trigger once the invoice exists, and a
    //      `customer_receivable` can only ever reference an invoice whose order HAS
    //      a customer (fn_check_customer_receivable_integrity) — so "no customer on
    //      the order" already means "no receivable" (both facts pinned in tests). ─
    if (invoice.customerId !== null) {
      throw new DomainError(
        'WALK_IN_JOURNAL_CUSTOMER_LINKED',
        'this journal books an anonymous sale only — a customer-linked invoice is booked by the receivables journals',
        409,
      );
    }
    if (invoice.kind !== 'WALK_IN') {
      throw new DomainError(
        'WALK_IN_JOURNAL_ORDER_KIND_UNSUPPORTED',
        `only a WALK_IN order is booked by this journal (this order is ${invoice.kind})`,
        409,
      );
    }

    // ── 5. the invoice and the plan's LINES must agree (a consistency check — no
    //      accounting figure is derived here, and the plan's own claimed totals
    //      are not trusted): the debit lines sum to the invoice total, the credit
    //      lines sum to the invoice total, the tax credit is the invoice tax. ───
    let debitSum = 0n;
    let creditSum = 0n;
    let taxCredit = 0n;
    for (const l of plan.lines) {
      if (l.direction === 'debit') debitSum += l.amountMinor;
      else creditSum += l.amountMinor;
      if (l.direction === 'credit' && l.accountKey === TAX_PAYABLE_ACCOUNT_KEY) {
        taxCredit += l.amountMinor;
      }
    }
    if (
      debitSum !== invoice.totalAmountMinor ||
      creditSum !== invoice.totalAmountMinor ||
      taxCredit !== invoice.taxTotalAmountMinor
    ) {
      throw new DomainError(
        'WALK_IN_JOURNAL_PLAN_MISMATCH',
        'the journal plan does not match the issued invoice (total / tax)',
        500,
      );
    }

    // ── 6. the invoice must be in the company's ACCOUNTING currency. The engine
    //      stamps the journal with `Company.defaultCurrency` and is otherwise
    //      currency-agnostic, so this is the one place the invoice's own currency
    //      / exponent is compared to it (no FX, a mismatch fails safely). The
    //      company row is read under the same `FOR SHARE` lock the engine takes
    //      next (idempotent), and also fails closed on a missing currency /
    //      timezone. ───────────────────────────────────────────────────────────
    const config = await this.companyConfig.lockForPosting(tx, input.companyId);
    if (
      invoice.currencyCode !== config.defaultCurrency ||
      invoice.currencyExponent !== currencyExponent(config.defaultCurrency)
    ) {
      throw new DomainError(
        'WALK_IN_JOURNAL_CURRENCY_MISMATCH',
        "the invoice's currency does not match the company's accounting currency",
        409,
      );
    }

    // ── 7. post through the ONE posting engine, in the caller's transaction ───
    const posted = await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      sourceKind: plan.sourceKind,
      sourceId: plan.sourceId,
      branchId: invoice.branchId,
      ...(invoice.posTerminalId !== null ? { posTerminalId: invoice.posTerminalId } : {}),
      lines: plan.lines.map((l) => ({
        accountKey: l.accountKey,
        direction: l.direction,
        amountMinor: l.amountMinor,
      })),
      accountingDate: invoice.invoiceDate,
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    return {
      journalEntryId: posted.journalEntryId,
      created: posted.created,
      sourceKind: plan.sourceKind,
      sourceId: plan.sourceId,
      accountingDate: invoice.invoiceDate,
    };
  }
}
