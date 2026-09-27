-- Phase 3b task 3b.6 CHECKPOINT B (B5/B6/B7) — relaxes the frozen 3b.5
-- `payment_allocation` 1:1-per-Payment cardinality to a fan-out, closes the
-- same-branch structural gap against `invoice`, and wires the concurrency-
-- safe invoice-coverage + payment-capacity backstops (the shared helper
-- functions created in the PRIOR migration `20260927130000_receivables_core_schema`).
--
-- NO service/repository/controller/PostingEngine/audit/outbox/realtime code
-- anywhere in this migration. Additive, forward-only. Never edits
-- `20260923120000_payments_core` on disk.

-- ══════════════ B5 — fan-out: drop the 3b.5 1:1 uniqueness ══════════════════
DROP INDEX "payment_allocation_paymentId_key";
CREATE INDEX "payment_allocation_paymentId_idx" ON "payment_allocation"("paymentId");

-- ══════════════ B6 — Invoice composite unique + branch-safe FK ═════════════
-- The `(tenantId, companyId, branchId, id)` unique target was created one
-- migration earlier (`20260927130000_receivables_core_schema`, needed there
-- by `customer_receivable`'s own composite FK) — reused here for
-- `payment_allocation`'s own branch-safe FK, B6's actual scope: proves
-- `payment_allocation.branchId` = the Invoice's OWN branchId (previously only
-- application/trigger-enforced, never a genuine FK backstop).
ALTER TABLE "payment_allocation" DROP CONSTRAINT "payment_allocation_invoice_tenant_company_fkey";
ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "payment_allocation_invoice_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "invoiceId")
    REFERENCES "invoice"("tenantId", "companyId", "branchId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ══════════════ B7/B14 — extend the EXISTING B trigger to lock+validate
-- invoice coverage (Invoice tier) THEN payment capacity (Payment tier) —
-- canonical order (B15), matching every other Checkpoint-B trigger path ═════
-- Every prior structural check in `fn_check_payment_allocation_integrity` is
-- preserved verbatim (payment match, then invoice match/branch/currency);
-- only the two `PERFORM` calls are appended at the end, in Invoice-then-
-- Payment order.
CREATE OR REPLACE FUNCTION fn_check_payment_allocation_integrity() RETURNS trigger AS $$
DECLARE
  p   RECORD;
  inv RECORD;
BEGIN
  SELECT * INTO p FROM "payment" WHERE "id" = NEW."paymentId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_allocation %: referenced paymentId % does not exist', NEW."id", NEW."paymentId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM p."tenantId"
     OR NEW."companyId" IS DISTINCT FROM p."companyId"
     OR NEW."branchId" IS DISTINCT FROM p."branchId"
  THEN
    RAISE EXCEPTION 'payment_allocation %: does not match its Payment % (scope)', NEW."id", NEW."paymentId";
  END IF;
  IF NEW."currencyCode" IS DISTINCT FROM p."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM p."currencyExponent" THEN
    RAISE EXCEPTION 'payment_allocation %: currency does not match its Payment %', NEW."id", NEW."paymentId";
  END IF;

  SELECT * INTO inv FROM "invoice" WHERE "id" = NEW."invoiceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_allocation %: referenced invoiceId % does not exist', NEW."id", NEW."invoiceId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM inv."tenantId" OR NEW."companyId" IS DISTINCT FROM inv."companyId" THEN
    RAISE EXCEPTION 'payment_allocation %: invoiceId % does not belong to the same tenant/company', NEW."id", NEW."invoiceId";
  END IF;
  IF NEW."branchId" IS DISTINCT FROM inv."branchId" THEN
    RAISE EXCEPTION 'payment_allocation %: branchId does not match invoice %''s branchId', NEW."id", NEW."invoiceId";
  END IF;
  IF NEW."currencyCode" IS DISTINCT FROM inv."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM inv."currencyExponent" THEN
    RAISE EXCEPTION 'payment_allocation %: currency does not match invoice %', NEW."id", NEW."invoiceId";
  END IF;

  -- B14/B7 concurrency-safe backstops, canonical order: Invoice tier first,
  -- then Payment tier (B15) — never the reverse.
  PERFORM fn_lock_and_validate_invoice_coverage(NEW."invoiceId", NEW."amountMinor");
  PERFORM fn_lock_and_validate_payment_capacity(NEW."paymentId", NEW."amountMinor");

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- NOTE: the 3b.5-frozen `payment_allocation_amount_positive_chk` (`amountMinor
-- > 0`) already covers the "no zero/negative allocation" invariant — no
-- change needed. The 3b.5-frozen exact-full-Payment-amount rule this trigger
-- used to imply (1:1, amount == Payment.amountMinor) is gone by construction:
-- the fan-out removes that assumption, and the capacity backstop above is its
-- replacement (sum of allocations + advances <= Payment.amountMinor).
