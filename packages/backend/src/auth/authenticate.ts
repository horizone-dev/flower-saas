import { Injectable } from '@nestjs/common';
import { JwtService, TokenInvalidError } from './jwt.service.js';
import { SessionStore } from './session-store.js';
import type { Realm, SessionData } from './session.types.js';

/**
 * A framework-agnostic authentication failure — deliberately **not** a Nest
 * `UnauthorizedException` (that's an `apps/api`-only HTTP concept). Each
 * consumer maps `.code` onto its own transport: `apps/api`'s `AuthGuard` throws
 * `UnauthorizedException(err.message)`; `apps/realtime`'s WS handler closes the
 * socket with a policy-violation close code and a short reason.
 */
export class SessionAuthError extends Error {
  constructor(
    public readonly code:
      | 'MISSING_TOKEN'
      | 'TOKEN_INVALID'
      | 'SESSION_NOT_FOUND'
      | 'WRONG_REALM'
      | 'SESSION_REVOKED'
      | 'SESSION_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'SessionAuthError';
  }
}

/**
 * Steps 1–3 of the Phase 1 guard pipeline (SECURITY.md), extracted (task 2.5) so
 * `apps/api`'s `AuthGuard` and `apps/realtime`'s WS connection handler run the
 * **exact same** token → session → status resolution — the whole reason this
 * extraction exists (token / realm / session semantics must never drift between
 * the two processes).
 *
 * Deliberately **excludes**:
 * - token **extraction** from a transport (an `Authorization` header, a cookie,
 *   a WS handshake query param) — that stays in each consumer, it is
 *   inherently transport-specific;
 * - step 4, the registered-device check (a documented no-op in Phase 1/2-core,
 *   HTTP-request-shaped, and not a realtime concern);
 * - populating `RequestContext` — an `apps/api`-only, HTTP-request-scoped
 *   primitive; `apps/realtime` derives its own (narrower) per-socket
 *   authorization state directly from the returned `SessionData`.
 * - any domain/business authorization (permissions, entitlements, company/branch
 *   scope **enforcement** for a specific action) — this function only answers
 *   "is this a live, valid session for the expected realm", nothing more.
 */
@Injectable()
export class SessionAuthenticator {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionStore,
  ) {}

  async authenticate(token: string, expectedRealm: Realm): Promise<SessionData> {
    let sessionId: string;
    try {
      ({ sid: sessionId } = await this.jwt.verify(token, expectedRealm));
    } catch (err) {
      throw new SessionAuthError(
        'TOKEN_INVALID',
        err instanceof TokenInvalidError ? err.message : 'token invalid',
      );
    }

    const session = await this.sessions.get(sessionId);
    if (!session) throw new SessionAuthError('SESSION_NOT_FOUND', 'session not found');
    if (session.realm !== expectedRealm) throw new SessionAuthError('WRONG_REALM', 'wrong realm');
    if (session.revokedAt !== null)
      throw new SessionAuthError('SESSION_REVOKED', 'session revoked');
    if (session.expiresAt <= Date.now()) {
      throw new SessionAuthError('SESSION_EXPIRED', 'session expired');
    }

    return session;
  }
}
