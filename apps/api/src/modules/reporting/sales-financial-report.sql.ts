import { WALK_IN_SALE_SOURCE_KIND } from '../sales/walk-in-sale-journal.js';
import type { InvoiceLineSetFacts } from './sales-invoice-line-set-proof.js';
import { SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';

/**
 * Task 3b.10 Checkpoint B — THE Sales Financial Report statement: ONE read statement for the whole
 * report AND its byBranch breakdown (a single consistent snapshot — `runScoped` offers no
 * isolation-level control, so a multi-statement report could straddle a concurrent posting).
 *
 *   $1 tenantId   $2 companyId   $3 from (civil date)   $4 to (civil date)
 *   $5 branchId   — NULL for the company report, the branch for the branch report
 *
 * ── The frozen financial-document source kinds (discovered in the code, never assumed) ─────────
 *   'invoice_ar'            customer-linked invoice  — `customer-invoice-ar.repository.ts`
 *                           Dr AR / Cr REVENUE.SALES (total − tax) / Cr LIABILITY.TAX_PAYABLE;
 *                           sourceId = the invoice id; posted WITHOUT an explicit accounting date
 *   'walk_in_sale'          anonymous walk-in sale   — `walk-in-sale-journal.ts`
 *                           Dr tender / Cr REVENUE.SALES (total − tax) / Cr LIABILITY.TAX_PAYABLE;
 *                           sourceId = the invoice id; accountingDate = invoice.invoiceDate
 *   'credit_note'           CreditNote               — `credit-note.repository.ts`
 *                           Dr REVENUE.SALES (total − tax) / Dr LIABILITY.TAX_PAYABLE / Cr AR (+ Advance);
 *                           sourceId = the credit note id; accountingDate = credit_note.accountingDate
 *   'cancellation_charge'   CancellationCharge       — `cancellation-charge.repository.ts`
 *                           Dr AR / Cr REVENUE.CANCELLATION_CHARGE (net) / Cr LIABILITY.TAX_PAYABLE;
 *                           sourceId = the charge id; accountingDate = charge.accountingDate
 *   `walk_in_sale` is the ONE kind whose producer EXPORTS its literal (`WALK_IN_SALE_SOURCE_KIND`); the report
 *   imports it instead of repeating it, so the report can never drift from the posting side. The other three
 *   kinds are literals in their producers and are pinned against them by the Checkpoint B structural pins.
 *   An invoice has exactly ONE revenue journal: customer-linked → 'invoice_ar', anonymous →
 *   'walk_in_sale' (the other kind existing for the same invoice is a malformed state and fails closed).
 *
 * ── Period authority (owner ruling OD-2) ──────────────────────────────────────────────────────
 *   A document is in the period iff its SEALED journal's `journal_entry.postingDate` is — and ONLY
 *   that. `invoiceDate`, `issuedAt`, `accountingDate`, `createdAt` never decide inclusion.
 *
 * ── Shape ─────────────────────────────────────────────────────────────────────────────────────
 *   sel   the sealed journals in the period of the four kinds above — the ONLY entry point, anchored on
 *         the indexed `journal_entry(tenantId, companyId, postingDate)`; unknown kinds are not sales
 *   cand  THE DENSITY GUARD (v1: at most SALES_REPORT_MAX_DOCUMENTS = 25 000 financial documents — invoices,
 *         credit notes, cancellation charges — per invocation): each journal joined to its source document by
 *         sourceId (primary key) and, for a branch report, kept only if the document is of the requested
 *         branch; `LIMIT max + 1` stops the scan at 25 001 candidates. A company report counts the whole
 *         company, a branch report only its branch. An unresolved sourceId is kept as an ORPHAN so it can
 *         fail the (company) report closed.
 *   gate  how many candidates there were (≤ 25 001). Every HEAVY stage below reads `docs`, the candidates
 *         behind `WHERE gate.n <= max` — one InitPlan comparison the planner turns into a One-Time Filter — so
 *         above the limit the order_line evidence, the fingerprint payload, the source aggregates and the
 *         reconciliation inputs are NEVER executed (EXPLAIN ANALYZE shows them never executed) and the
 *         repository rejects with REPORT_RESULT_TOO_LARGE from the one `candidateDocuments` figure.
 *   fdocs the found documents
 *   ld    the invoice line discounts — `order_line.discountAmountMinor` summed per invoice. The issued
 *         lines are immutable (`trg_enforce_order_line_freeze`, migration 20260920120000) and the
 *         amount is the stored OUTPUT of the frozen pricing, never recomputed from a rate or the catalog
 *   br    aggregates per branch · st  the CURRENT invoice payment-status breakdown (the stored
 *         projection, not derived from payments) · gl  the GL lines of exactly these journals per
 *         branch / kind / account · ic  the integrity counters
 *
 *   Explicit tenant + company predicates on every table touched — the report never relies on RLS or the
 *   branch GUC. Money is exact: every sum leaves the database as TEXT. Counts are JSON integers.
 */
export const SALES_SOURCE_KINDS = {
  invoiceCustomer: 'invoice_ar',
  invoiceAnonymous: WALK_IN_SALE_SOURCE_KIND,
  creditNote: 'credit_note',
  cancellationCharge: 'cancellation_charge',
} as const;

const INVOICE_KINDS = `'${SALES_SOURCE_KINDS.invoiceCustomer}', '${SALES_SOURCE_KINDS.invoiceAnonymous}'`;

export const SALES_ACCOUNT_KEYS = {
  salesRevenue: 'REVENUE.SALES',
  outputTax: 'LIABILITY.TAX_PAYABLE',
  cancellationChargeRevenue: 'REVENUE.CANCELLATION_CHARGE',
} as const;

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

function salesFinancialReportSql(maxDocuments: number): string {
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1) {
    throw new RangeError('the Sales report document limit must be a positive integer');
  }
  // the ONE gate comparison: `cand` counted at most limit + 1 documents; above the limit every stage that carries
  // this predicate is skipped as a whole (a One-Time Filter above its joins)
  const gateOpen = `(SELECT g."n" FROM gate g) <= ${maxDocuments}`;
  return `
WITH co AS (
  SELECT c."defaultCurrency" AS "defaultCurrency", c."accountingTimezone" AS "accountingTimezone"
    FROM "company" c
   WHERE c."tenantId" = $1::uuid
     AND c."id" = $2::uuid
),
scope_branch AS (
  SELECT b."id" AS "id"
    FROM "branch" b
   WHERE $5::uuid IS NOT NULL
     AND b."tenantId" = $1::uuid
     AND b."companyId" = $2::uuid
     AND b."id" = $5::uuid
),
sel AS (
  SELECT je."id" AS "entryId",
         je."sourceKind" AS "sourceKind",
         je."sourceId" AS "sourceId",
         je."currencyCode" AS "journalCurrency",
         CASE WHEN je."sourceId" ~ '${UUID_RE}' THEN je."sourceId"::uuid END AS "docId"
    FROM "journal_entry" je
   WHERE je."tenantId" = $1::uuid
     AND je."companyId" = $2::uuid
     AND je."sealedAt" IS NOT NULL
     AND je."postingDate" >= $3::date
     AND je."postingDate" <= $4::date
     AND je."sourceKind" IN ('${SALES_SOURCE_KINDS.invoiceCustomer}', '${SALES_SOURCE_KINDS.invoiceAnonymous}', '${SALES_SOURCE_KINDS.creditNote}', '${SALES_SOURCE_KINDS.cancellationCharge}')
),
cand AS (
  SELECT s."entryId" AS "entryId", s."sourceKind" AS "sourceKind", s."sourceId" AS "sourceId",
         s."journalCurrency" AS "journalCurrency", s."docId" AS "docId",
         (i."id" IS NOT NULL OR n."id" IS NOT NULL OR x."id" IS NOT NULL) AS "found",
         COALESCE(i."branchId", n."branchId", x."branchId") AS "branchId",
         COALESCE(i."currencyCode", n."currencyCode", x."currencyCode") AS "docCurrency",
         i."subtotalAmountMinor" AS "subtotal",
         i."documentDiscountAmountMinor" AS "docDiscount",
         COALESCE(i."taxTotalAmountMinor", n."taxTotalAmountMinor", x."taxAmountMinor") AS "tax",
         COALESCE(i."totalAmountMinor", n."totalAmountMinor", x."totalAmountMinor") AS "total",
         COALESCE(i."totalAmountMinor" - i."taxTotalAmountMinor", n."totalAmountMinor" - n."taxTotalAmountMinor", x."netAmountMinor") AS "net",
         i."invoicePaymentStatus" AS "status",
         i."orderId" AS "orderId",
         n."invoiceId" AS "invoiceId"
    FROM sel s
    LEFT JOIN "invoice" i
      ON i."id" = s."docId" AND i."tenantId" = $1::uuid AND i."companyId" = $2::uuid
     AND s."sourceKind" IN (${INVOICE_KINDS})
    LEFT JOIN "credit_note" n
      ON n."id" = s."docId" AND n."tenantId" = $1::uuid AND n."companyId" = $2::uuid
     AND s."sourceKind" = '${SALES_SOURCE_KINDS.creditNote}'
    LEFT JOIN "cancellation_charge" x
      ON x."id" = s."docId" AND x."tenantId" = $1::uuid AND x."companyId" = $2::uuid
     AND s."sourceKind" = '${SALES_SOURCE_KINDS.cancellationCharge}'
   WHERE ($5::uuid IS NULL OR COALESCE(i."branchId", n."branchId", x."branchId") = $5::uuid)
   LIMIT ${maxDocuments + 1}
),
gate AS (
  SELECT COUNT(*) AS "n" FROM cand
),
docs AS (
  SELECT c.*
    FROM cand c
   WHERE ${gateOpen}
),
fdocs AS (
  SELECT d.*
    FROM docs d
   WHERE d."found"
),
ils AS (
  SELECT d."docId" AS "invoiceId", d."branchId" AS "branchId", d."entryId" AS "entryId",
         (o."id" IS NOT NULL) AS "orderFound",
         o."tenantId" AS "oTenantId", o."companyId" AS "oCompanyId",
         o."originBranchId" AS "oOriginBranchId", o."fulfillingBranchId" AS "oFulfillingBranchId",
         o."customerId" AS "oCustomerId", o."kind" AS "oKind", o."currencyCode" AS "oCurrencyCode",
         o."documentDiscountMode" AS "oDocDiscountMode", o."documentDiscountBps" AS "oDocDiscountBps",
         o."documentDiscountAmountMinor" AS "oDocDiscountAmount",
         o."documentDiscountReason" AS "oDocDiscountReason",
         o."taxPriceMode" AS "oTaxPriceMode", o."taxRoundingScope" AS "oTaxRoundingScope",
         o."taxRoundingMode" AS "oTaxRoundingMode",
         o."commercialSnapshotFingerprint" AS "oFingerprint",
         o."commercialSnapshotFingerprintVersion" AS "oFingerprintVersion",
         l."lineDiscount" AS "lineDiscount", l."lines" AS "lines"
    FROM fdocs d
    LEFT JOIN "order" o
      ON o."id" = d."orderId" AND o."tenantId" = $1::uuid AND o."companyId" = $2::uuid
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(ol."discountAmountMinor"), 0) AS "lineDiscount",
             json_agg(json_build_array(
               ol."linePosition", ol."productId", ol."variantId", ol."quantity"::text,
               ol."selectedUomCode", ol."baseUomCode", ol."conversionNumerator"::text,
               ol."conversionDenominator"::text, ol."unitPriceAmountMinor"::text,
               ol."unitPriceCurrencyCode", ol."unitPriceCurrencyExponent", ol."discountMode",
               ol."discountBps", ol."discountAmountMinor"::text, ol."taxCategoryKey", ol."rateBps",
               to_char(ol."effectiveFrom", 'YYYY-MM-DD'), ol."resolutionSource"
             ) ORDER BY ol."linePosition") AS "lines"
        FROM "order_line" ol
       WHERE ol."orderId" = d."orderId" AND ol."tenantId" = $1::uuid AND ol."companyId" = $2::uuid
    ) l ON true
   WHERE d."sourceKind" IN (${INVOICE_KINDS})
     AND ${gateOpen}
),
ldb AS (
  SELECT x."branchId" AS "branchId", COALESCE(SUM(x."lineDiscount"), 0) AS "lineDiscount"
    FROM ils x
   GROUP BY x."branchId"
),
br AS (
  SELECT d."branchId" AS "branchId",
         COUNT(*) FILTER (WHERE d."sourceKind" IN (${INVOICE_KINDS})) AS "invoiceCount",
         COALESCE(SUM(d."subtotal") FILTER (WHERE d."sourceKind" IN (${INVOICE_KINDS})), 0) AS "invoicedSubtotal",
         COALESCE((SELECT x."lineDiscount" FROM ldb x WHERE x."branchId" = d."branchId"), 0) AS "lineDiscount",
         COALESCE(SUM(d."docDiscount") FILTER (WHERE d."sourceKind" IN (${INVOICE_KINDS})), 0) AS "documentDiscount",
         COALESCE(SUM(d."tax") FILTER (WHERE d."sourceKind" IN (${INVOICE_KINDS})), 0) AS "outputTax",
         COALESCE(SUM(d."total") FILTER (WHERE d."sourceKind" IN (${INVOICE_KINDS})), 0) AS "invoicedTotal",
         COUNT(*) FILTER (WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.creditNote}') AS "creditNoteCount",
         COALESCE(SUM(d."total") FILTER (WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.creditNote}'), 0) AS "creditNoteTotal",
         COALESCE(SUM(d."tax") FILTER (WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.creditNote}'), 0) AS "creditNoteTax",
         COUNT(*) FILTER (WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.cancellationCharge}') AS "cancellationChargeCount",
         COALESCE(SUM(d."net") FILTER (WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.cancellationCharge}'), 0) AS "cancellationChargeNet",
         COALESCE(SUM(d."tax") FILTER (WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.cancellationCharge}'), 0) AS "cancellationChargeTax",
         COALESCE(SUM(d."total") FILTER (WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.cancellationCharge}'), 0) AS "cancellationChargeTotal"
    FROM fdocs d
   GROUP BY d."branchId"
),
st AS (
  SELECT d."branchId" AS "branchId", d."status" AS "status",
         COUNT(*) AS "n", COALESCE(SUM(d."total"), 0) AS "total"
    FROM fdocs d
   WHERE d."sourceKind" IN (${INVOICE_KINDS})
   GROUP BY d."branchId", d."status"
),
gl AS (
  SELECT d."branchId" AS "branchId", d."sourceKind" AS "sourceKind", a."key" AS "accountKey",
         COALESCE(SUM(jl."debitMinor"), 0) AS "debit", COALESCE(SUM(jl."creditMinor"), 0) AS "credit"
    FROM fdocs d
    JOIN "journal_line" jl
      ON jl."journalEntryId" = d."entryId" AND jl."tenantId" = $1::uuid AND jl."companyId" = $2::uuid
    JOIN "account" a
      ON a."id" = jl."accountId" AND a."tenantId" = $1::uuid AND a."companyId" = $2::uuid
   WHERE ${gateOpen}
   GROUP BY d."branchId", d."sourceKind", a."key"
),
ic AS (
  SELECT
    (SELECT COUNT(*) FROM docs d WHERE NOT d."found") AS "orphanJournals",
    (SELECT COUNT(*) FROM fdocs d
       JOIN "journal_line" jl
         ON jl."journalEntryId" = d."entryId" AND jl."tenantId" = $1::uuid AND jl."companyId" = $2::uuid
      WHERE jl."branchId" IS DISTINCT FROM d."branchId" AND ${gateOpen}) AS "branchMismatchLines",
    (SELECT COUNT(*) FROM fdocs d, co
      WHERE d."journalCurrency" IS DISTINCT FROM co."defaultCurrency"
         OR d."docCurrency" IS DISTINCT FROM co."defaultCurrency") AS "currencyMismatchDocuments",
    (SELECT COUNT(*) FROM fdocs d
       LEFT JOIN LATERAL (
         SELECT 1 AS "hit" FROM "journal_entry" j2
          WHERE j2."tenantId" = $1::uuid AND j2."companyId" = $2::uuid
            AND j2."sealedAt" IS NOT NULL
            AND j2."sourceKind" = CASE d."sourceKind" WHEN '${SALES_SOURCE_KINDS.invoiceCustomer}' THEN '${SALES_SOURCE_KINDS.invoiceAnonymous}' ELSE '${SALES_SOURCE_KINDS.invoiceCustomer}' END
            AND j2."sourceId" = d."sourceId"
          LIMIT 1) dj ON true
      WHERE d."sourceKind" IN (${INVOICE_KINDS}) AND dj."hit" IS NOT NULL) AS "duplicateRevenueJournals",
    (SELECT COUNT(*) FROM fdocs d
      WHERE d."sourceKind" IN (${INVOICE_KINDS})
        AND ((d."sourceKind" = '${SALES_SOURCE_KINDS.invoiceCustomer}') <> EXISTS (
          SELECT 1 FROM "customer_receivable" cr
           WHERE cr."invoiceId" = d."docId" AND cr."tenantId" = $1::uuid AND cr."companyId" = $2::uuid))) AS "revenueKindMismatches",
    (SELECT COUNT(*) FROM fdocs d
       LEFT JOIN LATERAL (
         SELECT 1 AS "hit" FROM "journal_entry" j3
          WHERE j3."tenantId" = $1::uuid AND j3."companyId" = $2::uuid
            AND j3."sealedAt" IS NOT NULL
            AND j3."sourceKind" IN (${INVOICE_KINDS})
            AND j3."sourceId" = d."invoiceId"::text
          LIMIT 1) rj ON true
      WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.creditNote}' AND rj."hit" IS NULL) AS "creditNotesWithoutRevenueJournal"
)
SELECT json_build_object(
  'company', (SELECT json_build_object('defaultCurrency', co."defaultCurrency", 'accountingTimezone', co."accountingTimezone") FROM co),
  'branchFound', (SELECT COUNT(*) FROM scope_branch),
  'candidateDocuments', (SELECT g."n" FROM gate g),
  'branches', COALESCE((SELECT json_agg(json_build_object(
      'branchId', br."branchId",
      'invoiceCount', br."invoiceCount",
      'invoicedSubtotalMinor', br."invoicedSubtotal"::text,
      'lineDiscountMinor', br."lineDiscount"::text,
      'documentDiscountMinor', br."documentDiscount"::text,
      'outputTaxMinor', br."outputTax"::text,
      'invoicedTotalMinor', br."invoicedTotal"::text,
      'creditNoteCount', br."creditNoteCount",
      'creditNoteTotalMinor', br."creditNoteTotal"::text,
      'creditNoteTaxMinor', br."creditNoteTax"::text,
      'cancellationChargeCount', br."cancellationChargeCount",
      'cancellationChargeNetMinor', br."cancellationChargeNet"::text,
      'cancellationChargeTaxMinor', br."cancellationChargeTax"::text,
      'cancellationChargeTotalMinor', br."cancellationChargeTotal"::text
    ) ORDER BY br."branchId") FROM br), '[]'::json),
  'statuses', COALESCE((SELECT json_agg(json_build_object(
      'branchId', st."branchId", 'status', st."status", 'count', st."n", 'invoiceTotalMinor', st."total"::text
    ) ORDER BY st."branchId", st."status") FROM st), '[]'::json),
  'gl', COALESCE((SELECT json_agg(json_build_object(
      'branchId', gl."branchId", 'sourceKind', gl."sourceKind", 'accountKey', gl."accountKey",
      'debitMinor', gl."debit"::text, 'creditMinor', gl."credit"::text
    ) ORDER BY gl."branchId", gl."sourceKind", gl."accountKey") FROM gl), '[]'::json),
  'invoiceLineSets', COALESCE((SELECT json_agg(json_build_object(
      'invoiceId', ils."invoiceId",
      'branchId', ils."branchId",
      'order', CASE WHEN ils."orderFound" THEN json_build_object(
        'tenantId', ils."oTenantId", 'companyId', ils."oCompanyId",
        'originBranchId', ils."oOriginBranchId", 'fulfillingBranchId', ils."oFulfillingBranchId",
        'customerId', ils."oCustomerId", 'kind', ils."oKind", 'currencyCode', ils."oCurrencyCode",
        'documentDiscountMode', ils."oDocDiscountMode", 'documentDiscountBps', ils."oDocDiscountBps",
        'documentDiscountAmountMinor', ils."oDocDiscountAmount"::text,
        'documentDiscountReason', ils."oDocDiscountReason",
        'taxPriceMode', ils."oTaxPriceMode", 'taxRoundingScope', ils."oTaxRoundingScope",
        'taxRoundingMode', ils."oTaxRoundingMode",
        'commercialSnapshotFingerprint', ils."oFingerprint",
        'commercialSnapshotFingerprintVersion', ils."oFingerprintVersion"
      ) END,
      'lines', COALESCE(ils."lines", '[]'::json)
    ) ORDER BY ils."invoiceId") FROM ils), '[]'::json),
  'integrity', (SELECT json_build_object(
      'orphanJournals', ic."orphanJournals",
      'branchMismatchLines', ic."branchMismatchLines",
      'currencyMismatchDocuments', ic."currencyMismatchDocuments",
      'duplicateRevenueJournals', ic."duplicateRevenueJournals",
      'revenueKindMismatches', ic."revenueKindMismatches",
      'creditNotesWithoutRevenueJournal', ic."creditNotesWithoutRevenueJournal"
    ) FROM ic)
)::text AS "report"
`;
}

/** the statement at the v1 document limit (the exact text the repository runs) */
export const SALES_FINANCIAL_REPORT_SQL = salesFinancialReportSql(SALES_REPORT_MAX_DOCUMENTS);

export interface SalesFinancialReportQuery {
  readonly text: string;
  /** `[tenantId, companyId, from, to, branchId | null]` — positional parameters `$1..$5`. */
  readonly values: readonly [string, string, string, string, string | null];
}

export function buildSalesFinancialReportQuery(args: {
  readonly tenantId: string;
  readonly companyId: string;
  readonly from: string;
  readonly to: string;
  readonly branchId: string | null;
  /** the density limit (defaults to the v1 constant; only tests pass another value) */
  readonly maxDocuments?: number;
}): SalesFinancialReportQuery {
  return {
    text:
      args.maxDocuments === undefined
        ? SALES_FINANCIAL_REPORT_SQL
        : salesFinancialReportSql(args.maxDocuments),
    values: [args.tenantId, args.companyId, args.from, args.to, args.branchId],
  };
}

/** The JSON document the statement returns (money as TEXT, counts as JSON integers). */
export interface SalesFinancialReportJson {
  readonly company: { defaultCurrency: string | null; accountingTimezone: string | null } | null;
  readonly branchFound: number;
  /** financial documents (invoices, credit notes, cancellation charges) in scope, counted up to limit + 1 */
  readonly candidateDocuments: number;
  readonly branches: readonly {
    branchId: string;
    invoiceCount: number;
    invoicedSubtotalMinor: string;
    lineDiscountMinor: string;
    documentDiscountMinor: string;
    outputTaxMinor: string;
    invoicedTotalMinor: string;
    creditNoteCount: number;
    creditNoteTotalMinor: string;
    creditNoteTaxMinor: string;
    cancellationChargeCount: number;
    cancellationChargeNetMinor: string;
    cancellationChargeTaxMinor: string;
    cancellationChargeTotalMinor: string;
  }[];
  readonly statuses: readonly {
    branchId: string;
    status: string;
    count: number;
    invoiceTotalMinor: string;
  }[];
  readonly gl: readonly {
    branchId: string;
    sourceKind: string;
    accountKey: string;
    debitMinor: string;
    creditMinor: string;
  }[];
  /** one entry per invoice of the period: its order's fingerprint facts and its CURRENT ordered lines */
  readonly invoiceLineSets: readonly InvoiceLineSetFacts[];
  readonly integrity: {
    orphanJournals: number;
    branchMismatchLines: number;
    currencyMismatchDocuments: number;
    duplicateRevenueJournals: number;
    revenueKindMismatches: number;
    creditNotesWithoutRevenueJournal: number;
  };
}
