import { setTimeout as sleep } from 'node:timers/promises';
import type { Job } from 'bullmq';
import type { JobContext } from '../processor-registry.js';

/**
 * The trivial probe processor — it proves the framework end to end (enqueue →
 * run → retry → dead-letter → drain) without touching any domain logic.
 *
 * `data.fail: true`  → always throws (exercises retry + DLQ).
 * `data.sleepMs: n`  → holds the job `n` ms (exercises graceful drain).
 */
export interface ProbeJobData {
  readonly nonce?: string;
  readonly fail?: boolean;
  readonly sleepMs?: number;
}

export async function probeProcessor(job: Job<ProbeJobData>, ctx: JobContext): Promise<unknown> {
  const { fail, sleepMs, nonce } = job.data;
  if (sleepMs && sleepMs > 0) await sleep(sleepMs);
  if (fail) throw new Error('probe: deliberate failure');
  ctx.logger.info({ nonce }, 'probe job ok');
  return { ok: true, nonce: nonce ?? null, ranAt: new Date().toISOString() };
}
