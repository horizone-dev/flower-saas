import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';

const PLAN_V = '00000000-0000-7000-8000-0000003b0001';
const PLATFORM_USER = '00000000-0000-7000-8000-0000003b0002';

/**
 * Task 3b.1 Checkpoint D — `AccountingController` HTTP-layer proof. The
 * repository/service layer (business rules, sealed-journal, concurrency) is
 * already exhaustively covered by Checkpoints A–C's real-Postgres integration
 * tests; this file proves only the controller/DTO/permission/step-up/If-Match/
 * Idempotency-Key wiring itself, through real HTTP requests.
 */
describe('AccountingController (task 3b.1 Checkpoint D, integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let tenantB = '';
  let companyA = '';
  let companyB = '';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url); // applies the real 3b.1 migrations, incl. permission_registry rows
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

    companyA = await mkCompany(await mkTenant('accA'), 'Company A', 'AE', 'AED');
    tenantA = (
      await sql<{ tenantId: string }>(`SELECT "tenantId" FROM company WHERE id=$1`, [companyA])
    )[0]!.tenantId;
    companyB = await mkCompany(await mkTenant('accB'), 'Company B', 'AE', 'AED');
    tenantB = (
      await sql<{ tenantId: string }>(`SELECT "tenantId" FROM company WHERE id=$1`, [companyB])
    )[0]!.tenantId;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  // ── harness ──────────────────────────────────────────────────────────────
  const userIds = new Map<string, string>();
  let userSeq = 0;
  function userIdFor(sessionId: string): string {
    let uid = userIds.get(sessionId);
    if (uid === undefined) {
      uid = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
      userIds.set(sessionId, uid);
    }
    return uid;
  }
  function base(sessionId: string, tenantId: string): SessionData {
    return {
      sessionId,
      realm: 'tenant',
      familyId: 'f',
      tenantId,
      userId: userIdFor(sessionId),
      platformUserId: null,
      accountType: 'OWNER',
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
  async function mint(
    id: string,
    tenantId: string,
    perms: string[],
    opts: { stepUp?: boolean } = {},
  ): Promise<string> {
    const s = base(id, tenantId);
    s.access = {
      effectivePermissions: perms,
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    if (opts.stepUp) {
      s.mfaLevel = 'STEP_UP';
      s.stepUpUntil = Date.now() + 600_000;
    }
    await store.set(s);
    return jwt.sign({ sub: s.userId!, sid: s.sessionId, aud: 'tenant', tid: tenantId });
  }
  const req = (
    method: 'GET' | 'POST' | 'PATCH',
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
  async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      return (await c.query(text, params)).rows as T[];
    } finally {
      await c.end();
    }
  }
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;
  let tenantSeq = 0;
  async function mkTenant(slug: string): Promise<string> {
    const rows = await sql<{ id: string }>(
      `INSERT INTO tenant (id, slug, name, region, "planVersionId", status, "updatedAt")
       VALUES (uuidv7(), $1, $1, 'AE', $2, 'ACTIVE', now()) RETURNING id`,
      [`${slug}-${++tenantSeq}`, PLAN_V],
    );
    return rows[0]!.id;
  }
  async function mkCompany(
    tenantId: string,
    name: string,
    country: string,
    currency: string,
  ): Promise<string> {
    const rows = await sql<{ id: string }>(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'Asia/Dubai','ACTIVE',now()) RETURNING id`,
      [tenantId, name, country, currency],
    );
    const companyId = rows[0]!.id;
    // seed the 14 default accounts directly (bypassing the provisioning flow,
    // which this bespoke fixture doesn't exercise end-to-end)
    const accounts = await sql<{
      key: string;
      category: string;
      defaultDisplayCode: string;
      defaultDisplayName: string;
    }>(
      `SELECT * FROM (VALUES
        ('ASSET.CASH_ON_HAND','ASSET','1000','Cash on Hand'),
        ('ASSET.BANK','ASSET','1100','Bank'),
        ('REVENUE.SALES','REVENUE','4000','Sales Revenue')
      ) AS t(key, category, "defaultDisplayCode", "defaultDisplayName")`,
    );
    for (const a of accounts) {
      await sql(
        `INSERT INTO account ("tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [tenantId, companyId, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
      );
    }
    return companyId;
  }
  async function mkOpenPeriod(tenantId: string, companyId: string): Promise<void> {
    await sql(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,version,"updatedAt")
       VALUES (uuidv7(),$1,$2,'2030-01-01','2030-12-31','OPEN',1,now())`,
      [tenantId, companyId],
    );
  }

  // ── permission enforcement ───────────────────────────────────────────────
  it('rejects a caller without accounting:view on the CoA read route', async () => {
    const tok = await mint('p1', tenantA, []);
    const r = await req('GET', `/companies/${companyA}/accounting/accounts`, tok);
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('MISSING_PERMISSION');
  });

  it('rejects a caller without accounting:manage on the account-display PATCH', async () => {
    const tok = await mint('p2', tenantA, ['accounting:view']);
    const acc = (
      await sql<{ id: string }>(`SELECT id FROM account WHERE "companyId"=$1 LIMIT 1`, [companyA])
    )[0]!;
    const r = await req('PATCH', `/companies/${companyA}/accounting/accounts/${acc.id}`, tok, {
      displayName: 'x',
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('MISSING_PERMISSION');
  });

  it('rejects a caller without accounting:period:manage on period create', async () => {
    const tok = await mint('p3', tenantA, ['accounting:view', 'accounting:manage'], {
      stepUp: true,
    });
    const r = await req(
      'POST',
      `/companies/${companyA}/accounting/periods`,
      tok,
      { startDate: '2031-01-01', endDate: '2031-01-31' },
      { 'idempotency-key': 'perm-check-1' },
    );
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('MISSING_PERMISSION');
  });

  // ── step-up enforcement ──────────────────────────────────────────────────
  it('CoA read does NOT require step-up', async () => {
    const tok = await mint('s1', tenantA, ['accounting:view']);
    const r = await req('GET', `/companies/${companyA}/accounting/accounts`, tok);
    expect(r.statusCode).toBe(200);
  });

  it('account-display PATCH does NOT require step-up', async () => {
    const tok = await mint('s2', tenantA, ['accounting:manage']);
    const acc = (
      await sql<{ id: string; updatedAt: Date }>(
        `SELECT id, "updatedAt" FROM account WHERE "companyId"=$1 AND key='ASSET.BANK'`,
        [companyA],
      )
    )[0]!;
    const r = await req(
      'PATCH',
      `/companies/${companyA}/accounting/accounts/${acc.id}`,
      tok,
      { displayName: 'Bank Account' },
      { 'if-match': `"${new Date(acc.updatedAt).toISOString()}"` },
    );
    expect(r.statusCode).toBe(200);
  });

  it('period create requires step-up', async () => {
    const tok = await mint(
      's3',
      tenantA,
      ['accounting:view', 'accounting:manage', 'accounting:period:manage'],
      { stepUp: false },
    );
    const r = await req(
      'POST',
      `/companies/${companyA}/accounting/periods`,
      tok,
      { startDate: '2032-01-01', endDate: '2032-01-31' },
      { 'idempotency-key': 'stepup-check-1' },
    );
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  it('timezone-config requires step-up', async () => {
    const tok = await mint('s4', tenantA, ['accounting:manage'], { stepUp: false });
    const r = await req('PATCH', `/companies/${companyA}/accounting/config/timezone`, tok, {
      accountingTimezone: 'Asia/Riyadh',
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  // ── If-Match enforcement ─────────────────────────────────────────────────
  it('account-display PATCH rejects a stale If-Match', async () => {
    const tok = await mint('m1', tenantA, ['accounting:manage']);
    const acc = (
      await sql<{ id: string }>(
        `SELECT id FROM account WHERE "companyId"=$1 AND key='REVENUE.SALES'`,
        [companyA],
      )
    )[0]!;
    const r = await req(
      'PATCH',
      `/companies/${companyA}/accounting/accounts/${acc.id}`,
      tok,
      { displayName: 'x' },
      { 'if-match': '"1999-01-01T00:00:00.000Z"' },
    );
    expect(r.statusCode).toBe(409);
    expect(errCode(r)).toBe('ACCOUNT_VERSION_CONFLICT');
  });

  it('account-display PATCH rejects setting displayCode to one already used (ACCOUNT_DISPLAY_CODE_CONFLICT)', async () => {
    const tok = await mint('m2', tenantA, ['accounting:manage']);
    const cash = (
      await sql<{ id: string; updatedAt: Date }>(
        `SELECT id, "updatedAt" FROM account WHERE "companyId"=$1 AND key='ASSET.CASH_ON_HAND'`,
        [companyA],
      )
    )[0]!;
    const r = await req(
      'PATCH',
      `/companies/${companyA}/accounting/accounts/${cash.id}`,
      tok,
      { displayCode: '1100' }, // already used by ASSET.BANK
      { 'if-match': `"${new Date(cash.updatedAt).toISOString()}"` },
    );
    expect(r.statusCode).toBe(409);
    expect(errCode(r)).toBe('ACCOUNT_DISPLAY_CODE_CONFLICT');
  });

  it('account-display PATCH rejects an unknown/immutable field via .strict() (400)', async () => {
    const tok = await mint('m3', tenantA, ['accounting:manage']);
    const acc = (
      await sql<{ id: string; updatedAt: Date }>(
        `SELECT id, "updatedAt" FROM account WHERE "companyId"=$1 LIMIT 1`,
        [companyA],
      )
    )[0]!;
    const r = await req(
      'PATCH',
      `/companies/${companyA}/accounting/accounts/${acc.id}`,
      tok,
      { key: 'HACKED.KEY' },
      { 'if-match': `"${new Date(acc.updatedAt).toISOString()}"` },
    );
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe('VALIDATION_FAILED');
  });

  it('period close requires If-Match', async () => {
    const tok = await mint('m4', tenantA, ['accounting:period:manage'], { stepUp: true });
    const p = (
      await sql<{ id: string }>(
        `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,version,"updatedAt")
         VALUES (uuidv7(),$1,$2,'2033-01-01','2033-01-31','OPEN',1,now()) RETURNING id`,
        [tenantA, companyA],
      )
    )[0]!;
    const r = await req('POST', `/companies/${companyA}/accounting/periods/${p.id}/close`, tok);
    expect(r.statusCode).toBe(428);
  });

  // ── period create + Idempotency-Key ──────────────────────────────────────
  it('period create is idempotent under the same Idempotency-Key; rejects overlap', async () => {
    const tok = await mint(
      'i1',
      tenantA,
      ['accounting:view', 'accounting:manage', 'accounting:period:manage'],
      { stepUp: true },
    );
    const body = { startDate: '2034-01-01', endDate: '2034-01-31' };
    const r1 = await req('POST', `/companies/${companyA}/accounting/periods`, tok, body, {
      'idempotency-key': 'period-2034-01',
    });
    expect(r1.statusCode, r1.payload).toBe(201);
    const id1 = (r1.json() as { id: string }).id;

    const r2 = await req('POST', `/companies/${companyA}/accounting/periods`, tok, body, {
      'idempotency-key': 'period-2034-01',
    });
    expect(r2.statusCode, r2.payload).toBe(201);
    expect((r2.json() as { id: string }).id).toBe(id1);

    // a genuinely overlapping range under a DIFFERENT key is rejected
    const r3 = await req(
      'POST',
      `/companies/${companyA}/accounting/periods`,
      tok,
      { startDate: '2034-01-15', endDate: '2034-02-15' },
      { 'idempotency-key': 'period-2034-02' },
    );
    expect(r3.statusCode, r3.payload).toBe(409);
    expect(errCode(r3)).toBe('ACCOUNTING_PERIOD_OVERLAP');
  });

  // ── timezone config ──────────────────────────────────────────────────────
  it('rejects an invalid IANA timezone (ACCOUNTING_TIMEZONE_INVALID)', async () => {
    const tok = await mint('tz1', tenantA, ['accounting:manage'], { stepUp: true });
    const r = await req('PATCH', `/companies/${companyA}/accounting/config/timezone`, tok, {
      accountingTimezone: 'Not/AZone',
    });
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe('ACCOUNTING_TIMEZONE_INVALID');
  });

  it('accepts a valid timezone change', async () => {
    const tok = await mint('tz2', tenantA, ['accounting:manage'], { stepUp: true });
    const r = await req('PATCH', `/companies/${companyA}/accounting/config/timezone`, tok, {
      accountingTimezone: 'Asia/Riyadh',
    });
    expect(r.statusCode, r.payload).toBe(200);
    const row = (
      await sql<{ accountingTimezone: string }>(
        `SELECT "accountingTimezone" FROM company WHERE id=$1`,
        [companyA],
      )
    )[0]!;
    expect(row.accountingTimezone).toBe('Asia/Riyadh');
  });

  // ── cross-tenant / cross-company isolation ───────────────────────────────
  it("a tenant-B caller cannot read tenant-A company accounts (scoped query returns empty, per this codebase's list-endpoint convention — the repository filter, not a 404, is the isolation boundary here)", async () => {
    const tok = await mint('x1', tenantB, ['accounting:view']);
    const r = await req('GET', `/companies/${companyA}/accounting/accounts`, tok);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('a tenant-B caller cannot close a tenant-A period (404)', async () => {
    await mkOpenPeriod(tenantA, companyA);
    const p = (
      await sql<{ id: string; version: number }>(
        `SELECT id, version FROM accounting_period WHERE "companyId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
        [companyA],
      )
    )[0]!;
    const tokB = await mint('x2b', tenantB, ['accounting:period:manage'], { stepUp: true });
    const r = await req(
      'POST',
      `/companies/${companyA}/accounting/periods/${p.id}/close`,
      tokB,
      undefined,
      { 'if-match': `"${p.version}"` },
    );
    expect(r.statusCode).toBe(404);
  });

  // ── existing-company Accounting Setup bootstrap (§P) ─────────────────────
  it('setup rejects a caller without accounting:manage', async () => {
    const tok = await mint('su1', tenantA, [], { stepUp: true });
    const r = await req('POST', `/companies/${companyA}/accounting/setup`, tok, {
      accountingTimezone: 'Asia/Dubai',
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('MISSING_PERMISSION');
  });

  it('setup requires step-up', async () => {
    const tok = await mint('su2', tenantA, ['accounting:manage'], { stepUp: false });
    const r = await req('POST', `/companies/${companyA}/accounting/setup`, tok, {
      accountingTimezone: 'Asia/Dubai',
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  it('setup rejects an invalid IANA timezone', async () => {
    const tok = await mint('su3', tenantA, ['accounting:manage'], { stepUp: true });
    const r = await req('POST', `/companies/${companyA}/accounting/setup`, tok, {
      accountingTimezone: 'Not/AZone',
    });
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe('ACCOUNTING_TIMEZONE_INVALID');
  });

  it('setup is idempotent, backfills only missing default accounts, preserves an existing customization, and never creates an AccountingPeriod', async () => {
    const preexistingTenant = await mkTenant('accSetup');
    const preexistingCompany = (
      await sql<{ id: string }>(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency",status,"updatedAt")
         VALUES (uuidv7(),$1,'Pre-3b.1 Co','AE','AED','ACTIVE',now()) RETURNING id`,
        [preexistingTenant],
      )
    )[0]!.id; // note: NO accountingTimezone set — simulates a pre-3b.1 company
    // seed exactly one account with a customized displayCode, none of the other 13
    await sql(
      `INSERT INTO account ("tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
       VALUES ($1,$2,'ASSET.CASH_ON_HAND','ASSET','9999','My Custom Cash Name',now())`,
      [preexistingTenant, preexistingCompany],
    );

    const tok = await mint('su4', preexistingTenant, ['accounting:manage', 'accounting:view'], {
      stepUp: true,
    });

    const r1 = await req('POST', `/companies/${preexistingCompany}/accounting/setup`, tok, {
      accountingTimezone: 'Asia/Dubai',
    });
    expect(r1.statusCode, r1.payload).toBe(201);
    expect((r1.json() as { accountsCreated: number }).accountsCreated).toBe(13); // 14 - 1 pre-existing

    const afterFirst = await sql<{ key: string; displayCode: string }>(
      `SELECT key, "displayCode" FROM account WHERE "companyId"=$1 ORDER BY key`,
      [preexistingCompany],
    );
    expect(afterFirst).toHaveLength(14);
    expect(afterFirst.find((a) => a.key === 'ASSET.CASH_ON_HAND')?.displayCode).toBe('9999');

    // second call — retry-safe, no duplicates, customization still preserved
    const r2 = await req('POST', `/companies/${preexistingCompany}/accounting/setup`, tok, {
      accountingTimezone: 'Asia/Dubai',
    });
    expect(r2.statusCode, r2.payload).toBe(201);
    expect((r2.json() as { accountsCreated: number }).accountsCreated).toBe(0);

    const afterSecond = await sql<{ key: string; displayCode: string }>(
      `SELECT key, "displayCode" FROM account WHERE "companyId"=$1 ORDER BY key`,
      [preexistingCompany],
    );
    expect(afterSecond).toHaveLength(14);
    expect(afterSecond.find((a) => a.key === 'ASSET.CASH_ON_HAND')?.displayCode).toBe('9999');

    const tz = (
      await sql<{ accountingTimezone: string }>(
        `SELECT "accountingTimezone" FROM company WHERE id=$1`,
        [preexistingCompany],
      )
    )[0]!;
    expect(tz.accountingTimezone).toBe('Asia/Dubai');

    const periods = await sql(`SELECT id FROM accounting_period WHERE "companyId"=$1`, [
      preexistingCompany,
    ]);
    expect(periods).toHaveLength(0);

    const audits = await sql<{ action: string }>(
      `SELECT action FROM audit_log WHERE "companyId"=$1 ORDER BY at ASC`,
      [preexistingCompany],
    );
    const actions = audits.map((a) => a.action);
    expect(actions.filter((a) => a === 'accounting.company_timezone_configured')).toHaveLength(2); // one per call
    expect(actions.filter((a) => a === 'accounting.company_coa_backfilled')).toHaveLength(2); // one per call, 0-inserted the 2nd time
  });

  it('a company-B-scoped period id cannot be closed via company-A path (404)', async () => {
    await mkOpenPeriod(tenantB, companyB);
    const pB = (
      await sql<{ id: string; version: number }>(
        `SELECT id, version FROM accounting_period WHERE "companyId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
        [companyB],
      )
    )[0]!;
    const tok = await mint('x3', tenantB, ['accounting:period:manage'], { stepUp: true });
    const r = await req(
      'POST',
      `/companies/${companyA}/accounting/periods/${pB.id}/close`,
      tok,
      undefined,
      { 'if-match': `"${pB.version}"` },
    );
    expect(r.statusCode).toBe(404);
  });
});

async function seed(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO platform_user (id, email, name, "updatedAt")
      VALUES ('${PLATFORM_USER}', 'admin-3b1@flower.test', 'Platform Admin', now());
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b0000', 'starter-3b1', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b0000', 1, 'PUBLISHED', now());
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
        ('AED', 2, 'AED', 'x', 'x') ON CONFLICT DO NOTHING;
      INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
      VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT DO NOTHING;
    `);
  } finally {
    await c.end();
  }
}
