import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box composition spike — drives the FROZEN primitives directly inside one
// caller transaction. Not production module code.
import { createPrismaClient, runScoped } from '@flower/db';
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import { AccountRepository } from '../accounting/account.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { InvoiceIssuanceRepository } from '../orders/invoice-issuance.repository.js';
import { TaxFinalizationService } from '../orders/tax-finalization.service.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import { CustomerInvoiceArRepository } from '../receivables/customer-invoice-ar.repository.js';
import { CustomerReceiptEffectsRepository } from '../receivables/customer-receipt-effects.repository.js';
import { PaymentCustomerAttributionRepository } from '../receivables/payment-customer-attribution.repository.js';
import { PaymentCollectionRepository } from '../payments/payment-collection.repository.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import type { DbService } from '../../common/data/index.js';
import { buildWalkInSaleJournal } from './walk-in-sale-journal.js';
import { WalkInSaleJournalRepository } from './walk-in-sale-journal.repository.js';

/**
 * Task 3b.9 Checkpoint C — COMPOSITION SPIKE (run BEFORE the orchestrator).
 *
 * Proves, against real PostgreSQL, that the four frozen primitives participate in
 * ONE caller transaction without any of them opening / committing an independent
 * transaction, that a caller rollback removes EVERY effect, that the lock order
 * they actually take is the frozen ORDER -> INVOICE hierarchy (no inversion), and
 * that an anonymous sale never enters customer AR accounting nor double-books
 * revenue (the walk-in journal is the ONLY sale-revenue journal):
 *
 *   1. canonical totals + invoice issuance   TaxFinalizationService.finalizeAndIssueInvoice
 *   2. synchronous local tender capture      PaymentCollectionRepository.captureSynchronousTendersInTx
 *   3. anonymous walk-in GL                  WalkInSaleJournalRepository.postWalkInSaleJournalInTx
 *
 * No orchestrator exists yet — this file calls the primitives in sequence itself.
 */

interface LogEntry {
  seq: number;
  kind: 'sql' | 'model' | 'tx-control';
  text: string;
  values: unknown[];
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** wraps a ScopedTx so every statement / model call / transaction-control call is recorded */
function instrument(tx: ScopedTx, log: LogEntry[]): ScopedTx {
  const push = (kind: LogEntry['kind'], text: string, values: unknown[] = []): void => {
    log.push({ seq: log.length, kind, text, values });
  };
  const textOf = (first: unknown): string => {
    if (typeof first === 'string') return norm(first);
    if (Array.isArray(first)) return norm((first as string[]).join('?'));
    const strings = (first as { strings?: string[] } | undefined)?.strings;
    return norm((strings ?? []).join('?'));
  };
  return new Proxy(tx as unknown as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop !== 'string') return value;
      if (prop === '$queryRaw' || prop === '$executeRaw') {
        return (first: unknown, ...values: unknown[]) => {
          push('sql', textOf(first), values);
          return (value as (...a: unknown[]) => unknown).call(target, first, ...values);
        };
      }
      if (prop === '$queryRawUnsafe' || prop === '$executeRawUnsafe') {
        return (first: unknown, ...values: unknown[]) => {
          push('sql', textOf(first), values);
          return (value as (...a: unknown[]) => unknown).call(target, first, ...values);
        };
      }
      if (prop === '$transaction' || prop === '$connect' || prop === '$disconnect') {
        return (...a: unknown[]) => {
          push('tx-control', prop);
          return (value as (...x: unknown[]) => unknown).apply(target, a);
        };
      }
      if (!prop.startsWith('$') && value !== null && typeof value === 'object') {
        return new Proxy(value as object, {
          get(delegate, op) {
            const f = Reflect.get(delegate, op, delegate) as unknown;
            if (typeof f === 'function' && typeof op === 'string') {
              return (...a: unknown[]) => {
                push('model', `${prop}.${op}`);
                return (f as (...x: unknown[]) => unknown).apply(delegate, a);
              };
            }
            return f;
          },
        });
      }
      return value;
    },
  }) as unknown as ScopedTx;
}

/** the lock-relevant events, in order, as short stable labels */
function lockTrace(log: LogEntry[]): string[] {
  const out: string[] = [];
  for (const e of log) {
    if (e.kind === 'tx-control') {
      out.push(`TX-CONTROL:${e.text}`);
      continue;
    }
    if (e.kind === 'model') {
      if (/^(order\.update|invoice\.create|orderLine\.update)$/.test(e.text)) out.push(e.text);
      continue;
    }
    const t = e.text;
    if (/FROM "order" .*FOR UPDATE/.test(t)) out.push('order:FOR UPDATE');
    else if (/FROM "order" .*FOR SHARE/.test(t)) out.push('order:FOR SHARE');
    else if (/FROM "order_line" .*FOR UPDATE/.test(t)) out.push('order_line:FOR UPDATE');
    else if (/INSERT INTO "document_number_counter"/.test(t)) {
      out.push(`counter:${String(e.values.find((v) => v === 'ORDER' || v === 'INVOICE'))}`);
    } else if (/FROM "invoice" .*FOR UPDATE/.test(t)) out.push('invoice:FOR UPDATE');
    else if (/INSERT INTO "payment_attempt"/.test(t)) out.push('INSERT payment_attempt');
    else if (/INSERT INTO "payment" /.test(t)) out.push('INSERT payment');
    else if (/INSERT INTO "payment_allocation"/.test(t)) out.push('INSERT payment_allocation');
    else if (/FROM "company" .*FOR SHARE/.test(t)) out.push('company:FOR SHARE');
    else if (/FROM "accounting_period" .*FOR SHARE/.test(t))
      out.push('accounting_period:FOR SHARE');
    else if (/FOR UPDATE/.test(t)) out.push(`OTHER:FOR UPDATE:${t.slice(0, 60)}`);
  }
  return out;
}

describe('Task 3b.9 Checkpoint C — composition spike (frozen primitives in ONE caller transaction)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let pool: pg.Pool;
  let observer: pg.Pool; // a SEPARATE connection pool — sees only committed state

  let finalization: TaxFinalizationService;
  let collection: PaymentCollectionRepository;
  let walkInJournal: WalkInSaleJournalRepository;

  const tenantId = randomUUID();
  let companyId = '';
  let branchId = '';
  let productId = '';
  let variantId = '';
  const actor = randomUUID();

  const asTenant = <T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> =>
    runScoped(prisma, { tenantId }, fn);
  const fakeClock = { now: () => new Date('2026-06-15T10:00:00Z') } as unknown as SystemClock;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    observer = new pg.Pool({ connectionString: stack.postgres.url, max: 2 });

    const dummyDb = {} as unknown as DbService;
    const audit = new AuditWriter(dummyDb);
    const accounts = new AccountRepository(dummyDb, audit);
    const periods = new AccountingPeriodRepository(dummyDb, audit);
    const companyConfig = new CompanyFinancialConfigRepository(dummyDb, audit, accounts);
    const engine = new PostingEngineService(companyConfig, periods, audit, fakeClock);
    const issuance = new InvoiceIssuanceRepository(
      audit,
      fakeClock,
      new CustomerInvoiceArRepository(engine, audit),
    );
    finalization = new TaxFinalizationService(issuance);
    collection = new PaymentCollectionRepository(
      audit,
      new OutboxWriter(dummyDb),
      new PaymentCustomerAttributionRepository(),
      new CustomerReceiptEffectsRepository(engine, audit),
    );
    walkInJournal = new WalkInSaleJournalRepository(engine, companyConfig);

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `spike-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
      [tenantId, `spike-${tenantId.slice(0, 8)}`, planVersionId],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
       VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT (code) DO NOTHING`,
    );
    companyId = randomUUID();
    branchId = randomUUID();
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Spike Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
      [companyId, tenantId],
    );
    await pool.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main',now())`,
      [branchId, tenantId, companyId],
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
    await asTenant((tx) => accounts.ensureDefaultAccounts(tx, { tenantId, companyId }));
    await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId,
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2026-06-30T00:00:00Z'),
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await observer?.end();
    await pool?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  /** one DRAFT anonymous WALK_IN order, tax-exclusive 5%, one line of `priceMinor` */
  async function mkOrder(
    priceMinor: bigint,
  ): Promise<{ orderId: string; fingerprint: string; total: bigint; tax: bigint }> {
    const lineFp = {
      productId,
      variantId,
      quantity: '1.0000',
      selectedUomCode: 'piece',
      baseUomCode: 'piece',
      conversionNumerator: '1',
      conversionDenominator: '1',
      unitPriceAmountMinor: priceMinor.toString(),
      unitPriceCurrencyCode: 'AED',
      unitPriceCurrencyExponent: 2,
      discountMode: 'NONE',
      discountBps: null,
      discountAmountMinor: '0',
      taxCategoryKey: 'STANDARD',
      rateBps: 500,
      effectiveFrom: '2020-01-01',
      resolutionSource: 'VARIANT',
    };
    const fingerprint = computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId: null,
        kind: 'WALK_IN',
        currencyCode: 'AED',
        lines: [lineFp],
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      },
      { taxPriceMode: 'TAX_EXCLUSIVE', taxRoundingScope: 'LINE', taxRoundingMode: 'HALF_UP' },
    );
    const orderId = randomUUID();
    await pool.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountAmountMinor",
          "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,'NONE',0,$5,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [orderId, tenantId, companyId, branchId, fingerprint],
    );
    await pool.query(
      `INSERT INTO order_line
         (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
          "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
          "discountMode","discountAmountMinor","taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
          "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
          "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'NONE',0,'STANDARD',500,'2020-01-01'::date,'VARIANT',
               'piece','Piece','piece',1,1,'Rose','Rose',now())`,
      [randomUUID(), tenantId, companyId, orderId, productId, variantId, priceMinor],
    );
    const tax = (priceMinor * 500n + 5_000n) / 10_000n; // 5%, HALF_UP — hand oracle
    return { orderId, fingerprint, total: priceMinor + tax, tax };
  }

  const count = async (p: pg.Pool, sql: string, params: unknown[]): Promise<number> =>
    ((await p.query(sql, params)).rows[0] as { n: number }).n;

  /** every table a sale touches — counts for THIS tenant, read on `p` */
  async function effects(p: pg.Pool): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [label, table] of [
      ['invoice', 'invoice'],
      ['payment_attempt', 'payment_attempt'],
      ['payment_attempt_event', 'payment_attempt_event'],
      ['payment', 'payment'],
      ['payment_allocation', 'payment_allocation'],
      ['journal_entry', 'journal_entry'],
      ['journal_line', 'journal_line'],
      ['audit_log', 'audit_log'],
      ['outbox', 'outbox'],
      ['customer_receivable', 'customer_receivable'],
      ['customer_account_entry', 'customer_account_entry'],
      ['customer_advance', 'customer_advance'],
    ] as const) {
      out[label] = await count(
        p,
        `SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`,
        [tenantId],
      );
    }
    return out;
  }

  async function orderState(orderId: string): Promise<string> {
    const r = await pool.query(`SELECT status, version, "orderNumber" FROM "order" WHERE id = $1`, [
      orderId,
    ]);
    const row = r.rows[0] as { status: string; version: number; orderNumber: string | null };
    return `${row.status}/v${row.version}/${row.orderNumber ?? 'null'}`;
  }

  async function counters(): Promise<string> {
    const r = await pool.query(
      `SELECT string_agg("documentType" || ':' || "nextNumber"::text, ',' ORDER BY "documentType") AS s
         FROM document_number_counter WHERE "tenantId" = $1 AND "companyId" = $2`,
      [tenantId, companyId],
    );
    return String((r.rows[0] as { s: string | null }).s);
  }

  /** the composed flow: issue -> capture -> walk-in journal, all on the caller's `tx` */
  async function composed(
    tx: ScopedTx,
    o: { orderId: string; fingerprint: string; total: bigint; tax: bigint },
    tenders: { method: 'CASH' | 'BANK_TRANSFER'; amountMinor: bigint }[],
  ) {
    const issued = await finalization.finalizeAndIssueInvoice(tx, {
      tenantId,
      companyId,
      branchId,
      orderId: o.orderId,
      expectedVersion: 1,
      commercialSnapshotFingerprint: o.fingerprint,
      paymentIntent: 'PAY_NOW',
      actorUserId: actor,
    });
    const captured = await collection.captureSynchronousTendersInTx(tx, {
      tenantId,
      companyId,
      branchId,
      invoiceId: issued.invoiceId,
      amountMinor: o.total,
      tenders,
      createdByUserId: actor,
      actingUserId: actor,
      idempotencyKey: `spike-${randomUUID()}`,
    });
    const plan = buildWalkInSaleJournal({
      invoiceId: issued.invoiceId,
      customerId: null,
      currencyCode: 'AED',
      currencyExponent: 2,
      totalAmountMinor: o.total,
      taxTotalAmountMinor: o.tax,
      tenders,
    });
    const journal = await walkInJournal.postWalkInSaleJournalInTx(tx, {
      tenantId,
      companyId,
      branchId,
      invoiceId: issued.invoiceId,
      plan,
      actorUserId: actor,
    });
    return { issued, captured, journal };
  }

  it('composes finalize+issue → capture → walk-in journal in ONE transaction, and every effect appears together on commit', async () => {
    const o = await mkOrder(10_000n);
    const before = await effects(pool);

    const res = await asTenant((tx) => composed(tx, o, [{ method: 'CASH', amountMinor: o.total }]));

    const after = await effects(pool);
    expect(after['invoice']! - before['invoice']!).toBe(1);
    expect(after['payment']! - before['payment']!).toBe(1);
    expect(after['payment_allocation']! - before['payment_allocation']!).toBe(1);
    expect(after['payment_attempt']! - before['payment_attempt']!).toBe(1);
    expect(after['journal_entry']! - before['journal_entry']!).toBe(1);
    expect(after['journal_line']! - before['journal_line']!).toBe(3);
    expect(res.journal.created).toBe(true);
    expect(res.captured.remainingAvailableToCollectMinor).toBe(0n);
    expect(await orderState(o.orderId)).toMatch(/^CONFIRMED\/v2\/ORD-\d{6}$/);
  });

  it('NO primitive opens, commits or rolls back an independent transaction: nothing is visible to another connection until the caller commits, and nothing survives a caller rollback', async () => {
    const o = await mkOrder(10_000n);
    const before = await effects(observer);
    const stateBefore = await orderState(o.orderId);
    const countersBefore = await counters();
    const log: LogEntry[] = [];
    let midFlight: Record<string, number> = {};

    await expect(
      asTenant(async (rawTx) => {
        const tx = instrument(rawTx, log);
        await composed(tx, o, [{ method: 'CASH', amountMinor: o.total }]);
        // all three primitives have run; a SEPARATE connection must see NOTHING of it
        midFlight = await effects(observer);
        throw new Error('CALLER_ROLLBACK_AFTER_ALL_PRIMITIVES');
      }),
    ).rejects.toThrow('CALLER_ROLLBACK_AFTER_ALL_PRIMITIVES');

    // (a) nothing committed independently while the caller's transaction was still open
    expect(midFlight).toEqual(before);
    // (b) no primitive asked the client for a transaction / connection of its own
    expect(log.filter((e) => e.kind === 'tx-control')).toEqual([]);
    // (c) the caller's rollback removed everything
    expect(await effects(pool)).toEqual(await effects(observer));
    expect(await effects(observer)).toEqual(before);
    expect(await orderState(o.orderId)).toBe(stateBefore);
    expect(await counters()).toBe(countersBefore);
    // …and the very same order then completes cleanly (nothing was burned)
    await asTenant((tx) => composed(tx, o, [{ method: 'CASH', amountMinor: o.total }]));
    expect(await orderState(o.orderId)).toMatch(/^CONFIRMED\/v2\//);
  });

  it('the OBSERVED lock order is the frozen hierarchy ORDER → ORDER LINES → numbering → INVOICE → payments → GL (no Invoice→Order inversion)', async () => {
    const o = await mkOrder(10_000n);
    const log: LogEntry[] = [];

    await asTenant((rawTx) =>
      composed(instrument(rawTx, log), o, [{ method: 'CASH', amountMinor: o.total }]),
    );

    const trace = lockTrace(log);
    const first = (label: string): number => trace.indexOf(label);
    // the ORDER is the very first lock of the whole sale
    expect(trace[0]).toBe('order:FOR UPDATE');
    // hierarchy, by first occurrence
    const hierarchy = [
      'order:FOR UPDATE',
      'order_line:FOR UPDATE',
      'orderLine.update',
      'counter:ORDER',
      'counter:INVOICE',
      'order.update',
      'invoice.create',
      'invoice:FOR UPDATE',
      'INSERT payment_attempt',
      'INSERT payment',
      'INSERT payment_allocation',
      'company:FOR SHARE',
    ];
    const positions = hierarchy.map((h) => first(h));
    expect(
      positions.every((p) => p >= 0),
      JSON.stringify(trace),
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // no Invoice row lock before the invoice exists, and none BEFORE the order lock
    expect(first('invoice:FOR UPDATE')).toBeGreaterThan(first('invoice.create'));
    expect(first('invoice:FOR UPDATE')).toBeGreaterThan(first('order:FOR UPDATE'));
    // the capture re-takes the order lock FOR SHARE (a no-op downgrade — the sale already
    // holds it FOR UPDATE) BEFORE its invoice lock: ORDER → INVOICE, exactly the frozen F4 order
    expect(first('order:FOR SHARE')).toBeLessThan(first('invoice:FOR UPDATE'));
    // the two company counters are always taken ORDER then INVOICE
    expect(first('counter:ORDER')).toBeLessThan(first('counter:INVOICE'));
    // no unexpected row lock anywhere else
    expect(trace.filter((t) => t.startsWith('OTHER:'))).toEqual([]);
    // the GL shared locks come last
    expect(first('company:FOR SHARE')).toBeGreaterThan(first('INSERT payment_allocation'));
  });

  it('an ANONYMOUS invoice never enters customer AR accounting: no receivable, account entry, advance or AR journal', async () => {
    const o = await mkOrder(10_000n);
    const before = await effects(pool);

    const res = await asTenant((tx) => composed(tx, o, [{ method: 'CASH', amountMinor: o.total }]));

    const after = await effects(pool);
    expect(res.issued.customerReceivableId).toBeNull();
    expect(after['customer_receivable']).toBe(before['customer_receivable']);
    expect(after['customer_account_entry']).toBe(before['customer_account_entry']);
    expect(after['customer_advance']).toBe(before['customer_advance']);
    const lines = (
      await pool.query(
        `SELECT a."key" FROM journal_line jl JOIN account a ON a.id = jl."accountId"
          WHERE jl."journalEntryId" = $1`,
        [res.journal.journalEntryId],
      )
    ).rows.map((r: { key: string }) => r.key);
    expect(lines.sort()).toEqual(['ASSET.CASH_ON_HAND', 'LIABILITY.TAX_PAYABLE', 'REVENUE.SALES']);
  });

  it('tender capture on an anonymous invoice posts NO journal — the walk-in journal is the ONLY sale-revenue GL', async () => {
    const o = await mkOrder(10_000n);

    await asTenant(async (tx) => {
      const issued = await finalization.finalizeAndIssueInvoice(tx, {
        tenantId,
        companyId,
        branchId,
        orderId: o.orderId,
        expectedVersion: 1,
        commercialSnapshotFingerprint: o.fingerprint,
        paymentIntent: 'PAY_NOW',
        actorUserId: actor,
      });
      const journalsAfterIssue = await tx.journalEntry.count({ where: { tenantId } });
      await collection.captureSynchronousTendersInTx(tx, {
        tenantId,
        companyId,
        branchId,
        invoiceId: issued.invoiceId,
        amountMinor: o.total,
        tenders: [{ method: 'CASH', amountMinor: o.total }],
        createdByUserId: actor,
        actingUserId: actor,
        idempotencyKey: `spike-${randomUUID()}`,
      });
      // issuance and capture, TOGETHER, book no journal for an anonymous sale…
      expect(await tx.journalEntry.count({ where: { tenantId } })).toBe(journalsAfterIssue);
      expect(await tx.journalEntry.count({ where: { tenantId, sourceId: issued.invoiceId } })).toBe(
        0,
      );
      // …so the walk-in journal is the only one, and it books the revenue exactly once
      const plan = buildWalkInSaleJournal({
        invoiceId: issued.invoiceId,
        customerId: null,
        currencyCode: 'AED',
        currencyExponent: 2,
        totalAmountMinor: o.total,
        taxTotalAmountMinor: o.tax,
        tenders: [{ method: 'CASH', amountMinor: o.total }],
      });
      await walkInJournal.postWalkInSaleJournalInTx(tx, {
        tenantId,
        companyId,
        branchId,
        invoiceId: issued.invoiceId,
        plan,
        actorUserId: actor,
      });
      const revenue = await tx.$queryRaw<{ credit: bigint }[]>`
        SELECT COALESCE(SUM(jl."creditMinor"), 0)::bigint AS credit
          FROM journal_line jl
          JOIN journal_entry je ON je.id = jl."journalEntryId"
          JOIN account a ON a.id = jl."accountId"
         WHERE a."key" = 'REVENUE.SALES'
           AND (je."sourceId" = ${issued.invoiceId}
                OR je."sourceId" IN (SELECT id::text FROM payment WHERE "tenantId" = ${tenantId}::uuid))`;
      expect(revenue[0]!.credit).toBe(o.total - o.tax);
      const kinds = await tx.$queryRaw<{ sourceKind: string }[]>`
        SELECT "sourceKind" FROM journal_entry WHERE "sourceId" = ${issued.invoiceId}`;
      expect(kinds.map((k) => k.sourceKind)).toEqual(['walk_in_sale']);
    });
  });

  it('the composition shows NO incompatibility: every primitive left its own audit rows and the frozen payment outbox rows inside the same transaction', async () => {
    const o = await mkOrder(10_000n);
    const auditBefore = (
      await pool.query(
        `SELECT action, count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 GROUP BY action`,
        [tenantId],
      )
    ).rows as { action: string; n: number }[];
    const outboxBefore = (
      await pool.query(
        `SELECT "eventType", count(*)::int AS n FROM outbox WHERE "tenantId" = $1 GROUP BY "eventType"`,
        [tenantId],
      )
    ).rows as { eventType: string; n: number }[];

    await asTenant((tx) => composed(tx, o, [{ method: 'CASH', amountMinor: o.total }]));

    const delta = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      const a = (
        await pool.query(
          `SELECT action, count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 GROUP BY action`,
          [tenantId],
        )
      ).rows as { action: string; n: number }[];
      for (const r of a) {
        out[`audit:${r.action}`] = r.n - (auditBefore.find((x) => x.action === r.action)?.n ?? 0);
      }
      const ob = (
        await pool.query(
          `SELECT "eventType", count(*)::int AS n FROM outbox WHERE "tenantId" = $1 GROUP BY "eventType"`,
          [tenantId],
        )
      ).rows as { eventType: string; n: number }[];
      for (const r of ob) {
        out[`outbox:${r.eventType}`] =
          r.n - (outboxBefore.find((x) => x.eventType === r.eventType)?.n ?? 0);
      }
      return Object.fromEntries(Object.entries(out).filter(([, n]) => n !== 0));
    };
    expect(await delta()).toEqual({
      'audit:order.confirmed': 1,
      'audit:invoice.issued': 1,
      'audit:payment_attempt.state_changed': 1,
      'audit:payment.recorded': 1,
      'audit:accounting.journal_posted': 1,
      'outbox:payments.attempt_state_changed': 1,
      'outbox:payments.payment_recorded': 1,
    });
  });
});
