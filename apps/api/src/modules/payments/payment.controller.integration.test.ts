import 'reflect-metadata';
import crypto from 'node:crypto';
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

/**
 * Task 3b.5 Checkpoint C+D (integration, HTTP layer) — the synchronous
 * `POST .../invoices/:invoiceId/payments` route, completed in Checkpoint D
 * to its final N>=1-tender shape (a single-tender request remains exactly
 * Checkpoint C's own behavior): permission gates (`payments:collect`
 * required, `payments:view` alone insufficient, Cashier/Sales defaults, no
 * step-up), the shared `@Idempotent` replay contract for the WHOLE
 * operation (including the same-key/different-payload conflict case), the
 * component-sum validation hard gate, the Multi Payment happy path
 * (`paymentGroupId`, response order), and the same-tenant company/branch
 * access boundary at the HTTP layer (Checkpoint B §1's deferred proof, HTTP
 * side — the repository-level proof, including all concurrency/rollback/
 * reservation-interaction cases, lives in
 * `payment-collection.repository.integration.test.ts`).
 *
 * Order/Invoice fixtures are seeded directly via SQL (mirrors
 * `order.controller.integration.test.ts`'s own precedent of exercising
 * Checkpoint C's internal, non-HTTP issuance primitive directly in test
 * code) — no catalog/product/pricing/tax setup is needed here at all, since
 * this checkpoint never resolves a price or a tax rate.
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b5001';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b5000', 'starter-3b5', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b5000', 1, 'PUBLISHED', now());
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

describe('PaymentController (task 3b.5 Checkpoint C+D, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let tenantB = '';
  let coA = '';
  let coA2 = '';
  let branchA = '';
  let branchB = '';
  let branchOtherCo = '';

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
       VALUES (uuidv7(), 'pay-c-a', 'pay-c-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
    tenantB =
      await sqlOne(`INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'pay-c-b', 'pay-c-b', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
    coA = await sqlOne(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES (uuidv7(),$1,'Co A','AED','Asia/Dubai',now()) RETURNING id`,
      [tenantA],
    );
    coA2 = await sqlOne(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES (uuidv7(),$1,'Co A2','AED','Asia/Dubai',now()) RETURNING id`,
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
    branchOtherCo = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch on Co A2',now()) RETURNING id`,
      [tenantA, coA2],
    );
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── harness (mirrors order.controller.integration.test.ts exactly) ─────
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
  const ik = (): string => `pay-key-${String(++idemN).padStart(4, '0')}`;

  /** seeds a fresh CONFIRMED Order + issued Invoice under the given
   *  tenant/company/branch, returning the invoiceId. */
  async function freshInvoice(
    forTenant: string,
    companyId: string,
    branchId: string,
    totalAmountMinor = 500,
  ): Promise<string> {
    const orderId = await sqlOne(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
          "currencyCode","currencyExponent","commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode",
          "orderNumber",version,"updatedAt")
       VALUES (uuidv7(),$1,$2,$3,$3,'WALK_IN','CONFIRMED','AED',2,$4,2,'TAX_EXCLUSIVE','LINE','HALF_UP',
               $5,1,now())
       RETURNING id`,
      [
        forTenant,
        companyId,
        branchId,
        `fp-${crypto.randomUUID()}`,
        `ORD-${crypto.randomUUID().slice(0, 6)}`,
      ],
    );
    const categoryId = await sqlOne(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt")
       VALUES (uuidv7(),$1,$2,'Flowers',now()) RETURNING id`,
      [forTenant, `flowers-${crypto.randomUUID()}`],
    );
    const productId = await sqlOne(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'Rose','STOCKED',now()) RETURNING id`,
      [forTenant, categoryId, `rose-${crypto.randomUUID()}`],
    );
    const variantId = await sqlOne(
      `INSERT INTO variant (id,"tenantId","productId","nameEn","updatedAt")
       VALUES (uuidv7(),$1,$2,'Rose Variant',now()) RETURNING id`,
      [forTenant, productId],
    );
    await sql(
      `INSERT INTO order_line
         (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
          "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
          "priceTaxMode","roundingScope","roundingMode","lineTaxAmountMinor",
          "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
          "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,1,$4,$5,'1.0000',$6,'AED',2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Rose','Rose Variant', now())`,
      [forTenant, companyId, orderId, productId, variantId, totalAmountMinor],
    );
    const invoiceId = await sqlOne(
      `INSERT INTO invoice
         (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
          "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
          "taxTotalAmountMinor","totalAmountMinor")
       VALUES (uuidv7(),$1,$2,$3,$4,$5,now(),CURRENT_DATE,'AED',2,$6,0,0,$6)
       RETURNING id`,
      [
        forTenant,
        companyId,
        branchId,
        orderId,
        `INV-${crypto.randomUUID().slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    return invoiceId;
  }

  const paymentsUrl = (companyId: string, branchId: string, invoiceId: string): string =>
    `/companies/${companyId}/branches/${branchId}/invoices/${invoiceId}/payments`;
  /** the final Checkpoint D request shape — top-level `amountMinor` (the
   *  intended total) + a `tenders` array of one or more components. */
  const body = (
    amountMinor: string,
    tenders: { method: string; amountMinor: string }[],
  ): { amountMinor: string; tenders: { method: string; amountMinor: string }[] } => ({
    amountMinor,
    tenders,
  });

  // ═══════════════════════════ PERMISSIONS (C20/D18) ═════════════════════
  describe('permission hard gates', () => {
    it('payments:collect is required — a request with no permissions is rejected', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const noPerm = await mintTenant('noperm', tenantA, []);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        noPerm,
        body('100', [{ method: 'CASH', amountMinor: '100' }]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(403);
    });

    it('payments:view alone cannot collect', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const viewOnly = await mintTenant('viewonly', tenantA, ['payments:view']);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        viewOnly,
        body('100', [{ method: 'CASH', amountMinor: '100' }]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(403);
    });

    it('an unrelated permission cannot collect', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const unrelated = await mintTenant('unrelated', tenantA, ['orders:view', 'orders:manage']);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        unrelated,
        body('100', [{ method: 'CASH', amountMinor: '100' }]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(403);
    });

    it('payments:collect succeeds, no step-up required (single tender)', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('collector', tenantA, [
        'payments:view',
        'payments:collect',
      ]);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        collector,
        body('100', [{ method: 'CASH', amountMinor: '100' }]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
    });

    it('payments:collect succeeds on a Multi Payment (>1 tender), no step-up required', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA, 175);
      const collector = await mintTenant('collector-multi', tenantA, [
        'payments:view',
        'payments:collect',
      ]);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        collector,
        body('175', [
          { method: 'CASH', amountMinor: '50' },
          { method: 'CARD_TERMINAL', amountMinor: '100' },
          { method: 'BANK_TRANSFER', amountMinor: '25' },
        ]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
    });

    it('role default Cashier can collect', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const cashier = await mintTenant('cashier', tenantA, ['payments:view', 'payments:collect']);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        cashier,
        body('100', [{ method: 'CASH', amountMinor: '100' }]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
    });

    it('role default Sales can collect', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const sales = await mintTenant('sales', tenantA, ['payments:view', 'payments:collect']);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        sales,
        body('100', [{ method: 'CASH', amountMinor: '100' }]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
    });
  });

  // ═══════════════════════════ MULTI PAYMENT HAPPY PATH (D10) ════════════
  it('175 total across CASH 50 / CARD_TERMINAL 100 / BANK_TRANSFER 25 — one group, 3 payments, response order preserved', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA, 175);
    const collector = await mintTenant('multi-happy', tenantA, ['payments:collect']);
    const res = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('175', [
        { method: 'CASH', amountMinor: '50' },
        { method: 'CARD_TERMINAL', amountMinor: '100' },
        { method: 'BANK_TRANSFER', amountMinor: '25' },
      ]),
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    const json = res.json() as {
      paymentGroupId: string | null;
      amountMinor: string;
      payments: { method: string; amountMinor: string }[];
      remainingAvailableToCollectMinor: string;
    };
    expect(json.paymentGroupId).not.toBeNull();
    expect(json.amountMinor).toBe('175');
    expect(json.payments.map((p) => p.method)).toEqual(['CASH', 'CARD_TERMINAL', 'BANK_TRANSFER']);
    expect(json.payments.map((p) => p.amountMinor)).toEqual(['50', '100', '25']);
    expect(json.remainingAvailableToCollectMinor).toBe('0');

    const groupRows = await sql<{ n: number }>(
      `SELECT COUNT(DISTINCT "paymentGroupId")::int AS n FROM payment_attempt WHERE "paymentGroupId" = $1`,
      [json.paymentGroupId],
    );
    expect(groupRows[0]!.n).toBe(1);
    const invRows = await sql<{ status: string }>(
      `SELECT "invoicePaymentStatus" AS status FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invRows[0]!.status).toBe('UNPAID');
  });

  // ═══════════════════════════ IDEMPOTENCY — WHOLE OPERATION (D9) ════════
  it('replaying a successful single-tender request returns the stored response and creates nothing new', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('idem-user', tenantA, ['payments:collect']);
    const key = ik();
    const reqBody = body('150', [{ method: 'CASH', amountMinor: '150' }]);
    const first = await req('POST', paymentsUrl(coA, branchA, invoiceId), collector, reqBody, {
      'idempotency-key': key,
    });
    expect(first.statusCode, first.payload).toBe(201);
    const firstJson = first.json() as { payments: { paymentId: string }[] };

    const replay = await req('POST', paymentsUrl(coA, branchA, invoiceId), collector, reqBody, {
      'idempotency-key': key,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.json() as { payments: { paymentId: string }[] }).payments[0]!.paymentId).toBe(
      firstJson.payments[0]!.paymentId,
    );

    const rows = await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payment WHERE id = $1`, [
      firstJson.payments[0]!.paymentId,
    ]);
    expect(rows[0]!.n).toBe(1);
    const allocRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment_allocation WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    expect(allocRows[0]!.n).toBe(1);
  });

  it('(D9-A) replaying a successful 3-tender Multi Payment returns the identical group/payment ids and creates zero additional rows', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA, 175);
    const collector = await mintTenant('idem-multi-user', tenantA, ['payments:collect']);
    const key = ik();
    const reqBody = body('175', [
      { method: 'CASH', amountMinor: '50' },
      { method: 'CARD_TERMINAL', amountMinor: '100' },
      { method: 'BANK_TRANSFER', amountMinor: '25' },
    ]);
    const first = await req('POST', paymentsUrl(coA, branchA, invoiceId), collector, reqBody, {
      'idempotency-key': key,
    });
    expect(first.statusCode, first.payload).toBe(201);
    const firstJson = first.json() as {
      paymentGroupId: string;
      payments: { paymentId: string; paymentAttemptId: string; paymentAllocationId: string }[];
    };

    const replay = await req('POST', paymentsUrl(coA, branchA, invoiceId), collector, reqBody, {
      'idempotency-key': key,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const replayJson = replay.json() as typeof firstJson;
    expect(replayJson).toEqual(firstJson);

    const groupRows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment WHERE "paymentGroupId" = $1`,
      [firstJson.paymentGroupId],
    );
    expect(groupRows[0]!.n).toBe(3);
  });

  it('(D9-B) the same Idempotency-Key with a DIFFERENT request payload is rejected — never silently replayed/reprocessed', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA, 500);
    const collector = await mintTenant('idem-conflict-user', tenantA, ['payments:collect']);
    const key = ik();
    const first = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('100', [{ method: 'CASH', amountMinor: '100' }]),
      { 'idempotency-key': key },
    );
    expect(first.statusCode, first.payload).toBe(201);

    // same key, a materially different request (different amount)
    const conflicting = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('200', [{ method: 'CASH', amountMinor: '200' }]),
      { 'idempotency-key': key },
    );
    expect(conflicting.statusCode).toBe(409);
    expect(errCode(conflicting)).toBe('IDEMPOTENCY_KEY_REUSED');

    // exactly the first payment exists — the conflicting request never ran
    const rows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment_allocation WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('Idempotency-Key is required', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('no-key-user', tenantA, ['payments:collect']);
    const res = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('100', [{ method: 'CASH', amountMinor: '100' }]),
    );
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe('IDEMPOTENCY_KEY_MISSING');
  });

  // ═══════════════════════════ ROUTE / DTO SHAPE (C13/C7/D2) ═════════════
  it('rejects ONLINE_GATEWAY at the DTO layer', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('dto-user', tenantA, ['payments:collect']);
    const res = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('100', [{ method: 'ONLINE_GATEWAY', amountMinor: '100' }]),
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(400);
  });

  it('accepts more than one tender (Checkpoint D completion — no longer rejected)', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA, 100);
    const collector = await mintTenant('multi-user', tenantA, ['payments:collect']);
    const res = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('100', [
        { method: 'CASH', amountMinor: '50' },
        { method: 'CARD_TERMINAL', amountMinor: '50' },
      ]),
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  });

  it('(D12) rejects when the component sum does not equal the top-level amountMinor', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA, 500);
    const collector = await mintTenant('sum-mismatch-user', tenantA, ['payments:collect']);
    const under = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('175', [
        { method: 'CASH', amountMinor: '50' },
        { method: 'CARD_TERMINAL', amountMinor: '100' },
        { method: 'BANK_TRANSFER', amountMinor: '24' },
      ]),
      { 'idempotency-key': ik() },
    );
    expect(under.statusCode).toBe(422);
    expect(errCode(under)).toBe('PAYMENT_MULTI_PAYMENT_SUM_MISMATCH');

    const over = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      body('175', [
        { method: 'CASH', amountMinor: '50' },
        { method: 'CARD_TERMINAL', amountMinor: '100' },
        { method: 'BANK_TRANSFER', amountMinor: '26' },
      ]),
      { 'idempotency-key': ik() },
    );
    expect(over.statusCode).toBe(422);
    expect(errCode(over)).toBe('PAYMENT_MULTI_PAYMENT_SUM_MISMATCH');

    const rows = await sql<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
      [invoiceId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects a client-supplied providerCredentialId/currencyCode as unknown fields', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('strict-user', tenantA, ['payments:collect']);
    const res = await req(
      'POST',
      paymentsUrl(coA, branchA, invoiceId),
      collector,
      {
        amountMinor: '100',
        tenders: [
          { method: 'CASH', amountMinor: '100', currencyCode: 'AED', providerCredentialId: 'x' },
        ],
      },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode).toBe(400);
  });

  // ═══════════════════════════ ACCESS SCOPE (C19/D18, HTTP layer) ════════
  describe('same-tenant company/branch access (HTTP layer)', () => {
    it('same tenant, wrong company route param -> guard-pipeline rejection', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('scope-user-1', tenantA, ['payments:collect'], {
        branchScope: [branchA],
      });
      const res = await req(
        'POST',
        paymentsUrl(coA2, branchOtherCo, invoiceId),
        collector,
        body('10', [{ method: 'CASH', amountMinor: '10' }]),
        { 'idempotency-key': ik() },
      );
      expect([403, 404]).toContain(res.statusCode);
    });

    it('same tenant + company, wrong branch scope -> guard-pipeline rejection', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('scope-user-2', tenantA, ['payments:collect'], {
        branchScope: [branchB],
      });
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        collector,
        body('10', [{ method: 'CASH', amountMinor: '10' }]),
        { 'idempotency-key': ik() },
      );
      expect([403, 404]).toContain(res.statusCode);
    });

    it('wrong tenant entirely -> inaccessible', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const otherTenantUser = await mintTenant('other-tenant-user', tenantB, ['payments:collect']);
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        otherTenantUser,
        body('10', [{ method: 'CASH', amountMinor: '10' }]),
        { 'idempotency-key': ik() },
      );
      expect([403, 404]).toContain(res.statusCode);
    });

    it('correct tenant/company/branch -> Multi Payment succeeds', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA, 60);
      const collector = await mintTenant('scope-ok-user', tenantA, ['payments:collect'], {
        branchScope: [branchA],
      });
      const res = await req(
        'POST',
        paymentsUrl(coA, branchA, invoiceId),
        collector,
        body('60', [
          { method: 'CASH', amountMinor: '30' },
          { method: 'BANK_TRANSFER', amountMinor: '30' },
        ]),
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
    });
  });
});
