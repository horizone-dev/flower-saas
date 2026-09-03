import { Injectable } from '@nestjs/common';
import { runPlatform, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';

export interface PlanVersionConfig {
  planVersionId: string;
  entitlements: { moduleKey: string; enabled: boolean; config: unknown }[];
  limits: { limitKey: string; value: bigint }[];
}

/** Plans, versions and their entitlement/limit defaults — platform realm only. */
@Injectable()
export class PlanRepository {
  constructor(private readonly db: DbService) {}
  private get c(): PrismaClient {
    return this.db.platformClient();
  }

  listPlans(): Promise<
    {
      id: string;
      key: string;
      name: string;
      isActive: boolean;
      versions: { id: string; version: number; status: string }[];
    }[]
  > {
    return runPlatform(this.c, (tx) =>
      tx.plan.findMany({
        orderBy: { key: 'asc' },
        select: {
          id: true,
          key: true,
          name: true,
          isActive: true,
          versions: {
            orderBy: { version: 'asc' },
            select: { id: true, version: true, status: true },
          },
        },
      }),
    );
  }

  createPlan(input: {
    key: string;
    name: string;
    description?: string | null | undefined;
  }): Promise<{ id: string; key: string; name: string }> {
    return runPlatform(this.c, (tx) =>
      tx.plan.create({
        data: { key: input.key, name: input.name, description: input.description ?? null },
        select: { id: true, key: true, name: true },
      }),
    );
  }

  async createPlanVersion(
    planId: string,
    version: number,
    defaults: {
      entitlements: { moduleKey: string; enabled: boolean }[];
      limits: { limitKey: string; value: bigint }[];
    },
  ): Promise<{ id: string }> {
    return runPlatform(this.c, async (tx) => {
      const pv = await tx.planVersion.create({ data: { planId, version } });
      if (defaults.entitlements.length > 0) {
        await tx.entitlementDefault.createMany({
          data: defaults.entitlements.map((e) => ({
            planVersionId: pv.id,
            moduleKey: e.moduleKey,
            enabled: e.enabled,
          })),
        });
      }
      if (defaults.limits.length > 0) {
        await tx.limitDefault.createMany({
          data: defaults.limits.map((l) => ({
            planVersionId: pv.id,
            limitKey: l.limitKey,
            value: l.value,
          })),
        });
      }
      return { id: pv.id };
    });
  }

  async publishPlanVersion(planVersionId: string): Promise<void> {
    await runPlatform(this.c, (tx) =>
      tx.planVersion.update({
        where: { id: planVersionId },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      }),
    );
  }

  /** The defaults for a plan version — used by provisioning to snapshot a tenant. */
  async planVersionConfig(planVersionId: string): Promise<PlanVersionConfig | null> {
    return runPlatform(this.c, async (tx) => {
      const pv = await tx.planVersion.findUnique({
        where: { id: planVersionId },
        select: {
          id: true,
          entitlementDefaults: { select: { moduleKey: true, enabled: true, config: true } },
          limitDefaults: { select: { limitKey: true, value: true } },
        },
      });
      if (!pv) return null;
      return {
        planVersionId: pv.id,
        entitlements: pv.entitlementDefaults.map((e) => ({
          moduleKey: e.moduleKey,
          enabled: e.enabled,
          config: e.config,
        })),
        limits: pv.limitDefaults.map((l) => ({ limitKey: l.limitKey, value: l.value })),
      };
    });
  }

  async setEntitlementDefault(
    planVersionId: string,
    moduleKey: string,
    enabled: boolean,
  ): Promise<void> {
    await runPlatform(this.c, (tx) =>
      tx.entitlementDefault.upsert({
        where: { planVersionId_moduleKey: { planVersionId, moduleKey } },
        create: { planVersionId, moduleKey, enabled },
        update: { enabled },
      }),
    );
  }

  async setLimitDefault(planVersionId: string, limitKey: string, value: bigint): Promise<void> {
    await runPlatform(this.c, (tx) =>
      tx.limitDefault.upsert({
        where: { planVersionId_limitKey: { planVersionId, limitKey } },
        create: { planVersionId, limitKey, value },
        update: { value },
      }),
    );
  }
}
