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

/** SQL `LIKE` patterns for the `security_event` view — kept in sync with the
 *  `security: true` entries above by `actions.test.ts`. */
export const SECURITY_ACTION_PREFIXES = [
  'tenant.',
  'role.',
  'user.',
  'provider_credential.',
  'session.',
  'IMPERSONATION:',
] as const;
