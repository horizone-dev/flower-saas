-- Phase 1 — identity, tenancy, RBAC, entitlements, org, secrets vault shell,
-- and the minimal audit/outbox foundation.  docs/phase-1/PHASE-1-PLAN.md §3.1
--
-- Beyond the Prisma-generated DDL this migration adds (Prisma can express none
-- of these):
--   * uuidv7()  — time-ordered UUID PK generator (Postgres 17 has no built-in)
--   * range partitioning on audit_log / outbox
--   * DB roles: flower_app (NOSUPERUSER NOBYPASSRLS — the app), flower_platform
--     (BYPASSRLS — the separate, audited platform path), flower_migrate (DDL)
--   * RLS ENABLE + FORCE + a tenant-isolation policy on every tenant-owned table
--   * CHECK constraints for the status / kind / effect enumerations
--
-- Forward-only. Applied by `prisma migrate deploy` (prod/CI) and replayed on the
-- shadow DB by `migrate dev`.

-- ─────────────────────────── uuidv7() (RFC 9562) ───────────────────────────
-- Pure-SQL: first 48 bits = unix-ms timestamp, version nibble forced to 0b0111,
-- the rest random (from gen_random_uuid(), built in since PG 13).
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$ LANGUAGE sql VOLATILE;

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_version" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "planId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_default" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "planVersionId" UUID NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "entitlement_default_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "limit_default" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "planVersionId" UUID NOT NULL,
    "limitKey" TEXT NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "limit_default_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_registry" (
    "key" TEXT NOT NULL,
    "realm" TEXT NOT NULL DEFAULT 'TENANT',
    "groupKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "addedInPhase" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_registry_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform_user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_credential" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "platformUserId" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_mfa_factor" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "platformUserId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TOTP',
    "secretRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mfa_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "platform_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role_permission" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "platformRoleId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,

    CONSTRAINT "platform_role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_user_role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "platformUserId" UUID NOT NULL,
    "platformRoleId" UUID NOT NULL,

    CONSTRAINT "platform_user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "platformUserId" UUID NOT NULL,
    "mfaLevel" TEXT NOT NULL DEFAULT 'NONE',
    "ip" TEXT,
    "userAgent" TEXT,
    "impersonatingTenantId" UUID,
    "impersonationReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokeReason" TEXT,

    CONSTRAINT "platform_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "planVersionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_entitlement" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'DEFAULT',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_limit" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "limitKey" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "setByPlatformUserId" UUID,
    "setAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_setting" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'USER',
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PASSWORD',
    "hash" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factor" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TOTP',
    "secretRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "set_password_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdByPlatformUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "set_password_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "posTerminalId" UUID,
    "deviceId" UUID,
    "mfaLevel" TEXT NOT NULL DEFAULT 'NONE',
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokeReason" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "replacedById" UUID,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_security_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID,
    "userId" UUID,
    "kind" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "detail" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_security_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_grant" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedByUserId" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_scope_assignment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "companyScopeAll" BOOLEAN NOT NULL DEFAULT false,
    "companyIds" UUID[],
    "branchScopeAll" BOOLEAN NOT NULL DEFAULT false,
    "branchIds" UUID[],
    "perBranchOverlay" JSONB,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "data_scope_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "legalNameEn" TEXT NOT NULL,
    "legalNameAr" TEXT,
    "crNumber" TEXT,
    "trn" TEXT,
    "registeredAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_license" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trade_license_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
    "weekendModel" TEXT NOT NULL DEFAULT 'FRI_SAT',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_setting" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_terminal" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pos_terminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credential" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID NOT NULL,
    "companyId" UUID,
    "branchId" UUID,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'TEST',
    "secretCiphertext" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "dekWrapped" BYTEA NOT NULL,
    "nonSecretConfig" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByPlatformUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID,
    "companyId" UUID,
    "branchId" UUID,
    "posTerminalId" UUID,
    "actorUserId" UUID,
    "actorPlatformUserId" UUID,
    "actorAccountType" TEXT NOT NULL,
    "impersonatorPlatformUserId" UUID,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id","at")
) PARTITION BY RANGE ("at");

-- Phase 1 declares partitioning; a single DEFAULT partition holds everything
-- until a partition-maintenance job (Phase 2 scheduler) rolls monthly partitions.
CREATE TABLE "audit_log_default" PARTITION OF "audit_log" DEFAULT;

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenantId" UUID,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id","createdAt")
) PARTITION BY RANGE ("createdAt");

CREATE TABLE "outbox_default" PARTITION OF "outbox" DEFAULT;

-- CreateIndex
CREATE INDEX "permission_registry_realm_idx" ON "permission_registry"("realm");

-- CreateIndex
CREATE UNIQUE INDEX "plan_key_key" ON "plan"("key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_version_planId_version_key" ON "plan_version"("planId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_default_planVersionId_moduleKey_key" ON "entitlement_default"("planVersionId", "moduleKey");

-- CreateIndex
CREATE UNIQUE INDEX "limit_default_planVersionId_limitKey_key" ON "limit_default"("planVersionId", "limitKey");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_credential_platformUserId_key" ON "platform_credential"("platformUserId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_key_key" ON "platform_role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_permission_platformRoleId_permissionKey_key" ON "platform_role_permission"("platformRoleId", "permissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_role_platformUserId_platformRoleId_key" ON "platform_user_role"("platformUserId", "platformRoleId");

-- CreateIndex
CREATE INDEX "platform_session_platformUserId_idx" ON "platform_session"("platformUserId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_entitlement_tenantId_idx" ON "tenant_entitlement"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_entitlement_tenantId_moduleKey_key" ON "tenant_entitlement"("tenantId", "moduleKey");

-- CreateIndex
CREATE INDEX "tenant_limit_tenantId_idx" ON "tenant_limit"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_limit_tenantId_limitKey_key" ON "tenant_limit"("tenantId", "limitKey");

-- CreateIndex
CREATE INDEX "tenant_setting_tenantId_idx" ON "tenant_setting"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_setting_tenantId_key_key" ON "tenant_setting"("tenantId", "key");

-- CreateIndex
CREATE INDEX "user_tenantId_idx" ON "user"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenantId_email_key" ON "user"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "credential_userId_key" ON "credential"("userId");

-- CreateIndex
CREATE INDEX "credential_tenantId_idx" ON "credential"("tenantId");

-- CreateIndex
CREATE INDEX "mfa_factor_tenantId_userId_idx" ON "mfa_factor"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "set_password_token_tokenHash_key" ON "set_password_token"("tokenHash");

-- CreateIndex
CREATE INDEX "set_password_token_tenantId_userId_idx" ON "set_password_token"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "session_tenantId_userId_idx" ON "session"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "session_tenantId_expiresAt_idx" ON "session"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_tokenHash_key" ON "refresh_token"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_token_tenantId_familyId_idx" ON "refresh_token"("tenantId", "familyId");

-- CreateIndex
CREATE INDEX "login_security_event_tenantId_at_idx" ON "login_security_event"("tenantId", "at");

-- CreateIndex
CREATE INDEX "login_security_event_userId_at_idx" ON "login_security_event"("userId", "at");

-- CreateIndex
CREATE INDEX "role_tenantId_idx" ON "role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenantId_key_key" ON "role"("tenantId", "key");

-- CreateIndex
CREATE INDEX "role_permission_tenantId_idx" ON "role_permission"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_roleId_permissionKey_key" ON "role_permission"("roleId", "permissionKey");

-- CreateIndex
CREATE INDEX "user_role_tenantId_idx" ON "user_role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_userId_roleId_key" ON "user_role"("userId", "roleId");

-- CreateIndex
CREATE INDEX "permission_grant_tenantId_idx" ON "permission_grant"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "permission_grant_userId_permissionKey_key" ON "permission_grant"("userId", "permissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "data_scope_assignment_userId_key" ON "data_scope_assignment"("userId");

-- CreateIndex
CREATE INDEX "data_scope_assignment_tenantId_idx" ON "data_scope_assignment"("tenantId");

-- CreateIndex
CREATE INDEX "company_tenantId_idx" ON "company"("tenantId");

-- CreateIndex
CREATE INDEX "trade_license_tenantId_companyId_idx" ON "trade_license"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "trade_license_tenantId_expiresAt_idx" ON "trade_license"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "branch_tenantId_companyId_idx" ON "branch"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "branch_setting_tenantId_idx" ON "branch_setting"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "branch_setting_branchId_key_key" ON "branch_setting"("branchId", "key");

-- CreateIndex
CREATE INDEX "pos_terminal_tenantId_branchId_idx" ON "pos_terminal"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "pos_terminal_tenantId_code_key" ON "pos_terminal"("tenantId", "code");

-- CreateIndex
CREATE INDEX "provider_credential_tenantId_provider_idx" ON "provider_credential"("tenantId", "provider");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_at_idx" ON "audit_log"("tenantId", "at");

-- CreateIndex
CREATE INDEX "audit_log_action_at_idx" ON "audit_log"("action", "at");

-- CreateIndex
CREATE INDEX "outbox_createdAt_idx" ON "outbox"("createdAt");

-- AddForeignKey
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_default" ADD CONSTRAINT "entitlement_default_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "plan_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "limit_default" ADD CONSTRAINT "limit_default_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "plan_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_credential" ADD CONSTRAINT "platform_credential_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_mfa_factor" ADD CONSTRAINT "platform_mfa_factor_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_permission" ADD CONSTRAINT "platform_role_permission_platformRoleId_fkey" FOREIGN KEY ("platformRoleId") REFERENCES "platform_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_user_role" ADD CONSTRAINT "platform_user_role_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_user_role" ADD CONSTRAINT "platform_user_role_platformRoleId_fkey" FOREIGN KEY ("platformRoleId") REFERENCES "platform_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_session" ADD CONSTRAINT "platform_session_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "plan_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_entitlement" ADD CONSTRAINT "tenant_entitlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_limit" ADD CONSTRAINT "tenant_limit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_limit" ADD CONSTRAINT "tenant_limit_setByPlatformUserId_fkey" FOREIGN KEY ("setByPlatformUserId") REFERENCES "platform_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_setting" ADD CONSTRAINT "tenant_setting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "set_password_token" ADD CONSTRAINT "set_password_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_grant" ADD CONSTRAINT "permission_grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_grant" ADD CONSTRAINT "permission_grant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_scope_assignment" ADD CONSTRAINT "data_scope_assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_license" ADD CONSTRAINT "trade_license_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_setting" ADD CONSTRAINT "branch_setting_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_terminal" ADD CONSTRAINT "pos_terminal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_terminal" ADD CONSTRAINT "pos_terminal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_terminal" ADD CONSTRAINT "pos_terminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_updatedByPlatformUserId_fkey" FOREIGN KEY ("updatedByPlatformUserId") REFERENCES "platform_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════ CHECK constraints ═══════════════════════════════
-- Extensible enumerations are text + CHECK, never a PG enum (DB-CONVENTIONS).

ALTER TABLE "tenant"              ADD CONSTRAINT "tenant_status_chk"        CHECK ("status" IN ('DRAFT','ACTIVE','SUSPENDED','TERMINATED'));
ALTER TABLE "plan_version"        ADD CONSTRAINT "plan_version_status_chk"  CHECK ("status" IN ('DRAFT','PUBLISHED','RETIRED'));
ALTER TABLE "user"               ADD CONSTRAINT "user_account_type_chk"    CHECK ("accountType" IN ('OWNER','USER'));
ALTER TABLE "user"               ADD CONSTRAINT "user_status_chk"          CHECK ("status" IN ('ACTIVE','DISABLED','LOCKED'));
ALTER TABLE "platform_user"      ADD CONSTRAINT "platform_user_status_chk" CHECK ("status" IN ('ACTIVE','DISABLED'));
ALTER TABLE "mfa_factor"         ADD CONSTRAINT "mfa_factor_status_chk"    CHECK ("status" IN ('PENDING','CONFIRMED'));
ALTER TABLE "platform_mfa_factor" ADD CONSTRAINT "platform_mfa_status_chk" CHECK ("status" IN ('PENDING','CONFIRMED'));
ALTER TABLE "session"            ADD CONSTRAINT "session_mfa_level_chk"    CHECK ("mfaLevel" IN ('NONE','MFA','STEP_UP'));
ALTER TABLE "platform_session"   ADD CONSTRAINT "platform_session_mfa_chk" CHECK ("mfaLevel" IN ('NONE','MFA','STEP_UP'));
ALTER TABLE "permission_grant"   ADD CONSTRAINT "permission_grant_effect_chk" CHECK ("effect" IN ('ALLOW','DENY'));
ALTER TABLE "company"            ADD CONSTRAINT "company_status_chk"       CHECK ("status" IN ('ACTIVE','INACTIVE'));
ALTER TABLE "branch"             ADD CONSTRAINT "branch_status_chk"        CHECK ("status" IN ('ACTIVE','INACTIVE'));
ALTER TABLE "trade_license"      ADD CONSTRAINT "trade_license_status_chk" CHECK ("status" IN ('ACTIVE','EXPIRED','CANCELLED'));
ALTER TABLE "pos_terminal"       ADD CONSTRAINT "pos_terminal_status_chk"  CHECK ("status" IN ('ACTIVE','INACTIVE'));
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_mode_chk"   CHECK ("mode" IN ('TEST','LIVE'));
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_status_chk" CHECK ("status" IN ('ACTIVE','REVOKED'));
ALTER TABLE "tenant_entitlement" ADD CONSTRAINT "tenant_entitlement_source_chk"   CHECK ("source" IN ('DEFAULT','OVERRIDE'));
ALTER TABLE "permission_registry" ADD CONSTRAINT "permission_registry_realm_chk"  CHECK ("realm" IN ('TENANT','PLATFORM'));
ALTER TABLE "audit_log"          ADD CONSTRAINT "audit_log_actor_type_chk" CHECK ("actorAccountType" IN ('OWNER','USER','PLATFORM','SYSTEM'));

-- ══════════════════════════════ DB roles ════════════════════════════════════
-- Idempotent (CREATE ROLE has no IF NOT EXISTS). The app connects as flower_app;
-- the platform module's audited cross-tenant path connects as flower_platform.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flower_app') THEN
    CREATE ROLE flower_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flower_platform') THEN
    CREATE ROLE flower_platform NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flower_migrate') THEN
    CREATE ROLE flower_migrate NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEDB;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO flower_app, flower_platform, flower_migrate;
GRANT ALL ON ALL TABLES IN SCHEMA public TO flower_migrate;
GRANT EXECUTE ON FUNCTION uuidv7() TO flower_app, flower_platform, flower_migrate;

-- flower_platform: the audited cross-tenant path — DML on everything, RLS bypassed.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flower_platform;

-- flower_app: DML on tenant-owned tables (RLS then narrows to the request's
-- tenant) + SELECT on the platform-global reference tables it must read for
-- entitlement/limit resolution. It has NO access to the platform identity realm
-- (platform_user / _credential / _role / _session …) — defence in depth on top of
-- the application-layer realm separation.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flower_app;
REVOKE ALL ON
  "platform_user", "platform_credential", "platform_mfa_factor",
  "platform_role", "platform_role_permission", "platform_user_role",
  "platform_session"
  FROM flower_app;
REVOKE INSERT, UPDATE, DELETE ON
  "plan", "plan_version", "entitlement_default", "limit_default", "permission_registry"
  FROM flower_app;
-- (SELECT on plan* / permission_registry stays — resolution reads them.)

-- future tables created by whoever runs `migrate deploy`
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flower_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flower_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE flower_migrate IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flower_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flower_migrate IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flower_platform;

-- ══════════════════ Row-Level Security — every tenant-owned table ═══════════════
-- Policy: a row is visible/writable iff its tenant_id equals the request's
-- `app.tenant_id` GUC (set by SET LOCAL inside every scoped transaction —
-- ADR-0010). An unset/empty GUC yields NULL -> zero rows -> fails closed.
-- FORCE makes the policy apply to the table owner too. flower_platform (BYPASSRLS)
-- is the only path that legitimately crosses tenants, and every such call is
-- audited by the platform module (Phase 1 task 1.2 / 1.14).

-- the isolation root keys on id, not tenant_id
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant"
  USING ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- login_security_event.tenantId is nullable (a failed login before any tenant is
-- resolved). flower_app can only ever write rows for its own tenant (WITH CHECK);
-- pre-auth / null-tenant rows are written through flower_platform (task 1.5).
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenant_entitlement','tenant_limit','tenant_setting',
    'user','credential','mfa_factor','set_password_token','session','refresh_token',
    'login_security_event',
    'role','role_permission','user_role','permission_grant','data_scope_assignment',
    'company','trade_license','branch','branch_setting','pos_terminal',
    'provider_credential',
    'audit_log','outbox'
  ];
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

-- app_meta + all platform-global tables are deliberately RLS-exempt (documented):
--   plan, plan_version, entitlement_default, limit_default, permission_registry,
--   platform_user, platform_credential, platform_mfa_factor, platform_role,
--   platform_role_permission, platform_user_role, platform_session, app_meta.
-- They carry no tenant_id; the platform realm is isolated at the application layer
-- (distinct token audience + session namespace) and by not granting the tenant
-- realm a permission key that reaches them.
