import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped, ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import {
  InvoiceIssuanceRepository,
  type IssueFinalInvoiceInput,
} from '../orders/invoice-issuance.repository.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import { CustomerInvoiceArRepository } from './customer-invoice-ar.repository.js';
import { OpeningBalanceRepository } from './opening-balance.repository.js';
import { CustomerReceiptEffectsRepository } from './customer-receipt-effects.repository.js';
import { CustomerReceiptCollectionRepository } from './customer-receipt-collection.repository.js';
import { PaymentAdvanceConversionRepository } from './payment-advance-conversion.repository.js';
import { PaymentCustomerAttributionRepository } from './payment-customer-attribution.repository.js';
import { CustomerAdvanceApplicationRepository } from './customer-advance-application.repository.js';
import { CustomerAccountReadRepository } from './customer-account-read.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { AccountRepository } from '../accounting/account.repository.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import type { DbService } from '../../common/data/index.js';

const TEST_POLICY = {
  taxPriceMode: 'TAX_EXCLUSIVE',
  taxRoundingScope: 'LINE',
  taxRoundingMode: 'HALF_UP',
} as const;

/**
 * Task 3b.6 Checkpoint G — the customer account read model, proven against
 * real Postgres, at the repository layer (`CustomerAccountReadRepository`
 * directly, mirroring `opening-balance-credit-concurrency.integration.test.ts`'s
 * own fixture harness). HTTP-layer authorization/isolation/pagination live in
 * the SEPARATE `customer-account-read.controller.integration.test.ts`.
 */
describe('CustomerAccountReadRepository (task 3b.6 Checkpoint G, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let client: pg.Client;
  let issuance: InvoiceIssuanceRepository;
  let openingBalance: OpeningBalanceRepository;
  let collection: CustomerReceiptCollectionRepository;
  let conversion: PaymentAdvanceConversionRepository;
  let application: CustomerAdvanceApplicationRepository;
  let read: CustomerAccountReadRepository;

  const tenantId = randomUUID();
  let companyId = '';
  let branchA = '';
  let branchB = '';
  let branchC = '';
  let productId = '';
  let variantId = '';

  function fakeClock(): SystemClock {
    return { now: () => new Date('2026-06-15T10:00:00Z') } as unknown as SystemClock;
  }

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runScoped(prisma, { tenantId }, fn);
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    client = new pg.Client({ connectionString: stack.postgres.url });
    await client.connect();

    const dummyDb = {} as unknown as DbService;
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        dummyDb,
        new AuditWriter(dummyDb),
        new AccountRepository(dummyDb, new AuditWriter(dummyDb)),
      ),
      new AccountingPeriodRepository(dummyDb, new AuditWriter(dummyDb)),
      new AuditWriter(dummyDb),
      fakeClock(),
    );
    const customerInvoiceAr = new CustomerInvoiceArRepository(
      postingEngine,
      new AuditWriter(dummyDb),
    );
    issuance = new InvoiceIssuanceRepository(
      new AuditWriter(dummyDb),
      fakeClock(),
      customerInvoiceAr,
    );
    openingBalance = new OpeningBalanceRepository(
      postingEngine,
      new CompanyFinancialConfigRepository(
        dummyDb,
        new AuditWriter(dummyDb),
        new AccountRepository(dummyDb, new AuditWriter(dummyDb)),
      ),
      new AuditWriter(dummyDb),
      new OutboxWriter(dummyDb),
    );
    const receiptEffects = new CustomerReceiptEffectsRepository(
      postingEngine,
      new AuditWriter(dummyDb),
    );
    collection = new CustomerReceiptCollectionRepository(
      new AuditWriter(dummyDb),
      new OutboxWriter(dummyDb),
      receiptEffects,
    );
    conversion = new PaymentAdvanceConversionRepository(
      postingEngine,
      new AuditWriter(dummyDb),
      new PaymentCustomerAttributionRepository(),
      new OutboxWriter(dummyDb),
    );
    application = new CustomerAdvanceApplicationRepository(
      postingEngine,
      new AuditWriter(dummyDb),
      receiptEffects,
      new OutboxWriter(dummyDb),
    );
    read = new CustomerAccountReadRepository();

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await client.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `car-plan-${planId.slice(0, 8)}`,
    ]);
    await client.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    await client.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
      [tenantId, `car-3b6-${tenantId.slice(0, 8)}`, planVersionId],
    );
    await client.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
       VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT (code) DO NOTHING`,
    );
    companyId = randomUUID();
    await client.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
       VALUES ($1,$2,'Test Co','AE','AED','Asia/Dubai',now())`,
      [companyId, tenantId],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await client.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          randomUUID(),
          tenantId,
          companyId,
          a.key,
          a.category,
          a.defaultDisplayCode,
          a.defaultDisplayName,
        ],
      );
    }
    await client.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2026-01-01','2026-12-31','OPEN',now())`,
      [randomUUID(), tenantId, companyId],
    );
    branchA = randomUUID();
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Branch A',now())`,
      [branchA, tenantId, companyId],
    );
    branchB = randomUUID();
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Branch B',now())`,
      [branchB, tenantId, companyId],
    );
    branchC = randomUUID();
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Branch C',now())`,
      [branchC, tenantId, companyId],
    );
    const categoryId = randomUUID();
    await client.query(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'flowers','Flowers',now())`,
      [categoryId, tenantId],
    );
    productId = randomUUID();
    await client.query(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy",status,"updatedAt")
       VALUES ($1,$2,$3,'rose','Rose','STOCKED','ACTIVE',now())`,
      [productId, tenantId, categoryId],
    );
    variantId = randomUUID();
    await client.query(
      `INSERT INTO variant (id,"tenantId","productId","nameEn",status,"baseUomCode","updatedAt")
       VALUES ($1,$2,$3,'Rose','ACTIVE','piece',now())`,
      [variantId, tenantId, productId],
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  // ── fixture helpers (mirrors opening-balance-credit-concurrency's own) ───
  async function mkCustomer(): Promise<{ customerId: string; ccaId: string }> {
    const customerId = randomUUID();
    await client.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Test Customer',now())`,
      [customerId, tenantId],
    );
    const ccaId = randomUUID();
    await client.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [ccaId, tenantId, companyId, customerId],
    );
    return { customerId, ccaId };
  }

  async function setCredit(
    customerId: string,
    opts: { creditEnabled: boolean; creditLimitMinor?: bigint | null },
  ): Promise<void> {
    const limitFields =
      opts.creditLimitMinor !== undefined && opts.creditLimitMinor !== null
        ? { minor: opts.creditLimitMinor, code: 'AED', exp: 2 }
        : { minor: null, code: null, exp: null };
    await client.query(
      `UPDATE customer_company_account
          SET "creditEnabled" = $1, "creditLimitMinor" = $2, "creditLimitCurrencyCode" = $3, "creditLimitCurrencyExponent" = $4
        WHERE "tenantId" = $5 AND "companyId" = $6 AND "customerId" = $7`,
      [
        opts.creditEnabled,
        limitFields.minor,
        limitFields.code,
        limitFields.exp,
        tenantId,
        companyId,
        customerId,
      ],
    );
  }

  function fingerprintFor(opts: {
    customerId: string | null;
    total: bigint;
    branchId: string;
  }): string {
    return computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId,
        originBranchId: opts.branchId,
        fulfillingBranchId: opts.branchId,
        customerId: opts.customerId,
        kind: 'WALK_IN',
        currencyCode: 'AED',
        lines: [
          {
            productId,
            variantId,
            quantity: '1.0000',
            selectedUomCode: 'piece',
            baseUomCode: 'piece',
            conversionNumerator: '1',
            conversionDenominator: '1',
            unitPriceAmountMinor: opts.total.toString(),
            unitPriceCurrencyCode: 'AED',
            unitPriceCurrencyExponent: 2,
            discountMode: 'NONE',
            discountBps: null,
            discountAmountMinor: '0',
            taxCategoryKey: null,
            rateBps: null,
            effectiveFrom: null,
            resolutionSource: 'NONE',
          },
        ],
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      },
      TEST_POLICY,
    );
  }

  async function mkOrder(
    customerId: string | null,
    totalAmountMinor: number,
    branchId = branchA,
  ): Promise<{ orderId: string; lineId: string; fingerprint: string }> {
    const orderId = randomUUID();
    const fingerprint = fingerprintFor({ customerId, total: BigInt(totalAmountMinor), branchId });
    await client.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,$7,$8,$9,now())`,
      [
        orderId,
        tenantId,
        companyId,
        branchId,
        customerId,
        fingerprint,
        TEST_POLICY.taxPriceMode,
        TEST_POLICY.taxRoundingScope,
        TEST_POLICY.taxRoundingMode,
      ],
    );
    const lineId = randomUUID();
    await client.query(
      `INSERT INTO order_line
         (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
          "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
          "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
          "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'NONE','piece','Piece','piece',1,1,'Rose','Rose',now())`,
      [lineId, tenantId, companyId, orderId, productId, variantId, totalAmountMinor],
    );
    return { orderId, lineId, fingerprint };
  }

  function issueInput(
    fixture: { orderId: string; lineId: string; fingerprint: string },
    branchId: string,
    totalAmountMinor: bigint,
  ): IssueFinalInvoiceInput {
    return {
      tenantId,
      companyId,
      branchId,
      orderId: fixture.orderId,
      expectedVersion: 1,
      commercialSnapshotFingerprint: fixture.fingerprint,
      paymentIntent: 'ON_CREDIT',
      lines: [
        {
          orderLineId: fixture.lineId,
          priceTaxMode: TEST_POLICY.taxPriceMode,
          roundingScope: TEST_POLICY.taxRoundingScope,
          roundingMode: TEST_POLICY.taxRoundingMode,
          lineTaxAmountMinor: 0n,
        },
      ],
      totals: {
        subtotalAmountMinor: totalAmountMinor,
        documentDiscountAmountMinor: 0n,
        taxTotalAmountMinor: 0n,
        totalAmountMinor,
        currencyCode: 'AED',
        currencyExponent: 2,
      },
    };
  }

  async function mkInvoice(
    customerId: string,
    totalAmountMinor: number,
    branchId = branchA,
  ): Promise<{ invoiceId: string }> {
    const fixture = await mkOrder(customerId, totalAmountMinor, branchId);
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, issueInput(fixture, branchId, BigInt(totalAmountMinor))),
    );
    return { invoiceId: result.invoiceId };
  }

  let idemN = 0;
  const ik = (): string => `car-key-${String(++idemN).padStart(6, '0')}`;

  function collect(customerId: string, amountMinor: bigint, branchId = branchA) {
    return asTenant((tx) =>
      collection.collectInTx(tx, {
        tenantId,
        companyId,
        branchId,
        customerId,
        amountMinor,
        method: 'CASH',
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: ik(),
      }),
    );
  }

  function createOpening(
    customerId: string,
    type: 'RECEIVABLE' | 'ADVANCE',
    amountMinor: bigint,
    branchId = branchA,
    effectiveDate = '2026-01-10',
  ) {
    return asTenant((tx) =>
      openingBalance.createInTx(tx, {
        tenantId,
        companyId,
        branchId,
        customerId,
        type,
        amountMinor,
        effectiveDate,
        actorUserId: null,
      }),
    );
  }

  function convertToAdvance(
    customerId: string,
    paymentId: string,
    amountMinor: bigint,
    branchId = branchA,
  ) {
    return asTenant((tx) =>
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
  }

  function applyAdvanceTo(
    customerId: string,
    advanceId: string,
    customerReceivableId: string,
    amountMinor: bigint,
    branchId = branchA,
  ) {
    return asTenant((tx) =>
      application.applyInTx(tx, {
        tenantId,
        companyId,
        branchId,
        customerId,
        advanceId,
        customerReceivableId,
        amountMinor,
      }),
    );
  }

  async function receivableIdForInvoice(invoiceId: string): Promise<string> {
    const { rows } = await client.query(
      `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    return rows[0].id;
  }

  function summary(customerId: string, branchId = branchA) {
    return asTenant((tx) => read.getSummary(tx, { tenantId, companyId, branchId, customerId }));
  }

  // ═══════════════════════════ G31 — rich account reconciliation ═══════════
  it('G31: a rich multi-source account reconciles exactly across Invoice/Opening/Advance/unapplied-receipt formulas', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });

    // Payment #1 on branch A with NOTHING open yet -> fully unapplied ->
    // converted entirely into a PAYMENT-sourced Advance = 400.
    const p1 = await collect(customerId, 400n, branchA);
    expect(p1.unallocatedAmountMinor).toBe(400n);
    const adv = await convertToAdvance(customerId, p1.paymentId, 400n, branchA);

    // Invoice = 1000 on branch A.
    const { invoiceId } = await mkInvoice(customerId, 1000, branchA);
    const receivableId = await receivableIdForInvoice(invoiceId);

    // Advance application = 200 against the Invoice (explicit, not FIFO).
    await applyAdvanceTo(customerId, adv.advanceId, receivableId, 200n, branchA);

    // Receipt = 300 against the (only-open) Invoice -> PaymentAllocation=300.
    const p2 = await collect(customerId, 300n, branchA);
    expect(p2.allocatedAmountMinor).toBe(300n);
    expect(p2.unallocatedAmountMinor).toBe(0n);

    // Opening Receivable = 500 on branch B (a SEPARATE branch — FIFO queues
    // are branch-scoped, so this cannot compete with Invoice's own queue).
    await createOpening(customerId, 'RECEIVABLE', 500n, branchB);
    const p3 = await collect(customerId, 100n, branchB);
    expect(p3.allocatedAmountMinor).toBe(100n);

    // A pure unapplied receipt = 150 on branch C, where nothing is open.
    const p4 = await collect(customerId, 150n, branchC);
    expect(p4.unallocatedAmountMinor).toBe(150n);

    // Per-branch headline (G's Absolute Final Freeze Gate §1) — NEVER a
    // company-wide blend. branchA carries the Invoice+its own Advance;
    // branchB carries the Opening; branchC carries only the pure leftover.
    const sA = await summary(customerId, branchA);
    expect(sA.branchFinancials.receivableOutstandingMinor).toBe(500n); // 1000-300-200
    expect(sA.branchFinancials.openReceivableCount).toBe(1);
    expect(sA.branchFinancials.advanceAvailableMinor).toBe(200n); // 400-200
    expect(sA.branchFinancials.openAdvanceCount).toBe(1);
    expect(sA.branchFinancials.unappliedReceiptMinor).toBe(0n);

    const sB = await summary(customerId, branchB);
    expect(sB.branchFinancials.receivableOutstandingMinor).toBe(400n); // 500-100
    expect(sB.branchFinancials.openReceivableCount).toBe(1);
    expect(sB.branchFinancials.advanceAvailableMinor).toBe(0n);
    expect(sB.branchFinancials.unappliedReceiptMinor).toBe(0n);

    const sC = await summary(customerId, branchC);
    expect(sC.branchFinancials.receivableOutstandingMinor).toBe(0n);
    expect(sC.branchFinancials.advanceAvailableMinor).toBe(0n);
    expect(sC.branchFinancials.unappliedReceiptMinor).toBe(150n); // the pure leftover

    // Company-wide credit is a SEPARATE, explicitly-scoped concept — the sum
    // across ALL THREE branches (500+400+0=900), never any one branch's own
    // headline number.
    for (const s of [sA, sB, sC]) {
      expect(s.credit.scope).toBe('COMPANY');
      expect(s.credit.creditExposureMinor).toBe(900n);
      expect(s.credit.creditEnabled).toBe(true);
      expect(s.credit.creditLimitMinor).toBeNull();
      expect(s.credit.availableCreditMinor).toBeNull(); // unlimited -> null, never a fake number
      expect(s.credit.projectionIntegrity.receivableProjectionMatches).toBe(true);
      expect(s.credit.projectionIntegrity.advanceProjectionMatches).toBe(true);
    }
  });

  it("G's Absolute Final Freeze Gate §4: ONE CustomerCompanyAccount with independent activity in TWO branches — each branch's summary returns ONLY its own totals (300/50/25 vs 700/100/40), never the other branch's or the sum", async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });

    // Per branch: (1) collect the Advance-source Payment and convert it —
    // nothing is open yet, so it is never FIFO-consumed; (2) collect the
    // pure-unapplied Payment and leave it unconverted/unapplied — again
    // nothing is open yet; (3) create the Opening Receivable LAST, so it
    // can never retroactively absorb either of the two prior receipts
    // (`collectInTx` only allocates against what is open AT THE INSTANT OF
    // COLLECTION — a receivable created afterward is untouched by it).
    const advPaymentA = await collect(customerId, 50n, branchA);
    await convertToAdvance(customerId, advPaymentA.paymentId, 50n, branchA);
    await collect(customerId, 25n, branchA); // stays unapplied
    await createOpening(customerId, 'RECEIVABLE', 300n, branchA);

    const advPaymentB = await collect(customerId, 100n, branchB);
    await convertToAdvance(customerId, advPaymentB.paymentId, 100n, branchB);
    await collect(customerId, 40n, branchB); // stays unapplied
    await createOpening(customerId, 'RECEIVABLE', 700n, branchB);

    const sA = await summary(customerId, branchA);
    expect(sA.branchFinancials.receivableOutstandingMinor).toBe(300n);
    expect(sA.branchFinancials.advanceAvailableMinor).toBe(50n);
    expect(sA.branchFinancials.unappliedReceiptMinor).toBe(25n);

    const sB = await summary(customerId, branchB);
    expect(sB.branchFinancials.receivableOutstandingMinor).toBe(700n);
    expect(sB.branchFinancials.advanceAvailableMinor).toBe(100n);
    expect(sB.branchFinancials.unappliedReceiptMinor).toBe(40n);

    // Neither branch's own headline is ever the OTHER branch's number, and
    // never the naive sum (300+700=1000, 50+100=150, 25+40=65) either.
    expect(sA.branchFinancials.receivableOutstandingMinor).not.toBe(1000n);
    expect(sA.branchFinancials.advanceAvailableMinor).not.toBe(150n);
    expect(sA.branchFinancials.unappliedReceiptMinor).not.toBe(65n);
    expect(sB.branchFinancials.receivableOutstandingMinor).not.toBe(1000n);

    // Company credit exposure legitimately spans both branches (300+700=1000).
    expect(sA.credit.creditExposureMinor).toBe(1000n);
    expect(sB.credit.creditExposureMinor).toBe(1000n);
    expect(sA.credit.scope).toBe('COMPANY');
  });

  it('G31/1: an empty account (no receivables/advances/payments at all) summarizes to all-zero, not an error', async () => {
    const { customerId } = await mkCustomer();
    const s = await summary(customerId);
    expect(s.branchFinancials.receivableOutstandingMinor).toBe(0n);
    expect(s.branchFinancials.advanceAvailableMinor).toBe(0n);
    expect(s.branchFinancials.unappliedReceiptMinor).toBe(0n);
    expect(s.branchFinancials.openReceivableCount).toBe(0);
    expect(s.branchFinancials.openAdvanceCount).toBe(0);
    expect(s.credit.creditEnabled).toBe(false);
    expect(s.credit.availableCreditMinor).toBeNull();
    expect(s.credit.projectionIntegrity).toEqual({
      receivableProjectionMatches: true,
      advanceProjectionMatches: true,
    });
  });

  it('G9: bounded credit (company-scoped) — creditLimit=1000, exposure=300 -> availableCreditMinor=700', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });
    await mkInvoice(customerId, 300, branchA);
    const s = await summary(customerId, branchA);
    expect(s.branchFinancials.receivableOutstandingMinor).toBe(300n);
    expect(s.credit.creditExposureMinor).toBe(300n);
    expect(s.credit.availableCreditMinor).toBe(700n);
  });

  it('G9: an unapplied Payment remainder never reduces creditExposure/availableCredit', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: 1000n });
    await mkInvoice(customerId, 300, branchA);
    await collect(customerId, 900n, branchA); // 300 to invoice, 600 unapplied
    const s = await summary(customerId, branchA);
    expect(s.branchFinancials.receivableOutstandingMinor).toBe(0n); // invoice fully closed
    expect(s.branchFinancials.unappliedReceiptMinor).toBe(600n);
    // exposure is 0 (invoice closed) -> full 1000 available regardless of the
    // 600 sitting unapplied.
    expect(s.credit.creditExposureMinor).toBe(0n);
    expect(s.credit.availableCreditMinor).toBe(1000n);
  });

  // ═══════════════════════════ G10 — receivables list ═══════════════════════
  it('G10: an open INVOICE receivable and a partially-settled OPENING receivable both list correctly; a fully-closed one is CLOSED', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    const { invoiceId } = await mkInvoice(customerId, 400, branchA);
    await collect(customerId, 400n, branchA); // fully closes the invoice
    await createOpening(customerId, 'RECEIVABLE', 500n, branchB);
    await collect(customerId, 200n, branchB); // partial

    // G's Absolute Final Freeze Gate §9 — this is an OPEN-receivables
    // endpoint: the fully-closed Invoice on branch A must NOT be returned
    // at all (never a row with a zero outstandingMinor as a substitute for
    // exclusion).
    const invRows = await asTenant((tx) =>
      read.listReceivables(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    expect(invRows.data).toHaveLength(0);
    void invoiceId;

    const openRows = await asTenant((tx) =>
      read.listReceivables(tx, { tenantId, companyId, branchId: branchB, customerId }),
    );
    expect(openRows.data).toHaveLength(1);
    expect(openRows.data[0]!.sourceType).toBe('OPENING');
    expect(openRows.data[0]!.outstandingMinor).toBe(300n);
    expect(openRows.data[0]!.openingEffectiveDate).toBe('2026-01-10');
  });

  // ═══════════════════════════ G11 — advances list ═══════════════════════════
  it('G11: a PAYMENT-sourced advance lists its available remainder; a FULLY-applied advance is excluded entirely (open-advances-only contract, §10)', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    const p = await collect(customerId, 300n, branchA);
    const adv = await convertToAdvance(customerId, p.paymentId, 300n, branchA);
    const { invoiceId } = await mkInvoice(customerId, 1000, branchA);
    const receivableId = await receivableIdForInvoice(invoiceId);
    await applyAdvanceTo(customerId, adv.advanceId, receivableId, 200n, branchA); // PARTIAL — 100 remains

    const partial = await asTenant((tx) =>
      read.listAdvances(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    expect(partial.data).toHaveLength(1);
    expect(partial.data[0]!.sourceType).toBe('PAYMENT');
    expect(partial.data[0]!.sourcePaymentId).toBe(p.paymentId);
    expect(partial.data[0]!.originalAmountMinor).toBe(300n);
    expect(partial.data[0]!.appliedAmountMinor).toBe(200n);
    expect(partial.data[0]!.availableAmountMinor).toBe(100n);

    await applyAdvanceTo(customerId, adv.advanceId, receivableId, 100n, branchA); // now fully applied
    const full = await asTenant((tx) =>
      read.listAdvances(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    expect(full.data).toHaveLength(0); // fully-consumed advance is excluded, never zero-available
  });

  // ═══════════════════════════ G8/G35 — unapplied receipts + attribution ════
  it('G8: a fully-consumed Payment is excluded from the unapplied-receipts list; a partially-consumed one shows its remainder', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await mkInvoice(customerId, 100, branchA);
    const full = await collect(customerId, 100n, branchA); // fully consumed
    const partial = await collect(customerId, 250n, branchA); // 0 open now -> fully unapplied
    void full;

    const rows = await asTenant((tx) =>
      read.listUnappliedReceipts(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]!.paymentId).toBe(partial.paymentId);
    expect(rows.data[0]!.unappliedAmountMinor).toBe(250n);
  });

  it('G35: a walk-in Payment (no customer on its Order) never appears in any customer read', async () => {
    const { customerId } = await mkCustomer();
    // a genuine walk-in order/invoice — customerId NULL.
    const fixture = await mkOrder(null, 100, branchA);
    const walkInResult = await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, {
        ...issueInput(fixture, branchA, 100n),
        paymentIntent: 'PAY_NOW',
      }),
    );
    void walkInResult;
    // a CUSTOMER_RECEIPT-purpose collection for a DIFFERENT, real customer,
    // to prove attribution is positive-matched, not merely "any Payment row
    // exists at this branch".
    await mkCustomer().then(({ customerId: other }) => collect(other, 50n, branchA));

    const rows = await asTenant((tx) =>
      read.listUnappliedReceipts(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    expect(rows.data).toHaveLength(0);
    const s = await summary(customerId);
    expect(s.branchFinancials.unappliedReceiptMinor).toBe(0n);
  });

  // ═══════════════════════════ G34 — projection mismatch ═════════════════════
  it('G34: a deliberately corrupted CustomerCompanyAccount (company-wide) projection is detected via company-wide recomputation; the branch headline stays authoritative and untouched; never auto-healed', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await mkInvoice(customerId, 700, branchA);
    // corrupt the projection directly (authoritative sources untouched).
    await client.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = 999999
        WHERE "tenantId" = $1 AND "companyId" = $2 AND "customerId" = $3`,
      [tenantId, companyId, customerId],
    );
    const s = await summary(customerId, branchA);
    // the branch headline is unaffected — it was never compared to this
    // (company-wide) projection in the first place.
    expect(s.branchFinancials.receivableOutstandingMinor).toBe(700n);
    // the mismatch is detected via the SEPARATE company-wide recomputation.
    expect(s.credit.creditExposureMinor).toBe(700n);
    expect(s.credit.projectionIntegrity.receivableProjectionMatches).toBe(false);
    // no auto-heal — re-reading the raw column still shows the corruption.
    const { rows } = await client.query(
      `SELECT "currentOutstandingMinor"::text FROM customer_company_account
        WHERE "tenantId" = $1 AND "companyId" = $2 AND "customerId" = $3`,
      [tenantId, companyId, customerId],
    );
    expect(rows[0].currentOutstandingMinor).toBe('999999');
  });

  // ═══════════════════════════ G39 — no write on GET ═════════════════════════
  it('G39: every read endpoint (summary/receivables/advances/unapplied-receipts/statement) creates zero rows anywhere', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await mkInvoice(customerId, 500, branchA);
    await createOpening(customerId, 'RECEIVABLE', 200n, branchB);

    async function snap() {
      const { rows } = await client.query(`SELECT
        (SELECT count(*)::int FROM payment) AS payment,
        (SELECT count(*)::int FROM payment_allocation) AS alloc,
        (SELECT count(*)::int FROM customer_receivable) AS recv,
        (SELECT count(*)::int FROM customer_advance) AS adv,
        (SELECT count(*)::int FROM customer_advance_application) AS advapp,
        (SELECT count(*)::int FROM customer_receivable_payment_application) AS recvpayapp,
        (SELECT count(*)::int FROM customer_account_entry) AS entry,
        (SELECT count(*)::int FROM journal_entry) AS journal,
        (SELECT count(*)::int FROM audit_log) AS audit,
        (SELECT count(*)::int FROM outbox) AS outbox`);
      return rows[0];
    }

    const before = await snap();
    await asTenant((tx) =>
      read.getSummary(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    await asTenant((tx) =>
      read.listReceivables(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    await asTenant((tx) =>
      read.listAdvances(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    await asTenant((tx) =>
      read.listUnappliedReceipts(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    const after = await snap();
    expect(after).toEqual(before);
  });

  // ═══════════════════════════ G32/G14/G15 — statement, all 8 kinds ══════════
  it('G32: all 8 CustomerAccountEntry kinds resolve on the statement with correct Money effects; PAYMENT never reduces AR, only PAYMENT_ALLOCATION does; ADVANCE never reduces AR, only ADVANCE_APPLIED does', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });

    // ADVANCE — collected on branch A while NOTHING is open there yet, so
    // it stays fully unapplied and converts cleanly (no FIFO interference).
    const p3 = await collect(customerId, 250n, branchA);
    const adv2 = await convertToAdvance(customerId, p3.paymentId, 250n, branchA); // ADVANCE

    // OPENING_ADVANCE (its own branch, own opening slot).
    const openAdv = await createOpening(customerId, 'ADVANCE', 300n, branchB, '2026-02-01'); // OPENING_ADVANCE
    await createOpening(customerId, 'RECEIVABLE', 1000n, branchC, '2026-02-01'); // OPENING_RECEIVABLE (separate branch — no opening-slot conflict)

    // INVOICE + PAYMENT + PAYMENT_ALLOCATION (branch A, after the Advance
    // already exists there — same-branch ADVANCE_APPLIED is now valid, E5).
    const { invoiceId } = await mkInvoice(customerId, 400, branchA); // INVOICE
    const receivableId = await receivableIdForInvoice(invoiceId);
    await applyAdvanceTo(customerId, adv2.advanceId, receivableId, 150n, branchA); // ADVANCE_APPLIED
    const receipt = await collect(customerId, 100n, branchA); // PAYMENT + PAYMENT_ALLOCATION

    const stA = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    const stB = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchB, customerId }),
    );
    const stC = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchC, customerId }),
    );
    const kinds = new Set([...stA.data, ...stB.data, ...stC.data].map((l) => l.entryKind));
    // OPENING_RECEIVABLE_PAYMENT_APPLIED needs an Opening receivable + a
    // direct-payment application — exercised separately below (G32/2) to
    // keep this scenario's branch/FIFO arithmetic tractable.
    expect(kinds.has('OPENING_RECEIVABLE')).toBe(true);
    expect(kinds.has('OPENING_ADVANCE')).toBe(true);
    expect(kinds.has('INVOICE')).toBe(true);
    expect(kinds.has('PAYMENT')).toBe(true);
    expect(kinds.has('PAYMENT_ALLOCATION')).toBe(true);
    expect(kinds.has('ADVANCE')).toBe(true);
    expect(kinds.has('ADVANCE_APPLIED')).toBe(true);

    const paymentLine = stA.data.find(
      (l) => l.entryKind === 'PAYMENT' && l.refs['paymentId'] === receipt.paymentId,
    )!;
    expect(paymentLine.receivableEffectMinor).toBe(0n);
    expect(paymentLine.unappliedReceiptEffectMinor).toBe(100n);
    const allocLine = stA.data.find((l) => l.entryKind === 'PAYMENT_ALLOCATION')!;
    expect(allocLine.receivableEffectMinor).toBe(-100n);
    expect(allocLine.unappliedReceiptEffectMinor).toBe(-100n);
    const advLine = stA.data.find((l) => l.entryKind === 'ADVANCE')!;
    expect(advLine.advanceEffectMinor).toBe(250n);
    expect(advLine.receivableEffectMinor).toBe(0n);
    const advAppliedLine = stA.data.find((l) => l.entryKind === 'ADVANCE_APPLIED')!;
    expect(advAppliedLine.advanceEffectMinor).toBe(-150n);
    expect(advAppliedLine.receivableEffectMinor).toBe(-150n);
    const openAdvLine = stB.data.find((l) => l.entryKind === 'OPENING_ADVANCE')!;
    expect(openAdvLine.advanceEffectMinor).toBe(300n);
    expect(openAdvLine.receivableEffectMinor).toBe(0n);
    void openAdv;
  });

  it('G32/2: OPENING_RECEIVABLE_PAYMENT_APPLIED resolves with the correct receivable+unapplied-receipt effect', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await createOpening(customerId, 'RECEIVABLE', 500n, branchA);
    await collect(customerId, 200n, branchA);
    const st = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    const line = st.data.find((l) => l.entryKind === 'OPENING_RECEIVABLE_PAYMENT_APPLIED')!;
    expect(line).toBeDefined();
    expect(line.receivableEffectMinor).toBe(-200n);
    expect(line.unappliedReceiptEffectMinor).toBe(-200n);
  });

  it('G33: an Opening Receivable with a HISTORICALLY EARLIER effectiveDate appears BEFORE a later-dated Invoice in the statement, even though it was created chronologically AFTER it', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    // Invoice first (chronologically), dated by the fixture Clock at 2026-06-15.
    await mkInvoice(customerId, 100, branchA);
    // Opening created SECOND but with a historical effectiveDate before the invoice.
    await createOpening(customerId, 'RECEIVABLE', 200n, branchA, '2026-01-01');

    const st = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    const openingIdx = st.data.findIndex((l) => l.entryKind === 'OPENING_RECEIVABLE');
    const invoiceIdx = st.data.findIndex((l) => l.entryKind === 'INVOICE');
    expect(openingIdx).toBeGreaterThanOrEqual(0);
    expect(invoiceIdx).toBeGreaterThanOrEqual(0);
    expect(openingIdx).toBeLessThan(invoiceIdx);
    expect(st.data[openingIdx]!.financialDate).toBe('2026-01-01');
  });

  it('G19/G20: `from` filters by financial date, and the opening state before `from` correctly excludes later events', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await createOpening(customerId, 'RECEIVABLE', 300n, branchA, '2026-01-01');
    await mkInvoice(customerId, 200, branchA); // financial date = 2026-06-15 (fixture Clock)

    const st = await asTenant((tx) =>
      read.getStatement(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        from: '2026-06-01',
      }),
    );
    expect(st.data.every((l) => l.financialDate >= '2026-06-01')).toBe(true);
    expect(st.data.some((l) => l.entryKind === 'OPENING_RECEIVABLE')).toBe(false);
    expect(st.data.some((l) => l.entryKind === 'INVOICE')).toBe(true);
    expect(st.openingState).not.toBeNull();
    expect(st.openingState!.receivableOutstandingMinor).toBe(300n); // the opening balance, pre-range
  });

  // ═════ G's Absolute Final Freeze Gate §6/§7/§8 — application financial dates ═════
  // `Payment`/`PaymentAllocation`/`CustomerReceivablePaymentApplication` are
  // ALL append-only + immutable (DB-enforced — confirmed by
  // `fn_enforce_payment_no_update` et al. rejecting even a same-value
  // UPDATE), so a realistic "backdate after creation" is impossible, by
  // design, for ANY of them. `PaymentAllocation`/`CustomerReceivablePayment
  // Application` are also ONLY ever created (in real production code,
  // `CustomerReceiptCollectionRepository.collectInTx`) at the SAME instant
  // as their source Payment — there is genuinely no repository primitive
  // that applies an ALREADY-EXISTING unapplied Payment to a receivable
  // later (unlike `CustomerAdvanceApplicationRepository`, which IS
  // explicit/delayed by design). To prove the READ MODEL correctly resolves
  // each event's OWN `createdAt` independently of the other, these tests
  // construct the full FK-valid row chain via raw SQL INSERT (never
  // UPDATE — fully respecting append-only), each row's `createdAt` supplied
  // explicitly at creation time with a deliberately different value. This
  // proves the read model's date-resolution logic; it is not a claim that
  // this exact write sequence is itself a supported production flow.
  async function rawBackdatedInvoiceReceipt(
    customerId: string,
    receivableId: string,
    amountMinor: number,
    paymentCreatedAt: string,
    allocationCreatedAt: string,
  ): Promise<{ paymentId: string }> {
    const cca = (
      await client.query(
        `SELECT id FROM customer_company_account WHERE "tenantId"=$1 AND "companyId"=$2 AND "customerId"=$3`,
        [tenantId, companyId, customerId],
      )
    ).rows[0].id as string;
    const attemptId = randomUUID();
    await client.query(
      `INSERT INTO payment_attempt (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7,$8,now())`,
      [
        attemptId,
        tenantId,
        companyId,
        branchA,
        cca,
        amountMinor,
        `rbir-${attemptId}`,
        paymentCreatedAt,
      ],
    );
    const paymentId = randomUUID();
    await client.query(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent","createdAt")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2,$7)`,
      [paymentId, tenantId, companyId, branchA, attemptId, amountMinor, paymentCreatedAt],
    );
    await client.query(
      `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","paymentId","occurredAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'PAYMENT',$5,$6)`,
      [tenantId, companyId, branchA, cca, paymentId, paymentCreatedAt],
    );
    const allocationId = randomUUID();
    await client.query(
      `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent","createdAt")
       SELECT $1,$2,$3,$4,$5,cr."invoiceId",$6,'AED',2,$7
         FROM customer_receivable cr WHERE cr.id = $8`,
      [
        allocationId,
        tenantId,
        companyId,
        branchA,
        paymentId,
        amountMinor,
        allocationCreatedAt,
        receivableId,
      ],
    );
    await client.query(
      `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","paymentAllocationId","occurredAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'PAYMENT_ALLOCATION',$5,$6)`,
      [tenantId, companyId, branchA, cca, allocationId, allocationCreatedAt],
    );
    return { paymentId };
  }

  async function rawBackdatedOpeningReceipt(
    customerId: string,
    receivableId: string,
    amountMinor: number,
    paymentCreatedAt: string,
    applicationCreatedAt: string,
  ): Promise<{ paymentId: string }> {
    const cca = (
      await client.query(
        `SELECT id FROM customer_company_account WHERE "tenantId"=$1 AND "companyId"=$2 AND "customerId"=$3`,
        [tenantId, companyId, customerId],
      )
    ).rows[0].id as string;
    const attemptId = randomUUID();
    await client.query(
      `INSERT INTO payment_attempt (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7,$8,now())`,
      [
        attemptId,
        tenantId,
        companyId,
        branchA,
        cca,
        amountMinor,
        `rbor-${attemptId}`,
        paymentCreatedAt,
      ],
    );
    const paymentId = randomUUID();
    await client.query(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent","createdAt")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2,$7)`,
      [paymentId, tenantId, companyId, branchA, attemptId, amountMinor, paymentCreatedAt],
    );
    await client.query(
      `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","paymentId","occurredAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'PAYMENT',$5,$6)`,
      [tenantId, companyId, branchA, cca, paymentId, paymentCreatedAt],
    );
    const applicationId = randomUUID();
    await client.query(
      `INSERT INTO customer_receivable_payment_application (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId","customerReceivableId","amountMinor","currencyCode","currencyExponent","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AED',2,$9)`,
      [
        applicationId,
        tenantId,
        companyId,
        branchA,
        cca,
        paymentId,
        receivableId,
        amountMinor,
        applicationCreatedAt,
      ],
    );
    await client.query(
      `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivablePaymentApplicationId","occurredAt")
       VALUES (uuidv7(),$1,$2,$3,$4,'OPENING_RECEIVABLE_PAYMENT_APPLIED',$5,$6)`,
      [tenantId, companyId, branchA, cca, applicationId, applicationCreatedAt],
    );
    return { paymentId };
  }

  it("G's Absolute Final Freeze Gate §7: PAYMENT_ALLOCATION uses its OWN createdAt, never the originating Payment's — both events land on their OWN correct day", async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    const { invoiceId } = await mkInvoice(customerId, 500, branchA);
    const receivableId = await receivableIdForInvoice(invoiceId);
    const { paymentId } = await rawBackdatedInvoiceReceipt(
      customerId,
      receivableId,
      300,
      '2026-06-01T09:00:00Z',
      '2026-06-20T09:00:00Z',
    );

    const st = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    const paymentLine = st.data.find(
      (l) => l.entryKind === 'PAYMENT' && l.refs['paymentId'] === paymentId,
    )!;
    const allocLine = st.data.find((l) => l.entryKind === 'PAYMENT_ALLOCATION')!;
    expect(paymentLine.financialDate).toBe('2026-06-01');
    expect(allocLine.financialDate).toBe('2026-06-20');
    expect(allocLine.financialDate).not.toBe(paymentLine.financialDate);
  });

  it("G's Absolute Final Freeze Gate §7: OPENING_RECEIVABLE_PAYMENT_APPLIED uses its OWN createdAt, never the originating Payment's", async () => {
    const { customerId } = await mkCustomer();
    const opening = await createOpening(customerId, 'RECEIVABLE', 500n, branchA);
    const { paymentId } = await rawBackdatedOpeningReceipt(
      customerId,
      opening.sourceId,
      200,
      '2026-06-01T09:00:00Z',
      '2026-06-20T09:00:00Z',
    );

    const st = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    const paymentLine = st.data.find(
      (l) => l.entryKind === 'PAYMENT' && l.refs['paymentId'] === paymentId,
    )!;
    const appliedLine = st.data.find((l) => l.entryKind === 'OPENING_RECEIVABLE_PAYMENT_APPLIED')!;
    expect(paymentLine.financialDate).toBe('2026-06-01');
    expect(appliedLine.financialDate).toBe('2026-06-20');
  });

  it("G's Absolute Final Freeze Gate §8: a date range from=Jun10..to=Jun30 excludes the Jun-1 PAYMENT line, includes the Jun-20 application line, and the pre-range opening state carries the Jun-1 unapplied balance forward", async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    const { invoiceId } = await mkInvoice(customerId, 500, branchA);
    const receivableId = await receivableIdForInvoice(invoiceId);
    await rawBackdatedInvoiceReceipt(
      customerId,
      receivableId,
      300,
      '2026-06-01T09:00:00Z',
      '2026-06-20T09:00:00Z',
    );

    const st = await asTenant((tx) =>
      read.getStatement(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        from: '2026-06-10',
        to: '2026-06-30',
      }),
    );
    expect(st.data.some((l) => l.entryKind === 'PAYMENT')).toBe(false); // Jun-1, excluded
    expect(st.data.some((l) => l.entryKind === 'PAYMENT_ALLOCATION')).toBe(true); // Jun-20, included
    // the Jun-1 PAYMENT's own +300 unapplied-receipt effect is carried into
    // the pre-range opening state, proving the filter uses each event's OWN
    // financial date, never the originating Payment date wrongly re-applied
    // to the allocation, and never dropping the pre-existing balance.
    expect(st.openingState).not.toBeNull();
    expect(st.openingState!.unappliedReceiptMinor).toBe(300n);
  });

  // ═════ G's Absolute Final Freeze Gate §12 — historical opening pre-range ════
  it("G's Absolute Final Freeze Gate §12: an Opening ADVANCE imported today with a historical effectiveDate is excluded from an in-range statement but its effect is carried in the pre-range opening state", async () => {
    const { customerId } = await mkCustomer();
    await createOpening(customerId, 'ADVANCE', 400n, branchA, '2026-01-01');

    const st = await asTenant((tx) =>
      read.getStatement(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        from: '2026-06-01',
      }),
    );
    expect(st.data.some((l) => l.entryKind === 'OPENING_ADVANCE')).toBe(false);
    expect(st.openingState).not.toBeNull();
    expect(st.openingState!.advanceAvailableMinor).toBe(400n);
  });

  // ═════ G's Absolute Final Freeze Gate §13 — statement pagination re-proof ════
  it("G's Absolute Final Freeze Gate §13: statement pagination — >1 page, no duplicate/missing event, stable ordering after the date correction", async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    for (let i = 0; i < 4; i++) {
      await mkInvoice(customerId, 10 + i, branchA);
    }
    const page1 = await asTenant((tx) =>
      read.getStatement(tx, { tenantId, companyId, branchId: branchA, customerId, limit: 2 }),
    );
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await asTenant((tx) =>
      read.getStatement(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        limit: 2,
        cursor: page1.nextCursor!,
      }),
    );
    expect(page2.data).toHaveLength(2);
    const allIds = [...page1.data, ...page2.data].map((l) => l.customerAccountEntryId);
    expect(new Set(allIds).size).toBe(4); // no duplicate, none missing
    // stable ordering: page 2's first row is never earlier than page 1's last.
    expect(page2.data[0]!.financialDate >= page1.data.at(-1)!.financialDate).toBe(true);
  });

  it('rejects an invalid date range (from > to)', async () => {
    const { customerId } = await mkCustomer();
    await expect(
      asTenant((tx) =>
        read.getStatement(tx, {
          tenantId,
          companyId,
          branchId: branchA,
          customerId,
          from: '2026-06-01',
          to: '2026-01-01',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE' });
  });

  // ═══════════════════════════ G3/G29 — isolation ════════════════════════════
  it("a receivable created on branch B is excluded from branch A's own receivables list", async () => {
    const { customerId } = await mkCustomer();
    await createOpening(customerId, 'RECEIVABLE', 100n, branchB);
    const rows = await asTenant((tx) =>
      read.listReceivables(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    expect(rows.data).toHaveLength(0);
  });

  it('an unknown customerId in this company/branch is rejected 404', async () => {
    await expect(
      asTenant((tx) =>
        read.getSummary(tx, {
          tenantId,
          companyId,
          branchId: branchA,
          customerId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND' });
  });

  it('an unknown branchId is rejected 404 BRANCH_NOT_FOUND', async () => {
    const { customerId } = await mkCustomer();
    await expect(
      asTenant((tx) =>
        read.getSummary(tx, {
          tenantId,
          companyId,
          branchId: randomUUID(),
          customerId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  });

  // ═══════════════════════════ pagination ════════════════════════════════════
  it('G37: receivables list pagination — page1/page2 have no duplicate/missing rows, in deterministic id order', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    for (let i = 0; i < 5; i++) {
      await mkInvoice(customerId, 10 + i, branchA);
    }
    const page1 = await asTenant((tx) =>
      read.listReceivables(tx, { tenantId, companyId, branchId: branchA, customerId, limit: 3 }),
    );
    expect(page1.data).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await asTenant((tx) =>
      read.listReceivables(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        limit: 3,
        cursor: page1.nextCursor!,
      }),
    );
    expect(page2.data).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const allIds = [...page1.data, ...page2.data].map((r) => r.customerReceivableId);
    expect(new Set(allIds).size).toBe(5);
  });

  it('rejects a malformed cursor', async () => {
    const { customerId } = await mkCustomer();
    await expect(
      asTenant((tx) =>
        read.listReceivables(tx, {
          tenantId,
          companyId,
          branchId: branchA,
          customerId,
          cursor: 'not-a-uuid',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('rejects a non-positive limit', async () => {
    const { customerId } = await mkCustomer();
    await expect(
      asTenant((tx) =>
        read.listReceivables(tx, { tenantId, companyId, branchId: branchA, customerId, limit: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LIMIT' });
  });

  // ═══════════════════════════ G22/G23/G24/G25 — ageing ══════════════════════
  it('G22/G23: ageDays is computed from Invoice.invoiceDate (NO due-date field exists anywhere in this schema — the frozen fallback basis) with no bucket invented, only a raw day count', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await mkInvoice(customerId, 100, branchA); // invoiceDate = fixture Clock's 2026-06-15
    const rows = await asTenant((tx) =>
      read.listReceivables(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        asOf: '2026-06-20',
      }),
    );
    expect(rows.data[0]!.ageDays).toBe(5);
    // no `bucket`/`0-30`/etc. field anywhere on the row — raw ageDays only.
    expect(Object.keys(rows.data[0]!)).not.toContain('bucket');
  });

  it('G25: ageing ages only the CURRENT outstanding amount, not the original amount', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await mkInvoice(customerId, 1000, branchA);
    await collect(customerId, 700n, branchA); // 300 remains outstanding
    const rows = await asTenant((tx) =>
      read.listReceivables(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        asOf: '2026-06-16',
      }),
    );
    expect(rows.data[0]!.outstandingMinor).toBe(300n);
    expect(rows.data[0]!.ageDays).toBe(1);
  });

  it('G9/G22: a fully-settled Invoice receivable is EXCLUDED entirely from the open-receivables list (never returned with ageDays=null as a substitute)', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    await mkInvoice(customerId, 100, branchA);
    await collect(customerId, 100n, branchA);
    const rows = await asTenant((tx) =>
      read.listReceivables(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        asOf: '2026-06-20',
      }),
    );
    expect(rows.data).toHaveLength(0);
  });

  it('G9/G23: a fully-settled OPENING receivable is EXCLUDED entirely from the open-receivables list', async () => {
    const { customerId } = await mkCustomer();
    await createOpening(customerId, 'RECEIVABLE', 200n, branchA);
    await collect(customerId, 200n, branchA);
    const rows = await asTenant((tx) =>
      read.listReceivables(tx, { tenantId, companyId, branchId: branchA, customerId }),
    );
    expect(rows.data).toHaveLength(0);
  });

  it('G15: a future-dated ageing basis clamps ageDays to 0, never a negative "overdue" count', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId, { creditEnabled: true, creditLimitMinor: null });
    // the fixture Clock issues the invoice at 2026-06-15 — an `asOf` BEFORE
    // that date is a future-dated basis relative to `asOf`.
    await mkInvoice(customerId, 100, branchA);
    const rows = await asTenant((tx) =>
      read.listReceivables(tx, {
        tenantId,
        companyId,
        branchId: branchA,
        customerId,
        asOf: '2026-06-10',
      }),
    );
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]!.ageDays).toBe(0);
  });
});
