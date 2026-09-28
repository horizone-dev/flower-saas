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
import { SYSTEM_ROLE_TEMPLATES } from '../platform/system-roles.js';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';

/**
 * Task 3b.7 Checkpoint D — the `POST .../settlements/:id/finalize` route,
 * proven at the real HTTP layer: permission matrix, step-up enforcement,
 * cross-tenant/company/branch isolation, If-Match/version-CAS surface, and
 * one full create->addLine->match->finalize round trip through the real
 * controller stack. Deep financial correctness (Applications/journal/
 * projection/audit/outbox atomicity, concurrency races, capacity, mixed
 * coverage) is proven directly against the repository in
 * `settlement-finalization.repository.integration.test.ts` — this file is
 * deliberately narrow, mirroring how Checkpoint C split its own HTTP
 * permission tests from deeper matching-authority assertions.
 *
 * A SEPARATE file from `settlement-batch.controller.integration.test.ts`
 * (Checkpoint C, already committed/frozen) — never edited, to keep this
 * checkpoint's diff cleanly additive.
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b7f01';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b7f00', 'starter-3b7f', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b7f00', 1, 'PUBLISHED', now());
      INSERT INTO limit_default ("planVersionId", "limitKey", value)
      VALUES ('${PLAN_V}', 'max_branches', 5), ('${PLAN_V}', 'max_sessions_per_user', 80),
             ('${PLAN_V}', 'max_users', 80), ('${PLAN_V}', 'max_companies', 10);
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
      VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING;
    `);
  } finally {
    await c.end();
  }
}

describe('SettlementBatchController.finalize (task 3b.7 Checkpoint D, HTTP integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let tenantB = '';
  let coA = '';
  let branchA = '';
  let credA = '';
  let coB = '';
  let branchB = '';
  let credB = '';
  let branchA2 = '';
  let credA2 = '';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    await seedPlan(stack.postgres.url);

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

    tenantA = await sqlOne(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'settle-3b7f-a', 'settle-3b7f-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`,
    );
    tenantB = await sqlOne(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'settle-3b7f-b', 'settle-3b7f-b', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`,
    );
    coA = await sqlOne(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES (uuidv7(),$1,'Co A','AED','Asia/Dubai',now()) RETURNING id`,
      [tenantA],
    );
    branchA = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch A',now()) RETURNING id`,
      [tenantA, coA],
    );
    credA = await sqlOne(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
      [tenantA, coA, branchA],
    );
    await sql(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES (uuidv7(),$1,$2,'2026-01-01','2026-12-31','OPEN',now())`,
      [tenantA, coA],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await sql(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,now())`,
        [tenantA, coA, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
      );
    }

    // a SECOND branch under Company A (cross-branch isolation).
    branchA2 = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch A2',now()) RETURNING id`,
      [tenantA, coA],
    );
    credA2 = await sqlOne(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
      [tenantA, coA, branchA2],
    );

    // a SECOND company under tenant A (cross-company isolation) — its own
    // branch, credential, accounting period, and reference accounts.
    coB = await sqlOne(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES (uuidv7(),$1,'Co B','AED','Asia/Dubai',now()) RETURNING id`,
      [tenantA],
    );
    branchB = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch B',now()) RETURNING id`,
      [tenantA, coB],
    );
    credB = await sqlOne(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
      [tenantA, coB, branchB],
    );
    await sql(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES (uuidv7(),$1,$2,'2026-01-01','2026-12-31','OPEN',now())`,
      [tenantA, coB],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await sql(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,now())`,
        [tenantA, coB, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await stack?.stop();
    for (const k of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL', 'AUTH_JWT_SECRET']) {
      delete process.env[k];
    }
  });

  function baseSess(
    sessionId: string,
    forTenant: string,
    mfaLevel: 'NONE' | 'STEP_UP',
  ): SessionData {
    return {
      sessionId,
      realm: 'tenant',
      familyId: 'f',
      tenantId: forTenant,
      userId: null,
      platformUserId: null,
      accountType: 'OWNER',
      posTerminalId: null,
      deviceId: null,
      mfaLevel,
      stepUpUntil: mfaLevel === 'STEP_UP' ? Date.now() + 3_600_000 : null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      revokeReason: null,
      impersonatorPlatformUserId: null,
      access: null,
    };
  }
  const userIds = new Map<string, string>();
  let userSeq = 0;
  async function mintTenant(
    id: string,
    forTenant: string,
    perms: string[],
    mfaLevel: 'NONE' | 'STEP_UP' = 'STEP_UP',
    scope: { companyScope?: 'ALL' | string[]; branchScope?: 'ALL' | string[] } = {},
  ): Promise<string> {
    const s = baseSess(`ten-${id}`, forTenant, mfaLevel);
    let uidVal = userIds.get(id);
    if (uidVal === undefined) {
      uidVal = `00000000-0000-7000-8000-${String(++userSeq).padStart(12, '0')}`;
      userIds.set(id, uidVal);
    }
    s.userId = uidVal;
    s.access = {
      effectivePermissions: perms,
      companyScope: scope.companyScope ?? 'ALL',
      branchScope: scope.branchScope ?? 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: s.userId, sid: s.sessionId, aud: 'tenant', tid: forTenant });
  }
  function rolePerms(key: string): string[] {
    const tpl = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === key);
    if (!tpl) throw new Error(`no system role template for "${key}"`);
    return [...tpl.permissions];
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
  async function sqlOne(text: string, params: unknown[] = []): Promise<string> {
    const rows = await sql<{ id: string }>(text, params);
    return rows[0]!.id;
  }
  let idemN = 0;
  const ik = (): string => `settle-fin-key-${String(++idemN).padStart(4, '0')}`;
  let extIdN = 0;
  const extId = (): string => `settle-fin-ext-${String(++extIdN).padStart(6, '0')}`;

  async function insertProviderPayment(
    amountMinor = 1000,
    forCompany = coA,
    forBranch = branchA,
    forCredential = credA,
  ): Promise<string> {
    const customerId = await sqlOne(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES (uuidv7(),$1,'Cust',now()) RETURNING id`,
      [tenantA],
    );
    const ccaId = await sqlOne(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,now()) RETURNING id`,
      [tenantA, forCompany, customerId],
    );
    const attemptId = await sqlOne(
      `INSERT INTO payment_attempt
         (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",
          method,"providerKey","providerCredentialId","amountMinor","currencyCode",
          "currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'CUSTOMER_RECEIPT',$4,'ONLINE_GATEWAY','tap',$5,$6,'AED',2,'CAPTURED',$7,now())
       RETURNING id`,
      [tenantA, forCompany, forBranch, ccaId, forCredential, amountMinor, `idem-${Math.random()}`],
    );
    return sqlOne(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey","amountMinor","currencyCode","currencyExponent")
       VALUES (uuidv7(),$1,$2,$3,$4,'ONLINE_GATEWAY','tap',$5,'AED',2) RETURNING id`,
      [tenantA, forCompany, forBranch, attemptId, amountMinor],
    );
  }

  const baseUrl = (forCoA = coA, forBranchA = branchA): string =>
    `/companies/${forCoA}/branches/${forBranchA}/settlements`;

  /** returns a DRAFT batch id with exactly one matched Line, ready to finalize
   *  at expectedVersion=3 (create=1, addLine=2, match=3). Defaults to
   *  Company A / Branch A / credA; pass overrides to target another
   *  company/branch/credential (cross-scope isolation tests). */
  async function draftMatchedBatch(
    token: string,
    amountMinor = 1000,
    forCompany = coA,
    forBranch = branchA,
    forCredential = credA,
  ): Promise<{ id: string; payment: string }> {
    const url = baseUrl(forCompany, forBranch);
    const created = await req(
      'POST',
      url,
      token,
      {
        providerCredentialId: forCredential,
        externalSettlementId: extId(),
        providerSettlementDate: '2026-06-01',
        grossSettlementMinor: String(amountMinor),
        providerFeeMinor: '0',
        netBankMinor: String(amountMinor),
        currencyCode: 'AED',
      },
      { 'idempotency-key': ik() },
    );
    const id = created.json().id as string;
    const payment = await insertProviderPayment(amountMinor, forCompany, forBranch, forCredential);
    const lineRes = await req(
      'POST',
      `${url}/${id}/lines`,
      token,
      { amountMinor: String(amountMinor) },
      { 'if-match': '1' },
    );
    const lineId = lineRes.json().line.id as string;
    await req(
      'POST',
      `${url}/${id}/lines/${lineId}/match`,
      token,
      { paymentId: payment },
      { 'if-match': '2' },
    );
    return { id, payment };
  }

  describe('permission matrix', () => {
    it('owner can finalize', async () => {
      const owner = await mintTenant('fin-owner1', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, owner, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().state).toBe('FINALIZED');
    });

    it('admin can finalize', async () => {
      const admin = await mintTenant('fin-admin1', tenantA, rolePerms('admin'));
      const { id } = await draftMatchedBatch(admin);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, admin, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('accountant can finalize', async () => {
      const accountant = await mintTenant('fin-accountant1', tenantA, rolePerms('accountant'));
      const { id } = await draftMatchedBatch(accountant);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, accountant, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('manager (settlements:manage, no finalize) is denied 403', async () => {
      const manager = await mintTenant('fin-manager1', tenantA, rolePerms('manager'));
      const { id } = await draftMatchedBatch(manager);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, manager, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
    });

    it('cashier is denied 403', async () => {
      const cashier = await mintTenant('fin-cashier1', tenantA, rolePerms('cashier'));
      const owner = await mintTenant('fin-owner-setup1', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, cashier, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
    });

    it('sales is denied 403', async () => {
      const sales = await mintTenant('fin-sales1', tenantA, rolePerms('sales'));
      const owner = await mintTenant('fin-owner-setup2', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, sales, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('step-up enforcement (complete Owner/Admin/Accountant matrix)', () => {
    it('owner WITH a fresh step-up -> ALLOWED (200)', async () => {
      const owner = await mintTenant('fin-owner-stepup', tenantA, rolePerms('owner'), 'STEP_UP');
      const { id } = await draftMatchedBatch(owner);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, owner, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('owner WITHOUT a fresh step-up -> 403 STEP_UP_REQUIRED', async () => {
      const ownerNoStepUp = await mintTenant(
        'fin-owner-nostepup',
        tenantA,
        rolePerms('owner'),
        'NONE',
      );
      const { id } = await draftMatchedBatch(ownerNoStepUp);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, ownerNoStepUp, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    });

    it('admin WITH a fresh step-up -> ALLOWED (200)', async () => {
      const admin = await mintTenant('fin-admin-stepup', tenantA, rolePerms('admin'), 'STEP_UP');
      const { id } = await draftMatchedBatch(admin);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, admin, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('admin WITHOUT a fresh step-up -> 403 STEP_UP_REQUIRED', async () => {
      const adminNoStepUp = await mintTenant(
        'fin-admin-nostepup',
        tenantA,
        rolePerms('admin'),
        'NONE',
      );
      const { id } = await draftMatchedBatch(adminNoStepUp);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, adminNoStepUp, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    });

    it('accountant WITH a fresh step-up -> ALLOWED (200)', async () => {
      const accountant = await mintTenant(
        'fin-accountant-stepup',
        tenantA,
        rolePerms('accountant'),
        'STEP_UP',
      );
      const { id } = await draftMatchedBatch(accountant);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, accountant, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode, res.payload).toBe(200);
    });

    it('accountant WITHOUT a fresh step-up -> 403 STEP_UP_REQUIRED', async () => {
      const accountantNoStepUp = await mintTenant(
        'fin-accountant-nostepup',
        tenantA,
        rolePerms('accountant'),
        'NONE',
      );
      const { id } = await draftMatchedBatch(accountantNoStepUp);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, accountantNoStepUp, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    });

    it('manager is denied 403 regardless of step-up (no settlements:finalize permission at all)', async () => {
      const managerStepUp = await mintTenant(
        'fin-manager-stepup',
        tenantA,
        rolePerms('manager'),
        'STEP_UP',
      );
      const owner = await mintTenant('fin-owner-setup-mgr', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, managerStepUp, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).not.toBe('STEP_UP_REQUIRED'); // denied on permission, not step-up
    });
  });

  describe('If-Match / version-CAS', () => {
    it('missing If-Match -> 400', async () => {
      const owner = await mintTenant('fin-owner-nomatch', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, owner);
      expect(res.statusCode).toBe(428); // requireIfMatch's own convention (Precondition Required)
    });

    it('stale If-Match -> 409 SETTLEMENT_VERSION_CONFLICT', async () => {
      const owner = await mintTenant('fin-owner-stale', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, owner, undefined, {
        'if-match': '99',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SETTLEMENT_VERSION_CONFLICT');
    });

    it('finalizing twice -> second call is 409 SETTLEMENT_ALREADY_FINALIZED', async () => {
      const owner = await mintTenant('fin-owner-twice', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner);
      const first = await req('POST', `${baseUrl()}/${id}/finalize`, owner, undefined, {
        'if-match': '3',
      });
      expect(first.statusCode, first.payload).toBe(200);
      const second = await req('POST', `${baseUrl()}/${id}/finalize`, owner, undefined, {
        'if-match': String(first.json().version),
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('SETTLEMENT_ALREADY_FINALIZED');
    });
  });

  describe('cross-scope isolation', () => {
    it('a batch created under tenant A cannot be finalized via tenant B session -> 404', async () => {
      const ownerA = await mintTenant('fin-ownerA-x', tenantA, rolePerms('owner'));
      const ownerB = await mintTenant('fin-ownerB-x', tenantB, rolePerms('owner'));
      const { id } = await draftMatchedBatch(ownerA);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, ownerB, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(404);
    });

    it('cross-company: an actor with settlement finalize authority scoped ONLY to Company A cannot finalize a Batch belonging to Company B -> 404, no mutation', async () => {
      // the batch-creating actor is scoped to Company B itself, so fixture
      // setup succeeds; the ATTACKING actor is a real owner (finalize
      // authority) whose OWN access token is scoped to Company A only.
      const ownerSetupB = await mintTenant('fin-owner-setup-coB', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(ownerSetupB, 1000, coB, branchB, credB);
      const ownerScopedToA = await mintTenant(
        'fin-owner-scoped-coA',
        tenantA,
        rolePerms('owner'),
        'STEP_UP',
        { companyScope: [coA], branchScope: 'ALL' },
      );
      const res = await req(
        'POST',
        `/companies/${coB}/branches/${branchB}/settlements/${id}/finalize`,
        ownerScopedToA,
        undefined,
        { 'if-match': '3' },
      );
      expect(res.statusCode).toBe(404);
      const row = await sql<{ state: string }>(`SELECT state FROM settlement_batch WHERE id = $1`, [
        id,
      ]);
      expect(row[0]!.state).toBe('DRAFT');
      const appCount = await sql<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM settlement_application WHERE "batchId" = $1`,
        [id],
      );
      expect(appCount[0]!.n).toBe('0');
    });

    it('cross-branch: a branch-scoped actor (Branch A only) cannot finalize a Batch belonging Branch A2 (same Company A) -> 404, no mutation', async () => {
      const ownerSetupA2 = await mintTenant('fin-owner-setup-a2', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(ownerSetupA2, 1000, coA, branchA2, credA2);
      const ownerScopedToBranchA = await mintTenant(
        'fin-owner-scoped-branchA',
        tenantA,
        rolePerms('owner'),
        'STEP_UP',
        { companyScope: 'ALL', branchScope: [branchA] },
      );
      const res = await req(
        'POST',
        `/companies/${coA}/branches/${branchA2}/settlements/${id}/finalize`,
        ownerScopedToBranchA,
        undefined,
        { 'if-match': '3' },
      );
      expect(res.statusCode).toBe(404);
      const row = await sql<{ state: string }>(`SELECT state FROM settlement_batch WHERE id = $1`, [
        id,
      ]);
      expect(row[0]!.state).toBe('DRAFT');
      const appCount = await sql<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM settlement_application WHERE "batchId" = $1`,
        [id],
      );
      expect(appCount[0]!.n).toBe('0');
    });

    it("a tenant-wide (branchScope: ALL) owner is UNAFFECTED by another actor's branch restriction — same Branch A2 batch finalizes normally for an unrestricted owner", async () => {
      const ownerSetupA2b = await mintTenant('fin-owner-setup-a2b', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(ownerSetupA2b, 500, coA, branchA2, credA2);
      const res = await req(
        'POST',
        `/companies/${coA}/branches/${branchA2}/settlements/${id}/finalize`,
        ownerSetupA2b,
        undefined,
        { 'if-match': '3' },
      );
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().state).toBe('FINALIZED');
    });
  });

  describe('end-to-end happy path (real HTTP stack)', () => {
    it('create -> addLine -> match -> finalize: 200, FINALIZED, journalEntryId present, etag reflects new version, response never exposes credential/provider secrets; audit + outbox rows are bounded', async () => {
      const owner = await mintTenant('fin-e2e-owner', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(owner, 750);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, owner, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode, res.payload).toBe(200);
      const body = res.json();
      expect(body.state).toBe('FINALIZED');
      expect(body.journalEntryId).toBeTruthy();
      expect(body.finalizedAt).toBeTruthy();
      // create=v1 -> addLine=v2 -> match=v3 -> finalize=v4 (the atomic
      // DRAFT->FINALIZED transition's own +1, per the frozen CAS convention).
      expect(body.version).toBe(4);
      expect(res.headers['etag']).toBe('"4"');
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/secretCiphertext|secretNonce|dekWrapped/i);

      // audit: exactly one bounded `settlement.finalized` row — no provider
      // secret/raw payload/PII, no Payment id array, no Invoice id array.
      const auditRows = await sql<{ after: Record<string, unknown> }>(
        `SELECT "after" FROM audit_log WHERE action = 'settlement.finalized' AND "resourceId" = $1`,
        [id],
      );
      expect(auditRows).toHaveLength(1);
      const auditAfter = JSON.stringify(auditRows[0]!.after);
      expect(auditAfter).not.toMatch(/secretCiphertext|secretNonce|dekWrapped|providerKey/i);
      expect(Object.keys(auditRows[0]!.after).sort()).toEqual(
        [
          'currencyCode',
          'grossSettlementMinor',
          'matchedPaymentCount',
          'netBankMinor',
          'providerFeeMinor',
        ].sort(),
      );

      // outbox: exactly one bounded `payments.settlement_finalized` event,
      // payload = { settlementBatchId } only.
      const outboxRows = await sql<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM outbox WHERE "eventType" = 'payments.settlement_finalized' AND "aggregateId" = $1`,
        [id],
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]!.payload).toEqual({ settlementBatchId: id });
    });

    it('a denied finalize response also never exposes credential/provider secrets', async () => {
      const cashier = await mintTenant('fin-secret-leak-cashier', tenantA, rolePerms('cashier'));
      const ownerSetup = await mintTenant('fin-secret-leak-owner', tenantA, rolePerms('owner'));
      const { id } = await draftMatchedBatch(ownerSetup);
      const res = await req('POST', `${baseUrl()}/${id}/finalize`, cashier, undefined, {
        'if-match': '3',
      });
      expect(res.statusCode).toBe(403);
      expect(res.payload).not.toMatch(/secretCiphertext|secretNonce|dekWrapped/i);
    });
  });
});
