import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertValidIanaTimezone } from './posting-date.js';
import { AccountRepository } from './account.repository.js';

export interface CompanyFinancialConfig {
  defaultCurrency: string;
  accountingTimezone: string;
}

/**
 * Task 3b.1 — locks and validates the Company financial-config snapshot a
 * posting transaction must hold for its entire duration (docs/phase-3/
 * PHASE-3B-PLAN.md §J). `FOR SHARE` on the company row, matching the exact
 * locking convention already established by
 * `catalog/company-pricing.repository.ts` (`FOR SHARE` there serialises
 * against a future `defaultCurrency` change) and `catalog/branch-pricing.repository.ts`.
 * Fails closed if either field is unset — a posting transaction must never
 * proceed on a partially-configured company.
 */
@Injectable()
export class CompanyFinancialConfigRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
    private readonly accounts: AccountRepository,
  ) {
    super(db);
  }

  /** Standalone `PATCH config/timezone` entry point — opens its own transaction
   *  and records `accounting.company_timezone_configured`. */
  async setAccountingTimezoneScoped(companyId: string, accountingTimezone: string): Promise<void> {
    const { tenantId } = requireTenantContext();
    await this.scoped(async (tx) => {
      await this.setAccountingTimezone(tx, companyId, accountingTimezone);
      await this.audit.record(tx, {
        action: 'accounting.company_timezone_configured',
        resourceType: 'company',
        resourceId: companyId,
        tenantId,
        companyId,
        after: { accountingTimezone },
      });
    });
  }

  /** Existing-company Accounting Setup bootstrap (docs/phase-3/PHASE-3B-PLAN.md
   *  §J/§P) — NOT a raw accounting/journal-posting endpoint. Sets
   *  `Company.accountingTimezone` (explicit, never inferred) and idempotently
   *  backfills any of the 14 frozen CoA accounts not yet present, ATOMICALLY
   *  in one transaction (both effects commit or neither does). Never creates
   *  an `AccountingPeriod`. Records both audit actions in the same transaction. */
  async bootstrapExistingCompanyScoped(
    companyId: string,
    accountingTimezone: string,
  ): Promise<{ accountingTimezone: string; accountsCreated: number }> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      await this.setAccountingTimezone(tx, companyId, accountingTimezone);
      await this.audit.record(tx, {
        action: 'accounting.company_timezone_configured',
        resourceType: 'company',
        resourceId: companyId,
        tenantId,
        companyId,
        after: { accountingTimezone },
      });
      const result = await this.accounts.ensureDefaultAccounts(tx, { tenantId, companyId });
      await this.audit.record(tx, {
        action: 'accounting.company_coa_backfilled',
        resourceType: 'company',
        resourceId: companyId,
        tenantId,
        companyId,
        after: { insertedCount: result.insertedCount },
      });
      return { accountingTimezone, accountsCreated: result.insertedCount };
    });
  }

  /**
   * Locks the company row `FOR SHARE` and returns its raw financial-config
   * columns, unvalidated. Private — every public entry point below decides
   * for itself which of these fields it actually requires, so a caller that
   * only needs `defaultCurrency` (e.g. task 3b.2's credit configuration)
   * never has to satisfy `accountingTimezone`/posting-readiness prerequisites
   * that are irrelevant to it. Extracted from the original single-purpose
   * `lockForPosting` body — task 3b.2 checkpoint B, behavior-preserving.
   */
  private async lockCompanyRow(
    tx: ScopedTx,
    companyId: string,
  ): Promise<{ id: string; defaultCurrency: string | null; accountingTimezone: string | null }> {
    const rows = await tx.$queryRaw<
      { id: string; defaultCurrency: string | null; accountingTimezone: string | null }[]
    >`SELECT "id", "defaultCurrency", "accountingTimezone" FROM "company"
        WHERE "id" = ${companyId}::uuid FOR SHARE`;
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'company not found', 404);
    return row;
  }

  /**
   * Currency-only lock — for callers that need a stable `Company.defaultCurrency`
   * read (e.g. task 3b.2 credit-limit configuration) but have no posting-
   * readiness requirement of their own (no `accountingTimezone`/open-period
   * dependency). Fails closed only on the currency, never on timezone.
   */
  async lockCurrencyOnly(tx: ScopedTx, companyId: string): Promise<{ defaultCurrency: string }> {
    const row = await this.lockCompanyRow(tx, companyId);
    if (!row.defaultCurrency) {
      throw new DomainError(
        'ACCOUNTING_CURRENCY_NOT_CONFIGURED',
        'Company.defaultCurrency must be configured before financial posting',
        422,
      );
    }
    return { defaultCurrency: row.defaultCurrency };
  }

  async lockForPosting(tx: ScopedTx, companyId: string): Promise<CompanyFinancialConfig> {
    const row = await this.lockCompanyRow(tx, companyId);
    if (!row.defaultCurrency) {
      throw new DomainError(
        'ACCOUNTING_CURRENCY_NOT_CONFIGURED',
        'Company.defaultCurrency must be configured before financial posting',
        422,
      );
    }
    if (!row.accountingTimezone) {
      throw new DomainError(
        'ACCOUNTING_TIMEZONE_NOT_CONFIGURED',
        'Company.accountingTimezone must be configured before financial posting',
        422,
      );
    }
    return { defaultCurrency: row.defaultCurrency, accountingTimezone: row.accountingTimezone };
  }

  /**
   * Guard for a future company-currency-update path (none exists in this
   * codebase yet — no endpoint currently mutates `Company.defaultCurrency`
   * outside provisioning). Locks the company row `FOR UPDATE` and rejects a
   * currency change once ANY `journal_entry` exists for it (`COMPANY_CURRENCY_LOCKED`).
   * A future Task 3b.x company-update endpoint must call this, inside its own
   * transaction, before applying a `defaultCurrency` change.
   */
  async assertCurrencyChangeAllowed(
    tx: ScopedTx,
    companyId: string,
    nextDefaultCurrency: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string; defaultCurrency: string | null }[]>`
      SELECT "id", "defaultCurrency" FROM "company" WHERE "id" = ${companyId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'company not found', 404);
    if (row.defaultCurrency === nextDefaultCurrency) return;
    const hasHistory = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM "journal_entry" WHERE "companyId" = ${companyId}::uuid) AS "exists"`;
    if (hasHistory[0]?.exists) {
      throw new DomainError(
        'COMPANY_CURRENCY_LOCKED',
        'Company.defaultCurrency cannot change once posted financial history exists',
        409,
      );
    }
  }

  /**
   * `Company.accountingTimezone` MAY change after financial history exists
   * (frozen owner decision, docs/phase-3/PHASE-3B-PLAN.md §D — unlike
   * currency, no invariant a later change would silently violate: a stored
   * `postingDate` on an existing journal is never re-derived). Still locks
   * the company row `FOR UPDATE` — every financial-config write serialises
   * through this same row, matching `assertCurrencyChangeAllowed`. Affects
   * FUTURE postings only.
   */
  async setAccountingTimezone(
    tx: ScopedTx,
    companyId: string,
    accountingTimezone: string,
  ): Promise<void> {
    assertValidIanaTimezone(accountingTimezone);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "company" WHERE "id" = ${companyId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new DomainError('NOT_FOUND', 'company not found', 404);
    await tx.$executeRaw`
      UPDATE "company" SET "accountingTimezone" = ${accountingTimezone} WHERE "id" = ${companyId}::uuid`;
  }
}
