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
import { STEP_UP_PERMISSIONS } from '@flower/permissions';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';

/**
 * Task 3b.7 Checkpoint C — the DRAFT SettlementBatch/Line HTTP surface,
 * proven at the real HTTP layer. Mirrors
 * `opening-balance.controller.integration.test.ts`'s harness exactly.
 */
const PLAN_V = '00000000-0000-7000-8000-0000003b7c01';

async function seedPlan(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`
      INSERT INTO plan (id, key, name, "updatedAt")
      VALUES ('00000000-0000-7000-8000-0000003b7c00', 'starter-3b7c', 'Starter', now());
      INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
      VALUES ('${PLAN_V}', '00000000-0000-7000-8000-0000003b7c00', 1, 'PUBLISHED', now());
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

describe('SettlementBatchController (task 3b.7 Checkpoint C, HTTP integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let tenantA = '';
  let tenantB = '';
  let coA = '';
  let branchA = '';
  let branchA2 = '';
  let credA = '';
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
       VALUES (uuidv7(), 'settle-3b7c-a', 'settle-3b7c-a', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`,
    );
    tenantB = await sqlOne(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES (uuidv7(), 'settle-3b7c-b', 'settle-3b7c-b', 'AE', 'ACTIVE', '${PLAN_V}', now()) RETURNING id`,
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
    branchA2 = await sqlOne(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Branch A2',now()) RETURNING id`,
      [tenantA, coA],
    );
    credA = await sqlOne(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
      [tenantA, coA, branchA],
    );
    credA2 = await sqlOne(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
      [tenantA, coA, branchA2],
    );
    // fixtures for the one test that builds a genuinely FINALIZED batch via
    // raw SQL (Checkpoint C has no finalize route of its own).
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
      companyScope: 'ALL',
      branchScope: 'ALL',
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
  const ik = (): string => `settle-key-${String(++idemN).padStart(4, '0')}`;
  let extIdN = 0;
  const extId = (): string => `ext-${String(++extIdN).padStart(6, '0')}`;

  /** a provider-backed (ONLINE_GATEWAY), CAPTURED PaymentAttempt -> Payment pair. */
  /** A provider-backed (ONLINE_GATEWAY or credential-backed CARD_TERMINAL),
   *  CAPTURED PaymentAttempt -> Payment pair. */
  async function insertProviderPayment(
    credentialId: string,
    branchId: string,
    amountMinor = 1000,
    providerReference?: string,
    method: 'ONLINE_GATEWAY' | 'CARD_TERMINAL' = 'ONLINE_GATEWAY',
    providerKey = 'tap',
    currencyCode = 'AED',
    currencyExponent = 2,
    companyId = coA,
  ): Promise<string> {
    const customerId = await sqlOne(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES (uuidv7(),$1,'Cust',now()) RETURNING id`,
      [tenantA],
    );
    const ccaId = await sqlOne(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,now()) RETURNING id`,
      [tenantA, companyId, customerId],
    );
    const attemptId = await sqlOne(
      `INSERT INTO payment_attempt
         (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",
          method,"providerKey","providerCredentialId","providerReference","amountMinor","currencyCode",
          "currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'CUSTOMER_RECEIPT',$4,$5,$6,$7,$8,$9,$10,$11,'CAPTURED',$12,now())
       RETURNING id`,
      [
        tenantA,
        companyId,
        branchId,
        ccaId,
        method,
        providerKey,
        credentialId,
        providerReference ?? null,
        amountMinor,
        currencyCode,
        currencyExponent,
        `idem-${Math.random()}`,
      ],
    );
    return sqlOne(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey","amountMinor","currencyCode","currencyExponent")
       VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        tenantA,
        companyId,
        branchId,
        attemptId,
        method,
        providerKey,
        amountMinor,
        currencyCode,
        currencyExponent,
      ],
    );
  }

  /** A non-provider-backed (CASH/BANK_TRANSFER/OTHER_MANUAL) Payment — never
   *  settlement-eligible. */
  async function insertNonProviderPayment(
    method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL',
    branchId = branchA,
    amountMinor = 500,
  ): Promise<string> {
    const customerId = await sqlOne(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES (uuidv7(),$1,'Cust',now()) RETURNING id`,
      [tenantA],
    );
    const ccaId = await sqlOne(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt") VALUES (uuidv7(),$1,$2,$3,now()) RETURNING id`,
      [tenantA, coA, customerId],
    );
    const attemptId = await sqlOne(
      `INSERT INTO payment_attempt (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES (uuidv7(),$1,$2,$3,'CUSTOMER_RECEIPT',$4,$5,$6,'AED',2,'CAPTURED',$7,now()) RETURNING id`,
      [tenantA, coA, branchId, ccaId, method, amountMinor, `idem-${Math.random()}`],
    );
    return sqlOne(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
       VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,'AED',2) RETURNING id`,
      [tenantA, coA, branchId, attemptId, method, amountMinor],
    );
  }

  const baseUrl = (branchId = branchA): string =>
    `/companies/${coA}/branches/${branchId}/settlements`;

  async function createBatch(
    token: string,
    overrides: Partial<{
      providerCredentialId: string;
      externalSettlementId: string;
      grossSettlementMinor: string;
      providerFeeMinor: string;
      netBankMinor: string;
      currencyCode: string;
      branchId: string;
    }> = {},
  ) {
    return req(
      'POST',
      baseUrl(overrides.branchId ?? branchA),
      token,
      {
        providerCredentialId: overrides.providerCredentialId ?? credA,
        externalSettlementId: overrides.externalSettlementId ?? extId(),
        providerSettlementDate: '2026-06-01',
        grossSettlementMinor: overrides.grossSettlementMinor ?? '1000',
        providerFeeMinor: overrides.providerFeeMinor ?? '30',
        netBankMinor: overrides.netBankMinor ?? '970',
        currencyCode: overrides.currencyCode ?? 'AED',
      },
      { 'idempotency-key': ik() },
    );
  }

  // ═══════════════════════ permission matrix (item 22/26/31) ════════════════
  describe('permission matrix', () => {
    it('owner can create a batch', async () => {
      const owner = await mintTenant('owner1', tenantA, rolePerms('owner'));
      const res = await createBatch(owner);
      expect(res.statusCode, res.payload).toBe(201);
    });
    it('admin can create a batch', async () => {
      const admin = await mintTenant('admin1', tenantA, rolePerms('admin'));
      const res = await createBatch(admin);
      expect(res.statusCode, res.payload).toBe(201);
    });
    it('accountant can create a batch (first real permission grant)', async () => {
      const accountant = await mintTenant('accountant1', tenantA, rolePerms('accountant'));
      const res = await createBatch(accountant);
      expect(res.statusCode, res.payload).toBe(201);
    });
    it('manager can create a batch (settlements:manage, no finalize)', async () => {
      const manager = await mintTenant('manager1', tenantA, rolePerms('manager'));
      const res = await createBatch(manager);
      expect(res.statusCode, res.payload).toBe(201);
    });
    it('cashier is denied (no settlements:manage)', async () => {
      const cashier = await mintTenant('cashier1', tenantA, rolePerms('cashier'));
      const res = await createBatch(cashier);
      expect(res.statusCode).toBe(403);
    });
    it('sales is denied (no settlements:manage)', async () => {
      const sales = await mintTenant('sales1', tenantA, rolePerms('sales'));
      const res = await createBatch(sales);
      expect(res.statusCode).toBe(403);
    });
    it('cashier is denied read access too (no settlements:view)', async () => {
      const cashier = await mintTenant('cashier2', tenantA, rolePerms('cashier'));
      const res = await req('GET', baseUrl(), cashier);
      expect(res.statusCode).toBe(403);
    });
    it('settlements:view/manage require no step-up; settlements:finalize does', () => {
      expect(STEP_UP_PERMISSIONS.has('settlements:finalize')).toBe(true);
      expect(STEP_UP_PERMISSIONS.has('settlements:view')).toBe(false);
      expect(STEP_UP_PERMISSIONS.has('settlements:manage')).toBe(false);
    });
    it('owner/admin/accountant hold settlements:finalize; manager/cashier/sales do not', () => {
      for (const key of ['owner', 'admin', 'accountant']) {
        expect(rolePerms(key), key).toContain('settlements:finalize');
      }
      for (const key of ['manager', 'cashier', 'sales']) {
        expect(rolePerms(key), key).not.toContain('settlements:finalize');
      }
    });
    it('creating a batch WITHOUT step-up still succeeds (settlements:manage is not step-up gated)', async () => {
      const owner = await mintTenant('owner-nostepup', tenantA, rolePerms('owner'), 'NONE');
      const res = await createBatch(owner);
      expect(res.statusCode, res.payload).toBe(201);
    });
  });

  // ═══════════════════════ create + idempotency (item 23/31) ═══════════════
  describe('create + idempotency', () => {
    it('valid DRAFT batch create', async () => {
      const owner = await mintTenant('c-owner', tenantA, rolePerms('owner'));
      const res = await createBatch(owner);
      expect(res.statusCode, res.payload).toBe(201);
      const body = res.json();
      expect(body.state).toBe('DRAFT');
      expect(body.version).toBe(1);
      expect(body.journalEntryId).toBeNull();
      expect(body.finalizedAt).toBeNull();
    });

    it('wrong-branch credential rejected', async () => {
      const owner = await mintTenant('c-owner2', tenantA, rolePerms('owner'));
      const res = await createBatch(owner, { providerCredentialId: credA2, branchId: branchA });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_BRANCH_MISMATCH');
    });

    it('wrong-company credential rejected', async () => {
      const owner = await mintTenant('c-owner3', tenantA, rolePerms('owner'));
      const otherCo = await sqlOne(
        `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
         VALUES (uuidv7(),$1,'Other Co','AED','Asia/Dubai',now()) RETURNING id`,
        [tenantA],
      );
      const otherBranch = await sqlOne(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Other Branch',now()) RETURNING id`,
        [tenantA, otherCo],
      );
      const otherCred = await sqlOne(
        `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
        [tenantA, otherCo, otherBranch],
      );
      const res = await createBatch(owner, { providerCredentialId: otherCred });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_BRANCH_MISMATCH');
    });

    it('externalSettlementId conflict -> stable 409; same id under a DIFFERENT credential succeeds', async () => {
      const owner = await mintTenant('c-owner4', tenantA, rolePerms('owner'));
      const sameExtId = extId();
      const first = await createBatch(owner, { externalSettlementId: sameExtId });
      expect(first.statusCode, first.payload).toBe(201);
      const dup = await createBatch(owner, { externalSettlementId: sameExtId });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('SETTLEMENT_EXTERNAL_ID_CONFLICT');
      const differentCred = await createBatch(owner, {
        externalSettlementId: sameExtId,
        providerCredentialId: credA2,
        branchId: branchA2,
      });
      expect(differentCred.statusCode, differentCred.payload).toBe(201);
    });

    it('Money equation invalid rejected', async () => {
      const owner = await mintTenant('c-owner5', tenantA, rolePerms('owner'));
      const res = await createBatch(owner, {
        grossSettlementMinor: '1000',
        providerFeeMinor: '30',
        netBankMinor: '900',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_TOTAL_MISMATCH');
    });

    it('currency injection/rewrite rejected — must equal the company default (AED)', async () => {
      await sql(
        `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('USD',2,'$','x','x') ON CONFLICT (code) DO NOTHING`,
      );
      const owner = await mintTenant('c-owner6', tenantA, rolePerms('owner'));
      const res = await createBatch(owner, { currencyCode: 'USD' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_CURRENCY_MISMATCH');
    });

    it('create idempotency replay — same key + same payload returns the SAME batch', async () => {
      const owner = await mintTenant('c-owner7', tenantA, rolePerms('owner'));
      const key = ik();
      const payload = {
        providerCredentialId: credA,
        externalSettlementId: extId(),
        providerSettlementDate: '2026-06-01',
        grossSettlementMinor: '1000',
        providerFeeMinor: '30',
        netBankMinor: '970',
        currencyCode: 'AED',
      };
      const first = await req('POST', baseUrl(), owner, payload, { 'idempotency-key': key });
      expect(first.statusCode, first.payload).toBe(201);
      const replay = await req('POST', baseUrl(), owner, payload, { 'idempotency-key': key });
      expect(replay.statusCode).toBe(201);
      expect(replay.json().id).toBe(first.json().id);
    });

    it('same idempotency key + changed payload -> conflict', async () => {
      const owner = await mintTenant('c-owner8', tenantA, rolePerms('owner'));
      const key = ik();
      const payloadA = {
        providerCredentialId: credA,
        externalSettlementId: extId(),
        providerSettlementDate: '2026-06-01',
        grossSettlementMinor: '1000',
        providerFeeMinor: '30',
        netBankMinor: '970',
        currencyCode: 'AED',
      };
      const first = await req('POST', baseUrl(), owner, payloadA, { 'idempotency-key': key });
      expect(first.statusCode, first.payload).toBe(201);
      const payloadB = { ...payloadA, externalSettlementId: extId() };
      const conflict = await req('POST', baseUrl(), owner, payloadB, { 'idempotency-key': key });
      expect(conflict.statusCode).toBe(409);
    });
  });

  // ═══════════════════════ edit (item 23) ═══════════════════════════════════
  describe('edit', () => {
    it('edit requires expectedVersion (If-Match)', async () => {
      const owner = await mintTenant('e-owner', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req('PATCH', `${baseUrl()}/${id}`, owner, {
        grossSettlementMinor: '2000',
        providerFeeMinor: '30',
        netBankMinor: '1970',
      });
      expect(res.statusCode).toBe(428);
    });

    it('stale version rejected', async () => {
      const owner = await mintTenant('e-owner2', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req(
        'PATCH',
        `${baseUrl()}/${id}`,
        owner,
        { grossSettlementMinor: '2000', providerFeeMinor: '30', netBankMinor: '1970' },
        { 'if-match': '99' },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SETTLEMENT_VERSION_CONFLICT');
    });

    it('successful edit increments version exactly once', async () => {
      const owner = await mintTenant('e-owner3', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req(
        'PATCH',
        `${baseUrl()}/${id}`,
        owner,
        { grossSettlementMinor: '2000', providerFeeMinor: '30', netBankMinor: '1970' },
        { 'if-match': '1' },
      );
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().version).toBe(2);
      expect(res.json().grossSettlementMinor).toBe('2000');
    });
  });

  // ═══════════════════════ manual line add (item 24) ════════════════════════
  describe('manual line add', () => {
    it('line add succeeds on DRAFT, server derives currency/scope/lineKind, increments version once', async () => {
      const owner = await mintTenant('l-owner', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '500' },
        { 'if-match': '1' },
      );
      expect(res.statusCode, res.payload).toBe(201);
      expect(res.json().line.currencyCode).toBe('AED');
      expect(res.json().line.lineKind).toBe('SETTLEMENT');
      expect(res.json().batch.version).toBe(2);
    });

    it('positive amount only', async () => {
      const owner = await mintTenant('l-owner2', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '0' },
        { 'if-match': '1' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('same externalLineId same batch rejected; different batch allowed', async () => {
      const owner = await mintTenant('l-owner3', tenantA, rolePerms('owner'));
      const b1 = (await createBatch(owner)).json().id;
      const b2 = (await createBatch(owner)).json().id;
      const line = extId();
      const first = await req(
        'POST',
        `${baseUrl()}/${b1}/lines`,
        owner,
        { externalLineId: line, amountMinor: '500' },
        { 'if-match': '1' },
      );
      expect(first.statusCode, first.payload).toBe(201);
      const dup = await req(
        'POST',
        `${baseUrl()}/${b1}/lines`,
        owner,
        { externalLineId: line, amountMinor: '500' },
        { 'if-match': '2' },
      );
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('SETTLEMENT_EXTERNAL_LINE_ID_CONFLICT');
      const otherBatch = await req(
        'POST',
        `${baseUrl()}/${b2}/lines`,
        owner,
        { externalLineId: line, amountMinor: '500' },
        { 'if-match': '1' },
      );
      expect(otherBatch.statusCode, otherBatch.payload).toBe(201);
    });

    it('stale expectedVersion rejected', async () => {
      const owner = await mintTenant('l-owner4', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '500' },
        { 'if-match': '99' },
      );
      expect(res.statusCode).toBe(409);
    });

    it("finalized batch rejects line add (structurally — no finalize route exists in Checkpoint C, so this proves against a raw-SQL-finalized batch, exactly mirroring Checkpoint B's own frozen finalize sequence)", async () => {
      const owner = await mintTenant('l-owner5', tenantA, rolePerms('owner'));
      const created = await createBatch(owner, {
        grossSettlementMinor: '1000',
        providerFeeMinor: '0',
        netBankMinor: '1000',
      });
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const payment = await insertProviderPayment(credA, branchA, 1000);
      await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );

      // build + finalize exactly like Checkpoint B's own frozen sequence:
      // Application + sealed journal inserted while DRAFT, then ONE atomic
      // DRAFT->FINALIZED transition as the last statement of the transaction.
      const client = new pg.Client({ connectionString: stack.postgres.url });
      await client.connect();
      try {
        await client.query('BEGIN');
        const bankAcct = await client.query(
          `SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.BANK'`,
          [coA],
        );
        const feeAcct = await client.query(
          `SELECT id FROM account WHERE "companyId"=$1 AND key='EXPENSE.PAYMENT_PROCESSING_FEE'`,
          [coA],
        );
        const clearingAcct = await client.query(
          `SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.PAYMENT_CLEARING'`,
          [coA],
        );
        const period = await client.query(
          `SELECT id FROM accounting_period WHERE "companyId"=$1 LIMIT 1`,
          [coA],
        );
        const jeRows = await client.query(
          `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
           VALUES (uuidv7(),$1,$2,$3,'2026-06-01','SETTLEMENT_BATCH',$4,'AED','fp') RETURNING id`,
          [tenantA, coA, period.rows[0].id, id],
        );
        const je = jeRows.rows[0].id;
        await client.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,1000,0)`,
          [tenantA, coA, je, bankAcct.rows[0].id, branchA],
        );
        await client.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,0,1000)`,
          [tenantA, coA, je, clearingAcct.rows[0].id, branchA],
        );
        void feeAcct;
        await client.query(`UPDATE journal_entry SET "sealedAt"=now() WHERE id=$1`, [je]);
        await client.query(
          `INSERT INTO settlement_application (id,"tenantId","companyId","branchId","batchId","lineId","paymentId","amountMinor","currencyCode","currencyExponent")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,1000,'AED',2)`,
          [tenantA, coA, branchA, id, lineId, payment],
        );
        await client.query(
          `UPDATE settlement_batch SET state='FINALIZED', "journalEntryId"=$1, "finalizedAt"=now(), version=version+1 WHERE id=$2 AND state='DRAFT' AND version=3`,
          [je, id],
        );
        await client.query('COMMIT');
      } finally {
        await client.end();
      }

      const stateRow = await sql<{ state: string }>(
        `SELECT state FROM settlement_batch WHERE id=$1`,
        [id],
      );
      expect(stateRow[0]!.state).toBe('FINALIZED');

      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '500' },
        { 'if-match': '3' },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SETTLEMENT_ALREADY_FINALIZED');
    });
  });

  // ═══════════════════════ CSV import (item 25) ═════════════════════════════
  describe('CSV import', () => {
    const csv = (rows: string[]): string =>
      ['externalLineId,providerReference,amountMinor', ...rows].join('\n');

    it('valid normalized CSV imports atomically; one Batch version increment for multiple rows', async () => {
      const owner = await mintTenant('csv-owner', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const content = csv([',,100', ',,200', ',,300']);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: content },
        { 'if-match': '1', 'idempotency-key': ik() },
      );
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().insertedCount).toBe(3);
      expect(res.json().batch.version).toBe(2);
    });

    it('duplicate externalLineId inside the CSV rejected; zero rows committed', async () => {
      const owner = await mintTenant('csv-owner2', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const content = csv([`L1,,100`, `L1,,200`]);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: content },
        { 'if-match': '1', 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(422);
      const lines = await sql(`SELECT id FROM settlement_line WHERE "batchId"=$1`, [id]);
      expect(lines).toHaveLength(0);
    });

    it('duplicate PERSISTED externalLineId rejected', async () => {
      const owner = await mintTenant('csv-owner3', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { externalLineId: 'L1', amountMinor: '500' },
        { 'if-match': '1' },
      );
      const content = csv(['L1,,100']);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: content },
        { 'if-match': '2', 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(409);
    });

    it('malformed amount rejected; zero/negative rejected; malformed header rejected', async () => {
      const owner = await mintTenant('csv-owner4', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      for (const content of [
        csv([',,abc']),
        csv([',,0']),
        csv([',,-5']),
        'wrong,header,shape\n,,100',
      ]) {
        const res = await req(
          'POST',
          `${baseUrl()}/${id}/lines/import`,
          owner,
          { csvContent: content },
          { 'if-match': '1', 'idempotency-key': ik() },
        );
        expect(res.statusCode, content).toBe(422);
      }
    });

    it('same Idempotency-Key + same normalized content -> safe replay (no double-import)', async () => {
      const owner = await mintTenant('csv-owner5', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const content = csv([',,100']);
      const key = ik();
      const first = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: content },
        { 'if-match': '1', 'idempotency-key': key },
      );
      expect(first.statusCode, first.payload).toBe(200);
      const replay = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: content },
        { 'if-match': '1', 'idempotency-key': key },
      );
      expect(replay.statusCode).toBe(200);
      const lines = await sql(`SELECT id FROM settlement_line WHERE "batchId"=$1`, [id]);
      expect(lines).toHaveLength(1);
    });

    it('same key + changed content -> conflict', async () => {
      const owner = await mintTenant('csv-owner6', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const key = ik();
      const first = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: csv([',,100']) },
        { 'if-match': '1', 'idempotency-key': key },
      );
      expect(first.statusCode, first.payload).toBe(200);
      const conflict = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: csv([',,999']) },
        { 'if-match': '1', 'idempotency-key': key },
      );
      expect(conflict.statusCode).toBe(409);
    });

    it('stale Batch version -> conflict', async () => {
      const owner = await mintTenant('csv-owner7', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/import`,
        owner,
        { csvContent: csv([',,100']) },
        { 'if-match': '99', 'idempotency-key': ik() },
      );
      expect(res.statusCode).toBe(409);
    });
  });

  // ═══════════════════════ matching (item 26) ═══════════════════════════════
  describe('matching', () => {
    it('providerReference resolves the correct Payment (auto-match on line add)', async () => {
      const owner = await mintTenant('m-owner', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const ref = `ref-${extId()}`;
      const payment = await insertProviderPayment(credA, branchA, 1000, ref);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { providerReference: ref, amountMinor: '1000' },
        { 'if-match': '1' },
      );
      expect(res.statusCode, res.payload).toBe(201);
      expect(res.json().line.matchedPaymentId).toBe(payment);
    });

    it('wrong branch payment does NOT auto-match (stays unmatched)', async () => {
      const owner = await mintTenant('m-owner2', tenantA, rolePerms('owner'));
      const created = await createBatch(owner); // scoped to branchA / credA
      const id = created.json().id;
      const ref = `ref-${extId()}`;
      await insertProviderPayment(credA2, branchA2, 1000, ref); // different branch/credential
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { providerReference: ref, amountMinor: '1000' },
        { 'if-match': '1' },
      );
      expect(res.statusCode, res.payload).toBe(201);
      expect(res.json().line.matchedPaymentId).toBeNull();
    });

    it('explicit match: eligible ONLINE_GATEWAY payment matches; caller cannot force an ineligible Payment', async () => {
      const owner = await mintTenant('m-owner3', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const eligible = await insertProviderPayment(credA, branchA, 1000);
      const match = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: eligible },
        { 'if-match': '2' },
      );
      expect(match.statusCode, match.payload).toBe(200);
      expect(match.json().line.matchedPaymentId).toBe(eligible);

      // a wrong-branch payment must be rejected even when explicitly proposed
      const lineRes2 = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '500' },
        { 'if-match': '3' },
      );
      const lineId2 = lineRes2.json().line.id;
      const ineligible = await insertProviderPayment(credA2, branchA2, 500);
      const badMatch = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId2}/match`,
        owner,
        { paymentId: ineligible },
        { 'if-match': '4' },
      );
      expect(badMatch.statusCode).toBe(422);
      expect(badMatch.json().error.code).toBe('SETTLEMENT_PAYMENT_NOT_ELIGIBLE');
    });

    // ── negative eligibility predicates (Checkpoint C final verification
    // gate item 6) — each proves ONE frozen predicate in isolation, reusing
    // the SAME assertPaymentEligible authority the auto-match path also
    // calls (settlement-matching.repository.ts). ──────────────────────────
    async function freshUnmatchedLine(
      owner: string,
      batchId: string,
      expectedVersion: number,
      amountMinor = '500',
    ): Promise<string> {
      const res = await req(
        'POST',
        `${baseUrl()}/${batchId}/lines`,
        owner,
        { amountMinor },
        { 'if-match': String(expectedVersion) },
      );
      return res.json().line.id;
    }

    it('CASH payment does NOT match', async () => {
      const owner = await mintTenant('m-owner4', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineId = await freshUnmatchedLine(owner, id, 1);
      const cashPayment = await insertNonProviderPayment('CASH', branchA, 500);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: cashPayment },
        { 'if-match': '2' },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_PAYMENT_NOT_ELIGIBLE');
    });

    it('BANK_TRANSFER payment does NOT match', async () => {
      const owner = await mintTenant('m-owner-bt', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineId = await freshUnmatchedLine(owner, id, 1);
      const payment = await insertNonProviderPayment('BANK_TRANSFER', branchA, 500);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_PAYMENT_NOT_ELIGIBLE');
    });

    it('OTHER_MANUAL payment does NOT match', async () => {
      const owner = await mintTenant('m-owner-om', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineId = await freshUnmatchedLine(owner, id, 1);
      const payment = await insertNonProviderPayment('OTHER_MANUAL', branchA, 500);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_PAYMENT_NOT_ELIGIBLE');
    });

    it('wrong-COMPANY payment does NOT match (distinct from wrong-branch)', async () => {
      const owner = await mintTenant('m-owner-wc', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineId = await freshUnmatchedLine(owner, id, 1, '1000');
      const otherCo = await sqlOne(
        `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
         VALUES (uuidv7(),$1,'Wrong Co','AED','Asia/Dubai',now()) RETURNING id`,
        [tenantA],
      );
      const otherBranch = await sqlOne(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES (uuidv7(),$1,$2,'Wrong Branch',now()) RETURNING id`,
        [tenantA, otherCo],
      );
      const otherCred = await sqlOne(
        `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
        [tenantA, otherCo, otherBranch],
      );
      const payment = await insertProviderPayment(
        otherCred,
        otherBranch,
        1000,
        undefined,
        'ONLINE_GATEWAY',
        'tap',
        'AED',
        2,
        otherCo,
      );
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_PAYMENT_NOT_ELIGIBLE');
    });

    // NOTE — a "wrong currency" case is deliberately NOT tested here: a
    // Payment's own `currencyCode` is DB-FK-bound to ITS company's
    // `defaultCurrency` (`payment_attempt_currency_company_fkey`), and a
    // settlement Batch's currency is likewise forced to equal its OWN
    // company's `defaultCurrency` (Checkpoint C's own create-time
    // validation). Since both are derived from the SAME single-currency-
    // per-company invariant, a real Payment can never actually diverge in
    // currency from a real Batch under the same company — attempting to
    // construct one via raw SQL fails the FK before the settlement layer is
    // ever reached (confirmed empirically). The currency-equality check
    // inside `assertPaymentEligible` is retained as defense-in-depth for a
    // schema that may one day allow multi-currency, but it is currently
    // structurally unreachable — this is reported explicitly rather than
    // faked with an artificial test.

    it('same providerKey under a DIFFERENT credential (same branch) does NOT match', async () => {
      const owner = await mintTenant('m-owner-cred', tenantA, rolePerms('owner'));
      const altCred = await sqlOne(
        `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,'tap','TEST','\\x00','\\x00','\\x00',now()) RETURNING id`,
        [tenantA, coA, branchA],
      );
      const created = await createBatch(owner, { providerCredentialId: credA });
      const id = created.json().id;
      const lineId = await freshUnmatchedLine(owner, id, 1, '1000');
      // funded under altCred (SAME branch/company, SAME providerKey 'tap', DIFFERENT credential id)
      const payment = await insertProviderPayment(altCred, branchA, 1000);
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('SETTLEMENT_PAYMENT_NOT_ELIGIBLE');
    });

    // ── CARD_TERMINAL positive matching (final verification gate item 5) ──
    it('eligible credential-backed CARD_TERMINAL payment matches via explicit match', async () => {
      const owner = await mintTenant('m-owner-ct', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineId = await freshUnmatchedLine(owner, id, 1, '1000');
      const payment = await insertProviderPayment(credA, branchA, 1000, undefined, 'CARD_TERMINAL');
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().line.matchedPaymentId).toBe(payment);
    });

    it('eligible credential-backed CARD_TERMINAL payment auto-matches via providerReference on line add (same shared model as ONLINE_GATEWAY)', async () => {
      const owner = await mintTenant('m-owner-ct2', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const ref = `ref-ct-${extId()}`;
      const payment = await insertProviderPayment(credA, branchA, 1000, ref, 'CARD_TERMINAL');
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { providerReference: ref, amountMinor: '1000' },
        { 'if-match': '1' },
      );
      expect(res.statusCode, res.payload).toBe(201);
      expect(res.json().line.matchedPaymentId).toBe(payment);
    });

    it('match increments Batch.version once; same-match is an idempotent no-op (no second bump)', async () => {
      const owner = await mintTenant('m-owner5', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const payment = await insertProviderPayment(credA, branchA, 1000);
      const match1 = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );
      expect(match1.json().batch.version).toBe(3);
      const match2 = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '3' },
      );
      expect(match2.statusCode, match2.payload).toBe(200);
      expect(match2.json().batch.version).toBe(3); // unchanged — idempotent no-op
    });

    it('matching a DIFFERENT payment without unmatching first -> SETTLEMENT_LINE_ALREADY_MATCHED', async () => {
      const owner = await mintTenant('m-owner6', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const paymentA = await insertProviderPayment(credA, branchA, 1000);
      const paymentB = await insertProviderPayment(credA, branchA, 1000);
      await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: paymentA },
        { 'if-match': '2' },
      );
      const res = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: paymentB },
        { 'if-match': '3' },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SETTLEMENT_LINE_ALREADY_MATCHED');
    });

    it('unmatch works; repeated unmatch is an idempotent no-op', async () => {
      const owner = await mintTenant('m-owner7', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const payment = await insertProviderPayment(credA, branchA, 1000);
      await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: payment },
        { 'if-match': '2' },
      );
      const unmatch1 = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/unmatch`,
        owner,
        {},
        { 'if-match': '3' },
      );
      expect(unmatch1.statusCode, unmatch1.payload).toBe(200);
      expect(unmatch1.json().line.matchedPaymentId).toBeNull();
      expect(unmatch1.json().batch.version).toBe(4);
      const unmatch2 = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/unmatch`,
        owner,
        {},
        { 'if-match': '4' },
      );
      expect(unmatch2.statusCode, unmatch2.payload).toBe(200);
      expect(unmatch2.json().batch.version).toBe(4); // unchanged — idempotent no-op
    });
  });

  // ═══════════════════════ concurrency (item 27) ════════════════════════════
  describe('concurrency', () => {
    it('manual line add vs match at the same Batch version — exactly one wins, no lost update', async () => {
      const owner = await mintTenant('conc-owner', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const payment = await insertProviderPayment(credA, branchA, 1000);

      const [addRes, matchRes] = await Promise.all([
        req('POST', `${baseUrl()}/${id}/lines`, owner, { amountMinor: '1' }, { 'if-match': '2' }),
        req(
          'POST',
          `${baseUrl()}/${id}/lines/${lineId}/match`,
          owner,
          { paymentId: payment },
          { 'if-match': '2' },
        ),
      ]);
      const outcomes = [addRes.statusCode, matchRes.statusCode];
      const succeeded = outcomes.filter((s) => s === 200 || s === 201);
      const conflicted = outcomes.filter((s) => s === 409);
      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      // batch was at version 2 (after the first line-add) when both
      // concurrent requests read/proposed expectedVersion=2; exactly ONE of
      // them wins the FOR UPDATE lock and bumps to 3 — never both, never a
      // lost update.
      const batch = await sql<{ version: number }>(
        `SELECT version FROM settlement_batch WHERE id=$1`,
        [id],
      );
      expect(batch[0]!.version).toBe(3);
    });

    it('B. CSV import vs manual line add at the same Batch version — exactly one wins atomically, no partial CSV rows, version becomes N+1 never N+2', async () => {
      const owner = await mintTenant('conc-owner-b', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const N = created.json().version; // 1
      const csvContent = [
        'externalLineId,providerReference,amountMinor',
        ',,100',
        ',,200',
        ',,300',
      ].join('\n');

      const [csvRes, addRes] = await Promise.all([
        req(
          'POST',
          `${baseUrl()}/${id}/lines/import`,
          owner,
          { csvContent },
          { 'if-match': String(N), 'idempotency-key': ik() },
        ),
        req(
          'POST',
          `${baseUrl()}/${id}/lines`,
          owner,
          { amountMinor: '1' },
          { 'if-match': String(N) },
        ),
      ]);
      const outcomes = [csvRes.statusCode, addRes.statusCode];
      expect(outcomes.filter((s) => s === 200 || s === 201)).toHaveLength(1);
      expect(outcomes.filter((s) => s === 409)).toHaveLength(1);

      const lines = await sql<{ amountMinor: string }>(
        `SELECT "amountMinor" FROM settlement_line WHERE "batchId"=$1`,
        [id],
      );
      const batch = await sql<{ version: number }>(
        `SELECT version FROM settlement_batch WHERE id=$1`,
        [id],
      );
      expect(batch[0]!.version).toBe(N + 1);
      if (csvRes.statusCode === 200) {
        // CSV won: all 3 rows committed atomically, the manual add contributed nothing.
        expect(lines).toHaveLength(3);
      } else {
        // manual add won: exactly its 1 row committed, CSV committed ZERO rows.
        expect(lines).toHaveLength(1);
        expect(addRes.statusCode).toBe(201);
      }
    });

    it('C. match vs unmatch at the same Batch version (line starts matched) — exactly one version transition, no lost update', async () => {
      const owner = await mintTenant('conc-owner-c', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const paymentX = await insertProviderPayment(credA, branchA, 1000);
      const paymentY = await insertProviderPayment(credA, branchA, 1000);
      const afterMatch = await req(
        'POST',
        `${baseUrl()}/${id}/lines/${lineId}/match`,
        owner,
        { paymentId: paymentX },
        { 'if-match': '2' },
      );
      const N = afterMatch.json().batch.version; // 3, line now matched to paymentX

      const [unmatchRes, matchYRes] = await Promise.all([
        req(
          'POST',
          `${baseUrl()}/${id}/lines/${lineId}/unmatch`,
          owner,
          {},
          { 'if-match': String(N) },
        ),
        req(
          'POST',
          `${baseUrl()}/${id}/lines/${lineId}/match`,
          owner,
          { paymentId: paymentY },
          { 'if-match': String(N) },
        ),
      ]);
      // matching a DIFFERENT payment (Y) while still matched to X can never
      // itself succeed (SETTLEMENT_LINE_ALREADY_MATCHED, the frozen
      // deterministic state-specific error) — so `unmatch` is the only
      // operation that can ever actually commit here, whichever order the
      // two requests are served in. Exactly one 200, exactly one 409 either
      // way — never both succeeding, never a lost update.
      const outcomes = [unmatchRes.statusCode, matchYRes.statusCode];
      expect(outcomes.filter((s) => s === 200)).toHaveLength(1);
      expect(outcomes.filter((s) => s === 409)).toHaveLength(1);
      expect(unmatchRes.statusCode).toBe(200); // unmatch always eventually wins in this setup
      expect(matchYRes.statusCode).toBe(409);
      expect(['SETTLEMENT_LINE_ALREADY_MATCHED', 'SETTLEMENT_VERSION_CONFLICT']).toContain(
        matchYRes.json().error.code,
      );

      const line = await sql<{ matchedPaymentId: string | null }>(
        `SELECT "matchedPaymentId" FROM settlement_line WHERE id=$1`,
        [lineId],
      );
      expect(line[0]!.matchedPaymentId).toBeNull();
      const batch = await sql<{ version: number }>(
        `SELECT version FROM settlement_batch WHERE id=$1`,
        [id],
      );
      expect(batch[0]!.version).toBe(N + 1);
    });

    it('D. two concurrent matches (Payment A vs Payment B) on the same unmatched Line — exactly one wins, no last-writer-wins overwrite', async () => {
      const owner = await mintTenant('conc-owner-d', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const lineRes = await req(
        'POST',
        `${baseUrl()}/${id}/lines`,
        owner,
        { amountMinor: '1000' },
        { 'if-match': '1' },
      );
      const lineId = lineRes.json().line.id;
      const N = lineRes.json().batch.version; // 2
      const paymentA = await insertProviderPayment(credA, branchA, 1000);
      const paymentB = await insertProviderPayment(credA, branchA, 1000);

      const [matchARes, matchBRes] = await Promise.all([
        req(
          'POST',
          `${baseUrl()}/${id}/lines/${lineId}/match`,
          owner,
          { paymentId: paymentA },
          { 'if-match': String(N) },
        ),
        req(
          'POST',
          `${baseUrl()}/${id}/lines/${lineId}/match`,
          owner,
          { paymentId: paymentB },
          { 'if-match': String(N) },
        ),
      ]);
      const outcomes = [matchARes.statusCode, matchBRes.statusCode];
      expect(outcomes.filter((s) => s === 200)).toHaveLength(1);
      expect(outcomes.filter((s) => s === 409)).toHaveLength(1);
      // the loser is rejected by the version check itself (it never even
      // reaches the "already matched" check), so it is deterministically
      // SETTLEMENT_VERSION_CONFLICT, every time, in either interleaving.
      const loser = matchARes.statusCode === 409 ? matchARes : matchBRes;
      expect(loser.json().error.code).toBe('SETTLEMENT_VERSION_CONFLICT');

      const winnerPaymentId = matchARes.statusCode === 200 ? paymentA : paymentB;
      const line = await sql<{ matchedPaymentId: string }>(
        `SELECT "matchedPaymentId" FROM settlement_line WHERE id=$1`,
        [lineId],
      );
      expect(line[0]!.matchedPaymentId).toBe(winnerPaymentId); // never overwritten by the loser
      const batch = await sql<{ version: number }>(
        `SELECT version FROM settlement_batch WHERE id=$1`,
        [id],
      );
      expect(batch[0]!.version).toBe(N + 1);
    });
  });

  // ═══════════════════════ cross-tenant / cross-branch (item 28) ════════════
  describe('cross-tenant / cross-branch isolation', () => {
    it('cross-tenant detail is invisible (404)', async () => {
      const owner = await mintTenant('x-owner', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const otherTenantOwner = await mintTenant('x-owner-b', tenantB, rolePerms('owner'));
      const res = await req('GET', `${baseUrl()}/${id}`, otherTenantOwner);
      expect(res.statusCode).toBe(404);
    });

    it('detail never exposes provider_credential secret fields', async () => {
      const owner = await mintTenant('x-owner2', tenantA, rolePerms('owner'));
      const created = await createBatch(owner);
      const id = created.json().id;
      const res = await req('GET', `${baseUrl()}/${id}`, owner);
      expect(res.statusCode, res.payload).toBe(200);
      const text = res.payload;
      expect(text).not.toMatch(/secretCiphertext|secretNonce|dekWrapped/i);
    });

    it('list is scoped to the requested branch only', async () => {
      const owner = await mintTenant('x-owner3', tenantA, rolePerms('owner'));
      await createBatch(owner, { branchId: branchA });
      await createBatch(owner, { providerCredentialId: credA2, branchId: branchA2 });
      const res = await req('GET', baseUrl(branchA), owner);
      expect(res.statusCode, res.payload).toBe(200);
      for (const item of res.json().items) {
        expect(item.branchId).toBe(branchA);
      }
    });
  });
});
