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
import { assertEveryRouteDeclaresIntent } from '../../common/auth/route-coverage.js';
import type { SessionData } from '../../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-0000000e0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000000e0002';

describe('tenant provisioning + lifecycle + impersonation (integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;

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
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  async function platformToken(): Promise<string> {
    const s: SessionData = {
      sessionId: 'plat-1',
      realm: 'platform',
      familyId: 'f',
      tenantId: null,
      userId: null,
      platformUserId: PLATFORM_USER,
      accountType: 'PLATFORM',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'STEP_UP',
      stepUpUntil: Date.now() + 600_000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: {
        effectivePermissions: [...PLATFORM_PERMISSIONS],
        companyScope: 'ALL',
        branchScope: 'ALL',
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    };
    await store.set(s);
    return jwt.sign({ sub: PLATFORM_USER, sid: s.sessionId, aud: 'platform' });
  }

  const post = (
    url: string,
    body: Record<string, unknown>,
    token: string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1${url}`,
      payload: body,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  const del = (url: string, token: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('every mapped route declares a permission or @Public (G8)', () => {
    expect(() => assertEveryRouteDeclaresIntent(app)).not.toThrow();
  });

  let tenantId: string;
  let setPwToken: string;

  it('provisions a tenant in one transaction: roles, org, owner, snapshot, audit, outbox', async () => {
    const token = await platformToken();
    const res = await post(
      '/platform/tenants',
      {
        slug: 'acme-corp',
        name: 'Acme Corp',
        region: 'AE',
        companyCountryCode: 'AE',
        planVersionId: PLAN_V,
        ownerEmail: 'boss@acme.test',
      },
      token,
      { 'idempotency-key': 'prov-abc' },
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    tenantId = body.tenantId;
    setPwToken = body.setPasswordToken;
    expect(typeof setPwToken).toBe('string');

    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const q = (sql: string, params: unknown[] = []) => c.query(sql, params).then((r) => r.rows);
      expect((await q(`SELECT status FROM tenant WHERE id=$1`, [tenantId]))[0].status).toBe(
        'ACTIVE',
      );
      expect(
        Number((await q(`SELECT count(*) FROM role WHERE "tenantId"=$1`, [tenantId]))[0].count),
      ).toBe(13);
      expect(
        Number((await q(`SELECT count(*) FROM branch WHERE "tenantId"=$1`, [tenantId]))[0].count),
      ).toBe(1);
      expect(
        Number(
          (await q(`SELECT count(*) FROM pos_terminal WHERE "tenantId"=$1`, [tenantId]))[0].count,
        ),
      ).toBe(1);
      expect(
        (await q(`SELECT "accountType" FROM "user" WHERE "tenantId"=$1`, [tenantId]))[0]
          .accountType,
      ).toBe('OWNER');
      const actions = (
        await q(`SELECT action FROM audit_log WHERE "tenantId"=$1 ORDER BY action`, [tenantId])
      ).map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'branch.created',
          'company.created',
          'pos_terminal.created',
          'tenant.created',
          'user.created',
        ]),
      );
      const outbox = await q(`SELECT "eventType", "dispatchedAt" FROM outbox WHERE "tenantId"=$1`, [
        tenantId,
      ]);
      expect(outbox[0].eventType).toBe('tenant.provisioned');
      expect(outbox[0].dispatchedAt).toBeNull(); // no dispatcher in Phase 1

      // task 2.7: country_code / default_currency / fiscal_config are set
      // atomically, from the SAME authoritative country reference row, never
      // derived from tenant.region (correction 4) and never left mismatched.
      const company = (
        await q(
          `SELECT "countryCode", "defaultCurrency", "fiscalConfig" FROM company WHERE "tenantId"=$1`,
          [tenantId],
        )
      )[0];
      expect(company.countryCode).toBe('AE');
      expect(company.defaultCurrency).toBe('AED');
      expect(company.fiscalConfig).toEqual({});
    } finally {
      await c.end();
    }
  });

  it('an unknown company country code is rejected and creates nothing (task 2.7 — atomic, no partial tenant)', async () => {
    const token = await platformToken();
    const res = await post(
      '/platform/tenants',
      {
        slug: 'unknown-country-co',
        name: 'Unknown Country Co',
        region: 'AE',
        companyCountryCode: 'ZZ', // not seeded
        planVersionId: PLAN_V,
        ownerEmail: 'boss@unknown-country.test',
      },
      token,
      { 'idempotency-key': 'prov-unknown-country' },
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('UNKNOWN_COUNTRY');

    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const rows = (await c.query(`SELECT id FROM tenant WHERE slug=$1`, ['unknown-country-co']))
        .rows;
      // the whole provisioning transaction rolled back — no tenant, no
      // orphaned roles/company/branch either (same transaction, same rollback).
      expect(rows).toHaveLength(0);
    } finally {
      await c.end();
    }
  });

  it('is idempotent on the Idempotency-Key', async () => {
    const token = await platformToken();
    const res = await post(
      '/platform/tenants',
      {
        slug: 'acme-corp',
        name: 'Acme Corp',
        region: 'AE',
        companyCountryCode: 'AE',
        planVersionId: PLAN_V,
        ownerEmail: 'boss@acme.test',
      },
      token,
      { 'idempotency-key': 'prov-abc' },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().tenantId).toBe(tenantId);
  });

  it('the owner sets a password and logs in with ALL/ALL scope', async () => {
    expect(
      (
        await post(
          '/auth/set-password',
          { token: setPwToken, newPassword: 'a-strong-pass-1234' },
          '',
        )
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        workspaceSlug: 'acme-corp',
        email: 'boss@acme.test',
        password: 'a-strong-pass-1234',
      },
    });
    expect(login.statusCode).toBe(200);
    const me = await get('/me/access', login.json().accessToken);
    expect(me.json().accountType).toBe('OWNER');
    expect(me.json().branchScope).toBe('ALL');
  });

  it('suspend → tenant SUSPENDED and every session dies; resume restores', async () => {
    const token = await platformToken();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        workspaceSlug: 'acme-corp',
        email: 'boss@acme.test',
        password: 'a-strong-pass-1234',
      },
    });
    const ownerToken = login.json().accessToken as string;
    expect((await get('/me', ownerToken)).statusCode).toBe(200);

    const s = await post(`/platform/tenants/${tenantId}/suspend`, { reason: 'non-payment' }, token);
    expect(s.statusCode).toBe(200);
    expect(s.json().status).toBe('SUSPENDED');
    expect((await get('/me', ownerToken)).statusCode).toBe(401); // session killed
    // login refused while suspended
    const relogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        workspaceSlug: 'acme-corp',
        email: 'boss@acme.test',
        password: 'a-strong-pass-1234',
      },
    });
    expect(relogin.statusCode).toBe(401);

    expect((await post(`/platform/tenants/${tenantId}/resume`, {}, token)).json().status).toBe(
      'ACTIVE',
    );
  });

  it('impersonation is read-only and audited (OD7 / G13)', async () => {
    const token = await platformToken();
    const imp = await post(
      `/platform/tenants/${tenantId}/impersonate`,
      { reason: 'investigating a support ticket' },
      token,
    );
    expect(imp.statusCode).toBe(201);
    const body = imp.json();
    expect(body.banner).toBe(true);
    expect(body.expiresIn).toBe(30 * 60);

    // a read works
    expect((await get('/me', body.accessToken)).statusCode).toBe(200);
    // a mutating action is refused, whatever the permission says
    const mutate = await post(
      `/platform/tenants/${tenantId}/suspend`,
      { reason: 'x' },
      body.accessToken,
    );
    expect([401, 403]).toContain(mutate.statusCode); // realm + read-only both block it

    // stop
    expect((await del('/me/impersonation', body.accessToken)).statusCode).toBe(200);
    expect((await get('/me', body.accessToken)).statusCode).toBe(401);

    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const rows = await c
        .query(
          `SELECT action, "impersonatorPlatformUserId" FROM audit_log
            WHERE action LIKE 'IMPERSONATION:%' AND action <> 'IMPERSONATION:read' ORDER BY at`,
        )
        .then((r) => r.rows);
      expect(rows.map((r) => r.action)).toEqual(['IMPERSONATION:started', 'IMPERSONATION:ended']);
      expect(rows[0].impersonatorPlatformUserId).toBe(PLATFORM_USER);
      // every read served during impersonation is audited too (task 1.14 / OD7)
      const reads = await c
        .query(`SELECT count(*)::int AS n FROM audit_log WHERE action='IMPERSONATION:read'`)
        .then((r) => r.rows[0].n);
      expect(reads).toBeGreaterThanOrEqual(1);
    } finally {
      await c.end();
    }
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000000e0000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000000e0000', 1, 'PUBLISHED', now());
      INSERT INTO entitlement_default ("planVersionId", "moduleKey", enabled)
      VALUES ('${PLAN_V}', 'customer_web', false), ('${PLAN_V}', 'delivery', false);
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 3), ('${PLAN_V}', 'max_sessions_per_user', 5),
             ('${PLAN_V}', 'max_users', 10);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED-ar');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt") VALUES ('AE', 'United Arab Emirates', 'UAE-ar', 'gcc', 'AED', 'SAT_SUN', true, now());
    `);
  } finally {
    await c.end();
  }
}
