-- Phase 3b task 3b.8 HARD-GATE DB INTEGRITY CLOSURE — provider_refund_event guards + refund-side scope
-- integrity (defects D-B1 … D-B4 of the adversarial hard gate, owner decision "APPROVE MIGRATION 48").
--
-- The hard gate proved that the refund side of the 3b.8 schema relies on the application layer where the
-- database itself accepts a raw INSERT / DELETE:
--   D-B1  provider_refund_event could be DELETEd (its (credential, event id) dedup identity is not permanent),
--   D-B2  provider_refund_event could be INSERTed already terminal (PROCESSED / EXCEPTION), skipping RECEIVED,
--   D-B3  provider_refund_event was never checked against its credential's tenant / company / branch,
--   D-B4  refund / customer_advance_refund_application / refund_attempt /
--         refund_attempt_entitlement_reservation rows were never checked against the Payment / CustomerAdvance
--         they point at — all of their foreign keys are simple single-column ones, so a refund of a branch-A
--         Payment could be stamped with another branch, company (or tenant), and an application could consume
--         an advance of another scope.
-- provider_payment_event already has the equivalent four protections (credential scope, initial status,
-- transition, no delete); this migration gives provider_refund_event the missing three, and closes the
-- scope / provenance links of the refund chain, in the same style.
--
-- EXACT CONTENTS (nothing else — no table, column, index, CHECK, FK, UNIQUE, policy, grant, RLS flag, view,
-- enum value, money field, route, permission, provider contract or data change; NO edit to any prior
-- migration file; NO row is rewritten):
--   3 functions CREATED   fn_check_provider_refund_event_credential_scope()
--                         fn_enforce_provider_refund_event_initial_status()
--                         fn_enforce_provider_refund_event_no_delete()
--   3 triggers CREATED    trg_check_provider_refund_event_credential_scope   BEFORE INSERT
--                         trg_enforce_provider_refund_event_initial_status   BEFORE INSERT
--                         trg_enforce_provider_refund_event_no_delete        BEFORE DELETE
--                         (all on "provider_refund_event"; the existing BEFORE UPDATE transition trigger is untouched)
--   4 functions REPLACED  (CREATE OR REPLACE — SAME signature, SAME trigger bindings, so no trigger is touched)
--                         fn_check_refund_scope_and_capacity()                   (refund            BEFORE INSERT)
--                         fn_check_refund_attempt_scope_and_capacity()           (refund_attempt    BEFORE INSERT)
--                         fn_check_customer_advance_refund_application_integrity()
--                                                                                (customer_advance_refund_application BEFORE INSERT)
--                         fn_check_refund_attempt_reservation_integrity()        (refund_attempt_entitlement_reservation BEFORE INSERT)
--
-- THE RULES ADDED
--   provider_refund_event
--     - DELETE is never permitted, in any status (the dedup identity and the audit trail are permanent);
--     - an INSERT must start at RECEIVED (RECEIVED -> PROCESSED | EXCEPTION stays possible through the existing
--       transition trigger, which also still freezes a terminal status);
--     - the referenced credential must exist, be branch-scoped (companyId AND branchId NOT NULL) and carry
--       EXACTLY the event's own tenant / company / branch. The check reads the trusted credential row itself —
--       it does not rely on RLS visibility.
--   refund                                  — the source Payment must exist and share the refund's tenant / company / branch.
--   refund_attempt                          — the source Payment must exist and share the attempt's tenant / company / branch
--                                             (the credential rules already in the function are unchanged).
--   customer_advance_refund_application     — the CustomerAdvance must exist and share the application's tenant / company /
--                                             branch (the Refund side was already checked); its customer ACCOUNT must live in
--                                             the same tenant / company; and the advance must trace to the refund's source
--                                             Payment: a CREDIT_NOTE advance through its ONE funding release, a PAYMENT advance
--                                             through its own sourcePaymentId. An advance with no Payment provenance (OPENING,
--                                             or an opening-ended credit-note chain) can never fund a Refund — the schema's own
--                                             frozen rule, previously enforced by the application only. This is the same
--                                             provenance equality the RefundAttempt reservation trigger already enforces.
--   refund_attempt_entitlement_reservation  — the CustomerAdvance must share the reservation's tenant / company / branch and its
--                                             customer account must live in the same tenant / company (the attempt-scope,
--                                             release<->advance pair, release-provenance and currency checks are unchanged).
--
-- WHAT IS PRESERVED VERBATIM: every existing check and RAISE EXCEPTION message of the four replaced functions
-- (the ONE pre-existing line that is edited is the application function's refund SELECT, which now also reads
-- "sourcePaymentId" — needed for the provenance rule), the capacity functions and the order in which they are
-- called, and every immutability / transition trigger.
-- LOCK ORDER IS UNCHANGED: every added read is a plain SELECT (no FOR UPDATE / FOR SHARE), taken before the
-- existing capacity function that locks payment / advance, so no lock hierarchy (ORDER -> INVOICE -> ...) moves.
-- Plain reads of immutable rows are safe: payment, customer_advance, credit_note_coverage_release and
-- provider_credential identity/scope columns are never updated.

-- ══════════════════════ provider_refund_event — D-B3 credential scope ═════════════════════════════════
-- Mirrors fn_check_provider_payment_event_credential_scope (payments_core): every row in this table is
-- inherently a REFUND provider event, so the credential must be branch-scoped and mirror the event exactly.
CREATE FUNCTION fn_check_provider_refund_event_credential_scope() RETURNS trigger AS $$
DECLARE
  cred RECORD;
BEGIN
  SELECT "tenantId", "companyId", "branchId" INTO cred
    FROM "provider_credential" WHERE "id" = NEW."providerCredentialId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider_refund_event %: referenced providerCredentialId % does not exist', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS NULL OR cred."branchId" IS NULL THEN
    RAISE EXCEPTION 'provider_refund_event %: providerCredentialId % must be branch-scoped for refunds (companyId and branchId both required)', NEW."id", NEW."providerCredentialId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM cred."tenantId"
     OR NEW."companyId" IS DISTINCT FROM cred."companyId"
     OR NEW."branchId" IS DISTINCT FROM cred."branchId"
  THEN
    RAISE EXCEPTION 'provider_refund_event %: scope does not match providerCredentialId %''s own scope', NEW."id", NEW."providerCredentialId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_provider_refund_event_credential_scope
  BEFORE INSERT ON "provider_refund_event"
  FOR EACH ROW EXECUTE FUNCTION fn_check_provider_refund_event_credential_scope();

-- ══════════════════════ provider_refund_event — D-B2 initial status ═══════════════════════════════════
-- Mirrors fn_enforce_provider_payment_event_initial_status: INSERT must start at RECEIVED.
CREATE FUNCTION fn_enforce_provider_refund_event_initial_status() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'RECEIVED' THEN
    RAISE EXCEPTION 'provider_refund_event %: initial status must be RECEIVED (got %)', NEW."id", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_provider_refund_event_initial_status
  BEFORE INSERT ON "provider_refund_event"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_provider_refund_event_initial_status();

-- ══════════════════════ provider_refund_event — D-B1 never deleted ════════════════════════════════════
-- Mirrors fn_enforce_provider_payment_event_no_delete.
CREATE FUNCTION fn_enforce_provider_refund_event_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'provider_refund_event %: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_provider_refund_event_no_delete
  BEFORE DELETE ON "provider_refund_event"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_provider_refund_event_no_delete();

-- ══════════════════════ refund -> source Payment (D-B4) ═══════════════════════════════════════════════
-- The pre-existing body is reproduced verbatim; the source-Payment scope check is the only addition.
CREATE OR REPLACE FUNCTION fn_check_refund_scope_and_capacity() RETURNS trigger AS $$
DECLARE
  ra RECORD;
  pay RECORD;
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

  -- §1/§3 conversion-safe capacity: exclude the converting attempt's own
  -- PENDING reservation (still PENDING at this exact instant — its state
  -- flips to SUCCEEDED only AFTER this Refund row exists) so the SAME
  -- economic amount is never counted twice.
  PERFORM fn_lock_and_validate_payment_refund_capacity(NEW."sourcePaymentId", NEW."amountMinor", NEW."sourceRefundAttemptId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ refund_attempt -> source Payment / provider credential (D-B4) ═════════════════
-- The pre-existing credential checks are reproduced verbatim; the source-Payment scope check is the only
-- addition (placed after the credential checks and before the capacity lock).
CREATE OR REPLACE FUNCTION fn_check_refund_attempt_scope_and_capacity() RETURNS trigger AS $$
DECLARE
  cred RECORD;
  pay RECORD;
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

  PERFORM fn_lock_and_validate_payment_refund_capacity(NEW."sourcePaymentId", NEW."requestedAmountMinor", NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ customer_advance_refund_application -> Refund + CustomerAdvance (D-B4) ════════
-- The Refund-side checks are reproduced verbatim (the Refund row now also supplies its sourcePaymentId); the
-- CustomerAdvance-side scope, customer-account and Payment-provenance checks are the additions. They run
-- before the capacity function, so the existing capacity / conversion-safe exclusion semantics are untouched.
CREATE OR REPLACE FUNCTION fn_check_customer_advance_refund_application_integrity() RETURNS trigger AS $$
DECLARE
  rf RECORD;
  adv RECORD;
  provenance_payment_id UUID;
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

-- ══════════════════════ refund_attempt_entitlement_reservation -> RefundAttempt + CustomerAdvance (D-B4) ═
-- Every pre-existing check is reproduced verbatim; the advance-scope and customer-account checks are the
-- additions (placed after the attempt-scope check and before the capacity lock).
CREATE OR REPLACE FUNCTION fn_check_refund_attempt_reservation_integrity() RETURNS trigger AS $$
DECLARE
  ra RECORD;
  rel RECORD;
  adv RECORD;
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

  PERFORM fn_lock_and_validate_advance_capacity(NEW."customerAdvanceId", NEW."amountMinor", NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
