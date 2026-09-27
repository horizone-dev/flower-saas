import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors every other 3b.6 internal
// primitive in this module): PARTICIPATES in the caller's already-open
// transaction, never opens its own — this is a READ-ONLY primitive, so it
// never takes a row lock either (unlike `CompanyFinancialConfigRepository`'s
// `lockCurrencyOnly`/`lockForPosting`, which exist for a WRITE path).
import type { ScopedTx } from '@flower/db';
import { currencyExponent, isKnownCurrency } from '@flower/money';
import { isFiscalDate } from '@flower/shared-types';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { assertValidIanaTimezone, derivePostingDate } from '../accounting/posting-date.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** The frozen 8-kind `CustomerAccountEntry.entryKind` vocabulary (Checkpoint
 *  A/D) — Checkpoint G resolves EVERY one of these, never silently skipping
 *  an unrecognized value (G14). */
const KNOWN_ENTRY_KINDS = new Set([
  'INVOICE',
  'PAYMENT',
  'PAYMENT_ALLOCATION',
  'OPENING_RECEIVABLE_PAYMENT_APPLIED',
  'ADVANCE',
  'ADVANCE_APPLIED',
  'OPENING_RECEIVABLE',
  'OPENING_ADVANCE',
]);

export interface ReadScopeInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  customerId: string;
}

interface ResolvedAccount {
  customerCompanyAccountId: string;
  customerId: string;
  currencyCode: string;
  currencyExponent: number;
  accountingTimezone: string | null;
  creditEnabled: boolean;
  creditLimitMinor: bigint | null;
  currentOutstandingMinor: bigint;
  advanceBalanceMinor: bigint;
}

/** G's Absolute Final Freeze Gate (§1) — the operational totals a caller at
 *  THIS branch is entitled to see: computed exclusively from THIS branch's
 *  own `CustomerReceivable`/`CustomerAdvance`/`Payment` rows. Never includes
 *  another branch's activity, regardless of the caller's own company/branch
 *  scope breadth. */
export interface CustomerAccountBranchFinancials {
  receivableOutstandingMinor: bigint;
  advanceAvailableMinor: bigint;
  unappliedReceiptMinor: bigint;
  openReceivableCount: number;
  openAdvanceCount: number;
}

/** `CustomerCompanyAccount` credit configuration/exposure is frozen
 *  COMPANY-scoped (Checkpoint B/C) — deliberately a SEPARATE concept from
 *  `branchFinancials` above, never conflated with it. `creditExposureMinor`
 *  is the company-wide authoritative receivable outstanding (the SAME
 *  figure the frozen Checkpoint C credit gate itself evaluates against),
 *  NOT this branch's own `receivableOutstandingMinor`. `projectionIntegrity`
 *  compares that SAME company-wide recomputation against the company-scoped
 *  projection columns — never a branch total against a company projection. */
export interface CustomerAccountCreditSummary {
  scope: 'COMPANY';
  creditEnabled: boolean;
  creditLimitMinor: bigint | null;
  creditExposureMinor: bigint;
  availableCreditMinor: bigint | null;
  /** `true` means the recomputed company-wide authoritative total currently
   *  agrees with the live projection column; `false` is a genuine integrity
   *  signal. Exposes booleans only — never leaks per-branch figures. This
   *  endpoint NEVER auto-heals the projection and NEVER returns the raw
   *  (possibly stale) projection as any headline number. */
  projectionIntegrity: {
    receivableProjectionMatches: boolean;
    advanceProjectionMatches: boolean;
  };
}

export interface CustomerAccountSummary {
  customerCompanyAccountId: string;
  currencyCode: string;
  currencyExponent: number;
  branchFinancials: CustomerAccountBranchFinancials;
  credit: CustomerAccountCreditSummary;
  asOf: string;
}

export interface ReceivableRow {
  customerReceivableId: string;
  sourceType: 'INVOICE' | 'OPENING';
  invoiceId: string | null;
  invoiceNumber: string | null;
  sourceDate: string;
  originalAmountMinor: bigint;
  paidByPaymentMinor: bigint;
  paidByAdvanceMinor: bigint;
  outstandingMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  createdAt: Date;
  openingEffectiveDate: string | null;
  openingNote: string | null;
  /** always populated — every returned row is OPEN by construction (G9). */
  ageDays: number;
}

export interface AdvanceRow {
  customerAdvanceId: string;
  sourceType: 'PAYMENT' | 'OPENING';
  sourcePaymentId: string | null;
  originalAmountMinor: bigint;
  appliedAmountMinor: bigint;
  availableAmountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  openingEffectiveDate: string | null;
  createdAt: Date;
}

export interface UnappliedReceiptRow {
  paymentId: string;
  method: string;
  receiptPurpose: 'INVOICE_COLLECTION' | 'CUSTOMER_RECEIPT';
  originalAmountMinor: bigint;
  consumedAmountMinor: bigint;
  unappliedAmountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  createdAt: Date;
}

export interface StatementLine {
  customerAccountEntryId: string;
  entryKind: string;
  financialDate: string;
  occurredAt: Date;
  receivableEffectMinor: bigint;
  advanceEffectMinor: bigint;
  unappliedReceiptEffectMinor: bigint;
  refs: Record<string, string | null>;
}

export interface StatementOpeningState {
  asOfDate: string;
  receivableOutstandingMinor: bigint;
  advanceAvailableMinor: bigint;
  unappliedReceiptMinor: bigint;
}

/**
 * Task 3b.6 Checkpoint G — the ONE read-model repository for the customer
 * financial account. NEVER a new financial authority (G2): every number here
 * is recomputed on each call from the frozen authoritative source rows
 * (`CustomerReceivable`/`CustomerAdvance`/`Payment`/`PaymentAllocation`/
 * `CustomerAdvanceApplication`/`CustomerReceivablePaymentApplication`/
 * `Invoice`) — `CustomerAccountEntry` is consulted ONLY as the chronology/
 * reference index for the statement (G1's frozen principle), never as a
 * source of Money. `CustomerOpeningBalanceInit` is NEVER read here — it has
 * no application-readable grant at all (Checkpoint F Absolute Final Freeze
 * Gate) and carries no Money regardless.
 *
 * SCOPE DECISION (corrected in the Absolute Final Freeze Gate pass — the
 * PRIOR revision wrongly made `getSummary` company-wide; that violated the
 * frozen G branch-read contract and is fixed here): `getSummary`'s
 * `branchFinancials` are computed EXCLUSIVELY from `:branchId`'s own rows —
 * never another branch's activity, regardless of how broad the caller's own
 * session scope is. `CustomerCompanyAccount` credit configuration/exposure
 * remains frozen COMPANY-scoped (Checkpoint B's own architecture-freeze
 * comment on the model, and the SAME scope the Checkpoint C credit gate
 * itself evaluates) — this is a DELIBERATELY SEPARATE concept, returned
 * under `credit` with an explicit `scope: "COMPANY"` tag, never conflated
 * with or named as if it were a branch total. Projection-integrity
 * comparison ALSO happens at company scope (a fresh, company-wide
 * recomputation vs `CustomerCompanyAccount.currentOutstandingMinor`/
 * `advanceBalanceMinor` — themselves company-wide by frozen design; a
 * branch-only total could never legitimately reconcile against them). The
 * detail lists/statement below (`listReceivables`/`listAdvances`/
 * `listUnappliedReceipts`/`getStatement`) filter by `branchId` exactly as
 * before — the individual `CustomerReceivable`/`CustomerAdvance`/`Payment`
 * rows are genuinely branch-scoped.
 */
@Injectable()
export class CustomerAccountReadRepository {
  private async resolveAccount(tx: ScopedTx, input: ReadScopeInput): Promise<ResolvedAccount> {
    const branchRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "branch"
       WHERE "id" = ${input.branchId}::uuid
         AND "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid`;
    if (!branchRows[0]) {
      throw new NotFoundError('branch', 'BRANCH_NOT_FOUND');
    }

    const rows = await tx.$queryRaw<
      {
        id: string;
        customerId: string;
        defaultCurrency: string | null;
        accountingTimezone: string | null;
        creditEnabled: boolean;
        creditLimitMinor: bigint | null;
        currentOutstandingMinor: bigint;
        advanceBalanceMinor: bigint;
      }[]
    >`
      SELECT cca."id" AS "id", cca."customerId" AS "customerId",
             co."defaultCurrency" AS "defaultCurrency",
             co."accountingTimezone" AS "accountingTimezone",
             cca."creditEnabled" AS "creditEnabled",
             cca."creditLimitMinor" AS "creditLimitMinor",
             cca."currentOutstandingMinor" AS "currentOutstandingMinor",
             cca."advanceBalanceMinor" AS "advanceBalanceMinor"
        FROM "customer_company_account" cca
        INNER JOIN "company" co ON co."id" = cca."companyId"
       WHERE cca."tenantId" = ${input.tenantId}::uuid
         AND cca."companyId" = ${input.companyId}::uuid
         AND cca."customerId" = ${input.customerId}::uuid`;
    const row = rows[0];
    if (!row) {
      throw new DomainError('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND', 'association not found', 404);
    }
    if (!row.defaultCurrency || !isKnownCurrency(row.defaultCurrency)) {
      throw new DomainError('ACCOUNTING_CURRENCY_NOT_CONFIGURED', 'company currency not set', 422);
    }
    return {
      customerCompanyAccountId: row.id,
      customerId: row.customerId,
      currencyCode: row.defaultCurrency,
      currencyExponent: currencyExponent(row.defaultCurrency),
      accountingTimezone: row.accountingTimezone,
      creditEnabled: row.creditEnabled,
      creditLimitMinor: row.creditLimitMinor,
      currentOutstandingMinor: row.currentOutstandingMinor,
      advanceBalanceMinor: row.advanceBalanceMinor,
    };
  }

  private requireTimezone(account: ResolvedAccount): string {
    if (!account.accountingTimezone) {
      throw new DomainError(
        'ACCOUNTING_TIMEZONE_NOT_CONFIGURED',
        'company accounting timezone not set',
        422,
      );
    }
    assertValidIanaTimezone(account.accountingTimezone);
    return account.accountingTimezone;
  }

  /** `branchId: null` = company-wide (every branch this account has activity
   *  in) — used ONLY for the company-scoped credit/projection computation,
   *  never for a branch-headline response field. */
  private async sumReceivablesOutstanding(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      customerCompanyAccountId: string;
      branchId: string | null;
    },
  ): Promise<{ outstandingMinor: bigint; openCount: number }> {
    const rows = await tx.$queryRaw<
      { id: string; original: bigint; paidByPayment: bigint; paidByAdvance: bigint }[]
    >`
      SELECT cr."id" AS "id",
             CASE WHEN cr."sourceType" = 'INVOICE' THEN i."totalAmountMinor" ELSE cr."openingAmountMinor" END AS "original",
             CASE WHEN cr."sourceType" = 'INVOICE'
               THEN COALESCE((SELECT SUM(pa."amountMinor") FROM "payment_allocation" pa WHERE pa."invoiceId" = cr."invoiceId"), 0)::bigint
               ELSE COALESCE((SELECT SUM(crpa."amountMinor") FROM "customer_receivable_payment_application" crpa WHERE crpa."customerReceivableId" = cr."id"), 0)::bigint
             END AS "paidByPayment",
             COALESCE((SELECT SUM(caa."amountMinor") FROM "customer_advance_application" caa WHERE caa."customerReceivableId" = cr."id"), 0)::bigint AS "paidByAdvance"
        FROM "customer_receivable" cr
        LEFT JOIN "invoice" i ON i."id" = cr."invoiceId"
       WHERE cr."tenantId" = ${input.tenantId}::uuid
         AND cr."companyId" = ${input.companyId}::uuid
         AND cr."customerCompanyAccountId" = ${input.customerCompanyAccountId}::uuid
         AND (${input.branchId}::uuid IS NULL OR cr."branchId" = ${input.branchId}::uuid)`;
    let outstandingMinor = 0n;
    let openCount = 0;
    for (const r of rows) {
      const outstanding = r.original - r.paidByPayment - r.paidByAdvance;
      if (outstanding > 0n) {
        outstandingMinor += outstanding;
        openCount += 1;
      }
    }
    return { outstandingMinor, openCount };
  }

  private async sumAdvancesAvailable(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      customerCompanyAccountId: string;
      branchId: string | null;
    },
  ): Promise<{ availableMinor: bigint; openCount: number }> {
    const rows = await tx.$queryRaw<{ id: string; original: bigint; applied: bigint }[]>`
      SELECT ca."id" AS "id", ca."amountMinor" AS "original",
             COALESCE((SELECT SUM(caa."amountMinor") FROM "customer_advance_application" caa WHERE caa."customerAdvanceId" = ca."id"), 0)::bigint AS "applied"
        FROM "customer_advance" ca
       WHERE ca."tenantId" = ${input.tenantId}::uuid
         AND ca."companyId" = ${input.companyId}::uuid
         AND ca."customerCompanyAccountId" = ${input.customerCompanyAccountId}::uuid
         AND (${input.branchId}::uuid IS NULL OR ca."branchId" = ${input.branchId}::uuid)`;
    let availableMinor = 0n;
    let openCount = 0;
    for (const a of rows) {
      const available = a.original - a.applied;
      if (available > 0n) {
        availableMinor += available;
        openCount += 1;
      }
    }
    return { availableMinor, openCount };
  }

  // ═══════════════════════════ G5/G6/G7/G8/G9 — summary ═══════════════════
  async getSummary(tx: ScopedTx, input: ReadScopeInput): Promise<CustomerAccountSummary> {
    const account = await this.resolveAccount(tx, input);

    // A — branch headline: THIS branch's own rows only.
    const branchReceivables = await this.sumReceivablesOutstanding(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: account.customerCompanyAccountId,
      branchId: input.branchId,
    });
    const branchAdvances = await this.sumAdvancesAvailable(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: account.customerCompanyAccountId,
      branchId: input.branchId,
    });
    const branchUnapplied = await this.sumUnappliedReceipts(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: account.customerCompanyAccountId,
      customerId: account.customerId,
      branchId: input.branchId,
    });

    // B — company-wide authoritative totals: EVERY branch this account has
    // activity in, never just this route's own `:branchId`. This is the
    // ONLY scope that can legitimately reconcile against
    // `CustomerCompanyAccount.currentOutstandingMinor`/`advanceBalanceMinor`
    // (themselves company-wide by frozen design) and the ONLY scope the
    // frozen Checkpoint C credit gate itself ever evaluates.
    const companyReceivables = await this.sumReceivablesOutstanding(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: account.customerCompanyAccountId,
      branchId: null,
    });
    const companyAdvances = await this.sumAdvancesAvailable(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: account.customerCompanyAccountId,
      branchId: null,
    });

    const creditExposureMinor = companyReceivables.outstandingMinor;
    const availableCreditMinor = !account.creditEnabled
      ? null
      : account.creditLimitMinor === null
        ? null
        : creditExposureMinor >= account.creditLimitMinor
          ? 0n
          : account.creditLimitMinor - creditExposureMinor;

    return {
      customerCompanyAccountId: account.customerCompanyAccountId,
      currencyCode: account.currencyCode,
      currencyExponent: account.currencyExponent,
      branchFinancials: {
        receivableOutstandingMinor: branchReceivables.outstandingMinor,
        advanceAvailableMinor: branchAdvances.availableMinor,
        unappliedReceiptMinor: branchUnapplied,
        openReceivableCount: branchReceivables.openCount,
        openAdvanceCount: branchAdvances.openCount,
      },
      credit: {
        scope: 'COMPANY',
        creditEnabled: account.creditEnabled,
        creditLimitMinor: account.creditLimitMinor,
        creditExposureMinor,
        availableCreditMinor,
        projectionIntegrity: {
          receivableProjectionMatches:
            companyReceivables.outstandingMinor === account.currentOutstandingMinor,
          advanceProjectionMatches: companyAdvances.availableMinor === account.advanceBalanceMinor,
        },
      },
      asOf: new Date().toISOString(),
    };
  }

  private async sumUnappliedReceipts(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      customerCompanyAccountId: string;
      customerId: string;
      branchId: string | null;
    },
  ): Promise<bigint> {
    const rows = await this.rawUnappliedReceipts(tx, input);
    let total = 0n;
    for (const r of rows) {
      const unapplied = r.amountMinor - r.alloc - r.recvPayApp - r.adv;
      if (unapplied > 0n) total += unapplied;
    }
    return total;
  }

  /** G8 — the SAME join shape as the frozen `PaymentCustomerAttributionRepository`
   *  (customer-linked = CUSTOMER_RECEIPT's own `customerCompanyAccountId`, OR
   *  INVOICE_COLLECTION resolved through `targetInvoiceId -> Invoice ->
   *  Order.customerId`), batched into one set-based query (G28 — no N+1).
   *  A walk-in `Order.customerId IS NULL` never matches a real `customerId`,
   *  so walk-in Payments are excluded by construction, never a special case. */
  private async rawUnappliedReceipts(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      customerCompanyAccountId: string;
      customerId: string;
      branchId: string | null;
    },
  ): Promise<
    {
      id: string;
      method: string;
      receiptPurpose: string;
      amountMinor: bigint;
      alloc: bigint;
      recvPayApp: bigint;
      adv: bigint;
      createdAt: Date;
    }[]
  > {
    return tx.$queryRaw<
      {
        id: string;
        method: string;
        receiptPurpose: string;
        amountMinor: bigint;
        alloc: bigint;
        recvPayApp: bigint;
        adv: bigint;
        createdAt: Date;
      }[]
    >`
      SELECT p."id" AS "id", p."method" AS "method", pa."receiptPurpose" AS "receiptPurpose",
             p."amountMinor" AS "amountMinor", p."createdAt" AS "createdAt",
             COALESCE((SELECT SUM(x."amountMinor") FROM "payment_allocation" x WHERE x."paymentId" = p."id"), 0)::bigint AS "alloc",
             COALESCE((SELECT SUM(x."amountMinor") FROM "customer_receivable_payment_application" x WHERE x."paymentId" = p."id"), 0)::bigint AS "recvPayApp",
             COALESCE((SELECT SUM(x."amountMinor") FROM "customer_advance" x WHERE x."sourcePaymentId" = p."id"), 0)::bigint AS "adv"
        FROM "payment" p
        INNER JOIN "payment_attempt" pa ON pa."id" = p."sourceAttemptId"
        LEFT JOIN "invoice" i ON i."id" = pa."targetInvoiceId"
        LEFT JOIN "order" o ON o."id" = i."orderId"
       WHERE p."tenantId" = ${input.tenantId}::uuid
         AND p."companyId" = ${input.companyId}::uuid
         AND (${input.branchId}::uuid IS NULL OR p."branchId" = ${input.branchId}::uuid)
         AND (
           (pa."receiptPurpose" = 'CUSTOMER_RECEIPT' AND pa."customerCompanyAccountId" = ${input.customerCompanyAccountId}::uuid)
           OR (pa."receiptPurpose" = 'INVOICE_COLLECTION' AND o."customerId" = ${input.customerId}::uuid)
         )
       ORDER BY p."id" ASC`;
  }

  // ═══════════════════════════ G10 — open receivables list ═════════════════
  async listReceivables(
    tx: ScopedTx,
    input: ReadScopeInput & { cursor?: string; limit?: number; asOf?: string },
  ): Promise<{ data: ReceivableRow[]; nextCursor: string | null }> {
    const account = await this.resolveAccount(tx, input);
    const limit = clampLimit(input.limit);
    const cursor = input.cursor ?? null;
    if (cursor !== null) assertUuidLike(cursor, 'cursor');
    // G24 — ageing always has an as-of date: explicit `?asOf=`, or else
    // TODAY'S company-local fiscal date (never the UTC calendar date) via
    // the SAME `derivePostingDate` helper PostingEngine itself uses.
    let asOfDate: string;
    if (input.asOf !== undefined) {
      if (!isFiscalDate(input.asOf)) {
        throw new DomainError('INVALID_DATE', 'asOf must be a valid YYYY-MM-DD date', 400);
      }
      asOfDate = input.asOf;
    } else {
      asOfDate = derivePostingDate(new Date(), this.requireTimezone(account));
    }

    // G's Absolute Final Freeze Gate (§9) — this is an OPEN-receivables
    // endpoint: only rows whose computed outstanding is > 0 may ever be
    // returned. The filter must live INSIDE the SQL (a CTE), never applied
    // to the JS array after fetching — otherwise a `LIMIT n+1` page could
    // silently under-fill (skipping CLOSED rows without extending the scan)
    // and `nextCursor` would be wrong.
    const rows = await tx.$queryRaw<
      {
        id: string;
        sourceType: string;
        invoiceId: string | null;
        invoiceNumber: string | null;
        sourceDate: string;
        original: bigint;
        paidByPayment: bigint;
        paidByAdvance: bigint;
        currencyCode: string;
        currencyExponent: number;
        createdAt: Date;
        openingEffectiveDate: string | null;
        openingNote: string | null;
      }[]
    >`
      WITH candidate AS (
        SELECT cr."id" AS "id", cr."sourceType" AS "sourceType", cr."invoiceId" AS "invoiceId",
               i."invoiceNumber" AS "invoiceNumber",
               to_char(COALESCE(i."invoiceDate", cr."openingEffectiveDate"), 'YYYY-MM-DD') AS "sourceDate",
               CASE WHEN cr."sourceType" = 'INVOICE' THEN i."totalAmountMinor" ELSE cr."openingAmountMinor" END AS "original",
               CASE WHEN cr."sourceType" = 'INVOICE'
                 THEN COALESCE((SELECT SUM(pa."amountMinor") FROM "payment_allocation" pa WHERE pa."invoiceId" = cr."invoiceId"), 0)::bigint
                 ELSE COALESCE((SELECT SUM(crpa."amountMinor") FROM "customer_receivable_payment_application" crpa WHERE crpa."customerReceivableId" = cr."id"), 0)::bigint
               END AS "paidByPayment",
               COALESCE((SELECT SUM(caa."amountMinor") FROM "customer_advance_application" caa WHERE caa."customerReceivableId" = cr."id"), 0)::bigint AS "paidByAdvance",
               COALESCE(i."currencyCode", cr."currencyCode") AS "currencyCode",
               COALESCE(i."currencyExponent", cr."currencyExponent") AS "currencyExponent",
               cr."createdAt" AS "createdAt",
               to_char(cr."openingEffectiveDate", 'YYYY-MM-DD') AS "openingEffectiveDate",
               cr."openingNote" AS "openingNote"
          FROM "customer_receivable" cr
          LEFT JOIN "invoice" i ON i."id" = cr."invoiceId"
         WHERE cr."tenantId" = ${input.tenantId}::uuid
           AND cr."companyId" = ${input.companyId}::uuid
           AND cr."branchId" = ${input.branchId}::uuid
           AND cr."customerCompanyAccountId" = ${account.customerCompanyAccountId}::uuid
      )
      SELECT * FROM candidate
       WHERE ("original" - "paidByPayment" - "paidByAdvance") > 0
         AND (${cursor}::uuid IS NULL OR "id" > ${cursor}::uuid)
       ORDER BY "id" ASC
       LIMIT ${limit + 1}`;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const data: ReceivableRow[] = page.map((r) => {
      const outstanding = r.original - r.paidByPayment - r.paidByAdvance;
      const sourceDateStr = r.sourceDate;
      return {
        customerReceivableId: r.id,
        sourceType: r.sourceType as 'INVOICE' | 'OPENING',
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        sourceDate: sourceDateStr,
        originalAmountMinor: r.original,
        paidByPaymentMinor: r.paidByPayment,
        paidByAdvanceMinor: r.paidByAdvance,
        outstandingMinor: outstanding,
        currencyCode: r.currencyCode,
        currencyExponent: r.currencyExponent,
        createdAt: r.createdAt,
        openingEffectiveDate: r.openingEffectiveDate,
        openingNote: r.openingNote,
        // every returned row is OPEN by construction (the CTE's WHERE
        // clause already excludes outstanding<=0) — ageDays always computes.
        // A future-dated basis (sourceDate > asOfDate) clamps to 0, never a
        // negative "overdue" count (G's Final Hardening §15 — no existing
        // future-age convention exists anywhere else in this codebase, so 0
        // is the least surprising, most conservative choice).
        ageDays: Math.max(daysBetween(sourceDateStr, asOfDate), 0),
      };
    });

    return { data, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  // ═══════════════════════════ G11 — advances list ═════════════════════════
  async listAdvances(
    tx: ScopedTx,
    input: ReadScopeInput & { cursor?: string; limit?: number },
  ): Promise<{ data: AdvanceRow[]; nextCursor: string | null }> {
    const account = await this.resolveAccount(tx, input);
    const limit = clampLimit(input.limit);
    const cursor = input.cursor ?? null;
    if (cursor !== null) assertUuidLike(cursor, 'cursor');

    // G's Absolute Final Freeze Gate (§10) — open advances only: a fully
    // consumed Advance (availableAmountMinor <= 0) is never returned. Same
    // CTE-based filter-before-paginate reasoning as `listReceivables` above.
    const rows = await tx.$queryRaw<
      {
        id: string;
        sourceType: string;
        sourcePaymentId: string | null;
        original: bigint;
        applied: bigint;
        currencyCode: string;
        currencyExponent: number;
        openingEffectiveDate: string | null;
        createdAt: Date;
      }[]
    >`
      WITH candidate AS (
        SELECT ca."id" AS "id", ca."sourceType" AS "sourceType", ca."sourcePaymentId" AS "sourcePaymentId",
               ca."amountMinor" AS "original",
               COALESCE((SELECT SUM(caa."amountMinor") FROM "customer_advance_application" caa WHERE caa."customerAdvanceId" = ca."id"), 0)::bigint AS "applied",
               ca."currencyCode" AS "currencyCode", ca."currencyExponent" AS "currencyExponent",
               to_char(ca."openingEffectiveDate", 'YYYY-MM-DD') AS "openingEffectiveDate",
               ca."createdAt" AS "createdAt"
          FROM "customer_advance" ca
         WHERE ca."tenantId" = ${input.tenantId}::uuid
           AND ca."companyId" = ${input.companyId}::uuid
           AND ca."branchId" = ${input.branchId}::uuid
           AND ca."customerCompanyAccountId" = ${account.customerCompanyAccountId}::uuid
      )
      SELECT * FROM candidate
       WHERE ("original" - "applied") > 0
         AND (${cursor}::uuid IS NULL OR "id" > ${cursor}::uuid)
       ORDER BY "id" ASC
       LIMIT ${limit + 1}`;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const data: AdvanceRow[] = page.map((r) => ({
      customerAdvanceId: r.id,
      sourceType: r.sourceType as 'PAYMENT' | 'OPENING',
      sourcePaymentId: r.sourcePaymentId,
      originalAmountMinor: r.original,
      appliedAmountMinor: r.applied,
      availableAmountMinor: r.original - r.applied,
      currencyCode: r.currencyCode,
      currencyExponent: r.currencyExponent,
      openingEffectiveDate: r.openingEffectiveDate,
      createdAt: r.createdAt,
    }));
    return { data, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  // ═══════════════════════════ G12 — unapplied receipts list ═══════════════
  async listUnappliedReceipts(
    tx: ScopedTx,
    input: ReadScopeInput & { cursor?: string; limit?: number },
  ): Promise<{ data: UnappliedReceiptRow[]; nextCursor: string | null }> {
    const account = await this.resolveAccount(tx, input);
    const limit = clampLimit(input.limit);
    const cursor = input.cursor ?? null;
    if (cursor !== null) assertUuidLike(cursor, 'cursor');

    const rows = await this.rawUnappliedReceipts(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      customerCompanyAccountId: account.customerCompanyAccountId,
      customerId: account.customerId,
      branchId: input.branchId,
    });
    const filtered = (cursor === null ? rows : rows.filter((r) => r.id > cursor)).filter((r) => {
      const unapplied = r.amountMinor - r.alloc - r.recvPayApp - r.adv;
      return unapplied > 0n;
    });
    const hasMore = filtered.length > limit;
    const page = filtered.slice(0, limit);
    const data: UnappliedReceiptRow[] = page.map((r) => {
      const consumed = r.alloc + r.recvPayApp + r.adv;
      return {
        paymentId: r.id,
        method: r.method,
        receiptPurpose: r.receiptPurpose as 'INVOICE_COLLECTION' | 'CUSTOMER_RECEIPT',
        originalAmountMinor: r.amountMinor,
        consumedAmountMinor: consumed,
        unappliedAmountMinor: r.amountMinor - consumed,
        currencyCode: account.currencyCode,
        currencyExponent: account.currencyExponent,
        createdAt: r.createdAt,
      };
    });
    return { data, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  // ═══════════════════════════ G13-G21 — statement ═════════════════════════
  async getStatement(
    tx: ScopedTx,
    input: ReadScopeInput & { from?: string; to?: string; cursor?: string; limit?: number },
  ): Promise<{
    data: StatementLine[];
    nextCursor: string | null;
    openingState: StatementOpeningState | null;
  }> {
    const account = await this.resolveAccount(tx, input);
    const tz = this.requireTimezone(account);
    const limit = clampLimit(input.limit);

    let from: string | null = null;
    let to: string | null = null;
    if (input.from !== undefined) {
      if (!isFiscalDate(input.from)) {
        throw new DomainError('INVALID_DATE', 'from must be a valid YYYY-MM-DD date', 400);
      }
      from = input.from;
    }
    if (input.to !== undefined) {
      if (!isFiscalDate(input.to)) {
        throw new DomainError('INVALID_DATE', 'to must be a valid YYYY-MM-DD date', 400);
      }
      to = input.to;
    }
    if (from !== null && to !== null && from > to) {
      throw new DomainError('INVALID_DATE_RANGE', 'from must not be after to', 400);
    }

    const cursor = decodeStatementCursor(input.cursor);

    // financialDate + occurredAt(tie-break timestamp) resolved per-row via a
    // CASE keyed on entryKind (G17) — exactly one LEFT JOIN branch matches
    // per row, mirroring the frozen "exactly one reference column populated"
    // invariant this table already enforces structurally.
    const rows = await tx.$queryRaw<
      {
        id: string;
        entryKind: string;
        financialDate: string;
        tieTs: Date;
        receivableEffect: bigint;
        advanceEffect: bigint;
        unappliedEffect: bigint;
        refReceivableId: string | null;
        refPaymentId: string | null;
        refAllocationId: string | null;
        refAdvanceId: string | null;
        refAdvanceAppId: string | null;
        refRecvPayAppId: string | null;
      }[]
    >`
      SELECT
        e."id" AS "id",
        e."entryKind" AS "entryKind",
        to_char(
          CASE e."entryKind"
            WHEN 'INVOICE' THEN i."invoiceDate"
            WHEN 'OPENING_RECEIVABLE' THEN cr."openingEffectiveDate"
            WHEN 'OPENING_ADVANCE' THEN ca."openingEffectiveDate"
            WHEN 'PAYMENT' THEN (pay."createdAt" AT TIME ZONE ${tz})::date
            -- G's Absolute Final Freeze Gate (section 6) - an APPLICATION
            -- event's financial date is its OWN createdAt, never the
            -- originating Payment's receipt date. A same-Payment
            -- application made weeks later must land on its own day.
            WHEN 'PAYMENT_ALLOCATION' THEN (alloc."createdAt" AT TIME ZONE ${tz})::date
            WHEN 'OPENING_RECEIVABLE_PAYMENT_APPLIED' THEN (rpa."createdAt" AT TIME ZONE ${tz})::date
            WHEN 'ADVANCE' THEN (ca."createdAt" AT TIME ZONE ${tz})::date
            WHEN 'ADVANCE_APPLIED' THEN (aa."createdAt" AT TIME ZONE ${tz})::date
          END, 'YYYY-MM-DD'
        ) AS "financialDate",
        COALESCE(pay."createdAt", alloc."createdAt", rpa."createdAt", ca."createdAt", aa."createdAt", i."createdAt", e."occurredAt") AS "tieTs",
        CASE e."entryKind"
          WHEN 'INVOICE' THEN i."totalAmountMinor"
          WHEN 'OPENING_RECEIVABLE' THEN cr."openingAmountMinor"
          WHEN 'PAYMENT_ALLOCATION' THEN -alloc."amountMinor"
          WHEN 'OPENING_RECEIVABLE_PAYMENT_APPLIED' THEN -rpa."amountMinor"
          WHEN 'ADVANCE_APPLIED' THEN -aa."amountMinor"
          ELSE 0
        END AS "receivableEffect",
        CASE e."entryKind"
          WHEN 'ADVANCE' THEN ca."amountMinor"
          WHEN 'OPENING_ADVANCE' THEN ca."amountMinor"
          WHEN 'ADVANCE_APPLIED' THEN -aa."amountMinor"
          ELSE 0
        END AS "advanceEffect",
        CASE e."entryKind"
          WHEN 'PAYMENT' THEN pay."amountMinor"
          WHEN 'PAYMENT_ALLOCATION' THEN -alloc."amountMinor"
          WHEN 'OPENING_RECEIVABLE_PAYMENT_APPLIED' THEN -rpa."amountMinor"
          ELSE 0
        END AS "unappliedEffect",
        e."customerReceivableId" AS "refReceivableId",
        e."paymentId" AS "refPaymentId",
        e."paymentAllocationId" AS "refAllocationId",
        e."customerAdvanceId" AS "refAdvanceId",
        e."customerAdvanceApplicationId" AS "refAdvanceAppId",
        e."customerReceivablePaymentApplicationId" AS "refRecvPayAppId"
      FROM "customer_account_entry" e
      LEFT JOIN "customer_receivable" cr ON cr."id" = e."customerReceivableId"
      LEFT JOIN "invoice" i ON i."id" = cr."invoiceId"
      LEFT JOIN "payment" pay ON pay."id" = e."paymentId"
      LEFT JOIN "payment_allocation" alloc ON alloc."id" = e."paymentAllocationId"
      LEFT JOIN "customer_receivable_payment_application" rpa ON rpa."id" = e."customerReceivablePaymentApplicationId"
      LEFT JOIN "customer_advance" ca ON ca."id" = e."customerAdvanceId"
      LEFT JOIN "customer_advance_application" aa ON aa."id" = e."customerAdvanceApplicationId"
      WHERE e."tenantId" = ${input.tenantId}::uuid
        AND e."companyId" = ${input.companyId}::uuid
        AND e."branchId" = ${input.branchId}::uuid
        AND e."customerCompanyAccountId" = ${account.customerCompanyAccountId}::uuid
      ORDER BY "financialDate" ASC, "tieTs" ASC, e."id" ASC`;

    for (const r of rows) {
      if (!KNOWN_ENTRY_KINDS.has(r.entryKind)) {
        throw new DomainError(
          'STATEMENT_UNKNOWN_ENTRY_KIND',
          `unrecognized CustomerAccountEntry.entryKind "${r.entryKind}"`,
          500,
        );
      }
    }

    // in-range + after-cursor filtering happens in JS (the composite
    // (financialDate, tieTs, id) key is awkward to express as a single SQL
    // predicate against a computed `to_char` column without repeating the
    // whole CASE expression) — the candidate set per customer+branch is
    // small and bounded (one company's one branch's one customer), never a
    // whole-table scan (G28).
    const inRange = rows.filter(
      (r) => (from === null || r.financialDate >= from) && (to === null || r.financialDate <= to),
    );
    const afterCursor =
      cursor === null ? inRange : inRange.filter((r) => compareStatementKey(r, cursor) > 0);
    const hasMore = afterCursor.length > limit;
    const page = afterCursor.slice(0, limit);

    const data: StatementLine[] = page.map((r) => ({
      customerAccountEntryId: r.id,
      entryKind: r.entryKind,
      financialDate: r.financialDate,
      occurredAt: r.tieTs,
      receivableEffectMinor: r.receivableEffect,
      advanceEffectMinor: r.advanceEffect,
      unappliedReceiptEffectMinor: r.unappliedEffect,
      refs: {
        customerReceivableId: r.refReceivableId,
        paymentId: r.refPaymentId,
        paymentAllocationId: r.refAllocationId,
        customerAdvanceId: r.refAdvanceId,
        customerAdvanceApplicationId: r.refAdvanceAppId,
        customerReceivablePaymentApplicationId: r.refRecvPayAppId,
      },
    }));
    const nextCursor = hasMore
      ? encodeStatementCursor(page.at(-1)!.financialDate, page.at(-1)!.tieTs, page.at(-1)!.id)
      : null;

    // G20 — opening state strictly BEFORE `from`, computed once from the
    // SAME rows already fetched (never a second heavy query, never a
    // synthetic persisted entry).
    let openingState: StatementOpeningState | null = null;
    if (from !== null) {
      const before = rows.filter((r) => r.financialDate < from!);
      let receivableOutstandingMinor = 0n;
      let advanceEffectSum = 0n;
      let unappliedEffectSum = 0n;
      for (const r of before) {
        receivableOutstandingMinor += r.receivableEffect;
        advanceEffectSum += r.advanceEffect;
        unappliedEffectSum += r.unappliedEffect;
      }
      openingState = {
        asOfDate: from,
        receivableOutstandingMinor,
        advanceAvailableMinor: advanceEffectSum,
        unappliedReceiptMinor: unappliedEffectSum,
      };
    }

    return { data, nextCursor, openingState };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new DomainError('INVALID_LIMIT', 'limit must be a positive integer', 400);
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

function assertUuidLike(value: string, field: string): void {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(value)) {
    throw new DomainError('INVALID_CURSOR', `${field} is not a valid cursor`, 400);
  }
}

/** Whole-day difference, pure `YYYY-MM-DD` string arithmetic — no JS `Date`
 *  timezone conversion (mirrors task 3.9's civil-date discipline). */
function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.UTC(
    Number(fromDate.slice(0, 4)),
    Number(fromDate.slice(5, 7)) - 1,
    Number(fromDate.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(toDate.slice(0, 4)),
    Number(toDate.slice(5, 7)) - 1,
    Number(toDate.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

interface StatementCursorKey {
  financialDate: string;
  tieTs: string;
  id: string;
}

function encodeStatementCursor(financialDate: string, tieTs: Date, id: string): string {
  const raw = `${financialDate}|${tieTs.toISOString()}|${id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeStatementCursor(cursor: string | undefined): StatementCursorKey | null {
  if (cursor === undefined) return null;
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DomainError('INVALID_CURSOR', 'cursor is malformed', 400);
  }
  const parts = raw.split('|');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new DomainError('INVALID_CURSOR', 'cursor is malformed', 400);
  }
  const [financialDate, tieTs, id] = parts as [string, string, string];
  if (!isFiscalDate(financialDate) || Number.isNaN(Date.parse(tieTs))) {
    throw new DomainError('INVALID_CURSOR', 'cursor is malformed', 400);
  }
  return { financialDate, tieTs, id };
}

function compareStatementKey(
  row: { financialDate: string; tieTs: Date; id: string },
  cursor: StatementCursorKey,
): number {
  if (row.financialDate !== cursor.financialDate) {
    return row.financialDate > cursor.financialDate ? 1 : -1;
  }
  const rowTie = row.tieTs.toISOString();
  if (rowTie !== cursor.tieTs) {
    return rowTie > cursor.tieTs ? 1 : -1;
  }
  if (row.id === cursor.id) return 0;
  return row.id > cursor.id ? 1 : -1;
}
