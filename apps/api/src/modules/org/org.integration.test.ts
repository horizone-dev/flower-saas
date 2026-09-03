import 'reflect-metadata';
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
import type { MfaLevel } from '../../common/context/index.js';
import type { SessionData } from '../../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-0000000f0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000000f0002';

/**
 * Task 1.8 — companies / branches / POS terminals. Verifies (PHASE-1-PLAN §3.8):
 * an Owner adds a 2nd company + branch; `LimitService` blocks the (limit+1)th;
 * a branch-scoped user cannot touch tenant settings; `registered_device_required`
 * cannot be set through the API (amendment 1); every create writes an audit row
 * in the same tenant scope; the step-up gate covers the settings permissions.
 */
describe('org: companies / branches / POS terminals (integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;

  let tenantId: string;
  let companyId: string;
  let branchId: string;
  let ownerUserId: string;

  let ownerToken: string; // OWNER, ALL/ALL, stepped up
  let ownerMfaOnlyToken: string; // OWNER but not stepped up
  let branchManagerToken: string; // one branch, settings:branch:manage only

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

    // provision a tenant (max_companies = 2, max_branches = 2, max_pos_terminals = 2)
    const prov = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      payload: {
        slug: 'orgtest',
        name: 'OrgTest FZE',
        region: 'AE',
        planVersionId: PLAN_V,
        ownerEmail: 'owner@orgtest.test',
      },
      headers: {
        authorization: `Bearer ${await mintPlatform()}`,
        'idempotency-key': 'org-prov-1',
      },
    });
    expect(prov.statusCode).toBe(201);
    ({ tenantId, companyId, branchId, ownerUserId } = prov.json());

    ownerToken = await mintTenant('org-owner', {
      userId: ownerUserId,
      accountType: 'OWNER',
      mfaLevel: 'STEP_UP',
      permissions: [...PHASE_1_TENANT_PERMISSIONS],
      companyScope: 'ALL',
      branchScope: 'ALL',
    });
    ownerMfaOnlyToken = await mintTenant('org-owner-mfa', {
      userId: ownerUserId,
      accountType: 'OWNER',
      mfaLevel: 'MFA',
      permissions: [...PHASE_1_TENANT_PERMISSIONS],
      companyScope: 'ALL',
      branchScope: 'ALL',
    });
    branchManagerToken = await mintTenant('org-branch-mgr', {
      userId: '00000000-0000-7000-8000-0000000f00aa',
      accountType: 'USER',
      mfaLevel: 'STEP_UP',
      permissions: ['users:view', 'audit:view', 'settings:branch:manage'],
      companyScope: [companyId],
      branchScope: [branchId],
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
    const s = baseSession('org-plat', 'platform');
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
    o: {
      userId: string;
      accountType: SessionData['accountType'];
      mfaLevel: MfaLevel;
      permissions: string[];
      companyScope: 'ALL' | string[];
      branchScope: 'ALL' | string[];
    },
  ): Promise<string> {
    const s = baseSession(sessionId, 'tenant');
    s.tenantId = tenantId;
    s.userId = o.userId;
    s.accountType = o.accountType;
    s.mfaLevel = o.mfaLevel;
    s.stepUpUntil = o.mfaLevel === 'STEP_UP' ? Date.now() + 600_000 : null;
    s.access = {
      effectivePermissions: o.permissions,
      companyScope: o.companyScope,
      branchScope: o.branchScope,
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

  const post = (url: string, body: Record<string, unknown>, token: string) =>
    app.inject({ method: 'POST', url: `/v1${url}`, payload: body, headers: auth(token) });
  const put = (url: string, body: Record<string, unknown>, token: string) =>
    app.inject({ method: 'PUT', url: `/v1${url}`, payload: body, headers: auth(token) });
  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/v1${url}`, headers: auth(token) });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  // ── tests ────────────────────────────────────────────────────────────────
  it('every org route declares a permission or @Public (G8)', () => {
    expect(() => assertEveryRouteDeclaresIntent(app)).not.toThrow();
  });

  it('the Owner adds a 2nd company (provisioning created the 1st)', async () => {
    const res = await post('/org/companies', { legalNameEn: 'OrgTest Trading LLC' }, ownerToken);
    expect(res.statusCode).toBe(201);
    expect((await get('/org/companies', ownerToken)).json()).toHaveLength(2);
  });

  it('the Owner adds a 2nd branch under the first company', async () => {
    const res = await post(
      '/org/branches',
      { companyId, name: 'Sharjah Branch', weekendModel: 'SAT_SUN' },
      ownerToken,
    );
    expect(res.statusCode).toBe(201);
    expect((await get('/org/branches', ownerToken)).json()).toHaveLength(2);
  });

  it('LimitService blocks the 3rd branch — max_branches = 2 (G / §48)', async () => {
    const res = await post('/org/branches', { companyId, name: 'Ajman Branch' }, ownerToken);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('LIMIT_EXCEEDED');
  });

  it('a POS terminal on an unknown branch is a clean 404, not a 500', async () => {
    const res = await post(
      '/org/pos-terminals',
      { branchId: '00000000-0000-7000-8000-0000000f0bad', code: 'POS-X', name: 'nope' },
      ownerToken,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('the Owner adds a POS terminal (identity/origin only — never a boundary)', async () => {
    const res = await post(
      '/org/pos-terminals',
      { branchId, code: 'POS-02', name: 'Front counter 2' },
      ownerToken,
    );
    expect(res.statusCode).toBe(201);
  });

  it('a settings mutation without a fresh step-up is refused (CLAUDE.md §13)', async () => {
    const res = await post(
      '/org/branches',
      { companyId, name: 'No-StepUp Branch' },
      ownerMfaOnlyToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('a branch-scoped user cannot create a company (403, no tenant-settings perm)', async () => {
    const res = await post('/org/companies', { legalNameEn: 'Rogue Co' }, branchManagerToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MISSING_PERMISSION');
  });

  it('a branch-scoped user CAN set an operational setting on its own branch', async () => {
    const res = await put(
      `/org/branches/${branchId}/settings`,
      { key: 'notes', value: 'ramadan hours' },
      branchManagerToken,
    );
    expect(res.statusCode).toBe(200);
    const settings = (await get(`/org/branches/${branchId}/settings`, ownerToken)).json();
    expect(settings).toContainEqual({ key: 'notes', value: 'ramadan hours' });
  });

  it('registered_device_required cannot be set through the API (amendment 1)', async () => {
    const res = await put(
      `/org/branches/${branchId}/settings`,
      { key: 'registered_device_required', value: true },
      ownerToken,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('trade licenses surface on the expiry report', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    expect(
      (
        await post(
          '/org/trade-licenses',
          { companyId, number: 'CN-1234567', expiresAt: soon },
          ownerToken,
        )
      ).statusCode,
    ).toBe(201);
    const expiring = (await get('/org/licenses/expiring?withinDays=30', ownerToken)).json();
    expect(expiring.map((l: { number: string }) => l.number)).toContain('CN-1234567');
  });

  it('every create wrote a tenant-scoped audit row (amendment 2)', async () => {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      // provisioning writes its own PLATFORM-actor rows (company/branch/pos) —
      // the org module's rows are the tenant-user ones (actorUserId set).
      const rows = await c
        .query(
          `SELECT action, "tenantId", "actorUserId", "actorAccountType"
             FROM audit_log
            WHERE "tenantId" = $1 AND "actorUserId" IS NOT NULL`,
          [tenantId],
        )
        .then((r) => r.rows);
      const actions = rows.map((r) => r.action).sort();
      expect(actions).toEqual(
        [
          'branch.created',
          'branch_setting.changed',
          'company.created',
          'pos_terminal.created',
          'trade_license.created',
        ].sort(),
      );
      // all rows carry the tenant; none leaked to another scope
      expect(rows.every((r) => r.tenantId === tenantId)).toBe(true);
      // the setting was changed by the branch-scoped USER, the rest by the OWNER
      const setting = rows.find((r) => r.action === 'branch_setting.changed');
      expect(setting.actorAccountType).toBe('USER');
      expect(rows.find((r) => r.action === 'company.created').actorUserId).toBe(ownerUserId);
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
      VALUES ('00000000-0000-7000-8000-0000000f0000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000000f0000', 1, 'PUBLISHED', now());
      INSERT INTO entitlement_default ("planVersionId", "moduleKey", enabled)
      VALUES ('${PLAN_V}', 'customer_web', false);
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_companies', 2), ('${PLAN_V}', 'max_branches', 2),
             ('${PLAN_V}', 'max_pos_terminals', 2), ('${PLAN_V}', 'max_sessions_per_user', 20),
             ('${PLAN_V}', 'max_users', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
    `);
  } finally {
    await c.end();
  }
}
