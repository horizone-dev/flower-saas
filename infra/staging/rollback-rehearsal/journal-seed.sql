-- Seeds TWO balanced, SEALED journal entries for the company of tenant :slug, following the database's own posting protocol
-- (insert the entry unsealed -> insert its lines -> seal it, all in ONE transaction; the deferred constraint trigger
-- trg_check_journal_entry_sealed_and_balanced then verifies "sealed and Σdebit = Σcredit" at COMMIT). Disposable rehearsal database only.
--   psql -v slug=pilot-one -v src=rehearsal-<unique> -f journal-seed.sql
-- It needs the company's chart of accounts (POST /v1/companies/:id/accounting/setup) and creates the 2026-11 accounting period if absent.
\set ON_ERROR_STOP on
SELECT c.id AS company_id, c."tenantId" AS tenant_id, c."defaultCurrency" AS cur
  FROM company c JOIN tenant t ON t.id = c."tenantId" WHERE t.slug = :'slug' ORDER BY c."createdAt" LIMIT 1 \gset
SELECT id AS acc1 FROM account WHERE "companyId" = :'company_id' ORDER BY key LIMIT 1 \gset
SELECT id AS acc2 FROM account WHERE "companyId" = :'company_id' ORDER BY key OFFSET 1 LIMIT 1 \gset
SELECT id AS acc3 FROM account WHERE "companyId" = :'company_id' ORDER BY key OFFSET 2 LIMIT 1 \gset
INSERT INTO accounting_period ("tenantId", "companyId", "startDate", "endDate", "updatedAt")
VALUES (:'tenant_id', :'company_id', '2026-11-01', '2026-11-30', now()) ON CONFLICT DO NOTHING;
SELECT id AS period_id FROM accounting_period WHERE "companyId" = :'company_id' AND "startDate" = '2026-11-01' \gset

BEGIN;
INSERT INTO journal_entry ("tenantId", "companyId", "accountingPeriodId", "postingDate", "sourceKind", "sourceId", "currencyCode", "description", "postingFingerprint")
VALUES (:'tenant_id', :'company_id', :'period_id', '2026-11-15', 'ROLLBACK_REHEARSAL', :'src' || '-1', :'cur', 'rollback rehearsal fixture 1 (2 lines)', 'rehearsal-' || :'src' || '-1') RETURNING id AS je1 \gset
INSERT INTO journal_line ("tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
VALUES (:'tenant_id', :'company_id', :'je1', :'acc1', 12500, 0), (:'tenant_id', :'company_id', :'je1', :'acc2', 0, 12500);
UPDATE journal_entry SET "sealedAt" = now() WHERE id = :'je1';

INSERT INTO journal_entry ("tenantId", "companyId", "accountingPeriodId", "postingDate", "sourceKind", "sourceId", "currencyCode", "description", "postingFingerprint")
VALUES (:'tenant_id', :'company_id', :'period_id', '2026-11-16', 'ROLLBACK_REHEARSAL', :'src' || '-2', :'cur', 'rollback rehearsal fixture 2 (3 lines)', 'rehearsal-' || :'src' || '-2') RETURNING id AS je2 \gset
INSERT INTO journal_line ("tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
VALUES (:'tenant_id', :'company_id', :'je2', :'acc1', 10000, 0), (:'tenant_id', :'company_id', :'je2', :'acc2', 0, 6000), (:'tenant_id', :'company_id', :'je2', :'acc3', 0, 4000);
UPDATE journal_entry SET "sealedAt" = now() WHERE id = :'je2';
COMMIT;
\echo seeded :slug
