-- Phase 3b task 3b.8 Checkpoint C — CancellationCharge financial permission.
-- Owner-frozen decision (Checkpoint C owner review): a dedicated tenant
-- permission, `cancellation_charges:issue`, is the financial authority for
-- issuing a CancellationCharge — NEVER `credit_notes:issue` (a different
-- document/authority), NEVER `refunds:execute` (also a different document/
-- authority), NEVER bare `orders:manage`, and NEVER the never-implemented
-- `cancellation_charge:override` name from the pre-implementation Phase 3b
-- planning doc. CancellationCharge is its own financial document and
-- authority — Credit Note and Refund must not be implicitly coupled to it.
--
-- No schema/business-table change — permission registry + system-role
-- backfill ONLY. Migration 44 (`20261005120000_phase_3b8_credit_refund_core`)
-- is NOT modified; migrations 1-44 remain untouched.
--
-- Mirrors the exact `20261005120000_phase_3b8_credit_refund_core` /
-- `20261004120000_settlement_permissions` precedent (FORCE-toggle
-- discipline, `ON CONFLICT DO NOTHING` idempotency, `addedInPhase = 3`
-- matching every other Phase 3 permission registration).
--
-- ══════════════ OWNER-FROZEN ROLE-DEFAULT MATRIX ═══════════════════════════
--   OWNER:      cancellation_charges:issue
--   ADMIN:      cancellation_charges:issue
--   ACCOUNTANT: cancellation_charges:issue
--   MANAGER:    cancellation_charges:issue
--   CASHIER:    (none)
--   SALES:      (none)
--   all other built-in roles: no cancellation_charges:* key by default
--
-- `cancellation_charges:issue` is step-up gated (`STEP_UP_PERMISSIONS` in
-- `@flower/permissions`, code change only — no migration effect, mirrors
-- `settlements:finalize`'s identical code-only step-up wiring). Issuing a
-- CancellationCharge requires `orders:cancel` AND `cancellation_charges:issue`
-- AND step-up — `orders:cancel` alone (already registered/backfilled since
-- `20260920130000_orders_permissions`) remains the complete, sufficient
-- authority for the no-charge cancellation path, untouched by this migration.

-- ── permission registry — register the 1 new key ────────────────────────────
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('cancellation_charges:issue', 'TENANT', 'cancellation_charges', 'cancellation charges issue', 3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill ───────────────────────────────────────────
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

-- cancellation_charges:issue — owner/admin/accountant/manager ONLY (owner-frozen).
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'cancellation_charges:issue'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'accountant', 'manager')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
