import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { streamKey, liveChannel } from '@flower/backend';
import { startTestStack, type TestStack } from '@flower/testing';
import { discoverTenantStreams, relayTenant, relayTick } from './relay.js';

/**
 * The realtime relay, end to end, against real Redis (Testcontainers) —
 * PHASE-2-CORE-PLAN §2.5 / ADR-0017 §4 / OI-P2-2. No mocked Redis anywhere in
 * this file, and — deliberately — no Postgres/`@flower/db` at all: the relay
 * is a pure Redis consumer (owner instruction: "the relay consumes the durable
 * realtime Stream only", "do not duplicate the 2.4 dispatcher").
 */
describe('realtime relay (integration — Redis)', () => {
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

  /** Subscribes to `channel` and resolves `messages` once `expect` messages
   *  have arrived (or after a generous timeout, whichever first) — faster and
   *  less flaky under CI load than a fixed collection window. */
  async function subscribeOnce(
    channel: string,
    expectCount = 1,
  ): Promise<{ messages: Promise<string[]> }> {
    const sub = new Redis(stack.redis.url);
    const collected: string[] = [];
    let resolveMessages: (v: string[]) => void;
    const messages = new Promise<string[]>((resolve) => {
      resolveMessages = resolve;
    });
    await sub.subscribe(channel);
    sub.on('message', (_ch, msg: string) => {
      collected.push(msg);
      if (collected.length >= expectCount) resolveMessages(collected);
    });
    const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve(collected), 5_000));
    return {
      messages: Promise.race([messages, timeout]).finally(async () => {
        await sub.unsubscribe(channel);
        await sub.quit();
      }),
    };
  }

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

  // ── discovery ──────────────────────────────────────────────────────────
  it('discoverTenantStreams finds every rt:stream:{tenantId} key, nothing else', async () => {
    const t1 = randomUUID();
    const t2 = randomUUID();
    await redis.xadd(streamKey(t1), '*', 'event', envelope({ tenant_id: t1 }));
    await redis.xadd(streamKey(t2), '*', 'event', envelope({ tenant_id: t2 }));
    await redis.set('rt:revoke:not-a-stream', '1'); // must not be misparsed as a tenant

    const found = await discoverTenantStreams(redis);
    expect(found.sort()).toEqual([t1, t2].sort());
  });

  /** The relay publishes a `{cursor, event}` transport wrapper (task 2.6) —
   *  the Redis Stream entry id alongside the untouched envelope. */
  function wrapper(id: string, env: string): string {
    return JSON.stringify({ cursor: id, event: JSON.parse(env) });
  }

  // ── single event relay ────────────────────────────────────────────────
  it('a single stream entry is published to rt:live:{tenantId} as {cursor, event} — event verbatim', async () => {
    const tenantId = randomUUID();
    const env = envelope({ tenant_id: tenantId, type: 'single.event' });
    const id = await redis.xadd(streamKey(tenantId), '*', 'event', env);

    const sub = await subscribeOnce(liveChannel(tenantId));
    const published = await relayTenant(redis, tenantId, { consumerName: 'c1' });
    expect(published).toBe(1);

    const messages = await sub.messages;
    expect(messages).toEqual([wrapper(id!, env)]);
  });

  // ── multiple tenants relayed independently ───────────────────────────
  it('relayTick discovers and relays every tenant independently', async () => {
    const tA = randomUUID();
    const tB = randomUUID();
    const envA = envelope({ tenant_id: tA, type: 'a.event' });
    const envB = envelope({ tenant_id: tB, type: 'b.event' });
    const idA = await redis.xadd(streamKey(tA), '*', 'event', envA);
    const idB = await redis.xadd(streamKey(tB), '*', 'event', envB);

    const subA = await subscribeOnce(liveChannel(tA));
    const subB = await subscribeOnce(liveChannel(tB));
    const result = await relayTick(redis, { consumerName: 'c1' });
    expect(result.tenantsSeen).toBe(2);
    expect(result.published).toBe(2);

    expect(await subA.messages).toEqual([wrapper(idA!, envA)]);
    expect(await subB.messages).toEqual([wrapper(idB!, envB)]);
  });

  // ── relay restart loses no event (task 2.5 demonstration 7) ──────────
  it('a crashed relay (delivered but never XACKed) is reclaimed by the next tick — no event lost', async () => {
    const tenantId = randomUUID();
    const env = envelope({ tenant_id: tenantId, type: 'crash-before-ack' });
    const id = await redis.xadd(streamKey(tenantId), '*', 'event', env);

    // Simulate the crash directly: create the group, XREADGROUP (delivers +
    // marks pending) as consumer "dead-consumer", then never XACK — exactly
    // what a relay process crashing between XREADGROUP and XACK leaves behind.
    await redis.xgroup('CREATE', streamKey(tenantId), 'relay', '0', 'MKSTREAM');
    const delivered = await redis.xreadgroup(
      'GROUP',
      'relay',
      'dead-consumer',
      'COUNT',
      10,
      'STREAMS',
      streamKey(tenantId),
      '>',
    );
    expect(delivered).not.toBeNull(); // sanity: the "crashed" delivery really happened

    // nothing published yet — the crashed consumer died before PUBLISH+XACK.
    const sub = await subscribeOnce(liveChannel(tenantId));

    // a FRESH relay instance, minIdleMs 0 so the still-pending entry is
    // immediately eligible for XAUTOCLAIM (a real deployment would use a
    // larger window; 0 here only speeds up the test, it does not change what
    // is being proven — XAUTOCLAIM reclaims regardless of original consumer).
    const published = await relayTenant(redis, tenantId, {
      consumerName: 'new-consumer',
      minIdleMs: 0,
    });
    expect(published).toBe(1);
    expect(await sub.messages).toEqual([wrapper(id!, env)]);

    // and it is now genuinely acked — a further tick finds nothing left.
    const again = await relayTenant(redis, tenantId, {
      consumerName: 'new-consumer',
      minIdleMs: 0,
    });
    expect(again).toBe(0);
  });

  // ── idempotent group creation ─────────────────────────────────────────
  it('relaying the same tenant twice (group already exists) does not throw', async () => {
    const tenantId = randomUUID();
    await redis.xadd(streamKey(tenantId), '*', 'event', envelope({ tenant_id: tenantId }));
    await relayTenant(redis, tenantId, { consumerName: 'c1' });
    await expect(relayTenant(redis, tenantId, { consumerName: 'c1' })).resolves.toBe(0);
  });
});
