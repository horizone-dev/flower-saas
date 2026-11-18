-- DRAFT B — NOT APPLIED, NOT IN packages/db/prisma/migrations. A PROPOSAL for owner approval (decision sheet E-1 / P-2 / N6).
-- Permission registry + system-role backfill ONLY (exact precedent: 20261204120000_phase_4_device_permissions). NO schema change.
-- The six `cash_register:*` keys already exist in the TypeScript vocabulary and the S0b baseline but are policy-disabled and have no registry
-- row, so none is grantable to ANY role today. This draft registers them and grants a RECOMMENDED minimum matrix (the owner may change it):
--   OWNER   : cash_register:open, view, close, cash_in, cash_out, override
--   CASHIER : cash_register:open, view, close, cash_in          (cash_out only once a payout / safe-drop policy is approved: decisions B-1, C-2)
--   every other system role (incl. MANAGER, ADMIN, SUPERVISOR): NOTHING  (E-1 A: Manager none until limits and approval rules exist)
-- `cash_register:override` (the approver key) is Owner-only; every key keeps the `cash_register:` prefix, so the registered-device guard demands
-- a verified device for each route (correct for a drawer operation). Step-up for money movements is a CODE change (`STEP_UP_PERMISSIONS`).
--
-- COMPANION TypeScript changes (the S0b pins demand them in the SAME reviewed diff; NOT made here):
--   1. apps/api/src/verification/permission-baseline.ts: CASH_REGISTER_ENABLEMENT.registrySeeding = true and roleGrants = the matrix above;
--      HARD_DISABLED_ROLE_GRANTS stays for every other role; a new AUTHORIZED_PERMISSION_CHANGES entry (facts + SHA-256 of the changed files);
--   2. packages/permissions: add the money keys to STEP_UP_PERMISSIONS; role templates for owner / cashier.
-- Rollback: DELETE the role_permission rows then the registry rows for these six keys (safe while no custom role has been granted one).

INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('cash_register:open',     'TENANT', 'cashRegister', 'cash register open',     4),
  ('cash_register:view',     'TENANT', 'cashRegister', 'cash register view',     4),
  ('cash_register:close',    'TENANT', 'cashRegister', 'cash register close',    4),
  ('cash_register:cash_in',  'TENANT', 'cashRegister', 'cash register cash in',  4),
  ('cash_register:cash_out', 'TENANT', 'cashRegister', 'cash register cash out', 4),
  ('cash_register:override', 'TENANT', 'cashRegister', 'cash register override', 4)
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", g."key"
  FROM "role" r
  JOIN (VALUES
          ('owner',   'cash_register:open'),    ('owner',   'cash_register:view'),     ('owner',   'cash_register:close'),
          ('owner',   'cash_register:cash_in'), ('owner',   'cash_register:cash_out'), ('owner',   'cash_register:override'),
          ('cashier', 'cash_register:open'),    ('cashier', 'cash_register:view'),     ('cashier', 'cash_register:close'),
          ('cashier', 'cash_register:cash_in')
       ) AS g("roleKey", "key") ON g."roleKey" = r."key"
 WHERE r."isSystem" = true
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
