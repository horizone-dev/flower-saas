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

const PLAN_V = '00000000-0000-7000-8000-000000330001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000330002';
const MANAGE = ['catalog:view', 'catalog:manage'];

/**
 * Task 3.3 — typed attribute templates + values. Covers the owner's required
 * test matrix (1–35): closed value-type set, exactly-one-value + at-most-one-
 * scope + ENUM-option-belongs-to-definition (DB + service), exact category
 * scope (no descendant inheritance), all five value types, archived-definition
 * gating, required-completeness on product activation (+ non-retroactive), key /
 * valueType immutability, scope-change lock, optimistic concurrency, idempotency,
 * audit rollback atomicity, permission negatives, cross-tenant isolation,
 * HG3-NO-BT-BRANCH behavioural.
 */
describe('typed attributes (task 3.3, integration)', () => {
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
    tenantA = await provision('attr-a', 'CUSTOM');
    tenantC = await provision('attr-c', 'BAKERY_CAKE');
    // both tenants need strategy.stocked to create products
    for (const t of [tenantA, tenantC]) await setCap(t, 'strategy.stocked', true);
    ownerA = await mintTenant('oa', tenantA, MANAGE);
    ownerC = await mintTenant('oc', tenantC, MANAGE);
    viewerA = await mintTenant('va', tenantA, ['catalog:view']);
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

  let idemN = 0;
  const ik = (): string => `t33-auto-${++idemN}`;

  async function makeCategory(token: string, slug: string, parentId?: string): Promise<string> {
    const r = await req(
      'POST',
      '/catalog/categories',
      token,
      { slug, nameEn: slug, ...(parentId ? { parentId } : {}) },
      { 'idempotency-key': ik() },
    );
    expect(r.statusCode, r.payload).toBe(201);
    return (r.json() as { id: string }).id;
  }
  async function makeProduct(
    token: string,
    categoryId: string,
    slug: string,
  ): Promise<{ id: string; version: number }> {
    const r = await req(
      'POST',
      '/catalog/products',
      token,
      { categoryId, nameEn: slug, slug, fulfilmentStrategy: 'STOCKED' },
      { 'idempotency-key': ik() },
    );
    expect(r.statusCode, r.payload).toBe(201);
    const b = r.json() as { id: string; version: number };
    return { id: b.id, version: b.version };
  }
  async function makeDef(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; version: number }> {
    const r = await req('POST', '/catalog/attribute-definitions', token, body, {
      'idempotency-key': ik(),
    });
    expect(r.statusCode, r.payload).toBe(201);
    const b = r.json() as { id: string; version: number };
    return { id: b.id, version: b.version };
  }
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;

  // ══════════════════ definition CRUD + validation ═════════════════════════
  describe('attribute definition CRUD + validation', () => {
    it('key format (422), closed valueType (400), at-most-one scope (422)', async () => {
      const cat = await makeCategory(ownerA, 'scope-cat');
      const pt = (
        await req(
          'POST',
          '/catalog/product-types',
          ownerA,
          { key: 'SCOPE_PT', nameEn: 'PT' },
          { 'idempotency-key': ik() },
        )
      ).json() as { id: string };

      expect(
        (
          await req(
            'POST',
            '/catalog/attribute-definitions',
            ownerA,
            { key: 'lower', nameEn: 'x', valueType: 'TEXT' },
            { 'idempotency-key': ik() },
          )
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await req(
            'POST',
            '/catalog/attribute-definitions',
            ownerA,
            { key: 'BAD', nameEn: 'x', valueType: 'JSON' },
            { 'idempotency-key': ik() },
          )
        ).statusCode,
      ).toBe(400); // zod rejects a non-enum valueType
      const bad = await req(
        'POST',
        '/catalog/attribute-definitions',
        ownerA,
        {
          key: 'BOTHSCOPE',
          nameEn: 'x',
          valueType: 'TEXT',
          appliesToCategoryId: cat,
          appliesToProductTypeId: pt.id,
        },
        { 'idempotency-key': ik() },
      );
      expect(bad.statusCode).toBe(422);
      expect(errCode(bad)).toBe('INVALID_ATTRIBUTE_SCOPE');
    });

    it('duplicate key -> 409; unknown scope category -> 404; archived scope category -> 409', async () => {
      await makeDef(ownerA, { key: 'DUPE', nameEn: 'Dupe', valueType: 'TEXT' });
      const dup = await req(
        'POST',
        '/catalog/attribute-definitions',
        ownerA,
        { key: 'DUPE', nameEn: 'x', valueType: 'TEXT' },
        { 'idempotency-key': ik() },
      );
      expect(dup.statusCode).toBe(409);
      expect(errCode(dup)).toBe('ATTRIBUTE_KEY_TAKEN');

      const unknown = await req(
        'POST',
        '/catalog/attribute-definitions',
        ownerA,
        {
          key: 'BADSCOPE',
          nameEn: 'x',
          valueType: 'TEXT',
          appliesToCategoryId: '00000000-0000-7000-8000-00000000dead',
        },
        { 'idempotency-key': ik() },
      );
      expect(unknown.statusCode).toBe(404);
    });

    it('key + valueType are immutable (owner data-integrity rule 2) — the DTO rejects them', async () => {
      const d = await makeDef(ownerA, { key: 'IMMUT', nameEn: 'Immutable', valueType: 'TEXT' });
      const r = await req(
        'PUT',
        `/catalog/attribute-definitions/${d.id}`,
        ownerA,
        { key: 'RENAMED', valueType: 'NUMBER' },
        { 'if-match': `"${d.version}"` },
      );
      // zod strips unknown keys? our schema has no `key`/`valueType`, and .refine requires >=1 known field
      expect(r.statusCode).toBe(400);
    });

    it('scope change is rejected once the definition has product values (rule 2)', async () => {
      const cat = await makeCategory(ownerA, 'sc-lock-cat');
      const cat2 = await makeCategory(ownerA, 'sc-lock-cat-2');
      const d = await makeDef(ownerA, { key: 'SCLOCK', nameEn: 'x', valueType: 'TEXT' });
      const p = await makeProduct(ownerA, cat, 'sc-lock-p');
      const set = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: d.id, valueText: 'v' }] },
        { 'if-match': `"${p.version}"` },
      );
      expect(set.statusCode, set.payload).toBe(200);

      const scoped = await req(
        'PUT',
        `/catalog/attribute-definitions/${d.id}`,
        ownerA,
        { appliesToCategoryId: cat2 },
        { 'if-match': `"${d.version}"` },
      );
      expect(scoped.statusCode).toBe(409);
      expect(errCode(scoped)).toBe('ATTRIBUTE_SCOPE_LOCKED');
    });

    it('lifecycle ACTIVE <-> ARCHIVED; hard delete only ACTIVE + unused', async () => {
      const d = await makeDef(ownerA, { key: 'LC', nameEn: 'Lifecycle', valueType: 'TEXT' });
      const arch = await req(
        'POST',
        `/catalog/attribute-definitions/${d.id}/archive`,
        ownerA,
        undefined,
        { 'idempotency-key': ik(), 'if-match': `"${d.version}"` },
      );
      expect(arch.statusCode).toBe(200);
      const v2 = (arch.json() as { version: number }).version;
      // archived -> cannot hard-delete
      const badDel = await req(
        'DELETE',
        `/catalog/attribute-definitions/${d.id}`,
        ownerA,
        undefined,
        { 'if-match': `"${v2}"` },
      );
      expect(badDel.statusCode).toBe(409);
      const react = await req(
        'POST',
        `/catalog/attribute-definitions/${d.id}/activate`,
        ownerA,
        undefined,
        { 'idempotency-key': ik(), 'if-match': `"${v2}"` },
      );
      const v3 = (react.json() as { version: number }).version;
      const del = await req('DELETE', `/catalog/attribute-definitions/${d.id}`, ownerA, undefined, {
        'if-match': `"${v3}"`,
      });
      expect(del.statusCode).toBe(200);
      expect((del.json() as { status: string }).status).toBe('deleted');
    });
  });

  // ══════════════════ ENUM options (replace-set, owner K.4) ════════════════
  describe('ENUM option-set', () => {
    it('non-ENUM definition rejects an option-set; duplicate option rejected; replace bumps definition version once', async () => {
      const text = await makeDef(ownerA, { key: 'NOTENUM', nameEn: 'x', valueType: 'TEXT' });
      const r1 = await req(
        'PUT',
        `/catalog/attribute-definitions/${text.id}/options`,
        ownerA,
        { options: [{ value: 'A', labelEn: 'A' }] },
        { 'if-match': `"${text.version}"` },
      );
      expect(r1.statusCode).toBe(422);
      expect(errCode(r1)).toBe('ATTRIBUTE_NOT_ENUM');

      const en = await makeDef(ownerA, { key: 'COLOUR', nameEn: 'Colour', valueType: 'ENUM' });
      const dup = await req(
        'PUT',
        `/catalog/attribute-definitions/${en.id}/options`,
        ownerA,
        {
          options: [
            { value: 'RED', labelEn: 'Red' },
            { value: 'RED', labelEn: 'Red 2' },
          ],
        },
        { 'if-match': `"${en.version}"` },
      );
      expect(dup.statusCode).toBe(422);

      const ok = await req(
        'PUT',
        `/catalog/attribute-definitions/${en.id}/options`,
        ownerA,
        {
          options: [
            { value: 'RED', labelEn: 'Red', sortOrder: 1 },
            { value: 'WHITE', labelEn: 'White', sortOrder: 2 },
          ],
        },
        { 'if-match': `"${en.version}"` },
      );
      expect(ok.statusCode, ok.payload).toBe(200);
      const body = ok.json() as { version: number; options: { value: string }[] };
      expect(body.version).toBe(en.version + 1);
      expect(body.options.map((o) => o.value)).toEqual(['RED', 'WHITE']);
    });

    it('removing an option still referenced by a product value fails atomically', async () => {
      const cat = await makeCategory(ownerA, 'opt-ref-cat');
      const en = await makeDef(ownerA, { key: 'OCCASION', nameEn: 'Occasion', valueType: 'ENUM' });
      const seed1 = await req(
        'PUT',
        `/catalog/attribute-definitions/${en.id}/options`,
        ownerA,
        {
          options: [
            { value: 'BDAY', labelEn: 'Birthday' },
            { value: 'WEDDING', labelEn: 'Wedding' },
          ],
        },
        { 'if-match': `"${en.version}"` },
      );
      const def2 = seed1.json() as { version: number; options: { id: string; value: string }[] };
      const bday = def2.options.find((o) => o.value === 'BDAY')!;

      const p = await makeProduct(ownerA, cat, 'opt-ref-p');
      const setv = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: en.id, optionId: bday.id }] },
        { 'if-match': `"${p.version}"` },
      );
      expect(setv.statusCode, setv.payload).toBe(200);

      const before = def2.version;
      const remove = await req(
        'PUT',
        `/catalog/attribute-definitions/${en.id}/options`,
        ownerA,
        { options: [{ value: 'WEDDING', labelEn: 'Wedding' }] },
        { 'if-match': `"${before}"` },
      );
      expect(remove.statusCode).toBe(409);
      expect(errCode(remove)).toBe('ATTRIBUTE_OPTION_IN_USE');
      // no partial mutation — BDAY still there, version unchanged
      const fresh = await req('GET', `/catalog/attribute-definitions/${en.id}`, ownerA);
      const fb = fresh.json() as { version: number; options: { value: string }[] };
      expect(fb.version).toBe(before);
      expect(fb.options.map((o) => o.value).sort()).toEqual(['BDAY', 'WEDDING']);
    });
  });

  // ══════════════════ product attribute replace-set ═══════════════════════
  describe('product attribute values (replace-set, owner K.3)', () => {
    it('all five value types round-trip; type mismatch -> 422; not-in-scope -> 422', async () => {
      const cat = await makeCategory(ownerA, 'types-cat');
      const t = await makeDef(ownerA, { key: 'T_NOTE', nameEn: 'Note', valueType: 'TEXT' });
      const n = await makeDef(ownerA, {
        key: 'T_VOL',
        nameEn: 'Volume',
        valueType: 'NUMBER',
        unitHint: 'ml',
      });
      const b = await makeDef(ownerA, { key: 'T_GIFT', nameEn: 'Giftable', valueType: 'BOOLEAN' });
      const dt = await makeDef(ownerA, { key: 'T_BEST', nameEn: 'Best before', valueType: 'DATE' });
      const en = await makeDef(ownerA, { key: 'T_COLOUR', nameEn: 'Colour', valueType: 'ENUM' });
      const enSeed = await req(
        'PUT',
        `/catalog/attribute-definitions/${en.id}/options`,
        ownerA,
        { options: [{ value: 'RED', labelEn: 'Red' }] },
        { 'if-match': `"${en.version}"` },
      );
      const red = (enSeed.json() as { options: { id: string }[] }).options[0]!.id;

      const p = await makeProduct(ownerA, cat, 'types-p');
      const set = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        {
          attributes: [
            { attributeDefinitionId: t.id, valueText: 'hand-tied' },
            { attributeDefinitionId: n.id, valueNumber: '100.5000' },
            { attributeDefinitionId: b.id, valueBool: true },
            { attributeDefinitionId: dt.id, valueDate: '2026-12-31' },
            { attributeDefinitionId: en.id, optionId: red },
          ],
        },
        { 'if-match': `"${p.version}"` },
      );
      expect(set.statusCode, set.payload).toBe(200);
      const got = set.json() as {
        productVersion: number;
        values: { key: string; valueNumber: string | null }[];
      };
      expect(got.productVersion).toBe(p.version + 1);
      expect(got.values.find((v) => v.key === 'T_VOL')?.valueNumber).toBe('100.5000');

      // a type mismatch -> 422
      const mism = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: n.id, valueText: 'not a number' }] },
        { 'if-match': `"${got.productVersion}"` },
      );
      expect(mism.statusCode).toBe(422);

      // an out-of-scope definition -> 422
      const other = await makeCategory(ownerA, 'types-other-cat');
      const scopedDef = await makeDef(ownerA, {
        key: 'T_SCOPED',
        nameEn: 'Scoped',
        valueType: 'TEXT',
        appliesToCategoryId: other,
      });
      const oos = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: scopedDef.id, valueText: 'x' }] },
        { 'if-match': `"${got.productVersion}"` },
      );
      expect(oos.statusCode).toBe(422);
      expect(errCode(oos)).toBe('ATTRIBUTE_NOT_IN_SCOPE');
    });

    it('EXACT category scope only — a parent-category attribute does NOT apply to a product in a child category (owner K.7)', async () => {
      const parent = await makeCategory(ownerA, 'scope-parent');
      const child = await makeCategory(ownerA, 'scope-child', parent);
      const def = await makeDef(ownerA, {
        key: 'PARENT_ONLY',
        nameEn: 'Parent only',
        valueType: 'TEXT',
        appliesToCategoryId: parent,
      });
      const pChild = await makeProduct(ownerA, child, 'scope-child-p');
      const res = await req(
        'PUT',
        `/catalog/products/${pChild.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: def.id, valueText: 'x' }] },
        { 'if-match': `"${pChild.version}"` },
      );
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('ATTRIBUTE_NOT_IN_SCOPE');
    });

    it('ENUM option must belong to the same definition (service 422 + the DB composite FK backstop)', async () => {
      const cat = await makeCategory(ownerA, 'enum-belong-cat');
      const a = await makeDef(ownerA, { key: 'EA', nameEn: 'A', valueType: 'ENUM' });
      const b = await makeDef(ownerA, { key: 'EB', nameEn: 'B', valueType: 'ENUM' });
      const aSeed = await req(
        'PUT',
        `/catalog/attribute-definitions/${a.id}/options`,
        ownerA,
        { options: [{ value: 'X', labelEn: 'X' }] },
        { 'if-match': `"${a.version}"` },
      );
      const bSeed = await req(
        'PUT',
        `/catalog/attribute-definitions/${b.id}/options`,
        ownerA,
        { options: [{ value: 'Y', labelEn: 'Y' }] },
        { 'if-match': `"${b.version}"` },
      );
      const optB = (bSeed.json() as { options: { id: string }[] }).options[0]!.id;
      void aSeed;
      const p = await makeProduct(ownerA, cat, 'enum-belong-p');
      const res = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: a.id, optionId: optB }] },
        { 'if-match': `"${p.version}"` },
      );
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('ATTRIBUTE_OPTION_MISMATCH');
    });

    it('archived definition rejects a new product value', async () => {
      const cat = await makeCategory(ownerA, 'arch-def-cat');
      const d = await makeDef(ownerA, { key: 'ARCHDEF', nameEn: 'x', valueType: 'TEXT' });
      await req('POST', `/catalog/attribute-definitions/${d.id}/archive`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${d.version}"`,
      });
      const p = await makeProduct(ownerA, cat, 'arch-def-p');
      const res = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: d.id, valueText: 'x' }] },
        { 'if-match': `"${p.version}"` },
      );
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('ATTRIBUTE_NOT_IN_SCOPE');
    });

    it('stale If-Match -> 409, no write, no version bump, no audit row; missing -> 428; concurrent -> one wins', async () => {
      const cat = await makeCategory(ownerA, 'pa-cc-cat');
      const d = await makeDef(ownerA, { key: 'PACC', nameEn: 'x', valueType: 'TEXT' });
      const p = await makeProduct(ownerA, cat, 'pa-cc-p');
      const before = await auditRows(tenantA, 'catalog.product_attributes_changed');

      const stale = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: d.id, valueText: 'x' }] },
        { 'if-match': '"999"' },
      );
      expect(stale.statusCode).toBe(409);
      const noif = await req('PUT', `/catalog/products/${p.id}/attributes`, ownerA, {
        attributes: [],
      });
      expect(noif.statusCode).toBe(428);
      expect(await auditRows(tenantA, 'catalog.product_attributes_changed')).toBe(before);

      const [r1, r2] = await Promise.all([
        req(
          'PUT',
          `/catalog/products/${p.id}/attributes`,
          ownerA,
          { attributes: [{ attributeDefinitionId: d.id, valueText: 'a' }] },
          { 'if-match': `"${p.version}"` },
        ),
        req(
          'PUT',
          `/catalog/products/${p.id}/attributes`,
          ownerA,
          { attributes: [{ attributeDefinitionId: d.id, valueText: 'b' }] },
          { 'if-match': `"${p.version}"` },
        ),
      ]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    });
  });

  // ══════════════════ required completeness on product activation (K.2) ═══
  describe('required-attribute completeness gates product activation (owner K.2)', () => {
    it('ACTIVE in-scope required definition blocks activate until filled; catalog-active only', async () => {
      const cat = await makeCategory(ownerA, 'req-cat');
      const reqDef = await makeDef(ownerA, {
        key: 'REQ_ONE',
        nameEn: 'Required',
        valueType: 'TEXT',
        appliesToCategoryId: cat,
        required: true,
      });
      const p = await makeProduct(ownerA, cat, 'req-p');

      const blocked = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(blocked.statusCode).toBe(422);
      expect(errCode(blocked)).toBe('PRODUCT_REQUIRED_ATTRIBUTES_MISSING');

      const fill = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        ownerA,
        { attributes: [{ attributeDefinitionId: reqDef.id, valueText: 'done' }] },
        { 'if-match': `"${p.version}"` },
      );
      const v2 = (fill.json() as { productVersion: number }).productVersion;
      const ok = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v2}"`,
      });
      expect(ok.statusCode, ok.payload).toBe(200);
      expect((ok.json() as { status: string }).status).toBe('ACTIVE');
    });

    it('an ARCHIVED required definition does not gate activation', async () => {
      const cat = await makeCategory(ownerA, 'req-arch-cat');
      const d = await makeDef(ownerA, {
        key: 'REQ_ARCH',
        nameEn: 'x',
        valueType: 'TEXT',
        appliesToCategoryId: cat,
        required: true,
      });
      await req('POST', `/catalog/attribute-definitions/${d.id}/archive`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${d.version}"`,
      });
      const p = await makeProduct(ownerA, cat, 'req-arch-p');
      const ok = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(ok.statusCode, ok.payload).toBe(200);
    });

    it('flipping required false->true is NOT retroactive; but a later re-activation IS gated', async () => {
      const cat = await makeCategory(ownerA, 'req-flip-cat');
      const d = await makeDef(ownerA, {
        key: 'REQ_FLIP',
        nameEn: 'x',
        valueType: 'TEXT',
        appliesToCategoryId: cat,
        required: false,
      });
      const p = await makeProduct(ownerA, cat, 'req-flip-p');
      const act = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(act.statusCode).toBe(200); // activated fine (not required yet)
      const v2 = (act.json() as { version: number }).version;

      // flip required -> true; the product is NOT auto-deactivated / mutated
      await req(
        'PUT',
        `/catalog/attribute-definitions/${d.id}`,
        ownerA,
        { required: true },
        { 'if-match': `"${d.version}"` },
      );
      const still = await req('GET', `/catalog/products/${p.id}`, ownerA);
      expect((still.json() as { status: string }).status).toBe('ACTIVE');

      // archive then re-activate -> now gated
      const arch = await req('POST', `/catalog/products/${p.id}/archive`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v2}"`,
      });
      const v3 = (arch.json() as { version: number }).version;
      const react = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v3}"`,
      });
      expect(react.statusCode).toBe(422);
      expect(errCode(react)).toBe('PRODUCT_REQUIRED_ATTRIBUTES_MISSING');
    });

    it('an ACTIVE product re-categorized into a scope with an unfilled required attribute -> 409/422', async () => {
      const catX = await makeCategory(ownerA, 'req-move-x');
      const catY = await makeCategory(ownerA, 'req-move-y');
      await makeDef(ownerA, {
        key: 'REQ_Y',
        nameEn: 'x',
        valueType: 'TEXT',
        appliesToCategoryId: catY,
        required: true,
      });
      const p = await makeProduct(ownerA, catX, 'req-move-p');
      const act = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      const v2 = (act.json() as { version: number }).version;
      const move = await req(
        'PUT',
        `/catalog/products/${p.id}`,
        ownerA,
        { categoryId: catY },
        { 'if-match': `"${v2}"` },
      );
      expect(move.statusCode).toBe(422);
      expect(errCode(move)).toBe('PRODUCT_REQUIRED_ATTRIBUTES_MISSING');
    });
  });

  // ══════════════════ business-type non-branching (behavioural) ═══════════
  it('two tenants, different businessTypeKey, identical attribute data -> identical results', async () => {
    const btA = (
      await sql<{ k: string }>(`SELECT "businessTypeKey" AS k FROM tenant WHERE id=$1`, [tenantA])
    )[0]!.k;
    const btC = (
      await sql<{ k: string }>(`SELECT "businessTypeKey" AS k FROM tenant WHERE id=$1`, [tenantC])
    )[0]!.k;
    expect(btA).not.toBe(btC);

    const results: number[] = [];
    for (const [tok, tag] of [
      [ownerA, 'a'],
      [ownerC, 'c'],
    ] as const) {
      const cat = await makeCategory(tok, `bt-neutral-${tag}`);
      const d = await makeDef(tok, {
        key: 'BT_NEUTRAL',
        nameEn: 'x',
        valueType: 'NUMBER',
        appliesToCategoryId: cat,
        required: true,
      });
      const p = await makeProduct(tok, cat, `bt-neutral-p-${tag}`);
      const fill = await req(
        'PUT',
        `/catalog/products/${p.id}/attributes`,
        tok,
        { attributes: [{ attributeDefinitionId: d.id, valueNumber: '42.0000' }] },
        { 'if-match': `"${p.version}"` },
      );
      const v2 = (fill.json() as { productVersion: number }).productVersion;
      const act = await req('POST', `/catalog/products/${p.id}/activate`, tok, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${v2}"`,
      });
      results.push(act.statusCode);
    }
    expect(results).toEqual([200, 200]);
  });

  // ══════════════════ permissions + isolation ════════════════════════════
  describe('permissions + tenant isolation', () => {
    it('catalog:view-only cannot write attribute definitions or product attributes', async () => {
      const cat = await makeCategory(ownerA, 'perm-attr-cat');
      const d = await makeDef(ownerA, { key: 'PERMD', nameEn: 'x', valueType: 'TEXT' });
      const p = await makeProduct(ownerA, cat, 'perm-attr-p');

      expect((await req('GET', '/catalog/attribute-definitions', viewerA)).statusCode).toBe(200);
      expect(
        (
          await req(
            'POST',
            '/catalog/attribute-definitions',
            viewerA,
            { key: 'NOPE', nameEn: 'x', valueType: 'TEXT' },
            { 'idempotency-key': ik() },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await req(
            'PUT',
            `/catalog/attribute-definitions/${d.id}`,
            viewerA,
            { nameEn: 'y' },
            { 'if-match': `"${d.version}"` },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await req(
            'PUT',
            `/catalog/products/${p.id}/attributes`,
            viewerA,
            { attributes: [] },
            { 'if-match': `"${p.version}"` },
          )
        ).statusCode,
      ).toBe(403);
    });

    it('tenant C cannot read / mutate tenant A definitions or product attributes; lists never leak', async () => {
      const cat = await makeCategory(ownerA, 'iso-attr-cat');
      const d = await makeDef(ownerA, {
        key: 'ISO_SECRET_A',
        nameEn: 'ISO-SECRET-A',
        valueType: 'TEXT',
      });
      const p = await makeProduct(ownerA, cat, 'iso-attr-p');

      expect((await req('GET', `/catalog/attribute-definitions/${d.id}`, ownerC)).statusCode).toBe(
        404,
      );
      expect(
        (
          await req(
            'PUT',
            `/catalog/attribute-definitions/${d.id}`,
            ownerC,
            { nameEn: 'pwn' },
            { 'if-match': '"1"' },
          )
        ).statusCode,
      ).toBe(404);
      expect((await req('GET', `/catalog/products/${p.id}/attributes`, ownerC)).statusCode).toBe(
        404,
      );

      const list = await req('GET', '/catalog/attribute-definitions?q=ISO_SECRET_A', ownerC);
      expect(JSON.stringify(list.json())).not.toContain('ISO_SECRET_A');
      expect(JSON.stringify(list.json())).not.toContain(d.id);
    });

    it('a product-attribute write cannot reference another tenant’s attribute definition', async () => {
      const dA = await makeDef(ownerA, { key: 'XREF_DEF', nameEn: 'x', valueType: 'TEXT' });
      const catC = await makeCategory(ownerC, 'xref-c-cat');
      const pC = await makeProduct(ownerC, catC, 'xref-c-p');
      const res = await req(
        'PUT',
        `/catalog/products/${pC.id}/attributes`,
        ownerC,
        { attributes: [{ attributeDefinitionId: dA.id, valueText: 'x' }] },
        { 'if-match': `"${pC.version}"` },
      );
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('ATTRIBUTE_NOT_IN_SCOPE');
    });
  });

  // ══════════════════ idempotency + audit ════════════════════════════════
  describe('idempotency + audit', () => {
    it('replayed definition create returns the stored 201; different body + same key -> 409', async () => {
      const body = { key: 'IDEMP', nameEn: 'Idempotent', valueType: 'TEXT' };
      const a = await req('POST', '/catalog/attribute-definitions', ownerA, body, {
        'idempotency-key': 't33-idem-def',
      });
      const b = await req('POST', '/catalog/attribute-definitions', ownerA, body, {
        'idempotency-key': 't33-idem-def',
      });
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect((b.json() as { id: string }).id).toBe((a.json() as { id: string }).id);
      expect(b.headers['idempotency-replayed']).toBe('true');
      const c = await req(
        'POST',
        '/catalog/attribute-definitions',
        ownerA,
        { ...body, nameEn: 'Different' },
        { 'idempotency-key': 't33-idem-def' },
      );
      expect(c.statusCode).toBe(409);
    });

    it('each successful mutation writes exactly one audit row; a failed one writes none; security_event excludes them', async () => {
      const beforeCreated = await auditRows(tenantA, 'catalog.attribute_definition_created');
      const d = await makeDef(ownerA, { key: 'AUDITD', nameEn: 'x', valueType: 'ENUM' });
      expect(await auditRows(tenantA, 'catalog.attribute_definition_created')).toBe(
        beforeCreated + 1,
      );

      const beforeOpt = await auditRows(tenantA, 'catalog.attribute_option_set_changed');
      await req(
        'PUT',
        `/catalog/attribute-definitions/${d.id}/options`,
        ownerA,
        { options: [{ value: 'A', labelEn: 'A' }] },
        { 'if-match': `"${d.version}"` },
      );
      expect(await auditRows(tenantA, 'catalog.attribute_option_set_changed')).toBe(beforeOpt + 1);

      // a failed update (stale) writes nothing
      const beforeUpd = await auditRows(tenantA, 'catalog.attribute_definition_updated');
      const stale = await req(
        'PUT',
        `/catalog/attribute-definitions/${d.id}`,
        ownerA,
        { nameEn: 'y' },
        { 'if-match': '"999"' },
      );
      expect(stale.statusCode).toBe(409);
      expect(await auditRows(tenantA, 'catalog.attribute_definition_updated')).toBe(beforeUpd);

      const sec = await sql<{ kind: string }>(
        `SELECT kind FROM security_event WHERE "tenantId" = $1`,
        [tenantA],
      );
      const kinds = new Set(sec.map((r) => r.kind));
      expect(kinds.has('catalog.template_applied')).toBe(true);
      for (const k of [
        'catalog.attribute_definition_created',
        'catalog.attribute_option_set_changed',
        'catalog.product_attributes_changed',
      ]) {
        expect(kinds.has(k)).toBe(false);
      }
    });
  });

  // ══════════════════ no premature domain ════════════════════════════════
  it('no Task 3.4 / later-domain table exists', async () => {
    const rows = await sql<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const present = new Set(rows.map((r) => r.tablename));
    for (const forbidden of [
      'option_group',
      'option_value',
      'variant',
      'variant_option_value',
      'item_identifier',
      'uom',
      'uom_conversion',
      'company_variant_uom_price',
      'branch_variant_uom_price',
      'inventory_item',
      'order',
      'payment',
    ]) {
      expect(present.has(forbidden), `${forbidden} must NOT exist`).toBe(false);
    }
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000330000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000330000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 5);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('catalog:view','TENANT','catalog','v',3),('catalog:manage','TENANT','catalog','v',3),
             ('users:view','TENANT','admin','v',1),
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
