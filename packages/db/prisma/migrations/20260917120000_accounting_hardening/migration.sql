-- Phase 3b task 3b.1 hardening (owner pre-merge review round 2) — two
-- deterministic, additive fixes, no schema.prisma change (both are pure
-- data-backfill / DB-trigger additions on already-existing columns/tables
-- from `20260915120000_accounting_coa_posting_periods`).
--
--   1. `country.defaultTimezone` production-safe backfill for the six
--      approved GCC countries. The prior migration ADDED the column but
--      relied on `prisma/seed.ts` to populate it — `seed.ts` is NOT part of
--      the production deployment path, so a real production database would
--      never receive these values. This migration snapshots the six
--      owner-approved constants directly into migration history (the
--      standard, deterministic way to guarantee production-safe reference
--      data that must not depend on a dev/CI-only seed script).
--
--      Guarded by `... AND "defaultTimezone" IS NULL` so this is idempotent
--      and non-destructive — it can never overwrite a value already set by
--      any other path, and touches ONLY these six rows, never any other
--      `country` row. It does NOT touch `company.accountingTimezone` (the
--      sole runtime financial-posting authority, set once at company
--      provisioning time from this reference value — see
--      `provisioning.repository.ts` — and never re-read from `country`
--      afterward). It does NOT create any `accounting_period`. It does NOT
--      make `country.defaultTimezone` a runtime posting fallback — the
--      Posting Engine and `posting-date.ts` read ONLY
--      `company.accountingTimezone`, never `country`/`branch`/POS/client
--      timezone (unchanged by this migration, code-level invariant only).
--
--   2. `account.key` / `account.category` DB-level immutability. The prior
--      migration left these immutable only because no code path exposes
--      them for update (type/DTO-level only) — unlike every other Task 3b.1
--      invariant, there was no DB-level backstop. This adds the smallest
--      possible guard: a `BEFORE UPDATE` trigger on `account` that rejects
--      any UPDATE actually CHANGING `key` or `category` (via `IS DISTINCT
--      FROM`, not merely appearing in the SET clause — a display-only update
--      that re-sends the row's own current `key`/`category` unchanged still
--      succeeds). `displayCode`/`displayName` (and `updatedAt`) remain freely
--      editable. No `status`/`ACTIVE`/`INACTIVE` column is added.
--      `displayCode` is NOT made a posting identity — `key` remains the sole
--      immutable posting identity; this trigger is defense-in-depth on top
--      of that, not a redesign.

-- ── country.defaultTimezone — production-safe GCC backfill ──────────────────
UPDATE "country" SET "defaultTimezone" = 'Asia/Dubai'   WHERE "code" = 'AE' AND "defaultTimezone" IS NULL;
UPDATE "country" SET "defaultTimezone" = 'Asia/Riyadh'  WHERE "code" = 'SA' AND "defaultTimezone" IS NULL;
UPDATE "country" SET "defaultTimezone" = 'Asia/Qatar'   WHERE "code" = 'QA' AND "defaultTimezone" IS NULL;
UPDATE "country" SET "defaultTimezone" = 'Asia/Kuwait'  WHERE "code" = 'KW' AND "defaultTimezone" IS NULL;
UPDATE "country" SET "defaultTimezone" = 'Asia/Bahrain' WHERE "code" = 'BH' AND "defaultTimezone" IS NULL;
UPDATE "country" SET "defaultTimezone" = 'Asia/Muscat'  WHERE "code" = 'OM' AND "defaultTimezone" IS NULL;

-- ── account.key / account.category — DB-level immutability ─────────────────
CREATE FUNCTION fn_enforce_account_key_category_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."key" IS DISTINCT FROM NEW."key" OR OLD."category" IS DISTINCT FROM NEW."category" THEN
    RAISE EXCEPTION 'account.key and account.category are immutable after creation (id=%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_account_key_category_immutable
  BEFORE UPDATE ON "account"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_account_key_category_immutable();
