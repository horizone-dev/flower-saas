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
          [advanceId, TENANT, COMPANY, BRANCH, CCA, advanceExcess],
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
          [advId, TENANT, COMPANY, BRANCH, CCA, amountMinor],
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
          [advId, TENANT, COMPANY, BRANCH, CCA],
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
        const { applicationId } = await insertAdvanceApplicationToReceivable(
          'PAYMENT',
          200,
          ccaId,
          ccRecvId,
          { sourcePaymentId: paymentId },
        );
        const r = await insertReleaseInOneTx(invoiceId, lineId, 200, {
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
      const recvId = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
        [recvId, TENANT, COMPANY, BRANCH, CCA, invoiceId2],
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
});
