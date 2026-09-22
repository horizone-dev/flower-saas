-- Phase 3b task 3b.5 CHECKPOINT B — Payments: permission registration +
-- built-in system-role backfill (docs/phase-3/PHASE-3B-PLAN.md §E). No
-- schema change — activates the two `payments` keys that were just added as
-- a brand new group in `@flower/permissions` PERMISSIONS.payments
-- (`payments:view`/`payments:collect` — confirmed by direct inspection:
-- these two keys appear in NO prior migration's `permission_registry`
-- INSERT anywhere in this repository, and NO role held either of them
-- before this migration). `payments:refund:approve` (a pre-existing stale
-- placeholder key in the `customers` group) is explicitly OUT of Task
-- 3b.5 scope and is NOT registered or touched here.
--
-- ══════════════ OWNER-FROZEN ROLE-DEFAULT MATRIX ═══════════════════════════
--   OWNER:   payments:view, payments:collect
--   ADMIN:   payments:view, payments:collect
--   MANAGER: payments:view, payments:collect
--   CASHIER: payments:view, payments:collect
--   SALES:   payments:view, payments:collect
--   all other built-in roles: no payments:* key by default
--
-- Both keys go to every one of these 5 roles identically (unlike
-- `orders:cancel`'s narrower owner/admin/manager-only precedent) —
-- collecting a routine sale payment is a normal POS-floor action, mirroring
-- `orders:view`/`orders:manage`'s cashier/sales inclusion exactly. Neither
-- key is step-up gated (STEP_UP_PERMISSIONS untouched by this migration) —
-- no accepted rule mandates step-up for ordinary payment collection.
--
-- Same FORCE-toggle discipline as every prior task's backfill (task 3b.3's
-- `20260920130000_orders_permissions` is the most recent precedent):
-- `flower_migrate` OWNS `role`/`role_permission` but is NOBYPASSRLS, and both
-- tables are FORCE RLS, so even the owner is filtered. Drop FORCE for the two
-- tables inside THIS transaction (no other session can observe the gap — the
-- ALTERs take ACCESS EXCLUSIVE and commit atomically), do the cross-tenant
-- write, then restore FORCE. Idempotent + rerunnable: `ON CONFLICT (roleId,
-- permissionKey) DO NOTHING` can never create a duplicate row. A
-- `SYSTEM_ROLE_TEMPLATES` update for NEW-tenant provisioning is included in
-- the same code change as this migration (`system-roles.ts`), unlike task
-- 3b.3's own deferral — Checkpoint B has no HTTP surface either, so granting
-- the capability early to new tenants is harmless (matches the "register
-- now, no execution surface yet" pattern already used for
-- `customers:credit:override` in task 3b.2 and `orders:cancel` in 3b.3).

-- ── permission registry — register payments:view / payments:collect ────────
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('payments:view',    'TENANT', 'payments', 'payments view',    3),
  ('payments:collect', 'TENANT', 'payments', 'payments collect', 3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill ───────────────────────────────────────────
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

-- payments:view + payments:collect — owner/admin/manager/cashier/sales
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('payments:view'), ('payments:collect')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'manager', 'cashier', 'sales')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
