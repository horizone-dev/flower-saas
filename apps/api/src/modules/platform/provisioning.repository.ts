import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { runPlatform, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { SYSTEM_ROLE_TEMPLATES } from './system-roles.js';

export interface ProvisionInput {
  slug: string;
  name: string;
  region: string;
  planVersionId: string;
  companyLegalNameEn: string;
  branchName: string;
  branchTimezone: string;
  posTerminalCode: string;
  ownerEmail: string;
  setPasswordTokenHash: string;
  setPasswordExpiresAt: Date;
  entitlements: { moduleKey: string; enabled: boolean }[];
  limits: { limitKey: string; value: bigint }[];
  actorPlatformUserId: string | null;
}

export interface ProvisionResult {
  tenantId: string;
  companyId: string;
  branchId: string;
  posTerminalId: string;
  ownerUserId: string;
}

@Injectable()
export class ProvisioningRepository {
  constructor(private readonly db: DbService) {}
  private get c(): PrismaClient {
    return this.db.platformClient();
  }

  /**
   * The whole of provisioning in ONE transaction (amendment 3 — no external side
   * effect inside; `outbox` rows represent them). Multiple `audit_log` rows —
   * one per auditable effect (amendment 2).
   */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    return runPlatform(
      this.c,
      async (tx) => {
        const tenantId = randomUUID();
        const companyId = randomUUID();
        const branchId = randomUUID();
        const posTerminalId = randomUUID();
        const ownerUserId = randomUUID();
        const now = new Date();

        await tx.tenant.create({
          data: {
            id: tenantId,
            slug: input.slug,
            name: input.name,
            region: input.region,
            status: 'DRAFT',
            planVersionId: input.planVersionId,
          },
        });

        if (input.entitlements.length > 0) {
          await tx.tenantEntitlement.createMany({
            data: input.entitlements.map((e) => ({
              tenantId,
              moduleKey: e.moduleKey,
              enabled: e.enabled,
              source: 'DEFAULT',
            })),
          });
        }
        if (input.limits.length > 0) {
          await tx.tenantLimit.createMany({
            data: input.limits.map((l) => ({ tenantId, limitKey: l.limitKey, value: l.value })),
          });
        }

        // 13 system roles + their permissions
        for (const tpl of SYSTEM_ROLE_TEMPLATES) {
          const role = await tx.role.create({
            data: { tenantId, key: tpl.key, name: tpl.name, isSystem: true },
          });
          if (tpl.permissions.length > 0) {
            await tx.rolePermission.createMany({
              data: tpl.permissions.map((permissionKey) => ({
                tenantId,
                roleId: role.id,
                permissionKey,
              })),
            });
          }
        }
        const ownerRole = await tx.role.findUniqueOrThrow({
          where: { tenantId_key: { tenantId, key: 'owner' } },
          select: { id: true },
        });

        await tx.company.create({
          data: {
            id: companyId,
            tenantId,
            legalNameEn: input.companyLegalNameEn,
            status: 'ACTIVE',
          },
        });
        await tx.branch.create({
          data: {
            id: branchId,
            tenantId,
            companyId,
            name: input.branchName,
            timezone: input.branchTimezone,
            status: 'ACTIVE',
          },
        });
        await tx.posTerminal.create({
          data: {
            id: posTerminalId,
            tenantId,
            companyId,
            branchId,
            code: input.posTerminalCode,
            name: `${input.branchName} — Terminal 1`,
            status: 'ACTIVE',
          },
        });

        await tx.user.create({
          data: {
            id: ownerUserId,
            tenantId,
            accountType: 'OWNER',
            email: input.ownerEmail,
            status: 'ACTIVE',
          },
        });
        await tx.userRole.create({
          data: { tenantId, userId: ownerUserId, roleId: ownerRole.id },
        });
        await tx.dataScopeAssignment.create({
          data: {
            tenantId,
            userId: ownerUserId,
            companyScopeAll: true,
            branchScopeAll: true,
            companyIds: [],
            branchIds: [],
          },
        });
        await tx.setPasswordToken.create({
          data: {
            tenantId,
            userId: ownerUserId,
            tokenHash: input.setPasswordTokenHash,
            expiresAt: input.setPasswordExpiresAt,
            createdByPlatformUserId: input.actorPlatformUserId,
          },
        });

        // audit — one row per auditable effect (amendment 2)
        const auditBase = {
          tenantId,
          actorPlatformUserId: input.actorPlatformUserId,
          actorAccountType: 'PLATFORM',
          at: now,
        } as const;
        await tx.auditLog.createMany({
          data: [
            {
              ...auditBase,
              action: 'tenant.created',
              resourceType: 'tenant',
              resourceId: tenantId,
            },
            {
              ...auditBase,
              action: 'company.created',
              resourceType: 'company',
              resourceId: companyId,
            },
            {
              ...auditBase,
              action: 'branch.created',
              resourceType: 'branch',
              resourceId: branchId,
            },
            {
              ...auditBase,
              action: 'pos_terminal.created',
              resourceType: 'pos_terminal',
              resourceId: posTerminalId,
            },
            {
              ...auditBase,
              action: 'user.created',
              resourceType: 'user',
              resourceId: ownerUserId,
              reason: 'first owner (provisioning)',
            },
          ],
        });

        // external effects (owner invite, etc.) go via the outbox — never a call
        // inside this transaction (amendment 3). The dispatcher is Phase 2.
        await tx.outbox.create({
          data: {
            tenantId,
            aggregateType: 'tenant',
            aggregateId: tenantId,
            eventType: 'tenant.provisioned',
            payload: { tenantId, ownerUserId, ownerEmail: input.ownerEmail },
          },
        });

        await tx.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });

        return { tenantId, companyId, branchId, posTerminalId, ownerUserId };
      },
      { timeout: 30_000, maxWait: 20_000 },
    );
  }

  slugTaken(slug: string): Promise<boolean> {
    return runPlatform(this.c, (tx) =>
      tx.tenant.findUnique({ where: { slug }, select: { id: true } }).then((t) => t !== null),
    );
  }
}
