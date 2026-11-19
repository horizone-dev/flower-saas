-- DRAFT O — NOT in packages/db/prisma/migrations, NOT applied to any real database, NOT approved. (paid-sale returns, 2026-11-15)
-- PAID-SALE RETURNS for ANONYMOUS (walk-in) PAY_NOW sales: the immutable return document, its lines (VAT adjusted with the frozen credit-note formulas) and the
-- refund legs back to the ORIGINAL tenders. REQUIRES the frozen order / invoice / payment tables; the stock disposition uses the valued ledger (DRAFT-I) but this
-- file does not depend on it.
--
-- WHY A NEW TABLE FAMILY (the exact missing contract, see docs/mvp/PAID-SALE-RETURN-DESIGN.md §2):
--   * "refund" cannot hold a walk-in refund: a deferred trigger (fn_check_refund_application_complete_anchor, migration 20261005120000) forces every
--     refund to be fully covered by customer_advance_refund_application rows — i.e. a customer advance. A walk-in sale has no customer and no advance.
--   * "credit_note" cannot hold it either: credit_note_split_eq_total_chk + the advance-excess anchor force arReduction + advanceExcess = total and a CREDIT_NOTE
--     customer advance; an anonymous return is paid back at the till, not into a customer account.
--   * Neither frozen table is changed here. Customer-linked paid returns stay on the frozen credit-note → advance → refund chain (design only).
--
-- Guarantees (database-enforced):
--   * append-only: no UPDATE, no DELETE for any role; a mistake is corrected only by a later return, never by editing history;
--   * a return belongs to ONE invoice of an ANONYMOUS order, in the invoice's own branch (composite FK + guard);
--   * cumulative returned quantity of an order line can never exceed the quantity sold (the order line is locked FOR UPDATE inside the guard);
--   * a refund leg can only refund a payment that paid THIS invoice, by the SAME method, in the same branch, and the legs of one payment can never exceed it;
--   * at COMMIT: header = Σ lines (subtotal / tax / total), Σ refund legs = the return total, restock + waste = returned, and when every line of the order
--     has been fully returned the credited money equals the invoice exactly (VAT included) — a partial rounding drift cannot commit;
--   * duplicate-submission protection: UNIQUE (tenant, branch, idempotencyKey) + stored request fingerprint (decided by the service);
--   * a line / leg can only be added in the transaction that created its header (postedTxid); FORCE RLS tenant + branch.
-- Return numbers share the frozen company CREDIT_NOTE counter (a walk-in return IS a credit note in tax terms) — whether that is the right legal numbering
-- (and what KSA e-invoicing needs) is an open accountant / tax item (A-14), not decided here.

CREATE TABLE "sale_return" (
  "id"                 UUID           NOT NULL DEFAULT uuidv7(),
  "tenantId"           UUID           NOT NULL,
  "companyId"          UUID           NOT NULL,
  "branchId"           UUID           NOT NULL,
  "orderId"            UUID           NOT NULL,
  "invoiceId"          UUID           NOT NULL,
  "returnNumber"       TEXT           NOT NULL,
  "idempotencyKey"     TEXT           NOT NULL,
  "requestFingerprint" TEXT           NOT NULL,
  "accountingDate"     DATE           NOT NULL,
  "currencyCode"       TEXT           NOT NULL,
  "currencyExponent"   SMALLINT       NOT NULL,
  "reasonCode"         TEXT           NOT NULL,
  "note"               VARCHAR(255),
  "lineCount"          INTEGER        NOT NULL,
  "subtotalAmountMinor" BIGINT        NOT NULL,
  "taxTotalAmountMinor" BIGINT        NOT NULL,
  "totalAmountMinor"   BIGINT         NOT NULL,
  "approvedByUserId"   UUID,
  "postedTxid"         BIGINT         NOT NULL DEFAULT txid_current(),
  "createdByUserId"    UUID,
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sale_return_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sale_return_tenant_id_uq" UNIQUE ("tenantId", "id"),
  CONSTRAINT "sale_return_number_uq" UNIQUE ("tenantId", "companyId", "returnNumber"),
  CONSTRAINT "sale_return_idempotency_uq" UNIQUE ("tenantId", "branchId", "idempotencyKey"),
  CONSTRAINT "sale_return_key_chk" CHECK (length("idempotencyKey") BETWEEN 8 AND 128),
  CONSTRAINT "sale_return_fingerprint_chk" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sale_return_reason_chk" CHECK ("reasonCode" IN ('CUSTOMER_REQUEST','DUPLICATE','PRICING_ERROR','DAMAGED','SERVICE_NOT_DELIVERED','ORDER_ERROR','OTHER')),
  CONSTRAINT "sale_return_lines_chk" CHECK ("lineCount" BETWEEN 1 AND 200),
  CONSTRAINT "sale_return_amounts_chk" CHECK ("subtotalAmountMinor" >= 0 AND "taxTotalAmountMinor" >= 0 AND "totalAmountMinor" > 0 AND "taxTotalAmountMinor" <= "totalAmountMinor"),
  CONSTRAINT "sale_return_company_fk" FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_return_invoice_fk" FOREIGN KEY ("tenantId", "companyId", "branchId", "invoiceId") REFERENCES "invoice"("tenantId", "companyId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_return_order_fk"   FOREIGN KEY ("tenantId", "companyId", "orderId") REFERENCES "order"("tenantId", "companyId", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_return_company_currency_fk" FOREIGN KEY ("tenantId", "companyId", "currencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "sale_return_currency_pair_fk" FOREIGN KEY ("currencyCode", "currencyExponent")
    REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "sale_return_invoice_idx" ON "sale_return" ("tenantId", "invoiceId");
CREATE INDEX "sale_return_branch_idx" ON "sale_return" ("tenantId", "branchId", "createdAt");

CREATE TABLE "sale_return_line" (
  "id"                 UUID           NOT NULL DEFAULT uuidv7(),
  "tenantId"           UUID           NOT NULL,
  "companyId"          UUID           NOT NULL,
  "returnId"           UUID           NOT NULL,
  "lineNo"             INTEGER        NOT NULL,
  "orderLineId"        UUID           NOT NULL,
  "variantId"          UUID           NOT NULL,
  -- quantities in the order line's SELECTED unit (the unit the customer bought in); restock + waste = returned
  "quantityReturned"   NUMERIC(18,4)  NOT NULL,
  "restockQuantity"    NUMERIC(18,4)  NOT NULL,
  "wasteQuantity"      NUMERIC(18,4)  NOT NULL,
  "wasteReasonCode"    TEXT,
  -- how stock was touched: NONE (company without a locked costing method, or the line was never deducted), STOCKED (ledger reversal), BOM (components)
  "stockMode"          TEXT           NOT NULL,
  -- the credited amounts — the frozen credit-note components, proportional with the final residual taking the exact remainder
  "grossCreditedMinor"                    BIGINT NOT NULL,
  "discountCreditedMinor"                 BIGINT NOT NULL,
  "documentDiscountShareCreditedMinor"    BIGINT NOT NULL,
  "netAfterDocumentDiscountCreditedMinor" BIGINT NOT NULL,
  "taxCreditedMinor"                      BIGINT NOT NULL,
  "lineTotalCreditedMinor"                BIGINT NOT NULL,
  CONSTRAINT "sale_return_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sale_return_line_no_uq" UNIQUE ("returnId", "lineNo"),
  CONSTRAINT "sale_return_line_order_line_uq" UNIQUE ("returnId", "orderLineId"),
  CONSTRAINT "sale_return_line_chk" CHECK (
        "lineNo" > 0 AND "quantityReturned" > 0 AND "restockQuantity" >= 0 AND "wasteQuantity" >= 0
    AND "restockQuantity" + "wasteQuantity" = "quantityReturned"
    AND (("wasteQuantity" > 0) = ("wasteReasonCode" IS NOT NULL))
    AND ("wasteReasonCode" IS NULL OR "wasteReasonCode" IN ('DAMAGED','WASTAGE'))
    AND "stockMode" IN ('NONE','STOCKED','BOM')),
  CONSTRAINT "sale_return_line_amounts_chk" CHECK (
        "grossCreditedMinor" >= 0 AND "discountCreditedMinor" >= 0 AND "documentDiscountShareCreditedMinor" >= 0
    AND "netAfterDocumentDiscountCreditedMinor" >= 0 AND "taxCreditedMinor" >= 0 AND "lineTotalCreditedMinor" >= 0
    AND "netAfterDocumentDiscountCreditedMinor" = "grossCreditedMinor" - "discountCreditedMinor" - "documentDiscountShareCreditedMinor"),
  CONSTRAINT "sale_return_line_return_fk" FOREIGN KEY ("tenantId", "returnId") REFERENCES "sale_return"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_return_line_order_line_fk" FOREIGN KEY ("tenantId", "orderLineId") REFERENCES "order_line"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_return_line_variant_fk" FOREIGN KEY ("tenantId", "variantId") REFERENCES "variant"("tenantId", "id") ON DELETE RESTRICT
);
CREATE INDEX "sale_return_line_order_line_idx" ON "sale_return_line" ("tenantId", "orderLineId");

CREATE TABLE "sale_return_refund" (
  "id"               UUID           NOT NULL DEFAULT uuidv7(),
  "tenantId"         UUID           NOT NULL,
  "companyId"        UUID           NOT NULL,
  "branchId"         UUID           NOT NULL,
  "returnId"         UUID           NOT NULL,
  "legNo"            INTEGER        NOT NULL,
  "sourcePaymentId"  UUID           NOT NULL,
  "method"           TEXT           NOT NULL,
  "amountMinor"      BIGINT         NOT NULL,
  "currencyCode"     TEXT           NOT NULL,
  "currencyExponent" SMALLINT       NOT NULL,
  CONSTRAINT "sale_return_refund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sale_return_refund_leg_uq" UNIQUE ("returnId", "legNo"),
  CONSTRAINT "sale_return_refund_chk" CHECK ("legNo" > 0 AND "amountMinor" > 0 AND "method" IN ('CASH','CARD_TERMINAL','BANK_TRANSFER','OTHER_MANUAL')),
  CONSTRAINT "sale_return_refund_return_fk" FOREIGN KEY ("tenantId", "returnId") REFERENCES "sale_return"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_return_refund_payment_fk" FOREIGN KEY ("tenantId", "companyId", "branchId", "sourcePaymentId") REFERENCES "payment"("tenantId", "companyId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "sale_return_refund_currency_pair_fk" FOREIGN KEY ("currencyCode", "currencyExponent")
    REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "sale_return_refund_payment_idx" ON "sale_return_refund" ("tenantId", "sourcePaymentId");

-- ═════════════════════════════ guards ═════════════════════════════
CREATE FUNCTION fn_sale_return_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is never permitted (correct a return with a later return, never by editing history)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER trg_sale_return_append_only BEFORE UPDATE OR DELETE ON "sale_return" FOR EACH ROW EXECUTE FUNCTION fn_sale_return_append_only();
CREATE TRIGGER trg_sale_return_line_append_only BEFORE UPDATE OR DELETE ON "sale_return_line" FOR EACH ROW EXECUTE FUNCTION fn_sale_return_append_only();
CREATE TRIGGER trg_sale_return_refund_append_only BEFORE UPDATE OR DELETE ON "sale_return_refund" FOR EACH ROW EXECUTE FUNCTION fn_sale_return_append_only();

-- header: ONE invoice of an ANONYMOUS order, paid in full, in this branch
CREATE FUNCTION fn_sale_return_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o RECORD; i RECORD;
BEGIN
  SELECT "customerId", "originBranchId" INTO o FROM "order" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."orderId";
  IF NOT FOUND THEN RAISE EXCEPTION 'SALE_RETURN_ORDER_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF o."customerId" IS NOT NULL THEN
    RAISE EXCEPTION 'SALE_RETURN_CUSTOMER_SALE_NOT_SUPPORTED: a customer-linked sale returns through the credit-note / advance / refund chain' USING ERRCODE = 'P0001';
  END IF;
  SELECT "orderId", "invoicePaymentStatus", "currencyCode" INTO i FROM "invoice" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."invoiceId" FOR SHARE;
  IF NOT FOUND OR i."orderId" <> NEW."orderId" THEN RAISE EXCEPTION 'SALE_RETURN_INVOICE_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  IF i."invoicePaymentStatus" NOT IN ('PAID','SETTLED') THEN
    RAISE EXCEPTION 'SALE_RETURN_INVOICE_NOT_PAID: only a fully paid invoice can be returned (status %)', i."invoicePaymentStatus" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sale_return_header_guard BEFORE INSERT ON "sale_return" FOR EACH ROW EXECUTE FUNCTION fn_sale_return_header_guard();

-- line: only in the creating transaction; the order line is locked and the cumulative returned quantity can never exceed what was sold
CREATE FUNCTION fn_sale_return_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  h RECORD; ol RECORD; prior NUMERIC;
BEGIN
  SELECT "orderId", "postedTxid" INTO h FROM "sale_return" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."returnId";
  IF NOT FOUND OR h."postedTxid" <> txid_current() THEN
    RAISE EXCEPTION 'a posted return cannot receive more lines' USING ERRCODE = 'P0001';
  END IF;
  SELECT "orderId", "variantId", "quantity" INTO ol FROM "order_line" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."orderLineId" FOR UPDATE;
  IF NOT FOUND OR ol."orderId" <> h."orderId" OR ol."variantId" <> NEW."variantId" THEN
    RAISE EXCEPTION 'SALE_RETURN_LINE_NOT_ON_ORDER' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum("quantityReturned"), 0) INTO prior FROM "sale_return_line" WHERE "tenantId" = NEW."tenantId" AND "orderLineId" = NEW."orderLineId";
  IF prior + NEW."quantityReturned" > ol."quantity" THEN
    RAISE EXCEPTION 'RETURN_EXCEEDS_SOLD: returned % + % exceeds the % sold', prior, NEW."quantityReturned", ol."quantity" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sale_return_line_guard BEFORE INSERT ON "sale_return_line" FOR EACH ROW EXECUTE FUNCTION fn_sale_return_line_guard();

-- refund leg: only in the creating transaction; the payment is locked, paid THIS invoice, by the same method, and its legs never exceed it
CREATE FUNCTION fn_sale_return_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  h RECORD; p RECORD; prior BIGINT; alloc INTEGER;
BEGIN
  SELECT "invoiceId", "branchId", "currencyCode", "postedTxid" INTO h FROM "sale_return" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."returnId";
  IF NOT FOUND OR h."postedTxid" <> txid_current() THEN
    RAISE EXCEPTION 'a posted return cannot receive more refund legs' USING ERRCODE = 'P0001';
  END IF;
  SELECT "method", "amountMinor", "currencyCode", "branchId" INTO p FROM "payment" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."sourcePaymentId" FOR UPDATE;
  IF NOT FOUND OR p."branchId" <> h."branchId" OR p."method" <> NEW."method" OR p."currencyCode" <> NEW."currencyCode" OR NEW."currencyCode" <> h."currencyCode" THEN
    RAISE EXCEPTION 'SALE_RETURN_REFUND_SCOPE: a refund leg must go back to a payment of this branch, by the same method and currency' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO alloc FROM "payment_allocation" WHERE "tenantId" = NEW."tenantId" AND "paymentId" = NEW."sourcePaymentId" AND "invoiceId" = h."invoiceId";
  IF alloc = 0 THEN
    RAISE EXCEPTION 'SALE_RETURN_REFUND_PAYMENT_NOT_ON_INVOICE: that payment did not pay this invoice' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum("amountMinor"), 0) INTO prior FROM "sale_return_refund" WHERE "tenantId" = NEW."tenantId" AND "sourcePaymentId" = NEW."sourcePaymentId";
  IF prior + NEW."amountMinor" > p."amountMinor" THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_PAYMENT: refunded % + % exceeds the % paid', prior, NEW."amountMinor", p."amountMinor" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sale_return_refund_guard BEFORE INSERT ON "sale_return_refund" FOR EACH ROW EXECUTE FUNCTION fn_sale_return_refund_guard();

-- ═════════ at COMMIT: header = lines, refunds = total, a fully returned order equals its invoice to the minor unit ═════════
CREATE FUNCTION fn_sale_return_check(p_tenant UUID, p_return UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  h RECORD; n INTEGER; sub BIGINT; tax BIGINT; tot BIGINT; refunds BIGINT; inv RECORD; open_lines INTEGER; cum_total BIGINT; cum_tax BIGINT;
BEGIN
  SELECT * INTO h FROM "sale_return" WHERE "tenantId" = p_tenant AND "id" = p_return;
  SELECT count(*), coalesce(sum("netAfterDocumentDiscountCreditedMinor"), 0), coalesce(sum("taxCreditedMinor"), 0), coalesce(sum("lineTotalCreditedMinor"), 0)
    INTO n, sub, tax, tot FROM "sale_return_line" WHERE "tenantId" = p_tenant AND "returnId" = p_return;
  IF n <> h."lineCount" OR sub <> h."subtotalAmountMinor" OR tax <> h."taxTotalAmountMinor" OR tot <> h."totalAmountMinor" THEN
    RAISE EXCEPTION 'SALE_RETURN_TOTAL_MISMATCH: header (% lines / % / % / %) <> lines (% / % / % / %)',
      h."lineCount", h."subtotalAmountMinor", h."taxTotalAmountMinor", h."totalAmountMinor", n, sub, tax, tot USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum("amountMinor"), 0) INTO refunds FROM "sale_return_refund" WHERE "tenantId" = p_tenant AND "returnId" = p_return;
  IF refunds <> h."totalAmountMinor" THEN
    RAISE EXCEPTION 'SALE_RETURN_REFUND_MISMATCH: refund legs % <> return total %', refunds, h."totalAmountMinor" USING ERRCODE = 'P0001';
  END IF;
  SELECT "totalAmountMinor", "taxTotalAmountMinor" INTO inv FROM "invoice" WHERE "tenantId" = p_tenant AND "id" = h."invoiceId";
  SELECT coalesce(sum("totalAmountMinor"), 0), coalesce(sum("taxTotalAmountMinor"), 0) INTO cum_total, cum_tax FROM "sale_return" WHERE "tenantId" = p_tenant AND "invoiceId" = h."invoiceId";
  IF cum_total > inv."totalAmountMinor" OR cum_tax > inv."taxTotalAmountMinor" THEN
    RAISE EXCEPTION 'RETURN_EXCEEDS_INVOICE: credited % / tax % exceed the invoice % / %', cum_total, cum_tax, inv."totalAmountMinor", inv."taxTotalAmountMinor" USING ERRCODE = 'P0001';
  END IF;
  -- when EVERY line of the order has been returned in full, the credited money equals the invoice exactly (no rounding residue anywhere)
  SELECT count(*) INTO open_lines FROM "order_line" ol
   WHERE ol."tenantId" = p_tenant AND ol."orderId" = h."orderId"
     AND (SELECT coalesce(sum(l."quantityReturned"), 0) FROM "sale_return_line" l WHERE l."tenantId" = p_tenant AND l."orderLineId" = ol."id") <> ol."quantity";
  IF open_lines = 0 AND (cum_total <> inv."totalAmountMinor" OR cum_tax <> inv."taxTotalAmountMinor") THEN
    RAISE EXCEPTION 'RETURN_RESIDUE: the order is fully returned but the credited money (% / tax %) differs from the invoice (% / %)', cum_total, cum_tax, inv."totalAmountMinor", inv."taxTotalAmountMinor" USING ERRCODE = 'P0001';
  END IF;
END $$;
CREATE FUNCTION fn_sale_return_check_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'sale_return' THEN
    PERFORM fn_sale_return_check(NEW."tenantId", NEW."id");
  ELSE
    PERFORM fn_sale_return_check(NEW."tenantId", NEW."returnId");
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_sale_return_check AFTER INSERT ON "sale_return" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_sale_return_check_row();
CREATE CONSTRAINT TRIGGER trg_sale_return_line_check AFTER INSERT ON "sale_return_line" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_sale_return_check_row();
CREATE CONSTRAINT TRIGGER trg_sale_return_refund_check AFTER INSERT ON "sale_return_refund" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_sale_return_check_row();

-- ═════════════════════════════ RLS: tenant + branch ═════════════════════════════
ALTER TABLE "sale_return" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sale_return_tenant_branch_isolation" ON "sale_return"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND (nullif(current_setting('app.branch_id', true), '') IS NULL OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid))
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND (nullif(current_setting('app.branch_id', true), '') IS NULL OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid));
ALTER TABLE "sale_return" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sale_return_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sale_return_line_tenant_branch_isolation" ON "sale_return_line"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND EXISTS (SELECT 1 FROM "sale_return" r WHERE r."tenantId" = "sale_return_line"."tenantId" AND r."id" = "sale_return_line"."returnId"))
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND EXISTS (SELECT 1 FROM "sale_return" r WHERE r."tenantId" = "sale_return_line"."tenantId" AND r."id" = "sale_return_line"."returnId"));
ALTER TABLE "sale_return_line" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sale_return_refund" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sale_return_refund_tenant_branch_isolation" ON "sale_return_refund"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND EXISTS (SELECT 1 FROM "sale_return" r WHERE r."tenantId" = "sale_return_refund"."tenantId" AND r."id" = "sale_return_refund"."returnId"))
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND EXISTS (SELECT 1 FROM "sale_return" r WHERE r."tenantId" = "sale_return_refund"."tenantId" AND r."id" = "sale_return_refund"."returnId"));
ALTER TABLE "sale_return_refund" FORCE ROW LEVEL SECURITY;

-- ═════════════════════════════ grants ═════════════════════════════
GRANT ALL ON "sale_return", "sale_return_line", "sale_return_refund" TO flower_migrate;
GRANT SELECT, INSERT ON "sale_return", "sale_return_line", "sale_return_refund" TO flower_app, flower_platform;
REVOKE UPDATE, DELETE ON "sale_return", "sale_return_line", "sale_return_refund" FROM flower_app, flower_platform;
