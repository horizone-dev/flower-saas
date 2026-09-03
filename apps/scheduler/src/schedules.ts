/**
 * Repeatable-job definitions (ARCHITECTURE §49). The scheduler ONLY enqueues;
 * the worker runs the jobs. Real schedules (rollups, reconciliation, reservation
 * expiry, session reaping, plan/licence reminders) are added per phase.
 */
export interface RepeatableJob {
  readonly schedulerId: string;
  readonly queue: string;
  readonly jobName: string;
  /** interval in milliseconds */
  readonly everyMs: number;
}

export const REPEATABLE_JOBS: readonly RepeatableJob[] = [
  {
    schedulerId: 'heartbeat',
    queue: 'reconciliation',
    jobName: 'scheduler.heartbeat',
    everyMs: 60_000,
  },
];
