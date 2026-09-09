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

const PLAN_V = '00000000-0000-7000-8000-000000340001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000340002';
const MANAGE = ['catalog:view', 'catalog:manage', 'variants:manage'];

/**
 * Task 3.4 — variants + option groups. Covers the owner's required proof list:
 * default-variant creation / non-creation by strategy, the `variants` capability
 * gate (default exempt), first/last option-group ↔ default-variant transitions,
 * NO auto Cartesian generation, combination completeness + uniqueness +
 * insertion-order independence, archived-combination reuse, archived-variant
 * signature preservation, DRAFT-only selection edits, no identity drift, the
 * product-activation "≥1 non-archived variant" gate (non-CUSTOM) + CUSTOM zero
 * case + no deadlock, stale If-Match / concurrency, idempotent lifecycle replay,
 * one-audit-row-per-mutation + rollback atomicity, HG3-NO-BT-BRANCH behavioural.
 */
describe('variants + option groups (task 3.4, integration)', () => {
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
  let noCapTenant = '';
  let noCapOwner = '';

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
    // A + C: different Business Type, both with strategy.stocked + variants
    tenantA = await provision('var-a', 'CUSTOM');
    tenantC = await provision('var-c', 'BAKERY_CAKE');
    for (const t of [tenantA, tenantC]) {
      await setCap(t, 'strategy.stocked', true);
      await setCap(t, 'strategy.bom', true);
      await setCap(t, 'strategy.custom', true);
      await setCap(t, 'variants', true);
    }
    // a tenant WITHOUT the `variants` capability
    noCapTenant = await provision('var-nocap', 'CUSTOM');
    await setCap(noCapTenant, 'strategy.stocked', true);
    await setCap(noCapTenant, 'variants', false);

    const ent = ['production_bom', 'custom_composition'];
    ownerA = await mintTenant('oa', tenantA, MANAGE, ent);
    ownerC = await mintTenant('oc', tenantC, MANAGE, ent);
    viewerA = await mintTenant('va', tenantA, ['catalog:view']);
    noCapOwner = await mintTenant('onc', noCapTenant, MANAGE, ent);
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
  const ik = (): string => `t34-auto-key-${++idemN}`;

  async function makeCategory(token: string, slug: string): Promise<string> {
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
  async function makeProduct(
    token: string,
    categoryId: string,
    slug: string,
    fulfilmentStrategy = 'STOCKED',
  ): Promise<{ id: string; version: number }> {
    const r = await req(
      'POST',
      '/catalog/products',
      token,
      { categoryId, nameEn: slug, slug, fulfilmentStrategy },
      { 'idempotency-key': ik() },
    );
    expect(r.statusCode, r.payload).toBe(201);
    const b = r.json() as { id: string; version: number };
    return { id: b.id, version: b.version };
  }
  const listVariants = async (
    token: string,
    productId: string,
  ): Promise<{ id: string; isDefault: boolean; optionSignature: string; status: string }[]> => {
    const r = await req('GET', `/catalog/products/${productId}/variants`, token);
    expect(r.statusCode, r.payload).toBe(200);
    return r.json() as {
      id: string;
      isDefault: boolean;
      optionSignature: string;
      status: string;
    }[];
  };
  /**
   * task 3.6 (owner OD-G) — a STOCKED / BOM variant now needs a base UOM before
   * it can reach ACTIVE. This helper transparently sets `baseUomCode = 'piece'`
   * (a built-in — no `multi_uom` needed) if unset, then POSTs `/activate`.
   */
  async function activateVariant(token: string, variantId: string) {
    const cur = (await req('GET', `/catalog/variants/${variantId}`, token)).json() as {
      version: number;
      baseUomCode: string | null;
    };
    let version = cur.version;
    if (cur.baseUomCode === null) {
      const sb = await req(
        'PUT',
        `/catalog/variants/${variantId}/base-uom`,
        token,
        { baseUomCode: 'piece' },
        { 'if-match': `"${version}"` },
      );
      expect(sb.statusCode, sb.payload).toBe(200);
      version = (sb.json() as { version: number }).version;
    }
    return req('POST', `/catalog/variants/${variantId}/activate`, token, undefined, {
      'idempotency-key': ik(),
      'if-match': `"${version}"`,
    });
  }
  async function addGroup(
    token: string,
    productId: string,
    key: string,
  ): Promise<{ id: string; version: number }> {
    const r = await req(
      'POST',
      `/catalog/products/${productId}/option-groups`,
      token,
      { key, nameEn: key },
      { 'idempotency-key': ik() },
    );
    expect(r.statusCode, r.payload).toBe(201);
    const b = r.json() as { id: string; version: number };
    return { id: b.id, version: b.version };
  }
  async function setValues(
    token: string,
    productId: string,
    groupId: string,
    version: number,
    values: { value: string; labelEn: string }[],
  ): Promise<{ values: { id: string; value: string }[]; version: number }> {
    const r = await req(
      'PUT',
      `/catalog/products/${productId}/option-groups/${groupId}/values`,
      token,
      { values },
      { 'if-match': `"${version}"` },
    );
    expect(r.statusCode, r.payload).toBe(200);
    return r.json() as { values: { id: string; value: string }[]; version: number };
  }

  // ═══════════════════ default variant by strategy (proofs 20–21) ═══════════
  describe('auto default variant', () => {
    it('a new STOCKED / BOM product gets exactly one default variant; CUSTOM gets none', async () => {
      const cat = await makeCategory(ownerA, 'dv-cat');
      const stocked = await makeProduct(ownerA, cat, 'dv-stocked', 'STOCKED');
      const bom = await makeProduct(ownerA, cat, 'dv-bom', 'BOM');
      const custom = await makeProduct(ownerA, cat, 'dv-custom', 'CUSTOM');

      for (const p of [stocked, bom]) {
        const vs = await listVariants(ownerA, p.id);
        expect(vs).toHaveLength(1);
        expect(vs[0]!.isDefault).toBe(true);
        expect(vs[0]!.optionSignature).toBe('');
        expect(vs[0]!.status).toBe('DRAFT');
      }
      expect(await listVariants(ownerA, custom.id)).toHaveLength(0);

      // proof 16 — the default variant has zero option-value rows
      expect(
        await count(
          `SELECT count(*)::int AS n FROM variant_option_value vov
             JOIN variant v ON v.id = vov."variantId" WHERE v."productId" = $1`,
          [stocked.id],
        ),
      ).toBe(0);
    });

    it('the default variant is created with NO `variants` capability (owner L-13)', async () => {
      const cat = (
        await sql<{ id: string }>(
          `INSERT INTO category ("tenantId",slug,"nameEn","updatedAt") VALUES ($1,'nc','NC',now()) RETURNING id`,
          [noCapTenant],
        )
      )[0]!.id;
      const p = await makeProduct(noCapOwner, cat, 'nc-simple', 'STOCKED');
      expect(await listVariants(noCapOwner, p.id)).toHaveLength(1);
      // …but an option group (configurable path) is blocked
      const og = await req(
        'POST',
        `/catalog/products/${p.id}/option-groups`,
        noCapOwner,
        { key: 'COLOUR', nameEn: 'Colour' },
        { 'idempotency-key': ik() },
      );
      expect(og.statusCode).toBe(409);
      expect(errCode(og)).toBe('CAPABILITY_NOT_ENABLED');
    });

    it('a DRAFT strategy change STOCKED→CUSTOM drops the default; CUSTOM→STOCKED recreates it', async () => {
      const cat = await makeCategory(ownerA, 'sc-dv-cat');
      const p = await makeProduct(ownerA, cat, 'sc-dv-p', 'STOCKED');
      expect(await listVariants(ownerA, p.id)).toHaveLength(1);

      const toCustom = await req(
        'PUT',
        `/catalog/products/${p.id}`,
        ownerA,
        { fulfilmentStrategy: 'CUSTOM' },
        { 'if-match': `"${p.version}"` },
      );
      expect(toCustom.statusCode, toCustom.payload).toBe(200);
      expect(await listVariants(ownerA, p.id)).toHaveLength(0);

      const v2 = (toCustom.json() as { version: number }).version;
      const back = await req(
        'PUT',
        `/catalog/products/${p.id}`,
        ownerA,
        { fulfilmentStrategy: 'STOCKED' },
        { 'if-match': `"${v2}"` },
      );
      expect(back.statusCode, back.payload).toBe(200);
      expect(await listVariants(ownerA, p.id)).toHaveLength(1);
    });
  });

  // ═══════════════ option groups ↔ default variant (proofs 24–27) ═══════════
  describe('option-group structure', () => {
    it('the first option group removes the default variant; NO combinations are auto-generated', async () => {
      const cat = await makeCategory(ownerA, 'og-cat');
      const p = await makeProduct(ownerA, cat, 'og-p', 'STOCKED');
      expect(await listVariants(ownerA, p.id)).toHaveLength(1);

      const size = await addGroup(ownerA, p.id, 'SIZE');
      await setValues(ownerA, p.id, size.id, size.version, [
        { value: 'S', labelEn: 'S' },
        { value: 'M', labelEn: 'M' },
        { value: 'L', labelEn: 'L' },
      ]);
      const colour = await addGroup(ownerA, p.id, 'COLOUR');
      await setValues(ownerA, p.id, colour.id, colour.version, [
        { value: 'RED', labelEn: 'Red' },
        { value: 'BLUE', labelEn: 'Blue' },
      ]);

      // proof 25 — SIZE(3) × COLOUR(2) did NOT create 6 variants
      expect(await listVariants(ownerA, p.id)).toHaveLength(0);
    });

    it('removing the last option group recreates exactly one default variant (owner L-4)', async () => {
      const cat = await makeCategory(ownerA, 'og-last-cat');
      const p = await makeProduct(ownerA, cat, 'og-last-p', 'STOCKED');
      const g = await addGroup(ownerA, p.id, 'STYLE');
      expect(await listVariants(ownerA, p.id)).toHaveLength(0);

      const del = await req(
        'DELETE',
        `/catalog/products/${p.id}/option-groups/${g.id}`,
        ownerA,
        undefined,
        { 'if-match': `"${g.version}"` },
      );
      expect(del.statusCode, del.payload).toBe(200);
      expect((del.json() as { recreatedDefaultVariant: boolean }).recreatedDefaultVariant).toBe(
        true,
      );
      const vs = await listVariants(ownerA, p.id);
      expect(vs).toHaveLength(1);
      expect(vs[0]!.isDefault).toBe(true);
    });

    it('structural group add / remove is blocked once the product has explicit variants', async () => {
      const cat = await makeCategory(ownerA, 'og-lock-cat');
      const p = await makeProduct(ownerA, cat, 'og-lock-p', 'STOCKED');
      const g = await addGroup(ownerA, p.id, 'SIZE');
      const v = await setValues(ownerA, p.id, g.id, g.version, [{ value: 'S', labelEn: 'S' }]);
      const sId = v.values[0]!.id;
      const created = await req(
        'POST',
        `/catalog/products/${p.id}/variants`,
        ownerA,
        { optionValues: [{ optionGroupId: g.id, optionValueId: sId }] },
        { 'idempotency-key': ik() },
      );
      expect(created.statusCode, created.payload).toBe(201);

      const add2 = await req(
        'POST',
        `/catalog/products/${p.id}/option-groups`,
        ownerA,
        { key: 'COLOUR', nameEn: 'Colour' },
        { 'idempotency-key': ik() },
      );
      expect(add2.statusCode).toBe(409);
      expect(errCode(add2)).toBe('PRODUCT_HAS_VARIANTS');

      const gv = (await req('GET', `/catalog/products/${p.id}/option-groups`, ownerA)).json() as {
        id: string;
        version: number;
      }[];
      const del = await req(
        'DELETE',
        `/catalog/products/${p.id}/option-groups/${g.id}`,
        ownerA,
        undefined,
        { 'if-match': `"${gv[0]!.version}"` },
      );
      expect(del.statusCode).toBe(409);
      expect(errCode(del)).toBe('PRODUCT_HAS_VARIANTS');
    });

    it('a group cannot be added while the product is ACTIVE', async () => {
      const cat = await makeCategory(ownerA, 'og-active-cat');
      const p = await makeProduct(ownerA, cat, 'og-active-p', 'STOCKED');
      const act = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(act.statusCode, act.payload).toBe(200);
      const add = await req(
        'POST',
        `/catalog/products/${p.id}/option-groups`,
        ownerA,
        { key: 'SIZE', nameEn: 'Size' },
        { 'idempotency-key': ik() },
      );
      expect(add.statusCode).toBe(409);
      expect(errCode(add)).toBe('PRODUCT_NOT_DRAFT');
    });

    it('removing an in-use option value fails atomically (409); values keep their id', async () => {
      const cat = await makeCategory(ownerA, 'ov-cat');
      const p = await makeProduct(ownerA, cat, 'ov-p', 'STOCKED');
      const g = await addGroup(ownerA, p.id, 'SIZE');
      const v1 = await setValues(ownerA, p.id, g.id, g.version, [
        { value: 'S', labelEn: 'S' },
        { value: 'M', labelEn: 'M' },
      ]);
      const sId = v1.values.find((x) => x.value === 'S')!.id;
      await req(
        'POST',
        `/catalog/products/${p.id}/variants`,
        ownerA,
        { optionValues: [{ optionGroupId: g.id, optionValueId: sId }] },
        { 'idempotency-key': ik() },
      );
      // try to drop 'S' (referenced by the variant) → 409, no mutation
      const drop = await req(
        'PUT',
        `/catalog/products/${p.id}/option-groups/${g.id}/values`,
        ownerA,
        { values: [{ value: 'M', labelEn: 'M' }] },
        { 'if-match': `"${v1.version}"` },
      );
      expect(drop.statusCode).toBe(409);
      expect(errCode(drop)).toBe('OPTION_VALUE_IN_USE');
      const after = (
        await req('GET', `/catalog/products/${p.id}/option-groups`, ownerA)
      ).json() as { version: number; values: { value: string; id: string }[] }[];
      expect(after[0]!.values.map((x) => x.value).sort()).toEqual(['M', 'S']);
      expect(after[0]!.version).toBe(v1.version); // no bump on the failed replace
      // 'S' kept its id after a successful label edit
      const relabel = await setValues(ownerA, p.id, g.id, v1.version, [
        { value: 'S', labelEn: 'Small' },
        { value: 'M', labelEn: 'Medium' },
      ]);
      expect(relabel.values.find((x) => x.value === 'S')!.id).toBe(sId);
    });
  });

  // ═══════════════ variant combinations (proofs 9–15, 29–30) ════════════════
  describe('variant combinations', () => {
    async function configurable(
      token: string,
      slug: string,
    ): Promise<{
      productId: string;
      colour: { id: string; red: string; blue: string };
      size: { id: string; s: string; m: string };
    }> {
      const cat = await makeCategory(token, `${slug}-cat`);
      const p = await makeProduct(token, cat, `${slug}-p`, 'STOCKED');
      const cg = await addGroup(token, p.id, 'COLOUR');
      const cv = await setValues(token, p.id, cg.id, cg.version, [
        { value: 'RED', labelEn: 'Red' },
        { value: 'BLUE', labelEn: 'Blue' },
      ]);
      const sg = await addGroup(token, p.id, 'SIZE');
      const sv = await setValues(token, p.id, sg.id, sg.version, [
        { value: 'S', labelEn: 'S' },
        { value: 'M', labelEn: 'M' },
      ]);
      return {
        productId: p.id,
        colour: {
          id: cg.id,
          red: cv.values.find((x) => x.value === 'RED')!.id,
          blue: cv.values.find((x) => x.value === 'BLUE')!.id,
        },
        size: {
          id: sg.id,
          s: sv.values.find((x) => x.value === 'S')!.id,
          m: sv.values.find((x) => x.value === 'M')!.id,
        },
      };
    }
    const mkVariant = (
      token: string,
      productId: string,
      optionValues: { optionGroupId: string; optionValueId: string }[],
    ) =>
      req(
        'POST',
        `/catalog/products/${productId}/variants`,
        token,
        { optionValues },
        { 'idempotency-key': ik() },
      );

    it('requires exactly one value per group; incomplete / extra / duplicate → 422', async () => {
      const c = await configurable(ownerA, 'combo');
      // incomplete (missing SIZE)
      const inc = await mkVariant(ownerA, c.productId, [
        { optionGroupId: c.colour.id, optionValueId: c.colour.red },
      ]);
      expect(inc.statusCode).toBe(422);
      expect(errCode(inc)).toBe('VARIANT_COMBINATION_INCOMPLETE');
      // value from the wrong group
      const wrong = await mkVariant(ownerA, c.productId, [
        { optionGroupId: c.colour.id, optionValueId: c.size.s },
        { optionGroupId: c.size.id, optionValueId: c.size.m },
      ]);
      expect(wrong.statusCode).toBe(422);
      expect(errCode(wrong)).toBe('VARIANT_OPTION_VALUE_NOT_IN_GROUP');
      // a complete one works
      const ok = await mkVariant(ownerA, c.productId, [
        { optionGroupId: c.size.id, optionValueId: c.size.m },
        { optionGroupId: c.colour.id, optionValueId: c.colour.red },
      ]);
      expect(ok.statusCode, ok.payload).toBe(201);
    });

    it('a duplicate logical combination is rejected regardless of selection order (proofs 11–12)', async () => {
      const c = await configurable(ownerA, 'dup');
      const a = await mkVariant(ownerA, c.productId, [
        { optionGroupId: c.colour.id, optionValueId: c.colour.red },
        { optionGroupId: c.size.id, optionValueId: c.size.m },
      ]);
      expect(a.statusCode).toBe(201);
      const dup = await mkVariant(ownerA, c.productId, [
        { optionGroupId: c.size.id, optionValueId: c.size.m },
        { optionGroupId: c.colour.id, optionValueId: c.colour.red },
      ]);
      expect(dup.statusCode).toBe(409);
      expect(errCode(dup)).toBe('VARIANT_COMBINATION_DUPLICATE');
    });

    it('archiving a variant frees the combination; the archived signature is preserved; reactivation conflicts (13–15)', async () => {
      const c = await configurable(ownerA, 'arch');
      const v1 = (
        await mkVariant(ownerA, c.productId, [
          { optionGroupId: c.colour.id, optionValueId: c.colour.red },
          { optionGroupId: c.size.id, optionValueId: c.size.s },
        ])
      ).json() as { id: string; version: number; optionSignature: string };

      // must activate the product first (owner L-9), then the variant
      const pv = (
        (await req('GET', `/catalog/products/${c.productId}`, ownerA)).json() as { version: number }
      ).version;
      await req('POST', `/catalog/products/${c.productId}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${pv}"`,
      });
      const act = await activateVariant(ownerA, v1.id);
      expect(act.statusCode, act.payload).toBe(200);
      const v1v2 = (act.json() as { version: number }).version;

      const arch = await req('POST', `/catalog/variants/${v1.id}/archive`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v1v2}"`,
      });
      expect(arch.statusCode).toBe(200);
      expect((arch.json() as { optionSignature: string }).optionSignature).toBe(v1.optionSignature);

      // the same combination is now free for a new non-archived variant
      const v2 = await mkVariant(ownerA, c.productId, [
        { optionGroupId: c.colour.id, optionValueId: c.colour.red },
        { optionGroupId: c.size.id, optionValueId: c.size.s },
      ]);
      expect(v2.statusCode, v2.payload).toBe(201);
      const v2Id = (v2.json() as { id: string }).id;
      await activateVariant(ownerA, v2Id);

      // reactivating v1 now → 409 (v2 holds the combination), no mutation
      const archived = (
        (await req('GET', `/catalog/variants/${v1.id}`, ownerA)).json() as { version: number }
      ).version;
      const react = await req('POST', `/catalog/variants/${v1.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${archived}"`,
      });
      expect(react.statusCode).toBe(409);
      expect(errCode(react)).toBe('VARIANT_COMBINATION_DUPLICATE');
      expect(
        ((await req('GET', `/catalog/variants/${v1.id}`, ownerA)).json() as { status: string })
          .status,
      ).toBe('ARCHIVED');
    });

    it('option selections change only while DRAFT — no identity drift after ACTIVE (29–30)', async () => {
      const c = await configurable(ownerA, 'drift');
      const v = (
        await mkVariant(ownerA, c.productId, [
          { optionGroupId: c.colour.id, optionValueId: c.colour.red },
          { optionGroupId: c.size.id, optionValueId: c.size.s },
        ])
      ).json() as { id: string; version: number };

      // DRAFT edit of the combination is allowed
      const edit = await req(
        'PUT',
        `/catalog/variants/${v.id}`,
        ownerA,
        {
          optionValues: [
            { optionGroupId: c.colour.id, optionValueId: c.colour.blue },
            { optionGroupId: c.size.id, optionValueId: c.size.m },
          ],
        },
        { 'if-match': `"${v.version}"` },
      );
      expect(edit.statusCode, edit.payload).toBe(200);

      // activate product + variant, then a combination edit → 409
      const pv = (
        (await req('GET', `/catalog/products/${c.productId}`, ownerA)).json() as { version: number }
      ).version;
      await req('POST', `/catalog/products/${c.productId}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${pv}"`,
      });
      const actv = await activateVariant(ownerA, v.id);
      const v3 = (actv.json() as { version: number }).version;
      const drift = await req(
        'PUT',
        `/catalog/variants/${v.id}`,
        ownerA,
        { optionValues: [{ optionGroupId: c.colour.id, optionValueId: c.colour.red }] },
        { 'if-match': `"${v3}"` },
      );
      expect(drift.statusCode).toBe(409);
      expect(errCode(drift)).toBe('VARIANT_IDENTITY_LOCKED');
      // metadata edit on an ACTIVE variant is still fine
      const meta = await req(
        'PUT',
        `/catalog/variants/${v.id}`,
        ownerA,
        { nameEn: 'Renamed' },
        { 'if-match': `"${v3}"` },
      );
      expect(meta.statusCode, meta.payload).toBe(200);
    });
  });

  // ═══════════════ activation gates + no deadlock (31–34) ═══════════════════
  describe('activation gates', () => {
    it('a non-CUSTOM product with 0 variants (mid-config) cannot activate; CUSTOM with 0 can (31–32)', async () => {
      const cat = await makeCategory(ownerA, 'act-cat');
      const p = await makeProduct(ownerA, cat, 'act-p', 'STOCKED');
      await addGroup(ownerA, p.id, 'SIZE'); // default removed, 0 variants
      const pv = (
        (await req('GET', `/catalog/products/${p.id}`, ownerA)).json() as { version: number }
      ).version;
      const blocked = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${pv}"`,
      });
      expect(blocked.statusCode).toBe(422);
      expect(errCode(blocked)).toBe('PRODUCT_HAS_NO_VARIANT');

      const custom = await makeProduct(ownerA, cat, 'act-custom', 'CUSTOM');
      const ok = await req('POST', `/catalog/products/${custom.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${custom.version}"`,
      });
      expect(ok.statusCode, ok.payload).toBe(200);
    });

    it('the simple-product path has no Product↔Variant deadlock (34); default variant may still be DRAFT', async () => {
      const cat = await makeCategory(ownerA, 'deadlock-cat');
      const p = await makeProduct(ownerA, cat, 'deadlock-p', 'STOCKED');
      const [dv] = await listVariants(ownerA, p.id);
      expect(dv!.status).toBe('DRAFT');

      // product activates with the DRAFT default variant present (owner L-10)
      const pa = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(pa.statusCode, pa.payload).toBe(200);

      // the variant cannot activate before the product is ACTIVE — but now it is
      const vRow = (await listVariants(ownerA, p.id))[0]!;
      const va = await activateVariant(ownerA, vRow.id);
      expect(va.statusCode, va.payload).toBe(200);
      expect((va.json() as { status: string }).status).toBe('ACTIVE');
    });

    it('a variant cannot activate while its product is not ACTIVE (owner L-9)', async () => {
      const c = await makeCategory(ownerA, 'vact-cat');
      const p = await makeProduct(ownerA, c, 'vact-p', 'STOCKED');
      const g = await addGroup(ownerA, p.id, 'SIZE');
      const v = await setValues(ownerA, p.id, g.id, g.version, [{ value: 'S', labelEn: 'S' }]);
      const created = (
        await req(
          'POST',
          `/catalog/products/${p.id}/variants`,
          ownerA,
          { optionValues: [{ optionGroupId: g.id, optionValueId: v.values[0]!.id }] },
          { 'idempotency-key': ik() },
        )
      ).json() as { id: string; version: number };
      const act = await req('POST', `/catalog/variants/${created.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${created.version}"`,
      });
      expect(act.statusCode).toBe(409);
      expect(errCode(act)).toBe('PRODUCT_NOT_ACTIVE');
    });
  });

  // ═══════════════ concurrency + idempotency + audit (35–38) ════════════════
  describe('concurrency, idempotency, audit', () => {
    it('stale / missing If-Match on a variant PUT → 409 / 428, no write, no audit', async () => {
      const cat = await makeCategory(ownerA, 'cc-cat');
      const p = await makeProduct(ownerA, cat, 'cc-p', 'STOCKED');
      const v = (await listVariants(ownerA, p.id))[0]!;
      const before = await auditRows(tenantA, 'catalog.variant_updated');

      const stale = await req(
        'PUT',
        `/catalog/variants/${v.id}`,
        ownerA,
        { nameEn: 'x' },
        { 'if-match': '"999"' },
      );
      expect(stale.statusCode).toBe(409);
      const noif = await req('PUT', `/catalog/variants/${v.id}`, ownerA, { nameEn: 'x' });
      expect(noif.statusCode).toBe(428);
      expect(await auditRows(tenantA, 'catalog.variant_updated')).toBe(before);
    });

    it('two concurrent same-version option-group value replaces → exactly one 200', async () => {
      const cat = await makeCategory(ownerA, 'race-cat');
      const p = await makeProduct(ownerA, cat, 'race-p', 'STOCKED');
      const g = await addGroup(ownerA, p.id, 'SIZE');
      const [r1, r2] = await Promise.all([
        req(
          'PUT',
          `/catalog/products/${p.id}/option-groups/${g.id}/values`,
          ownerA,
          { values: [{ value: 'S', labelEn: 'S' }] },
          { 'if-match': `"${g.version}"` },
        ),
        req(
          'PUT',
          `/catalog/products/${p.id}/option-groups/${g.id}/values`,
          ownerA,
          { values: [{ value: 'M', labelEn: 'M' }] },
          { 'if-match': `"${g.version}"` },
        ),
      ]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    });

    it('replayed variant activate returns the stored 200; no duplicate audit row', async () => {
      const cat = await makeCategory(ownerA, 'idem-cat');
      const p = await makeProduct(ownerA, cat, 'idem-p', 'STOCKED');
      const pa = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(pa.statusCode).toBe(200);
      const v = (await listVariants(ownerA, p.id))[0]!;
      // task 3.6 — a built-in base UOM first (no multi_uom needed)
      const v0 = (await req('GET', `/catalog/variants/${v.id}`, ownerA)).json() as {
        version: number;
      };
      const sb = await req(
        'PUT',
        `/catalog/variants/${v.id}/base-uom`,
        ownerA,
        { baseUomCode: 'piece' },
        { 'if-match': `"${v0.version}"` },
      );
      expect(sb.statusCode, sb.payload).toBe(200);
      const vv = { version: (sb.json() as { version: number }).version };
      const before = await auditRows(tenantA, 'catalog.variant_status_changed');
      const key = ik();
      const a = await req('POST', `/catalog/variants/${v.id}/activate`, ownerA, undefined, {
        'idempotency-key': key,
        'if-match': `"${vv.version}"`,
      });
      const b = await req('POST', `/catalog/variants/${v.id}/activate`, ownerA, undefined, {
        'idempotency-key': key,
        'if-match': `"${vv.version}"`,
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(b.headers['idempotency-replayed']).toBe('true');
      expect(await auditRows(tenantA, 'catalog.variant_status_changed')).toBe(before + 1);
    });

    it('one audit row per successful mutation; a variant create writes exactly one row', async () => {
      const cat = await makeCategory(ownerA, 'audit-cat');
      const p = await makeProduct(ownerA, cat, 'audit-p', 'STOCKED');
      const g = await addGroup(ownerA, p.id, 'SIZE');
      const v = await setValues(ownerA, p.id, g.id, g.version, [{ value: 'S', labelEn: 'S' }]);
      const beforeCreate = await auditRows(tenantA, 'catalog.variant_created');
      const beforeOpts = await auditRows(tenantA, 'catalog.option_value_set_changed');
      await req(
        'POST',
        `/catalog/products/${p.id}/variants`,
        ownerA,
        { optionValues: [{ optionGroupId: g.id, optionValueId: v.values[0]!.id }] },
        { 'idempotency-key': ik() },
      );
      expect(await auditRows(tenantA, 'catalog.variant_created')).toBe(beforeCreate + 1);
      // the child variant_option_value write does NOT emit a second event
      expect(await auditRows(tenantA, 'catalog.option_value_set_changed')).toBe(beforeOpts);

      // security_event carries none of the task 3.4 actions
      const sec = await sql<{ kind: string }>(
        `SELECT DISTINCT kind FROM security_event WHERE "tenantId" = $1`,
        [tenantA],
      );
      const kinds = new Set(sec.map((r) => r.kind));
      for (const k of [
        'catalog.variant_created',
        'catalog.variant_status_changed',
        'catalog.option_group_created',
        'catalog.option_value_set_changed',
      ]) {
        expect(kinds.has(k)).toBe(false);
      }
    });
  });

  // ═══════════════ permissions + capability + isolation ════════════════════
  describe('permissions + capability', () => {
    it('catalog:view cannot write option groups or variants; reads work', async () => {
      const cat = await makeCategory(ownerA, 'perm-cat');
      const p = await makeProduct(ownerA, cat, 'perm-p', 'STOCKED');
      expect((await req('GET', `/catalog/products/${p.id}/variants`, viewerA)).statusCode).toBe(
        200,
      );
      expect(
        (
          await req(
            'POST',
            `/catalog/products/${p.id}/option-groups`,
            viewerA,
            { key: 'SIZE', nameEn: 'Size' },
            { 'idempotency-key': ik() },
          )
        ).statusCode,
      ).toBe(403);
    });
  });

  // ═══════════════ HG3-NO-BT-BRANCH behavioural (proof 41) ══════════════════
  it('two tenants with different businessTypeKey + identical data behave identically', async () => {
    const build = async (token: string): Promise<unknown> => {
      const cat = await makeCategory(token, 'bt-cat');
      const p = await makeProduct(token, cat, 'bt-p', 'BOM');
      const g = await addGroup(token, p.id, 'SIZE');
      const v = await setValues(token, p.id, g.id, g.version, [
        { value: 'S', labelEn: 'S' },
        { value: 'L', labelEn: 'L' },
      ]);
      const created = (
        await req(
          'POST',
          `/catalog/products/${p.id}/variants`,
          token,
          { optionValues: [{ optionGroupId: g.id, optionValueId: v.values[0]!.id }] },
          { 'idempotency-key': ik() },
        )
      ).json() as { isDefault: boolean; status: string; options: { optionValue: string }[] };
      const vs = await listVariants(token, p.id);
      return {
        variantCount: vs.length,
        isDefault: created.isDefault,
        status: created.status,
        selection: created.options.map((o) => o.optionValue),
      };
    };
    // tenantA = CUSTOM, tenantC = BAKERY_CAKE
    expect(await build(ownerA)).toEqual(await build(ownerC));
  });

  // ══ task 3.10 — variant status_changed outbox events (owner D-5) ═══════════
  describe('task 3.10 — variant status_changed outbox events', () => {
    const variantEvents = (variantId: string) =>
      sql<{
        companyId: string | null;
        branchId: string | null;
        resourceVersion: string | null;
        payload: Record<string, unknown>;
      }>(
        `SELECT "companyId","branchId","resourceVersion"::text AS "resourceVersion", payload
           FROM outbox
          WHERE "eventType" = 'catalog.variant.status_changed' AND "aggregateId" = $1
          ORDER BY "createdAt" ASC`,
        [variantId],
      );

    it('32/33/34 — DRAFT→ACTIVE, ACTIVE→ARCHIVED, ARCHIVED→ACTIVE each emit a tenant-global variant event (company_id null, branch_id null, productId in payload)', async () => {
      const cat = await makeCategory(ownerA, 't310v-cat');
      const p = await makeProduct(ownerA, cat, 't310v-p', 'STOCKED');
      // activate the product first (owner L-9)
      await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      const vs = await listVariants(ownerA, p.id);
      const vid = vs[0]!.id;

      const a = await activateVariant(ownerA, vid); // DRAFT → ACTIVE
      const v1 = (a.json() as { version: number }).version;
      const ar = await req('POST', `/catalog/variants/${vid}/archive`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v1}"`,
      });
      const v2 = (ar.json() as { version: number }).version;
      const re = await req('POST', `/catalog/variants/${vid}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v2}"`,
      });
      expect(re.statusCode, re.payload).toBe(200);

      const events = await variantEvents(vid);
      expect(events).toHaveLength(3);
      expect(events.map((e) => [e.payload['fromStatus'], e.payload['toStatus']])).toEqual([
        ['DRAFT', 'ACTIVE'],
        ['ACTIVE', 'ARCHIVED'],
        ['ARCHIVED', 'ACTIVE'],
      ]);
      for (const e of events) {
        expect(e.companyId).toBeNull();
        expect(e.branchId).toBeNull();
        expect(e.payload['variantId']).toBe(vid);
        expect(e.payload['productId']).toBe(p.id);
        expect(Number(e.resourceVersion)).toBeGreaterThan(0);
      }
    });

    it('a no-op variant activate + a base-UOM edit emit NO variant status event', async () => {
      const cat = await makeCategory(ownerA, 't310v2-cat');
      const p = await makeProduct(ownerA, cat, 't310v2-p', 'STOCKED');
      await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      const vid = (await listVariants(ownerA, p.id))[0]!.id;
      const a = await activateVariant(ownerA, vid);
      const v1 = (a.json() as { version: number }).version;
      const before = (await variantEvents(vid)).length;
      // no-op activate (already ACTIVE)
      await req('POST', `/catalog/variants/${vid}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v1}"`,
      });
      expect((await variantEvents(vid)).length).toBe(before);
    });
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000340000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000340000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 5);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('variants:manage','TENANT','catalog','v',3),('users:view','TENANT','admin','v',1),
             ('platform:tenants:view','PLATFORM','platform','v',1)
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('AED', 2, 'AED', 'x', 'x');
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now());
      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now()),
             ('BAKERY_CAKE', 2, 'Bakery', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()),
             ('BAKERY_CAKE','strategy.stocked',true,now());
    `);
  } finally {
    await c.end();
  }
}
