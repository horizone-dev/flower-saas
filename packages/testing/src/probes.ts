/**
 * Tenant + branch isolation probe harness (ARCHITECTURE §46 / §54, ADR-0004).
 *
 * A probe acts as the WRONG tenant / branch and tries to reach a resource it must
 * not see. A correctly-isolated system returns 403 or 404. Any other status is a
 * LEAK and fails the build. Real probe suites (one case per endpoint × id / param
 * / URL / document-id / realtime-topic) are generated in Phase 1; this is the
 * harness + a self-test.
 */
export type IsolationAxis = 'tenant' | 'branch' | 'register' | 'customer' | 'storefront';

export interface IsolationProbeCase {
  /** e.g. "GET /v1/orders/:id  as tenant B" */
  readonly name: string;
  readonly axis: IsolationAxis;
  /** perform the cross-boundary attempt; resolve with the HTTP status observed */
  readonly attempt: () => Promise<number>;
  /** statuses that count as "correctly denied" (default: 403, 404) */
  readonly expectDenied?: readonly number[];
}

export interface ProbeResult {
  readonly name: string;
  readonly axis: IsolationAxis;
  readonly observedStatus: number;
  readonly leaked: boolean;
  readonly error?: string;
}

export interface ProbeRun {
  readonly results: ProbeResult[];
  readonly leaks: ProbeResult[];
  readonly ok: boolean;
}

const DEFAULT_DENIED = [403, 404] as const;

export async function runIsolationProbes(cases: readonly IsolationProbeCase[]): Promise<ProbeRun> {
  const results: ProbeResult[] = [];
  for (const c of cases) {
    const denied = c.expectDenied ?? DEFAULT_DENIED;
    try {
      const observedStatus = await c.attempt();
      results.push({
        name: c.name,
        axis: c.axis,
        observedStatus,
        leaked: !denied.includes(observedStatus),
      });
    } catch (err) {
      // an error during the attempt is treated as a leak candidate — it must be
      // explained, not swallowed.
      results.push({
        name: c.name,
        axis: c.axis,
        observedStatus: -1,
        leaked: true,
        error: String(err),
      });
    }
  }
  const leaks = results.filter((r) => r.leaked);
  return { results, leaks, ok: leaks.length === 0 };
}

/** Assert no leaks; throws a readable summary otherwise (call from a test). */
export function assertNoLeaks(run: ProbeRun): void {
  if (run.ok) return;
  const lines = run.leaks
    .map(
      (l) =>
        `  - [${l.axis}] ${l.name}: observed ${l.observedStatus}${l.error ? ` (${l.error})` : ''}`,
    )
    .join('\n');
  throw new Error(`isolation probe found ${run.leaks.length} leak(s):\n${lines}`);
}

/**
 * Build the standard set of cross-boundary attempts for one resource: by id, by
 * a query/path param, and by a nested URL. `fetchAs` performs the request as the
 * attacker identity and returns the status.
 */
export function crossBoundaryCases(opts: {
  resource: string;
  axis: IsolationAxis;
  victimId: string;
  fetchAs: (path: string) => Promise<number>;
}): IsolationProbeCase[] {
  const { resource, axis, victimId, fetchAs } = opts;
  return [
    {
      name: `GET /v1/${resource}/${victimId} by id`,
      axis,
      attempt: () => fetchAs(`/v1/${resource}/${victimId}`),
    },
    {
      name: `GET /v1/${resource}?id=${victimId} by param`,
      axis,
      attempt: () => fetchAs(`/v1/${resource}?id=${victimId}`),
    },
    {
      name: `GET /v1/${resource}/${victimId}/detail nested URL`,
      axis,
      attempt: () => fetchAs(`/v1/${resource}/${victimId}/detail`),
    },
  ];
}
