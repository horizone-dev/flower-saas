import { SetMetadata } from '@nestjs/common';

/**
 * Opt a state-changing route into the idempotency store (Phase 2-core task 2.2 /
 * API-CONVENTIONS §Idempotency).
 *
 * - The client MUST send `Idempotency-Key: <opaque>` on every decorated route.
 * - The stored identity is `(tenant, scope, authenticated principal, key)` — a
 *   result is never replayable across principals (FC-2). `scope` is the canonical
 *   operation name (e.g. `"orders.create"`), NOT the raw path.
 * - Only a **2xx** response is stored and replayed. A 4xx/5xx or a thrown error
 *   removes the key so a retry re-executes (a transient 5xx is never cached).
 *
 * **Never** decorate an auth / credential-producing route (login, MFA verify,
 * refresh, logout, password/reset, provider-credential / secret operations). A
 * startup assertion (`assertNoIdempotencyOnCredentialRoutes`) rejects it.
 */
export const IDEMPOTENT_META = Symbol('idempotent');

export interface IdempotentOptions {
  /** canonical operation name — stable, not the URL. e.g. "orders.create" */
  scope: string;
}

export const Idempotent = (options: IdempotentOptions): MethodDecorator =>
  SetMetadata(IDEMPOTENT_META, options);
