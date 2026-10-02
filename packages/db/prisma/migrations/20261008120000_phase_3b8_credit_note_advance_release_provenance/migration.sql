-- Phase 3b task 3b.8 F3 — CREDIT_NOTE-sourced advance coverage release provenance.
--
-- Cancelling an invoice whose coverage includes a CustomerAdvanceApplication of a CREDIT_NOTE-sourced
-- CustomerAdvance (value an earlier cancellation released) must release that coverage AGAIN into a new
-- CREDIT_NOTE advance, conserving the customer's entitlement exactly. The frozen shape of
-- "credit_note_coverage_release" — its columns and "credit_note_coverage_release_source_shape_chk" —
-- already represents it: sourceKind ADVANCE_APPLICATION with the ULTIMATE sourcePaymentId, or
-- OPENING_ADVANCE with NULL. Only the BEFORE INSERT trigger BODY refused it (it hard-required a
-- PAYMENT-sourced / OPENING-sourced underlying advance), so even a correct, fully traced release was
-- rejected and the cancellation failed (a 500, fully rolled back).
--
-- EXACT CONTENTS (nothing else): ONE function replaced (CREATE OR REPLACE — SAME signature, SAME trigger
-- binding "trg_check_credit_note_coverage_release_integrity"):
--     fn_check_credit_note_coverage_release_integrity()
-- NO new table / column / index / CHECK / release kind / provenance column / money field / policy /
-- grant; NO row is rewritten; NO edit to any prior migration file (same technique as migrations 44/46).
--
-- THE ONE RULE ADDED. When the source application's underlying advance has sourceType='CREDIT_NOTE', the
-- ultimate provenance is DERIVED, only, from the ONE release that funded that advance (frozen 1:1,
-- UNIQUE "customerAdvanceId"). That funding release was validated by this same trigger when it was
-- inserted and is immutable, so it already carries the authoritative ultimate source: a Payment, or none
-- when the chain ends in an OPENING advance. The new release must reproduce it EXACTLY:
--   - ADVANCE_APPLICATION  -> "sourcePaymentId" must equal the funding release's "sourcePaymentId"
--                             (NULL fails; a wrong or invented Payment id fails; an opening-backed chain fails);
--   - OPENING_ADVANCE      -> the funding release must itself be OPENING_ADVANCE and "sourcePaymentId" NULL
--                             (a payment-backed chain fails).
-- Only the DIRECT parent funding release is read (no recursive search; nested chains work by induction:
-- every release carries the ultimate provenance forward). A missing, ambiguous or internally inconsistent
-- funding release fails closed. Nothing is accepted from the request on trust.
--
-- EVERYTHING ELSE IS PRESERVED VERBATIM — every earlier check of the function, the PAYMENT_ALLOCATION
-- branch, and the ADVANCE_APPLICATION / OPENING_ADVANCE rules (and their exact error messages) for
-- PAYMENT-sourced and OPENING-sourced underlying advances, plus the cumulative-release cap.

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
