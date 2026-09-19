-- Phase 3b task 3b.2 — CRM / Customer Core: permission registration +
-- built-in system-role backfill (docs/phase-3/PHASE-3B-PLAN.md §E). No schema
-- change — this migration only activates the four new `customers` keys that
-- already exist in `@flower/permissions` PERMISSIONS.customers (replacing the
-- stale Phase-0 placeholder keys `credit:view`/`credit:manage`/
-- `advance:manage`/`giftcards:manage`, added alongside the schema migration
-- `20260918120000_customer_core`). Follows the exact idempotent, rerunnable
-- pattern established by task 3.2's `catalog_core` migration and every task
-- since (D2-6 / HG3-PERMISSION-STABILITY), most recently task 3b.1's
-- `20260916120000_accounting_permissions`.

-- ── permission registry — register customers:view / customers:manage /
--    customers:credit:manage / customers:credit:override ────────────────────
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('customers:view',           'TENANT', 'customers', 'customers view',           3),
  ('customers:manage',         'TENANT', 'customers', 'customers manage',         3),
  ('customers:credit:manage',  'TENANT', 'customers', 'customers credit manage',  3),
  ('customers:credit:override','TENANT', 'customers', 'customers credit override',3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill ───────────────────────────────────────────
-- Existing tenants: owner gains all 4 keys; admin gains
-- customers:view + customers:manage + customers:credit:manage (NOT override —
-- Owner-tier only, mirrors accounting:period:manage's precedent; no tenant
-- "Super Admin" role is invented; Platform Super Admin is a wholly separate
-- auth realm); manager/cashier/sales each gain customers:view +
-- customers:manage only (customer lookup AND on-the-spot creation are
-- realistic POS-floor needs; credit configuration stays restricted to
-- Owner/Admin). All other roles are untouched. ONLY isSystem = true roles
-- with these exact keys — custom roles, user-created roles, explicit grants
-- and deny grants are NEVER touched. Idempotent + rerunnable: ON CONFLICT
-- (roleId, permissionKey) DO NOTHING can never create a duplicate row.
--
-- Same FORCE-toggle as every prior task's backfill: `flower_migrate` OWNS
-- these tables but is NOBYPASSRLS, and `role` / `role_permission` are FORCE
-- RLS, so even the owner is filtered. Drop FORCE for the two tables inside
-- THIS transaction (no other session can observe the gap — the ALTERs take
-- ACCESS EXCLUSIVE and commit atomically), do the cross-tenant write, then
-- restore FORCE. (SYSTEM_ROLE_TEMPLATES is updated in the same task so NEW
-- tenants get these keys at provisioning without any backfill.)
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('customers:view'), ('customers:manage')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'manager', 'cashier', 'sales')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'customers:credit:manage'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'customers:credit:override'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" = 'owner'
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
