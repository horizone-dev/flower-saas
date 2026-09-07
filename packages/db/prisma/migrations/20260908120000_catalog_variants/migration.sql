-- Phase 3 task 3.4 — Variants + option groups.
-- docs/phase-3/PHASE-3-PLAN.md §C.5 / ADR-0018 §1·3·5. Additive, forward-only.
-- No destructive rewrite. Exactly FOUR new tables — no identifier / SKU / UOM /
-- price / currency / availability / stock / inventory / order table
-- (HG3-NO-PREMATURE-DOMAIN). `variant` carries NO price / currency / sku /
-- base_uom column — ever (D2-2).
--
--   * option_group / option_value / variant / variant_option_value — tenant-
--     owned, RLS ENABLE + FORCE + tenant policy, `flower_app` full DML (tenant
--     business data the Owner writes through runScoped / flower_app; RLS narrows
--     every statement to the request tenant). NO REVOKE.
--   * option_group is INDEPENDENT (owner L-5) — no FK to / copy from
--     attribute_definition.
--   * TENANT-SAFE + SAME-PRODUCT composite FKs (owner §9 / "DB same-product
--     invariant"): every reference is ALSO a composite
--     `(tenantId[, productId], xId) → x(...)` FK so the DB itself rejects
--       - a tenant-A row pointing at a tenant-B row, AND
--       - a variant_option_value whose option group belongs to a different
--         product than its variant, AND
--       - a variant_option_value whose value belongs to a different group.
--     `variant_option_value.productId` is server-populated from the locked
--     variant/product context, never client input.
--   * Partial unique indexes Prisma cannot express:
--       - one logical combination per (tenant, product) among NON-ARCHIVED
--         variants (owner L-7) — archiving keeps the historical signature;
--       - at most one non-archived default variant per product.
--   * BACKFILL (owner "existing product backfill") — every existing STOCKED /
--     BOM product with no variant yet gets exactly one internal default variant
--     (isDefault, optionSignature '', status DRAFT). CUSTOM products get none.
--     Idempotent (NOT EXISTS guard) + FORCE-RLS-safe (toggle inside this txn).
--   * NO security_event change (ordinary catalog CRUD is not a security event —
--     the view already matches only `= 'catalog.template_applied'`, task 3.2).
--   * permission_registry — register the ALREADY-RESERVED `variants:manage` key
--     (idempotent) + assign it to the built-in owner / admin system roles
--     (manager does NOT get it). No key is invented (D2-6).

-- ── CreateTable ─────────────────────────────────────────────────────────────
CREATE TABLE "option_group" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "productId" UUID NOT NULL,
    "key"       TEXT NOT NULL,
    "nameEn"    TEXT NOT NULL,
    "nameAr"    TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version"   INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "option_group_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "option_value" (
    "id"            UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"      UUID NOT NULL,
    "optionGroupId" UUID NOT NULL,
    "value"         TEXT NOT NULL,
    "labelEn"       TEXT NOT NULL,
    "labelAr"       TEXT,
    "sortOrder"     INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "option_value_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "variant" (
    "id"              UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"        UUID NOT NULL,
    "productId"       UUID NOT NULL,
    "nameEn"          TEXT NOT NULL,
    "nameAr"          TEXT,
    "sortOrder"       INTEGER NOT NULL DEFAULT 0,
    "isDefault"       BOOLEAN NOT NULL DEFAULT false,
    "optionSignature" TEXT NOT NULL DEFAULT '',
    "status"          TEXT NOT NULL DEFAULT 'DRAFT',
    "version"         INTEGER NOT NULL DEFAULT 1,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "variant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "variant_option_value" (
    "id"            UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"      UUID NOT NULL,
    "productId"     UUID NOT NULL,
    "variantId"     UUID NOT NULL,
    "optionGroupId" UUID NOT NULL,
    "optionValueId" UUID NOT NULL,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "variant_option_value_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex — uniques ───────────────────────────────────────────────────
-- tenant-safe / same-product FK targets
CREATE UNIQUE INDEX "option_group_tenantId_id_key"           ON "option_group"("tenantId", "id");
CREATE UNIQUE INDEX "option_group_tenantId_productId_id_key" ON "option_group"("tenantId", "productId", "id");
CREATE UNIQUE INDEX "option_group_tenantId_productId_key_key" ON "option_group"("tenantId", "productId", "key");

CREATE UNIQUE INDEX "option_value_tenantId_optionGroupId_value_key"
  ON "option_value"("tenantId", "optionGroupId", "value");
-- target of the "value belongs to the stated group" composite FK
CREATE UNIQUE INDEX "option_value_tenantId_optionGroupId_id_key"
  ON "option_value"("tenantId", "optionGroupId", "id");

CREATE UNIQUE INDEX "variant_tenantId_id_key"           ON "variant"("tenantId", "id");
CREATE UNIQUE INDEX "variant_tenantId_productId_id_key" ON "variant"("tenantId", "productId", "id");
-- one logical option combination per (tenant, product) among NON-ARCHIVED
-- variants (owner L-7). An ARCHIVED variant keeps its historical signature but
-- does not block a new non-archived variant with the same combination.
CREATE UNIQUE INDEX "variant_tenant_product_signature_key"
  ON "variant"("tenantId", "productId", "optionSignature") WHERE "status" <> 'ARCHIVED';
-- at most one non-archived default variant per product
CREATE UNIQUE INDEX "variant_one_default_key"
  ON "variant"("tenantId", "productId") WHERE "isDefault" AND "status" <> 'ARCHIVED';

CREATE UNIQUE INDEX "variant_option_value_tenantId_variantId_optionGroupId_key"
  ON "variant_option_value"("tenantId", "variantId", "optionGroupId");

-- ── CreateIndex — lookups ───────────────────────────────────────────────────
CREATE INDEX "option_group_tenantId_productId_idx"          ON "option_group"("tenantId", "productId");
CREATE INDEX "option_value_tenantId_optionGroupId_idx"      ON "option_value"("tenantId", "optionGroupId");
CREATE INDEX "variant_tenantId_productId_idx"               ON "variant"("tenantId", "productId");
CREATE INDEX "variant_tenantId_status_idx"                  ON "variant"("tenantId", "status");
CREATE INDEX "variant_option_value_tenantId_variantId_idx"  ON "variant_option_value"("tenantId", "variantId");
CREATE INDEX "variant_option_value_tenantId_optionValueId_idx" ON "variant_option_value"("tenantId", "optionValueId");
CREATE INDEX "variant_option_value_tenantId_productId_idx"  ON "variant_option_value"("tenantId", "productId");
CREATE INDEX "variant_option_value_tenantId_optionGroupId_idx" ON "variant_option_value"("tenantId", "optionGroupId");

-- ── CHECK constraints (extensible enumerations = text + CHECK — DB-CONVENTIONS) ─
ALTER TABLE "option_group"
  ADD CONSTRAINT "option_group_key_chk" CHECK ("key" ~ '^[A-Z][A-Z0-9_]{1,63}$');

ALTER TABLE "option_value"
  ADD CONSTRAINT "option_value_value_chk"
    CHECK ("value" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$');

ALTER TABLE "variant"
  ADD CONSTRAINT "variant_status_chk" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  -- the default variant has no option selections and the empty canonical
  -- signature (owner L-8; service + tests also enforce zero child rows)
  ADD CONSTRAINT "variant_default_signature_chk"
    CHECK (NOT "isDefault" OR "optionSignature" = '');

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- tenant ownership + cascade (no Prisma relation on this axis)
ALTER TABLE "option_group"
  ADD CONSTRAINT "option_group_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "option_value"
  ADD CONSTRAINT "option_value_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "variant"
  ADD CONSTRAINT "variant_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- single-column references (match the Prisma `@relation`s). A product's
-- structural children (option groups, variants) are removed with it — a product
-- is hard-deletable only while DRAFT (R-8) and a DRAFT product has no ACTIVE
-- variants (owner L-9), so nothing sellable is lost.
ALTER TABLE "option_group"
  ADD CONSTRAINT "option_group_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "product"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "option_value"
  ADD CONSTRAINT "option_value_optionGroupId_fkey"
  FOREIGN KEY ("optionGroupId") REFERENCES "option_group"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "variant"
  ADD CONSTRAINT "variant_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "product"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "variant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_optionGroupId_fkey"
  FOREIGN KEY ("optionGroupId") REFERENCES "option_group"("id") ON UPDATE CASCADE ON DELETE NO ACTION;
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_optionValueId_fkey"
  FOREIGN KEY ("optionValueId") REFERENCES "option_value"("id") ON UPDATE CASCADE ON DELETE NO ACTION;
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "product"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- TENANT-SAFE composite FKs (owner §9) — a row can only ever reference a catalog
-- row IN THE SAME TENANT.
ALTER TABLE "option_group"
  ADD CONSTRAINT "option_group_tenant_product_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "product"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "option_value"
  ADD CONSTRAINT "option_value_tenant_group_fkey"
  FOREIGN KEY ("tenantId", "optionGroupId") REFERENCES "option_group"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "variant"
  ADD CONSTRAINT "variant_tenant_product_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "product"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE CASCADE;

-- SAME-PRODUCT + tenant-safe composite FKs on variant_option_value (owner "DB
-- same-product invariant"): the variant AND the option group must both belong to
-- the SAME (tenant, product); the option value must belong to the stated group.
-- NO ACTION (deferred to end-of-statement) so a product-delete cascade — which
-- removes the variant_option_value rows via `productId` — is not blocked by a
-- transient ordering of the option_group / variant cascades.
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_tenant_product_variant_fkey"
  FOREIGN KEY ("tenantId", "productId", "variantId")
  REFERENCES "variant"("tenantId", "productId", "id")
  ON UPDATE CASCADE ON DELETE NO ACTION;
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_tenant_product_group_fkey"
  FOREIGN KEY ("tenantId", "productId", "optionGroupId")
  REFERENCES "option_group"("tenantId", "productId", "id")
  ON UPDATE CASCADE ON DELETE NO ACTION;
ALTER TABLE "variant_option_value"
  ADD CONSTRAINT "variant_option_value_group_value_fkey"
  FOREIGN KEY ("tenantId", "optionGroupId", "optionValueId")
  REFERENCES "option_value"("tenantId", "optionGroupId", "id")
  ON UPDATE CASCADE ON DELETE NO ACTION;

-- ── grants for the DB roles ─────────────────────────────────────────────────
GRANT ALL ON "option_group", "option_value", "variant", "variant_option_value" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "option_group", "option_value", "variant", "variant_option_value" TO flower_platform;
-- full DML — tenant business data written by the Owner via runScoped / flower_app;
-- RLS then narrows every statement to the request tenant. NO REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "option_group", "option_value", "variant", "variant_option_value" TO flower_app;

-- ── Row-Level Security — ENABLE + policy now; FORCE after the backfill ───────
ALTER TABLE "option_group" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "option_group_tenant_isolation" ON "option_group"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "option_value" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "option_value_tenant_isolation" ON "option_value"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "variant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "variant_tenant_isolation" ON "variant"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "variant_option_value" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "variant_option_value_tenant_isolation" ON "variant_option_value"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ── deterministic default-variant backfill (owner "existing product backfill") ─
-- Every existing STOCKED / BOM product with no variant yet gets exactly one
-- internal default variant. CUSTOM products get none. Product lifecycle is
-- untouched. The default variant is DRAFT regardless of the product's status —
-- "ACTIVE" is a variant-definition state, decided by the Owner later; the
-- structural activation gate (owner L-10) only needs a NON-ARCHIVED variant.
--
-- In production `prisma migrate deploy` runs as `flower_migrate` (NOBYPASSRLS),
-- which owns these tables but is filtered by FORCE RLS on `product`. Drop FORCE
-- on `product` for this INSERT ... SELECT (no other session observes the gap —
-- ACCESS EXCLUSIVE, atomic in this txn), then restore it. `variant` is not yet
-- FORCEd (added below) so the owner INSERT is unfiltered. Idempotent: the
-- NOT EXISTS guard means a re-run inserts nothing.
ALTER TABLE "product" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "variant"
  ("id", "tenantId", "productId", "nameEn", "nameAr", "isDefault", "optionSignature", "status", "updatedAt")
SELECT uuidv7(), p."tenantId", p."id", p."nameEn", p."nameAr", true, '', 'DRAFT', now()
  FROM "product" p
 WHERE p."fulfilmentStrategy" IN ('STOCKED', 'BOM')
   AND NOT EXISTS (SELECT 1 FROM "variant" v WHERE v."productId" = p."id");

ALTER TABLE "product" FORCE ROW LEVEL SECURITY;

-- ── FORCE RLS on every new tenant-owned table (plan §C.11) ──────────────────
ALTER TABLE "option_group"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "option_value"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "variant"              FORCE ROW LEVEL SECURITY;
ALTER TABLE "variant_option_value" FORCE ROW LEVEL SECURITY;

-- ── permission registry — register the reserved `variants:manage` key ───────
-- Not a new key (D2-6 / HG3-PERMISSION-STABILITY): it has existed in
-- @flower/permissions PERMISSIONS.catalog since Phase 0. Registering it
-- (idempotent) means the tenant role-assignment / grantability checks accept it
-- in every environment; prisma/seed.ts upserts the same row for a fresh DB.
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES ('variants:manage', 'TENANT', 'catalog', 'variants manage', 3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill (owner L-17) ─────────────────────────────
-- Existing tenants: owner + admin gain `variants:manage`. Manager does NOT
-- (mirrors `catalog:manage`, task 3.2 R-1). ONLY isSystem = true owner/admin
-- roles — custom / user-created roles, explicit grants and deny grants are NEVER
-- touched. Idempotent + rerunnable via ON CONFLICT (roleId, permissionKey).
-- FORCE-toggle so a NOBYPASSRLS `flower_migrate` can write cross-tenant; restore
-- FORCE before the migration commits. `SYSTEM_ROLE_TEMPLATES` is updated in the
-- same task so NEW tenants get the key at provisioning without any backfill.
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'variants:manage'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
