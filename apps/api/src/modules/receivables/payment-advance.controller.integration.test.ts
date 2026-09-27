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
 * Task 3b.6 Checkpoint E (E35/E20/E21) — the two new Advance HTTP routes,
 * proven at the real HTTP layer: the frozen `receivables:advance:apply`
 * permission tier (owner/admin/manager allowed, cashier/sales denied), no
 * step-up, and the shared `@Idempotent` replay contract for both
 * operations. Mirrors `customer-receipt.controller.integration.test.ts`'s
 * own harness exactly.
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b6101';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b6100', 'starter-3b6e', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b6100', 1, 'PUBLISHED', now());
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

describe('PaymentAdvanceConversionController + CustomerAdvanceApplicationController (task 3b.6 Checkpoint E, HTTP integration)', () => {
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
       VALUES (uuidv7(), 'adv-3b6-a', 'adv-3b6-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
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
    let uid = userIds.get(id);
    if (uid === undefined) {
      uid = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
      userIds.set(id, uid);
    }
    s.userId = uid;
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
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;
  let idemN = 0;
  const ik = (): string => `adv-key-${String(++idemN).padStart(4, '0')}`;

  /** the REAL frozen system-role-template permission set — never a hand-picked
   *  subset — so an "admin"/"manager" session in these tests is not inferred
   *  from template equality but is the literal grant that role carries. */
  function rolePerms(key: 'owner' | 'admin' | 'manager' | 'cashier' | 'sales'): string[] {
    const tpl = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === key);
    if (!tpl) throw new Error(`no system role template for "${key}"`);
    return [...tpl.permissions];
  }

  /** a whole-DB financial-mutation fingerprint for the tables either of the
   *  two E commands can write to — used to prove a denied (403) request left
   *  ZERO trace, not merely that it returned the right status code. */
  async function fullSnapshot(): Promise<{
    advances: number;
    applications: number;
    entries: number;
    journals: number;
    audits: number;
  }> {
    const rows = await sql<{
      advances: number;
      applications: number;
      entries: number;
      journals: number;
      audits: number;
    }>(`SELECT
          (SELECT count(*)::int FROM customer_advance) AS advances,
          (SELECT count(*)::int FROM customer_advance_application) AS applications,
          (SELECT count(*)::int FROM customer_account_entry) AS entries,
          (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" IN ('customer_advance', 'customer_advance_application')) AS journals,
          (SELECT count(*)::int FROM audit_log) AS audits`);
    return rows[0]!;
  }

  async function ccaSnapshot(
    ccaId: string,
  ): Promise<{ advanceBalanceMinor: string; currentOutstandingMinor: string }> {
    const rows = await sql<{ advanceBalanceMinor: string; currentOutstandingMinor: string }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    return rows[0]!;
  }

  /** a fresh customer + CCA + one Opening Receivable, plus a fully-unapplied
   *  CUSTOMER_RECEIPT Payment ready to convert. */
  async function freshCustomerWithPaymentAndOpening(
    openingAmountMinor: number,
    paymentAmountMinor: number,
  ): Promise<{ customerId: string; ccaId: string; receivableId: string; paymentId: string }> {
    const customerId = await sqlOne(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES (uuidv7(), $1, 'Test Customer', now()) RETURNING id`,
      [tenantA],
    );
    const ccaId = await sqlOne(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, now()) RETURNING id`,
      [tenantA, coA, customerId],
    );
    const receivableId = await sqlOne(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', $5, 'AED', 2, '2026-01-05') RETURNING id`,
      [tenantA, coA, branchA, ccaId, openingAmountMinor],
    );
    await sql(`UPDATE customer_company_account SET "currentOutstandingMinor" = $2 WHERE id = $1`, [
      ccaId,
      openingAmountMinor,
    ]);
    const attemptId = await sqlOne(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'CUSTOMER_RECEIPT',$4,'CASH',$5,'AED',2,'CAPTURED',$6, now()) RETURNING id`,
      [tenantA, coA, branchA, ccaId, paymentAmountMinor, `idem-fixture-${ccaId}`],
    );
    const paymentId = await sqlOne(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES (uuidv7(),$1,$2,$3,$4,'CASH',$5,'AED',2) RETURNING id`,
      [tenantA, coA, branchA, attemptId, paymentAmountMinor],
    );
    return { customerId, ccaId, receivableId, paymentId };
  }

  const conversionUrl = (companyId: string, branchId: string, customerId: string): string =>
    `/companies/${companyId}/branches/${branchId}/customers/${customerId}/advances/from-payment`;
  const applicationUrl = (
    companyId: string,
    branchId: string,
    customerId: string,
    advanceId: string,
  ): string =>
    `/companies/${companyId}/branches/${branchId}/customers/${customerId}/advances/${advanceId}/applications`;

  // ═══════════════════════ E35 permission tier ═════════════════════════════
  it('owner is allowed to convert a Payment to an Advance', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 100);
    const owner = await mintTenant('adv-owner', tenantA, ['receivables:advance:apply']);
    const res = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  it('manager is allowed to convert a Payment to an Advance', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 100);
    const manager = await mintTenant('adv-manager', tenantA, [
      'receivables:view',
      'receivables:collect',
      'receivables:advance:apply',
    ]);
    const res = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      manager,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  it('cashier is denied (E35)', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 100);
    const cashier = await mintTenant('adv-cashier', tenantA, [
      'receivables:view',
      'receivables:collect',
    ]);
    const res = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      cashier,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
  });

  it('sales is denied (E35)', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 100);
    const sales = await mintTenant('adv-sales', tenantA, [
      'receivables:view',
      'receivables:collect',
    ]);
    const res = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      sales,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
  });

  it('cashier is denied for Advance application too', async () => {
    const { customerId, ccaId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      100,
      100,
    );
    const owner = await mintTenant('adv-owner2', tenantA, ['receivables:advance:apply']);
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    const advanceId = (conv.json() as { advanceId: string }).advanceId;
    const cashier = await mintTenant('adv-cashier2', tenantA, [
      'receivables:view',
      'receivables:collect',
    ]);
    const res = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      cashier,
      { customerReceivableId: receivableId, amountMinor: '50' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
    void ccaId;
  });

  // ═══ Checkpoint E Final Authorization Evidence Gate — remaining matrix ═══
  // cells, each exercised through the real HTTP layer with the LITERAL
  // frozen system-role-template permission set for that role (never a
  // hand-picked stand-in, never inferred from template equality).

  it('admin (real admin role-template permissions) is allowed to convert a Payment to an Advance', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 100);
    const admin = await mintTenant('adv-admin-conv', tenantA, rolePerms('admin'));
    const res = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      admin,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  it('admin (real admin role-template permissions) is allowed to apply an Advance', async () => {
    const { customerId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      120,
      120,
    );
    const admin = await mintTenant('adv-admin-app', tenantA, rolePerms('admin'));
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      admin,
      { paymentId, amountMinor: '120' },
      { 'idempotency-key': ik() },
    );
    expect(conv.statusCode, conv.payload).toBe(201);
    const advanceId = (conv.json() as { advanceId: string }).advanceId;
    const res = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      admin,
      { customerReceivableId: receivableId, amountMinor: '80' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  it('owner (real owner role-template permissions) is allowed to apply an Advance', async () => {
    const { customerId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      120,
      120,
    );
    const owner = await mintTenant('adv-owner-app', tenantA, rolePerms('owner'));
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '120' },
      { 'idempotency-key': ik() },
    );
    expect(conv.statusCode, conv.payload).toBe(201);
    const advanceId = (conv.json() as { advanceId: string }).advanceId;
    const res = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      owner,
      { customerReceivableId: receivableId, amountMinor: '80' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  it('manager (real manager role-template permissions) is allowed to apply an Advance', async () => {
    const { customerId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      120,
      120,
    );
    const manager = await mintTenant('adv-manager-app', tenantA, rolePerms('manager'));
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      manager,
      { paymentId, amountMinor: '120' },
      { 'idempotency-key': ik() },
    );
    expect(conv.statusCode, conv.payload).toBe(201);
    const advanceId = (conv.json() as { advanceId: string }).advanceId;
    const res = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      manager,
      { customerReceivableId: receivableId, amountMinor: '80' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  it('sales (real sales role-template permissions) is denied for Advance application, with zero financial-mutation proof', async () => {
    const { customerId, ccaId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      100,
      100,
    );
    const owner = await mintTenant('adv-owner-salesdeny', tenantA, rolePerms('owner'));
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(conv.statusCode, conv.payload).toBe(201);
    const advanceId = (conv.json() as { advanceId: string }).advanceId;

    const before = await fullSnapshot();
    const ccaBefore = await ccaSnapshot(ccaId);

    const sales = await mintTenant('adv-sales-app', tenantA, rolePerms('sales'));
    const res = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      sales,
      { customerReceivableId: receivableId, amountMinor: '50' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);

    const after = await fullSnapshot();
    expect(after).toEqual(before);
    const ccaAfter = await ccaSnapshot(ccaId);
    expect(ccaAfter).toEqual(ccaBefore);
    const appRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_advance_application WHERE "customerAdvanceId" = $1`,
      [advanceId],
    );
    expect(appRows[0]!.n).toBe(0);
  });

  it('cashier denial (conversion) causes zero financial mutation, not merely a 403', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 100);
    const before = await fullSnapshot();

    const cashier = await mintTenant('adv-cashier-convmut', tenantA, rolePerms('cashier'));
    const res = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      cashier,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);

    const after = await fullSnapshot();
    expect(after).toEqual(before);
    const advanceRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_advance WHERE "sourcePaymentId" = $1`,
      [paymentId],
    );
    expect(advanceRows[0]!.n).toBe(0);
  });

  it('sales denial (conversion) causes zero financial mutation, not merely a 403', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 100);
    const before = await fullSnapshot();

    const sales = await mintTenant('adv-sales-convmut', tenantA, rolePerms('sales'));
    const res = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      sales,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);

    const after = await fullSnapshot();
    expect(after).toEqual(before);
    const advanceRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_advance WHERE "sourcePaymentId" = $1`,
      [paymentId],
    );
    expect(advanceRows[0]!.n).toBe(0);
  });

  it('cashier denial (application) causes zero financial mutation, not merely a 403', async () => {
    const { customerId, ccaId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      100,
      100,
    );
    const owner = await mintTenant('adv-owner-cashmut', tenantA, rolePerms('owner'));
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': ik() },
    );
    expect(conv.statusCode, conv.payload).toBe(201);
    const advanceId = (conv.json() as { advanceId: string }).advanceId;

    const before = await fullSnapshot();
    const ccaBefore = await ccaSnapshot(ccaId);

    const cashier = await mintTenant('adv-cashier-appmut', tenantA, rolePerms('cashier'));
    const res = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      cashier,
      { customerReceivableId: receivableId, amountMinor: '50' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);

    const after = await fullSnapshot();
    expect(after).toEqual(before);
    const ccaAfter = await ccaSnapshot(ccaId);
    expect(ccaAfter).toEqual(ccaBefore);
    const appRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_advance_application WHERE "customerAdvanceId" = $1`,
      [advanceId],
    );
    expect(appRows[0]!.n).toBe(0);
  });

  // ═══════════════════════ E20/E21 idempotency ═════════════════════════════
  it('conversion: same key + same payload replays, creates nothing new', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 150);
    const owner = await mintTenant('adv-idem-conv', tenantA, ['receivables:advance:apply']);
    const key = ik();
    const body = { paymentId, amountMinor: '150' };
    const first = await req('POST', conversionUrl(coA, branchA, customerId), owner, body, {
      'idempotency-key': key,
    });
    expect(first.statusCode, first.payload).toBe(201);
    const firstJson = first.json() as { advanceId: string };

    const replay = await req('POST', conversionUrl(coA, branchA, customerId), owner, body, {
      'idempotency-key': key,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.json() as { advanceId: string }).advanceId).toBe(firstJson.advanceId);

    const rows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_advance WHERE id = $1`,
      [firstJson.advanceId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('conversion: same key + DIFFERENT payload is rejected', async () => {
    const { customerId, paymentId } = await freshCustomerWithPaymentAndOpening(1, 200);
    const owner = await mintTenant('adv-idem-conv2', tenantA, ['receivables:advance:apply']);
    const key = ik();
    const first = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '100' },
      { 'idempotency-key': key },
    );
    expect(first.statusCode, first.payload).toBe(201);
    const conflicting = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '150' },
      { 'idempotency-key': key },
    );
    expect(conflicting.statusCode).toBe(409);
    expect(errCode(conflicting)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('application: same key + same payload replays, creates nothing new', async () => {
    const { customerId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      200,
      200,
    );
    const owner = await mintTenant('adv-idem-app', tenantA, ['receivables:advance:apply']);
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '200' },
      { 'idempotency-key': ik() },
    );
    const advanceId = (conv.json() as { advanceId: string }).advanceId;

    const key = ik();
    const body = { customerReceivableId: receivableId, amountMinor: '150' };
    const first = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      owner,
      body,
      { 'idempotency-key': key },
    );
    expect(first.statusCode, first.payload).toBe(201);
    const firstJson = first.json() as { applicationId: string };

    const replay = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      owner,
      body,
      { 'idempotency-key': key },
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.json() as { applicationId: string }).applicationId).toBe(
      firstJson.applicationId,
    );

    const rows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_advance_application WHERE id = $1`,
      [firstJson.applicationId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('application: same key + DIFFERENT payload is rejected', async () => {
    const { customerId, receivableId, paymentId } = await freshCustomerWithPaymentAndOpening(
      300,
      300,
    );
    const owner = await mintTenant('adv-idem-app2', tenantA, ['receivables:advance:apply']);
    const conv = await req(
      'POST',
      conversionUrl(coA, branchA, customerId),
      owner,
      { paymentId, amountMinor: '300' },
      { 'idempotency-key': ik() },
    );
    const advanceId = (conv.json() as { advanceId: string }).advanceId;

    const key = ik();
    const first = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      owner,
      { customerReceivableId: receivableId, amountMinor: '100' },
      { 'idempotency-key': key },
    );
    expect(first.statusCode, first.payload).toBe(201);
    const conflicting = await req(
      'POST',
      applicationUrl(coA, branchA, customerId, advanceId),
      owner,
      { customerReceivableId: receivableId, amountMinor: '200' },
      { 'idempotency-key': key },
    );
    expect(conflicting.statusCode).toBe(409);
    expect(errCode(conflicting)).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
