-- DRAFT S — a pg_trgm GIN index on variant."nameEn" for the inventory stock search. A PROPOSAL that is **NOT RECOMMENDED**: applied only to a DISPOSABLE database by the benchmark.
--
-- WHAT WAS MEASURED (docs/mvp/INVENTORY-SEARCH-PERFORMANCE.md; `inventory-search-benchmark.integration.test.ts`):
--   * pg_trgm is ALREADY installed by the applied `20260906130000_catalog_core` migration (`CREATE EXTENSION IF NOT EXISTS pg_trgm`, version 1.6, a TRUSTED extension: a
--     database owner with CREATE can install it; no superuser needed on PostgreSQL ≥ 13), and `product."nameEn"` / `"nameAr"` already have GIN trigram indexes. Only the
--     VARIANT name has none.
--   * Under FORCE row-level security the planner CANNOT use a trigram index for `ILIKE` as the application role: `texticlike` is not LEAKPROOF, so the user's `ILIKE` is never
--     an index condition below the policy's tenant filter. Measured on 40 000 variants: a role that bypasses RLS uses `variant_nameEn_trgm_idx`; `flower_app` does NOT — even with
--     sequential scans forbidden. The index would be pure write overhead for the only role that reads it. (The same holds for the existing product trigram indexes.)
--   * The shipped search therefore does not depend on any index: it reads names with a bounded window + a candidate phase (no migration). It is correct and fast without this file.
--
-- It is kept, tested and documented so that the decision is reviewable and reversible: if a future PostgreSQL release or a leakproof search function changes the finding, re-run
-- the benchmark; until then DO NOT apply it. It is the LAST optional entry of the activation manifest (`recommended: false`).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "variant_nameEn_trgm_idx" ON "variant" USING GIN ("nameEn" gin_trgm_ops);
