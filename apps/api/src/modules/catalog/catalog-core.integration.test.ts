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

const PLAN_V = '00000000-0000-7000-8000-000000320001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000320002';
const CATALOG_MANAGE = ['catalog:view', 'catalog:manage'];

/**
 * Task 3.2 — Generic Catalog Core (Category / Product Type / Product).
 * Covers: RLS + tenant isolation, capability + entitlement enforcement (the
 * first consumer of `CatalogCapabilityService`), Business-Type non-branching,
 * category hierarchy, product lifecycle + DRAFT-only strategy change,
 * optimistic concurrency, idempotency, audit, security-event narrowing, the
 * permission model + the built-in system-role backfill.
 */
describe('generic catalog core (task 3.2, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let superTok = '';
  let tenantA = '';
  let tenantC = '';
  let ownerA = '';
  let ownerC = '';
  let viewerA = '';

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
    // two tenants with DIFFERENT business types — used to prove no runtime branch
    tenantA = await provision('cat-a', 'CUSTOM');
    tenantC = await provision('cat-c', 'BAKERY_CAKE');

    // give BOTH tenants an identical capability set (so a behaviour difference
    // could only come from a business-type branch — HG3-NO-BT-BRANCH).
    for (const t of [tenantA, tenantC]) {
      await setCaps(t, {
        'strategy.stocked': true,
        'strategy.bom': true,
        'strategy.custom': true,
      });
    }

    ownerA = await mintTenant(
      'oa',
      tenantA,
      [...CATALOG_MANAGE],
      ['production_bom', 'custom_composition'],
    );
    ownerC = await mintTenant(
      'oc',
      tenantC,
      [...CATALOG_MANAGE],
      ['production_bom', 'custom_composition'],
    );
    viewerA = await mintTenant('va', tenantA, ['catalog:view'], []);
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
    entitledModules: string[],
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
    s.access = {
      effectivePermissions: perms,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules,
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

  async function provision(slug: string, businessTypeKey: string): Promise<string> {
    const res = await req(
      'POST',
      '/platform/tenants',
      superTok,
      {
        slug,
        name: slug,
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey,
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

  /** Arrange a tenant's catalog-capability rows directly (superuser bypasses
   *  RLS). The capability *write* path is task 3.1's concern — here we only need
   *  arranged state to test task 3.2's *enforcement*. */
  async function setCaps(tenantId: string, caps: Record<string, boolean>): Promise<void> {
    for (const [k, enabled] of Object.entries(caps)) {
      await sql(
        `INSERT INTO tenant_catalog_capability ("tenantId","capabilityKey",enabled,"sourceKind","updatedAt")
         VALUES ($1,$2,$3,'MANUAL',now())
         ON CONFLICT ("tenantId","capabilityKey") DO UPDATE SET enabled = EXCLUDED.enabled`,
        [tenantId, k, enabled],
      );
    }
  }

  const auditRows = (tenantId: string, action: string): Promise<number> =>
    count(`SELECT count(*)::int AS n FROM audit_log WHERE "tenantId"=$1 AND action=$2`, [
      tenantId,
      action,
    ]);

  let idemN = 0;
  const ik = (): string => `ct32-auto-${++idemN}`;

  /** create an ACTIVE root category, return its id + version. */
  async function makeCategory(
    token: string,
    slug: string,
    parentId?: string,
  ): Promise<{ id: string; version: number }> {
    const res = await req(
      'POST',
      '/catalog/categories',
      token,
      { slug, nameEn: slug, ...(parentId ? { parentId } : {}) },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    const b = res.json() as { id: string; version: number };
    return { id: b.id, version: b.version };
  }

  // ═══════════════════ capability + entitlement enforcement ══════════════════
  describe('fulfilment-strategy capability + entitlement gate (owner §5/§6)', () => {
    it('STOCKED: rejected 409 CAPABILITY_NOT_ENABLED when disabled; 201 once enabled', async () => {
      const t = await provision('cap-stk', 'CUSTOM');
      await setCaps(t, { 'strategy.stocked': false });
      const tok = await mintTenant('cs', t, [...CATALOG_MANAGE], []);
      const cat = await req(
        'POST',
        '/catalog/categories',
        tok,
        { slug: 'c', nameEn: 'C' },
        { 'idempotency-key': 'catalog32-k1' },
      );
      const categoryId = (cat.json() as { id: string }).id;

      const denied = await req(
        'POST',
        '/catalog/products',
        tok,
        { categoryId, nameEn: 'P', slug: 'p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-p1' },
      );
      expect(denied.statusCode).toBe(409);
      expect((denied.json() as { error: { code: string } }).error.code).toBe(
        'CAPABILITY_NOT_ENABLED',
      );
      expect(await count(`SELECT count(*)::int AS n FROM product WHERE "tenantId"=$1`, [t])).toBe(
        0,
      );

      await setCaps(t, { 'strategy.stocked': true });
      const ok = await req(
        'POST',
        '/catalog/products',
        tok,
        { categoryId, nameEn: 'P', slug: 'p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-p2' },
      );
      expect(ok.statusCode, ok.payload).toBe(201);
      // enabling the capability did NOT write a capability row through the product path
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_catalog_capability WHERE "tenantId"=$1`,
          [t],
        ),
      ).toBe(1);
    });

    it('BOM: needs strategy.bom (409) AND production_bom entitlement (403); both -> 201', async () => {
      const t = await provision('cap-bom', 'CUSTOM');
      await setCaps(t, { 'strategy.stocked': true, 'strategy.bom': false });
      const cat = (
        await sql<{ id: string }>(
          `INSERT INTO category ("tenantId",slug,"nameEn","updatedAt") VALUES ($1,'c','C',now()) RETURNING id`,
          [t],
        )
      )[0]!.id;

      const noCap = await mintTenant('cb1', t, [...CATALOG_MANAGE], ['production_bom']);
      const r1 = await req(
        'POST',
        '/catalog/products',
        noCap,
        { categoryId: cat, nameEn: 'B', slug: 'b1', fulfilmentStrategy: 'BOM' },
        { 'idempotency-key': 'catalog32-b1' },
      );
      expect(r1.statusCode).toBe(409);
      expect((r1.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_ENABLED');

      await setCaps(t, { 'strategy.bom': true });
      const noEnt = await mintTenant('cb2', t, [...CATALOG_MANAGE], []);
      const r2 = await req(
        'POST',
        '/catalog/products',
        noEnt,
        { categoryId: cat, nameEn: 'B', slug: 'b2', fulfilmentStrategy: 'BOM' },
        { 'idempotency-key': 'catalog32-b2' },
      );
      expect(r2.statusCode).toBe(403);
      expect((r2.json() as { error: { code: string } }).error.code).toBe('MODULE_NOT_ENTITLED');

      const full = await mintTenant('cb3', t, [...CATALOG_MANAGE], ['production_bom']);
      const r3 = await req(
        'POST',
        '/catalog/products',
        full,
        { categoryId: cat, nameEn: 'B', slug: 'b3', fulfilmentStrategy: 'BOM' },
        { 'idempotency-key': 'catalog32-b3' },
      );
      expect(r3.statusCode, r3.payload).toBe(201);
    });

    it('CUSTOM: needs strategy.custom (409) AND custom_composition entitlement (403)', async () => {
      const t = await provision('cap-cus', 'CUSTOM');
      await setCaps(t, { 'strategy.stocked': true, 'strategy.custom': true });
      const cat = (
        await sql<{ id: string }>(
          `INSERT INTO category ("tenantId",slug,"nameEn","updatedAt") VALUES ($1,'c','C',now()) RETURNING id`,
          [t],
        )
      )[0]!.id;
      const noEnt = await mintTenant('cc1', t, [...CATALOG_MANAGE], []);
      const r = await req(
        'POST',
        '/catalog/products',
        noEnt,
        { categoryId: cat, nameEn: 'X', slug: 'x', fulfilmentStrategy: 'CUSTOM' },
        { 'idempotency-key': 'catalog32-c1' },
      );
      expect(r.statusCode).toBe(403);
      expect((r.json() as { error: { code: string } }).error.code).toBe('MODULE_NOT_ENTITLED');

      const withEnt = await mintTenant('cc2', t, [...CATALOG_MANAGE], ['custom_composition']);
      const ok = await req(
        'POST',
        '/catalog/products',
        withEnt,
        { categoryId: cat, nameEn: 'X', slug: 'x', fulfilmentStrategy: 'CUSTOM' },
        { 'idempotency-key': 'catalog32-c2' },
      );
      expect(ok.statusCode, ok.payload).toBe(201);
    });

    it('Business Type does NOT alter behaviour: two tenants, different businessTypeKey, identical caps -> identical results', async () => {
      const btA = (
        await sql<{ k: string }>(`SELECT "businessTypeKey" AS k FROM tenant WHERE id=$1`, [tenantA])
      )[0]!.k;
      const btC = (
        await sql<{ k: string }>(`SELECT "businessTypeKey" AS k FROM tenant WHERE id=$1`, [tenantC])
      )[0]!.k;
      expect(btA).not.toBe(btC);

      const catA = await makeCategory(ownerA, 'bt-neutral-a');
      const catC = await makeCategory(ownerC, 'bt-neutral-c');
      const pA = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: catA.id, nameEn: 'N', slug: 'bt-a', fulfilmentStrategy: 'BOM' },
        { 'idempotency-key': 'catalog32-bta' },
      );
      const pC = await req(
        'POST',
        '/catalog/products',
        ownerC,
        { categoryId: catC.id, nameEn: 'N', slug: 'bt-c', fulfilmentStrategy: 'BOM' },
        { 'idempotency-key': 'catalog32-btc' },
      );
      expect(pA.statusCode).toBe(201);
      expect(pC.statusCode).toBe(pA.statusCode);
      expect((pC.json() as { fulfilmentStrategy: string }).fulfilmentStrategy).toBe(
        (pA.json() as { fulfilmentStrategy: string }).fulfilmentStrategy,
      );
    });
  });

  // ═══════════════════════ category hierarchy (owner §3) ═════════════════════
  describe('category hierarchy', () => {
    it('sibling-slug + root-slug uniqueness -> 409', async () => {
      await makeCategory(ownerA, 'uniq-root');
      const dup = await req(
        'POST',
        '/catalog/categories',
        ownerA,
        { slug: 'uniq-root', nameEn: 'x' },
        { 'idempotency-key': 'catalog32-dup1' },
      );
      expect(dup.statusCode).toBe(409);
      expect((dup.json() as { error: { code: string } }).error.code).toBe('CATEGORY_SLUG_TAKEN');
    });

    it('self-parent, cycle, depth > 5, archived-parent are all rejected', async () => {
      const l1 = await makeCategory(ownerA, 'd1');
      const l2 = await makeCategory(ownerA, 'd2', l1.id);
      const l3 = await makeCategory(ownerA, 'd3', l2.id);
      const l4 = await makeCategory(ownerA, 'd4', l3.id);
      const l5 = await makeCategory(ownerA, 'd5', l4.id);

      // depth 6 -> rejected
      const tooDeep = await req(
        'POST',
        '/catalog/categories',
        ownerA,
        { slug: 'd6', nameEn: 'd6', parentId: l5.id },
        { 'idempotency-key': 'catalog32-d6' },
      );
      expect(tooDeep.statusCode).toBe(409);
      expect((tooDeep.json() as { error: { code: string } }).error.code).toBe('CATEGORY_TOO_DEEP');

      // self-parent
      const selfP = await req(
        'PUT',
        `/catalog/categories/${l2.id}`,
        ownerA,
        { parentId: l2.id },
        { 'if-match': `"${l2.version}"` },
      );
      expect(selfP.statusCode).toBe(409);
      expect((selfP.json() as { error: { code: string } }).error.code).toBe('CATEGORY_CYCLE');

      // cycle: move l1 under l3 (its own descendant)
      const cyc = await req(
        'PUT',
        `/catalog/categories/${l1.id}`,
        ownerA,
        { parentId: l3.id },
        { 'if-match': `"${l1.version}"` },
      );
      expect(cyc.statusCode).toBe(409);
      expect((cyc.json() as { error: { code: string } }).error.code).toBe('CATEGORY_CYCLE');

      // archived parent blocks a new child
      const arch = await req('POST', `/catalog/categories/${l5.id}/archive`, ownerA, undefined, {
        'idempotency-key': 'catalog32-arch-d5',
        'if-match': `"${l5.version}"`,
      });
      expect(arch.statusCode).toBe(200);
      const childUnderArchived = await req(
        'POST',
        '/catalog/categories',
        ownerA,
        { slug: 'x', nameEn: 'x', parentId: l5.id },
        { 'idempotency-key': 'catalog32-x-under-arch' },
      );
      expect(childUnderArchived.statusCode).toBe(409);
      expect((childUnderArchived.json() as { error: { code: string } }).error.code).toBe(
        'CATEGORY_PARENT_ARCHIVED',
      );
    });

    it('archive does not cascade; a category may hold children AND products at once', async () => {
      const parent = await makeCategory(ownerA, 'mix-parent');
      const child = await makeCategory(ownerA, 'mix-child', parent.id);
      const pres = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: parent.id, nameEn: 'P', slug: 'mix-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-mix-p' },
      );
      expect(pres.statusCode).toBe(201);

      const arch = await req(
        'POST',
        `/catalog/categories/${parent.id}/archive`,
        ownerA,
        undefined,
        { 'idempotency-key': 'catalog32-arch-parent', 'if-match': `"${parent.version}"` },
      );
      expect(arch.statusCode).toBe(200);
      // child stays ACTIVE (no cascade)
      const childRow = await req('GET', `/catalog/categories/${child.id}`, ownerA);
      expect((childRow.json() as { status: string }).status).toBe('ACTIVE');
    });
  });

  // ═══════════════════════ product lifecycle + concurrency ═══════════════════
  describe('product lifecycle, strategy mutability, concurrency (owner §5/§7/§12/§14)', () => {
    it('DRAFT -> ACTIVE -> ARCHIVED -> ACTIVE; ACTIVE -> DRAFT is not offered', async () => {
      const cat = await makeCategory(ownerA, 'lc-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'lc-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-lc-p' },
      );
      const id = (p.json() as { id: string }).id;
      let v = (p.json() as { version: number }).version;
      expect((p.json() as { status: string }).status).toBe('DRAFT');

      const act = await req('POST', `/catalog/products/${id}/activate`, ownerA, undefined, {
        'idempotency-key': 'catalog32-lc-act',
        'if-match': `"${v}"`,
      });
      expect(act.statusCode).toBe(200);
      expect((act.json() as { status: string }).status).toBe('ACTIVE');
      v = (act.json() as { version: number }).version;

      // "ACTIVE" is catalog-active only — no price / variant / availability gate
      // was consulted to get here (owner §7).

      const arch = await req('POST', `/catalog/products/${id}/archive`, ownerA, undefined, {
        'idempotency-key': 'catalog32-lc-arch',
        'if-match': `"${v}"`,
      });
      expect(arch.statusCode).toBe(200);
      expect((arch.json() as { status: string }).status).toBe('ARCHIVED');
      v = (arch.json() as { version: number }).version;

      const react = await req('POST', `/catalog/products/${id}/activate`, ownerA, undefined, {
        'idempotency-key': 'catalog32-lc-react',
        'if-match': `"${v}"`,
      });
      expect(react.statusCode).toBe(200);
      expect((react.json() as { status: string }).status).toBe('ACTIVE');
    });

    it('DRAFT strategy change is allowed + re-checked; ACTIVE strategy change -> 409 PRODUCT_STRATEGY_LOCKED', async () => {
      const cat = await makeCategory(ownerA, 'sc-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'sc-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-sc-p' },
      );
      const id = (p.json() as { id: string }).id;
      let v = (p.json() as { version: number }).version;

      // DRAFT: STOCKED -> BOM allowed (owner has production_bom + strategy.bom enabled)
      const chg = await req(
        'PUT',
        `/catalog/products/${id}`,
        ownerA,
        { fulfilmentStrategy: 'BOM' },
        { 'if-match': `"${v}"` },
      );
      expect(chg.statusCode, chg.payload).toBe(200);
      expect((chg.json() as { fulfilmentStrategy: string }).fulfilmentStrategy).toBe('BOM');
      v = (chg.json() as { version: number }).version;

      // activate, then a strategy change is locked
      const act = await req('POST', `/catalog/products/${id}/activate`, ownerA, undefined, {
        'idempotency-key': 'catalog32-sc-act',
        'if-match': `"${v}"`,
      });
      v = (act.json() as { version: number }).version;
      const locked = await req(
        'PUT',
        `/catalog/products/${id}`,
        ownerA,
        { fulfilmentStrategy: 'CUSTOM' },
        { 'if-match': `"${v}"` },
      );
      expect(locked.statusCode).toBe(409);
      expect((locked.json() as { error: { code: string } }).error.code).toBe(
        'PRODUCT_STRATEGY_LOCKED',
      );
    });

    it('DRAFT strategy change to a disabled strategy is re-checked -> 409', async () => {
      const t = await provision('sc-recheck', 'CUSTOM');
      await setCaps(t, { 'strategy.stocked': true, 'strategy.bom': false });
      const tok = await mintTenant('scr', t, [...CATALOG_MANAGE], ['production_bom']);
      const cat = (
        await sql<{ id: string }>(
          `INSERT INTO category ("tenantId",slug,"nameEn","updatedAt") VALUES ($1,'c','C',now()) RETURNING id`,
          [t],
        )
      )[0]!.id;
      const p = await req(
        'POST',
        '/catalog/products',
        tok,
        { categoryId: cat, nameEn: 'P', slug: 'p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-p' },
      );
      const id = (p.json() as { id: string }).id;
      const v = (p.json() as { version: number }).version;
      const chg = await req(
        'PUT',
        `/catalog/products/${id}`,
        tok,
        { fulfilmentStrategy: 'BOM' },
        { 'if-match': `"${v}"` },
      );
      expect(chg.statusCode).toBe(409);
      expect((chg.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_ENABLED');
    });

    it('hard delete: only a DRAFT product; ACTIVE -> 409; correct If-Match required', async () => {
      const cat = await makeCategory(ownerA, 'del-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'del-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-del-p' },
      );
      const id = (p.json() as { id: string }).id;
      const v = (p.json() as { version: number }).version;

      // wrong If-Match -> 409, still there
      const stale = await req('DELETE', `/catalog/products/${id}`, ownerA, undefined, {
        'if-match': `"${v + 9}"`,
      });
      expect(stale.statusCode).toBe(409);
      // missing If-Match -> 428
      const noIf = await req('DELETE', `/catalog/products/${id}`, ownerA);
      expect(noIf.statusCode).toBe(428);

      // activate then try to delete -> 409 PRODUCT_NOT_DELETABLE
      const act = await req('POST', `/catalog/products/${id}/activate`, ownerA, undefined, {
        'idempotency-key': 'catalog32-del-act',
        'if-match': `"${v}"`,
      });
      const v2 = (act.json() as { version: number }).version;
      const badDelete = await req('DELETE', `/catalog/products/${id}`, ownerA, undefined, {
        'if-match': `"${v2}"`,
      });
      expect(badDelete.statusCode).toBe(409);
      expect((badDelete.json() as { error: { code: string } }).error.code).toBe(
        'PRODUCT_NOT_DELETABLE',
      );
    });

    it('stale If-Match on PUT -> 409, no write, version unchanged, no audit row', async () => {
      const cat = await makeCategory(ownerA, 'cc-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'cc-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-cc-p' },
      );
      const id = (p.json() as { id: string }).id;
      const before = await auditRows(tenantA, 'catalog.product_updated');

      const bad = await req(
        'PUT',
        `/catalog/products/${id}`,
        ownerA,
        { nameEn: 'nope' },
        { 'if-match': '"999"' },
      );
      expect(bad.statusCode).toBe(409);
      const row = await req('GET', `/catalog/products/${id}`, ownerA);
      expect(row.json() as { nameEn: string; version: number }).toMatchObject({
        nameEn: 'P',
        version: 1,
      });
      expect(await auditRows(tenantA, 'catalog.product_updated')).toBe(before);
    });

    it('two concurrent PUTs with the same If-Match: one 200, one 409', async () => {
      const cat = await makeCategory(ownerA, 'race-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'race-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-race-p' },
      );
      const id = (p.json() as { id: string }).id;
      const v = (p.json() as { version: number }).version;
      const [r1, r2] = await Promise.all([
        req('PUT', `/catalog/products/${id}`, ownerA, { nameEn: 'A' }, { 'if-match': `"${v}"` }),
        req('PUT', `/catalog/products/${id}`, ownerA, { nameEn: 'B' }, { 'if-match': `"${v}"` }),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]);
    });

    it('PUT without If-Match -> 428 PRECONDITION_REQUIRED', async () => {
      const cat = await makeCategory(ownerA, 'pre-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'pre-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-pre-p' },
      );
      const id = (p.json() as { id: string }).id;
      const res = await req('PUT', `/catalog/products/${id}`, ownerA, { nameEn: 'x' });
      expect(res.statusCode).toBe(428);
    });
  });

  // ═══════════════════════ idempotency (owner §14) ══════════════════════════
  describe('idempotency', () => {
    it('replayed POST create returns the stored 2xx; a different body + same key -> 409', async () => {
      const cat = await makeCategory(ownerA, 'idem-cat');
      const body = {
        categoryId: cat.id,
        nameEn: 'P',
        slug: 'idem-p',
        fulfilmentStrategy: 'STOCKED',
      };
      const a = await req('POST', '/catalog/products', ownerA, body, {
        'idempotency-key': 'catalog32-idem-create-1',
      });
      const b = await req('POST', '/catalog/products', ownerA, body, {
        'idempotency-key': 'catalog32-idem-create-1',
      });
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect((b.json() as { id: string }).id).toBe((a.json() as { id: string }).id);
      expect(b.headers['idempotency-replayed']).toBe('true');

      const c = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { ...body, slug: 'different' },
        { 'idempotency-key': 'catalog32-idem-create-1' },
      );
      expect(c.statusCode).toBe(409);
    });

    it('lifecycle command replay (same key + same If-Match) is idempotent; stale version -> 409, no extra audit', async () => {
      const cat = await makeCategory(ownerA, 'idem-lc-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'idem-lc-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-idem-lc-p' },
      );
      const id = (p.json() as { id: string }).id;
      const v = (p.json() as { version: number }).version;
      const beforeAudit = await auditRows(tenantA, 'catalog.product_status_changed');

      const a1 = await req('POST', `/catalog/products/${id}/activate`, ownerA, undefined, {
        'idempotency-key': 'catalog32-idem-act',
        'if-match': `"${v}"`,
      });
      const a2 = await req('POST', `/catalog/products/${id}/activate`, ownerA, undefined, {
        'idempotency-key': 'catalog32-idem-act',
        'if-match': `"${v}"`,
      });
      expect(a1.statusCode).toBe(200);
      expect(a2.statusCode).toBe(200);
      expect(a2.headers['idempotency-replayed']).toBe('true');
      // exactly one status-change audit row was written
      expect(await auditRows(tenantA, 'catalog.product_status_changed')).toBe(beforeAudit + 1);

      // a fresh key with a now-stale If-Match -> 409, and NO extra audit row
      const stale = await req('POST', `/catalog/products/${id}/archive`, ownerA, undefined, {
        'idempotency-key': 'catalog32-idem-arch-stale',
        'if-match': `"${v}"`,
      });
      expect(stale.statusCode).toBe(409);
      expect(await auditRows(tenantA, 'catalog.product_status_changed')).toBe(beforeAudit + 1);
    });
  });

  // ═══════════════════════ tenant isolation ════════════════════════════════
  describe('tenant isolation (HG3-TENANT-ISOLATION)', () => {
    it('tenant C cannot read / update / archive / delete tenant A resources; lists + search never leak', async () => {
      const cat = await makeCategory(ownerA, 'iso-cat');
      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'SECRET-A', slug: 'iso-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-iso-p' },
      );
      const pid = (p.json() as { id: string }).id;

      expect((await req('GET', `/catalog/products/${pid}`, ownerC)).statusCode).toBe(404);
      expect((await req('GET', `/catalog/categories/${cat.id}`, ownerC)).statusCode).toBe(404);
      expect(
        (
          await req(
            'PUT',
            `/catalog/products/${pid}`,
            ownerC,
            { nameEn: 'pwn' },
            { 'if-match': '"1"' },
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (await req('DELETE', `/catalog/products/${pid}`, ownerC, undefined, { 'if-match': '"1"' }))
          .statusCode,
      ).toBe(404);

      const list = await req('GET', '/catalog/products?q=SECRET-A', ownerC);
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).not.toContain('SECRET-A');
      expect(JSON.stringify(list.json())).not.toContain(pid);
    });

    it('a product create referencing another tenant’s category -> 404 (DB tenant-safe FK is the backstop)', async () => {
      const catA = await makeCategory(ownerA, 'xref-cat');
      const res = await req(
        'POST',
        '/catalog/products',
        ownerC,
        { categoryId: catA.id, nameEn: 'P', slug: 'xref-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-xref-p' },
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════ permissions + backfill ══════════════════════════
  describe('permission model + system-role backfill (owner R-1)', () => {
    it('catalog:view-only cannot write; no token / no permission -> 403', async () => {
      const cat = await makeCategory(ownerA, 'perm-cat');
      expect((await req('GET', '/catalog/categories', viewerA)).statusCode).toBe(200);
      const w = await req(
        'POST',
        '/catalog/categories',
        viewerA,
        { slug: 'nope', nameEn: 'x' },
        { 'idempotency-key': 'catalog32-perm-w' },
      );
      expect(w.statusCode).toBe(403);
      const w2 = await req(
        'PUT',
        `/catalog/categories/${cat.id}`,
        viewerA,
        { nameEn: 'x' },
        { 'if-match': `"${cat.version}"` },
      );
      expect(w2.statusCode).toBe(403);
    });

    it('a freshly-provisioned tenant: owner + admin roles carry catalog:view + catalog:manage; manager only catalog:view', async () => {
      const rows = await sql<{ key: string; perms: string[] }>(
        `SELECT r.key, array_agg(rp."permissionKey" ORDER BY rp."permissionKey") AS perms
           FROM role r JOIN role_permission rp ON rp."roleId" = r.id
          WHERE r."tenantId" = $1 AND r."isSystem" = true AND r.key IN ('owner','admin','manager')
          GROUP BY r.key`,
        [tenantA],
      );
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.perms]));
      expect(byKey['owner']).toEqual(expect.arrayContaining(['catalog:manage', 'catalog:view']));
      expect(byKey['admin']).toEqual(expect.arrayContaining(['catalog:manage', 'catalog:view']));
      expect(byKey['manager']).toContain('catalog:view');
      expect(byKey['manager']).not.toContain('catalog:manage');
    });
  });

  // ═══════════════════════ audit + security_event ══════════════════════════
  describe('audit (D2-10) + security_event narrowing (owner §15/§16)', () => {
    it('each successful mutation writes exactly one registered audit row; catalog CRUD is not a security event', async () => {
      const cat = await makeCategory(ownerA, 'aud-cat');
      const created = await auditRows(tenantA, 'catalog.category_created');
      expect(created).toBeGreaterThanOrEqual(1);

      const p = await req(
        'POST',
        '/catalog/products',
        ownerA,
        { categoryId: cat.id, nameEn: 'P', slug: 'aud-p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-aud-p' },
      );
      expect(await auditRows(tenantA, 'catalog.product_created')).toBeGreaterThanOrEqual(1);
      const id = (p.json() as { id: string }).id;
      const v = (p.json() as { version: number }).version;
      await req(
        'PUT',
        `/catalog/products/${id}`,
        ownerA,
        { nameEn: 'renamed' },
        { 'if-match': `"${v}"` },
      );
      expect(await auditRows(tenantA, 'catalog.product_updated')).toBeGreaterThanOrEqual(1);

      // security_event: contains the provisioning template_applied, NOT catalog CRUD
      const sec = await sql<{ kind: string }>(
        `SELECT kind FROM security_event WHERE "tenantId" = $1`,
        [tenantA],
      );
      const kinds = new Set(sec.map((r) => r.kind));
      expect(kinds.has('catalog.template_applied')).toBe(true);
      expect(kinds.has('catalog.category_created')).toBe(false);
      expect(kinds.has('catalog.product_created')).toBe(false);
      expect(kinds.has('catalog.product_updated')).toBe(false);
    });

    it('a rolled-back create (capability denied) writes no audit row', async () => {
      const t = await provision('aud-rb', 'CUSTOM');
      await setCaps(t, { 'strategy.stocked': false });
      const tok = await mintTenant('arb', t, [...CATALOG_MANAGE], []);
      const cat = (
        await sql<{ id: string }>(
          `INSERT INTO category ("tenantId",slug,"nameEn","updatedAt") VALUES ($1,'c','C',now()) RETURNING id`,
          [t],
        )
      )[0]!.id;
      const r = await req(
        'POST',
        '/catalog/products',
        tok,
        { categoryId: cat, nameEn: 'P', slug: 'p', fulfilmentStrategy: 'STOCKED' },
        { 'idempotency-key': 'catalog32-p' },
      );
      expect(r.statusCode).toBe(409);
      expect(await auditRows(t, 'catalog.product_created')).toBe(0);
    });
  });

  // ═══════════════════════ product type genericity ═════════════════════════
  describe('product type — generic classification, no behaviour (owner §4/§10)', () => {
    it('arbitrary tenant keys are accepted; there is no behaviour column or enforcement', async () => {
      for (const key of ['CUT_FLOWER', 'FRAGRANCE', 'FOOD_ITEM', 'WIDGET']) {
        const r = await req(
          'POST',
          '/catalog/product-types',
          ownerA,
          { key, nameEn: key },
          { 'idempotency-key': `pt-${key}` },
        );
        expect(r.statusCode, r.payload).toBe(201);
      }
      // a product with a product type still needs its OWN strategy capability —
      // the product type contributes nothing to that decision.
      const pt = (await req('GET', '/catalog/product-types?status=ACTIVE', ownerA)).json() as {
        id: string;
        key: string;
      }[];
      const widget = pt.find((x) => x.key === 'WIDGET')!;
      const cat = await makeCategory(ownerA, 'pt-cat');
      const ok = await req(
        'POST',
        '/catalog/products',
        ownerA,
        {
          categoryId: cat.id,
          productTypeId: widget.id,
          nameEn: 'P',
          slug: 'pt-p',
          fulfilmentStrategy: 'STOCKED',
        },
        { 'idempotency-key': 'catalog32-pt-p' },
      );
      expect(ok.statusCode, ok.payload).toBe(201);

      const cols = await sql<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'product_type'`,
      );
      expect(cols.map((c) => c.column_name)).not.toContain('defaultFulfilmentStrategy');
      expect(cols.map((c) => c.column_name)).not.toContain('fulfilmentStrategy');
    });
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000320000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000320000', 1, 'PUBLISHED', now());
      INSERT INTO entitlement_default ("planVersionId", "moduleKey", enabled)
      VALUES ('${PLAN_V}', 'production_bom', false), ('${PLAN_V}', 'custom_composition', false);
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 50),
             ('${PLAN_V}', 'max_users', 50), ('${PLAN_V}', 'max_companies', 5);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      -- catalog:view / catalog:manage are already registered by the task 3.2
      -- migration; ON CONFLICT keeps this seed harmless.
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('users:view','TENANT','admin','v',1),
             ('platform:tenants:view','PLATFORM','platform','v',1),
             ('platform:catalog_capability:manage','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'x', 'x');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now()),
             ('BAKERY_CAKE', 2, 'Bakery', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()),
             ('BAKERY_CAKE','strategy.stocked',true,now()),('BAKERY_CAKE','strategy.bom',true,now());
    `);
  } finally {
    await c.end();
  }
}
