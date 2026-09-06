/** Schema-baseline marker key stored in `app_meta` by the baseline migration/seed. */
export const SCHEMA_BASELINE_KEY = 'schema_baseline';

/** The GUC the app sets (via `SET LOCAL` / `set_config`) inside every scoped
 *  transaction; the RLS policies key off it (ADR-0010). */
export const TENANT_GUC = 'app.tenant_id';
/** Set alongside `app.tenant_id` when the session is scoped to a single branch —
 *  an optimisation for branch-scoped read paths, not the isolation guarantee. */
export const BRANCH_GUC = 'app.branch_id';

/**
 * Every tenant-owned table (has a `tenant_id` column) — RLS is ENABLE + FORCE on
 * each with the tenant-isolation policy. `tenant` itself is included: its policy
 * keys on `id`, not `tenant_id`. Kept in sync with the Phase 1 migration; a
 * Testcontainers test asserts the DB matches this list.
 */
export const TENANT_SCOPED_TABLES: readonly string[] = Object.freeze([
  'tenant',
  'tenant_entitlement',
  'tenant_limit',
  'tenant_setting',
  'user',
  'credential',
  'mfa_factor',
  'set_password_token',
  'session',
  'refresh_token',
  'login_security_event',
  'role',
  'role_permission',
  'user_role',
  'permission_grant',
  'data_scope_assignment',
  'company',
  'trade_license',
  'branch',
  'branch_setting',
  'pos_terminal',
  'provider_credential',
  'audit_log',
  'outbox',
  // Phase 2-core (task 2.1)
  'idempotency_key',
  'translation',
  // Phase 3 (task 3.1) — the only runtime catalog-capability-state table
  'tenant_catalog_capability',
  // Phase 3 (task 3.2) — generic catalog core (tenant-scoped, company-neutral)
  'category',
  'product_type',
  'product',
]);

/**
 * Platform-global tables — no `tenant_id`, deliberately RLS-exempt. The platform
 * identity realm is isolated at the application layer + by not granting the
 * tenant realm any permission key that reaches it, and `flower_app` has no DB
 * privilege on the `platform_*` tables.
 */
export const PLATFORM_GLOBAL_TABLES: readonly string[] = Object.freeze([
  'plan',
  'plan_version',
  'entitlement_default',
  'limit_default',
  'permission_registry',
  'platform_user',
  'platform_credential',
  'platform_mfa_factor',
  'platform_role',
  'platform_role_permission',
  'platform_user_role',
  'platform_session',
  'app_meta',
  // Phase 2-core localization reference (task 2.1) — RLS-exempt, effective-dated
  // tax data. `flower_app` gets SELECT only; writes go via the platform path/seed.
  'country',
  'currency',
  'country_tax_config',
  'tax_category',
  'tax_rate',
  'locale',
  'holiday',
  // Phase 2-core outbox dispatcher (task 2.4) — dispatcher-internal `seq`
  // allocator bookkeeping. `flower_app` has NO privilege on it at all (stricter
  // than the reference tables above); only `flower_platform` (broad, for
  // platform operations) and `flower_dispatcher` (narrowed to exactly this +
  // `outbox` — task 2.4 remediation) ever reach it.
  'outbox_tenant_seq',
  // Phase 3 (task 3.1) — Business-Type preset templates + their normalized
  // capability defaults. RLS-exempt reference data; `flower_app` SELECT only.
  'business_type_template',
  'business_type_template_capability',
]);

/** Range-partitioned tables (declared in the Phase 1 migration; a DEFAULT
 *  partition holds everything until the Phase 2 partition-maintenance job). */
export const PARTITIONED_TABLES: readonly string[] = Object.freeze(['audit_log', 'outbox']);

/** DB roles created by the Phase 1 migration. */
export const DB_ROLES = Object.freeze({
  /** the application connection — NOSUPERUSER, NOBYPASSRLS */
  app: 'flower_app',
  /** the separate, audited cross-tenant platform path — BYPASSRLS */
  platform: 'flower_platform',
  /** the DDL / migration role */
  migrate: 'flower_migrate',
  /** the outbox dispatcher (task 2.4 remediation) — BYPASSRLS (it must scan
   *  every tenant's undispatched rows) but with grants narrowed to exactly
   *  `outbox` + `outbox_tenant_seq`; it cannot read or write any other table,
   *  tenant-owned or platform-global, regardless of RLS. */
  dispatcher: 'flower_dispatcher',
} as const);
