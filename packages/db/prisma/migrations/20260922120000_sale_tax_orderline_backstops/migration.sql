-- Phase 3b task 3b.4 CHECKPOINT E — finalized OrderLine tax-field DB
-- backstops (§E1). Additive, forward-only, a NEW migration after
-- Checkpoint C's `20260921120000_sale_tax_fiscal_policy_v1v2` — never
-- rewriting it or the original 3b.3
-- `20260920120000_orders_invoice_numbering` migration.
--
-- `order_line.priceTaxMode`/`roundingScope`/`roundingMode`/
-- `lineTaxAmountMinor` are the RESERVED nullable columns Task 3b.3 created
-- and never populated, and Task 3b.4 Checkpoint D's `TaxFinalizationService`
-- now writes at issuance time (via `InvoiceIssuanceRepository.
-- issueFinalInvoice`, step 7). The existing 3b.3
-- `order_line_tax_snapshot_shape_chk` (all-NULL pre-issuance OR
-- all-NOT-NULL post-issuance) is PRESERVED UNCHANGED — this migration only
-- ADDS closed-vocabulary + non-negative-range CHECKs for the NON-NULL case,
-- exactly mirroring the Order-level `taxPriceMode`/`taxRoundingScope`/
-- `taxRoundingMode` vocabulary Checkpoint C already froze (never a new
-- vocabulary). DB protects shape/vocabulary/range only — it computes no
-- tax formula, exactly like every other CHECK in this schema.
ALTER TABLE "order_line"
  ADD CONSTRAINT "order_line_price_tax_mode_chk" CHECK (
    "priceTaxMode" IS NULL OR "priceTaxMode" IN ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE')
  ),
  ADD CONSTRAINT "order_line_rounding_scope_chk" CHECK (
    "roundingScope" IS NULL OR "roundingScope" IN ('LINE', 'DOCUMENT')
  ),
  ADD CONSTRAINT "order_line_rounding_mode_chk" CHECK (
    "roundingMode" IS NULL
    OR "roundingMode" IN ('HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'HALF_DOWN')
  ),
  ADD CONSTRAINT "order_line_line_tax_amount_nonneg_chk" CHECK (
    "lineTaxAmountMinor" IS NULL OR "lineTaxAmountMinor" >= 0
  );
