import { Injectable } from '@nestjs/common';
import { runPlatform, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';

@Injectable()
export class TenantRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditWriter,
  ) {}
  private get c(): PrismaClient {
    return this.db.platformClient();
  }

  /** Flip a tenant's status + write the audit row in one transaction. */
  async setStatus(
    tenantId: string,
    action: string,
    next: string,
    actorPlatformUserId: string | null,
    reason: string | undefined,
  ): Promise<{ previous: string }> {
    return runPlatform(this.c, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });
      if (!tenant) throw new DomainError('TENANT_NOT_FOUND', 'unknown tenant', 404);
      if (tenant.status === 'TERMINATED') {
        throw new DomainError('TENANT_TERMINATED', 'a terminated tenant cannot change state', 409);
      }
      await tx.tenant.update({ where: { id: tenantId }, data: { status: next } });
      await this.audit.record(tx, {
        tenantId,
        action: `tenant.${action}`,
        resourceType: 'tenant',
        resourceId: tenantId,
        reason: reason ?? null,
        before: { status: tenant.status },
        after: { status: next },
      });
      return { previous: tenant.status };
    });
  }

  async markTenantSessionsRevoked(tenantId: string, reason: string): Promise<void> {
    await runPlatform(this.c, (tx) =>
      tx.session.updateMany({
        where: { tenantId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      }),
    );
  }

  async tenantStatus(tenantId: string): Promise<string | null> {
    const t = await runPlatform(this.c, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
    );
    return t?.status ?? null;
  }

  async findActiveOwnerId(tenantId: string): Promise<string | null> {
    const owner = await runPlatform(this.c, (tx) =>
      tx.user.findFirst({
        where: { tenantId, accountType: 'OWNER', status: 'ACTIVE' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return owner?.id ?? null;
  }
}
