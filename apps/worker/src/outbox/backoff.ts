/**
 * Publish retry/backoff policy (constraint 7). A publish failure never marks a
 * row dispatched — it bumps `attempts`, backs off `availableAt` and records a
 * bounded, secret-free `lastError`. No terminal/poison state in task 2.4 (a
 * DLQ-style schema change is out of scope — see PHASE-2-CORE-PLAN §2.4): a
 * permanently-failing row just keeps retrying at the capped interval, visible
 * via `attempts`/`lastError` for a future lag/alarm job. It is never discarded.
 */
export interface PublishBackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

export const DEFAULT_PUBLISH_BACKOFF: PublishBackoffPolicy = {
  baseMs: 1_000,
  maxMs: 5 * 60_000,
};

export function nextAvailableAt(
  attempts: number,
  policy: PublishBackoffPolicy = DEFAULT_PUBLISH_BACKOFF,
): Date {
  const delayMs = Math.min(policy.baseMs * 2 ** Math.max(0, attempts - 1), policy.maxMs);
  return new Date(Date.now() + delayMs);
}

const MAX_ERROR_LENGTH = 500;
/** Matches `scheme://user:pass@host` — strips embedded credentials from a URI. */
const CREDENTIAL_URI_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/gi;

/**
 * A publish failure's error message must never leak a secret (constraint 7) —
 * e.g. a Redis/Postgres connection string embeds credentials in its URI. Strips
 * any `user:pass@host` pattern and caps the length so a single poison error
 * can't blow past a reasonable column size.
 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = raw.replace(CREDENTIAL_URI_RE, (m) => `${m.split('://')[0]}://[redacted]@`);
  return scrubbed.length > MAX_ERROR_LENGTH ? `${scrubbed.slice(0, MAX_ERROR_LENGTH)}…` : scrubbed;
}
