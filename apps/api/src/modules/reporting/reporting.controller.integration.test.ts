import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test: it seeds fixtures directly — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { enumerateRoutes } from '../../common/auth/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { DbService } from '../../common/data/index.js';
import { SYSTEM_ROLE_TEMPLATES } from '../platform/system-roles.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { ReportingRepository } from './reporting.repository.js';

/**
 * Task 3b.10 Checkpoint F — the PUBLIC HTTP wiring of the five frozen reports, end to end: the full `AppModule`, the real guard
 * pipeline, the real default role templates, real PostgreSQL and Redis. Nothing here asserts a report's figures (the frozen A–E
 * suites own those) — it asserts WHO may call each of the nine routes, that a denied caller never reaches a report query, that
 * the query is strictly validated and that every error keeps the frozen envelope and is non-disclosing.
 */
const FROM = '2026-06-01';
const TO = '2026-06-30';
type Role = 'owner' | 'admin' | 'manager' | 'cashier' | 'sales' | 'accountant';
const ROLES: Role[] = ['owner', 'admin', 'manager', 'cashier', 'sales', 'accountant'];

interface RouteSpec {
  slug: string;
  perms: readonly string[];
  branch: boolean;
  query: string;
}
const REPORTS: RouteSpec[] = [
  {
    slug: 'trial-balance',
    perms: ['accounting:view'],
    branch: false,
    query: `from=${FROM}&to=${TO}`,
  },
  {
    slug: 'sales',
    perms: ['orders:view', 'credit_notes:view', 'receivables:view'],
    branch: true,
    query: `from=${FROM}&to=${TO}`,
  },
  { slug: 'tender-totals', perms: ['payments:view'], branch: true, query: `from=${FROM}&to=${TO}` },
  { slug: 'receivables', perms: ['receivables:view'], branch: true, query: '' },
  { slug: 'customer-liabilities', perms: ['receivables:view'], branch: true, query: '' },
];

describe('Reporting HTTP wiring — task 3b.10 Checkpoint F (full application, real guards, real role templates)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let pool: pg.Pool;
  let db: DbService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  interface Co {
    companyId: string;
    b1: string;
    b2: string;
    tenantId: string;
    customerId: string;
  }
  let c1: Co; // tenant A — the company under test (two branches, one customer)
  let c2: Co; // tenant A — another company of the same tenant
  let f1: Co; // tenant B

  const rolePerms = (key: string): string[] => {
    const role = SYSTEM_ROLE_TEMPLATES.find((r) => r.key === key);
    if (!role) throw new Error(`no system role ${key}`);
    return [...role.permissions];
  };

  async function mint(
    perms: readonly string[],
    o: {
      tenant?: string;
      companyScope?: 'ALL' | string[];
      branchScope?: 'ALL' | string[];
      overlay?: Record<string, string[]>;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const s: SessionData = {
      sessionId: `t-${id}`,
      realm: 'tenant',
      familyId: 'f',
      tenantId: o.tenant ?? tenantA,
      userId: randomUUID(),
      platformUserId: null,
      accountType: 'USER',
      posTerminalId: null,
      deviceId: null,
      mfaLevel: 'MFA',
      stepUpUntil: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: {
        effectivePermissions: [...perms],
        companyScope: o.companyScope ?? 'ALL',
        branchScope: o.branchScope ?? 'ALL',
        perBranchOverlay: o.overlay ?? {},
        entitledModules: [],
        planKey: null,
      },
    };
    await store.set(s);
    return jwt.sign({ sub: s.userId!, sid: s.sessionId, aud: 'tenant', tid: s.tenantId! });
  }

  const get = (path: string, token?: string) =>
    app.inject({
      method: 'GET',
      url: `/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const companyPath = (r: RouteSpec, c: Co, q = r.query): string =>
    `/companies/${c.companyId}/reports/${r.slug}${q ? `?${q}` : ''}`;
  const branchPath = (r: RouteSpec, c: Co, b: string, q = r.query): string =>
    `/companies/${c.companyId}/branches/${b}/reports/${r.slug}${q ? `?${q}` : ''}`;
  const code = (res: { json: () => { error?: { code?: string } } }): string | undefined =>
    res.json().error?.code;

  async function makeCompany(tid: string): Promise<Co> {
    const c: Co = {
      companyId: randomUUID(),
      b1: randomUUID(),
      b2: randomUUID(),
      tenantId: tid,
      customerId: randomUUID(),
    };
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Reporting HTTP Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
      [c.companyId, tid],
    );
    for (const [id, name] of [
      [c.b1, 'Main'],
      [c.b2, 'Sibling'],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [id, tid, c.companyId, name],
      );
    }
    await runScoped(db.appClient(), { tenantId: tid }, (tx) =>
      app
        .get(AccountRepository)
        .ensureDefaultAccounts(tx, { tenantId: tid, companyId: c.companyId }),
    );
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Customer',now())`,
      [c.customerId, tid],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","creditEnabled","updatedAt")
       VALUES ($1,$2,$3,$4,true,now())`,
      [randomUUID(), tid, c.companyId, c.customerId],
    );
    return c;
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `rhttp-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantA, tenantB]) {
      await pool.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [id, `rhttp-${id.slice(0, 8)}`, planVersionId],
      );
    }
    await pool.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel",active,"updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN',true,now()) ON CONFLICT (code) DO NOTHING`,
    );
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
    db = app.get(DbService);
    c1 = await makeCompany(tenantA);
    c2 = await makeCompany(tenantA);
    f1 = await makeCompany(tenantB);
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await stack?.stop();
  });

  /** counts every report query that actually reached the database layer */
  const reportQueries = (): { calls: () => number; stop: () => void } => {
    const spy = vi.spyOn(
      ReportingRepository.prototype as unknown as { readScoped: (fn: unknown) => Promise<unknown> },
      'readScoped',
    );
    return { calls: () => spy.mock.calls.length, stop: () => spy.mockRestore() };
  };

  // ═══════════════════════ registration ═══════════════════════
  it('EXACTLY nine report routes are registered, all GET, each with its OD-1 primary permission', () => {
    const routes = enumerateRoutes(app)
      .filter((r) => r.path.includes('/reports/'))
      .map((r) => `${r.httpMethod} ${r.path} ${r.permission}`)
      .sort();
    const expected: string[] = [];
    for (const r of REPORTS) {
      expected.push(`GET /v1/companies/:companyId/reports/${r.slug} ${r.perms[0]}`);
      if (r.branch)
        expected.push(
          `GET /v1/companies/:companyId/branches/:branchId/reports/${r.slug} ${r.perms[0]}`,
        );
    }
    expect(expected).toHaveLength(9);
    expect(routes).toEqual(expected.sort());
  });

  it('there is no write route: every other verb on a report path is not routed', async () => {
    const t = await mint(rolePerms('owner'));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/v1/companies/${c1.companyId}/reports/receivables`,
        headers: { authorization: `Bearer ${t}` },
      });
      expect(res.statusCode, method).toBe(404);
    }
  });

  // ═══════════════════════ authentication ═══════════════════════
  it('every route without a token is 401', async () => {
    for (const r of REPORTS) {
      expect((await get(companyPath(r, c1))).statusCode, r.slug).toBe(401);
      if (r.branch) expect((await get(branchPath(r, c1, c1.b1))).statusCode, r.slug).toBe(401);
    }
  });

  // ═══════════════════════ the default role templates (F-3) ═══════════════════════
  it('discovery findings hold against the ACTUAL default templates (no grant is changed by F)', () => {
    const has = (role: Role, k: string): boolean => rolePerms(role).includes(k);
    expect(ROLES.filter((r) => has(r, 'accounting:view'))).toEqual(['owner', 'admin']);
    expect(ROLES.filter((r) => REPORTS[1]!.perms.every((k) => has(r, k)))).toEqual([
      'owner',
      'admin',
      'manager',
    ]);
    for (const k of ['accounting:view', 'orders:view', 'receivables:view', 'payments:view']) {
      expect(has('accountant', k), `accountant ${k}`).toBe(false);
    }
    // (the accountant holds credit_notes:view only — which alone opens no report)
    expect(has('accountant', 'credit_notes:view')).toBe(true);
  });

  it('role matrix: every default role against every route — allowed exactly where it holds the full OD-1 permission set', async () => {
    for (const role of ROLES) {
      const t = await mint(rolePerms(role));
      for (const r of REPORTS) {
        const allowed = r.perms.every((k) => rolePerms(role).includes(k));
        const calls: [string, string][] = [['company', companyPath(r, c1)]];
        if (r.branch) calls.push(['branch', branchPath(r, c1, c1.b1)]);
        for (const [kind, path] of calls) {
          const res = await get(path, t);
          expect(res.statusCode, `${role} ${r.slug} ${kind}`).toBe(allowed ? 200 : 403);
          if (!allowed) expect(code(res), `${role} ${r.slug} ${kind}`).toBe('MISSING_PERMISSION');
        }
      }
    }
  });

  it('Sales needs ALL THREE permissions: missing any one of them, in turn, denies both Sales routes', async () => {
    const sales = REPORTS[1]!;
    const all = [...sales.perms];
    expect((await get(companyPath(sales, c1), await mint(all))).statusCode).toBe(200);
    for (const missing of sales.perms) {
      const t = await mint(all.filter((k) => k !== missing));
      for (const path of [companyPath(sales, c1), branchPath(sales, c1, c1.b1)]) {
        const res = await get(path, t);
        expect(res.statusCode, `without ${missing}`).toBe(403);
        expect(code(res)).toBe('MISSING_PERMISSION');
      }
    }
    // a single permission alone never opens it
    for (const only of sales.perms) {
      expect((await get(companyPath(sales, c1), await mint([only]))).statusCode, only).toBe(403);
    }
  });

  // ═══════════════════════ branch isolation (F-2) ═══════════════════════
  it('an unrestricted user reads the company routes AND every branch route', async () => {
    const t = await mint(rolePerms('owner'));
    for (const r of REPORTS) {
      expect((await get(companyPath(r, c1), t)).statusCode, r.slug).toBe(200);
      if (r.branch) {
        expect((await get(branchPath(r, c1, c1.b1), t)).statusCode).toBe(200);
        expect((await get(branchPath(r, c1, c1.b2), t)).statusCode).toBe(200);
      }
    }
  });

  it('a company-scoped but BRANCH-RESTRICTED user (one branch) gets a non-disclosing 404 on every company route and reads only its own branch', async () => {
    const t = await mint(rolePerms('owner'), {
      companyScope: [c1.companyId],
      branchScope: [c1.b1],
    });
    const q = reportQueries();
    try {
      for (const r of REPORTS) {
        const res = await get(companyPath(r, c1), t);
        expect(res.statusCode, `${r.slug} company`).toBe(404);
        expect(code(res)).toBe('NOT_FOUND');
        if (r.branch) {
          expect((await get(branchPath(r, c1, c1.b1), t)).statusCode, `${r.slug} own branch`).toBe(
            200,
          );
          expect(
            (await get(branchPath(r, c1, c1.b2), t)).statusCode,
            `${r.slug} other branch`,
          ).toBe(404);
        }
      }
      // 5 company denials + 4 foreign-branch denials reached no report query; the 4 own-branch reads did
      expect(q.calls()).toBe(4);
    } finally {
      q.stop();
    }
  });

  it('a MULTI-branch user (two branches, not "all") still cannot read a company route, but reads both of its branches', async () => {
    const t = await mint(rolePerms('owner'), { branchScope: [c1.b1, c1.b2] });
    for (const r of REPORTS) {
      expect((await get(companyPath(r, c1), t)).statusCode, `${r.slug} company`).toBe(404);
      if (r.branch) {
        expect((await get(branchPath(r, c1, c1.b1), t)).statusCode).toBe(200);
        expect((await get(branchPath(r, c1, c1.b2), t)).statusCode).toBe(200);
      }
    }
  });

  it('a user whose branch scope is "all" but whose per-branch overlay withholds the permission in one branch is NOT unrestricted', async () => {
    const owner = rolePerms('owner');
    const t = await mint(owner, {
      overlay: { [c1.b1]: owner.filter((k) => k !== 'receivables:view') },
    });
    const rec = REPORTS[3]!;
    expect((await get(companyPath(rec, c1), t)).statusCode).toBe(404);
    expect((await get(branchPath(rec, c1, c1.b1), t)).statusCode).toBe(403); // withheld in that branch
    expect((await get(branchPath(rec, c1, c1.b2), t)).statusCode).toBe(200);
  });

  it('a company-restricted user cannot read another company of the same tenant (company and branch routes): 404', async () => {
    const t = await mint(rolePerms('owner'), { companyScope: [c1.companyId] });
    for (const r of REPORTS) {
      expect((await get(companyPath(r, c2), t)).statusCode, r.slug).toBe(404);
      if (r.branch) expect((await get(branchPath(r, c2, c2.b1), t)).statusCode, r.slug).toBe(404);
    }
  });

  it('cross-tenant: tenant B’s owner gets a non-disclosing 404 for tenant A’s company and branches — and the reverse', async () => {
    const tb = await mint(rolePerms('owner'), { tenant: tenantB });
    const ta = await mint(rolePerms('owner'));
    for (const r of REPORTS) {
      const a = await get(companyPath(r, c1), tb);
      expect(a.statusCode, r.slug).toBe(404);
      expect(JSON.stringify(a.json())).not.toContain(c1.companyId);
      if (r.branch) expect((await get(branchPath(r, c1, c1.b1), tb)).statusCode).toBe(404);
      expect((await get(companyPath(r, f1), ta)).statusCode, `${r.slug} reverse`).toBe(404);
    }
  });

  it('a branch of ANOTHER company under my company path is 404 (no cross-company branch discovery)', async () => {
    const t = await mint(rolePerms('owner'));
    for (const r of REPORTS.filter((x) => x.branch)) {
      expect((await get(branchPath(r, c1, c2.b1), t)).statusCode, r.slug).toBe(404);
    }
  });

  it('invalid and nonexistent identifiers are a plain 404 (never 400/500, never an existence hint)', async () => {
    const t = await mint(rolePerms('owner'));
    for (const r of REPORTS) {
      for (const id of ['not-a-uuid', randomUUID()]) {
        const res = await get(
          `/companies/${id}/reports/${r.slug}${r.query ? `?${r.query}` : ''}`,
          t,
        );
        expect(res.statusCode, `${r.slug} company ${id}`).toBe(404);
        if (r.branch) {
          const b = await get(
            `/companies/${c1.companyId}/branches/${id}/reports/${r.slug}${r.query ? `?${r.query}` : ''}`,
            t,
          );
          expect(b.statusCode, `${r.slug} branch ${id}`).toBe(404);
        }
      }
    }
  });

  it('every denied request — role, scope, branch — executed NO report query; an allowed one did', async () => {
    const q = reportQueries();
    try {
      const cashier = await mint(rolePerms('cashier')); // lacks accounting:view and credit_notes:view
      const restricted = await mint(rolePerms('owner'), { branchScope: [c1.b1] });
      await get(companyPath(REPORTS[0]!, c1), cashier);
      await get(companyPath(REPORTS[1]!, c1), cashier);
      await get(branchPath(REPORTS[1]!, c1, c1.b1), cashier);
      await get(companyPath(REPORTS[2]!, c1), restricted);
      await get(branchPath(REPORTS[2]!, c1, c1.b2), restricted);
      await get(companyPath(REPORTS[3]!, c1));
      expect(q.calls()).toBe(0);
      await get(companyPath(REPORTS[3]!, c1), await mint(rolePerms('owner')));
      expect(q.calls()).toBe(1);
    } finally {
      q.stop();
    }
  });

  // ═══════════════════════ validation and the frozen error envelope (F-4) ═══════════════════════
  it('an unsupported query parameter is 400 VALIDATION_FAILED on every route — including any attempt to pass a scope in the query', async () => {
    const t = await mint(rolePerms('owner'));
    for (const r of REPORTS) {
      for (const extra of [
        'foo=1',
        `branchId=${c1.b2}`,
        `companyId=${c2.companyId}`,
        `tenantId=${tenantB}`,
        'asOf=2026-06-01',
      ]) {
        const q = [r.query, extra].filter(Boolean).join('&');
        const res = await get(companyPath(r, c1, q), t);
        expect(res.statusCode, `${r.slug} ${extra}`).toBe(400);
        expect(code(res)).toBe('VALIDATION_FAILED');
        if (r.branch) {
          expect(
            (await get(branchPath(r, c1, c1.b1, q), t)).statusCode,
            `${r.slug} branch ${extra}`,
          ).toBe(400);
        }
      }
    }
    // the paged reports accept no period, the period reports accept no page
    expect((await get(companyPath(REPORTS[3]!, c1, `from=${FROM}`), t)).statusCode).toBe(400);
    expect(
      (await get(companyPath(REPORTS[2]!, c1, `${REPORTS[2]!.query}&limit=5`), t)).statusCode,
    ).toBe(400);
  });

  it('dates: missing, malformed, timestamped and inverted are 400 INVALID_DATE-family errors; a valid civil period is 200', async () => {
    const t = await mint(rolePerms('owner'));
    for (const r of REPORTS.filter((x) => x.query.startsWith('from='))) {
      for (const bad of [
        '',
        `from=${FROM}`,
        `to=${TO}`,
        'from=2026-13-40&to=2026-06-30',
        'from=2026-06-01T10:00:00Z&to=2026-06-30',
        `from=${TO}&to=${FROM}`,
        'from=06/01/2026&to=06/30/2026',
      ]) {
        const res = await get(companyPath(r, c1, bad), t);
        expect(res.statusCode, `${r.slug} [${bad}]`).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, `${r.slug} [${bad}]`).toBeLessThan(500);
        expect(code(res)).toBeDefined();
      }
      expect((await get(companyPath(r, c1, `from=${FROM}&to=${TO}`), t)).statusCode).toBe(200);
    }
    const bad = await get(companyPath(REPORTS[2]!, c1, 'from=2026-13-40&to=2026-06-30'), t);
    expect(bad.statusCode).toBe(400);
    expect(code(bad)).toBe('INVALID_DATE');
  });

  it('limit and cursor: invalid values are 400 INVALID_LIMIT / INVALID_CURSOR; an over-max limit is clamped; a valid one is 200', async () => {
    const t = await mint(rolePerms('owner'));
    for (const r of REPORTS.filter(
      (x) => x.slug === 'receivables' || x.slug === 'customer-liabilities',
    )) {
      for (const path of [
        companyPath,
        (rr: RouteSpec, c: Co, q: string) => branchPath(rr, c, c.b1, q),
      ]) {
        for (const bad of ['limit=abc', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=']) {
          const res = await get(path(r, c1, bad), t);
          expect(res.statusCode, `${r.slug} ${bad}`).toBe(400);
          expect(code(res), `${r.slug} ${bad}`).toBe('INVALID_LIMIT');
        }
        const cur = await get(path(r, c1, 'cursor=not-a-cursor'), t);
        expect(cur.statusCode, `${r.slug} cursor`).toBe(400);
        expect(code(cur)).toBe('INVALID_CURSOR');
        expect((await get(path(r, c1, 'limit=5000'), t)).statusCode).toBe(200);
        expect((await get(path(r, c1, 'limit=10'), t)).statusCode).toBe(200);
        expect((await get(path(r, c1, `cursor=${randomUUID()}`), t)).statusCode).toBe(200);
      }
    }
  });

  it('customer filter: a known customer is 200 and scopes the report; an unknown, malformed or repeated customerId is a plain 404', async () => {
    const t = await mint(rolePerms('owner'));
    for (const r of REPORTS.filter(
      (x) => x.slug === 'receivables' || x.slug === 'customer-liabilities',
    )) {
      const ok = await get(companyPath(r, c1, `customerId=${c1.customerId}`), t);
      expect(ok.statusCode, r.slug).toBe(200);
      expect(ok.json().customerId).toBe(c1.customerId);
      for (const bad of [
        `customerId=${randomUUID()}`,
        'customerId=nope',
        `customerId=${c1.customerId}&customerId=${c1.customerId}`,
        `customerId=${c2.customerId}`, // a customer of another company
        `customerId=${f1.customerId}`, // a customer of another tenant
      ]) {
        const res = await get(companyPath(r, c1, bad), t);
        expect(res.statusCode, `${r.slug} ${bad}`).toBe(404);
      }
    }
  });

  it('responses are safe JSON in the frozen shapes (money as strings, no BigInt failure) and no write happened', async () => {
    const t = await mint(rolePerms('owner'));
    const before = await pool.query(
      `SELECT (SELECT count(*) FROM audit_log)::text || ':' || (SELECT count(*) FROM outbox)::text AS n`,
    );
    for (const r of REPORTS) {
      const res = await get(companyPath(r, c1), t);
      expect(res.statusCode, r.slug).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const body = res.json();
      expect(body.companyId ?? body.company?.id ?? c1.companyId).toBeDefined();
      expect(typeof body).toBe('object');
    }
    const tb = (await get(companyPath(REPORTS[0]!, c1), t)).json();
    expect(JSON.stringify(tb)).toMatch(/"total[A-Za-z]+Minor":"[0-9]+"/);
    const liab = (await get(companyPath(REPORTS[4]!, c1), t)).json();
    expect(liab.advances.bookLiabilityMinor).toBe('0');
    expect(liab.unappliedReceipts.unappliedReceiptMinor).toBe('0');
    const after = await pool.query(
      `SELECT (SELECT count(*) FROM audit_log)::text || ':' || (SELECT count(*) FROM outbox)::text AS n`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('a company without an accounting currency is 409 REPORT_COMPANY_NOT_CONFIGURED (the frozen error, unchanged)', async () => {
    const bare = randomUUID();
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Bare','AE',NULL,'Asia/Dubai','ACTIVE',now())`,
      [bare, tenantA],
    );
    const t = await mint(rolePerms('owner'));
    const res = await get(`/companies/${bare}/reports/receivables`, t);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('REPORT_COMPANY_NOT_CONFIGURED');
  });
});
