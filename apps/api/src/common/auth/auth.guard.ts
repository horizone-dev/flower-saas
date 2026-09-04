import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { SessionAuthenticator, SessionAuthError } from '@flower/backend';
import { requireContext, replaceContext } from '../context/index.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { PLATFORM_REALM_KEY } from './pipeline.decorators.js';
import { isStepUpActive, type Realm, type SessionData } from './session.types.js';

/**
 * Pipeline steps 1–4: authentication, tenant (from the session claim only),
 * account/session status, registered device (a documented no-op in Phase 1 —
 * amendment 1). On success the full `RequestContext` is populated from the
 * session's cached access snapshot and swapped into the ALS frame.
 *
 * Steps 1–3 (token verify → session lookup → realm/revoked/expired) run
 * through `SessionAuthenticator` (`@flower/backend`, task 2.5) — the same
 * primitive `apps/realtime`'s WS handler uses, so this app and the realtime
 * gateway can never resolve a session differently. This guard's own job is
 * purely HTTP-transport: extract the bearer token, map an authentication
 * failure onto `UnauthorizedException`, and populate the HTTP-request-scoped
 * `RequestContext`.
 *
 * `@Public()` routes skip this entirely.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: SessionAuthenticator,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    if (this.isPublic(execCtx)) return true;

    const req = execCtx.switchToHttp().getRequest<FastifyRequest>();
    const realm: Realm = this.reflector.getAllAndOverride<boolean>(PLATFORM_REALM_KEY, [
      execCtx.getHandler(),
      execCtx.getClass(),
    ])
      ? 'platform'
      : 'tenant';

    const token = bearer(req);
    if (!token) throw new UnauthorizedException('missing bearer token');

    let session: SessionData;
    try {
      session = await this.authenticator.authenticate(token, realm);
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof SessionAuthError ? err.message : 'auth failed',
      );
    }

    // step 4 — registered device: no-op in Phase 1 (the policy flag can never be
    // true; the full check lands with the devices module in Phase 2).

    replaceContext(requireContext().with(contextPatchFromSession(session)));
    return true;
  }

  private isPublic(execCtx: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        execCtx.getHandler(),
        execCtx.getClass(),
      ]) ?? false
    );
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const value = Array.isArray(h) ? h[0] : h;
  if (!value) {
    // cookie fallback (owner-web / super-admin-web — OD1)
    const cookie = (req as { cookies?: Record<string, string> }).cookies?.['flower_access'];
    return cookie ?? null;
  }
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : null;
}

export function contextPatchFromSession(
  session: SessionData,
): Parameters<ReturnType<typeof requireContext>['with']>[0] {
  const a = session.access;
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    platformUserId: session.platformUserId,
    sessionId: session.sessionId,
    accountType: session.accountType,
    posTerminalId: session.posTerminalId,
    deviceId: session.deviceId,
    mfaLevel: isStepUpActive(session)
      ? 'STEP_UP'
      : session.mfaLevel === 'STEP_UP'
        ? 'MFA'
        : session.mfaLevel,
    impersonatorPlatformUserId: session.impersonatorPlatformUserId,
    companyScope: a ? a.companyScope : [],
    branchScope: a ? a.branchScope : [],
    perBranchOverlay: a
      ? new Map(Object.entries(a.perBranchOverlay).map(([b, keys]) => [b, new Set(keys)]))
      : new Map(),
    effectivePermissions: a?.effectivePermissions ?? [],
    entitlements: a?.entitledModules ?? [],
    planKey: a?.planKey ?? null,
  };
}
