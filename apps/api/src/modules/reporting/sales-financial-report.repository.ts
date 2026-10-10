import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { ReportingRepository } from './reporting.repository.js';
import { parseSalesReportRange, SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';
import { parseMinorUnitsText, resolveCompanyReportAuthority } from './report-money.js';
import {
  lineDiscountCrossCheckFailures,
  verifyInvoiceLineSets,
  type InvoiceLineSetProof,
} from './sales-invoice-line-set-proof.js';
import {
  buildSalesFinancialBlocks,
  sumAggregates,
  type SalesBranchAggregate,
  type SalesFinancialBlocks,
  type SalesGlAggregate,
  type SalesStatusAggregate,
} from './sales-financial-report.js';
import {
  buildSalesFinancialReportQuery,
  type SalesFinancialReportJson,
} from './sales-financial-report.sql.js';

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

/** One branch's Sales Financial Report — also the shape of a `byBranch` row of the company report. */
export interface SalesFinancialBranchRow extends SalesFinancialBlocks {
  readonly branchId: string;
}

/** The Sales Financial Report of ONE branch. */
export interface SalesFinancialBranchReport extends ReportHeader, SalesFinancialBlocks {
  readonly branchId: string;
}

/** The Sales Financial Report of ONE company: the company aggregate plus one row per branch with activity. */
export interface SalesFinancialCompanyReport extends ReportHeader, SalesFinancialBlocks {
  readonly byBranch: readonly SalesFinancialBranchRow[];
}

@Injectable()
export class SalesFinancialReportRepository extends ReportingRepository {
  /**
   * The v1 density limit — the ONE authoritative constant. A `protected` seam only so a test can exercise the
   * boundary on a small real-document world; nothing in production overrides it.
   */
  protected readonly maxDocuments: number = SALES_REPORT_MAX_DOCUMENTS;

  constructor(db: DbService) {
    super(db);
  }

  /** The report of one branch of one company, for the civil period `[from, to]` (by posting date). */
  async getBranchReportScoped(input: {
    companyId: string;
    branchId: string;
    from: unknown;
    to: unknown;
  }): Promise<SalesFinancialBranchReport> {
    assertUuid(input.companyId, 'company');
    assertUuid(input.branchId, 'branch');
    const { json, header } = await this.read({ ...input, branchId: input.branchId });
    if (json.branchFound !== 1) throw new NotFoundError('branch');
    const rows = this.branchRows(json);
    const blocks = rows.get(input.branchId) ?? this.emptyBlocks(input.branchId);
    return { ...header, branchId: input.branchId, ...blocks };
  }

  /** The report of one company, for the civil period `[from, to]` (by posting date), with `byBranch`. */
  async getCompanyReportScoped(input: {
    companyId: string;
    from: unknown;
    to: unknown;
  }): Promise<SalesFinancialCompanyReport> {
    assertUuid(input.companyId, 'company');
    const { json, header } = await this.read({ ...input, branchId: null });
    const rows = this.branchRows(json);
    // the company aggregate is the EXACT sum of the branch aggregates — one source of truth
    const aggregates = parseAggregates(json);
    const blocks = buildSalesFinancialBlocks(
      sumAggregates('COMPANY', aggregates),
      parseStatuses(json),
      parseGl(json),
    );
    return {
      ...header,
      ...blocks,
      byBranch: [...rows.entries()].map(([branchId, b]) => ({ branchId, ...b })),
    };
  }

  /** ONE read statement in the read-only scoped transaction, then the integrity gates. */
  private async read(input: {
    companyId: string;
    from: unknown;
    to: unknown;
    branchId: string | null;
  }): Promise<{ json: SalesFinancialReportJson; header: ReportHeader }> {
    const { from, to } = parseSalesReportRange({ from: input.from, to: input.to });
    const tenantId = this.tenantIdOrThrow();
    const query = buildSalesFinancialReportQuery({
      tenantId,
      companyId: input.companyId,
      from,
      to,
      branchId: input.branchId,
      maxDocuments: this.maxDocuments,
    });
    const rows = await this.readScoped((tx) =>
      tx.$queryRawUnsafe<{ report: string }[]>(query.text, ...query.values),
    );
    const raw = rows[0]?.report;
    if (raw === undefined) throw new NotFoundError('company');
    const json = JSON.parse(raw) as SalesFinancialReportJson;
    if (json.company === null) throw new NotFoundError('company');
    // THE DENSITY GUARD: the statement counted the financial documents of the scope (at most limit + 1) in its
    // first stage and, above the limit, never executed any heavy stage — so this rejection reads nothing else
    if (json.candidateDocuments > this.maxDocuments) {
      throw new DomainError(
        'REPORT_RESULT_TOO_LARGE',
        `the Sales Financial Report of this ${input.branchId === null ? 'company' : 'branch'} and period would hold more than ${this.maxDocuments} financial documents — narrow the period${input.branchId === null ? ' or request one branch' : ''}`,
        422,
        [{ field: 'period', issue: `more than ${this.maxDocuments} financial documents` }],
      );
    }

    const authority = resolveCompanyReportAuthority(json.company);
    // the line-discount authority: every invoice's CURRENT order lines must hash to the order's immutable
    // commercial fingerprint, or no report is returned (owner correction 1)
    const proof = verifyInvoiceLineSets(json.invoiceLineSets);
    assertSourceIntegrity(
      json,
      proof,
      lineDiscountCrossCheckFailures(parseAggregates(json), proof),
    );
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

  /** Every branch with activity → its blocks, built from ONLY that branch's rows. */
  private branchRows(json: SalesFinancialReportJson): Map<string, SalesFinancialBlocks> {
    const statuses = parseStatuses(json);
    const gl = parseGl(json);
    const out = new Map<string, SalesFinancialBlocks>();
    for (const a of parseAggregates(json)) {
      out.set(
        a.branchId,
        buildSalesFinancialBlocks(
          a,
          statuses.filter((s) => s.branchId === a.branchId),
          gl.filter((g) => g.branchId === a.branchId),
        ),
      );
    }
    return out;
  }

  private emptyBlocks(branchId: string): SalesFinancialBlocks {
    return buildSalesFinancialBlocks(sumAggregates(branchId, []), [], []);
  }
}

/** Fail closed on a malformed financial state — never repaired, never disclosed beyond a check name. */
function assertSourceIntegrity(
  json: SalesFinancialReportJson,
  proof: InvoiceLineSetProof,
  lineDiscountCrossCheckMismatches: number,
): void {
  const i = json.integrity;
  if (i.currencyMismatchDocuments > 0) {
    throw new DomainError(
      'REPORT_CURRENCY_MISMATCH',
      "a sales source document or its journal is in a currency other than the company's accounting currency — no report is returned",
      409,
    );
  }
  const broken = (
    [
      ['orphanJournals', i.orphanJournals],
      ['branchMismatchLines', i.branchMismatchLines],
      ['duplicateRevenueJournals', i.duplicateRevenueJournals],
      ['revenueKindMismatches', i.revenueKindMismatches],
      ['creditNotesWithoutRevenueJournal', i.creditNotesWithoutRevenueJournal],
      ['invoiceLineSetMismatches', proof.mismatches],
      ['lineDiscountCrossCheckMismatches', lineDiscountCrossCheckMismatches],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([name]) => name);
  if (broken.length > 0) {
    throw new DomainError(
      'REPORT_SALES_SOURCE_INTEGRITY',
      `a sales financial journal is inconsistent with its source document (${broken.join(', ')}) — no report is returned`,
      500,
    );
  }
}

function parseAggregates(json: SalesFinancialReportJson): SalesBranchAggregate[] {
  return json.branches.map((b) => ({
    branchId: b.branchId,
    invoiceCount: b.invoiceCount,
    invoicedSubtotal: parseMinorUnitsText(b.invoicedSubtotalMinor, 'invoicedSubtotalMinor'),
    lineDiscount: parseMinorUnitsText(b.lineDiscountMinor, 'lineDiscountMinor'),
    documentDiscount: parseMinorUnitsText(b.documentDiscountMinor, 'documentDiscountMinor'),
    outputTax: parseMinorUnitsText(b.outputTaxMinor, 'outputTaxMinor'),
    invoicedTotal: parseMinorUnitsText(b.invoicedTotalMinor, 'invoicedTotalMinor'),
    creditNoteCount: b.creditNoteCount,
    creditNoteTotal: parseMinorUnitsText(b.creditNoteTotalMinor, 'creditNoteTotalMinor'),
    creditNoteTax: parseMinorUnitsText(b.creditNoteTaxMinor, 'creditNoteTaxMinor'),
    cancellationChargeCount: b.cancellationChargeCount,
    cancellationChargeNet: parseMinorUnitsText(
      b.cancellationChargeNetMinor,
      'cancellationChargeNetMinor',
    ),
    cancellationChargeTax: parseMinorUnitsText(
      b.cancellationChargeTaxMinor,
      'cancellationChargeTaxMinor',
    ),
    cancellationChargeTotal: parseMinorUnitsText(
      b.cancellationChargeTotalMinor,
      'cancellationChargeTotalMinor',
    ),
  }));
}

function parseStatuses(json: SalesFinancialReportJson): SalesStatusAggregate[] {
  return json.statuses.map((s) => ({
    branchId: s.branchId,
    status: s.status,
    count: s.count,
    total: parseMinorUnitsText(s.invoiceTotalMinor, 'invoiceTotalMinor'),
  }));
}

function parseGl(json: SalesFinancialReportJson): SalesGlAggregate[] {
  return json.gl.map((g) => ({
    branchId: g.branchId,
    sourceKind: g.sourceKind,
    accountKey: g.accountKey,
    debit: parseMinorUnitsText(g.debitMinor, 'debitMinor'),
    credit: parseMinorUnitsText(g.creditMinor, 'creditMinor'),
  }));
}
