import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './request-context.js';

/**
 * Per-request context carried through the async call tree (AsyncLocalStorage).
 *
 * The store holds a **mutable holder**, not the context directly: guards run in
 * sequence and the auth guard *replaces* the bootstrap context with the enriched
 * one via `replaceContext`. Mutating a holder that every reader shares works
 * regardless of how the runtime chains the guards' async contexts (an
 * `enterWith`-based swap does not reliably propagate to sibling guards).
 */
interface Holder {
  current: RequestContext;
}

export const contextStorage = new AsyncLocalStorage<Holder>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return contextStorage.run({ current: ctx }, fn);
}

/** Seed the holder for the current async context (the Fastify onRequest hook). */
export function enterContext(ctx: RequestContext): void {
  contextStorage.enterWith({ current: ctx });
}

/** The current context, or `undefined` outside a request (jobs, boot). */
export function getContext(): RequestContext | undefined {
  return contextStorage.getStore()?.current;
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
  const holder = contextStorage.getStore();
  if (!holder) throw new NoRequestContextError(what);
  return holder.current;
}

/** The current context with a resolved `tenantId`, or throw. */
export function requireTenantContext(): RequestContext & { tenantId: string } {
  const ctx = requireContext('tenant-scoped data access');
  if (ctx.tenantId === null) throw new NotTenantScopedError();
  return ctx as RequestContext & { tenantId: string };
}

/** Swap the context within the current request (the auth guard enriching the
 *  bootstrap context with the session's tenant / user / scope / permissions). */
export function replaceContext(ctx: RequestContext): void {
  const holder = contextStorage.getStore();
  if (!holder) throw new NoRequestContextError('replaceContext');
  holder.current = ctx;
}
