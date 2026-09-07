-- Phase 3 task 3.5 — Identifiers (SKU / barcode / QR).
-- docs/phase-3/PHASE-3-PLAN.md §C.6 / ADR-0018 §5·7. Additive, forward-only.
-- No destructive rewrite. Exactly ONE new table — `item_identifier`. NO
-- pack UOM / price / currency / stock / inventory / company / branch column
-- (HG3-NO-PREMATURE-DOMAIN / HG3-CATALOG-SCOPE-SEPARATION). `targetKind` is
-- VARIANT-only (owner decision 1) — `INVENTORY_ITEM` stays a documented reserved
-- future value with no table (D2-11); a Phase-5 migration widens the CHECK once
-- referential integrity to `inventory_item` can be added.
--
--   * item_identifier — tenant-owned, RLS ENABLE + FORCE + tenant policy,
--     `flower_app` full DML (tenant business data the Owner writes through
--     runScoped / flower_app; RLS narrows every statement to the request
--     tenant). NO REVOKE.
--   * DB-enforced tenant-safe VARIANT target integrity (owner decision 6): a
--     server-derived `targetVariantId` GENERATED ALWAYS ... STORED column (the
--     client can never set it independently) + a composite FK
--     `(tenantId, targetVariantId) → variant(tenantId, id)` ON DELETE RESTRICT.
--     RESTRICT (never CASCADE): once a variant has an identifier it cannot be
--     deleted / restructured away — the DB is the final backstop behind the
--     service's `VARIANT_HAS_IDENTIFIERS` 409.
--   * Uniqueness (owner decisions 2 / 3):
--       - UNIQUE (tenantId, value) — spans EVERY code type AND both statuses; a
--         deactivated value is reserved to its historical row forever and is
--         never reused for another target.
--       - partial UNIQUE — at most one ACTIVE SKU per (tenant, target).
--       - partial UNIQUE — at most one ACTIVE QR per (tenant, target).
--       - multiple ACTIVE BARCODE rows per target are allowed (each value still
--         tenant-unique).
--   * NO identifier-value backfill — existing variants get no invented SKU / QR.
--   * NO security_event change (ordinary catalog CRUD is not a security event —
--     the view already matches only `= 'catalog.template_applied'`, task 3.2).
--   * permission_registry — register the ALREADY-RESERVED `identifiers:manage`
--     key (D2-6 / HG3-PERMISSION-STABILITY: it has existed in
--     @flower/permissions PERMISSIONS.inventory since Phase 0; not renamed,
--     moved out of its `inventory` group, or duplicated) + assign it to the
--     built-in owner / admin system roles (manager does NOT get it — mirrors
--     `catalog:manage` / `variants:manage`).

-- ── CreateTable ─────────────────────────────────────────────────────────────
CREATE TABLE "item_identifier" (
    "id"         UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"   UUID NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId"   UUID NOT NULL,
    "codeType"   TEXT NOT NULL,
    "value"      TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMPTZ(6) NOT NULL,
    -- server-derived shadow FK column (owner decision 6). GENERATED ALWAYS ⇒
    -- the client can NEVER set it independently; it equals `targetId` when the
    -- row targets a VARIANT and is NULL otherwise. The composite FK below hangs
    -- off it so future `INVENTORY_ITEM` support (a second generated column + FK)
    -- is purely additive — this FK is never dropped.
    "targetVariantId" UUID GENERATED ALWAYS AS
        (CASE WHEN "targetKind" = 'VARIANT' THEN "targetId" END) STORED,

    CONSTRAINT "item_identifier_pkey" PRIMARY KEY ("id")
);

-- ── CHECK constraints (extensible enumerations = text + CHECK — DB-CONVENTIONS) ─
ALTER TABLE "item_identifier"
  -- owner decision 1 — VARIANT is the ONLY legal target kind in Phase 3a.
  ADD CONSTRAINT "item_identifier_target_kind_chk" CHECK ("targetKind" IN ('VARIANT')),
  ADD CONSTRAINT "item_identifier_code_type_chk"   CHECK ("codeType" IN ('SKU', 'BARCODE', 'QR')),
  ADD CONSTRAINT "item_identifier_status_chk"      CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
  -- bounded, trimmed, no control characters (owner "BARCODE SEMANTICS"). The
  -- per-code-type shape (SKU token grammar, QR opacity) is the service's job;
  -- this is the DB floor.
  ADD CONSTRAINT "item_identifier_value_chk" CHECK (
        char_length("value") BETWEEN 1 AND 128
    AND "value" !~ '^\s'
    AND "value" !~ '\s$'
    AND "value" !~ '[[:cntrl:]]'
  );

-- ── CreateIndex — uniques ───────────────────────────────────────────────────
-- owner decision 3 — one scanned value resolves to exactly one row, forever,
-- regardless of code type or status.
CREATE UNIQUE INDEX "item_identifier_tenantId_value_key"
  ON "item_identifier"("tenantId", "value");
-- owner decision 2 — at most one ACTIVE SKU per (tenant, target).
CREATE UNIQUE INDEX "item_identifier_one_active_sku_key"
  ON "item_identifier"("tenantId", "targetKind", "targetId")
  WHERE "codeType" = 'SKU' AND "status" = 'ACTIVE';
-- owner "QR SEMANTICS" — at most one ACTIVE QR per (tenant, target). 100 printed
-- QR labels for one variant is the SAME QR value printed 100 times.
CREATE UNIQUE INDEX "item_identifier_one_active_qr_key"
  ON "item_identifier"("tenantId", "targetKind", "targetId")
  WHERE "codeType" = 'QR' AND "status" = 'ACTIVE';

-- ── CreateIndex — lookups ───────────────────────────────────────────────────
CREATE INDEX "item_identifier_tenantId_targetKind_targetId_idx"
  ON "item_identifier"("tenantId", "targetKind", "targetId");
-- FK index (every FK is indexed — DB-CONVENTIONS).
CREATE INDEX "item_identifier_tenantId_targetVariantId_idx"
  ON "item_identifier"("tenantId", "targetVariantId");

-- ── Foreign keys ────────────────────────────────────────────────────────────
ALTER TABLE "item_identifier"
  ADD CONSTRAINT "item_identifier_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- tenant-safe existence RI for the VARIANT target (owner §9 / decision 6). The
-- reference is ALSO tenant-keyed, so the DB rejects a tenant-A identifier that
-- points at a tenant-B variant. ON DELETE RESTRICT — NOT CASCADE: deleting or
-- restructuring a variant that still has an identifier must not silently erase
-- printed-code history (owner "TASK 3.4 DEFAULT-VARIANT RESTRUCTURE GUARD").
-- ON UPDATE NO ACTION — Postgres forbids a cascading ON UPDATE on a FK whose
-- referencing column is GENERATED, and `variant(tenantId, id)` (uuidv7 PK +
-- tenant FK) is never updated in practice anyway.
ALTER TABLE "item_identifier"
  ADD CONSTRAINT "item_identifier_tenant_variant_fkey"
  FOREIGN KEY ("tenantId", "targetVariantId") REFERENCES "variant"("tenantId", "id")
  ON UPDATE NO ACTION ON DELETE RESTRICT;

-- ── grants for the DB roles ─────────────────────────────────────────────────
GRANT ALL ON "item_identifier" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "item_identifier" TO flower_platform;
-- full DML — tenant business data written by the Owner via runScoped / flower_app;
-- RLS then narrows every statement to the request tenant. NO REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON "item_identifier" TO flower_app;

-- ── Row-Level Security — ENABLE + policy + FORCE (plan §C.11) ────────────────
ALTER TABLE "item_identifier" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "item_identifier_tenant_isolation" ON "item_identifier"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "item_identifier" FORCE ROW LEVEL SECURITY;

-- ── permission registry — register the reserved `identifiers:manage` key ────
-- Not a new key (D2-6 / HG3-PERMISSION-STABILITY): it has existed in
-- @flower/permissions PERMISSIONS.inventory since Phase 0. Registering it
-- (idempotent) means the tenant role-assignment / grantability checks accept it
-- in every environment; prisma/seed.ts upserts the same row for a fresh DB. The
-- `inventory` group is display metadata — unchanged (owner I.5).
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES ('identifiers:manage', 'TENANT', 'inventory', 'identifiers manage', 3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill (owner "PERMISSIONS") ─────────────────────
-- Existing tenants: owner + admin gain `identifiers:manage`. Manager does NOT
-- (mirrors `catalog:manage` / `variants:manage`). ONLY isSystem = true
-- owner/admin roles — custom / user-created roles, explicit grants and deny
-- grants are NEVER touched. Idempotent + rerunnable via
-- ON CONFLICT (roleId, permissionKey). FORCE-toggle so a NOBYPASSRLS
-- `flower_migrate` can write cross-tenant; FORCE restored before commit.
-- `SYSTEM_ROLE_TEMPLATES` is updated in the same task so NEW tenants get the key
-- at provisioning without any backfill.
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'identifiers:manage'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
