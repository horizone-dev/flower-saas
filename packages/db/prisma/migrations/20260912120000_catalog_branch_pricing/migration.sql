-- Phase 3 task 3.8 — branch price override + branch availability.
-- docs/phase-3/PHASE-3-PLAN.md §C.9 (corrected — see the §C.9 reconciliation note
-- in the same PR) / ADR-0018 §5·§7 / D2-2·D2-3. Additive, forward-only.
--
-- THREE new tenant-owned tables + TWO additive FK-target UNIQUE constraints on
-- the already-shipped `branch` table (no column retype, no data change, no
-- backfill):
--   * branch_variant_price_set   — the per (tenant, company, branch, variant)
--     concurrency aggregate. It carries the `version` (the replace-set `If-Match`
--     target — BD-3), is INDEPENDENTLY MONOTONIC (created at 1, only ever
--     incremented, NEVER reset, NEVER deleted — there is NO `DELETE …/prices`
--     endpoint, BD-4), and MAY validly exist with ZERO price rows and ZERO
--     company pricing (a first `PUT { prices: [] } If-Match "0"` creates it —
--     Correction 2). It has NO FK to `company_variant_price_set`.
--   * branch_variant_uom_price   — the INDEPENDENT stored SELL override Money for
--     (company, branch, variant, uom_code). NEVER `company_price × factor`
--     (ADR-0018 §5). SELL-only — NO `purchase_*` (BD-9). The override currency
--     MUST equal `company.default_currency` (composite FK, ON UPDATE RESTRICT).
--     BD-1 (a matching `company_variant_uom_price` row must exist) is
--     service-enforced under the shared `company_variant_price_set` lock — there
--     is NO row-level FK to `company_variant_uom_price` (Task 3.7 replace-sets
--     delete/recreate rows).
--   * branch_variant_availability — a boolean merchandising flag per
--     (company, branch, variant). NOT a quantity (D2-11). Absence of a row ⇒
--     available. Independent of pricing (BD-6). NO version. NO extra flags
--     (BD-7). Bulk declarative writes, Idempotency-Key, no If-Match.
--   * branch += UNIQUE (tenant_id, id)              -- price-set/availability → branch tenant-safe FK target
--           += UNIQUE (tenant_id, company_id, id)   -- proves branch ∈ company at the DB
--
-- Branch-GUC RLS: USING/WITH CHECK narrows to `app.branch_id` when set (a
-- single-branch session), else tenant-wide (an owner/multi-branch session). The
-- three narrow cross-branch integrity read helpers (app layer, not a DB object)
-- neutralize ONLY `app.branch_id` for exactly one read-only SELECT.
--
-- NO price gate on product/variant activation. NO tax / discount / promotion /
-- price-list / customer group / effective dates / inventory / order (non-scope
-- §16). NO outbox / realtime (Task 3.10 — audit only). NO new DB role, NO
-- BYPASSRLS. NO `variant` / `product` / `company` / `currency` / `uom` column
-- change. NO data backfill.

-- ══════════════ CreateTable — branch_variant_price_set ═══════════════════════
CREATE TABLE "branch_variant_price_set" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId"  UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "version"   INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_variant_price_set_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branch_variant_price_set_scope_key"
  ON "branch_variant_price_set"("tenantId", "companyId", "branchId", "variantId");
CREATE INDEX "branch_variant_price_set_tenantId_companyId_branchId_idx"
  ON "branch_variant_price_set"("tenantId", "companyId", "branchId");

-- ══════════════ CreateTable — branch_variant_uom_price ═══════════════════════
CREATE TABLE "branch_variant_uom_price" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId"  UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "uomCode"   TEXT NOT NULL,

    -- SELL override — always present, tax-EXCLUSIVE / net. Money = minor +
    -- currency + exponent (§C.10). The app builds it via @flower/money
    -- `Money.fromDTO`; the composite FKs below are the DB backstop.
    "overrideAmountMinor"      BIGINT   NOT NULL,
    "overrideCurrencyCode"     TEXT     NOT NULL,
    "overrideCurrencyExponent" SMALLINT NOT NULL,

    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    -- NO version column — the aggregate owns versioning (BD-3).
    -- NO purchase_* — branch overrides are SELL-only (BD-9).

    CONSTRAINT "branch_variant_uom_price_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "branch_variant_uom_price"
  -- the ONE canonical persisted UOM-code shape (Task 3.6 MC-1)
  ADD CONSTRAINT "bvup_uom_code_shape_chk"
    CHECK ("uomCode" ~ '^[a-z][a-z0-9._-]{0,31}$'),
  -- a branch override sell price is strictly positive (free/gift is discount/promo semantics, later)
  ADD CONSTRAINT "bvup_override_amount_positive_chk"
    CHECK ("overrideAmountMinor" > 0),
  ADD CONSTRAINT "bvup_override_currency_shape_chk"
    CHECK ("overrideCurrencyCode" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "bvup_override_exponent_range_chk"
    CHECK ("overrideCurrencyExponent" BETWEEN 0 AND 3);

CREATE UNIQUE INDEX "branch_variant_uom_price_scope_uom_key"
  ON "branch_variant_uom_price"("tenantId", "companyId", "branchId", "variantId", "uomCode");
CREATE INDEX "branch_variant_uom_price_scope_idx"
  ON "branch_variant_uom_price"("tenantId", "companyId", "branchId", "variantId");
-- for the Task 3.6 custom-UOM delete guard (tenant-wide) — a textual reference, no FK
CREATE INDEX "branch_variant_uom_price_tenantId_uomCode_idx"
  ON "branch_variant_uom_price"("tenantId", "uomCode");
-- for the Task 3.7 base-UOM change guard + the company-price removal guard (tenant-wide)
CREATE INDEX "branch_variant_uom_price_tenantId_variantId_idx"
  ON "branch_variant_uom_price"("tenantId", "variantId");

-- ══════════════ CreateTable — branch_variant_availability ════════════════════
CREATE TABLE "branch_variant_availability" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId"  UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "available" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    -- NO version. NO posVisible / webVisible / displayOrder / reason / note /
    -- quantity / stock state (BD-7).

    CONSTRAINT "branch_variant_availability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "branch_variant_availability_scope_key"
  ON "branch_variant_availability"("tenantId", "companyId", "branchId", "variantId");
CREATE INDEX "branch_variant_availability_tenantId_companyId_branchId_idx"
  ON "branch_variant_availability"("tenantId", "companyId", "branchId");
CREATE INDEX "branch_variant_availability_tenantId_variantId_idx"
  ON "branch_variant_availability"("tenantId", "variantId");

-- ══════════════ additive FK-target UNIQUE constraints on `branch` ════════════
-- `branch.id` is already the PK (unique); these composite uniques only give the
-- FKs below a target. NO column is added or retyped, NO data changes. Precedent:
-- task 3.7 added the same shape to `company` / `currency`.
ALTER TABLE "branch"
  ADD CONSTRAINT "branch_tenantId_id_key"           UNIQUE ("tenantId", "id"),
  ADD CONSTRAINT "branch_tenantId_companyId_id_key" UNIQUE ("tenantId", "companyId", "id");

-- ══════════════ Foreign keys ════════════════════════════════════════════════
ALTER TABLE "branch_variant_price_set"
  ADD CONSTRAINT "branch_variant_price_set_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  -- tenant-safe, one hop: proves branch ∈ company ∈ tenant. ON DELETE CASCADE —
  -- a branch aggregate is pure commercial config, meaningless without its branch.
  ADD CONSTRAINT "branch_variant_price_set_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE CASCADE,
  ADD CONSTRAINT "branch_variant_price_set_tenant_variant_fkey"
    FOREIGN KEY ("tenantId", "variantId") REFERENCES "variant"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE CASCADE;
-- NO FK to `company_variant_price_set` (Correction 2) — the branch aggregate is
-- independently monotonic and may exist with zero branch rows and zero company
-- pricing. BD-1 constrains branch price ROWS, not the aggregate.

ALTER TABLE "branch_variant_uom_price"
  ADD CONSTRAINT "branch_variant_uom_price_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  -- belongs to the branch aggregate by its natural composite key — the price
  -- row's companyId/branchId/variantId can never drift from its price set.
  ADD CONSTRAINT "branch_variant_uom_price_price_set_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "variantId")
    REFERENCES "branch_variant_price_set"("tenantId", "companyId", "branchId", "variantId")
    ON UPDATE NO ACTION ON DELETE CASCADE,
  -- §9 part 1 — the override currency MUST equal the company's default currency.
  -- ON UPDATE RESTRICT (NOT CASCADE — cascading would rewrite the currency code
  -- without rewriting the amount, silently turning "AED 100.00" into a false
  -- "SAR 100.00"). While any branch override references it, company.defaultCurrency
  -- cannot change.
  ADD CONSTRAINT "branch_variant_uom_price_company_currency_fkey"
    FOREIGN KEY ("tenantId", "companyId", "overrideCurrencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  -- §9 part 2 — the stored (code, exponent) pair MUST be an authoritative currency
  -- pair. Blocks a direct DB write of (AED, 3) when AED's exponent is 2, and
  -- (ON UPDATE RESTRICT) blocks `UPDATE currency SET exponent = …` while referenced.
  ADD CONSTRAINT "branch_variant_uom_price_currency_pair_fkey"
    FOREIGN KEY ("overrideCurrencyCode", "overrideCurrencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE RESTRICT;
-- NO row-level FK to `company_variant_uom_price` (Correction 2 / BD-17) — it would
-- collide with Task 3.7's replace-set delete/recreate. BD-1 is service-enforced
-- under the shared `company_variant_price_set` lock (§3).

ALTER TABLE "branch_variant_availability"
  ADD CONSTRAINT "branch_variant_availability_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "branch_variant_availability_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE CASCADE,
  -- a `variant` hard-delete cascades its availability rows (BD-6).
  ADD CONSTRAINT "branch_variant_availability_tenant_variant_fkey"
    FOREIGN KEY ("tenantId", "variantId") REFERENCES "variant"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE CASCADE;

-- ══════════════ grants for the DB roles ═════════════════════════════════════
GRANT ALL ON "branch_variant_price_set", "branch_variant_uom_price", "branch_variant_availability" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "branch_variant_price_set", "branch_variant_uom_price", "branch_variant_availability" TO flower_platform;
-- full DML — tenant business data written by the Owner via runScoped / flower_app;
-- RLS then narrows every statement to the request tenant (+ branch, when the
-- session is single-branch). NO REVOKE. NO new role. flower_app stays NOBYPASSRLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON "branch_variant_price_set", "branch_variant_uom_price", "branch_variant_availability" TO flower_app;

-- ══════════════ Row-Level Security — ENABLE + policy + FORCE (plan §C.11) ════
-- Tenant isolation + branch-GUC defence-in-depth: when `app.branch_id` is set
-- (a single-branch session), the DB physically returns 0 rows for any other
-- branch; when it is unset (an owner / multi-branch session) the branch clause
-- is a no-op and isolation is the guard pipeline + the service companyScope
-- check. The three narrow cross-branch integrity read helpers neutralize ONLY
-- `app.branch_id` (never `app.tenant_id`) for exactly one read-only SELECT.
ALTER TABLE "branch_variant_price_set" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "branch_variant_price_set_tenant_branch_isolation" ON "branch_variant_price_set"
  USING (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  );
ALTER TABLE "branch_variant_price_set" FORCE ROW LEVEL SECURITY;

ALTER TABLE "branch_variant_uom_price" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "branch_variant_uom_price_tenant_branch_isolation" ON "branch_variant_uom_price"
  USING (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  );
ALTER TABLE "branch_variant_uom_price" FORCE ROW LEVEL SECURITY;

ALTER TABLE "branch_variant_availability" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "branch_variant_availability_tenant_branch_isolation" ON "branch_variant_availability"
  USING (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  );
ALTER TABLE "branch_variant_availability" FORCE ROW LEVEL SECURITY;

-- ══════════════ permission registry — register the reserved `branch_price:manage` ═
-- Not a new key (D2-6 / HG3-PERMISSION-STABILITY): it has existed in
-- @flower/permissions PERMISSIONS.catalog since Phase 0. Registering it
-- (idempotent) means the tenant role-assignment / grantability checks accept it
-- in every environment; prisma/seed.ts upserts the same row for a fresh DB.
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES ('branch_price:manage', 'TENANT', 'catalog', 'branch price manage', 3)
ON CONFLICT ("key") DO NOTHING;

-- ══════════════ built-in system-role backfill (owner BD-12) ═════════════════
-- Existing tenants: owner + admin gain `branch_price:manage`. Manager does NOT
-- (mirrors `catalog:manage` / `variants:manage` / `identifiers:manage` /
-- `pricing:manage`). ONLY isSystem = true owner/admin roles. Idempotent via
-- ON CONFLICT (roleId, permissionKey). FORCE-toggle so a NOBYPASSRLS
-- `flower_migrate` can write cross-tenant; FORCE restored before commit.
-- `SYSTEM_ROLE_TEMPLATES` is updated in the same task so NEW tenants get the key
-- at provisioning without any backfill.
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'branch_price:manage'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
