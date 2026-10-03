-- Phase 3b task 3b.8 FINAL HARD-GATE DB INTEGRITY CLOSURE — migration 49: currency authority (O-1) +
-- credit-note-coverage-release scope / customer attribution (O-2).
--
-- Owner decision "TASK 3b.8 — FINAL HARD-GATE DB INTEGRITY CLOSURE: APPROVE MIGRATION 49". Migration 48 is
-- APPROVED / FROZEN and is not touched.
--
-- ROOT CAUSES (proved by inspection of the frozen shapes + RED tests written first)
--   O-1  PHASE-3B-PLAN §A.8 / D3b-15: every Phase 3b financial chain — "order snapshot, invoice, payment,
--        allocation, AR, advance, settlement, cancellation, refund, credit note, journal" — uses the owning
--        Company's ONE accounting currency (Company.defaultCurrency); no FX anywhere; a mismatch fails safely.
--        Every money table of tasks 3b.1–3b.7 enforces it structurally with TWO composite FKs
--        (<table>_currency_company_fkey -> company(tenantId, id, defaultCurrency) and
--        <table>_currency_exponent_fkey -> currency(code, exponent)). The NINE tables migration 44 created
--        (credit_note, credit_note_line, credit_note_coverage_release, cancellation_charge, refund,
--        refund_attempt, refund_attempt_entitlement_reservation, customer_advance_refund_application,
--        provider_refund_event) carry NEITHER, and no 3b.8 trigger compared a refund / attempt / application /
--        reservation / credit note / credit-note line / charge to the Payment, advance, refund, attempt,
--        invoice, order or Company it belongs to — only release<->credit note/advance/allocation/application
--        and reservation<->release were compared. Their "currencyCode" / "currencyExponent" were free text.
--   O-2A credit_note_coverage_release has only simple single-column FKs and fn_check_credit_note_coverage_release_
--        integrity (migrations 44/47) never compared the release's tenant / company / branch to the CreditNote or
--        the CustomerAdvance it joins.
--   O-2B nothing bound a CREDIT_NOTE advance's customer account to the customer of the cancelled invoice:
--        credit_note has no customer column; its customer is credit_note -> invoice -> order.customerId, the very
--        chain the application derives the advance's account from (OrderRepository, join-gated), but the DATABASE
--        accepted any account of the tenant.
--
-- EXACT CONTENTS (nothing else — no table, column, index, CHECK, FK, UNIQUE, policy, grant, RLS flag, view, enum
-- value, money field, route, permission, release/source kind or provider contract; NO edit to migrations 1–48;
-- NO row is rewritten; NO new trigger — every hook below already exists): EIGHT functions are REPLACED with
-- CREATE OR REPLACE (SAME signature, SAME trigger binding):
--   fn_check_refund_scope_and_capacity()  [refund -> source Payment / converting RefundAttempt / Company currency]
--   fn_check_refund_attempt_scope_and_capacity()  [refund_attempt -> source Payment / Company currency]
--   fn_check_customer_advance_refund_application_integrity()  [refund application -> Refund + CustomerAdvance + Company currency]
--   fn_check_refund_attempt_reservation_integrity()  [reservation -> RefundAttempt + CustomerAdvance + Company currency]
--   fn_check_credit_note_coverage_release_integrity()  [release -> CreditNote + CustomerAdvance scope, CREDIT_NOTE advance customer attribution]
--   fn_check_credit_note_invoice_capacity()  [credit note -> Invoice + Company currency]
--   fn_check_credit_note_line_capacity()  [credit note line -> CreditNote currency]
--   fn_check_cancellation_charge_provenance()  [cancellation charge -> Order + Company currency]
--
-- EVERY OLD LINE IS PRESERVED BYTE-FOR-BYTE. Each body below is the latest definition (migration 44, 47 or 48)
-- copied verbatim with NEW statements INSERTED before an existing anchor line — no old line is edited, so every
-- pre-existing check, RAISE EXCEPTION message and call order (including migration 47's nested CREDIT_NOTE
-- provenance rules and migration 48's scope / provenance guards) is unchanged. Only new reads of immutable rows
-- were added (plain SELECT, no FOR UPDATE / FOR SHARE), taken before / after the existing locks without moving
-- them, so the ORDER -> INVOICE -> … lock hierarchy (F4) is untouched.
--
-- THE RULES ADDED
--   Currency (O-1) — exact currency code AND exponent equality, never a conversion:
--     refund                       = its source Payment, = its converting RefundAttempt (if any), = Company currency
--     refund_attempt               = its source Payment, = Company currency
--     customer_advance_refund_application = its Refund, = its CustomerAdvance, = Company currency
--     refund_attempt_entitlement_reservation = its RefundAttempt, = its CustomerAdvance (its release was already
--                                    checked), = Company currency
--     credit_note                  = its Invoice, = Company currency            (deferred header check)
--     credit_note_line             = its CreditNote
--     cancellation_charge          = its Order, = Company currency
--     "Company currency" = company.defaultCurrency with the exponent of the currency table's row for it — exactly
--     what the two composite FKs of every earlier money table prove.
--   Release scope (O-2A) — credit_note_coverage_release: tenant / company / branch must equal the CreditNote's
--     AND the CustomerAdvance's.
--   Customer attribution (O-2B) — credit_note_coverage_release: the funded advance's customer account must exist,
--     live in the release's tenant / company, and belong to the customer of credit_note -> invoice -> order; a
--     walk-in (customer-less) invoice can never fund a customer advance.

-- ══════════════════════ fn_check_refund_scope_and_capacity — refund -> source Payment / converting RefundAttempt / Company currency ═════
CREATE OR REPLACE FUNCTION fn_check_refund_scope_and_capacity() RETURNS trigger AS $$
DECLARE
  ra RECORD;
  pay RECORD;
  pay_cur RECORD;
  ra_cur RECORD;
  co RECORD;
BEGIN
  -- (migration 48) the source Payment must exist and belong to EXACTLY this refund's tenant / company /
  -- branch — an existence check alone would let a refund stamp another branch / company / tenant.
  IF NEW."sourcePaymentId" IS NOT NULL THEN
    SELECT "tenantId", "companyId", "branchId" INTO pay FROM "payment" WHERE "id" = NEW."sourcePaymentId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refund %: referenced sourcePaymentId % does not exist', NEW."id", NEW."sourcePaymentId";
    END IF;
    IF NEW."tenantId" IS DISTINCT FROM pay."tenantId"
       OR NEW."companyId" IS DISTINCT FROM pay."companyId"
       OR NEW."branchId" IS DISTINCT FROM pay."branchId"
    THEN
      RAISE EXCEPTION 'refund %: scope does not match sourcePayment %', NEW."id", NEW."sourcePaymentId";
    END IF;
  END IF;

  -- (migration 49) currency authority (D3b-15 / PHASE-3B-PLAN §A.8): the refund must be denominated in EXACTLY
  -- its source Payment's currency — no FX, no conversion, a mismatch fails safely.
  IF NEW."sourcePaymentId" IS NOT NULL THEN
    SELECT "currencyCode", "currencyExponent" INTO pay_cur FROM "payment" WHERE "id" = NEW."sourcePaymentId";
    IF NEW."currencyCode" IS DISTINCT FROM pay_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM pay_cur."currencyExponent" THEN
      RAISE EXCEPTION 'refund %: currency %/% does not match sourcePayment %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."sourcePaymentId", pay_cur."currencyCode", pay_cur."currencyExponent";
    END IF;
  END IF;

  IF NEW."sourceRefundAttemptId" IS NOT NULL THEN
    SELECT "sourcePaymentId", "state" INTO ra FROM "refund_attempt" WHERE "id" = NEW."sourceRefundAttemptId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refund %: referenced refund_attempt % does not exist', NEW."id", NEW."sourceRefundAttemptId";
    END IF;
    IF ra."sourcePaymentId" != NEW."sourcePaymentId" THEN
      RAISE EXCEPTION 'refund %: sourcePaymentId does not match refund_attempt %''s own sourcePaymentId', NEW."id", NEW."sourceRefundAttemptId";
    END IF;
    IF ra."state" != 'PENDING' THEN
      RAISE EXCEPTION 'refund %: converting refund_attempt % is not PENDING (state=%)', NEW."id", NEW."sourceRefundAttemptId", ra."state";
    END IF;
  END IF;

  -- (migration 49) a provider conversion must also match the RefundAttempt it converts.
  IF NEW."sourceRefundAttemptId" IS NOT NULL THEN
    SELECT "currencyCode", "currencyExponent" INTO ra_cur FROM "refund_attempt" WHERE "id" = NEW."sourceRefundAttemptId";
    IF NEW."currencyCode" IS DISTINCT FROM ra_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM ra_cur."currencyExponent" THEN
      RAISE EXCEPTION 'refund %: currency %/% does not match refund_attempt %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."sourceRefundAttemptId", ra_cur."currencyCode", ra_cur."currencyExponent";
    END IF;
  END IF;
  -- (migration 49) Company authority: the ONE accounting currency (D3b-15 — no FX, a mismatch fails safely).
  SELECT c."defaultCurrency", cur."exponent" INTO co
    FROM "company" c LEFT JOIN "currency" cur ON cur."code" = c."defaultCurrency"
   WHERE c."id" = NEW."companyId";
  IF NEW."currencyCode" IS DISTINCT FROM co."defaultCurrency" OR NEW."currencyExponent" IS DISTINCT FROM co."exponent" THEN
    RAISE EXCEPTION 'refund %: currency %/% does not match company %''s authoritative currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."companyId", co."defaultCurrency", co."exponent";
  END IF;

  -- §1/§3 conversion-safe capacity: exclude the converting attempt's own
  -- PENDING reservation (still PENDING at this exact instant — its state
  -- flips to SUCCEEDED only AFTER this Refund row exists) so the SAME
  -- economic amount is never counted twice.
  PERFORM fn_lock_and_validate_payment_refund_capacity(NEW."sourcePaymentId", NEW."amountMinor", NEW."sourceRefundAttemptId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ fn_check_refund_attempt_scope_and_capacity — refund_attempt -> source Payment / Company currency ═════
CREATE OR REPLACE FUNCTION fn_check_refund_attempt_scope_and_capacity() RETURNS trigger AS $$
DECLARE
  cred RECORD;
  pay RECORD;
  pay_cur RECORD;
  co RECORD;
BEGIN
  SELECT "tenantId", "companyId", "branchId", "provider" INTO cred
    FROM "provider_credential" WHERE "id" = NEW."providerCredentialId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_attempt %: referenced provider_credential % does not exist', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS NULL OR cred."branchId" IS NULL THEN
    RAISE EXCEPTION 'refund_attempt %: provider_credential % must be branch-scoped', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."tenantId" != NEW."tenantId" OR cred."companyId" != NEW."companyId" OR cred."branchId" != NEW."branchId" THEN
    RAISE EXCEPTION 'refund_attempt %: provider_credential % scope does not match this row''s own tenant/company/branch', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."provider" != NEW."providerKey" THEN
    RAISE EXCEPTION 'refund_attempt %: providerKey % does not match provider_credential %''s own provider %', NEW."id", NEW."providerKey", NEW."providerCredentialId", cred."provider";
  END IF;

  -- (migration 48) the source Payment must exist and belong to EXACTLY this attempt's tenant / company /
  -- branch (so the Payment, the attempt and the credential all share one scope).
  IF NEW."sourcePaymentId" IS NOT NULL THEN
    SELECT "tenantId", "companyId", "branchId" INTO pay FROM "payment" WHERE "id" = NEW."sourcePaymentId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refund_attempt %: referenced sourcePaymentId % does not exist', NEW."id", NEW."sourcePaymentId";
    END IF;
    IF NEW."tenantId" IS DISTINCT FROM pay."tenantId"
       OR NEW."companyId" IS DISTINCT FROM pay."companyId"
       OR NEW."branchId" IS DISTINCT FROM pay."branchId"
    THEN
      RAISE EXCEPTION 'refund_attempt %: scope does not match sourcePayment %', NEW."id", NEW."sourcePaymentId";
    END IF;
  END IF;

  -- (migration 49) currency authority: the attempt must be denominated in EXACTLY its source Payment's
  -- currency, and in the Company's one accounting currency.
  IF NEW."sourcePaymentId" IS NOT NULL THEN
    SELECT "currencyCode", "currencyExponent" INTO pay_cur FROM "payment" WHERE "id" = NEW."sourcePaymentId";
    IF NEW."currencyCode" IS DISTINCT FROM pay_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM pay_cur."currencyExponent" THEN
      RAISE EXCEPTION 'refund_attempt %: currency %/% does not match sourcePayment %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."sourcePaymentId", pay_cur."currencyCode", pay_cur."currencyExponent";
    END IF;
  END IF;
  -- (migration 49) Company authority: the ONE accounting currency (D3b-15 — no FX, a mismatch fails safely).
  SELECT c."defaultCurrency", cur."exponent" INTO co
    FROM "company" c LEFT JOIN "currency" cur ON cur."code" = c."defaultCurrency"
   WHERE c."id" = NEW."companyId";
  IF NEW."currencyCode" IS DISTINCT FROM co."defaultCurrency" OR NEW."currencyExponent" IS DISTINCT FROM co."exponent" THEN
    RAISE EXCEPTION 'refund_attempt %: currency %/% does not match company %''s authoritative currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."companyId", co."defaultCurrency", co."exponent";
  END IF;

  PERFORM fn_lock_and_validate_payment_refund_capacity(NEW."sourcePaymentId", NEW."requestedAmountMinor", NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ fn_check_customer_advance_refund_application_integrity — refund application -> Refund + CustomerAdvance + Company currency ═════
CREATE OR REPLACE FUNCTION fn_check_customer_advance_refund_application_integrity() RETURNS trigger AS $$
DECLARE
  rf RECORD;
  adv RECORD;
  provenance_payment_id UUID;
  rf_cur RECORD;
  adv_cur RECORD;
  co RECORD;
BEGIN
  SELECT "sourceRefundAttemptId", "sourcePaymentId", "tenantId", "companyId", "branchId" INTO rf FROM "refund" WHERE "id" = NEW."refundId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: referenced refund % does not exist', NEW."id", NEW."refundId";
  END IF;
  IF NEW."tenantId" != rf."tenantId" OR NEW."companyId" != rf."companyId" OR NEW."branchId" != rf."branchId" THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: scope mismatch against refund %', NEW."id", NEW."refundId";
  END IF;

  -- (migration 48) the OTHER side: the CustomerAdvance being consumed.
  SELECT "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "sourcePaymentId" INTO adv
    FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: referenced customerAdvanceId % does not exist', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM adv."tenantId"
     OR NEW."companyId" IS DISTINCT FROM adv."companyId"
     OR NEW."branchId" IS DISTINCT FROM adv."branchId"
  THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: scope does not match customerAdvance %', NEW."id", NEW."customerAdvanceId";
  END IF;
  -- customer scope: the advance's customer account must live in this tenant / company
  IF NOT EXISTS (
    SELECT 1 FROM "customer_company_account" cca
     WHERE cca."id" = adv."customerCompanyAccountId" AND cca."tenantId" = NEW."tenantId" AND cca."companyId" = NEW."companyId"
  ) THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: customerAdvance %''s customer account % is not in this tenant/company', NEW."id", NEW."customerAdvanceId", adv."customerCompanyAccountId";
  END IF;
  -- (migration 49) currency authority: the Refund and the CustomerAdvance it consumes must represent the SAME
  -- currency (no FX), and it must be the Company's one accounting currency.
  SELECT "currencyCode", "currencyExponent" INTO rf_cur FROM "refund" WHERE "id" = NEW."refundId";
  IF NEW."currencyCode" IS DISTINCT FROM rf_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM rf_cur."currencyExponent" THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: currency %/% does not match refund %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."refundId", rf_cur."currencyCode", rf_cur."currencyExponent";
  END IF;
  SELECT "currencyCode", "currencyExponent" INTO adv_cur FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
  IF NEW."currencyCode" IS DISTINCT FROM adv_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM adv_cur."currencyExponent" THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: currency %/% does not match customerAdvance %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."customerAdvanceId", adv_cur."currencyCode", adv_cur."currencyExponent";
  END IF;
  -- (migration 49) Company authority: the ONE accounting currency (D3b-15 — no FX, a mismatch fails safely).
  SELECT c."defaultCurrency", cur."exponent" INTO co
    FROM "company" c LEFT JOIN "currency" cur ON cur."code" = c."defaultCurrency"
   WHERE c."id" = NEW."companyId";
  IF NEW."currencyCode" IS DISTINCT FROM co."defaultCurrency" OR NEW."currencyExponent" IS DISTINCT FROM co."exponent" THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: currency %/% does not match company %''s authoritative currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."companyId", co."defaultCurrency", co."exponent";
  END IF;

  -- Payment provenance: the advance must trace to the refund's source Payment. A CREDIT_NOTE advance carries it
  -- in its ONE funding release (frozen 1:1); a PAYMENT advance in its own sourcePaymentId; anything else
  -- (OPENING, or a credit-note chain that ends in an opening advance — NULL) has none and can never fund a Refund.
  IF adv."sourceType" = 'CREDIT_NOTE' THEN
    SELECT "sourcePaymentId" INTO provenance_payment_id
      FROM "credit_note_coverage_release" WHERE "customerAdvanceId" = NEW."customerAdvanceId";
  ELSIF adv."sourceType" = 'PAYMENT' THEN
    provenance_payment_id := adv."sourcePaymentId";
  END IF;
  IF provenance_payment_id IS NULL THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: customerAdvance % has no underlying Payment provenance and can never fund a Refund', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF provenance_payment_id IS DISTINCT FROM rf."sourcePaymentId" THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: customerAdvance %''s underlying Payment provenance does not equal refund %''s sourcePaymentId', NEW."id", NEW."customerAdvanceId", NEW."refundId";
  END IF;

  PERFORM fn_lock_and_validate_advance_capacity(NEW."customerAdvanceId", NEW."amountMinor", rf."sourceRefundAttemptId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ fn_check_refund_attempt_reservation_integrity — reservation -> RefundAttempt + CustomerAdvance + Company currency ═════
CREATE OR REPLACE FUNCTION fn_check_refund_attempt_reservation_integrity() RETURNS trigger AS $$
DECLARE
  ra RECORD;
  rel RECORD;
  adv RECORD;
  ra_cur RECORD;
  adv_cur RECORD;
  co RECORD;
BEGIN
  SELECT "sourcePaymentId", "tenantId", "companyId", "branchId" INTO ra
    FROM "refund_attempt" WHERE "id" = NEW."refundAttemptId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: referenced refund_attempt % does not exist', NEW."id", NEW."refundAttemptId";
  END IF;

  SELECT "customerAdvanceId", "sourcePaymentId", "currencyCode", "currencyExponent" INTO rel
    FROM "credit_note_coverage_release" WHERE "id" = NEW."creditNoteCoverageReleaseId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: referenced credit_note_coverage_release % does not exist', NEW."id", NEW."creditNoteCoverageReleaseId";
  END IF;

  IF rel."customerAdvanceId" != NEW."customerAdvanceId" THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: customerAdvanceId does not match the frozen 1:1 release/advance pair', NEW."id";
  END IF;
  IF rel."sourcePaymentId" IS DISTINCT FROM ra."sourcePaymentId" THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: release''s own sourcePaymentId does not equal the parent refund_attempt''s sourcePaymentId (an OPENING_ADVANCE-derived release can never fund a RefundAttempt)', NEW."id";
  END IF;
  IF NEW."currencyCode" != rel."currencyCode" OR NEW."currencyExponent" != rel."currencyExponent" THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: currency mismatch against the funding release', NEW."id";
  END IF;
  IF NEW."tenantId" != ra."tenantId" OR NEW."companyId" != ra."companyId" OR NEW."branchId" != ra."branchId" THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: scope mismatch against the parent refund_attempt', NEW."id";
  END IF;

  -- (migration 48) the CustomerAdvance being reserved must live in EXACTLY this reservation's tenant / company /
  -- branch, and its customer account in this tenant / company. (The release<->advance pair above guarantees the
  -- advance is the one the release funded, so there is no cross-advance reservation.)
  SELECT "tenantId", "companyId", "branchId", "customerCompanyAccountId" INTO adv
    FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: referenced customerAdvanceId % does not exist', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM adv."tenantId"
     OR NEW."companyId" IS DISTINCT FROM adv."companyId"
     OR NEW."branchId" IS DISTINCT FROM adv."branchId"
  THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: scope does not match customerAdvance %', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "customer_company_account" cca
     WHERE cca."id" = adv."customerCompanyAccountId" AND cca."tenantId" = NEW."tenantId" AND cca."companyId" = NEW."companyId"
  ) THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: customerAdvance %''s customer account % is not in this tenant/company', NEW."id", NEW."customerAdvanceId", adv."customerCompanyAccountId";
  END IF;

  -- (migration 49) currency authority: the RefundAttempt and the CustomerAdvance being reserved must represent
  -- the SAME currency (the funding-release check above already binds the reservation to the release), and it
  -- must be the Company's one accounting currency.
  SELECT "currencyCode", "currencyExponent" INTO ra_cur FROM "refund_attempt" WHERE "id" = NEW."refundAttemptId";
  IF NEW."currencyCode" IS DISTINCT FROM ra_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM ra_cur."currencyExponent" THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: currency %/% does not match refund_attempt %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."refundAttemptId", ra_cur."currencyCode", ra_cur."currencyExponent";
  END IF;
  SELECT "currencyCode", "currencyExponent" INTO adv_cur FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
  IF NEW."currencyCode" IS DISTINCT FROM adv_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM adv_cur."currencyExponent" THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: currency %/% does not match customerAdvance %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."customerAdvanceId", adv_cur."currencyCode", adv_cur."currencyExponent";
  END IF;
  -- (migration 49) Company authority: the ONE accounting currency (D3b-15 — no FX, a mismatch fails safely).
  SELECT c."defaultCurrency", cur."exponent" INTO co
    FROM "company" c LEFT JOIN "currency" cur ON cur."code" = c."defaultCurrency"
   WHERE c."id" = NEW."companyId";
  IF NEW."currencyCode" IS DISTINCT FROM co."defaultCurrency" OR NEW."currencyExponent" IS DISTINCT FROM co."exponent" THEN
    RAISE EXCEPTION 'refund_attempt_entitlement_reservation %: currency %/% does not match company %''s authoritative currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."companyId", co."defaultCurrency", co."exponent";
  END IF;

  PERFORM fn_lock_and_validate_advance_capacity(NEW."customerAdvanceId", NEW."amountMinor", NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ fn_check_credit_note_coverage_release_integrity — release -> CreditNote + CustomerAdvance scope, CREDIT_NOTE advance customer attribution ═════
CREATE OR REPLACE FUNCTION fn_check_credit_note_coverage_release_integrity() RETURNS trigger AS $$
DECLARE
  adv RECORD;
  cn_invoice_id UUID;
  cn_currency_code TEXT;
  cn_currency_exponent SMALLINT;
  allocation_amount BIGINT;
  allocation_invoice_id UUID;
  allocation_currency_code TEXT;
  allocation_currency_exponent SMALLINT;
  application_amount BIGINT;
  application_currency_code TEXT;
  application_currency_exponent SMALLINT;
  recv_source_type TEXT;
  recv_invoice_id UUID;
  already_released BIGINT;
  underlying_source_type TEXT;
  underlying_source_payment_id UUID;
  underlying_advance_id UUID;
  funding_release_count INTEGER;
  funding_kind TEXT;
  funding_payment_id UUID;
  funding_is_opening BOOLEAN;
  cn_scope RECORD;
  adv_scope RECORD;
  acct RECORD;
  cn_customer_id UUID;
BEGIN
  -- FINAL INTEGRITY PROOF PASS — resolve the CreditNote and lock its Invoice
  -- FIRST, before any coverage-source lock below. This is the frozen
  -- serialization root (identical pattern/rationale to
  -- fn_check_credit_note_line_capacity's own "serialization root" lock) —
  -- acquiring it unconditionally at the top of THIS trigger too (regardless
  -- of whatever order a raw multi-statement transaction inserts
  -- credit_note_line vs credit_note_coverage_release rows in) makes the
  -- Invoice-before-source lock order a property of this trigger itself,
  -- never dependent on insertion order elsewhere.
  SELECT "invoiceId", "currencyCode", "currencyExponent"
    INTO cn_invoice_id, cn_currency_code, cn_currency_exponent
    FROM "credit_note" WHERE "id" = NEW."creditNoteId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: referenced credit_note % does not exist', NEW."id", NEW."creditNoteId";
  END IF;
  PERFORM 1 FROM "invoice" WHERE "id" = cn_invoice_id FOR UPDATE;

  -- Money-dimension exactness (§2 of the final integrity proof pass): the
  -- release's OWN currencyCode/currencyExponent — a separately-settable
  -- snapshot column, never re-derived — must match the CreditNote that owns
  -- it. Checked before any source-specific work below.
  IF NEW."currencyCode" IS DISTINCT FROM cn_currency_code OR NEW."currencyExponent" IS DISTINCT FROM cn_currency_exponent THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: currency %/% does not match credit_note %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."creditNoteId", cn_currency_code, cn_currency_exponent;
  END IF;

  SELECT "sourceType", "amountMinor", "currencyCode", "currencyExponent" INTO adv FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: referenced customer_advance % does not exist', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF adv."sourceType" != 'CREDIT_NOTE' THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: customer_advance % is not sourceType=CREDIT_NOTE', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF adv."amountMinor" != NEW."releasedAmountMinor" THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: releasedAmountMinor % != funded customer_advance %''s own amountMinor %', NEW."id", NEW."releasedAmountMinor", NEW."customerAdvanceId", adv."amountMinor";
  END IF;
  IF adv."currencyCode" IS DISTINCT FROM NEW."currencyCode" OR adv."currencyExponent" IS DISTINCT FROM NEW."currencyExponent" THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: funded customer_advance %''s currency %/% does not match this release''s own currency %/%', NEW."id", NEW."customerAdvanceId", adv."currencyCode", adv."currencyExponent", NEW."currencyCode", NEW."currencyExponent";
  END IF;

  -- (migration 49) O-2A — the release must live in EXACTLY the tenant / company / branch of BOTH authoritative
  -- parents: the CreditNote it releases coverage for and the CustomerAdvance it funds. The table has only simple
  -- single-column FKs, so nothing else could stop a release from cross-wiring unrelated scopes. Read from the
  -- parent rows themselves (never RLS visibility).
  SELECT "tenantId", "companyId", "branchId" INTO cn_scope FROM "credit_note" WHERE "id" = NEW."creditNoteId";
  IF NEW."tenantId" IS DISTINCT FROM cn_scope."tenantId"
     OR NEW."companyId" IS DISTINCT FROM cn_scope."companyId"
     OR NEW."branchId" IS DISTINCT FROM cn_scope."branchId" THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: scope does not match credit_note %', NEW."id", NEW."creditNoteId";
  END IF;
  SELECT "tenantId", "companyId", "branchId", "customerCompanyAccountId" INTO adv_scope
    FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
  IF NEW."tenantId" IS DISTINCT FROM adv_scope."tenantId"
     OR NEW."companyId" IS DISTINCT FROM adv_scope."companyId"
     OR NEW."branchId" IS DISTINCT FROM adv_scope."branchId" THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: scope does not match customer_advance %', NEW."id", NEW."customerAdvanceId";
  END IF;

  -- (migration 49) O-2B — customer attribution. A CREDIT_NOTE advance must belong to the customer entitlement of
  -- the cancelled invoice chain: credit_note -> invoice -> order.customerId (the very chain the application
  -- derives the advance's account from) must equal customer_company_account.customerId of the advance's
  -- account, and that account must live in this tenant / company. Nothing is invented or duplicated: both sides
  -- are existing columns. A walk-in order (no customer) can never fund a customer advance — the application
  -- already refuses its cancellation (WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE).
  SELECT cca."customerId", cca."tenantId", cca."companyId" INTO acct
    FROM "customer_company_account" cca WHERE cca."id" = adv_scope."customerCompanyAccountId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: customer_advance %''s customer account % does not exist', NEW."id", NEW."customerAdvanceId", adv_scope."customerCompanyAccountId";
  END IF;
  IF acct."tenantId" IS DISTINCT FROM NEW."tenantId" OR acct."companyId" IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: customer_advance %''s customer account % is not in this tenant/company', NEW."id", NEW."customerAdvanceId", adv_scope."customerCompanyAccountId";
  END IF;
  SELECT o."customerId" INTO cn_customer_id
    FROM "invoice" i JOIN "order" o ON o."id" = i."orderId" WHERE i."id" = cn_invoice_id;
  IF cn_customer_id IS NULL THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: credit_note %''s invoice has no customer (walk-in) — a CREDIT_NOTE advance can never be funded', NEW."id", NEW."creditNoteId";
  END IF;
  IF acct."customerId" IS DISTINCT FROM cn_customer_id THEN
    RAISE EXCEPTION 'credit_note_coverage_release %: customer_advance %''s customer account belongs to a different customer than credit_note %''s own invoice''s order', NEW."id", NEW."customerAdvanceId", NEW."creditNoteId";
  END IF;

  IF NEW."sourceKind" = 'PAYMENT_ALLOCATION' THEN
    -- NULL-guard first: a NULL id would otherwise fall through to the FOR
    -- UPDATE lookup below and raise a confusing "does not exist" instead of
    -- naming the actual shape violation (this row's sourceKind requires a
    -- non-NULL sourcePaymentAllocationId — the table's own
    -- credit_note_coverage_release_source_shape_chk CHECK constraint would
    -- also reject it at statement end, but only after every BEFORE INSERT
    -- trigger — including this one — has already run).
    IF NEW."sourcePaymentAllocationId" IS NULL THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: sourcePaymentAllocationId is required when sourceKind=PAYMENT_ALLOCATION', NEW."id";
    END IF;
    -- lock the source PaymentAllocation FOR UPDATE — the release-capacity
    -- serialization point for this source (the Invoice, this source's own
    -- parent, is already locked above).
    SELECT "paymentId", "amountMinor", "invoiceId", "currencyCode", "currencyExponent"
      INTO underlying_source_payment_id, allocation_amount, allocation_invoice_id, allocation_currency_code, allocation_currency_exponent
      FROM "payment_allocation" WHERE "id" = NEW."sourcePaymentAllocationId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: referenced payment_allocation % does not exist', NEW."id", NEW."sourcePaymentAllocationId";
    END IF;
    -- Source-belongs-to-this-Invoice provenance (§1 of the final integrity
    -- proof pass): scope equality (tenant/company/branch/customer) alone is
    -- NOT sufficient — a PaymentAllocation belonging to a DIFFERENT Invoice
    -- of the very same customer must never be consumable by this CreditNote.
    IF allocation_invoice_id IS DISTINCT FROM cn_invoice_id THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: payment_allocation %''s own invoiceId does not match credit_note %''s own invoiceId — scope equality alone is not sufficient', NEW."id", NEW."sourcePaymentAllocationId", NEW."creditNoteId";
    END IF;
    IF allocation_currency_code IS DISTINCT FROM NEW."currencyCode" OR allocation_currency_exponent IS DISTINCT FROM NEW."currencyExponent" THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: payment_allocation %''s currency %/% does not match this release''s own currency %/%', NEW."id", NEW."sourcePaymentAllocationId", allocation_currency_code, allocation_currency_exponent, NEW."currencyCode", NEW."currencyExponent";
    END IF;
    IF NEW."sourcePaymentId" IS DISTINCT FROM underlying_source_payment_id THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: sourcePaymentId does not match payment_allocation %''s own paymentId', NEW."id", NEW."sourcePaymentAllocationId";
    END IF;
    SELECT COALESCE(SUM("releasedAmountMinor"), 0) INTO already_released
      FROM "credit_note_coverage_release" WHERE "sourcePaymentAllocationId" = NEW."sourcePaymentAllocationId";
    IF already_released + NEW."releasedAmountMinor" > allocation_amount THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: cumulative release % exceeds payment_allocation %''s own amountMinor % (already released %)', NEW."id", already_released + NEW."releasedAmountMinor", NEW."sourcePaymentAllocationId", allocation_amount, already_released;
    END IF;

  ELSIF NEW."sourceKind" IN ('ADVANCE_APPLICATION', 'OPENING_ADVANCE') THEN
    -- Same NULL-guard rationale as the PAYMENT_ALLOCATION branch above: name
    -- the shape violation explicitly instead of letting a NULL id fall
    -- through to a "does not exist" lookup failure.
    IF NEW."sourceAdvanceApplicationId" IS NULL THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: sourceAdvanceApplicationId is required when sourceKind IN (ADVANCE_APPLICATION, OPENING_ADVANCE)', NEW."id";
    END IF;
    -- lock the source CustomerAdvanceApplication FOR UPDATE, and read its
    -- underlying CustomerAdvance's own sourceType/sourcePaymentId — the fact
    -- that distinguishes ADVANCE_APPLICATION from OPENING_ADVANCE — plus the
    -- application's OWN target CustomerReceivable's sourceType/invoiceId,
    -- resolved via the SAME join, for the provenance check below.
    SELECT caa."amountMinor", caa."currencyCode", caa."currencyExponent", caa."customerAdvanceId",
           ca."sourceType", ca."sourcePaymentId",
           recv."sourceType", recv."invoiceId"
      INTO application_amount, application_currency_code, application_currency_exponent, underlying_advance_id,
           underlying_source_type, underlying_source_payment_id,
           recv_source_type, recv_invoice_id
      FROM "customer_advance_application" caa
      JOIN "customer_advance" ca ON ca."id" = caa."customerAdvanceId"
      JOIN "customer_receivable" recv ON recv."id" = caa."customerReceivableId"
     WHERE caa."id" = NEW."sourceAdvanceApplicationId"
       FOR UPDATE OF caa;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: referenced customer_advance_application % does not exist', NEW."id", NEW."sourceAdvanceApplicationId";
    END IF;

    -- Source-belongs-to-this-Invoice provenance (§1): the application's own
    -- target CustomerReceivable must be an INVOICE-sourced receivable for
    -- EXACTLY this CreditNote's own Invoice — never another Invoice, an
    -- OPENING receivable, or a CANCELLATION_CHARGE receivable, even when
    -- tenant/company/branch/customer all happen to match.
    IF recv_source_type != 'INVOICE' OR recv_invoice_id IS DISTINCT FROM cn_invoice_id THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: customer_advance_application %''s own customer_receivable does not target credit_note %''s own invoice (receivable sourceType=%, invoiceId=%) — scope equality alone is not sufficient', NEW."id", NEW."sourceAdvanceApplicationId", NEW."creditNoteId", recv_source_type, recv_invoice_id;
    END IF;
    IF application_currency_code IS DISTINCT FROM NEW."currencyCode" OR application_currency_exponent IS DISTINCT FROM NEW."currencyExponent" THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: customer_advance_application %''s currency %/% does not match this release''s own currency %/%', NEW."id", NEW."sourceAdvanceApplicationId", application_currency_code, application_currency_exponent, NEW."currencyCode", NEW."currencyExponent";
    END IF;

    IF underlying_source_type = 'CREDIT_NOTE' THEN
      -- (migration 47) The underlying advance was itself funded by an earlier CreditNote. A
      -- CREDIT_NOTE advance has no Payment of its own: its provenance is carried by the ONE release
      -- that funded it (frozen 1:1 — UNIQUE "customerAdvanceId"). That funding release's
      -- sourceKind / sourcePaymentId were validated by THIS trigger when it was inserted and the row
      -- is immutable, so it already holds the AUTHORITATIVE ultimate provenance — a Payment, or none
      -- when the chain ends in an OPENING advance. The direct parent is validated and its provenance
      -- carried forward (no recursive walk, by induction), and nothing is accepted on trust: the
      -- inserted release must reproduce EXACTLY what the funding release carries. A missing,
      -- ambiguous or internally inconsistent funding release fails closed.
      SELECT count(*) INTO funding_release_count
        FROM "credit_note_coverage_release" f WHERE f."customerAdvanceId" = underlying_advance_id;
      IF funding_release_count != 1 THEN
        RAISE EXCEPTION 'credit_note_coverage_release %: underlying CREDIT_NOTE customer_advance % has % funding credit_note_coverage_release rows (expected exactly 1) — its provenance cannot be derived', NEW."id", underlying_advance_id, funding_release_count;
      END IF;
      SELECT f."sourceKind", f."sourcePaymentId" INTO funding_kind, funding_payment_id
        FROM "credit_note_coverage_release" f WHERE f."customerAdvanceId" = underlying_advance_id;
      IF funding_kind = 'OPENING_ADVANCE' THEN
        IF funding_payment_id IS NOT NULL THEN
          RAISE EXCEPTION 'credit_note_coverage_release %: the funding release of underlying CREDIT_NOTE customer_advance % is inconsistent (OPENING_ADVANCE with a sourcePaymentId)', NEW."id", underlying_advance_id;
        END IF;
        funding_is_opening := true;
      ELSIF funding_kind IN ('PAYMENT_ALLOCATION', 'ADVANCE_APPLICATION') THEN
        IF funding_payment_id IS NULL THEN
          RAISE EXCEPTION 'credit_note_coverage_release %: the funding release of underlying CREDIT_NOTE customer_advance % is inconsistent (% without a sourcePaymentId)', NEW."id", underlying_advance_id, funding_kind;
        END IF;
        funding_is_opening := false;
      ELSE
        RAISE EXCEPTION 'credit_note_coverage_release %: the funding release of underlying CREDIT_NOTE customer_advance % has an unrecognized sourceKind (%)', NEW."id", underlying_advance_id, funding_kind;
      END IF;

      IF NEW."sourceKind" = 'ADVANCE_APPLICATION' THEN
        IF funding_is_opening THEN
          RAISE EXCEPTION 'credit_note_coverage_release %: sourceKind=ADVANCE_APPLICATION requires a Payment-traced provenance, but the underlying CREDIT_NOTE customer_advance % was ultimately funded from an OPENING advance (use OPENING_ADVANCE)', NEW."id", underlying_advance_id;
        END IF;
        IF NEW."sourcePaymentId" IS DISTINCT FROM funding_payment_id THEN
          RAISE EXCEPTION 'credit_note_coverage_release %: sourcePaymentId does not match the ultimate Payment provenance carried by the funding release of the underlying CREDIT_NOTE customer_advance', NEW."id";
        END IF;
      ELSE -- OPENING_ADVANCE
        IF NOT funding_is_opening THEN
          RAISE EXCEPTION 'credit_note_coverage_release %: sourceKind=OPENING_ADVANCE requires the underlying CREDIT_NOTE customer_advance % to be ultimately funded from an OPENING advance (it is Payment-traced)', NEW."id", underlying_advance_id;
        END IF;
        IF NEW."sourcePaymentId" IS NOT NULL THEN
          RAISE EXCEPTION 'credit_note_coverage_release %: sourcePaymentId must be NULL — the underlying CREDIT_NOTE customer_advance is ultimately OPENING-funded', NEW."id";
        END IF;
      END IF;
    ELSIF NEW."sourceKind" = 'ADVANCE_APPLICATION' THEN
      IF underlying_source_type != 'PAYMENT' THEN
        RAISE EXCEPTION 'credit_note_coverage_release %: sourceKind=ADVANCE_APPLICATION requires the underlying customer_advance to be sourceType=PAYMENT (got %)', NEW."id", underlying_source_type;
      END IF;
      IF NEW."sourcePaymentId" IS DISTINCT FROM underlying_source_payment_id THEN
        RAISE EXCEPTION 'credit_note_coverage_release %: sourcePaymentId does not match the underlying PAYMENT-sourced customer_advance''s own sourcePaymentId', NEW."id";
      END IF;
    ELSE -- OPENING_ADVANCE
      IF underlying_source_type != 'OPENING' THEN
        RAISE EXCEPTION 'credit_note_coverage_release %: sourceKind=OPENING_ADVANCE requires the underlying customer_advance to be sourceType=OPENING (got %)', NEW."id", underlying_source_type;
      END IF;
      IF NEW."sourcePaymentId" IS NOT NULL THEN
        RAISE EXCEPTION 'credit_note_coverage_release %: sourcePaymentId must be NULL — underlying customer_advance is OPENING-sourced', NEW."id";
      END IF;
    END IF;

    SELECT COALESCE(SUM("releasedAmountMinor"), 0) INTO already_released
      FROM "credit_note_coverage_release" WHERE "sourceAdvanceApplicationId" = NEW."sourceAdvanceApplicationId";
    IF already_released + NEW."releasedAmountMinor" > application_amount THEN
      RAISE EXCEPTION 'credit_note_coverage_release %: cumulative release % exceeds customer_advance_application %''s own amountMinor % (already released %)', NEW."id", already_released + NEW."releasedAmountMinor", NEW."sourceAdvanceApplicationId", application_amount, already_released;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ fn_check_credit_note_invoice_capacity — credit note -> Invoice + Company currency ═════
CREATE OR REPLACE FUNCTION fn_check_credit_note_invoice_capacity() RETURNS trigger AS $$
DECLARE
  cn RECORD;
  invoice_total BIGINT;
  cumulative_total BIGINT;
  inv RECORD;
  co RECORD;
BEGIN
  SELECT * INTO cn FROM "credit_note" WHERE "id" = NEW."id";
  -- (migration 49) currency authority: a CreditNote is denominated in EXACTLY its Invoice's currency, which is
  -- the Company's one accounting currency (D3b-15 — no FX).
  SELECT "currencyCode", "currencyExponent" INTO inv FROM "invoice" WHERE "id" = cn."invoiceId";
  IF cn."currencyCode" IS DISTINCT FROM inv."currencyCode" OR cn."currencyExponent" IS DISTINCT FROM inv."currencyExponent" THEN
    RAISE EXCEPTION 'credit_note %: currency %/% does not match invoice %''s own currency %/%', NEW."id", cn."currencyCode", cn."currencyExponent", cn."invoiceId", inv."currencyCode", inv."currencyExponent";
  END IF;
  -- (migration 49) Company authority: the ONE accounting currency (D3b-15 — no FX, a mismatch fails safely).
  SELECT c."defaultCurrency", cur."exponent" INTO co
    FROM "company" c LEFT JOIN "currency" cur ON cur."code" = c."defaultCurrency"
   WHERE c."id" = NEW."companyId";
  IF cn."currencyCode" IS DISTINCT FROM co."defaultCurrency" OR cn."currencyExponent" IS DISTINCT FROM co."exponent" THEN
    RAISE EXCEPTION 'credit_note %: currency %/% does not match company %''s authoritative currency %/%', NEW."id", cn."currencyCode", cn."currencyExponent", NEW."companyId", co."defaultCurrency", co."exponent";
  END IF;

  SELECT "totalAmountMinor" INTO invoice_total FROM "invoice" WHERE "id" = cn."invoiceId";
  SELECT COALESCE(SUM("totalAmountMinor"), 0) INTO cumulative_total
    FROM "credit_note" WHERE "invoiceId" = cn."invoiceId";
  IF cumulative_total > invoice_total THEN
    RAISE EXCEPTION 'credit_note %: cumulative CreditNote total % exceeds invoice % own total %', NEW."id", cumulative_total, cn."invoiceId", invoice_total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ fn_check_credit_note_line_capacity — credit note line -> CreditNote currency ═════
CREATE OR REPLACE FUNCTION fn_check_credit_note_line_capacity() RETURNS trigger AS $$
DECLARE
  v_invoice_id UUID;
  ol RECORD;
  v_gross BIGINT;
  v_line_discount BIGINT;
  v_tax BIGINT;
  v_doc_share BIGINT;
  v_net_after_doc BIGINT;
  v_line_total BIGINT;
  v_prior_qty NUMERIC;
  v_prior_gross BIGINT;
  v_prior_discount BIGINT;
  v_prior_doc_share BIGINT;
  v_prior_net BIGINT;
  v_prior_tax BIGINT;
  v_prior_total BIGINT;
  v_cn_cur RECORD;
BEGIN
  SELECT cn."invoiceId" INTO v_invoice_id FROM "credit_note" cn WHERE cn."id" = NEW."creditNoteId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_line %: referenced credit_note % does not exist', NEW."id", NEW."creditNoteId";
  END IF;
  -- (migration 49) currency authority: a line is denominated in EXACTLY its CreditNote's currency.
  SELECT "currencyCode", "currencyExponent" INTO v_cn_cur FROM "credit_note" WHERE "id" = NEW."creditNoteId";
  IF NEW."currencyCode" IS DISTINCT FROM v_cn_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM v_cn_cur."currencyExponent" THEN
    RAISE EXCEPTION 'credit_note_line %: currency %/% does not match credit_note %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."creditNoteId", v_cn_cur."currencyCode", v_cn_cur."currencyExponent";
  END IF;

  -- serialization root — locked and held until this transaction commits.
  PERFORM 1 FROM "invoice" WHERE "id" = v_invoice_id FOR UPDATE;

  SELECT ol2."id", ol2."quantity", ol2."unitPriceAmountMinor", ol2."discountAmountMinor",
         ol2."lineTaxAmountMinor", ol2."linePosition", ol2."orderId" AS order_line_order_id,
         o."documentDiscountAmountMinor" AS doc_discount, o."taxPriceMode" AS tax_price_mode
    INTO ol
    FROM "order_line" ol2
    JOIN "order" o ON o."id" = ol2."orderId"
   WHERE ol2."id" = NEW."orderLineId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_line %: referenced order_line % does not exist', NEW."id", NEW."orderLineId";
  END IF;

  -- provenance: the order_line's own Order must equal the credit note's own
  -- Invoice's Order — cross-tenant/company/branch provenance fails here too
  -- (a cross-scope orderLineId can never satisfy this join at all).
  PERFORM 1 FROM "invoice" WHERE "id" = v_invoice_id AND "orderId" = ol.order_line_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_line %: order_line % does not belong to the credit note''s own invoice''s order', NEW."id", NEW."orderLineId";
  END IF;

  v_gross := ROUND(ol."unitPriceAmountMinor" * ol."quantity", 0)::bigint;
  v_line_discount := ol."discountAmountMinor";
  v_tax := ol."lineTaxAmountMinor";

  -- document-discount share — exact Money.allocate replica (floor base +
  -- largest-remainder-first, tie-break linePosition ASC) over every sibling
  -- order_line of the SAME order.
  WITH siblings AS (
    SELECT ol3."id",
           (ROUND(ol3."unitPriceAmountMinor" * ol3."quantity", 0)::bigint - ol3."discountAmountMinor") AS weight,
           ol3."linePosition"
      FROM "order_line" ol3 WHERE ol3."orderId" = ol.order_line_order_id
  ),
  totals AS (SELECT COALESCE(SUM(weight), 0) AS total_weight FROM siblings),
  shares AS (
    SELECT s."id", s."linePosition",
           CASE WHEN t.total_weight = 0 THEN 0 ELSE (s.weight * ol.doc_discount) / t.total_weight END AS base_share,
           CASE WHEN t.total_weight = 0 THEN 0 ELSE (s.weight * ol.doc_discount) % t.total_weight END AS remainder
      FROM siblings s CROSS JOIN totals t
  ),
  base_sum_cte AS (SELECT COALESCE(SUM(base_share), 0) AS base_sum FROM shares),
  ranked AS (
    SELECT sh.*, ROW_NUMBER() OVER (ORDER BY sh.remainder DESC, sh."linePosition" ASC) AS rnk
      FROM shares sh
  )
  SELECT r.base_share + CASE WHEN r.rnk <= (ol.doc_discount - bs.base_sum) THEN 1 ELSE 0 END
    INTO v_doc_share
    FROM ranked r CROSS JOIN base_sum_cte bs
   WHERE r."id" = ol."id";
  v_doc_share := COALESCE(v_doc_share, 0);

  v_net_after_doc := v_gross - v_line_discount - v_doc_share;
  IF ol.tax_price_mode = 'TAX_EXCLUSIVE' THEN
    v_line_total := v_net_after_doc + v_tax;
  ELSE
    v_line_total := v_net_after_doc;
  END IF;

  -- internal consistency of the NEW row (cheap, catches real corruption;
  -- never re-derives HOW the discount/tax split within the ceiling was
  -- chosen — that is the ceiling's job, checked below).
  IF (ol.tax_price_mode = 'TAX_EXCLUSIVE' AND NEW."lineTotalCreditedMinor" != NEW."netAfterDocumentDiscountCreditedMinor" + NEW."taxCreditedMinor")
     OR (ol.tax_price_mode = 'TAX_INCLUSIVE' AND NEW."lineTotalCreditedMinor" != NEW."netAfterDocumentDiscountCreditedMinor") THEN
    RAISE EXCEPTION 'credit_note_line %: lineTotalCreditedMinor inconsistent with order_line %''s own frozen taxPriceMode %', NEW."id", NEW."orderLineId", ol.tax_price_mode;
  END IF;

  -- cumulative prior credited components for this orderLineId.
  SELECT COALESCE(SUM("quantityCredited"), 0), COALESCE(SUM("grossCreditedMinor"), 0),
         COALESCE(SUM("discountCreditedMinor"), 0), COALESCE(SUM("documentDiscountShareCreditedMinor"), 0),
         COALESCE(SUM("netAfterDocumentDiscountCreditedMinor"), 0), COALESCE(SUM("taxCreditedMinor"), 0),
         COALESCE(SUM("lineTotalCreditedMinor"), 0)
    INTO v_prior_qty, v_prior_gross, v_prior_discount, v_prior_doc_share, v_prior_net, v_prior_tax, v_prior_total
    FROM "credit_note_line" WHERE "orderLineId" = NEW."orderLineId";

  IF v_prior_qty + NEW."quantityCredited" > ol."quantity" THEN
    RAISE EXCEPTION 'credit_note_line %: cumulative quantityCredited exceeds order_line %''s own quantity', NEW."id", NEW."orderLineId";
  END IF;
  IF v_prior_gross + NEW."grossCreditedMinor" > v_gross THEN
    RAISE EXCEPTION 'credit_note_line %: cumulative grossCreditedMinor exceeds original gross for order_line %', NEW."id", NEW."orderLineId";
  END IF;
  IF v_prior_discount + NEW."discountCreditedMinor" > v_line_discount THEN
    RAISE EXCEPTION 'credit_note_line %: cumulative discountCreditedMinor exceeds order_line %''s own frozen line discount', NEW."id", NEW."orderLineId";
  END IF;
  IF v_prior_doc_share + NEW."documentDiscountShareCreditedMinor" > v_doc_share THEN
    RAISE EXCEPTION 'credit_note_line %: cumulative documentDiscountShareCreditedMinor exceeds the deterministic original document-discount share for order_line %', NEW."id", NEW."orderLineId";
  END IF;
  IF v_prior_net + NEW."netAfterDocumentDiscountCreditedMinor" > v_net_after_doc THEN
    RAISE EXCEPTION 'credit_note_line %: cumulative netAfterDocumentDiscountCreditedMinor exceeds the original commercial amount for order_line %', NEW."id", NEW."orderLineId";
  END IF;
  IF v_prior_tax + NEW."taxCreditedMinor" > v_tax THEN
    RAISE EXCEPTION 'credit_note_line %: cumulative taxCreditedMinor exceeds order_line %''s own frozen lineTaxAmountMinor', NEW."id", NEW."orderLineId";
  END IF;
  IF v_prior_total + NEW."lineTotalCreditedMinor" > v_line_total THEN
    RAISE EXCEPTION 'credit_note_line %: cumulative lineTotalCreditedMinor exceeds the original frozen line total for order_line %', NEW."id", NEW."orderLineId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ fn_check_cancellation_charge_provenance — cancellation charge -> Order + Company currency ═════
CREATE OR REPLACE FUNCTION fn_check_cancellation_charge_provenance() RETURNS trigger AS $$
DECLARE
  ord RECORD;
  ord_cur RECORD;
  co RECORD;
BEGIN
  SELECT "originBranchId" INTO ord FROM "order" WHERE "id" = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cancellation_charge %: referenced order % does not exist', NEW."id", NEW."orderId";
  END IF;
  IF NEW."branchId" IS DISTINCT FROM ord."originBranchId" THEN
    RAISE EXCEPTION 'cancellation_charge %: branchId must equal order %''s originBranchId', NEW."id", NEW."orderId";
  END IF;
  -- (migration 49) currency authority: a CancellationCharge is denominated in EXACTLY its Order's currency,
  -- which is the Company's one accounting currency (D3b-15 — no FX).
  SELECT "currencyCode", "currencyExponent" INTO ord_cur FROM "order" WHERE "id" = NEW."orderId";
  IF NEW."currencyCode" IS DISTINCT FROM ord_cur."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM ord_cur."currencyExponent" THEN
    RAISE EXCEPTION 'cancellation_charge %: currency %/% does not match order %''s own currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."orderId", ord_cur."currencyCode", ord_cur."currencyExponent";
  END IF;
  -- (migration 49) Company authority: the ONE accounting currency (D3b-15 — no FX, a mismatch fails safely).
  SELECT c."defaultCurrency", cur."exponent" INTO co
    FROM "company" c LEFT JOIN "currency" cur ON cur."code" = c."defaultCurrency"
   WHERE c."id" = NEW."companyId";
  IF NEW."currencyCode" IS DISTINCT FROM co."defaultCurrency" OR NEW."currencyExponent" IS DISTINCT FROM co."exponent" THEN
    RAISE EXCEPTION 'cancellation_charge %: currency %/% does not match company %''s authoritative currency %/%', NEW."id", NEW."currencyCode", NEW."currencyExponent", NEW."companyId", co."defaultCurrency", co."exponent";
  END IF;

  IF NEW."invoiceId" IS NOT NULL THEN
    PERFORM 1 FROM "invoice" WHERE "id" = NEW."invoiceId" AND "orderId" = NEW."orderId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cancellation_charge %: invoiceId % does not belong to orderId %', NEW."id", NEW."invoiceId", NEW."orderId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
