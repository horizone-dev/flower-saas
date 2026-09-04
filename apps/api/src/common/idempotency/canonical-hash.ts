import { createHash } from 'node:crypto';

/**
 * Deterministic request fingerprint for the idempotency store (task 2.2,
 * constraint 3). Two **semantically identical** requests hash identically:
 * object-key order and insignificant whitespace do not matter; array order does
 * (it is semantic). Only inputs that materially define the operation are
 * included — method, route pattern, path params, query, `scope`, tenant,
 * principal, body. **No** JWT / cookie / refresh token / credential / header.
 */

/** Recursively sort object keys; drop `undefined`; leave arrays / scalars as-is. */
export function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 40) return '[depth-limited]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, depth + 1));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v, depth + 1);
  }
  return out;
}

export interface RequestHashParts {
  method: string;
  /** the route PATTERN, e.g. `/v1/orders/:id/refund` — never the concrete URL */
  routePattern: string;
  pathParams: unknown;
  query: unknown;
  scope: string;
  tenantId: string;
  principalId: string;
  body: unknown;
}

export function requestHash(parts: RequestHashParts): string {
  const canonical = JSON.stringify({
    m: parts.method.toUpperCase(),
    r: parts.routePattern,
    pp: canonicalize(parts.pathParams ?? {}),
    q: canonicalize(parts.query ?? {}),
    s: parts.scope,
    t: parts.tenantId,
    pr: parts.principalId,
    b: canonicalize(parts.body ?? null),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
