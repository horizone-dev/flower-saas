-- Phase 3b task 3b.6 CHECKPOINT B (B8-B11, B14) — the receivables/credit/
-- advances append-only subledger. Four new tables, realizing EXACTLY the
-- Checkpoint A pure-domain shapes (`apps/api/src/modules/receivables/*`):
--
--   customer_receivable          — the AR anchor (INVOICE | OPENING).
--   customer_advance             — the customer liability (PAYMENT | OPENING).
--   customer_advance_application — Advance principal applied to a receivable.
--   customer_account_entry       — the append-only chronology (7 frozen kinds).
--
-- NO service/repository/controller/PostingEngine/audit/outbox/realtime code
-- anywhere in this migration. Additive, forward-only. All four tables are
-- append-only — no UPDATE, no DELETE, DB-blocked below.
--
-- ══════════════ CONCURRENCY-SAFE COVERAGE/CAPACITY BACKSTOPS (B7/B10/B14) ═══
-- Four shared helper functions below implement lock-then-validate: each
-- SELECTs its anchor row `FOR UPDATE` (serializing concurrent writers against
-- the SAME anchor), THEN recomputes the aggregate from already-committed rows,
-- THEN checks the proposed new amount against it. A concurrent second
-- transaction blocks at the `FOR UPDATE` until the first commits (or rolls
-- back), so by the time it proceeds its own aggregate read already reflects
-- the first transaction's committed insert — this is what makes "exactly one
-- of two concurrent 60+60-against-100 inserts succeeds" true, unlike a naive
-- unlocked aggregate CHECK/trigger.
--
-- ══════════════ CANONICAL LOCK ORDER (B15) ══════════════════════════════════
-- The frozen application hierarchy is Invoice(s) -> CustomerCompanyAccount ->
-- Payment -> CustomerAdvance. Every trigger below (and the next migration's
-- extended `payment_allocation` trigger) acquires locks in EXACTLY this
-- order and never the reverse:
--   * `customer_advance_application` insert (this file): locks the coverage
--     anchor first (the underlying `invoice` row for an INVOICE-sourced
--     receivable, or the `customer_receivable` row itself for OPENING — both
--     stand in for the "Invoice(s)" tier), THEN locks `customer_advance`.
--   * `customer_advance` insert, sourceType=PAYMENT (this file): locks
--     `payment` only (the "Payment" tier) — no Invoice/CustomerAdvance lock
--     is needed on this path.
--   * `payment_allocation` insert (NEXT migration, extending the existing
--     Checkpoint B trigger): locks `invoice` (Invoice tier) THEN `payment`
--     (Payment tier) — never the reverse.
-- No path ever locks Payment/CustomerAdvance before Invoice, and no path
-- locks CustomerAdvance before Payment — the fixed global order is sufficient
-- to rule out a deadlock between any two of these paths (a standard result:
-- if every transaction acquires locks in the same total order, a cycle in the
-- wait-for graph is impossible). CustomerCompanyAccount itself is not locked
-- by any Checkpoint B trigger — its projection columns (B12, next-next
-- migration) have no mutation path yet.

-- ══════════════ B6 dependency — Invoice branch-safe composite unique target
-- (created here, ahead of schedule, because `customer_receivable`'s own
-- composite FK below needs it; the NEXT migration
-- `20260927140000_receivables_allocation_fanout_and_capacity` reuses this
-- SAME index for `payment_allocation`'s branch-safe FK — B6's actual scope —
-- and does not recreate it) ══════════════════════════════════════════════
CREATE UNIQUE INDEX "invoice_tenantId_companyId_branchId_id_key" ON "invoice"("tenantId", "companyId", "branchId", "id");

-- ── CreateTable — customer_receivable ────────────────────────────────────────
CREATE TABLE "customer_receivable" (
    "id"                       UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                 UUID NOT NULL,
    "companyId"                UUID NOT NULL,
    "branchId"                 UUID NOT NULL,
    "customerCompanyAccountId" UUID NOT NULL,
    "sourceType"               TEXT NOT NULL,
    "invoiceId"                UUID,
    "creditAuthorized"         BOOLEAN,
    "openingAmountMinor"       BIGINT,
    "currencyCode"             TEXT,
    "currencyExponent"         SMALLINT,
    "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId"          UUID,

    CONSTRAINT "customer_receivable_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — customer_advance ───────────────────────────────────────────
CREATE TABLE "customer_advance" (
    "id"                       UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                 UUID NOT NULL,
    "companyId"                UUID NOT NULL,
    "branchId"                 UUID NOT NULL,
    "customerCompanyAccountId" UUID NOT NULL,
    "sourceType"               TEXT NOT NULL,
    "sourcePaymentId"          UUID,
    "amountMinor"              BIGINT NOT NULL,
    "currencyCode"             TEXT NOT NULL,
    "currencyExponent"         SMALLINT NOT NULL,
    "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId"          UUID,

    CONSTRAINT "customer_advance_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — customer_advance_application ───────────────────────────────
CREATE TABLE "customer_advance_application" (
    "id"                    UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"              UUID NOT NULL,
    "companyId"             UUID NOT NULL,
    "branchId"              UUID NOT NULL,
    "customerAdvanceId"     UUID NOT NULL,
    "customerReceivableId"  UUID NOT NULL,
    "amountMinor"           BIGINT NOT NULL,
    "currencyCode"          TEXT NOT NULL,
    "currencyExponent"      SMALLINT NOT NULL,
    "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId"       UUID,

    CONSTRAINT "customer_advance_application_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — customer_account_entry ─────────────────────────────────────
CREATE TABLE "customer_account_entry" (
    "id"                            UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                      UUID NOT NULL,
    "companyId"                     UUID NOT NULL,
    "branchId"                      UUID NOT NULL,
    "customerCompanyAccountId"      UUID NOT NULL,
    "entryKind"                     TEXT NOT NULL,
    "customerReceivableId"          UUID,
    "paymentId"                     UUID,
    "paymentAllocationId"           UUID,
    "customerAdvanceId"             UUID,
    "customerAdvanceApplicationId"  UUID,
    "occurredAt"                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_account_entry_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "customer_receivable_tenantId_id_key" ON "customer_receivable"("tenantId", "id");
CREATE UNIQUE INDEX "customer_receivable_tenantId_companyId_id_key" ON "customer_receivable"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "customer_receivable_invoiceId_key" ON "customer_receivable"("invoiceId");
CREATE INDEX "customer_receivable_tenantId_companyId_idx" ON "customer_receivable"("tenantId", "companyId");
CREATE INDEX "customer_receivable_customerCompanyAccountId_idx" ON "customer_receivable"("customerCompanyAccountId");

CREATE UNIQUE INDEX "customer_advance_tenantId_id_key" ON "customer_advance"("tenantId", "id");
CREATE UNIQUE INDEX "customer_advance_tenantId_companyId_id_key" ON "customer_advance"("tenantId", "companyId", "id");
CREATE INDEX "customer_advance_tenantId_companyId_idx" ON "customer_advance"("tenantId", "companyId");
CREATE INDEX "customer_advance_customerCompanyAccountId_idx" ON "customer_advance"("customerCompanyAccountId");
CREATE INDEX "customer_advance_sourcePaymentId_idx" ON "customer_advance"("sourcePaymentId");

CREATE UNIQUE INDEX "customer_advance_application_tenantId_id_key" ON "customer_advance_application"("tenantId", "id");
CREATE UNIQUE INDEX "customer_advance_application_tenantId_companyId_id_key" ON "customer_advance_application"("tenantId", "companyId", "id");
CREATE INDEX "customer_advance_application_tenantId_companyId_idx" ON "customer_advance_application"("tenantId", "companyId");
CREATE INDEX "customer_advance_application_customerAdvanceId_idx" ON "customer_advance_application"("customerAdvanceId");
CREATE INDEX "customer_advance_application_customerReceivableId_idx" ON "customer_advance_application"("customerReceivableId");

CREATE UNIQUE INDEX "customer_account_entry_tenantId_id_key" ON "customer_account_entry"("tenantId", "id");
CREATE UNIQUE INDEX "customer_account_entry_customerReceivableId_key" ON "customer_account_entry"("customerReceivableId");
CREATE UNIQUE INDEX "customer_account_entry_paymentId_key" ON "customer_account_entry"("paymentId");
CREATE UNIQUE INDEX "customer_account_entry_paymentAllocationId_key" ON "customer_account_entry"("paymentAllocationId");
CREATE UNIQUE INDEX "customer_account_entry_customerAdvanceId_key" ON "customer_account_entry"("customerAdvanceId");
CREATE UNIQUE INDEX "customer_account_entry_customerAdvanceApplicationId_key" ON "customer_account_entry"("customerAdvanceApplicationId");
CREATE INDEX "customer_account_entry_tenantId_companyId_idx" ON "customer_account_entry"("tenantId", "companyId");
CREATE INDEX "customer_account_entry_customerCompanyAccountId_occurredAt_idx" ON "customer_account_entry"("customerCompanyAccountId", "occurredAt");

-- ── AddForeignKey — plain FKs ─────────────────────────────────────────────────
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "customer_receivable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "customer_receivable_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_receivable_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_receivable_customerCompanyAccountId_fkey" FOREIGN KEY ("customerCompanyAccountId") REFERENCES "customer_company_account"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_receivable_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "customer_advance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_advance_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_advance_customerCompanyAccountId_fkey" FOREIGN KEY ("customerCompanyAccountId") REFERENCES "customer_company_account"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_advance_sourcePaymentId_fkey" FOREIGN KEY ("sourcePaymentId") REFERENCES "payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "customer_advance_application"
  ADD CONSTRAINT "customer_advance_application_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "customer_advance_application_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_advance_application_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_advance_application_customerAdvanceId_fkey" FOREIGN KEY ("customerAdvanceId") REFERENCES "customer_advance"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_advance_application_customerReceivableId_fkey" FOREIGN KEY ("customerReceivableId") REFERENCES "customer_receivable"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "customer_account_entry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_account_entry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_account_entry_customerCompanyAccountId_fkey" FOREIGN KEY ("customerCompanyAccountId") REFERENCES "customer_company_account"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_account_entry_customerReceivableId_fkey" FOREIGN KEY ("customerReceivableId") REFERENCES "customer_receivable"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_account_entry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_account_entry_paymentAllocationId_fkey" FOREIGN KEY ("paymentAllocationId") REFERENCES "payment_allocation"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_account_entry_customerAdvanceId_fkey" FOREIGN KEY ("customerAdvanceId") REFERENCES "customer_advance"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_account_entry_customerAdvanceApplicationId_fkey" FOREIGN KEY ("customerAdvanceApplicationId") REFERENCES "customer_advance_application"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── AddForeignKey — composite tenant/company/branch-safe FKs ────────────────
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "customer_receivable_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_account_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerCompanyAccountId") REFERENCES "customer_company_account"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_invoice_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "invoiceId") REFERENCES "invoice"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode") REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_receivable_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent") REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_account_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerCompanyAccountId") REFERENCES "customer_company_account"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_source_payment_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "sourcePaymentId") REFERENCES "payment"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode") REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent") REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "customer_advance_application"
  ADD CONSTRAINT "customer_advance_application_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_application_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_application_advance_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerAdvanceId") REFERENCES "customer_advance"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_application_receivable_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerReceivableId") REFERENCES "customer_receivable"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_application_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode") REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_advance_application_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent") REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_account_entry_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_account_entry_account_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "customerCompanyAccountId") REFERENCES "customer_company_account"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- Note: FK columns above marked (tenantId, companyId, X) rather than a full
-- (tenantId, companyId, branchId, X) triple where the referenced table's
-- own branch is not independently meaningful for this cross-check (e.g. a
-- CustomerAdvance's OWN branch is where it was created, which need not equal
-- the branch of every receivable it is later applied against — a customer's
-- Advance is usable company-wide, mirroring CustomerCompanyAccount's own
-- company-scoped-not-branch-scoped identity). Same/cross-branch application
-- is intentionally allowed; only tenant/company scope is structurally closed.

-- ── CHECK constraints — closed vocabularies ──────────────────────────────────
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "customer_receivable_source_type_chk" CHECK ("sourceType" IN ('INVOICE', 'OPENING'));

ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_source_type_chk" CHECK ("sourceType" IN ('PAYMENT', 'OPENING'));

ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_kind_chk" CHECK ("entryKind" IN
    ('INVOICE', 'PAYMENT', 'PAYMENT_ALLOCATION', 'ADVANCE', 'ADVANCE_APPLIED', 'OPENING_RECEIVABLE', 'OPENING_ADVANCE'));

-- ── CHECK constraints — source shape XOR (mirrors the frozen Checkpoint A
--    pure-domain shape validators exactly: customer-receivable-source.ts /
--    customer-account-entry.ts) ────────────────────────────────────────────
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "customer_receivable_source_shape_chk" CHECK (
    ("sourceType" = 'INVOICE'
      AND "invoiceId" IS NOT NULL
      AND "creditAuthorized" IS NOT NULL
      AND "openingAmountMinor" IS NULL
      AND "currencyCode" IS NULL
      AND "currencyExponent" IS NULL)
    OR
    ("sourceType" = 'OPENING'
      AND "invoiceId" IS NULL
      AND "creditAuthorized" IS NULL
      AND "openingAmountMinor" IS NOT NULL AND "openingAmountMinor" >= 0
      AND "currencyCode" IS NOT NULL
      AND "currencyExponent" IS NOT NULL)
  );

ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_source_shape_chk" CHECK (
    ("sourceType" = 'PAYMENT' AND "sourcePaymentId" IS NOT NULL)
    OR ("sourceType" = 'OPENING' AND "sourcePaymentId" IS NULL)
  );

ALTER TABLE "customer_account_entry"
  ADD CONSTRAINT "customer_account_entry_reference_xor_chk" CHECK (
    ("entryKind" IN ('INVOICE', 'OPENING_RECEIVABLE')
      AND "customerReceivableId" IS NOT NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT'
      AND "paymentId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL)
    OR ("entryKind" = 'PAYMENT_ALLOCATION'
      AND "paymentAllocationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "customerAdvanceId" IS NULL AND "customerAdvanceApplicationId" IS NULL)
    OR ("entryKind" IN ('ADVANCE', 'OPENING_ADVANCE')
      AND "customerAdvanceId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceApplicationId" IS NULL)
    OR ("entryKind" = 'ADVANCE_APPLIED'
      AND "customerAdvanceApplicationId" IS NOT NULL AND "customerReceivableId" IS NULL AND "paymentId" IS NULL AND "paymentAllocationId" IS NULL AND "customerAdvanceId" IS NULL)
  );

-- ── CHECK constraints — defense-in-depth value shape ─────────────────────────
ALTER TABLE "customer_advance"
  ADD CONSTRAINT "customer_advance_amount_positive_chk" CHECK ("amountMinor" > 0);

ALTER TABLE "customer_advance_application"
  ADD CONSTRAINT "customer_advance_application_amount_positive_chk" CHECK ("amountMinor" > 0);

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "customer_receivable", "customer_advance", "customer_advance_application", "customer_account_entry" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_receivable", "customer_advance", "customer_advance_application", "customer_account_entry" TO flower_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_receivable", "customer_advance", "customer_advance_application", "customer_account_entry" TO flower_app;

-- ══════════════════════ Row-Level Security (CLAUDE.md rule 7) ═══════════════
ALTER TABLE "customer_receivable" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_receivable" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_receivable_tenant_isolation" ON "customer_receivable"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "customer_advance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_advance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_advance_tenant_isolation" ON "customer_advance"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "customer_advance_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_advance_application" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_advance_application_tenant_isolation" ON "customer_advance_application"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "customer_account_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_account_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_account_entry_tenant_isolation" ON "customer_account_entry"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ══════════════════════ shared lock-then-validate helpers (B7/B10/B14) ══════
-- Each is `RETURNS void` and RAISEs on violation — called via `PERFORM` from
-- the trigger functions below (and from the NEXT migration's extended
-- `payment_allocation` trigger). Referencing `customer_advance_application`/
-- `customer_advance` here is safe even though `payment_allocation`'s OWN
-- trigger (frozen in the prior `20260923120000_payments_core` migration)
-- predates this file — these functions are only ever CALLED after this
-- migration (and the next one, which wires the call sites) has fully applied.

CREATE FUNCTION fn_lock_and_validate_payment_capacity(p_payment_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  payment_amount BIGINT;
  consumed BIGINT;
BEGIN
  SELECT "amountMinor" INTO payment_amount FROM "payment" WHERE "id" = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment %: does not exist', p_payment_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO consumed FROM "payment_allocation" WHERE "paymentId" = p_payment_id;
  consumed := consumed + COALESCE((SELECT SUM("amountMinor") FROM "customer_advance" WHERE "sourcePaymentId" = p_payment_id), 0);
  IF consumed + p_proposed_amount > payment_amount THEN
    RAISE EXCEPTION 'payment %: consumption would exceed amountMinor (payment=%, already consumed=%, proposed=%)', p_payment_id, payment_amount, consumed, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fn_lock_and_validate_invoice_coverage(p_invoice_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  inv_total BIGINT;
  receivable_id UUID;
  covered BIGINT;
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
  IF covered + p_proposed_amount > inv_total THEN
    RAISE EXCEPTION 'invoice %: coverage would exceed totalAmountMinor (total=%, already covered=%, proposed=%)', p_invoice_id, inv_total, covered, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fn_lock_and_validate_opening_receivable_coverage(p_receivable_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  principal BIGINT;
  covered BIGINT;
BEGIN
  SELECT "openingAmountMinor" INTO principal FROM "customer_receivable" WHERE "id" = p_receivable_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_receivable %: does not exist', p_receivable_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO covered FROM "customer_advance_application" WHERE "customerReceivableId" = p_receivable_id;
  IF covered + p_proposed_amount > principal THEN
    RAISE EXCEPTION 'customer_receivable %: (OPENING) coverage would exceed openingAmountMinor (principal=%, already covered=%, proposed=%)', p_receivable_id, principal, covered, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fn_lock_and_validate_advance_capacity(p_advance_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  principal BIGINT;
  applied BIGINT;
BEGIN
  SELECT "amountMinor" INTO principal FROM "customer_advance" WHERE "id" = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance %: does not exist', p_advance_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO applied FROM "customer_advance_application" WHERE "customerAdvanceId" = p_advance_id;
  IF applied + p_proposed_amount > principal THEN
    RAISE EXCEPTION 'customer_advance %: application would exceed amountMinor (principal=%, already applied=%, proposed=%)', p_advance_id, principal, applied, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ structural integrity triggers (B8) ══════════════════
-- customer_receivable: INVOICE-sourced rows must reference a same-scope
-- Invoice belonging to an actual customer (a walk-in Invoice, whose Order has
-- no customerId, can never get a CustomerReceivable — 3b.6 architecture-
-- freeze: walk-in gets ZERO 3b.6 AR). OPENING rows need no cross-table check
-- beyond the account-scope check already run unconditionally.
CREATE FUNCTION fn_check_customer_receivable_integrity() RETURNS trigger AS $$
DECLARE
  inv RECORD;
  ord_customer_id UUID;
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

CREATE TRIGGER trg_check_customer_receivable_integrity
  BEFORE INSERT ON "customer_receivable"
  FOR EACH ROW EXECUTE FUNCTION fn_check_customer_receivable_integrity();

-- customer_advance: PAYMENT-sourced rows must reference a same-scope,
-- same-currency Payment whose attributed customer (via its sourceAttempt —
-- either the CUSTOMER_RECEIPT customerCompanyAccountId directly, or the
-- INVOICE_COLLECTION target Invoice's Order's customer) matches this row's
-- own customerCompanyAccountId, THEN locks+validates the shared payment
-- capacity (B7, canonical order: Payment tier only on this path).
CREATE FUNCTION fn_check_customer_advance_payment_source_integrity() RETURNS trigger AS $$
DECLARE
  pay RECORD;
  att RECORD;
  ord_customer_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "customer_company_account" cca
    WHERE cca."id" = NEW."customerCompanyAccountId" AND cca."tenantId" = NEW."tenantId" AND cca."companyId" = NEW."companyId"
  ) THEN
    RAISE EXCEPTION 'customer_advance %: referenced customerCompanyAccountId % does not exist in this tenant/company', NEW."id", NEW."customerCompanyAccountId";
  END IF;

  IF NEW."sourceType" != 'PAYMENT' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO pay FROM "payment" WHERE "id" = NEW."sourcePaymentId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance %: referenced sourcePaymentId % does not exist', NEW."id", NEW."sourcePaymentId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM pay."tenantId"
     OR NEW."companyId" IS DISTINCT FROM pay."companyId"
     OR NEW."branchId" IS DISTINCT FROM pay."branchId"
     OR NEW."currencyCode" IS DISTINCT FROM pay."currencyCode"
     OR NEW."currencyExponent" IS DISTINCT FROM pay."currencyExponent"
  THEN
    RAISE EXCEPTION 'customer_advance %: does not match its sourcePayment % (scope/currency)', NEW."id", NEW."sourcePaymentId";
  END IF;

  SELECT * INTO att FROM "payment_attempt" WHERE "id" = pay."sourceAttemptId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance %: sourcePayment %''s sourceAttempt does not exist', NEW."id", NEW."sourcePaymentId";
  END IF;

  IF att."receiptPurpose" = 'CUSTOMER_RECEIPT' THEN
    IF att."customerCompanyAccountId" IS DISTINCT FROM NEW."customerCompanyAccountId" THEN
      RAISE EXCEPTION 'customer_advance %: customerCompanyAccountId does not match sourcePayment %''s attributed customer account', NEW."id", NEW."sourcePaymentId";
    END IF;
  ELSE
    SELECT o."customerId" INTO ord_customer_id FROM "order" o WHERE o."id" = att."orderId";
    IF ord_customer_id IS NULL THEN
      RAISE EXCEPTION 'customer_advance %: sourcePayment %''s order has no associated customer (walk-in)', NEW."id", NEW."sourcePaymentId";
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "customer_company_account" cca
      WHERE cca."id" = NEW."customerCompanyAccountId" AND cca."customerId" = ord_customer_id AND cca."companyId" = NEW."companyId"
    ) THEN
      RAISE EXCEPTION 'customer_advance %: customerCompanyAccountId does not match sourcePayment %''s attributed customer', NEW."id", NEW."sourcePaymentId";
    END IF;
  END IF;

  PERFORM fn_lock_and_validate_payment_capacity(NEW."sourcePaymentId", NEW."amountMinor");

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_customer_advance_payment_source_integrity
  BEFORE INSERT ON "customer_advance"
  FOR EACH ROW EXECUTE FUNCTION fn_check_customer_advance_payment_source_integrity();

-- customer_advance_application: scope/currency/account match between the
-- referenced CustomerAdvance and CustomerReceivable, THEN locks+validates
-- receivable coverage (Invoice tier for INVOICE-sourced, the receivable
-- itself for OPENING) BEFORE locking+validating advance capacity (B15
-- canonical order: coverage anchor before CustomerAdvance).
CREATE FUNCTION fn_check_customer_advance_application_integrity() RETURNS trigger AS $$
DECLARE
  adv RECORD;
  recv RECORD;
BEGIN
  SELECT * INTO adv FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance_application %: referenced customerAdvanceId % does not exist', NEW."id", NEW."customerAdvanceId";
  END IF;
  SELECT * INTO recv FROM "customer_receivable" WHERE "id" = NEW."customerReceivableId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_advance_application %: referenced customerReceivableId % does not exist', NEW."id", NEW."customerReceivableId";
  END IF;

  IF NEW."tenantId" IS DISTINCT FROM adv."tenantId" OR NEW."companyId" IS DISTINCT FROM adv."companyId" OR NEW."branchId" IS DISTINCT FROM adv."branchId" THEN
    RAISE EXCEPTION 'customer_advance_application %: scope does not match customerAdvance %', NEW."id", NEW."customerAdvanceId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM recv."tenantId" OR NEW."companyId" IS DISTINCT FROM recv."companyId" THEN
    RAISE EXCEPTION 'customer_advance_application %: scope does not match customerReceivable %', NEW."id", NEW."customerReceivableId";
  END IF;
  IF adv."customerCompanyAccountId" IS DISTINCT FROM recv."customerCompanyAccountId" THEN
    RAISE EXCEPTION 'customer_advance_application %: customerAdvance %''s account does not match customerReceivable %''s account', NEW."id", NEW."customerAdvanceId", NEW."customerReceivableId";
  END IF;
  IF NEW."currencyCode" IS DISTINCT FROM adv."currencyCode" OR NEW."currencyExponent" IS DISTINCT FROM adv."currencyExponent" THEN
    RAISE EXCEPTION 'customer_advance_application %: currency does not match customerAdvance %', NEW."id", NEW."customerAdvanceId";
  END IF;

  IF recv."sourceType" = 'INVOICE' THEN
    PERFORM fn_lock_and_validate_invoice_coverage(recv."invoiceId", NEW."amountMinor");
  ELSE
    PERFORM fn_lock_and_validate_opening_receivable_coverage(recv."id", NEW."amountMinor");
  END IF;

  PERFORM fn_lock_and_validate_advance_capacity(NEW."customerAdvanceId", NEW."amountMinor");

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_customer_advance_application_integrity
  BEFORE INSERT ON "customer_advance_application"
  FOR EACH ROW EXECUTE FUNCTION fn_check_customer_advance_application_integrity();

-- customer_account_entry: cross-table sourceType consistency (B11) — a
-- Postgres CHECK cannot query another table, so this is trigger-enforced.
-- PAYMENT / PAYMENT_ALLOCATION / ADVANCE_APPLIED need no extra check here —
-- their sole reference column already carries a real FK (above), and there
-- is no second "sourceType" on those 3 tables to cross-validate against.
CREATE FUNCTION fn_check_customer_account_entry_source_type() RETURNS trigger AS $$
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
  ELSIF NEW."entryKind" IN ('ADVANCE', 'OPENING_ADVANCE') THEN
    SELECT "sourceType" INTO adv_source_type FROM "customer_advance" WHERE "id" = NEW."customerAdvanceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_account_entry %: referenced customerAdvanceId % does not exist', NEW."id", NEW."customerAdvanceId";
    END IF;
    IF NEW."entryKind" = 'ADVANCE' AND adv_source_type IS DISTINCT FROM 'PAYMENT' THEN
      RAISE EXCEPTION 'customer_account_entry %: entryKind ADVANCE requires customerAdvance %''s sourceType = PAYMENT (got %)', NEW."id", NEW."customerAdvanceId", adv_source_type;
    END IF;
    IF NEW."entryKind" = 'OPENING_ADVANCE' AND adv_source_type IS DISTINCT FROM 'OPENING' THEN
      RAISE EXCEPTION 'customer_account_entry %: entryKind OPENING_ADVANCE requires customerAdvance %''s sourceType = OPENING (got %)', NEW."id", NEW."customerAdvanceId", adv_source_type;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_customer_account_entry_source_type
  BEFORE INSERT ON "customer_account_entry"
  FOR EACH ROW EXECUTE FUNCTION fn_check_customer_account_entry_source_type();

-- ══════════════════════ append-only — no UPDATE, no DELETE, ever ═══════════
CREATE FUNCTION fn_enforce_customer_receivable_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_receivable %: is append-only — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_receivable_no_update BEFORE UPDATE ON "customer_receivable" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_receivable_no_update();

CREATE FUNCTION fn_enforce_customer_receivable_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_receivable %: is append-only — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_receivable_no_delete BEFORE DELETE ON "customer_receivable" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_receivable_no_delete();

CREATE FUNCTION fn_enforce_customer_advance_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_advance %: is append-only — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_advance_no_update BEFORE UPDATE ON "customer_advance" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_advance_no_update();

CREATE FUNCTION fn_enforce_customer_advance_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_advance %: is append-only — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_advance_no_delete BEFORE DELETE ON "customer_advance" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_advance_no_delete();

CREATE FUNCTION fn_enforce_customer_advance_application_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_advance_application %: is append-only — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_advance_application_no_update BEFORE UPDATE ON "customer_advance_application" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_advance_application_no_update();

CREATE FUNCTION fn_enforce_customer_advance_application_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_advance_application %: is append-only — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_advance_application_no_delete BEFORE DELETE ON "customer_advance_application" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_advance_application_no_delete();

CREATE FUNCTION fn_enforce_customer_account_entry_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_account_entry %: is append-only — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_account_entry_no_update BEFORE UPDATE ON "customer_account_entry" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_account_entry_no_update();

CREATE FUNCTION fn_enforce_customer_account_entry_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_account_entry %: is append-only — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_enforce_customer_account_entry_no_delete BEFORE DELETE ON "customer_account_entry" FOR EACH ROW EXECUTE FUNCTION fn_enforce_customer_account_entry_no_delete();
