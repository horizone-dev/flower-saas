import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { isPlatformPermissionKey, requiresStepUp } from '@flower/permissions';
import { getContext } from '../context/index.js';
import { DomainError, ForbiddenError, NotFoundError } from '../errors/domain-error.js';
import { PolicyEngine } from '../../modules/access/policy-engine.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator.js';
import { SCOPED_PARAM_KEY, type ScopedParamConfig } from './pipeline.decorators.js';

/**
 * Pipeline steps 5–9: entitlement -> permission (+ step-up) -> company scope ->
 * branch scope. Delegates the decision to the pure `PolicyEngine`; this guard
 * only resolves the target ids from the route and maps a DENY reason to an HTTP
 * status (403 / 422 / 404).
 *
 * The platform realm is checked separately (a platform permission short-circuits
 * to "hold the key on the platform session").
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly engine: PolicyEngine,
  ) {}

  canActivate(execCtx: ExecutionContext): boolean {
    if (this.meta<boolean>(execCtx, IS_PUBLIC_KEY)) return true;

    const required = this.meta<string>(execCtx, REQUIRED_PERMISSION_KEY);
    if (!required) {
      // route-must-declare-permission (lint) + the bootstrap assertion make this
      // unreachable; fail closed if it ever is.
      throw new ForbiddenError('route declares no permission', 'ROUTE_MISCONFIGURED');
    }

    const ctx = getContext();
    if (!ctx) throw new UnauthorizedException('no request context');

    // platform realm
    if (isPlatformPermissionKey(required)) {
      if (ctx.accountType !== 'PLATFORM' || !ctx.effectivePermissions.has(required)) {
        throw new ForbiddenError('missing platform permission', 'MISSING_PERMISSION');
      }
      if (requiresStepUp(required) && ctx.mfaLevel !== 'STEP_UP') {
        throw new DomainError('STEP_UP_REQUIRED', 'a fresh step-up is required', 403);
      }
      return true;
    }

    const req = execCtx.switchToHttp().getRequest<FastifyRequest>();
    const target = this.resolveTarget(execCtx, req);
    const decision = this.engine.can(ctx, required, target);
    if (decision.allowed) return true;

    switch (decision.reason) {
      case 'MODULE_NOT_ENTITLED':
        throw new DomainError(
          'MODULE_NOT_ENTITLED',
          `module "${decision.detail}" is not enabled for this tenant`,
          403,
        );
      case 'STEP_UP_REQUIRED':
        throw new DomainError('STEP_UP_REQUIRED', 'a fresh step-up is required', 403);
      case 'MISSING_PERMISSION':
        throw new ForbiddenError(
          'you do not have permission for this action',
          'MISSING_PERMISSION',
        );
      case 'COMPANY_OUT_OF_SCOPE':
      case 'BRANCH_OUT_OF_SCOPE':
        // never leak that the resource exists in another company/branch (API-CONVENTIONS)
        throw new NotFoundError('resource');
      case 'NOT_TENANT_SCOPED':
      case 'NO_CONTEXT':
        throw new UnauthorizedException(decision.reason);
    }
  }

  private resolveTarget(
    execCtx: ExecutionContext,
    req: FastifyRequest,
  ): { companyId?: string | null; branchId?: string | null } {
    const cfg = this.meta<ScopedParamConfig>(execCtx, SCOPED_PARAM_KEY);
    if (!cfg) return {};
    const source =
      cfg.from === 'query'
        ? ((req.query as Record<string, unknown>) ?? {})
        : ((req.params as Record<string, unknown>) ?? {});
    const pick = (name?: string): string | null =>
      name && typeof source[name] === 'string' ? (source[name] as string) : null;
    return { companyId: pick(cfg.company), branchId: pick(cfg.branch) };
  }

  private meta<T>(execCtx: ExecutionContext, key: string): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [execCtx.getHandler(), execCtx.getClass()]);
  }
}
