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
import { installRawBodyCapture } from '../../common/http/raw-body.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import type { PaymentProvider, VerifiedProviderWebhookEvent } from './payment-provider.port.js';

const PLAN_V = '00000000-0000-7000-8000-0000003bf001';
const PROVIDER_KEY = 'fake-webhook-e2e';
const SECRET = 'test-only-shared-secret';

/** a deliberately trivial HMAC-over-raw-bytes scheme — proves the
 *  controller hands the adapter the EXACT raw bytes (never a re-serialized
 *  JSON reconstruction), never a real vendor's signature algorithm. */
function sign(rawBody: Buffer): string {
  return crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003bf000', 'starter-3bf', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003bf000', 1, 'PUBLISHED', now());
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

describe('PaymentWebhookController (task 3b.5 Checkpoint F, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let coA = '';
  let branchA = '';
  let credentialId = '';
  let endpointId = '';

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
    // AFTER init() — see `installRawBodyCapture`'s own doc comment for why.
    installRawBodyCapture(app.getHttpAdapter().getInstance());
    await app.getHttpAdapter().getInstance().ready();
    jwt = app.get(JwtService);
    store = app.get(SessionStore);

    const fakeProvider: PaymentProvider = {
      createIntent: async () => {
        throw new Error('not used in this test');
      },
      authorize: async () => ({}),
      capture: async () => ({}),
      refund: async () => ({}),
      getStatus: async () => ({}),
      async verifyWebhook(request): Promise<VerifiedProviderWebhookEvent> {
        const expected = sign(request.rawBody);
        if (request.headers['x-webhook-signature'] !== expected) {
          throw new Error('invalid signature');
        }
        const body = JSON.parse(request.rawBody.toString('utf8')) as {
          eventId: string;
        };
        return { providerEventId: body.eventId, eventType: 'ping' };
      },
    };
    app.get(PaymentProviderRegistry).register(PROVIDER_KEY, fakeProvider);

    tenantA = await sqlOne(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'pay-wh-a', 'pay-wh-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`,
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
    credentialId = await sqlOne(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, status,
          "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES (uuidv7(), $1, $2, $3, $4, 'TEST', 'ACTIVE', '\\x00', '\\x00', '\\x00', now())
       RETURNING id`,
      [tenantA, coA, branchA, PROVIDER_KEY],
    );
    endpointId = await sqlOne(
      `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
       VALUES (uuidv7(), $1, $2, $3, $4) RETURNING id`,
      [tenantA, coA, branchA, credentialId],
    );
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
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

  const webhookUrl = (id: string): string => `/webhooks/payments/${id}`;

  // ── ordinary-JSON-route regression harness (owner reliability-pass §9)
  //    — mirrors payment-attempt.controller.integration.test.ts's own
  //    mintTenant/session pattern exactly. ─────────────────────────────────
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
  let userSeq = 0;
  async function mintTenant(forTenant: string, perms: string[]): Promise<string> {
    const s = baseSess(`sess-${++userSeq}`, forTenant);
    const userId = `00000000-0000-7000-8000-${String(userSeq).padStart(12, '0')}`;
    s.userId = userId;
    s.access = {
      effectivePermissions: perms,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: userId, sid: s.sessionId, aud: 'tenant', tid: forTenant });
  }

  async function freshOrdinaryInvoice(totalAmountMinor = 100): Promise<string> {
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
        tenantA,
        coA,
        branchA,
        `fp-${crypto.randomUUID()}`,
        `ORD-${crypto.randomUUID().slice(0, 6)}`,
      ],
    );
    const categoryId = await sqlOne(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt")
       VALUES (uuidv7(),$1,$2,'Flowers',now()) RETURNING id`,
      [tenantA, `flowers-${crypto.randomUUID()}`],
    );
    const productId = await sqlOne(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'Rose','STOCKED',now()) RETURNING id`,
      [tenantA, categoryId, `rose-${crypto.randomUUID()}`],
    );
    const variantId = await sqlOne(
      `INSERT INTO variant (id,"tenantId","productId","nameEn","updatedAt")
       VALUES (uuidv7(),$1,$2,'Rose Variant',now()) RETURNING id`,
      [tenantA, productId],
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
      [tenantA, coA, orderId, productId, variantId, totalAmountMinor],
    );
    return sqlOne(
      `INSERT INTO invoice
         (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
          "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
          "taxTotalAmountMinor","totalAmountMinor")
       VALUES (uuidv7(),$1,$2,$3,$4,$5,now(),CURRENT_DATE,'AED',2,$6,0,0,$6)
       RETURNING id`,
      [tenantA, coA, branchA, orderId, `INV-${crypto.randomUUID().slice(0, 8)}`, totalAmountMinor],
    );
  }

  it('valid signature: 202, NO Authorization header needed (@Public), durable inbox row created', async () => {
    const eventId = `evt-${crypto.randomUUID()}`;
    const payload = Buffer.from(JSON.stringify({ eventId }));
    const res = await app.inject({
      method: 'POST',
      url: `/v1${webhookUrl(endpointId)}`,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(payload) },
      payload,
    });
    expect(res.statusCode, res.payload).toBe(202);
    const json = res.json() as Record<string, unknown>;
    // bounded response — no Payment id / balance / credential / exception internals.
    expect(Object.keys(json)).toEqual(['received']);
    const rows = await sql<{ status: string }>(
      `SELECT status FROM provider_payment_event WHERE "providerCredentialId" = $1 AND "providerEventId" = $2`,
      [credentialId, eventId],
    );
    expect(rows[0]!.status).toBe('EXCEPTION'); // no paymentAttemptId target — F7's own allowance
  });

  it('invalid signature: bounded non-disclosing rejection, no inbox row', async () => {
    const eventId = `evt-${crypto.randomUUID()}`;
    const payload = Buffer.from(JSON.stringify({ eventId }));
    const res = await app.inject({
      method: 'POST',
      url: `/v1${webhookUrl(endpointId)}`,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'wrong-signature' },
      payload,
    });
    expect(res.statusCode).not.toBe(202);
    expect(res.statusCode).toBeLessThan(500);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('WEBHOOK_UNAUTHENTICATED');
    expect(body.error.message).not.toMatch(/signature/i);
    const rows = await sql(
      `SELECT count(*)::int AS n FROM provider_payment_event WHERE "providerCredentialId" = $1 AND "providerEventId" = $2`,
      [credentialId, eventId],
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('unknown endpoint: the EXACT same rejection shape as an invalid signature', async () => {
    const payload = Buffer.from(JSON.stringify({ eventId: `evt-${crypto.randomUUID()}` }));
    const res = await app.inject({
      method: 'POST',
      url: `/v1${webhookUrl(crypto.randomUUID())}`,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(payload) },
      payload,
    });
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('WEBHOOK_UNAUTHENTICATED');
  });

  // ══════════════ owner Checkpoint G §G21 — byte-for-byte enumeration
  // resistance for the two failure modes the webhook's OWN security
  // boundary is responsible for (owner §F3/§F8: "unknown endpoint OR
  // invalid signature — indistinguishable"): a well-formed-but-nonexistent
  // endpoint id, and a real endpoint signed with the wrong secret, must
  // produce byte-for-byte identical responses — not merely the same
  // `error.code` string. ═══════════════════════════════════════════════
  it('§G21: unknown endpoint vs wrong signature — byte-for-byte IDENTICAL responses', async () => {
    const payload = Buffer.from(JSON.stringify({ eventId: `evt-${crypto.randomUUID()}` }));

    const scenarios = [
      // a real, well-formed UUID that maps to no endpoint at all.
      { url: webhookUrl(crypto.randomUUID()), signature: sign(payload) },
      // the REAL, existing endpoint — but signed with the wrong secret.
      { url: webhookUrl(endpointId), signature: 'wrong-signature' },
    ];

    const responses = await Promise.all(
      scenarios.map((s) =>
        app.inject({
          method: 'POST',
          url: `/v1${s.url}`,
          headers: { 'content-type': 'application/json', 'x-webhook-signature': s.signature },
          payload,
        }),
      ),
    );

    const [unknownEndpoint, wrongSignature] = responses.map((res) => ({
      statusCode: res.statusCode,
      bodyLength: Buffer.byteLength(res.payload),
      body: res.payload,
    }));
    expect(wrongSignature!.statusCode).toBe(unknownEndpoint!.statusCode);
    expect(wrongSignature!.bodyLength).toBe(unknownEndpoint!.bodyLength);
    expect(wrongSignature!.body).toBe(unknownEndpoint!.body);
    expect(unknownEndpoint!.statusCode).not.toBe(202);
    expect(unknownEndpoint!.statusCode).toBeLessThan(500);
  });

  // A malformed (non-UUID-shaped) endpoint id takes a DIFFERENT code path —
  // `assertUuid` (the same generic route-param guard every UUID-keyed route
  // in this codebase uses) rejects it with a plain `404 NOT_FOUND` before
  // ever reaching the webhook's own bootstrap/signature logic. This is
  // NOT a webhook-specific enumeration gap: it reveals nothing about which
  // endpoint ids exist (every well-formed-but-unknown id still gets the
  // identical §G21 response above) — only that this route, like every other
  // UUID-param route, expects a UUID-shaped segment, which is already
  // obvious from the API surface itself. Documented here so the distinction
  // is explicit rather than silently assumed.
  it('a malformed (non-UUID) endpoint id gets the ordinary generic 404 — not the webhook auth-failure shape', async () => {
    const payload = Buffer.from(JSON.stringify({ eventId: `evt-${crypto.randomUUID()}` }));
    const res = await app.inject({
      method: 'POST',
      url: `/v1${webhookUrl('not-a-uuid-at-all')}`,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(payload) },
      payload,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('raw bytes are exactly what the adapter verifies against — not a re-serialized reconstruction', async () => {
    // deliberately unusual key order / spacing; a re-stringified JSON.parse
    // -> JSON.stringify round-trip would very likely NOT reproduce these
    // exact bytes, so this only passes if the ORIGINAL buffer is used.
    const eventId = `evt-${crypto.randomUUID()}`;
    const payload = Buffer.from(`{  "eventId":   "${eventId}"   }`);
    const res = await app.inject({
      method: 'POST',
      url: `/v1${webhookUrl(endpointId)}`,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(payload) },
      payload,
    });
    expect(res.statusCode, res.payload).toBe(202);
  });

  // ══════════════ owner Checkpoint G §G22 — Fastify's default body-size
  // limit must still apply after `installRawBodyCapture` REPLACES the
  // default `application/json` content-type parser. `addContentTypeParser`
  // is never given an explicit `bodyLimit` override in `raw-body.ts`, so it
  // inherits the Fastify INSTANCE's own global limit (Fastify's built-in
  // default, 1 MiB, since neither `main.ts` nor this test's own
  // `FastifyAdapter` construction overrides it) — that enforcement happens
  // in Fastify's core body-reading pipeline BEFORE any content-type parser
  // function ever runs, so replacing the parser cannot have silently lifted
  // it. Verified empirically here, not merely inferred from source. ══════
  it('§G22: an oversized webhook body is rejected (413) — the default body-size limit still applies', async () => {
    // just over Fastify's 1 MiB default `bodyLimit`.
    const oversized = Buffer.alloc(1_048_576 + 1024, 'a');
    const res = await app.inject({
      method: 'POST',
      url: `/v1${webhookUrl(endpointId)}`,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'irrelevant' },
      payload: oversized,
    });
    expect(res.statusCode).toBe(413);
  });

  // ══════════════ owner reliability-pass §9 — raw-body global parser
  // regression: an ORDINARY, non-webhook JSON route is unaffected ═════════
  describe('ordinary JSON route regression (installRawBodyCapture must not alter global JSON semantics)', () => {
    it('a normal parsed JSON body still works end to end on an existing route', async () => {
      const invoiceId = await freshOrdinaryInvoice(100);
      const token = await mintTenant(tenantA, ['payments:collect']);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/companies/${coA}/branches/${branchA}/invoices/${invoiceId}/payments`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `wh-regress-${crypto.randomUUID()}`,
        },
        payload: JSON.stringify({
          amountMinor: '100',
          tenders: [{ method: 'CASH', amountMinor: '100' }],
        }),
      });
      expect(res.statusCode, res.payload).toBe(201);
      const json = res.json() as { amountMinor: string };
      expect(json.amountMinor).toBe('100');
    });

    it('Zod validation still rejects an invalid (but well-formed JSON) body the same as before', async () => {
      const invoiceId = await freshOrdinaryInvoice(100);
      const token = await mintTenant(tenantA, ['payments:collect']);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/companies/${coA}/branches/${branchA}/invoices/${invoiceId}/payments`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `wh-regress-${crypto.randomUUID()}`,
        },
        // ONLINE_GATEWAY is not accepted on this synchronous route.
        payload: JSON.stringify({
          amountMinor: '100',
          tenders: [{ method: 'ONLINE_GATEWAY', amountMinor: '100' }],
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('malformed JSON still fails the same way it always did (400, no crash)', async () => {
      const invoiceId = await freshOrdinaryInvoice(100);
      const token = await mintTenant(tenantA, ['payments:collect']);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/companies/${coA}/branches/${branchA}/invoices/${invoiceId}/payments`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `wh-regress-${crypto.randomUUID()}`,
        },
        payload: '{ this is not valid json ',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
