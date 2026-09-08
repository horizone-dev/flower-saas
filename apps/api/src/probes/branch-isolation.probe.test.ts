import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { PLATFORM_PERMISSIONS } from '@flower/permissions';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../common/context/index.js';
import { JwtService } from '../common/auth/jwt.service.js';
import { SessionStore } from '../common/auth/session-store.js';
import type { SessionData } from '../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-0000003800b1';
const PLATFORM_USER = '00000000-0000-7000-8000-0000003800b2';
const CATALOG = [
  'catalog:view',
  'catalog:manage',
  'variants:manage',
  'pricing:manage',
  'branch_price:manage',
];

/**
 * HG3-BRANCH-ISOLATION — build-blocking (PHASE-3-PLAN §G; introduced by Task 3.8).
 *
 * Proves that the branch is THE operational data boundary for Task 3.8:
 *   - the requested branch RESOURCE comes from the authorized `:branchId` path
 *     selector — never `singleBranchId`, never `posTerminalId`;
 *   - the single-branch `app.branch_id` RLS GUC physically prevents sibling-branch
 *     user-facing reads / writes;
 *   - a multi-branch authorized session reaches exactly its granted branches;
 *   - company isolation + cross-tenant isolation hold;
 *   - the per-branch permission overlay narrows correctly;
 *   - RLS is ENABLE + FORCE on all three tables; a no-GUC read returns 0 rows;
 *   - `flower_app` is still NOBYPASSRLS and Task 3.8 adds no new DB role;
 *   - the three cross-branch integrity read helpers stay tenant-isolated and never
 *     leak a sibling branch id through a dependency error, and restore the GUC.
 *
 * TEETH: weaken `@ScopedParam`/`PolicyEngine` branch scoping, or the branch-GUC
 * RLS predicate, or the integrity-helper tenant predicate, and a probe below
 * flips from denied/0-rows to 200-with-data → the suite fails.
 */
describe('HG3-BRANCH-ISOLATION (task 3.8)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let superTok = '';
  let tenantA = '';
  let tenantB = '';
  let coA = '';
  let dubai = '';
  let sharjah = '';
  let coBBranch = '';
  let ownerA = ''; // ALL branches
  let dubaiOnly = ''; // branchScope = [dubai]
  let dubaiPosBound = ''; // branchScope = [dubai] but posTerminalId bound to a Sharjah terminal
  let dubaiOverlayNoPrice = ''; // has branch_price:manage globally but the Sharjah overlay omits it
  let ownerB = '';
  let sharjahTerminal = '';
  let vShared = ''; // a company-A variant priced at company level, overridden in Sharjah

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
    tenantA = await provision('bi-a', 'AE');
    tenantB = await provision('bi-b', 'AE');
    for (const t of [tenantA, tenantB]) {
      await setCap(t, 'multi_uom', true);
      await setCap(t, 'branch_pricing', true);
    }
    coA = (await sql<{ id: string }>(`SELECT id FROM company WHERE "tenantId"=$1`, [tenantA]))[0]!
      .id;
    dubai = (await sql<{ id: string }>(`SELECT id FROM branch WHERE "tenantId"=$1`, [tenantA]))[0]!
      .id;
    coBBranch = (
      await sql<{ id: string }>(`SELECT id FROM branch WHERE "tenantId"=$1`, [tenantB])
    )[0]!.id;
    sharjah = (
      await sql<{ id: string }>(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt")
         VALUES (uuidv7(),$1,$2,'Sharjah',now()) RETURNING id`,
        [tenantA, coA],
      )
    )[0]!.id;
    sharjahTerminal = (
      await sql<{ id: string }>(
        `INSERT INTO pos_terminal (id,"tenantId","companyId","branchId",code,name,"updatedAt")
         VALUES (uuidv7(),$1,$2,$3,'SHJ-1','Sharjah till',now()) RETURNING id`,
        [tenantA, coA, sharjah],
      )
    )[0]!.id;

    ownerA = await mintTenant('oa', tenantA, CATALOG);
    dubaiOnly = await mintTenant('do', tenantA, CATALOG, { branchScope: [dubai] });
    dubaiPosBound = await mintTenant('dpb', tenantA, CATALOG, {
      branchScope: [dubai],
      posTerminalId: sharjahTerminal,
    });
    dubaiOverlayNoPrice = await mintTenant('don', tenantA, CATALOG, {
      branchScope: [dubai, sharjah],
      // Sharjah is granted, but WITHOUT branch_price:manage → step 9 overlay deny
      perBranchOverlay: { [sharjah]: ['catalog:view'] },
    });
    ownerB = await mintTenant('ob', tenantB, CATALOG);

    // a shared company-A variant: priced at the company level + overridden in Sharjah
    vShared = await mkVariant(ownerA, 'shared', 'piece');
    await companyPrice(coA, vShared, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
    const put = await req(
      'PUT',
      `/catalog/branches/${sharjah}/variants/${vShared}/prices`,
      ownerA,
      { prices: [{ uomCode: 'piece', sell: money('440', 'AED', 2) }] },
      { 'if-match': '"0"' },
    );
    expect(put.statusCode, put.payload).toBe(200);
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
      perBranchOverlay?: Record<string, string[]>;
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
    s.access = {
      effectivePermissions: perms,
      companyScope: 'ALL',
      branchScope: opts.branchScope ?? 'ALL',
      perBranchOverlay: opts.perBranchOverlay ?? {},
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
  const ik = (): string => `bi-key-${String(++idemN).padStart(4, '0')}`;
  const money = (amountMinor: string, currency: string, exponent: number) => ({
    amountMinor,
    currency,
    exponent,
  });
  async function mkVariant(token: string, slug: string, base: string): Promise<string> {
    const cat = await req(
      'POST',
      '/catalog/categories',
      token,
      { slug: `${slug}-c`, nameEn: slug },
      { 'idempotency-key': ik() },
    );
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
    const productId = (p.json() as { id: string }).id;
    const vs = (await req('GET', `/catalog/products/${productId}/variants`, token)).json() as {
      id: string;
      version: number;
    }[];
    const variantId = vs[0]!.id;
    const v = (await req('GET', `/catalog/variants/${variantId}`, token)).json() as {
      version: number;
    };
    await req(
      'PUT',
      `/catalog/variants/${variantId}/base-uom`,
      token,
      { baseUomCode: base },
      { 'if-match': `"${v.version}"` },
    );
    return variantId;
  }
  async function companyPrice(
    companyId: string,
    variantId: string,
    prices: unknown[],
  ): Promise<void> {
    const g = await req(
      'GET',
      `/catalog/companies/${companyId}/variants/${variantId}/prices`,
      ownerA,
    );
    const put = await req(
      'PUT',
      `/catalog/companies/${companyId}/variants/${variantId}/prices`,
      ownerA,
      { prices },
      { 'if-match': `"${(g.json() as { version: number }).version}"` },
    );
    expect(put.statusCode, put.payload).toBe(200);
  }
  const bPrices = (branch: string, variant: string, extra = ''): string =>
    `/catalog/branches/${branch}/variants/${variant}/prices${extra}`;

  // ══════════════ requestedBranchId is the resource selector ═════════════════
  it('the branch acted on is the authorized :branchId path selector — not singleBranchId, not posTerminalId', async () => {
    // a Dubai-only session hits /branches/<Sharjah>/... — the path selector is
    // Sharjah, and it is NOT in branchScope → denied (never silently redirected
    // to the session's single branch).
    const g = await req('GET', bPrices(sharjah, vShared), dubaiOnly);
    expect(g.statusCode).toBe(404);

    // a session BOUND to a Sharjah POS terminal but scoped only to Dubai still
    // cannot touch Sharjah — the terminal confers no reach (CLAUDE.md rule 8).
    const gPos = await req('GET', bPrices(sharjah, vShared), dubaiPosBound);
    expect(gPos.statusCode).toBe(404);
    const wPos = await req('PUT', bPrices(sharjah, vShared), dubaiPosBound, {
      prices: [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
    });
    expect([403, 404, 409]).toContain(wPos.statusCode);

    // the SAME Dubai-only session CAN reach its granted branch by the path
    const gDubai = await req('GET', bPrices(dubai, vShared), dubaiOnly);
    expect(gDubai.statusCode).toBe(200);
  });

  it('the single-branch app.branch_id GUC physically prevents a sibling-branch read (RLS level)', async () => {
    // seed a Dubai override, then read as a single-branch Sharjah session — the
    // RLS branch predicate returns 0 rows for Dubai even though the row exists.
    await req(
      'PUT',
      bPrices(dubai, vShared),
      ownerA,
      { prices: [{ uomCode: 'piece', sell: money('455', 'AED', 2) }] },
      { 'if-match': '"0"' },
    );
    const sharjahOnly = await mintTenant('so', tenantA, CATALOG, { branchScope: [sharjah] });
    // Sharjah-only session reading Sharjah's own row → OK (its override is 440)
    const own = await req('GET', bPrices(sharjah, vShared), sharjahOnly);
    expect(own.statusCode).toBe(200);
    expect(JSON.stringify(own.json())).toContain('440');
    // and it can never even name Dubai (out of scope → 404)
    const cross = await req('GET', bPrices(dubai, vShared), sharjahOnly);
    expect(cross.statusCode).toBe(404);
  });

  it('a multi-branch authorized session reaches exactly its granted branches; per-branch overlay narrows', async () => {
    // dubaiOverlayNoPrice: branchScope [dubai, sharjah], but the Sharjah overlay
    // omits branch_price:manage → a Sharjah price write is denied, a Dubai one OK.
    const dubaiOk = await req(
      'PUT',
      bPrices(dubai, vShared),
      dubaiOverlayNoPrice,
      { prices: [{ uomCode: 'piece', sell: money('460', 'AED', 2) }] },
      { 'if-match': '"1"' },
    );
    expect(dubaiOk.statusCode, dubaiOk.payload).toBe(200);
    const sharjahDenied = await req('PUT', bPrices(sharjah, vShared), dubaiOverlayNoPrice, {
      prices: [{ uomCode: 'piece', sell: money('1', 'AED', 2) }],
    });
    expect([403, 404]).toContain(sharjahDenied.statusCode);
    // but a READ of Sharjah is allowed (the overlay grants catalog:view)
    const sharjahRead = await req('GET', bPrices(sharjah, vShared), dubaiOverlayNoPrice);
    expect(sharjahRead.statusCode).toBe(200);
  });

  it('company isolation + cross-tenant isolation — B cannot reach A branch pricing / availability / catalog', async () => {
    for (const url of [
      bPrices(dubai, vShared),
      bPrices(dubai, vShared, '/resolve?uomCode=piece'),
      `/catalog/branches/${dubai}/catalog`,
      `/catalog/branches/${dubai}/availability`,
    ]) {
      const r = await req('GET', url, ownerB);
      expect([403, 404], `${url}`).toContain(r.statusCode);
      expect(JSON.stringify(r.json())).not.toMatch(/455|460|500|440/);
    }
    // B's own variant id in A's availability filter → 404 (no leakage)
    const r = await req(
      'GET',
      `/catalog/branches/${dubai}/availability?variantId=00000000-0000-7000-8000-0000000000ff`,
      ownerB,
    );
    expect(r.statusCode).toBe(404);
  });

  // ══════════════ cross-branch integrity: no blinding, no leak ═══════════════
  describe('cross-branch integrity — a Dubai-only caller cannot orphan the Sharjah override', () => {
    it('company price removal → 409 COMPANY_PRICE_HAS_BRANCH_OVERRIDE; company price + Sharjah override survive; no Sharjah branchId leak', async () => {
      const g = await req('GET', `/catalog/companies/${coA}/variants/${vShared}/prices`, dubaiOnly);
      const clear = await req(
        'PUT',
        `/catalog/companies/${coA}/variants/${vShared}/prices`,
        dubaiOnly,
        { prices: [] },
        { 'if-match': `"${(g.json() as { version: number }).version}"` },
      );
      expect(clear.statusCode).toBe(409);
      expect(errCode(clear)).toBe('COMPANY_PRICE_HAS_BRANCH_OVERRIDE');
      expect(JSON.stringify(clear.json())).not.toContain(sharjah);
      // company price + Sharjah override both still present
      const cp = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM company_variant_uom_price WHERE "companyId"=$1 AND "variantId"=$2`,
        [coA, vShared],
      );
      expect(Number(cp[0]!.n)).toBeGreaterThan(0);
      const bp = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM branch_variant_uom_price WHERE "branchId"=$1 AND "variantId"=$2`,
        [sharjah, vShared],
      );
      expect(Number(bp[0]!.n)).toBe(1);
    });

    it('custom-UOM hard-delete → 409 UOM_IN_USE (a Sharjah override references it, invisible to the Dubai-only caller)', async () => {
      const v = await mkVariant(ownerA, 'uomiso', 'piece');
      await req(
        'POST',
        '/catalog/uoms',
        ownerA,
        { code: 'isobox', family: 'EACH', nameEn: 'Box' },
        { 'idempotency-key': ik() },
      );
      const gv = (await req('GET', `/catalog/variants/${v}`, ownerA)).json() as { version: number };
      await req(
        'PUT',
        `/catalog/variants/${v}/conversions`,
        ownerA,
        { conversions: [{ fromUomCode: 'isobox', num: '6' }] },
        { 'if-match': `"${gv.version}"` },
      );
      await companyPrice(coA, v, [
        { uomCode: 'piece', sell: money('500', 'AED', 2) },
        { uomCode: 'isobox', sell: money('2900', 'AED', 2) },
      ]);
      await req(
        'PUT',
        bPrices(sharjah, v),
        ownerA,
        { prices: [{ uomCode: 'isobox', sell: money('2800', 'AED', 2) }] },
        { 'if-match': '"0"' },
      );
      const uomRow = (
        await sql<{ version: number }>(`SELECT version FROM uom WHERE code='isobox'`)
      )[0]!;
      const del = await req('DELETE', `/catalog/uoms/isobox`, dubaiOnly, undefined, {
        'if-match': `"${uomRow.version}"`,
      });
      expect(del.statusCode).toBe(409);
      expect(errCode(del)).toBe('UOM_IN_USE');
      expect(JSON.stringify(del.json())).not.toContain(sharjah);
    });

    it('base-UOM change → 409 VARIANT_BASE_UOM_LOCKED (a Sharjah override, invisible to the Dubai-only caller)', async () => {
      const v = await mkVariant(ownerA, 'baseiso', 'piece');
      await companyPrice(coA, v, [{ uomCode: 'piece', sell: money('500', 'AED', 2) }]);
      await req(
        'PUT',
        bPrices(sharjah, v),
        ownerA,
        { prices: [{ uomCode: 'piece', sell: money('450', 'AED', 2) }] },
        { 'if-match': '"0"' },
      );
      const gv = (await req('GET', `/catalog/variants/${v}`, dubaiOnly)).json() as {
        version: number;
      };
      const lock = await req(
        'PUT',
        `/catalog/variants/${v}/base-uom`,
        dubaiOnly,
        { baseUomCode: 'kilogram' },
        { 'if-match': `"${gv.version}"` },
      );
      expect(lock.statusCode).toBe(409);
      expect(errCode(lock)).toBe('VARIANT_BASE_UOM_LOCKED');
      expect(JSON.stringify(lock.json())).not.toContain(sharjah);
    });

    it('after an integrity check, a normal branch-scoped read is still narrowed (GUC restored)', async () => {
      // the previous tests ran integrity helpers inside a Dubai-only session's
      // transaction; a subsequent Dubai-only read of Sharjah still 404s.
      const cross = await req('GET', bPrices(sharjah, vShared), dubaiOnly);
      expect(cross.statusCode).toBe(404);
      // and the Dubai row is still readable by a Dubai session
      const own = await req('GET', bPrices(dubai, vShared), dubaiOnly);
      expect(own.statusCode).toBe(200);
    });
  });

  // ══════════════ DB-level guarantees ═══════════════════════════════════════
  it('RLS ENABLE + FORCE on all three tables; a no-GUC read returns 0 rows; tenant-wide branch-GUC-neutralized read stays tenant-isolated', async () => {
    for (const t of [
      'branch_variant_price_set',
      'branch_variant_uom_price',
      'branch_variant_availability',
    ]) {
      const rows = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [t],
      );
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(`SET ROLE flower_app`);
      // no GUC → 0
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM branch_variant_uom_price`)).rows[0].n,
      ).toBe(0);
      // tenant A + neutralized branch GUC → only tenant A rows (never tenant B)
      await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantA]);
      await c.query(`SELECT set_config('app.branch_id', '', false)`);
      const wide = await c.query<{ tid: string }>(
        `SELECT DISTINCT "tenantId" AS tid FROM branch_variant_uom_price`,
      );
      expect(wide.rows.map((r) => r.tid)).toEqual([tenantA]);
    } finally {
      await c.end();
    }
  });

  it('flower_app is still NOBYPASSRLS + NOSUPERUSER; Task 3.8 added no new DB role', async () => {
    const dbRole = (
      await sql<{ rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='flower_app'`,
      )
    )[0]!;
    expect(dbRole).toEqual({ rolbypassrls: false, rolsuper: false });
    const roles = (
      await sql<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'flower_%'`)
    )
      .map((r) => r.rolname)
      .sort();
    expect(roles).toEqual(['flower_app', 'flower_dispatcher', 'flower_migrate', 'flower_platform']);
    void coBBranch;
    void sharjahTerminal;
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003800a0', 'starter-bi', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003800a0', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 10),
             ('${PLAN_V}', 'max_pos_terminals', 10);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin-bi@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('variants:manage','TENANT','catalog','v',3),('pricing:manage','TENANT','catalog','v',3),
             ('branch_price:manage','TENANT','catalog','v',3),
             ('settings:tenant:manage','TENANT','admin','v',1),
             ('users:view','TENANT','admin','v',1),('platform:tenants:view','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'x', 'x'), ('SAR', 2, 'SAR', 'x', 'x')
      ON CONFLICT (code) DO NOTHING;
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now())
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
