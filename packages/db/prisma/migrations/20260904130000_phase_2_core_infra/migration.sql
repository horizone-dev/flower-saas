-- Phase 2-core infra (task 2.1). Expand migration — additive only.
--   * idempotency_key   — NON-partitioned; unique (tenantId, scope, principalId, key)
--                         (FC-2 / architecture correction 1). RLS ENABLE+FORCE.
--   * translation       — tenant-owned, Arabic/RTL-ready (OD-P2-9). RLS ENABLE+FORCE.
--   * outbox +seq/attempts/availableAt/lastError — the dispatcher's columns (FC-1);
--     `seq` is assigned once and persisted BEFORE the Redis publish (task 2.4).
--   * audit_log +prevHash/entryHash — NULLABLE, UNWRITTEN in core (OD-P2-1); the
--     chain + verify job land in Phase 4 with the Z-Report chain.
--   * company +countryCode/defaultCurrency/fiscalConfig — the legal-entity fiscal
--     source is the company's country, never tenant.region (correction 4).
--   * localization reference (platform-global, RLS-exempt): country / currency /
--     country_tax_config / tax_category / tax_rate / locale / holiday. Tax data is
--     effective-dated. Seeded with the GCC set in task 2.7.

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "entryHash" BYTEA,
ADD COLUMN     "prevHash" BYTEA;

-- AlterTable
ALTER TABLE "company" ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "defaultCurrency" TEXT,
ADD COLUMN     "fiscalConfig" JSONB;

-- AlterTable  (partitioned parent — ADD COLUMN propagates to every partition)
ALTER TABLE "outbox" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "seq" BIGINT;

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "principalId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "responseSnapshot" JSONB,
    "httpStatus" INTEGER,
    "lockedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "translation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "country" (
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "defaultCurrencyCode" TEXT NOT NULL,
    "weekendModel" TEXT NOT NULL,
    "calendarFlags" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "country_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "currency" (
    "code" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "country_tax_config" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "countryCode" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "regime" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "country_tax_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_category" (
    "key" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "tax_category_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "countryCode" TEXT NOT NULL,
    "taxCategoryKey" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locale" (
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "direction" TEXT NOT NULL,

    CONSTRAINT "locale_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "holiday" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "countryCode" TEXT NOT NULL,
    "onDate" DATE NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_key_expiresAt_idx" ON "idempotency_key"("expiresAt");

-- CreateIndex
CREATE INDEX "idempotency_key_status_lockedAt_idx" ON "idempotency_key"("status", "lockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_tenantId_scope_principalId_key_key" ON "idempotency_key"("tenantId", "scope", "principalId", "key");

-- CreateIndex
CREATE INDEX "translation_tenantId_idx" ON "translation"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "translation_tenantId_entityType_entityId_field_locale_key" ON "translation"("tenantId", "entityType", "entityId", "field", "locale");

-- CreateIndex
CREATE INDEX "country_tax_config_countryCode_effectiveFrom_idx" ON "country_tax_config"("countryCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "tax_rate_countryCode_taxCategoryKey_effectiveFrom_idx" ON "tax_rate"("countryCode", "taxCategoryKey", "effectiveFrom");

-- CreateIndex
CREATE INDEX "holiday_countryCode_onDate_idx" ON "holiday"("countryCode", "onDate");

-- ══════════════════════════ hand-written (Prisma cannot express) ═══════════════

-- Dispatcher work queue: pick up undispatched, now-due rows fast (task 2.4).
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("availableAt") WHERE "dispatchedAt" IS NULL;

-- CHECK constraints (extensible enumerations = text + CHECK — DB-CONVENTIONS).
ALTER TABLE "idempotency_key"   ADD CONSTRAINT "idempotency_key_status_chk"      CHECK ("status" IN ('PENDING','DONE'));
ALTER TABLE "country_tax_config" ADD CONSTRAINT "country_tax_config_regime_chk"  CHECK ("regime" IN ('VAT','NONE'));
ALTER TABLE "locale"            ADD CONSTRAINT "locale_direction_chk"            CHECK ("direction" IN ('ltr','rtl'));

-- Foreign keys onto the localization reference tables (added after every CREATE
-- TABLE so ordering is irrelevant). Company's fiscal source is its country.
ALTER TABLE "country" ADD CONSTRAINT "country_defaultCurrencyCode_fkey"
  FOREIGN KEY ("defaultCurrencyCode") REFERENCES "currency"("code") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "country_tax_config" ADD CONSTRAINT "country_tax_config_countryCode_fkey"
  FOREIGN KEY ("countryCode") REFERENCES "country"("code") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_countryCode_fkey"
  FOREIGN KEY ("countryCode") REFERENCES "country"("code") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_taxCategoryKey_fkey"
  FOREIGN KEY ("taxCategoryKey") REFERENCES "tax_category"("key") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_countryCode_fkey"
  FOREIGN KEY ("countryCode") REFERENCES "country"("code") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "translation" ADD CONSTRAINT "translation_locale_fkey"
  FOREIGN KEY ("locale") REFERENCES "locale"("code") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "company" ADD CONSTRAINT "company_countryCode_fkey"
  FOREIGN KEY ("countryCode") REFERENCES "country"("code") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "company" ADD CONSTRAINT "company_defaultCurrency_fkey"
  FOREIGN KEY ("defaultCurrency") REFERENCES "currency"("code") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ─────────────────────────── grants for the DB roles ─────────────────────────
-- (new tables are not covered by the point-in-time GRANTs in the Phase 1 migration)

GRANT ALL ON
  "idempotency_key", "translation",
  "country", "currency", "country_tax_config", "tax_category", "tax_rate", "locale", "holiday"
  TO flower_migrate;

-- flower_app: full DML on the tenant-owned tables (RLS then narrows to the
-- request's tenant); SELECT-only on the platform-global reference tables (it
-- reads them for localization resolution — writes go via the platform path / seed).
-- New tables inherit SELECT,INSERT,UPDATE,DELETE for flower_app from the Phase 1
-- ALTER DEFAULT PRIVILEGES, so the reference tables need an explicit REVOKE (the
-- same pattern Phase 1 used for plan* / permission_registry).
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_key", "translation" TO flower_app;
GRANT SELECT ON
  "country", "currency", "country_tax_config", "tax_category", "tax_rate", "locale", "holiday"
  TO flower_app;
REVOKE INSERT, UPDATE, DELETE ON
  "country", "currency", "country_tax_config", "tax_category", "tax_rate", "locale", "holiday"
  FROM flower_app;

-- flower_platform: the audited cross-tenant path — DML on everything.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "idempotency_key", "translation",
  "country", "currency", "country_tax_config", "tax_category", "tax_rate", "locale", "holiday"
  TO flower_platform;

-- ═══════════════ Row-Level Security — the new tenant-owned tables ══════════════
-- Same policy as Phase 1: a row is visible/writable iff its tenant_id equals the
-- request's `app.tenant_id` GUC. FORCE applies it to the table owner too. An
-- unset/empty GUC -> NULL -> zero rows -> fails closed.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['idempotency_key','translation'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING ("tenantId" = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK ("tenantId" = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- country / currency / country_tax_config / tax_category / tax_rate / locale /
-- holiday are deliberately RLS-exempt (documented) — no tenant_id; they are
-- platform-global reference data, written only via the platform path / the seed.
