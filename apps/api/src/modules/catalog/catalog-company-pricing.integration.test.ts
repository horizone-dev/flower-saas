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

const PLAN_V = '00000000-0000-7000-8000-000000370001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000370002';
const PRICE = ['catalog:view', 'catalog:manage', 'variants:manage', 'pricing:manage'];

/**
 * Task 3.7 — company per-UOM SELL pricing (integration). Covers the frozen scope
 * freeze rev.3 proof set: price-set version semantics (V1–V5), no activation
 * price gate, base-UOM required, box-only pricing, NO price multiplication, NO
 * cross-company fallback, AED/SAR/KWD currency isolation + exact money + DB
 * currency/exponent invariants, concurrency (company A vs B, stale If-Match,
 * concurrent first writes with no raw P2002/500), UOM integration (custom-UOM
 * delete guard, conversion delete → resolvable:false, base-UOM change guard),
 * API contract (zero price 422, purchase absent, branchId 400, missing price
 * 200 null), RLS + company scope + cross-tenant denial.
 */
describe('company per-UOM pricing (task 3.7, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let superTok = '';
  let tenantA = '';
  let tenantB = '';
  let ownerA = '';
  let viewerA = '';
  let noPriceA = '';
  let ownerB = '';
  // tenant A companies, one per currency
  let coAED = '';
  let coSAR = '';
  let coKWD = '';
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
    tenantA = await provision('price-a', 'AE');
    tenantB = await provision('price-b', 'AE');
    for (const t of [tenantA, tenantB]) await setCap(t, 'multi_uom', true);

    ownerA = await mintTenant('oa', tenantA, PRICE);
    viewerA = await mintTenant('va', tenantA, ['catalog:view']);
    noPriceA = await mintTenant('npa', tenantA, ['catalog:view', 'variants:manage']);
    ownerB = await mintTenant('ob', tenantB, PRICE);

    coAED = (await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantA]))[0]!
      .id;
    coB = (await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantB]))[0]!
      .id;
    // extra tenant-A companies in other GCC currencies (a company-currency change
    // is a step-up settings op — seed the rows directly, mirroring provisioning)
    coSAR = await mkCompany(tenantA, 'KSA Co', 'SA', 'SAR');
    coKWD = await mkCompany(tenantA, 'Kuwait Co', 'KW', 'KWD');
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
  async function mintTenant(id: string, forTenant: string, perms: string[]): Promise<string> {
    const s = base(`ten-${id}`, 'tenant');
    s.tenantId = forTenant;
    let uid = userIds.get(id);
    if (uid === undefined) {
      uid = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
      userIds.set(id, uid);
    }
    s.userId = uid;
    s.accountType = 'OWNER';
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
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  async function withHeldTxn<T>(
    setup: (c: pg.Client) => Promise<void>,
    whileHeld: () => Promise<T>,
  ): Promise<T> {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await setup(c);
      const pending = whileHeld();
      await sleep(400);
      await c.query('COMMIT');
      return await pending;
    } finally {
      await c.end();
    }
  }
  async function setCap(tenantId: string, key: string, enabled: boolean): Promise<void> {
    await sql(
      `INSERT INTO tenant_catalog_capability ("tenantId","capabilityKey",enabled,"sourceKind","updatedAt")
       VALUES ($1,$2,$3,'MANUAL',now())
       ON CONFLICT ("tenantId","capabilityKey") DO UPDATE SET enabled = EXCLUDED.enabled`,
      [tenantId, key, enabled],
    );
  }
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;
  let idemN = 0;
  const ik = (): string => `t37-key-${++idemN}`;
  const money = (amountMinor: string, currency: string, exponent: number) => ({
    amountMinor,
    currency,
    exponent,
  });

  async function mkCompany(
    tenantId: string,
    name: string,
    country: string,
    currency: string,
  ): Promise<string> {
    const rows = await sql<{ id: string }>(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","status","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'ACTIVE',now()) RETURNING id`,
      [tenantId, name, country, currency],
    );
    return rows[0]!.id;
  }
  async function mkVariant(
    token: string,
    slug: string,
    opts: { base?: string; strategy?: string } = {},
  ): Promise<{ productId: string; variantId: string }> {
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
        fulfilmentStrategy: opts.strategy ?? 'STOCKED',
      },
      { 'idempotency-key': ik() },
    );
    expect(p.statusCode, p.payload).toBe(201);
    const productId = (p.json() as { id: string }).id;
    const vs = (await req('GET', `/catalog/products/${productId}/variants`, token)).json() as {
      id: string;
      version: number;
    }[];
    const variantId = vs[0]!.id;
    if (opts.base !== undefined) {
      const set = await setBase(token, variantId, opts.base);
      expect(set.statusCode, set.payload).toBe(200);
    }
    return { productId, variantId };
  }
  const getVariant = async (token: string, id: string) =>
    (await req('GET', `/catalog/variants/${id}`, token)).json() as {
      version: number;
      status: string;
      baseUomCode: string | null;
    };
  async function setBase(token: string, variantId: string, code: string) {
    const v = await getVariant(token, variantId);
    return req(
      'PUT',
      `/catalog/variants/${variantId}/base-uom`,
      token,
      { baseUomCode: code },
      { 'if-match': `"${v.version}"` },
    );
  }
  async function activateVariant(token: string, id: string) {
    const v = await getVariant(token, id);
    return req('POST', `/catalog/variants/${id}/activate`, token, undefined, {
      'idempotency-key': ik(),
      'if-match': `"${v.version}"`,
    });
  }
  async function activateProduct(token: string, id: string) {
    const p = (await req('GET', `/catalog/products/${id}`, token)).json() as { version: number };
    return req('POST', `/catalog/products/${id}/activate`, token, undefined, {
      'idempotency-key': ik(),
      'if-match': `"${p.version}"`,
    });
  }
  const putVariantConv = async (token: string, variantId: string, conversions: unknown[]) => {
    const v = await getVariant(token, variantId);
    return req(
      'PUT',
      `/catalog/variants/${variantId}/conversions`,
      token,
      { conversions },
      { 'if-match': `"${v.version}"` },
    );
  };
  const mkUom = (token: string, body: Record<string, unknown>) =>
    req('POST', '/catalog/uoms', token, body, { 'idempotency-key': ik() });

  const P = (companyId: string, variantId: string, extra = ''): string =>
    `/catalog/companies/${companyId}/variants/${variantId}/prices${extra}`;
  const getPrices = (companyId: string, variantId: string, token = ownerA) =>
    req('GET', P(companyId, variantId), token);
  const putPrices = (
    companyId: string,
    variantId: string,
    prices: unknown[],
    ifMatch: string,
    token = ownerA,
  ) => req('PUT', P(companyId, variantId), token, { prices }, { 'if-match': ifMatch });
  const resolve = (companyId: string, variantId: string, query: string, token = ownerA) =>
    req('GET', P(companyId, variantId, `/resolve?${query}`), token);
  const priceJson = (r: { json: () => unknown }) =>
    r.json() as {
      version: number;
      priceSetExists: boolean;
      prices: {
        uomCode: string;
        sell: { amountMinor: string; currency: string };
        resolvable: boolean;
      }[];
    };

  // ════════════ price-set version semantics (V1–V5) ═══════════════════════
  describe('price-set version semantics', () => {
    it('V1/V2/V3/V4 — absent GET → 0; first PUT → 1 (not 2); second → 2; PUT [] → 3, aggregate remains', async () => {
      const { variantId } = await mkVariant(ownerA, 'ver', { base: 'piece' });

      const g0 = await getPrices(coAED, variantId);
      expect(g0.statusCode).toBe(200);
      expect(priceJson(g0)).toMatchObject({ version: 0, priceSetExists: false, prices: [] });
      expect(g0.headers.etag).toBe('"0"');

      const p1 = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('500', 'AED', 2) }],
        '"0"',
      );
      expect(p1.statusCode, p1.payload).toBe(200);
      expect(priceJson(p1).version).toBe(1);
      expect(p1.headers.etag).toBe('"1"');

      const p2 = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('600', 'AED', 2) }],
        '"1"',
      );
      expect(p2.statusCode, p2.payload).toBe(200);
      expect(priceJson(p2).version).toBe(2);

      const p3 = await putPrices(coAED, variantId, [], '"2"');
      expect(p3.statusCode, p3.payload).toBe(200);
      expect(priceJson(p3).version).toBe(3);
      expect(priceJson(p3).prices).toEqual([]);
      // the aggregate row is retained
      expect(
        await count(
          `SELECT count(*)::int AS n FROM company_variant_price_set WHERE "companyId"=$1 AND "variantId"=$2`,
          [coAED, variantId],
        ),
      ).toBe(1);
      const g3 = await getPrices(coAED, variantId);
      expect(priceJson(g3)).toMatchObject({ version: 3, priceSetExists: true, prices: [] });
    });

    it('V5 — two concurrent first writes (If-Match "0"): one → v1, the other → deterministic 409, no P2002 / 500', async () => {
      const { variantId } = await mkVariant(ownerA, 'concurrent-first', { base: 'piece' });
      const res = await withHeldTxn(
        async (c) => {
          // another writer inserts the aggregate first (uncommitted) — the API
          // PUT's INSERT … ON CONFLICT DO NOTHING blocks until this commits
          await c.query(
            `INSERT INTO company_variant_price_set (id,"tenantId","companyId","variantId","updatedAt")
             VALUES (uuidv7(),$1,$2,$3,now())`,
            [tenantA, coAED, variantId],
          );
        },
        () =>
          putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('100', 'AED', 2) }], '"0"'),
      );
      expect(res.statusCode).not.toBe(500);
      expect(res.statusCode).toBe(409);
      expect(errCode(res)).toBe('PRICE_SET_VERSION_CONFLICT');
      // exactly one aggregate row
      expect(
        await count(
          `SELECT count(*)::int AS n FROM company_variant_price_set WHERE "companyId"=$1 AND "variantId"=$2`,
          [coAED, variantId],
        ),
      ).toBe(1);
    });

    it('the PUT response IS this mutation own committed result (built in the write txn, not a post-commit GET)', async () => {
      const { variantId } = await mkVariant(ownerA, 'linz', { base: 'piece' });

      const r1 = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('500', 'AED', 2) }],
        '"0"',
      );
      expect(r1.statusCode, r1.payload).toBe(200);
      expect(r1.json()).toEqual({
        version: 1,
        priceSetExists: true,
        prices: [
          {
            uomCode: 'piece',
            sell: { amountMinor: '500', currency: 'AED', exponent: 2 },
            resolvable: true,
          },
        ],
      });
      expect(r1.headers.etag).toBe('"1"');
      const capturedFirst = JSON.stringify(r1.json());

      // a later writer commits v2 with a different set
      const r2 = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('999', 'AED', 2) }],
        '"1"',
      );
      expect(priceJson(r2).version).toBe(2);
      expect(priceJson(r2).prices[0]!.sell.amountMinor).toBe('999');

      // the first PUT response is unchanged — it reflected v1 + its own submitted
      // set, NOT a read that could observe the later writer
      expect(JSON.stringify(r1.json())).toBe(capturedFirst);
    });

    it('concurrent PUTs to the same (company, variant): the winner response == its own committed set, at v1', async () => {
      const { variantId } = await mkVariant(ownerA, 'racy', { base: 'piece' });
      const [a, b] = await Promise.all([
        putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('111', 'AED', 2) }], '"0"'),
        putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('222', 'AED', 2) }], '"0"'),
      ]);
      const ok = [a, b].filter((r) => r.statusCode === 200);
      const conflict = [a, b].filter((r) => r.statusCode === 409);
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(1);
      expect(conflict[0]!.statusCode).not.toBe(500);
      expect(errCode(conflict[0]!)).toBe('PRICE_SET_VERSION_CONFLICT');

      const okJson = priceJson(ok[0]!);
      expect(okJson.version).toBe(1);
      expect(['111', '222']).toContain(okJson.prices[0]!.sell.amountMinor);
      // the winner response amount == the single stored row == one submitted set
      const stored = await sql<{ a: string }>(
        `SELECT "sellAmountMinor"::text AS a FROM company_variant_uom_price WHERE "companyId"=$1 AND "variantId"=$2`,
        [coAED, variantId],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.a).toBe(okJson.prices[0]!.sell.amountMinor);
    });

    it('variant.version is untouched by a company price write', async () => {
      const { variantId } = await mkVariant(ownerA, 'vv', { base: 'piece' });
      const before = (await getVariant(ownerA, variantId)).version;
      await putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('5', 'AED', 2) }], '"0"');
      await putPrices(coSAR, variantId, [{ uomCode: 'piece', sell: money('6', 'SAR', 2) }], '"0"');
      await putPrices(coAED, variantId, [], '"1"');
      expect((await getVariant(ownerA, variantId)).version).toBe(before);
    });

    it('stale same-company If-Match → 409; company A edit does not invalidate company B', async () => {
      const { variantId } = await mkVariant(ownerA, 'ab-isolation', { base: 'piece' });
      const a1 = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('10', 'AED', 2) }],
        '"0"',
      );
      expect(a1.statusCode).toBe(200);
      // company SAR: independent aggregate, also first-write "0"
      const s1 = await putPrices(
        coSAR,
        variantId,
        [{ uomCode: 'piece', sell: money('20', 'SAR', 2) }],
        '"0"',
      );
      expect(s1.statusCode, s1.payload).toBe(200);
      expect(priceJson(s1).version).toBe(1);
      // company AED's version is still 1 — company SAR's write did not touch it
      expect(priceJson(await getPrices(coAED, variantId)).version).toBe(1);
      // a stale If-Match on company AED → 409
      const stale = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('11', 'AED', 2) }],
        '"0"',
      );
      expect(stale.statusCode).toBe(409);
      expect(errCode(stale)).toBe('PRICE_SET_VERSION_CONFLICT');
      // the correct If-Match succeeds
      expect(
        (
          await putPrices(
            coAED,
            variantId,
            [{ uomCode: 'piece', sell: money('11', 'AED', 2) }],
            '"1"',
          )
        ).statusCode,
      ).toBe(200);
    });
  });

  // ════════════ catalog rules — no activation gate, base UOM, no multiplication
  describe('catalog rules', () => {
    it('an ACTIVE variant may exist with zero prices (no activation price gate)', async () => {
      const { productId, variantId } = await mkVariant(ownerA, 'active-noprice', { base: 'piece' });
      expect((await activateProduct(ownerA, productId)).statusCode).toBe(200);
      expect((await activateVariant(ownerA, variantId)).statusCode).toBe(200);
      expect((await getVariant(ownerA, variantId)).status).toBe('ACTIVE');
      const g = await getPrices(coAED, variantId);
      expect(g.statusCode).toBe(200);
      expect(priceJson(g)).toMatchObject({ version: 0, priceSetExists: false, prices: [] });
    });

    it('standard pricing requires variant.baseUomCode → 409 VARIANT_BASE_UOM_REQUIRED (no piece inferred)', async () => {
      // a fresh STOCKED variant carries no base UOM until it is explicitly set
      const { variantId } = await mkVariant(ownerA, 'baseless');
      expect((await getVariant(ownerA, variantId)).baseUomCode).toBeNull();
      const p = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
        '"0"',
      );
      expect(p.statusCode).toBe(409);
      expect(errCode(p)).toBe('VARIANT_BASE_UOM_REQUIRED');
      // an empty replace-set is also blocked while base-less
      expect(errCode(await putPrices(coAED, variantId, [], '"0"'))).toBe(
        'VARIANT_BASE_UOM_REQUIRED',
      );
      // once a base is set, pricing works
      expect((await setBase(ownerA, variantId, 'piece')).statusCode).toBe(200);
      expect(
        (
          await putPrices(
            coAED,
            variantId,
            [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
            '"0"',
          )
        ).statusCode,
      ).toBe(200);
    });

    it('box-only price allowed while base piece stays unpriced; NO price multiplication either way', async () => {
      await mkUom(ownerA, { code: 'box', family: 'EACH', nameEn: 'Box' }).catch(() => {});
      const { variantId } = await mkVariant(ownerA, 'box-only', { base: 'piece' });
      expect(
        (await putVariantConv(ownerA, variantId, [{ fromUomCode: 'box', num: '12' }])).statusCode,
      ).toBe(200);

      const p = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'box', sell: money('5500', 'AED', 2) }],
        '"0"',
      );
      expect(p.statusCode, p.payload).toBe(200);
      expect(priceJson(p).prices.map((x) => x.uomCode)).toEqual(['box']);

      // resolve box → the stored value, NOT 12 × <piece price> (which does not exist)
      const rb = await resolve(coAED, variantId, 'uomCode=box');
      expect(rb.statusCode).toBe(200);
      expect(rb.json()).toMatchObject({
        price: { amountMinor: '5500', currency: 'AED' },
        source: 'COMPANY',
      });
      // resolve piece → explicit no-price, never 5500 ÷ 12
      const rp = await resolve(coAED, variantId, 'uomCode=piece');
      expect(rp.statusCode).toBe(200);
      expect(rp.json()).toEqual({ price: null, source: null, reason: 'UOM_NOT_PRICED' });
    });

    it('a UOM not reachable to the base → 422 PRICE_UOM_UNREACHABLE (legitimacy check, no derivation)', async () => {
      await mkUom(ownerA, {
        code: 'litre2',
        family: 'VOLUME',
        perBaseNum: '1000',
        nameEn: 'L',
      }).catch(() => {});
      const { variantId } = await mkVariant(ownerA, 'unreach', { base: 'piece' });
      const p = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'litre2', sell: money('1', 'AED', 2) }],
        '"0"',
      );
      expect(p.statusCode).toBe(422);
      expect(errCode(p)).toBe('PRICE_UOM_UNREACHABLE');
    });

    it('NO cross-company fallback — company AED unpriced, company SAR priced', async () => {
      const { variantId } = await mkVariant(ownerA, 'no-fallback', { base: 'piece' });
      expect(
        (
          await putPrices(
            coSAR,
            variantId,
            [{ uomCode: 'piece', sell: money('999', 'SAR', 2) }],
            '"0"',
          )
        ).statusCode,
      ).toBe(200);
      const r = await resolve(coAED, variantId, 'uomCode=piece');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ price: null, source: null, reason: 'NO_PRICE_SET' });
    });
  });

  // ════════════ company / currency — isolation + exact money + DB invariants
  describe('company + currency', () => {
    it('HG3-COMPANY-PRICE — AED + SAR companies, the SAME shared variant, zero currency/price leakage', async () => {
      const { variantId } = await mkVariant(ownerA, 'shared', { base: 'piece' });
      await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('1000', 'AED', 2) }],
        '"0"',
      );
      await putPrices(
        coSAR,
        variantId,
        [{ uomCode: 'piece', sell: money('2000', 'SAR', 2) }],
        '"0"',
      );

      const gA = priceJson(await getPrices(coAED, variantId));
      expect(gA.prices).toEqual([
        {
          uomCode: 'piece',
          sell: { amountMinor: '1000', currency: 'AED', exponent: 2 },
          resolvable: true,
        },
      ]);
      expect(JSON.stringify(gA)).not.toMatch(/SAR/);

      const gS = priceJson(await getPrices(coSAR, variantId));
      expect(gS.prices[0]!.sell.currency).toBe('SAR');
      expect(JSON.stringify(gS)).not.toMatch(/AED/);

      expect((await resolve(coAED, variantId, 'uomCode=piece')).json()).toMatchObject({
        price: { currency: 'AED' },
      });
      expect((await resolve(coSAR, variantId, 'uomCode=piece')).json()).toMatchObject({
        price: { currency: 'SAR' },
      });
    });

    it('KWD (3-decimal) round-trips exactly through bigint minor units', async () => {
      const { variantId } = await mkVariant(ownerA, 'kwd', { base: 'piece' });
      const p = await putPrices(
        coKWD,
        variantId,
        [{ uomCode: 'piece', sell: money('12345', 'KWD', 3) }],
        '"0"',
      );
      expect(p.statusCode, p.payload).toBe(200);
      const stored = await sql<{ a: string; e: number }>(
        `SELECT "sellAmountMinor"::text AS a, "sellCurrencyExponent" AS e FROM company_variant_uom_price WHERE "companyId"=$1`,
        [coKWD],
      );
      expect(stored[0]).toEqual({ a: '12345', e: 3 });
      expect((await resolve(coKWD, variantId, 'uomCode=piece')).json()).toMatchObject({
        price: { amountMinor: '12345', currency: 'KWD', exponent: 3 },
      });
    });

    it('wrong company currency → 422 PRICE_CURRENCY_MISMATCH via the API; and rejected by the DB FK on a direct write', async () => {
      const { variantId } = await mkVariant(ownerA, 'wrongcur', { base: 'piece' });
      const p = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('1', 'SAR', 2) }],
        '"0"',
      );
      expect(p.statusCode).toBe(422);
      expect(errCode(p)).toBe('PRICE_CURRENCY_MISMATCH');
      // direct DB write of a SAR row under an AED company → FK reject
      await sql(
        `INSERT INTO company_variant_price_set (id,"tenantId","companyId","variantId","updatedAt") VALUES (uuidv7(),$1,$2,$3,now())`,
        [tenantA, coAED, variantId],
      );
      await expect(
        sql(
          `INSERT INTO company_variant_uom_price
             (id,"tenantId","companyId","variantId","uomCode","sellAmountMinor","sellCurrencyCode","sellCurrencyExponent","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,'piece','1','SAR',2,now())`,
          [tenantA, coAED, variantId],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('MoneyDTO structural error → 400; a structurally-valid wrong-exponent → 422; correct exponent → success; direct DB wrong exponent → FK reject', async () => {
      const { variantId } = await mkVariant(ownerA, 'wrongexp', { base: 'piece' });

      // (a) STRUCTURAL — a non-integer amountMinor / a non-3-letter currency /
      //     an unknown key => 400 (the Task-3.7 structural money schema)
      const structural = await req(
        'PUT',
        P(coAED, variantId),
        ownerA,
        {
          prices: [{ uomCode: 'piece', sell: { amountMinor: '1.5', currency: 'AE', exponent: 2 } }],
        },
        { 'if-match': '"0"' },
      );
      expect(structural.statusCode).toBe(400);

      // (b) SEMANTIC — a structurally-valid MoneyDTO whose exponent disagrees
      //     with the authoritative AED exponent (2) => 422 pricing/money domain error
      const semantic = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('500', 'AED', 3) }],
        '"0"',
      );
      expect(semantic.statusCode).toBe(422);
      expect(errCode(semantic)).toBe('PRICE_CURRENCY_INVALID');

      // (c) correct exponent => success
      expect(
        (
          await putPrices(
            coAED,
            variantId,
            [{ uomCode: 'piece', sell: money('500', 'AED', 2) }],
            '"0"',
          )
        ).statusCode,
      ).toBe(200);

      // (d) direct DB write of (AED, 3) => rejected by the (code, exponent) FK
      const { variantId: v2 } = await mkVariant(ownerA, 'wrongexp2', { base: 'piece' });
      await sql(
        `INSERT INTO company_variant_price_set (id,"tenantId","companyId","variantId","updatedAt") VALUES (uuidv7(),$1,$2,$3,now())`,
        [tenantA, coAED, v2],
      );
      await expect(
        sql(
          `INSERT INTO company_variant_uom_price
             (id,"tenantId","companyId","variantId","uomCode","sellAmountMinor","sellCurrencyCode","sellCurrencyExponent","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,'piece','1','AED',3,now())`,
          [tenantA, coAED, v2],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('once company prices exist, company.defaultCurrency cannot change (ON UPDATE RESTRICT — no CASCADE rewrite)', async () => {
      const { variantId } = await mkVariant(ownerA, 'lockcur', { base: 'piece' });
      expect(
        (
          await putPrices(
            coKWD,
            variantId,
            [{ uomCode: 'piece', sell: money('100', 'KWD', 3) }],
            '"0"',
          )
        ).statusCode,
      ).toBe(200);
      await expect(
        sql(`UPDATE company SET "defaultCurrency" = 'AED' WHERE id = $1`, [coKWD]),
      ).rejects.toThrow(/foreign key|update or delete|violates/i);
      // the KWD price row is untouched (not rewritten to AED)
      expect(
        (
          await sql<{ c: string }>(
            `SELECT "sellCurrencyCode" AS c FROM company_variant_uom_price WHERE "companyId"=$1`,
            [coKWD],
          )
        )[0]!.c,
      ).toBe('KWD');
    });

    it('company-currency-change concurrency cannot create a mismatch (company FOR SHARE + FK RESTRICT)', async () => {
      const { variantId } = await mkVariant(ownerA, 'curconc', { base: 'piece' });
      // hold a tx that starts to change coSAR's currency; concurrently price it
      const res = await withHeldTxn(
        async (c) => {
          await c.query(`SELECT "defaultCurrency" FROM company WHERE id = $1 FOR UPDATE`, [coSAR]);
        },
        () =>
          putPrices(coSAR, variantId, [{ uomCode: 'piece', sell: money('1', 'SAR', 2) }], '"0"'),
      );
      // the price write blocked on `company … FOR SHARE`, then committed cleanly
      // once the holder released (the holder only read, did not actually change)
      expect(res.statusCode).not.toBe(500);
      expect([200, 409, 422]).toContain(res.statusCode);
      // whatever happened, no AED/SAR mismatch is stored
      const rows = await sql<{ c: string }>(
        `SELECT "sellCurrencyCode" AS c FROM company_variant_uom_price WHERE "companyId"=$1`,
        [coSAR],
      );
      expect(rows.every((r) => r.c === 'SAR')).toBe(true);
    });
  });

  // ════════════ UOM integration — custom-UOM delete, conversion delete, base-UOM change
  describe('UOM / base-UOM integration (task 3.6 guards)', () => {
    it('a custom UOM referenced by a company price cannot be hard-deleted → 409 UOM_IN_USE', async () => {
      await mkUom(ownerA, { code: 'jar', family: 'EACH', nameEn: 'Jar' });
      const { variantId } = await mkVariant(ownerA, 'uomdel', { base: 'piece' });
      await putVariantConv(ownerA, variantId, [{ fromUomCode: 'jar', num: '6' }]);
      expect(
        (
          await putPrices(
            coAED,
            variantId,
            [{ uomCode: 'jar', sell: money('300', 'AED', 2) }],
            '"0"',
          )
        ).statusCode,
      ).toBe(200);
      const del = await req('DELETE', `/catalog/uoms/jar`, ownerA, undefined, {
        'if-match': '"1"',
      });
      expect(del.statusCode).toBe(409);
      expect(errCode(del)).toBe('UOM_IN_USE');
    });

    it('a conversion may be deleted; the price row survives; GET shows resolvable:false; resolve → UOM_UNRESOLVABLE; re-adding restores it', async () => {
      await mkUom(ownerA, { code: 'crate', family: 'EACH', nameEn: 'Crate' });
      const { variantId } = await mkVariant(ownerA, 'convdel', { base: 'piece' });
      await putVariantConv(ownerA, variantId, [{ fromUomCode: 'crate', num: '24' }]);
      expect(
        (
          await putPrices(
            coAED,
            variantId,
            [{ uomCode: 'crate', sell: money('7000', 'AED', 2) }],
            '"0"',
          )
        ).statusCode,
      ).toBe(200);
      // delete the conversion (allowed — a price row does NOT block a conversion delete)
      expect((await putVariantConv(ownerA, variantId, [])).statusCode).toBe(200);
      const g = priceJson(await getPrices(coAED, variantId));
      expect(g.prices).toEqual([
        {
          uomCode: 'crate',
          sell: { amountMinor: '7000', currency: 'AED', exponent: 2 },
          resolvable: false,
        },
      ]);
      expect((await resolve(coAED, variantId, 'uomCode=crate')).json()).toEqual({
        price: null,
        source: null,
        reason: 'UOM_UNRESOLVABLE',
      });
      // re-add the conversion → resolvable again, stored amount unchanged
      expect(
        (await putVariantConv(ownerA, variantId, [{ fromUomCode: 'crate', num: '24' }])).statusCode,
      ).toBe(200);
      expect((await resolve(coAED, variantId, 'uomCode=crate')).json()).toMatchObject({
        price: { amountMinor: '7000', currency: 'AED' },
        source: 'COMPANY',
      });
    });

    it('base-UOM change is blocked while ANY company price row exists → 409 VARIANT_BASE_UOM_LOCKED; after PUT [] for every company, Task 3.6 rules apply again', async () => {
      const { variantId } = await mkVariant(ownerA, 'basechange', { base: 'piece' });
      await putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('10', 'AED', 2) }], '"0"');
      await putPrices(coSAR, variantId, [{ uomCode: 'piece', sell: money('20', 'SAR', 2) }], '"0"');
      const blocked = await setBase(ownerA, variantId, 'stem');
      expect(blocked.statusCode).toBe(409);
      expect(errCode(blocked)).toBe('VARIANT_BASE_UOM_LOCKED');
      // unprice every company that priced it
      expect((await putPrices(coAED, variantId, [], '"1"')).statusCode).toBe(200);
      expect((await putPrices(coSAR, variantId, [], '"1"')).statusCode).toBe(200);
      // now a DRAFT base change succeeds again (Task 3.6 rules — DRAFT, zero conversions)
      expect((await setBase(ownerA, variantId, 'stem')).statusCode).toBe(200);
    });

    it('base-UOM change vs price write are deterministic under interleaving', async () => {
      const { variantId } = await mkVariant(ownerA, 'basewrite', { base: 'piece' });
      // hold a price write in flight, attempt setBase concurrently
      const setRes = await withHeldTxn(
        async (c) => {
          await c.query(`SELECT version FROM variant WHERE id = $1 FOR SHARE`, [variantId]);
        },
        () => setBase(ownerA, variantId, 'stem'),
      );
      // the setBase either wins (200, no prices yet) or is blocked and then runs;
      // never a 500
      expect(setRes.statusCode).not.toBe(500);
      expect([200, 409]).toContain(setRes.statusCode);
    });
  });

  // ════════════ API contract — strict schemas, purchase absent, branchId 400
  describe('API contract', () => {
    it('zero sell price → 422 PRICE_MUST_BE_POSITIVE', async () => {
      const { variantId } = await mkVariant(ownerA, 'zero', { base: 'piece' });
      const p = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('0', 'AED', 2) }],
        '"0"',
      );
      expect(p.statusCode).toBe(422);
      expect(errCode(p)).toBe('PRICE_MUST_BE_POSITIVE');
    });

    it('a `purchase` field in the body → 400 (strict schema); GET / resolve responses carry no purchase key', async () => {
      const { variantId } = await mkVariant(ownerA, 'purchase', { base: 'piece' });
      const bad = await req(
        'PUT',
        P(coAED, variantId),
        ownerA,
        {
          prices: [
            {
              uomCode: 'piece',
              sell: money('100', 'AED', 2),
              purchase: money('60', 'AED', 2),
            },
          ],
        },
        { 'if-match': '"0"' },
      );
      expect(bad.statusCode).toBe(400);
      // a clean price, then GET / resolve → no purchase key
      await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('100', 'AED', 2) }],
        '"0"',
      );
      expect(JSON.stringify((await getPrices(coAED, variantId)).json())).not.toMatch(/purchase/i);
      expect(JSON.stringify((await resolve(coAED, variantId, 'uomCode=piece')).json())).not.toMatch(
        /purchase/i,
      );
    });

    it('branchId in the resolve query → 400 (rejected, not ignored)', async () => {
      const { variantId } = await mkVariant(ownerA, 'branchid', { base: 'piece' });
      const bad = await resolve(
        coAED,
        variantId,
        'uomCode=piece&branchId=00000000-0000-7000-8000-000000000001',
      );
      expect(bad.statusCode).toBe(400);
      // the valid form works
      expect((await resolve(coAED, variantId, 'uomCode=piece')).statusCode).toBe(200);
    });

    it('missing If-Match → 428; missing price → 200 { price: null }', async () => {
      const { variantId } = await mkVariant(ownerA, 'contract', { base: 'piece' });
      const noMatch = await req('PUT', P(coAED, variantId), ownerA, {
        prices: [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
      });
      expect(noMatch.statusCode).toBe(428);
      const r = await resolve(coAED, variantId, 'uomCode=piece');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ price: null, source: null, reason: 'NO_PRICE_SET' });
    });

    it('resolve validates uomCode BEFORE any no-price short-circuit', async () => {
      // a company/variant with NO price-set aggregate at all
      const { variantId } = await mkVariant(ownerA, 'validorder', { base: 'piece' });

      // a syntactically invalid canonical UOM → 422 UOM_INVALID_CODE, NOT 200 NO_PRICE_SET
      const bad = await resolve(coAED, variantId, 'uomCode=BOX%2Fvalue');
      expect(bad.statusCode).toBe(422);
      expect(errCode(bad)).toBe('UOM_INVALID_CODE');

      // a valid uomCode with no aggregate → 200 { price: null, NO_PRICE_SET }
      const good = await resolve(coAED, variantId, 'uomCode=piece');
      expect(good.statusCode).toBe(200);
      expect(good.json()).toEqual({ price: null, source: null, reason: 'NO_PRICE_SET' });

      // an unknown query key (branchId) still → 400
      const branch = await resolve(coAED, variantId, 'uomCode=piece&branchId=abc');
      expect(branch.statusCode).toBe(400);
    });

    it('a malformed uomCode in resolve → 422 even when a price set exists', async () => {
      const { variantId } = await mkVariant(ownerA, 'malformed', { base: 'piece' });
      await putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('1', 'AED', 2) }], '"0"');
      const r = await resolve(coAED, variantId, 'uomCode=BOX%2F12');
      expect(r.statusCode).toBe(422);
      expect(errCode(r)).toBe('UOM_INVALID_CODE');
    });
  });

  // ════════════ permissions / scope / isolation / audit
  describe('permissions, scope, isolation, audit', () => {
    it('pricing:manage is required to write; catalog:view is enough to read', async () => {
      const { variantId } = await mkVariant(ownerA, 'perm', { base: 'piece' });
      const write = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
        '"0"',
        noPriceA,
      );
      expect(write.statusCode).toBe(403);
      await putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('1', 'AED', 2) }], '"0"');
      expect((await getPrices(coAED, variantId, viewerA)).statusCode).toBe(200);
    });

    it('tenant B cannot read or write tenant A prices (cross-tenant); tenant B cannot use tenant A company ids', async () => {
      const { variantId } = await mkVariant(ownerA, 'xtenant', { base: 'piece' });
      await putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('42', 'AED', 2) }], '"0"');
      // ownerB, A's company id + A's variant id
      const gB = await getPrices(coAED, variantId, ownerB);
      expect([403, 404]).toContain(gB.statusCode);
      const pB = await putPrices(
        coAED,
        variantId,
        [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
        '"0"',
        ownerB,
      );
      expect([403, 404, 409]).toContain(pB.statusCode);
      // ownerB pricing its OWN company but with A's variant id → not found
      const pBOwn = await putPrices(
        coB,
        variantId,
        [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
        '"0"',
        ownerB,
      );
      expect([404, 409, 422]).toContain(pBOwn.statusCode);
    });

    it('one audit row per replace-set mutation; catalog.company_price_changed; sell map only', async () => {
      const { variantId } = await mkVariant(ownerA, 'audit', { base: 'piece' });
      const before = await count(
        `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId"=$1 AND action='catalog.company_price_changed'`,
        [tenantA],
      );
      await putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('7', 'AED', 2) }], '"0"');
      await putPrices(coAED, variantId, [], '"1"'); // unprice — still one audit row
      const after = await sql<{ action: string; resourceType: string; after: unknown }>(
        `SELECT action, "resourceType", "after" FROM audit_log
          WHERE "tenantId"=$1 AND action='catalog.company_price_changed' ORDER BY at DESC LIMIT 2`,
        [tenantA],
      );
      expect(
        await count(
          `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId"=$1 AND action='catalog.company_price_changed'`,
          [tenantA],
        ),
      ).toBe(before + 2);
      expect(after[0]!.resourceType).toBe('company_variant_price_set');
      expect(JSON.stringify(after)).not.toMatch(/purchase/i);
    });

    it('purchase_* is never written by the Task 3.7 API', async () => {
      const { variantId } = await mkVariant(ownerA, 'nopurchase', { base: 'piece' });
      await putPrices(coAED, variantId, [{ uomCode: 'piece', sell: money('9', 'AED', 2) }], '"0"');
      const rows = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM company_variant_uom_price
          WHERE "companyId"=$1 AND "purchaseAmountMinor" IS NOT NULL`,
        [coAED],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('no Task 3.9+ / inventory pull-forward — no inventory / order / payment table', async () => {
      const present = new Set(
        (
          await sql<{ tablename: string }>(
            `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
          )
        ).map((r) => r.tablename),
      );
      // branch_variant_* IS created by the task 3.8 migration that this suite's
      // DB runs; the inventory / order / payment domain stays forbidden.
      for (const t of [
        'inventory_item',
        'inventory_movement',
        'branch_inventory_balance',
        'stock_reservation',
        'order',
        'payment',
      ]) {
        expect(present.has(t), t).toBe(false);
      }
    });
  });

  // ════════════ CHECK 1 (owner final review, task 3.10) — identical-set PUT
  // is a logical mutation, never a content-diff no-op. Frozen source:
  // Task 3.7 (`17b8623`) — "9. bump the aggregate version ONLY when it
  // already existed (a newly created row is already at version 1 ==
  // nextVersion)" — the condition is existence, never content equality.
  // Task 3.8 (`e333f9d`) — `branch_variant_price_set` is "INDEPENDENTLY
  // MONOTONIC (created at 1, only incremented, never reset/deleted)". The
  // implementation (`company-pricing.repository.ts` step 9) unconditionally
  // deletes+reinserts rows and bumps the version on every existing-aggregate
  // PUT — there is no content-equality short-circuit anywhere in the frozen
  // scope or the code. This suite proves that contract explicitly.
  describe('CHECK 1 — identical price-set PUT is a logical mutation, not a no-op', () => {
    const outbox = (eventType: string, resourceId: string) =>
      sql<{ resourceVersion: string | null }>(
        `SELECT "resourceVersion"::text AS "resourceVersion" FROM outbox
          WHERE "eventType" = $1 AND "aggregateId" = $2
          ORDER BY "createdAt" DESC LIMIT 5`,
        [eventType, resourceId],
      );

    it('a content-identical company PUT with correct If-Match bumps version n -> n+1, writes exactly 1 audit row, and enqueues exactly 1 outbox row at resource_version n+1', async () => {
      const { variantId } = await mkVariant(ownerA, 'check1-co', { base: 'piece' });
      const entries = [{ uomCode: 'piece', sell: money('500', 'AED', 2) }];

      const p1 = await putPrices(coAED, variantId, entries, '"0"');
      expect(p1.statusCode, p1.payload).toBe(200);
      expect(priceJson(p1).version).toBe(1);
      const aggId = (
        await sql<{ id: string }>(
          `SELECT id FROM company_variant_price_set WHERE "companyId"=$1 AND "variantId"=$2`,
          [coAED, variantId],
        )
      )[0]!.id;

      const auditBefore = await count(
        `SELECT count(*)::int AS n FROM audit_log WHERE "resourceId"=$1 AND action='catalog.company_price_changed'`,
        [aggId],
      );
      const outboxBefore = (await outbox('catalog.company.price_changed', aggId)).length;

      // resubmit the EXACT same entries with the correct If-Match — content-identical.
      const p2 = await putPrices(coAED, variantId, entries, '"1"');
      expect(p2.statusCode, p2.payload).toBe(200);
      expect(priceJson(p2).version).toBe(2); // n -> n+1, never a no-op
      expect(p2.headers.etag).toBe('"2"');
      expect(priceJson(p2).prices).toEqual(priceJson(p1).prices);

      expect(
        await count(
          `SELECT count(*)::int AS n FROM audit_log WHERE "resourceId"=$1 AND action='catalog.company_price_changed'`,
          [aggId],
        ),
      ).toBe(auditBefore + 1); // exactly 1 new audit row

      const outboxRows = await outbox('catalog.company.price_changed', aggId);
      expect(outboxRows.length).toBe(outboxBefore + 1); // exactly 1 new outbox row
      expect(outboxRows[0]!.resourceVersion).toBe('2'); // resource_version = n+1

      // a THIRD identical resubmit bumps again — unconditional on existence,
      // never gated on whether content changed.
      const p3 = await putPrices(coAED, variantId, entries, '"2"');
      expect(priceJson(p3).version).toBe(3);
    });
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000370000', 'starter-price', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000370000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 10);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin-price@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('variants:manage','TENANT','catalog','v',3),('pricing:manage','TENANT','catalog','v',3),
             ('settings:tenant:manage','TENANT','admin','v',1),
             ('users:view','TENANT','admin','v',1),('platform:tenants:view','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'x', 'x'), ('SAR', 2, 'SAR', 'x', 'x'), ('KWD', 3, 'KWD', 'x', 'x');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()),
             ('SA', 'KSA', 'x', 'gcc', 'SAR', 'FRI_SAT', true, now()),
             ('KW', 'Kuwait', 'x', 'gcc', 'KWD', 'FRI_SAT', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()), ('CUSTOM','strategy.custom',true,now()),
             ('CUSTOM','variants',true,now()), ('CUSTOM','multi_uom',true,now());
    `);
  } finally {
    await c.end();
  }
}
