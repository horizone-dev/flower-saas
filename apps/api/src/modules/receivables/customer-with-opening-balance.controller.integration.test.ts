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
 * Task 3b.6 Checkpoint F (F19-F22/F37) — the Customer-creation-with-
 * optional-embedded-Opening-Balance route
 * (`POST .../branches/:branchId/customers`), proven at the real HTTP layer.
 * Confirms: a plain `customers:manage` caller may still create a Customer
 * with NO `openingBalance` through this NEW route; the SAME caller is
 * denied the MOMENT `openingBalance` is present (F21); the frozen 3b.2
 * `/companies/:companyId/customers` route is untouched (proven in
 * `customer.controller.integration.test.ts`'s own unmodified regression, not
 * re-proven here).
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b6f11';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b6f10', 'starter-3b6f1', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b6f10', 1, 'PUBLISHED', now());
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

describe('CustomerWithOpeningBalanceController (task 3b.6 Checkpoint F, HTTP integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let coA = '';
  let branchA = '';

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

    tenantA =
      await sqlOne(`INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'obc-3b6f-a', 'obc-3b6f-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
    coA = await sqlOne(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES (uuidv7(),$1,'Co A','AED','Asia/Dubai',now()) RETURNING id`,
      [tenantA],
    );
    branchA = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch A',now()) RETURNING id`,
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

  function baseSess(
    sessionId: string,
    forTenant: string,
    mfaLevel: 'NONE' | 'STEP_UP',
  ): SessionData {
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
      mfaLevel,
      stepUpUntil: mfaLevel === 'STEP_UP' ? Date.now() + 3_600_000 : null,
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
  async function mintTenant(
    id: string,
    forTenant: string,
    perms: string[],
    mfaLevel: 'NONE' | 'STEP_UP' = 'STEP_UP',
  ): Promise<string> {
    const s = baseSess(`ten-${id}`, forTenant, mfaLevel);
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
  function rolePerms(key: 'owner' | 'admin' | 'manager' | 'cashier' | 'sales'): string[] {
    const tpl = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === key);
    if (!tpl) throw new Error(`no system role template for "${key}"`);
    return [...tpl.permissions];
  }
  const req = (
    method: 'GET' | 'POST',
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
  async function sqlOne(text: string, params: unknown[] = []): Promise<string> {
    const rows = await sql<{ id: string }>(text, params);
    return rows[0]!.id;
  }
  let idemN = 0;
  let nameN = 0;
  const ik = (): string => `obc-key-${String(++idemN).padStart(4, '0')}`;
  const freshName = (): string => `Test Customer ${String(++nameN).padStart(4, '0')}`;
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;

  const url = (): string => `/companies/${coA}/branches/${branchA}/customers`;

  async function fullSnapshot() {
    const rows = await sql<{
      customers: number;
      ccas: number;
      receivables: number;
      advances: number;
    }>(`SELECT
          (SELECT count(*)::int FROM customer) AS customers,
          (SELECT count(*)::int FROM customer_company_account) AS ccas,
          (SELECT count(*)::int FROM customer_receivable) AS receivables,
          (SELECT count(*)::int FROM customer_advance) AS advances`);
    return rows[0]!;
  }

  // ═══════════════════════ F37 matrix ═══════════════════════════════════════
  it('1: normal Customer create (no openingBalance) via the NEW route, with just customers:manage — unchanged/allowed', async () => {
    const manager = await mintTenant('obc-manager-plain', tenantA, rolePerms('manager'), 'STEP_UP');
    const res = await req(
      'POST',
      url(),
      manager,
      { displayName: freshName() },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    expect((res.json() as { openingBalance: unknown }).openingBalance).toBeNull();
  });

  // Final Hardening §16 — the old plain-create path (no openingBalance) must
  // NOT suddenly require step-up just because this new route exists.
  it("1b: normal Customer create (no openingBalance) succeeds WITHOUT step-up — the new route's step-up requirement is conditional, not blanket", async () => {
    const manager = await mintTenant('obc-manager-nostepup', tenantA, rolePerms('manager'), 'NONE');
    const res = await req(
      'POST',
      url(),
      manager,
      { displayName: freshName() },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  // Final Hardening §16 — Owner/Admin WITH receivables:opening_balance:manage
  // but WITHOUT a fresh step-up + openingBalance supplied -> STEP_UP_REQUIRED,
  // zero mutation.
  it('1c: Owner has BOTH permissions but NO step-up + openingBalance supplied -> STEP_UP_REQUIRED, zero mutation', async () => {
    const owner = await mintTenant('obc-owner-nostepup', tenantA, rolePerms('owner'), 'NONE');
    const before = await fullSnapshot();
    const res = await req(
      'POST',
      url(),
      owner,
      {
        displayName: freshName(),
        openingBalance: { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe('STEP_UP_REQUIRED');
    const after = await fullSnapshot();
    expect(after).toEqual(before);
  });

  it('2: Customer create + Opening Receivable (owner, both permissions present)', async () => {
    const owner = await mintTenant('obc-owner-recv', tenantA, rolePerms('owner'), 'STEP_UP');
    const res = await req(
      'POST',
      url(),
      owner,
      {
        displayName: freshName(),
        openingBalance: { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    const json = res.json() as {
      openingBalance: { type: string; currentOutstandingMinor: string };
    };
    expect(json.openingBalance.type).toBe('RECEIVABLE');
    expect(json.openingBalance.currentOutstandingMinor).toBe('500');
  });

  it('3: Customer create + Opening Advance (admin, both permissions present)', async () => {
    const admin = await mintTenant('obc-admin-adv', tenantA, rolePerms('admin'), 'STEP_UP');
    const res = await req(
      'POST',
      url(),
      admin,
      {
        displayName: freshName(),
        openingBalance: { type: 'ADVANCE', amountMinor: '300', effectiveDate: '2026-01-10' },
      },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    const json = res.json() as { openingBalance: { type: string; advanceBalanceMinor: string } };
    expect(json.openingBalance.type).toBe('ADVANCE');
    expect(json.openingBalance.advanceBalanceMinor).toBe('300');
  });

  it('4: missing opening-balance permission (manager: customers:manage only) + openingBalance supplied -> denied, ZERO mutation', async () => {
    const manager = await mintTenant('obc-manager-deny', tenantA, rolePerms('manager'), 'STEP_UP');
    const before = await fullSnapshot();
    const res = await req(
      'POST',
      url(),
      manager,
      {
        displayName: freshName(),
        openingBalance: { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
    const after = await fullSnapshot();
    expect(after).toEqual(before); // no Customer/CCA/receivable created either — F21 "reject the whole request"
  });

  it('5: same idempotency key replay -> no duplicates', async () => {
    const owner = await mintTenant('obc-idem-1', tenantA, rolePerms('owner'), 'STEP_UP');
    const key = ik();
    const body = {
      displayName: freshName(),
      openingBalance: { type: 'RECEIVABLE', amountMinor: '150', effectiveDate: '2026-01-10' },
    };
    const first = await req('POST', url(), owner, body, { 'idempotency-key': key });
    expect(first.statusCode, first.payload).toBe(201);
    const firstJson = first.json() as { id: string };

    const replay = await req('POST', url(), owner, body, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.json() as { id: string }).id).toBe(firstJson.id);

    const rows = await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customer WHERE id = $1`, [
      firstJson.id,
    ]);
    expect(rows[0]!.n).toBe(1);
  });

  it('6: same key + CHANGED opening-balance payload -> conflict', async () => {
    const owner = await mintTenant('obc-idem-2', tenantA, rolePerms('owner'), 'STEP_UP');
    const key = ik();
    const displayName = freshName();
    const first = await req(
      'POST',
      url(),
      owner,
      {
        displayName,
        openingBalance: { type: 'RECEIVABLE', amountMinor: '150', effectiveDate: '2026-01-10' },
      },
      { 'idempotency-key': key },
    );
    expect(first.statusCode, first.payload).toBe(201);
    const conflicting = await req(
      'POST',
      url(),
      owner,
      {
        displayName,
        openingBalance: { type: 'RECEIVABLE', amountMinor: '999', effectiveDate: '2026-01-10' },
      },
      { 'idempotency-key': key },
    );
    expect(conflicting.statusCode).toBe(409);
  });

  it('7: an invalid opening balance (zero amount) leaves NO partial financial state — no Customer row survives either', async () => {
    const owner = await mintTenant('obc-invalid', tenantA, rolePerms('owner'), 'STEP_UP');
    const before = await fullSnapshot();
    const res = await req(
      'POST',
      url(),
      owner,
      {
        displayName: freshName(),
        openingBalance: { type: 'RECEIVABLE', amountMinor: '0', effectiveDate: '2026-01-10' },
      },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(400); // DTO-layer rejection — never reaches the transaction at all
    const after = await fullSnapshot();
    expect(after).toEqual(before);
  });
});
