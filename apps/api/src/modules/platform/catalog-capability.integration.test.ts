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

  // ══ task 3.10 — POST /apply-business-type-template (re-apply) ══════════════
  describe('task 3.10 — apply-business-type-template re-apply', () => {
    let idemN = 0;
    const ik = (): string => `t310-apply-${String(++idemN).padStart(4, '0')}`;

    // Dedicated templates — no other test in this file touches these keys, so
    // their versions / rows are deterministic (BAKERY_CAKE is bumped to v9 by an
    // earlier test).
    beforeAll(async () => {
      await sql(`INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
                 VALUES ('T310_A', 1, 'A', 'x', 'ACTIVE', now()),
                        ('T310_B', 3, 'B', 'x', 'ACTIVE', now()),
                        ('T310_C', 1, 'C', 'x', 'ACTIVE', now())
                 ON CONFLICT (key) DO NOTHING`);
      await sql(`INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
                 VALUES ('T310_A','strategy.stocked',true,now()),
                        ('T310_A','branch_pricing',true,now()),
                        ('T310_A','channel.pos',true,now()),
                        ('T310_B','strategy.stocked',true,now()),
                        ('T310_B','strategy.bom',true,now()),
                        ('T310_B','channel.pos',true,now()),
                        ('T310_C','strategy.stocked',true,now()),
                        ('T310_C','branch_pricing',true,now()),
                        ('T310_C','channel.pos',true,now())
                 ON CONFLICT ("templateKey","capabilityKey") DO NOTHING`);
    });
    const applyTemplate = (
      tenantId: string,
      body: { templateKey: string; mode?: 'merge' | 'replace' },
      opts: { ifMatch?: string | null; idem?: string | null; tok?: string } = {},
    ) =>
      req(
        'POST',
        `/platform/tenants/${tenantId}/apply-business-type-template`,
        opts.tok ?? superTok,
        body,
        {
          ...(opts.ifMatch === null ? {} : { 'if-match': `"${opts.ifMatch ?? '1'}"` }),
          ...(opts.idem === null ? {} : { 'idempotency-key': opts.idem ?? ik() }),
        },
      );
    const capRows = (tenantId: string) =>
      sql<{
        capabilityKey: string;
        enabled: boolean;
        sourceKind: string;
        sourceTemplateKey: string | null;
        sourceTemplateVersion: number | null;
        overriddenAt: string | null;
      }>(
        `SELECT "capabilityKey", enabled, "sourceKind", "sourceTemplateKey",
                "sourceTemplateVersion", "overriddenAt"
           FROM tenant_catalog_capability WHERE "tenantId" = $1 ORDER BY "capabilityKey"`,
        [tenantId],
      );
    const tmplApplied = (tenantId: string) =>
      sql<{ reason: string }>(
        `SELECT reason FROM audit_log
          WHERE "tenantId" = $1 AND action = 'catalog.template_applied'
          ORDER BY "at" ASC`,
        [tenantId],
      );
    const tenantMeta = (tenantId: string) =>
      one<{ btk: string | null; bav: number | null; v: number }>(
        `SELECT "businessTypeKey" AS btk, "businessTypeAppliedVersion" AS bav,
                "catalogCapabilityVersion" AS v FROM tenant WHERE id = $1`,
        [tenantId],
      );

    it('11/12/13 — Idempotency-Key AND If-Match both required; missing/stale If-Match are deterministic', async () => {
      const t = await provision('t310-guards', 'T310_A');
      // missing Idempotency-Key -> 400
      const noIdem = await applyTemplate(
        t,
        { templateKey: 'T310_A' },
        { idem: null, ifMatch: '1' },
      );
      expect(noIdem.statusCode).toBe(400);
      expect((noIdem.json() as { error: { code: string } }).error.code).toBe(
        'IDEMPOTENCY_KEY_MISSING',
      );
      // missing If-Match -> 428
      const noIfMatch = await applyTemplate(t, { templateKey: 'T310_A' }, { ifMatch: null });
      expect(noIfMatch.statusCode).toBe(428);
      // stale If-Match -> 409, no write, no audit, version unchanged
      const beforeAudit = (await tmplApplied(t)).length;
      const stale = await applyTemplate(
        t,
        { templateKey: 'T310_A', mode: 'replace' },
        { ifMatch: '999' },
      );
      expect(stale.statusCode).toBe(409);
      expect((stale.json() as { error: { code: string } }).error.code).toBe(
        'CATALOG_CAPABILITY_VERSION_CONFLICT',
      );
      expect((await tmplApplied(t)).length).toBe(beforeAudit);
      expect((await tenantMeta(t)).v).toBe(1);
    });

    it('2/17/19 — merge of the SAME template at the same version is an EXACT no-op (no version bump, no audit, no outbox)', async () => {
      const t = await provision('t310-noop', 'T310_A');
      const v0 = (await tenantMeta(t)).v;
      const auditBefore = (await tmplApplied(t)).length;
      const outboxBefore = (
        await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM outbox WHERE "eventType" LIKE 'catalog.%'`,
        )
      )[0]!.n;
      const r = await applyTemplate(
        t,
        { templateKey: 'T310_A', mode: 'merge' },
        { ifMatch: String(v0) },
      );
      expect(r.statusCode, r.payload).toBe(200);
      expect(r.headers['etag']).toBe(`"${v0}"`);
      expect((await tenantMeta(t)).v).toBe(v0);
      expect((await tmplApplied(t)).length).toBe(auditBefore);
      expect(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM outbox WHERE "eventType" LIKE 'catalog.%'`,
          )
        )[0]!.n,
      ).toBe(outboxBefore);
    });

    it('3 — merge after a template VERSION bump refreshes TEMPLATE-provenance rows only, bumps once, one audit row', async () => {
      const t = await provision('t310-refresh', 'T310_C');
      // diverge one row manually so it becomes MANUAL
      await capsPATCH(t, String((await tenantMeta(t)).v), [
        { capabilityKey: 'channel.pos', enabled: false },
      ]);
      const vAfterPatch = (await tenantMeta(t)).v;
      // curator bumps CUSTOM v1 -> v2 and flips branch_pricing off + adds delivery
      await sql(`UPDATE business_type_template SET version = 2 WHERE key = 'T310_C'`);
      await sql(
        `UPDATE business_type_template_capability SET enabled = false
          WHERE "templateKey" = 'T310_C' AND "capabilityKey" = 'branch_pricing'`,
      );
      await sql(
        `INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
         VALUES ('T310_C','delivery',true, now())
         ON CONFLICT ("templateKey","capabilityKey") DO NOTHING`,
      );
      const auditBefore = (await tmplApplied(t)).length;
      const r = await applyTemplate(
        t,
        { templateKey: 'T310_C', mode: 'merge' },
        { ifMatch: String(vAfterPatch) },
      );
      expect(r.statusCode, r.payload).toBe(200);
      expect((await tenantMeta(t)).v).toBe(vAfterPatch + 1); // +1 exactly
      expect((await tmplApplied(t)).length).toBe(auditBefore + 1);

      const rows = new Map((await capRows(t)).map((x) => [x.capabilityKey, x]));
      // MANUAL row untouched (still disabled, still MANUAL)
      expect(rows.get('channel.pos')).toMatchObject({ enabled: false, sourceKind: 'MANUAL' });
      // TEMPLATE rows refreshed to v2 values
      expect(rows.get('branch_pricing')).toMatchObject({
        enabled: false,
        sourceKind: 'TEMPLATE',
        sourceTemplateVersion: 2,
      });
      expect(rows.get('delivery')).toMatchObject({ enabled: true, sourceKind: 'TEMPLATE' });
      // audit reason carries the template keys + versions (owner D-4)
      const reason = JSON.parse((await tmplApplied(t)).at(-1)!.reason) as Record<string, unknown>;
      expect(reason).toMatchObject({
        mode: 'merge',
        fromTemplateKey: 'T310_C',
        toTemplateKey: 'T310_C',
        toTemplateVersion: 2,
      });
      expect(reason['changedCapabilityKeys']).toEqual(
        expect.arrayContaining(['branch_pricing', 'delivery']),
      );
      expect(reason['changedCapabilityKeys']).not.toContain('channel.pos');
    });

    it('5/6 — replace overwrites a diverged MANUAL row + resets it to TEMPLATE provenance, clears overriddenAt', async () => {
      const t = await provision('t310-replace', 'T310_A');
      await capsPATCH(t, String((await tenantMeta(t)).v), [
        { capabilityKey: 'channel.pos', enabled: false },
      ]);
      const before = new Map((await capRows(t)).map((x) => [x.capabilityKey, x]));
      expect(before.get('channel.pos')).toMatchObject({ sourceKind: 'MANUAL' });
      expect(before.get('channel.pos')!.overriddenAt).not.toBeNull();

      const v = (await tenantMeta(t)).v;
      const r = await applyTemplate(
        t,
        { templateKey: 'T310_A', mode: 'replace' },
        { ifMatch: String(v) },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const after = new Map((await capRows(t)).map((x) => [x.capabilityKey, x]));
      expect(after.get('channel.pos')).toMatchObject({
        enabled: true, // back to the template value
        sourceKind: 'TEMPLATE',
        overriddenAt: null,
      });
    });

    it('7 — neither mode deletes a capability key absent from the target template', async () => {
      const t = await provision('t310-nodelete', 'T310_A');
      // give the tenant a MANUAL key not in ANY template
      await capsPATCH(t, String((await tenantMeta(t)).v), [
        { capabilityKey: 'inventory.expiry', enabled: true },
      ]);
      const v = (await tenantMeta(t)).v;
      await applyTemplate(t, { templateKey: 'T310_A', mode: 'replace' }, { ifMatch: String(v) });
      const rows = await capRows(t);
      expect(rows.map((x) => x.capabilityKey)).toContain('inventory.expiry');
    });

    it('8/9/10 — a DIFFERENT templateKey is allowed and re-stamps tenant.businessTypeKey; audit records from/to keys', async () => {
      const t = await provision('t310-switch', 'T310_A');
      expect((await tenantMeta(t)).btk).toBe('T310_A');
      const v = (await tenantMeta(t)).v;
      const r = await applyTemplate(
        t,
        { templateKey: 'T310_B', mode: 'merge' },
        { ifMatch: String(v) },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const meta = await tenantMeta(t);
      expect(meta.btk).toBe('T310_B');
      expect(meta.bav).toBe(3); // T310_B seed version
      expect(meta.v).toBe(v + 1);
      // T310_A-only keys (branch_pricing) are NOT deleted — additive
      const rows = (await capRows(t)).map((x) => x.capabilityKey);
      expect(rows).toContain('branch_pricing');
      expect(rows).toContain('strategy.bom'); // added by T310_B
      const reason = JSON.parse((await tmplApplied(t)).at(-1)!.reason) as Record<string, unknown>;
      expect(reason).toMatchObject({
        fromTemplateKey: 'T310_A',
        fromTemplateVersion: 1,
        toTemplateKey: 'T310_B',
        toTemplateVersion: 3,
      });
    });

    it('16 — an exact idempotent replay (same key) does NOT re-execute: no second version bump, no second audit row', async () => {
      const t = await provision('t310-idem', 'T310_A');
      const key = ik();
      const v = (await tenantMeta(t)).v;
      const r1 = await applyTemplate(
        t,
        { templateKey: 'T310_B', mode: 'merge' },
        { ifMatch: String(v), idem: key },
      );
      expect(r1.statusCode, r1.payload).toBe(200);
      const vAfter = (await tenantMeta(t)).v;
      const auditAfter = (await tmplApplied(t)).length;
      const r2 = await applyTemplate(
        t,
        { templateKey: 'T310_B', mode: 'merge' },
        { ifMatch: String(v), idem: key },
      );
      expect(r2.statusCode).toBe(200);
      expect(r2.json()).toEqual(r1.json()); // replayed response
      expect((await tenantMeta(t)).v).toBe(vAfter);
      expect((await tmplApplied(t)).length).toBe(auditAfter);
    });

    // ═══ owner strict-review fix — idempotency fingerprint (canonical mutation
    // identity = tenant + principal + {templateKey, mode}, via the shared
    // `requestHash` primitive) ═══════════════════════════════════════════════
    it('idempotency fingerprint — same key + same request replays the cached response WITHOUT revalidating the original If-Match against the now-advanced DB version', async () => {
      const t = await provision('t310-fp-same', 'T310_A');
      const key = ik();
      const v1 = (await tenantMeta(t)).v; // 1
      const first = await applyTemplate(
        t,
        { templateKey: 'T310_C', mode: 'merge' },
        { ifMatch: String(v1), idem: key },
      );
      expect(first.statusCode, first.payload).toBe(200);
      const v2 = (await tenantMeta(t)).v; // 2
      expect(v2).toBe(v1 + 1);

      // advance the DB version further via an UNRELATED mutation (a different
      // idempotency key) — the cached replay's original If-Match ("1") is now
      // stale against the live aggregate, which is exactly what must NOT matter.
      const advance = await applyTemplate(
        t,
        { templateKey: 'T310_A', mode: 'replace' },
        { ifMatch: String(v2), idem: ik() },
      );
      expect(advance.statusCode, advance.payload).toBe(200);
      const v3 = (await tenantMeta(t)).v; // 3
      expect(v3).toBe(v2 + 1);
      const auditBeforeReplay = (await tmplApplied(t)).length;

      // exact same key + exact same body + the ORIGINAL (now doubly-stale)
      // If-Match a naive client retry would resend.
      const replay = await applyTemplate(
        t,
        { templateKey: 'T310_C', mode: 'merge' },
        { ifMatch: String(v1), idem: key },
      );
      expect(replay.statusCode, replay.payload).toBe(200); // NOT 409
      expect(replay.json()).toEqual(first.json()); // the cached v2 response, verbatim
      expect((await tenantMeta(t)).v).toBe(v3); // DB untouched by the replay
      expect((await tmplApplied(t)).length).toBe(auditBeforeReplay); // no new audit row
    });

    it('idempotency fingerprint — same key + a DIFFERENT canonical request (templateKey/mode) is a deterministic 409, never the previous cached response', async () => {
      const t = await provision('t310-fp-diff', 'T310_A');
      const key = ik();
      const v1 = (await tenantMeta(t)).v;
      const first = await applyTemplate(
        t,
        { templateKey: 'T310_A', mode: 'merge' },
        { ifMatch: String(v1), idem: key },
      );
      expect(first.statusCode, first.payload).toBe(200);
      const v2 = (await tenantMeta(t)).v;
      const auditAfterFirst = (await tmplApplied(t)).length;

      // same key, DIFFERENT templateKey — a different canonical request.
      const diffTemplate = await applyTemplate(
        t,
        { templateKey: 'T310_B', mode: 'merge' },
        { ifMatch: String(v2), idem: key },
      );
      expect(diffTemplate.statusCode).toBe(409);
      expect((diffTemplate.json() as { error: { code: string } }).error.code).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
      expect(diffTemplate.json()).not.toEqual(first.json());

      // same key, same templateKey, DIFFERENT mode — also a different request.
      const diffMode = await applyTemplate(
        t,
        { templateKey: 'T310_A', mode: 'replace' },
        { ifMatch: String(v2), idem: key },
      );
      expect(diffMode.statusCode).toBe(409);
      expect((diffMode.json() as { error: { code: string } }).error.code).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );

      // neither rejected replay mutated anything.
      expect((await tenantMeta(t)).v).toBe(v2);
      expect((await tmplApplied(t)).length).toBe(auditAfterFirst);
    });

    it('idempotency fingerprint — a FRESH key with a stale If-Match still gets a deterministic 409 CATALOG_CAPABILITY_VERSION_CONFLICT', async () => {
      const t = await provision('t310-fp-fresh-stale', 'T310_A');
      const v1 = (await tenantMeta(t)).v;
      const bump = await applyTemplate(
        t,
        { templateKey: 'T310_C', mode: 'merge' },
        { ifMatch: String(v1), idem: ik() },
      );
      expect(bump.statusCode, bump.payload).toBe(200);
      const v2 = (await tenantMeta(t)).v;
      expect(v2).toBe(v1 + 1);

      // a brand-new idempotency key (never seen before) — no cache entry exists,
      // so this must reach `repo.reapply()` directly and fail its own If-Match
      // check against the now-current version.
      const freshStale = await applyTemplate(
        t,
        { templateKey: 'T310_A', mode: 'merge' },
        { ifMatch: String(v1), idem: ik() },
      );
      expect(freshStale.statusCode).toBe(409);
      expect((freshStale.json() as { error: { code: string } }).error.code).toBe(
        'CATALOG_CAPABILITY_VERSION_CONFLICT',
      );
      expect((await tenantMeta(t)).v).toBe(v2); // unchanged
    });

    it('20/21 — requires platform:catalog_capability:manage + fresh step-up; a tenant Owner cannot reach it', async () => {
      const t = await provision('t310-authz', 'T310_A');
      const noStepUp = await mintPlatform('t310-nsu', false, [...PLATFORM_PERMISSIONS]);
      const r1 = await applyTemplate(t, { templateKey: 'T310_A' }, { tok: noStepUp, ifMatch: '1' });
      expect(r1.statusCode).toBe(403);
      const weak = await mintPlatform('t310-weak', true, ['platform:tenants:view']);
      const r2 = await applyTemplate(t, { templateKey: 'T310_A' }, { tok: weak, ifMatch: '1' });
      expect(r2.statusCode).toBe(403);
      const owner = await mintTenant('t310-owner', t, ['catalog:view']);
      const r3 = await applyTemplate(t, { templateKey: 'T310_A' }, { tok: owner, ifMatch: '1' });
      expect([401, 403]).toContain(r3.statusCode);
    });

    it('1 — a DEPRECATED / unknown template is rejected 422; no partial write', async () => {
      const t = await provision('t310-badtmpl', 'T310_A');
      await sql(`INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
                 VALUES ('T310_DEP', 1, 'x', 'x', 'DEPRECATED', now()) ON CONFLICT (key) DO NOTHING`);
      const v = (await tenantMeta(t)).v;
      const dep = await applyTemplate(t, { templateKey: 'T310_DEP' }, { ifMatch: String(v) });
      expect(dep.statusCode).toBe(422);
      expect((dep.json() as { error: { code: string } }).error.code).toBe(
        'BUSINESS_TYPE_NOT_ACTIVE',
      );
      const unk = await applyTemplate(t, { templateKey: 'NOPE_NOT_REAL' }, { ifMatch: String(v) });
      expect(unk.statusCode).toBe(422);
      expect((unk.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_BUSINESS_TYPE');
      expect((await tenantMeta(t)).v).toBe(v); // unchanged
    });

    it('14 — a concurrent PATCH vs re-apply serialises (no lost update)', async () => {
      const t = await provision('t310-concur', 'T310_A');
      const v = (await tenantMeta(t)).v;
      const [a, b] = await Promise.all([
        applyTemplate(t, { templateKey: 'T310_B', mode: 'merge' }, { ifMatch: String(v) }),
        capsPATCH(t, String(v), [{ capabilityKey: 'multi_uom', enabled: true }]),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      // one wins (200), the other sees the bumped version (409)
      expect(codes).toEqual([200, 409]);
      expect((await tenantMeta(t)).v).toBe(v + 1);
    });

    it('19 — a re-apply writes ZERO catalog outbox rows (owner D-2)', async () => {
      const t = await provision('t310-noevent', 'T310_A');
      const before = (
        await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM outbox WHERE "eventType" LIKE 'catalog.%'`,
        )
      )[0]!.n;
      await applyTemplate(
        t,
        { templateKey: 'T310_B', mode: 'replace' },
        {
          ifMatch: String((await tenantMeta(t)).v),
        },
      );
      expect(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM outbox WHERE "eventType" LIKE 'catalog.%'`,
          )
        )[0]!.n,
      ).toBe(before);
    });

    it('25 — no catalog-entity seed table / template_payload exists (owner D-7)', async () => {
      const tables = await sql<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE 'business_type_template%'`,
      );
      expect(tables.map((r) => r.table_name).sort()).toEqual([
        'business_type_template',
        'business_type_template_capability',
      ]);
      const cols = await sql<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'business_type_template'`,
      );
      expect(cols.map((c) => c.column_name)).not.toContain('template_payload');
    });
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
