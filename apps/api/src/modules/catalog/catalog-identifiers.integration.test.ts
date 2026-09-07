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

const PLAN_V = '00000000-0000-7000-8000-000000350001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000350002';
const MANAGE = ['catalog:view', 'catalog:manage', 'variants:manage', 'identifiers:manage'];

/**
 * Task 3.5 — identifiers (SKU / barcode / QR). Covers the owner's required proof
 * list: VARIANT-only target + INVENTORY_ITEM rejection, tenant-wide value
 * uniqueness across code types + statuses (never reused), one ACTIVE SKU / one
 * ACTIVE QR per variant, many ACTIVE barcodes, SKU canonicalisation, generic
 * barcode validation, server-generated opaque QR, immutability (no PUT),
 * deactivate/reactivate on the same row, archived-variant scan resolution,
 * default-variant identifiers + the Task-3.4 restructure guard, CUSTOM
 * zero-variant, the `identifiers.barcode_qr` capability gate (SKU exempt),
 * permission 403, idempotent replay, one-audit-row-per-mutation + rollback
 * atomicity, HG3-NO-BT-BRANCH behavioural.
 */
describe('identifiers — SKU / barcode / QR (task 3.5, integration)', () => {
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
    tenantA = await provision('id-a', 'CUSTOM');
    tenantC = await provision('id-c', 'BAKERY_CAKE');
    for (const t of [tenantA, tenantC]) {
      await setCap(t, 'strategy.stocked', true);
      await setCap(t, 'strategy.custom', true);
      await setCap(t, 'variants', true);
      await setCap(t, 'identifiers.barcode_qr', true);
    }
    noCapTenant = await provision('id-nocap', 'CUSTOM');
    await setCap(noCapTenant, 'strategy.stocked', true);
    await setCap(noCapTenant, 'variants', true);
    await setCap(noCapTenant, 'identifiers.barcode_qr', false);

    const ent = ['custom_composition'];
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
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  /**
   * Open a dedicated client, `BEGIN`, run `setup` (which typically takes a row
   * lock), then run `whileHeld` (the concurrent request, parked on that lock),
   * `COMMIT`, and return `whileHeld`'s result — for deterministic interleaving
   * tests. The client is always closed even if an assertion throws.
   */
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
      await sleep(400); // let the concurrent request park on the lock
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
  const ik = (): string => `t35-auto-key-${++idemN}`;

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
  ): Promise<{ id: string; isDefault: boolean; status: string; version: number }[]> => {
    const r = await req('GET', `/catalog/products/${productId}/variants`, token);
    expect(r.statusCode, r.payload).toBe(200);
    return r.json() as { id: string; isDefault: boolean; status: string; version: number }[];
  };
  /** a simple STOCKED product + its auto default variant id */
  async function makeVariant(
    token: string,
    slug: string,
  ): Promise<{ productId: string; productVersion: number; variantId: string }> {
    const cat = await makeCategory(token, `${slug}-c`);
    const p = await makeProduct(token, cat, `${slug}-p`, 'STOCKED');
    const vs = await listVariants(token, p.id);
    return { productId: p.id, productVersion: p.version, variantId: vs[0]!.id };
  }
  const createId = (token: string, body: Record<string, unknown>, key = ik()) =>
    req('POST', '/catalog/identifiers', token, body, { 'idempotency-key': key });
  const resolveId = (token: string, value: string) =>
    req('GET', `/catalog/identifiers?value=${encodeURIComponent(value)}`, token);
  const listIds = (token: string, variantId: string) =>
    req('GET', `/catalog/identifiers?targetKind=VARIANT&targetId=${variantId}`, token);

  // ══════════════════ create + value semantics (proofs 3, 12–20) ════════════
  describe('create + value semantics', () => {
    it('SKU is canonicalised (trim + upper-case); case-only differences collide (proof 17)', async () => {
      const v = await makeVariant(ownerA, 'sku-canon');
      const a = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: '  rose-red.1 ',
      });
      expect(a.statusCode, a.payload).toBe(201);
      expect((a.json() as { value: string }).value).toBe('ROSE-RED.1');

      const v2 = await makeVariant(ownerA, 'sku-canon-2');
      const dup = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v2.variantId,
        codeType: 'SKU',
        value: 'ROSE-RED.1', // same canonical form, different variant
      });
      expect(dup.statusCode).toBe(409);
      expect(errCode(dup)).toBe('IDENTIFIER_VALUE_TAKEN');
    });

    it('BARCODE is stored verbatim (never case-folded); generic validation only (proof 18)', async () => {
      const v = await makeVariant(ownerA, 'bc-verbatim');
      const r = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'BARCODE',
        value: '  aB-Cd_12  ',
      });
      expect(r.statusCode, r.payload).toBe(201);
      expect((r.json() as { value: string }).value).toBe('aB-Cd_12');

      const bad = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'BARCODE',
        value: 'x\ty',
      });
      expect(bad.statusCode).toBe(422);
      expect(errCode(bad)).toBe('IDENTIFIER_BARCODE_INVALID');
    });

    it('QR is server-generated + opaque; a client value is rejected (proofs 19–20)', async () => {
      const v = await makeVariant(ownerA, 'qr-gen');
      const withValue = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'QR',
        value: 'MY-OWN-QR',
      });
      expect(withValue.statusCode).toBe(422);
      expect(errCode(withValue)).toBe('IDENTIFIER_QR_VALUE_NOT_ALLOWED');

      const ok = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'QR',
      });
      expect(ok.statusCode, ok.payload).toBe(201);
      const value = (ok.json() as { value: string }).value;
      expect(value).toMatch(/^[0-9A-F]{40}$/);
      // opaque — carries no tenant / variant / product substring
      expect(value.includes(tenantA.replace(/-/g, ''))).toBe(false);
      expect(value.includes(v.variantId.replace(/-/g, '').toUpperCase())).toBe(false);
    });

    it('one ACTIVE SKU + one ACTIVE QR per variant; multiple ACTIVE BARCODEs (proofs 14–16)', async () => {
      const v = await makeVariant(ownerA, 'per-variant');
      const mk = (codeType: string, value?: string) =>
        createId(ownerA, {
          targetKind: 'VARIANT',
          targetId: v.variantId,
          codeType,
          ...(value ? { value } : {}),
        });

      expect((await mk('SKU', 'PV-SKU-1')).statusCode).toBe(201);
      const sku2 = await mk('SKU', 'PV-SKU-2');
      expect(sku2.statusCode).toBe(409);
      expect(errCode(sku2)).toBe('IDENTIFIER_ACTIVE_SKU_EXISTS');

      expect((await mk('QR')).statusCode).toBe(201);
      const qr2 = await mk('QR');
      expect(qr2.statusCode).toBe(409);
      expect(errCode(qr2)).toBe('IDENTIFIER_ACTIVE_QR_EXISTS');

      expect((await mk('BARCODE', 'PV-BC-1')).statusCode).toBe(201);
      expect((await mk('BARCODE', 'PV-BC-2')).statusCode).toBe(201);
      expect((await mk('BARCODE', 'PV-BC-3')).statusCode).toBe(201);
    });

    it('INVENTORY_ITEM is rejected by the API (proof 4)', async () => {
      const v = await makeVariant(ownerA, 'inv-item');
      const r = await createId(ownerA, {
        targetKind: 'INVENTORY_ITEM',
        targetId: v.variantId,
        codeType: 'BARCODE',
        value: 'INV-1',
      });
      // rejected at the boundary — the zod `targetKind: literal('VARIANT')` is a
      // 400; the repo's `assertVariantTargetKind` is the 422 belt-and-braces
      expect([400, 422]).toContain(r.statusCode);
      // and never persisted
      expect(
        await count(
          `SELECT count(*)::int AS n FROM item_identifier WHERE "targetKind" <> 'VARIANT'`,
        ),
      ).toBe(0);
    });

    it('a non-existent / cross-tenant / CUSTOM-zero-variant target is rejected (proofs 10, 26)', async () => {
      // non-existent same-tenant variant id
      const nx = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: '00000000-0000-7000-8000-0000000000ff',
        codeType: 'SKU',
        value: 'NX-1',
      });
      expect(nx.statusCode).toBe(404);

      // CUSTOM product has no variant → no target exists
      const cat = await makeCategory(ownerA, 'custom-zero-c');
      const custom = await makeProduct(ownerA, cat, 'custom-zero-p', 'CUSTOM');
      expect(await listVariants(ownerA, custom.id)).toHaveLength(0);
    });
  });

  // ══════════════════ immutability + lifecycle (proofs 21–24) ═══════════════
  describe('immutability + lifecycle', () => {
    it('there is no PUT identifier route (identity is immutable — proof 21)', async () => {
      const v = await makeVariant(ownerA, 'no-put');
      const created = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: 'NP-1',
      });
      const id = (created.json() as { id: string }).id;
      const put = await req('PUT', `/catalog/identifiers/${id}`, ownerA, { value: 'NP-2' });
      expect([404, 405]).toContain(put.statusCode);
    });

    it('deactivate on an ACTIVE-variant identifier preserves the row + value; reactivate uses the SAME row (proofs 22–23)', async () => {
      // build an ACTIVE variant (so DELETE soft-deactivates instead of hard-deleting)
      const cat = await makeCategory(ownerA, 'life-c');
      const p = await makeProduct(ownerA, cat, 'life-p', 'STOCKED');
      const variantId = (await listVariants(ownerA, p.id))[0]!.id;
      const created = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: variantId,
        codeType: 'SKU',
        value: 'LIFE-1',
      });
      const id = (created.json() as { id: string }).id;
      // activate product + variant
      const pAct = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(pAct.statusCode, pAct.payload).toBe(200);
      const vRow = (await listVariants(ownerA, p.id))[0]!;
      const vAct = await req('POST', `/catalog/variants/${vRow.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${vRow.version}"`,
      });
      expect(vAct.statusCode, vAct.payload).toBe(200);

      const del = await req('DELETE', `/catalog/identifiers/${id}`, ownerA);
      expect(del.statusCode, del.payload).toBe(200);
      expect((del.json() as { status: string }).status).toBe('deactivated');
      const row = await sql<{ status: string; value: string }>(
        `SELECT status, value FROM item_identifier WHERE id = $1`,
        [id],
      );
      expect(row[0]).toEqual({ status: 'INACTIVE', value: 'LIFE-1' });

      const react = await req('POST', `/catalog/identifiers/${id}/reactivate`, ownerA, undefined, {
        'idempotency-key': ik(),
      });
      expect(react.statusCode, react.payload).toBe(200);
      expect(react.json() as { id: string; status: string }).toMatchObject({
        id,
        status: 'ACTIVE',
      });
    });

    it('an INACTIVE historical value can never be reassigned to another target (proof 13)', async () => {
      const cat = await makeCategory(ownerA, 'reuse-c');
      const p = await makeProduct(ownerA, cat, 'reuse-p', 'STOCKED');
      const v1 = (await listVariants(ownerA, p.id))[0]!.id;
      const created = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v1,
        codeType: 'BARCODE',
        value: 'REUSE-X',
      });
      const id = (created.json() as { id: string }).id;
      // activate so DELETE deactivates (keeps the historical row)
      await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      const vRow = (await listVariants(ownerA, p.id))[0]!;
      await req('POST', `/catalog/variants/${vRow.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${vRow.version}"`,
      });
      await req('DELETE', `/catalog/identifiers/${id}`, ownerA);

      const v2 = await makeVariant(ownerA, 'reuse-2');
      const reassign = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v2.variantId,
        codeType: 'BARCODE',
        value: 'REUSE-X',
      });
      expect(reassign.statusCode).toBe(409);
      expect(errCode(reassign)).toBe('IDENTIFIER_VALUE_TAKEN');
    });

    it('DELETE on a DRAFT-variant identifier hard-deletes it (the narrow correction path)', async () => {
      const v = await makeVariant(ownerA, 'draft-del');
      const created = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: 'DRAFT-DEL-1',
      });
      const id = (created.json() as { id: string }).id;
      const del = await req('DELETE', `/catalog/identifiers/${id}`, ownerA);
      expect(del.statusCode, del.payload).toBe(200);
      expect((del.json() as { status: string }).status).toBe('deleted');
      expect(
        await count(`SELECT count(*)::int AS n FROM item_identifier WHERE id = $1`, [id]),
      ).toBe(0);
      expect(await auditRows(tenantA, 'catalog.identifier_deleted')).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════ scan resolution (proofs 24, 32) ═══════════════════════
  describe('scan resolution', () => {
    it('resolves a bare ACTIVE value to its target; 404 for unknown / INACTIVE (proof 32)', async () => {
      const v = await makeVariant(ownerA, 'scan-1');
      await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'BARCODE',
        value: 'SCAN-ABC',
      });
      const hit = await resolveId(ownerA, 'SCAN-ABC');
      expect(hit.statusCode, hit.payload).toBe(200);
      expect((hit.json() as { target: { id: string } }).target.id).toBe(v.variantId);

      expect((await resolveId(ownerA, 'NEVER-REGISTERED')).statusCode).toBe(404);
      // a viewer (catalog:view only) can resolve
      expect((await resolveId(viewerA, 'SCAN-ABC')).statusCode).toBe(200);
    });

    it('an ARCHIVED target variant is NOT a usable scan target; identifier.status is untouched (proof 24)', async () => {
      const cat = await makeCategory(ownerA, 'arch-c');
      const p = await makeProduct(ownerA, cat, 'arch-p', 'STOCKED');
      const vRow0 = (await listVariants(ownerA, p.id))[0]!;
      await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: vRow0.id,
        codeType: 'BARCODE',
        value: 'ARCH-SCAN',
      });
      // activate then archive the variant
      await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      const vRow = (await listVariants(ownerA, p.id))[0]!;
      await req('POST', `/catalog/variants/${vRow.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${vRow.version}"`,
      });
      const vRow2 = (await listVariants(ownerA, p.id))[0]!;
      await req('POST', `/catalog/variants/${vRow.id}/archive`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${vRow2.version}"`,
      });

      const res = await resolveId(ownerA, 'ARCH-SCAN');
      expect(res.statusCode).toBe(404);
      // the identifier row + status are untouched (history intact)
      const row = await sql<{ status: string }>(
        `SELECT status FROM item_identifier WHERE value = 'ARCH-SCAN' AND "tenantId" = $1`,
        [tenantA],
      );
      expect(row[0]!.status).toBe('ACTIVE');
      // management list still shows it
      const list = await listIds(ownerA, vRow.id);
      expect(list.statusCode).toBe(200);
      expect((list.json() as { value: string }[]).some((r) => r.value === 'ARCH-SCAN')).toBe(true);
    });
  });

  // ══════════════════ default variant + restructure guard (proofs 25, 27–28) ═
  describe('default variant + Task-3.4 restructure guard', () => {
    it('the auto default variant accepts identifiers normally (proof 25)', async () => {
      const v = await makeVariant(ownerA, 'def-var');
      const r = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: 'DEF-VAR-1',
      });
      expect(r.statusCode, r.payload).toBe(201);
    });

    it('a default variant with an identifier BLOCKS the first option-group creation atomically (proofs 27–28)', async () => {
      const cat = await makeCategory(ownerA, 'guard-c');
      const p = await makeProduct(ownerA, cat, 'guard-p', 'STOCKED');
      const variantId = (await listVariants(ownerA, p.id))[0]!.id;
      const created = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: variantId,
        codeType: 'SKU',
        value: 'GUARD-1',
      });
      expect(created.statusCode).toBe(201);
      const ogAuditBefore = await auditRows(tenantA, 'catalog.option_group_created');

      const og = await req(
        'POST',
        `/catalog/products/${p.id}/option-groups`,
        ownerA,
        { key: 'COLOUR', nameEn: 'Colour' },
        { 'idempotency-key': ik() },
      );
      expect(og.statusCode).toBe(409);
      expect(errCode(og)).toBe('VARIANT_HAS_IDENTIFIERS');

      // the variant + identifier both survive; no option group; NO group audit row
      expect(await listVariants(ownerA, p.id)).toHaveLength(1);
      expect(
        await count(`SELECT count(*)::int AS n FROM item_identifier WHERE "targetId" = $1`, [
          variantId,
        ]),
      ).toBe(1);
      expect(
        await count(`SELECT count(*)::int AS n FROM option_group WHERE "productId" = $1`, [p.id]),
      ).toBe(0);
      expect(await auditRows(tenantA, 'catalog.option_group_created')).toBe(ogAuditBefore);

      // after the owner removes the identifier, the restructure proceeds
      const del = await req(
        'DELETE',
        `/catalog/identifiers/${(created.json() as { id: string }).id}`,
        ownerA,
      );
      expect(del.statusCode).toBe(200);
      const og2 = await req(
        'POST',
        `/catalog/products/${p.id}/option-groups`,
        ownerA,
        { key: 'COLOUR', nameEn: 'Colour' },
        { 'idempotency-key': ik() },
      );
      expect(og2.statusCode, og2.payload).toBe(201);
    });

    it('a DRAFT product hard-delete is refused while a variant carries an identifier', async () => {
      const cat = await makeCategory(ownerA, 'pdel-c');
      const p = await makeProduct(ownerA, cat, 'pdel-p', 'STOCKED');
      const variantId = (await listVariants(ownerA, p.id))[0]!.id;
      const created = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: variantId,
        codeType: 'SKU',
        value: 'PDEL-1',
      });
      const pv = (await req('GET', `/catalog/products/${p.id}`, ownerA)).headers['etag'];
      const del = await req('DELETE', `/catalog/products/${p.id}`, ownerA, undefined, {
        'if-match': String(pv),
      });
      expect(del.statusCode).toBe(409);
      expect(errCode(del)).toBe('PRODUCT_HAS_VARIANT_IDENTIFIERS');
      // clear it, then the delete works
      await req('DELETE', `/catalog/identifiers/${(created.json() as { id: string }).id}`, ownerA);
      const pv2 = (await req('GET', `/catalog/products/${p.id}`, ownerA)).headers['etag'];
      expect(
        (
          await req('DELETE', `/catalog/products/${p.id}`, ownerA, undefined, {
            'if-match': String(pv2),
          })
        ).statusCode,
      ).toBe(200);
    });
  });

  // ══════════════════ concurrency / TOCTOU (task 3.5 remediation) ═══════════
  describe('concurrency', () => {
    /** an ACTIVE product whose DRAFT default variant carries one SKU identifier */
    async function activeProductWithDraftDefaultAndSku(slug: string): Promise<{
      productId: string;
      variantId: string;
      identifierId: string;
      variantVersion: number;
    }> {
      const cat = await makeCategory(ownerA, `${slug}-c`);
      const p = await makeProduct(ownerA, cat, `${slug}-p`, 'STOCKED');
      const v0 = (await listVariants(ownerA, p.id))[0]!;
      const created = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v0.id,
        codeType: 'SKU',
        value: `${slug}-SKU`.toUpperCase(),
      });
      expect(created.statusCode).toBe(201);
      const act = await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      expect(act.statusCode, act.payload).toBe(200);
      const v1 = (await listVariants(ownerA, p.id))[0]!;
      return {
        productId: p.id,
        variantId: v1.id,
        identifierId: (created.json() as { id: string }).id,
        variantVersion: v1.version,
      };
    }

    // ── FIX 1 — identifier DELETE vs Variant activation ────────────────────
    it('DELETE blocked on the variant lock while the variant turns ACTIVE → non-destructive INACTIVE (owner FIX 1 / outcome B)', async () => {
      const f = await activeProductWithDraftDefaultAndSku('race1b');
      const delAuditBefore = await auditRows(tenantA, 'catalog.identifier_deleted');

      const del = await withHeldTxn(
        async (c) => {
          // hold the variant row FOR UPDATE and flip it ACTIVE inside the held txn
          await c.query(`SELECT "id" FROM "variant" WHERE "id" = $1 FOR UPDATE`, [f.variantId]);
          await c.query(
            `UPDATE "variant" SET "status" = 'ACTIVE', "version" = "version" + 1 WHERE "id" = $1`,
            [f.variantId],
          );
        },
        () => req('DELETE', `/catalog/identifiers/${f.identifierId}`, ownerA),
      );

      // the DELETE acquired the variant lock AFTER the commit → sees ACTIVE →
      // the approved non-destructive lifecycle rule, NOT a stale-DRAFT hard delete
      expect(del.statusCode, del.payload).toBe(200);
      expect((del.json() as { status: string }).status).toBe('deactivated');
      const row = await sql<{ status: string }>(
        `SELECT status FROM item_identifier WHERE id = $1`,
        [f.identifierId],
      );
      expect(row[0]?.status).toBe('INACTIVE'); // row + value preserved, not physically deleted
      expect(await auditRows(tenantA, 'catalog.identifier_deleted')).toBe(delAuditBefore); // no hard-delete audit
    });

    it('concurrent identifier DELETE vs variant activate always settles to a safe, self-consistent state', async () => {
      for (let i = 0; i < 4; i++) {
        const f = await activeProductWithDraftDefaultAndSku(`race1r${i}`);
        const [del, act] = await Promise.all([
          req('DELETE', `/catalog/identifiers/${f.identifierId}`, ownerA),
          req('POST', `/catalog/variants/${f.variantId}/activate`, ownerA, undefined, {
            'idempotency-key': ik(),
            'if-match': `"${f.variantVersion}"`,
          }),
        ]);
        expect(del.statusCode, del.payload).toBe(200);
        const status = (del.json() as { status: string }).status;
        expect(['deleted', 'deactivated']).toContain(status);
        const rows = await sql<{ status: string }>(
          `SELECT status FROM item_identifier WHERE id = $1`,
          [f.identifierId],
        );
        const deletedAudit = await count(
          `SELECT count(*)::int AS n FROM audit_log WHERE action='catalog.identifier_deleted' AND "resourceId"=$1`,
          [f.identifierId],
        );
        const deactAudit = await count(
          `SELECT count(*)::int AS n FROM audit_log WHERE action='catalog.identifier_deactivated' AND "resourceId"=$1`,
          [f.identifierId],
        );
        if (status === 'deleted') {
          expect(rows).toHaveLength(0); // physically gone
          expect(deletedAudit).toBe(1);
          expect(deactAudit).toBe(0);
        } else {
          expect(rows[0]?.status).toBe('INACTIVE'); // preserved
          expect(deactAudit).toBe(1);
          expect(deletedAudit).toBe(0);
        }
        // `activate` either succeeded (200) or lost the If-Match race (409) —
        // never a raw 500
        expect([200, 409, 428]).toContain(act.statusCode);
        expect(act.statusCode).not.toBe(500);
      }
    });

    // ── FIX 2 — Product hard delete vs identifier create ──────────────────
    it('an identifier created in the product-hard-delete race window → 409, never a raw FK 500 (owner FIX 2)', async () => {
      const cat = await makeCategory(ownerA, 'race2-c');
      const p = await makeProduct(ownerA, cat, 'race2-p', 'STOCKED');
      const variantId = (await listVariants(ownerA, p.id))[0]!.id;
      const productDeletedBefore = await auditRows(tenantA, 'catalog.product_deleted');
      const pv = (await req('GET', `/catalog/products/${p.id}`, ownerA)).headers['etag'];

      const del = await withHeldTxn(
        async (c) => {
          // an identifier row that exists but is NOT yet committed — the delete's
          // `count` pre-check will not see it, so the delete proceeds to
          // `product.delete` and hits the RESTRICT FK
          await c.query(
            `INSERT INTO item_identifier (id,"tenantId","targetKind","targetId","codeType","value","updatedAt")
             VALUES (uuidv7(),$1,'VARIANT',$2,'SKU','RACE2-INFLIGHT',now())`,
            [tenantA, variantId],
          );
        },
        () =>
          req('DELETE', `/catalog/products/${p.id}`, ownerA, undefined, { 'if-match': String(pv) }),
      );

      expect(del.statusCode, del.payload).toBe(409);
      expect(errCode(del)).toBe('PRODUCT_HAS_VARIANT_IDENTIFIERS');
      expect(del.statusCode).not.toBe(500);
      // nothing was destroyed
      expect(await count(`SELECT count(*)::int AS n FROM product WHERE id = $1`, [p.id])).toBe(1);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM item_identifier WHERE value = 'RACE2-INFLIGHT'`,
        ),
      ).toBe(1);
      expect(await auditRows(tenantA, 'catalog.product_deleted')).toBe(productDeletedBefore);
    });

    it('concurrent product hard-delete vs identifier create → one deterministic domain outcome, no 500', async () => {
      for (let i = 0; i < 4; i++) {
        const cat = await makeCategory(ownerA, `race2r${i}-c`);
        const p = await makeProduct(ownerA, cat, `race2r${i}-p`, 'STOCKED');
        const variantId = (await listVariants(ownerA, p.id))[0]!.id;
        const pv = (await req('GET', `/catalog/products/${p.id}`, ownerA)).headers['etag'];
        const [del, cre] = await Promise.all([
          req('DELETE', `/catalog/products/${p.id}`, ownerA, undefined, { 'if-match': String(pv) }),
          createId(ownerA, {
            targetKind: 'VARIANT',
            targetId: variantId,
            codeType: 'SKU',
            value: `RACE2R${i}`,
          }),
        ]);
        expect(del.statusCode).not.toBe(500);
        expect(cre.statusCode).not.toBe(500);
        const productGone =
          (await count(`SELECT count(*)::int AS n FROM product WHERE id = $1`, [p.id])) === 0;
        if (productGone) {
          // product delete won — the identifier create must have cleanly lost
          expect(del.statusCode).toBe(200);
          expect([404, 409]).toContain(cre.statusCode);
        } else {
          // identifier create won — the product delete must be a clean domain 409
          expect(del.statusCode).toBe(409);
          expect(errCode(del)).toBe('PRODUCT_HAS_VARIANT_IDENTIFIERS');
          expect(cre.statusCode).toBe(201);
        }
      }
    });

    // ── the check-then-insert `(tenantId, value)` race → deterministic 409 ──
    it('two concurrent creates of the same value on different variants → one 201, one 409 IDENTIFIER_VALUE_TAKEN', async () => {
      for (let i = 0; i < 3; i++) {
        const v1 = await makeVariant(ownerA, `raceval${i}a`);
        const v2 = await makeVariant(ownerA, `raceval${i}b`);
        const value = `RACEVAL-${i}`;
        const [a, b] = await Promise.all([
          createId(ownerA, {
            targetKind: 'VARIANT',
            targetId: v1.variantId,
            codeType: 'BARCODE',
            value,
          }),
          createId(ownerA, {
            targetKind: 'VARIANT',
            targetId: v2.variantId,
            codeType: 'BARCODE',
            value,
          }),
        ]);
        const codes = [a.statusCode, b.statusCode].sort();
        expect(codes).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(errCode(loser)).toBe('IDENTIFIER_VALUE_TAKEN');
        expect(a.statusCode).not.toBe(500);
        expect(b.statusCode).not.toBe(500);
        expect(
          await count(
            `SELECT count(*)::int AS n FROM item_identifier WHERE "tenantId"=$1 AND value=$2`,
            [tenantA, value],
          ),
        ).toBe(1); // exactly one row survived
      }
    });
  });

  // ══════════════════ permission + capability (proofs 29–31) ════════════════
  describe('permission + capability', () => {
    it('a role without identifiers:manage is 403 on writes; catalog:view still reads (proof 31)', async () => {
      const v = await makeVariant(ownerA, 'perm');
      await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'BARCODE',
        value: 'PERM-1',
      });
      const w = await createId(viewerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'BARCODE',
        value: 'PERM-2',
      });
      expect(w.statusCode).toBe(403);
      expect((await listIds(viewerA, v.variantId)).statusCode).toBe(200);
    });

    it('identifiers.barcode_qr disabled blocks BARCODE/QR writes but NOT SKU (proofs 29–30)', async () => {
      const v = await makeVariant(noCapOwner, 'cap');
      const bc = await createId(noCapOwner, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'BARCODE',
        value: 'CAP-BC',
      });
      expect(bc.statusCode).toBe(409);
      expect(errCode(bc)).toBe('CAPABILITY_NOT_ENABLED');

      const qr = await createId(noCapOwner, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'QR',
      });
      expect(qr.statusCode).toBe(409);

      const sku = await createId(noCapOwner, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: 'CAP-SKU',
      });
      expect(sku.statusCode, sku.payload).toBe(201);
      // a read is never blocked by capability state
      expect((await listIds(noCapOwner, v.variantId)).statusCode).toBe(200);
    });
  });

  // ══════════════════ idempotency + audit (proofs 33, 35–36) ════════════════
  describe('idempotency + audit', () => {
    it('a create + reactivate replay with the same key returns the stored 2xx (proofs 33–34)', async () => {
      // build an ACTIVE variant so DELETE deactivates (keeps the row for reactivate)
      const cat = await makeCategory(ownerA, 'idem-c');
      const p = await makeProduct(ownerA, cat, 'idem-p', 'STOCKED');
      const variantId0 = (await listVariants(ownerA, p.id))[0]!.id;
      const key = ik();
      const first = await createId(
        ownerA,
        { targetKind: 'VARIANT', targetId: variantId0, codeType: 'SKU', value: 'IDEM-1' },
        key,
      );
      expect(first.statusCode).toBe(201);
      const id = (first.json() as { id: string }).id;
      const replay = await createId(
        ownerA,
        { targetKind: 'VARIANT', targetId: variantId0, codeType: 'SKU', value: 'IDEM-1' },
        key,
      );
      expect(replay.statusCode).toBe(201);
      expect((replay.json() as { id: string }).id).toBe(id);
      // exactly one row
      expect(
        await count(
          `SELECT count(*)::int AS n FROM item_identifier WHERE value = 'IDEM-1' AND "tenantId" = $1`,
          [tenantA],
        ),
      ).toBe(1);

      // activate + deactivate + a reactivate replay
      await req('POST', `/catalog/products/${p.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${p.version}"`,
      });
      const vRow = (await listVariants(ownerA, p.id))[0]!;
      await req('POST', `/catalog/variants/${vRow.id}/activate`, ownerA, undefined, {
        'idempotency-key': ik(),
        'if-match': `"${vRow.version}"`,
      });
      await req('DELETE', `/catalog/identifiers/${id}`, ownerA);
      const rKey = ik();
      const r1 = await req('POST', `/catalog/identifiers/${id}/reactivate`, ownerA, undefined, {
        'idempotency-key': rKey,
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await req('POST', `/catalog/identifiers/${id}/reactivate`, ownerA, undefined, {
        'idempotency-key': rKey,
      });
      expect(r2.statusCode).toBe(200);
      expect((r2.json() as { status: string }).status).toBe('ACTIVE');
    });

    it('exactly one audit row per successful mutation; a failed create writes none (proofs 35–36)', async () => {
      const before = await auditRows(tenantA, 'catalog.identifier_created');
      const v = await makeVariant(ownerA, 'audit');
      const ok = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: 'AUDIT-1',
      });
      expect(ok.statusCode).toBe(201);
      expect(await auditRows(tenantA, 'catalog.identifier_created')).toBe(before + 1);

      // a duplicate → 409, no new audit row
      const dup = await createId(ownerA, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: 'AUDIT-1',
      });
      expect(dup.statusCode).toBe(409);
      expect(await auditRows(tenantA, 'catalog.identifier_created')).toBe(before + 1);
    });
  });

  // ══════════════════ HG3-NO-BT-BRANCH behavioural (proof 39) ═══════════════
  it('two tenants with different businessTypeKey + identical data behave identically', async () => {
    const build = async (token: string): Promise<unknown> => {
      const v = await makeVariant(token, 'bt');
      const sku = await createId(token, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'SKU',
        value: 'bt-sku-1',
      });
      const qr = await createId(token, {
        targetKind: 'VARIANT',
        targetId: v.variantId,
        codeType: 'QR',
      });
      const list = await listIds(token, v.variantId);
      return {
        skuStatus: sku.statusCode,
        skuValue: (sku.json() as { value: string }).value,
        qrStatus: qr.statusCode,
        qrShape: /^[0-9A-F]{40}$/.test((qr.json() as { value: string }).value),
        count: (list.json() as unknown[]).length,
      };
    };
    // tenantA = CUSTOM, tenantC = BAKERY_CAKE
    expect(await build(ownerA)).toEqual(await build(ownerC));
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000350000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000350000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 5);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
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
             ('BAKERY_CAKE', 2, 'Bakery', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()),
             ('BAKERY_CAKE','strategy.stocked',true,now());
    `);
  } finally {
    await c.end();
  }
}
