/**
 * Phase 3B closure — F-1 / F-2: the ONE read statement of the anonymous credit-note summary (see `anonymous-credit-note-summary.ts`).
 *
 *   $1 tenantId   $2 companyId   $3 from (civil date)   $4 to (civil date)   $5 branchId — NULL for the company summary   $6 density limit
 *   $7 "now" — the APPLICATION's accounting clock (the one time source: documents, journals and this ageing all use it, never the database clock)
 *
 * ONE statement ⇒ ONE snapshot (`runScoped` offers no isolation-level control, so a multi-statement report could straddle a concurrent
 * posting — the reason the frozen reports are single statements too). Explicit tenant + company (+ branch) predicates on EVERY table it
 * touches: it never relies on RLS or the branch GUC. Every money aggregate leaves the database as TEXT (exact), counts as JSON integers.
 * It reads only the three anonymous credit-note tables, the journals of exactly TWO source kinds (`anonymous_credit_note`,
 * `anonymous_credit_note_refund`), their lines, the accounts those lines touch, and the company row. It reads no payment, refund, invoice,
 * customer, settlement or catalogue table and WRITES nothing (the transaction is database-enforced read-only).
 *
 * Period authority: sealed journals by `postingDate`. A note belongs to the period of its `accountingDate` (its issuance journal's posting
 * date). A CASH / BANK_TRANSFER refund belongs to the period of its EXECUTION JOURNAL; a manual card / other refund posts nothing, so it
 * belongs to the civil date of its attestation in the company's accounting timezone.
 *
 * Density guard: the first stage reads at most `limit + 1` notes of the period; EVERY heavy stage carries `(SELECT ok FROM gate)`, so above
 * the limit nothing else is produced and the repository rejects with REPORT_RESULT_TOO_LARGE (422).
 */
const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const ANONYMOUS_SUMMARY_SQL = `
WITH
co AS (
  SELECT c."defaultCurrency", c."accountingTimezone"
    FROM "company" c
   WHERE c."id" = $2::uuid AND c."tenantId" = $1::uuid
),
tz AS (SELECT COALESCE((SELECT "accountingTimezone" FROM co), 'UTC') AS z),
sn AS (
  SELECT n."id", n."branchId", n."accountingDate", n."totalAmountMinor" AS total, n."taxTotalAmountMinor" AS tax
    FROM "anonymous_credit_note" n
   WHERE n."tenantId" = $1::uuid AND n."companyId" = $2::uuid
     AND ($5::uuid IS NULL OR n."branchId" = $5::uuid)
),
pn AS (
  SELECT sn."id", sn."total", sn."tax" FROM sn
   WHERE sn."accountingDate" BETWEEN $3::date AND $4::date
   LIMIT ($6::int + 1)
),
gate AS (SELECT (SELECT count(*) FROM pn) <= $6::int AS ok),
sr AS (
  SELECT r."id", r."creditNoteId", r."method", r."status", r."amountMinor" AS amount, r."createdAt", r."resolvedAt"
    FROM "anonymous_credit_note_refund" r
   WHERE r."tenantId" = $1::uuid AND r."companyId" = $2::uuid
     AND ($5::uuid IS NULL OR r."branchId" = $5::uuid)
),
cohort AS (
  SELECT r."method", r."status", count(*)::int AS c, COALESCE(sum(r.amount), 0)::text AS t
    FROM sr r JOIN pn ON pn."id" = r."creditNoteId"
   WHERE (SELECT ok FROM gate)
   GROUP BY 1, 2
),
exec_event AS (
  SELECT x."method", count(*)::int AS c, COALESCE(sum(x.amount), 0)::text AS t
    FROM (
      SELECT r."method", r.amount,
             CASE WHEN r."method" IN ('CASH', 'BANK_TRANSFER') THEN je."postingDate"
                  ELSE (r."resolvedAt" AT TIME ZONE (SELECT z FROM tz))::date END AS d
        FROM sr r
        LEFT JOIN "journal_entry" je
               ON je."tenantId" = $1::uuid AND je."companyId" = $2::uuid
              AND je."sourceKind" = 'anonymous_credit_note_refund' AND je."sourceId" = r."id"::text AND je."sealedAt" IS NOT NULL
       WHERE r."status" = 'EXECUTED' AND (SELECT ok FROM gate)
    ) x
   WHERE x.d BETWEEN $3::date AND $4::date
   GROUP BY 1
),
ageing AS (
  SELECT CASE WHEN q.a < 2 THEN '0-1 days' WHEN q.a < 8 THEN '2-7 days' WHEN q.a < 31 THEN '8-30 days' ELSE '31+ days' END AS b,
         count(*)::int AS c, COALESCE(sum(q.amount), 0)::text AS t
    FROM (
      SELECT r.amount, floor(extract(epoch FROM ($7::timestamptz - r."createdAt")) / 86400)::int AS a
        FROM sr r WHERE r."status" = 'PENDING' AND (SELECT ok FROM gate)
    ) q
   GROUP BY 1
),
at_end AS (
  SELECT count(*)::int AS c, COALESCE(sum(r.amount), 0)::text AS t
    FROM sr r JOIN sn ON sn."id" = r."creditNoteId"
   WHERE sn."accountingDate" <= $4::date
     AND (r."createdAt" AT TIME ZONE (SELECT z FROM tz))::date <= $4::date
     AND (r."status" = 'PENDING' OR (r."resolvedAt" AT TIME ZONE (SELECT z FROM tz))::date > $4::date)
     AND (SELECT ok FROM gate)
),
glp AS (
  SELECT a."key", je."sourceKind" AS kind,
         COALESCE(sum(jl."debitMinor"), 0)::text AS d, COALESCE(sum(jl."creditMinor"), 0)::text AS c
    FROM "journal_entry" je
    JOIN "journal_line" jl ON jl."journalEntryId" = je."id" AND jl."tenantId" = $1::uuid AND jl."companyId" = $2::uuid
    JOIN "account" a ON a."id" = jl."accountId" AND a."tenantId" = $1::uuid AND a."companyId" = $2::uuid
   WHERE je."tenantId" = $1::uuid AND je."companyId" = $2::uuid AND je."sealedAt" IS NOT NULL
     AND je."sourceKind" IN ('anonymous_credit_note', 'anonymous_credit_note_refund')
     AND je."postingDate" BETWEEN $3::date AND $4::date
     AND ($5::uuid IS NULL OR jl."branchId" = $5::uuid)
     AND (SELECT ok FROM gate)
   GROUP BY 1, 2
),
execj AS (
  SELECT r."method", count(*)::int AS c, COALESCE(sum(r.amount), 0)::text AS t
    FROM sr r
    JOIN "journal_entry" je
      ON je."tenantId" = $1::uuid AND je."companyId" = $2::uuid
     AND je."sourceKind" = 'anonymous_credit_note_refund' AND je."sourceId" = r."id"::text AND je."sealedAt" IS NOT NULL
   WHERE r."status" = 'EXECUTED' AND r."method" IN ('CASH', 'BANK_TRANSFER')
     AND je."postingDate" BETWEEN $3::date AND $4::date AND (SELECT ok FROM gate)
   GROUP BY 1
),
nnj AS (
  SELECT count(*)::int AS c, COALESCE(sum(sn.total), 0)::text AS t
    FROM sn
   WHERE (SELECT ok FROM gate)
     AND NOT EXISTS (
       SELECT 1 FROM "journal_entry" je
        WHERE je."tenantId" = $1::uuid AND je."companyId" = $2::uuid
          AND je."sourceKind" = 'anonymous_credit_note' AND je."sourceId" = sn."id"::text AND je."sealedAt" IS NOT NULL)
),
enj AS (
  SELECT count(*)::int AS c, COALESCE(sum(r.amount), 0)::text AS t
    FROM sr r
   WHERE (SELECT ok FROM gate) AND r."status" = 'EXECUTED' AND r."method" IN ('CASH', 'BANK_TRANSFER')
     AND NOT EXISTS (
       SELECT 1 FROM "journal_entry" je
        WHERE je."tenantId" = $1::uuid AND je."companyId" = $2::uuid
          AND je."sourceKind" = 'anonymous_credit_note_refund' AND je."sourceId" = r."id"::text AND je."sealedAt" IS NOT NULL)
),
orphans AS (
  SELECT count(*)::int AS c
    FROM "journal_entry" je
   WHERE (SELECT ok FROM gate)
     AND je."tenantId" = $1::uuid AND je."companyId" = $2::uuid AND je."sealedAt" IS NOT NULL
     AND je."sourceKind" IN ('anonymous_credit_note', 'anonymous_credit_note_refund')
     AND ($5::uuid IS NULL OR EXISTS (
            SELECT 1 FROM "journal_line" jb
             WHERE jb."tenantId" = $1::uuid AND jb."companyId" = $2::uuid
               AND jb."journalEntryId" = je."id" AND jb."branchId" = $5::uuid))
     AND (
          (je."sourceKind" = 'anonymous_credit_note' AND NOT EXISTS (
             SELECT 1 FROM "anonymous_credit_note" n
              WHERE n."tenantId" = $1::uuid AND n."companyId" = $2::uuid
                AND n."id" = (CASE WHEN je."sourceId" ~ '${UUID_RE}' THEN je."sourceId"::uuid END)))
       OR (je."sourceKind" = 'anonymous_credit_note_refund' AND NOT EXISTS (
             SELECT 1 FROM "anonymous_credit_note_refund" r
              WHERE r."tenantId" = $1::uuid AND r."companyId" = $2::uuid AND r."status" = 'EXECUTED' AND r."method" IN ('CASH', 'BANK_TRANSFER')
                AND r."id" = (CASE WHEN je."sourceId" ~ '${UUID_RE}' THEN je."sourceId"::uuid END)))
     )
),
clr AS (
  SELECT
    (SELECT COALESCE(sum(sn.total), 0)::text FROM sn WHERE sn."accountingDate" <= $4::date AND (SELECT ok FROM gate)) AS issued,
    (SELECT COALESCE(sum(r.amount), 0)::text
       FROM sr r
       JOIN "journal_entry" je
         ON je."tenantId" = $1::uuid AND je."companyId" = $2::uuid
        AND je."sourceKind" = 'anonymous_credit_note_refund' AND je."sourceId" = r."id"::text AND je."sealedAt" IS NOT NULL
      WHERE r."status" = 'EXECUTED' AND r."method" IN ('CASH', 'BANK_TRANSFER') AND je."postingDate" <= $4::date AND (SELECT ok FROM gate)) AS executed,
    (SELECT COALESCE(sum(jl."debitMinor" - jl."creditMinor"), 0)::text
       FROM "journal_entry" je
       JOIN "journal_line" jl ON jl."journalEntryId" = je."id" AND jl."tenantId" = $1::uuid AND jl."companyId" = $2::uuid
       JOIN "account" a ON a."id" = jl."accountId" AND a."tenantId" = $1::uuid AND a."companyId" = $2::uuid
      WHERE je."tenantId" = $1::uuid AND je."companyId" = $2::uuid AND je."sealedAt" IS NOT NULL
        AND je."sourceKind" IN ('anonymous_credit_note', 'anonymous_credit_note_refund')
        AND a."key" = 'ASSET.PAYMENT_CLEARING' AND je."postingDate" <= $4::date
        AND ($5::uuid IS NULL OR jl."branchId" = $5::uuid) AND (SELECT ok FROM gate)) AS gl
)
SELECT jsonb_build_object(
  'company', (SELECT to_jsonb(co) FROM co),
  'candidateNotes', (SELECT count(*)::int FROM pn),
  'creditNotes', (SELECT jsonb_build_object('count', count(*)::int, 'total', COALESCE(sum(pn.total), 0)::text, 'tax', COALESCE(sum(pn.tax), 0)::text)
                    FROM pn WHERE (SELECT ok FROM gate)),
  'cohort', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', method, 'status', status, 'count', c, 'total', t)) FROM cohort), '[]'::jsonb),
  'executedEvent', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', method, 'count', c, 'total', t)) FROM exec_event), '[]'::jsonb),
  'pendingAgeing', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', b, 'count', c, 'total', t)) FROM ageing), '[]'::jsonb),
  'atPeriodEnd', (SELECT jsonb_build_object('pendingCount', c, 'pendingTotal', t) FROM at_end),
  'gl', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'kind', kind, 'debit', d, 'credit', c)) FROM glp), '[]'::jsonb),
  'execJournalInPeriod', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', method, 'count', c, 'total', t)) FROM execj), '[]'::jsonb),
  'integrity', jsonb_build_object(
    'notesWithoutIssuanceJournalCount', (SELECT c FROM nnj), 'notesWithoutIssuanceJournalTotal', (SELECT t FROM nnj),
    'executedCashBankWithoutJournalCount', (SELECT c FROM enj), 'executedCashBankWithoutJournalTotal', (SELECT t FROM enj),
    'orphanJournals', (SELECT c FROM orphans)),
  'clearing', (SELECT jsonb_build_object('issuedToDate', issued, 'executedToDate', executed, 'glToDate', gl) FROM clr)
)::text AS doc
`;
