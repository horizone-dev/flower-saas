/**
 * `@flower/backend` — the reusable authoritative backend module layer (FC-3).
 *
 * Consumed by `apps/api`, `apps/worker` and `apps/scheduler`. Contains infra +
 * domain-service Nest modules only — **no** HTTP controllers, Fastify hooks,
 * request/response transport, cookies, CORS, OpenAPI or `main.ts` (those stay in
 * `apps/api`). This package never imports from `apps/*`.
 *
 * Task 2.3 cut (minimum): config + DB access + request context + logger.
 */

// aggregate
export { BackendModule } from './backend.module.js';

// config (dependency-inverted — the runtime provides BACKEND_CONFIG)
export {
  backendEnvSchema,
  loadBackendConfig,
  BACKEND_CONFIG,
  EnvValidationError,
  BackendConfigModule,
  type BackendConfig,
} from './config/index.js';

// logger
export { REDACT_PATHS, createRootLogger, rootLogger } from './logger/index.js';

// request context (AsyncLocalStorage) — the non-HTTP surface
export {
  RequestContext,
  contextStorage,
  runWithContext,
  enterContext,
  getContext,
  requireContext,
  requireTenantContext,
  replaceContext,
  NoRequestContextError,
  NotTenantScopedError,
  type AccountType,
  type MfaLevel,
  type ScopeSet,
  type RequestContextInit,
} from './context/index.js';

// data access — the sanctioned scoped / platform DB paths + the Prisma client host
export { DbModule, DbService } from './db/index.js';
export { ScopedRepository, PlatformRepository } from './data/index.js';

// auth / session — the shared, framework-independent token+session primitive
// (task 2.5). See auth/index.ts's module doc comment for exactly what is and
// is not in scope here.
export {
  JwtService,
  TokenInvalidError,
  SessionStore,
  SESSION_STORE,
  InMemorySessionStore,
  RedisSessionStore,
  SessionAuthenticator,
  SessionAuthError,
  type SessionData,
  type AccessTokenClaims,
  type Realm,
  isStepUpActive,
} from './auth/index.js';

// realtime channel naming — shared so apps/worker (publisher) and
// apps/realtime (subscriber) never cross-import each other (task 2.5)
export { streamKey, liveChannel, revokeChannel } from './realtime/channels.js';
