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

const PLAN_V = '00000000-0000-7000-8000-0000001c0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000001c0002';

/**
 * Audit + outbox foundation (PHASE-1-PLAN §1.14 / G12 / amendment 2). Every
 * registry action's mutation leaves its record(s), committed atomically; a
 * rolled-back mutation leaves none; provisioning produces the documented set;
 * the outbox accumulates undispatched; the `security_event` view assembles the
 * security feed.
 */
describe('audit + outbox foundation (integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let db: pg.Client;
  let tenantId: string;
  let ownerUserId: string;
  let superTok: string;

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
    db = new pg.Client({ connectionString: stack.postgres.url });
    await db.connect();

    superTok = await mint('af-super', 'platform', { permissions: [...PLATFORM_PERMISSIONS] });
    const prov = await send('POST', '/v1/platform/tenants', superTok, {
      slug: 'audittest',
      name: 'AuditTest',
      region: 'AE',
      companyCountryCode: 'AE',
      businessTypeKey: 'CUSTOM',
      planVersionId: PLAN_V,
      ownerEmail: 'owner@audittest.test',
    });
    expect(prov.statusCode).toBe(201);
    ({ tenantId, ownerUserId } = prov.json());
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  async function mint(
    sessionId: string,
    realm: 'tenant' | 'platform',
    o: { permissions: string[]; userId?: string; impersonator?: string },
  ): Promise<string> {
    const s: SessionData = {
      sessionId,
      realm,
      familyId: 'f',
      tenantId: realm === 'tenant' ? tenantId : null,
      userId: o.userId ?? null,
      platformUserId: realm === 'platform' ? PLATFORM_USER : null,
      accountType: realm === 'platform' ? 'PLATFORM' : 'OWNER',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'STEP_UP',
      stepUpUntil: Date.now() + 600_000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: o.impersonator ?? null,
      access: {
        effectivePermissions: o.permissions,
        companyScope: 'ALL',
        branchScope: 'ALL',
        perBranchOverlay: {},
        entitledModules: [],
        planKey: null,
      },
    };
    await store.set(s);
    return realm === 'platform'
      ? jwt.sign({ sub: PLATFORM_USER, sid: sessionId, aud: 'platform' })
      : jwt.sign({ sub: o.userId ?? 'u', sid: sessionId, aud: 'tenant', tid: tenantId });
  }

  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    token: string,
    body?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    });

  const actions = (where: string, params: unknown[]) =>
    db
      .query(`SELECT action FROM audit_log WHERE ${where}`, params)
      .then((r) => r.rows.map((x) => x.action));

  // ── tests ────────────────────────────────────────────────────────────────
  it('provisioning produces the documented set of audit rows + one undispatched outbox row', async () => {
    const rows = await actions(`"tenantId"=$1`, [tenantId]);
    expect(new Set(rows)).toEqual(
      new Set([
        'tenant.created',
        'company.created',
        'branch.created',
        'pos_terminal.created',
        'user.created',
        // task 3.1 — the Business-Type template snapshot audits itself
        'catalog.template_applied',
      ]),
    );
    const outbox = await db
      .query(`SELECT "eventType","dispatchedAt" FROM outbox WHERE "tenantId"=$1`, [tenantId])
      .then((r) => r.rows);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe('tenant.provisioned');
    expect(outbox[0].dispatchedAt).toBeNull();
  });

  it('a limit + entitlement override each leave an audit row', async () => {
    expect(
      (
        await send('PUT', `/v1/platform/tenants/${tenantId}/limits/max_branches`, superTok, {
          value: 9,
          reason: 'growth deal',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send('PUT', `/v1/platform/tenants/${tenantId}/entitlements`, superTok, {
          moduleKey: 'customer_web',
          enabled: true,
        })
      ).statusCode,
    ).toBe(200);
    const rows = await actions(`"tenantId"=$1 AND action LIKE 'tenant.%'`, [tenantId]);
    expect(rows).toContain('tenant.limit_overridden');
    expect(rows).toContain('tenant.entitlement_overridden');
  });

  it('a rolled-back mutation leaves no audit row (unique-key collision)', async () => {
    const first = await send('POST', `/v1/platform/tenants/${tenantId}/roles`, superTok, {
      key: 'dup_role',
      name: 'Dup',
      permissionKeys: [],
    });
    expect(first.statusCode).toBe(201);
    const second = await send('POST', `/v1/platform/tenants/${tenantId}/roles`, superTok, {
      key: 'dup_role',
      name: 'Dup again',
      permissionKeys: [],
    });
    expect(second.statusCode).toBe(409);
    const created = await db
      .query(
        `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId"=$1 AND action='role.created' AND "resourceType"='role'`,
        [tenantId],
      )
      .then((r) => r.rows[0].n);
    // exactly one — the failed second attempt rolled back its would-be audit row
    expect(created).toBe(1);
  });

  it('suspend + platform session revoke are audited', async () => {
    // an owner login → a live session to revoke
    const raw = 'audit-owner-setpw-000000000000000000';
    const { createHash } = await import('node:crypto');
    await db.query(
      `INSERT INTO set_password_token ("tenantId","userId","tokenHash","expiresAt") VALUES ($1,$2,$3, now() + interval '1 day')`,
      [tenantId, ownerUserId, createHash('sha256').update(raw).digest('hex')],
    );
    await app.inject({
      method: 'POST',
      url: '/v1/auth/set-password',
      payload: { token: raw, newPassword: 'audit-owner-pass-1' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        workspaceSlug: 'audittest',
        email: 'owner@audittest.test',
        password: 'audit-owner-pass-1',
      },
    });
    const sessions = (
      await send('GET', `/v1/platform/tenants/${tenantId}/sessions`, superTok)
    ).json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(
      (
        await send(
          'DELETE',
          `/v1/platform/tenants/${tenantId}/sessions/${sessions[0].sessionId}`,
          superTok,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send('POST', `/v1/platform/tenants/${tenantId}/suspend`, superTok, {
          reason: 'audit test',
        })
      ).statusCode,
    ).toBe(200);
    await send('POST', `/v1/platform/tenants/${tenantId}/resume`, superTok, {});

    const rows = await actions(
      `action IN ('session.revoked','tenant.suspend','tenant.resume')`,
      [],
    );
    expect(rows).toEqual(
      expect.arrayContaining(['session.revoked', 'tenant.suspend', 'tenant.resume']),
    );
    void login;
  });

  it('every request inside an impersonated session writes IMPERSONATION:read; stop writes IMPERSONATION:ended', async () => {
    const imp = await send('POST', `/v1/platform/tenants/${tenantId}/impersonate`, superTok, {
      reason: 'investigating a support ticket for the tenant owner',
    });
    expect(imp.statusCode).toBe(201);
    const impToken = imp.json().accessToken;

    expect((await send('GET', '/v1/me', impToken)).statusCode).toBe(200);
    expect((await send('GET', '/v1/me/access', impToken)).statusCode).toBe(200);
    await send('DELETE', '/v1/me/impersonation', impToken);

    // the interceptor writes after the response — give it a beat
    await new Promise((r) => setTimeout(r, 200));
    const reads = await db
      .query(
        `SELECT "impersonatorPlatformUserId" FROM audit_log WHERE action='IMPERSONATION:read' AND "tenantId"=$1`,
        [tenantId],
      )
      .then((r) => r.rows);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every((r) => r.impersonatorPlatformUserId === PLATFORM_USER)).toBe(true);

    const life = await actions(
      `action LIKE 'IMPERSONATION:%' AND action <> 'IMPERSONATION:read'`,
      [],
    );
    expect(life).toEqual(expect.arrayContaining(['IMPERSONATION:started', 'IMPERSONATION:ended']));
  });

  it('GET /v1/platform/audit/security-events assembles the audit + login feed', async () => {
    const res = await send(
      'GET',
      `/v1/platform/audit/security-events?tenantId=${tenantId}`,
      superTok,
    );
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { kind: string; source: string }[];
    expect(rows.some((r) => r.source === 'audit' && r.kind.startsWith('tenant.'))).toBe(true);
    expect(rows.some((r) => r.source === 'login')).toBe(true);
    // an org create (company.created) is NOT security-relevant → absent
    expect(rows.some((r) => r.kind === 'company.created')).toBe(false);
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000001c0000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000001c0000', 1, 'PUBLISHED', now());
      INSERT INTO entitlement_default ("planVersionId", "moduleKey", enabled)
      VALUES ('${PLAN_V}', 'customer_web', false);
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 3), ('${PLAN_V}', 'max_sessions_per_user', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED-ar');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt") VALUES ('AE', 'United Arab Emirates', 'UAE-ar', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt") VALUES ('CUSTOM', 1, 'Custom', 'مخصص', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey", "capabilityKey", enabled, "updatedAt") VALUES ('CUSTOM','strategy.stocked',true,now()),('CUSTOM','branch_pricing',true,now()),('CUSTOM','channel.pos',true,now());
    `);
  } finally {
    await c.end();
  }
}
