import type { PaymentAttemptState } from './payment-attempt-state.js';

/**
 * Task 3b.5 Checkpoint A — pure webhook-inbox processing vocabulary +
 * late-event classification. NO DB, NO raw payload persistence, NO
 * signature verification (that is Checkpoint F, and requires the actual
 * provider secret).
 *
 * Status vocabulary is frozen at exactly three values for 3b.5:
 *   - `RECEIVED`  — signature-verified, not yet business-processed.
 *   - `PROCESSED` — successfully applied (or classified, see below).
 *   - `EXCEPTION` — verified and understood, but applying it would violate
 *     an already-terminal business state (see `classifyProviderCaptureEvent`).
 *
 * `REJECTED` is deliberately NOT added here. An invalid-signature webhook is
 * rejected BEFORE durable acceptance (Checkpoint F's verification step) and
 * therefore never reaches this vocabulary at all — no inbox row is created
 * for it. A distinct "verified but structurally unprocessable payload" case
 * (e.g. an unrecognized `eventType`) is a different failure mode from
 * `EXCEPTION` (a business-state conflict) and *could* warrant its own value
 * later, but no such case is implemented in 3b.5 — inventing that value now,
 * with no concrete producer, would be exactly the kind of premature
 * enum-growth the frozen contract warns against. Checkpoint F revisits this
 * only if a concrete need actually materializes.
 */
export type ProviderPaymentEventStatus = 'RECEIVED' | 'PROCESSED' | 'EXCEPTION';

/**
 * A shallow, JSON-primitive-only record — never the raw/arbitrary provider
 * payload, and never `unknown`/`any` used directly by business logic. This
 * is the only shape any 3b.5 code may pass around as "provider event
 * metadata."
 */
export type SanitizedProviderEventMetadata = Readonly<
  Record<string, string | number | boolean | null>
>;

export type ProviderCaptureEventClassification = 'APPLY' | 'IDEMPOTENT_REPLAY' | 'EXCEPTION';

/**
 * Pure classifier for an authoritative (already signature-verified)
 * provider event claiming CAPTURED, given the PaymentAttempt's CURRENT live
 * state.
 *
 *   - `PENDING` / `REQUIRES_ACTION` / `AUTHORIZED` (still an active
 *     reservation) -> `APPLY`: proceed with the normal capture conversion.
 *   - `CAPTURED` (already converted) -> `IDEMPOTENT_REPLAY`: a benign
 *     duplicate delivery — no-op, no exception, no operational alarm.
 *   - `FAILED` / `CANCELED` (already terminal, non-capture) -> `EXCEPTION`:
 *     a genuine conflict — the event must NOT transition the attempt, must
 *     NOT create a Payment/Allocation/Advance, and must NOT be silently
 *     dropped (owner contract round 4, §4). The caller persists the
 *     verified event with `status = 'EXCEPTION'` for later
 *     reconciliation/settlement workflow visibility.
 *   - `PARTIALLY_REFUNDED` / `REFUNDED` -> `EXCEPTION`: reserved states
 *     3b.5 never produces; a capture claim arriving against one is treated
 *     as a conflict, never a silent apply.
 */
export function classifyProviderCaptureEvent(
  currentAttemptState: PaymentAttemptState,
): ProviderCaptureEventClassification {
  switch (currentAttemptState) {
    case 'PENDING':
    case 'REQUIRES_ACTION':
    case 'AUTHORIZED':
      return 'APPLY';
    case 'CAPTURED':
      return 'IDEMPOTENT_REPLAY';
    case 'FAILED':
    case 'CANCELED':
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return 'EXCEPTION';
    default: {
      const exhaustive: never = currentAttemptState;
      throw new RangeError(
        `classifyProviderCaptureEvent: unrecognized state ${String(exhaustive)}`,
      );
    }
  }
}
