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
import { computePaymentConsumption } from '../receivables/payment-consumption.js';
import { computeAdvanceBalance } from '../receivables/receivable-balance.js';
import { CustomerReceiptEffectsRepository } from '../receivables/customer-receipt-effects.repository.js';
import { RefundAttemptReservationRepository } from '../receivables/refund-attempt-reservation.repository.js';
import {
  CustomerLiabilitiesReportRepository,
  type LiabilitiesBranchReport,
  type LiabilitiesCompanyReport,
} from './customer-liabilities-report.repository.js';
import { CustomerLiabilitiesReportService } from './customer-liabilities-report.service.js';
import { LIABILITIES_REPORT_NOTE } from './customer-liabilities-report.js';
import { CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS } from './customer-liabilities-report.sql.js';
import { ReceivablesReportRepository } from './receivables-report.repository.js';
import { TenderTotalsReportRepository } from './tender-totals-report.repository.js';

/**
 * Task 3b.10 Checkpoint E — CUSTOMER ADVANCES + UNAPPLIED RECEIPTS current state over REAL documents.
 *
 * Every advance, receipt, allocation, application, conversion, CreditNote and refund is created through the frozen public
 * flows (`complete-sale`, the customer receipt route, the opening-balance route, the Payment → Advance conversion route,
 * the Advance application route, order `cancel` — a CreditNote whose excess becomes an Advance — and the local refund
 * route) on the full `AppModule`, with the real role grants, real PostgreSQL and real Redis, and a scripted clock. The one
 * provider-backed fixture (no real provider adapter exists) is raw-seeded and then driven through the frozen effects and
 * the internal reservation primitives. The expected figures come from a MODEL ORACLE: every advance, payment and source row
 * is read back table by table and folded with the FROZEN helpers (`computeAdvanceBalance`, `computePaymentConsumption`) in
 * plain TypeScript — independent of the report's single SQL statement — and each GL side is summed straight from the
 * journal lines of ITS OWN account and the authoritative source kinds, typed here independently of the production module.
 */
const DEFAULT_INSTANT = new Date('2026-06-10T10:00:00.000Z');
const at = (isoDate: string, hourUtc = 10): Date =>
  new Date(`${isoDate}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`);

/** the authoritative journal kinds of each liability account — typed here independently of the production module */
const ADV_ACCOUNT = 'LIABILITY.CUSTOMER_ADVANCES';
const UNAPPLIED_ACCOUNT = 'LIABILITY.UNAPPLIED_RECEIPTS';
const ADV_KINDS = [
  'customer_advance',
  'opening_advance',
  'credit_note',
  'customer_advance_application',
  'refund',
];
const UNAPPLIED_KINDS = [
  'customer_receipt_payment',
  'payment_allocation',
  'opening_receivable_payment_application',
  'cancellation_charge_payment_application',
  'customer_advance',
];

describe('Customer liabilities — task 3b.10 Checkpoint E (real documents, real PostgreSQL)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let pool: pg.Pool;
  let db: DbService;
  let prisma: PrismaClient;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let repo: CustomerLiabilitiesReportRepository;
  let service: CustomerLiabilitiesReportService;

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
  let aed: Co; // the main company: two branches, the full liability matrix
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
  // ── E-specific flows ──────────────────────────────────────────────────────────────────────────────
  /** the opening-balance route with `type: 'ADVANCE'` — an OPENING-origin CustomerAdvance */
  async function openingAdvance(
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
      { type: 'ADVANCE', amountMinor: amount.toString(), effectiveDate, note: 'opening advance' },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    return (
      await q<{ id: string }>(
        `SELECT ca.id FROM customer_advance ca JOIN customer_company_account x ON x.id = ca."customerCompanyAccountId"
          WHERE ca."branchId" = $1 AND x."customerId" = $2 AND ca."sourceType" = 'OPENING'`,
        [branchId, customerId],
      )
    )[0]!.id;
  }

  /** the CREDIT_NOTE-sourced Advances an order's cancellation created (one per released coverage source) */
  const advancesOfOrder = async (orderId: string): Promise<string[]> =>
    (
      await q<{ id: string }>(
        `SELECT ca.id FROM customer_advance ca
           JOIN credit_note_coverage_release r ON r."customerAdvanceId" = ca.id
           JOIN credit_note cn ON cn.id = r."creditNoteId"
           JOIN invoice i ON i.id = cn."invoiceId"
          WHERE i."orderId" = $1 ORDER BY ca.id`,
        [orderId],
      )
    ).map((r) => r.id);

  /** a PAID customer sale cancelled: the CreditNote excess becomes ONE CREDIT_NOTE-origin Advance */
  async function paidThenCancelledAdvance(
    co: Co,
    cust: Cust,
    branchId: string,
    tenders: Tender[],
    priceMinor = 2_000n,
  ): Promise<{ advanceId: string; order: MadeOrder; invoiceId: string }> {
    const order = await mkOrder(co, cust.customerId, one(priceMinor), branchId);
    const s = await sell(order, { tenders }, at('2026-06-10'));
    await cancel(order, at('2026-06-11'));
    const ids = await advancesOfOrder(order.orderId);
    expect(ids).toHaveLength(1);
    return { advanceId: ids[0]!, order, invoiceId: s.invoiceId };
  }

  /**
   * A PROVIDER-BACKED CreditNote Advance: there is no real provider adapter, so the provider Payment is raw-seeded and then
   * driven through the FROZEN effects (the receipt and allocation journals, the account chronology), a FINALIZED settlement
   * and the order cancellation — exactly the Tender suite's fixture, completed with its journals.
   */
  async function providerBackedCnAdvance(
    co: Co,
    branchId: string,
    cust: Cust,
  ): Promise<{ advanceId: string; paymentId: string }> {
    const s = await sell(
      await mkOrder(co, cust.customerId, one(2_000n), branchId),
      { intent: 'ON_CREDIT' },
      at('2026-06-10'),
    );
    const providerCred = randomUUID();
    await pool.query(
      `INSERT INTO provider_credential
         (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
      [providerCred, co.tenantId, co.companyId, branchId],
    );
    const attemptId = (
      await q<{ id: string }>(
        `INSERT INTO payment_attempt
           (id,"tenantId","companyId","branchId","orderId","targetInvoiceId",method,"providerKey",
            "providerCredentialId","amountMinor","currencyCode","currencyExponent",state,
            "orderCommercialSnapshotFingerprintAtCreation","orderVersionAtCreation","idempotencyKey","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,'ONLINE_GATEWAY','tap',$6,2100,'AED',2,'CAPTURED','fp-seed',1,$7,now())
         RETURNING id`,
        [
          co.tenantId,
          co.companyId,
          branchId,
          s.order.orderId,
          s.invoiceId,
          providerCred,
          `seed-${ik()}`,
        ],
      )
    )[0]!.id;
    const paymentId = (
      await q<{ id: string }>(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,'ONLINE_GATEWAY','tap',2100,'AED',2) RETURNING id`,
        [co.tenantId, co.companyId, branchId, attemptId],
      )
    )[0]!.id;
    const allocationId = (
      await q<{ id: string }>(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,2100,'AED',2) RETURNING id`,
        [co.tenantId, co.companyId, branchId, paymentId, s.invoiceId],
      )
    )[0]!.id;
    const receivableId = await receivableOfInvoice(s.invoiceId);
    setClock(at('2026-06-10'));
    await asTenant(async (tx) => {
      const effects = app.get(CustomerReceiptEffectsRepository);
      await effects.recordPaymentReceivedInTx(tx, {
        tenantId: co.tenantId,
        companyId: co.companyId,
        branchId,
        customerCompanyAccountId: cust.ccaId,
        paymentId,
        method: 'ONLINE_GATEWAY',
        amountMinor: 2_100n,
      });
      await effects.applyInvoiceAllocationEffectsInTx(tx, {
        tenantId: co.tenantId,
        companyId: co.companyId,
        branchId,
        customerCompanyAccountId: cust.ccaId,
        paymentAllocationId: allocationId,
        customerReceivableId: receivableId,
        invoiceId: s.invoiceId,
        amountMinor: 2_100n,
      });
    }, co.tenantId);
    setClock(DEFAULT_INSTANT);
    // a FINALIZED settlement (the provider refund's own full-settlement gate)
    const client = new pg.Client({ connectionString: stack.postgres.url });
    await client.connect();
    try {
      await client.query('BEGIN');
      const accountId = async (key: string): Promise<string> =>
        (
          await client.query(`SELECT id FROM account WHERE "companyId"=$1 AND key=$2`, [
            co.companyId,
            key,
          ])
        ).rows[0].id;
      const period = (
        await client.query(`SELECT id FROM accounting_period WHERE "companyId"=$1 LIMIT 1`, [
          co.companyId,
        ])
      ).rows[0].id;
      const batchId = randomUUID();
      const je = randomUUID();
      await client.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
         VALUES ($1,$2,$3,$4,'2026-06-01','SETTLEMENT_BATCH',$5,'AED',$6)`,
        [je, co.tenantId, co.companyId, period, batchId, `fp-${je}`],
      );
      await client.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,2100,0)`,
        [co.tenantId, co.companyId, je, await accountId('ASSET.BANK'), branchId],
      );
      await client.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,0,2100)`,
        [co.tenantId, co.companyId, je, await accountId('ASSET.PAYMENT_CLEARING'), branchId],
      );
      await client.query(`UPDATE journal_entry SET "sealedAt"=now() WHERE id=$1`, [je]);
      const lineId = randomUUID();
      await client.query(
        `INSERT INTO settlement_batch
           (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
            "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',2100,0,2100,'AED',2)`,
        [batchId, co.tenantId, co.companyId, branchId, providerCred, `ext-${batchId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
         VALUES ($1,$2,$3,$4,$5,2100,'AED',2,$6)`,
        [lineId, co.tenantId, co.companyId, branchId, batchId, paymentId],
      );
      await client.query(
        `INSERT INTO settlement_application (id,"tenantId","companyId","branchId","batchId","lineId","paymentId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,2100,'AED',2)`,
        [co.tenantId, co.companyId, branchId, batchId, lineId, paymentId],
      );
      await client.query(
        `UPDATE settlement_batch SET state='FINALIZED', "journalEntryId"=$1, "finalizedAt"=now(), version=version+1 WHERE id=$2`,
        [je, batchId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      await client.end();
    }
    await cancel(s.order, at('2026-06-12'));
    const ids = await advancesOfOrder(s.order.orderId);
    expect(ids).toHaveLength(1);
    return { advanceId: ids[0]!, paymentId };
  }

  const reserveProviderRefund = (
    co: Co,
    branchId: string,
    customerId: string,
    advanceId: string,
    amount: bigint,
  ): Promise<{ refundAttemptId: string }> =>
    asTenant(
      (tx) =>
        app.get(RefundAttemptReservationRepository).reserveProviderRefundAttemptInTx(tx, {
          tenantId: co.tenantId,
          companyId: co.companyId,
          branchId,
          customerId,
          customerAdvanceId: advanceId,
          requestedAmountMinor: amount,
          idempotencyKey: ik(),
        }),
      co.tenantId,
    );
  const finishProviderRefund = (
    co: Co,
    branchId: string,
    attemptId: string,
    resultState: 'SUCCEEDED' | 'FAILED',
    method: 'CARD_TERMINAL' | 'ONLINE_GATEWAY',
    accountingDate: string,
  ): Promise<unknown> =>
    asTenant(
      (tx) =>
        app.get(RefundAttemptReservationRepository).applyProviderRefundAttemptResultInTx(tx, {
          tenantId: co.tenantId,
          companyId: co.companyId,
          branchId,
          refundAttemptId: attemptId,
          resultState,
          providerReference: 'prov-ref',
          method,
          reasonCode: 'CUSTOMER_REQUEST',
          accountingDate,
          actorUserId: null,
          ...(resultState === 'FAILED' ? { failureCode: 'DECLINED' } : {}),
        }),
      co.tenantId,
    );

  // ── the model oracle: every advance, payment and source row read table by table, folded with the FROZEN helpers ──
  interface ModelAdvance {
    id: string;
    branchId: string;
    customerId: string;
    sourceType: string;
    principal: bigint;
    applied: bigint;
    refunded: bigint;
    reserved: bigint;
  }
  interface ModelPayment {
    id: string;
    branchId: string;
    customerId: string;
    original: bigint;
    allocated: bigint;
    receivableApplied: bigint;
    converted: bigint;
  }
  interface Model {
    advances: ModelAdvance[];
    payments: ModelPayment[];
  }
  const sums = async (sql: string, params: unknown[]): Promise<Map<string, bigint>> =>
    new Map((await q<{ k: string; s: string }>(sql, params)).map((r) => [r.k, BigInt(r.s)]));

  async function loadModel(companyId: string): Promise<Model> {
    const accountRows = await q<{ id: string; customerId: string }>(
      `SELECT id, "customerId" FROM customer_company_account WHERE "companyId" = $1`,
      [companyId],
    );
    const customerOfAccount = new Map(accountRows.map((a) => [a.id, a.customerId]));
    const accountOfCustomer = new Map(accountRows.map((a) => [a.customerId, a.id]));

    const advRows = await q<{
      id: string;
      branchId: string;
      sourceType: string;
      amt: string;
      cca: string;
    }>(
      `SELECT id, "branchId", "sourceType", "amountMinor"::text AS amt, "customerCompanyAccountId" AS cca
         FROM customer_advance WHERE "companyId" = $1 ORDER BY id`,
      [companyId],
    );
    const applied = await sums(
      `SELECT "customerAdvanceId" AS k, SUM("amountMinor")::text AS s FROM customer_advance_application WHERE "companyId" = $1 GROUP BY 1`,
      [companyId],
    );
    const refunded = await sums(
      `SELECT "customerAdvanceId" AS k, SUM("amountMinor")::text AS s FROM customer_advance_refund_application WHERE "companyId" = $1 GROUP BY 1`,
      [companyId],
    );
    const reserved = await sums(
      `SELECT rr."customerAdvanceId" AS k, SUM(rr."amountMinor")::text AS s
         FROM refund_attempt_entitlement_reservation rr JOIN refund_attempt ra ON ra.id = rr."refundAttemptId"
        WHERE rr."companyId" = $1 AND ra.state = 'PENDING' GROUP BY 1`,
      [companyId],
    );
    const advances: ModelAdvance[] = advRows.map((a) => ({
      id: a.id,
      branchId: a.branchId,
      customerId: customerOfAccount.get(a.cca)!,
      sourceType: a.sourceType,
      principal: BigInt(a.amt),
      applied: applied.get(a.id) ?? 0n,
      refunded: refunded.get(a.id) ?? 0n,
      reserved: reserved.get(a.id) ?? 0n,
    }));

    // the frozen attribution: CUSTOMER_RECEIPT → the attempt's own account; INVOICE_COLLECTION → the invoice's order customer
    const orderCustomerOfInvoice = new Map(
      (
        await q<{ id: string; customerId: string | null }>(
          `SELECT i.id, o."customerId" FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE i."companyId" = $1`,
          [companyId],
        )
      ).map((r) => [r.id, r.customerId]),
    );
    const payRows = await q<{
      id: string;
      branchId: string;
      amt: string;
      purpose: string;
      cca: string | null;
      inv: string | null;
    }>(
      `SELECT p.id, p."branchId", p."amountMinor"::text AS amt, pa."receiptPurpose" AS purpose,
              pa."customerCompanyAccountId" AS cca, pa."targetInvoiceId" AS inv
         FROM payment p JOIN payment_attempt pa ON pa.id = p."sourceAttemptId"
        WHERE p."companyId" = $1 ORDER BY p.id`,
      [companyId],
    );
    const allocated = await sums(
      `SELECT "paymentId" AS k, SUM("amountMinor")::text AS s FROM payment_allocation WHERE "companyId" = $1 GROUP BY 1`,
      [companyId],
    );
    const receivableApplied = await sums(
      `SELECT "paymentId" AS k, SUM("amountMinor")::text AS s FROM customer_receivable_payment_application WHERE "companyId" = $1 GROUP BY 1`,
      [companyId],
    );
    const converted = await sums(
      `SELECT "sourcePaymentId" AS k, SUM("amountMinor")::text AS s FROM customer_advance WHERE "companyId" = $1 AND "sourcePaymentId" IS NOT NULL GROUP BY 1`,
      [companyId],
    );
    const payments: ModelPayment[] = [];
    for (const p of payRows) {
      let customerId: string | null;
      if (p.purpose === 'CUSTOMER_RECEIPT') {
        customerId = p.cca === null ? null : (customerOfAccount.get(p.cca) ?? null);
      } else {
        const orderCustomer = p.inv === null ? null : (orderCustomerOfInvoice.get(p.inv) ?? null);
        customerId =
          orderCustomer !== null && accountOfCustomer.has(orderCustomer) ? orderCustomer : null;
      }
      if (customerId === null) continue; // a walk-in Payment: no customer account, no 3b.6 GL, no unapplied receipt
      payments.push({
        id: p.id,
        branchId: p.branchId,
        customerId,
        original: BigInt(p.amt),
        allocated: allocated.get(p.id) ?? 0n,
        receivableApplied: receivableApplied.get(p.id) ?? 0n,
        converted: converted.get(p.id) ?? 0n,
      });
    }
    return { advances, payments };
  }

  const scopeOf = (m: Model, branchId: string | null, customerId: string | null): Model => ({
    advances: m.advances.filter(
      (a) =>
        (branchId === null || a.branchId === branchId) &&
        (customerId === null || a.customerId === customerId),
    ),
    payments: m.payments.filter(
      (p) =>
        (branchId === null || p.branchId === branchId) &&
        (customerId === null || p.customerId === customerId),
    ),
  });

  function advanceFiguresOf(rows: ModelAdvance[]) {
    let principal = 0n;
    let applied = 0n;
    let refunded = 0n;
    let reserved = 0n;
    let book = 0n;
    let available = 0n;
    for (const a of rows) {
      const f = computeAdvanceBalance({
        principalMinor: a.principal,
        appliedMinor: a.applied,
        refundedMinor: a.refunded,
        reservedMinor: a.reserved,
      });
      principal += f.principalMinor;
      applied += f.appliedMinor;
      refunded += f.refundedMinor;
      reserved += f.reservedMinor;
      book += f.bookedRemainingMinor;
      available += f.availableMinor;
    }
    return {
      figures: {
        advanceCount: rows.length,
        originalAdvanceMinor: principal.toString(),
        appliedMinor: applied.toString(),
        actuallyRefundedMinor: refunded.toString(),
        bookLiabilityMinor: book.toString(),
        pendingRefundReservationMinor: reserved.toString(),
        availableMinor: available.toString(),
      },
      book,
    };
  }
  function unappliedFiguresOf(rows: ModelPayment[]) {
    let original = 0n;
    let allocated = 0n;
    let receivableApplied = 0n;
    let converted = 0n;
    let unapplied = 0n;
    let withUnapplied = 0;
    for (const p of rows) {
      const remaining = computePaymentConsumption({
        paymentAmountMinor: p.original,
        allocatedToInvoicesMinor: p.allocated + p.receivableApplied,
        convertedToAdvanceMinor: p.converted,
      }).remainingMinor;
      original += p.original;
      allocated += p.allocated;
      receivableApplied += p.receivableApplied;
      converted += p.converted;
      unapplied += remaining;
      if (remaining > 0n) withUnapplied += 1;
    }
    return {
      figures: {
        paymentCount: rows.length,
        paymentCountWithUnapplied: withUnapplied,
        originalReceiptMinor: original.toString(),
        paymentAllocationMinor: allocated.toString(),
        receivablePaymentApplicationMinor: receivableApplied.toString(),
        allocatedToReceivablesMinor: (allocated + receivableApplied).toString(),
        convertedToAdvanceMinor: converted.toString(),
        unappliedReceiptMinor: unapplied.toString(),
      },
      unapplied,
    };
  }

  /** the GL net (credit − debit) of ONE liability account over exactly the authoritative sealed kinds */
  async function glNet(
    companyId: string,
    accountKey: string,
    kinds: string[],
    branchId: string | null = null,
  ): Promise<bigint> {
    const r = await q<{ s: string }>(
      `SELECT COALESCE(SUM(l."creditMinor" - l."debitMinor"), 0)::text AS s
         FROM journal_entry je
         JOIN journal_line l ON l."journalEntryId" = je.id
         JOIN account a ON a.id = l."accountId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = $2
          AND je."sourceKind" = ANY($3::text[])
          AND ($4::uuid IS NULL OR l."branchId" = $4)`,
      [companyId, accountKey, kinds, branchId],
    );
    return BigInt(r[0]!.s);
  }
  /**
   * The GL net of a (branch, customer) scope, independent of the report: a journal belongs to a customer through the
   * SOURCE DOCUMENT its (kind, sourceId) names — an advance, an application, a refund (through its application), a
   * CreditNote (through its coverage release), a Payment, an allocation or a receivable application.
   */
  async function glNetScoped(
    companyId: string,
    accountKey: string,
    kinds: string[],
    branchId: string | null,
    customerId: string | null,
  ): Promise<bigint> {
    if (customerId === null) return glNet(companyId, accountKey, kinds, branchId);
    const model = await loadModel(companyId);
    const owner = new Map<string, string>();
    const advCustomer = new Map(model.advances.map((a) => [a.id, a.customerId]));
    const payCustomer = new Map(model.payments.map((p) => [p.id, p.customerId]));
    for (const [id, c] of advCustomer) owner.set(id, c);
    for (const [id, c] of payCustomer) owner.set(id, c);
    const viaAdvance = async (sql: string): Promise<void> => {
      for (const r of await q<{ id: string; aid: string }>(sql, [companyId])) {
        owner.set(r.id, advCustomer.get(r.aid)!);
      }
    };
    await viaAdvance(
      `SELECT id, "customerAdvanceId" AS aid FROM customer_advance_application WHERE "companyId" = $1`,
    );
    await viaAdvance(
      `SELECT "refundId" AS id, "customerAdvanceId" AS aid FROM customer_advance_refund_application WHERE "companyId" = $1`,
    );
    await viaAdvance(
      `SELECT "creditNoteId" AS id, "customerAdvanceId" AS aid FROM credit_note_coverage_release WHERE "companyId" = $1`,
    );
    for (const sql of [
      `SELECT id, "paymentId" AS pid FROM payment_allocation WHERE "companyId" = $1`,
      `SELECT id, "paymentId" AS pid FROM customer_receivable_payment_application WHERE "companyId" = $1`,
    ]) {
      for (const r of await q<{ id: string; pid: string }>(sql, [companyId])) {
        const c = payCustomer.get(r.pid);
        if (c !== undefined) owner.set(r.id, c);
      }
    }
    const lines = await q<{ sid: string; net: string }>(
      `SELECT je."sourceId" AS sid, (l."creditMinor" - l."debitMinor")::text AS net
         FROM journal_entry je
         JOIN journal_line l ON l."journalEntryId" = je.id
         JOIN account a ON a.id = l."accountId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = $2
          AND je."sourceKind" = ANY($3::text[])
          AND ($4::uuid IS NULL OR l."branchId" = $4)`,
      [companyId, accountKey, kinds, branchId],
    );
    let total = 0n;
    for (const l of lines) if (owner.get(l.sid) === customerId) total += BigInt(l.net);
    return total;
  }
  /** the WHOLE liability account, every kind — to prove a manual journal is NOT part of a control */
  async function glAllKinds(companyId: string, accountKey: string): Promise<bigint> {
    const r = await q<{ s: string }>(
      `SELECT COALESCE(SUM(l."creditMinor" - l."debitMinor"), 0)::text AS s
         FROM journal_entry je JOIN journal_line l ON l."journalEntryId" = je.id JOIN account a ON a.id = l."accountId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = $2`,
      [companyId, accountKey],
    );
    return BigInt(r[0]!.s);
  }

  /** the expected blocks of a scope: the oracle's source figures + the oracle's GL nets of the SAME scope */
  async function expectedBlocks(
    companyId: string,
    branchId: string | null = null,
    customerId: string | null = null,
  ) {
    const scoped = scopeOf(await loadModel(companyId), branchId, customerId);
    const adv = advanceFiguresOf(scoped.advances);
    const un = unappliedFiguresOf(scoped.payments);
    const glAdv = await glNetScoped(companyId, ADV_ACCOUNT, ADV_KINDS, branchId, customerId);
    const glUn = await glNetScoped(
      companyId,
      UNAPPLIED_ACCOUNT,
      UNAPPLIED_KINDS,
      branchId,
      customerId,
    );
    return {
      advances: {
        ...adv.figures,
        bySourceType: ['PAYMENT', 'OPENING', 'CREDIT_NOTE'].map((t) => ({
          sourceType: t,
          ...advanceFiguresOf(scoped.advances.filter((a) => a.sourceType === t)).figures,
        })),
        reconciliation: {
          sourceBookLiabilityMinor: adv.book.toString(),
          glCustomerAdvancesLiabilityMinor: glAdv.toString(),
          differenceMinor: (adv.book - glAdv).toString(),
          reconciled: adv.book === glAdv,
        },
      },
      unappliedReceipts: {
        ...un.figures,
        reconciliation: {
          sourceUnappliedMinor: un.unapplied.toString(),
          glUnappliedReceiptsLiabilityMinor: glUn.toString(),
          differenceMinor: (un.unapplied - glUn).toString(),
          reconciled: un.unapplied === glUn,
        },
      },
    };
  }
  const blocksOf = (r: Pick<LiabilitiesBranchReport, 'advances' | 'unappliedReceipts'>) => ({
    advances: r.advances,
    unappliedReceipts: r.unappliedReceipts,
  });

  // ── report helpers ──────────────────────────────────────────────────────────
  const inTenant = <T>(fn: () => Promise<T>, t: string = tenantId): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId: t }), fn);
  type Extra = { customerId?: string | null; cursor?: unknown; limit?: unknown };
  const companyReport = (co: Co, extra: Extra = {}): Promise<LiabilitiesCompanyReport> =>
    inTenant(() => service.companyReport({ companyId: co.companyId, ...extra }), co.tenantId);
  const branchReport = (
    co: Co,
    branchId: string,
    extra: Extra = {},
  ): Promise<LiabilitiesBranchReport> =>
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

    repo = new CustomerLiabilitiesReportRepository(db);
    service = new CustomerLiabilitiesReportService(repo);

    aed = await makeCompany(tenantId, { currency: 'AED' });
    aed2 = await makeCompany(tenantId, { currency: 'AED' });
    kwd = await makeCompany(tenantId, { currency: 'KWD', tz: 'Asia/Kuwait' });
    foreign = await makeCompany(otherTenantId, { currency: 'AED' });

    tok['owner'] = await mint('owner', rolePerms('owner'), { stepUp: true });
    tok['foreignOwner'] = await mint('foreign-owner', rolePerms('owner'), {
      tenant: otherTenantId,
      stepUp: true,
    });

    // ───────────────────── THE WORLD: both liabilities through the frozen flows ─────────────────────
    const A = aed.branchId;
    const B = aed.siblingBranchId;
    for (const n of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']) {
      C[n] = await mkCustomer(aed, `ZZ-PII-NAME-${n}`);
    }
    const cid = (n: string): string => C[n]!.customerId;

    // c1 · A · ONE fully UNAPPLIED receipt (3 000)
    W['c1Payment'] = (await receipt(aed, A, cid('c1'), 'CASH', 3_000n, at('2026-06-10'))).paymentId;

    // c2 · A · a receipt of 2 000 of which 1 200 is converted to an Advance (PAYMENT origin); 800 stays unapplied
    const r2 = await receipt(aed, A, cid('c2'), 'CASH', 2_000n, at('2026-06-10'));
    W['c2Payment'] = r2.paymentId;
    W['c2Advance'] = await convertToAdvance(aed, A, cid('c2'), r2.paymentId, 1_200n);

    // c3 · A · an invoice of 4 200 settled by two receipts: 1 000 fully allocated, then 5 000 of which 3 200 is allocated
    //          (multiple allocations) and 1 800 stays unapplied (a PARTIALLY allocated Payment)
    O['c3'] = await mkOrder(aed, cid('c3'), one(4_000n), A);
    await sell(O['c3'], { intent: 'ON_CREDIT' }, at('2026-06-10'));
    W['c3PaymentA'] = (
      await receipt(aed, A, cid('c3'), 'CASH', 1_000n, at('2026-06-11'))
    ).paymentId;
    W['c3PaymentB'] = (
      await receipt(aed, A, cid('c3'), 'BANK_TRANSFER', 5_000n, at('2026-06-12'))
    ).paymentId;

    // c4 · B · a receipt of 4 000 converted IN FULL to an Advance, then applied twice (1 000 + 500) to an invoice of 2 100
    const r4 = await receipt(aed, B, cid('c4'), 'BANK_TRANSFER', 4_000n, at('2026-06-10'));
    W['c4Payment'] = r4.paymentId;
    W['c4Advance'] = await convertToAdvance(aed, B, cid('c4'), r4.paymentId, 4_000n);
    const s4 = await sell(
      await mkOrder(aed, cid('c4'), one(2_000n), B),
      { intent: 'ON_CREDIT' },
      at('2026-06-11'),
    );
    W['c4Receivable'] = await receivableOfInvoice(s4.invoiceId);
    await applyAdvance(aed, B, cid('c4'), W['c4Advance']!, W['c4Receivable']!, 1_000n);
    await applyAdvance(aed, B, cid('c4'), W['c4Advance']!, W['c4Receivable']!, 500n);

    // c5 · A · an Advance of 1 050 applied IN FULL (book 0)
    const r5 = await receipt(aed, A, cid('c5'), 'CASH', 1_050n, at('2026-06-10'));
    W['c5Advance'] = await convertToAdvance(aed, A, cid('c5'), r5.paymentId, 1_050n);
    const s5 = await sell(
      await mkOrder(aed, cid('c5'), one(1_000n), A),
      { intent: 'ON_CREDIT' },
      at('2026-06-11'),
    );
    W['c5Receivable'] = await receivableOfInvoice(s5.invoiceId);
    await applyAdvance(aed, A, cid('c5'), W['c5Advance']!, W['c5Receivable']!, 1_050n);

    // c6 · A · an OPENING-origin Advance of 3 000, 700 applied to an invoice
    W['c6Advance'] = await openingAdvance(aed, A, cid('c6'), 3_000n, '2026-05-20');
    const s6 = await sell(
      await mkOrder(aed, cid('c6'), one(1_000n), A),
      { intent: 'ON_CREDIT' },
      at('2026-06-11'),
    );
    W['c6Receivable'] = await receivableOfInvoice(s6.invoiceId);
    await applyAdvance(aed, A, cid('c6'), W['c6Advance']!, W['c6Receivable']!, 700n);

    // c7 · A · a PAID sale cancelled → the CreditNote excess is a CREDIT_NOTE-origin Advance (2 100); a LOCAL CASH refund of 500
    const c7 = await paidThenCancelledAdvance(aed, C['c7']!, A, [card(2_100n)]);
    W['c7Advance'] = c7.advanceId;
    await refundAdvance(aed, A, cid('c7'), c7.advanceId, 500n);

    // c8 · B · a PROVIDER-BACKED CreditNote Advance (2 100): a PENDING reservation 500, a FAILED 700 (released), SUCCEEDED 800 + 300
    const c8 = await providerBackedCnAdvance(aed, B, C['c8']!);
    W['c8Advance'] = c8.advanceId;
    W['c8Payment'] = c8.paymentId;
    const pending = await reserveProviderRefund(aed, B, cid('c8'), c8.advanceId, 500n);
    W['c8Pending'] = pending.refundAttemptId;
    const failed = await reserveProviderRefund(aed, B, cid('c8'), c8.advanceId, 700n);
    await finishProviderRefund(
      aed,
      B,
      failed.refundAttemptId,
      'FAILED',
      'ONLINE_GATEWAY',
      '2026-06-14',
    );
    W['c8Failed'] = failed.refundAttemptId;
    const ok1 = await reserveProviderRefund(aed, B, cid('c8'), c8.advanceId, 800n);
    await finishProviderRefund(
      aed,
      B,
      ok1.refundAttemptId,
      'SUCCEEDED',
      'ONLINE_GATEWAY',
      '2026-06-15',
    );
    const ok2 = await reserveProviderRefund(aed, B, cid('c8'), c8.advanceId, 300n);
    await finishProviderRefund(
      aed,
      B,
      ok2.refundAttemptId,
      'SUCCEEDED',
      'CARD_TERMINAL',
      '2026-06-16',
    );

    // c9 · A · a receipt of 700 applied to an OPENING receivable (a CustomerReceivablePaymentApplication, not a PaymentAllocation)
    W['c9Receivable'] = await openingReceivable(aed, A, cid('c9'), 2_000n, '2026-05-15');
    W['c9Payment'] = (await receipt(aed, A, cid('c9'), 'CASH', 700n, at('2026-06-12'))).paymentId;

    // c10 · an ANONYMOUS walk-in sale — no customer account: in neither liability
    await sell(
      await mkOrder(aed, null, one(1_000n), A),
      { tenders: [cash(1_050n)] },
      at('2026-06-10'),
    );

    // a SECOND company of the same tenant and ANOTHER tenant — never part of aed's figures
    const a2 = await mkCustomer(aed2);
    const ra2 = await receipt(aed2, aed2.branchId, a2.customerId, 'CASH', 1_500n, at('2026-06-10'));
    await convertToAdvance(aed2, aed2.branchId, a2.customerId, ra2.paymentId, 500n);
    const f1 = await mkCustomer(foreign);
    await receipt(foreign, foreign.branchId, f1.customerId, 'CASH', 900n, at('2026-06-10'));
    C['a2'] = a2;
    C['f1'] = f1;

    // ───────── kwd · 3-decimal minor units ─────────
    const k1 = await mkCustomer(kwd);
    const k2 = await mkCustomer(kwd);
    const k3 = await mkCustomer(kwd);
    await receipt(kwd, kwd.branchId, k1.customerId, 'BANK_TRANSFER', 7_500n, at('2026-06-11'));
    const rk2 = await receipt(
      kwd,
      kwd.siblingBranchId,
      k2.customerId,
      'CASH',
      5_000n,
      at('2026-06-11'),
    );
    await convertToAdvance(kwd, kwd.siblingBranchId, k2.customerId, rk2.paymentId, 2_000n);
    const k3adv = await paidThenCancelledAdvance(kwd, k3, kwd.branchId, [card(6_300n)], 6_000n);
    await refundAdvance(kwd, kwd.branchId, k3.customerId, k3adv.advanceId, 2_500n);
    C['k1'] = k1;
    C['k2'] = k2;
    C['k3'] = k3;
  }, 1_200_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await stack?.stop();
  });

  // ═══════════════════ the figures equal the independent oracle ═══════════════════
  describe('the company report equals the model oracle — two liabilities, two independent controls', () => {
    it('the representative matrix, AED: both blocks and both GL controls equal the oracle (and the hand-computed figures)', async () => {
      const model = await loadModel(aed.companyId);
      expect(model.advances).toHaveLength(6);
      expect(model.payments).toHaveLength(9); // the anonymous walk-in Payment is in neither liability
      const r = await companyReport(aed, { limit: 200 });
      expect(blocksOf(r)).toEqual(await expectedBlocks(aed.companyId));
      expect(r.note).toBe(LIABILITIES_REPORT_NOTE);
      // hand-computed: advances 13 450 − applied 3 250 − refunded 1 600 = book 8 600; reserved 500; available 8 100
      expect(r.advances).toMatchObject({
        advanceCount: 6,
        originalAdvanceMinor: '13450',
        appliedMinor: '3250',
        actuallyRefundedMinor: '1600',
        bookLiabilityMinor: '8600',
        pendingRefundReservationMinor: '500',
        availableMinor: '8100',
      });
      expect(
        r.advances.bySourceType.map((t) => [t.sourceType, t.advanceCount, t.bookLiabilityMinor]),
      ).toEqual([
        ['PAYMENT', 3, '3700'],
        ['OPENING', 1, '2300'],
        ['CREDIT_NOTE', 2, '2600'],
      ]);
      // hand-computed: receipts 20 950 − allocated 8 400 − receivable applications 700 − converted 6 250 = unapplied 5 600
      expect(r.unappliedReceipts).toMatchObject({
        paymentCount: 9,
        paymentCountWithUnapplied: 3,
        originalReceiptMinor: '20950',
        paymentAllocationMinor: '8400',
        receivablePaymentApplicationMinor: '700',
        allocatedToReceivablesMinor: '9100',
        convertedToAdvanceMinor: '6250',
        unappliedReceiptMinor: '5600',
      });
      // the two controls reconcile EACH ON ITS OWN, to their own account
      expect(r.advances.reconciliation).toEqual({
        sourceBookLiabilityMinor: '8600',
        glCustomerAdvancesLiabilityMinor: '8600',
        differenceMinor: '0',
        reconciled: true,
      });
      expect(r.unappliedReceipts.reconciliation).toEqual({
        sourceUnappliedMinor: '5600',
        glUnappliedReceiptsLiabilityMinor: '5600',
        differenceMinor: '0',
        reconciled: true,
      });
    });

    it('KWD (3 decimals): every figure equals the oracle and nothing is rescaled', async () => {
      const r = await companyReport(kwd, { limit: 200 });
      expect(r.currencyCode).toBe('KWD');
      expect(r.currencyExponent).toBe(3);
      expect(blocksOf(r)).toEqual(await expectedBlocks(kwd.companyId));
      // advances 2 000 (PAYMENT) + 6 300 (CREDIT_NOTE) − refunded 2 500; unapplied 7 500 + 3 000
      expect(r.advances).toMatchObject({ bookLiabilityMinor: '5800', availableMinor: '5800' });
      expect(r.unappliedReceipts).toMatchObject({ unappliedReceiptMinor: '10500' });
    });

    it('the pending reservation reduces AVAILABLE only: the book liability and the GL carry the full amount; a FAILED attempt reserves nothing', async () => {
      const r = await companyReport(aed, { customerId: C['c8']!.customerId });
      // the provider advance 2 100: refunded 800 + 300 (two SUCCEEDED attempts), 500 PENDING, 700 FAILED (released)
      expect(r.advances).toMatchObject({
        advanceCount: 1,
        originalAdvanceMinor: '2100',
        appliedMinor: '0',
        actuallyRefundedMinor: '1100',
        bookLiabilityMinor: '1000',
        pendingRefundReservationMinor: '500',
        availableMinor: '500',
      });
      // the GL carries the BOOK liability — a reservation moved no journal; the available figure would NOT reconcile
      expect(r.advances.reconciliation).toEqual({
        sourceBookLiabilityMinor: '1000',
        glCustomerAdvancesLiabilityMinor: '1000',
        differenceMinor: '0',
        reconciled: true,
      });
      expect((await glNet(aed.companyId, ADV_ACCOUNT, ADV_KINDS, aed.siblingBranchId)) > 0n).toBe(
        true,
      );
      // the attempts: exactly one PENDING reservation counts; the FAILED one is a row but not a reservation
      expect(
        await q<{ state: string; n: string }>(
          `SELECT ra.state, count(*)::text AS n FROM refund_attempt ra
             JOIN refund_attempt_entitlement_reservation rr ON rr."refundAttemptId" = ra.id
            WHERE rr."customerAdvanceId" = $1 GROUP BY 1 ORDER BY 1`,
          [W['c8Advance']],
        ),
      ).toEqual([
        { state: 'FAILED', n: '1' },
        { state: 'PENDING', n: '1' },
        { state: 'SUCCEEDED', n: '2' },
      ]);
      // the provider Payment is fully allocated: the Advance (a CreditNote excess) never touches the receipt
      expect(r.unappliedReceipts).toMatchObject({
        paymentCount: 1,
        originalReceiptMinor: '2100',
        paymentAllocationMinor: '2100',
        convertedToAdvanceMinor: '0',
        unappliedReceiptMinor: '0',
      });
    });

    it('an ACTUAL refund reduces the book liability and available once (a local CASH refund of 500); the receipt and the origin are untouched', async () => {
      const r = await companyReport(aed, { customerId: C['c7']!.customerId });
      expect(r.advances).toMatchObject({
        advanceCount: 1,
        originalAdvanceMinor: '2100',
        actuallyRefundedMinor: '500',
        bookLiabilityMinor: '1600',
        pendingRefundReservationMinor: '0',
        availableMinor: '1600',
      });
      expect(r.advances.reconciliation.reconciled).toBe(true);
      expect(r.advances.bySourceType.find((t) => t.sourceType === 'CREDIT_NOTE')).toMatchObject({
        advanceCount: 1,
        bookLiabilityMinor: '1600',
      });
    });

    it('the CreditNote EXCESS is an Advance and ONLY an Advance: once in the advance book liability, never in Unapplied Receipts, and the Payment is not a second receipt', async () => {
      const r = await companyReport(aed, { customerId: C['c7']!.customerId });
      expect(r.advances.bySourceType.map((t) => [t.sourceType, t.advanceCount])).toEqual([
        ['PAYMENT', 0],
        ['OPENING', 0],
        ['CREDIT_NOTE', 1],
      ]);
      // the one Payment (2 100) of the cancelled sale is fully ALLOCATED to its invoice: unapplied 0, no conversion
      expect(r.unappliedReceipts).toMatchObject({
        paymentCount: 1,
        originalReceiptMinor: '2100',
        paymentAllocationMinor: '2100',
        convertedToAdvanceMinor: '0',
        unappliedReceiptMinor: '0',
        paymentCountWithUnapplied: 0,
      });
      // exactly one advance exists for the CreditNote and ONE journal credits the advances account for it
      const cn = await q<{ n: string; credit: string }>(
        `SELECT (SELECT count(*) FROM credit_note_coverage_release WHERE "customerAdvanceId" = $1)::text AS n,
                (SELECT COALESCE(SUM(l."creditMinor"), 0)::text FROM journal_entry je JOIN journal_line l ON l."journalEntryId" = je.id
                   JOIN account a ON a.id = l."accountId" AND a.key = $2
                  WHERE je."sourceKind" = 'credit_note' AND je."sourceId" =
                        (SELECT "creditNoteId"::text FROM credit_note_coverage_release WHERE "customerAdvanceId" = $1)) AS credit`,
        [W['c7Advance'], ADV_ACCOUNT],
      );
      expect(cn[0]).toEqual({ n: '1', credit: '2100' });
      // Tender counts the original Payment ONCE: the advances never add a tender receipt
      const tender = await inTenant(() =>
        new TenderTotalsReportRepository(db).getCompanyReportScoped({
          companyId: aed.companyId,
          from: '2026-06-01',
          to: '2026-06-30',
        }),
      );
      const allPayments = (await companyReport(aed, { limit: 200 })).unappliedReceipts
        .originalReceiptMinor;
      // attributable receipts + the one anonymous walk-in tender (1 050) are exactly the Tender receipts
      expect(BigInt(tender.receipts.receiptTotalMinor)).toBe(BigInt(allPayments) + 1_050n);
    });

    it('an Advance application reduces the book liability AND available together, increases Receivables paidByAdvance, creates no receipt, and leaves the Unapplied receipt untouched', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const rc = await receipt(co, co.branchId, cust.customerId, 'CASH', 3_000n, at('2026-06-10'));
      const advanceId = await convertToAdvance(
        co,
        co.branchId,
        cust.customerId,
        rc.paymentId,
        1_000n,
      );
      const s = await sell(
        await mkOrder(co, cust.customerId, one(1_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-11'),
      );
      const before = await companyReport(co);
      const dBefore = await inTenant(
        () =>
          new ReceivablesReportRepository(db).getCompanyReportScoped({ companyId: co.companyId }),
        co.tenantId,
      );
      await applyAdvance(
        co,
        co.branchId,
        cust.customerId,
        advanceId,
        await receivableOfInvoice(s.invoiceId),
        600n,
      );
      const after = await companyReport(co);
      const dAfter = await inTenant(
        () =>
          new ReceivablesReportRepository(db).getCompanyReportScoped({ companyId: co.companyId }),
        co.tenantId,
      );
      expect(before.advances).toMatchObject({
        bookLiabilityMinor: '1000',
        availableMinor: '1000',
        appliedMinor: '0',
      });
      expect(after.advances).toMatchObject({
        bookLiabilityMinor: '400',
        availableMinor: '400',
        appliedMinor: '600',
      });
      expect(after.advances.reconciliation.reconciled).toBe(true);
      // the receipt side is untouched: an application spends the advance, it never consumes the original receipt again
      expect(after.unappliedReceipts).toEqual(before.unappliedReceipts);
      expect(after.unappliedReceipts.unappliedReceiptMinor).toBe('2000');
      // Receivables owns the AR side
      expect(BigInt(dAfter.paidByAdvanceMinor) - BigInt(dBefore.paidByAdvanceMinor)).toBe(600n);
      // and no tender receipt came out of it
      expect(after.unappliedReceipts.originalReceiptMinor).toBe('3000');
    });

    it('a Payment → Advance conversion moves the liability ONCE: unapplied −X, advance book +X, each GL control follows, and Tender Totals is unchanged', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const rc = await receipt(co, co.branchId, cust.customerId, 'CASH', 3_000n, at('2026-06-10'));
      const tenderOf = () =>
        inTenant(
          () =>
            new TenderTotalsReportRepository(db).getCompanyReportScoped({
              companyId: co.companyId,
              from: '2026-06-01',
              to: '2026-06-30',
            }),
          co.tenantId,
        );
      const t0 = await tenderOf();
      const before = await companyReport(co);
      await convertToAdvance(co, co.branchId, cust.customerId, rc.paymentId, 1_000n);
      const after = await companyReport(co);
      const t1 = await tenderOf();
      expect(before.unappliedReceipts).toMatchObject({
        unappliedReceiptMinor: '3000',
        convertedToAdvanceMinor: '0',
      });
      expect(after.unappliedReceipts).toMatchObject({
        unappliedReceiptMinor: '2000',
        convertedToAdvanceMinor: '1000',
        originalReceiptMinor: '3000',
      });
      expect(before.advances.bookLiabilityMinor).toBe('0');
      expect(after.advances.bookLiabilityMinor).toBe('1000');
      // each liability moved exactly once, on its OWN account, and the two moves are equal and opposite
      expect(after.unappliedReceipts.reconciliation.glUnappliedReceiptsLiabilityMinor).toBe('2000');
      expect(after.advances.reconciliation.glCustomerAdvancesLiabilityMinor).toBe('1000');
      expect(before.unappliedReceipts.reconciliation.glUnappliedReceiptsLiabilityMinor).toBe(
        '3000',
      );
      expect(
        after.advances.reconciliation.reconciled &&
          after.unappliedReceipts.reconciliation.reconciled,
      ).toBe(true);
      // the conversion is a reclass, never a second receipt: Tender is byte-identical
      expect(t1.receipts).toEqual(t0.receipts);
      expect(t1.refunds).toEqual(t0.refunds);
    });

    it('a final Refund from an Advance reduces book and available once; a Refund is no receipt consumption, and Tender owns the outgoing movement', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const adv = await paidThenCancelledAdvance(co, cust, co.branchId, [card(2_100n)]);
      const before = await companyReport(co);
      await refundAdvance(co, co.branchId, cust.customerId, adv.advanceId, 700n);
      const after = await companyReport(co);
      expect(before.advances).toMatchObject({
        bookLiabilityMinor: '2100',
        availableMinor: '2100',
        actuallyRefundedMinor: '0',
      });
      expect(after.advances).toMatchObject({
        bookLiabilityMinor: '1400',
        availableMinor: '1400',
        actuallyRefundedMinor: '700',
      });
      expect(after.advances.reconciliation.reconciled).toBe(true);
      expect(after.unappliedReceipts).toEqual(before.unappliedReceipts); // the refund consumed no receipt
      const tender = await inTenant(
        () =>
          new TenderTotalsReportRepository(db).getCompanyReportScoped({
            companyId: co.companyId,
            from: '2026-06-01',
            to: '2026-06-30',
          }),
        co.tenantId,
      );
      expect(tender.refunds.refundTotalMinor).toBe('700'); // the money-out is Tender's movement; E reports only the liability
    });

    it('Unapplied semantics, every class: fully unapplied, partially allocated, fully allocated, converted, multiple allocations, receivable application — and an Advance application never subtracts', async () => {
      const r = await companyReport(aed, { limit: 200 });
      const rows = new Map(r.customers.rows.map((x) => [x.customerId, x.unappliedReceipts]));
      const row = (n: string) => rows.get(C[n]!.customerId)!;
      expect(row('c1')).toMatchObject({
        unappliedReceiptMinor: '3000',
        paymentCountWithUnapplied: 1,
      }); // fully unapplied
      expect(row('c2')).toMatchObject({
        unappliedReceiptMinor: '800',
        convertedToAdvanceMinor: '1200',
      }); // partly converted
      expect(row('c3')).toMatchObject({
        paymentCount: 2,
        originalReceiptMinor: '6000',
        paymentAllocationMinor: '4200', // two allocations: 1 000 (a fully allocated Payment) + 3 200 (a partial one)
        unappliedReceiptMinor: '1800',
        paymentCountWithUnapplied: 1,
      });
      expect(row('c4')).toMatchObject({
        convertedToAdvanceMinor: '4000',
        unappliedReceiptMinor: '0',
      }); // fully converted
      expect(row('c9')).toMatchObject({
        receivablePaymentApplicationMinor: '700',
        paymentAllocationMinor: '0',
        allocatedToReceivablesMinor: '700',
        unappliedReceiptMinor: '0',
      });
      // c4's Advance was APPLIED twice (1 500) — the Payment's unapplied figure is untouched by it
      expect(row('c4').unappliedReceiptMinor).toBe('0');
      const c4 = r.customers.rows.find((x) => x.customerId === C['c4']!.customerId)!;
      expect(c4.advances).toMatchObject({ appliedMinor: '1500', bookLiabilityMinor: '2500' });
    });

    it('opening, payment-derived and CreditNote-derived Advances each appear exactly once in their own source type', async () => {
      const r = await companyReport(aed, { limit: 200 });
      const byType = Object.fromEntries(r.advances.bySourceType.map((t) => [t.sourceType, t]));
      expect(byType['OPENING']).toMatchObject({
        advanceCount: 1,
        originalAdvanceMinor: '3000',
        appliedMinor: '700',
        bookLiabilityMinor: '2300',
      });
      expect(byType['PAYMENT']).toMatchObject({
        advanceCount: 3,
        originalAdvanceMinor: '6250',
        appliedMinor: '2550',
      });
      expect(byType['CREDIT_NOTE']).toMatchObject({
        advanceCount: 2,
        originalAdvanceMinor: '4200',
        actuallyRefundedMinor: '1600',
        pendingRefundReservationMinor: '500',
      });
    });

    it('a manual / unrelated journal that hits either liability account is NOT part of a control (the controls read only the authoritative sources)', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const rc = await receipt(co, co.branchId, cust.customerId, 'CASH', 2_000n, at('2026-06-10'));
      await convertToAdvance(co, co.branchId, cust.customerId, rc.paymentId, 500n);
      const before = await companyReport(co);
      const entryId = randomUUID();
      const c = await pool.connect();
      try {
        await c.query(`SET session_replication_role = 'replica'`);
        await c.query(
          `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
           VALUES ($1,$2,$3,(SELECT id FROM accounting_period WHERE "companyId" = $3 LIMIT 1),'2026-06-10','manual_adjustment',$4,'AED',$5,now())`,
          [entryId, co.tenantId, co.companyId, randomUUID(), `raw-${entryId}`],
        );
        for (const [key, dr, cr] of [
          [ADV_ACCOUNT, 0, 777],
          [UNAPPLIED_ACCOUNT, 333, 0],
          ['EQUITY.OPENING_BALANCE', 444, 0],
        ] as const) {
          await c.query(
            `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
             VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
            [co.tenantId, co.companyId, entryId, key, co.branchId, dr, cr],
          );
        }
        await c.query(`SET session_replication_role = 'origin'`);
      } finally {
        c.release();
      }
      const after = await companyReport(co);
      expect(blocksOf(after)).toEqual(blocksOf(before));
      // the WHOLE accounts carry the manual lines — a whole-account control would have failed
      expect(await glAllKinds(co.companyId, ADV_ACCOUNT)).toBe(
        BigInt(after.advances.reconciliation.glCustomerAdvancesLiabilityMinor) + 777n,
      );
      expect(await glAllKinds(co.companyId, UNAPPLIED_ACCOUNT)).toBe(
        BigInt(after.unappliedReceipts.reconciliation.glUnappliedReceiptsLiabilityMinor) - 333n,
      );
    });
  });

  // ═══════════════════ branch and company scopes ═══════════════════
  describe('branch and company scopes', () => {
    it('Branch A holds only A, Branch B only B, the Company is A + B exactly (both liabilities), and every byBranch row equals its branch report', async () => {
      const A = aed.branchId;
      const B = aed.siblingBranchId;
      const [a, b, company] = [
        await branchReport(aed, A),
        await branchReport(aed, B),
        await companyReport(aed),
      ];
      expect(blocksOf(a)).toEqual(await expectedBlocks(aed.companyId, A));
      expect(blocksOf(b)).toEqual(await expectedBlocks(aed.companyId, B));
      // c4 (4 000 Advance) and c8 (the provider Advance) live in Branch B; the rest in A
      expect(b.advances.advanceCount).toBe(2);
      expect(a.advances.advanceCount).toBe(4);
      expect(company.byBranch.map((r) => r.branchId)).toEqual([A, B].sort());
      for (const row of company.byBranch) {
        const own = row.branchId === A ? a : b;
        expect(blocksOf(row)).toEqual(blocksOf(own));
      }
      const sum = (
        pick: (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) => string,
      ): bigint => BigInt(pick(a)) + BigInt(pick(b));
      for (const pick of [
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) => r.advances.originalAdvanceMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) => r.advances.appliedMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) => r.advances.actuallyRefundedMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) => r.advances.bookLiabilityMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) =>
          r.advances.pendingRefundReservationMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) => r.advances.availableMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) =>
          r.unappliedReceipts.originalReceiptMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) =>
          r.unappliedReceipts.allocatedToReceivablesMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) =>
          r.unappliedReceipts.convertedToAdvanceMinor,
        (r: LiabilitiesBranchReport | LiabilitiesCompanyReport) =>
          r.unappliedReceipts.unappliedReceiptMinor,
      ]) {
        expect(BigInt(pick(company))).toBe(sum(pick));
      }
      // the provider Advance reserves in Branch B only — never moved to Branch A because the customer is tenant-wide
      expect(a.advances.pendingRefundReservationMinor).toBe('0');
      expect(b.advances.pendingRefundReservationMinor).toBe('500');
    });

    it('a branch with no liability is a zero-filled, reconciled report and is absent from byBranch; a foreign / unknown branch is a plain 404', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      await receipt(co, co.branchId, cust.customerId, 'CASH', 900n, at('2026-06-10'));
      const empty = await branchReport(co, co.siblingBranchId);
      expect(empty.advances.advanceCount).toBe(0);
      expect(empty.unappliedReceipts).toMatchObject({
        paymentCount: 0,
        unappliedReceiptMinor: '0',
      });
      expect(empty.advances.reconciliation.reconciled).toBe(true);
      expect(empty.unappliedReceipts.reconciliation.reconciled).toBe(true);
      const company = await companyReport(co);
      expect(company.byBranch.map((r) => r.branchId)).toEqual([co.branchId]);
      expect(await reject(branchReport(co, aed.branchId))).toMatchObject({ status: 404 });
      expect(await reject(branchReport(co, randomUUID()))).toMatchObject({ status: 404 });
    });

    it('another company of the same tenant and another tenant never contribute: each report equals ITS OWN oracle', async () => {
      expect(blocksOf(await companyReport(aed2))).toEqual(await expectedBlocks(aed2.companyId));
      expect(blocksOf(await companyReport(foreign))).toEqual(
        await expectedBlocks(foreign.companyId),
      );
      expect((await companyReport(aed2)).unappliedReceipts.unappliedReceiptMinor).toBe('1000');
      expect((await companyReport(foreign)).unappliedReceipts.unappliedReceiptMinor).toBe('900');
      expect(
        await reject(
          inTenant(() => service.companyReport({ companyId: foreign.companyId }), tenantId),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await reject(
          inTenant(() => service.companyReport({ companyId: aed.companyId }), otherTenantId),
        ),
      ).toMatchObject({ status: 404 });
    });
  });

  // ═══════════════════ the snapshot instant ═══════════════════
  describe('the report is a CURRENT snapshot: asOf is the database instant, never an input', () => {
    it('asOf is an ISO-8601 UTC database timestamp, the app clock never decides it, a later report is not earlier, a client cannot supply it', async () => {
      setClock(new Date('2020-01-01T00:00:00.000Z'));
      const r1 = await companyReport(aed);
      setClock(new Date('2031-01-01T00:00:00.000Z'));
      const r2 = await companyReport(aed);
      setClock(DEFAULT_INSTANT);
      expect(r1.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(r1.asOf >= '2026-01-01').toBe(true); // the database clock, not the 2020 scripted one
      expect(r2.asOf < '2030-01-01').toBe(true); // …and not the 2031 one
      expect(r2.asOf >= r1.asOf).toBe(true);
      const forged = await inTenant(() =>
        (
          service as unknown as { companyReport(i: object): Promise<LiabilitiesCompanyReport> }
        ).companyReport({
          companyId: aed.companyId,
          asOf: '2020-01-01T00:00:00.000Z',
          from: '2020-01-01',
          to: '2020-12-31',
        }),
      );
      expect(forged.asOf).not.toBe('2020-01-01T00:00:00.000Z');
      expect(blocksOf(forged)).toEqual(blocksOf(r2));
    });
  });

  // ═══════════════════ per-customer rows: keyset pagination, no PII ═══════════════════
  describe('per-customer rows are keyset-paginated; the summary and both controls cover the WHOLE scope', () => {
    it('limit 2: every page ≤ 2 rows in customerId order, nextCursor chains to null, the pages concatenate to the full list, the summary never changes', async () => {
      const full = await companyReport(aed, { limit: 200 });
      expect(full.customers.nextCursor).toBeNull();
      const ids = full.customers.rows.map((r) => r.customerId);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toHaveLength(9); // c1 … c9 hold a liability; the anonymous c10 sale holds none
      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      do {
        const page = await companyReport(aed, { limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.customers.rows.length).toBeLessThanOrEqual(2);
        expect(blocksOf(page)).toEqual(blocksOf(full)); // the summary and both controls are the whole scope
        seen.push(...page.customers.rows.map((r) => r.customerId));
        cursor = page.customers.nextCursor ?? undefined;
        guard += 1;
      } while (cursor && guard < 20);
      expect(seen).toEqual(ids);
    });

    it('a deep cursor returns exactly the customers after it; limit = total ⇒ no cursor (no trailing empty page); total − 1 ⇒ a cursor; the max clamps to 200', async () => {
      const full = await companyReport(aed, { limit: 200 });
      const ids = full.customers.rows.map((r) => r.customerId);
      const deep = await companyReport(aed, { cursor: ids[3]!, limit: 200 });
      expect(deep.customers.rows.map((r) => r.customerId)).toEqual(ids.slice(4));
      expect((await companyReport(aed, { limit: ids.length })).customers.nextCursor).toBeNull();
      expect((await companyReport(aed, { limit: ids.length - 1 })).customers.nextCursor).toBe(
        ids[ids.length - 2],
      );
      expect((await companyReport(aed, { limit: 5_000 })).customers.rows).toHaveLength(ids.length);
    });

    it('INVALID_LIMIT / INVALID_CURSOR are 400s and the report is never produced', async () => {
      for (const limit of [0, -1, 1.5, '10']) {
        expect(await reject(companyReport(aed, { limit }))).toMatchObject({
          code: 'INVALID_LIMIT',
          status: 400,
        });
      }
      for (const cursor of ['x', 'not-a-uuid', 7]) {
        expect(await reject(companyReport(aed, { cursor }))).toMatchObject({
          code: 'INVALID_CURSOR',
          status: 400,
        });
      }
    });

    it('every row carries BOTH liabilities for its customer and equals the oracle row (no GL, no PII)', async () => {
      const full = await companyReport(aed, { limit: 200 });
      const model = await loadModel(aed.companyId);
      for (const row of full.customers.rows) {
        const own = scopeOf(model, null, row.customerId);
        expect(row.advances).toEqual(advanceFiguresOf(own.advances).figures);
        expect(row.unappliedReceipts).toEqual(unappliedFiguresOf(own.payments).figures);
        expect(Object.keys(row).sort()).toEqual(['advances', 'customerId', 'unappliedReceipts']);
      }
    });

    it('NO customer name, phone, e-mail or address is returned: the whole serialized report holds only financial identifiers', async () => {
      const reports = [
        await companyReport(aed, { limit: 200 }),
        await branchReport(aed, aed.branchId, { limit: 200 }),
        await companyReport(aed, { customerId: C['c4']!.customerId }),
      ];
      for (const r of reports) {
        const text = JSON.stringify(r);
        expect(text).not.toMatch(/ZZ-PII-NAME|pii-example|\+9715|@/);
        expect(text).not.toMatch(
          /"(?:name|displayName|phone|phoneE164|email|emailNormalized|address|notes)"/i,
        );
      }
      expect(JSON.stringify(reports[0]!.customers.rows)).not.toMatch(
        /ageDays|bucket|overdue|dueDate/i,
      );
    });
  });

  // ═══════════════════ the optional customer filter ═══════════════════
  describe('the optional customer filter scopes the totals, the rows AND both GL controls in one snapshot', () => {
    it('every customer: totals = the oracle for that customer, ONE row, and each control reads only that customer’s journals', async () => {
      for (const n of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']) {
        const r = await companyReport(aed, { customerId: C[n]!.customerId });
        expect(blocksOf(r), n).toEqual(await expectedBlocks(aed.companyId, null, C[n]!.customerId));
        expect(
          r.customers.rows.map((x) => x.customerId),
          n,
        ).toEqual([C[n]!.customerId]);
        expect(
          r.advances.reconciliation.reconciled && r.unappliedReceipts.reconciliation.reconciled,
          n,
        ).toBe(true);
        expect(r.customerId).toBe(C[n]!.customerId);
      }
      // c1 holds only an unapplied receipt; its advance controls are an honest zero
      const c1 = await companyReport(aed, { customerId: C['c1']!.customerId });
      expect(c1.advances).toMatchObject({ advanceCount: 0, bookLiabilityMinor: '0' });
      expect(c1.unappliedReceipts.reconciliation.glUnappliedReceiptsLiabilityMinor).toBe('3000');
    });

    it('customer + branch together; a customer with no account at the company, an unknown id and another tenant’s customer are a 404', async () => {
      const both = await branchReport(aed, aed.siblingBranchId, {
        customerId: C['c4']!.customerId,
      });
      expect(blocksOf(both)).toEqual(
        await expectedBlocks(aed.companyId, aed.siblingBranchId, C['c4']!.customerId),
      );
      // c4 lives in Branch B only: the same customer in Branch A is an honest zero
      const other = await branchReport(aed, aed.branchId, { customerId: C['c4']!.customerId });
      expect(other.advances.advanceCount).toBe(0);
      expect(other.unappliedReceipts.paymentCount).toBe(0);
      expect(await reject(companyReport(aed, { customerId: C['a2']!.customerId }))).toMatchObject({
        status: 404,
      });
      expect(await reject(companyReport(aed, { customerId: randomUUID() }))).toMatchObject({
        status: 404,
      });
      expect(await reject(companyReport(aed, { customerId: C['f1']!.customerId }))).toMatchObject({
        status: 404,
      });
    });
  });

  // ═══════════════════ one statement, one snapshot ═══════════════════
  describe('one statement in one read-only transaction', () => {
    it('ONE statement in ONE transaction per report — company, branch, filtered and paged (no summary / page / GL triple, no N+1)', async () => {
      const counting = () =>
        new (class extends CustomerLiabilitiesReportRepository {
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
          c.getCompanyReportScoped({ companyId: aed.companyId, customerId: C['c8']!.customerId }),
      ];
      for (const run of cases) {
        const c = counting();
        await inTenant(() => run(c));
        expect([c.statements, c.transactions]).toEqual([1, 1]);
      }
    });

    it('the transaction is database-enforced read-only', async () => {
      class Probe extends CustomerLiabilitiesReportRepository {
        async tryWrite(): Promise<unknown> {
          return this.readScoped((tx) =>
            tx.$executeRawUnsafe(`UPDATE branch SET name = name WHERE id = '${aed.branchId}'`),
          );
        }
      }
      await expect(inTenant(() => new Probe(db).tryWrite())).rejects.toThrow(/read-only/i);
    });

    it('no aging and no figure labelled sales / receipts-as-revenue / profit / settled anywhere in the report', async () => {
      const text = JSON.stringify(await companyReport(aed, { limit: 200 }));
      expect(text).not.toMatch(/ageDays|"aging"|bucket|overdue|dueDate/i);
      expect(text).not.toMatch(/"(?:sales|revenue|profit|margin|settled)\w*"/i);
    });
  });

  // ═══════════════════ concurrency: one statement, one snapshot ═══════════════════
  describe('a report read while financial activity commits is internally consistent', () => {
    /** reads in a loop while `work` commits; every read must be ONE coherent state (never a GL / source skew) */
    async function readWhile(
      co: Co,
      work: () => Promise<void>,
    ): Promise<{ reads: LiabilitiesCompanyReport[]; errors: unknown[] }> {
      const reads: LiabilitiesCompanyReport[] = [];
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
      try {
        await work();
      } finally {
        stop = true;
        await reader;
      }
      return { reads, errors };
    }
    const coherent = (r: LiabilitiesCompanyReport): void => {
      expect(r.advances.reconciliation.reconciled).toBe(true);
      expect(r.unappliedReceipts.reconciliation.reconciled).toBe(true);
      // the figures and each GL side belong to ONE state: the book liability IS the GL, the unapplied IS its GL
      expect(r.advances.reconciliation.glCustomerAdvancesLiabilityMinor).toBe(
        r.advances.bookLiabilityMinor,
      );
      expect(r.unappliedReceipts.reconciliation.glUnappliedReceiptsLiabilityMinor).toBe(
        r.unappliedReceipts.unappliedReceiptMinor,
      );
      expect(
        BigInt(r.advances.originalAdvanceMinor) -
          BigInt(r.advances.appliedMinor) -
          BigInt(r.advances.actuallyRefundedMinor),
      ).toBe(BigInt(r.advances.bookLiabilityMinor));
      expect(
        BigInt(r.advances.bookLiabilityMinor) - BigInt(r.advances.pendingRefundReservationMinor),
      ).toBe(BigInt(r.advances.availableMinor));
    };

    it('concurrent CustomerAdvanceApplications (advance −, receivable +, journal Dr advances, in one transaction): every report is one coherent state, never a 500, and the last equals the oracle', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const custs: { cust: Cust; advanceId: string; receivableId: string }[] = [];
      for (let i = 0; i < 8; i++) {
        const cust = await mkCustomer(co);
        const rc = await receipt(
          co,
          co.branchId,
          cust.customerId,
          'CASH',
          2_000n,
          at('2026-06-10'),
        );
        const advanceId = await convertToAdvance(
          co,
          co.branchId,
          cust.customerId,
          rc.paymentId,
          1_500n,
        );
        const s = await sell(
          await mkOrder(co, cust.customerId, one(2_000n + BigInt(i) * 100n)),
          { intent: 'ON_CREDIT' },
          at('2026-06-11'),
        );
        custs.push({ cust, advanceId, receivableId: await receivableOfInvoice(s.invoiceId) });
      }
      const before = await companyReport(co, { limit: 200 });
      const { reads, errors } = await readWhile(co, async () => {
        await Promise.all(
          custs.map((c, i) =>
            applyAdvance(
              co,
              co.branchId,
              c.cust.customerId,
              c.advanceId,
              c.receivableId,
              400n + BigInt(i) * 10n,
            ),
          ),
        );
        await Promise.all(
          custs.map((c) =>
            applyAdvance(co, co.branchId, c.cust.customerId, c.advanceId, c.receivableId, 200n),
          ),
        );
      });
      const after = await companyReport(co, { limit: 200 });
      expect(errors).toEqual([]); // never a GL-mismatch / integrity 500 from a legitimate concurrent commit
      expect(reads.length).toBeGreaterThan(1);
      let lastApplied = BigInt(before.advances.appliedMinor);
      for (const r of [before, ...reads, after]) {
        coherent(r);
        expect(BigInt(r.advances.appliedMinor)).toBeGreaterThanOrEqual(lastApplied); // never a regression
        lastApplied = BigInt(r.advances.appliedMinor);
        expect(r.unappliedReceipts.unappliedReceiptMinor).toBe(
          before.unappliedReceipts.unappliedReceiptMinor,
        ); // an application never touches a receipt
      }
      expect(blocksOf(after)).toEqual(await expectedBlocks(co.companyId));
      expect(BigInt(after.advances.appliedMinor)).toBeGreaterThan(
        BigInt(before.advances.appliedMinor),
      );
    });

    it('concurrent Payment → Advance conversions (unapplied −, advance +, ONE journal Dr unapplied / Cr advances): every report is one coherent state and the two liabilities always sum to the receipts', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const payments: { cust: Cust; paymentId: string }[] = [];
      for (let i = 0; i < 8; i++) {
        const cust = await mkCustomer(co);
        const rc = await receipt(
          co,
          co.branchId,
          cust.customerId,
          'CASH',
          3_000n + BigInt(i) * 10n,
          at('2026-06-10'),
        );
        payments.push({ cust, paymentId: rc.paymentId });
      }
      const before = await companyReport(co, { limit: 200 });
      const { reads, errors } = await readWhile(co, async () => {
        await Promise.all(
          payments.map((p, i) =>
            convertToAdvance(
              co,
              co.branchId,
              p.cust.customerId,
              p.paymentId,
              500n + BigInt(i) * 5n,
            ),
          ),
        );
        await Promise.all(
          payments.map((p) =>
            convertToAdvance(co, co.branchId, p.cust.customerId, p.paymentId, 300n),
          ),
        );
      });
      const after = await companyReport(co, { limit: 200 });
      expect(errors).toEqual([]);
      expect(reads.length).toBeGreaterThan(1);
      const receipts = BigInt(before.unappliedReceipts.originalReceiptMinor);
      for (const r of [before, ...reads, after]) {
        coherent(r);
        // a conversion is a reclass: unapplied + advance book is invariant on EVERY read (never new advance with old unapplied)
        expect(
          BigInt(r.unappliedReceipts.unappliedReceiptMinor) + BigInt(r.advances.bookLiabilityMinor),
        ).toBe(receipts);
        expect(r.unappliedReceipts.originalReceiptMinor).toBe(receipts.toString());
      }
      expect(blocksOf(after)).toEqual(await expectedBlocks(co.companyId));
      expect(BigInt(after.advances.bookLiabilityMinor)).toBeGreaterThan(0n);
    });

    it('concurrent final Refunds (advance book −, journal Dr advances / Cr cash): every report is one coherent state and the book never regresses', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const advs: { cust: Cust; advanceId: string }[] = [];
      for (let i = 0; i < 6; i++) {
        const cust = await mkCustomer(co);
        const a = await paidThenCancelledAdvance(co, cust, co.branchId, [card(2_100n)]);
        advs.push({ cust, advanceId: a.advanceId });
      }
      const before = await companyReport(co, { limit: 200 });
      const { reads, errors } = await readWhile(co, async () => {
        await Promise.all(
          advs.map((a, i) =>
            refundAdvance(co, co.branchId, a.cust.customerId, a.advanceId, 300n + BigInt(i) * 10n),
          ),
        );
        await Promise.all(
          advs.map((a) => refundAdvance(co, co.branchId, a.cust.customerId, a.advanceId, 200n)),
        );
      });
      const after = await companyReport(co, { limit: 200 });
      expect(errors).toEqual([]);
      expect(reads.length).toBeGreaterThan(1);
      let lastBook = BigInt(before.advances.bookLiabilityMinor);
      for (const r of [before, ...reads, after]) {
        coherent(r);
        expect(BigInt(r.advances.bookLiabilityMinor)).toBeLessThanOrEqual(lastBook);
        lastBook = BigInt(r.advances.bookLiabilityMinor);
        expect(r.unappliedReceipts.unappliedReceiptMinor).toBe(
          before.unappliedReceipts.unappliedReceiptMinor,
        ); // a refund consumes no receipt
      }
      expect(blocksOf(after)).toEqual(await expectedBlocks(co.companyId));
      expect(BigInt(after.advances.actuallyRefundedMinor)).toBeGreaterThan(0n);
    });
  });

  // ═══════════════════ malformed ledger: fail closed, never repaired ═══════════════════
  describe('a malformed advance, receipt, application or journal fails the report closed (never repaired, non-disclosing)', () => {
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
      expect(err).toMatchObject({ code: 'REPORT_LIABILITIES_SOURCE_INTEGRITY', status: 500 });
      for (const c of checks) expect(err.message).toContain(c);
      expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // non-disclosing: a check name, never an identifier
      expect((err as unknown as { details?: unknown }).details).toBeUndefined();
      return err;
    }

    interface Fresh {
      co: Co;
      cust: Cust;
      paymentId: string;
      advanceId: string;
      applicationId: string;
    }
    /** a fresh company with ONE receipt of 3 000, a conversion of 1 000 to an Advance and one application of 300 */
    async function fresh(): Promise<Fresh> {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const rc = await receipt(co, co.branchId, cust.customerId, 'CASH', 3_000n, at('2026-06-10'));
      const advanceId = await convertToAdvance(
        co,
        co.branchId,
        cust.customerId,
        rc.paymentId,
        1_000n,
      );
      const s = await sell(
        await mkOrder(co, cust.customerId, one(1_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-11'),
      );
      await applyAdvance(
        co,
        co.branchId,
        cust.customerId,
        advanceId,
        await receivableOfInvoice(s.invoiceId),
        300n,
      );
      const applicationId = (
        await q<{ id: string }>(
          `SELECT id FROM customer_advance_application WHERE "customerAdvanceId" = $1`,
          [advanceId],
        )
      )[0]!.id;
      const ok = await companyReport(co);
      expect(
        ok.advances.reconciliation.reconciled && ok.unappliedReceipts.reconciliation.reconciled,
      ).toBe(true);
      expect(ok.advances.bookLiabilityMinor).toBe('700');
      expect(ok.unappliedReceipts.unappliedReceiptMinor).toBe('2000');
      return { co, cust, paymentId: rc.paymentId, advanceId, applicationId };
    }
    const journalOf = async (kind: string, sourceId: string): Promise<string> =>
      (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = $1 AND "sourceId" = $2`,
          [kind, sourceId],
        )
      )[0]!.id;
    const lineOf = (entryId: string, co: Co, key: string) => ({
      sql: `"journalEntryId" = $1 AND "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = $3)`,
      params: [entryId, co.companyId, key],
    });

    it('the clean baseline: every fresh scenario reconciles BOTH controls (so each failure below is the corruption, nothing else)', async () => {
      for (const f of [await fresh(), await fresh()]) {
        expect(blocksOf(await companyReport(f.co))).toEqual(await expectedBlocks(f.co.companyId));
      }
    });

    it('a currency mismatch — an Advance, an allocation, or a journal — is REPORT_CURRENCY_MISMATCH (409), first', async () => {
      const a = await fresh();
      await corrupt(`UPDATE customer_advance SET "currencyCode" = 'KWD' WHERE id = $1`, [
        a.advanceId,
      ]);
      expect(await reject(companyReport(a.co))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
        status: 409,
      });
      const b = await fresh();
      await corrupt(`UPDATE payment SET "currencyCode" = 'KWD' WHERE id = $1`, [b.paymentId]);
      expect(await reject(companyReport(b.co))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
        status: 409,
      });
      const c = await fresh();
      await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [
        await journalOf('customer_advance', c.advanceId),
      ]);
      expect(await reject(companyReport(c.co))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
        status: 409,
      });
    });

    it('an Advance over-applied, a duplicate application row and a refund beyond the book liability fail closed', async () => {
      const a = await fresh();
      await corrupt(
        `UPDATE customer_advance_application SET "amountMinor" = "amountMinor" + 100000 WHERE id = $1`,
        [a.applicationId],
      );
      await expectIntegrity(companyReport(a.co), 'advanceOverConsumed');
      const b = await fresh();
      await corrupt(
        `INSERT INTO customer_advance_application
         SELECT (jsonb_populate_record(NULL::customer_advance_application, to_jsonb(t) || jsonb_build_object('id', uuidv7()::text))).*
           FROM customer_advance_application t WHERE t.id = $1`,
        [b.applicationId],
      );
      // the duplicate application has no journal of its own: the control proves it
      await expectIntegrity(companyReport(b.co), 'advanceMissingJournals');
      const c = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(c);
      const adv = await paidThenCancelledAdvance(c, cust, c.branchId, [card(2_100n)]);
      await refundAdvance(c, c.branchId, cust.customerId, adv.advanceId, 500n);
      await corrupt(
        `UPDATE customer_advance_refund_application SET "amountMinor" = "amountMinor" + 100000 WHERE "customerAdvanceId" = $1`,
        [adv.advanceId],
      );
      await expectIntegrity(companyReport(c), 'advanceOverConsumed');
    });

    it('a pending reservation beyond the available balance fails closed; a FAILED attempt never counts', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const p = await providerBackedCnAdvance(co, co.branchId, cust);
      const pending = await reserveProviderRefund(
        co,
        co.branchId,
        cust.customerId,
        p.advanceId,
        500n,
      );
      const failed = await reserveProviderRefund(
        co,
        co.branchId,
        cust.customerId,
        p.advanceId,
        700n,
      );
      await finishProviderRefund(
        co,
        co.branchId,
        failed.refundAttemptId,
        'FAILED',
        'ONLINE_GATEWAY',
        '2026-06-14',
      );
      const ok = await companyReport(co);
      expect(ok.advances).toMatchObject({
        bookLiabilityMinor: '2100',
        pendingRefundReservationMinor: '500',
        availableMinor: '1600',
      });
      void pending;
      await corrupt(
        `UPDATE refund_attempt_entitlement_reservation SET "amountMinor" = "amountMinor" + 5000 WHERE "refundAttemptId" = $1`,
        [pending.refundAttemptId],
      );
      await expectIntegrity(companyReport(co), 'advanceReservationBeyondAvailable');
    });

    it('a malformed Payment conversion (an Advance whose source Payment is not a customer receipt) and an over-consumed Payment fail closed', async () => {
      const a = await fresh();
      await corrupt(`UPDATE customer_advance SET "sourcePaymentId" = $2 WHERE id = $1`, [
        a.advanceId,
        randomUUID(),
      ]);
      await expectIntegrity(companyReport(a.co), 'paymentAdvancesWithoutPayment');
      const b = await fresh();
      await corrupt(
        `UPDATE customer_advance SET "amountMinor" = "amountMinor" + 100000 WHERE id = $1`,
        [b.advanceId],
      );
      // the Payment now funds more than it received
      await expectIntegrity(companyReport(b.co), 'paymentOverConsumed');
    });

    it('a missing authoritative GL source (the advances line, or the unapplied line, is gone), an unsealed journal and a wrong sourceId each fail the RIGHT control', async () => {
      const a = await fresh();
      const conv = await journalOf('customer_advance', a.advanceId);
      const advLine = lineOf(conv, a.co, ADV_ACCOUNT);
      await corrupt(`DELETE FROM journal_line WHERE ${advLine.sql}`, advLine.params);
      const eA = await expectIntegrity(companyReport(a.co), 'advanceMissingJournals');
      expect(eA.message).not.toContain('unappliedMissingJournals');
      const b = await fresh();
      const receiptEntry = await journalOf('customer_receipt_payment', b.paymentId);
      const unLine = lineOf(receiptEntry, b.co, UNAPPLIED_ACCOUNT);
      await corrupt(`DELETE FROM journal_line WHERE ${unLine.sql}`, unLine.params);
      const eB = await expectIntegrity(companyReport(b.co), 'unappliedMissingJournals');
      expect(eB.message).not.toContain('advanceMissingJournals');
      const c = await fresh();
      await corrupt(`UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1`, [
        await journalOf('customer_receipt_payment', c.paymentId),
      ]);
      await expectIntegrity(companyReport(c.co), 'unappliedMissingJournals');
      // an unsealed journal is no authority for a branch- or customer-filtered report either
      await expectIntegrity(branchReport(c.co, c.co.branchId), 'unappliedMissingJournals');
      await expectIntegrity(
        companyReport(c.co, { customerId: c.cust.customerId }),
        'unappliedMissingJournals',
      );
      const d = await fresh();
      await corrupt(`UPDATE journal_entry SET "sourceId" = $2 WHERE id = $1`, [
        await journalOf('customer_advance_application', d.applicationId),
        randomUUID(),
      ]);
      const company = await expectIntegrity(companyReport(d.co), 'advanceMissingJournals');
      expect(company.message).toContain('advanceOrphanJournals'); // unattributable → the company report only
      const branch = await expectIntegrity(
        branchReport(d.co, d.co.branchId),
        'advanceMissingJournals',
      );
      expect(branch.message).not.toContain('advanceOrphanJournals');
    });

    it('a duplicate authoritative journal is impossible at the database (unique source index); a duplicate EFFECT inside a journal fails the shape control of the account it touches', async () => {
      const f = await fresh();
      const entryId = await journalOf('customer_advance', f.advanceId);
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
      // an extra balanced Dr UNAPPLIED / Cr ADVANCES pair of EXACTLY the same amount: each account's effect is doubled
      for (const [key, dr, cr] of [
        [UNAPPLIED_ACCOUNT, 1_000, 0],
        [ADV_ACCOUNT, 0, 1_000],
      ] as const) {
        await corrupt(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
           VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
          [f.co.tenantId, f.co.companyId, entryId, key, f.co.branchId, dr, cr],
        );
      }
      await expectIntegrity(
        companyReport(f.co),
        'advanceJournalShapeMismatches',
        'unappliedJournalShapeMismatches',
      );
    });

    it('advance / unapplied CROSS-NETTING is impossible: offsetting corruption on the one conversion journal fails BOTH controls, never passes as a zero sum', async () => {
      const f = await fresh();
      const entryId = await journalOf('customer_advance', f.advanceId);
      // +500 on the advances credit AND +500 on the unapplied debit: the journal stays balanced, the two GL nets move by
      // +500 and −500 — their SUM is zero. Each control must still fail by itself.
      const advLine = lineOf(entryId, f.co, ADV_ACCOUNT);
      const unLine = lineOf(entryId, f.co, UNAPPLIED_ACCOUNT);
      await corrupt(
        `UPDATE journal_line SET "creditMinor" = "creditMinor" + 500 WHERE ${advLine.sql}`,
        advLine.params,
      );
      await corrupt(
        `UPDATE journal_line SET "debitMinor" = "debitMinor" + 500 WHERE ${unLine.sql}`,
        unLine.params,
      );
      await expectIntegrity(
        companyReport(f.co),
        'advanceJournalShapeMismatches',
        'unappliedJournalShapeMismatches',
      );
    });

    it('wrong branch attribution fails closed — a journal line, an application, an allocation, a refund application or a conversion', async () => {
      const a = await fresh();
      const l = lineOf(await journalOf('customer_advance', a.advanceId), a.co, ADV_ACCOUNT);
      await corrupt(`UPDATE journal_line SET "branchId" = $4 WHERE ${l.sql}`, [
        ...l.params,
        a.co.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(a.co), 'advanceJournalBranchMismatches');
      const b = await fresh();
      await corrupt(`UPDATE customer_advance_application SET "branchId" = $2 WHERE id = $1`, [
        b.applicationId,
        b.co.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(b.co), 'advanceApplicationBranchMismatches');
      const c = await fresh();
      const l2 = lineOf(
        await journalOf('customer_receipt_payment', c.paymentId),
        c.co,
        UNAPPLIED_ACCOUNT,
      );
      await corrupt(`UPDATE journal_line SET "branchId" = $4 WHERE ${l2.sql}`, [
        ...l2.params,
        c.co.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(c.co), 'unappliedJournalBranchMismatches');
      const d = await fresh();
      await corrupt(`UPDATE customer_advance SET "branchId" = $2 WHERE id = $1`, [
        d.advanceId,
        d.co.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(d.co), 'paymentAdvanceBranchMismatches');
    });

    it('a CreditNote Advance without its coverage release fails closed (the excess is only ever reached through its release)', async () => {
      const c = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(c);
      const adv = await paidThenCancelledAdvance(c, cust, c.branchId, [card(2_100n)]);
      expect(blocksOf(await companyReport(c))).toEqual(await expectedBlocks(c.companyId));
      await corrupt(`DELETE FROM credit_note_coverage_release WHERE "customerAdvanceId" = $1`, [
        adv.advanceId,
      ]);
      await expectIntegrity(companyReport(c), 'creditNoteAdvancesWithoutRelease');
    });

    it('wrong branch attribution fails closed on the other four attributions — a refund application, a PENDING reservation, a PaymentAllocation and a receivable payment application', async () => {
      // a refund application whose branch is not its Advance's
      const a = await makeCompany(tenantId, { currency: 'AED' });
      const custA = await mkCustomer(a);
      const advA = await paidThenCancelledAdvance(a, custA, a.branchId, [card(2_100n)]);
      await refundAdvance(a, a.branchId, custA.customerId, advA.advanceId, 500n);
      expect(blocksOf(await companyReport(a))).toEqual(await expectedBlocks(a.companyId));
      await corrupt(
        `UPDATE customer_advance_refund_application SET "branchId" = $2 WHERE "customerAdvanceId" = $1`,
        [advA.advanceId, a.siblingBranchId],
      );
      await expectIntegrity(companyReport(a), 'advanceRefundApplicationBranchMismatches');

      // a PENDING reservation whose branch is not its Advance's
      const b = await makeCompany(tenantId, { currency: 'AED' });
      const custB = await mkCustomer(b);
      const pAdv = await providerBackedCnAdvance(b, b.branchId, custB);
      const pending = await reserveProviderRefund(
        b,
        b.branchId,
        custB.customerId,
        pAdv.advanceId,
        500n,
      );
      expect(blocksOf(await companyReport(b))).toEqual(await expectedBlocks(b.companyId));
      await corrupt(
        `UPDATE refund_attempt_entitlement_reservation SET "branchId" = $2 WHERE "refundAttemptId" = $1`,
        [pending.refundAttemptId, b.siblingBranchId],
      );
      await expectIntegrity(companyReport(b), 'advanceReservationBranchMismatches');

      // a PaymentAllocation whose branch is not its Payment's (a credit sale first, so the receipt allocates to it)
      const c = await makeCompany(tenantId, { currency: 'AED' });
      const custC = await mkCustomer(c);
      await sell(
        await mkOrder(c, custC.customerId, one(1_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-11'),
      );
      const rcC = await receipt(c, c.branchId, custC.customerId, 'CASH', 1_500n, at('2026-06-12'));
      expect(rcC.allocatedAmountMinor).toBe('1050'); // the invoice: 1 000 net + 5 % VAT
      expect(blocksOf(await companyReport(c))).toEqual(await expectedBlocks(c.companyId));
      await corrupt(`UPDATE payment_allocation SET "branchId" = $2 WHERE "paymentId" = $1`, [
        rcC.paymentId,
        c.siblingBranchId,
      ]);
      await expectIntegrity(companyReport(c), 'allocationBranchMismatches');

      // a receivable payment application whose branch is not its Payment's (an opening receivable, then a receipt)
      const d = await makeCompany(tenantId, { currency: 'AED' });
      const custD = await mkCustomer(d);
      await openingReceivable(d, d.branchId, custD.customerId, 800n, '2026-05-15');
      const rcD = await receipt(d, d.branchId, custD.customerId, 'CASH', 500n, at('2026-06-12'));
      expect(rcD.allocatedAmountMinor).toBe('500');
      expect(blocksOf(await companyReport(d))).toEqual(await expectedBlocks(d.companyId));
      await corrupt(
        `UPDATE customer_receivable_payment_application SET "branchId" = $2 WHERE "paymentId" = $1`,
        [rcD.paymentId, d.siblingBranchId],
      );
      await expectIntegrity(companyReport(d), 'receivablePaymentApplicationBranchMismatches');
    });

    it('a same-tenant foreign-company or foreign-tenant row of every source table never contributes and never fails the report', async () => {
      const f = await fresh();
      const other = await makeCompany(tenantId, { currency: 'AED' });
      const model = await expectedBlocks(f.co.companyId);
      const copyTo = (
        table: string,
        where: string,
        param: string,
        companyId: string,
        tenant: string,
        extra: Record<string, unknown> = {},
      ): Promise<void> =>
        corrupt(
          `INSERT INTO ${table}
           SELECT (jsonb_populate_record(NULL::${table},
                    to_jsonb(t) || jsonb_build_object('id', uuidv7()::text, 'companyId', $1::text, 'tenantId', $2::text) || $3::jsonb)).*
             FROM ${table} t WHERE ${where}`,
          [companyId, tenant, JSON.stringify(extra), param],
        );
      for (const [tid, cid] of [
        [f.co.tenantId, other.companyId], // another company of the same tenant
        [foreign.tenantId, foreign.companyId], // another tenant
      ] as const) {
        await copyTo('customer_advance', 'id = $4', f.advanceId, cid, tid, { amountMinor: 777 });
        await copyTo(
          'customer_advance_application',
          '"customerAdvanceId" = $4',
          f.advanceId,
          cid,
          tid,
          { amountMinor: 77 },
        );
        await copyTo('payment_allocation', '"paymentId" = $4', f.paymentId, cid, tid);
        await copyTo(
          'customer_receivable_payment_application',
          '"paymentId" = $4',
          f.paymentId,
          cid,
          tid,
        );
        const r = await companyReport(f.co);
        expect(blocksOf(r)).toEqual(model);
        expect(
          r.advances.reconciliation.reconciled && r.unappliedReceipts.reconciliation.reconciled,
        ).toBe(true);
      }
    });

    it('an orphan authoritative-kind journal fails the unfiltered company report ONLY, naming the control it touches', async () => {
      const f = await fresh();
      const entryId = randomUUID();
      await withReplica(async (c) => {
        await c.query(
          `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
           VALUES ($1,$2,$3,(SELECT id FROM accounting_period WHERE "companyId" = $3 LIMIT 1),'2026-06-10','customer_advance',$4,'AED',$5,now())`,
          [entryId, f.co.tenantId, f.co.companyId, randomUUID(), `raw-${entryId}`],
        );
        for (const [key, dr, cr] of [
          [UNAPPLIED_ACCOUNT, 40, 0],
          [ADV_ACCOUNT, 0, 40],
        ] as const) {
          await c.query(
            `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
             VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
            [f.co.tenantId, f.co.companyId, entryId, key, f.co.branchId, dr, cr],
          );
        }
      });
      await expectIntegrity(
        companyReport(f.co),
        'advanceOrphanJournals',
        'unappliedOrphanJournals',
      );
      // a branch / customer-filtered report cannot attribute it, so it does not carry the defect
      expect((await branchReport(f.co, f.co.branchId)).advances.reconciliation.reconciled).toBe(
        true,
      );
      expect(
        (await companyReport(f.co, { customerId: f.cust.customerId })).unappliedReceipts
          .reconciliation.reconciled,
      ).toBe(true);
    });

    it('a malformed item in Branch B neither fails nor discloses itself in a healthy Branch A report; Branch B and the Company fail closed', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const ca = await mkCustomer(co);
      const cb = await mkCustomer(co);
      await receipt(co, co.branchId, ca.customerId, 'CASH', 2_000n, at('2026-06-10'));
      const rb = await receipt(
        co,
        co.siblingBranchId,
        cb.customerId,
        'CASH',
        2_000n,
        at('2026-06-10'),
      );
      const okA = await branchReport(co, co.branchId);
      const l = lineOf(
        await journalOf('customer_receipt_payment', rb.paymentId),
        co,
        UNAPPLIED_ACCOUNT,
      );
      await corrupt(`UPDATE journal_line SET "branchId" = $4 WHERE ${l.sql}`, [
        ...l.params,
        co.branchId,
      ]);
      const a = await branchReport(co, co.branchId);
      expect(blocksOf(a)).toEqual(blocksOf(okA));
      expect(a.unappliedReceipts.reconciliation.reconciled).toBe(true);
      await expectIntegrity(
        branchReport(co, co.siblingBranchId),
        'unappliedJournalBranchMismatches',
      );
      await expectIntegrity(companyReport(co), 'unappliedJournalBranchMismatches');
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

  // ═══════════════════ EL-1 — the density guard: at most CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS roots per EVALUATED scope ═══════════════════
  describe('the density guard (owner ruling EL-1): at most CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS Payment + CustomerAdvance roots in the evaluated scope', () => {
    /** a repository with another limit (the protected seam) — only tests pass one; production uses the constant */
    const limited = (n: number): CustomerLiabilitiesReportRepository =>
      new (class extends CustomerLiabilitiesReportRepository {
        protected override readonly maxRoots: number = n;
      })(db);
    const companyWith = (n: number, co: Co, extra: Extra = {}): Promise<LiabilitiesCompanyReport> =>
      inTenant(
        () => limited(n).getCompanyReportScoped({ companyId: co.companyId, ...extra }),
        co.tenantId,
      );
    const branchWith = (
      n: number,
      co: Co,
      branchId: string,
      extra: Extra = {},
    ): Promise<LiabilitiesBranchReport> =>
      inTenant(
        () => limited(n).getBranchReportScoped({ companyId: co.companyId, branchId, ...extra }),
        co.tenantId,
      );
    const TOO_LARGE = { code: 'REPORT_RESULT_TOO_LARGE', status: 422 };
    const detailsOf = (n: number) => [
      { field: 'maxRoots', issue: String(n) },
      { field: 'action', issue: 'narrow_scope' },
    ];
    /** the EXACT root count of a scope: the smallest limit that accepts it — the guard itself is the measuring instrument */
    async function rootsOf(run: (limit: number) => Promise<unknown>): Promise<number> {
      const accepts = async (n: number): Promise<boolean> => {
        try {
          await run(n);
          return true;
        } catch (e) {
          if (e instanceof DomainError && e.code === 'REPORT_RESULT_TOO_LARGE') return false;
          throw e;
        }
      };
      expect(await accepts(64), 'the scope is small enough to measure').toBe(true);
      let lo = 0;
      let hi = 64;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await accepts(mid)) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
    /** an INDEPENDENT oracle: customer-attributable Payments (the two frozen attribution legs) + CustomerAdvances of a scope */
    const oracleRoots = async (
      companyId: string,
      branchId: string | null = null,
      customerId: string | null = null,
    ): Promise<number> =>
      Number(
        (
          await q<{ n: string }>(
            `SELECT (
               (SELECT count(*) FROM customer_advance ca
                  JOIN customer_company_account x ON x.id = ca."customerCompanyAccountId"
                 WHERE ca."companyId" = $1 AND ($2::uuid IS NULL OR ca."branchId" = $2::uuid)
                   AND ($3::uuid IS NULL OR x."customerId" = $3::uuid))
             + (SELECT count(*) FROM payment p
                  JOIN payment_attempt pa ON pa.id = p."sourceAttemptId"
                  LEFT JOIN customer_company_account xr ON xr.id = pa."customerCompanyAccountId"
                  LEFT JOIN invoice i ON i.id = pa."targetInvoiceId"
                  LEFT JOIN "order" o ON o.id = i."orderId"
                  LEFT JOIN customer_company_account xi ON xi."companyId" = p."companyId" AND xi."customerId" = o."customerId"
                 WHERE p."companyId" = $1 AND ($2::uuid IS NULL OR p."branchId" = $2::uuid)
                   AND COALESCE(xr.id, xi.id) IS NOT NULL
                   AND ($3::uuid IS NULL OR COALESCE(xr."customerId", xi."customerId") = $3::uuid))
             )::text AS n`,
            [companyId, branchId, customerId],
          )
        )[0]!.n,
      );
    const countRows = async (table: string, companyId: string): Promise<number> =>
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE "companyId" = $1`,
            [companyId],
          )
        )[0]!.n,
      );

    // ONE company whose roots have a known size per branch and per customer (9 in all):
    //   Branch A: d1 receipts ×2 · d2 opening advance ×1 + a paid-on-the-spot sale ×1                       = 4
    //   Branch B: d1 receipt ×1 + opening advance ×1 · d3 receipts ×3                                        = 5
    //   customers: d1 = 4, d2 = 2, d3 = 3.  Dependent facts (+0): d2's credit sale + its Advance application,
    //   d3's credit sale + the allocations of its receipts; and a walk-in sale in A (no customer account — no root)
    let dco: Co;
    let d1: Cust;
    let d2: Cust;
    let d3: Cust;
    beforeAll(async () => {
      dco = await makeCompany(tenantId, { currency: 'AED' });
      d1 = await mkCustomer(dco);
      d2 = await mkCustomer(dco);
      d3 = await mkCustomer(dco);
      const brA = dco.branchId;
      const brB = dco.siblingBranchId;
      await sell(
        await mkOrder(dco, d3.customerId, one(1_000n), brB),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      const adv2 = await openingAdvance(dco, brA, d2.customerId, 500n, '2026-05-20');
      const s2 = await sell(
        await mkOrder(dco, d2.customerId, one(1_000n), brA),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      await applyAdvance(
        dco,
        brA,
        d2.customerId,
        adv2,
        await receivableOfInvoice(s2.invoiceId),
        300n,
      );
      await sell(
        await mkOrder(dco, d2.customerId, one(1_000n), brA),
        { tenders: [cash(1_050n)] },
        at('2026-06-10'),
      );
      await receipt(dco, brA, d1.customerId, 'CASH', 1_000n, at('2026-06-11'));
      await receipt(dco, brA, d1.customerId, 'CASH', 1_000n, at('2026-06-11'));
      await receipt(dco, brB, d1.customerId, 'CASH', 2_000n, at('2026-06-11'));
      await openingAdvance(dco, brB, d1.customerId, 700n, '2026-05-20');
      for (let i = 0; i < 3; i++) {
        await receipt(dco, brB, d3.customerId, 'CASH', 400n, at('2026-06-11'));
      }
      await sell(
        await mkOrder(dco, null, one(1_000n), brA),
        { tenders: [cash(1_050n)] },
        at('2026-06-10'),
      );
    }, 600_000);

    it('the world has exactly the intended scope sizes (an INDEPENDENT oracle), and the guard measures the very same sizes', async () => {
      expect(await oracleRoots(dco.companyId)).toBe(9);
      expect(await oracleRoots(dco.companyId, dco.branchId)).toBe(4);
      expect(await oracleRoots(dco.companyId, dco.siblingBranchId)).toBe(5);
      expect(await oracleRoots(dco.companyId, null, d1.customerId)).toBe(4);
      expect(await oracleRoots(dco.companyId, null, d2.customerId)).toBe(2);
      expect(await oracleRoots(dco.companyId, null, d3.customerId)).toBe(3);
      // the guard's own count equals the oracle for every scope (and a scope's report holds exactly that many records)
      expect(await rootsOf((n) => companyWith(n, dco))).toBe(9);
      expect(await rootsOf((n) => branchWith(n, dco, dco.branchId))).toBe(4);
      expect(await rootsOf((n) => branchWith(n, dco, dco.siblingBranchId))).toBe(5);
      for (const [c, n] of [
        [d1, 4],
        [d2, 2],
        [d3, 3],
      ] as const) {
        expect(await rootsOf((k) => companyWith(k, dco, { customerId: c.customerId }))).toBe(n);
        const r = await companyReport(dco, { customerId: c.customerId });
        expect(r.advances.advanceCount + r.unappliedReceipts.paymentCount).toBe(n);
      }
    });

    it('the limit is the one v1 constant, 100 000 — the production repository default, an independent constant of every other report limit', async () => {
      expect(CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS).toBe(100_000);
      class Peek extends CustomerLiabilitiesReportRepository {
        limit(): number {
          return this.maxRoots;
        }
      }
      expect(new Peek(db).limit()).toBe(CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS);
    });

    it('company scope: exactly the limit is accepted (the same figures as the unguarded report) and ONE more is rejected', async () => {
      const unguarded = await companyReport(dco, { limit: 200 });
      const atLimit = await companyWith(9, dco, { limit: 200 });
      expect(blocksOf(atLimit)).toEqual(blocksOf(unguarded));
      expect(atLimit.byBranch).toEqual(unguarded.byBranch);
      expect(atLimit.customers).toEqual(unguarded.customers);
      expect(atLimit.advances.advanceCount + atLimit.unappliedReceipts.paymentCount).toBe(9);
      expect(await reject(companyWith(8, dco))).toMatchObject(TOO_LARGE);
    });

    it('branch scope is SCOPE-LOCAL: sibling branches never contribute — each branch is judged on its own roots', async () => {
      // the company (9) is over a limit of 5, yet Branch A (4) and Branch B (5) are each within it
      expect(await reject(companyWith(5, dco))).toMatchObject(TOO_LARGE);
      const a = await branchWith(5, dco, dco.branchId);
      const b = await branchWith(5, dco, dco.siblingBranchId);
      expect(a.advances.advanceCount + a.unappliedReceipts.paymentCount).toBe(4);
      expect(b.advances.advanceCount + b.unappliedReceipts.paymentCount).toBe(5);
      // exactly the branch size is accepted, one fewer rejected — Branch A (4) still fine where Branch B (5) is not
      expect(blocksOf(await branchWith(4, dco, dco.branchId))).toEqual(blocksOf(a));
      expect(await reject(branchWith(4, dco, dco.siblingBranchId))).toMatchObject(TOO_LARGE);
      expect(await reject(branchWith(3, dco, dco.branchId))).toMatchObject(TOO_LARGE);
      expect(blocksOf(await branchWith(5, dco, dco.siblingBranchId))).toEqual(blocksOf(b));
    });

    it('customer-filtered scope is SCOPE-LOCAL: judged on the customer’s own roots after the company / branch filter', async () => {
      // the company is over a limit of 3 (9), customers of 2 and 3 roots are not
      expect(await reject(companyWith(3, dco))).toMatchObject(TOO_LARGE);
      for (const [c, n] of [
        [d2, 2],
        [d3, 3],
      ] as const) {
        const r = await companyWith(3, dco, { customerId: c.customerId });
        expect(r.advances.advanceCount + r.unappliedReceipts.paymentCount).toBe(n);
        expect(r.customers.rows.map((x) => x.customerId)).toEqual([c.customerId]);
      }
      // d1 holds 4: one fewer is rejected, exactly 4 is accepted; a smaller customer still passes the same limit
      expect(await reject(companyWith(3, dco, { customerId: d1.customerId }))).toMatchObject(
        TOO_LARGE,
      );
      expect(
        (await companyWith(4, dco, { customerId: d1.customerId })).customers.rows,
      ).toHaveLength(1);
      expect(await reject(companyWith(1, dco, { customerId: d2.customerId }))).toMatchObject(
        TOO_LARGE,
      );
      // customer + branch: the scope is the intersection — d1 holds 2 in A and 2 in B, d2 holds 2 in A, d3 none in A
      for (const [br, c, n] of [
        [dco.branchId, d1, 2],
        [dco.siblingBranchId, d1, 2],
        [dco.branchId, d2, 2],
        [dco.siblingBranchId, d3, 3],
        [dco.branchId, d3, 0],
      ] as const) {
        expect(await rootsOf((k) => branchWith(k, dco, br, { customerId: c.customerId }))).toBe(n);
      }
      expect(
        await reject(branchWith(1, dco, dco.branchId, { customerId: d1.customerId })),
      ).toMatchObject(TOO_LARGE);
      expect(
        await reject(branchWith(2, dco, dco.siblingBranchId, { customerId: d3.customerId })),
      ).toMatchObject(TOO_LARGE);
    });

    it('the page size never decides the guard: a page of 1 over an accepted scope, a page of 200 over a rejected one', async () => {
      const small = await companyWith(9, dco, { limit: 1 });
      expect(small.advances.advanceCount + small.unappliedReceipts.paymentCount).toBe(9); // the whole scope
      expect(small.customers.rows).toHaveLength(1);
      expect(small.customers.nextCursor).not.toBeNull();
      for (const limit of [1, 2, 200]) {
        expect(await reject(companyWith(8, dco, { limit }))).toMatchObject(TOO_LARGE);
      }
    });

    it('the rejection is generic and non-disclosing: the limit and a narrowing hint, never the actual count, a sibling, a customer, an id or a figure', async () => {
      const cases: [string, number, number, Promise<DomainError>][] = [
        ['company', 4, 9, reject(companyWith(4, dco))],
        ['branch', 3, 5, reject(branchWith(3, dco, dco.siblingBranchId))],
        ['customer', 2, 4, reject(companyWith(2, dco, { customerId: d1.customerId }))],
      ];
      for (const [route, limit, actual, p] of cases) {
        const e = await p;
        expect(e, route).toMatchObject(TOO_LARGE);
        expect(e.details, route).toEqual(detailsOf(limit));
        const text = JSON.stringify({ message: e.message, details: e.details });
        expect(text, route).not.toMatch(new RegExp(`\\b${actual}\\b`));
        expect(text, route).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
        expect(text, route).not.toMatch(/Minor|book|unapplied|available|reserved|refund/i);
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
      expect(r.advances.advanceCount + r.unappliedReceipts.paymentCount).toBe(0);
      expect(
        r.advances.reconciliation.reconciled && r.unappliedReceipts.reconciliation.reconciled,
      ).toBe(true);
    });

    it('a rejected report is ONE statement in ONE read-only transaction and writes nothing; the accepted one is too', async () => {
      const counting = (n: number) =>
        new (class extends CustomerLiabilitiesReportRepository {
          statements = 0;
          transactions = 0;
          protected override readonly maxRoots: number = n;
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
      const marks = (): Promise<{ n: string }[]> =>
        q<{ n: string }>(
          `SELECT (SELECT count(*) FROM audit_log)::text || ':' || (SELECT count(*) FROM outbox)::text AS n`,
        );
      const before = await marks();
      for (const [n, rejected] of [
        [8, true],
        [9, false],
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
      expect(await marks()).toEqual(before);
    });

    it('the over-limit answer PRECEDES the integrity analysis: a malformed scope is rejected for its size, and is reported once it is within the limit', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const rc = await receipt(co, co.branchId, cust.customerId, 'CASH', 2_000n, at('2026-06-10'));
      const entryId = (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = 'customer_receipt_payment' AND "sourceId" = $1`,
          [rc.paymentId],
        )
      )[0]!.id;
      const c = await pool.connect();
      try {
        await c.query(`SET session_replication_role = 'replica'`);
        await c.query(
          `DELETE FROM journal_line WHERE "journalEntryId" = $1 AND "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'LIABILITY.UNAPPLIED_RECEIPTS')`,
          [entryId, co.companyId],
        );
        await c.query(`SET session_replication_role = 'origin'`);
      } finally {
        c.release();
      }
      // within the limit: the malformed scope fails its integrity check
      expect(await reject(companyWith(1, co))).toMatchObject({
        code: 'REPORT_LIABILITIES_SOURCE_INTEGRITY',
        status: 500,
      });
      // above the limit: no financial analysis is made — the size answer comes first
      expect(await reject(companyWith(0, co))).toMatchObject(TOO_LARGE);
    });

    it('the ROOT DEFINITION: a Payment is +1, a CustomerAdvance +1, a Payment-derived Advance +2 in all, a walk-in Payment 0 and EVERY dependent fact +0', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const roots = (): Promise<number> => rootsOf((n) => companyWith(n, co));
      expect(await roots(), 'an empty company').toBe(0);

      // a CUSTOMER_RECEIPT Payment (attributed through the attempt's own company account): +1
      const rc1 = await receipt(co, co.branchId, cust.customerId, 'CASH', 3_000n, at('2026-06-10'));
      expect(await roots(), 'a customer receipt').toBe(1);

      // a WALK-IN Payment (no customer account): 0 — it exists as a Payment, it is no liability root
      await sell(
        await mkOrder(co, null, one(1_000n)),
        { tenders: [cash(1_050n)] },
        at('2026-06-10'),
      );
      expect(await countRows('payment', co.companyId), 'the walk-in Payment exists').toBe(2);
      expect(await roots(), 'a walk-in Payment').toBe(1);

      // an INVOICE_COLLECTION Payment (attributed through the invoice → order → customer): +1
      await sell(
        await mkOrder(co, cust.customerId, one(1_000n)),
        { tenders: [cash(1_050n)] },
        at('2026-06-10'),
      );
      expect(await roots(), 'a customer-order Payment (invoice collection)').toBe(2);

      // an OPENING CustomerAdvance: +1
      const adv = await openingAdvance(co, co.branchId, cust.customerId, 500n, '2026-05-20');
      expect(await roots(), 'an opening advance').toBe(3);

      // a Payment-derived CustomerAdvance: the Payment (already a root) AND the Advance (+1) — two roots, never de-duplicated
      await convertToAdvance(co, co.branchId, cust.customerId, rc1.paymentId, 1_000n);
      expect(await roots(), 'a Payment-derived advance').toBe(4);

      // a credit sale (a CustomerReceivable) and an AdvanceApplication: +0 each
      const credit = await sell(
        await mkOrder(co, cust.customerId, one(1_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-11'),
      );
      await applyAdvance(
        co,
        co.branchId,
        cust.customerId,
        adv,
        await receivableOfInvoice(credit.invoiceId),
        300n,
      );
      expect(await countRows('customer_advance_application', co.companyId)).toBe(1);
      expect(await roots(), 'a receivable and an Advance application').toBe(4);

      // a receipt allocated to that receivable: the Payment +1, the PaymentAllocation +0
      const allocations = await countRows('payment_allocation', co.companyId);
      const rc2 = await receipt(co, co.branchId, cust.customerId, 'CASH', 500n, at('2026-06-12'));
      expect(rc2.allocatedAmountMinor).toBe('500');
      expect(await countRows('payment_allocation', co.companyId)).toBe(allocations + 1);
      expect(await roots(), 'a receipt and its PaymentAllocation').toBe(5);

      // an OPENING receivable (+0) and a receipt applied to it: the Payment +1, the receivable payment application +0
      const applications = await countRows('customer_receivable_payment_application', co.companyId);
      // (one opening balance per customer and branch: this second customer owns the opening receivable)
      const cust2 = await mkCustomer(co);
      await openingReceivable(co, co.branchId, cust2.customerId, 800n, '2026-05-15');
      await receipt(co, co.branchId, cust2.customerId, 'CASH', 200n, at('2026-06-13'));
      expect(await countRows('customer_receivable_payment_application', co.companyId)).toBe(
        applications + 1,
      );
      expect(await roots(), 'a receipt and its receivable payment application').toBe(6);

      // a card-paid customer sale: its Payment +1; its cancellation: the CreditNote +0, the coverage release +0, the
      // CREDIT_NOTE Advance of its excess +1
      const order = await mkOrder(co, cust.customerId, one(2_000n));
      await sell(order, { tenders: [card(2_100n)] }, at('2026-06-10'));
      expect(await roots(), 'a card-paid sale').toBe(7);
      await cancel(order, at('2026-06-11'));
      expect(await countRows('credit_note', co.companyId)).toBe(1);
      expect(await countRows('credit_note_coverage_release', co.companyId)).toBe(1);
      expect(await roots(), 'a CreditNote (+0) whose excess is one Advance (+1)').toBe(8);

      // a local Refund of that Advance: the Refund +0, the refund application +0
      const [cnAdvance] = await advancesOfOrder(order.orderId);
      await refundAdvance(co, co.branchId, cust.customerId, cnAdvance!, 500n);
      expect(await countRows('refund', co.companyId)).toBe(1);
      expect(await countRows('customer_advance_refund_application', co.companyId)).toBe(1);
      expect(await roots(), 'a Refund and its refund application').toBe(8);

      // the independent oracle agrees, and so does the report's own record count
      expect(await oracleRoots(co.companyId)).toBe(8);
      const r = await companyReport(co);
      expect(r.advances.advanceCount + r.unappliedReceipts.paymentCount).toBe(8);

      // a Payment-derived Advance is TWO roots in a clean company too (the Payment, then the Advance)
      const pd = await makeCompany(tenantId, { currency: 'AED' });
      const pdc = await mkCustomer(pd);
      const rp = await receipt(pd, pd.branchId, pdc.customerId, 'CASH', 1_000n, at('2026-06-10'));
      expect(await rootsOf((n) => companyWith(n, pd))).toBe(1);
      await convertToAdvance(pd, pd.branchId, pdc.customerId, rp.paymentId, 400n);
      expect(await rootsOf((n) => companyWith(n, pd))).toBe(2);
    });

    it('a RefundAttempt reservation and a SettlementApplication are +0: a provider-backed CreditNote Advance is exactly its provider Payment and its Advance', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const cust = await mkCustomer(co);
      const roots = (): Promise<number> => rootsOf((n) => companyWith(n, co));
      const p = await providerBackedCnAdvance(co, co.branchId, cust);
      // the dependent facts exist: an allocation, a finalized settlement and its application, a CreditNote and its release
      expect(await countRows('payment_allocation', co.companyId)).toBe(1);
      expect(await countRows('settlement_batch', co.companyId)).toBeGreaterThan(0);
      expect(await countRows('settlement_application', co.companyId)).toBeGreaterThan(0);
      expect(await countRows('credit_note', co.companyId)).toBe(1);
      expect(await countRows('credit_note_coverage_release', co.companyId)).toBe(1);
      expect(await roots(), 'a provider Payment + its CreditNote Advance').toBe(2);
      // a PENDING provider refund: a RefundAttempt and its entitlement reservation
      await reserveProviderRefund(co, co.branchId, cust.customerId, p.advanceId, 500n);
      expect(await countRows('refund_attempt', co.companyId)).toBe(1);
      expect(await countRows('refund_attempt_entitlement_reservation', co.companyId)).toBe(1);
      expect(await roots(), 'a RefundAttempt and its reservation').toBe(2);
      expect(await oracleRoots(co.companyId)).toBe(2);
    });
  });
});
