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

const PLAN_V = '00000000-0000-7000-8000-0000001b0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000001b0002';

describe('platform: tenant administration surface for Super Admin Web (integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantId: string;
  let ownerUserId: string;
  let managerRoleId: string;
  let superToken: string;

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

    superToken = await mintPlatform();
    const prov = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      payload: {
        slug: 'padmin',
        name: 'PAdmin FZE',
        region: 'AE',
        companyCountryCode: 'AE',
        planVersionId: PLAN_V,
        ownerEmail: 'owner@padmin.test',
      },
      headers: { authorization: `Bearer ${superToken}`, 'idempotency-key': 'padmin-1' },
    });
    expect(prov.statusCode).toBe(201);
    ({ tenantId, ownerUserId } = prov.json());

    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      managerRoleId = (
        await c.query(`SELECT id FROM role WHERE "tenantId"=$1 AND key='manager'`, [tenantId])
      ).rows[0].id;
      await c.query(`
        INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
        VALUES ('users:view','TENANT','admin','v',1),('audit:view','TENANT','admin','v',1),
               ('settings:branch:manage','TENANT','admin','v',1),
               ('platform:tenants:manage','PLATFORM','platform','v',1)
        ON CONFLICT (key) DO NOTHING;
      `);
    } finally {
      await c.end();
    }
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  async function mintPlatform(): Promise<string> {
    const s: SessionData = {
      sessionId: 'padmin-super',
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

  const get = (url: string, token = superToken) =>
    app.inject({ method: 'GET', url: `/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  const send = (
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    body: Record<string, unknown> | undefined,
    token = superToken,
  ) =>
    app.inject({
      method,
      url: `/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    });

  it('every route declares a permission or @Public (G8)', () => {
    expect(() => assertEveryRouteDeclaresIntent(app)).not.toThrow();
  });

  it('lists tenants and returns a detail with counts', async () => {
    const list = (await get('/platform/tenants')).json();
    expect(list.map((t: { slug: string }) => t.slug)).toContain('padmin');

    const detail = (await get(`/platform/tenants/${tenantId}`)).json();
    expect(detail.slug).toBe('padmin');
    expect(detail.counts).toEqual({ companies: 1, branches: 1, users: 1, posTerminals: 1 });
  });

  it('a normal Super Admin can create a tenant role and assign it (not read-only)', async () => {
    const created = await send('POST', `/platform/tenants/${tenantId}/roles`, {
      key: 'ops_lead',
      name: 'Ops Lead',
      permissionKeys: ['users:view', 'audit:view'],
    });
    expect(created.statusCode).toBe(201);
    const roleId = created.json().id;

    const assign = await send('PUT', `/platform/tenants/${tenantId}/users/${ownerUserId}/roles`, {
      roleIds: [managerRoleId, roleId],
    });
    expect(assign.statusCode).toBe(200);

    const user = (await get(`/platform/tenants/${tenantId}/users/${ownerUserId}`)).json();
    expect(user.permissions).toEqual(expect.arrayContaining(['audit:view', 'users:view']));
  });

  it('the escalation guard still bars a platform-realm key in a tenant role', async () => {
    const res = await send('POST', `/platform/tenants/${tenantId}/roles`, {
      key: 'evil',
      name: 'Evil',
      permissionKeys: ['platform:tenants:manage'],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_NOT_GRANTABLE');
  });

  it('access-preview works from the platform realm and is read-only', async () => {
    const res = await send(
      'POST',
      `/platform/tenants/${tenantId}/users/${ownerUserId}/access-preview`,
      { grants: [{ permissionKey: 'users:view', effect: 'DENY' }] },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().diff.permissionsRemoved).toContain('users:view');
  });

  it('lists live tenant sessions and can revoke one', async () => {
    // an owner login creates a live session in the tenantsessions index
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    let setPwHash: string;
    try {
      // reuse the provisioning set-password token path via a fresh token
      const raw = 'padmin-owner-setpw-token-raw-00000000';
      const { createHash } = await import('node:crypto');
      setPwHash = createHash('sha256').update(raw).digest('hex');
      await c.query(
        `INSERT INTO set_password_token ("tenantId","userId","tokenHash","expiresAt")
         VALUES ($1,$2,$3, now() + interval '1 day')`,
        [tenantId, ownerUserId, setPwHash],
      );
      await app.inject({
        method: 'POST',
        url: '/v1/auth/set-password',
        payload: { token: raw, newPassword: 'padmin-owner-pass-1' },
      });
    } finally {
      await c.end();
    }
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        workspaceSlug: 'padmin',
        email: 'owner@padmin.test',
        password: 'padmin-owner-pass-1',
      },
    });
    expect(login.statusCode).toBe(200);

    const sessions = (await get(`/platform/tenants/${tenantId}/sessions`)).json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const sid = sessions[0].sessionId;

    const del = await send('DELETE', `/platform/tenants/${tenantId}/sessions/${sid}`, undefined);
    expect(del.statusCode).toBe(200);
    // the owner's token is now dead
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('during impersonation, platform tenant-RBAC mutations fail (OD7)', async () => {
    const imp = await send('POST', `/platform/tenants/${tenantId}/impersonate`, {
      reason: 'investigating a support ticket for the customer',
    });
    expect(imp.statusCode).toBe(201);
    const impToken = imp.json().accessToken;

    // a read via the impersonated (tenant-realm) session works
    expect((await get('/me', impToken)).statusCode).toBe(200);

    // the platform tenant-RBAC route rejects the tenant-realm impersonation token
    const mutate = await send(
      'PUT',
      `/platform/tenants/${tenantId}/users/${ownerUserId}/roles`,
      { roleIds: [managerRoleId] },
      impToken,
    );
    expect([401, 403]).toContain(mutate.statusCode);

    await send('DELETE', '/me/impersonation', undefined, impToken);
  });

  it('the audit viewer returns the platform-actor rows for the tenant', async () => {
    const res = (await get(`/platform/audit?tenantId=${tenantId}&action=role`)).json();
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    expect(res.rows.every((r: { action: string }) => r.action.startsWith('role'))).toBe(true);
    expect(
      res.rows.some((r: { actorAccountType: string }) => r.actorAccountType === 'PLATFORM'),
    ).toBe(true);
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000001b0000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000001b0000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED-ar');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt") VALUES ('AE', 'United Arab Emirates', 'UAE-ar', 'gcc', 'AED', 'SAT_SUN', true, now());
    `);
  } finally {
    await c.end();
  }
}
