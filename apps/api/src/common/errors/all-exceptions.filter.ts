import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { rootLogger } from '../logger/logger.js';
import { DomainError, type ErrorDetail } from './domain-error.js';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    correlationId?: string;
  };
}

/**
 * Single global filter → the one error envelope (API-CONVENTIONS). Fails closed:
 * an unrecognised error is a 500 with a generic message (details are logged, not
 * returned).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const correlationId = (request as { correlationId?: string }).correlationId;

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: ErrorDetail[] | undefined;

    if (exception instanceof DomainError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      code = httpStatusCode(status);
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object' && 'message' in res) {
        const m = (res as { message: unknown }).message;
        message = Array.isArray(m) ? m.join('; ') : String(m);
      } else {
        message = exception.message;
      }
    }

    if (status >= 500) {
      rootLogger.error({ err: exception, correlationId, path: request.url }, 'unhandled error');
    } else {
      rootLogger.warn({ code, status, correlationId, path: request.url }, message);
    }

    const body: ErrorEnvelope = { error: { code, message } };
    if (details?.length) body.error.details = details;
    if (correlationId) body.error.correlationId = correlationId;

    void reply.status(status).send(body);
  }
}

function httpStatusCode(status: number): string {
  const map: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'RATE_LIMITED',
  };
  return map[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
}
