import { WALK_IN_SALE_SOURCE_KIND } from '../sales/walk-in-sale-journal.js';
import { TENDER_METHODS } from '../payments/tender.js';
import { resolveReceiptAccountKeyForTender } from '../payments/tender-account-mapping.js';

/**
 * Task 3b.10 Checkpoint C — THE Tender Totals statement: ONE read statement for the whole report AND its
 * byBranch breakdown (a single consistent snapshot — `runScoped` offers no isolation-level control, so a
 * multi-statement report could straddle a concurrent posting).
 *
 *   $1 tenantId   $2 companyId   $3 from (civil date)   $4 to (civil date)
 *   $5 branchId   — NULL for the company report, the branch for the branch report
 *
 * ── The frozen movement contracts (discovered in the code, never assumed) ─────────────────────────
 *
 *   RECEIPT — a `Payment` row (immutable; it exists only once recorded). Two booking paths, both exact:
 *
 *   'customer_receipt_payment'  a customer-attributable Payment (an invoice collection of a customer-linked
 *                               invoice, a standalone customer receipt, a provider-captured customer payment)
 *                               — `customer-receipt-effects.repository.ts` `recordPaymentReceivedInTx`:
 *                               Dr <tender account> / Cr LIABILITY.UNAPPLIED_RECEIPTS, sourceId = the PAYMENT id.
 *                               ONE journal per Payment.
 *   'walk_in_sale'              an ANONYMOUS walk-in sale — `walk-in-sale-journal.ts`: Dr <tender accounts>
 *                               (same-account tenders AGGREGATED) / Cr REVENUE.SALES / Cr TAX_PAYABLE,
 *                               sourceId = the INVOICE id. An anonymous Payment has no journal of its own: its
 *                               tender lives in the debit lines of its invoice's one walk_in_sale journal. The
 *                               Payments of that journal are exactly the Payments carrying a PaymentAllocation to
 *                               that invoice — N Payments (a Multi Payment) → ONE journal, each counted once.
 *   The tender account is the frozen `resolveReceiptAccountKeyForTender` mapping (imported, never repeated):
 *   CASH → ASSET.CASH_ON_HAND, BANK_TRANSFER → ASSET.BANK, CARD_TERMINAL / ONLINE_GATEWAY / OTHER_MANUAL →
 *   ASSET.PAYMENT_CLEARING. Credit is never a tender; a PaymentAllocation is never a second receipt; a
 *   `payment_allocation` / `customer_advance` / `customer_advance_application` journal is never a receipt.
 *
 *   REFUND — a `Refund` row (immutable money-out fact), ONE `refund` journal per Refund (sourceId = the REFUND id),
 *   Dr LIABILITY.CUSTOMER_ADVANCES, written in the SAME transaction as the Refund row by BOTH producers:
 *     local (CASH / BANK_TRANSFER, `sourceRefundAttemptId IS NULL`)   Cr ASSET.CASH_ON_HAND / ASSET.BANK
 *     provider-finalised (`sourceRefundAttemptId IS NOT NULL`)        Cr ASSET.PAYMENT_CLEARING
 *   A pending or failed RefundAttempt, an entitlement reservation and a CreditNote post NO `refund` journal and
 *   create NO Refund row — the exact source kinds below can never see them, and no whole-account balance is read.
 *
 *   'payment_allocation' is selected ONLY as an integrity detector (a customer Payment that was allocated but has
 *   no receipt journal) — it is never counted as a receipt.
 *
 *   PERIOD-BOUNDED INTEGRITY PROOFS (a measured design, plan §12): the two cross-journal checks are decided from the
 *   journals the PERIOD already holds — an anonymous Payment that ALSO has a customer receipt journal is found by
 *   joining the walk-in Payments to the in-period receipt journals; an allocated Payment is proven to have a receipt
 *   journal by that same in-period set, and ONLY the (rare) remainder — a receipt posted in an earlier period — is
 *   probed by the unique source index, one `LIMIT 1` lookup each. A per-Payment existence probe over every Payment of
 *   the window was measured and rejected: planned as a hash anti-join it read the company's whole receipt history for a
 *   one-day report; planned as a nested loop it added ~250 000 index probes to a 3-year report.
 *
 * ── Period authority ────────────────────────────────────────────────────────────────────────────
 *   A movement is in the period iff its SEALED journal's `journal_entry.postingDate` is — and ONLY that.
 *   `Payment.createdAt`, `Refund.createdAt` / `accountingDate`, `invoiceDate`, order and settlement dates never
 *   decide inclusion.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────────────────────────
 *   sel   the sealed journals in the period of the four kinds above — the ONLY entry point, anchored on the indexed
 *         `journal_entry(tenantId, companyId, postingDate)`; every other kind is not a tender movement
 *   cr    customer receipts: each journal joined to its Payment by primary key
 *   wj    walk-in journals joined to their invoice (and order) by primary key
 *   wp    the anonymous Payments of those invoices (PaymentAllocation.invoiceId → Payment by primary key)
 *   rf    refunds: each journal joined to its Refund by primary key
 *   al    the allocation journals (detector only)
 *   jl2   the GL lines of exactly the found receipt / walk-in / refund journals
 *   rcpt / rfnd / gl   the aggregates · crs / rfs / wsrc / wgl / wmis   the per-journal shape checks · ic   the counters
 *
 *   Explicit tenant + company (+ branch) predicates on every table touched — the report never relies on RLS or the
 *   branch GUC. Money is exact: every sum leaves the database as TEXT. Counts are JSON integers. No FX, no float.
 */
export const TENDER_SOURCE_KINDS = {
  customerReceipt: 'customer_receipt_payment',
  walkInSale: WALK_IN_SALE_SOURCE_KIND,
  refund: 'refund',
  paymentAllocation: 'payment_allocation',
} as const;

export const TENDER_ACCOUNT_KEYS = {
  cashOnHand: 'ASSET.CASH_ON_HAND',
  bank: 'ASSET.BANK',
  paymentClearing: 'ASSET.PAYMENT_CLEARING',
  unappliedReceipts: 'LIABILITY.UNAPPLIED_RECEIPTS',
  customerAdvances: 'LIABILITY.CUSTOMER_ADVANCES',
} as const;

/**
 * The account a LOCAL refund of the given method pays out of — mirrors `LOCAL_REFUND_CASH_OR_BANK_ACCOUNT` in
 * `refund-execution.repository.ts` (module-private there; pinned against it by the Checkpoint C structural pins).
 * A provider-finalised refund always credits ASSET.PAYMENT_CLEARING (`refund-attempt-reservation.repository.ts`).
 */
export const LOCAL_REFUND_ACCOUNT_BY_METHOD: Readonly<Record<string, string>> = Object.freeze({
  CASH: TENDER_ACCOUNT_KEYS.cashOnHand,
  BANK_TRANSFER: TENDER_ACCOUNT_KEYS.bank,
});

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** `CASE <column> WHEN 'CASH' THEN 'ASSET.CASH_ON_HAND' … END` from the production mapping — never a second copy. */
function receiptAccountCase(column: string): string {
  const whens = TENDER_METHODS.map(
    (m) => `WHEN '${m}' THEN '${resolveReceiptAccountKeyForTender(m)}'`,
  ).join(' ');
  return `CASE ${column} ${whens} END`;
}

/** the distinct tender accounts of the frozen mapping, as a SQL list */
const TENDER_ACCOUNT_LIST = [
  ...new Set(TENDER_METHODS.map((m) => resolveReceiptAccountKeyForTender(m))),
]
  .map((k) => `'${k}'`)
  .join(', ');

const REFUND_ACCOUNT_CASE = `CASE WHEN r."sourceRefundAttemptId" IS NOT NULL THEN '${TENDER_ACCOUNT_KEYS.paymentClearing}' ${Object.entries(
  LOCAL_REFUND_ACCOUNT_BY_METHOD,
)
  .map(([m, k]) => `WHEN r."method" = '${m}' THEN '${k}'`)
  .join(' ')} END`;

/**
 * THE DENSITY GUARD — Tender Totals v1 (owner ruling TT-1).
 *
 * NO calendar-day maximum. Instead: at most `TENDER_REPORT_MAX_MOVEMENTS` authoritative LOGICAL tender movements per
 * COMPANY-WINDOW evaluation, where a movement is exactly one successfully recorded `Payment` or one actual `Refund`
 * (N Payments of a Multi Payment = N movements; a PaymentAllocation, PaymentAttempt, RefundAttempt, CustomerAdvance,
 * CreditNote, SettlementApplication or an invoice / sale row is never one). The limit is judged on the COMPANY'S window
 * for the branch route too: `journal_entry` has no branch column, so a branch report still reads the company's tender
 * journals of the period, and it is that work the limit bounds.
 *
 * It is the FIRST stage of the same statement (never a separate COUNT): `cand` reads at most limit + 1 sealed journals of
 * the three movement kinds in the period; `gate` counts them (each journal is at least one movement, so more journals than
 * the limit is always over it) and adds, for the walk-in sale journals among them, the DISTINCT Payments each sale holds
 * beyond its first (N Payments of a Multi Payment = N movements although ONE journal books them). EVERY stage that reads a
 * heavy relation carries `gateOpen` — a One-Time Filter above its joins — so above the limit none of them executes under
 * any join method. The repository rejects from `candidateMovements` (REPORT_RESULT_TOO_LARGE, 422) before it reads
 * anything else; the figure itself is never disclosed.
 *
 * WHY THE EXTRA PAYMENTS ARE ONE SET-BASED READ, NOT A PROBE PER JOURNAL: a correlated `COUNT(DISTINCT …)` per walk-in
 * journal is costed by the planner as one index probe per candidate row (≈ 650 000 cost units for 77 000 estimated rows),
 * which lifts the whole statement over `jit_inline_above_cost` / `jit_optimize_above_cost` (500 000) and makes PostgreSQL
 * JIT-compile every expression with inlining and optimisation — ≈ 8–10 s of pure compilation, the same for an accepted and
 * a rejected report (measured: 15.6 s accepted / 10.1–11.2 s rejected at 100 000 movements, 6.5 s / 1.0 s with JIT off).
 * One `invoiceId = ANY (ARRAY(<the candidates' walk-in invoices>))` index scan, grouped per invoice, is the same exact
 * figure at a plan cost far below that threshold. (The ARRAY is bounded by the candidates, at most limit + 1.)
 */
export const TENDER_REPORT_MAX_MOVEMENTS = 100_000;

function tenderTotalsReportSql(maxMovements: number): string {
  if (!Number.isSafeInteger(maxMovements) || maxMovements < 0) {
    throw new RangeError('the Tender report movement limit must be a non-negative integer');
  }
  // the ONE gate comparison: `cand` counted at most limit + 1 journals; above the limit every stage that carries this
  // predicate is skipped as a whole (a One-Time Filter above its joins)
  const gateOpen = `(SELECT g."n" FROM gate g) <= ${maxMovements}`;
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
cand AS (
  SELECT je."sourceKind" AS "kind",
         CASE WHEN je."sourceId" ~ '${UUID_RE}' THEN je."sourceId"::uuid END AS "docId"
    FROM "journal_entry" je
   WHERE je."tenantId" = $1::uuid
     AND je."companyId" = $2::uuid
     AND je."sealedAt" IS NOT NULL
     AND je."postingDate" >= $3::date
     AND je."postingDate" <= $4::date
     AND je."sourceKind" IN ('${TENDER_SOURCE_KINDS.customerReceipt}', '${TENDER_SOURCE_KINDS.walkInSale}', '${TENDER_SOURCE_KINDS.refund}')
   LIMIT ${maxMovements + 1}
),
gate AS (
  SELECT (SELECT COUNT(*) FROM cand)
       + COALESCE((SELECT SUM(x."payments" - 1)
                     FROM (SELECT COUNT(DISTINCT pa0."paymentId") AS "payments"
                             FROM "payment_allocation" pa0
                            WHERE pa0."tenantId" = $1::uuid
                              AND pa0."companyId" = $2::uuid
                              AND pa0."invoiceId" = ANY (ARRAY(SELECT c."docId" FROM cand c WHERE c."kind" = '${TENDER_SOURCE_KINDS.walkInSale}'))
                            GROUP BY pa0."invoiceId") x
                    WHERE x."payments" > 1), 0) AS "n"
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
     AND je."sourceKind" IN ('${TENDER_SOURCE_KINDS.customerReceipt}', '${TENDER_SOURCE_KINDS.walkInSale}', '${TENDER_SOURCE_KINDS.refund}', '${TENDER_SOURCE_KINDS.paymentAllocation}')
     AND ${gateOpen}
),
cr AS (
  SELECT s."entryId" AS "entryId", s."journalCurrency" AS "journalCurrency", s."docId" AS "paymentId",
         (p."id" IS NOT NULL) AS "found",
         p."branchId" AS "branchId", p."method" AS "method", p."amountMinor" AS "amount",
         p."currencyCode" AS "docCurrency",
         ${receiptAccountCase('p."method"')} AS "expKey"
    FROM sel s
    LEFT JOIN "payment" p
      ON p."id" = s."docId" AND p."tenantId" = $1::uuid AND p."companyId" = $2::uuid
   WHERE s."sourceKind" = '${TENDER_SOURCE_KINDS.customerReceipt}'
     AND ($5::uuid IS NULL OR p."branchId" = $5::uuid)
     AND ${gateOpen}
),
wj AS (
  SELECT s."entryId" AS "entryId", s."journalCurrency" AS "journalCurrency", s."docId" AS "docId",
         (i."id" IS NOT NULL) AS "found",
         i."branchId" AS "branchId", i."currencyCode" AS "docCurrency",
         (o."customerId" IS NOT NULL
          OR EXISTS (SELECT 1 FROM "customer_receivable" cr0
                      WHERE cr0."invoiceId" = i."id" AND cr0."tenantId" = $1::uuid AND cr0."companyId" = $2::uuid)) AS "customerLinked"
    FROM sel s
    LEFT JOIN "invoice" i
      ON i."id" = s."docId" AND i."tenantId" = $1::uuid AND i."companyId" = $2::uuid
    LEFT JOIN "order" o
      ON o."id" = i."orderId" AND o."tenantId" = $1::uuid AND o."companyId" = $2::uuid
   WHERE s."sourceKind" = '${TENDER_SOURCE_KINDS.walkInSale}'
     AND ($5::uuid IS NULL OR i."branchId" = $5::uuid)
     AND ${gateOpen}
),
wp AS (
  SELECT w."entryId" AS "entryId", w."branchId" AS "branchId",
         p."id" AS "paymentId", p."branchId" AS "paymentBranchId", p."method" AS "method",
         p."amountMinor" AS "amount", p."currencyCode" AS "docCurrency",
         ${receiptAccountCase('p."method"')} AS "expKey",
         (SELECT COUNT(*) FROM "payment_allocation" x
           WHERE x."paymentId" = p."id" AND x."tenantId" = $1::uuid AND x."companyId" = $2::uuid) AS "allocationCount"
    FROM wj w
    JOIN "payment_allocation" pa
      ON pa."invoiceId" = w."docId" AND pa."tenantId" = $1::uuid AND pa."companyId" = $2::uuid
    JOIN "payment" p
      ON p."id" = pa."paymentId" AND p."tenantId" = $1::uuid AND p."companyId" = $2::uuid
   WHERE w."found"
     AND ${gateOpen}
),
rf AS (
  SELECT s."entryId" AS "entryId", s."journalCurrency" AS "journalCurrency",
         (r."id" IS NOT NULL) AS "found",
         r."branchId" AS "branchId", r."method" AS "method", r."amountMinor" AS "amount",
         r."currencyCode" AS "docCurrency",
         ${REFUND_ACCOUNT_CASE} AS "expKey"
    FROM sel s
    LEFT JOIN "refund" r
      ON r."id" = s."docId" AND r."tenantId" = $1::uuid AND r."companyId" = $2::uuid
   WHERE s."sourceKind" = '${TENDER_SOURCE_KINDS.refund}'
     AND ($5::uuid IS NULL OR r."branchId" = $5::uuid)
     AND ${gateOpen}
),
al AS (
  SELECT p."id" AS "paymentId"
    FROM sel s
    JOIN "payment_allocation" pa
      ON pa."id" = s."docId" AND pa."tenantId" = $1::uuid AND pa."companyId" = $2::uuid
    JOIN "payment" p
      ON p."id" = pa."paymentId" AND p."tenantId" = $1::uuid AND p."companyId" = $2::uuid
   WHERE s."sourceKind" = '${TENDER_SOURCE_KINDS.paymentAllocation}'
     AND ($5::uuid IS NULL OR p."branchId" = $5::uuid)
     AND ${gateOpen}
),
alu AS MATERIALIZED (
  SELECT DISTINCT a."paymentId" AS "paymentId"
    FROM al a
   WHERE NOT EXISTS (SELECT 1 FROM cr c WHERE c."paymentId" = a."paymentId")
),
jl2 AS (
  SELECT x."entryId" AS "entryId", x."kind" AS "kind", x."branchId" AS "docBranchId",
         a."key" AS "accountKey", jl."branchId" AS "lineBranchId",
         jl."debitMinor" AS "debit", jl."creditMinor" AS "credit"
    FROM (
      SELECT c."entryId", '${TENDER_SOURCE_KINDS.customerReceipt}'::text AS "kind", c."branchId" FROM cr c WHERE c."found"
      UNION ALL
      SELECT w."entryId", '${TENDER_SOURCE_KINDS.walkInSale}'::text, w."branchId" FROM wj w WHERE w."found"
      UNION ALL
      SELECT r."entryId", '${TENDER_SOURCE_KINDS.refund}'::text, r."branchId" FROM rf r WHERE r."found"
    ) x
    JOIN "journal_line" jl
      ON jl."journalEntryId" = x."entryId" AND jl."tenantId" = $1::uuid AND jl."companyId" = $2::uuid
    JOIN "account" a
      ON a."id" = jl."accountId" AND a."tenantId" = $1::uuid AND a."companyId" = $2::uuid
   WHERE ${gateOpen}
),
rcpt AS (
  SELECT c."branchId" AS "branchId", 'CUSTOMER'::text AS "stream", c."method" AS "method",
         COUNT(*) AS "n", COALESCE(SUM(c."amount"), 0) AS "total"
    FROM cr c
   WHERE c."found"
   GROUP BY c."branchId", c."method"
  UNION ALL
  SELECT w."branchId", 'ANONYMOUS'::text, w."method", COUNT(*), COALESCE(SUM(w."amount"), 0)
    FROM wp w
   GROUP BY w."branchId", w."method"
),
rfnd AS (
  SELECT r."branchId" AS "branchId", r."method" AS "method", r."expKey" AS "accountKey",
         COUNT(*) AS "n", COALESCE(SUM(r."amount"), 0) AS "total"
    FROM rf r
   WHERE r."found"
   GROUP BY r."branchId", r."method", r."expKey"
),
gl AS (
  SELECT l."docBranchId" AS "branchId", l."kind" AS "sourceKind", l."accountKey" AS "accountKey",
         COALESCE(SUM(l."debit"), 0) AS "debit", COALESCE(SUM(l."credit"), 0) AS "credit"
    FROM jl2 l
   GROUP BY l."docBranchId", l."kind", l."accountKey"
),
crs AS (
  SELECT c."entryId" AS "entryId", c."amount" AS "amount",
         COALESCE(SUM(l."debit") FILTER (WHERE l."accountKey" = c."expKey"), 0) AS "dExp",
         COALESCE(SUM(l."credit") FILTER (WHERE l."accountKey" = '${TENDER_ACCOUNT_KEYS.unappliedReceipts}'), 0) AS "cUnap",
         COALESCE(SUM(l."debit"), 0) AS "dAll", COALESCE(SUM(l."credit"), 0) AS "cAll"
    FROM cr c
    LEFT JOIN jl2 l ON l."entryId" = c."entryId" AND l."kind" = '${TENDER_SOURCE_KINDS.customerReceipt}'
   WHERE c."found"
   GROUP BY c."entryId", c."amount", c."expKey"
),
rfs AS (
  SELECT r."entryId" AS "entryId", r."amount" AS "amount", r."expKey" AS "expKey",
         COALESCE(SUM(l."debit") FILTER (WHERE l."accountKey" = '${TENDER_ACCOUNT_KEYS.customerAdvances}'), 0) AS "dAdv",
         COALESCE(SUM(l."credit") FILTER (WHERE r."expKey" IS NOT NULL AND l."accountKey" = r."expKey"), 0) AS "cExp",
         COALESCE(SUM(l."debit"), 0) AS "dAll", COALESCE(SUM(l."credit"), 0) AS "cAll"
    FROM rf r
    LEFT JOIN jl2 l ON l."entryId" = r."entryId" AND l."kind" = '${TENDER_SOURCE_KINDS.refund}'
   WHERE r."found"
   GROUP BY r."entryId", r."amount", r."expKey"
),
wsrc AS (
  SELECT w."entryId" AS "entryId", w."expKey" AS "accountKey", SUM(w."amount") AS "amt"
    FROM wp w
   GROUP BY w."entryId", w."expKey"
),
wgl AS (
  SELECT l."entryId" AS "entryId", l."accountKey" AS "accountKey",
         SUM(l."debit") AS "d", SUM(l."credit") AS "c"
    FROM jl2 l
   WHERE l."kind" = '${TENDER_SOURCE_KINDS.walkInSale}'
   GROUP BY l."entryId", l."accountKey"
),
wmis AS (
  SELECT COUNT(*) AS "n"
    FROM wsrc s
    FULL JOIN wgl g ON g."entryId" = s."entryId" AND g."accountKey" = s."accountKey"
   WHERE COALESCE(s."amt", 0) <> COALESCE(g."d", 0)
      OR (g."accountKey" IN (${TENDER_ACCOUNT_LIST}) AND COALESCE(g."c", 0) <> 0)
),
ic AS (
  SELECT
    (SELECT COUNT(*) FROM cr c WHERE NOT c."found") AS "orphanReceiptJournals",
    (SELECT COUNT(*) FROM wj w WHERE NOT w."found") AS "orphanWalkInJournals",
    (SELECT COUNT(*) FROM rf r WHERE NOT r."found") AS "orphanRefundJournals",
    (SELECT COUNT(*) FROM jl2 l WHERE l."lineBranchId" IS DISTINCT FROM l."docBranchId") AS "branchMismatchLines",
    (SELECT COUNT(*) FROM cr c, co WHERE c."found"
        AND (c."journalCurrency" IS DISTINCT FROM co."defaultCurrency" OR c."docCurrency" IS DISTINCT FROM co."defaultCurrency"))
    + (SELECT COUNT(*) FROM wj w, co WHERE w."found"
        AND (w."journalCurrency" IS DISTINCT FROM co."defaultCurrency" OR w."docCurrency" IS DISTINCT FROM co."defaultCurrency"))
    + (SELECT COUNT(*) FROM wp w, co WHERE w."docCurrency" IS DISTINCT FROM co."defaultCurrency")
    + (SELECT COUNT(*) FROM rf r, co WHERE r."found"
        AND (r."journalCurrency" IS DISTINCT FROM co."defaultCurrency" OR r."docCurrency" IS DISTINCT FROM co."defaultCurrency")) AS "currencyMismatchDocuments",
    (SELECT COUNT(*) FROM crs x
      WHERE NOT (x."dExp" = x."amount" AND x."cUnap" = x."amount" AND x."dAll" = x."amount" AND x."cAll" = x."amount")) AS "receiptJournalMismatches",
    (SELECT COUNT(*) FROM rfs x
      WHERE NOT (x."expKey" IS NOT NULL AND x."dAdv" = x."amount" AND x."cExp" = x."amount" AND x."dAll" = x."amount" AND x."cAll" = x."amount")) AS "refundJournalMismatches",
    (SELECT COUNT(*) FROM rf r WHERE r."found" AND r."expKey" IS NULL) AS "refundUnmappedMethods",
    (SELECT m."n" FROM wmis m) AS "walkInTenderMismatches",
    (SELECT COUNT(*) FROM wj w WHERE w."found" AND w."customerLinked") AS "walkInOnCustomerInvoices",
    (SELECT COUNT(*) FROM wp w WHERE w."allocationCount" <> 1) AS "walkInPaymentAllocationFanout",
    (SELECT COUNT(*) FROM wp w WHERE w."paymentBranchId" IS DISTINCT FROM w."branchId") AS "walkInPaymentBranchMismatches",
    (SELECT COUNT(*) FROM wp w
       JOIN cr c ON c."paymentId" = w."paymentId") AS "anonymousPaymentsWithReceiptJournal",
    (SELECT COUNT(*) FROM alu u
       LEFT JOIN LATERAL (
         SELECT 1 AS "hit" FROM "journal_entry" j
          WHERE j."tenantId" = $1::uuid AND j."companyId" = $2::uuid
            AND j."sealedAt" IS NOT NULL
            AND j."sourceKind" = '${TENDER_SOURCE_KINDS.customerReceipt}'
            AND j."sourceId" = u."paymentId"::text
          LIMIT 1) rj2 ON true
      WHERE rj2."hit" IS NULL) AS "allocatedPaymentsWithoutReceiptJournal"
)
SELECT json_build_object(
  'company', (SELECT json_build_object('defaultCurrency', co."defaultCurrency", 'accountingTimezone', co."accountingTimezone") FROM co),
  'branchFound', (SELECT COUNT(*) FROM scope_branch),
  'candidateMovements', (SELECT g."n" FROM gate g),
  'receipts', COALESCE((SELECT json_agg(json_build_object(
      'branchId', x."branchId", 'stream', x."stream", 'method', x."method",
      'count', x."n", 'totalMinor', x."total"::text
    ) ORDER BY x."branchId", x."stream", x."method") FROM rcpt x), '[]'::json),
  'refunds', COALESCE((SELECT json_agg(json_build_object(
      'branchId', x."branchId", 'method', x."method", 'accountKey', x."accountKey",
      'count', x."n", 'totalMinor', x."total"::text
    ) ORDER BY x."branchId", x."method", x."accountKey") FROM rfnd x), '[]'::json),
  'gl', COALESCE((SELECT json_agg(json_build_object(
      'branchId', g."branchId", 'sourceKind', g."sourceKind", 'accountKey', g."accountKey",
      'debitMinor', g."debit"::text, 'creditMinor', g."credit"::text
    ) ORDER BY g."branchId", g."sourceKind", g."accountKey") FROM gl g), '[]'::json),
  'integrity', (SELECT json_build_object(
      'orphanReceiptJournals', ic."orphanReceiptJournals",
      'orphanWalkInJournals', ic."orphanWalkInJournals",
      'orphanRefundJournals', ic."orphanRefundJournals",
      'branchMismatchLines', ic."branchMismatchLines",
      'currencyMismatchDocuments', ic."currencyMismatchDocuments",
      'receiptJournalMismatches', ic."receiptJournalMismatches",
      'refundJournalMismatches', ic."refundJournalMismatches",
      'refundUnmappedMethods', ic."refundUnmappedMethods",
      'walkInTenderMismatches', ic."walkInTenderMismatches",
      'walkInOnCustomerInvoices', ic."walkInOnCustomerInvoices",
      'walkInPaymentAllocationFanout', ic."walkInPaymentAllocationFanout",
      'walkInPaymentBranchMismatches', ic."walkInPaymentBranchMismatches",
      'anonymousPaymentsWithReceiptJournal', ic."anonymousPaymentsWithReceiptJournal",
      'allocatedPaymentsWithoutReceiptJournal', ic."allocatedPaymentsWithoutReceiptJournal"
    ) FROM ic)
)::text AS "report"
`;
}

/** the statement at the v1 movement limit (the exact text the repository runs) */
export const TENDER_TOTALS_REPORT_SQL = tenderTotalsReportSql(TENDER_REPORT_MAX_MOVEMENTS);

export interface TenderTotalsReportQuery {
  readonly text: string;
  /** `[tenantId, companyId, from, to, branchId | null]` — positional parameters `$1..$5`. */
  readonly values: readonly [string, string, string, string, string | null];
}

export function buildTenderTotalsReportQuery(args: {
  readonly tenantId: string;
  readonly companyId: string;
  readonly from: string;
  readonly to: string;
  readonly branchId: string | null;
  /** the density limit (defaults to the v1 constant; only tests pass another value) */
  readonly maxMovements?: number;
}): TenderTotalsReportQuery {
  return {
    text:
      args.maxMovements === undefined
        ? TENDER_TOTALS_REPORT_SQL
        : tenderTotalsReportSql(args.maxMovements),
    values: [args.tenantId, args.companyId, args.from, args.to, args.branchId],
  };
}

/** The JSON document the statement returns (money as TEXT, counts as JSON integers). */
export interface TenderTotalsReportJson {
  readonly company: { defaultCurrency: string | null; accountingTimezone: string | null } | null;
  readonly branchFound: number;
  /** logical tender movements of the COMPANY window, counted up to the limit (never returned to a caller) */
  readonly candidateMovements: number;
  readonly receipts: readonly {
    branchId: string;
    stream: string;
    method: string;
    count: number;
    totalMinor: string;
  }[];
  readonly refunds: readonly {
    branchId: string;
    method: string;
    accountKey: string | null;
    count: number;
    totalMinor: string;
  }[];
  readonly gl: readonly {
    branchId: string;
    sourceKind: string;
    accountKey: string;
    debitMinor: string;
    creditMinor: string;
  }[];
  readonly integrity: {
    orphanReceiptJournals: number;
    orphanWalkInJournals: number;
    orphanRefundJournals: number;
    branchMismatchLines: number;
    currencyMismatchDocuments: number;
    receiptJournalMismatches: number;
    refundJournalMismatches: number;
    refundUnmappedMethods: number;
    walkInTenderMismatches: number;
    walkInOnCustomerInvoices: number;
    walkInPaymentAllocationFanout: number;
    walkInPaymentBranchMismatches: number;
    anonymousPaymentsWithReceiptJournal: number;
    allocatedPaymentsWithoutReceiptJournal: number;
  };
}
