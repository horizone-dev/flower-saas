/**
 * Concurrency-test helpers (ARCHITECTURE §54): fire N operations at once and
 * inspect the settled outcomes — used to prove "no oversell", atomic reservation,
 * gapless numbering under load, and idempotent replay.
 */
export async function inParallel<T>(
  n: number,
  fn: (i: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
}

export interface ParallelSummary<T> {
  readonly fulfilled: T[];
  readonly rejected: string[];
  readonly fulfilledCount: number;
  readonly rejectedCount: number;
}

export function summarize<T>(settled: PromiseSettledResult<T>[]): ParallelSummary<T> {
  const fulfilled = settled.filter((s): s is PromiseFulfilledResult<T> => s.status === 'fulfilled');
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  return {
    fulfilled: fulfilled.map((s) => s.value),
    rejected: rejected.map((s) => String(s.reason)),
    fulfilledCount: fulfilled.length,
    rejectedCount: rejected.length,
  };
}

/**
 * Run `attempt` `n` times concurrently and assert that AT MOST `capacity` of them
 * succeed (`isSuccess`) — the "sell the last M units, N buyers" oversell test.
 */
export async function expectAtMostSucceed<T>(opts: {
  n: number;
  capacity: number;
  attempt: (i: number) => Promise<T>;
  isSuccess: (value: T) => boolean;
}): Promise<{ succeeded: number; summary: ParallelSummary<T> }> {
  const summary = summarize(await inParallel(opts.n, opts.attempt));
  const succeeded = summary.fulfilled.filter(opts.isSuccess).length;
  if (succeeded > opts.capacity) {
    throw new Error(`oversell: ${succeeded} succeeded but capacity is ${opts.capacity}`);
  }
  return { succeeded, summary };
}
