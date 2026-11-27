-- DRAFT J — NOT in packages/db/prisma/migrations, NOT applied, NOT approved. (I-3 accounting proposal, 2026-11-15)
-- FIVE additive system accounts for the valued inventory ledger. "Opening Stock Equity" REUSES the existing EQUITY.OPENING_BALANCE (3100,
-- ADR-0019: the opening / migration balance-sheet clearing account) — no new equity account is proposed.
-- NO journal is posted here: seeding accounts only. Posting rules: docs/mvp/I-3-ACCOUNTING-PROPOSAL.md (each needs accountant approval).
-- Same backfill precedent as DRAFT-C (EXPENSE.CASH_OVER_SHORT) and 20261003120000_settlement_core_schema; new-company provisioning picks the
-- accounts up from ACCOUNTING_REFERENCE_ACCOUNTS (packages/db/src/accounting-reference-data.ts — companion TypeScript change NOT made here;
-- every pin that counts the chart must be amended: 16 -> 21, or 22 together with DRAFT-C).
-- Codes continue each category's numbering (ASSET 1000/1100/1200/1300 -> 1400; LIABILITY ...2200 -> 2300; EXPENSE 5000/5100/(5200 DRAFT-C) -> 5300/5400/5500).
-- Rollback: DELETE FROM "account" WHERE "key" IN (...) — safe while no journal line references them.
ALTER TABLE "account" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "account" ("id", "tenantId", "companyId", "key", "category", "displayCode", "displayName", "updatedAt")
SELECT uuidv7(), c."tenantId", c."id", a."key", a."category", a."code", a."name", now()
  FROM "company" c
 CROSS JOIN (VALUES
   ('ASSET.INVENTORY',                         'ASSET',     '1400', 'Inventory'),
   ('LIABILITY.GOODS_RECEIVED_NOT_INVOICED',   'LIABILITY', '2300', 'Goods Received Not Invoiced'),
   ('EXPENSE.COST_OF_GOODS_SOLD',              'EXPENSE',   '5300', 'Cost of Goods Sold'),
   ('EXPENSE.STOCK_WASTAGE',                   'EXPENSE',   '5400', 'Stock Wastage'),
   ('EXPENSE.INVENTORY_ADJUSTMENT',            'EXPENSE',   '5500', 'Inventory Adjustments')
 ) AS a("key", "category", "code", "name")
ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING;

ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
