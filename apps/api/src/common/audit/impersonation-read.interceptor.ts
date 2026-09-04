import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { tap, type Observable } from 'rxjs';
import { getContext } from '../context/index.js';
import { AuditWriter } from './audit.writer.js';

/**
 * OD7: **every request** served inside an impersonated session is audited with
 * the impersonator. Reads carry no rollback risk, so this writes a standalone
 * `IMPERSONATION:read` row after a successful response. Mutations are already
 * blocked during impersonation by `PermissionGuard`.
 *
 * The actor snapshot is captured synchronously (the request's async-context is
 * gone by the time the async write runs).
 */
@Injectable()
export class ImpersonationReadInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditWriter) {}

  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execCtx.getType() !== 'http') return next.handle();
    const ctx = getContext();
    if (!ctx?.isImpersonating) return next.handle();

    const req = execCtx.switchToHttp().getRequest<FastifyRequest>();
    const path = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const snapshot = {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorAccountType: ctx.accountType,
      impersonatorPlatformUserId: ctx.impersonatorPlatformUserId,
    };

    return next.handle().pipe(
      tap({
        next: () => {
          void this.audit
            .emit({
              action: 'IMPERSONATION:read',
              resourceType: 'http_request',
              resourceId: path,
              ...snapshot,
            })
            .catch(() => undefined);
        },
      }),
    );
  }
}
