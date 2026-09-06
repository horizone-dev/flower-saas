import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { PLATFORM_PERMISSIONS } from '@flower/permissions';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-000000310001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000310002';

/**
 * Task 3.1 — the Super-Admin catalog-capability configuration surface + the
 * runtime read. Covers spec §16: RLS, `flower_app` denials, tenant isolation,
 * aggregate concurrency (If-Match / 428 / 409 / no-op), provenance transitions,
 * template-snapshot immutability, entitlement independence, audit, permission /
 * step-up behaviour, config rejection.
 */
describe('catalog capability configuration surface (task 3.1, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let tenantB = '';
  let superTok = '';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    await seed(stack.postgres.url);

    process.env['DATABASE_URL'] = stack.postgres.url;
    process.env['PLATFORM_DATABASE_URL'] = stack.postgres.url;
    process.env['REDIS_URL'] = stack.redis.url;
    process.env['AUTH_JWT_SECRET'] = 'integration-test-jwt-secret-0000000000';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    installRequestContext(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwt = app.get(JwtService);
    store = app.get(SessionStore);

    superTok = await mintPlatform('super', true, [...PLATFORM_PERMISSIONS]);
    tenantA = await provision('cap-a', 'BAKERY_CAKE');
    tenantB = await provision('cap-b', 'CUSTOM');
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  function base(sessionId: string, realm: 'tenant' | 'platform'): SessionData {
    return {
      sessionId,
      realm,
      familyId: 'f',
      tenantId: null,
      userId: null,
      platformUserId: null,
      accountType: 'USER',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'NONE',
      stepUpUntil: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: null,
    };
  }

  async function mintPlatform(id: string, stepUp: boolean, perms: string[]): Promise<string> {
    const s = base(`plat-${id}`, 'platform');
    s.platformUserId = PLATFORM_USER;
    s.accountType = 'PLATFORM';
    s.mfaLevel = stepUp ? 'STEP_UP' : 'MFA';
    s.stepUpUntil = stepUp ? Date.now() + 600_000 : null;
    s.access = {
      effectivePermissions: perms,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: PLATFORM_USER, sid: s.sessionId, aud: 'platform' });
  }

  async function mintTenant(id: string, forTenant: string, perms: string[]): Promise<string> {
    const s = base(`ten-${id}`, 'tenant');
    s.tenantId = forTenant;
    s.userId = '00000000-0000-7000-8000-0000003100ff';
    s.accountType = 'OWNER';
    s.access = {
      effectivePermissions: perms,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: s.userId, sid: s.sessionId, aud: 'tenant', tid: forTenant });
  }

  const req = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    token: string | null,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: `/v1${url}`,
      ...(token ? { headers: { authorization: `Bearer ${token}`, ...headers } } : { headers }),
      ...(body ? { payload: body } : {}),
    });

  async function provision(slug: string, key: string): Promise<string> {
    const res = await req(
      'POST',
      '/platform/tenants',
      superTok,
      {
        slug,
        name: slug,
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: key,
        planVersionId: PLAN_V,
        ownerEmail: `owner@${slug}.test`,
      },
      { 'idempotency-key': `prov-${slug}` },
    );
    expect(res.statusCode, res.payload).toBe(201);
    return (res.json() as { tenantId: string }).tenantId;
  }

  async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      return (await c.query(text, params)).rows as T[];
    } finally {
      await c.end();
    }
  }
  const one = async <T>(text: string, params: unknown[] = []): Promise<T> => {
    const rows = await sql<T>(text, params);
    if (rows[0] === undefined) throw new Error(`no rows: ${text}`);
    return rows[0];
  };
  const version = (t: string): Promise<number> =>
    one<{ v: number }>(`SELECT "catalogCapabilityVersion" AS v FROM tenant WHERE id=$1`, [t]).then(
      (r) => r.v,
    );
  const auditCount = (t: string): Promise<number> =>
    one<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId"=$1 AND action='tenant.catalog_capability_changed'`,
      [t],
    ).then((r) => r.n);

  const capsGET = (tenantId: string, tok = superTok) =>
    req('GET', `/platform/tenants/${tenantId}/catalog-capabilities`, tok);
  const capsPATCH = (
    tenantId: string,
    ifMatch: string | null,
    changes: unknown[],
    reason?: string,
    tok = superTok,
  ) =>
    req(
      'PATCH',
      `/platform/tenants/${tenantId}/catalog-capabilities`,
      tok,
      reason !== undefined ? { changes, reason } : { changes },
      ifMatch === null ? {} : { 'if-match': `"${ifMatch}"` },
    );

  // ── templates (spec §K.1) — the full 35-preset seed is proven in
  //    packages/db seed.integration.test.ts; here we check the API shape. ────
  it('GET /v1/platform/business-type-templates returns each seeded preset + its capability rows, config null', async () => {
    const res = await req('GET', '/platform/business-type-templates', superTok);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { key: string; capabilities: { capabilityKey: string; config: unknown }[] }[];
    };
    expect(body.data.map((t) => t.key).sort()).toEqual(['BAKERY_CAKE', 'CUSTOM']);
    const custom = body.data.find((t) => t.key === 'CUSTOM');
    expect(custom?.capabilities.map((c) => c.capabilityKey).sort()).toEqual(
      ['branch_pricing', 'channel.pos', 'strategy.stocked'].sort(),
    );
    expect(body.data.every((t) => t.capabilities.every((c) => c.config === null))).toBe(true);
  });

  // ── permission / step-up (owner R-7) ─────────────────────────────────────
  it('GET tenant caps: no step-up needed; ETag mirrors aggregateVersion', async () => {
    const noStepUp = await mintPlatform('nsu', false, [...PLATFORM_PERMISSIONS]);
    const res = await capsGET(tenantA, noStepUp);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { aggregateVersion: number };
    expect(res.headers.etag).toBe(`"${body.aggregateVersion}"`);
  });

  it('GET tenant caps: without the permission -> 403', async () => {
    const weak = await mintPlatform('weak', true, ['platform:tenants:view']);
    expect((await capsGET(tenantA, weak)).statusCode).toBe(403);
  });

  it('PATCH requires fresh step-up -> 403 STEP_UP_REQUIRED', async () => {
    const noStepUp = await mintPlatform('nsu2', false, [...PLATFORM_PERMISSIONS]);
    const res = await capsPATCH(
      tenantA,
      '1',
      [{ capabilityKey: 'multi_uom', enabled: false }],
      undefined,
      noStepUp,
    );
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('STEP_UP_REQUIRED');
  });

  // ── aggregate concurrency (spec §L) ─────────────────────────────────────
  it('the provisioning snapshot set aggregateVersion = 1', async () => {
    expect(await version(tenantA)).toBe(1);
    const res = await capsGET(tenantA);
    expect((res.json() as { aggregateVersion: number }).aggregateVersion).toBe(1);
  });

  it('PATCH without If-Match -> 428; stale If-Match -> 409, no row change, no audit row', async () => {
    expect(
      (await capsPATCH(tenantA, null, [{ capabilityKey: 'multi_uom', enabled: false }])).statusCode,
    ).toBe(428);

    const auditBefore = await auditCount(tenantA);
    const stale = await capsPATCH(tenantA, '999', [{ capabilityKey: 'multi_uom', enabled: false }]);
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe(
      'CATALOG_CAPABILITY_VERSION_CONFLICT',
    );
    expect(await version(tenantA)).toBe(1);
    expect(await auditCount(tenantA)).toBe(auditBefore);
  });

  it('PATCH: a real change -> MANUAL + overriddenAt, version +1, one audit row with before/after', async () => {
    const res = await capsPATCH(
      tenantA,
      '1',
      [{ capabilityKey: 'strategy.bom', enabled: false }],
      'onboarding',
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { aggregateVersion: number };
    expect(body.aggregateVersion).toBe(2);
    expect(res.headers.etag).toBe('"2"');

    const row = await one<{
      enabled: boolean;
      sourceKind: string;
      overriddenAt: string | null;
      sourceTemplateKey: string | null;
      sourceTemplateVersion: number | null;
    }>(
      `SELECT enabled, "sourceKind", "overriddenAt", "sourceTemplateKey", "sourceTemplateVersion"
         FROM tenant_catalog_capability WHERE "tenantId"=$1 AND "capabilityKey"='strategy.bom'`,
      [tenantA],
    );
    expect(row.enabled).toBe(false);
    expect(row.sourceKind).toBe('MANUAL');
    expect(row.overriddenAt).not.toBeNull();
    expect(row.sourceTemplateKey).toBe('BAKERY_CAKE'); // provenance retained (§H.2)
    expect(row.sourceTemplateVersion).toBe(2);

    const audit = await one<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE "tenantId"=$1 AND action='tenant.catalog_capability_changed' ORDER BY at DESC LIMIT 1`,
      [tenantA],
    );
    expect(JSON.parse(audit.reason)).toMatchObject({
      reason: 'onboarding',
      aggregateVersionFrom: 1,
      aggregateVersionTo: 2,
      changes: [{ capabilityKey: 'strategy.bom', enabledFrom: true, enabledTo: false }],
    });
  });

  it('PATCH: an all-no-op request -> 200, no version bump, no audit row', async () => {
    const before = await version(tenantA);
    const auditBefore = await auditCount(tenantA);
    const res = await capsPATCH(tenantA, String(before), [
      { capabilityKey: 'strategy.bom', enabled: false }, // already false
    ]);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { aggregateVersion: number }).aggregateVersion).toBe(before);
    expect(await version(tenantA)).toBe(before);
    expect(await auditCount(tenantA)).toBe(auditBefore);
  });

  it('PATCH: a capability the template never granted -> new MANUAL row, null source*/appliedAt', async () => {
    const res = await capsPATCH(tenantB, String(await version(tenantB)), [
      { capabilityKey: 'delivery', enabled: true },
    ]);
    expect(res.statusCode).toBe(200);
    const row = await one<{
      sourceKind: string;
      sourceTemplateKey: string | null;
      appliedAt: string | null;
      overriddenAt: string | null;
    }>(
      `SELECT "sourceKind", "sourceTemplateKey", "appliedAt", "overriddenAt"
         FROM tenant_catalog_capability WHERE "tenantId"=$1 AND "capabilityKey"='delivery'`,
      [tenantB],
    );
    expect(row).toMatchObject({
      sourceKind: 'MANUAL',
      sourceTemplateKey: null,
      appliedAt: null,
      overriddenAt: null,
    });
  });

  it('PATCH: non-null config for an unregistered key -> 422 CAPABILITY_CONFIG_NOT_SUPPORTED, nothing persisted', async () => {
    const cur = String(await version(tenantB));
    const bad = await capsPATCH(tenantB, cur, [
      { capabilityKey: 'inventory.expiry', enabled: true, config: { policy: 'FEFO' } },
    ]);
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { error: { code: string } }).error.code).toBe(
      'CAPABILITY_CONFIG_NOT_SUPPORTED',
    );
    expect(
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM tenant_catalog_capability WHERE "tenantId"=$1 AND "capabilityKey"='inventory.expiry'`,
          [tenantB],
        )
      ).n,
    ).toBe(0);
  });

  it('concurrency: two PATCHes with the same If-Match — one 200, one 409, exactly one increment', async () => {
    const cur = String(await version(tenantB));
    const [r1, r2] = await Promise.all([
      capsPATCH(tenantB, cur, [{ capabilityKey: 'variants', enabled: true }]),
      capsPATCH(tenantB, cur, [{ capabilityKey: 'multi_uom', enabled: true }]),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    expect(await version(tenantB)).toBe(Number(cur) + 1);
  });

  // ── template snapshot immutability + entitlement independence ────────────
  it('editing a global template does NOT mutate an already-applied tenant (HG3-TEMPLATE-SNAPSHOT)', async () => {
    const before = await sql<{ capabilityKey: string; enabled: boolean; sourceKind: string }>(
      `SELECT "capabilityKey", enabled, "sourceKind" FROM tenant_catalog_capability WHERE "tenantId"=$1 ORDER BY 1`,
      [tenantA],
    );
    await sql(`UPDATE business_type_template SET version = 9 WHERE key = 'BAKERY_CAKE'`);
    await sql(
      `INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
       VALUES ('BAKERY_CAKE','delivery',true, now())
       ON CONFLICT ("templateKey","capabilityKey") DO NOTHING`,
    );
    const after = await sql<{ capabilityKey: string; enabled: boolean; sourceKind: string }>(
      `SELECT "capabilityKey", enabled, "sourceKind" FROM tenant_catalog_capability WHERE "tenantId"=$1 ORDER BY 1`,
      [tenantA],
    );
    expect(after).toEqual(before);
    expect(
      (
        await one<{ v: number }>(
          `SELECT "businessTypeAppliedVersion" AS v FROM tenant WHERE id=$1`,
          [tenantA],
        )
      ).v,
    ).toBe(2);
  });

  it('no catalog operation ever wrote tenant_entitlement (HG3-1-ENTITLEMENT-INDEPENDENCE)', async () => {
    const rows = await sql(
      `SELECT 1 FROM tenant_entitlement WHERE "tenantId"=$1 AND source <> 'DEFAULT'`,
      [tenantA],
    );
    expect(rows).toEqual([]);
  });

  // ── RLS + flower_app denials (spec §N) ──────────────────────────────────
  it('flower_app cannot write any of the three configuration tables', async () => {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(`SET ROLE flower_app`);
      await expect(
        c.query(
          `INSERT INTO business_type_template (key, version, "nameEn", "nameAr", "updatedAt") VALUES ('X',1,'x','x',now())`,
        ),
      ).rejects.toThrow(/permission denied/i);
      await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantA]);
      await expect(
        c.query(
          `INSERT INTO tenant_catalog_capability ("tenantId","capabilityKey",enabled,"sourceKind","updatedAt")
           VALUES ($1,'variants',true,'MANUAL',now())`,
          [tenantA],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      await c.query(`SELECT set_config('app.tenant_id','',false)`).catch(() => {});
      await c.end();
    }
  });

  it('tenant_catalog_capability: no-GUC read -> 0 rows; tenant B never sees tenant A rows', async () => {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(`SET ROLE flower_app`);
      const noGuc = await c.query(`SELECT count(*)::int AS n FROM tenant_catalog_capability`);
      expect(Number((noGuc.rows[0] as { n: number }).n)).toBe(0);
      await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantB]);
      const scoped = await c.query(`SELECT "tenantId" FROM tenant_catalog_capability`);
      const ids = (scoped.rows as { tenantId: string }[]).map((r) => r.tenantId);
      expect(ids.every((id) => id === tenantB)).toBe(true);
      expect(ids).not.toContain(tenantA);
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      await c.query(`SELECT set_config('app.tenant_id','',false)`).catch(() => {});
      await c.end();
    }
  });

  // ── tenant-realm read (spec §K.4) ──────────────────────────────────────
  it('GET /v1/catalog/capabilities: caller tenant only, 16 keys, inert from entitlements, thin', async () => {
    const ownerB = await mintTenant('b', tenantB, ['catalog:view']);
    const res = await req('GET', '/catalog/capabilities', ownerB);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      businessTypeKey: string;
      aggregateVersion: number;
      capabilities: {
        capabilityKey: string;
        enabled: boolean;
        inert: boolean;
        sourceKind?: string;
      }[];
    };
    expect(body.businessTypeKey).toBe('CUSTOM');
    expect(body.aggregateVersion).toBeGreaterThanOrEqual(1);
    expect(body.capabilities).toHaveLength(16);
    const del = body.capabilities.find((c) => c.capabilityKey === 'delivery');
    expect(del).toMatchObject({ enabled: true, inert: true });
    expect(del?.sourceKind).toBeUndefined(); // thin — no provenance
    expect(JSON.stringify(body)).not.toContain(tenantA);
  });

  it('GET /v1/catalog/capabilities without catalog:view -> 403', async () => {
    const ownerB = await mintTenant('b2', tenantB, ['users:view']);
    expect((await req('GET', '/catalog/capabilities', ownerB)).statusCode).toBe(403);
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000310000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000310000', 1, 'PUBLISHED', now());
      INSERT INTO entitlement_default ("planVersionId", "moduleKey", enabled)
      VALUES ('${PLAN_V}', 'production_bom', false), ('${PLAN_V}', 'delivery', false),
             ('${PLAN_V}', 'customer_web', false), ('${PLAN_V}', 'advanced_inventory', false),
             ('${PLAN_V}', 'custom_composition', false);
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 20),
             ('${PLAN_V}', 'max_users', 20), ('${PLAN_V}', 'max_companies', 5);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',1),('users:view','TENANT','admin','v',1),
             ('platform:tenants:view','PLATFORM','platform','v',1),
             ('platform:catalog_capability:manage','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now()),
             ('BAKERY_CAKE', 2, 'Bakery', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()),('CUSTOM','branch_pricing',true,now()),
             ('CUSTOM','channel.pos',true,now()),
             ('BAKERY_CAKE','strategy.stocked',true,now()),('BAKERY_CAKE','strategy.bom',true,now()),
             ('BAKERY_CAKE','channel.pos',true,now()),('BAKERY_CAKE','multi_uom',true,now());
    `);
  } finally {
    await c.end();
  }
}
