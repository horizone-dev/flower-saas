-- HG3b-SALE-LATENCY — post-run CORRECTNESS checks (runbook step 6). Read-only. Run after EVERY repetition, against the benchmark database:
--   psql "$BENCH_DATABASE_URL" -v company_id=<company uuid> -f docs/phase-3/HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql
-- Checks 1–4 are PASS/FAIL: each must return the stated result, or the run is a gate failure (spec §8 step 8).
-- The same four statements run, with the same expectations, in apps/api/src/staging-benchmark/staging-benchmark.compat.integration.test.ts
-- against the real application, so the SQL itself is verified (it has never been run against staging).
-- Warm-up sales are real documents too: these checks cover ALL of the company's invoices, not only the measured window.

\echo '1. invoice numbers gapless per company — expect ok = t'
SELECT (max(x) - min(x) + 1 = count(*)) AS ok, count(*) AS invoices
  FROM (SELECT regexp_replace("invoiceNumber", '\D', '', 'g')::bigint AS x
          FROM invoice WHERE "companyId" = :'company_id') s;

\echo '2. exactly one walk_in_sale journal per issued invoice — expect 0 rows'
SELECT i.id AS invoice_without_exactly_one_sale_journal
  FROM invoice i
  LEFT JOIN journal_entry je ON je."sourceKind" = 'walk_in_sale' AND je."sourceId" = i.id::text
 WHERE i."companyId" = :'company_id'
 GROUP BY i.id HAVING count(je.id) <> 1;

\echo '3. every journal balanced (sum debits = sum credits) — expect 0 rows'
SELECT je.id AS unbalanced_journal
  FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
 WHERE je."companyId" = :'company_id'
 GROUP BY je.id HAVING sum(jl."debitMinor") <> sum(jl."creditMinor");

\echo '4. no duplicate sale — exactly one payment allocation per invoice (every request used a unique Idempotency-Key) — expect 0 rows'
SELECT i.id AS invoice_without_exactly_one_payment_allocation
  FROM invoice i LEFT JOIN payment_allocation pa ON pa."invoiceId" = i.id
 WHERE i."companyId" = :'company_id'
 GROUP BY i.id HAVING count(pa.id) <> 1;

\echo '5. INFORMATIONAL — outbox rows by event type for the tenant of the company (the spec line "one outbox event per sale" is NOT asserted: a single-tender sale is documented to emit no orders.sale_completed; the exact expected event set must be stated before this becomes pass/fail)'
SELECT "eventType", count(*) AS n
  FROM outbox
 WHERE "tenantId" = (SELECT "tenantId" FROM company WHERE id = :'company_id')
 GROUP BY "eventType" ORDER BY 1;

\echo '6. INFORMATIONAL — deadlocks / lock waits are read from the database server statistics and logs (pg_stat_database.deadlocks, log_lock_waits), not from these tables'
SELECT datname, deadlocks, conflicts, xact_rollback FROM pg_stat_database WHERE datname = current_database();
