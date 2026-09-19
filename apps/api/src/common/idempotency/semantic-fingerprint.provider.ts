import type { FastifyRequest } from 'fastify';

/**
 * Generic opt-in extension point for `@Idempotent({ semanticFingerprintProvider })`
 * (task 3b.2 owner review round). A route whose idempotency fingerprint must
 * be based on authoritative, normalized SEMANTIC content — not the raw HTTP
 * body — implements this interface and passes its class to the decorator.
 *
 * This file and `IdempotencyInterceptor` know nothing about any specific
 * domain (no Customer/Order/etc. import here or anywhere else in this
 * directory) — the owning module supplies its own provider class and is
 * responsible for using its OWN existing normalization helpers (never
 * duplicating them here) and resolving any trusted server-side context (e.g.
 * `Company.countryCode`) itself, scoped correctly to the same tenant/company
 * the route's own guards already authorized.
 *
 * `computeSemanticBody` may throw (e.g. a `DomainError` for an invalid phone)
 * — the interceptor calls this BEFORE acquiring any idempotency claim, so a
 * thrown error surfaces as an ordinary request failure and never creates or
 * poisons an idempotency-store row.
 */
export interface SemanticFingerprintProvider {
  computeSemanticBody(req: FastifyRequest): Promise<unknown>;
}
