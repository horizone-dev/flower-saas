-- DRAFT C — NOT APPLIED, NOT IN packages/db/prisma/migrations. A PROPOSAL for accountant + owner approval (decision sheet D-1 / S-9).
-- ONE additive system account, `EXPENSE.CASH_OVER_SHORT` ('5200': continues the EXPENSE numbering 5000, 5100). Exact backfill precedent:
-- 20261003120000_settlement_core_schema (EXPENSE.PAYMENT_PROCESSING_FEE). NO journal is posted here — seeding the account only. A shortage
-- debits it and an overage credits it (decision D-2, applied by a LATER, separately approved close-posting change).
-- NOT proposed here: any safe / petty-cash / payout / owner-contribution / supplier-payable account (decisions B-1 A and C-1/C-2 A keep the V1
-- cash in / out GL-neutral, so none is needed; B-1 B would add ASSET.SAFE_CASH, C-2 B would add EXPENSE.CASH_PAYOUT — owner choice).
--
-- COMPANION TypeScript change (NOT made here): append the entry to ACCOUNTING_REFERENCE_ACCOUNTS in packages/db/src/accounting-reference-data.ts
-- (new-company provisioning maps that array verbatim) and amend every pin that counts the chart (16 -> 17 accounts).
-- Rollback: DELETE FROM "account" WHERE "key" = 'EXPENSE.CASH_OVER_SHORT' (safe while no journal line references it).

ALTER TABLE "account" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "account" ("id", "tenantId", "companyId", "key", "category", "displayCode", "displayName", "updatedAt")
SELECT uuidv7(), c."tenantId", c."id", 'EXPENSE.CASH_OVER_SHORT', 'EXPENSE', '5200', 'Cash Over/Short', now()
  FROM "company" c
ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING;

ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
