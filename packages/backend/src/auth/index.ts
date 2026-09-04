/**
 * The shared, framework-independent authentication/session primitive (task 2.5).
 *
 * Extracted from `apps/api/src/common/auth/*` so `apps/realtime` (a plain
 * Fastify process, not Nest) can resolve the **identical** token → session →
 * status pipeline `apps/api` uses, instead of a second, independently-maintained
 * copy that could drift on issuer / audience / claim shape / revocation timing.
 *
 * Deliberately contains: JWT verification (+ signing, kept alongside verify —
 * splitting them would itself be a drift risk), audience/realm validation,
 * Redis-backed session lookup, revoked/expired/status validation, and the
 * shared `SessionData`/`Realm`/`AccessTokenClaims` types.
 *
 * Deliberately does **not** contain: Nest controllers, Fastify request-specific
 * logic (bearer-header / cookie / WS-handshake token extraction stays in each
 * consumer), domain/business authorization, or client-supplied tenant/branch
 * scope resolution (topic assignment is `apps/realtime`'s own concern, built
 * *from* the `SessionData` this module resolves — see
 * `apps/realtime/src/auth/topics.ts`).
 */

export { JwtService, TokenInvalidError } from './jwt.service.js';
export { SessionStore, SESSION_STORE, InMemorySessionStore } from './session-store.js';
export { RedisSessionStore, revokeChannel } from './redis-session-store.js';
export { SessionAuthenticator, SessionAuthError } from './authenticate.js';
export {
  type SessionData,
  type AccessTokenClaims,
  type Realm,
  isStepUpActive,
} from './session.types.js';
