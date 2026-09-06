-- Phase 3 task 3.1 — Catalog Capability & Business-Type Template Foundation.
-- docs/phase-3/PHASE-3.1-CAPABILITY-SPEC.md §S. Additive, forward-only. No
-- destructive rewrite. No Product / Category / Variant / UOM / Pricing / Tax /
-- Inventory / Order table.
--
--   * business_type_template + business_type_template_capability — platform-global
--     reference (RLS-exempt, like country/currency). `flower_app` SELECT-only —
--     explicit REVOKE INSERT/UPDATE/DELETE (the Phase 1 ALTER DEFAULT PRIVILEGES
--     would otherwise grant full DML on a new table). NO `template_payload` jsonb.
--   * tenant_catalog_capability — the ONLY runtime capability-state table.
--     tenant-owned, RLS ENABLE + FORCE + tenant policy. `flower_app` SELECT-only
--     too (owner §7 / R-7-adjacent): the capability-config surface is written
--     only via the platform path (`runPlatform` / `flower_platform`); no tenant
--     permission key reaches it.
--   * tenant +businessTypeKey / +businessTypeAppliedVersion / +businessTypeAppliedAt
--     (all nullable — pre-3.1 tenants stay NULL; the new provisioning API requires
--     a Business Type) + catalogCapabilityVersion INT NOT NULL DEFAULT 0 (the
--     capability-set aggregate optimistic-concurrency counter — spec §L / R-3).

-- ── AlterTable: the additive tenant columns ──────────────────────────────────
ALTER TABLE "tenant"
  ADD COLUMN "businessTypeKey"            TEXT,
  ADD COLUMN "businessTypeAppliedVersion" INTEGER,
  ADD COLUMN "businessTypeAppliedAt"      TIMESTAMPTZ(6),
  ADD COLUMN "catalogCapabilityVersion"   INTEGER NOT NULL DEFAULT 0;

-- ── CreateTable ─────────────────────────────────────────────────────────────
CREATE TABLE "business_type_template" (
    "key"       TEXT NOT NULL,
    "version"   INTEGER NOT NULL,
    "nameEn"    TEXT NOT NULL,
    "nameAr"    TEXT NOT NULL,
    "status"    TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_type_template_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "business_type_template_capability" (
    "id"            UUID NOT NULL DEFAULT uuidv7(),
    "templateKey"   TEXT NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "enabled"       BOOLEAN NOT NULL,
    "config"        JSONB,
    "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_type_template_capability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tenant_catalog_capability" (
    "id"                    UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"              UUID NOT NULL,
    "capabilityKey"         TEXT NOT NULL,
    "enabled"               BOOLEAN NOT NULL,
    "config"                JSONB,
    "sourceKind"            TEXT NOT NULL,
    "sourceTemplateKey"     TEXT,
    "sourceTemplateVersion" INTEGER,
    "appliedAt"             TIMESTAMPTZ(6),
    "appliedBy"             TEXT,
    "lastChangedBy"         TEXT,
    "overriddenAt"          TIMESTAMPTZ(6),
    "version"               INTEGER NOT NULL DEFAULT 1,
    "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_catalog_capability_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ─────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "business_type_template_capability_templateKey_capabilityKey_key"
  ON "business_type_template_capability"("templateKey", "capabilityKey");

CREATE UNIQUE INDEX "tenant_catalog_capability_tenantId_capabilityKey_key"
  ON "tenant_catalog_capability"("tenantId", "capabilityKey");
CREATE INDEX "tenant_catalog_capability_tenantId_idx"
  ON "tenant_catalog_capability"("tenantId");

-- ── CHECK constraints (extensible enumerations = text + CHECK — DB-CONVENTIONS) ─
ALTER TABLE "business_type_template"
  ADD CONSTRAINT "business_type_template_status_chk"
  CHECK ("status" IN ('ACTIVE', 'DEPRECATED'));

ALTER TABLE "tenant_catalog_capability"
  ADD CONSTRAINT "tenant_catalog_capability_sourceKind_chk"
  CHECK ("sourceKind" IN ('TEMPLATE', 'MANUAL'));

-- capabilityKey is drawn from the closed 16-key registry (spec §A). Mirrors
-- `@flower/shared-types` CATALOG_CAPABILITY_KEYS + the typed CapabilityKey union
-- (kept in sync by a shared-types test). A future phase that adds a capability
-- key ALTERs this CHECK in its own migration — deliberate, never silent.
ALTER TABLE "business_type_template_capability"
  ADD CONSTRAINT "business_type_template_capability_capabilityKey_chk"
  CHECK ("capabilityKey" IN (
    'strategy.stocked', 'strategy.bom', 'strategy.custom',
    'variants', 'multi_uom', 'identifiers.barcode_qr', 'branch_pricing',
    'channel.pos', 'channel.customer_web',
    'inventory.tracked', 'inventory.lot_batch', 'inventory.expiry',
    'purchasing', 'production', 'delivery', 'customer_ordering'
  ));

ALTER TABLE "tenant_catalog_capability"
  ADD CONSTRAINT "tenant_catalog_capability_capabilityKey_chk"
  CHECK ("capabilityKey" IN (
    'strategy.stocked', 'strategy.bom', 'strategy.custom',
    'variants', 'multi_uom', 'identifiers.barcode_qr', 'branch_pricing',
    'channel.pos', 'channel.customer_web',
    'inventory.tracked', 'inventory.lot_batch', 'inventory.expiry',
    'purchasing', 'production', 'delivery', 'customer_ordering'
  ));

-- ── Foreign keys ────────────────────────────────────────────────────────────
ALTER TABLE "business_type_template_capability"
  ADD CONSTRAINT "business_type_template_capability_templateKey_fkey"
  FOREIGN KEY ("templateKey") REFERENCES "business_type_template"("key")
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "tenant_catalog_capability"
  ADD CONSTRAINT "tenant_catalog_capability_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;

-- tenant.businessTypeKey -> business_type_template.key. ON DELETE RESTRICT: a
-- template a tenant points at cannot be dropped (spec §F.1.1). No cascade on the
-- soft `sourceTemplateKey` reference (§H.3 — provenance survives a prune).
ALTER TABLE "tenant"
  ADD CONSTRAINT "tenant_businessTypeKey_fkey"
  FOREIGN KEY ("businessTypeKey") REFERENCES "business_type_template"("key")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── grants for the DB roles ─────────────────────────────────────────────────
-- (new tables are not covered by the point-in-time GRANTs in the Phase 1 migration)
GRANT ALL ON
  "business_type_template", "business_type_template_capability", "tenant_catalog_capability"
  TO flower_migrate;

-- flower_platform: the audited cross-tenant path — full DML (the write path).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "business_type_template", "business_type_template_capability", "tenant_catalog_capability"
  TO flower_platform;

-- flower_app: SELECT only on ALL THREE. The Phase 1 ALTER DEFAULT PRIVILEGES
-- grants SELECT,INSERT,UPDATE,DELETE to flower_app on every new table, so an
-- explicit REVOKE is required (the same pattern Phase 1 used for plan* /
-- permission_registry and task 2.1 used for the localization reference tables).
--   - business_type_template*  — reference data, written via seed / platform path
--   - tenant_catalog_capability — the config surface is NOT in the tenant realm
--     (owner §7); the Owner read path is a scoped SELECT under RLS, writes go
--     only through runPlatform.
GRANT SELECT ON
  "business_type_template", "business_type_template_capability", "tenant_catalog_capability"
  TO flower_app;
REVOKE INSERT, UPDATE, DELETE ON
  "business_type_template", "business_type_template_capability", "tenant_catalog_capability"
  FROM flower_app;

-- ── Row-Level Security — tenant_catalog_capability only ──────────────────────
-- Same policy as Phase 1: visible/writable iff tenantId = the request's
-- app.tenant_id GUC. FORCE applies it to the table owner too. An unset/empty GUC
-- -> NULL -> zero rows -> fails closed.
ALTER TABLE "tenant_catalog_capability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_catalog_capability" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_catalog_capability_tenant_isolation" ON "tenant_catalog_capability"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- business_type_template / business_type_template_capability are deliberately
-- RLS-exempt (documented) — no tenant_id; platform-global reference data,
-- written only via the platform path / the seed.

-- ── security_event view — add the catalog.* prefix ──────────────────────────
-- `catalog.template_applied` is security-significant (spec §O.2). Kept in sync
-- with `SECURITY_ACTION_PREFIXES` in apps/api/src/common/audit/actions.ts.
-- `tenant.catalog_capability_changed` is already covered by `tenant.%`.
CREATE OR REPLACE VIEW "security_event" AS
  SELECT
    a."id",
    a."at",
    a."tenantId",
    a."action"                     AS "kind",
    a."resourceType",
    a."resourceId",
    a."actorUserId",
    a."actorPlatformUserId",
    a."actorAccountType",
    a."impersonatorPlatformUserId",
    a."reason",
    'audit'::text                  AS "source"
  FROM "audit_log" a
  WHERE a."action" LIKE 'tenant.%'
     OR a."action" LIKE 'role.%'
     OR a."action" LIKE 'user.%'
     OR a."action" LIKE 'provider_credential.%'
     OR a."action" LIKE 'session.%'
     OR a."action" LIKE 'IMPERSONATION:%'
     OR a."action" LIKE 'catalog.%'
  UNION ALL
  SELECT
    l."id",
    l."at",
    l."tenantId",
    l."kind",
    'login'::text                  AS "resourceType",
    NULL::text                     AS "resourceId",
    l."userId"                     AS "actorUserId",
    NULL::uuid                     AS "actorPlatformUserId",
    NULL::text                     AS "actorAccountType",
    NULL::uuid                     AS "impersonatorPlatformUserId",
    NULL::text                     AS "reason",
    'login'::text                  AS "source"
  FROM "login_security_event" l;

GRANT SELECT ON "security_event" TO flower_platform;
