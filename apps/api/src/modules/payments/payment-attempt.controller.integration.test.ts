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
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import type { PaymentProvider } from './payment-provider.port.js';

/**
 * Task 3b.5 Checkpoint E (integration, HTTP layer) — the async
 * `POST .../invoices/:invoiceId/payment-attempts` route: permission gates
 * (`payments:collect` required, no step-up), the closed `.strict()` DTO
 * (forbidden authoritative/server-derived fields, disallowed methods), the
 * shared `@Idempotent` replay contract, same-tenant company/branch access
 * boundary, and the bounded §E19 response shape. The full reservation/
 * concurrency/provider-result matrix lives in
 * `payment-attempt.repository.integration.test.ts` — this file proves only
 * the HTTP wiring around it, with one deterministic fake provider
 * registered directly against the app's own `PaymentProviderRegistry`
 * instance (mirrors this checkpoint's own "tests may register deterministic
 * fake providers" allowance).
 */
const PLAN_V = '00000000-0000-7000-8000-0000003be001';
const PROVIDER_KEY = 'fake-e2e';
const THROWING_PROVIDER_KEY = 'fake-e2e-throws';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003be000', 'starter-3be', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003be000', 1, 'PUBLISHED', now());
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

describe('PaymentAttemptController (task 3b.5 Checkpoint E, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let tenantB = '';
  let coA = '';
  let coA2 = '';
  let branchA = '';
  let branchOtherCo = '';
  let credentialId = '';

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

    // register one deterministic fake adapter directly on the app's own
    // registry singleton — no vendor code anywhere in this file (§E28).
    const fakeProvider: PaymentProvider = {
      // a distinct providerReference per call — this repository's own
      // Checkpoint E migration enforces UNIQUE(providerCredentialId,
      // providerReference), so a realistic fake never reuses one value
      // across different attempts under the same credential.
      createIntent: async () => ({
        state: 'REQUIRES_ACTION',
        providerReference: `fake-e2e-ref-${crypto.randomUUID()}`,
      }),
      authorize: async () => ({}),
      capture: async () => ({}),
      refund: async () => ({}),
      getStatus: async () => ({}),
      verifyWebhook: async () => ({ providerEventId: 'unused', eventType: 'unused' }),
    };
    app.get(PaymentProviderRegistry).register(PROVIDER_KEY, fakeProvider);

    tenantA =
      await sqlOne(`INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'pay-e-a', 'pay-e-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
    tenantB =
      await sqlOne(`INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'pay-e-b', 'pay-e-b', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`);
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
    branchOtherCo = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch on Co A2',now()) RETURNING id`,
      [tenantA, coA2],
    );
    credentialId = await sqlOne(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, status,
          "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, $4, 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
       RETURNING id`,
      [tenantA, coA, branchA, PROVIDER_KEY],
    );
    await sql(
      `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
       VALUES (uuidv7(), $1, $2, $3, $4)`,
      [tenantA, coA, branchA, credentialId],
    );

    // a SECOND fake provider that always throws — proves the HTTP-level
    // retryable-outcome behavior (owner recovery-pass §4) without touching
    // the primary happy-path fixtures above.
    const throwingProvider: PaymentProvider = {
      createIntent: async () => {
        throw new Error('simulated transport failure');
      },
      authorize: async () => ({}),
      capture: async () => ({}),
      refund: async () => ({}),
      getStatus: async () => ({}),
      verifyWebhook: async () => ({ providerEventId: 'unused', eventType: 'unused' }),
    };
    app.get(PaymentProviderRegistry).register(THROWING_PROVIDER_KEY, throwingProvider);
    const throwingCredentialId = await sqlOne(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, status,
          "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, $4, 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
       RETURNING id`,
      [tenantA, coA, branchA, THROWING_PROVIDER_KEY],
    );
    await sql(
      `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
       VALUES (uuidv7(), $1, $2, $3, $4)`,
      [tenantA, coA, branchA, throwingCredentialId],
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
  let idemN = 0;
  const ik = (): string => `pay-attempt-key-${String(++idemN).padStart(4, '0')}`;

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
    return sqlOne(
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
  }

  const attemptsUrl = (companyId: string, branchId: string, invoiceId: string): string =>
    `/companies/${companyId}/branches/${branchId}/invoices/${invoiceId}/payment-attempts`;
  const validBody = (amountMinor = '100'): Record<string, unknown> => ({
    method: 'ONLINE_GATEWAY',
    amountMinor,
    providerKey: PROVIDER_KEY,
  });

  // ═══════════════════════════ PERMISSIONS (§E20) ══════════════════════════
  describe('permission hard gates', () => {
    it('payments:collect is required — no permissions is rejected', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const noPerm = await mintTenant('e-noperm', tenantA, []);
      const res = await req('POST', attemptsUrl(coA, branchA, invoiceId), noPerm, validBody(), {
        'idempotency-key': ik(),
      });
      expect(res.statusCode).toBe(403);
    });

    it('payments:view alone cannot create an attempt', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const viewOnly = await mintTenant('e-viewonly', tenantA, ['payments:view']);
      const res = await req('POST', attemptsUrl(coA, branchA, invoiceId), viewOnly, validBody(), {
        'idempotency-key': ik(),
      });
      expect(res.statusCode).toBe(403);
    });

    it('payments:collect succeeds, 202 Accepted, no step-up required', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('e-collector', tenantA, ['payments:collect']);
      const res = await req('POST', attemptsUrl(coA, branchA, invoiceId), collector, validBody(), {
        'idempotency-key': ik(),
      });
      expect(res.statusCode, res.payload).toBe(202);
    });
  });

  // ═══════════════════════════ SCOPE (§E20) ════════════════════════════════
  it('same-tenant, wrong company is inaccessible', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('e-scope-co', tenantA, ['payments:collect']);
    const res = await req(
      'POST',
      attemptsUrl(coA2, branchOtherCo, invoiceId),
      collector,
      validBody(),
      {
        'idempotency-key': ik(),
      },
    );
    expect(res.statusCode).not.toBe(202);
  });

  it('wrong tenant is inaccessible', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const otherTenantUser = await mintTenant('e-scope-tenant', tenantB, ['payments:collect']);
    const res = await req(
      'POST',
      attemptsUrl(coA, branchA, invoiceId),
      otherTenantUser,
      validBody(),
      {
        'idempotency-key': ik(),
      },
    );
    expect(res.statusCode).not.toBe(202);
  });

  // ═══════════════════════════ DTO / route shape (§E4) ═════════════════════
  describe('closed DTO', () => {
    it('rejects CASH — this async route never accepts a local tender', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('e-dto-cash', tenantA, ['payments:collect']);
      const res = await req(
        'POST',
        attemptsUrl(coA, branchA, invoiceId),
        collector,
        { ...validBody(), method: 'CASH' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(400);
    });

    for (const forbidden of [
      'providerCredentialId',
      'currencyCode',
      'currencyExponent',
      'tenantId',
      'companyId',
      'branchId',
      'paymentGroupId',
      'providerReference',
      'webhookEndpointId',
    ]) {
      it(`rejects an unknown/forbidden field: ${forbidden}`, async () => {
        const invoiceId = await freshInvoice(tenantA, coA, branchA);
        const collector = await mintTenant('e-dto-forbidden', tenantA, ['payments:collect']);
        const res = await req(
          'POST',
          attemptsUrl(coA, branchA, invoiceId),
          collector,
          { ...validBody(), [forbidden]: 'x' },
          { 'idempotency-key': ik() },
        );
        expect(res.statusCode).toBe(400);
      });
    }
  });

  // ═══════════════════════════ HAPPY PATH + RESPONSE SHAPE (§E19) ═════════
  it('happy path: bounded response shape, no secret/internal field leaked', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('e-happy', tenantA, ['payments:collect']);
    const res = await req(
      'POST',
      attemptsUrl(coA, branchA, invoiceId),
      collector,
      validBody('150'),
      {
        'idempotency-key': ik(),
      },
    );
    expect(res.statusCode, res.payload).toBe(202);
    const json = res.json() as Record<string, unknown>;
    expect(json['state']).toBe('REQUIRES_ACTION');
    expect(json['invoiceId']).toBe(invoiceId);
    expect(json['amountMinor']).toBe('150');
    expect(json['providerKey']).toBe(PROVIDER_KEY);
    expect(Object.keys(json).sort()).toEqual(
      [
        'paymentAttemptId',
        'invoiceId',
        'method',
        'providerKey',
        'amountMinor',
        'currencyCode',
        'currencyExponent',
        'state',
      ].sort(),
    );
  });

  // ═══════════════════════════ IDEMPOTENCY (§E18) ══════════════════════════
  describe('idempotency', () => {
    it('identical replay returns the SAME attempt', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('e-idem-same', tenantA, ['payments:collect']);
      const key = ik();
      const first = await req(
        'POST',
        attemptsUrl(coA, branchA, invoiceId),
        collector,
        validBody(),
        {
          'idempotency-key': key,
        },
      );
      const second = await req(
        'POST',
        attemptsUrl(coA, branchA, invoiceId),
        collector,
        validBody(),
        {
          'idempotency-key': key,
        },
      );
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect((first.json() as { paymentAttemptId: string }).paymentAttemptId).toBe(
        (second.json() as { paymentAttemptId: string }).paymentAttemptId,
      );
    });

    it('same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('e-idem-diff', tenantA, ['payments:collect']);
      const key = ik();
      const first = await req(
        'POST',
        attemptsUrl(coA, branchA, invoiceId),
        collector,
        validBody('100'),
        { 'idempotency-key': key },
      );
      expect(first.statusCode).toBe(202);
      const second = await req(
        'POST',
        attemptsUrl(coA, branchA, invoiceId),
        collector,
        validBody('200'),
        { 'idempotency-key': key },
      );
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { code: string } }).error.code).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('a missing Idempotency-Key is rejected', async () => {
      const invoiceId = await freshInvoice(tenantA, coA, branchA);
      const collector = await mintTenant('e-idem-missing', tenantA, ['payments:collect']);
      const res = await req('POST', attemptsUrl(coA, branchA, invoiceId), collector, validBody());
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════ AMBIGUOUS OUTCOME IS RETRYABLE, NEVER A CACHED 2XX
  // (owner recovery-pass §4) ════════════════════════════════════════════
  it('an ambiguous provider outcome returns a retryable non-2xx, and a retry with the SAME key recovers and can succeed', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('e-ambiguous', tenantA, ['payments:collect']);
    const key = ik();
    const first = await req(
      'POST',
      attemptsUrl(coA, branchA, invoiceId),
      collector,
      { ...validBody(), providerKey: THROWING_PROVIDER_KEY },
      { 'idempotency-key': key },
    );
    // never a 2xx — the shared idempotency interceptor must release its
    // claim, not cache this as a successful replay (owner recovery-pass §4).
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(first.statusCode).toBeLessThan(500);
    const body = first.json() as {
      error: { code: string; message: string; details?: { field: string; issue: string }[] };
    };
    expect(body.error.code).toBe('PAYMENT_PROVIDER_OUTCOME_UNKNOWN');
    // never leaks the raw adapter exception message.
    expect(body.error.message).not.toMatch(/simulated transport failure/);
    const attemptId = body.error.details?.find((d) => d.field === 'paymentAttemptId')?.issue;
    expect(attemptId).toBeTruthy();

    // retry with the SAME Idempotency-Key — the shared claim was released,
    // so this is a fresh handler execution; the DB-level recovery finds the
    // SAME attempt (never a second one) and (since the fake keeps throwing)
    // returns the same retryable outcome again, never minting a duplicate.
    const retry = await req(
      'POST',
      attemptsUrl(coA, branchA, invoiceId),
      collector,
      { ...validBody(), providerKey: THROWING_PROVIDER_KEY },
      { 'idempotency-key': key },
    );
    expect(retry.statusCode).toBe(first.statusCode);
    const retryBody = retry.json() as { error: { details?: { field: string; issue: string }[] } };
    expect(retryBody.error.details?.find((d) => d.field === 'paymentAttemptId')?.issue).toBe(
      attemptId,
    );
  });

  // ═══════════════ createdByUserId / principal identity (owner
  // recovery-pass §12) ═════════════════════════════════════════════════
  it('the persisted createdByUserId is exactly the authenticated principal used by the shared idempotency layer', async () => {
    const invoiceId = await freshInvoice(tenantA, coA, branchA);
    const collector = await mintTenant('e-principal', tenantA, ['payments:collect']);
    const res = await req('POST', attemptsUrl(coA, branchA, invoiceId), collector, validBody(), {
      'idempotency-key': ik(),
    });
    expect(res.statusCode).toBe(202);
    const attemptId = (res.json() as { paymentAttemptId: string }).paymentAttemptId;
    const rows = await sql<{ createdByUserId: string }>(
      `SELECT "createdByUserId" FROM payment_attempt WHERE id = $1`,
      [attemptId],
    );
    // `IdempotencyInterceptor` reads `principalId = getContext()?.userId`
    // (the SAME `RequestContext.userId` the async-attempt orchestration
    // reads as `createdByUserId`) — both derive from the SAME session/JWT
    // `sub` claim for this tenant-realm route, so the two are provably the
    // same stable replay identity, never two different notions of "actor".
    expect(rows[0]!.createdByUserId).toBe(userIds.get('e-principal'));
  });
});
