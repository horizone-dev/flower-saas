import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { streamKey } from '@flower/backend';
import { startTestStack, type TestStack } from '@flower/testing';
import {
  streamSnapshot,
  streamGrowthWarnings,
  DEFAULT_STREAM_GROWTH_THRESHOLD,
  type StreamSnapshot,
} from './stream-metrics.js';

function snap(over: Partial<StreamSnapshot> = {}): StreamSnapshot {
  return { tenantStreams: 0, maxStreamLen: 0, totalStreamLen: 0, worstTenantId: null, ...over };
}

describe('streamGrowthWarnings (bounded aggregate, threshold-triggered)', () => {
  it('silent while the largest stream is within the threshold', () => {
    expect(streamGrowthWarnings(snap({ maxStreamLen: 10, tenantStreams: 4 }))).toEqual([]);
  });

  it('flags an abnormally long stream with the offending tenant id (for a log line)', () => {
    const w = streamGrowthWarnings(
      snap({
        maxStreamLen: DEFAULT_STREAM_GROWTH_THRESHOLD.maxStreamLen + 1,
        worstTenantId: 'tenant-z',
      }),
    );
    expect(w).toEqual([
      {
        code: 'REALTIME_STREAM_GROWTH_ABNORMAL',
        tenantId: 'tenant-z',
        value: DEFAULT_STREAM_GROWTH_THRESHOLD.maxStreamLen + 1,
      },
    ]);
  });

  it('a warning object carries only {code, tenantId, value}', () => {
    const w = streamGrowthWarnings(snap({ maxStreamLen: 1e9, worstTenantId: 't' }));
    expect(Object.keys(w[0]!).sort()).toEqual(['code', 'tenantId', 'value']);
  });
});

describe('streamSnapshot (integration — Redis)', () => {
  let stack: TestStack;
  let redis: Redis;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['redis'] });
    redis = new Redis(stack.redis.url);
  }, 120_000);

  afterAll(async () => {
    await redis?.quit();
    await stack?.stop();
  });

  afterEach(async () => {
    const keys = await redis.keys('rt:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  it('reports bounded aggregates across every discovered tenant stream', async () => {
    const small = randomUUID();
    const big = randomUUID();
    await redis.xadd(streamKey(small), '*', 'event', '{}');
    for (let i = 0; i < 4; i++) await redis.xadd(streamKey(big), '*', 'event', '{}');

    const s = await streamSnapshot(redis);
    expect(s.tenantStreams).toBe(2);
    expect(s.maxStreamLen).toBe(4);
    expect(s.totalStreamLen).toBe(5);
    expect(s.worstTenantId).toBe(big);
  });

  it('is a clean zero snapshot when no streams exist', async () => {
    expect(await streamSnapshot(redis)).toEqual({
      tenantStreams: 0,
      maxStreamLen: 0,
      totalStreamLen: 0,
      worstTenantId: null,
    });
  });
});
