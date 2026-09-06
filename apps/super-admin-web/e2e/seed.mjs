import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import pg from 'pg';

const PLATFORM_PERMISSIONS = [
  'platform:tenants:view',
  'platform:tenants:manage',
  'platform:tenants:impersonate',
  'platform:plans:manage',
  'platform:entitlements:manage',
  'platform:limits:manage',
  'platform:tenant_users:manage',
  'platform:tenant_roles:manage',
  'platform:sessions:revoke',
  'platform:audit:view',
  'platform:secrets:manage',
  // task 3.1
  'platform:catalog_capability:manage',
];
const TENANT_KEYS = [
  'users:view',
  'users:manage',
  'roles:manage',
  'audit:view',
  'settings:branch:manage',
  'settings:tenant:manage',
];

/**
 * Seed the platform realm for the Super Admin smoke: the permission registry, a
 * published Starter plan version, and a Super Admin with a password credential
 * and a CONFIRMED TOTP factor. Returns the login material.
 */
export async function seedForSmoke(databaseUrl) {
  const email = 'smoke-admin@flower.test';
  const password = 'smoke-admin-pass-123456';
  const totpSecret = authenticator.generateSecret();
  const argon = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    for (const key of TENANT_KEYS) {
      await c.query(
        `INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
         VALUES ($1,'TENANT','admin',$1,1) ON CONFLICT (key) DO NOTHING`,
        [key],
      );
    }
    for (const key of PLATFORM_PERMISSIONS) {
      await c.query(
        `INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
         VALUES ($1,'PLATFORM','platform',$1,1) ON CONFLICT (key) DO NOTHING`,
        [key],
      );
    }

    // task 2.7 — provisioning resolves the company's country/currency inside
    // its own transaction; the smoke's "Provision a tenant" form defaults to
    // AE for both region and companyCountryCode.
    await c.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x')`,
    );
    await c.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
       VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', true, now())`,
    );

    // task 3.1 — a couple of Business-Type templates so the "Provision a tenant"
    // form's (required) Business Type selector has options and the snapshot runs.
    await c.query(`
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom / other', 'x', 'ACTIVE', now()),
             ('FLOWER_FLORIST', 1, 'Flower Shop / Florist', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey", "capabilityKey", enabled, "updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()),('CUSTOM','branch_pricing',true,now()),
             ('CUSTOM','channel.pos',true,now()),
             ('FLOWER_FLORIST','strategy.stocked',true,now()),('FLOWER_FLORIST','variants',true,now()),
             ('FLOWER_FLORIST','multi_uom',true,now()),('FLOWER_FLORIST','branch_pricing',true,now()),
             ('FLOWER_FLORIST','channel.pos',true,now()),('FLOWER_FLORIST','strategy.bom',true,now()),
             ('FLOWER_FLORIST','delivery',true,now());
    `);

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await c.query(
      `INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,'starter','Starter',now())`,
      [planId],
    );
    await c.query(
      `INSERT INTO plan_version (id,"planId",version,status,"publishedAt","updatedAt")
       VALUES ($1,$2,1,'PUBLISHED',now(),now())`,
      [planVersionId, planId],
    );
    for (const [limitKey, value] of [
      ['max_companies', 1],
      ['max_branches', 3],
      ['max_pos_terminals', 5],
      ['max_users', 10],
      ['max_sessions_per_user', 10],
    ]) {
      await c.query(
        `INSERT INTO limit_default ("planVersionId","limitKey",value) VALUES ($1,$2,$3)`,
        [planVersionId, limitKey, value],
      );
    }

    const roleId = randomUUID();
    await c.query(
      `INSERT INTO platform_role (id,key,name,"isSystem") VALUES ($1,'super_admin','Super Admin',true)`,
      [roleId],
    );
    for (const key of PLATFORM_PERMISSIONS) {
      await c.query(
        `INSERT INTO platform_role_permission ("platformRoleId","permissionKey") VALUES ($1,$2)`,
        [roleId, key],
      );
    }

    const userId = randomUUID();
    await c.query(
      `INSERT INTO platform_user (id,email,name,status,"updatedAt") VALUES ($1,$2,'Smoke Admin','ACTIVE',now())`,
      [userId, email],
    );
    await c.query(
      `INSERT INTO platform_credential ("platformUserId",hash,"updatedAt") VALUES ($1,$2,now())`,
      [userId, await hash(password, argon)],
    );
    await c.query(
      `INSERT INTO platform_mfa_factor ("platformUserId",kind,"secretRef",status,"confirmedAt")
       VALUES ($1,'TOTP',$2,'CONFIRMED',now())`,
      [userId, totpSecret],
    );
    await c.query(
      `INSERT INTO platform_user_role ("platformUserId","platformRoleId") VALUES ($1,$2)`,
      [userId, roleId],
    );

    return { email, password, totpSecret, planVersionId };
  } finally {
    await c.end();
  }
}
