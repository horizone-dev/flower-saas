-- Phase 3b task 3b.6 CHECKPOINT B (B17) — the additive
-- `EQUITY.OPENING_BALANCE` system account (docs/decisions/ADR-0019.md). NOT
-- Revenue, NOT Retained Earnings, NOT Cash, NOT AR, NOT Customer Advances —
-- the opening/migration balance-sheet clearing account. `key`/`category` are
-- immutable per the frozen Chart-of-Accounts contract (task 3b.1); `3100`
-- continues the EQUITY category's own numbering (the only prior EQUITY entry
-- is `3000`), following the same one-gap-per-category convention already
-- used by every other category (`packages/db/src/accounting-reference-data.ts`).
--
-- New-tenant provisioning already picks this up for free (it maps
-- `ACCOUNTING_REFERENCE_ACCOUNTS` verbatim, unchanged code) — this migration
-- backfills the row for every EXISTING company (mirrors the exact
-- NO FORCE / cross-tenant-write / FORCE toggle already used by 3b.5's own
-- `20260923130000_payments_permissions` for `role`/`role_permission`:
-- `flower_migrate` OWNS `account` but is NOBYPASSRLS, and `account` is FORCE
-- RLS, so even the owner is filtered without this toggle). Idempotent +
-- rerunnable: `ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING` can
-- never create a duplicate row. NO journal is posted anywhere in this
-- migration — seeding the account only.

ALTER TABLE "account" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "account" ("id", "tenantId", "companyId", "key", "category", "displayCode", "displayName", "updatedAt")
SELECT uuidv7(), c."tenantId", c."id", 'EQUITY.OPENING_BALANCE', 'EQUITY', '3100', 'Opening Balance Equity', now()
  FROM "company" c
ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING;

ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
