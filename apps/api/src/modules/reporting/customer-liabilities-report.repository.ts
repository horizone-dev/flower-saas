import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/data/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertUuid } from '../catalog/catalog-write.helpers.js';
import { parseMinorUnitsText, resolveCompanyReportAuthority } from './report-money.js';
import { ReportingRepository } from './reporting.repository.js';
import {
  assertAsOf,
  buildCustomerLiabilityRows,
  buildLiabilityBlocks,
  parseLiabilitiesCursor,
  parseLiabilitiesLimit,
  type AdvanceCell,
  type LiabilityBlocks,
  type LiabilityCustomerRow,
  type UnappliedCell,
} from './customer-liabilities-report.js';
import {
  buildCustomerLiabilitiesReportQuery,
  CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS,
  type CustomerLiabilitiesReportJson,
} from './customer-liabilities-report.sql.js';

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
export interface LiabilitiesCustomerPage {
  readonly rows: readonly LiabilityCustomerRow[];
  /** the last emitted customerId when more customers follow, else `null` (the last page — no trailing empty request) */
  readonly nextCursor: string | null;
}

/** One branch's current liabilities — also the shape of a `byBranch` row of the company report. */
export interface LiabilitiesBranchRow extends LiabilityBlocks {
  readonly branchId: string;
}

/** The current liabilities of ONE branch. */
export interface LiabilitiesBranchReport extends ReportHeader, LiabilityBlocks {
  readonly branchId: string;
  readonly customers: LiabilitiesCustomerPage;
}

/** The current liabilities of ONE company: the company aggregate plus one row per branch holding a liability. */
export interface LiabilitiesCompanyReport extends ReportHeader, LiabilityBlocks {
  readonly byBranch: readonly LiabilitiesBranchRow[];
  readonly customers: LiabilitiesCustomerPage;
}

/**
 * Task 3b.10 Checkpoint E — the customer-liabilities CURRENT-STATE report: Customer Advances (book liability, pending
 * provider-refund reservation, available balance) and Unapplied Receipts, each with its OWN source figures and its OWN
 * source-to-GL reconciliation, never netted. READ-ONLY, ONE statement in ONE database-enforced read-only scoped transaction —
 * one snapshot. NOT registered in any Nest module and NOT reachable over HTTP.
 *
 * There is NO period input and NO historical `asOf` input: the report is the state at the instant the database read it, and
 * `asOf` is that database timestamp. The per-customer rows are cursor-paginated (keyset on customerId); the summaries,
 * `byBranch` and both GL controls cover the WHOLE requested scope, never just the page.
 *
 * The report is bounded by ONE density guard (owner ruling EL-1) — no calendar cap, no aging: at most
 * `CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS` liability roots (customer-attributable Payments + CustomerAdvances) in the ACTUAL
 * EVALUATED scope (the company, or the requested branch alone, or the customer filter after its company / branch scope).
 * Above it the report is rejected (`REPORT_RESULT_TOO_LARGE`, 422) from the first stage of the same statement, before any
 * financial figure is produced or any integrity analysis is made; the actual count is never disclosed.
 */
@Injectable()
export class CustomerLiabilitiesReportRepository extends ReportingRepository {
  /**
   * The v1 density limit (owner ruling EL-1) — the ONE authoritative constant. A `protected` seam only so a test can
   * exercise the boundary on a small real-document world; nothing in production overrides it.
   */
  protected readonly maxRoots: number = CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS;

  constructor(db: DbService) {
    super(db);
  }

  /** The current liabilities of one branch of one company (optionally one customer). */
  async getBranchReportScoped(input: {
    companyId: string;
    branchId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<LiabilitiesBranchReport> {
    assertUuid(input.companyId, 'company');
    assertUuid(input.branchId, 'branch');
    const { json, header, limit } = await this.read({ ...input, branchId: input.branchId });
    const cells = parseCells(json);
    const gl = glNetByControlAndBranch(json);
    const blocks = branchBlocks(cells, gl, input.branchId);
    return { ...header, branchId: input.branchId, ...blocks, customers: customerPage(json, limit) };
  }

  /** The current liabilities of one company (optionally one customer), with `byBranch`. */
  async getCompanyReportScoped(input: {
    companyId: string;
    customerId?: string | null;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<LiabilitiesCompanyReport> {
    assertUuid(input.companyId, 'company');
    const { json, header, limit } = await this.read({ ...input, branchId: null });
    const cells = parseCells(json);
    const gl = glNetByControlAndBranch(json);
    // each company control is the whole authoritative liability of the company: every branch's journals plus (only when the
    // report is unfiltered) any authoritative-kind journal line that has no source fact at all
    const orphanNet = (o: { debitMinor: string; creditMinor: string }): bigint =>
      parseMinorUnitsText(o.creditMinor, 'orphan creditMinor') -
      parseMinorUnitsText(o.debitMinor, 'orphan debitMinor');
    let glAdvances = orphanNet(json.glOrphan.advances);
    let glUnapplied = orphanNet(json.glOrphan.unapplied);
    for (const [key, net] of gl) {
      if (key.startsWith('A|')) glAdvances += net;
      else glUnapplied += net;
    }
    const blocks = buildLiabilityBlocks(
      [...cells.advances.values()].flat(),
      [...cells.unapplied.values()].flat(),
      glAdvances,
      glUnapplied,
    );
    const branchIds = [...new Set([...cells.advances.keys(), ...cells.unapplied.keys()])].sort(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const byBranch = branchIds.map((branchId) => ({
      branchId,
      ...branchBlocks(cells, gl, branchId),
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
  }): Promise<{ json: CustomerLiabilitiesReportJson; header: ReportHeader; limit: number }> {
    const customerId = input.customerId ?? null;
    if (customerId !== null) assertUuid(customerId, 'customer');
    const limit = parseLiabilitiesLimit(input.limit);
    const cursor = parseLiabilitiesCursor(input.cursor);
    const query = buildCustomerLiabilitiesReportQuery({
      tenantId: this.tenantIdOrThrow(),
      companyId: input.companyId,
      branchId: input.branchId,
      customerId,
      cursor,
      limit,
      maxRoots: this.maxRoots,
    });
    const rows = await this.readScoped((tx) =>
      tx.$queryRawUnsafe<{ report: string }[]>(query.text, ...query.values),
    );
    const raw = rows[0]?.report;
    if (raw === undefined) throw new NotFoundError('company');
    const json = JSON.parse(raw) as CustomerLiabilitiesReportJson;
    if (json.company === null) throw new NotFoundError('company');
    if (input.branchId !== null && json.branchFound !== 1) throw new NotFoundError('branch');
    if (customerId !== null && json.customerFound !== 1) throw new NotFoundError('customer');
    // THE DENSITY GUARD (EL-1): the statement counted the liability roots of the EVALUATED scope (at most limit + 1) in its
    // first stage and, above the limit, never executed any heavy stage — so this rejection reads nothing else, runs BEFORE
    // the authority and every integrity check (no financial figure is returned, so none is analysed), and reveals neither
    // the count nor anything of a sibling branch or another customer: the same generic answer on every route
    if (json.candidateRoots > this.maxRoots) {
      throw new DomainError(
        'REPORT_RESULT_TOO_LARGE',
        `the requested scope holds more customer liability records than a customer-liabilities report can cover (limit ${this.maxRoots}) — narrow the scope to one branch or one customer`,
        422,
        [
          { field: 'maxRoots', issue: String(this.maxRoots) },
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
function assertSourceIntegrity(json: CustomerLiabilitiesReportJson): void {
  const i = json.integrity;
  if (i.currencyMismatchDocuments > 0) {
    throw new DomainError(
      'REPORT_CURRENCY_MISMATCH',
      "an advance, a receipt, one of their applications or a journal is in a currency other than the company's accounting currency — no report is returned",
      409,
    );
  }
  const broken = (
    [
      ['advanceUnknownSourceTypes', i.advanceUnknownSourceTypes],
      ['advanceOverConsumed', i.advanceOverConsumed],
      ['advanceReservationBeyondAvailable', i.advanceReservationBeyondAvailable],
      ['advanceApplicationBranchMismatches', i.advanceApplicationBranchMismatches],
      ['advanceRefundApplicationBranchMismatches', i.advanceRefundApplicationBranchMismatches],
      ['advanceReservationBranchMismatches', i.advanceReservationBranchMismatches],
      ['paymentAdvancesWithoutPayment', i.paymentAdvancesWithoutPayment],
      ['creditNoteAdvancesWithoutRelease', i.creditNoteAdvancesWithoutRelease],
      ['paymentOverConsumed', i.paymentOverConsumed],
      ['allocationBranchMismatches', i.allocationBranchMismatches],
      [
        'receivablePaymentApplicationBranchMismatches',
        i.receivablePaymentApplicationBranchMismatches,
      ],
      ['paymentAdvanceBranchMismatches', i.paymentAdvanceBranchMismatches],
      ['advanceMissingJournals', i.advanceMissingJournals],
      ['advanceJournalShapeMismatches', i.advanceJournalShapeMismatches],
      ['advanceJournalBranchMismatches', i.advanceJournalBranchMismatches],
      ['advanceOrphanJournals', i.advanceOrphanJournals],
      ['unappliedMissingJournals', i.unappliedMissingJournals],
      ['unappliedJournalShapeMismatches', i.unappliedJournalShapeMismatches],
      ['unappliedJournalBranchMismatches', i.unappliedJournalBranchMismatches],
      ['unappliedOrphanJournals', i.unappliedOrphanJournals],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([name]) => name);
  if (broken.length > 0) {
    throw new DomainError(
      'REPORT_LIABILITIES_SOURCE_INTEGRITY',
      `a customer advance or receipt is inconsistent with its source documents or their journals (${broken.join(', ')}) — no report is returned`,
      500,
    );
  }
}

interface ParsedCells {
  readonly advances: Map<string, AdvanceCell[]>;
  readonly unapplied: Map<string, UnappliedCell[]>;
}

/** every branch with a liability → its advance (source type) cells and its unapplied cell, in branch-id order */
function parseCells(json: CustomerLiabilitiesReportJson): ParsedCells {
  const advances = new Map<string, AdvanceCell[]>();
  for (const c of json.advanceCells) {
    let slot = advances.get(c.branchId);
    if (slot === undefined) {
      slot = [];
      advances.set(c.branchId, slot);
    }
    slot.push({
      sourceType: c.sourceType,
      count: c.count,
      principal: parseMinorUnitsText(c.originalMinor, 'originalMinor'),
      applied: parseMinorUnitsText(c.appliedMinor, 'appliedMinor'),
      refunded: parseMinorUnitsText(c.refundedMinor, 'refundedMinor'),
      reserved: parseMinorUnitsText(c.reservedMinor, 'reservedMinor'),
    });
  }
  const unapplied = new Map<string, UnappliedCell[]>();
  for (const c of json.unappliedCells) {
    let slot = unapplied.get(c.branchId);
    if (slot === undefined) {
      slot = [];
      unapplied.set(c.branchId, slot);
    }
    slot.push({
      paymentCount: c.paymentCount,
      paymentCountWithUnapplied: c.paymentCountWithUnapplied,
      original: parseMinorUnitsText(c.originalMinor, 'originalMinor'),
      allocated: parseMinorUnitsText(c.allocatedMinor, 'allocatedMinor'),
      receivableApplied: parseMinorUnitsText(c.receivableAppliedMinor, 'receivableAppliedMinor'),
      converted: parseMinorUnitsText(c.convertedMinor, 'convertedMinor'),
    });
  }
  return { advances, unapplied };
}

/** the GL liability (credit − debit) of each (control, branch)'s authoritative journals — keyed `A|<branch>` / `U|<branch>` */
function glNetByControlAndBranch(json: CustomerLiabilitiesReportJson): Map<string, bigint> {
  return new Map(
    json.gl.map((g) => [
      `${g.control}|${g.branchId}`,
      parseMinorUnitsText(g.creditMinor, 'creditMinor') -
        parseMinorUnitsText(g.debitMinor, 'debitMinor'),
    ]),
  );
}

/** the blocks of ONE branch: its cells and its OWN GL nets — one control per account, never combined */
function branchBlocks(
  cells: ParsedCells,
  gl: ReadonlyMap<string, bigint>,
  branchId: string,
): LiabilityBlocks {
  return buildLiabilityBlocks(
    cells.advances.get(branchId) ?? [],
    cells.unapplied.get(branchId) ?? [],
    gl.get(`A|${branchId}`) ?? 0n,
    gl.get(`U|${branchId}`) ?? 0n,
  );
}

function customerPage(json: CustomerLiabilitiesReportJson, limit: number): LiabilitiesCustomerPage {
  const rows = buildCustomerLiabilityRows(
    json.advanceCustomerCells.map((c) => ({
      customerId: c.customerId,
      sourceType: c.sourceType,
      count: c.count,
      principal: parseMinorUnitsText(c.originalMinor, 'originalMinor'),
      applied: parseMinorUnitsText(c.appliedMinor, 'appliedMinor'),
      refunded: parseMinorUnitsText(c.refundedMinor, 'refundedMinor'),
      reserved: parseMinorUnitsText(c.reservedMinor, 'reservedMinor'),
    })),
    json.unappliedCustomerCells.map((c) => ({
      customerId: c.customerId,
      paymentCount: c.paymentCount,
      paymentCountWithUnapplied: c.paymentCountWithUnapplied,
      original: parseMinorUnitsText(c.originalMinor, 'originalMinor'),
      allocated: parseMinorUnitsText(c.allocatedMinor, 'allocatedMinor'),
      receivableApplied: parseMinorUnitsText(c.receivableAppliedMinor, 'receivableAppliedMinor'),
      converted: parseMinorUnitsText(c.convertedMinor, 'convertedMinor'),
    })),
  );
  if (rows.length > limit) {
    // the statement emits at most `limit` customers; more is a defect, never a silently longer page
    throw new DomainError(
      'REPORT_LIABILITIES_SOURCE_INTEGRITY',
      'a customer advance or receipt is inconsistent with its source documents or their journals — no report is returned',
      500,
    );
  }
  return {
    rows,
    nextCursor: json.hasMore && rows.length > 0 ? rows[rows.length - 1]!.customerId : null,
  };
}
