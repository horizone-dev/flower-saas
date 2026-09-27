-- Phase 3b task 3b.6 CHECKPOINT B (B18) — Receivables/Credit/Advances:
-- permission registration + built-in system-role backfill
-- (docs/decisions/ADR-0019.md). No schema change — activates the four
-- `receivables` keys just added as a brand new group in `@flower/permissions`
-- PERMISSIONS.receivables (confirmed by direct inspection: none of these four
-- keys appear in any prior migration's `permission_registry` INSERT anywhere
-- in this repository, and no role held any of them before this migration).
--
-- ══════════════ OWNER-FROZEN ROLE-DEFAULT MATRIX ═══════════════════════════
--   OWNER:   receivables:view, receivables:collect, receivables:advance:apply, receivables:opening_balance:manage
--   ADMIN:   receivables:view, receivables:collect, receivables:advance:apply, receivables:opening_balance:manage
--   MANAGER: receivables:view, receivables:collect, receivables:advance:apply
--   CASHIER: receivables:view, receivables:collect
--   SALES:   receivables:view, receivables:collect
--   all other built-in roles: no receivables:* key by default
--
-- `receivables:view`/`receivables:collect` mirror `payments:view`/
-- `payments:collect`'s cashier/sales inclusion exactly (routine POS-floor
-- actions). `receivables:advance:apply` is owner/admin/manager only —
-- applying a customer's Advance is not a routine sale-floor action.
-- `receivables:opening_balance:manage` is owner/admin ONLY and step-up gated
-- (`STEP_UP_PERMISSIONS` in `@flower/permissions`, code change only — no
-- migration effect) — it fabricates a financial balance from nothing, the
-- same money-exposure tier as `customers:credit:manage`.
--
-- Same FORCE-toggle discipline as every prior task's backfill (task 3b.5's
-- `20260923130000_payments_permissions` is the most recent precedent):
-- `flower_migrate` OWNS `role`/`role_permission` but is NOBYPASSRLS, and both
-- tables are FORCE RLS, so even the owner is filtered. Drop FORCE for the two
-- tables inside THIS transaction (no other session can observe the gap — the
-- ALTERs take ACCESS EXCLUSIVE and commit atomically), do the cross-tenant
-- write, then restore FORCE. Idempotent + rerunnable: `ON CONFLICT (roleId,
-- permissionKey) DO NOTHING` can never create a duplicate row. The
-- `SYSTEM_ROLE_TEMPLATES` update for NEW-tenant provisioning is included in
-- the same code change as this migration (`system-roles.ts`) — Checkpoint B
-- has no HTTP surface either, so granting the capability early to new
-- tenants is harmless (matches the "register now, no execution surface yet"
-- pattern already used for `customers:credit:override` in 3b.2 and
-- `orders:cancel` in 3b.3).

-- ── permission registry — register the 4 receivables:* keys ─────────────────
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('receivables:view',                    'TENANT', 'receivables', 'receivables view',                    3),
  ('receivables:collect',                 'TENANT', 'receivables', 'receivables collect',                 3),
  ('receivables:advance:apply',           'TENANT', 'receivables', 'receivables advance apply',           3),
  ('receivables:opening_balance:manage',  'TENANT', 'receivables', 'receivables opening balance manage',  3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill ───────────────────────────────────────────
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

-- receivables:view + receivables:collect — owner/admin/manager/cashier/sales
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('receivables:view'), ('receivables:collect')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'manager', 'cashier', 'sales')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

-- receivables:advance:apply — owner/admin/manager only
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'receivables:advance:apply'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'manager')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

-- receivables:opening_balance:manage — owner/admin ONLY
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'receivables:opening_balance:manage'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
