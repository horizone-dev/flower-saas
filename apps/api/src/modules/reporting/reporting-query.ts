import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.10 Checkpoint F — the ONE strict query reader of the public reporting routes.
 *
 * A route accepts EXACTLY its documented query keys; anything else is `400 VALIDATION_FAILED` (no silent ignore, so a client
 * can never believe a scope or a filter was applied that is not). It reads nothing from a body and never a tenant, company or
 * branch: those come from the authenticated session and the validated route params only. The values themselves are validated
 * by the frozen report services / repositories (dates, limit, cursor, customer), never re-implemented here.
 */
export function strictQuery(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const q = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(q)) {
    if (!allowed.includes(key)) {
      throw new DomainError('VALIDATION_FAILED', 'unsupported query parameter', 400);
    }
  }
  return q;
}

/** the civil-period query of Trial Balance, Sales and Tender Totals */
export function periodQuery(raw: unknown): { from: unknown; to: unknown } {
  const q = strictQuery(raw, ['from', 'to']);
  return { from: q['from'], to: q['to'] };
}

/**
 * The page query of Receivables and Customer Liabilities. `limit` arrives as a string: a plain digit string becomes the
 * number the frozen parser expects, anything else is passed on untouched and rejected there as `400 INVALID_LIMIT`.
 */
export function pageQuery(raw: unknown): {
  customerId?: string;
  cursor?: unknown;
  limit?: unknown;
} {
  const q = strictQuery(raw, ['customerId', 'cursor', 'limit']);
  const out: { customerId?: string; cursor?: unknown; limit?: unknown } = {};
  const customerId = q['customerId'];
  if (customerId !== undefined) {
    // a repeated key (an array) is never a customer id: the same non-disclosing 404 as an unknown customer
    if (typeof customerId !== 'string')
      throw new DomainError('NOT_FOUND', 'customer not found', 404);
    out.customerId = customerId;
  }
  if (q['cursor'] !== undefined) out.cursor = q['cursor'];
  const limit = q['limit'];
  if (limit !== undefined) {
    out.limit = typeof limit === 'string' && /^[0-9]{1,15}$/.test(limit) ? +limit : limit;
  }
  return out;
}
