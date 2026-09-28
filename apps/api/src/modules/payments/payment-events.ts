/**
 * Task 3b.5 Checkpoint G — the frozen business-outbox event vocabulary
 * (owner §G2) for payments. Originally deliberately just the first two — no
 * `payments.settled`/`payments.refunded`/`payments.advance_created`/
 * `payments.invoice_paid` (those concepts were outside 3b.5 entirely).
 * Mirrors `CatalogEventType`'s own role exactly (a plain string-literal
 * union checked at each `outbox.enqueue(... satisfies PaymentEventType)`
 * call site) — kept local to this module rather than added to
 * `@flower/shared-types` since nothing outside `apps/api` currently needs
 * the type at compile time (the realtime pipeline is already generic over
 * `eventType: string`, per inspection of `apps/worker`'s dispatcher/relay).
 *
 * Task 3b.7 Checkpoint D — `payments.settlement_finalized` is the frozen
 * addition (owned/emitted by the `settlements` module's finalization
 * transaction, never a 3b.5 producer — the `payments.` namespace prefix is
 * the frozen event name, not a module-ownership marker). Payload is bounded
 * to `{ settlementBatchId }` only — no Payment/Invoice id array, no Money,
 * no PII, no provider payload; consumers refetch.
 */
export type PaymentEventType =
  'payments.payment_recorded' | 'payments.attempt_state_changed' | 'payments.settlement_finalized';

/**
 * Bounded reason codes for a `provider_payment_event.exception` audit row
 * (owner §G8) — never the raw provider payload, never a free-text message
 * that could leak internal detail. Each maps 1:1 to a specific EXCEPTION
 * exit point in `webhook-event-processor.repository.ts`.
 */
export type ProviderEventExceptionReason =
  | 'UNKNOWN_OR_CROSS_SCOPE_ATTEMPT'
  | 'CREDENTIAL_MISMATCH'
  | 'PROVIDER_REFERENCE_MISMATCH'
  | 'ORDER_BINDING_MISMATCH'
  | 'UNSUPPORTED_TARGET_STATE'
  | 'ILLEGAL_TRANSITION'
  | 'FINANCIAL_INVARIANT_VIOLATION'
  | 'DUPLICATE_CAPTURED_MISMATCH';
