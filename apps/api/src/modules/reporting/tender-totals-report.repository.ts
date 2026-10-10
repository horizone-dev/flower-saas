import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { parseReportDateRange } from './report-date-range.js';
import { parseMinorUnitsText, resolveCompanyReportAuthority } from './report-money.js';
import { ReportingRepository } from './reporting.repository.js';
import {
  buildTenderTotalsBlocks,
  sumTenderAggregates,
  type TenderBranchAggregate,
  type TenderGlAggregate,
  type TenderStream,
  type TenderTotalsBlocks,
} from './tender-totals-report.js';
import {
  buildTenderTotalsReportQuery,
  TENDER_REPORT_MAX_MOVEMENTS,
  type TenderTotalsReportJson,
} from './tender-totals-report.sql.js';

interface ReportHeader {
  readonly companyId: string;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly accountingTimezone: string;
  /** inclusive civil start, `YYYY-MM-DD` (company accounting timezone) */
  readonly from: string;
  /** inclusive civil end, `YYYY-MM-DD` (company accounting timezone) */
  readonly to: string;
}

/** One branch's Tender Totals — also the shape of a `byBranch` row of the company report. */
export interface TenderTotalsBranchRow extends TenderTotalsBlocks {
  readonly branchId: string;
}

/** The Tender Totals of ONE branch. */
export interface TenderTotalsBranchReport extends ReportHeader, TenderTotalsBlocks {
  readonly branchId: string;
}

/** The Tender Totals of ONE company: the company aggregate plus one row per branch with activity. */
export interface TenderTotalsCompanyReport extends ReportHeader, TenderTotalsBlocks {
  readonly byBranch: readonly TenderTotalsBranchRow[];
}

/**
 * Task 3b.10 Checkpoint C — Tender Totals (recorded receipts by method, actual refunds by method, the explicit net
 * tender movement, and the source-to-GL reconciliation). READ-ONLY, ONE statement in ONE database-enforced read-only
 * scoped transaction. NOT registered in any Nest module and NOT reachable over HTTP.
 *
 * The period has NO calendar-day cap: Checkpoint B's 90-day / 25 000-document rules are the Sales report's own and are
 * not applied here. Tender Totals is bounded by ONE density guard instead (owner ruling TT-1): at most
 * `TENDER_REPORT_MAX_MOVEMENTS` logical tender movements (a Payment, an actual Refund) in the COMPANY's requested window
 * — for a branch report too, because the journal anchor has no branch and the company's window is what is read.
 * Above it the report is rejected (`REPORT_RESULT_TOO_LARGE`, 422) from the first stage of the same statement, before
 * any financial figure is produced or any integrity analysis is made. Volume behaviour is measured in
 * `tender-totals-report.query-plan.integration.test.ts` and `tender-totals-report.dense-window.integration.test.ts`.
 */
@Injectable()
export class TenderTotalsReportRepository extends ReportingRepository {
  /**
   * The v1 density limit (owner ruling TT-1) — the ONE authoritative constant. A `protected` seam only so a test can
   * exercise the boundary on a small real-document world; nothing in production overrides it.
   */
  protected readonly maxMovements: number = TENDER_REPORT_MAX_MOVEMENTS;

  constructor(db: DbService) {
    super(db);
  }

  /** The Tender Totals of one branch of one company, for the civil period `[from, to]` (by posting date). */
  async getBranchReportScoped(input: {
    companyId: string;
    branchId: string;
    from: unknown;
    to: unknown;
  }): Promise<TenderTotalsBranchReport> {
    assertUuid(input.companyId, 'company');
    assertUuid(input.branchId, 'branch');
    const { json, header } = await this.read({ ...input, branchId: input.branchId });
    const aggregate =
      parseAggregates(json).find((a) => a.branchId === input.branchId) ??
      emptyAggregate(input.branchId);
    const blocks = buildTenderTotalsBlocks(aggregate, parseGl(json, input.branchId));
    return { ...header, branchId: input.branchId, ...blocks };
  }

  /** The Tender Totals of one company, for the civil period `[from, to]` (by posting date), with `byBranch`. */
  async getCompanyReportScoped(input: {
    companyId: string;
    from: unknown;
    to: unknown;
  }): Promise<TenderTotalsCompanyReport> {
    assertUuid(input.companyId, 'company');
    const { json, header } = await this.read({ ...input, branchId: null });
    const aggregates = parseAggregates(json);
    const gl = parseGlRows(json);
    // the company aggregate is the EXACT sum of the branch aggregates — one source of truth
    const blocks = buildTenderTotalsBlocks(sumTenderAggregates('COMPANY', aggregates), gl);
    return {
      ...header,
      ...blocks,
      byBranch: aggregates.map((a) => ({
        branchId: a.branchId,
        ...buildTenderTotalsBlocks(
          a,
          gl.filter((g) => g.branchId === a.branchId),
        ),
      })),
    };
  }

  /** ONE read statement in the read-only scoped transaction, then the integrity gates. */
  private async read(input: {
    companyId: string;
    from: unknown;
    to: unknown;
    branchId: string | null;
  }): Promise<{ json: TenderTotalsReportJson; header: ReportHeader }> {
    const { from, to } = parseReportDateRange({ from: input.from, to: input.to });
    const tenantId = this.tenantIdOrThrow();
    const query = buildTenderTotalsReportQuery({
      tenantId,
      companyId: input.companyId,
      from,
      to,
      branchId: input.branchId,
      maxMovements: this.maxMovements,
    });
    const rows = await this.readScoped((tx) =>
      tx.$queryRawUnsafe<{ report: string }[]>(query.text, ...query.values),
    );
    const raw = rows[0]?.report;
    if (raw === undefined) throw new NotFoundError('company');
    const json = JSON.parse(raw) as TenderTotalsReportJson;
    if (json.company === null) throw new NotFoundError('company');
    if (input.branchId !== null && json.branchFound !== 1) throw new NotFoundError('branch');
    // THE DENSITY GUARD (TT-1): the statement counted the COMPANY-window's logical tender movements (at most limit + 1
    // journals) in its first stage and, above the limit, never executed any heavy stage — so this rejection reads nothing
    // else, runs BEFORE the authority and every integrity check (no financial figure is returned, so none is analysed),
    // and reveals neither the count nor anything of a sibling branch: the same generic answer on both routes
    if (json.candidateMovements > this.maxMovements) {
      throw new DomainError(
        'REPORT_RESULT_TOO_LARGE',
        `the requested period holds more tender movements than a Tender Totals report can cover (limit ${this.maxMovements}) — narrow the date range`,
        422,
        [
          { field: 'maxMovements', issue: String(this.maxMovements) },
          { field: 'action', issue: 'narrow_date_range' },
        ],
      );
    }

    const authority = resolveCompanyReportAuthority(json.company);
    assertSourceIntegrity(json);
    return {
      json,
      header: {
        companyId: input.companyId,
        currencyCode: authority.currencyCode,
        currencyExponent: authority.currencyExponent,
        accountingTimezone: authority.accountingTimezone,
        from,
        to,
      },
    };
  }
}

/** Fail closed on a malformed financial state — never repaired, never disclosed beyond a check name. */
function assertSourceIntegrity(json: TenderTotalsReportJson): void {
  const i = json.integrity;
  if (i.currencyMismatchDocuments > 0) {
    throw new DomainError(
      'REPORT_CURRENCY_MISMATCH',
      "a tender source document or its journal is in a currency other than the company's accounting currency — no report is returned",
      409,
    );
  }
  const broken = (
    [
      ['orphanReceiptJournals', i.orphanReceiptJournals],
      ['orphanWalkInJournals', i.orphanWalkInJournals],
      ['orphanRefundJournals', i.orphanRefundJournals],
      ['branchMismatchLines', i.branchMismatchLines],
      ['receiptJournalMismatches', i.receiptJournalMismatches],
      ['refundJournalMismatches', i.refundJournalMismatches],
      ['refundUnmappedMethods', i.refundUnmappedMethods],
      ['walkInTenderMismatches', i.walkInTenderMismatches],
      ['walkInOnCustomerInvoices', i.walkInOnCustomerInvoices],
      ['walkInPaymentAllocationFanout', i.walkInPaymentAllocationFanout],
      ['walkInPaymentBranchMismatches', i.walkInPaymentBranchMismatches],
      ['anonymousPaymentsWithReceiptJournal', i.anonymousPaymentsWithReceiptJournal],
      ['allocatedPaymentsWithoutReceiptJournal', i.allocatedPaymentsWithoutReceiptJournal],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([name]) => name);
  if (broken.length > 0) {
    throw new DomainError(
      'REPORT_TENDER_SOURCE_INTEGRITY',
      `a tender journal is inconsistent with its source document (${broken.join(', ')}) — no report is returned`,
      500,
    );
  }
}

function emptyAggregate(branchId: string): TenderBranchAggregate {
  return { branchId, receipts: [], refunds: [] };
}

/** Every branch with activity → its aggregate, in branch-id order. */
function parseAggregates(json: TenderTotalsReportJson): TenderBranchAggregate[] {
  const byBranch = new Map<
    string,
    {
      receipts: TenderBranchAggregate['receipts'][number][];
      refunds: TenderBranchAggregate['refunds'][number][];
    }
  >();
  const slot = (branchId: string) => {
    let s = byBranch.get(branchId);
    if (s === undefined) {
      s = { receipts: [], refunds: [] };
      byBranch.set(branchId, s);
    }
    return s;
  };
  for (const r of json.receipts) {
    slot(r.branchId).receipts.push({
      stream: r.stream as TenderStream,
      method: r.method,
      count: r.count,
      total: parseMinorUnitsText(r.totalMinor, 'receipt totalMinor'),
    });
  }
  for (const r of json.refunds) {
    slot(r.branchId).refunds.push({
      method: r.method,
      accountKey: r.accountKey,
      count: r.count,
      total: parseMinorUnitsText(r.totalMinor, 'refund totalMinor'),
    });
  }
  return [...byBranch.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([branchId, s]) => ({ branchId, receipts: s.receipts, refunds: s.refunds }));
}

function parseGlRows(json: TenderTotalsReportJson): TenderGlAggregate[] {
  return json.gl.map((g) => ({
    branchId: g.branchId,
    sourceKind: g.sourceKind,
    accountKey: g.accountKey,
    debit: parseMinorUnitsText(g.debitMinor, 'debitMinor'),
    credit: parseMinorUnitsText(g.creditMinor, 'creditMinor'),
  }));
}

function parseGl(json: TenderTotalsReportJson, branchId: string): TenderGlAggregate[] {
  return parseGlRows(json).filter((g) => g.branchId === branchId);
}
