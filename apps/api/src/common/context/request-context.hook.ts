import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RequestContext } from './request-context.js';
import { enterContext } from './context.als.js';

/**
 * Establish a bootstrap `RequestContext` (request id + client ip/ua) in the ALS
 * store at the very start of every request, BEFORE guards run. The auth guard
 * (task 1.5) then layers the session's tenant / user / scope / permissions onto
 * it via `replaceContext`. Everything downstream — guards, interceptors, the
 * handler, repositories — reads the same frame.
 *
 * Fastify keeps async-context continuity per request, so `enterWith()` in an
 * `onRequest` hook reliably propagates to the Nest handler.
 */
export function installRequestContext(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request: FastifyRequest, _reply, done) => {
    const requestId = (request as { correlationId?: string }).correlationId ?? String(request.id);
    const forwarded = request.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ??
      request.ip ??
      null;
    const uaHeader = request.headers['user-agent'];
    const userAgent = Array.isArray(uaHeader) ? (uaHeader[0] ?? null) : (uaHeader ?? null);

    enterContext(new RequestContext({ requestId, ip, userAgent }));
    done();
  });
}
