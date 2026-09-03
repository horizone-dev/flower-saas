import { Injectable } from '@nestjs/common';
import { runPlatform, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';

export interface PlatformLoginUser {
  id: string;
  status: string;
  email: string;
  passwordHash: string | null;
  mfa: { id: string; secretRef: string } | null;
  permissions: string[];
}

/** The platform identity realm — wholly separate from the tenant realm. All
 *  queries via the platform (BYPASSRLS) connection since the platform_* tables
 *  are RLS-exempt and `flower_app` has no grant on them. */
@Injectable()
export class PlatformIdentityRepository {
  constructor(private readonly db: DbService) {}

  private get client(): PrismaClient {
    return this.db.platformClient();
  }

  async loadLoginUser(email: string): Promise<PlatformLoginUser | null> {
    return runPlatform(this.client, async (tx) => {
      const user = await tx.platformUser.findUnique({
        where: { email },
        select: {
          id: true,
          status: true,
          email: true,
          credential: { select: { hash: true } },
          mfaFactors: {
            where: { kind: 'TOTP', status: 'CONFIRMED' },
            select: { id: true, secretRef: true },
            take: 1,
          },
          roles: {
            select: {
              platformRole: { select: { permissions: { select: { permissionKey: true } } } },
            },
          },
        },
      });
      if (!user) return null;
      const permissions = [
        ...new Set(
          user.roles.flatMap((r) => r.platformRole.permissions.map((p) => p.permissionKey)),
        ),
      ];
      return {
        id: user.id,
        status: user.status,
        email: user.email,
        passwordHash: user.credential?.hash ?? null,
        mfa: user.mfaFactors[0] ?? null,
        permissions,
      };
    });
  }

  async mfaSecretFor(platformUserId: string): Promise<string | null> {
    return runPlatform(this.client, async (tx) => {
      const f = await tx.platformMfaFactor.findFirst({
        where: { platformUserId, kind: 'TOTP', status: 'CONFIRMED' },
        select: { secretRef: true },
      });
      return f?.secretRef ?? null;
    });
  }

  async permissionsFor(platformUserId: string): Promise<string[]> {
    return runPlatform(this.client, async (tx) => {
      const rows = await tx.platformUserRole.findMany({
        where: { platformUserId },
        select: { platformRole: { select: { permissions: { select: { permissionKey: true } } } } },
      });
      return [
        ...new Set(rows.flatMap((r) => r.platformRole.permissions.map((p) => p.permissionKey))),
      ];
    });
  }

  async upsertPasswordCredential(platformUserId: string, hash: string): Promise<void> {
    await runPlatform(this.client, (tx) =>
      tx.platformCredential.upsert({
        where: { platformUserId },
        create: { platformUserId, hash },
        update: { hash },
      }),
    );
  }
}
