-- Phase 3 task 3.2 — Generic Catalog Core (Category + Product Type + Product).
-- docs/phase-3/PHASE-3-PLAN.md §C.3. Additive, forward-only. No destructive
-- rewrite of any Phase 0/1/2/3.1 table. Exactly three new tables — no variant /
-- attribute / option-group / identifier / uom / price / stock / inventory /
-- order / payment / journal table (HG3-NO-PREMATURE-DOMAIN).
--
--   * category / product_type / product — tenant-owned, RLS ENABLE + FORCE +
--     tenant policy. `flower_app` gets full DML (unlike task 3.1's SELECT-only
--     config surface): these are tenant business data the Owner writes through
--     `ScopedRepository` (`runScoped` / `flower_app`), RLS narrows to the request
--     tenant. The Phase 1 `ALTER DEFAULT PRIVILEGES` already grants flower_app
--     full DML on any new table — the GRANTs below are explicit for the record.
--   * Tenant-safe FKs (owner §9 / hard gate): every intra-catalog reference is
--     ALSO a composite `(tenantId, xId) → x(tenantId, id)` FK (backed by a
--     `UNIQUE (tenantId, id)` on the referenced table) so the DB itself rejects
--     a tenant-A row pointing at a tenant-B category / product type. Proven by
--     negative Testcontainers tests.
--   * pg_trgm — for tenant-scoped catalog product-name search (nameEn + nameAr),
--     GIN trigram indexes. `CREATE EXTENSION IF NOT EXISTS` is idempotent; on a
--     managed platform where the migration role cannot create an extension a DBA
--     pre-creates it and this line no-ops. Verified installable in the
--     Testcontainers migration path.
--   * security_event view — NARROWED: ordinary catalog CRUD is NOT a security
--     event (owner §15 / R-6). Only `catalog.template_applied` stays visible.
--   * built-in system-role backfill (owner R-1) — existing tenants' owner/admin
--     roles get catalog:view + catalog:manage, manager gets catalog:view;
--     idempotent, rerunnable, NEVER a duplicate row, custom roles untouched.
--     catalog:view / catalog:manage are also registered in `permission_registry`
--     here (ON CONFLICT DO NOTHING) so the role-assignment / grantability checks
--     accept them in every environment; prisma/seed.ts upserts the same rows for
--     a fresh platform DB.

-- ── pg_trgm ─────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── CreateTable ─────────────────────────────────────────────────────────────
CREATE TABLE "category" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "parentId"  UUID,
    "slug"      TEXT NOT NULL,
    "nameEn"    TEXT NOT NULL,
    "nameAr"    TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status"    TEXT NOT NULL DEFAULT 'ACTIVE',
    "version"   INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_type" (
    "id"        UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"  UUID NOT NULL,
    "key"       TEXT NOT NULL,
    "nameEn"    TEXT NOT NULL,
    "nameAr"    TEXT,
    "status"    TEXT NOT NULL DEFAULT 'ACTIVE',
    "version"   INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_type_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product" (
    "id"                 UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"           UUID NOT NULL,
    "categoryId"         UUID NOT NULL,
    "productTypeId"      UUID,
    "slug"               TEXT NOT NULL,
    "nameEn"             TEXT NOT NULL,
    "nameAr"             TEXT,
    "description"        TEXT,
    "fulfilmentStrategy" TEXT NOT NULL,
    "hidePrice"          BOOLEAN NOT NULL DEFAULT false,
    "status"             TEXT NOT NULL DEFAULT 'DRAFT',
    "version"            INTEGER NOT NULL DEFAULT 1,
    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex — uniques ───────────────────────────────────────────────────
-- tenant-safe FK targets: UNIQUE (tenantId, id)
CREATE UNIQUE INDEX "category_tenantId_id_key"      ON "category"("tenantId", "id");
CREATE UNIQUE INDEX "product_type_tenantId_id_key"  ON "product_type"("tenantId", "id");

-- sibling-unique slug for non-root categories; NULL parentId rows never collide
-- here (Postgres NULL distinctness) — the root case is the partial index below.
CREATE UNIQUE INDEX "category_tenantId_parentId_slug_key"
  ON "category"("tenantId", "parentId", "slug");
-- root-unique slug: exactly the "(tenant_id, slug) WHERE parent_id IS NULL" the
-- owner locked (§3).
CREATE UNIQUE INDEX "category_root_slug_key"
  ON "category"("tenantId", "slug") WHERE "parentId" IS NULL;

CREATE UNIQUE INDEX "product_type_tenantId_key_key" ON "product_type"("tenantId", "key");
CREATE UNIQUE INDEX "product_tenantId_slug_key"     ON "product"("tenantId", "slug");

-- ── CreateIndex — lookups ───────────────────────────────────────────────────
CREATE INDEX "category_tenantId_parentId_idx"      ON "category"("tenantId", "parentId");
CREATE INDEX "category_tenantId_status_idx"        ON "category"("tenantId", "status");
CREATE INDEX "product_type_tenantId_status_idx"    ON "product_type"("tenantId", "status");
CREATE INDEX "product_tenantId_categoryId_idx"     ON "product"("tenantId", "categoryId");
CREATE INDEX "product_tenantId_productTypeId_idx"  ON "product"("tenantId", "productTypeId");
CREATE INDEX "product_tenantId_status_idx"         ON "product"("tenantId", "status");

-- tenant-scoped product-name search (owner §16 / R-2) — nameEn always, nameAr
-- when present. GIN trigram; RLS still scopes every query to the request tenant.
CREATE INDEX "product_nameEn_trgm_idx" ON "product" USING GIN ("nameEn" gin_trgm_ops);
CREATE INDEX "product_nameAr_trgm_idx" ON "product" USING GIN ("nameAr" gin_trgm_ops);

-- ── CHECK constraints (extensible enumerations = text + CHECK — DB-CONVENTIONS) ─
ALTER TABLE "category"
  ADD CONSTRAINT "category_status_chk" CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  ADD CONSTRAINT "category_slug_chk"   CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,62}$');

ALTER TABLE "product_type"
  ADD CONSTRAINT "product_type_status_chk" CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  ADD CONSTRAINT "product_type_key_chk"    CHECK ("key" ~ '^[A-Z][A-Z0-9_]{1,63}$');

ALTER TABLE "product"
  ADD CONSTRAINT "product_status_chk" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  ADD CONSTRAINT "product_slug_chk"   CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  ADD CONSTRAINT "product_fulfilment_strategy_chk"
    CHECK ("fulfilmentStrategy" IN ('STOCKED', 'BOM', 'CUSTOM'));

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- tenant ownership + cascade (no Prisma relation on the new models for this axis;
-- the FK is the source of truth).
ALTER TABLE "category"
  ADD CONSTRAINT "category_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product_type"
  ADD CONSTRAINT "product_type_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product"
  ADD CONSTRAINT "product_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- single-column references (match the Prisma `@relation`s) — RESTRICT: a
-- referenced category / product type cannot be hard-deleted while in use.
ALTER TABLE "category"
  ADD CONSTRAINT "category_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "category"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "product"
  ADD CONSTRAINT "product_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "category"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "product"
  ADD CONSTRAINT "product_productTypeId_fkey"
  FOREIGN KEY ("productTypeId") REFERENCES "product_type"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- TENANT-SAFE composite FKs (owner §9) — the DB guarantees a row can only ever
-- reference a catalog row IN THE SAME TENANT. A nullable parentId / productTypeId
-- with a NULL is simply not checked (MATCH SIMPLE, the default).
ALTER TABLE "category"
  ADD CONSTRAINT "category_tenant_parent_fkey"
  FOREIGN KEY ("tenantId", "parentId") REFERENCES "category"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "product"
  ADD CONSTRAINT "product_tenant_category_fkey"
  FOREIGN KEY ("tenantId", "categoryId") REFERENCES "category"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "product"
  ADD CONSTRAINT "product_tenant_product_type_fkey"
  FOREIGN KEY ("tenantId", "productTypeId") REFERENCES "product_type"("tenantId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── grants for the DB roles ─────────────────────────────────────────────────
GRANT ALL ON "category", "product_type", "product" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "category", "product_type", "product" TO flower_platform;
-- full DML — tenant business data, written by the Owner via runScoped / flower_app;
-- RLS then narrows every statement to the request tenant. NO REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON "category", "product_type", "product" TO flower_app;

-- ── Row-Level Security — every new table (plan §C.11) ───────────────────────
-- Identical policy shape to every Phase 1/2/3.1 tenant table. FORCE applies it
-- to the table owner too. An unset / empty GUC -> NULL -> zero rows -> closed.
ALTER TABLE "category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "category" FORCE ROW LEVEL SECURITY;
CREATE POLICY "category_tenant_isolation" ON "category"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "product_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_type" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_type_tenant_isolation" ON "product_type"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_tenant_isolation" ON "product"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ── security_event view — NARROW the catalog match (owner §15 / §16 / R-6) ───
-- Ordinary category / product / product-type CRUD is NOT a security event even
-- though the action begins with `catalog.`. Only `catalog.template_applied` (the
-- Super-Admin action that establishes a tenant's initial capability set) stays
-- visible. `tenant.catalog_capability_changed` is still covered by `tenant.%`.
-- Kept in sync with apps/api/src/common/audit/actions.ts by actions.test.ts.
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
     OR a."action" = 'catalog.template_applied'
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

-- ── permission registry — register catalog:view / catalog:manage (owner R-1) ──
-- No new key is invented (D2-6 / HG3-PERMISSION-STABILITY): both already exist
-- in @flower/permissions PERMISSIONS.catalog. Registering them here (idempotent)
-- means the tenant role-assignment + grantability checks accept them in every
-- environment, not only after prisma/seed.ts has run.
INSERT INTO "permission_registry" ("key", "realm", "groupKey", "description", "addedInPhase")
VALUES
  ('catalog:view',   'TENANT', 'catalog', 'catalog view',   3),
  ('catalog:manage', 'TENANT', 'catalog', 'catalog manage', 3)
ON CONFLICT ("key") DO NOTHING;

-- ── built-in system-role backfill (owner R-1) ───────────────────────────────
-- Existing tenants: owner + admin get catalog:view + catalog:manage; manager
-- gets catalog:view only. ONLY isSystem = true roles with these exact keys —
-- custom roles, user-created roles, explicit grants and deny grants are NEVER
-- touched. Idempotent + rerunnable: ON CONFLICT (roleId, permissionKey) DO
-- NOTHING can never create a duplicate row.
--
-- In production `prisma migrate deploy` connects as `flower_migrate`, which OWNS
-- these tables but is NOBYPASSRLS — and `role` / `role_permission` are FORCE RLS,
-- so even the owner is filtered. Drop FORCE for the two tables inside THIS
-- transaction (no other session can observe the gap — the ALTERs take ACCESS
-- EXCLUSIVE and commit atomically), do the cross-tenant write, then restore
-- FORCE. `tenant` is not touched. (SYSTEM_ROLE_TEMPLATES is updated in the same
-- task so NEW tenants get these keys at provisioning without any backfill.)
ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", k.key
  FROM "role" r
  CROSS JOIN (VALUES ('catalog:view'), ('catalog:manage')) AS k(key)
 WHERE r."isSystem" = true
   AND r."key" IN ('owner', 'admin')
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
SELECT uuidv7(), r."tenantId", r."id", 'catalog:view'
  FROM "role" r
 WHERE r."isSystem" = true
   AND r."key" = 'manager'
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
