/**
 * The ADR-0017 §3 realtime envelope — a **change signal**, never authoritative
 * business state. Built from a *stamped* `outbox` row using only the approved
 * field list; the row's `payload` (arbitrary business JSON, task 2.1+) is
 * deliberately **never** copied in here (constraint 5 — "do not put ... raw
 * PII-heavy payloads, or full authoritative resource state into realtime
 * events"). A client that needs the resource refetches it over REST.
 */
export interface OutboxEnvelope {
  readonly event_id: string;
  /** stringified — BigInt has no safe JSON representation */
  readonly seq: string;
  readonly tenant_id: string;
  readonly branch_id: string | null;
  readonly type: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly resource_version: string | null;
  readonly occurred_at: string;
  readonly actor_summary: unknown;
}

/** The columns the dispatcher reads off a *stamped* row to build the envelope. */
export interface OutboxRow {
  readonly id: string;
  readonly tenantId: string | null;
  readonly branchId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly resourceVersion: bigint | null;
  readonly actorSummary: unknown;
  readonly createdAt: Date;
  readonly seq: bigint | null;
  readonly attempts: number;
}

/**
 * `event_id` is derived deterministically from the outbox row id (ADR-0017 §2) —
 * a crash-induced re-publish carries the identical `event_id`. `seq` must
 * already be stamped (FC-1) — a caller must never reach this with `seq === null`.
 */
export function buildEnvelope(row: OutboxRow): OutboxEnvelope {
  if (row.seq === null) {
    throw new Error(`buildEnvelope: outbox row ${row.id} has no seq — stamp it before publishing`);
  }
  if (row.tenantId === null) {
    throw new Error(
      `buildEnvelope: outbox row ${row.id} has no tenantId — dispatcher is tenant-scoped only`,
    );
  }
  return {
    event_id: row.id,
    seq: row.seq.toString(),
    tenant_id: row.tenantId,
    branch_id: row.branchId,
    type: row.eventType,
    resource_type: row.aggregateType,
    resource_id: row.aggregateId,
    resource_version: row.resourceVersion !== null ? row.resourceVersion.toString() : null,
    occurred_at: row.createdAt.toISOString(),
    actor_summary: row.actorSummary,
  };
}

/** One durable Redis Stream per tenant (ADR-0017 §3 / OD-P2-4). Re-exported
 *  from `@flower/backend` (task 2.5) — the realtime relay (`../realtime-relay/`,
 *  same app) needs the identical name to `XREADGROUP` from, and the canonical
 *  definition lives in `@flower/backend` alongside `liveChannel`/`revokeChannel`
 *  so `apps/realtime` never has to duplicate it either. */
export { streamKey } from '@flower/backend';

/** The single field name every envelope is written under in the Stream entry. */
export const ENVELOPE_FIELD = 'event';
