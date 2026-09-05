import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobContext } from '../processor-registry.js';
import {
  retentionTick,
  type RetentionOptions,
  type RetentionTickResult,
} from '../stream-retention/retention.js';
import {
  streamSnapshot,
  streamGrowthWarnings,
  type StreamGrowthThreshold,
} from '../stream-retention/stream-metrics.js';

/**
 * The realtime-Stream retention processor (task 2.8). The scheduler enqueues a
 * `stream-retention.tick` on its interval; this runs it — one `XTRIM … MINID`
 * per tenant stream (`retentionTick`). BullMQ gives the job idempotency +
 * retry for free, and `XTRIM` is itself safe to run repeatedly, so a duplicate
 * scheduler firing / a job retry never corrupts state.
 *
 * After trimming it takes one bounded stream-growth reading and logs a warning
 * (with the offending tenant id) only if a single stream is abnormally long —
 * never emitting a per-tenant metric.
 */
export interface StreamRetentionProcessorDeps {
  readonly redis: Redis;
  readonly retention?: RetentionOptions;
  readonly growthThreshold?: StreamGrowthThreshold;
  /** test hook — the last tick's result, for the worker `/metrics` payload. */
  readonly onResult?: (r: RetentionTickResult) => void;
}

export function makeStreamRetentionProcessor(deps: StreamRetentionProcessorDeps) {
  return async function streamRetentionProcessor(
    job: Job,
    ctx: JobContext,
  ): Promise<RetentionTickResult> {
    void job;
    const result = await retentionTick(deps.redis, deps.retention);
    if (result.trimmed > 0) {
      ctx.logger.info(
        { tenantsSeen: result.tenantsSeen, trimmed: result.trimmed, floorId: result.floorId },
        'realtime stream retention: entries trimmed',
      );
    }
    deps.onResult?.(result);

    const snap = await streamSnapshot(deps.redis, deps.retention?.tenantScanCount);
    for (const w of streamGrowthWarnings(snap, deps.growthThreshold)) {
      ctx.logger.warn(
        { code: w.code, tenantId: w.tenantId, streamLen: w.value },
        'realtime stream abnormal growth',
      );
    }
    return result;
  };
}
