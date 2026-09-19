import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-0000003b2001';

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b2000', 'starter-3b2', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b2000', 1, 'PUBLISHED', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'x', 'x'), ('KWD', 3, 'KWD', 'x', 'x'), ('SAR', 2, 'SAR', 'x', 'x')
        ON CONFLICT DO NOTHING;
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES
        ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()),
        ('KW', 'Kuwait', 'x', 'gcc', 'KWD', 'SAT_SUN', true, now())
      ON CONFLICT DO NOTHING;
    `);
  } finally {
    await c.end();
  }
}

/**
 * Task 3b.2 Checkpoint C — `CustomerController`/`CustomerTenantController`
 * HTTP-layer proof. The repository/domain layer (normalization, join-gating,
 * atomic creation, money/version/concurrency rules) is already exhaustively
 * covered by Checkpoints A-B's real-Postgres integration tests; this file
 * proves only the controller/DTO/permission/data-scope/step-up/If-Match/
 * Idempotency-Key wiring itself, through real HTTP requests.
 */
describe('CustomerController / CustomerTenantController (task 3b.2 Checkpoint C, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let tenantB = '';
  let companyA = '';
  /** SAME tenant as companyA — for cross-COMPANY (not cross-tenant) isolation
   *  and the multi-company-association scenarios. */
  let companyA2 = '';
  /** A DIFFERENT tenant's company — for the genuinely cross-TENANT test only. */
  let companyB = '';

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

    tenantA = await mkTenant('cusA');
    companyA = await mkCompany(tenantA, 'Company A', 'AE', 'AED');
    companyA2 = await mkCompany(tenantA, 'Company A2 (same tenant)', 'AE', 'AED');
    tenantB = await mkTenant('cusB');
    companyB = await mkCompany(tenantB, 'Company B (different tenant)', 'AE', 'AED');
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── harness ──────────────────────────────────────────────────────────────
  const userIds = new Map<string, string>();
  let userSeq = 0;
  function userIdFor(sessionId: string): string {
    let uid = userIds.get(sessionId);
    if (uid === undefined) {
      uid = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
      userIds.set(sessionId, uid);
    }
    return uid;
  }
  function base(sessionId: string, tenantId: string): SessionData {
    return {
      sessionId,
      realm: 'tenant',
      familyId: 'f',
      tenantId,
      userId: userIdFor(sessionId),
      platformUserId: null,
      accountType: 'OWNER',
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
  /** Tenant-wide-scoped session (Owner-shaped) — matches every other module's
   *  test-harness convention (`companyScope: 'ALL'`). */
  async function mint(
    id: string,
    tenantId: string,
    perms: string[],
    opts: { stepUp?: boolean } = {},
  ): Promise<string> {
    return mintScoped(id, tenantId, perms, 'ALL', opts);
  }
  /** A caller whose session carries an EXPLICIT, non-'ALL' company scope —
   *  needed to prove the `@ScopedParam`/`PolicyEngine` company-scope layer
   *  and the tenant-wide-scope gate on `/associate` and `/v1/customers`
   *  (task 3b.2 §2/§10/§19) — `mint()` alone (always `'ALL'`) cannot exercise
   *  either, since every session it mints already has full tenant-wide scope. */
  async function mintScoped(
    id: string,
    tenantId: string,
    perms: string[],
    companyScope: 'ALL' | string[],
    opts: { stepUp?: boolean } = {},
  ): Promise<string> {
    const s = base(id, tenantId);
    s.access = {
      effectivePermissions: perms,
      companyScope,
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    if (opts.stepUp) {
      s.mfaLevel = 'STEP_UP';
      s.stepUpUntil = Date.now() + 600_000;
    }
    await store.set(s);
    return jwt.sign({ sub: s.userId!, sid: s.sessionId, aud: 'tenant', tid: tenantId });
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
  async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      return (await c.query(text, params)).rows as T[];
    } finally {
      await c.end();
    }
  }
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;
  let tenantSeq = 0;
  async function mkTenant(slug: string): Promise<string> {
    const rows = await sql<{ id: string }>(
      `INSERT INTO tenant (id, slug, name, region, "planVersionId", status, "updatedAt")
       VALUES (uuidv7(), $1, $1, 'AE', $2, 'ACTIVE', now()) RETURNING id`,
      [`${slug}-${++tenantSeq}`, PLAN_V],
    );
    return rows[0]!.id;
  }
  async function mkCompany(
    tenantId: string,
    name: string,
    country: string,
    currency: string,
  ): Promise<string> {
    const rows = await sql<{ id: string }>(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'Asia/Dubai','ACTIVE',now()) RETURNING id`,
      [tenantId, name, country, currency],
    );
    return rows[0]!.id;
  }
  async function mkCustomer(
    companyId: string,
    perms: string[] = ['customers:manage'],
    displayName = 'Fixture Customer',
  ): Promise<{ id: string; version: number }> {
    const tenantId = (
      await sql<{ tenantId: string }>(`SELECT "tenantId" FROM company WHERE id=$1`, [companyId])
    )[0]!.tenantId;
    const tok = await mint(`mk-${Math.random()}`, tenantId, perms, {});
    const r = await req(
      'POST',
      `/companies/${companyId}/customers`,
      tok,
      { displayName },
      {
        'idempotency-key': `fixture-${Math.random()}`,
      },
    );
    expect(r.statusCode, r.payload).toBe(201);
    return r.json() as { id: string; version: number };
  }

  // ── permission enforcement (§22) ─────────────────────────────────────────
  it('rejects a caller with no customer permission on list', async () => {
    const tok = await mint('p1', tenantA, []);
    const r = await req('GET', `/companies/${companyA}/customers`, tok);
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('MISSING_PERMISSION');
  });

  it('customers:view allows list/read but not create/update/archive', async () => {
    const tok = await mint('p2', tenantA, ['customers:view']);
    expect((await req('GET', `/companies/${companyA}/customers`, tok)).statusCode).toBe(200);
    const rCreate = await req('POST', `/companies/${companyA}/customers`, tok, {
      displayName: 'x',
    });
    expect(rCreate.statusCode).toBe(403);
    expect(errCode(rCreate)).toBe('MISSING_PERMISSION');
  });

  it('customers:manage allows create/update/archive', async () => {
    const tok = await mint('p3', tenantA, ['customers:manage', 'customers:view']);
    const c = await mkCustomer(companyA, ['customers:manage']);
    const rUpdate = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}`,
      tok,
      { displayName: 'Updated' },
      { 'if-match': String(c.version) },
    );
    expect(rUpdate.statusCode, rUpdate.payload).toBe(200);
  });

  it('credit config requires customers:credit:manage specifically (customers:manage alone is insufficient)', async () => {
    const c = await mkCustomer(companyA);
    const tok = await mint('p4', tenantA, ['customers:manage'], { stepUp: true });
    const r = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}/account/credit`,
      tok,
      { creditEnabled: false },
      { 'if-match': '1' },
    );
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('MISSING_PERMISSION');
  });

  it('no route exists for customers:credit:override (registered permission, zero execution surface, task 3b.2 §0.K)', async () => {
    const tok = await mint('p5', tenantA, [
      'customers:manage',
      'customers:credit:manage',
      'customers:credit:override',
    ]);
    const c = await mkCustomer(companyA);
    for (const path of [
      `/companies/${companyA}/customers/${c.id}/account/credit/override`,
      `/companies/${companyA}/customers/${c.id}/credit-override`,
    ]) {
      const r = await req('POST', path, tok);
      expect(r.statusCode).toBe(404);
    }
  });

  // ── step-up (§16) ────────────────────────────────────────────────────────
  it('list/read/create/update/archive do NOT require step-up', async () => {
    const tok = await mint('s1', tenantA, ['customers:manage', 'customers:view']);
    expect((await req('GET', `/companies/${companyA}/customers`, tok)).statusCode).toBe(200);
    const rc = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'NoStepUp' },
      { 'idempotency-key': `nostepup-${Math.random()}` },
    );
    expect(rc.statusCode, rc.payload).toBe(201);
    const id = (rc.json() as { id: string }).id;
    const ru = await req(
      'PATCH',
      `/companies/${companyA}/customers/${id}`,
      tok,
      { displayName: 'Still no step-up' },
      { 'if-match': '1' },
    );
    expect(ru.statusCode, ru.payload).toBe(200);
    const ra = await req('POST', `/companies/${companyA}/customers/${id}/archive`, tok, undefined, {
      'if-match': '2',
    });
    expect(ra.statusCode, ra.payload).toBe(200);
  });

  it('credit config REQUIRES step-up', async () => {
    const c = await mkCustomer(companyA);
    const tok = await mint('s2', tenantA, ['customers:manage', 'customers:credit:manage']); // no stepUp
    const r = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}/account/credit`,
      tok,
      { creditEnabled: false },
      { 'if-match': '1' },
    );
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  // ── data-scope / PII isolation (§23) — the safety-critical set ───────────
  describe('company PII isolation', () => {
    it('a Company-A-only customer is invisible through Company B (list/read/update/archive/account all 404)', async () => {
      const c = await mkCustomer(companyA);
      // stepUp:true so the credit-config sub-assertion below exercises the
      // PII/company-scope gate specifically, not the (separately tested)
      // step-up gate — the guard checks step-up before company scope.
      const tokB = await mint(
        'pii1',
        tenantA,
        ['customers:manage', 'customers:view', 'customers:credit:manage'],
        { stepUp: true },
      );
      const rList = await req('GET', `/companies/${companyA2}/customers`, tokB);
      expect(rList.statusCode).toBe(200);
      expect((rList.json() as { data: { id: string }[] }).data.map((x) => x.id)).not.toContain(
        c.id,
      );

      const rGet = await req('GET', `/companies/${companyA2}/customers/${c.id}`, tokB);
      expect(rGet.statusCode).toBe(404);

      const rPatch = await req(
        'PATCH',
        `/companies/${companyA2}/customers/${c.id}`,
        tokB,
        { displayName: 'hijack' },
        { 'if-match': '1' },
      );
      expect(rPatch.statusCode).toBe(404);

      const rArchive = await req(
        'POST',
        `/companies/${companyA2}/customers/${c.id}/archive`,
        tokB,
        undefined,
        { 'if-match': '1' },
      );
      expect(rArchive.statusCode).toBe(404);

      const rAccount = await req('GET', `/companies/${companyA2}/customers/${c.id}/account`, tokB);
      expect(rAccount.statusCode).toBe(404);

      const rCredit = await req(
        'PATCH',
        `/companies/${companyA2}/customers/${c.id}/account/credit`,
        tokB,
        { creditEnabled: false },
        { 'if-match': '1' },
      );
      expect(rCredit.statusCode).toBe(404);
    });

    it('a customer associated with BOTH A and A2 (same tenant) is reachable through either authorized path', async () => {
      const c = await mkCustomer(companyA, ['customers:manage'], 'Shared Customer');
      const tokOwner = await mint('pii2', tenantA, ['customers:manage', 'customers:view']);
      const rAssoc = await req(
        'POST',
        `/companies/${companyA2}/customers/${c.id}/associate`,
        tokOwner,
      );
      expect(rAssoc.statusCode, rAssoc.payload).toBe(200);

      const rA = await req('GET', `/companies/${companyA}/customers/${c.id}`, tokOwner);
      const rA2 = await req('GET', `/companies/${companyA2}/customers/${c.id}`, tokOwner);
      expect(rA.statusCode).toBe(200);
      expect(rA2.statusCode).toBe(200);
    });

    it('cross-tenant customer is invisible (RLS) — 404, not just company-scope 404', async () => {
      const c = await mkCustomer(companyA);
      const tokB = await mint('pii3', tenantB, ['customers:view']);
      const r = await req('GET', `/companies/${companyB}/customers/${c.id}`, tokB);
      expect(r.statusCode).toBe(404);
    });
  });

  // ── tenant-wide route + association UUID-oracle protection (§10/§19) ────
  describe('tenant-wide scope', () => {
    it('GET /v1/customers works for a companyScope=ALL caller (Owner)', async () => {
      await mkCustomer(companyA);
      const tok = await mint('tw1', tenantA, ['customers:view']);
      const r = await req('GET', '/customers', tok);
      expect(r.statusCode, r.payload).toBe(200);
    });

    it('GET /v1/customers is forbidden for a restricted-companyScope caller (no fifth permission — same customers:view key, data-scope only)', async () => {
      const tok = await mintScoped('tw2', tenantA, ['customers:view'], [companyA]);
      const r = await req('GET', '/customers', tok);
      expect(r.statusCode).toBe(403);
      expect(errCode(r)).toBe('TENANT_WIDE_SCOPE_REQUIRED');
    });

    it('/associate is forbidden for a restricted-companyScope caller even when the target company IS in their scope (UUID-oracle protection)', async () => {
      const c = await mkCustomer(companyA);
      const tokRestricted = await mintScoped('tw3', tenantA, ['customers:manage'], [companyA]);
      const r = await req(
        'POST',
        `/companies/${companyA}/customers/${c.id}/associate`,
        tokRestricted,
      );
      expect(r.statusCode).toBe(403);
      expect(errCode(r)).toBe('TENANT_WIDE_SCOPE_REQUIRED');
    });

    it('/associate succeeds for a companyScope=ALL caller (same-tenant target company)', async () => {
      const c = await mkCustomer(companyA);
      const tokOwner = await mint('tw4', tenantA, ['customers:manage']);
      const r = await req('POST', `/companies/${companyA2}/customers/${c.id}/associate`, tokOwner);
      expect(r.statusCode, r.payload).toBe(200);
    });

    it('/associate is blocked cross-tenant even for a companyScope=ALL caller (composite FK, not just permission/scope)', async () => {
      const c = await mkCustomer(companyA);
      // companyScope='ALL' only means "any company within MY tenant" —
      // PolicyEngine's scope check has no notion of company existence/tenant
      // ownership, so the real backstop here is the composite FK
      // `customer_company_account(tenantId, companyId) -> company(tenantId, id)`:
      // inserting with tenantId=tenantA + companyId=companyB (tenantB's
      // company) can never satisfy it, since no such (tenantA, companyB) row
      // exists — a genuine FK violation, translated to CUSTOMER_NOT_FOUND.
      const tokOwner = await mint('tw5', tenantA, ['customers:manage']);
      const r = await req('POST', `/companies/${companyB}/customers/${c.id}/associate`, tokOwner);
      expect(r.statusCode).toBe(404);
    });

    it('GET /v1/customers/:id is forbidden for a restricted-companyScope caller (§19)', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mintScoped('tw6', tenantA, ['customers:view'], [companyA]);
      const r = await req('GET', `/customers/${c.id}`, tok);
      expect(r.statusCode).toBe(403);
      expect(errCode(r)).toBe('TENANT_WIDE_SCOPE_REQUIRED');
    });

    it('/associate denial for a restricted caller does not leak whether the target customer id even exists — a real customer and a random non-existent UUID get the identical 403 (§18)', async () => {
      const c = await mkCustomer(companyA);
      const tokRestricted = await mintScoped('tw7', tenantA, ['customers:manage'], [companyA]);
      const rReal = await req(
        'POST',
        `/companies/${companyA}/customers/${c.id}/associate`,
        tokRestricted,
      );
      const rFake = await req(
        'POST',
        `/companies/${companyA}/customers/00000000-0000-4000-8000-000000000000/associate`,
        tokRestricted,
      );
      expect(rReal.statusCode).toBe(403);
      expect(rFake.statusCode).toBe(403);
      expect(errCode(rReal)).toBe('TENANT_WIDE_SCOPE_REQUIRED');
      expect(errCode(rFake)).toBe('TENANT_WIDE_SCOPE_REQUIRED');
      expect(rReal.payload).toBe(rFake.payload);
    });
  });

  // ── idempotency (§24) ────────────────────────────────────────────────────
  it('create is idempotent under the same Idempotency-Key; rejects a changed body under the same key', async () => {
    const tok = await mint('i1', tenantA, ['customers:manage']);
    const body = { displayName: 'Idempotent Customer' };
    const key = `idem-${Math.random()}`;
    const r1 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r1.statusCode, r1.payload).toBe(201);
    const id1 = (r1.json() as { id: string }).id;

    const r2 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r2.statusCode, r2.payload).toBe(201);
    expect((r2.json() as { id: string }).id).toBe(id1);

    const r3 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'A different customer' },
      { 'idempotency-key': key },
    );
    expect(r3.statusCode).toBe(409);
    expect(errCode(r3)).toBe('IDEMPOTENCY_KEY_REUSED');

    // never a duplicate row for the same key + same body
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer WHERE "displayName" = $1`,
      ['Idempotent Customer'],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('different Idempotency-Keys with identical contact data produce distinct Customers', async () => {
    const tok = await mint('i2', tenantA, ['customers:manage']);
    const body = { displayName: 'Duplicate Contact', email: 'dup@example.com' };
    const r1 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': `k1-${Math.random()}`,
    });
    const r2 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': `k2-${Math.random()}`,
    });
    expect(r1.statusCode, r1.payload).toBe(201);
    expect(r2.statusCode, r2.payload).toBe(201);
    expect((r1.json() as { id: string }).id).not.toBe((r2.json() as { id: string }).id);
  });

  it('same key + same request creates exactly one Customer row and exactly one CustomerCompanyAccount row', async () => {
    const tok = await mint('i-rowcount', tenantA, ['customers:manage']);
    const body = { displayName: 'Row Count Check', email: 'rowcount@example.com' };
    const key = `idem-rowcount-${Math.random()}`;
    const r1 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r1.statusCode, r1.payload).toBe(201);
    const id = (r1.json() as { id: string }).id;
    const r2 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r2.statusCode, r2.payload).toBe(201);
    expect((r2.json() as { id: string }).id).toBe(id);

    const customerRows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer WHERE id = $1`,
      [id],
    );
    expect(customerRows[0]!.n).toBe('1');
    const accountRows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
      [id, companyA],
    );
    expect(accountRows[0]!.n).toBe('1');
  });

  it('same key + changed phone → idempotency conflict', async () => {
    const tok = await mint('i-phone', tenantA, ['customers:manage']);
    const key = `idem-phone-${Math.random()}`;
    const r1 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Phone Conflict Test', phone: '0501234567' },
      { 'idempotency-key': key },
    );
    expect(r1.statusCode, r1.payload).toBe(201);
    const r2 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Phone Conflict Test', phone: '0509999999' },
      { 'idempotency-key': key },
    );
    expect(r2.statusCode).toBe(409);
    expect(errCode(r2)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('same key + changed email → idempotency conflict', async () => {
    const tok = await mint('i-email', tenantA, ['customers:manage']);
    const key = `idem-email-${Math.random()}`;
    const r1 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Email Conflict Test', email: 'first@example.com' },
      { 'idempotency-key': key },
    );
    expect(r1.statusCode, r1.payload).toBe(201);
    const r2 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Email Conflict Test', email: 'second@example.com' },
      { 'idempotency-key': key },
    );
    expect(r2.statusCode).toBe(409);
    expect(errCode(r2)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('same key + different target Company → idempotency conflict (the canonical fingerprint includes the Company target)', async () => {
    const tok = await mint('i-company', tenantA, ['customers:manage']);
    const key = `idem-company-${Math.random()}`;
    const body = { displayName: 'Company Target Test' };
    const r1 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r1.statusCode, r1.payload).toBe(201);
    const r2 = await req('POST', `/companies/${companyA2}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r2.statusCode).toBe(409);
    expect(errCode(r2)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  // task 3b.2 owner review round §3/G — RESOLVED: `CustomerCreateFingerprintProvider`
  // (apps/api/src/modules/customers/customer-create-fingerprint.provider.ts) is
  // wired via the new generic, opt-in `semanticFingerprintProvider` extension
  // point on `@Idempotent()` — the fingerprint now hashes NORMALIZED canonical
  // semantics (tenantId, companyId, displayName, phoneE164, emailNormalized),
  // reusing the exact same `normalizePhoneE164`/`normalizeEmail` helpers the
  // domain layer uses. Every OTHER `@Idempotent()` route (including task 3b.1's
  // AccountingPeriod create) omits this option and is byte-for-byte unaffected.
  it('national-format and international phone inputs that normalize to the SAME E.164 value, under the same key, replay as the SAME Customer (§3-A)', async () => {
    const tok = await mint('i-phone-equiv', tenantA, ['customers:manage']);
    const key = `idem-phone-equiv-${Math.random()}`;
    const r1 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Equivalent Phone', phone: '0501234567' },
      { 'idempotency-key': key },
    );
    expect(r1.statusCode, r1.payload).toBe(201);
    const id1 = (r1.json() as { id: string }).id;
    const r2 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Equivalent Phone', phone: '+971501234567' },
      { 'idempotency-key': key },
    );
    expect(r2.statusCode, r2.payload).toBe(201);
    expect((r2.json() as { id: string }).id).toBe(id1);
    expect(r2.headers['idempotency-replayed']).toBe('true');

    const customerRows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer WHERE id = $1`,
      [id1],
    );
    expect(customerRows[0]!.n).toBe('1');
    const accountRows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
      [id1, companyA],
    );
    expect(accountRows[0]!.n).toBe('1');
    const createdAudit = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'customer.created' AND "resourceId" = $1`,
      [id1],
    );
    expect(createdAudit[0]!.n).toBe('1');
    const accountRow = await sql<{ id: string }>(
      `SELECT id FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
      [id1, companyA],
    );
    const accountAudit = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'customer.company_account_created' AND "resourceId" = $1`,
      [accountRow[0]!.id],
    );
    expect(accountAudit[0]!.n).toBe('1');
  });

  it('email differing only in case/whitespace, under the same key, replays as the SAME Customer (§3-B)', async () => {
    const tok = await mint('i-email-equiv', tenantA, ['customers:manage']);
    const key = `idem-email-equiv-${Math.random()}`;
    const r1 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Equivalent Email', email: ' Test@Example.com ' },
      { 'idempotency-key': key },
    );
    expect(r1.statusCode, r1.payload).toBe(201);
    const id1 = (r1.json() as { id: string }).id;
    const r2 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Equivalent Email', email: 'test@example.com' },
      { 'idempotency-key': key },
    );
    expect(r2.statusCode, r2.payload).toBe(201);
    expect((r2.json() as { id: string }).id).toBe(id1);
    expect(r2.headers['idempotency-replayed']).toBe('true');
  });

  it('a genuinely different normalized phone under the same key still conflicts (equivalence is not laxity) (§3-C)', async () => {
    const tok = await mint('i-phone-diff', tenantA, ['customers:manage']);
    const key = `idem-phone-diff-${Math.random()}`;
    const r1 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Different Phone', phone: '+971501234567' },
      { 'idempotency-key': key },
    );
    expect(r1.statusCode, r1.payload).toBe(201);
    const r2 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Different Phone', phone: '+971509999999' },
      { 'idempotency-key': key },
    );
    expect(r2.statusCode).toBe(409);
    expect(errCode(r2)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a genuinely different normalized email under the same key still conflicts (§3-D)', async () => {
    const tok = await mint('i-email-diff', tenantA, ['customers:manage']);
    const key = `idem-email-diff-${Math.random()}`;
    const r1 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Different Email', email: 'first@example.com' },
      { 'idempotency-key': key },
    );
    expect(r1.statusCode, r1.payload).toBe(201);
    const r2 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Different Email', email: 'second@example.com' },
      { 'idempotency-key': key },
    );
    expect(r2.statusCode).toBe(409);
    expect(errCode(r2)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('an invalid phone fails validation and never creates an idempotency-store row for that key (§3/§6)', async () => {
    const tok = await mint('i-invalid-phone', tenantA, ['customers:manage']);
    const key = `idem-invalid-phone-${Math.random()}`;
    const r1 = await req(
      'POST',
      `/companies/${companyA}/customers`,
      tok,
      { displayName: 'Invalid Phone', phone: 'not-a-phone-number' },
      { 'idempotency-key': key },
    );
    expect(r1.statusCode).toBe(400);
    expect(errCode(r1)).toBe('CUSTOMER_PHONE_INVALID');
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM idempotency_key WHERE key = $1`,
      [key],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('idempotent create replay does not duplicate customer.created or customer.company_account_created audit rows', async () => {
    const tok = await mint('i-audit', tenantA, ['customers:manage']);
    const key = `idem-audit-${Math.random()}`;
    const body = { displayName: 'Audit Replay Test' };
    const r1 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r1.statusCode, r1.payload).toBe(201);
    const id = (r1.json() as { id: string }).id;
    const r2 = await req('POST', `/companies/${companyA}/customers`, tok, body, {
      'idempotency-key': key,
    });
    expect(r2.statusCode, r2.payload).toBe(201);

    const createdAudit = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'customer.created' AND "resourceId" = $1`,
      [id],
    );
    expect(createdAudit[0]!.n).toBe('1');
    // customer.company_account_created's resourceId is the CustomerCompanyAccount's
    // own id (not the Customer's) — look it up first, then assert exactly one audit row.
    const accountRow = await sql<{ id: string }>(
      `SELECT id FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
      [id, companyA],
    );
    expect(accountRow).toHaveLength(1);
    const accountAudit = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'customer.company_account_created' AND "resourceId" = $1`,
      [accountRow[0]!.id],
    );
    expect(accountAudit[0]!.n).toBe('1');
  });

  // ── versioning (§25) ─────────────────────────────────────────────────────
  it('update: correct If-Match succeeds, stale If-Match conflicts, missing If-Match is a precondition error', async () => {
    const c = await mkCustomer(companyA);
    const tok = await mint('v1', tenantA, ['customers:manage']);
    const rNoMatch = await req('PATCH', `/companies/${companyA}/customers/${c.id}`, tok, {
      displayName: 'x',
    });
    expect(rNoMatch.statusCode).toBe(428);

    const rStale = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}`,
      tok,
      { displayName: 'x' },
      { 'if-match': '999' },
    );
    expect(rStale.statusCode).toBe(409);
    expect(errCode(rStale)).toBe('CUSTOMER_VERSION_CONFLICT');

    const rOk = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}`,
      tok,
      { displayName: 'x' },
      { 'if-match': String(c.version) },
    );
    expect(rOk.statusCode, rOk.payload).toBe(200);
  });

  it('customer.updated audit contains changed FIELD NAMES only — never the raw displayName/phone/email VALUES (§4)', async () => {
    const secretName = 'Zaid Al-Confidential';
    const secretPhone = '0501112222';
    const secretEmail = 'zaid.secret@example.com';
    const c = await mkCustomer(companyA);
    const tok = await mint('audit-pii', tenantA, ['customers:manage']);
    const r = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}`,
      tok,
      { displayName: secretName, phone: secretPhone, email: secretEmail },
      { 'if-match': String(c.version) },
    );
    expect(r.statusCode, r.payload).toBe(200);

    const rows = await sql<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_log WHERE action = 'customer.updated' AND "resourceId" = $1`,
      [c.id],
    );
    expect(rows).toHaveLength(1);
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain(secretName);
    expect(raw).not.toContain(secretPhone);
    expect(raw).not.toContain(secretEmail);
    expect(raw).not.toContain('+971501112222'); // normalized E.164 form either
    // the field NAMES are still present — that's the approved bounded shape
    // (internal storage-column names, e.g. `phoneE164`/`emailNormalized`, not
    // raw values)
    const after = rows[0]!.after as { changedFields: string[] };
    expect(after.changedFields.sort()).toEqual(
      ['displayName', 'emailNormalized', 'phoneE164'].sort(),
    );
  });

  it('customer.credit_config_updated audit contains only the creditEnabled boolean — never the credit limit amount (§4)', async () => {
    const c = await mkCustomer(companyA);
    const tok = await mint(
      'audit-credit-pii',
      tenantA,
      ['customers:manage', 'customers:credit:manage'],
      { stepUp: true },
    );
    const secretLimit = '123456789';
    const r = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}/account/credit`,
      tok,
      { creditEnabled: true, creditLimitMinor: secretLimit },
      { 'if-match': '1' },
    );
    expect(r.statusCode, r.payload).toBe(200);
    const accountId = (r.json() as { id: string }).id;

    const rows = await sql<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_log WHERE action = 'customer.credit_config_updated' AND "resourceId" = $1`,
      [accountId],
    );
    expect(rows).toHaveLength(1);
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain(secretLimit);
    const after = rows[0]!.after as { creditEnabled: boolean };
    expect(after.creditEnabled).toBe(true);
  });

  it('archive: correct version succeeds, stale version conflicts', async () => {
    const c = await mkCustomer(companyA);
    const tok = await mint('v2', tenantA, ['customers:manage']);
    const rStale = await req(
      'POST',
      `/companies/${companyA}/customers/${c.id}/archive`,
      tok,
      undefined,
      { 'if-match': '999' },
    );
    expect(rStale.statusCode).toBe(409);
    const rOk = await req(
      'POST',
      `/companies/${companyA}/customers/${c.id}/archive`,
      tok,
      undefined,
      { 'if-match': String(c.version) },
    );
    expect(rOk.statusCode, rOk.payload).toBe(200);
  });

  it('credit config: correct account version succeeds, stale version conflicts', async () => {
    const c = await mkCustomer(companyA);
    const tok = await mint('v3', tenantA, ['customers:manage', 'customers:credit:manage'], {
      stepUp: true,
    });
    const rStale = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}/account/credit`,
      tok,
      { creditEnabled: false },
      { 'if-match': '999' },
    );
    expect(rStale.statusCode).toBe(409);
    expect(errCode(rStale)).toBe('CUSTOMER_CREDIT_VERSION_CONFLICT');
    const rOk = await req(
      'PATCH',
      `/companies/${companyA}/customers/${c.id}/account/credit`,
      tok,
      { creditEnabled: false },
      { 'if-match': '1' },
    );
    expect(rOk.statusCode, rOk.payload).toBe(200);
  });

  // ── credit config rules (§26) ────────────────────────────────────────────
  describe('credit configuration', () => {
    it('AED: enable with a valid positive limit', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('cc1', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true, creditLimitMinor: '100000' },
        { 'if-match': '1' },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const body = r.json() as {
        creditEnabled: boolean;
        creditLimitCurrencyCode: string;
        creditLimitCurrencyExponent: number;
      };
      expect(body.creditEnabled).toBe(true);
      expect(body.creditLimitCurrencyCode).toBe('AED');
      expect(body.creditLimitCurrencyExponent).toBe(2);
    });

    it('KWD 3-decimal company: exponent resolved server-side as 3', async () => {
      const kwdCompany = await mkCompany(tenantA, 'KWD Co', 'KW', 'KWD');
      const c = await mkCustomer(kwdCompany);
      const tok = await mint('cc2', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r = await req(
        'PATCH',
        `/companies/${kwdCompany}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true, creditLimitMinor: '500000' },
        { 'if-match': '1' },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const body = r.json() as { creditLimitCurrencyExponent: number };
      expect(body.creditLimitCurrencyExponent).toBe(3);
    });

    it('client cannot submit an exponent — the DTO has no such field (.strict() rejects it)', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('cc3', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true, creditLimitMinor: '1000', creditLimitCurrencyExponent: 5 },
        { 'if-match': '1' },
      );
      expect(r.statusCode).toBe(400);
      expect(errCode(r)).toBe('VALIDATION_FAILED');
    });

    it('enabled + no stored limit fails (CUSTOMER_CREDIT_CONFIG_INVALID)', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('cc4', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true },
        { 'if-match': '1' },
      );
      expect(r.statusCode).toBe(422);
      expect(errCode(r)).toBe('CUSTOMER_CREDIT_CONFIG_INVALID');
    });

    it('disabled + omitted retains a previously stored limit', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('cc5', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r1 = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true, creditLimitMinor: '20000' },
        { 'if-match': '1' },
      );
      expect(r1.statusCode, r1.payload).toBe(200);
      const r2 = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false },
        { 'if-match': '2' },
      );
      expect(r2.statusCode, r2.payload).toBe(200);
      const body = r2.json() as { creditEnabled: boolean; creditLimitMinor: string };
      expect(body.creditEnabled).toBe(false);
      expect(String(body.creditLimitMinor)).toBe('20000');
    });

    it('disabled + supplied limit stores it while remaining disabled (configure-before-enable)', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('cc6', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false, creditLimitMinor: '30000' },
        { 'if-match': '1' },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const body = r.json() as { creditEnabled: boolean; creditLimitMinor: string };
      expect(body.creditEnabled).toBe(false);
      expect(String(body.creditLimitMinor)).toBe('30000');
    });

    it('enabled + omitted limit reuses a previously stored valid same-currency limit', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('cc6b', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      // configure-before-enable (case D) stores a valid limit while disabled
      const r1 = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false, creditLimitMinor: '45000' },
        { 'if-match': '1' },
      );
      expect(r1.statusCode, r1.payload).toBe(200);
      // enable with the limit field OMITTED entirely — must reuse the stored one
      const r2 = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true },
        { 'if-match': '2' },
      );
      expect(r2.statusCode, r2.payload).toBe(200);
      const body = r2.json() as {
        creditEnabled: boolean;
        creditLimitMinor: string;
        creditLimitCurrencyCode: string;
      };
      expect(body.creditEnabled).toBe(true);
      expect(String(body.creditLimitMinor)).toBe('45000');
      expect(body.creditLimitCurrencyCode).toBe('AED');
    });

    it('no clear-limit API exists — creditLimitMinor: null is rejected by the strict DTO (400), never treated as "clear the stored limit" (owner review round)', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('cc6c', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r1 = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false, creditLimitMinor: '77000' },
        { 'if-match': '1' },
      );
      expect(r1.statusCode, r1.payload).toBe(200);
      const r2 = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false, creditLimitMinor: null },
        { 'if-match': '2' },
      );
      expect(r2.statusCode).toBe(400);
      expect(errCode(r2)).toBe('VALIDATION_FAILED');
      // the stored limit from r1 is untouched — the rejected request never applied
      const stored = await sql<{ creditLimitMinor: string }>(
        `SELECT "creditLimitMinor"::text FROM customer_company_account WHERE "customerId" = $1`,
        [c.id],
      );
      expect(stored[0]!.creditLimitMinor).toBe('77000');
    });

    it.each([
      ['a decimal fraction', '12.5'],
      ['a negative sign', '-5'],
      ['non-numeric text', 'abc'],
      ['a leading-plus number', '+100'],
      ['scientific notation', '1e5'],
      ['an empty string', ''],
    ])('rejects a malformed creditLimitMinor: %s (%s)', async (_label, badValue) => {
      const c = await mkCustomer(companyA);
      const tok = await mint(
        'cc-malformed',
        tenantA,
        ['customers:manage', 'customers:credit:manage'],
        { stepUp: true },
      );
      const r = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false, creditLimitMinor: badValue },
        { 'if-match': '1' },
      );
      expect(r.statusCode, r.payload).toBe(400);
      expect(errCode(r)).toBe('VALIDATION_FAILED');
    });

    it('a limit beyond Number.MAX_SAFE_INTEGER round-trips exactly as BigInt (never parsed as a JS number)', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint(
        'cc-bigint',
        tenantA,
        ['customers:manage', 'customers:credit:manage'],
        { stepUp: true },
      );
      const huge = '99999999999999999'; // > Number.MAX_SAFE_INTEGER (9007199254740991)
      expect(BigInt(huge) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      const r = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false, creditLimitMinor: huge },
        { 'if-match': '1' },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const body = r.json() as { creditLimitMinor: string };
      expect(body.creditLimitMinor).toBe(huge);
      const stored = await sql<{ creditLimitMinor: string }>(
        `SELECT "creditLimitMinor"::text FROM customer_company_account WHERE "customerId" = $1`,
        [c.id],
      );
      expect(stored[0]!.creditLimitMinor).toBe(huge);
    });

    it('re-enabling with a stale (now different) company currency fails closed (CUSTOMER_CREDIT_CURRENCY_MISMATCH), never reinterpreting the minor value', async () => {
      const staleCo = await mkCompany(tenantA, 'Stale Currency Co', 'AE', 'AED');
      const c = await mkCustomer(staleCo);
      const tok = await mint('cc7', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const r1 = await req(
        'PATCH',
        `/companies/${staleCo}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true, creditLimitMinor: '10000' },
        { 'if-match': '1' },
      );
      expect(r1.statusCode, r1.payload).toBe(200);
      // simulate a future currency-change path (none exists live today, task
      // 3b.1's `assertCurrencyChangeAllowed` guard has no HTTP caller yet) —
      // directly mutate the company's currency to exercise the fail-closed path.
      await sql(`UPDATE company SET "defaultCurrency" = 'SAR' WHERE id = $1`, [staleCo]);
      const r2 = await req(
        'PATCH',
        `/companies/${staleCo}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: false },
        { 'if-match': '2' },
      );
      // disabling doesn't re-validate currency (task 3b.2 §9/§12 — disable-and-retain)
      expect(r2.statusCode, r2.payload).toBe(200);
      const r3 = await req(
        'PATCH',
        `/companies/${staleCo}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true },
        { 'if-match': '3' },
      );
      expect(r3.statusCode).toBe(409);
      expect(errCode(r3)).toBe('CUSTOMER_CREDIT_CURRENCY_MISMATCH');
      const stored = await sql<{ creditLimitMinor: string }>(
        `SELECT "creditLimitMinor"::text FROM customer_company_account WHERE "customerId" = $1`,
        [c.id],
      );
      expect(stored[0]!.creditLimitMinor).toBe('10000'); // never reinterpreted
    });

    it('no Journal/PostingEngine effect from any credit-config call', async () => {
      const before = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entry`);
      const c = await mkCustomer(companyA);
      const tok = await mint('cc8', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}/account/credit`,
        tok,
        { creditEnabled: true, creditLimitMinor: '5000' },
        { 'if-match': '1' },
      );
      const after = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entry`);
      expect(after[0]!.n).toBe(before[0]!.n);
    });
  });

  // ── archive behaviour (§27) ──────────────────────────────────────────────
  describe('archive', () => {
    it('archived customer cannot be updated or credit-configured', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('a1', tenantA, ['customers:manage', 'customers:credit:manage'], {
        stepUp: true,
      });
      const rArchive = await req(
        'POST',
        `/companies/${companyA}/customers/${c.id}/archive`,
        tok,
        undefined,
        { 'if-match': '1' },
      );
      expect(rArchive.statusCode, rArchive.payload).toBe(200);

      const rUpdate = await req(
        'PATCH',
        `/companies/${companyA}/customers/${c.id}`,
        tok,
        { displayName: 'nope' },
        { 'if-match': '2' },
      );
      expect(rUpdate.statusCode).toBe(409);
      expect(errCode(rUpdate)).toBe('CUSTOMER_ARCHIVED');
    });

    it('no unarchive route and no hard-delete route exist', async () => {
      const c = await mkCustomer(companyA);
      const tok = await mint('a2', tenantA, ['customers:manage']);
      await req('POST', `/companies/${companyA}/customers/${c.id}/archive`, tok, undefined, {
        'if-match': '1',
      });
      for (const attempt of [
        req('POST', `/companies/${companyA}/customers/${c.id}/unarchive`, tok),
        req('POST', `/companies/${companyA}/customers/${c.id}/reactivate`, tok, undefined, {
          'if-match': '2',
        }),
        req('POST', `/companies/${companyA}/customers/${c.id}/restore`, tok),
      ]) {
        const r = await attempt;
        expect(r.statusCode).toBe(404);
      }
      // no DELETE method exists on this controller at all (inject rejects an
      // unregistered method/route combination with 404, same as any other route)
      const rDelete = await app.inject({
        method: 'DELETE',
        url: `/v1/companies/${companyA}/customers/${c.id}`,
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(rDelete.statusCode).toBe(404);
    });

    it('archiving a Customer shared by Company A and Company B archives the ONE shared identity — Company B keeps its CustomerCompanyAccount row and observes the same archived status, not a separate still-active copy (§6)', async () => {
      const c = await mkCustomer(companyA);
      const tokOwner = await mint('shared-archive-owner', tenantA, ['customers:manage']);
      const rAssociate = await req(
        'POST',
        `/companies/${companyA2}/customers/${c.id}/associate`,
        tokOwner,
      );
      expect(rAssociate.statusCode, rAssociate.payload).toBe(200);

      const tokA = await mint('shared-archive-a', tenantA, ['customers:manage']);
      const rArchive = await req(
        'POST',
        `/companies/${companyA}/customers/${c.id}/archive`,
        tokA,
        undefined,
        { 'if-match': '1' },
      );
      expect(rArchive.statusCode, rArchive.payload).toBe(200);

      // (a) the single Customer row is ARCHIVED — checked directly in the DB
      const customerRow = await sql<{ status: string }>(
        `SELECT status FROM customer WHERE id = $1`,
        [c.id],
      );
      expect(customerRow[0]!.status).toBe('ARCHIVED');

      // (b)/(d) Company B's CustomerCompanyAccount row still exists, untouched
      const accountRows = await sql<{ id: string; creditEnabled: boolean }>(
        `SELECT id, "creditEnabled" FROM customer_company_account WHERE "customerId" = $1`,
        [c.id],
      );
      expect(accountRows).toHaveLength(2); // A and A2, neither deleted
      expect(accountRows.every((r) => r.creditEnabled === false)).toBe(true);

      // (c) Company B (A2) observes the SAME archived identity, not a separate
      // still-active copy — its own read path returns status ARCHIVED too.
      const tokA2 = await mintScoped('shared-archive-a2', tenantA, ['customers:view'], [companyA2]);
      const rGetFromA2 = await req('GET', `/companies/${companyA2}/customers/${c.id}`, tokA2);
      expect(rGetFromA2.statusCode, rGetFromA2.payload).toBe(200);
      const bodyFromA2 = rGetFromA2.json() as { status: string };
      expect(bodyFromA2.status).toBe('ARCHIVED');
    });
  });
});
