import { Injectable } from '@nestjs/common';
import { runPlatform, runScoped, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';

/** Reads/writes a tenant's resolved entitlements + limits. Provisioning + the
 *  Super Admin editors write here (platform path); LimitService reads counts
 *  tenant-scoped. */
@Injectable()
export class TenantConfigRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditWriter,
  ) {}
  private get platform(): PrismaClient {
    return this.db.platformClient();
  }
  private get app(): PrismaClient {
    return this.db.appClient();
  }

  /** Snapshot a plan version's defaults onto a tenant (provisioning — task 1.7). */
  async snapshotFromPlanVersion(
    tenantId: string,
    entitlements: { moduleKey: string; enabled: boolean }[],
    limits: { limitKey: string; value: bigint }[],
  ): Promise<void> {
    await runPlatform(this.platform, async (tx) => {
      for (const e of entitlements) {
        await tx.tenantEntitlement.upsert({
          where: { tenantId_moduleKey: { tenantId, moduleKey: e.moduleKey } },
          create: { tenantId, moduleKey: e.moduleKey, enabled: e.enabled, source: 'DEFAULT' },
          update: { enabled: e.enabled, source: 'DEFAULT' },
        });
      }
      for (const l of limits) {
        await tx.tenantLimit.upsert({
          where: { tenantId_limitKey: { tenantId, limitKey: l.limitKey } },
          create: { tenantId, limitKey: l.limitKey, value: l.value },
          update: { value: l.value },
        });
      }
    });
  }

  entitlements(tenantId: string): Promise<{ moduleKey: string; enabled: boolean }[]> {
    return runPlatform(this.platform, (tx) =>
      tx.tenantEntitlement.findMany({
        where: { tenantId },
        select: { moduleKey: true, enabled: true },
      }),
    );
  }

  limits(tenantId: string): Promise<{ limitKey: string; value: bigint; isOverride: boolean }[]> {
    return runPlatform(this.platform, (tx) =>
      tx.tenantLimit.findMany({
        where: { tenantId },
        select: { limitKey: true, value: true, isOverride: true },
      }),
    );
  }

  limit(tenantId: string, limitKey: string): Promise<{ value: bigint } | null> {
    return runPlatform(this.platform, (tx) =>
      tx.tenantLimit.findUnique({
        where: { tenantId_limitKey: { tenantId, limitKey } },
        select: { value: true },
      }),
    );
  }

  async setEntitlement(tenantId: string, moduleKey: string, enabled: boolean): Promise<void> {
    await runPlatform(this.platform, async (tx) => {
      const before = await tx.tenantEntitlement.findUnique({
        where: { tenantId_moduleKey: { tenantId, moduleKey } },
        select: { enabled: true },
      });
      await tx.tenantEntitlement.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey } },
        create: { tenantId, moduleKey, enabled, source: 'OVERRIDE' },
        update: { enabled, source: 'OVERRIDE' },
      });
      await this.audit.record(tx, {
        action: 'tenant.entitlement_overridden',
        resourceType: 'tenant_entitlement',
        resourceId: `${tenantId}/${moduleKey}`,
        tenantId,
        before: { enabled: before?.enabled ?? null },
        after: { enabled },
      });
    });
  }

  async overrideLimit(
    tenantId: string,
    limitKey: string,
    value: bigint,
    reason: string,
    setByPlatformUserId: string | null,
  ): Promise<void> {
    await runPlatform(this.platform, async (tx) => {
      const before = await tx.tenantLimit.findUnique({
        where: { tenantId_limitKey: { tenantId, limitKey } },
        select: { value: true, isOverride: true },
      });
      await tx.tenantLimit.upsert({
        where: { tenantId_limitKey: { tenantId, limitKey } },
        create: {
          tenantId,
          limitKey,
          value,
          isOverride: true,
          overrideReason: reason,
          setByPlatformUserId,
          setAt: new Date(),
        },
        update: {
          value,
          isOverride: true,
          overrideReason: reason,
          setByPlatformUserId,
          setAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'tenant.limit_overridden',
        resourceType: 'tenant_limit',
        resourceId: `${tenantId}/${limitKey}`,
        tenantId,
        reason,
        before: before ? { value: Number(before.value), isOverride: before.isOverride } : null,
        after: { value: Number(value), isOverride: true },
      });
    });
  }

  /** Current usage counts, tenant-scoped through RLS. */
  async usage(
    tenantId: string,
    which: 'company' | 'branch' | 'pos_terminal' | 'user_normal' | 'user_owner',
  ): Promise<number> {
    return runScoped(this.app, { tenantId }, async (tx) => {
      switch (which) {
        case 'company':
          return tx.company.count();
        case 'branch':
          return tx.branch.count();
        case 'pos_terminal':
          return tx.posTerminal.count();
        case 'user_normal':
          return tx.user.count({ where: { accountType: 'USER' } });
        case 'user_owner':
          return tx.user.count({ where: { accountType: 'OWNER' } });
      }
    });
  }
}
