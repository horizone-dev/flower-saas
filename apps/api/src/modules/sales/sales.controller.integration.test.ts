import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test of the PUBLIC HTTP surface of the atomic sale — not production code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import { installRequestContext } from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { SystemClock, type Clock } from '../../common/clock/clock.js';
import { DbService } from '../../common/data/index.js';
import { SYSTEM_ROLE_TEMPLATES } from '../platform/system-roles.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import type { CommercialSnapshotLine } from '../orders/commercial-snapshot.js';
import { TaxFinalizationService } from '../orders/tax-finalization.service.js';
import { PaymentCollectionRepository } from '../payments/payment-collection.repository.js';
import { CustomerAdvanceApplicationRepository } from '../receivables/customer-advance-application.repository.js';
import { PaymentAdvanceConversionRepository } from '../receivables/payment-advance-conversion.repository.js';
import { AtomicWalkInSaleService } from './atomic-walk-in-sale.service.js';
import { SalesApplicationService } from './sales-application.service.js';
import { WalkInSaleJournalRepository } from './walk-in-sale-journal.repository.js';

/**
 * Task 3b.9 Checkpoint E — the PUBLIC surface of the atomic sale, over the REAL HTTP stack:
 * the full `AppModule` (global guards, the shared idempotency interceptor, the exception
 * filter), real sessions with the REAL default role grants (`SYSTEM_ROLE_TEMPLATES`), the real
 * idempotency store, real Redis and real PostgreSQL. The financial behaviour itself is proven
 * by the frozen A–D suites; this file proves the surface in front of it: DTO strictness,
 * `If-Match`, public idempotency / replay, conditional authority, scope isolation, the sale
 * event, the totals preview and the order recovery read.
 */
const FIXED_INSTANT = new Date('2026-06-15T10:00:00.000Z');
const TOTAL = 10_500n; // 10 000 + 5 % tax

describe('SalesController — complete-sale / totals / order recovery read (task 3b.9 Checkpoint E, HTTP integration)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let pool: pg.Pool;
  let db: DbService;
  let prisma: PrismaClient;

  // the real provider instances the HTTP stack uses — spied on to prove what a replay does NOT touch
  let sales: SalesApplicationService;
  let atomic: AtomicWalkInSaleService;
  let walkInJournal: WalkInSaleJournalRepository;
  let engine: PostingEngineService;
  let collection: PaymentCollectionRepository;
  let finalization: TaxFinalizationService;
  let advanceApplication: CustomerAdvanceApplicationRepository;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let conversion: PaymentAdvanceConversionRepository;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  let productId = '';
  let variantId = '';

  interface Co {
    companyId: string;
    branchId: string;
    siblingBranchId: string;
    currency: 'AED' | 'KWD';
    exponent: number;
    periodId: string;
    periodVersion: number;
  }
  interface Cust {
    customerId: string;
    ccaId: string;
    co: Co;
  }
  let aed: Co;
  let aed2: Co;
  let kwd: Co;

  const fakeClock: Clock = { now: () => FIXED_INSTANT };

  const asTenant = <T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> =>
    runScoped(prisma, { tenantId }, fn);
  const q = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

  // ── sessions (real role grants) ─────────────────────────────────────────────
  function baseSess(sessionId: string): SessionData {
    return {
      sessionId,
      realm: 'tenant',
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
  const userIds = new Map<string, string>();
  async function mint(
    id: string,
    perms: readonly string[],
    opts: {
      tenant?: string;
      branchScope?: string[] | 'ALL';
      /** per-branch overlay: branchId → the ONLY keys allowed in that branch */
      overlay?: Record<string, string[]>;
      companyScope?: string[] | 'ALL';
      stepUp?: boolean;
      posTerminalId?: string | null;
    } = {},
  ): Promise<string> {
    const s = baseSess(`e-${id}`);
    const forTenant = opts.tenant ?? tenantId;
    s.tenantId = forTenant;
    let uid = userIds.get(id);
    if (uid === undefined) {
      uid = randomUUID();
      userIds.set(id, uid);
    }
    s.userId = uid;
    s.accountType = 'OWNER';
    s.posTerminalId = opts.posTerminalId ?? null;
    if (opts.stepUp) {
      s.mfaLevel = 'STEP_UP';
      s.stepUpUntil = Date.now() + 600_000;
    }
    s.access = {
      effectivePermissions: [...perms],
      companyScope: opts.companyScope ?? 'ALL',
      branchScope: opts.branchScope ?? 'ALL',
      perBranchOverlay: opts.overlay ?? {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: uid, sid: s.sessionId, aud: 'tenant', tid: forTenant });
  }
  const rolePerms = (key: string): string[] => {
    const role = SYSTEM_ROLE_TEMPLATES.find((r) => r.key === key);
    if (!role) throw new Error(`no system role ${key}`);
    return [...role.permissions];
  };
  const tok: Record<string, string> = {};

  // ── fixtures ────────────────────────────────────────────────────────────────
  async function makeCompany(
    tid: string,
    o: { currency: 'AED' | 'KWD'; tz?: string },
  ): Promise<Co> {
    const co = {
      companyId: randomUUID(),
      branchId: randomUUID(),
      siblingBranchId: randomUUID(),
      currency: o.currency,
      exponent: o.currency === 'KWD' ? 3 : 2,
    };
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Sale Co','AE',$3,$4,'ACTIVE',now())`,
      [co.companyId, tid, o.currency, o.tz ?? 'Asia/Dubai'],
    );
    for (const [id, name] of [
      [co.branchId, 'Main'],
      [co.siblingBranchId, 'Sibling'],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [id, tid, co.companyId, name],
      );
    }
    await asTenant((tx) =>
      accounts.ensureDefaultAccounts(tx, { tenantId: tid, companyId: co.companyId }),
    );
    const period = await asTenant((tx) =>
      periods.create(tx, {
        tenantId: tid,
        companyId: co.companyId,
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2026-06-30T00:00:00Z'),
      }),
    );
    return { ...co, periodId: period.id, periodVersion: period.version };
  }

  type Credit = { enabled: false } | { enabled: true; limit: bigint | null };
  async function mkCustomer(
    co: Co,
    credit: Credit = { enabled: true, limit: null },
  ): Promise<Cust> {
    const customerId = randomUUID();
    const ccaId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Customer',now())`,
      [customerId, tenantId],
    );
    const limited = credit.enabled && credit.limit !== null;
    await pool.query(
      `INSERT INTO customer_company_account
         (id,"tenantId","companyId","customerId","creditEnabled","creditLimitMinor","creditLimitCurrencyCode","creditLimitCurrencyExponent","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [
        ccaId,
        tenantId,
        co.companyId,
        customerId,
        credit.enabled,
        limited ? (credit as { limit: bigint }).limit.toString() : null,
        limited ? co.currency : null,
        limited ? co.exponent : null,
      ],
    );
    return { customerId, ccaId, co };
  }

  /** a customer whose ONLY company account is at `elsewhere` (none at the order's company) */
  async function mkCustomerElsewhere(elsewhere: Co): Promise<string> {
    return (await mkCustomer(elsewhere)).customerId;
  }

  async function mkAdvance(
    c: Cust,
    amountMinor: bigint,
    branchId: string = c.co.branchId,
  ): Promise<string> {
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,$7,$8,'CAPTURED',$9, now())`,
      [
        attemptId,
        tenantId,
        c.co.companyId,
        branchId,
        c.ccaId,
        amountMinor.toString(),
        c.co.currency,
        c.co.exponent,
        `idem-${attemptId}`,
      ],
    );
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,$7,$8)`,
      [
        paymentId,
        tenantId,
        c.co.companyId,
        branchId,
        attemptId,
        amountMinor.toString(),
        c.co.currency,
        c.co.exponent,
      ],
    );
    const converted = await asTenant((tx) =>
      conversion.convertInTx(tx, {
        tenantId,
        companyId: c.co.companyId,
        branchId,
        customerId: c.customerId,
        paymentId,
        amountMinor,
        actorUserId: null,
      }),
    );
    return converted.advanceId;
  }

  interface LineSpec {
    quantity: string;
    unitPriceAmountMinor: bigint;
    discountAmountMinor?: bigint;
    rateBps: number | null;
  }
  interface OrderSpec {
    lines: LineSpec[];
    taxPriceMode?: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
  }
  interface MadeOrder {
    orderId: string;
    co: Co;
    branchId: string;
    customerId: string | null;
    version: number;
  }
  const one = (priceMinor: bigint, rateBps: number | null = 500): OrderSpec => ({
    lines: [{ quantity: '1.0000', unitPriceAmountMinor: priceMinor, rateBps }],
  });

  function snapshotLine(spec: LineSpec, co: Co): CommercialSnapshotLine {
    const amount = spec.discountAmountMinor ?? 0n;
    return {
      productId,
      variantId,
      quantity: spec.quantity,
      selectedUomCode: 'piece',
      baseUomCode: 'piece',
      conversionNumerator: '1',
      conversionDenominator: '1',
      unitPriceAmountMinor: spec.unitPriceAmountMinor.toString(),
      unitPriceCurrencyCode: co.currency,
      unitPriceCurrencyExponent: co.exponent,
      discountMode: amount > 0n ? 'AMOUNT' : 'NONE',
      discountBps: null,
      discountAmountMinor: amount.toString(),
      taxCategoryKey: spec.rateBps === null ? null : 'STANDARD',
      rateBps: spec.rateBps,
      effectiveFrom: spec.rateBps === null ? null : '2020-01-01',
      resolutionSource: spec.rateBps === null ? 'NONE' : 'VARIANT',
    };
  }

  /** one DRAFT order (customer-linked unless `customerId` is null), with a REAL frozen fingerprint */
  async function mkOrder(
    co: Co,
    customerId: string | null,
    spec: OrderSpec,
    branchId: string = co.branchId,
  ): Promise<MadeOrder> {
    const taxPriceMode = spec.taxPriceMode ?? 'TAX_EXCLUSIVE';
    const fingerprint = computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId: co.companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId,
        kind: 'WALK_IN',
        currencyCode: co.currency,
        lines: spec.lines.map((l) => snapshotLine(l, co)),
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      },
      { taxPriceMode, taxRoundingScope: 'LINE', taxRoundingMode: 'HALF_UP' },
    );
    const orderId = randomUUID();
    await pool.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountAmountMinor",
          "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT',$6,$7,'NONE',0,$8,2,$9,'LINE','HALF_UP',now())`,
      [
        orderId,
        tenantId,
        co.companyId,
        branchId,
        customerId,
        co.currency,
        co.exponent,
        fingerprint,
        taxPriceMode,
      ],
    );
    for (const [i, l] of spec.lines.entries()) {
      const amount = l.discountAmountMinor ?? 0n;
      await pool.query(
        `INSERT INTO order_line
           (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
            "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
            "discountMode","discountBps","discountAmountMinor",
            "taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
            "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
            "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot",
            "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15,
                 CASE WHEN $15::int IS NULL THEN NULL ELSE '2020-01-01'::date END,$16,
                 'piece','Piece','piece',1,1,'Rose','Rose',now())`,
        [
          randomUUID(),
          tenantId,
          co.companyId,
          orderId,
          i + 1,
          productId,
          variantId,
          l.quantity,
          l.unitPriceAmountMinor.toString(),
          co.currency,
          co.exponent,
          amount > 0n ? 'AMOUNT' : 'NONE',
          amount.toString(),
          l.rateBps === null ? null : 'STANDARD',
          l.rateBps,
          l.rateBps === null ? 'NONE' : 'VARIANT',
        ],
      );
    }
    return { orderId, co, branchId, customerId, version: 1 };
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────
  let keySeq = 0;
  const ik = (): string => `e-key-${String(++keySeq).padStart(5, '0')}-${randomUUID().slice(0, 8)}`;
  const orderUrl = (o: { co: Co; branchId: string; orderId: string }, tail = ''): string =>
    `/v1/companies/${o.co.companyId}/branches/${o.branchId}/orders/${o.orderId}${tail}`;

  interface CompleteOpts {
    /** `null` ⇒ no header */
    key?: string | null;
    /** `null` ⇒ no header; default = the order's version */
    ifMatch?: string | number | null;
    headers?: Record<string, string>;
    /** override the URL (isolation probes) */
    url?: string;
  }
  const complete = (token: string, o: MadeOrder, payload: unknown, opts: CompleteOpts = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const key = opts.key === undefined ? ik() : opts.key;
    if (key !== null) headers['idempotency-key'] = key;
    const ifMatch = opts.ifMatch === undefined ? o.version : opts.ifMatch;
    if (ifMatch !== null) headers['if-match'] = String(ifMatch);
    Object.assign(headers, opts.headers ?? {});
    return app.inject({
      method: 'POST',
      url: opts.url ?? orderUrl(o, '/complete-sale'),
      headers,
      payload: payload as Record<string, unknown>,
    });
  };
  const getJson = (token: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  const errCode = (r: { json: () => unknown }): string =>
    (r.json() as { error: { code: string } }).error.code;

  const cash = (n: bigint) => ({ method: 'CASH', amountMinor: n.toString() });
  const bank = (n: bigint) => ({ method: 'BANK_TRANSFER', amountMinor: n.toString() });
  const adv = (advanceId: string, n: bigint) => ({ advanceId, amountMinor: n.toString() });
  const body = (p: {
    intent?: 'PAY_NOW' | 'ON_CREDIT';
    tenders?: unknown[];
    advances?: unknown[];
    reason?: string;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> => ({
    paymentIntent: p.intent ?? 'PAY_NOW',
    ...(p.tenders !== undefined ? { tenders: p.tenders } : {}),
    ...(p.advances !== undefined ? { advanceApplications: p.advances } : {}),
    ...(p.reason !== undefined ? { creditLimitExceptionReason: p.reason } : {}),
    ...(p.extra ?? {}),
  });

  // ── observers ───────────────────────────────────────────────────────────────
  const EFFECT_TABLES = [
    'invoice',
    'payment_attempt',
    'payment_attempt_event',
    'payment',
    'payment_allocation',
    'journal_entry',
    'journal_line',
    'audit_log',
    'outbox',
    'customer_receivable',
    'customer_account_entry',
    'customer_advance',
    'customer_advance_application',
    'credit_note',
    'refund',
    'idempotency_key',
  ] as const;
  async function snapshot(): Promise<Record<string, number | string>> {
    const out: Record<string, number | string> = {};
    for (const t of EFFECT_TABLES) {
      out[t] = (
        await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" = $1`, [
          tenantId,
        ])
      )[0]!.n;
    }
    const agg = async (sql: string): Promise<string> =>
      String((await q<{ s: string | null }>(sql, [tenantId]))[0]!.s);
    out['orders'] = await agg(
      `SELECT string_agg(id::text || ':' || status || ':' || version::text || ':' || coalesce("orderNumber", ''), ',' ORDER BY id) AS s FROM "order" WHERE "tenantId" = $1`,
    );
    out['accounts'] = await agg(
      `SELECT string_agg(id::text || ':' || "currentOutstandingMinor"::text || '/' || "advanceBalanceMinor"::text, ',' ORDER BY id) AS s FROM customer_company_account WHERE "tenantId" = $1`,
    );
    out['counters'] = await agg(
      `SELECT string_agg("companyId"::text || ':' || "documentType" || ':' || "nextNumber"::text, ',' ORDER BY "companyId", "documentType") AS s FROM document_number_counter WHERE "tenantId" = $1`,
    );
    return out;
  }
  const invoiceOf = async (orderId: string) =>
    (
      await q<{
        id: string;
        invoiceNumber: string;
        total: string;
        tax: string;
        subtotal: string;
        status: string;
        date: string;
      }>(
        `SELECT id, "invoiceNumber", "totalAmountMinor"::text AS total, "taxTotalAmountMinor"::text AS tax,
                "subtotalAmountMinor"::text AS subtotal, "invoicePaymentStatus" AS status,
                "invoiceDate"::text AS date
           FROM invoice WHERE "orderId" = $1`,
        [orderId],
      )
    )[0] ?? null;
  const countWhere = async (sql: string, params: unknown[]): Promise<number> =>
    (await q<{ n: number }>(sql, params))[0]!.n;
  const saleEvents = (orderId: string) =>
    q<{
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      tenantId: string | null;
      companyId: string | null;
      branchId: string | null;
      rv: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT "eventType","aggregateType","aggregateId","tenantId","companyId","branchId",
              "resourceVersion"::text AS rv, payload
         FROM outbox WHERE "tenantId" = $1 AND "eventType" = 'orders.sale_completed' AND "aggregateId" = $2`,
      [tenantId, orderId],
    );
  async function orderState(orderId: string): Promise<{ status: string; version: number }> {
    return (
      await q<{ status: string; version: number }>(
        `SELECT status, version FROM "order" WHERE id = $1`,
        [orderId],
      )
    )[0]!;
  }

  /** a rejection leaves NO effect anywhere (and burns no number, and leaves no idempotency claim) */
  async function expectRejection(
    run: () => Promise<{ statusCode: number; json: () => unknown }>,
    status: number,
    code: string,
    o?: MadeOrder,
  ): Promise<void> {
    const before = await snapshot();
    const res = await run();
    expect(res.statusCode, JSON.stringify(res.json())).toBe(status);
    expect(errCode(res)).toBe(code);
    expect(await snapshot()).toEqual(before);
    if (o) expect(await invoiceOf(o.orderId)).toBeNull();
  }

  // ── spies on the REAL provider instances ────────────────────────────────────
  const spyAll = () => ({
    sale: vi.spyOn(sales, 'completeSale'),
    anon: vi.spyOn(atomic, 'completeAnonymousPayNowInTx'),
    cust: vi.spyOn(atomic, 'completeCustomerSaleInTx'),
    journal: vi.spyOn(walkInJournal, 'postWalkInSaleJournalInTx'),
    post: vi.spyOn(engine, 'postJournal'),
    capture: vi.spyOn(collection, 'captureSynchronousTendersInTx'),
    issue: vi.spyOn(finalization, 'issuePrepared'),
    apply: vi.spyOn(advanceApplication, 'applyInTx'),
  });
  const callCount = (s: ReturnType<typeof spyAll>): number =>
    Object.values(s).reduce((n, sp) => n + sp.mock.calls.length, 0);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── setup ───────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url, max: 6 });

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `esale-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [id, `esale-${id.slice(0, 8)}`, planVersionId],
      );
    }
    await pool.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr")
       VALUES ('AED',2,'AED','x','x'),('KWD',3,'KWD','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel",active,"updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN',true,now()) ON CONFLICT (code) DO NOTHING`,
    );
    const categoryId = randomUUID();
    productId = randomUUID();
    variantId = randomUUID();
    await pool.query(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'flowers','Flowers',now())`,
      [categoryId, tenantId],
    );
    await pool.query(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy",status,"updatedAt")
       VALUES ($1,$2,$3,'rose','Rose','STOCKED','ACTIVE',now())`,
      [productId, tenantId, categoryId],
    );
    await pool.query(
      `INSERT INTO variant (id,"tenantId","productId","nameEn",status,"baseUomCode","updatedAt")
       VALUES ($1,$2,$3,'Rose','ACTIVE','piece',now())`,
      [variantId, tenantId, productId],
    );

    process.env['DATABASE_URL'] = stack.postgres.url;
    process.env['PLATFORM_DATABASE_URL'] = stack.postgres.url;
    process.env['REDIS_URL'] = stack.redis.url;
    process.env['AUTH_JWT_SECRET'] = 'integration-test-jwt-secret-0000000000';
    // long enough for an in-flight duplicate to be replayed, short enough for the IN_PROGRESS test
    process.env['IDEMPOTENCY_WAIT_MS'] = '2500';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SystemClock)
      .useValue(fakeClock)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('v1', { exclude: ['healthz', 'readyz'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    installRequestContext(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    jwt = app.get(JwtService);
    store = app.get(SessionStore);
    db = app.get(DbService);
    prisma = db.appClient();
    sales = app.get(SalesApplicationService);
    atomic = app.get(AtomicWalkInSaleService);
    walkInJournal = app.get(WalkInSaleJournalRepository);
    engine = app.get(PostingEngineService);
    collection = app.get(PaymentCollectionRepository);
    finalization = app.get(TaxFinalizationService);
    advanceApplication = app.get(CustomerAdvanceApplicationRepository);
    accounts = app.get(AccountRepository);
    periods = app.get(AccountingPeriodRepository);
    conversion = app.get(PaymentAdvanceConversionRepository);

    aed = await makeCompany(tenantId, { currency: 'AED' });
    aed2 = await makeCompany(tenantId, { currency: 'AED' });
    kwd = await makeCompany(tenantId, { currency: 'KWD', tz: 'Asia/Kuwait' });

    // the REAL default role grants — never hand-picked lists
    tok['owner'] = await mint('owner', rolePerms('owner'), { stepUp: true });
    tok['ownerNoStepUp'] = await mint('owner-ns', rolePerms('owner'));
    tok['admin'] = await mint('admin', rolePerms('admin'));
    tok['manager'] = await mint('manager', rolePerms('manager'));
    tok['cashier'] = await mint('cashier', rolePerms('cashier'));
    tok['sales'] = await mint('sales', rolePerms('sales'));
    tok['accountant'] = await mint('accountant', rolePerms('accountant'));
    // custom roles
    tok['viewer'] = await mint('viewer', ['orders:view']);
    tok['ordersOnly'] = await mint('orders-only', ['orders:manage']);
    tok['ordersPay'] = await mint('orders-pay', ['orders:manage', 'payments:collect']);
    // scoped users
    tok['branchA'] = await mint('branch-a', rolePerms('cashier'), { branchScope: [aed.branchId] });
    tok['branchSibling'] = await mint('branch-b', rolePerms('cashier'), {
      branchScope: [aed.siblingBranchId],
    });
    tok['otherTenant'] = await mint('other-tenant', rolePerms('owner'), {
      tenant: otherTenantId,
      stepUp: true,
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await stack?.stop();
    for (const k of [
      'DATABASE_URL',
      'PLATFORM_DATABASE_URL',
      'REDIS_URL',
      'AUTH_JWT_SECRET',
      'IDEMPOTENCY_WAIT_MS',
    ]) {
      delete process.env[k];
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 1. the happy paths over HTTP — one route, the ORDER picks the path
  // ═════════════════════════════════════════════════════════════════════════════
  describe('complete-sale over HTTP — anonymous and identified-customer dispatch from the persisted order', () => {
    const RESPONSE_KEYS = [
      'advanceApplications',
      'customerReceivableId',
      'invoice',
      'order',
      'outstandingMinor',
      'paymentGroupId',
      'paymentIntent',
      'payments',
    ];

    it('ANONYMOUS order → the frozen anonymous PAY_NOW path: 200, the stable response, the walk-in journal, one invoice', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const s = spyAll();
      const res = await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }));
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.headers['idempotency-replayed']).toBeUndefined();
      expect(s.anon).toHaveBeenCalledTimes(1);
      expect(s.cust).not.toHaveBeenCalled();

      const b = res.json();
      expect(Object.keys(b).sort()).toEqual(RESPONSE_KEYS);
      expect(b.order).toEqual({ id: o.orderId, orderNumber: expect.stringMatching(/^ORD-\d+$/) });
      expect(b.invoice).toEqual({
        id: expect.any(String),
        invoiceNumber: expect.stringMatching(/^INV-\d+$/),
        currencyCode: 'AED',
        currencyExponent: 2,
        subtotalAmountMinor: '10000',
        documentDiscountAmountMinor: '0',
        taxTotalAmountMinor: '500',
        totalAmountMinor: '10500',
        paymentStatus: 'SETTLED',
      });
      expect(b.paymentIntent).toBe('PAY_NOW');
      expect(b.outstandingMinor).toBe('0');
      expect(b.paymentGroupId).toBeNull();
      expect(b.payments).toEqual([
        {
          paymentId: expect.any(String),
          paymentAttemptId: expect.any(String),
          paymentAllocationId: expect.any(String),
          method: 'CASH',
          amountMinor: '10500',
        },
      ]);
      expect(b.advanceApplications).toEqual([]);
      expect(b.customerReceivableId).toBeNull();

      const inv = (await invoiceOf(o.orderId))!;
      expect(inv.id).toBe(b.invoice.id);
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM journal_entry WHERE "tenantId" = $1 AND "sourceKind" = 'walk_in_sale' AND "sourceId" = $2`,
          [tenantId, inv.id],
        ),
      ).toBe(1);
    });

    it('CUSTOMER order → the frozen customer path: a Multi Payment shares one paymentGroupId; the receivable id is returned', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const s = spyAll();
      const res = await complete(
        tok['cashier']!,
        o,
        body({ tenders: [cash(5_000n), bank(5_500n)] }),
      );
      expect(res.statusCode, res.payload).toBe(200);
      expect(s.cust).toHaveBeenCalledTimes(1);
      expect(s.anon).not.toHaveBeenCalled();
      expect(s.journal).not.toHaveBeenCalled(); // never the anonymous journal for a customer sale
      const b = res.json();
      expect(b.paymentIntent).toBe('PAY_NOW');
      expect(b.invoice.paymentStatus).toBe('SETTLED');
      expect(b.outstandingMinor).toBe('0');
      expect(b.paymentGroupId).toEqual(expect.any(String));
      expect(b.payments.map((p: { method: string }) => p.method)).toEqual([
        'CASH',
        'BANK_TRANSFER',
      ]);
      expect(b.customerReceivableId).toEqual(expect.any(String));
    });

    it('CUSTOMER ON_CREDIT with a partial tender → PARTIAL, the remainder is the receivable (corrected D exposure rule applies)', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 3_500n }); // exposure 3 500 ≤ limit < total
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(
        tok['cashier']!,
        o,
        body({ intent: 'ON_CREDIT', tenders: [cash(7_000n)] }),
      );
      expect(res.statusCode, res.payload).toBe(200);
      const b = res.json();
      expect(b.paymentIntent).toBe('ON_CREDIT');
      expect(b.invoice.paymentStatus).toBe('PARTIAL');
      expect(b.outstandingMinor).toBe('3500');
      expect(b.payments).toHaveLength(1);
    });

    it('CUSTOMER with a CustomerAdvance (manager holds receivables:advance:apply) → the application is returned, advance-only is SETTLED', async () => {
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, 4_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(
        tok['manager']!,
        o,
        body({ tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] }),
      );
      expect(res.statusCode, res.payload).toBe(200);
      const b = res.json();
      expect(b.advanceApplications).toEqual([
        { applicationId: expect.any(String), advanceId, amountMinor: '4000' },
      ]);
      expect(b.outstandingMinor).toBe('0');
    });

    it('the response exposes NO internals: no credit-gate structure, journal, operationKey, exposure parameter, customer id, idempotency id', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 5_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(
        tok['owner']!,
        o,
        body({ intent: 'ON_CREDIT', reason: 'owner approved the exception' }),
      );
      expect(res.statusCode, res.payload).toBe(200); // an OVERRIDE sale — the strongest leak test
      const text = res.payload;
      expect(text).not.toMatch(
        /creditAuthorizationMode|authorities|journal|operationKey|finalSaleOutstanding|creditExposure|customerCompanyAccount|idempotency|claimToken|OVERRIDE/i,
      );
      expect(text).not.toContain(c.customerId);
      expect(text).not.toContain(c.ccaId);
      expect(Object.keys(res.json()).sort()).toEqual(RESPONSE_KEYS);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 2. the DTO is strict — no trusted / authoritative / server-owned field is client-suppliable
  // ═════════════════════════════════════════════════════════════════════════════
  describe('the complete-sale DTO is strict (zod .strict(), 400 VALIDATION_FAILED, zero mutation)', () => {
    const FORBIDDEN: [string, unknown][] = [
      ['customerId', randomUUID()],
      ['customerCompanyAccountId', randomUUID()],
      ['tenantId', randomUUID()],
      ['companyId', randomUUID()],
      ['branchId', randomUUID()],
      ['terminalId', randomUUID()],
      ['posTerminalId', randomUUID()],
      ['userId', randomUUID()],
      ['actorUserId', randomUUID()],
      ['operationKey', 'client-supplied-op-key'],
      ['finalSaleOutstandingMinor', '1'],
      ['creditExposureMinor', '1'],
      ['creditOverride', true],
      ['overrideCreditLimit', true],
      ['override', true],
      ['force', true],
      ['bypass', true],
      ['allowOverLimit', true],
      ['totalAmountMinor', '1'],
      ['taxTotalAmountMinor', '1'],
      ['subtotalAmountMinor', '1'],
      ['currencyCode', 'USD'],
      ['currencyExponent', 3],
      ['outstandingMinor', '0'],
      ['version', 1],
      ['expectedVersion', 1],
      ['paymentGroupId', randomUUID()],
    ];

    it.each(FORBIDDEN)(
      'a body carrying `%s` is rejected (400) — nothing written, no idempotency claim left',
      async (field, value) => {
        const o = await mkOrder(aed, null, one(10_000n));
        await expectRejection(
          () =>
            complete(
              tok['cashier']!,
              o,
              body({ tenders: [cash(TOTAL)], extra: { [field]: value } }),
            ),
          400,
          'VALIDATION_FAILED',
          o,
        );
        expect(await orderState(o.orderId)).toEqual({ status: 'DRAFT', version: 1 });
      },
    );

    const NESTED: [string, Record<string, unknown>][] = [
      [
        'a tender with providerCredentialId (a provider-backed tender)',
        { tenders: [{ ...cash(TOTAL), providerCredentialId: randomUUID() }] },
      ],
      ['a tender with a currencyCode', { tenders: [{ ...cash(TOTAL), currencyCode: 'USD' }] }],
      [
        'a tender with a paymentGroupId',
        { tenders: [{ ...cash(TOTAL), paymentGroupId: randomUUID() }] },
      ],
      [
        'an ONLINE_GATEWAY tender',
        { tenders: [{ method: 'ONLINE_GATEWAY', amountMinor: TOTAL.toString() }] },
      ],
      [
        'a CREDIT "tender" (credit is never a tender)',
        { tenders: [{ method: 'CREDIT', amountMinor: TOTAL.toString() }] },
      ],
      ['a zero tender amount', { tenders: [{ method: 'CASH', amountMinor: '0' }] }],
      ['a negative tender amount', { tenders: [{ method: 'CASH', amountMinor: '-5' }] }],
      ['a decimal tender amount', { tenders: [{ method: 'CASH', amountMinor: '10.5' }] }],
      ['a NUMBER tender amount', { tenders: [{ method: 'CASH', amountMinor: 10500 }] }],
      ['a leading-zero tender amount', { tenders: [{ method: 'CASH', amountMinor: '010500' }] }],
      [
        'an advance with a customerReceivableId',
        { advanceApplications: [{ ...adv(randomUUID(), 1n), customerReceivableId: randomUUID() }] },
      ],
      [
        'an advance with a currencyCode',
        { advanceApplications: [{ ...adv(randomUUID(), 1n), currencyCode: 'AED' }] },
      ],
      [
        'an advance with a non-uuid id',
        { advanceApplications: [{ advanceId: 'not-a-uuid', amountMinor: '1' }] },
      ],
      ['an unknown paymentIntent', { paymentIntent: 'CREDIT' }],
      ['tenders that are not an array', { tenders: 'CASH' }],
    ];
    // the MANAGER holds payments:collect AND receivables:advance:apply, so the 400 below comes from
    // validation, not from the conditional-authority guard (which would answer 403 first)
    it.each(NESTED)('%s → 400 VALIDATION_FAILED, nothing written', async (_label, patch) => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['manager']!, o, { ...body({ tenders: [cash(TOTAL)] }), ...patch }),
        400,
        'VALIDATION_FAILED',
        o,
      );
    });

    it('a missing paymentIntent is refused — there is no default and no inference from the tenders', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, { tenders: [cash(TOTAL)] }),
        400,
        'VALIDATION_FAILED',
        o,
      );
    });

    it('spoofed scope HEADERS are ignored: the sale runs under the SESSION tenant and the ROUTE branch only', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const res = await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), {
        headers: {
          'x-tenant-id': otherTenantId,
          'x-company-id': aed2.companyId,
          'x-branch-id': aed.siblingBranchId,
          'x-pos-terminal-id': randomUUID(),
          'x-user-id': randomUUID(),
        },
      });
      expect(res.statusCode, res.payload).toBe(200);
      const pay = await q<{ tenantId: string; companyId: string; branchId: string }>(
        `SELECT "tenantId","companyId","branchId" FROM payment WHERE "tenantId" = $1 AND "branchId" = $2 AND "companyId" = $3 ORDER BY "createdAt" DESC LIMIT 1`,
        [tenantId, aed.branchId, aed.companyId],
      );
      expect(pay).toHaveLength(1);
      expect((await invoiceOf(o.orderId))!.id).toBe(res.json().invoice.id);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 3. If-Match — the expected order version, from the header only
  // ═════════════════════════════════════════════════════════════════════════════
  describe('If-Match is the expected order version (and part of the idempotency identity)', () => {
    it('a MISSING If-Match fails closed: 428 PRECONDITION_REQUIRED, nothing written, no claim left', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
        o,
      );
    });

    it.each(['abc', '*', '""', '-1', '1.5', 'W/', 'one', '1,2'])(
      'a MALFORMED If-Match (%j) fails closed with the established 428, nothing written',
      async (bad) => {
        const o = await mkOrder(aed, null, one(10_000n));
        await expectRejection(
          () => complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), { ifMatch: bad }),
          428,
          'PRECONDITION_REQUIRED',
          o,
        );
      },
    );

    it('a STALE If-Match → 409 ORDER_VERSION_CONFLICT; the claim is released so a corrected retry with the SAME key succeeds', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await pool.query(`UPDATE "order" SET version = version + 1 WHERE id = $1`, [o.orderId]); // N → N+1
      const key = ik();
      const stale = await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), {
        key,
        ifMatch: 1,
      });
      expect(stale.statusCode).toBe(409);
      expect(errCode(stale)).toBe('ORDER_VERSION_CONFLICT');
      expect(await invoiceOf(o.orderId)).toBeNull();
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM idempotency_key WHERE "tenantId" = $1 AND key = $2`,
          [tenantId, key],
        ),
      ).toBe(0);
      const retry = await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), {
        key,
        ifMatch: 2,
      });
      expect(retry.statusCode, retry.payload).toBe(200);
    });

    it('a body `version` is never a substitute: it is refused (400) and the header is still required', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () =>
          complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)], extra: { version: 1 } }), {
            ifMatch: null,
          }),
        428,
        'PRECONDITION_REQUIRED',
        o,
      );
    });

    it('the quoted / weak spellings of one version are ONE precondition: `1`, `"1"` and `W/"1"` replay the same key', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const first = await complete(tok['cashier']!, o, b, { key, ifMatch: '1' });
      expect(first.statusCode, first.payload).toBe(200);
      const quoted = await complete(tok['cashier']!, o, b, { key, ifMatch: '"1"' });
      expect(quoted.statusCode).toBe(200);
      expect(quoted.headers['idempotency-replayed']).toBe('true');
      const weak = await complete(tok['cashier']!, o, b, { key, ifMatch: 'W/"1"' });
      expect(weak.statusCode).toBe(200);
      expect(weak.headers['idempotency-replayed']).toBe('true');
      expect(quoted.json()).toEqual(first.json());
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 4. public idempotency — hard gates against the REAL interceptor, store and stack
  // ═════════════════════════════════════════════════════════════════════════════
  describe('public idempotency (scope orders.complete_sale) — hard gates', () => {
    it('A + L — an exact replay returns the STORED response, flagged as a replay, and invokes ZERO sale services and writes ZERO effects', async () => {
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, 2_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(5_000n), bank(3_500n)], advances: [adv(advanceId, 2_000n)] });
      const first = await complete(tok['manager']!, o, b, { key });
      expect(first.statusCode, first.payload).toBe(200);
      expect(first.headers['idempotency-replayed']).toBeUndefined();

      const before = await snapshot();
      const s = spyAll();
      const second = await complete(tok['manager']!, o, b, { key });
      expect(second.statusCode).toBe(200);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());
      expect(callCount(s)).toBe(0); // facade, orchestrator, journal, posting, capture, issuance, advance: NONE ran
      // zero new DB effects of ANY kind: invoice, payments, allocations, advance application,
      // journals, audit, outbox (so no second orders.sale_completed), counters
      expect(await snapshot()).toEqual(before);
      expect(await saleEvents(o.orderId)).toHaveLength(1);
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
          o.orderId,
        ]),
      ).toBe(1);
    });

    it('K — a replay after the order is already CONFIRMED still returns the stored 200 (not the 409 a fresh attempt would get)', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const first = await complete(tok['cashier']!, o, b, { key });
      expect(first.statusCode).toBe(200);
      expect((await orderState(o.orderId)).status).toBe('CONFIRMED');
      const replay = await complete(tok['cashier']!, o, b, { key });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      // …while a NEW key on the now-CONFIRMED order is refused and sells nothing twice
      await expectRejection(
        () => complete(tok['cashier']!, o, b, { ifMatch: 1 }),
        409,
        'ORDER_INVALID_STATE_TRANSITION',
      );
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
          o.orderId,
        ]),
      ).toBe(1);
    });

    it('B — the same key with a CHANGED body is 409 IDEMPOTENCY_KEY_REUSED, and runs nothing', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const first = await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), { key });
      expect(first.statusCode).toBe(200);
      const before = await snapshot();
      const s = spyAll();
      const changed = await complete(tok['cashier']!, o, body({ tenders: [bank(TOTAL)] }), { key });
      expect(changed.statusCode).toBe(409);
      expect(errCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(callCount(s)).toBe(0);
      expect(await snapshot()).toEqual(before);
    });

    it('C — the same key against a DIFFERENT order is 409 IDEMPOTENCY_KEY_REUSED; the other order is untouched', async () => {
      const o1 = await mkOrder(aed, null, one(10_000n));
      const o2 = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      expect((await complete(tok['cashier']!, o1, b, { key })).statusCode).toBe(200);
      const other = await complete(tok['cashier']!, o2, b, { key });
      expect(other.statusCode).toBe(409);
      expect(errCode(other)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await orderState(o2.orderId)).toEqual({ status: 'DRAFT', version: 1 });
      expect(await invoiceOf(o2.orderId)).toBeNull();
    });

    it('D — the same key with a CHANGED If-Match is 409 IDEMPOTENCY_KEY_REUSED — If-Match is part of the semantic request, it never silently replays', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const first = await complete(tok['cashier']!, o, b, { key, ifMatch: 1 });
      expect(first.statusCode).toBe(200);
      const s = spyAll();
      const changed = await complete(tok['cashier']!, o, b, { key, ifMatch: 2 });
      expect(changed.statusCode).toBe(409);
      expect(errCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(changed.headers['idempotency-replayed']).toBeUndefined();
      expect(callCount(s)).toBe(0);
    });

    it("E — another PRINCIPAL with the same key never receives the first principal's response (identity includes the principal)", async () => {
      const o1 = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const mine = await complete(tok['cashier']!, o1, b, { key });
      expect(mine.statusCode).toBe(200);
      // the SAME key + request from a second principal is NOT a replay: it executes (and the order is gone)
      const theirs = await complete(tok['manager']!, o1, b, { key, ifMatch: 1 });
      expect(theirs.statusCode).toBe(409);
      expect(errCode(theirs)).toBe('ORDER_INVALID_STATE_TRANSITION');
      expect(theirs.headers['idempotency-replayed']).toBeUndefined();
      // …and on a fresh order the second principal's sale is wholly independent
      const o2 = await mkOrder(aed, null, one(10_000n));
      const independent = await complete(tok['manager']!, o2, b, { key });
      expect(independent.statusCode).toBe(200);
      expect(independent.json().order.id).toBe(o2.orderId);
    });

    it('the fingerprint is the NORMALIZED request: advance applications in a different ORDER, an advance id in a different CASE, and a reason with different surrounding whitespace are ONE request (replay)', async () => {
      const c = await mkCustomer(aed);
      const a1 = await mkAdvance(c, 1_000n);
      const a2 = await mkAdvance(c, 2_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const key = ik();
      const first = await complete(
        tok['manager']!,
        o,
        body({
          intent: 'ON_CREDIT',
          tenders: [cash(5_000n)],
          advances: [adv(a1, 1_000n), adv(a2, 2_000n)],
          reason: 'owner approved',
        }),
        { key },
      );
      expect(first.statusCode, first.payload).toBe(200);
      const reordered = await complete(
        tok['manager']!,
        o,
        body({
          intent: 'ON_CREDIT',
          tenders: [cash(5_000n)],
          advances: [adv(a2, 2_000n), adv(a1, 1_000n)],
          reason: 'owner approved',
        }),
        { key },
      );
      expect(reordered.statusCode).toBe(200);
      expect(reordered.headers['idempotency-replayed']).toBe('true');
      const upper = await complete(
        tok['manager']!,
        o,
        body({
          intent: 'ON_CREDIT',
          tenders: [cash(5_000n)],
          advances: [adv(a1.toUpperCase(), 1_000n), adv(a2, 2_000n)],
          reason: 'owner approved',
        }),
        { key },
      );
      expect(upper.headers['idempotency-replayed']).toBe('true');
      const padded = await complete(
        tok['manager']!,
        o,
        body({
          intent: 'ON_CREDIT',
          tenders: [cash(5_000n)],
          advances: [adv(a1, 1_000n), adv(a2, 2_000n)],
          reason: '   owner approved   ',
        }),
        { key },
      );
      expect(padded.headers['idempotency-replayed']).toBe('true');
      expect(padded.json()).toEqual(first.json());
    });

    it('…but a CHANGED reason, a changed tender order or a changed amount is a DIFFERENT request: 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const key = ik();
      const base = {
        intent: 'ON_CREDIT' as const,
        tenders: [cash(2_000n), bank(1_000n)],
        reason: 'because',
      };
      expect((await complete(tok['cashier']!, o, body(base), { key })).statusCode).toBe(200);
      const variants = [
        body({ ...base, reason: 'a different reason' }),
        body({ ...base, tenders: [bank(1_000n), cash(2_000n)] }), // tender order IS meaning (payment creation order)
        body({ ...base, tenders: [cash(2_000n), bank(1_001n)] }),
        body({ ...base, intent: 'PAY_NOW' }),
      ];
      for (const v of variants) {
        const r = await complete(tok['cashier']!, o, v, { key });
        expect(r.statusCode).toBe(409);
        expect(errCode(r)).toBe('IDEMPOTENCY_KEY_REUSED');
      }
    });

    it('F — two CONCURRENT exact requests: exactly one executes, the other waits and replays its result', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(5_000n), bank(5_500n)] });
      const s = spyAll();
      const [r1, r2] = await Promise.all([
        complete(tok['cashier']!, o, b, { key }),
        complete(tok['cashier']!, o, b, { key }),
      ]);
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
      expect(r1.json()).toEqual(r2.json());
      const replayed = [r1, r2].filter((r) => r.headers['idempotency-replayed'] === 'true');
      expect(replayed).toHaveLength(1);
      expect(s.sale).toHaveBeenCalledTimes(1);
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
          o.orderId,
        ]),
      ).toBe(1);
      expect(await saleEvents(o.orderId)).toHaveLength(1);
      const inv = (await invoiceOf(o.orderId))!;
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM payment_allocation WHERE "invoiceId" = $1`,
          [inv.id],
        ),
      ).toBe(2);
    });

    it('IN PROGRESS — a duplicate that outlasts the wait window gets the established 409 IDEMPOTENCY_IN_PROGRESS; the first still completes once', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const real = sales.completeSale.bind(sales);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const spy = vi.spyOn(sales, 'completeSale').mockImplementationOnce(async (cmd) => {
        await gate;
        return real(cmd);
      });
      const first = complete(tok['cashier']!, o, b, { key });
      for (let i = 0; i < 100 && spy.mock.calls.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(spy).toHaveBeenCalledTimes(1);
      const dup = await complete(tok['cashier']!, o, b, { key });
      expect(dup.statusCode).toBe(409);
      expect(errCode(dup)).toBe('IDEMPOTENCY_IN_PROGRESS');
      release();
      const done = await first;
      expect(done.statusCode, done.payload).toBe(200);
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
          o.orderId,
        ]),
      ).toBe(1);
    }, 30_000);

    it('G — an original that fails BEFORE any write releases its claim; the same key retries cleanly', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const key = ik();
      const b = body({ intent: 'ON_CREDIT' });
      const denied = await complete(tok['cashier']!, o, b, { key });
      expect(denied.statusCode).toBe(409);
      expect(errCode(denied)).toBe('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM idempotency_key WHERE "tenantId" = $1 AND key = $2`,
          [tenantId, key],
        ),
      ).toBe(0);
      await pool.query(
        `UPDATE customer_company_account SET "creditLimitMinor" = 50000 WHERE id = $1`,
        [c.ccaId],
      );
      const retry = await complete(tok['cashier']!, o, b, { key });
      expect(retry.statusCode, retry.payload).toBe(200);
    });

    it('H — an original that fails LATE (after payments were written) rolls EVERYTHING back, emits no event, releases its claim; the same key then succeeds', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(5_000n), bank(5_500n)] });
      const before = await snapshot();
      const spy = vi
        .spyOn(walkInJournal, 'postWalkInSaleJournalInTx')
        .mockRejectedValueOnce(new Error('simulated late failure after the payments'));
      const failed = await complete(tok['cashier']!, o, b, { key });
      expect(failed.statusCode).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(before); // invoice, payments, allocations, journals, audit, outbox, counters
      expect(await saleEvents(o.orderId)).toHaveLength(0);
      expect(await orderState(o.orderId)).toEqual({ status: 'DRAFT', version: 1 });
      const retry = await complete(tok['cashier']!, o, b, { key });
      expect(retry.statusCode, retry.payload).toBe(200);
      expect(await saleEvents(o.orderId)).toHaveLength(1);
    });

    it('I — a LOST response: the sale is recoverable from the order read, a new key sells nothing twice, and the original key still replays', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const lost = await complete(tok['cashier']!, o, b, { key }); // the client never sees this
      expect(lost.statusCode).toBe(200);
      // recovery 1 — the order read carries the issued invoice
      const read = await getJson(tok['cashier']!, orderUrl(o));
      expect(read.statusCode).toBe(200);
      expect(read.json().issuedInvoice).toEqual({
        invoiceId: lost.json().invoice.id,
        invoiceNumber: lost.json().invoice.invoiceNumber,
        invoiceDate: '2026-06-15',
        totalAmountMinor: '10500',
        invoicePaymentStatus: 'SETTLED',
      });
      // a client that lost its key and tries again with a NEW key: refused, nothing sold twice
      await expectRejection(
        () => complete(tok['cashier']!, o, b, { ifMatch: 1 }),
        409,
        'ORDER_INVALID_STATE_TRANSITION',
      );
      // recovery 2 — the original key replays the stored response
      const replay = await complete(tok['cashier']!, o, b, { key });
      expect(replay.json()).toEqual(lost.json());
    });

    it('J — a replay after the original ACCOUNTING PERIOD CLOSED still returns the stored success; no service runs; no effect (the Checkpoint-B replay finding)', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const o = await mkOrder(co, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const first = await complete(tok['cashier']!, o, b, { key });
      expect(first.statusCode, first.payload).toBe(200);

      // close the period the sale was posted into
      await asTenant((tx) =>
        periods.close(tx, {
          tenantId,
          companyId: co.companyId,
          id: co.periodId,
          expectedVersion: co.periodVersion,
          closedByUserId: null,
        }),
      );
      // …a FRESH sale in that company is now genuinely refused by the period gate
      const fresh = await mkOrder(co, null, one(10_000n));
      const refused = await complete(tok['cashier']!, fresh, b);
      expect(refused.statusCode).toBe(422);
      expect(errCode(refused)).toBe('ACCOUNTING_PERIOD_CLOSED');

      const before = await snapshot();
      const s = spyAll();
      const replay = await complete(tok['cashier']!, o, b, { key });
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      expect(callCount(s)).toBe(0);
      expect(s.journal).not.toHaveBeenCalled();
      expect(s.post).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    });

    it('the nested operation identity is the request Idempotency-Key (the payments.create convention), and a replay creates no second PaymentAttempt / Payment', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(5_000n), bank(5_500n)] });
      const s = spyAll();
      const first = await complete(tok['cashier']!, o, b, { key });
      expect(first.statusCode, first.payload).toBe(200);
      expect(s.capture.mock.calls[0]![1].idempotencyKey).toBe(key);
      const inv = (await invoiceOf(o.orderId))!;
      const attempts = () =>
        q<{ idempotencyKey: string }>(
          `SELECT "idempotencyKey" FROM payment_attempt WHERE "targetInvoiceId" = $1`,
          [inv.id],
        );
      expect((await attempts()).map((a) => a.idempotencyKey)).toEqual([key, key]);
      const payments = () =>
        countWhere(
          `SELECT count(*)::int AS n FROM payment p JOIN payment_attempt a ON a.id = p."sourceAttemptId" WHERE a."targetInvoiceId" = $1`,
          [inv.id],
        );
      expect(await payments()).toBe(2);
      await complete(tok['cashier']!, o, b, { key });
      await complete(tok['cashier']!, o, b, { key });
      expect(await attempts()).toHaveLength(2);
      expect(await payments()).toBe(2);
    });

    it('a MISSING / MALFORMED Idempotency-Key is refused by the shared interceptor before anything runs', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), { key: null }),
        400,
        'IDEMPOTENCY_KEY_MISSING',
        o,
      );
      for (const bad of ['short', 'has space in it!', 'x'.repeat(201)]) {
        await expectRejection(
          () => complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), { key: bad }),
          400,
          'IDEMPOTENCY_KEY_INVALID',
          o,
        );
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 5. permissions — the REAL default role grants + the conditional authority
  // ═════════════════════════════════════════════════════════════════════════════
  describe('permission matrix (real SYSTEM_ROLE_TEMPLATES) and conditional authority', () => {
    it.each(['cashier', 'sales'])(
      '%s — a normal local PAY_NOW (orders:manage + payments:collect) succeeds',
      async (role) => {
        const o = await mkOrder(aed, null, one(10_000n));
        const res = await complete(tok[role]!, o, body({ tenders: [cash(TOTAL)] }));
        expect(res.statusCode, res.payload).toBe(200);
      },
    );

    it.each(['cashier', 'sales'])(
      '%s — cannot apply an advance without receivables:advance:apply (403, nothing written, advance untouched)',
      async (role) => {
        const c = await mkCustomer(aed);
        const advanceId = await mkAdvance(c, 4_000n);
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        await expectRejection(
          () =>
            complete(
              tok[role]!,
              o,
              body({ tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] }),
            ),
          403,
          'MISSING_PERMISSION',
          o,
        );
      },
    );

    it.each(['cashier', 'sales', 'manager', 'admin'])(
      '%s — cannot perform a credit-limit override (Owner-only): 403 CREDIT_OVERRIDE_DENIED, nothing written',
      async (role) => {
        const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        await expectRejection(
          () =>
            complete(tok[role]!, o, body({ intent: 'ON_CREDIT', reason: 'please approve this' })),
          403,
          'CREDIT_OVERRIDE_DENIED',
          o,
        );
      },
    );

    it.each(['manager', 'admin'])(
      '%s — holds receivables:advance:apply and may spend an advance on a sale',
      async (role) => {
        const c = await mkCustomer(aed);
        const advanceId = await mkAdvance(c, 4_000n);
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        const res = await complete(
          tok[role]!,
          o,
          body({ tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] }),
        );
        expect(res.statusCode, res.payload).toBe(200);
      },
    );

    it('an advance-ONLY sale needs receivables:advance:apply and NOT payments:collect (the axes are independent)', async () => {
      const advanceOnly = await mint('adv-only', ['orders:manage', 'receivables:advance:apply']);
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, TOTAL);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(advanceOnly, o, body({ advances: [adv(advanceId, TOTAL)] }));
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().payments).toEqual([]);
      expect(res.json().invoice.paymentStatus).toBe('SETTLED');
    });

    it('the Owner WITH step-up performs a credit-limit override: 200, the exception is audited once with its reason', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(
        tok['owner']!,
        o,
        body({ intent: 'ON_CREDIT', reason: '  VIP — approved by the owner  ' }),
      );
      expect(res.statusCode, res.payload).toBe(200);
      const audit = await q<{ reason: string | null }>(
        `SELECT reason FROM audit_log WHERE "tenantId" = $1 AND action = 'credit_limit.override_used' AND "resourceId" = $2`,
        [tenantId, c.ccaId],
      );
      expect(audit).toEqual([{ reason: 'VIP — approved by the owner' }]);
    });

    it('the Owner WITHOUT a fresh step-up cannot override: 403 CREDIT_OVERRIDE_DENIED, nothing written', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejection(
        () =>
          complete(
            tok['ownerNoStepUp']!,
            o,
            body({ intent: 'ON_CREDIT', reason: 'owner approves' }),
          ),
        403,
        'CREDIT_OVERRIDE_DENIED',
        o,
      );
    });

    it('a reason alone grants nothing — and requires nothing: a sale that needs NO override ignores it (a cashier supplying one still succeeds, no override audited)', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(
        tok['cashier']!,
        o,
        body({ intent: 'ON_CREDIT', tenders: [cash(2_000n)], reason: 'just in case' }),
      );
      expect(res.statusCode, res.payload).toBe(200);
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 AND action = 'credit_limit.override_used' AND "resourceId" = $2`,
          [tenantId, c.ccaId],
        ),
      ).toBe(0);
    });

    it('an over-limit sale with NO reason is a plain 409 CUSTOMER_CREDIT_LIMIT_EXCEEDED even for the Owner — authority alone grants nothing', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejection(
        () => complete(tok['owner']!, o, body({ intent: 'ON_CREDIT' })),
        409,
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        o,
      );
    });

    it('the Accountant holds no orders:* authority: complete-sale and totals are both 403 MISSING_PERMISSION', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['accountant']!, o, body({ tenders: [cash(TOTAL)] })),
        403,
        'MISSING_PERMISSION',
        o,
      );
      const totals = await getJson(tok['accountant']!, orderUrl(o, '/totals'));
      expect(totals.statusCode).toBe(403);
      expect(errCode(totals)).toBe('MISSING_PERMISSION');
    });

    it('custom roles: orders:manage alone cannot take a tender; orders:manage + payments:collect cannot spend an advance; orders:view alone cannot sell', async () => {
      const o1 = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['ordersOnly']!, o1, body({ tenders: [cash(TOTAL)] })),
        403,
        'MISSING_PERMISSION',
        o1,
      );
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, 4_000n);
      const o2 = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejection(
        () =>
          complete(
            tok['ordersPay']!,
            o2,
            body({ tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] }),
          ),
        403,
        'MISSING_PERMISSION',
        o2,
      );
      const o3 = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['viewer']!, o3, body({ tenders: [cash(TOTAL)] })),
        403,
        'MISSING_PERMISSION',
        o3,
      );
    });

    it('CREDIT IS NOT A TENDER: an ON_CREDIT sale with no tender and no advance needs only orders:manage', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(tok['ordersOnly']!, o, body({ intent: 'ON_CREDIT' }));
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().invoice.paymentStatus).toBe('UNPAID');
      expect(res.json().outstandingMinor).toBe('10500');
    });

    it('a malformed tenders value from a caller WITHOUT payments:collect gets 403 first (the guard fails closed) — only an authorised caller sees the 400', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const bad = { paymentIntent: 'PAY_NOW', tenders: 'CASH' };
      const unauth = await complete(tok['ordersOnly']!, o, bad);
      expect(unauth.statusCode).toBe(403);
      const authed = await complete(tok['cashier']!, o, bad);
      expect(authed.statusCode).toBe(400);
    });

    it('AUTHORISATION vs REPLAY — a principal who LOSES payments:collect can no longer replay a response that included a tender (the guard runs before the replay)', async () => {
      const principal = 'replay-authz';
      const withPay = await mint(principal, ['orders:manage', 'payments:collect']);
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const first = await complete(withPay, o, b, { key });
      expect(first.statusCode, first.payload).toBe(200);
      const replayOk = await complete(withPay, o, b, { key });
      expect(replayOk.headers['idempotency-replayed']).toBe('true');

      // the SAME principal (same user id), the SAME key — but the permission is revoked
      const revoked = await mint(principal, ['orders:manage']);
      const s = spyAll();
      const denied = await complete(revoked, o, b, { key });
      expect(denied.statusCode).toBe(403);
      expect(errCode(denied)).toBe('MISSING_PERMISSION');
      expect(denied.headers['idempotency-replayed']).toBeUndefined();
      expect(callCount(s)).toBe(0);
    });

    it('the per-branch overlay narrows the CONDITIONAL authority too: a tender is refused where the overlay does not allow payments:collect', async () => {
      const overlayUser = await mint('overlay', ['orders:manage', 'payments:collect'], {
        overlay: { [aed.branchId]: ['orders:manage'] },
      });
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(overlayUser, o, body({ tenders: [cash(TOTAL)] })),
        403,
        'MISSING_PERMISSION',
        o,
      );
      // …while the sibling branch, where the overlay does not apply, still allows it
      const oSibling = await mkOrder(aed, null, one(10_000n), aed.siblingBranchId);
      const ok = await complete(overlayUser, oSibling, body({ tenders: [cash(TOTAL)] }));
      expect(ok.statusCode, ok.payload).toBe(200);
    });

    it('the base permission is enforced before any replay too: losing orders:manage denies the replay', async () => {
      const principal = 'replay-base';
      const full = await mint(principal, ['orders:manage', 'payments:collect']);
      const o = await mkOrder(aed, null, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      expect((await complete(full, o, b, { key })).statusCode).toBe(200);
      const viewOnly = await mint(principal, ['orders:view', 'payments:collect']);
      const denied = await complete(viewOnly, o, b, { key });
      expect(denied.statusCode).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 6. the HTTP error matrix — existing DomainError / filter mapping, nothing one-off
  // ═════════════════════════════════════════════════════════════════════════════
  describe('HTTP error matrix', () => {
    it('order not found → 404 ORDER_NOT_FOUND', async () => {
      const ghost: MadeOrder = {
        ...(await mkOrder(aed, null, one(10_000n))),
        orderId: randomUUID(),
      };
      await expectRejection(
        () => complete(tok['cashier']!, ghost, body({ tenders: [cash(TOTAL)] })),
        404,
        'ORDER_NOT_FOUND',
      );
    });

    it('a non-uuid order id → 404 NOT_FOUND (assertUuid), never a 500', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const res = await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), {
        url: `/v1/companies/${aed.companyId}/branches/${aed.branchId}/orders/not-a-uuid/complete-sale`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('anonymous ON_CREDIT → 422 SALE_CREDIT_REQUIRES_CUSTOMER', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, body({ intent: 'ON_CREDIT', tenders: [cash(2_000n)] })),
        422,
        'SALE_CREDIT_REQUIRES_CUSTOMER',
        o,
      );
    });

    it("anonymous with an advance → 422 SALE_ADVANCE_REQUIRES_CUSTOMER (the frozen plan's own code), nothing written", async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () =>
          complete(
            tok['manager']!,
            o,
            body({ tenders: [cash(6_500n)], advances: [adv(randomUUID(), 4_000n)] }),
          ),
        422,
        'SALE_ADVANCE_REQUIRES_CUSTOMER',
        o,
      );
    });

    it('underpayment (PAY_NOW not fully covered) → 422 SALE_NOT_FULLY_RESOLVED', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL - 1n)] })),
        422,
        'SALE_NOT_FULLY_RESOLVED',
        o,
      );
    });

    it('overpayment → 422 SALE_OVERPAYMENT_NOT_ALLOWED (no change-making)', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL + 1n)] })),
        422,
        'SALE_OVERPAYMENT_NOT_ALLOWED',
        o,
      );
    });

    it('credit-limit exceeded → 409 CUSTOMER_CREDIT_LIMIT_EXCEEDED', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, body({ intent: 'ON_CREDIT' })),
        409,
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        o,
      );
    });

    it('credit disabled → 422 CUSTOMER_CREDIT_DISABLED (an override can never buy it)', async () => {
      const c = await mkCustomer(aed, { enabled: false });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejection(
        () => complete(tok['owner']!, o, body({ intent: 'ON_CREDIT', reason: 'owner approves' })),
        422,
        'CUSTOMER_CREDIT_DISABLED',
        o,
      );
    });

    it('insufficient advance → 409 CUSTOMER_ADVANCE_APPLICATION_INVALID, the advance is untouched', async () => {
      const c = await mkCustomer(aed);
      const advanceId = await mkAdvance(c, 1_000n);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejection(
        () =>
          complete(
            tok['manager']!,
            o,
            body({ tenders: [cash(7_500n)], advances: [adv(advanceId, 3_000n)] }),
          ),
        409,
        'CUSTOMER_ADVANCE_APPLICATION_INVALID',
        o,
      );
    });

    it('a PAY_NOW with neither tender nor advance → 422 SALE_NOT_FULLY_RESOLVED', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o, body({})),
        422,
        'SALE_NOT_FULLY_RESOLVED',
        o,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 7. tenant / company / branch / customer isolation — non-disclosing, zero mutation
  // ═════════════════════════════════════════════════════════════════════════════
  describe('scope isolation probes (real HTTP; non-disclosing; zero mutation)', () => {
    const payNow = () => body({ tenders: [cash(TOTAL)] });

    it("cross-TENANT: another tenant's Owner gets the same 404 ORDER_NOT_FOUND — and nothing changes", async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['otherTenant']!, o, payNow()),
        404,
        'ORDER_NOT_FOUND',
        o,
      );
      expect(await orderState(o.orderId)).toEqual({ status: 'DRAFT', version: 1 });
    });

    it('wrong COMPANY: the order is in company A but the route names company A2 → 404 ORDER_NOT_FOUND', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () =>
          complete(tok['cashier']!, o, payNow(), {
            url: `/v1/companies/${aed2.companyId}/branches/${aed2.branchId}/orders/${o.orderId}/complete-sale`,
          }),
        404,
        'ORDER_NOT_FOUND',
        o,
      );
    });

    it("SIBLING branch: an order of the sibling branch cannot be sold through this branch's route (404), even by a caller scoped to ALL branches", async () => {
      const o = await mkOrder(aed, null, one(10_000n), aed.siblingBranchId);
      await expectRejection(
        () =>
          complete(tok['cashier']!, o, payNow(), {
            url: `/v1/companies/${aed.companyId}/branches/${aed.branchId}/orders/${o.orderId}/complete-sale`,
          }),
        404,
        'ORDER_NOT_FOUND',
        o,
      );
    });

    it("a caller scoped to branch A cannot reach branch B's route at all (the guard pipeline, 404), and vice-versa", async () => {
      const oB = await mkOrder(aed, null, one(10_000n), aed.siblingBranchId);
      await expectRejection(() => complete(tok['branchA']!, oB, payNow()), 404, 'NOT_FOUND', oB);
      const oA = await mkOrder(aed, null, one(10_000n));
      await expectRejection(
        () => complete(tok['branchSibling']!, oA, payNow()),
        404,
        'NOT_FOUND',
        oA,
      );
    });

    it('the ROUTE scope pipeline alone (no tender, no advance — so the conditional guard has nothing to double-check) keeps a branch-scoped / company-scoped caller out of another branch / company, on complete-sale AND totals', async () => {
      const c = await mkCustomer(aed);
      const sibling = await mkOrder(aed, c.customerId, one(10_000n), aed.siblingBranchId);
      const onlyBranchA = await mint('scope-branch-a', ['orders:manage', 'orders:view'], {
        branchScope: [aed.branchId],
      });
      // complete-sale, ON_CREDIT with no tender: no conditional authority is implicated at all
      await expectRejection(
        () => complete(onlyBranchA, sibling, body({ intent: 'ON_CREDIT' })),
        404,
        'NOT_FOUND',
        sibling,
      );
      const totalsWrongBranch = await getJson(onlyBranchA, orderUrl(sibling, '/totals'));
      expect(totalsWrongBranch.statusCode).toBe(404);

      const onlyCompany2 = await mint('scope-company-2', ['orders:manage', 'orders:view'], {
        companyScope: [aed2.companyId],
      });
      const own = await mkOrder(aed, c.customerId, one(10_000n));
      await expectRejection(
        () => complete(onlyCompany2, own, body({ intent: 'ON_CREDIT' })),
        404,
        'NOT_FOUND',
        own,
      );
      expect((await getJson(onlyCompany2, orderUrl(own, '/totals'))).statusCode).toBe(404);
      expect((await getJson(onlyCompany2, orderUrl(own))).statusCode).toBe(404);
    });

    it("a MISMATCHED company / branch pair in the URL — the order's real branch under ANOTHER company — is a non-disclosing 404 on complete-sale, totals and the order read", async () => {
      const o = await mkOrder(aed, null, one(10_000n)); // company aed, branch aed.branchId
      const mismatched = (tail: string): string =>
        `/v1/companies/${aed2.companyId}/branches/${aed.branchId}/orders/${o.orderId}${tail}`;
      await expectRejection(
        () =>
          complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), {
            url: mismatched('/complete-sale'),
          }),
        404,
        'ORDER_NOT_FOUND',
        o,
      );
      expect((await getJson(tok['viewer']!, mismatched('/totals'))).statusCode).toBe(404);
      expect((await getJson(tok['viewer']!, mismatched(''))).statusCode).toBe(404);
    });

    it("a caller scoped to the order's own branch succeeds", async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const res = await complete(tok['branchA']!, o, payNow());
      expect(res.statusCode, res.payload).toBe(200);
    });

    it("a customer with NO account at the order's company (their account is at another company) → non-disclosing 404, nothing leaks, zero mutation", async () => {
      const elsewhere = await mkCustomerElsewhere(aed2);
      const o = await mkOrder(aed, elsewhere, one(10_000n));
      const before = await snapshot();
      const res = await complete(tok['cashier']!, o, body({ intent: 'ON_CREDIT' }));
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND');
      expect(res.payload).not.toContain(aed2.companyId);
      expect(await snapshot()).toEqual(before);
    });

    it("a FOREIGN advance — another customer's, or a sibling branch's — is the same 404 CUSTOMER_ADVANCE_NOT_FOUND, zero mutation", async () => {
      const mine = await mkCustomer(aed);
      const theirs = await mkCustomer(aed);
      const theirAdvance = await mkAdvance(theirs, 4_000n);
      const siblingAdvance = await mkAdvance(mine, 4_000n, aed.siblingBranchId);
      for (const advanceId of [theirAdvance, siblingAdvance]) {
        const o = await mkOrder(aed, mine.customerId, one(10_000n));
        await expectRejection(
          () =>
            complete(
              tok['manager']!,
              o,
              body({ tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] }),
            ),
          404,
          'CUSTOMER_ADVANCE_NOT_FOUND',
          o,
        );
      }
    });

    it('TERMINAL attribution spoofing: a session bound to a terminal still sells under the ROUTE branch; the terminal is never an isolation boundary or a body input', async () => {
      const terminalId = randomUUID();
      await pool.query(
        `INSERT INTO pos_terminal (id,"tenantId","companyId","branchId",code,name,"updatedAt")
         VALUES ($1,$2,$3,$4,'POS-E','POS E',now())`,
        [terminalId, tenantId, aed.companyId, aed.branchId],
      );
      const posUser = await mint('pos-user', rolePerms('cashier'), {
        branchScope: [aed.branchId],
        posTerminalId: terminalId,
      });
      const o = await mkOrder(aed, null, one(10_000n));
      // a body terminal is refused outright…
      await expectRejection(
        () =>
          complete(
            posUser,
            o,
            body({ tenders: [cash(TOTAL)], extra: { terminalId: randomUUID() } }),
          ),
        400,
        'VALIDATION_FAILED',
        o,
      );
      // …and the terminal-bound session sells normally, scoped by the route branch
      const res = await complete(posUser, o, payNow());
      expect(res.statusCode, res.payload).toBe(200);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 8. orders.sale_completed — one coarse, bounded, scoped event, co-committed
  // ═════════════════════════════════════════════════════════════════════════════
  describe('orders.sale_completed', () => {
    it('the FIRST success writes exactly one event: right scope (tenant + company + branch), bounded payload, the post-issuance order version; the frozen payments.* events are preserved', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(
        tok['cashier']!,
        o,
        body({ tenders: [cash(5_000n), bank(5_500n)] }),
      );
      expect(res.statusCode, res.payload).toBe(200);
      const events = await saleEvents(o.orderId);
      expect(events).toHaveLength(1);
      const e = events[0]!;
      expect(e).toMatchObject({
        eventType: 'orders.sale_completed',
        aggregateType: 'order',
        aggregateId: o.orderId,
        tenantId,
        companyId: aed.companyId,
        branchId: aed.branchId,
        rv: String(o.version + 1), // the order's version AFTER the issuance transition
      });
      // BOUNDED: identifiers only — no Money, customer data, lines, payment / credential / journal / advance detail
      expect(e.payload).toEqual({ orderId: o.orderId, invoiceId: res.json().invoice.id });
      expect(JSON.stringify(e.payload)).not.toContain(c.customerId);

      // the frozen payments.payment_recorded events still emit naturally — one per tender, unchanged
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM outbox WHERE "tenantId" = $1 AND "eventType" = 'payments.payment_recorded' AND payload->>'invoiceId' = $2`,
          [tenantId, res.json().invoice.id],
        ),
      ).toBe(2);
    });

    it('an ANONYMOUS sale emits the same single event', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const res = await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }));
      expect(res.statusCode).toBe(200);
      expect(await saleEvents(o.orderId)).toHaveLength(1);
    });

    it('a rejected or rolled-back sale leaves NO event', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL - 1n)] })); // 422
      await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), { ifMatch: 99 }); // 409
      expect(await saleEvents(o.orderId)).toHaveLength(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 9. the read-only canonical totals preview
  // ═════════════════════════════════════════════════════════════════════════════
  describe('GET totals — the read-only canonical preview', () => {
    it('returns the order id + version + exact totals (money as strings) — exactly the frozen Checkpoint-A wire shape', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const res = await getJson(tok['viewer']!, orderUrl(o, '/totals'));
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json()).toEqual({
        orderId: o.orderId,
        version: 1,
        currencyCode: 'AED',
        currencyExponent: 2,
        priceTaxMode: 'TAX_EXCLUSIVE',
        subtotalAmountMinor: '10000',
        documentDiscountAmountMinor: '0',
        taxTotalAmountMinor: '500',
        totalAmountMinor: '10500',
      });
    });

    it('NEVER takes or waits on an order lock: a preview returns promptly even while another transaction holds the order row FOR UPDATE', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM "order" WHERE id = $1 FOR UPDATE`, [o.orderId]);
        const raced = await Promise.race([
          getJson(tok['viewer']!, orderUrl(o, '/totals')).then((r) => ({ timedOut: false, r })),
          new Promise<{ timedOut: true }>((resolve) =>
            setTimeout(() => resolve({ timedOut: true }), 4_000),
          ),
        ]);
        expect(raced.timedOut).toBe(false);
        if (!raced.timedOut) expect(raced.r.statusCode).toBe(200);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    }, 30_000);

    it('is READ-ONLY: no invoice, no number, no payment, no journal, no audit, no outbox, no lock-visible change', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const before = await snapshot();
      for (let i = 0; i < 3; i += 1) {
        expect((await getJson(tok['viewer']!, orderUrl(o, '/totals'))).statusCode).toBe(200);
      }
      expect(await snapshot()).toEqual(before);
      expect(await invoiceOf(o.orderId)).toBeNull();
    });

    it('EQUIVALENCE: the preview equals what finalization freezes — exclusive, inclusive, fractional quantities, line discounts, an untaxed line, KWD (3 decimals)', async () => {
      const cases: [string, Co, OrderSpec][] = [
        ['simple exclusive', aed, one(10_000n)],
        [
          'multi-line, fractional quantities, line discount, untaxed line',
          aed,
          {
            lines: [
              {
                quantity: '2.5000',
                unitPriceAmountMinor: 1_234n,
                discountAmountMinor: 100n,
                rateBps: 500,
              },
              { quantity: '0.3333', unitPriceAmountMinor: 999n, rateBps: 500 },
              { quantity: '1.0000', unitPriceAmountMinor: 5_000n, rateBps: null },
            ],
          },
        ],
        [
          'tax-inclusive',
          aed,
          {
            taxPriceMode: 'TAX_INCLUSIVE',
            lines: [
              { quantity: '3.0000', unitPriceAmountMinor: 1_050n, rateBps: 500 },
              {
                quantity: '1.5000',
                unitPriceAmountMinor: 777n,
                discountAmountMinor: 50n,
                rateBps: 500,
              },
            ],
          },
        ],
        [
          'KWD three-decimal',
          kwd,
          { lines: [{ quantity: '1.7500', unitPriceAmountMinor: 12_345n, rateBps: 500 }] },
        ],
      ];
      for (const [label, co, spec] of cases) {
        const o = await mkOrder(co, null, spec);
        const preview = (await getJson(tok['viewer']!, orderUrl(o, '/totals'))).json();
        const sold = await complete(
          tok['cashier']!,
          o,
          body({ tenders: [cash(BigInt(preview.totalAmountMinor))] }),
          { ifMatch: preview.version },
        );
        expect(sold.statusCode, `${label}: ${sold.payload}`).toBe(200);
        const inv = sold.json().invoice;
        expect(inv.subtotalAmountMinor, label).toBe(preview.subtotalAmountMinor);
        expect(inv.documentDiscountAmountMinor, label).toBe(preview.documentDiscountAmountMinor);
        expect(inv.taxTotalAmountMinor, label).toBe(preview.taxTotalAmountMinor);
        expect(inv.totalAmountMinor, label).toBe(preview.totalAmountMinor);
        expect(inv.currencyCode, label).toBe(preview.currencyCode);
        // and, once issued, a preview of the (frozen) lines still agrees with the invoice
        const after = (await getJson(tok['viewer']!, orderUrl(o, '/totals'))).json();
        expect(after.totalAmountMinor, label).toBe(inv.totalAmountMinor);
      }
    });

    it('VERSION-BOUND: a preview of version N does not authorize a sale after the order moved to N+1 (If-Match N → 409), and the new preview reports N+1', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const old = (await getJson(tok['viewer']!, orderUrl(o, '/totals'))).json();
      expect(old.version).toBe(1);
      // the order is edited elsewhere: a line price changes and the version moves to 2
      await pool.query(
        `UPDATE order_line SET "unitPriceAmountMinor" = 20000 WHERE "orderId" = $1`,
        [o.orderId],
      );
      await pool.query(`UPDATE "order" SET version = version + 1 WHERE id = $1`, [o.orderId]);
      const fresh = (await getJson(tok['viewer']!, orderUrl(o, '/totals'))).json();
      expect(fresh.version).toBe(2);
      expect(fresh.totalAmountMinor).toBe('21000');
      expect(fresh.totalAmountMinor).not.toBe(old.totalAmountMinor);
      // acting on the OLD preview's version is refused; nothing is frozen from it
      await expectRejection(
        () =>
          complete(tok['cashier']!, o, body({ tenders: [cash(BigInt(old.totalAmountMinor))] }), {
            ifMatch: old.version,
          }),
        409,
        'ORDER_VERSION_CONFLICT',
        o,
      );
    });

    it('is scoped: a sibling-branch / foreign-company / foreign-tenant order is a non-disclosing 404, and a caller without orders:view is 403', async () => {
      const o = await mkOrder(aed, null, one(10_000n), aed.siblingBranchId);
      const wrongBranch = await getJson(
        tok['cashier']!,
        `/v1/companies/${aed.companyId}/branches/${aed.branchId}/orders/${o.orderId}/totals`,
      );
      expect(wrongBranch.statusCode).toBe(404);
      const wrongCompany = await getJson(
        tok['cashier']!,
        `/v1/companies/${aed2.companyId}/branches/${aed2.branchId}/orders/${o.orderId}/totals`,
      );
      expect(wrongCompany.statusCode).toBe(404);
      const own = await mkOrder(aed, null, one(10_000n));
      const foreignTenant = await getJson(tok['otherTenant']!, orderUrl(own, '/totals'));
      expect(foreignTenant.statusCode).toBe(404);
      const noPerm = await getJson(tok['ordersOnly']!, orderUrl(own, '/totals'));
      expect(noPerm.statusCode).toBe(403);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 10. the additive issued-invoice recovery read on Order GET
  // ═════════════════════════════════════════════════════════════════════════════
  describe('Order GET — the additive issuedInvoice recovery summary', () => {
    it('is null while there is no issued invoice, and the existing order + lines are unchanged', async () => {
      const o = await mkOrder(aed, null, one(10_000n));
      const res = await getJson(tok['viewer']!, orderUrl(o));
      expect(res.statusCode, res.payload).toBe(200);
      const b = res.json();
      expect(b.issuedInvoice).toBeNull();
      expect(b.order.id).toBe(o.orderId);
      expect(b.lines).toHaveLength(1);
    });

    it('after the sale it carries EXACTLY the frozen five fields, read from the invoice row — for an anonymous and a credit sale', async () => {
      const anon = await mkOrder(aed, null, one(10_000n));
      const sold = await complete(tok['cashier']!, anon, body({ tenders: [cash(TOTAL)] }));
      const inv = (await invoiceOf(anon.orderId))!;
      const read = (await getJson(tok['viewer']!, orderUrl(anon))).json();
      expect(Object.keys(read.issuedInvoice).sort()).toEqual([
        'invoiceDate',
        'invoiceId',
        'invoiceNumber',
        'invoicePaymentStatus',
        'totalAmountMinor',
      ]);
      expect(read.issuedInvoice).toEqual({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.date,
        totalAmountMinor: inv.total,
        invoicePaymentStatus: inv.status,
      });
      expect(read.issuedInvoice.invoiceId).toBe(sold.json().invoice.id);

      const c = await mkCustomer(aed);
      const credit = await mkOrder(aed, c.customerId, one(10_000n));
      await complete(
        tok['cashier']!,
        credit,
        body({ intent: 'ON_CREDIT', tenders: [cash(2_000n)] }),
      );
      const readCredit = (await getJson(tok['viewer']!, orderUrl(credit))).json();
      expect(readCredit.issuedInvoice.invoicePaymentStatus).toBe('PARTIAL');
      expect(readCredit.issuedInvoice.totalAmountMinor).toBe('10500');
    });

    it('is scoped like the order read: a sibling-branch order is a 404, with no invoice data', async () => {
      const o = await mkOrder(aed, null, one(10_000n), aed.siblingBranchId);
      await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }), {
        url: `/v1/companies/${aed.companyId}/branches/${aed.siblingBranchId}/orders/${o.orderId}/complete-sale`,
      });
      const wrong = await getJson(
        tok['cashier']!,
        `/v1/companies/${aed.companyId}/branches/${aed.branchId}/orders/${o.orderId}`,
      );
      expect(wrong.statusCode).toBe(404);
      expect(wrong.payload).not.toContain('invoiceNumber');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // CHECKPOINT F — FINAL HARD GATES, over the PUBLIC HTTP surface, on the integrated tree.
  // (Tests only: nothing here redesigns an A–E behaviour — it pins and re-proves them.)
  // ═════════════════════════════════════════════════════════════════════════════
  describe('F — final hard gates (public HTTP, real PostgreSQL, real stack)', () => {
    const card = (n: bigint) => ({ method: 'CARD_TERMINAL', amountMinor: n.toString() });
    const other = (n: bigint) => ({ method: 'OTHER_MANUAL', amountMinor: n.toString() });
    const ACCOUNT_OF: Record<string, string> = {
      CASH: 'ASSET.CASH_ON_HAND',
      BANK_TRANSFER: 'ASSET.BANK',
      CARD_TERMINAL: 'ASSET.PAYMENT_CLEARING',
      OTHER_MANUAL: 'ASSET.PAYMENT_CLEARING',
    };

    /** every journal booked by THIS sale, each as { kind, lines: {key → net debit} } */
    async function journalsOfSale(invoiceId: string) {
      const pays = await q<{ paymentId: string; allocationId: string }>(
        `SELECT p.id AS "paymentId", pa.id AS "allocationId"
           FROM payment_allocation pa JOIN payment p ON p.id = pa."paymentId"
          WHERE pa."invoiceId" = $1`,
        [invoiceId],
      );
      const apps = await q<{ id: string }>(
        `SELECT caa.id FROM customer_advance_application caa
           JOIN customer_receivable cr ON cr.id = caa."customerReceivableId"
          WHERE cr."invoiceId" = $1`,
        [invoiceId],
      );
      const ids = [
        invoiceId,
        ...pays.map((p) => p.paymentId),
        ...pays.map((p) => p.allocationId),
        ...apps.map((a) => a.id),
      ];
      const entries = await q<{ id: string; sourceKind: string }>(
        `SELECT id, "sourceKind" FROM journal_entry WHERE "tenantId" = $1 AND "sourceId" = ANY($2::text[])`,
        [tenantId, ids],
      );
      const out: { kind: string; net: Record<string, bigint>; debit: bigint; credit: bigint }[] =
        [];
      for (const e of entries) {
        const lines = await q<{ key: string; d: string; c: string }>(
          `SELECT a."key" AS key, jl."debitMinor"::text AS d, jl."creditMinor"::text AS c
             FROM journal_line jl JOIN account a ON a.id = jl."accountId" WHERE jl."journalEntryId" = $1`,
          [e.id],
        );
        const net: Record<string, bigint> = {};
        let debit = 0n;
        let credit = 0n;
        for (const l of lines) {
          net[l.key] = (net[l.key] ?? 0n) + BigInt(l.d) - BigInt(l.c);
          debit += BigInt(l.d);
          credit += BigInt(l.c);
        }
        out.push({ kind: e.sourceKind, net, debit, credit });
      }
      return out;
    }
    const sumNet = (js: { net: Record<string, bigint> }[], key: string): bigint =>
      js.reduce((a, j) => a + (j.net[key] ?? 0n), 0n);
    const accountOf = async (ccaId: string) => {
      const r = (
        await q<{ o: string; a: string }>(
          `SELECT "currentOutstandingMinor"::text AS o, "advanceBalanceMinor"::text AS a
             FROM customer_company_account WHERE id = $1`,
          [ccaId],
        )
      )[0]!;
      return { outstanding: BigInt(r.o), advance: BigInt(r.a) };
    };
    const noAnonymousCustomerEffects = async (invoiceId: string): Promise<void> => {
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        ),
      ).toBe(0);
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM customer_account_entry cae
             JOIN customer_receivable cr ON cr.id = cae."customerReceivableId" WHERE cr."invoiceId" = $1`,
          [invoiceId],
        ),
      ).toBe(0);
    };

    // ── ANONYMOUS financial matrix ────────────────────────────────────────────
    const ANON: [string, unknown[], string][] = [
      ['CASH', [cash(TOTAL)], 'SETTLED'],
      ['BANK_TRANSFER', [bank(TOTAL)], 'SETTLED'],
      ['manual CARD_TERMINAL', [card(TOTAL)], 'PAID'],
      ['OTHER_MANUAL', [other(TOTAL)], 'PAID'],
      [
        'Multi Payment (cash + bank + manual card)',
        [cash(4_000n), bank(3_500n), card(3_000n)],
        'PAID',
      ],
    ];
    it.each(ANON)(
      'ANONYMOUS %s: exactly ONE walk_in_sale journal (balanced, exact), no AR / customer-account effect, status %s derived',
      async (_label, tenders, status) => {
        const o = await mkOrder(aed, null, one(10_000n));
        const res = await complete(tok['cashier']!, o, body({ tenders }));
        expect(res.statusCode, res.payload).toBe(200);
        const b = res.json();
        expect(b.invoice.paymentStatus).toBe(status);
        expect(b.outstandingMinor).toBe('0');
        const js = await journalsOfSale(b.invoice.id);
        expect(js.map((j) => j.kind)).toEqual(['walk_in_sale']); // exactly ONE journal, no receipt / allocation journal
        const j = js[0]!;
        expect(j.debit).toBe(j.credit); // balanced
        expect(j.debit).toBe(TOTAL);
        expect(j.net['REVENUE.SALES']).toBe(-10_000n);
        expect(j.net['LIABILITY.TAX_PAYABLE']).toBe(-500n);
        const expectedDebit: Record<string, bigint> = {};
        for (const t of tenders as { method: string; amountMinor: string }[]) {
          const k = ACCOUNT_OF[t.method]!;
          expectedDebit[k] = (expectedDebit[k] ?? 0n) + BigInt(t.amountMinor);
        }
        for (const [k, v] of Object.entries(expectedDebit)) expect(j.net[k], k).toBe(v);
        await noAnonymousCustomerEffects(b.invoice.id);
        // PAID is NOT SETTLED: local-slip value is `PAID`; only cash / bank are `SETTLED`
        if (status === 'PAID') expect(b.invoice.paymentStatus).not.toBe('SETTLED');
      },
    );

    it('ANONYMOUS in a 3-DECIMAL currency (KWD) and in TAX-INCLUSIVE mode with line discounts: exact Money, one balanced journal', async () => {
      const cases: [string, Co, OrderSpec, string][] = [
        [
          'KWD exclusive',
          kwd,
          { lines: [{ quantity: '1.7500', unitPriceAmountMinor: 12_345n, rateBps: 500 }] },
          'CASH',
        ],
        [
          'AED inclusive + discounts',
          aed,
          {
            taxPriceMode: 'TAX_INCLUSIVE',
            lines: [
              { quantity: '3.0000', unitPriceAmountMinor: 1_050n, rateBps: 500 },
              {
                quantity: '1.5000',
                unitPriceAmountMinor: 777n,
                discountAmountMinor: 50n,
                rateBps: 500,
              },
            ],
          },
          'BANK_TRANSFER',
        ],
        [
          'AED exclusive, fractional + line discount + untaxed line',
          aed,
          {
            lines: [
              {
                quantity: '2.5000',
                unitPriceAmountMinor: 1_234n,
                discountAmountMinor: 100n,
                rateBps: 500,
              },
              { quantity: '0.3333', unitPriceAmountMinor: 999n, rateBps: 500 },
              { quantity: '1.0000', unitPriceAmountMinor: 5_000n, rateBps: null },
            ],
          },
          'CASH',
        ],
      ];
      for (const [label, co, spec, method] of cases) {
        const o = await mkOrder(co, null, spec);
        const preview = (await getJson(tok['viewer']!, orderUrl(o, '/totals'))).json();
        const total = BigInt(preview.totalAmountMinor);
        const tax = BigInt(preview.taxTotalAmountMinor);
        const res = await complete(
          tok['cashier']!,
          o,
          body({ tenders: [{ method, amountMinor: total.toString() }] }),
          { ifMatch: preview.version },
        );
        expect(res.statusCode, `${label}: ${res.payload}`).toBe(200);
        const b = res.json();
        expect(b.invoice.totalAmountMinor, label).toBe(total.toString());
        expect(b.invoice.currencyExponent, label).toBe(co.exponent);
        const js = await journalsOfSale(b.invoice.id);
        expect(
          js.map((j) => j.kind),
          label,
        ).toEqual(['walk_in_sale']);
        expect(js[0]!.debit, label).toBe(js[0]!.credit);
        expect(js[0]!.net[ACCOUNT_OF[method]!], label).toBe(total);
        expect(js[0]!.net['LIABILITY.TAX_PAYABLE'] ?? 0n, label).toBe(-tax);
        expect(js[0]!.net['REVENUE.SALES'], label).toBe(-(total - tax));
      }
    });

    // ── CUSTOMER financial matrix ─────────────────────────────────────────────
    interface CCase {
      name: string;
      intent: 'PAY_NOW' | 'ON_CREDIT';
      tenders: { method: string; amountMinor: bigint }[];
      advances: bigint[];
      status: string;
    }
    const CUST: CCase[] = [
      {
        name: 'PAY_NOW cash',
        intent: 'PAY_NOW',
        tenders: [{ method: 'CASH', amountMinor: TOTAL }],
        advances: [],
        status: 'SETTLED',
      },
      {
        name: 'PAY_NOW manual card',
        intent: 'PAY_NOW',
        tenders: [{ method: 'CARD_TERMINAL', amountMinor: TOTAL }],
        advances: [],
        status: 'PAID',
      },
      {
        name: 'advance-only PAY_NOW',
        intent: 'PAY_NOW',
        tenders: [],
        advances: [TOTAL],
        status: 'SETTLED',
      },
      {
        name: 'tender + advance PAY_NOW',
        intent: 'PAY_NOW',
        tenders: [{ method: 'CASH', amountMinor: 6_500n }],
        advances: [4_000n],
        status: 'SETTLED',
      },
      { name: 'full ON_CREDIT', intent: 'ON_CREDIT', tenders: [], advances: [], status: 'UNPAID' },
      {
        name: 'tender + credit',
        intent: 'ON_CREDIT',
        tenders: [{ method: 'CASH', amountMinor: 2_000n }],
        advances: [],
        status: 'PARTIAL',
      },
      {
        name: 'advance + credit',
        intent: 'ON_CREDIT',
        tenders: [],
        advances: [3_000n],
        status: 'PARTIAL',
      },
      {
        name: 'tender + advance + credit',
        intent: 'ON_CREDIT',
        tenders: [{ method: 'CASH', amountMinor: 2_500n }],
        advances: [3_000n],
        status: 'PARTIAL',
      },
    ];
    it.each(CUST.map((c) => [c.name, c] as const))(
      'CUSTOMER %s: NO walk_in_sale journal; exactly the frozen invoice-AR / receipt / allocation / advance journals; the receivable and the account end exactly right',
      async (_n, cs) => {
        const c = await mkCustomer(aed, { enabled: true, limit: 50_000n });
        const advances: { id: string; amount: bigint }[] = [];
        for (const amount of cs.advances) advances.push({ id: await mkAdvance(c, amount), amount });
        const before = await accountOf(c.ccaId);
        const o = await mkOrder(aed, c.customerId, one(10_000n));
        const res = await complete(
          tok['manager']!,
          o,
          body({
            intent: cs.intent,
            tenders: cs.tenders.map((t) => ({
              method: t.method,
              amountMinor: t.amountMinor.toString(),
            })),
            advances: advances.map((a) => adv(a.id, a.amount)),
          }),
        );
        expect(res.statusCode, res.payload).toBe(200);
        const b = res.json();
        const tenderSum = cs.tenders.reduce((n, t) => n + t.amountMinor, 0n);
        const advSum = cs.advances.reduce((n, a) => n + a, 0n);
        const remainder = TOTAL - tenderSum - advSum; // the FINAL sale outstanding
        expect(b.invoice.paymentStatus).toBe(cs.status);
        expect(b.outstandingMinor).toBe(remainder.toString());
        if (cs.status === 'PAID') expect(b.invoice.paymentStatus).not.toBe('SETTLED');

        const js = await journalsOfSale(b.invoice.id);
        const kinds = js.map((j) => j.kind).sort();
        expect(kinds.includes('walk_in_sale')).toBe(false);
        expect(kinds).toEqual(
          [
            'invoice_ar',
            ...cs.tenders.flatMap(() => ['customer_receipt_payment', 'payment_allocation']),
            ...cs.advances.map(() => 'customer_advance_application'),
          ].sort(),
        );
        for (const j of js) expect(j.debit, j.kind).toBe(j.credit); // every journal balanced
        // the books agree with the receivable: AR nets to the remainder, every receipt was allocated
        expect(sumNet(js, 'ASSET.ACCOUNTS_RECEIVABLE')).toBe(remainder);
        expect(sumNet(js, 'LIABILITY.UNAPPLIED_RECEIPTS')).toBe(0n);
        expect(js.find((j) => j.kind === 'invoice_ar')!.net['ASSET.ACCOUNTS_RECEIVABLE']).toBe(
          TOTAL,
        );
        expect(sumNet(js, 'LIABILITY.CUSTOMER_ADVANCES')).toBe(advSum);
        for (const t of cs.tenders) {
          expect(sumNet(js, ACCOUNT_OF[t.method]!), t.method).toBe(t.amountMinor);
        }
        // the corrected credit exposure: the account carries EXACTLY the sale's final outstanding
        const after = await accountOf(c.ccaId);
        expect(after.outstanding - before.outstanding).toBe(remainder);
        expect(before.advance - after.advance).toBe(advSum);
        // credit is never a Payment
        const methods = await q<{ method: string }>(
          `SELECT p.method FROM payment_allocation pa JOIN payment p ON p.id = pa."paymentId" WHERE pa."invoiceId" = $1`,
          [b.invoice.id],
        );
        expect(methods.map((m) => m.method).sort()).toEqual(cs.tenders.map((t) => t.method).sort());
      },
    );

    it('CUSTOMER authorized credit-limit OVERRIDE: the exposure beyond the limit is booked exactly, audited once, still only the frozen journals', async () => {
      const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const res = await complete(
        tok['owner']!,
        o,
        body({
          intent: 'ON_CREDIT',
          tenders: [cash(2_000n)],
          reason: 'owner approved the exception',
        }),
      );
      expect(res.statusCode, res.payload).toBe(200);
      const js = await journalsOfSale(res.json().invoice.id);
      expect(js.map((j) => j.kind).sort()).toEqual(
        ['customer_receipt_payment', 'invoice_ar', 'payment_allocation'].sort(),
      );
      expect(sumNet(js, 'ASSET.ACCOUNTS_RECEIVABLE')).toBe(8_500n);
      expect((await accountOf(c.ccaId)).outstanding).toBe(8_500n);
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 AND action = 'credit_limit.override_used' AND "resourceId" = $2`,
          [tenantId, c.ccaId],
        ),
      ).toBe(1);
    });

    it('CORRECTED credit exposure over HTTP: existing + FINAL outstanding is tested — exactly at the limit passes, one minor unit over is a 409 (never the gross invoice total)', async () => {
      const pass = await mkCustomer(aed, { enabled: true, limit: 3_500n });
      const o1 = await mkOrder(aed, pass.customerId, one(10_000n));
      const ok = await complete(
        tok['cashier']!,
        o1,
        body({ intent: 'ON_CREDIT', tenders: [cash(7_000n)] }),
      );
      expect(ok.statusCode, ok.payload).toBe(200);
      expect((await accountOf(pass.ccaId)).outstanding).toBe(3_500n);
      const over = await mkCustomer(aed, { enabled: true, limit: 3_499n });
      const o2 = await mkOrder(aed, over.customerId, one(10_000n));
      await expectRejection(
        () => complete(tok['cashier']!, o2, body({ intent: 'ON_CREDIT', tenders: [cash(7_000n)] })),
        409,
        'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        o2,
      );
    });

    // ── idempotency: the TTL-expired / new-request behaviour (owner ruling) ────
    it('TTL EXPIRY: once the stored key has expired the same request is a NEW request — the already-completed order prevents a double sale, and issuedInvoice is the recovery', async () => {
      const c = await mkCustomer(aed);
      const o = await mkOrder(aed, c.customerId, one(10_000n));
      const key = ik();
      const b = body({ tenders: [cash(TOTAL)] });
      const first = await complete(tok['cashier']!, o, b, { key });
      expect(first.statusCode, first.payload).toBe(200);
      // the idempotency record's TTL elapses
      await pool.query(
        `UPDATE idempotency_key SET "expiresAt" = now() - interval '1 second' WHERE "tenantId" = $1 AND key = $2`,
        [tenantId, key],
      );
      const effects = async () => ({
        invoices: await countWhere(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
          o.orderId,
        ]),
        payments: await countWhere(
          `SELECT count(*)::int AS n FROM payment_allocation pa JOIN invoice i ON i.id = pa."invoiceId" WHERE i."orderId" = $1`,
          [o.orderId],
        ),
        events: (await saleEvents(o.orderId)).length,
        journals: (await journalsOfSale(first.json().invoice.id)).length,
      });
      const before = await effects();
      const s = spyAll();
      const again = await complete(tok['cashier']!, o, b, { key });
      expect(again.headers['idempotency-replayed']).toBeUndefined(); // NOT a replay: a new request
      expect(again.statusCode).toBe(409);
      expect(errCode(again)).toBe('ORDER_INVALID_STATE_TRANSITION');
      expect(s.sale).toHaveBeenCalledTimes(1); // it genuinely re-executed (and was refused by the order state)
      expect(s.issue).not.toHaveBeenCalled();
      expect(s.capture).not.toHaveBeenCalled();
      expect(s.journal).not.toHaveBeenCalled();
      expect(await effects()).toEqual(before); // exactly one economic sale remains
      const read = await getJson(tok['cashier']!, orderUrl(o));
      expect(read.json().issuedInvoice.invoiceId).toBe(first.json().invoice.id);
    });

    // ── true duplicate submits (DISTINCT keys, so the idempotency layer cannot dedupe) ──
    async function oneEconomicSale(o: MadeOrder, expectedJournals: number): Promise<void> {
      const inv = (await invoiceOf(o.orderId))!;
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [
          o.orderId,
        ]),
      ).toBe(1);
      expect((await journalsOfSale(inv.id)).length).toBe(expectedJournals);
      expect((await saleEvents(o.orderId)).length).toBe(1);
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
          [inv.id],
        ),
      ).toBe(
        await countWhere(
          `SELECT count(*)::int AS n FROM payment_allocation WHERE "invoiceId" = $1`,
          [inv.id],
        ),
      );
    }
    const noDeadlockNo500 = (rs: { statusCode: number; payload: string }[]): void => {
      for (const r of rs) {
        expect([200, 409, 404]).toContain(r.statusCode);
        expect(r.payload).not.toMatch(/40P01|deadlock/i);
      }
    };

    it('DUPLICATE completions with DISTINCT keys — anonymous, customer PAY_NOW, ON_CREDIT and advance-involved: exactly one sale, one of each effect, clean 409 losers', async () => {
      const dup = async (
        o: MadeOrder,
        b: Record<string, unknown>,
        token: string,
        journals: number,
      ) => {
        const rs = await Promise.all(Array.from({ length: 6 }, () => complete(token, o, b)));
        expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
        noDeadlockNo500(rs);
        for (const r of rs.filter((x) => x.statusCode !== 200)) {
          expect(['ORDER_INVALID_STATE_TRANSITION', 'ORDER_VERSION_CONFLICT']).toContain(
            errCode(r),
          );
        }
        await oneEconomicSale(o, journals);
      };
      await dup(
        await mkOrder(aed, null, one(10_000n)),
        body({ tenders: [cash(5_000n), bank(5_500n)] }),
        tok['cashier']!,
        1,
      );
      const c1 = await mkCustomer(aed);
      await dup(
        await mkOrder(aed, c1.customerId, one(10_000n)),
        body({ tenders: [cash(TOTAL)] }),
        tok['cashier']!,
        3,
      );
      const c2 = await mkCustomer(aed);
      await dup(
        await mkOrder(aed, c2.customerId, one(10_000n)),
        body({ intent: 'ON_CREDIT', tenders: [cash(2_000n)] }),
        tok['cashier']!,
        3,
      );
      const c3 = await mkCustomer(aed);
      const advanceId = await mkAdvance(c3, 20_000n);
      await dup(
        await mkOrder(aed, c3.customerId, one(10_000n)),
        body({ tenders: [cash(8_500n)], advances: [adv(advanceId, 2_000n)] }),
        tok['manager']!,
        4,
      );
      // the advance was spent exactly once
      expect((await accountOf(c3.ccaId)).advance).toBe(18_000n);
    }, 120_000);

    it('ADVANCE DOUBLE-SPEND over HTTP: two sales each wanting 4 000 of one 5 000 advance — exactly one wins, the balance never goes negative, the loser is a clean 409', async () => {
      for (let round = 0; round < 3; round += 1) {
        const c = await mkCustomer(aed);
        const advanceId = await mkAdvance(c, 5_000n);
        const a = await mkOrder(aed, c.customerId, one(10_000n));
        const b2 = await mkOrder(aed, c.customerId, one(10_000n));
        const payload = body({ tenders: [cash(6_500n)], advances: [adv(advanceId, 4_000n)] });
        const rs = await Promise.all([
          complete(tok['manager']!, a, payload),
          complete(tok['manager']!, b2, payload),
        ]);
        expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
        noDeadlockNo500(rs);
        const loser = rs.find((r) => r.statusCode !== 200)!;
        expect(errCode(loser)).toBe('CUSTOMER_ADVANCE_APPLICATION_INVALID');
        const acc = await accountOf(c.ccaId);
        expect(acc.advance).toBe(1_000n);
        expect(acc.advance >= 0n).toBe(true);
      }
    }, 120_000);

    it('CONCURRENT CREDIT EXPOSURE over HTTP — 500 + 500 against a 1 000 limit: both succeed; 600 + 600: exactly one, the committed outstanding never exceeds the limit', async () => {
      const untaxed = (price: bigint): OrderSpec => one(price, null);
      for (const [cashEach, expectBoth] of [
        [300n, true],
        [200n, false],
      ] as const) {
        for (let round = 0; round < 3; round += 1) {
          const c = await mkCustomer(aed, { enabled: true, limit: 1_000n });
          const orders = [
            await mkOrder(aed, c.customerId, untaxed(800n)),
            await mkOrder(aed, c.customerId, untaxed(800n)),
          ];
          const rs = await Promise.all(
            orders.map((o) =>
              complete(
                tok['cashier']!,
                o,
                body({ intent: 'ON_CREDIT', tenders: [cash(cashEach)] }),
              ),
            ),
          );
          noDeadlockNo500(rs);
          const ok = rs.filter((r) => r.statusCode === 200);
          expect(ok).toHaveLength(expectBoth ? 2 : 1);
          if (!expectBoth) {
            expect(errCode(rs.find((r) => r.statusCode !== 200)!)).toBe(
              'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
            );
          }
          const outstanding = (await accountOf(c.ccaId)).outstanding;
          expect(outstanding).toBe(expectBoth ? 1_000n : 600n);
          expect(outstanding <= 1_000n).toBe(true); // never exceeded without an authorized override
        }
      }
    }, 180_000);

    it('CANCEL vs COMPLETE over HTTP — a DRAFT order raced by the cancel route and complete-sale: exactly one wins, never a partial state, the loser is a clean 409, no deadlock', async () => {
      const cancel = (o: MadeOrder) =>
        app.inject({
          method: 'POST',
          url: orderUrl(o, '/cancel'),
          headers: {
            authorization: `Bearer ${tok['owner']!}`,
            'if-match': String(o.version),
          },
          payload: { reason: 'customer changed their mind' },
        });
      let saleWins = 0;
      let cancelWins = 0;
      for (let round = 0; round < 8; round += 1) {
        const c = await mkCustomer(aed);
        const o = await mkOrder(aed, round % 2 === 0 ? null : c.customerId, one(10_000n));
        const [sale, cancelled] = await Promise.all([
          complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] })),
          cancel(o),
        ]);
        noDeadlockNo500([sale, cancelled]);
        expect([sale.statusCode, cancelled.statusCode].filter((s) => s === 200)).toHaveLength(1);
        const st = await orderState(o.orderId);
        const inv = await invoiceOf(o.orderId);
        if (sale.statusCode === 200) {
          saleWins += 1;
          expect(st.status).toBe('CONFIRMED');
          expect(inv).not.toBeNull();
          expect(cancelled.statusCode).toBe(409);
          expect(['ORDER_VERSION_CONFLICT', 'ORDER_INVALID_STATE_TRANSITION']).toContain(
            errCode(cancelled),
          );
          expect((await saleEvents(o.orderId)).length).toBe(1);
        } else {
          cancelWins += 1;
          expect(st.status).toBe('CANCELLED');
          expect(inv).toBeNull(); // no invoice, no payment, no number burned
          expect(sale.statusCode).toBe(409);
          expect(errCode(sale)).toBe('ORDER_INVALID_STATE_TRANSITION');
          expect((await saleEvents(o.orderId)).length).toBe(0);
          expect(
            await countWhere(
              `SELECT count(*)::int AS n FROM payment_attempt WHERE "orderId" = $1`,
              [o.orderId],
            ),
          ).toBe(0);
        }
      }
      expect(saleWins + cancelWins).toBe(8);
    }, 180_000);

    it('NUMBERING over HTTP — concurrent sales of ONE company get contiguous, unique, gapless numbers; four companies in parallel number independently; a rolled-back sale leaves no gap', async () => {
      const num = (s: string): number => Number(s.replace(/\D+/g, ''));
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const orders = await Promise.all(
        Array.from({ length: 6 }, () => mkOrder(co, null, one(10_000n))),
      );
      const rs = await Promise.all(
        orders.map((o) => complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] }))),
      );
      expect(rs.every((r) => r.statusCode === 200)).toBe(true);
      const nums = rs.map((r) => num(r.json().invoice.invoiceNumber)).sort((a, b) => a - b);
      expect(new Set(nums).size).toBe(6);
      expect(nums[5]! - nums[0]!).toBe(5); // contiguous
      const orderNums = rs.map((r) => num(r.json().order.orderNumber)).sort((a, b) => a - b);
      expect(orderNums[5]! - orderNums[0]!).toBe(5);

      // a late failure rolls the numbers back: the NEXT sale takes the very next number (no gap)
      const lastBefore = nums[5]!;
      const failing = await mkOrder(co, null, one(10_000n));
      vi.spyOn(walkInJournal, 'postWalkInSaleJournalInTx').mockRejectedValueOnce(
        new Error('late failure'),
      );
      expect(
        (await complete(tok['cashier']!, failing, body({ tenders: [cash(TOTAL)] }))).statusCode,
      ).toBe(500);
      const next = await complete(tok['cashier']!, failing, body({ tenders: [cash(TOTAL)] }));
      expect(next.statusCode, next.payload).toBe(200);
      expect(num(next.json().invoice.invoiceNumber)).toBe(lastBefore + 1);
      vi.restoreAllMocks();

      // four companies in parallel: per-company contiguity, no cross-company state
      const four = await Promise.all(
        Array.from({ length: 4 }, () => makeCompany(tenantId, { currency: 'AED' })),
      );
      const batch = await Promise.all(
        four.flatMap((cx) =>
          Array.from({ length: 3 }, async () => {
            const o = await mkOrder(cx, null, one(10_000n));
            return { cx, r: await complete(tok['cashier']!, o, body({ tenders: [cash(TOTAL)] })) };
          }),
        ),
      );
      expect(batch.every((b) => b.r.statusCode === 200)).toBe(true);
      for (const cx of four) {
        const mine = batch
          .filter((b) => b.cx.companyId === cx.companyId)
          .map((b) => num(b.r.json().invoice.invoiceNumber))
          .sort((a, b) => a - b);
        expect(mine).toEqual([1, 2, 3]);
      }
    }, 180_000);
  });
});
