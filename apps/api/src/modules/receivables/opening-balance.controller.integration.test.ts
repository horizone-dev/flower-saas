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
 * Task 3b.6 Checkpoint F (F30) — the standalone Opening Balance HTTP route,
 * proven at the real HTTP layer: `receivables:opening_balance:manage` is
 * step-up gated (unlike every other 3b.6 receivables route in this module —
 * confirmed via `STEP_UP_PERMISSIONS` in `packages/permissions/src/
 * index.ts`) and owner/admin-only (confirmed via `system-roles.ts`'s
 * `RECEIVABLES_OPENING_BALANCE_MANAGE` grant). Mirrors
 * `payment-advance.controller.integration.test.ts`'s own harness exactly.
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b6f01';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b6f00', 'starter-3b6f', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b6f00', 1, 'PUBLISHED', now());
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

describe('OpeningBalanceController (task 3b.6 Checkpoint F, HTTP integration)', () => {
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
       VALUES (uuidv7(), 'ob-3b6f-a', 'ob-3b6f-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
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
  const ik = (): string => `ob-key-${String(++idemN).padStart(4, '0')}`;

  async function freshCustomer(): Promise<{ customerId: string; ccaId: string }> {
    const customerId = await sqlOne(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES (uuidv7(), $1, 'Test Customer', now()) RETURNING id`,
      [tenantA],
    );
    const ccaId = await sqlOne(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, now()) RETURNING id`,
      [tenantA, coA, customerId],
    );
    return { customerId, ccaId };
  }

  const url = (customerId: string): string =>
    `/companies/${coA}/branches/${branchA}/customers/${customerId}/opening-balance`;

  async function fullSnapshot() {
    const rows = await sql<{ receivables: number; advances: number; audits: number }>(`SELECT
          (SELECT count(*)::int FROM customer_receivable) AS receivables,
          (SELECT count(*)::int FROM customer_advance) AS advances,
          (SELECT count(*)::int FROM audit_log) AS audits`);
    return rows[0]!;
  }

  // ═══════════════════════ F30 authorization matrix ═════════════════════════
  it('owner + step-up is allowed to create an Opening Receivable', async () => {
    const { customerId } = await freshCustomer();
    const owner = await mintTenant('ob-owner', tenantA, rolePerms('owner'), 'STEP_UP');
    const res = await req(
      'POST',
      url(customerId),
      owner,
      { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    expect((res.json() as { type: string }).type).toBe('RECEIVABLE');
  });

  it('admin + step-up is allowed to create an Opening Advance', async () => {
    const { customerId } = await freshCustomer();
    const admin = await mintTenant('ob-admin', tenantA, rolePerms('admin'), 'STEP_UP');
    const res = await req(
      'POST',
      url(customerId),
      admin,
      { type: 'ADVANCE', amountMinor: '300', effectiveDate: '2026-01-10' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    expect((res.json() as { type: string }).type).toBe('ADVANCE');
  });

  it('owner WITHOUT step-up is denied (STEP_UP_REQUIRED) even with the correct permission', async () => {
    const { customerId } = await freshCustomer();
    const owner = await mintTenant('ob-owner-nostepup', tenantA, rolePerms('owner'), 'NONE');
    const before = await fullSnapshot();
    const res = await req(
      'POST',
      url(customerId),
      owner,
      { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
    const after = await fullSnapshot();
    expect(after).toEqual(before);
  });

  it('manager is denied (real manager role-template permissions, no receivables:opening_balance:manage)', async () => {
    const { customerId } = await freshCustomer();
    const manager = await mintTenant('ob-manager', tenantA, rolePerms('manager'), 'STEP_UP');
    const before = await fullSnapshot();
    const res = await req(
      'POST',
      url(customerId),
      manager,
      { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
    const after = await fullSnapshot();
    expect(after).toEqual(before);
  });

  it('cashier is denied, with zero financial-mutation proof', async () => {
    const { customerId } = await freshCustomer();
    const cashier = await mintTenant('ob-cashier', tenantA, rolePerms('cashier'), 'STEP_UP');
    const before = await fullSnapshot();
    const res = await req(
      'POST',
      url(customerId),
      cashier,
      { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
    const after = await fullSnapshot();
    expect(after).toEqual(before);
  });

  it('sales is denied, with zero financial-mutation proof', async () => {
    const { customerId } = await freshCustomer();
    const sales = await mintTenant('ob-sales', tenantA, rolePerms('sales'), 'STEP_UP');
    const before = await fullSnapshot();
    const res = await req(
      'POST',
      url(customerId),
      sales,
      { type: 'RECEIVABLE', amountMinor: '500', effectiveDate: '2026-01-10' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
    const after = await fullSnapshot();
    expect(after).toEqual(before);
  });

  // ═══════════════════════ F23 standalone idempotency ═══════════════════════
  it('same key + same payload replays, creates nothing new', async () => {
    const { customerId } = await freshCustomer();
    const owner = await mintTenant('ob-idem-1', tenantA, rolePerms('owner'), 'STEP_UP');
    const key = ik();
    const body = { type: 'RECEIVABLE', amountMinor: '150', effectiveDate: '2026-01-10' };
    const first = await req('POST', url(customerId), owner, body, { 'idempotency-key': key });
    expect(first.statusCode, first.payload).toBe(201);
    const firstJson = first.json() as { sourceId: string };

    const replay = await req('POST', url(customerId), owner, body, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.json() as { sourceId: string }).sourceId).toBe(firstJson.sourceId);

    const rows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_receivable WHERE id = $1`,
      [firstJson.sourceId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('same key + DIFFERENT payload is rejected', async () => {
    const { customerId } = await freshCustomer();
    const owner = await mintTenant('ob-idem-2', tenantA, rolePerms('owner'), 'STEP_UP');
    const key = ik();
    const first = await req(
      'POST',
      url(customerId),
      owner,
      { type: 'RECEIVABLE', amountMinor: '150', effectiveDate: '2026-01-10' },
      { 'idempotency-key': key },
    );
    expect(first.statusCode, first.payload).toBe(201);
    const conflicting = await req(
      'POST',
      url(customerId),
      owner,
      { type: 'RECEIVABLE', amountMinor: '200', effectiveDate: '2026-01-10' },
      { 'idempotency-key': key },
    );
    expect(conflicting.statusCode).toBe(409);
  });

  // ═════ Checkpoint H §16 — authorization resolved BEFORE idempotency replay ════
  it("H16: a caller WITHOUT the required permission, reusing the EXACT SAME literal Idempotency-Key an authorized owner already used, is denied 403 — never a replay of the owner's prior response, never a second financial mutation", async () => {
    const { customerId } = await freshCustomer();
    const owner = await mintTenant('h16-owner', tenantA, rolePerms('owner'), 'STEP_UP');
    // cashier has neither `receivables:opening_balance:manage` nor step-up —
    // deliberately unauthorized for this specific route.
    const cashier = await mintTenant('h16-cashier', tenantA, rolePerms('cashier'), 'STEP_UP');
    const sharedKey = ik();
    const body = { type: 'RECEIVABLE', amountMinor: '150', effectiveDate: '2026-01-10' };

    const ownerRes = await req('POST', url(customerId), owner, body, {
      'idempotency-key': sharedKey,
    });
    expect(ownerRes.statusCode, ownerRes.payload).toBe(201);
    const ownerJson = ownerRes.json() as { sourceId: string };

    const cashierRes = await req('POST', url(customerId), cashier, body, {
      'idempotency-key': sharedKey,
    });
    expect(cashierRes.statusCode, cashierRes.payload).toBe(403);
    // never the owner's cached response leaking through.
    expect(cashierRes.json()).not.toMatchObject({ sourceId: ownerJson.sourceId });
    expect(cashierRes.headers['idempotency-replayed']).not.toBe('true');

    // no second opening-balance row was created for this account+branch.
    const rows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_receivable
        WHERE "customerCompanyAccountId" = (
          SELECT id FROM customer_company_account WHERE "customerId" = $1
        )`,
      [customerId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  // ═══════════════════════ F30 DTO-layer rejection ══════════════════════════
  it('rejects a zero amount at the DTO layer', async () => {
    const { customerId } = await freshCustomer();
    const owner = await mintTenant('ob-zero', tenantA, rolePerms('owner'), 'STEP_UP');
    const res = await req(
      'POST',
      url(customerId),
      owner,
      { type: 'RECEIVABLE', amountMinor: '0', effectiveDate: '2026-01-10' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid effectiveDate at the DTO layer', async () => {
    const { customerId } = await freshCustomer();
    const owner = await mintTenant('ob-baddate', tenantA, rolePerms('owner'), 'STEP_UP');
    const res = await req(
      'POST',
      url(customerId),
      owner,
      { type: 'RECEIVABLE', amountMinor: '100', effectiveDate: '2026-13-40' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(400);
  });
});
