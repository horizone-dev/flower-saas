import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import {
  createPrismaClient,
  runScoped,
  ACCOUNTING_REFERENCE_ACCOUNTS,
  type PrismaClient,
} from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { SystemClock } from '../../common/clock/clock.js';
import { PaymentCustomerAttributionRepository } from './payment-customer-attribution.repository.js';
import { CustomerReceiptEffectsRepository } from './customer-receipt-effects.repository.js';
import { CustomerReceiptCollectionRepository } from './customer-receipt-collection.repository.js';
import { PaymentAdvanceConversionRepository } from './payment-advance-conversion.repository.js';

/**
 * Task 3b.6 Checkpoint E (E3/E4/E5/E8-E10/E20/E22/E26/E29/E31/E32/E34) —
 * `PaymentAdvanceConversionRepository` proven directly against real
 * Postgres through the actual production `runScoped` path. Every fixture
 * Payment is created via the REAL, already-frozen
 * `CustomerReceiptCollectionRepository` (Checkpoint D) rather than raw SQL —
 * this both exercises genuine production code as fixture setup and
 * guarantees the resulting Payment's remaining-capacity arithmetic is
 * authentic, not hand-constructed.
 */
const TENANT = 'e1000000-1111-7111-8111-111111111111';
const COMPANY = 'e1000000-3333-7333-8333-333333333333';
const BRANCH = 'e1000000-6666-7666-8666-666666666666';
const CATEGORY = 'e1000000-8888-7888-8888-888888888888';
const PRODUCT = 'e1000000-9999-7999-8999-999999999999';
const VARIANT = 'e1000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe('PaymentAdvanceConversionRepository (task 3b.6 Checkpoint E, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let collection: CustomerReceiptCollectionRepository;
  let conversion: PaymentAdvanceConversionRepository;
  const uid = (): string => crypto.randomUUID();

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AccountingPeriodRepository(db, new AuditWriter(db)),
      new AuditWriter(db),
      new SystemClock(),
    );
    const effects = new CustomerReceiptEffectsRepository(postingEngine, new AuditWriter(db));
    const attribution = new PaymentCustomerAttributionRepository();
    collection = new CustomerReceiptCollectionRepository(
      new AuditWriter(db),
      new OutboxWriter(db),
      effects,
    );
    conversion = new PaymentAdvanceConversionRepository(
      postingEngine,
      new AuditWriter(db),
      attribution,
      new OutboxWriter(db),
    );

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000e1000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000e1000002', '00000000-0000-7000-8000-0000e1000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'e3-3b6', 'e3-3b6', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000e1000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Test Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await pool.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [uid(), TENANT, COMPANY, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
      );
    }
    await pool.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2026-01-01','2026-12-31','OPEN',now())`,
      [uid(), TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Main', now())`,
      [BRANCH, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt") VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await pool.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose', 'Rose', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await pool.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt") VALUES ($1, $2, $3, 'Rose Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  async function freshCustomer(): Promise<{ customerId: string; ccaId: string }> {
    const customerId = uid();
    const ccaId = uid();
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Test Customer', now())`,
      [customerId, TENANT],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [ccaId, TENANT, COMPANY, customerId],
    );
    return { customerId, ccaId };
  }

  /** a genuine, fully-wired Payment with `amountMinor` entirely unapplied —
   *  created via the REAL D `CustomerReceiptCollectionRepository` against a
   *  customer with zero open receivables. */
  async function freshUnappliedPayment(
    customerId: string,
    amountMinor: bigint,
  ): Promise<{ paymentId: string; currencyCode: string; currencyExponent: number }> {
    const result = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      collection.collectInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        customerId,
        amountMinor,
        method: 'CASH',
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: `fixture-${uid()}`,
      }),
    );
    expect(result.unallocatedAmountMinor).toBe(amountMinor); // fixture sanity
    return {
      paymentId: result.paymentId,
      currencyCode: result.currencyCode,
      currencyExponent: result.currencyExponent,
    };
  }

  function convert(customerId: string, paymentId: string, amountMinor: bigint) {
    return runScoped(prisma, { tenantId: TENANT }, (tx) =>
      conversion.convertInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        customerId,
        paymentId,
        amountMinor,
        actorUserId: null,
      }),
    );
  }

  async function journalFor(sourceKind: string, sourceId: string) {
    const { rows } = await pool.query<{
      accountKey: string;
      debitMinor: string;
      creditMinor: string;
    }>(
      `SELECT a.key AS "accountKey", jl."debitMinor", jl."creditMinor"
         FROM journal_entry je
         JOIN journal_line jl ON jl."journalEntryId" = je.id
         JOIN account a ON a.id = jl."accountId"
        WHERE je."sourceKind" = $1 AND je."sourceId" = $2
        ORDER BY jl."debitMinor" DESC`,
      [sourceKind, sourceId],
    );
    return rows;
  }

  // ═══════════════════════ E38 functional tests (conversion side) ══════════
  it('1: converts the FULL Payment remainder to Advance', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { paymentId } = await freshUnappliedPayment(customerId, 200n);
    const result = await convert(customerId, paymentId, 200n);
    expect(result.remainingPaymentUnallocatedMinor).toBe(0n);
    expect(result.advanceBalanceMinor).toBe(200n);
    const { rows } = await pool.query<{
      advanceBalanceMinor: string;
      currentOutstandingMinor: string;
    }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(rows[0]!.advanceBalanceMinor).toBe('200');
    expect(rows[0]!.currentOutstandingMinor).toBe('0'); // E10 — funding never touches this
  });

  it('2: converts a PARTIAL remainder', async () => {
    const { customerId } = await freshCustomer();
    const { paymentId } = await freshUnappliedPayment(customerId, 200n);
    const result = await convert(customerId, paymentId, 120n);
    expect(result.remainingPaymentUnallocatedMinor).toBe(80n);
    expect(result.advanceBalanceMinor).toBe(120n);
  });

  it('3: conversion amount exceeding remaining capacity is rejected, no partial hidden conversion', async () => {
    const { customerId } = await freshCustomer();
    const { paymentId } = await freshUnappliedPayment(customerId, 100n);
    await expect(convert(customerId, paymentId, 101n)).rejects.toMatchObject({
      code: 'PAYMENT_ADVANCE_CONVERSION_EXCEEDS_CAPACITY',
    });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_advance WHERE "sourcePaymentId" = $1`,
      [paymentId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('4: a walk-in Payment (no customer attribution) is rejected — fail closed (E31)', async () => {
    // a walk-in local invoice Payment has no CUSTOMER_RECEIPT/attributable
    // Order.customerId at all; simulate minimally via a raw payment_attempt +
    // payment with receiptPurpose=INVOICE_COLLECTION and no customer order.
    const orderId = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "orderNumber", version, "updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','CONFIRMED','AED',2,$5,2,'TAX_EXCLUSIVE','LINE','HALF_UP',$6,1,now())`,
      [orderId, TENANT, COMPANY, BRANCH, `fp-${orderId}`, `ORD-E4-${orderId.slice(0, 6)}`],
    );
    const lineId = uid();
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',100,'AED',2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT],
    );
    const invoiceId = uid();
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 100, 0, 0, 100)`,
      [invoiceId, TENANT, COMPANY, BRANCH, orderId, `INV-WALKIN-${invoiceId.slice(0, 8)}`],
    );
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "receiptPurpose",
          method, "amountMinor", "currencyCode", "currencyExponent", state,
          "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation", "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'INVOICE_COLLECTION','CASH',100,'AED',2,'CAPTURED','fp-x',1,$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, orderId, invoiceId, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',100,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId],
    );
    const { customerId } = await freshCustomer();
    await expect(convert(customerId, paymentId, 50n)).rejects.toBeInstanceOf(DomainError);
  });

  it('5: wrong customer (route customerId does not match the Payment attribution) is rejected — non-disclosing 404', async () => {
    const { customerId: ownerCustomerId } = await freshCustomer();
    const { customerId: otherCustomerId } = await freshCustomer();
    const { paymentId } = await freshUnappliedPayment(ownerCustomerId, 100n);
    await expect(convert(otherCustomerId, paymentId, 50n)).rejects.toThrow();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_advance WHERE "sourcePaymentId" = $1`,
      [paymentId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('9: Advance funding chronology exactly once', async () => {
    const { customerId } = await freshCustomer();
    const { paymentId } = await freshUnappliedPayment(customerId, 100n);
    const result = await convert(customerId, paymentId, 100n);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_account_entry WHERE "customerAdvanceId" = $1`,
      [result.advanceId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('10: Advance funding GL exactly once — Dr Unapplied Receipts / Cr Customer Advances, never Cash/Bank/Clearing/Revenue/AR', async () => {
    const { customerId } = await freshCustomer();
    const { paymentId } = await freshUnappliedPayment(customerId, 150n);
    const result = await convert(customerId, paymentId, 150n);
    const journal = await journalFor('customer_advance', result.advanceId);
    expect(journal).toEqual([
      { accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS', debitMinor: '150', creditMinor: '0' },
      { accountKey: 'LIABILITY.CUSTOMER_ADVANCES', debitMinor: '0', creditMinor: '150' },
    ]);
  });

  it('11: advanceBalance increments correctly across two separate conversions', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { paymentId: p1 } = await freshUnappliedPayment(customerId, 100n);
    await convert(customerId, p1, 40n);
    const { paymentId: p2 } = await freshUnappliedPayment(customerId, 100n);
    await convert(customerId, p2, 30n);
    const { rows } = await pool.query<{ advanceBalanceMinor: string }>(
      `SELECT "advanceBalanceMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(rows[0]!.advanceBalanceMinor).toBe('70');
  });

  it('12: Advance existence alone does not reduce credit exposure (E26, funding half)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await pool.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = 500 WHERE id = $1`,
      [ccaId],
    );
    const { paymentId } = await freshUnappliedPayment(customerId, 500n);
    await convert(customerId, paymentId, 500n);
    const { rows } = await pool.query<{
      currentOutstandingMinor: string;
      advanceBalanceMinor: string;
    }>(
      `SELECT "currentOutstandingMinor", "advanceBalanceMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(rows[0]!.currentOutstandingMinor).toBe('500'); // unchanged
    expect(rows[0]!.advanceBalanceMinor).toBe('500');
  });

  // ═════ E29 — source-Payment remainder proof ══════════════════════════════
  it('E29: Payment=700, D applies 500 elsewhere, convert 150 -> remaining unapplied 50; a further 60 is rejected', async () => {
    const { customerId } = await freshCustomer();
    // an Opening Receivable of 500 lets D's own FIFO consume exactly 500 of
    // a 700 receipt, leaving exactly 200 unapplied on the Payment.
    const openingId = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,(SELECT id FROM customer_company_account WHERE "customerId" = $5),'OPENING',500,'AED',2,'2026-01-05')`,
      [openingId, TENANT, COMPANY, BRANCH, customerId],
    );
    await pool.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" + 500 WHERE "customerId" = $1`,
      [customerId],
    );
    const result = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      collection.collectInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        customerId,
        amountMinor: 700n,
        method: 'CASH',
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: `fixture-${uid()}`,
      }),
    );
    expect(result.unallocatedAmountMinor).toBe(200n);

    const converted = await convert(customerId, result.paymentId, 150n);
    expect(converted.remainingPaymentUnallocatedMinor).toBe(50n);

    await expect(convert(customerId, result.paymentId, 60n)).rejects.toMatchObject({
      code: 'PAYMENT_ADVANCE_CONVERSION_EXCEEDS_CAPACITY',
    });
  });

  // ═════ E34 rollback (conversion side) ════════════════════════════════════
  it('31: an injected failure after conversion effects rolls back EVERY new row', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { paymentId } = await freshUnappliedPayment(customerId, 100n);

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
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AccountingPeriodRepository(db, new AuditWriter(db)),
      new AuditWriter(db),
      new SystemClock(),
    );
    const flaky = new FailsAfterEveryEffect(
      postingEngine,
      new AuditWriter(db),
      new PaymentCustomerAttributionRepository(),
      new OutboxWriter(db),
    );

    const before = await pool.query<{
      advances: number;
      entries: number;
      journals: number;
      audits: number;
      outboxRows: number;
    }>(`SELECT
          (SELECT count(*)::int FROM customer_advance) AS advances,
          (SELECT count(*)::int FROM customer_account_entry) AS entries,
          (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'customer_advance') AS journals,
          (SELECT count(*)::int FROM audit_log) AS audits,
          (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`);
    const { rows: ccaBeforeRows } = await pool.query<{ advanceBalanceMinor: string }>(
      `SELECT "advanceBalanceMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );

    await expect(
      runScoped(prisma, { tenantId: TENANT }, (tx) =>
        flaky.convertInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          paymentId,
          amountMinor: 50n,
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow('simulated post-effects failure, before commit');

    const after = await pool.query<(typeof before.rows)[0]>(`SELECT
          (SELECT count(*)::int FROM customer_advance) AS advances,
          (SELECT count(*)::int FROM customer_account_entry) AS entries,
          (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'customer_advance') AS journals,
          (SELECT count(*)::int FROM audit_log) AS audits,
          (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`);
    expect(after.rows[0]!.advances).toBe(before.rows[0]!.advances);
    expect(after.rows[0]!.entries).toBe(before.rows[0]!.entries);
    expect(after.rows[0]!.journals).toBe(before.rows[0]!.journals);
    expect(after.rows[0]!.audits).toBe(before.rows[0]!.audits);
    expect(after.rows[0]!.outboxRows).toBe(before.rows[0]!.outboxRows); // H9 — no orphaned outbox row
    const { rows: ccaAfterRows } = await pool.query<{ advanceBalanceMinor: string }>(
      `SELECT "advanceBalanceMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(ccaAfterRows[0]!.advanceBalanceMinor).toBe(ccaBeforeRows[0]!.advanceBalanceMinor);
  });

  // ═════ E39 concurrency (Payment-capacity side) ═══════════════════════════
  describe('E22/E39 — Payment-capacity concurrency', () => {
    it('A: same Payment, two concurrent conversions of 60 each on capacity=100 -> exactly one succeeds', async () => {
      const { customerId } = await freshCustomer();
      const { paymentId } = await freshUnappliedPayment(customerId, 100n);
      const results = await Promise.allSettled([
        convert(customerId, paymentId, 60n),
        convert(customerId, paymentId, 60n),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(1);
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM("amountMinor"),0)::int AS n FROM customer_advance WHERE "sourcePaymentId" = $1`,
        [paymentId],
      );
      expect(rows[0]!.n).toBeLessThanOrEqual(100);
    });

    it('B: same Payment=100 — conversion 60 (repository) vs a direct PaymentAllocation insert 60 (raw SQL) -> exactly one succeeds', async () => {
      const { customerId } = await freshCustomer();
      const { paymentId, currencyCode, currencyExponent } = await freshUnappliedPayment(
        customerId,
        100n,
      );
      // a real Invoice-origin receivable for the SAME customer to allocate
      // the raw-SQL side against.
      const orderId = uid();
      await pool.query(
        `INSERT INTO "order"
           (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
            "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
            "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
            "taxRoundingMode", "orderNumber", version, "updatedAt")
         VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','CONFIRMED','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',$7,1,now())`,
        [
          orderId,
          TENANT,
          COMPANY,
          BRANCH,
          customerId,
          `fp-${orderId}`,
          `ORD-E22B-${orderId.slice(0, 6)}`,
        ],
      );
      const lineId = uid();
      await pool.query(
        `INSERT INTO order_line
           (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
            "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
            "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
            "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
            "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
            "updatedAt")
         VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',100,'AED',2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
                 'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
        [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT],
      );
      const invoiceId = uid();
      await pool.query(
        `INSERT INTO invoice
           (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
            "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
            "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
         VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 100, 0, 0, 100)`,
        [invoiceId, TENANT, COMPANY, BRANCH, orderId, `INV-E22B-${invoiceId.slice(0, 8)}`],
      );

      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          convert(customerId, paymentId, 60n),
          c1.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES (uuidv7(),$1,$2,$3,$4,$5,60,$6,$7)`,
            [TENANT, COMPANY, BRANCH, paymentId, invoiceId, currencyCode, currencyExponent],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('C: same Payment=100 — conversion 60 (repository) vs a direct CustomerReceivablePaymentApplication insert 60 (raw SQL) -> exactly one succeeds', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const { paymentId, currencyCode, currencyExponent } = await freshUnappliedPayment(
        customerId,
        100n,
      );
      const openingId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',100,$6,$7,'2026-01-05')`,
        [openingId, TENANT, COMPANY, BRANCH, ccaId, currencyCode, currencyExponent],
      );

      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          convert(customerId, paymentId, 60n),
          c1.query(
            `INSERT INTO customer_receivable_payment_application (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,60,$7,$8)`,
            [TENANT, COMPANY, BRANCH, ccaId, paymentId, openingId, currencyCode, currencyExponent],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });
  });
});
