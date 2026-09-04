import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import type { DbService } from '@flower/backend';
import type { Logger } from '@flower/service-runtime';
import { allocateTenantSeq, discoverUnstampedTenants } from './seq-allocator.js';
import { publishReadyBatch } from './publisher.js';
import { DEFAULT_PUBLISH_BACKOFF, type PublishBackoffPolicy } from './backoff.js';

export interface OutboxDispatcherOptions {
  readonly db: DbService;
  readonly redis: Redis;
  readonly logger: Logger;
  /** how often a tick runs when there's nothing left to do (ms) */
  readonly tickIntervalMs?: number;
  /** candidate tenants (with unstamped work) considered per tick */
  readonly tenantBatchSize?: number;
  /** rows stamped per tenant per allocation attempt */
  readonly seqBatchSize?: number;
  /** rows published per tick */
  readonly publishBatchSize?: number;
  readonly backoff?: PublishBackoffPolicy;
}

export interface DispatcherTickResult {
  readonly tenantsTried: number;
  readonly stamped: number;
  readonly published: number;
  readonly failed: number;
}

const DEFAULTS = {
  tickIntervalMs: 500,
  tenantBatchSize: 10,
  seqBatchSize: 50,
  publishBatchSize: 20,
};

/**
 * The outbox dispatcher (task 2.4): PostgreSQL `outbox` → durable per-tenant
 * Redis Stream. A dedicated loop in `apps/worker` — **not** a BullMQ queue
 * (PHASE-2-CORE-PLAN §2.3/§2.4). Two independent phases per tick:
 *
 *   A. **Seq allocation** — for each candidate tenant with unstamped work, try
 *      to become that tenant's advisory-lock leader and stamp its rows
 *      (`allocateTenantSeq`). One failing tenant (a thrown error) is isolated
 *      and never blocks another tenant's turn, or the publish phase below.
 *   B. **Publish** — drain already-stamped, eligible rows to their tenant's
 *      Redis Stream (`publishReadyBatch`), independent of which tenant they
 *      belong to or who stamped them.
 *
 * The outbox row + business mutation are already atomic in PostgreSQL (the
 * caller's transaction, via `OutboxWriter`); this dispatcher never treats Redis
 * as authoritative — a row is only ever "done" once `dispatched_at` is durably
 * committed in Postgres.
 */
export class OutboxDispatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly opts: OutboxDispatcherOptions) {}

  /** Run exactly one tick — exposed directly for tests and manual draining. */
  async tick(): Promise<DispatcherTickResult> {
    const { db, redis, logger, backoff = DEFAULT_PUBLISH_BACKOFF } = this.opts;
    const tenantBatchSize = this.opts.tenantBatchSize ?? DEFAULTS.tenantBatchSize;
    const seqBatchSize = this.opts.seqBatchSize ?? DEFAULTS.seqBatchSize;
    const publishBatchSize = this.opts.publishBatchSize ?? DEFAULTS.publishBatchSize;

    const candidates = await discoverUnstampedTenants(db, tenantBatchSize);
    let stamped = 0;
    for (const tenantId of candidates) {
      try {
        const res = await allocateTenantSeq(db, tenantId, seqBatchSize);
        stamped += res.stamped;
      } catch (err) {
        // one poisoned tenant's allocation must never block the others, or the
        // publish phase below (constraint 4/7).
        logger.error({ err, tenantId }, 'outbox dispatcher: seq allocation failed for tenant');
      }
    }

    const { published, failed } = await publishReadyBatch(db, redis, publishBatchSize, backoff);
    return { tenantsTried: candidates.length, stamped, published, failed };
  }

  /** Start the periodic loop. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.timer || this.stopped) return;
    const loop = (): void => {
      if (this.stopped) return;
      this.ticking = true;
      this.tick()
        .then((result) => {
          if (result.published > 0 || result.stamped > 0 || result.failed > 0) {
            this.opts.logger.debug(result, 'outbox dispatcher tick');
          }
        })
        .catch((err: unknown) => {
          this.opts.logger.error({ err }, 'outbox dispatcher tick failed');
        })
        .finally(() => {
          this.ticking = false;
          if (!this.stopped) {
            this.timer = setTimeout(loop, this.opts.tickIntervalMs ?? DEFAULTS.tickIntervalMs);
          }
        });
    };
    loop();
  }

  /** Stop the loop and wait for any in-flight tick to finish (graceful drain). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.ticking) await sleep(20);
  }
}
