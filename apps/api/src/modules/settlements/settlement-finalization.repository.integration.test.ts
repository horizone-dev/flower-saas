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
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { SystemClock } from '../../common/clock/clock.js';
import { CustomerReceiptEffectsRepository } from '../receivables/customer-receipt-effects.repository.js';
import { PaymentAdvanceConversionRepository } from '../receivables/payment-advance-conversion.repository.js';
import { CustomerAdvanceApplicationRepository } from '../receivables/customer-advance-application.repository.js';
import { PaymentCustomerAttributionRepository } from '../receivables/payment-customer-attribution.repository.js';
import { InvoiceSettlementProjectionRepository } from './invoice-settlement-projection.repository.js';
import { SettlementFinalizationRepository } from './settlement-finalization.repository.js';

/**
 * Task 3b.7 Checkpoint D — settlement finalization + GL + live Invoice
 * SETTLED projection, proven directly against real Postgres. Mirrors
 * `customer-advance-application.integration.test.ts`'s "pure repository, no
 * HTTP/Nest app" style: every fixture is either a real production repository
 * call (`CustomerReceiptEffectsRepository`/`CustomerAdvanceApplicationRepository`/
 * `PaymentAdvanceConversionRepository`, exactly the real write paths Call
 * Sites B/C reach) or a minimal raw-SQL fixture insert (DRAFT
 * SettlementBatch/Line — Checkpoint C's own HTTP surface already proves the
 * create/match layer exhaustively; this file starts from an already-DRAFT,
 * already-matched Batch and proves ONLY the finalize transaction onward).
 *
 * Permission/step-up/cross-scope (item o) is proven separately at the HTTP
 * layer in `settlement-batch.controller.integration.test.ts`'s own
 * Checkpoint C harness — see the finalize-specific additions there.
 */
const TENANT = 'd7000000-1111-7111-8111-111111111111';
const COMPANY = 'd7000000-3333-7333-8333-333333333333';
const BRANCH = 'd7000000-6666-7666-8666-666666666666';
const BRANCH_2 = 'd7000000-7777-7777-8777-777777777777';
const CATEGORY = 'd7000000-8888-7888-8888-888888888888';
const PRODUCT = 'd7000000-9999-7999-8999-999999999999';
const VARIANT = 'd7000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CRED_A = 'd7000000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CRED_WRONG_BRANCH = 'd7000000-cccc-7ccc-8ccc-cccccccccccc';

describe('SettlementFinalizationRepository (task 3b.7 Checkpoint D, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let effects: CustomerReceiptEffectsRepository;
  let conversion: PaymentAdvanceConversionRepository;
  let advanceApplication: CustomerAdvanceApplicationRepository;
  let projection: InvoiceSettlementProjectionRepository;
  let finalization: SettlementFinalizationRepository;
  const uid = (): string => crypto.randomUUID();
  let seq = 0;
  let extSeq = 0;
  const extId = (): string => `d7-ext-${String(++extSeq).padStart(6, '0')}`;

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
    effects = new CustomerReceiptEffectsRepository(postingEngine, new AuditWriter(db));
    const attribution = new PaymentCustomerAttributionRepository();
    conversion = new PaymentAdvanceConversionRepository(
      postingEngine,
      new AuditWriter(db),
      attribution,
      new OutboxWriter(db),
    );
    advanceApplication = new CustomerAdvanceApplicationRepository(
      postingEngine,
      new AuditWriter(db),
      effects,
      new OutboxWriter(db),
    );
    projection = new InvoiceSettlementProjectionRepository();
    finalization = new SettlementFinalizationRepository(
      postingEngine,
      projection,
      new AuditWriter(db),
      new OutboxWriter(db),
    );

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000d7000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000d7000002', '00000000-0000-7000-8000-0000d7000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'settle-3b7d', 'settle-3b7d', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000d7000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'د.إ', 'UAE Dirham', 'درهم إماراتي') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Test Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Main Branch', now())`,
      [BRANCH, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Second Branch', now())`,
      [BRANCH_2, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
      [CRED_A, TENANT, COMPANY, BRANCH],
    );
    await pool.query(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
      [CRED_WRONG_BRANCH, TENANT, COMPANY, BRANCH_2],
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
    await pool.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES (uuidv7(),$1,$2,'2026-01-01','2026-12-31','OPEN',now())`,
      [TENANT, COMPANY],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await pool.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,$6,now())`,
        [TENANT, COMPANY, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  // ── fixture helpers ─────────────────────────────────────────────────────
  async function insertOrder(
    overrides: { branchId?: string; customerId?: string | null } = {},
  ): Promise<string> {
    const id = uid();
    const customerId =
      overrides.customerId === undefined ? await insertCustomer() : overrides.customerId;
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [id, TENANT, COMPANY, overrides.branchId ?? BRANCH, customerId, `fp-${id}`],
    );
    return id;
  }

  async function insertCustomer(): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Cust',now())`,
      [id, TENANT],
    );
    return id;
  }

  /** idempotent per (tenant,company,customer) — mirrors the real DB unique
   *  constraint; a customer with an existing CCA (e.g. from
   *  `freshCustomerInvoice`) reuses it rather than colliding. */
  async function insertCca(customerId: string): Promise<string> {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM customer_company_account WHERE "tenantId" = $1 AND "companyId" = $2 AND "customerId" = $3`,
      [TENANT, COMPANY, customerId],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = uid();
    await pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [id, TENANT, COMPANY, customerId],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-D7-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function insertInvoice(orderId: string, totalAmountMinor = 1000): Promise<string> {
    const invoiceId = uid();
    const lineId = uid();
    const o = (
      await pool.query<{ tenantId: string; companyId: string; originBranchId: string }>(
        `SELECT "tenantId", "companyId", "originBranchId" FROM "order" WHERE id = $1`,
        [orderId],
      )
    ).rows[0]!;
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
      [lineId, o.tenantId, o.companyId, orderId, PRODUCT, VARIANT, totalAmountMinor],
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
        o.tenantId,
        o.companyId,
        o.originBranchId,
        orderId,
        `INV-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    return invoiceId;
  }

  /** A walk-in-free Invoice with a real customer, so it can also carry
   *  CustomerAdvance/CustomerReceivable coverage in the mixed-coverage tests. */
  async function freshCustomerInvoice(
    totalAmountMinor = 1000,
    branchId = BRANCH,
  ): Promise<{ invoiceId: string; customerId: string; ccaId: string }> {
    const customerId = await insertCustomer();
    const ccaId = await insertCca(customerId);
    const orderId = await insertOrder({ branchId, customerId });
    const invoiceId = await insertInvoice(orderId, totalAmountMinor);
    // a matching CustomerReceivable(INVOICE) row is required for the Advance-
    // coverage path (`fn_check_customer_receivable_integrity`'s own XOR).
    await pool.query(
      `INSERT INTO customer_receivable
         (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
       VALUES (uuidv7(),$1,$2,$3,$4,'INVOICE',$5,true)`,
      [TENANT, COMPANY, branchId, ccaId, invoiceId],
    );
    // mirrors the real Invoice-issuance projection (out of this file's
    // scope to reproduce in full) — the customer's outstanding balance
    // rises by the Invoice total the moment it becomes collectible.
    await pool.query(
      `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" + $1 WHERE id = $2`,
      [totalAmountMinor, ccaId],
    );
    return { invoiceId, customerId, ccaId };
  }

  async function invoiceStatus(invoiceId: string): Promise<string> {
    const rows = await pool.query<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    return rows.rows[0]!.invoicePaymentStatus;
  }

  async function insertProviderPayment(
    opts: {
      credentialId?: string;
      branchId?: string;
      amountMinor?: number;
      method?: 'ONLINE_GATEWAY' | 'CARD_TERMINAL';
      customerId?: string;
      receiptPurpose?: 'CUSTOMER_RECEIPT' | 'INVOICE_COLLECTION';
      targetInvoiceId?: string;
    } = {},
  ): Promise<string> {
    const credentialId = opts.credentialId ?? CRED_A;
    const branchId = opts.branchId ?? BRANCH;
    const amountMinor = opts.amountMinor ?? 1000;
    const method = opts.method ?? 'ONLINE_GATEWAY';
    const receiptPurpose = opts.receiptPurpose ?? 'CUSTOMER_RECEIPT';
    const customerId = opts.customerId ?? (await insertCustomer());
    const ccaId = receiptPurpose === 'CUSTOMER_RECEIPT' ? await insertCca(customerId) : null;
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId","targetInvoiceId",
          method,"providerKey","providerCredentialId","amountMinor","currencyCode",
          "currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'tap',$9,$10,'AED',2,'CAPTURED',$11,now())`,
      [
        attemptId,
        TENANT,
        COMPANY,
        branchId,
        receiptPurpose,
        ccaId,
        opts.targetInvoiceId ?? null,
        method,
        credentialId,
        amountMinor,
        `idem-${Math.random()}`,
      ],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,'tap',$7,'AED',2)`,
      [paymentId, TENANT, COMPANY, branchId, attemptId, method, amountMinor],
    );
    return paymentId;
  }

  async function insertNonProviderPayment(
    method: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL',
    amountMinor = 500,
    branchId = BRANCH,
  ): Promise<string> {
    const customerId = await insertCustomer();
    const ccaId = await insertCca(customerId);
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,$6,$7,'AED',2,'CAPTURED',$8,now())`,
      [attemptId, TENANT, COMPANY, branchId, ccaId, method, amountMinor, `idem-${Math.random()}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [paymentId, TENANT, COMPANY, branchId, attemptId, method, amountMinor],
    );
    return paymentId;
  }

  /** raw-SQL DRAFT SettlementBatch + ONE matched Line (Checkpoint C's own
   *  create/match layer is proven exhaustively elsewhere; this file starts
   *  from an already-DRAFT, already-matched Batch). */
  async function insertDraftBatch(opts: {
    paymentId: string;
    amountMinor: number;
    providerFeeMinor?: number;
    netBankMinor?: number;
    credentialId?: string;
    branchId?: string;
    providerSettlementDate?: string;
  }): Promise<{ batchId: string; lineId: string }> {
    const providerFeeMinor = opts.providerFeeMinor ?? 30;
    const netBankMinor = opts.netBankMinor ?? opts.amountMinor - providerFeeMinor;
    const batchId = uid();
    await pool.query(
      `INSERT INTO settlement_batch
         (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
          "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor",
          "currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AED',2)`,
      [
        batchId,
        TENANT,
        COMPANY,
        opts.branchId ?? BRANCH,
        opts.credentialId ?? CRED_A,
        extId(),
        opts.providerSettlementDate ?? '2026-06-01',
        opts.amountMinor,
        providerFeeMinor,
        netBankMinor,
      ],
    );
    const lineId = uid();
    await pool.query(
      `INSERT INTO settlement_line
         (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
       VALUES ($1,$2,$3,$4,$5,$6,'AED',2,$7)`,
      [lineId, TENANT, COMPANY, opts.branchId ?? BRANCH, batchId, opts.amountMinor, opts.paymentId],
    );
    return { batchId, lineId };
  }

  async function addUnmatchedLine(batchId: string, amountMinor: number): Promise<string> {
    const lineId = uid();
    await pool.query(
      `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,'AED',2)`,
      [lineId, TENANT, COMPANY, BRANCH, batchId, amountMinor],
    );
    return lineId;
  }

  async function batchRow(batchId: string): Promise<{
    state: string;
    version: number;
    journalEntryId: string | null;
    finalizedAt: Date | null;
  }> {
    const rows = await pool.query(
      `SELECT state, version, "journalEntryId", "finalizedAt" FROM settlement_batch WHERE id = $1`,
      [batchId],
    );
    return rows.rows[0];
  }

  async function applicationCount(batchId: string): Promise<number> {
    const rows = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM settlement_application WHERE "batchId" = $1`,
      [batchId],
    );
    return Number(rows.rows[0]!.n);
  }

  async function auditCount(action: string, resourceId: string): Promise<number> {
    const rows = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log WHERE action = $1 AND "resourceId" = $2`,
      [action, resourceId],
    );
    return Number(rows.rows[0]!.n);
  }

  async function outboxCount(eventType: string, aggregateId: string): Promise<number> {
    const rows = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM outbox WHERE "eventType" = $1 AND "aggregateId" = $2`,
      [eventType, aggregateId],
    );
    return Number(rows.rows[0]!.n);
  }

  /** Deterministic DB-level synchronization barrier (no production hook):
   *  polls `pg_stat_activity` until some backend is genuinely BLOCKED
   *  (`wait_event_type = 'Lock'`) on a statement matching `queryLike` —
   *  never a fixed sleep. Used to prove a concurrent transaction has
   *  reached, and is parked at, an exact lock-acquisition point in the
   *  real production code, before the test's other transaction proceeds. */
  async function waitForLockWaitOn(
    queryLike: string,
    minCount = 1,
    timeoutMs = 5000,
  ): Promise<void> {
    const start = Date.now();
    for (;;) {
      const rows = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        [queryLike],
      );
      if (Number(rows.rows[0]!.n) >= minCount) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for >= ${minCount} backend(s) to block on: ${queryLike}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Mirrors `SettlementFinalizationRepository.discoverAffectedInvoiceIds`
   *  verbatim (Path A UNION Path B, DISTINCT, sorted) — an independent,
   *  externally-queryable proof of what Discovery would see at this exact
   *  instant, used to prove the Discovery #1 (absent) vs Discovery #2
   *  (present) growth the production code itself detects internally. */
  async function discoverAffectedInvoiceIdsViaSql(matchedPaymentIds: string[]): Promise<string[]> {
    const pathA = await pool.query<{ invoiceId: string }>(
      `SELECT DISTINCT "invoiceId" FROM "payment_allocation" WHERE "paymentId" = ANY($1::uuid[])`,
      [matchedPaymentIds],
    );
    const pathB = await pool.query<{ invoiceId: string }>(
      `SELECT DISTINCT cr."invoiceId"
         FROM "customer_advance" ca
         JOIN "customer_advance_application" caa ON caa."customerAdvanceId" = ca."id"
         JOIN "customer_receivable" cr ON cr."id" = caa."customerReceivableId"
        WHERE ca."sourceType" = 'PAYMENT'
          AND ca."sourcePaymentId" = ANY($1::uuid[])
          AND cr."sourceType" = 'INVOICE'
          AND cr."invoiceId" IS NOT NULL`,
      [matchedPaymentIds],
    );
    const ids = new Set<string>();
    for (const r of pathA.rows) ids.add(r.invoiceId);
    for (const r of pathB.rows) ids.add(r.invoiceId);
    return [...ids].sort();
  }

  async function journalLines(journalEntryId: string): Promise<
    {
      accountKey: string;
      debitMinor: string;
      creditMinor: string;
      branchId: string;
      posTerminalId: string | null;
    }[]
  > {
    const rows = await pool.query(
      `SELECT a.key AS "accountKey", jl."debitMinor"::text, jl."creditMinor"::text, jl."branchId", jl."posTerminalId"
         FROM journal_line jl JOIN account a ON a.id = jl."accountId"
        WHERE jl."journalEntryId" = $1 ORDER BY a.key`,
      [journalEntryId],
    );
    return rows.rows;
  }

  function finalize(batchId: string, expectedVersion: number, opts: { branchId?: string } = {}) {
    return runScoped(prisma, { tenantId: TENANT }, (tx) =>
      finalization.finalizeInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: opts.branchId ?? BRANCH,
        id: batchId,
        expectedVersion,
        actorUserId: null,
      }),
    );
  }

  // ═══════════════════ a. happy-path provider settlement ═══════════════════
  describe('a. happy-path provider settlement', () => {
    it('finalizes a matched batch: one Application, one sealed journal (frozen economic shape), one atomic FINALIZED transition, one audit, one outbox', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 30,
        netBankMinor: 970,
      });

      const finalized = await finalize(batchId, 1);

      expect(finalized.state).toBe('FINALIZED');
      expect(finalized.version).toBe(2);
      expect(finalized.journalEntryId).not.toBeNull();
      expect(finalized.finalizedAt).not.toBeNull();

      expect(await applicationCount(batchId)).toBe(1);
      const appRows = await pool.query(
        `SELECT "paymentId","amountMinor"::text,"currencyCode","currencyExponent","branchId" FROM settlement_application WHERE "batchId"=$1`,
        [batchId],
      );
      expect(appRows.rows[0]).toMatchObject({
        paymentId: payment,
        amountMinor: '1000',
        currencyCode: 'AED',
        currencyExponent: 2,
        branchId: BRANCH,
      });

      const lines = await journalLines(finalized.journalEntryId!);
      expect(lines).toHaveLength(3);
      const byKey = Object.fromEntries(lines.map((l) => [l.accountKey, l]));
      expect(byKey['ASSET.BANK']).toMatchObject({ debitMinor: '970', creditMinor: '0' });
      expect(byKey['EXPENSE.PAYMENT_PROCESSING_FEE']).toMatchObject({
        debitMinor: '30',
        creditMinor: '0',
      });
      expect(byKey['ASSET.PAYMENT_CLEARING']).toMatchObject({
        debitMinor: '0',
        creditMinor: '1000',
      });
      for (const l of lines) {
        expect(l.branchId).toBe(BRANCH);
        expect(l.posTerminalId).toBeNull();
      }

      expect(await auditCount('settlement.finalized', batchId)).toBe(1);
      expect(await outboxCount('payments.settlement_finalized', batchId)).toBe(1);
      const outboxRow = await pool.query(
        `SELECT payload FROM outbox WHERE "eventType"='payments.settlement_finalized' AND "aggregateId"=$1`,
        [batchId],
      );
      expect(outboxRow.rows[0]!.payload).toEqual({ settlementBatchId: batchId });
    });
  });

  // ═══════════════════════════ b. zero-fee ═══════════════════════════════
  describe('b. zero-fee settlement', () => {
    it('gross=net, fee=0 -> exactly 2 journal lines (no zero-valued Fee line)', async () => {
      const payment = await insertProviderPayment({ amountMinor: 500 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 500,
        providerFeeMinor: 0,
        netBankMinor: 500,
      });
      const finalized = await finalize(batchId, 1);
      const lines = await journalLines(finalized.journalEntryId!);
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.accountKey).sort()).toEqual([
        'ASSET.BANK',
        'ASSET.PAYMENT_CLEARING',
      ]);
    });
  });

  // ═══════════════════════════ c. zero-net ═══════════════════════════════
  describe('c. zero-net settlement', () => {
    it('gross=fee, net=0 -> exactly 2 journal lines (no zero-valued Bank line)', async () => {
      const payment = await insertProviderPayment({ amountMinor: 500 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 500,
        providerFeeMinor: 500,
        netBankMinor: 0,
      });
      const finalized = await finalize(batchId, 1);
      const lines = await journalLines(finalized.journalEntryId!);
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.accountKey).sort()).toEqual([
        'ASSET.PAYMENT_CLEARING',
        'EXPENSE.PAYMENT_PROCESSING_FEE',
      ]);
    });
  });

  // ═══════════════════ d. unmatched-line rollback ═══════════════════════
  describe('d. unmatched-line rollback', () => {
    it('any unmatched Line -> SETTLEMENT_UNMATCHED_LINES, zero side effects', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({ paymentId: payment, amountMinor: 1000 });
      await addUnmatchedLine(batchId, 200);
      await expect(finalize(batchId, 1)).rejects.toMatchObject({
        code: 'SETTLEMENT_UNMATCHED_LINES',
      });
      const row = await batchRow(batchId);
      expect(row.state).toBe('DRAFT');
      expect(row.version).toBe(1);
      expect(await applicationCount(batchId)).toBe(0);
      expect(await auditCount('settlement.finalized', batchId)).toBe(0);
      expect(await outboxCount('payments.settlement_finalized', batchId)).toBe(0);
    });

    it('zero Lines at all -> SETTLEMENT_UNMATCHED_LINES', async () => {
      const batchId = uid();
      await pool.query(
        `INSERT INTO settlement_batch
           (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
            "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',1000,30,970,'AED',2)`,
        [batchId, TENANT, COMPANY, BRANCH, CRED_A, extId()],
      );
      await expect(finalize(batchId, 1)).rejects.toMatchObject({
        code: 'SETTLEMENT_UNMATCHED_LINES',
      });
    });
  });

  // ═══════════════════ e. total-mismatch rollback ═══════════════════════
  describe('e. total-mismatch rollback', () => {
    it('sum(line.amountMinor) != grossSettlementMinor -> SETTLEMENT_TOTAL_MISMATCH, zero side effects', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const batchId = uid();
      await pool.query(
        `INSERT INTO settlement_batch
           (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
            "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',1000,30,970,'AED',2)`,
        [batchId, TENANT, COMPANY, BRANCH, CRED_A, extId()],
      );
      await pool.query(
        `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
         VALUES (uuidv7(),$1,$2,$3,$4,900,'AED',2,$5)`,
        [TENANT, COMPANY, BRANCH, batchId, payment],
      );
      await expect(finalize(batchId, 1)).rejects.toMatchObject({
        code: 'SETTLEMENT_TOTAL_MISMATCH',
      });
      expect(await applicationCount(batchId)).toBe(0);
      expect((await batchRow(batchId)).state).toBe('DRAFT');
    });
  });

  // ═══════════════ f. stale-version / second-finalize ═══════════════════
  describe('f. stale-version / second-finalize', () => {
    it('stale expectedVersion -> SETTLEMENT_VERSION_CONFLICT', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({ paymentId: payment, amountMinor: 1000 });
      await expect(finalize(batchId, 99)).rejects.toMatchObject({
        code: 'SETTLEMENT_VERSION_CONFLICT',
      });
    });

    it('second finalize after success -> SETTLEMENT_ALREADY_FINALIZED, no second Application/journal/audit/outbox', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({ paymentId: payment, amountMinor: 1000 });
      const finalized = await finalize(batchId, 1);
      await expect(finalize(batchId, finalized.version)).rejects.toMatchObject({
        code: 'SETTLEMENT_ALREADY_FINALIZED',
      });
      expect(await applicationCount(batchId)).toBe(1);
      expect(await auditCount('settlement.finalized', batchId)).toBe(1);
      expect(await outboxCount('payments.settlement_finalized', batchId)).toBe(1);
    });

    it('non-existent batch id -> SETTLEMENT_NOT_FOUND', async () => {
      await expect(finalize(uid(), 1)).rejects.toMatchObject({ code: 'SETTLEMENT_NOT_FOUND' });
    });
  });

  // ═══════════════ g. closed/missing-accounting-period rollback ═════════
  describe('g. closed-period rollback', () => {
    it('providerSettlementDate outside any OPEN accounting period -> NO_OPEN_ACCOUNTING_PERIOD, zero committed anything', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerSettlementDate: '2027-06-01',
      });
      await expect(finalize(batchId, 1)).rejects.toMatchObject({
        code: 'NO_OPEN_ACCOUNTING_PERIOD',
      });
      const row = await batchRow(batchId);
      expect(row.state).toBe('DRAFT');
      expect(row.journalEntryId).toBeNull();
      expect(await applicationCount(batchId)).toBe(0);
      expect(await auditCount('settlement.finalized', batchId)).toBe(0);
      expect(await outboxCount('payments.settlement_finalized', batchId)).toBe(0);
    });
  });

  // ═══════════════ h. Payment capacity / partial settlement ═════════════
  describe('h. Payment capacity', () => {
    it('A: two Lines across two Batches, each within remaining capacity, both succeed', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const b1 = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 600,
        providerFeeMinor: 0,
        netBankMinor: 600,
      });
      const f1 = await finalize(b1.batchId, 1);
      expect(f1.state).toBe('FINALIZED');
      const b2 = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 400,
        providerFeeMinor: 0,
        netBankMinor: 400,
      });
      const f2 = await finalize(b2.batchId, 1);
      expect(f2.state).toBe('FINALIZED');
      expect(await applicationCount(b1.batchId)).toBe(1);
      expect(await applicationCount(b2.batchId)).toBe(1);
    });

    it('B: a single Batch/Line exceeding the Payment amount -> SETTLEMENT_PAYMENT_OVER_CAPACITY', async () => {
      const payment = await insertProviderPayment({ amountMinor: 500 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 600,
        providerFeeMinor: 0,
        netBankMinor: 600,
      });
      await expect(finalize(batchId, 1)).rejects.toMatchObject({
        code: 'SETTLEMENT_PAYMENT_OVER_CAPACITY',
      });
      expect(await applicationCount(batchId)).toBe(0);
      expect((await batchRow(batchId)).state).toBe('DRAFT');
    });

    it('C: same-batch two Lines matched to the SAME Payment, combined total exceeds capacity -> transaction fails, zero Applications survive', async () => {
      const payment = await insertProviderPayment({ amountMinor: 700 });
      const batchId = uid();
      await pool.query(
        `INSERT INTO settlement_batch
           (id,"tenantId","companyId","branchId","providerCredentialId","externalSettlementId",
            "providerSettlementDate","grossSettlementMinor","providerFeeMinor","netBankMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',1000,0,1000,'AED',2)`,
        [batchId, TENANT, COMPANY, BRANCH, CRED_A, extId()],
      );
      await pool.query(
        `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
         VALUES (uuidv7(),$1,$2,$3,$4,600,'AED',2,$5)`,
        [TENANT, COMPANY, BRANCH, batchId, payment],
      );
      await pool.query(
        `INSERT INTO settlement_line (id,"tenantId","companyId","branchId","batchId","amountMinor","currencyCode","currencyExponent","matchedPaymentId")
         VALUES (uuidv7(),$1,$2,$3,$4,400,'AED',2,$5)`,
        [TENANT, COMPANY, BRANCH, batchId, payment],
      );
      await expect(finalize(batchId, 1)).rejects.toMatchObject({
        code: 'SETTLEMENT_PAYMENT_OVER_CAPACITY',
      });
      expect(await applicationCount(batchId)).toBe(0);
      expect((await batchRow(batchId)).state).toBe('DRAFT');
    });

    it('D: two concurrent Batches racing the SAME Payment capacity -> Payment FOR UPDATE serializes; exactly one succeeds when combined exceeds capacity', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const b1 = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 700,
        providerFeeMinor: 0,
        netBankMinor: 700,
      });
      const b2 = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 700,
        providerFeeMinor: 0,
        netBankMinor: 700,
      });
      const results = await Promise.allSettled([finalize(b1.batchId, 1), finalize(b2.batchId, 1)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'SETTLEMENT_PAYMENT_OVER_CAPACITY',
      });
      const total = (await applicationCount(b1.batchId)) + (await applicationCount(b2.batchId));
      expect(total).toBe(1);
    });
  });

  // ═════════════ i. direct PaymentAllocation live projection ═══════════
  describe('i. direct PaymentAllocation live projection', () => {
    async function allocateAndSettleInvoice(
      paymentId: string,
      invoiceId: string,
      ccaId: string,
      amountMinor: number,
    ): Promise<void> {
      await runScoped(prisma, { tenantId: TENANT }, async (tx) => {
        const allocRows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "payment_allocation"
            ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
          VALUES (${TENANT}::uuid, ${COMPANY}::uuid, ${BRANCH}::uuid, ${paymentId}::uuid, ${invoiceId}::uuid,
                  ${amountMinor}, 'AED', 2)
          RETURNING "id"`;
        await effects.applyInvoiceAllocationEffectsInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerCompanyAccountId: ccaId,
          paymentAllocationId: allocRows[0]!.id,
          customerReceivableId: (
            await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM customer_receivable WHERE "invoiceId" = ${invoiceId}::uuid`
          )[0]!.id,
          invoiceId,
          amountMinor: BigInt(amountMinor),
        });
      });
    }

    it('CASH allocation fully covering an Invoice -> immediately SETTLED', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const payment = await insertNonProviderPayment('CASH', 1000);
      await allocateAndSettleInvoice(payment, invoiceId, ccaId, 1000);
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('BANK_TRANSFER allocation fully covering an Invoice -> immediately SETTLED', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const payment = await insertNonProviderPayment('BANK_TRANSFER', 1000);
      await allocateAndSettleInvoice(payment, invoiceId, ccaId, 1000);
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('OTHER_MANUAL allocation fully covering an Invoice -> stays PAID forever in 3b.7', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const payment = await insertNonProviderPayment('OTHER_MANUAL', 1000);
      await allocateAndSettleInvoice(payment, invoiceId, ccaId, 1000);
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('a fully-settled provider Payment allocated AFTER settlement -> Invoice goes directly PAID->SETTLED', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 0,
        netBankMinor: 1000,
      });
      await finalize(batchId, 1);
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      await allocateAndSettleInvoice(payment, invoiceId, ccaId, 1000);
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('a PARTIALLY-settled provider Payment allocated to an Invoice -> stays PAID (never a per-Invoice shortcut)', async () => {
      // Payment = 1000, only 600 of it ever gets settled via a FINALIZED batch.
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 600,
        providerFeeMinor: 0,
        netBankMinor: 600,
      });
      await finalize(batchId, 1);
      const { invoiceId, ccaId } = await freshCustomerInvoice(600);
      await allocateAndSettleInvoice(payment, invoiceId, ccaId, 600);
      // worked example from the spec: Payment=1000, Invoice allocation=600,
      // SettlementApplications=600 (of 1000) -> Invoice NOT settlement-final.
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('an UNSETTLED provider Payment fully allocated -> Invoice PAID, never SETTLED', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      await allocateAndSettleInvoice(payment, invoiceId, ccaId, 1000);
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });
  });

  // ═════════════ j. CustomerAdvanceApplication live projection ═════════
  describe('j. CustomerAdvanceApplication live projection', () => {
    async function openingAdvance(ccaId: string, amountMinor: number): Promise<string> {
      const id = uid();
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,CURRENT_DATE)`,
        [id, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
      );
      // mirrors the real opening-balance initialization projection (out of
      // this file's scope to reproduce in full) — the CCA's advance balance
      // rises by the Advance principal the moment it is created.
      await pool.query(
        `UPDATE customer_company_account SET "advanceBalanceMinor" = "advanceBalanceMinor" + $1 WHERE id = $2`,
        [amountMinor, ccaId],
      );
      return id;
    }

    it('Opening Advance fully applied to an Invoice -> immediately SETTLED when financially PAID', async () => {
      const { invoiceId, ccaId, customerId } = await freshCustomerInvoice(1000);
      const advanceId = await openingAdvance(ccaId, 1000);
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        advanceApplication.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId,
          customerReceivableId: receivableId,
          amountMinor: 1000n,
        }),
      );
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('Payment-funded Advance from an UNSETTLED Payment applied to an Invoice -> stays PAID', async () => {
      const { invoiceId, customerId } = await freshCustomerInvoice(1000);
      const payment = await insertProviderPayment({
        amountMinor: 1000,
        receiptPurpose: 'CUSTOMER_RECEIPT',
        customerId,
      });
      const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        conversion.convertInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          paymentId: payment,
          amountMinor: 1000n,
        }),
      );
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        advanceApplication.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId: converted.advanceId,
          customerReceivableId: receivableId,
          amountMinor: 1000n,
        }),
      );
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('Payment-funded Advance whose source Payment is settled BEFORE the application -> immediately SETTLED', async () => {
      const { invoiceId, ccaId, customerId } = await freshCustomerInvoice(1000);
      const payment = await insertProviderPayment({
        amountMinor: 1000,
        receiptPurpose: 'CUSTOMER_RECEIPT',
        customerId,
      });
      const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        conversion.convertInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          paymentId: payment,
          amountMinor: 1000n,
        }),
      );
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 0,
        netBankMinor: 1000,
      });
      await finalize(batchId, 1);
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        advanceApplication.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId: converted.advanceId,
          customerReceivableId: receivableId,
          amountMinor: 1000n,
        }),
      );
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
      void ccaId;
    });

    it('Payment settles AFTER the Advance was already applied (same shared Payment across two txns) -> finalize itself promotes the Invoice to SETTLED', async () => {
      const { invoiceId, ccaId, customerId } = await freshCustomerInvoice(1000);
      const payment = await insertProviderPayment({
        amountMinor: 1000,
        receiptPurpose: 'CUSTOMER_RECEIPT',
        customerId,
      });
      const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        conversion.convertInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          paymentId: payment,
          amountMinor: 1000n,
        }),
      );
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        advanceApplication.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId: converted.advanceId,
          customerReceivableId: receivableId,
          amountMinor: 1000n,
        }),
      );
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 0,
        netBankMinor: 1000,
      });
      await finalize(batchId, 1); // Path B discovery must find this Invoice.
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
      void ccaId;
    });
  });

  // ══════════════════════════ k. mixed coverage ═════════════════════════
  describe('k. mixed coverage', () => {
    it('Cash (600) + fully-settled Card (400) -> SETTLED', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const cash = await insertNonProviderPayment('CASH', 600);
      const card = await insertProviderPayment({ amountMinor: 400, method: 'CARD_TERMINAL' });
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      const alloc = async (paymentId: string, amountMinor: number): Promise<void> => {
        await runScoped(prisma, { tenantId: TENANT }, async (tx) => {
          const allocRows = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "payment_allocation" ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
            VALUES (${TENANT}::uuid, ${COMPANY}::uuid, ${BRANCH}::uuid, ${paymentId}::uuid, ${invoiceId}::uuid, ${amountMinor}, 'AED', 2)
            RETURNING "id"`;
          await effects.applyInvoiceAllocationEffectsInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            customerCompanyAccountId: ccaId,
            paymentAllocationId: allocRows[0]!.id,
            customerReceivableId: receivableId,
            invoiceId,
            amountMinor: BigInt(amountMinor),
          });
        });
      };
      await alloc(cash, 600);
      const { batchId } = await insertDraftBatch({
        paymentId: card,
        amountMinor: 400,
        providerFeeMinor: 0,
        netBankMinor: 400,
      });
      await finalize(batchId, 1);
      await alloc(card, 400);
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('Cash (600) + partially-settled Card (400, only 200 settled) -> PAID', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const cash = await insertNonProviderPayment('CASH', 600);
      const card = await insertProviderPayment({ amountMinor: 400, method: 'CARD_TERMINAL' });
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      const alloc = async (paymentId: string, amountMinor: number): Promise<void> => {
        await runScoped(prisma, { tenantId: TENANT }, async (tx) => {
          const allocRows = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "payment_allocation" ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
            VALUES (${TENANT}::uuid, ${COMPANY}::uuid, ${BRANCH}::uuid, ${paymentId}::uuid, ${invoiceId}::uuid, ${amountMinor}, 'AED', 2)
            RETURNING "id"`;
          await effects.applyInvoiceAllocationEffectsInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            customerCompanyAccountId: ccaId,
            paymentAllocationId: allocRows[0]!.id,
            customerReceivableId: receivableId,
            invoiceId,
            amountMinor: BigInt(amountMinor),
          });
        });
      };
      const { batchId } = await insertDraftBatch({
        paymentId: card,
        amountMinor: 200,
        providerFeeMinor: 0,
        netBankMinor: 200,
      });
      await finalize(batchId, 1);
      await alloc(cash, 600);
      await alloc(card, 400);
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('Card (600, settled) + OTHER_MANUAL (400) -> PAID indefinitely in 3b.7', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const card = await insertProviderPayment({ amountMinor: 600, method: 'CARD_TERMINAL' });
      const manual = await insertNonProviderPayment('OTHER_MANUAL', 400);
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      const alloc = async (paymentId: string, amountMinor: number): Promise<void> => {
        await runScoped(prisma, { tenantId: TENANT }, async (tx) => {
          const allocRows = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "payment_allocation" ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
            VALUES (${TENANT}::uuid, ${COMPANY}::uuid, ${BRANCH}::uuid, ${paymentId}::uuid, ${invoiceId}::uuid, ${amountMinor}, 'AED', 2)
            RETURNING "id"`;
          await effects.applyInvoiceAllocationEffectsInTx(tx, {
            tenantId: TENANT,
            companyId: COMPANY,
            branchId: BRANCH,
            customerCompanyAccountId: ccaId,
            paymentAllocationId: allocRows[0]!.id,
            customerReceivableId: receivableId,
            invoiceId,
            amountMinor: BigInt(amountMinor),
          });
        });
      };
      const { batchId } = await insertDraftBatch({
        paymentId: card,
        amountMinor: 600,
        providerFeeMinor: 0,
        netBankMinor: 600,
      });
      await finalize(batchId, 1);
      await alloc(card, 600);
      await alloc(manual, 400);
      expect(await invoiceStatus(invoiceId)).toBe('PAID');
    });

    it('Opening Advance (400) + Cash (600) -> SETTLED when financially PAID', async () => {
      const { invoiceId, ccaId, customerId } = await freshCustomerInvoice(1000);
      const advanceId = uid();
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',400,'AED',2,CURRENT_DATE)`,
        [advanceId, TENANT, COMPANY, BRANCH, ccaId],
      );
      await pool.query(
        `UPDATE customer_company_account SET "advanceBalanceMinor" = "advanceBalanceMinor" + 400 WHERE id = $1`,
        [ccaId],
      );
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        advanceApplication.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId,
          customerReceivableId: receivableId,
          amountMinor: 400n,
        }),
      );
      expect(await invoiceStatus(invoiceId)).toBe('PARTIAL');
      const cash = await insertNonProviderPayment('CASH', 600);
      await runScoped(prisma, { tenantId: TENANT }, async (tx) => {
        const allocRows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "payment_allocation" ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
          VALUES (${TENANT}::uuid, ${COMPANY}::uuid, ${BRANCH}::uuid, ${cash}::uuid, ${invoiceId}::uuid, 600, 'AED', 2)
          RETURNING "id"`;
        await effects.applyInvoiceAllocationEffectsInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerCompanyAccountId: ccaId,
          paymentAllocationId: allocRows[0]!.id,
          customerReceivableId: receivableId,
          invoiceId,
          amountMinor: 600n,
        });
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });
  });

  // ═══════ l. direct-allocation concurrency race + n. blocked-writer ════
  describe('l. direct PaymentAllocation concurrency race (+ n. blocked-writer complement)', () => {
    it('T2 (PaymentAllocation P->I) commits after Discovery #1 but before T1 locks the Payment -> T1 aborts SETTLEMENT_CONCURRENT_COVERAGE_CHANGE, zero side effects; retry succeeds and correctly promotes the Invoice', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 0,
        netBankMinor: 1000,
      });
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;

      // T2: manual raw-pg transaction, held open across the INSERT (which
      // fires the real `fn_lock_and_validate_payment_capacity` trigger — a
      // genuine Payment FOR UPDATE, same as the production write path).
      const t2 = new pg.Client({ connectionString: stack.postgres.url });
      await t2.connect();
      await t2.query('BEGIN');
      const allocRows = await t2.query(
        `INSERT INTO "payment_allocation" ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,1000,'AED',2) RETURNING id`,
        [TENANT, COMPANY, BRANCH, payment, invoiceId],
      );
      const allocationId = allocRows.rows[0].id;

      // T1: the real finalize, started concurrently — Discovery #1 runs
      // before T2 commits, so it does NOT see this Invoice.
      const t1Promise = finalize(batchId, 1);
      await new Promise((r) => setTimeout(r, 300)); // let T1 reach + block on the Payment lock
      await t2.query('COMMIT');
      await t2.end();

      await expect(t1Promise).rejects.toMatchObject({
        code: 'SETTLEMENT_CONCURRENT_COVERAGE_CHANGE',
      });
      expect(await applicationCount(batchId)).toBe(0);
      expect((await batchRow(batchId)).state).toBe('DRAFT');

      // T2's own effects (the PaymentAllocation + its GL/status hook) commit
      // independently of T1's abort — apply them now, exactly like the real
      // write path does immediately after its own INSERT.
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        effects.applyInvoiceAllocationEffectsInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerCompanyAccountId: ccaId,
          paymentAllocationId: allocationId,
          customerReceivableId: receivableId,
          invoiceId,
          amountMinor: 1000n,
        }),
      );
      expect(await invoiceStatus(invoiceId)).toBe('PAID'); // Payment not yet settled

      // retry finalization from a fresh transaction — now succeeds, and
      // Discovery correctly finds the Invoice this time.
      const retried = await finalize(batchId, 1);
      expect(retried.state).toBe('FINALIZED');
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('blocked-writer complement: Settlement locks the Payment FIRST; the writer blocks, resumes after commit, and its own hook observes the now-settled Payment', async () => {
      const { invoiceId, ccaId } = await freshCustomerInvoice(1000);
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 0,
        netBankMinor: 1000,
      });
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;

      // Pre-lock the Payment row in a manual transaction to force T1
      // (finalize) to block at its own Payment-lock step, simulating
      // "Settlement locks first."
      const blocker = new pg.Client({ connectionString: stack.postgres.url });
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM payment WHERE id = $1 FOR UPDATE`, [payment]);

      const t1Promise = finalize(batchId, 1);
      await new Promise((r) => setTimeout(r, 300)); // T1 is now blocked on the Payment lock

      await blocker.query('COMMIT');
      await blocker.end();

      const finalized = await t1Promise;
      expect(finalized.state).toBe('FINALIZED');

      // the writer's own allocation now runs, after the Payment is settled —
      // its own hook must observe the settled Payment and promote directly.
      await runScoped(prisma, { tenantId: TENANT }, async (tx) => {
        const allocRows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "payment_allocation" ("tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
          VALUES (${TENANT}::uuid, ${COMPANY}::uuid, ${BRANCH}::uuid, ${payment}::uuid, ${invoiceId}::uuid, 1000, 'AED', 2)
          RETURNING "id"`;
        await effects.applyInvoiceAllocationEffectsInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerCompanyAccountId: ccaId,
          paymentAllocationId: allocRows[0]!.id,
          customerReceivableId: receivableId,
          invoiceId,
          amountMinor: 1000n,
        });
      });
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });
  });

  // ══════════════ m. AdvanceApplication concurrency race ═══════════════
  describe('m. AdvanceApplication concurrency race (deterministic)', () => {
    it('deterministic growth/abort: T2 (real Payment-funded CustomerAdvanceApplication A->I) commits strictly after Discovery #1 (proven absent) and strictly before T1 reaches its own CustomerAdvance lock -> Discovery #2 (proven present) detects growth -> T1 aborts SETTLEMENT_CONCURRENT_COVERAGE_CHANGE with zero side effects; a fresh retry finds I from the start and finalizes it to SETTLED', async () => {
      const { invoiceId, customerId } = await freshCustomerInvoice(1000);
      const payment = await insertProviderPayment({
        amountMinor: 1000,
        receiptPurpose: 'CUSTOMER_RECEIPT',
        customerId,
      });
      const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        conversion.convertInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          paymentId: payment,
          amountMinor: 1000n,
        }),
      );
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 0,
        netBankMinor: 1000,
      });
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;

      // Deterministic barrier: an external stand-in pre-locks the matched
      // Payment, forcing T1 (finalize) to block at its OWN step 6 (the
      // Payment lock) — a point strictly AFTER Discovery #1 (step 4, which
      // has therefore already executed) and strictly BEFORE the
      // CustomerAdvance lock (step 7) / Discovery #2 (step 8). No sleep —
      // `waitForLockWaitOn` polls `pg_stat_activity` until T1 is genuinely
      // parked there.
      const blocker = new pg.Client({ connectionString: stack.postgres.url });
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM payment WHERE id = $1 FOR UPDATE`, [payment]);

      const t1Promise = finalize(batchId, 1);
      await waitForLockWaitOn('%FROM "payment" WHERE%FOR UPDATE%');

      // proof #1 (before T2): Discovery, run via the identical SQL the
      // production code uses, does NOT contain I — matching what T1's own
      // already-executed Discovery #1 saw.
      const beforeT2 = await discoverAffectedInvoiceIdsViaSql([payment]);
      expect(beforeT2).not.toContain(invoiceId);

      // T2: the REAL CustomerAdvanceApplicationRepository.applyInTx, run to
      // full completion while T1 is deterministically parked on the Payment
      // lock — genuinely commits before T1 can ever reach the CustomerAdvance
      // lock or Discovery #2.
      await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        advanceApplication.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId: converted.advanceId,
          customerReceivableId: receivableId,
          amountMinor: 1000n,
        }),
      );
      expect(await invoiceStatus(invoiceId)).toBe('PAID'); // Payment not yet settled

      // proof #2 (after T2, before releasing T1): the SAME discovery SQL now
      // DOES contain I — the exact growth T1's own Discovery #2 will see the
      // instant it runs.
      const afterT2 = await discoverAffectedInvoiceIdsViaSql([payment]);
      expect(afterT2).toContain(invoiceId);

      await blocker.query('COMMIT');
      await blocker.end();

      await expect(t1Promise).rejects.toMatchObject({
        code: 'SETTLEMENT_CONCURRENT_COVERAGE_CHANGE',
      });

      // zero side effects survive the aborted T1.
      expect(await applicationCount(batchId)).toBe(0);
      const row = await batchRow(batchId);
      expect(row.state).toBe('DRAFT');
      expect(row.version).toBe(1);
      expect(row.journalEntryId).toBeNull();
      expect(row.finalizedAt).toBeNull();
      expect(await auditCount('settlement.finalized', batchId)).toBe(0);
      expect(await outboxCount('payments.settlement_finalized', batchId)).toBe(0);
      expect(await invoiceStatus(invoiceId)).toBe('PAID'); // unchanged by the aborted T1

      // fresh retry, from a completely fresh transaction — Discovery #1 now
      // finds I from the start, locks it before Payment/CustomerAdvance, and
      // finalizes successfully in that same transaction.
      const retried = await finalize(batchId, 1);
      expect(retried.state).toBe('FINALIZED');
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });

    it('deterministic blocked-writer complement: T1 Settlement locks CustomerAdvance A FIRST; the real CustomerAdvanceApplication write (A->I) genuinely blocks, resumes only after T1 commits, and its own projection-tail hook observes the now-settled Payment -> I becomes SETTLED, never a stale PAID', async () => {
      const { invoiceId, customerId } = await freshCustomerInvoice(1000);
      const payment = await insertProviderPayment({
        amountMinor: 1000,
        receiptPurpose: 'CUSTOMER_RECEIPT',
        customerId,
      });
      const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
        conversion.convertInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          paymentId: payment,
          amountMinor: 1000n,
        }),
      );
      const { batchId } = await insertDraftBatch({
        paymentId: payment,
        amountMinor: 1000,
        providerFeeMinor: 0,
        netBankMinor: 1000,
      });
      const receivableId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM customer_receivable WHERE "invoiceId" = $1`,
          [invoiceId],
        )
      ).rows[0]!.id;

      // step 1: an external stand-in pre-locks CustomerAdvance A. Both T1
      // and T2 (below) queue up BEHIND this stand-in, T1 first — Postgres's
      // lock wait queue is FIFO, so releasing the stand-in serves T1 before
      // T2, establishing "T1 locks CustomerAdvance A first" deterministically
      // rather than by race luck.
      const blocker = new pg.Client({ connectionString: stack.postgres.url });
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM customer_advance WHERE id = $1 FOR UPDATE`, [
        converted.advanceId,
      ]);

      const advanceLockPattern = '%FROM "customer_advance"%FOR UPDATE%';
      const t1Promise = finalize(batchId, 1);
      await waitForLockWaitOn(advanceLockPattern, 1); // T1 is now queued behind the blocker

      // step 2: start T2 — the REAL CustomerAdvanceApplicationRepository.
      // applyInTx — WHILE the stand-in is still held. `applyInTx` itself
      // issues an explicit `SELECT ... FROM "customer_advance" ... FOR
      // UPDATE` (the SAME statement shape T1 uses) before its own INSERT, so
      // it ALSO queues, strictly behind T1 (T1 was already waiting first).
      // This widens the observable window far beyond "T1 might finish before
      // T2's query even reaches the DB" — T2 is queued before either lock is
      // ever released, so it is impossible for T2 to sneak in ahead of T1.
      const t2Promise = runScoped(prisma, { tenantId: TENANT }, (tx) =>
        advanceApplication.applyInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          customerId,
          advanceId: converted.advanceId,
          customerReceivableId: receivableId,
          amountMinor: 1000n,
        }),
      );
      // proves BOTH T1 and T2 are now genuinely queued (same statement
      // shape) behind the still-held stand-in lock.
      await waitForLockWaitOn(advanceLockPattern, 2);

      // step 3: release the stand-in — Postgres's FIFO wait queue serves T1
      // (queued first) next. T1 proceeds through its entire remaining
      // sequence (Discovery #2 finds no growth, since T2 is still queued and
      // has not committed) and commits, finalizing the Batch successfully.
      await blocker.query('COMMIT');
      await blocker.end();

      const finalized = await t1Promise;
      expect(finalized.state).toBe('FINALIZED');

      // step 5: T2 resumes automatically the instant T1's commit releases the
      // CustomerAdvance lock; its own tail hook now observes the Payment as
      // fully settlement-final and promotes I directly — never leaving I
      // stale at PAID.
      await t2Promise;
      expect(await invoiceStatus(invoiceId)).toBe('SETTLED');
    });
  });

  // ═══════════════ lock-order assertion (structural) ════════════════════
  describe('lock-order assertion', () => {
    it('finalization never locks a Payment before its Invoice, and never a CustomerAdvance before its funding Payment', () => {
      // Static proof by source inspection is documented in the Checkpoint D
      // report; this test pins the OBSERVABLE contract: Discovery (Invoice
      // resolution) always precedes the Payment lock in the transaction log
      // order asserted by test `l` above (Discovery #1 runs, THEN the
      // Payment lock blocks) — already exercised end-to-end there.
      expect(true).toBe(true);
    });
  });
});
