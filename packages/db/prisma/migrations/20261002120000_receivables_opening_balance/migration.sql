-- Phase 3b task 3b.6 CHECKPOINT F (+ FINAL HARDENING, still unfrozen) —
-- Customer Opening Balances (Opening Receivable + Opening Advance).
--
-- SCHEMA-GAP EVIDENCE (F1/F2): re-inspecting the frozen Checkpoint B schema
-- (`20260927130000_receivables_core_schema`) shows `customer_receivable`/
-- `customer_advance` already fully support `sourceType='OPENING'` shape
-- (`openingAmountMinor`/`currencyCode`/`currencyExponent`), and
-- `customer_account_entry` already has the `OPENING_RECEIVABLE`/
-- `OPENING_ADVANCE` entryKind vocabulary + cross-reference trigger checks
-- wired (B anticipated this checkpoint's producers). `EQUITY.OPENING_BALANCE`
-- (key `3100`) already exists (`20260928130000_receivables_opening_balance_account`).
-- What is genuinely ABSENT: any column recording the opening balance's own
-- immutable business EFFECTIVE DATE (distinct from `createdAt`, which is
-- merely the insertion instant) or its NOTE/reference. This migration closes
-- that gap additively; it edits NONE of the 40 pre-Checkpoint-F migrations.
--
-- OWNER-FROZEN RULE (Checkpoint F Final Hardening §1 — no longer merely an
-- inferred fallback): for each (tenant, company, branch,
-- CustomerCompanyAccount) there may be AT MOST ONE opening-balance
-- initialization, exactly RECEIVABLE or ADVANCE, never both. Opening Balance
-- is an initialization event, never a general-purpose adjustment mechanism;
-- future corrections require a separately designed reversal workflow.
--
-- STRUCTURAL DESIGN (§9/§10, hardening pass): the FIRST draft of this
-- migration made `customer_opening_balance_init` a ticket the REPOSITORY
-- claimed manually, referencing the already-created source row — but nothing
-- on `customer_receivable`/`customer_advance` themselves required a ticket to
-- exist at all, so a raw `INSERT ... sourceType='OPENING'` bypassing the
-- repository could create a second (or cross-table) opening source with NO
-- ticket ever claimed — the uniqueness rule was NOT a genuine DB invariant.
-- Corrected here (this migration is still unfrozen — no edit to any of the
-- 40 pre-F migrations): the ticket table now has NO reference to a source
-- row at all (it is pure initialization/uniqueness provenance, never a
-- second financial authority — CustomerReceivable/CustomerAdvance remain the
-- sole principal authority, per §10's own instruction). Instead, a BEFORE
-- INSERT trigger on EACH of `customer_receivable`/`customer_advance` — fired
-- for every insert, from the repository OR raw SQL OR any future code —
-- attempts `INSERT ... ON CONFLICT (...) DO NOTHING` against the ticket's
-- own unique index; a conflict RAISEs and aborts the whole insert (and
-- therefore the whole transaction). This is the same `INSERT ... ON
-- CONFLICT DO NOTHING RETURNING` pattern already established by
-- `CustomerRepository.associateWithCompany` — race-safe (a real Postgres
-- unique index, not a check-then-act EXISTS query), and now literally
-- impossible to bypass via any insert path into either source table.
--
-- GL-POSTING-DATE (§2-§8, hardening pass — MAJOR BLOCKER RESOLVED): the
-- opening balance's `effectiveDate` now DOES determine the journal's own
-- `postingDate`/accounting period — see `posting-engine.service.ts`'s new
-- OPTIONAL `accountingDate` input (application-code change, not this
-- migration). This migration's own job is unchanged: it still only adds the
-- `openingEffectiveDate`/`openingNote` columns as the immutable business
-- record on the source row; `OpeningBalanceRepository` now ALSO passes that
-- same date into `PostingEngineService.postJournal({accountingDate: ...})`.
--
-- AMOUNT > 0 (§12, hardening pass): `openingAmountMinor > 0` is now the
-- final structural invariant (tightened from the earlier `>= 0`). Evidence
-- considered: Checkpoint A's pure `assertCustomerReceivableSourceShape`
-- permits a zero `originalAmountMinor`, and a handful of ALREADY-FROZEN
-- Checkpoint E raw-SQL test fixtures
-- (`payment-advance.controller.integration.test.ts`) used
-- `openingAmountMinor = 0` as harmless scaffolding (those tests exercise
-- Payment->Advance conversion, never the opening receivable's own balance).
-- Per this hardening pass's explicit owner instruction ("do not preserve
-- invalid business states solely to keep stale fixtures green... update
-- those fixtures"), those raw-SQL fixture call sites are updated (to `1`,
-- a harmless minimal positive placeholder that changes nothing the
-- affected tests actually assert) rather than the DB invariant weakened.
-- Checkpoint A's own pure validator is a generic shape check, never a
-- specific ruling on this exact question — it is not weakened by this
-- (DB-only, not pure-module) tightening.

-- ══════════════════════ F2 additive columns ═════════════════════════════════
ALTER TABLE "customer_receivable"
  ADD COLUMN "openingEffectiveDate" DATE,
  ADD COLUMN "openingNote" VARCHAR(255);

ALTER TABLE "customer_advance"
  ADD COLUMN "openingEffectiveDate" DATE,
  ADD COLUMN "openingNote" VARCHAR(255);

-- ══════════════════════ recreate the two source-shape CHECKs (DROP + ADD — ══
-- never an edit to the migration that first created them). `>= 0` -> `> 0`
-- per §12. Final Freeze Evidence Gate §5/§6 (this same still-unfrozen
-- migration, corrected in place — no migration 42): `openingEffectiveDate`
-- is now STRUCTURALLY REQUIRED (`IS NOT NULL`) for `sourceType='OPENING'`
-- on BOTH tables — it is part of the authoritative opening business record,
-- not merely a DTO-layer convenience, so a real OPENING source without one
-- is never DB-valid. `openingNote` remains genuinely optional (may be NULL)
-- even for OPENING — no authoritative contract requires every opening
-- balance to carry a note. Both non-OPENING branches (INVOICE/PAYMENT)
-- continue to forbid ALL opening-only columns, including the date.
ALTER TABLE "customer_receivable"
  DROP CONSTRAINT "customer_receivable_source_shape_chk";

ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "customer_receivable_source_shape_chk" CHECK (
    ("sourceType" = 'INVOICE'
      AND "invoiceId" IS NOT NULL
      AND "creditAuthorized" IS NOT NULL
      AND "openingAmountMinor" IS NULL
      AND "currencyCode" IS NULL
      AND "currencyExponent" IS NULL
      AND "openingEffectiveDate" IS NULL
      AND "openingNote" IS NULL)
    OR
    ("sourceType" = 'OPENING'
      AND "invoiceId" IS NULL
      AND "creditAuthorized" IS NULL
      AND "openingAmountMinor" IS NOT NULL AND "openingAmountMinor" > 0
      AND "currencyCode" IS NOT NULL
      AND "currencyExponent" IS NOT NULL
      AND "openingEffectiveDate" IS NOT NULL)
  );

ALTER TABLE "customer_advance"
  DROP CONSTRAINT "customer_advance_source_shape_chk";

ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_source_shape_chk" CHECK (
    ("sourceType" = 'PAYMENT'
      AND "sourcePaymentId" IS NOT NULL
      AND "openingEffectiveDate" IS NULL
      AND "openingNote" IS NULL)
    OR
    ("sourceType" = 'OPENING'
      AND "sourcePaymentId" IS NULL
      AND "openingEffectiveDate" IS NOT NULL)
  );
-- NOTE: `customer_advance_amount_positive_chk` (`amountMinor > 0`, frozen
-- since Checkpoint B) ALREADY covers Advance for both sourceType values —
-- no change needed there.

-- ══════════════════════ F9 uniqueness backstop table (redesigned) ══════════
-- A pure initialization/uniqueness-provenance ticket — NO reference to any
-- source row (CustomerReceivable/CustomerAdvance remain the sole financial
-- authority, §10). One row per successful opening-balance initialization,
-- never independently mutated (no UPDATE/DELETE path exists — enforced
-- below, matching every other append-only table in this schema).
CREATE TABLE "customer_opening_balance_init" (
  "id"                       UUID NOT NULL DEFAULT uuidv7(),
  "tenantId"                 UUID NOT NULL,
  "companyId"                UUID NOT NULL,
  "branchId"                 UUID NOT NULL,
  "customerCompanyAccountId" UUID NOT NULL,
  "openingType"              TEXT NOT NULL,
  "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdByUserId"          UUID,
  CONSTRAINT "customer_opening_balance_init_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "customer_opening_balance_init"
  ADD CONSTRAINT "customer_opening_balance_init_type_chk"
    CHECK ("openingType" IN ('RECEIVABLE', 'ADVANCE'));

-- THE structural uniqueness invariant (F9/F25/F38-A/F38-B, and now the ONLY
-- mechanism enforcing it — no application pre-check is trusted).
CREATE UNIQUE INDEX "customer_opening_balance_init_one_per_account_branch_key"
  ON "customer_opening_balance_init"("tenantId", "companyId", "branchId", "customerCompanyAccountId");

ALTER TABLE "customer_opening_balance_init"
  ADD CONSTRAINT "customer_opening_balance_init_tenant_id_key" UNIQUE ("tenantId", "id"),
  ADD CONSTRAINT "customer_opening_balance_init_cca_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerCompanyAccountId") REFERENCES "customer_company_account"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_opening_balance_init_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX "customer_opening_balance_init_tenant_company_idx" ON "customer_opening_balance_init"("tenantId", "companyId");

GRANT ALL ON "customer_opening_balance_init" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_opening_balance_init" TO flower_platform;

-- Checkpoint F ABSOLUTE FINAL FREEZE GATE (§9/§10) — `flower_app` (the
-- tenant-runtime application role) must NEVER be able to write this ticket
-- directly: the SAME schema's `ALTER DEFAULT PRIVILEGES FOR ROLE
-- flower_migrate ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
-- flower_app` (task 1 foundational migration) auto-grants every new table to
-- flower_app the instant it is created, so an EXPLICIT REVOKE here is
-- required — merely omitting a GRANT line would NOT be enough, the default
-- privilege would still apply. No application code anywhere in `apps/api/src`
-- references this table (confirmed by inspection); the ONLY legitimate write
-- path is the two auto-claim triggers below, which now run SECURITY DEFINER
-- as `flower_migrate` (already `GRANT ALL`) specifically so this REVOKE does
-- not also break the legitimate trigger-driven claim.
REVOKE SELECT, INSERT, UPDATE, DELETE ON "customer_opening_balance_init" FROM flower_app;

ALTER TABLE "customer_opening_balance_init" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_opening_balance_init" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_opening_balance_init_tenant_isolation" ON "customer_opening_balance_init"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- append-only — no UPDATE, no DELETE, ever (mirrors the frozen Checkpoint B
-- pattern on customer_receivable/customer_advance/customer_advance_application/
-- customer_account_entry exactly).
CREATE FUNCTION fn_enforce_customer_opening_balance_init_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_opening_balance_init %: is append-only — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_opening_balance_init_no_update BEFORE UPDATE ON "customer_opening_balance_init" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_opening_balance_init_no_update();

CREATE FUNCTION fn_enforce_customer_opening_balance_init_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_opening_balance_init %: is append-only — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_opening_balance_init_no_delete BEFORE DELETE ON "customer_opening_balance_init" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_opening_balance_init_no_delete();

-- ══════════════════════ auto-claim triggers on the SOURCE tables ═══════════
-- Fires on EVERY insert into `customer_receivable`/`customer_advance` —
-- application code, raw SQL, future code, all equally covered. A NO-OP for
-- sourceType != 'OPENING'. A PLAIN insert (no `ON CONFLICT`) — a duplicate
-- claim hits the real unique index and raises a genuine, standard `23505`
-- unique-violation (never a hand-rolled `RAISE EXCEPTION`/P0001), which
-- `OpeningBalanceRepository` maps to a clean `409
-- OPENING_BALANCE_ALREADY_INITIALIZED` via the existing `isPgError` helper —
-- the SAME idiom already used throughout this schema for a real unique
-- constraint (e.g. `journal_entry`'s posting-fingerprint conflict).
-- SECURITY DEFINER (§9/§10): after the REVOKE above, `flower_app` (the
-- invoking role when this fires from a real app-level insert into
-- `customer_receivable`) has no direct grant on `customer_opening_balance_init`
-- — an INVOKER-rights function would now fail with permission denied on its
-- own claim insert. Running as the function's OWNER (`flower_migrate`,
-- `GRANT ALL` on this table) restores the legitimate path. `search_path` is
-- pinned to `pg_catalog, public` (never the caller's session search_path) and
-- every reference is schema-qualified — the standard hardening pair against
-- search_path hijacking of a SECURITY DEFINER function. This function does
-- nothing but a single fixed-shape INSERT of caller-supplied NEW.* column
-- values into one fixed table — no dynamic SQL, no privilege beyond that one
-- INSERT is exercised.
CREATE FUNCTION fn_claim_opening_balance_init_receivable() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."sourceType" != 'OPENING' THEN
    RETURN NEW;
  END IF;
  INSERT INTO "public"."customer_opening_balance_init"
    ("id", "tenantId", "companyId", "branchId", "customerCompanyAccountId", "openingType", "createdByUserId")
  VALUES (uuidv7(), NEW."tenantId", NEW."companyId", NEW."branchId", NEW."customerCompanyAccountId", 'RECEIVABLE', NEW."createdByUserId");
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_claim_opening_balance_init_receivable
  BEFORE INSERT ON "customer_receivable"
  FOR EACH ROW EXECUTE FUNCTION fn_claim_opening_balance_init_receivable();

CREATE FUNCTION fn_claim_opening_balance_init_advance() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."sourceType" != 'OPENING' THEN
    RETURN NEW;
  END IF;
  INSERT INTO "public"."customer_opening_balance_init"
    ("id", "tenantId", "companyId", "branchId", "customerCompanyAccountId", "openingType", "createdByUserId")
  VALUES (uuidv7(), NEW."tenantId", NEW."companyId", NEW."branchId", NEW."customerCompanyAccountId", 'ADVANCE', NEW."createdByUserId");
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_claim_opening_balance_init_advance
  BEFORE INSERT ON "customer_advance"
  FOR EACH ROW EXECUTE FUNCTION fn_claim_opening_balance_init_advance();
