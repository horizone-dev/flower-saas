import type { SessionData } from '@flower/backend';

/** The trusted fields of a relayed envelope this gateway ever reads for
 *  authorization — a structural subset of `apps/worker`'s `OutboxEnvelope`
 *  (never imported from `apps/worker` directly — that cross-app import is
 *  exactly what `@flower/backend` exists to avoid, FC-3; the relay forwards
 *  the envelope verbatim, so this shape is just "the JSON parsed back"). */
export interface RelayedEnvelope {
  readonly tenant_id: string;
  /** ADR-0017 §3 (additive Phase-3 amendment / task 3.10) — present + non-null
   *  for a company-scoped OR branch-scoped event; absent / null for a
   *  tenant-global one. Authorised CUMULATIVELY with tenant_id + branch_id. */
  readonly company_id?: string | null;
  readonly branch_id: string | null;
  readonly [key: string]: unknown;
}

/**
 * Server-side, per-socket topic authorization (SECURITY.md "Realtime" row /
 * ADR-0017 §9). **CUMULATIVE** — every populated scope field must pass (task
 * 3.10, owner D-1):
 *
 *   1. `tenant_id` MUST equal the authenticated session tenant.
 *   2. if `company_id != null` — `session.companyScope` MUST be `'ALL'` or
 *      include it (a company-scoped catalog event, e.g.
 *      `catalog.company.price_changed`).
 *   3. if `branch_id != null` — `session.branchScope` MUST be `'ALL'` or
 *      include it.
 *
 * When BOTH `company_id` and `branch_id` are present (every `catalog.branch.*`
 * event carries both — defence in depth), BOTH checks must pass: a session
 * scoped to branch A but NOT company A is denied.
 *
 * A **tenant-global** event (`company_id: null`, `branch_id: null` —
 * `tenant.provisioned`, `catalog.product.status_changed`,
 * `catalog.variant.status_changed`) is deliverable to any authorized socket of
 * that tenant: a tenant-scoped catalog definition genuinely affects every
 * company/branch, and the socket has already been proven a member of the
 * tenant.
 *
 * Company is NEVER inferred from a client-supplied branch and the gateway does
 * NO database lookup — the trusted domain producer places the authoritative
 * `company_id` into the envelope; the dispatcher forwards it verbatim and never
 * reads `payload` for routing. `posTerminalId` is NEVER a realtime business-data
 * authority.
 *
 * The scope this checks against comes **only** from the session the gateway
 * itself resolved via `SessionAuthenticator` (never a client-supplied topic
 * string — CLAUDE.md rule 5, extended to WS subscriptions).
 */
export function isAuthorized(session: SessionData, envelope: RelayedEnvelope): boolean {
  if (envelope.tenant_id !== session.tenantId) return false;

  const companyId = envelope.company_id ?? null;
  if (companyId !== null) {
    const companyScope = session.access?.companyScope ?? [];
    if (companyScope !== 'ALL' && !companyScope.includes(companyId)) return false;
  }

  const branchId = envelope.branch_id;
  if (branchId !== null) {
    const branchScope = session.access?.branchScope ?? [];
    if (branchScope !== 'ALL' && !branchScope.includes(branchId)) return false;
  }

  return true;
}
