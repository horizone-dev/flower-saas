/**
 * Phase 1 seed. Idempotent (all upserts). Seeds only what the platform realm
 * needs to exist before any tenant is provisioned:
 *   - the `permission_registry` (the Phase 1 tenant subset + the platform realm)
 *   - a `Starter` plan + a published plan version with entitlement/limit defaults
 *   - (optional, dev only) a platform super-admin from the environment
 *
 * NO tenant data — tenants come from provisioning (Phase 1 task 1.7). Not run in
 * production containers.
 */
import 'dotenv/config';
import {
  PHASE_1_TENANT_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PERMISSION_GROUP_OF,
} from '@flower/permissions';
import { ENTITLEMENT_MODULES, LIMIT_KEYS, type LimitKey } from '@flower/shared-types';
import { createPrismaClient, databaseUrlFromEnv } from '../src/client.js';
import { SCHEMA_BASELINE_KEY } from '../src/index.js';

const humanize = (key: string): string => key.replace(/[:_]/g, ' ');

/** Starter-plan default numeric limits. */
const STARTER_LIMITS: Record<LimitKey, bigint> = {
  max_companies: 1n,
  max_branches: 2n,
  max_pos_terminals: 3n,
  max_registered_devices: 3n,
  max_users: 10n,
  max_owner_users: 2n,
  max_pos_concurrent_sessions: 3n,
  max_owner_concurrent_sessions: 3n,
  max_sessions_per_user: 3n,
  storage_bytes: 1_073_741_824n, // 1 GiB
};

async function main(): Promise<void> {
  const prisma = createPrismaClient({ connectionString: databaseUrlFromEnv() });
  try {
    await prisma.appMeta.upsert({
      where: { key: SCHEMA_BASELINE_KEY },
      create: { key: SCHEMA_BASELINE_KEY, value: 'phase-1' },
      update: { value: 'phase-1' },
    });

    // ── permission registry ────────────────────────────────────────────────
    for (const key of PHASE_1_TENANT_PERMISSIONS) {
      await prisma.permissionRegistry.upsert({
        where: { key },
        create: {
          key,
          realm: 'TENANT',
          groupKey: PERMISSION_GROUP_OF[key],
          description: humanize(key),
          addedInPhase: 1,
        },
        update: { realm: 'TENANT', groupKey: PERMISSION_GROUP_OF[key] },
      });
    }
    for (const key of PLATFORM_PERMISSIONS) {
      await prisma.permissionRegistry.upsert({
        where: { key },
        create: {
          key,
          realm: 'PLATFORM',
          groupKey: 'platform',
          description: humanize(key),
          addedInPhase: 1,
        },
        update: { realm: 'PLATFORM', groupKey: 'platform' },
      });
    }

    // ── Starter plan + published version ───────────────────────────────────
    const plan = await prisma.plan.upsert({
      where: { key: 'starter' },
      create: { key: 'starter', name: 'Starter', description: 'The default onboarding plan.' },
      update: { name: 'Starter' },
    });

    const existingVersion = await prisma.planVersion.findFirst({
      where: { planId: plan.id, version: 1 },
    });
    const planVersion =
      existingVersion ??
      (await prisma.planVersion.create({
        data: { planId: plan.id, version: 1, status: 'PUBLISHED', publishedAt: new Date() },
      }));

    for (const moduleKey of ENTITLEMENT_MODULES) {
      await prisma.entitlementDefault.upsert({
        where: { planVersionId_moduleKey: { planVersionId: planVersion.id, moduleKey } },
        create: { planVersionId: planVersion.id, moduleKey, enabled: false },
        update: {},
      });
    }
    for (const limitKey of LIMIT_KEYS) {
      await prisma.limitDefault.upsert({
        where: { planVersionId_limitKey: { planVersionId: planVersion.id, limitKey } },
        create: { planVersionId: planVersion.id, limitKey, value: STARTER_LIMITS[limitKey] },
        update: { value: STARTER_LIMITS[limitKey] },
      });
    }

    // ── dev platform super-admin (optional) ───────────────────────────────
    const adminEmail = process.env['SEED_PLATFORM_ADMIN_EMAIL'];
    if (adminEmail) {
      const superRole = await prisma.platformRole.upsert({
        where: { key: 'super_admin' },
        create: { key: 'super_admin', name: 'Super Admin', isSystem: true },
        update: {},
      });
      for (const permissionKey of PLATFORM_PERMISSIONS) {
        await prisma.platformRolePermission.upsert({
          where: {
            platformRoleId_permissionKey: { platformRoleId: superRole.id, permissionKey },
          },
          create: { platformRoleId: superRole.id, permissionKey },
          update: {},
        });
      }
      const admin = await prisma.platformUser.upsert({
        where: { email: adminEmail },
        create: { email: adminEmail, name: 'Platform Admin (dev seed)' },
        update: {},
      });
      await prisma.platformUserRole.upsert({
        where: {
          platformUserId_platformRoleId: {
            platformUserId: admin.id,
            platformRoleId: superRole.id,
          },
        },
        create: { platformUserId: admin.id, platformRoleId: superRole.id },
        update: {},
      });
      console.log(`seed: platform super-admin ${adminEmail} (no credential — set-password flow)`);
    }

    const [perms, modules, limits] = await Promise.all([
      prisma.permissionRegistry.count(),
      prisma.entitlementDefault.count({ where: { planVersionId: planVersion.id } }),
      prisma.limitDefault.count({ where: { planVersionId: planVersion.id } }),
    ]);
    console.log(
      `seed ok — permission_registry=${perms}, Starter v1 entitlements=${modules}, limits=${limits}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
