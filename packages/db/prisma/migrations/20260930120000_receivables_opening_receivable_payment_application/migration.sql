-- Phase 3b task 3b.6 CHECKPOINT D (D2) — pre-D architecture-review correction.
-- Adds the ONE missing source-of-truth: a canonical `Payment` applied
-- DIRECTLY to a `customer_receivable`(sourceType='OPENING') — never routed
-- through a fake CustomerAdvance, never through PaymentAllocation (which
-- remains, unchanged, the ONLY authoritative Payment->Invoice relationship).
--
-- This migration does NOT edit any prior migration file. It is purely
-- additive: one new append-only table, two `CREATE OR REPLACE FUNCTION`
-- extensions (same technique as `20260929120000_receivables_unlimited_credit_correction`)
-- adding one new SUM term each to the existing capacity/coverage backstops,
-- and an additive extension of `customer_account_entry`'s closed CHECK sets
-- (drop+recreate, same technique already used in this checkpoint chain).
--
-- ══════════════ CANONICAL LOCK ORDER (unchanged, B15) ═══════════════════════
-- `customer_receivable_payment_application` insert: locks the coverage anchor
-- FIRST (the `customer_receivable` row itself — this table only ever targets
-- an OPENING-sourced receivable, never an Invoice), THEN locks `payment` —
-- identical ordering to the existing `customer_advance_application` trigger.

-- ── CreateTable — customer_receivable_payment_application ───────────────────
CREATE TABLE "customer_receivable_payment_application" (
    "id"                       UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                 UUID NOT NULL,
    "companyId"                UUID NOT NULL,
    "branchId"                 UUID NOT NULL,
    "customerCompanyAccountId" UUID NOT NULL,
    "paymentId"                UUID NOT NULL,
    "customerReceivableId"     UUID NOT NULL,
    "amountMinor"              BIGINT NOT NULL,
    "currencyCode"             TEXT NOT NULL,
    "currencyExponent"         SMALLINT NOT NULL,
    "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId"          UUID,

    CONSTRAINT "customer_receivable_payment_application_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "customer_receivable_payment_application_tenantId_id_key" ON "customer_receivable_payment_application"("tenantId", "id");
CREATE UNIQUE INDEX "customer_receivable_payment_application_tenantId_companyId_id_key" ON "customer_receivable_payment_application"("tenantId", "companyId", "id");
CREATE INDEX "customer_receivable_payment_application_tenantId_companyId_idx" ON "customer_receivable_payment_application"("tenantId", "companyId");
CREATE INDEX "customer_receivable_payment_application_paymentId_idx" ON "customer_receivable_payment_application"("paymentId");
CREATE INDEX "customer_receivable_payment_application_customerReceivableId_idx" ON "customer_receivable_payment_application"("customerReceivableId");
CREATE INDEX "customer_receivable_payment_application_customerCompanyAccountId_idx" ON "customer_receivable_payment_application"("customerCompanyAccountId");

-- ── AddForeignKey — plain FKs ─────────────────────────────────────────────────
ALTER TABLE "customer_receivable_payment_application"
  ADD CONSTRAINT "customer_receivable_payment_application_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "customer_receivable_payment_application_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_receivable_payment_application_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_receivable_payment_application_customerCompanyAccountId_fkey" FOREIGN KEY ("customerCompanyAccountId") REFERENCES "customer_company_account"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_receivable_payment_application_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_receivable_payment_application_customerReceivableId_fkey" FOREIGN KEY ("customerReceivableId") REFERENCES "customer_receivable"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── AddForeignKey — composite tenant/company/branch-safe FKs ────────────────
ALTER TABLE "customer_receivable_payment_application"
  ADD CONSTRAINT "customer_receivable_payment_application_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_payment_application_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_payment_application_account_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerCompanyAccountId") REFERENCES "customer_company_account"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_payment_application_receivable_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerReceivableId") REFERENCES "customer_receivable"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  -- same-branch requirement between this application and the Payment it draws
  -- from (D3) — a Payment recorded in branch A can never fund an application
  -- row filed under branch B.
  ADD CONSTRAINT "customer_receivable_payment_application_payment_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "paymentId") REFERENCES "payment"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_payment_application_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode") REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_payment_application_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent") REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE NO ACTION;

-- ── CHECK constraints — defense-in-depth value shape ─────────────────────────
ALTER TABLE "customer_receivable_payment_application"
  ADD CONSTRAINT "customer_receivable_payment_application_amount_positive_chk" CHECK ("amountMinor" > 0);

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "customer_receivable_payment_application" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_receivable_payment_application" TO flower_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_receivable_payment_application" TO flower_app;

-- ══════════════════════ Row-Level Security (CLAUDE.md rule 7) ═══════════════
ALTER TABLE "customer_receivable_payment_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_receivable_payment_application" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_receivable_payment_application_tenant_isolation" ON "customer_receivable_payment_application"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ══════════════════════ extend the shared capacity/coverage backstops ═══════
-- Additive only: same signature, same locking semantics, one new SUM term
-- each. Every existing consumption path (PaymentAllocation, CustomerAdvance)
-- is completely unaffected — this only makes a THIRD/SECOND draw visible to
-- the SAME already-frozen lock-then-validate arithmetic.
CREATE OR REPLACE FUNCTION fn_lock_and_validate_payment_capacity(p_payment_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  payment_amount BIGINT;
  consumed BIGINT;
BEGIN
  SELECT "amountMinor" INTO payment_amount FROM "payment" WHERE "id" = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment %: does not exist', p_payment_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO consumed FROM "payment_allocation" WHERE "paymentId" = p_payment_id;
  consumed := consumed + COALESCE((SELECT SUM("amountMinor") FROM "customer_advance" WHERE "sourcePaymentId" = p_payment_id), 0);
  consumed := consumed + COALESCE((SELECT SUM("amountMinor") FROM "customer_receivable_payment_application" WHERE "paymentId" = p_payment_id), 0);
  IF consumed + p_proposed_amount > payment_amount THEN
    RAISE EXCEPTION 'payment %: consumption would exceed amountMinor (payment=%, already consumed=%, proposed=%)', p_payment_id, payment_amount, consumed, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_lock_and_validate_opening_receivable_coverage(p_receivable_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  principal BIGINT;
  covered BIGINT;
BEGIN
  SELECT "openingAmountMinor" INTO principal FROM "customer_receivable" WHERE "id" = p_receivable_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable %: does not exist', p_receivable_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO covered FROM "customer_advance_application" WHERE "customerReceivableId" = p_receivable_id;
  covered := covered + COALESCE((SELECT SUM("amountMinor") FROM "customer_receivable_payment_application" WHERE "customerReceivableId" = p_receivable_id), 0);
  IF covered + p_proposed_amount > principal THEN
    RAISE EXCEPTION 'customer_receivable %: (OPENING) coverage would exceed openingAmountMinor (principal=%, already covered=%, proposed=%)', p_receivable_id, principal, covered, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ structural integrity trigger (D3) ═══════════════════
-- A CustomerReceivablePaymentApplication must structurally prove: target
-- CustomerReceivable.sourceType = OPENING (an INVOICE-sourced target is
-- unconditionally rejected — that path is PaymentAllocation's alone); same
-- tenant/company/branch/account; the Payment's OWN attributed customer
-- (resolved exactly like `fn_check_customer_advance_payment_source_integrity`
-- resolves it for a PAYMENT-sourced CustomerAdvance: CUSTOMER_RECEIPT ->
-- attempt.customerCompanyAccountId directly; INVOICE_COLLECTION -> the target
-- Invoice's Order's customer) matches this row's own customerCompanyAccountId
-- AND the target receivable's own account; currency/exponent match both the
-- Payment and the Opening Receivable. THEN locks+validates opening-receivable
-- coverage BEFORE locking+validating payment capacity (canonical order:
-- coverage anchor before Payment).
CREATE FUNCTION fn_check_customer_receivable_payment_application_integrity() RETURNS trigger AS $$
DECLARE
  recv RECORD;
  pay RECORD;
  att RECORD;
  ord_customer_id UUID;
BEGIN
  SELECT * INTO recv FROM "customer_receivable" WHERE "id" = NEW."customerReceivableId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: referenced customerReceivableId % does not exist', NEW."id", NEW."customerReceivableId";
  END IF;
  IF recv."sourceType" != 'OPENING' THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: target customerReceivable % is not OPENING-sourced (got %) — an INVOICE-sourced receivable must use PaymentAllocation, never this table', NEW."id", NEW."customerReceivableId", recv."sourceType";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM recv."tenantId" OR NEW."companyId" IS DISTINCT FROM recv."companyId" OR NEW."branchId" IS DISTINCT FROM recv."branchId" THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: scope does not match customerReceivable %', NEW."id", NEW."customerReceivableId";
  END IF;
  IF NEW."customerCompanyAccountId" IS DISTINCT FROM recv."customerCompanyAccountId" THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: customerCompanyAccountId does not match customerReceivable %''s own account', NEW."id", NEW."customerReceivableId";
  END IF;
  IF NEW."currencyCode" IS DISTINCT FROM recv."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM recv."currencyExponent" THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: currency does not match customerReceivable %', NEW."id", NEW."customerReceivableId";
  END IF;

  SELECT * INTO pay FROM "payment" WHERE "id" = NEW."paymentId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: referenced paymentId % does not exist', NEW."id", NEW."paymentId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM pay."tenantId"
     OR NEW."companyId" IS DISTINCT FROM pay."companyId"
     OR NEW."branchId" IS DISTINCT FROM pay."branchId"
     OR NEW."currencyCode" IS DISTINCT FROM pay."currencyCode"
     OR NEW."currencyExponent" IS DISTINCT FROM pay."currencyExponent"
  THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: does not match its payment % (scope/currency)', NEW."id", NEW."paymentId";
  END IF;

  SELECT * INTO att FROM "payment_attempt" WHERE "id" = pay."sourceAttemptId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: payment %''s sourceAttempt does not exist', NEW."id", NEW."paymentId";
  END IF;

  IF att."receiptPurpose" = 'CUSTOMER_RECEIPT' THEN
    IF att."customerCompanyAccountId" IS DISTINCT FROM NEW."customerCompanyAccountId" THEN
      RAISE EXCEPTION 'customer_receivable_payment_application %: customerCompanyAccountId does not match payment %''s attributed customer account', NEW."id", NEW."paymentId";
    END IF;
  ELSE
    SELECT o."customerId" INTO ord_customer_id FROM "order" o WHERE o."id" = att."orderId";
    IF ord_customer_id IS NULL THEN
      RAISE EXCEPTION 'customer_receivable_payment_application %: payment %''s order has no associated customer (walk-in)', NEW."id", NEW."paymentId";
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "customer_company_account" cca
      WHERE cca."id" = NEW."customerCompanyAccountId" AND cca."customerId" = ord_customer_id AND cca."companyId" = NEW."companyId"
    ) THEN
      RAISE EXCEPTION 'customer_receivable_payment_application %: customerCompanyAccountId does not match payment %''s attributed customer', NEW."id", NEW."paymentId";
    END IF;
  END IF;

  PERFORM fn_lock_and_validate_opening_receivable_coverage(recv."id", NEW."amountMinor");
  PERFORM fn_lock_and_validate_payment_capacity(NEW."paymentId", NEW."amountMinor");

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_customer_receivable_payment_application_integrity
  BEFORE INSERT ON "customer_receivable_payment_application"
  FOR EACH ROW EXECUTE FUNCTION fn_check_customer_receivable_payment_application_integrity();

-- ══════════════════════ append-only — no UPDATE, no DELETE, ever ═══════════
CREATE FUNCTION fn_enforce_customer_receivable_payment_application_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_receivable_payment_application %: is append-only — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_receivable_payment_application_no_update BEFORE UPDATE ON "customer_receivable_payment_application" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_receivable_payment_application_no_update();

CREATE FUNCTION fn_enforce_customer_receivable_payment_application_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_receivable_payment_application %: is append-only — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_receivable_payment_application_no_delete BEFORE DELETE ON "customer_receivable_payment_application" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_receivable_payment_application_no_delete();

-- ══════════════════════ customer_account_entry extension (D7) ══════════════
-- Additive 8th entryKind + 6th reference column. Do NOT overload
-- PAYMENT_ALLOCATION — that kind's cross-table consistency meaning
-- ("references a payment_allocation row, always Invoice-sourced") stays
-- exact and unambiguous.
ALTER TABLE "customer_account_entry" ADD COLUMN "customerReceivablePaymentApplicationId" UUID;

CREATE UNIQUE INDEX "customer_account_entry_customerReceivablePaymentApplicationId_key" ON "customer_account_entry"("customerReceivablePaymentApplicationId");

ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_customerReceivablePaymentApplicationId_fkey"
    FOREIGN KEY ("customerReceivablePaymentApplicationId") REFERENCES "customer_receivable_payment_application"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "customer_account_entry" DROP CONSTRAINT "customer_account_entry_kind_chk";
ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_kind_chk" CHECK ("entryKind" IN
    ('INVOICE', 'PAYMENT', 'PAYMENT_ALLOCATION', 'OPENING_RECEIVABLE_PAYMENT_APPLIED', 'ADVANCE', 'ADVANCE_APPLIED', 'OPENING_RECEIVABLE', 'OPENING_ADVANCE'));

ALTER TABLE "customer_account_entry" DROP CONSTRAINT "customer_account_entry_reference_xor_chk";
ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_reference_xor_chk" CHECK (
    ("entryKind" IN ('INVOICE', 'OPENING_RECEIVABLE')
      AND "customerReceivableId" IS NOT NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT'
      AND "paymentId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT_ALLOCATION'
      AND "paymentAllocationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL)
    OR ("entryKind" = 'OPENING_RECEIVABLE_PAYMENT_APPLIED'
      AND "customerReceivablePaymentApplicationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL)
    OR ("entryKind" IN ('ADVANCE', 'OPENING_ADVANCE')
      AND "customerAdvanceId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL)
    OR ("entryKind" = 'ADVANCE_APPLIED'
      AND "customerAdvanceApplicationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL)
  );

-- fn_check_customer_account_entry_source_type needs NO behavioral change —
-- OPENING_RECEIVABLE_PAYMENT_APPLIED's sole reference column
-- (customerReceivablePaymentApplicationId) already carries a real FK to a
-- table whose own insert trigger unconditionally proves its target is
-- OPENING-sourced (above); there is no separate "sourceType" on that entity
-- needing cross-validation here, exactly like PAYMENT/PAYMENT_ALLOCATION/
-- ADVANCE_APPLIED today. The existing function is left completely untouched.
