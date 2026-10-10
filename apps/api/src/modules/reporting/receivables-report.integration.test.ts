import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test: it seeds fixtures and reads the ledger directly — not production
// module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter.js';
import {
  RequestContext,
  installRequestContext,
  runWithContext,
} from '../../common/context/index.js';
import { JwtService } from '../../common/auth/jwt.service.js';
import { SessionStore } from '../../common/auth/session-store.js';
import type { SessionData } from '../../common/auth/session.types.js';
import { SystemClock, type Clock } from '../../common/clock/clock.js';
import { DbService } from '../../common/data/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { SYSTEM_ROLE_TEMPLATES } from '../platform/system-roles.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import type { CommercialSnapshotLine } from '../orders/commercial-snapshot.js';
import {
  computeReceivableBalance,
  RECEIVABLE_SOURCE_TYPES,
} from '../receivables/receivable-balance.js';
import {
  ReceivablesReportRepository,
  type ReceivablesBranchReport,
  type ReceivablesCompanyReport,
} from './receivables-report.repository.js';
import { ReceivablesReportService } from './receivables-report.service.js';
import { RECEIVABLES_REPORT_NOTE } from './receivables-report.js';
import { RECEIVABLES_REPORT_MAX_RECEIVABLES } from './receivables-report.sql.js';
import { TenderTotalsReportRepository } from './tender-totals-report.repository.js';

/**
 * Task 3b.10 Checkpoint D — RECEIVABLES CURRENT STATE over REAL receivables.
 *
 * Every receivable, allocation, advance application, CreditNote and CancellationCharge is created through the frozen
 * public flows (`complete-sale` ON_CREDIT / PAY_NOW, the standalone invoice payment route, the customer receipt route,
 * the opening-balance route, the advance conversion + application routes, order `cancel` with and without a charge) on
 * the full `AppModule`, with the real role grants, real PostgreSQL and real Redis, and a scripted clock. The expected
 * figures come from a MODEL ORACLE: every receivable and its source rows are read back table by table and folded with the
 * FROZEN `computeReceivableBalance` in plain TypeScript — independent of the report's single SQL statement — and the GL
 * side is summed straight from the journal lines.
 */
const DEFAULT_INSTANT = new Date('2026-06-10T10:00:00.000Z');
const at = (isoDate: string, hourUtc = 10): Date =>
  new Date(`${isoDate}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`);

/** the authoritative AR-changing journal kinds — typed here independently of the production module */
const AR_KINDS = [
  'invoice_ar',
  'opening_receivable',
  'cancellation_charge',
  'payment_allocation',
  'opening_receivable_payment_application',
  'cancellation_charge_payment_application',
  'customer_advance_application',
  'credit_note',
];

describe('Receivables current state — task 3b.10 Checkpoint D (real documents, real PostgreSQL)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let pool: pg.Pool;
  let db: DbService;
  let prisma: PrismaClient;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let repo: ReceivablesReportRepository;
  let service: ReceivablesReportService;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const catalogOf = new Map<string, { productId: string; variantId: string }>();

  type Uuid = ReturnType<typeof randomUUID>;
  interface Co {
    companyId: Uuid;
    branchId: Uuid;
    siblingBranchId: Uuid;
    currency: 'AED' | 'KWD';
    exponent: number;
    tenantId: Uuid;
  }
  interface Cust {
    customerId: string;
    ccaId: string;
    co: Co;
  }
  let aed: Co; // the main company: two branches, the full receivable matrix
  let aed2: Co; // another company of the SAME tenant — must never contribute to aed
  let kwd: Co; // 3-decimal company
  let foreign: Co; // another tenant's company

  let clockNow = DEFAULT_INSTANT;
  const fakeClock: Clock = { now: () => clockNow };
  const setClock = (d: Date): void => {
    clockNow = d;
  };

  const asTenant = <T>(fn: (tx: ScopedTx) => Promise<T>, t = tenantId): Promise<T> =>
    runScoped(prisma, { tenantId: t }, fn);
  const q = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await pool.query(sql, params)).rows as T[];

  // ── sessions (real role grants) ────────────────────────────────────────
  const baseSess = (sessionId: string): SessionData => ({
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
  });
  async function mint(
    id: string,
    perms: readonly string[],
    opts: { tenant?: string; stepUp?: boolean } = {},
  ): Promise<string> {
    const s = baseSess(`t-${id}`);
    s.tenantId = opts.tenant ?? tenantId;
    s.userId = randomUUID();
    s.accountType = 'OWNER';
    if (opts.stepUp) {
      s.mfaLevel = 'STEP_UP';
      s.stepUpUntil = Date.now() + 3_600_000;
    }
    s.access = {
      effectivePermissions: [...perms],
      companyScope: 'ALL',
      branchScope: 'ALL',
      perBranchOverlay: {},
      entitledModules: [],
      planKey: null,
    };
    await store.set(s);
    return jwt.sign({ sub: s.userId, sid: s.sessionId, aud: 'tenant', tid: s.tenantId });
  }
  const rolePerms = (key: string): string[] => {
    const role = SYSTEM_ROLE_TEMPLATES.find((r) => r.key === key);
    if (!role) throw new Error(`no system role ${key}`);
    return [...role.permissions];
  };
  const tok: Record<string, string> = {};

  // ── fixtures ────────────────────────────────────────────────────────────────
  async function makeCompany(tid: Uuid, o: { currency: 'AED' | 'KWD'; tz?: string }): Promise<Co> {
    const co: Co = {
      companyId: randomUUID(),
      branchId: randomUUID(),
      siblingBranchId: randomUUID(),
      currency: o.currency,
      exponent: o.currency === 'KWD' ? 3 : 2,
      tenantId: tid,
    };
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","cancellationFeeTaxCategoryKey",status,"updatedAt")
       VALUES ($1,$2,'Receivables Report Co','AE',$3,$4,'STD3B3','ACTIVE',now())`,
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
    await asTenant(
      (tx) => accounts.ensureDefaultAccounts(tx, { tenantId: tid, companyId: co.companyId }),
      tid,
    );
    await asTenant(
      (tx) =>
        periods.create(tx, {
          tenantId: tid,
          companyId: co.companyId,
          startDate: new Date('2026-05-01T00:00:00Z'),
          endDate: new Date('2026-09-30T00:00:00Z'),
        }),
      tid,
    );
    return co;
  }

  async function mkCustomer(co: Co, displayName = 'Customer'): Promise<Cust> {
    const customerId = randomUUID();
    const ccaId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","phoneE164","emailNormalized","updatedAt") VALUES ($1,$2,$3,$4,$5,now())`,
      [
        customerId,
        co.tenantId,
        displayName,
        `+9715${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        `${customerId.slice(0, 8)}@pii-example.test`,
      ],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","creditEnabled","updatedAt")
       VALUES ($1,$2,$3,$4,true,now())`,
      [ccaId, co.tenantId, co.companyId, customerId],
    );
    return { customerId, ccaId, co };
  }

  interface LineSpec {
    unitPriceAmountMinor: bigint;
    rateBps: number | null;
  }
  interface OrderSpec {
    lines: LineSpec[];
  }
  interface MadeOrder {
    orderId: string;
    co: Co;
    branchId: string;
    customerId: string | null;
    version: number;
  }
  const one = (priceMinor: bigint, rateBps: number | null = 500): OrderSpec => ({
    lines: [{ unitPriceAmountMinor: priceMinor, rateBps }],
  });

  function snapshotLine(spec: LineSpec, co: Co): CommercialSnapshotLine {
    const { productId, variantId } = catalogOf.get(co.tenantId)!;
    return {
      productId,
      variantId,
      quantity: '1.0000',
      selectedUomCode: 'piece',
      baseUomCode: 'piece',
      conversionNumerator: '1',
      conversionDenominator: '1',
      unitPriceAmountMinor: spec.unitPriceAmountMinor.toString(),
      unitPriceCurrencyCode: co.currency,
      unitPriceCurrencyExponent: co.exponent,
      discountMode: 'NONE',
      discountBps: null,
      discountAmountMinor: '0',
      taxCategoryKey: spec.rateBps === null ? null : 'STANDARD',
      rateBps: spec.rateBps,
      effectiveFrom: spec.rateBps === null ? null : '2020-01-01',
      resolutionSource: spec.rateBps === null ? 'NONE' : 'VARIANT',
    };
  }

  async function mkOrder(
    co: Co,
    customerId: string | null,
    spec: OrderSpec,
    branchId: string = co.branchId,
  ): Promise<MadeOrder> {
    const fingerprint = computeCommercialSnapshotFingerprintV2(
      {
        tenantId: co.tenantId,
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
      { taxPriceMode: 'TAX_EXCLUSIVE', taxRoundingScope: 'LINE', taxRoundingMode: 'HALF_UP' },
    );
    const orderId = randomUUID();
    const { productId, variantId } = catalogOf.get(co.tenantId)!;
    await pool.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor",
          "documentDiscountReason","commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT',$6,$7,'NONE',NULL,0,NULL,$8,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [
        orderId,
        co.tenantId,
        co.companyId,
        branchId,
        customerId,
        co.currency,
        co.exponent,
        fingerprint,
      ],
    );
    for (const [i, l] of spec.lines.entries()) {
      await pool.query(
        `INSERT INTO order_line
           (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
            "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
            "discountMode","discountBps","discountAmountMinor",
            "taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
            "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
            "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot",
            "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'1.0000',$8,$9,$10,'NONE',NULL,0,$11,$12,
                 CASE WHEN $12::int IS NULL THEN NULL ELSE '2020-01-01'::date END,$13,
                 'piece','Piece','piece',1,1,'Rose','Rose',now())`,
        [
          randomUUID(),
          co.tenantId,
          co.companyId,
          orderId,
          i + 1,
          productId,
          variantId,
          l.unitPriceAmountMinor.toString(),
          co.currency,
          co.exponent,
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
  const ik = (): string => `r-key-${String(++keySeq).padStart(5, '0')}-${randomUUID().slice(0, 8)}`;
  const orderUrl = (o: { co: Co; branchId: string; orderId: string }, tail = ''): string =>
    `/v1/companies/${o.co.companyId}/branches/${o.branchId}/orders/${o.orderId}${tail}`;
  const tokenOf = (co: Co): string =>
    co.tenantId === tenantId ? tok['owner']! : tok['foreignOwner']!;
  const post = (
    token: string,
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload: payload as Record<string, unknown>,
    });

  type Tender = { method: string; amountMinor: string };
  const cash = (n: bigint): Tender => ({ method: 'CASH', amountMinor: n.toString() });
  const bank = (n: bigint): Tender => ({ method: 'BANK_TRANSFER', amountMinor: n.toString() });
  const card = (n: bigint): Tender => ({ method: 'CARD_TERMINAL', amountMinor: n.toString() });

  /** complete a sale at `when` (the scripted clock); returns the made order + its invoice id */
  async function sell(
    o: MadeOrder,
    payload: {
      intent?: 'PAY_NOW' | 'ON_CREDIT';
      tenders?: Tender[];
      advances?: { advanceId: string; amountMinor: string }[];
    },
    when: Date,
  ): Promise<{ order: MadeOrder; invoiceId: string }> {
    setClock(when);
    const res = await post(
      tokenOf(o.co),
      orderUrl(o, '/complete-sale'),
      {
        paymentIntent: payload.intent ?? 'PAY_NOW',
        ...(payload.tenders !== undefined ? { tenders: payload.tenders } : {}),
        ...(payload.advances !== undefined ? { advanceApplications: payload.advances } : {}),
      },
      { 'idempotency-key': ik(), 'if-match': String(o.version) },
    );
    expect(res.statusCode, res.payload).toBe(200);
    setClock(DEFAULT_INSTANT);
    return { order: o, invoiceId: (res.json() as { invoice: { id: string } }).invoice.id };
  }

  async function cancel(
    o: MadeOrder,
    when: Date,
    body: Record<string, unknown> = { reason: 'receivables fixture' },
  ): Promise<void> {
    setClock(when);
    const v = (
      await q<{ version: number }>(`SELECT version FROM "order" WHERE id = $1`, [o.orderId])
    )[0]!.version;
    const res = await post(tokenOf(o.co), orderUrl(o, '/cancel'), body, { 'if-match': String(v) });
    expect(res.statusCode, res.payload).toBe(200);
    setClock(DEFAULT_INSTANT);
  }

  /** the standalone customer receipt route (FIFO allocation; the remainder stays unapplied) */
  async function receipt(
    co: Co,
    branchId: string,
    customerId: string,
    method: 'CASH' | 'BANK_TRANSFER',
    amount: bigint,
    when: Date,
  ): Promise<{ paymentId: string; allocatedAmountMinor: string; unallocatedAmountMinor: string }> {
    setClock(when);
    const res = await post(
      tokenOf(co),
      `/v1/companies/${co.companyId}/branches/${branchId}/customers/${customerId}/receipts`,
      { amountMinor: amount.toString(), method },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    setClock(DEFAULT_INSTANT);
    return res.json() as {
      paymentId: string;
      allocatedAmountMinor: string;
      unallocatedAmountMinor: string;
    };
  }

  /** the opening-balance route: an OPENING receivable (type RECEIVABLE) */
  async function openingReceivable(
    co: Co,
    branchId: string,
    customerId: string,
    amount: bigint,
    effectiveDate: string,
  ): Promise<string> {
    setClock(DEFAULT_INSTANT);
    const res = await post(
      tokenOf(co),
      `/v1/companies/${co.companyId}/branches/${branchId}/customers/${customerId}/opening-balance`,
      { type: 'RECEIVABLE', amountMinor: amount.toString(), effectiveDate, note: 'opening' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    return (
      await q<{ id: string }>(
        `SELECT cr.id FROM customer_receivable cr JOIN customer_company_account x ON x.id = cr."customerCompanyAccountId"
          WHERE cr."branchId" = $1 AND x."customerId" = $2 AND cr."sourceType" = 'OPENING'`,
        [branchId, customerId],
      )
    )[0]!.id;
  }

  /** convert part of an UNAPPLIED receipt into a CustomerAdvance (a reclass — AR is untouched) */
  async function convertToAdvance(
    co: Co,
    branchId: string,
    customerId: string,
    paymentId: string,
    amount: bigint,
  ): Promise<string> {
    const res = await post(
      tokenOf(co),
      `/v1/companies/${co.companyId}/branches/${branchId}/customers/${customerId}/advances/from-payment`,
      { paymentId, amountMinor: amount.toString() },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    return (res.json() as { advanceId: string }).advanceId;
  }

  /** apply an advance to ONE named receivable */
  async function applyAdvance(
    co: Co,
    branchId: string,
    customerId: string,
    advanceId: string,
    receivableId: string,
    amount: bigint,
  ): Promise<void> {
    const res = await post(
      tokenOf(co),
      `/v1/companies/${co.companyId}/branches/${branchId}/customers/${customerId}/advances/${advanceId}/applications`,
      { customerReceivableId: receivableId, amountMinor: amount.toString() },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  }

  /** the advance refund route — a LOCAL cash refund of part of an Advance (a Refund never reduces a receivable) */
  async function refundAdvance(
    co: Co,
    branchId: string,
    customerId: string,
    advanceId: string,
    amount: bigint,
  ): Promise<void> {
    const res = await post(
      tokenOf(co),
      `/v1/companies/${co.companyId}/branches/${branchId}/customers/${customerId}/advances/${advanceId}/refunds`,
      { requestedAmountMinor: amount.toString(), method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  }

  const receivableOfInvoice = async (invoiceId: string): Promise<string> =>
    (
      await q<{ id: string }>(`SELECT id FROM customer_receivable WHERE "invoiceId" = $1`, [
        invoiceId,
      ])
    )[0]!.id;
  const invoiceOfOrder = async (o: MadeOrder): Promise<string> =>
    (await q<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [o.orderId]))[0]!.id;

  // ── the model oracle: every receivable and its source rows read table by table, folded with the FROZEN helper ──
  interface ModelReceivable {
    id: string;
    branchId: string;
    customerId: string;
    sourceType: string;
    original: bigint;
    paidByPayment: bigint;
    paidByAdvance: bigint;
    credited: bigint;
    outstanding: bigint;
  }
  async function loadModel(companyId: string): Promise<ModelReceivable[]> {
    const receivables = await q<{
      id: string;
      branchId: string;
      sourceType: string;
      invoiceId: string | null;
      cancellationChargeId: string | null;
      openingAmountMinor: string | null;
      customerId: string;
    }>(
      `SELECT cr.id, cr."branchId", cr."sourceType", cr."invoiceId", cr."cancellationChargeId",
              cr."openingAmountMinor"::text AS "openingAmountMinor", x."customerId"
         FROM customer_receivable cr JOIN customer_company_account x ON x.id = cr."customerCompanyAccountId"
        WHERE cr."companyId" = $1`,
      [companyId],
    );
    const sumBy = async (sql: string): Promise<Map<string, bigint>> =>
      new Map((await q<{ k: string; s: string }>(sql, [companyId])).map((r) => [r.k, BigInt(r.s)]));
    const invoiceTotal = await sumBy(
      `SELECT i.id::text AS k, i."totalAmountMinor"::text AS s FROM invoice i WHERE i."companyId" = $1`,
    );
    const chargeTotal = await sumBy(
      `SELECT c.id::text AS k, c."totalAmountMinor"::text AS s FROM cancellation_charge c WHERE c."companyId" = $1`,
    );
    const allocByInvoice = await sumBy(
      `SELECT pa."invoiceId"::text AS k, SUM(pa."amountMinor")::text AS s FROM payment_allocation pa WHERE pa."companyId" = $1 GROUP BY pa."invoiceId"`,
    );
    const crpaByReceivable = await sumBy(
      `SELECT x."customerReceivableId"::text AS k, SUM(x."amountMinor")::text AS s FROM customer_receivable_payment_application x WHERE x."companyId" = $1 GROUP BY x."customerReceivableId"`,
    );
    const caaByReceivable = await sumBy(
      `SELECT x."customerReceivableId"::text AS k, SUM(x."amountMinor")::text AS s FROM customer_advance_application x WHERE x."companyId" = $1 GROUP BY x."customerReceivableId"`,
    );
    const creditByInvoice = await sumBy(
      `SELECT n."invoiceId"::text AS k, SUM(n."arReductionMinor")::text AS s FROM credit_note n WHERE n."companyId" = $1 GROUP BY n."invoiceId"`,
    );
    return receivables.map((r) => {
      const principal =
        r.sourceType === 'INVOICE'
          ? invoiceTotal.get(r.invoiceId!)!
          : r.sourceType === 'OPENING'
            ? BigInt(r.openingAmountMinor!)
            : chargeTotal.get(r.cancellationChargeId!)!;
      const b = computeReceivableBalance({
        sourceType: r.sourceType,
        principalMinor: principal,
        paidByPaymentMinor:
          r.sourceType === 'INVOICE'
            ? (allocByInvoice.get(r.invoiceId!) ?? 0n)
            : (crpaByReceivable.get(r.id) ?? 0n),
        paidByAdvanceMinor: caaByReceivable.get(r.id) ?? 0n,
        creditedMinor: r.sourceType === 'INVOICE' ? (creditByInvoice.get(r.invoiceId!) ?? 0n) : 0n,
      });
      return {
        id: r.id,
        branchId: r.branchId,
        customerId: r.customerId,
        sourceType: r.sourceType,
        original: b.originalMinor,
        paidByPayment: b.paidByPaymentMinor,
        paidByAdvance: b.paidByAdvanceMinor,
        credited: b.creditedMinor,
        outstanding: b.outstandingMinor,
      };
    });
  }

  interface Figures {
    receivableCount: number;
    originalMinor: string;
    paidByPaymentMinor: string;
    paidByAdvanceMinor: string;
    creditedMinor: string;
    outstandingMinor: string;
  }
  const figuresOfRows = (rows: ModelReceivable[]): Figures => {
    const sum = (f: (r: ModelReceivable) => bigint): string =>
      rows.reduce((n, r) => n + f(r), 0n).toString();
    return {
      receivableCount: rows.length,
      originalMinor: sum((r) => r.original),
      paidByPaymentMinor: sum((r) => r.paidByPayment),
      paidByAdvanceMinor: sum((r) => r.paidByAdvance),
      creditedMinor: sum((r) => r.credited),
      outstandingMinor: sum((r) => r.outstanding),
    };
  };
  const pickFigures = (r: Figures): Figures => ({
    receivableCount: r.receivableCount,
    originalMinor: r.originalMinor,
    paidByPaymentMinor: r.paidByPaymentMinor,
    paidByAdvanceMinor: r.paidByAdvanceMinor,
    creditedMinor: r.creditedMinor,
    outstandingMinor: r.outstandingMinor,
  });
  /** the figures a report MUST show for a scope, aggregated in plain TypeScript from the model */
  function expectedBlocks(rows: ModelReceivable[]) {
    return {
      ...figuresOfRows(rows),
      bySourceType: RECEIVABLE_SOURCE_TYPES.map((t) => ({
        sourceType: t,
        ...figuresOfRows(rows.filter((r) => r.sourceType === t)),
      })),
    };
  }
  const blocksOf = (
    r: Figures & { bySourceType: readonly (Figures & { sourceType: string })[] },
  ) => ({
    ...pickFigures(r),
    bySourceType: r.bySourceType.map((s) => ({ sourceType: s.sourceType, ...pickFigures(s) })),
  });

  /** the GL Accounts-Receivable net of the authoritative AR journals — summed straight from the journal tables */
  async function glOracle(companyId: string, branchId: string | null = null): Promise<bigint> {
    const rows = await q<{ s: string }>(
      `SELECT COALESCE(SUM(jl."debitMinor" - jl."creditMinor"), 0)::text AS s
         FROM journal_entry je
         JOIN journal_line jl ON jl."journalEntryId" = je.id
         JOIN account a ON a.id = jl."accountId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = 'ASSET.ACCOUNTS_RECEIVABLE'
          AND je."sourceKind" = ANY($2) AND ($3::uuid IS NULL OR jl."branchId" = $3::uuid)`,
      [companyId, AR_KINDS, branchId],
    );
    return BigInt(rows[0]!.s);
  }
  /** EVERY sealed AR line of the company, whatever its journal kind — the clean world has no other kind */
  async function glAllKinds(companyId: string): Promise<bigint> {
    const rows = await q<{ s: string }>(
      `SELECT COALESCE(SUM(jl."debitMinor" - jl."creditMinor"), 0)::text AS s
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = 'ASSET.ACCOUNTS_RECEIVABLE'`,
      [companyId],
    );
    return BigInt(rows[0]!.s);
  }

  // ── report helpers ──────────────────────────────────────────────────────────
  const inTenant = <T>(fn: () => Promise<T>, t: string = tenantId): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId: t }), fn);
  const companyReport = (
    co: Co,
    extra: { customerId?: string | null; cursor?: unknown; limit?: unknown } = {},
  ): Promise<ReceivablesCompanyReport> =>
    inTenant(() => service.companyReport({ companyId: co.companyId, ...extra }), co.tenantId);
  const branchReport = (
    co: Co,
    branchId: string,
    extra: { customerId?: string | null; cursor?: unknown; limit?: unknown } = {},
  ): Promise<ReceivablesBranchReport> =>
    inTenant(
      () => service.branchReport({ companyId: co.companyId, branchId, ...extra }),
      co.tenantId,
    );

  async function reject(p: Promise<unknown>): Promise<DomainError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof DomainError) return e;
      throw e;
    }
    throw new Error('expected a DomainError');
  }

  // ── the shared document world ───────────────────────────────────────────────────────────────
  const W: Record<string, string> = {}; // named ids
  const O: Record<string, MadeOrder> = {};
  const C: Record<string, Cust> = {};

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url, max: 8 });

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `rrep-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [id, `rrep-${id.slice(0, 8)}`, planVersionId],
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
    await pool.query(
      `INSERT INTO country_tax_config (id,"countryCode","effectiveFrom",regime,config)
       SELECT uuidv7(),'AE','2020-01-01','VAT',
              '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM country_tax_config WHERE "countryCode" = 'AE')`,
    );
    await pool.query(
      `INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STD3B3','Standard 3b3','x') ON CONFLICT (key) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom")
       SELECT 'AE','STD3B3',500,'2020-01-01'
        WHERE NOT EXISTS (SELECT 1 FROM tax_rate WHERE "countryCode"='AE' AND "taxCategoryKey"='STD3B3')`,
    );
    for (const t of [tenantId, otherTenantId]) {
      const categoryId = randomUUID();
      const prod = randomUUID();
      const vari = randomUUID();
      await pool.query(
        `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'flowers','Flowers',now())`,
        [categoryId, t],
      );
      await pool.query(
        `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy",status,"updatedAt")
         VALUES ($1,$2,$3,'rose','Rose','STOCKED','ACTIVE',now())`,
        [prod, t, categoryId],
      );
      await pool.query(
        `INSERT INTO variant (id,"tenantId","productId","nameEn",status,"baseUomCode","updatedAt")
         VALUES ($1,$2,$3,'Rose','ACTIVE','piece',now())`,
        [vari, t, prod],
      );
      catalogOf.set(t, { productId: prod, variantId: vari });
    }

    process.env['DATABASE_URL'] = stack.postgres.url;
    process.env['PLATFORM_DATABASE_URL'] = stack.postgres.url;
    process.env['REDIS_URL'] = stack.redis.url;
    process.env['AUTH_JWT_SECRET'] = 'integration-test-jwt-secret-0000000000';
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
    accounts = app.get(AccountRepository);
    periods = app.get(AccountingPeriodRepository);
    repo = new ReceivablesReportRepository(db);
    service = new ReceivablesReportService(repo);

    aed = await makeCompany(tenantId, { currency: 'AED' });
    aed2 = await makeCompany(tenantId, { currency: 'AED' });
    kwd = await makeCompany(tenantId, { currency: 'KWD', tz: 'Asia/Kuwait' });
    foreign = await makeCompany(otherTenantId, { currency: 'AED' });

    tok['owner'] = await mint('owner', rolePerms('owner'), { stepUp: true });
    tok['foreignOwner'] = await mint('foreign-owner', rolePerms('owner'), {
      tenant: otherTenantId,
      stepUp: true,
    });

    // ───────────────────── THE WORLD: receivables through the frozen flows ─────────────────────
    const A = aed.branchId;
    const B = aed.siblingBranchId;
    for (const n of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) {
      C[n] = await mkCustomer(aed, `ZZ-PII-NAME-${n}`);
    }

    // c1 · A · ON_CREDIT, nothing paid (INVOICE, outstanding = total)
    O['c1Credit'] = (
      await sell(
        await mkOrder(aed, C['c1']!.customerId, one(10_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      )
    ).order;
    // c1 · A · ON_CREDIT with a PARTIAL cash tender (INVOICE, partly paid)
    O['c1Partial'] = (
      await sell(
        await mkOrder(aed, C['c1']!.customerId, one(8_000n)),
        { intent: 'ON_CREDIT', tenders: [cash(3_000n)] },
        at('2026-06-11'),
      )
    ).order;
    // c1 · A · PAY_NOW fully paid in cash (INVOICE, zero outstanding — a receivable record that stays)
    O['c1Paid'] = (
      await sell(
        await mkOrder(aed, C['c1']!.customerId, one(2_000n)),
        { tenders: [cash(2_100n)] },
        at('2026-06-11'),
      )
    ).order;
    // c2 · B · ON_CREDIT 5 250, then a customer receipt of 9 000: 5 250 allocated, 3 750 left UNAPPLIED (one Payment)
    O['c2Credit'] = (
      await sell(
        await mkOrder(aed, C['c2']!.customerId, one(5_000n), B),
        { intent: 'ON_CREDIT' },
        at('2026-06-12'),
      )
    ).order;
    const c2Receipt = await receipt(aed, B, C['c2']!.customerId, 'CASH', 9_000n, at('2026-06-13'));
    W['c2ReceiptPayment'] = c2Receipt.paymentId;
    expect(c2Receipt.allocatedAmountMinor).toBe('5250');
    expect(c2Receipt.unallocatedAmountMinor).toBe('3750');
    // c2 · B · a second ON_CREDIT open invoice (so c2 has open + zero rows)
    O['c2Credit2'] = (
      await sell(
        await mkOrder(aed, C['c2']!.customerId, one(4_000n), B),
        { intent: 'ON_CREDIT' },
        at('2026-06-14'),
      )
    ).order;
    // c3 · A · an unapplied receipt converted to an ADVANCE, applied to an ON_CREDIT invoice (advance application)
    const c3Rec = await receipt(aed, A, C['c3']!.customerId, 'CASH', 5_000n, at('2026-06-14'));
    W['c3ReceiptPayment'] = c3Rec.paymentId;
    expect(c3Rec.allocatedAmountMinor).toBe('0');
    W['c3Advance'] = await convertToAdvance(aed, A, C['c3']!.customerId, c3Rec.paymentId, 4_000n);
    O['c3Credit'] = (
      await sell(
        await mkOrder(aed, C['c3']!.customerId, one(6_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-15'),
      )
    ).order;
    W['c3CreditReceivable'] = await receivableOfInvoice(await invoiceOfOrder(O['c3Credit']!));
    await applyAdvance(
      aed,
      A,
      C['c3']!.customerId,
      W['c3Advance']!,
      W['c3CreditReceivable']!,
      1_500n,
    );
    // c3 · a second advance application on the SAME receivable (multiple advance applications) + a Payment + advance combination
    await applyAdvance(
      aed,
      A,
      C['c3']!.customerId,
      W['c3Advance']!,
      W['c3CreditReceivable']!,
      1_000n,
    );
    await receipt(aed, A, C['c3']!.customerId, 'BANK_TRANSFER', 1_000n, at('2026-06-16'));
    // c4 · A · ON_CREDIT, a CreditNote FULL AR reduction (cancel of an UNPAID invoice)
    O['c4Credit'] = (
      await sell(
        await mkOrder(aed, C['c4']!.customerId, one(3_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-16'),
      )
    ).order;
    await cancel(O['c4Credit']!, at('2026-06-17'));
    // c4 · A · ON_CREDIT with a PARTIAL payment, then cancelled: arReduction = the unpaid remainder, advanceExcess = the paid part
    O['c4Partial'] = (
      await sell(
        await mkOrder(aed, C['c4']!.customerId, one(10_000n)),
        { intent: 'ON_CREDIT', tenders: [cash(4_000n)] },
        at('2026-06-17'),
      )
    ).order;
    await cancel(O['c4Partial']!, at('2026-06-18'));
    // c5 · A · PAID (manual card) then cancelled: arReduction 0 — the whole credit became a CustomerAdvance (excess)
    O['c5Paid'] = (
      await sell(
        await mkOrder(aed, C['c5']!.customerId, one(4_000n), B),
        { tenders: [card(4_200n)] },
        at('2026-06-18'),
      )
    ).order;
    await cancel(O['c5Paid']!, at('2026-06-19'));
    // c5 · OPENING receivable at B, partly paid by a receipt (FIFO) and partly by an advance application
    W['c5Opening'] = await openingReceivable(aed, B, C['c5']!.customerId, 7_000n, '2026-05-15');
    await receipt(aed, B, C['c5']!.customerId, 'BANK_TRANSFER', 2_000n, at('2026-06-19'));
    const c5Adv = await q<{ id: string }>(
      `SELECT ca.id FROM customer_advance ca WHERE ca."customerCompanyAccountId" = $1`,
      [C['c5']!.ccaId],
    );
    await applyAdvance(aed, B, C['c5']!.customerId, c5Adv[0]!.id, W['c5Opening']!, 1_000n);
    // … and 500 of the same advance is REFUNDED in cash — a Refund is a money-out fact, never an AR reduction
    await refundAdvance(aed, B, C['c5']!.customerId, c5Adv[0]!.id, 500n);
    // c6 · A · a CancellationCharge receivable (pre-invoice cancel of a DRAFT order with a charge), partly paid
    {
      const draft = await mkOrder(aed, C['c6']!.customerId, one(3_000n));
      await cancel(draft, at('2026-06-20'), {
        reason: 'customer left',
        cancellationCharge: { requestedAmountMinor: '800', reasonCode: 'CUSTOMER_REQUEST' },
      });
      O['c6Charge'] = draft;
    }
    await receipt(aed, A, C['c6']!.customerId, 'CASH', 300n, at('2026-06-21'));
    // c7 · A · OPENING receivable only, untouched
    W['c7Opening'] = await openingReceivable(aed, A, C['c7']!.customerId, 12_345n, '2026-05-20');
    // c8 · ANONYMOUS-style customer with ONLY zero-outstanding history: PAY_NOW cash, fully paid (still a receivable record)
    O['c8Paid'] = (
      await sell(
        await mkOrder(aed, C['c8']!.customerId, one(1_000n), B),
        { tenders: [cash(1_050n)] },
        at('2026-06-21'),
      )
    ).order;
    // c9 · a customer with receivables in BOTH branches (ON_CREDIT at A and at B, a partial receipt at B)
    C['c9'] = await mkCustomer(aed, 'ZZ-PII-NAME-c9');
    O['c9A'] = (
      await sell(
        await mkOrder(aed, C['c9']!.customerId, one(3_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-22'),
      )
    ).order;
    O['c9B'] = (
      await sell(
        await mkOrder(aed, C['c9']!.customerId, one(2_000n), B),
        { intent: 'ON_CREDIT' },
        at('2026-06-22'),
      )
    ).order;
    await receipt(aed, B, C['c9']!.customerId, 'CASH', 700n, at('2026-06-23'));
    // anonymous (walk-in) sales — NEVER a receivable
    O['anon1'] = (
      await sell(
        await mkOrder(aed, null, one(9_000n)),
        { tenders: [cash(9_450n)] },
        at('2026-06-10'),
      )
    ).order;
    O['anon2'] = (
      await sell(
        await mkOrder(aed, null, one(5_000n), B),
        { tenders: [bank(5_250n)] },
        at('2026-06-11'),
      )
    ).order;

    // another company of the SAME tenant, and another tenant: each holds receivables that must never contribute to aed
    const o1Cust = await mkCustomer(aed2);
    await sell(
      await mkOrder(aed2, o1Cust.customerId, one(7_000n)),
      { intent: 'ON_CREDIT' },
      at('2026-06-12'),
    );
    const fCust = await mkCustomer(foreign);
    await sell(
      await mkOrder(foreign, fCust.customerId, one(6_000n)),
      { intent: 'ON_CREDIT' },
      at('2026-06-12'),
    );

    // the KWD company: a credit sale, an opening receivable, a partial receipt (3-decimal minor units)
    const k1 = await mkCustomer(kwd);
    await sell(
      await mkOrder(kwd, k1.customerId, one(12_345n)),
      { intent: 'ON_CREDIT' },
      at('2026-06-13'),
    );
    await openingReceivable(kwd, kwd.siblingBranchId, k1.customerId, 2_500n, '2026-05-10');
    await receipt(kwd, kwd.branchId, k1.customerId, 'CASH', 5_000n, at('2026-06-14'));
    C['k1'] = k1;
    C['o1'] = o1Cust;
    C['f1'] = fCust;
  }, 900_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await stack?.stop();
  });

  // ═══════════════════ the figures equal the independent oracle ═══════════════════
  describe('the company report equals the model oracle (original − allocations − advance applications − CreditNote AR reductions)', () => {
    it('the representative matrix: summary, source-type breakdown, GL control — AED', async () => {
      const model = await loadModel(aed.companyId);
      expect(model.length).toBeGreaterThanOrEqual(13);
      const r = await companyReport(aed);
      expect(blocksOf(r)).toEqual(expectedBlocks(model));
      const gl = await glOracle(aed.companyId);
      expect(r.reconciliation).toEqual({
        sourceOutstandingMinor: figuresOfRows(model).outstandingMinor,
        glAccountsReceivableMinor: gl.toString(),
        differenceMinor: '0',
        reconciled: true,
      });
      // the clean world has NO other journal that touches AR: the whole-account balance equals the authoritative one
      expect(await glAllKinds(aed.companyId)).toBe(gl);
      expect(r.currencyCode).toBe('AED');
      expect(r.currencyExponent).toBe(2);
      expect(r.accountingTimezone).toBe('Asia/Dubai');
      expect(r.note).toBe(RECEIVABLES_REPORT_NOTE);
      // every frozen source type is represented and each contributes in this world
      expect(r.bySourceType.map((s) => s.sourceType)).toEqual([...RECEIVABLE_SOURCE_TYPES]);
      for (const s of r.bySourceType) expect(s.receivableCount, s.sourceType).toBeGreaterThan(0);
    });

    it('KWD (3 decimals): every figure equals the oracle and nothing is rescaled', async () => {
      const model = await loadModel(kwd.companyId);
      expect(model.length).toBe(2);
      const r = await companyReport(kwd);
      expect(blocksOf(r)).toEqual(expectedBlocks(model));
      expect(r.currencyCode).toBe('KWD');
      expect(r.currencyExponent).toBe(3);
      expect(r.accountingTimezone).toBe('Asia/Kuwait');
      expect(r.reconciliation.reconciled).toBe(true);
      expect(r.reconciliation.glAccountsReceivableMinor).toBe(
        (await glOracle(kwd.companyId)).toString(),
      );
      // a 12.345 KWD invoice + 2.500 KWD opening − 5.000 receipt applied FIFO (oldest first)
      expect(r.originalMinor).toBe(figuresOfRows(model).originalMinor);
    });

    it('a Payment RECEIPT is not an AR reduction: only the allocated part is (Tender counts the whole receipt once)', async () => {
      const r = await companyReport(aed);
      const model = await loadModel(aed.companyId);
      const pay = BigInt(r.paidByPaymentMinor);
      expect(pay).toBe(model.reduce((n, m) => n + m.paidByPayment, 0n));
      // c2's 9 000 receipt: 5 250 allocated, 3 750 unapplied — the unapplied remainder reduced no receivable
      const c2Rows = model.filter((m) => m.customerId === C['c2']!.customerId);
      const c2Paid = c2Rows.reduce((n, m) => n + m.paidByPayment, 0n);
      expect(c2Paid).toBe(5_250n);
      // the cross-report invariant: Tender's CASH receipt of that Payment is the WHOLE 9 000
      const tender = new TenderTotalsReportRepository(db);
      const t = await inTenant(() =>
        tender.getCompanyReportScoped({
          companyId: aed.companyId,
          from: '2026-06-01',
          to: '2026-06-30',
        }),
      );
      const cashReceipts = BigInt(
        t.receipts.byMethod.find((m) => m.method === 'CASH')!.receiptTotalMinor,
      );
      expect(cashReceipts).toBeGreaterThan(c2Paid);
      const paymentRow = await q<{ a: string }>(
        `SELECT "amountMinor"::text AS a FROM payment WHERE id = $1`,
        [W['c2ReceiptPayment']],
      );
      expect(BigInt(paymentRow[0]!.a)).toBe(9_000n);
    });

    it('anonymous (walk-in) sales are never a receivable and never appear in the report', async () => {
      const anon = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM customer_receivable cr
           JOIN invoice i ON i.id = cr."invoiceId" JOIN "order" o ON o.id = i."orderId"
          WHERE cr."companyId" = $1 AND o."customerId" IS NULL`,
        [aed.companyId],
      );
      expect(anon[0]!.n).toBe('0');
      const invoices = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE i."companyId" = $1 AND o."customerId" IS NULL`,
        [aed.companyId],
      );
      expect(Number(invoices[0]!.n)).toBeGreaterThanOrEqual(2); // the walk-in invoices exist …
      const r = await companyReport(aed);
      expect(r.receivableCount).toBe((await loadModel(aed.companyId)).length); // … yet no receivable is theirs
    });

    it('a CreditNote reduces AR by its AR-reduction ONLY: total > AR reduction ⇒ credited uses only that portion', async () => {
      const cn = await q<{ total: string; ar: string; excess: string; invoiceId: string }>(
        `SELECT cn."totalAmountMinor"::text AS total, cn."arReductionMinor"::text AS ar, cn."advanceExcessMinor"::text AS excess,
                cn."invoiceId" AS "invoiceId"
           FROM credit_note cn JOIN invoice i ON i.id = cn."invoiceId" WHERE i."orderId" = $1`,
        [O['c4Partial']!.orderId],
      );
      const note = cn[0]!;
      expect(BigInt(note.total)).toBeGreaterThan(BigInt(note.ar)); // the total exceeds the AR reduction …
      expect(BigInt(note.excess)).toBeGreaterThan(0n); // … by an advance excess
      expect(BigInt(note.ar) + BigInt(note.excess)).toBe(BigInt(note.total));
      const rec = (await loadModel(aed.companyId)).find(
        (m) =>
          m.customerId === C['c4']!.customerId &&
          m.credited === BigInt(note.ar) &&
          m.paidByPayment > 0n,
      )!;
      expect(rec).toBeDefined();
      expect(rec.credited).toBe(BigInt(note.ar)); // the excess advance is NOT subtracted again
      expect(rec.outstanding).toBe(0n); // total − paid − arReduction = 0
      // the excess became a CustomerAdvance — not receivable, not in `credited`, not in any figure
      const adv = await q<{ s: string }>(
        `SELECT COALESCE(SUM(ca."amountMinor"),0)::text AS s FROM customer_advance ca WHERE ca."companyId" = $1 AND ca."sourceType" = 'CREDIT_NOTE'`,
        [aed.companyId],
      );
      expect(BigInt(adv[0]!.s)).toBeGreaterThan(0n);
      const r = await companyReport(aed);
      expect(BigInt(r.creditedMinor)).toBe(
        (await loadModel(aed.companyId)).reduce((n, m) => n + m.credited, 0n),
      );
    });

    it('an Advance application counts ONCE; the Advance creation, an unapplied remainder and a Refund are not AR reductions', async () => {
      const model = await loadModel(aed.companyId);
      const r = await companyReport(aed);
      const caa = await q<{ s: string }>(
        `SELECT COALESCE(SUM("amountMinor"),0)::text AS s FROM customer_advance_application WHERE "companyId" = $1`,
        [aed.companyId],
      );
      expect(r.paidByAdvanceMinor).toBe(caa[0]!.s);
      expect(r.paidByAdvanceMinor).toBe(model.reduce((n, m) => n + m.paidByAdvance, 0n).toString());
      const created = await q<{ s: string }>(
        `SELECT COALESCE(SUM("amountMinor"),0)::text AS s FROM customer_advance WHERE "companyId" = $1`,
        [aed.companyId],
      );
      expect(BigInt(created[0]!.s)).toBeGreaterThan(BigInt(caa[0]!.s)); // creation ≠ application
    });

    it('zero-outstanding receivables stay in every total and in the customer rows (original − satisfaction = outstanding stays auditable)', async () => {
      const model = await loadModel(aed.companyId);
      const zero = model.filter((m) => m.outstanding === 0n);
      expect(zero.length).toBeGreaterThanOrEqual(3);
      const r = await companyReport(aed, { limit: 200 });
      expect(r.receivableCount).toBe(model.length); // open AND closed
      const rowOf = (id: string) => r.customers.rows.find((c) => c.customerId === id)!;
      // c8 holds only a fully paid receivable: still a row, outstanding 0
      expect(rowOf(C['c8']!.customerId)).toMatchObject({
        receivableCount: 1,
        outstandingMinor: '0',
      });
      for (const c of r.customers.rows) {
        expect(
          BigInt(c.originalMinor) -
            BigInt(c.paidByPaymentMinor) -
            BigInt(c.paidByAdvanceMinor) -
            BigInt(c.creditedMinor),
        ).toBe(BigInt(c.outstandingMinor));
      }
    });
  });

  // ═══════════════════ branch and company scopes ═══════════════════
  describe('branch and company scopes', () => {
    const KEYS = [
      'originalMinor',
      'paidByPaymentMinor',
      'paidByAdvanceMinor',
      'creditedMinor',
      'outstandingMinor',
    ] as const;

    it('Branch A holds only A, Branch B only B, the Company is A + B exactly, and every byBranch row equals its branch report', async () => {
      const A = aed.branchId;
      const B = aed.siblingBranchId;
      const model = await loadModel(aed.companyId);
      const company = await companyReport(aed);
      const a = await branchReport(aed, A);
      const b = await branchReport(aed, B);
      expect(blocksOf(a)).toEqual(expectedBlocks(model.filter((m) => m.branchId === A)));
      expect(blocksOf(b)).toEqual(expectedBlocks(model.filter((m) => m.branchId === B)));
      expect(a.receivableCount).toBeGreaterThan(0);
      expect(b.receivableCount).toBeGreaterThan(0);
      // company current source totals = Σ byBranch, for EVERY field and every source type
      expect(company.receivableCount).toBe(a.receivableCount + b.receivableCount);
      for (const k of KEYS) {
        expect(BigInt(company[k]), k).toBe(BigInt(a[k]) + BigInt(b[k]));
        for (const [i, s] of company.bySourceType.entries()) {
          expect(BigInt(s[k]), `${s.sourceType}.${k}`).toBe(
            BigInt(a.bySourceType[i]![k]) + BigInt(b.bySourceType[i]![k]),
          );
        }
      }
      const rowIds = company.byBranch.map((r) => r.branchId);
      expect(rowIds).toEqual([A, B].sort());
      for (const row of company.byBranch) {
        const own = row.branchId === A ? a : b;
        expect(blocksOf(row)).toEqual(blocksOf(own));
        expect(row.reconciliation).toEqual(own.reconciliation);
      }
      // the company figures are the EXACT sum of the byBranch rows
      for (const k of KEYS) {
        expect(BigInt(company[k])).toBe(company.byBranch.reduce((n, r) => n + BigInt(r[k]), 0n));
      }
      // each control reads the GL of its own scope
      expect(a.reconciliation.glAccountsReceivableMinor).toBe(
        (await glOracle(aed.companyId, A)).toString(),
      );
      expect(b.reconciliation.glAccountsReceivableMinor).toBe(
        (await glOracle(aed.companyId, B)).toString(),
      );
      expect(BigInt(company.reconciliation.glAccountsReceivableMinor)).toBe(
        BigInt(a.reconciliation.glAccountsReceivableMinor) +
          BigInt(b.reconciliation.glAccountsReceivableMinor),
      );
    });

    it('a per-customer company row aggregates the customer across branches; a branch row only that branch', async () => {
      const model = await loadModel(aed.companyId);
      const c9 = C['c9']!.customerId;
      const inBoth = model.filter((m) => m.customerId === c9);
      expect(new Set(inBoth.map((m) => m.branchId)).size).toBe(2);
      const company = await companyReport(aed, { limit: 200 });
      const rowOf = (r: { customers: { rows: readonly { customerId: string }[] } }) =>
        r.customers.rows.find((c) => c.customerId === c9)! as unknown as Figures & {
          customerId: string;
        };
      expect(pickFigures(rowOf(company))).toEqual(figuresOfRows(inBoth));
      for (const branchId of [aed.branchId, aed.siblingBranchId]) {
        const r = await branchReport(aed, branchId, { limit: 200 });
        expect(pickFigures(rowOf(r))).toEqual(
          figuresOfRows(inBoth.filter((m) => m.branchId === branchId)),
        );
      }
    });

    it('a branch with no receivable is a zero-filled, reconciled report and is absent from byBranch; a foreign / unknown branch is a plain 404', async () => {
      const empty = await makeCompany(tenantId, { currency: 'AED' });
      const company = await companyReport(empty);
      expect(company.byBranch).toEqual([]);
      expect(company.receivableCount).toBe(0);
      expect(company.reconciliation).toEqual({
        sourceOutstandingMinor: '0',
        glAccountsReceivableMinor: '0',
        differenceMinor: '0',
        reconciled: true,
      });
      const branch = await branchReport(empty, empty.branchId);
      expect(branch).toMatchObject({ receivableCount: 0, outstandingMinor: '0' });
      expect(branch.customers).toEqual({ rows: [], nextCursor: null });
      for (const bs of [...company.bySourceType, ...branch.bySourceType]) {
        expect(bs.receivableCount).toBe(0);
      }
      // a branch of ANOTHER company, and an unknown branch, are a plain 404 (never a zero report)
      expect(await reject(branchReport(aed, aed2.branchId))).toMatchObject({ status: 404 });
      expect(await reject(branchReport(aed, randomUUID()))).toMatchObject({ status: 404 });
    });
  });

  // ═══════════════════ tenant / company isolation ═══════════════════
  describe('tenant and company isolation', () => {
    it('another company of the same tenant and another tenant never contribute: each report equals ITS OWN oracle', async () => {
      for (const co of [aed, aed2, kwd]) {
        const r = await companyReport(co);
        expect(blocksOf(r), co.companyId).toEqual(expectedBlocks(await loadModel(co.companyId)));
      }
      const f = await companyReport(foreign);
      expect(blocksOf(f)).toEqual(expectedBlocks(await loadModel(foreign.companyId)));
      // the tenant holds more receivables than any one company reports — proof the other companies exist
      const tenantWide = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM customer_receivable WHERE "tenantId" = $1`,
        [tenantId],
      );
      expect(Number(tenantWide[0]!.n)).toBeGreaterThan((await companyReport(aed)).receivableCount);
      expect((await companyReport(aed2)).receivableCount).toBe(1);
      expect(f.receivableCount).toBe(1);
    });

    it('a company of ANOTHER tenant is a plain 404 in this tenant’s context and vice versa', async () => {
      expect(await reject(companyReport({ ...foreign, tenantId } as Co))).toMatchObject({
        status: 404,
      });
      expect(
        await reject(
          inTenant(() => service.companyReport({ companyId: aed.companyId }), otherTenantId),
        ),
      ).toMatchObject({ status: 404 });
      expect(await reject(companyReport(aed, { customerId: C['f1']!.customerId }))).toMatchObject({
        status: 404,
      });
    });
  });

  // ═══════════════════ the current snapshot: asOf ═══════════════════
  describe('the report is a CURRENT snapshot: asOf is the database instant, never an input', () => {
    it('asOf is an ISO-8601 UTC database timestamp, the app clock never decides it, a later report is not earlier, a client cannot supply it', async () => {
      const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      const r1 = await companyReport(aed);
      expect(r1.asOf).toMatch(re);
      const dbNow = (
        await q<{ n: string }>(
          `SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS n`,
        )
      )[0]!.n;
      expect(Math.abs(Date.parse(r1.asOf) - Date.parse(dbNow))).toBeLessThan(15_000);
      setClock(new Date('2020-01-01T00:00:00.000Z')); // the scripted application clock says 2020 …
      const r2 = await companyReport(aed);
      setClock(DEFAULT_INSTANT);
      expect(r2.asOf.startsWith('2020')).toBe(false); // … the snapshot instant is still the database's
      expect(Date.parse(r2.asOf)).toBeGreaterThanOrEqual(Date.parse(r1.asOf));
      // no historical input exists: an extra `asOf` key is ignored, never used
      const r3 = await inTenant(() =>
        service.companyReport({
          companyId: aed.companyId,
          asOf: '2020-01-01T00:00:00.000Z',
        } as never),
      );
      expect(r3.asOf.startsWith('2020')).toBe(false);
      // ONE asOf describes the whole report (summary, byBranch, customers, reconciliation share it)
      expect((JSON.stringify(r1).match(/"asOf":/g) ?? []).length).toBe(1);
      const b = await branchReport(aed, aed.branchId);
      expect(b.asOf).toMatch(re);
      expect((JSON.stringify(b).match(/"asOf":/g) ?? []).length).toBe(1);
    });
  });

  // ═══════════════════ pagination ═══════════════════
  describe('per-customer rows are keyset-paginated; the summary and the control cover the WHOLE scope', () => {
    it('limit 2: every page ≤ 2 rows in customerId order, nextCursor chains to null, the pages concatenate to the full list, the summary never changes', async () => {
      const model = await loadModel(aed.companyId);
      const customers = [...new Set(model.map((m) => m.customerId))].sort();
      expect(customers.length).toBe(9);
      const full = await companyReport(aed, { limit: 200 });
      expect(full.customers.rows.map((r) => r.customerId)).toEqual(customers);
      expect(full.customers.nextCursor).toBeNull();

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let summary: unknown;
      for (;;) {
        const page = await companyReport(aed, {
          limit: 2,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        pages += 1;
        expect(page.customers.rows.length).toBeLessThanOrEqual(2);
        seen.push(...page.customers.rows.map((r) => r.customerId));
        const s = {
          blocks: blocksOf(page),
          byBranch: page.byBranch.length,
          rec: page.reconciliation,
        };
        if (summary === undefined) summary = s;
        expect(s).toEqual(summary); // the summary / control is the whole scope, never the page
        // each row equals the oracle for that customer
        for (const row of page.customers.rows) {
          expect(pickFigures(row as unknown as Figures)).toEqual(
            figuresOfRows(model.filter((m) => m.customerId === row.customerId)),
          );
        }
        if (page.customers.nextCursor === null) break;
        expect(page.customers.nextCursor).toBe(
          page.customers.rows[page.customers.rows.length - 1]!.customerId,
        );
        cursor = page.customers.nextCursor;
        expect(pages).toBeLessThan(20);
      }
      expect(pages).toBe(5); // 9 customers at 2 per page
      expect(seen).toEqual(customers);
    });

    it('a deep cursor returns exactly the customers after it; limit = total ⇒ no cursor (no trailing empty page); total − 1 ⇒ a cursor; the max clamps to 200', async () => {
      const model = await loadModel(aed.companyId);
      const customers = [...new Set(model.map((m) => m.customerId))].sort();
      const deep = await companyReport(aed, { cursor: customers[5]!, limit: 200 });
      expect(deep.customers.rows.map((r) => r.customerId)).toEqual(customers.slice(6));
      expect(deep.customers.nextCursor).toBeNull();
      const exact = await companyReport(aed, { limit: customers.length });
      expect(exact.customers.nextCursor).toBeNull();
      const short = await companyReport(aed, { limit: customers.length - 1 });
      expect(short.customers.nextCursor).toBe(customers[customers.length - 2]);
      const tail = await companyReport(aed, { cursor: short.customers.nextCursor!, limit: 5 });
      expect(tail.customers.rows.map((r) => r.customerId)).toEqual([
        customers[customers.length - 1],
      ]);
      expect(tail.customers.nextCursor).toBeNull();
      expect((await companyReport(aed, { limit: 5_000 })).customers.rows.length).toBe(
        customers.length,
      );
      expect((await companyReport(aed)).customers.rows.length).toBe(customers.length); // the default (50)
      // a cursor beyond the last customer is an empty last page
      const past = await companyReport(aed, {
        cursor: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        limit: 3,
      });
      expect(past.customers).toEqual({ rows: [], nextCursor: null });
    });

    it('INVALID_LIMIT / INVALID_CURSOR are 400s and the report is never produced', async () => {
      for (const limit of [0, -3, 1.5, '10']) {
        expect(await reject(companyReport(aed, { limit }))).toMatchObject({
          code: 'INVALID_LIMIT',
          status: 400,
        });
      }
      for (const cursor of ['nope', '123', 7]) {
        expect(await reject(companyReport(aed, { cursor }))).toMatchObject({
          code: 'INVALID_CURSOR',
          status: 400,
        });
      }
    });
  });

  // ═══════════════════ the optional customer filter ═══════════════════
  describe('the optional customer filter scopes the totals, the rows AND the GL control in one snapshot', () => {
    async function glOracleForCustomer(companyId: string, customerId: string): Promise<bigint> {
      const rows = await q<{ s: string }>(
        `WITH cr AS (
           SELECT c.id, c."invoiceId", c."cancellationChargeId", c."sourceType"
             FROM customer_receivable c JOIN customer_company_account x ON x.id = c."customerCompanyAccountId"
            WHERE c."companyId" = $1 AND x."customerId" = $2)
         SELECT COALESCE(SUM(jl."debitMinor" - jl."creditMinor"), 0)::text AS s
           FROM journal_entry je
           JOIN journal_line jl ON jl."journalEntryId" = je.id
           JOIN account a ON a.id = jl."accountId" AND a.key = 'ASSET.ACCOUNTS_RECEIVABLE'
          WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND (
                (je."sourceKind" = 'invoice_ar' AND je."sourceId" IN (SELECT "invoiceId"::text FROM cr WHERE "sourceType" = 'INVOICE'))
             OR (je."sourceKind" = 'opening_receivable' AND je."sourceId" IN (SELECT id::text FROM cr WHERE "sourceType" = 'OPENING'))
             OR (je."sourceKind" = 'cancellation_charge' AND je."sourceId" IN (SELECT "cancellationChargeId"::text FROM cr WHERE "sourceType" = 'CANCELLATION_CHARGE'))
             OR (je."sourceKind" = 'payment_allocation' AND je."sourceId" IN (SELECT pa.id::text FROM payment_allocation pa JOIN cr ON cr."invoiceId" = pa."invoiceId"))
             OR (je."sourceKind" IN ('opening_receivable_payment_application','cancellation_charge_payment_application')
                 AND je."sourceId" IN (SELECT p.id::text FROM customer_receivable_payment_application p JOIN cr ON cr.id = p."customerReceivableId"))
             OR (je."sourceKind" = 'customer_advance_application' AND je."sourceId" IN (SELECT p.id::text FROM customer_advance_application p JOIN cr ON cr.id = p."customerReceivableId"))
             OR (je."sourceKind" = 'credit_note' AND je."sourceId" IN (SELECT n.id::text FROM credit_note n JOIN cr ON cr."invoiceId" = n."invoiceId")))`,
        [companyId, customerId],
      );
      return BigInt(rows[0]!.s);
    }

    it('every customer: totals = the oracle for that customer, ONE row, and the GL control reads only that customer’s journals', async () => {
      const model = await loadModel(aed.companyId);
      for (const name of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']) {
        const id = C[name]!.customerId;
        const mine = model.filter((m) => m.customerId === id);
        const r = await companyReport(aed, { customerId: id });
        expect(r.customerId).toBe(id);
        expect(blocksOf(r), name).toEqual(expectedBlocks(mine));
        expect(r.customers.rows).toHaveLength(1);
        expect(pickFigures(r.customers.rows[0] as unknown as Figures)).toEqual(figuresOfRows(mine));
        expect(r.reconciliation.glAccountsReceivableMinor, name).toBe(
          (await glOracleForCustomer(aed.companyId, id)).toString(),
        );
        expect(r.reconciliation.reconciled).toBe(true);
        // byBranch covers only that customer's branches
        for (const row of r.byBranch) {
          expect(blocksOf(row)).toEqual(
            expectedBlocks(mine.filter((m) => m.branchId === row.branchId)),
          );
        }
      }
    });

    it('customer + branch together; a customer with no account at the company, an unknown id and another tenant’s customer are a 404', async () => {
      const c9 = C['c9']!.customerId;
      const model = await loadModel(aed.companyId);
      const r = await branchReport(aed, aed.siblingBranchId, { customerId: c9 });
      expect(blocksOf(r)).toEqual(
        expectedBlocks(
          model.filter((m) => m.customerId === c9 && m.branchId === aed.siblingBranchId),
        ),
      );
      // a customer who exists in ANOTHER company only (same tenant) has no account here
      expect(await reject(companyReport(aed, { customerId: C['o1']!.customerId }))).toMatchObject({
        status: 404,
      });
      expect(await reject(companyReport(aed, { customerId: randomUUID() }))).toMatchObject({
        status: 404,
      });
      expect(await reject(companyReport(aed, { customerId: 'not-a-uuid' }))).toMatchObject({
        status: 404,
      });
    });
  });

  // ═══════════════════ one statement, one snapshot, no PII ═══════════════════
  describe('one statement in one read-only transaction; no customer PII anywhere', () => {
    it('ONE statement in ONE transaction per report — company, branch, filtered and paged (no summary / page / GL triple, no N+1)', async () => {
      const counting = () =>
        new (class extends ReceivablesReportRepository {
          statements = 0;
          transactions = 0;
          protected override readScoped<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
            this.transactions += 1;
            return super.readScoped((tx) =>
              fn(
                new Proxy(tx as object, {
                  get: (target, prop) => {
                    const v = Reflect.get(target, prop) as unknown;
                    if (typeof v !== 'function') return v;
                    return (...args: unknown[]) => {
                      if (typeof prop === 'string' && /^\$(query|execute)/.test(prop))
                        this.statements += 1;
                      return (v as (...a: unknown[]) => unknown).apply(target, args);
                    };
                  },
                }) as ScopedTx,
              ),
            );
          }
        })(db);
      const cases: ((c: ReturnType<typeof counting>) => Promise<unknown>)[] = [
        (c) => c.getCompanyReportScoped({ companyId: aed.companyId }),
        (c) => c.getCompanyReportScoped({ companyId: aed.companyId, limit: 2 }),
        (c) => c.getBranchReportScoped({ companyId: aed.companyId, branchId: aed.branchId }),
        (c) =>
          c.getCompanyReportScoped({ companyId: aed.companyId, customerId: C['c1']!.customerId }),
      ];
      for (const run of cases) {
        const c = counting();
        await inTenant(() => run(c));
        expect([c.statements, c.transactions]).toEqual([1, 1]);
      }
    });

    it('the transaction is database-enforced read-only', async () => {
      class Probe extends ReceivablesReportRepository {
        async tryWrite(): Promise<unknown> {
          return this.readScoped((tx) =>
            tx.$executeRawUnsafe(`UPDATE branch SET name = name WHERE id = '${aed.branchId}'`),
          );
        }
      }
      await expect(inTenant(() => new Probe(db).tryWrite())).rejects.toThrow(/read-only/i);
    });

    it('NO customer name, phone, e-mail or address is returned: the whole serialized report holds only financial identifiers', async () => {
      const reports = [
        await companyReport(aed, { limit: 200 }),
        await branchReport(aed, aed.branchId, { limit: 200 }),
        await companyReport(aed, { customerId: C['c1']!.customerId }),
      ];
      for (const r of reports) {
        const text = JSON.stringify(r);
        expect(text).not.toMatch(
          /ZZ-PII-NAME|pii-example|\+9715|displayName|phone|email|address|"notes"/i,
        );
        for (const row of r.customers.rows) {
          expect(Object.keys(row).sort()).toEqual([
            'creditedMinor',
            'customerId',
            'originalMinor',
            'outstandingMinor',
            'paidByAdvanceMinor',
            'paidByPaymentMinor',
            'receivableCount',
          ]);
        }
      }
    });

    it('no aging: no ageDays, no bucket, no due date, no overdue label anywhere in the report', async () => {
      const text = JSON.stringify(await companyReport(aed, { limit: 200 }));
      expect(text).not.toMatch(/ageDays|aging|ageing|bucket|dueDate|due_date|overdue|days/i);
    });

    it('no figure is labelled sales / receipts / revenue / profit / settled', async () => {
      const r = await companyReport(aed);
      const keys =
        JSON.stringify(Object.keys(r)) +
        JSON.stringify(r.bySourceType) +
        JSON.stringify(r.reconciliation);
      expect(keys).not.toMatch(/sales|revenue|profit|settled|receiptTotal|netSales/i);
    });
  });

  // ═══════════════════ concurrency: one statement, one snapshot ═══════════════════
  describe('a report read while financial activity commits is internally consistent', () => {
    it('concurrent customer receipts (allocation + journal + application in one transaction): every report is one coherent state, never a 500, and the last equals the oracle', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const custs: Cust[] = [];
      for (let i = 0; i < 10; i++) {
        const c = await mkCustomer(co);
        await sell(
          await mkOrder(co, c.customerId, one(4_000n + BigInt(i) * 100n)),
          { intent: 'ON_CREDIT' },
          at('2026-06-10'),
        );
        custs.push(c);
      }
      const before = await companyReport(co, { limit: 200 });
      const reads: ReceivablesCompanyReport[] = [];
      const errors: unknown[] = [];
      let stop = false;
      const reader = (async () => {
        while (!stop) {
          try {
            reads.push(await companyReport(co, { limit: 200 }));
          } catch (e) {
            errors.push(e);
          }
        }
      })();
      await Promise.all(
        custs.map((c, i) =>
          receipt(
            co,
            co.branchId,
            c.customerId,
            'CASH',
            1_000n + BigInt(i) * 50n,
            at('2026-06-20'),
          ),
        ),
      );
      // a second wave: partial settlement of the REST of each invoice
      await Promise.all(
        custs.map((c) =>
          receipt(co, co.branchId, c.customerId, 'BANK_TRANSFER', 500n, at('2026-06-21')),
        ),
      );
      stop = true;
      await reader;
      const after = await companyReport(co, { limit: 200 });
      expect(errors).toEqual([]); // never a GL-mismatch / integrity 500 from a legitimate concurrent commit
      expect(reads.length).toBeGreaterThan(1);
      let lastPaid = BigInt(before.paidByPaymentMinor);
      for (const r of [before, ...reads, after]) {
        expect(r.reconciliation.reconciled).toBe(true);
        // one coherent state: outstanding = original − paid on EVERY read, and never a regression
        expect(BigInt(r.originalMinor) - BigInt(r.paidByPaymentMinor)).toBe(
          BigInt(r.outstandingMinor),
        );
        expect(BigInt(r.paidByPaymentMinor)).toBeGreaterThanOrEqual(lastPaid);
        lastPaid = BigInt(r.paidByPaymentMinor);
        expect(BigInt(r.reconciliation.glAccountsReceivableMinor)).toBe(BigInt(r.outstandingMinor));
      }
      expect(blocksOf(after)).toEqual(expectedBlocks(await loadModel(co.companyId)));
      expect(BigInt(after.paidByPaymentMinor)).toBeGreaterThan(BigInt(before.paidByPaymentMinor));
    });
  });

  // ═══════════════════ malformed financial data FAILS CLOSED ═══════════════════
  describe('a malformed receivable, application or journal fails the report closed (never repaired, non-disclosing)', () => {
    /** run statements with triggers off (the application path can never write these states) */
    async function withReplica(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
      const c = await pool.connect();
      try {
        await c.query(`SET session_replication_role = 'replica'`);
        await fn(c);
        await c.query(`SET session_replication_role = 'origin'`);
      } finally {
        c.release();
      }
    }
    const corrupt = (sql: string, params: unknown[] = []): Promise<void> =>
      withReplica(async (c) => {
        await c.query(sql, params);
      });

    async function expectIntegrity(p: Promise<unknown>, ...checks: string[]): Promise<DomainError> {
      const err = await reject(p);
      expect(err).toMatchObject({ code: 'REPORT_RECEIVABLES_SOURCE_INTEGRITY', status: 500 });
      for (const c of checks) expect(err.message).toContain(c);
      expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // non-disclosing: a check name, never an identifier
      expect((err as unknown as { details?: unknown }).details).toBeUndefined(); // and no figure at all
      return err;
    }

    interface Fresh {
      co: Co;
      cust: Cust;
      invoiceId: string;
      receivableId: string;
      order: MadeOrder;
    }
    /** a fresh company with ONE customer receivable, and a clean (reconciled) report before anything is corrupted */
    async function fresh(
      opts: {
        intent?: 'ON_CREDIT' | 'PAY_NOW';
        tenders?: Tender[];
        branch?: 'A' | 'B';
        cancel?: boolean;
      } = {},
    ): Promise<Fresh> {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const branchId = opts.branch === 'B' ? co.siblingBranchId : co.branchId;
      const order = await mkOrder(co, cust.customerId, one(4_000n), branchId);
      const s = await sell(
        order,
        { intent: opts.intent ?? 'ON_CREDIT', ...(opts.tenders ? { tenders: opts.tenders } : {}) },
        at('2026-06-10'),
      );
      if (opts.cancel) await cancel(order, at('2026-06-11'));
      const ok = await companyReport(co);
      expect(ok.reconciliation.reconciled).toBe(true);
      expect(ok.receivableCount).toBe(1);
      return {
        co,
        cust,
        invoiceId: s.invoiceId,
        receivableId: await receivableOfInvoice(s.invoiceId),
        order,
      };
    }
    const journalOf = async (kind: string, sourceId: string): Promise<string> =>
      (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = $1 AND "sourceId" = $2`,
          [kind, sourceId],
        )
      )[0]!.id;

    /** a sealed, balanced journal written with triggers off: lines = [accountKey, debit, credit, branchId] */
    async function rawJournal(
      co: Co,
      kind: string,
      sourceId: string,
      lines: readonly (readonly [string, number, number, string])[],
    ): Promise<string> {
      const entryId = randomUUID();
      await withReplica(async (c) => {
        await c.query(
          `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
           VALUES ($1,$2,$3,(SELECT id FROM accounting_period WHERE "companyId" = $3 LIMIT 1),'2026-06-10',$4,$5,$6,$7,now())`,
          [entryId, co.tenantId, co.companyId, kind, sourceId, co.currency, `raw-${entryId}`],
        );
        for (const [key, dr, cr, branchId] of lines) {
          await c.query(
            `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
             VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
            [co.tenantId, co.companyId, entryId, key, branchId, dr, cr],
          );
        }
      });
      return entryId;
    }

    it('the clean baseline: every fresh scenario reconciles (so each failure below is the corruption, nothing else)', async () => {
      for (const f of [
        await fresh(),
        await fresh({ tenders: [cash(1_000n)] }),
        await fresh({ intent: 'PAY_NOW', tenders: [card(4_200n)], cancel: true }),
        await fresh({ tenders: [cash(1_000n)], cancel: true }),
      ]) {
        expect(blocksOf(await companyReport(f.co))).toEqual(
          expectedBlocks(await loadModel(f.co.companyId)),
        );
      }
    });

    it('a currency mismatch — the receivable (invoice), an application, or a journal — is REPORT_CURRENCY_MISMATCH (409), first', async () => {
      const a = await fresh();
      await corrupt(`UPDATE invoice SET "currencyCode" = 'KWD' WHERE id = $1`, [a.invoiceId]);
      expect(await reject(companyReport(a.co))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
        status: 409,
      });
      const b = await fresh({ tenders: [cash(1_000n)] });
      await corrupt(`UPDATE payment_allocation SET "currencyCode" = 'KWD' WHERE "invoiceId" = $1`, [
        b.invoiceId,
      ]);
      expect(await reject(companyReport(b.co))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
        status: 409,
      });
      const c = await fresh();
      await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [
        await journalOf('invoice_ar', c.invoiceId),
      ]);
      expect(await reject(companyReport(c.co))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
        status: 409,
      });
    });

    it('a PaymentAllocation that exceeds the receivable, and a duplicate allocation row, fail closed', async () => {
      const a = await fresh({ tenders: [cash(1_000n)] });
      await corrupt(
        `UPDATE payment_allocation SET "amountMinor" = "amountMinor" + 100000 WHERE "invoiceId" = $1`,
        [a.invoiceId],
      );
      await expectIntegrity(companyReport(a.co), 'overCoveredReceivables');
      const b = await fresh({ tenders: [cash(1_000n)] });
      await corrupt(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         SELECT uuidv7(),"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent"
           FROM payment_allocation WHERE "invoiceId" = $1`,
        [b.invoiceId],
      );
      // the duplicate allocation has no AR journal of its own: the control proves it
      await expectIntegrity(companyReport(b.co), 'missingJournals');
    });

    it('a CustomerAdvance over-application fails closed', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const rec = await receipt(co, co.branchId, cust.customerId, 'CASH', 3_000n, at('2026-06-10'));
      const advanceId = await convertToAdvance(
        co,
        co.branchId,
        cust.customerId,
        rec.paymentId,
        3_000n,
      );
      const s = await sell(
        await mkOrder(co, cust.customerId, one(2_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-11'),
      );
      await applyAdvance(
        co,
        co.branchId,
        cust.customerId,
        advanceId,
        await receivableOfInvoice(s.invoiceId),
        1_000n,
      );
      expect((await companyReport(co)).paidByAdvanceMinor).toBe('1000');
      await corrupt(
        `UPDATE customer_advance_application SET "amountMinor" = "amountMinor" + 100000 WHERE "companyId" = $1`,
        [co.companyId],
      );
      await expectIntegrity(companyReport(co), 'overCoveredReceivables');
    });

    it('a CreditNote AR reduction larger than the valid amount fails closed (the over-reduction is never trusted)', async () => {
      const f = await fresh({ tenders: [cash(1_000n)], cancel: true });
      const cn = (
        await q<{ id: string; total: string; ar: string; excess: string }>(
          `SELECT id, "totalAmountMinor"::text AS total, "arReductionMinor"::text AS ar, "advanceExcessMinor"::text AS excess
             FROM credit_note WHERE "invoiceId" = $1`,
          [f.invoiceId],
        )
      )[0]!;
      expect(BigInt(cn.ar)).toBeGreaterThan(0n);
      expect(BigInt(cn.excess)).toBeGreaterThan(0n);
      // the same-row CHECK (ar + excess = total) stays satisfied: move the whole excess into the AR reduction
      await corrupt(
        `UPDATE credit_note SET "arReductionMinor" = "totalAmountMinor", "advanceExcessMinor" = 0 WHERE id = $1`,
        [cn.id],
      );
      await expectIntegrity(companyReport(f.co), 'overCoveredReceivables');
    });

    it('a missing authoritative GL source (the AR line is gone), an unsealed journal, a wrong sourceId and an unresolvable principal each fail closed', async () => {
      const a = await fresh();
      await corrupt(
        `DELETE FROM journal_line WHERE "journalEntryId" = $1 AND "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = $3)`,
        [await journalOf('invoice_ar', a.invoiceId), a.co.companyId, 'ASSET.ACCOUNTS_RECEIVABLE'],
      );
      await expectIntegrity(companyReport(a.co), 'missingJournals');
      const b = await fresh();
      await corrupt(`UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1`, [
        await journalOf('invoice_ar', b.invoiceId),
      ]);
      await expectIntegrity(companyReport(b.co), 'missingJournals');
      const c = await fresh();
      await corrupt(`UPDATE journal_entry SET "sourceId" = $2 WHERE id = $1`, [
        await journalOf('invoice_ar', c.invoiceId),
        randomUUID(),
      ]);
      const company = await expectIntegrity(companyReport(c.co), 'missingJournals');
      expect(company.message).toContain('orphanJournals'); // unattributable → the company report only
      const branch = await expectIntegrity(branchReport(c.co, c.co.branchId), 'missingJournals');
      expect(branch.message).not.toContain('orphanJournals');
      const d = await fresh();
      await corrupt(`UPDATE customer_receivable SET "invoiceId" = $2 WHERE id = $1`, [
        d.receivableId,
        randomUUID(),
      ]);
      await expectIntegrity(companyReport(d.co), 'unresolvedPrincipals');
    });

    it('a duplicate authoritative AR journal is impossible at the database (unique source index); a duplicate AR EFFECT inside a journal fails the shape control', async () => {
      const f = await fresh();
      const entryId = await journalOf('invoice_ar', f.invoiceId);
      await expect(
        withReplica(async (c) => {
          await c.query(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
             SELECT uuidv7(),"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode",'dup-' || id::text,now()
               FROM journal_entry WHERE id = $1`,
            [entryId],
          );
        }),
      ).rejects.toMatchObject({ code: '23505' });
      // an extra balanced Dr AR / Cr revenue pair on the real journal: the AR effect is doubled
      for (const [key, dr, cr] of [
        ['ASSET.ACCOUNTS_RECEIVABLE', 5, 0],
        ['REVENUE.SALES', 0, 5],
      ] as const) {
        await corrupt(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
           VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
          [f.co.tenantId, f.co.companyId, entryId, key, f.co.branchId, dr, cr],
        );
      }
      await expectIntegrity(companyReport(f.co), 'journalShapeMismatches');
    });

    it('an EXACT duplicate of the AR line inside one journal (same amount, balanced by revenue) is a named shape defect — never a silent doubling of the GL figure', async () => {
      const f = await fresh();
      const entryId = await journalOf('invoice_ar', f.invoiceId);
      const amount = (
        await q<{ d: string }>(
          `SELECT l."debitMinor"::text AS d FROM journal_line l
             JOIN account a ON a.id = l."accountId" AND a.key = 'ASSET.ACCOUNTS_RECEIVABLE'
            WHERE l."journalEntryId" = $1`,
          [entryId],
        )
      )[0]!.d;
      for (const [key, dr, cr] of [
        ['ASSET.ACCOUNTS_RECEIVABLE', amount, '0'],
        ['REVENUE.SALES', '0', amount],
      ] as const) {
        await corrupt(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
           VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
          [f.co.tenantId, f.co.companyId, entryId, key, f.co.branchId, dr, cr],
        );
      }
      // every (fact, line) pair equals the fact on its own — only the surplus line itself reveals the defect
      await expectIntegrity(companyReport(f.co), 'journalShapeMismatches');
    });

    it('an unsealed journal is no authority for a branch- or customer-filtered report either (the fact has no sealed journal)', async () => {
      const f = await fresh();
      await corrupt(`UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1`, [
        await journalOf('invoice_ar', f.invoiceId),
      ]);
      await expectIntegrity(branchReport(f.co, f.co.branchId), 'missingJournals');
      await expectIntegrity(
        companyReport(f.co, { customerId: f.cust.customerId }),
        'missingJournals',
      );
      await expectIntegrity(companyReport(f.co), 'missingJournals');
    });

    it('a same-tenant foreign-company row of every source table (receivable, receivable payment application, advance application, credit note) never contributes and never fails the report', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const other = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      // INVOICE receivable 1: an allocation + an advance application
      const rcpt = await receipt(
        co,
        co.branchId,
        cust.customerId,
        'CASH',
        3_000n,
        at('2026-06-09'),
      );
      const advanceId = await convertToAdvance(
        co,
        co.branchId,
        cust.customerId,
        rcpt.paymentId,
        2_000n,
      );
      const s1 = await sell(
        await mkOrder(co, cust.customerId, one(4_000n)),
        { intent: 'ON_CREDIT', tenders: [cash(1_000n)] },
        at('2026-06-10'),
      );
      await applyAdvance(
        co,
        co.branchId,
        cust.customerId,
        advanceId,
        await receivableOfInvoice(s1.invoiceId),
        500n,
      );
      // INVOICE receivable 2: a cancellation that issues a CreditNote with an AR reduction
      const o2 = await mkOrder(co, cust.customerId, one(4_000n));
      const s2 = await sell(o2, { intent: 'ON_CREDIT', tenders: [cash(1_000n)] }, at('2026-06-10'));
      await cancel(o2, at('2026-06-11'));
      // OPENING receivable: a receivable payment application
      const cust2 = await mkCustomer(co);
      const opening = await openingReceivable(
        co,
        co.branchId,
        cust2.customerId,
        2_000n,
        '2026-05-15',
      );
      await receipt(co, co.branchId, cust2.customerId, 'CASH', 700n, at('2026-06-12'));

      for (const [table, where, param] of [
        ['payment_allocation', '"invoiceId" = $3', s1.invoiceId],
        [
          'customer_advance_application',
          '"customerReceivableId" = $3',
          await receivableOfInvoice(s1.invoiceId),
        ],
        ['credit_note', '"invoiceId" = $3', s2.invoiceId],
        ['customer_receivable_payment_application', '"customerReceivableId" = $3', opening],
        ['customer_receivable', 'id = $3', opening],
      ] as const) {
        const n = await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE ${where.replace('$3', '$1')}`,
          [param],
        );
        expect(Number(n[0]!.n), `the world holds a ${table} row to copy`).toBeGreaterThan(0);
      }
      const model = expectedBlocks(await loadModel(co.companyId));
      const clean = await companyReport(co);
      expect(blocksOf(clean)).toEqual(model);
      expect(clean.reconciliation.reconciled).toBe(true);
      expect(clean.receivableCount).toBe(3);

      /** copy the rows of a table into ANOTHER company of the same tenant, still pointing at this company's documents */
      const copyToOther = (
        table: string,
        where: string,
        param: string,
        extra: Record<string, unknown>,
      ): Promise<void> =>
        corrupt(
          `INSERT INTO ${table}
           SELECT (jsonb_populate_record(NULL::${table},
                    to_jsonb(t) || jsonb_build_object('id', uuidv7()::text, 'companyId', $1::text) || $2::jsonb)).*
             FROM ${table} t WHERE ${where}`,
          [other.companyId, JSON.stringify(extra), param],
        );
      for (const [table, where, param, extra] of [
        ['payment_allocation', '"invoiceId" = $3', s1.invoiceId, { amountMinor: 777 }],
        [
          'customer_advance_application',
          '"customerReceivableId" = $3',
          await receivableOfInvoice(s1.invoiceId),
          { amountMinor: 777 },
        ],
        ['credit_note', '"invoiceId" = $3', s2.invoiceId, {}],
        [
          'customer_receivable_payment_application',
          '"customerReceivableId" = $3',
          opening,
          { amountMinor: 777 },
        ],
        ['customer_receivable', 'id = $3', opening, { openingAmountMinor: 999 }],
      ] as const) {
        await copyToOther(table, where, param, extra);
        const r = await companyReport(co);
        expect(blocksOf(r), `${table}: a foreign-company copy changed a figure`).toEqual(model);
        expect(r.reconciliation.reconciled, table).toBe(true);
        expect(r.receivableCount, table).toBe(3);
      }
    });

    it('a receivable whose invoice, journal line or AR account belongs to ANOTHER company of the same tenant fails closed (the explicit company predicate of each join)', async () => {
      const other = await makeCompany(tenantId, { currency: 'AED' });
      const a = await fresh();
      await corrupt(`UPDATE invoice SET "companyId" = $2 WHERE id = $1`, [
        a.invoiceId,
        other.companyId,
      ]);
      await expectIntegrity(companyReport(a.co), 'unresolvedPrincipals');
      const b = await fresh();
      await corrupt(
        `UPDATE journal_line SET "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'ASSET.ACCOUNTS_RECEIVABLE')
          WHERE "journalEntryId" = $1
            AND "accountId" = (SELECT id FROM account WHERE "companyId" = $3 AND key = 'ASSET.ACCOUNTS_RECEIVABLE')`,
        [await journalOf('invoice_ar', b.invoiceId), other.companyId, b.co.companyId],
      );
      await expectIntegrity(companyReport(b.co), 'missingJournals');
      const c = await fresh();
      await corrupt(
        `UPDATE journal_line SET "companyId" = $2
          WHERE "journalEntryId" = $1
            AND "accountId" = (SELECT id FROM account WHERE "companyId" = $3 AND key = 'ASSET.ACCOUNTS_RECEIVABLE')`,
        [await journalOf('invoice_ar', c.invoiceId), other.companyId, c.co.companyId],
      );
      await expectIntegrity(companyReport(c.co), 'missingJournals');
    });

    it('wrong branch attribution fails closed — the journal line, the application, or the source document', async () => {
      const a = await fresh();
      await corrupt(`UPDATE journal_line SET "branchId" = $2 WHERE "journalEntryId" = $1`, [
        await journalOf('invoice_ar', a.invoiceId),
        a.co.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(a.co), 'journalBranchMismatches');
      const b = await fresh({ tenders: [cash(1_000n)] });
      await corrupt(`UPDATE payment_allocation SET "branchId" = $2 WHERE "invoiceId" = $1`, [
        b.invoiceId,
        b.co.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(b.co), 'applicationBranchMismatches');
      const c = await fresh();
      await corrupt(`UPDATE invoice SET "branchId" = $2 WHERE id = $1`, [
        c.invoiceId,
        c.co.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(c.co), 'sourceBranchMismatches');
    });

    it('an unknown source type is blocked by the database CHECK (a closed set); a Payment application on an INVOICE receivable fails closed', async () => {
      const a = await fresh();
      await expect(
        corrupt(`UPDATE customer_receivable SET "sourceType" = 'GIFT' WHERE id = $1`, [
          a.receivableId,
        ]),
      ).rejects.toThrow(/check|constraint/i);
      const b = await fresh({ tenders: [cash(1_000n)] });
      const payment = (
        await q<{ id: string }>(
          `SELECT "paymentId" AS id FROM payment_allocation WHERE "invoiceId" = $1`,
          [b.invoiceId],
        )
      )[0]!.id;
      await corrupt(
        `INSERT INTO customer_receivable_payment_application (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,10,'AED',2)`,
        [b.co.tenantId, b.co.companyId, b.co.branchId, b.cust.ccaId, payment, b.receivableId],
      );
      await expectIntegrity(companyReport(b.co), 'paymentApplicationsOnInvoiceReceivables');
    });

    it('a CreditNote that reduces AR with NO receivable (a walk-in invoice) fails closed; an orphan authoritative-kind journal fails the unfiltered company report ONLY', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      await sell(
        await mkOrder(co, cust.customerId, one(1_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      const walkIn = await sell(
        await mkOrder(co, null, one(2_000n)),
        { tenders: [cash(2_100n)] },
        at('2026-06-10'),
      );
      expect((await companyReport(co)).receivableCount).toBe(1);
      // an orphan journal of an authoritative kind that carries an AR line and has no source fact
      await rawJournal(co, 'payment_allocation', randomUUID(), [
        ['LIABILITY.UNAPPLIED_RECEIPTS', 40, 0, co.branchId],
        ['ASSET.ACCOUNTS_RECEIVABLE', 0, 40, co.branchId],
      ]);
      await expectIntegrity(companyReport(co), 'orphanJournals'); // the unfiltered company report
      // a branch / customer-filtered report cannot attribute it, so it does not carry the defect
      expect((await branchReport(co, co.branchId)).reconciliation.reconciled).toBe(true);
      expect(
        (await companyReport(co, { customerId: cust.customerId })).reconciliation.reconciled,
      ).toBe(true);
      // a CreditNote with an AR reduction on the WALK-IN invoice (no receivable exists to reduce)
      await corrupt(
        `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate",
                                  "currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor",
                                  "arReductionMinor","advanceExcessMinor")
         VALUES (uuidv7(),$1,$2,$3,$4,'CN-RAW-1',now(),'2026-06-10','AED',2,'OTHER',100,0,100,100,0)`,
        [co.tenantId, co.companyId, co.branchId, walkIn.invoiceId],
      );
      const err = await expectIntegrity(
        branchReport(co, co.branchId),
        'creditNotesWithoutReceivable',
      );
      expect(err.message).not.toContain('orphanJournals');
    });

    it('a manual / unrelated journal that happens to hit the AR account is NOT part of the control (the control reads only the authoritative AR sources)', async () => {
      const f = await fresh({ tenders: [cash(1_000n)] });
      const before = await companyReport(f.co);
      await rawJournal(f.co, 'manual_adjustment', randomUUID(), [
        ['ASSET.ACCOUNTS_RECEIVABLE', 777, 0, f.co.branchId],
        ['REVENUE.SALES', 0, 777, f.co.branchId],
      ]);
      const after = await companyReport(f.co);
      expect(blocksOf(after)).toEqual(blocksOf(before));
      expect(after.reconciliation).toEqual(before.reconciliation);
      expect(after.reconciliation.reconciled).toBe(true);
      // the AR ACCOUNT now carries 777 more than the authoritative sources — a whole-account control would have failed
      expect(await glAllKinds(f.co.companyId)).toBe(
        BigInt(after.reconciliation.glAccountsReceivableMinor) + 777n,
      );
    });

    it('a foreign-company or foreign-tenant row that points at this company’s documents never contributes (and never fails the report)', async () => {
      const f = await fresh({ tenders: [cash(1_000n)] });
      const other = await makeCompany(tenantId, { currency: 'AED' });
      const model = expectedBlocks(await loadModel(f.co.companyId));
      for (const [tid, cid] of [
        [f.co.tenantId, other.companyId], // same tenant, another company
        [foreign.tenantId, foreign.companyId], // another tenant
      ] as const) {
        await corrupt(
          `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
           SELECT uuidv7(),$2,$3,$4,"paymentId","invoiceId",777,"currencyCode","currencyExponent" FROM payment_allocation WHERE "invoiceId" = $1`,
          [f.invoiceId, tid, cid, tid === f.co.tenantId ? other.branchId : foreign.branchId],
        );
        const r = await companyReport(f.co);
        expect(blocksOf(r)).toEqual(model);
        expect(r.reconciliation.reconciled).toBe(true);
      }
    });

    it('a malformed item in Branch B neither fails nor discloses itself in a healthy Branch A report; Branch B and the Company fail closed', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const ca = await mkCustomer(co);
      const cb = await mkCustomer(co);
      await sell(
        await mkOrder(co, ca.customerId, one(4_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      const sb = await sell(
        await mkOrder(co, cb.customerId, one(3_000n), co.siblingBranchId),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      const okA = await branchReport(co, co.branchId);
      await corrupt(`UPDATE journal_line SET "branchId" = $2 WHERE "journalEntryId" = $1`, [
        await journalOf('invoice_ar', sb.invoiceId),
        co.branchId,
      ]);
      const a = await branchReport(co, co.branchId);
      expect(blocksOf(a)).toEqual(blocksOf(okA));
      expect(a.reconciliation.reconciled).toBe(true);
      await expectIntegrity(branchReport(co, co.siblingBranchId), 'journalBranchMismatches');
      await expectIntegrity(companyReport(co), 'journalBranchMismatches');
    });

    it('a company without an accounting currency / timezone fails closed (REPORT_COMPANY_NOT_CONFIGURED)', async () => {
      const bare = randomUUID();
      await pool.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
         VALUES ($1,$2,'Bare','AE',NULL,'Asia/Dubai','ACTIVE',now())`,
        [bare, tenantId],
      );
      expect(
        await reject(inTenant(() => service.companyReport({ companyId: bare }))),
      ).toMatchObject({
        code: 'REPORT_COMPANY_NOT_CONFIGURED',
        status: 409,
      });
    });
  });

  // ═══════════════════ RD-1 — the density guard: at most RECEIVABLES_REPORT_MAX_RECEIVABLES receivables per EVALUATED scope ═══════════════════
  describe('the density guard (owner ruling RD-1): at most RECEIVABLES_REPORT_MAX_RECEIVABLES CustomerReceivable records in the evaluated scope', () => {
    /** a repository with another limit (the protected seam) — only tests pass one; production uses the constant */
    const limited = (n: number): ReceivablesReportRepository =>
      new (class extends ReceivablesReportRepository {
        protected override readonly maxReceivables: number = n;
      })(db);
    type Extra = { customerId?: string | null; cursor?: unknown; limit?: unknown };
    const companyWith = (n: number, co: Co, extra: Extra = {}): Promise<ReceivablesCompanyReport> =>
      inTenant(
        () => limited(n).getCompanyReportScoped({ companyId: co.companyId, ...extra }),
        co.tenantId,
      );
    const branchWith = (
      n: number,
      co: Co,
      branchId: string,
      extra: Extra = {},
    ): Promise<ReceivablesBranchReport> =>
      inTenant(
        () => limited(n).getBranchReportScoped({ companyId: co.companyId, branchId, ...extra }),
        co.tenantId,
      );
    const TOO_LARGE = { code: 'REPORT_RESULT_TOO_LARGE', status: 422 };
    const detailsOf = (n: number) => [
      { field: 'maxReceivables', issue: String(n) },
      { field: 'action', issue: 'narrow_scope' },
    ];

    // ONE company whose receivables have a known size per branch and per customer (7 in all):
    //   Branch A: d1 ×2 + d2 ×1 = 3     Branch B: d1 ×1 + d3 ×3 = 4     customers: d1 = 3, d2 = 1, d3 = 3
    let dco: Co;
    let d1: Cust;
    let d2: Cust;
    let d3: Cust;
    beforeAll(async () => {
      dco = await makeCompany(tenantId, { currency: 'AED' });
      d1 = await mkCustomer(dco);
      d2 = await mkCustomer(dco);
      d3 = await mkCustomer(dco);
      const sellOn = async (c: Cust, branchId: string, n: number): Promise<void> => {
        for (let i = 0; i < n; i++) {
          await sell(
            await mkOrder(dco, c.customerId, one(1_000n), branchId),
            { intent: 'ON_CREDIT' },
            at('2026-06-10'),
          );
        }
      };
      await sellOn(d1, dco.branchId, 2);
      await sellOn(d2, dco.branchId, 1);
      await sellOn(d1, dco.siblingBranchId, 1);
      await sellOn(d3, dco.siblingBranchId, 3);
    }, 600_000);

    it('the world has exactly the intended scope sizes (the oracle: CustomerReceivable rows per company / branch / customer)', async () => {
      const count = async (where: string, ...p: unknown[]): Promise<number> =>
        Number(
          (
            await q<{ n: string }>(
              `SELECT count(*)::text AS n FROM customer_receivable cr
                 JOIN customer_company_account x ON x.id = cr."customerCompanyAccountId"
                WHERE cr."companyId" = $1 ${where}`,
              [dco.companyId, ...p],
            )
          )[0]!.n,
        );
      expect(await count('')).toBe(7);
      expect(await count(`AND cr."branchId" = $2`, dco.branchId)).toBe(3);
      expect(await count(`AND cr."branchId" = $2`, dco.siblingBranchId)).toBe(4);
      expect(await count(`AND x."customerId" = $2`, d1.customerId)).toBe(3);
      expect(await count(`AND x."customerId" = $2`, d2.customerId)).toBe(1);
      expect(await count(`AND x."customerId" = $2`, d3.customerId)).toBe(3);
    });

    it('the limit is the one v1 constant, 100 000 — the production repository default, an independent constant of every other report limit', async () => {
      expect(RECEIVABLES_REPORT_MAX_RECEIVABLES).toBe(100_000);
      class Peek extends ReceivablesReportRepository {
        limit(): number {
          return this.maxReceivables;
        }
      }
      expect(new Peek(db).limit()).toBe(RECEIVABLES_REPORT_MAX_RECEIVABLES);
    });

    it('company scope: exactly the limit is accepted (the same figures as the unguarded report) and ONE more is rejected', async () => {
      const unguarded = await companyReport(dco, { limit: 200 });
      const atLimit = await companyWith(7, dco, { limit: 200 });
      expect(blocksOf(atLimit)).toEqual(blocksOf(unguarded));
      expect(atLimit.byBranch).toEqual(unguarded.byBranch);
      expect(atLimit.customers).toEqual(unguarded.customers);
      expect(atLimit.receivableCount).toBe(7);
      expect(await reject(companyWith(6, dco))).toMatchObject(TOO_LARGE);
    });

    it('branch scope is SCOPE-LOCAL: sibling branches never contribute — each branch is judged on its own receivables', async () => {
      // the company (7) is over a limit of 6, yet Branch A (3) and Branch B (4) are each within it
      expect(await reject(companyWith(6, dco))).toMatchObject(TOO_LARGE);
      const a = await branchWith(6, dco, dco.branchId);
      const b = await branchWith(6, dco, dco.siblingBranchId);
      expect(a.receivableCount).toBe(3);
      expect(b.receivableCount).toBe(4);
      // exactly the branch size is accepted, one fewer rejected — Branch A (3) still fine where Branch B (4) is not
      expect(blocksOf(await branchWith(3, dco, dco.branchId))).toEqual(blocksOf(a));
      expect(await reject(branchWith(3, dco, dco.siblingBranchId))).toMatchObject(TOO_LARGE);
      expect(await reject(branchWith(2, dco, dco.branchId))).toMatchObject(TOO_LARGE);
      expect(blocksOf(await branchWith(4, dco, dco.siblingBranchId))).toEqual(blocksOf(b));
    });

    it('customer-filtered scope is SCOPE-LOCAL: judged on the customer’s own receivables after the company / branch filter', async () => {
      // company is over a limit of 3 (7), a customer of 3 / 1 / 3 receivables is not
      expect(await reject(companyWith(3, dco))).toMatchObject(TOO_LARGE);
      for (const [c, n] of [
        [d1, 3],
        [d2, 1],
        [d3, 3],
      ] as const) {
        const r = await companyWith(3, dco, { customerId: c.customerId });
        expect(r.receivableCount).toBe(n);
        expect(r.customers.rows.map((x) => x.customerId)).toEqual([c.customerId]);
      }
      // one fewer than the customer holds → rejected; a smaller customer still passes the same limit
      expect(await reject(companyWith(2, dco, { customerId: d1.customerId }))).toMatchObject(
        TOO_LARGE,
      );
      expect(await reject(companyWith(2, dco, { customerId: d3.customerId }))).toMatchObject(
        TOO_LARGE,
      );
      expect((await companyWith(2, dco, { customerId: d2.customerId })).receivableCount).toBe(1);
      // customer + branch: d1 holds 2 in Branch A and 1 in Branch B — the scope is the intersection
      expect(
        (await branchWith(2, dco, dco.branchId, { customerId: d1.customerId })).receivableCount,
      ).toBe(2);
      expect(
        (await branchWith(1, dco, dco.siblingBranchId, { customerId: d1.customerId }))
          .receivableCount,
      ).toBe(1);
      expect(
        await reject(branchWith(1, dco, dco.branchId, { customerId: d1.customerId })),
      ).toMatchObject(TOO_LARGE);
      // d3's three receivables are all in Branch B
      expect(
        await reject(branchWith(2, dco, dco.siblingBranchId, { customerId: d3.customerId })),
      ).toMatchObject(TOO_LARGE);
      expect(
        (await branchWith(3, dco, dco.siblingBranchId, { customerId: d3.customerId }))
          .receivableCount,
      ).toBe(3);
    });

    it('the page size never decides the guard: a page of 1 over an accepted scope, a page of 200 over a rejected one', async () => {
      const small = await companyWith(7, dco, { limit: 1 });
      expect(small.receivableCount).toBe(7); // the summary is the whole scope although the page holds one customer
      expect(small.customers.rows).toHaveLength(1);
      expect(small.customers.nextCursor).not.toBeNull();
      expect(await reject(companyWith(6, dco, { limit: 1 }))).toMatchObject(TOO_LARGE);
      expect(await reject(companyWith(6, dco, { limit: 200 }))).toMatchObject(TOO_LARGE);
      expect(await reject(companyWith(6, dco, { limit: 2 }))).toMatchObject(TOO_LARGE);
    });

    it('the rejection is generic and non-disclosing: the limit and a narrowing hint, never the actual count, a sibling, a customer, an id or a figure', async () => {
      const cases: [string, number, number, Promise<DomainError>][] = [
        ['company', 5, 7, reject(companyWith(5, dco))],
        ['branch', 3, 4, reject(branchWith(3, dco, dco.siblingBranchId))],
        ['customer', 2, 3, reject(companyWith(2, dco, { customerId: d1.customerId }))],
      ];
      for (const [route, limit, actual, p] of cases) {
        const e = await p;
        expect(e, route).toMatchObject(TOO_LARGE);
        expect(e.details, route).toEqual(detailsOf(limit));
        const text = JSON.stringify({ message: e.message, details: e.details });
        expect(text, route).not.toMatch(new RegExp(`\\b${actual}\\b`));
        expect(text, route).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
        expect(text, route).not.toMatch(/Minor|outstanding|original|credited|paid/i);
      }
      // at one limit the three routes answer in IDENTICAL words
      const words = [
        await reject(companyWith(0, dco)),
        await reject(branchWith(0, dco, dco.siblingBranchId)),
        await reject(companyWith(0, dco, { customerId: d1.customerId })),
      ].map((e) => `${e.code}|${e.status}|${e.message}|${JSON.stringify(e.details)}`);
      expect(new Set(words).size).toBe(1);
    });

    it('a missing company, a branch of another company and a customer with no account here are still plain 404s — never a density answer', async () => {
      await expect(
        inTenant(() => limited(0).getCompanyReportScoped({ companyId: randomUUID() })),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        inTenant(() =>
          limited(0).getBranchReportScoped({ companyId: dco.companyId, branchId: aed.branchId }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      const stranger = await mkCustomer(aed2);
      await expect(
        inTenant(() =>
          limited(0).getCompanyReportScoped({
            companyId: dco.companyId,
            customerId: stranger.customerId,
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('an empty scope is within every limit, even 0', async () => {
      const empty = await makeCompany(tenantId, { currency: 'AED' });
      const r = await companyWith(0, empty);
      expect(r.receivableCount).toBe(0);
      expect(r.reconciliation.reconciled).toBe(true);
    });

    it('a rejected report is ONE statement in ONE read-only transaction and writes nothing; the accepted one is too', async () => {
      const counting = (n: number) =>
        new (class extends ReceivablesReportRepository {
          statements = 0;
          transactions = 0;
          protected override readonly maxReceivables: number = n;
          protected override readScoped<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
            this.transactions += 1;
            return super.readScoped((tx) =>
              fn(
                new Proxy(tx as object, {
                  get: (target, prop) => {
                    const v = Reflect.get(target, prop) as unknown;
                    if (typeof v !== 'function') return v;
                    return (...args: unknown[]) => {
                      if (typeof prop === 'string' && /^\$(query|execute)/.test(prop))
                        this.statements += 1;
                      return (v as (...a: unknown[]) => unknown).apply(target, args);
                    };
                  },
                }) as ScopedTx,
              ),
            );
          }
        })(db);
      const before = await q<{ n: string }>(
        `SELECT (SELECT count(*) FROM audit_log)::text || ':' || (SELECT count(*) FROM outbox)::text AS n`,
      );
      for (const [n, rejected] of [
        [6, true],
        [7, false],
      ] as const) {
        const c = counting(n);
        const run = inTenant(
          () => c.getCompanyReportScoped({ companyId: dco.companyId }),
          dco.tenantId,
        );
        if (rejected) expect(await reject(run)).toMatchObject(TOO_LARGE);
        else await run;
        expect([c.statements, c.transactions], `limit ${n}`).toEqual([1, 1]);
      }
      expect(
        await q<{ n: string }>(
          `SELECT (SELECT count(*) FROM audit_log)::text || ':' || (SELECT count(*) FROM outbox)::text AS n`,
        ),
      ).toEqual(before);
    });

    it('the over-limit answer PRECEDES the integrity analysis: a malformed scope is rejected for its size, and is reported once it is within the limit', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const s = await sell(
        await mkOrder(co, cust.customerId, one(4_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      const entryId = (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = 'invoice_ar' AND "sourceId" = $1`,
          [s.invoiceId],
        )
      )[0]!.id;
      const c = await pool.connect();
      try {
        await c.query(`SET session_replication_role = 'replica'`);
        await c.query(
          `DELETE FROM journal_line WHERE "journalEntryId" = $1 AND "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'ASSET.ACCOUNTS_RECEIVABLE')`,
          [entryId, co.companyId],
        );
        await c.query(`SET session_replication_role = 'origin'`);
      } finally {
        c.release();
      }
      // within the limit: the malformed scope fails its integrity check
      expect(await reject(companyWith(1, co))).toMatchObject({
        code: 'REPORT_RECEIVABLES_SOURCE_INTEGRITY',
        status: 500,
      });
      // above the limit: no financial analysis is made — the size answer comes first
      expect(await reject(companyWith(0, co))).toMatchObject(TOO_LARGE);
    });
  });
});
