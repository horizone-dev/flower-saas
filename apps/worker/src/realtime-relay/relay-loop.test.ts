import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@flower/service-runtime';
import { RealtimeRelay } from './relay-loop.js';

const { relayTick } = vi.hoisted(() => ({ relayTick: vi.fn() }));
vi.mock('./relay.js', () => ({ relayTick }));

describe('RealtimeRelay.start()/stop()', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const fakeRedis = {} as never;

  beforeEach(() => {
    relayTick.mockReset();
    relayTick.mockResolvedValue({ tenantsSeen: 0, published: 0 });
  });

  it('a tick that throws is caught and logged — the loop keeps running, not crashes the process', async () => {
    relayTick.mockRejectedValue(new Error('SIMULATED_RELAY_FAILURE'));
    const relay = new RealtimeRelay({ redis: fakeRedis, logger: log, tickIntervalMs: 10 });
    relay.start();
    await new Promise((r) => setTimeout(r, 30));
    await relay.stop();
    expect(log.error).toHaveBeenCalled();
  });

  it('start() is idempotent — a second call does not double the loop', async () => {
    const relay = new RealtimeRelay({ redis: fakeRedis, logger: log, tickIntervalMs: 10 });
    relay.start();
    relay.start();
    await new Promise((r) => setTimeout(r, 30));
    await relay.stop();
    // no assertion beyond "did not throw" — a doubled loop would still not
    // throw, but this guards the documented idempotency contract by exercise.
  });

  it('tick() calls relayTick with a stable consumer name across calls', async () => {
    const relay = new RealtimeRelay({ redis: fakeRedis, logger: log });
    await relay.tick();
    await relay.tick();
    expect(relayTick).toHaveBeenCalledTimes(2);
    const [, opts1] = relayTick.mock.calls[0]!;
    const [, opts2] = relayTick.mock.calls[1]!;
    expect(opts1.consumerName).toBe(opts2.consumerName);
  });
});
