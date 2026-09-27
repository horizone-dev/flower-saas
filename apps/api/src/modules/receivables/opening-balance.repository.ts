import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors every other 3b.6 internal
// primitive): PARTICIPATES in the caller's already-open transaction, never
// opens its own.
import type { ScopedTx } from '@flower/db';
import { currencyExponent, isKnownCurrency } from '@flower/money';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { isPgError } from '../../common/errors/pg-error.js';
import { assertCustomerReceivableSourceShape } from './customer-receivable-source.js';
import { assertCustomerAccountEntryReferenceShape } from './customer-account-entry.js';
import type { ReceivablesEventType } from './receivables-events.js';

const PG_UNIQUE_VIOLATION = '23505';

export interface CreateOpeningBalanceInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerId: string;
  type: 'RECEIVABLE' | 'ADVANCE';
  amountMinor: bigint;
  /** `YYYY-MM-DD` civil calendar date — the immutable business record only.
   *  NEVER fed into `PostingEngineService` (F15 — see the repository-level
   *  doc comment below). */
  effectiveDate: string;
  note?: string | null;
  actorUserId?: string | null;
}

/** `CreateOpeningBalanceInput` with `effectiveDate` resolved from its raw
 *  `YYYY-MM-DD` string into an actual `Date` (for the Prisma `@db.Date`
 *  column) and scope/currency already resolved — an `Omit`, never an
 *  intersection, since `effectiveDate`'s type itself changes shape. */
type ResolvedOpeningBalanceInput = Omit<CreateOpeningBalanceInput, 'effectiveDate' | 'note'> & {
  customerCompanyAccountId: string;
  currencyCode: string;
  currencyExponent: number;
  effectiveDate: Date;
  note: string | null;
};

export interface CreateOpeningBalanceResult {
  type: 'RECEIVABLE' | 'ADVANCE';
  sourceId: string;
  customerCompanyAccountId: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  effectiveDate: string;
  note: string | null;
  currentOutstandingMinor: bigint | null;
  advanceBalanceMinor: bigint | null;
}

/**
 * Task 3b.6 Checkpoint F — the explicit "create an Opening Receivable or an
 * Opening Advance for a customer" primitive (F3/F10/F11). Always exactly ONE
 * of the two, never both, never automatic (F4). Creates NO Payment, NO
 * PaymentAttempt, NO PaymentAllocation, NO CustomerAdvanceApplication, NO
 * fake Invoice.
 *
 * GL-POSTING-DATE (Checkpoint F Final Hardening §2/§4 — the MAJOR BLOCKER
 * resolved): `effectiveDate` now DOES determine the journal's own accounting
 * date. `PostingEngineService.postJournal` gained an OPTIONAL
 * `accountingDate` input (every OTHER caller in this codebase still omits it
 * and is completely unaffected — existing `Clock.now()`-derived behavior is
 * unchanged byte-for-byte); this repository is the ONE caller that supplies
 * it, using `effectiveDate` verbatim (a plain civil `YYYY-MM-DD` string,
 * never a JS `Date`/timestamp). The `AccountingPeriod` containing THAT date
 * must be OPEN — today's own period is irrelevant once an explicit
 * `effectiveDate` is supplied (F6). `effectiveDate` is ALSO stored on the
 * source row as the immutable business record — the two are now the SAME
 * date, never divergent.
 *
 * STRUCTURAL UNIQUENESS (Final Hardening §9/§10): the "at most one opening
 * balance per CustomerCompanyAccount+Branch" invariant is now enforced by a
 * `BEFORE INSERT` trigger on `customer_receivable`/`customer_advance`
 * themselves (migration SQL) — fired for EVERY insert with
 * `sourceType='OPENING'`, from this repository, raw SQL, or any future code.
 * This repository no longer performs its own explicit ticket-claim call; a
 * genuine Postgres `23505` unique-violation (surfaced through the trigger)
 * is caught below and mapped to a clean `409`.
 *
 * Canonical lock order (B15, extended): CustomerCompanyAccount only — there
 * is no coverage-anchor/Payment/Advance tier to lock first for a brand-new
 * opening balance.
 */
@Injectable()
export class OpeningBalanceRepository {
  constructor(
    private readonly postingEngine: PostingEngineService,
    private readonly companyFinancialConfig: CompanyFinancialConfigRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async createInTx(
    tx: ScopedTx,
    input: CreateOpeningBalanceInput,
  ): Promise<CreateOpeningBalanceResult> {
    if (input.amountMinor <= 0n) {
      throw new DomainError('OPENING_BALANCE_INVALID_AMOUNT', 'amountMinor must be > 0', 422);
    }

    // ── 1. trusted branch resolution (the route's `@ScopedParam` already
    //      authorized this branchId against the caller's session scope —
    //      this is the ordinary existence/tenant+company-consistency proof
    //      every other repository in this checkpoint chain also runs). ────
    const branchRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "branch"
       WHERE "id" = ${input.branchId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid`;
    if (!branchRows[0]) {
      throw new NotFoundError('branch', 'BRANCH_NOT_FOUND');
    }

    // ── 2. join-gated CustomerCompanyAccount resolution — a wrong
    //      customerId can never reach another customer's account (F5). ────
    const accountRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_company_account"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "customerId" = ${input.customerId}::uuid`;
    const account = accountRows[0];
    if (!account) {
      throw new DomainError('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND', 'association not found', 404);
    }

    // ── 3. F6 — company currency is the SOLE authoritative Money basis; the
    //      caller never supplies currency/exponent. ──────────────────────
    const { defaultCurrency } = await this.companyFinancialConfig.lockCurrencyOnly(
      tx,
      input.companyId,
    );
    if (!isKnownCurrency(defaultCurrency)) {
      throw new DomainError('OPENING_BALANCE_CONFIG_INVALID', 'unknown company currency', 422);
    }
    const currencyCode = defaultCurrency;
    const exponent = currencyExponent(defaultCurrency);

    // ── 4. lock CustomerCompanyAccount — serializes every opening-balance
    //      attempt (and F26/F38 concurrent credit/outstanding mutation) on
    //      this exact account. ───────────────────────────────────────────
    await tx.$queryRaw`SELECT "id" FROM "customer_company_account" WHERE "id" = ${account.id}::uuid FOR UPDATE`;

    const effectiveDate = new Date(`${input.effectiveDate}T00:00:00.000Z`);
    const note = input.note?.trim() || null;

    if (input.type === 'RECEIVABLE') {
      return this.createOpeningReceivable(tx, {
        ...input,
        customerCompanyAccountId: account.id,
        currencyCode,
        currencyExponent: exponent,
        effectiveDate,
        note,
      });
    }
    return this.createOpeningAdvance(tx, {
      ...input,
      customerCompanyAccountId: account.id,
      currencyCode,
      currencyExponent: exponent,
      effectiveDate,
      note,
    });
  }

  private async createOpeningReceivable(
    tx: ScopedTx,
    input: ResolvedOpeningBalanceInput,
  ): Promise<CreateOpeningBalanceResult> {
    assertCustomerReceivableSourceShape({
      sourceType: 'OPENING',
      originalAmountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      currencyExponent: input.currencyExponent,
      branchId: input.branchId,
    });

    // F10.7 — create CustomerReceivable(sourceType='OPENING'). The BEFORE
    // INSERT trigger (migration SQL) atomically claims this account+branch's
    // ONE opening-balance slot as part of this SAME insert statement — a
    // conflict raises a genuine `23505`, caught below.
    const receivable = await tx.customerReceivable
      .create({
        data: {
          tenantId: input.tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          customerCompanyAccountId: input.customerCompanyAccountId,
          sourceType: 'OPENING',
          openingAmountMinor: input.amountMinor,
          currencyCode: input.currencyCode,
          currencyExponent: input.currencyExponent,
          openingEffectiveDate: input.effectiveDate,
          openingNote: input.note,
          ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
        },
      })
      .catch((err: unknown) => {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw new DomainError(
            'OPENING_BALANCE_ALREADY_INITIALIZED',
            'this customer already has an opening balance for this branch',
            409,
          );
        }
        throw err;
      });

    // F10.8 — chronology.
    assertCustomerAccountEntryReferenceShape('OPENING_RECEIVABLE', {
      customerReceivableId: receivable.id,
    });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'OPENING_RECEIVABLE',
        customerReceivableId: receivable.id,
      },
    });

    // F10.9 — projection: currentOutstandingMinor ONLY. advanceBalanceMinor
    // and `version` (the credit-CONFIG optimistic-concurrency axis) are
    // untouched (F10 "do not modify").
    const updatedAccount = await tx.customerCompanyAccount.update({
      where: { id: input.customerCompanyAccountId },
      data: { currentOutstandingMinor: { increment: input.amountMinor } },
      select: { currentOutstandingMinor: true },
    });

    // F12 — Dr ASSET.ACCOUNTS_RECEIVABLE / Cr EQUITY.OPENING_BALANCE, exactly
    // once, sourceKind='opening_receivable'. F27 — this is historical
    // opening reality, NOT a new ON_CREDIT authorization: no credit gate of
    // any kind runs here. `accountingDate` = `effectiveDate` (Final Hardening
    // §2/§4) — the journal now posts in the accounting period containing the
    // opening balance's own historical date, never today's by default.
    const effectiveDateStr = input.effectiveDate.toISOString().slice(0, 10);
    await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'opening_receivable',
      sourceId: receivable.id,
      accountingDate: effectiveDateStr,
      lines: [
        {
          accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
          direction: 'debit',
          amountMinor: input.amountMinor,
        },
        {
          accountKey: 'EQUITY.OPENING_BALANCE',
          direction: 'credit',
          amountMinor: input.amountMinor,
        },
      ],
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'receivable.opening_receivable_created',
      resourceType: 'customer_receivable',
      resourceId: receivable.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      after: {
        customerCompanyAccountId: input.customerCompanyAccountId,
        amountMinor: input.amountMinor.toString(),
        currencyCode: input.currencyCode,
        effectiveDate: effectiveDateStr,
        hasNote: input.note !== null,
      },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    // Checkpoint H (§6/§7) — standalone command, no other outbox event
    // fires in this transaction. Branch-scoped (the opening init's own
    // branch — this is a per-branch operational fact, per Checkpoint F).
    await this.outbox.enqueue(tx, {
      aggregateType: 'customer_receivable',
      aggregateId: receivable.id,
      eventType: 'receivables.customer_account_changed' satisfies ReceivablesEventType,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      payload: {
        customerCompanyAccountId: input.customerCompanyAccountId,
        changeKind: 'OPENING_RECEIVABLE_CREATED',
        sourceType: 'customer_receivable',
        sourceId: receivable.id,
      },
    });

    return {
      type: 'RECEIVABLE',
      sourceId: receivable.id,
      customerCompanyAccountId: input.customerCompanyAccountId,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      currencyExponent: input.currencyExponent,
      effectiveDate: effectiveDateStr,
      note: input.note,
      currentOutstandingMinor: updatedAccount.currentOutstandingMinor,
      advanceBalanceMinor: null,
    };
  }

  private async createOpeningAdvance(
    tx: ScopedTx,
    input: ResolvedOpeningBalanceInput,
  ): Promise<CreateOpeningBalanceResult> {
    // F11.5 — create CustomerAdvance(sourceType='OPENING'). Same trigger-
    // based auto-claim + `23505` mapping as the RECEIVABLE path above.
    const advance = await tx.customerAdvance
      .create({
        data: {
          tenantId: input.tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          customerCompanyAccountId: input.customerCompanyAccountId,
          sourceType: 'OPENING',
          amountMinor: input.amountMinor,
          currencyCode: input.currencyCode,
          currencyExponent: input.currencyExponent,
          openingEffectiveDate: input.effectiveDate,
          openingNote: input.note,
          ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
        },
      })
      .catch((err: unknown) => {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw new DomainError(
            'OPENING_BALANCE_ALREADY_INITIALIZED',
            'this customer already has an opening balance for this branch',
            409,
          );
        }
        throw err;
      });

    // F11.6 — chronology.
    assertCustomerAccountEntryReferenceShape('OPENING_ADVANCE', {
      customerAdvanceId: advance.id,
    });
    await tx.customerAccountEntry.create({
      data: {
        tenantId: input.tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        customerCompanyAccountId: input.customerCompanyAccountId,
        entryKind: 'OPENING_ADVANCE',
        customerAdvanceId: advance.id,
      },
    });

    // F11.7 — projection: advanceBalanceMinor ONLY (F28 — never
    // currentOutstandingMinor/creditEnabled/creditLimitMinor/version).
    const updatedAccount = await tx.customerCompanyAccount.update({
      where: { id: input.customerCompanyAccountId },
      data: { advanceBalanceMinor: { increment: input.amountMinor } },
      select: { advanceBalanceMinor: true },
    });

    // F13 — Dr EQUITY.OPENING_BALANCE / Cr LIABILITY.CUSTOMER_ADVANCES,
    // exactly once, sourceKind='opening_advance'. Never touches Cash/Bank/
    // Clearing. `accountingDate` = `effectiveDate` (Final Hardening §2/§4).
    const effectiveDateStr = input.effectiveDate.toISOString().slice(0, 10);
    await this.postingEngine.postJournal(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      sourceKind: 'opening_advance',
      sourceId: advance.id,
      accountingDate: effectiveDateStr,
      lines: [
        {
          accountKey: 'EQUITY.OPENING_BALANCE',
          direction: 'debit',
          amountMinor: input.amountMinor,
        },
        {
          accountKey: 'LIABILITY.CUSTOMER_ADVANCES',
          direction: 'credit',
          amountMinor: input.amountMinor,
        },
      ],
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {}),
    });

    await this.audit.record(tx, {
      action: 'receivable.opening_advance_created',
      resourceType: 'customer_advance',
      resourceId: advance.id,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      after: {
        customerCompanyAccountId: input.customerCompanyAccountId,
        amountMinor: input.amountMinor.toString(),
        currencyCode: input.currencyCode,
        effectiveDate: effectiveDateStr,
        hasNote: input.note !== null,
      },
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    await this.outbox.enqueue(tx, {
      aggregateType: 'customer_advance',
      aggregateId: advance.id,
      eventType: 'receivables.customer_account_changed' satisfies ReceivablesEventType,
      tenantId: input.tenantId,
      companyId: input.companyId,
      branchId: input.branchId,
      payload: {
        customerCompanyAccountId: input.customerCompanyAccountId,
        changeKind: 'OPENING_ADVANCE_CREATED',
        sourceType: 'customer_advance',
        sourceId: advance.id,
      },
    });

    return {
      type: 'ADVANCE',
      sourceId: advance.id,
      customerCompanyAccountId: input.customerCompanyAccountId,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      currencyExponent: input.currencyExponent,
      effectiveDate: effectiveDateStr,
      note: input.note,
      currentOutstandingMinor: null,
      advanceBalanceMinor: updatedAccount.advanceBalanceMinor,
    };
  }
}
