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

/**
 * Task 3b.6 Checkpoint D hardening (task 10) — the new customer-level
 * receipt route (`POST .../customers/:customerId/receipts`), proven at the
 * real HTTP layer: `receivables:collect` permission gate, no step-up, and —
 * the specific gap this pass closes — the shared `@Idempotent` replay
 * contract for the WHOLE operation (same-key replay creates nothing new;
 * same-key/different-payload is a `409 IDEMPOTENCY_KEY_REUSED`, never
 * silently reprocessed). Mirrors
 * `payment.controller.integration.test.ts`'s own harness exactly.
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b6001';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b6000', 'starter-3b6', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b6000', 1, 'PUBLISHED', now());
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

describe('CustomerReceiptController (task 3b.6 Checkpoint D hardening, HTTP integration)', () => {
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
       VALUES (uuidv7(), 'recpt-3b6-a', 'recpt-3b6-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
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

  // ── harness (mirrors payment.controller.integration.test.ts exactly) ───
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
  async function mintTenant(
    id: string,
    forTenant: string,
    perms: string[],
    opts: { branchScope?: string[] | 'ALL' } = {},
  ): Promise<string> {
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
      branchScope: opts.branchScope ?? 'ALL',
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
  const ik = (): string => `recpt-key-${String(++idemN).padStart(4, '0')}`;

  /** a fresh customer + CCA + one Opening Receivable of `openingAmountMinor`. */
  async function freshCustomerWithOpening(
    openingAmountMinor: number,
  ): Promise<{ customerId: string; ccaId: string; receivableId: string }> {
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
    return { customerId, ccaId, receivableId };
  }

  const receiptsUrl = (companyId: string, branchId: string, customerId: string): string =>
    `/companies/${companyId}/branches/${branchId}/customers/${customerId}/receipts`;
  const body = (amountMinor: string, method: string): { amountMinor: string; method: string } => ({
    amountMinor,
    method,
  });

  it('a permitted Owner collects a valid customer receipt — 201, fully allocates', async () => {
    const { customerId } = await freshCustomerWithOpening(200);
    const collector = await mintTenant('recpt-user', tenantA, ['receivables:collect']);
    const res = await req(
      'POST',
      receiptsUrl(coA, branchA, customerId),
      collector,
      body('150', 'CASH'),
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    const json = res.json() as { allocatedAmountMinor: string; unallocatedAmountMinor: string };
    expect(json.allocatedAmountMinor).toBe('150');
    expect(json.unallocatedAmountMinor).toBe('0');
  });

  it('rejects CARD_TERMINAL at the DTO layer (final freeze — unconditional, no branch-config lookup)', async () => {
    const { customerId } = await freshCustomerWithOpening(100);
    const collector = await mintTenant('recpt-card-user', tenantA, ['receivables:collect']);
    const res = await req(
      'POST',
      receiptsUrl(coA, branchA, customerId),
      collector,
      body('50', 'CARD_TERMINAL'),
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects ONLINE_GATEWAY at the DTO layer', async () => {
    const { customerId } = await freshCustomerWithOpening(100);
    const collector = await mintTenant('recpt-gateway-user', tenantA, ['receivables:collect']);
    const res = await req(
      'POST',
      receiptsUrl(coA, branchA, customerId),
      collector,
      body('50', 'ONLINE_GATEWAY'),
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(400);
  });

  it('missing receivables:collect permission is rejected', async () => {
    const { customerId } = await freshCustomerWithOpening(100);
    const noPerm = await mintTenant('recpt-noperm', tenantA, ['receivables:view']);
    const res = await req(
      'POST',
      receiptsUrl(coA, branchA, customerId),
      noPerm,
      body('50', 'CASH'),
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(403);
  });

  // ═══════════════════════ HTTP IDEMPOTENCY (task 10) ══════════════════════
  it('replaying a successful receipt with the SAME key + SAME payload returns the stored response and creates nothing new', async () => {
    const { customerId } = await freshCustomerWithOpening(300);
    const collector = await mintTenant('recpt-idem-user', tenantA, ['receivables:collect']);
    const key = ik();
    const reqBody = body('120', 'CASH');
    const first = await req('POST', receiptsUrl(coA, branchA, customerId), collector, reqBody, {
      'idempotency-key': key,
    });
    expect(first.statusCode, first.payload).toBe(201);
    const firstJson = first.json() as { paymentId: string };

    const replay = await req('POST', receiptsUrl(coA, branchA, customerId), collector, reqBody, {
      'idempotency-key': key,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.json() as { paymentId: string }).paymentId).toBe(firstJson.paymentId);

    const paymentRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment WHERE id = $1`,
      [firstJson.paymentId],
    );
    expect(paymentRows[0]!.n).toBe(1);
    const applicationRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_receivable_payment_application WHERE "paymentId" = $1`,
      [firstJson.paymentId],
    );
    expect(applicationRows[0]!.n).toBe(1);
    const entryRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customer_account_entry WHERE "paymentId" = $1`,
      [firstJson.paymentId],
    );
    expect(entryRows[0]!.n).toBe(1);
    const journalRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM journal_entry WHERE "sourceKind" = 'customer_receipt_payment' AND "sourceId" = $1`,
      [firstJson.paymentId],
    );
    expect(journalRows[0]!.n).toBe(1);
  });

  it('the SAME Idempotency-Key with a DIFFERENT payload is rejected — never silently replayed/reprocessed', async () => {
    const { customerId } = await freshCustomerWithOpening(500);
    const collector = await mintTenant('recpt-conflict-user', tenantA, ['receivables:collect']);
    const key = ik();
    const first = await req(
      'POST',
      receiptsUrl(coA, branchA, customerId),
      collector,
      body('100', 'CASH'),
      { 'idempotency-key': key },
    );
    expect(first.statusCode, first.payload).toBe(201);

    const conflicting = await req(
      'POST',
      receiptsUrl(coA, branchA, customerId),
      collector,
      body('200', 'CASH'),
      { 'idempotency-key': key },
    );
    expect(conflicting.statusCode).toBe(409);
    expect(errCode(conflicting)).toBe('IDEMPOTENCY_KEY_REUSED');

    const paymentRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment p
         JOIN payment_attempt pa ON pa.id = p."sourceAttemptId"
        WHERE pa."customerCompanyAccountId" IN (
          SELECT id FROM customer_company_account WHERE "customerId" = $1
        )`,
      [customerId],
    );
    expect(paymentRows[0]!.n).toBe(1); // exactly the first payment — the conflicting request never ran
  });

  it('Idempotency-Key is required', async () => {
    const { customerId } = await freshCustomerWithOpening(100);
    const collector = await mintTenant('recpt-no-key-user', tenantA, ['receivables:collect']);
    const res = await req(
      'POST',
      receiptsUrl(coA, branchA, customerId),
      collector,
      body('50', 'CASH'),
    );
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe('IDEMPOTENCY_KEY_MISSING');
  });
});
