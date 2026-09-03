import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './request-context.js';

/**
 * Per-request context carried through the async call tree (AsyncLocalStorage).
 * One store per Node process; every request runs its handler inside
 * `runWithContext`, so nothing leaks between concurrent requests.
 */
export const contextStorage = new AsyncLocalStorage<RequestContext>();
const als = contextStorage;

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** The current context, or `undefined` outside a request (jobs, boot). */
export function getContext(): RequestContext | undefined {
  return als.getStore();
}

export class NoRequestContextError extends Error {
  constructor(what = 'operation') {
    super(`${what} requires a request context but none is active (fails closed)`);
    this.name = 'NoRequestContextError';
  }
}

export class NotTenantScopedError extends Error {
  constructor() {
    super('this operation requires a tenant-scoped request context');
    this.name = 'NotTenantScopedError';
  }
}

/** The current context or throw — the default for anything data-touching. */
export function requireContext(what?: string): RequestContext {
  const ctx = als.getStore();
  if (!ctx) throw new NoRequestContextError(what);
  return ctx;
}

/** The current context with a resolved `tenantId`, or throw. */
export function requireTenantContext(): RequestContext & { tenantId: string } {
  const ctx = requireContext('tenant-scoped data access');
  if (ctx.tenantId === null) throw new NotTenantScopedError();
  return ctx as RequestContext & { tenantId: string };
}

/** Test/interceptor helper: replace the context within the current ALS frame. */
export function replaceContext(ctx: RequestContext): void {
  const store = als.getStore();
  if (!store) throw new NoRequestContextError('replaceContext');
  als.enterWith(ctx);
}
