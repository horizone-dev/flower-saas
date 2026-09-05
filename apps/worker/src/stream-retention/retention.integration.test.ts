import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { streamKey } from '@flower/backend';
import { startTestStack, type TestStack } from '@flower/testing';
import { retentionFloorId, retentionTick, trimTenantStream } from './retention.js';

/**
 * Realtime-Stream retention (task 2.8, ADR-0017 §5), end to end against a real
 * Redis (Testcontainers). No mocked Redis. The owner-locked proof set:
 *
 *   1. an entry older than the retention floor is eligible for trimming
 *   2. a newer entry remains
 *   3. tenant A trimming does not trim tenant B
 *   4. repeated execution is safe / idempotent
 *   5. a client cursor below the retained Stream floor -> the existing
 *      resync-required behaviour (proven here at the contract level: the
 *      trimmed cursor is strictly below `XINFO STREAM`'s recorded-first-entry-id,
 *      which is exactly the predicate `apps/realtime`'s `GatewayHub.resume`
 *      applies; the gateway-side wire behaviour itself is proven in
 *      `apps/realtime/src/resume.integration.test.ts`)
 *   6. a cursor still within retention can replay normally (its id is >= the
 *      retained floor)
 *   7. retention never rewrites `event_id` / `seq` (or the Stream entry id)
 *   8. no MAXLEN-based logic — trimming is a threshold cut at the time floor,
 *      never "keep the last N"
 *
 * The integration tests use the EXACT (`approximate: false`) form of
 * `XTRIM ... MINID` so the assertions are deterministic — the approximate
 * (`~`) form (the production default, cheaper) may leave a few entries just
 * past the floor and is covered by the unit tests instead.
 */
describe('realtime stream retention (integration — Redis)', () => {
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

  function envelope(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      event_id: randomUUID(),
      seq: '1',
      tenant_id: randomUUID(),
      branch_id: null,
      type: 'test.event',
      resource_type: 'tenant',
      resource_id: randomUUID(),
      resource_version: null,
      occurred_at: new Date().toISOString(),
      actor_summary: null,
      ...over,
    });
  }

  /** `XADD key <explicit id> event <json>` — an explicit id lets a test place
   *  an entry precisely above or below a synthetic retention floor. */
  async function add(tenantId: string, id: string, env: string = envelope()): Promise<string> {
    return (await redis.xadd(streamKey(tenantId), id, 'event', env)) as string;
  }

  async function ids(tenantId: string): Promise<string[]> {
    const raw = await redis.xrange(streamKey(tenantId), '-', '+');
    return raw.map(([entryId]) => entryId);
  }

  /** `XINFO STREAM`'s `recorded-first-entry-id` — the retained floor the
   *  realtime gateway's `resume()` compares a client cursor against. */
  async function retainedFloor(tenantId: string): Promise<string | null> {
    const raw = (await redis.call('XINFO', 'STREAM', streamKey(tenantId))) as unknown[];
    const info = new Map<string, unknown>();
    for (let i = 0; i + 1 < raw.length; i += 2) info.set(raw[i] as string, raw[i + 1]);
    return Number(info.get('length') ?? 0) > 0
      ? (info.get('recorded-first-entry-id') as string)
      : null;
  }

  /** Compare two Redis Stream ids (`ms-seq`) numerically — the same ordering
   *  `apps/realtime`'s `gateway/cursor.ts` `compareStreamIds` implements. */
  function cmpId(a: string, b: string): number {
    const [am, as_] = a.split('-').map(Number);
    const [bm, bs] = b.split('-').map(Number);
    return am !== bm ? am! - bm! : as_! - bs!;
  }

  // ── proofs 1 + 2 ──────────────────────────────────────────────────────────
  it('an entry older than the floor is trimmed; a newer entry remains', async () => {
    const t = randomUUID();
    await add(t, '2000-1');
    const keep = await add(t, '9000-1');

    // now=10_000, retention=3_000 -> floor 7000-0 (between the two entries)
    const result = await retentionTick(
      redis,
      { retentionMs: 3_000, approximate: false },
      () => 10_000,
    );

    expect(result.floorId).toBe('7000-0');
    expect(result.trimmed).toBe(1);
    expect(await ids(t)).toEqual([keep]);
  });

  it('keeps every entry when all are newer than the floor (not a "keep last N" cut)', async () => {
    const t = randomUUID();
    for (let i = 1; i <= 5; i++) await add(t, `${8000 + i}-1`);

    const result = await retentionTick(
      redis,
      { retentionMs: 3_000, approximate: false },
      () => 10_000,
    );
    expect(result.trimmed).toBe(0);
    expect(await ids(t)).toHaveLength(5);
  });

  // ── proof 3 — tenant isolation ────────────────────────────────────────────
  it('trimming tenant A never touches tenant B', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await add(a, '2000-1');
    await add(a, '9000-1');
    const bOld = await add(b, '2000-1');
    const bNew = await add(b, '9000-1');

    // trim ONLY tenant A, directly
    const removed = await trimTenantStream(redis, a, retentionFloorId(10_000, 3_000), false);
    expect(removed).toBe(1);
    expect(await ids(a)).toEqual(['9000-1']);
    expect(await ids(b)).toEqual([bOld, bNew]); // B completely untouched

    // and a full sweep trims each tenant by the same time floor, independently
    await add(a, '9500-1');
    const result = await retentionTick(
      redis,
      { retentionMs: 3_000, approximate: false },
      () => 10_000,
    );
    expect(result.tenantsSeen).toBe(2);
    expect(await ids(b)).toEqual(['9000-1']); // B's own old entry now gone, by B's own floor
  });

  // ── proof 4 — idempotent / safe to repeat ─────────────────────────────────
  it('a repeated sweep (duplicate scheduler firing / job retry) does not corrupt state', async () => {
    const t = randomUUID();
    await add(t, '2000-1');
    await add(t, '3000-1');
    const keep = await add(t, '9000-1');

    const first = await retentionTick(
      redis,
      { retentionMs: 3_000, approximate: false },
      () => 10_000,
    );
    expect(first.trimmed).toBe(2);
    const afterFirst = await ids(t);

    const second = await retentionTick(
      redis,
      { retentionMs: 3_000, approximate: false },
      () => 10_000,
    );
    expect(second.trimmed).toBe(0); // nothing left below the floor
    expect(await ids(t)).toEqual(afterFirst);
    expect(await ids(t)).toEqual([keep]);

    // running it twice back-to-back with no `await` between also never throws
    await Promise.all([
      retentionTick(redis, { retentionMs: 3_000, approximate: false }, () => 10_000),
      retentionTick(redis, { retentionMs: 3_000, approximate: false }, () => 10_000),
    ]);
    expect(await ids(t)).toEqual([keep]);
  });

  // ── proofs 5 + 6 — cursor vs. retained floor ──────────────────────────────
  it('after a trim, a below-floor cursor sorts below XINFO recorded-first-entry-id; a within-retention cursor does not', async () => {
    const t = randomUUID();
    const trimmedCursor = await add(t, '2000-1');
    const retainedCursor = await add(t, '9000-1');

    await retentionTick(redis, { retentionMs: 3_000, approximate: false }, () => 10_000);

    const floor = await retainedFloor(t);
    expect(floor).not.toBeNull();
    // proof 5: the gateway's resume() sees `cursor < floor` -> resync-required
    expect(cmpId(trimmedCursor, floor!)).toBeLessThan(0);
    // proof 6: a cursor still in the window is >= floor -> normal replay
    expect(cmpId(retainedCursor, floor!)).toBeGreaterThanOrEqual(0);
  });

  // ── proof 7 — no envelope / id rewriting ──────────────────────────────────
  it('retention never rewrites event_id, seq or the Stream entry id of a surviving entry', async () => {
    const t = randomUUID();
    const eventId = randomUUID();
    await add(t, '2000-1', envelope({ event_id: randomUUID(), seq: '41', type: 'doomed' }));
    const survivorId = await add(
      t,
      '9000-1',
      envelope({ event_id: eventId, seq: '42', type: 'survivor', tenant_id: t }),
    );

    await retentionTick(redis, { retentionMs: 3_000, approximate: false }, () => 10_000);

    const raw = await redis.xrange(streamKey(t), '-', '+');
    expect(raw).toHaveLength(1);
    const [entryId, fields] = raw[0]!;
    expect(entryId).toBe(survivorId); // the Stream entry id is byte-identical
    const parsed = JSON.parse(fields[fields.indexOf('event') + 1]!) as Record<string, unknown>;
    expect(parsed['event_id']).toBe(eventId);
    expect(parsed['seq']).toBe('42');
    expect(parsed['type']).toBe('survivor');
  });

  // ── proof 8 — threshold cut, never "keep the last N" ──────────────────────
  it('trims exactly the entries below the time floor — not a fixed-count tail', async () => {
    const t = randomUUID();
    for (let ms = 1; ms <= 10; ms++) await add(t, `${ms * 1000}-1`); // 1000-1 .. 10000-1

    // floor 5000-0: entries at 1000..4000 are below it, 5000..10000 are not
    await retentionTick(redis, { retentionMs: 5_000, approximate: false }, () => 10_000);

    expect(await ids(t)).toEqual(['5000-1', '6000-1', '7000-1', '8000-1', '9000-1', '10000-1']);
  });
});
