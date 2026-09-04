import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue, type Job } from 'bullmq';
import { createLogger } from '@flower/service-runtime';
import { startTestStack, type TestStack } from '@flower/testing';
import { bootstrapWorker, type WorkerRuntime, type WorkerRuntimeOptions } from './bootstrap.js';
import { DEAD_LETTER_QUEUE } from './queues.js';
import type { DeadLetter } from './processor-registry.js';

/**
 * The worker framework, end to end, against a real Redis (Testcontainers) —
 * PHASE-2-CORE-PLAN §2.3 / HG-RUNTIME. Only the trivial probe processor is
 * exercised; no domain logic.
 *
 * Every test boots its **own** `WorkerRuntime` and it is stopped in `afterEach`
 * — two `Worker`s left running on the same BullMQ queue name would otherwise
 * race to lock a later test's job (and make the drain-timing assertion flaky:
 * a leftover worker from an earlier test can steal and finish the job before
 * the current test's own runtime ever sees it as active).
 */
describe('worker runtime (integration — Redis)', () => {
  let stack: TestStack;
  let redisHost: string;
  let redisPort: number;
  const log = createLogger('worker-test', 'silent', false);
  let runtimes: WorkerRuntime[] = [];

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

  async function boot(overrides: Partial<WorkerRuntimeOptions> = {}): Promise<WorkerRuntime> {
    const runtime = await bootstrapWorker({
      redisHost,
      redisPort,
      metricsPort: 0, // these tests don't hit the health server over HTTP
      logger: log,
      retryPolicy: { attempts: 2, backoffMs: 20 },
      ...overrides,
    });
    runtimes.push(runtime);
    return runtime;
  }

  async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await sleep(50);
    }
  }

  it('boots independently and resolves a @flower/backend service via the Nest context', async () => {
    const runtime = await boot();
    expect(runtime.context).toBeDefined();
    expect(runtime.registry.registeredQueues).toEqual(['probe']);
  });

  it('a trivial job round-trips through the real processor', async () => {
    const runtime = await boot();
    const nonce = randomUUID();
    const jobId = await runtime.registry.enqueue('probe', 'probe.tick', { nonce });
    const probeQueue = new Queue('probe', { connection: runtime.connection });
    const state = await waitFor(async () => {
      const job = await probeQueue.getJob(jobId);
      const s = await job?.getState();
      return s === 'completed' ? s : undefined;
    });
    expect(state).toBe('completed');
    await probeQueue.close();
  });

  it('a transient failure retries, then a repeated failure reaches the dead-letter queue', async () => {
    const runtime = await boot(); // attempts: 2 from the default overrides above
    const nonce = randomUUID();
    await runtime.registry.enqueue('probe', 'probe.tick', { nonce, fail: true });

    const dlq = new Queue(DEAD_LETTER_QUEUE, { connection: runtime.connection });
    const dead = await waitFor(async () => {
      const jobs = await dlq.getJobs(['waiting', 'completed'], 0, 100);
      return jobs.find(
        (j: Job<DeadLetter>) => j.data.data && (j.data.data as { nonce?: string }).nonce === nonce,
      );
    });
    expect(dead!.data.attemptsMade).toBe(2);
    expect(dead!.data.failedReason).toMatch(/deliberate failure/);
    expect(dead!.data.queue).toBe('probe');
    await dlq.close();
  });

  it('graceful shutdown drains the in-flight job instead of abandoning it', async () => {
    const runtime = await boot({ retryPolicy: { attempts: 1, backoffMs: 10 } });
    const nonce = randomUUID();
    const jobId = await runtime.registry.enqueue('probe', 'probe.tick', { nonce, sleepMs: 300 });

    // Wait for the job to actually be locked/running before draining — a fixed
    // sleep is flaky under container/CI scheduling jitter.
    const probeQueue = new Queue('probe', { connection: { host: redisHost, port: redisPort } });
    await waitFor(async () => {
      const job = await probeQueue.getJob(jobId);
      const s = await job?.getState();
      return s === 'active' ? true : undefined;
    });

    const stopStarted = Date.now();
    await runtime.stop(); // must wait for the 300ms handler to finish, not kill it mid-flight
    runtimes = []; // already stopped — don't let afterEach double-stop it
    expect(Date.now() - stopStarted).toBeGreaterThanOrEqual(150);

    // `runtime.connection` was disconnected by `stop()` — the probeQueue above
    // used its own fresh connection, so it is still usable here.
    const job = await probeQueue.getJob(jobId);
    expect(await job?.getState()).toBe('completed');
    await probeQueue.close();
  });

  it('Redis unreachable at startup fails fast (documented policy)', async () => {
    await expect(
      bootstrapWorker({
        redisHost: '127.0.0.1',
        redisPort: 59987, // nothing listening
        metricsPort: 0,
        logger: log,
        redisConnectTimeoutMs: 300,
      }),
    ).rejects.toThrow(/Redis unreachable/);
  });
});
