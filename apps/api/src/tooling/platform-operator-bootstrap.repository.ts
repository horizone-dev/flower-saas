import { runPlatform, type PrismaClient } from '@flower/db';
import { PLATFORM_PERMISSIONS } from '@flower/permissions';

/**
 * Persistence for the FIRST platform operator (production bootstrap — an operator-run CLI, NOT an HTTP route). One platform transaction:
 * the operator, an argon2id password hash, a TOTP factor that is already CONFIRMED (the CLI proved possession of the authenticator before it
 * calls this), the `super_admin` role with every platform permission, and one audit row. It never overwrites an existing operator.
 */
export interface NewOperator {
  email: string;
  name: string;
  passwordHash: string;
  totpSecret: string;
  /** allow a SECOND operator when a confirmed one already exists (explicit opt-in; never the default) */
  allowAdditional: boolean;
}

export class OperatorBootstrapRefused extends Error {
  constructor(
    readonly code: 'OPERATOR_EXISTS' | 'OPERATORS_ALREADY_BOOTSTRAPPED',
    message: string,
  ) {
    super(message);
  }
}

export class PlatformOperatorBootstrapRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: NewOperator): Promise<{ operatorId: string }> {
    return runPlatform(this.prisma, async (tx) => {
      if (await tx.platformUser.findUnique({ where: { email: input.email } })) {
        throw new OperatorBootstrapRefused(
          'OPERATOR_EXISTS',
          'a platform operator with this email already exists',
        );
      }
      if (!input.allowAdditional) {
        const confirmed = await tx.platformMfaFactor.count({ where: { status: 'CONFIRMED' } });
        if (confirmed > 0) {
          throw new OperatorBootstrapRefused(
            'OPERATORS_ALREADY_BOOTSTRAPPED',
            'a platform operator with a confirmed authenticator already exists; bootstrap is for the FIRST operator (pass the explicit additional-operator flag to add another)',
          );
        }
      }
      const role = await tx.platformRole.upsert({
        where: { key: 'super_admin' },
        create: { key: 'super_admin', name: 'Super Admin', isSystem: true },
        update: {},
      });
      for (const permissionKey of PLATFORM_PERMISSIONS) {
        await tx.platformRolePermission.upsert({
          where: { platformRoleId_permissionKey: { platformRoleId: role.id, permissionKey } },
          create: { platformRoleId: role.id, permissionKey },
          update: {},
        });
      }
      const user = await tx.platformUser.create({
        data: { email: input.email, name: input.name, status: 'ACTIVE' },
      });
      await tx.platformCredential.create({
        data: { platformUserId: user.id, hash: input.passwordHash },
      });
      await tx.platformMfaFactor.create({
        data: {
          platformUserId: user.id,
          kind: 'TOTP',
          secretRef: input.totpSecret,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      });
      await tx.platformUserRole.create({
        data: { platformUserId: user.id, platformRoleId: role.id },
      });
      await tx.auditLog.create({
        data: {
          action: 'user.created',
          resourceType: 'platform_user',
          resourceId: user.id,
          actorAccountType: 'SYSTEM',
          reason: 'platform operator bootstrap (CLI)',
          after: { email: input.email, role: 'super_admin', mfa: 'TOTP confirmed' },
        },
      });
      return { operatorId: user.id };
    });
  }
}
