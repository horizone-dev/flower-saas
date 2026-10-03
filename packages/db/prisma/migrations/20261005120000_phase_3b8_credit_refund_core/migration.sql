-- Phase 3b task 3b.8 CHECKPOINT B — Cancellation / Refund / Credit Note core
-- schema (docs/phase-3 3b.8-A, permanently frozen architecture, 4 owner
-- review rounds). Schema + DB integrity ONLY — no service/controller/
-- GL-posting/projection code exists anywhere in this module set yet.
--
-- New tables: credit_note, credit_note_line, credit_note_coverage_release,
-- cancellation_charge, refund, refund_attempt,
-- refund_attempt_entitlement_reservation, customer_advance_refund_application,
-- provider_refund_event.
--
-- Widened existing tables (additive only): company (+cancellationFeeTaxCategoryKey),
-- customer_receivable (+cancellationChargeId, sourceType +CANCELLATION_CHARGE),
-- customer_advance (sourceType +CREDIT_NOTE), customer_account_entry
-- (+creditNoteId, +customerAdvanceRefundApplicationId, entryKind +3 kinds),
-- document_number_counter (documentType +CREDIT_NOTE, +CANCELLATION_CHARGE).
--
-- Extended via CREATE OR REPLACE FUNCTION (frozen migration files untouched,
-- exact technique already established by 3b.5/3b.6):
-- fn_lock_and_validate_advance_capacity, fn_check_customer_account_entry_source_type,
-- fn_check_customer_receivable_integrity.
--
-- No CoA change — `REVENUE.CANCELLATION_CHARGE` (code 4100) and
-- `LIABILITY.REFUND_PAYABLE` (code 2200) already exist in
-- `ACCOUNTING_REFERENCE_ACCOUNTS` (packages/db/src/accounting-reference-data.ts),
-- seeded by an earlier task — confirmed by direct inspection before writing
-- this migration. 3b.8-A's own repeated "REVENUE.CANCELLATION_FEE"/
-- "LIABILITY.REFUNDS_PAYABLE" naming was an architecture-report label, not
-- the actual DB key; the real key is `REVENUE.CANCELLATION_CHARGE`.
-- `LIABILITY.REFUND_PAYABLE` is NOT used by any 3b.8 posting (walk-in
-- financial reversal is blocked in initial 3b.8 — no code path needs it).
--
-- No migration 1-43 file is modified.

-- ══════════════════════ widen existing tables (additive) ════════════════════

ALTER TABLE "company" ADD COLUMN "cancellationFeeTaxCategoryKey" TEXT;
ALTER TABLE "company"
  ADD CONSTRAINT "company_cancellation_fee_tax_category_fkey"
  FOREIGN KEY ("cancellationFeeTaxCategoryKey") REFERENCES "tax_category"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_receivable" ADD COLUMN "cancellationChargeId" UUID;
ALTER TABLE "customer_account_entry"
  ADD COLUMN "creditNoteId" UUID,
  ADD COLUMN "customerAdvanceRefundApplicationId" UUID;

-- ── sourceType / documentType / entryKind CHECK widening (DROP + ADD — the
--    exact technique for widening a CHECK constraint; CREATE OR REPLACE
--    FUNCTION is reserved for trigger BODIES, never for a CHECK) ────────────
ALTER TABLE "customer_receivable" DROP CONSTRAINT "customer_receivable_source_type_chk";
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "customer_receivable_source_type_chk"
  CHECK ("sourceType" IN ('INVOICE', 'OPENING', 'CANCELLATION_CHARGE'));

ALTER TABLE "customer_advance" DROP CONSTRAINT "customer_advance_source_type_chk";
ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_source_type_chk"
  CHECK ("sourceType" IN ('PAYMENT', 'OPENING', 'CREDIT_NOTE'));

-- Widen from the ACTUAL CURRENT shape (already once-widened by Checkpoint F,
-- migration `20261002120000_receivables_opening_balance`, which added the
-- `openingEffectiveDate`/`openingNote` refinement on top of the original
-- Checkpoint B shape) — never the original Checkpoint B shape directly, to
-- avoid silently weakening the F9 opening-balance provenance requirement.
ALTER TABLE "customer_advance" DROP CONSTRAINT "customer_advance_source_shape_chk";
ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_source_shape_chk" CHECK (
    ("sourceType" = 'PAYMENT'
      AND "sourcePaymentId" IS NOT NULL
      AND "openingEffectiveDate" IS NULL
      AND "openingNote" IS NULL)
    OR
    ("sourceType" = 'OPENING'
      AND "sourcePaymentId" IS NULL
      AND "openingEffectiveDate" IS NOT NULL)
    OR
    ("sourceType" = 'CREDIT_NOTE'
      AND "sourcePaymentId" IS NULL
      AND "openingEffectiveDate" IS NULL
      AND "openingNote" IS NULL)
  );

ALTER TABLE "customer_account_entry" DROP CONSTRAINT "customer_account_entry_reference_xor_chk";
ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_reference_xor_chk" CHECK (
    ("entryKind" IN ('INVOICE', 'OPENING_RECEIVABLE', 'CANCELLATION_CHARGE')
      AND "customerReceivableId" IS NOT NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT'
      AND "paymentId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT_ALLOCATION'
      AND "paymentAllocationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL AND "customerReceivablePaymentApplicationId" IS NULL AND "creditNoteId" IS NULL AND "customerAdvanceRefundApplicationId" IS NULL)
    OR ("entryKind" = 'OPENING_RECEIVABLE_PAYMENT_APPLIED'
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

ALTER TABLE "document_number_counter" DROP CONSTRAINT "document_number_counter_document_type_chk";
ALTER TABLE "document_number_counter"
  ADD CONSTRAINT "document_number_counter_document_type_chk"
  CHECK ("documentType" IN ('ORDER', 'INVOICE', 'CREDIT_NOTE', 'CANCELLATION_CHARGE'));

-- widen the frozen INVOICE/OPENING source-shape XOR (§15 of the frozen
-- 3b.8-A architecture: "one source kind: one valid source reference shape" —
-- never weakening the existing two shapes, purely additive). Widened from
-- the ACTUAL CURRENT shape (already once-widened by Checkpoint F, migration
-- `20261002120000_receivables_opening_balance`, which added the
-- `openingEffectiveDate IS NOT NULL` requirement for OPENING and raised
-- `openingAmountMinor` from `>= 0` to `> 0`) — never the original Checkpoint
-- B shape directly.
ALTER TABLE "customer_receivable" DROP CONSTRAINT "customer_receivable_source_shape_chk";
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "customer_receivable_source_shape_chk" CHECK (
    ("sourceType" = 'INVOICE'
      AND "invoiceId" IS NOT NULL
      AND "creditAuthorized" IS NOT NULL
      AND "openingAmountMinor" IS NULL
      AND "currencyCode" IS NULL
      AND "currencyExponent" IS NULL
      AND "openingEffectiveDate" IS NULL
      AND "openingNote" IS NULL
      AND "cancellationChargeId" IS NULL)
    OR
    ("sourceType" = 'OPENING'
      AND "invoiceId" IS NULL
      AND "creditAuthorized" IS NULL
      AND "openingAmountMinor" IS NOT NULL AND "openingAmountMinor" > 0
      AND "currencyCode" IS NOT NULL
      AND "currencyExponent" IS NOT NULL
      AND "openingEffectiveDate" IS NOT NULL
      AND "cancellationChargeId" IS NULL)
    OR
    ("sourceType" = 'CANCELLATION_CHARGE'
      AND "invoiceId" IS NULL
      AND "creditAuthorized" IS NULL
      AND "openingAmountMinor" IS NULL
      AND "currencyCode" IS NULL
      AND "currencyExponent" IS NULL
      AND "openingEffectiveDate" IS NULL
      AND "openingNote" IS NULL
      AND "cancellationChargeId" IS NOT NULL)
  );

-- ══════════════════════ CreateTable — the 9 new tables ═══════════════════════

CREATE TABLE "credit_note" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL,
    "accountingDate" DATE NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" VARCHAR(255),
    "subtotalAmountMinor" BIGINT NOT NULL,
    "taxTotalAmountMinor" BIGINT NOT NULL,
    "totalAmountMinor" BIGINT NOT NULL,
    "arReductionMinor" BIGINT NOT NULL,
    "advanceExcessMinor" BIGINT NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credit_note_line" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "creditNoteId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "quantityCredited" DECIMAL(18,4) NOT NULL,
    "grossCreditedMinor" BIGINT NOT NULL,
    "discountCreditedMinor" BIGINT NOT NULL,
    "documentDiscountShareCreditedMinor" BIGINT NOT NULL,
    "netAfterDocumentDiscountCreditedMinor" BIGINT NOT NULL,
    "taxCreditedMinor" BIGINT NOT NULL,
    "lineTotalCreditedMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_line_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credit_note_coverage_release" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "creditNoteId" UUID NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourcePaymentAllocationId" UUID,
    "sourceAdvanceApplicationId" UUID,
    "sourcePaymentId" UUID,
    "releasedAmountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "customerAdvanceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_coverage_release_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cancellation_charge" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "invoiceId" UUID,
    "cancellationChargeNumber" TEXT NOT NULL,
    "netAmountMinor" BIGINT NOT NULL,
    "taxAmountMinor" BIGINT NOT NULL,
    "totalAmountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "taxCategoryKey" TEXT,
    "rateBps" INTEGER,
    "priceTaxMode" TEXT NOT NULL,
    "roundingMode" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" VARCHAR(255),
    "accountingDate" DATE NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_charge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refund" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "sourcePaymentId" UUID NOT NULL,
    "sourceRefundAttemptId" UUID,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "method" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "accountingDate" DATE NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refund_attempt" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "sourcePaymentId" UUID NOT NULL,
    "requestedAmountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "providerCredentialId" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "resultingRefundId" UUID,
    "failureCode" TEXT,
    "sanitizedFailureMetadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refund_attempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refund_attempt_entitlement_reservation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "refundAttemptId" UUID NOT NULL,
    "creditNoteCoverageReleaseId" UUID NOT NULL,
    "customerAdvanceId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_attempt_entitlement_reservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_advance_refund_application" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "customerAdvanceId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_advance_refund_application_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_refund_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "providerCredentialId" UUID NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "sanitizedMetadata" JSONB NOT NULL DEFAULT '{}',
    "refundAttemptId" UUID,
    "providerReference" TEXT,
    "targetState" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_refund_event_pkey" PRIMARY KEY ("id")
);

-- ══════════════════════ CreateIndex ══════════════════════════════════════════

CREATE INDEX "credit_note_tenantId_companyId_invoiceId_idx" ON "credit_note"("tenantId", "companyId", "invoiceId");
CREATE UNIQUE INDEX "credit_note_tenantId_id_key" ON "credit_note"("tenantId", "id");
CREATE UNIQUE INDEX "credit_note_tenantId_companyId_id_key" ON "credit_note"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "credit_note_tenantId_companyId_branchId_id_key" ON "credit_note"("tenantId", "companyId", "branchId", "id");
CREATE UNIQUE INDEX "credit_note_tenantId_companyId_creditNoteNumber_key" ON "credit_note"("tenantId", "companyId", "creditNoteNumber");

CREATE INDEX "credit_note_line_creditNoteId_idx" ON "credit_note_line"("creditNoteId");
CREATE INDEX "credit_note_line_orderLineId_idx" ON "credit_note_line"("orderLineId");
CREATE UNIQUE INDEX "credit_note_line_tenantId_id_key" ON "credit_note_line"("tenantId", "id");

-- CORRECTIVE PASS (§1) — NOT globally unique: a single PaymentAllocation /
-- CustomerAdvanceApplication may legitimately be released across several
-- separate CreditNotes over time (staged/partial credits), each releasing a
-- different portion, capped only by the source's own remaining capacity
-- (§2's release-capacity trigger). These composite-unique indexes prevent
-- only a DUPLICATE release of the SAME source inside the SAME CreditNote —
-- standard Postgres unique-index semantics already treat every NULL as
-- distinct, so no partial WHERE predicate is needed (rows from the other two
-- sourceKinds, whose column here is always NULL, never collide).
CREATE UNIQUE INDEX "credit_note_coverage_release_creditNoteId_sourcePaymentAll_key" ON "credit_note_coverage_release"("creditNoteId", "sourcePaymentAllocationId");
CREATE UNIQUE INDEX "credit_note_coverage_release_creditNoteId_sourceAdvanceApp_key" ON "credit_note_coverage_release"("creditNoteId", "sourceAdvanceApplicationId");
CREATE INDEX "credit_note_coverage_release_sourcePaymentAllocationId_idx" ON "credit_note_coverage_release"("sourcePaymentAllocationId");
CREATE INDEX "credit_note_coverage_release_sourceAdvanceApplicationId_idx" ON "credit_note_coverage_release"("sourceAdvanceApplicationId");
CREATE UNIQUE INDEX "credit_note_coverage_release_customerAdvanceId_key" ON "credit_note_coverage_release"("customerAdvanceId");
CREATE INDEX "credit_note_coverage_release_creditNoteId_idx" ON "credit_note_coverage_release"("creditNoteId");
CREATE INDEX "credit_note_coverage_release_sourcePaymentId_idx" ON "credit_note_coverage_release"("sourcePaymentId");
CREATE UNIQUE INDEX "credit_note_coverage_release_tenantId_id_key" ON "credit_note_coverage_release"("tenantId", "id");

CREATE INDEX "cancellation_charge_tenantId_companyId_orderId_idx" ON "cancellation_charge"("tenantId", "companyId", "orderId");
CREATE INDEX "cancellation_charge_invoiceId_idx" ON "cancellation_charge"("invoiceId");
CREATE UNIQUE INDEX "cancellation_charge_tenantId_id_key" ON "cancellation_charge"("tenantId", "id");
CREATE UNIQUE INDEX "cancellation_charge_tenantId_companyId_cancellationChargeNu_key" ON "cancellation_charge"("tenantId", "companyId", "cancellationChargeNumber");

CREATE UNIQUE INDEX "refund_sourceRefundAttemptId_key" ON "refund"("sourceRefundAttemptId");
CREATE INDEX "refund_sourcePaymentId_idx" ON "refund"("sourcePaymentId");
CREATE UNIQUE INDEX "refund_tenantId_id_key" ON "refund"("tenantId", "id");

CREATE UNIQUE INDEX "refund_attempt_resultingRefundId_key" ON "refund_attempt"("resultingRefundId");
CREATE INDEX "refund_attempt_sourcePaymentId_state_idx" ON "refund_attempt"("sourcePaymentId", "state");
CREATE INDEX "refund_attempt_providerCredentialId_providerReference_idx" ON "refund_attempt"("providerCredentialId", "providerReference");
CREATE UNIQUE INDEX "refund_attempt_tenantId_id_key" ON "refund_attempt"("tenantId", "id");

CREATE INDEX "refund_attempt_entitlement_reservation_refundAttemptId_idx" ON "refund_attempt_entitlement_reservation"("refundAttemptId");
CREATE INDEX "refund_attempt_entitlement_reservation_customerAdvanceId_idx" ON "refund_attempt_entitlement_reservation"("customerAdvanceId");
CREATE INDEX "refund_attempt_entitlement_reservation_creditNoteCoverageRe_idx" ON "refund_attempt_entitlement_reservation"("creditNoteCoverageReleaseId");
CREATE UNIQUE INDEX "refund_attempt_entitlement_reservation_tenantId_id_key" ON "refund_attempt_entitlement_reservation"("tenantId", "id");

CREATE INDEX "customer_advance_refund_application_customerAdvanceId_idx" ON "customer_advance_refund_application"("customerAdvanceId");
CREATE INDEX "customer_advance_refund_application_refundId_idx" ON "customer_advance_refund_application"("refundId");
CREATE UNIQUE INDEX "customer_advance_refund_application_tenantId_id_key" ON "customer_advance_refund_application"("tenantId", "id");

CREATE INDEX "provider_refund_event_tenantId_companyId_receivedAt_idx" ON "provider_refund_event"("tenantId", "companyId", "receivedAt");
CREATE INDEX "provider_refund_event_refundAttemptId_idx" ON "provider_refund_event"("refundAttemptId");
CREATE UNIQUE INDEX "provider_refund_event_providerCredentialId_providerEventId_key" ON "provider_refund_event"("providerCredentialId", "providerEventId");

CREATE UNIQUE INDEX "customer_account_entry_creditNoteId_key" ON "customer_account_entry"("creditNoteId");
CREATE UNIQUE INDEX "customer_account_entry_customerAdvanceRefundApplicationId_key" ON "customer_account_entry"("customerAdvanceRefundApplicationId");
CREATE UNIQUE INDEX "customer_receivable_cancellationChargeId_key" ON "customer_receivable"("cancellationChargeId");

-- ══════════════════════ AddForeignKey — simple + tenant-safe ═════════════════

ALTER TABLE "customer_receivable" ADD CONSTRAINT "customer_receivable_cancellationChargeId_fkey" FOREIGN KEY ("cancellationChargeId") REFERENCES "cancellation_charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_account_entry" ADD CONSTRAINT "customer_account_entry_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_account_entry" ADD CONSTRAINT "customer_account_entry_customerAdvanceRefundApplicationId_fkey" FOREIGN KEY ("customerAdvanceRefundApplicationId") REFERENCES "customer_advance_refund_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- §5 provenance backstop: CreditNote.branchId MUST equal its own target
-- Invoice's branchId exactly — composite FK against Invoice's own
-- `(tenantId, companyId, branchId, id)` unique index (the exact same
-- technique `payment_allocation_invoice_tenant_company_branch_fkey` already
-- uses).
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoice_tenant_company_branch_fkey" FOREIGN KEY ("tenantId", "companyId", "branchId", "invoiceId") REFERENCES "invoice"("tenantId", "companyId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_sourcePaymentAllocationId_fkey" FOREIGN KEY ("sourcePaymentAllocationId") REFERENCES "payment_allocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_sourceAdvanceApplicationId_fkey" FOREIGN KEY ("sourceAdvanceApplicationId") REFERENCES "customer_advance_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_sourcePaymentId_fkey" FOREIGN KEY ("sourcePaymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_note_coverage_release" ADD CONSTRAINT "credit_note_coverage_release_customerAdvanceId_fkey" FOREIGN KEY ("customerAdvanceId") REFERENCES "customer_advance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cancellation_charge" ADD CONSTRAINT "cancellation_charge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cancellation_charge" ADD CONSTRAINT "cancellation_charge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cancellation_charge" ADD CONSTRAINT "cancellation_charge_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cancellation_charge" ADD CONSTRAINT "cancellation_charge_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cancellation_charge" ADD CONSTRAINT "cancellation_charge_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund" ADD CONSTRAINT "refund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund" ADD CONSTRAINT "refund_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund" ADD CONSTRAINT "refund_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund" ADD CONSTRAINT "refund_sourcePaymentId_fkey" FOREIGN KEY ("sourcePaymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_attempt" ADD CONSTRAINT "refund_attempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_attempt" ADD CONSTRAINT "refund_attempt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_attempt" ADD CONSTRAINT "refund_attempt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_attempt" ADD CONSTRAINT "refund_attempt_sourcePaymentId_fkey" FOREIGN KEY ("sourcePaymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_attempt" ADD CONSTRAINT "refund_attempt_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_attempt_entitlement_reservation" ADD CONSTRAINT "refund_attempt_entitlement_reservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_attempt_entitlement_reservation" ADD CONSTRAINT "refund_attempt_entitlement_reservation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_attempt_entitlement_reservation" ADD CONSTRAINT "refund_attempt_entitlement_reservation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_attempt_entitlement_reservation" ADD CONSTRAINT "refund_attempt_entitlement_reservation_refundAttemptId_fkey" FOREIGN KEY ("refundAttemptId") REFERENCES "refund_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_attempt_entitlement_reservation" ADD CONSTRAINT "refund_attempt_entitlement_reservation_creditNoteCoverageR_fkey" FOREIGN KEY ("creditNoteCoverageReleaseId") REFERENCES "credit_note_coverage_release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_attempt_entitlement_reservation" ADD CONSTRAINT "refund_attempt_entitlement_reservation_customerAdvanceId_fkey" FOREIGN KEY ("customerAdvanceId") REFERENCES "customer_advance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_advance_refund_application" ADD CONSTRAINT "customer_advance_refund_application_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_advance_refund_application" ADD CONSTRAINT "customer_advance_refund_application_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_refund_application" ADD CONSTRAINT "customer_advance_refund_application_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_refund_application" ADD CONSTRAINT "customer_advance_refund_application_customerAdvanceId_fkey" FOREIGN KEY ("customerAdvanceId") REFERENCES "customer_advance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_refund_application" ADD CONSTRAINT "customer_advance_refund_application_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_refund_event" ADD CONSTRAINT "provider_refund_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_refund_event" ADD CONSTRAINT "provider_refund_event_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_refund_event" ADD CONSTRAINT "provider_refund_event_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_refund_event" ADD CONSTRAINT "provider_refund_event_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ══════════════════════ same-row CHECK constraints ═══════════════════════════

ALTER TABLE "credit_note"
  ADD CONSTRAINT "credit_note_subtotal_nonneg_chk" CHECK ("subtotalAmountMinor" >= 0),
  ADD CONSTRAINT "credit_note_tax_nonneg_chk" CHECK ("taxTotalAmountMinor" >= 0),
  ADD CONSTRAINT "credit_note_total_positive_chk" CHECK ("totalAmountMinor" > 0),
  ADD CONSTRAINT "credit_note_ar_reduction_nonneg_chk" CHECK ("arReductionMinor" >= 0),
  ADD CONSTRAINT "credit_note_advance_excess_nonneg_chk" CHECK ("advanceExcessMinor" >= 0),
  -- §9/§10 of the frozen 3b.8-A architecture — the persisted split must
  -- reconcile exactly to the document total, computed once under lock at
  -- issuance and frozen forever.
  ADD CONSTRAINT "credit_note_split_eq_total_chk" CHECK ("arReductionMinor" + "advanceExcessMinor" = "totalAmountMinor"),
  ADD CONSTRAINT "credit_note_reason_code_chk" CHECK ("reasonCode" IN (
    'CUSTOMER_REQUEST', 'DUPLICATE', 'PRICING_ERROR', 'DAMAGED',
    'SERVICE_NOT_DELIVERED', 'ORDER_ERROR', 'OTHER'
  ));

ALTER TABLE "credit_note_line"
  ADD CONSTRAINT "credit_note_line_quantity_positive_chk" CHECK ("quantityCredited" > 0),
  ADD CONSTRAINT "credit_note_line_gross_nonneg_chk" CHECK ("grossCreditedMinor" >= 0),
  ADD CONSTRAINT "credit_note_line_discount_nonneg_chk" CHECK ("discountCreditedMinor" >= 0),
  ADD CONSTRAINT "credit_note_line_doc_discount_share_nonneg_chk" CHECK ("documentDiscountShareCreditedMinor" >= 0),
  ADD CONSTRAINT "credit_note_line_tax_nonneg_chk" CHECK ("taxCreditedMinor" >= 0),
  ADD CONSTRAINT "credit_note_line_total_nonneg_chk" CHECK ("lineTotalCreditedMinor" >= 0),
  -- §11/§20 of the frozen 3b.8-A architecture — net subtracts discount then
  -- document-discount share EXACTLY ONCE, never a double subtraction.
  ADD CONSTRAINT "credit_note_line_net_eq_chk" CHECK (
    "netAfterDocumentDiscountCreditedMinor" = "grossCreditedMinor" - "discountCreditedMinor" - "documentDiscountShareCreditedMinor"
  );

ALTER TABLE "credit_note_coverage_release"
  ADD CONSTRAINT "credit_note_coverage_release_amount_positive_chk" CHECK ("releasedAmountMinor" > 0),
  ADD CONSTRAINT "credit_note_coverage_release_source_kind_chk" CHECK ("sourceKind" IN (
    'PAYMENT_ALLOCATION', 'ADVANCE_APPLICATION', 'OPENING_ADVANCE'
  )),
  -- exactly the reference appropriate to sourceKind may be populated —
  -- mirrors `order_line`'s own 3-shape structural CHECK discipline exactly.
  -- CORRECTIVE PASS (§3) — OPENING_ADVANCE now shares ADVANCE_APPLICATION's
  -- own `sourceAdvanceApplicationId NOT NULL` shape (retaining its exact
  -- CustomerAdvanceApplication provenance instead of populating neither
  -- reference column); the two kinds are distinguished by the underlying
  -- CustomerAdvance's own `sourceType` (trigger-verified, §
  -- fn_check_credit_note_coverage_release_integrity below) and by whether
  -- `sourcePaymentId` is populated.
  ADD CONSTRAINT "credit_note_coverage_release_source_shape_chk" CHECK (
    ("sourceKind" = 'PAYMENT_ALLOCATION' AND "sourcePaymentAllocationId" IS NOT NULL AND "sourceAdvanceApplicationId" IS NULL AND "sourcePaymentId" IS NOT NULL)
    OR ("sourceKind" = 'ADVANCE_APPLICATION' AND "sourcePaymentAllocationId" IS NULL AND "sourceAdvanceApplicationId" IS NOT NULL AND "sourcePaymentId" IS NOT NULL)
    OR ("sourceKind" = 'OPENING_ADVANCE' AND "sourcePaymentAllocationId" IS NULL AND "sourceAdvanceApplicationId" IS NOT NULL AND "sourcePaymentId" IS NULL)
  );

ALTER TABLE "cancellation_charge"
  ADD CONSTRAINT "cancellation_charge_net_nonneg_chk" CHECK ("netAmountMinor" >= 0),
  ADD CONSTRAINT "cancellation_charge_tax_nonneg_chk" CHECK ("taxAmountMinor" >= 0),
  ADD CONSTRAINT "cancellation_charge_total_positive_chk" CHECK ("totalAmountMinor" > 0),
  ADD CONSTRAINT "cancellation_charge_price_tax_mode_chk" CHECK ("priceTaxMode" IN ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE')),
  ADD CONSTRAINT "cancellation_charge_rounding_mode_chk" CHECK ("roundingMode" IN ('HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'HALF_DOWN')),
  ADD CONSTRAINT "cancellation_charge_reason_code_chk" CHECK ("reasonCode" IN (
    'CUSTOMER_REQUEST', 'DUPLICATE', 'PRICING_ERROR', 'DAMAGED',
    'SERVICE_NOT_DELIVERED', 'ORDER_ERROR', 'OTHER'
  )),
  -- §3/§13 of the frozen 3b.8-A architecture — exact mode-conditional total
  -- equation, the caller's ONE `requestedAmountMinor` interpreted per mode
  -- (application layer) resolves into these 3 persisted, mutually-consistent
  -- columns.
  ADD CONSTRAINT "cancellation_charge_total_eq_chk" CHECK (
    ("priceTaxMode" = 'TAX_EXCLUSIVE' AND "totalAmountMinor" = "netAmountMinor" + "taxAmountMinor")
    OR ("priceTaxMode" = 'TAX_INCLUSIVE' AND "netAmountMinor" = "totalAmountMinor" - "taxAmountMinor")
  ),
  -- tax-reference snapshot shape — mirrors `order_line`'s own universal
  -- invariants: a rate never exists without a category, and rateBps IS NULL
  -- iff no category was resolved (a genuinely unconfigured/zero-tax charge
  -- is `taxCategoryKey IS NULL, rateBps IS NULL, taxAmountMinor = 0`).
  ADD CONSTRAINT "cancellation_charge_tax_ref_shape_chk" CHECK (
    ("taxCategoryKey" IS NULL) = ("rateBps" IS NULL)
  );

ALTER TABLE "refund"
  ADD CONSTRAINT "refund_amount_positive_chk" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "refund_method_chk" CHECK ("method" IN ('CASH', 'CARD_TERMINAL', 'BANK_TRANSFER', 'ONLINE_GATEWAY', 'OTHER_MANUAL')),
  ADD CONSTRAINT "refund_reason_code_chk" CHECK ("reasonCode" IN (
    'CUSTOMER_REQUEST', 'DUPLICATE', 'PRICING_ERROR', 'DAMAGED',
    'SERVICE_NOT_DELIVERED', 'ORDER_ERROR', 'OTHER'
  ));

ALTER TABLE "refund_attempt"
  ADD CONSTRAINT "refund_attempt_requested_amount_positive_chk" CHECK ("requestedAmountMinor" > 0),
  ADD CONSTRAINT "refund_attempt_state_chk" CHECK ("state" IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  -- §1/§17 of the frozen 3b.8-A architecture — a provider-backed Refund row
  -- MUST NOT be created before provider success: SUCCEEDED requires a real
  -- resultingRefundId, FAILED requires none, PENDING has none yet.
  ADD CONSTRAINT "refund_attempt_resulting_refund_shape_chk" CHECK (
    ("state" = 'SUCCEEDED' AND "resultingRefundId" IS NOT NULL)
    OR ("state" IN ('PENDING', 'FAILED') AND "resultingRefundId" IS NULL)
  );

ALTER TABLE "refund_attempt_entitlement_reservation"
  ADD CONSTRAINT "refund_attempt_entitlement_reservation_amount_positive_chk" CHECK ("amountMinor" > 0);

ALTER TABLE "customer_advance_refund_application"
  ADD CONSTRAINT "customer_advance_refund_application_amount_positive_chk" CHECK ("amountMinor" > 0);

ALTER TABLE "provider_refund_event"
  ADD CONSTRAINT "provider_refund_event_status_chk" CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'EXCEPTION')),
  ADD CONSTRAINT "provider_refund_event_target_state_chk" CHECK ("targetState" IS NULL OR "targetState" IN ('PENDING', 'SUCCEEDED', 'FAILED'));

-- entryKind CHECK widening — Task 3b.8 Checkpoint B adds the final 3 kinds,
-- names this table's own domain module (`customer-account-entry.ts`) already
-- reserved ("3b.8's CREDIT_NOTE/REFUND/WRITE_OFF") — WRITE_OFF is NOT added
-- (no 3b.8 concept requires it).
ALTER TABLE "customer_account_entry" DROP CONSTRAINT "customer_account_entry_kind_chk";
ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_kind_chk" CHECK ("entryKind" IN (
    'INVOICE', 'PAYMENT', 'PAYMENT_ALLOCATION', 'OPENING_RECEIVABLE_PAYMENT_APPLIED',
    'ADVANCE', 'ADVANCE_APPLIED', 'OPENING_RECEIVABLE', 'OPENING_ADVANCE',
    'CREDIT_NOTE', 'CANCELLATION_CHARGE', 'REFUND'
  ));

-- ══════════════════════ CreditNote header/line deferred completeness ═══════
-- Mirrors `trg_check_settlement_batch_finalized_complete`'s exact
-- CONSTRAINT TRIGGER / DEFERRABLE INITIALLY DEFERRED idiom (header + child
-- rows inserted in the SAME transaction, reconciled once at COMMIT).
CREATE FUNCTION fn_check_credit_note_complete() RETURNS trigger AS $$
DECLARE
  cn RECORD;
  line_count INT;
  sum_net BIGINT;
  sum_tax BIGINT;
  sum_total BIGINT;
BEGIN
  SELECT * INTO cn FROM "credit_note" WHERE "id" = NEW."id";
  SELECT COUNT(*), COALESCE(SUM("netAfterDocumentDiscountCreditedMinor"), 0),
         COALESCE(SUM("taxCreditedMinor"), 0), COALESCE(SUM("lineTotalCreditedMinor"), 0)
    INTO line_count, sum_net, sum_tax, sum_total
    FROM "credit_note_line" WHERE "creditNoteId" = NEW."id";
  IF line_count = 0 THEN
    RAISE EXCEPTION 'credit_note %: has zero credit_note_line rows', NEW."id";
  END IF;
  IF cn."subtotalAmountMinor" != sum_net THEN
    RAISE EXCEPTION 'credit_note %: subtotalAmountMinor % != SUM(netAfterDocumentDiscountCreditedMinor) %', NEW."id", cn."subtotalAmountMinor", sum_net;
  END IF;
  IF cn."taxTotalAmountMinor" != sum_tax THEN
    RAISE EXCEPTION 'credit_note %: taxTotalAmountMinor % != SUM(taxCreditedMinor) %', NEW."id", cn."taxTotalAmountMinor", sum_tax;
  END IF;
  IF cn."totalAmountMinor" != sum_total THEN
    RAISE EXCEPTION 'credit_note %: totalAmountMinor % != SUM(lineTotalCreditedMinor) %', NEW."id", cn."totalAmountMinor", sum_total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_credit_note_complete
  AFTER INSERT ON "credit_note"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_credit_note_complete();

-- Invoice-aggregate capacity — §7 of the frozen 3b.8-A architecture:
-- SUM(CreditNote.totalAmountMinor for this Invoice) <= Invoice.totalAmountMinor.
-- Deferred (fires at COMMIT, same transaction that already holds the
-- Invoice row FOR UPDATE via the per-line capacity trigger below — no new
-- lock is acquired here, the existing one is simply still held).
CREATE FUNCTION fn_check_credit_note_invoice_capacity() RETURNS trigger AS $$
DECLARE
  cn RECORD;
  invoice_total BIGINT;
  cumulative_total BIGINT;
BEGIN
  SELECT * INTO cn FROM "credit_note" WHERE "id" = NEW."id";
  SELECT "totalAmountMinor" INTO invoice_total FROM "invoice" WHERE "id" = cn."invoiceId";
  SELECT COALESCE(SUM("totalAmountMinor"), 0) INTO cumulative_total
    FROM "credit_note" WHERE "invoiceId" = cn."invoiceId";
  IF cumulative_total > invoice_total THEN
    RAISE EXCEPTION 'credit_note %: cumulative CreditNote total % exceeds invoice % own total %', NEW."id", cumulative_total, cn."invoiceId", invoice_total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_credit_note_invoice_capacity
  AFTER INSERT ON "credit_note"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_credit_note_invoice_capacity();

-- ANCHOR-SIDE twin of `fn_check_credit_note_coverage_release_complete`
-- (defined further below, on `credit_note_coverage_release`) — that
-- CONSTRAINT TRIGGER never fires at all when a CreditNote with
-- `advanceExcessMinor > 0` has ZERO coverage-release rows (no child-table
-- INSERT event to fire it), which would otherwise silently violate "the
-- excess must be funded" (§11). A CreditNote with `advanceExcessMinor = 0`
-- legitimately has zero release rows (the normal AR-only case) — this check
-- only fires when excess > 0.
CREATE FUNCTION fn_check_credit_note_advance_excess_anchor() RETURNS trigger AS $$
DECLARE
  funded_sum BIGINT;
BEGIN
  IF NEW."advanceExcessMinor" = 0 THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(ca."amountMinor"), 0) INTO funded_sum
    FROM "credit_note_coverage_release" r
    JOIN "customer_advance" ca ON ca."id" = r."customerAdvanceId"
   WHERE r."creditNoteId" = NEW."id";
  IF funded_sum != NEW."advanceExcessMinor" THEN
    RAISE EXCEPTION 'credit_note %: SUM(funded CustomerAdvance) % != advanceExcessMinor %', NEW."id", funded_sum, NEW."advanceExcessMinor";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_credit_note_advance_excess_anchor
  AFTER INSERT ON "credit_note"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_credit_note_advance_excess_anchor();

-- ══════════════════════ CreditNoteLine provenance + 7-component capacity ═════
-- §5/§7/§8/§11/§14/§20 of the frozen 3b.8-A architecture — the Invoice row is
-- the serialization root (locked FOR UPDATE here, matching §19's own
-- correction). Provenance: the OrderLine's own Order must be the SAME Order
-- as the CreditNote's own Invoice's Order — never an arbitrary same-tenant
-- pairing. Capacity: 7 independent cumulative ceilings (quantity, gross,
-- line discount, document-discount share, net-after-document-discount, tax,
-- line total), each derived from the OrderLine's own ALREADY-PERSISTED
-- frozen snapshot (`unitPriceAmountMinor`/`quantity`/`discountAmountMinor`/
-- `lineTaxAmountMinor`/`priceTaxMode`) — NEVER current tax config,
-- NEVER `TaxResolutionService`. `documentDiscountShareMinor` (never itself
-- persisted on `order_line`) is safely RE-DERIVED here by replicating
-- `Money.allocate`'s own exact largest-remainder algorithm (floor base +
-- largest-fractional-remainder-first distribution, tie-broken by
-- linePosition ascending — verified against `packages/money/src/money.ts`
-- directly) over the SAME frozen sibling-line inputs `allocateDocumentDiscount`
-- itself consumes; this is a safe, deterministic, byte-identical
-- re-derivation (its inputs never depend on current external config), never
-- a tax re-resolution. `grossCreditedMinor`'s own internal formula is
-- intentionally NOT asserted bit-exact here (only capped) — full
-- per-component formula replication beyond the ceiling itself is
-- consciously out of scope for a DB hard gate (no precedent anywhere else in
-- this schema re-derives rate/quantity arithmetic inside a trigger); the two
-- CHEAP, CHEAP-TO-VERIFY internal-consistency identities
-- (`netAfterDocumentDiscountCreditedMinor` via the same-row CHECK above, and
-- the mode-conditional `lineTotalCreditedMinor` equation checked here) are
-- what actually catch real corruption, while the 7 ceilings prevent
-- over-credit — together these are the DB's actual job, not re-implementing
-- the tax engine.
CREATE FUNCTION fn_check_credit_note_line_capacity() RETURNS trigger AS $$
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
BEGIN
  SELECT cn."invoiceId" INTO v_invoice_id FROM "credit_note" cn WHERE cn."id" = NEW."creditNoteId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_line %: referenced credit_note % does not exist', NEW."id", NEW."creditNoteId";
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

CREATE TRIGGER trg_check_credit_note_line_capacity
  BEFORE INSERT ON "credit_note_line"
  FOR EACH ROW EXECUTE FUNCTION fn_check_credit_note_line_capacity();

-- ══════════════════════ CreditNoteCoverageRelease -> CustomerAdvance 1:1 ═════
-- §5/§10/§11 of the frozen 3b.8-A architecture. No GL is attached here — the
-- ONE CreditNote journal (application layer, a later checkpoint) already
-- funds every Advance this migration creates via its own aggregate
-- `Cr LIABILITY.CUSTOMER_ADVANCES advanceExcessMinor` line.
-- CORRECTIVE PASS (§2/§3) — OPENING_ADVANCE now retains its exact
-- CustomerAdvanceApplication provenance (shares ADVANCE_APPLICATION's own
-- `sourceAdvanceApplicationId NOT NULL` shape; distinguished by the
-- underlying CustomerAdvance's own `sourceType`, never by which column is
-- populated). A release-capacity hard gate is added for BOTH source kinds:
-- cumulative releases against one PaymentAllocation/CustomerAdvanceApplication
-- can never exceed that row's own `amountMinor` — locking the SOURCE row
-- itself FOR UPDATE (mirrors `fn_lock_and_validate_payment_capacity`'s own
-- lock-then-sum-then-reject idiom exactly), independent of and in addition
-- to the Invoice-row lock the caller (a later checkpoint's Credit-Note
-- issuance command) already holds via the per-line capacity trigger.
CREATE FUNCTION fn_check_credit_note_coverage_release_integrity() RETURNS trigger AS $$
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
    SELECT caa."amountMinor", caa."currencyCode", caa."currencyExponent",
           ca."sourceType", ca."sourcePaymentId",
           recv."sourceType", recv."invoiceId"
      INTO application_amount, application_currency_code, application_currency_exponent,
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

    IF NEW."sourceKind" = 'ADVANCE_APPLICATION' THEN
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

CREATE TRIGGER trg_check_credit_note_coverage_release_integrity
  BEFORE INSERT ON "credit_note_coverage_release"
  FOR EACH ROW EXECUTE FUNCTION fn_check_credit_note_coverage_release_integrity();

CREATE FUNCTION fn_enforce_credit_note_coverage_release_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_note_coverage_release % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_credit_note_coverage_release_no_update
  BEFORE UPDATE ON "credit_note_coverage_release" FOR EACH ROW EXECUTE FUNCTION fn_enforce_credit_note_coverage_release_no_update();

CREATE FUNCTION fn_enforce_credit_note_coverage_release_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_note_coverage_release % is immutable: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_credit_note_coverage_release_no_delete
  BEFORE DELETE ON "credit_note_coverage_release" FOR EACH ROW EXECUTE FUNCTION fn_enforce_credit_note_coverage_release_no_delete();

-- deferred: SUM(CustomerAdvance funded by this CreditNote's own releases) =
-- CreditNote.advanceExcessMinor (persisted, §11 — never a live recomputation
-- of mutable customer-balance state).
CREATE FUNCTION fn_check_credit_note_coverage_release_complete() RETURNS trigger AS $$
DECLARE
  cn RECORD;
  funded_sum BIGINT;
  released_sum BIGINT;
BEGIN
  SELECT * INTO cn FROM "credit_note" WHERE "id" = NEW."creditNoteId";
  SELECT COALESCE(SUM(ca."amountMinor"), 0), COALESCE(SUM(r."releasedAmountMinor"), 0)
    INTO funded_sum, released_sum
    FROM "credit_note_coverage_release" r
    JOIN "customer_advance" ca ON ca."id" = r."customerAdvanceId"
   WHERE r."creditNoteId" = NEW."creditNoteId";
  IF funded_sum != cn."advanceExcessMinor" THEN
    RAISE EXCEPTION 'credit_note %: SUM(funded CustomerAdvance) % != advanceExcessMinor %', NEW."creditNoteId", funded_sum, cn."advanceExcessMinor";
  END IF;
  IF released_sum != cn."advanceExcessMinor" THEN
    RAISE EXCEPTION 'credit_note %: SUM(releasedAmountMinor) % != advanceExcessMinor %', NEW."creditNoteId", released_sum, cn."advanceExcessMinor";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_credit_note_coverage_release_complete
  AFTER INSERT ON "credit_note_coverage_release"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_credit_note_coverage_release_complete();

-- ══════════════════════ CreditNote / CreditNoteLine immutability ═════════════

CREATE FUNCTION fn_enforce_credit_note_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_note % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_credit_note_no_update BEFORE UPDATE ON "credit_note" FOR EACH ROW EXECUTE FUNCTION fn_enforce_credit_note_no_update();

CREATE FUNCTION fn_enforce_credit_note_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_note % is immutable: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_credit_note_no_delete BEFORE DELETE ON "credit_note" FOR EACH ROW EXECUTE FUNCTION fn_enforce_credit_note_no_delete();

CREATE FUNCTION fn_enforce_credit_note_line_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_note_line % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_credit_note_line_no_update BEFORE UPDATE ON "credit_note_line" FOR EACH ROW EXECUTE FUNCTION fn_enforce_credit_note_line_no_update();

CREATE FUNCTION fn_enforce_credit_note_line_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_note_line % is immutable: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_credit_note_line_no_delete BEFORE DELETE ON "credit_note_line" FOR EACH ROW EXECUTE FUNCTION fn_enforce_credit_note_line_no_delete();

-- ══════════════════════ CancellationCharge provenance + immutability ═══════
-- §5/§6/§9/§15 of the frozen 3b.8-A architecture — the one-directional
-- receivable link (mirrors `Invoice`'s own precedent exactly: no
-- `cancellation_charge.customerReceivableId` column; `customer_receivable.
-- cancellationChargeId` points AT this row — never a two-way FK cycle).
CREATE FUNCTION fn_check_cancellation_charge_provenance() RETURNS trigger AS $$
DECLARE
  ord RECORD;
BEGIN
  SELECT "originBranchId" INTO ord FROM "order" WHERE "id" = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cancellation_charge %: referenced order % does not exist', NEW."id", NEW."orderId";
  END IF;
  IF NEW."branchId" IS DISTINCT FROM ord."originBranchId" THEN
    RAISE EXCEPTION 'cancellation_charge %: branchId must equal order %''s originBranchId', NEW."id", NEW."orderId";
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

CREATE TRIGGER trg_check_cancellation_charge_provenance
  BEFORE INSERT ON "cancellation_charge"
  FOR EACH ROW EXECUTE FUNCTION fn_check_cancellation_charge_provenance();

CREATE FUNCTION fn_enforce_cancellation_charge_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cancellation_charge % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_cancellation_charge_no_update BEFORE UPDATE ON "cancellation_charge" FOR EACH ROW EXECUTE FUNCTION fn_enforce_cancellation_charge_no_update();

CREATE FUNCTION fn_enforce_cancellation_charge_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cancellation_charge % is immutable: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_cancellation_charge_no_delete BEFORE DELETE ON "cancellation_charge" FOR EACH ROW EXECUTE FUNCTION fn_enforce_cancellation_charge_no_delete();

-- ══════════════════════ Payment refund-capacity function (§3/§4/§23/§24) ═════
-- Mirrors the exact `fn_lock_and_validate_payment_capacity` /
-- `fn_lock_and_validate_payment_settlement_capacity` precedent (locks
-- `payment` FOR UPDATE, sums existing consumption, rejects over-capacity) —
-- a SEPARATE consumption ceiling (refund-OUT vs allocation/settlement-IN),
-- same Payment row, same lock tier, no new lock-order rule. The
-- `p_excluding_refund_attempt_id` parameter is what makes the
-- RefundAttempt->Refund conversion transaction (§1/§2) capacity-safe: it
-- excludes the converting attempt's OWN PENDING reservation from the active
-- side while the NEW Refund amount is counted via `p_proposed_amount`,
-- closing the double-count defect a naive reservation+successful-Refund sum
-- would otherwise create.
CREATE FUNCTION fn_lock_and_validate_payment_refund_capacity(
  p_payment_id UUID,
  p_proposed_amount BIGINT,
  p_excluding_refund_attempt_id UUID DEFAULT NULL
) RETURNS void AS $$
DECLARE
  payment_amount BIGINT;
  consumed BIGINT;
BEGIN
  SELECT "amountMinor" INTO payment_amount FROM "payment" WHERE "id" = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment %: does not exist', p_payment_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO consumed FROM "refund" WHERE "sourcePaymentId" = p_payment_id;
  consumed := consumed + COALESCE((
    SELECT SUM("requestedAmountMinor") FROM "refund_attempt"
     WHERE "sourcePaymentId" = p_payment_id AND "state" = 'PENDING'
       AND (p_excluding_refund_attempt_id IS NULL OR "id" != p_excluding_refund_attempt_id)
  ), 0);
  IF consumed + p_proposed_amount > payment_amount THEN
    RAISE EXCEPTION 'payment %: refund consumption would exceed amountMinor (payment=%, already consumed=%, proposed=%)', p_payment_id, payment_amount, consumed, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ extend fn_lock_and_validate_advance_capacity ═══════
-- The frozen 3b.6 migration file (20260927130000_receivables_core_schema) is
-- untouched on disk; the function it already points to is redefined here.
-- NOTE: `CREATE OR REPLACE FUNCTION` cannot change a function's parameter
-- list — PostgreSQL identifies a function by (name, parameter types), so
-- adding a 3rd parameter (even with a DEFAULT) would silently CREATE A
-- SECOND, OVERLOADED function instead of replacing the original, making
-- every existing 2-argument call site ambiguous
-- ("function ... is not unique") — verified against real Postgres in this
-- checkpoint's own test suite. The original 2-argument function is therefore
-- explicitly DROPPED first, then the 3-argument replacement is created under
-- the SAME name — the exact same net effect (one authoritative definition
-- going forward, frozen migration file untouched) as the `CREATE OR REPLACE`
-- technique 3b.5/3b.6 themselves used for a same-signature body swap
-- (`fn_enforce_invoice_no_update`/`fn_enforce_provider_payment_event_transition`),
-- just with the one extra DROP a signature change requires. Existing
-- 2-argument call sites (`customer_advance_application` trigger) keep
-- working unchanged — the 3rd parameter defaults to NULL. §5/§6/§21 of the
-- frozen 3b.8-A architecture.
DROP FUNCTION IF EXISTS fn_lock_and_validate_advance_capacity(UUID, BIGINT);
CREATE FUNCTION fn_lock_and_validate_advance_capacity(
  p_advance_id UUID,
  p_proposed_amount BIGINT,
  p_excluding_refund_attempt_id UUID DEFAULT NULL
) RETURNS void AS $$
DECLARE
  principal BIGINT;
  consumed BIGINT;
BEGIN
  SELECT "amountMinor" INTO principal FROM "customer_advance" WHERE "id" = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance %: does not exist', p_advance_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO consumed FROM "customer_advance_application" WHERE "customerAdvanceId" = p_advance_id;
  consumed := consumed + COALESCE((SELECT SUM("amountMinor") FROM "customer_advance_refund_application" WHERE "customerAdvanceId" = p_advance_id), 0);
  consumed := consumed + COALESCE((
    SELECT SUM(r."amountMinor") FROM "refund_attempt_entitlement_reservation" r
      JOIN "refund_attempt" ra ON ra."id" = r."refundAttemptId"
     WHERE r."customerAdvanceId" = p_advance_id AND ra."state" = 'PENDING'
       AND (p_excluding_refund_attempt_id IS NULL OR ra."id" != p_excluding_refund_attempt_id)
  ), 0);
  IF consumed + p_proposed_amount > principal THEN
    RAISE EXCEPTION 'customer_advance %: application would exceed amountMinor (principal=%, already applied=%, proposed=%)', p_advance_id, principal, consumed, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ RefundAttempt: scope + reservation + capacity ═══════
CREATE FUNCTION fn_check_refund_attempt_scope_and_capacity() RETURNS trigger AS $$
DECLARE
  cred RECORD;
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

  PERFORM fn_lock_and_validate_payment_refund_capacity(NEW."sourcePaymentId", NEW."requestedAmountMinor", NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_refund_attempt_scope_and_capacity
  BEFORE INSERT ON "refund_attempt"
  FOR EACH ROW EXECUTE FUNCTION fn_check_refund_attempt_scope_and_capacity();

-- narrow lifecycle mutation — mirrors `PaymentAttempt`'s own frozen-graph
-- precedent exactly. §1/§14/§17/§21 of the frozen 3b.8-A architecture.
CREATE FUNCTION fn_enforce_refund_attempt_transition() RETURNS trigger AS $$
BEGIN
  IF NOT (
    NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."sourcePaymentId" IS NOT DISTINCT FROM OLD."sourcePaymentId"
    AND NEW."requestedAmountMinor" IS NOT DISTINCT FROM OLD."requestedAmountMinor"
    AND NEW."currencyCode" IS NOT DISTINCT FROM OLD."currencyCode"
    AND NEW."currencyExponent" IS NOT DISTINCT FROM OLD."currencyExponent"
    AND NEW."providerCredentialId" IS NOT DISTINCT FROM OLD."providerCredentialId"
    AND NEW."providerKey" IS NOT DISTINCT FROM OLD."providerKey"
    AND NEW."idempotencyKey" IS NOT DISTINCT FROM OLD."idempotencyKey"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'refund_attempt %: only state/providerReference/resultingRefundId/failureCode/sanitizedFailureMetadata/updatedAt may change', OLD."id";
  END IF;

  IF OLD."state" IN ('SUCCEEDED', 'FAILED') THEN
    IF NEW."state" IS DISTINCT FROM OLD."state"
       OR NEW."resultingRefundId" IS DISTINCT FROM OLD."resultingRefundId"
       OR NEW."providerReference" IS DISTINCT FROM OLD."providerReference"
       OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode" THEN
      RAISE EXCEPTION 'refund_attempt %: terminal state % is immutable', OLD."id", OLD."state";
    END IF;
    RETURN NEW; -- harmless same-value no-op
  END IF;

  -- OLD.state = 'PENDING' here.
  IF NEW."providerReference" IS NOT NULL AND OLD."providerReference" IS NOT NULL
     AND NEW."providerReference" != OLD."providerReference" THEN
    RAISE EXCEPTION 'refund_attempt %: providerReference is narrow set-once — cannot change to a different value', OLD."id";
  END IF;
  IF OLD."providerReference" IS NOT NULL AND NEW."providerReference" IS NULL THEN
    RAISE EXCEPTION 'refund_attempt %: providerReference cannot be cleared once set', OLD."id";
  END IF;

  IF NEW."state" = 'PENDING' THEN
    RETURN NEW; -- e.g. providerReference NULL -> non-NULL while still PENDING
  ELSIF NEW."state" = 'SUCCEEDED' THEN
    IF NEW."resultingRefundId" IS NULL THEN
      RAISE EXCEPTION 'refund_attempt %: SUCCEEDED requires resultingRefundId', OLD."id";
    END IF;
    PERFORM 1 FROM "refund" WHERE "id" = NEW."resultingRefundId" AND "sourceRefundAttemptId" = OLD."id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refund_attempt %: resultingRefundId % does not point back to a refund whose own sourceRefundAttemptId is this row', OLD."id", NEW."resultingRefundId";
    END IF;
    RETURN NEW;
  ELSIF NEW."state" = 'FAILED' THEN
    IF NEW."resultingRefundId" IS NOT NULL THEN
      RAISE EXCEPTION 'refund_attempt %: FAILED must have a NULL resultingRefundId', OLD."id";
    END IF;
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'refund_attempt %: illegal state transition % -> %', OLD."id", OLD."state", NEW."state";
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_refund_attempt_transition
  BEFORE UPDATE ON "refund_attempt"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_refund_attempt_transition();

-- ══════════════════════ RefundAttemptEntitlementReservation ══════════════════
-- §2/§4/§6/§20 of the frozen 3b.8-A architecture — every reservation row
-- must trace to the parent attempt's OWN sourcePaymentId (an OPENING_ADVANCE
-- release, whose funded Advance's release has sourcePaymentId NULL, can
-- never satisfy this equality against any non-NULL attempt.sourcePaymentId —
-- "cannot fund a RefundAttempt" is therefore structural, not merely policy).
CREATE FUNCTION fn_check_refund_attempt_reservation_integrity() RETURNS trigger AS $$
DECLARE
  ra RECORD;
  rel RECORD;
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

  PERFORM fn_lock_and_validate_advance_capacity(NEW."customerAdvanceId", NEW."amountMinor", NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_refund_attempt_reservation_integrity
  BEFORE INSERT ON "refund_attempt_entitlement_reservation"
  FOR EACH ROW EXECUTE FUNCTION fn_check_refund_attempt_reservation_integrity();

CREATE FUNCTION fn_enforce_refund_attempt_entitlement_reservation_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'refund_attempt_entitlement_reservation % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_rafer_no_update BEFORE UPDATE ON "refund_attempt_entitlement_reservation" FOR EACH ROW EXECUTE FUNCTION fn_enforce_refund_attempt_entitlement_reservation_no_update();

CREATE FUNCTION fn_enforce_refund_attempt_entitlement_reservation_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'refund_attempt_entitlement_reservation % is immutable: DELETE is never permitted (a FAILED attempt''s reservations remain as historical evidence)', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_rafer_no_delete BEFORE DELETE ON "refund_attempt_entitlement_reservation" FOR EACH ROW EXECUTE FUNCTION fn_enforce_refund_attempt_entitlement_reservation_no_delete();

-- deferred: SUM(reservation.amountMinor for one attempt) = attempt.requestedAmountMinor.
CREATE FUNCTION fn_check_refund_attempt_reservation_complete() RETURNS trigger AS $$
DECLARE
  requested BIGINT;
  reserved BIGINT;
BEGIN
  SELECT "requestedAmountMinor" INTO requested FROM "refund_attempt" WHERE "id" = NEW."refundAttemptId";
  SELECT COALESCE(SUM("amountMinor"), 0) INTO reserved FROM "refund_attempt_entitlement_reservation" WHERE "refundAttemptId" = NEW."refundAttemptId";
  IF reserved != requested THEN
    RAISE EXCEPTION 'refund_attempt %: SUM(reservation.amountMinor) % != requestedAmountMinor %', NEW."refundAttemptId", reserved, requested;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_refund_attempt_reservation_complete
  AFTER INSERT ON "refund_attempt_entitlement_reservation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_refund_attempt_reservation_complete();

-- ANCHOR-SIDE twin of the check above — a `CONSTRAINT TRIGGER` on the CHILD
-- table alone never fires at all when ZERO child rows exist (there is no
-- INSERT event on that table to fire it), so a RefundAttempt inserted with
-- no reservation rows would otherwise silently satisfy "SUM = requested"
-- vacuously never being checked. This twin, on `refund_attempt` itself,
-- closes that gap — mirrors `fn_check_credit_note_complete`'s own "zero
-- lines" anchor-side check exactly.
CREATE FUNCTION fn_check_refund_attempt_reservation_complete_anchor() RETURNS trigger AS $$
DECLARE
  reserved BIGINT;
BEGIN
  SELECT COALESCE(SUM("amountMinor"), 0) INTO reserved FROM "refund_attempt_entitlement_reservation" WHERE "refundAttemptId" = NEW."id";
  IF reserved != NEW."requestedAmountMinor" THEN
    RAISE EXCEPTION 'refund_attempt %: SUM(reservation.amountMinor) % != requestedAmountMinor %', NEW."id", reserved, NEW."requestedAmountMinor";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_refund_attempt_reservation_complete_anchor
  AFTER INSERT ON "refund_attempt"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_refund_attempt_reservation_complete_anchor();

-- ══════════════════════ Refund: scope + capacity + immutability ═════════════
CREATE FUNCTION fn_check_refund_scope_and_capacity() RETURNS trigger AS $$
DECLARE
  ra RECORD;
BEGIN
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

CREATE TRIGGER trg_check_refund_scope_and_capacity
  BEFORE INSERT ON "refund"
  FOR EACH ROW EXECUTE FUNCTION fn_check_refund_scope_and_capacity();

CREATE FUNCTION fn_enforce_refund_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'refund % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_refund_no_update BEFORE UPDATE ON "refund" FOR EACH ROW EXECUTE FUNCTION fn_enforce_refund_no_update();

CREATE FUNCTION fn_enforce_refund_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'refund % is immutable: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_refund_no_delete BEFORE DELETE ON "refund" FOR EACH ROW EXECUTE FUNCTION fn_enforce_refund_no_delete();

-- ══════════════════════ CustomerAdvanceRefundApplication ═════════════════════
-- §4/§7/§14/§21 of the frozen 3b.8-A architecture — the conversion-safe
-- exclusion is derived from the consuming Refund's OWN sourceRefundAttemptId
-- (never independently supplied) so a provider conversion's successful
-- application never double-counts against its own now-converting reservation.
CREATE FUNCTION fn_check_customer_advance_refund_application_integrity() RETURNS trigger AS $$
DECLARE
  rf RECORD;
BEGIN
  SELECT "sourceRefundAttemptId", "tenantId", "companyId", "branchId" INTO rf FROM "refund" WHERE "id" = NEW."refundId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: referenced refund % does not exist', NEW."id", NEW."refundId";
  END IF;
  IF NEW."tenantId" != rf."tenantId" OR NEW."companyId" != rf."companyId" OR NEW."branchId" != rf."branchId" THEN
    RAISE EXCEPTION 'customer_advance_refund_application %: scope mismatch against refund %', NEW."id", NEW."refundId";
  END IF;

  PERFORM fn_lock_and_validate_advance_capacity(NEW."customerAdvanceId", NEW."amountMinor", rf."sourceRefundAttemptId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_customer_advance_refund_application_integrity
  BEFORE INSERT ON "customer_advance_refund_application"
  FOR EACH ROW EXECUTE FUNCTION fn_check_customer_advance_refund_application_integrity();

CREATE FUNCTION fn_enforce_customer_advance_refund_application_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_advance_refund_application % is immutable: UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_carfa_no_update BEFORE UPDATE ON "customer_advance_refund_application" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_advance_refund_application_no_update();

CREATE FUNCTION fn_enforce_customer_advance_refund_application_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_advance_refund_application % is immutable: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_carfa_no_delete BEFORE DELETE ON "customer_advance_refund_application" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_advance_refund_application_no_delete();

-- deferred: SUM(application.amountMinor for one Refund) = Refund.amountMinor.
-- A Refund with zero applications fails this at commit automatically
-- (0 != a strictly-positive amountMinor) — no separate count>0 check needed.
CREATE FUNCTION fn_check_refund_application_complete() RETURNS trigger AS $$
DECLARE
  refund_amount BIGINT;
  applied BIGINT;
BEGIN
  SELECT "amountMinor" INTO refund_amount FROM "refund" WHERE "id" = NEW."refundId";
  SELECT COALESCE(SUM("amountMinor"), 0) INTO applied FROM "customer_advance_refund_application" WHERE "refundId" = NEW."refundId";
  IF applied != refund_amount THEN
    RAISE EXCEPTION 'refund %: SUM(customer_advance_refund_application.amountMinor) % != amountMinor %', NEW."refundId", applied, refund_amount;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_refund_application_complete
  AFTER INSERT ON "customer_advance_refund_application"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_refund_application_complete();

-- ANCHOR-SIDE twin — see the identical rationale on
-- `fn_check_refund_attempt_reservation_complete_anchor` above: a Refund
-- inserted with ZERO `customer_advance_refund_application` rows would
-- otherwise never be checked at all (no child-table INSERT event to fire
-- the twin above). "No Refund with zero applications in initial
-- customer-linked 3b.8" (§23 of the frozen 3b.8-A architecture) is enforced
-- here, unconditionally.
CREATE FUNCTION fn_check_refund_application_complete_anchor() RETURNS trigger AS $$
DECLARE
  applied BIGINT;
BEGIN
  SELECT COALESCE(SUM("amountMinor"), 0) INTO applied FROM "customer_advance_refund_application" WHERE "refundId" = NEW."id";
  IF applied != NEW."amountMinor" THEN
    RAISE EXCEPTION 'refund %: SUM(customer_advance_refund_application.amountMinor) % != amountMinor %', NEW."id", applied, NEW."amountMinor";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_refund_application_complete_anchor
  AFTER INSERT ON "refund"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_refund_application_complete_anchor();

-- ══════════════════════ ProviderRefundEvent transition ═══════════════════════
-- Mirrors `ProviderPaymentEvent`'s own frozen posture exactly: RECEIVED ->
-- PROCESSED | EXCEPTION only, both terminal; every other field immutable
-- after insert.
CREATE FUNCTION fn_enforce_provider_refund_event_transition() RETURNS trigger AS $$
BEGIN
  IF NOT (
    NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."providerCredentialId" IS NOT DISTINCT FROM OLD."providerCredentialId"
    AND NEW."providerEventId" IS NOT DISTINCT FROM OLD."providerEventId"
    AND NEW."eventType" IS NOT DISTINCT FROM OLD."eventType"
    AND NEW."receivedAt" IS NOT DISTINCT FROM OLD."receivedAt"
    AND NEW."payloadHash" IS NOT DISTINCT FROM OLD."payloadHash"
    AND NEW."sanitizedMetadata" IS NOT DISTINCT FROM OLD."sanitizedMetadata"
    AND NEW."refundAttemptId" IS NOT DISTINCT FROM OLD."refundAttemptId"
    AND NEW."providerReference" IS NOT DISTINCT FROM OLD."providerReference"
    AND NEW."targetState" IS NOT DISTINCT FROM OLD."targetState"
    AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'provider_refund_event %: only status/updatedAt may change', OLD."id";
  END IF;
  IF OLD."status" != 'RECEIVED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'provider_refund_event %: terminal status % is immutable', OLD."id", OLD."status";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" NOT IN ('RECEIVED', 'PROCESSED', 'EXCEPTION') THEN
    RAISE EXCEPTION 'provider_refund_event %: illegal status %', OLD."id", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_provider_refund_event_transition
  BEFORE UPDATE ON "provider_refund_event"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_provider_refund_event_transition();

-- ══════════════════════ CustomerReceivable / CustomerAccountEntry extension ═
-- Extend the frozen cross-table integrity triggers via CREATE OR REPLACE
-- (same non-destructive technique 3b.5/3b.6 already established) — the
-- INVOICE/OPENING shapes are completely unchanged; CANCELLATION_CHARGE is a
-- purely additive branch.
CREATE OR REPLACE FUNCTION fn_check_customer_receivable_integrity() RETURNS trigger AS $$
DECLARE
  inv RECORD;
  ord_customer_id UUID;
  cc RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "customer_company_account" cca
    WHERE cca."id" = NEW."customerCompanyAccountId" AND cca."tenantId" = NEW."tenantId" AND cca."companyId" = NEW."companyId"
  ) THEN
    RAISE EXCEPTION 'customer_receivable %: referenced customerCompanyAccountId % does not exist in this tenant/company', NEW."id", NEW."customerCompanyAccountId";
  END IF;

  IF NEW."sourceType" = 'OPENING' THEN
    RETURN NEW;
  END IF;

  -- Task 3b.8 Checkpoint B — additive CANCELLATION_CHARGE branch, mirrors
  -- the INVOICE branch's own scope/customer-match discipline exactly.
  IF NEW."sourceType" = 'CANCELLATION_CHARGE' THEN
    SELECT * INTO cc FROM "cancellation_charge" WHERE "id" = NEW."cancellationChargeId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_receivable %: referenced cancellationChargeId % does not exist', NEW."id", NEW."cancellationChargeId";
    END IF;
    IF NEW."tenantId" IS DISTINCT FROM cc."tenantId" OR NEW."companyId" IS DISTINCT FROM cc."companyId" OR NEW."branchId" IS DISTINCT FROM cc."branchId" THEN
      RAISE EXCEPTION 'customer_receivable %: scope does not match cancellation_charge %', NEW."id", NEW."cancellationChargeId";
    END IF;
    SELECT o."customerId" INTO ord_customer_id FROM "order" o WHERE o."id" = cc."orderId";
    IF ord_customer_id IS NULL THEN
      RAISE EXCEPTION 'customer_receivable %: cancellation_charge %''s order has no associated customer (walk-in) — a walk-in CancellationCharge never gets a CustomerReceivable', NEW."id", NEW."cancellationChargeId";
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "customer_company_account" cca WHERE cca."id" = NEW."customerCompanyAccountId" AND cca."customerId" = ord_customer_id
    ) THEN
      RAISE EXCEPTION 'customer_receivable %: customerCompanyAccountId does not match cancellation_charge %''s actual customer', NEW."id", NEW."cancellationChargeId";
    END IF;
    RETURN NEW;
  END IF;

  -- NEW."sourceType" = 'INVOICE' (unchanged, original logic).
  SELECT * INTO inv FROM "invoice" WHERE "id" = NEW."invoiceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable %: referenced invoiceId % does not exist', NEW."id", NEW."invoiceId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM inv."tenantId" OR NEW."companyId" IS DISTINCT FROM inv."companyId" OR NEW."branchId" IS DISTINCT FROM inv."branchId" THEN
    RAISE EXCEPTION 'customer_receivable %: scope does not match invoice %', NEW."id", NEW."invoiceId";
  END IF;

  SELECT o."customerId" INTO ord_customer_id FROM "order" o WHERE o."id" = inv."orderId";
  IF ord_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_receivable %: invoice %''s order has no associated customer (walk-in) — a walk-in Invoice never gets a CustomerReceivable', NEW."id", NEW."invoiceId";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "customer_company_account" cca WHERE cca."id" = NEW."customerCompanyAccountId" AND cca."customerId" = ord_customer_id
  ) THEN
    RAISE EXCEPTION 'customer_receivable %: customerCompanyAccountId does not match invoice %''s actual customer', NEW."id", NEW."invoiceId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_check_customer_account_entry_source_type() RETURNS trigger AS $$
DECLARE
  recv_source_type TEXT;
  adv_source_type TEXT;
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
  END IF;
  -- CREDIT_NOTE (creditNoteId) and REFUND (customerAdvanceRefundApplicationId)
  -- need no cross-table sourceType check — each references a table with no
  -- competing sourceType vocabulary of its own (mirrors PAYMENT/
  -- PAYMENT_ALLOCATION/OPENING_RECEIVABLE_PAYMENT_APPLIED's own precedent:
  -- "their sole reference column already carries a real FK — there is no
  -- second sourceType on those tables to cross-validate against").
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ Row-Level Security (CLAUDE.md rule 7) ═══════════════

ALTER TABLE "credit_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credit_note_tenant_isolation" ON "credit_note"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "credit_note_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credit_note_line_tenant_isolation" ON "credit_note_line"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "credit_note_coverage_release" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note_coverage_release" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credit_note_coverage_release_tenant_isolation" ON "credit_note_coverage_release"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "cancellation_charge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cancellation_charge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cancellation_charge_tenant_isolation" ON "cancellation_charge"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "refund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_tenant_isolation" ON "refund"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "refund_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_attempt_tenant_isolation" ON "refund_attempt"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "refund_attempt_entitlement_reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_attempt_entitlement_reservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_attempt_entitlement_reservation_tenant_isolation" ON "refund_attempt_entitlement_reservation"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "customer_advance_refund_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_advance_refund_application" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_advance_refund_application_tenant_isolation" ON "customer_advance_refund_application"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "provider_refund_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_refund_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_refund_event_tenant_isolation" ON "provider_refund_event"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "credit_note", "credit_note_line", "credit_note_coverage_release",
  "cancellation_charge", "refund", "refund_attempt",
  "refund_attempt_entitlement_reservation", "customer_advance_refund_application",
  "provider_refund_event" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_note", "credit_note_line",
  "credit_note_coverage_release", "cancellation_charge", "refund", "refund_attempt",
  "refund_attempt_entitlement_reservation", "customer_advance_refund_application",
  "provider_refund_event" TO flower_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_note", "credit_note_line",
  "credit_note_coverage_release", "cancellation_charge", "refund", "refund_attempt",
  "refund_attempt_entitlement_reservation", "customer_advance_refund_application",
  "provider_refund_event" TO flower_app;

-- ══════════════════════ permission registry + system-role backfill ══════════
-- §27/§30 of the frozen 3b.8-A architecture — mirrors the exact
-- `20261004120000_settlement_permissions` precedent (FORCE-toggle discipline,
-- ON CONFLICT DO NOTHING idempotency). Only 4 new tenant-realm keys —
-- pre-invoice no-charge cancellation deliberately registers NO new
-- permission here (reuses existing `orders:manage` scope per the frozen
-- 3b.8-A architecture; a pre-existing, more specific `orders:cancel` key was
-- found already registered/backfilled since migration
-- `20260920130000_orders_permissions` — see this checkpoint's own final
-- report for the flagged precedent conflict, left for owner confirmation
-- before Checkpoint C wires the actual route decorator).
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('credit_notes:view',   'TENANT', 'credit_notes', 'credit notes view',   3),
  ('credit_notes:issue',  'TENANT', 'credit_notes', 'credit notes issue',  3),
  ('refunds:view',        'TENANT', 'refunds',      'refunds view',        3),
  ('refunds:execute',     'TENANT', 'refunds',      'refunds execute',     3)
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

-- credit_notes:view + refunds:view — owner/admin/accountant/manager (§27).
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('credit_notes:view'), ('refunds:view')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'accountant', 'manager')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

-- credit_notes:issue + refunds:execute — owner/admin/accountant/manager,
-- STEP-UP wired in a LATER checkpoint (§27: "Manager precedent deviation is
-- explicitly accepted by owner" — a documented departure from
-- `settlements:finalize`'s own narrower owner/admin/accountant-only precedent).
INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('credit_notes:issue'), ('refunds:execute')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin', 'accountant', 'manager')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
