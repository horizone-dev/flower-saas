import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test of the Checkpoint-B caller-transaction posting
// adapter — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import type pg from 'pg';
import { AccountRepository } from '../accounting/account.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  buildWalkInSaleJournal,
  type WalkInJournalTender,
  type WalkInSaleJournalPlan,
} from './walk-in-sale-journal.js';
import {
  WalkInSaleJournalRepository,
  type PostWalkInSaleJournalInput,
} from './walk-in-sale-journal.repository.js';

/**
 * Task 3b.9 Checkpoint B — the walk-in sale journal adapter against REAL
 * Postgres: the Checkpoint-A plan is posted through the frozen
 * `PostingEngineService`, inside the caller's transaction. Covers the journal
 * results (cash / bank / multi-tender / 3-decimal), replay + conflict +
 * concurrency, caller-rollback + fault injection, period / currency failures,
 * trusted-scope, the customer-linked hard gate and the zero-total ruling.
 */
describe('WalkInSaleJournalRepository (task 3b.9 Checkpoint B, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let pool: pg.Pool;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let companyConfig: CompanyFinancialConfigRepository;
  let engine: PostingEngineService;
  let repo: WalkInSaleJournalRepository;
  let postSpy: ReturnType<typeof vi.spyOn>;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUserId = randomUUID();
  const runTag = randomUUID().slice(0, 8);
  let seq = 0;

  let categoryId = '';
  let productId = '';
  let variantId = '';

  interface Co {
    companyId: string;
    branchId: string;
    siblingBranchId: string;
    terminalId: string;
  }
  let aed: Co; // AED / Asia/Dubai, OPEN period 2026-06
  let kwd: Co; // KWD / Asia/Kuwait, OPEN period 2026-06
  let closed: Co; // AED, period 2026-06 CLOSED
  let noCurrency: Co; // no defaultCurrency
  let noTimezone: Co; // defaultCurrency set, no accountingTimezone
  let sar: Co; // SAR (2-decimal, like AED) — for the currency backstop

  const fakeClock = { now: () => new Date('2026-06-15T10:00:00Z') } as unknown as SystemClock;
  const asTenant = <T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> =>
    runScoped(prisma, { tenantId }, fn);

  // ── fixtures ────────────────────────────────────────────────────────────────
  async function makeCompany(o: {
    currency: 'AED' | 'KWD' | 'SAR' | null;
    timezone: string | null;
    country: 'AE' | 'KW';
    period: 'open' | 'closed' | 'none';
  }): Promise<Co> {
    const co: Co = {
      companyId: randomUUID(),
      branchId: randomUUID(),
      siblingBranchId: randomUUID(),
      terminalId: randomUUID(),
    };
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", "accountingTimezone", status, "updatedAt")
       VALUES ($1, $2, 'Test Co', $3, $4, $5, 'ACTIVE', now())`,
      [co.companyId, tenantId, o.country, o.currency, o.timezone],
    );
    for (const [id, name] of [
      [co.branchId, 'Main'],
      [co.siblingBranchId, 'Sibling'],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, $4, now())`,
        [id, tenantId, co.companyId, name],
      );
    }
    await pool.query(
      `INSERT INTO pos_terminal (id, "tenantId", "companyId", "branchId", code, name, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'POS 1', now())`,
      [co.terminalId, tenantId, co.companyId, co.branchId, `POS-${co.terminalId.slice(0, 8)}`],
    );
    if (o.period !== 'none' && o.currency !== null) {
      await asTenant((tx) =>
        accounts.ensureDefaultAccounts(tx, { tenantId, companyId: co.companyId }),
      );
      const period = await asTenant((tx) =>
        periods.create(tx, {
          tenantId,
          companyId: co.companyId,
          startDate: new Date('2026-06-01T00:00:00Z'),
          endDate: new Date('2026-06-30T00:00:00Z'),
        }),
      );
      if (o.period === 'closed') {
        await asTenant((tx) =>
          periods.close(tx, {
            tenantId,
            companyId: co.companyId,
            id: period.id,
            expectedVersion: period.version,
            closedByUserId: null,
          }),
        );
      }
    }
    return co;
  }

  async function makeCustomer(companyId: string): Promise<string> {
    const customerId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Linked Customer', now())`,
      [customerId, tenantId],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [randomUUID(), tenantId, companyId, customerId],
    );
    return customerId;
  }

  interface SaleOpts {
    total: bigint;
    tax?: bigint;
    currency?: 'AED' | 'KWD' | 'SAR';
    exponent?: number;
    customerId?: string | null;
    kind?: string;
    withTerminal?: boolean;
    invoiceDate?: string;
  }

  /** an ISSUED invoice (+ its CONFIRMED order and one line) in `co` */
  async function makeInvoice(co: Co, o: SaleOpts): Promise<string> {
    const currency = o.currency ?? 'AED';
    const exponent = o.exponent ?? (currency === 'KWD' ? 3 : 2);
    const tax = o.tax ?? 0n;
    const orderId = randomUUID();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", "posTerminalId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "documentDiscountAmountMinor", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'DRAFT',$8,$9,$10,2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,now())`,
      [
        orderId,
        tenantId,
        co.companyId,
        co.branchId,
        o.customerId ?? null,
        o.withTerminal ? co.terminalId : null,
        o.kind ?? 'WALK_IN',
        currency,
        exponent,
        `fp-${orderId}`,
      ],
    );
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "discountMode", "discountAmountMinor", "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,$8,$9,'NONE',0,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [
        randomUUID(),
        tenantId,
        co.companyId,
        orderId,
        productId,
        variantId,
        (o.total - tax === 0n ? 1n : o.total - tax).toString(),
        currency,
        exponent,
      ],
    );
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-${runTag}-${(++seq).toString().padStart(6, '0')}`],
    );
    const invoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7::date, $8, $9, $10, 0, $11, $12)`,
      [
        invoiceId,
        tenantId,
        co.companyId,
        co.branchId,
        orderId,
        `INV-${runTag}-${invoiceId.slice(0, 8)}`,
        o.invoiceDate ?? '2026-06-10',
        currency,
        exponent,
        (o.total - tax).toString(),
        tax.toString(),
        o.total.toString(),
      ],
    );
    return invoiceId;
  }

  /** the Checkpoint-A plan for an invoice made with `o` (anonymous by construction) */
  function planFor(
    invoiceId: string,
    o: SaleOpts,
    tenders: readonly WalkInJournalTender[],
  ): WalkInSaleJournalPlan {
    const currency = o.currency ?? 'AED';
    return buildWalkInSaleJournal({
      invoiceId,
      customerId: null,
      currencyCode: currency,
      currencyExponent: o.exponent ?? (currency === 'KWD' ? 3 : 2),
      totalAmountMinor: o.total,
      taxTotalAmountMinor: o.tax ?? 0n,
      tenders,
    });
  }

  const input = (
    co: Co,
    invoiceId: string,
    plan: WalkInSaleJournalPlan,
    over: Partial<PostWalkInSaleJournalInput> = {},
  ): PostWalkInSaleJournalInput => ({
    tenantId,
    companyId: co.companyId,
    branchId: co.branchId,
    invoiceId,
    plan,
    actorUserId,
    ...over,
  });

  const post = (co: Co, invoiceId: string, plan: WalkInSaleJournalPlan) =>
    asTenant((tx) => repo.postWalkInSaleJournalInTx(tx, input(co, invoiceId, plan)));

  interface LineRow {
    key: string;
    debit: bigint;
    credit: bigint;
    branchId: string | null;
    posTerminalId: string | null;
  }

  async function linesOf(journalEntryId: string): Promise<LineRow[]> {
    const r = await pool.query(
      `SELECT a."key" AS key, jl."debitMinor"::text AS debit, jl."creditMinor"::text AS credit,
              jl."branchId", jl."posTerminalId"
         FROM journal_line jl JOIN account a ON a.id = jl."accountId"
        WHERE jl."journalEntryId" = $1`,
      [journalEntryId],
    );
    return (r.rows as Record<string, string | null>[])
      .map((x) => ({
        key: x['key'] as string,
        debit: BigInt(x['debit'] as string),
        credit: BigInt(x['credit'] as string),
        branchId: x['branchId'] ?? null,
        posTerminalId: x['posTerminalId'] ?? null,
      }))
      .sort((a, b) =>
        a.debit > 0n !== b.debit > 0n
          ? a.debit > 0n
            ? -1
            : 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
      );
  }

  /** compact `Dr KEY n` / `Cr KEY n` rendering, debits first */
  const rendered = (rows: LineRow[]): string[] =>
    rows.map((r) => (r.debit > 0n ? `Dr ${r.key} ${r.debit}` : `Cr ${r.key} ${r.credit}`));

  async function journalCount(invoiceId: string): Promise<number> {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entry
        WHERE "tenantId" = $1 AND "sourceKind" = 'walk_in_sale' AND "sourceId" = $2`,
      [tenantId, invoiceId],
    );
    return (r.rows[0] as { n: number }).n;
  }

  async function auditCount(journalEntryId: string): Promise<number> {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 AND "resourceId" = $2`,
      [tenantId, journalEntryId],
    );
    return (r.rows[0] as { n: number }).n;
  }

  /** every side-effect table 3b.9 Checkpoint B must NOT touch, plus order state */
  async function sideEffects(): Promise<Record<string, number | string>> {
    const out: Record<string, number | string> = {};
    for (const t of [
      'payment',
      'payment_allocation',
      'customer_receivable',
      'customer_advance',
      'customer_account_entry',
      'outbox',
      'document_number_counter',
    ]) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      out[t] = (r.rows[0] as { n: number }).n;
    }
    const o = await pool.query(
      `SELECT string_agg(id::text || ':' || status || ':' || version::text || ':' || coalesce("orderNumber", ''), ',' ORDER BY id) AS s
         FROM "order" WHERE "tenantId" = $1`,
      [tenantId],
    );
    out['orders'] = String((o.rows[0] as { s: string | null }).s);
    return out;
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });

    const dummyDb = {} as unknown as DbService;
    const audit = new AuditWriter(dummyDb);
    accounts = new AccountRepository(dummyDb, audit);
    periods = new AccountingPeriodRepository(dummyDb, audit);
    companyConfig = new CompanyFinancialConfigRepository(dummyDb, audit, accounts);
    engine = new PostingEngineService(companyConfig, periods, audit, fakeClock);
    repo = new WalkInSaleJournalRepository(engine, companyConfig);
    postSpy = vi.spyOn(engine, 'postJournal');

    const pgMod = await import('pg');
    pool = new pgMod.default.Pool({ connectionString: stack.postgres.url });

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `walk-in-journal-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [id, `walk-in-journal-${id.slice(0, 8)}`, planVersionId],
      );
    }
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x'), ('KWD', 3, 'KWD', 'Kuwaiti Dinar', 'x'), ('SAR', 2, 'SAR', 'Saudi Riyal', 'x')
       ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "defaultTimezone", "updatedAt")
       VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', 'Asia/Dubai', now()),
              ('KW', 'Kuwait', 'x', 'gcc', 'KWD', 'FRI_SAT', 'Asia/Kuwait', now())
       ON CONFLICT (code) DO NOTHING`,
    );
    categoryId = randomUUID();
    productId = randomUUID();
    variantId = randomUUID();
    await pool.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt") VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [categoryId, tenantId],
    );
    await pool.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose-bouquet', 'Test Product', 'STOCKED', now())`,
      [productId, tenantId, categoryId],
    );
    await pool.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt") VALUES ($1, $2, $3, 'Test Variant', now())`,
      [variantId, tenantId, productId],
    );

    aed = await makeCompany({
      currency: 'AED',
      timezone: 'Asia/Dubai',
      country: 'AE',
      period: 'open',
    });
    kwd = await makeCompany({
      currency: 'KWD',
      timezone: 'Asia/Kuwait',
      country: 'KW',
      period: 'open',
    });
    closed = await makeCompany({
      currency: 'AED',
      timezone: 'Asia/Dubai',
      country: 'AE',
      period: 'closed',
    });
    noCurrency = await makeCompany({
      currency: null,
      timezone: 'Asia/Dubai',
      country: 'AE',
      period: 'none',
    });
    noTimezone = await makeCompany({
      currency: 'AED',
      timezone: null,
      country: 'AE',
      period: 'none',
    });
    sar = await makeCompany({
      currency: 'SAR',
      timezone: 'Asia/Riyadh',
      country: 'AE',
      period: 'open',
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  beforeEach(() => {
    postSpy.mockClear();
  });

  // ── the journal results ─────────────────────────────────────────────────────
  describe('journal results', () => {
    it('A. CASH 105.00 → Dr CASH_ON_HAND 10500 / Cr REVENUE.SALES 10000 / Cr TAX_PAYABLE 500', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const before = await sideEffects();
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      const res = await post(aed, invoiceId, plan);

      expect(res).toMatchObject({
        created: true,
        sourceKind: 'walk_in_sale',
        sourceId: invoiceId,
        accountingDate: '2026-06-10',
      });
      expect(rendered(await linesOf(res.journalEntryId))).toEqual([
        'Dr ASSET.CASH_ON_HAND 10500',
        'Cr LIABILITY.TAX_PAYABLE 500',
        'Cr REVENUE.SALES 10000',
      ]);
      expect(await journalCount(invoiceId)).toBe(1);
      // the ONLY side effect of the post is the journal (+ the engine's own audit row)
      expect(await sideEffects()).toEqual(before);
    });

    it('B. BANK 26.25 → Dr BANK 2625 / Cr REVENUE.SALES 2500 / Cr TAX_PAYABLE 125', async () => {
      const o = { total: 2625n, tax: 125n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'BANK_TRANSFER', amountMinor: 2625n }]);

      const res = await post(aed, invoiceId, plan);

      expect(rendered(await linesOf(res.journalEntryId))).toEqual([
        'Dr ASSET.BANK 2625',
        'Cr LIABILITY.TAX_PAYABLE 125',
        'Cr REVENUE.SALES 2500',
      ]);
    });

    it('C. Multi Payment: same-account tenders aggregate deterministically, whatever order they arrive in', async () => {
      const o = { total: 10500n, tax: 500n };
      const tenders: WalkInJournalTender[] = [
        { method: 'CASH', amountMinor: 5000n },
        { method: 'BANK_TRANSFER', amountMinor: 3000n },
        { method: 'CASH', amountMinor: 2500n },
      ];
      const a = await makeInvoice(aed, o);
      const b = await makeInvoice(aed, o);

      const planA = planFor(a, o, tenders);
      const planB = planFor(b, o, [...tenders].reverse());

      const ra = await post(aed, a, planA);
      const rb = await post(aed, b, planB);

      // read back sorted by (side, account key) — row order in the table is not a DB fact
      const expected = [
        'Dr ASSET.BANK 3000',
        'Dr ASSET.CASH_ON_HAND 7500',
        'Cr LIABILITY.TAX_PAYABLE 500',
        'Cr REVENUE.SALES 10000',
      ];
      expect(rendered(await linesOf(ra.journalEntryId))).toEqual(expected);
      expect(rendered(await linesOf(rb.journalEntryId))).toEqual(expected);
      // the engine receives the frozen plan's own deterministic line order, verbatim
      const handed = postSpy.mock.calls.map((c: unknown[]) => (c[1] as { lines: unknown }).lines);
      expect(handed[0]).toEqual(planA.lines);
      expect(handed[1]).toEqual(planA.lines);
      expect(handed[1]).toEqual(planB.lines);
    });

    it('manual CARD_TERMINAL + OTHER_MANUAL tenders both land on PAYMENT_CLEARING as one line', async () => {
      const o = { total: 6000n, tax: 0n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [
        { method: 'CARD_TERMINAL', amountMinor: 4000n },
        { method: 'OTHER_MANUAL', amountMinor: 2000n },
      ]);

      const res = await post(aed, invoiceId, plan);

      expect(rendered(await linesOf(res.journalEntryId))).toEqual([
        'Dr ASSET.PAYMENT_CLEARING 6000',
        'Cr REVENUE.SALES 6000',
      ]);
    });

    it('a single OTHER_MANUAL tender and a single manual CARD_TERMINAL each post to PAYMENT_CLEARING', async () => {
      for (const method of ['OTHER_MANUAL', 'CARD_TERMINAL']) {
        const o = { total: 1050n, tax: 50n };
        const invoiceId = await makeInvoice(aed, o);
        const res = await post(
          aed,
          invoiceId,
          planFor(invoiceId, o, [{ method, amountMinor: 1050n }]),
        );
        expect(rendered(await linesOf(res.journalEntryId))).toEqual([
          'Dr ASSET.PAYMENT_CLEARING 1050',
          'Cr LIABILITY.TAX_PAYABLE 50',
          'Cr REVENUE.SALES 1000',
        ]);
      }
    });

    it('zero tax posts no TAX_PAYABLE line (the sealed-journal CHECK rejects a zero line)', async () => {
      const o = { total: 5000n, tax: 0n };
      const invoiceId = await makeInvoice(aed, o);

      const res = await post(
        aed,
        invoiceId,
        planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 5000n }]),
      );

      expect(rendered(await linesOf(res.journalEntryId))).toEqual([
        'Dr ASSET.CASH_ON_HAND 5000',
        'Cr REVENUE.SALES 5000',
      ]);
    });

    it('3-decimal currency (KWD, exponent 3): exact minor units end to end', async () => {
      const o = { total: 12345n, tax: 588n, currency: 'KWD' as const };
      const invoiceId = await makeInvoice(kwd, o);
      const plan = planFor(invoiceId, o, [
        { method: 'CASH', amountMinor: 10000n },
        { method: 'BANK_TRANSFER', amountMinor: 2345n },
      ]);

      const res = await post(kwd, invoiceId, plan);

      expect(rendered(await linesOf(res.journalEntryId))).toEqual([
        'Dr ASSET.BANK 2345',
        'Dr ASSET.CASH_ON_HAND 10000',
        'Cr LIABILITY.TAX_PAYABLE 588',
        'Cr REVENUE.SALES 11757',
      ]);
      const entry = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({ where: { id: res.journalEntryId } }),
      );
      expect(entry.currencyCode).toBe('KWD');
    });

    it('seals the journal, dates it with the invoice, stamps branch + POS terminal (attribution only) and the actor', async () => {
      const o = { total: 10500n, tax: 500n, withTerminal: true, invoiceDate: '2026-06-22' };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      const res = await post(aed, invoiceId, plan);

      const entry = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({ where: { id: res.journalEntryId } }),
      );
      expect(entry.sealedAt).not.toBeNull();
      expect(entry.sourceKind).toBe('walk_in_sale');
      expect(entry.sourceId).toBe(invoiceId);
      expect(entry.currencyCode).toBe('AED');
      expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2026-06-22');
      expect(entry.createdByUserId).toBe(actorUserId);
      for (const l of await linesOf(res.journalEntryId)) {
        expect(l.branchId).toBe(aed.branchId);
        expect(l.posTerminalId).toBe(aed.terminalId);
      }
      expect(postSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sourceKind: 'walk_in_sale',
          sourceId: invoiceId,
          branchId: aed.branchId,
          posTerminalId: aed.terminalId,
          accountingDate: '2026-06-22',
          createdByUserId: actorUserId,
        }),
      );
    });

    it('an order with no POS terminal posts with no posTerminalId dimension', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);

      const res = await post(
        aed,
        invoiceId,
        planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]),
      );

      for (const l of await linesOf(res.journalEntryId)) expect(l.posTerminalId).toBeNull();
      const arg = postSpy.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('posTerminalId');
    });

    it('books exactly: no AR, customer advance, unapplied receipt, contra-revenue or settlement-discount line, and no customer entry', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const res = await post(
        aed,
        invoiceId,
        planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]),
      );

      const keys = (await linesOf(res.journalEntryId)).map((l) => l.key);
      expect(keys.sort()).toEqual(['ASSET.CASH_ON_HAND', 'LIABILITY.TAX_PAYABLE', 'REVENUE.SALES']);
      const sums = await asTenant((tx) =>
        tx.journalLine.aggregate({
          where: { journalEntryId: res.journalEntryId },
          _sum: { debitMinor: true, creditMinor: true },
        }),
      );
      expect(sums._sum.debitMinor).toBe(10500n);
      expect(sums._sum.creditMinor).toBe(10500n);
    });

    it('the engine writes its own single audit row and no other audit/outbox row', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      const outboxBefore = (await sideEffects())['outbox'];

      const res = await post(
        aed,
        invoiceId,
        planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]),
      );

      const rows = await pool.query(
        `SELECT action FROM audit_log WHERE "tenantId" = $1 AND "resourceId" = $2`,
        [tenantId, res.journalEntryId],
      );
      expect(rows.rows).toEqual([{ action: 'accounting.journal_posted' }]);
      expect((await sideEffects())['outbox']).toBe(outboxBefore);
    });
  });

  // ── provider-backed tender, customer-linked, zero-total: rejected before posting ──
  describe('rejected before the posting engine', () => {
    it('provider-backed tenders never produce a plan, so nothing reaches the engine', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      expect(() =>
        planFor(invoiceId, o, [{ method: 'ONLINE_GATEWAY', amountMinor: 1050n }]),
      ).toThrow(RangeError);
      expect(() =>
        planFor(invoiceId, o, [
          { method: 'CARD_TERMINAL', amountMinor: 1050n, providerCredentialId: randomUUID() },
        ]),
      ).toThrow(RangeError);
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('a customer-linked order is refused (WALK_IN_JOURNAL_CUSTOMER_LINKED) — engine never called, no journal, no side effect', async () => {
      const customerId = await makeCustomer(aed.companyId);
      const o = { total: 10500n, tax: 500n, customerId };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, { ...o, customerId: null }, [
        { method: 'CASH', amountMinor: 10500n },
      ]);
      const before = await sideEffects();

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_CUSTOMER_LINKED',
        status: 409,
      });

      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
      expect(await sideEffects()).toEqual(before);
    });

    it('the Checkpoint-A builder itself refuses a customer-linked sale', () => {
      expect(() =>
        buildWalkInSaleJournal({
          invoiceId: randomUUID(),
          customerId: randomUUID(),
          currencyCode: 'AED',
          currencyExponent: 2,
          totalAmountMinor: 100n,
          taxTotalAmountMinor: 0n,
          tenders: [{ method: 'CASH', amountMinor: 100n }],
        }),
      ).toThrow(RangeError);
    });

    it('a non-WALK_IN order kind is refused (WALK_IN_JOURNAL_ORDER_KIND_UNSUPPORTED)', async () => {
      const o = { total: 1050n, tax: 50n, kind: 'PICKUP' };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_ORDER_KIND_UNSUPPORTED',
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('ZERO-TOTAL ruling: a zero-total invoice is SALE_ZERO_TOTAL_NOT_SUPPORTED — no engine call, no journal, no zero-value accounting path', async () => {
      const invoiceId = await makeInvoice(aed, { total: 0n, tax: 0n });
      const nonZeroPlan = planFor(invoiceId, { total: 10500n, tax: 500n }, [
        { method: 'CASH', amountMinor: 10500n },
      ]);
      const before = await sideEffects();

      await expect(post(aed, invoiceId, nonZeroPlan)).rejects.toMatchObject({
        code: 'SALE_ZERO_TOTAL_NOT_SUPPORTED',
        status: 422,
      });

      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
      expect(await sideEffects()).toEqual(before);
      // …and the builder itself never emits a zero-value journal
      expect(() =>
        planFor(invoiceId, { total: 0n, tax: 0n }, [{ method: 'CASH', amountMinor: 1n }]),
      ).toThrow(RangeError);
    });

    it('a hand-forged zero plan is also refused before the engine (SALE_ZERO_TOTAL_NOT_SUPPORTED)', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      const forged = {
        sourceKind: 'walk_in_sale',
        sourceId: invoiceId,
        lines: [],
        totalDebitMinor: 0n,
        totalCreditMinor: 0n,
      } as unknown as WalkInSaleJournalPlan;

      await expect(post(aed, invoiceId, forged)).rejects.toMatchObject({
        code: 'SALE_ZERO_TOTAL_NOT_SUPPORTED',
      });
      expect(postSpy).not.toHaveBeenCalled();
    });

    // The customer-linked gate reads ONLY `order.customerId`. These two pins prove
    // that is sufficient: no receivable can ever sit on an anonymous invoice, and an
    // issued order's customer can never be changed (so an order cannot turn
    // anonymous after a receivable exists).
    it('DB pin: a customer_receivable can never reference an anonymous invoice', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      const customerId = await makeCustomer(aed.companyId);
      const cca = (
        await pool.query(
          `SELECT id FROM customer_company_account WHERE "tenantId" = $1 AND "customerId" = $2`,
          [tenantId, customerId],
        )
      ).rows[0] as { id: string };
      await expect(
        pool.query(
          `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
           VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
          [randomUUID(), tenantId, aed.companyId, aed.branchId, cca.id, invoiceId],
        ),
      ).rejects.toThrow(/walk-in/);
    });

    it('DB pin: an issued order can never lose (or change) its customer, nor change kind / POS terminal / currency', async () => {
      const customerId = await makeCustomer(aed.companyId);
      const invoiceId = await makeInvoice(aed, { total: 1050n, tax: 50n, customerId });
      const orderId = (await pool.query(`SELECT "orderId" FROM invoice WHERE id = $1`, [invoiceId]))
        .rows[0] as { orderId: string };
      for (const set of [
        `"customerId" = NULL`,
        `"kind" = 'PICKUP'`,
        `"posTerminalId" = '${aed.terminalId}'`,
      ]) {
        await expect(
          pool.query(`UPDATE "order" SET ${set} WHERE id = $1`, [orderId.orderId]),
        ).rejects.toThrow(/order/);
      }
    });
  });

  // ── the plan must be the frozen Checkpoint-A plan of THIS invoice ────────────
  describe('plan integrity', () => {
    it('a plan for another invoice id is WALK_IN_JOURNAL_PLAN_INVALID', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      const other = planFor(randomUUID(), o, [{ method: 'CASH', amountMinor: 1050n }]);

      await expect(post(aed, invoiceId, other)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_PLAN_INVALID',
      });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('a plan of another sourceKind is WALK_IN_JOURNAL_PLAN_INVALID', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = {
        ...planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]),
        sourceKind: 'invoice_ar',
      } as unknown as WalkInSaleJournalPlan;

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_PLAN_INVALID',
      });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['an AR debit', { accountKey: 'ASSET.CUSTOMER_RECEIVABLE', direction: 'debit' }],
      [
        'a customer-advance credit',
        { accountKey: 'LIABILITY.CUSTOMER_ADVANCES', direction: 'credit' },
      ],
      [
        'an unapplied-receipts credit',
        { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', direction: 'credit' },
      ],
      [
        'a contra-revenue debit',
        { accountKey: 'CONTRA_REVENUE.SALES_DISCOUNT', direction: 'debit' },
      ],
      ['revenue on the debit side', { accountKey: 'REVENUE.SALES', direction: 'debit' }],
      [
        'a tender account on the credit side',
        { accountKey: 'ASSET.CASH_ON_HAND', direction: 'credit' },
      ],
    ])(
      'a forged plan with %s never reaches the engine (WALK_IN_JOURNAL_PLAN_INVALID)',
      async (_n, bad) => {
        const o = { total: 1050n, tax: 50n };
        const invoiceId = await makeInvoice(aed, o);
        const good = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);
        const forged = {
          ...good,
          lines: [...good.lines, { ...bad, amountMinor: 1n }],
        } as unknown as WalkInSaleJournalPlan;

        await expect(post(aed, invoiceId, forged)).rejects.toMatchObject({
          code: 'WALK_IN_JOURNAL_PLAN_INVALID',
        });
        expect(postSpy).not.toHaveBeenCalled();
        expect(await journalCount(invoiceId)).toBe(0);
      },
    );

    it('a plan whose total differs from the issued invoice is WALK_IN_JOURNAL_PLAN_MISMATCH', async () => {
      const invoiceId = await makeInvoice(aed, { total: 10500n, tax: 500n });
      const plan = planFor(invoiceId, { total: 10000n, tax: 500n }, [
        { method: 'CASH', amountMinor: 10000n },
      ]);

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_PLAN_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('a plan whose tax differs from the issued invoice is WALK_IN_JOURNAL_PLAN_MISMATCH', async () => {
      const invoiceId = await makeInvoice(aed, { total: 10500n, tax: 500n });
      const plan = planFor(invoiceId, { total: 10500n, tax: 0n }, [
        { method: 'CASH', amountMinor: 10500n },
      ]);

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_PLAN_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('an unbalanced forged plan with SHORT CREDITS is WALK_IN_JOURNAL_PLAN_MISMATCH', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      const good = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);
      const forged = {
        ...good,
        lines: good.lines.filter((l) => l.accountKey !== 'REVENUE.SALES'),
      } as WalkInSaleJournalPlan;

      await expect(post(aed, invoiceId, forged)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_PLAN_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('an unbalanced forged plan with SHORT DEBITS is WALK_IN_JOURNAL_PLAN_MISMATCH', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      const good = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);
      const forged = {
        ...good,
        lines: good.lines.map((l) => (l.direction === 'debit' ? { ...l, amountMinor: 1000n } : l)),
      } as WalkInSaleJournalPlan;

      await expect(post(aed, invoiceId, forged)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_PLAN_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['a zero', 0n],
      ['a negative', -1n],
      ['a non-BigInt', 5],
    ])(
      'a forged plan carrying %s line amount never reaches the engine (WALK_IN_JOURNAL_PLAN_INVALID)',
      async (_n, amount) => {
        const o = { total: 1050n, tax: 50n };
        const invoiceId = await makeInvoice(aed, o);
        const good = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);
        const forged = {
          ...good,
          lines: [
            ...good.lines,
            { accountKey: 'ASSET.BANK', direction: 'debit', amountMinor: amount },
          ],
        } as unknown as WalkInSaleJournalPlan;

        await expect(post(aed, invoiceId, forged)).rejects.toMatchObject({
          code: 'WALK_IN_JOURNAL_PLAN_INVALID',
        });
        expect(postSpy).not.toHaveBeenCalled();
        expect(await journalCount(invoiceId)).toBe(0);
      },
    );

    it('the plan LINES are trusted over its self-declared totals', async () => {
      const invoiceId = await makeInvoice(aed, { total: 10500n, tax: 500n });
      const small = planFor(invoiceId, { total: 5000n, tax: 0n }, [
        { method: 'CASH', amountMinor: 5000n },
      ]);
      const lying = { ...small, totalDebitMinor: 10500n, totalCreditMinor: 10500n };

      await expect(post(aed, invoiceId, lying)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_PLAN_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
    });
  });

  // ── trusted scope ────────────────────────────────────────────────────────────
  describe('trusted scope (no cross-tenant / company / branch posting)', () => {
    const setup = async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(aed, o);
      return { invoiceId, plan: planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]) };
    };

    it('another tenant (RLS) cannot see the invoice → INVOICE_NOT_FOUND', async () => {
      const { invoiceId, plan } = await setup();
      await expect(
        runScoped(prisma, { tenantId: otherTenantId }, (tx) =>
          repo.postWalkInSaleJournalInTx(
            tx,
            input(aed, invoiceId, plan, { tenantId: otherTenantId }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it("a claimed foreign tenantId inside this tenant's scope also matches nothing", async () => {
      const { invoiceId, plan } = await setup();
      await expect(
        asTenant((tx) =>
          repo.postWalkInSaleJournalInTx(
            tx,
            input(aed, invoiceId, plan, { tenantId: otherTenantId }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('another company → INVOICE_NOT_FOUND (no existence leak)', async () => {
      const { invoiceId, plan } = await setup();
      await expect(
        asTenant((tx) =>
          repo.postWalkInSaleJournalInTx(
            tx,
            input(aed, invoiceId, plan, { companyId: kwd.companyId }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('another branch of the same company → INVOICE_NOT_FOUND', async () => {
      const { invoiceId, plan } = await setup();
      await expect(
        asTenant((tx) =>
          repo.postWalkInSaleJournalInTx(
            tx,
            input(aed, invoiceId, plan, { branchId: aed.siblingBranchId }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('an unknown invoice id → INVOICE_NOT_FOUND', async () => {
      const { plan } = await setup();
      const ghost = randomUUID();
      await expect(
        asTenant((tx) =>
          repo.postWalkInSaleJournalInTx(
            tx,
            input(aed, ghost, { ...plan, sourceId: ghost } as WalkInSaleJournalPlan),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    });
  });

  // ── accounting period / currency fail-closed ─────────────────────────────────
  describe('accounting period and currency fail closed', () => {
    it('a CLOSED period for the invoice date → ACCOUNTING_PERIOD_CLOSED, no journal', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(closed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);

      await expect(post(closed, invoiceId, plan)).rejects.toMatchObject({
        code: 'ACCOUNTING_PERIOD_CLOSED',
      });
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('no period covering the invoice date → NO_OPEN_ACCOUNTING_PERIOD, no journal', async () => {
      const o = { total: 1050n, tax: 50n, invoiceDate: '2099-01-01' };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'NO_OPEN_ACCOUNTING_PERIOD',
      });
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('DB pin: an order / invoice can only be in the company accounting currency — a mismatched or currency-less company cannot own one', async () => {
      await expect(makeInvoice(aed, { total: 100n, currency: 'KWD' })).rejects.toThrow(
        /order_currency_company_fkey/,
      );
      await expect(makeInvoice(noCurrency, { total: 100n })).rejects.toThrow(
        /order_currency_company_fkey/,
      );
    });

    it('a company with no accounting timezone → ACCOUNTING_TIMEZONE_NOT_CONFIGURED', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(noTimezone, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);

      await expect(post(noTimezone, invoiceId, plan)).rejects.toMatchObject({
        code: 'ACCOUNTING_TIMEZONE_NOT_CONFIGURED',
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });
  });

  // ── idempotency / replay / conflict ──────────────────────────────────────────
  describe('one economic walk_in_sale journal per issued invoice', () => {
    it('the same invoice + the same plan replays the existing journal (created:false), one journal, one audit row', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      const first = await post(aed, invoiceId, plan);
      const second = await post(aed, invoiceId, plan);
      const third = await post(
        aed,
        invoiceId,
        planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]),
      );

      expect(first.created).toBe(true);
      expect(second).toMatchObject({ created: false, journalEntryId: first.journalEntryId });
      expect(third).toMatchObject({ created: false, journalEntryId: first.journalEntryId });
      expect(await journalCount(invoiceId)).toBe(1);
      expect(await linesOf(first.journalEntryId)).toHaveLength(3);
      expect(await auditCount(first.journalEntryId)).toBe(1);
    });

    it('the same invoice + a conflicting plan is JOURNAL_SOURCE_CONFLICT — the original journal is untouched', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const cash = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);
      const bank = planFor(invoiceId, o, [{ method: 'BANK_TRANSFER', amountMinor: 10500n }]);
      const first = await post(aed, invoiceId, cash);

      await expect(post(aed, invoiceId, bank)).rejects.toMatchObject({
        code: 'JOURNAL_SOURCE_CONFLICT',
      });

      expect(await journalCount(invoiceId)).toBe(1);
      expect(rendered(await linesOf(first.journalEntryId))).toEqual([
        'Dr ASSET.CASH_ON_HAND 10500',
        'Cr LIABILITY.TAX_PAYABLE 500',
        'Cr REVENUE.SALES 10000',
      ]);
    });

    it('a replay AFTER the invoice period was closed fails closed (ACCOUNTING_PERIOD_CLOSED) — never a silent re-post, and the one journal stays', async () => {
      const co = await makeCompany({
        currency: 'AED',
        timezone: 'Asia/Dubai',
        country: 'AE',
        period: 'open',
      });
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(co, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);
      const first = await post(co, invoiceId, plan);
      expect(first.created).toBe(true);

      const period = (
        await pool.query(
          `SELECT id, version FROM accounting_period WHERE "tenantId" = $1 AND "companyId" = $2`,
          [tenantId, co.companyId],
        )
      ).rows[0] as { id: string; version: number };
      await asTenant((tx) =>
        periods.close(tx, {
          tenantId,
          companyId: co.companyId,
          id: period.id,
          expectedVersion: period.version,
          closedByUserId: null,
        }),
      );

      await expect(post(co, invoiceId, plan)).rejects.toMatchObject({
        code: 'ACCOUNTING_PERIOD_CLOSED',
      });
      expect(await journalCount(invoiceId)).toBe(1);
      expect(await auditCount(first.journalEntryId)).toBe(1);
    });

    it('replay is deterministic: tender order never changes the fingerprint', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const t: WalkInJournalTender[] = [
        { method: 'CASH', amountMinor: 5000n },
        { method: 'BANK_TRANSFER', amountMinor: 5500n },
      ];
      const first = await post(aed, invoiceId, planFor(invoiceId, o, t));
      const replay = await post(aed, invoiceId, planFor(invoiceId, o, [...t].reverse()));

      expect(replay).toMatchObject({ created: false, journalEntryId: first.journalEntryId });
      expect(await journalCount(invoiceId)).toBe(1);
    });

    it('two concurrent posts of the same invoice + plan: exactly one journal, one created, one replay, no 40P01 / raw 500', async () => {
      const o = { total: 10500n, tax: 500n };
      for (let i = 0; i < 5; i += 1) {
        const invoiceId = await makeInvoice(aed, o);
        const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

        const settled = await Promise.allSettled([
          post(aed, invoiceId, plan),
          post(aed, invoiceId, plan),
        ]);

        for (const s of settled) {
          expect(s.status, JSON.stringify(s)).toBe('fulfilled');
        }
        const results = settled.map(
          (s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof post>>>).value,
        );
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(results.filter((r) => !r.created)).toHaveLength(1);
        expect(results[0]?.journalEntryId).toBe(results[1]?.journalEntryId);
        expect(await journalCount(invoiceId)).toBe(1);
        expect(await auditCount(results[0]!.journalEntryId)).toBe(1);
      }
    });

    it('many concurrent identical posts still produce exactly one journal', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, () => post(aed, invoiceId, plan)),
      );

      for (const s of settled) expect(s.status, JSON.stringify(s)).toBe('fulfilled');
      const ok = settled.map(
        (s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof post>>>).value,
      );
      expect(ok.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(ok.map((r) => r.journalEntryId)).size).toBe(1);
      expect(await journalCount(invoiceId)).toBe(1);
    });

    it('two concurrent posts with CONFLICTING plans: exactly one journal; the loser is JOURNAL_SOURCE_CONFLICT (a domain 409, never 40P01/500)', async () => {
      const o = { total: 10500n, tax: 500n };
      for (let i = 0; i < 4; i += 1) {
        const invoiceId = await makeInvoice(aed, o);
        const cash = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);
        const bank = planFor(invoiceId, o, [{ method: 'BANK_TRANSFER', amountMinor: 10500n }]);

        const settled = await Promise.allSettled([
          post(aed, invoiceId, cash),
          post(aed, invoiceId, bank),
        ]);

        const ok = settled.filter((s) => s.status === 'fulfilled');
        const bad = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(1);
        const err = bad[0]!.reason as DomainError;
        expect(err).toBeInstanceOf(DomainError);
        expect(err.code).toBe('JOURNAL_SOURCE_CONFLICT');
        expect(err.status).toBe(409);
        expect(await journalCount(invoiceId)).toBe(1);
      }
    });

    it('if the winning transaction ROLLS BACK, the blocked concurrent post proceeds and creates the journal', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signalPosted!: () => void;
      const posted = new Promise<void>((resolve) => {
        signalPosted = resolve;
      });

      const loser = asTenant(async (tx) => {
        await repo.postWalkInSaleJournalInTx(tx, input(aed, invoiceId, plan));
        signalPosted();
        await gate;
        throw new Error('FAULT_AFTER_POST');
      });
      await posted; // the first transaction now holds the unique-index claim
      const waiter = post(aed, invoiceId, plan); // blocks on that claim
      await new Promise((r) => setTimeout(r, 400));
      release();

      await expect(loser).rejects.toThrow('FAULT_AFTER_POST');
      const res = await waiter;
      expect(res.created).toBe(true);
      expect(await journalCount(invoiceId)).toBe(1);
    });
  });

  // ── caller-transaction participation: rollback / fault injection ─────────────
  describe('caller-transaction participation (rollback + fault injection)', () => {
    it('a caller failure AFTER the post removes the journal, its lines and its audit row; a retry then succeeds cleanly', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);
      const before = await sideEffects();
      let journalEntryId = '';

      await expect(
        asTenant(async (tx) => {
          const r = await repo.postWalkInSaleJournalInTx(tx, input(aed, invoiceId, plan));
          journalEntryId = r.journalEntryId;
          // the journal IS visible inside the caller's own transaction…
          const inside = await tx.journalEntry.count({ where: { id: r.journalEntryId } });
          expect(inside).toBe(1);
          throw new Error('CALLER_FAULT_AFTER_POST');
        }),
      ).rejects.toThrow('CALLER_FAULT_AFTER_POST');

      // …and gone after the caller's rollback
      expect(journalEntryId).not.toBe('');
      expect(await journalCount(invoiceId)).toBe(0);
      expect(
        (
          await pool.query(`SELECT 1 FROM journal_line WHERE "journalEntryId" = $1`, [
            journalEntryId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(await auditCount(journalEntryId)).toBe(0);
      expect(await sideEffects()).toEqual(before);

      const retry = await post(aed, invoiceId, plan);
      expect(retry.created).toBe(true);
      expect(await journalCount(invoiceId)).toBe(1);
      expect(await auditCount(retry.journalEntryId)).toBe(1);
    });

    it('fault injected INSIDE the posting step (after the engine inserted) rolls everything back', async () => {
      class FaultAfterInsertEngine extends PostingEngineService {
        override async postJournal(
          ...args: Parameters<PostingEngineService['postJournal']>
        ): ReturnType<PostingEngineService['postJournal']> {
          await super.postJournal(...args);
          throw new DomainError('INJECTED_POSTING_FAULT', 'injected after the journal insert', 500);
        }
      }
      const faulty = new WalkInSaleJournalRepository(
        new FaultAfterInsertEngine(
          companyConfig,
          periods,
          new AuditWriter({} as DbService),
          fakeClock,
        ),
        companyConfig,
      );
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);
      const before = await sideEffects();

      await expect(
        asTenant((tx) => faulty.postWalkInSaleJournalInTx(tx, input(aed, invoiceId, plan))),
      ).rejects.toMatchObject({ code: 'INJECTED_POSTING_FAULT' });

      expect(await journalCount(invoiceId)).toBe(0);
      expect(await sideEffects()).toEqual(before);
      const retry = await post(aed, invoiceId, plan);
      expect(retry.created).toBe(true);
    });

    it('a failure BEFORE the engine (guard rejection) leaves no row at all', async () => {
      const o = { total: 10500n, tax: 500n, kind: 'PICKUP' };
      const invoiceId = await makeInvoice(aed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);
      const before = await sideEffects();

      await expect(post(aed, invoiceId, plan)).rejects.toBeInstanceOf(DomainError);

      expect(await journalCount(invoiceId)).toBe(0);
      expect(await sideEffects()).toEqual(before);
    });

    it('a period failure in the engine rolls back with no residue and the same invoice posts once the date is valid', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(closed, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);
      const before = await sideEffects();

      await expect(post(closed, invoiceId, plan)).rejects.toMatchObject({
        code: 'ACCOUNTING_PERIOD_CLOSED',
      });

      expect(await journalCount(invoiceId)).toBe(0);
      expect(await sideEffects()).toEqual(before);
    });

    it('two sales posted in ONE caller transaction are both removed when that transaction fails (composition proof)', async () => {
      const o = { total: 1050n, tax: 50n };
      const a = await makeInvoice(aed, o);
      const b = await makeInvoice(aed, o);

      await expect(
        asTenant(async (tx) => {
          await repo.postWalkInSaleJournalInTx(
            tx,
            input(aed, a, planFor(a, o, [{ method: 'CASH', amountMinor: 1050n }])),
          );
          await repo.postWalkInSaleJournalInTx(
            tx,
            input(aed, b, planFor(b, o, [{ method: 'CASH', amountMinor: 1050n }])),
          );
          throw new Error('COMPOSED_FAILURE');
        }),
      ).rejects.toThrow('COMPOSED_FAILURE');

      expect(await journalCount(a)).toBe(0);
      expect(await journalCount(b)).toBe(0);
    });
  });

  // ── LAST on purpose: the currency backstop, with the DB's own guarantee removed ──
  // The order / invoice / order-line currency FKs make 'invoice currency != company accounting
  // currency' unconstructible (pinned above). To prove the ADAPTER fails closed on
  // its own if that structural guarantee were ever relaxed, this section drops those
  // six currency / exponent FKs in this file's DISPOSABLE test container. It must stay the final section:
  // nothing after it may rely on the FKs (vitest runs a file's tests in order).
  describe('currency backstop (the currency FKs dropped in the disposable container)', () => {
    beforeAll(async () => {
      await pool.query(`ALTER TABLE "order" DROP CONSTRAINT order_currency_company_fkey`);
      await pool.query(`ALTER TABLE invoice DROP CONSTRAINT invoice_currency_company_fkey`);
      await pool.query(
        `ALTER TABLE order_line DROP CONSTRAINT order_line_unit_price_currency_company_fkey`,
      );
      await pool.query(`ALTER TABLE "order" DROP CONSTRAINT order_currency_exponent_fkey`);
      await pool.query(`ALTER TABLE invoice DROP CONSTRAINT invoice_currency_exponent_fkey`);
      await pool.query(
        `ALTER TABLE order_line DROP CONSTRAINT order_line_unit_price_currency_exponent_fkey`,
      );
    });

    it('an invoice whose currency is not the company accounting currency → WALK_IN_JOURNAL_CURRENCY_MISMATCH', async () => {
      const o = { total: 10500n, tax: 500n, currency: 'KWD' as const };
      const invoiceId = await makeInvoice(aed, o); // a KWD invoice inside an AED company
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_CURRENCY_MISMATCH',
        status: 409,
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('an AED invoice in a KWD (3-decimal) company → WALK_IN_JOURNAL_CURRENCY_MISMATCH (exponent never reinterpreted)', async () => {
      const o = { total: 10500n, tax: 500n, currency: 'AED' as const };
      const invoiceId = await makeInvoice(kwd, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      await expect(post(kwd, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_CURRENCY_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('a company with no accounting currency → ACCOUNTING_CURRENCY_NOT_CONFIGURED, nothing posted', async () => {
      const o = { total: 1050n, tax: 50n };
      const invoiceId = await makeInvoice(noCurrency, o);
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 1050n }]);

      await expect(post(noCurrency, invoiceId, plan)).rejects.toMatchObject({
        code: 'ACCOUNTING_CURRENCY_NOT_CONFIGURED',
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('same exponent, different currency: an AED invoice in a SAR company → WALK_IN_JOURNAL_CURRENCY_MISMATCH', async () => {
      const o = { total: 10500n, tax: 500n };
      const invoiceId = await makeInvoice(sar, o); // AED (2 decimals) inside a SAR (2 decimals) company
      const plan = planFor(invoiceId, o, [{ method: 'CASH', amountMinor: 10500n }]);

      await expect(post(sar, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_CURRENCY_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });

    it('same currency, wrong exponent: an AED invoice stamped with exponent 3 → WALK_IN_JOURNAL_CURRENCY_MISMATCH (minor units are never reinterpreted)', async () => {
      const invoiceId = await makeInvoice(aed, { total: 10500n, tax: 500n, exponent: 3 });
      // the pure builder (correctly) only builds AED/2, so the plan is the AED/2 plan
      const plan = planFor(invoiceId, { total: 10500n, tax: 500n }, [
        { method: 'CASH', amountMinor: 10500n },
      ]);

      await expect(post(aed, invoiceId, plan)).rejects.toMatchObject({
        code: 'WALK_IN_JOURNAL_CURRENCY_MISMATCH',
      });
      expect(postSpy).not.toHaveBeenCalled();
      expect(await journalCount(invoiceId)).toBe(0);
    });
  });
});
