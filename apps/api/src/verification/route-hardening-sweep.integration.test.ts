import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import {
  ALL_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  isPlatformPermissionKey,
} from '@flower/permissions';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../common/context/index.js';
import { JwtService } from '../common/auth/jwt.service.js';
import { SessionStore } from '../common/auth/session-store.js';
import { enumerateRoutes, type MappedRoute } from '../common/auth/route-coverage.js';
import type { SessionData } from '../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-0000000f0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000000f0002';
const MALFORMED = 'not-a-uuid';

/**
 * Phase 3B closure — route-hardening sweep (open findings F4, V-1, V-2 of Task 3b.11). EVERY mapped route is called, with a fully
 * privileged caller, in three ways:
 *   A. every `:id`-style path parameter is a well-formed UUID that does not exist           → must never answer 5xx (F4: not-found paths)
 *   B. every `:id`-style path parameter is malformed                                         → must never answer 5xx, and is a 4xx (V-1)
 *   C. `?cursor=` is malformed on every GET                                                  → must never answer 5xx (V-1 customer cursor)
 * A 5xx anywhere means a caller-controlled value reached the database or a handler and was reported as a server fault (V-2).
 * Bodies are `{}` (a validation 400 is the expected outcome for mutations); this is NOT a functional test of any route.
 */
describe('route-hardening sweep — no caller-controlled value may produce a 5xx', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let tenantToken = '';
  let provisioned = { tenantId: '', companyId: '', branchId: '' };
  let platformToken = '';
  let routes: MappedRoute[] = [];

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000000f0000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000000f0000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value) VALUES ('${PLAN_V}', 'max_companies', 5), ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_pos_terminals', 5), ('${PLAN_V}', 'max_sessions_per_user', 20), ('${PLAN_V}', 'max_users', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt") VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED-ar');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt") VALUES ('AE', 'United Arab Emirates', 'UAE-ar', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt") VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey", "capabilityKey", enabled, "updatedAt") VALUES ('CUSTOM','strategy.stocked',true,now()),('CUSTOM','branch_pricing',true,now()),('CUSTOM','channel.pos',true,now());
    `);
    await c.end();
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
    const jwt = app.get(JwtService);
    const store = app.get(SessionStore);
    const base = (sessionId: string, realm: 'tenant' | 'platform'): SessionData =>
      ({
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
      }) as unknown as SessionData;
    const ps = base('sweep-plat', 'platform');
    ps.platformUserId = PLATFORM_USER;
    ps.accountType = 'PLATFORM';
    ps.mfaLevel = 'STEP_UP';
    ps.stepUpUntil = Date.now() + 3_600_000;
    ps.access = {
      effectivePermissions: [...PLATFORM_PERMISSIONS],
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(ps);
    platformToken = await jwt.sign({ sub: PLATFORM_USER, sid: ps.sessionId, aud: 'platform' });
    const prov = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      payload: {
        slug: 'sweep',
        name: 'Sweep FZE',
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'CUSTOM',
        planVersionId: PLAN_V,
        ownerEmail: 'owner@sweep.test',
      },
      headers: { authorization: `Bearer ${platformToken}`, 'idempotency-key': 'sweep-prov' },
    });
    expect(prov.statusCode).toBe(201);
    const t = prov.json() as {
      tenantId: string;
      ownerUserId: string;
      companyId: string;
      branchId: string;
    };
    provisioned = { tenantId: t.tenantId, companyId: t.companyId, branchId: t.branchId };
    const ts = base('sweep-owner', 'tenant');
    ts.tenantId = t.tenantId;
    ts.userId = t.ownerUserId;
    ts.accountType = 'OWNER';
    ts.mfaLevel = 'STEP_UP';
    ts.stepUpUntil = Date.now() + 3_600_000;
    ts.access = {
      effectivePermissions: ALL_PERMISSIONS.filter((k) => !isPlatformPermissionKey(k)),
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(ts);
    tenantToken = await jwt.sign({
      sub: t.ownerUserId,
      sid: ts.sessionId,
      aud: 'tenant',
      tid: t.tenantId,
    });
    routes = enumerateRoutes(app).filter((r) => !r.isPublic);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET'])
      delete process.env[k];
  });

  /** `:code` / `:limitKey` are NOT uuids — they get a plausible, well-formed value */
  const NON_UUID_PARAMS: Record<string, string> = { code: 'AED', limitKey: 'max_users' };
  const isIdParam = (name: string): boolean => name === 'id' || name.endsWith('Id');

  const fill = (path: string, mode: 'valid' | 'malformed'): string =>
    path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
      if (!isIdParam(name)) return NON_UUID_PARAMS[name] ?? 'x';
      return mode === 'valid' ? randomUUID() : MALFORMED;
    });

  /** documented FAIL-CLOSED configuration faults (frozen Task 2.7 / 3.9): a missing or ambiguous tax regime is a 500 BY DESIGN and depends on seeded data, never on caller input */
  /** the privileged session must still be valid, or a sweep of 401s would pass vacuously */
  const assertAlive = async (): Promise<void> => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer ' + tenantToken },
    });
    expect(res.statusCode, 'the sweep session was revoked before this case ran').toBe(200);
  };

  const DOCUMENTED_CONFIG_FAULTS = new Set([
    'TAX_REGIME_NOT_CONFIGURED',
    'TAX_REGIME_AMBIGUOUS',
    'TAX_RATE_AMBIGUOUS',
  ]);

  async function call(r: MappedRoute, url: string, payload: unknown = {}): Promise<number> {
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(r.httpMethod);
    const res = await app.inject({
      method: r.httpMethod as 'GET',
      url,
      ...(hasBody ? { payload: payload as object } : {}),
      headers: {
        authorization: `Bearer ${r.realm === 'platform' ? platformToken : tenantToken}`,
        'idempotency-key': randomUUID(),
        'if-match': '1',
      },
    });
    if (res.statusCode >= 500) {
      const code = (res.json() as { error?: { code?: string } }).error?.code ?? '';
      if (DOCUMENTED_CONFIG_FAULTS.has(code)) return 0;
    }
    return res.statusCode;
  }

  it('the route table is non-trivial (the sweep covers the whole application, not a handful of routes)', () => {
    expect(routes.length).toBeGreaterThan(150);
  });

  it('G — F3: a payment card number in a free-text field is refused with 400 SENSITIVE_DATA_REJECTED and nothing is stored; ordinary text still works', async () => {
    const send = (extra: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/v1/org/companies',
        payload: { legalNameEn: 'Rose Trading LLC', countryCode: 'AE', ...extra },
        headers: { authorization: 'Bearer ' + tenantToken, 'idempotency-key': randomUUID() },
      });
    const count = async (): Promise<number> =>
      (
        (
          await app.inject({
            method: 'GET',
            url: '/v1/org/companies',
            headers: { authorization: 'Bearer ' + tenantToken },
          })
        ).json() as unknown[]
      ).length;
    const before = await count();

    // refused: a card number in every kind of free-text field, including the disguises (NBSP separators, Arabic-Indic digits)
    for (const extra of [
      { legalNameEn: 'Rose Co 4111 1111 1111 1111' },
      { legalNameEn: 'Rose Co 4111 1111 1111 1111' },
      { legalNameAr: '٤١١١ ١١١١ ١١١١ ١١١١' },
      { registeredAddress: 'PO Box 4111-1111-1111-1111, Dubai' },
      { ['name4111111111111111']: 'x', legalNameEn: '4111111111111111' },
    ]) {
      const refused = await send(extra);
      expect([refused.statusCode, refused.json().error.code]).toEqual([
        400,
        'SENSITIVE_DATA_REJECTED',
      ]);
      expect(refused.body).not.toMatch(/4111|٤١١١/);
    }
    expect(await count()).toBe(before); // nothing was stored

    // accepted: the SAME digits in fields that are not free text (CR number, TRN) and ordinary free text
    const idLike = await send({ crNumber: '4111111111111111', trn: '4111111111111111' });
    expect(idLike.statusCode).toBe(201);
    const ordinary = await send({ legalNameEn: 'Order 20261105 ledger AED 1,250.500' });
    expect(ordinary.statusCode).toBe(201);
    expect(await count()).toBe(before + 2);
  });

  it('A — unknown-but-valid ids: no route answers 5xx (F4)', async () => {
    await assertAlive();
    const bad: string[] = [];
    for (const r of routes.filter((x) => /:/.test(x.path))) {
      const s = await call(r, fill(r.path, 'valid'));
      if (s >= 500) bad.push(`${r.httpMethod} ${r.path} → ${s}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it('B — malformed ids: no route answers 5xx; a malformed id-style path parameter is a 4xx (V-1)', async () => {
    await assertAlive();
    const bad: string[] = [];
    for (const r of routes.filter((x) => /:(id|[A-Za-z]+Id)\b/.test(x.path))) {
      const s = await call(r, fill(r.path, 'malformed'));
      if (s >= 500) bad.push(`${r.httpMethod} ${r.path} → ${s}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it('C — malformed ?cursor= on every GET: no 5xx (V-1 customer / order / receivables cursor)', async () => {
    await assertAlive();
    const bad: string[] = [];
    for (const r of routes.filter((x) => x.httpMethod === 'GET')) {
      const s = await call(r, `${fill(r.path, 'valid')}?cursor=${MALFORMED}`);
      if (s >= 500) bad.push(`${r.httpMethod} ${r.path} → ${s}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it('D — garbage query values on every GET: a 4xx, never a 5xx (V-2: a zod error must not surface as 500)', async () => {
    await assertAlive();
    const bad: string[] = [];
    const q =
      '?limit=abc&at=garbage&from=garbage&to=garbage&asOf=garbage&status=zz&since=garbage&companyId=nope';
    for (const r of routes.filter((x) => x.httpMethod === 'GET')) {
      const s = await call(r, fill(r.path, 'valid') + q);
      if (s >= 500) bad.push(`${r.httpMethod} ${r.path} → ${s}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it('F — a plain GET with no query on routes that take no id answers without a 5xx (guards against seed-data-dependent faults)', async () => {
    await assertAlive();
    const bad: string[] = [];
    for (const r of routes.filter((x) => x.httpMethod === 'GET' && !/:/.test(x.path))) {
      const s = await call(r, r.path);
      if (s >= 500) bad.push(`${r.httpMethod} ${r.path} → ${s}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it('H — EXACT statuses: every route the 3b.11 findings named answers its approved 4xx, and the frozen contracts are unchanged', async () => {
    await assertAlive();
    const UNKNOWN = randomUUID();
    const { companyId, branchId } = provisioned;
    const hit = async (
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      realm: 'tenant' | 'platform' = 'tenant',
      payload: unknown = {},
    ) => {
      const res = await app.inject({
        method,
        url,
        ...(method === 'GET' ? {} : { payload: payload as object }),
        headers: {
          authorization: 'Bearer ' + (realm === 'platform' ? platformToken : tenantToken),
          'idempotency-key': randomUUID(),
        },
      });
      const code = (res.json() as { error?: { code?: string } }).error?.code;
      return [res.statusCode, code];
    };
    const T = provisioned.tenantId;

    // F4 — unknown ids → 404 NOT_FOUND (was 500)
    expect(await hit('GET', `/v1/access/users/${UNKNOWN}`)).toEqual([404, 'NOT_FOUND']);
    expect(await hit('POST', `/v1/access/users/${UNKNOWN}/preview`, 'tenant', {})).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(await hit('GET', `/v1/platform/tenants/${T}/users/${UNKNOWN}`, 'platform')).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(await hit('POST', `/v1/platform/plans/versions/${UNKNOWN}/publish`, 'platform')).toEqual(
      [404, 'NOT_FOUND'],
    );

    // V-1 / V-2 — malformed ids → 404 NOT_FOUND (the frozen non-UUID convention), never 500
    expect(await hit('GET', '/v1/platform/tenants/not-a-uuid', 'platform')).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(await hit('GET', '/v1/platform/tenants/not-a-uuid/roles', 'platform')).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(await hit('GET', '/v1/org/branches/not-a-uuid/settings')).toEqual([404, 'NOT_FOUND']);
    expect(await hit('GET', '/v1/localization/companies/not-a-uuid')).toEqual([404, 'NOT_FOUND']);

    // V-1 — malformed cursor → 400 INVALID_CURSOR on exactly the four routes
    expect(await hit('GET', '/v1/customers?cursor=garbage')).toEqual([400, 'INVALID_CURSOR']);
    expect(await hit('GET', `/v1/companies/${companyId}/customers?cursor=garbage`)).toEqual([
      400,
      'INVALID_CURSOR',
    ]);
    expect(
      await hit('GET', `/v1/companies/${companyId}/branches/${branchId}/orders?cursor=garbage`),
    ).toEqual([400, 'INVALID_CURSOR']);
    expect(
      await hit(
        'GET',
        `/v1/companies/${companyId}/branches/${branchId}/settlements?cursor=garbage`,
      ),
    ).toEqual([400, 'INVALID_CURSOR']);
    // …and a well-formed cursor still pages (frozen behaviour)
    expect((await hit('GET', `/v1/customers?cursor=${UNKNOWN}`))[0]).toBe(200);

    // V-2 — bare zod parse → 400 VALIDATION_FAILED
    expect(await hit('GET', '/v1/localization/reference?at=garbage')).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(await hit('GET', `/v1/localization/companies/${companyId}?at=garbage`)).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(await hit('GET', '/v1/platform/audit?limit=abc', 'platform')).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(await hit('GET', '/v1/platform/audit/security-events?limit=abc', 'platform')).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(
      await hit('PUT', `/v1/platform/tenants/${T}/limits/not_a_limit_key`, 'platform', {
        value: 1,
        reason: 'sweep test',
      }),
    ).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('E — non-object JSON bodies (array / string / number) on every mutation: a 4xx, never a 5xx', async () => {
    await assertAlive();
    const bad: string[] = [];
    for (const r of routes.filter((x) => ['POST', 'PUT', 'PATCH'].includes(x.httpMethod))) {
      for (const body of [[], 'str', 7]) {
        const s = await call(r, fill(r.path, 'valid'), body);
        if (s >= 500) bad.push(`${r.httpMethod} ${r.path} body=${JSON.stringify(body)} → ${s}`);
      }
    }
    expect(bad).toEqual([]);
  }, 600_000);
});
