import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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

const PLAN_V = '00000000-0000-7000-8000-000000210001';
const PLATFORM_USER = '00000000-0000-7000-8000-000000210002';

/**
 * Task 2.7 — localization reference data + service + company-level fiscal
 * resolution (ARCHITECTURE "Localization reference data + service", HG-LOCALE).
 * Verifies: GCC currencies/exponents seed correctly; fiscal regimes/rates are
 * effective-dated and reference-data driven; QA/KW are `NONE` (never a
 * synthetic 0% rate); a company's profile resolves from `company.country_code`
 * (never `tenant.region`); a tenant with companies in different GCC countries
 * resolves each independently; a rate change resolves correctly without
 * touching `company.fiscal_config`; reference tables are readable without a
 * tenant GUC; `flower_app` cannot write to them; the company endpoint respects
 * tenant + company scope.
 */
describe('localization: reference data + company fiscal resolution (integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;

  let tenantId: string;
  let companyAeId: string; // provisioned, country AE
  let companySaId: string; // added via /org/companies, country SA
  let ownerToken: string;
  let otherTenantOwnerToken: string; // a second tenant, for scope-enforcement

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

    const platformTok = await mintPlatform();

    const prov = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      payload: {
        slug: 'loctest',
        name: 'LocTest FZE',
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'CUSTOM',
        planVersionId: PLAN_V,
        ownerEmail: 'owner@loctest.test',
      },
      headers: { authorization: `Bearer ${platformTok}`, 'idempotency-key': 'loc-prov-1' },
    });
    expect(prov.statusCode).toBe(201);
    tenantId = prov.json().tenantId as string;
    companyAeId = prov.json().companyId as string;

    ownerToken = await mintTenant(tenantId, 'loc-owner-1');

    // a tenant with companies in different GCC countries resolves each
    // independently — add a SECOND company, in Saudi Arabia, to the SAME tenant.
    const addCompany = await app.inject({
      method: 'POST',
      url: '/v1/org/companies',
      payload: { legalNameEn: 'LocTest KSA Branch Co', countryCode: 'SA' },
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(addCompany.statusCode).toBe(201);
    companySaId = addCompany.json().id as string;

    // a second, unrelated tenant — for the cross-tenant scope-enforcement check
    const prov2 = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      payload: {
        slug: 'loctest-other',
        name: 'LocTest Other FZE',
        region: 'AE',
        companyCountryCode: 'AE',
        businessTypeKey: 'CUSTOM',
        planVersionId: PLAN_V,
        ownerEmail: 'owner2@loctest.test',
      },
      headers: { authorization: `Bearer ${platformTok}`, 'idempotency-key': 'loc-prov-2' },
    });
    expect(prov2.statusCode).toBe(201);
    otherTenantOwnerToken = await mintTenant(prov2.json().tenantId as string, 'loc-owner-2');
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  async function mintPlatform(): Promise<string> {
    const s = baseSession('loc-plat', 'platform');
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

  async function mintTenant(forTenantId: string, sessionId: string): Promise<string> {
    const s = baseSession(sessionId, 'tenant');
    s.tenantId = forTenantId;
    s.userId = randomUUID();
    s.accountType = 'OWNER';
    s.mfaLevel = 'STEP_UP';
    s.stepUpUntil = Date.now() + 600_000;
    s.access = {
      effectivePermissions: ['settings:tenant:manage'],
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: s.userId, sid: s.sessionId, aud: 'tenant', tid: forTenantId });
  }

  function baseSession(sessionId: string, realm: 'tenant' | 'platform'): SessionData {
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

  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url: `/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  // ── 1/2/3. GCC currencies/exponents/regimes seed correctly, effective-dated ──
  it('the reference snapshot has correct GCC currencies, exponents, and regimes (QA/KW = NONE, never 0%)', async () => {
    const res = await get('/localization/reference', ownerToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const currencyByCode = Object.fromEntries(
      (body.currencies as { code: string; exponent: number }[]).map((c) => [c.code, c.exponent]),
    );
    expect(currencyByCode).toMatchObject({ AED: 2, SAR: 2, QAR: 2, KWD: 3, BHD: 3, OMR: 3 });

    const countryByCode = Object.fromEntries(
      (body.countries as { code: string; taxRegime: { regime: string; rates: unknown[] } }[]).map(
        (c) => [c.code, c.taxRegime],
      ),
    );
    expect(countryByCode['AE']).toMatchObject({ regime: 'VAT' });
    expect(countryByCode['AE']?.rates.length).toBeGreaterThan(0);
    // QA / KW: NONE regime, and — critically — NO rate rows at all, never a
    // synthetic 0% STANDARD rate standing in for "no VAT law".
    expect(countryByCode['QA']).toMatchObject({ regime: 'NONE', rates: [] });
    expect(countryByCode['KW']).toMatchObject({ regime: 'NONE', rates: [] });
  });

  // ── 6. a rate change resolves correctly without rewriting fiscal_config ──
  it("Saudi Arabia's historical 5% and current 15% both resolve correctly by effective date", async () => {
    const before = await get(
      '/localization/companies/' + companySaId + '?at=2019-01-01T00:00:00.000Z',
      ownerToken,
    );
    expect(before.statusCode).toBe(200);
    const beforeRates = before.json().taxRegime.rates as {
      taxCategoryKey: string;
      rateBps: number;
    }[];
    expect(beforeRates.find((r) => r.taxCategoryKey === 'STANDARD')?.rateBps).toBe(500);

    const after = await get(
      '/localization/companies/' + companySaId + '?at=2026-01-01T00:00:00.000Z',
      ownerToken,
    );
    expect(after.statusCode).toBe(200);
    const afterRates = after.json().taxRegime.rates as {
      taxCategoryKey: string;
      rateBps: number;
    }[];
    expect(afterRates.find((r) => r.taxCategoryKey === 'STANDARD')?.rateBps).toBe(1500);

    // the company row itself never changed — the rate change is resolved
    // purely from the effective-dated reference data, not a value cached on
    // the company.
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const row = (await c.query(`SELECT "fiscalConfig" FROM company WHERE id=$1`, [companySaId]))
        .rows[0];
      expect(row.fiscalConfig).toEqual({});
    } finally {
      await c.end();
    }
  });

  // ── 4/5. company profile derives from company.country_code, two countries independently ──
  it('one tenant with companies in AE and SA resolves each company independently, from country_code never tenant.region', async () => {
    const ae = await get(`/localization/companies/${companyAeId}`, ownerToken);
    expect(ae.statusCode).toBe(200);
    expect(ae.json()).toMatchObject({ countryCode: 'AE', currency: { code: 'AED', exponent: 2 } });

    const sa = await get(`/localization/companies/${companySaId}`, ownerToken);
    expect(sa.statusCode).toBe(200);
    expect(sa.json()).toMatchObject({ countryCode: 'SA', currency: { code: 'SAR', exponent: 2 } });

    // both companies belong to a tenant whose `region` is 'AE' — the SA
    // company's currency is SAR regardless, proving resolution never fell
    // back to tenant.region.
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const t = (await c.query(`SELECT region FROM tenant WHERE id=$1`, [tenantId])).rows[0];
      expect(t.region).toBe('AE');
    } finally {
      await c.end();
    }
  });

  // ── 11. company localization endpoint respects tenant + company scope ──
  it("a company profile is not reachable by a different tenant's session (scope-checked, not just RLS)", async () => {
    const res = await get(`/localization/companies/${companyAeId}`, otherTenantOwnerToken);
    expect([403, 404]).toContain(res.statusCode);
  });

  // ── 12. global reference-data endpoint cannot be abused to access tenant data ──
  it('the reference endpoint carries no tenant-specific data for anyone who calls it', async () => {
    const res = await get('/localization/reference', otherTenantOwnerToken);
    expect(res.statusCode).toBe(200);
    const blob = JSON.stringify(res.json());
    expect(blob.includes(tenantId)).toBe(false);
    expect(blob.includes(companyAeId)).toBe(false);
    expect(blob.includes(companySaId)).toBe(false);
  });

  // ── 7/8. reference tables readable without tenant GUC; flower_app cannot write ──
  it('reference tables are readable by flower_app with NO app.tenant_id set, and flower_app cannot write to them', async () => {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE flower_app');
      // deliberately no `set_config('app.tenant_id', ...)` at all.
      const rows = await c.query('SELECT code FROM country');
      expect(rows.rows.length).toBeGreaterThanOrEqual(6);

      await expect(
        c.query(`INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
                  VALUES ('ZZ', 'x', 'x', 'gcc', 'AED', 'FRI_SAT', now())`),
      ).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-000000210000', 'starter', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-000000210000', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_companies', 5),
             ('${PLAN_V}', 'max_pos_terminals', 5), ('${PLAN_V}', 'max_sessions_per_user', 20),
             ('${PLAN_V}', 'max_users', 20);
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin@flower.test', 'Platform Admin', now());
      INSERT INTO permission_registry (key, realm, "groupKey", description, "addedInPhase")
      VALUES ('users:view','TENANT','admin','v',1),('users:manage','TENANT','admin','v',1),
             ('roles:manage','TENANT','admin','v',1),('audit:view','TENANT','admin','v',1),
             ('settings:branch:manage','TENANT','admin','v',1),('settings:tenant:manage','TENANT','admin','v',1);

      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'UAE Dirham', 'x'),
        ('SAR', 2, 'SAR', 'Saudi Riyal', 'x'),
        ('QAR', 2, 'QAR', 'Qatari Riyal', 'x'),
        ('KWD', 3, 'KWD', 'Kuwaiti Dinar', 'x'),
        ('BHD', 3, 'BHD', 'Bahraini Dinar', 'x'),
        ('OMR', 3, 'OMR', 'Omani Rial', 'x');

      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt") VALUES
        ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()),
        ('SA', 'Saudi Arabia', 'x', 'gcc', 'SAR', 'FRI_SAT', true, now()),
        ('QA', 'Qatar', 'x', 'gcc', 'QAR', 'FRI_SAT', true, now()),
        ('KW', 'Kuwait', 'x', 'gcc', 'KWD', 'FRI_SAT', true, now()),
        ('BH', 'Bahrain', 'x', 'gcc', 'BHD', 'FRI_SAT', true, now()),
        ('OM', 'Oman', 'x', 'gcc', 'OMR', 'FRI_SAT', true, now());

      INSERT INTO tax_category (key, "nameEn", "nameAr") VALUES
        ('STANDARD', 'Standard', 'x'), ('ZERO_RATED', 'Zero-rated', 'x'), ('EXEMPT', 'Exempt', 'x');

      INSERT INTO business_type_template (key, version, "nameEn", "nameAr", status, "updatedAt")
      VALUES ('CUSTOM', 1, 'Custom', 'x', 'ACTIVE', now());
      INSERT INTO business_type_template_capability ("templateKey", "capabilityKey", enabled, "updatedAt")
      VALUES ('CUSTOM','strategy.stocked',true,now()),('CUSTOM','branch_pricing',true,now()),('CUSTOM','channel.pos',true,now());

      INSERT INTO country_tax_config ("countryCode", "effectiveFrom", "effectiveTo", regime) VALUES
        ('AE', '2018-01-01', NULL, 'VAT'),
        ('SA', '2018-01-01', NULL, 'VAT'),
        ('BH', '2019-01-01', NULL, 'VAT'),
        ('OM', '2021-04-16', NULL, 'VAT'),
        ('QA', '2016-06-01', NULL, 'NONE'),
        ('KW', '2016-06-01', NULL, 'NONE');

      INSERT INTO tax_rate ("countryCode", "taxCategoryKey", "rateBps", "effectiveFrom", "effectiveTo") VALUES
        ('AE', 'STANDARD', 500, '2018-01-01', NULL),
        ('AE', 'ZERO_RATED', 0, '2018-01-01', NULL),
        ('SA', 'STANDARD', 500, '2018-01-01', '2020-06-30'),
        ('SA', 'STANDARD', 1500, '2020-07-01', NULL),
        ('SA', 'ZERO_RATED', 0, '2018-01-01', NULL),
        ('BH', 'STANDARD', 500, '2019-01-01', '2021-12-31'),
        ('BH', 'STANDARD', 1000, '2022-01-01', NULL),
        ('OM', 'STANDARD', 500, '2021-04-16', NULL);
      -- QA / KW: deliberately zero tax_rate rows.

      INSERT INTO locale (code, "nameEn", "nameAr", direction) VALUES
        ('en', 'English', 'x', 'ltr'), ('ar', 'Arabic', 'x', 'rtl');
    `);
  } finally {
    await c.end();
  }
}
