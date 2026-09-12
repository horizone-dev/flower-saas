import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

const PLAN_V = '00000000-0000-7000-8000-000000390001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000390002';
const CATALOG = ['catalog:view', 'catalog:manage', 'variants:manage'];

/**
 * Task 3.9 — catalog tax-category assignment + effective tax-rate resolution
 * (integration). Covers the owner-approved proof set: product / variant
 * assignment + precedence (variant -> product -> NONE), clearing an override,
 * NULL != 0% (three distinct reasons), configured 0% is returned distinctly,
 * effective-date rate selection (SA 5% -> 15%), missing category / missing rate,
 * regime NONE (QA), Company.countryCode authority, `catalog:manage` (product) /
 * `variants:manage` (variant) / `catalog:view` (resolution) permission split, no
 * new capability, ARCHIVED product/variant blocked, optimistic concurrency,
 * one audit row per assignment, no audit on GET, no tax amount, no
 * branch/POS authority leakage, no realtime/outbox, tenant + company isolation.
 */
describe('catalog tax-category + rate resolution (task 3.9, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let superTok = '';
  let tenantA = '';
  let tenantB = '';
  let ownerA = ''; // full CATALOG, companyScope ALL
  let viewerA = ''; // catalog:view only
  let managerOnlyA = ''; // catalog:manage + catalog:view (NO variants:manage)
  let variantsOnlyA = ''; // variants:manage + catalog:view (NO catalog:manage)
  let scopedA = ''; // CATALOG but companyScope = [coAE] only
  let posA = ''; // a POS session (posTerminalId set), companyScope = [coAE]
  let ownerB = '';
  let coAE = '';
  let coQA = '';
  let coSA = '';
  let coNoCountry = ''; // a tenant-A company with countryCode = NULL
  let coB = '';

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
    tenantA = await provision('tax-a', 'AE');
    tenantB = await provision('tax-b', 'AE');

    coAE = (await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantA]))[0]!
      .id;
    coB = (await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantB]))[0]!
      .id;
    coQA = await mkCompany(tenantA, 'Qatar Co', 'QA', 'QAR');
    coSA = await mkCompany(tenantA, 'KSA Co', 'SA', 'SAR');
    coNoCountry = await mkCompany(tenantA, 'No-Country Co', null, null);

    ownerA = await mintTenant('oa', tenantA, CATALOG);
    viewerA = await mintTenant('va', tenantA, ['catalog:view']);
    managerOnlyA = await mintTenant('ma', tenantA, ['catalog:view', 'catalog:manage']);
    variantsOnlyA = await mintTenant('vo', tenantA, ['catalog:view', 'variants:manage']);
    scopedA = await mintTenant('sa', tenantA, CATALOG, { companyScope: [coAE] });
    posA = await mintTenant('pa', tenantA, CATALOG, {
      companyScope: [coAE],
      posTerminalId: '00000000-0000-7000-8000-0000000000fe',
    });
    ownerB = await mintTenant('ob', tenantB, CATALOG);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── harness ──────────────────────────────────────────────────────────────
  function base(sessionId: string, realm: 'tenant' | 'platform'): SessionData {
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
    const s = base('plat', 'platform');
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
    opts: { companyScope?: string[] | 'ALL'; posTerminalId?: string | null } = {},
  ): Promise<string> {
    const s = base(`ten-${id}`, 'tenant');
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
      companyScope: opts.companyScope ?? 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: s.userId, sid: s.sessionId, aud: 'tenant', tid: forTenant });
  }
  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      return (await c.query(text, params)).rows as T[];
    } finally {
      await c.end();
    }
  }
  const count = async (text: string, params: unknown[] = []): Promise<number> =>
    Number((await sql<{ n: string }>(text, params))[0]!.n);
  async function mkCompany(
    tenantId: string,
    name: string,
    country: string | null,
    currency: string | null,
  ): Promise<string> {
    const rows = await sql<{ id: string }>(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","status","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'ACTIVE',now()) RETURNING id`,
      [tenantId, name, country, currency],
    );
    return rows[0]!.id;
  }
  let idemN = 0;
  const ik = (): string => `t39-key-${String(++idemN).padStart(4, '0')}`;
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;

  async function mkVariant(
    token: string,
    slug: string,
  ): Promise<{
    productId: string;
    variantId: string;
    productVersion: number;
    variantVersion: number;
  }> {
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
    const productVersion = (p.json() as { version: number }).version;
    const vs = (await req('GET', `/catalog/products/${productId}/variants`, token)).json() as {
      id: string;
      version: number;
    }[];
    return {
      productId,
      variantId: vs[0]!.id,
      productVersion,
      variantVersion: vs[0]!.version,
    };
  }
  const getProduct = async (id: string, token = ownerA) =>
    (await req('GET', `/catalog/products/${id}`, token)).json() as {
      version: number;
      status: string;
    };
  const getVariant = async (id: string, token = ownerA) =>
    (await req('GET', `/catalog/variants/${id}`, token)).json() as {
      version: number;
      status: string;
    };
  const setProductTax = (id: string, key: string | null, ifMatch: string, token = ownerA) =>
    req(
      'PUT',
      `/catalog/products/${id}/tax-category`,
      token,
      { taxCategoryKey: key },
      {
        'if-match': ifMatch,
      },
    );
  const setVariantTax = (id: string, key: string | null, ifMatch: string, token = ownerA) =>
    req(
      'PUT',
      `/catalog/variants/${id}/tax-category`,
      token,
      { taxCategoryKey: key },
      {
        'if-match': ifMatch,
      },
    );
  // Resolution input is a REQUIRED `?date=YYYY-MM-DD` civil calendar date. When a
  // test does not care about the date it omits `query` and this default is used.
  const resolveTax = (companyId: string, variantId: string, query = '', token = ownerA) =>
    req(
      'GET',
      `/catalog/companies/${companyId}/variants/${variantId}/tax${query || '?date=2026-01-15'}`,
      token,
    );
  type Resolution = {
    variantId: string;
    companyId: string;
    countryCode: string;
    regime: 'VAT' | 'NONE';
    taxCategoryKey: string | null;
    categorySource: 'VARIANT' | 'PRODUCT' | 'NONE';
    rateBps: number | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    resolvedDate: string;
    reason: string | null;
  };

  // ════════════ assignment ═══════════════════════════════════════════════════
  it('product assignment: assign, reassign, clear — each bumps product.version + writes exactly one audit row', async () => {
    const { productId, productVersion } = await mkVariant(ownerA, 'p-assign');
    const auditsBefore = await count(
      `SELECT count(*)::text AS n FROM audit_log WHERE action='catalog.product_tax_category_changed' AND "resourceId"=$1`,
      [productId],
    );

    const r1 = await setProductTax(productId, 'STANDARD', `"${productVersion}"`);
    expect(r1.statusCode, r1.payload).toBe(200);
    expect(r1.json()).toEqual({ taxCategoryKey: 'STANDARD', version: productVersion + 1 });
    expect(r1.headers['etag']).toBe(`"${productVersion + 1}"`);

    const r2 = await setProductTax(productId, 'ZERO_RATED', `"${productVersion + 1}"`);
    expect(r2.json()).toEqual({ taxCategoryKey: 'ZERO_RATED', version: productVersion + 2 });

    const r3 = await setProductTax(productId, null, `"${productVersion + 2}"`);
    expect(r3.json()).toEqual({ taxCategoryKey: null, version: productVersion + 3 });

    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit_log WHERE action='catalog.product_tax_category_changed' AND "resourceId"=$1`,
        [productId],
      ),
    ).toBe(auditsBefore + 3);
    // before/after payload is bounded to { taxCategoryKey }
    const rows = await sql<{ before: unknown; after: unknown }>(
      `SELECT "before", "after" FROM audit_log WHERE action='catalog.product_tax_category_changed' AND "resourceId"=$1 ORDER BY "at" DESC LIMIT 1`,
      [productId],
    );
    expect(rows[0]).toEqual({
      before: { taxCategoryKey: 'ZERO_RATED' },
      after: { taxCategoryKey: null },
    });
  });

  it('variant assignment overrides the product; clearing the override falls back to the product (precedence)', async () => {
    const { productId, variantId, productVersion, variantVersion } = await mkVariant(
      ownerA,
      'v-override',
    );
    await setProductTax(productId, 'STANDARD', `"${productVersion}"`);
    // no override yet -> resolution reads PRODUCT
    let res = (await resolveTax(coAE, variantId)).json() as Resolution;
    expect(res).toMatchObject({
      categorySource: 'PRODUCT',
      taxCategoryKey: 'STANDARD',
      rateBps: 500,
    });

    const set = await setVariantTax(variantId, 'EXEMPT', `"${variantVersion}"`);
    expect(set.statusCode, set.payload).toBe(200);
    res = (await resolveTax(coAE, variantId)).json() as Resolution;
    expect(res).toMatchObject({
      categorySource: 'VARIANT',
      taxCategoryKey: 'EXEMPT',
      rateBps: 0,
      reason: null,
    });

    // clear the override -> inherit the product again
    const cleared = await setVariantTax(variantId, null, `"${variantVersion + 1}"`);
    expect(cleared.json()).toEqual({ taxCategoryKey: null, version: variantVersion + 2 });
    res = (await resolveTax(coAE, variantId)).json() as Resolution;
    expect(res).toMatchObject({ categorySource: 'PRODUCT', taxCategoryKey: 'STANDARD' });
  });

  it('unknown-but-well-formed key -> 422 TAX_CATEGORY_UNKNOWN; malformed key -> 400; missing If-Match -> 428; stale -> 409', async () => {
    const { productId, variantId, productVersion, variantVersion } = await mkVariant(
      ownerA,
      'p-errs',
    );
    const unknown = await setProductTax(productId, 'MADE_UP_KEY', `"${productVersion}"`);
    expect(unknown.statusCode).toBe(422);
    expect(errCode(unknown)).toBe('TAX_CATEGORY_UNKNOWN');

    const malformed = await req(
      'PUT',
      `/catalog/products/${productId}/tax-category`,
      ownerA,
      { taxCategoryKey: 'lower' },
      { 'if-match': `"${productVersion}"` },
    );
    expect(malformed.statusCode).toBe(400);

    const noMatch = await req('PUT', `/catalog/variants/${variantId}/tax-category`, ownerA, {
      taxCategoryKey: 'STANDARD',
    });
    expect(noMatch.statusCode).toBe(428);

    const stale = await setVariantTax(variantId, 'STANDARD', `"${variantVersion + 9}"`);
    expect(stale.statusCode).toBe(409);
    expect(errCode(stale)).toBe('VARIANT_VERSION_CONFLICT');
    // a stale write leaves no audit row and no mutation
    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit_log WHERE action='catalog.variant_tax_category_changed' AND "resourceId"=$1`,
        [variantId],
      ),
    ).toBe(0);
    expect((await getVariant(variantId)).version).toBe(variantVersion);
  });

  it('ARCHIVED product / variant tax-category writes are BLOCKED (owner O2) — 409, no mutation, no audit', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'p-arch');
    // archive the variant, then the product
    let v = await getVariant(variantId);
    const av = await req('POST', `/catalog/variants/${variantId}/archive`, ownerA, undefined, {
      'idempotency-key': ik(),
      'if-match': `"${v.version}"`,
    });
    expect(av.statusCode, av.payload).toBe(200);
    let p = await getProduct(productId);
    const ap = await req('POST', `/catalog/products/${productId}/archive`, ownerA, undefined, {
      'idempotency-key': ik(),
      'if-match': `"${p.version}"`,
    });
    expect(ap.statusCode, ap.payload).toBe(200);

    p = await getProduct(productId);
    const pBlocked = await setProductTax(productId, 'STANDARD', `"${p.version}"`);
    expect(pBlocked.statusCode).toBe(409);
    expect(errCode(pBlocked)).toBe('PRODUCT_ARCHIVED');

    v = await getVariant(variantId);
    const vBlocked = await setVariantTax(variantId, 'STANDARD', `"${v.version}"`);
    expect(vBlocked.statusCode).toBe(409);
    expect(errCode(vBlocked)).toBe('VARIANT_ARCHIVED');

    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit_log WHERE action IN ('catalog.product_tax_category_changed','catalog.variant_tax_category_changed') AND "resourceId" IN ($1,$2)`,
        [productId, variantId],
      ),
    ).toBe(0);
    expect((await getProduct(productId)).version).toBe(p.version);
  });

  // ════════════ permission matrix (owner O1) ════════════════════════════════
  it('product assignment needs catalog:manage; variant assignment needs variants:manage; reads need catalog:view', async () => {
    const { productId, variantId, productVersion, variantVersion } = await mkVariant(
      ownerA,
      'perm',
    );

    // catalog:manage user CAN set the product, CANNOT set the variant
    expect(
      (await setProductTax(productId, 'STANDARD', `"${productVersion}"`, managerOnlyA)).statusCode,
    ).toBe(200);
    expect(
      (await setVariantTax(variantId, 'STANDARD', `"${variantVersion}"`, managerOnlyA)).statusCode,
    ).toBe(403);

    // variants:manage user CAN set the variant, CANNOT set the product
    expect(
      (await setVariantTax(variantId, 'STANDARD', `"${variantVersion}"`, variantsOnlyA)).statusCode,
    ).toBe(200);
    expect(
      (await setProductTax(productId, 'EXEMPT', `"${productVersion + 1}"`, variantsOnlyA))
        .statusCode,
    ).toBe(403);

    // catalog:view-only user can resolve but cannot write either
    expect((await resolveTax(coAE, variantId, '', viewerA)).statusCode).toBe(200);
    expect(
      (await setProductTax(productId, 'EXEMPT', `"${productVersion + 1}"`, viewerA)).statusCode,
    ).toBe(403);
  });

  // ════════════ resolution — precedence, dates, zero-rate vs no-rate ═════════
  it('effective-date rate selection: SA STANDARD is 5% before 2020-07-01 and 15% after', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'sa-dates');
    const p = await getProduct(productId);
    await setProductTax(productId, 'STANDARD', `"${p.version}"`);

    const before = (await resolveTax(coSA, variantId, '?date=2020-06-30')).json() as Resolution;
    expect(before).toMatchObject({
      countryCode: 'SA',
      regime: 'VAT',
      rateBps: 500,
      effectiveFrom: '2018-01-01',
      effectiveTo: '2020-06-30',
      reason: null,
      resolvedDate: '2020-06-30',
    });
    const after = (await resolveTax(coSA, variantId, '?date=2020-07-01')).json() as Resolution;
    expect(after).toMatchObject({ rateBps: 1500, effectiveFrom: '2020-07-01', effectiveTo: null });
  });

  it('NULL != 0%: not-configured / regime-NONE / no-rate are THREE distinct reasons, none is rateBps 0', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'distinct');

    // (a) nothing configured -> NO_CATEGORY_ASSIGNED, rateBps null
    let res = (await resolveTax(coAE, variantId)).json() as Resolution;
    expect(res).toMatchObject({
      categorySource: 'NONE',
      taxCategoryKey: null,
      rateBps: null,
      reason: 'NO_CATEGORY_ASSIGNED',
      countryCode: 'AE',
      regime: 'VAT',
    });

    // (b) STANDARD assigned but the company's country has NO VAT regime (QA) ->
    // REGIME_NONE, rateBps null
    const p = await getProduct(productId);
    await setProductTax(productId, 'STANDARD', `"${p.version}"`);
    res = (await resolveTax(coQA, variantId)).json() as Resolution;
    expect(res).toMatchObject({
      countryCode: 'QA',
      regime: 'NONE',
      taxCategoryKey: 'STANDARD',
      categorySource: 'PRODUCT',
      rateBps: null,
      reason: 'REGIME_NONE',
    });

    // (c) a category with no seeded rate in a VAT country -> NO_RATE_FOR_CATEGORY
    const p2 = await getProduct(productId);
    await setProductTax(productId, 'REDUCED', `"${p2.version}"`); // seeded key, no AE rate row
    res = (await resolveTax(coAE, variantId)).json() as Resolution;
    expect(res).toMatchObject({
      regime: 'VAT',
      taxCategoryKey: 'REDUCED',
      rateBps: null,
      reason: 'NO_RATE_FOR_CATEGORY',
    });

    // (d) a genuine configured 0% (ZERO_RATED) -> rateBps 0, reason null
    const p3 = await getProduct(productId);
    await setProductTax(productId, 'ZERO_RATED', `"${p3.version}"`);
    res = (await resolveTax(coAE, variantId)).json() as Resolution;
    expect(res).toMatchObject({ rateBps: 0, reason: null, effectiveFrom: '2018-01-01' });
  });

  it('a category with no in-force rate row in a VAT country → NO_RATE_FOR_CATEGORY (not a 0)', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'norate');
    const p = await getProduct(productId);
    // SA has STANDARD + ZERO_RATED seeded, but NO SA EXEMPT rate row
    await setProductTax(productId, 'EXEMPT', `"${p.version}"`);
    const res = (await resolveTax(coSA, variantId, '?date=2022-01-01')).json() as Resolution;
    expect(res).toMatchObject({
      countryCode: 'SA',
      regime: 'VAT',
      taxCategoryKey: 'EXEMPT',
      rateBps: null,
      effectiveFrom: null,
      reason: 'NO_RATE_FOR_CATEGORY',
    });
  });

  it('a date before the country tax regime existed → 500 TAX_REGIME_NOT_CONFIGURED (fail closed)', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'preregime');
    const p = await getProduct(productId);
    await setProductTax(productId, 'STANDARD', `"${p.version}"`);
    // SA regime starts 2018-01-01; a 2017 date has no country_tax_config row
    const r = await resolveTax(coSA, variantId, '?date=2017-01-01');
    expect(r.statusCode).toBe(500);
    expect(errCode(r)).toBe('TAX_REGIME_NOT_CONFIGURED');
  });

  it('Company.countryCode is authoritative — same variant, different company country, different result; no client override', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'authority');
    const p = await getProduct(productId);
    await setProductTax(productId, 'STANDARD', `"${p.version}"`);

    expect(((await resolveTax(coAE, variantId)).json() as Resolution).countryCode).toBe('AE');
    expect(((await resolveTax(coSA, variantId)).json() as Resolution).countryCode).toBe('SA');

    // an attempt to pass a country / branch / posTerminal override in the query -> 400 (strict)
    expect((await resolveTax(coAE, variantId, '?date=2026-01-15&countryCode=SA')).statusCode).toBe(
      400,
    );
    expect((await resolveTax(coAE, variantId, '?date=2026-01-15&branchId=x')).statusCode).toBe(400);
    expect((await resolveTax(coAE, variantId, '?date=2026-01-15&posTerminalId=x')).statusCode).toBe(
      400,
    );
    // a legacy `?at=` instant is NOT a recognised key anymore -> 400 (strict schema)
    expect((await resolveTax(coAE, variantId, '?at=2020-07-01T00:00:00.000Z')).statusCode).toBe(
      400,
    );
    // a malformed ?date= -> 400 INVALID_DATE
    const badDate = await resolveTax(coAE, variantId, '?date=not-a-date');
    expect(badDate.statusCode).toBe(400);
    expect(errCode(badDate)).toBe('INVALID_DATE');
    // `?date=` is REQUIRED — omitting it is a 400
    const noDate = await req('GET', `/catalog/companies/${coAE}/variants/${variantId}/tax`, ownerA);
    expect(noDate.statusCode).toBe(400);
    expect(errCode(noDate)).toBe('VALIDATION_FAILED');
  });

  it('a company with no countryCode -> 409 COMPANY_LOCALIZATION_NOT_CONFIGURED', async () => {
    const { variantId } = await mkVariant(ownerA, 'nocountry');
    const r = await resolveTax(coNoCountry, variantId);
    expect(r.statusCode).toBe(409);
    expect(errCode(r)).toBe('COMPANY_LOCALIZATION_NOT_CONFIGURED');
  });

  it('resolution GET writes NO audit row (metadata read)', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'noaudit');
    const p = await getProduct(productId);
    await setProductTax(productId, 'STANDARD', `"${p.version}"`);
    const before = await count(`SELECT count(*)::text AS n FROM audit_log`);
    await resolveTax(coAE, variantId);
    await resolveTax(coSA, variantId, '?date=2020-01-01');
    expect(await count(`SELECT count(*)::text AS n FROM audit_log`)).toBe(before);
  });

  it('the resolution response carries NO computed tax amount (rateBps only)', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'noamount');
    const p = await getProduct(productId);
    await setProductTax(productId, 'STANDARD', `"${p.version}"`);
    const res = await resolveTax(coAE, variantId);
    const blob = JSON.stringify(res.json());
    expect(blob).not.toMatch(/amountMinor|taxAmount|"amount"|gross|net|inclusive|exclusive/i);
    expect((res.json() as Resolution).rateBps).toBe(500);
  });

  // ════════════ isolation + scope ═══════════════════════════════════════════
  it('tenant isolation — B cannot assign or resolve A resources (404, no leak)', async () => {
    const { productId, variantId, productVersion } = await mkVariant(ownerA, 'iso');
    await setProductTax(productId, 'STANDARD', `"${productVersion}"`);

    const bAssign = await setProductTax(productId, 'EXEMPT', `"${productVersion + 1}"`, ownerB);
    expect(bAssign.statusCode).toBe(404);
    const bResolve = await resolveTax(coAE, variantId, '', ownerB);
    expect(bResolve.statusCode).toBe(404);
    expect(JSON.stringify(bResolve.json())).not.toContain('STANDARD');
    // even in B's OWN company context, A's variant is not reachable
    expect((await resolveTax(coB, variantId, '', ownerB)).statusCode).toBe(404);
  });

  it('company scope — a user scoped to coAE gets 404 resolving coSA; posTerminalId never selects the company/country', async () => {
    const { productId, variantId } = await mkVariant(ownerA, 'scope');
    const p = await getProduct(productId);
    await setProductTax(productId, 'STANDARD', `"${p.version}"`);

    expect((await resolveTax(coAE, variantId, '', scopedA)).statusCode).toBe(200);
    expect((await resolveTax(coSA, variantId, '', scopedA)).statusCode).toBe(404);

    // a POS session (posTerminalId set, companyScope [coAE]) resolves via the
    // PATH companyId only — coAE works, coSA is out of scope; the country came
    // from company.country_code, never the terminal.
    const pos = await resolveTax(coAE, variantId, '', posA);
    expect(pos.statusCode).toBe(200);
    expect((pos.json() as Resolution).countryCode).toBe('AE');
    expect((await resolveTax(coSA, variantId, '', posA)).statusCode).toBe(404);
  });

  it('unknown / cross-tenant variant or company -> 404', async () => {
    const missing = '00000000-0000-7000-8000-0000000000aa';
    expect((await resolveTax(coAE, missing)).statusCode).toBe(404);
    expect((await resolveTax(missing, missing)).statusCode).toBe(404);
    expect((await setProductTax(missing, 'STANDARD', '"1"')).statusCode).toBe(404);
  });

  // ════════════ scope guards ════════════════════════════════════════════════
  it('no Task 3.10 realtime/outbox — a tax-category assignment writes zero outbox rows', async () => {
    const { productId, productVersion } = await mkVariant(ownerA, 'nooutbox');
    const before = await count(`SELECT count(*)::text AS n FROM outbox`);
    await setProductTax(productId, 'STANDARD', `"${productVersion}"`);
    expect(await count(`SELECT count(*)::text AS n FROM outbox`)).toBe(before);
  });

  it('no new tax table exists; product/variant carry only a nullable taxCategoryKey', async () => {
    const tables = (
      await sql<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%tax%'`,
      )
    ).map((r) => r.table_name);
    expect(tables.sort()).toEqual(['country_tax_config', 'tax_category', 'tax_rate'].sort());
    for (const t of ['product', 'variant']) {
      const cols = (
        await sql<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name ILIKE '%tax%'`,
          [t],
        )
      ).map((r) => r.column_name);
      expect(cols).toEqual(['taxCategoryKey']);
    }
  });

  // ════════════ CHECK 1 — overlapping tax-rate windows (fail closed) ═════════
  // Owner ruling (CHECK 1-B): for ONE (country, taxCategoryKey, civil date) there
  // must be AT MOST ONE applicable tax_rate. `> 1` in-force row — of ANY shape —
  // is corrupt reference data and is NEVER silently resolved by picking one.
  describe('overlapping tax-rate windows', () => {
    // a synthetic isolated country so these mutations never touch the AE/SA seed
    let coTC = '';
    let variantTC = '';
    const CAT = 'CHK1_STD';

    beforeAll(async () => {
      await sql(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('XTS', 2, 'XTS', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
      );
      await sql(
        `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel",active,"updatedAt")
         VALUES ('TC','Testland','x','gcc','XTS','SAT_SUN',true,now()) ON CONFLICT (code) DO NOTHING`,
      );
      await sql(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo","regime")
         VALUES ('TC','2000-01-01',NULL,'VAT')`,
      );
      await sql(
        `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ($1,'x','x') ON CONFLICT (key) DO NOTHING`,
        [CAT],
      );
      coTC = await mkCompany(tenantA, 'Testland Co', 'TC', 'XTS');
      const v = await mkVariant(ownerA, 'chk1');
      variantTC = v.variantId;
      await setProductTax(v.productId, CAT, `"${v.productVersion}"`);
    });

    afterEach(async () => {
      await sql(`DELETE FROM tax_rate WHERE "countryCode"='TC' AND "taxCategoryKey"=$1`, [CAT]);
    });

    const addRate = (from: string, to: string | null, bps: number) =>
      sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom","effectiveTo")
         VALUES ('TC',$1,$2,$3,$4)`,
        [CAT, bps, from, to],
      );
    const at = (d: string) => resolveTax(coTC, variantTC, `?date=${d}`);

    it('1. same effectiveFrom, both active → 500 TAX_RATE_AMBIGUOUS', async () => {
      await addRate('2026-01-01', '2026-12-31', 500);
      await addRate('2026-01-01', null, 600);
      const r = await at('2026-07-01');
      expect(r.statusCode).toBe(500);
      expect(errCode(r)).toBe('TAX_RATE_AMBIGUOUS');
    });

    it('2. different effectiveFrom, overlapping finite ranges → 500 TAX_RATE_AMBIGUOUS (never "newest wins")', async () => {
      await addRate('2026-01-01', '2026-12-31', 500);
      await addRate('2026-06-01', '2027-06-30', 600); // starts later, still overlaps on 2026-07-01
      const r = await at('2026-07-01');
      expect(r.statusCode, r.payload).toBe(500);
      expect(errCode(r)).toBe('TAX_RATE_AMBIGUOUS');
      // outside the overlap (2026-02-01) only the first row is in force → resolves
      const before = await at('2026-02-01');
      expect(before.statusCode).toBe(200);
      expect((before.json() as Resolution).rateBps).toBe(500);
    });

    it('3. old open-ended row + newer active row (Rate A 500 finite, Rate B 600 open) → 500 at the overlap', async () => {
      await addRate('2026-01-01', '2026-12-31', 500); // Rate A
      await addRate('2026-06-01', null, 600); // Rate B — the owner\'s example
      const both = await at('2026-07-01'); // both active
      expect(both.statusCode).toBe(500);
      expect(errCode(both)).toBe('TAX_RATE_AMBIGUOUS');
      // after A expires (2027-01-01) only B is in force → 600
      const onlyB = await at('2027-01-01');
      expect(onlyB.statusCode).toBe(200);
      expect((onlyB.json() as Resolution).rateBps).toBe(600);
    });

    it('4. adjacent NON-overlapping ranges resolve deterministically at the civil-date boundary', async () => {
      await addRate('2026-01-01', '2026-06-30', 500); // old
      await addRate('2026-07-01', null, 1500); // new
      const oldDay = await at('2026-06-30');
      expect(oldDay.statusCode).toBe(200);
      expect((oldDay.json() as Resolution).rateBps).toBe(500);
      const newDay = await at('2026-07-01');
      expect(newDay.statusCode).toBe(200);
      expect((newDay.json() as Resolution).rateBps).toBe(1500);
    });

    it('5. exactly one applicable row → success', async () => {
      await addRate('2026-01-01', null, 700);
      const r = await at('2026-09-09');
      expect(r.statusCode).toBe(200);
      expect(r.json() as Resolution).toMatchObject({
        rateBps: 700,
        reason: null,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      });
    });

    it('6. no applicable row → 200 NO_RATE_FOR_CATEGORY', async () => {
      await addRate('2030-01-01', null, 800); // future-dated only
      const r = await at('2026-01-01');
      expect(r.statusCode).toBe(200);
      expect(r.json() as Resolution).toMatchObject({
        rateBps: null,
        reason: 'NO_RATE_FOR_CATEGORY',
      });
    });
  });

  // ════════════ CHECK 2 — DATE-ONLY civil-date contract (no timezone) ═══════
  // Owner freeze: FISCAL RESOLUTION DATE = a YYYY-MM-DD civil calendar date.
  // Not an instant, not UTC-normalized, not company/branch/POS-timezone-derived.
  // The only public input is a REQUIRED `?date=YYYY-MM-DD`. A timezone-bearing
  // timestamp is NOT an equivalent input — it is a 400. There is no UAE/KSA/UTC
  // ±1-day conversion path at all. The SQL predicate stays pure DATE vs DATE
  // (effectiveFrom <= $date::date AND effectiveTo >= $date::date) for tax_rate
  // AND country_tax_config.
  describe('civil-date contract — DATE only, no timezone', () => {
    let coTX = ''; // VAT throughout — rate-transition boundary
    let variantTX = '';
    let coTY = ''; // NONE → VAT at 2026-07-01 — CountryTaxConfig boundary
    let variantTY = '';
    const CAT = 'CHK2_STD';

    beforeAll(async () => {
      await sql(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
           ('XTX', 2, 'XTX', 'x', 'x'), ('XTY', 2, 'XTY', 'x', 'x')
         ON CONFLICT (code) DO NOTHING`,
      );
      await sql(
        `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel",active,"updatedAt") VALUES
           ('TX','TZ-rate','x','gcc','XTX','SAT_SUN',true,now()),
           ('TY','TZ-regime','x','gcc','XTY','SAT_SUN',true,now())
         ON CONFLICT (code) DO NOTHING`,
      );
      await sql(
        `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ($1,'x','x') ON CONFLICT (key) DO NOTHING`,
        [CAT],
      );
      // TX: VAT throughout; rate transition OLD 2026-01-01..2026-06-30 = 500,
      // NEW 2026-07-01..NULL = 1500.
      await sql(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo","regime")
         VALUES ('TX','2000-01-01',NULL,'VAT')`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom","effectiveTo") VALUES
           ('TX',$1,500,'2026-01-01','2026-06-30'),
           ('TX',$1,1500,'2026-07-01',NULL)`,
        [CAT],
      );
      // TY: CountryTaxConfig civil-date-effective — NONE ..2026-06-30, VAT 2026-07-01..
      await sql(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo","regime") VALUES
           ('TY','2000-01-01','2026-06-30','NONE'),
           ('TY','2026-07-01',NULL,'VAT')`,
      );
      await sql(
        `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom","effectiveTo")
         VALUES ('TY',$1,1500,'2026-07-01',NULL)`,
        [CAT],
      );

      coTX = await mkCompany(tenantA, 'TX Co', 'TX', 'XTX');
      const vx = await mkVariant(ownerA, 'chk2x');
      variantTX = vx.variantId;
      await setProductTax(vx.productId, CAT, `"${vx.productVersion}"`);

      coTY = await mkCompany(tenantA, 'TY Co', 'TY', 'XTY');
      const vy = await mkVariant(ownerA, 'chk2y');
      variantTY = vy.variantId;
      await setProductTax(vy.productId, CAT, `"${vy.productVersion}"`);
    });

    // a `query` object → light-my-request encodes each value, so a raw `+HH:MM`
    // or `:` in the value survives verbatim to the controller for the 400 proofs.
    const raw = (companyId: string, variantId: string, date: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/catalog/companies/${companyId}/variants/${variantId}/tax`,
        query: { date },
        headers: { authorization: `Bearer ${ownerA}` },
      });
    const onTX = (d: string) => raw(coTX, variantTX, d);
    const onTY = (d: string) => raw(coTY, variantTY, d);

    // ── TaxRate boundary — effectiveTo is inclusive ──────────────────────────
    it('date=2026-06-29 → OLD rate 500', async () => {
      const r = await onTX('2026-06-29');
      expect(r.statusCode, r.payload).toBe(200);
      expect(r.json() as Resolution).toMatchObject({
        rateBps: 500,
        regime: 'VAT',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-06-30',
        resolvedDate: '2026-06-29',
      });
    });

    it('date=2026-06-30 → OLD rate 500 (effectiveTo inclusive)', async () => {
      expect(((await onTX('2026-06-30')).json() as Resolution).rateBps).toBe(500);
    });

    it('date=2026-07-01 → NEW rate 1500', async () => {
      const r = await onTX('2026-07-01');
      expect(r.statusCode).toBe(200);
      expect(r.json() as Resolution).toMatchObject({
        rateBps: 1500,
        effectiveFrom: '2026-07-01',
        effectiveTo: null,
        resolvedDate: '2026-07-01',
      });
    });

    it('date=2026-07-02 → NEW rate 1500', async () => {
      expect(((await onTX('2026-07-02')).json() as Resolution).rateBps).toBe(1500);
    });

    // ── CountryTaxConfig boundary — same pure-DATE semantics ─────────────────
    it('CountryTaxConfig: date=2026-06-29 / 2026-06-30 → REGIME_NONE', async () => {
      for (const d of ['2026-06-29', '2026-06-30']) {
        const r = await onTY(d);
        expect(r.statusCode, `${d}: ${r.payload}`).toBe(200);
        expect(r.json() as Resolution, d).toMatchObject({
          regime: 'NONE',
          rateBps: null,
          reason: 'REGIME_NONE',
        });
      }
    });

    it('CountryTaxConfig: date=2026-07-01 / 2026-07-02 → VAT + 1500', async () => {
      for (const d of ['2026-07-01', '2026-07-02']) {
        const r = await onTY(d);
        expect(r.statusCode, `${d}: ${r.payload}`).toBe(200);
        expect(r.json() as Resolution, d).toMatchObject({ regime: 'VAT', rateBps: 1500 });
      }
    });

    // ── timezone regression — a timestamp is NOT an accepted equivalent ──────
    it('timezone-bearing / ISO-instant inputs are rejected 400 — no ±1-day conversion path', async () => {
      for (const bad of [
        '2026-07-01T00:30:00+04:00', // UAE offset
        '2026-07-01T00:30:00+03:00', // KSA offset
        '2026-06-30T20:30:00Z', // UTC instant
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00',
        '2026-07-01 00:00:00',
      ]) {
        const r = await onTX(bad);
        expect(r.statusCode, `${bad} should be 400`).toBe(400);
        expect(errCode(r), bad).toBe('INVALID_DATE');
      }
      // the canonical civil date resolves to the NEW rate
      expect(((await onTX('2026-07-01')).json() as Resolution).rateBps).toBe(1500);
    });

    it('malformed / impossible calendar dates are rejected 400', async () => {
      for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '07/01/2026', '2026-7-1', '']) {
        const r = await onTX(bad);
        expect(r.statusCode, `${bad} should be 400`).toBe(400);
      }
    });

    it('date is REQUIRED — omitting it is 400 VALIDATION_FAILED', async () => {
      const r = await app.inject({
        method: 'GET',
        url: `/v1/catalog/companies/${coTX}/variants/${variantTX}/tax`,
        headers: { authorization: `Bearer ${ownerA}` },
      });
      expect(r.statusCode).toBe(400);
      expect(errCode(r)).toBe('VALIDATION_FAILED');
    });

    it('the response carries resolvedDate (YYYY-MM-DD) and NO instant / timestamp field', async () => {
      const body = (await onTX('2026-07-01')).json() as Record<string, unknown>;
      expect(body['resolvedDate']).toBe('2026-07-01');
      expect(body).not.toHaveProperty('resolvedAt');
      // no ISO-8601 timestamp value anywhere in the response
      expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });
  });

  // ════════════ Task 3.11 — HG3-NO-BT-BRANCH dual-tenant proof (owner §28) ══
  describe('generic multi-business — Business Type does not alter tax resolution', () => {
    let tenantBT = '';
    let coBT = '';
    let ownerBT = '';

    beforeAll(async () => {
      // a SECOND, genuinely different, real preset — mirrors the pattern
      // already used in catalog-core/-attributes/-variants/-identifiers/-uom.
      // No capability gates tax resolution, so no setCap() parity is needed —
      // the point is purely that businessTypeKey never enters the fiscal path
      // (company.countryCode is the sole authority, CLAUDE.md §9 / owner
      // Correction 4).
      await sql(`INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
                 VALUES ('BAKERY_CAKE', 2, 'Bakery', 'x', 'ACTIVE', now())
                 ON CONFLICT (key) DO NOTHING`);
      await sql(`INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
                 VALUES ('BAKERY_CAKE','strategy.stocked',true,now()),
                        ('BAKERY_CAKE','variants',true,now())
                 ON CONFLICT ("templateKey","capabilityKey") DO NOTHING`);
      const res = await req(
        'POST',
        '/platform/tenants',
        superTok,
        {
          slug: 'tax-bt',
          name: 'tax-bt',
          region: 'AE',
          companyCountryCode: 'AE',
          businessTypeKey: 'BAKERY_CAKE',
          planVersionId: PLAN_V,
          ownerEmail: 'owner@tax-bt.test',
        },
        { 'idempotency-key': 'prov-tax-bt' },
      );
      expect(res.statusCode, res.payload).toBe(201);
      tenantBT = (res.json() as { tenantId: string }).tenantId;
      ownerBT = await mintTenant('obt', tenantBT, CATALOG);
      coBT = (
        await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantBT])
      )[0]!.id;
    });

    it('two tenants, different businessTypeKey, identical product tax-category + date -> identical resolution', async () => {
      const btA = (
        await sql<{ k: string }>(`SELECT "businessTypeKey" AS k FROM tenant WHERE id=$1`, [tenantA])
      )[0]!.k;
      const btBT = (
        await sql<{ k: string }>(`SELECT "businessTypeKey" AS k FROM tenant WHERE id=$1`, [
          tenantBT,
        ])
      )[0]!.k;
      expect(btA).not.toBe(btBT);

      const {
        productId: pA,
        variantId: vA,
        productVersion: pvA,
      } = await mkVariant(ownerA, 'bt-neutral-tax-a');
      const {
        productId: pBT,
        variantId: vBT,
        productVersion: pvBT,
      } = await mkVariant(ownerBT, 'bt-neutral-tax-bt');
      await setProductTax(pA, 'STANDARD', `"${pvA}"`, ownerA);
      await setProductTax(pBT, 'STANDARD', `"${pvBT}"`, ownerBT);

      const rA = await resolveTax(coAE, vA, '?date=2026-01-15', ownerA);
      const rBT = await resolveTax(coBT, vBT, '?date=2026-01-15', ownerBT);
      expect(rA.statusCode, rA.payload).toBe(200);
      expect(rBT.statusCode, rBT.payload).toBe(rA.statusCode);
      // identical rateBps/source/reason/categorySource/resolvedDate/regime —
      // business type never enters the fiscal path. `companyId`/`variantId`
      // are per-request identifiers and are excluded from the comparison.
      const { companyId: _cA, variantId: _vA, ...domainA } = rA.json() as Record<string, unknown>;
      const {
        companyId: _cBT,
        variantId: _vBT,
        ...domainBT
      } = rBT.json() as Record<string, unknown>;
      expect(domainBT).toEqual(domainA);
    });
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000390000', 'starter-tax', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000390000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 10);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin-tax@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('variants:manage','TENANT','catalog','v',3),
             ('settings:tenant:manage','TENANT','admin','v',1),
             ('users:view','TENANT','admin','v',1),('platform:tenants:view','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'x', 'x'), ('SAR', 2, 'SAR', 'x', 'x'), ('QAR', 2, 'QAR', 'x', 'x')
      ON CONFLICT (code) DO NOTHING;
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()),
             ('SA', 'KSA', 'x', 'gcc', 'SAR', 'FRI_SAT', true, now()),
             ('QA', 'Qatar', 'x', 'gcc', 'QAR', 'FRI_SAT', true, now())
      ON CONFLICT (code) DO NOTHING;
      -- tax categories (the 3 seeded platform keys + a REDUCED key with NO AE rate,
      -- used to prove NO_RATE_FOR_CATEGORY)
      INSERT INTO tax_category (key, "nameEn", "nameAr", description) VALUES
        ('STANDARD','Standard','x','x'), ('ZERO_RATED','Zero-rated','x','x'),
        ('EXEMPT','Exempt','x','x'), ('REDUCED','Reduced','x','x')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo","regime") VALUES
        ('AE','2018-01-01',NULL,'VAT'),
        ('SA','2018-01-01',NULL,'VAT'),
        ('QA','2016-06-01',NULL,'NONE');
      INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom","effectiveTo") VALUES
        ('AE','STANDARD',500,'2018-01-01',NULL),
        ('AE','ZERO_RATED',0,'2018-01-01',NULL),
        ('AE','EXEMPT',0,'2018-01-01',NULL),
        ('SA','STANDARD',500,'2018-01-01','2020-06-30'),
        ('SA','STANDARD',1500,'2020-07-01',NULL),
        ('SA','ZERO_RATED',0,'2018-01-01',NULL);
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now())
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()), ('CUSTOM','strategy.custom',true,now()),
             ('CUSTOM','variants',true,now())
      ON CONFLICT ("templateKey","capabilityKey") DO NOTHING;
    `);
  } finally {
    await c.end();
  }
}
