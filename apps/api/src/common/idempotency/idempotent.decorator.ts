import { SetMetadata, type Type } from '@nestjs/common';
import type { SemanticFingerprintProvider } from './semantic-fingerprint.provider.js';

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
  /**
   * OPT-IN ONLY (task 3b.2 owner review round) — when set, the interceptor
   * resolves this injectable class app-wide (`ModuleRef.get(..., {strict:
   * false})`) and hashes the result of its `computeSemanticBody(req)` instead
   * of the raw HTTP body. Every route that omits this field (every existing
   * `@Idempotent()` route, including task 3b.1's AccountingPeriod create) is
   * completely unaffected — the interceptor's default behavior (hash
   * `req.body` verbatim) is unchanged. This generic idempotency module never
   * imports a domain-specific provider; the owning module (e.g. Customers)
   * supplies its own class reference here.
   */
  semanticFingerprintProvider?: Type<SemanticFingerprintProvider>;
}

export const Idempotent = (options: IdempotentOptions): MethodDecorator =>
  SetMetadata(IDEMPOTENT_META, options);
