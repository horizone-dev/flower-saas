import { describe, expect, it } from 'vitest';
import {
  buildRepeatableJobs,
  DEFAULT_RETENTION_SWEEP_MS,
  REPEATABLE_JOBS,
  STREAM_RETENTION_SCHEDULER_ID,
} from './schedules.js';

describe('scheduler repeatable jobs', () => {
  it('every job has a unique schedulerId, a positive interval and a target queue', () => {
    const ids = new Set<string>();
    for (const job of REPEATABLE_JOBS) {
      expect(ids.has(job.schedulerId), job.schedulerId).toBe(false);
      ids.add(job.schedulerId);
      expect(job.everyMs).toBeGreaterThan(0);
      expect(job.queue).toBeTruthy();
      expect(job.jobName).toBeTruthy();
    }
  });

  it('Phase 2-core ships the trivial probe schedule (framework proof, no domain job)', () => {
    expect(REPEATABLE_JOBS.some((j) => j.schedulerId === 'probe' && j.queue === 'probe')).toBe(
      true,
    );
  });

  it('ships the realtime-Stream retention sweep on its own infra queue (task 2.8)', () => {
    const retention = REPEATABLE_JOBS.find((j) => j.schedulerId === STREAM_RETENTION_SCHEDULER_ID);
    expect(retention).toBeDefined();
    expect(retention!.queue).toBe('stream-retention');
    expect(retention!.jobName).toBe('stream-retention.tick');
    expect(retention!.everyMs).toBe(DEFAULT_RETENTION_SWEEP_MS);
  });

  it('the retention sweep cadence is configurable, not a hard-coded constant', () => {
    const custom = buildRepeatableJobs(5 * 60_000);
    const retention = custom.find((j) => j.schedulerId === STREAM_RETENTION_SCHEDULER_ID);
    expect(retention!.everyMs).toBe(5 * 60_000);
    // probe is unaffected by the retention override
    expect(custom.find((j) => j.schedulerId === 'probe')!.everyMs).toBe(60_000);
  });

  it('only ships infra schedules — no domain job (HG-NO-DOMAIN)', () => {
    expect(REPEATABLE_JOBS.map((j) => j.schedulerId).sort()).toEqual(
      ['probe', 'stream-retention'].sort(),
    );
  });
});
