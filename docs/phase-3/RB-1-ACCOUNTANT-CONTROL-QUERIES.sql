-- RB-1 (anonymous credit notes) — ACCOUNTANT / OPERATIONS CONTROL QUERIES. Read-only.
--   psql "$DATABASE_URL" -v company_id=<company uuid> -f docs/phase-3/RB-1-ACCOUNTANT-CONTROL-QUERIES.sql
-- Each statement is executed, unchanged apart from the :'company_id' placeholder, by
-- apps/api/src/modules/anonymous-credit-notes/anonymous-credit-note.integration.test.ts ("CONTROL QUERIES"), so they are verified against the
-- real schema and the real journals. They read only; they change nothing and apply no financial policy.
-- Amounts are in minor units. Statements are separated by the "-- @query" markers (used by the test harness).

-- @query pending_refunds
-- Q1. Refund lines still PENDING (the tender execution has not been attested), oldest first. A non-empty result at a period end is a cut-off
-- item: the refund is booked in flight on ASSET.PAYMENT_CLEARING.
SELECT n."creditNoteNumber", r."id" AS refund_id, r."branchId", r."method", r."amountMinor"::text AS amount_minor,
       r."createdAt", floor(extract(epoch FROM (now() - r."createdAt")) / 86400)::int AS age_days
  FROM "anonymous_credit_note_refund" r
  JOIN "anonymous_credit_note" n ON n."id" = r."creditNoteId"
 WHERE r."companyId" = :'company_id' AND r."status" = 'PENDING'
 ORDER BY r."createdAt";

-- @query unallocated_credit
-- Q2. Credit notes whose refund lines do not cover the credit total (a FAILED line was not replaced). The customer is still owed this
-- amount; it remains booked in flight on ASSET.PAYMENT_CLEARING.
SELECT n."creditNoteNumber", n."id" AS credit_note_id, n."branchId", n."totalAmountMinor"::text AS total_minor,
       COALESCE(sum(r."amountMinor") FILTER (WHERE r."status" <> 'FAILED'), 0)::text AS allocated_minor,
       (n."totalAmountMinor" - COALESCE(sum(r."amountMinor") FILTER (WHERE r."status" <> 'FAILED'), 0))::text AS unallocated_minor
  FROM "anonymous_credit_note" n
  LEFT JOIN "anonymous_credit_note_refund" r ON r."creditNoteId" = n."id"
 WHERE n."companyId" = :'company_id'
 GROUP BY n."id"
HAVING n."totalAmountMinor" - COALESCE(sum(r."amountMinor") FILTER (WHERE r."status" <> 'FAILED'), 0) > 0
 ORDER BY n."issuedAt";

-- @query clearing_reconciliation
-- Q3. Sub-ledger vs general ledger for ASSET.PAYMENT_CLEARING, anonymous credit notes only. EXPECTED (from the documents) = −(Σ credit totals −
-- Σ EXECUTED CASH / BANK_TRANSFER refunds); ACTUAL = Σ(debit − credit) of that account over the anonymous credit-note journals. difference_minor
-- must be 0. (Manual card / other executions post nothing, so they stay in the credit — by design.)
WITH expected AS (
  SELECT -(
           COALESCE((SELECT sum(n."totalAmountMinor") FROM "anonymous_credit_note" n WHERE n."companyId" = :'company_id'), 0)
         - COALESCE((SELECT sum(r."amountMinor") FROM "anonymous_credit_note_refund" r
                      WHERE r."companyId" = :'company_id' AND r."status" = 'EXECUTED' AND r."method" IN ('CASH', 'BANK_TRANSFER')), 0)
         ) AS v
), actual AS (
  SELECT COALESCE(sum(jl."debitMinor" - jl."creditMinor"), 0) AS v
    FROM "journal_entry" je
    JOIN "journal_line" jl ON jl."journalEntryId" = je."id"
    JOIN "account" a ON a."id" = jl."accountId"
   WHERE je."companyId" = :'company_id' AND a."key" = 'ASSET.PAYMENT_CLEARING'
     AND je."sourceKind" IN ('anonymous_credit_note', 'anonymous_credit_note_refund')
)
SELECT (SELECT v FROM expected)::text AS expected_minor, (SELECT v FROM actual)::text AS actual_minor,
       ((SELECT v FROM expected) - (SELECT v FROM actual))::text AS difference_minor;

-- @query gl_effect_by_account
-- Q4. The general-ledger effect of ALL anonymous credit-note journals, per account (Σ debit − credit). For tie-out with the trial balance.
SELECT a."key" AS account_key, sum(jl."debitMinor" - jl."creditMinor")::text AS net_debit_minor
  FROM "journal_entry" je
  JOIN "journal_line" jl ON jl."journalEntryId" = je."id"
  JOIN "account" a ON a."id" = jl."accountId"
 WHERE je."companyId" = :'company_id' AND je."sourceKind" IN ('anonymous_credit_note', 'anonymous_credit_note_refund')
 GROUP BY a."key" ORDER BY a."key";

-- @query executed_refunds_by_day
-- Q5. Attested (EXECUTED) refunds by branch, method and resolution day (UTC) — the list a cash-drawer reconciliation needs until Phase 4
-- integrates the register. Cash / bank executions are also in the general ledger; manual card / other are not (they post nothing).
SELECT r."branchId", r."method", (r."resolvedAt" AT TIME ZONE 'UTC')::date AS resolved_date_utc,
       count(*)::int AS refunds, sum(r."amountMinor")::text AS amount_minor
  FROM "anonymous_credit_note_refund" r
 WHERE r."companyId" = :'company_id' AND r."status" = 'EXECUTED'
 GROUP BY 1, 2, 3 ORDER BY 3, 1, 2;

-- @query reversed_sales
-- Q6. Sales reversed through anonymous credit notes: credited total against the invoice total, and the derived reversal state
-- (NONE is never listed here; FULL when the credited total equals the invoice total, otherwise PARTIAL).
SELECT i."invoiceNumber", i."id" AS invoice_id, i."totalAmountMinor"::text AS invoice_total_minor,
       sum(n."totalAmountMinor")::text AS credited_total_minor,
       CASE WHEN sum(n."totalAmountMinor") = i."totalAmountMinor" THEN 'FULL' ELSE 'PARTIAL' END AS reversal
  FROM "anonymous_credit_note" n
  JOIN "invoice" i ON i."id" = n."invoiceId"
 WHERE n."companyId" = :'company_id'
 GROUP BY i."id" ORDER BY i."invoiceNumber";

-- @query same_user_issue_and_attest
-- Q7. Segregation-of-duties evidence (F-5): refund lines whose outcome (EXECUTED or FAILED) was attested by the SAME user who issued the credit
-- note. The system permits this (one role holding both credit_notes:issue and refunds:execute can do all three steps); this query makes it
-- visible without changing any policy. An empty result means every outcome was attested by a second person.
SELECT n."creditNoteNumber", r."id" AS refund_id, r."method", r."amountMinor"::text AS amount_minor, r."status",
       n."createdByUserId" AS issued_by, r."resolvedByUserId" AS attested_by, r."resolvedAt"
  FROM "anonymous_credit_note_refund" r
  JOIN "anonymous_credit_note" n ON n."id" = r."creditNoteId"
 WHERE r."companyId" = :'company_id' AND r."resolvedByUserId" IS NOT NULL AND r."resolvedByUserId" = n."createdByUserId"
 ORDER BY r."resolvedAt";

-- @query clearing_by_source_kind
-- Q8. The ASSET.PAYMENT_CLEARING balance of the company BY SOURCE KIND (all sealed journals, not only anonymous ones): the composition of the
-- clearing account at a glance. Typical contributors: walk_in_sale (+ manual card / other takings), SETTLEMENT_BATCH (− provider settlements),
-- anonymous_credit_note (− refunds in flight), anonymous_credit_note_refund (+ cash / bank refunds attested), refund and customer_receipt_payment
-- (frozen receivables flows). The anonymous contribution is what Q3 reconciles to the documents; the rest is for the accountant's own tie-out.
SELECT je."sourceKind" AS source_kind, count(DISTINCT je."id")::int AS journals, sum(jl."debitMinor" - jl."creditMinor")::text AS net_debit_minor
  FROM "journal_entry" je
  JOIN "journal_line" jl ON jl."journalEntryId" = je."id"
  JOIN "account" a ON a."id" = jl."accountId"
 WHERE je."companyId" = :'company_id' AND a."key" = 'ASSET.PAYMENT_CLEARING' AND je."sealedAt" IS NOT NULL
 GROUP BY je."sourceKind"
 ORDER BY je."sourceKind";

-- @query executed_without_audit
-- Q9. EXECUTED refunds that have NO audit record of their execution. Through the application every attestation writes the status, the journal and the
-- audit row in ONE transaction, so this must be EMPTY. A non-empty result means an outcome was written by a path that bypassed the application (for
-- example a privileged direct writer that posted a genuine-shaped journal and set the status consistently — the one thing the database guard cannot tell
-- apart from the application). It is a DETECTIVE control for that residual trust assumption.
SELECT n."creditNoteNumber", r."id" AS refund_id, r."method", r."amountMinor"::text AS amount_minor, r."resolvedAt", r."resolvedByUserId"
  FROM "anonymous_credit_note_refund" r
  JOIN "anonymous_credit_note" n ON n."id" = r."creditNoteId"
 WHERE r."companyId" = :'company_id' AND r."status" = 'EXECUTED'
   AND NOT EXISTS (SELECT 1 FROM "audit_log" al WHERE al."action" = 'anonymous_credit_note.refund_executed' AND al."resourceId" = r."id"::text)
 ORDER BY r."resolvedAt";
