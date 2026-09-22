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

  // ── typed attribute templates + values (task 3.3) ──────────────────────
  // Ordinary tenant catalog configuration — business events, NOT security
  // events; they do NOT surface in `security_event` (the view already matches
  // only `= 'catalog.template_applied'`, task 3.2).
  'catalog.attribute_definition_created': { resourceType: 'attribute_definition', security: false },
  'catalog.attribute_definition_updated': { resourceType: 'attribute_definition', security: false },
  'catalog.attribute_definition_status_changed': {
    resourceType: 'attribute_definition',
    security: false,
  },
  'catalog.attribute_definition_deleted': { resourceType: 'attribute_definition', security: false },
  'catalog.attribute_option_set_changed': { resourceType: 'attribute_definition', security: false },
  'catalog.product_attributes_changed': { resourceType: 'product', security: false },

  // ── variants + option groups (task 3.4) ───────────────────────────────────
  // Ordinary tenant catalog configuration — business events, NOT security
  // events; they do NOT surface in `security_event` (the view already matches
  // only `= 'catalog.template_applied'`, task 3.2). ONE audit row per successful
  // public mutation — a variant create/update that also writes child
  // `variant_option_value` rows still emits exactly one row (owner "audit
  // semantics").
  'catalog.option_group_created': { resourceType: 'option_group', security: false },
  'catalog.option_group_updated': { resourceType: 'option_group', security: false },
  'catalog.option_group_deleted': { resourceType: 'option_group', security: false },
  'catalog.option_value_set_changed': { resourceType: 'option_group', security: false },
  'catalog.variant_created': { resourceType: 'variant', security: false },
  'catalog.variant_updated': { resourceType: 'variant', security: false },
  'catalog.variant_status_changed': { resourceType: 'variant', security: false },

  // ── identifiers — SKU / barcode / QR (task 3.5) ───────────────────────────
  // Ordinary tenant catalog configuration — business events, NOT security
  // events; they do NOT surface in `security_event` (the view already matches
  // only `= 'catalog.template_applied'`, task 3.2). ONE audit row per successful
  // public mutation. `identifier_deleted` = the narrow DRAFT-target hard-delete
  // correction path; `identifier_deactivated` = the normal ACTIVE → INACTIVE
  // removal on a non-DRAFT target.
  'catalog.identifier_created': { resourceType: 'item_identifier', security: false },
  'catalog.identifier_deactivated': { resourceType: 'item_identifier', security: false },
  'catalog.identifier_reactivated': { resourceType: 'item_identifier', security: false },
  'catalog.identifier_deleted': { resourceType: 'item_identifier', security: false },

  // ── UOM registry + pack conversions (task 3.6) ────────────────────────────
  // Ordinary tenant catalog configuration — business events, NOT security
  // events (D2-10). ONE audit row per successful public mutation. A conversion
  // replace-set writes exactly one row with the before/after row-set (a ratio
  // edit changes future normalised quantities — payload completeness matters —
  // but it is not money / permission / secret / attribution, so `security: false`
  // and no `security_event` change).
  'catalog.uom_created': { resourceType: 'uom', security: false },
  'catalog.uom_updated': { resourceType: 'uom', security: false },
  'catalog.uom_deleted': { resourceType: 'uom', security: false },
  'catalog.variant_base_uom_set': { resourceType: 'variant', security: false },
  'catalog.variant_conversions_changed': { resourceType: 'variant', security: false },
  'catalog.product_conversions_changed': { resourceType: 'product', security: false },

  // ── company per-UOM sale pricing (task 3.7) ───────────────────────────────
  // Ordinary tenant commercial configuration — a business event, NOT a security
  // event (D2-10). ONE audit row per replace-set mutation (incl. `PUT []`),
  // resource = the `company_variant_price_set` aggregate, payload = the semantic
  // before/after sell-price map. NOT money-moving (no cash / ledger effect —
  // that is Phase 3b), so `security: false` and no `security_event` change. NO
  // realtime / outbox (that is task 3.10). `purchase_*` is never written by the
  // task 3.7 API, so it never appears in the payload.
  'catalog.company_price_changed': { resourceType: 'company_variant_price_set', security: false },

  // ── branch price override + branch availability (task 3.8) ────────────────
  // Ordinary tenant commercial / merchandising configuration — a business event,
  // NOT a security event (D2-10). NO `security_event` change (`catalog.` is not a
  // security prefix). NO realtime / outbox (task 3.10 — audit only).
  //   * `catalog.branch_price_changed` — ONE row per branch price replace-set
  //     mutation (incl. `PUT []`); resource = the `branch_variant_price_set`
  //     aggregate; payload = THIS branch's semantic before/after SELL-override
  //     map only (never a sibling branch's data, never `purchase`).
  //   * `catalog.branch_availability_changed` — ONE row per successful bulk
  //     availability `PUT`; resource = the `branch` (resourceId = the authorized
  //     requestedBranchId — NOT an arbitrary `branch_variant_availability` row
  //     id, Correction 4); payload = `{ variants: { <id>: { available, explicit } } }`
  //     bounded to the request's variants. An idempotency replay writes NO
  //     second audit row.
  'catalog.branch_price_changed': { resourceType: 'branch_variant_price_set', security: false },
  'catalog.branch_availability_changed': { resourceType: 'branch', security: false },

  // ── catalog tax-category assignment (task 3.9) ────────────────────────────
  // Ordinary tenant catalog metadata — a business event, NOT a security event
  // (D2-10). `catalog.` is not a `security_event` prefix, so no view change.
  // ONE row per successful assignment `PUT` (assign / reassign / clear), payload
  // = the `{ taxCategoryKey }` before/after; a stale / failed / ARCHIVED-blocked
  // write leaves NO row. It is CATALOG metadata — it never mutates a historical
  // invoice / sale / fiscal document. NO realtime / outbox (task 3.10). The
  // resolution `GET …/tax` writes NO audit row.
  'catalog.product_tax_category_changed': { resourceType: 'product', security: false },
  'catalog.variant_tax_category_changed': { resourceType: 'variant', security: false },

  // ── accounting: CoA / periods / posting engine (task 3b.1) ────────────────
  // Business events, NOT security events — ordinary tenant financial-config
  // administration and the posting engine's own append-only trail. The journal
  // itself (journal_entry / journal_line) is the authoritative financial
  // detail; these audit rows record WHO/WHEN/WHAT-SOURCE, never a raw
  // debit/credit amount or account key (bounded payload convention).
  'accounting.account_display_updated': { resourceType: 'account', security: false },
  /** existing-company bootstrap's idempotent CoA backfill (§P) — distinct from
   *  `account_display_updated`, which records an owner editing one account's
   *  display fields, not a bulk insert of missing default rows. */
  'accounting.company_coa_backfilled': { resourceType: 'company', security: false },
  'accounting.period_created': { resourceType: 'accounting_period', security: false },
  'accounting.period_closed': { resourceType: 'accounting_period', security: false },
  'accounting.company_timezone_configured': { resourceType: 'company', security: false },
  'accounting.journal_posted': { resourceType: 'journal_entry', security: false },
  'accounting.journal_reversed': { resourceType: 'journal_entry', security: false },

  // ── customers: CRM / Customer Core (task 3b.2) ─────────────────────────────
  // Bounded payloads only — never raw PII (displayName/phoneE164/emailNormalized)
  // and never a credit-limit amount. IDs, booleans, and changed-field NAMES only.
  'customer.created': { resourceType: 'customer', security: false },
  'customer.company_account_created': { resourceType: 'customer_company_account', security: false },
  'customer.updated': { resourceType: 'customer', security: false },
  'customer.archived': { resourceType: 'customer', security: false },
  'customer.credit_config_updated': { resourceType: 'customer_company_account', security: false },

  // ── orders: Orders + Invoice + Numbering (task 3b.3 Checkpoint B) ─────────
  // Bounded payloads only — never raw commercial snapshot / customer PII /
  // unbounded DTO body. IDs, counts, booleans, and changed-section names only.
  'order.created': { resourceType: 'order', security: false },
  'order.updated': { resourceType: 'order', security: false },
  'order.held': { resourceType: 'order', security: false },
  'order.resumed': { resourceType: 'order', security: false },
  /** Checkpoint C — the internal final-issuance primitive only; never a
   *  public route's own audit action. Bounded: order/invoice ids + document
   *  numbers + a safe state-transition label only, never a raw line/PII dump. */
  'order.confirmed': { resourceType: 'order', security: false },
  'invoice.issued': { resourceType: 'invoice', security: false },

  // ── payments (task 3b.5 Checkpoint G) ──────────────────────────────────
  // Business events, NOT security events — ordinary financial activity
  // recording, not permission/secret/attribution change. Bounded payloads
  // only: ids, method, amount/currency, before/after state labels — never a
  // raw webhook body/header/signature, never PAN/CVV/secret, never
  // arbitrary sanitizedMetadata. `payment.recorded` is written once per
  // immutable `Payment` row (C/D per tender; F once per verified CAPTURED
  // conversion). `payment_attempt.reserved` marks a NEW async (Checkpoint
  // E) reservation only — C/D's synchronous PENDING creation is not a
  // durable reservation window (it transitions to CAPTURED in the same
  // transaction) and is covered by `payment_attempt.state_changed`
  // instead, alongside every other REAL PaymentAttempt state transition
  // (never a same-state/no-op result). `provider_payment_event.exception`
  // records a verified-but-unsafe-to-apply provider event (owner §G8) —
  // reason-coded, never the raw provider payload.
  'payment.recorded': { resourceType: 'payment', security: false },
  'payment_attempt.reserved': { resourceType: 'payment_attempt', security: false },
  'payment_attempt.state_changed': { resourceType: 'payment_attempt', security: false },
  'provider_payment_event.exception': { resourceType: 'provider_payment_event', security: false },

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
