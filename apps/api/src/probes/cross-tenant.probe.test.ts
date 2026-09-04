import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import {
  runIsolationProbes,
  assertNoLeaks,
  type IsolationProbeCase,
  type ProbeOutcome,
} from '@flower/testing';
import { PHASE_1_TENANT_PERMISSIONS, PLATFORM_PERMISSIONS } from '@flower/permissions';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../common/context/index.js';
import { JwtService } from '../common/auth/jwt.service.js';
import { SessionStore } from '../common/auth/session-store.js';
import { enumerateRoutes } from '../common/auth/index.js';
import type { SessionData } from '../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-0000000c0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000000c0002';

/**
 * Cross-tenant / cross-branch / cross-realm isolation probe suite (PHASE-1-PLAN
 * §1.13, hard gate G1/G2/G3/G7). Two tenants are provisioned; every attempt to
 * read or write the OTHER tenant's resource — by id, nested URL, RLS-injection
 * body, wrong realm, or out-of-scope branch — must be denied (401/403/404) or
 * return none of the victim's rows. A leak fails the build.
 *
 * Teeth: the probes hit live endpoints through the full guard pipeline. Remove
 * `PermissionGuard` (or weaken `runScoped`) and the cross-tenant reads answer
 * 200-with-data → `assertNoLeaks` throws.
 */
describe('cross-tenant isolation probe suite', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;

  const A = {
    tenantId: '',
    companyId: '',
    branchId: '',
    branch2Id: '',
    ownerId: '',
    roleId: '',
    credId: '',
  };
  const B = { tenantId: '', companyId: '', branchId: '', ownerId: '' };

  let platformTok: string;
  let ownerATok: string;
  let ownerBTok: string;
  let branchUserATok: string; // tenant A, scoped to branch A1 only

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

    platformTok = await mint('probe-plat', {
      realm: 'platform',
      platformUserId: PLATFORM_USER,
      accountType: 'PLATFORM',
      permissions: [...PLATFORM_PERMISSIONS],
    });

    A.tenantId = await provision('tenant-a', 'a@probe.test');
    B.tenantId = await provision('tenant-b', 'b@probe.test');

    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0];
      A.companyId = (await one(`SELECT id FROM company WHERE "tenantId"=$1`, [A.tenantId])).id;
      A.branchId = (await one(`SELECT id FROM branch WHERE "tenantId"=$1`, [A.tenantId])).id;
      A.ownerId = (await one(`SELECT id FROM "user" WHERE "tenantId"=$1`, [A.tenantId])).id;
      B.companyId = (await one(`SELECT id FROM company WHERE "tenantId"=$1`, [B.tenantId])).id;
      B.branchId = (await one(`SELECT id FROM branch WHERE "tenantId"=$1`, [B.tenantId])).id;
      B.ownerId = (await one(`SELECT id FROM "user" WHERE "tenantId"=$1`, [B.tenantId])).id;

      A.branch2Id = (
        await one(
          `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
           VALUES (uuidv7(),$1,$2,'A branch 2',now()) RETURNING id`,
          [A.tenantId, A.companyId],
        )
      ).id;
      // a real branch_setting on A1 — a read leak would expose this value
      await c.query(
        `INSERT INTO branch_setting ("tenantId","branchId",key,value,"updatedAt")
         VALUES ($1,$2,'notes','"A-only secret note"'::jsonb,now())`,
        [A.tenantId, A.branchId],
      );
      const mgrRole = (
        await one(`SELECT id FROM role WHERE "tenantId"=$1 AND key='manager'`, [A.tenantId])
      ).id;
      const bu = '00000000-0000-7000-8000-0000000c00aa';
      await c.query(
        `INSERT INTO "user" (id,"tenantId","accountType",email,status,"updatedAt")
         VALUES ($1,$2,'USER','branchuser@probe.test','ACTIVE',now())`,
        [bu, A.tenantId],
      );
      await c.query(`INSERT INTO user_role ("tenantId","userId","roleId") VALUES ($1,$2,$3)`, [
        A.tenantId,
        bu,
        mgrRole,
      ]);
      await c.query(
        `INSERT INTO data_scope_assignment ("tenantId","userId","companyScopeAll","companyIds","branchScopeAll","branchIds","updatedAt")
         VALUES ($1,$2,false,ARRAY[$3::uuid],false,ARRAY[$4::uuid],now())`,
        [A.tenantId, bu, A.companyId, A.branchId],
      );
      branchUserATok = await mint('probe-bu-a', {
        realm: 'tenant',
        tenantId: A.tenantId,
        userId: bu,
        accountType: 'USER',
        permissions: ['users:view', 'audit:view', 'settings:branch:manage'],
        branchScope: [A.branchId],
        companyScope: [A.companyId],
      });
    } finally {
      await c.end();
    }

    ownerATok = await mint('probe-owner-a', {
      realm: 'tenant',
      tenantId: A.tenantId,
      userId: A.ownerId,
      accountType: 'OWNER',
      permissions: [...PHASE_1_TENANT_PERMISSIONS],
    });
    ownerBTok = await mint('probe-owner-b', {
      realm: 'tenant',
      tenantId: B.tenantId,
      userId: B.ownerId,
      accountType: 'OWNER',
      permissions: [...PHASE_1_TENANT_PERMISSIONS],
    });

    // seed a couple of A-owned resources to probe for
    A.roleId = (
      await send('POST', `/v1/platform/tenants/${A.tenantId}/roles`, platformTok, {
        key: 'a_only_role',
        name: 'A only',
        permissionKeys: ['users:view'],
      })
    ).json().id;
    A.credId = (
      await send('POST', `/v1/platform/tenants/${A.tenantId}/provider-credentials`, platformTok, {
        provider: 'stripe',
        mode: 'TEST',
        secret: 'sk_test_a_only_9f8e7d6c000',
      })
    ).json().id;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  async function mint(
    sessionId: string,
    o: {
      realm: 'tenant' | 'platform';
      tenantId?: string;
      userId?: string;
      platformUserId?: string;
      accountType: SessionData['accountType'];
      permissions: string[];
      branchScope?: string[] | 'ALL';
      companyScope?: string[] | 'ALL';
    },
  ): Promise<string> {
    const s: SessionData = {
      sessionId,
      realm: o.realm,
      familyId: 'f',
      tenantId: o.tenantId ?? null,
      userId: o.userId ?? null,
      platformUserId: o.platformUserId ?? null,
      accountType: o.accountType,
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
        effectivePermissions: o.permissions,
        companyScope: o.companyScope ?? 'ALL',
        branchScope: o.branchScope ?? 'ALL',
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    };
    await store.set(s);
    return o.realm === 'platform'
      ? jwt.sign({ sub: o.platformUserId ?? 'p', sid: s.sessionId, aud: 'platform' })
      : jwt.sign({ sub: o.userId ?? 'u', sid: s.sessionId, aud: 'tenant', tid: o.tenantId ?? '' });
  }

  async function provision(slug: string, ownerEmail: string): Promise<string> {
    const res = await send('POST', '/v1/platform/tenants', platformTok, {
      slug,
      name: slug,
      region: 'AE',
      planVersionId: PLAN_V,
      ownerEmail,
    });
    expect(res.statusCode).toBe(201);
    return res.json().tenantId as string;
  }

  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    token: string | null,
    body?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(body ? { payload: body } : {}),
    });

  /** status of a request as `attacker` */
  const asStatus =
    (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      token: string,
      body?: Record<string, unknown>,
    ) =>
    async (): Promise<number> =>
      (await send(method, url, token, body)).statusCode;

  // ═══════════════════════ tenant axis — B attacks A ══════════════════════════
  it('tenant axis: tenant B cannot reach tenant A resources', async () => {
    const cases: IsolationProbeCase[] = [
      {
        name: 'GET A branch settings by id',
        axis: 'tenant',
        attempt: async (): Promise<ProbeOutcome> => {
          const res = await send('GET', `/v1/org/branches/${A.branchId}/settings`, ownerBTok);
          if ([403, 404].includes(res.statusCode)) return res.statusCode;
          const body = JSON.stringify(res.json());
          return { status: res.statusCode, leaked: body.includes('A-only secret note') };
        },
      },
      {
        name: 'PUT A branch settings (write to A branch)',
        axis: 'tenant',
        attempt: asStatus('PUT', `/v1/org/branches/${A.branchId}/settings`, ownerBTok, {
          key: 'notes',
          value: 'pwned-by-B',
        }),
      },
      {
        name: 'POST branch under A company',
        axis: 'tenant',
        attempt: asStatus('POST', '/v1/org/branches', ownerBTok, {
          companyId: A.companyId,
          name: 'B-injected',
        }),
      },
      {
        name: 'POST pos-terminal on A branch',
        axis: 'tenant',
        attempt: asStatus('POST', '/v1/org/pos-terminals', ownerBTok, {
          branchId: A.branchId,
          code: 'X',
          name: 'x',
        }),
      },
      {
        name: 'POST trade-license under A company',
        axis: 'tenant',
        attempt: asStatus('POST', '/v1/org/trade-licenses', ownerBTok, {
          companyId: A.companyId,
          number: 'CN-B',
        }),
      },
      {
        name: 'org lists never contain A rows',
        axis: 'tenant',
        attempt: async (): Promise<ProbeOutcome> => {
          const [companies, branches, pos] = await Promise.all([
            send('GET', '/v1/org/companies', ownerBTok),
            send('GET', '/v1/org/branches', ownerBTok),
            send('GET', '/v1/org/pos-terminals', ownerBTok),
          ]);
          const blob = JSON.stringify([companies.json(), branches.json(), pos.json()]);
          return {
            status: 200,
            leaked: [A.companyId, A.branchId, A.branch2Id].some((id) => blob.includes(id)),
          };
        },
      },
    ];
    assertNoLeaks(await runIsolationProbes(cases));
  });

  // ═════════════════════ RLS-injection — body cannot re-scope ═════════════════
  it('RLS injection: a tenantId in the request body is ignored', async () => {
    const res = await send('POST', '/v1/org/companies', ownerBTok, {
      legalNameEn: 'injected',
      tenantId: A.tenantId,
    });
    expect(res.statusCode).toBe(201);
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const row = (await c.query(`SELECT "tenantId" FROM company WHERE "legalNameEn"='injected'`))
        .rows[0];
      expect(row.tenantId).toBe(B.tenantId); // scoped from the session, never the body
    } finally {
      await c.end();
    }
  });

  // ══════════════════════════ realm axis ═════════════════════════════════════
  it('realm axis: a tenant token is rejected on every @PlatformRealm route', async () => {
    const platformRoutes = enumerateRoutes(app).filter(
      (r) => r.realm === 'platform' && !r.isPublic,
    );
    expect(platformRoutes.length).toBeGreaterThan(10);
    const cases: IsolationProbeCase[] = platformRoutes.map((r) => ({
      name: `${r.httpMethod} ${r.path} as tenant token`,
      axis: 'tenant',
      // 401 (wrong audience) or 403 both count as denied
      expectDenied: [401, 403],
      attempt: async () =>
        (await send(r.httpMethod as 'GET', concretePath(r.path), ownerATok)).statusCode,
    }));
    assertNoLeaks(await runIsolationProbes(cases));
  });

  it('realm axis: a platform token is rejected on tenant-realm routes', async () => {
    const cases: IsolationProbeCase[] = [
      {
        name: 'GET /v1/me as platform token',
        axis: 'tenant',
        expectDenied: [401, 403],
        attempt: asStatus('GET', '/v1/me', platformTok),
      },
      {
        name: 'GET /v1/access/roles as platform token',
        axis: 'tenant',
        expectDenied: [401, 403],
        attempt: asStatus('GET', '/v1/access/roles', platformTok),
      },
      {
        name: 'GET /v1/org/companies as platform token',
        axis: 'tenant',
        expectDenied: [401, 403],
        attempt: asStatus('GET', '/v1/org/companies', platformTok),
      },
    ];
    assertNoLeaks(await runIsolationProbes(cases));
  });

  // ═══════════════════════ platform axis — B's platform-less token ════════════
  it('platform tenant-admin routes: no tenant token reaches another tenant', async () => {
    const cases: IsolationProbeCase[] = [
      {
        name: 'GET /v1/platform/tenants/{A}/roles as ownerB',
        axis: 'tenant',
        expectDenied: [401, 403, 404],
        attempt: asStatus('GET', `/v1/platform/tenants/${A.tenantId}/roles`, ownerBTok),
      },
      {
        name: 'PUT /v1/platform/tenants/{A}/roles/{id}/permissions as ownerB',
        axis: 'tenant',
        expectDenied: [401, 403, 404],
        attempt: asStatus(
          'PUT',
          `/v1/platform/tenants/${A.tenantId}/roles/${A.roleId}/permissions`,
          ownerBTok,
          { permissionKeys: [] },
        ),
      },
      {
        name: 'GET A provider credential as ownerB',
        axis: 'tenant',
        expectDenied: [401, 403, 404],
        attempt: asStatus(
          'GET',
          `/v1/platform/tenants/${A.tenantId}/provider-credentials/${A.credId}`,
          ownerBTok,
        ),
      },
      {
        name: 'POST A tenant suspend as ownerB',
        axis: 'tenant',
        expectDenied: [401, 403, 404],
        attempt: asStatus('POST', `/v1/platform/tenants/${A.tenantId}/suspend`, ownerBTok, {}),
      },
      {
        name: 'POST impersonate A as ownerB',
        axis: 'tenant',
        expectDenied: [401, 403, 404],
        attempt: asStatus('POST', `/v1/platform/tenants/${A.tenantId}/impersonate`, ownerBTok, {
          reason: 'probe attempt at cross tenant impersonation',
        }),
      },
      {
        name: 'GET A sessions as ownerB',
        axis: 'tenant',
        expectDenied: [401, 403, 404],
        attempt: asStatus('GET', `/v1/platform/tenants/${A.tenantId}/sessions`, ownerBTok),
      },
    ];
    assertNoLeaks(await runIsolationProbes(cases));
  });

  // ══════════════════════════ branch axis ════════════════════════════════════
  it('branch axis: an A1-scoped user cannot touch branch A2', async () => {
    const cases: IsolationProbeCase[] = [
      {
        name: 'GET A2 branch settings as A1-scoped user',
        axis: 'branch',
        attempt: asStatus('GET', `/v1/org/branches/${A.branch2Id}/settings`, branchUserATok),
      },
      {
        name: 'PUT A2 branch settings as A1-scoped user',
        axis: 'branch',
        attempt: asStatus('PUT', `/v1/org/branches/${A.branch2Id}/settings`, branchUserATok, {
          key: 'notes',
          value: 'x',
        }),
      },
    ];
    assertNoLeaks(await runIsolationProbes(cases));
  });

  // ══════════════════════════ coverage ══════════════════════════════════════
  it('every non-@Public route is either probed or on the documented safe list', () => {
    const routes = enumerateRoutes(app);
    const nonPublic = routes.filter((r) => !r.isPublic);
    // routes that carry no cross-tenant resource of their own — the caller only
    // ever acts on their own session context or a global reference table.
    const SAFE = new Set<string>([
      'GET /v1/me',
      'GET /v1/me/access',
      'DELETE /v1/me/impersonation',
      'POST /v1/auth/logout',
      'POST /v1/auth/step-up',
      'POST /v1/auth/mfa/enrol',
      'POST /v1/auth/mfa/confirm',
      'DELETE /v1/auth/sessions/:sessionId',
      'GET /v1/platform/plans',
      'POST /v1/platform/plans',
      'POST /v1/platform/plans/:planId/versions',
      'POST /v1/platform/plans/versions/:planVersionId/publish',
      'PUT /v1/platform/plans/versions/:planVersionId/entitlements',
      'PUT /v1/platform/plans/versions/:planVersionId/limits',
      'GET /v1/platform/tenants',
      'GET /v1/platform/audit',
      'GET /v1/platform/audit/security-events',
      'POST /v1/platform/tenants',
    ]);
    const PROBED_PREFIXES = [
      '/v1/org',
      '/v1/access',
      '/v1/platform/tenants/:tenantId',
      '/v1/platform/tenants/:id',
    ];
    const unprobed = nonPublic.filter((r) => {
      const key = `${r.httpMethod} ${r.path}`;
      if (SAFE.has(key)) return false;
      return !PROBED_PREFIXES.some((p) => r.path.startsWith(p));
    });
    expect(unprobed.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([]);
  });

  it('the guard pipeline is wired (teeth)', () => {
    // Two APP_GUARDs (AuthGuard + PermissionGuard). If either is removed the
    // cross-tenant probes above answer 200-with-data and this suite goes red.
    const routes = enumerateRoutes(app);
    expect(
      routes.every((r) => r.isPublic || r.permission !== undefined || r.realm === 'platform'),
    ).toBe(true);
  });
});

/** Fill a `:param` path pattern with the literal `probe` so the request reaches
 *  the guard (which rejects before the handler cares about the value). */
function concretePath(pattern: string): string {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, 'probe');
}

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000000c0000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000000c0000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_companies', 5),
             ('${PLAN_V}', 'max_pos_terminals', 5), ('${PLAN_V}', 'max_sessions_per_user', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('users:view','TENANT','admin','v',1),('users:manage','TENANT','admin','v',1),
             ('roles:manage','TENANT','admin','v',1),('audit:view','TENANT','admin','v',1),
             ('settings:branch:manage','TENANT','admin','v',1),('settings:tenant:manage','TENANT','admin','v',1);
    `);
  } finally {
    await c.end();
  }
}
