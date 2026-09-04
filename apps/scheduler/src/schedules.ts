/**
 * Repeatable-job definitions (ARCHITECTURE §49). The scheduler ONLY enqueues;
 * `apps/worker` runs them. Phase 2-core ships the framework only — a trivial
 * probe schedule that proves the round-trip. Domain schedules (rollups,
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

export const REPEATABLE_JOBS: readonly RepeatableJob[] = [
  {
    schedulerId: 'probe',
    queue: 'probe',
    jobName: 'probe.tick',
    everyMs: 60_000,
  },
];
