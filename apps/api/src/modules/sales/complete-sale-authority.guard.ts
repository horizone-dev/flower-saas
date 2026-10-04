import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getContext } from '../../common/context/index.js';
import { DomainError, ForbiddenError, NotFoundError } from '../../common/errors/domain-error.js';
import { PolicyEngine } from '../access/policy-engine.js';
import type { Decision } from '../access/policy.types.js';
import { saleAuthorityRequirements } from './sale-authority.js';

/**
 * Task 3b.9 Checkpoint E — the CONDITIONAL authority of `complete-sale`, enforced as a
 * ROUTE GUARD so that it runs BEFORE the idempotency interceptor can replay anything.
 *
 * The route's static `@RequirePermission('orders:manage')` is enforced by the global
 * `PermissionGuard`. One static decorator cannot vary by request content, so the two
 * body-dependent authorities are checked here, through the SAME `PolicyEngine` (never a
 * second authorization system), with the SAME deny → HTTP mapping as `PermissionGuard`:
 *
 *   - the request carries REAL tenders      → `payments:collect`
 *   - the request carries advance applications → `receivables:advance:apply`
 *
 * Which keys a request implicates is decided by the frozen PURE
 * `saleAuthorityRequirements` (Checkpoint D) — this guard owns no rule of its own. The
 * two axes are independent: spending an advance never rides on `payments:collect`, and
 * collecting a tender never grants advance use. Credit is not a tender, so an ON_CREDIT
 * request with no tender needs neither.
 *
 * The credit-limit override is NOT decided here (and never by the controller): whether one
 * is necessary is a server decision inside the frozen orchestrator, which then runs the
 * frozen `authorize()` (Owner permission + step-up + a bounded audited reason). A reason
 * alone grants nothing and requires nothing.
 *
 * It reads the RAW parsed body deliberately and tolerantly — the guard runs before body
 * validation — and FAILS CLOSED: a `tenders` / `advanceApplications` value that is present
 * but not an empty array counts as implicating the key. A malformed body therefore gets
 * `403` from an unauthorised caller and its `400` only from an authorised one; it can never
 * smuggle a tender past this check, and validation itself is unchanged (`ZodBody`).
 *
 * Because it is a guard, an idempotent REPLAY is authorised exactly like a first execution:
 * a principal who has lost `payments:collect` can no longer replay a response that included
 * a tender, and no replay can ever cause a new privileged side effect (the handler is not
 * invoked at all).
 */
@Injectable()
export class CompleteSaleAuthorityGuard implements CanActivate {
  constructor(private readonly engine: PolicyEngine) {}

  canActivate(execCtx: ExecutionContext): boolean {
    const ctx = getContext();
    if (!ctx) throw new UnauthorizedException('no request context');

    const req = execCtx.switchToHttp().getRequest<FastifyRequest>();
    const body = (req.body ?? null) as Record<string, unknown> | null;
    const params = (req.params as Record<string, unknown> | undefined) ?? {};
    const target = {
      companyId: typeof params['companyId'] === 'string' ? params['companyId'] : null,
      branchId: typeof params['branchId'] === 'string' ? params['branchId'] : null,
    };

    const requirements = saleAuthorityRequirements({
      tenderCount: implicated(body?.['tenders']),
      advanceCount: implicated(body?.['advanceApplications']),
      creditOverrideUsed: false,
    });
    for (const key of requirements.permissionKeys) {
      const decision = this.engine.can(ctx, key, target);
      if (!decision.allowed) throw httpErrorFor(decision);
    }
    return true;
  }
}

/** how many entries a raw body value implicates: an array counts its length; anything else
 *  that is present (a malformed value) counts as one — fail closed. */
function implicated(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return Array.isArray(value) ? value.length : 1;
}

/** the SAME mapping `PermissionGuard` applies to a denied `PolicyEngine` decision */
function httpErrorFor(decision: Extract<Decision, { allowed: false }>): Error {
  switch (decision.reason) {
    case 'MODULE_NOT_ENTITLED':
      return new DomainError(
        'MODULE_NOT_ENTITLED',
        `module "${decision.detail}" is not enabled for this tenant`,
        403,
      );
    case 'STEP_UP_REQUIRED':
      return new DomainError('STEP_UP_REQUIRED', 'a fresh step-up is required', 403);
    case 'MISSING_PERMISSION':
      return new ForbiddenError('you do not have permission for this action', 'MISSING_PERMISSION');
    case 'COMPANY_OUT_OF_SCOPE':
    case 'BRANCH_OUT_OF_SCOPE':
      // never leak that the resource exists in another company / branch
      return new NotFoundError('resource');
    case 'NOT_TENANT_SCOPED':
    case 'NO_CONTEXT':
      return new UnauthorizedException(decision.reason);
  }
}
