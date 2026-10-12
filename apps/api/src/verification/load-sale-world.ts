import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { PLATFORM_PERMISSIONS } from '@flower/permissions';
// White-box verification support: it seeds disposable fixtures through the repositories — not production code.
import { runScoped } from '@flower/db';
import { AppModule } from '../app.module.js';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../common/context/index.js';
import { JwtService } from '../common/auth/jwt.service.js';
import { SessionStore } from '../common/auth/session-store.js';
import type { SessionData } from '../common/auth/session.types.js';
import { SystemClock, type Clock } from '../common/clock/clock.js';
import { DbService } from '../common/data/index.js';
import { SYSTEM_ROLE_TEMPLATES } from '../modules/platform/system-roles.js';
import { AccountRepository } from '../modules/accounting/account.repository.js';
import { AccountingPeriodRepository } from '../modules/accounting/accounting-period.repository.js';
import type { HttpResult } from './load-support.js';

/**
 * Task 3b.10 Checkpoint G — the application + sale fixture of the local load-verification suites: the REAL `AppModule`
 * (global guards, idempotency interceptor, exception filter), real sessions with the REAL default role grants, real
 * Redis and the disposable PostgreSQL. Orders and sales are created ONLY through the public HTTP routes
 * (`POST …/orders`, `POST …/orders/:id/complete-sale`, `POST …/customers/:id/receipts`) — nothing in the sale
 * path is bypassed. Disposable data only.
 */
export const FIXED_INSTANT = new Date('2026-06-15T10:00:00.000Z');
export const PERIOD = { from: '2026-06-01', to: '2026-06-30' } as const;
const PLAN_V = '00000000-0000-7000-8000-0000003b9a01';
const PLATFORM_USER = '00000000-0000-7000-8000-0000003b9a02';
export type Role = 'owner' | 'admin' | 'manager' | 'cashier' | 'sales' | 'accountant';
export const ROLES: Role[] = ['owner', 'admin', 'manager', 'cashier', 'sales', 'accountant'];

export const rolePerms = (key: string): string[] => {
  const role = SYSTEM_ROLE_TEMPLATES.find((r) => r.key === key);
  if (!role) throw new Error(`no system role ${key}`);
  return [...role.permissions];
};

export interface AppHandle {
  app: NestFastifyApplication;
  jwt: JwtService;
  store: SessionStore;
  db: DbService;
  close(): Promise<void>;
}

export async function bootApp(
  urls: { pg: string; redis: string },
  clock?: Clock,
): Promise<AppHandle> {
  process.env['DATABASE_URL'] = urls.pg;
  process.env['PLATFORM_DATABASE_URL'] = urls.pg;
  process.env['REDIS_URL'] = urls.redis;
  process.env['AUTH_JWT_SECRET'] = 'integration-test-jwt-secret-0000000000';
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (clock) builder = builder.overrideProvider(SystemClock).useValue(clock);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  installRequestContext(app.getHttpAdapter().getInstance());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    jwt: app.get(JwtService),
    store: app.get(SessionStore),
    db: app.get(DbService),
    close: async () => {
      await app.close();
      for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
        delete process.env[k];
      }
    },
  };
}

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
    expiresAt: Date.now() + 6 * 3_600_000,
    revokedAt: null,
    revokeReason: null,
    impersonatorPlatformUserId: null,
    access: null,
  };
}

export interface MintOptions {
  branchScope?: string[] | 'ALL';
  companyScope?: string[] | 'ALL';
  overlay?: Record<string, string[]>;
  stepUp?: boolean;
}

export async function mintTenantToken(
  h: AppHandle,
  tenantId: string,
  perms: readonly string[],
  o: MintOptions = {},
): Promise<string> {
  const s = baseSess(`g-${randomUUID()}`, 'tenant');
  s.tenantId = tenantId;
  s.userId = randomUUID();
  s.accountType = 'OWNER';
  if (o.stepUp) {
    s.mfaLevel = 'STEP_UP';
    s.stepUpUntil = Date.now() + 5 * 3_600_000;
  }
  s.access = {
    effectivePermissions: [...perms],
    companyScope: o.companyScope ?? 'ALL',
    branchScope: o.branchScope ?? 'ALL',
    perBranchOverlay: o.overlay ?? {},
    entitledModules: [],
    planKey: null,
  };
  await h.store.set(s);
  return h.jwt.sign({ sub: s.userId, sid: s.sessionId, aud: 'tenant', tid: tenantId });
}

async function mintPlatformToken(h: AppHandle): Promise<string> {
  const s = baseSess('g-platform', 'platform');
  s.platformUserId = PLATFORM_USER;
  s.accountType = 'PLATFORM';
  s.mfaLevel = 'STEP_UP';
  s.stepUpUntil = Date.now() + 5 * 3_600_000;
  s.access = {
    effectivePermissions: [...PLATFORM_PERMISSIONS],
    companyScope: 'ALL',
    branchScope: 'ALL',
    perBranchOverlay: {},
    entitledModules: [],
    planKey: null,
  };
  await h.store.set(s);
  return h.jwt.sign({ sub: PLATFORM_USER, sid: s.sessionId, aud: 'platform' });
}

/** the reference rows a provisioned tenant needs (plan, currencies, country, tax config, template) */
export async function seedReference(pool: pg.Pool): Promise<void> {
  await pool.query(`
    INSERT INTO plan (id, key, name, "updatedAt")
    VALUES ('00000000-0000-7000-8000-0000003b9a00', 'starter-g', 'Starter', now());
    INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
    VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b9a00', 1, 'PUBLISHED', now());
    INSERT INTO limit_default ("planVersionId", "limitKey", value)
    VALUES ('${PLAN_V}', 'max_branches', 20), ('${PLAN_V}', 'max_sessions_per_user', 200),
           ('${PLAN_V}', 'max_users', 200), ('${PLAN_V}', 'max_companies', 20);
    INSERT INTO platform_user (id, email, name, "updatedAt")
    VALUES ('${PLATFORM_USER}', 'admin-g@flower.test', 'Platform Admin', now());
    INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
      ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING;
    INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
    VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT (code) DO NOTHING;
    INSERT INTO country_tax_config (id, "countryCode", "effectiveFrom", regime, config)
    SELECT uuidv7(), 'AE', '2020-01-01', 'VAT',
           '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM country_tax_config WHERE "countryCode" = 'AE');
    INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
    VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now()) ON CONFLICT (key) DO NOTHING;
    INSERT INTO business_type_template_capability ("templateKey","capabilityKey",enabled,"updatedAt")
    VALUES ('CUSTOM','strategy.stocked',true,now()), ('CUSTOM','strategy.custom',true,now()),
           ('CUSTOM','variants',true,now()), ('CUSTOM','multi_uom',true,now()),
           ('CUSTOM','branch_pricing',true,now()) ON CONFLICT ("templateKey","capabilityKey") DO NOTHING;
  `);
}

export interface Co {
  tenantId: string;
  companyId: string;
  branches: string[];
}

export interface SaleWorld {
  h: AppHandle;
  pool: pg.Pool;
  a: Co; // tenant A — the company under test
  a2: Co; // tenant A — ANOTHER company (foreign-company probe)
  b: Co; // tenant B — the foreign tenant
  customers: string[];
  productId: string;
  variantId: string;
  ownerToken: string;
  unitPrice: bigint;
  req(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token: string | null,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<HttpResult>;
  sale(o: {
    co: Co;
    branch: string;
    token: string;
    customerId?: string;
    credit?: boolean;
    quantity?: number;
    key?: string;
  }): Promise<{
    ok: boolean;
    status: number;
    ms: number;
    step: 'create' | 'complete';
    code?: string | undefined;
    total?: string;
    orderId?: string;
    invoiceId?: string | null;
  }>;
  receipt(o: {
    co: Co;
    branch: string;
    token: string;
    customerId: string;
    amountMinor: bigint;
    key?: string;
  }): Promise<HttpResult>;
}

export async function createSaleWorld(
  urls: { pg: string; redis: string },
  branchesPerCompany = 3,
): Promise<SaleWorld> {
  const pool = new pg.Pool({ connectionString: urls.pg, max: 6 });
  await seedReference(pool);
  const clock: Clock = { now: () => FIXED_INSTANT };
  const h = await bootApp(urls, clock);
  const platform = await mintPlatformToken(h);
  const req: SaleWorld['req'] = async (method, url, token, body, headers = {}) => {
    const t0 = performance.now();
    const res = await h.app.inject({
      method,
      url: `/v1${url}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { payload: body } : {}),
    });
    const ms = performance.now() - t0;
    const parse = (): unknown => {
      try {
        return res.json();
      } catch {
        return res.payload;
      }
    };
    return { status: res.statusCode, ms, body: parse() };
  };
  let ik = 0;
  const key = (p: string): string =>
    `g-${p}-${String(++ik).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;

  const provision = async (slug: string): Promise<string> => {
    const r = await req(
      'POST',
      '/platform/tenants',
      platform,
      {
        slug,
        name: slug,
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'CUSTOM',
        planVersionId: PLAN_V,
        ownerEmail: `owner@${slug}.test`,
      },
      { 'idempotency-key': `prov-${slug}` },
    );
    if (r.status !== 201)
      throw new Error(`provision ${slug} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body as { tenantId: string }).tenantId;
  };
  const q = async <T extends Record<string, unknown>>(
    sql: string,
    p: unknown[] = [],
  ): Promise<T[]> => (await pool.query(sql, p)).rows as T[];
  const accountsAndPeriod = async (tenantId: string, companyId: string): Promise<void> => {
    await runScoped(h.db.appClient(), { tenantId }, (tx) =>
      h.app.get(AccountRepository).ensureDefaultAccounts(tx, { tenantId, companyId }),
    );
    const covering = await q(
      `SELECT id FROM accounting_period WHERE "companyId" = $1 AND "startDate" <= DATE '2026-06-15' AND "endDate" >= DATE '2026-06-15'`,
      [companyId],
    );
    if (covering.length === 0) {
      await runScoped(h.db.appClient(), { tenantId }, (tx) =>
        h.app.get(AccountingPeriodRepository).create(tx, {
          tenantId,
          companyId,
          startDate: new Date('2026-06-01T00:00:00Z'),
          endDate: new Date('2026-06-30T00:00:00Z'),
        }),
      );
    }
  };
  const mkCompany = async (tenantId: string, extraBranches: number): Promise<Co> => {
    const companyId = (
      await q<{ id: string }>(
        `SELECT id FROM company WHERE "tenantId" = $1 ORDER BY "createdAt" LIMIT 1`,
        [tenantId],
      )
    )[0]!.id;
    await pool.query(`UPDATE company SET "accountingTimezone" = 'Asia/Dubai' WHERE id = $1`, [
      companyId,
    ]);
    const branches = (
      await q<{ id: string }>(`SELECT id FROM branch WHERE "companyId" = $1 ORDER BY id`, [
        companyId,
      ])
    ).map((r) => r.id);
    for (let i = 0; i < extraBranches; i++) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [id, tenantId, companyId, `Branch ${branches.length + 1}`],
      );
      branches.push(id);
    }
    await accountsAndPeriod(tenantId, companyId);
    return { tenantId, companyId, branches };
  };

  const tenantA = await provision(`g-a-${randomUUID().slice(0, 6)}`);
  const tenantB = await provision(`g-b-${randomUUID().slice(0, 6)}`);
  const a = await mkCompany(tenantA, Math.max(0, branchesPerCompany - 1));
  const b = await mkCompany(tenantB, 1);
  // a second company of tenant A (the "foreign company" probe)
  const a2Id = randomUUID();
  await pool.query(
    `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
     VALUES ($1,$2,'Company A2','AE','AED','Asia/Dubai','ACTIVE',now())`,
    [a2Id, tenantA],
  );
  const a2Branch = randomUUID();
  await pool.query(
    `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'A2 Main',now())`,
    [a2Branch, tenantA, a2Id],
  );
  await accountsAndPeriod(tenantA, a2Id);
  const a2: Co = { tenantId: tenantA, companyId: a2Id, branches: [a2Branch] };

  const ownerToken = await mintTenantToken(h, tenantA, rolePerms('owner'), { stepUp: true });
  // catalog + company price through the public HTTP routes
  const cat = await req(
    'POST',
    '/catalog/categories',
    ownerToken,
    { slug: 'g-roses-c', nameEn: 'Roses' },
    { 'idempotency-key': key('cat') },
  );
  const prod = await req(
    'POST',
    '/catalog/products',
    ownerToken,
    {
      categoryId: (cat.body as { id: string }).id,
      nameEn: 'Rose',
      slug: 'g-rose-p',
      fulfilmentStrategy: 'STOCKED',
    },
    { 'idempotency-key': key('prod') },
  );
  if (prod.status !== 201)
    throw new Error(`product create failed ${prod.status} ${JSON.stringify(prod.body)}`);
  const productId = (prod.body as { id: string }).id;
  const variants = (await req('GET', `/catalog/products/${productId}/variants`, ownerToken))
    .body as { id: string; version: number }[];
  const variantId = variants[0]!.id;
  const v0 = (await req('GET', `/catalog/variants/${variantId}`, ownerToken)).body as {
    version: number;
  };
  const base = await req(
    'PUT',
    `/catalog/variants/${variantId}/base-uom`,
    ownerToken,
    { baseUomCode: 'piece' },
    { 'if-match': `"${v0.version}"` },
  );
  if (base.status !== 200)
    throw new Error(`base uom failed ${base.status} ${JSON.stringify(base.body)}`);
  const actP = await req('POST', `/catalog/products/${productId}/activate`, ownerToken, undefined, {
    'if-match': '"1"',
    'idempotency-key': key('actp'),
  });
  if (actP.status !== 200)
    throw new Error(`activate product failed ${actP.status} ${JSON.stringify(actP.body)}`);
  const v1 = (await req('GET', `/catalog/variants/${variantId}`, ownerToken)).body as {
    version: number;
  };
  const actV = await req('POST', `/catalog/variants/${variantId}/activate`, ownerToken, undefined, {
    'if-match': `"${v1.version}"`,
    'idempotency-key': key('actv'),
  });
  if (actV.status !== 200)
    throw new Error(`activate variant failed ${actV.status} ${JSON.stringify(actV.body)}`);
  const unitPrice = 1000n;
  const prices = await req(
    'GET',
    `/catalog/companies/${a.companyId}/variants/${variantId}/prices`,
    ownerToken,
  );
  const put = await req(
    'PUT',
    `/catalog/companies/${a.companyId}/variants/${variantId}/prices`,
    ownerToken,
    {
      prices: [
        {
          uomCode: 'piece',
          sell: { amountMinor: unitPrice.toString(), currency: 'AED', exponent: 2 },
        },
      ],
    },
    { 'if-match': `"${(prices.body as { version: number }).version}"` },
  );
  if (put.status !== 200)
    throw new Error(`company price failed ${put.status} ${JSON.stringify(put.body)}`);

  const customers: string[] = [];
  for (let i = 0; i < 4; i++) {
    const customerId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,$3,now())`,
      [customerId, tenantA, `Customer ${i + 1}`],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","creditEnabled","updatedAt") VALUES ($1,$2,$3,$4,true,now())`,
      [randomUUID(), tenantA, a.companyId, customerId],
    );
    customers.push(customerId);
  }

  const sale: SaleWorld['sale'] = async (o) => {
    const qty = o.quantity ?? 2;
    const created = await req(
      'POST',
      `/companies/${o.co.companyId}/branches/${o.branch}/orders`,
      o.token,
      {
        ...(o.customerId ? { customerId: o.customerId } : {}),
        lines: [{ productId, variantId, selectedUomCode: 'piece', quantity: String(qty) }],
      },
      { 'idempotency-key': o.key ? `${o.key}-c` : key('order') },
    );
    if (created.status !== 201) {
      return {
        ok: false,
        status: created.status,
        ms: created.ms,
        step: 'create',
        code: (created.body as { error?: { code?: string } })?.error?.code,
      };
    }
    const order = (created.body as { order: { id: string; version: number } }).order;
    const total = unitPrice * BigInt(qty);
    const done = await req(
      'POST',
      `/companies/${o.co.companyId}/branches/${o.branch}/orders/${order.id}/complete-sale`,
      o.token,
      o.credit
        ? { paymentIntent: 'ON_CREDIT' }
        : {
            paymentIntent: 'PAY_NOW',
            tenders: [{ method: 'CASH', amountMinor: total.toString() }],
          },
      { 'if-match': String(order.version), 'idempotency-key': o.key ? `${o.key}-s` : key('sale') },
    );
    const inv =
      (done.body as { issuedInvoice?: { id?: string } | null; invoiceId?: string })?.issuedInvoice
        ?.id ??
      (done.body as { invoiceId?: string })?.invoiceId ??
      null;
    return {
      ok: done.status === 200,
      status: done.status,
      ms: created.ms + done.ms,
      step: 'complete',
      ...(done.status === 200
        ? {}
        : { code: (done.body as { error?: { code?: string } })?.error?.code }),
      total: total.toString(),
      orderId: order.id,
      invoiceId: inv,
    };
  };
  const receipt: SaleWorld['receipt'] = (o) =>
    req(
      'POST',
      `/companies/${o.co.companyId}/branches/${o.branch}/customers/${o.customerId}/receipts`,
      o.token,
      { amountMinor: o.amountMinor.toString(), method: 'CASH' },
      { 'idempotency-key': o.key ?? key('receipt') },
    );

  return {
    h,
    pool,
    a,
    a2,
    b,
    customers,
    productId,
    variantId,
    ownerToken,
    unitPrice,
    req,
    sale,
    receipt,
  };
}
