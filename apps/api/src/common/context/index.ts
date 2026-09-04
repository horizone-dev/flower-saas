/**
 * The request-context primitive (`RequestContext`, ALS accessors, errors) now
 * lives in `@flower/backend` (FC-3 — shared by `api` / `worker` / `scheduler`).
 * The HTTP-bound pieces — the `@Ctx()` param decorator and the Fastify
 * `installRequestContext` onRequest hook — stay here in `apps/api`.
 */
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
} from '@flower/backend';
export { Ctx } from './ctx.decorator.js';
export { installRequestContext } from './request-context.hook.js';
