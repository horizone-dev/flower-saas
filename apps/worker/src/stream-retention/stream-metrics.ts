import type { Redis } from 'ioredis';
import { streamKey } from '@flower/backend';
import { discoverTenantStreams } from '../realtime-relay/relay.js';

/**
 * Bounded aggregate realtime-Stream signals (task 2.8, operational visibility).
 * Same scalability rule as `outbox/metrics.ts`: **global aggregates only** —
 * `tenantStreams` is a count, `maxStreamLen` / `totalStreamLen` are aggregates.
 * The abnormally-long stream's tenant id is surfaced as `worstTenantId` for a
 * threshold-breach diagnostic log only — never a metric key.
 */
export interface StreamSnapshot {
  readonly tenantStreams: number;
  readonly maxStreamLen: number;
  readonly totalStreamLen: number;
  readonly worstTenantId: string | null;
}

export async function streamSnapshot(redis: Redis, tenantScanCount = 100): Promise<StreamSnapshot> {
  const tenantIds = await discoverTenantStreams(redis, tenantScanCount);
  let maxStreamLen = 0;
  let totalStreamLen = 0;
  let worstTenantId: string | null = null;
  for (const tenantId of tenantIds) {
    const len = Number(await redis.xlen(streamKey(tenantId))) || 0;
    totalStreamLen += len;
    if (len > maxStreamLen) {
      maxStreamLen = len;
      worstTenantId = tenantId;
    }
  }
  return { tenantStreams: tenantIds.length, maxStreamLen, totalStreamLen, worstTenantId };
}

export interface StreamGrowthThreshold {
  /** log a warning once any single stream exceeds this many entries. */
  readonly maxStreamLen: number;
}

export const DEFAULT_STREAM_GROWTH_THRESHOLD: StreamGrowthThreshold = { maxStreamLen: 100_000 };

export function streamGrowthWarnings(
  snap: StreamSnapshot,
  threshold: StreamGrowthThreshold = DEFAULT_STREAM_GROWTH_THRESHOLD,
): { code: string; tenantId: string | null; value: number }[] {
  if (snap.maxStreamLen > threshold.maxStreamLen) {
    return [
      {
        code: 'REALTIME_STREAM_GROWTH_ABNORMAL',
        tenantId: snap.worstTenantId,
        value: snap.maxStreamLen,
      },
    ];
  }
  return [];
}
