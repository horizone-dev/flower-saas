-- Phase 3 task 3.6 — UOM registry + product/variant-scoped pack conversions.
-- docs/phase-3/PHASE-3-PLAN.md §C.7 / ADR-0018 / D0-1. Additive, forward-only.
-- No destructive rewrite. Exactly TWO new tables (`uom`, `uom_conversion`) + a
-- nullable `variant.baseUomCode` column + three nullable `item_identifier` pack
-- columns. NO price / cost / currency / company / branch / stock / inventory
-- column anywhere (HG3-NO-PREMATURE-DOMAIN / D2-11). NO `GLOBAL` conversion
-- scope. NO base-UOM backfill and NO NOT-NULL tightening (OD-2 — `piece` is not
-- a safe universal assumption). NO permission_registry / system-role change
-- (`catalog:manage` / `variants:manage` are already registered — tasks 3.2 / 3.4).
--
--   * uom — tenant-owned custom units only (a built-in code is rejected). RLS
--     ENABLE + FORCE + tenant policy, `flower_app` full DML. Semantic fields
--     (code / family / perBase* / maxDecimals) are immutable after create
--     (service-enforced); only the display names are editable.
--   * uom_conversion — VARIANT | PRODUCT scoped, base-anchored (P2 — no graph).
--     Server-derived `scopeVariantId` / `scopeProductId` GENERATED columns +
--     tenant-safe composite FKs so a tenant-A row can never point at a tenant-B
--     variant/product AND a dropped DRAFT variant / hard-deleted product takes
--     its conversion rows with it (ON DELETE CASCADE — pure config, unlike an
--     `item_identifier` printed artifact). Two partial unique indexes Prisma
--     cannot express (one per fromUom for VARIANT; per fromUom+toUom for PRODUCT).
--   * variant.baseUomCode text NULL — the canonical base UOM. Textual reference
--     (built-in OR tenant `uom`), NO DB FK (OD-5 — materialising built-ins per
--     tenant would be a second source of truth); the service validates against
--     `@flower/uom` + a row lock (FOR KEY SHARE) on any tenant-custom code.
--   * item_identifier.packUomCode / packQty / packBaseQty — the IMMUTABLE
--     printed pack-identity snapshot (Task 3.6 §I). `packBaseQty` is computed
--     ONCE with `@flower/uom` `convertExact` and is never recomputed from a
--     later conversion edit. All three NULL together or non-NULL together;
--     forbidden on a SKU.

-- ── CreateTable — uom ───────────────────────────────────────────────────────
CREATE TABLE "uom" (
    "id"          UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"    UUID NOT NULL,
    "code"        TEXT NOT NULL,
    "family"      TEXT NOT NULL,
    "perBaseNum"  BIGINT NOT NULL DEFAULT 1,
    "perBaseDen"  BIGINT NOT NULL DEFAULT 1,
    "maxDecimals" SMALLINT NOT NULL DEFAULT 0,
    "nameEn"      TEXT NOT NULL,
    "nameAr"      TEXT,
    "version"     INTEGER NOT NULL DEFAULT 1,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uom_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "uom"
  ADD CONSTRAINT "uom_family_chk"
    CHECK ("family" IN ('LENGTH', 'MASS', 'VOLUME', 'COUNT', 'EACH')),
  ADD CONSTRAINT "uom_per_base_num_chk"  CHECK ("perBaseNum" > 0),
  ADD CONSTRAINT "uom_per_base_den_chk"  CHECK ("perBaseDen" > 0),
  ADD CONSTRAINT "uom_max_decimals_chk"  CHECK ("maxDecimals" BETWEEN 0 AND 4),
  -- D0-1 — a COUNT unit is strictly discrete
  ADD CONSTRAINT "uom_count_discrete_chk"
    CHECK ("family" <> 'COUNT' OR "maxDecimals" = 0),
  -- an EACH unit has no generic ratio — perBase is forced to 1/1
  ADD CONSTRAINT "uom_each_perbase_chk"
    CHECK ("family" <> 'EACH' OR ("perBaseNum" = 1 AND "perBaseDen" = 1)),
  -- the ONE canonical persisted UOM-code shape (lowercase, no slash — MC-1)
  ADD CONSTRAINT "uom_code_shape_chk"
    CHECK ("code" ~ '^[a-z][a-z0-9._-]{0,31}$');

CREATE UNIQUE INDEX "uom_tenantId_code_key" ON "uom"("tenantId", "code");
CREATE INDEX "uom_tenantId_idx" ON "uom"("tenantId");

-- ── CreateTable — uom_conversion ────────────────────────────────────────────
CREATE TABLE "uom_conversion" (
    "id"          UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"    UUID NOT NULL,
    "scopeKind"   TEXT NOT NULL,
    "scopeId"     UUID NOT NULL,
    "fromUomCode" TEXT NOT NULL,
    "toUomCode"   TEXT NOT NULL,
    "num"         BIGINT NOT NULL,
    "den"         BIGINT NOT NULL DEFAULT 1,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
    -- server-derived shadow FK columns (Task 3.5 generated-column pattern). The
    -- client can NEVER set them independently; they equal `scopeId` for the
    -- matching `scopeKind` and NULL otherwise, so the composite FKs below bind
    -- each row to a same-tenant variant / product.
    "scopeVariantId" UUID GENERATED ALWAYS AS
        (CASE WHEN "scopeKind" = 'VARIANT' THEN "scopeId" END) STORED,
    "scopeProductId" UUID GENERATED ALWAYS AS
        (CASE WHEN "scopeKind" = 'PRODUCT' THEN "scopeId" END) STORED,

    CONSTRAINT "uom_conversion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "uom_conversion"
  -- D0-1 — VARIANT | PRODUCT only; there is NO 'GLOBAL' scope value
  ADD CONSTRAINT "uom_conversion_scope_kind_chk"
    CHECK ("scopeKind" IN ('VARIANT', 'PRODUCT')),
  ADD CONSTRAINT "uom_conversion_num_chk" CHECK ("num" > 0),
  ADD CONSTRAINT "uom_conversion_den_chk" CHECK ("den" > 0),
  ADD CONSTRAINT "uom_conversion_from_ne_to_chk" CHECK ("fromUomCode" <> "toUomCode"),
  ADD CONSTRAINT "uom_conversion_from_shape_chk"
    CHECK ("fromUomCode" ~ '^[a-z][a-z0-9._-]{0,31}$'),
  ADD CONSTRAINT "uom_conversion_to_shape_chk"
    CHECK ("toUomCode" ~ '^[a-z][a-z0-9._-]{0,31}$');

-- VARIANT scope: at most ONE effective explicit conversion per fromUom (the
-- service pins toUom to the variant's baseUomCode).
CREATE UNIQUE INDEX "uom_conversion_variant_from_key"
  ON "uom_conversion"("tenantId", "scopeId", "fromUomCode")
  WHERE "scopeKind" = 'VARIANT';
-- PRODUCT scope: the same fromUom MAY anchor to different toUoms (variants of
-- the product can have different bases — MC-4).
CREATE UNIQUE INDEX "uom_conversion_product_from_to_key"
  ON "uom_conversion"("tenantId", "scopeId", "fromUomCode", "toUomCode")
  WHERE "scopeKind" = 'PRODUCT';

CREATE INDEX "uom_conversion_tenantId_scope_idx"
  ON "uom_conversion"("tenantId", "scopeKind", "scopeId");
CREATE INDEX "uom_conversion_tenantId_scopeVariantId_idx"
  ON "uom_conversion"("tenantId", "scopeVariantId");
CREATE INDEX "uom_conversion_tenantId_scopeProductId_idx"
  ON "uom_conversion"("tenantId", "scopeProductId");

-- ── Foreign keys ────────────────────────────────────────────────────────────
ALTER TABLE "uom"
  ADD CONSTRAINT "uom_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "uom_conversion"
  ADD CONSTRAINT "uom_conversion_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- tenant-safe composite FKs on the generated shadow columns. ON DELETE CASCADE
-- (a conversion is pure config — it is meaningless without its variant/product,
-- unlike an `item_identifier` which is a printed artifact and uses NO ACTION).
-- ON UPDATE NO ACTION — Postgres forbids a cascading ON UPDATE on a FK whose
-- referencing column is GENERATED (and `variant`/`product` (tenantId, id) is
-- never updated in practice anyway).
ALTER TABLE "uom_conversion"
  ADD CONSTRAINT "uom_conversion_tenant_variant_fkey"
  FOREIGN KEY ("tenantId", "scopeVariantId") REFERENCES "variant"("tenantId", "id")
  ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "uom_conversion"
  ADD CONSTRAINT "uom_conversion_tenant_product_fkey"
  FOREIGN KEY ("tenantId", "scopeProductId") REFERENCES "product"("tenantId", "id")
  ON UPDATE NO ACTION ON DELETE CASCADE;

-- ── grants for the DB roles ─────────────────────────────────────────────────
GRANT ALL ON "uom", "uom_conversion" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "uom", "uom_conversion" TO flower_platform;
-- full DML — tenant business data written by the Owner via runScoped / flower_app;
-- RLS then narrows every statement to the request tenant. NO REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON "uom", "uom_conversion" TO flower_app;

-- ── Row-Level Security — ENABLE + policy + FORCE (plan §C.11) ────────────────
ALTER TABLE "uom" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "uom_tenant_isolation" ON "uom"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "uom" FORCE ROW LEVEL SECURITY;

ALTER TABLE "uom_conversion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "uom_conversion_tenant_isolation" ON "uom_conversion"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "uom_conversion" FORCE ROW LEVEL SECURITY;

-- ── variant.baseUomCode — additive, NULLABLE, NO backfill, NO NOT NULL (OD-2) ─
ALTER TABLE "variant" ADD COLUMN "baseUomCode" TEXT;
ALTER TABLE "variant"
  ADD CONSTRAINT "variant_base_uom_shape_chk"
    CHECK ("baseUomCode" IS NULL OR "baseUomCode" ~ '^[a-z][a-z0-9._-]{0,31}$');

-- ── item_identifier — the IMMUTABLE printed pack-identity snapshot (§I) ──────
ALTER TABLE "item_identifier"
  ADD COLUMN "packUomCode" TEXT,
  ADD COLUMN "packQty"     NUMERIC(18, 4),
  ADD COLUMN "packBaseQty" NUMERIC(18, 4);

ALTER TABLE "item_identifier"
  -- all three, or none
  ADD CONSTRAINT "item_identifier_pack_triple_chk"
    CHECK ( ("packUomCode" IS NULL) = ("packQty" IS NULL)
        AND ("packQty"     IS NULL) = ("packBaseQty" IS NULL) ),
  ADD CONSTRAINT "item_identifier_pack_positive_chk"
    CHECK ( "packQty" IS NULL OR ("packQty" > 0 AND "packBaseQty" > 0) ),
  -- a SKU is a catalogue label, never a printed pack (§I / MC-2)
  ADD CONSTRAINT "item_identifier_pack_sku_chk"
    CHECK ( "codeType" <> 'SKU' OR "packUomCode" IS NULL ),
  ADD CONSTRAINT "item_identifier_pack_uom_shape_chk"
    CHECK ( "packUomCode" IS NULL OR "packUomCode" ~ '^[a-z][a-z0-9._-]{0,31}$' );
