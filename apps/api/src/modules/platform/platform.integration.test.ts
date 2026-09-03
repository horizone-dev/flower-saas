import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import pg from 'pg';
import { ConfigModule } from '../../config/config.module.js';
import { DbModule } from '../../common/db/db.module.js';
import { RedisModule } from '../../common/redis/redis.module.js';
import { SessionModule } from '../../common/auth/session.module.js';
import { PlatformModule } from './platform.module.js';
import { LimitService, LimitExceededError } from './limit.service.js';
import { EntitlementService } from './entitlement.service.js';
import { TenantConfigRepository } from './tenant-config.repository.js';

const TENANT = '00000000-0000-7000-8000-00000000f001';
const PLAN_V = '00000000-0000-7000-8000-00000000f002';
const COMPANY = '00000000-0000-7000-8000-00000000f003';

describe('platform: limits + entitlements (integration)', () => {
  let stack: TestStack;
  let limits: LimitService;
  let entitlements: EntitlementService;
  let config: TenantConfigRepository;
  let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    await seed(stack.postgres.url);

    process.env['DATABASE_URL'] = stack.postgres.url;
    process.env['PLATFORM_DATABASE_URL'] = stack.postgres.url;
    process.env['REDIS_URL'] = stack.redis.url;

    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DbModule, RedisModule, SessionModule, PlatformModule],
    }).compile();
    await moduleRef.init();
    limits = moduleRef.get(LimitService);
    entitlements = moduleRef.get(EntitlementService);
    config = moduleRef.get(TenantConfigRepository);
  }, 240_000);

  afterAll(async () => {
    await moduleRef?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL']) delete process.env[k];
  });

  it('LimitService blocks the (limit+1)th create at the boundary', async () => {
    // Starter: max_branches = 2. Seed already created 0 branches.
    await limits.assertWithin(TENANT, 'max_branches'); // 0 -> 1: ok
    await addBranch(stack.postgres.url, 'b1');
    await limits.assertWithin(TENANT, 'max_branches'); // 1 -> 2: ok
    await addBranch(stack.postgres.url, 'b2');
    await expect(limits.assertWithin(TENANT, 'max_branches')).rejects.toBeInstanceOf(
      LimitExceededError,
    );
  });

  it('a per-tenant override lifts the limit', async () => {
    await config.overrideLimit(
      TENANT,
      'max_branches',
      5n,
      'customer on an enterprise contract',
      null,
    );
    await limits.assertWithin(TENANT, 'max_branches'); // 2 -> 3, now under 5
  });

  it('concurrent-session cap: refuses a new session over max_sessions_per_user', async () => {
    // Starter seed sets max_sessions_per_user = 2
    const user = '00000000-0000-7000-8000-00000000f0aa';
    const soon = Date.now() + 60_000;
    await limits.recordSession(TENANT, user, 's1', soon);
    await limits.recordSession(TENANT, user, 's2', soon);
    await expect(limits.assertSessionWithin(TENANT, user)).rejects.toBeInstanceOf(
      LimitExceededError,
    );
    await limits.dropSession(TENANT, user, 's1');
    await limits.assertSessionWithin(TENANT, user); // back under the cap
  });

  it('EntitlementService reflects tenant_entitlement + invalidates its cache on change', async () => {
    expect((await entitlements.resolve(TENANT)).has('customer_web')).toBe(false);
    await entitlements.setEnabled(TENANT, 'customer_web', true);
    expect((await entitlements.resolve(TENANT)).has('customer_web')).toBe(true);
    await entitlements.setEnabled(TENANT, 'customer_web', false);
    expect((await entitlements.resolve(TENANT)).has('customer_web')).toBe(false);
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-00000000f000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-00000000f000', 1, 'PUBLISHED', now());
      INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
      VALUES ('${TENANT}', 'limtest', 'LimTest', 'AE', 'ACTIVE', '${PLAN_V}', now());
      INSERT INTO company (id, "tenantId", "legalNameEn", "updatedAt")
      VALUES ('${COMPANY}', '${TENANT}', 'LimTest Co', now());
      INSERT INTO tenant_limit ("tenantId", "limitKey", value, "updatedAt") VALUES
        ('${TENANT}', 'max_branches', 2, now()),
        ('${TENANT}', 'max_companies', 1, now()),
        ('${TENANT}', 'max_sessions_per_user', 2, now());
      INSERT INTO tenant_entitlement ("tenantId", "moduleKey", enabled, source, "updatedAt")
      VALUES ('${TENANT}', 'customer_web', false, 'DEFAULT', now());
    `);
  } finally {
    await c.end();
  }
}

async function addBranch(url: string, name: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO branch ("tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, now())`,
      [TENANT, COMPANY, name],
    );
  } finally {
    await c.end();
  }
}
