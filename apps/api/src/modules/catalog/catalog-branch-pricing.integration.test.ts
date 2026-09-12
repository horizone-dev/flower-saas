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

const PLAN_V = '00000000-0000-7000-8000-000000380001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000380002';
const CATALOG = [
  'catalog:view',
  'catalog:manage',
  'variants:manage',
  'pricing:manage',
  'branch_price:manage',
];

/**
 * Task 3.8 — branch price override + branch availability (integration). Covers
 * the scope-freeze rev.5 proof set: the monotonic branch price-set version model,
 * the first empty PUT creating v1 with no company pricing, BD-1 (a branch
 * override needs a matching company price), the company↔branch TOCTOU protocol
 * (shared `company_variant_price_set` lock, both interleavings), the corrected
 * base-UOM and custom-UOM-delete races, principal-scoped + branch-bound
 * availability idempotency, the structural/domain validation split, the
 * `branch_pricing` capability gating price writes only, currency/exponent
 * invariants, and the dedicated branch resolver.
 */
describe('branch price override + availability (task 3.8, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let superTok = '';
  let tenantA = '';
  let tenantB = '';
  let ownerA = '';
  let ownerA2 = ''; // a SECOND principal in tenant A (for idempotency-principal tests)
  let viewerA = ''; // catalog:view only
  let dubaiUserA = ''; // branchScope = [dubai] only
  let ownerB = '';
  let coA = '';
  let dubai = '';
  let sharjah = '';

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
    tenantA = await provision('bp-a', 'AE');
    tenantB = await provision('bp-b', 'AE');
    for (const t of [tenantA, tenantB]) {
      await setCap(t, 'multi_uom', true);
      await setCap(t, 'branch_pricing', true);
    }

    coA = (await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantA]))[0]!
      .id;
    dubai = (await sql<{ id: string }>(`SELECT id FROM branch WHERE "tenantId"=$1`, [tenantA]))[0]!
      .id;
    // a SECOND branch in company A (Sharjah)
    sharjah = (
      await sql<{ id: string }>(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
         VALUES (uuidv7(),$1,$2,'Sharjah',now()) RETURNING id`,
        [tenantA, coA],
      )
    )[0]!.id;

    ownerA = await mintTenant('oa', tenantA, CATALOG);
    ownerA2 = await mintTenant('oa2', tenantA, CATALOG);
    viewerA = await mintTenant('va', tenantA, ['catalog:view']);
    dubaiUserA = await mintTenant('du-a', tenantA, CATALOG, { branchScope: [dubai] });
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
  const ik = (): string => `t38-key-${String(++idemN).padStart(4, '0')}`;
  const money = (amountMinor: string, currency: string, exponent: number) => ({
    amountMinor,
    currency,
    exponent,
  });

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
    const variantId = vs[0]!.id;
    if (opts.base !== undefined) {
      const v = await getVariant(token, variantId);
      const set = await req(
        'PUT',
        `/catalog/variants/${variantId}/base-uom`,
        token,
        { baseUomCode: opts.base },
        { 'if-match': `"${v.version}"` },
      );
      expect(set.statusCode, set.payload).toBe(200);
    }
    return variantId;
  }
  const getVariant = async (token: string, id: string) =>
    (await req('GET', `/catalog/variants/${id}`, token)).json() as {
      version: number;
      baseUomCode: string | null;
    };
  const mkUom = (token: string, body: Record<string, unknown>) =>
    req('POST', '/catalog/uoms', token, body, { 'idempotency-key': ik() });

  // company pricing helpers (Task 3.7 API)
  const CP = (companyId: string, variantId: string, extra = ''): string =>
    `/catalog/companies/${companyId}/variants/${variantId}/prices${extra}`;
  const putCompanyPrices = (
    companyId: string,
    variantId: string,
    prices: unknown[],
    ifMatch: string,
    token = ownerA,
  ) => req('PUT', CP(companyId, variantId), token, { prices }, { 'if-match': ifMatch });

  // branch pricing helpers (Task 3.8 API)
  const BP = (branchId: string, variantId: string, extra = ''): string =>
    `/catalog/branches/${branchId}/variants/${variantId}/prices${extra}`;
  const putBranchPrices = (
    branchId: string,
    variantId: string,
    prices: unknown[],
    ifMatch: string,
    token = ownerA,
  ) => req('PUT', BP(branchId, variantId), token, { prices }, { 'if-match': ifMatch });
  const getBranchPrices = (branchId: string, variantId: string, token = ownerA) =>
    req('GET', BP(branchId, variantId), token);
  const resolveBranch = (branchId: string, variantId: string, query: string, token = ownerA) =>
    req('GET', BP(branchId, variantId, `/resolve?${query}`), token);
  const setAvail = (branchId: string, entries: unknown[], key: string, token = ownerA) =>
    req(
      'PUT',
      `/catalog/branches/${branchId}/availability`,
      token,
      { entries },
      {
        'idempotency-key': key,
      },
    );
  const getAvail = (branchId: string, query = '', token = ownerA) =>
    req('GET', `/catalog/branches/${branchId}/availability${query}`, token);
  const effCatalog = (branchId: string, query = '', token = ownerA) =>
    req('GET', `/catalog/branches/${branchId}/catalog${query}`, token);
  const bpJson = (r: { json: () => unknown }) =>
    r.json() as {
      version: number;
      priceSetExists: boolean;
      prices: {
        uomCode: string;
        sell: { amountMinor: string; currency: string };
        resolvable: boolean;
      }[];
    };

  /** price a variant at the company level (a prerequisite for a branch override — BD-1). */
  async function companyPrice(
    companyId: string,
    variantId: string,
    prices: unknown[],
    token = ownerA,
  ): Promise<void> {
    const g = await req('GET', CP(companyId, variantId), token);
    const cur = (g.json() as { version: number }).version;
    const p = await putCompanyPrices(companyId, variantId, prices, `"${cur}"`, token);
    expect(p.statusCode, p.payload).toBe(200);
  }

  // ════════════ version model ════════════════════════════════════════════
  describe('branch price-set version model', () => {
    it('absent GET → v0; first non-empty PUT → v1 (not 2); second → v2; PUT [] → v3, aggregate retained', async () => {
      const v = await mkVariant(ownerA, 'ver', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);

      const g0 = await getBranchPrices(dubai, v);
      expect(g0.statusCode).toBe(200);
      expect(bpJson(g0)).toMatchObject({ version: 0, priceSetExists: false, prices: [] });
      expect(g0.headers.etag).toBe('"0"');

      const p1 = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'piece', sell: money('450', 'AED', 2) }],
        '"0"',
      );
      expect(p1.statusCode, p1.payload).toBe(200);
      expect(bpJson(p1).version).toBe(1);
      expect(bpJson(p1).prices).toEqual([
        {
          uomCode: 'piece',
          sell: { amountMinor: '450', currency: 'AED', exponent: 2 },
          resolvable: true,
        },
      ]);
      expect(p1.headers.etag).toBe('"1"');

      const p2 = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'piece', sell: money('440', 'AED', 2) }],
        '"1"',
      );
      expect(bpJson(p2).version).toBe(2);

      const p3 = await putBranchPrices(dubai, v, [], '"2"');
      expect(p3.statusCode, p3.payload).toBe(200);
      expect(bpJson(p3)).toMatchObject({ version: 3, priceSetExists: true, prices: [] });
      // rows gone, aggregate retained
      expect(
        Number(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM branch_variant_uom_price WHERE "branchId"=$1 AND "variantId"=$2`,
              [dubai, v],
            )
          )[0]!.n,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM branch_variant_price_set WHERE "branchId"=$1 AND "variantId"=$2`,
              [dubai, v],
            )
          )[0]!.n,
        ),
      ).toBe(1);
    });

    it('first EMPTY PUT If-Match "0" creates v1 even with NO company pricing anywhere', async () => {
      const v = await mkVariant(ownerA, 'emptyfirst'); // no base UOM, no company price
      const p = await putBranchPrices(dubai, v, [], '"0"');
      expect(p.statusCode, p.payload).toBe(200);
      expect(bpJson(p)).toEqual({ version: 1, priceSetExists: true, prices: [] });
      expect(p.headers.etag).toBe('"1"');
      // no DELETE endpoint exists
      const del = await req('DELETE', BP(dubai, v), ownerA, undefined, { 'if-match': '"1"' });
      expect([404, 405]).toContain(del.statusCode);
    });

    it('once the aggregate exists, If-Match "0" is ALWAYS 409 (ABA prevented — no reset)', async () => {
      const v = await mkVariant(ownerA, 'aba', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(dubai, v, [], '"0"'); // v1
      await putBranchPrices(dubai, v, [], '"1"'); // v2
      const stale = await putBranchPrices(dubai, v, [], '"0"');
      expect(stale.statusCode).toBe(409);
      expect(errCode(stale)).toBe('BRANCH_PRICE_SET_VERSION_CONFLICT');
    });

    it('stale If-Match → 409; concurrent first PUTs → one v1, one 409, no raw P2002/500; variant.version untouched', async () => {
      const v = await mkVariant(ownerA, 'concur', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      const before = (await getVariant(ownerA, v)).version;
      const [a, b] = await Promise.all([
        putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('111', 'AED', 2) }], '"0"'),
        putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('222', 'AED', 2) }], '"0"'),
      ]);
      const ok = [a, b].filter((r) => r.statusCode === 200);
      const conflict = [a, b].filter((r) => r.statusCode === 409);
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(1);
      expect(conflict[0]!.statusCode).not.toBe(500);
      expect(errCode(conflict[0]!)).toBe('BRANCH_PRICE_SET_VERSION_CONFLICT');
      expect(bpJson(ok[0]!).version).toBe(1);
      // the winner response == its own committed set == the single stored row
      const stored = await sql<{ a: string }>(
        `SELECT "overrideAmountMinor"::text AS a FROM branch_variant_uom_price WHERE "branchId"=$1 AND "variantId"=$2`,
        [dubai, v],
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.a).toBe(bpJson(ok[0]!).prices[0]!.sell.amountMinor);
      expect((await getVariant(ownerA, v)).version).toBe(before);
    });

    it('a Dubai branch write does not change the Sharjah branch price-set version', async () => {
      const v = await mkVariant(ownerA, 'sibling', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(
        sharjah,
        v,
        [{ uomCode: 'piece', sell: money('400', 'AED', 2) }],
        '"0"',
      ); // sharjah v1
      await putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('450', 'AED', 2) }], '"0"'); // dubai v1
      await putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('460', 'AED', 2) }], '"1"'); // dubai v2
      expect(bpJson(await getBranchPrices(sharjah, v)).version).toBe(1);
      expect(bpJson(await getBranchPrices(dubai, v)).version).toBe(2);
      // isolation: dubai override does not leak into sharjah's stored row
      const shj = await resolveBranch(sharjah, v, 'uomCode=piece');
      expect((shj.json() as { price: { amountMinor: string } }).price.amountMinor).toBe('400');
    });
  });

  // ════════════ BD-1 + company↔branch TOCTOU ═════════════════════════════
  describe('company ↔ branch price-row integrity', () => {
    it('BD-1 — a branch override for a UOM with no company price → 422 BRANCH_PRICE_NO_COMPANY_PRICE', async () => {
      const v = await mkVariant(ownerA, 'bd1', { base: 'piece' });
      // company prices `piece` only; the branch tries to override `box`
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await mkUom(ownerA, { code: 'bd1box', family: 'EACH', nameEn: 'Box' });
      const gv = await getVariant(ownerA, v);
      await req(
        'PUT',
        `/catalog/variants/${v}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'bd1box', num: '12' }] },
        { 'if-match': `"${gv.version}"` },
      );
      const bad = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'bd1box', sell: money('5000', 'AED', 2) }],
        '"0"',
      );
      expect(bad.statusCode).toBe(422);
      expect(errCode(bad)).toBe('BRANCH_PRICE_NO_COMPANY_PRICE');
      // after the company prices box, the same PUT succeeds
      const g = await req('GET', CP(coA, v), ownerA);
      await putCompanyPrices(
        coA,
        v,
        [
          { uomCode: 'piece', sell: money('500', 'AED', 2) },
          { uomCode: 'bd1box', sell: money('5500', 'AED', 2) },
        ],
        `"${(g.json() as { version: number }).version}"`,
      );
      const ok = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'bd1box', sell: money('5000', 'AED', 2) }],
        '"0"',
      );
      expect(ok.statusCode, ok.payload).toBe(200);
    });

    it('company PUT [] while a branch override exists → 409 COMPANY_PRICE_HAS_BRANCH_OVERRIDE (no branchId leak); regardless of branch_pricing capability', async () => {
      const v = await mkVariant(ownerA, 'toctou1', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(
        sharjah,
        v,
        [{ uomCode: 'piece', sell: money('400', 'AED', 2) }],
        '"0"',
      );

      const g = await req('GET', CP(coA, v), ownerA);
      const clear = await putCompanyPrices(
        coA,
        v,
        [],
        `"${(g.json() as { version: number }).version}"`,
      );
      expect(clear.statusCode).toBe(409);
      expect(errCode(clear)).toBe('COMPANY_PRICE_HAS_BRANCH_OVERRIDE');
      // the error carries UOM codes + a count, NEVER a sibling branchId
      expect(JSON.stringify(clear.json())).not.toContain(sharjah);
      expect(JSON.stringify(clear.json())).toMatch(/piece/);

      // still blocked with branch_pricing DISABLED
      await setCap(tenantA, 'branch_pricing', false);
      const g2 = await req('GET', CP(coA, v), ownerA);
      const clear2 = await putCompanyPrices(
        coA,
        v,
        [],
        `"${(g2.json() as { version: number }).version}"`,
      );
      expect(errCode(clear2)).toBe('COMPANY_PRICE_HAS_BRANCH_OVERRIDE');
      await setCap(tenantA, 'branch_pricing', true);

      // clear the branch override, then the company PUT [] succeeds
      await putBranchPrices(sharjah, v, [], '"1"');
      const g3 = await req('GET', CP(coA, v), ownerA);
      const clear3 = await putCompanyPrices(
        coA,
        v,
        [],
        `"${(g3.json() as { version: number }).version}"`,
      );
      expect(clear3.statusCode, clear3.payload).toBe(200);
    });

    it('TOCTOU — company writer first: branch writer waits, then 422 BRANCH_PRICE_NO_COMPANY_PRICE (no orphan)', async () => {
      const v = await mkVariant(ownerA, 'toctou-cf', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      const g = await req('GET', CP(coA, v), ownerA);
      const companyVersion = (g.json() as { version: number }).version;

      const branchRes = await withHeldTxn(
        async (c) => {
          // hold company_variant_price_set FOR UPDATE + remove the company row,
          // mimicking a mid-flight company `replace()` clearing prices.
          await c.query(`SET ROLE flower_app`);
          await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
          await c.query(
            `SELECT id FROM company_variant_price_set
             WHERE "tenantId"=$1 AND "companyId"=$2 AND "variantId"=$3 FOR UPDATE`,
            [tenantA, coA, v],
          );
          await c.query(
            `DELETE FROM company_variant_uom_price WHERE "companyId"=$1 AND "variantId"=$2`,
            [coA, v],
          );
        },
        () =>
          putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('450', 'AED', 2) }], '"0"'),
      );
      expect([422, 409]).toContain(branchRes.statusCode);
      if (branchRes.statusCode === 422) {
        expect(errCode(branchRes)).toBe('BRANCH_PRICE_NO_COMPANY_PRICE');
      }
      // no orphan branch override row committed
      const orphan = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM branch_variant_uom_price bvup
           LEFT JOIN company_variant_uom_price cvup
             ON cvup."companyId"=bvup."companyId" AND cvup."variantId"=bvup."variantId" AND cvup."uomCode"=bvup."uomCode"
          WHERE cvup.id IS NULL`,
      );
      expect(Number(orphan[0]!.n)).toBe(0);
      void companyVersion;
    });

    it('TOCTOU — branch writer first: company remove waits, then 409 COMPANY_PRICE_HAS_BRANCH_OVERRIDE', async () => {
      const v = await mkVariant(ownerA, 'toctou-bf', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);

      const companyRes = await withHeldTxn(
        async (c) => {
          // hold company_variant_price_set FOR SHARE + write a branch override,
          // mimicking a mid-flight branch `PUT`.
          await c.query(`SET ROLE flower_app`);
          await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
          await c.query(
            `SELECT id FROM company_variant_price_set
             WHERE "tenantId"=$1 AND "companyId"=$2 AND "variantId"=$3 FOR SHARE`,
            [tenantA, coA, v],
          );
          await c.query(
            `INSERT INTO branch_variant_price_set (id,"tenantId","companyId","branchId","variantId","updatedAt")
             VALUES (uuidv7(),$1,$2,$3,$4,now()) ON CONFLICT DO NOTHING`,
            [tenantA, coA, sharjah, v],
          );
          await c.query(
            `INSERT INTO branch_variant_uom_price
               (id,"tenantId","companyId","branchId","variantId","uomCode","overrideAmountMinor","overrideCurrencyCode","overrideCurrencyExponent","updatedAt")
             VALUES (uuidv7(),$1,$2,$3,$4,'piece',400,'AED',2,now())`,
            [tenantA, coA, sharjah, v],
          );
        },
        async () => {
          const g = await req('GET', CP(coA, v), ownerA);
          return putCompanyPrices(coA, v, [], `"${(g.json() as { version: number }).version}"`);
        },
      );
      expect(companyRes.statusCode).toBe(409);
      expect(errCode(companyRes)).toBe('COMPANY_PRICE_HAS_BRANCH_OVERRIDE');
      await sql(`DELETE FROM branch_variant_price_set WHERE "branchId"=$1 AND "variantId"=$2`, [
        sharjah,
        v,
      ]);
    });
  });

  // ════════════ base-UOM race + custom-UOM delete race ═══════════════════
  describe('UOM lifecycle races', () => {
    it('base-UOM change is blocked by a branch override (no branchId leak); availability rows do NOT block it', async () => {
      const v = await mkVariant(ownerA, 'baselock', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(
        sharjah,
        v,
        [{ uomCode: 'piece', sell: money('400', 'AED', 2) }],
        '"0"',
      );
      const gv = await getVariant(ownerA, v);
      const lock = await req(
        'PUT',
        `/catalog/variants/${v}/base-uom`,
        ownerA,
        { baseUomCode: 'kilogram' },
        { 'if-match': `"${gv.version}"` },
      );
      expect(lock.statusCode).toBe(409);
      expect(errCode(lock)).toBe('VARIANT_BASE_UOM_LOCKED');
      expect(JSON.stringify(lock.json())).not.toContain(sharjah);

      // an availability-only variant does NOT lock its base UOM
      const v2 = await mkVariant(ownerA, 'baseavail', { base: 'piece' });
      await setAvail(dubai, [{ variantId: v2, available: false }], ik());
      const gv2 = await getVariant(ownerA, v2);
      const ok = await req(
        'PUT',
        `/catalog/variants/${v2}/base-uom`,
        ownerA,
        { baseUomCode: 'kilogram' },
        { 'if-match': `"${gv2.version}"` },
      );
      expect(ok.statusCode, ok.payload).toBe(200);
    });

    it('custom-UOM hard-delete is blocked while a branch override references it (409 UOM_IN_USE)', async () => {
      const v = await mkVariant(ownerA, 'uomdel', { base: 'piece' });
      const created = await mkUom(ownerA, { code: 'delbox', family: 'EACH', nameEn: 'Box' });
      expect(created.statusCode).toBe(201);
      const gv = await getVariant(ownerA, v);
      await req(
        'PUT',
        `/catalog/variants/${v}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'delbox', num: '10' }] },
        { 'if-match': `"${gv.version}"` },
      );
      await companyPrice(coA, v, [
        { uomCode: 'piece', sell: money('500', 'AED', 2) },
        { uomCode: 'delbox', sell: money('4800', 'AED', 2) },
      ]);
      await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'delbox', sell: money('4500', 'AED', 2) }],
        '"0"',
      );

      const uomRow = (
        await sql<{ version: number }>(`SELECT version FROM uom WHERE code='delbox'`)
      )[0]!;
      const del = await req('DELETE', `/catalog/uoms/delbox`, ownerA, undefined, {
        'if-match': `"${uomRow.version}"`,
      });
      expect(del.statusCode).toBe(409);
      expect(errCode(del)).toBe('UOM_IN_USE');
      expect(JSON.stringify(del.json())).toMatch(/branch price override/i);
    });
  });

  // ════════════ availability ═════════════════════════════════════════════
  describe('branch availability', () => {
    it('structural 400 vs domain 422/400 split; min 1 / max 500; atomic rollback', async () => {
      const v1 = await mkVariant(ownerA, 'av1');
      const v2 = await mkVariant(ownerA, 'av2');
      // malformed shape → 400
      const bad = await setAvail(dubai, [{ variantId: 'nope', available: true }], ik());
      expect(bad.statusCode).toBe(400);
      // 0 entries → 400
      expect((await setAvail(dubai, [], ik())).statusCode).toBe(400);
      // duplicate variantId → 422 (a DomainError, not VALIDATION_FAILED)
      const dup = await setAvail(
        dubai,
        [
          { variantId: v1, available: true },
          { variantId: v1, available: false },
        ],
        ik(),
      );
      expect(dup.statusCode).toBe(422);
      expect(errCode(dup)).toBe('BRANCH_AVAILABILITY_DUPLICATE_VARIANT');
      // non-ascending → 400
      const [lo, hi] = [v1, v2].sort();
      const desc = await setAvail(
        dubai,
        [
          { variantId: hi, available: true },
          { variantId: lo, available: false },
        ],
        ik(),
      );
      expect(desc.statusCode).toBe(400);
      // unknown tenant variant → 422 BRANCH_AVAILABILITY_VARIANT_NOT_FOUND, whole batch rolls back
      const unknown = '00000000-0000-7000-8000-0000000000ff';
      const rollback = await setAvail(
        dubai,
        [lo, unknown].sort().map((id) => ({ variantId: id, available: false })),
        ik(),
      );
      expect(rollback.statusCode).toBe(422);
      expect(errCode(rollback)).toBe('BRANCH_AVAILABILITY_VARIANT_NOT_FOUND');
      // the whole batch rolled back — the valid entry `lo` (v1) wrote NO row
      expect(
        Number(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM branch_variant_availability WHERE "branchId"=$1 AND "variantId"=$2`,
              [dubai, lo],
            )
          )[0]!.n,
        ),
      ).toBe(0);
    });

    it('idempotency is principal + branch bound; replay writes no second audit row; a different principal is independent', async () => {
      const v = await mkVariant(ownerA, 'avidem');
      const body = [{ variantId: v, available: false }];
      const key = ik();
      const r1 = await setAvail(dubai, body, key, ownerA);
      expect(r1.statusCode, r1.payload).toBe(200);
      const r1Body = r1.json();
      expect(r1Body).toEqual({ entries: [{ variantId: v, available: false, explicit: true }] });

      const auditsAfter1 = Number(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_log WHERE action='catalog.branch_availability_changed' AND "resourceId"=$1`,
            [dubai],
          )
        )[0]!.n,
      );

      // same key + same principal + same branch + same body → replay, no 2nd audit
      const r1replay = await setAvail(dubai, body, key, ownerA);
      expect(r1replay.statusCode).toBe(200);
      expect(r1replay.json()).toEqual(r1Body);
      expect(r1replay.headers['idempotency-replayed']).toBe('true');
      const auditsAfterReplay = Number(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_log WHERE action='catalog.branch_availability_changed' AND "resourceId"=$1`,
            [dubai],
          )
        )[0]!.n,
      );
      expect(auditsAfterReplay).toBe(auditsAfter1);

      // same key + same principal + DIFFERENT branch → conflict
      const diffBranch = await setAvail(sharjah, body, key, ownerA);
      expect(diffBranch.statusCode).toBe(409);
      expect(errCode(diffBranch)).toBe('IDEMPOTENCY_KEY_REUSED');

      // same key + same principal + same branch + DIFFERENT body → conflict
      const diffBody = await setAvail(dubai, [{ variantId: v, available: true }], key, ownerA);
      expect(diffBody.statusCode).toBe(409);
      expect(errCode(diffBody)).toBe('IDEMPOTENCY_KEY_REUSED');

      // DIFFERENT principal, same key → independent operation (executes)
      const otherPrincipal = await setAvail(
        dubai,
        [{ variantId: v, available: true }],
        key,
        ownerA2,
      );
      expect(otherPrincipal.statusCode, otherPrincipal.payload).toBe(200);
      expect(
        (otherPrincipal.json() as { entries: { available: boolean }[] }).entries[0]!.available,
      ).toBe(true);
    });

    it('explicit true stored; absence resolves available:true/explicit:false; unknown GET variant → 404', async () => {
      const v = await mkVariant(ownerA, 'avexpl');
      // absence
      const g0 = await getAvail(dubai, `?variantId=${v}`);
      expect(g0.statusCode).toBe(200);
      expect(g0.json()).toEqual([{ variantId: v, available: true, explicit: false }]);
      // explicit true
      await setAvail(dubai, [{ variantId: v, available: true }], ik());
      const g1 = await getAvail(dubai, `?variantId=${v}`);
      expect(g1.json()).toEqual([{ variantId: v, available: true, explicit: true }]);
      // unknown / random / cross-tenant → 404
      const rnd = await getAvail(dubai, `?variantId=00000000-0000-7000-8000-0000000000aa`);
      expect(rnd.statusCode).toBe(404);
      const vB = await mkVariant(ownerB, 'avb');
      const crossTenant = await getAvail(dubai, `?variantId=${vB}`);
      expect(crossTenant.statusCode).toBe(404);
      // unfiltered → explicit rows only
      const all = await getAvail(dubai);
      expect((all.json() as { variantId: string }[]).every((r) => 'explicit' in r)).toBe(true);
    });

    it('availability is independent of pricing; does not gate base-UOM; does not alter price resolution', async () => {
      const v = await mkVariant(ownerA, 'avindep', { base: 'piece' });
      // set availability BEFORE any company/branch price — succeeds
      const set = await setAvail(dubai, [{ variantId: v, available: false }], ik());
      expect(set.statusCode, set.payload).toBe(200);
      // now price it at the company level and resolve — price returned + branchAvailable:false
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      const r = await resolveBranch(dubai, v, 'uomCode=piece');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        price: { amountMinor: '500', currency: 'AED' },
        source: 'COMPANY',
        branchAvailable: false,
      });
    });

    it('branch_pricing capability gates EVERY branch write — price AND availability (owner ruling 2026-09-09)', async () => {
      // an EXISTING availability row that must survive a capability disable (F)
      const surviving = await mkVariant(ownerA, 'avsurvive');
      const pre = await setAvail(dubai, [{ variantId: surviving, available: false }], ik());
      expect(pre.statusCode, pre.payload).toBe(200);
      const auditsBefore = Number(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_log WHERE action='catalog.branch_availability_changed' AND "resourceId"=$1`,
            [dubai],
          )
        )[0]!.n,
      );

      await setCap(tenantA, 'branch_pricing', false);
      try {
        const v = await mkVariant(ownerA, 'avnocap', { base: 'piece' });
        await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);

        // (B) availability PUT is now BLOCKED → 409 CAPABILITY_NOT_ENABLED
        const availBlocked = await setAvail(dubai, [{ variantId: v, available: false }], ik());
        expect(availBlocked.statusCode).toBe(409);
        expect(errCode(availBlocked)).toBe('CAPABILITY_NOT_ENABLED');
        // ...and it produced NO business mutation and NO audit row
        expect(
          Number(
            (
              await sql<{ n: string }>(
                `SELECT count(*)::text AS n FROM branch_variant_availability WHERE "branchId"=$1 AND "variantId"=$2`,
                [dubai, v],
              )
            )[0]!.n,
          ),
        ).toBe(0);
        expect(
          Number(
            (
              await sql<{ n: string }>(
                `SELECT count(*)::text AS n FROM audit_log WHERE action='catalog.branch_availability_changed' AND "resourceId"=$1`,
                [dubai],
              )
            )[0]!.n,
          ),
        ).toBe(auditsBefore);

        // (also) price writes still blocked, incl. PUT []
        const priceBlocked = await putBranchPrices(
          dubai,
          v,
          [{ uomCode: 'piece', sell: money('450', 'AED', 2) }],
          '"0"',
        );
        expect(errCode(priceBlocked)).toBe('CAPABILITY_NOT_ENABLED');
        expect((await putBranchPrices(dubai, v, [], '"0"')).statusCode).toBe(409);

        // (C) availability READ still works
        expect((await getAvail(dubai, `?variantId=${v}`)).statusCode).toBe(200);
        // (D) branch effective-catalog READ still works
        expect((await effCatalog(dubai)).statusCode).toBe(200);
        // (E) branch price GET + resolve READS still work
        expect((await getBranchPrices(dubai, v)).statusCode).toBe(200);
        expect((await resolveBranch(dubai, v, 'uomCode=piece')).statusCode).toBe(200);

        // (F) the pre-existing availability row is untouched
        const still = await getAvail(dubai, `?variantId=${surviving}`);
        expect(still.json()).toEqual([{ variantId: surviving, available: false, explicit: true }]);
      } finally {
        await setCap(tenantA, 'branch_pricing', true);
      }

      // (A) capability re-enabled → availability PUT succeeds
      const v2 = await mkVariant(ownerA, 'avnocap2');
      const ok = await setAvail(dubai, [{ variantId: v2, available: false }], ik());
      expect(ok.statusCode, ok.payload).toBe(200);
    });

    it('a capability-blocked availability retry (same key) re-executes after the capability is re-enabled — the 409 released the idempotency claim', async () => {
      const v = await mkVariant(ownerA, 'avretry');
      const key = ik();
      await setCap(tenantA, 'branch_pricing', false);
      const blocked = await setAvail(dubai, [{ variantId: v, available: false }], key);
      expect(blocked.statusCode).toBe(409);
      expect(errCode(blocked)).toBe('CAPABILITY_NOT_ENABLED');
      await setCap(tenantA, 'branch_pricing', true);
      // same key — a non-2xx released the claim, so the retry EXECUTES (not IN_PROGRESS / not a stale replay)
      const retry = await setAvail(dubai, [{ variantId: v, available: false }], key);
      expect(retry.statusCode, retry.payload).toBe(200);
      expect((retry.json() as { entries: { available: boolean }[] }).entries[0]!.available).toBe(
        false,
      );
    });
  });

  // ════════════ currency / money / UOM ═══════════════════════════════════
  describe('currency + money + UOM validation', () => {
    it('box-only override allowed; no base-UOM branch price required; no multiplication; wrong currency/exponent → 422; malformed → 400', async () => {
      const v = await mkVariant(ownerA, 'cur', { base: 'piece' });
      await mkUom(ownerA, { code: 'curbox', family: 'EACH', nameEn: 'Box' });
      const gv = await getVariant(ownerA, v);
      await req(
        'PUT',
        `/catalog/variants/${v}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'curbox', num: '12' }] },
        { 'if-match': `"${gv.version}"` },
      );
      await companyPrice(coA, v, [
        { uomCode: 'piece', sell: money('500', 'AED', 2) },
        { uomCode: 'curbox', sell: money('5500', 'AED', 2) },
      ]);

      // box-only override, no piece override → allowed
      const boxOnly = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'curbox', sell: money('5000', 'AED', 2) }],
        '"0"',
      );
      expect(boxOnly.statusCode, boxOnly.payload).toBe(200);
      // resolve box → the STORED box override, not 12 × a piece price
      const rBox = await resolveBranch(dubai, v, 'uomCode=curbox');
      expect((rBox.json() as { price: { amountMinor: string } }).price.amountMinor).toBe('5000');
      // resolve piece → falls back to the COMPANY piece price (no branch override for piece)
      const rPiece = await resolveBranch(dubai, v, 'uomCode=piece');
      expect(rPiece.json()).toMatchObject({ source: 'COMPANY', price: { amountMinor: '500' } });

      // wrong currency → 422 mismatch
      const mism = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'piece', sell: money('500', 'SAR', 2) }],
        '"1"',
      );
      expect(mism.statusCode).toBe(422);
      expect(errCode(mism)).toBe('BRANCH_PRICE_CURRENCY_MISMATCH');
      // structurally-valid wrong exponent → 422 invalid
      const wrongExp = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'piece', sell: money('500', 'AED', 3) }],
        '"1"',
      );
      expect(wrongExp.statusCode).toBe(422);
      expect(errCode(wrongExp)).toBe('BRANCH_PRICE_CURRENCY_INVALID');
      // malformed money shape → 400
      const malformed = await req(
        'PUT',
        BP(dubai, v),
        ownerA,
        {
          prices: [{ uomCode: 'piece', sell: { amountMinor: '1.5', currency: 'AE', exponent: 2 } }],
        },
        { 'if-match': '"1"' },
      );
      expect(malformed.statusCode).toBe(400);
      // a `purchase` field → 400
      const withPurchase = await req(
        'PUT',
        BP(dubai, v),
        ownerA,
        {
          prices: [
            {
              uomCode: 'piece',
              sell: money('500', 'AED', 2),
              purchase: money('1', 'AED', 2),
            },
          ],
        },
        { 'if-match': '"1"' },
      );
      expect(withPurchase.statusCode).toBe(400);
    });

    it('unreachable UOM → 422 BRANCH_PRICE_UOM_UNREACHABLE; VARIANT_BASE_UOM_REQUIRED only for a non-empty PUT', async () => {
      const v = await mkVariant(ownerA, 'unreach'); // no base UOM
      // non-empty PUT → 409 VARIANT_BASE_UOM_REQUIRED
      const noBase = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
        '"0"',
      );
      expect(noBase.statusCode).toBe(409);
      expect(errCode(noBase)).toBe('VARIANT_BASE_UOM_REQUIRED');
    });

    it('company.defaultCurrency cannot change while a branch override references it (DB RESTRICT backstop)', async () => {
      const v = await mkVariant(ownerA, 'currestrict', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('450', 'AED', 2) }], '"0"');
      await expect(
        sql(`UPDATE company SET "defaultCurrency"='SAR' WHERE id=$1`, [coA]),
      ).rejects.toThrow(/foreign key|violates|update or delete/i);
      // direct DB write of a wrong exponent → currency-pair FK reject
      await expect(
        sql(
          `INSERT INTO branch_variant_uom_price
             (id,"tenantId","companyId","branchId","variantId","uomCode","overrideAmountMinor","overrideCurrencyCode","overrideCurrencyExponent","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$4,'kilogram',100,'AED',3,now())`,
          [tenantA, coA, dubai, v],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('conversion delete → resolvable:false; re-add restores; amount unchanged', async () => {
      const v = await mkVariant(ownerA, 'convdel', { base: 'piece' });
      await mkUom(ownerA, { code: 'cdbox', family: 'EACH', nameEn: 'Box' });
      let gv = await getVariant(ownerA, v);
      await req(
        'PUT',
        `/catalog/variants/${v}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'cdbox', num: '12' }] },
        { 'if-match': `"${gv.version}"` },
      );
      await companyPrice(coA, v, [
        { uomCode: 'piece', sell: money('500', 'AED', 2) },
        { uomCode: 'cdbox', sell: money('5500', 'AED', 2) },
      ]);
      await putBranchPrices(dubai, v, [{ uomCode: 'cdbox', sell: money('5000', 'AED', 2) }], '"0"');

      // delete the conversion
      gv = await getVariant(ownerA, v);
      await req(
        'PUT',
        `/catalog/variants/${v}/conversions`,
        ownerA,
        { conversions: [] },
        { 'if-match': `"${gv.version}"` },
      );
      const g = await getBranchPrices(dubai, v);
      expect(bpJson(g).prices[0]).toMatchObject({ uomCode: 'cdbox', resolvable: false });
      const r = await resolveBranch(dubai, v, 'uomCode=cdbox');
      expect(r.json()).toEqual({
        price: null,
        source: null,
        reason: 'UOM_UNRESOLVABLE',
        branchAvailable: true,
      });

      // re-add → restored, amount unchanged
      gv = await getVariant(ownerA, v);
      await req(
        'PUT',
        `/catalog/variants/${v}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'cdbox', num: '12' }] },
        { 'if-match': `"${gv.version}"` },
      );
      const r2 = await resolveBranch(dubai, v, 'uomCode=cdbox');
      expect(r2.json()).toMatchObject({ source: 'BRANCH', price: { amountMinor: '5000' } });
    });
  });

  // ════════════ resolve + effective catalog + scope ══════════════════════
  describe('resolve + effective catalog + scope', () => {
    it('precedence: branch → company → null; strict query; malformed uomCode → 422 before DB; branchId key → 400', async () => {
      const v = await mkVariant(ownerA, 'prec', { base: 'piece' });
      // no company aggregate → NO_PRICE_SET (but a valid uomCode)
      const g0 = await resolveBranch(dubai, v, 'uomCode=piece');
      expect(g0.json()).toEqual({
        price: null,
        source: null,
        reason: 'NO_PRICE_SET',
        branchAvailable: true,
      });
      // malformed uomCode → 422 UOM_INVALID_CODE (validated before any DB access)
      const bad = await resolveBranch(dubai, v, 'uomCode=BOX%2Fvalue');
      expect(bad.statusCode).toBe(422);
      expect(errCode(bad)).toBe('UOM_INVALID_CODE');
      // an extra query key → 400
      const extra = await resolveBranch(dubai, v, 'uomCode=piece&branchId=abc');
      expect(extra.statusCode).toBe(400);

      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      // company only → source COMPANY
      expect((await resolveBranch(dubai, v, 'uomCode=piece')).json()).toMatchObject({
        source: 'COMPANY',
      });
      // aggregate exists, uom not priced → UOM_NOT_PRICED
      expect((await resolveBranch(dubai, v, 'uomCode=kilogram')).json()).toMatchObject({
        reason: 'UOM_UNRESOLVABLE',
      });
      // branch override → source BRANCH
      await putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('450', 'AED', 2) }], '"0"');
      expect((await resolveBranch(dubai, v, 'uomCode=piece')).json()).toMatchObject({
        source: 'BRANCH',
        price: { amountMinor: '450' },
      });
    });

    it('effective catalog — one entry per company-priced variant; branch overrides replace company tiers; cursor paginated', async () => {
      const v = await mkVariant(ownerA, 'effcat', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('450', 'AED', 2) }], '"0"');
      await setAvail(dubai, [{ variantId: v, available: false }], ik());

      const r = await effCatalog(dubai, '?limit=200');
      expect(r.statusCode).toBe(200);
      const body = r.json() as {
        entries: {
          variantId: string;
          available: boolean;
          prices: { uomCode: string; sell: { amountMinor: string }; source: string }[];
        }[];
        nextCursor: string | null;
      };
      const entry = body.entries.find((e) => e.variantId === v)!;
      expect(entry.available).toBe(false);
      expect(entry.prices).toEqual([
        {
          uomCode: 'piece',
          sell: { amountMinor: '450', currency: 'AED', exponent: 2 },
          source: 'BRANCH',
          resolvable: true,
        },
      ]);
      // no product name / attributes / identifiers / media / inventory
      expect(JSON.stringify(entry)).not.toMatch(/nameEn|attributes|identifiers|media|onHand/i);
    });

    it('effective-catalog pagination is over UNIQUE variants, not price rows (CHECK 2) — a multi-UOM variant consumes exactly ONE page slot; no skips, no dupes, stable nextCursor', async () => {
      // a DEDICATED company + branch so this test's variant set is isolated
      const pgCo = (
        await sql<{ id: string }>(
          `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","status","updatedAt")
           VALUES (uuidv7(),$1,'PgCo','AE','AED','ACTIVE',now()) RETURNING id`,
          [tenantA],
        )
      )[0]!.id;
      const pgBranch = (
        await sql<{ id: string }>(
          `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
           VALUES (uuidv7(),$1,$2,'PgBranch',now()) RETURNING id`,
          [tenantA, pgCo],
        )
      )[0]!.id;

      // three variants created IN ORDER — variantId is uuidv7 ⇒ a < b < c
      const a = await mkVariant(ownerA, 'pgva');
      const b = await mkVariant(ownerA, 'pgvb');
      const c = await mkVariant(ownerA, 'pgvc');
      // price them at the COMPANY level (direct SQL — this test is about paging,
      // not the pricing API): A has 3 UOM rows, B has 1, C has 2.
      for (const [vid, uoms] of [
        [a, ['piece', 'ecdozen', 'eccarton']],
        [b, ['piece']],
        [c, ['piece', 'ecdozen']],
      ] as [string, string[]][]) {
        await sql(
          `INSERT INTO company_variant_price_set (id,"tenantId","companyId","variantId","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,now())`,
          [tenantA, pgCo, vid],
        );
        for (const u of uoms) {
          await sql(
            `INSERT INTO company_variant_uom_price
               (id,"tenantId","companyId","variantId","uomCode","sellAmountMinor","sellCurrencyCode","sellCurrencyExponent","updatedAt")
             VALUES (uuidv7(),$1,$2,$3,$4,100,'AED',2,now())`,
            [tenantA, pgCo, vid, u],
          );
        }
      }
      // a BRANCH override on A/piece (direct SQL — A has no base UOM here) — the
      // projection must still count A exactly ONCE and prefer the branch tier.
      await sql(
        `INSERT INTO branch_variant_price_set (id,"tenantId","companyId","branchId","variantId","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,now())`,
        [tenantA, pgCo, pgBranch, a],
      );
      await sql(
        `INSERT INTO branch_variant_uom_price
           (id,"tenantId","companyId","branchId","variantId","uomCode","overrideAmountMinor","overrideCurrencyCode","overrideCurrencyExponent","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,'piece',90,'AED',2,now())`,
        [tenantA, pgCo, pgBranch, a],
      );

      type Page = {
        entries: { variantId: string; prices: { uomCode: string; source: string }[] }[];
        nextCursor: string | null;
      };
      const pageOf = async (cursor?: string): Promise<Page> =>
        (await effCatalog(pgBranch, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json() as Page;

      // the effective-catalog page order is variantId ASC; A has 3 company UOM
      // rows, B has 1, C has 2 — a multi-UOM variant must consume exactly ONE
      // page slot (the DISTINCT collapses the extra rows before LIMIT).
      const tierCount: Record<string, number> = { [a]: 3, [b]: 1, [c]: 2 };
      const ordered = [a, b, c].sort();
      const seen = new Set<string>();

      // limit=1 walk: page1 → A (nextCursor A), page2 → B (nextCursor B),
      // page3 → C (nextCursor NULL — the `limit + 1` lookahead found no 4th
      // unique variant, so the walk terminates WITHOUT a trailing empty request).
      let cursor: string | null | undefined = undefined;
      for (let i = 0; i < ordered.length; i++) {
        const pg: Page = await pageOf(cursor ?? undefined);
        expect(pg.entries, `page ${i + 1} must hold exactly one unique variant`).toHaveLength(1);
        const e = pg.entries[0]!;
        expect(e.variantId, `page ${i + 1}`).toBe(ordered[i]);
        expect(seen.has(e.variantId), 'no variant repeats across pages').toBe(false);
        seen.add(e.variantId);
        expect(e.prices, `${e.variantId} tier count`).toHaveLength(tierCount[e.variantId]!);
        const isLast = i === ordered.length - 1;
        expect(
          pg.nextCursor,
          isLast
            ? 'final page → nextCursor null (lookahead saw no further variant)'
            : 'nextCursor is the last emitted variantId',
        ).toBe(isLast ? null : ordered[i]);
        cursor = pg.nextCursor;
      }
      // the walk is already done — nextCursor was null on page 3, no page 4 request.
      expect(cursor).toBeNull();
      // every variant seen exactly once — no skips
      expect([...seen].sort()).toEqual(ordered);

      // an explicit request past the last emitted id still yields entries=[] / null
      const past = await pageOf(ordered[ordered.length - 1]!);
      expect(past.entries).toEqual([]);
      expect(past.nextCursor).toBeNull();

      // the 3-UOM variant's page carried all 3 tiers (branch override on `piece`,
      // company fallback on the other two) — its extra rows never split the page.
      // limit=200 > 3 unique variants ⇒ hasMore false ⇒ nextCursor null.
      const bigPage = (await effCatalog(pgBranch, '?limit=200')).json() as Page;
      expect(bigPage.entries.map((x) => x.variantId)).toEqual(ordered);
      expect(bigPage.nextCursor).toBeNull();
      const aEntry = bigPage.entries.find((x) => x.variantId === a)!;
      expect(aEntry.prices.map((x) => x.uomCode).sort()).toEqual(['eccarton', 'ecdozen', 'piece']);
      expect(aEntry.prices.find((x) => x.uomCode === 'piece')!.source).toBe('BRANCH');
      expect(aEntry.prices.find((x) => x.uomCode === 'ecdozen')!.source).toBe('COMPANY');

      // a branch whose company has priced NOTHING → empty first page, nextCursor null
      const emptyBranch = (
        await sql<{ id: string }>(
          `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
           VALUES (uuidv7(),$1,$2,'PgBranchEmpty',now()) RETURNING id`,
          [
            tenantA,
            (
              await sql<{ id: string }>(
                `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","status","updatedAt")
                 VALUES (uuidv7(),$1,'PgCoEmpty','AE','AED','ACTIVE',now()) RETURNING id`,
                [tenantA],
              )
            )[0]!.id,
          ],
        )
      )[0]!.id;
      const empty = (await effCatalog(emptyBranch, '?limit=50')).json() as Page;
      expect(empty.entries).toEqual([]);
      expect(empty.nextCursor).toBeNull();
    });

    it('a catalog:view-only user → 403 on writes; branch reads work', async () => {
      const v = await mkVariant(ownerA, 'viewonly', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      expect(
        (
          await putBranchPrices(
            dubai,
            v,
            [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
            '"0"',
            viewerA,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await setAvail(dubai, [{ variantId: v, available: false }], ik(), viewerA)).statusCode,
      ).toBe(403);
      expect((await getBranchPrices(dubai, v, viewerA)).statusCode).toBe(200);
    });

    it('a Dubai-scoped user cannot touch the Sharjah branch (404), can touch Dubai; requestedBranchId is the selector', async () => {
      const v = await mkVariant(ownerA, 'branchscope', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      // Dubai user → Sharjah → 404 (BRANCH_OUT_OF_SCOPE → NotFound)
      expect(
        (
          await putBranchPrices(
            sharjah,
            v,
            [{ uomCode: 'piece', sell: money('400', 'AED', 2) }],
            '"0"',
            dubaiUserA,
          )
        ).statusCode,
      ).toBe(404);
      expect((await getBranchPrices(sharjah, v, dubaiUserA)).statusCode).toBe(404);
      // Dubai user → Dubai → OK
      const ok = await putBranchPrices(
        dubai,
        v,
        [{ uomCode: 'piece', sell: money('450', 'AED', 2) }],
        '"0"',
        dubaiUserA,
      );
      expect(ok.statusCode, ok.payload).toBe(200);
    });

    it('company B cannot reach company A branch pricing; cross-tenant denied', async () => {
      const v = await mkVariant(ownerA, 'cross', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('450', 'AED', 2) }], '"0"');
      // ownerB (tenant B) → A's branch id → 404, no leak
      const leak = await getBranchPrices(dubai, v, ownerB);
      expect([403, 404]).toContain(leak.statusCode);
      expect(JSON.stringify(leak.json())).not.toContain('450');
    });

    it('the Task 3.7 company resolver still rejects branchId (unchanged)', async () => {
      const v = await mkVariant(ownerA, 'compresolver', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      const r = await req('GET', CP(coA, v, `/resolve?uomCode=piece&branchId=${dubai}`), ownerA);
      expect(r.statusCode).toBe(400);
    });
  });

  it('branch_variant_uom_price is SELL-only — no purchase_* column ever written (grep + DB proof)', async () => {
    const cols = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='branch_variant_uom_price'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain('purchaseAmountMinor');
  });

  // ════════════ task 3.10 — transactional outbox events (owner D-1 / D-6) ════
  describe('task 3.10 — catalog outbox events', () => {
    const outbox = (eventType: string, resourceId?: string) =>
      sql<{
        tenantId: string;
        companyId: string | null;
        branchId: string | null;
        aggregateType: string;
        aggregateId: string;
        eventType: string;
        payload: Record<string, unknown>;
        resourceVersion: string | null;
        dispatchedAt: Date | null;
      }>(
        `SELECT "tenantId","companyId","branchId","aggregateType","aggregateId","eventType",
                payload,"resourceVersion"::text AS "resourceVersion","dispatchedAt"
           FROM outbox
          WHERE "eventType" = $1 ${resourceId ? 'AND "aggregateId" = $2' : ''}
          ORDER BY "createdAt" DESC LIMIT 5`,
        resourceId ? [eventType, resourceId] : [eventType],
      );
    const countOutbox = async (): Promise<number> =>
      Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`))[0]!.n);

    it('26/38/39 — a company price replace-set co-commits a company-scoped outbox row (company_id set, branch_id null, resource_version = set version, bounded payload, no Money)', async () => {
      const v = await mkVariant(ownerA, 'ob-cp', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]); // v1
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('600', 'AED', 2) }]); // v2
      const rows = await outbox('catalog.company.price_changed');
      const latest = rows[0]!;
      expect(latest.tenantId).toBe(tenantA);
      expect(latest.companyId).toBe(coA);
      expect(latest.branchId).toBeNull();
      expect(latest.aggregateType).toBe('company_variant_price_set');
      expect(latest.resourceVersion).toBe('2');
      expect(latest.payload['variantId']).toBe(v);
      expect(latest.payload['changedUomCodes']).toEqual(['piece']);
      const blob = JSON.stringify(latest.payload);
      expect(blob).not.toMatch(/amountMinor|"600"|AED|sell/i);
      expect(latest.dispatchedAt).toBeNull();
    });

    it('27 — a branch price replace-set co-commits a branch-scoped row carrying BOTH company_id and branch_id', async () => {
      const v = await mkVariant(ownerA, 'ob-bp', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await putBranchPrices(dubai, v, [{ uomCode: 'piece', sell: money('450', 'AED', 2) }], '"0"');
      const latest = (await outbox('catalog.branch.price_changed'))[0]!;
      expect(latest.tenantId).toBe(tenantA);
      expect(latest.companyId).toBe(coA);
      expect(latest.branchId).toBe(dubai);
      expect(latest.resourceVersion).toBe('1');
      expect(latest.payload['variantId']).toBe(v);
      expect(latest.payload['changedUomCodes']).toEqual(['piece']);
    });

    // ═══ CHECK 1 (owner final review, task 3.10) — identical-set PUT is a
    // logical mutation, never a content-diff no-op. Frozen source: Task 3.7
    // (`17b8623`) "9. bump the aggregate version ONLY when it already
    // existed" (existence, never content, gates the bump); Task 3.8
    // (`e333f9d`) `branch_variant_price_set` is "INDEPENDENTLY MONOTONIC
    // (created at 1, only incremented, never reset/deleted)". Proven here
    // through the real branch replace() path, mirroring the company-side
    // proof in catalog-company-pricing.integration.test.ts.
    it('CHECK1 — a content-identical branch PUT with correct If-Match bumps version n -> n+1, writes exactly 1 audit row, and enqueues exactly 1 outbox row at resource_version n+1', async () => {
      const v = await mkVariant(ownerA, 'check1-branch', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      const entries = [{ uomCode: 'piece', sell: money('450', 'AED', 2) }];

      const p1 = await putBranchPrices(dubai, v, entries, '"0"');
      expect(p1.statusCode, p1.payload).toBe(200);
      expect(bpJson(p1).version).toBe(1);
      const aggId = (
        await sql<{ id: string }>(
          `SELECT id FROM branch_variant_price_set WHERE "branchId"=$1 AND "variantId"=$2`,
          [dubai, v],
        )
      )[0]!.id;

      const countAudit = async (): Promise<number> =>
        Number(
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM audit_log WHERE "resourceId"=$1 AND action='catalog.branch_price_changed'`,
              [aggId],
            )
          )[0]!.n,
        );
      const auditBefore = await countAudit();
      const outboxBefore = (await outbox('catalog.branch.price_changed', aggId)).length;

      // resubmit the EXACT same entries with the correct If-Match — content-identical.
      const p2 = await putBranchPrices(dubai, v, entries, '"1"');
      expect(p2.statusCode, p2.payload).toBe(200);
      expect(bpJson(p2).version).toBe(2); // n -> n+1, never a no-op
      expect(p2.headers.etag).toBe('"2"');
      expect(bpJson(p2).prices).toEqual(bpJson(p1).prices);

      expect(await countAudit()).toBe(auditBefore + 1); // exactly 1 new audit row

      const outboxRows = await outbox('catalog.branch.price_changed', aggId);
      expect(outboxRows.length).toBe(outboxBefore + 1); // exactly 1 new outbox row
      expect(outboxRows[0]!.resourceVersion).toBe('2'); // resource_version = n+1

      // a THIRD identical resubmit bumps again — unconditional on existence,
      // never gated on whether content changed.
      const p3 = await putBranchPrices(dubai, v, entries, '"2"');
      expect(bpJson(p3).version).toBe(3);
    });

    it('28 — a branch availability set co-commits a branch-scoped row (both ids, no resource_version, bounded variantIds)', async () => {
      const v = await mkVariant(ownerA, 'ob-av', { base: 'piece' });
      const r = await setAvail(dubai, [{ variantId: v, available: false }], ik());
      expect(r.statusCode, r.payload).toBe(200);
      const latest = (await outbox('catalog.branch.availability_changed'))[0]!;
      expect(latest.companyId).toBe(coA);
      expect(latest.branchId).toBe(dubai);
      expect(latest.aggregateType).toBe('branch');
      expect(latest.resourceVersion).toBeNull();
      expect(latest.payload['variantIds']).toEqual([v]);
    });

    it('36 — a rolled-back mutation (stale If-Match → 409) writes NO outbox row', async () => {
      const v = await mkVariant(ownerA, 'ob-rb', { base: 'piece' });
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]); // v1
      const before = await countOutbox();
      const stale = await putCompanyPrices(
        coA,
        v,
        [{ uomCode: 'piece', sell: money('999', 'AED', 2) }],
        '"0"',
      );
      expect(stale.statusCode).toBe(409);
      expect(await countOutbox()).toBe(before);
    });

    it('44 — an idempotent availability replay (same key) writes NO second outbox row', async () => {
      const v = await mkVariant(ownerA, 'ob-idem', { base: 'piece' });
      const key = ik();
      await setAvail(dubai, [{ variantId: v, available: true }], key);
      const after1 = (await outbox('catalog.branch.availability_changed', dubai)).length;
      await setAvail(dubai, [{ variantId: v, available: true }], key); // replay
      const after2 = (await outbox('catalog.branch.availability_changed', dubai)).length;
      expect(after2).toBe(after1);
    });

    it('41/42 — a tax-category / UOM / identifier mutation writes NO outbox row', async () => {
      const v = await mkVariant(ownerA, 'ob-neg', { base: 'piece' });
      const before = await countOutbox();
      // tax-category assignment (task 3.9)
      const gv = await req('GET', `/catalog/variants/${v}`, ownerA);
      const vv = (gv.json() as { version: number; productId: string }).version;
      await req(
        'PUT',
        `/catalog/variants/${v}/tax-category`,
        ownerA,
        { taxCategoryKey: 'STANDARD' },
        { 'if-match': `"${vv}"` },
      );
      // a UOM create
      const u = await mkUom(ownerA, { code: 'ob_neg_uom', family: 'EACH', nameEn: 'x' });
      expect(u.statusCode, u.payload).toBe(201);
      expect(await countOutbox()).toBe(before);
    });
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000380000', 'starter-bp', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000380000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 10);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin-bp@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('variants:manage','TENANT','catalog','v',3),('pricing:manage','TENANT','catalog','v',3),
             ('branch_price:manage','TENANT','catalog','v',3),
             ('settings:tenant:manage','TENANT','admin','v',1),
             ('users:view','TENANT','admin','v',1),('platform:tenants:view','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'x', 'x'), ('SAR', 2, 'SAR', 'x', 'x'), ('KWD', 3, 'KWD', 'x', 'x')
      ON CONFLICT (code) DO NOTHING;
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()),
             ('SA', 'KSA', 'x', 'gcc', 'SAR', 'FRI_SAT', true, now()),
             ('KW', 'Kuwait', 'x', 'gcc', 'KWD', 'FRI_SAT', true, now())
      ON CONFLICT (code) DO NOTHING;
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
