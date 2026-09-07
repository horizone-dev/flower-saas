-- Phase 3 task 3.3 — Typed attribute templates + values.
-- docs/phase-3/PHASE-3-PLAN.md §C.4 / ADR-0018 §6 + risk 3. Additive,
-- forward-only. No destructive rewrite. Exactly three new tables — no
-- option-group / variant / identifier / uom / price / stock / inventory / order
-- table (HG3-NO-PREMATURE-DOMAIN).
--
--   * attribute_definition / attribute_option / product_attribute_value —
--     tenant-owned, RLS ENABLE + FORCE + tenant policy, `flower_app` full DML
--     (Owner-written business data), RLS narrows to the request tenant.
--   * STRONGLY TYPED, no schemaless JSON: `value_type` is a closed 5-value CHECK
--     set (TEXT | NUMBER | ENUM | BOOLEAN | DATE); `product_attribute_value` has
--     one typed column per type + a CHECK that exactly one is populated.
--   * Tenant-safe composite FKs everywhere: every intra-catalog reference is
--     `(tenantId, xId) → x(tenantId, id)` backed by a UNIQUE (tenantId, id) — the
--     DB itself rejects a tenant-A row that points at a tenant-B row.
--   * DATA-INTEGRITY RULE 1 — the ENUM composite FK
--     `(tenantId, attributeDefinitionId, optionId) →
--      attribute_option(tenantId, attributeDefinitionId, id)` proves at the DB
--     that an ENUM value's option belongs to the SAME definition (and tenant),
--     never one from another definition even within one tenant.
--   * ONE additive index on an existing table: UNIQUE (product.tenantId, id) —
--     backs the product_attribute_value tenant-safe FK (D2-12: additive-only).
--   * NO security_event change (ordinary catalog CRUD is not a security event —
--     the view already matches only `= 'catalog.template_applied'`, task 3.2).
--   * NO permission_registry / system-role change — attributes reuse
--     catalog:view / catalog:manage (registered + assigned in task 3.2).

-- ── AlterTable: the one additive index on `product` ─────────────────────────
CREATE UNIQUE INDEX "product_tenantId_id_key" ON "product"("tenantId", "id");

-- ── CreateTable ─────────────────────────────────────────────────────────────
CREATE TABLE "attribute_definition" (
    "id"                     UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"               UUID NOT NULL,
    "key"                    TEXT NOT NULL,
    "nameEn"                 TEXT NOT NULL,
    "nameAr"                 TEXT,
    "valueType"              TEXT NOT NULL,
    "appliesToCategoryId"    UUID,
    "appliesToProductTypeId" UUID,
    "unitHint"               TEXT,
    "isVariantOption"        BOOLEAN NOT NULL DEFAULT false,
    "required"               BOOLEAN NOT NULL DEFAULT false,
    "status"                 TEXT NOT NULL DEFAULT 'ACTIVE',
    "version"                INTEGER NOT NULL DEFAULT 1,
    "createdAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_definition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attribute_option" (
    "id"                    UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"              UUID NOT NULL,
    "attributeDefinitionId" UUID NOT NULL,
    "value"                 TEXT NOT NULL,
    "labelEn"               TEXT NOT NULL,
    "labelAr"               TEXT,
    "sortOrder"             INTEGER NOT NULL DEFAULT 0,
    "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_option_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_attribute_value" (
    "id"                    UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"              UUID NOT NULL,
    "productId"             UUID NOT NULL,
    "attributeDefinitionId" UUID NOT NULL,
    "valueText"             TEXT,
    "valueNumber"           DECIMAL(18,4),
    "valueBool"             BOOLEAN,
    "valueDate"             DATE,
    "optionId"              UUID,
    "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_attribute_value_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex — uniques ───────────────────────────────────────────────────
-- tenant-safe FK targets: UNIQUE (tenantId, id)
CREATE UNIQUE INDEX "attribute_definition_tenantId_id_key" ON "attribute_definition"("tenantId", "id");

CREATE UNIQUE INDEX "attribute_definition_tenantId_key_key" ON "attribute_definition"("tenantId", "key");

CREATE UNIQUE INDEX "attribute_option_tenantId_attributeDefinitionId_value_key"
  ON "attribute_option"("tenantId", "attributeDefinitionId", "value");
-- target of the ENUM composite FK (data-integrity rule 1)
CREATE UNIQUE INDEX "attribute_option_tenantId_attributeDefinitionId_id_key"
  ON "attribute_option"("tenantId", "attributeDefinitionId", "id");

CREATE UNIQUE INDEX "product_attribute_value_tenantId_productId_attributeDefinitionId_key"
  ON "product_attribute_value"("tenantId", "productId", "attributeDefinitionId");

-- ── CreateIndex — lookups ───────────────────────────────────────────────────
CREATE INDEX "attribute_definition_tenantId_appliesToCategoryId_idx"    ON "attribute_definition"("tenantId", "appliesToCategoryId");
CREATE INDEX "attribute_definition_tenantId_appliesToProductTypeId_idx" ON "attribute_definition"("tenantId", "appliesToProductTypeId");
CREATE INDEX "attribute_definition_tenantId_status_idx"                 ON "attribute_definition"("tenantId", "status");
CREATE INDEX "attribute_definition_tenantId_isVariantOption_idx"        ON "attribute_definition"("tenantId", "isVariantOption");
CREATE INDEX "attribute_option_tenantId_attributeDefinitionId_idx"      ON "attribute_option"("tenantId", "attributeDefinitionId");
CREATE INDEX "product_attribute_value_tenantId_productId_idx"           ON "product_attribute_value"("tenantId", "productId");
CREATE INDEX "product_attribute_value_tenantId_attributeDefinitionId_idx" ON "product_attribute_value"("tenantId", "attributeDefinitionId");
CREATE INDEX "product_attribute_value_tenantId_optionId_idx"            ON "product_attribute_value"("tenantId", "optionId");

-- ── CHECK constraints ──────────────────────────────────────────────────────
ALTER TABLE "attribute_definition"
  ADD CONSTRAINT "attribute_definition_value_type_chk"
    CHECK ("valueType" IN ('TEXT', 'NUMBER', 'ENUM', 'BOOLEAN', 'DATE')),
  ADD CONSTRAINT "attribute_definition_status_chk"
    CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  ADD CONSTRAINT "attribute_definition_key_chk"
    CHECK ("key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- at most one scope ref (owner K.7)
  ADD CONSTRAINT "attribute_definition_scope_chk"
    CHECK (NOT ("appliesToCategoryId" IS NOT NULL AND "appliesToProductTypeId" IS NOT NULL));

-- exactly one typed value column populated (data-integrity rule 3 — the DB
-- part; the type↔column match + option-belongs-to-definition are service +
-- the ENUM composite FK below).
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_one_value_chk"
    CHECK (
      (CASE WHEN "valueText"   IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "valueNumber" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "valueBool"   IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "valueDate"   IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "optionId"    IS NOT NULL THEN 1 ELSE 0 END) = 1
    );

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- tenant ownership + cascade (raw — no Prisma relation on this axis)
ALTER TABLE "attribute_definition"
  ADD CONSTRAINT "attribute_definition_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "attribute_option"
  ADD CONSTRAINT "attribute_option_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- single-column references (match the Prisma `@relation`s)
ALTER TABLE "attribute_definition"
  ADD CONSTRAINT "attribute_definition_appliesToCategoryId_fkey"
  FOREIGN KEY ("appliesToCategoryId") REFERENCES "category"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "attribute_definition"
  ADD CONSTRAINT "attribute_definition_appliesToProductTypeId_fkey"
  FOREIGN KEY ("appliesToProductTypeId") REFERENCES "product_type"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "attribute_option"
  ADD CONSTRAINT "attribute_option_attributeDefinitionId_fkey"
  FOREIGN KEY ("attributeDefinitionId") REFERENCES "attribute_definition"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "product"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_attributeDefinitionId_fkey"
  FOREIGN KEY ("attributeDefinitionId") REFERENCES "attribute_definition"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_optionId_fkey"
  FOREIGN KEY ("optionId") REFERENCES "attribute_option"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- TENANT-SAFE composite FKs — a row can only ever reference a catalog row IN THE
-- SAME TENANT. Nullable refs with a NULL are simply not checked (MATCH SIMPLE).
ALTER TABLE "attribute_definition"
  ADD CONSTRAINT "attribute_definition_tenant_category_fkey"
  FOREIGN KEY ("tenantId", "appliesToCategoryId") REFERENCES "category"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "attribute_definition"
  ADD CONSTRAINT "attribute_definition_tenant_product_type_fkey"
  FOREIGN KEY ("tenantId", "appliesToProductTypeId") REFERENCES "product_type"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "attribute_option"
  ADD CONSTRAINT "attribute_option_tenant_definition_fkey"
  FOREIGN KEY ("tenantId", "attributeDefinitionId") REFERENCES "attribute_definition"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_tenant_product_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "product"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_tenant_definition_fkey"
  FOREIGN KEY ("tenantId", "attributeDefinitionId") REFERENCES "attribute_definition"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- DATA-INTEGRITY RULE 1 — the ENUM value's option MUST belong to the same
-- definition (and tenant). When optionId IS NULL (a non-ENUM value) MATCH SIMPLE
-- skips this; when set, all three columns are non-null and the option is
-- required to exist with exactly that (tenantId, attributeDefinitionId).
ALTER TABLE "product_attribute_value"
  ADD CONSTRAINT "product_attribute_value_enum_option_fkey"
  FOREIGN KEY ("tenantId", "attributeDefinitionId", "optionId")
  REFERENCES "attribute_option"("tenantId", "attributeDefinitionId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── grants for the DB roles ─────────────────────────────────────────────────
GRANT ALL ON "attribute_definition", "attribute_option", "product_attribute_value" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "attribute_definition", "attribute_option", "product_attribute_value" TO flower_platform;
-- full DML — tenant business data written by the Owner via runScoped / flower_app;
-- RLS then narrows every statement to the request tenant. NO REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "attribute_definition", "attribute_option", "product_attribute_value" TO flower_app;

-- ── Row-Level Security — every new table (plan §C.11) ───────────────────────
ALTER TABLE "attribute_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attribute_definition" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attribute_definition_tenant_isolation" ON "attribute_definition"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "attribute_option" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attribute_option" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attribute_option_tenant_isolation" ON "attribute_option"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "product_attribute_value" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_attribute_value" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_attribute_value_tenant_isolation" ON "product_attribute_value"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
