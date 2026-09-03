import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { Realm, SessionData } from '../../common/auth/session.types.js';
import type { MfaLevel } from '../../common/context/index.js';
import { PolicyService } from '../access/policy.service.js';
import { LimitService } from '../platform/limit.service.js';
import { IdentityRepository } from './identity.repository.js';
import { PlatformIdentityRepository } from './platform-identity.repository.js';
import { RefreshTokenStore } from './refresh-token.store.js';

export interface IssueSessionInput {
  realm: Realm;
  tenantId: string | null;
  userId: string | null;
  platformUserId: string | null;
  accountType: SessionData['accountType'];
  mfaLevel: MfaLevel;
  ip: string | null;
  userAgent: string | null;
  posTerminalId?: string | null;
  impersonatorPlatformUserId?: string | null;
  /** shorten the session lifetime (impersonation ≤ 30 min — OD7) */
  ttlSecondsOverride?: number;
}

export interface IssuedSession {
  session: SessionData;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
    private readonly store: SessionStore,
    private readonly refresh: RefreshTokenStore,
    private readonly policy: PolicyService,
    private readonly limits: LimitService,
    private readonly identity: IdentityRepository,
    private readonly platformIdentity: PlatformIdentityRepository,
  ) {}

  async issue(input: IssueSessionInput): Promise<IssuedSession> {
    const now = Date.now();
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const ttlSeconds = Math.min(
      input.ttlSecondsOverride ?? this.config.AUTH_SESSION_TTL_SECONDS,
      this.config.AUTH_SESSION_TTL_SECONDS,
    );
    const expiresAt = now + ttlSeconds * 1000;

    // concurrent-session limit (tenant realm) — refuse before creating anything.
    // Impersonation sessions don't count against the owner's cap.
    if (
      input.realm === 'tenant' &&
      input.tenantId &&
      input.userId &&
      !input.impersonatorPlatformUserId
    ) {
      await this.limits.assertSessionWithin(input.tenantId, input.userId);
    }

    const access =
      input.realm === 'tenant' && input.tenantId && input.userId
        ? await this.resolveAccess(input.tenantId, input.userId)
        : input.realm === 'platform' && input.platformUserId
          ? await this.resolvePlatformAccess(input.platformUserId)
          : null;

    const session: SessionData = {
      sessionId,
      realm: input.realm,
      familyId,
      tenantId: input.tenantId,
      userId: input.userId,
      platformUserId: input.platformUserId,
      accountType: input.accountType,
      posTerminalId: input.posTerminalId ?? null,
      deviceId: null,
      mfaLevel: input.mfaLevel,
      stepUpUntil: null,
      createdAt: now,
      expiresAt,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: input.impersonatorPlatformUserId ?? null,
      access,
    };
    await this.store.set(session);

    if (input.realm === 'tenant' && input.tenantId && input.userId) {
      await this.identity.insertSessionRow({
        id: sessionId,
        tenantId: input.tenantId,
        userId: input.userId,
        posTerminalId: input.posTerminalId ?? null,
        mfaLevel: input.mfaLevel,
        ip: input.ip,
        userAgent: input.userAgent,
        expiresAt: new Date(expiresAt),
      });
    }

    if (input.realm === 'tenant' && input.tenantId && input.userId) {
      await this.limits.recordSession(input.tenantId, input.userId, sessionId, expiresAt);
    }

    const { token: refreshToken } = await this.refresh.issue(sessionId, familyId);
    const accessToken = await this.signAccess(session);
    return { session, accessToken, refreshToken };
  }

  async signAccess(session: SessionData): Promise<string> {
    return this.jwt.sign(
      session.realm === 'platform'
        ? { sub: session.platformUserId!, sid: session.sessionId, aud: 'platform' }
        : { sub: session.userId!, sid: session.sessionId, aud: 'tenant', tid: session.tenantId! },
    );
  }

  async get(sessionId: string): Promise<SessionData | null> {
    return this.store.get(sessionId);
  }

  /** Rotate the refresh token; re-issue the access token; refresh the access
   *  snapshot (a role/scope change since login takes effect here). */
  async rotate(
    oldRefreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; session: SessionData }> {
    const rotated = await this.refresh.rotate(oldRefreshToken);
    const session = await this.store.get(rotated.sessionId);
    if (!session) throw new Error('session gone');

    if (session.realm === 'tenant' && session.tenantId && session.userId) {
      session.access = await this.resolveAccess(session.tenantId, session.userId);
      await this.store.set(session);
    }
    return {
      accessToken: await this.signAccess(session),
      refreshToken: rotated.token,
      session,
    };
  }

  async stepUp(sessionId: string): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) return;
    session.mfaLevel = 'STEP_UP';
    session.stepUpUntil = Date.now() + this.config.AUTH_STEP_UP_TTL_SECONDS * 1000;
    await this.store.set(session);
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    const session = await this.store.get(sessionId);
    await this.store.revoke(sessionId, reason);
    await this.identity.markSessionRowRevoked(sessionId, reason).catch(() => {});
    if (session) {
      await this.refresh.revokeFamily(session.familyId).catch(() => []);
      if (session.tenantId && session.userId) {
        await this.limits.dropSession(session.tenantId, session.userId, sessionId).catch(() => {});
      }
    }
  }

  private async resolveAccess(tenantId: string, userId: string): Promise<SessionData['access']> {
    const r = await this.policy.resolveForUser(userId, tenantId);
    return {
      effectivePermissions: [...r.effectivePermissions],
      companyScope: r.companyScope === 'ALL' ? 'ALL' : [...r.companyScope],
      branchScope: r.branchScope === 'ALL' ? 'ALL' : [...r.branchScope],
      perBranchOverlay: Object.fromEntries(
        [...r.perBranchOverlay].map(([b, keys]) => [b, [...keys]]),
      ),
      entitledModules: [...r.entitledModules],
      planKey: null,
    };
  }

  private async resolvePlatformAccess(platformUserId: string): Promise<SessionData['access']> {
    return {
      effectivePermissions: await this.platformIdentity.permissionsFor(platformUserId),
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
  }
}
