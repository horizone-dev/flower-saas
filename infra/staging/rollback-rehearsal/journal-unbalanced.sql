-- NEGATIVE control: an UNBALANCED sealed entry (debit 100 / credit 50) must be refused by the database at COMMIT.
-- Expected: this script FAILS (psql exits non-zero) and persists nothing. Run it against the live AND the restored database.
--   psql -v slug=pilot-one -v src=rehearsal-unbalanced-<unique> -f journal-unbalanced.sql
\set ON_ERROR_STOP on
SELECT c.id AS company_id, c."tenantId" AS tenant_id, c."defaultCurrency" AS cur
  FROM company c JOIN tenant t ON t.id = c."tenantId" WHERE t.slug = :'slug' ORDER BY c."createdAt" LIMIT 1 \gset
SELECT id AS acc1 FROM account WHERE "companyId" = :'company_id' ORDER BY key LIMIT 1 \gset
SELECT id AS acc2 FROM account WHERE "companyId" = :'company_id' ORDER BY key OFFSET 1 LIMIT 1 \gset
SELECT id AS period_id FROM accounting_period WHERE "companyId" = :'company_id' AND "startDate" = '2026-11-01' \gset
BEGIN;
INSERT INTO journal_entry ("tenantId", "companyId", "accountingPeriodId", "postingDate", "sourceKind", "sourceId", "currencyCode", "description", "postingFingerprint")
VALUES (:'tenant_id', :'company_id', :'period_id', '2026-11-17', 'ROLLBACK_REHEARSAL', :'src', :'cur', 'UNBALANCED — must never persist', 'rehearsal-' || :'src') RETURNING id AS je \gset
INSERT INTO journal_line ("tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
VALUES (:'tenant_id', :'company_id', :'je', :'acc1', 100, 0), (:'tenant_id', :'company_id', :'je', :'acc2', 0, 50);
UPDATE journal_entry SET "sealedAt" = now() WHERE id = :'je';
COMMIT;
