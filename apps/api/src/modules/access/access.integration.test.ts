import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { PHASE_1_TENANT_PERMISSIONS, PLATFORM_PERMISSIONS } from '@flower/permissions';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import { assertEveryRouteDeclaresIntent } from '../../common/auth/route-coverage.js';
import type { SessionData } from '../../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-000000190001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000190002';
const TARGET_USER = '00000000-0000-7000-8000-0000001900aa';
const SET_PW_TOKEN = 'access-test-set-password-token-raw-000';

/**
 * Task 1.9 — role / grant / scope administration + the escalation guard
 * (PHASE-1-PLAN §1.9). Verifies: two roles resolve to the union; a DENY grant
 * beats an ALLOW from a role; a platform-realm / not-entitled key is refused
 * (403); a system role is read-only; a scope change takes effect on the target's
 * next request without a re-login; every mutation writes an audit row.
 */
describe('access: role / grant / scope admin (integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;

  let tenantId: string;
  let companyId: string;
  let branchId: string;
  let branch2Id: string;
  let ownerUserId: string;
  let managerRoleId: string;

  let ownerToken: string; // OWNER, ALL/ALL, stepped up
  let targetToken: string; // real login for TARGET_USER (session in the ZSET)

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

    const prov = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      payload: {
        slug: 'acctest',
        name: 'AccTest FZE',
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'CUSTOM',
        planVersionId: PLAN_V,
        ownerEmail: 'owner@acctest.test',
      },
      headers: { authorization: `Bearer ${await mintPlatform()}`, 'idempotency-key': 'acc-prov-1' },
    });
    expect(prov.statusCode).toBe(201);
    ({ tenantId, companyId, branchId, ownerUserId } = prov.json());

    // a 2nd branch + the target user, seeded directly (superuser conn bypasses RLS)
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      branch2Id = (
        await c.query(
          `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
           VALUES (uuidv7(),$1,$2,'Second Branch',now()) RETURNING id`,
          [tenantId, companyId],
        )
      ).rows[0].id;
      managerRoleId = (
        await c.query(`SELECT id FROM role WHERE "tenantId"=$1 AND key='manager'`, [tenantId])
      ).rows[0].id;

      await c.query(
        `INSERT INTO "user" (id,"tenantId","accountType",email,status,"updatedAt")
         VALUES ($1,$2,'USER','target@acctest.test','ACTIVE',now())`,
        [TARGET_USER, tenantId],
      );
      await c.query(`INSERT INTO user_role ("tenantId","userId","roleId") VALUES ($1,$2,$3)`, [
        tenantId,
        TARGET_USER,
        managerRoleId,
      ]);
      await c.query(
        `INSERT INTO data_scope_assignment ("tenantId","userId","companyScopeAll","companyIds","branchScopeAll","branchIds","updatedAt")
         VALUES ($1,$2,false,ARRAY[$3::uuid],false,ARRAY[$4::uuid],now())`,
        [tenantId, TARGET_USER, companyId, branchId],
      );
      await c.query(
        `INSERT INTO set_password_token ("tenantId","userId","tokenHash","expiresAt")
         VALUES ($1,$2,$3, now() + interval '1 day')`,
        [tenantId, TARGET_USER, sha256(SET_PW_TOKEN)],
      );
    } finally {
      await c.end();
    }

    await app.inject({
      method: 'POST',
      url: '/v1/auth/set-password',
      payload: { token: SET_PW_TOKEN, newPassword: 'target-pass-strong-1' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        workspaceSlug: 'acctest',
        email: 'target@acctest.test',
        password: 'target-pass-strong-1',
      },
    });
    expect(login.statusCode).toBe(200);
    targetToken = login.json().accessToken;

    ownerToken = await mintTenant('acc-owner', {
      userId: ownerUserId,
      accountType: 'OWNER',
      permissions: [...PHASE_1_TENANT_PERMISSIONS],
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── token helpers ────────────────────────────────────────────────────────
  async function mintPlatform(): Promise<string> {
    const s = baseSession('acc-plat', 'platform');
    s.platformUserId = PLATFORM_USER;
    s.accountType = 'PLATFORM';
    s.mfaLevel = 'STEP_UP';
    s.stepUpUntil = Date.now() + 600_000;
    s.access = {
      effectivePermissions: [...PLATFORM_PERMISSIONS],
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: PLATFORM_USER, sid: s.sessionId, aud: 'platform' });
  }

  async function mintTenant(
    sessionId: string,
    o: { userId: string; accountType: SessionData['accountType']; permissions: string[] },
  ): Promise<string> {
    const s = baseSession(sessionId, 'tenant');
    s.tenantId = tenantId;
    s.userId = o.userId;
    s.accountType = o.accountType;
    s.mfaLevel = 'STEP_UP';
    s.stepUpUntil = Date.now() + 600_000;
    s.access = {
      effectivePermissions: o.permissions,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: o.userId, sid: s.sessionId, aud: 'tenant', tid: tenantId });
  }

  function baseSession(sessionId: string, realm: 'tenant' | 'platform'): SessionData {
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

  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  const send = (
    method: 'POST' | 'PUT',
    url: string,
    body: Record<string, unknown>,
    token: string,
  ) =>
    app.inject({
      method,
      url: `/v1${url}`,
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });
  const myAccess = () => get('/me/access', targetToken).then((r) => r.json());

  // ── tests ────────────────────────────────────────────────────────────────
  it('every access route declares a permission or @Public (G8)', () => {
    expect(() => assertEveryRouteDeclaresIntent(app)).not.toThrow();
  });

  it('lists the 13 seeded system roles (all read-only)', async () => {
    const roles = (await get('/access/roles', ownerToken)).json();
    expect(roles).toHaveLength(13);
    expect(roles.every((r: { isSystem: boolean }) => r.isSystem)).toBe(true);
  });

  it('rejects a custom role carrying a platform-realm key (escalation guard)', async () => {
    const res = await send(
      'POST',
      '/access/roles',
      { key: 'evil', name: 'Evil', permissionKeys: ['platform:tenants:manage'] },
      ownerToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_NOT_GRANTABLE');
  });

  it('rejects a custom role carrying a not-yet-seeded future key', async () => {
    const res = await send(
      'POST',
      '/access/roles',
      { key: 'evil2', name: 'E2', permissionKeys: ['inventory:adjust'] },
      ownerToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_NOT_GRANTABLE');
  });

  it('a system role is not editable', async () => {
    const res = await send(
      'PUT',
      `/access/roles/${managerRoleId}/permissions`,
      { permissionKeys: ['users:view'] },
      ownerToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SYSTEM_ROLE_READONLY');
  });

  it('two custom roles resolve to the union on the target user', async () => {
    const r1 = (
      await send(
        'POST',
        '/access/roles',
        { key: 'r1', name: 'R1', permissionKeys: ['users:view'] },
        ownerToken,
      )
    ).json().id;
    const r2 = (
      await send(
        'POST',
        '/access/roles',
        { key: 'r2', name: 'R2', permissionKeys: ['audit:view'] },
        ownerToken,
      )
    ).json().id;

    const res = await send(
      'PUT',
      `/access/users/${TARGET_USER}/roles`,
      { roleIds: [r1, r2] },
      ownerToken,
    );
    expect(res.statusCode).toBe(200);
    expect((await myAccess()).permissions).toEqual(['audit:view', 'users:view']);
  });

  it('a DENY grant beats the ALLOW from a role', async () => {
    const res = await send(
      'PUT',
      `/access/users/${TARGET_USER}/grants`,
      {
        grants: [
          { permissionKey: 'audit:view', effect: 'DENY', reason: 'temporary review freeze' },
        ],
      },
      ownerToken,
    );
    expect(res.statusCode).toBe(200);
    expect((await myAccess()).permissions).toEqual(['users:view']);
  });

  it('a scope change takes effect on the target’s next request (no re-login)', async () => {
    expect((await myAccess()).branchScope).toEqual([branchId]);
    const res = await send(
      'PUT',
      `/access/users/${TARGET_USER}/scope`,
      {
        companyScopeAll: false,
        companyIds: [companyId],
        branchScopeAll: false,
        branchIds: [branch2Id],
      },
      ownerToken,
    );
    expect(res.statusCode).toBe(200);
    expect((await myAccess()).branchScope).toEqual([branch2Id]);
  });

  it('preview is read-only — it returns the diff without applying it', async () => {
    const res = await send(
      'POST',
      `/access/users/${TARGET_USER}/preview`,
      { grants: [{ permissionKey: 'users:view', effect: 'DENY' }] },
      ownerToken,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().diff.permissionsRemoved).toContain('users:view');
    // unchanged — the target still has users:view
    expect((await myAccess()).permissions).toEqual(['users:view']);
  });

  it('every mutation wrote a tenant-scoped audit row', async () => {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const rows = await c
        .query(`SELECT action FROM audit_log WHERE "tenantId"=$1 AND "actorUserId"=$2`, [
          tenantId,
          ownerUserId,
        ])
        .then((r) => r.rows.map((x) => x.action));
      expect(new Set(rows)).toEqual(
        new Set([
          'role.created',
          'user.roles_changed',
          'user.grants_changed',
          'user.scope_changed',
        ]),
      );
    } finally {
      await c.end();
    }
  });
});

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000190000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000190000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_users', 20),
             ('${PLAN_V}', 'max_sessions_per_user', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED-ar');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt") VALUES ('AE', 'United Arab Emirates', 'UAE-ar', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt") VALUES ('CUSTOM', 1, 'Custom', 'مخصص', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey", "capabilityKey", enabled, "updatedAt") VALUES ('CUSTOM','strategy.stocked',true,now()),('CUSTOM','branch_pricing',true,now()),('CUSTOM','channel.pos',true,now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('users:view','TENANT','admin','users view',1),
             ('users:manage','TENANT','admin','users manage',1),
             ('roles:manage','TENANT','admin','roles manage',1),
             ('audit:view','TENANT','admin','audit view',1),
             ('settings:branch:manage','TENANT','admin','branch settings',1),
             ('settings:tenant:manage','TENANT','admin','tenant settings',1),
             ('platform:tenants:manage','PLATFORM','platform','tenants manage',1);
    `);
  } finally {
    await c.end();
  }
}
