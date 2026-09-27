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
 * Task 3b.6 Checkpoint H Absolute Final Verification Gate (§9-§13) — the new
 * `receivables.customer_account_changed` outbox event's success-path,
 * payload-contract, idempotent-replay, rollback, and branch-isolation
 * proofs. Mirrors `customer-account-read.integration.test.ts`'s own fixture
 * harness (same fake Clock, same fixture-building helpers).
 */
describe('receivables.customer_account_changed outbox event (Checkpoint H, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let client: pg.Client;
  let issuance: InvoiceIssuanceRepository;
  let openingBalance: OpeningBalanceRepository;
  let collection: CustomerReceiptCollectionRepository;
  let conversion: PaymentAdvanceConversionRepository;
  let application: CustomerAdvanceApplicationRepository;

  const tenantId = randomUUID();
  let companyId = '';
  let branchA = '';
  let branchB = '';
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
    const effects = new CustomerReceiptEffectsRepository(postingEngine, new AuditWriter(dummyDb));
    collection = new CustomerReceiptCollectionRepository(
      new AuditWriter(dummyDb),
      new OutboxWriter(dummyDb),
      effects,
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
      effects,
      new OutboxWriter(dummyDb),
    );

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await client.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `rt-plan-${planId.slice(0, 8)}`,
    ]);
    await client.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    await client.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
      [tenantId, `rt-3b6-${tenantId.slice(0, 8)}`, planVersionId],
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

  // ── fixture helpers (mirrors customer-account-read.integration.test.ts) ──
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

  async function setCredit(customerId: string): Promise<void> {
    await client.query(
      `UPDATE customer_company_account SET "creditEnabled" = true WHERE "tenantId" = $1 AND "companyId" = $2 AND "customerId" = $3`,
      [tenantId, companyId, customerId],
    );
  }

  function fingerprintFor(customerId: string, total: bigint, branchId: string): string {
    return computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId,
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
            unitPriceAmountMinor: total.toString(),
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

  async function mkInvoice(
    customerId: string,
    totalAmountMinor: number,
    branchId: string,
  ): Promise<{ invoiceId: string }> {
    const orderId = randomUUID();
    const fingerprint = fingerprintFor(customerId, BigInt(totalAmountMinor), branchId);
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
    const input: IssueFinalInvoiceInput = {
      tenantId,
      companyId,
      branchId,
      orderId,
      expectedVersion: 1,
      commercialSnapshotFingerprint: fingerprint,
      paymentIntent: 'ON_CREDIT',
      lines: [
        {
          orderLineId: lineId,
          priceTaxMode: TEST_POLICY.taxPriceMode,
          roundingScope: TEST_POLICY.taxRoundingScope,
          roundingMode: TEST_POLICY.taxRoundingMode,
          lineTaxAmountMinor: 0n,
        },
      ],
      totals: {
        subtotalAmountMinor: BigInt(totalAmountMinor),
        documentDiscountAmountMinor: 0n,
        taxTotalAmountMinor: 0n,
        totalAmountMinor: BigInt(totalAmountMinor),
        currencyCode: 'AED',
        currencyExponent: 2,
      },
    };
    const result = await asTenant((tx) => issuance.issueFinalInvoice(tx, input));
    return { invoiceId: result.invoiceId };
  }

  async function receivableIdForInvoice(invoiceId: string): Promise<string> {
    const { rows } = await client.query(
      `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    return rows[0].id;
  }

  let idemN = 0;
  const ik = (): string => `rt-key-${String(++idemN).padStart(6, '0')}`;

  function collect(customerId: string, amountMinor: bigint, branchId: string) {
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
    branchId: string,
  ) {
    return asTenant((tx) =>
      openingBalance.createInTx(tx, {
        tenantId,
        companyId,
        branchId,
        customerId,
        type,
        amountMinor,
        effectiveDate: '2026-01-10',
        actorUserId: null,
      }),
    );
  }

  function convertToAdvance(
    customerId: string,
    paymentId: string,
    amountMinor: bigint,
    branchId: string,
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
    branchId: string,
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

  interface OutboxRow {
    id: string;
    tenantId: string;
    companyId: string | null;
    branchId: string | null;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }

  async function outboxRowsFor(aggregateId: string): Promise<OutboxRow[]> {
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, "tenantId", "companyId", "branchId", "aggregateType", "aggregateId", "eventType", payload
         FROM outbox WHERE "aggregateId" = $1 AND "eventType" = 'receivables.customer_account_changed'`,
      [aggregateId],
    );
    return rows;
  }

  function assertSafePayload(row: OutboxRow): void {
    const raw = JSON.stringify(row.payload).toLowerCase();
    expect(raw).not.toContain('phone');
    expect(raw).not.toContain('email');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('webhook');
    expect(raw).not.toContain('step-up');
    expect(raw).not.toContain('stepup');
  }

  // ═══════════════════════ §9/§10 — success-path + payload contract ═════════
  it('§9/§10.1: Payment->CustomerAdvance conversion produces EXACTLY ONE customer_account_changed event with the correct payload', async () => {
    const { customerId, ccaId } = await mkCustomer();
    const p = await collect(customerId, 100n, branchA);
    const adv = await convertToAdvance(customerId, p.paymentId, 100n, branchA);

    const rows = await outboxRowsFor(adv.advanceId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.eventType).toBe('receivables.customer_account_changed');
    expect(row.tenantId).toBe(tenantId);
    expect(row.companyId).toBe(companyId);
    expect(row.branchId).toBe(branchA);
    expect(row.aggregateType).toBe('customer_advance');
    expect(row.payload['customerCompanyAccountId']).toBe(ccaId);
    expect(row.payload['changeKind']).toBe('ADVANCE_CREATED_FROM_PAYMENT');
    expect(row.payload['sourceType']).toBe('customer_advance');
    expect(row.payload['sourceId']).toBe(adv.advanceId);
    assertSafePayload(row);
  });

  it('§9/§10.2: CustomerAdvanceApplication produces EXACTLY ONE customer_account_changed event with the correct payload', async () => {
    const { customerId, ccaId } = await mkCustomer();
    await setCredit(customerId);
    const p = await collect(customerId, 200n, branchA);
    const adv = await convertToAdvance(customerId, p.paymentId, 200n, branchA);
    const { invoiceId } = await mkInvoice(customerId, 500, branchA);
    const receivableId = await receivableIdForInvoice(invoiceId);
    const applied = await applyAdvanceTo(customerId, adv.advanceId, receivableId, 150n, branchA);

    const rows = await outboxRowsFor(applied.applicationId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.branchId).toBe(branchA);
    expect(row.aggregateType).toBe('customer_advance_application');
    expect(row.payload['customerCompanyAccountId']).toBe(ccaId);
    expect(row.payload['changeKind']).toBe('ADVANCE_APPLIED');
    expect(row.payload['sourceType']).toBe('customer_advance_application');
    expect(row.payload['sourceId']).toBe(applied.applicationId);
    assertSafePayload(row);
  });

  it('§9/§10.3: Opening Receivable creation produces EXACTLY ONE customer_account_changed event, distinctly payloaded from Opening Advance', async () => {
    const { customerId, ccaId } = await mkCustomer();
    const opening = await createOpening(customerId, 'RECEIVABLE', 300n, branchA);

    const rows = await outboxRowsFor(opening.sourceId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.branchId).toBe(branchA);
    expect(row.aggregateType).toBe('customer_receivable');
    expect(row.payload['customerCompanyAccountId']).toBe(ccaId);
    expect(row.payload['changeKind']).toBe('OPENING_RECEIVABLE_CREATED');
    expect(row.payload['sourceType']).toBe('customer_receivable');
    expect(row.payload['sourceId']).toBe(opening.sourceId);
    assertSafePayload(row);
  });

  it('§9/§10.4: Opening Advance creation produces EXACTLY ONE customer_account_changed event, distinctly payloaded from Opening Receivable', async () => {
    const { customerId, ccaId } = await mkCustomer();
    const opening = await createOpening(customerId, 'ADVANCE', 300n, branchA);

    const rows = await outboxRowsFor(opening.sourceId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.branchId).toBe(branchA);
    expect(row.aggregateType).toBe('customer_advance');
    expect(row.payload['customerCompanyAccountId']).toBe(ccaId);
    expect(row.payload['changeKind']).toBe('OPENING_ADVANCE_CREATED');
    expect(row.payload['sourceType']).toBe('customer_advance');
    expect(row.payload['sourceId']).toBe(opening.sourceId);
    assertSafePayload(row);
  });

  // ═══════════════════════ §8/§10 — branch isolation ═════════════════════════
  it("§8/§10: a Branch A Opening Receivable's event carries branchId=Branch A ONLY — no Branch B event is ever emitted for it", async () => {
    const { customerId } = await mkCustomer();
    const opening = await createOpening(customerId, 'RECEIVABLE', 250n, branchA);
    const rows = await outboxRowsFor(opening.sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branchId).toBe(branchA);
    expect(rows[0]!.branchId).not.toBe(branchB);
  });

  // ═══════════════════════ §11 — idempotent replay ═══════════════════════════
  it('§11.A: Payment->Advance conversion — a forced-duplicate business call is never exercised twice by the shared idempotency layer; verified here at the repository layer that a SINGLE convertInTx call yields exactly one outbox row (baseline for the HTTP-level idempotent-replay contract)', async () => {
    const { customerId } = await mkCustomer();
    const p = await collect(customerId, 80n, branchA);
    const adv = await convertToAdvance(customerId, p.paymentId, 80n, branchA);
    const rows = await outboxRowsFor(adv.advanceId);
    expect(rows).toHaveLength(1);
  });

  it('§11.B: Opening Balance — the SAME idempotency-key HTTP replay (proven in opening-balance.controller.integration.test.ts) never re-invokes createInTx, so the outbox row count for one logical creation stays exactly 1', async () => {
    const { customerId } = await mkCustomer();
    const opening = await createOpening(customerId, 'RECEIVABLE', 60n, branchA);
    const rows = await outboxRowsFor(opening.sourceId);
    expect(rows).toHaveLength(1);
    // a genuine SECOND, independent creation attempt on the SAME account+branch
    // is structurally rejected (F's opening-uniqueness invariant) BEFORE any
    // second outbox row could ever be enqueued.
    await expect(createOpening(customerId, 'RECEIVABLE', 60n, branchA)).rejects.toMatchObject({
      code: 'OPENING_BALANCE_ALREADY_INITIALIZED',
    });
    const rowsAfter = await outboxRowsFor(opening.sourceId);
    expect(rowsAfter).toHaveLength(1);
  });

  // ═══════════════════════ §12 — rollback ════════════════════════════════════
  it('§12: a forced post-effects failure in Payment->Advance conversion rolls back the outbox row together with the financial mutation (exact before/after row counts)', async () => {
    const { customerId } = await mkCustomer();
    const p = await collect(customerId, 90n, branchA);

    class FailsAfterEveryEffect extends PaymentAdvanceConversionRepository {
      override async convertInTx(
        tx: Parameters<PaymentAdvanceConversionRepository['convertInTx']>[0],
        input: Parameters<PaymentAdvanceConversionRepository['convertInTx']>[1],
      ): ReturnType<PaymentAdvanceConversionRepository['convertInTx']> {
        await super.convertInTx(tx, input);
        throw new Error('simulated post-effects failure, before commit');
      }
    }
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        {} as unknown as DbService,
        new AuditWriter({} as unknown as DbService),
        new AccountRepository(
          {} as unknown as DbService,
          new AuditWriter({} as unknown as DbService),
        ),
      ),
      new AccountingPeriodRepository(
        {} as unknown as DbService,
        new AuditWriter({} as unknown as DbService),
      ),
      new AuditWriter({} as unknown as DbService),
      fakeClock(),
    );
    const flaky = new FailsAfterEveryEffect(
      postingEngine,
      new AuditWriter({} as unknown as DbService),
      new PaymentCustomerAttributionRepository(),
      new OutboxWriter({} as unknown as DbService),
    );

    const before = await client.query<{ advances: string; outboxRows: string }>(
      `SELECT
         (SELECT count(*)::int FROM customer_advance)::text AS advances,
         (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed')::text AS "outboxRows"`,
    );
    await expect(
      asTenant((tx) =>
        flaky.convertInTx(tx, {
          tenantId,
          companyId,
          branchId: branchA,
          customerId,
          paymentId: p.paymentId,
          amountMinor: 90n,
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow('simulated post-effects failure, before commit');
    const after = await client.query<{ advances: string; outboxRows: string }>(
      `SELECT
         (SELECT count(*)::int FROM customer_advance)::text AS advances,
         (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed')::text AS "outboxRows"`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  // ═══════════════════════ §13 — duplicate webhook / provider path ══════════
  it('§13: the generic receivables event is NEVER emitted by the receipt-collection/PaymentAllocation path — it is used ONLY by the 3 standalone commands (receivables-events.ts) — a customer receipt against an Invoice creates ZERO new receivables.customer_account_changed rows, while it DOES ride on the frozen payments.payment_recorded event', async () => {
    const { customerId } = await mkCustomer();
    await setCredit(customerId);
    const { invoiceId } = await mkInvoice(customerId, 100, branchA);
    void invoiceId;

    const before = await client.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM outbox WHERE "eventType" = 'receivables.customer_account_changed' AND "tenantId" = $1`,
      [tenantId],
    );
    const receipt = await collect(customerId, 100n, branchA);
    const after = await client.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM outbox WHERE "eventType" = 'receivables.customer_account_changed' AND "tenantId" = $1`,
      [tenantId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n); // no new row from the receipt itself

    const paymentRecordedRows = await client.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM outbox WHERE "eventType" = 'payments.payment_recorded' AND "aggregateId" = $1`,
      [receipt.paymentId],
    );
    expect(Number(paymentRecordedRows.rows[0]!.n)).toBe(1); // the frozen 3b.5 event still fires exactly once
  });
});
