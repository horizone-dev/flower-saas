import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { parseMinorUnitsText, resolveCompanyReportAuthority } from './report-money.js';
import { ReportingRepository } from './reporting.repository.js';
import {
  assertAsOf,
  buildCustomerRows,
  buildReceivablesBlocks,
  parseReceivablesCursor,
  parseReceivablesLimit,
  type ReceivablesBlocks,
  type ReceivablesCell,
  type ReceivablesCustomerRow,
} from './receivables-report.js';
import {
  buildReceivablesReportQuery,
  RECEIVABLES_REPORT_MAX_RECEIVABLES,
  type ReceivablesReportJson,
} from './receivables-report.sql.js';

interface ReportHeader {
  readonly companyId: string;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly accountingTimezone: string;
  /** the database snapshot instant (ISO-8601 UTC) the whole report was read at — never an input */
  readonly asOf: string;
  /** the requested customer filter (a report identifier, never PII), or `null` */
  readonly customerId: string | null;
}

/** The per-customer page: aggregate rows (financial identifiers only — no PII) and the keyset cursor. */
export interface ReceivablesCustomerPage {
  readonly rows: readonly ReceivablesCustomerRow[];
  /** the last emitted customerId when more customers follow, else `null` (the last page — no trailing empty request) */
  readonly nextCursor: string | null;
}

/** One branch's current receivables — also the shape of a `byBranch` row of the company report. */
export interface ReceivablesBranchRow extends ReceivablesBlocks {
  readonly branchId: string;
}

/** The current receivables of ONE branch. */
export interface ReceivablesBranchReport extends ReportHeader, ReceivablesBlocks {
  readonly branchId: string;
  readonly customers: ReceivablesCustomerPage;
}

/** The current receivables of ONE company: the company aggregate plus one row per branch holding a receivable. */
export interface ReceivablesCompanyReport extends ReportHeader, ReceivablesBlocks {
  readonly byBranch: readonly ReceivablesBranchRow[];
  readonly customers: ReceivablesCustomerPage;
}

/**
 * Task 3b.10 Checkpoint D — the Receivables CURRENT-STATE report (the original receivable, what payment allocations,
 * customer-advance applications and credit-note AR reductions satisfied, the current outstanding, the source-type
 * breakdown, per-customer aggregate rows and the source-to-GL Accounts-Receivable reconciliation). READ-ONLY, ONE
 * statement in ONE database-enforced read-only scoped transaction — one snapshot. NOT registered in any Nest module and
 * NOT reachable over HTTP.
 *
 * There is NO period input and NO historical `asOf` input: the report is the state at the instant the database read it,
 * and `asOf` is that database timestamp. The per-customer rows are cursor-paginated (keyset on customerId); the summary,
 * `byBranch` and the GL control cover the WHOLE requested scope, never just the page.
 *
 * The report is bounded by ONE density guard (owner ruling RD-1) — no calendar cap, no aging: at most
 * `RECEIVABLES_REPORT_MAX_RECEIVABLES` CustomerReceivable records in the ACTUAL EVALUATED scope (the company, or the
 * requested branch alone, or the customer filter after its company / branch scope). Above it the report is rejected
 * (`REPORT_RESULT_TOO_LARGE`, 422) from the first stage of the same statement, before any financial figure is produced or
 * any integrity analysis is made; the actual count is never disclosed.
 */
@Injectable()
export class ReceivablesReportRepository extends ReportingRepository {
  /**
   * The v1 density limit (owner ruling RD-1) — the ONE authoritative constant. A `protected` seam only so a test can
   * exercise the boundary on a small real-document world; nothing in production overrides it.
   */
  protected readonly maxReceivables: number = RECEIVABLES_REPORT_MAX_RECEIVABLES;

  constructor(db: DbService) {
    super(db);
  }

  /** The current receivables of one branch of one company (optionally one customer). */
  async getBranchReportScoped(input: {
    companyId: string;
    branchId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<ReceivablesBranchReport> {
    assertUuid(input.companyId, 'company');
    assertUuid(input.branchId, 'branch');
    const { json, header, limit } = await this.read({ ...input, branchId: input.branchId });
    const cells = parseCells(json);
    const gl = glNetByBranch(json);
    const blocks = buildReceivablesBlocks(
      cells.get(input.branchId) ?? [],
      gl.get(input.branchId) ?? 0n,
    );
    return { ...header, branchId: input.branchId, ...blocks, customers: customerPage(json, limit) };
  }

  /** The current receivables of one company (optionally one customer), with `byBranch`. */
  async getCompanyReportScoped(input: {
    companyId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<ReceivablesCompanyReport> {
    assertUuid(input.companyId, 'company');
    const { json, header, limit } = await this.read({ ...input, branchId: null });
    const cells = parseCells(json);
    const gl = glNetByBranch(json);
    // the company control is the whole authoritative AR of the company: every branch's journals plus (only when the
    // report is unfiltered) any authoritative-kind journal that has no source fact at all
    const orphanNet =
      parseMinorUnitsText(json.glOrphan.debitMinor, 'orphan debitMinor') -
      parseMinorUnitsText(json.glOrphan.creditMinor, 'orphan creditMinor');
    let glTotal = orphanNet;
    for (const v of gl.values()) glTotal += v;
    const blocks = buildReceivablesBlocks([...cells.values()].flat(), glTotal);
    const byBranch = [...cells.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([branchId, branchCells]) => ({
        branchId,
        ...buildReceivablesBlocks(branchCells, gl.get(branchId) ?? 0n),
      }));
    return { ...header, ...blocks, byBranch, customers: customerPage(json, limit) };
  }

  /** ONE read statement in the read-only scoped transaction, then the integrity gates. */
  private async read(input: {
    companyId: string;
    branchId: string | null;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<{ json: ReceivablesReportJson; header: ReportHeader; limit: number }> {
    const customerId = input.customerId ?? null;
    if (customerId !== null) assertUuid(customerId, 'customer');
    const limit = parseReceivablesLimit(input.limit);
    const cursor = parseReceivablesCursor(input.cursor);
    const query = buildReceivablesReportQuery({
      tenantId: this.tenantIdOrThrow(),
      companyId: input.companyId,
      branchId: input.branchId,
      customerId,
      cursor,
      limit,
      maxReceivables: this.maxReceivables,
    });
    const rows = await this.readScoped((tx) =>
      tx.$queryRawUnsafe<{ report: string }[]>(query.text, ...query.values),
    );
    const raw = rows[0]?.report;
    if (raw === undefined) throw new NotFoundError('company');
    const json = JSON.parse(raw) as ReceivablesReportJson;
    if (json.company === null) throw new NotFoundError('company');
    if (input.branchId !== null && json.branchFound !== 1) throw new NotFoundError('branch');
    if (customerId !== null && json.customerFound !== 1) throw new NotFoundError('customer');
    // THE DENSITY GUARD (RD-1): the statement counted the receivables of the EVALUATED scope (at most limit + 1) in its first
    // stage and, above the limit, never executed any heavy stage — so this rejection reads nothing else, runs BEFORE the
    // authority and every integrity check (no financial figure is returned, so none is analysed), and reveals neither the
    // count nor anything of a sibling branch or another customer: the same generic answer on every route
    if (json.candidateReceivables > this.maxReceivables) {
      throw new DomainError(
        'REPORT_RESULT_TOO_LARGE',
        `the requested scope holds more customer receivables than a Receivables report can cover (limit ${this.maxReceivables}) — narrow the scope to one branch or one customer`,
        422,
        [
          { field: 'maxReceivables', issue: String(this.maxReceivables) },
          { field: 'action', issue: 'narrow_scope' },
        ],
      );
    }

    const authority = resolveCompanyReportAuthority(json.company);
    assertSourceIntegrity(json);
    return {
      json,
      limit,
      header: {
        companyId: input.companyId,
        currencyCode: authority.currencyCode,
        currencyExponent: authority.currencyExponent,
        accountingTimezone: authority.accountingTimezone,
        asOf: assertAsOf(json.asOf),
        customerId,
      },
    };
  }
}

/** Fail closed on a malformed financial state — never repaired, never disclosed beyond a check name. */
function assertSourceIntegrity(json: ReceivablesReportJson): void {
  const i = json.integrity;
  if (i.currencyMismatchDocuments > 0) {
    throw new DomainError(
      'REPORT_CURRENCY_MISMATCH',
      "a receivable, one of its applications or its journal is in a currency other than the company's accounting currency — no report is returned",
      409,
    );
  }
  const broken = (
    [
      ['unknownSourceTypes', i.unknownSourceTypes],
      ['unresolvedPrincipals', i.unresolvedPrincipals],
      ['overCoveredReceivables', i.overCoveredReceivables],
      ['sourceBranchMismatches', i.sourceBranchMismatches],
      ['applicationBranchMismatches', i.applicationBranchMismatches],
      ['paymentApplicationsOnInvoiceReceivables', i.paymentApplicationsOnInvoiceReceivables],
      ['missingJournals', i.missingJournals],
      ['journalShapeMismatches', i.journalShapeMismatches],
      ['journalBranchMismatches', i.journalBranchMismatches],
      ['orphanJournals', i.orphanJournals],
      ['creditNotesWithoutReceivable', i.creditNotesWithoutReceivable],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([name]) => name);
  if (broken.length > 0) {
    throw new DomainError(
      'REPORT_RECEIVABLES_SOURCE_INTEGRITY',
      `a customer receivable is inconsistent with its source documents or their journals (${broken.join(', ')}) — no report is returned`,
      500,
    );
  }
}

/** every branch with a receivable → its (source type) cells, in branch-id order */
function parseCells(json: ReceivablesReportJson): Map<string, ReceivablesCell[]> {
  const byBranch = new Map<string, ReceivablesCell[]>();
  for (const c of json.cells) {
    let slot = byBranch.get(c.branchId);
    if (slot === undefined) {
      slot = [];
      byBranch.set(c.branchId, slot);
    }
    slot.push({
      sourceType: c.sourceType,
      count: c.count,
      original: parseMinorUnitsText(c.originalMinor, 'originalMinor'),
      paidByPayment: parseMinorUnitsText(c.paidByPaymentMinor, 'paidByPaymentMinor'),
      paidByAdvance: parseMinorUnitsText(c.paidByAdvanceMinor, 'paidByAdvanceMinor'),
      credited: parseMinorUnitsText(c.creditedMinor, 'creditedMinor'),
    });
  }
  return new Map([...byBranch.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** the GL Accounts-Receivable net (debit − credit) of each branch's authoritative journals */
function glNetByBranch(json: ReceivablesReportJson): Map<string, bigint> {
  return new Map(
    json.gl.map((g) => [
      g.branchId,
      parseMinorUnitsText(g.debitMinor, 'debitMinor') -
        parseMinorUnitsText(g.creditMinor, 'creditMinor'),
    ]),
  );
}

function customerPage(json: ReceivablesReportJson, limit: number): ReceivablesCustomerPage {
  const rows = buildCustomerRows(
    json.customerCells.map((c) => ({
      customerId: c.customerId,
      sourceType: c.sourceType,
      count: c.count,
      original: parseMinorUnitsText(c.originalMinor, 'originalMinor'),
      paidByPayment: parseMinorUnitsText(c.paidByPaymentMinor, 'paidByPaymentMinor'),
      paidByAdvance: parseMinorUnitsText(c.paidByAdvanceMinor, 'paidByAdvanceMinor'),
      credited: parseMinorUnitsText(c.creditedMinor, 'creditedMinor'),
    })),
  );
  if (rows.length > limit) {
    // the statement emits at most `limit` customers; more is a defect, never a silently longer page
    throw new DomainError(
      'REPORT_RECEIVABLES_SOURCE_INTEGRITY',
      'a customer receivable is inconsistent with its source documents or their journals — no report is returned',
      500,
    );
  }
  return {
    rows,
    nextCursor: json.hasMore && rows.length > 0 ? rows[rows.length - 1]!.customerId : null,
  };
}
