/**
 * Phase 1 + Phase 2-core (task 2.7) seed. Idempotent. Seeds only what the
 * platform realm needs to exist before any tenant is provisioned:
 *   - the `permission_registry` (the Phase 1 tenant subset + the platform realm)
 *   - a `Starter` plan + a published plan version with entitlement/limit defaults
 *   - the GCC localization/fiscal reference data (`country`/`currency`/
 *     `country_tax_config`/`tax_category`/`tax_rate`/`locale`/`holiday`) —
 *     see `gcc-reference-data.ts` and `docs/phase-2/GCC-FISCAL-REFERENCE.md`
 *     for sources, verification dates and known limitations
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
import {
  GCC_COUNTRIES,
  GCC_CURRENCIES,
  GCC_TAX_CONFIGS,
  TAX_CATEGORIES,
  GCC_TAX_RATES,
  LOCALES,
  GCC_HOLIDAYS_2026,
} from './gcc-reference-data.js';

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

    // ── GCC localization/fiscal reference data (task 2.7) ──────────────────
    // Platform-global, RLS-exempt (no tenant_id). Idempotent: `Country`/
    // `Currency`/`Locale`/`TaxCategory` have a real `@id` and use `upsert`;
    // `CountryTaxConfig`/`TaxRate`/`Holiday` have no unique constraint beyond
    // their own generated `id` (by design — they are effective-dated ranges,
    // not natural-key rows), so idempotency is a find-by-natural-key-then-
    // create-if-missing check instead of a DB-level upsert.
    for (const currency of GCC_CURRENCIES) {
      await prisma.currency.upsert({
        where: { code: currency.code },
        create: currency,
        update: {
          exponent: currency.exponent,
          symbol: currency.symbol,
          nameEn: currency.nameEn,
          nameAr: currency.nameAr,
        },
      });
    }
    for (const country of GCC_COUNTRIES) {
      await prisma.country.upsert({
        where: { code: country.code },
        create: country,
        update: {
          nameEn: country.nameEn,
          nameAr: country.nameAr,
          region: country.region,
          defaultCurrencyCode: country.defaultCurrencyCode,
          weekendModel: country.weekendModel,
          active: country.active,
        },
      });
    }
    for (const category of TAX_CATEGORIES) {
      await prisma.taxCategory.upsert({
        where: { key: category.key },
        create: category,
        update: {
          nameEn: category.nameEn,
          nameAr: category.nameAr,
          description: category.description,
        },
      });
    }
    for (const locale of LOCALES) {
      await prisma.locale.upsert({
        where: { code: locale.code },
        create: locale,
        update: { nameEn: locale.nameEn, nameAr: locale.nameAr, direction: locale.direction },
      });
    }
    for (const cfg of GCC_TAX_CONFIGS) {
      const exists = await prisma.countryTaxConfig.findFirst({
        where: {
          countryCode: cfg.countryCode,
          effectiveFrom: new Date(cfg.effectiveFrom),
          regime: cfg.regime,
        },
        select: { id: true },
      });
      if (!exists) {
        await prisma.countryTaxConfig.create({
          data: {
            countryCode: cfg.countryCode,
            effectiveFrom: new Date(cfg.effectiveFrom),
            effectiveTo: cfg.effectiveTo ? new Date(cfg.effectiveTo) : null,
            regime: cfg.regime,
          },
        });
      }
    }
    for (const rate of GCC_TAX_RATES) {
      const exists = await prisma.taxRate.findFirst({
        where: {
          countryCode: rate.countryCode,
          taxCategoryKey: rate.taxCategoryKey,
          effectiveFrom: new Date(rate.effectiveFrom),
        },
        select: { id: true },
      });
      if (!exists) {
        await prisma.taxRate.create({
          data: {
            countryCode: rate.countryCode,
            taxCategoryKey: rate.taxCategoryKey,
            rateBps: rate.rateBps,
            effectiveFrom: new Date(rate.effectiveFrom),
            effectiveTo: rate.effectiveTo ? new Date(rate.effectiveTo) : null,
          },
        });
      }
    }
    for (const holiday of GCC_HOLIDAYS_2026) {
      const exists = await prisma.holiday.findFirst({
        where: {
          countryCode: holiday.countryCode,
          onDate: new Date(holiday.onDate),
          nameEn: holiday.nameEn,
        },
        select: { id: true },
      });
      if (!exists) {
        await prisma.holiday.create({
          data: {
            countryCode: holiday.countryCode,
            onDate: new Date(holiday.onDate),
            nameEn: holiday.nameEn,
            nameAr: holiday.nameAr,
            kind: holiday.kind,
          },
        });
      }
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

    const [perms, modules, limits, countries, currencies] = await Promise.all([
      prisma.permissionRegistry.count(),
      prisma.entitlementDefault.count({ where: { planVersionId: planVersion.id } }),
      prisma.limitDefault.count({ where: { planVersionId: planVersion.id } }),
      prisma.country.count(),
      prisma.currency.count(),
    ]);
    console.log(
      `seed ok — permission_registry=${perms}, Starter v1 entitlements=${modules}, limits=${limits}, ` +
        `countries=${countries}, currencies=${currencies}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
