/**
 * Task 3b.5 Checkpoint A — the PaymentAttempt state machine. Pure. NO DB, NO
 * provider-specific logic.
 *
 * Error convention: this module throws plain `RangeError`, matching the
 * repository's established pure-module convention (`tax-arithmetic.ts`,
 * `document-discount-allocation.ts`, `commercial-snapshot.ts` — none of
 * which import `DomainError`). A pure, DB/HTTP-free module never embeds an
 * HTTP status; that mapping is a service/repository-boundary concern (see
 * `order.repository.ts`, `invoice-issuance.repository.ts`, both of which
 * throw `DomainError` themselves precisely because they sit at that
 * boundary). The future service layer that calls this module is expected to
 * surface an illegal transition as `PAYMENT_ATTEMPT_INVALID_TRANSITION`
 * (409) — documented here as the intended code, not constructed here.
 *
 * State VALUES are reused verbatim from the already-Accepted
 * ARCHITECTURE.md §42-43 "Payment state machine" — `REQUIRES_ACTION ->
 * AUTHORIZED -> CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED · FAILED ·
 * CANCELED · PENDING`. The owner contract-freeze (round 3, §6) reconciled
 * that these values attach to `PaymentAttempt`, not to `Payment` (which,
 * under the frozen confirmed-receipt-only model, carries no state machine of
 * its own) — no value was renamed or removed, only reassigned to the entity
 * that can actually carry a pre-capture state.
 *
 * `PARTIALLY_REFUNDED` / `REFUNDED` remain reserved in the vocabulary (the
 * accepted architecture requires them to exist) but are UNREACHABLE from
 * every function in this module — no transition edge targets or originates
 * from either, and 3b.5 implements no refund behavior.
 */
export type PaymentAttemptState =
  | 'PENDING'
  | 'REQUIRES_ACTION'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export const PAYMENT_ATTEMPT_STATES: readonly PaymentAttemptState[] = Object.freeze([
  'PENDING',
  'REQUIRES_ACTION',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

/** States 3b.5 code can actually drive a transition INTO. */
export const REACHABLE_3B5_STATES: readonly PaymentAttemptState[] = Object.freeze([
  'PENDING',
  'REQUIRES_ACTION',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELED',
]);

/**
 * Terminal states never regress — no outgoing edge exists for any of them.
 *
 * Non-terminal edges (the accepted architecture text — ARCHITECTURE.md
 * §42-43's "Payment state machine: `REQUIRES_ACTION -> AUTHORIZED ->
 * CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED` · `FAILED · CANCELED ·
 * PENDING`" — lists the state SET and a "happy path chain" together, but
 * does not itself enumerate which states FAILED/CANCELED are reachable
 * from; it names them as members of the set via a `·` separator, not as
 * edges of a specific graph. This is the smallest realistic completion of
 * that set into a graph, not an invention of new states):
 *   - `PENDING -> REQUIRES_ACTION` / `-> AUTHORIZED` / `-> CAPTURED`: a
 *     provider may require further customer action, may authorize directly,
 *     or (local synchronous cash/manual tender) may capture immediately with
 *     no separate auth step.
 *   - `REQUIRES_ACTION -> AUTHORIZED` / `-> CAPTURED`: once the required
 *     action completes, some providers report an explicit AUTHORIZED step,
 *     others report CAPTURED directly (sale-mode capture).
 *   - `AUTHORIZED -> CAPTURED`: the ordinary happy path — the ONLY edge out
 *     of `AUTHORIZED` in 3b.5.
 *   - `PENDING -> FAILED` / `-> CANCELED`, `REQUIRES_ACTION -> FAILED` /
 *     `-> CANCELED`: ordinary failure/cancel exits before authorization.
 *
 * `AUTHORIZED -> FAILED` / `-> CANCELED` are DELIBERATELY NOT included
 * (owner contract-freeze final integrity pass, item 2): re-reading the
 * accepted source above shows it defines only the state vocabulary and a
 * broad chain, never an explicit post-authorization failure/void edge — the
 * general "providers commonly support auth-then-fail/void" reasoning used
 * in an earlier draft of this module was payment-provider domain knowledge,
 * not a repository-accepted fact, and has been removed. Post-authorization
 * failure/void semantics are deferred until the concrete provider adapter
 * (Checkpoint E/F) has authoritative vendor documentation to freeze against
 * — adding the edge speculatively now would be exactly the "invent
 * transitions casually" the frozen contract forbids.
 *
 * Self-transitions are deliberately absent from this graph — a same-state
 * duplicate event (e.g. a replayed webhook) is NOT a new valid transition.
 * That is recognized and handled by the CALLER as an idempotent replay
 * BEFORE reaching this validator (see provider-event.ts's
 * `classifyProviderCaptureEvent` for the CAPTURED-specific case) — this
 * module only ever answers "is `from -> to` a legal state CHANGE."
 */
const TRANSITIONS: Readonly<Record<PaymentAttemptState, readonly PaymentAttemptState[]>> =
  Object.freeze({
    PENDING: ['REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELED'],
    REQUIRES_ACTION: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELED'],
    AUTHORIZED: ['CAPTURED'],
    CAPTURED: [],
    FAILED: [],
    CANCELED: [],
    PARTIALLY_REFUNDED: [],
    REFUNDED: [],
  });

/** Deterministic, fail-closed, pure. No DB, no provider-specific logic. */
export function canTransitionPaymentAttempt(
  from: PaymentAttemptState,
  to: PaymentAttemptState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Throws a plain `RangeError` when `from -> to` is not a legal edge in the
 * frozen graph above (this includes every self-transition and every
 * attempted move out of a terminal state — see the module doc comment for
 * why replay-as-self-transition is handled by the caller, not here). The
 * future service-layer caller is expected to surface this as
 * `PAYMENT_ATTEMPT_INVALID_TRANSITION` (409) — see the module-level error
 * convention note above.
 */
export function assertPaymentAttemptTransition(
  from: PaymentAttemptState,
  to: PaymentAttemptState,
): void {
  if (!canTransitionPaymentAttempt(from, to)) {
    throw new RangeError(`illegal PaymentAttempt transition ${from} -> ${to}`);
  }
}

export type ReservationState = 'ACTIVE' | 'CONVERTED' | 'RELEASED';

/**
 * Frozen reservation classification (owner contract round 3, §1/§4) for
 * provider-backed async attempts. Pure — no DB sum is computed here (see
 * available-to-collect.ts for that).
 *
 * `PARTIALLY_REFUNDED` / `REFUNDED` are outside the 3b.5 operational
 * reservation flow entirely — this function fails closed (throws) rather
 * than guess a reservation state for an enum value 3b.5 never produces.
 */
export function reservationStateForAttempt(state: PaymentAttemptState): ReservationState {
  switch (state) {
    case 'PENDING':
    case 'REQUIRES_ACTION':
    case 'AUTHORIZED':
      return 'ACTIVE';
    case 'CAPTURED':
      return 'CONVERTED';
    case 'FAILED':
    case 'CANCELED':
      return 'RELEASED';
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      throw new RangeError(
        `reservationStateForAttempt: ${state} is outside the 3b.5 operational reservation flow`,
      );
    default: {
      const exhaustive: never = state;
      throw new RangeError(`reservationStateForAttempt: unrecognized state ${String(exhaustive)}`);
    }
  }
}
