import { runDispatcher } from '@flower/db';
import type { DbService } from '@flower/backend';

/**
 * Bounded aggregate outbox-health signals (task 2.8, operational visibility).
 *
 * **Scalability rule (owner lock):** every value here is a **global aggregate**
 * — never a per-tenant / per-row time series. A single persistently-failing
 * row shows up as `withFailures >= 1` and a rising `oldestUndispatchedAgeMs`;
 * *which* tenant is diagnosed from `worstTenantId` **only when a threshold is
 * breached**, and even then it is emitted as a one-off structured log line
 * (`emitOutboxLagWarnings`), not a metric label — so metric cardinality stays
 * O(1) regardless of tenant count.
 */
export interface OutboxLagSnapshot {
  /** rows with `dispatched_at IS NULL` (all tenants). */
  readonly undispatched: number;
  /** age of the oldest such row, ms (0 when the backlog is empty). */
  readonly oldestUndispatchedAgeMs: number;
  /** undispatched rows that have already failed at least one publish attempt. */
  readonly withFailures: number;
  /** the single most-behind tenant id — for a threshold-breach diagnostic log
   *  only, never exposed as a metric key. `null` when the backlog is empty. */
  readonly worstTenantId: string | null;
}

export async function outboxLagSnapshot(db: DbService): Promise<OutboxLagSnapshot> {
  return runDispatcher(db.platformClient(), async (tx) => {
    const agg = await tx.$queryRawUnsafe<
      { undispatched: bigint; oldest: Date | null; with_failures: bigint }[]
    >(
      `SELECT count(*)                                   AS undispatched,
              min("createdAt")                           AS oldest,
              count(*) FILTER (WHERE attempts > 0)       AS with_failures
         FROM outbox
        WHERE "dispatchedAt" IS NULL`,
    );
    const row = agg[0];
    const undispatched = Number(row?.undispatched ?? 0n);
    const oldest = row?.oldest ?? null;

    let worstTenantId: string | null = null;
    if (undispatched > 0) {
      const worst = await tx.$queryRawUnsafe<{ tenantId: string | null }[]>(
        `SELECT "tenantId"
           FROM outbox
          WHERE "dispatchedAt" IS NULL
          ORDER BY "createdAt" ASC
          LIMIT 1`,
      );
      worstTenantId = worst[0]?.tenantId ?? null;
    }

    return {
      undispatched,
      oldestUndispatchedAgeMs: oldest ? Math.max(0, Date.now() - oldest.getTime()) : 0,
      withFailures: Number(row?.with_failures ?? 0n),
      worstTenantId,
    };
  });
}

export interface OutboxLagThresholds {
  /** log a warning once the backlog exceeds this many rows. */
  readonly maxUndispatched: number;
  /** log a warning once the oldest undispatched row is older than this (ms). */
  readonly maxOldestAgeMs: number;
}

export const DEFAULT_OUTBOX_LAG_THRESHOLDS: OutboxLagThresholds = {
  maxUndispatched: 1_000,
  maxOldestAgeMs: 5 * 60_000,
};

/**
 * Emit a bounded, structured warning when a threshold is breached — this is the
 * sanctioned way to surface *which* tenant is behind, without a per-tenant
 * metric series. Returns the warnings it emitted (for tests).
 */
export function outboxLagWarnings(
  snap: OutboxLagSnapshot,
  thresholds: OutboxLagThresholds = DEFAULT_OUTBOX_LAG_THRESHOLDS,
): { code: string; tenantId: string | null; value: number }[] {
  const warnings: { code: string; tenantId: string | null; value: number }[] = [];
  if (snap.undispatched > thresholds.maxUndispatched) {
    warnings.push({
      code: 'OUTBOX_BACKLOG_HIGH',
      tenantId: snap.worstTenantId,
      value: snap.undispatched,
    });
  }
  if (snap.oldestUndispatchedAgeMs > thresholds.maxOldestAgeMs) {
    warnings.push({
      code: 'OUTBOX_OLDEST_TOO_OLD',
      tenantId: snap.worstTenantId,
      value: snap.oldestUndispatchedAgeMs,
    });
  }
  return warnings;
}
