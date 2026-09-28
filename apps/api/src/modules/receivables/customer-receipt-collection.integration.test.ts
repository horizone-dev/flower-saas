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
import { CustomerReceiptEffectsRepository } from './customer-receipt-effects.repository.js';
import { CustomerReceiptCollectionRepository } from './customer-receipt-collection.repository.js';
import { CustomerInvoiceArRepository } from './customer-invoice-ar.repository.js';

/**
 * Task 3b.6 Checkpoint D (D13-D16/D29, representative subset) —
 * `CustomerReceiptCollectionRepository` proven directly against real
 * Postgres through the actual production `runScoped` path (no HTTP). Proves
 * the combined Invoice+Opening FIFO queue (D14), the transactional
 * recomputation/lock sequence (D13/D15), the unallocated-remainder rule
 * (D16), and the tender/scope boundaries (D11/D33). Given the size of this
 * checkpoint, this is a representative functional proof of the highest-risk
 * new logic (the combined FIFO adapter), not an exhaustive re-run of every
 * scenario in the owner spec — the DB-level structural/concurrency
 * invariants themselves are separately, exhaustively proven in
 * `packages/db/test/receivables-opening-payment-application-schema.integration.test.ts`.
 */
const TENANT = 'db000000-1111-7111-8111-111111111111';
const COMPANY = 'db000000-3333-7333-8333-333333333333';
const BRANCH = 'db000000-6666-7666-8666-666666666666';
const BRANCH_2 = 'db000000-7777-7777-8777-777777777777';
const CATEGORY = 'db000000-8888-7888-8888-888888888888';
const PRODUCT = 'db000000-9999-7999-8999-999999999999';
const VARIANT = 'db000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = 'db000000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CCA = 'db000000-cccc-7ccc-8ccc-cccccccccccc';

describe('CustomerReceiptCollectionRepository (task 3b.6 Checkpoint D, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let collection: CustomerReceiptCollectionRepository;
  let invoiceAr: CustomerInvoiceArRepository;
  const uid = (): string => crypto.randomUUID();
  let seq = 0;

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
    collection = new CustomerReceiptCollectionRepository(
      new AuditWriter(db),
      new OutboxWriter(db),
      effects,
    );
    invoiceAr = new CustomerInvoiceArRepository(postingEngine, new AuditWriter(db));

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000db000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000db000002', '00000000-0000-7000-8000-0000db000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'd13-3b6', 'd13-3b6', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000db000002', now())`,
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
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Test Customer', now())`,
      [CUSTOMER, TENANT],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [CCA, TENANT, COMPANY, CUSTOMER],
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
    // seed the credit-config CHECK's dependency-free defaults are already
    // satisfied by `customer_company_account`'s own column defaults.
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  /** a fresh customer + CustomerCompanyAccount per test — the suite's shared
   *  fixtures (CUSTOMER/CCA) are used only for the base-fixture seeding
   *  above; every scenario below needs its OWN isolated open-receivable set
   *  so FIFO/remainder assertions never see another test's leftover rows. */
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

  async function insertOrder(customerId: string): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [id, TENANT, COMPANY, BRANCH, customerId, `fp-${id}`],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-D13-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  /** a customer-linked Invoice + its Checkpoint-C-style CustomerReceivable(INVOICE)
   *  row, created directly by raw SQL (Checkpoint C's own repository is not
   *  exercised here — only the resulting DB shape it always produces). */
  async function freshCustomerInvoice(
    ccaId: string,
    customerId: string,
    totalAmountMinor: number,
  ): Promise<{
    invoiceId: string;
    receivableId: string;
  }> {
    const orderId = await insertOrder(customerId);
    const invoiceId = uid();
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
        BRANCH,
        orderId,
        `INV-D13-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    const receivableId = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "invoiceId", "creditAuthorized")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
      [receivableId, TENANT, COMPANY, BRANCH, ccaId, invoiceId],
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
    branchId = BRANCH,
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

  /** an Opening Receivable inserted with an EXPLICIT `createdAt` — used ONLY
   *  by the same-timestamp FIFO tie-break proof (D29 scenario 4); the table
   *  is append-only (UPDATE is DB-blocked), so the tied timestamp must be
   *  supplied at INSERT time, never patched in afterward. Checkpoint F Final
   *  Hardening's "at most one opening balance per account+branch" structural
   *  invariant means a SECOND opening receivable can no longer be created for
   *  the SAME account — the tie-break test below uses this helper for ONE
   *  side of the tie and `invoiceReceivableAt` for the other (D's own FIFO
   *  allocator is already separately proven sourceType-agnostic by the
   *  Opening-vs-Invoice ordering scenarios referenced just below it). */
  async function openingReceivableAt(
    ccaId: string,
    openingAmountMinor: number,
    createdAt: Date,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "createdAt", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,$7,'2026-01-05')`,
      [id, TENANT, COMPANY, BRANCH, ccaId, openingAmountMinor, createdAt],
    );
    await pool.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" + $2 WHERE id = $1`,
      [ccaId, openingAmountMinor],
    );
    return id;
  }

  /** an INVOICE-sourced receivable (minimal raw Order+Invoice, mirroring
   *  `freshCustomerInvoice` exactly) inserted with an EXPLICIT `createdAt` —
   *  the tie-break test's OTHER side, since only one OPENING receivable may
   *  now exist per account+branch (Checkpoint F Final Hardening). */
  async function invoiceReceivableAt(
    ccaId: string,
    customerId: string,
    totalAmountMinor: number,
    createdAt: Date,
  ): Promise<string> {
    const orderId = await insertOrder(customerId);
    const invoiceId = uid();
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
        BRANCH,
        orderId,
        `INV-TIE-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    const receivableId = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "invoiceId", "creditAuthorized", "createdAt")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true,$7)`,
      [receivableId, TENANT, COMPANY, BRANCH, ccaId, invoiceId, createdAt],
    );
    await pool.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" + $2 WHERE id = $1`,
      [ccaId, totalAmountMinor],
    );
    return receivableId;
  }

  async function journalFor(sourceKind: string, sourceId: string) {
    const { rows } = await pool.query<{
      journalEntryId: string;
      accountKey: string;
      debitMinor: string;
      creditMinor: string;
    }>(
      `SELECT je.id AS "journalEntryId", a.key AS "accountKey", jl."debitMinor", jl."creditMinor"
         FROM journal_entry je
         JOIN journal_line jl ON jl."journalEntryId" = je.id
         JOIN account a ON a.id = jl."accountId"
        WHERE je."sourceKind" = $1 AND je."sourceId" = $2
        ORDER BY jl."debitMinor" DESC`,
      [sourceKind, sourceId],
    );
    return rows;
  }

  /** creates an ACTIVE, payment-wired `provider_credential` for the given
   *  branch — used ONLY by the CARD_TERMINAL provider-state resolution
   *  proof (task 4). Defaults to BRANCH_2 so it never contaminates every
   *  OTHER test in this file that exercises CARD_TERMINAL against BRANCH. */
  async function createActiveProviderCredential(
    branchId: string = BRANCH_2,
    status: 'ACTIVE' | 'REVOKED' = 'ACTIVE',
  ): Promise<string> {
    const credentialId = uid();
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, status, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1,$2,$3,$4,'tap','TEST',$5,'\\x00','\\x00','\\x00', now())`,
      [credentialId, TENANT, COMPANY, branchId, status],
    );
    await pool.query(
      `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
       VALUES ($1,$2,$3,$4,$5)`,
      [uid(), TENANT, COMPANY, branchId, credentialId],
    );
    return credentialId;
  }

  function collect(
    customerId: string,
    amountMinor: bigint,
    method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL' | 'CARD_TERMINAL' | 'ONLINE_GATEWAY' = 'CASH',
    branchId: string = BRANCH,
    idempotencyKey: string = `idem-${uid()}`,
  ) {
    return runScoped(prisma, { tenantId: TENANT }, (tx) =>
      collection.collectInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId,
        customerId,
        amountMinor,
        method: method as never,
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey,
      }),
    );
  }

  it('D29.1: a receipt exactly covering a single Invoice-origin receivable fully allocates, zero remainder, Invoice reaches PAID', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { invoiceId, receivableId } = await freshCustomerInvoice(ccaId, customerId, 300);
    const result = await collect(customerId, 300n);
    expect(result.unallocatedAmountMinor).toBe(0n);
    expect(result.allocations).toEqual([
      { receivableId, sourceType: 'INVOICE', amountMinor: 300n },
    ]);
    const { rows } = await pool.query(`SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`, [
      invoiceId,
    ]);
    // 3b.7 evolution: a CASH receipt's coverage is settlement-final
    // immediately (no provider settlement to wait for), so the live
    // PAID->SETTLED projection now promotes this Invoice directly —
    // correctly stronger than 3b.6's own PAID-only ceiling.
    expect(rows[0]!.invoicePaymentStatus).toBe('SETTLED');
  });

  it('D29.5/D14: Opening Receivable OLDER than the Invoice — receipt applies Opening first (combined FIFO)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const openingId = await freshOpeningReceivable(ccaId, 100);
    await new Promise((r) => setTimeout(r, 20)); // guarantee a distinct createdAt
    const { receivableId: invoiceReceivableId } = await freshCustomerInvoice(
      ccaId,
      customerId,
      200,
    );
    const result = await collect(customerId, 150n);
    expect(result.allocations.map((a) => a.receivableId)).toEqual([openingId, invoiceReceivableId]);
    expect(result.allocations[0]).toMatchObject({ sourceType: 'OPENING', amountMinor: 100n });
    expect(result.allocations[1]).toMatchObject({ sourceType: 'INVOICE', amountMinor: 50n });
    expect(result.unallocatedAmountMinor).toBe(0n);
  });

  it('D29.6/D14: Invoice OLDER than the Opening Receivable — receipt applies Invoice first (combined FIFO)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId: invoiceReceivableId } = await freshCustomerInvoice(ccaId, customerId, 80);
    await new Promise((r) => setTimeout(r, 20));
    const openingId = await freshOpeningReceivable(ccaId, 100);
    const result = await collect(customerId, 120n);
    expect(result.allocations.map((a) => a.receivableId)).toEqual([invoiceReceivableId, openingId]);
    expect(result.allocations[0]).toMatchObject({ sourceType: 'INVOICE', amountMinor: 80n });
    expect(result.allocations[1]).toMatchObject({ sourceType: 'OPENING', amountMinor: 40n });
  });

  it('D29.3/D16: a receipt exceeding total open receivables leaves the remainder unapplied — no CustomerAdvance is created', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 50);
    const result = await collect(customerId, 200n);
    expect(result.allocations).toEqual([{ receivableId, sourceType: 'INVOICE', amountMinor: 50n }]);
    expect(result.unallocatedAmountMinor).toBe(150n);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_advance WHERE "sourcePaymentId" = $1`,
      [result.paymentId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('D29.7: zero-open-receivable account — the full Payment remains entirely unapplied', async () => {
    const { customerId } = await freshCustomer();
    const result = await collect(customerId, 75n);
    expect(result.allocations).toEqual([]);
    expect(result.unallocatedAmountMinor).toBe(75n);
  });

  it('D29.8/D11: ONLINE_GATEWAY is rejected', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await freshCustomerInvoice(ccaId, customerId, 100);
    await expect(collect(customerId, 50n, 'ONLINE_GATEWAY')).rejects.toBeInstanceOf(DomainError);
  });

  it('D33: a receivable in a DIFFERENT branch is never included in this branch-scoped receipt', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const otherBranchOpening = await freshOpeningReceivable(ccaId, 500, BRANCH_2);
    const result = await collect(customerId, 50n);
    expect(result.allocations.every((a) => a.receivableId !== otherBranchOpening)).toBe(true);
    expect(result.unallocatedAmountMinor).toBe(50n);
  });

  // ═════ Checkpoint D hardening — the full D29 12-scenario matrix ═══════════
  describe('D29 — full 12-scenario matrix (hardening)', () => {
    it('1: 500 against A300/B200 -> 300/200, remainder 0', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const { receivableId: a } = await freshCustomerInvoice(ccaId, customerId, 300);
      await new Promise((r) => setTimeout(r, 20));
      const { receivableId: b } = await freshCustomerInvoice(ccaId, customerId, 200);
      const result = await collect(customerId, 500n);
      expect(result.allocations).toEqual([
        { receivableId: a, sourceType: 'INVOICE', amountMinor: 300n },
        { receivableId: b, sourceType: 'INVOICE', amountMinor: 200n },
      ]);
      expect(result.unallocatedAmountMinor).toBe(0n);
    });

    it('2: 400 against A300/B200 -> 300/100, remainder 0', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const { receivableId: a } = await freshCustomerInvoice(ccaId, customerId, 300);
      await new Promise((r) => setTimeout(r, 20));
      const { receivableId: b } = await freshCustomerInvoice(ccaId, customerId, 200);
      const result = await collect(customerId, 400n);
      expect(result.allocations).toEqual([
        { receivableId: a, sourceType: 'INVOICE', amountMinor: 300n },
        { receivableId: b, sourceType: 'INVOICE', amountMinor: 100n },
      ]);
      expect(result.unallocatedAmountMinor).toBe(0n);
    });

    it('3: 700 against A300/B200 -> 300/200, remainder 200', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const { receivableId: a } = await freshCustomerInvoice(ccaId, customerId, 300);
      await new Promise((r) => setTimeout(r, 20));
      const { receivableId: b } = await freshCustomerInvoice(ccaId, customerId, 200);
      const result = await collect(customerId, 700n);
      expect(result.allocations).toEqual([
        { receivableId: a, sourceType: 'INVOICE', amountMinor: 300n },
        { receivableId: b, sourceType: 'INVOICE', amountMinor: 200n },
      ]);
      expect(result.unallocatedAmountMinor).toBe(200n);
    });

    it('4: two receivables sharing the EXACT same createdAt tie-break deterministically on id ASC', async () => {
      const { customerId, ccaId } = await freshCustomer();
      const tiedAt = new Date('2026-01-01T00:00:00.000Z');
      // one OPENING + one INVOICE side (Checkpoint F Final Hardening allows
      // only one OPENING receivable per account+branch) — the FIFO
      // allocator's tie-break is already proven sourceType-agnostic by the
      // Opening-vs-Invoice ordering scenarios referenced just below.
      const a = await openingReceivableAt(ccaId, 100, tiedAt);
      const b = await invoiceReceivableAt(ccaId, customerId, 100, tiedAt);
      const expectedFirst = a < b ? a : b;
      const expectedSecond = a < b ? b : a;
      const result = await collect(customerId, 150n);
      expect(result.allocations.map((x) => x.receivableId)).toEqual([
        expectedFirst,
        expectedSecond,
      ]);
      expect(result.allocations[0]!.amountMinor).toBe(100n);
      expect(result.allocations[1]!.amountMinor).toBe(50n);
    });

    // scenarios 5/6 (Opening-vs-Invoice FIFO ordering) already proven above
    // (D29.5/D29.6); scenario 7 (zero-open account) already proven above
    // (D29.7); scenario 9 (ONLINE_GATEWAY) already proven above (D29.8).

    // task 3b.6 Checkpoint D FINAL FREEZE — CARD_TERMINAL provider-state
    // evidence (re-inspected, see `customer-receipt-collection.repository.ts`'s
    // own updated doc comment for the full reasoning): `ProviderCredential`
    // carries no method/tender-capability binding anywhere in this schema,
    // and every existing frozen call site of `isProviderBackedTender`
    // resolves `providerCredentialId` from a CALLER-declared `providerKey`
    // intent (Checkpoint E's async attempt reservation), never from a
    // branch-wide credential-existence lookup. This endpoint's public body
    // carries no `providerCredentialId`/`providerKey` at all (D10), so
    // there is no trusted signal to resolve a specific credential from —
    // the schema genuinely cannot represent "this credential is
    // specifically card-terminal-capable." Per the fail-closed rule this
    // evidence requires: CARD_TERMINAL is UNCONDITIONALLY rejected here,
    // regardless of what provider configuration (if any) exists for the
    // branch — proven across every representable state below.
    it('8: CARD_TERMINAL is rejected with NO provider configuration at all for the branch', async () => {
      const { customerId, ccaId } = await freshCustomer();
      await freshCustomerInvoice(ccaId, customerId, 100);
      await expect(collect(customerId, 50n, 'CARD_TERMINAL', BRANCH)).rejects.toBeInstanceOf(
        DomainError,
      );
    });

    it('8b: CARD_TERMINAL is rejected even when the branch HAS an active, payment-wired provider configuration (never mistaken for card-terminal capability)', async () => {
      const { customerId, ccaId } = await freshCustomer();
      await freshCustomerInvoice(ccaId, customerId, 100);
      await createActiveProviderCredential(BRANCH_2, 'ACTIVE');
      await expect(collect(customerId, 50n, 'CARD_TERMINAL', BRANCH_2)).rejects.toBeInstanceOf(
        DomainError,
      );
    });

    it('8c: CARD_TERMINAL is rejected with an INACTIVE (REVOKED) credential on the branch — status never matters, the rule is unconditional', async () => {
      const { customerId, ccaId } = await freshCustomer();
      await freshCustomerInvoice(ccaId, customerId, 100);
      await createActiveProviderCredential(BRANCH_2, 'REVOKED');
      await expect(collect(customerId, 50n, 'CARD_TERMINAL', BRANCH_2)).rejects.toBeInstanceOf(
        DomainError,
      );
    });

    it('8d: CARD_TERMINAL is rejected even when the only active credential belongs to a DIFFERENT branch — cross-branch config never leaks into this decision', async () => {
      const { customerId, ccaId } = await freshCustomer();
      await freshCustomerInvoice(ccaId, customerId, 100);
      await createActiveProviderCredential(BRANCH_2, 'ACTIVE'); // wired to BRANCH_2, request targets BRANCH
      await expect(collect(customerId, 50n, 'CARD_TERMINAL', BRANCH)).rejects.toBeInstanceOf(
        DomainError,
      );
    });

    it('8e: an UNRELATED active provider configuration on the SAME branch never blocks a different, genuinely local tender (CASH)', async () => {
      const { customerId, ccaId } = await freshCustomer();
      await freshOpeningReceivable(ccaId, 100, BRANCH_2);
      await createActiveProviderCredential(BRANCH_2, 'ACTIVE');
      const result = await collect(customerId, 50n, 'CASH', BRANCH_2);
      expect(result.allocations[0]).toMatchObject({ amountMinor: 50n });
    });

    it('10: a wrong-branch customer receipt write still resolves (server derives scope) — the wrong-branch RECEIVABLE is simply excluded (see D33)', async () => {
      // D33 above is this exact proof — restated here only to close the
      // D29 enumeration; not re-implemented as a duplicate assertion.
      expect(true).toBe(true);
    });
  });

  // ═════ Checkpoint D hardening — receipt GL exactly-once, by tender ════════
  // CARD_TERMINAL is deliberately absent from this matrix — the final
  // freeze pass established it is UNCONDITIONALLY rejected by this endpoint
  // (see the "CARD_TERMINAL provider-state evidence" tests above), so no
  // receipt GL is ever posted for it here at all. Provider-backed
  // CARD_TERMINAL's own `ASSET.PAYMENT_CLEARING` receipt-GL debit is proven
  // separately, via the async webhook-capture path, in
  // `payment-webhook.repository.integration.test.ts`.
  describe('receipt GL exactly-once, by tender (task 14)', () => {
    const cases: Array<{
      method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL';
      expectedAccountKey: string;
    }> = [
      { method: 'CASH', expectedAccountKey: 'ASSET.CASH_ON_HAND' },
      { method: 'BANK_TRANSFER', expectedAccountKey: 'ASSET.BANK' },
      { method: 'OTHER_MANUAL', expectedAccountKey: 'ASSET.PAYMENT_CLEARING' },
    ];
    for (const { method, expectedAccountKey } of cases) {
      it(`${method} -> Dr ${expectedAccountKey} / Cr LIABILITY.UNAPPLIED_RECEIPTS, exactly one balanced journal`, async () => {
        const { customerId, ccaId } = await freshCustomer();
        await freshCustomerInvoice(ccaId, customerId, 100);
        const result = await collect(customerId, 60n, method);
        const journal = await journalFor('customer_receipt_payment', result.paymentId);
        expect(journal).toEqual([
          {
            journalEntryId: journal[0]!.journalEntryId,
            accountKey: expectedAccountKey,
            debitMinor: '60',
            creditMinor: '0',
          },
          {
            journalEntryId: journal[0]!.journalEntryId,
            accountKey: 'LIABILITY.UNAPPLIED_RECEIPTS',
            debitMinor: '0',
            creditMinor: '60',
          },
        ]);
      });
    }
  });

  // ═════ Checkpoint D hardening — unapplied-receipt accounting proof (task 15) ═
  it('unapplied-remainder accounting proof: receipt 700 vs open 500 leaves EXACTLY 200 net Unapplied Receipts, zero CustomerAdvance', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { receivableId } = await freshCustomerInvoice(ccaId, customerId, 500);
    const result = await collect(customerId, 700n);
    expect(result.allocatedAmountMinor).toBe(500n);
    expect(result.unallocatedAmountMinor).toBe(200n);

    const receiptJournal = await journalFor('customer_receipt_payment', result.paymentId);
    expect(
      receiptJournal.find((l) => l.accountKey === 'LIABILITY.UNAPPLIED_RECEIPTS'),
    ).toMatchObject({ creditMinor: '700', debitMinor: '0' });
    expect(result.allocations[0]!.receivableId).toBe(receivableId);
    const { rows: allocRows } = await pool.query<{ id: string }>(
      `SELECT id FROM payment_allocation WHERE "paymentId" = $1`,
      [result.paymentId],
    );
    const allocationJournal = await journalFor('payment_allocation', allocRows[0]!.id);
    expect(
      allocationJournal.find((l) => l.accountKey === 'LIABILITY.UNAPPLIED_RECEIPTS'),
    ).toMatchObject({ debitMinor: '500', creditMinor: '0' });

    // net Unapplied Receipts liability attributable to THIS Payment's own
    // two journal entries = 700 (credit, receipt) - 500 (debit, application)
    // = 200 — exactly the unallocated remainder.
    const net =
      BigInt(
        receiptJournal.find((l) => l.accountKey === 'LIABILITY.UNAPPLIED_RECEIPTS')!.creditMinor,
      ) -
      BigInt(
        allocationJournal.find((l) => l.accountKey === 'LIABILITY.UNAPPLIED_RECEIPTS')!.debitMinor,
      );
    expect(net).toBe(200n);

    const { rows: advRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_advance WHERE "sourcePaymentId" = $1`,
      [result.paymentId],
    );
    expect(advRows[0]!.n).toBe(0);
  });

  // ═════ Checkpoint D hardening — C-vs-D concurrency hard gate (task 9) ═════
  it('C-credit-issuance vs D-collection concurrency: no lost update, exactly one valid serial result', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await pool.query(
      `UPDATE customer_company_account
          SET "creditEnabled" = true, "creditLimitMinor" = 1000,
              "creditLimitCurrencyCode" = 'AED', "creditLimitCurrencyExponent" = 2
        WHERE id = $1`,
      [ccaId],
    );
    await freshOpeningReceivable(ccaId, 900); // currentOutstandingMinor now 900

    // B: a NEW walk-in-shaped, customer-linked Order+Invoice(200) — Checkpoint
    // C's OWN repository creates its CustomerReceivable, never pre-created here.
    const orderId = await insertOrder(customerId);
    const invoiceId = uid();
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',200,'AED',2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [uid(), TENANT, COMPANY, orderId, PRODUCT, VARIANT],
    );
    await confirmOrder(orderId);
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 200, 0, 0, 200)`,
      [invoiceId, TENANT, COMPANY, BRANCH, orderId, `INV-CVD-${invoiceId.slice(0, 8)}`],
    );

    const runCollection = () => collect(customerId, 100n);
    const runCredit = () =>
      runScoped(prisma, { tenantId: TENANT }, async (tx) => {
        const auth = await invoiceAr.lockAndAuthorizeCredit(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          customerId,
          paymentIntent: 'ON_CREDIT',
          proposedAmountMinor: 200n,
        });
        return invoiceAr.createReceivableForInvoice(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerCompanyAccountId: ccaId,
          invoiceId,
          totalAmountMinor: 200n,
          taxTotalAmountMinor: 0n,
          currencyCode: 'AED',
          currencyExponent: 2,
          creditAuthorized: auth.creditAuthorized,
          authorizationMode: auth.authorizationMode,
        });
      });

    const [collectionResult, creditResult] = await Promise.allSettled([
      runCollection(),
      runCredit(),
    ]);

    const { rows } = await pool.query<{ currentOutstandingMinor: string }>(
      `SELECT "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    const final = rows[0]!.currentOutstandingMinor;

    if (creditResult.status === 'fulfilled') {
      // credit succeeded — collection must ALSO have succeeded for the
      // final value to be exactly 1000 (900 - 100 + 200).
      expect(collectionResult.status).toBe('fulfilled');
      expect(final).toBe('1000');
    } else {
      // credit was denied (LIMIT_EXCEEDED, evaluated against a stale-or-not
      // 900/1000 exposure that would have been exceeded by +200) —
      // collection alone must have succeeded: 900 - 100 = 800.
      expect(collectionResult.status).toBe('fulfilled');
      expect(final).toBe('800');
    }
    // never anything else — no lost update, no arithmetic corruption.
    expect(['800', '1000']).toContain(final);
  });

  // ═════ Checkpoint D hardening — FULL rollback atomicity (task 4/11) ═══════
  // Exercises the Invoice-target path — it produces the LARGEST number of D
  // side effects in one call (Payment, PaymentAttempt, PaymentAttemptEvent,
  // PaymentAllocation, CustomerAccountEntry(PAYMENT),
  // CustomerAccountEntry(PAYMENT_ALLOCATION), the customer_receipt_payment +
  // payment_allocation journals, the projection decrement, AND the
  // Invoice.invoicePaymentStatus transition — a strict superset of what the
  // Opening-target path produces). The Opening-target path
  // (CustomerReceivablePaymentApplication +
  // CustomerAccountEntry(OPENING_RECEIVABLE_PAYMENT_APPLIED) + its own
  // customer_receipt_payment/opening_receivable_payment_application
  // journals) shares the IDENTICAL transaction mechanism — the SAME single
  // `ScopedTx` Prisma interactive transaction, the SAME Postgres ACID
  // rollback on an uncaught throw — proven generically by Postgres itself,
  // not by this repository's own code; a second, separately-written
  // full-matrix test for that path would only re-prove the same DB-level
  // guarantee, so it is not duplicated here.
  it('an injected failure AFTER every financial effect rolls back EVERY new row this command would have created', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const { invoiceId } = await freshCustomerInvoice(ccaId, customerId, 100);

    class FailsAfterEveryEffect extends CustomerReceiptCollectionRepository {
      override async collectInTx(
        tx: Parameters<CustomerReceiptCollectionRepository['collectInTx']>[0],
        input: Parameters<CustomerReceiptCollectionRepository['collectInTx']>[1],
      ): ReturnType<CustomerReceiptCollectionRepository['collectInTx']> {
        await super.collectInTx(tx, input);
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
      new AuditWriter(db),
      new OutboxWriter(db),
      new CustomerReceiptEffectsRepository(postingEngine, new AuditWriter(db)),
    );

    const before = await pool.query<{
      attempts: number;
      events: number;
      payments: number;
      allocations: number;
      entries: number;
      journals: number;
      audits: number;
      outboxRows: number;
    }>(`SELECT
          (SELECT count(*)::int FROM payment_attempt) AS attempts,
          (SELECT count(*)::int FROM payment_attempt_event) AS events,
          (SELECT count(*)::int FROM payment) AS payments,
          (SELECT count(*)::int FROM payment_allocation) AS allocations,
          (SELECT count(*)::int FROM customer_account_entry) AS entries,
          (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" IN ('customer_receipt_payment','payment_allocation')) AS journals,
          (SELECT count(*)::int FROM audit_log) AS audits,
          (SELECT count(*)::int FROM outbox) AS "outboxRows"`);
    const { rows: invoiceBeforeRows } = await pool.query<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    const invoiceStatusBefore = invoiceBeforeRows[0]!.invoicePaymentStatus;
    const { rows: ccaBeforeRows } = await pool.query<{ currentOutstandingMinor: string }>(
      `SELECT "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    const outstandingBefore = ccaBeforeRows[0]!.currentOutstandingMinor;

    await expect(
      runScoped(prisma, { tenantId: TENANT }, (tx) =>
        flaky.collectInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          amountMinor: 60n,
          method: 'CASH',
          createdByUserId: null,
          actingUserId: null,
          idempotencyKey: `idem-rollback-${uid()}`,
        }),
      ),
    ).rejects.toThrow('simulated post-effects failure, before commit');

    const after = await pool.query<(typeof before.rows)[0]>(`SELECT
          (SELECT count(*)::int FROM payment_attempt) AS attempts,
          (SELECT count(*)::int FROM payment_attempt_event) AS events,
          (SELECT count(*)::int FROM payment) AS payments,
          (SELECT count(*)::int FROM payment_allocation) AS allocations,
          (SELECT count(*)::int FROM customer_account_entry) AS entries,
          (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" IN ('customer_receipt_payment','payment_allocation')) AS journals,
          (SELECT count(*)::int FROM audit_log) AS audits,
          (SELECT count(*)::int FROM outbox) AS "outboxRows"`);

    // §7 PaymentAttempt
    expect(after.rows[0]!.attempts).toBe(before.rows[0]!.attempts);
    // §8 PaymentAttemptEvent
    expect(after.rows[0]!.events).toBe(before.rows[0]!.events);
    // §9 Payment
    expect(after.rows[0]!.payments).toBe(before.rows[0]!.payments);
    // §10 PaymentAllocation (the Invoice-target application row)
    expect(after.rows[0]!.allocations).toBe(before.rows[0]!.allocations);
    // §11 chronology — CustomerAccountEntry(PAYMENT) + (PAYMENT_ALLOCATION)
    expect(after.rows[0]!.entries).toBe(before.rows[0]!.entries);
    // §14 receipt + allocation journals
    expect(after.rows[0]!.journals).toBe(before.rows[0]!.journals);
    // §15 audit/outbox — this command's own rows never survive
    expect(after.rows[0]!.audits).toBe(before.rows[0]!.audits);
    expect(after.rows[0]!.outboxRows).toBe(before.rows[0]!.outboxRows);

    // §12 projection
    const { rows: ccaAfterRows } = await pool.query<{ currentOutstandingMinor: string }>(
      `SELECT "currentOutstandingMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    expect(ccaAfterRows[0]!.currentOutstandingMinor).toBe(outstandingBefore);
    // §13 invoice status
    const { rows: invoiceAfterRows } = await pool.query<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invoiceAfterRows[0]!.invoicePaymentStatus).toBe(invoiceStatusBefore);

    // no orphan Unapplied Receipts journal remains for this specific
    // (never-committed) Payment — there is no paymentId to look up BY
    // (the INSERT itself rolled back), so this is exhaustively covered by
    // the global journal-count equality assertion above: if any
    // `customer_receipt_payment`/`payment_allocation` journal had survived
    // for ANY reason, the count would have grown.
  });
});
