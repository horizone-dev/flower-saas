/**
 * Task 3b.5 Checkpoint E — the generic `PaymentProvider` adapter port,
 * reused VERBATIM from the already-Accepted architecture (ADR-0007;
 * ARCHITECTURE.md §42-43: "createIntent · authorize · capture · refund ·
 * getStatus · verifyWebhook") — never silently redefined. No concrete
 * vendor (Tap or otherwise) implements this interface anywhere in this
 * checkpoint; the core never references a vendor by name.
 *
 * Checkpoint E production orchestration invokes ONLY `createIntent` — the
 * provider-initiation capability needed to start an async attempt.
 * `authorize`/`capture`/`refund`/`getStatus`/`verifyWebhook` exist here for
 * architectural completeness (matching the accepted port shape) and are
 * NEVER called by any Checkpoint E code. Their exact request/response
 * shapes are deliberately left generic (`unknown`) — committing to a
 * concrete shape now would be inventing vendor semantics ahead of the
 * checkpoint that actually implements them (F+ for capture/refund/webhook
 * verification).
 */

/**
 * The narrowed, financially-safe outcome of a provider-initiation call.
 * Deliberately excludes `CAPTURED` — capture is only ever produced by a
 * VERIFIED provider webhook event (Checkpoint F), never by the synchronous
 * result of starting an attempt. `PARTIALLY_REFUNDED`/`REFUNDED` are also
 * excluded — refunds are out of scope entirely for 3b.5.
 */
export type PaymentProviderInitiationState =
  'PENDING' | 'REQUIRES_ACTION' | 'AUTHORIZED' | 'FAILED' | 'CANCELED';

export const PAYMENT_PROVIDER_INITIATION_STATES: readonly PaymentProviderInitiationState[] =
  Object.freeze(['PENDING', 'REQUIRES_ACTION', 'AUTHORIZED', 'FAILED', 'CANCELED']);

/** Runtime guard (owner Checkpoint E contract §E12) — a malformed/
 *  misbehaving adapter returning `CAPTURED` or any other value MUST be
 *  detected here, not trusted structurally. */
export function isValidPaymentProviderInitiationState(
  value: unknown,
): value is PaymentProviderInitiationState {
  return (
    typeof value === 'string' &&
    (PAYMENT_PROVIDER_INITIATION_STATES as readonly string[]).includes(value)
  );
}

export interface PaymentProviderInitiationRequest {
  /** the stable internal identity (owner §E10) — the merchant/reference
   *  value an adapter uses for this attempt, including on a later retry.
   *  Never a second randomly-generated reference. */
  paymentAttemptId: string;
  /** the SAME request idempotency key, forwarded so a concrete adapter can
   *  map it to the provider's own idempotency/reference mechanism later. */
  idempotencyKey: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  /** non-secret identity only (owner §E6) — never a decrypted secret. A
   *  concrete adapter resolves the actual credential material itself,
   *  internally, via `SecretsService` — never through this generic port. */
  providerCredentialId: string;
}

export interface PaymentProviderInitiationResult {
  state: PaymentProviderInitiationState;
  /** present only when the provider actually created a referenceable
   *  intent; persisted through the DB's narrow set-once rule. */
  providerReference?: string | null;
}

/**
 * Task 3b.5 Checkpoint F — the verified-webhook target-state vocabulary.
 * Adds `CAPTURED` to Checkpoint E's `PaymentProviderInitiationState` set —
 * CAPTURED is reachable ONLY through a verified webhook event, never as a
 * synchronous `createIntent` result (owner §F5, unchanged from E). Still
 * excludes `PARTIALLY_REFUNDED`/`REFUNDED` — "No refund state processing in
 * F" (owner §F5).
 */
export type WebhookVerifiedTargetState = PaymentProviderInitiationState | 'CAPTURED';

export const WEBHOOK_VERIFIED_TARGET_STATES: readonly WebhookVerifiedTargetState[] = Object.freeze([
  ...PAYMENT_PROVIDER_INITIATION_STATES,
  'CAPTURED',
]);

export function isValidWebhookVerifiedTargetState(
  value: unknown,
): value is WebhookVerifiedTargetState {
  return (
    typeof value === 'string' &&
    (WEBHOOK_VERIFIED_TARGET_STATES as readonly string[]).includes(value)
  );
}

/**
 * The ONLY information a `verifyWebhook` call may use to authenticate a
 * request (owner §F6) — non-secret identity plus the EXACT raw request
 * bytes (owner §F4: never a re-stringified/re-parsed JSON reconstruction).
 * A concrete adapter resolves the actual secret material itself,
 * internally, via `SecretsService` — never through this generic port, and
 * never returned/logged by it either.
 */
export interface WebhookVerificationRequest {
  /** non-secret identity only — the credential this endpoint is bound to.
   *  The adapter uses it to look up (internally) which secret/version to
   *  verify against; this port never carries or exposes that secret. */
  providerCredentialId: string;
  /** the EXACT raw request bytes, byte-for-byte as received — required for
   *  a correct HMAC/signature check. Never re-derived from parsed JSON. */
  rawBody: Buffer;
  /** lower-cased header map, exactly as received (no vendor-specific
   *  parsing happens in the generic core — the adapter reads whichever
   *  header(s) its own vendor documentation specifies). */
  headers: Readonly<Record<string, string>>;
}

/**
 * The normalized, provider-neutral outcome of a verified webhook event
 * (owner §F5). The generic core never sees vendor JSON structure, header
 * names, HMAC algorithm, or merchant secret format — only this shape.
 *
 * `paymentAttemptId`/`targetState` are optional together — an adapter that
 * verifies a genuine provider event with NO corresponding payment
 * processing meaning in 3b.5 (e.g., a provider event type this checkpoint
 * does not process) returns `targetState: undefined`/`paymentAttemptId:
 * undefined`; the core then durably records it as an EXCEPTION with no
 * PaymentAttempt target (owner §F7) rather than guessing.
 */
export interface VerifiedProviderWebhookEvent {
  /** the provider's own event identity — deduped per credential (owner
   *  §F9/§F10), never trusted globally across different credentials. */
  providerEventId: string;
  eventType: string;
  paymentAttemptId?: string;
  providerReference?: string;
  targetState?: WebhookVerifiedTargetState;
  /** bounded, JSON-primitive-only (owner §F29) — never the raw payload,
   *  never headers wholesale, never PAN/CVV/API key/signature/Authorization
   *  header content. Informational only — business capture logic MUST NOT
   *  depend on it (owner §F29). */
  sanitizedMetadata?: Record<string, unknown>;
}

/**
 * The accepted generic port — see the module doc comment above.
 *
 * ══════════════ `createIntent` RETRY-SAFETY CONTRACT (frozen, hard
 * requirement — owner Checkpoint E recovery pass) ═══════════════════════
 *
 * `createIntent` for a given `paymentAttemptId` MUST be safe to invoke more
 * than once. The orchestration retries it whenever a PaymentAttempt's
 * reservation is durably committed but no definitive provider-initiation
 * result has yet been durably applied — this happens after a process crash
 * between the reservation commit and the provider call, after a transport
 * failure of ambiguous outcome, and after a Phase-2 persistence failure
 * following an otherwise-successful provider call. In every one of these
 * cases the orchestration calls `createIntent` again with the EXACT SAME
 * `paymentAttemptId` (and the same `idempotencyKey`) it used the first time
 * — never a freshly minted identity.
 *
 * A conforming adapter MUST guarantee that retrying `createIntent` for the
 * same `paymentAttemptId` never creates a SECOND independent provider-side
 * payment intent/charge — it must either return the outcome of the
 * already-created intent (reconciliation) or rely on the provider's own
 * idempotency mechanism keyed by a stable value derived from
 * `paymentAttemptId`/`idempotencyKey`. This is a hard requirement a
 * concrete provider adapter MUST satisfy before it can be considered
 * production-ready — HOW it satisfies it (provider-native idempotency keys,
 * a merchant/reference lookup, a safe reconciliation call) is entirely
 * deferred to that adapter's own authoritative vendor documentation; no
 * vendor-specific mechanism is assumed or invented here.
 */
export interface PaymentProvider {
  createIntent(request: PaymentProviderInitiationRequest): Promise<PaymentProviderInitiationResult>;
  /** Not called by any Checkpoint E code — shape deferred to F+. */
  authorize(request: unknown): Promise<unknown>;
  /** Not called by any Checkpoint E code — shape deferred to F+. */
  capture(request: unknown): Promise<unknown>;
  /** Not called by any Checkpoint E code — shape deferred to a future
   *  refund task, out of 3b.5 scope entirely. */
  refund(request: unknown): Promise<unknown>;
  /** Not called by any Checkpoint E/F code — shape deferred to F+. */
  getStatus(request: unknown): Promise<unknown>;
  /**
   * Checkpoint F — authenticate + normalize an inbound provider webhook.
   * A conforming adapter: (1) authenticates the signature/timestamp/
   * replay-relevant provider proof using ONLY `request.rawBody`/
   * `request.headers` (never a re-parsed/re-stringified body), (2) parses
   * the provider-specific payload internally, (3) returns a normalized,
   * provider-neutral {@link VerifiedProviderWebhookEvent}. Must THROW for
   * an inauthentic request — a rejected/failed verification is a thrown
   * error, never a "successful" result with a sentinel state (owner §F8:
   * an invalid signature must produce ZERO durable side effects, which the
   * generic core enforces by never persisting anything when this call
   * rejects).
   *
   * NOTE (forward-looking, not a Checkpoint F blocker — owner §F6): this
   * port interface currently lives in `apps/api/src/modules/payments/`, a
   * `domain-module` under this repository's `eslint-plugin-boundaries`
   * policy, which forbids one domain-module importing another's files
   * directly. A future concrete adapter that needs `SecretsService`
   * (itself inside the separate `modules/secrets` domain-module) to verify
   * a signature cannot be a plain sibling file inside `modules/payments/`
   * AND import `SecretsService` directly — the two domain-modules cannot
   * import each other's source either direction. Resolving this (most
   * likely by promoting this port's type declarations to a shared package,
   * mirroring how `ScopedRepository`/`DbService` were promoted to
   * `@flower/backend` for the same cross-module-reuse reason) is deferred
   * to whichever future checkpoint actually implements a concrete,
   * secret-using adapter — Checkpoint F implements no concrete adapter and
   * is not blocked by this.
   */
  verifyWebhook(request: WebhookVerificationRequest): Promise<VerifiedProviderWebhookEvent>;
}
