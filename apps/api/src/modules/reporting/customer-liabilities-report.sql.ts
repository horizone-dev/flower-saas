import { ADVANCE_SOURCE_TYPES } from './customer-liabilities-report.js';

/**
 * Task 3b.10 Checkpoint E — THE customer-liabilities current-state statement: ONE read statement for the whole report — the
 * snapshot instant, both liabilities' summaries, the advance source-type breakdown, `byBranch`, the paginated per-customer
 * page and BOTH general-ledger controls — so every figure comes from ONE snapshot (`runScoped` offers no isolation-level
 * control; a multi-statement report could straddle a concurrent posting).
 *
 *   $1 tenantId   $2 companyId   $3 branchId (NULL = the whole company)   $4 customerId (NULL = every customer)
 *   $5 cursor (the last emitted customerId, NULL = the first page)        $6 page limit
 *
 * ── The frozen model (discovered in the code, never assumed) ─────────────────────────────────────────
 *
 * CUSTOMER ADVANCES — `customer_advance.sourceType` is the closed set PAYMENT | OPENING | CREDIT_NOTE (the database
 * CHECK); the branch is the advance's OWN `branchId`; the customer is reached through `customer_company_account` only:
 *   principal           `customer_advance.amountMinor`
 *   applied             Σ `customer_advance_application`            (the Advance spent on a receivable)
 *   refunded            Σ `customer_advance_refund_application`     (an ACTUAL, final Refund)
 *   reserved            Σ `refund_attempt_entitlement_reservation` of a `refund_attempt` in state 'PENDING' ONLY
 *   book liability      principal − applied − refunded     (the frozen `computeAdvanceBalance().bookedRemainingMinor`)
 *   available           book − reserved                    (the frozen `computeAdvanceBalance().availableMinor`)
 * THIS statement only sums the components, per (branch, source type); the pure module applies the frozen helper.
 *
 * UNAPPLIED RECEIPTS — per customer-attributable `payment` (the frozen attribution of
 * `PaymentCustomerAttributionRepository`: a CUSTOMER_RECEIPT attempt's own account; an INVOICE_COLLECTION attempt through its
 * invoice's order customer to the company account; a walk-in resolves to none and is in no liability):
 *   unapplied = amountMinor − Σ payment_allocation − Σ customer_receivable_payment_application
 *                           − Σ customer_advance(sourcePaymentId)       (the DB's own 3-term capacity)
 * A CustomerAdvanceApplication, a CreditNote, a Refund and a settlement NEVER consume a receipt and are not read for it.
 *
 * ── The two GL controls: ONLY the authoritative journals of each account (each producer read, not remembered) ──
 *
 *   LIABILITY.CUSTOMER_ADVANCES              sourceKind · sourceId                      producer
 *     Cr  customer_advance                   the ADVANCE id    (PAYMENT origin)         payment-advance-conversion.repository.ts
 *     Cr  opening_advance                    the ADVANCE id    (OPENING origin)         opening-balance.repository.ts
 *     Cr  credit_note                        the CREDIT NOTE id (CREDIT_NOTE origin)    orders/credit-note.repository.ts
 *     Dr  customer_advance_application       the application id                         customer-advance-application.repository.ts
 *     Dr  refund                             the REFUND id                              refund-execution / refund-attempt-reservation
 *   LIABILITY.UNAPPLIED_RECEIPTS
 *     Cr  customer_receipt_payment           the PAYMENT id                             customer-receipt-effects.repository.ts
 *     Dr  payment_allocation                 the allocation id                          customer-receipt-effects.repository.ts
 *     Dr  opening_receivable_payment_application / cancellation_charge_payment_application   the application id (same file)
 *     Dr  customer_advance                   the ADVANCE id    (the conversion — the ONE journal that moves a liability)
 * A pending reservation posts NO journal, so the advances control compares the BOOK liability — never the available figure.
 * A journal of any other kind that happens to carry a line on either account (a manual one) is not part of a control.
 * The statement proves, per source FACT, that its ONE sealed journal exists with exactly that line on the right side, in the
 * fact's branch and the company currency — and, for the unfiltered company report, that no authoritative-kind journal line
 * exists without a fact. Each control is judged on its own: the two are never netted.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────────────────────────
 *   adv / aapp / rapp / rsv     the advances in scope, and their applications, refund applications and PENDING reservations
 *   advr · acells · acust       each advance with its three summed components · the (branch, source type) and per-customer cells
 *   pay · palloc · pcrpa · pconv   the attributable Payments in scope and every draw on them (allocation, receivable
 *                               application, conversion to an Advance) — set-based, one read per source table
 *   payr · pcells · pcust       each Payment with its three draws · the per-branch and per-customer cells
 *   fact                        every source fact of BOTH controls, tagged with its account ('A' advances, 'U' unapplied)
 *   jh / jall                   (unfiltered company report only) the headers of every authoritative-kind sealed journal and
 *                               their lines on the two liability accounts — a hash join, never one probe per line
 *   jx                          THE RECONCILIATION: ONE join of the facts against the lines on (account, sourceKind,
 *                               sourceId). Unfiltered it is a FULL OUTER JOIN: matched · fact-only (a MISSING journal) ·
 *                               line-only (an ORPHAN journal). A branch / customer report is fact-driven: the facts LEFT
 *                               JOINed to their own journal and line (one unique-index probe per fact)
 *   jxc · glb · ic              the counters per control · the GL liability per (control, branch) · the integrity counters
 *
 * Explicit tenant + company (+ branch) predicates on EVERY table touched — the report never relies on RLS or the branch GUC.
 * Money is exact: every sum leaves the database as TEXT. Counts are JSON integers. No FX, no float. No customer name, phone,
 * e-mail or address is ever read.
 */
export const LIABILITY_ACCOUNT_KEYS = {
  advances: 'LIABILITY.CUSTOMER_ADVANCES',
  unapplied: 'LIABILITY.UNAPPLIED_RECEIPTS',
} as const;

/** the journal kinds of the CUSTOMER_ADVANCES control — exactly these, no other */
export const ADVANCE_JOURNAL_KINDS = {
  conversion: 'customer_advance',
  opening: 'opening_advance',
  creditNote: 'credit_note',
  application: 'customer_advance_application',
  refund: 'refund',
} as const;

/** the journal kinds of the UNAPPLIED_RECEIPTS control — exactly these, no other */
export const UNAPPLIED_JOURNAL_KINDS = {
  receipt: 'customer_receipt_payment',
  allocation: 'payment_allocation',
  openingApplication: 'opening_receivable_payment_application',
  chargeApplication: 'cancellation_charge_payment_application',
  conversion: 'customer_advance',
} as const;

const quoted = (kinds: Record<string, string>): string =>
  Object.values(kinds)
    .map((k) => `'${k}'`)
    .join(', ');
const ADVANCE_KIND_LIST = quoted(ADVANCE_JOURNAL_KINDS);
const UNAPPLIED_KIND_LIST = quoted(UNAPPLIED_JOURNAL_KINDS);
const ALL_KIND_LIST = [
  ...new Set([...Object.values(ADVANCE_JOURNAL_KINDS), ...Object.values(UNAPPLIED_JOURNAL_KINDS)]),
]
  .map((k) => `'${k}'`)
  .join(', ');
const SOURCE_TYPE_LIST = ADVANCE_SOURCE_TYPES.map((t) => `'${t}'`).join(', ');
const ADV = LIABILITY_ACCOUNT_KEYS.advances;
const UNAPPLIED = LIABILITY_ACCOUNT_KEYS.unapplied;

/**
 * THE DENSITY GUARD — Customer Liabilities v1 (owner ruling EL-1).
 *
 * NO calendar cap, NO historical `asOf`, NO aging. At most `CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS` LIABILITY ROOT RECORDS in
 * the ACTUAL EVALUATED SCOPE, where a root is exactly ONE customer-attributable `payment` (the frozen attribution — a
 * CUSTOMER_RECEIPT attempt's own account, an INVOICE_COLLECTION attempt through its invoice's order customer; a walk-in is no
 * root) or ONE `customer_advance`. The two source families are bounded TOGETHER; a Payment-derived Advance is TWO roots (the
 * Payment and the Advance — never de-duplicated). A PaymentAllocation, a receivable payment application, an Advance
 * application, a refund application, a Refund, a refund attempt / reservation, a CreditNote and a settlement are NEVER roots
 * (they are dependent facts, fully evaluated for an accepted report) and neither is a journal row. The scope is the company,
 * or the requested branch (sibling branches never contribute), or the customer filter after its company / branch scope: the
 * gate applies EXACTLY the predicates `adv` and `pay` apply (tenant, company, `$3` branch, `$4` customer through
 * `customer_company_account`) and nothing else.
 *
 * It is the FIRST stage of the same statement — never a separate COUNT: `gate` reads at most limit + 1 roots of the scope (an
 * early-stopped scan of the three root legs) and counts them. EVERY stage that reads a heavy relation carries `gateOpen` — a
 * One-Time Filter above its joins — so above the limit none of them executes under any join method: the advances (`adv`),
 * their applications / refund applications / PENDING reservations, the Payments (both attribution legs) and their allocations
 * / receivable applications / conversions, the CreditNote release reads, the journal headers and lines (`jh`, `jall`, `jx`)
 * and the integrity counter that reads a base table; the aggregates, `byBranch`, the customer page and both GL
 * reconciliations all derive from those and are empty. The repository rejects from `candidateRoots`
 * (REPORT_RESULT_TOO_LARGE, 422) before it reads anything else; the figure itself is never disclosed.
 */
export const CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS = 100_000;

function customerLiabilitiesReportSql(maxRoots: number): string {
  if (!Number.isSafeInteger(maxRoots) || maxRoots < 0) {
    throw new RangeError(
      'the customer-liabilities report root limit must be a non-negative integer',
    );
  }
  // the ONE gate comparison: `gate` counted at most limit + 1 roots; above the limit every stage that carries this
  // predicate is skipped as a whole (a One-Time Filter above its joins)
  const gateOpen = `(SELECT gt."n" FROM gate gt) <= ${maxRoots}`;
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
        FROM (
          SELECT 1
            FROM "customer_advance" cg
            JOIN "customer_company_account" xg
              ON xg."id" = cg."customerCompanyAccountId" AND xg."tenantId" = $1::uuid AND xg."companyId" = $2::uuid
           WHERE cg."tenantId" = $1::uuid
             AND cg."companyId" = $2::uuid
             AND ($3::uuid IS NULL OR cg."branchId" = $3::uuid)
             AND ($4::uuid IS NULL OR xg."customerId" = $4::uuid)
          UNION ALL
          SELECT 1
            FROM "payment" pg
            JOIN "payment_attempt" pag
              ON pag."id" = pg."sourceAttemptId" AND pag."tenantId" = $1::uuid AND pag."companyId" = $2::uuid
             AND pag."receiptPurpose" = 'CUSTOMER_RECEIPT'
            JOIN "customer_company_account" xpg
              ON xpg."id" = pag."customerCompanyAccountId" AND xpg."tenantId" = $1::uuid AND xpg."companyId" = $2::uuid
           WHERE pg."tenantId" = $1::uuid
             AND pg."companyId" = $2::uuid
             AND ($3::uuid IS NULL OR pg."branchId" = $3::uuid)
             AND ($4::uuid IS NULL OR xpg."customerId" = $4::uuid)
          UNION ALL
          SELECT 1
            FROM "payment" qg
            JOIN "payment_attempt" qag
              ON qag."id" = qg."sourceAttemptId" AND qag."tenantId" = $1::uuid AND qag."companyId" = $2::uuid
             AND qag."receiptPurpose" = 'INVOICE_COLLECTION'
            JOIN "invoice" ig
              ON ig."id" = qag."targetInvoiceId" AND ig."tenantId" = $1::uuid AND ig."companyId" = $2::uuid
            JOIN "order" og
              ON og."id" = ig."orderId" AND og."tenantId" = $1::uuid AND og."companyId" = $2::uuid
            JOIN "customer_company_account" xqg
              ON xqg."tenantId" = $1::uuid AND xqg."companyId" = $2::uuid AND xqg."customerId" = og."customerId"
           WHERE qg."tenantId" = $1::uuid
             AND qg."companyId" = $2::uuid
             AND ($3::uuid IS NULL OR qg."branchId" = $3::uuid)
             AND ($4::uuid IS NULL OR xqg."customerId" = $4::uuid)
        ) roots
       LIMIT ${maxRoots + 1}
    ) gs
),
adv AS MATERIALIZED (
  SELECT ca."id" AS "aid", ca."branchId" AS "branch", ca."sourceType" AS "st", ca."amountMinor" AS "amt",
         ca."currencyCode" AS "cur", ca."sourcePaymentId" AS "spid", x."customerId" AS "cust"
    FROM "customer_advance" ca
    JOIN "customer_company_account" x
      ON x."id" = ca."customerCompanyAccountId" AND x."tenantId" = $1::uuid AND x."companyId" = $2::uuid
   WHERE ca."tenantId" = $1::uuid
     AND ca."companyId" = $2::uuid
     AND ($3::uuid IS NULL OR ca."branchId" = $3::uuid)
     AND ($4::uuid IS NULL OR x."customerId" = $4::uuid)
     AND ${gateOpen}
),
aapp AS MATERIALIZED (
  SELECT caa."id" AS "id", a."aid" AS "aid", caa."amountMinor" AS "amt", caa."currencyCode" AS "cur",
         caa."branchId" AS "appBranch", a."branch" AS "branch"
    FROM "customer_advance_application" caa
    JOIN adv a ON a."aid" = caa."customerAdvanceId"
   WHERE caa."tenantId" = $1::uuid
     AND caa."companyId" = $2::uuid
     AND ${gateOpen}
),
rapp AS MATERIALIZED (
  SELECT cra."id" AS "id", cra."refundId" AS "refundId", a."aid" AS "aid", cra."amountMinor" AS "amt",
         cra."currencyCode" AS "cur", cra."branchId" AS "appBranch", a."branch" AS "branch"
    FROM "customer_advance_refund_application" cra
    JOIN adv a ON a."aid" = cra."customerAdvanceId"
   WHERE cra."tenantId" = $1::uuid
     AND cra."companyId" = $2::uuid
     AND ${gateOpen}
),
rsv AS MATERIALIZED (
  SELECT rr."id" AS "id", a."aid" AS "aid", rr."amountMinor" AS "amt", rr."currencyCode" AS "cur",
         rr."branchId" AS "appBranch", a."branch" AS "branch"
    FROM "refund_attempt_entitlement_reservation" rr
    JOIN "refund_attempt" ra
      ON ra."id" = rr."refundAttemptId" AND ra."tenantId" = $1::uuid AND ra."companyId" = $2::uuid AND ra."state" = 'PENDING'
    JOIN adv a ON a."aid" = rr."customerAdvanceId"
   WHERE rr."tenantId" = $1::uuid
     AND rr."companyId" = $2::uuid
     AND ${gateOpen}
),
aapp_s AS (SELECT p."aid" AS "aid", SUM(p."amt") AS "s" FROM aapp p GROUP BY p."aid"),
rapp_s AS (SELECT p."aid" AS "aid", SUM(p."amt") AS "s" FROM rapp p GROUP BY p."aid"),
rsv_s AS (SELECT p."aid" AS "aid", SUM(p."amt") AS "s" FROM rsv p GROUP BY p."aid"),
advr AS (
  SELECT a."aid" AS "aid", a."branch" AS "branch", a."st" AS "st", a."cust" AS "cust", a."amt" AS "amt",
         COALESCE(ap."s", 0) AS "applied", COALESCE(rp."s", 0) AS "refunded", COALESCE(rs."s", 0) AS "reserved",
         a."amt" - COALESCE(ap."s", 0) - COALESCE(rp."s", 0) AS "book",
         a."amt" - COALESCE(ap."s", 0) - COALESCE(rp."s", 0) - COALESCE(rs."s", 0) AS "avail"
    FROM adv a
    LEFT JOIN aapp_s ap ON ap."aid" = a."aid"
    LEFT JOIN rapp_s rp ON rp."aid" = a."aid"
    LEFT JOIN rsv_s rs ON rs."aid" = a."aid"
),
acells AS (
  SELECT r."branch" AS "branch", r."st" AS "st", COUNT(*) AS "n", COALESCE(SUM(r."amt"), 0) AS "orig",
         COALESCE(SUM(r."applied"), 0) AS "applied", COALESCE(SUM(r."refunded"), 0) AS "refunded",
         COALESCE(SUM(r."reserved"), 0) AS "reserved",
         COUNT(*) FILTER (WHERE r."book" < 0) AS "over",
         COUNT(*) FILTER (WHERE r."book" >= 0 AND r."avail" < 0) AS "beyond"
    FROM advr r
   GROUP BY r."branch", r."st"
),
pay AS MATERIALIZED (
  SELECT p."id" AS "pid", p."branchId" AS "branch", p."amountMinor" AS "amt", p."currencyCode" AS "cur", x."customerId" AS "cust"
    FROM "payment" p
    JOIN "payment_attempt" pa
      ON pa."id" = p."sourceAttemptId" AND pa."tenantId" = $1::uuid AND pa."companyId" = $2::uuid
     AND pa."receiptPurpose" = 'CUSTOMER_RECEIPT'
    JOIN "customer_company_account" x
      ON x."id" = pa."customerCompanyAccountId" AND x."tenantId" = $1::uuid AND x."companyId" = $2::uuid
   WHERE p."tenantId" = $1::uuid
     AND p."companyId" = $2::uuid
     AND ($3::uuid IS NULL OR p."branchId" = $3::uuid)
     AND ($4::uuid IS NULL OR x."customerId" = $4::uuid)
     AND ${gateOpen}
  UNION ALL
  SELECT p."id", p."branchId", p."amountMinor", p."currencyCode", x."customerId"
    FROM "payment" p
    JOIN "payment_attempt" pa
      ON pa."id" = p."sourceAttemptId" AND pa."tenantId" = $1::uuid AND pa."companyId" = $2::uuid
     AND pa."receiptPurpose" = 'INVOICE_COLLECTION'
    JOIN "invoice" i
      ON i."id" = pa."targetInvoiceId" AND i."tenantId" = $1::uuid AND i."companyId" = $2::uuid
    JOIN "order" o
      ON o."id" = i."orderId" AND o."tenantId" = $1::uuid AND o."companyId" = $2::uuid
    JOIN "customer_company_account" x
      ON x."tenantId" = $1::uuid AND x."companyId" = $2::uuid AND x."customerId" = o."customerId"
   WHERE p."tenantId" = $1::uuid
     AND p."companyId" = $2::uuid
     AND ($3::uuid IS NULL OR p."branchId" = $3::uuid)
     AND ($4::uuid IS NULL OR x."customerId" = $4::uuid)
     AND ${gateOpen}
),
palloc AS MATERIALIZED (
  SELECT al."id" AS "id", p."pid" AS "pid", al."amountMinor" AS "amt", al."currencyCode" AS "cur",
         al."branchId" AS "appBranch", p."branch" AS "branch"
    FROM "payment_allocation" al
    JOIN pay p ON p."pid" = al."paymentId"
   WHERE al."tenantId" = $1::uuid
     AND al."companyId" = $2::uuid
     AND ${gateOpen}
),
pcrpa AS MATERIALIZED (
  SELECT rp."id" AS "id", p."pid" AS "pid", rp."amountMinor" AS "amt", rp."currencyCode" AS "cur",
         rp."branchId" AS "appBranch", p."branch" AS "branch", rc."sourceType" AS "rst"
    FROM "customer_receivable_payment_application" rp
    JOIN pay p ON p."pid" = rp."paymentId"
    JOIN "customer_receivable" rc
      ON rc."id" = rp."customerReceivableId" AND rc."tenantId" = $1::uuid AND rc."companyId" = $2::uuid
   WHERE rp."tenantId" = $1::uuid
     AND rp."companyId" = $2::uuid
     AND ${gateOpen}
),
pconv AS MATERIALIZED (
  SELECT cv."id" AS "id", p."pid" AS "pid", cv."amountMinor" AS "amt", cv."currencyCode" AS "cur",
         cv."branchId" AS "appBranch", p."branch" AS "branch"
    FROM "customer_advance" cv
    JOIN pay p ON p."pid" = cv."sourcePaymentId"
   WHERE cv."tenantId" = $1::uuid
     AND cv."companyId" = $2::uuid
     AND ${gateOpen}
),
palloc_s AS (SELECT x."pid" AS "pid", SUM(x."amt") AS "s" FROM palloc x GROUP BY x."pid"),
pcrpa_s AS (SELECT x."pid" AS "pid", SUM(x."amt") AS "s" FROM pcrpa x GROUP BY x."pid"),
pconv_s AS (SELECT x."pid" AS "pid", SUM(x."amt") AS "s" FROM pconv x GROUP BY x."pid"),
payr AS (
  SELECT p."pid" AS "pid", p."branch" AS "branch", p."cust" AS "cust", p."amt" AS "amt",
         COALESCE(al."s", 0) AS "alloc", COALESCE(rp."s", 0) AS "rapp", COALESCE(cv."s", 0) AS "conv",
         p."amt" - COALESCE(al."s", 0) - COALESCE(rp."s", 0) - COALESCE(cv."s", 0) AS "unapplied"
    FROM pay p
    LEFT JOIN palloc_s al ON al."pid" = p."pid"
    LEFT JOIN pcrpa_s rp ON rp."pid" = p."pid"
    LEFT JOIN pconv_s cv ON cv."pid" = p."pid"
),
pcells AS (
  SELECT r."branch" AS "branch", COUNT(*) AS "n", COUNT(*) FILTER (WHERE r."unapplied" > 0) AS "nw",
         COALESCE(SUM(r."amt"), 0) AS "orig", COALESCE(SUM(r."alloc"), 0) AS "alloc",
         COALESCE(SUM(r."rapp"), 0) AS "rapp", COALESCE(SUM(r."conv"), 0) AS "conv",
         COUNT(*) FILTER (WHERE r."unapplied" < 0) AS "over"
    FROM payr r
   GROUP BY r."branch"
),
pg AS (
  SELECT DISTINCT u."cust" AS "cust"
    FROM (SELECT a."cust" AS "cust" FROM advr a UNION ALL SELECT p."cust" AS "cust" FROM payr p) u
   WHERE ($5::uuid IS NULL OR u."cust" > $5::uuid)
   ORDER BY u."cust"
   LIMIT ($6::int + 1)
),
pgn AS (
  SELECT p."cust" AS "cust", row_number() OVER (ORDER BY p."cust") AS "rn"
    FROM pg p
),
acust AS (
  SELECT r."cust" AS "cust", r."st" AS "st", COUNT(*) AS "n", COALESCE(SUM(r."amt"), 0) AS "orig",
         COALESCE(SUM(r."applied"), 0) AS "applied", COALESCE(SUM(r."refunded"), 0) AS "refunded",
         COALESCE(SUM(r."reserved"), 0) AS "reserved"
    FROM advr r
    JOIN pgn p ON p."cust" = r."cust" AND p."rn" <= $6::int
   GROUP BY r."cust", r."st"
),
pcust AS (
  SELECT r."cust" AS "cust", COUNT(*) AS "n", COUNT(*) FILTER (WHERE r."unapplied" > 0) AS "nw",
         COALESCE(SUM(r."amt"), 0) AS "orig", COALESCE(SUM(r."alloc"), 0) AS "alloc",
         COALESCE(SUM(r."rapp"), 0) AS "rapp", COALESCE(SUM(r."conv"), 0) AS "conv"
    FROM payr r
    JOIN pgn p ON p."cust" = r."cust" AND p."rn" <= $6::int
   GROUP BY r."cust"
),
fact AS MATERIALIZED (
  SELECT 'A'::text AS "acct",
         CASE a."st" WHEN 'PAYMENT' THEN '${ADVANCE_JOURNAL_KINDS.conversion}' WHEN 'OPENING' THEN '${ADVANCE_JOURNAL_KINDS.opening}' END AS "kind",
         a."aid"::text AS "sid", a."branch" AS "branch", a."amt" AS "amt", 'C'::text AS "side"
    FROM adv a
   WHERE a."st" IN ('PAYMENT', 'OPENING')
  UNION ALL
  SELECT 'A', '${ADVANCE_JOURNAL_KINDS.creditNote}', rel."creditNoteId"::text, a."branch", SUM(a."amt"), 'C'
    FROM adv a
    JOIN "credit_note_coverage_release" rel
      ON rel."customerAdvanceId" = a."aid" AND rel."tenantId" = $1::uuid AND rel."companyId" = $2::uuid
   WHERE a."st" = 'CREDIT_NOTE'
     AND ${gateOpen}
   GROUP BY rel."creditNoteId", a."branch"
  UNION ALL
  SELECT 'A', '${ADVANCE_JOURNAL_KINDS.application}', p."id"::text, p."branch", p."amt", 'D' FROM aapp p
  UNION ALL
  SELECT 'A', '${ADVANCE_JOURNAL_KINDS.refund}', r."refundId"::text, r."branch", SUM(r."amt"), 'D'
    FROM rapp r
   GROUP BY r."refundId", r."branch"
  UNION ALL
  SELECT 'U', '${UNAPPLIED_JOURNAL_KINDS.receipt}', p."pid"::text, p."branch", p."amt", 'C' FROM pay p
  UNION ALL
  SELECT 'U', '${UNAPPLIED_JOURNAL_KINDS.allocation}', x."id"::text, x."branch", x."amt", 'D' FROM palloc x
  UNION ALL
  SELECT 'U',
         CASE x."rst" WHEN 'OPENING' THEN '${UNAPPLIED_JOURNAL_KINDS.openingApplication}' ELSE '${UNAPPLIED_JOURNAL_KINDS.chargeApplication}' END,
         x."id"::text, x."branch", x."amt", 'D'
    FROM pcrpa x
  UNION ALL
  SELECT 'U', '${UNAPPLIED_JOURNAL_KINDS.conversion}', v."id"::text, v."branch", v."amt", 'D' FROM pconv v
),
jh AS MATERIALIZED (
  SELECT je."id" AS "jid", je."sourceKind" AS "kind", je."sourceId" AS "sid", je."currencyCode" AS "jcur"
    FROM "journal_entry" je
   WHERE je."tenantId" = $1::uuid
     AND je."companyId" = $2::uuid
     AND je."sealedAt" IS NOT NULL
     AND je."sourceKind" IN (${ALL_KIND_LIST})
     AND $3::uuid IS NULL
     AND $4::uuid IS NULL
     AND ${gateOpen}
),
jall AS MATERIALIZED (
  SELECT CASE a."key" WHEN '${ADV}' THEN 'A' ELSE 'U' END AS "acct", h."kind" AS "kind", h."sid" AS "sid",
         h."jcur" AS "jcur", h."jid" AS "jid", l."branchId" AS "lb", l."debitMinor" AS "d", l."creditMinor" AS "c"
    FROM "journal_line" l
    JOIN "account" a
      ON a."id" = l."accountId" AND a."tenantId" = $1::uuid AND a."companyId" = $2::uuid
     AND a."key" IN ('${ADV}', '${UNAPPLIED}')
    JOIN jh h ON h."jid" = l."journalEntryId"
   WHERE l."tenantId" = $1::uuid
     AND l."companyId" = $2::uuid
     AND ((a."key" = '${ADV}' AND h."kind" IN (${ADVANCE_KIND_LIST}))
       OR (a."key" = '${UNAPPLIED}' AND h."kind" IN (${UNAPPLIED_KIND_LIST})))
     AND ${gateOpen}
),
jx AS MATERIALIZED (
  SELECT COALESCE(f."acct", y."acct") AS "ra", f."kind" AS "fk", f."branch" AS "fbranch", f."amt" AS "amt", f."side" AS "side",
         y."jid" AS "ym", y."jcur" AS "jcur", y."lb" AS "lb", y."d" AS "d", y."c" AS "c"
    FROM fact f
    FULL JOIN jall y ON y."acct" = f."acct" AND y."kind" = f."kind" AND y."sid" = f."sid"
   WHERE $3::uuid IS NULL
     AND $4::uuid IS NULL
     AND ${gateOpen}
  UNION ALL
  SELECT f."acct", f."kind", f."branch", f."amt", f."side",
         ll."journalEntryId", je."currencyCode", ll."branchId", ll."debitMinor", ll."creditMinor"
    FROM fact f
    LEFT JOIN "journal_entry" je
      ON je."tenantId" = $1::uuid AND je."companyId" = $2::uuid
     AND je."sourceKind" = f."kind" AND je."sourceId" = f."sid" AND je."sealedAt" IS NOT NULL
    LEFT JOIN ("journal_line" ll
      JOIN "account" aa
        ON aa."id" = ll."accountId" AND aa."tenantId" = $1::uuid AND aa."companyId" = $2::uuid)
      ON ll."journalEntryId" = je."id" AND ll."tenantId" = $1::uuid AND ll."companyId" = $2::uuid
     AND aa."key" = CASE f."acct" WHEN 'A' THEN '${ADV}' ELSE '${UNAPPLIED}' END
   WHERE ($3::uuid IS NOT NULL OR $4::uuid IS NOT NULL)
     AND ${gateOpen}
),
fcount AS (SELECT f."acct" AS "ra", COUNT(*) AS "n" FROM fact f GROUP BY f."acct"),
jxc AS (
  SELECT x."ra" AS "ra",
         COUNT(*) FILTER (WHERE x."fk" IS NOT NULL AND x."ym" IS NOT NULL) AS "lines",
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
   GROUP BY x."ra"
),
glb AS (
  SELECT x."ra" AS "ra", x."fbranch" AS "branch", COALESCE(SUM(x."d"), 0) AS "d", COALESCE(SUM(x."c"), 0) AS "c"
    FROM jx x
   WHERE x."fk" IS NOT NULL AND x."ym" IS NOT NULL
   GROUP BY x."ra", x."fbranch"
),
ic AS (
  SELECT
    (SELECT COUNT(*) FROM adv a WHERE a."st" NOT IN (${SOURCE_TYPE_LIST})) AS "advanceUnknownSourceTypes",
    (SELECT COALESCE(SUM(c."over"), 0) FROM acells c) AS "advanceOverConsumed",
    (SELECT COALESCE(SUM(c."beyond"), 0) FROM acells c) AS "advanceReservationBeyondAvailable",
    (SELECT COUNT(*) FROM aapp p WHERE p."appBranch" IS DISTINCT FROM p."branch") AS "advanceApplicationBranchMismatches",
    (SELECT COUNT(*) FROM rapp p WHERE p."appBranch" IS DISTINCT FROM p."branch") AS "advanceRefundApplicationBranchMismatches",
    (SELECT COUNT(*) FROM rsv p WHERE p."appBranch" IS DISTINCT FROM p."branch") AS "advanceReservationBranchMismatches",
    (SELECT COUNT(*) FROM adv a LEFT JOIN pay p ON p."pid" = a."spid" WHERE a."st" = 'PAYMENT' AND p."pid" IS NULL) AS "paymentAdvancesWithoutPayment",
    (SELECT COUNT(*) FROM adv a
       LEFT JOIN "credit_note_coverage_release" rl
         ON rl."customerAdvanceId" = a."aid" AND rl."tenantId" = $1::uuid AND rl."companyId" = $2::uuid
      WHERE a."st" = 'CREDIT_NOTE' AND rl."id" IS NULL
        AND ${gateOpen}) AS "creditNoteAdvancesWithoutRelease",
    (SELECT COALESCE(SUM(c."over"), 0) FROM pcells c) AS "paymentOverConsumed",
    (SELECT COUNT(*) FROM palloc p WHERE p."appBranch" IS DISTINCT FROM p."branch") AS "allocationBranchMismatches",
    (SELECT COUNT(*) FROM pcrpa p WHERE p."appBranch" IS DISTINCT FROM p."branch") AS "receivablePaymentApplicationBranchMismatches",
    (SELECT COUNT(*) FROM pconv p WHERE p."appBranch" IS DISTINCT FROM p."branch") AS "paymentAdvanceBranchMismatches",
    (SELECT COUNT(*) FROM adv a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COUNT(*) FROM aapp a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COUNT(*) FROM rapp a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COUNT(*) FROM rsv a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COUNT(*) FROM pay a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COUNT(*) FROM palloc a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COUNT(*) FROM pcrpa a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COUNT(*) FROM pconv a, co WHERE a."cur" IS DISTINCT FROM co."cur")
      + (SELECT COALESCE(SUM(j."currencyMismatches"), 0) FROM jxc j) AS "currencyMismatchDocuments",
    (SELECT COALESCE(SUM(j."missing"), 0) FROM jxc j WHERE j."ra" = 'A') AS "advanceMissingJournals",
    (SELECT COALESCE(SUM(j."shapeMismatches"), 0) FROM jxc j WHERE j."ra" = 'A')
      + (SELECT COALESCE(SUM(j."lines"), 0) FROM jxc j WHERE j."ra" = 'A')
      - ((SELECT COALESCE(SUM(n."n"), 0) FROM fcount n WHERE n."ra" = 'A')
         - (SELECT COALESCE(SUM(j."missing"), 0) FROM jxc j WHERE j."ra" = 'A')) AS "advanceJournalShapeMismatches",
    (SELECT COALESCE(SUM(j."branchMismatches"), 0) FROM jxc j WHERE j."ra" = 'A') AS "advanceJournalBranchMismatches",
    (SELECT COALESCE(SUM(j."orphans"), 0) FROM jxc j WHERE j."ra" = 'A') AS "advanceOrphanJournals",
    (SELECT COALESCE(SUM(j."missing"), 0) FROM jxc j WHERE j."ra" = 'U') AS "unappliedMissingJournals",
    (SELECT COALESCE(SUM(j."shapeMismatches"), 0) FROM jxc j WHERE j."ra" = 'U')
      + (SELECT COALESCE(SUM(j."lines"), 0) FROM jxc j WHERE j."ra" = 'U')
      - ((SELECT COALESCE(SUM(n."n"), 0) FROM fcount n WHERE n."ra" = 'U')
         - (SELECT COALESCE(SUM(j."missing"), 0) FROM jxc j WHERE j."ra" = 'U')) AS "unappliedJournalShapeMismatches",
    (SELECT COALESCE(SUM(j."branchMismatches"), 0) FROM jxc j WHERE j."ra" = 'U') AS "unappliedJournalBranchMismatches",
    (SELECT COALESCE(SUM(j."orphans"), 0) FROM jxc j WHERE j."ra" = 'U') AS "unappliedOrphanJournals"
)
SELECT json_build_object(
  'asOf', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'company', (SELECT json_build_object('defaultCurrency', co."cur", 'accountingTimezone', co."tz") FROM co),
  'branchFound', (SELECT COUNT(*) FROM scope_branch),
  'customerFound', (SELECT COUNT(*) FROM scope_customer),
  'candidateRoots', (SELECT gt."n" FROM gate gt),
  'advanceCells', COALESCE((SELECT json_agg(json_build_object(
      'branchId', x."branch", 'sourceType', x."st", 'count', x."n",
      'originalMinor', x."orig"::text, 'appliedMinor', x."applied"::text,
      'refundedMinor', x."refunded"::text, 'reservedMinor', x."reserved"::text
    ) ORDER BY x."branch", x."st") FROM acells x), '[]'::json),
  'unappliedCells', COALESCE((SELECT json_agg(json_build_object(
      'branchId', x."branch", 'paymentCount', x."n", 'paymentCountWithUnapplied', x."nw",
      'originalMinor', x."orig"::text, 'allocatedMinor', x."alloc"::text,
      'receivableAppliedMinor', x."rapp"::text, 'convertedMinor', x."conv"::text
    ) ORDER BY x."branch") FROM pcells x), '[]'::json),
  'advanceCustomerCells', COALESCE((SELECT json_agg(json_build_object(
      'customerId', x."cust", 'sourceType', x."st", 'count', x."n",
      'originalMinor', x."orig"::text, 'appliedMinor', x."applied"::text,
      'refundedMinor', x."refunded"::text, 'reservedMinor', x."reserved"::text
    ) ORDER BY x."cust", x."st") FROM acust x), '[]'::json),
  'unappliedCustomerCells', COALESCE((SELECT json_agg(json_build_object(
      'customerId', x."cust", 'paymentCount', x."n", 'paymentCountWithUnapplied', x."nw",
      'originalMinor', x."orig"::text, 'allocatedMinor', x."alloc"::text,
      'receivableAppliedMinor', x."rapp"::text, 'convertedMinor', x."conv"::text
    ) ORDER BY x."cust") FROM pcust x), '[]'::json),
  'hasMore', EXISTS (SELECT 1 FROM pgn p WHERE p."rn" > $6::int),
  'gl', COALESCE((SELECT json_agg(json_build_object(
      'control', g."ra", 'branchId', g."branch", 'debitMinor', g."d"::text, 'creditMinor', g."c"::text
    ) ORDER BY g."ra", g."branch") FROM glb g), '[]'::json),
  'glOrphan', json_build_object(
      'advances', json_build_object(
        'debitMinor', (SELECT COALESCE(SUM(j."orphanD"), 0) FROM jxc j WHERE j."ra" = 'A')::text,
        'creditMinor', (SELECT COALESCE(SUM(j."orphanC"), 0) FROM jxc j WHERE j."ra" = 'A')::text),
      'unapplied', json_build_object(
        'debitMinor', (SELECT COALESCE(SUM(j."orphanD"), 0) FROM jxc j WHERE j."ra" = 'U')::text,
        'creditMinor', (SELECT COALESCE(SUM(j."orphanC"), 0) FROM jxc j WHERE j."ra" = 'U')::text)),
  'integrity', (SELECT json_build_object(
      'advanceUnknownSourceTypes', ic."advanceUnknownSourceTypes",
      'advanceOverConsumed', ic."advanceOverConsumed",
      'advanceReservationBeyondAvailable', ic."advanceReservationBeyondAvailable",
      'advanceApplicationBranchMismatches', ic."advanceApplicationBranchMismatches",
      'advanceRefundApplicationBranchMismatches', ic."advanceRefundApplicationBranchMismatches",
      'advanceReservationBranchMismatches', ic."advanceReservationBranchMismatches",
      'paymentAdvancesWithoutPayment', ic."paymentAdvancesWithoutPayment",
      'creditNoteAdvancesWithoutRelease', ic."creditNoteAdvancesWithoutRelease",
      'paymentOverConsumed', ic."paymentOverConsumed",
      'allocationBranchMismatches', ic."allocationBranchMismatches",
      'receivablePaymentApplicationBranchMismatches', ic."receivablePaymentApplicationBranchMismatches",
      'paymentAdvanceBranchMismatches', ic."paymentAdvanceBranchMismatches",
      'currencyMismatchDocuments', ic."currencyMismatchDocuments",
      'advanceMissingJournals', ic."advanceMissingJournals",
      'advanceJournalShapeMismatches', ic."advanceJournalShapeMismatches",
      'advanceJournalBranchMismatches', ic."advanceJournalBranchMismatches",
      'advanceOrphanJournals', ic."advanceOrphanJournals",
      'unappliedMissingJournals', ic."unappliedMissingJournals",
      'unappliedJournalShapeMismatches', ic."unappliedJournalShapeMismatches",
      'unappliedJournalBranchMismatches', ic."unappliedJournalBranchMismatches",
      'unappliedOrphanJournals', ic."unappliedOrphanJournals"
    ) FROM ic)
)::text AS "report"
`;
}

export const CUSTOMER_LIABILITIES_REPORT_SQL = customerLiabilitiesReportSql(
  CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS,
);

export interface CustomerLiabilitiesReportQuery {
  readonly text: string;
  /** `[tenantId, companyId, branchId | null, customerId | null, cursor | null, limit]` — positional parameters `$1..$6`. */
  readonly values: readonly [string, string, string | null, string | null, string | null, number];
}

export function buildCustomerLiabilitiesReportQuery(args: {
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string | null;
  readonly customerId: string | null;
  readonly cursor: string | null;
  readonly limit: number;
  /** the density limit (defaults to the v1 constant; only tests pass another value) */
  readonly maxRoots?: number;
}): CustomerLiabilitiesReportQuery {
  return {
    text:
      args.maxRoots === undefined
        ? CUSTOMER_LIABILITIES_REPORT_SQL
        : customerLiabilitiesReportSql(args.maxRoots),
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
export interface CustomerLiabilitiesReportJson {
  readonly asOf: string;
  readonly company: { defaultCurrency: string | null; accountingTimezone: string | null } | null;
  readonly branchFound: number;
  readonly customerFound: number;
  /** liability roots (Payments + Advances) of the EVALUATED scope, counted up to the limit + 1 (never returned to a caller) */
  readonly candidateRoots: number;
  readonly advanceCells: readonly {
    branchId: string;
    sourceType: string;
    count: number;
    originalMinor: string;
    appliedMinor: string;
    refundedMinor: string;
    reservedMinor: string;
  }[];
  readonly unappliedCells: readonly {
    branchId: string;
    paymentCount: number;
    paymentCountWithUnapplied: number;
    originalMinor: string;
    allocatedMinor: string;
    receivableAppliedMinor: string;
    convertedMinor: string;
  }[];
  readonly advanceCustomerCells: readonly {
    customerId: string;
    sourceType: string;
    count: number;
    originalMinor: string;
    appliedMinor: string;
    refundedMinor: string;
    reservedMinor: string;
  }[];
  readonly unappliedCustomerCells: readonly {
    customerId: string;
    paymentCount: number;
    paymentCountWithUnapplied: number;
    originalMinor: string;
    allocatedMinor: string;
    receivableAppliedMinor: string;
    convertedMinor: string;
  }[];
  readonly hasMore: boolean;
  /** the GL lines of the matched journals, per control ('A' advances, 'U' unapplied) and branch */
  readonly gl: readonly {
    control: 'A' | 'U';
    branchId: string;
    debitMinor: string;
    creditMinor: string;
  }[];
  readonly glOrphan: {
    readonly advances: { debitMinor: string; creditMinor: string };
    readonly unapplied: { debitMinor: string; creditMinor: string };
  };
  readonly integrity: {
    readonly advanceUnknownSourceTypes: number;
    readonly advanceOverConsumed: number;
    readonly advanceReservationBeyondAvailable: number;
    readonly advanceApplicationBranchMismatches: number;
    readonly advanceRefundApplicationBranchMismatches: number;
    readonly advanceReservationBranchMismatches: number;
    readonly paymentAdvancesWithoutPayment: number;
    readonly creditNoteAdvancesWithoutRelease: number;
    readonly paymentOverConsumed: number;
    readonly allocationBranchMismatches: number;
    readonly receivablePaymentApplicationBranchMismatches: number;
    readonly paymentAdvanceBranchMismatches: number;
    readonly currencyMismatchDocuments: number;
    readonly advanceMissingJournals: number;
    readonly advanceJournalShapeMismatches: number;
    readonly advanceJournalBranchMismatches: number;
    readonly advanceOrphanJournals: number;
    readonly unappliedMissingJournals: number;
    readonly unappliedJournalShapeMismatches: number;
    readonly unappliedJournalBranchMismatches: number;
    readonly unappliedOrphanJournals: number;
  };
}
