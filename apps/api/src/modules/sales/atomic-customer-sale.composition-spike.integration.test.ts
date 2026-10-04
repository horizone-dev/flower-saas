import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box composition spike — drives the FROZEN customer-linked primitives
// directly inside one caller transaction. Not production module code.
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
import { CustomerAdvanceApplicationRepository } from '../receivables/customer-advance-application.repository.js';
import { CustomerInvoiceArRepository } from '../receivables/customer-invoice-ar.repository.js';
import { CustomerReceiptEffectsRepository } from '../receivables/customer-receipt-effects.repository.js';
import { PaymentAdvanceConversionRepository } from '../receivables/payment-advance-conversion.repository.js';
import { PaymentCustomerAttributionRepository } from '../receivables/payment-customer-attribution.repository.js';
import { PaymentCollectionRepository } from '../payments/payment-collection.repository.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import type { DbService } from '../../common/data/index.js';

/**
 * Task 3b.9 Checkpoint D — COMPOSITION SPIKE for the identified-customer path
 * (run BEFORE any orchestrator code). Proves, against real PostgreSQL, that the
 * frozen 3b.6 primitives compose in ONE caller transaction and records the lock
 * order they actually take, so the hierarchy is established empirically before
 * anything is built on it:
 *
 *   issuance (credit gate + receivable + invoice_ar journal)
 *     → CustomerAdvance application (frozen `applyInTx`)
 *     → synchronous tender capture (frozen customer-receipt effects)
 *
 * No orchestrator exists in this file — it calls the primitives in sequence.
 */
type TxEvent =
  | { kind: 'sql'; text: string; values: unknown[] }
  | { kind: 'model'; name: string }
  | { kind: 'tx-control'; name: string };

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function observe(tx: ScopedTx, onEvent: (e: TxEvent) => void): ScopedTx {
  const textOf = (first: unknown): string => {
    if (typeof first === 'string') return norm(first);
    if (Array.isArray(first)) return norm((first as string[]).join('?'));
    return norm(((first as { strings?: string[] } | undefined)?.strings ?? []).join('?'));
  };
  return new Proxy(tx as unknown as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop !== 'string') return value;
      if (
        prop === '$queryRaw' ||
        prop === '$executeRaw' ||
        prop === '$queryRawUnsafe' ||
        prop === '$executeRawUnsafe'
      ) {
        return (first: unknown, ...values: unknown[]) => {
          onEvent({ kind: 'sql', text: textOf(first), values });
          return (value as (...a: unknown[]) => unknown).call(target, first, ...values);
        };
      }
      if (prop === '$transaction' || prop === '$connect' || prop === '$disconnect') {
        return (...a: unknown[]) => {
          onEvent({ kind: 'tx-control', name: prop });
          return (value as (...x: unknown[]) => unknown).apply(target, a);
        };
      }
      if (!prop.startsWith('$') && value !== null && typeof value === 'object') {
        return new Proxy(value as object, {
          get(delegate, op) {
            const f = Reflect.get(delegate, op, delegate) as unknown;
            if (typeof f === 'function' && typeof op === 'string') {
              return (...a: unknown[]) => {
                onEvent({ kind: 'model', name: `${prop}.${op}` });
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

function lockTrace(events: TxEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind === 'tx-control') {
      out.push(`TX-CONTROL:${e.name}`);
    } else if (e.kind === 'model') {
      if (
        /^(order\.update|invoice\.create|orderLine\.update|customerReceivable\.create|customerAdvanceApplication\.create)$/.test(
          e.name,
        )
      ) {
        out.push(e.name);
      }
    } else {
      const t = e.text;
      if (/FROM "order" .*FOR UPDATE/.test(t)) out.push('order:FOR UPDATE');
      else if (/FROM "order" .*FOR SHARE/.test(t)) out.push('order:FOR SHARE');
      else if (/FROM "order_line" .*FOR UPDATE/.test(t)) out.push('order_line:FOR UPDATE');
      else if (/FROM "customer_company_account" .*FOR UPDATE/.test(t))
        out.push('account:FOR UPDATE');
      else if (/FROM "customer_advance" .*FOR UPDATE/.test(t)) out.push('advance:FOR UPDATE');
      else if (/INSERT INTO "document_number_counter"/.test(t)) {
        out.push(`counter:${String(e.values.find((v) => v === 'ORDER' || v === 'INVOICE'))}`);
      } else if (/FROM "invoice" .*FOR UPDATE/.test(t)) out.push('invoice:FOR UPDATE');
      else if (/INSERT INTO "payment_attempt"/.test(t)) out.push('INSERT payment_attempt');
      else if (/INSERT INTO "payment" /.test(t)) out.push('INSERT payment');
      else if (/INSERT INTO "payment_allocation"/.test(t)) out.push('INSERT payment_allocation');
      else if (/FROM "company" .*FOR SHARE/.test(t)) out.push('company:FOR SHARE');
      else if (/FROM "accounting_period" .*FOR SHARE/.test(t))
        out.push('accounting_period:FOR SHARE');
      else if (/FOR UPDATE/.test(t)) out.push(`OTHER:FOR UPDATE:${t.slice(0, 70)}`);
    }
  }
  return out;
}

describe('Task 3b.9 Checkpoint D — composition spike (frozen customer primitives in ONE caller transaction)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let pool: pg.Pool;
  let observer: pg.Pool;

  let finalization: TaxFinalizationService;
  let collection: PaymentCollectionRepository;
  let advanceApplication: CustomerAdvanceApplicationRepository;
  let conversion: PaymentAdvanceConversionRepository;

  const tenantId = randomUUID();
  let companyId = '';
  let branchId = '';
  let productId = '';
  let variantId = '';
  let customerId = '';
  let ccaId = '';
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
    const outbox = new OutboxWriter(dummyDb);
    const accounts = new AccountRepository(dummyDb, audit);
    const periods = new AccountingPeriodRepository(dummyDb, audit);
    const companyConfig = new CompanyFinancialConfigRepository(dummyDb, audit, accounts);
    const engine = new PostingEngineService(companyConfig, periods, audit, fakeClock);
    const effects = new CustomerReceiptEffectsRepository(engine, audit);
    finalization = new TaxFinalizationService(
      new InvoiceIssuanceRepository(
        audit,
        fakeClock,
        new CustomerInvoiceArRepository(engine, audit),
      ),
    );
    collection = new PaymentCollectionRepository(
      audit,
      outbox,
      new PaymentCustomerAttributionRepository(),
      effects,
    );
    advanceApplication = new CustomerAdvanceApplicationRepository(engine, audit, effects, outbox);
    conversion = new PaymentAdvanceConversionRepository(
      engine,
      audit,
      new PaymentCustomerAttributionRepository(),
      outbox,
    );

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await pool.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `cspike-plan-${planId.slice(0, 8)}`,
    ]);
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
      [tenantId, `cspike-${tenantId.slice(0, 8)}`, planVersionId],
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
    customerId = randomUUID();
    ccaId = randomUUID();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Spike Customer',now())`,
      [customerId, tenantId],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","creditEnabled","creditLimitMinor","creditLimitCurrencyCode","creditLimitCurrencyExponent","updatedAt")
       VALUES ($1,$2,$3,$4,true,1000000,'AED',2,now())`,
      [ccaId, tenantId, companyId, customerId],
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

  /** a DRAFT customer-linked WALK_IN order: one line of `priceMinor`, tax-exclusive 5% */
  async function mkOrder(
    priceMinor: bigint,
  ): Promise<{ orderId: string; fingerprint: string; total: bigint }> {
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
        customerId,
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
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountAmountMinor",
          "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,'NONE',0,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [orderId, tenantId, companyId, branchId, customerId, fingerprint],
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
    return { orderId, fingerprint, total: priceMinor + (priceMinor * 500n + 5_000n) / 10_000n };
  }

  /** a genuine PAYMENT-sourced Advance: a raw, fully-unapplied CUSTOMER_RECEIPT payment converted by the
   *  REAL `PaymentAdvanceConversionRepository` (an OPENING advance is limited to one per account + branch) */
  async function mkAdvance(amountMinor: bigint): Promise<string> {
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7, now())`,
      [
        attemptId,
        tenantId,
        companyId,
        branchId,
        ccaId,
        amountMinor.toString(),
        `idem-${attemptId}`,
      ],
    );
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2)`,
      [paymentId, tenantId, companyId, branchId, attemptId, amountMinor.toString()],
    );
    const converted = await asTenant((tx) =>
      conversion.convertInTx(tx, {
        tenantId,
        companyId,
        branchId,
        customerId,
        paymentId,
        amountMinor,
        actorUserId: null,
      }),
    );
    return converted.advanceId;
  }

  const count = async (p: pg.Pool, table: string): Promise<number> =>
    (
      (await p.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [tenantId]))
        .rows[0] as { n: number }
    ).n;

  async function effects(p: pg.Pool): Promise<Record<string, number | string>> {
    const out: Record<string, number | string> = {};
    for (const t of [
      'invoice',
      'customer_receivable',
      'customer_account_entry',
      'customer_advance_application',
      'payment',
      'payment_allocation',
      'journal_entry',
      'journal_line',
      'audit_log',
      'outbox',
    ]) {
      out[t] = await count(p, t);
    }
    out['account'] = String(
      (
        await p.query(
          `SELECT "currentOutstandingMinor"::text || '/' || "advanceBalanceMinor"::text AS s FROM customer_company_account WHERE id = $1`,
          [ccaId],
        )
      ).rows[0].s,
    );
    out['counters'] = String(
      (
        await p.query(
          `SELECT string_agg("documentType" || ':' || "nextNumber"::text, ',' ORDER BY "documentType") AS s FROM document_number_counter WHERE "companyId" = $1`,
          [companyId],
        )
      ).rows[0].s,
    );
    return out;
  }

  /** the composed customer flow: issue (credit gate + AR) → advance → tender */
  async function composed(
    tx: ScopedTx,
    o: { orderId: string; fingerprint: string; total: bigint },
    p: {
      intent: 'PAY_NOW' | 'ON_CREDIT';
      advance?: { id: string; amount: bigint };
      tender?: bigint;
    },
  ) {
    const issued = await finalization.finalizeAndIssueInvoice(tx, {
      tenantId,
      companyId,
      branchId,
      orderId: o.orderId,
      expectedVersion: 1,
      commercialSnapshotFingerprint: o.fingerprint,
      paymentIntent: p.intent,
      actorUserId: actor,
    });
    if (p.advance) {
      await advanceApplication.applyInTx(tx, {
        tenantId,
        companyId,
        branchId,
        customerId,
        advanceId: p.advance.id,
        customerReceivableId: issued.customerReceivableId!,
        amountMinor: p.advance.amount,
        actorUserId: actor,
      });
    }
    if (p.tender) {
      await collection.captureSynchronousTendersInTx(tx, {
        tenantId,
        companyId,
        branchId,
        invoiceId: issued.invoiceId,
        amountMinor: p.tender,
        tenders: [{ method: 'CASH', amountMinor: p.tender }],
        createdByUserId: actor,
        actingUserId: actor,
        idempotencyKey: `cspike-${randomUUID()}`,
      });
    }
    return issued;
  }

  it('composes issuance (credit gate + AR) → advance application → tender capture in ONE transaction, with exactly the 3b.6 journals and NO walk_in_sale', async () => {
    const o = await mkOrder(10_000n); // total 10 500
    const advanceId = await mkAdvance(2_000n);
    const issued = await asTenant((tx) =>
      composed(tx, o, {
        intent: 'ON_CREDIT',
        advance: { id: advanceId, amount: 2_000n },
        tender: 3_500n,
      }),
    );

    const kinds = (
      await pool.query(
        `SELECT "sourceKind", count(*)::int AS n FROM journal_entry
          WHERE "tenantId" = $1 AND ("sourceId" = $4
             OR "sourceId" IN (SELECT id::text FROM payment_allocation WHERE "invoiceId" = $2)
             OR "sourceId" IN (SELECT "paymentId"::text FROM payment_allocation WHERE "invoiceId" = $2)
             OR "sourceId" IN (SELECT id::text FROM customer_advance_application WHERE "customerAdvanceId" = $3))
          GROUP BY "sourceKind" ORDER BY "sourceKind"`,
        [tenantId, issued.invoiceId, advanceId, issued.invoiceId],
      )
    ).rows as { sourceKind: string; n: number }[];
    expect(kinds).toEqual([
      { sourceKind: 'customer_advance_application', n: 1 },
      { sourceKind: 'customer_receipt_payment', n: 1 },
      { sourceKind: 'invoice_ar', n: 1 },
      { sourceKind: 'payment_allocation', n: 1 },
    ]);
    // ON_CREDIT remainder: 10 500 − 2 000 (advance) − 3 500 (cash) = 5 000 stays on the account
    const acct = (
      await pool.query(
        `SELECT "currentOutstandingMinor"::text AS o, "advanceBalanceMinor"::text AS a FROM customer_company_account WHERE id = $1`,
        [ccaId],
      )
    ).rows[0] as { o: string; a: string };
    expect(acct.o).toBe('5000');
    expect(acct.a).toBe('0');
  });

  it('NO primitive opens an independent transaction: nothing is visible to another connection mid-flight and a caller rollback removes everything', async () => {
    const o = await mkOrder(10_000n);
    const advanceId = await mkAdvance(1_000n);
    const before = await effects(observer);
    const events: TxEvent[] = [];
    let midFlight: Record<string, number | string> = {};

    await expect(
      asTenant(async (rawTx) => {
        await composed(
          observe(rawTx, (e) => events.push(e)),
          o,
          {
            intent: 'ON_CREDIT',
            advance: { id: advanceId, amount: 1_000n },
            tender: 2_000n,
          },
        );
        midFlight = await effects(observer);
        throw new Error('CALLER_ROLLBACK');
      }),
    ).rejects.toThrow('CALLER_ROLLBACK');

    expect(midFlight).toEqual(before);
    expect(events.filter((e) => e.kind === 'tx-control')).toEqual([]);
    expect(await effects(pool)).toEqual(before);
    // the very same order then completes (nothing was burned)
    await asTenant((tx) =>
      composed(tx, o, {
        intent: 'PAY_NOW',
        advance: { id: advanceId, amount: 1_000n },
        tender: 9_500n,
      }),
    );
  });

  it('the OBSERVED lock order of a customer sale with an advance and a tender is ORDER → LINES → ACCOUNT → numbering → INVOICE → ADVANCE → payments → GL (no inversion)', async () => {
    const o = await mkOrder(10_000n);
    const advanceId = await mkAdvance(2_000n);
    const events: TxEvent[] = [];
    await asTenant((tx) =>
      composed(
        observe(tx, (e) => events.push(e)),
        o,
        {
          intent: 'ON_CREDIT',
          advance: { id: advanceId, amount: 2_000n },
          tender: 3_500n,
        },
      ),
    );
    const trace = lockTrace(events);
    if (process.env['D_SPIKE_TRACE_FILE']) {
      (await import('node:fs')).writeFileSync(
        process.env['D_SPIKE_TRACE_FILE'],
        JSON.stringify(trace),
      );
    }
    const first = (label: string): number => trace.indexOf(label);
    const hierarchy = [
      'order:FOR UPDATE',
      'order_line:FOR UPDATE',
      'account:FOR UPDATE',
      'counter:ORDER',
      'counter:INVOICE',
      'invoice.create',
      'customerReceivable.create',
      'invoice:FOR UPDATE',
      'advance:FOR UPDATE',
      'customerAdvanceApplication.create',
      'INSERT payment_attempt',
      'INSERT payment',
      'INSERT payment_allocation',
    ];
    const positions = hierarchy.map((h) => first(h));
    expect(
      positions.every((p) => p >= 0),
      JSON.stringify(trace),
    ).toBe(true);
    expect(
      [...positions].sort((a, b) => a - b),
      JSON.stringify(trace),
    ).toEqual(positions);
    // the order is the very first lock; the account precedes numbering (the gate burns no number)
    expect(trace[0]).toBe('order:FOR UPDATE');
    expect(first('account:FOR UPDATE')).toBeLessThan(first('counter:ORDER'));
    // the invoice is only ever locked AFTER it exists
    expect(first('invoice:FOR UPDATE')).toBeGreaterThan(first('invoice.create'));
    // the advance is locked after the account and the invoice — the frozen 3b.6 order
    expect(first('advance:FOR UPDATE')).toBeGreaterThan(first('account:FOR UPDATE'));
    expect(first('advance:FOR UPDATE')).toBeGreaterThan(first('invoice:FOR UPDATE'));
    expect(trace.filter((t) => t.startsWith('OTHER:') || t.startsWith('TX-CONTROL'))).toEqual([]);
  });

  it('a customer PAY_NOW sale takes no credit gate and no walk-in journal, and the issuance already holds the account lock before any number', async () => {
    const o = await mkOrder(10_000n);
    const events: TxEvent[] = [];
    const issued = await asTenant((tx) =>
      composed(
        observe(tx, (e) => events.push(e)),
        o,
        { intent: 'PAY_NOW', tender: o.total },
      ),
    );
    const trace = lockTrace(events);
    expect(trace.indexOf('account:FOR UPDATE')).toBeLessThan(trace.indexOf('counter:ORDER'));
    expect(
      (
        await pool.query(
          `SELECT 1 FROM journal_entry WHERE "sourceKind" = 'walk_in_sale' AND "sourceId" = $1`,
          [issued.invoiceId],
        )
      ).rowCount,
    ).toBe(0);
    expect(issued.creditAuthorizationMode).toBeNull(); // the gate never ran
  });
});
