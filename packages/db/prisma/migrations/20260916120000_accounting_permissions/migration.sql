-- Phase 3b task 3b.1 — CoA + Posting Engine + Accounting Periods: permission
-- registration + built-in system-role backfill (docs/phase-3/PHASE-3B-PLAN.md
-- §E). No schema change — this migration only activates the three new
-- `accounting` keys that already exist in `@flower/permissions` PERMISSIONS.accounting
-- (added alongside the schema migration `20260915120000_accounting_coa_posting_periods`).
-- Follows the exact idempotent, rerunnable pattern established by task 3.2's
-- `catalog_core` migration and every catalog task since (D2-6 / HG3-PERMISSION-STABILITY).

-- ── permission registry — register accounting:view / accounting:manage /
--    accounting:period:manage ─────────────────────────────────────────────
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('accounting:view',           'TENANT', 'accounting', 'accounting view',           3),
  ('accounting:manage',         'TENANT', 'accounting', 'accounting manage',         3),
  ('accounting:period:manage',  'TENANT', 'accounting', 'accounting period manage',  3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill ───────────────────────────────────────────
-- Existing tenants: owner + admin get accounting:view + accounting:manage;
-- owner ALONE also gets accounting:period:manage (Owner-tier only — no tenant
-- "Super Admin" role is invented; Platform Super Admin is a wholly separate
-- auth realm). manager gets neither. ONLY isSystem = true roles with these
-- exact keys — custom roles, user-created roles, explicit grants and deny
-- grants are NEVER touched. Idempotent + rerunnable: ON CONFLICT (roleId,
-- permissionKey) DO NOTHING can never create a duplicate row.
--
-- Same FORCE-toggle as every prior catalog-task backfill: `flower_migrate`
-- OWNS these tables but is NOBYPASSRLS, and `role` / `role_permission` are
-- FORCE RLS, so even the owner is filtered. Drop FORCE for the two tables
-- inside THIS transaction (no other session can observe the gap — the ALTERs
-- take ACCESS EXCLUSIVE and commit atomically), do the cross-tenant write,
-- then restore FORCE. (SYSTEM_ROLE_TEMPLATES is updated in the same task so
-- NEW tenants get these keys at provisioning without any backfill.)
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('accounting:view'), ('accounting:manage')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'accounting:period:manage'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" = 'owner'
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
