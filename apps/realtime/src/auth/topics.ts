import type { SessionData } from '@flower/backend';

/** The trusted fields of a relayed envelope this gateway ever reads for
 *  authorization — a structural subset of `apps/worker`'s `OutboxEnvelope`
 *  (never imported from `apps/worker` directly — that cross-app import is
 *  exactly what `@flower/backend` exists to avoid, FC-3; the relay forwards
 *  the envelope verbatim, so this shape is just "the JSON parsed back"). */
export interface RelayedEnvelope {
  readonly tenant_id: string;
  readonly branch_id: string | null;
  readonly [key: string]: unknown;
}

/**
 * Server-side, per-socket topic authorization (SECURITY.md "Realtime" row /
 * ADR-0017 §9): "topic membership re-checks tenant + branch scope". No
 * resource-type-level filtering exists yet — no domain module has shipped a
 * resource type in Phase 2-core (CLAUDE.md rule 4) — so tenant + branch is the
 * complete authorization surface for now; a future domain phase narrows this
 * further, never widens it.
 *
 * A **tenant-global** event (`branch_id: null` — currently only
 * `tenant.provisioned`) is deliverable to any authorized socket of that
 * tenant, regardless of the socket's own branch scope: a branch-scoped
 * session's branch list says nothing about whether it should see tenant-level
 * lifecycle signals, and withholding them serves no isolation purpose (the
 * event is tenant-scoped, and the socket has already been proven a member of
 * that tenant).
 *
 * The scope this checks against comes **only** from the session the gateway
 * itself resolved via `SessionAuthenticator` (never a client-supplied topic
 * string — that is a banned pattern, CLAUDE.md rule 5, extended to WS
 * subscriptions by this very function's existence).
 */
export function isAuthorized(session: SessionData, envelope: RelayedEnvelope): boolean {
  if (envelope.tenant_id !== session.tenantId) return false;
  if (envelope.branch_id === null) return true;
  const branchScope = session.access?.branchScope ?? [];
  if (branchScope === 'ALL') return true;
  return branchScope.includes(envelope.branch_id);
}
