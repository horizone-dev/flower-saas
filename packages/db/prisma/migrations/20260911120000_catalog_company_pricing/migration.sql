-- Phase 3 task 3.7 — company per-UOM sale pricing.
-- docs/phase-3/PHASE-3-PLAN.md §C.8 (corrected — see the §C.8 reconciliation note
-- in the same PR) / ADR-0018 §5·§7 / D2-2·D2-3. Additive, forward-only.
--
-- TWO new tenant-owned tables + THREE additive FK-target UNIQUE constraints on
-- already-shipped tables (no column retype, no data change, no backfill):
--   * company_variant_price_set  — the per (tenant, company, variant) aggregate;
--     it carries the `version` (the replace-set `If-Match` target — D-7). It is
--     the concurrency unit and it EXISTS independently of whether any price rows
--     exist (an empty price set is a first-class state). Task 3.7 NEVER deletes
--     it through the pricing API — `PUT []` deletes the price rows and bumps the
--     aggregate version, the aggregate row stays.
--   * company_variant_uom_price  — the INDEPENDENT stored sell Money for
--     (company, variant, uom_code). NEVER `base_price × factor` (ADR-0018 §5).
--     `sell_*` mandatory (> 0, tax-EXCLUSIVE / net — D-2·D-8); `purchase_*` a
--     NULLABLE, API-absent, unconsumed Phase-5 foundation (D-6).
--   * company    += UNIQUE (tenant_id, id)                       -- price-set → company FK target
--                += UNIQUE (tenant_id, id, default_currency)     -- sell-currency == company default (Inv-3)
--   * currency   += UNIQUE (code, exponent)                      -- sell-currency exponent is authoritative (Inv-3 / C-3)
--
-- NO price gate on product/variant activation (D-1). NO branch price /
-- availability (Task 3.8). NO tax / discount / promotion / price-list / customer
-- group / effective dates / inventory / order (non-scope §14). NO outbox /
-- realtime (Task 3.10 — audit only). NO `variant` / `product` / `uom` column
-- change. NO data backfill.

-- ══════════════ CreateTable — company_variant_price_set ═══════════════════════
CREATE TABLE "company_variant_price_set" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "version"   INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_variant_price_set_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "company_variant_price_set_scope_key"
  ON "company_variant_price_set"("tenantId", "companyId", "variantId");
CREATE INDEX "company_variant_price_set_tenantId_companyId_idx"
  ON "company_variant_price_set"("tenantId", "companyId");

-- ══════════════ CreateTable — company_variant_uom_price ═══════════════════════
CREATE TABLE "company_variant_uom_price" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "uomCode"   TEXT NOT NULL,

    -- SELL price — always present, tax-EXCLUSIVE / net. Money = minor + currency
    -- + exponent (§C.10). The app builds it via @flower/money `Money.fromDTO`
    -- (rejects a wrong exponent); the composite FKs below are the DB backstop.
    "sellAmountMinor"      BIGINT   NOT NULL,
    "sellCurrencyCode"     TEXT     NOT NULL,
    "sellCurrencyExponent" SMALLINT NOT NULL,

    -- PURCHASE / cost-path — FOUNDATION ONLY. NULLABLE, never accepted / updated
    -- / returned by the Task 3.7 API, read by no Task 3.7 runtime flow (D-6).
    -- Phase 5 procurement wires it — no schema change needed then.
    "purchaseAmountMinor"      BIGINT,
    "purchaseCurrencyCode"     TEXT,
    "purchaseCurrencyExponent" SMALLINT,

    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    -- NO version column — the aggregate owns versioning (D-7).

    CONSTRAINT "company_variant_uom_price_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "company_variant_uom_price"
  -- the ONE canonical persisted UOM-code shape (Task 3.6 MC-1)
  ADD CONSTRAINT "cvup_uom_code_shape_chk"
    CHECK ("uomCode" ~ '^[a-z][a-z0-9._-]{0,31}$'),
  -- a master sell price is strictly positive (D-8 — free/gift is discount/promo semantics, later)
  ADD CONSTRAINT "cvup_sell_amount_positive_chk"
    CHECK ("sellAmountMinor" > 0),
  ADD CONSTRAINT "cvup_sell_currency_shape_chk"
    CHECK ("sellCurrencyCode" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "cvup_sell_exponent_range_chk"
    CHECK ("sellCurrencyExponent" BETWEEN 0 AND 3),
  -- purchase triple: all three NULL, or all three non-NULL
  ADD CONSTRAINT "cvup_purchase_triple_chk"
    CHECK ( ("purchaseAmountMinor" IS NULL) = ("purchaseCurrencyCode" IS NULL)
        AND ("purchaseCurrencyCode" IS NULL) = ("purchaseCurrencyExponent" IS NULL) ),
  ADD CONSTRAINT "cvup_purchase_amount_nonneg_chk"
    CHECK ( "purchaseAmountMinor" IS NULL OR "purchaseAmountMinor" >= 0 ),
  ADD CONSTRAINT "cvup_purchase_currency_shape_chk"
    CHECK ( "purchaseCurrencyCode" IS NULL OR "purchaseCurrencyCode" ~ '^[A-Z]{3}$' ),
  ADD CONSTRAINT "cvup_purchase_exponent_range_chk"
    CHECK ( "purchaseCurrencyExponent" IS NULL OR "purchaseCurrencyExponent" BETWEEN 0 AND 3 );

CREATE UNIQUE INDEX "company_variant_uom_price_scope_uom_key"
  ON "company_variant_uom_price"("tenantId", "companyId", "variantId", "uomCode");
CREATE INDEX "company_variant_uom_price_scope_idx"
  ON "company_variant_uom_price"("tenantId", "companyId", "variantId");
-- for the Task 3.6 custom-UOM delete guard (D-5) — a textual reference, no FK
CREATE INDEX "company_variant_uom_price_tenantId_uomCode_idx"
  ON "company_variant_uom_price"("tenantId", "uomCode");

-- ══════════════ additive FK-target UNIQUE constraints ════════════════════════
-- `company.id` is already the PK (unique); these composite uniques only give the
-- FKs below a target. NO column is added or retyped, NO data changes.
ALTER TABLE "company"
  ADD CONSTRAINT "company_tenantId_id_key"          UNIQUE ("tenantId", "id"),
  ADD CONSTRAINT "company_tenantId_id_currency_key" UNIQUE ("tenantId", "id", "defaultCurrency");
-- `currency.code` is already the PK; this only gives the (code, exponent) FK a
-- target. The Currency business model is unchanged; no per-company currency row.
ALTER TABLE "currency"
  ADD CONSTRAINT "currency_code_exponent_key" UNIQUE ("code", "exponent");

-- ══════════════ Foreign keys ════════════════════════════════════════════════
ALTER TABLE "company_variant_price_set"
  ADD CONSTRAINT "company_variant_price_set_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  -- tenant-safe: a price set can never point at another tenant's / another
  -- relationship's company or variant. ON DELETE CASCADE — an aggregate is pure
  -- commercial config, meaningless without its company/variant.
  ADD CONSTRAINT "company_variant_price_set_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE CASCADE,
  ADD CONSTRAINT "company_variant_price_set_tenant_variant_fkey"
    FOREIGN KEY ("tenantId", "variantId") REFERENCES "variant"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "company_variant_uom_price"
  ADD CONSTRAINT "company_variant_uom_price_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  -- belongs to the aggregate by its natural composite key (D-7 / scope §3.4):
  -- the price row's companyId/variantId can never drift from its price set, and
  -- no aggregate-id lookup is needed before inserting price rows.
  ADD CONSTRAINT "company_variant_uom_price_price_set_fkey"
    FOREIGN KEY ("tenantId", "companyId", "variantId")
    REFERENCES "company_variant_price_set"("tenantId", "companyId", "variantId")
    ON UPDATE NO ACTION ON DELETE CASCADE,
  -- Inv-3 part 1 — the sell currency MUST equal the company's default currency.
  -- ON UPDATE RESTRICT (NOT CASCADE — cascading would rewrite the currency code
  -- without rewriting `sellAmountMinor`, silently turning "AED 100.00" into a
  -- false "SAR 100.00"). While any price row references it, company.defaultCurrency
  -- cannot change — the forcing function for a future currency-change feature.
  ADD CONSTRAINT "company_variant_uom_price_company_currency_fkey"
    FOREIGN KEY ("tenantId", "companyId", "sellCurrencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- Inv-3 part 2 (C-3) — the stored (code, exponent) pair MUST be an authoritative
  -- currency pair. Blocks a direct DB write of (AED, 3) when AED's exponent is 2,
  -- and (ON UPDATE RESTRICT) blocks `UPDATE currency SET exponent = …` while
  -- referenced — the stored meaning of every existing price is protected.
  ADD CONSTRAINT "company_variant_uom_price_sell_currency_pair_fkey"
    FOREIGN KEY ("sellCurrencyCode", "sellCurrencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- same pair integrity for the inert purchase triple (MATCH SIMPLE skips it
  -- while NULL — which it always is under the Task 3.7 API; this pre-empts a
  -- future direct / Phase-5 write of a bad pair).
  ADD CONSTRAINT "company_variant_uom_price_purchase_currency_pair_fkey"
    FOREIGN KEY ("purchaseCurrencyCode", "purchaseCurrencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- ══════════════ grants for the DB roles ═════════════════════════════════════
GRANT ALL ON "company_variant_price_set", "company_variant_uom_price" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_variant_price_set", "company_variant_uom_price" TO flower_platform;
-- full DML — tenant business data written by the Owner via runScoped / flower_app;
-- RLS then narrows every statement to the request tenant. NO REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_variant_price_set", "company_variant_uom_price" TO flower_app;

-- ══════════════ Row-Level Security — ENABLE + policy + FORCE (plan §C.11) ════
ALTER TABLE "company_variant_price_set" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_variant_price_set_tenant_isolation" ON "company_variant_price_set"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "company_variant_price_set" FORCE ROW LEVEL SECURITY;

ALTER TABLE "company_variant_uom_price" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_variant_uom_price_tenant_isolation" ON "company_variant_uom_price"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "company_variant_uom_price" FORCE ROW LEVEL SECURITY;

-- ══════════════ permission registry — register the reserved `pricing:manage` ═
-- Not a new key (D2-6 / HG3-PERMISSION-STABILITY): it has existed in
-- @flower/permissions PERMISSIONS.catalog since Phase 0. Registering it
-- (idempotent) means the tenant role-assignment / grantability checks accept it
-- in every environment; prisma/seed.ts upserts the same row for a fresh DB.
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES ('pricing:manage', 'TENANT', 'catalog', 'pricing manage', 3)
ON CONFLICT ("key") DO NOTHING;

-- ══════════════ built-in system-role backfill (owner "PERMISSIONS") ═════════
-- Existing tenants: owner + admin gain `pricing:manage`. Manager does NOT
-- (mirrors `catalog:manage` / `variants:manage` / `identifiers:manage`). ONLY
-- isSystem = true owner/admin roles — custom / user-created roles, explicit
-- grants and deny grants are NEVER touched. Idempotent + rerunnable via
-- ON CONFLICT (roleId, permissionKey). FORCE-toggle so a NOBYPASSRLS
-- `flower_migrate` can write cross-tenant; FORCE restored before commit.
-- `SYSTEM_ROLE_TEMPLATES` is updated in the same task so NEW tenants get the key
-- at provisioning without any backfill.
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'pricing:manage'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
