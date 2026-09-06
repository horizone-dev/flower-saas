/**
 * The auditable-action registry (PHASE-1-PLAN §1.14, amendment 2 / hard gate
 * G12). Every security- or business-significant mutation that MUST leave an
 * `audit_log` record is listed here. `AuditWriter.record` accepts only these
 * actions, so a new mutation cannot ship without deciding its audit story.
 *
 * `security` marks actions that also surface in the `security_event` view.
 * Multiple records may exist for one request (e.g. provisioning).
 */
export const AUDITABLE_ACTIONS = {
  // ── tenant lifecycle + config (platform realm) ──────────────────────────
  'tenant.created': { resourceType: 'tenant', security: true },
  'tenant.suspend': { resourceType: 'tenant', security: true },
  'tenant.resume': { resourceType: 'tenant', security: true },
  'tenant.terminate': { resourceType: 'tenant', security: true },
  'tenant.limit_overridden': { resourceType: 'tenant_limit', security: true },
  'tenant.entitlement_overridden': { resourceType: 'tenant_entitlement', security: true },

  // ── RBAC ───────────────────────────────────────────────────────────────
  'role.created': { resourceType: 'role', security: true },
  'role.permissions_changed': { resourceType: 'role', security: true },
  'user.created': { resourceType: 'user', security: true },
  'user.roles_changed': { resourceType: 'user', security: true },
  'user.grants_changed': { resourceType: 'user', security: true },
  'user.scope_changed': { resourceType: 'user', security: true },

  // ── org ────────────────────────────────────────────────────────────────
  'company.created': { resourceType: 'company', security: false },
  'branch.created': { resourceType: 'branch', security: false },
  'branch_setting.changed': { resourceType: 'branch_setting', security: false },
  'pos_terminal.created': { resourceType: 'pos_terminal', security: false },
  'trade_license.created': { resourceType: 'trade_license', security: false },

  // ── secrets vault (platform realm) ─────────────────────────────────────
  'provider_credential.created': { resourceType: 'provider_credential', security: true },
  'provider_credential.rotated': { resourceType: 'provider_credential', security: true },
  'provider_credential.revoked': { resourceType: 'provider_credential', security: true },

  // ── catalog capability & Business-Type template foundation (task 3.1) ───
  /** initial Business-Type template snapshot during provisioning; (later)
   *  Task 3.10's explicit re-apply. SECURITY-significant — it establishes a
   *  tenant's initial capability configuration. */
  'catalog.template_applied': { resourceType: 'business_type_template', security: true },
  /** a Super-Admin PATCH to a tenant's catalog-capability set — written ONLY
   *  inside a committed write transaction (no row for a stale/failed/no-op) */
  'tenant.catalog_capability_changed': {
    resourceType: 'tenant_catalog_capability',
    security: true,
  },

  // ── generic catalog core — Category / Product Type / Product (task 3.2) ──
  // Ordinary tenant catalog CRUD by an Owner/Admin — business events, NOT
  // security events (owner §15 / §16). They do NOT surface in `security_event`
  // even though the action name begins with `catalog.` (the view + the
  // prefix/exact registry below are narrowed accordingly).
  'catalog.category_created': { resourceType: 'category', security: false },
  'catalog.category_updated': { resourceType: 'category', security: false },
  'catalog.category_status_changed': { resourceType: 'category', security: false },
  'catalog.category_deleted': { resourceType: 'category', security: false },
  'catalog.product_type_created': { resourceType: 'product_type', security: false },
  'catalog.product_type_updated': { resourceType: 'product_type', security: false },
  'catalog.product_type_status_changed': { resourceType: 'product_type', security: false },
  'catalog.product_type_deleted': { resourceType: 'product_type', security: false },
  'catalog.product_created': { resourceType: 'product', security: false },
  'catalog.product_updated': { resourceType: 'product', security: false },
  'catalog.product_status_changed': { resourceType: 'product', security: false },
  'catalog.product_deleted': { resourceType: 'product', security: false },

  // ── sessions + impersonation ──────────────────────────────────────────
  'session.revoked': { resourceType: 'session', security: true },
  'IMPERSONATION:started': { resourceType: 'tenant', security: true },
  'IMPERSONATION:ended': { resourceType: 'tenant', security: true },
  /** every request served inside an impersonated session (OD7) */
  'IMPERSONATION:read': { resourceType: 'http_request', security: true },
} as const;

export type AuditableAction = keyof typeof AUDITABLE_ACTIONS;

export function isAuditableAction(value: string): value is AuditableAction {
  return value in AUDITABLE_ACTIONS;
}

/**
 * The `security_event` view membership, kept in sync with the `security: true`
 * entries above by `actions.test.ts` (build-blocking). An action is a security
 * event iff it matches a prefix here OR is listed in `SECURITY_ACTION_EXACT`.
 *
 * `catalog.` is deliberately NOT a prefix (owner §16 / R-6): task 3.2's ordinary
 * `catalog.category_*` / `catalog.product_*` / `catalog.product_type_*` CRUD is
 * business activity, not security activity. The one security-significant catalog
 * action — `catalog.template_applied` (establishes a tenant's initial capability
 * configuration) — is matched exactly below. `tenant.catalog_capability_changed`
 * stays covered by the `tenant.` prefix.
 */
export const SECURITY_ACTION_PREFIXES = [
  'tenant.',
  'role.',
  'user.',
  'provider_credential.',
  'session.',
  'IMPERSONATION:',
] as const;

/** Security-event actions matched exactly (not by prefix). Mirrors the
 *  `a."action" = '…'` clauses in the `security_event` view. */
export const SECURITY_ACTION_EXACT: ReadonlySet<string> = new Set<string>([
  'catalog.template_applied',
]);

/** Whether an action surfaces in the `security_event` view. */
export function isSecurityEventAction(action: string): boolean {
  return (
    SECURITY_ACTION_PREFIXES.some((p) => action.startsWith(p)) || SECURITY_ACTION_EXACT.has(action)
  );
}
