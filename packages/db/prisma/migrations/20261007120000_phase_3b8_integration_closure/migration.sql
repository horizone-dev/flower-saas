-- Phase 3b task 3b.8 INTEGRATION CLOSURE — DB backstops + closed vocabulary for
-- the 3b.8 financial artifacts (a CANCELLATION_CHARGE-sourced CustomerReceivable
-- and a CreditNote's invoice AR reduction).
--
-- Post-Checkpoint-C/D inspection found three frozen-3b.6 backstop FUNCTIONS that
-- predate those artifacts and silently mishandle them, plus a chronology
-- vocabulary with no truthful kind for "a Payment applied to a CancellationCharge
-- receivable". This migration is purely corrective and additive. EXACT CONTENTS
-- (nothing else):
--   functions replaced (CREATE OR REPLACE — SAME signatures, SAME trigger bindings):
--     fn_lock_and_validate_opening_receivable_coverage(uuid, bigint)
--     fn_check_customer_receivable_payment_application_integrity()
--     fn_lock_and_validate_invoice_coverage(uuid, bigint)
--     fn_check_customer_account_entry_source_type()
--   CHECK constraints replaced (DROP + ADD — vocabulary widened by exactly ONE kind):
--     customer_account_entry_kind_chk
--     customer_account_entry_reference_xor_chk
-- NO new table, NO new column, NO new money field, NO schema/Prisma-model change,
-- NO row is rewritten (historical OPENING_RECEIVABLE_PAYMENT_APPLIED rows are
-- untouched), NO edit to any prior migration file (same technique as
-- `20260930120000_receivables_opening_receivable_payment_application`,
-- `20261001120000_receivables_advance_application_branch_backstop` and migration 44).
--
-- (1) `fn_lock_and_validate_opening_receivable_coverage` read its principal from
--     `customer_receivable.openingAmountMinor` — which a CANCELLATION_CHARGE
--     receivable never has (the 3b.8 source-shape CHECK forces it NULL; the
--     principal is `cancellation_charge.totalAmountMinor`). `covered + proposed >
--     NULL` is NULL, never true, so an advance application over a charge
--     receivable had NO DB capacity backstop at all. It now resolves the principal
--     BY SOURCE TYPE and raises for anything it cannot resolve (never a NULL
--     comparison). The OPENING message text is preserved verbatim.
--
-- (2) `fn_check_customer_receivable_payment_application_integrity` rejected every
--     target that was not OPENING-sourced, so a customer receipt could never settle
--     a CANCELLATION_CHARGE receivable even though it is an ordinary AR receivable
--     (owner ruling: a charge receivable must be collectible by normal receipt
--     collection AND by CustomerAdvance application, with NO special "charge
--     payment" subsystem). The non-invoice payment-application target is therefore
--     generalized to OPENING and CANCELLATION_CHARGE — and ONLY those: an
--     INVOICE-sourced target is still unconditionally rejected (that path is
--     PaymentAllocation's alone), and the rejection message keeps the substring
--     "is not OPENING-sourced". Every other check (scope, account, currency,
--     Payment provenance/customer attribution, capacity, lock order: coverage
--     anchor BEFORE Payment) is reproduced verbatim; the currency/exponent
--     comparison now reads the charge's OWN currency for a charge receivable (a
--     charge receivable's `customer_receivable.currencyCode` is NULL by CHECK).
--
-- (3) `fn_lock_and_validate_invoice_coverage` ignored a CreditNote's
--     `arReductionMinor`: a fully AR-reversed (cancelled) invoice still accepted
--     new PaymentAllocation / CustomerAdvanceApplication rows up to its NOMINAL
--     total. A CreditNote reverses the still-unpaid remainder ("it was never
--     money", ADR-0019 §19) while the already-PAID portion stays represented by its
--     immutable allocation/application rows (released into a CREDIT_NOTE advance),
--     so `Σ allocations + Σ advance applications + Σ credit_note.arReductionMinor`
--     can never legitimately exceed `invoice.totalAmountMinor` — exactly the same
--     canonical formula the application layer now uses
--     (`receivables/receivable-balance.ts`). One new SUM term; the coverage-anchor
--     lock (`invoice ... FOR UPDATE`) is unchanged, so lock order is unchanged.
--     The `coverage would exceed totalAmountMinor` message prefix is preserved.

-- (4) `CANCELLATION_CHARGE_PAYMENT_APPLIED` — a NEW, semantically correct
--     chronology kind for a Payment applied to a CANCELLATION_CHARGE receivable
--     (owner ruling: the legacy `OPENING_RECEIVABLE_PAYMENT_APPLIED` is FROZEN for
--     opening-receivable payment history and must never record a charge payment).
--     Additive: the closed kind vocabulary gains exactly this one value; it shares
--     that legacy kind's sole reference column
--     (`customerReceivablePaymentApplicationId`) under the same exactly-one-reference
--     rule; and `fn_check_customer_account_entry_source_type` (every other branch
--     reproduced verbatim from migration 44) gains ONE branch that structurally
--     keeps the two kinds apart — each may only reference a payment application whose
--     own target receivable has the matching sourceType (OPENING vs
--     CANCELLATION_CHARGE). A NULL reference is left to the exactly-one-reference
--     CHECK to report. Existing rows stay valid under the stricter backstop by
--     construction: before this migration a payment application could only ever
--     target an OPENING receivable (trigger-enforced), so every pre-existing
--     OPENING_RECEIVABLE_PAYMENT_APPLIED entry already satisfies it.

-- ══════════════ (1) non-invoice receivable coverage: principal by source type ═══
CREATE OR REPLACE FUNCTION fn_lock_and_validate_opening_receivable_coverage(p_receivable_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  recv_source_type TEXT;
  recv_charge_id UUID;
  opening_amount BIGINT;
  principal BIGINT;
  covered BIGINT;
BEGIN
  SELECT "sourceType", "cancellationChargeId", "openingAmountMinor"
    INTO recv_source_type, recv_charge_id, opening_amount
    FROM "customer_receivable" WHERE "id" = p_receivable_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable %: does not exist', p_receivable_id;
  END IF;

  IF recv_source_type = 'OPENING' THEN
    principal := opening_amount;
  ELSIF recv_source_type = 'CANCELLATION_CHARGE' THEN
    SELECT "totalAmountMinor" INTO principal FROM "cancellation_charge" WHERE "id" = recv_charge_id;
  ELSE
    RAISE EXCEPTION 'customer_receivable %: non-invoice coverage cannot be validated for sourceType % (INVOICE coverage is validated through the invoice)', p_receivable_id, recv_source_type;
  END IF;
  IF principal IS NULL THEN
    RAISE EXCEPTION 'customer_receivable %: (%) has no resolvable principal — coverage cannot be validated', p_receivable_id, recv_source_type;
  END IF;

  SELECT COALESCE(SUM("amountMinor"), 0) INTO covered FROM "customer_advance_application" WHERE "customerReceivableId" = p_receivable_id;
  covered := covered + COALESCE((SELECT SUM("amountMinor") FROM "customer_receivable_payment_application" WHERE "customerReceivableId" = p_receivable_id), 0);
  IF covered + p_proposed_amount > principal THEN
    IF recv_source_type = 'OPENING' THEN
      RAISE EXCEPTION 'customer_receivable %: (OPENING) coverage would exceed openingAmountMinor (principal=%, already covered=%, proposed=%)', p_receivable_id, principal, covered, p_proposed_amount;
    END IF;
    RAISE EXCEPTION 'customer_receivable %: (CANCELLATION_CHARGE) coverage would exceed the charge totalAmountMinor (principal=%, already covered=%, proposed=%)', p_receivable_id, principal, covered, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════ (2) payment application: OPENING + CANCELLATION_CHARGE targets ══
CREATE OR REPLACE FUNCTION fn_check_customer_receivable_payment_application_integrity() RETURNS trigger AS $$
DECLARE
  recv RECORD;
  pay RECORD;
  att RECORD;
  ord_customer_id UUID;
  recv_currency_code TEXT;
  recv_currency_exponent SMALLINT;
BEGIN
  SELECT * INTO recv FROM "customer_receivable" WHERE "id" = NEW."customerReceivableId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: referenced customerReceivableId % does not exist', NEW."id", NEW."customerReceivableId";
  END IF;
  IF recv."sourceType" NOT IN ('OPENING', 'CANCELLATION_CHARGE') THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: target customerReceivable % is not OPENING-sourced (got %) and is not CANCELLATION_CHARGE-sourced — an INVOICE-sourced receivable must use PaymentAllocation, never this table', NEW."id", NEW."customerReceivableId", recv."sourceType";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM recv."tenantId" OR NEW."companyId" IS DISTINCT FROM recv."companyId" OR NEW."branchId" IS DISTINCT FROM recv."branchId" THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: scope does not match customerReceivable %', NEW."id", NEW."customerReceivableId";
  END IF;
  IF NEW."customerCompanyAccountId" IS DISTINCT FROM recv."customerCompanyAccountId" THEN
    RAISE EXCEPTION 'customer_receivable_payment_application %: customerCompanyAccountId does not match customerReceivable %''s own account', NEW."id", NEW."customerReceivableId";
  END IF;

  -- the receivable's OWN currency: authored on the row for an OPENING receivable,
  -- on the immutable CancellationCharge for a CANCELLATION_CHARGE receivable (its
  -- own currency columns are NULL by CHECK).
  IF recv."sourceType" = 'OPENING' THEN
    recv_currency_code := recv."currencyCode";
    recv_currency_exponent := recv."currencyExponent";
  ELSE
    SELECT cc."currencyCode", cc."currencyExponent" INTO recv_currency_code, recv_currency_exponent
      FROM "cancellation_charge" cc WHERE cc."id" = recv."cancellationChargeId";
  END IF;
  IF NEW."currencyCode" IS DISTINCT FROM recv_currency_code OR NEW."currencyExponent" IS DISTINCT FROM recv_currency_exponent THEN
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

  -- canonical lock order (unchanged): coverage anchor (the customer_receivable
  -- row) BEFORE the Payment.
  PERFORM fn_lock_and_validate_opening_receivable_coverage(recv."id", NEW."amountMinor");
  PERFORM fn_lock_and_validate_payment_capacity(NEW."paymentId", NEW."amountMinor");

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════ (3) invoice coverage: a CreditNote's AR reduction is part of it ═
CREATE OR REPLACE FUNCTION fn_lock_and_validate_invoice_coverage(p_invoice_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  inv_total BIGINT;
  receivable_id UUID;
  covered BIGINT;
  credited BIGINT;
BEGIN
  SELECT "totalAmountMinor" INTO inv_total FROM "invoice" WHERE "id" = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice %: does not exist', p_invoice_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO covered FROM "payment_allocation" WHERE "invoiceId" = p_invoice_id;
  SELECT "id" INTO receivable_id FROM "customer_receivable" WHERE "invoiceId" = p_invoice_id;
  IF receivable_id IS NOT NULL THEN
    covered := covered + COALESCE((SELECT SUM("amountMinor") FROM "customer_advance_application" WHERE "customerReceivableId" = receivable_id), 0);
  END IF;
  SELECT COALESCE(SUM("arReductionMinor"), 0) INTO credited FROM "credit_note" WHERE "invoiceId" = p_invoice_id;
  IF covered + credited + p_proposed_amount > inv_total THEN
    RAISE EXCEPTION 'invoice %: coverage would exceed totalAmountMinor (total=%, already covered=%, credited by CreditNote=%, proposed=%)', p_invoice_id, inv_total, covered, credited, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════ (4) chronology vocabulary: CANCELLATION_CHARGE_PAYMENT_APPLIED ══
-- Widened from the ACTUAL CURRENT shape (migration 44's 11-kind vocabulary and its
-- 9-group exactly-one-reference rule) — never from an older shape.
ALTER TABLE "customer_account_entry" DROP CONSTRAINT "customer_account_entry_kind_chk";
ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_kind_chk" CHECK ("entryKind" IN (
    'INVOICE', 'PAYMENT', 'PAYMENT_ALLOCATION', 'OPENING_RECEIVABLE_PAYMENT_APPLIED',
    'ADVANCE', 'ADVANCE_APPLIED', 'OPENING_RECEIVABLE', 'OPENING_ADVANCE',
    'CREDIT_NOTE', 'CANCELLATION_CHARGE', 'REFUND', 'CANCELLATION_CHARGE_PAYMENT_APPLIED'
  ));

ALTER TABLE "customer_account_entry" DROP CONSTRAINT "customer_account_entry_reference_xor_chk";
ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_reference_xor_chk" CHECK (
    ("entryKind" IN ('INVOICE', 'OPENING_RECEIVABLE', 'CANCELLATION_CHARGE')
      AND "customerReceivableId" IS NOT NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT'
      AND "paymentId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT_ALLOCATION'
      AND "paymentAllocationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" IN ('OPENING_RECEIVABLE_PAYMENT_APPLIED', 'CANCELLATION_CHARGE_PAYMENT_APPLIED')
      AND "customerReceivablePaymentApplicationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" IN ('ADVANCE', 'OPENING_ADVANCE')
      AND "customerAdvanceId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'ADVANCE_APPLIED'
      AND "customerAdvanceApplicationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'CREDIT_NOTE'
      AND "creditNoteId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'REFUND'
      AND "customerAdvanceRefundApplicationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL)
  );

-- the cross-table backstop — every branch below that existed in migration 44 is
-- reproduced VERBATIM; only the payment-application branch is new.
CREATE OR REPLACE FUNCTION fn_check_customer_account_entry_source_type() RETURNS trigger AS $$
DECLARE
  recv_source_type TEXT;
  adv_source_type TEXT;
  app_recv_source_type TEXT;
BEGIN
  IF NEW."entryKind" IN ('INVOICE', 'OPENING_RECEIVABLE') THEN
    SELECT "sourceType" INTO recv_source_type FROM "customer_receivable" WHERE "id" = NEW."customerReceivableId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_account_entry %: referenced customerReceivableId % does not exist', NEW."id", NEW."customerReceivableId";
    END IF;
    IF NEW."entryKind" = 'INVOICE' AND recv_source_type IS DISTINCT FROM 'INVOICE' THEN
      RAISE EXCEPTION 'customer_account_entry %: entryKind INVOICE requires customerReceivable %''s sourceType = INVOICE (got %)', NEW."id", NEW."customerReceivableId", recv_source_type;
    END IF;
    IF NEW."entryKind" = 'OPENING_RECEIVABLE' AND recv_source_type IS DISTINCT FROM 'OPENING' THEN
      RAISE EXCEPTION 'customer_account_entry %: entryKind OPENING_RECEIVABLE requires customerReceivable %''s sourceType = OPENING (got %)', NEW."id", NEW."customerReceivableId", recv_source_type;
    END IF;
  ELSIF NEW."entryKind" = 'CANCELLATION_CHARGE' THEN
    SELECT "sourceType" INTO recv_source_type FROM "customer_receivable" WHERE "id" = NEW."customerReceivableId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_account_entry %: referenced customerReceivableId % does not exist', NEW."id", NEW."customerReceivableId";
    END IF;
    IF recv_source_type IS DISTINCT FROM 'CANCELLATION_CHARGE' THEN
      RAISE EXCEPTION 'customer_account_entry %: entryKind=CANCELLATION_CHARGE but customer_receivable %''s own sourceType is %', NEW."id", NEW."customerReceivableId", recv_source_type;
    END IF;
  ELSIF NEW."entryKind" IN ('ADVANCE', 'OPENING_ADVANCE') THEN
    SELECT "sourceType" INTO adv_source_type FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_account_entry %: referenced customerAdvanceId % does not exist', NEW."id", NEW."customerAdvanceId";
    END IF;
    IF NEW."entryKind" = 'ADVANCE' AND adv_source_type NOT IN ('PAYMENT', 'CREDIT_NOTE') THEN
      RAISE EXCEPTION 'customer_account_entry %: entryKind ADVANCE requires customerAdvance %''s sourceType = PAYMENT (got %)', NEW."id", NEW."customerAdvanceId", adv_source_type;
    END IF;
    IF NEW."entryKind" = 'OPENING_ADVANCE' AND adv_source_type IS DISTINCT FROM 'OPENING' THEN
      RAISE EXCEPTION 'customer_account_entry %: entryKind OPENING_ADVANCE requires customerAdvance %''s sourceType = OPENING (got %)', NEW."id", NEW."customerAdvanceId", adv_source_type;
    END IF;
  ELSIF NEW."entryKind" IN ('OPENING_RECEIVABLE_PAYMENT_APPLIED', 'CANCELLATION_CHARGE_PAYMENT_APPLIED') THEN
    -- NEW (migration 46). A NULL reference is the exactly-one-reference CHECK's
    -- to report (it is evaluated right after this BEFORE trigger).
    IF NEW."customerReceivablePaymentApplicationId" IS NOT NULL THEN
      SELECT r."sourceType" INTO app_recv_source_type
        FROM "customer_receivable_payment_application" a
        JOIN "customer_receivable" r ON r."id" = a."customerReceivableId"
       WHERE a."id" = NEW."customerReceivablePaymentApplicationId";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'customer_account_entry %: referenced customerReceivablePaymentApplicationId % does not exist', NEW."id", NEW."customerReceivablePaymentApplicationId";
      END IF;
      IF NEW."entryKind" = 'OPENING_RECEIVABLE_PAYMENT_APPLIED' AND app_recv_source_type IS DISTINCT FROM 'OPENING' THEN
        RAISE EXCEPTION 'customer_account_entry %: entryKind OPENING_RECEIVABLE_PAYMENT_APPLIED requires the payment application''s target customerReceivable to be sourceType = OPENING (got %) — a payment applied to a CANCELLATION_CHARGE receivable is recorded as CANCELLATION_CHARGE_PAYMENT_APPLIED', NEW."id", app_recv_source_type;
      END IF;
      IF NEW."entryKind" = 'CANCELLATION_CHARGE_PAYMENT_APPLIED' AND app_recv_source_type IS DISTINCT FROM 'CANCELLATION_CHARGE' THEN
        RAISE EXCEPTION 'customer_account_entry %: entryKind CANCELLATION_CHARGE_PAYMENT_APPLIED requires the payment application''s target customerReceivable to be sourceType = CANCELLATION_CHARGE (got %)', NEW."id", app_recv_source_type;
      END IF;
    END IF;
  END IF;
  -- CREDIT_NOTE (creditNoteId) and REFUND (customerAdvanceRefundApplicationId)
  -- need no cross-table sourceType check — each references a table with no
  -- competing sourceType vocabulary of its own (mirrors PAYMENT/
  -- PAYMENT_ALLOCATION's own precedent: "their sole reference column already
  -- carries a real FK — there is no second sourceType on those tables to
  -- cross-validate against").
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
