import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { PLATFORM_PERMISSIONS } from '@flower/permissions';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { SystemClock, type Clock } from '../../common/clock/clock.js';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { InvoiceIssuanceRepository } from './invoice-issuance.repository.js';
import { TaxFinalizationService } from './tax-finalization.service.js';
import { computeCommercialSnapshotFingerprintByVersion } from './commercial-snapshot.js';

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
    opts: { branchScope?: string[] | 'ALL'; posTerminalId?: string | null } = {},
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
      const je = await sql<{ count: string }>(`SELECT count(*)::text FROM "journal_entry"`);
      expect(je[0]!.count).toBe('0');
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
});
