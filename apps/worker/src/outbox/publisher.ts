import { runPlatform } from '@flower/db';
import type { DbService } from '@flower/backend';
import type { Redis } from 'ioredis';
import { buildEnvelope, streamKey, ENVELOPE_FIELD, type OutboxRow } from './envelope.js';
import {
  nextAvailableAt,
  sanitizeError,
  DEFAULT_PUBLISH_BACKOFF,
  type PublishBackoffPolicy,
} from './backoff.js';

export type PublishOutcome = 'published' | 'failed' | 'empty';

/**
 * Phase B — publish exactly one already-stamped, eligible row.
 *
 * Runs as its own short `runPlatform` transaction: `SELECT … FOR UPDATE SKIP
 * LOCKED LIMIT 1` claims one row (globally oldest-first across tenants —
 * `outbox_ready_to_publish_idx`), attempts `XADD`, then — **within the same
 * transaction** — either marks `dispatched_at` (success) or bumps
 * `attempts`/`available_at`/`last_error` (failure), and commits.
 *
 * This is the source of the FC-1 crash scenarios by construction, not by
 * simulation: if the process dies after a successful `XADD` but before this
 * transaction commits, Postgres rolls the whole transaction back — the row's
 * `seq` (stamped durably in a *prior*, already-committed transaction —
 * `allocateTenantSeq`) is untouched, `dispatched_at` stays null, and the next
 * `publishOne` call re-selects the same row and republishes it, `XADD`ing the
 * **identical `event_id` + `seq`** (a duplicate Stream entry — architecturally
 * acceptable, suppressed downstream by `event_id`). If the crash happens
 * *before* `XADD` at all, nothing changed — the row is simply retried, exactly
 * once published. If the crash happens *after* this transaction's commit
 * (`dispatched_at` durably set), the row is no longer selected — never
 * republished.
 *
 * One row per transaction, not a whole batch, deliberately: it minimises how
 * long any row-level lock is held across the network round-trip to Redis, and
 * it means a mid-batch crash can only ever leave *one* row's ack unresolved.
 *
 * `FOR UPDATE SKIP LOCKED` here needs no tenant-level coordination — by the time
 * a row reaches this step its `seq` is immutable and final (stamped once, by
 * whichever process was the tenant's leader); publishing it is safe from any
 * number of concurrent callers, and per ADR-0017 a duplicate/out-of-order live
 * delivery is explicitly tolerated (dedup + reorder handling are part of the
 * approved client protocol, not a dispatcher concern).
 */
export async function publishOne(
  db: DbService,
  redis: Redis,
  backoff: PublishBackoffPolicy = DEFAULT_PUBLISH_BACKOFF,
): Promise<PublishOutcome> {
  return runPlatform(db.platformClient(), async (tx) => {
    const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
      `SELECT id, "tenantId", "branchId", "aggregateType", "aggregateId", "eventType",
              "resourceVersion", "actorSummary", "createdAt", seq, attempts
         FROM outbox
        WHERE seq IS NOT NULL AND "dispatchedAt" IS NULL AND "availableAt" <= now()
          AND "tenantId" IS NOT NULL
        ORDER BY "createdAt", id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
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

export interface PublishBatchResult {
  readonly published: number;
  readonly failed: number;
}

/** Drain up to `batchSize` ready rows, one `publishOne` transaction each. */
export async function publishReadyBatch(
  db: DbService,
  redis: Redis,
  batchSize = 20,
  backoff: PublishBackoffPolicy = DEFAULT_PUBLISH_BACKOFF,
): Promise<PublishBatchResult> {
  let published = 0;
  let failed = 0;
  for (let i = 0; i < batchSize; i++) {
    const outcome = await publishOne(db, redis, backoff);
    if (outcome === 'empty') break;
    if (outcome === 'published') published++;
    else failed++;
  }
  return { published, failed };
}
