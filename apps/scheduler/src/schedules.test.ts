import { describe, expect, it } from 'vitest';
import { REPEATABLE_JOBS } from './schedules.js';

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
});
