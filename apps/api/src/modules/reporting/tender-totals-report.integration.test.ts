import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { SYSTEM_ROLE_TEMPLATES } from '../platform/system-roles.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import type { CommercialSnapshotLine } from '../orders/commercial-snapshot.js';
import { PaymentAttemptReservationRepository } from '../payments/payment-attempt-reservation.repository.js';
import { PaymentProviderRegistry } from '../payments/payment-provider-registry.js';
import { PaymentWebhookRepository } from '../payments/payment-webhook.repository.js';
import type {
  PaymentProvider,
  VerifiedProviderWebhookEvent,
} from '../payments/payment-provider.port.js';
import { TENDER_METHODS } from '../payments/tender.js';
import { PaymentAdvanceConversionRepository } from '../receivables/payment-advance-conversion.repository.js';
import { RefundAttemptReservationRepository } from '../receivables/refund-attempt-reservation.repository.js';
import {
  TenderTotalsReportRepository,
  type TenderTotalsBranchReport,
  type TenderTotalsCompanyReport,
} from './tender-totals-report.repository.js';
import { TenderTotalsReportService } from './tender-totals-report.service.js';
import { TENDER_NET_NOTE } from './tender-totals-report.js';
import { TENDER_REPORT_MAX_MOVEMENTS } from './tender-totals-report.sql.js';
import { SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';

/**
 * Task 3b.10 Checkpoint C — TENDER TOTALS over REAL Payment and Refund rows.
 *
 * Every Payment and every Refund is created through the frozen public flows (`complete-sale` for anonymous and
 * identified customers, the standalone invoice payment route, the customer receipt route, the verified provider
 * webhook, the advance conversion, order `cancel`, the advance refund route and the internal provider-refund
 * primitives) on the full `AppModule`, with the real role grants, real PostgreSQL and real Redis, and a scripted
 * clock — nothing is faked by writing a journal date. The expected figures come from a MODEL ORACLE: every Payment
 * and Refund is read back from its own table, its posting date from its own journal, and the expectation is
 * aggregated in plain TypeScript — independent of the report's single SQL statement.
 */
const DEFAULT_INSTANT = new Date('2026-06-10T10:00:00.000Z'); // 14:00 in Dubai
const at = (isoDate: string, hourUtc = 10): Date =>
  new Date(`${isoDate}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`);

describe('Tender Totals — task 3b.10 Checkpoint C (real documents, real PostgreSQL)', () => {
  let stack: TestStack;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let store: SessionStore;
  let pool: pg.Pool;
  let db: DbService;
  let prisma: PrismaClient;
  let engine: PostingEngineService;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let conversion: PaymentAdvanceConversionRepository;
  let repo: TenderTotalsReportRepository;
  let service: TenderTotalsReportService;

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
  let aed: Co; // the main company: two branches, the full receipt / refund matrix
  let aed2: Co; // the provider-refund world (pending / failed / succeeded attempts)
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
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Tender Report Co','AE',$3,$4,'ACTIVE',now())`,
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

  async function mkCustomer(co: Co): Promise<Cust> {
    const customerId = randomUUID();
    const ccaId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Customer',now())`,
      [customerId, co.tenantId],
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
  const ik = (): string => `t-key-${String(++keySeq).padStart(5, '0')}-${randomUUID().slice(0, 8)}`;
  const orderUrl = (o: { co: Co; branchId: string; orderId: string }, tail = ''): string =>
    `/v1/companies/${o.co.companyId}/branches/${o.branchId}/orders/${o.orderId}${tail}`;
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
  const manual = (n: bigint): Tender => ({ method: 'OTHER_MANUAL', amountMinor: n.toString() });
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
      o.co.tenantId === tenantId ? tok['owner']! : tok['foreignOwner']!,
      orderUrl(o, '/complete-sale'),
      {
        paymentIntent: payload.intent ?? 'PAY_NOW',
        ...(payload.tenders !== undefined ? { tenders: payload.tenders } : {}),
        ...(payload.advances !== undefined ? { advanceApplications: payload.advances } : {}),
      },
      { 'idempotency-key': ik(), 'if-match': String(o.version) },
    );
    expect(res.statusCode, res.payload).toBe(200);
    return { order: o, invoiceId: (res.json() as { invoice: { id: string } }).invoice.id };
  }

  async function cancel(o: MadeOrder, when: Date): Promise<void> {
    setClock(when);
    const v = (
      await q<{ version: number }>(`SELECT version FROM "order" WHERE id = $1`, [o.orderId])
    )[0]!.version;
    const res = await post(
      tok['owner']!,
      orderUrl(o, '/cancel'),
      { reason: 'tender fixture' },
      { 'if-match': String(v) },
    );
    expect(res.statusCode, res.payload).toBe(200);
  }

  /** the standalone customer receipt route (an unapplied / partly applied Payment) */
  async function receipt(
    co: Co,
    branchId: string,
    customerId: string,
    method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL',
    amount: bigint,
    when: Date,
  ): Promise<{ paymentId: string; allocatedAmountMinor: string; unallocatedAmountMinor: string }> {
    setClock(when);
    const res = await post(
      tok['owner']!,
      `/v1/companies/${co.companyId}/branches/${branchId}/customers/${customerId}/receipts`,
      { amountMinor: amount.toString(), method },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
    return res.json() as {
      paymentId: string;
      allocatedAmountMinor: string;
      unallocatedAmountMinor: string;
    };
  }

  /** the standalone invoice payment route */
  async function payInvoice(
    co: Co,
    branchId: string,
    invoiceId: string,
    tenders: Tender[],
    when: Date,
  ): Promise<void> {
    setClock(when);
    const total = tenders.reduce((n, t) => n + BigInt(t.amountMinor), 0n);
    const res = await post(
      tok['owner']!,
      `/v1/companies/${co.companyId}/branches/${branchId}/invoices/${invoiceId}/payments`,
      { amountMinor: total.toString(), tenders },
      { 'idempotency-key': ik() },
    );
    expect(res.statusCode, res.payload).toBe(201);
  }

  const advanceOfOrder = async (orderId: string): Promise<string> =>
    (
      await q<{ id: string }>(
        `SELECT ca.id FROM customer_advance ca
           JOIN credit_note_coverage_release r ON r."customerAdvanceId" = ca.id
          WHERE r."creditNoteId" = (SELECT cn.id FROM credit_note cn JOIN invoice i ON i.id = cn."invoiceId" WHERE i."orderId" = $1)`,
        [orderId],
      )
    )[0]!.id;

  /** the advance refund route — a LOCAL CASH / BANK_TRANSFER refund */
  async function refund(
    co: Co,
    branchId: string,
    advanceId: string,
    method: 'CASH' | 'BANK_TRANSFER',
    amount: bigint,
    when: Date,
  ): Promise<string> {
    const cust = (
      await q<{ customerId: string }>(
        `SELECT cca."customerId" FROM customer_advance ca JOIN customer_company_account cca ON cca.id = ca."customerCompanyAccountId" WHERE ca.id = $1`,
        [advanceId],
      )
    )[0]!;
    setClock(when);
    const res = await post(
      tok['owner']!,
      `/v1/companies/${co.companyId}/branches/${branchId}/customers/${cust.customerId}/advances/${advanceId}/refunds`,
      { requestedAmountMinor: amount.toString(), method, reasonCode: 'CUSTOMER_REQUEST' },
      { 'idempotency-key': ik() },
    );
    setClock(DEFAULT_INSTANT);
    expect(res.statusCode, res.payload).toBe(201);
    return (res.json() as { refundId: string }).refundId;
  }

  /** a PAID (never SETTLED) manual-card customer sale, cancelled → a CreditNote-funded CustomerAdvance */
  async function paidThenCancelledAdvance(
    co: Co,
    branchId: string,
    cust: Cust,
    price: bigint,
    rateBps: number | null,
    tender: Tender,
    saleAt: Date,
    cancelAt: Date,
  ): Promise<{ saleOrder: MadeOrder; invoiceId: string; advanceId: string }> {
    const s = await sell(
      await mkOrder(co, cust.customerId, one(price, rateBps), branchId),
      { tenders: [tender] },
      saleAt,
    );
    await cancel(s.order, cancelAt);
    return {
      saleOrder: s.order,
      invoiceId: s.invoiceId,
      advanceId: await advanceOfOrder(s.order.orderId),
    };
  }

  // ── the ONLINE_GATEWAY receipt: the verified provider webhook (the frozen successful recorded path) ──
  function fakeAdapter(event: VerifiedProviderWebhookEvent): PaymentProvider {
    const fail = async (): Promise<never> => {
      throw new Error('not implemented — never called here');
    };
    return {
      createIntent: fail,
      authorize: fail,
      capture: fail,
      refund: fail,
      getStatus: fail,
      verifyWebhook: async () => event,
    } as unknown as PaymentProvider;
  }
  async function onlineGatewayCapture(
    co: Co,
    branchId: string,
    invoiceId: string,
    amount: bigint,
    when: Date,
  ): Promise<string> {
    const providerKey = `tap-${randomUUID().slice(0, 8)}`;
    const credentialId = (
      await q<{ id: string }>(
        `INSERT INTO provider_credential
           (id,"tenantId","companyId","branchId",provider,mode,status,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,'TEST','ACTIVE','\\x00','\\x00','\\x00',now()) RETURNING id`,
        [co.tenantId, co.companyId, branchId, providerKey],
      )
    )[0]!.id;
    const endpointId = (
      await q<{ id: string }>(
        `INSERT INTO payment_webhook_endpoint (id,"tenantId","companyId","branchId","providerCredentialId")
         VALUES (uuidv7(),$1,$2,$3,$4) RETURNING id`,
        [co.tenantId, co.companyId, branchId, credentialId],
      )
    )[0]!.id;
    const reserved = await asTenant(
      (tx) =>
        app.get(PaymentAttemptReservationRepository).reserveAsyncAttemptInTx(tx, {
          tenantId: co.tenantId,
          companyId: co.companyId,
          branchId,
          invoiceId,
          method: 'ONLINE_GATEWAY',
          amountMinor: amount,
          providerKey,
          providerCredentialId: credentialId,
          createdByUserId: randomUUID(),
          actingUserId: null,
          idempotencyKey: ik(),
        }),
      co.tenantId,
    );
    app.get(PaymentProviderRegistry).register(
      providerKey,
      fakeAdapter({
        providerEventId: `evt-${randomUUID()}`,
        eventType: 'charge.captured',
        paymentAttemptId: reserved.paymentAttemptId,
        targetState: 'CAPTURED',
        providerReference: 'ref-tender-report',
      }),
    );
    setClock(when);
    await app.get(PaymentWebhookRepository).handle({
      endpointId,
      rawBody: Buffer.from('{}'),
      headers: {},
    });
    setClock(DEFAULT_INSTANT);
    const p = await q<{ id: string }>(`SELECT id FROM payment WHERE "sourceAttemptId" = $1`, [
      reserved.paymentAttemptId,
    ]);
    expect(p, 'the verified CAPTURED event recorded exactly one Payment').toHaveLength(1);
    return p[0]!.id;
  }

  // ── the model oracle: every Payment / Refund read back from ITS OWN table and journal ──────────
  interface ModelReceipt {
    id: string;
    branchId: string;
    method: string;
    amount: bigint;
    stream: 'CUSTOMER' | 'ANONYMOUS';
    postingDate: string;
  }
  interface ModelRefund {
    id: string;
    branchId: string;
    method: string;
    amount: bigint;
    postingDate: string;
  }
  async function loadModel(
    companyId: string,
  ): Promise<{ receipts: ModelReceipt[]; refunds: ModelRefund[] }> {
    const pays = await q<{ id: string; branchId: string; method: string; amount: string }>(
      `SELECT p.id, p."branchId", p.method, p."amountMinor"::text AS amount FROM payment p WHERE p."companyId" = $1`,
      [companyId],
    );
    const custJournal = new Map(
      (
        await q<{ id: string; pd: string }>(
          `SELECT je."sourceId" AS id, je."postingDate"::text AS pd FROM journal_entry je
            WHERE je."companyId" = $1 AND je."sourceKind" = 'customer_receipt_payment' AND je."sealedAt" IS NOT NULL`,
          [companyId],
        )
      ).map((r) => [r.id, r.pd]),
    );
    const anonJournal = new Map(
      (
        await q<{ id: string; pd: string }>(
          `SELECT pa."paymentId"::text AS id, je."postingDate"::text AS pd FROM payment_allocation pa
             JOIN journal_entry je ON je."companyId" = pa."companyId" AND je."sourceKind" = 'walk_in_sale'
                                  AND je."sourceId" = pa."invoiceId"::text AND je."sealedAt" IS NOT NULL
            WHERE pa."companyId" = $1`,
          [companyId],
        )
      ).map((r) => [r.id, r.pd]),
    );
    const receipts: ModelReceipt[] = [];
    for (const p of pays) {
      const common = { id: p.id, branchId: p.branchId, method: p.method, amount: BigInt(p.amount) };
      const c = custJournal.get(p.id);
      const a = anonJournal.get(p.id);
      if (c !== undefined) receipts.push({ ...common, stream: 'CUSTOMER', postingDate: c });
      else if (a !== undefined) receipts.push({ ...common, stream: 'ANONYMOUS', postingDate: a });
      // a Payment with NO journal at all is not provable by a journal-anchored period report (stated boundary)
    }
    const rfs = await q<{
      id: string;
      branchId: string;
      method: string;
      amount: string;
      pd: string | null;
    }>(
      `SELECT r.id, r."branchId", r.method, r."amountMinor"::text AS amount,
              (SELECT je."postingDate"::text FROM journal_entry je
                WHERE je."companyId" = r."companyId" AND je."sourceKind" = 'refund' AND je."sourceId" = r.id::text
                  AND je."sealedAt" IS NOT NULL) AS pd
         FROM refund r WHERE r."companyId" = $1`,
      [companyId],
    );
    const refunds: ModelRefund[] = rfs
      .filter((r) => r.pd !== null)
      .map((r) => ({
        id: r.id,
        branchId: r.branchId,
        method: r.method,
        amount: BigInt(r.amount),
        postingDate: r.pd!,
      }));
    return { receipts, refunds };
  }

  /** the figures a report MUST show, aggregated in plain TypeScript from the model */
  function expectedFigures(
    model: { receipts: ModelReceipt[]; refunds: ModelRefund[] },
    from: string,
    to: string,
    branchId: string | null,
  ) {
    const inScope = <T extends { branchId: string; postingDate: string }>(rows: T[]): T[] =>
      rows.filter(
        (d) =>
          d.postingDate >= from &&
          d.postingDate <= to &&
          (branchId === null || d.branchId === branchId),
      );
    const rc = inScope(model.receipts);
    const rf = inScope(model.refunds);
    const sumOf = (rows: { amount: bigint }[]): bigint => rows.reduce((n, d) => n + d.amount, 0n);
    return {
      receipts: {
        receiptCount: rc.length,
        receiptTotalMinor: sumOf(rc).toString(),
        byMethod: TENDER_METHODS.map((m) => {
          const rows = rc.filter((d) => d.method === m);
          return {
            method: m,
            receiptCount: rows.length,
            receiptTotalMinor: sumOf(rows).toString(),
          };
        }),
      },
      refunds: {
        refundCount: rf.length,
        refundTotalMinor: sumOf(rf).toString(),
        byMethod: TENDER_METHODS.map((m) => {
          const rows = rf.filter((d) => d.method === m);
          return { method: m, refundCount: rows.length, refundTotalMinor: sumOf(rows).toString() };
        }),
      },
      netTenderMovement: {
        note: TENDER_NET_NOTE,
        netMovementMinor: (sumOf(rc) - sumOf(rf)).toString(),
        byMethod: TENDER_METHODS.map((m) => ({
          method: m,
          netMovementMinor: (
            sumOf(rc.filter((d) => d.method === m)) - sumOf(rf.filter((d) => d.method === m))
          ).toString(),
        })),
      },
    };
  }
  const figuresOf = (r: { receipts: unknown; refunds: unknown; netTenderMovement: unknown }) => ({
    receipts: r.receipts,
    refunds: r.refunds,
    netTenderMovement: r.netTenderMovement,
  });

  /** the GL side of every control, read independently from the journal tables (plain SQL, not the report's) */
  async function glOracle(
    co: Co,
    from: string,
    to: string,
    branchId: string | null,
  ): Promise<Record<string, bigint>> {
    const sum = async (
      kinds: string[],
      accountKey: string,
      side: 'debitMinor' | 'creditMinor',
    ): Promise<bigint> => {
      const rows = await q<{ s: string }>(
        `SELECT COALESCE(SUM(jl."${side}"), 0)::text AS s
           FROM journal_entry je
           JOIN journal_line jl ON jl."journalEntryId" = je.id
           JOIN account a ON a.id = jl."accountId"
          WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL
            AND je."sourceKind" = ANY($2) AND a.key = $3
            AND je."postingDate" BETWEEN $4::date AND $5::date
            AND ($6::uuid IS NULL OR jl."branchId" = $6::uuid)`,
        [co.companyId, kinds, accountKey, from, to, branchId],
      );
      return BigInt(rows[0]!.s);
    };
    const RC = ['customer_receipt_payment', 'walk_in_sale'];
    return {
      rCash: await sum(RC, 'ASSET.CASH_ON_HAND', 'debitMinor'),
      rBank: await sum(RC, 'ASSET.BANK', 'debitMinor'),
      rClearing: await sum(RC, 'ASSET.PAYMENT_CLEARING', 'debitMinor'),
      rUnapplied: await sum(
        ['customer_receipt_payment'],
        'LIABILITY.UNAPPLIED_RECEIPTS',
        'creditMinor',
      ),
      fCash: await sum(['refund'], 'ASSET.CASH_ON_HAND', 'creditMinor'),
      fBank: await sum(['refund'], 'ASSET.BANK', 'creditMinor'),
      fClearing: await sum(['refund'], 'ASSET.PAYMENT_CLEARING', 'creditMinor'),
      fAdvances: await sum(['refund'], 'LIABILITY.CUSTOMER_ADVANCES', 'debitMinor'),
    };
  }

  // ── the report under test, through the real scoped path ─────────────────────────
  const inTenant = <T>(fn: () => Promise<T>, t = tenantId): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId: t }), fn);
  const companyReport = (co: Co, from: string, to: string): Promise<TenderTotalsCompanyReport> =>
    inTenant(() => service.companyReport({ companyId: co.companyId, from, to }), co.tenantId);
  const branchReport = (
    co: Co,
    branchId: string,
    from: string,
    to: string,
  ): Promise<TenderTotalsBranchReport> =>
    inTenant(
      () => service.branchReport({ companyId: co.companyId, branchId, from, to }),
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
  async function expectIntegrity(p: Promise<unknown>, check: string): Promise<void> {
    const err = await reject(p);
    expect(err).toMatchObject({ code: 'REPORT_TENDER_SOURCE_INTEGRITY', status: 500 });
    expect(err.message).toContain(check);
    expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // non-disclosing: a check name, never an identifier
  }

  // ── the shared document world ───────────────────────────────────────────────────────────────
  const W: Record<string, string> = {}; // named ids (invoice / payment / refund / advance)
  const O: Record<string, MadeOrder> = {};
  let cust3Advance = '';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url, max: 6 });

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `trep-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [id, `trep-${id.slice(0, 8)}`, planVersionId],
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
    engine = app.get(PostingEngineService);
    accounts = app.get(AccountRepository);
    periods = app.get(AccountingPeriodRepository);
    conversion = app.get(PaymentAdvanceConversionRepository);
    repo = new TenderTotalsReportRepository(db);
    service = new TenderTotalsReportService(repo);

    aed = await makeCompany(tenantId, { currency: 'AED' });
    aed2 = await makeCompany(tenantId, { currency: 'AED' });
    kwd = await makeCompany(tenantId, { currency: 'KWD', tz: 'Asia/Kuwait' });
    foreign = await makeCompany(otherTenantId, { currency: 'AED' });

    tok['owner'] = await mint('owner', rolePerms('owner'), { stepUp: true });
    tok['foreignOwner'] = await mint('foreign-owner', rolePerms('owner'), {
      tenant: otherTenantId,
      stepUp: true,
    });

    // ───────────────────── THE WORLD: Payments and Refunds through the frozen flows ─────────────────────
    const A = aed.branchId;
    const B = aed.siblingBranchId;
    const c1 = await mkCustomer(aed);
    const c2 = await mkCustomer(aed);
    const c3 = await mkCustomer(aed);
    const c4 = await mkCustomer(aed);
    const c5 = await mkCustomer(aed);
    const c6 = await mkCustomer(aed);

    // 06-10 · A · anonymous CASH
    O['anonCash'] = (
      await sell(
        await mkOrder(aed, null, one(9_000n)),
        { tenders: [cash(9_450n)] },
        at('2026-06-10'),
      )
    ).order;
    W['anonCashInvoice'] = (
      await q<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [
        O['anonCash']!.orderId,
      ])
    )[0]!.id;
    // 06-10 · A · anonymous Multi Payment — ONE sale, THREE Payment rows (CASH + BANK_TRANSFER + OTHER_MANUAL)
    O['anonMulti3'] = (
      await sell(
        await mkOrder(aed, null, one(20_000n)),
        { tenders: [cash(8_000n), bank(7_000n), manual(6_000n)] }, // 21 000
        at('2026-06-10'),
      )
    ).order;
    W['anonMulti3Invoice'] = (
      await q<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [
        O['anonMulti3']!.orderId,
      ])
    )[0]!.id;
    // 06-11 · A · anonymous, two tenders that share ONE GL account (manual CARD_TERMINAL + OTHER_MANUAL → PAYMENT_CLEARING)
    O['anonClearing'] = (
      await sell(
        await mkOrder(aed, null, one(10_000n)),
        { tenders: [card(6_000n), manual(4_500n)] }, // 10 500
        at('2026-06-11'),
      )
    ).order;
    W['anonClearingInvoice'] = (
      await q<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [
        O['anonClearing']!.orderId,
      ])
    )[0]!.id;
    // 06-11 · B · anonymous BANK_TRANSFER
    O['anonBankB'] = (
      await sell(
        await mkOrder(aed, null, one(5_000n), B),
        { tenders: [bank(5_250n)] },
        at('2026-06-11'),
      )
    ).order;
    // 06-12 · A · identified customer Multi Payment CASH + BANK_TRANSFER
    O['custMulti'] = (
      await sell(
        await mkOrder(aed, c1.customerId, one(10_000n)),
        { tenders: [cash(4_000n), bank(6_500n)] },
        at('2026-06-12'),
      )
    ).order;
    W['custMultiInvoice'] = (
      await q<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [
        O['custMulti']!.orderId,
      ])
    )[0]!.id;
    // 06-12 · A · identified customer, manual CARD_TERMINAL (PAID — never SETTLED)
    O['custCard'] = (
      await sell(
        await mkOrder(aed, c1.customerId, one(3_000n)),
        { tenders: [card(3_150n)] },
        at('2026-06-12'),
      )
    ).order;
    // 06-13 · B · identified customer ON_CREDIT with a PARTIAL cash tender, and a credit sale with NO tender
    O['custPartialB'] = (
      await sell(
        await mkOrder(aed, c2.customerId, one(8_000n), B),
        { intent: 'ON_CREDIT', tenders: [cash(3_000n)] },
        at('2026-06-13'),
      )
    ).order;
    O['custCreditB'] = (
      await sell(
        await mkOrder(aed, c2.customerId, one(5_000n), B),
        { intent: 'ON_CREDIT' },
        at('2026-06-13'),
      )
    ).order;
    // 06-14 · A · an UNAPPLIED customer receipt (the customer owes nothing): 5 000 CASH, 0 allocated
    const unapplied = await receipt(aed, A, c3.customerId, 'CASH', 5_000n, at('2026-06-14'));
    W['unappliedPayment'] = unapplied.paymentId;
    expect(unapplied.allocatedAmountMinor).toBe('0');
    // 06-15 · the unapplied receipt is converted to a CustomerAdvance (a reclass — never a second receipt)
    setClock(at('2026-06-15'));
    await asTenant((tx) =>
      conversion.convertInTx(tx, {
        tenantId,
        companyId: aed.companyId,
        branchId: A,
        customerId: c3.customerId,
        paymentId: unapplied.paymentId,
        amountMinor: 2_000n,
        actorUserId: null,
      }),
    );
    setClock(DEFAULT_INSTANT);
    cust3Advance = (
      await q<{ id: string }>(
        `SELECT ca.id FROM customer_advance ca WHERE ca."customerCompanyAccountId" = $1`,
        [c3.ccaId],
      )
    )[0]!.id;
    // 06-16 · A · c4 ON_CREDIT (UNPAID, 4 200); 06-17 · c4 pays 6 000 CASH: 4 200 allocated + 1 800 unapplied — ONE Payment
    O['c4Credit'] = (
      await sell(
        await mkOrder(aed, c4.customerId, one(4_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-16'),
      )
    ).order;
    const partlyApplied = await receipt(aed, A, c4.customerId, 'CASH', 6_000n, at('2026-06-17'));
    W['partlyAppliedPayment'] = partlyApplied.paymentId;
    expect(partlyApplied.allocatedAmountMinor).toBe('4200');
    expect(partlyApplied.unallocatedAmountMinor).toBe('1800');
    // 06-18 · A · c1 ON_CREDIT (6 300) · paid in JULY (07-10) — the receipt posts in July
    const late = await sell(
      await mkOrder(aed, c1.customerId, one(6_000n)),
      { intent: 'ON_CREDIT' },
      at('2026-06-18'),
    );
    O['custLate'] = late.order;
    await payInvoice(aed, A, late.invoiceId, [cash(6_300n)], at('2026-07-10'));
    W['lateInvoice'] = late.invoiceId;
    setClock(DEFAULT_INSTANT);
    // 06-20 · A · c1 ON_CREDIT (2 100) paid by ONLINE_GATEWAY through the verified provider webhook
    const og = await sell(
      await mkOrder(aed, c1.customerId, one(2_000n)),
      { intent: 'ON_CREDIT' },
      at('2026-06-20'),
    );
    W['onlineGatewayPayment'] = await onlineGatewayCapture(
      aed,
      A,
      og.invoiceId,
      2_100n,
      at('2026-06-20'),
    );
    // 06-14 23:59:59 local-ish (19:59:59Z) · A · c2 standalone BANK receipt whose JOURNAL crosses midnight (06-15)
    {
      setClock(new Date('2026-06-14T19:59:59.000Z'));
      const realPost = engine.postJournal.bind(engine);
      const spy = vi.spyOn(engine, 'postJournal').mockImplementation(async (tx, input) => {
        if (input.sourceKind === 'customer_receipt_payment')
          setClock(new Date('2026-06-14T20:00:01.000Z'));
        return realPost(tx, input);
      });
      try {
        const r = await receipt(
          aed,
          A,
          c2.customerId,
          'BANK_TRANSFER',
          1_000n,
          new Date('2026-06-14T19:59:59.000Z'),
        );
        W['straddleReceipt'] = r.paymentId;
      } finally {
        spy.mockRestore();
      }
      setClock(DEFAULT_INSTANT);
    }
    // 06-14 23:59:59 · A · anonymous sale whose invoiceDate is 06-14 and whose JOURNAL is posted after midnight
    {
      const o = await mkOrder(aed, null, one(4_000n));
      setClock(new Date('2026-06-14T19:59:59.000Z'));
      const realPost = engine.postJournal.bind(engine);
      const spy = vi.spyOn(engine, 'postJournal').mockImplementation(async (tx, input) => {
        if (input.sourceKind === 'walk_in_sale') setClock(new Date('2026-06-14T20:00:01.000Z'));
        return realPost(tx, input);
      });
      try {
        O['anonStraddle'] = (
          await sell(o, { tenders: [cash(4_200n)] }, new Date('2026-06-14T19:59:59.000Z'))
        ).order;
      } finally {
        spy.mockRestore();
      }
      setClock(DEFAULT_INSTANT);
      W['anonStraddleInvoice'] = (
        await q<{ id: string }>(`SELECT id FROM invoice WHERE "orderId" = $1`, [o.orderId])
      )[0]!.id;
    }
    // 06-26 · A · c3 spends 2 000 of its ADVANCE on a sale and pays the remaining 1 150 CASH — the advance is NOT a receipt
    O['advanceSale'] = (
      await sell(
        await mkOrder(aed, c3.customerId, one(3_000n)), // 3 150
        { tenders: [cash(1_150n)], advances: [{ advanceId: cust3Advance, amountMinor: '2000' }] },
        at('2026-06-26'),
      )
    ).order;

    // 06-22 · A · c5 PAID by OTHER_MANUAL 10 500 → cancelled 06-23 → CreditNote-funded advance 10 500
    const c5Adv = await paidThenCancelledAdvance(
      aed,
      A,
      c5,
      10_000n,
      500,
      manual(10_500n),
      at('2026-06-22'),
      at('2026-06-23'),
    );
    W['c5Advance'] = c5Adv.advanceId;
    W['c5Order'] = c5Adv.saleOrder.orderId;
    // refunds of that advance: CASH 4 000 (06-28), BANK_TRANSFER 3 000 (06-29), CASH 3 500 (07-12, a month after the sale)
    W['refundCash1'] = await refund(aed, A, c5Adv.advanceId, 'CASH', 4_000n, at('2026-06-28'));
    W['refundBank1'] = await refund(
      aed,
      A,
      c5Adv.advanceId,
      'BANK_TRANSFER',
      3_000n,
      at('2026-06-29'),
    );
    W['refundCash2'] = await refund(aed, A, c5Adv.advanceId, 'CASH', 3_500n, at('2026-07-12'));
    // 06-24 · B · c6 PAID by manual CARD_TERMINAL 4 200 → cancelled 06-25 → advance; refunds CASH 1 000 + BANK 2 000 on 06-30
    const c6Adv = await paidThenCancelledAdvance(
      aed,
      B,
      c6,
      4_000n,
      500,
      card(4_200n),
      at('2026-06-24'),
      at('2026-06-25'),
    );
    W['c6Advance'] = c6Adv.advanceId;
    W['refundCashB'] = await refund(aed, B, c6Adv.advanceId, 'CASH', 1_000n, at('2026-06-30'));
    W['refundBankB'] = await refund(
      aed,
      B,
      c6Adv.advanceId,
      'BANK_TRANSFER',
      2_000n,
      at('2026-06-30'),
    );

    // ───────── aed2 · the provider-refund world: pending / failed / succeeded RefundAttempts ─────────
    {
      const c7 = await mkCustomer(aed2);
      const s = await sell(
        await mkOrder(aed2, c7.customerId, one(2_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      const providerCred = randomUUID();
      await pool.query(
        `INSERT INTO provider_credential
           (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
         VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
        [providerCred, tenantId, aed2.companyId, aed2.branchId],
      );
      // a RAW-SEEDED provider-backed Payment (no real adapter exists) paying the invoice, then a FINALIZED settlement
      const attemptId = (
        await q<{ id: string }>(
          `INSERT INTO payment_attempt
             (id,"tenantId","companyId","branchId","orderId","targetInvoiceId",method,"providerKey",
              "providerCredentialId","amountMinor","currencyCode","currencyExponent",state,
              "orderCommercialSnapshotFingerprintAtCreation","orderVersionAtCreation","idempotencyKey","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,'ONLINE_GATEWAY','tap',$6,2100,'AED',2,'CAPTURED','fp-seed',1,$7,now())
           RETURNING id`,
          [
            tenantId,
            aed2.companyId,
            aed2.branchId,
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
          [tenantId, aed2.companyId, aed2.branchId, attemptId],
        )
      )[0]!.id;
      W['rawProviderPayment'] = paymentId;
      await pool.query(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,2100,'AED',2)`,
        [tenantId, aed2.companyId, aed2.branchId, paymentId, s.invoiceId],
      );
      await pool.query(`UPDATE invoice SET "invoicePaymentStatus" = 'PAID' WHERE id = $1`, [
        s.invoiceId,
      ]);
      const client = new pg.Client({ connectionString: stack.postgres.url });
      await client.connect();
      try {
        await client.query('BEGIN');
        const accountId = async (key: string): Promise<string> =>
          (
            await client.query(`SELECT id FROM account WHERE "companyId"=$1 AND key=$2`, [
              aed2.companyId,
              key,
            ])
          ).rows[0].id;
        const period = (
          await client.query(`SELECT id FROM accounting_period WHERE "companyId"=$1 LIMIT 1`, [
            aed2.companyId,
          ])
        ).rows[0].id;
        const batchId = randomUUID();
        const je = randomUUID();
        await client.query(
          `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
           VALUES ($1,$2,$3,$4,'2026-06-01','SETTLEMENT_BATCH',$5,'AED',$6)`,
          [je, tenantId, aed2.companyId, period, batchId, `fp-${je}`],
        );
        await client.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,2100,0)`,
          [tenantId, aed2.companyId, je, await accountId('ASSET.BANK'), aed2.branchId],
        );
        await client.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,0,2100)`,
          [tenantId, aed2.companyId, je, await accountId('ASSET.PAYMENT_CLEARING'), aed2.branchId],
        );
        await client.query(`UPDATE journal_entry SET "sealedAt"=now() WHERE id=$1`, [je]);
        const lineId = randomUUID();
        await client.query(
          `INSERT INTO settlement_batch
             (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
              "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',2100,0,2100,'AED',2)`,
          [
            batchId,
            tenantId,
            aed2.companyId,
            aed2.branchId,
            providerCred,
            `ext-${batchId.slice(0, 8)}`,
          ],
        );
        await client.query(
          `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
           VALUES ($1,$2,$3,$4,$5,2100,'AED',2,$6)`,
          [lineId, tenantId, aed2.companyId, aed2.branchId, batchId, paymentId],
        );
        await client.query(
          `INSERT INTO settlement_application (id,"tenantId","companyId","branchId","batchId","lineId","paymentId","amountMinor","currencyCode","currencyExponent")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,2100,'AED',2)`,
          [tenantId, aed2.companyId, aed2.branchId, batchId, lineId, paymentId],
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
      const advanceId = await advanceOfOrder(s.order.orderId);
      W['aed2Advance'] = advanceId;
      const reserve = (amount: bigint, key: string) =>
        asTenant((tx) =>
          app.get(RefundAttemptReservationRepository).reserveProviderRefundAttemptInTx(tx, {
            tenantId,
            companyId: aed2.companyId,
            branchId: aed2.branchId,
            customerId: c7.customerId,
            customerAdvanceId: advanceId,
            requestedAmountMinor: amount,
            idempotencyKey: key,
          }),
        );
      const apply = (
        attemptId: string,
        resultState: 'SUCCEEDED' | 'FAILED',
        method: 'CARD_TERMINAL' | 'ONLINE_GATEWAY',
        accountingDate: string,
      ) =>
        asTenant((tx) =>
          app.get(RefundAttemptReservationRepository).applyProviderRefundAttemptResultInTx(tx, {
            tenantId,
            companyId: aed2.companyId,
            branchId: aed2.branchId,
            refundAttemptId: attemptId,
            resultState,
            providerReference: 'prov-ref',
            method,
            reasonCode: 'CUSTOMER_REQUEST',
            accountingDate,
            actorUserId: null,
            ...(resultState === 'FAILED' ? { failureCode: 'DECLINED' } : {}),
          }),
        );
      setClock(at('2026-06-13'));
      const pending = await reserve(500n, ik()); // stays PENDING — reserves entitlement, creates NO Refund, NO journal
      W['pendingAttempt'] = pending.refundAttemptId;
      const failed = await reserve(700n, ik());
      await apply(failed.refundAttemptId, 'FAILED', 'ONLINE_GATEWAY', '2026-06-14');
      W['failedAttempt'] = failed.refundAttemptId;
      const ok1 = await reserve(800n, ik());
      await apply(ok1.refundAttemptId, 'SUCCEEDED', 'ONLINE_GATEWAY', '2026-06-15');
      const ok2 = await reserve(300n, ik());
      await apply(ok2.refundAttemptId, 'SUCCEEDED', 'CARD_TERMINAL', '2026-06-16');
      setClock(DEFAULT_INSTANT);
      void c7;
    }

    // ───────── kwd · 3-decimal minor units ─────────
    {
      const k1 = await mkCustomer(kwd);
      const k2 = await mkCustomer(kwd);
      // 06-10 anonymous Multi Payment (no tax): 12.345 KWD = CASH 5.000 + BANK_TRANSFER 7.345
      await sell(
        await mkOrder(kwd, null, one(12_345n, null)),
        { tenders: [cash(5_000n), bank(7_345n)] },
        at('2026-06-10'),
      );
      // 06-11 customer standalone BANK_TRANSFER receipt 7.500 KWD (unapplied)
      await receipt(kwd, kwd.branchId, k1.customerId, 'BANK_TRANSFER', 7_500n, at('2026-06-11'));
      // 06-12 PAID manual-card customer sale 6.000 → cancelled 06-13 → advance → CASH refund 2.500 on 06-14
      const adv = await paidThenCancelledAdvance(
        kwd,
        kwd.branchId,
        k2,
        6_000n,
        null,
        card(6_000n),
        at('2026-06-12'),
        at('2026-06-13'),
      );
      await refund(kwd, kwd.branchId, adv.advanceId, 'CASH', 2_500n, at('2026-06-14'));
    }
    // another company of the same tenant (aed2 has its own movements) and a foreign tenant each have their own
    await sell(
      await mkOrder(foreign, null, one(1_234n)),
      { tenders: [cash(1_296n)] },
      at('2026-06-10'),
    );
    setClock(DEFAULT_INSTANT);
  }, 900_000);

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

  const FULL = ['2026-06-01', '2026-07-31'] as const;
  const byMethod = <T extends { method: string }>(rows: readonly T[]): Record<string, T> =>
    Object.fromEntries(rows.map((r) => [r.method, r]));

  // ═══════════════════ the frozen contracts: the cardinalities the report relies on ═══════════════════
  describe('the frozen persistence and journal contracts (discovery, pinned against real flows)', () => {
    const journalsOf = (kind: string, sourceId: string) =>
      q<{ id: string; pd: string }>(
        `SELECT id, "postingDate"::text AS pd FROM journal_entry WHERE "sourceKind" = $1 AND "sourceId" = $2 AND "sealedAt" IS NOT NULL`,
        [kind, sourceId],
      );
    const linesOf = (entryId: string) =>
      q<{ accountKey: string; debit: string; credit: string }>(
        `SELECT a.key AS "accountKey", jl."debitMinor"::text AS debit, jl."creditMinor"::text AS credit
           FROM journal_line jl JOIN account a ON a.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY a.key`,
        [entryId],
      );

    it('an anonymous Multi Payment is ONE sale: three Payment rows (one paymentGroupId), ONE walk_in_sale journal, no per-Payment journal', async () => {
      const pays = await q<{ id: string; method: string; amount: string; g: string | null }>(
        `SELECT p.id, p.method, p."amountMinor"::text AS amount, p."paymentGroupId" AS g
           FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1 ORDER BY p.method`,
        [W['anonMulti3Invoice']],
      );
      expect(pays.map((p) => [p.method, p.amount])).toEqual([
        ['BANK_TRANSFER', '7000'],
        ['CASH', '8000'],
        ['OTHER_MANUAL', '6000'],
      ]);
      expect(new Set(pays.map((p) => p.g)).size).toBe(1);
      expect(pays[0]!.g).not.toBeNull();
      const journal = await journalsOf('walk_in_sale', W['anonMulti3Invoice']!);
      expect(journal).toHaveLength(1);
      const lines = await linesOf(journal[0]!.id);
      expect(lines.filter((l) => BigInt(l.debit) > 0n).map((l) => [l.accountKey, l.debit])).toEqual(
        [
          ['ASSET.BANK', '7000'],
          ['ASSET.CASH_ON_HAND', '8000'],
          ['ASSET.PAYMENT_CLEARING', '6000'],
        ],
      );
      for (const p of pays) {
        expect(await journalsOf('customer_receipt_payment', p.id)).toHaveLength(0);
      }
    });

    it('same-account anonymous tenders are AGGREGATED into one debit line of the one journal (not duplicated per Payment)', async () => {
      const journal = await journalsOf('walk_in_sale', W['anonClearingInvoice']!);
      expect(journal).toHaveLength(1);
      const debits = (await linesOf(journal[0]!.id)).filter((l) => BigInt(l.debit) > 0n);
      expect(debits).toEqual([
        { accountKey: 'ASSET.PAYMENT_CLEARING', debit: '10500', credit: '0' },
      ]);
      const pays = await q(`SELECT 1 FROM payment_allocation WHERE "invoiceId" = $1`, [
        W['anonClearingInvoice'],
      ]);
      expect(pays).toHaveLength(2);
    });

    it('every customer Payment has exactly ONE customer_receipt_payment journal: Dr <tender account> / Cr LIABILITY.UNAPPLIED_RECEIPTS', async () => {
      const customerPays = await q<{ id: string; method: string; amount: string }>(
        `SELECT p.id, p.method, p."amountMinor"::text AS amount FROM payment p
          WHERE p."companyId" = $1 AND EXISTS (SELECT 1 FROM journal_entry je WHERE je."sourceKind" = 'customer_receipt_payment' AND je."sourceId" = p.id::text)`,
        [aed.companyId],
      );
      expect(customerPays.length).toBeGreaterThanOrEqual(10);
      const expectedAccount: Record<string, string> = {
        CASH: 'ASSET.CASH_ON_HAND',
        BANK_TRANSFER: 'ASSET.BANK',
        CARD_TERMINAL: 'ASSET.PAYMENT_CLEARING',
        ONLINE_GATEWAY: 'ASSET.PAYMENT_CLEARING',
        OTHER_MANUAL: 'ASSET.PAYMENT_CLEARING',
      };
      for (const p of customerPays) {
        const js = await journalsOf('customer_receipt_payment', p.id);
        expect(js).toHaveLength(1);
        expect(await linesOf(js[0]!.id)).toEqual(
          [
            { accountKey: expectedAccount[p.method]!, debit: p.amount, credit: '0' },
            { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', debit: '0', credit: p.amount },
          ].sort((a, b) => (a.accountKey < b.accountKey ? -1 : 1)),
        );
      }
    });

    it('a Payment allocated to several places is still ONE Payment row and ONE receipt journal (the allocation is not a receipt)', async () => {
      const id = W['partlyAppliedPayment']!;
      expect(await q(`SELECT 1 FROM payment WHERE id = $1`, [id])).toHaveLength(1);
      expect(await journalsOf('customer_receipt_payment', id)).toHaveLength(1);
      const alloc = await q<{ amount: string; aid: string }>(
        `SELECT "amountMinor"::text AS amount, id::text AS aid FROM payment_allocation WHERE "paymentId" = $1`,
        [id],
      );
      expect(alloc.map((a) => a.amount)).toEqual(['4200']); // 4 200 applied, 1 800 unapplied — the Payment is 6 000
      expect(await journalsOf('payment_allocation', alloc[0]!.aid)).toHaveLength(1);
    });

    it('every Refund has exactly ONE refund journal: Dr LIABILITY.CUSTOMER_ADVANCES / Cr cash, bank (local) or clearing (provider)', async () => {
      const refunds = await q<{
        id: string;
        method: string;
        amount: string;
        provider: boolean;
        branchId: string;
      }>(
        `SELECT r.id, r.method, r."amountMinor"::text AS amount, (r."sourceRefundAttemptId" IS NOT NULL) AS provider, r."branchId"
           FROM refund r WHERE r."companyId" = ANY($1)`,
        [[aed.companyId, aed2.companyId]],
      );
      expect(refunds.length).toBe(5 + 2);
      for (const r of refunds) {
        const js = await journalsOf('refund', r.id);
        expect(js).toHaveLength(1);
        const credit = r.provider
          ? 'ASSET.PAYMENT_CLEARING'
          : r.method === 'CASH'
            ? 'ASSET.CASH_ON_HAND'
            : 'ASSET.BANK';
        expect(await linesOf(js[0]!.id)).toEqual(
          [
            { accountKey: 'LIABILITY.CUSTOMER_ADVANCES', debit: r.amount, credit: '0' },
            { accountKey: credit, debit: '0', credit: r.amount },
          ].sort((a, b) => (a.accountKey < b.accountKey ? -1 : 1)),
        );
      }
    });

    it('a PENDING and a FAILED RefundAttempt create NO Refund and NO journal; only the SUCCEEDED attempts do', async () => {
      const attempts = await q<{ id: string; state: string }>(
        `SELECT id, state FROM refund_attempt WHERE "companyId" = $1 ORDER BY state, id`,
        [aed2.companyId],
      );
      expect(attempts.map((a) => a.state).sort()).toEqual([
        'FAILED',
        'PENDING',
        'SUCCEEDED',
        'SUCCEEDED',
      ]);
      for (const a of attempts.filter((x) => x.state !== 'SUCCEEDED')) {
        expect(
          await q(`SELECT 1 FROM refund WHERE "sourceRefundAttemptId" = $1`, [a.id]),
        ).toHaveLength(0);
        expect(await journalsOf('refund', a.id)).toHaveLength(0);
      }
      expect(await q(`SELECT 1 FROM refund WHERE "companyId" = $1`, [aed2.companyId])).toHaveLength(
        2,
      );
    });

    it('a CreditNote posts a credit_note journal and creates NO Refund — account credit is not a refund', async () => {
      const cn = await q<{ id: string }>(
        `SELECT cn.id FROM credit_note cn JOIN invoice i ON i.id = cn."invoiceId" WHERE i."orderId" = $1`,
        [W['c5Order']],
      );
      expect(cn).toHaveLength(1);
      expect(await journalsOf('credit_note', cn[0]!.id)).toHaveLength(1);
      expect(await journalsOf('refund', cn[0]!.id)).toHaveLength(0);
    });

    it('the credit-sale, the advance application and the unapplied → advance conversion create NO Payment', async () => {
      // a credit sale (custCreditB, c4Credit) has no Payment
      for (const key of ['custCreditB', 'c4Credit']) {
        const rows = await q(
          `SELECT 1 FROM payment_allocation pa JOIN invoice i ON i.id = pa."invoiceId" WHERE i."orderId" = $1`,
          [O[key]!.orderId],
        );
        expect(rows, key).toHaveLength(key === 'c4Credit' ? 1 : 0); // c4Credit is later paid by the 6 000 receipt (one allocation)
      }
      // the advance sale: ONE Payment (the 1 150 CASH) — the 2 000 advance application is not a Payment
      const advSale = await q<{ amount: string }>(
        `SELECT p."amountMinor"::text AS amount FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id
           JOIN invoice i ON i.id = pa."invoiceId" WHERE i."orderId" = $1`,
        [O['advanceSale']!.orderId],
      );
      expect(advSale).toEqual([{ amount: '1150' }]);
      // the conversion left the SAME Payment row, still ONE receipt journal, and added a customer_advance journal (a reclass)
      expect(await journalsOf('customer_receipt_payment', W['unappliedPayment']!)).toHaveLength(1);
      expect(
        await q(`SELECT 1 FROM payment WHERE "companyId" = $1 AND id = $2`, [
          aed.companyId,
          W['unappliedPayment'],
        ]),
      ).toHaveLength(1);
    });
  });

  // ═══════════════════ the receipt figures, hand-anchored ═══════════════════
  describe('receipts', () => {
    it('anonymous CASH + the anonymous Multi Payment (06-10, branch A): four Payment rows, each counted once, one zero-filled row per method', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-10', '2026-06-10');
      expect(r.receipts.receiptCount).toBe(4);
      expect(r.receipts.receiptTotalMinor).toBe('30450'); // 9 450 + 8 000 + 7 000 + 6 000
      expect(r.receipts.byMethod).toEqual([
        { method: 'CASH', receiptCount: 2, receiptTotalMinor: '17450' },
        { method: 'CARD_TERMINAL', receiptCount: 0, receiptTotalMinor: '0' },
        { method: 'BANK_TRANSFER', receiptCount: 1, receiptTotalMinor: '7000' },
        { method: 'ONLINE_GATEWAY', receiptCount: 0, receiptTotalMinor: '0' },
        { method: 'OTHER_MANUAL', receiptCount: 1, receiptTotalMinor: '6000' },
      ]);
      expect(r.refunds.refundCount).toBe(0);
    });

    it('two anonymous tenders sharing ONE GL account (06-11, branch A) stay two method rows and make ONE clearing control', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-11', '2026-06-11');
      const by = byMethod(r.receipts.byMethod);
      expect(by['CARD_TERMINAL']).toMatchObject({ receiptCount: 1, receiptTotalMinor: '6000' });
      expect(by['OTHER_MANUAL']).toMatchObject({ receiptCount: 1, receiptTotalMinor: '4500' });
      expect(r.reconciliation.receipts.paymentClearing).toEqual({
        sourceMinor: '10500',
        glMinor: '10500',
        differenceMinor: '0',
        reconciled: true,
      });
    });

    it('an identified customer Multi Payment and a manual card payment (06-12, branch A): every Payment row is a receipt', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-12', '2026-06-12');
      const by = byMethod(r.receipts.byMethod);
      expect(by['CASH']).toMatchObject({ receiptCount: 1, receiptTotalMinor: '4000' });
      expect(by['BANK_TRANSFER']).toMatchObject({ receiptCount: 1, receiptTotalMinor: '6500' });
      expect(by['CARD_TERMINAL']).toMatchObject({ receiptCount: 1, receiptTotalMinor: '3150' });
      expect(r.receipts.receiptCount).toBe(3);
    });

    it('a PARTIAL payment is a receipt of exactly what was paid; a credit sale with no tender adds nothing (06-13, branch B)', async () => {
      const r = await branchReport(aed, aed.siblingBranchId, '2026-06-13', '2026-06-13');
      expect(r.receipts.receiptCount).toBe(1);
      expect(byMethod(r.receipts.byMethod)['CASH']).toMatchObject({
        receiptCount: 1,
        receiptTotalMinor: '3000',
      });
      // two invoices were issued that day on credit terms — one partly paid, one not at all
      const inv = await q<{ s: string }>(
        `SELECT i."invoicePaymentStatus" AS s FROM invoice i WHERE i."orderId" = ANY($1) ORDER BY s`,
        [[O['custPartialB']!.orderId, O['custCreditB']!.orderId]],
      );
      expect(inv.map((x) => x.s)).toEqual(['PARTIAL', 'UNPAID']);
    });

    it('an UNAPPLIED receipt is a receipt, counted once — and converting it to a CustomerAdvance is NOT a second receipt', async () => {
      const day = await branchReport(aed, aed.branchId, '2026-06-14', '2026-06-14');
      // 06-14: the unapplied 5 000 CASH receipt + the anonymous 4 200 CASH sale (journal dated by its invoice)
      expect(byMethod(day.receipts.byMethod)['CASH']).toMatchObject({
        receiptCount: 2,
        receiptTotalMinor: '9200',
      });
      const conv = await branchReport(aed, aed.branchId, '2026-06-15', '2026-06-15');
      // 06-15 holds the customer_advance reclass journal and the straddling BANK receipt — only the latter is a receipt
      expect(conv.receipts.receiptCount).toBe(1);
      expect(byMethod(conv.receipts.byMethod)['BANK_TRANSFER']).toMatchObject({
        receiptCount: 1,
        receiptTotalMinor: '1000',
      });
      const reclass = await q(
        `SELECT 1 FROM journal_entry WHERE "companyId" = $1 AND "sourceKind" = 'customer_advance' AND "postingDate" = '2026-06-15'`,
        [aed.companyId],
      );
      expect(reclass.length).toBeGreaterThan(0);
      // the whole window: the unapplied Payment is still exactly ONE receipt of 5 000
      const all = await companyReport(aed, ...FULL);
      const oracle = await loadModel(aed.companyId);
      expect(oracle.receipts.filter((x) => x.id === W['unappliedPayment'])).toHaveLength(1);
      expect(byMethod(all.receipts.byMethod)['CASH']!.receiptTotalMinor).toBe(
        expectedFigures(oracle, ...FULL, null).receipts.byMethod.find((m) => m.method === 'CASH')!
          .receiptTotalMinor,
      );
    });

    it('a Payment that is partly allocated is counted ONCE at its full amount — the allocation never duplicates or replaces it (06-17)', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-17', '2026-06-17');
      expect(r.receipts.receiptCount).toBe(1);
      expect(byMethod(r.receipts.byMethod)['CASH']).toMatchObject({
        receiptCount: 1,
        receiptTotalMinor: '6000',
      }); // not 4 200, not 10 200
      // the allocation journal (06-17) is posted too, and is NOT a receipt
      expect(
        (
          await q(
            `SELECT 1 FROM journal_entry WHERE "companyId" = $1 AND "sourceKind" = 'payment_allocation' AND "postingDate" = '2026-06-17'`,
            [aed.companyId],
          )
        ).length,
      ).toBe(1);
    });

    it('a sale paid partly by a CustomerAdvance counts only the real tender (06-26): the advance is not a Payment', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-26', '2026-06-26');
      expect(r.receipts.receiptCount).toBe(1);
      expect(r.receipts.receiptTotalMinor).toBe('1150');
      expect(
        (
          await q<{ t: string }>(
            `SELECT "totalAmountMinor"::text AS t FROM invoice WHERE "orderId" = $1`,
            [O['advanceSale']!.orderId],
          )
        )[0]!.t,
      ).toBe('3150'); // the invoice is 3 150; 2 000 of it was an advance application, not money received
    });

    it('a credit sale is never a tender: 06-16 holds an ON_CREDIT sale and no receipt', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-16', '2026-06-16');
      expect(r.receipts.receiptCount).toBe(0);
      expect(r.receipts.receiptTotalMinor).toBe('0');
    });

    it('ONLINE_GATEWAY appears only where the frozen verified-webhook capture recorded a Payment (06-20)', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-20', '2026-06-20');
      expect(byMethod(r.receipts.byMethod)['ONLINE_GATEWAY']).toMatchObject({
        receiptCount: 1,
        receiptTotalMinor: '2100',
      });
      expect(r.reconciliation.receipts.paymentClearing.sourceMinor).toBe('2100');
    });

    it('a payment made in JULY for a June invoice is a JULY receipt (the journal posts on the day of the payment)', async () => {
      const june = await branchReport(aed, aed.branchId, '2026-06-18', '2026-06-19');
      expect(june.receipts.receiptCount).toBe(0);
      const july = await branchReport(aed, aed.branchId, '2026-07-10', '2026-07-10');
      expect(july.receipts.receiptCount).toBe(1);
      expect(byMethod(july.receipts.byMethod)['CASH']).toMatchObject({ receiptTotalMinor: '6300' });
    });

    it('the whole-company receipt totals (hand-anchored) and the stream split behind the unapplied control', async () => {
      const r = await companyReport(aed, ...FULL);
      expect(byMethod(r.receipts.byMethod)).toMatchObject({
        CASH: { receiptCount: 9, receiptTotalMinor: '47100' },
        BANK_TRANSFER: { receiptCount: 4, receiptTotalMinor: '19750' },
        CARD_TERMINAL: { receiptCount: 3, receiptTotalMinor: '13350' },
        ONLINE_GATEWAY: { receiptCount: 1, receiptTotalMinor: '2100' },
        OTHER_MANUAL: { receiptCount: 3, receiptTotalMinor: '21000' },
      });
      expect(r.receipts.receiptCount).toBe(20);
      expect(r.receipts.receiptTotalMinor).toBe('103300');
      // anonymous tenders (9 450 + 21 000 + 10 500 + 5 250 + 4 200) never credit the unapplied-receipts liability
      expect(r.reconciliation.receipts.unappliedReceipts.sourceMinor).toBe('52900'); // 103 300 − 50 400 anonymous
    });
  });

  // ═══════════════════ refunds ═══════════════════
  describe('refunds', () => {
    it('a local CASH refund and a later BANK_TRANSFER refund are separate figures on their own posting dates', async () => {
      const cash1 = await branchReport(aed, aed.branchId, '2026-06-28', '2026-06-28');
      expect(cash1.refunds.refundCount).toBe(1);
      expect(byMethod(cash1.refunds.byMethod)['CASH']).toMatchObject({
        refundCount: 1,
        refundTotalMinor: '4000',
      });
      const bank1 = await branchReport(aed, aed.branchId, '2026-06-29', '2026-06-29');
      expect(byMethod(bank1.refunds.byMethod)['BANK_TRANSFER']).toMatchObject({
        refundCount: 1,
        refundTotalMinor: '3000',
      });
    });

    it('a refund a month AFTER the sale lands in its own (later) period — the sale period shows no refund', async () => {
      const sale = await branchReport(aed, aed.branchId, '2026-06-22', '2026-06-22');
      expect(sale.refunds.refundCount).toBe(0);
      expect(byMethod(sale.receipts.byMethod)['OTHER_MANUAL']).toMatchObject({
        receiptCount: 1,
        receiptTotalMinor: '10500',
      });
      const later = await branchReport(aed, aed.branchId, '2026-07-12', '2026-07-12');
      expect(later.refunds.refundCount).toBe(1);
      expect(byMethod(later.refunds.byMethod)['CASH']!.refundTotalMinor).toBe('3500');
      expect(later.receipts.receiptCount).toBe(0); // a July refund, no July receipt in that branch that day
      expect(BigInt(later.netTenderMovement.netMovementMinor)).toBe(-3_500n);
    });

    it('a CreditNote is not a refund: the cancellation day (06-23) shows a CreditNote + advance and ZERO refunds', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-23', '2026-06-23');
      expect(r.refunds.refundCount).toBe(0);
      expect(r.refunds.refundTotalMinor).toBe('0');
      expect(r.receipts.receiptCount).toBe(0);
    });

    it('several refunds of ONE advance are several Refund rows (three here: 4 000 + 3 000 + 3 500 = the 10 500 advance)', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-01', '2026-07-31');
      expect(r.refunds.refundCount).toBe(3);
      expect(r.refunds.refundTotalMinor).toBe('10500');
    });

    it('the second branch: CASH 1 000 + BANK_TRANSFER 2 000 on one day', async () => {
      const r = await branchReport(aed, aed.siblingBranchId, '2026-06-30', '2026-06-30');
      expect(r.refunds.refundCount).toBe(2);
      expect(byMethod(r.refunds.byMethod)['CASH']).toMatchObject({
        refundCount: 1,
        refundTotalMinor: '1000',
      });
      expect(byMethod(r.refunds.byMethod)['BANK_TRANSFER']).toMatchObject({
        refundCount: 1,
        refundTotalMinor: '2000',
      });
      expect(r.reconciliation.refunds.cashOnHand.sourceMinor).toBe('1000');
      expect(r.reconciliation.refunds.bank.sourceMinor).toBe('2000');
      expect(r.reconciliation.refunds.customerAdvances.sourceMinor).toBe('3000');
    });

    it('a provider-finalised refund credits the clearing account; a PENDING reservation and a FAILED attempt are not refunds (aed2)', async () => {
      const r = await companyReport(aed2, ...FULL);
      expect(r.refunds.refundCount).toBe(2); // 800 ONLINE_GATEWAY + 300 CARD_TERMINAL — not the 500 pending nor the 700 failed
      expect(r.refunds.refundTotalMinor).toBe('1100');
      expect(byMethod(r.refunds.byMethod)['ONLINE_GATEWAY']).toMatchObject({
        refundCount: 1,
        refundTotalMinor: '800',
      });
      expect(byMethod(r.refunds.byMethod)['CARD_TERMINAL']).toMatchObject({
        refundCount: 1,
        refundTotalMinor: '300',
      });
      expect(r.reconciliation.refunds.paymentClearing).toEqual({
        sourceMinor: '1100',
        glMinor: '1100',
        differenceMinor: '0',
        reconciled: true,
      });
      expect(r.reconciliation.refunds.cashOnHand.sourceMinor).toBe('0');
      // the pending reservation's amount (500) and the failed attempt's (700) appear nowhere
      const pending = await q<{ state: string; amount: string }>(
        `SELECT state, "requestedAmountMinor"::text AS amount FROM refund_attempt WHERE "companyId" = $1 AND state <> 'SUCCEEDED' ORDER BY amount`,
        [aed2.companyId],
      );
      expect(pending).toEqual([
        { state: 'PENDING', amount: '500' },
        { state: 'FAILED', amount: '700' },
      ]);
      // each succeeded refund sits on the posting date its own accounting date gave it
      expect((await companyReport(aed2, '2026-06-13', '2026-06-14')).refunds.refundCount).toBe(0);
      expect((await companyReport(aed2, '2026-06-15', '2026-06-15')).refunds.refundCount).toBe(1);
      expect((await companyReport(aed2, '2026-06-16', '2026-06-16')).refunds.refundCount).toBe(1);
    });

    it('receipts and refunds are separate figures and the explicit net is signed (a refund-only window is negative)', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-28', '2026-06-29');
      expect(r.receipts.receiptCount).toBe(0);
      expect(r.refunds.refundTotalMinor).toBe('7000');
      expect(r.netTenderMovement.netMovementMinor).toBe('-7000');
      expect(byMethod(r.netTenderMovement.byMethod)['CASH']!.netMovementMinor).toBe('-4000');
      expect(byMethod(r.netTenderMovement.byMethod)['BANK_TRANSFER']!.netMovementMinor).toBe(
        '-3000',
      );
      expect(r.netTenderMovement.note).toBe(TENDER_NET_NOTE);
    });

    it('the whole company: receipts 103 300, refunds 13 500, net tender movement 89 800 — no revenue / profit wording anywhere', async () => {
      const r = await companyReport(aed, ...FULL);
      expect(r.refunds.refundCount).toBe(5);
      expect(r.refunds.refundTotalMinor).toBe('13500');
      expect(r.netTenderMovement.netMovementMinor).toBe('89800');
      const keys =
        JSON.stringify(Object.keys(r)) + JSON.stringify(Object.keys(r.netTenderMovement));
      expect(keys).not.toMatch(/revenue|profit|settled|balance|sales/i);
    });
  });

  // ═══════════════════ the model oracle over a grid of windows × scopes ═══════════════════
  describe('the report equals the model oracle for every window and scope', () => {
    const WINDOWS: [string, string][] = [
      [...FULL],
      ['2026-06-01', '2026-06-30'],
      ['2026-07-01', '2026-07-31'],
      ['2026-06-10', '2026-06-10'],
      ['2026-06-12', '2026-06-18'],
      ['2026-06-20', '2026-06-28'],
      ['2026-05-01', '2026-06-09'],
      ['2026-08-01', '2026-09-30'],
      ['2026-06-14', '2026-06-15'],
      ['2020-01-01', '2030-12-31'], // no length cap: a multi-year range reads like any other
    ];
    it('aed: company, branch A and branch B all match — figures AND the independent GL oracle', async () => {
      const model = await loadModel(aed.companyId);
      expect(model.receipts.length).toBe(20);
      expect(model.refunds.length).toBe(5);
      for (const [from, to] of WINDOWS) {
        const company = await companyReport(aed, from, to);
        expect(figuresOf(company), `company ${from}..${to}`).toEqual(
          expectedFigures(model, from, to, null),
        );
        for (const branchId of [aed.branchId, aed.siblingBranchId]) {
          const b = await branchReport(aed, branchId, from, to);
          expect(figuresOf(b), `branch ${branchId} ${from}..${to}`).toEqual(
            expectedFigures(model, from, to, branchId),
          );
        }
      }
    });

    it('every reconciliation control equals the GL read straight from the journal tables (company and branch scopes)', async () => {
      for (const [from, to] of WINDOWS) {
        for (const scope of [null, aed.branchId, aed.siblingBranchId]) {
          const r =
            scope === null
              ? await companyReport(aed, from, to)
              : await branchReport(aed, scope, from, to);
          const gl = await glOracle(aed, from, to, scope);
          expect(r.reconciliation.receipts.cashOnHand.glMinor).toBe(gl['rCash']!.toString());
          expect(r.reconciliation.receipts.bank.glMinor).toBe(gl['rBank']!.toString());
          expect(r.reconciliation.receipts.paymentClearing.glMinor).toBe(
            gl['rClearing']!.toString(),
          );
          expect(r.reconciliation.receipts.unappliedReceipts.glMinor).toBe(
            gl['rUnapplied']!.toString(),
          );
          expect(r.reconciliation.refunds.cashOnHand.glMinor).toBe(gl['fCash']!.toString());
          expect(r.reconciliation.refunds.bank.glMinor).toBe(gl['fBank']!.toString());
          expect(r.reconciliation.refunds.paymentClearing.glMinor).toBe(
            gl['fClearing']!.toString(),
          );
          expect(r.reconciliation.refunds.customerAdvances.glMinor).toBe(
            gl['fAdvances']!.toString(),
          );
          expect(r.reconciliation.reconciled).toBe(true);
        }
      }
    });

    it('aed2 (provider refunds), kwd and the foreign tenant match their own oracles', async () => {
      for (const [co, wins] of [
        [
          aed2,
          [FULL, ['2026-06-13', '2026-06-16'] as const, ['2026-06-15', '2026-06-15'] as const],
        ],
        [kwd, [FULL, ['2026-06-10', '2026-06-12'] as const, ['2026-06-14', '2026-06-14'] as const]],
      ] as const) {
        const model = await loadModel(co.companyId);
        for (const [from, to] of wins) {
          for (const scope of [null, co.branchId, co.siblingBranchId]) {
            const r =
              scope === null
                ? await companyReport(co, from, to)
                : await branchReport(co, scope, from, to);
            expect(figuresOf(r), `${co.currency} ${scope} ${from}..${to}`).toEqual(
              expectedFigures(model, from, to, scope),
            );
          }
        }
      }
      const fm = await loadModel(foreign.companyId);
      expect(figuresOf(await companyReport(foreign, ...FULL))).toEqual(
        expectedFigures(fm, ...FULL, null),
      );
      expect(fm.receipts).toHaveLength(1);
    });
  });

  // ═══════════════════ branch / company / byBranch / isolation ═══════════════════
  describe('branch, company and byBranch', () => {
    it('Branch A and Branch B report only their own movements; the company is exactly A + B', async () => {
      const a = await branchReport(aed, aed.branchId, ...FULL);
      const b = await branchReport(aed, aed.siblingBranchId, ...FULL);
      const c = await companyReport(aed, ...FULL);
      expect(a.receipts.receiptCount).toBeGreaterThan(0);
      expect(b.receipts.receiptCount).toBeGreaterThan(0);
      expect(c.receipts.receiptCount).toBe(a.receipts.receiptCount + b.receipts.receiptCount);
      expect(c.refunds.refundCount).toBe(a.refunds.refundCount + b.refunds.refundCount);
      for (const m of TENDER_METHODS) {
        const pick = (rep: TenderTotalsCompanyReport | TenderTotalsBranchReport) =>
          byMethod(rep.receipts.byMethod)[m]!;
        expect(BigInt(pick(c).receiptTotalMinor)).toBe(
          BigInt(pick(a).receiptTotalMinor) + BigInt(pick(b).receiptTotalMinor),
        );
        const pr = (rep: TenderTotalsCompanyReport | TenderTotalsBranchReport) =>
          byMethod(rep.refunds.byMethod)[m]!;
        expect(BigInt(pr(c).refundTotalMinor)).toBe(
          BigInt(pr(a).refundTotalMinor) + BigInt(pr(b).refundTotalMinor),
        );
      }
      expect(BigInt(c.netTenderMovement.netMovementMinor)).toBe(
        BigInt(a.netTenderMovement.netMovementMinor) + BigInt(b.netTenderMovement.netMovementMinor),
      );
    });

    it("every byBranch row EQUALS that branch's own report (including the reconciliation block)", async () => {
      const c = await companyReport(aed, ...FULL);
      expect(c.byBranch.map((r) => r.branchId).sort()).toEqual(
        [aed.branchId, aed.siblingBranchId].sort(),
      );
      // deterministic: ascending branch id
      expect(c.byBranch.map((r) => r.branchId)).toEqual(
        [...c.byBranch.map((r) => r.branchId)].sort(),
      );
      for (const row of c.byBranch) {
        const { branchId, ...blocks } = row;
        const own = await branchReport(aed, branchId, ...FULL);
        const {
          companyId: _c,
          currencyCode: _cc,
          currencyExponent: _ce,
          accountingTimezone: _t,
          from: _f,
          to: _to,
          branchId: _b,
          ...ownBlocks
        } = own;
        void _c;
        void _cc;
        void _ce;
        void _t;
        void _f;
        void _to;
        void _b;
        expect(blocks).toEqual(ownBlocks);
      }
    });

    it('a branch with no movement in the window is a zero-filled report (not an error), and is absent from byBranch', async () => {
      const r = await branchReport(aed, aed.siblingBranchId, '2026-06-10', '2026-06-10');
      expect(r.receipts.receiptCount).toBe(0);
      expect(r.receipts.byMethod).toHaveLength(5);
      expect(r.receipts.byMethod.every((m) => m.receiptTotalMinor === '0')).toBe(true);
      expect(r.netTenderMovement.netMovementMinor).toBe('0');
      const c = await companyReport(aed, '2026-06-10', '2026-06-10');
      expect(c.byBranch.map((x) => x.branchId)).toEqual([aed.branchId]);
      expect((await companyReport(aed, '2026-08-01', '2026-08-31')).byBranch).toEqual([]);
    });

    it('the report states its company currency, exponent, timezone and period', async () => {
      const c = await companyReport(aed, '2026-06-01', '2026-06-30');
      expect(c).toMatchObject({
        companyId: aed.companyId,
        currencyCode: 'AED',
        currencyExponent: 2,
        accountingTimezone: 'Asia/Dubai',
        from: '2026-06-01',
        to: '2026-06-30',
      });
    });

    it('another company of the same tenant and a foreign tenant NEVER appear in this company, and vice versa', async () => {
      const mine = await companyReport(aed, ...FULL);
      await sell(
        await mkOrder(aed2, null, one(7_777n)),
        { tenders: [cash(8_166n)] },
        at('2026-06-10'),
      ); // 7 777 + 5 %
      await sell(
        await mkOrder(foreign, null, one(1_000n)),
        { tenders: [cash(1_050n)] },
        at('2026-06-10'),
      );
      setClock(DEFAULT_INSTANT);
      expect(figuresOf(await companyReport(aed, ...FULL))).toEqual(figuresOf(mine));
      const other = await companyReport(aed2, '2026-06-10', '2026-06-10');
      expect(other.receipts.receiptTotalMinor).toBe('8166');
      expect(other.byBranch).toHaveLength(1);
      expect(other.byBranch[0]!.branchId).toBe(aed2.branchId);
      expect(
        (await companyReport(foreign, '2026-06-10', '2026-06-10')).receipts.receiptTotalMinor,
      ).toBe('2346'); // 1 296 + 1 050
    });

    it("a foreign tenant's company, a missing company and a branch of ANOTHER company are plain 404s", async () => {
      for (const run of [
        () =>
          inTenant(() =>
            service.companyReport({ companyId: foreign.companyId, from: FULL[0], to: FULL[1] }),
          ),
        () =>
          inTenant(() =>
            service.companyReport({ companyId: randomUUID(), from: FULL[0], to: FULL[1] }),
          ),
        () =>
          inTenant(() =>
            service.branchReport({
              companyId: aed.companyId,
              branchId: aed2.branchId,
              from: FULL[0],
              to: FULL[1],
            }),
          ),
        () =>
          inTenant(() =>
            service.branchReport({
              companyId: aed.companyId,
              branchId: foreign.branchId,
              from: FULL[0],
              to: FULL[1],
            }),
          ),
        () =>
          inTenant(() =>
            service.branchReport({
              companyId: foreign.companyId,
              branchId: foreign.branchId,
              from: FULL[0],
              to: FULL[1],
            }),
          ),
      ]) {
        let err: unknown;
        try {
          await run();
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as NotFoundError).status).toBe(404);
      }
    });
  });

  // ═══════════════════ period membership = the JOURNAL's posting date ═══════════════════
  describe('postingDate controls inclusion — never the document date', () => {
    it("each movement's own boundary: before from, on from, inside, on to, after to", async () => {
      const probe = async (from: string, to: string) =>
        (await branchReport(aed, aed.branchId, from, to)).receipts.byMethod.find(
          (m) => m.method === 'BANK_TRANSFER',
        )!.receiptCount;
      // the single BANK_TRANSFER receipt of 06-11… is on branch B; use branch A's 06-10 multi-payment BANK (7 000)
      expect(await probe('2026-06-11', '2026-06-11')).toBe(0); // posting BEFORE from
      expect(await probe('2026-06-10', '2026-06-10')).toBe(1); // on from AND on to
      expect(await probe('2026-06-09', '2026-06-11')).toBe(1); // inside
      expect(await probe('2026-06-09', '2026-06-09')).toBe(0); // AFTER to
      expect(await probe('2026-06-10', '2026-06-10')).toBe(1);
      expect(await probe('2026-06-01', '2026-06-10')).toBe(1); // on to
    });

    it('the Payment row date is irrelevant: createdAt is the real wall clock, yet every Payment sits on its journal date', async () => {
      const rows = await q<{ created: string }>(
        `SELECT p."createdAt"::date::text AS created FROM payment p WHERE p."companyId" = $1 LIMIT 3`,
        [aed.companyId],
      );
      const postingDates = new Set(
        (await loadModel(aed.companyId)).receipts.map((r) => r.postingDate),
      );
      // the real wall-clock day carries no receipt: createdAt is NOT any journal's posting date
      const wall = rows[0]!.created;
      expect(postingDates.has(wall)).toBe(false);
      const lo = new Date(`${wall}T00:00:00Z`);
      const from = new Date(lo.getTime() - 86_400_000).toISOString().slice(0, 10);
      const to = new Date(lo.getTime() + 86_400_000).toISOString().slice(0, 10);
      expect((await companyReport(aed, from, to)).receipts.receiptCount).toBe(0);
    });

    it('the customer receipt: its journal posts at 00:00:01 on 06-15 although the Payment was created at 23:59:59 on 06-14', async () => {
      const pd = (
        await q<{ d: string }>(
          `SELECT "postingDate"::text AS d FROM journal_entry WHERE "sourceKind" = 'customer_receipt_payment' AND "sourceId" = $1`,
          [W['straddleReceipt']],
        )
      )[0]!.d;
      expect(pd).toBe('2026-06-15');
      // posting OUTSIDE the window → excluded; posting INSIDE → included
      const on14 = await branchReport(aed, aed.branchId, '2026-06-14', '2026-06-14');
      expect(byMethod(on14.receipts.byMethod)['BANK_TRANSFER']!.receiptCount).toBe(0);
      const on15 = await branchReport(aed, aed.branchId, '2026-06-15', '2026-06-15');
      expect(byMethod(on15.receipts.byMethod)['BANK_TRANSFER']).toMatchObject({
        receiptCount: 1,
        receiptTotalMinor: '1000',
      });
    });

    it("the anonymous walk-in tender: the journal is dated by the INVOICE's own date (06-14) even though it was posted after midnight", async () => {
      const inv = (
        await q<{ d: string }>(`SELECT "invoiceDate"::text AS d FROM invoice WHERE id = $1`, [
          W['anonStraddleInvoice'],
        ])
      )[0]!;
      const pd = (
        await q<{ d: string }>(
          `SELECT "postingDate"::text AS d FROM journal_entry WHERE "sourceKind" = 'walk_in_sale' AND "sourceId" = $1`,
          [W['anonStraddleInvoice']],
        )
      )[0]!;
      expect(inv.d).toBe('2026-06-14');
      expect(pd.d).toBe('2026-06-14');
      const on14 = await branchReport(aed, aed.branchId, '2026-06-14', '2026-06-14');
      expect(byMethod(on14.receipts.byMethod)['CASH']!.receiptTotalMinor).toBe('9200'); // 5 000 unapplied + 4 200 anonymous
      const on15 = await branchReport(aed, aed.branchId, '2026-06-15', '2026-06-15');
      expect(byMethod(on15.receipts.byMethod)['CASH']!.receiptCount).toBe(0);
    });

    it('a refund is dated by its own journal (the route stamps the company-timezone date of the call)', async () => {
      const pd = (
        await q<{ d: string; ad: string }>(
          `SELECT je."postingDate"::text AS d, r."accountingDate"::text AS ad FROM journal_entry je JOIN refund r ON r.id::text = je."sourceId"
            WHERE je."sourceKind" = 'refund' AND r.id = $1`,
          [W['refundCash2']],
        )
      )[0]!;
      expect(pd.d).toBe('2026-07-12');
      expect(pd.ad).toBe(pd.d);
      expect(
        (await branchReport(aed, aed.branchId, '2026-07-12', '2026-07-12')).refunds.refundCount,
      ).toBe(1);
      expect(
        (await branchReport(aed, aed.branchId, '2026-07-11', '2026-07-11')).refunds.refundCount,
      ).toBe(0);
      expect(
        (await branchReport(aed, aed.branchId, '2026-07-13', '2026-07-13')).refunds.refundCount,
      ).toBe(0);
    });
  });

  // ═══════════════════ KWD (exponent 3) ═══════════════════
  describe('KWD (exponent 3)', () => {
    it('reports exact 3-decimal minor units with the exponent', async () => {
      const r = await companyReport(kwd, '2026-06-01', '2026-06-30');
      expect(r).toMatchObject({
        currencyCode: 'KWD',
        currencyExponent: 3,
        accountingTimezone: 'Asia/Kuwait',
      });
      expect(r.receipts.receiptTotalMinor).toBe('25845'); // 12.345 + 7.500 + 6.000 KWD
      expect(byMethod(r.receipts.byMethod)).toMatchObject({
        CASH: { receiptCount: 1, receiptTotalMinor: '5000' },
        BANK_TRANSFER: { receiptCount: 2, receiptTotalMinor: '14845' },
        CARD_TERMINAL: { receiptCount: 1, receiptTotalMinor: '6000' },
      });
      expect(r.refunds.refundTotalMinor).toBe('2500');
      expect(r.netTenderMovement.netMovementMinor).toBe(String(25_845n - 2_500n)); // 23.345 KWD
      expect(r.reconciliation.reconciled).toBe(true);
    });
  });

  // ═══════════════════ source ↔ GL reconciliation ═══════════════════
  describe('source ↔ GL reconciliation', () => {
    it('every control is zero-difference and reconciled — company and each branch', async () => {
      for (const co of [aed, aed2, kwd]) {
        const c = await companyReport(co, ...FULL);
        const controls = (rep: TenderTotalsBranchReport | TenderTotalsCompanyReport) => [
          ...Object.values(rep.reconciliation.receipts),
          ...Object.values(rep.reconciliation.refunds),
        ];
        expect(controls(c)).toHaveLength(8);
        for (const ctl of controls(c)) {
          expect(ctl.reconciled).toBe(true);
          expect(ctl.differenceMinor).toBe('0');
          expect(ctl.sourceMinor).toBe(ctl.glMinor);
        }
        for (const row of c.byBranch) expect(row.reconciliation.reconciled).toBe(true);
      }
    });

    it('a manual / unrelated journal on a tender account never enters a control, and cannot break one', async () => {
      const before = await companyReport(aed, ...FULL);
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: aed.companyId,
          sourceKind: 'manual_adjustment',
          sourceId: randomUUID(),
          branchId: aed.branchId,
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 9_999n },
            { accountKey: 'ASSET.PAYMENT_CLEARING', direction: 'credit', amountMinor: 9_999n },
          ],
        }),
      );
      setClock(DEFAULT_INSTANT);
      expect(await companyReport(aed, ...FULL)).toEqual(before);
    });

    it('a settlement journal (moves money clearing → bank) is not a tender movement', async () => {
      const r = await companyReport(aed2, '2026-06-01', '2026-06-01');
      expect(r.receipts.receiptCount).toBe(0);
      expect(r.refunds.refundCount).toBe(0);
      expect(r.reconciliation.receipts.paymentClearing.glMinor).toBe('0');
      expect(
        (
          await q(
            `SELECT 1 FROM journal_entry WHERE "companyId" = $1 AND "sourceKind" = 'SETTLEMENT_BATCH' AND "postingDate" = '2026-06-01'`,
            [aed2.companyId],
          )
        ).length,
      ).toBe(1);
    });

    it('a Payment that has NO journal of any kind is not provable by a journal-anchored period report (the stated boundary)', async () => {
      // aed2's RAW-SEEDED provider Payment (no frozen flow recorded it) has no receipt journal — it is invisible, never guessed
      expect(
        (await q(`SELECT 1 FROM payment WHERE id = $1`, [W['rawProviderPayment']])).length,
      ).toBe(1);
      const model = await loadModel(aed2.companyId);
      expect(model.receipts.find((x) => x.id === W['rawProviderPayment'])).toBeUndefined();
      const r = await companyReport(aed2, ...FULL);
      expect(r.receipts.receiptCount).toBe(model.receipts.length); // never counts the journal-less Payment, never errors
    });
  });

  // ═══════════════════ input and read-only behaviour ═══════════════════
  describe('input and read-only behaviour', () => {
    it('invalid dates never reach the database; both bounds are required', async () => {
      const bad = (from: unknown, to: unknown) =>
        reject(inTenant(() => service.companyReport({ companyId: aed.companyId, from, to })));
      expect(await bad(undefined, '2026-06-30')).toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 400,
      });
      expect(await bad('2026-06-01', undefined)).toMatchObject({ code: 'VALIDATION_FAILED' });
      for (const v of [
        '2026-06-01T00:00:00Z',
        '06/01/2026',
        '2026-6-1',
        '2026-02-30',
        20260601,
        '2026-06-01+04:00',
        '0000-01-01',
      ]) {
        expect(await bad(v, '2026-06-30'), String(v)).toMatchObject({
          code: 'INVALID_DATE',
          status: 400,
        });
      }
      expect(await bad('2026-06-30', '2026-06-01')).toMatchObject({ code: 'INVALID_DATE_RANGE' });
      expect((await companyReport(aed, '2026-06-10', '2026-06-10')).from).toBe('2026-06-10'); // a one-day period is fine
    });

    it('there is NO period cap and NO document limit: the Sales 90-day / 25 000 rules are not applied (a 4-year range reports)', async () => {
      const long = await companyReport(aed, '2024-01-01', '2027-12-31');
      expect(figuresOf(long)).toEqual(figuresOf(await companyReport(aed, ...FULL)));
      const half = await companyReport(aed, '2026-06-01', '2026-12-31'); // 214 days: accepted
      expect(half.receipts.receiptCount).toBe(20);
    });

    it('reading a report writes nothing: ledger, documents, audit and outbox are byte-for-byte unchanged', async () => {
      const count = async (): Promise<string> =>
        (
          await q<{ n: string }>(
            `SELECT (SELECT count(*) FROM audit_log) || '/' || (SELECT count(*) FROM outbox) || '/' || (SELECT count(*) FROM journal_entry)
                    || '/' || (SELECT count(*) FROM journal_line) || '/' || (SELECT count(*) FROM payment) || '/' || (SELECT count(*) FROM refund)
                    || '/' || (SELECT count(*) FROM idempotency_key) AS n`,
          )
        )[0]!.n;
      const before = await count();
      await companyReport(aed, ...FULL);
      await branchReport(aed, aed.branchId, ...FULL);
      await companyReport(kwd, ...FULL);
      expect(await count()).toBe(before);
    });

    it('the transaction is database-enforced read-only (a write inside it is refused)', async () => {
      class Probe extends TenderTotalsReportRepository {
        async tryWrite(): Promise<unknown> {
          return this.readScoped((tx) =>
            tx.$executeRawUnsafe(`UPDATE branch SET name = name WHERE id = '${aed.branchId}'`),
          );
        }
      }
      await expect(inTenant(() => new Probe(db).tryWrite())).rejects.toThrow(/read-only/i);
    });

    it('a company without an accounting timezone / currency fails closed', async () => {
      const bare = randomUUID();
      await pool.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
         VALUES ($1,$2,'Bare','AE',NULL,'Asia/Dubai','ACTIVE',now())`,
        [bare, tenantId],
      );
      expect(
        await reject(
          inTenant(() => service.companyReport({ companyId: bare, from: FULL[0], to: FULL[1] })),
        ),
      ).toMatchObject({ code: 'REPORT_COMPANY_NOT_CONFIGURED', status: 409 });
    });

    it('ONE statement in ONE transaction per report — company and branch (no COUNT + report, no per-payment query, no N+1)', async () => {
      const counting = () =>
        new (class extends TenderTotalsReportRepository {
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
      const c = counting();
      await inTenant(() =>
        c.getCompanyReportScoped({ companyId: aed.companyId, from: FULL[0], to: FULL[1] }),
      );
      expect([c.statements, c.transactions]).toEqual([1, 1]);
      const b = counting();
      await inTenant(() =>
        b.getBranchReportScoped({
          companyId: aed.companyId,
          branchId: aed.branchId,
          from: FULL[0],
          to: FULL[1],
        }),
      );
      expect([b.statements, b.transactions]).toEqual([1, 1]);
    });
  });

  // ═══════════════════ malformed financial data FAILS CLOSED ═══════════════════
  describe('a malformed authoritative journal fails the report closed (never repaired)', () => {
    const W6 = ['2026-06-01', '2026-06-30'] as const;

    /** corrupt with triggers off (the application path can never write these states) */
    async function corrupt(sql: string, params: unknown[] = []): Promise<void> {
      const c = await pool.connect();
      try {
        await c.query(`SET session_replication_role = 'replica'`);
        await c.query(sql, params);
        await c.query(`SET session_replication_role = 'origin'`);
      } finally {
        c.release();
      }
    }

    /** a balanced EXTRA pair of lines on a journal (Dr <debitKey> 5 / Cr <creditKey> 5), written with triggers off */
    async function addLinePair(
      co: Co,
      entryId: string,
      debitKey: string,
      creditKey: string,
    ): Promise<void> {
      for (const [key, dr, cr] of [
        [debitKey, 5, 0],
        [creditKey, 0, 5],
      ] as const) {
        await corrupt(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
           VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
          [co.tenantId, co.companyId, entryId, key, co.branchId, dr, cr],
        );
      }
    }
    const journalOf = async (kind: string, sourceId: string): Promise<string> =>
      (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = $1 AND "sourceId" = $2`,
          [kind, sourceId],
        )
      )[0]!.id;
    const paymentOfInvoice = async (invoiceId: string): Promise<string> =>
      (
        await q<{ id: string }>(
          `SELECT p.id FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1`,
          [invoiceId],
        )
      )[0]!.id;

    /** a fresh company with ONE anonymous CASH sale (one Payment, one walk_in_sale journal) */
    async function freshAnon(): Promise<{
      co: Co;
      invoiceId: string;
      paymentId: string;
      entryId: string;
    }> {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const s = await sell(
        await mkOrder(co, null, one(10_000n)),
        { tenders: [cash(10_500n)] },
        at('2026-06-10'),
      );
      setClock(DEFAULT_INSTANT);
      const ok = await companyReport(co, ...W6);
      expect(ok.reconciliation.reconciled).toBe(true);
      expect(ok.receipts.receiptTotalMinor).toBe('10500');
      return {
        co,
        invoiceId: s.invoiceId,
        paymentId: await paymentOfInvoice(s.invoiceId),
        entryId: await journalOf('walk_in_sale', s.invoiceId),
      };
    }
    /** a fresh company with ONE standalone customer receipt (CASH 3 000, one customer_receipt_payment journal) */
    async function freshReceipt(): Promise<{ co: Co; paymentId: string; entryId: string }> {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const c = await mkCustomer(co);
      const r = await receipt(co, co.branchId, c.customerId, 'CASH', 3_000n, at('2026-06-10'));
      setClock(DEFAULT_INSTANT);
      const ok = await companyReport(co, ...W6);
      expect(ok.receipts.receiptTotalMinor).toBe('3000');
      return {
        co,
        paymentId: r.paymentId,
        entryId: await journalOf('customer_receipt_payment', r.paymentId),
      };
    }
    /** a fresh company with ONE local CASH refund (1 000) of a CreditNote-funded advance */
    async function freshRefund(): Promise<{ co: Co; refundId: string; entryId: string }> {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const c = await mkCustomer(co);
      const adv = await paidThenCancelledAdvance(
        co,
        co.branchId,
        c,
        4_000n,
        500,
        card(4_200n),
        at('2026-06-10'),
        at('2026-06-11'),
      );
      const refundId = await refund(
        co,
        co.branchId,
        adv.advanceId,
        'CASH',
        1_000n,
        at('2026-06-12'),
      );
      const ok = await companyReport(co, ...W6);
      expect(ok.refunds.refundTotalMinor).toBe('1000');
      return { co, refundId, entryId: await journalOf('refund', refundId) };
    }
    const postRaw = async (
      co: Co,
      kind: string,
      sourceId: string,
      lines: { accountKey: string; direction: 'debit' | 'credit'; amountMinor: bigint }[],
    ): Promise<void> => {
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: co.companyId,
          sourceKind: kind,
          sourceId,
          branchId: co.branchId,
          lines,
        }),
      );
      setClock(DEFAULT_INSTANT);
    };

    // ── customer receipts ──
    describe('customer receipt journals', () => {
      it('a receipt journal that debits one minor unit more than its Payment → receiptJournalMismatches (company AND branch)', async () => {
        const { co, entryId } = await freshReceipt();
        await corrupt(
          `UPDATE journal_line SET "debitMinor" = "debitMinor" + 1 WHERE "journalEntryId" = $1 AND "debitMinor" > 0`,
          [entryId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'receiptJournalMismatches');
        await expectIntegrity(branchReport(co, co.branchId, ...W6), 'receiptJournalMismatches');
      });

      it('a CASH Payment booked to the BANK account (a swap that nets to zero in a whole-account control) → receiptJournalMismatches', async () => {
        const { co, entryId } = await freshReceipt();
        await corrupt(
          `UPDATE journal_line SET "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'ASSET.BANK')
            WHERE "journalEntryId" = $1 AND "debitMinor" > 0`,
          [entryId, co.companyId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'receiptJournalMismatches');
      });

      it('the unapplied-receipts credit one unit short → receiptJournalMismatches', async () => {
        const { co, entryId } = await freshReceipt();
        await corrupt(
          `UPDATE journal_line SET "creditMinor" = "creditMinor" - 1 WHERE "journalEntryId" = $1 AND "creditMinor" > 0`,
          [entryId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'receiptJournalMismatches');
      });

      it('an EXTRA balanced pair of lines on a receipt journal (Dr bank 5 / Cr tax 5 — the totals still balance) → receiptJournalMismatches', async () => {
        const { co, entryId } = await freshReceipt();
        await addLinePair(co, entryId, 'ASSET.BANK', 'LIABILITY.TAX_PAYABLE');
        await expectIntegrity(companyReport(co, ...W6), 'receiptJournalMismatches');
      });

      it('an ORPHAN receipt journal (its sourceId names no Payment) → orphanReceiptJournals, non-disclosing', async () => {
        const { co } = await freshReceipt();
        await postRaw(co, 'customer_receipt_payment', randomUUID(), [
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 100n },
          { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', direction: 'credit', amountMinor: 100n },
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'orphanReceiptJournals');
      });

      it('a sourceId that is not even a uuid is an orphan, not a SQL cast error', async () => {
        const { co } = await freshReceipt();
        await postRaw(co, 'customer_receipt_payment', 'not-a-uuid-at-all', [
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 100n },
          { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', direction: 'credit', amountMinor: 100n },
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'orphanReceiptJournals');
      });

      it('a journal whose source names a Payment of ANOTHER company or tenant is an orphan — documents are never joined across scopes', async () => {
        for (const foreignPayment of [
          W['unappliedPayment']!,
          (
            await q<{ id: string }>(`SELECT id FROM payment WHERE "companyId" = $1`, [
              foreign.companyId,
            ])
          )[0]!.id,
        ]) {
          const { co, entryId } = await freshReceipt();
          await corrupt(`UPDATE journal_entry SET "sourceId" = $2 WHERE id = $1`, [
            entryId,
            foreignPayment,
          ]);
          await expectIntegrity(companyReport(co, ...W6), 'orphanReceiptJournals');
        }
      });

      it('a receipt journal booked on a DIFFERENT branch than its Payment → branchMismatchLines', async () => {
        const { co, entryId } = await freshReceipt();
        await corrupt(`UPDATE journal_line SET "branchId" = $2 WHERE "journalEntryId" = $1`, [
          entryId,
          co.siblingBranchId,
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'branchMismatchLines');
      });

      it('a journal in a foreign currency, and a Payment in a foreign currency → REPORT_CURRENCY_MISMATCH (409), never converted', async () => {
        const a = await freshReceipt();
        await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [a.entryId]);
        expect(await reject(companyReport(a.co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
          status: 409,
        });
        const b = await freshReceipt();
        await corrupt(`UPDATE payment SET "currencyCode" = 'KWD' WHERE id = $1`, [b.paymentId]);
        expect(await reject(companyReport(b.co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
      });

      it('an UNSEALED receipt journal is never authoritative: it is invisible (nothing is counted, nothing guessed)', async () => {
        const { co, entryId } = await freshReceipt();
        await corrupt(`UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1`, [entryId]);
        const r = await companyReport(co, ...W6);
        expect(r.receipts.receiptCount).toBe(0);
        expect(r.byBranch).toEqual([]);
      });

      it('a SECOND receipt journal for one Payment cannot exist: the (company, sourceKind, sourceId) unique index refuses it', async () => {
        const { entryId } = await freshReceipt();
        await expect(
          corrupt(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
             SELECT uuidv7(),"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode",'dup' FROM journal_entry WHERE id = $1`,
            [entryId],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      });

      it('VALID: an allocation journal posted after midnight of its receipt journal (the receipt sits in the EARLIER period) never fails the later report', async () => {
        const co = await makeCompany(tenantId, { currency: 'AED' });
        const c = await mkCustomer(co);
        const s = await sell(
          await mkOrder(co, c.customerId, one(10_000n)),
          { intent: 'ON_CREDIT' },
          at('2026-06-10'),
        );
        const realPost = engine.postJournal.bind(engine);
        const spy = vi.spyOn(engine, 'postJournal').mockImplementation(async (tx, input) => {
          if (input.sourceKind === 'payment_allocation')
            setClock(new Date('2026-06-14T20:00:01.000Z')); // 00:00:01 on 06-15
          return realPost(tx, input);
        });
        try {
          await payInvoice(
            co,
            co.branchId,
            s.invoiceId,
            [cash(10_500n)],
            new Date('2026-06-14T19:59:59.000Z'),
          );
        } finally {
          spy.mockRestore();
        }
        setClock(DEFAULT_INSTANT);
        const paymentId = await paymentOfInvoice(s.invoiceId);
        const dateOf = async (kind: string, sourceId: string): Promise<string> =>
          (
            await q<{ d: string }>(
              'SELECT "postingDate"::text AS d FROM journal_entry WHERE "sourceKind" = $1 AND "sourceId" = $2',
              [kind, sourceId],
            )
          )[0]!.d;
        expect(await dateOf('customer_receipt_payment', paymentId)).toBe('2026-06-14');
        const allocationId = (
          await q<{ id: string }>('SELECT id FROM payment_allocation WHERE "paymentId" = $1', [
            paymentId,
          ])
        )[0]!.id;
        expect(await dateOf('payment_allocation', allocationId)).toBe('2026-06-15');
        // 06-15 holds the allocation journal but NOT the receipt journal: the receipt is proven by the source index — no failure, no receipt
        const later = await companyReport(co, '2026-06-15', '2026-06-15');
        expect(later.receipts.receiptCount).toBe(0);
        const earlier = await companyReport(co, '2026-06-14', '2026-06-14');
        expect(earlier.receipts.receiptTotalMinor).toBe('10500');
      });

      it('an UNSEALED receipt journal is no proof of a receipt: an allocated Payment whose only receipt journal is unsealed → allocatedPaymentsWithoutReceiptJournal', async () => {
        const co = await makeCompany(tenantId, { currency: 'AED' });
        const c = await mkCustomer(co);
        const s = await sell(
          await mkOrder(co, c.customerId, one(10_000n)),
          { intent: 'ON_CREDIT' },
          at('2026-06-10'),
        );
        await payInvoice(co, co.branchId, s.invoiceId, [cash(10_500n)], at('2026-06-11'));
        setClock(DEFAULT_INSTANT);
        const entry = await journalOf(
          'customer_receipt_payment',
          await paymentOfInvoice(s.invoiceId),
        );
        await corrupt('UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1', [entry]);
        await expectIntegrity(companyReport(co, ...W6), 'allocatedPaymentsWithoutReceiptJournal');
      });

      it('a customer Payment that was allocated but has NO receipt journal → allocatedPaymentsWithoutReceiptJournal', async () => {
        const co = await makeCompany(tenantId, { currency: 'AED' });
        const c = await mkCustomer(co);
        const s = await sell(
          await mkOrder(co, c.customerId, one(10_000n)),
          { intent: 'ON_CREDIT' },
          at('2026-06-10'),
        );
        await payInvoice(co, co.branchId, s.invoiceId, [cash(10_500n)], at('2026-06-11'));
        setClock(DEFAULT_INSTANT);
        const ok = await companyReport(co, ...W6);
        expect(ok.receipts.receiptTotalMinor).toBe('10500');
        const paymentId = await paymentOfInvoice(s.invoiceId);
        const entry = await journalOf('customer_receipt_payment', paymentId);
        await corrupt(`DELETE FROM journal_line WHERE "journalEntryId" = $1`, [entry]);
        await corrupt(`DELETE FROM journal_entry WHERE id = $1`, [entry]);
        await expectIntegrity(companyReport(co, ...W6), 'allocatedPaymentsWithoutReceiptJournal');
        await expectIntegrity(
          branchReport(co, co.branchId, ...W6),
          'allocatedPaymentsWithoutReceiptJournal',
        );
      });
    });

    // ── anonymous walk-in tenders ──
    describe('anonymous walk-in sale journals', () => {
      it('a Payment one minor unit above the debit line it should match → walkInTenderMismatches', async () => {
        const { co, paymentId } = await freshAnon();
        await corrupt(`UPDATE payment SET "amountMinor" = "amountMinor" + 1 WHERE id = $1`, [
          paymentId,
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'walkInTenderMismatches');
        await expectIntegrity(branchReport(co, co.branchId, ...W6), 'walkInTenderMismatches');
      });

      it('an EXTRA balanced pair of lines on a walk-in journal (Dr bank 5 / Cr tax 5) → walkInTenderMismatches', async () => {
        const { co, entryId } = await freshAnon();
        await addLinePair(co, entryId, 'ASSET.BANK', 'LIABILITY.TAX_PAYABLE');
        await expectIntegrity(companyReport(co, ...W6), 'walkInTenderMismatches');
      });

      it('a CASH tender whose debit line sits on the BANK account → walkInTenderMismatches', async () => {
        const { co, entryId } = await freshAnon();
        await corrupt(
          `UPDATE journal_line SET "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'ASSET.BANK')
            WHERE "journalEntryId" = $1 AND "debitMinor" > 0`,
          [entryId, co.companyId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'walkInTenderMismatches');
      });

      it('a walk-in journal whose invoice has NO Payments at all → walkInTenderMismatches', async () => {
        const { co, paymentId } = await freshAnon();
        await corrupt(`DELETE FROM payment_allocation WHERE "paymentId" = $1`, [paymentId]);
        await corrupt(`DELETE FROM payment WHERE id = $1`, [paymentId]);
        await expectIntegrity(companyReport(co, ...W6), 'walkInTenderMismatches');
      });

      it('an anonymous Payment allocated to TWO invoices (fan-out would double count it) → walkInPaymentAllocationFanout', async () => {
        const { co, paymentId } = await freshAnon();
        const s2 = await sell(
          await mkOrder(co, null, one(5_000n)),
          { tenders: [cash(5_250n)] },
          at('2026-06-10'),
        );
        setClock(DEFAULT_INSTANT);
        await corrupt(
          `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,1,'AED',2)`,
          [co.tenantId, co.companyId, co.branchId, paymentId, s2.invoiceId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'walkInPaymentAllocationFanout');
      });

      it('a walk-in journal on an invoice that belongs to an IDENTIFIED customer → walkInOnCustomerInvoices', async () => {
        const co = await makeCompany(tenantId, { currency: 'AED' });
        const c = await mkCustomer(co);
        const s = await sell(
          await mkOrder(co, c.customerId, one(10_000n)),
          { intent: 'ON_CREDIT' },
          at('2026-06-10'),
        );
        await postRaw(co, 'walk_in_sale', s.invoiceId, [
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 10_500n },
          { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 10_000n },
          { accountKey: 'LIABILITY.TAX_PAYABLE', direction: 'credit', amountMinor: 500n },
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'walkInOnCustomerInvoices');
      });

      it('an anonymous Payment that ALSO carries a customer receipt journal (it would be counted twice) → anonymousPaymentsWithReceiptJournal', async () => {
        const { co, paymentId } = await freshAnon();
        await postRaw(co, 'customer_receipt_payment', paymentId, [
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 10_500n },
          { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', direction: 'credit', amountMinor: 10_500n },
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'anonymousPaymentsWithReceiptJournal');
      });

      it('a Payment booked by BOTH streams in DIFFERENT periods is never counted twice in one report (stated boundary: it fails closed only when one report holds both)', async () => {
        const { co, paymentId } = await freshAnon(); // walk-in journal on 06-10
        await postRaw(co, 'customer_receipt_payment', paymentId, [
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 10_500n },
          { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', direction: 'credit', amountMinor: 10_500n },
        ]); // receipt journal on 06-11
        expect(
          (await companyReport(co, '2026-06-10', '2026-06-10')).receipts.receiptTotalMinor,
        ).toBe('10500');
        expect(
          (await companyReport(co, '2026-06-11', '2026-06-11')).receipts.receiptTotalMinor,
        ).toBe('10500');
        await expectIntegrity(companyReport(co, ...W6), 'anonymousPaymentsWithReceiptJournal');
      });

      it('a Payment on a DIFFERENT branch than its invoice → walkInPaymentBranchMismatches; the other branch stays healthy', async () => {
        const { co, paymentId } = await freshAnon();
        await corrupt(`UPDATE payment SET "branchId" = $2 WHERE id = $1`, [
          paymentId,
          co.siblingBranchId,
        ]);
        await expectIntegrity(
          branchReport(co, co.branchId, ...W6),
          'walkInPaymentBranchMismatches',
        );
        await expectIntegrity(companyReport(co, ...W6), 'walkInPaymentBranchMismatches');
        const healthy = await branchReport(co, co.siblingBranchId, ...W6);
        expect(healthy.receipts.receiptCount).toBe(0);
      });

      it('a walk-in journal line on a DIFFERENT branch than its invoice → branchMismatchLines', async () => {
        const { co, entryId } = await freshAnon();
        await corrupt(`UPDATE journal_line SET "branchId" = $2 WHERE "journalEntryId" = $1`, [
          entryId,
          co.siblingBranchId,
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'branchMismatchLines');
      });

      it('an ORPHAN walk-in journal (its sourceId names no invoice) → orphanWalkInJournals', async () => {
        const { co } = await freshAnon();
        await postRaw(co, 'walk_in_sale', randomUUID(), [
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 100n },
          { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 100n },
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'orphanWalkInJournals');
      });

      it('a journal, an invoice or a Payment in a foreign currency → REPORT_CURRENCY_MISMATCH', async () => {
        const a = await freshAnon();
        await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [a.entryId]);
        expect(await reject(companyReport(a.co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
          status: 409,
        });
        const b = await freshAnon();
        await corrupt(`UPDATE invoice SET "currencyCode" = 'KWD' WHERE id = $1`, [b.invoiceId]);
        expect(await reject(companyReport(b.co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
        const c = await freshAnon();
        await corrupt(`UPDATE payment SET "currencyCode" = 'KWD' WHERE id = $1`, [c.paymentId]);
        expect(await reject(companyReport(c.co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
      });

      it('an UNSEALED walk-in journal is invisible; a SECOND walk-in journal for one invoice cannot exist (unique index)', async () => {
        const a = await freshAnon();
        await corrupt(`UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1`, [a.entryId]);
        expect((await companyReport(a.co, ...W6)).receipts.receiptCount).toBe(0);
        const b = await freshAnon();
        await expect(
          corrupt(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
             SELECT uuidv7(),"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode",'dup' FROM journal_entry WHERE id = $1`,
            [b.entryId],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      });
    });

    // ── refunds ──
    describe('refund journals', () => {
      it('a refund journal one minor unit off the Refund → refundJournalMismatches', async () => {
        const { co, entryId } = await freshRefund();
        await corrupt(
          `UPDATE journal_line SET "creditMinor" = "creditMinor" + 1 WHERE "journalEntryId" = $1 AND "creditMinor" > 0`,
          [entryId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'refundJournalMismatches');
        await expectIntegrity(branchReport(co, co.branchId, ...W6), 'refundJournalMismatches');
      });

      it('an EXTRA balanced pair of lines on a refund journal (Dr bank 5 / Cr tax 5) → refundJournalMismatches', async () => {
        const { co, entryId } = await freshRefund();
        await addLinePair(co, entryId, 'ASSET.BANK', 'LIABILITY.TAX_PAYABLE');
        await expectIntegrity(companyReport(co, ...W6), 'refundJournalMismatches');
      });

      it('a CASH refund paid out of the BANK account → refundJournalMismatches', async () => {
        const { co, entryId } = await freshRefund();
        await corrupt(
          `UPDATE journal_line SET "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'ASSET.BANK')
            WHERE "journalEntryId" = $1 AND "creditMinor" > 0`,
          [entryId, co.companyId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'refundJournalMismatches');
      });

      it('a refund that debits the wrong liability → refundJournalMismatches', async () => {
        const { co, entryId } = await freshRefund();
        await corrupt(
          `UPDATE journal_line SET "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'LIABILITY.UNAPPLIED_RECEIPTS')
            WHERE "journalEntryId" = $1 AND "debitMinor" > 0`,
          [entryId, co.companyId],
        );
        await expectIntegrity(companyReport(co, ...W6), 'refundJournalMismatches');
      });

      it('a refund whose method has no frozen credit account (a local OTHER_MANUAL refund) → refundUnmappedMethods', async () => {
        const { co, refundId } = await freshRefund();
        await corrupt(`UPDATE refund SET method = 'OTHER_MANUAL' WHERE id = $1`, [refundId]);
        await expectIntegrity(companyReport(co, ...W6), 'refundUnmappedMethods');
      });

      it('a refund marked provider-finalised whose journal paid out of cash (the local posting) → refundJournalMismatches', async () => {
        const { co, refundId } = await freshRefund();
        await corrupt(`UPDATE refund SET "sourceRefundAttemptId" = uuidv7() WHERE id = $1`, [
          refundId,
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'refundJournalMismatches');
      });

      it('an ORPHAN refund journal (its sourceId names no Refund) → orphanRefundJournals', async () => {
        const { co } = await freshRefund();
        await postRaw(co, 'refund', randomUUID(), [
          { accountKey: 'LIABILITY.CUSTOMER_ADVANCES', direction: 'debit', amountMinor: 100n },
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'credit', amountMinor: 100n },
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'orphanRefundJournals');
      });

      it('a refund journal booked on a DIFFERENT branch than its Refund → branchMismatchLines', async () => {
        const { co, entryId } = await freshRefund();
        await corrupt(`UPDATE journal_line SET "branchId" = $2 WHERE "journalEntryId" = $1`, [
          entryId,
          co.siblingBranchId,
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'branchMismatchLines');
      });

      it('a journal or a Refund in a foreign currency → REPORT_CURRENCY_MISMATCH', async () => {
        const a = await freshRefund();
        await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [a.entryId]);
        expect(await reject(companyReport(a.co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
          status: 409,
        });
        const b = await freshRefund();
        await corrupt(`UPDATE refund SET "currencyCode" = 'KWD' WHERE id = $1`, [b.refundId]);
        expect(await reject(companyReport(b.co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
      });

      it('an UNSEALED refund journal is invisible; a SECOND refund journal for one Refund cannot exist (unique index)', async () => {
        const a = await freshRefund();
        await corrupt(`UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1`, [a.entryId]);
        expect((await companyReport(a.co, ...W6)).refunds.refundCount).toBe(0);
        const b = await freshRefund();
        await expect(
          corrupt(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
             SELECT uuidv7(),"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode",'dup' FROM journal_entry WHERE id = $1`,
            [b.entryId],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      });

      it('a Refund with NO journal is not provable by a journal-anchored period report (the stated boundary): it is never guessed into a figure', async () => {
        const { co, entryId } = await freshRefund();
        await corrupt(`DELETE FROM journal_line WHERE "journalEntryId" = $1`, [entryId]);
        await corrupt(`DELETE FROM journal_entry WHERE id = $1`, [entryId]);
        const r = await companyReport(co, ...W6);
        expect(r.refunds.refundCount).toBe(0);
        expect(await q(`SELECT 1 FROM refund WHERE "companyId" = $1`, [co.companyId])).toHaveLength(
          1,
        );
      });
    });

    // ── scope ──
    describe('scope of a defect', () => {
      it("a defect in ANOTHER branch never fails (or discloses itself in) a healthy branch's report — receipts and refunds alike", async () => {
        const co = await makeCompany(tenantId, { currency: 'AED' });
        const c = await mkCustomer(co);
        await sell(
          await mkOrder(co, null, one(10_000n)),
          { tenders: [cash(10_500n)] },
          at('2026-06-10'),
        );
        const rB = await receipt(
          co,
          co.siblingBranchId,
          c.customerId,
          'CASH',
          3_000n,
          at('2026-06-10'),
        );
        const healthy = await branchReport(co, co.branchId, ...W6);
        expect(healthy.receipts.receiptTotalMinor).toBe('10500');
        const entryB = await journalOf('customer_receipt_payment', rB.paymentId);
        await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [entryB]);
        // the healthy branch reads only ITS OWN movements …
        expect(await branchReport(co, co.branchId, ...W6)).toEqual(healthy);
        // … while the defective branch and the company (which contains it) fail closed
        expect(await reject(branchReport(co, co.siblingBranchId, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
        expect(await reject(companyReport(co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
      });

      it('an ORPHAN journal is unattributable to any branch: the company report fails closed, a branch report (which cannot own it) does not', async () => {
        const { co } = await freshReceipt();
        await postRaw(co, 'customer_receipt_payment', randomUUID(), [
          { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 100n },
          { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', direction: 'credit', amountMinor: 100n },
        ]);
        await expectIntegrity(companyReport(co, ...W6), 'orphanReceiptJournals');
        const branch = await branchReport(co, co.branchId, ...W6);
        expect(branch.receipts.receiptTotalMinor).toBe('3000'); // documented residual (plan §12, stated boundaries)
      });

      it('an allocated Payment with no receipt journal in ANOTHER branch fails that branch and the company, never a healthy branch (the detector is branch-scoped)', async () => {
        const co = await makeCompany(tenantId, { currency: 'AED' });
        const c = await mkCustomer(co);
        const sA = await sell(
          await mkOrder(co, c.customerId, one(10_000n)),
          { intent: 'ON_CREDIT' },
          at('2026-06-10'),
        );
        const sB = await sell(
          await mkOrder(co, c.customerId, one(5_000n), co.siblingBranchId),
          { intent: 'ON_CREDIT' },
          at('2026-06-10'),
        );
        await payInvoice(co, co.branchId, sA.invoiceId, [cash(10_500n)], at('2026-06-11'));
        await payInvoice(co, co.siblingBranchId, sB.invoiceId, [cash(5_250n)], at('2026-06-11'));
        setClock(DEFAULT_INSTANT);
        const healthy = await branchReport(co, co.branchId, ...W6);
        expect(healthy.receipts.receiptTotalMinor).toBe('10500');
        const entry = await journalOf(
          'customer_receipt_payment',
          await paymentOfInvoice(sB.invoiceId),
        );
        await corrupt('DELETE FROM journal_line WHERE "journalEntryId" = $1', [entry]);
        await corrupt('DELETE FROM journal_entry WHERE id = $1', [entry]);
        expect(await branchReport(co, co.branchId, ...W6)).toEqual(healthy);
        await expectIntegrity(
          branchReport(co, co.siblingBranchId, ...W6),
          'allocatedPaymentsWithoutReceiptJournal',
        );
        await expectIntegrity(companyReport(co, ...W6), 'allocatedPaymentsWithoutReceiptJournal');
      });

      it("a REFUND defect in ANOTHER branch never fails (or discloses itself in) a healthy branch's refund report", async () => {
        const co = await makeCompany(tenantId, { currency: 'AED' });
        const cA = await mkCustomer(co);
        const cB = await mkCustomer(co);
        const advA = await paidThenCancelledAdvance(
          co,
          co.branchId,
          cA,
          4_000n,
          500,
          card(4_200n),
          at('2026-06-10'),
          at('2026-06-11'),
        );
        const advB = await paidThenCancelledAdvance(
          co,
          co.siblingBranchId,
          cB,
          4_000n,
          500,
          card(4_200n),
          at('2026-06-10'),
          at('2026-06-11'),
        );
        await refund(co, co.branchId, advA.advanceId, 'CASH', 1_000n, at('2026-06-12'));
        const refundB = await refund(
          co,
          co.siblingBranchId,
          advB.advanceId,
          'CASH',
          500n,
          at('2026-06-12'),
        );
        const healthy = await branchReport(co, co.branchId, ...W6);
        expect(healthy.refunds.refundTotalMinor).toBe('1000');
        await corrupt('UPDATE journal_entry SET "currencyCode" = \'KWD\' WHERE id = $1', [
          await journalOf('refund', refundB),
        ]);
        // the healthy branch reads only ITS OWN refunds …
        expect(await branchReport(co, co.branchId, ...W6)).toEqual(healthy);
        // … while the defective branch and the company (which contains it) fail closed
        expect(await reject(branchReport(co, co.siblingBranchId, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
        expect(await reject(companyReport(co, ...W6))).toMatchObject({
          code: 'REPORT_CURRENCY_MISMATCH',
        });
      });
    });
  });

  // ═══════════════════ TT-1 — the density guard: 100 000 logical tender movements per COMPANY-WINDOW ═══════════════════
  describe('the density guard (owner ruling TT-1): at most TENDER_REPORT_MAX_MOVEMENTS logical tender movements per company-window evaluation', () => {
    /** a repository with another limit (the protected seam) — only tests pass one; production uses the constant */
    const limited = (n: number): TenderTotalsReportRepository =>
      new (class extends TenderTotalsReportRepository {
        protected override readonly maxMovements: number = n;
      })(db);
    const companyWith = (
      n: number,
      co: Co,
      from: string,
      to: string,
    ): Promise<TenderTotalsCompanyReport> =>
      inTenant(
        () => limited(n).getCompanyReportScoped({ companyId: co.companyId, from, to }),
        co.tenantId,
      );
    const branchWith = (
      n: number,
      co: Co,
      branchId: string,
      from: string,
      to: string,
    ): Promise<TenderTotalsBranchReport> =>
      inTenant(
        () => limited(n).getBranchReportScoped({ companyId: co.companyId, branchId, from, to }),
        co.tenantId,
      );
    /** the LOGICAL movements of a window, read from the model oracle: Payments + actual Refunds with a sealed journal in it */
    const movementsIn = async (
      co: Co,
      from: string,
      to: string,
      branchId: string | null = null,
    ): Promise<number> => {
      const m = await loadModel(co.companyId);
      const inScope = (d: { postingDate: string; branchId: string }): boolean =>
        d.postingDate >= from &&
        d.postingDate <= to &&
        (branchId === null || d.branchId === branchId);
      return m.receipts.filter(inScope).length + m.refunds.filter(inScope).length;
    };
    const TOO_LARGE = { code: 'REPORT_RESULT_TOO_LARGE', status: 422 };
    const W6 = ['2026-06-01', '2026-06-30'] as const;

    it('the limit is the one v1 constant, 100 000 — used by the production repository, never the Sales limits', async () => {
      expect(TENDER_REPORT_MAX_MOVEMENTS).toBe(100_000);
      class Peek extends TenderTotalsReportRepository {
        limit(): number {
          return this.maxMovements;
        }
      }
      expect(new Peek(db).limit()).toBe(TENDER_REPORT_MAX_MOVEMENTS);
      expect(TENDER_REPORT_MAX_MOVEMENTS).not.toBe(SALES_REPORT_MAX_DOCUMENTS);
    });

    it('EXACTLY the limit is accepted and one more is REPORT_RESULT_TOO_LARGE (422) — the company route, over every window of the real-document world', async () => {
      const windows: [string, string][] = [
        [...FULL],
        ['2026-06-10', '2026-06-10'],
        ['2026-06-12', '2026-06-18'],
        ['2026-06-20', '2026-06-28'],
        ['2026-07-01', '2026-07-31'],
      ];
      for (const [from, to] of windows) {
        const n = await movementsIn(aed, from, to);
        expect(n, `${from}..${to}`).toBeGreaterThan(0);
        const ok = await companyWith(n, aed, from, to);
        expect(figuresOf(ok), `${from}..${to} at the limit`).toEqual(
          figuresOf(await companyReport(aed, from, to)),
        );
        expect(
          await reject(companyWith(n - 1, aed, from, to)),
          `${from}..${to} one over`,
        ).toMatchObject(TOO_LARGE);
      }
    });

    it('the unit is the LOGICAL movement: an anonymous Multi Payment of N tenders is N movements although ONE walk_in_sale journal books it', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const s = await sell(
        await mkOrder(co, null, one(20_000n)),
        { tenders: [cash(8_000n), bank(7_000n), manual(6_000n)] }, // 21 000
        at('2026-06-10'),
      );
      setClock(DEFAULT_INSTANT);
      const journals = await q(
        `SELECT 1 FROM journal_entry WHERE "companyId" = $1 AND "sourceKind" IN ('walk_in_sale','customer_receipt_payment','refund')`,
        [co.companyId],
      );
      expect(journals).toHaveLength(1); // ONE journal …
      expect(
        (
          await q<{ n: number }>(
            'SELECT count(*)::int AS n FROM payment_allocation WHERE "invoiceId" = $1',
            [s.invoiceId],
          )
        )[0]!.n,
      ).toBe(3); // … THREE Payment rows
      expect(await movementsIn(co, ...W6)).toBe(3);
      expect((await companyWith(3, co, ...W6)).receipts.receiptCount).toBe(3); // accepted at exactly 3
      expect(await reject(companyWith(2, co, ...W6))).toMatchObject(TOO_LARGE); // 2 would be the journal-count + 1 reading
      // a second sale (2 tenders) and a customer receipt: 3 + 2 + 1 = 6, still logical
      await sell(
        await mkOrder(co, null, one(10_000n)),
        { tenders: [card(6_000n), manual(4_500n)] },
        at('2026-06-11'),
      );
      const c = await mkCustomer(co);
      await receipt(co, co.branchId, c.customerId, 'CASH', 1_000n, at('2026-06-12'));
      setClock(DEFAULT_INSTANT);
      expect(await movementsIn(co, ...W6)).toBe(6);
      expect((await companyWith(6, co, ...W6)).receipts.receiptCount).toBe(6);
      expect(await reject(companyWith(5, co, ...W6))).toMatchObject(TOO_LARGE);
    });

    it('an actual Refund is +1 movement; a pending / failed RefundAttempt, a CreditNote, a CustomerAdvance and a PaymentAllocation are +0', async () => {
      // aed2: two SUCCEEDED provider refunds (+2); a PENDING and a FAILED attempt exist (+0); the cancellation made a CreditNote + an advance (+0)
      const refunds = await companyWith(2, aed2, '2026-06-13', '2026-06-16');
      expect(refunds.refunds.refundCount).toBe(2);
      expect(await reject(companyWith(1, aed2, '2026-06-13', '2026-06-16'))).toMatchObject(
        TOO_LARGE,
      );
      // windows holding ONLY non-movements are 0 movements: the limit 0 still accepts them
      for (const [co, from, to] of [
        [aed2, '2026-06-13', '2026-06-14'], // the PENDING reservation and the FAILED attempt: no journal, no Refund
        [aed, '2026-06-23', '2026-06-23'], // the CreditNote + the CustomerAdvance it funded (a cancellation day)
      ] as const) {
        expect(await movementsIn(co, from, to), `${from}..${to}`).toBe(0);
        expect((await companyWith(0, co, from, to)).receipts.receiptCount).toBe(0);
      }
      // 06-17: ONE receipt (a partly applied Payment) with its payment_allocation journal on the same day → 1, not 2
      expect(
        (
          await q(
            `SELECT 1 FROM journal_entry WHERE "companyId" = $1 AND "sourceKind" = 'payment_allocation' AND "postingDate" = '2026-06-17'`,
            [aed.companyId],
          )
        ).length,
      ).toBe(1);
      expect(await movementsIn(aed, '2026-06-17', '2026-06-17')).toBe(1);
      expect((await companyWith(1, aed, '2026-06-17', '2026-06-17')).receipts.receiptCount).toBe(1);
      // 06-15: the advance conversion (customer_advance journal) + the straddling receipt → 1
      expect(await movementsIn(aed, '2026-06-15', '2026-06-15')).toBe(1);
      expect((await companyWith(1, aed, '2026-06-15', '2026-06-15')).receipts.receiptCount).toBe(1);
    });

    it('an allocation journal posted AFTER its receipt (a later period) is not a movement: the window holding only the allocation is 0 movements', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const c = await mkCustomer(co);
      const s = await sell(
        await mkOrder(co, c.customerId, one(10_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      const realPost = engine.postJournal.bind(engine);
      const spy = vi.spyOn(engine, 'postJournal').mockImplementation(async (tx, input) => {
        if (input.sourceKind === 'payment_allocation')
          setClock(new Date('2026-06-14T20:00:01.000Z'));
        return realPost(tx, input);
      });
      try {
        await payInvoice(
          co,
          co.branchId,
          s.invoiceId,
          [cash(10_500n)],
          new Date('2026-06-14T19:59:59.000Z'),
        );
      } finally {
        spy.mockRestore();
      }
      setClock(DEFAULT_INSTANT);
      expect(await movementsIn(co, '2026-06-15', '2026-06-15')).toBe(0);
      expect((await companyWith(0, co, '2026-06-15', '2026-06-15')).receipts.receiptCount).toBe(0);
      expect(await movementsIn(co, '2026-06-14', '2026-06-14')).toBe(1);
    });

    it('a BRANCH report is bounded by the COMPANY-window density: a small branch is rejected when the company window is too dense, and accepted when it is not', async () => {
      const company = await movementsIn(aed, ...FULL);
      const own = await movementsIn(aed, ...FULL, aed.siblingBranchId);
      expect(own).toBeGreaterThan(0);
      expect(own).toBeLessThan(company); // the requested branch is far smaller than the company
      // limit between the branch's own count and the company's: the branch itself fits, the company window does not
      expect(
        await reject(branchWith(company - 1, aed, aed.siblingBranchId, ...FULL)),
      ).toMatchObject(TOO_LARGE);
      expect(await reject(branchWith(own, aed, aed.siblingBranchId, ...FULL))).toMatchObject(
        TOO_LARGE,
      );
      // exactly the company's density: accepted, and equal to the unlimited branch report
      const ok = await branchWith(company, aed, aed.siblingBranchId, ...FULL);
      expect(figuresOf(ok)).toEqual(
        figuresOf(await branchReport(aed, aed.siblingBranchId, ...FULL)),
      );
      // the sibling branch is rejected by the same company density
      expect(await reject(branchWith(company - 1, aed, aed.branchId, ...FULL))).toMatchObject(
        TOO_LARGE,
      );
    });

    it('NON-DISCLOSURE: the rejection reveals only the generic code and the limit — never a count, a branch id, a sibling or a figure; both routes answer identically', async () => {
      const company = await movementsIn(aed, ...FULL);
      const own = await movementsIn(aed, ...FULL, aed.siblingBranchId);
      const limit = company - 1;
      const forCompany = await reject(companyWith(limit, aed, ...FULL));
      const forBranch = await reject(branchWith(limit, aed, aed.siblingBranchId, ...FULL));
      for (const err of [forCompany, forBranch]) {
        const wire = JSON.stringify({
          code: err.code,
          status: err.status,
          message: err.message,
          details: err.details,
        });
        expect(err).toMatchObject(TOO_LARGE);
        expect(wire).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no identifier
        expect(wire).not.toContain(aed.siblingBranchId);
        expect(wire).not.toContain(aed.branchId);
        // the only number on the wire is the limit; neither the company count nor the branch count appears
        const numbers = [...wire.matchAll(/\d+/g)]
          .map((m) => Number(m[0]))
          .filter((v) => v !== 422);
        expect(numbers.every((v) => v === limit)).toBe(true);
        expect(wire).not.toMatch(/\bsibling|\bbranch(es)?\b|\bcompany\b|minor|AED|[a-z]+Minor/i);
        expect(err.details).toEqual([
          { field: 'maxMovements', issue: String(limit) },
          { field: 'action', issue: 'narrow_date_range' },
        ]);
      }
      expect(forBranch.message).toBe(forCompany.message);
      expect(forBranch.details).toEqual(forCompany.details);
      expect(company).not.toBe(limit); // the real company count differs from the reported limit …
      expect(JSON.stringify(forBranch)).not.toContain(String(company)); // … and does not appear
      expect(own).toBeLessThan(limit);
    });

    it('there is NO calendar cap: a multi-year range with few movements is accepted, and the Sales REPORT_RANGE_TOO_LARGE rule never applies', async () => {
      const n = await movementsIn(aed, '2010-01-01', '2040-12-31');
      const r = await companyWith(n, aed, '2010-01-01', '2040-12-31'); // 31 years
      expect(r.receipts.receiptCount).toBe(20);
      expect(r.from).toBe('2010-01-01');
      expect(r.to).toBe('2040-12-31');
    });

    it('a missing company or a branch of ANOTHER company is a plain 404 — before the density is judged', async () => {
      for (const run of [
        () =>
          inTenant(() =>
            limited(0).getCompanyReportScoped({
              companyId: foreign.companyId,
              from: FULL[0],
              to: FULL[1],
            }),
          ),
        () =>
          inTenant(() =>
            limited(0).getCompanyReportScoped({
              companyId: randomUUID(),
              from: FULL[0],
              to: FULL[1],
            }),
          ),
        () => branchWith(0, aed, aed2.branchId, ...FULL),
        () => branchWith(0, aed, foreign.branchId, ...FULL),
      ]) {
        let err: unknown;
        try {
          await run();
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(NotFoundError);
      }
    });

    it('a rejected report is still ONE statement in ONE transaction, writes nothing, and returns no financial figure', async () => {
      const counting = (n: number) =>
        new (class extends TenderTotalsReportRepository {
          statements = 0;
          transactions = 0;
          protected override readonly maxMovements: number = n;
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
      const n = await movementsIn(aed, ...FULL);
      const count = async (): Promise<string> =>
        (
          await q<{ n: string }>(
            `SELECT (SELECT count(*) FROM audit_log) || '/' || (SELECT count(*) FROM outbox) || '/' || (SELECT count(*) FROM journal_entry) || '/' || (SELECT count(*) FROM idempotency_key) AS n`,
          )
        )[0]!.n;
      const before = await count();
      for (const [limit, accepted] of [
        [n, true],
        [n - 1, false],
      ] as const) {
        const r = counting(limit);
        const call = inTenant(() =>
          r.getCompanyReportScoped({ companyId: aed.companyId, from: FULL[0], to: FULL[1] }),
        );
        if (accepted) await call;
        else expect(await reject(call)).toMatchObject(TOO_LARGE);
        expect([r.statements, r.transactions]).toEqual([1, 1]);
      }
      const b = counting(n - 1);
      expect(
        await reject(
          inTenant(() =>
            b.getBranchReportScoped({
              companyId: aed.companyId,
              branchId: aed.branchId,
              from: FULL[0],
              to: FULL[1],
            }),
          ),
        ),
      ).toMatchObject(TOO_LARGE);
      expect([b.statements, b.transactions]).toEqual([1, 1]);
      expect(await count()).toBe(before);
    });

    it('the accepted report is unchanged by the guard: at the limit every figure equals the unguarded report, company and every byBranch row', async () => {
      const n = await movementsIn(aed, ...FULL);
      const guarded = await companyWith(n, aed, ...FULL);
      const plain = await companyReport(aed, ...FULL);
      expect(guarded).toEqual(plain);
      for (const row of plain.byBranch) {
        const own = await branchWith(n, aed, row.branchId, ...FULL);
        expect(figuresOf(own)).toEqual(figuresOf(row));
      }
    });
  });
});
