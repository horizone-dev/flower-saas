import {
  RECEIVABLE_SOURCE_TYPES,
  type ReceivableSourceType,
} from '../receivables/receivable-balance.js';

/**
 * Task 3b.10 Checkpoint D — THE Receivables current-state statement: ONE read statement for the whole report — the
 * snapshot instant, the scope summary, the source-type breakdown, `byBranch`, the paginated per-customer page and the
 * GL control — so every figure comes from ONE snapshot (`runScoped` offers no isolation-level control; a multi-statement
 * report could straddle a concurrent posting).
 *
 *   $1 tenantId   $2 companyId   $3 branchId (NULL = the whole company)   $4 customerId (NULL = every customer)
 *   $5 cursor (the last emitted customerId, NULL = the first page)        $6 page limit
 *
 * ── The frozen receivable model (discovered in the code, never assumed) ──────────────────────────────
 *
 *   `customer_receivable` is the append-only AR anchor; `sourceType` is a CLOSED set (INVOICE | OPENING |
 *   CANCELLATION_CHARGE — `RECEIVABLE_SOURCE_TYPES`), the branch is the receivable's OWN `branchId`, and the customer is
 *   reached through `customer_company_account.customerId` (never the customer PII table):
 *
 *   original        INVOICE `invoice.totalAmountMinor` · OPENING `openingAmountMinor` · CANCELLATION_CHARGE
 *                   `cancellation_charge.totalAmountMinor`
 *   paidByPayment   INVOICE Σ `payment_allocation` of the invoice · OPENING / CANCELLATION_CHARGE Σ
 *                   `customer_receivable_payment_application` of the receivable
 *   paidByAdvance   Σ `customer_advance_application` of the receivable
 *   credited        INVOICE Σ `credit_note.arReductionMinor` of the invoice (the AR reduction ONLY — the excess that
 *                   became a CustomerAdvance is never read here)
 *   outstanding     original − paidByPayment − paidByAdvance − credited — the frozen `computeReceivableBalance`
 *                   (`receivable-balance.ts`) applies it; THIS statement only sums its components, per (branch, source type).
 *
 * ── The GL control: ONLY the authoritative AR-changing journals (each producer read, not remembered) ──
 *
 *   AR increase (Dr ASSET.ACCOUNTS_RECEIVABLE)                       sourceKind · sourceId
 *     invoice_ar                           customer-invoice-ar.repository.ts     the INVOICE id
 *     opening_receivable                   opening-balance.repository.ts         the RECEIVABLE id
 *     cancellation_charge                  cancellation-charge.repository.ts     the CHARGE id
 *   AR decrease (Cr ASSET.ACCOUNTS_RECEIVABLE)
 *     payment_allocation                   customer-receipt-effects.repository   the PaymentAllocation id
 *     opening_receivable_payment_application / cancellation_charge_payment_application
 *                                          customer-receipt-effects.repository   the application id
 *     customer_advance_application         customer-advance-application.repository  the application id
 *     credit_note                          credit-note.repository.ts  the CreditNote id (the arReduction line ONLY)
 *   Every other journal that touches no AR line (a Payment receipt, an Advance conversion, a Refund, a settlement, a
 *   walk-in sale) is not read; a journal of some OTHER kind that happens to carry an AR line (a manual or raw one) is not
 *   part of the control. The statement proves, per source FACT, that its ONE sealed journal exists with exactly that AR
 *   line on the right side, in the fact's branch and the company currency — and, for the unfiltered company report, that
 *   no authoritative-kind journal with an AR line exists without a fact. Any gap fails the report closed.
 *
 * ── Shape ──────────────────────────────────────────────────────────────────────────────────────────
 *   rcv   the receivables in scope (explicit tenant / company / branch / customer predicates) with their source document
 *   app   every application of those receivables (allocation, receivable payment application, advance application,
 *         CreditNote AR reduction) — set-based, one read per source table, no per-receivable query
 *   rc    each receivable with its three summed components · cells / custcells   the aggregates
 *   fact  every AR-changing fact (the receivable itself + each application)
 *   jh / jall  (unfiltered company report only) the headers of every authoritative-kind sealed journal, and their AR LINES —
 *         a hash join, never one index probe per line
 *   jx    THE RECONCILIATION: ONE join of the facts against the AR lines. Unfiltered it is a FULL OUTER JOIN on
 *         (sourceKind, sourceId): matched (a fact and its line) · fact-only (a MISSING journal) · line-only (an ORPHAN
 *         journal — an authoritative-kind AR line with no fact), all in one pass. A branch / customer report is
 *         fact-driven: the facts LEFT JOINed to their own journal and AR line (one unique-index probe per fact)
 *   jxc   the counters over jx — matched lines, missing facts, orphan lines and sums, currency / shape / branch mismatches
 *         (a journal with an EXTRA AR line is the matched lines beyond the facts that matched) · glb   the GL AR per branch
 *   ic    the integrity counters
 *
 *   Explicit tenant + company (+ branch) predicates on EVERY table touched — the report never relies on RLS or the branch
 *   GUC. Money is exact: every sum leaves the database as TEXT. Counts are JSON integers. No FX, no float. No customer
 *   name, phone, e-mail or address is ever read.
 */
export const AR_SOURCE_TYPES = {
  invoice: 'INVOICE',
  opening: 'OPENING',
  cancellationCharge: 'CANCELLATION_CHARGE',
} as const satisfies Record<string, ReceivableSourceType>;

export const AR_ACCOUNT_KEY = 'ASSET.ACCOUNTS_RECEIVABLE';

export const AR_JOURNAL_KINDS = {
  invoiceAr: 'invoice_ar',
  openingReceivable: 'opening_receivable',
  cancellationCharge: 'cancellation_charge',
  paymentAllocation: 'payment_allocation',
  openingReceivablePaymentApplication: 'opening_receivable_payment_application',
  cancellationChargePaymentApplication: 'cancellation_charge_payment_application',
  customerAdvanceApplication: 'customer_advance_application',
  creditNote: 'credit_note',
} as const;

/** the journal kinds the control reads — exactly these, no other */
const AR_KIND_LIST = Object.values(AR_JOURNAL_KINDS)
  .map((k) => `'${k}'`)
  .join(', ');

const SOURCE_TYPE_LIST = RECEIVABLE_SOURCE_TYPES.map((t) => `'${t}'`).join(', ');

/**
 * THE DENSITY GUARD — Receivables v1 (owner ruling RD-1).
 *
 * NO calendar cap, NO historical `asOf`, NO aging. At most `RECEIVABLES_REPORT_MAX_RECEIVABLES` CustomerReceivable records
 * in the ACTUAL EVALUATED SCOPE — the company, or the requested branch (sibling branches never contribute), or the customer
 * filter after its company / branch scope; the gate applies EXACTLY the predicates `rcv` applies (tenant, company,
 * `$3` branch, `$4` customer through `customer_company_account`) and nothing else.
 *
 * It is the FIRST stage of the same statement — never a separate COUNT: `gate` reads at most limit + 1 receivables of the
 * scope (an early-stopped scan) and counts them. EVERY stage that reads a heavy relation carries `gateOpen` — a One-Time
 * Filter above its joins — so above the limit none of them executes under any join method: the receivables themselves
 * (`rcv`), the four application sources (`app`), the journal headers and AR lines (`jh`, `jall`, `jx`) and the integrity
 * counters that read a base table (`ic`); the aggregates, `byBranch`, the customer page and the GL reconciliation all
 * derive from those and are empty. The repository rejects from `candidateReceivables` (REPORT_RESULT_TOO_LARGE, 422) before
 * it reads anything else; the figure itself is never disclosed.
 */
export const RECEIVABLES_REPORT_MAX_RECEIVABLES = 100_000;

function receivablesReportSql(maxReceivables: number): string {
  if (!Number.isSafeInteger(maxReceivables) || maxReceivables < 0) {
    throw new RangeError('the Receivables report receivable limit must be a non-negative integer');
  }
  // the ONE gate comparison: `gate` counted at most limit + 1 receivables; above the limit every stage that carries this
  // predicate is skipped as a whole (a One-Time Filter above its joins)
  const gateOpen = `(SELECT gt."n" FROM gate gt) <= ${maxReceivables}`;
  return `
WITH co AS (
  SELECT c."defaultCurrency" AS "cur", c."accountingTimezone" AS "tz"
    FROM "company" c
   WHERE c."tenantId" = $1::uuid
     AND c."id" = $2::uuid
),
scope_branch AS (
  SELECT b."id" AS "id"
    FROM "branch" b
   WHERE b."tenantId" = $1::uuid
     AND b."companyId" = $2::uuid
     AND b."id" = $3::uuid
),
scope_customer AS (
  SELECT sc."id" AS "id"
    FROM "customer_company_account" sc
   WHERE sc."tenantId" = $1::uuid
     AND sc."companyId" = $2::uuid
     AND sc."customerId" = $4::uuid
),
gate AS MATERIALIZED (
  SELECT COUNT(*) AS "n"
    FROM (
      SELECT 1
        FROM "customer_receivable" cg
        JOIN "customer_company_account" xg
          ON xg."id" = cg."customerCompanyAccountId" AND xg."tenantId" = $1::uuid AND xg."companyId" = $2::uuid
       WHERE cg."tenantId" = $1::uuid
         AND cg."companyId" = $2::uuid
         AND ($3::uuid IS NULL OR cg."branchId" = $3::uuid)
         AND ($4::uuid IS NULL OR xg."customerId" = $4::uuid)
       LIMIT ${maxReceivables + 1}
    ) gs
),
rcv AS MATERIALIZED (
  SELECT cr."id" AS "rid", cr."branchId" AS "branch", cr."sourceType" AS "st",
         cr."invoiceId" AS "inv", cr."cancellationChargeId" AS "chg", x."customerId" AS "cust",
         CASE cr."sourceType"
           WHEN '${AR_SOURCE_TYPES.invoice}' THEN i."totalAmountMinor"
           WHEN '${AR_SOURCE_TYPES.opening}' THEN cr."openingAmountMinor"
           WHEN '${AR_SOURCE_TYPES.cancellationCharge}' THEN cc."totalAmountMinor"
         END AS "principal",
         COALESCE(i."currencyCode", cc."currencyCode", cr."currencyCode") AS "cur",
         COALESCE(i."branchId", cc."branchId", cr."branchId") AS "srcBranch"
    FROM "customer_receivable" cr
    JOIN "customer_company_account" x
      ON x."id" = cr."customerCompanyAccountId" AND x."tenantId" = $1::uuid AND x."companyId" = $2::uuid
    LEFT JOIN "invoice" i
      ON i."id" = cr."invoiceId" AND i."tenantId" = $1::uuid AND i."companyId" = $2::uuid
    LEFT JOIN "cancellation_charge" cc
      ON cc."id" = cr."cancellationChargeId" AND cc."tenantId" = $1::uuid AND cc."companyId" = $2::uuid
   WHERE cr."tenantId" = $1::uuid
     AND cr."companyId" = $2::uuid
     AND ($3::uuid IS NULL OR cr."branchId" = $3::uuid)
     AND ($4::uuid IS NULL OR x."customerId" = $4::uuid)
     AND ${gateOpen}
),
app AS MATERIALIZED (
  SELECT '${AR_JOURNAL_KINDS.paymentAllocation}'::text AS "kind", pa."id" AS "id", r."rid" AS "rid",
         pa."amountMinor" AS "amt", 'PAY'::text AS "grp", pa."currencyCode" AS "cur",
         pa."branchId" AS "appBranch", r."branch" AS "branch", r."cust" AS "cust"
    FROM "payment_allocation" pa
    JOIN rcv r ON r."inv" = pa."invoiceId" AND r."st" = '${AR_SOURCE_TYPES.invoice}'
   WHERE pa."tenantId" = $1::uuid
     AND pa."companyId" = $2::uuid
     AND ${gateOpen}
  UNION ALL
  SELECT CASE r."st"
           WHEN '${AR_SOURCE_TYPES.opening}' THEN '${AR_JOURNAL_KINDS.openingReceivablePaymentApplication}'
           ELSE '${AR_JOURNAL_KINDS.cancellationChargePaymentApplication}'
         END, crpa."id", r."rid", crpa."amountMinor", 'PAY', crpa."currencyCode",
         crpa."branchId", r."branch", r."cust"
    FROM "customer_receivable_payment_application" crpa
    JOIN rcv r ON r."rid" = crpa."customerReceivableId" AND r."st" <> '${AR_SOURCE_TYPES.invoice}'
   WHERE crpa."tenantId" = $1::uuid
     AND crpa."companyId" = $2::uuid
     AND ${gateOpen}
  UNION ALL
  SELECT '${AR_JOURNAL_KINDS.customerAdvanceApplication}', caa."id", r."rid", caa."amountMinor", 'ADV',
         caa."currencyCode", caa."branchId", r."branch", r."cust"
    FROM "customer_advance_application" caa
    JOIN rcv r ON r."rid" = caa."customerReceivableId"
   WHERE caa."tenantId" = $1::uuid
     AND caa."companyId" = $2::uuid
     AND ${gateOpen}
  UNION ALL
  SELECT '${AR_JOURNAL_KINDS.creditNote}', cn."id", r."rid", cn."arReductionMinor", 'CRD',
         cn."currencyCode", cn."branchId", r."branch", r."cust"
    FROM "credit_note" cn
    JOIN rcv r ON r."inv" = cn."invoiceId" AND r."st" = '${AR_SOURCE_TYPES.invoice}'
   WHERE cn."tenantId" = $1::uuid
     AND cn."companyId" = $2::uuid
     AND cn."arReductionMinor" > 0
     AND ${gateOpen}
),
agg AS (
  SELECT a."rid" AS "rid",
         COALESCE(SUM(a."amt") FILTER (WHERE a."grp" = 'PAY'), 0) AS "pay",
         COALESCE(SUM(a."amt") FILTER (WHERE a."grp" = 'ADV'), 0) AS "adv",
         COALESCE(SUM(a."amt") FILTER (WHERE a."grp" = 'CRD'), 0) AS "crd"
    FROM app a
   GROUP BY a."rid"
),
rc AS (
  SELECT r."rid" AS "rid", r."branch" AS "branch", r."st" AS "st", r."cust" AS "cust",
         r."principal" AS "principal", COALESCE(g."pay", 0) AS "pay", COALESCE(g."adv", 0) AS "adv",
         COALESCE(g."crd", 0) AS "crd",
         r."principal" - COALESCE(g."pay", 0) - COALESCE(g."adv", 0) - COALESCE(g."crd", 0) AS "outstanding"
    FROM rcv r
    LEFT JOIN agg g ON g."rid" = r."rid"
),
cells AS (
  SELECT r."branch" AS "branch", r."st" AS "st", COUNT(*) AS "n", COALESCE(SUM(r."principal"), 0) AS "orig",
         COALESCE(SUM(r."pay"), 0) AS "pay", COALESCE(SUM(r."adv"), 0) AS "adv", COALESCE(SUM(r."crd"), 0) AS "crd",
         COUNT(*) FILTER (WHERE r."principal" IS NOT NULL AND r."outstanding" < 0) AS "over"
    FROM rc r
   GROUP BY r."branch", r."st"
),
pg AS (
  SELECT DISTINCT r."cust" AS "cust"
    FROM rc r
   WHERE ($5::uuid IS NULL OR r."cust" > $5::uuid)
   ORDER BY r."cust"
   LIMIT ($6::int + 1)
),
pgn AS (
  SELECT p."cust" AS "cust", row_number() OVER (ORDER BY p."cust") AS "rn"
    FROM pg p
),
custcells AS (
  SELECT r."cust" AS "cust", r."st" AS "st", COUNT(*) AS "n", COALESCE(SUM(r."principal"), 0) AS "orig",
         COALESCE(SUM(r."pay"), 0) AS "pay", COALESCE(SUM(r."adv"), 0) AS "adv", COALESCE(SUM(r."crd"), 0) AS "crd"
    FROM rc r
    JOIN pgn p ON p."cust" = r."cust" AND p."rn" <= $6::int
   GROUP BY r."cust", r."st"
),
fact AS MATERIALIZED (
  SELECT CASE r."st"
           WHEN '${AR_SOURCE_TYPES.invoice}' THEN '${AR_JOURNAL_KINDS.invoiceAr}'
           WHEN '${AR_SOURCE_TYPES.opening}' THEN '${AR_JOURNAL_KINDS.openingReceivable}'
           WHEN '${AR_SOURCE_TYPES.cancellationCharge}' THEN '${AR_JOURNAL_KINDS.cancellationCharge}'
         END AS "kind",
         CASE r."st"
           WHEN '${AR_SOURCE_TYPES.invoice}' THEN r."inv"::text
           WHEN '${AR_SOURCE_TYPES.opening}' THEN r."rid"::text
           WHEN '${AR_SOURCE_TYPES.cancellationCharge}' THEN r."chg"::text
         END AS "sid",
         r."branch" AS "branch", r."principal" AS "amt", 'D'::text AS "side"
    FROM rcv r
  UNION ALL
  SELECT a."kind", a."id"::text, a."branch", a."amt", 'C'::text
    FROM app a
),
jh AS MATERIALIZED (
  SELECT je."id" AS "jid", je."sourceKind" AS "kind", je."sourceId" AS "sid", je."currencyCode" AS "jcur"
    FROM "journal_entry" je
   WHERE je."tenantId" = $1::uuid
     AND je."companyId" = $2::uuid
     AND je."sealedAt" IS NOT NULL
     AND je."sourceKind" IN (${AR_KIND_LIST})
     AND $3::uuid IS NULL
     AND $4::uuid IS NULL
     AND ${gateOpen}
),
jall AS MATERIALIZED (
  SELECT h."kind" AS "kind", h."sid" AS "sid", h."jcur" AS "jcur", h."jid" AS "jid",
         l."branchId" AS "lb", l."debitMinor" AS "d", l."creditMinor" AS "c"
    FROM "journal_line" l
    JOIN "account" a
      ON a."id" = l."accountId" AND a."tenantId" = $1::uuid AND a."companyId" = $2::uuid
     AND a."key" = '${AR_ACCOUNT_KEY}'
    JOIN jh h ON h."jid" = l."journalEntryId"
   WHERE l."tenantId" = $1::uuid
     AND l."companyId" = $2::uuid
     AND ${gateOpen}
),
jx AS MATERIALIZED (
  SELECT f."kind" AS "fk", f."branch" AS "fbranch", f."amt" AS "amt", f."side" AS "side",
         y."jid" AS "ym", y."jcur" AS "jcur", y."lb" AS "lb", y."d" AS "d", y."c" AS "c"
    FROM fact f
    FULL JOIN jall y ON y."kind" = f."kind" AND y."sid" = f."sid"
   WHERE $3::uuid IS NULL
     AND $4::uuid IS NULL
     AND ${gateOpen}
  UNION ALL
  SELECT f."kind", f."branch", f."amt", f."side",
         ll."journalEntryId", je."currencyCode", ll."branchId", ll."debitMinor", ll."creditMinor"
    FROM fact f
    LEFT JOIN "journal_entry" je
      ON je."tenantId" = $1::uuid AND je."companyId" = $2::uuid
     AND je."sourceKind" = f."kind" AND je."sourceId" = f."sid" AND je."sealedAt" IS NOT NULL
    LEFT JOIN ("journal_line" ll
      JOIN "account" aa
        ON aa."id" = ll."accountId" AND aa."tenantId" = $1::uuid AND aa."companyId" = $2::uuid
       AND aa."key" = '${AR_ACCOUNT_KEY}')
      ON ll."journalEntryId" = je."id" AND ll."tenantId" = $1::uuid AND ll."companyId" = $2::uuid
   WHERE ($3::uuid IS NOT NULL OR $4::uuid IS NOT NULL)
     AND ${gateOpen}
),
rcc AS (
  SELECT COUNT(*) AS "n",
         COUNT(*) FILTER (WHERE r."st" NOT IN (${SOURCE_TYPE_LIST})) AS "unknownSourceTypes",
         COUNT(*) FILTER (WHERE r."principal" IS NULL) AS "unresolvedPrincipals",
         COUNT(*) FILTER (WHERE r."principal" IS NOT NULL AND r."cur" IS DISTINCT FROM co."cur") AS "currencyMismatches",
         COUNT(*) FILTER (WHERE r."srcBranch" IS DISTINCT FROM r."branch") AS "sourceBranchMismatches"
    FROM rcv r, co
),
apc AS (
  SELECT COUNT(*) AS "n",
         COUNT(*) FILTER (WHERE a."cur" IS DISTINCT FROM co."cur") AS "currencyMismatches",
         COUNT(*) FILTER (WHERE a."appBranch" IS DISTINCT FROM a."branch") AS "branchMismatches"
    FROM app a, co
),
jxc AS (
  SELECT COUNT(*) FILTER (WHERE x."fk" IS NOT NULL AND x."ym" IS NOT NULL) AS "lines",
         COUNT(*) FILTER (WHERE x."fk" IS NOT NULL AND x."ym" IS NULL) AS "missing",
         COUNT(*) FILTER (WHERE x."fk" IS NULL) AS "orphans",
         COALESCE(SUM(x."d") FILTER (WHERE x."fk" IS NULL), 0) AS "orphanD",
         COALESCE(SUM(x."c") FILTER (WHERE x."fk" IS NULL), 0) AS "orphanC",
         COUNT(*) FILTER (WHERE x."fk" IS NOT NULL AND x."ym" IS NOT NULL AND x."jcur" IS DISTINCT FROM co."cur") AS "currencyMismatches",
         COUNT(*) FILTER (WHERE x."fk" IS NOT NULL AND x."ym" IS NOT NULL
                            AND (CASE x."side" WHEN 'D' THEN x."d" = x."amt" AND x."c" = 0
                                               ELSE x."c" = x."amt" AND x."d" = 0 END) IS NOT TRUE) AS "shapeMismatches",
         COUNT(*) FILTER (WHERE x."fk" IS NOT NULL AND x."ym" IS NOT NULL AND x."lb" IS DISTINCT FROM x."fbranch") AS "branchMismatches"
    FROM jx x, co
),
glb AS (
  SELECT x."fbranch" AS "branch", COALESCE(SUM(x."d"), 0) AS "d", COALESCE(SUM(x."c"), 0) AS "c"
    FROM jx x
   WHERE x."fk" IS NOT NULL AND x."ym" IS NOT NULL
   GROUP BY x."fbranch"
),
ic AS (
  SELECT
    rcc."unknownSourceTypes" AS "unknownSourceTypes",
    rcc."unresolvedPrincipals" AS "unresolvedPrincipals",
    (SELECT COALESCE(SUM(cl."over"), 0) FROM cells cl) AS "overCoveredReceivables",
    rcc."currencyMismatches" + apc."currencyMismatches" + jxc."currencyMismatches" AS "currencyMismatchDocuments",
    rcc."sourceBranchMismatches" AS "sourceBranchMismatches",
    apc."branchMismatches" AS "applicationBranchMismatches",
    (SELECT COUNT(*) FROM "customer_receivable_payment_application" crx
       JOIN rcv r ON r."rid" = crx."customerReceivableId" AND r."st" = '${AR_SOURCE_TYPES.invoice}'
      WHERE crx."tenantId" = $1::uuid AND crx."companyId" = $2::uuid
        AND ${gateOpen}) AS "paymentApplicationsOnInvoiceReceivables",
    jxc."missing" AS "missingJournals",
    (jxc."shapeMismatches" + (jxc."lines" - ((rcc."n" + apc."n") - jxc."missing"))) AS "journalShapeMismatches",
    jxc."branchMismatches" AS "journalBranchMismatches",
    jxc."orphans" AS "orphanJournals",
    (SELECT COUNT(*) FROM "credit_note" cnx
      WHERE cnx."tenantId" = $1::uuid AND cnx."companyId" = $2::uuid
        AND cnx."arReductionMinor" > 0
        AND $4::uuid IS NULL
        AND ${gateOpen}
        AND ($3::uuid IS NULL OR cnx."branchId" = $3::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM "customer_receivable" crz
           WHERE crz."tenantId" = $1::uuid AND crz."companyId" = $2::uuid AND crz."invoiceId" = cnx."invoiceId")) AS "creditNotesWithoutReceivable"
    FROM rcc, apc, jxc
)
SELECT json_build_object(
  'asOf', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'company', (SELECT json_build_object('defaultCurrency', co."cur", 'accountingTimezone', co."tz") FROM co),
  'branchFound', (SELECT COUNT(*) FROM scope_branch),
  'customerFound', (SELECT COUNT(*) FROM scope_customer),
  'candidateReceivables', (SELECT gt."n" FROM gate gt),
  'cells', COALESCE((SELECT json_agg(json_build_object(
      'branchId', x."branch", 'sourceType', x."st", 'count', x."n",
      'originalMinor', x."orig"::text, 'paidByPaymentMinor', x."pay"::text,
      'paidByAdvanceMinor', x."adv"::text, 'creditedMinor', x."crd"::text
    ) ORDER BY x."branch", x."st") FROM cells x), '[]'::json),
  'customerCells', COALESCE((SELECT json_agg(json_build_object(
      'customerId', x."cust", 'sourceType', x."st", 'count', x."n",
      'originalMinor', x."orig"::text, 'paidByPaymentMinor', x."pay"::text,
      'paidByAdvanceMinor', x."adv"::text, 'creditedMinor', x."crd"::text
    ) ORDER BY x."cust", x."st") FROM custcells x), '[]'::json),
  'hasMore', EXISTS (SELECT 1 FROM pgn p WHERE p."rn" > $6::int),
  'gl', COALESCE((SELECT json_agg(json_build_object(
      'branchId', g."branch", 'debitMinor', g."d"::text, 'creditMinor', g."c"::text
    ) ORDER BY g."branch") FROM glb g), '[]'::json),
  'glOrphan', (SELECT json_build_object('debitMinor', c."orphanD"::text, 'creditMinor', c."orphanC"::text) FROM jxc c),
  'integrity', (SELECT json_build_object(
      'unknownSourceTypes', ic."unknownSourceTypes",
      'unresolvedPrincipals', ic."unresolvedPrincipals",
      'overCoveredReceivables', ic."overCoveredReceivables",
      'currencyMismatchDocuments', ic."currencyMismatchDocuments",
      'sourceBranchMismatches', ic."sourceBranchMismatches",
      'applicationBranchMismatches', ic."applicationBranchMismatches",
      'paymentApplicationsOnInvoiceReceivables', ic."paymentApplicationsOnInvoiceReceivables",
      'missingJournals', ic."missingJournals",
      'journalShapeMismatches', ic."journalShapeMismatches",
      'journalBranchMismatches', ic."journalBranchMismatches",
      'orphanJournals', ic."orphanJournals",
      'creditNotesWithoutReceivable', ic."creditNotesWithoutReceivable"
    ) FROM ic)
)::text AS "report"
`;
}

/** the statement at the v1 receivable limit (the exact text the repository runs) */
export const RECEIVABLES_REPORT_SQL = receivablesReportSql(RECEIVABLES_REPORT_MAX_RECEIVABLES);

export interface ReceivablesReportQuery {
  readonly text: string;
  /** `[tenantId, companyId, branchId | null, customerId | null, cursor | null, limit]` — positional parameters `$1..$6`. */
  readonly values: readonly [string, string, string | null, string | null, string | null, number];
}

export function buildReceivablesReportQuery(args: {
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string | null;
  readonly customerId: string | null;
  readonly cursor: string | null;
  readonly limit: number;
  /** the density limit (defaults to the v1 constant; only tests pass another value) */
  readonly maxReceivables?: number;
}): ReceivablesReportQuery {
  return {
    text:
      args.maxReceivables === undefined
        ? RECEIVABLES_REPORT_SQL
        : receivablesReportSql(args.maxReceivables),
    values: [
      args.tenantId,
      args.companyId,
      args.branchId,
      args.customerId,
      args.cursor,
      args.limit,
    ],
  };
}

/** The JSON document the statement returns (money as TEXT, counts as JSON integers). */
export interface ReceivablesReportJson {
  readonly asOf: string;
  readonly company: { defaultCurrency: string | null; accountingTimezone: string | null } | null;
  readonly branchFound: number;
  readonly customerFound: number;
  /** CustomerReceivable records of the EVALUATED scope, counted up to the limit + 1 (never returned to a caller) */
  readonly candidateReceivables: number;
  readonly cells: readonly {
    branchId: string;
    sourceType: string;
    count: number;
    originalMinor: string;
    paidByPaymentMinor: string;
    paidByAdvanceMinor: string;
    creditedMinor: string;
  }[];
  readonly customerCells: readonly {
    customerId: string;
    sourceType: string;
    count: number;
    originalMinor: string;
    paidByPaymentMinor: string;
    paidByAdvanceMinor: string;
    creditedMinor: string;
  }[];
  readonly hasMore: boolean;
  readonly gl: readonly { branchId: string; debitMinor: string; creditMinor: string }[];
  readonly glOrphan: { debitMinor: string; creditMinor: string };
  readonly integrity: {
    readonly unknownSourceTypes: number;
    readonly unresolvedPrincipals: number;
    readonly overCoveredReceivables: number;
    readonly currencyMismatchDocuments: number;
    readonly sourceBranchMismatches: number;
    readonly applicationBranchMismatches: number;
    readonly paymentApplicationsOnInvoiceReceivables: number;
    readonly missingJournals: number;
    readonly journalShapeMismatches: number;
    readonly journalBranchMismatches: number;
    readonly orphanJournals: number;
    readonly creditNotesWithoutReceivable: number;
  };
}
