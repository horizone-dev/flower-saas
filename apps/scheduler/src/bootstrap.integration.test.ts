import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { createLogger } from '@flower/service-runtime';
import { startTestStack, type TestStack } from '@flower/testing';
import { bootstrapScheduler, type SchedulerRuntime } from './bootstrap.js';

/**
 * The scheduler framework, end to end, against a real Redis (Testcontainers) —
 * PHASE-2-CORE-PLAN §2.3 / HG-RUNTIME. The scheduler only *registers* repeatable
 * jobs (`upsertJobScheduler`) and enqueues; it runs no `Worker` itself. Only the
 * trivial probe schedule is exercised — no domain logic.
 */
describe('scheduler runtime (integration — Redis)', () => {
  let stack: TestStack;
  let redisHost: string;
  let redisPort: number;
  const log = createLogger('scheduler-test', 'silent', false);
  let runtimes: SchedulerRuntime[] = [];

  beforeAll(async () => {
    stack = await startTestStack({ services: ['redis'] });
    const url = new URL(stack.redis.url);
    redisHost = url.hostname;
    redisPort = Number(url.port);
  }, 120_000);

  afterEach(async () => {
    await Promise.allSettled(runtimes.map((r) => r.stop()));
    runtimes = [];
  });

  afterAll(async () => {
    await stack?.stop();
  });

  async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await sleep(50);
    }
  }

  it('boots independently over @flower/backend (no HTTP, no worker)', async () => {
    const runtime = await bootstrapScheduler({
      redisHost,
      redisPort,
      metricsPort: 0,
      logger: log,
      jobs: [{ schedulerId: 'probe-test', queue: 'probe', jobName: 'probe.tick', everyMs: 60_000 }],
    });
    runtimes.push(runtime);
    expect(runtime.context).toBeDefined();
    expect(runtime.registeredSchedules).toEqual(['probe-test']);
  });

  it('registers a repeatable job that actually fires on its interval', async () => {
    const runtime = await bootstrapScheduler({
      redisHost,
      redisPort,
      metricsPort: 0,
      logger: log,
      // a short interval so the test doesn't wait a full minute
      jobs: [{ schedulerId: 'probe-fast', queue: 'probe', jobName: 'probe.tick', everyMs: 200 }],
    });
    runtimes.push(runtime);

    const probeQueue = new Queue('probe', { connection: { host: redisHost, port: redisPort } });
    const fired = await waitFor(async () => {
      const repeatable = await probeQueue.getJobSchedulers();
      return repeatable.some((r) => r.key === 'probe-fast') ? true : undefined;
    });
    expect(fired).toBe(true);

    // it actually produces real jobs on the queue, not just a scheduler record
    const produced = await waitFor(async () => {
      const waiting = await probeQueue.getJobs(['waiting', 'completed', 'active'], 0, 20);
      return waiting.some((j) => j.name === 'probe.tick') ? true : undefined;
    });
    expect(produced).toBe(true);
    await probeQueue.close();
  });

  it('the default registry registers both infra schedules incl. stream-retention (task 2.8)', async () => {
    const runtime = await bootstrapScheduler({
      redisHost,
      redisPort,
      metricsPort: 0,
      logger: log,
      // no `jobs` override — exercise buildRepeatableJobs() with a fast sweep
      retentionSweepMs: 200,
    });
    runtimes.push(runtime);
    expect([...runtime.registeredSchedules].sort()).toEqual(['probe', 'stream-retention'].sort());

    const retentionQueue = new Queue('stream-retention', {
      connection: { host: redisHost, port: redisPort },
    });
    const fired = await waitFor(async () => {
      const jobs = await retentionQueue.getJobs(['waiting', 'completed', 'active'], 0, 20);
      return jobs.some((j) => j.name === 'stream-retention.tick') ? true : undefined;
    });
    expect(fired).toBe(true);
    await retentionQueue.close();
  });

  it('Redis unreachable at startup fails fast (documented policy)', async () => {
    await expect(
      bootstrapScheduler({
        redisHost: '127.0.0.1',
        redisPort: 59988, // nothing listening
        metricsPort: 0,
        logger: log,
        redisConnectTimeoutMs: 300,
      }),
    ).rejects.toThrow(/Redis unreachable/);
  });

  it('shuts down cleanly (health server + connection released, no hang)', async () => {
    const runtime = await bootstrapScheduler({
      redisHost,
      redisPort,
      metricsPort: 0,
      logger: log,
      jobs: [{ schedulerId: 'probe-stop', queue: 'probe', jobName: 'probe.tick', everyMs: 60_000 }],
    });
    await runtime.stop();
    // stop() is idempotent-safe for afterEach — nothing left to clean up here.
  });
});
