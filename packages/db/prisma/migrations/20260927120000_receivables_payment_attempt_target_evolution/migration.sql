-- Phase 3b task 3b.6 CHECKPOINT B (B3/B4) — evolves the frozen 3b.5
-- `payment_attempt` targeting so a CUSTOMER_RECEIPT (an invoice-less
-- customer-level receipt) can exist without a fabricated Order/Invoice,
-- WITHOUT introducing a second confirmed-receipt entity (`Payment` itself is
-- completely unchanged in shape — see the next migration for the
-- allocation/capacity evolution).
--
-- NO service/repository/controller/PostingEngine/AR/Advance/audit/outbox/
-- realtime code anywhere in this migration. Additive, forward-only. Never
-- edits `20260923120000_payments_core` on disk — `CREATE OR REPLACE FUNCTION`
-- below only redefines that migration's trigger FUNCTION body going forward
-- (the same technique already used by 3b.5's own Checkpoint F migration
-- `20260925120000_payments_webhook_inbox_routing` to extend
-- `fn_enforce_provider_payment_event_transition`).
--
-- ══════════════ receiptPurpose — closed XOR vocabulary ══════════════════════
-- Every existing 3b.5 row backfills deterministically to INVOICE_COLLECTION
-- (the column DEFAULT applies to existing rows on ADD COLUMN) — its
-- orderId/targetInvoiceId/snapshot fields are already NOT NULL and its new
-- customerCompanyAccountId is NULL (new column, no default), so it already
-- satisfies the INVOICE_COLLECTION branch of the shape CHECK below with zero
-- backfill statement needed.
ALTER TABLE "payment_attempt"
  ADD COLUMN "receiptPurpose" TEXT NOT NULL DEFAULT 'INVOICE_COLLECTION',
  ADD COLUMN "customerCompanyAccountId" UUID,
  ALTER COLUMN "orderId" DROP NOT NULL,
  ALTER COLUMN "targetInvoiceId" DROP NOT NULL,
  ALTER COLUMN "orderCommercialSnapshotFingerprintAtCreation" DROP NOT NULL,
  ALTER COLUMN "orderVersionAtCreation" DROP NOT NULL;

ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_receipt_purpose_chk" CHECK ("receiptPurpose" IN
    ('INVOICE_COLLECTION', 'CUSTOMER_RECEIPT'));

-- Structural XOR (B3): INVOICE_COLLECTION requires every order/invoice
-- attribute NOT NULL and customerCompanyAccountId NULL; CUSTOMER_RECEIPT
-- requires the exact opposite. A composite FK against a NULL component column
-- is trivially satisfied (Postgres MATCH SIMPLE), so the EXISTING
-- `payment_attempt_target_invoice_order_fkey` / `payment_attempt_order_tenant_company_fkey`
-- composite FKs need no change at all for a CUSTOMER_RECEIPT row.
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_receipt_purpose_shape_chk" CHECK (
    ("receiptPurpose" = 'INVOICE_COLLECTION'
      AND "orderId" IS NOT NULL
      AND "targetInvoiceId" IS NOT NULL
      AND "orderCommercialSnapshotFingerprintAtCreation" IS NOT NULL
      AND "orderVersionAtCreation" IS NOT NULL
      AND "customerCompanyAccountId" IS NULL)
    OR
    ("receiptPurpose" = 'CUSTOMER_RECEIPT'
      AND "orderId" IS NULL
      AND "targetInvoiceId" IS NULL
      AND "orderCommercialSnapshotFingerprintAtCreation" IS NULL
      AND "orderVersionAtCreation" IS NULL
      AND "customerCompanyAccountId" IS NOT NULL)
  );

-- ══════════════ customer_company_account — additive FK target ══════════════
-- `customer_company_account` had no tenant+company-safe composite unique key
-- at all (only `(tenantId, companyId, customerId)`) — the smallest additive
-- index needed for a genuine composite FK from `payment_attempt` (and the
-- next migration's `customer_receivable`/`customer_advance`/
-- `customer_account_entry`). This account remains COMPANY-scoped, never
-- branch-scoped (3b.6 architecture-freeze) — no branchId column is added.
CREATE UNIQUE INDEX "customer_company_account_tenantId_companyId_id_key"
  ON "customer_company_account"("tenantId", "companyId", "id");

ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_customerCompanyAccountId_fkey"
    FOREIGN KEY ("customerCompanyAccountId") REFERENCES "customer_company_account"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_customer_company_account_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerCompanyAccountId")
    REFERENCES "customer_company_account"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

CREATE INDEX "payment_attempt_customerCompanyAccountId_idx"
  ON "payment_attempt"("customerCompanyAccountId");

-- ══════════════ immutability — extend the EXISTING B trigger to also
-- protect the 2 new columns ══════════════════════════════════════════════
-- `fn_enforce_payment_attempt_immutable_and_transition` is an EXPLICIT
-- column-by-column comparison — a new column added without updating it would
-- NOT be protected. Every prior comparison line is preserved verbatim; only
-- `receiptPurpose`/`customerCompanyAccountId` are appended, and the
-- now-nullable columns already use the NULL-safe `IS NOT DISTINCT FROM`
-- operator, so no other line needs to change.
CREATE OR REPLACE FUNCTION fn_enforce_payment_attempt_immutable_and_transition() RETURNS trigger AS $$
BEGIN
  IF NOT (
    NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."orderId" IS NOT DISTINCT FROM OLD."orderId"
    AND NEW."targetInvoiceId" IS NOT DISTINCT FROM OLD."targetInvoiceId"
    AND NEW."receiptPurpose" IS NOT DISTINCT FROM OLD."receiptPurpose"
    AND NEW."customerCompanyAccountId" IS NOT DISTINCT FROM OLD."customerCompanyAccountId"
    AND NEW."paymentGroupId" IS NOT DISTINCT FROM OLD."paymentGroupId"
    AND NEW."method" IS NOT DISTINCT FROM OLD."method"
    AND NEW."providerKey" IS NOT DISTINCT FROM OLD."providerKey"
    AND NEW."providerCredentialId" IS NOT DISTINCT FROM OLD."providerCredentialId"
    AND NEW."amountMinor" IS NOT DISTINCT FROM OLD."amountMinor"
    AND NEW."currencyCode" IS NOT DISTINCT FROM OLD."currencyCode"
    AND NEW."currencyExponent" IS NOT DISTINCT FROM OLD."currencyExponent"
    AND NEW."orderCommercialSnapshotFingerprintAtCreation" IS NOT DISTINCT FROM OLD."orderCommercialSnapshotFingerprintAtCreation"
    AND NEW."orderVersionAtCreation" IS NOT DISTINCT FROM OLD."orderVersionAtCreation"
    AND NEW."idempotencyKey" IS NOT DISTINCT FROM OLD."idempotencyKey"
    AND NEW."createdByUserId" IS NOT DISTINCT FROM OLD."createdByUserId"
    AND NEW."actingUserId" IS NOT DISTINCT FROM OLD."actingUserId"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'payment_attempt %: creation-time attributes are immutable — only state/providerReference/updatedAt may change', OLD."id";
  END IF;

  IF OLD."state" IS DISTINCT FROM NEW."state" THEN
    IF NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('PENDING', 'REQUIRES_ACTION'), ('PENDING', 'AUTHORIZED'), ('PENDING', 'CAPTURED'),
        ('PENDING', 'FAILED'), ('PENDING', 'CANCELED'),
        ('REQUIRES_ACTION', 'AUTHORIZED'), ('REQUIRES_ACTION', 'CAPTURED'),
        ('REQUIRES_ACTION', 'FAILED'), ('REQUIRES_ACTION', 'CANCELED'),
        ('AUTHORIZED', 'CAPTURED')
      ) AS t("fromState", "toState")
      WHERE t."fromState" = OLD."state" AND t."toState" = NEW."state"
    ) THEN
      RAISE EXCEPTION 'payment_attempt %: illegal state transition % -> %', OLD."id", OLD."state", NEW."state";
    END IF;
  END IF;

  IF OLD."providerReference" IS DISTINCT FROM NEW."providerReference" THEN
    IF OLD."providerReference" IS NOT NULL THEN
      RAISE EXCEPTION 'payment_attempt %: providerReference is set-once — it cannot change from % to %', OLD."id", OLD."providerReference", NEW."providerReference";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
