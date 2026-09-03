import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { TenantRepository } from '../platform/tenant.repository.js';
import { SessionService } from './session.service.js';

/**
 * OD7 — impersonation is **READ-ONLY**. A platform admin (with
 * `platform:tenants:impersonate` + a fresh step-up) gets a short-lived tenant
 * session acting as the tenant's owner, with `impersonatorPlatformUserId`
 * stamped. `PermissionGuard.IMPERSONATION_READ_ALLOWLIST` rejects every mutating
 * action during impersonation; every read is audited with the impersonator.
 */
export const IMPERSONATION_MAX_SECONDS = 30 * 60;

@Injectable()
export class ImpersonationService {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly audit: AuditWriter,
    private readonly sessions: SessionService,
  ) {}

  async start(input: {
    tenantId: string;
    platformUserId: string;
    reason: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; banner: true }> {
    const status = await this.tenants.tenantStatus(input.tenantId);
    if (status === null) throw new DomainError('TENANT_NOT_FOUND', 'unknown tenant', 404);
    if (status !== 'ACTIVE') {
      throw new DomainError('TENANT_NOT_ACTIVE', 'can only impersonate into an active tenant', 409);
    }
    const ownerUserId = await this.tenants.findActiveOwnerId(input.tenantId);
    if (!ownerUserId) throw new DomainError('NO_OWNER', 'tenant has no active owner', 409);

    const issued = await this.sessions.issue({
      realm: 'tenant',
      tenantId: input.tenantId,
      userId: ownerUserId,
      platformUserId: null,
      accountType: 'USER',
      mfaLevel: 'STEP_UP',
      ip: input.ip,
      userAgent: input.userAgent,
      impersonatorPlatformUserId: input.platformUserId,
      ttlSecondsOverride: IMPERSONATION_MAX_SECONDS,
    });

    await this.audit.emit({
      tenantId: input.tenantId,
      action: 'IMPERSONATION:started',
      resourceType: 'tenant',
      resourceId: input.tenantId,
      reason: input.reason,
      actorPlatformUserId: input.platformUserId,
      impersonatorPlatformUserId: input.platformUserId,
      after: { sessionId: issued.session.sessionId },
    });

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: IMPERSONATION_MAX_SECONDS,
      banner: true,
    };
  }

  async stop(
    sessionId: string,
    tenantId: string | null,
    platformUserId: string | null,
  ): Promise<void> {
    await this.sessions.revoke(sessionId, 'impersonation ended');
    await this.audit.emit({
      tenantId,
      action: 'IMPERSONATION:ended',
      resourceType: 'tenant',
      resourceId: tenantId,
      actorPlatformUserId: platformUserId,
      impersonatorPlatformUserId: platformUserId,
      after: { sessionId },
    });
  }
}
