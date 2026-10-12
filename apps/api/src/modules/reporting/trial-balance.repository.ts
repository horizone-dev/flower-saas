import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { ReportingRepository } from './reporting.repository.js';
import { parseReportDateRange } from './report-date-range.js';
import { parseMinorUnitsText, resolveCompanyReportAuthority } from './report-money.js';
import {
  buildTrialBalance,
  type TrialBalanceAccountAggregate,
  type TrialBalanceAccountRow,
  type TrialBalanceTotals,
} from './trial-balance.js';
import { buildTrialBalanceQuery, type TrialBalanceSqlRow } from './trial-balance.sql.js';

/**
 * The Trial Balance report of ONE company (task 3b.10 Checkpoint A). Company GL only — there
 * is deliberately no branch, POS-terminal, customer, `sourceKind` or pagination input or output.
 */
export interface TrialBalanceReport {
  readonly companyId: string;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly accountingTimezone: string;
  /** inclusive civil start, `YYYY-MM-DD` (company accounting timezone) */
  readonly from: string;
  /** inclusive civil end, `YYYY-MM-DD` (company accounting timezone) */
  readonly to: string;
  /** every account with sealed activity on or before `to`, in the frozen deterministic order */
  readonly accounts: readonly TrialBalanceAccountRow[];
  readonly totals: TrialBalanceTotals;
}

@Injectable()
export class TrialBalanceRepository extends ReportingRepository {
  constructor(db: DbService) {
    super(db);
  }

  /**
   * Read the Trial Balance of `companyId` for the civil period `[from, to]`.
   *
   * ONE read statement ({@link buildTrialBalanceQuery}); the pure
   * {@link buildTrialBalance} then applies the exact balance algorithm and enforces the
   * control-total invariant. A company the caller's tenant does not own is
   * indistinguishable from one that does not exist (`404 NOT_FOUND`) — nothing is disclosed.
   */
  async getForCompanyScoped(input: {
    companyId: string;
    from: unknown;
    to: unknown;
  }): Promise<TrialBalanceReport> {
    assertUuid(input.companyId, 'company');
    const { from, to } = parseReportDateRange({ from: input.from, to: input.to });
    const tenantId = this.tenantIdOrThrow();
    const query = buildTrialBalanceQuery({ tenantId, companyId: input.companyId, from, to });

    const rows = await this.readScoped((tx) =>
      tx.$queryRawUnsafe<TrialBalanceSqlRow[]>(query.text, ...query.values),
    );

    const head = rows[0];
    if (head === undefined) throw new NotFoundError('company');
    const authority = resolveCompanyReportAuthority(head);

    // `LEFT JOIN`: a company with an empty ledger is ONE row whose account columns are NULL.
    const aggregates: TrialBalanceAccountAggregate[] = [];
    let mismatchedLines = 0n;
    for (const r of rows) {
      if (r.accountId === null) continue;
      mismatchedLines += parseMinorUnitsText(r.currencyMismatch, 'currencyMismatch');
      aggregates.push({
        accountId: r.accountId,
        accountKey: requireText(r.accountKey, 'accountKey'),
        category: requireText(r.category, 'category'),
        displayCode: requireText(r.displayCode, 'displayCode'),
        displayName: requireText(r.displayName, 'displayName'),
        openingDebitMinor: parseMinorUnitsText(r.openingDebit, 'openingDebit'),
        openingCreditMinor: parseMinorUnitsText(r.openingCredit, 'openingCredit'),
        periodDebitMinor: parseMinorUnitsText(r.periodDebit, 'periodDebit'),
        periodCreditMinor: parseMinorUnitsText(r.periodCredit, 'periodCredit'),
      });
    }

    // single company currency, no FX: a ledger line in any other currency is a data-integrity
    // failure, never converted and never summed in.
    if (mismatchedLines > 0n) {
      throw new DomainError(
        'REPORT_CURRENCY_MISMATCH',
        "a sealed journal entry's currency differs from the company's accounting currency — no trial balance is returned",
        409,
      );
    }

    const { accounts, totals } = buildTrialBalance(aggregates);
    return {
      companyId: input.companyId,
      currencyCode: authority.currencyCode,
      currencyExponent: authority.currencyExponent,
      accountingTimezone: authority.accountingTimezone,
      from,
      to,
      accounts,
      totals,
    };
  }
}

function requireText(value: string | null, label: string): string {
  if (value === null) throw new RangeError(`${label} must not be null for an aggregated account`);
  return value;
}
