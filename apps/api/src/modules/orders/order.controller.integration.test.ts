import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { PLATFORM_PERMISSIONS, requiresStepUp } from '@flower/permissions';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator.js';
import { REQUIRED_PERMISSION_KEY } from '../../common/auth/require-permission.decorator.js';
import { NO_STEP_UP_KEY, SCOPED_PARAM_KEY } from '../../common/auth/pipeline.decorators.js';
import { SYSTEM_ROLE_TEMPLATES } from '../platform/system-roles.js';
import { SystemClock, type Clock } from '../../common/clock/clock.js';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped, ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { InvoiceIssuanceRepository } from './invoice-issuance.repository.js';
import { CreditNoteRepository } from './credit-note.repository.js';
import { TaxFinalizationService } from './tax-finalization.service.js';
import { allocateDocumentDiscount } from './document-discount-allocation.js';
import { computeCommercialSnapshotFingerprintByVersion } from './commercial-snapshot.js';
import { RefundAttemptReservationRepository } from '../receivables/refund-attempt-reservation.repository.js';
import { ProviderRefundEventInboxRepository } from '../receivables/provider-refund-event-inbox.repository.js';
import { CustomerReceiptCollectionRepository } from '../receivables/customer-receipt-collection.repository.js';
import { CustomerAdvanceApplicationRepository } from '../receivables/customer-advance-application.repository.js';
import { SettlementFinalizationRepository } from '../settlements/settlement-finalization.repository.js';
import { HistoricalSettlementReconciliationRepository } from '../settlements/historical-settlement-reconciliation.repository.js';
import { PaymentAttemptReservationRepository } from '../payments/payment-attempt-reservation.repository.js';

const PLAN_V = '00000000-0000-7000-8000-0000003b3001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000003b3002';
const CATALOG_PERMS = [
  'catalog:view',
  'catalog:manage',
  'variants:manage',
  'pricing:manage',
  'identifiers:manage',
];
const CUSTOMER_PERMS = ['customers:view', 'customers:manage'];
const ORDER_PERMS = ['orders:view', 'orders:manage', 'orders:cancel'];

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b3000', 'starter-3b3', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b3000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 10);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin-3b3@flower.test', 'Platform Admin', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'x', 'x'), ('KWD', 3, 'KWD', 'x', 'x')
      ON CONFLICT (code) DO NOTHING;
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now())
      ON CONFLICT (code) DO NOTHING;
      INSERT INTO country_tax_config (id, "countryCode", "effectiveFrom", regime, config)
      SELECT uuidv7(), 'AE', '2020-01-01', 'VAT',
             '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM country_tax_config WHERE "countryCode" = 'AE');
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now())
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()), ('CUSTOM','strategy.custom',true,now()),
             ('CUSTOM','variants',true,now()), ('CUSTOM','multi_uom',true,now()),
             ('CUSTOM','branch_pricing',true,now())
      ON CONFLICT ("templateKey","capabilityKey") DO NOTHING;
    `);
  } finally {
    await c.end();
  }
}

/**
 * Task 3b.3 Checkpoint B (Order draft domain, integration) — the WALK_IN
 * create/patch/hold/resume/read/list HTTP surface: server-authoritative
 * snapshot resolution (price/tax/UOM/currency/display/SKU), discount
 * validation, the commercial fingerprint, create idempotency, optimistic
 * concurrency, branch/company/customer scope isolation, and the explicit
 * structural non-scope confirmations (no orderNumber, no Invoice, no
 * PostingEngine).
 */
describe('OrderController (task 3b.3 Checkpoint B, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let superTok = '';
  let tenantA = '';
  let tenantB = '';
  let coA = '';
  let coA2 = ''; // second company, SAME tenant — for cross-company customer test
  let branchA = '';
  let branchB = ''; // second branch, SAME company — for cross-branch scope test
  let posTerminalId = '';
  let ownerA = ''; // full orders + catalog + customer perms, branchScope ALL
  let branchAUser = ''; // full order perms, branchScope=[branchA]
  let branchBUser = ''; // full order perms, branchScope=[branchB]
  let viewOnlyA = ''; // orders:view only
  let posUser = ''; // orders perms, branchScope=[branchA], posTerminalId set
  let tenantBUser = '';
  let variantId = '';
  let variantId2 = '';
  // Checkpoint C's internal (non-HTTP) issuance primitive is deliberately
  // exercised by a few tests in this file directly (never through a public
  // route) — tracked here so the "structural non-scope" gate below can
  // distinguish a legitimate, controlled test issuance from an actual public
  // API leak, rather than assuming zero orderNumber ever (Checkpoint D
  // hard-gate fix — see D14/structural-non-scope).
  const deliberatelyIssuedOrderIds = new Set<string>();
  let customerId = ''; // associated with coA
  let customerOtherCompanyId = ''; // associated with coA2 ONLY
  let coKwd = ''; // KWD (3-decimal exponent) company — commercial gross exactness (§11)
  let branchKwd = '';
  let gramVariantId = ''; // base UOM 'gram' — fractional quantities permitted

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

    superTok = await mintPlatform();
    tenantA = await provision('ord-a', 'AE');
    tenantB = await provision('ord-b', 'AE');

    coA = (await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantA]))[0]!
      .id;
    // task 3b.3 Checkpoint B hardening — tax-reference resolution derives its
    // civil date from Company.accountingTimezone (never UTC/Branch/POS); a
    // company with none configured fails closed, so every fixture company
    // needs one explicitly set (never auto-backfilled by provisioning).
    await sql(`UPDATE company SET "accountingTimezone" = 'Asia/Dubai' WHERE id = $1`, [coA]);
    branchA = (
      await sql<{ id: string }>(`SELECT id FROM branch WHERE "tenantId"=$1`, [tenantA])
    )[0]!.id;
    branchB = (
      await sql<{ id: string }>(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
         VALUES (uuidv7(),$1,$2,'Second Branch',now()) RETURNING id`,
        [tenantA, coA],
      )
    )[0]!.id;
    coA2 = (
      await sql<{ id: string }>(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
         VALUES (uuidv7(),$1,'Company A2','AE','AED','Asia/Dubai',now()) RETURNING id`,
        [tenantA],
      )
    )[0]!.id;
    posTerminalId = (
      await sql<{ id: string }>(
        `INSERT INTO pos_terminal (id,"tenantId","companyId","branchId",code,name,"updatedAt")
         VALUES (uuidv7(),$1,$2,$3,'POS-1','POS 1',now()) RETURNING id`,
        [tenantA, coA, branchA],
      )
    )[0]!.id;

    ownerA = await mintTenant('oa', tenantA, [...ORDER_PERMS, ...CATALOG_PERMS, ...CUSTOMER_PERMS]);
    branchAUser = await mintTenant('bau', tenantA, ORDER_PERMS, { branchScope: [branchA] });
    branchBUser = await mintTenant('bbu', tenantA, ORDER_PERMS, { branchScope: [branchB] });
    viewOnlyA = await mintTenant('vo', tenantA, ['orders:view']);
    posUser = await mintTenant('pu', tenantA, ORDER_PERMS, {
      branchScope: [branchA],
      posTerminalId,
    });
    tenantBUser = await mintTenant('tb', tenantB, ORDER_PERMS);

    variantId = await mkVariant(ownerA, 'rose', { base: 'piece' });
    await companyPrice(coA, variantId, [{ uomCode: 'piece', sell: money('1000', 'AED', 2) }]);
    // second distinct product/variant — Checkpoint C final-hardening (§1),
    // needed only to build genuinely multi-line orders for the linePosition/
    // fingerprint-ordering tests.
    variantId2 = await mkVariant(ownerA, 'lily', { base: 'piece' });
    await companyPrice(coA, variantId2, [{ uomCode: 'piece', sell: money('700', 'AED', 2) }]);

    const custRes = await req(
      'POST',
      `/companies/${coA}/customers`,
      ownerA,
      { displayName: 'Fixture Customer' },
      { 'idempotency-key': 'fixture-customer-1' },
    );
    expect(custRes.statusCode, custRes.payload).toBe(201);
    customerId = (custRes.json() as { id: string }).id;

    const custRes2 = await req(
      'POST',
      `/companies/${coA2}/customers`,
      ownerA,
      { displayName: 'Other Company Customer' },
      { 'idempotency-key': 'fixture-customer-2' },
    );
    expect(custRes2.statusCode, custRes2.payload).toBe(201);
    customerOtherCompanyId = (custRes2.json() as { id: string }).id;

    // KWD (3-decimal exponent) fixture — commercial gross exactness (§11)
    const kwdRow = await sql<{ id: string }>(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
       VALUES (uuidv7(),$1,'KWD Co','AE','KWD','Asia/Dubai',now()) RETURNING id`,
      [tenantA],
    );
    coKwd = kwdRow[0]!.id;
    const kwdBranchRow = await sql<{ id: string }>(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
       VALUES (uuidv7(),$1,$2,'KWD Branch',now()) RETURNING id`,
      [tenantA, coKwd],
    );
    branchKwd = kwdBranchRow[0]!.id;
    gramVariantId = await mkVariant(ownerA, 'gram-item', { base: 'gram' });
    await companyPrice(coA, gramVariantId, [{ uomCode: 'gram', sell: money('333', 'AED', 2) }]);
    await companyPrice(coKwd, gramVariantId, [{ uomCode: 'gram', sell: money('7', 'KWD', 3) }]);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── harness ──────────────────────────────────────────────────────────────
  function baseSess(sessionId: string, realm: 'tenant' | 'platform'): SessionData {
    return {
      sessionId,
      realm,
      familyId: 'f',
      tenantId: null,
      userId: null,
      platformUserId: null,
      accountType: 'USER',
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
  async function mintPlatform(): Promise<string> {
    const s = baseSess('plat', 'platform');
    s.platformUserId = PLATFORM_USER;
    s.accountType = 'PLATFORM';
    s.mfaLevel = 'STEP_UP';
    s.stepUpUntil = Date.now() + 600_000;
    s.access = {
      effectivePermissions: [...PLATFORM_PERMISSIONS],
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: PLATFORM_USER, sid: s.sessionId, aud: 'platform' });
  }
  const userIds = new Map<string, string>();
  let userSeq = 0;
  async function mintTenant(
    id: string,
    forTenant: string,
    perms: string[],
    opts: {
      branchScope?: string[] | 'ALL';
      posTerminalId?: string | null;
      /** task 3b.8 Checkpoint C — a fresh step-up, for the cancellation-charge
       *  financial-document authority's own step-up requirement. */
      stepUp?: boolean;
    } = {},
  ): Promise<string> {
    const s = baseSess(`ten-${id}`, 'tenant');
    s.tenantId = forTenant;
    let uid = userIds.get(id);
    if (uid === undefined) {
      uid = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
      userIds.set(id, uid);
    }
    s.userId = uid;
    s.accountType = 'OWNER';
    s.posTerminalId = opts.posTerminalId ?? null;
    if (opts.stepUp) {
      s.mfaLevel = 'STEP_UP';
      s.stepUpUntil = Date.now() + 600_000;
    }
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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
  const money = (amountMinor: string, currency: string, exponent: number) => ({
    amountMinor,
    currency,
    exponent,
  });
  let idemN = 0;
  const ik = (): string => `ord-key-${String(++idemN).padStart(4, '0')}`;

  async function provision(slug: string, country: string): Promise<string> {
    const res = await req(
      'POST',
      '/platform/tenants',
      superTok,
      {
        slug,
        name: slug,
        region: 'AE',
        companyCountryCode: country,
        businessTypeKey: 'CUSTOM',
        planVersionId: PLAN_V,
        ownerEmail: `owner@${slug}.test`,
      },
      { 'idempotency-key': `prov-${slug}` },
    );
    expect(res.statusCode, res.payload).toBe(201);
    return (res.json() as { tenantId: string }).tenantId;
  }

  async function mkVariant(
    token: string,
    slug: string,
    opts: { base?: string } = {},
  ): Promise<string> {
    const cat = await req(
      'POST',
      '/catalog/categories',
      token,
      { slug: `${slug}-c`, nameEn: slug },
      { 'idempotency-key': ik() },
    );
    expect(cat.statusCode, cat.payload).toBe(201);
    const p = await req(
      'POST',
      '/catalog/products',
      token,
      {
        categoryId: (cat.json() as { id: string }).id,
        nameEn: slug,
        slug: `${slug}-p`,
        fulfilmentStrategy: 'STOCKED',
      },
      { 'idempotency-key': ik() },
    );
    expect(p.statusCode, p.payload).toBe(201);
    const productId = (p.json() as { id: string }).id;
    const vs = (await req('GET', `/catalog/products/${productId}/variants`, token)).json() as {
      id: string;
      version: number;
    }[];
    const vId = vs[0]!.id;
    if (opts.base !== undefined) {
      const v = (await req('GET', `/catalog/variants/${vId}`, token)).json() as { version: number };
      const set = await req(
        'PUT',
        `/catalog/variants/${vId}/base-uom`,
        token,
        { baseUomCode: opts.base },
        { 'if-match': `"${v.version}"` },
      );
      expect(set.statusCode, set.payload).toBe(200);
    }
    const activateP = await req(
      'POST',
      `/catalog/products/${productId}/activate`,
      token,
      undefined,
      {
        'if-match': '"1"',
        'idempotency-key': ik(),
      },
    );
    expect(activateP.statusCode, activateP.payload).toBe(200);
    const vNow = (await req('GET', `/catalog/variants/${vId}`, token)).json() as {
      version: number;
    };
    const activateV = await req('POST', `/catalog/variants/${vId}/activate`, token, undefined, {
      'if-match': `"${vNow.version}"`,
      'idempotency-key': ik(),
    });
    expect(activateV.statusCode, activateV.payload).toBe(200);
    return vId;
  }

  async function companyPrice(companyId: string, vId: string, prices: unknown[]): Promise<void> {
    const g = await req('GET', `/catalog/companies/${companyId}/variants/${vId}/prices`, ownerA);
    const cur = (g.json() as { version: number }).version;
    const p = await req(
      'PUT',
      `/catalog/companies/${companyId}/variants/${vId}/prices`,
      ownerA,
      { prices },
      { 'if-match': `"${cur}"` },
    );
    expect(p.statusCode, p.payload).toBe(200);
  }

  const ORD = (companyId: string, branchId: string, extra = ''): string =>
    `/companies/${companyId}/branches/${branchId}/orders${extra}`;

  function basicLine(overrides: Record<string, unknown> = {}) {
    return {
      productId: overrides['productId'] ?? undefined,
      variantId,
      selectedUomCode: 'piece',
      quantity: '2',
      ...overrides,
    };
  }
  async function productIdFor(vId: string): Promise<string> {
    const v = (await req('GET', `/catalog/variants/${vId}`, ownerA)).json() as {
      productId: string;
    };
    return v.productId;
  }

  // ── CREATE ────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('creates an anonymous WALK_IN draft with server-resolved price/tax/UOM/currency snapshot', async () => {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId })] },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const body = r.json() as { order: Record<string, unknown>; lines: Record<string, unknown>[] };
      expect(body.order['customerId']).toBeNull();
      expect(body.order['status']).toBe('DRAFT');
      expect(body.order['kind']).toBe('WALK_IN');
      expect(body.order['orderNumber']).toBeNull();
      expect(body.order['version']).toBe(1);
      expect(body.order['commercialSnapshotFingerprint']).toEqual(expect.any(String));
      expect(body.order['currencyCode']).toBe('AED');
      expect(body.order['currencyExponent']).toBe(2);
      expect(body.order['originBranchId']).toBe(branchA);
      expect(body.order['fulfillingBranchId']).toBe(branchA); // WALK_IN: fulfilling = origin
      expect(body.order['posTerminalId']).toBeNull(); // no POS session context
      const line = body.lines[0]!;
      expect(line['unitPriceAmountMinor']).toBe('1000');
      expect(line['unitPriceCurrencyCode']).toBe('AED');
      expect(line['quantity']).toBe('2.0000');
      expect(line['baseUomCode']).toBe('piece');
      expect(line['conversionNumerator']).toBe('1'); // piece == piece, exact identity ratio
      expect(line['conversionDenominator']).toBe('1');
      expect(line['priceTaxMode']).toBeNull(); // reserved for 3b.4
      expect(line['lineTaxAmountMinor']).toBeNull();
      expect(line['productNameEnSnapshot']).toBeTruthy();
      expect(line['variantNameEnSnapshot']).toBeTruthy();
    });

    it('creates an identified WALK_IN draft when the customer is associated with the target company', async () => {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { customerId, lines: [basicLine({ productId })] },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      expect((r.json() as { order: { customerId: string } }).order.customerId).toBe(customerId);
    });

    it('rejects a Company-A2-only customer attached to a Company-A order (non-disclosing)', async () => {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { customerId: customerOtherCompanyId, lines: [basicLine({ productId })] },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(404);
      expect(errCode(r)).toBe('ORDER_CUSTOMER_NOT_AVAILABLE');
    });

    it('POS terminal id is derived from the trusted session, never forgeable via the request body', async () => {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        posUser,
        // an attempted posTerminalId in the body is rejected outright by .strict()
        {
          lines: [basicLine({ productId })],
          posTerminalId: '00000000-0000-7000-8000-000000000099',
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(400);
      expect(errCode(r)).toBe('VALIDATION_FAILED');

      const ok = await req(
        'POST',
        ORD(coA, branchA),
        posUser,
        { lines: [basicLine({ productId })] },
        { 'idempotency-key': ik() },
      );
      expect(ok.statusCode, ok.payload).toBe(201);
      expect((ok.json() as { order: { posTerminalId: string } }).order.posTerminalId).toBe(
        posTerminalId,
      );
    });

    it('rejects zero/negative quantity and accepts fractional exactness', async () => {
      const productId = await productIdFor(variantId);
      const zero = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '0' })] },
        { 'idempotency-key': ik() },
      );
      expect(zero.statusCode, zero.payload).toBe(422);
      expect(errCode(zero)).toBe('ORDER_LINE_QUANTITY_INVALID');

      const cmVariant = await mkVariant(ownerA, 'ribbon', { base: 'centimeter' });
      await companyPrice(coA, cmVariant, [{ uomCode: 'centimeter', sell: money('10', 'AED', 2) }]);
      const fractional = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: await productIdFor(cmVariant),
              variantId: cmVariant,
              selectedUomCode: 'centimeter',
              quantity: '12.5',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(fractional.statusCode, fractional.payload).toBe(201);
      const line = (fractional.json() as { lines: { quantity: string }[] }).lines[0]!;
      expect(line.quantity).toBe('12.5000');
    });

    it('line discount: NONE/AMOUNT/PERCENT_BPS resolve exactly, and an over-discount is rejected', async () => {
      const productId = await productIdFor(variantId);
      const amt = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({
              productId,
              quantity: '1',
              discountMode: 'AMOUNT',
              discountAmountMinor: '200',
            }),
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(amt.statusCode, amt.payload).toBe(201);
      expect(
        (amt.json() as { lines: { discountAmountMinor: string }[] }).lines[0]!.discountAmountMinor,
      ).toBe('200');

      const pct = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({ productId, quantity: '1', discountMode: 'PERCENT_BPS', discountBps: 1000 }),
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(pct.statusCode, pct.payload).toBe(201);
      // 1000 minor * 10% = 100
      expect(
        (pct.json() as { lines: { discountAmountMinor: string }[] }).lines[0]!.discountAmountMinor,
      ).toBe('100');

      const over = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({
              productId,
              quantity: '1',
              discountMode: 'AMOUNT',
              discountAmountMinor: '999999',
            }),
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(over.statusCode, over.payload).toBe(422);
      expect(errCode(over)).toBe('ORDER_LINE_DISCOUNT_EXCEEDS_GROSS');
    });

    it('document discount resolves exactly against the post-line-discount gross, and an over-discount is rejected', async () => {
      const productId = await productIdFor(variantId);
      const ok = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [basicLine({ productId, quantity: '2' })], // gross 2000
          documentDiscountMode: 'PERCENT_BPS',
          documentDiscountBps: 500, // 5% of 2000 = 100
        },
        { 'idempotency-key': ik() },
      );
      expect(ok.statusCode, ok.payload).toBe(201);
      expect(
        (ok.json() as { order: { documentDiscountAmountMinor: string } }).order
          .documentDiscountAmountMinor,
      ).toBe('100');

      const over = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [basicLine({ productId, quantity: '1' })], // gross 1000
          documentDiscountMode: 'AMOUNT',
          documentDiscountAmountMinor: '5000',
        },
        { 'idempotency-key': ik() },
      );
      expect(over.statusCode, over.payload).toBe(422);
      expect(errCode(over)).toBe('ORDER_DOCUMENT_DISCOUNT_EXCEEDS_GROSS');
    });

    it('rejects an unknown/archived-shaped variant with a structural 422, never a raw 500', async () => {
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: '00000000-0000-7000-8000-000000000001',
              variantId: '00000000-0000-7000-8000-000000000002',
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(422);
      expect(errCode(r)).toBe('ORDER_LINE_VARIANT_NOT_FOUND');
    });

    it('atomicity: one invalid line rolls back the whole create — no partial Order/OrderLine', async () => {
      const productId = await productIdFor(variantId);
      const before = await sql<{ count: string }>(
        `SELECT count(*)::text FROM "order" WHERE "tenantId" = $1`,
        [tenantA],
      );
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({ productId }),
            {
              productId: '00000000-0000-7000-8000-000000000001',
              variantId: '00000000-0000-7000-8000-000000000002',
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(422);
      const after = await sql<{ count: string }>(
        `SELECT count(*)::text FROM "order" WHERE "tenantId" = $1`,
        [tenantA],
      );
      expect(after[0]!.count).toBe(before[0]!.count);
    });

    it('confirms zero Invoice rows exist after any create in this suite', async () => {
      const rows = await sql<{ count: string }>(`SELECT count(*)::text FROM "invoice"`);
      expect(rows[0]!.count).toBe('0');
    });
  });

  // ── UOM RATIO SNAPSHOT (Checkpoint B hardening §9) ────────────────────────
  describe('UOM ratio snapshot', () => {
    it('I. a later UomConversion edit does not mutate a previously stored OrderLine ratio, and a fresh line picks up the new ratio', async () => {
      const uomRes = await req(
        'POST',
        '/catalog/uoms',
        ownerA,
        { code: 'crate3b3', family: 'EACH', nameEn: 'Crate', maxDecimals: 0 },
        { 'idempotency-key': ik() },
      );
      expect(uomRes.statusCode, uomRes.payload).toBe(201);
      const crateVariantId = await mkVariant(ownerA, 'crate-item', { base: 'piece' });
      const v0 = (await req('GET', `/catalog/variants/${crateVariantId}`, ownerA)).json() as {
        version: number;
      };
      const setConv1 = await req(
        'PUT',
        `/catalog/variants/${crateVariantId}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'crate3b3', num: '10' }] },
        { 'if-match': `"${v0.version}"` },
      );
      expect(setConv1.statusCode, setConv1.payload).toBe(200);
      await companyPrice(coA, crateVariantId, [
        { uomCode: 'crate3b3', sell: money('5000', 'AED', 2) },
      ]);

      const crateProductId = await productIdFor(crateVariantId);
      const firstOrder = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: crateProductId,
              variantId: crateVariantId,
              selectedUomCode: 'crate3b3',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(firstOrder.statusCode, firstOrder.payload).toBe(201);
      const firstBody = firstOrder.json() as {
        order: { id: string };
        lines: { conversionNumerator: string; conversionDenominator: string }[];
      };
      expect(firstBody.lines[0]!.conversionNumerator).toBe('10');
      expect(firstBody.lines[0]!.conversionDenominator).toBe('1');

      // edit the conversion ratio
      const v1 = (await req('GET', `/catalog/variants/${crateVariantId}`, ownerA)).json() as {
        version: number;
      };
      const setConv2 = await req(
        'PUT',
        `/catalog/variants/${crateVariantId}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'crate3b3', num: '20' }] },
        { 'if-match': `"${v1.version}"` },
      );
      expect(setConv2.statusCode, setConv2.payload).toBe(200);

      // the ALREADY-CREATED line's stored ratio must be untouched
      const reread = await req('GET', ORD(coA, branchA, `/${firstBody.order.id}`), ownerA);
      expect(reread.statusCode, reread.payload).toBe(200);
      const rereadBody = reread.json() as {
        lines: { conversionNumerator: string; conversionDenominator: string }[];
      };
      expect(rereadBody.lines[0]!.conversionNumerator).toBe('10');
      expect(rereadBody.lines[0]!.conversionDenominator).toBe('1');

      // a FRESH line resolves the NEW ratio
      const secondOrder = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: crateProductId,
              variantId: crateVariantId,
              selectedUomCode: 'crate3b3',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(secondOrder.statusCode, secondOrder.payload).toBe(201);
      const secondBody = secondOrder.json() as {
        lines: { conversionNumerator: string; conversionDenominator: string }[];
      };
      expect(secondBody.lines[0]!.conversionNumerator).toBe('20');
      expect(secondBody.lines[0]!.conversionDenominator).toBe('1');
    });
  });

  // ── D6 (Checkpoint D hard-gate) — historical snapshot independence: a
  //    legitimate LATER Catalog change (name, price) never mutates an
  //    already-created OrderLine's snapshot. Mirrors the existing "UOM ratio
  //    snapshot" test's proof pattern (§9) for a DIFFERENT set of fields. ──
  describe('historical snapshot independence (Checkpoint D hard-gate §D6)', () => {
    it('a later Product/Variant rename and a later branch price change do not mutate an already-created OrderLine snapshot', async () => {
      const snapVariantId = await mkVariant(ownerA, 'snap-item', { base: 'piece' });
      await companyPrice(coA, snapVariantId, [{ uomCode: 'piece', sell: money('900', 'AED', 2) }]);
      const snapProductId = await productIdFor(snapVariantId);

      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: snapProductId,
              variantId: snapVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(created.statusCode, created.payload).toBe(201);
      const body = created.json() as {
        order: { id: string };
        lines: {
          productNameEnSnapshot: string;
          variantNameEnSnapshot: string;
          unitPriceAmountMinor: string;
        }[];
      };
      const originalProductName = body.lines[0]!.productNameEnSnapshot;
      const originalVariantName = body.lines[0]!.variantNameEnSnapshot;
      expect(body.lines[0]!.unitPriceAmountMinor).toBe('900');

      // legitimate later changes the frozen architecture permits.
      await sql(`UPDATE product SET "nameEn"='Renamed Product' WHERE id=$1`, [snapProductId]);
      await sql(`UPDATE variant SET "nameEn"='Renamed Variant' WHERE id=$1`, [snapVariantId]);
      await companyPrice(coA, snapVariantId, [{ uomCode: 'piece', sell: money('1500', 'AED', 2) }]);

      const reread = await req('GET', ORD(coA, branchA, `/${body.order.id}`), ownerA);
      expect(reread.statusCode, reread.payload).toBe(200);
      const rereadBody = reread.json() as {
        lines: {
          productNameEnSnapshot: string;
          variantNameEnSnapshot: string;
          unitPriceAmountMinor: string;
        }[];
      };
      expect(rereadBody.lines[0]!.productNameEnSnapshot).toBe(originalProductName);
      expect(rereadBody.lines[0]!.variantNameEnSnapshot).toBe(originalVariantName);
      expect(rereadBody.lines[0]!.unitPriceAmountMinor).toBe('900'); // NOT the new 1500

      // a FRESH line on a FRESH order picks up the NEW live values.
      const fresh = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: snapProductId,
              variantId: snapVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(fresh.statusCode, fresh.payload).toBe(201);
      const freshBody = fresh.json() as {
        lines: { productNameEnSnapshot: string; unitPriceAmountMinor: string }[];
      };
      expect(freshBody.lines[0]!.productNameEnSnapshot).toBe('Renamed Product');
      expect(freshBody.lines[0]!.unitPriceAmountMinor).toBe('1500');
    });

    it('a later SKU replacement (deactivate old + activate new) does not mutate an already-created OrderLine skuSnapshot', async () => {
      const skuVariantId = await mkVariant(ownerA, 'sku-snap-item', { base: 'piece' });
      await companyPrice(coA, skuVariantId, [{ uomCode: 'piece', sell: money('250', 'AED', 2) }]);
      const skuProductId = await productIdFor(skuVariantId);

      const sku1 = await req(
        'POST',
        '/catalog/identifiers',
        ownerA,
        { targetKind: 'VARIANT', targetId: skuVariantId, codeType: 'SKU', value: 'SKU-ORIG-3B3' },
        { 'idempotency-key': ik() },
      );
      expect(sku1.statusCode, sku1.payload).toBe(201);
      const sku1Id = (sku1.json() as { id: string }).id;

      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: skuProductId,
              variantId: skuVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(created.statusCode, created.payload).toBe(201);
      const body = created.json() as {
        order: { id: string };
        lines: { skuSnapshot: string | null }[];
      };
      expect(body.lines[0]!.skuSnapshot).toBe('SKU-ORIG-3B3');

      // legitimate later SKU lifecycle change: deactivate the old ACTIVE SKU,
      // then activate a new one (the "one ACTIVE SKU per variant" rule
      // permits this two-step replacement, never a direct in-place edit).
      const del = await req('DELETE', `/catalog/identifiers/${sku1Id}`, ownerA);
      expect(del.statusCode, del.payload).toBe(200);
      const sku2 = await req(
        'POST',
        '/catalog/identifiers',
        ownerA,
        { targetKind: 'VARIANT', targetId: skuVariantId, codeType: 'SKU', value: 'SKU-NEW-3B3' },
        { 'idempotency-key': ik() },
      );
      expect(sku2.statusCode, sku2.payload).toBe(201);

      const reread = await req('GET', ORD(coA, branchA, `/${body.order.id}`), ownerA);
      const rereadBody = reread.json() as { lines: { skuSnapshot: string | null }[] };
      expect(rereadBody.lines[0]!.skuSnapshot).toBe('SKU-ORIG-3B3'); // unchanged

      const fresh = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: skuProductId,
              variantId: skuVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(fresh.statusCode, fresh.payload).toBe(201);
      const freshBody = fresh.json() as { lines: { skuSnapshot: string | null }[] };
      expect(freshBody.lines[0]!.skuSnapshot).toBe('SKU-NEW-3B3'); // picks up the new live SKU
    });

    it('a later custom-UOM display-label rename does not mutate an already-created OrderLine uomDisplayLabelSnapshot', async () => {
      const uomRes = await req(
        'POST',
        '/catalog/uoms',
        ownerA,
        { code: 'labelunit3b3', family: 'EACH', nameEn: 'Original Label', maxDecimals: 0 },
        { 'idempotency-key': ik() },
      );
      expect(uomRes.statusCode, uomRes.payload).toBe(201);
      const uomVersion = (uomRes.json() as { version: number }).version;
      const labelVariantId = await mkVariant(ownerA, 'label-snap-item', { base: 'piece' });
      const v0 = (await req('GET', `/catalog/variants/${labelVariantId}`, ownerA)).json() as {
        version: number;
      };
      const setConv = await req(
        'PUT',
        `/catalog/variants/${labelVariantId}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'labelunit3b3', num: '1' }] },
        { 'if-match': `"${v0.version}"` },
      );
      expect(setConv.statusCode, setConv.payload).toBe(200);
      await companyPrice(coA, labelVariantId, [
        { uomCode: 'labelunit3b3', sell: money('600', 'AED', 2) },
      ]);
      const labelProductId = await productIdFor(labelVariantId);

      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: labelProductId,
              variantId: labelVariantId,
              selectedUomCode: 'labelunit3b3',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(created.statusCode, created.payload).toBe(201);
      const body = created.json() as {
        order: { id: string };
        lines: { uomDisplayLabelSnapshot: string }[];
      };
      expect(body.lines[0]!.uomDisplayLabelSnapshot).toBe('Original Label');

      // legitimate later rename — UOM semantic fields (code/family) are
      // immutable, but the display name is explicitly editable via PUT.
      const rename = await req(
        'PUT',
        `/catalog/uoms/labelunit3b3`,
        ownerA,
        { nameEn: 'Renamed Label' },
        { 'if-match': `"${uomVersion}"` },
      );
      expect(rename.statusCode, rename.payload).toBe(200);

      const reread = await req('GET', ORD(coA, branchA, `/${body.order.id}`), ownerA);
      const rereadBody = reread.json() as { lines: { uomDisplayLabelSnapshot: string }[] };
      expect(rereadBody.lines[0]!.uomDisplayLabelSnapshot).toBe('Original Label'); // unchanged

      const fresh = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: labelProductId,
              variantId: labelVariantId,
              selectedUomCode: 'labelunit3b3',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(fresh.statusCode, fresh.payload).toBe(201);
      const freshBody = fresh.json() as { lines: { uomDisplayLabelSnapshot: string }[] };
      expect(freshBody.lines[0]!.uomDisplayLabelSnapshot).toBe('Renamed Label'); // picks up new live label
    });

    it('a later tax-category (re)assignment does not mutate an already-created OrderLine tax-reference snapshot', async () => {
      await sql(
        `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STD3B3','Standard 3b3','x'),('ZERO3B3','Zero 3b3','x') ON CONFLICT (key) DO NOTHING`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom") VALUES ('AE','STD3B3',500,'2020-01-01') ON CONFLICT DO NOTHING`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom") VALUES ('AE','ZERO3B3',0,'2020-01-01') ON CONFLICT DO NOTHING`,
      );

      const taxVariantId = await mkVariant(ownerA, 'tax-snap-item', { base: 'piece' });
      await companyPrice(coA, taxVariantId, [{ uomCode: 'piece', sell: money('400', 'AED', 2) }]);
      const taxProductId = await productIdFor(taxVariantId);
      const vRow = (await req('GET', `/catalog/variants/${taxVariantId}`, ownerA)).json() as {
        version: number;
      };
      const assign1 = await req(
        'PUT',
        `/catalog/variants/${taxVariantId}/tax-category`,
        ownerA,
        { taxCategoryKey: 'STD3B3' },
        { 'if-match': `"${vRow.version}"` },
      );
      expect(assign1.statusCode, assign1.payload).toBe(200);

      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: taxProductId,
              variantId: taxVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(created.statusCode, created.payload).toBe(201);
      const body = created.json() as {
        order: { id: string };
        lines: { taxCategoryKey: string | null; rateBps: number | null }[];
      };
      expect(body.lines[0]!.taxCategoryKey).toBe('STD3B3');
      expect(body.lines[0]!.rateBps).toBe(500);

      // legitimate later change: reassign the variant's tax category.
      const v2 = (await req('GET', `/catalog/variants/${taxVariantId}`, ownerA)).json() as {
        version: number;
      };
      const assign2 = await req(
        'PUT',
        `/catalog/variants/${taxVariantId}/tax-category`,
        ownerA,
        { taxCategoryKey: 'ZERO3B3' },
        { 'if-match': `"${v2.version}"` },
      );
      expect(assign2.statusCode, assign2.payload).toBe(200);

      const reread = await req('GET', ORD(coA, branchA, `/${body.order.id}`), ownerA);
      const rereadBody = reread.json() as {
        lines: { taxCategoryKey: string | null; rateBps: number | null }[];
      };
      expect(rereadBody.lines[0]!.taxCategoryKey).toBe('STD3B3'); // unchanged
      expect(rereadBody.lines[0]!.rateBps).toBe(500);

      const fresh = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: taxProductId,
              variantId: taxVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(fresh.statusCode, fresh.payload).toBe(201);
      const freshBody = fresh.json() as {
        lines: { taxCategoryKey: string | null; rateBps: number | null }[];
      };
      expect(freshBody.lines[0]!.taxCategoryKey).toBe('ZERO3B3'); // picks up new live assignment
      expect(freshBody.lines[0]!.rateBps).toBe(0);
    });
  });

  // ── SALE-TIME UOM EXACTNESS (Checkpoint C final-integrity pass §1) ────────
  // Frozen Phase 3.6 contract: `convertExact`-as-a-quantity-gate belongs only
  // to pack identity (`item_identifier.packBaseQty`), never to a normal
  // Order-line sale — Task 3b.3 stores the exact rational
  // conversionNumerator/conversionDenominator snapshot but never derives or
  // stores a base-equivalent quantity, so there is nothing for a sale-time
  // exact-conversion gate to protect.
  describe('sale-time UOM exactness (Checkpoint C final-integrity pass §1)', () => {
    let thirdVariantId = '';
    let thirdProductId = '';

    beforeAll(async () => {
      const uomRes = await req(
        'POST',
        '/catalog/uoms',
        ownerA,
        { code: 'third3b3', family: 'EACH', nameEn: 'Third', maxDecimals: 0 },
        { 'idempotency-key': ik() },
      );
      expect(uomRes.statusCode, uomRes.payload).toBe(201);
      thirdVariantId = await mkVariant(ownerA, 'third-item', { base: 'piece' });
      const v0 = (await req('GET', `/catalog/variants/${thirdVariantId}`, ownerA)).json() as {
        version: number;
      };
      const setConv = await req(
        'PUT',
        `/catalog/variants/${thirdVariantId}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'third3b3', num: '1', den: '3' }] },
        { 'if-match': `"${v0.version}"` },
      );
      expect(setConv.statusCode, setConv.payload).toBe(200);
      await companyPrice(coA, thirdVariantId, [
        { uomCode: 'third3b3', sell: money('300', 'AED', 2) },
      ]);
      thirdProductId = await productIdFor(thirdVariantId);
    });

    it('A/B. quantity=1 in a UOM with a 1/3 ratio to base is accepted, and the exact rational snapshot (1/3) is stored', async () => {
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: thirdProductId,
              variantId: thirdVariantId,
              selectedUomCode: 'third3b3',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const body = r.json() as {
        lines: { conversionNumerator: string; conversionDenominator: string }[];
      };
      expect(body.lines[0]!.conversionNumerator).toBe('1');
      expect(body.lines[0]!.conversionDenominator).toBe('3');
    });

    it('C. a quantity violating the selected UOM maxDecimals/discrete rule is still rejected', async () => {
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: thirdProductId,
              variantId: thirdVariantId,
              selectedUomCode: 'third3b3',
              quantity: '1.5',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(422);
      expect(errCode(r)).toBe('ORDER_LINE_QUANTITY_INVALID');
    });

    it('D. an unresolvable selected->base UOM is still rejected', async () => {
      // a REGISTERED UOM (passes assertPermitted's own quantity/shape check)
      // from a different family than the variant's base ('piece', EACH) —
      // never linked via a conversion — so effectiveRatio itself must fail.
      const uomRes = await req(
        'POST',
        '/catalog/uoms',
        ownerA,
        { code: 'unlinked3b3', family: 'MASS', nameEn: 'Unlinked', maxDecimals: 4 },
        { 'idempotency-key': ik() },
      );
      expect(uomRes.statusCode, uomRes.payload).toBe(201);
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, selectedUomCode: 'unlinked3b3' })] },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(422);
      expect(errCode(r)).toBe('ORDER_LINE_UOM_INVALID');
    });

    it('F. ratio 12/1 and identity 1/1 continue to work unchanged', async () => {
      const productId = await productIdFor(variantId);
      const identity = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '2' })] },
        { 'idempotency-key': ik() },
      );
      expect(identity.statusCode, identity.payload).toBe(201);
      const identityBody = identity.json() as {
        lines: { conversionNumerator: string; conversionDenominator: string }[];
      };
      expect(identityBody.lines[0]!.conversionNumerator).toBe('1');
      expect(identityBody.lines[0]!.conversionDenominator).toBe('1');

      const uomRes = await req(
        'POST',
        '/catalog/uoms',
        ownerA,
        { code: 'dozen3b3', family: 'EACH', nameEn: 'Dozen', maxDecimals: 0 },
        { 'idempotency-key': ik() },
      );
      expect(uomRes.statusCode, uomRes.payload).toBe(201);
      const dozenVariantId = await mkVariant(ownerA, 'dozen-item', { base: 'piece' });
      const v0 = (await req('GET', `/catalog/variants/${dozenVariantId}`, ownerA)).json() as {
        version: number;
      };
      const setConv = await req(
        'PUT',
        `/catalog/variants/${dozenVariantId}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'dozen3b3', num: '12' }] },
        { 'if-match': `"${v0.version}"` },
      );
      expect(setConv.statusCode, setConv.payload).toBe(200);
      await companyPrice(coA, dozenVariantId, [
        { uomCode: 'dozen3b3', sell: money('12000', 'AED', 2) },
      ]);
      const dozenProductId = await productIdFor(dozenVariantId);
      const dozenOrder = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: dozenProductId,
              variantId: dozenVariantId,
              selectedUomCode: 'dozen3b3',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(dozenOrder.statusCode, dozenOrder.payload).toBe(201);
      const dozenBody = dozenOrder.json() as {
        lines: { conversionNumerator: string; conversionDenominator: string }[];
      };
      expect(dozenBody.lines[0]!.conversionNumerator).toBe('12');
      expect(dozenBody.lines[0]!.conversionDenominator).toBe('1');
    });
  });

  // ── COMMERCIAL GROSS EXACTNESS (Checkpoint B hardening §11) ───────────────
  // Formula: `Money.ofMinor(unitPriceAmountMinor, currency).mulRatio(quantity.scaled, 10_000n)`
  // — exact BigInt arithmetic (`unitPriceAmountMinor × quantity.scaled`) divided
  // by the fixed `@flower/uom` scale (10 000), rounded ONLY on that final
  // division, HALF_UP (`Money.mulRatio`'s documented default — the same
  // generic default used everywhere else in this codebase; NOT a sale-tax
  // rounding policy, which remains 3b.4's). A `PERCENT_BPS` discount at
  // `10000` bps equals the resolved gross EXACTLY (no further rounding, since
  // `gross × 10000 / 10000` is always exact) — used here as an observable
  // window onto the internal gross value the API does not otherwise expose
  // directly.
  describe('commercial gross exactness', () => {
    it('AED (2-decimal): unitPrice=333 minor × quantity=0.5 gram rounds HALF_UP to 167 minor gross', async () => {
      const gramProductId = await productIdFor(gramVariantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: gramProductId,
              variantId: gramVariantId,
              selectedUomCode: 'gram',
              quantity: '0.5',
              discountMode: 'PERCENT_BPS',
              discountBps: 10000,
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const line = (r.json() as { lines: { discountAmountMinor: string }[] }).lines[0]!;
      // 333 * 0.5 = 166.5 -> HALF_UP -> 167
      expect(line.discountAmountMinor).toBe('167');
    });

    it('KWD (3-decimal): unitPrice=7 minor × quantity=0.5 gram rounds HALF_UP to 4 minor gross', async () => {
      const gramProductId = await productIdFor(gramVariantId);
      const r = await req(
        'POST',
        ORD(coKwd, branchKwd),
        ownerA,
        {
          lines: [
            {
              productId: gramProductId,
              variantId: gramVariantId,
              selectedUomCode: 'gram',
              quantity: '0.5',
              discountMode: 'PERCENT_BPS',
              discountBps: 10000,
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const line = (r.json() as { lines: { discountAmountMinor: string }[] }).lines[0]!;
      // 7 * 0.5 = 3.5 -> HALF_UP -> 4
      expect(line.discountAmountMinor).toBe('4');
    });

    it('an AMOUNT discount exactly equal to the resolved gross is accepted; one minor unit over is rejected', async () => {
      const gramProductId = await productIdFor(gramVariantId);
      const exact = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: gramProductId,
              variantId: gramVariantId,
              selectedUomCode: 'gram',
              quantity: '0.5',
              discountMode: 'AMOUNT',
              discountAmountMinor: '167', // == the exact gross from the AED test above
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(exact.statusCode, exact.payload).toBe(201);
      expect(
        (exact.json() as { lines: { discountAmountMinor: string }[] }).lines[0]!
          .discountAmountMinor,
      ).toBe('167');

      const overByOne = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: gramProductId,
              variantId: gramVariantId,
              selectedUomCode: 'gram',
              quantity: '0.5',
              discountMode: 'AMOUNT',
              discountAmountMinor: '168', // gross + 1 minor unit
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(overByOne.statusCode, overByOne.payload).toBe(422);
      expect(errCode(overByOne)).toBe('ORDER_LINE_DISCOUNT_EXCEEDS_GROSS');
    });
  });

  // ── IDEMPOTENCY ───────────────────────────────────────────────────────────
  describe('create idempotency', () => {
    it('same key + same canonical intent -> the same Order replayed, no duplicate rows', async () => {
      const productId = await productIdFor(variantId);
      const key = ik();
      const body = { lines: [basicLine({ productId, quantity: '3' })] };
      const r1 = await req('POST', ORD(coA, branchA), ownerA, body, { 'idempotency-key': key });
      const r2 = await req('POST', ORD(coA, branchA), ownerA, body, { 'idempotency-key': key });
      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);
      expect((r1.json() as { order: { id: string } }).order.id).toBe(
        (r2.json() as { order: { id: string } }).order.id,
      );
    });

    it('same key + equivalent-but-differently-formatted quantity -> the same replayed Order', async () => {
      const productId = await productIdFor(variantId);
      const key = ik();
      const r1 = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '4' })] },
        { 'idempotency-key': key },
      );
      const r2 = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '4.00' })] },
        { 'idempotency-key': key },
      );
      expect(r1.statusCode, r1.payload).toBe(201);
      expect(r2.statusCode, r2.payload).toBe(201);
      expect((r1.json() as { order: { id: string } }).order.id).toBe(
        (r2.json() as { order: { id: string } }).order.id,
      );
    });

    it('same key + changed commercial semantics -> deterministic conflict', async () => {
      const productId = await productIdFor(variantId);
      const key = ik();
      const r1 = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': key },
      );
      expect(r1.statusCode, r1.payload).toBe(201);
      const r2 = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '2' })] },
        { 'idempotency-key': key },
      );
      expect(r2.statusCode).toBe(409);
    });

    it('different keys + identical commercial content -> distinct Orders', async () => {
      const productId = await productIdFor(variantId);
      const body = { lines: [basicLine({ productId, quantity: '1' })] };
      const r1 = await req('POST', ORD(coA, branchA), ownerA, body, { 'idempotency-key': ik() });
      const r2 = await req('POST', ORD(coA, branchA), ownerA, body, { 'idempotency-key': ik() });
      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);
      expect((r1.json() as { order: { id: string } }).order.id).not.toBe(
        (r2.json() as { order: { id: string } }).order.id,
      );
    });

    it('the SAME Idempotency-Key + SAME body across two different authorized Branches never cross-replays a Branch-A Order into Branch B (§10 hardening)', async () => {
      const productId = await productIdFor(variantId);
      const key = ik();
      const body = { lines: [basicLine({ productId, quantity: '1' })] };
      const rA = await req('POST', ORD(coA, branchA), ownerA, body, { 'idempotency-key': key });
      expect(rA.statusCode, rA.payload).toBe(201);
      const rB = await req('POST', ORD(coA, branchB), ownerA, body, { 'idempotency-key': key });
      // safe outcomes only: never Branch A's Order id returned under Branch B's route.
      if (rB.statusCode === 201) {
        expect((rB.json() as { order: { id: string; originBranchId: string } }).order.id).not.toBe(
          (rA.json() as { order: { id: string } }).order.id,
        );
        expect((rB.json() as { order: { originBranchId: string } }).order.originBranchId).toBe(
          branchB,
        );
      } else {
        expect(rB.statusCode).toBe(409);
        expect(errCode(rB)).toBe('IDEMPOTENCY_KEY_REUSED');
      }
    });

    it('the SAME Idempotency-Key + SAME body across two different Companies never cross-replays across Companies (§10 hardening)', async () => {
      const productId = await productIdFor(variantId);
      const key = ik();
      const body = { lines: [basicLine({ productId, quantity: '1' })] };
      const r1 = await req('POST', ORD(coA, branchA), ownerA, body, { 'idempotency-key': key });
      expect(r1.statusCode, r1.payload).toBe(201);
      // coA2 has no branch/product of its own reachable here — a structurally
      // fake but well-formed branch id under coA2 is enough to prove no
      // cross-company replay occurs (a genuine 404/422 is an equally safe
      // outcome to a 409 key-reuse conflict; a 200/201 returning r1's id is not).
      const fakeBranch = '00000000-0000-7000-8000-0000000000aa';
      const r2 = await req('POST', ORD(coA2, fakeBranch), ownerA, body, {
        'idempotency-key': key,
      });
      if (r2.statusCode === 201) {
        expect((r2.json() as { order: { id: string } }).order.id).not.toBe(
          (r1.json() as { order: { id: string } }).order.id,
        );
      } else {
        expect([404, 409, 422]).toContain(r2.statusCode);
      }
    });
  });

  // ── PATCH ─────────────────────────────────────────────────────────────────
  describe('patch (DRAFT only)', () => {
    async function createDraft(): Promise<{ id: string; version: number; fingerprint: string }> {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const b = r.json() as {
        order: { id: string; version: number; commercialSnapshotFingerprint: string };
      };
      return {
        id: b.order.id,
        version: b.order.version,
        fingerprint: b.order.commercialSnapshotFingerprint,
      };
    }

    it('If-Match is required, and a stale version is rejected', async () => {
      const d = await createDraft();
      const noMatch = await req('PATCH', ORD(coA, branchA, `/${d.id}`), ownerA, { customerId });
      expect(noMatch.statusCode).toBe(428);

      const stale = await req(
        'PATCH',
        ORD(coA, branchA, `/${d.id}`),
        ownerA,
        { customerId },
        { 'if-match': String(d.version + 5) },
      );
      expect(stale.statusCode).toBe(409);
      expect(errCode(stale)).toBe('ORDER_VERSION_CONFLICT');
    });

    it('an empty PATCH body is rejected rather than silently bumping the version', async () => {
      const d = await createDraft();
      const empty = await req(
        'PATCH',
        ORD(coA, branchA, `/${d.id}`),
        ownerA,
        {},
        { 'if-match': String(d.version) },
      );
      expect(empty.statusCode, empty.payload).toBe(400);
      expect(errCode(empty)).toBe('ORDER_PATCH_EMPTY');
    });

    it('a DRAFT edit succeeds, increments version exactly once, and changes the fingerprint when commercial semantics change', async () => {
      const productId = await productIdFor(variantId);
      const d = await createDraft();
      const r = await req(
        'PATCH',
        ORD(coA, branchA, `/${d.id}`),
        ownerA,
        { lines: [basicLine({ productId, quantity: '9' })] },
        { 'if-match': String(d.version) },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const b = r.json() as { order: { version: number; commercialSnapshotFingerprint: string } };
      expect(b.order.version).toBe(d.version + 1);
      expect(b.order.commercialSnapshotFingerprint).not.toBe(d.fingerprint);
    });

    it('re-resolves price/UOM/tax/display snapshots for a changed line — never preserves a stale snapshot', async () => {
      const productId = await productIdFor(variantId);
      const d = await createDraft();
      // reprice the variant, then PATCH the line quantity — the new line must
      // reflect the CURRENT price, not whatever was resolved at create time.
      await companyPrice(coA, variantId, [{ uomCode: 'piece', sell: money('1500', 'AED', 2) }]);
      const r = await req(
        'PATCH',
        ORD(coA, branchA, `/${d.id}`),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'if-match': String(d.version) },
      );
      expect(r.statusCode, r.payload).toBe(200);
      const b = r.json() as { lines: { unitPriceAmountMinor: string }[] };
      expect(b.lines[0]!.unitPriceAmountMinor).toBe('1500');
      await companyPrice(coA, variantId, [{ uomCode: 'piece', sell: money('1000', 'AED', 2) }]); // restore
    });

    it('a HELD order cannot be PATCHed — must resume to DRAFT first', async () => {
      const d = await createDraft();
      const held = await req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
        'if-match': String(d.version),
      });
      expect(held.statusCode, held.payload).toBe(200);
      const r = await req(
        'PATCH',
        ORD(coA, branchA, `/${d.id}`),
        ownerA,
        { customerId },
        { 'if-match': String(d.version + 1) },
      );
      expect(r.statusCode).toBe(409);
      expect(errCode(r)).toBe('ORDER_INVALID_STATE_TRANSITION');
    });
  });

  // ── HOLD / RESUME ─────────────────────────────────────────────────────────
  describe('hold / resume', () => {
    async function createDraft(): Promise<{ id: string; version: number; fingerprint: string }> {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const b = r.json() as {
        order: { id: string; version: number; commercialSnapshotFingerprint: string };
      };
      return {
        id: b.order.id,
        version: b.order.version,
        fingerprint: b.order.commercialSnapshotFingerprint,
      };
    }

    it('DRAFT -> HELD -> DRAFT: version increments each time, fingerprint never changes, no order number, no invoice', async () => {
      const d = await createDraft();
      const held = await req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
        'if-match': String(d.version),
      });
      expect(held.statusCode, held.payload).toBe(200);
      const heldBody = held.json() as {
        status: string;
        version: number;
        commercialSnapshotFingerprint: string;
        orderNumber: string | null;
      };
      expect(heldBody.status).toBe('HELD');
      expect(heldBody.version).toBe(d.version + 1);
      expect(heldBody.commercialSnapshotFingerprint).toBe(d.fingerprint);
      expect(heldBody.orderNumber).toBeNull();

      const resumed = await req('POST', ORD(coA, branchA, `/${d.id}/resume`), ownerA, undefined, {
        'if-match': String(heldBody.version),
      });
      expect(resumed.statusCode, resumed.payload).toBe(200);
      const resumedBody = resumed.json() as {
        status: string;
        version: number;
        commercialSnapshotFingerprint: string;
      };
      expect(resumedBody.status).toBe('DRAFT');
      expect(resumedBody.version).toBe(heldBody.version + 1);
      expect(resumedBody.commercialSnapshotFingerprint).toBe(d.fingerprint);

      const invoiceCount = await sql<{ count: string }>(`SELECT count(*)::text FROM "invoice"`);
      expect(invoiceCount[0]!.count).toBe('0');
    });

    it('HELD -> CONFIRMED is impossible (no such route); DRAFT cannot resume', async () => {
      const d = await createDraft();
      const resumeFromDraft = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/resume`),
        ownerA,
        undefined,
        { 'if-match': String(d.version) },
      );
      expect(resumeFromDraft.statusCode).toBe(409);
      expect(errCode(resumeFromDraft)).toBe('ORDER_INVALID_STATE_TRANSITION');
    });

    it('a stale If-Match on hold is rejected with a version conflict, and a replay with the ORIGINAL If-Match after success also conflicts deterministically', async () => {
      const d = await createDraft();
      const stale = await req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
        'if-match': String(d.version + 9),
      });
      expect(stale.statusCode).toBe(409);

      const ok = await req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
        'if-match': String(d.version),
      });
      expect(ok.statusCode, ok.payload).toBe(200);

      const replay = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/hold`),
        ownerA,
        undefined,
        { 'if-match': String(d.version) }, // now stale — deterministic, no duplicate transition
      );
      expect(replay.statusCode).toBe(409);
    });
  });

  // ── CANCEL (task 3b.8 Checkpoint C — NO-CHARGE PATH ONLY) ────────────────
  describe('cancel (task 3b.8 Checkpoint C, no-charge path only)', () => {
    async function createDraft(customerId?: string): Promise<{ id: string; version: number }> {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [basicLine({ productId })],
          ...(customerId !== undefined ? { customerId } : {}),
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const b = r.json() as { order: { id: string; version: number } };
      return { id: b.order.id, version: b.order.version };
    }

    /** Local copy of the `concurrency` describe block's own `finalizedInputFor`
     *  (that one is scoped to its own closure) — same minimal PAY_NOW, zero-tax
     *  finalized input, used ONLY to prove cancel can never reach an already-
     *  invoiced Order (never to test issuance itself, which is covered
     *  exhaustively elsewhere). */
    async function finalizedInputForCancelSuite(orderId: string): Promise<{
      tenantId: string;
      companyId: string;
      branchId: string;
      orderId: string;
      expectedVersion: number;
      commercialSnapshotFingerprint: string;
      paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
      lines: {
        orderLineId: string;
        priceTaxMode: string;
        roundingScope: string;
        roundingMode: string;
        lineTaxAmountMinor: bigint;
      }[];
      totals: {
        subtotalAmountMinor: bigint;
        documentDiscountAmountMinor: bigint;
        taxTotalAmountMinor: bigint;
        totalAmountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
      };
    }> {
      const g = await req('GET', ORD(coA, branchA, `/${orderId}`), ownerA);
      const gBody = g.json() as {
        order: { version: number; commercialSnapshotFingerprint: string };
        lines: { id: string }[];
      };
      return {
        tenantId: tenantA,
        companyId: coA,
        branchId: branchA,
        orderId,
        expectedVersion: gBody.order.version,
        commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
        paymentIntent: 'PAY_NOW',
        lines: [
          {
            orderLineId: gBody.lines[0]!.id,
            priceTaxMode: 'TAX_EXCLUSIVE',
            roundingScope: 'LINE',
            roundingMode: 'HALF_UP',
            lineTaxAmountMinor: 0n,
          },
        ],
        totals: {
          subtotalAmountMinor: 2000n,
          documentDiscountAmountMinor: 0n,
          taxTotalAmountMinor: 0n,
          totalAmountMinor: 2000n,
          currencyCode: 'AED',
          currencyExponent: 2,
        },
      };
    }

    it('DRAFT -> CANCELLED succeeds; no Invoice/Payment/PaymentAllocation/CustomerReceivable/CustomerAdvance/journal/stock effect', async () => {
      const d = await createDraft();
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'customer changed their mind' },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode, res.payload).toBe(200);
      const body = res.json() as { status: string; version: number };
      expect(body.status).toBe('CANCELLED');
      expect(body.version).toBe(d.version + 1);

      const [inv, pay, alloc, recv, adv, jrn] = await Promise.all([
        sql<{ count: string }>(`SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`, [
          d.id,
        ]),
        sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM payment_attempt WHERE "orderId"=$1`,
          [d.id],
        ),
        sql<{ count: string }>(`SELECT count(*)::text AS count FROM payment_allocation`),
        sql<{ count: string }>(`SELECT count(*)::text AS count FROM customer_receivable`),
        sql<{ count: string }>(`SELECT count(*)::text AS count FROM customer_advance`),
        sql<{ count: string }>(`SELECT count(*)::text AS count FROM journal_entry`),
      ]);
      expect(inv[0]!.count).toBe('0');
      expect(pay[0]!.count).toBe('0');
      expect(alloc[0]!.count).toBe('0');
      expect(recv[0]!.count).toBe('0');
      expect(adv[0]!.count).toBe('0');
      expect(jrn[0]!.count).toBe('0');

      // the mandatory reason's durable authority — audit_log.reason (§7)
      const auditRow = await sql<{ reason: string | null; action: string }>(
        `SELECT reason, action FROM audit_log WHERE "resourceId"=$1 AND action='order.cancelled'`,
        [d.id],
      );
      expect(auditRow).toHaveLength(1);
      expect(auditRow[0]!.reason).toBe('customer changed their mind');
    });

    it('HELD -> CANCELLED succeeds', async () => {
      const d = await createDraft();
      const held = await req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
        'if-match': String(d.version),
      });
      expect(held.statusCode, held.payload).toBe(200);
      const heldVersion = (held.json() as { version: number }).version;
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'held too long' },
        { 'if-match': String(heldVersion) },
      );
      expect(res.statusCode, res.payload).toBe(200);
      expect((res.json() as { status: string }).status).toBe('CANCELLED');
    });

    it('walk-in (no customer) no-charge cancellation succeeds', async () => {
      const d = await createDraft(); // no customerId — WALK_IN
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'walk-in cancel' },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('a customer-linked order can also be cancelled on the no-charge path', async () => {
      const d = await createDraft(customerId);
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'customer requested, no fee' },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('a missing/empty/whitespace-only reason is rejected (400)', async () => {
      const d = await createDraft();
      for (const badReason of [undefined, '', '   ']) {
        const res = await req(
          'POST',
          ORD(coA, branchA, `/${d.id}/cancel`),
          ownerA,
          badReason === undefined ? {} : { reason: badReason },
          { 'if-match': String(d.version) },
        );
        expect(res.statusCode, res.payload).toBe(400);
      }
    });

    it('If-Match is required, and a stale version is rejected', async () => {
      const d = await createDraft();
      const missing = await req('POST', ORD(coA, branchA, `/${d.id}/cancel`), ownerA, {
        reason: 'x',
      });
      expect(missing.statusCode).toBe(428);

      const stale = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'x' },
        { 'if-match': String(d.version + 9) },
      );
      expect(stale.statusCode).toBe(409);
      expect(errCode(stale)).toBe('ORDER_VERSION_CONFLICT');
    });

    it('CONFIRMED (already invoiced) via the no-charge path is rejected for a caller lacking credit_notes:issue (post-invoice cancellation is Checkpoint D — covered in its own describe block below)', async () => {
      const d = await createDraft();
      const input = await finalizedInputForCancelSuite(d.id);
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
        issuance.issueFinalInvoice(tx, input),
      );
      deliberatelyIssuedOrderIds.add(d.id);
      const confirmedRow = await sql<{ version: number }>(
        `SELECT version FROM "order" WHERE id=$1`,
        [d.id],
      );
      // `ownerA` has `orders:cancel` but NOT `credit_notes:issue` — an
      // invoiced order now routes to the Checkpoint D post-invoice path,
      // which requires that separate financial-document authority.
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'too late' },
        { 'if-match': String(confirmedRow[0]!.version) },
      );
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe('MISSING_PERMISSION');
    });

    it('already-CANCELLED is rejected', async () => {
      const d = await createDraft();
      const first = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'first cancel' },
        { 'if-match': String(d.version) },
      );
      expect(first.statusCode, first.payload).toBe(200);
      const firstVersion = (first.json() as { version: number }).version;
      const second = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'second cancel' },
        { 'if-match': String(firstVersion) },
      );
      expect(second.statusCode).toBe(409);
      expect(errCode(second)).toBe('ORDER_INVALID_STATE_TRANSITION');
    });

    // ── authorization matrix (§21, no-charge path) ──────────────────────────
    it('orders:view alone cannot cancel (403)', async () => {
      const d = await createDraft();
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        viewOnlyA,
        { reason: 'x' },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode).toBe(403);
    });

    it('Owner/Admin/Manager are allowed by default; Cashier/Sales are denied by default (frozen matrix, §5/§21)', async () => {
      const cashier = await mintTenant('cshr', tenantA, ['orders:view', 'orders:manage'], {
        branchScope: [branchA],
      });
      const managerPerms = ['orders:view', 'orders:manage', 'orders:cancel'];
      const managerUser = await mintTenant('mgr', tenantA, managerPerms, {
        branchScope: [branchA],
      });

      const dCashier = await createDraft();
      const cashierRes = await req(
        'POST',
        ORD(coA, branchA, `/${dCashier.id}/cancel`),
        cashier,
        { reason: 'x' },
        { 'if-match': String(dCashier.version) },
      );
      expect(cashierRes.statusCode).toBe(403);

      const dManager = await createDraft();
      const managerRes = await req(
        'POST',
        ORD(coA, branchA, `/${dManager.id}/cancel`),
        managerUser,
        { reason: 'manager cancel' },
        { 'if-match': String(dManager.version) },
      );
      expect(managerRes.statusCode, managerRes.payload).toBe(200);
    });

    it('a cross-tenant caller cannot cancel an order at all (non-disclosing 404)', async () => {
      const d = await createDraft();
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        tenantBUser,
        { reason: 'x' },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode).toBe(404);
    });

    it('a Branch-A-scoped order cannot be cancelled by a Branch-B-scoped caller (non-disclosing 404)', async () => {
      const d = await createDraft();
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        branchBUser,
        { reason: 'x' },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode).toBe(404);
    });

    it('a Company-A2 order path does not exist for a Company-A id (cross-company non-disclosing 404)', async () => {
      const d = await createDraft();
      const res = await req(
        'POST',
        ORD(coA2, branchA, `/${d.id}/cancel`),
        ownerA,
        { reason: 'x' },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // ── CANCEL WITH CHARGE (task 3b.8 Checkpoint C) ──────────────────────────
  describe('cancel WITH CHARGE (task 3b.8 Checkpoint C)', () => {
    let chargeOwner = ''; // orders:cancel + cancellation_charges:issue + step-up
    let chargeAdmin = '';
    let chargeManager = '';
    let chargeAccountant = ''; // cancellation_charges:issue but NO orders:cancel (frozen matrix)
    let onlyOrdersCancel = ''; // orders:cancel only, no charge-issue, step-up irrelevant
    let onlyChargeIssueNoStepUp = ''; // both perms, NO step-up
    let chargeCashier = ''; // frozen default: neither key
    let customerForCharge = '';
    let inclusiveCompanyId = '';
    let inclusiveBranchId = '';
    let inclusiveCustomerId = '';

    beforeAll(async () => {
      // 'ALL' branch scope — `chargeOwner` is also used against the isolated
      // BH/inclusive-tax company+branch fixture below, not just coA/branchA.
      chargeOwner = await mintTenant(
        'chOwner',
        tenantA,
        [...ORDER_PERMS, 'cancellation_charges:issue'],
        {
          branchScope: 'ALL',
          stepUp: true,
        },
      );
      chargeAdmin = await mintTenant(
        'chAdmin',
        tenantA,
        [...ORDER_PERMS, 'cancellation_charges:issue'],
        {
          branchScope: [branchA],
          stepUp: true,
        },
      );
      chargeManager = await mintTenant(
        'chManager',
        tenantA,
        [...ORDER_PERMS, 'cancellation_charges:issue'],
        { branchScope: [branchA], stepUp: true },
      );
      // frozen matrix (task 3b.3): accountant never receives orders:cancel —
      // it independently holds cancellation_charges:issue only.
      chargeAccountant = await mintTenant('chAcct', tenantA, ['cancellation_charges:issue'], {
        branchScope: [branchA],
        stepUp: true,
      });
      onlyOrdersCancel = await mintTenant('onlyCancel', tenantA, ORDER_PERMS, {
        branchScope: [branchA],
        stepUp: true,
      });
      onlyChargeIssueNoStepUp = await mintTenant(
        'noStepUp',
        tenantA,
        [...ORDER_PERMS, 'cancellation_charges:issue'],
        { branchScope: [branchA] }, // no stepUp
      );
      chargeCashier = await mintTenant('chCashier', tenantA, ['orders:view', 'orders:manage'], {
        branchScope: [branchA],
      });

      const custRes = await req(
        'POST',
        `/companies/${coA}/customers`,
        ownerA,
        { displayName: 'Charge Fixture Customer' },
        { 'idempotency-key': 'charge-fixture-customer-1' },
      );
      expect(custRes.statusCode, custRes.payload).toBe(201);
      customerForCharge = (custRes.json() as { id: string }).id;

      // tax reference — self-contained (reuses the SAME `STD3B3`/`ZERO3B3`
      // categories an earlier describe block in this file also creates).
      // `tax_rate` has NO natural-key unique constraint, so `ON CONFLICT DO
      // NOTHING` never actually dedupes it (it only guards the table's own
      // surrogate `id` PK) — a bare `ON CONFLICT DO NOTHING` insert here
      // would silently create a SECOND, genuinely duplicate row and trip
      // `resolveTaxRate`'s own fail-closed ">1 row" ambiguity gate. `WHERE
      // NOT EXISTS` (mirroring `seed()`'s own `country_tax_config` insert
      // pattern) is the correct idempotent guard for this table.
      await sql(
        `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STD3B3','Standard 3b3','x'),('ZERO3B3','Zero 3b3','x') ON CONFLICT (key) DO NOTHING`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom")
         SELECT 'AE','STD3B3',500,'2020-01-01'
          WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE "countryCode"='AE' AND "taxCategoryKey"='STD3B3')`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom")
         SELECT 'AE','ZERO3B3',0,'2020-01-01'
          WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE "countryCode"='AE' AND "taxCategoryKey"='ZERO3B3')`,
      );

      // coA itself is used for TAX_EXCLUSIVE tests — configure its
      // cancellationFeeTaxCategoryKey and give it a wide-open accounting
      // period (coA was provisioned for real, so its Chart of Accounts is
      // already seeded — never re-seeded here).
      await sql(`UPDATE company SET "cancellationFeeTaxCategoryKey" = 'STD3B3' WHERE id = $1`, [
        coA,
      ]);
      await sql(
        `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
         VALUES (uuidv7(), $1, $2, '2020-01-01', '2030-12-31', 'OPEN', now())
         ON CONFLICT DO NOTHING`,
        [tenantA, coA],
      );

      // a second, fully isolated TAX_INCLUSIVE country/currency/company —
      // never touches 'AE' (every other describe block in this file depends
      // on 'AE' staying TAX_EXCLUSIVE for every date it tests). Raw-SQL
      // company (not real provisioning), so its Chart of Accounts is seeded
      // here too — only the 3 keys this checkpoint's GL posting ever uses.
      await sql(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('BHD', 3, 'BHD', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
      );
      await sql(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
         VALUES ('BH', 'Bahrain', 'x', 'gcc', 'BHD', 'SAT_SUN', true, now())
         ON CONFLICT (code) DO NOTHING`,
      );
      await sql(
        `INSERT INTO country_tax_config (id, "countryCode", "effectiveFrom", regime, config)
         SELECT uuidv7(), 'BH', '2020-01-01', 'VAT',
                '{"priceTaxMode":"TAX_INCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb
          WHERE NOT EXISTS (SELECT 1 FROM country_tax_config WHERE "countryCode" = 'BH')`,
      );
      await sql(
        `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STDBH','Standard BH','x') ON CONFLICT (key) DO NOTHING`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom") VALUES ('BH','STDBH',1000,'2020-01-01') ON CONFLICT DO NOTHING`,
      );
      const inclCoRow = await sql<{ id: string }>(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","cancellationFeeTaxCategoryKey","updatedAt")
         VALUES (uuidv7(),$1,'BH Charge Co','BH','BHD','Asia/Bahrain','STDBH',now()) RETURNING id`,
        [tenantA],
      );
      inclusiveCompanyId = inclCoRow[0]!.id;
      const inclBranchRow = await sql<{ id: string }>(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
         VALUES (uuidv7(),$1,$2,'BH Branch',now()) RETURNING id`,
        [tenantA, inclusiveCompanyId],
      );
      inclusiveBranchId = inclBranchRow[0]!.id;
      for (const [key, category, code, name] of [
        ['ASSET.ACCOUNTS_RECEIVABLE', 'ASSET', '1300', 'Accounts Receivable'],
        ['REVENUE.CANCELLATION_CHARGE', 'REVENUE', '4100', 'Cancellation Charge Revenue'],
        ['LIABILITY.TAX_PAYABLE', 'LIABILITY', '2100', 'Tax Payable'],
      ]) {
        await sql(
          `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,now()) ON CONFLICT DO NOTHING`,
          [tenantA, inclusiveCompanyId, key, category, code, name],
        );
      }
      await sql(
        `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
         VALUES (uuidv7(), $1, $2, '2020-01-01', '2030-12-31', 'OPEN', now())`,
        [tenantA, inclusiveCompanyId],
      );
      const inclCustRes = await req(
        'POST',
        `/companies/${inclusiveCompanyId}/customers`,
        ownerA,
        { displayName: 'Inclusive Fixture Customer' },
        { 'idempotency-key': 'charge-fixture-customer-inclusive' },
      );
      expect(inclCustRes.statusCode, inclCustRes.payload).toBe(201);
      inclusiveCustomerId = (inclCustRes.json() as { id: string }).id;
    }, 120_000);

    async function createDraft(customerId?: string): Promise<{ id: string; version: number }> {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [basicLine({ productId })],
          ...(customerId !== undefined ? { customerId } : {}),
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const b = r.json() as { order: { id: string; version: number } };
      return { id: b.order.id, version: b.order.version };
    }

    async function cancelWithCharge(
      orderId: string,
      version: number,
      token: string,
      chargeOverrides: Record<string, unknown> = {},
      companyId = coA,
      branchId = branchA,
    ) {
      return req(
        'POST',
        ORD(companyId, branchId, `/${orderId}/cancel`),
        token,
        {
          reason: 'cancellation charge test',
          cancellationCharge: {
            requestedAmountMinor: '10000',
            reasonCode: 'CUSTOMER_REQUEST',
            ...chargeOverrides,
          },
        },
        { 'if-match': String(version) },
      );
    }

    /** Local copy of the no-charge describe block's own
     *  `finalizedInputForCancelSuite` (that one is scoped to its own
     *  closure) — identical minimal PAY_NOW, zero-tax finalized input, used
     *  only to prove the charge path's own concurrency behavior against
     *  Invoice issuance. */
    async function finalizedInputForCancelSuite(orderId: string): Promise<{
      tenantId: string;
      companyId: string;
      branchId: string;
      orderId: string;
      expectedVersion: number;
      commercialSnapshotFingerprint: string;
      paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
      lines: {
        orderLineId: string;
        priceTaxMode: string;
        roundingScope: string;
        roundingMode: string;
        lineTaxAmountMinor: bigint;
      }[];
      totals: {
        subtotalAmountMinor: bigint;
        documentDiscountAmountMinor: bigint;
        taxTotalAmountMinor: bigint;
        totalAmountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
      };
    }> {
      const g = await req('GET', ORD(coA, branchA, `/${orderId}`), ownerA);
      const gBody = g.json() as {
        order: { version: number; commercialSnapshotFingerprint: string };
        lines: { id: string }[];
      };
      return {
        tenantId: tenantA,
        companyId: coA,
        branchId: branchA,
        orderId,
        expectedVersion: gBody.order.version,
        commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
        paymentIntent: 'PAY_NOW',
        lines: [
          {
            orderLineId: gBody.lines[0]!.id,
            priceTaxMode: 'TAX_EXCLUSIVE',
            roundingScope: 'LINE',
            roundingMode: 'HALF_UP',
            lineTaxAmountMinor: 0n,
          },
        ],
        totals: {
          subtotalAmountMinor: 2000n,
          documentDiscountAmountMinor: 0n,
          taxTotalAmountMinor: 0n,
          totalAmountMinor: 2000n,
          currencyCode: 'AED',
          currencyExponent: 2,
        },
      };
    }

    // ── AUTHORIZATION ───────────────────────────────────────────────────────
    it('Owner with orders:cancel + cancellation_charges:issue + step-up is allowed', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeOwner);
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('Admin with both permissions + step-up is allowed', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeAdmin);
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('Manager with both permissions + step-up is allowed', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeManager);
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('Accountant has cancellation_charges:issue but NOT orders:cancel by default — denied at the route (403), the frozen matrix is never silently widened', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeAccountant);
      expect(res.statusCode).toBe(403);
    });

    it('missing orders:cancel is denied', async () => {
      const onlyCharge = await mintTenant('onlyCharge2', tenantA, ['cancellation_charges:issue'], {
        branchScope: [branchA],
        stepUp: true,
      });
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, onlyCharge);
      expect(res.statusCode).toBe(403);
    });

    it('missing cancellation_charges:issue is denied', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, onlyOrdersCancel);
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe('MISSING_PERMISSION');
    });

    it('both permissions present but no step-up -> STEP_UP_REQUIRED', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, onlyChargeIssueNoStepUp);
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe('STEP_UP_REQUIRED');
    });

    it('Cashier/Sales are denied by default (neither orders:cancel nor cancellation_charges:issue)', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeCashier);
      expect(res.statusCode).toBe(403);
    });

    // ── FUNCTIONAL ──────────────────────────────────────────────────────────
    it('DRAFT customer-linked order: exact CancellationCharge/CustomerReceivable/CustomerAccountEntry/GL/document number (TAX_EXCLUSIVE)', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeOwner, {
        requestedAmountMinor: '10000',
      });
      expect(res.statusCode, res.payload).toBe(200);
      expect((res.json() as { status: string }).status).toBe('CANCELLED');

      const charge = (
        await sql<{
          cancellationChargeNumber: string;
          netAmountMinor: string;
          taxAmountMinor: string;
          totalAmountMinor: string;
          currencyCode: string;
          priceTaxMode: string;
          rateBps: number;
          reasonCode: string;
          note: string;
        }>(
          `SELECT "cancellationChargeNumber","netAmountMinor","taxAmountMinor","totalAmountMinor",
                  "currencyCode","priceTaxMode","rateBps","reasonCode",note
             FROM cancellation_charge WHERE "orderId" = $1`,
          [d.id],
        )
      )[0]!;
      expect(charge.cancellationChargeNumber).toMatch(/^CC-\d{6}$/);
      // TAX_EXCLUSIVE: net = requested, tax = 5% of net, total = net + tax
      expect(charge.netAmountMinor).toBe('10000');
      expect(charge.taxAmountMinor).toBe('500');
      expect(charge.totalAmountMinor).toBe('10500');
      expect(charge.currencyCode).toBe('AED');
      expect(charge.priceTaxMode).toBe('TAX_EXCLUSIVE');
      expect(charge.rateBps).toBe(500);
      expect(charge.reasonCode).toBe('CUSTOMER_REQUEST');
      expect(charge.note).toBe('cancellation charge test');

      const receivable = (
        await sql<{ sourceType: string; cancellationChargeId: string }>(
          `SELECT "sourceType","cancellationChargeId" FROM customer_receivable
            WHERE "cancellationChargeId" = (SELECT id FROM cancellation_charge WHERE "orderId" = $1)`,
          [d.id],
        )
      )[0]!;
      expect(receivable.sourceType).toBe('CANCELLATION_CHARGE');

      const entry = await sql<{ entryKind: string }>(
        `SELECT "entryKind" FROM customer_account_entry
          WHERE "customerReceivableId" = (
            SELECT id FROM customer_receivable
             WHERE "cancellationChargeId" = (SELECT id FROM cancellation_charge WHERE "orderId" = $1)
          )`,
        [d.id],
      );
      expect(entry).toHaveLength(1);
      expect(entry[0]!.entryKind).toBe('CANCELLATION_CHARGE');

      const journalLines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
        `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl."journalEntryId"
           JOIN account a ON a.id = jl."accountId"
          WHERE je."sourceKind" = 'cancellation_charge'
            AND je."sourceId" = (SELECT id::text FROM cancellation_charge WHERE "orderId" = $1)
          ORDER BY a.key`,
        [d.id],
      );
      expect(journalLines).toEqual([
        { key: 'ASSET.ACCOUNTS_RECEIVABLE', debitMinor: '10500', creditMinor: '0' },
        { key: 'LIABILITY.TAX_PAYABLE', debitMinor: '0', creditMinor: '500' },
        { key: 'REVENUE.CANCELLATION_CHARGE', debitMinor: '0', creditMinor: '10000' },
      ]);

      const auditRow = await sql<{ action: string }>(
        `SELECT action FROM audit_log WHERE action = 'cancellation_charge.issued'
          AND "resourceId" = (SELECT id::text FROM cancellation_charge WHERE "orderId" = $1)`,
        [d.id],
      );
      expect(auditRow).toHaveLength(1);
    });

    it('HELD customer-linked order charge cancellation succeeds', async () => {
      const d = await createDraft(customerForCharge);
      const held = await req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
        'if-match': String(d.version),
      });
      expect(held.statusCode, held.payload).toBe(200);
      const heldVersion = (held.json() as { version: number }).version;
      const res = await cancelWithCharge(d.id, heldVersion, chargeOwner);
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('walk-in (no customer) charge cancellation is rejected — financial charge requires a customer', async () => {
      const d = await createDraft(); // no customerId
      const res = await cancelWithCharge(d.id, d.version, chargeOwner);
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('CANCELLATION_CHARGE_REQUIRES_CUSTOMER');
      const orderRow = (
        await sql<{ status: string }>(`SELECT status FROM "order" WHERE id=$1`, [d.id])
      )[0]!;
      expect(orderRow.status).toBe('DRAFT'); // no partial cancellation
    });

    it('missing cancellationFeeTaxCategoryKey is rejected (fail closed), and the order stays DRAFT (atomicity)', async () => {
      // a fresh, unconfigured AE company — never touches coA's own configured key.
      const freshCo = await sql<{ id: string }>(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
         VALUES (uuidv7(),$1,'Unconfigured Co','AE','AED','Asia/Dubai',now()) RETURNING id`,
        [tenantA],
      );
      const freshCoId = freshCo[0]!.id;
      const freshBranch = await sql<{ id: string }>(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
         VALUES (uuidv7(),$1,$2,'Unconfigured Branch',now()) RETURNING id`,
        [tenantA, freshCoId],
      );
      const freshBranchId = freshBranch[0]!.id;
      const freshCustRes = await req(
        'POST',
        `/companies/${freshCoId}/customers`,
        ownerA,
        { displayName: 'Unconfigured Customer' },
        { 'idempotency-key': 'charge-fixture-unconfigured-customer' },
      );
      expect(freshCustRes.statusCode, freshCustRes.payload).toBe(201);
      const freshCustomerId = (freshCustRes.json() as { id: string }).id;

      // raw-SQL order insert (mirrors `createDraftFor`, defined later in this
      // describe block but hoisted) — this fresh company has no catalog price
      // configured for any variant, so the real HTTP create endpoint cannot
      // be used here; CancellationCharge only ever reads the Order's own
      // companyId/branchId/customerId/status/version, never its lines.
      const d = await createDraftFor(freshCoId, freshBranchId, freshCustomerId, {
        code: 'AED',
        exponent: 2,
      });

      const res = await cancelWithCharge(
        d.id,
        d.version,
        chargeOwner,
        {},
        freshCoId,
        freshBranchId,
      );
      expect(res.statusCode).toBe(409);
      expect(errCode(res)).toBe('CANCELLATION_CHARGE_TAX_POLICY_NOT_CONFIGURED');

      const [orderRow, chargeCount] = await Promise.all([
        sql<{ status: string }>(`SELECT status FROM "order" WHERE id=$1`, [d.id]),
        sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM cancellation_charge WHERE "orderId"=$1`,
          [d.id],
        ),
      ]);
      expect(orderRow[0]!.status).toBe('DRAFT'); // no partial cancellation — atomicity
      expect(chargeCount[0]!.count).toBe('0'); // no orphan charge
    });

    it('a zero-rated (ZERO3B3) tax category produces a configured, genuine 0 tax — distinct from "not configured"', async () => {
      await sql(`UPDATE company SET "cancellationFeeTaxCategoryKey" = 'ZERO3B3' WHERE id = $1`, [
        coA,
      ]);
      try {
        const d = await createDraft(customerForCharge);
        const res = await cancelWithCharge(d.id, d.version, chargeOwner, {
          requestedAmountMinor: '5000',
        });
        expect(res.statusCode, res.payload).toBe(200);
        const charge = (
          await sql<{
            netAmountMinor: string;
            taxAmountMinor: string;
            totalAmountMinor: string;
            rateBps: number;
          }>(
            `SELECT "netAmountMinor","taxAmountMinor","totalAmountMinor","rateBps" FROM cancellation_charge WHERE "orderId" = $1`,
            [d.id],
          )
        )[0]!;
        expect(charge.rateBps).toBe(0);
        expect(charge.taxAmountMinor).toBe('0');
        expect(charge.netAmountMinor).toBe('5000');
        expect(charge.totalAmountMinor).toBe('5000');
        // no fake zero-value tax journal line (§14)
        const taxLines = await sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM journal_line jl
             JOIN journal_entry je ON je.id = jl."journalEntryId"
             JOIN account a ON a.id = jl."accountId"
            WHERE je."sourceKind" = 'cancellation_charge'
              AND je."sourceId" = (SELECT id::text FROM cancellation_charge WHERE "orderId" = $1)
              AND a.key = 'LIABILITY.TAX_PAYABLE'`,
          [d.id],
        );
        expect(taxLines[0]!.count).toBe('0');
      } finally {
        await sql(`UPDATE company SET "cancellationFeeTaxCategoryKey" = 'STD3B3' WHERE id = $1`, [
          coA,
        ]);
      }
    });

    it('TAX_INCLUSIVE: requestedAmountMinor is the customer-facing total, tax is extracted, net = total - tax', async () => {
      // the inclusive (BH/BHD) company has no catalog price configured for
      // any variant, so the real HTTP create endpoint cannot be used —
      // CancellationCharge only ever reads the Order's own
      // companyId/branchId/customerId/status/version, never its lines, so a
      // raw-SQL-inserted placeholder Order (`createDraftFor`) is sufficient
      // and exercises the exact same code path as a normally-created Order.
      const d = await createDraftFor(inclusiveCompanyId, inclusiveBranchId, inclusiveCustomerId);
      const res = await cancelWithCharge(
        d.id,
        d.version,
        chargeOwner,
        { requestedAmountMinor: '11000' },
        inclusiveCompanyId,
        inclusiveBranchId,
      );
      expect(res.statusCode, res.payload).toBe(200);
      const charge = (
        await sql<{
          netAmountMinor: string;
          taxAmountMinor: string;
          totalAmountMinor: string;
          priceTaxMode: string;
          currencyCode: string;
        }>(
          `SELECT "netAmountMinor","taxAmountMinor","totalAmountMinor","priceTaxMode","currencyCode"
             FROM cancellation_charge WHERE "orderId" = $1`,
          [d.id],
        )
      )[0]!;
      expect(charge.priceTaxMode).toBe('TAX_INCLUSIVE');
      expect(charge.currencyCode).toBe('BHD');
      // 10% inclusive: total=11000 -> tax = round(11000*1000/11000)=1000, net=10000
      expect(charge.totalAmountMinor).toBe('11000');
      expect(charge.taxAmountMinor).toBe('1000');
      expect(charge.netAmountMinor).toBe('10000');
    });

    it('explicit accountingDate posts the journal at that exact date', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeOwner, {
        accountingDate: '2024-06-15',
      });
      expect(res.statusCode, res.payload).toBe(200);
      const charge = (
        await sql<{ accountingDate: string }>(
          `SELECT "accountingDate"::text FROM cancellation_charge WHERE "orderId" = $1`,
          [d.id],
        )
      )[0]!;
      expect(charge.accountingDate).toBe('2024-06-15');
      const journal = (
        await sql<{ postingDate: string }>(
          `SELECT "postingDate"::text FROM journal_entry
            WHERE "sourceKind" = 'cancellation_charge'
              AND "sourceId" = (SELECT id::text FROM cancellation_charge WHERE "orderId" = $1)`,
          [d.id],
        )
      )[0]!;
      expect(journal.postingDate).toBe('2024-06-15');
    });

    it('a malformed accountingDate is rejected (400) before any mutation', async () => {
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeOwner, {
        accountingDate: '15-06-2024',
      });
      expect(res.statusCode).toBe(400);
      const orderRow = (
        await sql<{ status: string }>(`SELECT status FROM "order" WHERE id=$1`, [d.id])
      )[0]!;
      expect(orderRow.status).toBe('DRAFT');
    });

    it('an accountingDate outside any accounting period is rejected, and the order/charge roll back completely', async () => {
      // must stay INSIDE the AE country_tax_config (effectiveFrom 2018-01-01)
      // and STD3B3 tax_rate (effectiveFrom 2020-01-01) in-force windows —
      // both are open-ended (no effectiveTo) — so this isolates the
      // accounting_period boundary (fixture ends 2030-12-31) specifically,
      // rather than tripping the earlier ORDER_COMPANY_TAX_POLICY_NOT_CONFIGURED
      // fiscal-policy-resolution gate a too-early date (e.g. 2015-01-01) hits
      // first, before the posting-engine period check ever runs.
      const d = await createDraft(customerForCharge);
      const res = await cancelWithCharge(d.id, d.version, chargeOwner, {
        accountingDate: '2031-06-15',
      });
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('NO_OPEN_ACCOUNTING_PERIOD');
      const [orderRow, chargeCount, recvCount] = await Promise.all([
        sql<{ status: string; version: number }>(
          `SELECT status, version FROM "order" WHERE id=$1`,
          [d.id],
        ),
        sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM cancellation_charge WHERE "orderId"=$1`,
          [d.id],
        ),
        sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM customer_receivable cr JOIN cancellation_charge cc ON cc.id = cr."cancellationChargeId" WHERE cc."orderId"=$1`,
          [d.id],
        ),
      ]);
      expect(orderRow[0]!.status).toBe('DRAFT');
      expect(orderRow[0]!.version).toBe(d.version); // untouched — no partial increment
      expect(chargeCount[0]!.count).toBe('0');
      expect(recvCount[0]!.count).toBe('0');
    });

    // ── CONCURRENCY ─────────────────────────────────────────────────────────
    it('charge cancel vs charge cancel, same version: exactly one succeeds, no duplicate charge/document/AR/GL', async () => {
      const d = await createDraft(customerForCharge);
      const [r1, r2] = await Promise.allSettled([
        cancelWithCharge(d.id, d.version, chargeOwner, { requestedAmountMinor: '2000' }),
        cancelWithCharge(d.id, d.version, chargeAdmin, { requestedAmountMinor: '3000' }),
      ]);
      const ok1 = r1.status === 'fulfilled' && r1.value.statusCode === 200;
      const ok2 = r2.status === 'fulfilled' && r2.value.statusCode === 200;
      expect(ok1).not.toBe(ok2);
      const chargeCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM cancellation_charge WHERE "orderId"=$1`,
        [d.id],
      );
      expect(chargeCount[0]!.count).toBe('1');
      const numberCount = await sql<{ count: string }>(
        `SELECT count(DISTINCT "cancellationChargeNumber")::text AS count FROM cancellation_charge WHERE "orderId"=$1`,
        [d.id],
      );
      expect(numberCount[0]!.count).toBe('1');
    });

    it('charge cancel vs internal issuance, same version: exactly one economic outcome, no orphan charge/AR/journal', async () => {
      const d = await createDraft(customerForCharge);
      const input = await finalizedInputForCancelSuite(d.id);
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      const [cancelRes, issueRes] = await Promise.allSettled([
        cancelWithCharge(d.id, d.version, chargeOwner, { requestedAmountMinor: '4000' }),
        runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          issuance.issueFinalInvoice(tx, input),
        ),
      ]);
      const cancelOk = cancelRes.status === 'fulfilled' && cancelRes.value.statusCode === 200;
      const issueOk = issueRes.status === 'fulfilled';
      if (issueOk) deliberatelyIssuedOrderIds.add(d.id);
      expect(cancelOk).not.toBe(issueOk);
      const finalOrder = (
        await sql<{ status: string }>(`SELECT status FROM "order" WHERE id=$1`, [d.id])
      )[0]!;
      if (issueOk) {
        expect(finalOrder.status).toBe('CONFIRMED');
        const chargeCount = await sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM cancellation_charge WHERE "orderId"=$1`,
          [d.id],
        );
        expect(chargeCount[0]!.count).toBe('0'); // no orphan charge against an invoiced order
      } else {
        expect(finalOrder.status).toBe('CANCELLED');
        const invCount = await sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`,
          [d.id],
        );
        expect(invCount[0]!.count).toBe('0');
      }
    });

    /** A raw-SQL-inserted DRAFT Order — `CancellationCharge` only ever reads
     *  the Order's own companyId/branchId/customerId/status/version (never
     *  its lines/currency/taxPriceMode), so a minimally-valid placeholder
     *  row is sufficient for every charge-path test that doesn't need a real
     *  catalog-priced line (avoids needing a priced variant in every test
     *  company). `currencyCode`/`currencyExponent` default to the inclusive
     *  BHD fixture's own shape — irrelevant to the charge path either way. */
    async function createDraftFor(
      companyId: string,
      branchId: string,
      customerId: string,
      currency: { code: string; exponent: number } = { code: 'BHD', exponent: 3 },
    ): Promise<{ id: string; version: number }> {
      const orderRow = await sql<{ id: string; version: number }>(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",
            "customerId",kind,status,"currencyCode","currencyExponent","documentDiscountMode",
            "documentDiscountAmountMinor","commercialSnapshotFingerprint",
            "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$3,$4,'WALK_IN','DRAFT',$5,$6,'NONE',0,'fp-raw-test',2,
                 'TAX_EXCLUSIVE','LINE','HALF_UP',now())
         RETURNING id, version`,
        [tenantA, companyId, branchId, customerId, currency.code, currency.exponent],
      );
      return { id: orderRow[0]!.id, version: orderRow[0]!.version };
    }
  });

  // ── CANCEL (post-invoice, task 3b.8 Checkpoint D) ───────────────────────────
  describe('cancel POST-INVOICE (task 3b.8 Checkpoint D)', () => {
    let cnOwner = ''; // orders:cancel + credit_notes:issue + step-up
    let cnNoCreditNotePerm = ''; // orders:cancel only
    let cnNoStepUp = ''; // both perms, NO step-up
    let cnCollector = ''; // receivables:collect only — seeds paid/partial fixtures
    let customerForCreditNote = '';

    beforeAll(async () => {
      cnOwner = await mintTenant('cnOwner', tenantA, [...ORDER_PERMS, 'credit_notes:issue'], {
        branchScope: 'ALL',
        stepUp: true,
      });
      cnCollector = await mintTenant('cnCollector', tenantA, ['receivables:collect'], {
        branchScope: [branchA],
      });
      cnNoCreditNotePerm = await mintTenant('cnNoCredit', tenantA, ORDER_PERMS, {
        branchScope: [branchA],
        stepUp: true,
      });
      cnNoStepUp = await mintTenant(
        'cnNoStepUp',
        tenantA,
        [...ORDER_PERMS, 'credit_notes:issue'],
        { branchScope: [branchA] }, // no stepUp
      );

      const custRes = await req(
        'POST',
        `/companies/${coA}/customers`,
        ownerA,
        { displayName: 'Credit Note Fixture Customer' },
        { 'idempotency-key': 'credit-note-fixture-customer-1' },
      );
      expect(custRes.statusCode, custRes.payload).toBe(201);
      customerForCreditNote = (custRes.json() as { id: string }).id;
    });

    async function createDraft(customerId?: string): Promise<{ id: string; version: number }> {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [basicLine({ productId })],
          ...(customerId !== undefined ? { customerId } : {}),
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const b = r.json() as { order: { id: string; version: number } };
      return { id: b.order.id, version: b.order.version };
    }

    /** Identical minimal PAY_NOW, zero-tax finalized input as the sibling
     *  charge describe block's own copy — totalAmountMinor is always 2000. */
    async function finalizedInputForCreditNote(orderId: string): Promise<{
      tenantId: string;
      companyId: string;
      branchId: string;
      orderId: string;
      expectedVersion: number;
      commercialSnapshotFingerprint: string;
      paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
      lines: {
        orderLineId: string;
        priceTaxMode: string;
        roundingScope: string;
        roundingMode: string;
        lineTaxAmountMinor: bigint;
      }[];
      totals: {
        subtotalAmountMinor: bigint;
        documentDiscountAmountMinor: bigint;
        taxTotalAmountMinor: bigint;
        totalAmountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
      };
    }> {
      const g = await req('GET', ORD(coA, branchA, `/${orderId}`), ownerA);
      const gBody = g.json() as {
        order: { version: number; commercialSnapshotFingerprint: string };
        lines: { id: string }[];
      };
      return {
        tenantId: tenantA,
        companyId: coA,
        branchId: branchA,
        orderId,
        expectedVersion: gBody.order.version,
        commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
        paymentIntent: 'PAY_NOW',
        lines: [
          {
            orderLineId: gBody.lines[0]!.id,
            priceTaxMode: 'TAX_EXCLUSIVE',
            roundingScope: 'LINE',
            roundingMode: 'HALF_UP',
            lineTaxAmountMinor: 0n,
          },
        ],
        totals: {
          subtotalAmountMinor: 2000n,
          documentDiscountAmountMinor: 0n,
          taxTotalAmountMinor: 0n,
          totalAmountMinor: 2000n,
          currencyCode: 'AED',
          currencyExponent: 2,
        },
      };
    }

    /** Issues a real Invoice via the internal primitive (never through a
     *  public route — none exists), and tracks the order id as deliberately
     *  issued for the file's own structural non-scope proof. */
    async function issueInvoiceFor(orderId: string): Promise<string> {
      const input = await finalizedInputForCreditNote(orderId);
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
        issuance.issueFinalInvoice(tx, input),
      );
      deliberatelyIssuedOrderIds.add(orderId);
      const invRows = await sql<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [
        orderId,
      ]);
      return invRows[0]!.id;
    }

    /** A dedicated, fresh customer — required for any test that collects a
     *  real payment via the FIFO receipt-collection route, since FIFO
     *  allocates oldest-UNPAID-invoice-first for a given customer: sharing
     *  `customerForCreditNote` with the auth-denial tests above (which issue
     *  an Invoice but never cancel it, leaving it UNPAID) would silently
     *  misdirect a payment meant for THIS test's own invoice. */
    async function freshCustomer(label: string): Promise<string> {
      const r = await req(
        'POST',
        `/companies/${coA}/customers`,
        ownerA,
        { displayName: `Credit Note ${label}` },
        { 'idempotency-key': `credit-note-${label}-${ik()}` },
      );
      expect(r.statusCode, r.payload).toBe(201);
      return (r.json() as { id: string }).id;
    }

    async function cancelInvoiced(
      orderId: string,
      version: number,
      token: string,
      overrides: Record<string, unknown> = {},
    ) {
      return req(
        'POST',
        ORD(coA, branchA, `/${orderId}/cancel`),
        token,
        { reason: 'post-invoice cancellation test', ...overrides },
        { 'if-match': String(version) },
      );
    }

    // ── AUTHORIZATION ───────────────────────────────────────────────────────
    it('missing credit_notes:issue is denied (403 MISSING_PERMISSION)', async () => {
      const d = await createDraft(customerForCreditNote);
      await issueInvoiceFor(d.id);
      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const res = await cancelInvoiced(d.id, row[0]!.version, cnNoCreditNotePerm);
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe('MISSING_PERMISSION');
    });

    it('credit_notes:issue without a fresh step-up is denied (403 STEP_UP_REQUIRED)', async () => {
      const d = await createDraft(customerForCreditNote);
      await issueInvoiceFor(d.id);
      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const res = await cancelInvoiced(d.id, row[0]!.version, cnNoStepUp);
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe('STEP_UP_REQUIRED');
    });

    // ── WALK-IN BLOCKED ──────────────────────────────────────────────────────
    it('a walk-in (no customer) invoiced order cannot be cancelled (422)', async () => {
      const d = await createDraft(); // no customerId
      await issueInvoiceFor(d.id);
      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const res = await cancelInvoiced(d.id, row[0]!.version, cnOwner);
      expect(res.statusCode, res.payload).toBe(422);
      expect(errCode(res)).toBe('WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE');
      const orderRow = (
        await sql<{ status: string }>(`SELECT status FROM "order" WHERE id=$1`, [d.id])
      )[0]!;
      expect(orderRow.status).not.toBe('CANCELLED');
    });

    // ── FUNCTIONAL: fully UNPAID invoice ─────────────────────────────────────
    it('a fully UNPAID invoice: CreditNote arReduction=total, advanceExcess=0, invoicePaymentStatus -> CANCELLED, no CustomerAdvance created', async () => {
      const d = await createDraft(customerForCreditNote);
      const invoiceId = await issueInvoiceFor(d.id);
      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const res = await cancelInvoiced(d.id, row[0]!.version, cnOwner);
      expect(res.statusCode, res.payload).toBe(200);
      const body = res.json() as { status: string };
      expect(body.status).toBe('CANCELLED');

      const cn = (
        await sql<{
          creditNoteNumber: string;
          totalAmountMinor: string;
          arReductionMinor: string;
          advanceExcessMinor: string;
        }>(
          `SELECT "creditNoteNumber", "totalAmountMinor"::text, "arReductionMinor"::text, "advanceExcessMinor"::text
             FROM credit_note WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      )[0]!;
      expect(cn.creditNoteNumber).toMatch(/^CN-\d{6}$/);
      expect(cn.totalAmountMinor).toBe('2000');
      expect(cn.arReductionMinor).toBe('2000');
      expect(cn.advanceExcessMinor).toBe('0');

      const invStatus = (
        await sql<{ invoicePaymentStatus: string }>(
          `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
          [invoiceId],
        )
      )[0]!;
      expect(invStatus.invoicePaymentStatus).toBe('CANCELLED');

      const advCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_advance WHERE "sourceType" = 'CREDIT_NOTE'
           AND id IN (SELECT "customerAdvanceId" FROM credit_note_coverage_release WHERE "creditNoteId" = (SELECT id FROM credit_note WHERE "invoiceId" = $1))`,
        [invoiceId],
      );
      expect(advCount[0]!.count).toBe('0');

      const journalLines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
        `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl."journalEntryId"
           JOIN account a ON a.id = jl."accountId"
          WHERE je."sourceKind" = 'credit_note'
            AND je."sourceId" = (SELECT id::text FROM credit_note WHERE "invoiceId" = $1)
          ORDER BY a.key`,
        [invoiceId],
      );
      expect(journalLines).toEqual([
        { key: 'ASSET.ACCOUNTS_RECEIVABLE', debitMinor: '0', creditMinor: '2000' },
        { key: 'REVENUE.SALES', debitMinor: '2000', creditMinor: '0' },
      ]);
    });

    // ── FUNCTIONAL: fully PAID invoice ───────────────────────────────────────
    it('a fully PAID invoice: CreditNote arReduction=0, advanceExcess=total, invoicePaymentStatus -> REFUNDED, exactly one CREDIT_NOTE-sourced CustomerAdvance', async () => {
      const paidCustomer = await freshCustomer('paid');
      const d = await createDraft(paidCustomer);
      const invoiceId = await issueInvoiceFor(d.id);
      // OTHER_MANUAL — a CASH/BANK_TRANSFER tender is settlement-final
      // immediately (task 3b.7), which would auto-promote a fully-covered
      // invoice PAID -> SETTLED (`InvoiceSettlementProjectionRepository`'s
      // own tail hook) before this test ever gets to exercise the PAID ->
      // REFUNDED cancellation edge in isolation — SETTLED is out of this
      // checkpoint's scope entirely. OTHER_MANUAL is never settlement-final
      // in 3b.7, so the invoice stays at PAID.
      const collect = await req(
        'POST',
        `/companies/${coA}/branches/${branchA}/customers/${paidCustomer}/receipts`,
        cnCollector,
        { amountMinor: '2000', method: 'OTHER_MANUAL' },
        { 'idempotency-key': ik() },
      );
      expect(collect.statusCode, collect.payload).toBe(201);

      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const res = await cancelInvoiced(d.id, row[0]!.version, cnOwner);
      expect(res.statusCode, res.payload).toBe(200);

      const cn = (
        await sql<{ arReductionMinor: string; advanceExcessMinor: string }>(
          `SELECT "arReductionMinor"::text, "advanceExcessMinor"::text FROM credit_note WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      )[0]!;
      expect(cn.arReductionMinor).toBe('0');
      expect(cn.advanceExcessMinor).toBe('2000');

      const invStatus = (
        await sql<{ invoicePaymentStatus: string }>(
          `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
          [invoiceId],
        )
      )[0]!;
      expect(invStatus.invoicePaymentStatus).toBe('REFUNDED');

      const advances = await sql<{ amountMinor: string }>(
        `SELECT "amountMinor"::text AS "amountMinor" FROM customer_advance
           WHERE "sourceType" = 'CREDIT_NOTE'
             AND id IN (SELECT "customerAdvanceId" FROM credit_note_coverage_release WHERE "creditNoteId" = (SELECT id FROM credit_note WHERE "invoiceId" = $1))`,
        [invoiceId],
      );
      expect(advances).toHaveLength(1);
      expect(advances[0]!.amountMinor).toBe('2000');

      const journalLines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
        `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl."journalEntryId"
           JOIN account a ON a.id = jl."accountId"
          WHERE je."sourceKind" = 'credit_note'
            AND je."sourceId" = (SELECT id::text FROM credit_note WHERE "invoiceId" = $1)
          ORDER BY a.key`,
        [invoiceId],
      );
      expect(journalLines).toEqual([
        { key: 'LIABILITY.CUSTOMER_ADVANCES', debitMinor: '0', creditMinor: '2000' },
        { key: 'REVENUE.SALES', debitMinor: '2000', creditMinor: '0' },
      ]);
    });

    // ── FUNCTIONAL: partially paid invoice ───────────────────────────────────
    it('a partially paid invoice: arReduction + advanceExcess = total, invoicePaymentStatus -> PARTIALLY_REFUNDED', async () => {
      const partialCustomer = await freshCustomer('partial');
      const d = await createDraft(partialCustomer);
      const invoiceId = await issueInvoiceFor(d.id);
      const collect = await req(
        'POST',
        `/companies/${coA}/branches/${branchA}/customers/${partialCustomer}/receipts`,
        cnCollector,
        { amountMinor: '800', method: 'CASH' },
        { 'idempotency-key': ik() },
      );
      expect(collect.statusCode, collect.payload).toBe(201);

      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const res = await cancelInvoiced(d.id, row[0]!.version, cnOwner);
      expect(res.statusCode, res.payload).toBe(200);

      const cn = (
        await sql<{ arReductionMinor: string; advanceExcessMinor: string }>(
          `SELECT "arReductionMinor"::text, "advanceExcessMinor"::text FROM credit_note WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      )[0]!;
      expect(cn.arReductionMinor).toBe('1200');
      expect(cn.advanceExcessMinor).toBe('800');

      const invStatus = (
        await sql<{ invoicePaymentStatus: string }>(
          `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
          [invoiceId],
        )
      )[0]!;
      expect(invStatus.invoicePaymentStatus).toBe('PARTIALLY_REFUNDED');
    });

    // ── INELIGIBLE STATES ────────────────────────────────────────────────────
    it('an already-CANCELLED invoiced order cannot be cancelled again (409)', async () => {
      const d = await createDraft(customerForCreditNote);
      await issueInvoiceFor(d.id);
      const row1 = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [
        d.id,
      ]);
      const first = await cancelInvoiced(d.id, row1[0]!.version, cnOwner);
      expect(first.statusCode, first.payload).toBe(200);

      const row2 = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [
        d.id,
      ]);
      const second = await cancelInvoiced(d.id, row2[0]!.version, cnOwner);
      expect(second.statusCode).toBe(409);
      expect(errCode(second)).toBe('ORDER_INVALID_STATE_TRANSITION');
    });

    it('a SETTLED invoice cannot be cancelled in this task (409 INVOICE_CANCELLATION_NOT_SUPPORTED)', async () => {
      const d = await createDraft(customerForCreditNote);
      const invoiceId = await issueInvoiceFor(d.id);
      // simulate a settled invoice directly — a real 3b.7 settlement flow is
      // out of scope for this gate-only test.
      await sql(`UPDATE invoice SET "invoicePaymentStatus" = 'SETTLED' WHERE id = $1`, [invoiceId]);
      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const res = await cancelInvoiced(d.id, row[0]!.version, cnOwner);
      expect(res.statusCode).toBe(409);
      expect(errCode(res)).toBe('INVOICE_CANCELLATION_NOT_SUPPORTED');
      const orderRow = (
        await sql<{ status: string }>(`SELECT status FROM "order" WHERE id=$1`, [d.id])
      )[0]!;
      expect(orderRow.status).not.toBe('CANCELLED');
    });
  });

  // ── REFUND (task 3b.8 Checkpoint D) ─────────────────────────────────────────
  describe('refund (task 3b.8 Checkpoint D)', () => {
    let refundExecutor = ''; // refunds:execute + step-up
    let refundNoPerm = '';
    let refundNoStepUp = '';

    beforeAll(async () => {
      refundExecutor = await mintTenant('refundExec', tenantA, ['refunds:execute'], {
        branchScope: 'ALL',
        stepUp: true,
      });
      refundNoPerm = await mintTenant('refundNoPerm', tenantA, [], {
        branchScope: [branchA],
        stepUp: true,
      });
      refundNoStepUp = await mintTenant('refundNoStepUp', tenantA, ['refunds:execute'], {
        branchScope: [branchA],
      });
    });

    async function freshCustomer(label: string): Promise<string> {
      const r = await req(
        'POST',
        `/companies/${coA}/customers`,
        ownerA,
        { displayName: `Refund ${label}` },
        { 'idempotency-key': `refund-${label}-${ik()}` },
      );
      expect(r.statusCode, r.payload).toBe(201);
      return (r.json() as { id: string }).id;
    }

    /** Creates a customer-linked, invoiced, fully-paid (OTHER_MANUAL — never
     *  settlement-final, so the invoice stays at PAID not SETTLED), then
     *  cancels it — producing exactly ONE CREDIT_NOTE-sourced CustomerAdvance
     *  of 2000 minor units, the fixture every refund test below needs. */
    async function creditNoteFundedAdvance(): Promise<{ customerId: string; advanceId: string }> {
      const customerId = await freshCustomer(`adv-${ik()}`);
      const cnOwner = await mintTenant(
        `cnFor-${ik()}`,
        tenantA,
        [...ORDER_PERMS, 'credit_notes:issue'],
        {
          branchScope: 'ALL',
          stepUp: true,
        },
      );
      const collector = await mintTenant(`coll-${ik()}`, tenantA, ['receivables:collect'], {
        branchScope: [branchA],
      });

      const productId = await productIdFor(variantId);
      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId })], customerId },
        { 'idempotency-key': ik() },
      );
      expect(created.statusCode, created.payload).toBe(201);
      const d = (created.json() as { order: { id: string; version: number } }).order;

      const g = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
      const gBody = g.json() as {
        order: { version: number; commercialSnapshotFingerprint: string };
        lines: { id: string }[];
      };
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
        issuance.issueFinalInvoice(tx, {
          tenantId: tenantA,
          companyId: coA,
          branchId: branchA,
          orderId: d.id,
          expectedVersion: gBody.order.version,
          commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
          paymentIntent: 'PAY_NOW',
          lines: [
            {
              orderLineId: gBody.lines[0]!.id,
              priceTaxMode: 'TAX_EXCLUSIVE',
              roundingScope: 'LINE',
              roundingMode: 'HALF_UP',
              lineTaxAmountMinor: 0n,
            },
          ],
          totals: {
            subtotalAmountMinor: 2000n,
            documentDiscountAmountMinor: 0n,
            taxTotalAmountMinor: 0n,
            totalAmountMinor: 2000n,
            currencyCode: 'AED',
            currencyExponent: 2,
          },
        }),
      );
      deliberatelyIssuedOrderIds.add(d.id);

      const collect = await req(
        'POST',
        `/companies/${coA}/branches/${branchA}/customers/${customerId}/receipts`,
        collector,
        { amountMinor: '2000', method: 'OTHER_MANUAL' },
        { 'idempotency-key': ik() },
      );
      expect(collect.statusCode, collect.payload).toBe(201);

      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [d.id]);
      const cancel = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        cnOwner,
        { reason: 'refund fixture setup' },
        { 'if-match': String(row[0]!.version) },
      );
      expect(cancel.statusCode, cancel.payload).toBe(200);

      const advRows = await sql<{ id: string }>(
        `SELECT ca.id FROM customer_advance ca
           JOIN credit_note_coverage_release r ON r."customerAdvanceId" = ca.id
          WHERE r."creditNoteId" = (SELECT cn.id FROM credit_note cn JOIN invoice i ON i.id = cn."invoiceId" WHERE i."orderId" = $1)`,
        [d.id],
      );
      return { customerId, advanceId: advRows[0]!.id };
    }

    const refundUrl = (
      companyId: string,
      branchId: string,
      customerId: string,
      advanceId: string,
    ): string =>
      `/companies/${companyId}/branches/${branchId}/customers/${customerId}/advances/${advanceId}/refunds`;

    it('a permitted Owner executes a CASH refund of the full advance — 201, GL balanced, advance drained', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const res = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundExecutor,
        { requestedAmountMinor: '2000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
      const body = res.json() as { refundId: string; amountMinor: string; currencyCode: string };
      expect(body.amountMinor).toBe('2000');
      expect(body.currencyCode).toBe('AED');

      const refundRow = (
        await sql<{ method: string; amountMinor: string; sourceRefundAttemptId: string | null }>(
          `SELECT method, "amountMinor"::text, "sourceRefundAttemptId" FROM refund WHERE id = $1`,
          [body.refundId],
        )
      )[0]!;
      expect(refundRow.method).toBe('CASH');
      expect(refundRow.amountMinor).toBe('2000');
      expect(refundRow.sourceRefundAttemptId).toBeNull();

      const journalLines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
        `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl."journalEntryId"
           JOIN account a ON a.id = jl."accountId"
          WHERE je."sourceKind" = 'refund' AND je."sourceId" = $1
          ORDER BY a.key`,
        [body.refundId],
      );
      expect(journalLines).toEqual([
        { key: 'ASSET.CASH_ON_HAND', debitMinor: '0', creditMinor: '2000' },
        { key: 'LIABILITY.CUSTOMER_ADVANCES', debitMinor: '2000', creditMinor: '0' },
      ]);

      // draining the advance to zero: a second refund attempt against it fails.
      const second = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundExecutor,
        { requestedAmountMinor: '1', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(second.statusCode).toBe(409);
      expect(errCode(second)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');
    });

    it('a refund request exceeding the available advance balance is rejected (409)', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const res = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundExecutor,
        { requestedAmountMinor: '2001', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(409);
      expect(errCode(res)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');
    });

    it('OTHER_MANUAL refund execution is rejected (422 REFUND_METHOD_NOT_SUPPORTED)', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const res = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundExecutor,
        { requestedAmountMinor: '100', method: 'OTHER_MANUAL', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('REFUND_METHOD_NOT_SUPPORTED');
    });

    // ── LOCAL (CASH/BANK_TRANSFER) hard gates ──────────────────────────────────
    const advanceBalanceOf = async (customerId: string): Promise<string> =>
      (
        await sql<{ v: string }>(
          `SELECT "advanceBalanceMinor"::text AS v FROM customer_company_account WHERE "customerId" = $1`,
          [customerId],
        )
      )[0]!.v;
    /** global counts of every table a refund could touch — compared
     *  before/after a single request (tests in this file run sequentially, so
     *  a delta is attributable to that request alone). */
    const refundFootprint = async (): Promise<Record<string, string>> => {
      const one = async (q: string): Promise<string> => (await sql<{ c: string }>(q))[0]!.c;
      return {
        refund: await one(`SELECT count(*)::text AS c FROM refund`),
        application: await one(
          `SELECT count(*)::text AS c FROM customer_advance_refund_application`,
        ),
        attempt: await one(`SELECT count(*)::text AS c FROM refund_attempt`),
        reservation: await one(
          `SELECT count(*)::text AS c FROM refund_attempt_entitlement_reservation`,
        ),
        // ANY kind/source — a refund request that is supposed to be a no-op
        // must not create a chronology entry or a journal of any sort.
        entryAny: await one(`SELECT count(*)::text AS c FROM customer_account_entry`),
        journalAny: await one(`SELECT count(*)::text AS c FROM journal_entry`),
      };
    };

    it('a BANK_TRANSFER refund executes end-to-end — 201, partial amount leaves the remainder, GL Dr CUSTOMER_ADVANCES / Cr BANK', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      expect(await advanceBalanceOf(customerId)).toBe('2000');
      const res = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundExecutor,
        { requestedAmountMinor: '750', method: 'BANK_TRANSFER', reasonCode: 'DUPLICATE' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
      const body = res.json() as { refundId: string; amountMinor: string };
      expect(body.amountMinor).toBe('750');

      const refundRow = (
        await sql<{ method: string; reasonCode: string; sourceRefundAttemptId: string | null }>(
          `SELECT method, "reasonCode", "sourceRefundAttemptId" FROM refund WHERE id = $1`,
          [body.refundId],
        )
      )[0]!;
      expect(refundRow).toEqual({
        method: 'BANK_TRANSFER',
        reasonCode: 'DUPLICATE',
        sourceRefundAttemptId: null,
      });

      const journalLines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
        `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
           FROM journal_line jl
           JOIN journal_entry je ON je.id = jl."journalEntryId"
           JOIN account a ON a.id = jl."accountId"
          WHERE je."sourceKind" = 'refund' AND je."sourceId" = $1
          ORDER BY a.key`,
        [body.refundId],
      );
      expect(journalLines).toEqual([
        { key: 'ASSET.BANK', debitMinor: '0', creditMinor: '750' },
        { key: 'LIABILITY.CUSTOMER_ADVANCES', debitMinor: '750', creditMinor: '0' },
      ]);

      // exactly one REFUND chronology entry, anchored to the application row.
      const entries = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_account_entry
          WHERE "entryKind" = 'REFUND'
            AND "customerAdvanceRefundApplicationId" IN
                (SELECT id FROM customer_advance_refund_application WHERE "refundId" = $1)`,
        [body.refundId],
      );
      expect(entries[0]!.count).toBe('1');
      expect(await advanceBalanceOf(customerId)).toBe('1250');
    });

    it('HTTP-level retry (same Idempotency-Key + body) replays the original result and never double-refunds; a different body under that key is rejected', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const key = ik();
      const body = { requestedAmountMinor: '2000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' };
      const url = refundUrl(coA, branchA, customerId, advanceId);
      const first = await req('POST', url, refundExecutor, body, { 'idempotency-key': key });
      expect(first.statusCode, first.payload).toBe(201);
      const second = await req('POST', url, refundExecutor, body, { 'idempotency-key': key });
      expect(second.statusCode, second.payload).toBe(201);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect((second.json() as { refundId: string }).refundId).toBe(
        (first.json() as { refundId: string }).refundId,
      );
      const applications = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_advance_refund_application WHERE "customerAdvanceId" = $1`,
        [advanceId],
      );
      expect(applications[0]!.count).toBe('1');
      expect(await advanceBalanceOf(customerId)).toBe('0');

      const conflicting = await req(
        'POST',
        url,
        refundExecutor,
        { ...body, requestedAmountMinor: '1' },
        { 'idempotency-key': key },
      );
      expect(conflicting.statusCode).toBe(409);
      expect(errCode(conflicting)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refund-vs-refund concurrency on the same advance yields exactly ONE economic result', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const url = refundUrl(coA, branchA, customerId, advanceId);
      const results = await Promise.all([
        req(
          'POST',
          url,
          refundExecutor,
          { requestedAmountMinor: '2000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
          { 'idempotency-key': ik() },
        ),
        req(
          'POST',
          url,
          refundExecutor,
          { requestedAmountMinor: '2000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
          { 'idempotency-key': ik() },
        ),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.statusCode === 409)!;
      expect(errCode(loser)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');
      const applied = await sql<{ count: string; total: string }>(
        `SELECT count(*)::text AS count, COALESCE(sum("amountMinor"),0)::text AS total
           FROM customer_advance_refund_application WHERE "customerAdvanceId" = $1`,
        [advanceId],
      );
      expect(applied[0]).toEqual({ count: '1', total: '2000' });
      expect(await advanceBalanceOf(customerId)).toBe('0');
    });

    it('rollback: a failure inside the refund transaction leaves NO partial financial state, and a retry afterwards succeeds exactly once', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const key = ik();
      const url = refundUrl(coA, branchA, customerId, advanceId);
      const body = { requestedAmountMinor: '2000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' };
      const footprintBefore = await refundFootprint();

      // fault injection at the LAST write before GL posting (the REFUND
      // chronology entry) — the Refund + application rows written earlier in
      // the SAME transaction must roll back with it.
      await sql(
        `CREATE OR REPLACE FUNCTION fn_test_fail_refund_entry() RETURNS trigger AS $$
         BEGIN
           IF NEW."entryKind" = 'REFUND' THEN RAISE EXCEPTION 'injected refund failure'; END IF;
           RETURN NEW;
         END; $$ LANGUAGE plpgsql`,
      );
      await sql(
        `CREATE TRIGGER trg_test_fail_refund_entry BEFORE INSERT ON customer_account_entry
           FOR EACH ROW EXECUTE FUNCTION fn_test_fail_refund_entry()`,
      );
      try {
        const failed = await req('POST', url, refundExecutor, body, { 'idempotency-key': key });
        expect(failed.statusCode, failed.payload).toBeGreaterThanOrEqual(500);
        expect(await refundFootprint()).toEqual(footprintBefore);
        expect(await advanceBalanceOf(customerId)).toBe('2000');
      } finally {
        await sql(`DROP TRIGGER IF EXISTS trg_test_fail_refund_entry ON customer_account_entry`);
        await sql(`DROP FUNCTION IF EXISTS fn_test_fail_refund_entry()`);
      }

      // the failed request released its idempotency claim, so the SAME key
      // retries cleanly — and produces exactly one refund.
      const retry = await req('POST', url, refundExecutor, body, { 'idempotency-key': key });
      expect(retry.statusCode, retry.payload).toBe(201);
      const applied = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_advance_refund_application WHERE "customerAdvanceId" = $1`,
        [advanceId],
      );
      expect(applied[0]!.count).toBe('1');
      expect(await advanceBalanceOf(customerId)).toBe('0');
    });

    it("another customer's advance, or a customer with no company account, is a non-disclosing 404 — nothing is created", async () => {
      const a = await creditNoteFundedAdvance();
      const otherCustomer = await freshCustomer('other');
      const footprintBefore = await refundFootprint();

      const crossCustomer = await req(
        'POST',
        refundUrl(coA, branchA, otherCustomer, a.advanceId),
        refundExecutor,
        { requestedAmountMinor: '100', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(crossCustomer.statusCode).toBe(404);
      expect(errCode(crossCustomer)).toBe('CUSTOMER_ADVANCE_NOT_FOUND');

      const noAccount = await req(
        'POST',
        refundUrl(coA, branchA, crypto.randomUUID(), a.advanceId),
        refundExecutor,
        { requestedAmountMinor: '100', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(noAccount.statusCode).toBe(404);
      expect(errCode(noAccount)).toBe('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND');

      expect(await refundFootprint()).toEqual(footprintBefore);
      expect(await advanceBalanceOf(a.customerId)).toBe('2000');
    });

    it('the persisted Refund and CustomerAdvanceRefundApplication are immutable (DB-enforced: UPDATE and DELETE both rejected)', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const res = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundExecutor,
        { requestedAmountMinor: '500', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(201);
      const refundId = (res.json() as { refundId: string }).refundId;
      const application = (
        await sql<{ id: string }>(
          `SELECT id FROM customer_advance_refund_application WHERE "refundId" = $1`,
          [refundId],
        )
      )[0]!;
      await expect(
        sql(`UPDATE refund SET "reasonCode" = 'OTHER' WHERE id = $1`, [refundId]),
      ).rejects.toThrow(/immutable/i);
      await expect(sql(`DELETE FROM refund WHERE id = $1`, [refundId])).rejects.toThrow(
        /immutable/i,
      );
      await expect(
        sql(`UPDATE customer_advance_refund_application SET "amountMinor" = 1 WHERE id = $1`, [
          application.id,
        ]),
      ).rejects.toThrow(/immutable/i);
      await expect(
        sql(`DELETE FROM customer_advance_refund_application WHERE id = $1`, [application.id]),
      ).rejects.toThrow(/immutable/i);
    });

    it('missing refunds:execute is denied (403 MISSING_PERMISSION)', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const res = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundNoPerm,
        { requestedAmountMinor: '100', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(403);
    });

    it('refunds:execute without a fresh step-up is denied (403 STEP_UP_REQUIRED)', async () => {
      const { customerId, advanceId } = await creditNoteFundedAdvance();
      const res = await req(
        'POST',
        refundUrl(coA, branchA, customerId, advanceId),
        refundNoStepUp,
        { requestedAmountMinor: '100', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(403);
      expect(errCode(res)).toBe('STEP_UP_REQUIRED');
    });

    // ── PROVIDER-BACKED REFUNDS (task 3b.8 Checkpoint D) ─────────────────────
    // Public route: completely side-effect free until PaymentProvider.refund/
    // getStatus exist. Internal RefundAttempt foundation: kept, exercised
    // directly.
    describe('provider-backed refunds', () => {
      const PROVIDER_CRED = '00000000-0000-7000-9000-0000000003b8';

      beforeAll(async () => {
        await sql(
          `INSERT INTO provider_credential
             (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
           VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())
           ON CONFLICT (id) DO NOTHING`,
          [PROVIDER_CRED, tenantA, coA, branchA],
        );
      });

      /** Creates a customer-linked, invoiced order whose Invoice is paid by
       *  a RAW-SEEDED provider-backed Payment (ONLINE_GATEWAY) — never
       *  through a real adapter (none exists) — then cancels it, producing a
       *  CREDIT_NOTE-sourced Advance whose provenance traces to that
       *  provider-backed Payment. `settled: true` additionally raw-seeds a
       *  FINALIZED SettlementBatch/Application covering the full payment
       *  amount, satisfying `isPaymentSettlementFinal`. */
      async function providerBackedCreditNoteAdvance(opts: {
        settled: boolean;
      }): Promise<{ customerId: string; advanceId: string; paymentId: string }> {
        const customerId = await freshCustomer(`prov-${ik()}`);
        const cnOwner = await mintTenant(
          `cnProv-${ik()}`,
          tenantA,
          [...ORDER_PERMS, 'credit_notes:issue'],
          { branchScope: 'ALL', stepUp: true },
        );

        const productId = await productIdFor(variantId);
        const created = await req(
          'POST',
          ORD(coA, branchA),
          ownerA,
          { lines: [basicLine({ productId })], customerId },
          { 'idempotency-key': ik() },
        );
        expect(created.statusCode, created.payload).toBe(201);
        const d = (created.json() as { order: { id: string; version: number } }).order;

        const g = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
        const gBody = g.json() as {
          order: { version: number; commercialSnapshotFingerprint: string };
          lines: { id: string }[];
        };
        const issuance = app.get(InvoiceIssuanceRepository);
        const db = app.get(DbService);
        await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          issuance.issueFinalInvoice(tx, {
            tenantId: tenantA,
            companyId: coA,
            branchId: branchA,
            orderId: d.id,
            expectedVersion: gBody.order.version,
            commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
            paymentIntent: 'PAY_NOW',
            lines: [
              {
                orderLineId: gBody.lines[0]!.id,
                priceTaxMode: 'TAX_EXCLUSIVE',
                roundingScope: 'LINE',
                roundingMode: 'HALF_UP',
                lineTaxAmountMinor: 0n,
              },
            ],
            totals: {
              subtotalAmountMinor: 2000n,
              documentDiscountAmountMinor: 0n,
              taxTotalAmountMinor: 0n,
              totalAmountMinor: 2000n,
              currencyCode: 'AED',
              currencyExponent: 2,
            },
          }),
        );
        deliberatelyIssuedOrderIds.add(d.id);
        const invoiceId = (
          await sql<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [d.id])
        )[0]!.id;

        // ── raw-seed the provider-backed Payment (no real adapter exists) ──
        const attemptId = await sql<{ id: string }>(
          `INSERT INTO payment_attempt
             (id,"tenantId","companyId","branchId","orderId","targetInvoiceId",method,"providerKey",
              "providerCredentialId","amountMinor","currencyCode","currencyExponent",state,
              "orderCommercialSnapshotFingerprintAtCreation","orderVersionAtCreation","idempotencyKey","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,'ONLINE_GATEWAY','tap',$6,2000,'AED',2,'CAPTURED','fp-seed',1,$7,now())
           RETURNING id`,
          [tenantA, coA, branchA, d.id, invoiceId, PROVIDER_CRED, `seed-attempt-${ik()}`],
        ).then((r) => r[0]!.id);
        const paymentId = await sql<{ id: string }>(
          `INSERT INTO payment
             (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey",
              "amountMinor","currencyCode","currencyExponent")
           VALUES (uuidv7(),$1,$2,$3,$4,'ONLINE_GATEWAY','tap',2000,'AED',2)
           RETURNING id`,
          [tenantA, coA, branchA, attemptId],
        ).then((r) => r[0]!.id);
        await sql(
          `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,2000,'AED',2)`,
          [tenantA, coA, branchA, paymentId, invoiceId],
        );
        // bypasses the real `recomputeInvoicePaymentStatusInTx` application
        // path (this fixture raw-seeds the Payment, never through a real
        // capture flow) — set directly to the SAME state that path would
        // have produced for a fully-covered Invoice.
        await sql(`UPDATE invoice SET "invoicePaymentStatus" = 'PAID' WHERE id = $1`, [invoiceId]);

        if (opts.settled) {
          // ONE explicit transaction (never the file's own one-shot `sql()`
          // helper, which auto-commits each statement individually) — the
          // journal_entry "must seal every entry it creates" deferred
          // constraint trigger fires at the END of the transaction that
          // created the entry, so the INSERT and its sealing UPDATE must
          // share the SAME transaction (mirrors `historical-settlement-
          // reconciliation.repository.integration.test.ts`'s own fixture
          // pattern exactly).
          const client = new pg.Client({ connectionString: stack.postgres.url });
          await client.connect();
          try {
            await client.query('BEGIN');
            const bankAcct = (
              await client.query(
                `SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.BANK'`,
                [coA],
              )
            ).rows[0].id;
            const clearingAcct = (
              await client.query(
                `SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.PAYMENT_CLEARING'`,
                [coA],
              )
            ).rows[0].id;
            const period = (
              await client.query(`SELECT id FROM accounting_period WHERE "companyId"=$1 LIMIT 1`, [
                coA,
              ])
            ).rows[0].id;
            const batchId = crypto.randomUUID();
            const je = crypto.randomUUID();
            await client.query(
              `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
               VALUES ($1,$2,$3,$4,'2026-06-01','SETTLEMENT_BATCH',$5,'AED',$6)`,
              [je, tenantA, coA, period, batchId, `fp-${je}`],
            );
            await client.query(
              `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,2000,0)`,
              [tenantA, coA, je, bankAcct, branchA],
            );
            await client.query(
              `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,0,2000)`,
              [tenantA, coA, je, clearingAcct, branchA],
            );
            await client.query(`UPDATE journal_entry SET "sealedAt"=now() WHERE id=$1`, [je]);
            const lineId = crypto.randomUUID();
            await client.query(
              `INSERT INTO settlement_batch
                 (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
                  "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor",
                  "currencyCode","currencyExponent")
               VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',2000,0,2000,'AED',2)`,
              [batchId, tenantA, coA, branchA, PROVIDER_CRED, `ext-${batchId.slice(0, 8)}`],
            );
            await client.query(
              `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
               VALUES ($1,$2,$3,$4,$5,2000,'AED',2,$6)`,
              [lineId, tenantA, coA, branchA, batchId, paymentId],
            );
            await client.query(
              `INSERT INTO settlement_application (id,"tenantId","companyId","branchId","batchId","lineId","paymentId","amountMinor","currencyCode","currencyExponent")
               VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,2000,'AED',2)`,
              [tenantA, coA, branchA, batchId, lineId, paymentId],
            );
            await client.query(
              `UPDATE settlement_batch SET state='FINALIZED', "journalEntryId"=$1, "finalizedAt"=now(), version=version+1 WHERE id=$2`,
              [je, batchId],
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            await client.end();
          }
        }

        const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [
          d.id,
        ]);
        const cancel = await req(
          'POST',
          ORD(coA, branchA, `/${d.id}/cancel`),
          cnOwner,
          { reason: 'provider-stub fixture setup' },
          { 'if-match': String(row[0]!.version) },
        );
        expect(cancel.statusCode, cancel.payload).toBe(200);

        const advRows = await sql<{ id: string }>(
          `SELECT ca.id FROM customer_advance ca
             JOIN credit_note_coverage_release r ON r."customerAdvanceId" = ca.id
            WHERE r."creditNoteId" = (SELECT cn.id FROM credit_note cn JOIN invoice i ON i.id = cn."invoiceId" WHERE i."orderId" = $1)`,
          [d.id],
        );
        return { customerId, advanceId: advRows[0]!.id, paymentId };
      }

      // ── helpers shared by the public-route and internal-foundation tests ──
      const idempotencyRowsFor = async (key: string): Promise<string> =>
        (
          await sql<{ c: string }>(
            `SELECT count(*)::text AS c FROM idempotency_key WHERE "key" = $1`,
            [key],
          )
        )[0]!.c;
      const refundScopeIdempotencyRows = async (): Promise<string> =>
        (
          await sql<{ c: string }>(
            `SELECT count(*)::text AS c FROM idempotency_key WHERE "scope" = 'receivables.refund'`,
          )
        )[0]!.c;
      const advanceRowsOf = async (customerId: string): Promise<{ n: string; total: string }> =>
        (
          await sql<{ n: string; total: string }>(
            `SELECT count(*)::text AS n, COALESCE(sum(ca."amountMinor"),0)::text AS total
               FROM customer_advance ca
               JOIN customer_company_account cca ON cca.id = ca."customerCompanyAccountId"
              WHERE cca."customerId" = $1`,
            [customerId],
          )
        )[0]!;

      /** Calls the INTERNAL reservation primitive directly — no public route
       *  reaches it (the route rejects provider methods before any DB work). */
      const reserveDirect = (input: {
        customerId: string;
        advanceId: string;
        amount: bigint;
        key: string;
      }) => {
        const repo = app.get(RefundAttemptReservationRepository);
        const db = app.get(DbService);
        return runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          repo.reserveProviderRefundAttemptInTx(tx, {
            tenantId: tenantA,
            companyId: coA,
            branchId: branchA,
            customerId: input.customerId,
            customerAdvanceId: input.advanceId,
            requestedAmountMinor: input.amount,
            idempotencyKey: input.key,
          }),
        );
      };
      /** Calls the INTERNAL confirmation-phase primitive directly — the
       *  future `getStatus`/webhook integration's entry point. */
      const applyDirect = (
        attemptId: string,
        resultState: 'SUCCEEDED' | 'FAILED',
        extra: { providerReference?: string | null; failureCode?: string } = {},
      ) => {
        const repo = app.get(RefundAttemptReservationRepository);
        const db = app.get(DbService);
        return runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          repo.applyProviderRefundAttemptResultInTx(tx, {
            tenantId: tenantA,
            companyId: coA,
            branchId: branchA,
            refundAttemptId: attemptId,
            resultState,
            providerReference: extra.providerReference ?? null,
            method: 'ONLINE_GATEWAY',
            reasonCode: 'CUSTOMER_REQUEST',
            accountingDate: '2026-06-15',
            actorUserId: null,
            ...(extra.failureCode ? { failureCode: extra.failureCode } : {}),
          }),
        );
      };

      // ══════════════ PUBLIC ROUTE — completely side-effect free ═════════════
      describe('public route: CARD_TERMINAL / ONLINE_GATEWAY are completely side-effect free', () => {
        it.each(['ONLINE_GATEWAY', 'CARD_TERMINAL'])(
          '%s → 501 REFUND_PROVIDER_NOT_IMPLEMENTED with ZERO DB side effects, even for a fully-settled provider-backed advance (the case that used to reserve a PENDING attempt)',
          async (method) => {
            const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
              settled: true,
            });
            const key = ik();
            const footprintBefore = await refundFootprint();
            const advancesBefore = await advanceRowsOf(customerId);
            const balanceBefore = await advanceBalanceOf(customerId);
            const idemBefore = await refundScopeIdempotencyRows();

            const res = await req(
              'POST',
              refundUrl(coA, branchA, customerId, advanceId),
              refundExecutor,
              { requestedAmountMinor: '500', method, reasonCode: 'CUSTOMER_REQUEST' },
              { 'idempotency-key': key },
            );
            expect(res.statusCode, res.payload).toBe(501);
            expect(errCode(res)).toBe('REFUND_PROVIDER_NOT_IMPLEMENTED');

            // ZERO RefundAttempt / reservation / Refund / application /
            // CustomerAccountEntry (any kind) / journal (any source) rows.
            expect(await refundFootprint()).toEqual(footprintBefore);
            // no advance mutation, no advance-balance mutation.
            expect(await advanceRowsOf(customerId)).toEqual(advancesBefore);
            expect(await advanceBalanceOf(customerId)).toBe(balanceBefore);
            // no idempotency-key reservation survives the rejected request
            // (`IdempotencyRepository.release` deletes the PENDING claim row).
            expect(await idempotencyRowsFor(key)).toBe('0');
            expect(await refundScopeIdempotencyRows()).toBe(idemBefore);
          },
        );

        it('repeated unsupported requests (same key and different keys, both methods) still leave zero rows and never poison the Idempotency-Key', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const url = refundUrl(coA, branchA, customerId, advanceId);
          const sharedKey = ik();
          const footprintBefore = await refundFootprint();
          const balanceBefore = await advanceBalanceOf(customerId);
          const idemBefore = await refundScopeIdempotencyRows();

          const attempts: [string, string][] = [
            ['ONLINE_GATEWAY', sharedKey],
            ['ONLINE_GATEWAY', sharedKey], // exact repeat
            ['CARD_TERMINAL', sharedKey], // same key, DIFFERENT body
            ['CARD_TERMINAL', ik()],
            ['ONLINE_GATEWAY', ik()],
          ];
          for (const [method, key] of attempts) {
            const res = await req(
              'POST',
              url,
              refundExecutor,
              { requestedAmountMinor: '500', method, reasonCode: 'CUSTOMER_REQUEST' },
              { 'idempotency-key': key },
            );
            // every repeat is the SAME clean 501 — never a replay and never an
            // IDEMPOTENCY_KEY_REUSED (the first request's claim was released
            // and nothing was stored under the key).
            expect(res.statusCode, res.payload).toBe(501);
            expect(errCode(res)).toBe('REFUND_PROVIDER_NOT_IMPLEMENTED');
            expect(res.headers['idempotency-replayed']).toBeUndefined();
          }
          expect(await refundFootprint()).toEqual(footprintBefore);
          expect(await advanceBalanceOf(customerId)).toBe(balanceBefore);
          expect(await refundScopeIdempotencyRows()).toBe(idemBefore);
          expect(await idempotencyRowsFor(sharedKey)).toBe('0');
        });

        it('the 501 does not depend on advance provenance or settlement — an UNSETTLED provider-backed advance and an OTHER_MANUAL-funded advance are both clean 501s with zero rows', async () => {
          const unsettled = await providerBackedCreditNoteAdvance({ settled: false });
          const manual = await creditNoteFundedAdvance();
          const footprintBefore = await refundFootprint();
          for (const f of [unsettled, manual]) {
            const res = await req(
              'POST',
              refundUrl(coA, branchA, f.customerId, f.advanceId),
              refundExecutor,
              {
                requestedAmountMinor: '500',
                method: 'ONLINE_GATEWAY',
                reasonCode: 'CUSTOMER_REQUEST',
              },
              { 'idempotency-key': ik() },
            );
            expect(res.statusCode, res.payload).toBe(501);
            expect(errCode(res)).toBe('REFUND_PROVIDER_NOT_IMPLEMENTED');
          }
          expect(await refundFootprint()).toEqual(footprintBefore);
        });

        it('the Idempotency-Key of a rejected provider request stays available — the SAME key then completes a legitimate CASH refund', async () => {
          const { customerId, advanceId } = await creditNoteFundedAdvance();
          const key = ik();
          const url = refundUrl(coA, branchA, customerId, advanceId);
          const rejected = await req(
            'POST',
            url,
            refundExecutor,
            {
              requestedAmountMinor: '500',
              method: 'ONLINE_GATEWAY',
              reasonCode: 'CUSTOMER_REQUEST',
            },
            { 'idempotency-key': key },
          );
          expect(rejected.statusCode, rejected.payload).toBe(501);
          const accepted = await req(
            'POST',
            url,
            refundExecutor,
            { requestedAmountMinor: '500', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
            { 'idempotency-key': key },
          );
          expect(accepted.statusCode, accepted.payload).toBe(201);
          expect(await advanceBalanceOf(customerId)).toBe('1500');
        });

        it('authorization is enforced BEFORE the provider-method rejection — no permission / no step-up gets 403, never a 501 capability probe', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const url = refundUrl(coA, branchA, customerId, advanceId);
          const body = {
            requestedAmountMinor: '500',
            method: 'ONLINE_GATEWAY',
            reasonCode: 'CUSTOMER_REQUEST',
          };
          const noPerm = await req('POST', url, refundNoPerm, body, { 'idempotency-key': ik() });
          expect(noPerm.statusCode).toBe(403);
          const noStepUp = await req('POST', url, refundNoStepUp, body, {
            'idempotency-key': ik(),
          });
          expect(noStepUp.statusCode).toBe(403);
          expect(errCode(noStepUp)).toBe('STEP_UP_REQUIRED');
        });
      });

      // ═════ INTERNAL FOUNDATION — directly exercised, no public route ═══════
      describe('internal RefundAttempt foundation (primitives exercised directly)', () => {
        it('the reservation primitive is BRANCH-scoped like every other branch-nested operation: an advance of branch A is unreachable from a reservation requested in sibling branch B (404 CUSTOMER_ADVANCE_NOT_FOUND) and nothing is created — while branch A itself reserves it', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const repo = app.get(RefundAttemptReservationRepository);
          const db = app.get(DbService);
          const reserveIn = (branchId: string, key: string) =>
            runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
              repo.reserveProviderRefundAttemptInTx(tx, {
                tenantId: tenantA,
                companyId: coA,
                branchId,
                customerId,
                customerAdvanceId: advanceId,
                requestedAmountMinor: 500n,
                idempotencyKey: key,
              }),
            );
          const before = await refundFootprint();
          await expect(reserveIn(branchB, ik())).rejects.toMatchObject({
            code: 'CUSTOMER_ADVANCE_NOT_FOUND',
            status: 404,
          });
          expect(await refundFootprint()).toEqual(before);
          const ok = await reserveIn(branchA, ik());
          expect(ok.state).toBe('PENDING');
        });

        it('a source Payment that is NOT fully settlement-final is rejected (PROVIDER_REFUND_REQUIRES_FULL_SETTLEMENT) and nothing is created', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: false,
          });
          const before = await refundFootprint();
          await expect(
            reserveDirect({ customerId, advanceId, amount: 500n, key: ik() }),
          ).rejects.toMatchObject({
            code: 'PROVIDER_REFUND_REQUIRES_FULL_SETTLEMENT',
            status: 409,
          });
          expect(await refundFootprint()).toEqual(before);
        });

        it('a non-provider-backed source Payment (OTHER_MANUAL origin) is rejected (REFUND_SOURCE_PAYMENT_NOT_PROVIDER_BACKED) — there is no credential to execute against', async () => {
          const { customerId, advanceId } = await creditNoteFundedAdvance();
          const before = await refundFootprint();
          await expect(
            reserveDirect({ customerId, advanceId, amount: 500n, key: ik() }),
          ).rejects.toMatchObject({
            code: 'REFUND_SOURCE_PAYMENT_NOT_PROVIDER_BACKED',
            status: 422,
          });
          expect(await refundFootprint()).toEqual(before);
        });

        it('a fully-settled provider-backed advance durably reserves ONE PENDING RefundAttempt bound to the ORIGINAL payment credential, and never creates a Refund', async () => {
          const { customerId, advanceId, paymentId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const reserved = await reserveDirect({ customerId, advanceId, amount: 500n, key: ik() });
          expect(reserved).toMatchObject({
            state: 'PENDING',
            reused: false,
            providerCredentialId: PROVIDER_CRED,
            providerKey: 'tap',
            sourcePaymentId: paymentId,
            requestedAmountMinor: 500n,
            currencyCode: 'AED',
            currencyExponent: 2,
          });

          const attempt = (
            await sql<{
              state: string;
              requestedAmountMinor: string;
              providerCredentialId: string;
              sourcePaymentId: string;
              resultingRefundId: string | null;
            }>(
              `SELECT state, "requestedAmountMinor"::text, "providerCredentialId", "sourcePaymentId", "resultingRefundId"
                 FROM refund_attempt WHERE id = $1`,
              [reserved.refundAttemptId],
            )
          )[0]!;
          expect(attempt).toEqual({
            state: 'PENDING',
            requestedAmountMinor: '500',
            providerCredentialId: PROVIDER_CRED,
            sourcePaymentId: paymentId,
            resultingRefundId: null,
          });
          const reservations = await sql<{ amountMinor: string; customerAdvanceId: string }>(
            `SELECT "amountMinor"::text, "customerAdvanceId" FROM refund_attempt_entitlement_reservation
              WHERE "refundAttemptId" = $1`,
            [reserved.refundAttemptId],
          );
          expect(reservations).toEqual([{ amountMinor: '500', customerAdvanceId: advanceId }]);
          const refunds = await sql<{ count: string }>(
            `SELECT count(*)::text AS count FROM refund WHERE "sourceRefundAttemptId" = $1`,
            [reserved.refundAttemptId],
          );
          expect(refunds[0]!.count).toBe('0');
        });

        it('replay: the SAME Idempotency-Key with the same semantics reuses the SAME attempt (reused=true, no second row)', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const key = ik();
          const first = await reserveDirect({ customerId, advanceId, amount: 500n, key });
          const second = await reserveDirect({ customerId, advanceId, amount: 500n, key });
          expect(first.reused).toBe(false);
          expect(second.reused).toBe(true);
          expect(second.refundAttemptId).toBe(first.refundAttemptId);
          const rows = await sql<{ count: string }>(
            `SELECT count(*)::text AS count FROM refund_attempt ra
               JOIN refund_attempt_entitlement_reservation rr ON rr."refundAttemptId" = ra.id
              WHERE rr."customerAdvanceId" = $1`,
            [advanceId],
          );
          expect(rows[0]!.count).toBe('1');
        });

        it('conflict: the SAME Idempotency-Key with a DIFFERENT amount is rejected (IDEMPOTENCY_KEY_REUSED) and the original attempt is untouched', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const key = ik();
          const first = await reserveDirect({ customerId, advanceId, amount: 500n, key });
          await expect(
            reserveDirect({ customerId, advanceId, amount: 600n, key }),
          ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
          const original = (
            await sql<{ state: string; requestedAmountMinor: string }>(
              `SELECT state, "requestedAmountMinor"::text FROM refund_attempt WHERE id = $1`,
              [first.refundAttemptId],
            )
          )[0]!;
          expect(original).toEqual({ state: 'PENDING', requestedAmountMinor: '500' });
        });

        it('concurrent identical reservations create exactly ONE economic attempt (advisory lock); the loser reuses it', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const key = ik();
          const settled = await Promise.allSettled([
            reserveDirect({ customerId, advanceId, amount: 500n, key }),
            reserveDirect({ customerId, advanceId, amount: 500n, key }),
          ]);
          const values = settled.map((r) => {
            if (r.status !== 'fulfilled')
              throw new Error(`unexpected rejection: ${String(r.reason)}`);
            return r.value;
          });
          expect(values.filter((v) => !v.reused)).toHaveLength(1);
          expect(values[0]!.refundAttemptId).toBe(values[1]!.refundAttemptId);
          const rows = await sql<{ count: string }>(
            `SELECT count(*)::text AS count FROM refund_attempt ra
               JOIN refund_attempt_entitlement_reservation rr ON rr."refundAttemptId" = ra.id
              WHERE rr."customerAdvanceId" = $1`,
            [advanceId],
          );
          expect(rows[0]!.count).toBe('1');
        });

        it('two DIFFERENT reservations racing for the same advance capacity: exactly one wins, the other is rejected for insufficient balance', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const settled = await Promise.allSettled([
            reserveDirect({ customerId, advanceId, amount: 2000n, key: ik() }),
            reserveDirect({ customerId, advanceId, amount: 2000n, key: ik() }),
          ]);
          const fulfilled = settled.filter((r) => r.status === 'fulfilled');
          const rejected = settled.filter((r) => r.status === 'rejected');
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
            code: 'REFUND_EXCEEDS_AVAILABLE_ADVANCE',
          });
          const rows = await sql<{ count: string }>(
            `SELECT count(*)::text AS count FROM refund_attempt_entitlement_reservation WHERE "customerAdvanceId" = $1`,
            [advanceId],
          );
          expect(rows[0]!.count).toBe('1');
        });

        it('a PENDING reservation holds capacity: it reduces what a LOCAL refund can draw, and is released again when the attempt FAILS', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const reserved = await reserveDirect({ customerId, advanceId, amount: 500n, key: ik() });
          const url = refundUrl(coA, branchA, customerId, advanceId);
          const local = (amount: string) =>
            req(
              'POST',
              url,
              refundExecutor,
              { requestedAmountMinor: amount, method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
              { 'idempotency-key': ik() },
            );

          // 2000 advance − 500 reserved = 1500 available to a local refund.
          const tooMuch = await local('1501');
          expect(tooMuch.statusCode, tooMuch.payload).toBe(409);
          expect(errCode(tooMuch)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');
          const exact = await local('1500');
          expect(exact.statusCode, exact.payload).toBe(201);
          // fully committed now (1500 refunded + 500 reserved): even 1 more is refused.
          const none = await local('1');
          expect(none.statusCode).toBe(409);
          expect(errCode(none)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');

          // the provider attempt FAILS → its 500 is released back to the advance.
          const failed = await applyDirect(reserved.refundAttemptId, 'FAILED', {
            failureCode: 'PROVIDER_DECLINED',
          });
          expect(failed.state).toBe('FAILED');
          const released = await local('500');
          expect(released.statusCode, released.payload).toBe(201);
          expect(await advanceBalanceOf(customerId)).toBe('0');
        });

        it('local refunds reduce what an internal reservation can claim', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const local = await req(
            'POST',
            refundUrl(coA, branchA, customerId, advanceId),
            refundExecutor,
            { requestedAmountMinor: '1500', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
            { 'idempotency-key': ik() },
          );
          expect(local.statusCode, local.payload).toBe(201);
          await expect(
            reserveDirect({ customerId, advanceId, amount: 600n, key: ik() }),
          ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_AVAILABLE_ADVANCE' });
          const ok = await reserveDirect({ customerId, advanceId, amount: 500n, key: ik() });
          expect(ok.state).toBe('PENDING');
        });

        it('recovery/reconciliation: a SUCCEEDED result creates the Refund + application + REFUND entry + GL exactly once, and a later conflicting result cannot flip it', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const reserved = await reserveDirect({ customerId, advanceId, amount: 500n, key: ik() });

          const applied = await applyDirect(reserved.refundAttemptId, 'SUCCEEDED', {
            providerReference: 'prov-ref-1',
          });
          expect(applied.state).toBe('SUCCEEDED');
          expect(applied.refundId).not.toBeNull();

          const refund = (
            await sql<{ method: string; amountMinor: string; sourceRefundAttemptId: string }>(
              `SELECT method, "amountMinor"::text, "sourceRefundAttemptId" FROM refund WHERE id = $1`,
              [applied.refundId],
            )
          )[0]!;
          expect(refund).toEqual({
            method: 'ONLINE_GATEWAY',
            amountMinor: '500',
            sourceRefundAttemptId: reserved.refundAttemptId,
          });
          const attempt = (
            await sql<{ state: string; resultingRefundId: string; providerReference: string }>(
              `SELECT state, "resultingRefundId", "providerReference" FROM refund_attempt WHERE id = $1`,
              [reserved.refundAttemptId],
            )
          )[0]!;
          expect(attempt).toEqual({
            state: 'SUCCEEDED',
            resultingRefundId: applied.refundId,
            providerReference: 'prov-ref-1',
          });

          const journalLines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
            `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
               FROM journal_line jl
               JOIN journal_entry je ON je.id = jl."journalEntryId"
               JOIN account a ON a.id = jl."accountId"
              WHERE je."sourceKind" = 'refund' AND je."sourceId" = $1
              ORDER BY a.key`,
            [applied.refundId],
          );
          expect(journalLines).toEqual([
            { key: 'ASSET.PAYMENT_CLEARING', debitMinor: '0', creditMinor: '500' },
            { key: 'LIABILITY.CUSTOMER_ADVANCES', debitMinor: '500', creditMinor: '0' },
          ]);
          const entries = await sql<{ count: string }>(
            `SELECT count(*)::text AS count FROM customer_account_entry
              WHERE "entryKind" = 'REFUND'
                AND "customerAdvanceRefundApplicationId" IN
                    (SELECT id FROM customer_advance_refund_application WHERE "refundId" = $1)`,
            [applied.refundId],
          );
          expect(entries[0]!.count).toBe('1');
          expect(await advanceBalanceOf(customerId)).toBe('1500');

          // replay of the SAME terminal result → idempotent no-op.
          const reapplied = await applyDirect(reserved.refundAttemptId, 'SUCCEEDED', {
            providerReference: 'prov-ref-1',
          });
          expect(reapplied).toMatchObject({ state: 'SUCCEEDED', refundId: applied.refundId });
          // a CONFLICTING later result (FAILED) can never flip a confirmed refund.
          const conflicting = await applyDirect(reserved.refundAttemptId, 'FAILED', {
            failureCode: 'LATE_DECLINE',
          });
          expect(conflicting).toMatchObject({ state: 'SUCCEEDED', refundId: applied.refundId });

          const refundRows = await sql<{ count: string }>(
            `SELECT count(*)::text AS count FROM refund WHERE "sourceRefundAttemptId" = $1`,
            [reserved.refundAttemptId],
          );
          expect(refundRows[0]!.count).toBe('1');
          expect(await advanceBalanceOf(customerId)).toBe('1500');
        });

        it('recovery/reconciliation: a FAILED result releases the reservation and creates no Refund', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const reserved = await reserveDirect({ customerId, advanceId, amount: 500n, key: ik() });
          const before = await refundFootprint();

          const applied = await applyDirect(reserved.refundAttemptId, 'FAILED', {
            failureCode: 'PROVIDER_DECLINED',
          });
          expect(applied).toMatchObject({ state: 'FAILED', refundId: null });
          const after = await refundFootprint();
          expect(after).toEqual(before); // FAILED touches no financial table
          const attempt = (
            await sql<{ state: string; failureCode: string; resultingRefundId: string | null }>(
              `SELECT state, "failureCode", "resultingRefundId" FROM refund_attempt WHERE id = $1`,
              [reserved.refundAttemptId],
            )
          )[0]!;
          expect(attempt).toEqual({
            state: 'FAILED',
            failureCode: 'PROVIDER_DECLINED',
            resultingRefundId: null,
          });
          expect(await advanceBalanceOf(customerId)).toBe('2000');

          // capacity released — a fresh local refund can use the FULL 2000.
          const cashRes = await req(
            'POST',
            refundUrl(coA, branchA, customerId, advanceId),
            refundExecutor,
            { requestedAmountMinor: '2000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
            { 'idempotency-key': ik() },
          );
          expect(cashRes.statusCode, cashRes.payload).toBe(201);
        });

        it('ProviderRefundEventInboxRepository dedups by (providerCredentialId, providerEventId) and detects a payload conflict', async () => {
          const inbox = app.get(ProviderRefundEventInboxRepository);
          const db = app.get(DbService);
          const providerEventId = `evt-${ik()}`;
          const first = await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
            inbox.insertVerifiedEventInTx(tx, {
              tenantId: tenantA,
              companyId: coA,
              branchId: branchA,
              providerCredentialId: PROVIDER_CRED,
              providerEventId,
              eventType: 'refund.succeeded',
              payloadHash: 'hash-a',
              providerReference: 'ref-1',
              targetState: 'SUCCEEDED',
            }),
          );
          expect(first.duplicate).toBe(false);

          const replay = await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
            inbox.insertVerifiedEventInTx(tx, {
              tenantId: tenantA,
              companyId: coA,
              branchId: branchA,
              providerCredentialId: PROVIDER_CRED,
              providerEventId,
              eventType: 'refund.succeeded',
              payloadHash: 'hash-a',
              providerReference: 'ref-1',
              targetState: 'SUCCEEDED',
            }),
          );
          expect(replay.duplicate).toBe(true);
          expect(replay.payloadConflict).toBe(false);
          expect(replay.inboxId).toBe(first.inboxId);

          const conflict = await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
            inbox.insertVerifiedEventInTx(tx, {
              tenantId: tenantA,
              companyId: coA,
              branchId: branchA,
              providerCredentialId: PROVIDER_CRED,
              providerEventId,
              eventType: 'refund.succeeded',
              payloadHash: 'hash-DIFFERENT',
              providerReference: 'ref-1',
              targetState: 'SUCCEEDED',
            }),
          );
          expect(conflict.duplicate).toBe(true);
          expect(conflict.payloadConflict).toBe(true);
        });
      });

      // ── task 3b.8 Integration Closure — canonical advance availability ────────
      // A PENDING provider-refund reservation holds advance capacity (the DB
      // `fn_lock_and_validate_advance_capacity` counts it) but does NOT move the
      // maintained `advanceBalanceMinor` projection until the refund completes.
      // The customer-account read model and CustomerAdvance application must
      // therefore treat it as consumed for AVAILABILITY and as NOT-yet-consumed
      // for the BOOKED figure the projection is reconciled against.
      describe('canonical advance availability with a PENDING reservation (integration closure)', () => {
        let readTok = '';
        let applyTok = '';
        beforeAll(async () => {
          readTok = await mintTenant('prov-canon-read', tenantA, ['receivables:view'], {
            branchScope: 'ALL',
          });
          applyTok = await mintTenant('prov-canon-apply', tenantA, ['receivables:advance:apply'], {
            branchScope: 'ALL',
          });
          // self-contained: a filtered `-t` run skips the sibling describe that
          // normally creates coA's wide-open accounting period (idempotent).
          await sql(
            `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
             VALUES (uuidv7(), $1, $2, '2020-01-01', '2030-12-31', 'OPEN', now())
             ON CONFLICT DO NOTHING`,
            [tenantA, coA],
          );
        });

        const acctUrl = (customerId: string): string =>
          `/companies/${coA}/branches/${branchA}/customers/${customerId}/account`;
        const readAdvances = async (
          customerId: string,
        ): Promise<
          {
            customerAdvanceId: string;
            originalAmountMinor: string;
            appliedAmountMinor: string;
            refundedAmountMinor: string;
            reservedAmountMinor: string;
            availableAmountMinor: string;
          }[]
        > => {
          const r = await req('GET', `${acctUrl(customerId)}/advances`, readTok);
          expect(r.statusCode, r.payload).toBe(200);
          return (r.json() as { data: never[] }).data;
        };
        const readSummary = async (
          customerId: string,
        ): Promise<{
          branchFinancials: { advanceAvailableMinor: string; openAdvanceCount: number };
          credit: { projectionIntegrity: { advanceProjectionMatches: boolean } };
        }> => {
          const r = await req('GET', `${acctUrl(customerId)}/summary`, readTok);
          expect(r.statusCode, r.payload).toBe(200);
          return r.json() as never;
        };
        /** a still-OPEN customer-linked invoice (2000) for `customerId`; returns
         *  its receivable id (the target an advance can be applied to). */
        async function openInvoiceReceivable(customerId: string): Promise<string> {
          const productId = await productIdFor(variantId);
          const created = await req(
            'POST',
            ORD(coA, branchA),
            ownerA,
            { lines: [basicLine({ productId })], customerId },
            { 'idempotency-key': ik() },
          );
          expect(created.statusCode, created.payload).toBe(201);
          const d = (created.json() as { order: { id: string } }).order;
          const g = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
          const gBody = g.json() as {
            order: { version: number; commercialSnapshotFingerprint: string };
            lines: { id: string }[];
          };
          const issuance = app.get(InvoiceIssuanceRepository);
          const db = app.get(DbService);
          await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
            issuance.issueFinalInvoice(tx, {
              tenantId: tenantA,
              companyId: coA,
              branchId: branchA,
              orderId: d.id,
              expectedVersion: gBody.order.version,
              commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
              paymentIntent: 'PAY_NOW',
              lines: [
                {
                  orderLineId: gBody.lines[0]!.id,
                  priceTaxMode: 'TAX_EXCLUSIVE',
                  roundingScope: 'LINE',
                  roundingMode: 'HALF_UP',
                  lineTaxAmountMinor: 0n,
                },
              ],
              totals: {
                subtotalAmountMinor: 2000n,
                documentDiscountAmountMinor: 0n,
                taxTotalAmountMinor: 0n,
                totalAmountMinor: 2000n,
                currencyCode: 'AED',
                currencyExponent: 2,
              },
            }),
          );
          deliberatelyIssuedOrderIds.add(d.id);
          return (
            await sql<{ id: string }>(
              `SELECT cr.id FROM customer_receivable cr JOIN invoice i ON i.id = cr."invoiceId" WHERE i."orderId" = $1`,
              [d.id],
            )
          )[0]!.id;
        }
        const applyOf = (
          customerId: string,
          advanceId: string,
          customerReceivableId: string,
          amountMinor: string,
        ) =>
          req(
            'POST',
            `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/${advanceId}/applications`,
            applyTok,
            { customerReceivableId, amountMinor },
            { 'idempotency-key': ik() },
          );

        it('a PENDING reservation reduces AVAILABLE everywhere (list, summary, application) but never the booked projection — integrity stays true', async () => {
          const { customerId, advanceId } = await providerBackedCreditNoteAdvance({
            settled: true,
          });
          const receivableId = await openInvoiceReceivable(customerId);
          await reserveDirect({ customerId, advanceId, amount: 500n, key: ik() });

          const list = await readAdvances(customerId);
          expect(list).toHaveLength(1);
          expect(list[0]).toMatchObject({
            customerAdvanceId: advanceId,
            originalAmountMinor: '2000',
            appliedAmountMinor: '0',
            refundedAmountMinor: '0',
            reservedAmountMinor: '500',
            availableAmountMinor: '1500',
          });
          const summary = await readSummary(customerId);
          expect(summary.branchFinancials.advanceAvailableMinor).toBe('1500');
          expect(summary.branchFinancials.openAdvanceCount).toBe(1);
          // the maintained projection is untouched by a reservation (still the
          // BOOKED 2000), and the read model reconciles against the BOOKED figure.
          expect(await advanceBalanceOf(customerId)).toBe('2000');
          expect(summary.credit.projectionIntegrity.advanceProjectionMatches).toBe(true);

          // application eligibility uses the same canonical figure: 1501 is a
          // clean business 409, 1500 (the full available) applies.
          const tooMuch = await applyOf(customerId, advanceId, receivableId, '1501');
          expect(tooMuch.statusCode, tooMuch.payload).toBe(409);
          expect(errCode(tooMuch)).toBe('CUSTOMER_ADVANCE_APPLICATION_INVALID');
          const exact = await applyOf(customerId, advanceId, receivableId, '1500');
          expect(exact.statusCode, exact.payload).toBe(201);
          expect((exact.json() as { remainingAdvanceMinor: string }).remainingAdvanceMinor).toBe(
            '0',
          );
          // 1500 applied + 500 reserved = fully consumed: nothing left to list
          expect(await readAdvances(customerId)).toHaveLength(0);
          // booked = 2000 - 1500 applied = 500 (the reservation still has not moved it)
          expect(await advanceBalanceOf(customerId)).toBe('500');
          expect(
            (await readSummary(customerId)).credit.projectionIntegrity.advanceProjectionMatches,
          ).toBe(true);
        });

        it('a FAILED attempt releases the reservation (available returns to 2000); a SUCCEEDED attempt completes the refund (booked + available both fall, integrity true)', async () => {
          const failedCase = await providerBackedCreditNoteAdvance({ settled: true });
          const failedAttempt = await reserveDirect({
            customerId: failedCase.customerId,
            advanceId: failedCase.advanceId,
            amount: 500n,
            key: ik(),
          });
          await applyDirect(failedAttempt.refundAttemptId, 'FAILED', {
            failureCode: 'PROVIDER_DECLINED',
          });
          const afterFail = await readAdvances(failedCase.customerId);
          expect(afterFail[0]).toMatchObject({
            reservedAmountMinor: '0',
            refundedAmountMinor: '0',
            availableAmountMinor: '2000',
          });

          const okCase = await providerBackedCreditNoteAdvance({ settled: true });
          const okAttempt = await reserveDirect({
            customerId: okCase.customerId,
            advanceId: okCase.advanceId,
            amount: 500n,
            key: ik(),
          });
          await applyDirect(okAttempt.refundAttemptId, 'SUCCEEDED', {
            providerReference: 'prov-ref-canon',
          });
          const afterOk = await readAdvances(okCase.customerId);
          expect(afterOk[0]).toMatchObject({
            reservedAmountMinor: '0',
            refundedAmountMinor: '500',
            availableAmountMinor: '1500',
          });
          expect(await advanceBalanceOf(okCase.customerId)).toBe('1500');
          const s = await readSummary(okCase.customerId);
          expect(s.branchFinancials.advanceAvailableMinor).toBe('1500');
          expect(s.credit.projectionIntegrity.advanceProjectionMatches).toBe(true);
        });
      });
    });
  });

  // ── SCOPE ─────────────────────────────────────────────────────────────────
  describe('scope isolation', () => {
    it('a Branch-A-scoped user cannot reach a Branch-B order (non-disclosing 404)', async () => {
      const productId = await productIdFor(variantId);
      const created = await req(
        'POST',
        ORD(coA, branchB),
        branchBUser,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      expect(created.statusCode, created.payload).toBe(201);
      const orderId = (created.json() as { order: { id: string } }).order.id;

      const wrongBranchRead = await req('GET', ORD(coA, branchA, `/${orderId}`), branchAUser);
      expect(wrongBranchRead.statusCode).toBe(404);

      const correctBranchRead = await req('GET', ORD(coA, branchB, `/${orderId}`), branchBUser);
      expect(correctBranchRead.statusCode, correctBranchRead.payload).toBe(200);
    });

    it('a cross-tenant caller cannot reach an order at all (different tenant session, route ids meaningless to it)', async () => {
      const productId = await productIdFor(variantId);
      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const orderId = (created.json() as { order: { id: string } }).order.id;
      const cross = await req('GET', ORD(coA, branchA, `/${orderId}`), tenantBUser);
      expect([403, 404]).toContain(cross.statusCode);
    });

    it('orders:view alone cannot create/patch/hold', async () => {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        viewOnlyA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode).toBe(403);
      expect(errCode(r)).toBe('MISSING_PERMISSION');
    });

    it('list is branch-scoped — a Branch-B user never sees a Branch-A order in the list', async () => {
      const productId = await productIdFor(variantId);
      await req(
        'POST',
        ORD(coA, branchA),
        branchAUser,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const listFromB = await req('GET', ORD(coA, branchB), branchBUser);
      expect(listFromB.statusCode, listFromB.payload).toBe(200);
      const ids = (listFromB.json() as { data: { originBranchId: string }[] }).data;
      for (const o of ids) expect(o.originBranchId).toBe(branchB);
    });
  });

  // ── CONCURRENCY (Checkpoint B hardening §13) ──────────────────────────────
  // Real parallel `app.inject()` calls racing the SAME row + SAME expected
  // version — proves the `SELECT ... FOR UPDATE` row lock, not merely
  // sequential simulation: exactly one mutation commits, the other observes a
  // deterministic conflict, never a partial write.
  describe('concurrency', () => {
    async function createDraft(): Promise<{ id: string; version: number; fingerprint: string }> {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const b = r.json() as {
        order: { id: string; version: number; commercialSnapshotFingerprint: string };
      };
      return {
        id: b.order.id,
        version: b.order.version,
        fingerprint: b.order.commercialSnapshotFingerprint,
      };
    }

    function outcomes(results: { statusCode: number }[]): {
      succeeded: number;
      conflicted: number;
    } {
      const succeeded = results.filter((r) => r.statusCode === 200).length;
      const conflicted = results.filter((r) => r.statusCode === 409).length;
      return { succeeded, conflicted };
    }

    it('PATCH vs PATCH, same version: exactly one succeeds, the other gets a deterministic version conflict', async () => {
      const d = await createDraft();
      const [r1, r2] = await Promise.all([
        req(
          'PATCH',
          ORD(coA, branchA, `/${d.id}`),
          ownerA,
          { documentDiscountMode: 'NONE' },
          { 'if-match': String(d.version) },
        ),
        req(
          'PATCH',
          ORD(coA, branchA, `/${d.id}`),
          ownerA,
          { customerId },
          { 'if-match': String(d.version) },
        ),
      ]);
      const { succeeded, conflicted } = outcomes([r1, r2]);
      expect(succeeded).toBe(1);
      expect(conflicted).toBe(1);
      const final = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
      expect((final.json() as { order: { version: number } }).order.version).toBe(d.version + 1);
    });

    it('PATCH vs HOLD, same version: exactly one succeeds, the other gets a deterministic conflict', async () => {
      const d = await createDraft();
      const [r1, r2] = await Promise.all([
        req(
          'PATCH',
          ORD(coA, branchA, `/${d.id}`),
          ownerA,
          { documentDiscountMode: 'NONE' },
          { 'if-match': String(d.version) },
        ),
        req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
          'if-match': String(d.version),
        }),
      ]);
      const { succeeded, conflicted } = outcomes([r1, r2]);
      expect(succeeded).toBe(1);
      expect(conflicted).toBe(1);
      const final = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
      expect((final.json() as { order: { version: number } }).order.version).toBe(d.version + 1);
    });

    it('HOLD vs HOLD, same version: exactly one succeeds, the other gets a deterministic conflict, order ends HELD exactly once', async () => {
      const d = await createDraft();
      const [r1, r2] = await Promise.all([
        req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
          'if-match': String(d.version),
        }),
        req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
          'if-match': String(d.version),
        }),
      ]);
      const { succeeded, conflicted } = outcomes([r1, r2]);
      expect(succeeded).toBe(1);
      expect(conflicted).toBe(1);
      const final = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
      const finalBody = final.json() as { order: { status: string; version: number } };
      expect(finalBody.order.status).toBe('HELD');
      expect(finalBody.order.version).toBe(d.version + 1);
    });

    it('RESUME vs PATCH on a HELD order, same version: RESUME wins or PATCH deterministically rejects — never a commercial edit while HELD', async () => {
      const d = await createDraft();
      const held = await req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
        'if-match': String(d.version),
      });
      const heldVersion = (held.json() as { version: number }).version;
      const [rResume, rPatch] = await Promise.all([
        req('POST', ORD(coA, branchA, `/${d.id}/resume`), ownerA, undefined, {
          'if-match': String(heldVersion),
        }),
        req(
          'PATCH',
          ORD(coA, branchA, `/${d.id}`),
          ownerA,
          { customerId },
          { 'if-match': String(heldVersion) },
        ),
      ]);
      // PATCH must NEVER succeed while the order is (or was, at lock time) HELD.
      expect(rPatch.statusCode).not.toBe(200);
      expect([409]).toContain(rPatch.statusCode);
      expect(rResume.statusCode).toBe(200);
      const final = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
      const finalBody = final.json() as { order: { status: string; version: number } };
      expect(finalBody.order.status).toBe('DRAFT');
      expect(finalBody.order.version).toBe(heldVersion + 1);
    });

    // ── D4 (Checkpoint D hard-gate) — real concurrency between an HTTP
    //    mutation and the internal (non-HTTP) issuance primitive, racing on
    //    the SAME Order row's `FOR UPDATE` lock. ───────────────────────────
    async function finalizedInputFor(orderId: string): Promise<{
      tenantId: string;
      companyId: string;
      branchId: string;
      orderId: string;
      expectedVersion: number;
      commercialSnapshotFingerprint: string;
      paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
      lines: {
        orderLineId: string;
        priceTaxMode: string;
        roundingScope: string;
        roundingMode: string;
        lineTaxAmountMinor: bigint;
      }[];
      totals: {
        subtotalAmountMinor: bigint;
        documentDiscountAmountMinor: bigint;
        taxTotalAmountMinor: bigint;
        totalAmountMinor: bigint;
        currencyCode: string;
        currencyExponent: number;
      };
    }> {
      const g = await req('GET', ORD(coA, branchA, `/${orderId}`), ownerA);
      const gBody = g.json() as {
        order: { version: number; commercialSnapshotFingerprint: string };
        lines: { id: string }[];
      };
      return {
        tenantId: tenantA,
        companyId: coA,
        branchId: branchA,
        orderId,
        expectedVersion: gBody.order.version,
        commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
        paymentIntent: 'PAY_NOW',
        lines: [
          {
            orderLineId: gBody.lines[0]!.id,
            priceTaxMode: 'TAX_EXCLUSIVE',
            roundingScope: 'LINE',
            roundingMode: 'HALF_UP',
            lineTaxAmountMinor: 0n,
          },
        ],
        totals: {
          subtotalAmountMinor: 1000n,
          documentDiscountAmountMinor: 0n,
          taxTotalAmountMinor: 0n,
          totalAmountMinor: 1000n,
          currencyCode: 'AED',
          currencyExponent: 2,
        },
      };
    }

    it('PATCH vs internal issuance, same version: exactly one wins; the other gets a deterministic conflict; no double Invoice', async () => {
      const d = await createDraft();
      const input = await finalizedInputFor(d.id);
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      const [patchRes, issueRes] = await Promise.allSettled([
        req(
          'PATCH',
          ORD(coA, branchA, `/${d.id}`),
          ownerA,
          { documentDiscountMode: 'NONE' },
          { 'if-match': String(d.version) },
        ),
        runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          issuance.issueFinalInvoice(tx, input),
        ),
      ]);
      const patchOk = patchRes.status === 'fulfilled' && patchRes.value.statusCode === 200;
      const issueOk = issueRes.status === 'fulfilled';
      if (issueOk) deliberatelyIssuedOrderIds.add(d.id);
      expect(patchOk).not.toBe(issueOk); // exactly one wins
      const final = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
      const finalBody = final.json() as {
        order: { status: string; orderNumber: string | null };
      };
      if (issueOk) {
        expect(finalBody.order.status).toBe('CONFIRMED');
        expect(finalBody.order.orderNumber).not.toBeNull();
      } else {
        expect(finalBody.order.status).toBe('DRAFT');
        expect(finalBody.order.orderNumber).toBeNull();
      }
      const invCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`,
        [d.id],
      );
      expect(Number(invCount[0]!.count)).toBe(issueOk ? 1 : 0);
    });

    it('HOLD vs internal issuance, same version: exactly one wins; the other gets a deterministic conflict; no double Invoice, no partial HELD+CONFIRMED state', async () => {
      const d = await createDraft();
      const input = await finalizedInputFor(d.id);
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      const [holdRes, issueRes] = await Promise.allSettled([
        req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
          'if-match': String(d.version),
        }),
        runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          issuance.issueFinalInvoice(tx, input),
        ),
      ]);
      const holdOk = holdRes.status === 'fulfilled' && holdRes.value.statusCode === 200;
      const issueOk = issueRes.status === 'fulfilled';
      if (issueOk) deliberatelyIssuedOrderIds.add(d.id);
      expect(holdOk).not.toBe(issueOk); // exactly one wins
      const final = await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA);
      const finalBody = final.json() as {
        order: { status: string; orderNumber: string | null };
      };
      if (issueOk) {
        expect(finalBody.order.status).toBe('CONFIRMED');
        expect(finalBody.order.orderNumber).not.toBeNull();
      } else {
        expect(finalBody.order.status).toBe('HELD');
        expect(finalBody.order.orderNumber).toBeNull();
      }
      const invCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`,
        [d.id],
      );
      expect(Number(invCount[0]!.count)).toBe(issueOk ? 1 : 0);
    });

    // Task 3b.4 Checkpoint E (§E4) — the SAME 3 official-mutation-path races
    // above, now targeting the NEW `TaxFinalizationService` wrapper directly
    // (not the raw `InvoiceIssuanceRepository` primitive) — real concurrent
    // Postgres transactions via `Promise.allSettled`, never sequential
    // simulation. The 3 tests above are retained UNCHANGED (§E4 instruction).
    async function finalizeVia(
      orderId: string,
      version: number,
      fingerprint: string,
    ): Promise<unknown> {
      const finalization = app.get(TaxFinalizationService);
      const db = app.get(DbService);
      return runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
        finalization.finalizeAndIssueInvoice(tx, {
          tenantId: tenantA,
          companyId: coA,
          branchId: branchA,
          orderId,
          expectedVersion: version,
          commercialSnapshotFingerprint: fingerprint,
          paymentIntent: 'PAY_NOW',
        }),
      );
    }

    it('E4-A. finalize vs finalize (via TaxFinalizationService): exactly one wins, no double Invoice, no duplicate numbering', async () => {
      const d = await createDraft();
      const [r1, r2] = await Promise.allSettled([
        finalizeVia(d.id, d.version, d.fingerprint),
        finalizeVia(d.id, d.version, d.fingerprint),
      ]);
      const outcomes = [r1, r2];
      const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
      if (fulfilled.length === 1) deliberatelyIssuedOrderIds.add(d.id);
      expect(fulfilled).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const invCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`,
        [d.id],
      );
      expect(Number(invCount[0]!.count)).toBe(1);
      const orderNumbers = await sql<{ orderNumber: string }>(
        `SELECT DISTINCT "orderNumber" FROM "order" WHERE id=$1 AND "orderNumber" IS NOT NULL`,
        [d.id],
      );
      expect(orderNumbers).toHaveLength(1);
    });

    it('E4-B. PATCH vs finalize (via TaxFinalizationService): exactly one wins, no partial finalized tax fields on the loser', async () => {
      const d = await createDraft();
      const [patchRes, issueRes] = await Promise.allSettled([
        req(
          'PATCH',
          ORD(coA, branchA, `/${d.id}`),
          ownerA,
          { documentDiscountMode: 'NONE' },
          { 'if-match': String(d.version) },
        ),
        finalizeVia(d.id, d.version, d.fingerprint),
      ]);
      const patchOk = patchRes.status === 'fulfilled' && patchRes.value.statusCode === 200;
      const issueOk = issueRes.status === 'fulfilled';
      if (issueOk) deliberatelyIssuedOrderIds.add(d.id);
      expect(patchOk).not.toBe(issueOk);
      const finalBody = (await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA)).json() as {
        order: { status: string; orderNumber: string | null };
        lines: { id: string }[];
      };
      if (issueOk) {
        expect(finalBody.order.status).toBe('CONFIRMED');
        expect(finalBody.order.orderNumber).not.toBeNull();
      } else {
        expect(finalBody.order.status).toBe('DRAFT');
        expect(finalBody.order.orderNumber).toBeNull();
        // the loser leaves no partially-written finalized tax field.
        const lineRows = await sql<{ lineTaxAmountMinor: string | null }>(
          `SELECT "lineTaxAmountMinor"::text AS "lineTaxAmountMinor" FROM order_line WHERE "orderId"=$1`,
          [d.id],
        );
        for (const r of lineRows) expect(r.lineTaxAmountMinor).toBeNull();
      }
      const invCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`,
        [d.id],
      );
      expect(Number(invCount[0]!.count)).toBe(issueOk ? 1 : 0);
    });

    it('E4-C. HOLD vs finalize (via TaxFinalizationService): exactly one wins, no partial HELD+CONFIRMED state', async () => {
      const d = await createDraft();
      const [holdRes, issueRes] = await Promise.allSettled([
        req('POST', ORD(coA, branchA, `/${d.id}/hold`), ownerA, undefined, {
          'if-match': String(d.version),
        }),
        finalizeVia(d.id, d.version, d.fingerprint),
      ]);
      const holdOk = holdRes.status === 'fulfilled' && holdRes.value.statusCode === 200;
      const issueOk = issueRes.status === 'fulfilled';
      if (issueOk) deliberatelyIssuedOrderIds.add(d.id);
      expect(holdOk).not.toBe(issueOk);
      const finalBody = (await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA)).json() as {
        order: { status: string; orderNumber: string | null };
      };
      if (issueOk) {
        expect(finalBody.order.status).toBe('CONFIRMED');
        expect(finalBody.order.orderNumber).not.toBeNull();
      } else {
        expect(finalBody.order.status).toBe('HELD');
        expect(finalBody.order.orderNumber).toBeNull();
      }
      const invCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`,
        [d.id],
      );
      expect(Number(invCount[0]!.count)).toBe(issueOk ? 1 : 0);
    });

    // Task 3b.8 Checkpoint C (§20) — cancel joins the SAME real-concurrent-
    // Postgres-transaction race matrix as PATCH/HOLD/RESUME/finalize above,
    // reusing this describe block's own `createDraft`/`finalizedInputFor`.
    it('§20-A. cancel vs cancel, same version: at most one successful transition, never a duplicate CANCELLED audit row', async () => {
      const d = await createDraft();
      const [r1, r2] = await Promise.allSettled([
        req(
          'POST',
          ORD(coA, branchA, `/${d.id}/cancel`),
          ownerA,
          { reason: 'race A' },
          { 'if-match': String(d.version) },
        ),
        req(
          'POST',
          ORD(coA, branchA, `/${d.id}/cancel`),
          ownerA,
          { reason: 'race B' },
          { 'if-match': String(d.version) },
        ),
      ]);
      const ok1 = r1.status === 'fulfilled' && r1.value.statusCode === 200;
      const ok2 = r2.status === 'fulfilled' && r2.value.statusCode === 200;
      expect(ok1).not.toBe(ok2); // exactly one succeeds
      const finalBody = (await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA)).json() as {
        order: { status: string; version: number };
      };
      expect(finalBody.order.status).toBe('CANCELLED');
      expect(finalBody.order.version).toBe(d.version + 1); // exactly one increment
      const auditCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log WHERE "resourceId"=$1 AND action='order.cancelled'`,
        [d.id],
      );
      expect(auditCount[0]!.count).toBe('1');
    });

    it('§20-B. no-charge cancel vs internal issuance, same version: exactly one economic outcome, never both', async () => {
      const d = await createDraft();
      const input = await finalizedInputFor(d.id);
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      const [cancelRes, issueRes] = await Promise.allSettled([
        req(
          'POST',
          ORD(coA, branchA, `/${d.id}/cancel`),
          ownerA,
          { reason: 'race vs issuance' },
          { 'if-match': String(d.version) },
        ),
        runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          issuance.issueFinalInvoice(tx, input),
        ),
      ]);
      const cancelOk = cancelRes.status === 'fulfilled' && cancelRes.value.statusCode === 200;
      const issueOk = issueRes.status === 'fulfilled';
      if (issueOk) deliberatelyIssuedOrderIds.add(d.id);
      expect(cancelOk).not.toBe(issueOk); // exactly one economic outcome
      const finalBody = (await req('GET', ORD(coA, branchA, `/${d.id}`), ownerA)).json() as {
        order: { status: string; orderNumber: string | null };
      };
      if (issueOk) {
        expect(finalBody.order.status).toBe('CONFIRMED');
        expect(finalBody.order.orderNumber).not.toBeNull();
      } else {
        expect(finalBody.order.status).toBe('CANCELLED');
        expect(finalBody.order.orderNumber).toBeNull();
      }
      const invCount = await sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM invoice WHERE "orderId"=$1`,
        [d.id],
      );
      expect(Number(invCount[0]!.count)).toBe(issueOk ? 1 : 0);
    });
  });

  // ── STRUCTURAL NON-SCOPE ──────────────────────────────────────────────────
  describe('structural non-scope', () => {
    it('no public confirm route exists', async () => {
      const productId = await productIdFor(variantId);
      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const orderId = (created.json() as { order: { id: string } }).order.id;
      const confirm = await req('POST', ORD(coA, branchA, `/${orderId}/confirm`), ownerA);
      expect(confirm.statusCode).toBe(404);
    });

    it('no order acquires orderNumber except via a deliberately-exercised internal issuance primitive test; no journal_entry exists', async () => {
      // Checkpoint C's internal primitive is intentionally exercised by a few
      // controlled, non-HTTP tests in this file (tracked in
      // `deliberatelyIssuedOrderIds`) — this proves there is no OTHER path
      // (i.e. no public API leak) that can ever number an order: every
      // numbered order's id must be one of the deliberate ones, and the
      // count must match exactly (no leak inflates it further).
      const rows = await sql<{ id: string }>(
        `SELECT id FROM "order" WHERE "orderNumber" IS NOT NULL`,
      );
      expect(rows.map((r) => r.id).sort()).toEqual([...deliberatelyIssuedOrderIds].sort());
      // `sourceKind = 'cancellation_charge'` entries are a SECOND, equally
      // legitimate GL-posting producer as of Task 3b.8 Checkpoint C — created
      // by the real, authorized, publicly-reachable `POST /orders/:id/cancel`
      // charge path (never a leak) — `credit_note`/`refund` entries (task
      // 3b.8 Checkpoint D) are the SAME category: `credit_note` from the same
      // `POST /orders/:id/cancel` route's post-invoice branch, `refund` from
      // the real, authorized `POST .../advances/:id/refunds` route exercised
      // by this checkpoint's own refund tests. `customer_receipt_payment`/
      // `payment_allocation` entries (task 3b.6) are ALSO the same category —
      // the real, authorized `POST .../customers/:id/receipts` route.
      // Task 3b.8 Integration Closure adds two more producers of that SAME
      // category, both exercised by the closure tests below through their real,
      // authorized routes: `customer_advance_application` (task 3b.6
      // `POST .../advances/:id/applications` — a CREDIT_NOTE advance applied to
      // an invoice / a charge receivable) and
      // `cancellation_charge_payment_application` (the receipts route settling
      // a CancellationCharge receivable).
      // `SETTLEMENT_BATCH` entries are raw-seeded ONLY by this checkpoint's
      // own provider-stub-foundation test fixture (`providerBackedCreditNoteAdvance`'s
      // `settled: true` branch), simulating what Task 3b.7's real settlement
      // finalization produces — unrelated to Order numbering entirely (it
      // never touches `order.orderNumber`), so it needs no order-id
      // cross-check either. None of these eight need an order-id cross-check
      // here. `sourceKind = 'invoice_ar'` entries (sourceId = invoiceId)
      // remain the invoice-issuance primitive's own output — not every
      // deliberately-issued order produces one (e.g. a walk-in/cash order has
      // no customer AR to post), so this checks a SUBSET relationship: every
      // invoice_ar entry's order must be one of the deliberate ones (no
      // public-route leak), never the reverse. No other sourceKind may exist.
      const nonChargeKinds = await sql<{ sourceKind: string }>(
        `SELECT DISTINCT "sourceKind" FROM "journal_entry"
          WHERE "sourceKind" NOT IN
                ('cancellation_charge', 'credit_note', 'customer_receipt_payment', 'payment_allocation',
                 'refund', 'SETTLEMENT_BATCH', 'customer_advance_application',
                 'cancellation_charge_payment_application')`,
      );
      expect(nonChargeKinds.map((r) => r.sourceKind)).toEqual(
        nonChargeKinds.length > 0 ? ['invoice_ar'] : [],
      );
      const invoiceOrderIds = (
        await sql<{ orderId: string }>(
          `SELECT DISTINCT i."orderId" AS "orderId"
             FROM "journal_entry" je
             JOIN invoice i ON i.id = je."sourceId"::uuid
            WHERE je."sourceKind" = 'invoice_ar'`,
        )
      ).map((r) => r.orderId);
      for (const orderId of invoiceOrderIds) {
        expect(deliberatelyIssuedOrderIds.has(orderId)).toBe(true);
      }
    });

    // Task 3b.4 Checkpoint C (§C17) — the fiscal-policy fields + fingerprint
    // version are server-resolved ONLY; a client can never supply, override,
    // or bypass them via either create or PATCH body (`.strict()` rejects the
    // unknown field before any handler code runs).
    it('a client-supplied taxPriceMode/taxRoundingScope/taxRoundingMode/commercialSnapshotFingerprintVersion on create is rejected (400, unknown field)', async () => {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [basicLine({ productId, quantity: '1' })],
          taxPriceMode: 'TAX_INCLUSIVE',
          taxRoundingScope: 'DOCUMENT',
          taxRoundingMode: 'HALF_EVEN',
          commercialSnapshotFingerprintVersion: 1,
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode).toBe(400);
    });

    it('a client-supplied taxPriceMode on PATCH is rejected (400, unknown field) — PATCH never re-resolves policy', async () => {
      const productId = await productIdFor(variantId);
      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const body = created.json() as { order: { id: string; version: number } };
      const patched = await req(
        'PATCH',
        ORD(coA, branchA, `/${body.order.id}`),
        ownerA,
        { taxPriceMode: 'TAX_INCLUSIVE' },
        { 'if-match': String(body.order.version) },
      );
      expect(patched.statusCode).toBe(400);
    });
  });

  // ── TAX-REFERENCE CIVIL-DATE DERIVATION (Checkpoint B hardening §1-§3) ────
  // Proves the ACTUAL wiring — not just `derivePostingDate`'s own unit-level
  // correctness (already proven in task 3b.1) — passes the Company civil
  // date to `TaxResolutionService.resolve`, never a UTC truncation, never
  // Branch/POS/client date. A fixed instant is chosen where the UTC calendar
  // date and the Asia/Dubai (UTC+4) civil date genuinely differ (22:00 UTC on
  // day N is 02:00 on day N+1 in Dubai), and a `tax_rate` row is scoped to be
  // in force ONLY from day N+1 — so the resolved `rateBps` is a deterministic,
  // unambiguous witness of which civil date actually reached the service.
  describe('tax-reference civil-date derivation (Checkpoint B hardening)', () => {
    let app2: NestFastifyApplication;
    let dateVariantId = '';
    const FIXED_INSTANT = new Date('2026-01-01T22:00:00.000Z'); // UTC day = Jan 1; Dubai (+4) day = Jan 2

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SystemClock)
        .useValue({ now: (): Date => FIXED_INSTANT } satisfies Clock)
        .compile();
      app2 = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app2.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
      app2.useGlobalFilters(new AllExceptionsFilter());
      installRequestContext(app2.getHttpAdapter().getInstance());
      await app2.init();
      await app2.getHttpAdapter().getInstance().ready();

      // a tax_rate for STANDARD/AE effective ONLY from Jan 2 onward — if the
      // UTC date (Jan 1) were wrongly used, no rate would be in force yet.
      await sql(
        `INSERT INTO tax_category (key, "nameEn", "nameAr") VALUES ('STANDARD_3B3', 'Standard', 'x')
         ON CONFLICT (key) DO NOTHING`,
      );
      await sql(
        `INSERT INTO tax_rate (id, "countryCode", "taxCategoryKey", "rateBps", "effectiveFrom")
         VALUES (uuidv7(), 'AE', 'STANDARD_3B3', 500, '2026-01-02')`,
      );
      dateVariantId = await mkVariant(ownerA, 'tulip', { base: 'piece' });
      await companyPrice(coA, dateVariantId, [{ uomCode: 'piece', sell: money('1000', 'AED', 2) }]);
      const dateProductId = await productIdFor(dateVariantId);
      await sql(`UPDATE product SET "taxCategoryKey" = 'STANDARD_3B3' WHERE id = $1`, [
        dateProductId,
      ]);
    }, 120_000);

    afterAll(async () => {
      await app2?.close();
    });

    const req2 = (
      method: 'POST',
      url: string,
      token: string | null,
      body?: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) =>
      app2.inject({
        method,
        url: `/v1${url}`,
        ...(token ? { headers: { authorization: `Bearer ${token}`, ...headers } } : { headers }),
        ...(body ? { payload: body } : {}),
      });

    it('resolves tax reference against the Company (Asia/Dubai) civil date, not the UTC calendar date', async () => {
      const dateProductId = await productIdFor(dateVariantId);
      const r = await req2(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            {
              productId: dateProductId,
              variantId: dateVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const line = (
        r.json() as { lines: { rateBps: number | null; taxCategoryKey: string | null }[] }
      ).lines[0]!;
      // proves the Dubai civil date (Jan 2) reached TaxResolutionService — the
      // UTC date (Jan 1) would have produced rateBps: null (NO_RATE_FOR_CATEGORY).
      expect(line.taxCategoryKey).toBe('STANDARD_3B3');
      expect(line.rateBps).toBe(500);
    });

    it('a company with no accountingTimezone configured fails closed (never silently falls back to UTC)', async () => {
      const bareCo = await sql<{ id: string }>(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","updatedAt")
         VALUES (uuidv7(),$1,'No TZ Co','AE','AED',now()) RETURNING id`,
        [tenantA],
      );
      const bareBranch = await sql<{ id: string }>(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
         VALUES (uuidv7(),$1,$2,'No TZ Branch',now()) RETURNING id`,
        [tenantA, bareCo[0]!.id],
      );
      const dateProductId = await productIdFor(dateVariantId);
      const r = await req2(
        'POST',
        ORD(bareCo[0]!.id, bareBranch[0]!.id),
        ownerA,
        {
          lines: [
            {
              productId: dateProductId,
              variantId: dateVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(409);
      expect(errCode(r)).toBe('ORDER_COMPANY_ACCOUNTING_TIMEZONE_NOT_CONFIGURED');
    });
  });

  // ── INVOICE READ (Checkpoint C) ───────────────────────────────────────────
  // Uses the internal `InvoiceIssuanceRepository` directly (never through
  // HTTP — no confirm/finalize route exists) to produce one real issued
  // Invoice against this suite's own app/DI container, then proves the READ
  // route's scope/security exactly like every other Order route.
  // ── line ordering / positional fingerprint (Checkpoint C final-hardening
  //    §1) — persisted linePosition, deterministic read order, PATCH-
  //    replacement re-numbering, reversed-line fingerprint distinctness, and
  //    fingerprint recompute-from-persisted-rows equality independent of DB
  //    read order. ──────────────────────────────────────────────────────────
  describe('line ordering / positional fingerprint (Checkpoint C final-hardening §1)', () => {
    it('persisted linePosition follows the submitted order (A), and GET returns it deterministically (B)', async () => {
      const p1 = await productIdFor(variantId);
      const p2 = await productIdFor(variantId2);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({ productId: p1, variantId, quantity: '1' }),
            basicLine({ productId: p2, variantId: variantId2, quantity: '2' }),
          ],
        },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const body = r.json() as {
        order: { id: string };
        lines: { linePosition: number; variantId: string }[];
      };
      expect(body.lines.map((l) => l.variantId)).toEqual([variantId, variantId2]);
      expect(body.lines.map((l) => l.linePosition)).toEqual([1, 2]);

      const g = await req('GET', ORD(coA, branchA, `/${body.order.id}`), ownerA);
      expect(g.statusCode, g.payload).toBe(200);
      const gBody = g.json() as { lines: { linePosition: number; variantId: string }[] };
      expect(gBody.lines.map((l) => l.variantId)).toEqual([variantId, variantId2]);
      expect(gBody.lines.map((l) => l.linePosition)).toEqual([1, 2]);
    });

    it('a full-line-replacement PATCH regenerates deterministic new positions in the new order (C)', async () => {
      const p1 = await productIdFor(variantId);
      const p2 = await productIdFor(variantId2);
      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId: p1, variantId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const b = created.json() as { order: { id: string; version: number } };
      const patched = await req(
        'PATCH',
        ORD(coA, branchA, `/${b.order.id}`),
        ownerA,
        {
          lines: [
            basicLine({ productId: p2, variantId: variantId2, quantity: '3' }),
            basicLine({ productId: p1, variantId, quantity: '1' }),
          ],
        },
        { 'if-match': String(b.order.version) },
      );
      expect(patched.statusCode, patched.payload).toBe(200);
      const pBody = patched.json() as { lines: { linePosition: number; variantId: string }[] };
      expect(pBody.lines.map((l) => l.variantId)).toEqual([variantId2, variantId]);
      expect(pBody.lines.map((l) => l.linePosition)).toEqual([1, 2]);
    });

    it('two otherwise-identical orders with reversed lines produce distinct fingerprints (D)', async () => {
      const p1 = await productIdFor(variantId);
      const p2 = await productIdFor(variantId2);
      const rA = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({ productId: p1, variantId, quantity: '1' }),
            basicLine({ productId: p2, variantId: variantId2, quantity: '1' }),
          ],
        },
        { 'idempotency-key': ik() },
      );
      const rB = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({ productId: p2, variantId: variantId2, quantity: '1' }),
            basicLine({ productId: p1, variantId, quantity: '1' }),
          ],
        },
        { 'idempotency-key': ik() },
      );
      const fpA = (rA.json() as { order: { commercialSnapshotFingerprint: string } }).order
        .commercialSnapshotFingerprint;
      const fpB = (rB.json() as { order: { commercialSnapshotFingerprint: string } }).order
        .commercialSnapshotFingerprint;
      expect(fpA).not.toBe(fpB);
    });

    it('recomputing the fingerprint from persisted rows in linePosition order equals the stored value, independent of DB read order (E, F)', async () => {
      const p1 = await productIdFor(variantId);
      const p2 = await productIdFor(variantId2);
      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        {
          lines: [
            basicLine({ productId: p1, variantId, quantity: '2' }),
            basicLine({ productId: p2, variantId: variantId2, quantity: '1' }),
          ],
        },
        { 'idempotency-key': ik() },
      );
      const body = created.json() as {
        order: { id: string; commercialSnapshotFingerprint: string };
      };

      // deliberately read in a DB-arbitrary order (id DESC, NOT linePosition)
      // — proves the RECOMPUTE (sorting by linePosition below), not the raw
      // read order, is what makes this deterministic (F).
      const rows = await sql<{
        linePosition: number;
        productId: string;
        variantId: string;
        quantity: string;
        selectedUomCode: string;
        baseUomCode: string;
        conversionNumerator: string;
        conversionDenominator: string;
        unitPriceAmountMinor: string;
        unitPriceCurrencyCode: string;
        unitPriceCurrencyExponent: number;
        discountMode: string;
        discountBps: number | null;
        discountAmountMinor: string;
        taxCategoryKey: string | null;
        rateBps: number | null;
        effectiveFrom: string | null;
        resolutionSource: string;
      }>(
        `SELECT "linePosition","productId","variantId",quantity::text AS quantity,
                "selectedUomCode","baseUomCode",
                "conversionNumerator"::text AS "conversionNumerator",
                "conversionDenominator"::text AS "conversionDenominator",
                "unitPriceAmountMinor"::text AS "unitPriceAmountMinor",
                "unitPriceCurrencyCode","unitPriceCurrencyExponent",
                "discountMode","discountBps","discountAmountMinor"::text AS "discountAmountMinor",
                "taxCategoryKey","rateBps",
                to_char("effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom","resolutionSource"
           FROM order_line WHERE "orderId" = $1 ORDER BY id DESC`,
        [body.order.id],
      );
      const orderRow = (
        await sql<{
          originBranchId: string;
          fulfillingBranchId: string;
          customerId: string | null;
          kind: string;
          currencyCode: string;
          documentDiscountMode: string;
          documentDiscountBps: number | null;
          documentDiscountAmountMinor: string;
          documentDiscountReason: string | null;
          commercialSnapshotFingerprintVersion: number;
          taxPriceMode: string;
          taxRoundingScope: string;
          taxRoundingMode: string;
        }>(
          `SELECT "originBranchId","fulfillingBranchId","customerId",kind,"currencyCode",
                  "documentDiscountMode","documentDiscountBps",
                  "documentDiscountAmountMinor"::text AS "documentDiscountAmountMinor",
                  "documentDiscountReason","commercialSnapshotFingerprintVersion",
                  "taxPriceMode","taxRoundingScope","taxRoundingMode"
             FROM "order" WHERE id = $1`,
          [body.order.id],
        )
      )[0]!;
      const sorted = [...rows].sort((a, b) => a.linePosition - b.linePosition);
      const recomputed = computeCommercialSnapshotFingerprintByVersion(
        orderRow.commercialSnapshotFingerprintVersion,
        {
          tenantId: tenantA,
          companyId: coA,
          originBranchId: orderRow.originBranchId,
          fulfillingBranchId: orderRow.fulfillingBranchId,
          customerId: orderRow.customerId,
          kind: orderRow.kind,
          currencyCode: orderRow.currencyCode,
          lines: sorted.map((l) => ({
            productId: l.productId,
            variantId: l.variantId,
            quantity: l.quantity,
            selectedUomCode: l.selectedUomCode,
            baseUomCode: l.baseUomCode,
            conversionNumerator: l.conversionNumerator,
            conversionDenominator: l.conversionDenominator,
            unitPriceAmountMinor: l.unitPriceAmountMinor,
            unitPriceCurrencyCode: l.unitPriceCurrencyCode,
            unitPriceCurrencyExponent: l.unitPriceCurrencyExponent,
            discountMode: l.discountMode,
            discountBps: l.discountBps,
            discountAmountMinor: l.discountAmountMinor,
            taxCategoryKey: l.taxCategoryKey,
            rateBps: l.rateBps,
            effectiveFrom: l.effectiveFrom,
            resolutionSource: l.resolutionSource,
          })),
          documentDiscountMode: orderRow.documentDiscountMode,
          documentDiscountBps: orderRow.documentDiscountBps,
          documentDiscountAmountMinor: orderRow.documentDiscountAmountMinor,
          documentDiscountReason: orderRow.documentDiscountReason,
        },
        {
          taxPriceMode: orderRow.taxPriceMode,
          taxRoundingScope: orderRow.taxRoundingScope,
          taxRoundingMode: orderRow.taxRoundingMode,
        },
      );
      expect(recomputed).toBe(body.order.commercialSnapshotFingerprint);
    });
  });

  describe('Invoice read (Checkpoint C)', () => {
    let issuedOrderId = '';
    let issuedInvoiceId = '';

    beforeAll(async () => {
      const productId = await productIdFor(variantId);
      const created = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId, quantity: '1' })] },
        { 'idempotency-key': ik() },
      );
      const body = created.json() as {
        order: { id: string; version: number; commercialSnapshotFingerprint: string };
        lines: { id: string }[];
      };
      issuedOrderId = body.order.id;
      deliberatelyIssuedOrderIds.add(issuedOrderId);

      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      const result = await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
        issuance.issueFinalInvoice(tx, {
          tenantId: tenantA,
          companyId: coA,
          branchId: branchA,
          orderId: body.order.id,
          expectedVersion: body.order.version,
          commercialSnapshotFingerprint: body.order.commercialSnapshotFingerprint,
          paymentIntent: 'PAY_NOW',
          lines: [
            {
              orderLineId: body.lines[0]!.id,
              priceTaxMode: 'TAX_EXCLUSIVE',
              roundingScope: 'LINE',
              roundingMode: 'HALF_UP',
              lineTaxAmountMinor: 0n,
            },
          ],
          totals: {
            subtotalAmountMinor: 1000n,
            documentDiscountAmountMinor: 0n,
            taxTotalAmountMinor: 0n,
            totalAmountMinor: 1000n,
            currencyCode: 'AED',
            currencyExponent: 2,
          },
        }),
      );
      issuedInvoiceId = result.invoiceId;
    });

    it('orders:view can read the Invoice from the correct company/branch', async () => {
      const r = await req(
        'GET',
        `/companies/${coA}/branches/${branchA}/invoices/${issuedInvoiceId}`,
        ownerA,
      );
      expect(r.statusCode, r.payload).toBe(200);
      const inv = r.json() as { orderId: string; branchId: string };
      expect(inv.orderId).toBe(issuedOrderId);
      expect(inv.branchId).toBe(branchA);
    });

    it('a different Branch, Company, or Tenant gets a non-disclosing not-found', async () => {
      const wrongBranch = await req(
        'GET',
        `/companies/${coA}/branches/${branchB}/invoices/${issuedInvoiceId}`,
        ownerA,
      );
      expect(wrongBranch.statusCode).toBe(404);

      const wrongCompany = await req(
        'GET',
        `/companies/${coA2}/branches/${branchA}/invoices/${issuedInvoiceId}`,
        ownerA,
      );
      expect(wrongCompany.statusCode).toBe(404);

      const wrongTenant = await req(
        'GET',
        `/companies/${coA}/branches/${branchA}/invoices/${issuedInvoiceId}`,
        tenantBUser,
      );
      expect([403, 404]).toContain(wrongTenant.statusCode);
    });

    it('orders:view alone is sufficient (no invoices:* permission exists); a caller with neither permission is denied', async () => {
      const noPerm = await mintTenant('inv-noperm', tenantA, []);
      const r = await req(
        'GET',
        `/companies/${coA}/branches/${branchA}/invoices/${issuedInvoiceId}`,
        noPerm,
      );
      expect(r.statusCode).toBe(403);
    });

    it('no Invoice write route exists', async () => {
      const post = await req('POST', `/companies/${coA}/branches/${branchA}/invoices`, ownerA, {});
      expect(post.statusCode).toBe(404);
    });
  });

  // ── INTEGRATION CLOSURE (task 3b.8) ─────────────────────────────────────────
  // Post-Checkpoint-C/D inspection found genuine integration defects between
  // the new 3b.8 financial artifacts (a CancellationCharge-sourced
  // CustomerReceivable, a CreditNote's invoice AR reduction, a CREDIT_NOTE-
  // sourced CustomerAdvance, a Refund) and the existing 3b.6 customer-account
  // read model, FIFO receipt collection and CustomerAdvance application. Every
  // test below reproduces ONE diagnosed defect at the real HTTP layer (or, for
  // the PENDING-reservation case, through the real internal primitive) and was
  // written — and observed RED for its diagnosed reason — BEFORE any production
  // change. Fixtures use only the real production paths (the public cancel /
  // receipt / refund / advance-application routes + the internal invoice
  // issuance primitive); nothing is raw-seeded except where a fixture needs a
  // financial FACT no public route can create.
  describe('integration closure (task 3b.8): receivables flows x CancellationCharge / CreditNote / Refund', () => {
    let closureTok = ''; // every permission the scenarios need + a fresh step-up
    let payTok = ''; // `payments:collect` only — the DIRECT invoice-payment route
    let openingTok = ''; // `receivables:opening_balance:manage` + a fresh step-up

    interface SummaryBody {
      branchFinancials: {
        receivableOutstandingMinor: string;
        advanceAvailableMinor: string;
        unappliedReceiptMinor: string;
        openReceivableCount: number;
        openAdvanceCount: number;
      };
      credit: {
        creditExposureMinor: string;
        projectionIntegrity: {
          receivableProjectionMatches: boolean;
          advanceProjectionMatches: boolean;
        };
      };
    }
    interface ReceivableBody {
      customerReceivableId: string;
      sourceType: string;
      invoiceId: string | null;
      invoiceNumber: string | null;
      cancellationChargeId: string | null;
      cancellationChargeNumber: string | null;
      sourceDate: string;
      originalAmountMinor: string;
      paidByPaymentMinor: string;
      paidByAdvanceMinor: string;
      outstandingMinor: string;
      currencyCode: string;
      currencyExponent: number;
      openingEffectiveDate: string | null;
      openingNote: string | null;
      ageDays: number;
    }
    interface AdvanceBody {
      customerAdvanceId: string;
      sourceType: string;
      sourcePaymentId: string | null;
      originalAmountMinor: string;
      appliedAmountMinor: string;
      refundedAmountMinor: string;
      reservedAmountMinor: string;
      availableAmountMinor: string;
    }
    interface StatementLineBody {
      customerAccountEntryId: string;
      entryKind: string;
      financialDate: string;
      receivableEffectMinor: string;
      advanceEffectMinor: string;
      unappliedReceiptEffectMinor: string;
      refs: Record<string, string | null>;
    }
    interface StatementBody {
      data: StatementLineBody[];
      nextCursor: string | null;
      openingState: {
        asOfDate: string;
        receivableOutstandingMinor: string;
        advanceAvailableMinor: string;
        unappliedReceiptMinor: string;
      } | null;
    }

    beforeAll(async () => {
      closureTok = await mintTenant(
        'closure',
        tenantA,
        [
          ...ORDER_PERMS,
          'cancellation_charges:issue',
          'credit_notes:issue',
          'refunds:execute',
          'receivables:view',
          'receivables:collect',
          'receivables:advance:apply',
        ],
        { branchScope: 'ALL', stepUp: true },
      );
      payTok = await mintTenant('closure-pay', tenantA, ['payments:collect'], {
        branchScope: 'ALL',
      });
      // the provider credential the raw-seeded provider Payments use (idempotent) + the opening-balance token
      await sql(
        `INSERT INTO provider_credential
           (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
         VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())
         ON CONFLICT (id) DO NOTHING`,
        [PROVIDER_CRED_K, tenantA, coA, branchA],
      );
      openingTok = await mintTenant(
        'closure-opening',
        tenantA,
        ['receivables:opening_balance:manage'],
        { branchScope: 'ALL', stepUp: true },
      );
      // self-contained (a filtered `-t` run skips the sibling describes'
      // `beforeAll`): idempotent tax reference + cancellation-fee tax category
      // + a wide-open accounting period for coA, exactly the sibling
      // "cancel WITH CHARGE" describe's own (WHERE NOT EXISTS) pattern.
      await sql(
        `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STD3B3','Standard 3b3','x'),('ZERO3B3','Zero 3b3','x') ON CONFLICT (key) DO NOTHING`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom")
         SELECT 'AE','STD3B3',500,'2020-01-01'
          WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE "countryCode"='AE' AND "taxCategoryKey"='STD3B3')`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom")
         SELECT 'AE','ZERO3B3',0,'2020-01-01'
          WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE "countryCode"='AE' AND "taxCategoryKey"='ZERO3B3')`,
      );
      await sql(`UPDATE company SET "cancellationFeeTaxCategoryKey" = 'STD3B3' WHERE id = $1`, [
        coA,
      ]);
      await sql(
        `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
         VALUES (uuidv7(), $1, $2, '2020-01-01', '2030-12-31', 'OPEN', now())
         ON CONFLICT DO NOTHING`,
        [tenantA, coA],
      );
    }, 120_000);

    // ── fixtures — every one a real production path ───────────────────────────
    const acct = (customerId: string, branch = branchA): string =>
      `/companies/${coA}/branches/${branch}/customers/${customerId}/account`;

    async function newCustomer(label: string): Promise<string> {
      const r = await req(
        'POST',
        `/companies/${coA}/customers`,
        ownerA,
        { displayName: `Closure ${label}` },
        { 'idempotency-key': `closure-${label}-${ik()}` },
      );
      expect(r.statusCode, r.payload).toBe(201);
      return (r.json() as { id: string }).id;
    }

    async function draftFor(customerId: string): Promise<{ id: string; version: number }> {
      const productId = await productIdFor(variantId);
      const r = await req(
        'POST',
        ORD(coA, branchA),
        ownerA,
        { lines: [basicLine({ productId })], customerId },
        { 'idempotency-key': ik() },
      );
      expect(r.statusCode, r.payload).toBe(201);
      const b = r.json() as { order: { id: string; version: number } };
      return { id: b.order.id, version: b.order.version };
    }

    /** Issues a real customer-linked Invoice (total 2000, PAY_NOW, zero tax)
     *  through the internal issuance primitive (no public route exists). */
    async function issueInvoiceOf(orderId: string): Promise<string> {
      const g = await req('GET', ORD(coA, branchA, `/${orderId}`), ownerA);
      const gBody = g.json() as {
        order: { version: number; commercialSnapshotFingerprint: string };
        lines: { id: string }[];
      };
      const issuance = app.get(InvoiceIssuanceRepository);
      const db = app.get(DbService);
      await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
        issuance.issueFinalInvoice(tx, {
          tenantId: tenantA,
          companyId: coA,
          branchId: branchA,
          orderId,
          expectedVersion: gBody.order.version,
          commercialSnapshotFingerprint: gBody.order.commercialSnapshotFingerprint,
          paymentIntent: 'PAY_NOW',
          lines: [
            {
              orderLineId: gBody.lines[0]!.id,
              priceTaxMode: 'TAX_EXCLUSIVE',
              roundingScope: 'LINE',
              roundingMode: 'HALF_UP',
              lineTaxAmountMinor: 0n,
            },
          ],
          totals: {
            subtotalAmountMinor: 2000n,
            documentDiscountAmountMinor: 0n,
            taxTotalAmountMinor: 0n,
            totalAmountMinor: 2000n,
            currencyCode: 'AED',
            currencyExponent: 2,
          },
        }),
      );
      deliberatelyIssuedOrderIds.add(orderId);
      return (
        await sql<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [orderId])
      )[0]!.id;
    }

    const receivableOfInvoice = async (invoiceId: string): Promise<string> =>
      (
        await sql<{ id: string }>(`SELECT id FROM customer_receivable WHERE "invoiceId" = $1`, [
          invoiceId,
        ])
      )[0]!.id;

    /** customer-linked invoice (2000) still OPEN — returns its receivable too. */
    async function openInvoiceFor(
      customerId: string,
    ): Promise<{ orderId: string; invoiceId: string; receivableId: string }> {
      const d = await draftFor(customerId);
      const invoiceId = await issueInvoiceOf(d.id);
      return { orderId: d.id, invoiceId, receivableId: await receivableOfInvoice(invoiceId) };
    }

    const receipt = (
      customerId: string,
      amountMinor: string,
      method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL' = 'OTHER_MANUAL',
      branch = branchA,
    ) =>
      req(
        'POST',
        `/companies/${coA}/branches/${branch}/customers/${customerId}/receipts`,
        closureTok,
        { amountMinor, method },
        { 'idempotency-key': ik() },
      );

    async function cancelInvoicedOrder(orderId: string) {
      const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [
        orderId,
      ]);
      return req(
        'POST',
        ORD(coA, branchA, `/${orderId}/cancel`),
        closureTok,
        { reason: 'integration closure scenario' },
        { 'if-match': String(row[0]!.version) },
      );
    }

    /** invoice (2000) -> optional receipt -> FULL post-invoice cancellation.
     *  OTHER_MANUAL keeps a fully-covered invoice at PAID (CASH/BANK_TRANSFER
     *  would auto-promote it to SETTLED, which is out of scope for a CreditNote). */
    async function invoiceThenCancel(
      customerId: string,
      paidMinor: string | null,
      method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL' = 'OTHER_MANUAL',
    ): Promise<{ orderId: string; invoiceId: string; creditNoteId: string; advanceIds: string[] }> {
      const { orderId, invoiceId } = await openInvoiceFor(customerId);
      if (paidMinor !== null) {
        const r = await receipt(customerId, paidMinor, method);
        expect(r.statusCode, r.payload).toBe(201);
      }
      const c = await cancelInvoicedOrder(orderId);
      expect(c.statusCode, c.payload).toBe(200);
      const creditNoteId = (
        await sql<{ id: string }>(`SELECT id FROM credit_note WHERE "invoiceId" = $1`, [invoiceId])
      )[0]!.id;
      const adv = await sql<{ id: string }>(
        `SELECT r."customerAdvanceId" AS id FROM credit_note_coverage_release r
          WHERE r."creditNoteId" = $1 ORDER BY r."createdAt", r.id`,
        [creditNoteId],
      );
      return { orderId, invoiceId, creditNoteId, advanceIds: adv.map((a) => a.id) };
    }

    /** a customer-linked DRAFT order cancelled WITH a cancellation charge —
     *  produces exactly one CancellationCharge + its CANCELLATION_CHARGE-sourced
     *  CustomerReceivable (coA is TAX_EXCLUSIVE, fee tax category 5%: a requested
     *  net of 10000 -> total 10500). */
    async function chargeReceivableFor(
      customerId: string,
      requestedAmountMinor = '10000',
    ): Promise<{
      receivableId: string;
      chargeId: string;
      totalMinor: bigint;
      accountingDate: string;
    }> {
      const d = await draftFor(customerId);
      const res = await req(
        'POST',
        ORD(coA, branchA, `/${d.id}/cancel`),
        closureTok,
        {
          reason: 'integration closure charge',
          cancellationCharge: { requestedAmountMinor, reasonCode: 'CUSTOMER_REQUEST' },
        },
        { 'if-match': String(d.version) },
      );
      expect(res.statusCode, res.payload).toBe(200);
      const row = (
        await sql<{
          receivableId: string;
          chargeId: string;
          total: string;
          accountingDate: string;
        }>(
          `SELECT cr.id AS "receivableId", cc.id AS "chargeId", cc."totalAmountMinor"::text AS total,
                  to_char(cc."accountingDate",'YYYY-MM-DD') AS "accountingDate"
             FROM cancellation_charge cc
             JOIN customer_receivable cr ON cr."cancellationChargeId" = cc.id
            WHERE cc."orderId" = $1`,
          [d.id],
        )
      )[0]!;
      return {
        receivableId: row.receivableId,
        chargeId: row.chargeId,
        totalMinor: BigInt(row.total),
        accountingDate: row.accountingDate,
      };
    }

    const refundOf = (
      customerId: string,
      advanceId: string,
      amountMinor: string,
      method: 'CASH' | 'BANK_TRANSFER' = 'CASH',
    ) =>
      req(
        'POST',
        `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/${advanceId}/refunds`,
        closureTok,
        { requestedAmountMinor: amountMinor, method, reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );

    const applyAdvanceTo = (
      customerId: string,
      advanceId: string,
      customerReceivableId: string,
      amountMinor: string,
    ) =>
      req(
        'POST',
        `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/${advanceId}/applications`,
        closureTok,
        { customerReceivableId, amountMinor },
        { 'idempotency-key': ik() },
      );

    const projectionOf = async (
      customerId: string,
    ): Promise<{ outstanding: string; advance: string }> =>
      (
        await sql<{ outstanding: string; advance: string }>(
          `SELECT "currentOutstandingMinor"::text AS outstanding, "advanceBalanceMinor"::text AS advance
             FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
          [customerId, coA],
        )
      )[0]!;

    async function summaryOf(customerId: string, branch = branchA): Promise<SummaryBody> {
      const r = await req('GET', `${acct(customerId, branch)}/summary`, closureTok);
      expect(r.statusCode, r.payload).toBe(200);
      return r.json() as SummaryBody;
    }
    async function receivablesOf(customerId: string, branch = branchA): Promise<ReceivableBody[]> {
      const r = await req('GET', `${acct(customerId, branch)}/receivables?limit=200`, closureTok);
      expect(r.statusCode, r.payload).toBe(200);
      return (r.json() as { data: ReceivableBody[] }).data;
    }
    async function advancesOf(customerId: string, branch = branchA): Promise<AdvanceBody[]> {
      const r = await req('GET', `${acct(customerId, branch)}/advances?limit=200`, closureTok);
      expect(r.statusCode, r.payload).toBe(200);
      return (r.json() as { data: AdvanceBody[] }).data;
    }
    async function statementOf(
      customerId: string,
      qs = '?limit=200',
      branch = branchA,
    ): Promise<StatementBody> {
      const r = await req('GET', `${acct(customerId, branch)}/statement${qs}`, closureTok);
      expect(r.statusCode, r.payload).toBe(200);
      return r.json() as StatementBody;
    }
    const sumOf = (
      lines: StatementLineBody[],
      key: 'receivableEffectMinor' | 'advanceEffectMinor' | 'unappliedReceiptEffectMinor',
    ): bigint => lines.reduce((acc, l) => acc + BigInt(l[key]), 0n);

    /** the DIRECT invoice-payment route (`payments:collect`, atomic synchronous tenders). */
    const directPayment = (
      invoiceId: string,
      amountMinor: string,
      key: string = ik(),
      method: 'CASH' | 'BANK_TRANSFER' = 'CASH',
    ) =>
      req(
        'POST',
        `/companies/${coA}/branches/${branchA}/invoices/${invoiceId}/payments`,
        payTok,
        { amountMinor, tenders: [{ method, amountMinor }] },
        { 'idempotency-key': key },
      );
    const allocationTotal = async (invoiceId: string): Promise<string> =>
      (
        await sql<{ t: string }>(
          `SELECT COALESCE(SUM("amountMinor"),0)::text AS t FROM payment_allocation WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      )[0]!.t;
    const statusOf = async (invoiceId: string): Promise<string> =>
      (
        await sql<{ s: string }>(`SELECT "invoicePaymentStatus" AS s FROM invoice WHERE id = $1`, [
          invoiceId,
        ])
      )[0]!.s;
    /** the maintained customer-account projections still equal the canonical sums */
    const integrityHolds = async (customerId: string): Promise<void> => {
      expect((await summaryOf(customerId)).credit.projectionIntegrity).toEqual({
        receivableProjectionMatches: true,
        advanceProjectionMatches: true,
      });
    };

    /** global row counts of every table a receipt / payment / advance application /
     *  credit note can touch — compared before/after one operation (these tests run
     *  sequentially, so a delta is attributable to that operation alone). */
    const footprint = async (): Promise<Record<string, string>> => {
      const one = async (table: string): Promise<string> =>
        (await sql<{ c: string }>(`SELECT count(*)::text AS c FROM ${table}`))[0]!.c;
      return {
        payment_attempt: await one('payment_attempt'),
        payment: await one('payment'),
        payment_allocation: await one('payment_allocation'),
        application: await one('customer_receivable_payment_application'),
        advance_application: await one('customer_advance_application'),
        customer_advance: await one('customer_advance'),
        credit_note: await one('credit_note'),
        settlement_application: await one('settlement_application'),
        entry: await one('customer_account_entry'),
        journal_entry: await one('journal_entry'),
        journal_line: await one('journal_line'),
        audit_log: await one('audit_log'),
        outbox: await one('outbox'),
      };
    };

    // ── shared fixtures (provider-paid invoices, settlement batches, release provenance, cancellation facts) ──
    // the same id the refund describe's provider-backed fixture seeds (ON CONFLICT DO NOTHING)
    const PROVIDER_CRED_K = '00000000-0000-7000-9000-0000000003b8';
    /** an OPEN customer invoice (2000) then fully covered by a RAW-SEEDED provider-backed
     *  Payment (no real adapter exists — the same fixture technique the refund describe's
     *  provider foundation uses), with the account projection the real receipt effects
     *  would have written. */
    async function providerPaidInvoice(
      customerId: string,
      method: 'ONLINE_GATEWAY' | 'CARD_TERMINAL' = 'ONLINE_GATEWAY',
    ): Promise<{ orderId: string; invoiceId: string; paymentId: string }> {
      const open = await openInvoiceFor(customerId);
      const attemptId = (
        await sql<{ id: string }>(
          `INSERT INTO payment_attempt
             (id,"tenantId","companyId","branchId","orderId","targetInvoiceId",method,"providerKey",
              "providerCredentialId","amountMinor","currencyCode","currencyExponent",state,
              "orderCommercialSnapshotFingerprintAtCreation","orderVersionAtCreation","idempotencyKey","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,'tap',$7,2000,'AED',2,'CAPTURED','fp-seed',1,$8,now())
           RETURNING id`,
          [
            tenantA,
            coA,
            branchA,
            open.orderId,
            open.invoiceId,
            method,
            PROVIDER_CRED_K,
            `seed-attempt-${ik()}`,
          ],
        )
      )[0]!.id;
      const paymentId = (
        await sql<{ id: string }>(
          `INSERT INTO payment
             (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey",
              "amountMinor","currencyCode","currencyExponent")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,'tap',2000,'AED',2)
           RETURNING id`,
          [tenantA, coA, branchA, attemptId, method],
        )
      )[0]!.id;
      await sql(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,2000,'AED',2)`,
        [tenantA, coA, branchA, paymentId, open.invoiceId],
      );
      await sql(`UPDATE invoice SET "invoicePaymentStatus" = 'PAID' WHERE id = $1`, [
        open.invoiceId,
      ]);
      await sql(
        `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" - 2000
          WHERE "customerId" = $1 AND "companyId" = $2`,
        [customerId, coA],
      );
      return { orderId: open.orderId, invoiceId: open.invoiceId, paymentId };
    }

    /** ONE batch matching ONE provider Payment (2000): DRAFT — to be finalized by the REAL
     *  finalization command — or already FINALIZED (journal + application raw-seeded in
     *  one transaction, mirroring the refund describe's `settled` fixture). */
    async function seedSettlement(
      paymentId: string,
      state: 'DRAFT' | 'FINALIZED',
    ): Promise<string> {
      const client = new pg.Client({ connectionString: stack.postgres.url });
      await client.connect();
      const batchId = crypto.randomUUID();
      const lineId = crypto.randomUUID();
      try {
        await client.query('BEGIN');
        let journalEntryId: string | null = null;
        if (state === 'FINALIZED') {
          const bankAcct = (
            await client.query(`SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.BANK'`, [
              coA,
            ])
          ).rows[0].id;
          const clearingAcct = (
            await client.query(
              `SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.PAYMENT_CLEARING'`,
              [coA],
            )
          ).rows[0].id;
          const period = (
            await client.query(
              `SELECT id FROM accounting_period
                WHERE "companyId"=$1 AND "startDate" <= '2026-06-01' AND "endDate" >= '2026-06-01' LIMIT 1`,
              [coA],
            )
          ).rows[0].id;
          journalEntryId = crypto.randomUUID();
          await client.query(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
             VALUES ($1,$2,$3,$4,'2026-06-01','SETTLEMENT_BATCH',$5,'AED',$6)`,
            [journalEntryId, tenantA, coA, period, batchId, `fp-${journalEntryId}`],
          );
          await client.query(
            `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,2000,0)`,
            [tenantA, coA, journalEntryId, bankAcct, branchA],
          );
          await client.query(
            `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,0,2000)`,
            [tenantA, coA, journalEntryId, clearingAcct, branchA],
          );
          await client.query(`UPDATE journal_entry SET "sealedAt"=now() WHERE id=$1`, [
            journalEntryId,
          ]);
        }
        await client.query(
          `INSERT INTO settlement_batch
             (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
              "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor",
              "currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',2000,0,2000,'AED',2)`,
          [batchId, tenantA, coA, branchA, PROVIDER_CRED_K, `ext-${batchId.slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
           VALUES ($1,$2,$3,$4,$5,2000,'AED',2,$6)`,
          [lineId, tenantA, coA, branchA, batchId, paymentId],
        );
        if (state === 'FINALIZED') {
          await client.query(
            `INSERT INTO settlement_application (id,"tenantId","companyId","branchId","batchId","lineId","paymentId","amountMinor","currencyCode","currencyExponent")
             VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,2000,'AED',2)`,
            [tenantA, coA, branchA, batchId, lineId, paymentId],
          );
          await client.query(
            `UPDATE settlement_batch SET state='FINALIZED', "journalEntryId"=$1, "finalizedAt"=now(), version=version+1 WHERE id=$2`,
            [journalEntryId, batchId],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        await client.end();
      }
      return batchId;
    }

    /** the REAL settlement-finalization command (Path A/B/C discovery + projection). */
    async function finalizeBatch(batchId: string): Promise<void> {
      const finalization = app.get(SettlementFinalizationRepository);
      const db = app.get(DbService);
      const version = (
        await sql<{ v: number }>(`SELECT version AS v FROM settlement_batch WHERE id = $1`, [
          batchId,
        ])
      )[0]!.v;
      await runScoped(db.appClient(), { tenantId: tenantA, branchId: branchA }, (tx) =>
        finalization.finalizeInTx(tx, {
          tenantId: tenantA,
          companyId: coA,
          branchId: branchA,
          id: batchId,
          expectedVersion: version,
          actorUserId: null,
        }),
      );
    }

    /** the CREDIT_NOTE advance a cancelled invoice released + its release provenance */
    async function releasedAdvanceOf(
      invoiceId: string,
    ): Promise<{ advanceId: string; sourceKind: string; sourcePaymentId: string | null }> {
      const rows = await sql<{
        advanceId: string;
        sourceKind: string;
        sourcePaymentId: string | null;
      }>(
        `SELECT r."customerAdvanceId" AS "advanceId", r."sourceKind", r."sourcePaymentId"
           FROM credit_note_coverage_release r
           JOIN credit_note cn ON cn.id = r."creditNoteId"
          WHERE cn."invoiceId" = $1`,
        [invoiceId],
      );
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    async function cancelOk(orderId: string): Promise<void> {
      const c = await cancelInvoicedOrder(orderId);
      expect(c.statusCode, c.payload).toBe(200);
    }

    /** applies `amountMinor` of the advance to the receivable and expects 201 */
    async function applyOk(
      customerId: string,
      advanceId: string,
      receivableId: string,
      amountMinor: string,
    ): Promise<void> {
      const r = await applyAdvanceTo(customerId, advanceId, receivableId, amountMinor);
      expect(r.statusCode, r.payload).toBe(201);
    }

    /** the credit note + releases + advances + GL + audit of ONE cancelled invoice, as persisted */
    async function cancelledInvoiceFacts(invoiceId: string, orderId: string) {
      const cns = await sql<{ id: string; num: string; ar: string; excess: string }>(
        `SELECT id, "creditNoteNumber" AS num, "arReductionMinor"::text AS ar, "advanceExcessMinor"::text AS excess
           FROM credit_note WHERE "invoiceId" = $1`,
        [invoiceId],
      );
      const releases = await sql<{
        kind: string;
        allocationId: string | null;
        applicationId: string | null;
        amount: string;
        advanceId: string;
        paymentId: string | null;
      }>(
        `SELECT r."sourceKind" AS kind, r."sourcePaymentAllocationId" AS "allocationId",
                r."sourceAdvanceApplicationId" AS "applicationId", r."releasedAmountMinor"::text AS amount,
                r."customerAdvanceId" AS "advanceId", r."sourcePaymentId" AS "paymentId"
           FROM credit_note_coverage_release r JOIN credit_note cn ON cn.id = r."creditNoteId"
          WHERE cn."invoiceId" = $1`,
        [invoiceId],
      );
      const charges = (
        await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM cancellation_charge WHERE "orderId" = $1`,
          [orderId],
        )
      )[0]!.n;
      const unbalanced = await sql<{ id: string }>(
        `SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
          GROUP BY je.id HAVING SUM(jl."debitMinor") <> SUM(jl."creditMinor")`,
      );
      const audits = cns[0]
        ? await sql<{ action: string; n: string }>(
            `SELECT action, count(*)::text AS n FROM audit_log WHERE "resourceId"::text = ANY($1::text[]) GROUP BY action`,
            [[cns[0].id, orderId]],
          )
        : [];
      const auditCount = (action: string): number =>
        Number(audits.find((a) => a.action === action)?.n ?? '0');
      return { cns, releases, charges, unbalanced, auditCount };
    }

    // ═══════ A — the customer-account read model with a CancellationCharge receivable ═══════
    describe('A — read model with a CancellationCharge receivable (no OPENING fallthrough)', () => {
      it('A1: summary succeeds (no NULL arithmetic / 500), reports the charge as outstanding and projection integrity true', async () => {
        const customerId = await newCustomer('a1');
        const charge = await chargeReceivableFor(customerId);
        expect(charge.totalMinor).toBe(10500n); // net 10000 + 5% tax
        const body = await summaryOf(customerId);
        expect(body.branchFinancials).toEqual({
          receivableOutstandingMinor: '10500',
          advanceAvailableMinor: '0',
          unappliedReceiptMinor: '0',
          openReceivableCount: 1,
          openAdvanceCount: 0,
        });
        expect(body.credit.creditExposureMinor).toBe('10500');
        expect(body.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
        expect(await projectionOf(customerId)).toEqual({ outstanding: '10500', advance: '0' });
      });

      it('A2: the open-receivables list returns the charge as a first-class CANCELLATION_CHARGE row (never dropped, never mislabelled OPENING)', async () => {
        const customerId = await newCustomer('a2');
        const charge = await chargeReceivableFor(customerId);
        const rows = await receivablesOf(customerId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          customerReceivableId: charge.receivableId,
          sourceType: 'CANCELLATION_CHARGE',
          invoiceId: null,
          invoiceNumber: null,
          cancellationChargeId: charge.chargeId,
          sourceDate: charge.accountingDate,
          originalAmountMinor: '10500',
          paidByPaymentMinor: '0',
          paidByAdvanceMinor: '0',
          outstandingMinor: '10500',
          currencyCode: 'AED',
          currencyExponent: 2,
          openingEffectiveDate: null,
          openingNote: null,
        });
        expect(rows[0]!.cancellationChargeNumber).toMatch(/^CC-\d{6}$/);
        expect(Number.isInteger(rows[0]!.ageDays)).toBe(true);
        expect(rows[0]!.ageDays).toBeGreaterThanOrEqual(0);
      });
    });

    // ═══════ B — the statement: CANCELLATION_CHARGE / CREDIT_NOTE / REFUND ═══════
    describe('B — statement exposes CANCELLATION_CHARGE, CREDIT_NOTE and REFUND', () => {
      it('B1: a CancellationCharge receivable is a +charge receivable line dated at the charge accounting date', async () => {
        const customerId = await newCustomer('b1');
        const charge = await chargeReceivableFor(customerId);
        const st = await statementOf(customerId);
        expect(st.data).toHaveLength(1);
        expect(st.data[0]).toMatchObject({
          entryKind: 'CANCELLATION_CHARGE',
          financialDate: charge.accountingDate,
          receivableEffectMinor: '10500',
          advanceEffectMinor: '0',
          unappliedReceiptEffectMinor: '0',
        });
        expect(st.data[0]!.refs['customerReceivableId']).toBe(charge.receivableId);
        const otherRefs = Object.entries(st.data[0]!.refs).filter(
          ([k]) => k !== 'customerReceivableId',
        );
        expect(otherRefs.every(([, v]) => v === null)).toBe(true);
      });

      it('B2: a CreditNote on an UNPAID invoice is a -arReduction receivable line referencing the credit note (INVOICE line unchanged)', async () => {
        const customerId = await newCustomer('b2');
        const cancelled = await invoiceThenCancel(customerId, null);
        const st = await statementOf(customerId);
        expect(st.data.map((l) => l.entryKind)).toEqual(['INVOICE', 'CREDIT_NOTE']);
        expect(st.data[0]).toMatchObject({ receivableEffectMinor: '2000' });
        const cnAccountingDate = (
          await sql<{ d: string }>(
            `SELECT to_char("accountingDate",'YYYY-MM-DD') AS d FROM credit_note WHERE id = $1`,
            [cancelled.creditNoteId],
          )
        )[0]!.d;
        expect(st.data[1]).toMatchObject({
          entryKind: 'CREDIT_NOTE',
          financialDate: cnAccountingDate,
          receivableEffectMinor: '-2000',
          advanceEffectMinor: '0',
          unappliedReceiptEffectMinor: '0',
        });
        expect(st.data[1]!.refs['creditNoteId']).toBe(cancelled.creditNoteId);
        expect(sumOf(st.data, 'receivableEffectMinor')).toBe(0n);
      });

      it('B3: a Refund is a -amount ADVANCE line referencing the refund application; a fully-paid CreditNote writes NO CREDIT_NOTE line', async () => {
        const customerId = await newCustomer('b3');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const refund = await refundOf(customerId, cancelled.advanceIds[0]!, '1500', 'CASH');
        expect(refund.statusCode, refund.payload).toBe(201);
        const st = await statementOf(customerId);
        expect(st.data.map((l) => l.entryKind)).toEqual([
          'INVOICE',
          'PAYMENT',
          'PAYMENT_ALLOCATION',
          'ADVANCE',
          'REFUND',
        ]);
        const refundLine = st.data[4]!;
        expect(refundLine).toMatchObject({
          receivableEffectMinor: '0',
          advanceEffectMinor: '-1500',
          unappliedReceiptEffectMinor: '0',
        });
        const refundApplicationId = (
          await sql<{ id: string }>(
            `SELECT id FROM customer_advance_refund_application WHERE "customerAdvanceId" = $1`,
            [cancelled.advanceIds[0]!],
          )
        )[0]!.id;
        expect(refundLine.refs['customerAdvanceRefundApplicationId']).toBe(refundApplicationId);
        expect(sumOf(st.data, 'receivableEffectMinor')).toBe(0n);
        expect(sumOf(st.data, 'advanceEffectMinor')).toBe(500n);
        expect(sumOf(st.data, 'unappliedReceiptEffectMinor')).toBe(0n);
      });

      it('B4: the existing line shape is unchanged — every line carries the same 6 original ref keys plus the 2 new ones, all null when unused', async () => {
        const customerId = await newCustomer('b4');
        await chargeReceivableFor(customerId);
        const st = await statementOf(customerId);
        expect(Object.keys(st.data[0]!.refs).sort()).toEqual(
          [
            'creditNoteId',
            'customerAdvanceApplicationId',
            'customerAdvanceId',
            'customerAdvanceRefundApplicationId',
            'customerReceivableId',
            'customerReceivablePaymentApplicationId',
            'paymentAllocationId',
            'paymentId',
          ].sort(),
        );
      });

      it('B5: a mixed-history customer (credit-noted partially-paid invoice + charge + refund + receipt + advance application) reconciles: statement == summary, in stable order, across pages and an opening state', async () => {
        const customerId = await newCustomer('b5');
        // (1) invoice paid 800 then fully cancelled: CN arReduction 1200 + a CN advance of 800
        const cancelled = await invoiceThenCancel(customerId, '800', 'CASH');
        // (2) a cancellation-charge receivable
        const charge = await chargeReceivableFor(customerId);
        // (3) refund 300 of the CN advance
        const refund = await refundOf(customerId, cancelled.advanceIds[0]!, '300', 'CASH');
        expect(refund.statusCode, refund.payload).toBe(201);
        // (4) a 4000 receipt — FIFO must reach the charge (the credit-noted invoice is closed)
        const rec = await receipt(customerId, '4000', 'CASH');
        expect(rec.statusCode, rec.payload).toBe(201);
        // (5) apply the remaining 500 of the CN advance to the charge
        const applied = await applyAdvanceTo(
          customerId,
          cancelled.advanceIds[0]!,
          charge.receivableId,
          '500',
        );
        expect(applied.statusCode, applied.payload).toBe(201);

        const st = await statementOf(customerId);
        const kinds = st.data.map((l) => l.entryKind);
        for (const k of [
          'INVOICE',
          'PAYMENT',
          'PAYMENT_ALLOCATION',
          'CREDIT_NOTE',
          'ADVANCE',
          'CANCELLATION_CHARGE',
          'REFUND',
          'CANCELLATION_CHARGE_PAYMENT_APPLIED',
          'ADVANCE_APPLIED',
        ]) {
          expect(kinds, `statement must contain a ${k} line`).toContain(k);
        }
        // a charge payment is NEVER recorded with the frozen opening-receivable kind
        expect(kinds).not.toContain('OPENING_RECEIVABLE_PAYMENT_APPLIED');

        const summary = await summaryOf(customerId);
        // receivable: 10500 charge - 4000 receipt - 500 advance = 6000 (invoice fully closed)
        expect(summary.branchFinancials.receivableOutstandingMinor).toBe('6000');
        expect(summary.branchFinancials.advanceAvailableMinor).toBe('0');
        expect(summary.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
        expect(sumOf(st.data, 'receivableEffectMinor').toString()).toBe(
          summary.branchFinancials.receivableOutstandingMinor,
        );
        expect(sumOf(st.data, 'advanceEffectMinor').toString()).toBe(
          summary.branchFinancials.advanceAvailableMinor,
        );
        expect(sumOf(st.data, 'unappliedReceiptEffectMinor').toString()).toBe(
          summary.branchFinancials.unappliedReceiptMinor,
        );

        // stable ordering: (financialDate, then occurrence) — ids never repeat,
        // pages of 3 concatenate to exactly the full statement, in order.
        const paged: StatementLineBody[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 20; guard++) {
          const qs: string = `?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
          const page = await statementOf(customerId, qs);
          paged.push(...page.data);
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        expect(paged.map((l) => l.customerAccountEntryId)).toEqual(
          st.data.map((l) => l.customerAccountEntryId),
        );
        expect(new Set(paged.map((l) => l.customerAccountEntryId)).size).toBe(paged.length);

        // opening state strictly before a far-future `from` == the full sums
        const future = await statementOf(customerId, '?from=2999-01-01&limit=5');
        expect(future.data).toHaveLength(0);
        expect(future.openingState).toEqual({
          asOfDate: '2999-01-01',
          receivableOutstandingMinor: '6000',
          advanceAvailableMinor: '0',
          unappliedReceiptMinor: '0',
        });
      });

      it('B6: a receipt applied to a charge renders as its OWN CANCELLATION_CHARGE_PAYMENT_APPLIED line — −amount receivable and −amount unapplied-receipt effect, dated by the application itself, referencing the application', async () => {
        const customerId = await newCustomer('b6');
        await chargeReceivableFor(customerId);
        const rec = await receipt(customerId, '4000', 'CASH');
        expect(rec.statusCode, rec.payload).toBe(201);
        const st = await statementOf(customerId);
        expect(st.data.map((l) => l.entryKind)).toEqual([
          'CANCELLATION_CHARGE',
          'PAYMENT',
          'CANCELLATION_CHARGE_PAYMENT_APPLIED',
        ]);
        const applied = st.data[2]!;
        expect(applied).toMatchObject({
          receivableEffectMinor: '-4000',
          advanceEffectMinor: '0',
          unappliedReceiptEffectMinor: '-4000',
        });
        const application = (
          await sql<{ id: string; day: string }>(
            `SELECT a.id, to_char((a."createdAt" AT TIME ZONE 'Asia/Dubai')::date,'YYYY-MM-DD') AS day
               FROM customer_receivable_payment_application a
               JOIN customer_company_account cca ON cca.id = a."customerCompanyAccountId"
              WHERE cca."customerId" = $1`,
            [customerId],
          )
        )[0]!;
        expect(applied.refs['customerReceivablePaymentApplicationId']).toBe(application.id);
        expect(applied.financialDate).toBe(application.day);
        // the statement reconciles with the summary (receivable 10500 − 4000, nothing unapplied left)
        const s = await summaryOf(customerId);
        expect(sumOf(st.data, 'receivableEffectMinor').toString()).toBe(
          s.branchFinancials.receivableOutstandingMinor,
        );
        expect(sumOf(st.data, 'unappliedReceiptEffectMinor').toString()).toBe(
          s.branchFinancials.unappliedReceiptMinor,
        );
      });
    });

    // ═══════ C — projectionIntegrity: recomputation == maintained projection ═══════
    describe('C — projectionIntegrity stays true after every 3b.8 financial event', () => {
      const expectIntegrity = async (
        customerId: string,
        expected: { outstanding: string; advance: string },
      ): Promise<void> => {
        const b = await summaryOf(customerId);
        expect(b.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
        expect(b.credit.creditExposureMinor).toBe(expected.outstanding);
        expect(b.branchFinancials.receivableOutstandingMinor).toBe(expected.outstanding);
        expect(b.branchFinancials.advanceAvailableMinor).toBe(expected.advance);
        expect(await projectionOf(customerId)).toEqual(expected);
      };

      it('C1: CreditNote cancellation of an UNPAID invoice (AR reduced by the full total)', async () => {
        const customerId = await newCustomer('c1');
        await invoiceThenCancel(customerId, null);
        await expectIntegrity(customerId, { outstanding: '0', advance: '0' });
      });

      it('C2: CreditNote cancellation of a PARTIALLY paid invoice (AR reduction + CN advance)', async () => {
        const customerId = await newCustomer('c2');
        await invoiceThenCancel(customerId, '800', 'CASH');
        await expectIntegrity(customerId, { outstanding: '0', advance: '800' });
      });

      it('C3 (control): CreditNote cancellation of a FULLY paid invoice (all CN advance)', async () => {
        const customerId = await newCustomer('c3');
        await invoiceThenCancel(customerId, '2000');
        await expectIntegrity(customerId, { outstanding: '0', advance: '2000' });
      });

      it('C4: a CASH refund of part of a CREDIT_NOTE advance', async () => {
        const customerId = await newCustomer('c4');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const r = await refundOf(customerId, cancelled.advanceIds[0]!, '1500', 'CASH');
        expect(r.statusCode, r.payload).toBe(201);
        await expectIntegrity(customerId, { outstanding: '0', advance: '500' });
      });

      it('C5: a BANK_TRANSFER refund draining a CREDIT_NOTE advance', async () => {
        const customerId = await newCustomer('c5');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const r = await refundOf(customerId, cancelled.advanceIds[0]!, '2000', 'BANK_TRANSFER');
        expect(r.statusCode, r.payload).toBe(201);
        await expectIntegrity(customerId, { outstanding: '0', advance: '0' });
      });
    });

    // ═══════ D — FIFO receipt collection ═══════
    describe('D — FIFO receipt collection', () => {
      it('D1: a receipt collects against a CancellationCharge receivable (valid receivable, never an OPENING fallthrough) with correct principal/outstanding and a full financial footprint', async () => {
        const customerId = await newCustomer('d1');
        const charge = await chargeReceivableFor(customerId);
        const res = await receipt(customerId, '4000', 'CASH');
        expect(res.statusCode, res.payload).toBe(201);
        const body = res.json() as {
          paymentId: string;
          allocations: { receivableId: string; sourceType: string; amountMinor: string }[];
          allocatedAmountMinor: string;
          unallocatedAmountMinor: string;
        };
        expect(body.allocations).toEqual([
          {
            receivableId: charge.receivableId,
            sourceType: 'CANCELLATION_CHARGE',
            amountMinor: '4000',
          },
        ]);
        expect(body.allocatedAmountMinor).toBe('4000');
        expect(body.unallocatedAmountMinor).toBe('0');

        // exactly one application row, tied to THIS payment and THIS charge receivable
        const apps = await sql<{ id: string; amountMinor: string; paymentId: string }>(
          `SELECT id, "amountMinor"::text, "paymentId" FROM customer_receivable_payment_application
            WHERE "customerReceivableId" = $1`,
          [charge.receivableId],
        );
        expect(apps).toEqual([{ id: apps[0]!.id, amountMinor: '4000', paymentId: body.paymentId }]);
        // exactly one chronology entry references that application, and it is
        // the CHARGE-specific kind — the legacy opening-receivable kind is
        // frozen for opening-balance history and must never record a charge payment
        const entries = await sql<{ k: string }>(
          `SELECT "entryKind" AS k FROM customer_account_entry
            WHERE "customerReceivablePaymentApplicationId" = $1`,
          [apps[0]!.id],
        );
        expect(entries).toEqual([{ k: 'CANCELLATION_CHARGE_PAYMENT_APPLIED' }]);
        // GL: Dr UNAPPLIED_RECEIPTS / Cr ACCOUNTS_RECEIVABLE, balanced, exactly once
        const lines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
          `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
             FROM journal_line jl
             JOIN journal_entry je ON je.id = jl."journalEntryId"
             JOIN account a ON a.id = jl."accountId"
            WHERE je."sourceKind" = 'cancellation_charge_payment_application' AND je."sourceId" = $1
            ORDER BY a.key`,
          [apps[0]!.id],
        );
        expect(lines).toEqual([
          { key: 'ASSET.ACCOUNTS_RECEIVABLE', debitMinor: '0', creditMinor: '4000' },
          { key: 'LIABILITY.UNAPPLIED_RECEIPTS', debitMinor: '4000', creditMinor: '0' },
        ]);
        const audit = await sql<{ c: string }>(
          `SELECT count(*)::text AS c FROM audit_log
            WHERE action = 'receivable.cancellation_charge_payment_applied' AND "resourceId" = $1`,
          [apps[0]!.id],
        );
        expect(audit[0]!.c).toBe('1');

        // projections + read model agree, the charge shows its payment and the remainder
        await expect(projectionOf(customerId)).resolves.toEqual({
          outstanding: '6500',
          advance: '0',
        });
        const rows = await receivablesOf(customerId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          sourceType: 'CANCELLATION_CHARGE',
          originalAmountMinor: '10500',
          paidByPaymentMinor: '4000',
          paidByAdvanceMinor: '0',
          outstandingMinor: '6500',
        });
        const s = await summaryOf(customerId);
        expect(s.branchFinancials.receivableOutstandingMinor).toBe('6500');
        expect(s.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });

        // a second receipt exceeding the remainder closes the charge; the excess stays unapplied
        const second = await receipt(customerId, '7000', 'CASH');
        expect(second.statusCode, second.payload).toBe(201);
        const secondBody = second.json() as {
          allocatedAmountMinor: string;
          unallocatedAmountMinor: string;
        };
        expect(secondBody.allocatedAmountMinor).toBe('6500');
        expect(secondBody.unallocatedAmountMinor).toBe('500');
        expect(await receivablesOf(customerId)).toHaveLength(0);
        const closed = await summaryOf(customerId);
        expect(closed.branchFinancials.receivableOutstandingMinor).toBe('0');
        expect(closed.branchFinancials.unappliedReceiptMinor).toBe('500');
        expect(closed.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
      });

      it('D2: a credit-noted (CANCELLED, unpaid) invoice is NOT collectible — the receipt stays unapplied and the invoice is untouched', async () => {
        const customerId = await newCustomer('d2');
        const cancelled = await invoiceThenCancel(customerId, null);
        const res = await receipt(customerId, '500', 'OTHER_MANUAL');
        expect(res.statusCode, res.payload).toBe(201);
        const body = res.json() as {
          allocations: unknown[];
          allocatedAmountMinor: string;
          unallocatedAmountMinor: string;
        };
        expect(body.allocations).toEqual([]);
        expect(body.allocatedAmountMinor).toBe('0');
        expect(body.unallocatedAmountMinor).toBe('500');
        const allocs = await sql<{ c: string }>(
          `SELECT count(*)::text AS c FROM payment_allocation WHERE "invoiceId" = $1`,
          [cancelled.invoiceId],
        );
        expect(allocs[0]!.c).toBe('0');
        const inv = await sql<{ s: string }>(
          `SELECT "invoicePaymentStatus" AS s FROM invoice WHERE id = $1`,
          [cancelled.invoiceId],
        );
        expect(inv[0]!.s).toBe('CANCELLED');
        const s = await summaryOf(customerId);
        expect(s.branchFinancials.receivableOutstandingMinor).toBe('0');
        expect(s.branchFinancials.unappliedReceiptMinor).toBe('500');
      });

      it('D3: a PARTIALLY-paid credit-noted invoice (PARTIALLY_REFUNDED) is NOT collectible beyond its true remaining (0)', async () => {
        const customerId = await newCustomer('d3');
        const cancelled = await invoiceThenCancel(customerId, '800', 'CASH');
        const res = await receipt(customerId, '3000', 'CASH');
        expect(res.statusCode, res.payload).toBe(201);
        const body = res.json() as {
          allocations: unknown[];
          allocatedAmountMinor: string;
          unallocatedAmountMinor: string;
        };
        expect(body.allocations).toEqual([]);
        expect(body.allocatedAmountMinor).toBe('0');
        expect(body.unallocatedAmountMinor).toBe('3000');
        const allocs = await sql<{ total: string }>(
          `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
          [cancelled.invoiceId],
        );
        expect(allocs[0]!.total).toBe('800'); // only the ORIGINAL 800 — never topped up
        const inv = await sql<{ s: string }>(
          `SELECT "invoicePaymentStatus" AS s FROM invoice WHERE id = $1`,
          [cancelled.invoiceId],
        );
        expect(inv[0]!.s).toBe('PARTIALLY_REFUNDED');
      });

      it('D4: a mixed FIFO queue (credit-noted invoice older, charge, open invoice newest) skips the closed invoice and collects charge-then-invoice in order', async () => {
        const customerId = await newCustomer('d4');
        const cancelled = await invoiceThenCancel(customerId, null); // oldest, closed by its CreditNote
        const charge = await chargeReceivableFor(customerId); // 10500
        const open = await openInvoiceFor(customerId); // 2000, newest
        const res = await receipt(customerId, '11000', 'CASH');
        expect(res.statusCode, res.payload).toBe(201);
        const body = res.json() as {
          allocations: { receivableId: string; sourceType: string; amountMinor: string }[];
          allocatedAmountMinor: string;
          unallocatedAmountMinor: string;
        };
        expect(body.allocations).toEqual([
          {
            receivableId: charge.receivableId,
            sourceType: 'CANCELLATION_CHARGE',
            amountMinor: '10500',
          },
          { receivableId: open.receivableId, sourceType: 'INVOICE', amountMinor: '500' },
        ]);
        expect(body.allocatedAmountMinor).toBe('11000');
        expect(body.unallocatedAmountMinor).toBe('0');
        const allocsOnCancelled = await sql<{ c: string }>(
          `SELECT count(*)::text AS c FROM payment_allocation WHERE "invoiceId" = $1`,
          [cancelled.invoiceId],
        );
        expect(allocsOnCancelled[0]!.c).toBe('0');
        const st = await sql<{ id: string; s: string }>(
          `SELECT id, "invoicePaymentStatus" AS s FROM invoice WHERE id = ANY($1::uuid[])`,
          [[cancelled.invoiceId, open.invoiceId]],
        );
        expect(Object.fromEntries(st.map((r) => [r.id, r.s]))).toEqual({
          [cancelled.invoiceId]: 'CANCELLED',
          [open.invoiceId]: 'PARTIAL',
        });
        const s = await summaryOf(customerId);
        expect(s.branchFinancials.receivableOutstandingMinor).toBe('1500');
        expect(s.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
      });
    });

    // ═══════ E — CustomerAdvance application ═══════
    describe('E — CustomerAdvance application', () => {
      it('E1: a CREDIT_NOTE-sourced advance is applicable to a CancellationCharge receivable — correct remaining amounts, projections, ledger entry and GL', async () => {
        const customerId = await newCustomer('e1');
        const cancelled = await invoiceThenCancel(customerId, '2000'); // CN advance of 2000
        const charge = await chargeReceivableFor(customerId); // created AFTER, so the receipt above hit the invoice
        const res = await applyAdvanceTo(
          customerId,
          cancelled.advanceIds[0]!,
          charge.receivableId,
          '2000',
        );
        expect(res.statusCode, res.payload).toBe(201);
        const body = res.json() as {
          applicationId: string;
          remainingAdvanceMinor: string;
          receivableOutstandingMinor: string;
          invoicePaymentStatus: string | null;
        };
        expect(body.remainingAdvanceMinor).toBe('0');
        expect(body.receivableOutstandingMinor).toBe('8500');
        expect(body.invoicePaymentStatus).toBeNull();

        await expect(projectionOf(customerId)).resolves.toEqual({
          outstanding: '8500',
          advance: '0',
        });
        const entries = await sql<{ k: string }>(
          `SELECT "entryKind" AS k FROM customer_account_entry WHERE "customerAdvanceApplicationId" = $1`,
          [body.applicationId],
        );
        expect(entries).toEqual([{ k: 'ADVANCE_APPLIED' }]);
        const lines = await sql<{ key: string; debitMinor: string; creditMinor: string }>(
          `SELECT a.key, jl."debitMinor"::text, jl."creditMinor"::text
             FROM journal_line jl
             JOIN journal_entry je ON je.id = jl."journalEntryId"
             JOIN account a ON a.id = jl."accountId"
            WHERE je."sourceKind" = 'customer_advance_application' AND je."sourceId" = $1
            ORDER BY a.key`,
          [body.applicationId],
        );
        expect(lines).toEqual([
          { key: 'ASSET.ACCOUNTS_RECEIVABLE', debitMinor: '0', creditMinor: '2000' },
          { key: 'LIABILITY.CUSTOMER_ADVANCES', debitMinor: '2000', creditMinor: '0' },
        ]);
        const rows = await receivablesOf(customerId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          sourceType: 'CANCELLATION_CHARGE',
          paidByPaymentMinor: '0',
          paidByAdvanceMinor: '2000',
          outstandingMinor: '8500',
        });
        expect(await advancesOf(customerId)).toHaveLength(0); // fully consumed
        const s = await summaryOf(customerId);
        expect(s.branchFinancials.receivableOutstandingMinor).toBe('8500');
        expect(s.branchFinancials.advanceAvailableMinor).toBe('0');
        expect(s.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
      });

      it('E2: applying more than a CancellationCharge receivable still owes is a clean 409 (never a 500), and the exact remainder applies', async () => {
        const customerId = await newCustomer('e2');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const charge = await chargeReceivableFor(customerId, '1000'); // 1000 net + 5% = 1050
        expect(charge.totalMinor).toBe(1050n);
        const tooMuch = await applyAdvanceTo(
          customerId,
          cancelled.advanceIds[0]!,
          charge.receivableId,
          '2000',
        );
        expect(tooMuch.statusCode, tooMuch.payload).toBe(409);
        expect(errCode(tooMuch)).toBe('CUSTOMER_ADVANCE_APPLICATION_INVALID');
        const exact = await applyAdvanceTo(
          customerId,
          cancelled.advanceIds[0]!,
          charge.receivableId,
          '1050',
        );
        expect(exact.statusCode, exact.payload).toBe(201);
        const body = exact.json() as {
          remainingAdvanceMinor: string;
          receivableOutstandingMinor: string;
        };
        expect(body.remainingAdvanceMinor).toBe('950');
        expect(body.receivableOutstandingMinor).toBe('0');
        expect(await receivablesOf(customerId)).toHaveLength(0);
        const advances = await advancesOf(customerId);
        expect(advances).toHaveLength(1);
        expect(advances[0]).toMatchObject({
          sourceType: 'CREDIT_NOTE',
          originalAmountMinor: '2000',
          appliedAmountMinor: '1050',
          availableAmountMinor: '950',
        });
      });
    });

    // ═══════ F — canonical advance availability (refund applications) ═══════
    describe('F — canonical advance availability includes refund applications', () => {
      it('F1: a partly-refunded CREDIT_NOTE advance cannot be over-applied (clean 409) and its remaining applies exactly', async () => {
        const customerId = await newCustomer('f1');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const open = await openInvoiceFor(customerId); // 2000 open
        const refund = await refundOf(customerId, cancelled.advanceIds[0]!, '1500', 'CASH');
        expect(refund.statusCode, refund.payload).toBe(201);
        // 2000 - 1500 refunded = 500 left: 600 must be a clean business 409
        const tooMuch = await applyAdvanceTo(
          customerId,
          cancelled.advanceIds[0]!,
          open.receivableId,
          '600',
        );
        expect(tooMuch.statusCode, tooMuch.payload).toBe(409);
        expect(errCode(tooMuch)).toBe('CUSTOMER_ADVANCE_APPLICATION_INVALID');
        const exact = await applyAdvanceTo(
          customerId,
          cancelled.advanceIds[0]!,
          open.receivableId,
          '500',
        );
        expect(exact.statusCode, exact.payload).toBe(201);
        const body = exact.json() as { remainingAdvanceMinor: string };
        expect(body.remainingAdvanceMinor).toBe('0');
        await expect(projectionOf(customerId)).resolves.toEqual({
          outstanding: '1500',
          advance: '0',
        });
        const s = await summaryOf(customerId);
        expect(s.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
      });

      it('F2: the advances list reports refunded and available amounts that reconcile with the principal', async () => {
        const customerId = await newCustomer('f2');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const refund = await refundOf(customerId, cancelled.advanceIds[0]!, '1500', 'CASH');
        expect(refund.statusCode, refund.payload).toBe(201);
        const advances = await advancesOf(customerId);
        expect(advances).toHaveLength(1);
        expect(advances[0]).toMatchObject({
          customerAdvanceId: cancelled.advanceIds[0],
          sourceType: 'CREDIT_NOTE',
          originalAmountMinor: '2000',
          appliedAmountMinor: '0',
          refundedAmountMinor: '1500',
          reservedAmountMinor: '0',
          availableAmountMinor: '500',
        });
        const s = await summaryOf(customerId);
        expect(s.branchFinancials.advanceAvailableMinor).toBe('500');
        expect(s.branchFinancials.openAdvanceCount).toBe(1);
      });
    });

    // ═══════ G — settlement of a CancellationCharge receivable under concurrency, rollback,
    //          idempotency, projection-version and scope ═══════
    describe('G — charge-receivable settlement: concurrency / rollback / idempotency / scope', () => {
      const totalAppliedTo = async (receivableId: string): Promise<string> =>
        (
          await sql<{ total: string }>(
            `SELECT ((SELECT COALESCE(SUM("amountMinor"),0) FROM customer_receivable_payment_application WHERE "customerReceivableId" = $1)
                   + (SELECT COALESCE(SUM("amountMinor"),0) FROM customer_advance_application WHERE "customerReceivableId" = $1))::text AS total`,
            [receivableId],
          )
        )[0]!.total;

      it('G1: two concurrent receipts racing for ONE charge receivable never over-collect it', async () => {
        const customerId = await newCustomer('g1');
        const charge = await chargeReceivableFor(customerId); // 10500
        const [a, b] = await Promise.all([
          receipt(customerId, '8000', 'CASH'),
          receipt(customerId, '8000', 'CASH'),
        ]);
        expect(a.statusCode, a.payload).toBe(201);
        expect(b.statusCode, b.payload).toBe(201);
        const allocated = [a, b]
          .map((r) => BigInt((r.json() as { allocatedAmountMinor: string }).allocatedAmountMinor))
          .reduce((x, y) => x + y, 0n);
        expect(allocated).toBe(10_500n); // exactly the charge — never 16000
        expect(await totalAppliedTo(charge.receivableId)).toBe('10500');
        await expect(projectionOf(customerId)).resolves.toEqual({ outstanding: '0', advance: '0' });
        const s = await summaryOf(customerId);
        expect(s.branchFinancials.receivableOutstandingMinor).toBe('0');
        expect(s.branchFinancials.unappliedReceiptMinor).toBe('5500'); // 16000 received - 10500 applied
        await integrityHolds(customerId);
      });

      it('G2: two concurrent applications of the SAME CREDIT_NOTE advance to one charge receivable — exactly one wins, the other is a clean 409', async () => {
        const customerId = await newCustomer('g2');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const charge = await chargeReceivableFor(customerId);
        const [a, b] = await Promise.all([
          applyAdvanceTo(customerId, cancelled.advanceIds[0]!, charge.receivableId, '2000'),
          applyAdvanceTo(customerId, cancelled.advanceIds[0]!, charge.receivableId, '2000'),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(errCode(loser)).toBe('CUSTOMER_ADVANCE_APPLICATION_INVALID');
        expect(await totalAppliedTo(charge.receivableId)).toBe('2000');
        await expect(projectionOf(customerId)).resolves.toEqual({
          outstanding: '8500',
          advance: '0',
        });
        await integrityHolds(customerId);
      });

      it('G3: a receipt racing an advance application for the SAME charge receivable can never apply more than the charge in total', async () => {
        const customerId = await newCustomer('g3');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const charge = await chargeReceivableFor(customerId, '1000'); // 1050
        const [rec, app] = await Promise.all([
          receipt(customerId, '1050', 'CASH'),
          applyAdvanceTo(customerId, cancelled.advanceIds[0]!, charge.receivableId, '1050'),
        ]);
        // either order is legal: the receipt always succeeds (it may allocate 0);
        // the application either wins or is a clean 409 — never both in full.
        expect(rec.statusCode, rec.payload).toBe(201);
        expect([201, 409]).toContain(app.statusCode);
        expect(await totalAppliedTo(charge.receivableId)).toBe('1050');
        await expect(projectionOf(customerId)).resolves.toMatchObject({ outstanding: '0' });
        await integrityHolds(customerId);
      });

      it('G4: a failure after the charge-receipt effects rolls back EVERY row (payment, application, entries, journal, audit, outbox, projection)', async () => {
        const customerId = await newCustomer('g4');
        const charge = await chargeReceivableFor(customerId);
        const before = await footprint();
        const projectionBefore = await projectionOf(customerId);
        const collection = app.get(CustomerReceiptCollectionRepository);
        const db = app.get(DbService);
        await expect(
          runScoped(db.appClient(), { tenantId: tenantA }, async (tx) => {
            const r = await collection.collectInTx(tx, {
              tenantId: tenantA,
              companyId: coA,
              branchId: branchA,
              customerId,
              amountMinor: 4000n,
              method: 'CASH',
              createdByUserId: null,
              actingUserId: null,
              idempotencyKey: `rollback-${ik()}`,
            });
            // proof the effects really ran inside the transaction
            expect(r.allocations).toEqual([
              {
                receivableId: charge.receivableId,
                sourceType: 'CANCELLATION_CHARGE',
                amountMinor: 4000n,
              },
            ]);
            throw new Error('forced rollback after charge receipt effects');
          }),
        ).rejects.toThrow('forced rollback');
        expect(await footprint()).toEqual(before);
        expect(await projectionOf(customerId)).toEqual(projectionBefore);
        expect(await totalAppliedTo(charge.receivableId)).toBe('0');
        // the receivable is still fully collectible afterwards
        const ok = await receipt(customerId, '4000', 'CASH');
        expect(ok.statusCode, ok.payload).toBe(201);
        expect(await totalAppliedTo(charge.receivableId)).toBe('4000');
      });

      it('G4b: a failure after a CREDIT_NOTE advance application to a charge receivable rolls back EVERY row', async () => {
        const customerId = await newCustomer('g4b');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const charge = await chargeReceivableFor(customerId);
        const before = await footprint();
        const projectionBefore = await projectionOf(customerId);
        const application = app.get(CustomerAdvanceApplicationRepository);
        const db = app.get(DbService);
        await expect(
          runScoped(db.appClient(), { tenantId: tenantA }, async (tx) => {
            const r = await application.applyInTx(tx, {
              tenantId: tenantA,
              companyId: coA,
              branchId: branchA,
              customerId,
              advanceId: cancelled.advanceIds[0]!,
              customerReceivableId: charge.receivableId,
              amountMinor: 1000n,
              actorUserId: null,
            });
            expect(r.receivableOutstandingMinor).toBe(9500n);
            expect(r.remainingAdvanceMinor).toBe(1000n);
            throw new Error('forced rollback after advance application effects');
          }),
        ).rejects.toThrow('forced rollback');
        expect(await footprint()).toEqual(before);
        expect(await projectionOf(customerId)).toEqual(projectionBefore);
        expect(await totalAppliedTo(charge.receivableId)).toBe('0');
        // and the full 2000 is still applicable afterwards
        const ok = await applyAdvanceTo(
          customerId,
          cancelled.advanceIds[0]!,
          charge.receivableId,
          '2000',
        );
        expect(ok.statusCode, ok.payload).toBe(201);
      });

      it('G5: replaying the SAME Idempotency-Key for a charge receipt / advance application returns the stored result and applies exactly once', async () => {
        const customerId = await newCustomer('g5');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const charge = await chargeReceivableFor(customerId);

        const receiptKey = ik();
        const receiptUrl = `/companies/${coA}/branches/${branchA}/customers/${customerId}/receipts`;
        const r1 = await req(
          'POST',
          receiptUrl,
          closureTok,
          { amountMinor: '3000', method: 'CASH' },
          { 'idempotency-key': receiptKey },
        );
        const r2 = await req(
          'POST',
          receiptUrl,
          closureTok,
          { amountMinor: '3000', method: 'CASH' },
          { 'idempotency-key': receiptKey },
        );
        expect(r1.statusCode, r1.payload).toBe(201);
        expect(r2.statusCode, r2.payload).toBe(201);
        expect(r2.headers['idempotency-replayed']).toBe('true');
        expect((r2.json() as { paymentId: string }).paymentId).toBe(
          (r1.json() as { paymentId: string }).paymentId,
        );

        const applyKey = ik();
        const applyUrl = `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/${cancelled.advanceIds[0]}/applications`;
        const applyBody = { customerReceivableId: charge.receivableId, amountMinor: '1500' };
        const a1 = await req('POST', applyUrl, closureTok, applyBody, {
          'idempotency-key': applyKey,
        });
        const a2 = await req('POST', applyUrl, closureTok, applyBody, {
          'idempotency-key': applyKey,
        });
        expect(a1.statusCode, a1.payload).toBe(201);
        expect(a2.statusCode, a2.payload).toBe(201);
        expect(a2.headers['idempotency-replayed']).toBe('true');
        expect((a2.json() as { applicationId: string }).applicationId).toBe(
          (a1.json() as { applicationId: string }).applicationId,
        );

        // applied exactly ONCE each: 3000 by payment + 1500 by advance
        expect(await totalAppliedTo(charge.receivableId)).toBe('4500');
        await expect(projectionOf(customerId)).resolves.toEqual({
          outstanding: '6000',
          advance: '500',
        });
        await integrityHolds(customerId);
      });

      it("G6: settling a charge receivable never touches the account's credit-configuration `version`", async () => {
        const customerId = await newCustomer('g6');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const charge = await chargeReceivableFor(customerId);
        const versionOf = async (): Promise<string> =>
          (
            await sql<{ v: string }>(
              `SELECT version::text AS v FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
              [customerId, coA],
            )
          )[0]!.v;
        const before = await versionOf();
        expect((await receipt(customerId, '1000', 'CASH')).statusCode).toBe(201);
        expect(
          (await applyAdvanceTo(customerId, cancelled.advanceIds[0]!, charge.receivableId, '500'))
            .statusCode,
        ).toBe(201);
        expect(await versionOf()).toBe(before);
      });

      it("G7: branch isolation — a branch-A charge receivable is invisible to branch B's operational reads and is never touched by a branch-B receipt; the company-scoped credit block still sees it", async () => {
        const customerId = await newCustomer('g7');
        const charge = await chargeReceivableFor(customerId); // branch A, 10500
        const sB = await summaryOf(customerId, branchB);
        expect(sB.branchFinancials).toEqual({
          receivableOutstandingMinor: '0',
          advanceAvailableMinor: '0',
          unappliedReceiptMinor: '0',
          openReceivableCount: 0,
          openAdvanceCount: 0,
        });
        // company-scoped credit exposure is a separate, labelled concept
        expect(sB.credit.creditExposureMinor).toBe('10500');
        expect(sB.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
        expect(await receivablesOf(customerId, branchB)).toHaveLength(0);
        expect((await statementOf(customerId, '?limit=50', branchB)).data).toHaveLength(0);

        // a receipt at branch B has no branch-B receivable to settle: it stays
        // unapplied, and the branch-A charge is untouched
        const rec = await receipt(customerId, '1000', 'CASH', branchB);
        expect(rec.statusCode, rec.payload).toBe(201);
        const recBody = rec.json() as { allocations: unknown[]; unallocatedAmountMinor: string };
        expect(recBody.allocations).toEqual([]);
        expect(recBody.unallocatedAmountMinor).toBe('1000');
        expect(await totalAppliedTo(charge.receivableId)).toBe('0');
        await expect(projectionOf(customerId)).resolves.toEqual({
          outstanding: '10500',
          advance: '0',
        });
      });

      it('G9: the DIRECT invoice-payment route can never collect against a credit-noted (cancelled) invoice — a clean 409 INVOICE_INSUFFICIENT_AVAILABLE_BALANCE and nothing persists', async () => {
        const customerId = await newCustomer('g9');
        const cancelled = await invoiceThenCancel(customerId, null);
        const before = await footprint();
        const res = await directPayment(cancelled.invoiceId, '500');
        expect(res.statusCode, res.payload).toBe(409);
        expect(errCode(res)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        expect(await footprint()).toEqual(before);
        expect(await statusOf(cancelled.invoiceId)).toBe('CANCELLED');
      });

      it('G8: permissions are unchanged — collecting and applying still need their own permissions; a view-only caller can do neither; no standalone CreditNote/Refund/Charge read route exists', async () => {
        const customerId = await newCustomer('g8');
        const cancelled = await invoiceThenCancel(customerId, '2000');
        const charge = await chargeReceivableFor(customerId);
        const viewOnly = await mintTenant('closure-view-only', tenantA, ['receivables:view'], {
          branchScope: 'ALL',
        });
        const collect = await req(
          'POST',
          `/companies/${coA}/branches/${branchA}/customers/${customerId}/receipts`,
          viewOnly,
          { amountMinor: '1000', method: 'CASH' },
          { 'idempotency-key': ik() },
        );
        expect(collect.statusCode).toBe(403);
        const apply = await req(
          'POST',
          `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/${cancelled.advanceIds[0]}/applications`,
          viewOnly,
          { customerReceivableId: charge.receivableId, amountMinor: '500' },
          { 'idempotency-key': ik() },
        );
        expect(apply.statusCode).toBe(403);
        expect(await totalAppliedTo(charge.receivableId)).toBe('0');
        // and a view-only caller CAN read the account (non-disclosing scope unchanged)
        expect((await req('GET', `${acct(customerId)}/summary`, viewOnly)).statusCode).toBe(200);
        // a different tenant cannot read it at all
        const other = await req('GET', `${acct(customerId)}/summary`, tenantBUser);
        expect([401, 403, 404]).toContain(other.statusCode);

        // reserved view permissions get NO standalone read API in this task
        for (const path of [
          `/companies/${coA}/branches/${branchA}/credit-notes`,
          `/companies/${coA}/branches/${branchA}/refunds`,
          `/companies/${coA}/branches/${branchA}/cancellation-charges`,
          `/companies/${coA}/credit-notes`,
          `/companies/${coA}/refunds`,
        ]) {
          const res = await req('GET', path, closureTok);
          expect(res.statusCode, path).toBe(404);
        }
      });
    });

    // ═══════ J — the DIRECT invoice-payment route honours the canonical receivable balance (F1) ═══════
    // `POST .../invoices/:invoiceId/payments` used to compute "available" as
    // `total - allocations - reservations` only: it ignored a CreditNote's AR
    // reduction (and a CustomerAdvance application), let the request through, and
    // surfaced the DB coverage backstop as a raw 500. It now uses the SAME canonical
    // remaining balance as every other receivables consumer, so the request is a
    // clean domain 409 BEFORE any row is written.
    describe('J — direct invoice-payment route x CreditNote / advance application (F1)', () => {
      const invoiceFacts = async (invoiceId: string): Promise<Record<string, string>> =>
        (
          await sql<Record<string, string>>(
            `SELECT "totalAmountMinor"::text AS "totalAmountMinor", "subtotalAmountMinor"::text AS "subtotalAmountMinor",
                    "taxTotalAmountMinor"::text AS "taxTotalAmountMinor", "invoiceNumber", "currencyCode"
               FROM invoice WHERE id = $1`,
            [invoiceId],
          )
        )[0]!;

      /** a customer with an OPEN 2000 invoice whose receivable has ALREADY had
       *  `appliedMinor` of a funded CREDIT_NOTE advance applied to it — the invoice's
       *  remaining AR is therefore `2000 - appliedMinor`, with NO allocation and NO
       *  CreditNote on it. (The advance is funded FIRST, by a separate cancelled
       *  invoice, so FIFO receipt collection cannot route the funding receipt to the
       *  target invoice.) */
      async function invoiceWithAdvanceApplied(
        label: string,
        appliedMinor: string,
      ): Promise<{ customerId: string; invoiceId: string; receivableId: string }> {
        const customerId = await newCustomer(label);
        const funded = await invoiceThenCancel(customerId, '1000');
        const open = await openInvoiceFor(customerId);
        const applied = await applyAdvanceTo(
          customerId,
          funded.advanceIds[0]!,
          open.receivableId,
          appliedMinor,
        );
        expect(applied.statusCode, applied.payload).toBe(201);
        return { customerId, invoiceId: open.invoiceId, receivableId: open.receivableId };
      }

      it('J1: a FULLY cancelled (credit-noted) invoice — a clean 409 INVOICE_INSUFFICIENT_AVAILABLE_BALANCE, never a 500, and ZERO side effects', async () => {
        const customerId = await newCustomer('j1');
        const cancelled = await invoiceThenCancel(customerId, null);
        const factsBefore = await invoiceFacts(cancelled.invoiceId);
        const before = await footprint();
        const res = await directPayment(cancelled.invoiceId, '500');
        expect(res.statusCode, res.payload).toBe(409);
        expect(errCode(res)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        // no PaymentAllocation / Payment / attempt / CustomerAccountEntry / GL / outbox / audit
        expect(await footprint()).toEqual(before);
        // the immutable invoice facts and the credit-noted status are untouched
        expect(await invoiceFacts(cancelled.invoiceId)).toEqual(factsBefore);
        const status = await sql<{ s: string }>(
          `SELECT "invoicePaymentStatus" AS s FROM invoice WHERE id = $1`,
          [cancelled.invoiceId],
        );
        expect(status[0]!.s).toBe('CANCELLED');
        await integrityHolds(customerId);
      });

      it('J2: paid 500 then cancelled (allocation 500 + AR reduction 1500 = total): the remaining AR is exactly 0 — even 1 minor unit is a clean 409 and the released CREDIT_NOTE advance is untouched', async () => {
        const customerId = await newCustomer('j2');
        const cancelled = await invoiceThenCancel(customerId, '500');
        const advanceBefore = await advancesOf(customerId);
        const before = await footprint();
        for (const amount of ['1', '500', '1500']) {
          const res = await directPayment(cancelled.invoiceId, amount);
          expect(res.statusCode, `${amount}: ${res.payload}`).toBe(409);
          expect(errCode(res)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        }
        expect(await footprint()).toEqual(before);
        expect(await allocationTotal(cancelled.invoiceId)).toBe('500');
        expect(await advancesOf(customerId)).toEqual(advanceBefore);
        await integrityHolds(customerId);
      });

      it('J3: PARTIALLY remaining AR (advance 600 applied to a 2000 invoice => 1400 left): paying 1401 is a clean 409 with zero side effects; the legacy `total - allocations` would have let it through to a raw DB error', async () => {
        const { customerId, invoiceId } = await invoiceWithAdvanceApplied('j3', '600');
        // the read model (the canonical loader) and the direct route must agree on the figure
        const row = (await receivablesOf(customerId)).find((r) => r.invoiceId === invoiceId)!;
        expect(row.outstandingMinor).toBe('1400');
        expect(row.paidByAdvanceMinor).toBe('600');
        const before = await footprint();
        const res = await directPayment(invoiceId, '1401');
        expect(res.statusCode, res.payload).toBe(409);
        expect(errCode(res)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        expect(await footprint()).toEqual(before);
        expect(await allocationTotal(invoiceId)).toBe('0');
        await integrityHolds(customerId);
      });

      it('J4: EXACTLY the remaining AR is accepted (201, remaining 0), and one minor unit more is then a clean 409', async () => {
        const { customerId, invoiceId } = await invoiceWithAdvanceApplied('j4', '600');
        const ok = await directPayment(invoiceId, '1400');
        expect(ok.statusCode, ok.payload).toBe(201);
        const body = ok.json() as {
          amountMinor: string;
          remainingAvailableToCollectMinor: string;
          payments: { paymentId: string }[];
        };
        expect(body.amountMinor).toBe('1400');
        expect(body.remainingAvailableToCollectMinor).toBe('0');
        expect(body.payments).toHaveLength(1);
        expect(await allocationTotal(invoiceId)).toBe('1400');
        const before = await footprint();
        const over = await directPayment(invoiceId, '1');
        expect(over.statusCode, over.payload).toBe(409);
        expect(errCode(over)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        expect(await footprint()).toEqual(before);
        // the whole account is consistent: no outstanding left, projections match
        await expect(projectionOf(customerId)).resolves.toMatchObject({ outstanding: '0' });
        await integrityHolds(customerId);
      });

      it('J5: a payment smaller than the remaining AR is accepted and reports the CANONICAL remainder (advance 600 applied, pay 400 -> 1000 still available)', async () => {
        const { customerId, invoiceId } = await invoiceWithAdvanceApplied('j5', '600');
        const ok = await directPayment(invoiceId, '400');
        expect(ok.statusCode, ok.payload).toBe(201);
        expect(
          (ok.json() as { remainingAvailableToCollectMinor: string })
            .remainingAvailableToCollectMinor,
        ).toBe('1000');
        await integrityHolds(customerId);
      });

      it('J6: idempotency — an accepted payment replays (header + body) and is applied exactly once; a REJECTED request releases its key, so retrying it is the same clean 409 (never a stored 500, never a replay)', async () => {
        const { invoiceId } = await invoiceWithAdvanceApplied('j6', '600');

        // accepted + replay
        const key = ik();
        const first = await directPayment(invoiceId, '700', key);
        const replay = await directPayment(invoiceId, '700', key);
        expect(first.statusCode, first.payload).toBe(201);
        expect(replay.statusCode, replay.payload).toBe(201);
        expect(replay.headers['idempotency-replayed']).toBe('true');
        expect(replay.json()).toEqual(first.json());
        expect(await allocationTotal(invoiceId)).toBe('700');

        // rejected (remaining is now 700) — twice with the SAME key
        const badKey = ik();
        const before = await footprint();
        const r1 = await directPayment(invoiceId, '701', badKey);
        const r2 = await directPayment(invoiceId, '701', badKey);
        for (const r of [r1, r2]) {
          expect(r.statusCode, r.payload).toBe(409);
          expect(errCode(r)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
          expect(r.headers['idempotency-replayed']).toBeUndefined();
        }
        expect(await footprint()).toEqual(before);
        // and the exact remainder still goes through afterwards
        const rest = await directPayment(invoiceId, '700');
        expect(rest.statusCode, rest.payload).toBe(201);
        expect(await allocationTotal(invoiceId)).toBe('1400');
      });

      it('J7: two CONCURRENT payments racing for the last 1400 — exactly one wins, the loser is a clean 409, the invoice is never over-covered', async () => {
        const { customerId, invoiceId } = await invoiceWithAdvanceApplied('j7', '600');
        const [a, b] = await Promise.all([
          directPayment(invoiceId, '1400'),
          directPayment(invoiceId, '1400'),
        ]);
        expect([a.statusCode, b.statusCode].sort(), `${a.payload} | ${b.payload}`).toEqual([
          201, 409,
        ]);
        const loser = a.statusCode === 409 ? a : b;
        expect(errCode(loser)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        expect(await allocationTotal(invoiceId)).toBe('1400');
        await integrityHolds(customerId);
      });

      it('J8: a walk-in (no customer, no receivable) invoice keeps its exact pre-existing behaviour: total - allocations, rejection above, acceptance at exactly the remainder', async () => {
        const draft = await req(
          'POST',
          ORD(coA, branchA),
          ownerA,
          { lines: [basicLine({ productId: await productIdFor(variantId) })] },
          { 'idempotency-key': ik() },
        );
        expect(draft.statusCode, draft.payload).toBe(201);
        const orderId = (draft.json() as { order: { id: string } }).order.id;
        const invoiceId = await issueInvoiceOf(orderId); // 2000, walk-in
        expect((await directPayment(invoiceId, '2001')).statusCode).toBe(409);
        expect((await directPayment(invoiceId, '1500')).statusCode).toBe(201);
        const over = await directPayment(invoiceId, '501');
        expect(over.statusCode, over.payload).toBe(409);
        expect(errCode(over)).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        expect((await directPayment(invoiceId, '500')).statusCode).toBe(201);
        expect(await allocationTotal(invoiceId)).toBe('2000');
      });

      // The post-invoice cancellation locks order -> invoice, the direct-payment path locks
      // invoice -> (order FK check); under a true race Postgres can pick EITHER as a
      // `40P01 deadlock detected` victim — an open finding reported to the owner (a lock-order
      // inversion that predates and is independent of the F1 availability fix). This test
      // pins what must hold WHATEVER the interleaving or victim: a deadlock victim rolls back
      // COMPLETELY, so the invoice is never over-covered, a full cancellation closes it
      // exactly, nothing is half-written and the account projections stay consistent. It
      // deliberately asserts on the persisted state, not on the status codes.
      it('J9: a direct payment RACING the post-invoice cancellation of the same invoice — whatever the interleaving, the invoice is never over-covered and the account stays consistent', async () => {
        for (let i = 0; i < 4; i++) {
          const customerId = await newCustomer(`j9-${i}`);
          const open = await openInvoiceFor(customerId);
          const [pay, cancel] = await Promise.all([
            directPayment(open.invoiceId, '500'),
            cancelInvoicedOrder(open.orderId),
          ]);
          const row = (
            await sql<{ total: string; alloc: string; cnAr: string; cnCount: string }>(
              `SELECT i."totalAmountMinor"::text AS total,
                      COALESCE((SELECT SUM(pa."amountMinor") FROM payment_allocation pa WHERE pa."invoiceId" = i.id), 0)::text AS alloc,
                      COALESCE((SELECT SUM(cn."arReductionMinor") FROM credit_note cn WHERE cn."invoiceId" = i.id), 0)::text AS "cnAr",
                      (SELECT count(*) FROM credit_note cn WHERE cn."invoiceId" = i.id)::text AS "cnCount"
                 FROM invoice i WHERE i.id = $1`,
              [open.invoiceId],
            )
          )[0]!;
          const total = BigInt(row.total);
          const alloc = BigInt(row.alloc);
          const cnAr = BigInt(row.cnAr);
          const label = `iteration ${i}: pay=${pay.statusCode} cancel=${cancel.statusCode}`;
          // never over-covered
          expect(alloc + cnAr <= total, label).toBe(true);
          // a payment is all-or-nothing: 500 on the invoice, or none
          expect([0n, 500n], label).toContain(alloc);
          if (pay.statusCode === 201) expect(alloc, label).toBe(500n);
          if (pay.statusCode !== 201) expect(alloc, label).toBe(0n);
          // a cancellation is all-or-nothing, and a FULL one closes the invoice EXACTLY
          if (cancel.statusCode === 200) {
            expect(row.cnCount, label).toBe('1');
            expect(alloc + cnAr, label).toBe(total);
            // whatever was already paid is released into exactly one CREDIT_NOTE advance
            const released = await sql<{ n: string; total: string }>(
              `SELECT count(*)::text AS n, COALESCE(SUM(ca."amountMinor"), 0)::text AS total
                 FROM credit_note_coverage_release r
                 JOIN credit_note cn ON cn.id = r."creditNoteId"
                 JOIN customer_advance ca ON ca.id = r."customerAdvanceId"
                WHERE cn."invoiceId" = $1`,
              [open.invoiceId],
            );
            expect(BigInt(released[0]!.total), label).toBe(alloc);
            expect(released[0]!.n, label).toBe(alloc > 0n ? '1' : '0');
          } else {
            expect(row.cnCount, label).toBe('0');
            expect(cnAr, label).toBe(0n);
          }
          await integrityHolds(customerId);
        }
      });
    });

    // ═══════ K — settlement finality of a CREDIT_NOTE advance applied to another invoice (F2) ═══════
    // PAID != SETTLED (3b.7). An invoice covered by a CREDIT_NOTE-sourced CustomerAdvance used
    // to stay PAID forever: the 3b.7 resolver only understood PAYMENT- and OPENING-sourced
    // advances and read a CREDIT_NOTE advance's NULL `sourcePaymentId` as "not final". Its
    // finality is now traced through its single CreditNoteCoverageRelease — the provenance of
    // exactly which prior coverage the CreditNote converted into it — with the EXISTING 3b.7
    // predicate (CASH / BANK_TRANSFER final; OTHER_MANUAL never; ONLINE_GATEWAY / CARD_TERMINAL
    // only once the WHOLE source Payment is covered by FINALIZED settlements; an OPENING
    // provenance is immediately final). One unsettled component blocks SETTLED, and the status
    // stays DERIVED: nothing here ever writes a Payment / Allocation / Application /
    // SettlementApplication.
    describe('K — settlement finality of a CREDIT_NOTE advance applied to another invoice (F2)', () => {
      it.each(['CASH', 'BANK_TRANSFER'] as const)(
        'K1 (%s): a CREDIT_NOTE advance funded by a receipt of that method makes the invoice it covers SETTLED — not stuck at PAID',
        async (method) => {
          const customerId = await newCustomer(`k1-${method}`);
          const funded = await invoiceThenCancel(customerId, '1000', method);
          const release = await releasedAdvanceOf(funded.invoiceId);
          expect(release.sourceKind).toBe('PAYMENT_ALLOCATION');
          const target = await openInvoiceFor(customerId);
          await applyOk(customerId, release.advanceId, target.receivableId, '1000');
          expect(await statusOf(target.invoiceId)).toBe('PARTIAL');
          const pay = await directPayment(target.invoiceId, '1000', ik(), method);
          expect(pay.statusCode, pay.payload).toBe(201);
          expect(await statusOf(target.invoiceId)).toBe('SETTLED');
          await integrityHolds(customerId);
        },
      );

      it('K2: an OTHER_MANUAL provenance is NEVER settlement-final — the covered invoice stays PAID (the 3b.7 rule, unchanged)', async () => {
        const customerId = await newCustomer('k2');
        const funded = await invoiceThenCancel(customerId, '1000', 'OTHER_MANUAL');
        const target = await openInvoiceFor(customerId);
        await applyOk(customerId, funded.advanceIds[0]!, target.receivableId, '1000');
        const pay = await directPayment(target.invoiceId, '1000', ik(), 'CASH');
        expect(pay.statusCode, pay.payload).toBe(201);
        expect(await statusOf(target.invoiceId)).toBe('PAID');
      });

      it.each(['ONLINE_GATEWAY', 'CARD_TERMINAL'] as const)(
        'K3 (%s): a provider provenance whose Payment is NOT yet settlement-final keeps the covered invoice at PAID',
        async (method) => {
          const customerId = await newCustomer(`k3-${method}`);
          const p = await providerPaidInvoice(customerId, method);
          await cancelOk(p.orderId);
          const release = await releasedAdvanceOf(p.invoiceId);
          expect(release.sourceKind).toBe('PAYMENT_ALLOCATION');
          expect(release.sourcePaymentId).toBe(p.paymentId);
          const target = await openInvoiceFor(customerId);
          await applyOk(customerId, release.advanceId, target.receivableId, '2000');
          expect(await statusOf(target.invoiceId)).toBe('PAID');
          await integrityHolds(customerId);
        },
      );

      it('K4: a provider provenance whose Payment is ALREADY settlement-final at application time makes the covered invoice SETTLED', async () => {
        const customerId = await newCustomer('k4');
        const p = await providerPaidInvoice(customerId);
        await seedSettlement(p.paymentId, 'FINALIZED');
        await cancelOk(p.orderId);
        const release = await releasedAdvanceOf(p.invoiceId);
        const target = await openInvoiceFor(customerId);
        await applyOk(customerId, release.advanceId, target.receivableId, '2000');
        expect(await statusOf(target.invoiceId)).toBe('SETTLED');
        await integrityHolds(customerId);
      });

      it('K5: PAID while the provider Payment is unsettled — then the REAL settlement finalization promotes the covered invoice to SETTLED in the same transaction (discovery Path C)', async () => {
        const customerId = await newCustomer('k5');
        const p = await providerPaidInvoice(customerId);
        const batchId = await seedSettlement(p.paymentId, 'DRAFT');
        await cancelOk(p.orderId);
        const cancelledStatus = await statusOf(p.invoiceId);
        const release = await releasedAdvanceOf(p.invoiceId);
        const target = await openInvoiceFor(customerId);
        await applyOk(customerId, release.advanceId, target.receivableId, '2000');
        expect(await statusOf(target.invoiceId)).toBe('PAID');

        await finalizeBatch(batchId);

        expect(await statusOf(target.invoiceId)).toBe('SETTLED');
        // the cancelled invoice is untouched by the finalization's projection
        expect(await statusOf(p.invoiceId)).toBe(cancelledStatus);
        const batch = await sql<{ state: string; apps: string }>(
          `SELECT sb.state, (SELECT count(*)::text FROM settlement_application sa WHERE sa."batchId" = sb.id) AS apps
             FROM settlement_batch sb WHERE sb.id = $1`,
          [batchId],
        );
        expect(batch[0]).toEqual({ state: 'FINALIZED', apps: '1' });
        await integrityHolds(customerId);
      });

      it('K6: ONE unsettled component blocks SETTLED — a CASH-provenance advance (final) + a provider-provenance advance (unsettled) stay PAID until the provider Payment settles, then SETTLED', async () => {
        const customerId = await newCustomer('k6');
        const cash = await invoiceThenCancel(customerId, '1000', 'CASH');
        const p = await providerPaidInvoice(customerId);
        const batchId = await seedSettlement(p.paymentId, 'DRAFT');
        await cancelOk(p.orderId);
        const provider = await releasedAdvanceOf(p.invoiceId);
        const target = await openInvoiceFor(customerId);

        await applyOk(customerId, cash.advanceIds[0]!, target.receivableId, '1000');
        expect(await statusOf(target.invoiceId)).toBe('PARTIAL');
        await applyOk(customerId, provider.advanceId, target.receivableId, '1000');
        expect(await statusOf(target.invoiceId)).toBe('PAID'); // CASH part final, provider part NOT

        await finalizeBatch(batchId);
        expect(await statusOf(target.invoiceId)).toBe('SETTLED');
        await integrityHolds(customerId);
      });

      it('K7: an OPENING-advance provenance (OPENING_ADVANCE release) is immediately final — the covered invoice is SETTLED', async () => {
        const customerId = await newCustomer('k7');
        const ob = await req(
          'POST',
          `/companies/${coA}/branches/${branchA}/customers/${customerId}/opening-balance`,
          openingTok,
          { type: 'ADVANCE', amountMinor: '1000', effectiveDate: '2026-01-01' },
          { 'idempotency-key': ik() },
        );
        expect(ob.statusCode, ob.payload).toBe(201);
        const openingAdvanceId = (ob.json() as { sourceId: string }).sourceId;
        const first = await openInvoiceFor(customerId);
        await applyOk(customerId, openingAdvanceId, first.receivableId, '1000');
        await cancelOk(first.orderId);
        const release = await releasedAdvanceOf(first.invoiceId);
        expect(release.sourceKind).toBe('OPENING_ADVANCE');
        expect(release.sourcePaymentId).toBeNull();

        const target = await openInvoiceFor(customerId);
        await applyOk(customerId, release.advanceId, target.receivableId, '1000');
        const pay = await directPayment(target.invoiceId, '1000', ik(), 'CASH');
        expect(pay.statusCode, pay.payload).toBe(201);
        expect(await statusOf(target.invoiceId)).toBe('SETTLED');
        await integrityHolds(customerId);
      });

      it.each([
        ['CASH', 'SETTLED'],
        ['OTHER_MANUAL', 'PAID'],
      ] as const)(
        'K8 (%s receipt): a PAYMENT-sourced advance applied to an invoice that is then cancelled — the released CREDIT_NOTE advance inherits THAT source finality (-> %s)',
        async (method, expected) => {
          const customerId = await newCustomer(`k8-${method}`);
          const rcpt = await receipt(customerId, '1000', method); // no open receivable -> fully unapplied
          expect(rcpt.statusCode, rcpt.payload).toBe(201);
          const paymentId = (rcpt.json() as { paymentId: string }).paymentId;
          const conv = await req(
            'POST',
            `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/from-payment`,
            closureTok,
            { paymentId, amountMinor: '1000' },
            { 'idempotency-key': ik() },
          );
          expect(conv.statusCode, conv.payload).toBe(201);
          const paymentAdvanceId = (conv.json() as { advanceId: string }).advanceId;

          const first = await openInvoiceFor(customerId);
          await applyOk(customerId, paymentAdvanceId, first.receivableId, '1000');
          await cancelOk(first.orderId);
          const release = await releasedAdvanceOf(first.invoiceId);
          expect(release.sourceKind).toBe('ADVANCE_APPLICATION');
          expect(release.sourcePaymentId).toBe(paymentId);

          const target = await openInvoiceFor(customerId);
          await applyOk(customerId, release.advanceId, target.receivableId, '1000');
          const pay = await directPayment(target.invoiceId, '1000', ik(), 'CASH');
          expect(pay.statusCode, pay.payload).toBe(201);
          expect(await statusOf(target.invoiceId)).toBe(expected);
          await integrityHolds(customerId);
        },
      );

      it('K9: cancellation, advance application and refund never mutate a SettlementBatch / SettlementApplication (status is derived; the settlement fact is immutable)', async () => {
        const customerId = await newCustomer('k9');
        const p = await providerPaidInvoice(customerId);
        await seedSettlement(p.paymentId, 'FINALIZED');
        const snapshot = async (): Promise<unknown[]> =>
          sql(
            `SELECT sa.id, sa."amountMinor"::text AS amount, sa."paymentId", sb.id AS "batchId", sb.state,
                    sb.version::text AS version, sb."journalEntryId"
               FROM settlement_application sa JOIN settlement_batch sb ON sb.id = sa."batchId"
              WHERE sa."paymentId" = $1 ORDER BY sa.id`,
            [p.paymentId],
          );
        const totals = async (): Promise<unknown> =>
          (
            await sql(
              `SELECT (SELECT count(*) FROM settlement_batch)::text AS batches,
                      (SELECT count(*) FROM settlement_line)::text AS lines,
                      (SELECT count(*) FROM settlement_application)::text AS apps`,
            )
          )[0];
        const before = await snapshot();
        const totalsBefore = await totals();
        expect(before).toHaveLength(1);

        await cancelOk(p.orderId);
        expect(await snapshot()).toEqual(before);

        const release = await releasedAdvanceOf(p.invoiceId);
        const target = await openInvoiceFor(customerId);
        await applyOk(customerId, release.advanceId, target.receivableId, '1000');
        expect(await snapshot()).toEqual(before);

        const refund = await refundOf(customerId, release.advanceId, '1000', 'CASH');
        expect(refund.statusCode, refund.payload).toBe(201);
        expect(await snapshot()).toEqual(before);
        expect(await totals()).toEqual(totalsBefore);
        await integrityHolds(customerId);
      });

      it('K11: settlement finalization RACING the application of its CREDIT_NOTE advance — whatever the interleaving, the covered invoice ends SETTLED (never stuck at PAID), and nothing is a server error', async () => {
        for (let i = 0; i < 3; i++) {
          const customerId = await newCustomer(`k11-${i}`);
          const p = await providerPaidInvoice(customerId);
          const batchId = await seedSettlement(p.paymentId, 'DRAFT');
          await cancelOk(p.orderId);
          const release = await releasedAdvanceOf(p.invoiceId);
          const target = await openInvoiceFor(customerId);

          const [applied, finalized] = await Promise.allSettled([
            applyAdvanceTo(customerId, release.advanceId, target.receivableId, '2000'),
            finalizeBatch(batchId),
          ]);
          const label = `iteration ${i}`;
          expect(applied.status, label).toBe('fulfilled');
          const application = (
            applied as PromiseFulfilledResult<{ statusCode: number; payload: string }>
          ).value;
          expect(application.statusCode, `${label}: ${application.payload}`).toBe(201);
          // a finalization that lost the stable-set race aborts CLEANLY (the documented 3b.7
          // retry contract) and is simply retried; anything else would be a defect
          if (finalized.status === 'rejected') {
            expect((finalized.reason as { code?: string }).code, label).toBe(
              'SETTLEMENT_CONCURRENT_COVERAGE_CHANGE',
            );
            await finalizeBatch(batchId);
          }
          expect(await statusOf(target.invoiceId), label).toBe('SETTLED');
          const batch = await sql<{ state: string; apps: string }>(
            `SELECT sb.state, (SELECT count(*)::text FROM settlement_application sa WHERE sa."batchId" = sb.id) AS apps
               FROM settlement_batch sb WHERE sb.id = $1`,
            [batchId],
          );
          expect(batch[0], label).toEqual({ state: 'FINALIZED', apps: '1' });
          await integrityHolds(customerId);
        }
      });

      it('K10: historical reconciliation heals an invoice left at PAID by the old resolver — it reuses the SAME resolver (no second finality predicate)', async () => {
        const customerId = await newCustomer('k10');
        const p = await providerPaidInvoice(customerId);
        await cancelOk(p.orderId);
        const release = await releasedAdvanceOf(p.invoiceId);
        const target = await openInvoiceFor(customerId);
        await applyOk(customerId, release.advanceId, target.receivableId, '2000');
        expect(await statusOf(target.invoiceId)).toBe('PAID');

        // the provider Payment becomes settlement-final WITHOUT this invoice being recomputed
        // (what happened before F2: finalization could not discover this coverage path)
        await seedSettlement(p.paymentId, 'FINALIZED');
        expect(await statusOf(target.invoiceId)).toBe('PAID');

        const reconciliation = app.get(HistoricalSettlementReconciliationRepository);
        let cursor: string | null = null;
        for (;;) {
          const page = await reconciliation.runBatch({
            tenantId: tenantA,
            companyId: coA,
            branchId: branchA,
            cursor,
            limit: 100,
          });
          if (!page.hasMore) break;
          cursor = page.nextCursor;
        }
        expect(await statusOf(target.invoiceId)).toBe('SETTLED');
      });
    });

    // ═══════ L — payment vs post-invoice cancellation: the ORDER → INVOICE lock hierarchy (F4) ═══════
    // The post-invoice cancellation locks ORDER -> INVOICE; the direct-payment and async-reservation
    // paths used to lock INVOICE first and reach the order only through the foreign key of the
    // `payment_attempt` row they insert — an opposite-order pair of independent transactions, i.e. a
    // textbook deadlock (about 3 races in 4 produced a `40P01`, surfaced as a 500). They now take the
    // ORDER lock first (see `payment-target-lock.repository.ts` for the full lock graph).
    //
    // These are REAL concurrent requests against real PostgreSQL, repeated well past the repository's
    // usual stress count, with the arrival order varied (simultaneous, payment first, cancellation
    // first). BOTH serialized outcomes are financially valid and neither is forced:
    //   - the payment commits first  -> the cancellation observes the committed payment and credits /
    //     releases it into a CREDIT_NOTE advance;
    //   - the cancellation commits first -> the later payment is a clean 409 against zero collectible AR.
    // What is required EVERY run: no deadlock, no 500, no half-written state, the invoice closed
    // exactly, nothing lost and nothing duplicated, balanced GL, atomic audit, exact entitlement.
    describe('L — payment vs post-invoice cancellation: the ORDER → INVOICE lock hierarchy (F4)', () => {
      // the same id the refund / K describes seed (ON CONFLICT DO NOTHING)
      const PROVIDER_CRED_L = '00000000-0000-7000-9000-0000000003b8';
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const deadlockCount = async (): Promise<number> =>
        Number(
          (
            await sql<{ d: string }>(
              `SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()`,
            )
          )[0]!.d,
        );
      let deadlocksBefore = 0;
      const cnNumbersSeen = new Set<string>();

      /** [payment delay, cancellation delay] in ms — true simultaneity and both arrival orders */
      const SCHEDULE: readonly (readonly [number, number])[] = [
        [0, 0],
        [40, 0],
        [0, 40],
        [0, 0],
        [15, 0],
        [0, 15],
      ];
      const delayed = <T>(ms: number, fn: () => Promise<T>): Promise<T> => sleep(ms).then(fn);

      beforeAll(async () => {
        await sql(
          `INSERT INTO provider_credential
             (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
           VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())
           ON CONFLICT (id) DO NOTHING`,
          [PROVIDER_CRED_L, tenantA, coA, branchA],
        );
        deadlocksBefore = await deadlockCount();
      }, 60_000);

      type HttpResult = { statusCode: number; payload: string; json: () => unknown };

      /** every persisted fact of ONE invoice after a payment-vs-cancellation race */
      async function expectConsistentAfterRace(
        label: string,
        customerId: string,
        target: { orderId: string; invoiceId: string },
        pay: HttpResult,
        cancel: HttpResult,
        priorPaidMinor: bigint,
      ): Promise<void> {
        // transport: no server error of any kind — the cancellation always succeeds (in BOTH
        // serialized orders) and the payment is either recorded or a clean domain rejection
        expect(cancel.statusCode, `${label}: cancel ${cancel.payload}`).toBe(200);
        expect([201, 409], `${label}: payment ${pay.payload}`).toContain(pay.statusCode);
        if (pay.statusCode === 409) {
          expect(errCode(pay), label).toBe('INVOICE_INSUFFICIENT_AVAILABLE_BALANCE');
        }
        const paidNow = pay.statusCode === 201 ? 500n : 0n;

        const total = BigInt(
          (
            await sql<{ t: string }>(
              `SELECT "totalAmountMinor"::text AS t FROM invoice WHERE id = $1`,
              [target.invoiceId],
            )
          )[0]!.t,
        );
        const allocs = await sql<{ id: string; paymentId: string; amount: string }>(
          `SELECT id, "paymentId", "amountMinor"::text AS amount FROM payment_allocation WHERE "invoiceId" = $1 ORDER BY id`,
          [target.invoiceId],
        );
        const attempts = await sql<{ id: string; state: string }>(
          `SELECT id, state FROM payment_attempt WHERE "targetInvoiceId" = $1`,
          [target.invoiceId],
        );
        const cns = await sql<{ id: string; num: string; ar: string; excess: string }>(
          `SELECT id, "creditNoteNumber" AS num, "arReductionMinor"::text AS ar, "advanceExcessMinor"::text AS excess
             FROM credit_note WHERE "invoiceId" = $1`,
          [target.invoiceId],
        );
        const releases = await sql<{
          id: string;
          kind: string;
          allocationId: string | null;
          amount: string;
          advanceId: string;
          paymentId: string | null;
        }>(
          `SELECT r.id, r."sourceKind" AS kind, r."sourcePaymentAllocationId" AS "allocationId",
                  r."releasedAmountMinor"::text AS amount, r."customerAdvanceId" AS "advanceId",
                  r."sourcePaymentId" AS "paymentId"
             FROM credit_note_coverage_release r JOIN credit_note cn ON cn.id = r."creditNoteId"
            WHERE cn."invoiceId" = $1`,
          [target.invoiceId],
        );

        // no partial allocation, no over-collection, no lost payment
        const paid = allocs.reduce((acc, a) => acc + BigInt(a.amount), 0n);
        expect(paid, `${label}: collected`).toBe(priorPaidMinor + paidNow);
        expect(paid <= total, label).toBe(true);
        expect(attempts, `${label}: direct attempts`).toHaveLength(paidNow > 0n ? 1 : 0);
        for (const a of attempts) expect(a.state, label).toBe('CAPTURED');

        // exactly ONE credit note, a unique gapless number, the invoice closed EXACTLY, everything
        // that was paid released
        expect(cns, `${label}: credit notes`).toHaveLength(1);
        const cn = cns[0]!;
        expect(cnNumbersSeen.has(cn.num), `${label}: duplicate credit note number ${cn.num}`).toBe(
          false,
        );
        cnNumbersSeen.add(cn.num);
        expect(paid + BigInt(cn.ar), `${label}: invoice closed exactly`).toBe(total);
        expect(BigInt(cn.excess), `${label}: released value`).toBe(paid);
        // no cancellation charge was requested — and none may appear half-written
        expect(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM cancellation_charge WHERE "orderId" = $1`,
              [target.orderId],
            )
          )[0]!.n,
          `${label}: no partial CancellationCharge`,
        ).toBe('0');

        // exactly one release per allocation (the allocation's full amount, its own payment, the
        // ultimate provenance — never invented), each funding exactly ONE unconsumed advance
        expect(releases, `${label}: releases`).toHaveLength(allocs.length);
        for (const a of allocs) {
          const r = releases.find((x) => x.allocationId === a.id);
          expect(r, `${label}: release of allocation ${a.id}`).toBeDefined();
          expect(r!.kind, label).toBe('PAYMENT_ALLOCATION');
          expect(r!.amount, label).toBe(a.amount);
          expect(r!.paymentId, label).toBe(a.paymentId);
        }
        expect(new Set(releases.map((r) => r.advanceId)).size, `${label}: advances`).toBe(
          releases.length,
        );
        const advanceRows = releases.length
          ? await sql<{ amount: string; applied: string }>(
              `SELECT ca."amountMinor"::text AS amount,
                      COALESCE((SELECT SUM(caa."amountMinor") FROM customer_advance_application caa WHERE caa."customerAdvanceId" = ca.id), 0)::text AS applied
                 FROM customer_advance ca WHERE ca.id = ANY($1::uuid[])`,
              [releases.map((r) => r.advanceId)],
            )
          : [];
        expect(
          advanceRows.reduce((acc, r) => acc + BigInt(r.amount), 0n),
          `${label}: customer entitlement`,
        ).toBe(paid);
        for (const r of advanceRows) expect(r.applied, label).toBe('0');

        // the customer account: nothing outstanding, entitlement exact, projections equal the sums
        await expect(projectionOf(customerId), label).resolves.toEqual({
          outstanding: '0',
          advance: paid.toString(),
        });
        const advances = await advancesOf(customerId);
        expect(
          advances.reduce((acc, a) => acc + BigInt(a.availableAmountMinor), 0n),
          `${label}: spendable entitlement`,
        ).toBe(paid);
        await integrityHolds(customerId);

        // GL: every journal tied to this race is balanced, the credit note posted exactly once,
        // and a recorded payment has its journal
        const paymentIds = allocs.map((a) => a.paymentId);
        const sourceIds = [
          cn.id,
          ...paymentIds,
          ...allocs.map((a) => a.id),
          ...attempts.map((a) => a.id),
        ];
        const journals = await sql<{ id: string; kind: string; d: string; c: string }>(
          `SELECT je.id, je."sourceKind" AS kind, SUM(jl."debitMinor")::text AS d, SUM(jl."creditMinor")::text AS c
             FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
            WHERE je."sourceId"::text = ANY($1::text[]) GROUP BY je.id, je."sourceKind"`,
          [sourceIds],
        );
        for (const j of journals) expect(j.d, `${label}: journal ${j.kind} balanced`).toBe(j.c);
        expect(
          journals.filter((j) => j.kind === 'credit_note'),
          `${label}: credit note GL`,
        ).toHaveLength(1);
        if (paidNow > 0n) {
          expect(journals.length, `${label}: payment GL`).toBeGreaterThan(1);
        }

        // audit is atomic with its business row: exactly one of each, nothing for the rejected side
        const resourceIds = [cn.id, target.orderId, ...attempts.map((a) => a.id)];
        const directPaymentId =
          pay.statusCode === 201
            ? (pay.json() as { payments: { paymentId: string }[] }).payments[0]!.paymentId
            : null;
        if (directPaymentId) resourceIds.push(directPaymentId);
        const audits = await sql<{ action: string; n: string }>(
          `SELECT action, count(*)::text AS n FROM audit_log WHERE "resourceId"::text = ANY($1::text[]) GROUP BY action`,
          [resourceIds],
        );
        const auditCount = (action: string): number =>
          Number(audits.find((a) => a.action === action)?.n ?? '0');
        expect(auditCount('credit_note.issued'), `${label}: credit_note.issued`).toBe(1);
        expect(auditCount('order.cancelled'), `${label}: order.cancelled`).toBe(1);
        expect(auditCount('payment.recorded'), `${label}: payment.recorded`).toBe(
          paidNow > 0n ? 1 : 0,
        );
        expect(auditCount('payment_attempt.state_changed'), `${label}: attempt audit`).toBe(
          paidNow > 0n ? 1 : 0,
        );
      }

      it('L1: 24 repeated direct-payment-vs-cancellation races on the SAME invoice — never a deadlock or a 500, both serialized outcomes valid, every invariant exact', async () => {
        let paymentFirst = 0;
        let cancellationFirst = 0;
        for (let i = 0; i < 24; i++) {
          const customerId = await newCustomer(`l1-${i}`);
          const open = await openInvoiceFor(customerId);
          const [payDelay, cancelDelay] = SCHEDULE[i % SCHEDULE.length]!;
          const [pay, cancel] = await Promise.all([
            delayed(payDelay, () => directPayment(open.invoiceId, '500')),
            delayed(cancelDelay, () => cancelInvoicedOrder(open.orderId)),
          ]);
          await expectConsistentAfterRace(`L1 iteration ${i}`, customerId, open, pay, cancel, 0n);
          if (pay.statusCode === 201) paymentFirst += 1;
          else cancellationFirst += 1;
        }
        // the race is genuinely exercised in BOTH serialization orders
        expect(paymentFirst, 'payment-commits-first outcomes').toBeGreaterThan(0);
        expect(cancellationFirst, 'cancellation-commits-first outcomes').toBeGreaterThan(0);
      }, 600_000);

      it('L2: 12 async-reservation-vs-cancellation races on the SAME invoice — never a deadlock or a server error; a reservation is recorded whole or cleanly rejected', async () => {
        const reservations = app.get(PaymentAttemptReservationRepository);
        const db = app.get(DbService);
        let reservedFirst = 0;
        let cancellationFirst = 0;
        for (let i = 0; i < 12; i++) {
          const customerId = await newCustomer(`l2-${i}`);
          const open = await openInvoiceFor(customerId);
          const [reserveDelay, cancelDelay] = SCHEDULE[i % SCHEDULE.length]!;
          const [reserved, cancel] = await Promise.allSettled([
            delayed(reserveDelay, () =>
              runScoped(db.appClient(), { tenantId: tenantA, branchId: branchA }, (tx) =>
                reservations.reserveAsyncAttemptInTx(tx, {
                  tenantId: tenantA,
                  companyId: coA,
                  branchId: branchA,
                  invoiceId: open.invoiceId,
                  method: 'ONLINE_GATEWAY',
                  amountMinor: 500n,
                  providerKey: 'tap',
                  providerCredentialId: PROVIDER_CRED_L,
                  createdByUserId: crypto.randomUUID(),
                  actingUserId: null,
                  idempotencyKey: `l2-${ik()}`,
                }),
              ),
            ),
            delayed(cancelDelay, () => cancelInvoicedOrder(open.orderId)),
          ]);
          const label = `L2 iteration ${i}`;
          expect(cancel.status, label).toBe('fulfilled');
          const cancelResult = (cancel as PromiseFulfilledResult<HttpResult>).value;
          expect(cancelResult.statusCode, `${label}: ${cancelResult.payload}`).toBe(200);
          let recorded = false;
          if (reserved.status === 'fulfilled') {
            recorded = true;
            expect(reserved.value.state, label).toBe('PENDING');
            reservedFirst += 1;
          } else {
            expect(reserved.reason, label).toMatchObject({
              code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
              status: 409,
            });
            cancellationFirst += 1;
          }

          const attempts = await sql<{ id: string; state: string }>(
            `SELECT id, state FROM payment_attempt WHERE "targetInvoiceId" = $1`,
            [open.invoiceId],
          );
          expect(attempts, `${label}: reservations`).toHaveLength(recorded ? 1 : 0);
          for (const a of attempts) expect(a.state, label).toBe('PENDING');
          // a reservation moves no money: no payment, no allocation; the whole invoice was credited
          expect(await allocationTotal(open.invoiceId), label).toBe('0');
          const cns = await sql<{ id: string; num: string; ar: string; excess: string }>(
            `SELECT id, "creditNoteNumber" AS num, "arReductionMinor"::text AS ar, "advanceExcessMinor"::text AS excess
               FROM credit_note WHERE "invoiceId" = $1`,
            [open.invoiceId],
          );
          expect(cns, `${label}: credit notes`).toHaveLength(1);
          expect(cnNumbersSeen.has(cns[0]!.num), `${label}: duplicate number`).toBe(false);
          cnNumbersSeen.add(cns[0]!.num);
          expect(cns[0]!.ar, label).toBe('2000');
          expect(cns[0]!.excess, label).toBe('0');
          expect(
            (
              await sql<{ n: string }>(
                `SELECT count(*)::text AS n FROM cancellation_charge WHERE "orderId" = $1`,
                [open.orderId],
              )
            )[0]!.n,
            `${label}: no partial CancellationCharge`,
          ).toBe('0');
          await expect(projectionOf(customerId), label).resolves.toEqual({
            outstanding: '0',
            advance: '0',
          });
          await integrityHolds(customerId);
          const audits = await sql<{ action: string; n: string }>(
            `SELECT action, count(*)::text AS n FROM audit_log WHERE "resourceId"::text = ANY($1::text[]) GROUP BY action`,
            [[cns[0]!.id, open.orderId, ...attempts.map((a) => a.id)]],
          );
          const auditCount = (action: string): number =>
            Number(audits.find((a) => a.action === action)?.n ?? '0');
          expect(auditCount('credit_note.issued'), label).toBe(1);
          expect(auditCount('order.cancelled'), label).toBe(1);
          expect(auditCount('payment_attempt.reserved'), label).toBe(recorded ? 1 : 0);
        }
        expect(reservedFirst, 'reservation-commits-first outcomes').toBeGreaterThan(0);
        expect(cancellationFirst, 'cancellation-commits-first outcomes').toBeGreaterThan(0);
      }, 600_000);

      it('L3: 12 races on a PARTLY PAID invoice (700 already collected) — the cancellation releases every paid source exactly once whichever side wins; entitlement is exact', async () => {
        for (let i = 0; i < 12; i++) {
          const customerId = await newCustomer(`l3-${i}`);
          const open = await openInvoiceFor(customerId);
          const prior = await receipt(customerId, '700', 'CASH');
          expect(prior.statusCode, prior.payload).toBe(201);
          const [payDelay, cancelDelay] = SCHEDULE[i % SCHEDULE.length]!;
          const [pay, cancel] = await Promise.all([
            delayed(payDelay, () => directPayment(open.invoiceId, '500')),
            delayed(cancelDelay, () => cancelInvoicedOrder(open.orderId)),
          ]);
          await expectConsistentAfterRace(`L3 iteration ${i}`, customerId, open, pay, cancel, 700n);
        }
      }, 600_000);

      it("L5: 12 customer-RECEIPT-vs-cancellation races (FIFO collection locks invoice -> account, the cancellation order -> invoice -> account) — never a deadlock or a 500; the customer's 500 is conserved whichever side wins", async () => {
        for (let i = 0; i < 12; i++) {
          const label = `L5 iteration ${i}`;
          const customerId = await newCustomer(`l5-${i}`);
          const open = await openInvoiceFor(customerId);
          const [payDelay, cancelDelay] = SCHEDULE[i % SCHEDULE.length]!;
          const [rcpt, cancel] = await Promise.all([
            delayed(payDelay, () => receipt(customerId, '500', 'CASH')),
            delayed(cancelDelay, () => cancelInvoicedOrder(open.orderId)),
          ]);
          expect(rcpt.statusCode, `${label}: receipt ${rcpt.payload}`).toBe(201);
          expect(cancel.statusCode, `${label}: cancel ${cancel.payload}`).toBe(200);
          const body = rcpt.json() as {
            allocatedAmountMinor: string;
            unallocatedAmountMinor: string;
          };
          const allocated = BigInt(body.allocatedAmountMinor);
          expect([0n, 500n], label).toContain(allocated);
          expect(BigInt(body.unallocatedAmountMinor), label).toBe(500n - allocated);

          const facts = await cancelledInvoiceFacts(open.invoiceId, open.orderId);
          expect(facts.cns, `${label}: credit notes`).toHaveLength(1);
          expect(cnNumbersSeen.has(facts.cns[0]!.num), `${label}: duplicate number`).toBe(false);
          cnNumbersSeen.add(facts.cns[0]!.num);
          expect(await allocationTotal(open.invoiceId), label).toBe(allocated.toString());
          expect(BigInt(facts.cns[0]!.ar), `${label}: invoice closed exactly`).toBe(
            2000n - allocated,
          );
          expect(BigInt(facts.cns[0]!.excess), label).toBe(allocated);
          expect(facts.releases, `${label}: releases`).toHaveLength(allocated > 0n ? 1 : 0);
          expect(facts.charges, label).toBe('0');
          expect(facts.unbalanced, `${label}: unbalanced journals`).toEqual([]);
          expect(facts.auditCount('credit_note.issued'), label).toBe(1);
          expect(facts.auditCount('order.cancelled'), label).toBe(1);
          // the customer's 500 is conserved — released into an advance when the receipt paid the
          // invoice first, or left as an unapplied receipt when the cancellation closed it first
          const summary = await summaryOf(customerId);
          expect(
            BigInt(summary.branchFinancials.advanceAvailableMinor) +
              BigInt(summary.branchFinancials.unappliedReceiptMinor),
            `${label}: customer value conserved`,
          ).toBe(500n);
          expect(summary.branchFinancials.receivableOutstandingMinor, label).toBe('0');
          await integrityHolds(customerId);
        }
      }, 600_000);

      it('L6: 12 PAYMENT-advance-APPLICATION-vs-cancellation races (application locks invoice -> account -> advance) — never a deadlock or a 500; the 600 of customer value is conserved and released with its real provenance', async () => {
        for (let i = 0; i < 12; i++) {
          const label = `L6 iteration ${i}`;
          const customerId = await newCustomer(`l6-${i}`);
          // fund a PAYMENT-sourced advance FIRST (a receipt with no open receivable stays unapplied)
          const rcpt = await receipt(customerId, '600', 'CASH');
          expect(rcpt.statusCode, rcpt.payload).toBe(201);
          const paymentId = (rcpt.json() as { paymentId: string }).paymentId;
          const conv = await req(
            'POST',
            `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/from-payment`,
            closureTok,
            { paymentId, amountMinor: '600' },
            { 'idempotency-key': ik() },
          );
          expect(conv.statusCode, conv.payload).toBe(201);
          const advanceId = (conv.json() as { advanceId: string }).advanceId;
          const open = await openInvoiceFor(customerId);

          const [applyDelay, cancelDelay] = SCHEDULE[i % SCHEDULE.length]!;
          const [apply, cancel] = await Promise.all([
            delayed(applyDelay, () =>
              applyAdvanceTo(customerId, advanceId, open.receivableId, '600'),
            ),
            delayed(cancelDelay, () => cancelInvoicedOrder(open.orderId)),
          ]);
          expect(cancel.statusCode, `${label}: cancel ${cancel.payload}`).toBe(200);
          expect([201, 409], `${label}: apply ${apply.payload}`).toContain(apply.statusCode);
          if (apply.statusCode === 409) {
            expect(errCode(apply), label).toBe('CUSTOMER_ADVANCE_APPLICATION_INVALID');
          }
          const applied = apply.statusCode === 201 ? 600n : 0n;

          const facts = await cancelledInvoiceFacts(open.invoiceId, open.orderId);
          expect(facts.cns, `${label}: credit notes`).toHaveLength(1);
          expect(cnNumbersSeen.has(facts.cns[0]!.num), `${label}: duplicate number`).toBe(false);
          cnNumbersSeen.add(facts.cns[0]!.num);
          expect(BigInt(facts.cns[0]!.ar), `${label}: invoice closed exactly`).toBe(
            2000n - applied,
          );
          expect(BigInt(facts.cns[0]!.excess), label).toBe(applied);
          // the applied advance coverage is released exactly once, with its REAL provenance
          expect(facts.releases, `${label}: releases`).toHaveLength(applied > 0n ? 1 : 0);
          if (applied > 0n) {
            expect(facts.releases[0]!.kind, label).toBe('ADVANCE_APPLICATION');
            expect(facts.releases[0]!.paymentId, label).toBe(paymentId);
            expect(facts.releases[0]!.amount, label).toBe('600');
          }
          expect(facts.charges, label).toBe('0');
          expect(facts.unbalanced, `${label}: unbalanced journals`).toEqual([]);
          expect(facts.auditCount('credit_note.issued'), label).toBe(1);
          expect(facts.auditCount('order.cancelled'), label).toBe(1);
          // customer value is conserved: the 600 is either still on the original advance (the
          // application lost the race) or on the CREDIT_NOTE advance that replaced it (it won)
          const advances = await advancesOf(customerId);
          expect(
            advances.reduce((acc, a) => acc + BigInt(a.availableAmountMinor), 0n),
            `${label}: spendable entitlement`,
          ).toBe(600n);
          await expect(projectionOf(customerId), label).resolves.toEqual({
            outstanding: '0',
            advance: '600',
          });
          await integrityHolds(customerId);
        }
      }, 600_000);

      it('L4: the whole stress produced ZERO deadlocks at the database (pg_stat_database.deadlocks unchanged)', async () => {
        // a backend flushes its pending statistics at most ~10 s after it goes idle
        await sleep(12_000);
        expect(await deadlockCount()).toBe(deadlocksBefore);
        // the gapless credit-note counter: every rolled-back / rejected attempt rolled its number
        // back too, so the numbers this stress issued form ONE unbroken run
        const numbers = [...cnNumbersSeen]
          .map((n) => Number(n.slice('CN-'.length)))
          .sort((a, b) => a - b);
        for (let i = 1; i < numbers.length; i++) {
          expect(
            numbers[i]! - numbers[i - 1]!,
            `credit note numbers ${numbers[i - 1]} -> ${numbers[i]}`,
          ).toBe(1);
        }
      }, 60_000);
    });

    // ═══════ M — cancelling an invoice covered by a CREDIT_NOTE-sourced advance (F3) ═══════
    // Invoice B was (partly) paid with a CREDIT_NOTE advance — value an EARLIER cancellation of invoice A
    // released. Cancelling B must release that coverage AGAIN into a new CREDIT_NOTE advance, conserving the
    // customer's entitlement exactly. The release carries the ULTIMATE provenance of the value: the
    // authoritative funding release of the CREDIT_NOTE advance is copied forward (kind ADVANCE_APPLICATION
    // with the original Payment, or OPENING_ADVANCE with none) — never invented, never flattened, and the
    // historical applications / allocations / SettlementApplication rows are never touched. (Migration 47
    // teaches the release-integrity trigger to derive that provenance from the direct parent funding release.)
    describe('M — cancellation of an invoice covered by a CREDIT_NOTE-sourced advance (F3)', () => {
      interface ExpectedRelease {
        kind: 'PAYMENT_ALLOCATION' | 'ADVANCE_APPLICATION' | 'OPENING_ADVANCE';
        amount: bigint;
        paymentId: string | null;
        /** the allocation (PAYMENT_ALLOCATION) or application (the other two) id the release must cite */
        sourceId: string;
      }
      interface Before {
        advanceIds: string[];
        applications: string;
        allocations: string;
        settlement: string;
      }

      const advanceIdsOf = async (customerId: string): Promise<string[]> =>
        (
          await sql<{ id: string }>(
            `SELECT ca.id FROM customer_advance ca
                JOIN customer_company_account cca ON cca.id = ca."customerCompanyAccountId"
               WHERE cca."customerId" = $1 ORDER BY ca.id`,
            [customerId],
          )
        ).map((r) => r.id);

      const applicationIdOf = async (receivableId: string, advanceId: string): Promise<string> => {
        const rows = await sql<{ id: string }>(
          `SELECT id FROM customer_advance_application WHERE "customerReceivableId" = $1 AND "customerAdvanceId" = $2`,
          [receivableId, advanceId],
        );
        expect(rows).toHaveLength(1);
        return rows[0]!.id;
      };

      /** everything a cancellation must leave UNTOUCHED, plus the advances that exist before it */
      const snapshotOf = async (customerId: string, invoiceId: string): Promise<Before> => ({
        advanceIds: await advanceIdsOf(customerId),
        applications: JSON.stringify(
          await sql(
            `SELECT caa.* FROM customer_advance_application caa
                JOIN customer_advance ca ON ca.id = caa."customerAdvanceId"
                JOIN customer_company_account cca ON cca.id = ca."customerCompanyAccountId"
               WHERE cca."customerId" = $1 ORDER BY caa.id`,
            [customerId],
          ),
        ),
        allocations: JSON.stringify(
          await sql(`SELECT * FROM payment_allocation WHERE "invoiceId" = $1 ORDER BY id`, [
            invoiceId,
          ]),
        ),
        settlement: JSON.stringify({
          applications: await sql(`SELECT * FROM settlement_application ORDER BY id`),
          batches: await sql(
            `SELECT id, state, version, "journalEntryId" FROM settlement_batch ORDER BY id`,
          ),
        }),
      });

      const refundedOf = async (paymentId: string): Promise<bigint> =>
        BigInt(
          (
            await sql<{ t: string }>(
              `SELECT COALESCE(SUM("amountMinor"), 0)::text AS t FROM refund WHERE "sourcePaymentId" = $1`,
              [paymentId],
            )
          )[0]!.t,
        );

      /** invoice A (2000) partly paid by `method`, then cancelled -> ONE CREDIT_NOTE advance of `paid`
       *  derived from that Payment (release kind PAYMENT_ALLOCATION). */
      async function cnAdvanceFromPayment(
        customerId: string,
        paid: string,
        method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL',
      ): Promise<{ invoiceId: string; advanceId: string; paymentId: string }> {
        const a = await invoiceThenCancel(customerId, paid, method);
        const r1 = await releasedAdvanceOf(a.invoiceId);
        expect(r1.sourceKind).toBe('PAYMENT_ALLOCATION');
        return { invoiceId: a.invoiceId, advanceId: r1.advanceId, paymentId: r1.sourcePaymentId! };
      }

      /** a fresh open invoice (2000) with `amountMinor` of the advance applied to it */
      async function invoiceCoveredBy(
        customerId: string,
        advanceId: string,
        amountMinor: string,
      ): Promise<{
        orderId: string;
        invoiceId: string;
        receivableId: string;
        applicationId: string;
      }> {
        const target = await openInvoiceFor(customerId);
        await applyOk(customerId, advanceId, target.receivableId, amountMinor);
        return { ...target, applicationId: await applicationIdOf(target.receivableId, advanceId) };
      }

      /** the full economic proof of ONE successful cancellation — see the describe comment */
      async function expectCancelledExactly(a: {
        label: string;
        customerId: string;
        target: { orderId: string; invoiceId: string };
        total: bigint;
        expected: ExpectedRelease[];
        entitlementAfter: bigint;
        before: Before;
      }) {
        const { label } = a;
        const facts = await cancelledInvoiceFacts(a.target.invoiceId, a.target.orderId);

        // ONE credit note of the invoice's exact amount, split exactly into AR reduction / advance excess
        expect(facts.cns, `${label}: credit notes`).toHaveLength(1);
        const cn = facts.cns[0]!;
        const cnTotal = (
          await sql<{ t: string }>(
            `SELECT "totalAmountMinor"::text AS t FROM credit_note WHERE id = $1`,
            [cn.id],
          )
        )[0]!.t;
        expect(BigInt(cnTotal), `${label}: credit note total`).toBe(a.total);
        const covered = a.expected.reduce((acc, e) => acc + e.amount, 0n);
        expect(BigInt(cn.ar), `${label}: arReductionMinor`).toBe(a.total - covered);
        expect(BigInt(cn.excess), `${label}: advanceExcessMinor`).toBe(covered);

        // exactly ONE release per consumed coverage source — exact amount, exact (never invented) provenance
        expect(facts.releases, `${label}: releases`).toHaveLength(a.expected.length);
        const remaining = [...facts.releases];
        for (const e of a.expected) {
          const at = remaining.findIndex(
            (r) =>
              r.kind === e.kind &&
              r.amount === e.amount.toString() &&
              r.paymentId === e.paymentId &&
              (e.kind === 'PAYMENT_ALLOCATION'
                ? r.allocationId === e.sourceId
                : r.applicationId === e.sourceId),
          );
          expect(
            at,
            `${label}: a ${e.kind} release of ${e.amount} citing ${e.sourceId} with payment ${e.paymentId}`,
          ).toBeGreaterThanOrEqual(0);
          remaining.splice(at, 1);
        }
        expect(remaining, `${label}: no unexplained release`).toEqual([]);

        // each release funds exactly ONE brand-new, untouched CREDIT_NOTE advance; nothing else appeared
        const advanceIds = facts.releases.map((r) => r.advanceId);
        expect(new Set(advanceIds).size, `${label}: advances distinct`).toBe(advanceIds.length);
        const created = (await advanceIdsOf(a.customerId))
          .filter((id) => !a.before.advanceIds.includes(id))
          .sort();
        expect(created, `${label}: advances created == advances funded`).toEqual(
          [...advanceIds].sort(),
        );
        for (const r of facts.releases) {
          const adv = (
            await sql<{ amount: string; sourceType: string; consumed: string }>(
              `SELECT ca."amountMinor"::text AS amount, ca."sourceType",
                      (COALESCE((SELECT SUM(x."amountMinor") FROM customer_advance_application x WHERE x."customerAdvanceId" = ca.id), 0)
                     + COALESCE((SELECT SUM(x."amountMinor") FROM customer_advance_refund_application x WHERE x."customerAdvanceId" = ca.id), 0))::text AS consumed
                 FROM customer_advance ca WHERE ca.id = $1`,
              [r.advanceId],
            )
          )[0]!;
          expect(adv.sourceType, label).toBe('CREDIT_NOTE');
          expect(adv.amount, label).toBe(r.amount);
          expect(adv.consumed, `${label}: the new advance is untouched`).toBe('0');
        }

        // no lost / duplicated customer entitlement; the maintained projections equal the canonical sums
        const advances = await advancesOf(a.customerId);
        expect(
          advances.reduce((acc, x) => acc + BigInt(x.availableAmountMinor), 0n),
          `${label}: spendable entitlement`,
        ).toBe(a.entitlementAfter);
        await expect(projectionOf(a.customerId), label).resolves.toEqual({
          outstanding: '0',
          advance: a.entitlementAfter.toString(),
        });
        await integrityHolds(a.customerId);

        // GL: the ONE credit-note journal, balanced, with exactly these legs; nothing unbalanced anywhere
        expect(facts.unbalanced, `${label}: unbalanced journals`).toEqual([]);
        const legs = await sql<{ key: string; debit: string; credit: string }>(
          `SELECT ac.key, SUM(jl."debitMinor")::text AS debit, SUM(jl."creditMinor")::text AS credit
             FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
             JOIN account ac ON ac.id = jl."accountId"
            WHERE je."sourceKind" = 'credit_note' AND je."sourceId"::text = $1 GROUP BY ac.key`,
          [cn.id],
        );
        const leg = (key: string, side: 'debit' | 'credit'): bigint =>
          BigInt(legs.find((l) => l.key === key)?.[side] ?? '0');
        expect(
          leg('REVENUE.SALES', 'debit') + leg('LIABILITY.TAX_PAYABLE', 'debit'),
          `${label}: revenue + tax reversed`,
        ).toBe(a.total);
        expect(leg('ASSET.ACCOUNTS_RECEIVABLE', 'credit'), `${label}: AR credit`).toBe(
          a.total - covered,
        );
        expect(
          leg('LIABILITY.CUSTOMER_ADVANCES', 'credit'),
          `${label}: customer-advances credit`,
        ).toBe(covered);
        const journals = (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM journal_entry WHERE "sourceKind" = 'credit_note' AND "sourceId"::text = $1`,
            [cn.id],
          )
        )[0]!.n;
        expect(journals, `${label}: ONE credit-note journal`).toBe('1');

        // audit is atomic with the business rows; no cancellation charge was requested or appeared
        expect(facts.auditCount('credit_note.issued'), label).toBe(1);
        expect(facts.auditCount('order.cancelled'), label).toBe(1);
        expect(facts.charges, `${label}: no cancellation charge`).toBe('0');

        // historical facts are IMMUTABLE: applications, allocations, SettlementApplication / Batch
        const now = await snapshotOf(a.customerId, a.target.invoiceId);
        expect(now.applications, `${label}: historical applications unchanged`).toBe(
          a.before.applications,
        );
        expect(now.allocations, `${label}: allocations unchanged`).toBe(a.before.allocations);
        expect(now.settlement, `${label}: settlement rows unchanged`).toBe(a.before.settlement);
        return { releases: facts.releases };
      }

      it.each(['CASH', 'BANK_TRANSFER'] as const)(
        'M1 (%s receipt): invoice B funded by a CREDIT_NOTE advance derived from that receipt — cancelling B succeeds, releasing exactly that coverage ONCE with the ORIGINAL payment',
        async (method) => {
          const customerId = await newCustomer(`m1-${method}`);
          const a = await cnAdvanceFromPayment(customerId, '1000', method);
          const b = await invoiceCoveredBy(customerId, a.advanceId, '1000');
          const before = await snapshotOf(customerId, b.invoiceId);

          await cancelOk(b.orderId);

          const { releases } = await expectCancelledExactly({
            label: `M1 ${method}`,
            customerId,
            target: b,
            total: 2000n,
            expected: [
              {
                kind: 'ADVANCE_APPLICATION',
                amount: 1000n,
                paymentId: a.paymentId, // the ULTIMATE payment, carried forward from the funding release
                sourceId: b.applicationId,
              },
            ],
            entitlementAfter: 1000n,
            before,
          });
          // the first-generation advance is exactly as it was: fully drawn by the (immutable) application,
          // so the (open-advances-only) list now shows ONLY the new advance
          expect(releases[0]!.advanceId).not.toBe(a.advanceId);
          const drawn = await sql<{ t: string }>(
            `SELECT COALESCE(SUM("amountMinor"), 0)::text AS t FROM customer_advance_application WHERE "customerAdvanceId" = $1`,
            [a.advanceId],
          );
          expect(drawn[0]!.t).toBe('1000');
          expect((await advancesOf(customerId)).map((x) => x.customerAdvanceId)).toEqual([
            releases[0]!.advanceId,
          ]);
        },
      );

      it('M2: provider-backed provenance stays linked to the ORIGINAL Payment — and the 3b.7 settlement-finality semantics are preserved through the nested release (PAID until that Payment is settlement-final, then SETTLED)', async () => {
        const customerId = await newCustomer('m2');
        const p = await providerPaidInvoice(customerId); // invoice A paid by an UNSETTLED ONLINE_GATEWAY Payment
        const batchId = await seedSettlement(p.paymentId, 'DRAFT');
        await cancelOk(p.orderId);
        const r1 = await releasedAdvanceOf(p.invoiceId);
        expect(r1.sourcePaymentId).toBe(p.paymentId);

        const b = await invoiceCoveredBy(customerId, r1.advanceId, '2000');
        expect(await statusOf(b.invoiceId)).toBe('PAID'); // provider Payment not settlement-final
        const before = await snapshotOf(customerId, b.invoiceId);

        await cancelOk(b.orderId); // a PAID (not SETTLED) invoice is cancellable

        await expectCancelledExactly({
          label: 'M2',
          customerId,
          target: b,
          total: 2000n,
          expected: [
            {
              kind: 'ADVANCE_APPLICATION',
              amount: 2000n,
              paymentId: p.paymentId,
              sourceId: b.applicationId,
            },
          ],
          entitlementAfter: 2000n,
          before,
        });
        const r2 = await releasedAdvanceOf(b.invoiceId);
        expect(
          r2.sourcePaymentId,
          'the new advance still traces to the ORIGINAL provider Payment',
        ).toBe(p.paymentId);

        // finality semantics through the NESTED release: an invoice covered by the new advance is PAID while
        // the original Payment is unsettled, and is promoted by the REAL settlement finalization (Path C).
        const c = await invoiceCoveredBy(customerId, r2.advanceId, '2000');
        expect(await statusOf(c.invoiceId)).toBe('PAID');
        const cancelledStatus = await statusOf(b.invoiceId);
        await finalizeBatch(batchId);
        expect(await statusOf(c.invoiceId)).toBe('SETTLED');
        // …and the already-cancelled middle invoice is never promoted by the finalization
        expect(await statusOf(b.invoiceId)).toBe(cancelledStatus);
        await integrityHolds(customerId);
      });

      it('M3: OPENING-advance provenance (permitted by the frozen model) — cancelling B releases as OPENING_ADVANCE with NO Payment; the value can never be cashed out, and settles immediately', async () => {
        const customerId = await newCustomer('m3');
        const ob = await req(
          'POST',
          `/companies/${coA}/branches/${branchA}/customers/${customerId}/opening-balance`,
          openingTok,
          { type: 'ADVANCE', amountMinor: '1000', effectiveDate: '2026-01-01' },
          { 'idempotency-key': ik() },
        );
        expect(ob.statusCode, ob.payload).toBe(201);
        const openingAdvanceId = (ob.json() as { sourceId: string }).sourceId;
        const a = await openInvoiceFor(customerId);
        await applyOk(customerId, openingAdvanceId, a.receivableId, '1000');
        await cancelOk(a.orderId);
        const r1 = await releasedAdvanceOf(a.invoiceId);
        expect(r1.sourceKind).toBe('OPENING_ADVANCE');
        expect(r1.sourcePaymentId).toBeNull();

        const b = await invoiceCoveredBy(customerId, r1.advanceId, '1000');
        const before = await snapshotOf(customerId, b.invoiceId);
        await cancelOk(b.orderId);
        await expectCancelledExactly({
          label: 'M3',
          customerId,
          target: b,
          total: 2000n,
          expected: [
            { kind: 'OPENING_ADVANCE', amount: 1000n, paymentId: null, sourceId: b.applicationId },
          ],
          entitlementAfter: 1000n,
          before,
        });
        const r2 = await releasedAdvanceOf(b.invoiceId);
        expect(r2.sourceKind).toBe('OPENING_ADVANCE');
        expect(r2.sourcePaymentId).toBeNull(); // a Payment id is never fabricated

        // opening-derived value never funds a cash refund (no Payment provenance exists)
        const refund = await refundOf(customerId, r2.advanceId, '1000');
        expect(refund.statusCode, refund.payload).toBe(422);
        expect(errCode(refund)).toBe('REFUND_ADVANCE_HAS_NO_PAYMENT_PROVENANCE');

        // …and it is immediately settlement-final: covered by it + a CASH payment, an invoice is SETTLED
        const c = await invoiceCoveredBy(customerId, r2.advanceId, '1000');
        const pay = await directPayment(c.invoiceId, '1000', ik(), 'CASH');
        expect(pay.statusCode, pay.payload).toBe(201);
        expect(await statusOf(c.invoiceId)).toBe('SETTLED');
        await integrityHolds(customerId);
      });

      it('M4: depth-2 chain A → A′ → (B cancelled) → A″ → (C cancelled) → A‴ — every step succeeds, the ULTIMATE payment is carried forward unchanged, the customer entitlement stays exactly 1000 and can be cashed out only ONCE', async () => {
        const customerId = await newCustomer('m4');
        const a = await cnAdvanceFromPayment(customerId, '1000', 'CASH');

        // step 1 — B is covered by A′; cancel B -> A″
        const b = await invoiceCoveredBy(customerId, a.advanceId, '1000');
        const beforeB = await snapshotOf(customerId, b.invoiceId);
        await cancelOk(b.orderId);
        await expectCancelledExactly({
          label: 'M4 step 1',
          customerId,
          target: b,
          total: 2000n,
          expected: [
            {
              kind: 'ADVANCE_APPLICATION',
              amount: 1000n,
              paymentId: a.paymentId,
              sourceId: b.applicationId,
            },
          ],
          entitlementAfter: 1000n,
          before: beforeB,
        });
        const r2 = await releasedAdvanceOf(b.invoiceId);

        // step 2 — C is covered by A″ (itself a CREDIT_NOTE advance of a CREDIT_NOTE advance); cancel C -> A‴
        const c = await invoiceCoveredBy(customerId, r2.advanceId, '1000');
        const beforeC = await snapshotOf(customerId, c.invoiceId);
        await cancelOk(c.orderId);
        await expectCancelledExactly({
          label: 'M4 step 2',
          customerId,
          target: c,
          total: 2000n,
          // the SAME ultimate payment — not flattened, not re-derived, not duplicated
          expected: [
            {
              kind: 'ADVANCE_APPLICATION',
              amount: 1000n,
              paymentId: a.paymentId,
              sourceId: c.applicationId,
            },
          ],
          entitlementAfter: 1000n,
          before: beforeC,
        });
        const r3 = await releasedAdvanceOf(c.invoiceId);
        expect(new Set([a.advanceId, r2.advanceId, r3.advanceId]).size).toBe(3);

        // the value can be cashed out exactly ONCE: only A‴ is spendable; A′ and A″ are fully consumed
        for (const consumed of [a.advanceId, r2.advanceId]) {
          const refund = await refundOf(customerId, consumed, '1');
          expect(refund.statusCode, refund.payload).toBe(409);
          expect(errCode(refund)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');
        }
        const cash = await refundOf(customerId, r3.advanceId, '1000');
        expect(cash.statusCode, cash.payload).toBe(201);
        expect((await refundOf(customerId, r3.advanceId, '1')).statusCode).toBe(409);
        expect(await refundedOf(a.paymentId), 'refunds against the ONE original payment').toBe(
          1000n,
        );
        await integrityHolds(customerId);
      });

      it('M5: mixed coverage — a direct payment + a CASH-derived CREDIT_NOTE advance + a PAYMENT advance: every consumed source is released EXACTLY once with its own exact amount (500 + 600 + 400 released, 500 AR reduction)', async () => {
        const customerId = await newCustomer('m5');
        // a PAYMENT-sourced advance of 400 (a receipt with no open receivable stays unapplied → converted)
        const rcpt = await receipt(customerId, '400', 'CASH');
        expect(rcpt.statusCode, rcpt.payload).toBe(201);
        const advancePaymentId = (rcpt.json() as { paymentId: string }).paymentId;
        const conv = await req(
          'POST',
          `/companies/${coA}/branches/${branchA}/customers/${customerId}/advances/from-payment`,
          closureTok,
          { paymentId: advancePaymentId, amountMinor: '400' },
          { 'idempotency-key': ik() },
        );
        expect(conv.statusCode, conv.payload).toBe(201);
        const paymentAdvanceId = (conv.json() as { advanceId: string }).advanceId;
        // a CASH-derived CREDIT_NOTE advance of 600
        const a = await cnAdvanceFromPayment(customerId, '600', 'CASH');

        // invoice B (2000): CN advance 600 + PAYMENT advance 400 + a direct CASH payment of 500
        const b = await openInvoiceFor(customerId);
        await applyOk(customerId, a.advanceId, b.receivableId, '600');
        await applyOk(customerId, paymentAdvanceId, b.receivableId, '400');
        const pay = await directPayment(b.invoiceId, '500', ik(), 'CASH');
        expect(pay.statusCode, pay.payload).toBe(201);
        const direct = await sql<{ id: string; paymentId: string }>(
          `SELECT id, "paymentId" FROM payment_allocation WHERE "invoiceId" = $1`,
          [b.invoiceId],
        );
        expect(direct).toHaveLength(1); // the advances are applications, not payment allocations
        const allocation = direct[0]!.id;
        const directPaymentId = direct[0]!.paymentId;
        const cnApplication = await applicationIdOf(b.receivableId, a.advanceId);
        const paymentApplication = await applicationIdOf(b.receivableId, paymentAdvanceId);
        const before = await snapshotOf(customerId, b.invoiceId);

        await cancelOk(b.orderId);

        await expectCancelledExactly({
          label: 'M5',
          customerId,
          target: b,
          total: 2000n,
          expected: [
            {
              kind: 'PAYMENT_ALLOCATION',
              amount: 500n,
              paymentId: directPaymentId,
              sourceId: allocation,
            },
            {
              kind: 'ADVANCE_APPLICATION',
              amount: 600n,
              paymentId: a.paymentId,
              sourceId: cnApplication,
            },
            {
              kind: 'ADVANCE_APPLICATION',
              amount: 400n,
              paymentId: advancePaymentId,
              sourceId: paymentApplication,
            },
          ],
          entitlementAfter: 1500n,
          before,
        });
      });

      it('M6: the nested advance is cashed out against the REAL money, once — the first advance is consumed, the new one is refundable, and refunds can never exceed the original Payment', async () => {
        const customerId = await newCustomer('m6');
        const a = await cnAdvanceFromPayment(customerId, '1000', 'CASH');
        const b = await invoiceCoveredBy(customerId, a.advanceId, '1000');
        await cancelOk(b.orderId);
        const r2 = await releasedAdvanceOf(b.invoiceId);

        // the consumed first-generation advance can never be refunded again…
        const again = await refundOf(customerId, a.advanceId, '1');
        expect(again.statusCode, again.payload).toBe(409);
        expect(errCode(again)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');
        // …the nested one funds exactly its amount, against the ORIGINAL payment
        expect((await refundOf(customerId, r2.advanceId, '600')).statusCode).toBe(201);
        expect((await refundOf(customerId, r2.advanceId, '400')).statusCode).toBe(201);
        const over = await refundOf(customerId, r2.advanceId, '1');
        expect(over.statusCode, over.payload).toBe(409);
        expect(errCode(over)).toBe('REFUND_EXCEEDS_AVAILABLE_ADVANCE');
        expect(await refundedOf(a.paymentId)).toBe(1000n);
        await expect(projectionOf(customerId)).resolves.toEqual({ outstanding: '0', advance: '0' });
        await integrityHolds(customerId);
      });

      it('M7: retrying the SAME cancellation never creates a second CreditNote, release or CustomerAdvance', async () => {
        const customerId = await newCustomer('m7');
        const a = await cnAdvanceFromPayment(customerId, '1000', 'CASH');
        const b = await invoiceCoveredBy(customerId, a.advanceId, '1000');
        const versionBefore = (
          await sql<{ version: number }>(`SELECT version FROM "order" WHERE id = $1`, [b.orderId])
        )[0]!.version;
        await cancelOk(b.orderId);
        const settled = await footprint();
        const counts = async (): Promise<Record<string, string>> => {
          const one = async (q: string): Promise<string> => (await sql<{ c: string }>(q))[0]!.c;
          return {
            creditNotes: await one(`SELECT count(*)::text AS c FROM credit_note`),
            lines: await one(`SELECT count(*)::text AS c FROM credit_note_line`),
            releases: await one(`SELECT count(*)::text AS c FROM credit_note_coverage_release`),
            advances: await one(`SELECT count(*)::text AS c FROM customer_advance`),
            counter: await one(
              `SELECT "nextNumber"::text AS c FROM document_number_counter WHERE "documentType" = 'CREDIT_NOTE' AND "companyId" = '${coA}'`,
            ),
          };
        };
        const afterFirst = await counts();

        // a retry with the (fresh) version, and a retry replaying the ORIGINAL If-Match — both refused cleanly
        const retryFresh = await cancelInvoicedOrder(b.orderId);
        expect(retryFresh.statusCode, retryFresh.payload).toBe(409);
        const retryStale = await req(
          'POST',
          ORD(coA, branchA, `/${b.orderId}/cancel`),
          closureTok,
          { reason: 'duplicate retry' },
          { 'if-match': String(versionBefore) },
        );
        expect([409, 412], retryStale.payload).toContain(retryStale.statusCode);

        expect(await counts(), 'no second credit note / line / release / advance / number').toEqual(
          afterFirst,
        );
        expect(await footprint(), 'no financial row of any kind').toEqual(settled);
        await integrityHolds(customerId);
      });

      it('M8: a forced failure AFTER the releases are prepared rolls EVERYTHING back — CreditNote, releases, advances, journal, audit, document number, projections — and the retry then succeeds with the SAME number', async () => {
        const customerId = await newCustomer('m8');
        const a = await cnAdvanceFromPayment(customerId, '1000', 'CASH');
        const b = await invoiceCoveredBy(customerId, a.advanceId, '1000');
        const before = await snapshotOf(customerId, b.invoiceId);
        const state = async (): Promise<Record<string, unknown>> => {
          const one = async (q: string): Promise<string> => (await sql<{ c: string }>(q))[0]!.c;
          return {
            footprint: await footprint(),
            creditNotes: await one(`SELECT count(*)::text AS c FROM credit_note`),
            lines: await one(`SELECT count(*)::text AS c FROM credit_note_line`),
            releases: await one(`SELECT count(*)::text AS c FROM credit_note_coverage_release`),
            advances: await one(`SELECT count(*)::text AS c FROM customer_advance`),
            counter: await one(
              `SELECT COALESCE((SELECT "nextNumber" FROM document_number_counter WHERE "documentType" = 'CREDIT_NOTE' AND "companyId" = '${coA}'), 0)::text AS c`,
            ),
            projection: await projectionOf(customerId),
            order: (await sql(`SELECT status, version FROM "order" WHERE id = $1`, [b.orderId]))[0],
            invoice: (
              await sql(`SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`, [b.invoiceId])
            )[0],
          };
        };
        const stateBefore = await state();

        // the LAST write of the cancellation (the order's own audit row) fails — after the CreditNote, the
        // releases, the advances, the chronology entries, the projections and the journal were all written
        await sql(
          `CREATE OR REPLACE FUNCTION fn_test_fail_order_cancelled() RETURNS trigger AS $$
             BEGIN
               IF NEW.action = 'order.cancelled' THEN RAISE EXCEPTION 'injected failure after release preparation'; END IF;
               RETURN NEW;
             END; $$ LANGUAGE plpgsql`,
        );
        await sql(
          `CREATE TRIGGER trg_test_fail_order_cancelled BEFORE INSERT ON audit_log
             FOR EACH ROW EXECUTE FUNCTION fn_test_fail_order_cancelled()`,
        );
        try {
          const failed = await cancelInvoicedOrder(b.orderId);
          expect(failed.statusCode, failed.payload).toBeGreaterThanOrEqual(500);
          expect(await state(), 'a failed cancellation leaves ZERO partial state').toEqual(
            stateBefore,
          );
          const unchanged = await snapshotOf(customerId, b.invoiceId);
          expect(unchanged.applications).toBe(before.applications);
          expect(unchanged.allocations).toBe(before.allocations);
        } finally {
          await sql(`DROP TRIGGER IF EXISTS trg_test_fail_order_cancelled ON audit_log`);
          await sql(`DROP FUNCTION IF EXISTS fn_test_fail_order_cancelled()`);
        }

        // the retry succeeds and the gapless number rolled back with the failed attempt
        await cancelOk(b.orderId);
        const cn = (
          await sql<{ num: string }>(
            `SELECT "creditNoteNumber" AS num FROM credit_note WHERE "invoiceId" = $1`,
            [b.invoiceId],
          )
        )[0]!.num;
        expect(Number(cn.slice('CN-'.length)) + 1).toBe(Number((await state())['counter']));
        await expectCancelledExactly({
          label: 'M8 retry',
          customerId,
          target: b,
          total: 2000n,
          expected: [
            {
              kind: 'ADVANCE_APPLICATION',
              amount: 1000n,
              paymentId: a.paymentId,
              sourceId: b.applicationId,
            },
          ],
          entitlementAfter: 1000n,
          before,
        });
      });

      it('M9: a CREDIT_NOTE advance whose funding release is MISSING (malformed lineage) fails closed — a clean domain 409, never a guessed provenance, never a raw DB error, no partial rows', async () => {
        const customerId = await newCustomer('m9');
        const account = (
          await sql<{ id: string }>(
            `SELECT id FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
            [customerId, coA],
          )
        )[0]!.id;
        // an ORPHAN credit-note advance (raw-seeded: no release funded it) with its projection mirrored
        const orphanId = crypto.randomUUID();
        await sql(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',1000,'AED',2)`,
          [orphanId, tenantA, coA, branchA, account],
        );
        await sql(
          `UPDATE customer_company_account SET "advanceBalanceMinor" = "advanceBalanceMinor" + 1000 WHERE id = $1`,
          [account],
        );
        const b = await invoiceCoveredBy(customerId, orphanId, '1000');
        const before = await footprint();

        const res = await cancelInvoicedOrder(b.orderId);
        expect(res.statusCode, res.payload).toBe(409);
        expect(errCode(res)).toBe('CREDIT_NOTE_ADVANCE_PROVENANCE_UNRESOLVED');
        expect(await footprint()).toEqual(before);
        expect(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM credit_note WHERE "invoiceId" = $1`,
              [b.invoiceId],
            )
          )[0]!.n,
        ).toBe('0');
      });

      it('M10: a SETTLED provider-funded chain with a PARTIAL middle application — the nested release keeps the ORIGINAL provider Payment, an invoice covered by the nested advance is SETTLED at once, and the settlement fact is never touched', async () => {
        const customerId = await newCustomer('m10');
        const p = await providerPaidInvoice(customerId); // invoice A paid by an ONLINE_GATEWAY Payment (2000)
        await seedSettlement(p.paymentId, 'FINALIZED'); // …whose Payment is ALREADY settlement-final
        await cancelOk(p.orderId);
        const r1 = await releasedAdvanceOf(p.invoiceId);
        expect(r1.sourceKind).toBe('PAYMENT_ALLOCATION');
        expect(r1.sourcePaymentId).toBe(p.paymentId);

        // B draws only 1000 of the 2000 advance — a PARTIAL application: cancelling B must release exactly
        // that 1000 (never the advance's full 2000, never B's full 2000 total)
        const b = await invoiceCoveredBy(customerId, r1.advanceId, '1000');
        expect(await statusOf(b.invoiceId)).toBe('PARTIAL');
        const before = await snapshotOf(customerId, b.invoiceId);

        await cancelOk(b.orderId);

        await expectCancelledExactly({
          label: 'M10',
          customerId,
          target: b,
          total: 2000n,
          expected: [
            {
              kind: 'ADVANCE_APPLICATION',
              amount: 1000n,
              paymentId: p.paymentId,
              sourceId: b.applicationId,
            },
          ],
          // the first-generation advance still holds its undrawn 1000, the nested one holds the released 1000
          entitlementAfter: 2000n,
          before,
        });
        const r2 = await releasedAdvanceOf(b.invoiceId);
        expect(
          r2.sourcePaymentId,
          'the nested advance still traces to the ORIGINAL settled provider Payment',
        ).toBe(p.paymentId);

        // finality through the nested release: the Payment is already settlement-final, so an invoice covered
        // by the nested advance + CASH is SETTLED immediately — no unsettled component is invented
        const c = await invoiceCoveredBy(customerId, r2.advanceId, '1000');
        expect(await statusOf(c.invoiceId)).toBe('PARTIAL');
        const pay = await directPayment(c.invoiceId, '1000', ik(), 'CASH');
        expect(pay.statusCode, pay.payload).toBe(201);
        expect(await statusOf(c.invoiceId)).toBe('SETTLED');
        // …and the cancelled middle invoice is never promoted
        expect(await statusOf(b.invoiceId)).not.toBe('SETTLED');
        await integrityHolds(customerId);
      });
    });

    // ═══════ N — hard-gate economics: tax-inclusive / multi-line / discounted credit notes ═══════
    // The Checkpoint D post-invoice tests all use a ZERO-tax, ZERO-discount, ONE-line invoice, so the
    // CreditNote's line arithmetic and its journal were never exercised with real tax, a document
    // discount, several lines or a TAX_INCLUSIVE price mode. This describe proves them end to end through
    // the REAL pipeline (order create -> TaxFinalizationService -> Invoice + AR journal -> public cancel
    // route), asserting the CreditNote is the exact mirror of the Invoice.
    describe('N — hard-gate economics: tax-inclusive / multi-line / discounted credit notes', () => {
      let hgCancelTok = ''; // orders:cancel + credit_notes:issue + a fresh step-up, ALL branches
      // an isolated BH company: BHD (3-decimal), TAX_INCLUSIVE 10 %, with the REAL 14-account chart
      let bhCompany = '';
      let bhBranch = '';
      let bhCustomer = '';
      let bhProductId = '';
      let bhVariantId = '';

      beforeAll(async () => {
        hgCancelTok = await mintTenant(
          'hg-n-cancel',
          tenantA,
          [...ORDER_PERMS, 'credit_notes:issue'],
          { branchScope: 'ALL', stepUp: true },
        );
        await sql(
          `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('BHD', 3, 'BHD', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
        );
        await sql(
          `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
           VALUES ('BH', 'Bahrain', 'x', 'gcc', 'BHD', 'SAT_SUN', true, now())
           ON CONFLICT (code) DO NOTHING`,
        );
        await sql(
          `INSERT INTO country_tax_config (id, "countryCode", "effectiveFrom", regime, config)
           SELECT uuidv7(), 'BH', '2020-01-01', 'VAT',
                  '{"priceTaxMode":"TAX_INCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM country_tax_config WHERE "countryCode" = 'BH')`,
        );
        await sql(
          `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STDBH','Standard BH','x') ON CONFLICT (key) DO NOTHING`,
        );
        await sql(
          `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom")
           SELECT 'BH','STDBH',1000,'2020-01-01'
            WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE "countryCode"='BH' AND "taxCategoryKey"='STDBH')`,
        );
        bhCompany = (
          await sql<{ id: string }>(
            `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
             VALUES (uuidv7(),$1,'BH HG Co','BH','BHD','Asia/Bahrain',now()) RETURNING id`,
            [tenantA],
          )
        )[0]!.id;
        bhBranch = (
          await sql<{ id: string }>(
            `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
             VALUES (uuidv7(),$1,$2,'BH HG Branch',now()) RETURNING id`,
            [tenantA, bhCompany],
          )
        )[0]!.id;
        for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
          await sql(
            `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
             VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,now())`,
            [tenantA, bhCompany, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
          );
        }
        await sql(
          `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
           VALUES (uuidv7(), $1, $2, '2020-01-01', '2030-12-31', 'OPEN', now())`,
          [tenantA, bhCompany],
        );
        const cust = await req(
          'POST',
          `/companies/${bhCompany}/customers`,
          ownerA,
          { displayName: 'BH HG Customer' },
          { 'idempotency-key': `hg-n-bh-customer-${ik()}` },
        );
        expect(cust.statusCode, cust.payload).toBe(201);
        bhCustomer = (cust.json() as { id: string }).id;

        bhVariantId = await mkVariant(ownerA, 'hg-n-incl-item', { base: 'piece' });
        bhProductId = await productIdFor(bhVariantId);
        await companyPrice(bhCompany, bhVariantId, [
          { uomCode: 'piece', sell: money('11000', 'BHD', 3) },
        ]);
        const v = (await req('GET', `/catalog/variants/${bhVariantId}`, ownerA)).json() as {
          version: number;
        };
        const assign = await req(
          'PUT',
          `/catalog/variants/${bhVariantId}/tax-category`,
          ownerA,
          { taxCategoryKey: 'STDBH' },
          { 'if-match': `"${v.version}"` },
        );
        expect(assign.statusCode, assign.payload).toBe(200);
      }, 180_000);

      /** a customer-linked order in an arbitrary company/branch, via the REAL create route */
      async function createOrderIn(
        companyId: string,
        branchId: string,
        body: Record<string, unknown>,
      ): Promise<{ id: string; version: number; fingerprint: string; lines: Row[] }> {
        const r = await req('POST', ORD(companyId, branchId), ownerA, body, {
          'idempotency-key': ik(),
        });
        expect(r.statusCode, r.payload).toBe(201);
        const b = r.json() as {
          order: { id: string; version: number; commercialSnapshotFingerprint: string };
          lines: Row[];
        };
        return {
          id: b.order.id,
          version: b.order.version,
          fingerprint: b.order.commercialSnapshotFingerprint,
          lines: b.lines,
        };
      }
      type Row = Record<string, unknown>;

      /** the REAL tax finalization + Invoice issuance (+ the customer-linked AR journal) */
      async function finalizeAndInvoice(
        companyId: string,
        branchId: string,
        o: { id: string; version: number; fingerprint: string },
      ): Promise<string> {
        const finalization = app.get(TaxFinalizationService);
        const db = app.get(DbService);
        await runScoped(db.appClient(), { tenantId: tenantA }, (tx) =>
          finalization.finalizeAndIssueInvoice(tx, {
            tenantId: tenantA,
            companyId,
            branchId,
            orderId: o.id,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
            paymentIntent: 'PAY_NOW',
          }),
        );
        deliberatelyIssuedOrderIds.add(o.id);
        return (
          await sql<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [o.id])
        )[0]!.id;
      }

      async function cancelIn(
        companyId: string,
        branchId: string,
        orderId: string,
        token: string,
        extra: Record<string, unknown> = {},
      ) {
        const row = await sql<{ version: number }>(`SELECT version FROM "order" WHERE id=$1`, [
          orderId,
        ]);
        return req(
          'POST',
          ORD(companyId, branchId, `/${orderId}/cancel`),
          token,
          { reason: 'hard-gate cancellation', ...extra },
          { 'if-match': String(row[0]!.version) },
        );
      }

      it('N1: a TAX_INCLUSIVE (10 %) invoice is cancelled — the CreditNote journal BALANCES and exactly mirrors the invoice (revenue = total − tax)', async () => {
        const o = await createOrderIn(bhCompany, bhBranch, {
          lines: [
            {
              productId: bhProductId,
              variantId: bhVariantId,
              selectedUomCode: 'piece',
              quantity: '2',
            },
          ],
          customerId: bhCustomer,
        });
        const invoiceId = await finalizeAndInvoice(bhCompany, bhBranch, o);
        const inv = (
          await sql<{ sub: string; tax: string; total: string; mode: string }>(
            `SELECT i."subtotalAmountMinor"::text AS sub, i."taxTotalAmountMinor"::text AS tax,
                    i."totalAmountMinor"::text AS total, o."taxPriceMode" AS mode
               FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE i.id = $1`,
            [invoiceId],
          )
        )[0]!;
        expect(inv.mode).toBe('TAX_INCLUSIVE');
        expect(inv.total).toBe('22000'); // 2 × 11.000 BHD, tax INCLUDED
        expect(inv.tax).toBe('2000'); // 22000 × 1000 / 11000

        const res = await cancelIn(bhCompany, bhBranch, o.id, hgCancelTok);
        expect(res.statusCode, res.payload).toBe(200);

        const cn = (
          await sql<{
            id: string;
            sub: string;
            tax: string;
            total: string;
            ar: string;
            excess: string;
          }>(
            `SELECT id, "subtotalAmountMinor"::text AS sub, "taxTotalAmountMinor"::text AS tax,
                    "totalAmountMinor"::text AS total, "arReductionMinor"::text AS ar, "advanceExcessMinor"::text AS excess
               FROM credit_note WHERE "invoiceId" = $1`,
            [invoiceId],
          )
        )[0]!;
        // the CreditNote is the exact mirror of the Invoice
        expect(cn.total).toBe(inv.total);
        expect(cn.tax).toBe(inv.tax);
        expect(cn.ar).toBe('22000');
        expect(cn.excess).toBe('0');

        const legs = await sql<{ key: string; debit: string; credit: string }>(
          `SELECT a.key, SUM(jl."debitMinor")::text AS debit, SUM(jl."creditMinor")::text AS credit
             FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
             JOIN account a ON a.id = jl."accountId"
            WHERE je."sourceKind" = 'credit_note' AND je."sourceId"::text = $1 GROUP BY a.key ORDER BY a.key`,
          [cn.id],
        );
        expect(legs).toEqual([
          { key: 'ASSET.ACCOUNTS_RECEIVABLE', debit: '0', credit: '22000' },
          { key: 'LIABILITY.TAX_PAYABLE', debit: '2000', credit: '0' },
          // revenue is NET of the extracted tax — the very amount the invoice credited
          { key: 'REVENUE.SALES', debit: '20000', credit: '0' },
        ]);
      });

      // ── shared helpers for the hard-gate economics tests ─────────────────────────────────────
      type Legs = Record<string, { debit: bigint; credit: bigint }>;
      const glOf = async (sourceKind: string, sourceId: string): Promise<Legs> => {
        const rows = await sql<{ key: string; debit: string; credit: string }>(
          `SELECT a.key, SUM(jl."debitMinor")::text AS debit, SUM(jl."creditMinor")::text AS credit
             FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
             JOIN account a ON a.id = jl."accountId"
            WHERE je."sourceKind" = $1 AND je."sourceId"::text = $2 GROUP BY a.key`,
          [sourceKind, sourceId],
        );
        return Object.fromEntries(
          rows.map((r) => [r.key, { debit: BigInt(r.debit), credit: BigInt(r.credit) }]),
        );
      };
      const totalsOf = (legs: Legs): { debit: bigint; credit: bigint } => ({
        debit: Object.values(legs).reduce((a, l) => a + l.debit, 0n),
        credit: Object.values(legs).reduce((a, l) => a + l.credit, 0n),
      });
      const debitOf = (legs: Legs, key: string): bigint => legs[key]?.debit ?? 0n;
      const creditOf = (legs: Legs, key: string): bigint => legs[key]?.credit ?? 0n;

      async function newCustomerIn(companyId: string, label: string): Promise<string> {
        const r = await req(
          'POST',
          `/companies/${companyId}/customers`,
          ownerA,
          { displayName: `HG ${label}` },
          { 'idempotency-key': `hg-n-${label}-${ik()}` },
        );
        expect(r.statusCode, r.payload).toBe(201);
        return (r.json() as { id: string }).id;
      }

      async function assignTax(variant: string, key: string): Promise<void> {
        const v = (await req('GET', `/catalog/variants/${variant}`, ownerA)).json() as {
          version: number;
        };
        const r = await req(
          'PUT',
          `/catalog/variants/${variant}/tax-category`,
          ownerA,
          { taxCategoryKey: key },
          { 'if-match': `"${v.version}"` },
        );
        expect(r.statusCode, r.payload).toBe(200);
      }

      const receiptIn = (
        companyId: string,
        branchId: string,
        customerId: string,
        amountMinor: string,
        method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL' = 'CASH',
      ) =>
        req(
          'POST',
          `/companies/${companyId}/branches/${branchId}/customers/${customerId}/receipts`,
          closureTok,
          { amountMinor, method },
          { 'idempotency-key': ik() },
        );

      async function summaryIn(
        companyId: string,
        branchId: string,
        customerId: string,
      ): Promise<SummaryBody> {
        const r = await req(
          'GET',
          `/companies/${companyId}/branches/${branchId}/customers/${customerId}/account/summary`,
          closureTok,
        );
        expect(r.statusCode, r.payload).toBe(200);
        return r.json() as SummaryBody;
      }

      /** the CreditNote is the EXACT mirror of the Invoice — header, every line, and the journal */
      async function expectCreditNoteMirrorsInvoice(a: {
        label: string;
        orderId: string;
        invoiceId: string;
        paid: bigint;
      }): Promise<{ creditNoteId: string; inv: { total: bigint; tax: bigint } }> {
        const { label } = a;
        const inv = (
          await sql<{ sub: string; dd: string; tax: string; total: string }>(
            `SELECT "subtotalAmountMinor"::text AS sub, "documentDiscountAmountMinor"::text AS dd,
                    "taxTotalAmountMinor"::text AS tax, "totalAmountMinor"::text AS total
               FROM invoice WHERE id = $1`,
            [a.invoiceId],
          )
        )[0]!;
        const cns = await sql<{
          id: string;
          sub: string;
          tax: string;
          total: string;
          ar: string;
          excess: string;
        }>(
          `SELECT id, "subtotalAmountMinor"::text AS sub, "taxTotalAmountMinor"::text AS tax,
                  "totalAmountMinor"::text AS total, "arReductionMinor"::text AS ar, "advanceExcessMinor"::text AS excess
             FROM credit_note WHERE "invoiceId" = $1`,
          [a.invoiceId],
        );
        expect(cns, `${label}: ONE credit note`).toHaveLength(1);
        const cn = cns[0]!;
        const total = BigInt(inv.total);
        const tax = BigInt(inv.tax);

        // header: mirrors the invoice, split exactly into AR reduction + customer entitlement
        expect(cn.total, `${label}: total`).toBe(inv.total);
        expect(cn.tax, `${label}: tax`).toBe(inv.tax);
        expect(BigInt(cn.sub), `${label}: subtotal = invoice subtotal − document discount`).toBe(
          BigInt(inv.sub) - BigInt(inv.dd),
        );
        expect(BigInt(cn.excess), `${label}: advance excess = what was paid`).toBe(a.paid);
        expect(BigInt(cn.ar), `${label}: AR reduction = what was still owed`).toBe(total - a.paid);

        // lines: every amount re-derived from the FROZEN order-line snapshot, independently of the repository
        const order = (
          await sql<{ dd: string; cur: string }>(
            `SELECT "documentDiscountAmountMinor"::text AS dd, "currencyCode" AS cur FROM "order" WHERE id = $1`,
            [a.orderId],
          )
        )[0]!;
        const lines = await sql<{
          id: string;
          pos: number;
          qty: string;
          unit: string;
          disc: string;
          tax: string;
          mode: string;
        }>(
          `SELECT id, "linePosition" AS pos, quantity::text AS qty, "unitPriceAmountMinor"::text AS unit,
                  "discountAmountMinor"::text AS disc, COALESCE("lineTaxAmountMinor", 0)::text AS tax,
                  "priceTaxMode" AS mode
             FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"`,
          [a.orderId],
        );
        const cnLines = await sql<{
          olid: string;
          qty: string;
          gross: string;
          disc: string;
          dshare: string;
          net: string;
          tax: string;
          total: string;
        }>(
          `SELECT "orderLineId" AS olid, "quantityCredited"::text AS qty, "grossCreditedMinor"::text AS gross,
                  "discountCreditedMinor"::text AS disc, "documentDiscountShareCreditedMinor"::text AS dshare,
                  "netAfterDocumentDiscountCreditedMinor"::text AS net, "taxCreditedMinor"::text AS tax,
                  "lineTotalCreditedMinor"::text AS total
             FROM credit_note_line WHERE "creditNoteId" = $1`,
          [cn.id],
        );
        expect(cnLines, `${label}: one credit-note line per order line`).toHaveLength(lines.length);
        const afterLine = lines.map((l) => ({
          linePosition: l.pos,
          commercialAmountAfterLineDiscountMinor:
            BigInt(l.unit) * BigInt(l.qty.split('.')[0]!) - BigInt(l.disc),
        }));
        const alloc = allocateDocumentDiscount(afterLine, BigInt(order.dd), order.cur);
        const share = new Map(
          alloc.lines.map((x) => [x.linePosition, x.documentDiscountShareMinor]),
        );
        let sumShare = 0n;
        let sumNet = 0n;
        let sumTax = 0n;
        let sumTotal = 0n;
        for (const l of lines) {
          const c = cnLines.find((x) => x.olid === l.id);
          expect(c, `${label}: credit-note line for order line ${l.pos}`).toBeDefined();
          const gross = BigInt(l.unit) * BigInt(l.qty.split('.')[0]!);
          const dshare = share.get(l.pos)!;
          const lineNet = gross - BigInt(l.disc) - dshare;
          const lineTotal = l.mode === 'TAX_INCLUSIVE' ? lineNet : lineNet + BigInt(l.tax);
          expect(c!.qty, `${label}: line ${l.pos} quantity (full)`).toBe(l.qty);
          expect(BigInt(c!.gross), `${label}: line ${l.pos} gross`).toBe(gross);
          expect(BigInt(c!.disc), `${label}: line ${l.pos} line discount`).toBe(BigInt(l.disc));
          expect(
            BigInt(c!.dshare),
            `${label}: line ${l.pos} document-discount share (deterministic replay)`,
          ).toBe(dshare);
          expect(BigInt(c!.net), `${label}: line ${l.pos} net`).toBe(lineNet);
          expect(BigInt(c!.tax), `${label}: line ${l.pos} tax = the FROZEN line tax`).toBe(
            BigInt(l.tax),
          );
          expect(BigInt(c!.total), `${label}: line ${l.pos} total`).toBe(lineTotal);
          sumShare += dshare;
          sumNet += lineNet;
          sumTax += BigInt(l.tax);
          sumTotal += lineTotal;
        }
        expect(sumShare, `${label}: shares add up to the document discount`).toBe(BigInt(order.dd));
        expect(sumNet, `${label}: Σ line net = header subtotal`).toBe(BigInt(cn.sub));
        expect(sumTax, `${label}: Σ line tax = header tax`).toBe(tax);
        expect(sumTotal, `${label}: Σ line total = header total`).toBe(total);

        // journals: both balance, and the credit note reverses EXACTLY what the invoice booked
        const invGl = await glOf('invoice_ar', a.invoiceId);
        const cnGl = await glOf('credit_note', cn.id);
        expect(totalsOf(invGl).debit, `${label}: invoice journal balances`).toBe(
          totalsOf(invGl).credit,
        );
        expect(totalsOf(cnGl).debit, `${label}: credit-note journal balances`).toBe(
          totalsOf(cnGl).credit,
        );
        expect(debitOf(cnGl, 'REVENUE.SALES'), `${label}: revenue reversed`).toBe(
          creditOf(invGl, 'REVENUE.SALES'),
        );
        expect(debitOf(cnGl, 'LIABILITY.TAX_PAYABLE'), `${label}: tax reversed`).toBe(
          creditOf(invGl, 'LIABILITY.TAX_PAYABLE'),
        );
        expect(creditOf(cnGl, 'ASSET.ACCOUNTS_RECEIVABLE'), `${label}: AR credit`).toBe(
          total - a.paid,
        );
        expect(
          creditOf(cnGl, 'LIABILITY.CUSTOMER_ADVANCES'),
          `${label}: customer-advances credit`,
        ).toBe(a.paid);
        const journals = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM journal_entry WHERE "sourceKind" = 'credit_note' AND "sourceId"::text = $1`,
          [cn.id],
        );
        expect(journals[0]!.n, `${label}: ONE credit-note journal`).toBe('1');
        return { creditNoteId: cn.id, inv: { total, tax } };
      }

      it('N2: a TAX_INCLUSIVE multi-line invoice with line + document discounts, PARTLY PAID — the CreditNote mirrors the invoice exactly and releases exactly the paid part', async () => {
        const second = await mkVariant(ownerA, 'hg-n2-second', { base: 'piece' });
        await companyPrice(bhCompany, second, [
          { uomCode: 'piece', sell: money('4999', 'BHD', 3) },
        ]);
        await assignTax(second, 'STDBH');
        const customer = await newCustomerIn(bhCompany, 'n2');
        const o = await createOrderIn(bhCompany, bhBranch, {
          lines: [
            {
              productId: bhProductId,
              variantId: bhVariantId,
              selectedUomCode: 'piece',
              quantity: '3',
              discountMode: 'PERCENT_BPS',
              discountBps: 1500,
            },
            {
              productId: await productIdFor(second),
              variantId: second,
              selectedUomCode: 'piece',
              quantity: '2',
              discountMode: 'AMOUNT',
              discountAmountMinor: '333',
            },
          ],
          documentDiscountMode: 'AMOUNT',
          documentDiscountAmountMinor: '777',
          customerId: customer,
        });
        const invoiceId = await finalizeAndInvoice(bhCompany, bhBranch, o);
        const rec = await receiptIn(bhCompany, bhBranch, customer, '5000', 'CASH');
        expect(rec.statusCode, rec.payload).toBe(201);

        const res = await cancelIn(bhCompany, bhBranch, o.id, hgCancelTok);
        expect(res.statusCode, res.payload).toBe(200);
        const { inv } = await expectCreditNoteMirrorsInvoice({
          label: 'N2',
          orderId: o.id,
          invoiceId,
          paid: 5000n,
        });
        expect(inv.tax > 0n, 'the scenario really carries tax').toBe(true);

        // the customer's value is conserved: nothing owed, exactly the paid 5000 held as entitlement
        const summary = await summaryIn(bhCompany, bhBranch, customer);
        expect(summary.branchFinancials.receivableOutstandingMinor).toBe('0');
        expect(summary.branchFinancials.advanceAvailableMinor).toBe('5000');
        expect(summary.credit.projectionIntegrity).toEqual({
          receivableProjectionMatches: true,
          advanceProjectionMatches: true,
        });
      });

      it('N3: a TAX_EXCLUSIVE multi-line invoice (5 % + 0 % lines, line AMOUNT + PERCENT discounts, an odd document discount) — every CreditNote line equals the independently re-derived frozen amounts', async () => {
        const vx = await mkVariant(ownerA, 'hg-n3-x', { base: 'piece' });
        const vy = await mkVariant(ownerA, 'hg-n3-y', { base: 'piece' });
        const vz = await mkVariant(ownerA, 'hg-n3-z', { base: 'piece' });
        await companyPrice(coA, vx, [{ uomCode: 'piece', sell: money('1000', 'AED', 2) }]);
        await companyPrice(coA, vy, [{ uomCode: 'piece', sell: money('700', 'AED', 2) }]);
        await companyPrice(coA, vz, [{ uomCode: 'piece', sell: money('333', 'AED', 2) }]);
        await assignTax(vx, 'STD3B3');
        await assignTax(vy, 'ZERO3B3');
        await assignTax(vz, 'STD3B3');
        const customer = await newCustomerIn(coA, 'n3');
        const o = await createOrderIn(coA, branchA, {
          lines: [
            {
              productId: await productIdFor(vx),
              variantId: vx,
              selectedUomCode: 'piece',
              quantity: '2',
              discountMode: 'AMOUNT',
              discountAmountMinor: '150',
            },
            {
              productId: await productIdFor(vy),
              variantId: vy,
              selectedUomCode: 'piece',
              quantity: '3',
              discountMode: 'PERCENT_BPS',
              discountBps: 1000,
            },
            {
              productId: await productIdFor(vz),
              variantId: vz,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
          documentDiscountMode: 'AMOUNT',
          documentDiscountAmountMinor: '137',
          customerId: customer,
        });
        const invoiceId = await finalizeAndInvoice(coA, branchA, o);
        const res = await cancelIn(coA, branchA, o.id, hgCancelTok);
        expect(res.statusCode, res.payload).toBe(200);
        const { inv } = await expectCreditNoteMirrorsInvoice({
          label: 'N3',
          orderId: o.id,
          invoiceId,
          paid: 0n,
        });
        expect(inv.tax > 0n, 'the scenario really carries tax').toBe(true);
        const lineTaxes = await sql<{ t: string }>(
          `SELECT "lineTaxAmountMinor"::text AS t FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"`,
          [o.id],
        );
        expect(
          lineTaxes.some((x) => x.t === '0'),
          'a 0 % line is really in the mix',
        ).toBe(true);
        expect(
          lineTaxes.some((x) => x.t !== '0'),
          'a 5 % line is really in the mix',
        ).toBe(true);
      });

      it('N4: the CreditNote reuses the FROZEN tax snapshot — a later change of the live tax rate and of the variant tax category never changes it', async () => {
        await sql(
          `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('HGSNAP','HG snapshot','x') ON CONFLICT (key) DO NOTHING`,
        );
        await sql(
          `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom")
           SELECT 'AE','HGSNAP',500,'2020-01-01'
            WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE "countryCode"='AE' AND "taxCategoryKey"='HGSNAP')`,
        );
        const v = await mkVariant(ownerA, 'hg-n4-snap', { base: 'piece' });
        await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('1000', 'AED', 2) }]);
        await assignTax(v, 'HGSNAP');
        const customer = await newCustomerIn(coA, 'n4');
        const o = await createOrderIn(coA, branchA, {
          lines: [
            {
              productId: await productIdFor(v),
              variantId: v,
              selectedUomCode: 'piece',
              quantity: '2',
            },
          ],
          customerId: customer,
        });
        const invoiceId = await finalizeAndInvoice(coA, branchA, o);
        const frozen = (
          await sql<{ tax: string; rate: number }>(
            `SELECT "lineTaxAmountMinor"::text AS tax, "rateBps" AS rate FROM order_line WHERE "orderId" = $1`,
            [o.id],
          )
        )[0]!;
        expect(frozen).toEqual({ tax: '100', rate: 500 }); // 5 % of 2000

        try {
          // the LIVE configuration moves on: a new rate AND a different category for the variant
          await sql(
            `UPDATE tax_rate SET "rateBps" = 1200 WHERE "countryCode" = 'AE' AND "taxCategoryKey" = 'HGSNAP'`,
          );
          await assignTax(v, 'ZERO3B3');
          const res = await cancelIn(coA, branchA, o.id, hgCancelTok);
          expect(res.statusCode, res.payload).toBe(200);
          const { creditNoteId } = await expectCreditNoteMirrorsInvoice({
            label: 'N4',
            orderId: o.id,
            invoiceId,
            paid: 0n,
          });
          const cn = (
            await sql<{ tax: string; total: string }>(
              `SELECT "taxTotalAmountMinor"::text AS tax, "totalAmountMinor"::text AS total FROM credit_note WHERE id = $1`,
              [creditNoteId],
            )
          )[0]!;
          expect(cn).toEqual({ tax: '100', total: '2100' }); // the frozen 5 %, never the live 12 % / 0 %
        } finally {
          await sql(
            `UPDATE tax_rate SET "rateBps" = 500 WHERE "countryCode" = 'AE' AND "taxCategoryKey" = 'HGSNAP'`,
          );
        }
      });

      // ── CancellationCharge on a post-invoice cancellation, document numbering, audit ──────────
      let chargeCancelTok = ''; // orders:cancel + credit_notes:issue + cancellation_charges:issue + step-up
      beforeAll(async () => {
        chargeCancelTok = await mintTenant(
          'hg-n-charge',
          tenantA,
          [...ORDER_PERMS, 'credit_notes:issue', 'cancellation_charges:issue'],
          { branchScope: 'ALL', stepUp: true },
        );
      });

      const counterOf = async (companyId: string, documentType: string): Promise<bigint | null> => {
        const r = await sql<{ n: string }>(
          `SELECT "nextNumber"::text AS n FROM document_number_counter
            WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = $3`,
          [tenantA, companyId, documentType],
        );
        return r[0] ? BigInt(r[0].n) : null;
      };
      const numOf = (doc: string): bigint => BigInt(doc.slice(doc.indexOf('-') + 1));
      const setCounter = (companyId: string, documentType: string, next: bigint) =>
        sql(
          `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber","updatedAt")
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT ("tenantId","companyId","documentType") DO UPDATE SET "nextNumber" = EXCLUDED."nextNumber"`,
          [tenantA, companyId, documentType, next.toString()],
        );
      const CHARGE = {
        cancellationCharge: { requestedAmountMinor: '10000', reasonCode: 'CUSTOMER_REQUEST' },
      };

      /** a customer-linked, REAL (finalized) 2000 invoice in coA — zero tax */
      async function realInvoiceInCoA(
        customer: string,
      ): Promise<{ orderId: string; invoiceId: string }> {
        const o = await createOrderIn(coA, branchA, {
          lines: [
            {
              productId: await productIdFor(variantId),
              variantId,
              selectedUomCode: 'piece',
              quantity: '2',
            },
          ],
          customerId: customer,
        });
        return { orderId: o.id, invoiceId: await finalizeAndInvoice(coA, branchA, o) };
      }

      it.each([0, 800] as const)(
        'N5 (paid %i): post-invoice cancellation WITH a charge — the CreditNote and the CancellationCharge are two INDEPENDENT documents (own number, own receivable, own journal), never netted',
        async (paidNumber) => {
          const paid = BigInt(paidNumber);
          const customer = await newCustomerIn(coA, `n5-${paidNumber}`);
          const target = await realInvoiceInCoA(customer);
          if (paid > 0n) {
            const r = await receiptIn(coA, branchA, customer, paid.toString(), 'CASH');
            expect(r.statusCode, r.payload).toBe(201);
          }

          const res = await cancelIn(coA, branchA, target.orderId, chargeCancelTok, CHARGE);
          expect(res.statusCode, res.payload).toBe(200);

          // ── the CreditNote: exactly what a no-charge cancellation would have produced ──
          const { creditNoteId } = await expectCreditNoteMirrorsInvoice({
            label: `N5(${paidNumber})`,
            orderId: target.orderId,
            invoiceId: target.invoiceId,
            paid,
          });
          const cn = (
            await sql<{ num: string; total: string; ar: string; excess: string }>(
              `SELECT "creditNoteNumber" AS num, "totalAmountMinor"::text AS total,
                      "arReductionMinor"::text AS ar, "advanceExcessMinor"::text AS excess
                 FROM credit_note WHERE id = $1`,
              [creditNoteId],
            )
          )[0]!;
          expect(cn.num).toMatch(/^CN-\d{6,}$/);
          expect(cn.total).toBe('2000'); // the charge is NEVER netted into the credit note
          expect(cn.ar).toBe((2000n - paid).toString());

          // ── the CancellationCharge: a separate, fully-formed financial document ──
          const charges = await sql<{
            id: string;
            invoiceId: string | null;
            num: string;
            net: string;
            tax: string;
            total: string;
            mode: string;
            cat: string | null;
            rate: number | null;
          }>(
            `SELECT id, "invoiceId", "cancellationChargeNumber" AS num, "netAmountMinor"::text AS net,
                    "taxAmountMinor"::text AS tax, "totalAmountMinor"::text AS total, "priceTaxMode" AS mode,
                    "taxCategoryKey" AS cat, "rateBps" AS rate
               FROM cancellation_charge WHERE "orderId" = $1`,
            [target.orderId],
          );
          expect(charges).toHaveLength(1);
          const ch = charges[0]!;
          expect(ch).toMatchObject({
            invoiceId: target.invoiceId, // the cancelled invoice is recorded on the charge
            net: '10000',
            tax: '500',
            total: '10500',
            mode: 'TAX_EXCLUSIVE',
            cat: 'STD3B3',
            rate: 500,
          });
          expect(ch.num).toMatch(/^CC-\d{6,}$/);
          expect(ch.num.startsWith('CC-')).toBe(true);
          expect(cn.num.startsWith('CN-')).toBe(true);

          // its OWN receivable (a CANCELLATION_CHARGE source, no invoice) …
          const recv = await sql<{ sourceType: string; invoiceId: string | null }>(
            `SELECT "sourceType", "invoiceId" FROM customer_receivable WHERE "cancellationChargeId" = $1`,
            [ch.id],
          );
          expect(recv).toEqual([{ sourceType: 'CANCELLATION_CHARGE', invoiceId: null }]);
          // … and its OWN journal — separate from the credit-note journal, both balanced
          const chGl = await glOf('cancellation_charge', ch.id);
          expect(chGl).toEqual({
            'ASSET.ACCOUNTS_RECEIVABLE': { debit: 10500n, credit: 0n },
            'REVENUE.CANCELLATION_CHARGE': { debit: 0n, credit: 10000n },
            'LIABILITY.TAX_PAYABLE': { debit: 0n, credit: 500n },
          });
          const cnGl = await glOf('credit_note', creditNoteId);
          expect(totalsOf(chGl).debit).toBe(totalsOf(chGl).credit);
          expect(totalsOf(cnGl).debit).toBe(totalsOf(cnGl).credit);
          expect(Object.keys(cnGl)).not.toContain('REVENUE.CANCELLATION_CHARGE');

          // the account: ONLY the charge is owed; the paid part is a separate entitlement (never auto-netted)
          const summary = await summaryIn(coA, branchA, customer);
          expect(summary.branchFinancials.receivableOutstandingMinor).toBe('10500');
          expect(summary.branchFinancials.advanceAvailableMinor).toBe(paid.toString());
          expect(summary.credit.projectionIntegrity).toEqual({
            receivableProjectionMatches: true,
            advanceProjectionMatches: true,
          });
          const applications = await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM customer_advance_application caa
              WHERE caa."customerAdvanceId" IN (SELECT "customerAdvanceId" FROM credit_note_coverage_release WHERE "creditNoteId" = $1)`,
            [creditNoteId],
          );
          expect(applications[0]!.n).toBe('0');

          // independent gapless numbering: each counter sits exactly one past its document's number
          expect(await counterOf(coA, 'CREDIT_NOTE')).toBe(numOf(cn.num) + 1n);
          expect(await counterOf(coA, 'CANCELLATION_CHARGE')).toBe(numOf(ch.num) + 1n);

          // audit: one row per document, atomic with the business rows, linked by id
          const audits = await sql<{ action: string; n: string }>(
            `SELECT action, count(*)::text AS n FROM audit_log
              WHERE "resourceId"::text = ANY($1::text[])
                AND action IN ('order.cancelled','credit_note.issued','cancellation_charge.issued')
              GROUP BY action ORDER BY action`,
            [[target.orderId, creditNoteId, ch.id]],
          );
          expect(audits).toEqual([
            { action: 'cancellation_charge.issued', n: '1' },
            { action: 'credit_note.issued', n: '1' },
            { action: 'order.cancelled', n: '1' },
          ]);
          const orderAudit = (
            await sql<{ after: Record<string, unknown> }>(
              `SELECT after FROM audit_log WHERE action = 'order.cancelled' AND "resourceId"::text = $1`,
              [target.orderId],
            )
          )[0]!;
          expect(orderAudit.after).toMatchObject({
            hasCharge: true,
            creditNoteId,
            creditNoteNumber: cn.num,
            cancellationChargeId: ch.id,
            cancellationChargeNumber: ch.num,
          });

          // a replay is a clean 409 and creates nothing
          const before = await footprint();
          const again = await cancelIn(coA, branchA, target.orderId, chargeCancelTok, CHARGE);
          expect(again.statusCode, again.payload).toBe(409);
          expect(await footprint()).toEqual(before);
          expect(await counterOf(coA, 'CANCELLATION_CHARGE')).toBe(numOf(ch.num) + 1n);
        },
      );

      it('N5c: every missing authority fails BEFORE any financial mutation — no charge, no credit note, no journal, no number, order untouched', async () => {
        const mk = (id: string, perms: string[], stepUp: boolean) =>
          mintTenant(`hg-n5c-${id}`, tenantA, perms, { branchScope: 'ALL', stepUp });
        const noChargePerm = await mk('nochargeperm', [...ORDER_PERMS, 'credit_notes:issue'], true);
        const noCnPerm = await mk('nocnperm', [...ORDER_PERMS, 'cancellation_charges:issue'], true);
        const noStepUp = await mk(
          'nostepup',
          [...ORDER_PERMS, 'credit_notes:issue', 'cancellation_charges:issue'],
          false,
        );
        // an Accountant-shaped caller: holds BOTH financial-document authorities + step-up, but NOT orders:cancel
        const noCancelPerm = await mk(
          'nocancel',
          ['orders:view', 'orders:manage', 'credit_notes:issue', 'cancellation_charges:issue'],
          true,
        );
        const customer = await newCustomerIn(coA, 'n5c');
        const target = await realInvoiceInCoA(customer);
        const walkIn = await createOrderIn(coA, branchA, {
          lines: [
            {
              productId: await productIdFor(variantId),
              variantId,
              selectedUomCode: 'piece',
              quantity: '2',
            },
          ],
        });
        await finalizeAndInvoice(coA, branchA, walkIn);

        const orderState = async (id: string) =>
          (await sql(`SELECT status, version FROM "order" WHERE id = $1`, [id]))[0];
        const cases: [string, string, string, number, string, string][] = [
          [
            'no cancellation_charges:issue',
            noChargePerm,
            target.orderId,
            403,
            'MISSING_PERMISSION',
            'charge',
          ],
          ['no credit_notes:issue', noCnPerm, target.orderId, 403, 'MISSING_PERMISSION', 'charge'],
          ['no fresh step-up', noStepUp, target.orderId, 403, 'STEP_UP_REQUIRED', 'charge'],
          [
            'no orders:cancel (both document authorities held)',
            noCancelPerm,
            target.orderId,
            403,
            'MISSING_PERMISSION',
            'charge',
          ],
          [
            'no orders:cancel, NO charge requested',
            noCancelPerm,
            target.orderId,
            403,
            'MISSING_PERMISSION',
            'plain',
          ],
          [
            'no credit_notes:issue, NO charge requested',
            await mk('nocn-plain', ORDER_PERMS, true),
            target.orderId,
            403,
            'MISSING_PERMISSION',
            'plain',
          ],
          [
            'no step-up, NO charge requested (credit note still step-up gated)',
            await mk('nostepup-plain', [...ORDER_PERMS, 'credit_notes:issue'], false),
            target.orderId,
            403,
            'STEP_UP_REQUIRED',
            'plain',
          ],
          [
            'a walk-in invoiced order + charge',
            chargeCancelTok,
            walkIn.id,
            422,
            'WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE',
            'charge',
          ],
        ];
        for (const [label, token, orderId, status, code, kind] of cases) {
          const before = {
            footprint: await footprint(),
            order: await orderState(orderId),
            cn: await counterOf(coA, 'CREDIT_NOTE'),
            cc: await counterOf(coA, 'CANCELLATION_CHARGE'),
          };
          const res = await cancelIn(coA, branchA, orderId, token, kind === 'charge' ? CHARGE : {});
          expect(res.statusCode, `${label}: ${res.payload}`).toBe(status);
          expect(errCode(res), label).toBe(code);
          expect(await footprint(), `${label}: no row of any kind`).toEqual(before.footprint);
          expect(await orderState(orderId), `${label}: order untouched`).toEqual(before.order);
          expect(await counterOf(coA, 'CREDIT_NOTE'), `${label}: no CN number consumed`).toBe(
            before.cn,
          );
          expect(
            await counterOf(coA, 'CANCELLATION_CHARGE'),
            `${label}: no CC number consumed`,
          ).toBe(before.cc);
        }
        // control: with every authority the very same request succeeds
        const ok = await cancelIn(coA, branchA, target.orderId, chargeCancelTok, CHARGE);
        expect(ok.statusCode, ok.payload).toBe(200);
      });

      it('N6a: document numbering is BigInt-safe with no artificial ceiling — a CreditNote past 2^53 and a CancellationCharge past 6 digits are exact, consecutive and unique', async () => {
        await sql(`UPDATE company SET "cancellationFeeTaxCategoryKey" = 'STDBH' WHERE id = $1`, [
          bhCompany,
        ]);
        const BIG = 9007199254740993n; // 2^53 + 1 — NOT representable as a JS number
        expect(BigInt(Number(BIG))).not.toBe(BIG);
        await setCounter(bhCompany, 'CREDIT_NOTE', BIG);
        await setCounter(bhCompany, 'CANCELLATION_CHARGE', 9_999_999n);

        const numbers: string[] = [];
        for (const label of ['n6a-1', 'n6a-2']) {
          const customer = await newCustomerIn(bhCompany, label);
          const o = await createOrderIn(bhCompany, bhBranch, {
            lines: [
              {
                productId: bhProductId,
                variantId: bhVariantId,
                selectedUomCode: 'piece',
                quantity: '1',
              },
            ],
            customerId: customer,
          });
          const invoiceId = await finalizeAndInvoice(bhCompany, bhBranch, o);
          const res = await cancelIn(bhCompany, bhBranch, o.id, hgCancelTok);
          expect(res.statusCode, res.payload).toBe(200);
          numbers.push(
            (
              await sql<{ n: string }>(
                `SELECT "creditNoteNumber" AS n FROM credit_note WHERE "invoiceId" = $1`,
                [invoiceId],
              )
            )[0]!.n,
          );
        }
        expect(numbers).toEqual(['CN-9007199254740993', 'CN-9007199254740994']); // exact — a float would round
        expect(await counterOf(bhCompany, 'CREDIT_NOTE')).toBe(9007199254740995n);

        const chargeNumbers: string[] = [];
        for (const label of ['n6a-c1', 'n6a-c2']) {
          const customer = await newCustomerIn(bhCompany, label);
          const o = await createOrderIn(bhCompany, bhBranch, {
            lines: [
              {
                productId: bhProductId,
                variantId: bhVariantId,
                selectedUomCode: 'piece',
                quantity: '1',
              },
            ],
            customerId: customer,
          });
          const res = await cancelIn(bhCompany, bhBranch, o.id, chargeCancelTok, {
            cancellationCharge: { requestedAmountMinor: '11000', reasonCode: 'CUSTOMER_REQUEST' },
          });
          expect(res.statusCode, res.payload).toBe(200);
          chargeNumbers.push(
            (
              await sql<{ n: string }>(
                `SELECT "cancellationChargeNumber" AS n FROM cancellation_charge WHERE "orderId" = $1`,
                [o.id],
              )
            )[0]!.n,
          );
        }
        expect(chargeNumbers).toEqual(['CC-9999999', 'CC-10000000']); // 6-digit padding never truncates
        expect(await counterOf(bhCompany, 'CANCELLATION_CHARGE')).toBe(10_000_001n);
      });

      it('N6b: concurrent cancellations in ONE company get distinct, consecutive, gapless CreditNote numbers (the counter row serializes them) — scoped per company and per document type', async () => {
        await setCounter(bhCompany, 'CREDIT_NOTE', 1000n);
        const coA2CounterBefore = await counterOf(coA, 'CREDIT_NOTE');
        const targets: { orderId: string; invoiceId: string }[] = [];
        for (let i = 0; i < 6; i++) {
          const customer = await newCustomerIn(bhCompany, `n6b-${i}`);
          const o = await createOrderIn(bhCompany, bhBranch, {
            lines: [
              {
                productId: bhProductId,
                variantId: bhVariantId,
                selectedUomCode: 'piece',
                quantity: '1',
              },
            ],
            customerId: customer,
          });
          targets.push({
            orderId: o.id,
            invoiceId: await finalizeAndInvoice(bhCompany, bhBranch, o),
          });
        }
        const results = await Promise.all(
          targets.map((t) => cancelIn(bhCompany, bhBranch, t.orderId, hgCancelTok)),
        );
        for (const r of results) expect(r.statusCode, r.payload).toBe(200);
        const nums = (
          await sql<{ n: string }>(
            `SELECT "creditNoteNumber" AS n FROM credit_note WHERE "invoiceId" = ANY($1::uuid[])`,
            [targets.map((t) => t.invoiceId)],
          )
        )
          .map((r) => numOf(r.n))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        expect(nums).toEqual([1000n, 1001n, 1002n, 1003n, 1004n, 1005n]);
        expect(await counterOf(bhCompany, 'CREDIT_NOTE')).toBe(1006n);
        // another company's counter is untouched by them
        expect(await counterOf(coA, 'CREDIT_NOTE')).toBe(coA2CounterBefore);
      });

      it('N6c: a charge cancellation that rolls back consumes NO number — the counter is unchanged and the next successful charge takes the very same number', async () => {
        await sql(`UPDATE company SET "cancellationFeeTaxCategoryKey" = 'STDBH' WHERE id = $1`, [
          bhCompany,
        ]);
        await setCounter(bhCompany, 'CANCELLATION_CHARGE', 500n);
        const customer = await newCustomerIn(bhCompany, 'n6c');
        const o = await createOrderIn(bhCompany, bhBranch, {
          lines: [
            {
              productId: bhProductId,
              variantId: bhVariantId,
              selectedUomCode: 'piece',
              quantity: '1',
            },
          ],
          customerId: customer,
        });
        // BH has an open period 2020–2030 only: 2031 fails INSIDE the transaction, after the number was allocated
        const failed = await cancelIn(bhCompany, bhBranch, o.id, chargeCancelTok, {
          cancellationCharge: {
            requestedAmountMinor: '11000',
            reasonCode: 'CUSTOMER_REQUEST',
            accountingDate: '2031-06-15',
          },
        });
        expect(failed.statusCode, failed.payload).toBe(422);
        expect(errCode(failed)).toBe('NO_OPEN_ACCOUNTING_PERIOD');
        expect(await counterOf(bhCompany, 'CANCELLATION_CHARGE')).toBe(500n);

        const ok = await cancelIn(bhCompany, bhBranch, o.id, chargeCancelTok, {
          cancellationCharge: { requestedAmountMinor: '11000', reasonCode: 'CUSTOMER_REQUEST' },
        });
        expect(ok.statusCode, ok.payload).toBe(200);
        const num = (
          await sql<{ n: string }>(
            `SELECT "cancellationChargeNumber" AS n FROM cancellation_charge WHERE "orderId" = $1`,
            [o.id],
          )
        )[0]!.n;
        expect(num).toBe('CC-000500');
        expect(await counterOf(bhCompany, 'CANCELLATION_CHARGE')).toBe(501n);
      });

      it('N7: audit stays BOUNDED — ids / numbers / amounts / status labels only, no customer PII, no secrets, no nested payload — for the cancellation, credit note, charge and refund', async () => {
        const customer = await newCustomerIn(coA, 'n7-customer-pii-canary');
        const target = await realInvoiceInCoA(customer);
        const rec = await receiptIn(coA, branchA, customer, '800', 'CASH');
        expect(rec.statusCode, rec.payload).toBe(201);
        const res = await cancelIn(coA, branchA, target.orderId, chargeCancelTok, CHARGE);
        expect(res.statusCode, res.payload).toBe(200);
        const adv = (
          await sql<{ id: string }>(
            `SELECT r."customerAdvanceId" AS id FROM credit_note_coverage_release r
               JOIN credit_note cn ON cn.id = r."creditNoteId" WHERE cn."invoiceId" = $1`,
            [target.invoiceId],
          )
        )[0]!.id;
        const refund = await refundOf(customer, adv, '300', 'CASH');
        expect(refund.statusCode, refund.payload).toBe(201);

        const cnId = (
          await sql<{ id: string }>(`SELECT id FROM credit_note WHERE "invoiceId" = $1`, [
            target.invoiceId,
          ])
        )[0]!.id;
        const chId = (
          await sql<{ id: string }>(`SELECT id FROM cancellation_charge WHERE "orderId" = $1`, [
            target.orderId,
          ])
        )[0]!.id;
        const refundId = (
          await sql<{ id: string }>(
            `SELECT a."refundId" AS id FROM customer_advance_refund_application a WHERE a."customerAdvanceId" = $1`,
            [adv],
          )
        )[0]!.id;
        const ALLOWED: Record<string, string[]> = {
          'order.cancelled': [
            'fromStatus',
            'toStatus',
            'hasCharge',
            'creditNoteId',
            'creditNoteNumber',
            'nextInvoicePaymentStatus',
            'cancellationChargeId',
            'cancellationChargeNumber',
          ],
          'credit_note.issued': [
            'orderId',
            'invoiceId',
            'creditNoteNumber',
            'totalAmountMinor',
            'arReductionMinor',
            'advanceExcessMinor',
            'currencyCode',
          ],
          'cancellation_charge.issued': [
            'orderId',
            'cancellationChargeNumber',
            'totalAmountMinor',
            'currencyCode',
            'customerReceivableId',
          ],
          'refund.completed': [
            'customerAdvanceId',
            'amountMinor',
            'currencyCode',
            'method',
            'refundAttemptId',
          ],
        };
        const rows = await sql<{
          action: string;
          reason: string | null;
          before: Record<string, unknown> | null;
          after: Record<string, unknown> | null;
        }>(
          `SELECT action, reason, before, after FROM audit_log
            WHERE "resourceId"::text = ANY($1::text[]) AND action = ANY($2::text[]) ORDER BY action`,
          [[target.orderId, cnId, chId, refundId], Object.keys(ALLOWED)],
        );
        expect(rows.map((r) => r.action)).toEqual([
          'cancellation_charge.issued',
          'credit_note.issued',
          'order.cancelled',
          'refund.completed',
        ]);
        const FORBIDDEN =
          /pii-canary|display[_-]?name|e-?mail|phone|secret|password|token|cvv|card|authorization|api[_-]?key|ciphertext/i;
        for (const r of rows) {
          expect(r.before, `${r.action}: a creation records no before-image`).toBeNull();
          const after = r.after!;
          for (const [k, v] of Object.entries(after)) {
            expect(ALLOWED[r.action], `${r.action}: unexpected audit key "${k}"`).toContain(k);
            expect(
              ['string', 'number', 'boolean'].includes(typeof v) || v === null,
              `${r.action}.${k} is a bare scalar`,
            ).toBe(true);
          }
          expect(JSON.stringify(after), r.action).not.toMatch(FORBIDDEN);
          // the ONLY free text is the caller's own cancellation reason — and only on the order row
          if (r.action !== 'order.cancelled') expect(r.reason, r.action).toBeNull();
          expect((r.reason ?? '').length).toBeLessThanOrEqual(255);
        }
      });

      // ═══════ HG1 — public surface, permissions, step-up ═══════════════════════════════════════
      /** the actual mapped route table with each route's permission / step-up / scope declaration */
      function routeTable(): string[] {
        const discovery = app.get(DiscoveryService);
        const reflector = app.get(Reflector);
        const scanner = new MetadataScanner();
        const METHOD: Record<number, string> = {
          [RequestMethod.GET]: 'GET',
          [RequestMethod.POST]: 'POST',
          [RequestMethod.PUT]: 'PUT',
          [RequestMethod.DELETE]: 'DELETE',
          [RequestMethod.PATCH]: 'PATCH',
        };
        const join = (...p: string[]): string =>
          '/' +
          p
            .flatMap((x) => x.split('/'))
            .filter((x) => x.length > 0)
            .join('/');
        const rows: string[] = [];
        for (const w of discovery.getControllers()) {
          if (!w.instance || !w.metatype) continue;
          const proto = Object.getPrototypeOf(w.instance) as object;
          const base = reflector.get<string>(PATH_METADATA, w.metatype) ?? '';
          const classPublic = reflector.get<boolean>(IS_PUBLIC_KEY, w.metatype) ?? false;
          for (const name of scanner.getAllMethodNames(proto)) {
            const handler = (proto as Record<string, unknown>)[name];
            if (typeof handler !== 'function') continue;
            const method = reflector.get<number>(METHOD_METADATA, handler);
            if (method === undefined) continue;
            const permission = reflector.get<string>(REQUIRED_PERMISSION_KEY, handler);
            const isPublic =
              classPublic || (reflector.get<boolean>(IS_PUBLIC_KEY, handler) ?? false);
            const noStepUp = reflector.get<boolean>(NO_STEP_UP_KEY, handler) ?? false;
            const scoped = reflector.get<{ company?: string; branch?: string }>(
              SCOPED_PARAM_KEY,
              handler,
            );
            const path = join('v1', base, reflector.get<string>(PATH_METADATA, handler) ?? '');
            const auth = isPublic
              ? '@Public'
              : `${permission ?? '<none>'} | ${permission && requiresStepUp(permission) && !noStepUp ? 'STEP-UP' : 'no-step-up'}`;
            const scope = scoped
              ? `scope(${scoped.company ?? '-'},${scoped.branch ?? '-'})`
              : 'unscoped';
            rows.push(
              `${w.metatype.name}: ${METHOD[method] ?? method} ${path} => ${auth} | ${scope}`,
            );
          }
        }
        return rows.sort();
      }

      it('N8: the public surface — the Task 3b.8 routes are EXACTLY the frozen ones; no standalone CreditNote / Refund / CancellationCharge route, read or write, exists (the Orders, Payments and Receivables route tables are pinned)', () => {
        const table = routeTable();
        const BR = '/v1/companies/:companyId/branches/:branchId';
        const CU = `${BR}/customers/:customerId`;
        const S = 'scope(companyId,branchId)';
        const expected = [
          `CustomerAccountReadController: GET ${CU}/account/advances => receivables:view | no-step-up | ${S}`,
          `CustomerAccountReadController: GET ${CU}/account/receivables => receivables:view | no-step-up | ${S}`,
          `CustomerAccountReadController: GET ${CU}/account/statement => receivables:view | no-step-up | ${S}`,
          `CustomerAccountReadController: GET ${CU}/account/summary => receivables:view | no-step-up | ${S}`,
          `CustomerAccountReadController: GET ${CU}/account/unapplied-receipts => receivables:view | no-step-up | ${S}`,
          `CustomerAdvanceApplicationController: POST ${CU}/advances/:advanceId/applications => receivables:advance:apply | no-step-up | ${S}`,
          `CustomerReceiptController: POST ${CU}/receipts => receivables:collect | no-step-up | ${S}`,
          `CustomerWithOpeningBalanceController: POST ${BR}/customers => customers:manage | no-step-up | ${S}`,
          `InvoiceController: GET ${BR}/invoices/:id => orders:view | no-step-up | ${S}`,
          `OpeningBalanceController: POST ${CU}/opening-balance => receivables:opening_balance:manage | STEP-UP | ${S}`,
          `OrderController: GET ${BR}/orders => orders:view | no-step-up | ${S}`,
          `OrderController: GET ${BR}/orders/:id => orders:view | no-step-up | ${S}`,
          `OrderController: PATCH ${BR}/orders/:id => orders:manage | no-step-up | ${S}`,
          `OrderController: POST ${BR}/orders => orders:manage | no-step-up | ${S}`,
          // the cancellation COMMAND: orders:cancel, no route-level step-up (the no-charge path moves no money);
          // the financial-DOCUMENT authorities + step-up are enforced INSIDE (see N5c)
          `OrderController: POST ${BR}/orders/:id/cancel => orders:cancel | no-step-up | ${S}`,
          `OrderController: POST ${BR}/orders/:id/hold => orders:manage | no-step-up | ${S}`,
          `OrderController: POST ${BR}/orders/:id/resume => orders:manage | no-step-up | ${S}`,
          `PaymentAdvanceConversionController: POST ${CU}/advances/from-payment => receivables:advance:apply | no-step-up | ${S}`,
          `PaymentAttemptController: POST ${BR}/invoices/:invoiceId/payment-attempts => payments:collect | no-step-up | ${S}`,
          `PaymentController: POST ${BR}/invoices/:invoiceId/payments => payments:collect | no-step-up | ${S}`,
          `PaymentWebhookController: POST /v1/webhooks/payments/:endpointId => @Public | unscoped`,
          // the ONE Refund route: refunds:execute, step-up by permission (no @NoStepUp)
          `RefundController: POST ${CU}/advances/:advanceId/refunds => refunds:execute | STEP-UP | ${S}`,
        ].sort();
        const modules = new Set(expected.map((e) => e.slice(0, e.indexOf(':'))));
        const actual = table.filter((r) => modules.has(r.slice(0, r.indexOf(':'))));
        expect(actual).toEqual(expected);

        // nothing else — anywhere in the application — carries a 3b.8 document permission or path
        const everyRoute = table.join('\n');
        for (const forbidden of [
          /credit_notes:/, // issued INSIDE the cancellation, never a route's own permission
          /cancellation_charges:/,
          /refunds:view/,
          /credit-note/i,
          /cancellation-charge/i,
        ]) {
          expect(everyRoute, String(forbidden)).not.toMatch(forbidden);
        }
        // exactly ONE route mentions "refund" at all (the POST above) and none is a read
        const refundRoutes = table.filter((r) => /refund/i.test(r));
        expect(refundRoutes).toEqual([
          `RefundController: POST ${CU}/advances/:advanceId/refunds => refunds:execute | STEP-UP | ${S}`,
        ]);
        // and the permission the owner forbade does not exist anywhere in the route table
        expect(everyRoute).not.toMatch(/receivables:credit_note:issue/);
      });

      // ═══════ HG1 — the FROZEN role matrix, end to end through the REAL system-role templates ═══
      it('N9: frozen role matrix — owner/admin/manager cancel; accountant holds credit_notes + refunds + charges but can NOT cancel; cashier/sales can do nothing; step-up gates every money action; a denial mutates NOTHING', async () => {
        const FROZEN = {
          cancel: ['owner', 'admin', 'manager'],
          creditNotes: ['owner', 'admin', 'manager', 'accountant'],
          refunds: ['owner', 'admin', 'manager', 'accountant'],
          charges: ['owner', 'admin', 'manager', 'accountant'],
        };
        const ROLES = ['owner', 'admin', 'manager', 'accountant', 'cashier', 'sales'];
        // the templates themselves carry exactly the frozen matrix for these keys
        const holds = (role: string, key: string): boolean =>
          SYSTEM_ROLE_TEMPLATES.find((r) => r.key === role)!.permissions.includes(key);
        for (const role of ROLES) {
          expect(holds(role, 'orders:cancel'), `${role} orders:cancel`).toBe(
            FROZEN.cancel.includes(role),
          );
          expect(holds(role, 'credit_notes:issue'), `${role} credit_notes:issue`).toBe(
            FROZEN.creditNotes.includes(role),
          );
          expect(holds(role, 'refunds:execute'), `${role} refunds:execute`).toBe(
            FROZEN.refunds.includes(role),
          );
          expect(
            holds(role, 'cancellation_charges:issue'),
            `${role} cancellation_charges:issue`,
          ).toBe(FROZEN.charges.includes(role));
        }

        const roleTok = (role: string, stepUp: boolean) =>
          mintTenant(
            `hg-role-${role}-${stepUp ? 'su' : 'nosu'}`,
            tenantA,
            [...SYSTEM_ROLE_TEMPLATES.find((r) => r.key === role)!.permissions],
            {
              branchScope: 'ALL',
              stepUp,
            },
          );
        const draft = async (customer?: string) => {
          const o = await createOrderIn(coA, branchA, {
            lines: [
              {
                productId: await productIdFor(variantId),
                variantId,
                selectedUomCode: 'piece',
                quantity: '2',
              },
            ],
            ...(customer ? { customerId: customer } : {}),
          });
          return o.id;
        };
        const advanceFor = async (customer: string): Promise<string> => {
          const t = await realInvoiceInCoA(customer);
          const r = await receiptIn(coA, branchA, customer, '1000', 'CASH');
          expect(r.statusCode, r.payload).toBe(201);
          const c = await cancelIn(coA, branchA, t.orderId, hgCancelTok);
          expect(c.statusCode, c.payload).toBe(200);
          return (
            await sql<{ id: string }>(
              `SELECT r."customerAdvanceId" AS id FROM credit_note_coverage_release r
                 JOIN credit_note cn ON cn.id = r."creditNoteId" WHERE cn."invoiceId" = $1`,
              [t.invoiceId],
            )
          )[0]!.id;
        };
        const refundWith = (token: string, customer: string, advanceId: string) =>
          req(
            'POST',
            `/companies/${coA}/branches/${branchA}/customers/${customer}/advances/${advanceId}/refunds`,
            token,
            { requestedAmountMinor: '100', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
            { 'idempotency-key': ik() },
          );

        type Scenario = 'cancel' | 'cancel+charge' | 'cancel invoiced' | 'refund';
        const allowed = (role: string, sc: Scenario): boolean => {
          const c = FROZEN.cancel.includes(role);
          if (sc === 'cancel') return c;
          if (sc === 'cancel+charge') return c && FROZEN.charges.includes(role);
          if (sc === 'cancel invoiced') return c && FROZEN.creditNotes.includes(role);
          return FROZEN.refunds.includes(role);
        };
        const attempt = async (role: string, stepUp: boolean, sc: Scenario) => {
          const token = await roleTok(role, stepUp);
          const customer = await newCustomerIn(
            coA,
            `n9-${role}-${sc.replace(/\W+/g, '')}-${stepUp ? 1 : 0}`,
          );
          let call: () => Promise<{ statusCode: number; payload: string; json: () => unknown }>;
          let resourceId: string;
          if (sc === 'cancel') {
            resourceId = await draft(customer);
            call = () => cancelIn(coA, branchA, resourceId, token);
          } else if (sc === 'cancel+charge') {
            resourceId = await draft(customer);
            call = () => cancelIn(coA, branchA, resourceId, token, CHARGE);
          } else if (sc === 'cancel invoiced') {
            resourceId = (await realInvoiceInCoA(customer)).orderId;
            call = () => cancelIn(coA, branchA, resourceId, token);
          } else {
            const adv = await advanceFor(customer);
            resourceId = adv;
            call = () => refundWith(token, customer, adv);
          }
          const before = {
            footprint: await footprint(),
            cn: await counterOf(coA, 'CREDIT_NOTE'),
            cc: await counterOf(coA, 'CANCELLATION_CHARGE'),
          };
          const res = await call();
          return { res, before, resourceId };
        };

        for (const role of ROLES) {
          for (const sc of ['cancel', 'cancel+charge', 'cancel invoiced', 'refund'] as Scenario[]) {
            const label = `${role} / ${sc} / step-up`;
            const { res, before } = await attempt(role, true, sc);
            if (allowed(role, sc)) {
              expect(res.statusCode, `${label}: ${res.payload}`).toBe(sc === 'refund' ? 201 : 200);
            } else {
              expect(res.statusCode, `${label}: ${res.payload}`).toBe(403);
              expect(errCode(res), label).toBe('MISSING_PERMISSION');
              expect(await footprint(), `${label}: no row of any kind`).toEqual(before.footprint);
              expect(await counterOf(coA, 'CREDIT_NOTE'), label).toBe(before.cn);
              expect(await counterOf(coA, 'CANCELLATION_CHARGE'), label).toBe(before.cc);
            }
          }
        }
        // WITHOUT a fresh step-up: every money-moving action is refused for every role that otherwise holds it,
        // the no-money cancellation is NOT step-up gated, and a refusal mutates nothing
        for (const role of ['owner', 'admin', 'manager', 'accountant']) {
          for (const sc of ['cancel+charge', 'cancel invoiced', 'refund'] as Scenario[]) {
            if (!allowed(role, sc)) continue;
            const label = `${role} / ${sc} / NO step-up`;
            const { res, before } = await attempt(role, false, sc);
            expect(res.statusCode, `${label}: ${res.payload}`).toBe(403);
            expect(errCode(res), label).toBe('STEP_UP_REQUIRED');
            expect(await footprint(), `${label}: no row of any kind`).toEqual(before.footprint);
            expect(await counterOf(coA, 'CREDIT_NOTE'), label).toBe(before.cn);
            expect(await counterOf(coA, 'CANCELLATION_CHARGE'), label).toBe(before.cc);
          }
        }
        for (const role of ['owner', 'admin', 'manager']) {
          const { res } = await attempt(role, false, 'cancel');
          expect(res.statusCode, `${role} plain cancel without step-up: ${res.payload}`).toBe(200);
        }
      }, 300_000);

      async function mintImpersonated(id: string, perms: string[]): Promise<string> {
        const s2 = baseSess(`imp-${id}`, 'tenant');
        s2.tenantId = tenantA;
        s2.userId = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
        s2.accountType = 'OWNER';
        s2.mfaLevel = 'STEP_UP';
        s2.stepUpUntil = Date.now() + 600_000;
        s2.impersonatorPlatformUserId = PLATFORM_USER;
        s2.access = {
          effectivePermissions: perms,
          companyScope: 'ALL',
          branchScope: 'ALL',
          perBranchOverlay: {},
          entitledModules: [],
          planKey: null,
        };
        await store.set(s2);
        return jwt.sign({ sub: s2.userId, sid: s2.sessionId, aud: 'tenant', tid: tenantA });
      }

      it('N10: an IMPERSONATED (support) session can never cancel or refund — even holding every permission and a fresh step-up — and mutates nothing', async () => {
        const all = [
          ...ORDER_PERMS,
          'credit_notes:issue',
          'cancellation_charges:issue',
          'refunds:execute',
          'receivables:view',
        ];
        const imp = await mintImpersonated('n10', all);
        const customer = await newCustomerIn(coA, 'n10');
        const invoiced = await realInvoiceInCoA(customer);
        const draftOrder = await createOrderIn(coA, branchA, {
          lines: [
            {
              productId: await productIdFor(variantId),
              variantId,
              selectedUomCode: 'piece',
              quantity: '2',
            },
          ],
          customerId: customer,
        });
        const paid = await newCustomerIn(coA, 'n10-paid');
        const paidInvoice = await realInvoiceInCoA(paid);
        expect((await receiptIn(coA, branchA, paid, '1000', 'CASH')).statusCode).toBe(201);
        expect((await cancelIn(coA, branchA, paidInvoice.orderId, hgCancelTok)).statusCode).toBe(
          200,
        );
        const adv = (
          await sql<{ id: string }>(
            `SELECT r."customerAdvanceId" AS id FROM credit_note_coverage_release r
               JOIN credit_note cn ON cn.id = r."creditNoteId" WHERE cn."invoiceId" = $1`,
            [paidInvoice.invoiceId],
          )
        )[0]!.id;

        const before = await footprint();
        const attempts = [
          await cancelIn(coA, branchA, draftOrder.id, imp),
          await cancelIn(coA, branchA, draftOrder.id, imp, CHARGE),
          await cancelIn(coA, branchA, invoiced.orderId, imp),
          await req(
            'POST',
            `/companies/${coA}/branches/${branchA}/customers/${paid}/advances/${adv}/refunds`,
            imp,
            { requestedAmountMinor: '100', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
            { 'idempotency-key': ik() },
          ),
        ];
        for (const r of attempts) {
          expect(r.statusCode, r.payload).toBe(403);
          expect(errCode(r)).toBe('IMPERSONATION_READ_ONLY');
        }
        expect(await footprint()).toEqual(before);
        expect(
          (
            await sql<{ status: string }>(`SELECT status FROM "order" WHERE id = $1`, [
              draftOrder.id,
            ])
          )[0]!.status,
        ).toBe('DRAFT');
      });

      // ═══════ HG13 — tenant / company / branch / POS isolation of the 3b.8 financial routes ══════
      it('N11: tenant, company, branch and POS-terminal isolation — an out-of-scope caller (cross-tenant, wrong company, sibling branch, a POS id belonging to ANOTHER branch) gets a non-disclosing 404 on cancel / cancel+charge / CASH refund / BANK refund and mutates NOTHING; the same-branch controls succeed', async () => {
        const PERMS = [
          ...ORDER_PERMS,
          'credit_notes:issue',
          'cancellation_charges:issue',
          'refunds:execute',
        ];
        const mk = (id: string, forTenant: string, opts: Parameters<typeof mintTenant>[3]) =>
          mintTenant(`hg-n11-${id}`, forTenant, PERMS, { stepUp: true, ...opts });
        const branchBOnly = await mk('branch-b', tenantA, { branchScope: [branchB] });
        // a POS terminal that belongs to branch A — bound onto a session that is authorized for branch B ONLY
        const posOfOtherBranch = await mk('pos-other', tenantA, {
          branchScope: [branchB],
          posTerminalId,
        });
        const otherTenant = await mk('tenant-b', tenantB, { branchScope: 'ALL' });
        const branchAStaff = await mk('branch-a', tenantA, { branchScope: [branchA] });
        const branchAPos = await mk('branch-a-pos', tenantA, {
          branchScope: [branchA],
          posTerminalId,
        });

        // the "wrong company" attacker targets coA2 — give it a fee tax category so a with-charge request is
        // not stopped by ITS OWN (unrelated) tax-policy gate before it ever reaches the order lookup
        await sql(`UPDATE company SET "cancellationFeeTaxCategoryKey" = 'STD3B3' WHERE id = $1`, [
          coA2,
        ]);
        const customer = await newCustomerIn(coA, 'n11');
        const invoiced = await realInvoiceInCoA(customer); // post-invoice target
        const invoicedForCharge = await realInvoiceInCoA(customer);
        const drafted = await createOrderIn(coA, branchA, {
          lines: [
            {
              productId: await productIdFor(variantId),
              variantId,
              selectedUomCode: 'piece',
              quantity: '2',
            },
          ],
          customerId: customer,
        });
        const advCustomer = await newCustomerIn(coA, 'n11-adv');
        const advInvoice = await realInvoiceInCoA(advCustomer);
        expect(
          (await receiptIn(coA, branchA, advCustomer, '2000', 'OTHER_MANUAL')).statusCode,
        ).toBe(201);
        expect((await cancelIn(coA, branchA, advInvoice.orderId, hgCancelTok)).statusCode).toBe(
          200,
        );
        const adv = (
          await sql<{ id: string }>(
            `SELECT r."customerAdvanceId" AS id FROM credit_note_coverage_release r
               JOIN credit_note cn ON cn.id = r."creditNoteId" WHERE cn."invoiceId" = $1`,
            [advInvoice.invoiceId],
          )
        )[0]!.id;

        const refundAt = (
          token: string,
          company: string,
          branch: string,
          method: 'CASH' | 'BANK_TRANSFER',
        ) =>
          req(
            'POST',
            `/companies/${company}/branches/${branch}/customers/${advCustomer}/advances/${adv}/refunds`,
            token,
            { requestedAmountMinor: '100', method, reasonCode: 'CUSTOMER_REQUEST' },
            { 'idempotency-key': ik() },
          );
        const attackers: [string, string, string, string][] = [
          ['cross-tenant owner', otherTenant, coA, branchA],
          ['sibling-branch staff (path = victim branch)', branchBOnly, coA, branchA],
          ['sibling-branch staff (path = own branch, victim id)', branchBOnly, coA, branchB],
          [
            'POS id of branch A on a branch-B session (path = victim branch)',
            posOfOtherBranch,
            coA,
            branchA,
          ],
          [
            'POS id of branch A on a branch-B session (path = own branch, victim id)',
            posOfOtherBranch,
            coA,
            branchB,
          ],
          ['wrong company for the branch', branchAStaff, coA2, branchA],
        ];
        const stateOf = async () => ({
          footprint: await footprint(),
          orders: await sql(
            `SELECT id, status, version FROM "order" WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[invoiced.orderId, invoicedForCharge.orderId, drafted.id]],
          ),
          adv: await sql(
            `SELECT "customerAdvanceId", COALESCE(SUM(a."amountMinor"),0)::text AS refunded
               FROM customer_advance_refund_application a WHERE a."customerAdvanceId" = $1 GROUP BY 1`,
            [adv],
          ),
        });
        const before = await stateOf();
        for (const [label, token, company, branch] of attackers) {
          const calls = [
            ['cancel invoiced', () => cancelIn(company, branch, invoiced.orderId, token)],
            [
              'cancel invoiced + charge',
              () => cancelIn(company, branch, invoicedForCharge.orderId, token, CHARGE),
            ],
            ['cancel draft + charge', () => cancelIn(company, branch, drafted.id, token, CHARGE)],
            ['CASH refund', () => refundAt(token, company, branch, 'CASH')],
            ['BANK refund', () => refundAt(token, company, branch, 'BANK_TRANSFER')],
          ] as const;
          for (const [what, fn] of calls) {
            const res = await fn();
            expect(res.statusCode, `${label} / ${what}: ${res.payload}`).toBe(404);
            // non-disclosing: the body never confirms the resource exists elsewhere
            expect(res.payload, `${label} / ${what}`).not.toContain(invoiced.orderId);
          }
          expect(await stateOf(), `${label}: nothing mutated`).toEqual(before);
        }

        // controls — the SAME-branch staff and a POS-bound same-branch session act on exactly these resources
        const c1 = await cancelIn(coA, branchA, invoiced.orderId, branchAStaff);
        expect(c1.statusCode, c1.payload).toBe(200);
        const c2 = await cancelIn(coA, branchA, invoicedForCharge.orderId, branchAPos, CHARGE);
        expect(c2.statusCode, c2.payload).toBe(200); // a terminal id confers no extra/less reach inside its OWN branch
        const r1 = await refundAt(branchAPos, coA, branchA, 'CASH');
        expect(r1.statusCode, r1.payload).toBe(201);
        const r2 = await refundAt(branchAStaff, coA, branchA, 'BANK_TRANSFER');
        expect(r2.statusCode, r2.payload).toBe(201);
      }, 300_000);
    });

    // ═══════ O — migration 49 (O-2B) at the application layer ═══════
    // The DB-level matrix (`packages/db/test/3b8-currency-release-integrity.integration.test.ts`) proves that every
    // refused raw case leaves no trace in ANY table. This proves it through the REAL internal primitive — the one
    // place the application hands the database an account id: a credit note issued for ONE customer's invoice but
    // funded into ANOTHER customer's account is refused by the database, and EVERYTHING the primitive wrote in its
    // transaction (credit note, lines, release, advance, chronology entry, the GL journal, the audit row, the
    // account projections, the document-number counter) rolls back with it. (The currency and release-scope guards
    // have no application-layer trigger path: the primitives derive currency from the invoice / advance / payment,
    // and a mis-scoped credit note already fails its own composite FK to the invoice first.)
    describe("O — migration 49 (O-2B) at the application layer: the credit-note primitive handed another customer's account", () => {
      const WATCHED = [
        'credit_note',
        'credit_note_line',
        'credit_note_coverage_release',
        'customer_advance',
        'customer_advance_application',
        'customer_advance_refund_application',
        'customer_account_entry',
        'customer_company_account',
        'customer_receivable',
        'journal_entry',
        'journal_line',
        'audit_log',
        'outbox',
        'document_number_counter',
        'payment',
        'payment_allocation',
        'invoice',
        '"order"',
        'refund',
        'cancellation_charge',
      ] as const;
      /** row count + md5 of every row's text for each table a credit note can touch — projections, journals and
       *  audit rows included */
      const state = async (): Promise<Record<string, string>> => {
        const out: Record<string, string> = {};
        for (const t of WATCHED) {
          const r = await sql<{ n: string; h: string }>(
            `SELECT count(*)::text AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
          );
          out[t] = `${r[0]!.n}:${r[0]!.h}`;
        }
        return out;
      };
      const accountOf = async (customerId: string): Promise<string> =>
        (
          await sql<{ id: string }>(
            `SELECT id FROM customer_company_account WHERE "customerId" = $1 AND "companyId" = $2`,
            [customerId, coA],
          )
        )[0]!.id;

      it("O1: a credit note funded into ANOTHER customer's account is refused at the database and nothing survives — no credit note / line / release / advance / chronology entry / journal / audit / outbox row, no projection change, no document number consumed; the same primitive with the RIGHT account succeeds", async () => {
        const customerId = await newCustomer('o1');
        const intruderId = await newCustomer('o1-intruder');
        const { orderId, invoiceId } = await openInvoiceFor(customerId);
        const paid = await receipt(customerId, '1000', 'OTHER_MANUAL');
        expect(paid.statusCode, paid.payload).toBe(201);
        const rightAccount = await accountOf(customerId);
        const wrongAccount = await accountOf(intruderId);
        expect(wrongAccount).not.toBe(rightAccount);

        const creditNote = app.get(CreditNoteRepository);
        const db = app.get(DbService);
        const issue = (customerCompanyAccountId: string) =>
          runScoped(db.appClient(), { tenantId: tenantA, branchId: branchA }, (tx) =>
            creditNote.issueCreditNoteForFullCancellation(tx, {
              tenantId: tenantA,
              companyId: coA,
              branchId: branchA,
              orderId,
              invoiceId,
              customerCompanyAccountId,
              reasonCode: 'CUSTOMER_REQUEST',
              note: null,
              accountingDate: new Date().toISOString().slice(0, 10),
              actorUserId: null,
            }),
          );

        const before = await state();
        await expect(issue(wrongAccount)).rejects.toThrow(
          /belongs to a different customer than credit_note/,
        );
        expect(await state(), 'a refused credit note leaves NO trace in any table').toEqual(before);
        await integrityHolds(customerId);
        await integrityHolds(intruderId);

        // control — the SAME primitive with the invoice customer's own account succeeds: 1000 released into ONE advance
        const ok = await issue(rightAccount);
        expect(ok.advanceExcessMinor).toBe(1000n);
        expect(ok.arReductionMinor).toBe(1000n);
        const after = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM customer_advance a
             JOIN customer_company_account cca ON cca.id = a."customerCompanyAccountId"
            WHERE cca."customerId" = $1 AND a."sourceType" = 'CREDIT_NOTE'`,
          [customerId],
        );
        expect(after[0]!.n).toBe('1');
      }, 120_000);
    });
  });
});
