-- Phase 3 task 3.9 — catalog tax-category assignment + effective tax-rate
-- resolution. docs/phase-3/PHASE-3-PLAN.md §C.10 / §D-3.9 / D2-8. Additive,
-- forward-only. No destructive rewrite.
--
-- Scope of THIS migration (the entire schema change for task 3.9):
--   * product.taxCategoryKey  text NULL  — the VAT tax-category default for a
--     product's variants (D1 = product default + variant override).
--   * variant.taxCategoryKey  text NULL  — the per-variant override; when NULL
--     the variant inherits product.taxCategoryKey (precedence: variant ->
--     product -> NONE). NULL at BOTH levels = "not configured" — a distinct
--     state from a configured 0% rate and from a NONE-regime country (§11).
--
-- Both columns are a TEXTUAL reference to `tax_category.key` (platform-global,
-- RLS-exempt reference data, task 2.7). The FK is `ON UPDATE CASCADE ON DELETE
-- RESTRICT` — mirrors `tax_rate.taxCategoryKey_fkey` and the established
-- tenant-table -> platform-global pattern (`company.countryCode -> country.code`,
-- `20260904130000_phase_2_core_infra`). `flower_app` cannot delete a
-- `tax_category` row (task-2.7 `REVOKE`), so the RESTRICT is a DB backstop only.
--
-- NO new table (existing `tax_category` is reused as-is). NO tax computation on
-- an amount (Phase 3b, D2-8). NO backfill. NO NOT NULL. NO change to
-- `tax_category` / `tax_rate` / `country_tax_config` / any task-2.7 fiscal
-- migration. NO RLS / policy change (`product` and `variant` already carry
-- `ENABLE + FORCE` + a tenant policy — a new nullable column inherits it). NO
-- grant change (`flower_app` already holds full DML on `product` / `variant`).
-- NO permission_registry / system-role change (`catalog:manage` /
-- `variants:manage` are already registered — tasks 3.2 / 3.4). NO realtime /
-- outbox (task 3.10).

-- ── product.taxCategoryKey — additive, NULLABLE, NO backfill, NO NOT NULL ─────
ALTER TABLE "product" ADD COLUMN "taxCategoryKey" TEXT;

ALTER TABLE "product"
  ADD CONSTRAINT "product_taxCategoryKey_fkey"
    FOREIGN KEY ("taxCategoryKey") REFERENCES "tax_category"("key")
    ON UPDATE CASCADE ON DELETE RESTRICT;

-- Partial index — the forward-looking "which products are assigned category X"
-- admin/report query (Prisma cannot express a partial index).
CREATE INDEX "product_taxCategoryKey_idx"
  ON "product" ("taxCategoryKey")
  WHERE "taxCategoryKey" IS NOT NULL;

-- ── variant.taxCategoryKey — additive, NULLABLE, NO backfill, NO NOT NULL ─────
ALTER TABLE "variant" ADD COLUMN "taxCategoryKey" TEXT;

ALTER TABLE "variant"
  ADD CONSTRAINT "variant_taxCategoryKey_fkey"
    FOREIGN KEY ("taxCategoryKey") REFERENCES "tax_category"("key")
    ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX "variant_taxCategoryKey_idx"
  ON "variant" ("taxCategoryKey")
  WHERE "taxCategoryKey" IS NOT NULL;
