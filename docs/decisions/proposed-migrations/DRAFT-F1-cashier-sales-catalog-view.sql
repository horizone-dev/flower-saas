-- DRAFT (NOT APPLIED — NOT in packages/db/prisma/migrations) — MVP finding F-1.
-- Grant the read-only `catalog:view` permission to the built-in `cashier` and `sales` system roles.
--
-- WHY: the POS product grid reads GET /v1/catalog/products and the branch effective catalog, both guarded by `catalog:view`. The shipped
-- `cashier` / `sales` templates do not hold it, so a cashier sees an empty catalog. `catalog:view` is READ-ONLY (no catalog:manage,
-- no price/variant/tax write). It is already registered in `permission_registry` and already held by owner / admin / manager.
--
-- NEEDS (owner + S0b): (1) owner approval of this role-matrix change; (2) the matching SYSTEM_ROLE_TEMPLATES change for NEW tenants
-- (DRAFT-F1-system-roles.patch) and the permission-baseline (S0b) facts update; (3) a real migration timestamp/name chosen at apply time.
--
-- Same discipline as 20260920130000_orders_permissions: `role` / `role_permission` are FORCE RLS and `flower_migrate` is NOBYPASSRLS, so FORCE is
-- dropped INSIDE the migration transaction, the cross-tenant write is done, and FORCE is restored. Idempotent (`ON CONFLICT DO NOTHING`).

ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'catalog:view'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('cashier', 'sales')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
