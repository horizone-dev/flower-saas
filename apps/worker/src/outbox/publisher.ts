import { runDispatcher } from '@flower/db';
import type { DbService } from '@flower/backend';
import type { Redis } from 'ioredis';
import { buildEnvelope, streamKey, ENVELOPE_FIELD, type OutboxRow } from './envelope.js';
import {
  nextAvailableAt,
  sanitizeError,
  DEFAULT_PUBLISH_BACKOFF,
  type PublishBackoffPolicy,
} from './backoff.js';

export type PublishOutcome = 'published' | 'failed' | 'empty' | 'not-leader';

/**
 * Phase B — publish the single lowest-`seq` eligible row for one tenant.
 *
 * **Same-tenant append order (remediation, 2026-09-04).** Assigning `seq`
 * serially per tenant is not sufficient on its own — publishing was lock-free,
 * so two concurrent processes could each claim a *different* already-stamped
 * row for the *same* tenant (`FOR UPDATE SKIP LOCKED` skips whatever the other
 * one is holding) and `XADD` them in the wrong order, e.g. `seq=11` reaching
 * `rt:stream:{tenantId}` before `seq=10` if the process publishing `seq=10` is
 * merely slow. The fix mirrors `seq-allocator.ts`: a **second**, independently
 * keyed `pg_try_advisory_xact_lock('outbox_publish:' || tenantId)` — at most
 * one process may be *publishing* for a given tenant at any moment, so rows for
 * that tenant are necessarily processed one at a time, lowest `seq` first
 * (`ORDER BY seq FOR UPDATE`, no `SKIP LOCKED` needed here for the same reason
 * `allocateTenantSeq` doesn't need it — holding the lock makes this process the
 * only one touching this tenant's rows at all). This lock is deliberately a
 * *different* key from the allocation lock (`outbox_seq:`) — allocation and
 * publish touch disjoint row sets (`seq IS NULL` vs `seq IS NOT NULL`) and may
 * run concurrently for the same tenant without any real conflict. Different
 * tenants always publish independently — this only serializes *within* one
 * tenant.
 *
 * Runs as its own short `runDispatcher` transaction (least-privilege review,
 * 2026-09-04 — `flower_dispatcher`, grants narrowed to `outbox` +
 * `outbox_tenant_seq` only, see `@flower/db`'s `runDispatcher`): claim the
 * tenant's lock, `SELECT … ORDER BY seq FOR UPDATE LIMIT 1`, attempt `XADD`,
 * then — **within the same transaction** — either mark `dispatched_at`
 * (success) or bump `attempts`/`available_at`/`last_error` (failure), and
 * commit.
 *
 * This is the source of the FC-1 crash scenarios by construction, not by
 * simulation: if the process dies after a successful `XADD` but before this
 * transaction commits, Postgres rolls the whole transaction back — the row's
 * `seq` (stamped durably in a *prior*, already-committed transaction —
 * `allocateTenantSeq`) is untouched, `dispatched_at` stays null, and the next
 * `publishNextForTenant` call re-selects the same row (still the tenant's
 * lowest eligible `seq` — nothing else could have been published ahead of it)
 * and republishes it, `XADD`ing the **identical `event_id` + `seq`** (a
 * duplicate Stream entry — architecturally acceptable, suppressed downstream by
 * `event_id`). If the crash happens *before* `XADD` at all, nothing changed —
 * the row is simply retried, exactly once published. If the crash happens
 * *after* this transaction's commit (`dispatched_at` durably set), the row is
 * no longer selected — never republished.
 *
 * **Routing metadata (remediation, 2026-09-04).** The envelope's `branch_id` /
 * `tenant_id` / routing fields come **only** from the row's own first-class
 * columns (`buildEnvelope`) — this function never reads, parses or trusts
 * anything from `outbox.payload` for authorization or routing purposes; a
 * client-influenced or otherwise untrusted `payload` field can never spoof a
 * branch/tenant/resource identity into the Stream.
 */
export async function publishNextForTenant(
  db: DbService,
  tenantId: string,
  redis: Redis,
  backoff: PublishBackoffPolicy = DEFAULT_PUBLISH_BACKOFF,
): Promise<PublishOutcome> {
  return runDispatcher(db.platformClient(), async (tx) => {
    const lock = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
      `SELECT pg_try_advisory_xact_lock(hashtext('outbox_publish:' || $1::text)) AS acquired`,
      tenantId,
    );
    if (!lock[0]?.acquired) return 'not-leader';

    const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
      `SELECT id, "tenantId", "branchId", "aggregateType", "aggregateId", "eventType",
              "resourceVersion", "actorSummary", "createdAt", seq, attempts
         FROM outbox
        WHERE "tenantId" = $1::uuid AND seq IS NOT NULL AND "dispatchedAt" IS NULL
          AND "availableAt" <= now()
        ORDER BY seq
        LIMIT 1
        FOR UPDATE`,
      tenantId,
    );
    const row = rows[0];
    if (!row) return 'empty';

    try {
      const envelope = buildEnvelope(row);
      await redis.xadd(streamKey(row.tenantId!), '*', ENVELOPE_FIELD, JSON.stringify(envelope));
      // keyed on `id` alone — see the note in seq-allocator.ts: `id` (a
      // `uuidv7()`) is already globally unique; a round-tripped `createdAt`
      // loses the `timestamptz(6)` column's sub-millisecond precision and would
      // silently match zero rows.
      await tx.$executeRawUnsafe(
        `UPDATE outbox SET "dispatchedAt" = now() WHERE id = $1::uuid`,
        row.id,
      );
      return 'published';
    } catch (err) {
      const attempts = row.attempts + 1;
      await tx.$executeRawUnsafe(
        `UPDATE outbox SET attempts = $1, "availableAt" = $2, "lastError" = $3
          WHERE id = $4::uuid`,
        attempts,
        nextAvailableAt(attempts, backoff),
        sanitizeError(err),
        row.id,
      );
      return 'failed';
    }
  });
}

/**
 * Candidate tenants with already-stamped, eligible-to-publish work — a cheap,
 * lock-free scan. Discovery only: which tenant actually gets to publish
 * anything (and in what order) is decided by the per-tenant lock in
 * `publishNextForTenant`.
 */
export async function discoverPublishableTenants(db: DbService, limit = 20): Promise<string[]> {
  return runDispatcher(db.platformClient(), async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ tenantId: string }[]>(
      `SELECT DISTINCT "tenantId" FROM outbox
        WHERE "tenantId" IS NOT NULL AND seq IS NOT NULL AND "dispatchedAt" IS NULL
          AND "availableAt" <= now()
        LIMIT $1`,
      limit,
    );
    return rows.map((r) => r.tenantId);
  });
}

export interface PublishBatchResult {
  readonly published: number;
  readonly failed: number;
}

/**
 * Drain up to `perTenantBatchSize` ready rows for each of up to
 * `tenantBatchSize` discovered tenants — one `publishNextForTenant` call (one
 * lock acquisition, one transaction) per row, so ordering within a tenant and
 * independence across tenants both hold exactly as `publishNextForTenant`
 * documents.
 */
export async function publishReadyAcrossTenants(
  db: DbService,
  redis: Redis,
  opts: {
    tenantBatchSize?: number;
    perTenantBatchSize?: number;
    backoff?: PublishBackoffPolicy;
  } = {},
): Promise<PublishBatchResult> {
  const tenantBatchSize = opts.tenantBatchSize ?? 10;
  const perTenantBatchSize = opts.perTenantBatchSize ?? 20;
  const backoff = opts.backoff ?? DEFAULT_PUBLISH_BACKOFF;

  const tenants = await discoverPublishableTenants(db, tenantBatchSize);
  let published = 0;
  let failed = 0;
  for (const tenantId of tenants) {
    for (let i = 0; i < perTenantBatchSize; i++) {
      const outcome = await publishNextForTenant(db, tenantId, redis, backoff);
      if (outcome === 'empty' || outcome === 'not-leader') break;
      if (outcome === 'published') published++;
      else failed++;
    }
  }
  return { published, failed };
}
