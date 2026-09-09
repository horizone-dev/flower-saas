/**
 * Task 3.10 — catalog transactional outbox event helpers.
 *
 * The 5 `catalog.*` events (owner D-2) are a **coarse, resource-oriented
 * invalidation signal**, co-committed with the domain mutation + its audit row
 * in the SAME transaction (owner "OUTBOX TRANSACTIONAL GUARANTEE"). They are
 * NEVER authoritative state — a client that receives one refetches over REST
 * (ADR-0017 §3). The realtime envelope carries only the frozen ADR-0017 §3
 * fields (+ the additive `company_id`); the bounded `payload` hints below are
 * for a future REST-aware consumer and are NEVER copied into the realtime
 * envelope by the dispatcher (owner D-6).
 */

const CATALOG_STATUS_VISIBLE = 'ACTIVE';

/**
 * Does a product/variant status transition CHANGE CONSUMER VISIBILITY (owner
 * D-5)? The lifecycle is `DRAFT · ACTIVE · ARCHIVED`; only `ACTIVE` is visible
 * to a POS / Owner catalog consumer. So a transition matters iff `ACTIVE` is on
 * exactly one side:
 *   - `DRAFT → ACTIVE`     → became visible      → emit
 *   - `ARCHIVED → ACTIVE`  → became visible      → emit
 *   - `ACTIVE → ARCHIVED`  → became hidden       → emit
 *   - `DRAFT → ARCHIVED`   → not visible either  → NO event
 * A no-op (`from === to`) never reaches here — the repositories return early.
 */
export function visibilityChanged(from: string, to: string): boolean {
  if (from === to) return false;
  return from === CATALOG_STATUS_VISIBLE || to === CATALOG_STATUS_VISIBLE;
}

/**
 * The bounded set of UOM codes touched by a price replace-set — the symmetric
 * union of the codes priced before and after. Bounded by the existing price
 * request limit + the pre-existing row count; never a full catalog dump.
 */
export function changedUomCodes(
  before: readonly { uomCode: string }[],
  after: readonly { uomCode: string }[],
): string[] {
  const set = new Set<string>();
  for (const r of before) set.add(r.uomCode);
  for (const r of after) set.add(r.uomCode);
  return [...set].sort((a, b) => a.localeCompare(b));
}
