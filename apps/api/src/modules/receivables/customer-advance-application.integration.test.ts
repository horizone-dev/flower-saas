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
import { PaymentAdvanceConversionRepository } from './payment-advance-conversion.repository.js';
import { CustomerAdvanceApplicationRepository } from './customer-advance-application.repository.js';

/**
 * Task 3b.6 Checkpoint E (E11-E19, E21, E23-E28, E30, E34) —
 * `CustomerAdvanceApplicationRepository` proven directly against real
 * Postgres. Every PAYMENT-sourced Advance fixture is created via the REAL
 * `PaymentAdvanceConversionRepository` (this same checkpoint's own
 * conversion primitive); the one OPENING-sourced Advance fixture (E30) is
 * hand-constructed via raw SQL, exactly as the owner spec requires ("do not
 * create the Opening Advance endpoint in E" — Checkpoint F's own scope).
 */
const TENANT = 'e2000000-1111-7111-8111-111111111111';
const COMPANY = 'e2000000-3333-7333-8333-333333333333';
const BRANCH = 'e2000000-6666-7666-8666-666666666666';
const BRANCH_2 = 'e2000000-7777-7777-8777-777777777777';
const CATEGORY = 'e2000000-8888-7888-8888-888888888888';
const PRODUCT = 'e2000000-9999-7999-8999-999999999999';
const VARIANT = 'e2000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe('CustomerAdvanceApplicationRepository (task 3b.6 Checkpoint E, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let conversion: PaymentAdvanceConversionRepository;
  let application: CustomerAdvanceApplicationRepository;
  let seq = 0;
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
    conversion = new PaymentAdvanceConversionRepository(
      postingEngine,
      new AuditWriter(db),
      attribution,
      new OutboxWriter(db),
    );
    application = new CustomerAdvanceApplicationRepository(
      postingEngine,
      new AuditWriter(db),
      effects,
      new OutboxWriter(db),
    );

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000e2000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000e2000002', '00000000-0000-7000-8000-0000e2000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'e11-3b6', 'e11-3b6', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000e2000002', now())`,
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
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Second', now())`,
      [BRANCH_2, TENANT, COMPANY],
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

  async function insertOrder(customerId: string, branchId: string = BRANCH): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [id, TENANT, COMPANY, branchId, customerId, `fp-${id}`],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-E11-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function freshCustomerInvoice(
    ccaId: string,
    customerId: string,
    totalAmountMinor: number,
    branchId: string = BRANCH,
  ): Promise<{ invoiceId: string; receivableId: string }> {
    const orderId = await insertOrder(customerId, branchId);
    const lineId = uid();
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT, totalAmountMinor],
    );
    await confirmOrder(orderId);
    const invoiceId = uid();
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, $7, 0, 0, $7)`,
      [
        invoiceId,
        TENANT,
        COMPANY,
        branchId,
        orderId,
        `INV-E11-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    const receivableId = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "invoiceId", "creditAuthorized")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
      [receivableId, TENANT, COMPANY, branchId, ccaId, invoiceId],
    );
    await pool.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" + $2 WHERE id = $1`,
      [ccaId, totalAmountMinor],
    );
    return { invoiceId, receivableId };
  }

  async function freshOpeningReceivable(
    ccaId: string,
    openingAmountMinor: number,
    branchId: string = BRANCH,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
      [id, TENANT, COMPANY, branchId, ccaId, openingAmountMinor],
    );
    await pool.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" + $2 WHERE id = $1`,
      [ccaId, openingAmountMinor],
    );
    return id;
  }

  /** a raw, fully-unapplied CUSTOMER_RECEIPT Payment — built directly via
   *  SQL (bypassing `collectInTx`'s own FIFO entirely) so it is NEVER
   *  affected by whatever open receivables this test has already created
   *  for the SAME customer (a real `collectInTx` call would immediately
   *  FIFO-consume against those, exactly as D intends — but that behavior
   *  would corrupt THIS file's own fixture ordering, which deliberately
   *  creates receivables and Advances in whatever order each scenario
   *  needs). Mirrors the exact CUSTOMER_RECEIPT PaymentAttempt/Payment
   *  shape `CustomerReceiptCollectionRepository` itself produces. */
  async function freshUnappliedPaymentRaw(ccaId: string, amountMinor: bigint): Promise<string> {
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, ccaId, amountMinor.toString(), `idem-${attemptId}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId, amountMinor.toString()],
    );
    return paymentId;
  }

  /** a genuine PAYMENT-sourced Advance, created via the REAL
   *  `PaymentAdvanceConversionRepository` against a raw, fully-unapplied
   *  Payment (see `freshUnappliedPaymentRaw` above for why raw). */
  async function freshAdvance(
    customerId: string,
    ccaId: string,
    amountMinor: bigint,
  ): Promise<string> {
    const paymentId = await freshUnappliedPaymentRaw(ccaId, amountMinor);
    const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
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
    return converted.advanceId;
  }

  /** E30 — an OPENING-sourced Advance fixture, hand-constructed via raw SQL
   *  (Checkpoint F's own future creation command is explicitly NOT built
   *  here). */
  async function freshOpeningAdvance(
    ccaId: string,
    amountMinor: number,
    branchId: string = BRANCH,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "amountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
      [id, TENANT, COMPANY, branchId, ccaId, amountMinor],
    );
    await pool.query(
      `UPDATE customer_company_account SET "advanceBalanceMinor" = "advanceBalanceMinor" + $2 WHERE id = $1`,
      [ccaId, amountMinor],
    );
    return id;
  }

  function apply(
    customerId: string,
    advanceId: string,
    customerReceivableId: string,
    amountMinor: bigint,
  ) {
    return runScoped(prisma, { tenantId: TENANT }, (tx) =>
      application.applyInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH,
        customerId,
        advanceId,
        customerReceivableId,
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

  // ═══════════════════════ E38 functional tests (application side) ═════════
  it('13/14/17: partial then full application to an Invoice — PARTIAL then PAID', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { invoiceId, receivableId } = await freshCustomerInvoice(ccaId, customerId, 300);
    const advanceId = await freshAdvance(customerId, ccaId, 500n);

    const partial = await apply(customerId, advanceId, receivableId, 200n);
    expect(partial.remainingAdvanceMinor).toBe(300n);
    expect(partial.receivableOutstandingMinor).toBe(100n);
    expect(partial.invoicePaymentStatus).toBe('PARTIAL');
    let ccaRows = await pool.query<{
      advanceBalanceMinor: string;
      currentOutstandingMinor: string;
    }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(ccaRows.rows[0]!.advanceBalanceMinor).toBe('300');
    expect(ccaRows.rows[0]!.currentOutstandingMinor).toBe('100');

    const full = await apply(customerId, advanceId, receivableId, 100n);
    expect(full.remainingAdvanceMinor).toBe(200n);
    expect(full.receivableOutstandingMinor).toBe(0n);
    expect(full.invoicePaymentStatus).toBe('PAID');
    ccaRows = await pool.query(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(ccaRows.rows[0]!.advanceBalanceMinor).toBe('200');
    expect(ccaRows.rows[0]!.currentOutstandingMinor).toBe('0');

    const { rows: invRows } = await pool.query<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invRows[0]!.invoicePaymentStatus).toBe('PAID');
  });

  it('15: applying more than the Invoice outstanding is rejected', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 100);
    const advanceId = await freshAdvance(customerId, ccaId, 500n);
    await expect(apply(customerId, advanceId, receivableId, 101n)).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it('16: applying more than the Advance available is rejected', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 500);
    const advanceId = await freshAdvance(customerId, ccaId, 100n);
    await expect(apply(customerId, advanceId, receivableId, 101n)).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it('18/28: apply to an Opening Receivable — no Invoice status, correct projections, one chronology entry, one journal', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const openingId = await freshOpeningReceivable(ccaId, 300);
    const advanceId = await freshAdvance(customerId, ccaId, 500n);

    const result = await apply(customerId, advanceId, openingId, 300n);
    expect(result.receivableOutstandingMinor).toBe(0n);
    expect(result.remainingAdvanceMinor).toBe(200n);
    expect(result.invoicePaymentStatus).toBeNull();

    const { rows } = await pool.query<{
      advanceBalanceMinor: string;
      currentOutstandingMinor: string;
    }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(rows[0]!.advanceBalanceMinor).toBe('200');
    // 300 (opening receivable's own principal) - 300 (this application) = 0.
    // The Advance-funding Payment itself was created via
    // `freshUnappliedPaymentRaw` (raw SQL, bypassing the real customer-receipt
    // endpoint entirely) so it never posted a receipt against
    // currentOutstandingMinor in the first place — only the Opening
    // Receivable's own principal ever touched this projection here.
    expect(rows[0]!.currentOutstandingMinor).toBe('0');

    const { rows: entryRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_account_entry WHERE "customerAdvanceApplicationId" = $1`,
      [result.applicationId],
    );
    expect(entryRows[0]!.n).toBe(1);
    const journal = await journalFor('customer_advance_application', result.applicationId);
    expect(journal).toEqual([
      { accountKey: 'LIABILITY.CUSTOMER_ADVANCES', debitMinor: '300', creditMinor: '0' },
      { accountKey: 'ASSET.ACCOUNTS_RECEIVABLE', debitMinor: '0', creditMinor: '300' },
    ]);
  });

  it('19/20/21: Advance application chronology and GL are each produced exactly once', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 300);
    const advanceId = await freshAdvance(customerId, ccaId, 300n);
    const result = await apply(customerId, advanceId, receivableId, 300n);
    const { rows: entryRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_account_entry WHERE "customerAdvanceApplicationId" = $1`,
      [result.applicationId],
    );
    expect(entryRows[0]!.n).toBe(1);
    const { rows: journalRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM journal_entry WHERE "sourceKind" = 'customer_advance_application' AND "sourceId" = $1`,
      [result.applicationId],
    );
    expect(journalRows[0]!.n).toBe(1);
  });

  it('22/23: currentOutstanding and advanceBalance decrease by EXACTLY the applied amount', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 300);
    const advanceId = await freshAdvance(customerId, ccaId, 500n);
    const before = await pool.query<{
      advanceBalanceMinor: string;
      currentOutstandingMinor: string;
    }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    await apply(customerId, advanceId, receivableId, 120n);
    const after = await pool.query<{
      advanceBalanceMinor: string;
      currentOutstandingMinor: string;
    }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(
      BigInt(before.rows[0]!.advanceBalanceMinor) - BigInt(after.rows[0]!.advanceBalanceMinor),
    ).toBe(120n);
    expect(
      BigInt(before.rows[0]!.currentOutstandingMinor) -
        BigInt(after.rows[0]!.currentOutstandingMinor),
    ).toBe(120n);
  });

  it('24: no auto-application to a second receivable — the remainder simply stays available on the Advance', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId: a } = await freshCustomerInvoice(ccaId, customerId, 100);
    const { receivableId: b } = await freshCustomerInvoice(ccaId, customerId, 100);
    const advanceId = await freshAdvance(customerId, ccaId, 500n);
    await apply(customerId, advanceId, a, 100n);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_advance_application WHERE "customerReceivableId" = $1`,
      [b],
    );
    expect(rows[0]!.n).toBe(0); // never auto-applied to b
  });

  it('26: an OPENING-sourced Advance fixture applies to an Invoice-origin receivable under normal scope/currency/capacity rules (E30)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 200);
    const advanceId = await freshOpeningAdvance(ccaId, 500);
    const result = await apply(customerId, advanceId, receivableId, 200n);
    expect(result.receivableOutstandingMinor).toBe(0n);
    expect(result.invoicePaymentStatus).toBe('PAID');
  });

  // "final hardening (task 8): an OPENING-sourced Advance applies to an
  // OPENING-sourced Receivable" — REMOVED by Checkpoint F Final Hardening
  // §1/§9-10: the owner-frozen rule "at most one opening-balance
  // initialization (RECEIVABLE XOR ADVANCE, never both) per
  // CustomerCompanyAccount+Branch" is now a genuine structural DB invariant
  // (a trigger on both `customer_receivable`/`customer_advance` claims a
  // shared unique slot) — an account can no longer simultaneously hold an
  // OPENING receivable AND an OPENING advance, so the exact scenario this
  // test constructed is now structurally UNREACHABLE, even via raw SQL. The
  // property it existed to prove — the apply mechanism is sourceType-
  // agnostic on EACH side independently — remains fully proven: the ADVANCE
  // side by test "26" immediately above (OPENING Advance -> INVOICE
  // Receivable) and by Checkpoint F's own new
  // `opening-balance.integration.test.ts` ("20: an E Advance (PAYMENT-sourced)
  // can settle an Opening Receivable"); the RECEIVABLE side by test "18/28"
  // immediately below (INVOICE... via `freshAdvance`/PAYMENT-sourced
  // Advance -> OPENING Receivable) and by D's own frozen FIFO suite.

  it('cross-branch advance pooling is rejected (E5) — application-layer domain error (the DB-level structural backstop is proven independently in packages/db/test/receivables-advance-application-branch-backstop.integration.test.ts)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const advanceId = await freshAdvance(customerId, ccaId, 200n); // lives at BRANCH
    const { receivableId: otherBranchReceivable } = await freshCustomerInvoice(
      ccaId,
      customerId,
      100,
      BRANCH_2,
    );
    await expect(
      runScoped(prisma, { tenantId: TENANT }, (tx) =>
        application.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId,
          customerReceivableId: otherBranchReceivable,
          amountMinor: 50n,
          actorUserId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_ADVANCE_APPLICATION_CROSS_BRANCH_NOT_ALLOWED' });
  });

  // ═════ E25/E26 — credit-exposure before/after proof ═══════════════════════
  it('E26: creating the Advance does not reduce exposure; applying it does, exactly', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 500);
    // outstanding is now 500 from the Invoice alone.
    const advanceId = await freshAdvance(customerId, ccaId, 500n);
    let rows = await pool.query<{ currentOutstandingMinor: string }>(
      `SELECT "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(rows.rows[0]!.currentOutstandingMinor).toBe('500'); // unchanged by funding alone

    await apply(customerId, advanceId, receivableId, 500n);
    rows = await pool.query(
      `SELECT "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(rows.rows[0]!.currentOutstandingMinor).toBe('0'); // fully reduced after application
  });

  // ═════ E34 rollback (application side) ════════════════════════════════════
  it('32: an injected failure after application effects rolls back EVERY new row', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { invoiceId, receivableId } = await freshCustomerInvoice(ccaId, customerId, 300);
    const advanceId = await freshAdvance(customerId, ccaId, 500n);

    class FailsAfterEveryEffect extends CustomerAdvanceApplicationRepository {
      override async applyInTx(
        tx: Parameters<CustomerAdvanceApplicationRepository['applyInTx']>[0],
        input: Parameters<CustomerAdvanceApplicationRepository['applyInTx']>[1],
      ): ReturnType<CustomerAdvanceApplicationRepository['applyInTx']> {
        await super.applyInTx(tx, input);
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
    const effects = new CustomerReceiptEffectsRepository(postingEngine, new AuditWriter(db));
    const flaky = new FailsAfterEveryEffect(
      postingEngine,
      new AuditWriter(db),
      effects,
      new OutboxWriter(db),
    );

    const before = await pool.query<{
      applications: number;
      entries: number;
      journals: number;
      audits: number;
      outboxRows: number;
    }>(`SELECT
          (SELECT count(*)::int FROM customer_advance_application) AS applications,
          (SELECT count(*)::int FROM customer_account_entry) AS entries,
          (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'customer_advance_application') AS journals,
          (SELECT count(*)::int FROM audit_log) AS audits,
          (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`);
    const ccaBefore = await pool.query<{
      advanceBalanceMinor: string;
      currentOutstandingMinor: string;
    }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    const invoiceBefore = await pool.query<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );

    await expect(
      runScoped(prisma, { tenantId: TENANT }, (tx) =>
        flaky.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId,
          customerReceivableId: receivableId,
          amountMinor: 100n,
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow('simulated post-effects failure, before commit');

    const after = await pool.query<(typeof before.rows)[0]>(`SELECT
          (SELECT count(*)::int FROM customer_advance_application) AS applications,
          (SELECT count(*)::int FROM customer_account_entry) AS entries,
          (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'customer_advance_application') AS journals,
          (SELECT count(*)::int FROM audit_log) AS audits,
          (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`);
    expect(after.rows[0]!.applications).toBe(before.rows[0]!.applications);
    expect(after.rows[0]!.entries).toBe(before.rows[0]!.entries);
    expect(after.rows[0]!.journals).toBe(before.rows[0]!.journals);
    expect(after.rows[0]!.audits).toBe(before.rows[0]!.audits);
    expect(after.rows[0]!.outboxRows).toBe(before.rows[0]!.outboxRows); // H9 — no orphaned outbox row
    const ccaAfter = await pool.query<{
      advanceBalanceMinor: string;
      currentOutstandingMinor: string;
    }>(
      `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(ccaAfter.rows[0]!.advanceBalanceMinor).toBe(ccaBefore.rows[0]!.advanceBalanceMinor);
    expect(ccaAfter.rows[0]!.currentOutstandingMinor).toBe(
      ccaBefore.rows[0]!.currentOutstandingMinor,
    );
    const invoiceAfter = await pool.query<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invoiceAfter.rows[0]!.invoicePaymentStatus).toBe(
      invoiceBefore.rows[0]!.invoicePaymentStatus,
    );
  });

  // ═════ E39 concurrency (application side) ═════════════════════════════════
  describe('E23/E24/E25 concurrency', () => {
    it('D: same Advance=100, two concurrent applications of 60 each (to two different Invoices) -> exactly one succeeds', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const { receivableId: a } = await freshCustomerInvoice(ccaId, customerId, 100);
      const { receivableId: b } = await freshCustomerInvoice(ccaId, customerId, 100);
      const advanceId = await freshAdvance(customerId, ccaId, 100n);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES (uuidv7(),$1,$2,$3,$4,$5,60,'AED',2)`,
            [TENANT, COMPANY, BRANCH, advanceId, a],
          ),
          c2.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES (uuidv7(),$1,$2,$3,$4,$5,60,'AED',2)`,
            [TENANT, COMPANY, BRANCH, advanceId, b],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('E: same Invoice outstanding=100 — Advance application 60 vs a direct PaymentAllocation 60 -> exactly one succeeds', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const { invoiceId, receivableId } = await freshCustomerInvoice(ccaId, customerId, 100);
      const advanceId = await freshAdvance(customerId, ccaId, 100n);
      // a Payment with FULL, untouched $60 capacity (never through
      // `collectInTx`, which would immediately FIFO-consume it against this
      // SAME open Invoice receivable before the race even starts).
      const racePaymentId = await freshUnappliedPaymentRaw(ccaId, 60n);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          apply(customerId, advanceId, receivableId, 60n),
          c1.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES (uuidv7(),$1,$2,$3,$4,$5,60,'AED',2)`,
            [TENANT, COMPANY, BRANCH, racePaymentId, invoiceId],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('F: same Opening Receivable outstanding=100 — Advance application 60 vs a direct CustomerReceivablePaymentApplication 60 -> exactly one succeeds', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const openingId = await freshOpeningReceivable(ccaId, 100);
      const advanceId = await freshAdvance(customerId, ccaId, 100n);
      const racePaymentId = await freshUnappliedPaymentRaw(ccaId, 60n);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          apply(customerId, advanceId, openingId, 60n),
          c1.query(
            `INSERT INTO customer_receivable_payment_application (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [TENANT, COMPANY, BRANCH, ccaId, racePaymentId, openingId],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('G: same CustomerCompanyAccount — Advance funding and Advance application concurrently -> no lost projection update', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 200);
      const firstAdvanceId = await freshAdvance(customerId, ccaId, 100n);

      // concurrently: (A) fund a SECOND Advance from a fresh, untouched
      // Payment, and (B) apply the FIRST Advance to the Invoice receivable.
      const racePaymentId = await freshUnappliedPaymentRaw(ccaId, 50n);
      const runFunding = () =>
        runScoped(prisma, { tenantId: TENANT }, (tx) =>
          conversion.convertInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            customerId,
            paymentId: racePaymentId,
            amountMinor: 50n,
            actorUserId: null,
          }),
        );
      const runApplication = () => apply(customerId, firstAdvanceId, receivableId, 80n);

      const [fundingResult, applicationResult] = await Promise.allSettled([
        runFunding(),
        runApplication(),
      ]);
      expect(fundingResult.status).toBe('fulfilled');
      expect(applicationResult.status).toBe('fulfilled');

      const { rows } = await pool.query<{
        advanceBalanceMinor: string;
        currentOutstandingMinor: string;
      }>(
        `SELECT "advanceBalanceMinor", "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
        [ccaId],
      );
      // serial-order-independent final value: funding +50, application -80,
      // starting balance 100 -> 100 + 50 - 80 = 70. Never a lost update.
      expect(rows[0]!.advanceBalanceMinor).toBe('70');
      expect(rows[0]!.currentOutstandingMinor).toBe('120'); // 200 - 80
    });
  });
});
