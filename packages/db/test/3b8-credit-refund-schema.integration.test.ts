import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.8 Checkpoint B — the Cancellation / Refund / Credit Note core
 * schema, proven against real Postgres via raw SQL: `credit_note` /
 * `credit_note_line` / `credit_note_coverage_release` / `cancellation_charge`
 * / `refund` / `refund_attempt` / `refund_attempt_entitlement_reservation` /
 * `customer_advance_refund_application` / `provider_refund_event`, the
 * deferred completeness triggers, the 7-component CreditNoteLine capacity
 * trigger, the frozen CreditNoteCoverageRelease<->CustomerAdvance 1:1, the
 * conversion-safe Payment/Advance refund-capacity functions, the
 * RefundAttempt->Refund state machine, RLS, and the widened
 * CustomerReceivable/CustomerAdvance/CustomerAccountEntry vocabularies
 * (migration `20261005120000_phase_3b8_credit_refund_core`).
 *
 * Checkpoint B ships schema/RLS/FK/CHECK/trigger structure ONLY — no
 * service/repository/controller/GL-posting/projection code. Every row is
 * inserted by raw SQL, exactly like `receivables-schema.integration.test.ts`
 * / `settlement-schema.integration.test.ts` before it.
 */
const TENANT = 'aaaaaaaa-8111-7111-8111-111111111111';
const OTHER_TENANT = 'bbbbbbbb-8222-7222-8222-222222222222';
const COMPANY = 'cccccccc-8333-7333-8333-333333333333';
const BRANCH = 'ffffffff-8666-7666-8666-666666666666';
const CATEGORY = '22222222-8888-7888-8888-888888888888';
const PRODUCT = '33333333-8999-7999-8999-999999999999';
const VARIANT = '44444444-8aaa-7aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = '55555555-8bbb-7bbb-8bbb-bbbbbbbbbbbb';
const CCA = '66666666-8ccc-7ccc-8ccc-cccccccccccc';
const CRED = '77777777-8ddd-7ddd-8ddd-dddddddddddd';

describe('packages/db — Task 3b.8 Checkpoint B credit/refund schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  const uid = (): string => crypto.randomUUID();
  let seq = 0;
  const RUN = crypto.randomUUID().slice(0, 8);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    const url = container.getConnectionUri();
    execFileSync(
      'node',
      [path.join(pkgDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    pool = new pg.Pool({ connectionString: url });

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT, '3b8-tenant'],
      [OTHER_TENANT, '3b8-tenant-other'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [id, slug],
      );
    }
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED') ON CONFLICT (code) DO NOTHING`,
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
       VALUES ($1, $2, $3, 'rose-bouquet', 'Test Product', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await pool.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt") VALUES ($1, $2, $3, 'Test Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [CRED, TENANT, COMPANY, BRANCH],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── fixture helpers ─────────────────────────────────────────────────────
  /** the customer account of the invoice's OWN customer — the account a CREDIT_NOTE advance for that invoice
   *  must belong to (migration 49, O-2B: credit_note -> invoice -> order.customerId must equal the advance
   *  account's customerId). Falls back to the shared CCA fixture (the default CUSTOMER's account). Call it
   *  BEFORE opening a transaction that already holds the invoice lock. */
  async function accountOfInvoice(invoiceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT cca.id FROM invoice i
         JOIN "order" o ON o.id = i."orderId"
         JOIN customer_company_account cca
           ON cca."customerId" = o."customerId" AND cca."companyId" = i."companyId" AND cca."tenantId" = i."tenantId"
        WHERE i.id = $1`,
      [invoiceId],
    );
    return rows[0]?.id ?? CCA;
  }

  async function insertOrder(customerId: string | null = CUSTOMER): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "documentDiscountAmountMinor", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,now())`,
      [id, TENANT, COMPANY, BRANCH, customerId, `fp-${id}`],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-${RUN}-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  /** ONE order_line: qty=2.0000, unitPrice=1000, line discount=200 (net 1800), tax=90 (5% TAX_EXCLUSIVE). */
  async function insertLine(orderId: string): Promise<string> {
    const lineId = uid();
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "discountMode", "discountAmountMinor", "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'2.0000',1000,'AED',2,'AMOUNT',200,'TAX_EXCLUSIVE','LINE','HALF_UP',90,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT],
    );
    return lineId;
  }

  async function insertInvoice(orderId: string, lineId: string): Promise<string> {
    const invoiceId = uid();
    await confirmOrder(orderId);
    const { rows } = await pool.query<{ originBranchId: string }>(
      `SELECT "originBranchId" FROM "order" WHERE id = $1`,
      [orderId],
    );
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 1800, 0, 90, 1890)`,
      [
        invoiceId,
        TENANT,
        COMPANY,
        rows[0]!.originBranchId,
        orderId,
        `INV-${invoiceId.slice(0, 8)}`,
      ],
    );
    void lineId;
    return invoiceId;
  }

  /** Fresh order + line + invoice: total 1890 (subtotal 1800 + tax 90), qty 2. */
  async function freshInvoice(): Promise<{ orderId: string; lineId: string; invoiceId: string }> {
    const orderId = await insertOrder();
    const lineId = await insertLine(orderId);
    const invoiceId = await insertInvoice(orderId, lineId);
    return { orderId, lineId, invoiceId };
  }

  async function insertCreditNote(
    invoiceId: string,
    overrides: {
      subtotal?: number;
      tax?: number;
      total?: number;
      arReduction?: number;
      advanceExcess?: number;
    } = {},
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO credit_note
         (id, "tenantId", "companyId", "branchId", "invoiceId", "creditNoteNumber", "issuedAt",
          "accountingDate", "currencyCode", "currencyExponent", "reasonCode",
          "subtotalAmountMinor", "taxTotalAmountMinor", "totalAmountMinor",
          "arReductionMinor", "advanceExcessMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 'CUSTOMER_REQUEST', $7,$8,$9,$10,$11)`,
      [
        id,
        TENANT,
        COMPANY,
        BRANCH,
        invoiceId,
        `CN-${id.slice(0, 8)}`,
        overrides.subtotal ?? 1800,
        overrides.tax ?? 90,
        overrides.total ?? 1890,
        overrides.arReduction ?? 1890,
        overrides.advanceExcess ?? 0,
      ],
    );
    return id;
  }

  /** §11 of the frozen 3b.8-A architecture requires
   *  `SUM(funded CustomerAdvance) = advanceExcessMinor` to hold the moment a
   *  CreditNote with `advanceExcessMinor > 0` commits (the deferred
   *  anchor-side trigger on `credit_note` itself proves this even with ZERO
   *  coverage-release rows) — so whenever a CreditNote's excess must be
   *  funded, the CustomerAdvance + CreditNoteCoverageRelease rows MUST be
   *  created in the SAME transaction as the header+line, mirroring how a
   *  real Credit-Note-issuance command would atomically do all of it at
   *  once (a later checkpoint's application code). `release` is optional
   *  precisely for the `advanceExcess = 0` (pure AR-reduction) case, where
   *  no release is needed at all. */
  async function insertCreditNoteWithLine(
    invoiceId: string,
    orderLineId: string,
    cn: {
      subtotal?: number;
      tax?: number;
      total?: number;
      arReduction?: number;
      advanceExcess?: number;
    } = {},
    line: {
      qty?: string;
      gross?: number;
      discount?: number;
      docShare?: number;
      net?: number;
      tax?: number;
      total?: number;
    } = {},
    release?: {
      sourceKind?: string;
      sourcePaymentAllocationId?: string | null;
      sourceAdvanceApplicationId?: string | null;
      sourcePaymentId?: string | null;
      amountMinor?: number;
      /** the caller-chosen id for the funded CustomerAdvance — pass this in
       *  when the caller needs to know the id up-front (it becomes the row
       *  actually inserted, instead of a fresh random one). */
      advanceId?: string;
    },
  ): Promise<string> {
    const cnId = uid();
    const gross = line.gross ?? 2000;
    const discount = line.discount ?? 200;
    const docShare = line.docShare ?? 0;
    const net = line.net ?? gross - discount - docShare;
    const tax = line.tax ?? 90;
    const total = line.total ?? net + tax;
    const advanceExcess = cn.advanceExcess ?? 0;
    let advanceId: string | null = null;
    // migration 49 (O-2B): the advance a credit note funds belongs to the INVOICE customer's own account —
    // resolved BEFORE the transaction opens (see the lock-wait note on `insertAdvanceApplication`)
    const advanceAccountId = await accountOfInvoice(invoiceId);
    const result = await inTransaction(async (c) => {
      await c.query(
        `INSERT INTO credit_note
           (id, "tenantId", "companyId", "branchId", "invoiceId", "creditNoteNumber", "issuedAt",
            "accountingDate", "currencyCode", "currencyExponent", "reasonCode",
            "subtotalAmountMinor", "taxTotalAmountMinor", "totalAmountMinor",
            "arReductionMinor", "advanceExcessMinor")
         VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 'CUSTOMER_REQUEST', $7,$8,$9,$10,$11)`,
        [
          cnId,
          TENANT,
          COMPANY,
          BRANCH,
          invoiceId,
          `CN-${cnId.slice(0, 8)}`,
          cn.subtotal ?? 1800,
          cn.tax ?? 90,
          cn.total ?? 1890,
          cn.arReduction ?? 1890,
          advanceExcess,
        ],
      );
      await c.query(
        `INSERT INTO credit_note_line
           (id, "tenantId", "companyId", "creditNoteId", "orderLineId", "quantityCredited",
            "grossCreditedMinor", "discountCreditedMinor", "documentDiscountShareCreditedMinor",
            "netAfterDocumentDiscountCreditedMinor", "taxCreditedMinor", "lineTotalCreditedMinor",
            "currencyCode", "currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'AED',2)`,
        [
          uid(),
          TENANT,
          COMPANY,
          cnId,
          orderLineId,
          line.qty ?? '2.0000',
          gross,
          discount,
          docShare,
          net,
          tax,
          total,
        ],
      );
      if (advanceExcess > 0) {
        advanceId = release?.advanceId ?? uid();
        await c.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
          [advanceId, TENANT, COMPANY, BRANCH, advanceAccountId, advanceExcess],
        );
        await c.query(
          `INSERT INTO credit_note_coverage_release
             (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AED',2,$11)`,
          [
            uid(),
            TENANT,
            COMPANY,
            BRANCH,
            cnId,
            release?.sourceKind ?? 'PAYMENT_ALLOCATION',
            release?.sourcePaymentAllocationId ?? null,
            release?.sourceAdvanceApplicationId ?? null,
            release?.sourcePaymentId ?? null,
            release?.amountMinor ?? advanceExcess,
            advanceId,
          ],
        );
      }
    });
    if (!result.ok) throw result.error;
    return cnId;
  }

  /** A round-number, tax-free, discount-free invoice — qty=1, unitPrice =
   *  totalMinor. Used where the point of the test is Refund/Advance-capacity
   *  arithmetic, not CreditNoteLine's own tax/discount reversal arithmetic.
   *  `customerId` (FINAL INTEGRITY PROOF PASS) — defaults to the global
   *  `CUSTOMER` fixture, as every pre-existing caller assumes; pass a
   *  specific customerId when the invoice must be attributed to a
   *  particular (e.g. freshly created) customer instead. */
  async function insertSimpleInvoice(
    totalMinor: number,
    customerId: string | null = CUSTOMER,
  ): Promise<{ orderId: string; lineId: string; invoiceId: string }> {
    const orderId = await insertOrder(customerId);
    const lineId = uid();
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "discountMode", "discountAmountMinor", "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'NONE',0,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT, totalMinor],
    );
    await confirmOrder(orderId);
    const { rows } = await pool.query<{ originBranchId: string }>(
      `SELECT "originBranchId" FROM "order" WHERE id = $1`,
      [orderId],
    );
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
        rows[0]!.originBranchId,
        orderId,
        `INV-${invoiceId.slice(0, 8)}`,
        totalMinor,
      ],
    );
    return { orderId, lineId, invoiceId };
  }

  /** A simple CreditNote (one line, qty=1, no tax/discount) fully or
   *  partially crediting a `insertSimpleInvoice`-shaped Invoice. */
  async function insertSimpleCreditNote(
    invoiceId: string,
    lineId: string,
    totalMinor: number,
    split: { arReduction: number; advanceExcess: number },
    release?: {
      sourceKind?: string;
      sourcePaymentAllocationId?: string | null;
      sourceAdvanceApplicationId?: string | null;
      sourcePaymentId?: string | null;
      advanceId?: string;
    },
  ): Promise<string> {
    return insertCreditNoteWithLine(
      invoiceId,
      lineId,
      {
        subtotal: totalMinor,
        tax: 0,
        total: totalMinor,
        arReduction: split.arReduction,
        advanceExcess: split.advanceExcess,
      },
      {
        qty: '1.0000',
        gross: totalMinor,
        discount: 0,
        docShare: 0,
        net: totalMinor,
        tax: 0,
        total: totalMinor,
      },
      release,
    );
  }

  async function insertPaymentWithAllocation(
    invoiceId: string,
    amountMinor: number,
  ): Promise<{ paymentId: string; allocationId: string }> {
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "receiptPurpose",
          method, "amountMinor", "currencyCode", "currencyExponent", state,
          "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
          "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4, (SELECT "orderId" FROM invoice WHERE id=$5), $5,'INVOICE_COLLECTION',
               'BANK_TRANSFER',$6,'AED',2,'CAPTURED','fp',1,$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, invoiceId, amountMinor, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId, amountMinor],
    );
    const allocationId = uid();
    await pool.query(
      `INSERT INTO payment_allocation (id, "tenantId", "companyId", "branchId", "paymentId", "invoiceId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [allocationId, TENANT, COMPANY, BRANCH, paymentId, invoiceId, amountMinor],
    );
    return { paymentId, allocationId };
  }

  async function insertCreditNoteAdvance(amountMinor: number): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
      [id, TENANT, COMPANY, BRANCH, CCA, amountMinor],
    );
    return id;
  }

  /** A fresh Customer + CustomerCompanyAccount — used whenever a test needs
   *  its OWN OPENING-sourced CustomerReceivable/CustomerAdvance, since the F9
   *  uniqueness backstop allows at most ONE opening balance (receivable OR
   *  advance) per CustomerCompanyAccount+branch; reusing the shared `CCA`
   *  constant across independent OPENING fixtures would collide. Returns the
   *  raw `customerId` too, since a PAYMENT-sourced Advance's own integrity
   *  trigger requires its `customerCompanyAccountId` to match the funding
   *  Payment's own attributed customer (via that Payment's order) — a fresh
   *  CCA is useless for that case unless the SAME customer also owns the
   *  order the Payment was captured against. */
  async function freshCustomerCompanyAccount(): Promise<{ ccaId: string; customerId: string }> {
    const customerId = uid();
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Fresh Customer', now())`,
      [customerId, TENANT],
    );
    const ccaId = uid();
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [ccaId, TENANT, COMPANY, customerId],
    );
    return { ccaId, customerId };
  }

  /** A CustomerAdvanceApplication whose funding CustomerAdvance is either
   *  PAYMENT-sourced or OPENING-sourced — the exact fixture §3/§4 of the
   *  corrective pass needs to exercise ADVANCE_APPLICATION vs
   *  OPENING_ADVANCE provenance.
   *
   *  For PAYMENT: the caller must supply a `sourcePaymentId` captured
   *  against an Invoice belonging to the SAME fresh customer this helper
   *  creates (see `insertPaymentForFreshCustomer` below) — a PAYMENT-sourced
   *  Advance's own integrity trigger requires its `customerCompanyAccountId`
   *  to match that Payment's attributed customer exactly.
   *
   *  The target CustomerReceivable is always INVOICE-sourced (a small
   *  dedicated invoice, never OPENING) — `CustomerAdvanceApplication`'s own
   *  frozen design accepts either shape generically, and using INVOICE here
   *  avoids ever competing for the SAME customer's F9 opening-balance slot
   *  the OPENING-sourced Advance case (below) already claims.
   *
   *  FINAL INTEGRITY PROOF PASS — `opts.targetInvoiceId`: since the coverage-
   *  release trigger now requires the application's own target receivable to
   *  be INVOICE-sourced for EXACTLY the releasing CreditNote's own Invoice
   *  (§1), a caller that wants its release to actually SUCCEED (or to be
   *  rejected for a reason OTHER than invoice provenance) must pass the
   *  CreditNote's own invoiceId here so the receivable this helper creates
   *  targets that SAME invoice. Omitted (the default), this helper still
   *  fabricates its own unrelated dedicated invoice — now exactly the
   *  fixture shape needed to prove the provenance rejection itself. */
  async function insertAdvanceApplication(
    advanceSourceType: 'PAYMENT' | 'OPENING',
    amountMinor: number,
    opts?: {
      sourcePaymentId?: string;
      ccaId?: string;
      customerId?: string;
      targetInvoiceId?: string;
    },
  ): Promise<{ applicationId: string; advanceId: string; ccaId: string }> {
    const { ccaId, customerId } =
      opts?.ccaId && opts?.customerId
        ? { ccaId: opts.ccaId, customerId: opts.customerId }
        : await freshCustomerCompanyAccount();
    const advanceId = uid();
    if (advanceSourceType === 'PAYMENT') {
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
        [advanceId, TENANT, COMPANY, BRANCH, ccaId, opts?.sourcePaymentId, amountMinor],
      );
    } else {
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
        [advanceId, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
      );
    }
    // target receivable: an INVOICE-sourced receivable for either the
    // caller-supplied invoice (opts.targetInvoiceId) or a fresh, unrelated,
    // dedicated invoice for the SAME customer (never OPENING — see doc
    // comment above).
    const targetInvoiceId =
      opts?.targetInvoiceId ??
      (await (async () => {
        const targetOrderId = await insertOrder(customerId);
        const targetLineId = await insertLine(targetOrderId);
        return insertInvoice(targetOrderId, targetLineId);
      })());
    const recvId = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
      [recvId, TENANT, COMPANY, BRANCH, ccaId, targetInvoiceId],
    );
    const applicationId = uid();
    await pool.query(
      `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [applicationId, TENANT, COMPANY, BRANCH, advanceId, recvId, amountMinor],
    );
    return { applicationId, advanceId, ccaId };
  }

  /** A fresh customer + a captured CUSTOMER_RECEIPT Payment (invoice-less,
   *  NO PaymentAllocation) attributed directly to that customer's CCA via
   *  `payment_attempt.customerCompanyAccountId` — the real-world shape of an
   *  over-collected/prepayment receipt later converted to a PAYMENT-sourced
   *  CustomerAdvance. Deliberately carries NO allocation: an INVOICE_COLLECTION
   *  payment allocated in full to its invoice would leave zero spare capacity
   *  under `fn_lock_and_validate_payment_capacity` for a same-payment Advance
   *  conversion (allocation + advance share one capacity ceiling against
   *  `payment.amountMinor`) — CUSTOMER_RECEIPT sidesteps that by construction. */
  async function insertPaymentForFreshCustomer(
    amountMinor: number,
  ): Promise<{ ccaId: string; customerId: string; paymentId: string }> {
    const { ccaId, customerId } = await freshCustomerCompanyAccount();
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'BANK_TRANSFER',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, ccaId, amountMinor, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId, amountMinor],
    );
    return { ccaId, customerId, paymentId };
  }

  async function inTransaction<T>(
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const value = await fn(c);
      await c.query('COMMIT');
      return { ok: true, value };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      return { ok: false, error: err as Error };
    } finally {
      c.release();
    }
  }

  // ═══════════════════════ CreditNote / CreditNoteLine ═══════════════════════
  describe('CreditNote + CreditNoteLine', () => {
    it('a valid full CreditNote + Line commits and reconciles', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1800,90,1890,1890,0)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'2.0000',2000,200,0,1800,90,1890,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId],
        );
        return cnId;
      });
      expect(result.ok).toBe(true);
    });

    it('zero-line CreditNote fails at COMMIT (deferred completeness)', async () => {
      const { invoiceId } = await freshInvoice();
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1800,90,1890,1890,0)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(/zero credit_note_line/);
    });

    it('mismatched header total fails at COMMIT', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1800,90,1891,1891,0)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'2.0000',2000,200,0,1800,90,1890,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(/totalAmountMinor/);
    });

    it('wrong orderLine provenance (line from an unrelated order) is rejected', async () => {
      const { invoiceId } = await freshInvoice();
      const other = await freshInvoice();
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1800,90,1890,1890,0)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'2.0000',2000,200,0,1800,90,1890,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, other.lineId],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(
        /does not belong to the credit note/,
      );
    });

    it('quantity over-credit is rejected', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1800,90,1890,1890,0)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'2.0001',2000,200,0,1800,90,1890,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(
        /cumulative quantityCredited exceeds/,
      );
    });

    it('tax over-credit is rejected', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1800,91,1891,1891,0)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'2.0000',2000,200,0,1800,91,1891,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(
        /cumulative taxCreditedMinor exceeds/,
      );
    });

    it('exact partial credit + exact final residual succeeds across two CreditNotes', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      await expect(
        insertCreditNoteWithLine(
          invoiceId,
          lineId,
          { subtotal: 900, tax: 45, total: 945, arReduction: 945, advanceExcess: 0 },
          { qty: '1.0000', gross: 1000, discount: 100, net: 900, tax: 45, total: 945 },
        ),
      ).resolves.toBeTruthy();
      await expect(
        insertCreditNoteWithLine(
          invoiceId,
          lineId,
          { subtotal: 900, tax: 45, total: 945, arReduction: 945, advanceExcess: 0 },
          { qty: '1.0000', gross: 1000, discount: 100, net: 900, tax: 45, total: 945 },
        ),
      ).resolves.toBeTruthy();
    });

    it('Invoice-aggregate capacity trigger exists and does not reject a single fully-reconciled CreditNote at exactly Invoice.totalAmountMinor', async () => {
      // NOTE: given the 7-component per-line capacity trigger already
      // mathematically guarantees SUM(CreditNote.total for one Invoice) can
      // never exceed Invoice.totalAmountMinor (every credited component is
      // independently capped per order_line, and Invoice.totalAmountMinor is
      // itself exactly the sum of its own order_lines' totals), the deferred
      // Invoice-aggregate trigger is a defense-in-depth backstop that is
      // never independently reachable as the PROXIMATE rejection cause once
      // the line-level trigger is functioning correctly — attempting to
      // over-credit the same order_line a second time is caught by the
      // line-level trigger first (proven by the "quantity/tax over-credit"
      // tests above). This test proves the backstop is harmless on the
      // legitimate boundary case (exactly Invoice.totalAmountMinor, in one
      // CreditNote) rather than asserting an unreachable failure mode.
      const { lineId, invoiceId } = await freshInvoice();
      await expect(insertCreditNoteWithLine(invoiceId, lineId)).resolves.toBeTruthy();
    });

    it('split CHECK: arReduction + advanceExcess != total is rejected', async () => {
      const { invoiceId } = await freshInvoice();
      await expect(
        insertCreditNote(invoiceId, { arReduction: 1000, advanceExcess: 0 }),
      ).rejects.toThrow(/credit_note_split_eq_total_chk/);
    });

    it('UPDATE and DELETE on credit_note are rejected', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const cnId = await insertCreditNoteWithLine(invoiceId, lineId);
      await expect(
        pool.query(`UPDATE credit_note SET "reasonCode"='OTHER' WHERE id=$1`, [cnId]),
      ).rejects.toThrow(/immutable/);
      await expect(pool.query(`DELETE FROM credit_note WHERE id=$1`, [cnId])).rejects.toThrow(
        /immutable/,
      );
    });

    it('UPDATE and DELETE on credit_note_line are rejected', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const cnId = await insertCreditNoteWithLine(invoiceId, lineId);
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM credit_note_line WHERE "creditNoteId" = $1`,
        [cnId],
      );
      const clId = rows[0]!.id;
      await expect(
        pool.query(`UPDATE credit_note_line SET "taxCreditedMinor"=91 WHERE id=$1`, [clId]),
      ).rejects.toThrow(/immutable/);
      await expect(pool.query(`DELETE FROM credit_note_line WHERE id=$1`, [clId])).rejects.toThrow(
        /immutable/,
      );
    });
  });

  // ═══════════════════════ CoverageRelease / Advance 1:1 ═════════════════════
  describe('CreditNoteCoverageRelease <-> CustomerAdvance', () => {
    it('a valid PAYMENT_ALLOCATION release funding a matching CREDIT_NOTE advance succeeds and completeness passes', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 1890);
      await expect(
        insertCreditNoteWithLine(
          invoiceId,
          lineId,
          { arReduction: 0, advanceExcess: 1890 },
          {},
          { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId },
        ),
      ).resolves.toBeTruthy();
    });

    it('a release whose funded advance amount mismatches releasedAmountMinor is rejected', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 1890);
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1800,90,1890,0,1890)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'2.0000',2000,200,0,1800,90,1890,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId],
        );
        const advId = uid();
        await c.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',1000,'AED',2)`, // mismatch vs the 1890 release below
          [advId, TENANT, COMPANY, BRANCH, CCA],
        );
        await c.query(
          `INSERT INTO credit_note_coverage_release (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
           VALUES ($1,$2,$3,$4,$5,'PAYMENT_ALLOCATION',$6,NULL,$7,1890,'AED',2,$8)`,
          [uid(), TENANT, COMPANY, BRANCH, cnId, allocationId, paymentId, advId],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(
        /does not equal|releasedAmountMinor/,
      );
    });

    /** Builds one complete CreditNote(header+line) + ONE coverage release +
     *  its funded CREDIT_NOTE Advance, all in one transaction — the minimal
     *  shape every provenance/capacity test below needs. `lineOverrides`
     *  lets each call credit a different quantity slice of the SAME
     *  `insertSimpleInvoice`-shaped line without ever approaching its own
     *  quantity ceiling (every test in this file uses distinct, small
     *  fractions of a large round invoice total for exactly this reason). */
    async function insertReleaseInOneTx(
      invoiceId: string,
      lineId: string,
      amountMinor: number,
      releaseOverrides: {
        sourceKind?: string;
        sourcePaymentAllocationId?: string | null;
        sourceAdvanceApplicationId?: string | null;
        sourcePaymentId?: string | null;
      },
    ): Promise<{ ok: boolean; error?: Error }> {
      // migration 49 (O-2B): the funded advance belongs to the INVOICE customer's own account (resolved
      // before the transaction opens — it must never wait on the invoice lock the transaction takes)
      const advanceAccountId = await accountOfInvoice(invoiceId);
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',$7,0,$7,0,$7)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`, amountMinor],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$7,0,$7,'AED',2)`,
          [
            uid(),
            TENANT,
            COMPANY,
            cnId,
            lineId,
            (amountMinor / 10000).toFixed(4), // qty fraction of the 10000-unit-price simple invoice
            amountMinor,
          ],
        );
        const advId = uid();
        await c.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
          [advId, TENANT, COMPANY, BRANCH, advanceAccountId, amountMinor],
        );
        await c.query(
          `INSERT INTO credit_note_coverage_release (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AED',2,$11)`,
          [
            uid(),
            TENANT,
            COMPANY,
            BRANCH,
            cnId,
            releaseOverrides.sourceKind ?? 'PAYMENT_ALLOCATION',
            releaseOverrides.sourcePaymentAllocationId ?? null,
            releaseOverrides.sourceAdvanceApplicationId ?? null,
            releaseOverrides.sourcePaymentId ?? null,
            amountMinor,
            advId,
          ],
        );
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }

    it('OPENING_ADVANCE with a valid sourceAdvanceApplicationId (OPENING-funded) and sourcePaymentId=NULL succeeds (A)', async () => {
      // fresh CCA — an OPENING-sourced customer_advance claims that
      // account's single F9 opening-balance slot forever; sharing the global
      // CCA across several OPENING fixtures in this describe block would
      // collide (see the identical rationale on freshCustomerCompanyAccount).
      const { ccaId, customerId } = await freshCustomerCompanyAccount();
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
      const { applicationId } = await insertAdvanceApplication('OPENING', 200, {
        ccaId,
        customerId,
        targetInvoiceId: invoiceId,
      });
      const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourceKind: 'OPENING_ADVANCE',
        sourceAdvanceApplicationId: applicationId,
        sourcePaymentId: null,
      });
      expect(r.ok).toBe(true);
    });

    it('OPENING_ADVANCE with no sourceAdvanceApplicationId is rejected (B)', async () => {
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000);
      const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourceKind: 'OPENING_ADVANCE',
        sourceAdvanceApplicationId: null,
        sourcePaymentId: null,
      });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/sourceAdvanceApplicationId is required/);
    });

    it('OPENING_ADVANCE pointing to a PAYMENT-funded CustomerAdvanceApplication is rejected (C)', async () => {
      const { ccaId, customerId, paymentId } = await insertPaymentForFreshCustomer(200);
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
      const { applicationId } = await insertAdvanceApplication('PAYMENT', 200, {
        sourcePaymentId: paymentId,
        ccaId,
        customerId,
        targetInvoiceId: invoiceId,
      });
      const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourceKind: 'OPENING_ADVANCE',
        sourceAdvanceApplicationId: applicationId,
        sourcePaymentId: null,
      });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/sourceType=OPENING/);
    });

    it('ADVANCE_APPLICATION pointing to an OPENING-sourced CustomerAdvance is rejected (D)', async () => {
      const { ccaId, customerId } = await freshCustomerCompanyAccount();
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
      const { applicationId } = await insertAdvanceApplication('OPENING', 200, {
        ccaId,
        customerId,
        targetInvoiceId: invoiceId,
      });
      const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourceKind: 'ADVANCE_APPLICATION',
        sourceAdvanceApplicationId: applicationId,
        sourcePaymentId: crypto.randomUUID(),
      });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/sourceType=PAYMENT/);
    });

    it('payment-funded ADVANCE_APPLICATION with the exact sourcePaymentId succeeds (E)', async () => {
      const { ccaId, customerId, paymentId } = await insertPaymentForFreshCustomer(200);
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
      const { applicationId } = await insertAdvanceApplication('PAYMENT', 200, {
        sourcePaymentId: paymentId,
        ccaId,
        customerId,
        targetInvoiceId: invoiceId,
      });
      const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourceKind: 'ADVANCE_APPLICATION',
        sourceAdvanceApplicationId: applicationId,
        sourcePaymentId: paymentId,
      });
      expect(r.ok).toBe(true);
    });

    it('payment-funded ADVANCE_APPLICATION with the WRONG sourcePaymentId is rejected (F)', async () => {
      const { ccaId, customerId, paymentId } = await insertPaymentForFreshCustomer(200);
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
      const { applicationId } = await insertAdvanceApplication('PAYMENT', 200, {
        sourcePaymentId: paymentId,
        ccaId,
        customerId,
        targetInvoiceId: invoiceId,
      });
      const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourceKind: 'ADVANCE_APPLICATION',
        sourceAdvanceApplicationId: applicationId,
        sourcePaymentId: crypto.randomUUID(),
      });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(
        /does not match the underlying PAYMENT-sourced customer_advance/,
      );
    });

    it('multiple partial releases from the SAME PaymentAllocation: 200 then 300 succeed, leaving 500 unreleased; 501 more is rejected; exactly 500 more succeeds', async () => {
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000);
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 1000);

      const r1 = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourcePaymentAllocationId: allocationId,
        sourcePaymentId: paymentId,
      });
      expect(r1.ok).toBe(true);

      const r2 = await insertReleaseInOneTx(invoiceId, lineId, 300, {
        sourcePaymentAllocationId: allocationId,
        sourcePaymentId: paymentId,
      });
      expect(r2.ok).toBe(true);
      // cumulative so far: 500 of 1000 — 500 remains.

      const rOver = await insertReleaseInOneTx(invoiceId, lineId, 501, {
        sourcePaymentAllocationId: allocationId,
        sourcePaymentId: paymentId,
      });
      expect(rOver.ok).toBe(false);
      expect(rOver.error?.message).toMatch(/cumulative release .* exceeds payment_allocation/);

      const rExact = await insertReleaseInOneTx(invoiceId, lineId, 500, {
        sourcePaymentAllocationId: allocationId,
        sourcePaymentId: paymentId,
      });
      expect(rExact.ok).toBe(true);

      const rNoMore = await insertReleaseInOneTx(invoiceId, lineId, 1, {
        sourcePaymentAllocationId: allocationId,
        sourcePaymentId: paymentId,
      });
      expect(rNoMore.ok).toBe(false);
    });

    it('multiple partial releases from the SAME CustomerAdvanceApplication: 200 then 300 succeed; 501 more is rejected; exactly 500 more succeeds', async () => {
      const { ccaId, customerId } = await freshCustomerCompanyAccount();
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
      const { applicationId } = await insertAdvanceApplication('OPENING', 1000, {
        ccaId,
        customerId,
        targetInvoiceId: invoiceId,
      });

      const r1 = await insertReleaseInOneTx(invoiceId, lineId, 200, {
        sourceKind: 'OPENING_ADVANCE',
        sourceAdvanceApplicationId: applicationId,
      });
      expect(r1.ok).toBe(true);

      const r2 = await insertReleaseInOneTx(invoiceId, lineId, 300, {
        sourceKind: 'OPENING_ADVANCE',
        sourceAdvanceApplicationId: applicationId,
      });
      expect(r2.ok).toBe(true);

      const rOver = await insertReleaseInOneTx(invoiceId, lineId, 501, {
        sourceKind: 'OPENING_ADVANCE',
        sourceAdvanceApplicationId: applicationId,
      });
      expect(rOver.ok).toBe(false);
      expect(rOver.error?.message).toMatch(
        /cumulative release .* exceeds customer_advance_application/,
      );

      const rExact = await insertReleaseInOneTx(invoiceId, lineId, 500, {
        sourceKind: 'OPENING_ADVANCE',
        sourceAdvanceApplicationId: applicationId,
      });
      expect(rExact.ok).toBe(true);
    });

    it('duplicate release of the SAME PaymentAllocation inside the SAME CreditNote is rejected (composite UNIQUE)', async () => {
      const { lineId, invoiceId } = await insertSimpleInvoice(10_000);
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 1000);
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',300,0,300,0,300)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'0.0300',300,0,0,300,0,300,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId],
        );
        for (const amt of [100, 200]) {
          const advId = uid();
          await c.query(
            `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
             VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
            [advId, TENANT, COMPANY, BRANCH, CCA, amt],
          );
          await c.query(
            `INSERT INTO credit_note_coverage_release (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
             VALUES ($1,$2,$3,$4,$5,'PAYMENT_ALLOCATION',$6,NULL,$7,$8,'AED',2,$9)`,
            [uid(), TENANT, COMPANY, BRANCH, cnId, allocationId, paymentId, amt, advId],
          );
        }
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(
        /credit_note_coverage_release_creditNoteId_sourcePaymentAll_key|duplicate key/,
      );
    });

    it('advanceExcess deferred completeness fails at COMMIT when the funding release undershoots the target', async () => {
      const { ccaId, customerId } = await freshCustomerCompanyAccount();
      const { lineId, invoiceId } = await insertSimpleInvoice(1890, customerId);
      // deliberately undershoots: advanceExcessMinor claims 1890, but only a
      // 1000 OPENING_ADVANCE release/advance is actually funded alongside it —
      // now with the CORRECTED (post-corrective-pass) OPENING_ADVANCE shape,
      // which requires a real sourceAdvanceApplicationId. Built BEFORE the
      // transaction below opens: `insertAdvanceApplication`'s own internal
      // inserts use the shared pool (a separate connection), and its
      // customer_receivable row now targets this SAME invoiceId (§1) — done
      // after the transaction below has already locked that Invoice FOR
      // UPDATE, the FK's implicit lock on the referenced invoice row would
      // wait on a connection the test itself is blocking on, hanging forever.
      const { applicationId } = await insertAdvanceApplication('OPENING', 1000, {
        ccaId,
        customerId,
        targetInvoiceId: invoiceId,
      });
      const result = await inTransaction(async (c) => {
        const cnId = uid();
        await c.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1890,0,1890,0,1890)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'1.0000',1890,0,0,1890,0,1890,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId],
        );
        const advId = uid();
        await c.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',1000,'AED',2)`,
          [advId, TENANT, COMPANY, BRANCH, ccaId], // the invoice customer's own account (migration 49, O-2B)
        );
        await c.query(
          `INSERT INTO credit_note_coverage_release (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
           VALUES ($1,$2,$3,$4,$5,'OPENING_ADVANCE',NULL,$6,NULL,1000,'AED',2,$7)`,
          [uid(), TENANT, COMPANY, BRANCH, cnId, applicationId, advId],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(/advanceExcessMinor/);
    });

    // Shared fixtures for the three "final integrity proof pass" groups
    // below (provenance / money-dimension / lock-order) — hoisted to this
    // parent scope so all three sibling describe blocks can use them.

    /** An INVOICE-sourced CustomerReceivable for a GIVEN ccaId+invoiceId —
     *  generalizes the inline logic `insertAdvanceApplication` already uses
     *  for its own (matching) target, letting these tests build a
     *  receivable for an ARBITRARY (often deliberately mismatched)
     *  invoice/account pairing instead. */
    async function insertReceivableForInvoice(ccaId: string, invoiceId: string): Promise<string> {
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
        [recvId, TENANT, COMPANY, BRANCH, ccaId, invoiceId],
      );
      return recvId;
    }

    /** An OPENING-sourced CustomerReceivable for a GIVEN ccaId — claims that
     *  account's F9 opening-balance slot, so callers must pass a FRESH ccaId
     *  (never one already used for an OPENING advance elsewhere). */
    async function insertOpeningReceivable(ccaId: string, amountMinor: number): Promise<string> {
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
        [recvId, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
      );
      return recvId;
    }

    /** A CANCELLATION_CHARGE-sourced CustomerReceivable for a GIVEN ccaId —
     *  builds its own backing Order + CancellationCharge row first (a
     *  cancellationChargeId is mandatory + UNIQUE for this sourceType). */
    async function insertCancellationChargeReceivable(
      ccaId: string,
      customerId: string,
    ): Promise<string> {
      const orderId = await insertOrder(customerId);
      const ccId = uid();
      await pool.query(
        `INSERT INTO cancellation_charge
           (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
            "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
            "priceTaxMode","roundingMode","reasonCode","accountingDate")
         VALUES ($1,$2,$3,$4,$5,$6,100,5,105,'AED',2,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
        [ccId, TENANT, COMPANY, BRANCH, orderId, `CC-${ccId.slice(0, 8)}`],
      );
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","cancellationChargeId")
         VALUES ($1,$2,$3,$4,$5,'CANCELLATION_CHARGE',$6)`,
        [recvId, TENANT, COMPANY, BRANCH, ccaId, ccId],
      );
      return recvId;
    }

    /** A CustomerAdvance (PAYMENT- or OPENING-sourced) + its Application
     *  against a CALLER-SUPPLIED `customerReceivableId` — unlike the
     *  top-level `insertAdvanceApplication`, this never fabricates its own
     *  target receivable, so these tests can point it at an arbitrary
     *  (matching OR deliberately mismatched) receivable. */
    async function insertAdvanceApplicationToReceivable(
      advanceSourceType: 'PAYMENT' | 'OPENING',
      amountMinor: number,
      ccaId: string,
      customerReceivableId: string,
      opts?: { sourcePaymentId?: string },
    ): Promise<{ applicationId: string; advanceId: string }> {
      const advanceId = uid();
      if (advanceSourceType === 'PAYMENT') {
        await pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
          [advanceId, TENANT, COMPANY, BRANCH, ccaId, opts?.sourcePaymentId, amountMinor],
        );
      } else {
        await pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
           VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
          [advanceId, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
        );
      }
      const applicationId = uid();
      await pool.query(
        `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
        [applicationId, TENANT, COMPANY, BRANCH, advanceId, customerReceivableId, amountMinor],
      );
      return { applicationId, advanceId };
    }

    // ═════════ FINAL INTEGRITY PROOF PASS — source-Invoice provenance ═══════
    // §1: scope equality (tenant/company/branch/customer) alone is never
    // sufficient — the coverage source must belong to EXACTLY the releasing
    // CreditNote's own Invoice.
    describe('source-Invoice provenance (final integrity proof pass)', () => {
      it('(A) PAYMENT_ALLOCATION from a DIFFERENT Invoice of the SAME customer is rejected', async () => {
        const { customerId } = await freshCustomerCompanyAccount();
        const { lineId: lineIdA, invoiceId: invoiceIdA } = await insertSimpleInvoice(
          10_000,
          customerId,
        );
        const orderB = await insertOrder(customerId);
        const lineB = await insertLine(orderB);
        const invoiceIdB = await insertInvoice(orderB, lineB);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceIdB, 200);
        const r = await insertReleaseInOneTx(invoiceIdA, lineIdA, 200, {
          sourcePaymentAllocationId: allocationId,
          sourcePaymentId: paymentId,
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(
          /payment_allocation .* own invoiceId does not match credit_note .* own invoiceId/,
        );
      });

      it('(B) AdvanceApplication applied to a DIFFERENT Invoice of the SAME customer is rejected', async () => {
        const { ccaId, customerId, paymentId } = await insertPaymentForFreshCustomer(200);
        const { lineId: lineIdA, invoiceId: invoiceIdA } = await insertSimpleInvoice(
          10_000,
          customerId,
        );
        const orderB = await insertOrder(customerId);
        const lineB = await insertLine(orderB);
        const invoiceIdB = await insertInvoice(orderB, lineB);
        const recvB = await insertReceivableForInvoice(ccaId, invoiceIdB);
        const { applicationId } = await insertAdvanceApplicationToReceivable(
          'PAYMENT',
          200,
          ccaId,
          recvB,
          { sourcePaymentId: paymentId },
        );
        const r = await insertReleaseInOneTx(invoiceIdA, lineIdA, 200, {
          sourceKind: 'ADVANCE_APPLICATION',
          sourceAdvanceApplicationId: applicationId,
          sourcePaymentId: paymentId,
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(
          /customer_advance_application .* does not target credit_note .* own invoice/,
        );
      });

      it('(C) AdvanceApplication targeting an OPENING receivable is rejected', async () => {
        // PAYMENT-sourced funding (not OPENING) deliberately: an OPENING
        // receivable ALREADY claims this account's single F9 opening-balance
        // slot (customer_opening_balance_init) — an OPENING-sourced Advance
        // for the SAME account would claim it a second time and collide. The
        // check under test only inspects the target receivable's own
        // sourceType, so a PAYMENT-sourced Advance exercises it identically.
        const { ccaId, customerId, paymentId } = await insertPaymentForFreshCustomer(200);
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
        const openingRecvId = await insertOpeningReceivable(ccaId, 200);
        const { applicationId } = await insertAdvanceApplicationToReceivable(
          'PAYMENT',
          200,
          ccaId,
          openingRecvId,
          { sourcePaymentId: paymentId },
        );
        const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
          sourceKind: 'ADVANCE_APPLICATION',
          sourceAdvanceApplicationId: applicationId,
          sourcePaymentId: paymentId,
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(
          /does not target credit_note .* own invoice \(receivable sourceType=OPENING/,
        );
      });

      it('(D) AdvanceApplication targeting a CANCELLATION_CHARGE receivable is rejected', async () => {
        const { ccaId, customerId, paymentId } = await insertPaymentForFreshCustomer(200);
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
        const ccRecvId = await insertCancellationChargeReceivable(ccaId, customerId);
        // 100 (not 200): the fixture's charge receivable totals 105, and the
        // Integration Closure's corrected `fn_lock_and_validate_opening_receivable_coverage`
        // now enforces a charge receivable's capacity (it used to compare
        // against a NULL principal and silently accept any amount — which is
        // what let this fixture over-apply 200 against a 105 charge). The
        // point of this test is the RELEASE provenance rejection below, not
        // the over-application.
        const { applicationId } = await insertAdvanceApplicationToReceivable(
          'PAYMENT',
          100,
          ccaId,
          ccRecvId,
          { sourcePaymentId: paymentId },
        );
        const r = await insertReleaseInOneTx(invoiceId, lineId, 100, {
          sourceKind: 'ADVANCE_APPLICATION',
          sourceAdvanceApplicationId: applicationId,
          sourcePaymentId: paymentId,
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(
          /does not target credit_note .* own invoice \(receivable sourceType=CANCELLATION_CHARGE/,
        );
      });

      it('(E) PAYMENT_ALLOCATION from a totally different customer/account is rejected', async () => {
        const { customerId: customerX } = await freshCustomerCompanyAccount();
        const { lineId: lineIdA, invoiceId: invoiceIdA } = await insertSimpleInvoice(
          10_000,
          customerX,
        );
        const { customerId: customerY } = await freshCustomerCompanyAccount();
        const orderC = await insertOrder(customerY);
        const lineC = await insertLine(orderC);
        const invoiceIdC = await insertInvoice(orderC, lineC);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceIdC, 200);
        const r = await insertReleaseInOneTx(invoiceIdA, lineIdA, 200, {
          sourcePaymentAllocationId: allocationId,
          sourcePaymentId: paymentId,
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(
          /payment_allocation .* own invoiceId does not match credit_note .* own invoiceId/,
        );
      });

      it('(F) exact-Invoice PaymentAllocation source succeeds', async () => {
        const { customerId } = await freshCustomerCompanyAccount();
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 200);
        const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
          sourcePaymentAllocationId: allocationId,
          sourcePaymentId: paymentId,
        });
        expect(r.ok).toBe(true);
      });

      it('(G) exact-Invoice CustomerAdvanceApplication source succeeds', async () => {
        const { ccaId, customerId, paymentId } = await insertPaymentForFreshCustomer(200);
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
        const recvA = await insertReceivableForInvoice(ccaId, invoiceId);
        const { applicationId } = await insertAdvanceApplicationToReceivable(
          'PAYMENT',
          200,
          ccaId,
          recvA,
          { sourcePaymentId: paymentId },
        );
        const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
          sourceKind: 'ADVANCE_APPLICATION',
          sourceAdvanceApplicationId: applicationId,
          sourcePaymentId: paymentId,
        });
        expect(r.ok).toBe(true);
      });
    });

    // ═════════ FINAL INTEGRITY PROOF PASS — Money-dimension exactness ═══════
    describe('money-dimension exactness (final integrity proof pass)', () => {
      /** Builds one complete CreditNote(header+line)+CustomerAdvance(CREDIT_NOTE)+
       *  CoverageRelease in one transaction, with every currency/exponent
       *  independently overridable — unlike `insertReleaseInOneTx` (which
       *  hardcodes 'AED'/2 throughout), this is what the money-mismatch tests
       *  need. The funded CustomerAdvance's own amountMinor always equals
       *  `release.releasedAmountMinor` (the pre-existing, frozen, exact-match
       *  rule — never independently varied here). */
      async function insertReleaseCustom(params: {
        invoiceId: string;
        lineId: string;
        creditNoteAmountMinor: number;
        creditNoteCurrencyCode?: string;
        creditNoteCurrencyExponent?: number;
        release: {
          sourceKind: string;
          sourcePaymentAllocationId?: string | null;
          sourceAdvanceApplicationId?: string | null;
          sourcePaymentId?: string | null;
          releasedAmountMinor: number;
          currencyCode?: string;
          currencyExponent?: number;
        };
        advanceCurrencyCode?: string;
        advanceCurrencyExponent?: number;
      }): Promise<{ ok: boolean; error?: Error }> {
        const result = await inTransaction(async (c) => {
          const cnId = uid();
          const cnCur = params.creditNoteCurrencyCode ?? 'AED';
          const cnExp = params.creditNoteCurrencyExponent ?? 2;
          await c.query(
            `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
             VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,$7,$8,'CUSTOMER_REQUEST',$9,0,$9,0,$9)`,
            [
              cnId,
              TENANT,
              COMPANY,
              BRANCH,
              params.invoiceId,
              `CN-${cnId.slice(0, 8)}`,
              cnCur,
              cnExp,
              params.creditNoteAmountMinor,
            ],
          );
          await c.query(
            `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$7,0,$7,$8,$9)`,
            [
              uid(),
              TENANT,
              COMPANY,
              cnId,
              params.lineId,
              (params.creditNoteAmountMinor / 10000).toFixed(4),
              params.creditNoteAmountMinor,
              cnCur,
              cnExp,
            ],
          );
          const advId = uid();
          const advCur = params.advanceCurrencyCode ?? cnCur;
          const advExp = params.advanceCurrencyExponent ?? cnExp;
          await c.query(
            `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
             VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,$7,$8)`,
            [
              advId,
              TENANT,
              COMPANY,
              BRANCH,
              CCA,
              params.release.releasedAmountMinor,
              advCur,
              advExp,
            ],
          );
          await c.query(
            `INSERT INTO credit_note_coverage_release (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              uid(),
              TENANT,
              COMPANY,
              BRANCH,
              cnId,
              params.release.sourceKind,
              params.release.sourcePaymentAllocationId ?? null,
              params.release.sourceAdvanceApplicationId ?? null,
              params.release.sourcePaymentId ?? null,
              params.release.releasedAmountMinor,
              params.release.currencyCode ?? cnCur,
              params.release.currencyExponent ?? cnExp,
              advId,
            ],
          );
        });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }

      it('release currency mismatch vs its own CreditNote is rejected (AED CreditNote, USD release)', async () => {
        const { customerId } = await freshCustomerCompanyAccount();
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 200);
        const r = await insertReleaseCustom({
          invoiceId,
          lineId,
          creditNoteAmountMinor: 200,
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            sourcePaymentAllocationId: allocationId,
            sourcePaymentId: paymentId,
            releasedAmountMinor: 200,
            currencyCode: 'USD',
          },
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(/currency .* does not match credit_note .* own currency/);
      });

      it('release currencyExponent mismatch vs its own CreditNote is rejected (same currencyCode, different exponent)', async () => {
        const { customerId } = await freshCustomerCompanyAccount();
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 200);
        const r = await insertReleaseCustom({
          invoiceId,
          lineId,
          creditNoteAmountMinor: 200,
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            sourcePaymentAllocationId: allocationId,
            sourcePaymentId: paymentId,
            releasedAmountMinor: 200,
            currencyCode: 'AED',
            currencyExponent: 3,
          },
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(/currency .* does not match credit_note .* own currency/);
      });

      // NOTE on source-vs-release currency: PaymentAllocation, CustomerAdvance
      // and CustomerAdvanceApplication are EACH independently FK-locked to
      // their owning company's OWN single `defaultCurrency`
      // (`payment_allocation_currency_company_fkey` /
      // `customer_advance_currency_company_fkey` /
      // `customer_advance_application_currency_company_fkey` — pre-existing,
      // frozen, migration `20260923120000_payments_core` /
      // `20260927130000_receivables_core_schema`). For one company that
      // means a PaymentAllocation/CustomerAdvanceApplication and the
      // CustomerAdvance it eventually funds can NEVER independently hold
      // different currencies from each other — both are always exactly the
      // company's one currency. Reaching the trigger's PAYMENT_ALLOCATION-
      // or ADVANCE_APPLICATION-vs-release currency check (`allocation_currency_code
      // IS DISTINCT FROM NEW."currencyCode"` / `application_currency_code IS
      // DISTINCT FROM NEW."currencyCode"`) with the EARLIER funded-Advance-vs-
      // release check already passed requires `NEW."currencyCode"` to equal
      // the Advance's own (company-forced) currency, which the source
      // ALSO always holds — so no live fixture can isolate that branch
      // without ALSO already failing the earlier Advance check. The check is
      // still correct, still defends against a future multi-currency-per-
      // company schema evolution or a direct/malicious SQL bypass, and is
      // verified here by code inspection (migration 44,
      // `fn_check_credit_note_coverage_release_integrity`) rather than by a
      // forced/misleading integration test. The funded-Advance-vs-release
      // check immediately below IS independently reachable, because
      // `credit_note`/`credit_note_coverage_release` carry NO such FK to
      // company.defaultCurrency (free-form on both).

      it('funded CustomerAdvance currency mismatch vs its own release is rejected', async () => {
        const { customerId } = await freshCustomerCompanyAccount();
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000, customerId);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 200);
        // CreditNote + release both claim USD (passes the CreditNote-vs-
        // release check) while the funded CustomerAdvance is left at its
        // only legally-insertable value for this company — 'AED' — so the
        // funded-Advance-vs-release check is reached and fires in isolation.
        const r = await insertReleaseCustom({
          invoiceId,
          lineId,
          creditNoteAmountMinor: 200,
          creditNoteCurrencyCode: 'USD',
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            sourcePaymentAllocationId: allocationId,
            sourcePaymentId: paymentId,
            releasedAmountMinor: 200,
            currencyCode: 'USD',
          },
          advanceCurrencyCode: 'AED',
          advanceCurrencyExponent: 2,
        });
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(
          /funded customer_advance .* currency .* does not match this release/,
        );
      });
    });

    // ═════════ FINAL INTEGRITY PROOF PASS — Invoice-first lock order ════════
    describe('Invoice-first lock order / concurrency (final integrity proof pass)', () => {
      it('two concurrent CreditNotes releasing from the SAME PaymentAllocation on the SAME Invoice never double-spend and never deadlock', async () => {
        const { lineId, invoiceId } = await insertSimpleInvoice(10_000);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 1000);

        const [r1, r2] = await Promise.all([
          insertReleaseInOneTx(invoiceId, lineId, 700, {
            sourcePaymentAllocationId: allocationId,
            sourcePaymentId: paymentId,
          }),
          insertReleaseInOneTx(invoiceId, lineId, 700, {
            sourcePaymentAllocationId: allocationId,
            sourcePaymentId: paymentId,
          }),
        ]);

        // both promises settled (no hang/deadlock). Exactly one of the two
        // 700-releases succeeds — 700+700=1400 > the allocation's own 1000
        // capacity, so the SECOND to acquire the Invoice-first serialization
        // lock must see the FIRST's already-committed 700 and be rejected on
        // capacity, never on a deadlock, and never both succeeding (which
        // would silently double-spend 400 beyond the source's own capacity).
        const results = [r1, r2];
        const succeeded = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);
        expect(succeeded.length).toBe(1);
        expect(failed.length).toBe(1);
        expect(failed[0]!.error?.message).toMatch(
          /cumulative release .* exceeds payment_allocation/,
        );
      }, 30_000);
    });
  });

  // ═══════════════════════ CancellationCharge ════════════════════════════════
  describe('CancellationCharge', () => {
    async function insertCC(
      overrides: {
        net?: number;
        tax?: number;
        total?: number;
        mode?: string;
      } = {},
    ): Promise<{ id: string; orderId: string }> {
      const orderId = await insertOrder();
      const id = uid();
      await pool.query(
        `INSERT INTO cancellation_charge
           (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
            "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
            "priceTaxMode","roundingMode","reasonCode","accountingDate")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'AED',2,$10,'HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
        [
          id,
          TENANT,
          COMPANY,
          BRANCH,
          orderId,
          `CC-${id.slice(0, 8)}`,
          overrides.net ?? 100,
          overrides.tax ?? 5,
          overrides.total ?? 105,
          overrides.mode ?? 'TAX_EXCLUSIVE',
        ],
      );
      return { id, orderId };
    }

    it('a valid TAX_EXCLUSIVE CancellationCharge commits', async () => {
      await expect(insertCC()).resolves.toBeTruthy();
    });

    it('a valid TAX_INCLUSIVE CancellationCharge commits', async () => {
      await expect(
        insertCC({ net: 95, tax: 5, total: 100, mode: 'TAX_INCLUSIVE' }),
      ).resolves.toBeTruthy();
    });

    it('a mismatched total equation is rejected', async () => {
      await expect(insertCC({ net: 100, tax: 5, total: 106 })).rejects.toThrow(
        /cancellation_charge_total_eq_chk/,
      );
    });

    it('zero total is rejected', async () => {
      await expect(insertCC({ net: 0, tax: 0, total: 0 })).rejects.toThrow(
        /cancellation_charge_total_positive_chk/,
      );
    });

    it('branchId not matching the order origin branch is rejected', async () => {
      const orderId = await insertOrder();
      const otherBranch = uid();
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Other',now())`,
        [otherBranch, TENANT, COMPANY],
      );
      await expect(
        pool.query(
          `INSERT INTO cancellation_charge
             (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
              "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
              "priceTaxMode","roundingMode","reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,$6,100,5,105,'AED',2,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [uid(), TENANT, COMPANY, otherBranch, orderId, `CC-${uid().slice(0, 8)}`],
        ),
      ).rejects.toThrow(/must equal order/);
    });

    it('UPDATE and DELETE are rejected', async () => {
      const { id } = await insertCC();
      await expect(
        pool.query(`UPDATE cancellation_charge SET "reasonCode"='OTHER' WHERE id=$1`, [id]),
      ).rejects.toThrow(/immutable/);
      await expect(pool.query(`DELETE FROM cancellation_charge WHERE id=$1`, [id])).rejects.toThrow(
        /immutable/,
      );
    });

    it('a CANCELLATION_CHARGE-sourced CustomerReceivable links correctly and DocumentNumberCounter accepts the new type', async () => {
      const { id } = await insertCC();
      await pool.query(
        `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber","updatedAt")
         VALUES ($1,$2,'CANCELLATION_CHARGE',1,now()) ON CONFLICT DO NOTHING`,
        [TENANT, COMPANY],
      );
      const recvId = uid();
      await expect(
        pool.query(
          `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","cancellationChargeId","creditAuthorized")
           VALUES ($1,$2,$3,$4,$5,'CANCELLATION_CHARGE',$6,NULL)`,
          [recvId, TENANT, COMPANY, BRANCH, CCA, id],
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ═══════════════════════ Refund / RefundAttempt ════════════════════════════
  describe('Refund + RefundAttempt', () => {
    async function fullSetup(paymentAmount = 1000): Promise<{
      invoiceId: string;
      paymentId: string;
      advanceId: string;
    }> {
      const { lineId, invoiceId } = await insertSimpleInvoice(paymentAmount);
      const { paymentId, allocationId } = await insertPaymentWithAllocation(
        invoiceId,
        paymentAmount,
      );
      const advanceId = uid();
      await insertSimpleCreditNote(
        invoiceId,
        lineId,
        paymentAmount,
        { arReduction: 0, advanceExcess: paymentAmount },
        { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId, advanceId },
      );
      return { invoiceId, paymentId, advanceId };
    }

    async function insertLocalRefund(
      paymentId: string,
      advanceId: string,
      amountMinor: number,
    ): Promise<{ ok: boolean; error?: Error; refundId?: string }> {
      const result = await inTransaction(async (c) => {
        const refundId = uid();
        await c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,$6,'AED',2,'BANK_TRANSFER','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, BRANCH, paymentId, amountMinor],
        );
        await c.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, advanceId, refundId, amountMinor],
        );
        return refundId;
      });
      return result.ok ? { ok: true, refundId: result.value } : { ok: false, error: result.error };
    }

    it('a local Refund with a matching application succeeds', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const r = await insertLocalRefund(paymentId, advanceId, 1000);
      expect(r.ok).toBe(true);
    });

    it('a Refund exceeding Payment capacity is rejected', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const r = await insertLocalRefund(paymentId, advanceId, 1001);
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/refund consumption would exceed/);
    });

    it('a prior Refund of 400 + a new Refund of 600 succeeds (cumulative exactly at Payment capacity)', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const r1 = await insertLocalRefund(paymentId, advanceId, 400);
      expect(r1.ok).toBe(true);
      // the SAME 1000 advance still holds 600 of capacity (only 400 consumed
      // so far via the r1 application) — the remaining 600 succeeds exactly.
      const r2 = await insertLocalRefund(paymentId, advanceId, 600);
      expect(r2.ok).toBe(true);
      // a further +1 against the now fully-consumed Payment is rejected.
      const r3 = await insertLocalRefund(paymentId, advanceId, 1);
      expect(r3.ok).toBe(false);
    });

    it('a Refund with zero applications fails at COMMIT', async () => {
      const { paymentId } = await fullSetup(1000);
      const result = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,500,'AED',2,'BANK_TRANSFER','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [uid(), TENANT, COMPANY, BRANCH, paymentId],
        );
      });
      expect(result.ok).toBe(false);
      expect((result as { error: Error }).error.message).toMatch(
        /customer_advance_refund_application/,
      );
    });

    it('Refund UPDATE/DELETE are rejected', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const { refundId } = await insertLocalRefund(paymentId, advanceId, 1000);
      await expect(
        pool.query(`UPDATE refund SET "reasonCode"='OTHER' WHERE id=$1`, [refundId]),
      ).rejects.toThrow(/immutable/);
      await expect(pool.query(`DELETE FROM refund WHERE id=$1`, [refundId])).rejects.toThrow(
        /immutable/,
      );
    });

    async function insertAttempt(
      paymentId: string,
      advanceId: string,
      amount: number,
    ): Promise<string> {
      const id = uid();
      const result = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,'AED',2,$7,'tap',$8,now())`,
          [id, TENANT, COMPANY, BRANCH, paymentId, amount, CRED, `idem-${id}`],
        );
        await c.query(
          `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,(SELECT id FROM credit_note_coverage_release WHERE "customerAdvanceId"=$6),$6,$7,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, id, advanceId, amount],
        );
      });
      if (!result.ok) throw result.error;
      return id;
    }

    it('a PENDING RefundAttempt with a matching reservation commits', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      await expect(insertAttempt(paymentId, advanceId, 700)).resolves.toBeTruthy();
    });

    it('a second reservation exceeding remaining Payment capacity is rejected', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      await insertAttempt(paymentId, advanceId, 700);
      await expect(insertAttempt(paymentId, advanceId, 301)).rejects.toThrow(
        /refund consumption would exceed/,
      );
    });

    it('converting a PENDING attempt to a successful Refund does not double-count capacity', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const attemptId = await insertAttempt(paymentId, advanceId, 700);
      const result = await inTransaction(async (c) => {
        await c.query(`SELECT id FROM refund_attempt WHERE id=$1 FOR UPDATE`, [attemptId]);
        const refundId = uid();
        await c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","sourceRefundAttemptId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,$6,700,'AED',2,'ONLINE_GATEWAY','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, BRANCH, paymentId, attemptId],
        );
        await c.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,700,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, advanceId, refundId],
        );
        await c.query(
          `UPDATE refund_attempt SET state='SUCCEEDED', "resultingRefundId"=$2 WHERE id=$1`,
          [attemptId, refundId],
        );
        return refundId;
      });
      expect(result.ok).toBe(true);

      // remaining capacity is now 300 (1000 - 700 successful) — a further
      // reservation of 301 must be rejected, 300 must succeed.
      await expect(insertAttempt(paymentId, advanceId, 301)).rejects.toThrow(
        /refund consumption would exceed/,
      );
      await expect(insertAttempt(paymentId, advanceId, 300)).resolves.toBeTruthy();
    });

    it('a FAILED attempt creates no Refund and its reservations remain', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const attemptId = await insertAttempt(paymentId, advanceId, 500);
      await pool.query(`UPDATE refund_attempt SET state='FAILED' WHERE id=$1`, [attemptId]);
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM refund WHERE "sourceRefundAttemptId" = $1`,
        [attemptId],
      );
      expect(rows[0]!.count).toBe('0');
      const { rows: reservationRows } = await pool.query(
        `SELECT id FROM refund_attempt_entitlement_reservation WHERE "refundAttemptId" = $1`,
        [attemptId],
      );
      expect(reservationRows.length).toBe(1);
      // capacity is freed: a fresh 500 reservation now succeeds again.
      await expect(insertAttempt(paymentId, advanceId, 500)).resolves.toBeTruthy();
    });

    it('an illegal RefundAttempt state transition is rejected', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const attemptId = await insertAttempt(paymentId, advanceId, 500);
      await expect(
        pool.query(`UPDATE refund_attempt SET state='SUCCEEDED' WHERE id=$1`, [attemptId]),
      ).rejects.toThrow(/SUCCEEDED requires resultingRefundId/);
    });

    it('a terminal FAILED attempt is immutable', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const attemptId = await insertAttempt(paymentId, advanceId, 500);
      await pool.query(`UPDATE refund_attempt SET state='FAILED' WHERE id=$1`, [attemptId]);
      await expect(
        pool.query(`UPDATE refund_attempt SET state='PENDING' WHERE id=$1`, [attemptId]),
      ).rejects.toThrow(/immutable/);
    });
  });

  // ═══════════════════════ Advance capacity regression (3b.6 + 3b.8) ═════════
  describe('extended fn_lock_and_validate_advance_capacity regression', () => {
    it('existing 2-argument CustomerAdvanceApplication capacity is unchanged', async () => {
      const advId = await insertCreditNoteAdvance(100);
      const { invoiceId } = await freshInvoice();
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
        [recvId, TENANT, COMPANY, BRANCH, CCA, invoiceId],
      );
      await expect(
        pool.query(
          `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,100,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, advId, recvId],
        ),
      ).resolves.toBeTruthy();
      // a further +1 against the same (now fully-consumed) 100 advance is rejected.
      await expect(
        pool.query(
          `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,1,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, advId, recvId],
        ),
      ).rejects.toThrow(/would exceed amountMinor/);
    });

    it('combined capacity: application + refund application + pending reservation cannot exceed amountMinor', async () => {
      const { lineId: lineId2, invoiceId: invoiceId2 } = await insertSimpleInvoice(1890);
      // FINAL INTEGRITY PROOF PASS — the PaymentAllocation funding this
      // CreditNote's release must belong to the SAME Invoice the CreditNote
      // itself targets (§1); this test's actual point is the combined
      // application+refund-application+reservation capacity ceiling further
      // below, so the allocation is deliberately on invoiceId2 too.
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId2, 100);
      const advId = uid();
      await insertSimpleCreditNote(
        invoiceId2,
        lineId2,
        1890,
        { arReduction: 1790, advanceExcess: 100 },
        { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId, advanceId: advId },
      );
      // The advance application below targets a SEPARATE, still-open invoice —
      // never `invoiceId2` itself: after the Integration Closure's corrected
      // `fn_lock_and_validate_invoice_coverage` (a CreditNote's AR reduction is
      // part of an invoice's coverage) the credit-noted `invoiceId2` is fully
      // covered (allocation 100 + arReduction 1790 = 1890) and can no longer
      // receive ANY application. This test's point is the advance's combined
      // capacity ceiling, which is independent of the target invoice.
      const { invoiceId: openTargetInvoiceId } = await insertSimpleInvoice(1890);
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
        [recvId, TENANT, COMPANY, BRANCH, CCA, openTargetInvoiceId],
      );
      // 40 via CustomerAdvanceApplication + 30 via CustomerAdvanceRefundApplication (needs a Refund row)
      await pool.query(
        `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,40,'AED',2)`,
        [uid(), TENANT, COMPANY, BRANCH, advId, recvId],
      );
      const refundId = uid();
      const refundResult = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,30,'AED',2,'BANK_TRANSFER','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, BRANCH, paymentId],
        );
        await c.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,30,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, advId, refundId],
        );
      });
      if (!refundResult.ok) throw refundResult.error;
      // +30 PENDING reservation via a RefundAttempt = 100 total, exact capacity.
      const releaseId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM credit_note_coverage_release WHERE "customerAdvanceId" = $1`,
          [advId],
        )
      ).rows[0]!.id;
      const attemptId = uid();
      const attemptResult = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
           VALUES ($1,$2,$3,$4,$5,30,'AED',2,$6,'tap',$7,now())`,
          [attemptId, TENANT, COMPANY, BRANCH, paymentId, CRED, `idem-${attemptId}`],
        );
        await c.query(
          `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,30,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, attemptId, releaseId, advId],
        );
      });
      expect(attemptResult.ok).toBe(true);

      // any further +1 must be rejected (40+30+30=100, exact capacity reached).
      const attempt2 = uid();
      const attempt2Result = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
           VALUES ($1,$2,$3,$4,$5,1,'AED',2,$6,'tap',$7,now())`,
          [attempt2, TENANT, COMPANY, BRANCH, paymentId, CRED, `idem-${attempt2}`],
        );
        await c.query(
          `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, attempt2, releaseId, advId],
        );
      });
      expect(attempt2Result.ok).toBe(false);
      expect((attempt2Result as { error: Error }).error.message).toMatch(
        /would exceed amountMinor/,
      );
    });
  });

  // ═══════════════════════ CustomerAccountEntry extension ════════════════════
  describe('CustomerAccountEntry new kinds', () => {
    it('CREDIT_NOTE entry with only creditNoteId populated succeeds', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const cnId = await insertCreditNoteWithLine(invoiceId, lineId);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","creditNoteId")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA, cnId],
        ),
      ).resolves.toBeTruthy();
    });

    it('a CREDIT_NOTE entry populating a second reference column is rejected', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const cnId = await insertCreditNoteWithLine(invoiceId, lineId);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","creditNoteId","paymentId")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,$7)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA, cnId, uid()],
        ),
      ).rejects.toThrow(/customer_account_entry_reference_xor_chk/);
    });

    it('a REFUND entry requires customerAdvanceRefundApplicationId only, and cross-checks it exists', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 1890);
      const advId = uid();
      await insertCreditNoteWithLine(
        invoiceId,
        lineId,
        { arReduction: 0, advanceExcess: 1890 },
        {},
        { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId, advanceId: advId },
      );
      const refundId = uid();
      const applicationId = uid();
      const refundResult = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,1890,'AED',2,'BANK_TRANSFER','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, BRANCH, paymentId],
        );
        await c.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,1890,'AED',2)`,
          [applicationId, TENANT, COMPANY, BRANCH, advId, refundId],
        );
      });
      expect(refundResult.ok).toBe(true);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerAdvanceRefundApplicationId")
           VALUES ($1,$2,$3,$4,$5,'REFUND',$6)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA, applicationId],
        ),
      ).resolves.toBeTruthy();
    });

    it('a CREDIT_NOTE-sourced CustomerAdvance is still accepted by entryKind=ADVANCE (widened check)', async () => {
      const advId = await insertCreditNoteAdvance(250);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerAdvanceId")
           VALUES ($1,$2,$3,$4,$5,'ADVANCE',$6)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA, advId],
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ═══════════════════════ ProviderRefundEvent ═══════════════════════════════
  describe('ProviderRefundEvent', () => {
    it('duplicate (providerCredentialId, providerEventId) is rejected', async () => {
      const row = {
        id: uid(),
        eventId: `evt-${uid()}`,
      };
      await pool.query(
        `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash1', now())`,
        [row.id, TENANT, COMPANY, BRANCH, CRED, row.eventId],
      );
      await expect(
        pool.query(
          `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash2', now())`,
          [uid(), TENANT, COMPANY, BRANCH, CRED, row.eventId],
        ),
      ).rejects.toThrow(/provider_refund_event_providerCredentialId_providerEventId_key/);
    });

    it('RECEIVED -> PROCESSED is a valid transition; a terminal event is then immutable', async () => {
      const id = uid();
      await pool.query(
        `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash3', now())`,
        [id, TENANT, COMPANY, BRANCH, CRED, `evt-${uid()}`],
      );
      await expect(
        pool.query(`UPDATE provider_refund_event SET status='PROCESSED' WHERE id=$1`, [id]),
      ).resolves.toBeTruthy();
      await expect(
        pool.query(`UPDATE provider_refund_event SET status='RECEIVED' WHERE id=$1`, [id]),
      ).rejects.toThrow(/immutable/);
    });
  });

  // ═══════════════════════ RLS ════════════════════════════════════════════════
  describe('RLS cross-tenant isolation', () => {
    it('credit_note rows are invisible across tenants under RLS', async () => {
      const { lineId, invoiceId } = await freshInvoice();
      const cnId = await insertCreditNoteWithLine(invoiceId, lineId);
      const client = await pool.connect();
      try {
        await client.query('SET ROLE flower_app');
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [OTHER_TENANT]);
        const { rows } = await client.query(`SELECT id FROM credit_note WHERE id = $1`, [cnId]);
        expect(rows.length).toBe(0);
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
        const { rows: ownRows } = await client.query(`SELECT id FROM credit_note WHERE id = $1`, [
          cnId,
        ]);
        expect(ownRows.length).toBe(1);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });

    it('refund rows are invisible across tenants under RLS', async () => {
      const { paymentId, advanceId } = await fullSetup(1000);
      const r = await insertLocalRefund(paymentId, advanceId, 1000);
      const client = await pool.connect();
      try {
        await client.query('SET ROLE flower_app');
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [OTHER_TENANT]);
        const { rows } = await client.query(`SELECT id FROM refund WHERE id = $1`, [r.refundId]);
        expect(rows.length).toBe(0);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });

    async function fullSetup(paymentAmount = 1000): Promise<{
      invoiceId: string;
      paymentId: string;
      advanceId: string;
    }> {
      const { lineId, invoiceId } = await insertSimpleInvoice(paymentAmount);
      const { paymentId, allocationId } = await insertPaymentWithAllocation(
        invoiceId,
        paymentAmount,
      );
      const advanceId = uid();
      await insertSimpleCreditNote(
        invoiceId,
        lineId,
        paymentAmount,
        { arReduction: 0, advanceExcess: paymentAmount },
        { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId, advanceId },
      );
      return { invoiceId, paymentId, advanceId };
    }

    async function insertLocalRefund(
      paymentId: string,
      advanceId: string,
      amountMinor: number,
    ): Promise<{ ok: boolean; refundId?: string }> {
      const result = await inTransaction(async (c) => {
        const refundId = uid();
        await c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,$6,'AED',2,'BANK_TRANSFER','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, BRANCH, paymentId, amountMinor],
        );
        await c.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, advanceId, refundId, amountMinor],
        );
        return refundId;
      });
      return result.ok ? { ok: true, refundId: result.value } : { ok: false };
    }
  });

  // ═══════════ Task 3b.8 INTEGRATION CLOSURE — DB backstops ═══════════════════
  // Migration `20261007120000_phase_3b8_integration_closure`. Two frozen-3b.6
  // backstop functions predate the 3b.8 financial artifacts and silently
  // mishandle them:
  //   - `fn_check_customer_receivable_payment_application_integrity` rejects
  //     every non-OPENING target, so a receipt could never settle a
  //     CANCELLATION_CHARGE receivable;
  //   - `fn_lock_and_validate_opening_receivable_coverage` reads the principal
  //     from `openingAmountMinor`, which is NULL for a CANCELLATION_CHARGE
  //     receivable — `covered + proposed > NULL` is NULL, never true, so an
  //     advance application over a charge receivable had NO DB capacity
  //     backstop at all;
  //   - `fn_lock_and_validate_invoice_coverage` ignores a CreditNote's
  //     `arReductionMinor`, so a fully AR-reversed invoice still accepted new
  //     allocations/applications up to its nominal total.
  describe('integration closure: CANCELLATION_CHARGE settlement + credit-note-aware invoice coverage', () => {
    /** fresh customer/CCA + its CANCELLATION_CHARGE receivable of `totalMinor`
     *  (TAX_EXCLUSIVE, tax 5, net = total - 5 — satisfies `total = net + tax`). */
    async function chargeReceivableOf(
      totalMinor: number,
    ): Promise<{ ccaId: string; customerId: string; receivableId: string }> {
      const { ccaId, customerId } = await freshCustomerCompanyAccount();
      const orderId = await insertOrder(customerId);
      const ccId = uid();
      await pool.query(
        `INSERT INTO cancellation_charge
           (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
            "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
            "priceTaxMode","roundingMode","reasonCode","accountingDate")
         VALUES ($1,$2,$3,$4,$5,$6,$7,5,$8,'AED',2,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
        [
          ccId,
          TENANT,
          COMPANY,
          BRANCH,
          orderId,
          `CC-${ccId.slice(0, 8)}`,
          totalMinor - 5,
          totalMinor,
        ],
      );
      const receivableId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","cancellationChargeId")
         VALUES ($1,$2,$3,$4,$5,'CANCELLATION_CHARGE',$6)`,
        [receivableId, TENANT, COMPANY, BRANCH, ccaId, ccId],
      );
      return { ccaId, customerId, receivableId };
    }

    /** a captured CUSTOMER_RECEIPT Payment attributed to a GIVEN account, in a GIVEN branch. */
    async function receiptPaymentOf(
      ccaId: string,
      amountMinor: number,
      branchId = BRANCH,
    ): Promise<string> {
      const attemptId = uid();
      await pool.query(
        `INSERT INTO payment_attempt
           (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
            method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
         VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'BANK_TRANSFER',$6,'AED',2,'CAPTURED',$7, now())`,
        [attemptId, TENANT, COMPANY, branchId, ccaId, amountMinor, `idem-${attemptId}`],
      );
      const paymentId = uid();
      await pool.query(
        `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
        [paymentId, TENANT, COMPANY, branchId, attemptId, amountMinor],
      );
      return paymentId;
    }

    /** inserts one `customer_receivable_payment_application` and resolves with
     *  its id (so a test can reference it from a chronology entry). */
    const applyPayment = async (
      ccaId: string,
      paymentId: string,
      receivableId: string,
      amountMinor: number,
      branchId = BRANCH,
    ): Promise<string> => {
      const id = uid();
      await pool.query(
        `INSERT INTO customer_receivable_payment_application
           (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AED',2)`,
        [id, TENANT, COMPANY, branchId, ccaId, paymentId, receivableId, amountMinor],
      );
      return id;
    };

    /** a CREDIT_NOTE-sourced advance of `advanceMinor` + an application of
     *  `appliedMinor` of it against `receivableId` (rejects if the DB does). */
    async function applyCreditNoteAdvance(
      ccaId: string,
      receivableId: string,
      advanceMinor: number,
      appliedMinor: number,
    ) {
      const advanceId = uid();
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
        [advanceId, TENANT, COMPANY, BRANCH, ccaId, advanceMinor],
      );
      return pool.query(
        `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
        [uid(), TENANT, COMPANY, BRANCH, advanceId, receivableId, appliedMinor],
      );
    }

    it('T1: a CUSTOMER_RECEIPT Payment can be applied to a CANCELLATION_CHARGE receivable (the non-invoice payment-application target is generalized beyond OPENING)', async () => {
      const { ccaId, receivableId } = await chargeReceivableOf(105);
      const paymentId = await receiptPaymentOf(ccaId, 105);
      await expect(applyPayment(ccaId, paymentId, receivableId, 100)).resolves.toBeTruthy();
    });

    it('T2: payment applications and advance applications SHARE one capacity ceiling — the charge total — and the exact remainder fits', async () => {
      const { ccaId, receivableId } = await chargeReceivableOf(105);
      const paymentId = await receiptPaymentOf(ccaId, 105);
      await applyPayment(ccaId, paymentId, receivableId, 60);
      await applyCreditNoteAdvance(ccaId, receivableId, 45, 45); // 60 + 45 = 105 exactly
      await expect(applyPayment(ccaId, paymentId, receivableId, 1)).rejects.toThrow(
        /CANCELLATION_CHARGE.*coverage would exceed/,
      );
    });

    it('T3: an advance application over a CANCELLATION_CHARGE receivable is capacity-checked by the DB (no silent NULL-principal hole)', async () => {
      const { ccaId, receivableId } = await chargeReceivableOf(105);
      await expect(applyCreditNoteAdvance(ccaId, receivableId, 106, 106)).rejects.toThrow(
        /CANCELLATION_CHARGE.*coverage would exceed/,
      );
      await expect(applyCreditNoteAdvance(ccaId, receivableId, 105, 105)).resolves.toBeTruthy();
    });

    it('T4 (control): an INVOICE-sourced target is still unconditionally rejected for a payment application', async () => {
      const { ccaId, customerId } = await freshCustomerCompanyAccount();
      const { invoiceId } = await insertSimpleInvoice(1000, customerId);
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
        [recvId, TENANT, COMPANY, BRANCH, ccaId, invoiceId],
      );
      const paymentId = await receiptPaymentOf(ccaId, 500);
      await expect(applyPayment(ccaId, paymentId, recvId, 100)).rejects.toThrow(
        /is not OPENING-sourced/,
      );
    });

    it("T5: a payment application whose account differs from the charge receivable's own account is rejected", async () => {
      const { receivableId } = await chargeReceivableOf(105);
      const other = await freshCustomerCompanyAccount();
      const paymentId = await receiptPaymentOf(other.ccaId, 105);
      await expect(applyPayment(other.ccaId, paymentId, receivableId, 100)).rejects.toThrow(
        /customerCompanyAccountId does not match customerReceivable/,
      );
    });

    it("T6: a Payment recorded in another branch can never settle this branch's charge receivable", async () => {
      const { ccaId, receivableId } = await chargeReceivableOf(105);
      const otherBranch = uid();
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Closure Other',now())`,
        [otherBranch, TENANT, COMPANY],
      );
      const paymentId = await receiptPaymentOf(ccaId, 105, otherBranch);
      await expect(applyPayment(ccaId, paymentId, receivableId, 100, otherBranch)).rejects.toThrow(
        /scope does not match customerReceivable/,
      );
    });

    it("T7: a CreditNote's AR reduction closes the invoice — a later allocation is rejected by the DB backstop", async () => {
      const { lineId, invoiceId } = await insertSimpleInvoice(2000);
      await insertSimpleCreditNote(invoiceId, lineId, 2000, {
        arReduction: 2000,
        advanceExcess: 0,
      });
      await expect(insertPaymentWithAllocation(invoiceId, 500)).rejects.toThrow(
        /coverage would exceed totalAmountMinor/,
      );
    });

    it('T8: partly paid then credit-noted (allocation 800 + arReduction 1200): not even 1 more can be allocated; an advance application is rejected too', async () => {
      const { lineId, invoiceId } = await insertSimpleInvoice(2000);
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 800);
      await insertSimpleCreditNote(
        invoiceId,
        lineId,
        2000,
        { arReduction: 1200, advanceExcess: 800 },
        { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId },
      );
      await expect(insertPaymentWithAllocation(invoiceId, 1)).rejects.toThrow(
        /coverage would exceed totalAmountMinor/,
      );
      // an advance application targeting that invoice's own receivable (the
      // invoice belongs to the shared CUSTOMER / CCA fixture)
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
        [recvId, TENANT, COMPANY, BRANCH, CCA, invoiceId],
      );
      await expect(applyCreditNoteAdvance(CCA, recvId, 100, 1)).rejects.toThrow(
        /coverage would exceed totalAmountMinor/,
      );
    });

    it('T9 (control): an invoice with NO CreditNote still accepts allocations up to its total and rejects total + 1', async () => {
      const { invoiceId } = await insertSimpleInvoice(2000);
      await expect(insertPaymentWithAllocation(invoiceId, 2000)).resolves.toBeTruthy();
      await expect(insertPaymentWithAllocation(invoiceId, 1)).rejects.toThrow(
        /coverage would exceed totalAmountMinor/,
      );
    });

    // ═════ the CANCELLATION_CHARGE_PAYMENT_APPLIED chronology kind ═══════════
    // The legacy `OPENING_RECEIVABLE_PAYMENT_APPLIED` is FROZEN for opening-
    // receivable payment history: a Payment applied to a CancellationCharge
    // receivable is recorded with its OWN kind, and the DB structurally keeps
    // the two apart (kind <-> target receivable sourceType).
    const insertEntry = (
      kind: string,
      ccaId: string,
      applicationId: string,
      extra: { column: string; value: string } | null = null,
    ) =>
      pool.query(
        `INSERT INTO customer_account_entry
           (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivablePaymentApplicationId"${extra ? `,"${extra.column}"` : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7${extra ? ',$8' : ''})`,
        [
          uid(),
          TENANT,
          COMPANY,
          BRANCH,
          ccaId,
          kind,
          applicationId,
          ...(extra ? [extra.value] : []),
        ],
      );

    /** a fresh account + its OPENING receivable (claims the account's F9
     *  opening slot, hence the fresh account) + a receipt applied to it. */
    async function openingApplicationOf(
      amountMinor: number,
    ): Promise<{ ccaId: string; applicationId: string }> {
      const { ccaId } = await freshCustomerCompanyAccount();
      const receivableId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
        [receivableId, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
      );
      const paymentId = await receiptPaymentOf(ccaId, amountMinor);
      const applicationId = await applyPayment(ccaId, paymentId, receivableId, amountMinor);
      return { ccaId, applicationId };
    }

    async function chargeApplicationOf(
      totalMinor: number,
    ): Promise<{ ccaId: string; applicationId: string }> {
      const { ccaId, receivableId } = await chargeReceivableOf(totalMinor);
      const paymentId = await receiptPaymentOf(ccaId, totalMinor);
      const applicationId = await applyPayment(ccaId, paymentId, receivableId, totalMinor);
      return { ccaId, applicationId };
    }

    it('T10: a CANCELLATION_CHARGE_PAYMENT_APPLIED entry referencing a payment application on a CANCELLATION_CHARGE receivable is accepted', async () => {
      const { ccaId, applicationId } = await chargeApplicationOf(105);
      await expect(
        insertEntry('CANCELLATION_CHARGE_PAYMENT_APPLIED', ccaId, applicationId),
      ).resolves.toBeTruthy();
    });

    it('T11: the legacy OPENING_RECEIVABLE_PAYMENT_APPLIED entry on an OPENING-receivable application is still accepted — unchanged', async () => {
      const { ccaId, applicationId } = await openingApplicationOf(100);
      await expect(
        insertEntry('OPENING_RECEIVABLE_PAYMENT_APPLIED', ccaId, applicationId),
      ).resolves.toBeTruthy();
    });

    it('T12: the legacy OPENING_RECEIVABLE_PAYMENT_APPLIED kind can NEVER record a payment applied to a CANCELLATION_CHARGE receivable', async () => {
      const { ccaId, applicationId } = await chargeApplicationOf(105);
      await expect(
        insertEntry('OPENING_RECEIVABLE_PAYMENT_APPLIED', ccaId, applicationId),
      ).rejects.toThrow(/OPENING_RECEIVABLE_PAYMENT_APPLIED requires .*OPENING/);
    });

    it('T13: CANCELLATION_CHARGE_PAYMENT_APPLIED can NEVER record a payment applied to an OPENING receivable', async () => {
      const { ccaId, applicationId } = await openingApplicationOf(100);
      await expect(
        insertEntry('CANCELLATION_CHARGE_PAYMENT_APPLIED', ccaId, applicationId),
      ).rejects.toThrow(/CANCELLATION_CHARGE_PAYMENT_APPLIED requires .*CANCELLATION_CHARGE/);
    });

    it('T14: a CANCELLATION_CHARGE_PAYMENT_APPLIED entry populating a second reference column is rejected (same exactly-one-reference rule)', async () => {
      const { ccaId, applicationId } = await chargeApplicationOf(105);
      await expect(
        insertEntry('CANCELLATION_CHARGE_PAYMENT_APPLIED', ccaId, applicationId, {
          column: 'paymentId',
          value: uid(),
        }),
      ).rejects.toThrow(/customer_account_entry_reference_xor_chk/);
    });

    it('T15: a CANCELLATION_CHARGE_PAYMENT_APPLIED entry with NO application reference is rejected', async () => {
      const { ccaId } = await chargeApplicationOf(105);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind")
           VALUES ($1,$2,$3,$4,$5,'CANCELLATION_CHARGE_PAYMENT_APPLIED')`,
          [uid(), TENANT, COMPANY, BRANCH, ccaId],
        ),
      ).rejects.toThrow(/customer_account_entry_reference_xor_chk/);
    });

    it('T16: the entry-kind vocabulary stays CLOSED — an unlisted kind is still rejected', async () => {
      const { ccaId, applicationId } = await chargeApplicationOf(105);
      await expect(insertEntry('WRITE_OFF', ccaId, applicationId)).rejects.toThrow(
        /customer_account_entry_kind_chk/,
      );
    });
  });

  // ═══════════ Task 3b.8 HARD GATE — immutability, scope integrity and RLS of every 3b.8 table ═══════════
  // HG12 / HG13 / HG4. Every assertion is made BOTH as the privileged connection and as the real
  // application role (`flower_app`, NOBYPASSRLS) holding the owning tenant's GUC, because the application role
  // has DELETE/UPDATE privilege on all nine tables — only a trigger can stop it.
  describe('Task 3b.8 HARD GATE — immutability, scope integrity and RLS of every 3b.8 table', () => {
    const NINE = [
      'credit_note',
      'credit_note_line',
      'credit_note_coverage_release',
      'cancellation_charge',
      'refund',
      'refund_attempt',
      'refund_attempt_entitlement_reservation',
      'customer_advance_refund_application',
      'provider_refund_event',
    ] as const;

    interface Chain {
      invoiceId: string;
      orderId: string;
      paymentId: string;
      allocationId: string;
      advanceId: string;
      creditNoteId: string;
      creditNoteLineId: string;
      releaseId: string;
      refundId: string;
      applicationId: string;
      attemptId: string;
      reservationId: string;
      eventId: string;
      chargeId: string;
    }

    /** ONE row in each of the nine tables, all in TENANT / COMPANY / BRANCH */
    async function chain(): Promise<Chain> {
      const { orderId, lineId, invoiceId } = await insertSimpleInvoice(2000);
      const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, 1000);
      const advanceId = uid();
      const creditNoteId = await insertSimpleCreditNote(
        invoiceId,
        lineId,
        2000,
        { arReduction: 1000, advanceExcess: 1000 },
        { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId, advanceId },
      );
      const one = async (sql: string, params: unknown[]): Promise<string> =>
        String((await pool.query(sql, params)).rows[0].id);
      const creditNoteLineId = await one(
        `SELECT id FROM credit_note_line WHERE "creditNoteId" = $1`,
        [creditNoteId],
      );
      const releaseId = await one(
        `SELECT id FROM credit_note_coverage_release WHERE "customerAdvanceId" = $1`,
        [advanceId],
      );

      const refundId = uid();
      const applicationId = uid();
      const r = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,300,'AED',2,'BANK_TRANSFER','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, BRANCH, paymentId],
        );
        await c.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,300,'AED',2)`,
          [applicationId, TENANT, COMPANY, BRANCH, advanceId, refundId],
        );
      });
      if (!r.ok) throw r.error;

      const attemptId = uid();
      const reservationId = uid();
      const a = await inTransaction(async (c) => {
        await c.query(
          `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
           VALUES ($1,$2,$3,$4,$5,400,'AED',2,$6,'tap',$7,now())`,
          [attemptId, TENANT, COMPANY, BRANCH, paymentId, CRED, `idem-${attemptId}`],
        );
        await c.query(
          `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,400,'AED',2)`,
          [reservationId, TENANT, COMPANY, BRANCH, attemptId, releaseId, advanceId],
        );
      });
      if (!a.ok) throw a.error;

      const eventId = uid();
      await pool.query(
        `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-hg',now())`,
        [eventId, TENANT, COMPANY, BRANCH, CRED, `evt-${eventId}`],
      );

      const chargeOrderId = await insertOrder();
      const chargeId = uid();
      await pool.query(
        `INSERT INTO cancellation_charge
           (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
            "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
            "priceTaxMode","roundingMode","reasonCode","accountingDate")
         VALUES ($1,$2,$3,$4,$5,$6,100,5,105,'AED',2,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
        [chargeId, TENANT, COMPANY, BRANCH, chargeOrderId, `CC-${chargeId.slice(0, 8)}`],
      );
      return {
        invoiceId,
        orderId,
        paymentId,
        allocationId,
        advanceId,
        creditNoteId,
        creditNoteLineId,
        releaseId,
        refundId,
        applicationId,
        attemptId,
        reservationId,
        eventId,
        chargeId,
      };
    }

    /** a session of the REAL application role holding the given tenant GUC (or none); always rolled back */
    async function asApp<R>(
      tenant: string | null,
      fn: (c: pg.PoolClient) => Promise<R>,
    ): Promise<R> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE flower_app');
        if (tenant) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    /** run one statement as the app role; report the error message (or null) and rows affected */
    async function tryAsApp(
      tenant: string | null,
      sql: string,
      params: unknown[] = [],
    ): Promise<{ error: string | null; rowCount: number }> {
      return asApp(tenant, async (c) => {
        try {
          const r = await c.query(sql, params);
          return { error: null, rowCount: r.rowCount ?? 0 };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e), rowCount: 0 };
        }
      });
    }
    const tryAsSuper = async (
      sql: string,
      params: unknown[] = [],
    ): Promise<{ error: string | null; rowCount: number }> => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await c.query(sql, params);
        return { error: null, rowCount: r.rowCount ?? 0 };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e), rowCount: 0 };
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    const exists = async (table: string, id: string): Promise<boolean> =>
      (await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

    // ───────────── HG12 — the strictly immutable tables: UPDATE and DELETE are refused for EVERY role ─────────────
    it('HG12-a: credit_note, credit_note_line, credit_note_coverage_release, cancellation_charge, refund, customer_advance_refund_application and refund_attempt_entitlement_reservation refuse UPDATE and DELETE — for the privileged connection AND for the application role', async () => {
      const c = await chain();
      const targets: [string, string, string][] = [
        ['credit_note', c.creditNoteId, '"reasonCode" = \'OTHER\''],
        ['credit_note_line', c.creditNoteLineId, '"quantityCredited" = "quantityCredited"'],
        [
          'credit_note_coverage_release',
          c.releaseId,
          '"releasedAmountMinor" = "releasedAmountMinor"',
        ],
        ['cancellation_charge', c.chargeId, '"reasonCode" = \'OTHER\''],
        ['refund', c.refundId, '"reasonCode" = \'OTHER\''],
        ['customer_advance_refund_application', c.applicationId, '"amountMinor" = "amountMinor"'],
        [
          'refund_attempt_entitlement_reservation',
          c.reservationId,
          '"amountMinor" = "amountMinor"',
        ],
      ];
      for (const [table, id, set] of targets) {
        for (const [who, run] of [
          ['privileged', (q: string) => tryAsSuper(q, [id])],
          ['flower_app', (q: string) => tryAsApp(TENANT, q, [id])],
        ] as const) {
          const upd = await run(`UPDATE ${table} SET ${set} WHERE id = $1`);
          expect(upd.error, `${who}: UPDATE ${table}`).toMatch(/immutable|never permitted/);
          const del = await run(`DELETE FROM ${table} WHERE id = $1`);
          expect(del.error, `${who}: DELETE ${table}`).toMatch(/immutable|never permitted/);
          expect(await exists(table, id), `${table} row survives`).toBe(true);
        }
      }
    });

    it('HG12-b: a RefundAttempt keeps every identity/amount column immutable, its terminal state frozen, and cannot be DELETEd (its reservation pins it) — for both roles', async () => {
      const c = await chain();
      for (const [who, run] of [
        ['privileged', (q: string) => tryAsSuper(q, [c.attemptId])],
        ['flower_app', (q: string) => tryAsApp(TENANT, q, [c.attemptId])],
      ] as const) {
        const amount = await run(
          `UPDATE refund_attempt SET "requestedAmountMinor" = 1 WHERE id = $1`,
        );
        expect(amount.error, `${who}: amount`).toMatch(/only state\/providerReference/);
        const scope = await run(`UPDATE refund_attempt SET "idempotencyKey" = 'x' WHERE id = $1`);
        expect(scope.error, `${who}: idempotencyKey`).toMatch(/only state\/providerReference/);
        const del = await run(`DELETE FROM refund_attempt WHERE id = $1`);
        expect(del.error, `${who}: DELETE refund_attempt`).toMatch(
          /foreign key|immutable|never permitted/,
        );
        expect(await exists('refund_attempt', c.attemptId)).toBe(true);
      }
      // terminal FAILED is frozen
      await pool.query(`UPDATE refund_attempt SET state = 'FAILED' WHERE id = $1`, [c.attemptId]);
      const back = await tryAsApp(
        TENANT,
        `UPDATE refund_attempt SET state = 'PENDING' WHERE id = $1`,
        [c.attemptId],
      );
      expect(back.error).toMatch(/immutable/);
    });

    it('HG12-c: ProviderRefundEvent — the dedup identity and payload are immutable, a terminal status is frozen, and a duplicate (credential, event id) is refused — for both roles', async () => {
      const c = await chain();
      for (const [who, run] of [
        ['privileged', (q: string, p: unknown[]) => tryAsSuper(q, p)],
        ['flower_app', (q: string, p: unknown[]) => tryAsApp(TENANT, q, p)],
      ] as const) {
        for (const col of [
          '"providerEventId" = \'other\'',
          '"providerCredentialId" = \'' + uid() + "'",
          '"payloadHash" = \'tampered\'',
          '"eventType" = \'refund.failed\'',
        ]) {
          const r = await run(`UPDATE provider_refund_event SET ${col} WHERE id = $1`, [c.eventId]);
          expect(r.error, `${who}: ${col}`).toMatch(/only status\/updatedAt may change/);
        }
        const dup = await run(
          `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-dup',now())`,
          [uid(), TENANT, COMPANY, BRANCH, CRED, `evt-${c.eventId}`],
        );
        expect(dup.error, `${who}: duplicate`).toMatch(
          /provider_refund_event_providerCredentialId_providerEventId_key|row-level security/,
        );
      }
      await pool.query(`UPDATE provider_refund_event SET status = 'EXCEPTION' WHERE id = $1`, [
        c.eventId,
      ]);
      const flip = await tryAsApp(
        TENANT,
        `UPDATE provider_refund_event SET status = 'PROCESSED' WHERE id = $1`,
        [c.eventId],
      );
      expect(flip.error).toMatch(/terminal status .* is immutable/);
    });

    // ───────────── HG12 — parity with the ProviderPaymentEvent precedent the schema says it MIRRORS ─────────────
    // ProviderRefundEvent "mirrors ProviderPaymentEvent's exact shape/guarantees" (schema doc). The payment
    // event has FOUR DB guarantees: a credential-scope check, an initial-status check, a transition guard and a
    // never-DELETE guard. The refund event has only the transition guard.
    it('HG12-d (DEFECT D-B1): a ProviderRefundEvent can never be DELETEd — its (credential, event id) dedup identity is permanent, exactly like provider_payment_event — for both roles', async () => {
      for (const [who, run] of [
        ['privileged', (q: string, p: unknown[]) => tryAsSuper(q, p)],
        ['flower_app', (q: string, p: unknown[]) => tryAsApp(TENANT, q, p)],
      ] as const) {
        const c = await chain();
        const del = await run(`DELETE FROM provider_refund_event WHERE id = $1`, [c.eventId]);
        expect(
          del.error ?? 'NOT REFUSED - the DELETE succeeded',
          `${who}: DELETE provider_refund_event must be refused`,
        ).toMatch(/never permitted|immutable/);
        expect(await exists('provider_refund_event', c.eventId)).toBe(true);
      }
    });

    it('HG12-e (DEFECT D-B2): a ProviderRefundEvent must be INSERTed as RECEIVED — a pre-terminal row would skip the RECEIVED -> PROCESSED|EXCEPTION lifecycle (parity with provider_payment_event)', async () => {
      for (const status of ['PROCESSED', 'EXCEPTION']) {
        const r = await tryAsSuper(
          `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","status","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-init',$7,now())`,
          [uid(), TENANT, COMPANY, BRANCH, CRED, `evt-init-${uid()}`, status],
        );
        expect(
          r.error ?? 'NOT REFUSED - the pre-terminal INSERT succeeded',
          `initial status ${status}`,
        ).toMatch(/initial status must be RECEIVED/);
      }
    });

    it("HG12-f (DEFECT D-B3): a ProviderRefundEvent must carry EXACTLY its credential's tenant/company/branch — a sibling-branch row, or a row of ANOTHER tenant pointing at this tenant's credential, is refused (parity with provider_payment_event; the FK alone is not scope-aware)", async () => {
      const otherBranch = uid();
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'HG sibling',now())`,
        [otherBranch, TENANT, COMPANY],
      );
      const sibling = await tryAsSuper(
        `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-scope',now())`,
        [uid(), TENANT, COMPANY, otherBranch, CRED, `evt-scope-${uid()}`],
      );
      expect(
        sibling.error ?? 'NOT REFUSED - the sibling-branch INSERT succeeded',
        "sibling branch vs the credential's branch",
      ).toMatch(/scope does not match/);

      const otherCompany = uid();
      const otherTenantBranch = uid();
      await pool.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt") VALUES ($1,$2,'Other Tenant Co','AED','Asia/Dubai',now())`,
        [otherCompany, OTHER_TENANT],
      );
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Other Tenant Branch',now())`,
        [otherTenantBranch, OTHER_TENANT, otherCompany],
      );
      const crossTenant = await tryAsSuper(
        `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-xt',now())`,
        [uid(), OTHER_TENANT, otherCompany, otherTenantBranch, CRED, `evt-xt-${uid()}`],
      );
      expect(
        crossTenant.error ?? 'NOT REFUSED - the cross-tenant INSERT succeeded',
        "another tenant pointing at this tenant's credential",
      ).toMatch(/scope does not match|must be branch-scoped/);
    });

    // ───────────── HG12 — scope integrity of a Refund and its application (raw malformed INSERTs fail closed) ───────
    it('HG12-g (DEFECT D-B4): a Refund — and the advance application it consumes — must live in the SAME branch as its source Payment and Advance; a raw insert stamped with a sibling branch fails closed (the application layer already refuses it; the DB must too)', async () => {
      const c = await chain();
      const otherBranch = uid();
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'HG refund sibling',now())`,
        [otherBranch, TENANT, COMPANY],
      );
      const r = await inTransaction(async (cl) => {
        const refundId = uid();
        await cl.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,100,'AED',2,'CASH','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, otherBranch, c.paymentId],
        );
        await cl.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,100,'AED',2)`,
          [uid(), TENANT, COMPANY, otherBranch, c.advanceId, refundId],
        );
        return refundId;
      });
      expect(
        r.ok,
        'a cross-branch refund of a branch-A payment/advance must be refused by the database',
      ).toBe(false);
      expect((r as { error: Error }).error.message).toMatch(/scope|branch/i);
    });

    // ═══════════ MIGRATION 48 — owner-approved closure of D-B1 … D-B4, written TEST-FIRST ═══════════
    // Every case below is RAW SQL on the privileged connection (so RLS can never be what refuses it) unless the
    // title says `flower_app`. The refusing layer is the trigger itself; RLS stays an additional layer.
    //   RED  = refused only by a trigger migration 48 adds / extends   (accepted by the pre-48 schema)
    //   KEEP = refused by a pre-existing guard that migration 48 must leave exactly as it is
    describe('migration 48 — provider_refund_event guards + refund-side scope integrity (D-B1 … D-B4)', () => {
      type Kind = 'branch' | 'company' | 'tenant';
      interface Scope {
        tenantId: string;
        companyId: string;
        branchId: string;
      }
      interface Foreign extends Scope {
        ccaId: string;
        credId: string;
      }
      type Txn = { ok: true; value: unknown } | { ok: false; error: Error };
      const KINDS: readonly Kind[] = ['branch', 'company', 'tenant'];
      const S0: Scope = { tenantId: TENANT, companyId: COMPANY, branchId: BRANCH };
      const NOT_REFUSED = 'NOT REFUSED - the statement / transaction was ACCEPTED';
      const outcome = (r: Txn): string => (r.ok ? NOT_REFUSED : r.error.message);
      const failure = (r: { error: string | null }): string => r.error ?? NOT_REFUSED;

      /** a scope in another BRANCH / COMPANY / TENANT, each with its own account and branch-scoped credential */
      let foreignSeeded: Promise<Record<Kind, Foreign>> | undefined;
      const foreignScopes = (): Promise<Record<Kind, Foreign>> => (foreignSeeded ??= seedForeign());

      async function seedForeign(): Promise<Record<Kind, Foreign>> {
        const make = async (kind: Kind): Promise<Foreign> => {
          let scope: Scope;
          let ccaId = CCA;
          if (kind === 'branch') {
            scope = { tenantId: TENANT, companyId: COMPANY, branchId: uid() };
            await pool.query(
              `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'M48 sibling branch',now())`,
              [scope.branchId, scope.tenantId, scope.companyId],
            );
          } else {
            const tenantId = kind === 'tenant' ? OTHER_TENANT : TENANT;
            scope = { tenantId, companyId: uid(), branchId: uid() };
            await pool.query(
              `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt") VALUES ($1,$2,'M48 foreign company','AED','Asia/Dubai',now())`,
              [scope.companyId, tenantId],
            );
            await pool.query(
              `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'M48 foreign branch',now())`,
              [scope.branchId, tenantId, scope.companyId],
            );
            let customerId = CUSTOMER;
            if (kind === 'tenant') {
              customerId = uid();
              await pool.query(
                `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'M48 foreign customer',now())`,
                [customerId, tenantId],
              );
            }
            ccaId = uid();
            await pool.query(
              `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
              [ccaId, tenantId, scope.companyId, customerId],
            );
          }
          const credId = uid();
          await pool.query(
            `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
             VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
            [credId, scope.tenantId, scope.companyId, scope.branchId],
          );
          return { ...scope, ccaId, credId };
        };
        return {
          branch: await make('branch'),
          company: await make('company'),
          tenant: await make('tenant'),
        };
      }

      /** a CAPTURED CUSTOMER_RECEIPT Payment of `amount` inside a foreign scope */
      async function foreignPayment(f: Foreign, amount = 1000): Promise<string> {
        const attemptId = uid();
        await pool.query(
          `INSERT INTO payment_attempt
             (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","updatedAt")
           VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'BANK_TRANSFER',$6,'AED',2,'CAPTURED',$7,now())`,
          [attemptId, f.tenantId, f.companyId, f.branchId, f.ccaId, amount, `idem-${attemptId}`],
        );
        const paymentId = uid();
        await pool.query(
          `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
          [paymentId, f.tenantId, f.companyId, f.branchId, attemptId, amount],
        );
        return paymentId;
      }

      /** a PAYMENT-sourced advance of `amount` (its own fresh Payment) inside a foreign scope */
      async function foreignAdvance(f: Foreign, amount = 500): Promise<string> {
        const paymentId = await foreignPayment(f, 1000);
        const advanceId = uid();
        await pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
          [advanceId, f.tenantId, f.companyId, f.branchId, f.ccaId, paymentId, amount],
        );
        return advanceId;
      }

      /** a fresh CREDIT_NOTE advance of `amount` in the main scope, funded by its own Payment (release provenance) */
      async function cnAdvance(
        amount: number,
      ): Promise<{ paymentId: string; advanceId: string; releaseId: string }> {
        const { lineId, invoiceId } = await insertSimpleInvoice(amount);
        const { paymentId, allocationId } = await insertPaymentWithAllocation(invoiceId, amount);
        const advanceId = uid();
        await insertSimpleCreditNote(
          invoiceId,
          lineId,
          amount,
          { arReduction: 0, advanceExcess: amount },
          { sourcePaymentAllocationId: allocationId, sourcePaymentId: paymentId, advanceId },
        );
        const releaseId = String(
          (
            await pool.query(
              `SELECT id FROM credit_note_coverage_release WHERE "customerAdvanceId" = $1`,
              [advanceId],
            )
          ).rows[0].id,
        );
        return { paymentId, advanceId, releaseId };
      }

      const insertRefund = (
        c: pg.PoolClient,
        id: string,
        scope: Scope,
        paymentId: string,
        amount: number,
        method = 'BANK_TRANSFER',
        attemptId: string | null = null,
      ) =>
        c.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","sourceRefundAttemptId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2,$8,'CUSTOMER_REQUEST',CURRENT_DATE)`,
          [
            id,
            scope.tenantId,
            scope.companyId,
            scope.branchId,
            paymentId,
            attemptId,
            amount,
            method,
          ],
        );
      const insertApplication = (
        c: pg.PoolClient,
        id: string,
        scope: Scope,
        advanceId: string,
        refundId: string,
        amount: number,
      ) =>
        c.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
          [id, scope.tenantId, scope.companyId, scope.branchId, advanceId, refundId, amount],
        );
      const ATTEMPT_SQL = `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,'AED',2,$7,'tap',$8,now())`;
      const attemptParams = (
        id: string,
        scope: Scope,
        paymentId: string,
        credId: string,
        amount: number,
      ): unknown[] => [
        id,
        scope.tenantId,
        scope.companyId,
        scope.branchId,
        paymentId,
        amount,
        credId,
        `idem-${id}`,
      ];
      const insertAttempt = (
        c: pg.PoolClient,
        id: string,
        scope: Scope,
        paymentId: string,
        credId: string,
        amount: number,
      ) => c.query(ATTEMPT_SQL, attemptParams(id, scope, paymentId, credId, amount));
      const insertReservation = (
        c: pg.PoolClient,
        id: string,
        scope: Scope,
        attemptId: string,
        releaseId: string,
        advanceId: string,
        amount: number,
      ) =>
        c.query(
          `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AED',2)`,
          [
            id,
            scope.tenantId,
            scope.companyId,
            scope.branchId,
            attemptId,
            releaseId,
            advanceId,
            amount,
          ],
        );
      const EVENT_SQL = `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-m48',now())`;
      const eventParams = (
        id: string,
        scope: Scope,
        credId: string,
        providerEventId: string,
      ): unknown[] => [
        id,
        scope.tenantId,
        scope.companyId,
        scope.branchId,
        credId,
        providerEventId,
      ];
      const eventCount = async (providerEventId: string): Promise<number> =>
        Number(
          (
            await pool.query(
              `SELECT count(*)::int AS n FROM provider_refund_event WHERE "providerEventId" = $1`,
              [providerEventId],
            )
          ).rows[0].n,
        );
      /** forge a row's column inside the CURRENT transaction only, with triggers off, then restore triggers */
      const forge = async (c: pg.PoolClient, sql: string, params: unknown[]): Promise<void> => {
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(sql, params);
        await c.query(`SET LOCAL session_replication_role = origin`);
      };

      // ───────────── B1 / B2 / B3 — provider_refund_event ─────────────
      it.each(KINDS)(
        'HG48-A1 (D-B3, %s) RED: an event whose CREDENTIAL belongs to a foreign scope is refused by the database and leaves no row',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const providerEventId = `evt-a1-${uid()}`;
          const r = await inTransaction((c) =>
            c.query(EVENT_SQL, eventParams(uid(), S0, f.credId, providerEventId)),
          );
          expect(outcome(r), kind).toMatch(/scope does not match/);
          expect(await eventCount(providerEventId), 'no partial row').toBe(0);
        },
      );

      it.each(KINDS)(
        "HG48-A2 (D-B3, %s) RED: an event stamped with a foreign scope while pointing at this scope's credential is refused and leaves no row",
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const providerEventId = `evt-a2-${uid()}`;
          const r = await inTransaction((c) =>
            c.query(EVENT_SQL, eventParams(uid(), f, CRED, providerEventId)),
          );
          expect(outcome(r), kind).toMatch(/scope does not match/);
          expect(await eventCount(providerEventId), 'no partial row').toBe(0);
        },
      );

      it('HG48-A3 (D-B3) RED: a tenant-wide or company-only credential can never back a refund event (a refund credential is branch-scoped, like the payment one)', async () => {
        const tenantWide = uid();
        const companyOnly = uid();
        for (const [id, company] of [
          [tenantWide, null],
          [companyOnly, COMPANY],
        ] as const) {
          await pool.query(
            `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
             VALUES ($1,$2,$3,NULL,'tap','TEST','\\x00','\\x00','\\x00',now())`,
            [id, TENANT, company],
          );
        }
        for (const credId of [tenantWide, companyOnly]) {
          const providerEventId = `evt-a3-${uid()}`;
          const r = await inTransaction((c) =>
            c.query(EVENT_SQL, eventParams(uid(), S0, credId, providerEventId)),
          );
          expect(outcome(r), credId).toMatch(/must be branch-scoped/);
          expect(await eventCount(providerEventId), 'no partial row').toBe(0);
        }
      });

      it.each(KINDS)(
        'HG48-A4 (D-B3, %s) RED: the APPLICATION ROLE (flower_app + tenant GUC) cannot register an event against a foreign credential either',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const r = await tryAsApp(
            TENANT,
            EVENT_SQL,
            eventParams(uid(), S0, f.credId, `evt-a4-${uid()}`),
          );
          expect(failure(r), kind).toMatch(/scope does not match|does not exist/);
        },
      );

      it('HG48-A5 (D-B1) RED: a ProviderRefundEvent is never DELETEd in ANY status (PROCESSED and EXCEPTION as well as RECEIVED), for both roles', async () => {
        for (const status of ['PROCESSED', 'EXCEPTION'] as const) {
          const id = uid();
          await pool.query(EVENT_SQL, eventParams(id, S0, CRED, `evt-a5-${id}`));
          await pool.query(`UPDATE provider_refund_event SET status = $2 WHERE id = $1`, [
            id,
            status,
          ]);
          for (const [who, run] of [
            ['privileged', (q: string, p: unknown[]) => tryAsSuper(q, p)],
            ['flower_app', (q: string, p: unknown[]) => tryAsApp(TENANT, q, p)],
          ] as const) {
            const del = await run(`DELETE FROM provider_refund_event WHERE id = $1`, [id]);
            expect(failure(del), `${who} / ${status}`).toMatch(/never permitted/);
          }
          expect(await exists('provider_refund_event', id)).toBe(true);
        }
      });

      it('HG48-A6 positive control (D-B1…B3): a same-scope event inserts as RECEIVED, the inbox ON CONFLICT DO NOTHING path still dedups, RECEIVED -> PROCESSED / EXCEPTION still works and a terminal status stays frozen — for both roles', async () => {
        for (const [who, run] of [
          ['privileged', (q: string, p: unknown[]) => tryAsSuper(q, p)],
          ['flower_app', (q: string, p: unknown[]) => tryAsApp(TENANT, q, p)],
        ] as const) {
          const providerEventId = `evt-a6-${who}-${uid()}`;
          const inserted = await run(`${EVENT_SQL} RETURNING status`, [
            uid(),
            TENANT,
            COMPANY,
            BRANCH,
            CRED,
            providerEventId,
          ]);
          expect(failure(inserted), `${who}: a valid event is accepted`).toBe(NOT_REFUSED);
          expect(inserted.rowCount, who).toBe(1);
        }
        // the exact SQL of ProviderRefundEventInboxRepository: a duplicate (credential, event id) is a clean no-op
        const id = uid();
        const providerEventId = `evt-a6-dup-${id}`;
        await pool.query(EVENT_SQL, eventParams(id, S0, CRED, providerEventId));
        const DEDUP_SQL = `INSERT INTO provider_refund_event ("tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
          VALUES ($1,$2,$3,$4,$5,'refund.succeeded','hash-m48',now())
          ON CONFLICT ("providerCredentialId","providerEventId") DO NOTHING RETURNING id`;
        for (const [who, run] of [
          ['privileged', (q: string, p: unknown[]) => tryAsSuper(q, p)],
          ['flower_app', (q: string, p: unknown[]) => tryAsApp(TENANT, q, p)],
        ] as const) {
          const dup = await run(DEDUP_SQL, [TENANT, COMPANY, BRANCH, CRED, providerEventId]);
          expect(failure(dup), `${who}: duplicate`).toBe(NOT_REFUSED);
          expect(dup.rowCount, `${who}: duplicate inserts nothing`).toBe(0);
        }
        // legitimate transitions
        await pool.query(`UPDATE provider_refund_event SET status = 'PROCESSED' WHERE id = $1`, [
          id,
        ]);
        const other = uid();
        await pool.query(EVENT_SQL, eventParams(other, S0, CRED, `evt-a6-exc-${other}`));
        await pool.query(`UPDATE provider_refund_event SET status = 'EXCEPTION' WHERE id = $1`, [
          other,
        ]);
        const frozen = await tryAsApp(
          TENANT,
          `UPDATE provider_refund_event SET status = 'EXCEPTION' WHERE id = $1`,
          [id],
        );
        expect(failure(frozen)).toMatch(/terminal status .* is immutable/);
      });

      // ───────────── B4 — Refund -> source Payment ─────────────
      it.each(KINDS)(
        'HG48-B1 (D-B4, %s) RED: a Refund whose SOURCE PAYMENT lives in a foreign scope is refused — the whole refund + application transaction leaves no row',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const foreignPaymentId = await foreignPayment(f);
          const adv = await cnAdvance(300);
          const refundId = uid();
          const applicationId = uid();
          const r = await inTransaction(async (c) => {
            await insertRefund(c, refundId, S0, foreignPaymentId, 300);
            await insertApplication(c, applicationId, S0, adv.advanceId, refundId, 300);
          });
          expect(outcome(r), kind).toMatch(/scope does not match sourcePayment/);
          expect(await exists('refund', refundId), 'no refund row').toBe(false);
          expect(await exists('customer_advance_refund_application', applicationId)).toBe(false);
        },
      );

      it.each(['branch', 'company'] as const)(
        'HG48-B2 (D-B4, %s) RED: the APPLICATION ROLE cannot create a Refund over a foreign-scope Payment its tenant can see — only the trigger can stop it',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const foreignPaymentId = await foreignPayment(f);
          const r = await asApp(TENANT, async (c) => {
            try {
              await insertRefund(c, uid(), S0, foreignPaymentId, 300);
              return null;
            } catch (e) {
              return e instanceof Error ? e.message : String(e);
            }
          });
          expect(r ?? NOT_REFUSED, kind).toMatch(/scope does not match sourcePayment/);
        },
      );

      it.each(['CASH', 'BANK_TRANSFER'] as const)(
        'HG48-B3 positive control (%s): a same-scope local Refund with its application still commits',
        async (method) => {
          const adv = await cnAdvance(500);
          const refundId = uid();
          const applicationId = uid();
          const r = await inTransaction(async (c) => {
            await insertRefund(c, refundId, S0, adv.paymentId, 200, method);
            await insertApplication(c, applicationId, S0, adv.advanceId, refundId, 200);
          });
          expect(outcome(r)).toBe(NOT_REFUSED);
          expect(await exists('refund', refundId)).toBe(true);
          expect(await exists('customer_advance_refund_application', applicationId)).toBe(true);
        },
      );

      // ───────────── B4 — CustomerAdvanceRefundApplication -> Refund + CustomerAdvance ─────────────
      it.each(KINDS)(
        'HG48-C1 (D-B4, %s) RED: an application that consumes a FOREIGN-scope advance of a correct Refund is refused — refund and application roll back together',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const foreignAdvanceId = await foreignAdvance(f);
          const p0 = (await insertPaymentForFreshCustomer(1000)).paymentId;
          const refundId = uid();
          const applicationId = uid();
          const r = await inTransaction(async (c) => {
            await insertRefund(c, refundId, S0, p0, 300);
            await insertApplication(c, applicationId, S0, foreignAdvanceId, refundId, 300);
          });
          expect(outcome(r), kind).toMatch(/scope does not match customerAdvance/);
          expect(await exists('refund', refundId), 'no refund row').toBe(false);
          expect(await exists('customer_advance_refund_application', applicationId)).toBe(false);
        },
      );

      it.each(KINDS)(
        'HG48-C2 (D-B4, %s): a FOREIGN-scope Refund consuming a correct advance is refused whichever scope the application claims — the refund side by the KEEP guard, the advance side by the RED guard',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const adv = await cnAdvance(300);
          const foreignPaymentId = await foreignPayment(f);
          // (i) KEEP — the application claims the ADVANCE's scope: the refund-side check refuses
          const refundA = uid();
          const applicationA = uid();
          const a = await inTransaction(async (c) => {
            await insertRefund(c, refundA, f, foreignPaymentId, 300);
            await insertApplication(c, applicationA, S0, adv.advanceId, refundA, 300);
          });
          expect(outcome(a), `${kind} (i)`).toMatch(/scope mismatch against refund/);
          expect(await exists('refund', refundA)).toBe(false);
          expect(await exists('customer_advance_refund_application', applicationA)).toBe(false);
          // (ii) RED — the application claims the REFUND's scope: only the advance-side check can refuse
          const refundB = uid();
          const applicationB = uid();
          const b = await inTransaction(async (c) => {
            await insertRefund(c, refundB, f, foreignPaymentId, 300);
            await insertApplication(c, applicationB, f, adv.advanceId, refundB, 300);
          });
          expect(outcome(b), `${kind} (ii)`).toMatch(/scope does not match customerAdvance/);
          expect(await exists('refund', refundB)).toBe(false);
          expect(await exists('customer_advance_refund_application', applicationB)).toBe(false);
        },
      );

      it('HG48-C3 (D-B4 provenance) RED: a same-scope Refund whose source Payment is NOT the Payment the consumed advance traces to is refused', async () => {
        const adv = await cnAdvance(300);
        const other = (await insertPaymentForFreshCustomer(1000)).paymentId;
        const refundId = uid();
        const applicationId = uid();
        const r = await inTransaction(async (c) => {
          await insertRefund(c, refundId, S0, other, 300);
          await insertApplication(c, applicationId, S0, adv.advanceId, refundId, 300);
        });
        expect(outcome(r)).toMatch(/underlying Payment provenance does not equal refund/);
        expect(await exists('refund', refundId)).toBe(false);
        expect(await exists('customer_advance_refund_application', applicationId)).toBe(false);
      });

      it("HG48-C4 (D-B4 provenance) RED: an OPENING advance has no Payment to refund against — the schema's own frozen rule is now structural, not only application-level", async () => {
        const { ccaId } = await freshCustomerCompanyAccount();
        const advanceId = uid();
        await pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
           VALUES ($1,$2,$3,$4,$5,'OPENING',300,'AED',2,'2026-01-05')`,
          [advanceId, TENANT, COMPANY, BRANCH, ccaId],
        );
        const p0 = (await insertPaymentForFreshCustomer(1000)).paymentId;
        const refundId = uid();
        const applicationId = uid();
        const r = await inTransaction(async (c) => {
          await insertRefund(c, refundId, S0, p0, 300);
          await insertApplication(c, applicationId, S0, advanceId, refundId, 300);
        });
        expect(outcome(r)).toMatch(/has no underlying Payment provenance/);
        expect(await exists('refund', refundId)).toBe(false);
        expect(await exists('customer_advance_refund_application', applicationId)).toBe(false);
      });

      it('HG48-C5 (D-B4 provenance) RED: a CREDIT_NOTE advance whose funding release is OPENING_ADVANCE (an opening chain, no Payment) can never fund a Refund', async () => {
        const { ccaId, customerId } = await freshCustomerCompanyAccount();
        const inv = await insertSimpleInvoice(2000, customerId);
        const opening = await insertAdvanceApplication('OPENING', 1000, {
          ccaId,
          customerId,
          targetInvoiceId: inv.invoiceId,
        });
        const advanceId = uid();
        await insertSimpleCreditNote(
          inv.invoiceId,
          inv.lineId,
          2000,
          { arReduction: 1000, advanceExcess: 1000 },
          {
            sourceKind: 'OPENING_ADVANCE',
            sourceAdvanceApplicationId: opening.applicationId,
            sourcePaymentId: null,
            advanceId,
          },
        );
        const p0 = (await insertPaymentForFreshCustomer(1000)).paymentId;
        const refundId = uid();
        const applicationId = uid();
        const r = await inTransaction(async (c) => {
          await insertRefund(c, refundId, S0, p0, 500);
          await insertApplication(c, applicationId, S0, advanceId, refundId, 500);
        });
        expect(outcome(r)).toMatch(/has no underlying Payment provenance/);
        expect(await exists('refund', refundId)).toBe(false);
        expect(await exists('customer_advance_refund_application', applicationId)).toBe(false);
      });

      it('HG48-C6 (D-B4 customer scope) RED: an advance whose customer ACCOUNT lives in another company can never be consumed by a refund of this scope (the account row is forged inside the transaction with triggers off)', async () => {
        const f = (await foreignScopes()).company;
        const adv = await cnAdvance(300);
        const refundId = uid();
        const applicationId = uid();
        const r = await inTransaction(async (c) => {
          await forge(
            c,
            `UPDATE customer_advance SET "customerCompanyAccountId" = $2 WHERE id = $1`,
            [adv.advanceId, f.ccaId],
          );
          await insertRefund(c, refundId, S0, adv.paymentId, 300);
          await insertApplication(c, applicationId, S0, adv.advanceId, refundId, 300);
        });
        expect(outcome(r)).toMatch(/customer account .* is not in this tenant\/company/);
        expect(await exists('refund', refundId)).toBe(false);
        expect(await exists('customer_advance_refund_application', applicationId)).toBe(false);
      });

      it('HG48-C7 positive control (provenance): a PAYMENT-sourced advance with its own source Payment is still consumable by a same-scope refund', async () => {
        const p = await insertPaymentForFreshCustomer(1000);
        const advanceId = uid();
        await pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,500,'AED',2)`,
          [advanceId, TENANT, COMPANY, BRANCH, p.ccaId, p.paymentId],
        );
        const refundId = uid();
        const r = await inTransaction(async (c) => {
          await insertRefund(c, refundId, S0, p.paymentId, 200, 'CASH');
          await insertApplication(c, uid(), S0, advanceId, refundId, 200);
        });
        expect(outcome(r)).toBe(NOT_REFUSED);
        expect(await exists('refund', refundId)).toBe(true);
      });

      // ───────────── B4 — RefundAttempt -> source Payment / provider credential ─────────────
      it.each(KINDS)(
        'HG48-D1 (D-B4, %s) RED: a RefundAttempt over a FOREIGN-scope source Payment is refused (its credential and own scope are correct)',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const foreignPaymentId = await foreignPayment(f);
          const id = uid();
          const r = await tryAsSuper(
            ATTEMPT_SQL,
            attemptParams(id, S0, foreignPaymentId, CRED, 400),
          );
          expect(failure(r), kind).toMatch(/scope does not match sourcePayment/);
        },
      );

      it.each(KINDS)(
        "HG48-D2 (D-B4, %s) RED: a RefundAttempt stamped in a foreign scope (with that scope's own credential) over a main-scope Payment is refused — the branch/company/tenant mismatch is between attempt and Payment",
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const p0 = (await insertPaymentForFreshCustomer(1000)).paymentId;
          const id = uid();
          const r = await tryAsSuper(ATTEMPT_SQL, attemptParams(id, f, p0, f.credId, 400));
          expect(failure(r), kind).toMatch(/scope does not match sourcePayment/);
        },
      );

      it.each(KINDS)(
        'HG48-D3 (%s) KEEP: a RefundAttempt over a FOREIGN-scope credential is still refused by the pre-existing credential guard',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const p0 = (await insertPaymentForFreshCustomer(1000)).paymentId;
          const r = await tryAsSuper(ATTEMPT_SQL, attemptParams(uid(), S0, p0, f.credId, 400));
          expect(failure(r), kind).toMatch(
            /provider_credential .* scope does not match this row's own tenant\/company\/branch/,
          );
        },
      );

      it('HG48-D4 KEEP: a RefundAttempt over a tenant-wide or company-only credential is still refused ("must be branch-scoped")', async () => {
        const tenantWide = uid();
        await pool.query(
          `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
           VALUES ($1,$2,NULL,NULL,'tap','TEST','\\x00','\\x00','\\x00',now())`,
          [tenantWide, TENANT],
        );
        const p0 = (await insertPaymentForFreshCustomer(1000)).paymentId;
        const r = await tryAsSuper(ATTEMPT_SQL, attemptParams(uid(), S0, p0, tenantWide, 400));
        expect(failure(r)).toMatch(/must be branch-scoped/);
      });

      it('HG48-D5 positive control: a same-scope attempt + reservation commits, converts to a SUCCEEDED Refund (attempt, refund and application agree) and a second attempt can FAIL — the internal reconciliation is intact', async () => {
        const ok = await cnAdvance(400);
        const attemptId = uid();
        const reserve = await inTransaction(async (c) => {
          await insertAttempt(c, attemptId, S0, ok.paymentId, CRED, 400);
          await insertReservation(c, uid(), S0, attemptId, ok.releaseId, ok.advanceId, 400);
        });
        expect(outcome(reserve)).toBe(NOT_REFUSED);
        const refundId = uid();
        const convert = await inTransaction(async (c) => {
          await c.query(`SELECT id FROM refund_attempt WHERE id = $1 FOR UPDATE`, [attemptId]);
          await insertRefund(c, refundId, S0, ok.paymentId, 400, 'ONLINE_GATEWAY', attemptId);
          await insertApplication(c, uid(), S0, ok.advanceId, refundId, 400);
          await c.query(
            `UPDATE refund_attempt SET state = 'SUCCEEDED', "resultingRefundId" = $2 WHERE id = $1`,
            [attemptId, refundId],
          );
        });
        expect(outcome(convert)).toBe(NOT_REFUSED);

        const failing = await cnAdvance(250);
        const failedAttempt = uid();
        const failReserve = await inTransaction(async (c) => {
          await insertAttempt(c, failedAttempt, S0, failing.paymentId, CRED, 250);
          await insertReservation(
            c,
            uid(),
            S0,
            failedAttempt,
            failing.releaseId,
            failing.advanceId,
            250,
          );
        });
        expect(outcome(failReserve)).toBe(NOT_REFUSED);
        await pool.query(`UPDATE refund_attempt SET state = 'FAILED' WHERE id = $1`, [
          failedAttempt,
        ]);
        expect(
          (await pool.query(`SELECT state FROM refund_attempt WHERE id = $1`, [failedAttempt]))
            .rows[0].state,
        ).toBe('FAILED');
      });

      // ───────────── B4 — RefundAttemptEntitlementReservation -> RefundAttempt + CustomerAdvance ─────────────
      it.each(KINDS)(
        'HG48-E1 (%s) KEEP: a reservation stamped with a scope other than its attempt is still refused by the pre-existing attempt-scope guard',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const adv = await cnAdvance(400);
          const attemptId = uid();
          const reservationId = uid();
          const r = await inTransaction(async (c) => {
            await insertAttempt(c, attemptId, S0, adv.paymentId, CRED, 400);
            await insertReservation(
              c,
              reservationId,
              f,
              attemptId,
              adv.releaseId,
              adv.advanceId,
              400,
            );
          });
          expect(outcome(r), kind).toMatch(/scope mismatch against the parent refund_attempt/);
          expect(await exists('refund_attempt', attemptId), 'no attempt row').toBe(false);
          expect(await exists('refund_attempt_entitlement_reservation', reservationId)).toBe(false);
        },
      );

      it.each(KINDS)(
        'HG48-E2 (D-B4, %s) RED: a reservation whose ADVANCE sits in a foreign scope is refused (the advance row is forged inside the transaction with triggers off; the attempt and release are correct)',
        async (kind) => {
          const f = (await foreignScopes())[kind];
          const adv = await cnAdvance(400);
          const column = { branch: '"branchId"', company: '"companyId"', tenant: '"tenantId"' }[
            kind
          ];
          const value = { branch: f.branchId, company: f.companyId, tenant: f.tenantId }[kind];
          const attemptId = uid();
          const reservationId = uid();
          const r = await inTransaction(async (c) => {
            await forge(c, `UPDATE customer_advance SET ${column} = $2 WHERE id = $1`, [
              adv.advanceId,
              value,
            ]);
            await insertAttempt(c, attemptId, S0, adv.paymentId, CRED, 400);
            await insertReservation(
              c,
              reservationId,
              S0,
              attemptId,
              adv.releaseId,
              adv.advanceId,
              400,
            );
          });
          expect(outcome(r), kind).toMatch(/scope does not match customerAdvance/);
          expect(await exists('refund_attempt', attemptId), 'no attempt row').toBe(false);
          expect(await exists('refund_attempt_entitlement_reservation', reservationId)).toBe(false);
        },
      );

      it('HG48-E3 KEEP: no cross-advance reservation — a release can only reserve the advance it funded', async () => {
        const a1 = await cnAdvance(400);
        const a2 = await cnAdvance(400);
        const attemptId = uid();
        const reservationId = uid();
        const r = await inTransaction(async (c) => {
          await insertAttempt(c, attemptId, S0, a1.paymentId, CRED, 400);
          await insertReservation(c, reservationId, S0, attemptId, a1.releaseId, a2.advanceId, 400);
        });
        expect(outcome(r)).toMatch(/frozen 1:1 release\/advance pair/);
        expect(await exists('refund_attempt', attemptId)).toBe(false);
        expect(await exists('refund_attempt_entitlement_reservation', reservationId)).toBe(false);
      });

      it('HG48-E4 KEEP: a reservation whose release traces to a different Payment than its attempt is still refused', async () => {
        const a1 = await cnAdvance(400);
        const a2 = await cnAdvance(400);
        const attemptId = uid();
        const reservationId = uid();
        const r = await inTransaction(async (c) => {
          await insertAttempt(c, attemptId, S0, a2.paymentId, CRED, 400);
          await insertReservation(c, reservationId, S0, attemptId, a1.releaseId, a1.advanceId, 400);
        });
        expect(outcome(r)).toMatch(
          /release's own sourcePaymentId does not equal the parent refund_attempt's sourcePaymentId/,
        );
        expect(await exists('refund_attempt', attemptId)).toBe(false);
        expect(await exists('refund_attempt_entitlement_reservation', reservationId)).toBe(false);
      });

      it('HG48-E5 (D-B4 customer scope) RED: a reservation over an advance whose customer ACCOUNT lives in another company is refused (account forged inside the transaction with triggers off)', async () => {
        const f = (await foreignScopes()).company;
        const adv = await cnAdvance(400);
        const attemptId = uid();
        const reservationId = uid();
        const r = await inTransaction(async (c) => {
          await forge(
            c,
            `UPDATE customer_advance SET "customerCompanyAccountId" = $2 WHERE id = $1`,
            [adv.advanceId, f.ccaId],
          );
          await insertAttempt(c, attemptId, S0, adv.paymentId, CRED, 400);
          await insertReservation(
            c,
            reservationId,
            S0,
            attemptId,
            adv.releaseId,
            adv.advanceId,
            400,
          );
        });
        expect(outcome(r)).toMatch(/customer account .* is not in this tenant\/company/);
        expect(await exists('refund_attempt', attemptId)).toBe(false);
        expect(await exists('refund_attempt_entitlement_reservation', reservationId)).toBe(false);
      });
    });

    // ───────────── HG4 — the funding release is unique even when every trigger is bypassed ─────────────
    it('HG4-db: a CREDIT_NOTE advance has exactly ONE funding release — a second one is refused by the unique index even with triggers switched off (raw bypass)', async () => {
      const c = await chain();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL session_replication_role = replica`); // triggers off — only constraints remain
        let message = '';
        try {
          await client.query(
            `INSERT INTO credit_note_coverage_release
               (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
             SELECT $2, "tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId"
               FROM credit_note_coverage_release WHERE id = $1`,
            [c.releaseId, uid()],
          );
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(message).toMatch(
          /credit_note_coverage_release_customerAdvanceId_key|credit_note_coverage_release_creditNoteId_sourcePaymentAll_key/,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    // ───────────── HG13 — row-level security of all nine tables ─────────────
    it('HG13-a: every 3b.8 table has RLS ENABLED + FORCED and a tenant-isolation policy that gates BOTH reads (USING) and writes (WITH CHECK) on app.tenant_id; the application role is NOSUPERUSER NOBYPASSRLS', async () => {
      const flags = await pool.query<{ relname: string; rls: boolean; force: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY 1`,
        [[...NINE]],
      );
      expect(flags.rows.map((r) => r.relname)).toEqual([...NINE].sort());
      for (const r of flags.rows) {
        expect(r.rls, `${r.relname}: RLS enabled`).toBe(true);
        expect(r.force, `${r.relname}: RLS forced`).toBe(true);
      }
      const policies = await pool.query<{
        tablename: string;
        cmd: string;
        qual: string;
        with_check: string;
      }>(
        `SELECT tablename, cmd, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1`,
        [[...NINE]],
      );
      for (const t of NINE) {
        const p = policies.rows.filter((r) => r.tablename === t);
        expect(p, `${t}: exactly one policy`).toHaveLength(1);
        expect(p[0]!.cmd, `${t}: applies to ALL commands`).toBe('ALL');
        expect(p[0]!.qual, `${t}: USING`).toMatch(/"tenantId" = .*app\.tenant_id/);
        expect(p[0]!.with_check, `${t}: WITH CHECK`).toMatch(/"tenantId" = .*app\.tenant_id/);
      }
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'flower_app'`,
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('HG13-b: a REAL row of each of the nine tables is invisible, un-updatable and un-deletable to another tenant (and to a session with no tenant at all) — with a positive control proving the owning tenant sees it', async () => {
      const c = await chain();
      const rows: [string, string][] = [
        ['credit_note', c.creditNoteId],
        ['credit_note_line', c.creditNoteLineId],
        ['credit_note_coverage_release', c.releaseId],
        ['cancellation_charge', c.chargeId],
        ['refund', c.refundId],
        ['refund_attempt', c.attemptId],
        ['refund_attempt_entitlement_reservation', c.reservationId],
        ['customer_advance_refund_application', c.applicationId],
        ['provider_refund_event', c.eventId],
      ];
      for (const [table, id] of rows) {
        // positive control — the owning tenant sees it
        const own = await asApp(
          TENANT,
          async (cl) => (await cl.query(`SELECT id FROM ${table} WHERE id = $1`, [id])).rowCount,
        );
        expect(own, `${table}: owner sees its row`).toBe(1);
        for (const [label, tenant] of [
          ['another tenant', OTHER_TENANT],
          ['no tenant GUC', null],
        ] as const) {
          const seen = await asApp(
            tenant,
            async (cl) => (await cl.query(`SELECT id FROM ${table} WHERE id = $1`, [id])).rowCount,
          );
          expect(seen, `${table}: SELECT as ${label}`).toBe(0);
          const all = await asApp(tenant, async (cl) =>
            Number((await cl.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n),
          );
          expect(all, `${table}: count(*) as ${label}`).toBe(0);
          const upd = await tryAsApp(
            tenant,
            `UPDATE ${table} SET "tenantId" = "tenantId" WHERE id = $1`,
            [id],
          );
          expect(upd, `${table}: UPDATE as ${label}`).toEqual({ error: null, rowCount: 0 });
          const del = await tryAsApp(tenant, `DELETE FROM ${table} WHERE id = $1`, [id]);
          expect(del, `${table}: DELETE as ${label}`).toEqual({ error: null, rowCount: 0 });
        }
        expect(await exists(table, id), `${table}: the row is untouched`).toBe(true);
      }
    });

    it("HG13-c: another tenant can INSERT nothing into any of the nine tables on this tenant's behalf — each forged row is refused (by RLS or by the integrity trigger that runs first) and not one row appears", async () => {
      const c = await chain();
      const n = (): string => uid();
      const forged: [string, string, unknown[]][] = [
        [
          'credit_note',
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',1,0,1,1,0)`,
          [n(), TENANT, COMPANY, BRANCH, c.invoiceId, `CN-forged-${uid().slice(0, 6)}`],
        ],
        [
          'credit_note_line',
          `INSERT INTO credit_note_line (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,(SELECT id FROM order_line WHERE "orderId" = $5 LIMIT 1),'1.0000',1,0,0,1,0,1,'AED',2)`,
          [n(), TENANT, COMPANY, c.creditNoteId, c.orderId],
        ],
        [
          'credit_note_coverage_release',
          `INSERT INTO credit_note_coverage_release (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
           VALUES ($1,$2,$3,$4,$5,'PAYMENT_ALLOCATION',$6,$7,1,'AED',2,$8)`,
          [n(), TENANT, COMPANY, BRANCH, c.creditNoteId, c.allocationId, c.paymentId, c.advanceId],
        ],
        [
          'cancellation_charge',
          `INSERT INTO cancellation_charge (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber","netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent","priceTaxMode","roundingMode","reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,$6,100,5,105,'AED',2,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [n(), TENANT, COMPANY, BRANCH, c.orderId, `CC-forged-${uid().slice(0, 6)}`],
        ],
        [
          'refund',
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,1,'AED',2,'CASH','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [n(), TENANT, COMPANY, BRANCH, c.paymentId],
        ],
        [
          'refund_attempt',
          `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
           VALUES ($1,$2,$3,$4,$5,1,'AED',2,$6,'tap',$7,now())`,
          [n(), TENANT, COMPANY, BRANCH, c.paymentId, CRED, `forged-${uid()}`],
        ],
        [
          'refund_attempt_entitlement_reservation',
          `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,'AED',2)`,
          [n(), TENANT, COMPANY, BRANCH, c.attemptId, c.releaseId, c.advanceId],
        ],
        [
          'customer_advance_refund_application',
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,1,'AED',2)`,
          [n(), TENANT, COMPANY, BRANCH, c.advanceId, c.refundId],
        ],
        [
          'provider_refund_event',
          `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-forged',now())`,
          [n(), TENANT, COMPANY, BRANCH, CRED, `evt-forged-${uid()}`],
        ],
      ];
      expect(forged.map(([t]) => t).sort()).toEqual([...NINE].sort());
      const before: Record<string, number> = {};
      for (const t of NINE)
        before[t] = Number((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
      for (const [table, sql, params] of forged) {
        for (const [label, tenant] of [
          ['another tenant', OTHER_TENANT],
          ['no tenant GUC', null],
        ] as const) {
          const r = await tryAsApp(tenant, sql, params);
          expect(r.error, `${table}: forged INSERT as ${label} must be refused`).not.toBeNull();
          expect(r.error, `${table} as ${label}`).toMatch(
            /row-level security|does not exist|violates|not found|must|invalid/i,
          );
        }
      }
      for (const t of NINE) {
        const now = Number((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
        expect(now, `${t}: no row appeared`).toBe(before[t]);
      }
      // the credit note has no BEFORE INSERT trigger, so the RLS WITH CHECK itself refuses the forged row
      const cn = forged.find(([t]) => t === 'credit_note')!;
      const rlsOnly = await tryAsApp(OTHER_TENANT, cn[1], cn[2]);
      expect(rlsOnly.error, 'credit_note: RLS WITH CHECK').toMatch(/row-level security/);
    });
  });
});
