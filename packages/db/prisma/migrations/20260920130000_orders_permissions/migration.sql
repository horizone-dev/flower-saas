-- Phase 3b task 3b.3 CHECKPOINT A — Orders + Invoice + Numbering: permission
-- registration + built-in system-role backfill (docs/phase-3/PHASE-3B-PLAN.md
-- §E.1). No schema change — activates the three `orders` keys that already
-- exist as unregistered placeholder keys in `@flower/permissions`
-- PERMISSIONS.orders (`orders:view`/`orders:manage`/`orders:cancel` —
-- confirmed by direct inspection: these three keys appear in NO prior
-- migration's `permission_registry` INSERT anywhere in this repository, and
-- NO role held any of them before this migration). `orders:attribution:edit`
-- / `online_orders:*` (also present in the same PERMISSIONS.orders TS array)
-- are explicitly OUT of Task 3b.3 scope and are NOT registered here.
--
-- ══════════════ HARDENING PASS — OWNER-FROZEN ROLE-DEFAULT MATRIX ═══════════
-- Checkpoint A's first pass correctly registered the three keys but withheld
-- backfill, reporting a genuine missing-evidence gap (no frozen role matrix
-- existed anywhere for `orders:*` at that time — unlike task 3b.2's
-- `customers:*` migration, which had one). The owner has now frozen the
-- matrix explicitly (Checkpoint A hardening review, this task):
--
--   OWNER:   orders:view, orders:manage, orders:cancel
--   ADMIN:   orders:view, orders:manage, orders:cancel
--   MANAGER: orders:view, orders:manage, orders:cancel
--   CASHIER: orders:view, orders:manage
--   SALES:   orders:view, orders:manage
--   all other built-in roles: no orders:* key by default
--
-- `orders:cancel` is registered/backfilled as a capability only — Task 3b.3
-- implements NO cancellation endpoint or transition; execution remains Task
-- 3b.8 (matches the identical "register now, no execution surface" pattern
-- already used for `customers:credit:override` in task 3b.2 and
-- `accounting:period:manage`-adjacent keys in task 3b.1).
--
-- Same FORCE-toggle discipline as every prior task's backfill (task 3b.2's
-- `20260918130000_customer_permissions` is the most recent precedent):
-- `flower_migrate` OWNS `role`/`role_permission` but is NOBYPASSRLS, and both
-- tables are FORCE RLS, so even the owner is filtered. Drop FORCE for the two
-- tables inside THIS transaction (no other session can observe the gap — the
-- ALTERs take ACCESS EXCLUSIVE and commit atomically), do the cross-tenant
-- write, then restore FORCE. Idempotent + rerunnable: `ON CONFLICT (roleId,
-- permissionKey) DO NOTHING` can never create a duplicate row. (A
-- `SYSTEM_ROLE_TEMPLATES` update for NEW-tenant provisioning is Checkpoint
-- C's concern, alongside the rest of the Order/Invoice HTTP surface it ships
-- with — no route exists yet for a brand-new tenant to reach.)

-- ── permission registry — register orders:view / orders:manage / orders:cancel
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('orders:view',   'TENANT', 'orders', 'orders view',   3),
  ('orders:manage', 'TENANT', 'orders', 'orders manage', 3),
  ('orders:cancel', 'TENANT', 'orders', 'orders cancel (no execution surface in task 3b.3)', 3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill ───────────────────────────────────────────
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

-- orders:view + orders:manage — owner/admin/manager/cashier/sales
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('orders:view'), ('orders:manage')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'manager', 'cashier', 'sales')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

-- orders:cancel — owner/admin/manager only (Owner-tier + operational
-- management; capability-only, no execution surface until task 3b.8)
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'orders:cancel'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'manager')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
