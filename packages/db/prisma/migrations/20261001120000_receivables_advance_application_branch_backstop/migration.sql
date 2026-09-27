-- Phase 3b task 3b.6 Checkpoint E FINAL HARDENING — structural branch
-- backstop for `customer_advance_application`.
--
-- Confirmed defect (re-inspection of the live `fn_check_customer_advance_application_integrity`
-- trigger, frozen in `20260927130000_receivables_core_schema`): the trigger
-- checks `NEW.branchId` against the referenced CustomerAdvance's OWN
-- branchId, but NEVER checks the referenced CustomerReceivable's branchId
-- against anything at all. Checkpoint E's frozen policy ("No cross-branch
-- advance pooling in 3b.6") was therefore enforced ONLY in application code
-- — a raw/direct INSERT (or a future repository defect) could structurally
-- create a cross-branch application the DB itself would accept.
--
-- This migration does NOT edit any of the 39 existing migrations. It is
-- purely additive/corrective: two new branch-inclusive composite unique
-- indexes (needed as FK targets), two composite FKs on
-- `customer_advance_application` that REPLACE (drop + re-add) the existing
-- tenant+company-only ones with tenant+company+BRANCH-inclusive versions,
-- and one `CREATE OR REPLACE FUNCTION` extending the existing trigger body
-- with an explicit, friendly branch-equality check (fires BEFORE the
-- composite FK would ever be reached, since BEFORE ROW triggers run before
-- Postgres's own FK constraint checks) — the SAME "trigger message first,
-- FK is the true structural backstop" pattern already used throughout this
-- schema (e.g. currency/account checks above it).
--
-- Because BOTH new composite FKs constrain against the SAME
-- `customer_advance_application.branchId` column
-- (`(tenantId, companyId, branchId, customerAdvanceId) -> customer_advance`
-- and `(tenantId, companyId, branchId, customerReceivableId) ->
-- customer_receivable`), they TRANSITIVELY force
-- `customer_advance.branchId = customer_advance_application.branchId =
-- customer_receivable.branchId` — exactly the frozen invariant, expressed
-- as two ordinary composite FKs rather than a novel constraint type.
--
-- No existing invariant is weakened: same tenant/company/account/currency/
-- exponent/amount-positive/capacity/coverage checks are all left completely
-- untouched below.
--
-- Lock order is UNCHANGED — this migration adds no new lock acquisition of
-- any kind (composite FK checks are ordinary referential-integrity lookups,
-- not row locks in the sense of B15's hierarchy; the trigger's own existing
-- `PERFORM fn_lock_and_validate_*` call order is untouched, still
-- coverage-anchor before CustomerAdvance).

-- ══════════════════════ additive composite unique indexes (FK targets) ═════
CREATE UNIQUE INDEX "customer_advance_tenantId_companyId_branchId_id_key" ON "customer_advance"("tenantId", "companyId", "branchId", "id");
CREATE UNIQUE INDEX "customer_receivable_tenantId_companyId_branchId_id_key" ON "customer_receivable"("tenantId", "companyId", "branchId", "id");

-- ══════════════════════ replace the two tenant+company-only composite FKs ══
-- with tenant+company+branch-inclusive versions (drop + re-add — this is a
-- NEW migration correcting a prior one's FK, never an edit to that prior
-- migration file itself; same technique already used by
-- `20260929120000_receivables_unlimited_credit_correction` for a CHECK).
ALTER TABLE "customer_advance_application"
  DROP CONSTRAINT "customer_advance_application_advance_tenant_company_fkey",
  DROP CONSTRAINT "customer_advance_application_receivable_tenant_company_fkey";

ALTER TABLE "customer_advance_application"
  ADD CONSTRAINT "customer_advance_application_advance_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "customerAdvanceId") REFERENCES "customer_advance"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_application_receivable_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "customerReceivableId") REFERENCES "customer_receivable"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ══════════════════════ extend the trigger with an explicit, friendly ══════
-- branch-equality check — additive only, every existing check body line is
-- reproduced verbatim below (CREATE OR REPLACE requires the full body).
CREATE OR REPLACE FUNCTION fn_check_customer_advance_application_integrity() RETURNS trigger AS $$
DECLARE
  adv RECORD;
  recv RECORD;
BEGIN
  SELECT * INTO adv FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance_application %: referenced customerAdvanceId % does not exist', NEW."id", NEW."customerAdvanceId";
  END IF;
  SELECT * INTO recv FROM "customer_receivable" WHERE "id" = NEW."customerReceivableId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance_application %: referenced customerReceivableId % does not exist', NEW."id", NEW."customerReceivableId";
  END IF;

  IF NEW."tenantId" IS DISTINCT FROM adv."tenantId" OR NEW."companyId" IS DISTINCT FROM adv."companyId" OR NEW."branchId" IS DISTINCT FROM adv."branchId" THEN
    RAISE EXCEPTION 'customer_advance_application %: scope does not match customerAdvance %', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM recv."tenantId" OR NEW."companyId" IS DISTINCT FROM recv."companyId" THEN
    RAISE EXCEPTION 'customer_advance_application %: scope does not match customerReceivable %', NEW."id", NEW."customerReceivableId";
  END IF;
  -- task 3b.6 Checkpoint E final hardening — "No cross-branch advance
  -- pooling in 3b.6" (E5), now a structural check, not application-only.
  -- Together with the existing NEW.branchId-vs-adv.branchId check above,
  -- this closes BOTH directions: an application row claiming the
  -- ADVANCE's own branch is rejected here (recv mismatch); one claiming
  -- the RECEIVABLE's own branch is already rejected by the check above
  -- (adv mismatch) — a caller cannot bypass the rule by picking either side.
  IF recv."branchId" IS DISTINCT FROM adv."branchId" THEN
    RAISE EXCEPTION 'customer_advance_application %: customerAdvance %''s branch does not match customerReceivable %''s branch — no cross-branch advance pooling', NEW."id", NEW."customerAdvanceId", NEW."customerReceivableId";
  END IF;
  IF adv."customerCompanyAccountId" IS DISTINCT FROM recv."customerCompanyAccountId" THEN
    RAISE EXCEPTION 'customer_advance_application %: customerAdvance %''s account does not match customerReceivable %''s account', NEW."id", NEW."customerAdvanceId", NEW."customerReceivableId";
  END IF;
  IF NEW."currencyCode" IS DISTINCT FROM adv."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM adv."currencyExponent" THEN
    RAISE EXCEPTION 'customer_advance_application %: currency does not match customerAdvance %', NEW."id", NEW."customerAdvanceId";
  END IF;

  IF recv."sourceType" = 'INVOICE' THEN
    PERFORM fn_lock_and_validate_invoice_coverage(recv."invoiceId", NEW."amountMinor");
  ELSE
    PERFORM fn_lock_and_validate_opening_receivable_coverage(recv."id", NEW."amountMinor");
  END IF;

  PERFORM fn_lock_and_validate_advance_capacity(NEW."customerAdvanceId", NEW."amountMinor");

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- the trigger itself (`trg_check_customer_advance_application_integrity`,
-- BEFORE INSERT) is untouched — `CREATE OR REPLACE FUNCTION` swaps only the
-- function body it already points to.
