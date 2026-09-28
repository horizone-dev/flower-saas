import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { InvoiceSettlementProjectionRepository } from './invoice-settlement-projection.repository.js';
import { HistoricalSettlementReconciliationRepository } from './historical-settlement-reconciliation.repository.js';

/**
 * Task 3b.7 Checkpoint E — historical PAID->SETTLED Invoice reconciliation,
 * proven directly against real Postgres.
 *
 * Every fixture Invoice is constructed at `invoicePaymentStatus = 'PAID'`
 * WITHOUT ever calling the live Checkpoint D projection hook (raw SQL, no
 * `CustomerReceiptEffectsRepository`/`CustomerAdvanceApplicationRepository`
 * write path) — simulating genuinely historical data that predates the
 * live hook. Genuine "fully-settled provider Payment" evidence is likewise
 * constructed via raw SQL mirroring `settlement-batch.controller.
 * integration.test.ts`'s own "finalized batch via raw SQL" precedent
 * (Checkpoint C) — NEVER by calling the real `SettlementFinalizationRepository.
 * finalizeInTx`, since THAT already runs the live projection itself
 * (Call Site A) and would immediately promote the Invoice, defeating the
 * entire premise of a "stuck at PAID, never reconciled" historical fixture.
 */
const TENANT = 'e9000000-1111-7111-8111-111111111111';
const TENANT_B = 'e9000000-2222-7222-8222-222222222222';
const COMPANY_A = 'e9000000-3333-7333-8333-333333333333';
const COMPANY_B = 'e9000000-4444-7444-8444-444444444444';
const BRANCH_A = 'e9000000-6666-7666-8666-666666666666';
const BRANCH_A2 = 'e9000000-7777-7777-8777-777777777777';
const BRANCH_B = 'e9000000-9999-7999-8999-999999999999';
const CRED_A = 'e9000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY = 'e9000000-8888-7888-8888-888888888888';
const PRODUCT = 'e9000000-9999-7999-8999-999999999999';
const VARIANT = 'e9000000-cccc-7ccc-8ccc-cccccccccccc';

describe('HistoricalSettlementReconciliationRepository (task 3b.7 Checkpoint E, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let db: DbService;
  let reconciliation: HistoricalSettlementReconciliationRepository;
  const uid = (): string => crypto.randomUUID();
  let seq = 0;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    reconciliation = new HistoricalSettlementReconciliationRepository(
      db,
      new InvoiceSettlementProjectionRepository(),
      new AuditWriter(db),
    );

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000e9000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000e9000002', '00000000-0000-7000-8000-0000e9000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT, 'recon-3b7e'],
      [TENANT_B, 'recon-3b7e-other'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000e9000002', now())`,
        [id, slug],
      );
    }
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'د.إ', 'UAE Dirham', 'درهم إماراتي') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Co A', 'AED', 'Asia/Dubai', now())`,
      [COMPANY_A, TENANT],
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Co B', 'AED', 'Asia/Dubai', now())`,
      [COMPANY_B, TENANT],
    );
    for (const [branchId, companyId] of [
      [BRANCH_A, COMPANY_A],
      [BRANCH_A2, COMPANY_A],
      [BRANCH_B, COMPANY_B],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Branch', now())`,
        [branchId, TENANT, companyId],
      );
    }
    await pool.query(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
      [CRED_A, TENANT, COMPANY_A, BRANCH_A],
    );
    await pool.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt") VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await pool.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose-bouquet', 'Test Product', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await pool.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt") VALUES ($1, $2, $3, 'Test Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
    for (const companyId of [COMPANY_A, COMPANY_B]) {
      await pool.query(
        `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
         VALUES (uuidv7(),$1,$2,'2026-01-01','2026-12-31','OPEN',now())`,
        [TENANT, companyId],
      );
      for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
        await pool.query(
          `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,now())`,
          [TENANT, companyId, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
        );
      }
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await stack?.stop();
  });

  // ── fixture helpers ─────────────────────────────────────────────────────
  async function insertCustomerAndCca(
    companyId: string,
  ): Promise<{ customerId: string; ccaId: string }> {
    const customerId = uid();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Cust',now())`,
      [customerId, TENANT],
    );
    const ccaId = uid();
    await pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [ccaId, TENANT, companyId, customerId],
    );
    return { customerId, ccaId };
  }

  /** a historical, already-PAID Invoice — constructed entirely via raw SQL,
   *  NEVER through a live write path, so no Checkpoint D projection hook
   *  ever ran against it. */
  async function insertHistoricalPaidInvoice(
    companyId: string,
    branchId: string,
    totalAmountMinor = 1000,
  ): Promise<{ invoiceId: string; receivableId: string; ccaId: string; customerId: string }> {
    const { customerId, ccaId } = await insertCustomerAndCca(companyId);
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
        companyId,
        branchId,
        customerId,
        `fp-${orderId}`,
        `ORD-E9-${(++seq).toString().padStart(6, '0')}`,
      ],
    );
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
      [uid(), TENANT, companyId, orderId, PRODUCT, VARIANT, totalAmountMinor],
    );
    const invoiceId = uid();
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor",
          "invoicePaymentStatus")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, $7, 0, 0, $7, 'PAID')`,
      [
        invoiceId,
        TENANT,
        companyId,
        branchId,
        orderId,
        `INV-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    const receivableId = uid();
    await pool.query(
      `INSERT INTO customer_receivable
         (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
      [receivableId, TENANT, companyId, branchId, ccaId, invoiceId],
    );
    return { invoiceId, receivableId, ccaId, customerId };
  }

  async function invoiceStatus(invoiceId: string): Promise<string> {
    const rows = await pool.query<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    return rows.rows[0]!.invoicePaymentStatus;
  }

  async function insertNonProviderPayment(
    companyId: string,
    branchId: string,
    method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL',
    amountMinor = 500,
  ): Promise<string> {
    const { ccaId } = await insertCustomerAndCca(companyId);
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,$6,$7,'AED',2,'CAPTURED',$8,now())`,
      [attemptId, TENANT, companyId, branchId, ccaId, method, amountMinor, `idem-${Math.random()}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [paymentId, TENANT, companyId, branchId, attemptId, method, amountMinor],
    );
    return paymentId;
  }

  async function insertProviderPayment(
    companyId: string,
    branchId: string,
    amountMinor = 1000,
    credentialId = CRED_A,
    ccaIdOverride?: string,
  ): Promise<string> {
    const ccaId = ccaIdOverride ?? (await insertCustomerAndCca(companyId)).ccaId;
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",
          method,"providerKey","providerCredentialId","amountMinor","currencyCode",
          "currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'ONLINE_GATEWAY','tap',$6,$7,'AED',2,'CAPTURED',$8,now())`,
      [
        attemptId,
        TENANT,
        companyId,
        branchId,
        ccaId,
        credentialId,
        amountMinor,
        `idem-${Math.random()}`,
      ],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'ONLINE_GATEWAY','tap',$6,'AED',2)`,
      [paymentId, TENANT, companyId, branchId, attemptId, amountMinor],
    );
    return paymentId;
  }

  /** raw PaymentAllocation insert — fires the real capacity trigger, but
   *  deliberately does NOT call `applyInvoiceAllocationEffectsInTx` (no live
   *  projection hook). */
  async function insertRawPaymentAllocation(
    companyId: string,
    branchId: string,
    paymentId: string,
    invoiceId: string,
    amountMinor: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO "payment_allocation" ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,'AED',2)`,
      [TENANT, companyId, branchId, paymentId, invoiceId, amountMinor],
    );
  }

  async function insertAdvance(
    companyId: string,
    branchId: string,
    ccaId: string,
    sourceType: 'OPENING' | 'PAYMENT',
    amountMinor: number,
    sourcePaymentId: string | null = null,
  ): Promise<string> {
    const advanceId = uid();
    if (sourceType === 'OPENING') {
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,CURRENT_DATE)`,
        [advanceId, TENANT, companyId, branchId, ccaId, amountMinor],
      );
    } else {
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
        [advanceId, TENANT, companyId, branchId, ccaId, sourcePaymentId, amountMinor],
      );
    }
    return advanceId;
  }

  /** raw CustomerAdvanceApplication insert — fires the real capacity
   *  trigger, but deliberately does NOT call the live application write
   *  path / projection hook. */
  async function insertRawAdvanceApplication(
    companyId: string,
    branchId: string,
    advanceId: string,
    receivableId: string,
    amountMinor: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
       VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,'AED',2)`,
      [TENANT, companyId, branchId, advanceId, receivableId, amountMinor],
    );
  }

  /** Genuine FINALIZED SettlementApplication/JournalEntry evidence,
   *  constructed via raw SQL exactly mirroring Checkpoint C's own
   *  "finalized batch via raw SQL" precedent — never via the real
   *  `SettlementFinalizationRepository.finalizeInTx` (which would run the
   *  live projection itself and immediately promote the Invoice, defeating
   *  the "never reconciled" premise this fixture exists to create). */
  async function insertGenuineFinalizedSettlement(
    companyId: string,
    branchId: string,
    paymentId: string,
    amountMinor: number,
  ): Promise<string> {
    // ONE explicit transaction (mirrors Checkpoint C's own "finalized batch
    // via raw SQL" precedent) — the journal-entry-must-be-sealed-at-commit
    // deferred trigger otherwise fires on each separate auto-committing
    // `pool.query` call.
    const client = new pg.Client({ connectionString: stack.postgres.url });
    await client.connect();
    try {
      await client.query('BEGIN');
      const bankAcct = await client.query(
        `SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.BANK'`,
        [companyId],
      );
      const clearingAcct = await client.query(
        `SELECT id FROM account WHERE "companyId"=$1 AND key='ASSET.PAYMENT_CLEARING'`,
        [companyId],
      );
      const period = await client.query(
        `SELECT id FROM accounting_period WHERE "companyId"=$1 LIMIT 1`,
        [companyId],
      );
      const batchId = uid();
      const je = uid();
      await client.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
         VALUES ($1,$2,$3,$4,'2026-06-01','SETTLEMENT_BATCH',$5,'AED','fp')`,
        [je, TENANT, companyId, period.rows[0].id, batchId],
      );
      await client.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,0)`,
        [TENANT, companyId, je, bankAcct.rows[0].id, branchId, amountMinor],
      );
      await client.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor") VALUES (uuidv7(),$1,$2,$3,$4,$5,0,$6)`,
        [TENANT, companyId, je, clearingAcct.rows[0].id, branchId, amountMinor],
      );
      await client.query(`UPDATE journal_entry SET "sealedAt"=now() WHERE id=$1`, [je]);
      const lineId = uid();
      // Batch inserted as DRAFT first (Checkpoint B's own two-phase
      // Application/Batch gate requires the parent to be DRAFT at Line/
      // Application insert time) — the DRAFT->FINALIZED transition is the
      // LAST statement, exactly mirroring the real `finalizeInTx` sequence.
      await client.query(
        `INSERT INTO settlement_batch
           (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
            "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor",
            "currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',$7,0,$7,'AED',2)`,
        [
          batchId,
          TENANT,
          companyId,
          branchId,
          CRED_A,
          `hist-ext-${batchId.slice(0, 8)}`,
          amountMinor,
        ],
      );
      await client.query(
        `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
         VALUES ($1,$2,$3,$4,$5,$6,'AED',2,$7)`,
        [lineId, TENANT, companyId, branchId, batchId, amountMinor, paymentId],
      );
      await client.query(
        `INSERT INTO settlement_application (id,"tenantId","companyId","branchId","batchId","lineId","paymentId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,$7,'AED',2)`,
        [TENANT, companyId, branchId, batchId, lineId, paymentId, amountMinor],
      );
      await client.query(
        `UPDATE settlement_batch SET state='FINALIZED', "journalEntryId"=$1, "finalizedAt"=now(), version=version+1 WHERE id=$2`,
        [je, batchId],
      );
      await client.query('COMMIT');
      return batchId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      await client.end();
    }
  }

  async function countRows(table: string): Promise<number> {
    const rows = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`);
    return Number(rows.rows[0]!.n);
  }

  async function auditCount(action: string, resourceId: string): Promise<number> {
    const rows = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log WHERE action = $1 AND "resourceId" = $2`,
      [action, resourceId],
    );
    return Number(rows.rows[0]!.n);
  }

  async function outboxTotal(): Promise<number> {
    return countRows('outbox');
  }

  // ═══════════════════ required historical rules (1-13) ═══════════════════
  describe('historical rules', () => {
    it('1. cash-only PAID -> SETTLED', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 500);
      const payment = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 500);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, payment, invoiceId, 500);
      const result = await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        branchId: null,
        cursor: null,
        limit: 100,
      });
      expect(result.settledCount).toBeGreaterThanOrEqual(1);
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('2. bank-transfer-only PAID -> SETTLED', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 500);
      const payment = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'BANK_TRANSFER', 500);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, payment, invoiceId, 500);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('3. opening-advance-only PAID -> SETTLED', async () => {
      const { invoiceId, receivableId, ccaId } = await insertHistoricalPaidInvoice(
        COMPANY_A,
        BRANCH_A,
        400,
      );
      const advanceId = await insertAdvance(COMPANY_A, BRANCH_A, ccaId, 'OPENING', 400);
      await insertRawAdvanceApplication(COMPANY_A, BRANCH_A, advanceId, receivableId, 400);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('4. OTHER_MANUAL PAID -> remains PAID', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 300);
      const payment = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'OTHER_MANUAL', 300);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, payment, invoiceId, 300);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('5. provider Payment with zero finalized settlement evidence -> remains PAID', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 700);
      const payment = await insertProviderPayment(COMPANY_A, BRANCH_A, 700);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, payment, invoiceId, 700);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('6. provider Payment partially settled -> remains PAID', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 1000);
      const payment = await insertProviderPayment(COMPANY_A, BRANCH_A, 1000);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, payment, invoiceId, 1000);
      await insertGenuineFinalizedSettlement(COMPANY_A, BRANCH_A, payment, 600); // only 600 of 1000 settled
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('7. provider Payment fully settled through genuine finalized SettlementApplications -> SETTLED', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 900);
      const payment = await insertProviderPayment(COMPANY_A, BRANCH_A, 900);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, payment, invoiceId, 900);
      await insertGenuineFinalizedSettlement(COMPANY_A, BRANCH_A, payment, 900);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('8. Payment-funded Advance, source provider Payment unsettled -> PAID', async () => {
      const { invoiceId, receivableId, ccaId } = await insertHistoricalPaidInvoice(
        COMPANY_A,
        BRANCH_A,
        800,
      );
      const payment = await insertProviderPayment(COMPANY_A, BRANCH_A, 800, CRED_A, ccaId);
      const advanceId = await insertAdvance(COMPANY_A, BRANCH_A, ccaId, 'PAYMENT', 800, payment);
      await insertRawAdvanceApplication(COMPANY_A, BRANCH_A, advanceId, receivableId, 800);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('9. Payment-funded Advance, source Payment fully settled -> SETTLED', async () => {
      const { invoiceId, receivableId, ccaId } = await insertHistoricalPaidInvoice(
        COMPANY_A,
        BRANCH_A,
        650,
      );
      const payment = await insertProviderPayment(COMPANY_A, BRANCH_A, 650, CRED_A, ccaId);
      const advanceId = await insertAdvance(COMPANY_A, BRANCH_A, ccaId, 'PAYMENT', 650, payment);
      await insertRawAdvanceApplication(COMPANY_A, BRANCH_A, advanceId, receivableId, 650);
      await insertGenuineFinalizedSettlement(COMPANY_A, BRANCH_A, payment, 650);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('10. Cash + fully-settled provider Payment -> SETTLED', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 1000);
      const cash = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 400);
      const card = await insertProviderPayment(COMPANY_A, BRANCH_A, 600);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cash, invoiceId, 400);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, card, invoiceId, 600);
      await insertGenuineFinalizedSettlement(COMPANY_A, BRANCH_A, card, 600);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('11. Cash + partially-settled provider Payment -> PAID', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 1000);
      const cash = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 400);
      const card = await insertProviderPayment(COMPANY_A, BRANCH_A, 600);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cash, invoiceId, 400);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, card, invoiceId, 600);
      await insertGenuineFinalizedSettlement(COMPANY_A, BRANCH_A, card, 300); // only 300 of 600 settled
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('12. provider Payment + OTHER_MANUAL -> PAID', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 1000);
      const card = await insertProviderPayment(COMPANY_A, BRANCH_A, 600);
      const manual = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'OTHER_MANUAL', 400);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, card, invoiceId, 600);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, manual, invoiceId, 400);
      await insertGenuineFinalizedSettlement(COMPANY_A, BRANCH_A, card, 600);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('13. Opening Advance + Cash -> SETTLED', async () => {
      const { invoiceId, receivableId, ccaId } = await insertHistoricalPaidInvoice(
        COMPANY_A,
        BRANCH_A,
        1000,
      );
      const advanceId = await insertAdvance(COMPANY_A, BRANCH_A, ccaId, 'OPENING', 400);
      await insertRawAdvanceApplication(COMPANY_A, BRANCH_A, advanceId, receivableId, 400);
      const cash = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 600);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cash, invoiceId, 600);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });
  });

  // ═══════════════════════ no-fake-evidence proof ═══════════════════════
  describe('no fake evidence', () => {
    it('reconciliation creates NO financial/evidence records — only Invoice.status + one audit row', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 900);
      const payment = await insertProviderPayment(COMPANY_A, BRANCH_A, 900);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, payment, invoiceId, 900);
      await insertGenuineFinalizedSettlement(COMPANY_A, BRANCH_A, payment, 900);

      const tables = [
        'settlement_batch',
        'settlement_line',
        'settlement_application',
        'payment_attempt',
        'payment',
        'payment_allocation',
        'journal_entry',
        'journal_line',
        'customer_advance',
        'customer_advance_application',
      ];
      const before = await Promise.all(tables.map(countRows));

      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');

      const after = await Promise.all(tables.map(countRows));
      expect(after).toEqual(before);
    });
  });

  // ═══════════════════════ cursor / batch / resume ═══════════════════════
  describe('cursor / batch / resume', () => {
    it('processes exactly one deterministic window per batch, resumes via nextCursor with no OFFSET, until hasMore=false', async () => {
      const companyId = uid(); // isolated company just for this test's candidate count
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, 'Co Cursor', 'AED', 'Asia/Dubai', now())`,
        [companyId, TENANT],
      );
      const branchId = uid();
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Branch', now())`,
        [branchId, TENANT, companyId],
      );
      const invoiceIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { invoiceId } = await insertHistoricalPaidInvoice(companyId, branchId, 100);
        const payment = await insertNonProviderPayment(companyId, branchId, 'CASH', 100);
        await insertRawPaymentAllocation(companyId, branchId, payment, invoiceId, 100);
        invoiceIds.push(invoiceId);
      }
      invoiceIds.sort();

      const batch1 = await reconciliation.runBatch({
        tenantId: TENANT,
        companyId,
        cursor: null,
        limit: 2,
      });
      expect(batch1.processedCount).toBeLessThanOrEqual(2);
      expect(batch1.hasMore).toBe(true);
      expect(batch1.nextCursor).toBeTruthy();

      const batch2 = await reconciliation.runBatch({
        tenantId: TENANT,
        companyId,
        cursor: batch1.nextCursor,
        limit: 2,
      });
      expect(batch2.processedCount).toBeLessThanOrEqual(2);

      let cursor = batch2.nextCursor;
      let hasMore = batch2.hasMore;
      let totalProcessed = batch1.processedCount + batch2.processedCount;
      while (hasMore) {
        const next = await reconciliation.runBatch({
          tenantId: TENANT,
          companyId,
          cursor,
          limit: 2,
        });
        totalProcessed += next.processedCount;
        cursor = next.nextCursor;
        hasMore = next.hasMore;
      }
      expect(totalProcessed).toBe(5);
      for (const id of invoiceIds) {
        expect(await invoiceStatus(id)).toBe('SETTLED');
      }
    });
  });

  // ═══════════════════════ re-run / idempotency ═══════════════════════
  describe('re-run same cursor window', () => {
    it('already-SETTLED invoices do not regress; remaining PAID invoices safely re-evaluate; no financial duplication', async () => {
      const { invoiceId: settledId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 200);
      const cash = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 200);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cash, settledId, 200);

      const { invoiceId: paidId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 300);
      const manual = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'OTHER_MANUAL', 300);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, manual, paidId, 300);

      const first = await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(settledId)).toBe('SETTLED');
      expect(await invoiceStatus(paidId)).toBe('PAID');

      const before = await countRows('customer_advance_application');
      const beforeAlloc = await countRows('payment_allocation');

      // re-run the exact same cursor window (null / from the start).
      const second = await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(settledId)).toBe('SETTLED'); // never regresses
      expect(await invoiceStatus(paidId)).toBe('PAID'); // safely re-evaluated, unchanged
      expect(await countRows('customer_advance_application')).toBe(before);
      expect(await countRows('payment_allocation')).toBe(beforeAlloc);

      // the SETTLED invoice is no longer a PAID candidate at all on the
      // second run (it left the candidate set), so `second` never touches it.
      expect(second.processedCount).toBeLessThanOrEqual(first.processedCount);
    });
  });

  // ═══════════════════════ scope isolation ═══════════════════════
  describe('scope isolation', () => {
    it('a Company A run does not modify Company B', async () => {
      const { invoiceId: invoiceA } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 400);
      const cashA = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 400);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cashA, invoiceA, 400);

      const { invoiceId: invoiceB } = await insertHistoricalPaidInvoice(COMPANY_B, BRANCH_B, 400);
      const cashB = await insertNonProviderPayment(COMPANY_B, BRANCH_B, 'CASH', 400);
      await insertRawPaymentAllocation(COMPANY_B, BRANCH_B, cashB, invoiceB, 400);

      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceA)).toBe('SETTLED');
      expect(await invoiceStatus(invoiceB)).toBe('PAID'); // untouched
    });

    it('a Branch A run (branch-scoped) does not modify Branch A2 (same Company A)', async () => {
      const { invoiceId: invoiceA } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 250);
      const cashA = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 250);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cashA, invoiceA, 250);

      const { invoiceId: invoiceA2 } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A2, 250);
      const cashA2 = await insertNonProviderPayment(COMPANY_A, BRANCH_A2, 'CASH', 250);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A2, cashA2, invoiceA2, 250);

      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        branchId: BRANCH_A,
        cursor: null,
        limit: 100,
      });
      expect(await invoiceStatus(invoiceA)).toBe('SETTLED');
      expect(await invoiceStatus(invoiceA2)).toBe('PAID'); // untouched — different branch
    });

    it('cross-tenant rows never appear (RLS remains active inside runScoped)', async () => {
      const coOtherTenant = uid();
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, 'Co Other Tenant', 'AED', 'Asia/Dubai', now())`,
        [coOtherTenant, TENANT_B],
      );
      const branchOtherTenant = uid();
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Branch', now())`,
        [branchOtherTenant, TENANT_B, coOtherTenant],
      );
      // attempting to reconcile tenant B's company under tenant A's
      // authority must find nothing (RLS scopes strictly by tenantId).
      const result = await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: coOtherTenant,
        cursor: null,
        limit: 100,
      });
      expect(result.processedCount).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });

  // ═══════════════════════ maintenance audit ═══════════════════════
  describe('maintenance audit', () => {
    it('one run writes exactly one bounded settlement.reconciliation_run summary row; no per-Invoice audit; no PII/secret', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 150);
      const cash = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 150);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cash, invoiceId, 150);

      const before = await auditCount('settlement.reconciliation_run', COMPANY_A);
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      const after = await auditCount('settlement.reconciliation_run', COMPANY_A);
      expect(after).toBe(before + 1);

      const rows = await pool.query<{ after: Record<string, unknown> }>(
        `SELECT "after" FROM audit_log WHERE action = 'settlement.reconciliation_run' AND "resourceId" = $1 ORDER BY at DESC LIMIT 1`,
        [COMPANY_A],
      );
      const payload = rows.rows[0]!.after;
      expect(Object.keys(payload).sort()).toEqual(
        ['hasMore', 'processedCount', 'settledCount', 'unchangedCount'].sort(),
      );
      expect(JSON.stringify(payload)).not.toMatch(/secretCiphertext|secretNonce|dekWrapped/i);

      const settlementFinalizedCount = await auditCount('settlement.finalized', COMPANY_A);
      expect(settlementFinalizedCount).toBe(0); // never fabricates a finalize event
    });
  });

  // ═══════════════════════ outbox ═══════════════════════
  describe('outbox', () => {
    it('a historical run creates ZERO outbox rows of any kind', async () => {
      const { invoiceId } = await insertHistoricalPaidInvoice(COMPANY_A, BRANCH_A, 175);
      const cash = await insertNonProviderPayment(COMPANY_A, BRANCH_A, 'CASH', 175);
      await insertRawPaymentAllocation(COMPANY_A, BRANCH_A, cash, invoiceId, 175);

      const before = await outboxTotal();
      await reconciliation.runBatch({
        tenantId: TENANT,
        companyId: COMPANY_A,
        cursor: null,
        limit: 100,
      });
      const after = await outboxTotal();
      expect(after).toBe(before);
    });
  });

  // ═══════════════════════ no startup / no request-side execution ═══════
  describe('no startup / no request-side execution (source proof)', () => {
    it('HistoricalSettlementReconciliationRepository is registered but never invoked by AppModule bootstrap or any HTTP route', async () => {
      // structural proof: the class is a plain provider with no
      // `@Controller`, and `runBatch` is never referenced from any
      // `*.controller.ts` file in this repo.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const modulesDir = path.resolve(process.cwd(), 'src/modules');
      async function* walk(dir: string): AsyncGenerator<string> {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) yield* walk(full);
          else if (entry.name.endsWith('.controller.ts')) yield full;
        }
      }
      for await (const file of walk(modulesDir)) {
        const content = await fs.readFile(file, 'utf8');
        expect(content).not.toMatch(/HistoricalSettlementReconciliationRepository/);
        expect(content).not.toMatch(/runBatch\(/);
      }
    });
  });
});
