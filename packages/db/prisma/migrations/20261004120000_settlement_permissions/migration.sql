-- Phase 3b task 3b.7 CHECKPOINT C — Settlement DRAFT ingestion/matching:
-- permission registration + built-in system-role backfill. No schema change
-- — activates the 3 `settlements` keys just added as a brand new group in
-- `@flower/permissions` PERMISSIONS.settlements (confirmed by direct
-- inspection: none of these three keys appear in any prior migration's
-- `permission_registry` INSERT anywhere in this repository, and no role held
-- any of them before this migration).
--
-- ══════════════ OWNER-FROZEN ROLE-DEFAULT MATRIX ═══════════════════════════
--   OWNER:      settlements:view, settlements:manage, settlements:finalize
--   ADMIN:      settlements:view, settlements:manage, settlements:finalize
--   ACCOUNTANT: settlements:view, settlements:manage, settlements:finalize
--   MANAGER:    settlements:view, settlements:manage
--   CASHIER:    (none)
--   SALES:      (none)
--   all other built-in roles: no settlements:* key by default
--
-- This is the FIRST real permission grant to the `accountant` system role —
-- verified present in `system-roles.ts` before this migration (previously
-- `users:view` only, unchanged by any prior migration). `settlements:finalize`
-- is step-up gated (`STEP_UP_PERMISSIONS` in `@flower/permissions`, code
-- change only — no migration effect) — it is the permission that will
-- eventually gate creating a SettlementApplication/GL/Invoice-SETTLED effect
-- (Checkpoint D); no finalize route exists yet. `settlements:view`/
-- `settlements:manage` are NOT step-up gated.
--
-- Same FORCE-toggle discipline as every prior task's backfill (task 3b.6's
-- `20260928140000_receivables_permissions` is the most recent precedent):
-- `flower_migrate` OWNS `role`/`role_permission` but is NOBYPASSRLS, and both
-- tables are FORCE RLS, so even the owner is filtered. Drop FORCE for the two
-- tables inside THIS transaction (no other session can observe the gap — the
-- ALTERs take ACCESS EXCLUSIVE and commit atomically), do the cross-tenant
-- write, then restore FORCE. Idempotent + rerunnable: `ON CONFLICT (roleId,
-- permissionKey) DO NOTHING` can never create a duplicate row. The
-- `SYSTEM_ROLE_TEMPLATES` update for NEW-tenant provisioning is included in
-- the same code change as this migration (`system-roles.ts`) — Checkpoint C
-- has no finalize HTTP surface either, so granting `settlements:finalize`
-- early to new tenants is harmless (matches the "register now, no execution
-- surface yet" pattern already used for `customers:credit:override` in 3b.2
-- and `receivables:opening_balance:manage`... this task's OWN `settlements:manage`/
-- `settlements:view` DO have a live execution surface as of this checkpoint).

-- ── permission registry — register the 3 settlements:* keys ─────────────────
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('settlements:view',     'TENANT', 'settlements', 'settlements view',     3),
  ('settlements:manage',   'TENANT', 'settlements', 'settlements manage',   3),
  ('settlements:finalize', 'TENANT', 'settlements', 'settlements finalize', 3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill ───────────────────────────────────────────
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

-- settlements:view + settlements:manage — owner/admin/accountant/manager
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('settlements:view'), ('settlements:manage')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'accountant', 'manager')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

-- settlements:finalize — owner/admin/accountant ONLY (NOT manager)
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'settlements:finalize'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'accountant')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
