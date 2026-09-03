import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { PasswordService } from '../../common/crypto/password.service.js';
import { TotpService } from '../../common/crypto/totp.service.js';
import type { MfaLevel } from '../../common/context/index.js';
import { RefreshReuseError, RefreshInvalidError } from './refresh-token.store.js';
import { IdentityRepository } from './identity.repository.js';
import { PlatformIdentityRepository } from './platform-identity.repository.js';
import { SessionService } from './session.service.js';
import { BruteForceService } from './brute-force.service.js';

/** A fixed valid argon2id digest so a login for a non-existent user still runs a
 *  verify (no user-enumeration timing oracle). Generated once, of "not-a-real-password". */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';

export interface LoginResult {
  status: 'ok' | 'mfa_required';
  accessToken?: string;
  refreshToken?: string;
  mfaChallenge?: string;
  expiresIn?: number;
}

interface Actor {
  sessionId: string;
  realm: 'tenant' | 'platform';
  tenantId: string | null;
  userId: string | null;
  platformUserId: string | null;
}

@Injectable()
export class AuthService {
  private readonly mfaKey: Uint8Array;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly identity: IdentityRepository,
    private readonly platformIdentity: PlatformIdentityRepository,
    private readonly sessions: SessionService,
    private readonly bruteForce: BruteForceService,
  ) {
    this.mfaKey = new TextEncoder().encode(config.AUTH_JWT_SECRET + ':mfa');
  }

  // ── tenant login ──────────────────────────────────────────────────────────
  async login(input: {
    workspaceSlug: string;
    email: string;
    password: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<LoginResult> {
    const key = `${input.workspaceSlug}/${input.email}`;
    await this.assertNotLocked(key, input.ip, {
      tenantId: null,
      detail: { slug: input.workspaceSlug, email: input.email },
    });

    const tenant = await this.identity.resolveTenantBySlug(input.workspaceSlug);
    const user =
      tenant?.status === 'ACTIVE'
        ? await this.identity.loadLoginUser(tenant.id, input.email)
        : null;

    const passwordOk = await this.passwords.verify(
      user?.passwordHash ?? DUMMY_HASH,
      input.password,
    );
    if (!user || user.status !== 'ACTIVE' || !user.passwordHash || !passwordOk) {
      await this.bruteForce.recordFailure(key, input.ip);
      await this.identity.writeLoginSecurityEvent({
        tenantId: tenant?.id ?? null,
        userId: user?.id ?? null,
        kind: 'LOGIN_FAIL',
        ip: input.ip,
        userAgent: input.userAgent,
      });
      throw new DomainError('LOGIN_FAILED', 'invalid workspace, email or password', 401);
    }
    await this.bruteForce.recordSuccess(key, input.ip);

    if (user.mfa) {
      return {
        status: 'mfa_required',
        mfaChallenge: await this.mfaChallenge('tenant', user.id, tenant!.id),
      };
    }
    return this.finishTenantLogin(user.id, tenant!.id, user.accountType, 'MFA', input);
  }

  async verifyMfa(input: {
    mfaChallenge: string;
    code: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<LoginResult> {
    const challenge = await this.readMfaChallenge(input.mfaChallenge);

    if (challenge.realm === 'platform') {
      const secret = await this.platformIdentity.mfaSecretFor(challenge.sub);
      if (!secret || !this.totp.verify(input.code, secret))
        throw this.mfaFailed(null, challenge.sub, input);
      const issued = await this.sessions.issue({
        realm: 'platform',
        tenantId: null,
        userId: null,
        platformUserId: challenge.sub,
        accountType: 'PLATFORM',
        mfaLevel: 'STEP_UP',
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return this.ok(issued);
    }

    const user = await this.identity.loadUserById(challenge.tid!, challenge.sub);
    if (!user?.mfa || !this.totp.verify(input.code, user.mfa.secretRef)) {
      throw this.mfaFailed(challenge.tid ?? null, challenge.sub, input);
    }
    return this.finishTenantLogin(challenge.sub, challenge.tid!, user.accountType, 'MFA', input);
  }

  private async finishTenantLogin(
    userId: string,
    tenantId: string,
    accountType: 'OWNER' | 'USER',
    mfaLevel: MfaLevel,
    ctx: { ip: string | null; userAgent: string | null },
  ): Promise<LoginResult> {
    const issued = await this.sessions.issue({
      realm: 'tenant',
      tenantId,
      userId,
      platformUserId: null,
      accountType,
      mfaLevel,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.identity.writeLoginSecurityEvent({
      tenantId,
      userId,
      kind: 'LOGIN_OK',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.ok(issued);
  }

  // ── platform login (MFA mandatory — OD2) ──────────────────────────────────
  async platformLogin(input: {
    email: string;
    password: string;
    code?: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<LoginResult> {
    const key = `platform/${input.email}`;
    await this.assertNotLocked(key, input.ip, { tenantId: null, detail: { realm: 'platform' } });

    const user = await this.platformIdentity.loadLoginUser(input.email);
    const passwordOk = await this.passwords.verify(
      user?.passwordHash ?? DUMMY_HASH,
      input.password,
    );
    if (!user || user.status !== 'ACTIVE' || !user.passwordHash || !passwordOk) {
      await this.bruteForce.recordFailure(key, input.ip);
      await this.identity.writeLoginSecurityEvent({
        tenantId: null,
        userId: null,
        kind: 'LOGIN_FAIL',
        ip: input.ip,
        userAgent: input.userAgent,
        detail: { realm: 'platform', email: input.email },
      });
      throw new DomainError('LOGIN_FAILED', 'invalid email or password', 401);
    }
    await this.bruteForce.recordSuccess(key, input.ip);

    if (!user.mfa)
      throw new DomainError('MFA_ENROLLMENT_REQUIRED', 'platform accounts must enrol TOTP', 403);
    if (!input.code || !this.totp.verify(input.code, user.mfa.secretRef)) {
      await this.bruteForce.recordFailure(key, input.ip);
      throw new DomainError('MFA_FAILED', 'invalid or missing verification code', 401);
    }

    const issued = await this.sessions.issue({
      realm: 'platform',
      tenantId: null,
      userId: null,
      platformUserId: user.id,
      accountType: 'PLATFORM',
      mfaLevel: 'STEP_UP',
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await this.identity.writeLoginSecurityEvent({
      tenantId: null,
      userId: null,
      kind: 'LOGIN_OK',
      ip: input.ip,
      userAgent: input.userAgent,
      detail: { realm: 'platform', platformUserId: user.id },
    });
    return this.ok(issued);
  }

  // ── refresh / step-up / logout ────────────────────────────────────────────
  async refresh(refreshToken: string, ip: string | null): Promise<LoginResult> {
    try {
      const r = await this.sessions.rotate(refreshToken);
      return this.ok(r);
    } catch (err) {
      if (err instanceof RefreshReuseError) {
        await this.identity.writeLoginSecurityEvent({
          tenantId: null,
          userId: null,
          kind: 'REFRESH_REUSE',
          ip,
          userAgent: null,
          detail: { familyId: err.familyId },
        });
        throw new DomainError('REFRESH_REUSED', 'session ended for security reasons', 401);
      }
      if (err instanceof RefreshInvalidError) {
        throw new DomainError('REFRESH_INVALID', 'refresh token invalid or expired', 401);
      }
      throw err;
    }
  }

  async stepUp(actor: Actor, code: string): Promise<void> {
    const secret =
      actor.realm === 'platform' && actor.platformUserId
        ? await this.platformIdentity.mfaSecretFor(actor.platformUserId)
        : actor.tenantId && actor.userId
          ? ((await this.identity.loadUserById(actor.tenantId, actor.userId))?.mfa?.secretRef ??
            null)
          : null;
    if (!secret || !this.totp.verify(code, secret)) {
      throw new DomainError('MFA_FAILED', 'invalid verification code', 401);
    }
    await this.sessions.stepUp(actor.sessionId);
    await this.identity.writeLoginSecurityEvent({
      tenantId: actor.tenantId,
      userId: actor.userId,
      kind: 'STEP_UP_OK',
      ip: null,
      userAgent: null,
    });
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
  }

  async revokeSession(targetSessionId: string, byUserId: string | null): Promise<void> {
    await this.sessions.revoke(targetSessionId, `revoked by ${byUserId ?? 'system'}`);
    await this.identity.writeLoginSecurityEvent({
      tenantId: null,
      userId: byUserId,
      kind: 'SESSION_REVOKED',
      ip: null,
      userAgent: null,
      detail: { targetSessionId },
    });
  }

  // ── set-password (admin-generated link — OD3) ─────────────────────────────
  generateSetPasswordToken(): string {
    return randomBytes(32).toString('base64url');
  }
  hashSetPasswordToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
  async setPassword(rawToken: string, newPassword: string): Promise<void> {
    if (newPassword.length < 12) {
      throw new DomainError('WEAK_PASSWORD', 'password must be at least 12 characters', 422);
    }
    const consumed = await this.identity.consumeSetPasswordToken(
      this.hashSetPasswordToken(rawToken),
    );
    if (!consumed) throw new DomainError('TOKEN_INVALID', 'link is invalid, used or expired', 400);
    await this.identity.upsertPasswordCredential(
      consumed.tenantId,
      consumed.userId,
      await this.passwords.hash(newPassword),
    );
  }

  // ── MFA enrolment (tenant) ───────────────────────────────────────────────
  async enrolMfa(
    tenantId: string,
    userId: string,
    email: string,
  ): Promise<{ secret: string; uri: string }> {
    const secret = this.totp.generateSecret();
    await this.identity.upsertMfaFactor(tenantId, userId, secret);
    return { secret, uri: this.totp.keyUri(email, secret) };
  }
  async confirmMfa(tenantId: string, userId: string, code: string): Promise<void> {
    const factor = await this.identity.pendingMfaFactor(tenantId, userId);
    if (!factor || !this.totp.verify(code, factor.secretRef)) {
      throw new DomainError('MFA_FAILED', 'invalid verification code', 401);
    }
    await this.identity.confirmMfaFactor(tenantId, factor.id);
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private ok(issued: { accessToken: string; refreshToken: string }): LoginResult {
    return {
      status: 'ok',
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: this.config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private async assertNotLocked(
    key: string,
    ip: string | null,
    evt: { tenantId: string | null; detail?: Record<string, unknown> },
  ): Promise<void> {
    if (await this.bruteForce.isLocked(key, ip)) {
      await this.identity.writeLoginSecurityEvent({
        tenantId: evt.tenantId,
        userId: null,
        kind: 'LOCKOUT',
        ip,
        userAgent: null,
        detail: evt.detail ?? {},
      });
      throw new DomainError('LOGIN_LOCKED', 'too many attempts — try again later', 429);
    }
  }

  private async mfaChallenge(
    realm: 'tenant' | 'platform',
    sub: string,
    tid?: string,
  ): Promise<string> {
    return new SignJWT({ realm, ...(tid ? { tid } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.mfaKey);
  }
  private async readMfaChallenge(
    token: string,
  ): Promise<{ realm: 'tenant' | 'platform'; sub: string; tid?: string }> {
    try {
      const { payload } = await jwtVerify(token, this.mfaKey);
      const realm = payload['realm'] === 'platform' ? 'platform' : 'tenant';
      const sub = String(payload.sub);
      return typeof payload['tid'] === 'string'
        ? { realm, sub, tid: payload['tid'] }
        : { realm, sub };
    } catch {
      throw new DomainError(
        'MFA_CHALLENGE_INVALID',
        'the MFA challenge expired — log in again',
        401,
      );
    }
  }
  private mfaFailed(
    tenantId: string | null,
    userId: string,
    input: { ip: string | null; userAgent: string | null },
  ): DomainError {
    void this.identity.writeLoginSecurityEvent({
      tenantId,
      userId,
      kind: 'MFA_FAIL',
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return new DomainError('MFA_FAILED', 'invalid verification code', 401);
  }
}
