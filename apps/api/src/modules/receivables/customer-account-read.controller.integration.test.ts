import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import pg from 'pg';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { SYSTEM_ROLE_TEMPLATES } from '../platform/system-roles.js';

/**
 * Task 3b.6 Checkpoint G — the customer account read model's HTTP surface:
 * authorization matrix (`receivables:view`, ALL 13 system role templates,
 * literal — never hand-picked), branch/company/tenant isolation, Money
 * string serialization, pagination, and query validation, all at the real
 * HTTP layer. Mirrors `opening-balance.controller.integration.test.ts`'s own
 * harness exactly. Formula/reconciliation/statement-kind correctness is
 * proven separately, at the repository layer, in
 * `customer-account-read.integration.test.ts`.
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b6ca1';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b6ca0', 'starter-3b6ca', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b6ca0', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 10);
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
      VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING;
    `);
  } finally {
    await c.end();
  }
}

describe('CustomerAccountReadController (task 3b.6 Checkpoint G, HTTP integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let coA = '';
  let branchA = '';
  let branchB = '';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    await seedPlan(stack.postgres.url);

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

    tenantA = await sqlOne(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'car-3b6c-a', 'car-3b6c-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`,
    );
    coA = await sqlOne(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES (uuidv7(),$1,'Co A','AED','Asia/Dubai',now()) RETURNING id`,
      [tenantA],
    );
    branchA = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch A',now()) RETURNING id`,
      [tenantA, coA],
    );
    branchB = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch B',now()) RETURNING id`,
      [tenantA, coA],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await sql(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,now())`,
        [tenantA, coA, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
      );
    }
    await sql(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES (uuidv7(),$1,$2,'2026-01-01','2026-12-31','OPEN',now())`,
      [tenantA, coA],
    );
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  function baseSess(sessionId: string, forTenant: string): SessionData {
    return {
      sessionId,
      realm: 'tenant',
      familyId: 'f',
      tenantId: forTenant,
      userId: null,
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
  const userIds = new Map<string, string>();
  let userSeq = 0;
  async function mintTenant(id: string, forTenant: string, perms: string[]): Promise<string> {
    const s = baseSess(`ten-${id}`, forTenant);
    let uidVal = userIds.get(id);
    if (uidVal === undefined) {
      uidVal = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
      userIds.set(id, uidVal);
    }
    s.userId = uidVal;
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
  function rolePerms(key: string): string[] {
    const tpl = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === key);
    if (!tpl) throw new Error(`no system role template for "${key}"`);
    return [...tpl.permissions];
  }
  const req = (method: 'GET', url: string, token: string | null) =>
    app.inject({
      method,
      url: `/v1${url}`,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
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
  async function sqlOne(text: string, params: unknown[] = []): Promise<string> {
    const rows = await sql<{ id: string }>(text, params);
    return rows[0]!.id;
  }

  async function freshCustomer(): Promise<string> {
    const customerId = await sqlOne(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES (uuidv7(), $1, 'Test Customer', now()) RETURNING id`,
      [tenantA],
    );
    await sqlOne(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, now()) RETURNING id`,
      [tenantA, coA, customerId],
    );
    return customerId;
  }

  const summaryUrl = (customerId: string, branch = branchA): string =>
    `/companies/${coA}/branches/${branch}/customers/${customerId}/account/summary`;
  const receivablesUrl = (customerId: string, branch = branchA, qs = ''): string =>
    `/companies/${coA}/branches/${branch}/customers/${customerId}/account/receivables${qs}`;
  const statementUrl = (customerId: string, branch = branchA, qs = ''): string =>
    `/companies/${coA}/branches/${branch}/customers/${customerId}/account/statement${qs}`;

  // ═══════════════════════ G36 authorization matrix (all 13 roles) ══════════
  const ALL_ROLES = SYSTEM_ROLE_TEMPLATES.map((t) => t.key);
  const ALLOWED_ROLES = new Set(['owner', 'admin', 'manager', 'cashier', 'sales']);

  for (const role of ALL_ROLES) {
    const expectAllowed = ALLOWED_ROLES.has(role);
    it(`role "${role}" (receivables:view ${expectAllowed ? 'GRANTED' : 'NOT granted'}) -> summary ${expectAllowed ? '200' : '403'}`, async () => {
      const customerId = await freshCustomer();
      const token = await mintTenant(`g36-${role}`, tenantA, rolePerms(role));
      const res = await req('GET', summaryUrl(customerId), token);
      expect(res.statusCode, res.payload).toBe(expectAllowed ? 200 : 403);
    });
  }

  it('no step-up is required for an ordinary receivables:view read (owner without STEP_UP still succeeds)', async () => {
    const customerId = await freshCustomer();
    const token = await mintTenant('g36-owner-nostepup', tenantA, rolePerms('owner'));
    const res = await req('GET', summaryUrl(customerId), token);
    expect(res.statusCode, res.payload).toBe(200);
  });

  it('an unauthenticated request is rejected', async () => {
    const customerId = await freshCustomer();
    const res = await req('GET', summaryUrl(customerId), null);
    expect(res.statusCode).toBe(401);
  });

  // ═══════════════════════ G27 — Money serializes as strings ════════════════
  it('G27: every Money field in the summary response (branchFinancials + credit) is a JSON string, never a raw number/BigInt', async () => {
    const customerId = await freshCustomer();
    const token = await mintTenant('g27-owner', tenantA, rolePerms('owner'));
    const res = await req('GET', summaryUrl(customerId), token);
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json() as {
      branchFinancials: Record<string, unknown>;
      credit: Record<string, unknown>;
    };
    expect(typeof body.branchFinancials['receivableOutstandingMinor']).toBe('string');
    expect(typeof body.branchFinancials['advanceAvailableMinor']).toBe('string');
    expect(typeof body.branchFinancials['unappliedReceiptMinor']).toBe('string');
    expect(body.branchFinancials['receivableOutstandingMinor']).toBe('0');
    expect(typeof body.credit['creditExposureMinor']).toBe('string');
    expect(body.credit['scope']).toBe('COMPANY');
  });

  // ═════ Checkpoint H §14 — large-value Money precision (beyond JS safe int) ════
  it('H14: a receivable outstanding beyond Number.MAX_SAFE_INTEGER round-trips through the summary endpoint as an EXACT string, never truncated by JSON number serialization', async () => {
    const customerId = await freshCustomer();
    // 9,007,199,254,740,991 is Number.MAX_SAFE_INTEGER — use a value with a
    // distinguishing tail well beyond it so any float-precision loss would
    // corrupt a digit a naive `JSON.stringify(Number(...))` could not
    // represent exactly.
    const hugeAmount = '99999999999999999';
    await sql(
      `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
       SELECT uuidv7(), $1, $2, $3, cca.id, 'OPENING', $4::bigint, 'AED', 2, '2026-01-05'
         FROM customer_company_account cca WHERE cca."customerId" = $5`,
      [tenantA, coA, branchA, hugeAmount, customerId],
    );
    const token = await mintTenant('h14-huge', tenantA, rolePerms('owner'));
    const res = await req('GET', summaryUrl(customerId), token);
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json() as { branchFinancials: Record<string, unknown> };
    expect(body.branchFinancials['receivableOutstandingMinor']).toBe(hugeAmount);

    const listRes = await req('GET', receivablesUrl(customerId), token);
    const listBody = listRes.json() as { data: { outstandingMinor: string }[] };
    expect(listBody.data[0]!.outstandingMinor).toBe(hugeAmount);
  });

  // ═══════════════════════ G3/G29 — isolation ════════════════════════════════
  it('a different tenant cannot read this customer account at all (401/403/404, never leaks data)', async () => {
    const customerId = await freshCustomer();
    const otherTenant = await sqlOne(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'car-3b6c-other', 'car-3b6c-other', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`,
    );
    const token = await mintTenant('g29-other-tenant', otherTenant, rolePerms('owner'));
    const res = await req('GET', summaryUrl(customerId), token);
    expect([401, 403, 404]).toContain(res.statusCode);
  });

  it("a branch outside the caller's branchScope is rejected non-disclosingly (branch/company scope enforced by @ScopedParam, not merely permission)", async () => {
    const customerId = await freshCustomer();
    const s = baseSess('g29-branch-scoped', tenantA);
    s.userId = '00000000-0000-7000-8000-999999999901';
    s.access = {
      effectivePermissions: rolePerms('owner'),
      companyScope: 'ALL',
      branchScope: [branchB], // NOT branchA
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    const token = await jwt.sign({ sub: s.userId, sid: s.sessionId, aud: 'tenant', tid: tenantA });
    const res = await req('GET', summaryUrl(customerId, branchA), token);
    // non-disclosing: an out-of-scope branch is a plain 404, never a
    // different status that would confirm the branch/customer exists
    // (mirrors `customer.controller.ts`'s own documented convention).
    expect(res.statusCode).toBe(404);
  });

  it("a receivable created on branch B never appears in branch A's receivables list (real HTTP)", async () => {
    const customerId = await freshCustomer();
    await sql(
      `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
       SELECT uuidv7(), $1, $2, $3, cca.id, 'OPENING', 100, 'AED', 2, '2026-01-05'
         FROM customer_company_account cca WHERE cca."customerId" = $4`,
      [tenantA, coA, branchB, customerId],
    );
    const token = await mintTenant('g29-branch-list', tenantA, rolePerms('owner'));
    const res = await req('GET', receivablesUrl(customerId, branchA), token);
    expect(res.statusCode, res.payload).toBe(200);
    expect((res.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  // ═════ G's Absolute Final Freeze Gate §5 — cashier/sales cross-branch isolation ═════
  it.each(['cashier', 'sales'])(
    'role "%s" (receivables:view granted) requesting branch A summary NEVER obtains branch B\'s operational amounts — even though the role can be granted the permission at all branches',
    async (role) => {
      const customerId = await freshCustomer();
      // Branch A: Receivable 120. Branch B: Receivable 999 (deliberately
      // large/distinguishable, so any leak is unmistakable).
      await sql(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         SELECT uuidv7(), $1, $2, $3, cca.id, 'OPENING', 120, 'AED', 2, '2026-01-05'
           FROM customer_company_account cca WHERE cca."customerId" = $4`,
        [tenantA, coA, branchA, customerId],
      );
      await sql(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         SELECT uuidv7(), $1, $2, $3, cca.id, 'OPENING', 999, 'AED', 2, '2026-01-05'
           FROM customer_company_account cca WHERE cca."customerId" = $4`,
        [tenantA, coA, branchB, customerId],
      );
      const token = await mintTenant(`g5-${role}`, tenantA, rolePerms(role));
      const resA = await req('GET', summaryUrl(customerId, branchA), token);
      expect(resA.statusCode, resA.payload).toBe(200);
      const bodyA = resA.json() as { branchFinancials: { receivableOutstandingMinor: string } };
      expect(bodyA.branchFinancials.receivableOutstandingMinor).toBe('120');
      expect(bodyA.branchFinancials.receivableOutstandingMinor).not.toBe('999');
      expect(bodyA.branchFinancials.receivableOutstandingMinor).not.toBe('1119');

      // owner/admin do NOT get different branch-summary semantics merely
      // because they can access more branches — to see branch B they must
      // request branch B's own route, same as any other role.
      const resB = await req('GET', summaryUrl(customerId, branchB), token);
      expect(resB.statusCode, resB.payload).toBe(200);
      const bodyB = resB.json() as { branchFinancials: { receivableOutstandingMinor: string } };
      expect(bodyB.branchFinancials.receivableOutstandingMinor).toBe('999');
    },
  );

  // ═══════════════════════ G30 — HTTP validation ═════════════════════════════
  it('rejects a malformed cursor with 400 INVALID_CURSOR', async () => {
    const customerId = await freshCustomer();
    const token = await mintTenant('g30-cursor', tenantA, rolePerms('owner'));
    const res = await req('GET', receivablesUrl(customerId, branchA, '?cursor=not-a-uuid'), token);
    expect(res.statusCode, res.payload).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_CURSOR');
  });

  it('rejects limit=0 with 400 INVALID_LIMIT', async () => {
    const customerId = await freshCustomer();
    const token = await mintTenant('g30-limit', tenantA, rolePerms('owner'));
    const res = await req('GET', receivablesUrl(customerId, branchA, '?limit=0'), token);
    expect(res.statusCode, res.payload).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_LIMIT');
  });

  it('rejects a malformed date on the statement `from` filter with 400 INVALID_DATE', async () => {
    const customerId = await freshCustomer();
    const token = await mintTenant('g30-date', tenantA, rolePerms('owner'));
    const res = await req('GET', statementUrl(customerId, branchA, '?from=13/40/2026'), token);
    expect(res.statusCode, res.payload).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_DATE');
  });

  it('rejects from > to with 400 INVALID_DATE_RANGE', async () => {
    const customerId = await freshCustomer();
    const token = await mintTenant('g30-range', tenantA, rolePerms('owner'));
    const res = await req(
      'GET',
      statementUrl(customerId, branchA, '?from=2026-06-01&to=2026-01-01'),
      token,
    );
    expect(res.statusCode, res.payload).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_DATE_RANGE');
  });

  // ═══════════════════════ G37 — HTTP pagination ═════════════════════════════
  // Genuine multi-page correctness (several real Invoices for ONE customer,
  // page1/page2, no duplicate/missing rows) is already proven exhaustively
  // at the repository layer (`customer-account-read.integration.test.ts`'s
  // own G37 test, using real `InvoiceIssuanceRepository` fixtures). This
  // HTTP-level test proves the CONTROLLER correctly threads `?limit=`/
  // `?cursor=` through to that same repository and shapes the response.
  it('G37: `?limit=1` is honored over HTTP, and `nextCursor` is null once the (single) row is exhausted', async () => {
    const customerId = await freshCustomer();
    await sql(
      `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
       SELECT uuidv7(), $1, $2, $3, cca.id, 'OPENING', 50, 'AED', 2, '2026-01-05'
         FROM customer_company_account cca WHERE cca."customerId" = $4`,
      [tenantA, coA, branchA, customerId],
    );
    const token = await mintTenant('g37-http-page', tenantA, rolePerms('owner'));
    const res1 = await req('GET', receivablesUrl(customerId, branchA, '?limit=1'), token);
    expect(res1.statusCode, res1.payload).toBe(200);
    const body1 = res1.json() as {
      data: { customerReceivableId: string }[];
      nextCursor: string | null;
    };
    expect(body1.data).toHaveLength(1);
    expect(body1.nextCursor).toBeNull();
  });
});
