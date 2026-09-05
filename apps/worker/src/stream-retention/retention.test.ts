import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { retentionFloorId, retentionTick, trimTenantStream } from './retention.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('retentionFloorId (the whole time-based policy, one pure function)', () => {
  it('returns a `<ms>-<seq>` Stream id for "now minus the retention window", seq always 0', () => {
    expect(retentionFloorId(10_000, 3_000)).toBe('7000-0');
    expect(retentionFloorId(1_757_000_000_000, 24 * 60 * 60 * 1000)).toBe('1756913600000-0');
  });

  it('clamps at the epoch — never a negative floor', () => {
    expect(retentionFloorId(1_000, 5_000)).toBe('0-0');
    expect(retentionFloorId(0, 1)).toBe('0-0');
  });

  it('truncates fractional millis (a clock reading is not always integral)', () => {
    expect(retentionFloorId(10_000.9, 3_000.9)).toBe('7000-0');
  });

  it('is a time floor, never a count — the returned value is an id, and larger retention => smaller floor', () => {
    const shortWindow = retentionFloorId(1_000_000, 1_000);
    const longWindow = retentionFloorId(1_000_000, 500_000);
    expect(Number(shortWindow.split('-')[0])).toBeGreaterThan(Number(longWindow.split('-')[0]));
  });
});

describe('no MAXLEN-based logic exists (owner lock, proof #8)', () => {
  // The behavioural proof is retention.integration.test.ts's "trims exactly the
  // entries below the time floor — not a fixed-count tail". This is the
  // belt-and-suspenders source check: no retention source may pass `MAXLEN` as
  // an argument (a bare word in a "never MAXLEN" comment is fine, a string
  // literal is not).
  const MAXLEN_ARG = /["']MAXLEN["']/;

  it('retention.ts trims via the "MINID" argument, never a "MAXLEN" argument', () => {
    const src = readFileSync(join(HERE, 'retention.ts'), 'utf8');
    expect(src).toMatch(/["']MINID["']/);
    expect(src).not.toMatch(MAXLEN_ARG);
  });

  it('no retention/metrics/processor source passes a MAXLEN argument', () => {
    for (const rel of [
      'retention.ts',
      'stream-metrics.ts',
      '../processors/stream-retention.processor.ts',
    ]) {
      expect(readFileSync(join(HERE, rel), 'utf8')).not.toMatch(MAXLEN_ARG);
    }
  });
});

/** A minimal fake Redis that records the retention-relevant commands. */
function fakeRedis(streamKeys: string[]): {
  redis: Redis;
  xtrimCalls: unknown[][];
} {
  const xtrimCalls: unknown[][] = [];
  const redis = {
    async scan(cursor: string, ..._args: unknown[]) {
      return cursor === '0' ? ['0', streamKeys] : ['0', []];
    },
    async xtrim(...args: unknown[]) {
      xtrimCalls.push(args);
      return 0;
    },
    async xlen() {
      return 0;
    },
  } as unknown as Redis;
  return { redis, xtrimCalls };
}

describe('trimTenantStream', () => {
  it('issues XTRIM ... MINID (approximate by default), never MAXLEN', async () => {
    const { redis, xtrimCalls } = fakeRedis([]);
    await trimTenantStream(redis, 'tenant-a', '5000-0');
    expect(xtrimCalls).toHaveLength(1);
    expect(xtrimCalls[0]).toEqual(['rt:stream:tenant-a', 'MINID', '~', '5000-0']);
  });

  it('honours approximate=false (exact MINID)', async () => {
    const { redis, xtrimCalls } = fakeRedis([]);
    await trimTenantStream(redis, 'tenant-a', '5000-0', false);
    expect(xtrimCalls[0]).toEqual(['rt:stream:tenant-a', 'MINID', '5000-0']);
  });

  it('coerces the removed-count reply to a number', async () => {
    const redis = {
      async xtrim() {
        return '4';
      },
    } as unknown as Redis;
    expect(await trimTenantStream(redis, 't', '1-0')).toBe(4);
  });
});

describe('retentionTick', () => {
  it('computes one wall-clock floor and trims every discovered tenant stream with it', async () => {
    const { redis, xtrimCalls } = fakeRedis(['rt:stream:a', 'rt:stream:b', 'rt:stream:c']);
    const now = vi.fn(() => 10_000);
    const result = await retentionTick(redis, { retentionMs: 3_000 }, now);

    expect(result).toEqual({ tenantsSeen: 3, trimmed: 0, floorId: '7000-0' });
    expect(xtrimCalls.map((c) => c[0])).toEqual(['rt:stream:a', 'rt:stream:b', 'rt:stream:c']);
    // the identical floor id for every tenant — the floor is time, not per-tenant state
    expect(new Set(xtrimCalls.map((c) => c[3]))).toEqual(new Set(['7000-0']));
  });

  it('is a no-op across zero tenant streams', async () => {
    const { redis } = fakeRedis([]);
    const result = await retentionTick(redis, { retentionMs: 1_000 }, () => 5_000);
    expect(result).toEqual({ tenantsSeen: 0, trimmed: 0, floorId: '4000-0' });
  });
});
