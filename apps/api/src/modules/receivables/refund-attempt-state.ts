/**
 * Task 3b.8 Checkpoint D (provider-stub reconciliation) — the RefundAttempt
 * state machine. Pure. NO DB, NO provider-specific logic. Mirrors
 * `payment-attempt-state.ts`'s exact shape/conventions (plain `RangeError`,
 * the future repository/service boundary maps an illegal edge to a
 * DomainError itself).
 *
 * State vocabulary is the frozen `refund_attempt_state_chk` CHECK
 * (migration 44): `PENDING | SUCCEEDED | FAILED` — both non-PENDING states
 * are terminal (migration SQL's own `refund_attempt_resulting_refund_shape_chk`
 * independently enforces SUCCEEDED <=> `resultingRefundId IS NOT NULL`).
 * No `PARTIALLY_REFUNDED`/`REQUIRES_ACTION`/`AUTHORIZED`/`CANCELED` exists
 * here — a refund is never a customer-facing multi-step auth flow like a
 * payment capture (the CancellationCharge/CreditNote schema doc comments'
 * own "a refund attempt is PENDING -> SUCCEEDED/FAILED" framing).
 */
export type RefundAttemptState = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export const REFUND_ATTEMPT_STATES: readonly RefundAttemptState[] = Object.freeze([
  'PENDING',
  'SUCCEEDED',
  'FAILED',
]);

/** Both non-PENDING states are terminal — no outgoing edge from either. */
const TRANSITIONS: Readonly<Record<RefundAttemptState, readonly RefundAttemptState[]>> =
  Object.freeze({
    PENDING: ['SUCCEEDED', 'FAILED'],
    SUCCEEDED: [],
    FAILED: [],
  });

export function canTransitionRefundAttempt(
  from: RefundAttemptState,
  to: RefundAttemptState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Throws a plain `RangeError` for any edge outside the frozen graph above —
 * in particular every self-transition (a replayed terminal result is the
 * CALLER's own idempotent-no-op concern, same convention as
 * `payment-attempt-state.ts`) and every attempted move out of a terminal
 * state. The repository boundary is expected to surface this as
 * `REFUND_ATTEMPT_INVALID_TRANSITION` (409).
 */
export function assertRefundAttemptTransition(
  from: RefundAttemptState,
  to: RefundAttemptState,
): void {
  if (!canTransitionRefundAttempt(from, to)) {
    throw new RangeError(`illegal RefundAttempt transition ${from} -> ${to}`);
  }
}
