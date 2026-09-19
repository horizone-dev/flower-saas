-- Phase 3b task 3b.2 — CRM / Customer Core. Additive, forward-only.
--
--   * `customer` — TENANT-scoped identity (D3b-5). UUID-only, no customer code.
--     `phoneE164`/`emailNormalized` are deliberately NOT unique — duplicates are
--     allowed by design (shared family phones/business emails, no hidden
--     auto-merge); plain indexes support exact-match lookup only.
--   * `customer_company_account` — the explicit, COMPANY-scoped financial-
--     relationship boundary (D3b-5/§C.2). Created atomically the moment a
--     Customer is first associated with a Company. `creditLimit*` is a
--     self-describing 3-column Money snapshot (mirrors
--     `company_variant_uom_price.purchaseAmountMinor/purchaseCurrencyCode/
--     purchaseCurrencyExponent`) so a later Company-currency change can never
--     cause `creditLimitMinor` to be silently reinterpreted. No
--     `currentOutstanding`/`availableCredit`/`advanceBalance` — those are 3b.6
--     additive columns once the append-only AR/Advance subledger exists.
--   * RLS/composite-FK conventions copied verbatim from task 3b.1's
--     `20260915120000_accounting_coa_posting_periods` — company-level PII/
--     financial separation is a service/query-layer concern (`listForCompany`
--     joins through this table), not an RLS concern, matching the
--     account/accounting_period precedent exactly.

-- ── CreateTable — customer ───────────────────────────────────────────────────
CREATE TABLE "customer" (
    "id"              UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"        UUID NOT NULL,
    "displayName"     TEXT NOT NULL,
    "phoneE164"       TEXT,
    "emailNormalized" TEXT,
    "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
    "version"         INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" UUID,
    "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — customer_company_account ──────────────────────────────────
CREATE TABLE "customer_company_account" (
    "id"                          UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                    UUID NOT NULL,
    "companyId"                   UUID NOT NULL,
    "customerId"                  UUID NOT NULL,
    "creditEnabled"               BOOLEAN NOT NULL DEFAULT false,
    "creditLimitMinor"            BIGINT,
    "creditLimitCurrencyCode"     TEXT,
    "creditLimitCurrencyExponent" SMALLINT,
    "version"                     INTEGER NOT NULL DEFAULT 1,
    "createdAt"                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_company_account_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "customer_tenantId_id_key" ON "customer"("tenantId", "id");
CREATE INDEX "customer_tenantId_phoneE164_idx" ON "customer"("tenantId", "phoneE164");
CREATE INDEX "customer_tenantId_emailNormalized_idx" ON "customer"("tenantId", "emailNormalized");

CREATE UNIQUE INDEX "customer_company_account_tenantId_companyId_customerId_key" ON "customer_company_account"("tenantId", "companyId", "customerId");

-- ── AddForeignKey — plain FKs ────────────────────────────────────────────────
ALTER TABLE "customer"
  ADD CONSTRAINT "customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "customer_company_account"
  ADD CONSTRAINT "customer_company_account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "customer_company_account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "customer_company_account_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── AddForeignKey — composite tenant-safe FKs (structural integrity, mirrors
--    task 3b.1's journal_line composite-FK pattern) — an association cannot
--    reference a customer/company from a different tenant even under an
--    application bug. RLS remains defense-in-depth, not primary. ───────────
ALTER TABLE "customer_company_account"
  ADD CONSTRAINT "customer_company_account_customer_tenant_fkey"
    FOREIGN KEY ("tenantId", "customerId")
    REFERENCES "customer"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "customer_company_account_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ── CHECK constraints ─────────────────────────────────────────────────────────
ALTER TABLE "customer"
  ADD CONSTRAINT "customer_status_chk" CHECK ("status" IN ('ACTIVE', 'ARCHIVED'));

-- all-or-nothing Money snapshot (task 3b.2 §8) — a partial set would leave a
-- creditLimitMinor value with no currency/exponent to interpret it by.
ALTER TABLE "customer_company_account"
  ADD CONSTRAINT "customer_company_account_credit_limit_money_shape_chk"
  CHECK (
    (("creditLimitMinor" IS NULL) = ("creditLimitCurrencyCode" IS NULL))
    AND (("creditLimitCurrencyCode" IS NULL) = ("creditLimitCurrencyExponent" IS NULL))
  );

-- defense-in-depth: a stored limit, when present, is never zero/negative.
-- The enabled/disabled cross-column business rule (task 3b.2 §6) stays at the
-- application layer since it depends on `creditEnabled` too.
ALTER TABLE "customer_company_account"
  ADD CONSTRAINT "customer_company_account_credit_limit_positive_chk"
  CHECK ("creditLimitMinor" IS NULL OR "creditLimitMinor" > 0);

-- creditEnabled=true REQUIRES a configured credit-limit Money snapshot (task
-- 3b.2 owner review round 3). Only `creditLimitMinor IS NOT NULL` needs
-- checking here — the money-shape CHECK above already guarantees
-- currency/exponent are present whenever `creditLimitMinor` is, and the
-- positive CHECK above already guarantees it's > 0 when present. Disabled
-- rows are unconstrained by this CHECK (a stored positive limit may remain
-- for later re-enable, or be absent entirely).
ALTER TABLE "customer_company_account"
  ADD CONSTRAINT "customer_company_account_credit_enabled_requires_limit_chk"
  CHECK (NOT "creditEnabled" OR "creditLimitMinor" IS NOT NULL);

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "customer", "customer_company_account" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer", "customer_company_account" TO flower_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer", "customer_company_account" TO flower_app;

-- ══════════════════════ Row-Level Security ══════════════════════════════════
-- Tenant-only, exactly matching the account/accounting_period precedent —
-- company-level PII/financial separation is a service/query-layer concern,
-- not an RLS concern (task 3b.2 §8/§18).
ALTER TABLE "customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_tenant_isolation" ON "customer"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "customer_company_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_company_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_company_account_tenant_isolation" ON "customer_company_account"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
