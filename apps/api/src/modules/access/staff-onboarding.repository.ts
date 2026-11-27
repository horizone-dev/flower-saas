import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { runPlatform, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';

/**
 * F-7 (PROPOSED, NOT registered in any module, NO route) — the persistence half of "create a staff user and invite them".
 *
 * ONE platform transaction: serialise concurrent invites for the tenant (tenant row lock), then check the tenant is ACTIVE, the role is an
 * existing active role of THIS tenant, every company and branch belongs to THIS tenant (and each branch to a listed company), the plan's
 * `max_users` limit still holds on the re-count taken under the lock, and the email is free; then create the user (ACTIVE, accountType USER,
 * no credential yet), exactly ONE role, an EXPLICIT data scope (never "all"), the single-use set-password token (hash only), and the audit
 * rows `user.created`, `user.roles_changed`, `user.scope_changed`. Any failure rolls everything back: no half-created account.
 */
export interface CreateStaffInput {
  tenantId: string;
  email: string;
  roleKey: string;
  companyIds: readonly string[];
  branchIds: readonly string[];
  tokenHash: string;
  tokenExpiresAt: Date;
  /** the plan's effective `max_users` (the re-count under the lock is compared with it); null = unlimited */
  maxUsers: number | null;
  actorPlatformUserId: string;
}

export interface CreateStaffResult {
  userId: string;
  roleId: string;
}

@Injectable()
export class StaffOnboardingRepository {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditWriter,
  ) {}
  private get c(): PrismaClient {
    return this.db.platformClient();
  }

  async createStaffUser(input: CreateStaffInput): Promise<CreateStaffResult> {
    const { tenantId } = input;
    return runPlatform(this.c, async (tx) => {
      // serialise invites for this tenant: the limit re-count below must see every committed invite
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "tenant" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError('tenant');
      if (locked[0]!.status !== 'ACTIVE') {
        throw new DomainError('TENANT_NOT_ACTIVE', 'the workspace is not active', 409);
      }

      const role = await tx.role.findUnique({
        where: { tenantId_key: { tenantId, key: input.roleKey } },
        select: { id: true, isActive: true },
      });
      if (!role || !role.isActive) {
        throw new DomainError('ROLE_NOT_FOUND', 'no such active role in this workspace', 422);
      }

      const companies = await tx.company.findMany({
        where: { tenantId, id: { in: [...input.companyIds] } },
        select: { id: true },
      });
      if (companies.length !== input.companyIds.length) {
        throw new DomainError('SCOPE_INVALID', 'a company does not belong to this workspace', 422);
      }
      const branches = await tx.branch.findMany({
        where: { tenantId, id: { in: [...input.branchIds] } },
        select: { id: true, companyId: true },
      });
      const companySet = new Set(input.companyIds);
      if (
        branches.length !== input.branchIds.length ||
        branches.some((b) => !companySet.has(b.companyId))
      ) {
        throw new DomainError(
          'SCOPE_INVALID',
          'a branch does not belong to this workspace or to a listed company',
          422,
        );
      }

      if (input.maxUsers !== null) {
        const current = await tx.user.count({ where: { tenantId, accountType: 'USER' } });
        if (current + 1 > input.maxUsers) {
          throw new DomainError(
            'LIMIT_EXCEEDED',
            `plan limit "max_users" reached (${current}/${input.maxUsers})`,
            422,
          );
        }
      }

      if (
        await tx.user.findUnique({ where: { tenantId_email: { tenantId, email: input.email } } })
      ) {
        throw new DomainError('USER_EMAIL_TAKEN', 'a user with this email already exists', 409);
      }

      const userId = randomUUID();
      await tx.user.create({
        data: { id: userId, tenantId, accountType: 'USER', email: input.email, status: 'ACTIVE' },
      });
      await tx.userRole.create({ data: { tenantId, userId, roleId: role.id } });
      await tx.dataScopeAssignment.create({
        data: {
          tenantId,
          userId,
          companyScopeAll: false,
          branchScopeAll: false,
          companyIds: [...input.companyIds],
          branchIds: [...input.branchIds],
        },
      });
      await tx.setPasswordToken.create({
        data: {
          tenantId,
          userId,
          tokenHash: input.tokenHash,
          expiresAt: input.tokenExpiresAt,
          createdByPlatformUserId: input.actorPlatformUserId,
        },
      });

      const actor = {
        tenantId,
        actorPlatformUserId: input.actorPlatformUserId,
        actorAccountType: 'PLATFORM',
      } as const;
      await this.audit.record(tx, {
        ...actor,
        action: 'user.created',
        resourceType: 'user',
        resourceId: userId,
        reason: 'staff onboarding (invite)',
        after: { accountType: 'USER', roleKey: input.roleKey },
      });
      await this.audit.record(tx, {
        ...actor,
        action: 'user.roles_changed',
        resourceType: 'user',
        resourceId: userId,
        before: { roleIds: [] },
        after: { roleIds: [role.id] },
      });
      await this.audit.record(tx, {
        ...actor,
        action: 'user.scope_changed',
        resourceType: 'user',
        resourceId: userId,
        after: {
          companyScopeAll: false,
          branchScopeAll: false,
          companyIds: [...input.companyIds].sort(),
          branchIds: [...input.branchIds].sort(),
        },
      });
      return { userId, roleId: role.id };
    });
  }
}
