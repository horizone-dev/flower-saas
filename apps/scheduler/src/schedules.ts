/**
 * Repeatable-job definitions (ARCHITECTURE §49). The scheduler ONLY enqueues;
 * `apps/worker` runs them. Phase 2-core ships the framework plus two infra
 * schedules — `probe` (proves the round-trip) and `stream-retention` (the
 * realtime-Stream `XTRIM … MINID` sweep, task 2.8). Domain schedules (rollups,
 * reconciliation, reservation expiry, session reaping, plan/licence reminders,
 * the idempotency-key TTL sweep — PHASE-2-BACKLOG.md) are added per phase.
 */
export interface RepeatableJob {
  readonly schedulerId: string;
  readonly queue: string;
  readonly jobName: string;
  /** interval in milliseconds */
  readonly everyMs: number;
}

/** default sweep cadence for the realtime-Stream retention job. Configurable
 *  via `STREAM_RETENTION_SWEEP_INTERVAL_MS` (task 2.8) — a missed sweep is
 *  harmless (the next one still trims everything past the floor), so this is a
 *  low-frequency maintenance cadence, not a tight loop. */
export const DEFAULT_RETENTION_SWEEP_MS = 60 * 60 * 1000;

export const STREAM_RETENTION_SCHEDULER_ID = 'stream-retention';

export function buildRepeatableJobs(
  retentionSweepMs = DEFAULT_RETENTION_SWEEP_MS,
): RepeatableJob[] {
  return [
    { schedulerId: 'probe', queue: 'probe', jobName: 'probe.tick', everyMs: 60_000 },
    {
      schedulerId: STREAM_RETENTION_SCHEDULER_ID,
      queue: 'stream-retention',
      jobName: 'stream-retention.tick',
      everyMs: retentionSweepMs,
    },
  ];
}

export const REPEATABLE_JOBS: readonly RepeatableJob[] = buildRepeatableJobs();
