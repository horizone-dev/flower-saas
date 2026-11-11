-- Phase 3B closure — RB-1 (owner decision 2026-11-11: option A2, "additive anonymous credit note").
--
-- An ISSUED ANONYMOUS sale (order.customerId IS NULL) could not be credited or refunded: the frozen 3b.8 credit-note path funds a
-- CustomerAdvance on a customer account. This migration is PURELY ADDITIVE: three NEW tables, their triggers, RLS and grants. It edits
-- NO existing table, constraint, trigger, function, policy, privilege, permission or posting template, and registers NO permission key
-- (the route reuses `credit_notes:issue` + `refunds:execute`).
--
--   anonymous_credit_note         one immutable document per credit (numbered from the SAME company CREDIT_NOTE counter as `credit_note`,
--                                 so the series stays gapless across both kinds); partial and full credits
--   anonymous_credit_note_line    the frozen per-line reversal snapshot (same components as `credit_note_line`)
--   anonymous_credit_note_refund  the refund INTENT per tender (PENDING) and its verified outcome (EXECUTED | FAILED). A refund is never
--                                 reported executed until a user attests its tender execution (the only mutable columns)
--
-- The original sale journal, the invoice and the order are NEVER touched (owner decision 3): a reversed sale is identified by these records.
-- Database guards (independent of the application): the credited invoice's order must be ANONYMOUS; a line must belong to that order; the
-- cumulative credited quantity / line discount / line tax can never exceed the frozen order line; the cumulative credited total can never
-- exceed the invoice total; per (invoice, tender) the non-failed refunds can never exceed what that tender paid; a note's non-failed refunds
-- can never exceed its total, and at creation equal it. All guards take the invoice row lock first, so concurrent credits serialise.

-- ═══════════════════════════ tables ═══════════════════════════

CREATE TABLE "anonymous_credit_note" (
    "id"                  UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"            UUID NOT NULL,
    "companyId"           UUID NOT NULL,
    "branchId"            UUID NOT NULL,
    "invoiceId"           UUID NOT NULL,
    "creditNoteNumber"    TEXT NOT NULL,
    "issuedAt"            TIMESTAMPTZ(6) NOT NULL,
    "accountingDate"      DATE NOT NULL,
    "currencyCode"        TEXT NOT NULL,
    "currencyExponent"    SMALLINT NOT NULL,
    "reasonCode"          TEXT NOT NULL,
    "note"                VARCHAR(255),
    "subtotalAmountMinor" BIGINT NOT NULL,
    "taxTotalAmountMinor" BIGINT NOT NULL,
    "totalAmountMinor"    BIGINT NOT NULL,
    "createdByUserId"     UUID,
    "createdAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "anonymous_credit_note_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "anonymous_credit_note_line" (
    "id"                                    UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                              UUID NOT NULL,
    "companyId"                             UUID NOT NULL,
    "creditNoteId"                          UUID NOT NULL,
    "orderLineId"                           UUID NOT NULL,
    "quantityCredited"                      DECIMAL(18,4) NOT NULL,
    "grossCreditedMinor"                    BIGINT NOT NULL,
    "discountCreditedMinor"                 BIGINT NOT NULL,
    "documentDiscountShareCreditedMinor"    BIGINT NOT NULL,
    "netAfterDocumentDiscountCreditedMinor" BIGINT NOT NULL,
    "taxCreditedMinor"                      BIGINT NOT NULL,
    "lineTotalCreditedMinor"                BIGINT NOT NULL,
    "currencyCode"                          TEXT NOT NULL,
    "currencyExponent"                      SMALLINT NOT NULL,
    "createdAt"                             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "anonymous_credit_note_line_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "anonymous_credit_note_refund" (
    "id"                UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"          UUID NOT NULL,
    "companyId"         UUID NOT NULL,
    "branchId"          UUID NOT NULL,
    "creditNoteId"      UUID NOT NULL,
    "invoiceId"         UUID NOT NULL,
    "method"            TEXT NOT NULL,
    "amountMinor"       BIGINT NOT NULL,
    "currencyCode"      TEXT NOT NULL,
    "currencyExponent"  SMALLINT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'PENDING',
    "reference"         VARCHAR(60),
    "requestedByUserId" UUID,
    "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"        TIMESTAMPTZ(6),
    "resolvedByUserId"  UUID,
    "failureReasonCode" TEXT,
    "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "anonymous_credit_note_refund_pkey" PRIMARY KEY ("id")
);

-- ═══════════════════════════ indexes ═══════════════════════════

CREATE UNIQUE INDEX "anonymous_credit_note_tenantId_id_key" ON "anonymous_credit_note"("tenantId", "id");
CREATE UNIQUE INDEX "anonymous_credit_note_tenantId_companyId_id_key" ON "anonymous_credit_note"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "anonymous_credit_note_tenantId_companyId_branchId_id_key" ON "anonymous_credit_note"("tenantId", "companyId", "branchId", "id");
CREATE UNIQUE INDEX "anonymous_credit_note_tenantId_companyId_number_key" ON "anonymous_credit_note"("tenantId", "companyId", "creditNoteNumber");
CREATE INDEX "anonymous_credit_note_tenantId_companyId_invoiceId_idx" ON "anonymous_credit_note"("tenantId", "companyId", "invoiceId");
CREATE UNIQUE INDEX "anonymous_credit_note_line_tenantId_id_key" ON "anonymous_credit_note_line"("tenantId", "id");
CREATE INDEX "anonymous_credit_note_line_creditNoteId_idx" ON "anonymous_credit_note_line"("creditNoteId");
CREATE INDEX "anonymous_credit_note_line_orderLineId_idx" ON "anonymous_credit_note_line"("orderLineId");
CREATE UNIQUE INDEX "anonymous_credit_note_refund_tenantId_id_key" ON "anonymous_credit_note_refund"("tenantId", "id");
CREATE INDEX "anonymous_credit_note_refund_creditNoteId_idx" ON "anonymous_credit_note_refund"("creditNoteId");
CREATE INDEX "anonymous_credit_note_refund_invoice_method_idx" ON "anonymous_credit_note_refund"("invoiceId", "method");

-- ═══════════════════════════ foreign keys ═══════════════════════════

ALTER TABLE "anonymous_credit_note" ADD CONSTRAINT "anonymous_credit_note_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "anonymous_credit_note" ADD CONSTRAINT "anonymous_credit_note_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anonymous_credit_note" ADD CONSTRAINT "anonymous_credit_note_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- the credit's branch must equal the invoice's own branch (never a client-chosen branch)
ALTER TABLE "anonymous_credit_note" ADD CONSTRAINT "anonymous_credit_note_invoice_scope_fkey" FOREIGN KEY ("tenantId", "companyId", "branchId", "invoiceId") REFERENCES "invoice"("tenantId", "companyId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "anonymous_credit_note_line" ADD CONSTRAINT "anonymous_credit_note_line_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "anonymous_credit_note_line" ADD CONSTRAINT "anonymous_credit_note_line_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "anonymous_credit_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "anonymous_credit_note_line" ADD CONSTRAINT "anonymous_credit_note_line_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "anonymous_credit_note_refund" ADD CONSTRAINT "anonymous_credit_note_refund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "anonymous_credit_note_refund" ADD CONSTRAINT "anonymous_credit_note_refund_creditNote_scope_fkey" FOREIGN KEY ("tenantId", "companyId", "branchId", "creditNoteId") REFERENCES "anonymous_credit_note"("tenantId", "companyId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════ CHECK constraints ═══════════════════════════

ALTER TABLE "anonymous_credit_note"
  ADD CONSTRAINT "anonymous_credit_note_subtotal_nonneg_chk" CHECK ("subtotalAmountMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_tax_nonneg_chk" CHECK ("taxTotalAmountMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_total_positive_chk" CHECK ("totalAmountMinor" > 0),
  ADD CONSTRAINT "anonymous_credit_note_tax_le_total_chk" CHECK ("taxTotalAmountMinor" <= "totalAmountMinor"),
  ADD CONSTRAINT "anonymous_credit_note_exponent_chk" CHECK ("currencyExponent" BETWEEN 0 AND 4),
  ADD CONSTRAINT "anonymous_credit_note_number_format_chk" CHECK ("creditNoteNumber" ~ '^CN-[0-9]{6,}$'),
  ADD CONSTRAINT "anonymous_credit_note_reason_code_chk" CHECK ("reasonCode" IN (
    'CUSTOMER_REQUEST', 'DUPLICATE', 'PRICING_ERROR', 'DAMAGED',
    'SERVICE_NOT_DELIVERED', 'ORDER_ERROR', 'OTHER'
  ));

ALTER TABLE "anonymous_credit_note_line"
  ADD CONSTRAINT "anonymous_credit_note_line_quantity_positive_chk" CHECK ("quantityCredited" > 0),
  ADD CONSTRAINT "anonymous_credit_note_line_gross_nonneg_chk" CHECK ("grossCreditedMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_line_discount_nonneg_chk" CHECK ("discountCreditedMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_line_docshare_nonneg_chk" CHECK ("documentDiscountShareCreditedMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_line_net_nonneg_chk" CHECK ("netAfterDocumentDiscountCreditedMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_line_tax_nonneg_chk" CHECK ("taxCreditedMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_line_total_nonneg_chk" CHECK ("lineTotalCreditedMinor" >= 0),
  ADD CONSTRAINT "anonymous_credit_note_line_net_equation_chk" CHECK (
    "netAfterDocumentDiscountCreditedMinor" = "grossCreditedMinor" - "discountCreditedMinor" - "documentDiscountShareCreditedMinor"
  ),
  -- the line total is the net (tax-inclusive) or the net plus tax (tax-exclusive): either way it is one of the two
  ADD CONSTRAINT "anonymous_credit_note_line_total_equation_chk" CHECK (
    "lineTotalCreditedMinor" = "netAfterDocumentDiscountCreditedMinor"
    OR "lineTotalCreditedMinor" = "netAfterDocumentDiscountCreditedMinor" + "taxCreditedMinor"
  ),
  ADD CONSTRAINT "anonymous_credit_note_line_exponent_chk" CHECK ("currencyExponent" BETWEEN 0 AND 4);

ALTER TABLE "anonymous_credit_note_refund"
  ADD CONSTRAINT "anonymous_credit_note_refund_amount_positive_chk" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "anonymous_credit_note_refund_exponent_chk" CHECK ("currencyExponent" BETWEEN 0 AND 4),
  -- the manual tenders an anonymous sale can have used (CREDIT is never a tender; provider-backed tenders cannot reach an anonymous sale)
  ADD CONSTRAINT "anonymous_credit_note_refund_method_chk" CHECK ("method" IN ('CASH', 'BANK_TRANSFER', 'CARD_TERMINAL', 'OTHER_MANUAL')),
  ADD CONSTRAINT "anonymous_credit_note_refund_status_chk" CHECK ("status" IN ('PENDING', 'EXECUTED', 'FAILED')),
  ADD CONSTRAINT "anonymous_credit_note_refund_failure_reason_chk" CHECK ("failureReasonCode" IS NULL OR "failureReasonCode" IN (
    'TERMINAL_DECLINED', 'CUSTOMER_UNAVAILABLE', 'CASH_UNAVAILABLE', 'BANK_REJECTED', 'OTHER'
  )),
  -- a refund is PENDING until a user attests the outcome; the outcome facts exist exactly when it is resolved — and a resolution is always
  -- ATTRIBUTED: an EXECUTED or FAILED refund names the user who attested it (the attestation IS the evidence for a manual card / other refund)
  ADD CONSTRAINT "anonymous_credit_note_refund_state_chk" CHECK (
    ("status" = 'PENDING' AND "resolvedAt" IS NULL AND "resolvedByUserId" IS NULL AND "failureReasonCode" IS NULL)
    OR ("status" = 'EXECUTED' AND "resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL AND "failureReasonCode" IS NULL)
    OR ("status" = 'FAILED' AND "resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL AND "failureReasonCode" IS NOT NULL)
  );

-- ═══════════════════════════ immutability ═══════════════════════════

CREATE FUNCTION fn_anon_cn_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% % is immutable: % is never permitted', TG_TABLE_NAME, OLD."id", TG_OP;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER trg_anon_cn_no_update BEFORE UPDATE ON "anonymous_credit_note" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_immutable();
CREATE TRIGGER trg_anon_cn_no_delete BEFORE DELETE ON "anonymous_credit_note" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_immutable();
CREATE TRIGGER trg_anon_cn_line_no_update BEFORE UPDATE ON "anonymous_credit_note_line" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_immutable();
CREATE TRIGGER trg_anon_cn_line_no_delete BEFORE DELETE ON "anonymous_credit_note_line" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_immutable();
CREATE TRIGGER trg_anon_cn_refund_no_delete BEFORE DELETE ON "anonymous_credit_note_refund" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_immutable();

-- ═══════════════════════════ note: ANONYMOUS invoices only, shared numbering ═══════════════════════════

CREATE FUNCTION fn_anon_cn_note_guard() RETURNS trigger AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT i."id", i."orderId", i."currencyCode", i."currencyExponent", i."totalAmountMinor" INTO inv
    FROM "invoice" i WHERE i."id" = NEW."invoiceId" FOR UPDATE; -- serialise every credit of this invoice
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anonymous_credit_note: invoice % not found', NEW."invoiceId" USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- the credited invoice's ORDER must be anonymous: a customer-linked invoice can only use the frozen 3b.8 credit-note path
  IF EXISTS (SELECT 1 FROM "order" o WHERE o."id" = inv."orderId" AND o."customerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'anonymous_credit_note: invoice % belongs to a customer-linked order', NEW."invoiceId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currencyCode" <> inv."currencyCode" OR NEW."currencyExponent" <> inv."currencyExponent" THEN
    RAISE EXCEPTION 'anonymous_credit_note: currency must equal the invoice currency' USING ERRCODE = 'check_violation';
  END IF;
  -- one gapless company series shared with `credit_note`: the same number can never exist in both tables
  IF EXISTS (SELECT 1 FROM "credit_note" c WHERE c."tenantId" = NEW."tenantId" AND c."companyId" = NEW."companyId"
               AND c."creditNoteNumber" = NEW."creditNoteNumber") THEN
    RAISE EXCEPTION 'anonymous_credit_note: number % already exists as a credit note', NEW."creditNoteNumber" USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
CREATE TRIGGER trg_anon_cn_note_guard BEFORE INSERT ON "anonymous_credit_note" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_note_guard();

-- ═══════════════════════════ line: provenance + capacity ═══════════════════════════

CREATE FUNCTION fn_anon_cn_line_guard() RETURNS trigger AS $$
DECLARE
  cn   RECORD;
  inv  RECORD;
  ol   RECORD;
  prev_q NUMERIC;
  prev_d BIGINT;
  prev_t BIGINT;
  prev_total BIGINT;
  prev_s BIGINT;
BEGIN
  SELECT n."id", n."invoiceId", n."tenantId", n."companyId", n."currencyCode", n."currencyExponent" INTO cn
    FROM "anonymous_credit_note" n WHERE n."id" = NEW."creditNoteId";
  IF NOT FOUND OR cn."tenantId" <> NEW."tenantId" OR cn."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: credit note scope mismatch' USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."orderId", i."totalAmountMinor", i."documentDiscountAmountMinor" INTO inv
    FROM "invoice" i WHERE i."id" = cn."invoiceId" FOR UPDATE; -- same first lock as every other guard
  SELECT l."orderId", l."quantity", l."discountAmountMinor", l."lineTaxAmountMinor" INTO ol
    FROM "order_line" l WHERE l."id" = NEW."orderLineId";
  IF NOT FOUND OR ol."orderId" <> inv."orderId" THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: order line % does not belong to the credited invoice''s order', NEW."orderLineId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currencyCode" <> cn."currencyCode" OR NEW."currencyExponent" <> cn."currencyExponent" THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: currency must equal the credit note currency' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(x."quantityCredited"), 0), COALESCE(SUM(x."discountCreditedMinor"), 0), COALESCE(SUM(x."taxCreditedMinor"), 0)
    INTO prev_q, prev_d, prev_t FROM "anonymous_credit_note_line" x WHERE x."orderLineId" = NEW."orderLineId";
  IF prev_q + NEW."quantityCredited" > ol."quantity" THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: cumulative credited quantity % exceeds the ordered quantity %', prev_q + NEW."quantityCredited", ol."quantity" USING ERRCODE = 'check_violation';
  END IF;
  IF prev_d + NEW."discountCreditedMinor" > ol."discountAmountMinor" THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: cumulative credited line discount exceeds the frozen line discount' USING ERRCODE = 'check_violation';
  END IF;
  IF prev_t + NEW."taxCreditedMinor" > COALESCE(ol."lineTaxAmountMinor", 0) THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: cumulative credited tax exceeds the frozen line tax' USING ERRCODE = 'check_violation';
  END IF;
  -- the FINAL credit of a line consumes the exact remainder of every frozen component (no rounding dust is ever left or over-credited)
  IF prev_q + NEW."quantityCredited" = ol."quantity" THEN
    IF prev_d + NEW."discountCreditedMinor" <> ol."discountAmountMinor"
       OR prev_t + NEW."taxCreditedMinor" <> COALESCE(ol."lineTaxAmountMinor", 0) THEN
      RAISE EXCEPTION 'anonymous_credit_note_line: the final credit of a line must consume the exact remainder of its discount and tax' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT COALESCE(SUM(x."lineTotalCreditedMinor"), 0), COALESCE(SUM(x."documentDiscountShareCreditedMinor"), 0)
    INTO prev_total, prev_s
    FROM "anonymous_credit_note_line" x JOIN "anonymous_credit_note" n ON n."id" = x."creditNoteId"
   WHERE n."invoiceId" = cn."invoiceId";
  IF prev_total + NEW."lineTotalCreditedMinor" > inv."totalAmountMinor" THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: cumulative credited total exceeds the invoice total' USING ERRCODE = 'check_violation';
  END IF;
  IF prev_s + NEW."documentDiscountShareCreditedMinor" > inv."documentDiscountAmountMinor" THEN
    RAISE EXCEPTION 'anonymous_credit_note_line: cumulative credited document discount exceeds the invoice document discount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
CREATE TRIGGER trg_anon_cn_line_guard BEFORE INSERT ON "anonymous_credit_note_line" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_line_guard();

-- ═══════════════════════════ refund: tender caps, born PENDING, guarded transitions ═══════════════════════════

CREATE FUNCTION fn_anon_cn_refund_insert_guard() RETURNS trigger AS $$
DECLARE
  cn   RECORD;
  paid BIGINT;
  used BIGINT;
  note_used BIGINT;
BEGIN
  SELECT n."invoiceId", n."totalAmountMinor", n."currencyCode", n."currencyExponent" INTO cn
    FROM "anonymous_credit_note" n WHERE n."id" = NEW."creditNoteId";
  IF NOT FOUND OR cn."invoiceId" <> NEW."invoiceId" THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund: invoice does not match the credit note' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currencyCode" <> cn."currencyCode" OR NEW."currencyExponent" <> cn."currencyExponent" THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund: currency must equal the credit note currency' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund: a refund is created PENDING' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM "invoice" i WHERE i."id" = cn."invoiceId" FOR UPDATE; -- serialise every credit / refund of this invoice
  -- what this tender actually paid for the invoice (the sale's own payment allocations)
  SELECT COALESCE(SUM(pa."amountMinor"), 0) INTO paid
    FROM "payment_allocation" pa JOIN "payment" p ON p."id" = pa."paymentId"
   WHERE pa."invoiceId" = cn."invoiceId" AND p."method" = NEW."method";
  SELECT COALESCE(SUM(r."amountMinor"), 0) INTO used
    FROM "anonymous_credit_note_refund" r
   WHERE r."invoiceId" = cn."invoiceId" AND r."method" = NEW."method" AND r."status" <> 'FAILED';
  IF used + NEW."amountMinor" > paid THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund: % refunds % would exceed what that tender paid (%)', NEW."method", used + NEW."amountMinor", paid USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(r."amountMinor"), 0) INTO note_used
    FROM "anonymous_credit_note_refund" r WHERE r."creditNoteId" = NEW."creditNoteId" AND r."status" <> 'FAILED';
  IF note_used + NEW."amountMinor" > cn."totalAmountMinor" THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund: refunds % would exceed the credit note total %', note_used + NEW."amountMinor", cn."totalAmountMinor" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
CREATE TRIGGER trg_anon_cn_refund_insert_guard BEFORE INSERT ON "anonymous_credit_note_refund" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_refund_insert_guard();

-- only PENDING → EXECUTED | FAILED, only the outcome columns may change; EXECUTED and FAILED are terminal
CREATE FUNCTION fn_anon_cn_refund_update_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund % is % and terminal', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('EXECUTED', 'FAILED') THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund %: a PENDING refund can only become EXECUTED or FAILED', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."creditNoteId" IS DISTINCT FROM OLD."creditNoteId" OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
     OR NEW."method" IS DISTINCT FROM OLD."method" OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM OLD."currencyExponent"
     OR NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund %: only the outcome columns may change', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
CREATE TRIGGER trg_anon_cn_refund_update_guard BEFORE UPDATE ON "anonymous_credit_note_refund" FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_refund_update_guard();

-- ═══════════════════════════ note completeness, checked at COMMIT ═══════════════════════════
-- a note is created together with its lines and its initial refunds: the lines sum to the stored totals and the (non-failed) refunds sum
-- to the credit total exactly. Later replacement refunds are bounded by the insert guard above (never above the total).

CREATE FUNCTION fn_anon_cn_note_complete() RETURNS trigger AS $$
DECLARE
  cn RECORD;
  v_lines INT; v_net BIGINT; v_tax BIGINT; v_total BIGINT; v_refunds BIGINT;
BEGIN
  SELECT * INTO cn FROM "anonymous_credit_note" WHERE "id" = NEW."id";
  SELECT COUNT(*), COALESCE(SUM(l."netAfterDocumentDiscountCreditedMinor"), 0), COALESCE(SUM(l."taxCreditedMinor"), 0), COALESCE(SUM(l."lineTotalCreditedMinor"), 0)
    INTO v_lines, v_net, v_tax, v_total FROM "anonymous_credit_note_line" l WHERE l."creditNoteId" = cn."id";
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'anonymous_credit_note %: a credit note needs at least one line', cn."id" USING ERRCODE = 'check_violation';
  END IF;
  IF v_net <> cn."subtotalAmountMinor" OR v_tax <> cn."taxTotalAmountMinor" OR v_total <> cn."totalAmountMinor" THEN
    RAISE EXCEPTION 'anonymous_credit_note %: the lines do not sum to the stored totals', cn."id" USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(r."amountMinor"), 0) INTO v_refunds
    FROM "anonymous_credit_note_refund" r WHERE r."creditNoteId" = cn."id" AND r."status" <> 'FAILED';
  IF v_refunds <> cn."totalAmountMinor" THEN
    RAISE EXCEPTION 'anonymous_credit_note %: the refunds (%) must equal the credit total (%)', cn."id", v_refunds, cn."totalAmountMinor" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
CREATE CONSTRAINT TRIGGER trg_anon_cn_note_complete
  AFTER INSERT ON "anonymous_credit_note"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_note_complete();

-- ═══════════════════════════ status ↔ posting atomicity, checked at COMMIT (F-4) ═══════════════════════════
-- The application writes a refund's outcome and its journal in ONE transaction. These deferred checks make that coupling a DATABASE
-- guarantee, so a direct writer (a bug, an injected statement, a mis-granted role) cannot leave a status without its posting or a posting
-- without its status. They enforce the EXISTING accounting policy (the frozen tender → account mapping and the two-phase design); they
-- introduce no new policy. The method → account pairs below mirror `resolveReceiptAccountKeyForTender` (a structural test pins the parity).
--   issuance   Dr REVENUE.SALES (total − tax) · Dr LIABILITY.TAX_PAYABLE (tax) / Cr ASSET.PAYMENT_CLEARING (total)       exactly these lines
--   EXECUTED   CASH → Dr ASSET.PAYMENT_CLEARING / Cr ASSET.CASH_ON_HAND · BANK_TRANSFER → … / Cr ASSET.BANK                exactly these lines
--   EXECUTED manual card / other, FAILED, PENDING: NO execution journal may exist (they post nothing).
-- A superuser or a role with BYPASSRLS / the table owner can still disable triggers (`session_replication_role`); that residual path is
-- covered by the detective reconciliation (Q3 of the control queries), not by this trigger.

CREATE FUNCTION fn_anon_cn_refund_execution_journal_guard() RETURNS trigger AS $$
DECLARE
  r RECORD;
  tender_key TEXT;
  n_journals INT;
  j_id UUID;
  j_sealed TIMESTAMPTZ;
  c_clear INT; c_tender INT; c_all INT;
BEGIN
  SELECT * INTO r FROM "anonymous_credit_note_refund" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  tender_key := CASE r."method" WHEN 'CASH' THEN 'ASSET.CASH_ON_HAND' WHEN 'BANK_TRANSFER' THEN 'ASSET.BANK' ELSE NULL END;
  SELECT COUNT(*), MIN(je."id"::text)::uuid INTO n_journals, j_id
    FROM "journal_entry" je
   WHERE je."tenantId" = r."tenantId" AND je."companyId" = r."companyId"
     AND je."sourceKind" = 'anonymous_credit_note_refund' AND je."sourceId" = r."id"::text;

  IF r."status" = 'EXECUTED' AND tender_key IS NOT NULL THEN
    IF n_journals <> 1 THEN
      RAISE EXCEPTION 'anonymous_credit_note_refund %: an EXECUTED % refund needs exactly one execution journal (found %)', r."id", r."method", n_journals USING ERRCODE = 'check_violation';
    END IF;
    SELECT je."sealedAt" INTO j_sealed FROM "journal_entry" je WHERE je."id" = j_id;
    SELECT COUNT(*) FILTER (WHERE a."key" = 'ASSET.PAYMENT_CLEARING' AND jl."debitMinor" = r."amountMinor" AND jl."creditMinor" = 0),
           COUNT(*) FILTER (WHERE a."key" = tender_key AND jl."creditMinor" = r."amountMinor" AND jl."debitMinor" = 0),
           COUNT(*)
      INTO c_clear, c_tender, c_all
      FROM "journal_line" jl JOIN "account" a ON a."id" = jl."accountId"
     WHERE jl."journalEntryId" = j_id;
    IF j_sealed IS NULL OR c_clear <> 1 OR c_tender <> 1 OR c_all <> 2 THEN
      RAISE EXCEPTION 'anonymous_credit_note_refund %: the execution journal must be sealed and be exactly Dr ASSET.PAYMENT_CLEARING / Cr % for the refund amount', r."id", tender_key USING ERRCODE = 'check_violation';
    END IF;
  ELSIF n_journals > 0 THEN
    RAISE EXCEPTION 'anonymous_credit_note_refund %: a refund that is % (method %) posts no execution journal, but % exist', r."id", r."status", r."method", n_journals USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
CREATE CONSTRAINT TRIGGER trg_anon_cn_refund_execution_journal_guard
  AFTER UPDATE OF "status" ON "anonymous_credit_note_refund"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_refund_execution_journal_guard();

CREATE FUNCTION fn_anon_cn_note_issuance_journal_guard() RETURNS trigger AS $$
DECLARE
  n RECORD;
  j_id UUID;
  j_sealed TIMESTAMPTZ;
  n_journals INT;
  c_rev INT; c_tax INT; c_clear INT; c_all INT;
  rev BIGINT;
BEGIN
  SELECT * INTO n FROM "anonymous_credit_note" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  rev := n."totalAmountMinor" - n."taxTotalAmountMinor";
  SELECT COUNT(*), MIN(je."id"::text)::uuid INTO n_journals, j_id
    FROM "journal_entry" je
   WHERE je."tenantId" = n."tenantId" AND je."companyId" = n."companyId"
     AND je."sourceKind" = 'anonymous_credit_note' AND je."sourceId" = n."id"::text;
  IF n_journals <> 1 THEN
    RAISE EXCEPTION 'anonymous_credit_note %: a credit note needs exactly one issuance journal (found %)', n."id", n_journals USING ERRCODE = 'check_violation';
  END IF;
  SELECT je."sealedAt" INTO j_sealed FROM "journal_entry" je WHERE je."id" = j_id;
  SELECT COUNT(*) FILTER (WHERE a."key" = 'REVENUE.SALES' AND jl."debitMinor" = rev AND jl."creditMinor" = 0),
         COUNT(*) FILTER (WHERE a."key" = 'LIABILITY.TAX_PAYABLE' AND jl."debitMinor" = n."taxTotalAmountMinor" AND jl."creditMinor" = 0),
         COUNT(*) FILTER (WHERE a."key" = 'ASSET.PAYMENT_CLEARING' AND jl."creditMinor" = n."totalAmountMinor" AND jl."debitMinor" = 0),
         COUNT(*)
    INTO c_rev, c_tax, c_clear, c_all
    FROM "journal_line" jl JOIN "account" a ON a."id" = jl."accountId"
   WHERE jl."journalEntryId" = j_id;
  IF j_sealed IS NULL
     OR c_clear <> 1
     OR c_rev <> (CASE WHEN rev > 0 THEN 1 ELSE 0 END)
     OR c_tax <> (CASE WHEN n."taxTotalAmountMinor" > 0 THEN 1 ELSE 0 END)
     OR c_all <> 1 + (CASE WHEN rev > 0 THEN 1 ELSE 0 END) + (CASE WHEN n."taxTotalAmountMinor" > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'anonymous_credit_note %: the issuance journal must be sealed and be exactly Dr REVENUE.SALES (total − tax) · Dr LIABILITY.TAX_PAYABLE (tax) / Cr ASSET.PAYMENT_CLEARING (total)', n."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
CREATE CONSTRAINT TRIGGER trg_anon_cn_note_issuance_journal_guard
  AFTER INSERT ON "anonymous_credit_note"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_anon_cn_note_issuance_journal_guard();

-- ═══════════════════════════ Row-Level Security (tenant isolation; branch is enforced by the scoped repository and the composite FKs) ═══════════════════════════

ALTER TABLE "anonymous_credit_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "anonymous_credit_note" FORCE ROW LEVEL SECURITY;
CREATE POLICY "anonymous_credit_note_tenant_isolation" ON "anonymous_credit_note"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "anonymous_credit_note_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "anonymous_credit_note_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "anonymous_credit_note_line_tenant_isolation" ON "anonymous_credit_note_line"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "anonymous_credit_note_refund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "anonymous_credit_note_refund" FORCE ROW LEVEL SECURITY;
CREATE POLICY "anonymous_credit_note_refund_tenant_isolation" ON "anonymous_credit_note_refund"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ═══════════════════════════ grants (least privilege) ═══════════════════════════
-- The Phase 1 default privileges grant SELECT/INSERT/UPDATE/DELETE on every new table; revoke them and grant exactly what each path needs.
-- Notes and lines are append-only; a refund may only have its outcome columns updated; nothing is ever deleted.

GRANT ALL ON "anonymous_credit_note", "anonymous_credit_note_line", "anonymous_credit_note_refund" TO flower_migrate;
REVOKE ALL ON "anonymous_credit_note", "anonymous_credit_note_line", "anonymous_credit_note_refund" FROM flower_platform, flower_app;
-- F-4: only the tenant-scoped application role (RLS-bound) may write; the platform realm (BYPASSRLS, cross-tenant support path) is READ-ONLY here.
GRANT SELECT ON "anonymous_credit_note", "anonymous_credit_note_line", "anonymous_credit_note_refund" TO flower_platform;
GRANT SELECT, INSERT ON "anonymous_credit_note", "anonymous_credit_note_line", "anonymous_credit_note_refund" TO flower_app;
GRANT UPDATE ("status", "reference", "resolvedAt", "resolvedByUserId", "failureReasonCode", "updatedAt")
  ON "anonymous_credit_note_refund" TO flower_app;
