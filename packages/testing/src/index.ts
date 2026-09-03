/**
 * Test infrastructure (ARCHITECTURE §54, conventions/TESTING-STRATEGY).
 *
 * Phase 0 seed. Task 0.11 adds the real Testcontainers bootstrap (Postgres + Redis
 * + MinIO), `withTenantContext`, and the tenant + branch probe-suite skeleton.
 * For now this exposes the shape of the probe harness so tests can be written
 * against it before endpoints exist.
 */

export interface IsolationProbeCase {
  /** short description, e.g. "GET /v1/orders/:id as tenant B" */
  readonly name: string;
  /** the boundary being probed */
  readonly axis: 'tenant' | 'branch' | 'register' | 'customer' | 'storefront';
  /** run the probe; resolve with the HTTP status the attacker observed */
  readonly attempt: () => Promise<number>;
  /** statuses that mean "correctly denied" (default: 403 or 404) */
  readonly expectDenied?: readonly number[];
}

export interface ProbeResult {
  readonly name: string;
  readonly axis: IsolationProbeCase['axis'];
  readonly observedStatus: number;
  readonly leaked: boolean;
}

const DEFAULT_DENIED = [403, 404] as const;

/**
 * Runs every probe and reports which ones LEAKED (i.e. did not return a denied
 * status). A caller in CI asserts `result.leaks.length === 0`.
 */
export async function runIsolationProbes(
  cases: readonly IsolationProbeCase[],
): Promise<{ results: ProbeResult[]; leaks: ProbeResult[] }> {
  const results: ProbeResult[] = [];
  for (const c of cases) {
    const denied = c.expectDenied ?? DEFAULT_DENIED;
    const observedStatus = await c.attempt();
    results.push({
      name: c.name,
      axis: c.axis,
      observedStatus,
      leaked: !denied.includes(observedStatus),
    });
  }
  return { results, leaks: results.filter((r) => r.leaked) };
}

/** Placeholder for Task 0.11 — the real one starts Testcontainers + sets `app.tenant_id`. */
export async function withTenantContext<T>(_tenantId: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}

/** Run `fn` `n` times concurrently and collect settled results (concurrency-suite helper). */
export async function inParallel<T>(
  n: number,
  fn: (i: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
}
