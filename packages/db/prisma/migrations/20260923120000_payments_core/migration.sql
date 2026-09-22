-- Phase 3b task 3b.5 CHECKPOINT B — Payments: schema, RLS, structural
-- backstops ONLY. Contract frozen across 4 owner review rounds
-- (docs/phase-3/PHASE-3B-PLAN.md §E). Additive, forward-only.
--
-- NO service / repository / controller / provider network call / webhook
-- handler / SecretsService integration / audit / outbox / realtime /
-- Invoice.invoicePaymentStatus mutation / PostingEngine / AR / Advance /
-- Settlement / Refund / Credit Note / Inventory / frontend code anywhere in
-- this migration. Six new tables:
--
--   payment                  — CONFIRMED RECEIPT ONLY. No status, no
--                              version, no invoiceId. Fully immutable after
--                              INSERT.
--   payment_attempt          — the mechanical/provider lifecycle. Reuses
--                              the already-Accepted ARCHITECTURE.md §42-43
--                              state vocabulary verbatim.
--   payment_allocation       — the ONLY authoritative Payment->Invoice
--                              relationship. Append-only, exactly one row
--                              per Payment in 3b.5.
--   payment_attempt_event    — append-only state-transition log.
--   provider_payment_event   — the webhook inbox. No raw payload column.
--   payment_webhook_endpoint — the opaque webhook-routing primitive, 1:1
--                              with a provider_credential.
--
-- ══════════════ CROSS-ROW FINANCIAL LIMIT — DELIBERATELY NOT HERE ═══════════
-- The invariant "confirmed allocations + active reservations <= invoice
-- total" requires locking the target Invoice row and orchestrating a
-- multi-statement transaction (recompute availableToCollect under the lock,
-- then insert). That is NOT expressible as a naive aggregate CHECK or
-- per-row trigger without a race (two concurrent inserts each re-reading a
-- stale aggregate before either commits). This migration's DB role is
-- STRUCTURAL integrity only — exact 1:1 pairwise matching, referential
-- correctness, immutability, and closed vocabularies. The cross-row
-- financial limit itself is enforced by application logic under an
-- explicit Invoice lock in a later checkpoint (C/E/G). Do NOT mistake this
-- section's absence of a cross-row CHECK for an omission — it is
-- intentional and documented identically in
-- packages/db/test/payments-core.integration.test.ts.
--
-- ══════════════ PROVIDERCREDENTIAL SCOPE — FROZEN BRANCH-SCOPED FOR PAYMENTS
-- `provider_credential.companyId`/`branchId` are nullable at the shared-table
-- level (a credential may be tenant-wide, company-wide, or branch-specific
-- for OTHER platform domains — WhatsApp/AI/SMS). `provider_credential` itself
-- is NOT redesigned here. But Task 3b.5's own payment usage is FROZEN
-- branch-specific (owner final security pass, item 2): every trigger below
-- that consumes a `providerCredentialId` for a payment purpose
-- (`payment_attempt`, `payment_webhook_endpoint`, `provider_payment_event`)
-- REQUIRES the referenced credential to have `companyId` AND `branchId` both
-- NOT NULL, and requires an EXACT (never NULL-tolerant) match against its own
-- tenant/company/branch. A tenant-wide or company-only credential may
-- continue to exist for other domains but is unconditionally rejected for
-- any payment use. `payment_attempt` additionally requires `providerKey` to
-- exactly equal the credential's own `provider` column.

-- ── CreateTable — payment_attempt ────────────────────────────────────────────
CREATE TABLE "payment_attempt" (
    "id"                                            UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                                      UUID NOT NULL,
    "companyId"                                     UUID NOT NULL,
    "branchId"                                      UUID NOT NULL,
    "orderId"                                       UUID NOT NULL,
    "targetInvoiceId"                               UUID NOT NULL,
    "paymentGroupId"                                UUID,
    "method"                                        TEXT NOT NULL,
    "providerKey"                                   TEXT,
    "providerCredentialId"                          UUID,
    "amountMinor"                                   BIGINT NOT NULL,
    "currencyCode"                                  TEXT NOT NULL,
    "currencyExponent"                              SMALLINT NOT NULL,
    "state"                                         TEXT NOT NULL DEFAULT 'PENDING',
    "orderCommercialSnapshotFingerprintAtCreation"  TEXT NOT NULL,
    "orderVersionAtCreation"                        INTEGER NOT NULL,
    "providerReference"                             TEXT,
    "idempotencyKey"                                TEXT NOT NULL,
    "createdByUserId"                               UUID,
    "actingUserId"                                  UUID,
    "createdAt"                                     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                                     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — payment ────────────────────────────────────────────────────
CREATE TABLE "payment" (
    "id"                 UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"           UUID NOT NULL,
    "companyId"          UUID NOT NULL,
    "branchId"           UUID NOT NULL,
    "paymentGroupId"     UUID,
    "sourceAttemptId"    UUID NOT NULL,
    "method"             TEXT NOT NULL,
    "providerKey"        TEXT,
    "amountMinor"        BIGINT NOT NULL,
    "currencyCode"       TEXT NOT NULL,
    "currencyExponent"   SMALLINT NOT NULL,
    "createdByUserId"    UUID,
    "actingUserId"       UUID,
    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — payment_allocation ─────────────────────────────────────────
CREATE TABLE "payment_allocation" (
    "id"               UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"         UUID NOT NULL,
    "companyId"        UUID NOT NULL,
    "branchId"         UUID NOT NULL,
    "paymentId"        UUID NOT NULL,
    "invoiceId"        UUID NOT NULL,
    "amountMinor"      BIGINT NOT NULL,
    "currencyCode"     TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — payment_attempt_event ──────────────────────────────────────
CREATE TABLE "payment_attempt_event" (
    "id"                     UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"               UUID NOT NULL,
    "companyId"              UUID NOT NULL,
    "branchId"               UUID NOT NULL,
    "paymentAttemptId"       UUID NOT NULL,
    "fromState"              TEXT NOT NULL,
    "toState"                TEXT NOT NULL,
    "occurredAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source"                 TEXT NOT NULL,
    "providerPaymentEventId" UUID,

    CONSTRAINT "payment_attempt_event_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — provider_payment_event ─────────────────────────────────────
CREATE TABLE "provider_payment_event" (
    "id"                   UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"             UUID NOT NULL,
    "companyId"            UUID NOT NULL,
    "branchId"             UUID NOT NULL,
    "providerCredentialId" UUID NOT NULL,
    "providerEventId"      TEXT NOT NULL,
    "eventType"            TEXT NOT NULL,
    "receivedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadHash"          TEXT NOT NULL,
    "status"               TEXT NOT NULL DEFAULT 'RECEIVED',
    "sanitizedMetadata"    JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "provider_payment_event_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — payment_webhook_endpoint ───────────────────────────────────
CREATE TABLE "payment_webhook_endpoint" (
    "id"                   UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"             UUID NOT NULL,
    "companyId"            UUID,
    "branchId"             UUID,
    "providerCredentialId" UUID NOT NULL,
    "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "payment_attempt_tenantId_id_key" ON "payment_attempt"("tenantId", "id");
CREATE UNIQUE INDEX "payment_attempt_tenantId_companyId_id_key" ON "payment_attempt"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "payment_attempt_tenantId_companyId_branchId_id_key" ON "payment_attempt"("tenantId", "companyId", "branchId", "id");
CREATE INDEX "payment_attempt_tenantId_companyId_idx" ON "payment_attempt"("tenantId", "companyId");
CREATE INDEX "payment_attempt_providerCredentialId_idx" ON "payment_attempt"("providerCredentialId");
CREATE INDEX "payment_attempt_paymentGroupId_idx" ON "payment_attempt"("paymentGroupId");
-- the reservation-computation query shape (owner contract round 4 §1): a
-- partial index on exactly the 3 active-reservation states, keyed by the
-- target invoice — `availableToCollect` (a later checkpoint) filters this
-- set further by `NOT EXISTS (SELECT 1 FROM payment WHERE "sourceAttemptId"
-- = payment_attempt.id)`, already served by `payment_sourceAttemptId_key`.
CREATE INDEX "payment_attempt_reservation_idx" ON "payment_attempt"("targetInvoiceId")
  WHERE "state" IN ('PENDING', 'REQUIRES_ACTION', 'AUTHORIZED');

CREATE UNIQUE INDEX "payment_tenantId_id_key" ON "payment"("tenantId", "id");
CREATE UNIQUE INDEX "payment_tenantId_companyId_id_key" ON "payment"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "payment_tenantId_companyId_branchId_id_key" ON "payment"("tenantId", "companyId", "branchId", "id");
CREATE UNIQUE INDEX "payment_sourceAttemptId_key" ON "payment"("sourceAttemptId");
CREATE INDEX "payment_tenantId_companyId_idx" ON "payment"("tenantId", "companyId");
CREATE INDEX "payment_paymentGroupId_idx" ON "payment"("paymentGroupId");

CREATE UNIQUE INDEX "payment_allocation_tenantId_id_key" ON "payment_allocation"("tenantId", "id");
CREATE UNIQUE INDEX "payment_allocation_paymentId_key" ON "payment_allocation"("paymentId");
CREATE INDEX "payment_allocation_tenantId_companyId_idx" ON "payment_allocation"("tenantId", "companyId");
-- confirmedAmount / payment-summary query support (a later checkpoint):
-- `SELECT SUM("amountMinor") FROM payment_allocation WHERE "invoiceId" = $1`.
CREATE INDEX "payment_allocation_invoiceId_idx" ON "payment_allocation"("invoiceId");

CREATE INDEX "payment_attempt_event_tenantId_companyId_idx" ON "payment_attempt_event"("tenantId", "companyId");
CREATE INDEX "payment_attempt_event_paymentAttemptId_idx" ON "payment_attempt_event"("paymentAttemptId");

CREATE UNIQUE INDEX "provider_payment_event_providerCredentialId_providerEventId_key" ON "provider_payment_event"("providerCredentialId", "providerEventId");
CREATE INDEX "provider_payment_event_tenantId_companyId_receivedAt_idx" ON "provider_payment_event"("tenantId", "companyId", "receivedAt");

CREATE UNIQUE INDEX "payment_webhook_endpoint_providerCredentialId_key" ON "payment_webhook_endpoint"("providerCredentialId");

-- required so `payment_attempt.targetInvoiceId` can be composite-FK-bound to
-- "the Invoice whose own orderId equals this attempt's orderId" (B7) — the
-- existing `invoice_tenantId_companyId_orderId_key` is already unique on the
-- narrower (tenantId, companyId, orderId); widening by `id` (itself already
-- unique) is a trivially-safe additive index, never a behavior change.
CREATE UNIQUE INDEX "invoice_tenantId_companyId_orderId_id_key" ON "invoice"("tenantId", "companyId", "orderId", "id");

-- ── AddForeignKey — plain FKs (tenant / company / branch / id-only refs) ────
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "payment_attempt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_targetInvoiceId_fkey" FOREIGN KEY ("targetInvoiceId") REFERENCES "invoice"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credential"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "payment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_sourceAttemptId_fkey" FOREIGN KEY ("sourceAttemptId") REFERENCES "payment_attempt"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "payment_allocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "payment_allocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_allocation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_allocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_allocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "payment_attempt_event"
  ADD CONSTRAINT "payment_attempt_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "payment_attempt_event_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_event_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_event_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempt"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_attempt_event_providerPaymentEventId_fkey" FOREIGN KEY ("providerPaymentEventId") REFERENCES "provider_payment_event"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "provider_payment_event"
  ADD CONSTRAINT "provider_payment_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "provider_payment_event_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "provider_payment_event_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "provider_payment_event_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credential"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "payment_webhook_endpoint"
  ADD CONSTRAINT "payment_webhook_endpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "payment_webhook_endpoint_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_webhook_endpoint_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "payment_webhook_endpoint_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credential"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── AddForeignKey — composite tenant/company/branch-safe FKs (structural
--    integrity) — a row cannot reference a tenant/company/branch/order/
--    invoice from outside its own scope even under an application bug.
--    RLS remains defense-in-depth, not primary. ──────────────────────────────
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_attempt_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_attempt_order_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "orderId")
    REFERENCES "order"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  -- B7: the target Invoice must be the ONE whose OWN orderId equals this
  -- attempt's orderId — not merely an arbitrary same-tenant Order/Invoice
  -- pairing. Realized as a genuine 4-column composite FK (no trigger
  -- needed) against the additive `invoice_tenantId_companyId_orderId_id_key`
  -- unique index created above.
  ADD CONSTRAINT "payment_attempt_target_invoice_order_fkey"
    FOREIGN KEY ("tenantId", "companyId", "orderId", "targetInvoiceId")
    REFERENCES "invoice"("tenantId", "companyId", "orderId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  -- currency authority — mirrors Order/Invoice's own precedent exactly: the
  -- stored currency must be the company's CURRENT default currency, and a
  -- stored exponent can never diverge from the currency's authoritative one.
  ADD CONSTRAINT "payment_attempt_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_attempt_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_source_attempt_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "sourceAttemptId")
    REFERENCES "payment_attempt"("tenantId", "companyId", "branchId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "payment_allocation_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_allocation_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_allocation_payment_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "paymentId")
    REFERENCES "payment"("tenantId", "companyId", "branchId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_allocation_invoice_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "invoiceId")
    REFERENCES "invoice"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_allocation_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode")
    REFERENCES "company"("tenantId", "id", "defaultCurrency")
    ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_allocation_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent")
    REFERENCES "currency"("code", "exponent")
    ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "payment_attempt_event"
  ADD CONSTRAINT "payment_attempt_event_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_attempt_event_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_attempt_event_attempt_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "paymentAttemptId")
    REFERENCES "payment_attempt"("tenantId", "companyId", "branchId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE "provider_payment_event"
  ADD CONSTRAINT "provider_payment_event_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "provider_payment_event_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE "payment_webhook_endpoint"
  ADD CONSTRAINT "payment_webhook_endpoint_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "company"("tenantId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "payment_webhook_endpoint_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ── CHECK constraints — closed vocabularies (never a native Postgres ENUM) ──
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_method_chk" CHECK ("method" IN (
    'CASH', 'CARD_TERMINAL', 'BANK_TRANSFER', 'ONLINE_GATEWAY', 'OTHER_MANUAL'
  )),
  ADD CONSTRAINT "payment_attempt_state_chk" CHECK ("state" IN (
    'PENDING', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELED',
    'PARTIALLY_REFUNDED', 'REFUNDED'
  ));

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_method_chk" CHECK ("method" IN (
    'CASH', 'CARD_TERMINAL', 'BANK_TRANSFER', 'ONLINE_GATEWAY', 'OTHER_MANUAL'
  ));

ALTER TABLE "payment_attempt_event"
  ADD CONSTRAINT "payment_attempt_event_source_chk" CHECK ("source" IN ('SYSTEM', 'WEBHOOK', 'USER')),
  ADD CONSTRAINT "payment_attempt_event_from_state_chk" CHECK ("fromState" IN (
    'PENDING', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELED',
    'PARTIALLY_REFUNDED', 'REFUNDED'
  )),
  ADD CONSTRAINT "payment_attempt_event_to_state_chk" CHECK ("toState" IN (
    'PENDING', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELED',
    'PARTIALLY_REFUNDED', 'REFUNDED'
  ));

ALTER TABLE "provider_payment_event"
  ADD CONSTRAINT "provider_payment_event_status_chk" CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'EXCEPTION'));

-- ── CHECK constraints — tender/provider shape (B4) — CREDIT/ADVANCE/WALLET/
--    STORE_CREDIT/LOYALTY/REFUND never appear in the method vocabulary above
--    at all, so no separate CHECK is needed to exclude them. ────────────────
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_tender_provider_shape_chk" CHECK (
    ("method" = 'ONLINE_GATEWAY' AND "providerCredentialId" IS NOT NULL AND "providerKey" IS NOT NULL)
    OR ("method" = 'CARD_TERMINAL' AND (
         ("providerCredentialId" IS NULL AND "providerKey" IS NULL)
      OR ("providerCredentialId" IS NOT NULL AND "providerKey" IS NOT NULL)
    ))
    OR ("method" IN ('CASH', 'BANK_TRANSFER', 'OTHER_MANUAL')
        AND "providerCredentialId" IS NULL AND "providerKey" IS NULL)
  );

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_provider_key_shape_chk" CHECK (
    ("method" IN ('CASH', 'BANK_TRANSFER', 'OTHER_MANUAL') AND "providerKey" IS NULL)
    OR ("method" = 'ONLINE_GATEWAY' AND "providerKey" IS NOT NULL)
    OR ("method" = 'CARD_TERMINAL')
  );

-- ── CHECK constraints — defense-in-depth value shape (B18) ───────────────────
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_amount_positive_chk" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "payment_attempt_order_version_positive_chk" CHECK ("orderVersionAtCreation" >= 1);

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_amount_positive_chk" CHECK ("amountMinor" > 0);

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "payment_allocation_amount_positive_chk" CHECK ("amountMinor" > 0);

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "payment_attempt", "payment", "payment_allocation", "payment_attempt_event", "provider_payment_event", "payment_webhook_endpoint" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_attempt", "payment", "payment_allocation", "payment_attempt_event", "provider_payment_event", "payment_webhook_endpoint" TO flower_platform;
-- full DML — tenant business data written via runScoped / flower_app; RLS
-- narrows every statement to the request tenant. The trigger set below
-- applies regardless of role (including flower_app), same discipline as
-- every prior financial-table migration in this repository (3b.1's
-- sealed-journal backstop, 3b.3's Checkpoint C invoice/order freeze).
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_attempt", "payment", "payment_allocation", "payment_attempt_event", "provider_payment_event", "payment_webhook_endpoint" TO flower_app;

-- ══════════════════════ Row-Level Security (CLAUDE.md rule 7) ═══════════════
ALTER TABLE "payment_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_attempt_tenant_isolation" ON "payment_attempt"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_tenant_isolation" ON "payment"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "payment_allocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_allocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_allocation_tenant_isolation" ON "payment_allocation"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "payment_attempt_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_attempt_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_attempt_event_tenant_isolation" ON "payment_attempt_event"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "provider_payment_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_payment_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_payment_event_tenant_isolation" ON "provider_payment_event"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- NOT a generic public pre-scope policy — this remains ordinary tenant RLS,
-- exactly like `provider_credential` itself. The webhook pre-scope resolver
-- (Checkpoint F) reaches this table via the existing platform/BYPASSRLS
-- `PlatformRepository` convention, never via a special-cased policy here.
ALTER TABLE "payment_webhook_endpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_webhook_endpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_webhook_endpoint_tenant_isolation" ON "payment_webhook_endpoint"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ══════════════════════ structural integrity triggers (B5/B6/B7/B8) ════════

-- Trigger — payment_attempt.providerCredentialId scope + provider integrity
-- (B8, owner final security pass item 2). Task 3b.5 payment provider
-- credentials are FROZEN branch-specific: the referenced ProviderCredential
-- must have companyId AND branchId both NOT NULL, and must EXACTLY match
-- this attempt's own tenant/company/branch (no NULL-tolerant "applies more
-- broadly" case for payments — that remains valid for OTHER ProviderCredential
-- consumers such as WhatsApp/AI/SMS, which this trigger never touches).
-- Also requires `providerKey` to exactly equal the credential's own
-- `provider` — a provider-backed attempt can never reference a credential
-- for a different provider.
CREATE FUNCTION fn_check_payment_attempt_provider_credential_scope() RETURNS trigger AS $$
DECLARE
  cred RECORD;
BEGIN
  IF NEW."providerCredentialId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO cred FROM "provider_credential" WHERE "id" = NEW."providerCredentialId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_attempt %: referenced providerCredentialId % does not exist', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'payment_attempt %: providerCredentialId % belongs to a different tenant', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS NULL OR cred."branchId" IS NULL THEN
    RAISE EXCEPTION 'payment_attempt %: providerCredentialId % must be branch-scoped for payments (companyId and branchId both required)', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'payment_attempt %: providerCredentialId % is scoped to a different company', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."branchId" IS DISTINCT FROM NEW."branchId" THEN
    RAISE EXCEPTION 'payment_attempt %: providerCredentialId % is scoped to a different branch', NEW."id", NEW."providerCredentialId";
  END IF;
  IF NEW."providerKey" IS DISTINCT FROM cred."provider" THEN
    RAISE EXCEPTION 'payment_attempt %: providerKey % does not match providerCredentialId %''s provider %', NEW."id", NEW."providerKey", NEW."providerCredentialId", cred."provider";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_payment_attempt_provider_credential_scope
  BEFORE INSERT ON "payment_attempt"
  FOR EACH ROW EXECUTE FUNCTION fn_check_payment_attempt_provider_credential_scope();

-- Trigger — payment_webhook_endpoint scope EXACT mirror + branch-scope
-- requirement (B13, owner final security pass item 2). 1:1 with ONE
-- credential, and that credential must be branch-scoped (companyId AND
-- branchId both NOT NULL) — a tenant-wide or company-only ProviderCredential
-- may continue to exist for other platform domains, but is rejected here.
CREATE FUNCTION fn_check_payment_webhook_endpoint_credential_scope() RETURNS trigger AS $$
DECLARE
  cred RECORD;
BEGIN
  SELECT * INTO cred FROM "provider_credential" WHERE "id" = NEW."providerCredentialId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_webhook_endpoint %: referenced providerCredentialId % does not exist', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS NULL OR cred."branchId" IS NULL THEN
    RAISE EXCEPTION 'payment_webhook_endpoint %: providerCredentialId % must be branch-scoped for payments (companyId and branchId both required)', NEW."id", NEW."providerCredentialId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM cred."tenantId"
     OR NEW."companyId" IS DISTINCT FROM cred."companyId"
     OR NEW."branchId" IS DISTINCT FROM cred."branchId"
  THEN
    RAISE EXCEPTION 'payment_webhook_endpoint %: scope must exactly mirror providerCredentialId %''s own scope', NEW."id", NEW."providerCredentialId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_payment_webhook_endpoint_credential_scope
  BEFORE INSERT ON "payment_webhook_endpoint"
  FOR EACH ROW EXECUTE FUNCTION fn_check_payment_webhook_endpoint_credential_scope();

-- Trigger — provider_payment_event scope + branch-scope requirement (owner
-- final security pass item 4). Every row in this table is inherently a
-- PAYMENT provider event (the table is payment-specific by name/design, no
-- domain ambiguity), so the referenced credential must always be
-- branch-scoped, and the event's own tenant/company/branch must exactly
-- match the credential's. No separate `provider` column exists on this
-- table to cross-check — provider identity is implicit via the FK, so no
-- duplicate data is added.
CREATE FUNCTION fn_check_provider_payment_event_credential_scope() RETURNS trigger AS $$
DECLARE
  cred RECORD;
BEGIN
  SELECT * INTO cred FROM "provider_credential" WHERE "id" = NEW."providerCredentialId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider_payment_event %: referenced providerCredentialId % does not exist', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS NULL OR cred."branchId" IS NULL THEN
    RAISE EXCEPTION 'provider_payment_event %: providerCredentialId % must be branch-scoped for payments (companyId and branchId both required)', NEW."id", NEW."providerCredentialId";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM cred."tenantId"
     OR NEW."companyId" IS DISTINCT FROM cred."companyId"
     OR NEW."branchId" IS DISTINCT FROM cred."branchId"
  THEN
    RAISE EXCEPTION 'provider_payment_event %: scope does not match providerCredentialId %''s own scope', NEW."id", NEW."providerCredentialId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_provider_payment_event_credential_scope
  BEFORE INSERT ON "provider_payment_event"
  FOR EACH ROW EXECUTE FUNCTION fn_check_provider_payment_event_credential_scope();

-- Trigger — payment.sourceAttemptId structural integrity (B5). A Payment
-- must represent EXACTLY its source PaymentAttempt: same tenant/company/
-- branch/method/providerKey(NULL-safe)/amount/currency/exponent, and the
-- attempt must already be CAPTURED. Does NOT transition the attempt — the
-- application later owns that mutation; this only rejects an inconsistent
-- Payment INSERT.
CREATE FUNCTION fn_check_payment_source_attempt_integrity() RETURNS trigger AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT * INTO a FROM "payment_attempt" WHERE "id" = NEW."sourceAttemptId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment %: referenced sourceAttemptId % does not exist', NEW."id", NEW."sourceAttemptId";
  END IF;
  IF a."state" IS DISTINCT FROM 'CAPTURED' THEN
    RAISE EXCEPTION 'payment %: sourceAttemptId % is not CAPTURED (state %)', NEW."id", NEW."sourceAttemptId", a."state";
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM a."tenantId"
     OR NEW."companyId" IS DISTINCT FROM a."companyId"
     OR NEW."branchId" IS DISTINCT FROM a."branchId"
     OR NEW."method" IS DISTINCT FROM a."method"
     OR NEW."providerKey" IS DISTINCT FROM a."providerKey"
     OR NEW."amountMinor" IS DISTINCT FROM a."amountMinor"
     OR NEW."currencyCode" IS DISTINCT FROM a."currencyCode"
     OR NEW."currencyExponent" IS DISTINCT FROM a."currencyExponent"
  THEN
    RAISE EXCEPTION 'payment %: does not match its sourceAttempt % (tenant/company/branch/method/providerKey/amount/currency)', NEW."id", NEW."sourceAttemptId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_payment_source_attempt_integrity
  BEFORE INSERT ON "payment"
  FOR EACH ROW EXECUTE FUNCTION fn_check_payment_source_attempt_integrity();

-- Trigger — payment_allocation structural integrity (B6). Must match its
-- Payment exactly (scope/amount/currency — 3b.5's frozen 1:1, full-amount
-- rule) and its target Invoice (tenant/company scope, branchId equal to the
-- Invoice's own branchId, currency/exponent equal). Deliberately does NOT
-- compute or check the cross-row outstanding-balance invariant — see the
-- migration header comment.
CREATE FUNCTION fn_check_payment_allocation_integrity() RETURNS trigger AS $$
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
     OR NEW."amountMinor" IS DISTINCT FROM p."amountMinor"
     OR NEW."currencyCode" IS DISTINCT FROM p."currencyCode"
     OR NEW."currencyExponent" IS DISTINCT FROM p."currencyExponent"
  THEN
    RAISE EXCEPTION 'payment_allocation %: does not match its Payment % (scope/amount/currency)', NEW."id", NEW."paymentId";
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_payment_allocation_integrity
  BEFORE INSERT ON "payment_allocation"
  FOR EACH ROW EXECUTE FUNCTION fn_check_payment_allocation_integrity();

-- ══════════════════════ immutability / transition triggers (B9-B13) ════════

-- Trigger — payment_attempt: creation-time attributes immutable; state moves
-- only through the frozen 3b.5 transition graph; providerReference follows
-- its own narrow set-once lifecycle. All comparisons NULL-safe
-- (IS NOT DISTINCT FROM / IS DISTINCT FROM) — a same-value write is
-- harmless.
CREATE FUNCTION fn_enforce_payment_attempt_immutable_and_transition() RETURNS trigger AS $$
BEGIN
  IF NOT (
    NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."orderId" IS NOT DISTINCT FROM OLD."orderId"
    AND NEW."targetInvoiceId" IS NOT DISTINCT FROM OLD."targetInvoiceId"
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

CREATE TRIGGER trg_enforce_payment_attempt_immutable_and_transition
  BEFORE UPDATE ON "payment_attempt"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_attempt_immutable_and_transition();

-- Trigger — payment_attempt is never deleted (append-only spirit, matching
-- every other financial table in this schema — journal_entry/journal_line/
-- invoice all block DELETE unconditionally; not explicitly requested for
-- this table but a deliberate, narrow, contract-consistent completion of
-- the same philosophy, not scope creep).
CREATE FUNCTION fn_enforce_payment_attempt_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_attempt %: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_attempt_no_delete
  BEFORE DELETE ON "payment_attempt"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_attempt_no_delete();

-- Trigger — payment is fully immutable: no UPDATE, ever.
CREATE FUNCTION fn_enforce_payment_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment %: is immutable — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_no_update
  BEFORE UPDATE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_no_update();

-- Trigger — payment is fully immutable: no DELETE, ever.
CREATE FUNCTION fn_enforce_payment_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment %: is immutable — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_no_delete
  BEFORE DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_no_delete();

-- Trigger — payment_allocation is append-only: no UPDATE.
CREATE FUNCTION fn_enforce_payment_allocation_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_allocation %: is append-only — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_allocation_no_update
  BEFORE UPDATE ON "payment_allocation"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_allocation_no_update();

-- Trigger — payment_allocation is append-only: no DELETE.
CREATE FUNCTION fn_enforce_payment_allocation_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_allocation %: is append-only — DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_allocation_no_delete
  BEFORE DELETE ON "payment_allocation"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_allocation_no_delete();

-- Trigger — payment_attempt_event is append-only: no UPDATE, no DELETE.
CREATE FUNCTION fn_enforce_payment_attempt_event_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_attempt_event %: is append-only — DELETE is never permitted', OLD."id";
  ELSE
    RAISE EXCEPTION 'payment_attempt_event %: is append-only — UPDATE is never permitted', OLD."id";
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_attempt_event_append_only
  BEFORE UPDATE OR DELETE ON "payment_attempt_event"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_attempt_event_append_only();

-- Trigger — provider_payment_event: INSERT must start at RECEIVED.
CREATE FUNCTION fn_enforce_provider_payment_event_initial_status() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'RECEIVED' THEN
    RAISE EXCEPTION 'provider_payment_event %: initial status must be RECEIVED (got %)', NEW."id", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_provider_payment_event_initial_status
  BEFORE INSERT ON "provider_payment_event"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_provider_payment_event_initial_status();

-- Trigger — provider_payment_event: only `status` may ever change, and only
-- via RECEIVED -> PROCESSED / RECEIVED -> EXCEPTION (both then terminal). A
-- genuine same-value update (including from a terminal status) is a
-- harmless no-op; any actual status CHANGE away from a terminal status, or
-- any change to another column, is rejected. No raw payload column exists
-- anywhere on this table.
CREATE FUNCTION fn_enforce_provider_payment_event_transition() RETURNS trigger AS $$
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
  ) THEN
    RAISE EXCEPTION 'provider_payment_event %: only status may change', OLD."id";
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RECEIVED' AND NEW."status" IN ('PROCESSED', 'EXCEPTION') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'provider_payment_event %: illegal status transition % -> %', OLD."id", OLD."status", NEW."status";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_provider_payment_event_transition
  BEFORE UPDATE ON "provider_payment_event"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_provider_payment_event_transition();

-- Trigger — provider_payment_event is never deleted (audit-trail
-- philosophy, same as its five sibling tables — not explicitly requested
-- but a consistent completion, not scope creep).
CREATE FUNCTION fn_enforce_provider_payment_event_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'provider_payment_event %: DELETE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_provider_payment_event_no_delete
  BEFORE DELETE ON "provider_payment_event"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_provider_payment_event_no_delete();

-- Trigger — payment_webhook_endpoint: UPDATE unconditionally blocked (the
-- mapping is immutable; no repository precedent requires a safer lifecycle).
CREATE FUNCTION fn_enforce_payment_webhook_endpoint_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_webhook_endpoint %: is immutable — UPDATE is never permitted', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_webhook_endpoint_no_update
  BEFORE UPDATE ON "payment_webhook_endpoint"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_webhook_endpoint_no_update();

-- Trigger — payment_webhook_endpoint: DELETE blocked by default in 3b.5.
CREATE FUNCTION fn_enforce_payment_webhook_endpoint_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_webhook_endpoint %: DELETE is not permitted in 3b.5', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_payment_webhook_endpoint_no_delete
  BEFORE DELETE ON "payment_webhook_endpoint"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_payment_webhook_endpoint_no_delete();

-- ══════════════════════ trigger error-contract precedent ════════════════════
-- All triggers above follow Task 3b.1/3b.3's precedent exactly: a plain
-- `RAISE EXCEPTION` (SQLSTATE P0001), no dedicated domain-error mapping.
-- This is safe for the same reason it was safe there — Checkpoint B ships
-- no service/repository/controller that can ever reach these tables outside
-- test fixtures; a raw-SQL bypass is the only way any of these triggers can
-- fire. The codebase's global `AllExceptionsFilter` already fails closed
-- for any exception that is not a recognised `DomainError`/`HttpException`.
