-- Phase 3b task 3b.4 CHECKPOINT C — Fiscal Policy Snapshot + Fingerprint
-- V1/V2 + safe legacy migration. docs/phase-3 3b.4 contract freeze (4 rounds,
-- owner-approved). Additive + backfill + hardening, forward-only.
--
-- Adds to `order`:
--   * `taxPriceMode` / `taxRoundingScope` / `taxRoundingMode` — the 3
--     document-wide fiscal-policy fields, resolved ONCE at Order creation
--     from `country_tax_config.config` (never per-line, never re-resolved,
--     never client-suppliable).
--   * `commercialSnapshotFingerprintVersion` — dispatch tag for the
--     `commercialSnapshotFingerprint` payload shape (1 = frozen pre-3b.4
--     Task 3b.3 shape; 2 = that shape + the 3 fiscal-policy fields).
--
-- `country_tax_config` becomes a historical effective-dated source of truth
-- from this migration onward — a policy row already created (and any Order
-- that has resolved against it) must never have its content rewritten in
-- place; only closing an open row (`effectiveTo` NULL -> non-NULL) is legal,
-- and DELETE is blocked entirely (§C11).
--
-- ═══════════════ PRODUCTION-SAFE MIGRATION ORDERING (§C13) ══════════════════
-- 1. add nullable `taxPriceMode`/`taxRoundingScope`/`taxRoundingMode`
-- 2. add nullable `commercialSnapshotFingerprintVersion`
-- 3. backfill fiscal policy for PRE-EXISTING Orders from the historically
--    effective `country_tax_config` row (`company.countryCode` + the order's
--    OWN `createdAt` civil date in `company.accountingTimezone`) — 0 or >1
--    matching rows, or a match whose `config` fails the strict shape check
--    below, is left UNRESOLVED (NULL) here, never silently defaulted
-- 4. independently assign `commercialSnapshotFingerprintVersion = 1` to
--    EVERY pre-existing Order row — NOT conditioned on step 3's success;
--    every Order that existed before this migration is V1 by definition
-- 5. verify every Order now has all 4 columns non-null; FAIL the migration
--    explicitly (RAISE EXCEPTION) if not — no default policy, ever
-- 6. apply NOT NULL
-- 7. apply closed-vocabulary CHECKs
-- 8. set `commercialSnapshotFingerprintVersion` DEFAULT 2 for future inserts
--    (the application ALSO explicitly sets 2 on every new Order — belt+braces)
-- 9. ONLY AFTER 5-8 succeed: create the Order creation-attribute immutability
--    trigger (`fn_enforce_order_creation_attributes_immutable`) — creating it
--    before the backfill would self-block step 3/4's own UPDATEs
-- 10. create the `country_tax_config` immutable UPDATE/DELETE backstop
--
-- No destructive reset. No `SEQUENCE`. No native ENUM (closed vocabulary =
-- TEXT + CHECK, matching every other vocabulary in this schema).

-- ── STEP 1 — nullable fiscal-policy columns ─────────────────────────────────
ALTER TABLE "order" ADD COLUMN "taxPriceMode" TEXT;
ALTER TABLE "order" ADD COLUMN "taxRoundingScope" TEXT;
ALTER TABLE "order" ADD COLUMN "taxRoundingMode" TEXT;

-- ── STEP 2 — nullable fingerprint-version column ────────────────────────────
ALTER TABLE "order" ADD COLUMN "commercialSnapshotFingerprintVersion" INTEGER;

-- ── STEP 3 — backfill fiscal policy for PRE-EXISTING Orders ─────────────────
-- Three-way resolution semantics, deliberately mirroring the RUNTIME
-- `LocalizationService.resolveFiscalPolicyOn` contract exactly (§C4/§C14):
--   1. count EFFECTIVE-DATED rows for (countryCode, civil date) — regardless
--      of config content;
--   2. `effective_count <> 1` (0 = unconfigured, >1 = ambiguous overlapping
--      reference data) -> leave UNRESOLVED, never pick one;
--   3. `effective_count = 1` -> the config JSON must independently pass the
--      EXACT SQL-side equivalent of the runtime `.strict()` Zod shape (§C14)
--      — a well-formed-but-wrong-shape config also leaves the row UNRESOLVED,
--      never defaulted.
-- Guarded by `"taxPriceMode" IS NULL` so a re-run (idempotent redeploy, §C16
-- test J) never overwrites an already-backfilled row.
WITH order_civil_date AS (
  SELECT o."id" AS order_id,
         c."countryCode" AS country_code,
         (o."createdAt" AT TIME ZONE c."accountingTimezone")::date AS civil_date
    FROM "order" o
    JOIN "company" c ON c."id" = o."companyId"
   WHERE o."taxPriceMode" IS NULL
     AND c."countryCode" IS NOT NULL
     AND c."accountingTimezone" IS NOT NULL
),
effective_rows AS (
  SELECT ocd.order_id,
         ctc."config" AS config,
         COUNT(*) OVER (PARTITION BY ocd.order_id) AS effective_count
    FROM order_civil_date ocd
    JOIN "country_tax_config" ctc
      ON ctc."countryCode" = ocd.country_code
     AND ctc."effectiveFrom" <= ocd.civil_date
     AND (ctc."effectiveTo" IS NULL OR ctc."effectiveTo" >= ocd.civil_date)
),
resolved AS (
  SELECT order_id, config
    FROM effective_rows
   WHERE effective_count = 1
     -- STRICT JSON SHAPE VALIDATION (§C14) — matches runtime `.strict()`
     -- exactly: top-level type = object, EXACTLY the 3 required keys (no
     -- fewer, no more — `array_agg` of the actual keys must equal the frozen
     -- sorted 3-key set), each value is a JSON string, each value belongs to
     -- its own frozen closed vocabulary.
     AND jsonb_typeof(config) = 'object'
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(config) AS k)
         = ARRAY['priceTaxMode', 'roundingMode', 'roundingScope']
     AND jsonb_typeof(config -> 'priceTaxMode') = 'string'
     AND jsonb_typeof(config -> 'roundingScope') = 'string'
     AND jsonb_typeof(config -> 'roundingMode') = 'string'
     AND config ->> 'priceTaxMode' IN ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE')
     AND config ->> 'roundingScope' IN ('LINE', 'DOCUMENT')
     AND config ->> 'roundingMode' IN ('HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'HALF_DOWN')
)
UPDATE "order" o
   SET "taxPriceMode" = r.config ->> 'priceTaxMode',
       "taxRoundingScope" = r.config ->> 'roundingScope',
       "taxRoundingMode" = r.config ->> 'roundingMode'
  FROM resolved r
 WHERE o."id" = r.order_id;

-- ── STEP 4 — every pre-existing Order is V1, unconditionally ────────────────
-- Deliberately NOT tied to step 3's success — a legacy Order's fingerprint
-- was computed (and stored) under the V1 payload shape regardless of whether
-- its fiscal policy could be backfilled; the two facts are independent.
UPDATE "order" SET "commercialSnapshotFingerprintVersion" = 1
 WHERE "commercialSnapshotFingerprintVersion" IS NULL;

-- ── STEP 5 — verify: FAIL CLOSED, never default ─────────────────────────────
DO $$
DECLARE
  unresolved_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO unresolved_count FROM "order"
   WHERE "taxPriceMode" IS NULL
      OR "taxRoundingScope" IS NULL
      OR "taxRoundingMode" IS NULL
      OR "commercialSnapshotFingerprintVersion" IS NULL;
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'sale_tax_fiscal_policy_v1v2 migration: % existing Order row(s) could not be resolved to a complete fiscal policy / fingerprint version (0 or >1 effective country_tax_config row, or a malformed config) — migration aborted, NO default policy applied',
      unresolved_count;
  END IF;
END $$;

-- ── STEP 6 — NOT NULL ────────────────────────────────────────────────────────
ALTER TABLE "order" ALTER COLUMN "taxPriceMode" SET NOT NULL;
ALTER TABLE "order" ALTER COLUMN "taxRoundingScope" SET NOT NULL;
ALTER TABLE "order" ALTER COLUMN "taxRoundingMode" SET NOT NULL;
ALTER TABLE "order" ALTER COLUMN "commercialSnapshotFingerprintVersion" SET NOT NULL;

-- ── STEP 7 — closed-vocabulary CHECKs ────────────────────────────────────────
ALTER TABLE "order"
  ADD CONSTRAINT "order_tax_price_mode_chk" CHECK ("taxPriceMode" IN ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE')),
  ADD CONSTRAINT "order_tax_rounding_scope_chk" CHECK ("taxRoundingScope" IN ('LINE', 'DOCUMENT')),
  ADD CONSTRAINT "order_tax_rounding_mode_chk" CHECK ("taxRoundingMode" IN ('HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'HALF_DOWN')),
  ADD CONSTRAINT "order_fingerprint_version_chk" CHECK ("commercialSnapshotFingerprintVersion" IN (1, 2));

-- ── STEP 8 — DEFAULT 2 for future inserts (application also sets it explicitly) ──
ALTER TABLE "order" ALTER COLUMN "commercialSnapshotFingerprintVersion" SET DEFAULT 2;

-- ── STEP 9 — Order creation-attribute immutability (ONLY after 5-8 succeed) ─
-- A SEPARATE, unconditional trigger from `fn_enforce_order_commercial_freeze`
-- (task 3b.3) — deliberately NOT folded into it (§C10): these 4 columns are
-- resolved ONCE at creation and must be frozen in EVERY status (DRAFT / HELD
-- / CONFIRMED / every other status), unlike the commercial-freeze trigger's
-- own pre-issuance/post-issuance split. `commercialSnapshotFingerprint`
-- itself is deliberately NOT covered here — a legitimate DRAFT PATCH already
-- recomputes that column (task 3b.3), only its VERSION tag is frozen.
CREATE FUNCTION fn_enforce_order_creation_attributes_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."taxPriceMode" IS DISTINCT FROM OLD."taxPriceMode" THEN
    RAISE EXCEPTION 'order %: taxPriceMode is immutable after creation', OLD."id";
  END IF;
  IF NEW."taxRoundingScope" IS DISTINCT FROM OLD."taxRoundingScope" THEN
    RAISE EXCEPTION 'order %: taxRoundingScope is immutable after creation', OLD."id";
  END IF;
  IF NEW."taxRoundingMode" IS DISTINCT FROM OLD."taxRoundingMode" THEN
    RAISE EXCEPTION 'order %: taxRoundingMode is immutable after creation', OLD."id";
  END IF;
  IF NEW."commercialSnapshotFingerprintVersion" IS DISTINCT FROM OLD."commercialSnapshotFingerprintVersion" THEN
    RAISE EXCEPTION 'order %: commercialSnapshotFingerprintVersion is immutable after creation', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_order_creation_attributes_immutable
  BEFORE UPDATE ON "order"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_order_creation_attributes_immutable();

-- ── STEP 10 — country_tax_config history immutability (§C11) ────────────────
-- `country_tax_config` is a historical effective-dated source of truth from
-- this migration onward. The ONLY legal UPDATE transition on an existing row
-- is closing an open one (`effectiveTo` NULL -> non-NULL); every other field
-- is frozen, and re-closing/reopening/changing a closed date is rejected.
-- DELETE is unconditionally blocked — if history is immutable, DELETE must
-- not be an unprotected bypass around that. Applies regardless of role
-- (flower_app has no DML grant on this table at all today — only
-- flower_platform/flower_migrate do — so this is a backstop against THOSE
-- roles and any future grant widening, matching the 3b.1/3b.3 trigger
-- discipline of "regardless of role").
CREATE FUNCTION fn_enforce_country_tax_config_immutable() RETURNS trigger AS $$
BEGIN
  IF NOT (
    NEW."countryCode" IS NOT DISTINCT FROM OLD."countryCode"
    AND NEW."effectiveFrom" IS NOT DISTINCT FROM OLD."effectiveFrom"
    AND NEW."regime" IS NOT DISTINCT FROM OLD."regime"
    AND NEW."config" IS NOT DISTINCT FROM OLD."config"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION
      'country_tax_config %: countryCode/effectiveFrom/regime/config/createdAt are immutable — history is never rewritten in place',
      OLD."id";
  END IF;
  -- the ONE legal transition: an OPEN row (effectiveTo IS NULL) may be
  -- closed (set to a non-NULL date). A row that is ALREADY closed can never
  -- have its effectiveTo changed again — not reopened, not re-dated.
  IF OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo" THEN
    RAISE EXCEPTION
      'country_tax_config %: a closed effectiveTo can never be changed again (no reopening, no re-dating)',
      OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_country_tax_config_immutable
  BEFORE UPDATE ON "country_tax_config"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_country_tax_config_immutable();

CREATE FUNCTION fn_enforce_country_tax_config_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'country_tax_config %: DELETE is never permitted — history is immutable', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_country_tax_config_no_delete
  BEFORE DELETE ON "country_tax_config"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_country_tax_config_no_delete();

-- ── STEP 11 — country_tax_config: reject an impossible inverted effective
--    interval (Checkpoint C final-integrity pass, §3 — a genuine C defect:
--    no prior migration ever added this invariant for this table, unlike
--    the immutability backstops above which are Checkpoint C's own new
--    concept). Structural only — NOT a current-date/business-time rule; an
--    open row (`effectiveTo IS NULL`) is always valid regardless of date. ──
ALTER TABLE "country_tax_config"
  ADD CONSTRAINT "country_tax_config_effective_range_chk"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
