-- Phase 3b task 3b.6 CHECKPOINT B (B12/B13) — CustomerCompanyAccount
-- persisted projection columns, and the Invoice immutability-trigger
-- narrowing that finally lets `invoicePaymentStatus` change (Task 3b.3's own
-- doc comment already promised "derivation logic is Task 3b.6's" — the
-- Checkpoint A trigger blocked EVERY Invoice UPDATE unconditionally, which
-- was a genuine integration defect against that promise).
--
-- NO service/repository/controller/PostingEngine/audit/outbox/realtime code
-- anywhere in this migration. Additive, forward-only.

-- ══════════════ B12 — CustomerCompanyAccount projections ════════════════════
-- NEVER authoritative — derived from the append-only subledger, maintained
-- transactionally by application code in a LATER checkpoint. No direct
-- public mutation path exists anywhere yet (no controller/repository method
-- in this or any prior checkpoint touches these two columns). DEFAULT 0 so
-- every existing 3b.2 row backfills safely with zero behavior change.
ALTER TABLE "customer_company_account"
  ADD COLUMN "currentOutstandingMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "advanceBalanceMinor"     BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "customer_company_account"
  ADD CONSTRAINT "customer_company_account_outstanding_nonneg_chk" CHECK ("currentOutstandingMinor" >= 0),
  ADD CONSTRAINT "customer_company_account_advance_balance_nonneg_chk" CHECK ("advanceBalanceMinor" >= 0);

-- ══════════════ B13 — Invoice immutability: narrow to invoicePaymentStatus
-- ONLY ═════════════════════════════════════════════════════════════════════
-- Mirrors the exact extend-in-a-later-migration technique already used by
-- 3b.5's own Checkpoint F (`20260925120000_payments_webhook_inbox_routing`
-- extending `fn_enforce_provider_payment_event_transition`) and by this
-- checkpoint's own `20260927120000_receivables_payment_attempt_target_evolution`
-- (extending `fn_enforce_payment_attempt_immutable_and_transition`) — `CREATE
-- OR REPLACE FUNCTION` here redefines Task 3b.3 Checkpoint A's
-- `fn_enforce_invoice_no_update` body going forward; the frozen migration file
-- itself is untouched on disk. Every column except `invoicePaymentStatus` is
-- still fully immutable — a same-value write to `invoicePaymentStatus` is
-- harmless (`IS NOT DISTINCT FROM`), matching the null-safe comparison
-- convention used by every other immutability trigger in this schema.
CREATE OR REPLACE FUNCTION fn_enforce_invoice_no_update() RETURNS trigger AS $$
BEGIN
  IF NOT (
    NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."orderId" IS NOT DISTINCT FROM OLD."orderId"
    AND NEW."invoiceNumber" IS NOT DISTINCT FROM OLD."invoiceNumber"
    AND NEW."issuedAt" IS NOT DISTINCT FROM OLD."issuedAt"
    AND NEW."invoiceDate" IS NOT DISTINCT FROM OLD."invoiceDate"
    AND NEW."customerDisplayNameSnapshot" IS NOT DISTINCT FROM OLD."customerDisplayNameSnapshot"
    AND NEW."currencyCode" IS NOT DISTINCT FROM OLD."currencyCode"
    AND NEW."currencyExponent" IS NOT DISTINCT FROM OLD."currencyExponent"
    AND NEW."subtotalAmountMinor" IS NOT DISTINCT FROM OLD."subtotalAmountMinor"
    AND NEW."documentDiscountAmountMinor" IS NOT DISTINCT FROM OLD."documentDiscountAmountMinor"
    AND NEW."taxTotalAmountMinor" IS NOT DISTINCT FROM OLD."taxTotalAmountMinor"
    AND NEW."totalAmountMinor" IS NOT DISTINCT FROM OLD."totalAmountMinor"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'invoice %: only invoicePaymentStatus may change — every other field is immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- NOTE: `invoice_payment_status_chk` (the ADR-0019 §2 closed vocabulary) was
-- already added by Task 3b.3's own `20260920120000_orders_invoice_numbering`
-- migration — confirmed by direct inspection, not re-added here. The actual
-- transition-graph policy (which value may follow which) is the pure-domain
-- `invoice-payment-status.ts` module's job (Checkpoint A), applied by a later
-- checkpoint's application code — this migration only unblocks the column at
-- the DB level.
