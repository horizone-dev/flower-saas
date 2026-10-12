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
import { PaymentAdvanceConversionRepository } from '../receivables/payment-advance-conversion.repository.js';
import {
  SalesFinancialReportRepository,
  type SalesFinancialBranchReport,
  type SalesFinancialCompanyReport,
} from './sales-financial-report.repository.js';
import { SalesFinancialReportService } from './sales-financial-report.service.js';
import { INVOICE_PAYMENT_STATUSES } from './sales-financial-report.js';
import {
  buildSalesFinancialReportQuery,
  type SalesFinancialReportJson,
} from './sales-financial-report.sql.js';
import { SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';

/**
 * Task 3b.10 Checkpoint B — the SALES FINANCIAL REPORT over REAL financial documents.
 *
 * Every document is created through the frozen public flows (`complete-sale`, order `cancel`,
 * invoice payment, customer receipt, advance refund) on the full `AppModule`, with the real role
 * grants, real PostgreSQL and real Redis, and a scripted clock — nothing is faked by writing a
 * journal date. The expected figures come from a MODEL ORACLE: every document is read back from its
 * own table, its posting date from its own journal, and the expectation is aggregated in plain
 * TypeScript — independent of the report's single SQL statement.
 */
const DEFAULT_INSTANT = new Date('2026-06-10T10:00:00.000Z'); // 14:00 in Dubai
const at = (isoDate: string, hourUtc = 10): Date =>
  new Date(`${isoDate}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`);

describe('Sales Financial Report — task 3b.10 Checkpoint B (real documents, real PostgreSQL)', () => {
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
  let repo: SalesFinancialReportRepository;
  let service: SalesFinancialReportService;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  /** product / variant per tenant (a variant belongs to ONE tenant) */
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
  let aed: Co; // the main company: two branches, the full document matrix
  let aed2: Co; // another company of the same tenant
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
    const s = baseSess(`r-${id}`);
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
  async function makeCompany(
    tid: Uuid,
    o: { currency: 'AED' | 'KWD'; tz?: string; countryCode?: string },
  ): Promise<Co> {
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
       VALUES ($1,$2,'Sales Report Co','AE',$3,$4,'ACTIVE',now())`,
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

  interface Discount {
    mode: 'AMOUNT' | 'PERCENT_BPS';
    bps?: number;
    amountMinor: bigint;
  }
  interface LineSpec {
    quantity?: string;
    unitPriceAmountMinor: bigint;
    discount?: Discount;
    rateBps: number | null;
  }
  interface OrderSpec {
    lines: LineSpec[];
    taxPriceMode?: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
    documentDiscount?: Discount;
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
    const d = spec.discount;
    const { productId, variantId } = catalogOf.get(co.tenantId)!;
    return {
      productId,
      variantId,
      quantity: spec.quantity ?? '1.0000',
      selectedUomCode: 'piece',
      baseUomCode: 'piece',
      conversionNumerator: '1',
      conversionDenominator: '1',
      unitPriceAmountMinor: spec.unitPriceAmountMinor.toString(),
      unitPriceCurrencyCode: co.currency,
      unitPriceCurrencyExponent: co.exponent,
      discountMode: d ? d.mode : 'NONE',
      discountBps: d?.mode === 'PERCENT_BPS' ? (d.bps ?? null) : null,
      discountAmountMinor: (d?.amountMinor ?? 0n).toString(),
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
    const taxPriceMode = spec.taxPriceMode ?? 'TAX_EXCLUSIVE';
    const dd = spec.documentDiscount;
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
        documentDiscountMode: dd ? dd.mode : 'NONE',
        documentDiscountBps: dd?.mode === 'PERCENT_BPS' ? (dd.bps ?? null) : null,
        documentDiscountAmountMinor: (dd?.amountMinor ?? 0n).toString(),
        documentDiscountReason: dd ? 'promo' : null,
      },
      { taxPriceMode, taxRoundingScope: 'LINE', taxRoundingMode: 'HALF_UP' },
    );
    const orderId = randomUUID();
    const { productId, variantId } = catalogOf.get(co.tenantId)!;
    await pool.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor",
          "documentDiscountReason","commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT',$6,$7,$8,$9,$10,$11,$12,2,$13,'LINE','HALF_UP',now())`,
      [
        orderId,
        co.tenantId,
        co.companyId,
        branchId,
        customerId,
        co.currency,
        co.exponent,
        dd ? dd.mode : 'NONE',
        dd?.mode === 'PERCENT_BPS' ? (dd.bps ?? null) : null,
        (dd?.amountMinor ?? 0n).toString(),
        dd ? 'promo' : null,
        fingerprint,
        taxPriceMode,
      ],
    );
    for (const [i, l] of spec.lines.entries()) {
      const d = l.discount;
      await pool.query(
        `INSERT INTO order_line
           (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
            "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
            "discountMode","discountBps","discountAmountMinor",
            "taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
            "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
            "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot",
            "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 CASE WHEN $16::int IS NULL THEN NULL ELSE '2020-01-01'::date END,$17,
                 'piece','Piece','piece',1,1,'Rose','Rose',now())`,
        [
          randomUUID(),
          co.tenantId,
          co.companyId,
          orderId,
          i + 1,
          productId,
          variantId,
          l.quantity ?? '1.0000',
          l.unitPriceAmountMinor.toString(),
          co.currency,
          co.exponent,
          d ? d.mode : 'NONE',
          d?.mode === 'PERCENT_BPS' ? (d.bps ?? null) : null,
          (d?.amountMinor ?? 0n).toString(),
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

  const cash = (n: bigint) => ({ method: 'CASH', amountMinor: n.toString() });
  const bank = (n: bigint) => ({ method: 'BANK_TRANSFER', amountMinor: n.toString() });
  const manual = (n: bigint) => ({ method: 'OTHER_MANUAL', amountMinor: n.toString() });

  /** complete a sale at `when` (the scripted clock); returns the made order + its invoice id */
  async function sell(
    o: MadeOrder,
    payload: { intent?: 'PAY_NOW' | 'ON_CREDIT'; tenders?: unknown[] },
    when: Date,
  ): Promise<{ order: MadeOrder; invoiceId: string }> {
    setClock(when);
    const res = await post(
      o.co.tenantId === tenantId ? tok['owner']! : tok['foreignOwner']!,
      orderUrl(o, '/complete-sale'),
      {
        paymentIntent: payload.intent ?? 'PAY_NOW',
        ...(payload.tenders !== undefined ? { tenders: payload.tenders } : {}),
      },
      { 'idempotency-key': ik(), 'if-match': String(o.version) },
    );
    expect(res.statusCode, res.payload).toBe(200);
    return { order: o, invoiceId: (res.json() as { invoice: { id: string } }).invoice.id };
  }

  /** cancel an order at `when`; the order's current version is read first */
  async function cancel(
    o: MadeOrder,
    when: Date,
    body: Record<string, unknown> = { reason: 'report fixture' },
  ) {
    setClock(when);
    const v = (
      await q<{ version: number }>(`SELECT version FROM "order" WHERE id = $1`, [o.orderId])
    )[0]!.version;
    const res = await post(tok['owner']!, orderUrl(o, '/cancel'), body, { 'if-match': String(v) });
    expect(res.statusCode, res.payload).toBe(200);
  }

  // ── the model oracle: every document read back from ITS OWN table and journal ──────────────
  interface ModelDoc {
    kind: 'INV' | 'CN' | 'CC';
    id: string;
    branchId: string;
    postingDate: string;
    subtotal: bigint;
    lineDiscount: bigint;
    docDiscount: bigint;
    tax: bigint;
    total: bigint;
    net: bigint;
    status: string | null;
  }
  async function loadModel(companyId: string): Promise<ModelDoc[]> {
    const invs = await q<Record<string, string>>(
      `SELECT i.id, i."branchId", i."subtotalAmountMinor"::text AS subtotal, i."documentDiscountAmountMinor"::text AS dd,
              i."taxTotalAmountMinor"::text AS tax, i."totalAmountMinor"::text AS total, i."invoicePaymentStatus" AS status,
              (SELECT COALESCE(SUM(ol."discountAmountMinor"), 0)::text FROM order_line ol WHERE ol."orderId" = i."orderId") AS ld,
              (SELECT je."postingDate"::text FROM journal_entry je
                WHERE je."companyId" = i."companyId" AND je."sourceId" = i.id::text
                  AND je."sourceKind" IN ('invoice_ar','walk_in_sale')) AS pd
         FROM invoice i WHERE i."companyId" = $1`,
      [companyId],
    );
    const cns = await q<Record<string, string>>(
      `SELECT c.id, c."branchId", c."taxTotalAmountMinor"::text AS tax, c."totalAmountMinor"::text AS total,
              (SELECT je."postingDate"::text FROM journal_entry je
                WHERE je."companyId" = c."companyId" AND je."sourceId" = c.id::text AND je."sourceKind" = 'credit_note') AS pd
         FROM credit_note c WHERE c."companyId" = $1`,
      [companyId],
    );
    const ccs = await q<Record<string, string>>(
      `SELECT x.id, x."branchId", x."netAmountMinor"::text AS net, x."taxAmountMinor"::text AS tax, x."totalAmountMinor"::text AS total,
              (SELECT je."postingDate"::text FROM journal_entry je
                WHERE je."companyId" = x."companyId" AND je."sourceId" = x.id::text AND je."sourceKind" = 'cancellation_charge') AS pd
         FROM cancellation_charge x WHERE x."companyId" = $1`,
      [companyId],
    );
    const out: ModelDoc[] = [];
    for (const r of invs) {
      out.push({
        kind: 'INV',
        id: r['id']!,
        branchId: r['branchId']!,
        postingDate: r['pd']!,
        subtotal: BigInt(r['subtotal']!),
        lineDiscount: BigInt(r['ld']!),
        docDiscount: BigInt(r['dd']!),
        tax: BigInt(r['tax']!),
        total: BigInt(r['total']!),
        net: BigInt(r['total']!) - BigInt(r['tax']!),
        status: r['status']!,
      });
    }
    for (const r of cns) {
      out.push({
        kind: 'CN',
        id: r['id']!,
        branchId: r['branchId']!,
        postingDate: r['pd']!,
        subtotal: 0n,
        lineDiscount: 0n,
        docDiscount: 0n,
        tax: BigInt(r['tax']!),
        total: BigInt(r['total']!),
        net: BigInt(r['total']!) - BigInt(r['tax']!),
        status: null,
      });
    }
    for (const r of ccs) {
      out.push({
        kind: 'CC',
        id: r['id']!,
        branchId: r['branchId']!,
        postingDate: r['pd']!,
        subtotal: 0n,
        lineDiscount: 0n,
        docDiscount: 0n,
        tax: BigInt(r['tax']!),
        total: BigInt(r['total']!),
        net: BigInt(r['net']!),
        status: null,
      });
    }
    return out;
  }

  /** the figures a report MUST show, aggregated in plain TypeScript from the model */
  function expectedFigures(model: ModelDoc[], from: string, to: string, branchId: string | null) {
    const inScope = model.filter(
      (d) =>
        d.postingDate >= from &&
        d.postingDate <= to &&
        (branchId === null || d.branchId === branchId),
    );
    const sum = (kind: ModelDoc['kind'], f: (d: ModelDoc) => bigint): bigint =>
      inScope.filter((d) => d.kind === kind).reduce((n, d) => n + f(d), 0n);
    const count = (kind: ModelDoc['kind']): number => inScope.filter((d) => d.kind === kind).length;
    const invTotal = sum('INV', (d) => d.total);
    const invTax = sum('INV', (d) => d.tax);
    const cnTotal = sum('CN', (d) => d.total);
    const cnTax = sum('CN', (d) => d.tax);
    const status: Record<string, { count: number; total: bigint }> = Object.fromEntries(
      INVOICE_PAYMENT_STATUSES.map((s) => [s, { count: 0, total: 0n }]),
    );
    for (const d of inScope.filter((x) => x.kind === 'INV')) {
      status[d.status!]!.count += 1;
      status[d.status!]!.total += d.total;
    }
    return {
      invoices: {
        invoiceCount: count('INV'),
        invoicedSubtotalMinor: sum('INV', (d) => d.subtotal).toString(),
        lineDiscountMinor: sum('INV', (d) => d.lineDiscount).toString(),
        documentDiscountMinor: sum('INV', (d) => d.docDiscount).toString(),
        outputTaxMinor: invTax.toString(),
        invoicedTotalMinor: invTotal.toString(),
        salesNetExTaxMinor: (invTotal - invTax).toString(),
      },
      creditNotes: {
        creditNoteCount: count('CN'),
        creditNoteNetExTaxMinor: (cnTotal - cnTax).toString(),
        creditNoteTaxMinor: cnTax.toString(),
        creditNoteTotalMinor: cnTotal.toString(),
      },
      netSalesAfterCreditNotes: {
        netSalesAfterCreditNotesExTaxMinor: (invTotal - invTax - (cnTotal - cnTax)).toString(),
        netSalesAfterCreditNotesTaxMinor: (invTax - cnTax).toString(),
        netSalesAfterCreditNotesTotalMinor: (invTotal - cnTotal).toString(),
      },
      cancellationCharges: {
        cancellationChargeCount: count('CC'),
        cancellationChargeNetExTaxMinor: sum('CC', (d) => d.net).toString(),
        cancellationChargeTaxMinor: sum('CC', (d) => d.tax).toString(),
        cancellationChargeTotalMinor: sum('CC', (d) => d.total).toString(),
      },
      statuses: INVOICE_PAYMENT_STATUSES.map((s) => ({
        status: s,
        count: status[s]!.count,
        invoiceTotalMinor: status[s]!.total.toString(),
      })),
    };
  }
  const figuresOf = (r: {
    invoices: unknown;
    creditNotes: unknown;
    netSalesAfterCreditNotes: unknown;
    cancellationCharges: unknown;
    currentPaymentStatusBreakdown: { statuses: unknown };
  }) => ({
    invoices: r.invoices,
    creditNotes: r.creditNotes,
    netSalesAfterCreditNotes: r.netSalesAfterCreditNotes,
    cancellationCharges: r.cancellationCharges,
    statuses: r.currentPaymentStatusBreakdown.statuses,
  });

  // ── the report under test, through the real scoped path ─────────────────────────
  const inTenant = <T>(fn: () => Promise<T>, t = tenantId): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId: t }), fn);
  const companyReport = (co: Co, from: string, to: string): Promise<SalesFinancialCompanyReport> =>
    inTenant(() => service.companyReport({ companyId: co.companyId, from, to }), co.tenantId);
  const branchReport = (
    co: Co,
    branchId: string,
    from: string,
    to: string,
  ): Promise<SalesFinancialBranchReport> =>
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

  // ── the shared document world (company `aed`) ───────────────────────────────────
  const W: Record<string, { order: MadeOrder; invoiceId: string }> = {};

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url, max: 6 });

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `srep-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [id, `srep-${id.slice(0, 8)}`, planVersionId],
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
    // the fiscal policy a CancellationCharge is resolved against (country policy + the company's
    // charge tax category and its rate) — the same reference data the 3b.8 charge tests use
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
    engine = app.get(PostingEngineService);
    accounts = app.get(AccountRepository);
    periods = app.get(AccountingPeriodRepository);
    conversion = app.get(PaymentAdvanceConversionRepository);
    repo = new SalesFinancialReportRepository(db);
    service = new SalesFinancialReportService(repo);

    aed = await makeCompany(tenantId, { currency: 'AED' });
    aed2 = await makeCompany(tenantId, { currency: 'AED' });
    kwd = await makeCompany(tenantId, { currency: 'KWD', tz: 'Asia/Kuwait' });
    // the foreign tenant has its own product (same slug is per-tenant)
    foreign = await makeCompany(otherTenantId, { currency: 'AED' });
    await pool.query(
      `UPDATE company SET "cancellationFeeTaxCategoryKey" = 'STD3B3' WHERE id = ANY($1)`,
      [[aed.companyId, aed2.companyId, kwd.companyId]],
    );

    // the REAL default role grants — an Owner with a fresh step-up drives sales, cancellations, refunds
    tok['owner'] = await mint('owner', rolePerms('owner'), { stepUp: true });
    tok['foreignOwner'] = await mint('foreign-owner', rolePerms('owner'), {
      tenant: otherTenantId,
      stepUp: true,
    });

    // ───────────────────── THE WORLD: documents through the frozen flows ─────────────────────
    const A = aed.branchId;
    const B = aed.siblingBranchId;
    const cust = await mkCustomer(aed);
    const cust2 = await mkCustomer(aed);

    // 06-10 · branch A · anonymous CASH · tax-exclusive · line AMOUNT discount 1 000 (SETTLED)
    W['anonCash'] = await sell(
      await mkOrder(aed, null, {
        lines: [
          {
            unitPriceAmountMinor: 10_000n,
            rateBps: 500,
            discount: { mode: 'AMOUNT', amountMinor: 1_000n },
          },
        ],
      }),
      { tenders: [cash(9_450n)] },
      at('2026-06-10'),
    );
    // 06-10 · branch A · customer PAY_NOW Multi Payment · line 10 % + document AMOUNT 500 (SETTLED)
    W['custMulti'] = await sell(
      await mkOrder(aed, cust.customerId, {
        lines: [
          {
            unitPriceAmountMinor: 20_000n,
            rateBps: 500,
            discount: { mode: 'PERCENT_BPS', bps: 1000, amountMinor: 2_000n },
          },
        ],
        documentDiscount: { mode: 'AMOUNT', amountMinor: 500n },
      }),
      { tenders: [cash(9_000n), bank(9_375n)] }, // total = (18 000 − 500) × 1.05 = 18 375
      at('2026-06-10'),
    );
    // 06-12 · branch B · customer ON_CREDIT, no tender (UNPAID) · will get a full CreditNote
    W['custCredit'] = await sell(
      await mkOrder(aed, cust.customerId, one(5_000n), B),
      { intent: 'ON_CREDIT' },
      at('2026-06-12'),
    );
    // 06-12 · branch B · customer ON_CREDIT with a partial cash tender (PARTIAL) · cancelled with a charge
    W['custPartial'] = await sell(
      await mkOrder(aed, cust2.customerId, one(8_000n), B),
      { intent: 'ON_CREDIT', tenders: [cash(3_000n)] },
      at('2026-06-12'),
    );
    // 06-15 · branch A · customer PAY_NOW by OTHER_MANUAL · TAX-INCLUSIVE (PAID — never SETTLED)
    W['custManualInclusive'] = await sell(
      await mkOrder(aed, cust.customerId, {
        lines: [{ unitPriceAmountMinor: 10_500n, rateBps: 500 }],
        taxPriceMode: 'TAX_INCLUSIVE',
      }),
      { tenders: [manual(10_500n)] },
      at('2026-06-15'),
    );
    // 06-16 · branch A · anonymous OTHER_MANUAL · zero-tax line (PAID)
    W['anonManualZeroTax'] = await sell(
      await mkOrder(aed, null, one(2_000n, null)),
      { tenders: [manual(2_000n)] },
      at('2026-06-16'),
    );
    // 06-17 · branch A · customer PAY_NOW cash · document PERCENT 10 % on top of a line AMOUNT discount (SETTLED)
    W['custDocPercent'] = await sell(
      await mkOrder(aed, cust2.customerId, {
        lines: [
          {
            unitPriceAmountMinor: 12_000n,
            rateBps: 500,
            discount: { mode: 'AMOUNT', amountMinor: 2_000n },
          },
        ],
        documentDiscount: { mode: 'PERCENT_BPS', bps: 1000, amountMinor: 1_000n },
      }),
      { tenders: [cash(9_450n)] }, // (10 000 − 1 000) × 1.05 = 9 450
      at('2026-06-17'),
    );
    // 06-18 · branch A · customer ON_CREDIT (UNPAID) · will be PAID in JULY (status changes AFTER the period)
    W['custLatePay'] = await sell(
      await mkOrder(aed, cust.customerId, one(6_000n)),
      { intent: 'ON_CREDIT' },
      at('2026-06-18'),
    );
    // 06-19 · branch A · customer ON_CREDIT with a partial cash tender that STAYS partial (PARTIAL)
    W['custStillPartial'] = await sell(
      await mkOrder(aed, cust.customerId, one(7_000n)),
      { intent: 'ON_CREDIT', tenders: [cash(2_000n)] },
      at('2026-06-19'),
    );
    // 06-14 23:59:59 local (19:59:59Z) · branch A · customer ON_CREDIT · the POSTING crosses midnight into 06-15
    {
      const o = await mkOrder(aed, cust2.customerId, one(4_000n));
      setClock(new Date('2026-06-14T19:59:59.000Z'));
      const realPost = engine.postJournal.bind(engine);
      const spy = vi.spyOn(engine, 'postJournal').mockImplementation(async (tx, input) => {
        if (input.sourceKind === 'invoice_ar') setClock(new Date('2026-06-14T20:00:01.000Z')); // 00:00:01 on 06-15
        return realPost(tx, input);
      });
      try {
        W['straddle'] = await sell(
          o,
          { intent: 'ON_CREDIT' },
          new Date('2026-06-14T19:59:59.000Z'),
        );
      } finally {
        spy.mockRestore();
      }
    }

    // CreditNote · full cancellation of the UNPAID taxed invoice → CN total = invoice total (06-20)
    await cancel(W['custCredit']!.order, at('2026-06-20'));
    // CreditNote with an EXCESS advance: the PAID (OTHER_MANUAL) inclusive invoice (06-22)
    await cancel(W['custManualInclusive']!.order, at('2026-06-22'));
    // CreditNote + CancellationCharge (explicit accounting date 07-05, in another month than the clock)
    await cancel(W['custPartial']!.order, at('2026-06-25'), {
      reason: 'customer left',
      cancellationCharge: {
        requestedAmountMinor: '800',
        reasonCode: 'CUSTOMER_REQUEST',
        accountingDate: '2026-07-05',
      },
    });
    // a pre-invoice cancelled order — no financial document at all
    {
      const draft = await mkOrder(aed, cust.customerId, one(3_000n));
      await cancel(draft, at('2026-06-26'));
      W['preInvoiceCancelled'] = { order: draft, invoiceId: '' };
    }
    // a valid REFUND of the CN-funded advance (06-28) — Tender reporting's concern, never Sales'
    {
      const adv = await q<{ id: string }>(
        `SELECT ca.id FROM customer_advance ca
           JOIN credit_note_coverage_release r ON r."customerAdvanceId" = ca.id
          WHERE r."creditNoteId" = (SELECT cn.id FROM credit_note cn JOIN invoice i ON i.id = cn."invoiceId" WHERE i."orderId" = $1)`,
        [W['custManualInclusive']!.order.orderId],
      );
      W['advance'] = { order: W['custManualInclusive']!.order, invoiceId: adv[0]!.id };
    }
    // July: the late payment on the 06-18 invoice
    setClock(at('2026-07-10'));
    const late = await post(
      tok['owner']!,
      `/v1/companies/${aed.companyId}/branches/${A}/invoices/${W['custLatePay']!.invoiceId}/payments`,
      { amountMinor: '6300', tenders: [{ method: 'CASH', amountMinor: '6300' }] },
      { 'idempotency-key': ik() },
    );
    expect(late.statusCode, late.payload).toBe(201);
    setClock(DEFAULT_INSTANT);
  }, 600_000);

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

  const FULL = ['2026-06-01', '2026-08-29'] as const; // 90 days inclusive — the Sales cap; every world document is inside it

  // ═══════════════════ the financial figures, hand-anchored ═══════════════════
  describe('the figures', () => {
    it('anonymous CASH sale with a line discount: the invoice figures are exactly the stored ones', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-10', '2026-06-10');
      // anonCash 9 450 (subtotal 9 000 after the 1 000 line discount, tax 450) + custMulti
      const inv = (
        await q<Record<string, string>>(
          `SELECT "subtotalAmountMinor"::text s, "taxTotalAmountMinor"::text t, "totalAmountMinor"::text a FROM invoice WHERE id = $1`,
          [W['anonCash']!.invoiceId],
        )
      )[0]!;
      expect(inv).toEqual({ s: '9000', t: '450', a: '9450' });
      expect(r.invoices.invoiceCount).toBe(2);
      expect(r.invoices.lineDiscountMinor).toBe('3000'); // 1 000 (AMOUNT) + 2 000 (10 % → stored 2 000)
      expect(r.invoices.documentDiscountMinor).toBe('500');
    });

    it('a 10 % line discount, a fixed document discount and their combination: the STORED outputs are reported, kept apart', async () => {
      const r = await branchReport(aed, aed.branchId, '2026-06-17', '2026-06-17'); // custDocPercent only
      expect(r.invoices).toMatchObject({
        invoiceCount: 1,
        lineDiscountMinor: '2000', // AMOUNT line discount
        documentDiscountMinor: '1000', // PERCENT_BPS document discount (stored amount)
        invoicedTotalMinor: '9450',
        outputTaxMinor: '450',
        salesNetExTaxMinor: '9000',
      });
      const multi = await branchReport(aed, aed.branchId, '2026-06-10', '2026-06-10');
      expect(Number(BigInt(multi.invoices.documentDiscountMinor))).toBe(500);
    });

    it('tax-exclusive, tax-inclusive and zero-tax invoices: net ex-tax is total − tax in every mode', async () => {
      const model = await loadModel(aed.companyId);
      for (const key of ['anonCash', 'custManualInclusive', 'anonManualZeroTax']) {
        const d = model.find((m) => m.id === W[key]!.invoiceId)!;
        const r = await branchReport(aed, d.branchId, d.postingDate, d.postingDate);
        const mine = model.filter(
          (m) => m.kind === 'INV' && m.postingDate === d.postingDate && m.branchId === d.branchId,
        );
        expect(r.invoices.salesNetExTaxMinor).toBe(
          mine.reduce((n, m) => n + (m.total - m.tax), 0n).toString(),
        );
      }
      const zero = model.find((m) => m.id === W['anonManualZeroTax']!.invoiceId)!;
      expect(zero.tax).toBe(0n);
      const inclusive = model.find((m) => m.id === W['custManualInclusive']!.invoiceId)!;
      expect(inclusive.total).toBe(10_500n);
      expect(inclusive.tax).toBe(500n); // extracted from the inclusive price
      expect(inclusive.total - inclusive.tax).toBe(10_000n);
    });

    it('the full CreditNote shows separately and never mutates the invoice figures; the net-after-credit-notes is explicit', async () => {
      const r = await branchReport(aed, aed.siblingBranchId, '2026-06-12', '2026-07-31');
      const cn = (
        await q<Record<string, string>>(
          `SELECT "totalAmountMinor"::text a, "taxTotalAmountMinor"::text t FROM credit_note WHERE "invoiceId" = $1`,
          [W['custCredit']!.invoiceId],
        )
      )[0]!;
      expect(cn).toEqual({ a: '5250', t: '250' });
      // branch B: custCredit (5 250) + custPartial (8 400) invoiced; two CNs
      expect(r.invoices.invoicedTotalMinor).toBe('13650');
      expect(r.creditNotes.creditNoteCount).toBe(2);
      // the invoices are untouched by the credit notes
      expect(r.invoices.invoiceCount).toBe(2);
      expect(r.netSalesAfterCreditNotes.netSalesAfterCreditNotesTotalMinor).toBe(
        (
          BigInt(r.invoices.invoicedTotalMinor) - BigInt(r.creditNotes.creditNoteTotalMinor)
        ).toString(),
      );
      expect(r.netSalesAfterCreditNotes.netSalesAfterCreditNotesExTaxMinor).toBe(
        (
          BigInt(r.invoices.salesNetExTaxMinor) - BigInt(r.creditNotes.creditNoteNetExTaxMinor)
        ).toString(),
      );
      expect(r.netSalesAfterCreditNotes.netSalesAfterCreditNotesTaxMinor).toBe(
        (BigInt(r.invoices.outputTaxMinor) - BigInt(r.creditNotes.creditNoteTaxMinor)).toString(),
      );
    });

    it('a CreditNote whose excess becomes a CustomerAdvance counts as a credit note ONLY — the advance is no sales figure', async () => {
      const cn = (
        await q<Record<string, string>>(
          `SELECT "totalAmountMinor"::text a, "arReductionMinor"::text ar, "advanceExcessMinor"::text ex FROM credit_note WHERE "invoiceId" = $1`,
          [W['custManualInclusive']!.invoiceId],
        )
      )[0]!;
      expect(cn).toEqual({ a: '10500', ar: '0', ex: '10500' }); // the whole amount became an advance
      const june = await branchReport(aed, aed.branchId, '2026-06-22', '2026-06-22');
      expect(june.creditNotes).toMatchObject({
        creditNoteCount: 1,
        creditNoteTotalMinor: '10500',
        creditNoteTaxMinor: '500',
        creditNoteNetExTaxMinor: '10000',
      });
      // no field anywhere carries the advance
      expect(JSON.stringify(june)).not.toMatch(/advance/i);
    });

    it('a CancellationCharge is its own block: not in invoiced sales, not in the net after credit notes', async () => {
      const r = await branchReport(aed, aed.siblingBranchId, '2026-07-05', '2026-07-05');
      const cc = (
        await q<Record<string, string>>(
          `SELECT "netAmountMinor"::text n, "taxAmountMinor"::text t, "totalAmountMinor"::text a FROM cancellation_charge WHERE "companyId" = $1`,
          [aed.companyId],
        )
      )[0]!;
      expect(r.cancellationCharges).toEqual({
        cancellationChargeCount: 1,
        cancellationChargeNetExTaxMinor: cc['n'],
        cancellationChargeTaxMinor: cc['t'],
        cancellationChargeTotalMinor: cc['a'],
      });
      expect(r.invoices.invoiceCount).toBe(0);
      expect(r.invoices.invoicedTotalMinor).toBe('0');
      expect(BigInt(r.netSalesAfterCreditNotes.netSalesAfterCreditNotesTotalMinor)).toBe(
        -BigInt(r.creditNotes.creditNoteTotalMinor),
      );
    });

    it('a pre-invoice cancelled order produces NO financial row', async () => {
      const orderRow = await q<{ status: string }>(`SELECT status FROM "order" WHERE id = $1`, [
        W['preInvoiceCancelled']!.order.orderId,
      ]);
      expect(orderRow[0]!.status).toBe('CANCELLED');
      expect(
        await q(`SELECT 1 FROM invoice WHERE "orderId" = $1`, [
          W['preInvoiceCancelled']!.order.orderId,
        ]),
      ).toHaveLength(0);
      const r = await branchReport(aed, aed.branchId, '2026-06-26', '2026-06-26');
      expect(r.invoices.invoiceCount).toBe(0);
      expect(r.creditNotes.creditNoteCount).toBe(0);
      expect(r.cancellationCharges.cancellationChargeCount).toBe(0);
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
    ];
    it('company, branch A and branch B all match', async () => {
      const model = await loadModel(aed.companyId);
      expect(model.filter((m) => m.kind === 'INV').length).toBeGreaterThanOrEqual(9);
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
  });

  // ═══════════════════ branch / company / byBranch / isolation ═══════════════════
  describe('branch, company and byBranch', () => {
    it('Branch A and Branch B report only their own documents; the company is exactly A + B', async () => {
      const a = await branchReport(aed, aed.branchId, ...FULL);
      const b = await branchReport(aed, aed.siblingBranchId, ...FULL);
      const c = await companyReport(aed, ...FULL);
      expect(a.invoices.invoiceCount).toBeGreaterThan(0);
      expect(b.invoices.invoiceCount).toBeGreaterThan(0);
      for (const f of [
        'invoicedTotalMinor',
        'outputTaxMinor',
        'lineDiscountMinor',
        'documentDiscountMinor',
        'invoicedSubtotalMinor',
        'salesNetExTaxMinor',
      ] as const) {
        expect(BigInt(c.invoices[f]), f).toBe(BigInt(a.invoices[f]) + BigInt(b.invoices[f]));
      }
      expect(c.invoices.invoiceCount).toBe(a.invoices.invoiceCount + b.invoices.invoiceCount);
      expect(c.creditNotes.creditNoteCount).toBe(
        a.creditNotes.creditNoteCount + b.creditNotes.creditNoteCount,
      );
      expect(BigInt(c.creditNotes.creditNoteTotalMinor)).toBe(
        BigInt(a.creditNotes.creditNoteTotalMinor) + BigInt(b.creditNotes.creditNoteTotalMinor),
      );
    });

    it("every byBranch row EQUALS that branch's own report (including the reconciliation block)", async () => {
      const c = await companyReport(aed, ...FULL);
      expect(c.byBranch.map((r) => r.branchId).sort()).toEqual(
        [aed.branchId, aed.siblingBranchId].sort(),
      );
      for (const row of c.byBranch) {
        const own = await branchReport(aed, row.branchId, ...FULL);
        const { branchId, ...blocks } = row;
        expect(branchId).toBe(row.branchId);
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
        void [_c, _cc, _ce, _t, _f, _to, _b];
        expect(blocks).toEqual(ownBlocks);
      }
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
      expect(c.currentPaymentStatusBreakdown.note).toBe(
        'Payment status is current at report read time; period membership is based on accounting postingDate.',
      );
    });

    it('another company of the same tenant and a foreign tenant NEVER appear', async () => {
      const mine = await companyReport(aed, ...FULL);
      // give the other company and the foreign tenant their own sales
      await sell(
        await mkOrder(aed2, null, one(7_777n)),
        { tenders: [cash(8_166n)] },
        at('2026-06-10'),
      ); // 7 777 + 5 % = 8 166
      await sell(
        await mkOrder(foreign, null, one(1_234n)),
        { tenders: [cash(1_296n)] },
        at('2026-06-10'),
      ); // 1 234 + 5 % = 1 296 (rounded)
      const after = await companyReport(aed, ...FULL);
      expect(figuresOf(after)).toEqual(figuresOf(mine));
      const aed2Report = await companyReport(aed2, ...FULL);
      expect(aed2Report.invoices.invoiceCount).toBe(1);
      expect(aed2Report.byBranch).toHaveLength(1);
      expect(aed2Report.byBranch[0]!.branchId).toBe(aed2.branchId);
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
      // the foreign tenant sees ONLY its own company's sale (1 296), never ours
      const own = await companyReport(foreign, ...FULL);
      expect(own.invoices.invoiceCount).toBe(1);
      expect(own.invoices.invoicedTotalMinor).toBe('1296');
    });
  });

  // ═══════════════════ period membership = the JOURNAL's posting date ═══════════════════
  describe('postingDate controls inclusion — never the document date', () => {
    it('the Invoice: the 00:00:01 posting of a 23:59:59 invoice is on 06-15, and the report follows the journal', async () => {
      const inv = (
        await q<Record<string, string>>(
          `SELECT "invoiceDate"::text AS d, "issuedAt"::text AS issued FROM invoice WHERE id = $1`,
          [W['straddle']!.invoiceId],
        )
      )[0]!;
      const pd = (
        await q<Record<string, string>>(
          `SELECT "postingDate"::text AS d FROM journal_entry WHERE "sourceKind" = 'invoice_ar' AND "sourceId" = $1`,
          [W['straddle']!.invoiceId],
        )
      )[0]!;
      expect(inv['d']).toBe('2026-06-14'); // the document's date
      expect(pd['d']).toBe('2026-06-15'); // the journal's date — they genuinely differ
      // document date INSIDE the window, posting OUTSIDE → excluded
      const onDocDate = await branchReport(aed, aed.branchId, '2026-06-14', '2026-06-14');
      expect(onDocDate.invoices.invoiceCount).toBe(0);
      // document date OUTSIDE, posting INSIDE → included
      const onPosting = await branchReport(aed, aed.branchId, '2026-06-15', '2026-06-15');
      expect(onPosting.invoices.invoiceCount).toBe(2); // the straddle invoice + custManualInclusive (06-15)
      expect(onPosting.invoices.invoicedTotalMinor).toBe('14700'); // 4 200 + 10 500
    });

    it("each document's own boundary: before from, on from, inside, on to, after to", async () => {
      // the 06-10 postings (anonCash + custMulti) — branch A
      const probe = async (from: string, to: string) =>
        (await branchReport(aed, aed.branchId, from, to)).invoices.invoiceCount;
      expect(await probe('2026-06-11', '2026-06-11')).toBe(0); // posting BEFORE from … (06-10 < 06-11)
      expect(await probe('2026-06-10', '2026-06-10')).toBe(2); // on from AND on to
      expect(await probe('2026-06-09', '2026-06-11')).toBe(2); // inside
      expect(await probe('2026-06-09', '2026-06-09')).toBe(0); // AFTER to
      expect(await probe('2026-06-10', '2026-06-12')).toBe(2); // on from
      expect(await probe('2026-06-01', '2026-06-10')).toBe(2); // on to
    });

    it('the CreditNote: its own issuedAt (the wall clock) is irrelevant — only its journal date counts', async () => {
      const cn = (
        await q<Record<string, string>>(
          `SELECT "accountingDate"::text AS ad, "issuedAt"::text AS issued,
                (SELECT je."postingDate"::text FROM journal_entry je WHERE je."sourceKind" = 'credit_note' AND je."sourceId" = c.id::text) AS pd
           FROM credit_note c WHERE c."invoiceId" = $1`,
          [W['custCredit']!.invoiceId],
        )
      )[0]!;
      expect(cn['pd']).toBe(cn['ad']);
      expect(cn['pd']).toBe('2026-06-20');
      const issuedDate = cn['issued']!.slice(0, 10); // the real wall-clock day the fixture ran
      expect(issuedDate).not.toBe('2026-06-20');
      // document date (issuedAt) INSIDE the window, posting outside → excluded
      const lo = new Date(`${issuedDate}T00:00:00Z`);
      const from = new Date(lo.getTime() - 86_400_000).toISOString().slice(0, 10);
      const to = new Date(lo.getTime() + 86_400_000).toISOString().slice(0, 10);
      expect(
        (await branchReport(aed, aed.siblingBranchId, from, to)).creditNotes.creditNoteCount,
      ).toBe(0);
      // document date OUTSIDE, posting INSIDE → included
      expect(
        (await branchReport(aed, aed.siblingBranchId, '2026-06-20', '2026-06-20')).creditNotes
          .creditNoteCount,
      ).toBe(1);
    });

    it('the CancellationCharge: an explicit accounting date in another month than its creation decides', async () => {
      const cc = (
        await q<Record<string, string>>(
          `SELECT "accountingDate"::text AS ad, "createdAt"::text AS created,
                (SELECT je."postingDate"::text FROM journal_entry je WHERE je."sourceKind" = 'cancellation_charge' AND je."sourceId" = x.id::text) AS pd
           FROM cancellation_charge x WHERE x."companyId" = $1`,
          [aed.companyId],
        )
      )[0]!;
      expect(cc['pd']).toBe('2026-07-05');
      expect(cc['ad']).toBe('2026-07-05');
      const createdDate = cc['created']!.slice(0, 10);
      expect(createdDate).not.toBe('2026-07-05');
      const lo = new Date(`${createdDate}T00:00:00Z`);
      const from = new Date(lo.getTime() - 86_400_000).toISOString().slice(0, 10);
      const to = new Date(lo.getTime() + 86_400_000).toISOString().slice(0, 10);
      expect(
        (await branchReport(aed, aed.siblingBranchId, from, to)).cancellationCharges
          .cancellationChargeCount,
      ).toBe(0);
      const onPosting = await branchReport(aed, aed.siblingBranchId, '2026-07-05', '2026-07-05');
      expect(onPosting.cancellationCharges.cancellationChargeCount).toBe(1);
      expect(
        (await branchReport(aed, aed.siblingBranchId, '2026-07-04', '2026-07-04'))
          .cancellationCharges.cancellationChargeCount,
      ).toBe(0);
      expect(
        (await branchReport(aed, aed.siblingBranchId, '2026-07-06', '2026-07-06'))
          .cancellationCharges.cancellationChargeCount,
      ).toBe(0);
    });
  });

  // ═══════════════════ the CURRENT payment status ═══════════════════
  describe('currentPaymentStatusBreakdown', () => {
    it('covers UNPAID, PARTIAL, PAID and SETTLED (and the rest of the frozen vocabulary); PAID is never SETTLED', async () => {
      const all = await companyReport(aed, ...FULL);
      const by = Object.fromEntries(
        all.currentPaymentStatusBreakdown.statuses.map((s) => [s.status, s.count]),
      );
      expect(Object.keys(by)).toEqual([...INVOICE_PAYMENT_STATUSES]);
      // SETTLED: cash/bank sales (anonCash, custMulti, custDocPercent) + the late cash payment
      expect(by['SETTLED']).toBeGreaterThanOrEqual(3);
      // PAID: the OTHER_MANUAL anonymous sale (never settlement-final)
      expect(by['PAID']).toBeGreaterThanOrEqual(1);
      expect(by['UNPAID']).toBeGreaterThanOrEqual(1); // the straddle invoice
      expect(by['PARTIAL']).toBeGreaterThanOrEqual(1); // the partially paid invoice that stays partial
      // the CANCELLED / REFUNDED / PARTIALLY_REFUNDED states exist after the cancellations
      expect(by['CANCELLED']! + by['REFUNDED']! + by['PARTIALLY_REFUNDED']!).toBeGreaterThanOrEqual(
        3,
      );
      const manualAnon = (
        await q<{ s: string }>(`SELECT "invoicePaymentStatus" s FROM invoice WHERE id = $1`, [
          W['anonManualZeroTax']!.invoiceId,
        ])
      )[0]!;
      const cashAnon = (
        await q<{ s: string }>(`SELECT "invoicePaymentStatus" s FROM invoice WHERE id = $1`, [
          W['anonCash']!.invoiceId,
        ])
      )[0]!;
      expect(manualAnon.s).toBe('PAID');
      expect(cashAnon.s).toBe('SETTLED');
      expect(manualAnon.s).not.toBe(cashAnon.s);
      // the amounts per status add up to the invoiced total
      expect(
        all.currentPaymentStatusBreakdown.statuses.reduce(
          (n, s) => n + BigInt(s.invoiceTotalMinor),
          0n,
        ),
      ).toBe(BigInt(all.invoices.invoicedTotalMinor));
    });

    it('a payment AFTER the sale period changes the CURRENT status but not the period: the sale stays in June', async () => {
      const id = W['custLatePay']!.invoiceId;
      const row = (
        await q<{ s: string; pd: string }>(
          `SELECT i."invoicePaymentStatus" s, (SELECT je."postingDate"::text FROM journal_entry je WHERE je."sourceId" = i.id::text AND je."sourceKind" = 'invoice_ar') pd FROM invoice i WHERE i.id = $1`,
          [id],
        )
      )[0]!;
      expect(row.pd).toBe('2026-06-18'); // sold in June
      expect(row.s).toBe('SETTLED'); // paid in July (cash)
      const june = await branchReport(aed, aed.branchId, '2026-06-18', '2026-06-18');
      expect(june.invoices.invoiceCount).toBe(1);
      expect(june.invoices.invoicedTotalMinor).toBe('6300');
      const status = Object.fromEntries(
        june.currentPaymentStatusBreakdown.statuses.map((s) => [s.status, s.count]),
      );
      expect(status['SETTLED']).toBe(1); // CURRENT state, not the state "as of" 06-18
      expect(status['UNPAID']).toBe(0);
      // July holds no sale — the July payment is not a sale
      const july = await branchReport(aed, aed.branchId, '2026-07-01', '2026-07-31');
      expect(july.invoices.invoiceCount).toBe(0);
    });
  });

  // ═══════════════════ what is NOT sales ═══════════════════
  describe('refund, advance, payment and unrelated journals are not sales', () => {
    it('a valid REFUND leaves every Sales figure unchanged (refund belongs to Tender reporting)', async () => {
      const before = await companyReport(aed, ...FULL);
      const advanceId = W['advance']!.invoiceId;
      const cust = (
        await q<{ customerId: string }>(
          `SELECT cca."customerId" FROM customer_advance ca JOIN customer_company_account cca ON cca.id = ca."customerCompanyAccountId" WHERE ca.id = $1`,
          [advanceId],
        )
      )[0]!;
      setClock(at('2026-06-28'));
      const refund = await post(
        tok['owner']!,
        `/v1/companies/${aed.companyId}/branches/${aed.branchId}/customers/${cust.customerId}/advances/${advanceId}/refunds`,
        { requestedAmountMinor: '10500', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
        { 'idempotency-key': ik() },
      );
      setClock(DEFAULT_INSTANT);
      expect(refund.statusCode, refund.payload).toBe(201);
      const refunds = await q(`SELECT 1 FROM refund WHERE "companyId" = $1`, [aed.companyId]);
      expect(refunds).toHaveLength(1);
      const after = await companyReport(aed, ...FULL);
      expect(after).toEqual(before);
    });

    it('a standalone CustomerAdvance is not sales', async () => {
      const before = await companyReport(aed, ...FULL);
      const c = await mkCustomer(aed);
      const attemptId = randomUUID();
      await pool.query(
        `INSERT INTO payment_attempt (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","updatedAt")
         VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',4000,'AED',2,'CAPTURED',$6,now())`,
        [attemptId, tenantId, aed.companyId, aed.branchId, c.ccaId, `idem-${attemptId}`],
      );
      const paymentId = randomUUID();
      await pool.query(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'CASH',4000,'AED',2)`,
        [paymentId, tenantId, aed.companyId, aed.branchId, attemptId],
      );
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        conversion.convertInTx(tx, {
          tenantId,
          companyId: aed.companyId,
          branchId: aed.branchId,
          customerId: c.customerId,
          paymentId,
          amountMinor: 4_000n,
          actorUserId: null,
        }),
      );
      setClock(DEFAULT_INSTANT);
      expect(
        await q(`SELECT 1 FROM customer_advance WHERE "customerCompanyAccountId" = $1`, [c.ccaId]),
      ).toHaveLength(1);
      const after = await companyReport(aed, ...FULL);
      expect(after).toEqual(before);
    });

    it('an unrelated / unknown-kind journal that credits REVENUE.SALES never participates', async () => {
      const before = await companyReport(aed, ...FULL);
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: aed.companyId,
          sourceKind: 'manual_revenue_adjustment_ZZ',
          sourceId: randomUUID(),
          branchId: aed.branchId,
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 999_999n },
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 999_999n },
          ],
        }),
      );
      setClock(DEFAULT_INSTANT);
      const after = await companyReport(aed, ...FULL);
      expect(after).toEqual(before); // not sales, and it does not disturb the reconciliation either
      expect(after.reconciliation.reconciled).toBe(true);
    });
  });

  // ═══════════════════ the reconciliation to the GL ═══════════════════
  describe('source ↔ GL reconciliation', () => {
    it('every control is zero-difference and reconciled — company and each branch — for all three document sets', async () => {
      const c = await companyReport(aed, ...FULL);
      const scopes = [c, ...c.byBranch];
      for (const s of scopes) {
        expect(s.reconciliation.reconciled).toBe(true);
        for (const ctl of [
          s.reconciliation.invoices.salesRevenue,
          s.reconciliation.invoices.outputTax,
          s.reconciliation.creditNotes.revenueReversal,
          s.reconciliation.creditNotes.outputTaxReversal,
          s.reconciliation.cancellationCharges.revenue,
          s.reconciliation.cancellationCharges.outputTax,
        ]) {
          expect(ctl.differenceMinor).toBe('0');
          expect(ctl.reconciled).toBe(true);
          expect(ctl.sourceMinor).toBe(ctl.glMinor);
        }
      }
      // and the controls carry real, non-zero money for this world
      expect(c.reconciliation.invoices.salesRevenue.sourceMinor).toBe(
        c.invoices.salesNetExTaxMinor,
      );
      expect(BigInt(c.reconciliation.creditNotes.revenueReversal.glMinor)).toBeGreaterThan(0n);
      expect(BigInt(c.reconciliation.cancellationCharges.revenue.glMinor)).toBeGreaterThan(0n);
    });
  });

  // ═══════════════════ the KWD (3-decimal) company ═══════════════════
  describe('KWD (exponent 3)', () => {
    it('reports exact 3-decimal minor units with the exponent', async () => {
      const c = await mkCustomer(kwd);
      const anon = await sell(
        await mkOrder(kwd, null, one(10_000n)),
        { tenders: [cash(10_500n)] },
        at('2026-06-10'),
      );
      const cred = await sell(
        await mkOrder(kwd, c.customerId, one(2_500n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-11'),
      );
      void anon;
      await cancel(cred.order, at('2026-06-12'));
      const r = await companyReport(kwd, '2026-06-01', '2026-06-30');
      expect(r.currencyCode).toBe('KWD');
      expect(r.currencyExponent).toBe(3);
      expect(r.accountingTimezone).toBe('Asia/Kuwait');
      expect(r.invoices.invoiceCount).toBe(2);
      expect(r.invoices.invoicedTotalMinor).toBe('13125'); // 10 500 + 2 625
      expect(r.invoices.outputTaxMinor).toBe('625'); // 500 + 125
      expect(r.invoices.salesNetExTaxMinor).toBe('12500');
      expect(r.creditNotes).toMatchObject({
        creditNoteCount: 1,
        creditNoteTotalMinor: '2625',
        creditNoteTaxMinor: '125',
      });
      expect(r.netSalesAfterCreditNotes.netSalesAfterCreditNotesTotalMinor).toBe('10500');
      const model = await loadModel(kwd.companyId);
      expect(figuresOf(r)).toEqual(expectedFigures(model, '2026-06-01', '2026-06-30', null));
    });
  });

  // ═══════════════════ the request itself ═══════════════════
  describe('input and read-only behaviour', () => {
    it('invalid dates never reach the database; both bounds are required', async () => {
      const bad = (from: unknown, to: unknown) =>
        reject(inTenant(() => service.companyReport({ companyId: aed.companyId, from, to })));
      expect(await bad('2026-06-01T00:00:00Z', '2026-06-30')).toMatchObject({
        code: 'INVALID_DATE',
        status: 400,
      });
      expect(await bad('2026-06-30', '2026-06-01')).toMatchObject({ code: 'INVALID_DATE_RANGE' });
      expect(await bad(undefined, '2026-06-30')).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await bad('2026-06-01', undefined)).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('reading a report writes nothing: ledger, documents, audit and outbox are byte-for-byte unchanged', async () => {
      const snap = async () =>
        (
          await q(
            `SELECT (SELECT count(*) FROM journal_entry)::int AS je, (SELECT count(*) FROM journal_line)::int AS jl,
                  (SELECT count(*) FROM invoice)::int AS inv, (SELECT count(*) FROM credit_note)::int AS cn,
                  (SELECT count(*) FROM cancellation_charge)::int AS cc, (SELECT count(*) FROM audit_log)::int AS al,
                  (SELECT count(*) FROM outbox)::int AS ob, (SELECT count(*) FROM idempotency_key)::int AS ik`,
          )
        )[0];
      const before = await snap();
      await companyReport(aed, ...FULL);
      await branchReport(aed, aed.branchId, ...FULL);
      expect(await snap()).toEqual(before);
    });

    it('a company without an accounting timezone / currency fails closed', async () => {
      const bare = randomUUID();
      await pool.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
         VALUES ($1,$2,'Bare','AE',NULL,'Asia/Dubai','ACTIVE',now())`,
        [bare, tenantId],
      );
      const err = await reject(
        inTenant(() => service.companyReport({ companyId: bare, from: FULL[0], to: FULL[1] })),
      );
      expect(err).toMatchObject({ code: 'REPORT_COMPANY_NOT_CONFIGURED', status: 409 });
    });
  });

  // ═══════════════════ malformed financial data FAILS CLOSED ═══════════════════
  describe('a malformed authoritative journal fails the report closed (never repaired)', () => {
    /** a fresh company with ONE anonymous sale, so each corruption stands alone */
    async function freshSale(): Promise<{ co: Co; invoiceId: string; entryId: string }> {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const s = await sell(
        await mkOrder(co, null, one(10_000n)),
        { tenders: [cash(10_500n)] },
        at('2026-06-10'),
      );
      const entry = (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = 'walk_in_sale' AND "sourceId" = $1`,
          [s.invoiceId],
        )
      )[0]!;
      // the clean report works first
      const ok = await companyReport(co, '2026-06-01', '2026-06-30');
      expect(ok.reconciliation.reconciled).toBe(true);
      return { co, invoiceId: s.invoiceId, entryId: entry.id };
    }
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
    const W6 = ['2026-06-01', '2026-06-30'] as const;

    it('REVENUE disagreement: the journal credits one minor unit more than the invoice states → REPORT_SALES_GL_MISMATCH', async () => {
      const { co, entryId } = await freshSale();
      await corrupt(
        `UPDATE journal_line SET "creditMinor" = "creditMinor" + 1
          WHERE "journalEntryId" = $1 AND "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'REVENUE.SALES')`,
        [entryId, co.companyId],
      );
      expect(await reject(companyReport(co, ...W6))).toMatchObject({
        code: 'REPORT_SALES_GL_MISMATCH',
        status: 500,
      });
      expect(await reject(branchReport(co, co.branchId, ...W6))).toMatchObject({
        code: 'REPORT_SALES_GL_MISMATCH',
      });
    });

    it('TAX disagreement → REPORT_SALES_GL_MISMATCH', async () => {
      const { co, entryId } = await freshSale();
      await corrupt(
        `UPDATE journal_line SET "creditMinor" = "creditMinor" - 1
          WHERE "journalEntryId" = $1 AND "accountId" = (SELECT id FROM account WHERE "companyId" = $2 AND key = 'LIABILITY.TAX_PAYABLE')`,
        [entryId, co.companyId],
      );
      expect(await reject(companyReport(co, ...W6))).toMatchObject({
        code: 'REPORT_SALES_GL_MISMATCH',
      });
    });

    it('an ORPHAN journal (its sourceId names no document) → REPORT_SALES_SOURCE_INTEGRITY, non-disclosing', async () => {
      const { co } = await freshSale();
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: co.companyId,
          sourceKind: 'walk_in_sale',
          sourceId: randomUUID(),
          branchId: co.branchId,
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 100n },
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 100n },
          ],
        }),
      );
      setClock(DEFAULT_INSTANT);
      const err = await reject(companyReport(co, ...W6));
      expect(err).toMatchObject({ code: 'REPORT_SALES_SOURCE_INTEGRITY', status: 500 });
      expect(err.message).toContain('orphanJournals');
      expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no identifier is disclosed
    });

    it('a sourceId that is not even a uuid is an orphan, not a SQL cast error', async () => {
      const { co } = await freshSale();
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: co.companyId,
          sourceKind: 'credit_note',
          sourceId: 'not-a-uuid-at-all',
          branchId: co.branchId,
          lines: [
            { accountKey: 'REVENUE.SALES', direction: 'debit', amountMinor: 100n },
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'credit', amountMinor: 100n },
          ],
        }),
      );
      setClock(DEFAULT_INSTANT);
      expect(await reject(companyReport(co, ...W6))).toMatchObject({
        code: 'REPORT_SALES_SOURCE_INTEGRITY',
      });
    });

    it('a DUPLICATE authoritative revenue journal for one invoice → REPORT_SALES_SOURCE_INTEGRITY', async () => {
      const { co, invoiceId } = await freshSale();
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: co.companyId,
          sourceKind: 'invoice_ar', // the OTHER revenue kind for the same anonymous invoice
          sourceId: invoiceId,
          branchId: co.branchId,
          lines: [
            { accountKey: 'ASSET.ACCOUNTS_RECEIVABLE', direction: 'debit', amountMinor: 10_500n },
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 10_000n },
            { accountKey: 'LIABILITY.TAX_PAYABLE', direction: 'credit', amountMinor: 500n },
          ],
        }),
      );
      setClock(DEFAULT_INSTANT);
      const err = await reject(companyReport(co, ...W6));
      expect(err.code).toBe('REPORT_SALES_SOURCE_INTEGRITY');
      expect(err.message).toContain('duplicateRevenueJournals');
    });

    it('the journal booked on a DIFFERENT branch than its invoice → REPORT_SALES_SOURCE_INTEGRITY', async () => {
      const { co, entryId } = await freshSale();
      await corrupt(`UPDATE journal_line SET "branchId" = $2 WHERE "journalEntryId" = $1`, [
        entryId,
        co.siblingBranchId,
      ]);
      const err = await reject(companyReport(co, ...W6));
      expect(err.code).toBe('REPORT_SALES_SOURCE_INTEGRITY');
      expect(err.message).toContain('branchMismatchLines');
    });

    it('a journal in a foreign currency → REPORT_CURRENCY_MISMATCH (409), never converted', async () => {
      const { co, entryId } = await freshSale();
      await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [entryId]);
      expect(await reject(companyReport(co, ...W6))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
        status: 409,
      });
    });

    it('an invoice in a foreign currency → REPORT_CURRENCY_MISMATCH', async () => {
      const { co, invoiceId } = await freshSale();
      await corrupt(`UPDATE invoice SET "currencyCode" = 'KWD' WHERE id = $1`, [invoiceId]);
      expect(await reject(companyReport(co, ...W6))).toMatchObject({
        code: 'REPORT_CURRENCY_MISMATCH',
      });
    });

    it('an anonymous-kind journal on an invoice that HAS a customer receivable (wrong revenue kind) → integrity failure', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const c = await mkCustomer(co);
      const s = await sell(
        await mkOrder(co, c.customerId, one(10_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      expect((await companyReport(co, ...W6)).invoices.invoiceCount).toBe(1);
      await corrupt(
        `UPDATE journal_entry SET "sourceKind" = 'walk_in_sale' WHERE "sourceKind" = 'invoice_ar' AND "sourceId" = $1`,
        [s.invoiceId],
      );
      const err = await reject(companyReport(co, ...W6));
      expect(err.code).toBe('REPORT_SALES_SOURCE_INTEGRITY');
      expect(err.message).toContain('revenueKindMismatches');
    });

    it('a CreditNote whose invoice has NO revenue journal → integrity failure (the document lacks its required journal)', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const c = await mkCustomer(co);
      const s = await sell(
        await mkOrder(co, c.customerId, one(10_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      await cancel(s.order, at('2026-06-12'));
      expect(
        (await companyReport(co, '2026-06-12', '2026-06-12')).creditNotes.creditNoteCount,
      ).toBe(1);
      const entry = (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = 'invoice_ar' AND "sourceId" = $1`,
          [s.invoiceId],
        )
      )[0]!;
      await corrupt(`DELETE FROM journal_line WHERE "journalEntryId" = $1`, [entry.id]);
      await corrupt(`DELETE FROM journal_entry WHERE id = $1`, [entry.id]);
      const err = await reject(companyReport(co, '2026-06-12', '2026-06-12'));
      expect(err.code).toBe('REPORT_SALES_SOURCE_INTEGRITY');
      expect(err.message).toContain('creditNotesWithoutRevenueJournal');
    });

    it('an UNSEALED sales journal is never authoritative: it is invisible (and cannot mask a missing sealed one)', async () => {
      const { co, entryId } = await freshSale();
      await corrupt(`UPDATE journal_entry SET "sealedAt" = NULL WHERE id = $1`, [entryId]);
      const r = await companyReport(co, ...W6);
      expect(r.invoices.invoiceCount).toBe(0); // the only journal is unsealed → no authoritative journal
      expect(r.byBranch).toEqual([]);
    });

    it('an UNSEALED second revenue journal is NOT a duplicate: only SEALED journals are authoritative', async () => {
      const { co, invoiceId } = await freshSale();
      const clean = await companyReport(co, ...W6);
      setClock(at('2026-06-11'));
      await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: co.companyId,
          sourceKind: 'invoice_ar', // the OTHER revenue kind for the same anonymous invoice …
          sourceId: invoiceId,
          branchId: co.branchId,
          lines: [
            { accountKey: 'ASSET.ACCOUNTS_RECEIVABLE', direction: 'debit', amountMinor: 10_500n },
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 10_000n },
            { accountKey: 'LIABILITY.TAX_PAYABLE', direction: 'credit', amountMinor: 500n },
          ],
        }),
      );
      setClock(DEFAULT_INSTANT);
      // … but never sealed, so it is invisible to the report and cannot make the invoice a "duplicate"
      await corrupt(
        `UPDATE journal_entry SET "sealedAt" = NULL WHERE "sourceKind" = 'invoice_ar' AND "sourceId" = $1`,
        [invoiceId],
      );
      expect(await companyReport(co, ...W6)).toEqual(clean);
    });

    it('a CreditNote whose invoice journal is UNSEALED has no AUTHORITATIVE revenue journal → integrity failure', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const c = await mkCustomer(co);
      const s = await sell(
        await mkOrder(co, c.customerId, one(10_000n)),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      await cancel(s.order, at('2026-06-12'));
      expect(
        (await companyReport(co, '2026-06-12', '2026-06-12')).creditNotes.creditNoteCount,
      ).toBe(1);
      await corrupt(
        `UPDATE journal_entry SET "sealedAt" = NULL WHERE "sourceKind" = 'invoice_ar' AND "sourceId" = $1`,
        [s.invoiceId],
      );
      const err = await reject(companyReport(co, '2026-06-12', '2026-06-12'));
      expect(err.code).toBe('REPORT_SALES_SOURCE_INTEGRITY');
      expect(err.message).toContain('creditNotesWithoutRevenueJournal');
    });

    it("a defect in ANOTHER branch never fails (or discloses itself in) a healthy branch's report", async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      await sell(
        await mkOrder(co, null, one(10_000n)),
        { tenders: [cash(10_500n)] },
        at('2026-06-10'),
      );
      const sB = await sell(
        await mkOrder(co, null, one(20_000n), co.siblingBranchId),
        { tenders: [cash(21_000n)] },
        at('2026-06-10'),
      );
      const healthy = await branchReport(co, co.branchId, ...W6);
      expect(healthy.invoices.invoiceCount).toBe(1);
      const entryB = (
        await q<{ id: string }>(
          `SELECT id FROM journal_entry WHERE "sourceKind" = 'walk_in_sale' AND "sourceId" = $1`,
          [sB.invoiceId],
        )
      )[0]!;
      await corrupt(`UPDATE journal_entry SET "currencyCode" = 'KWD' WHERE id = $1`, [entryB.id]);
      // the healthy branch reads only ITS OWN documents: the other branch's defect is invisible to it …
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

  // ═══════════════ owner correction 2 — the Sales period cap: 90 calendar days, inclusive ═══════════════
  describe('the Sales period cap (90 calendar days, both bounds inclusive)', () => {
    const OVER = ['2026-06-01', '2026-08-30'] as const; // 91 dates

    it('a 90-day period reports; a 91-day period is rejected by the service AND by the repository', async () => {
      expect((await companyReport(aed, ...FULL)).invoices.invoiceCount).toBeGreaterThan(0);
      expect((await branchReport(aed, aed.branchId, ...FULL)).branchId).toBe(aed.branchId);

      expect(await reject(companyReport(aed, ...OVER))).toMatchObject({
        code: 'REPORT_RANGE_TOO_LARGE',
        status: 400,
      });
      expect(await reject(branchReport(aed, aed.branchId, ...OVER))).toMatchObject({
        code: 'REPORT_RANGE_TOO_LARGE',
      });
      // the repository — the only door to the database — enforces it on its own (no caller can bypass the service)
      expect(
        await reject(
          inTenant(() =>
            repo.getCompanyReportScoped({ companyId: aed.companyId, from: OVER[0], to: OVER[1] }),
          ),
        ),
      ).toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE' });
      expect(
        await reject(
          inTenant(() =>
            repo.getBranchReportScoped({
              companyId: aed.companyId,
              branchId: aed.branchId,
              from: OVER[0],
              to: OVER[1],
            }),
          ),
        ),
      ).toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE' });
    });

    it('the rule is checked BEFORE the database: even an unknown company gets the cap error, not a 404', async () => {
      const err = await reject(
        inTenant(() =>
          service.companyReport({ companyId: randomUUID(), from: OVER[0], to: OVER[1] }),
        ),
      );
      expect(err.code).toBe('REPORT_RANGE_TOO_LARGE');
    });

    it('a rejected period reads and writes nothing', async () => {
      const count = async (): Promise<string> =>
        (
          await q<{ n: string }>(
            'SELECT (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM outbox) + (SELECT count(*) FROM journal_entry) AS n',
          )
        )[0]!.n;
      const before = await count();
      await reject(companyReport(aed, '2026-01-01', '2026-12-31'));
      expect(await count()).toBe(before);
    });
  });

  // ═══════════════ owner correction 1 — the line discount has an IMMUTABLE authority ═══════════════
  describe('the line discount is proven by the order snapshot fingerprint (a tampered line set fails the report closed)', () => {
    const JUNE = ['2026-06-01', '2026-06-30'] as const;

    interface DiscountSale {
      co: Co;
      orderId: string;
      invoiceId: string;
      lineIds: string[];
      expectedLineDiscount: string;
    }
    /** a fresh company with ONE issued anonymous sale carrying line discounts — each tamper stands alone */
    async function discountSale(twoLines = false): Promise<DiscountSale> {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const lines: LineSpec[] = twoLines
        ? [
            {
              unitPriceAmountMinor: 10_000n,
              rateBps: 500,
              discount: { mode: 'AMOUNT', amountMinor: 1_000n },
            },
            {
              unitPriceAmountMinor: 4_000n,
              rateBps: 500,
              discount: { mode: 'AMOUNT', amountMinor: 400n },
            },
          ]
        : [
            {
              unitPriceAmountMinor: 10_000n,
              rateBps: 500,
              discount: { mode: 'AMOUNT', amountMinor: 1_000n },
            },
          ];
      const order = await mkOrder(co, null, { lines });
      const s = await sell(
        order,
        { tenders: [cash(twoLines ? 13_230n : 9_450n)] },
        at('2026-06-10'),
      );
      const lineIds = (
        await q<{ id: string }>(
          'SELECT id FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"',
          [order.orderId],
        )
      ).map((r) => r.id);
      const clean = await companyReport(co, ...JUNE);
      expect(clean.invoices.invoiceCount).toBe(1);
      expect(clean.reconciliation.reconciled).toBe(true);
      return {
        co,
        orderId: order.orderId,
        invoiceId: s.invoiceId,
        lineIds,
        expectedLineDiscount: clean.invoices.lineDiscountMinor,
      };
    }
    const EXPECTED = { one: '1000', two: '1400' } as const;

    /** run SQL with triggers OFF (neither the application nor the database path can write these states) */
    async function tamper(sql: string, params: unknown[] = []): Promise<void> {
      const c = await pool.connect();
      try {
        await c.query("SET session_replication_role = 'replica'");
        await c.query(sql, params);
        await c.query("SET session_replication_role = 'origin'");
      } finally {
        c.release();
      }
    }
    /** an INSERT of an extra line into the ISSUED order — the one mutation the database permits */
    async function insertExtraLine(
      sale: DiscountSale,
      line: { price: bigint; discountAmount: bigint },
    ): Promise<void> {
      const { productId, variantId } = catalogOf.get(tenantId)!;
      await pool.query(
        `INSERT INTO order_line
           (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
            "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
            "discountMode","discountBps","discountAmountMinor",
            "taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
            "priceTaxMode","roundingScope","roundingMode","lineTaxAmountMinor",
            "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
            "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,'AED',2,
                 $9,NULL,$10,'STANDARD',500,'2020-01-01','VARIANT',
                 'TAX_EXCLUSIVE','LINE','HALF_UP',0,
                 'piece','Piece','piece',1,1,'Rose','Rose',now())`,
        [
          randomUUID(),
          tenantId,
          sale.co.companyId,
          sale.orderId,
          sale.lineIds.length + 1,
          productId,
          variantId,
          line.price.toString(),
          line.discountAmount > 0n ? 'AMOUNT' : 'NONE',
          line.discountAmount.toString(),
        ],
      );
    }
    const FAILS_CLOSED = { code: 'REPORT_SALES_SOURCE_INTEGRITY', status: 500 } as const;
    async function expectFailsClosed(co: Co): Promise<void> {
      const err = await reject(companyReport(co, ...JUNE));
      expect(err).toMatchObject(FAILS_CLOSED);
      expect(err.message).toContain('invoiceLineSetMismatches');
      // non-disclosing: a check name, never an amount, an id or a figure
      expect(err.message).not.toMatch(/\d{3,}/);
      expect(await reject(branchReport(co, co.branchId, ...JUNE))).toMatchObject(FAILS_CLOSED);
    }

    it('the clean sale verifies and reports exactly its stored line discount', async () => {
      const sale = await discountSale(true);
      expect(sale.expectedLineDiscount).toBe(EXPECTED.two);
      expect(sale.lineIds).toHaveLength(2);
    });

    it('legitimate data with a FRACTIONAL quantity and a PERCENT discount verifies (the recomputation is exact)', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      await sell(
        await mkOrder(co, null, {
          lines: [
            {
              quantity: '2.5000',
              unitPriceAmountMinor: 10_000n,
              rateBps: 500,
              discount: { mode: 'PERCENT_BPS', bps: 1000, amountMinor: 2_500n },
            },
          ],
        }),
        { tenders: [cash(23_625n)] },
        at('2026-06-10'),
      );
      const r = await companyReport(co, ...JUNE);
      expect(r.invoices.lineDiscountMinor).toBe('2500');
      expect(r.reconciliation.reconciled).toBe(true);
    });

    describe('an extra order line inserted into the ISSUED order (the database PERMITS this)', () => {
      it.each([
        ['with a non-zero discount', { price: 10_000n, discountAmount: 500n }],
        [
          'whose NET amount is zero but whose discount is not (the invoice subtotal is unchanged)',
          { price: 800n, discountAmount: 800n },
        ],
        ['that is a zero-value line', { price: 0n, discountAmount: 0n }],
      ])(
        '%s → the report fails closed, never an altered lineDiscountMinor',
        async (_label, line) => {
          const sale = await discountSale();
          expect(sale.expectedLineDiscount).toBe(EXPECTED.one);
          await insertExtraLine(sale, line); // a plain INSERT — no trigger fires
          expect(
            await q('SELECT 1 FROM order_line WHERE "orderId" = $1', [sale.orderId]),
          ).toHaveLength(2);
          await expectFailsClosed(sale.co);
          // the proof is bounded to the period's invoices: a window that excludes the sale still reports
          const elsewhere = await companyReport(sale.co, '2026-06-11', '2026-06-12');
          expect(elsewhere.invoices.invoiceCount).toBe(0);
        },
      );
    });

    describe('the database REJECTS update / delete of an issued order line, and a forced one is detected', () => {
      const UPDATE_CASES: readonly (readonly [string, string])[] = [
        ['a changed discount', 'UPDATE order_line SET "discountAmountMinor" = 999 WHERE id = $1'],
        ['a changed quantity', "UPDATE order_line SET quantity = '2.0000' WHERE id = $1"],
        [
          'a changed unit price',
          'UPDATE order_line SET "unitPriceAmountMinor" = 10001 WHERE id = $1',
        ],
        [
          'a price and a discount raised by the same amount (the invoice net / total unchanged)',
          'UPDATE order_line SET "unitPriceAmountMinor" = "unitPriceAmountMinor" + 100, "discountAmountMinor" = "discountAmountMinor" + 100 WHERE id = $1',
        ],
      ];
      it.each(UPDATE_CASES)('%s', async (_label, sql) => {
        const sale = await discountSale();
        // normal mode: the freeze trigger refuses it …
        await expect(pool.query(sql, [sale.lineIds[0]])).rejects.toThrow(/order_line is immutable/);
        // … with the triggers forced off the tampering lands, and the report must NOT return it
        await tamper(sql, [sale.lineIds[0]]);
        await expectFailsClosed(sale.co);
      });

      it('a deleted line', async () => {
        const sale = await discountSale(true);
        await expect(
          pool.query('DELETE FROM order_line WHERE id = $1', [sale.lineIds[1]]),
        ).rejects.toThrow(/order_line is immutable/);
        await tamper('DELETE FROM order_line WHERE id = $1', [sale.lineIds[1]]);
        expect(
          await q('SELECT 1 FROM order_line WHERE "orderId" = $1', [sale.orderId]),
        ).toHaveLength(1);
        await expectFailsClosed(sale.co);
      });

      it('every line deleted (an invoice with no lines at all)', async () => {
        const sale = await discountSale();
        await tamper('DELETE FROM order_line WHERE "orderId" = $1', [sale.orderId]);
        await expectFailsClosed(sale.co);
      });

      it('the stored fingerprint itself: refused by the order freeze trigger, and a forced change is detected', async () => {
        const sale = await discountSale();
        const sql =
          'UPDATE "order" SET "commercialSnapshotFingerprint" = repeat(\'0\', 64) WHERE id = $1';
        await expect(pool.query(sql, [sale.orderId])).rejects.toThrow(/frozen once issued/);
        await tamper(sql, [sale.orderId]);
        await expectFailsClosed(sale.co);
      });
    });

    it("a tampered line set in ANOTHER branch never disturbs a healthy branch's report (the proof is branch-scoped)", async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      await sell(
        await mkOrder(co, null, one(10_000n)),
        { tenders: [cash(10_500n)] },
        at('2026-06-10'),
      );
      const b = await mkOrder(co, null, one(20_000n), co.siblingBranchId);
      await sell(b, { tenders: [cash(21_000n)] }, at('2026-06-10'));
      const healthy = await branchReport(co, co.branchId, ...JUNE);
      const ids = await q<{ id: string }>('SELECT id FROM order_line WHERE "orderId" = $1', [
        b.orderId,
      ]);
      await tamper(
        'UPDATE order_line SET "discountAmountMinor" = 5, "discountMode" = $2 WHERE id = $1',
        [ids[0]!.id, 'AMOUNT'],
      );
      expect(await branchReport(co, co.branchId, ...JUNE)).toEqual(healthy);
      expect(await reject(branchReport(co, co.siblingBranchId, ...JUNE))).toMatchObject(
        FAILS_CLOSED,
      );
      expect(await reject(companyReport(co, ...JUNE))).toMatchObject(FAILS_CLOSED);
    });

    it('a tampered order of ANOTHER company never affects this company', async () => {
      const mine = await discountSale();
      const other = await discountSale();
      const ids = await q<{ id: string }>('SELECT id FROM order_line WHERE "orderId" = $1', [
        other.orderId,
      ]);
      await tamper('UPDATE order_line SET "discountAmountMinor" = 77 WHERE id = $1', [ids[0]!.id]);
      expect((await companyReport(mine.co, ...JUNE)).invoices.lineDiscountMinor).toBe(EXPECTED.one);
      await expectFailsClosed(other.co);
    });

    it('a credit-noted invoice (its lines untouched) still proves itself', async () => {
      const co = await makeCompany(tenantId, { currency: 'AED' });
      const c = await mkCustomer(co);
      const s = await sell(
        await mkOrder(co, c.customerId, {
          lines: [
            {
              unitPriceAmountMinor: 10_000n,
              rateBps: 500,
              discount: { mode: 'AMOUNT', amountMinor: 1_000n },
            },
          ],
        }),
        { intent: 'ON_CREDIT' },
        at('2026-06-10'),
      );
      await cancel(s.order, at('2026-06-12'));
      const r = await companyReport(co, ...JUNE);
      expect(r.creditNotes.creditNoteCount).toBe(1);
      expect(r.invoices.lineDiscountMinor).toBe('1000');
    });
  });

  // ═══════════════ the DENSITY GUARD — v1: at most 25 000 financial documents per invocation ═══════════════
  describe('the density guard: invoices + credit notes + cancellation charges, company-wide or per requested branch', () => {
    /** a repository whose limit is `n` (the production class keeps 25 000; only the boundary needs a small world) */
    const limited = (n: number): SalesFinancialReportRepository =>
      new (class extends SalesFinancialReportRepository {
        protected override readonly maxDocuments: number = n;
      })(db);
    type Counted = {
      invoices: { invoiceCount: number };
      creditNotes: { creditNoteCount: number };
      cancellationCharges: { cancellationChargeCount: number };
    };
    const docCount = (r: Counted): number =>
      r.invoices.invoiceCount +
      r.creditNotes.creditNoteCount +
      r.cancellationCharges.cancellationChargeCount;
    const companyWith = (n: number, co: Co, from: string, to: string) =>
      inTenant(
        () => limited(n).getCompanyReportScoped({ companyId: co.companyId, from, to }),
        co.tenantId,
      );
    const branchWith = (n: number, co: Co, branchId: string, from: string, to: string) =>
      inTenant(
        () => limited(n).getBranchReportScoped({ companyId: co.companyId, branchId, from, to }),
        co.tenantId,
      );
    const TOO_LARGE = { code: 'REPORT_RESULT_TOO_LARGE', status: 422 } as const;

    it('the limit is the one v1 constant, 25 000, used by the production repository', () => {
      expect(SALES_REPORT_MAX_DOCUMENTS).toBe(25_000);
      expect((repo as unknown as { maxDocuments: number }).maxDocuments).toBe(25_000);
    });

    it('EXACTLY the limit is accepted and one more is REPORT_RESULT_TOO_LARGE (company route, real documents of all three kinds)', async () => {
      const full = await companyReport(aed, ...FULL);
      const n = docCount(full);
      expect(full.invoices.invoiceCount).toBeGreaterThan(0);
      expect(full.creditNotes.creditNoteCount).toBeGreaterThan(0);
      expect(full.cancellationCharges.cancellationChargeCount).toBeGreaterThan(0);
      // the same company window ALSO holds journals of payments, a refund, a customer advance … that are NOT documents
      const others = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_entry
          WHERE "companyId" = $1 AND "sourceKind" NOT IN ('invoice_ar','walk_in_sale','credit_note','cancellation_charge')
            AND "postingDate" BETWEEN $2::date AND $3::date`,
        [aed.companyId, FULL[0], FULL[1]],
      );
      expect(Number(others[0]!.n)).toBeGreaterThan(0);
      expect(await companyWith(n, aed, ...FULL)).toEqual(full); // exactly N documents → accepted, byte-for-byte the same report
      const err = await reject(companyWith(n - 1, aed, ...FULL)); // N documents against a limit of N − 1
      expect(err).toMatchObject(TOO_LARGE);
      expect(err.message).toContain('company');
    });

    it('every kind is counted on its own: a CreditNote window and a CancellationCharge window sit exactly on the boundary', async () => {
      // 06-20: a credit note posts in branch B's window; 07-05: a cancellation charge does
      for (const [co, branchId, day] of [
        [aed, aed.branchId, '2026-06-22'],
        [aed, aed.siblingBranchId, '2026-07-05'],
        [aed, aed.siblingBranchId, '2026-06-20'],
      ] as const) {
        const r = await branchReport(co, branchId, day, day);
        const n = docCount(r);
        expect(n).toBeGreaterThan(0);
        // the guard's OWN count equals the documents of the report — invoices + credit notes + charges, nothing else
        const counted = await asTenant((tx) => {
          const query = buildSalesFinancialReportQuery({
            tenantId,
            companyId: co.companyId,
            from: day,
            to: day,
            branchId,
            maxDocuments: 1_000,
          });
          return tx.$queryRawUnsafe<{ report: string }[]>(query.text, ...query.values);
        });
        expect(
          (JSON.parse(counted[0]!.report) as SalesFinancialReportJson).candidateDocuments,
        ).toBe(n);
        expect(await branchWith(n, co, branchId, day, day)).toEqual(r);
        if (n > 1) {
          expect(await reject(branchWith(n - 1, co, branchId, day, day))).toMatchObject(TOO_LARGE);
        }
      }
      const cn = await branchReport(aed, aed.branchId, '2026-06-22', '2026-06-22');
      expect(cn.creditNotes.creditNoteCount).toBeGreaterThan(0); // the credit-note boundary above really included one
      const cc = await branchReport(aed, aed.siblingBranchId, '2026-07-05', '2026-07-05');
      expect(cc.cancellationCharges.cancellationChargeCount).toBeGreaterThan(0); // …and the charge one
    });

    it('the COMPANY limit is for the whole company — not per branch; a BRANCH limit counts that branch only — a sibling never affects it', async () => {
      const a = await branchReport(aed, aed.branchId, ...FULL);
      const b = await branchReport(aed, aed.siblingBranchId, ...FULL);
      const company = await companyReport(aed, ...FULL);
      const [na, nb, nc] = [docCount(a), docCount(b), docCount(company)];
      expect(na + nb).toBe(nc);
      expect(Math.min(na, nb)).toBeGreaterThan(0);
      const hi = Math.max(na, nb);
      const lo = Math.min(na, nb);
      expect(hi).toBeGreaterThan(lo);
      const hiBranch = na >= nb ? aed.branchId : aed.siblingBranchId;
      const loBranch = na >= nb ? aed.siblingBranchId : aed.branchId;
      // a limit equal to the LARGER branch: both branches fit, the company (the sum) does not — so it is not applied per branch
      expect(await branchWith(hi, aed, hiBranch, ...FULL)).toBeTruthy();
      expect(await branchWith(hi, aed, loBranch, ...FULL)).toBeTruthy();
      expect(await reject(companyWith(hi, aed, ...FULL))).toMatchObject(TOO_LARGE);
      // a limit one below the larger branch: THAT branch is refused while the smaller one is untouched by its sibling
      const err = await reject(branchWith(hi - 1, aed, hiBranch, ...FULL));
      expect(err).toMatchObject(TOO_LARGE);
      expect(err.message).toContain('branch');
      expect(await branchWith(hi - 1, aed, loBranch, ...FULL)).toBeTruthy();
      // …and the smaller branch fits exactly at its own count although the sibling alone exceeds that limit
      expect(await branchWith(lo, aed, loBranch, ...FULL)).toBeTruthy();
      expect(await reject(branchWith(lo - 1, aed, loBranch, ...FULL))).toMatchObject(TOO_LARGE);
    });

    it('another company or tenant never counts toward the limit', async () => {
      const mine = docCount(await companyReport(aed, ...FULL));
      // a limit of exactly this company's documents holds although the database holds far more (other companies, a foreign tenant)
      expect(await companyWith(mine, aed, ...FULL)).toBeTruthy();
      const foreignOwn = docCount(await companyReport(foreign, ...FULL));
      expect(
        await inTenant(
          () =>
            limited(Math.max(1, foreignOwn)).getCompanyReportScoped({
              companyId: foreign.companyId,
              from: FULL[0],
              to: FULL[1],
            }),
          foreign.tenantId,
        ),
      ).toBeTruthy();
    });

    it('ABOVE the limit nothing heavy is produced: the statement returns the count and NO evidence, aggregate, GL or integrity figure', async () => {
      const full = await companyReport(aed, ...FULL);
      const n = docCount(full);
      const run = (max: number, branchId: string | null) => {
        const query = buildSalesFinancialReportQuery({
          tenantId,
          companyId: aed.companyId,
          from: FULL[0],
          to: FULL[1],
          branchId,
          maxDocuments: max,
        });
        return asTenant((tx) =>
          tx.$queryRawUnsafe<{ report: string }[]>(query.text, ...query.values),
        ).then((rows) => JSON.parse(rows[0]!.report) as SalesFinancialReportJson);
      };
      // exactly at the limit: the heavy parts are present
      const within = await run(n, null);
      expect(within.candidateDocuments).toBe(n);
      expect(within.invoiceLineSets.length).toBe(full.invoices.invoiceCount);
      expect(within.branches.length).toBeGreaterThan(0);
      expect(within.gl.length).toBeGreaterThan(0);
      // one below: the candidates are counted (n), and every heavy section is EMPTY
      const over = await run(n - 1, null);
      expect(over.candidateDocuments).toBe(n);
      expect(over.invoiceLineSets).toEqual([]);
      expect(over.branches).toEqual([]);
      expect(over.statuses).toEqual([]);
      expect(over.gl).toEqual([]);
      expect(Object.values(over.integrity).every((x) => x === 0)).toBe(true);
      // the scan STOPS at limit + 1: with a tiny limit the count is exactly limit + 1, not the whole window
      expect((await run(3, null)).candidateDocuments).toBe(4);
      expect((await run(1, null)).candidateDocuments).toBe(2);
      // the branch route counts its own branch only
      const branchOnly = await run(1, aed.siblingBranchId);
      expect(branchOnly.candidateDocuments).toBe(2);
    });

    it('ONE statement in ONE transaction per report — accepted and rejected alike (no second COUNT query, no N+1)', async () => {
      const counting = (n: number) =>
        new (class extends SalesFinancialReportRepository {
          statements = 0;
          transactions = 0;
          protected override readonly maxDocuments: number = n;
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
      const n = docCount(await companyReport(aed, ...FULL));
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
        expect(r.statements).toBe(1);
        expect(r.transactions).toBe(1);
      }
      const b = counting(1_000);
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
    it('a rejected report is cheap and writes nothing; the other checks are unchanged (91 days first, then the density)', async () => {
      const count = async (): Promise<string> =>
        (
          await q<{ n: string }>(
            'SELECT (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM outbox) + (SELECT count(*) FROM journal_entry) AS n',
          )
        )[0]!.n;
      const before = await count();
      await reject(companyWith(1, aed, ...FULL));
      expect(await count()).toBe(before);
      // the period rule is checked first: 91 days is REPORT_RANGE_TOO_LARGE even when the density would also fail
      expect(await reject(companyWith(1, aed, '2026-06-01', '2026-08-30'))).toMatchObject({
        code: 'REPORT_RANGE_TOO_LARGE',
      });
      // an unknown company is still a plain 404 (no document of it is counted)
      expect(
        await reject(
          inTenant(() =>
            limited(1).getCompanyReportScoped({
              companyId: randomUUID(),
              from: FULL[0],
              to: FULL[1],
            }),
          ),
        ),
      ).toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
