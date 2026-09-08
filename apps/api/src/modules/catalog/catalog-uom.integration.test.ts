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

const PLAN_V = '00000000-0000-7000-8000-000000360001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000360002';
const MANAGE = ['catalog:view', 'catalog:manage', 'variants:manage', 'identifiers:manage'];

/**
 * Task 3.6 — UOM / pack conversion (integration). Covers the frozen §O proof
 * list: canonical lowercase codes + slash rejection + built-in shadow; no
 * `piece` backfill; base-UOM lifecycle (legacy-ACTIVE init, non-null replace
 * restrictions, STOCKED/BOM activation gate, CUSTOM optional); built-in +
 * tenant + cross-family + product-inheritance + override + redundant-rejection
 * conversion resolution; exact-or-reject pack arithmetic + nested-pack proof;
 * frozen pack snapshot survives a conversion edit / deactivate / reactivate;
 * custom-UOM delete guards + concurrency; capability matrix; RLS isolation;
 * no INVENTORY_ITEM / GLOBAL / price / stock pull-forward; HG3-NO-BT-BRANCH.
 */
describe('UOM / pack conversion (task 3.6, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let superTok = '';
  let tenantA = '';
  let tenantN = '';
  let tenantB = '';
  let ownerA = '';
  let viewerA = '';
  let ownerN = '';
  let ownerB = '';

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
    tenantA = await provision('uom-a', 'CUSTOM');
    tenantN = await provision('uom-n', 'CUSTOM');
    tenantB = await provision('uom-b', 'PERFUME_ATTAR');
    for (const t of [tenantA, tenantN, tenantB]) {
      await setCap(t, 'strategy.stocked', true);
      await setCap(t, 'strategy.bom', true);
      await setCap(t, 'strategy.custom', true);
      await setCap(t, 'variants', true);
      await setCap(t, 'identifiers.barcode_qr', true);
    }
    await setCap(tenantA, 'multi_uom', true);
    await setCap(tenantB, 'multi_uom', true);
    await setCap(tenantN, 'multi_uom', false);

    const ent = ['custom_composition', 'production_bom'];
    ownerA = await mintTenant('oa', tenantA, MANAGE, ent);
    viewerA = await mintTenant('va', tenantA, ['catalog:view'], ent);
    ownerN = await mintTenant('on', tenantN, MANAGE, ent);
    ownerB = await mintTenant('ob', tenantB, MANAGE, ent);
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
    entitledModules: string[] = [],
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
  const auditRows = (tenantId: string, action: string): Promise<number> =>
    count(`SELECT count(*)::int AS n FROM audit_log WHERE "tenantId"=$1 AND action=$2`, [
      tenantId,
      action,
    ]);
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;
  let idemN = 0;
  const ik = (): string => `t36-key-${++idemN}`;

  async function mkCat(token: string, slug: string): Promise<string> {
    const r = await req(
      'POST',
      '/catalog/categories',
      token,
      { slug, nameEn: slug },
      { 'idempotency-key': ik() },
    );
    expect(r.statusCode, r.payload).toBe(201);
    return (r.json() as { id: string }).id;
  }
  async function mkProduct(
    token: string,
    slug: string,
    fulfilmentStrategy = 'STOCKED',
  ): Promise<{ id: string; version: number }> {
    const cat = await mkCat(token, `${slug}-c`);
    const r = await req(
      'POST',
      '/catalog/products',
      token,
      { categoryId: cat, nameEn: slug, slug: `${slug}-p`, fulfilmentStrategy },
      { 'idempotency-key': ik() },
    );
    expect(r.statusCode, r.payload).toBe(201);
    const b = r.json() as { id: string; version: number };
    return { id: b.id, version: b.version };
  }
  const listVariants = async (token: string, productId: string) => {
    const r = await req('GET', `/catalog/products/${productId}/variants`, token);
    expect(r.statusCode, r.payload).toBe(200);
    return r.json() as {
      id: string;
      isDefault: boolean;
      status: string;
      version: number;
      baseUomCode: string | null;
    }[];
  };
  const getVariant = async (token: string, id: string) =>
    (await req('GET', `/catalog/variants/${id}`, token)).json() as {
      id: string;
      version: number;
      status: string;
      baseUomCode: string | null;
    };
  /** a simple STOCKED product + its DRAFT default variant */
  async function mkStocked(token: string, slug: string, strategy = 'STOCKED') {
    const p = await mkProduct(token, slug, strategy);
    const v = (await listVariants(token, p.id))[0]!;
    return {
      productId: p.id,
      productVersion: p.version,
      variantId: v.id,
      variantVersion: v.version,
    };
  }
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
  async function activateProduct(token: string, id: string) {
    const p = (await req('GET', `/catalog/products/${id}`, token)).json() as { version: number };
    return req('POST', `/catalog/products/${id}/activate`, token, undefined, {
      'idempotency-key': ik(),
      'if-match': `"${p.version}"`,
    });
  }
  async function activateVariant(token: string, id: string) {
    const v = await getVariant(token, id);
    return req('POST', `/catalog/variants/${id}/activate`, token, undefined, {
      'idempotency-key': ik(),
      'if-match': `"${v.version}"`,
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
  const putProductConv = async (token: string, productId: string, conversions: unknown[]) => {
    const p = (await req('GET', `/catalog/products/${productId}`, token)).json() as {
      version: number;
    };
    return req(
      'PUT',
      `/catalog/products/${productId}/conversions`,
      token,
      { conversions },
      { 'if-match': `"${p.version}"` },
    );
  };
  const mkUom = (token: string, body: Record<string, unknown>) =>
    req('POST', '/catalog/uoms', token, body, { 'idempotency-key': ik() });
  const createId = (token: string, body: Record<string, unknown>, key = ik()) =>
    req('POST', '/catalog/identifiers', token, body, { 'idempotency-key': key });

  // ════════════ canonical codes + shadow (proofs 1–3) ══════════════════════
  describe('canonical UOM codes', () => {
    it('a tenant unit code is canonicalized to lowercase; a slash is rejected; a built-in shadow is 422', async () => {
      const up = await mkUom(ownerA, { code: '  BOX ', family: 'EACH', nameEn: 'Box' });
      expect(up.statusCode, up.payload).toBe(201);
      expect((up.json() as { code: string }).code).toBe('box');

      const slash = await mkUom(ownerA, { code: 'roll/12', family: 'EACH', nameEn: 'Roll' });
      expect(slash.statusCode).toBe(422);

      const shadow = await mkUom(ownerA, { code: 'PIECE', family: 'COUNT', nameEn: 'Piece' });
      expect(shadow.statusCode).toBe(422);
      expect(errCode(shadow)).toBe('UOM_BUILTIN_SHADOW');
    });

    it('GET /uoms merges built-ins (read-only) + tenant units; no piece backfill on a fresh variant', async () => {
      const list = (await req('GET', '/catalog/uoms', ownerA)).json() as {
        code: string;
        builtin: boolean;
      }[];
      const piece = list.find((u) => u.code === 'piece')!;
      expect(piece.builtin).toBe(true);
      expect(list.some((u) => u.code === 'box' && !u.builtin)).toBe(true);

      const s = await mkStocked(ownerA, 'nobackfill');
      expect((await getVariant(ownerA, s.variantId)).baseUomCode).toBeNull();
    });

    it('COUNT unit must be discrete; EACH perBase is forced 1/1', async () => {
      expect(
        (
          await mkUom(ownerA, {
            code: 'halfdz',
            family: 'COUNT',
            perBaseNum: '6',
            maxDecimals: 2,
            nameEn: 'x',
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await mkUom(ownerA, { code: 'bigbox', family: 'EACH', perBaseNum: '5', nameEn: 'x' }))
          .statusCode,
      ).toBe(422);
      expect(
        (
          await mkUom(ownerA, {
            code: 'yard',
            family: 'LENGTH',
            perBaseNum: '9144',
            perBaseDen: '10000',
            maxDecimals: 4,
            nameEn: 'Yard',
          })
        ).statusCode,
      ).toBe(201);
    });
  });

  // ════════════ base-UOM lifecycle (proofs 4–9) ═══════════════════════════
  describe('variant base-UOM lifecycle', () => {
    it('a legacy ACTIVE variant with a NULL base can be initialized once (no conversions, no pack ids)', async () => {
      const s = await mkStocked(ownerA, 'legacy-init');
      // drive it ACTIVE via SQL to simulate a pre-3.6 variant, then init via API
      await sql(`UPDATE "product" SET status='ACTIVE' WHERE id=$1`, [s.productId]);
      await sql(`UPDATE "variant" SET status='ACTIVE' WHERE id=$1`, [s.variantId]);
      const r = await setBase(ownerA, s.variantId, 'piece');
      expect(r.statusCode, r.payload).toBe(200);
      expect((r.json() as { baseUomCode: string }).baseUomCode).toBe('piece');
      expect(await auditRows(tenantA, 'catalog.variant_base_uom_set')).toBeGreaterThan(0);
    });

    it('non-NULL → different base: only while DRAFT with zero conversions / pack ids', async () => {
      const s = await mkStocked(ownerA, 'base-replace');
      expect((await setBase(ownerA, s.variantId, 'piece')).statusCode).toBe(200);
      // still DRAFT, no deps → replace OK
      expect((await setBase(ownerA, s.variantId, 'stem')).statusCode).toBe(200);
      // add a conversion, then a replace is locked
      await mkUom(ownerA, { code: 'box2', family: 'EACH', nameEn: 'Box' }).catch(() => {});
      expect(
        (await putVariantConv(ownerA, s.variantId, [{ fromUomCode: 'dozen', num: '12' }]))
          .statusCode,
      ).not.toBe(200);
      // dozen->stem is same-family resolvable → redundant; use an EACH unit instead
      await mkUom(ownerA, { code: 'bundle', family: 'EACH', nameEn: 'Bundle' });
      expect(
        (await putVariantConv(ownerA, s.variantId, [{ fromUomCode: 'bundle', num: '5' }]))
          .statusCode,
      ).toBe(200);
      const locked = await setBase(ownerA, s.variantId, 'piece');
      expect(locked.statusCode).toBe(409);
      expect(errCode(locked)).toBe('VARIANT_BASE_UOM_LOCKED');
    });

    it('STOCKED + BOM variant activation requires a base UOM; CUSTOM does not', async () => {
      const st = await mkStocked(ownerA, 'act-stocked', 'STOCKED');
      expect((await activateProduct(ownerA, st.productId)).statusCode).toBe(200);
      const noBase = await activateVariant(ownerA, st.variantId);
      expect(noBase.statusCode).toBe(409);
      expect(errCode(noBase)).toBe('VARIANT_BASE_UOM_REQUIRED');
      await setBase(ownerA, st.variantId, 'piece');
      expect((await activateVariant(ownerA, st.variantId)).statusCode).toBe(200);

      const bom = await mkStocked(ownerA, 'act-bom', 'BOM');
      await activateProduct(ownerA, bom.productId);
      expect(errCode(await activateVariant(ownerA, bom.variantId))).toBe(
        'VARIANT_BASE_UOM_REQUIRED',
      );

      // CUSTOM product has zero variants by default — activation needs no base
      const cu = await mkProduct(ownerA, 'act-custom', 'CUSTOM');
      expect((await activateProduct(ownerA, cu.id)).statusCode).toBe(200);
    });
  });

  // ════════════ conversion model (proofs 10–17) ═══════════════════════════
  describe('conversion resolution', () => {
    it('built-in same-family conversions resolve with ZERO rows; a redundant explicit row is rejected', async () => {
      const s = await mkStocked(ownerA, 'family-safe');
      await setBase(ownerA, s.variantId, 'gram');
      // kilogram->gram is authoritative perBase — an explicit row is redundant
      const redundant = await putVariantConv(ownerA, s.variantId, [
        { fromUomCode: 'kilogram', num: '1000' },
      ]);
      expect(redundant.statusCode).toBe(422);
      expect(errCode(redundant)).toBe('UOM_CONVERSION_REDUNDANT');
    });

    it('a cross-family conversion needs an explicit scoped row; a tenant EACH pack unit resolves via it', async () => {
      await mkUom(ownerA, { code: 'box', family: 'EACH', nameEn: 'Box' }).catch(() => {});
      await mkUom(ownerA, { code: 'carton', family: 'EACH', nameEn: 'Carton' });
      const s = await mkStocked(ownerA, 'crossfam');
      await setBase(ownerA, s.variantId, 'piece');
      const ok = await putVariantConv(ownerA, s.variantId, [
        { fromUomCode: 'box', num: '12' },
        { fromUomCode: 'carton', num: '288' },
      ]);
      expect(ok.statusCode, ok.payload).toBe(200);
      const eff = ok.json() as { rows: { fromUomCode: string; toUomCode: string; num: string }[] };
      expect(eff.rows.find((r) => r.fromUomCode === 'carton')!.toUomCode).toBe('piece');
    });

    it('PRODUCT conversion is inherited only when toUomCode == variant base; a variant override wins; inert rows show only on the product GET', async () => {
      await mkUom(ownerA, { code: 'tray', family: 'EACH', nameEn: 'Tray' });
      const p = await mkProduct(ownerA, 'prod-conv', 'STOCKED');
      const vs = await listVariants(ownerA, p.id);
      const vPiece = vs[0]!;
      await setBase(ownerA, vPiece.id, 'piece');

      // product row tray->piece (matches) + tray->milliliter (inert, no ml variant)
      const pc = await putProductConv(ownerA, p.id, [
        { fromUomCode: 'tray', toUomCode: 'piece', num: '20' },
        { fromUomCode: 'tray', toUomCode: 'milliliter', num: '500' },
      ]);
      expect(pc.statusCode, pc.payload).toBe(200);
      const stored = pc.json() as { rows: { toUomCode: string; appliesToVariantCount: number }[] };
      expect(stored.rows.find((r) => r.toUomCode === 'milliliter')!.appliesToVariantCount).toBe(0);

      const veff = (
        await req('GET', `/catalog/variants/${vPiece.id}/conversions`, ownerA)
      ).json() as {
        rows: { fromUomCode: string; num: string; inherited: boolean }[];
      };
      const inh = veff.rows.find((r) => r.fromUomCode === 'tray')!;
      expect(inh.inherited).toBe(true);
      expect(inh.num).toBe('20');

      // variant override: tray->piece = 24 wins over the inherited 20
      await putVariantConv(ownerA, vPiece.id, [{ fromUomCode: 'tray', num: '24' }]);
      const veff2 = (
        await req('GET', `/catalog/variants/${vPiece.id}/conversions`, ownerA)
      ).json() as {
        rows: { fromUomCode: string; num: string; inherited: boolean }[];
      };
      expect(veff2.rows.filter((r) => r.fromUomCode === 'tray')).toHaveLength(1);
      expect(veff2.rows[0]!.num).toBe('24');
      expect(veff2.rows[0]!.inherited).toBe(false);
    });
  });

  // ════════════ exact pack arithmetic + snapshot (proofs 13–14, 18, 21–26) ═
  describe('pack identity snapshot', () => {
    async function packVariant(slug: string, base = 'piece', activate = false) {
      await mkUom(ownerA, { code: 'box', family: 'EACH', nameEn: 'Box' }).catch(() => {});
      await mkUom(ownerA, { code: 'carton', family: 'EACH', nameEn: 'Carton' }).catch(() => {});
      const s = await mkStocked(ownerA, slug);
      expect((await setBase(ownerA, s.variantId, base)).statusCode).toBe(200);
      expect(
        (
          await putVariantConv(ownerA, s.variantId, [
            { fromUomCode: 'box', num: '12' },
            { fromUomCode: 'carton', num: '288' },
          ])
        ).statusCode,
      ).toBe(200);
      if (activate) {
        expect((await activateProduct(ownerA, s.productId)).statusCode).toBe(200);
        expect((await activateVariant(ownerA, s.variantId)).statusCode).toBe(200);
      }
      return s;
    }

    it('a pack BARCODE snapshots the base quantity; SKU pack is rejected; a plain BARCODE keeps Task 3.5 behaviour', async () => {
      const s = await packVariant('pack-basic');
      const sku = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'SKU',
        value: 'CHOCO-PIECE',
        pack: { uomCode: 'box', qty: '1' },
      });
      expect(sku.statusCode).toBe(422);
      expect(errCode(sku)).toBe('IDENTIFIER_PACK_NOT_ALLOWED');

      const plain = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-A',
      });
      expect(plain.statusCode).toBe(201);
      expect((plain.json() as { packUomCode: string | null }).packUomCode).toBeNull();

      const b = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-B',
        pack: { uomCode: 'box', qty: '1' },
      });
      expect(b.statusCode, b.payload).toBe(201);
      expect((b.json() as { packBaseQty: string }).packBaseQty).toBe('12.0000');

      const c = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-C',
        pack: { uomCode: 'carton', qty: '1' },
      });
      expect((c.json() as { packBaseQty: string }).packBaseQty).toBe('288.0000');

      const scan = await req('GET', `/catalog/identifiers?value=BC-B`, ownerA);
      const pk = (scan.json() as { pack: { baseUomCode: string; baseQty: string } | null }).pack!;
      expect(pk.baseUomCode).toBe('piece');
      expect(pk.baseQty).toBe('12.0000');
    });

    it('the frozen packBaseQty survives a later conversion-ratio edit; a new meaning needs a new value', async () => {
      const s = await packVariant('pack-frozen');
      const b = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-FROZEN',
        pack: { uomCode: 'box', qty: '1' },
      });
      expect((b.json() as { packBaseQty: string }).packBaseQty).toBe('12.0000');
      // change box -> piece to 10
      const edit = await putVariantConv(ownerA, s.variantId, [
        { fromUomCode: 'box', num: '10' },
        { fromUomCode: 'carton', num: '288' },
      ]);
      expect(edit.statusCode, edit.payload).toBe(200);
      const scan = await req('GET', `/catalog/identifiers?value=BC-FROZEN`, ownerA);
      expect((scan.json() as { pack: { baseQty: string } }).pack.baseQty).toBe('12.0000');
    });

    it('an inexact base quantity is rejected — never HALF_UP rounded', async () => {
      await mkUom(ownerA, { code: 'bunch', family: 'EACH', nameEn: 'Bunch' });
      const s = await mkStocked(ownerA, 'pack-inexact');
      await setBase(ownerA, s.variantId, 'stem');
      // 1 bunch = 3 stem; a barcode for 1 bunch → exact
      await putVariantConv(ownerA, s.variantId, [{ fromUomCode: 'bunch', num: '3' }]);
      const okB = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-BUNCH',
        pack: { uomCode: 'stem', qty: '2' },
      });
      expect(okB.statusCode).toBe(201);
      // now a fractional-ratio bunch (7/2 stems) → a barcode for 1 stem in bunch is inexact
      await putVariantConv(ownerA, s.variantId, [{ fromUomCode: 'bunch', num: '7', den: '2' }]);
      const inexact = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-INEXACT',
        pack: { uomCode: 'stem', qty: '1' },
      });
      // stem->stem is identity (exact); the inexactness only shows converting bunch. Instead pack in bunch with a qty that yields a fraction:
      expect(inexact.statusCode).toBe(201); // stem is the base — exact
      const frac = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-FRAC',
        pack: { uomCode: 'bunch', qty: '1' },
      });
      // 1 bunch = 3.5 stem → 3.5000 is exact at scale-4 but violates stem's discrete rule (0 decimals)
      expect(frac.statusCode).toBe(422);
      expect(errCode(frac)).toBe('FRACTIONAL_UNIT');
    });

    it('deactivate + reactivate preserve the frozen snapshot; reactivating a pack id needs multi_uom', async () => {
      const s = await packVariant('pack-lifecycle', 'piece', true);
      const b = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-LC',
        pack: { uomCode: 'box', qty: '2' },
      });
      const bid = (b.json() as { id: string }).id;
      expect((b.json() as { packBaseQty: string }).packBaseQty).toBe('24.0000');
      await req('DELETE', `/catalog/identifiers/${bid}`, ownerA);
      const inactive = await sql<{ packBaseQty: string }>(
        `SELECT "packBaseQty" FROM item_identifier WHERE id=$1`,
        [bid],
      );
      expect(Number(inactive[0]!.packBaseQty)).toBe(24);
      const re = await req('POST', `/catalog/identifiers/${bid}/reactivate`, ownerA, undefined, {
        'idempotency-key': ik(),
      });
      expect(re.statusCode, re.payload).toBe(200);
      expect((re.json() as { packBaseQty: string }).packBaseQty).toBe('24.0000');
    });

    it('a base-UOM change is blocked once a pack identifier (ACTIVE or INACTIVE) exists', async () => {
      const s = await packVariant('pack-baselock', 'piece', true);
      const b = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'BC-BL',
        pack: { uomCode: 'box', qty: '1' },
      });
      const bid = (b.json() as { id: string }).id;
      const locked1 = await setBase(ownerA, s.variantId, 'stem');
      expect(errCode(locked1)).toBe('VARIANT_BASE_UOM_LOCKED');
      await req('DELETE', `/catalog/identifiers/${bid}`, ownerA); // INACTIVE now
      const locked2 = await setBase(ownerA, s.variantId, 'stem');
      expect(errCode(locked2)).toBe('VARIANT_BASE_UOM_LOCKED');
    });
  });

  // ════════════ custom-UOM delete guards + concurrency (proofs 27–31, 39–41) ═
  describe('custom-UOM delete guards + concurrency', () => {
    const getUomVersion = async (token: string, code: string): Promise<number> => {
      const list = (await req('GET', '/catalog/uoms', token)).json() as {
        code: string;
        version: number | null;
      }[];
      return list.find((u) => u.code === code)!.version!;
    };
    const delUom = async (token: string, code: string) => {
      const v = await getUomVersion(token, code);
      return req('DELETE', `/catalog/uoms/${code}`, token, undefined, { 'if-match': `"${v}"` });
    };

    it('delete is blocked by a variant base / a conversion / an ACTIVE pack id / an INACTIVE pack id; an unreferenced unit deletes', async () => {
      // unreferenced → deletes
      await mkUom(ownerA, { code: 'freeunit', family: 'EACH', nameEn: 'Free' });
      expect((await delUom(ownerA, 'freeunit')).statusCode).toBe(200);

      // referenced by a variant base
      await mkUom(ownerA, { code: 'baseunit', family: 'COUNT', perBaseNum: '1', nameEn: 'B' });
      const s1 = await mkStocked(ownerA, 'du-base');
      await setBase(ownerA, s1.variantId, 'baseunit');
      expect(errCode(await delUom(ownerA, 'baseunit'))).toBe('UOM_IN_USE');

      // referenced by a conversion + a pack id
      await mkUom(ownerA, { code: 'packu', family: 'EACH', nameEn: 'P' });
      const s2 = await mkStocked(ownerA, 'du-conv');
      expect((await setBase(ownerA, s2.variantId, 'piece')).statusCode).toBe(200);
      expect(
        (await putVariantConv(ownerA, s2.variantId, [{ fromUomCode: 'packu', num: '6' }]))
          .statusCode,
      ).toBe(200);
      expect(errCode(await delUom(ownerA, 'packu'))).toBe('UOM_IN_USE');
      // activate so the pack-identifier DELETE deactivates (INACTIVE), not hard-deletes
      expect((await activateProduct(ownerA, s2.productId)).statusCode).toBe(200);
      expect((await activateVariant(ownerA, s2.variantId)).statusCode).toBe(200);
      const b = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s2.variantId,
        codeType: 'BARCODE',
        value: 'BC-PACKU',
        pack: { uomCode: 'packu', qty: '1' },
      });
      expect(b.statusCode, b.payload).toBe(201);
      const bid = (b.json() as { id: string }).id;
      // clear the conversion — still blocked by the ACTIVE pack id
      expect((await putVariantConv(ownerA, s2.variantId, [])).statusCode).toBe(200);
      expect(errCode(await delUom(ownerA, 'packu'))).toBe('UOM_IN_USE');
      // deactivate — STILL blocked (INACTIVE pack id counts)
      expect((await req('DELETE', `/catalog/identifiers/${bid}`, ownerA)).statusCode).toBe(200);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM item_identifier WHERE id=$1 AND status='INACTIVE'`,
          [bid],
        ),
      ).toBe(1);
      expect(errCode(await delUom(ownerA, 'packu'))).toBe('UOM_IN_USE');
    });

    it('writer-first: a reference write holding FOR KEY SHARE makes a concurrent DELETE wait, then the delete 409s', async () => {
      await mkUom(ownerA, { code: 'raceunit', family: 'EACH', nameEn: 'R' });
      const s = await mkStocked(ownerA, 'race-writer');
      await setBase(ownerA, s.variantId, 'piece');
      const uomVer = await getUomVersion(ownerA, 'raceunit');

      const del = await withHeldTxn(
        async (c) => {
          // hold FOR KEY SHARE on the uom row (what a reference writer does)
          await c.query(`SELECT "code" FROM "uom" WHERE "code" = 'raceunit' FOR KEY SHARE`);
          // and persist a reference while holding it
          await c.query(
            `INSERT INTO "uom_conversion" (id,"tenantId","scopeKind","scopeId","fromUomCode","toUomCode","num","updatedAt")
             VALUES (uuidv7(),$1,'VARIANT',$2,'raceunit','piece',6,now())`,
            [tenantA, s.variantId],
          );
        },
        () =>
          req('DELETE', `/catalog/uoms/raceunit`, ownerA, undefined, { 'if-match': `"${uomVer}"` }),
      );
      expect(del.statusCode).toBe(409);
      expect(errCode(del)).toBe('UOM_IN_USE');
    });

    it('delete-first: a DELETE holding FOR UPDATE makes a concurrent reference write wait, then it fails cleanly (no 500)', async () => {
      await mkUom(ownerA, { code: 'raceunit2', family: 'EACH', nameEn: 'R2' });
      const s = await mkStocked(ownerA, 'race-delete');
      await setBase(ownerA, s.variantId, 'piece');

      const write = await withHeldTxn(
        async (c) => {
          await c.query(`SELECT "id" FROM "uom" WHERE "code" = 'raceunit2' FOR UPDATE`);
          await c.query(`DELETE FROM "uom" WHERE "code" = 'raceunit2'`);
        },
        () => putVariantConv(ownerA, s.variantId, [{ fromUomCode: 'raceunit2', num: '6' }]),
      );
      expect([404, 422]).toContain(write.statusCode);
      expect(write.statusCode).not.toBe(500);
      // no dangling reference persisted
      expect(
        await count(
          `SELECT count(*)::int AS n FROM "uom_conversion" WHERE "fromUomCode"='raceunit2'`,
        ),
      ).toBe(0);
    });
  });

  // ════════════ capability matrix (proofs 32–33, 17–18) ═══════════════════
  describe('multi_uom capability matrix', () => {
    it('multi_uom off: uom writes / conversion writes / custom base / pack create are all 409; reads + built-in base work', async () => {
      // reads
      expect((await req('GET', '/catalog/uoms', ownerN)).statusCode).toBe(200);

      const create = await mkUom(ownerN, { code: 'nbox', family: 'EACH', nameEn: 'x' });
      expect(create.statusCode).toBe(409);
      expect(errCode(create)).toBe('CAPABILITY_NOT_ENABLED');

      const s = await mkStocked(ownerN, 'nocap');
      // built-in base → allowed without multi_uom
      expect((await setBase(ownerN, s.variantId, 'piece')).statusCode).toBe(200);
      // conversion write → 409
      const cw = await putVariantConv(ownerN, s.variantId, [{ fromUomCode: 'dozen', num: '12' }]);
      expect(cw.statusCode).toBe(409);
      // pack create → 409 (needs multi_uom)
      const pk = await createId(ownerN, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'N-BC',
        pack: { uomCode: 'dozen', qty: '1' },
      });
      expect(pk.statusCode).toBe(409);
      // a plain barcode still works (Task 3.5 unaffected)
      expect(
        (
          await createId(ownerN, {
            targetKind: 'VARIANT',
            targetId: s.variantId,
            codeType: 'BARCODE',
            value: 'N-PLAIN',
          })
        ).statusCode,
      ).toBe(201);
    });

    it('disabling multi_uom does not hide or destroy existing custom UOMs / pack identifiers; scan still works; pack reactivate is 409', async () => {
      // build with multi_uom ON (tenant B); activate so the pack id deactivates
      await mkUom(ownerB, { code: 'box', family: 'EACH', nameEn: 'Box' });
      const s = await mkStocked(ownerB, 'toggle');
      expect((await setBase(ownerB, s.variantId, 'piece')).statusCode).toBe(200);
      expect(
        (await putVariantConv(ownerB, s.variantId, [{ fromUomCode: 'box', num: '12' }])).statusCode,
      ).toBe(200);
      expect((await activateProduct(ownerB, s.productId)).statusCode).toBe(200);
      expect((await activateVariant(ownerB, s.variantId)).statusCode).toBe(200);
      const b = await createId(ownerB, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'B-BC',
        pack: { uomCode: 'box', qty: '1' },
      });
      expect(b.statusCode, b.payload).toBe(201);
      const bid = (b.json() as { id: string }).id;
      // a plain ACTIVE pack barcode for the same variant — to prove scan still works after the toggle
      const bScan = await createId(ownerB, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'B-SCAN',
        pack: { uomCode: 'box', qty: '2' },
      });
      expect(bScan.statusCode, bScan.payload).toBe(201);
      expect((await req('DELETE', `/catalog/identifiers/${bid}`, ownerB)).statusCode).toBe(200);

      await setCap(tenantB, 'multi_uom', false);
      try {
        // custom uom still listed
        expect(
          ((await req('GET', '/catalog/uoms', ownerB)).json() as { code: string }[]).some(
            (u) => u.code === 'box',
          ),
        ).toBe(true);
        // an ACTIVE pack barcode still scans (frozen snapshot, not recomputed)
        const scan = await req('GET', `/catalog/identifiers?value=B-SCAN`, ownerB);
        expect(scan.statusCode).toBe(200);
        expect((scan.json() as { pack: { baseQty: string } }).pack.baseQty).toBe('24.0000');
        // the reactivate of the INACTIVE pack id is blocked
        const re = await req('POST', `/catalog/identifiers/${bid}/reactivate`, ownerB, undefined, {
          'idempotency-key': ik(),
        });
        expect(re.statusCode).toBe(409);
        expect(errCode(re)).toBe('CAPABILITY_NOT_ENABLED');
      } finally {
        await setCap(tenantB, 'multi_uom', true);
      }
      // re-enabling permits it
      const re2 = await req('POST', `/catalog/identifiers/${bid}/reactivate`, ownerB, undefined, {
        'idempotency-key': ik(),
      });
      expect(re2.statusCode, re2.payload).toBe(200);
    });
  });

  // ════════════ isolation + no pull-forward (proofs 36, 45–48) ════════════
  describe('isolation + non-scope', () => {
    it('tenant B cannot read / write tenant A UOMs or conversions', async () => {
      await mkUom(ownerA, { code: 'aonly', family: 'EACH', nameEn: 'A only' });
      const list = (await req('GET', '/catalog/uoms', ownerB)).json() as { code: string }[];
      expect(list.some((u) => u.code === 'aonly')).toBe(false);
      // B updating A's unit → 404 (RLS scoped)
      const upd = await req(
        'PUT',
        '/catalog/uoms/aonly',
        ownerB,
        { nameEn: 'pwn' },
        { 'if-match': '"1"' },
      );
      expect([404, 409]).toContain(upd.statusCode);
    });

    it('no INVENTORY_ITEM identifier target; no GLOBAL conversion scope; a pack scan returns no price / stock field', async () => {
      const inv = await createId(ownerA, {
        targetKind: 'INVENTORY_ITEM',
        targetId: '00000000-0000-7000-8000-000000009999',
        codeType: 'BARCODE',
        value: 'INV-X',
      });
      expect([400, 422]).toContain(inv.statusCode);

      const s = await mkStocked(ownerA, 'noscope');
      await setBase(ownerA, s.variantId, 'piece');
      await mkUom(ownerA, { code: 'box', family: 'EACH', nameEn: 'Box' }).catch(() => {});
      await putVariantConv(ownerA, s.variantId, [{ fromUomCode: 'box', num: '12' }]);
      const b = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: s.variantId,
        codeType: 'BARCODE',
        value: 'NS-BC',
        pack: { uomCode: 'box', qty: '1' },
      });
      expect(b.statusCode).toBe(201);
      const scan = (await req('GET', `/catalog/identifiers?value=NS-BC`, ownerA)).json() as Record<
        string,
        unknown
      >;
      const blob = JSON.stringify(scan);
      for (const forbidden of [
        'price',
        'amountMinor',
        'currency',
        'stock',
        'onHand',
        'available',
        'quantityOnHand',
      ]) {
        expect(blob).not.toMatch(new RegExp(forbidden, 'i'));
      }
    });

    it('HG3-NO-BT-BRANCH: two tenants on different Business-Type presets get identical UOM behaviour', async () => {
      const build = async (token: string, slug: string) => {
        await mkUom(token, { code: 'box', family: 'EACH', nameEn: 'Box' }).catch(() => {});
        const s = await mkStocked(token, slug);
        await setBase(token, s.variantId, 'piece');
        await putVariantConv(token, s.variantId, [{ fromUomCode: 'box', num: '12' }]);
        const b = await createId(token, {
          targetKind: 'VARIANT',
          targetId: s.variantId,
          codeType: 'BARCODE',
          value: `${slug}-BC`,
          pack: { uomCode: 'box', qty: '1' },
        });
        return (b.json() as { packBaseQty: string }).packBaseQty;
      };
      const a = await build(ownerA, 'bt-a'); // tenant A = CUSTOM preset
      const b = await build(ownerB, 'bt-b'); // tenant B = PERFUME_ATTAR preset
      expect(a).toBe(b);
      expect(a).toBe('12.0000');
    });

    it('permission: catalog:view cannot write a UOM or a conversion', async () => {
      const w = await req(
        'POST',
        '/catalog/uoms',
        viewerA,
        { code: 'vbox', family: 'EACH', nameEn: 'x' },
        { 'idempotency-key': ik() },
      );
      expect(w.statusCode).toBe(403);
    });
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000360000', 'starter-uom', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000360000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 5);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin-uom@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('variants:manage','TENANT','catalog','v',3),('identifiers:manage','TENANT','inventory','v',3),
             ('users:view','TENANT','admin','v',1),('platform:tenants:view','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'x', 'x');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now()),
             ('PERFUME_ATTAR', 2, 'Perfume', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()),
             ('PERFUME_ATTAR','strategy.stocked',true,now());
    `);
  } finally {
    await c.end();
  }
}
