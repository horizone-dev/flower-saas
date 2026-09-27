import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.6 Checkpoint D (D2/D3/D5/D6/D28) — the 39th forward migration's
 * `customer_receivable_payment_application` table, proven against real
 * Postgres via raw SQL, mirroring `receivables-schema.integration.test.ts`'s
 * own conventions exactly. Structural rules (D3), the extended
 * payment-capacity/opening-receivable-coverage backstops (D5/D6), and every
 * required D28 direct-DB concurrency hard gate.
 *
 * Uses the plain Testcontainers superuser connection (bypasses RLS as the
 * table owner) — RLS itself is already proven generically by
 * `receivables-schema.integration.test.ts`'s own suite for the sibling
 * tables; this file focuses on the NEW table's own structural/concurrency
 * invariants, not re-proving RLS from scratch.
 */
const TENANT = 'da000000-1111-7111-8111-111111111111';
const OTHER_TENANT = 'da000000-2222-7222-8222-222222222222';
const COMPANY = 'da000000-3333-7333-8333-333333333333';
const OTHER_COMPANY = 'da000000-4444-7444-8444-444444444444';
const BRANCH = 'da000000-6666-7666-8666-666666666666';
const BRANCH_2 = 'da000000-7777-7777-8777-777777777777'; // same company as BRANCH
const CATEGORY = 'da000000-8888-7888-8888-888888888888';
const PRODUCT = 'da000000-9999-7999-8999-999999999999';
const VARIANT = 'da000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = 'da000000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CCA = 'da000000-cccc-7ccc-8ccc-cccccccccccc'; // customer_company_account
const OTHER_CUSTOMER = 'da000000-dddd-7ddd-8ddd-dddddddddddd';
const OTHER_CCA = 'da000000-eeee-7eee-8eee-eeeeeeeeeeee';

describe('packages/db — Task 3b.6 Checkpoint D customer_receivable_payment_application', () => {
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
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000da000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000da000002', '00000000-0000-7000-8000-0000da000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT, 'd28-3b6'],
      [OTHER_TENANT, 'd28-3b6-other'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000da000002', now())`,
        [id, slug],
      );
    }
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'د.إ', 'UAE Dirham', 'درهم إماراتي') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('SAR', 2, 'ر.س', 'Saudi Riyal', 'ريال سعودي') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Test Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Other Co', 'AED', 'Asia/Dubai', now())`,
      [OTHER_COMPANY, TENANT],
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
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Test Customer', now())`,
      [CUSTOMER, TENANT],
    );
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Other Customer', now())`,
      [OTHER_CUSTOMER, TENANT],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [CCA, TENANT, COMPANY, CUSTOMER],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [OTHER_CCA, TENANT, COMPANY, OTHER_CUSTOMER],
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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── fixture helpers (mirrors receivables-schema.integration.test.ts) ───────
  async function insertOrder(
    overrides: { branchId?: string; customerId?: string | null } = {},
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [
        id,
        TENANT,
        COMPANY,
        overrides.branchId ?? BRANCH,
        overrides.customerId === undefined ? CUSTOMER : overrides.customerId,
        `fp-${id}`,
      ],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-D28-${RUN}-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function insertInvoice(orderId: string, totalAmountMinor = 1000): Promise<string> {
    const invoiceId = uid();
    const lineId = uid();
    const { rows } = await pool.query<{
      tenantId: string;
      companyId: string;
      originBranchId: string;
    }>(`SELECT "tenantId", "companyId", "originBranchId" FROM "order" WHERE id = $1`, [orderId]);
    const o = rows[0]!;
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
        `INV-D28-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    return invoiceId;
  }

  async function freshOrderInvoice(
    overrides: { branchId?: string; customerId?: string | null; totalAmountMinor?: number } = {},
  ): Promise<{ orderId: string; invoiceId: string }> {
    const orderId = await insertOrder(overrides);
    const invoiceId = await insertInvoice(orderId, overrides.totalAmountMinor ?? 1000);
    return { orderId, invoiceId };
  }

  interface AttemptOverrides {
    branchId?: string;
    orderId?: string | null;
    targetInvoiceId?: string | null;
    receiptPurpose?: 'INVOICE_COLLECTION' | 'CUSTOMER_RECEIPT';
    customerCompanyAccountId?: string | null;
    amountMinor?: number;
    currencyCode?: string;
  }

  /** CUSTOMER_RECEIPT by default — this file's own new-table tests are almost
   *  always exercising the direct-Payment-to-Opening-Receivable path. */
  async function insertAttempt(overrides: AttemptOverrides = {}): Promise<{
    id: string;
    orderId: string | null;
    invoiceId: string | null;
  }> {
    const purpose = overrides.receiptPurpose ?? 'CUSTOMER_RECEIPT';
    let orderId = overrides.orderId;
    let invoiceId = overrides.targetInvoiceId;
    if (purpose === 'INVOICE_COLLECTION' && (orderId === undefined || invoiceId === undefined)) {
      const fresh = await freshOrderInvoice(
        overrides.branchId !== undefined ? { branchId: overrides.branchId } : {},
      );
      orderId = orderId ?? fresh.orderId;
      invoiceId = invoiceId ?? fresh.invoiceId;
    }
    const id = uid();
    const currency = overrides.currencyCode ?? 'AED';
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "receiptPurpose",
          "customerCompanyAccountId", method, "amountMinor", "currencyCode", "currencyExponent",
          state, "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
          "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CASH',$9,$10,2,'CAPTURED',$11,$12,$13, now())`,
      [
        id,
        TENANT,
        COMPANY,
        overrides.branchId ?? BRANCH,
        orderId ?? null,
        invoiceId ?? null,
        purpose,
        overrides.customerCompanyAccountId ?? (purpose === 'CUSTOMER_RECEIPT' ? CCA : null),
        overrides.amountMinor ?? 1000,
        currency,
        purpose === 'INVOICE_COLLECTION' ? 'fp-attempt' : null,
        purpose === 'INVOICE_COLLECTION' ? 1 : null,
        `idem-${id}`,
      ],
    );
    return { id, orderId: orderId ?? null, invoiceId: invoiceId ?? null };
  }

  async function insertPayment(
    sourceAttemptId: string,
    overrides: { amountMinor?: number; branchId?: string; currencyCode?: string } = {},
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,$7,2)`,
      [
        id,
        TENANT,
        COMPANY,
        overrides.branchId ?? BRANCH,
        sourceAttemptId,
        overrides.amountMinor ?? 1000,
        overrides.currencyCode ?? 'AED',
      ],
    );
    return id;
  }

  /** Convenience: a fresh CUSTOMER_RECEIPT Payment for CCA, amountMinor given. */
  async function freshCustomerReceiptPayment(
    amountMinor: number,
    branchId = BRANCH,
  ): Promise<string> {
    const { id: attemptId } = await insertAttempt({ amountMinor, branchId });
    return insertPayment(attemptId, { amountMinor, branchId });
  }

  /** Task 3b.6 Checkpoint F Final Hardening — a fresh, dedicated branch. This
   *  whole describe block's tests share ONE `CCA`; Checkpoint F's new "at
   *  most one opening-balance initialization per tenant/company/branch/
   *  CustomerCompanyAccount" structural trigger means any two tests that
   *  each create an OPENING receivable on the SAME shared `CCA`+`BRANCH` now
   *  collide. Tests that create one use a freshly minted branch (this
   *  helper) purely for that isolation — it is NOT testing anything about
   *  branch scope itself (D28.5/D28.6, which genuinely test branch/account
   *  mismatch, use their OWN pair of fresh branches instead of the shared
   *  `BRANCH`/`BRANCH_2` constants, preserving the exact same two-different-
   *  scopes shape). */
  async function freshBranch(): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1,$2,$3,'Fresh',now())`,
      [id, TENANT, COMPANY],
    );
    return id;
  }

  async function insertOpeningReceivable(
    openingAmountMinor: number,
    branchId = BRANCH,
    customerCompanyAccountId = CCA,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
      [id, TENANT, COMPANY, branchId, customerCompanyAccountId, openingAmountMinor],
    );
    return id;
  }

  async function insertInvoiceReceivable(invoiceId: string, branchId = BRANCH): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "invoiceId", "creditAuthorized")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
      [id, TENANT, COMPANY, branchId, CCA, invoiceId],
    );
    return id;
  }

  function insertApplicationSql(
    id: string,
    paymentId: string,
    receivableId: string,
    amountMinor: number,
    opts: { branchId?: string; customerCompanyAccountId?: string; currencyCode?: string } = {},
  ): { text: string; values: unknown[] } {
    return {
      text: `INSERT INTO customer_receivable_payment_application
        (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "paymentId", "customerReceivableId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2)`,
      values: [
        id,
        TENANT,
        COMPANY,
        opts.branchId ?? BRANCH,
        opts.customerCompanyAccountId ?? CCA,
        paymentId,
        receivableId,
        amountMinor,
        opts.currencyCode ?? 'AED',
      ],
    };
  }

  async function insertApplication(
    paymentId: string,
    receivableId: string,
    amountMinor: number,
    opts: { branchId?: string; customerCompanyAccountId?: string; currencyCode?: string } = {},
  ): Promise<string> {
    const id = uid();
    const { text, values } = insertApplicationSql(id, paymentId, receivableId, amountMinor, opts);
    await pool.query(text, values);
    return id;
  }

  // ═══════════════════════ D3 — structural rules ═════════════════════════════
  describe('structural rules (D3)', () => {
    it('D28.1/D28.2: an INVOICE-sourced receivable target is rejected — an OPENING target succeeds', async () => {
      const b = await freshBranch();
      const { invoiceId } = await freshOrderInvoice({ branchId: b });
      const invoiceReceivable = await insertInvoiceReceivable(invoiceId, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      await expect(
        pool.query(
          ...toArgs(insertApplicationSql(uid(), paymentId, invoiceReceivable, 50, { branchId: b })),
        ),
      ).rejects.toThrow(/is not OPENING-sourced/);

      const openingReceivable = await insertOpeningReceivable(100, b);
      await expect(
        insertApplication(paymentId, openingReceivable, 50, { branchId: b }),
      ).resolves.toBeDefined();
    });

    it('D28.3: wrong tenant rejected', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      const id = uid();
      await expect(
        pool.query(
          `INSERT INTO customer_receivable_payment_application
             (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "paymentId", "customerReceivableId", "amountMinor", "currencyCode", "currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,50,'AED',2)`,
          [id, OTHER_TENANT, COMPANY, b, CCA, paymentId, openingReceivable],
        ),
      ).rejects.toThrow(/violates foreign key|does not exist|scope does not match/);
    });

    it('D28.4: wrong company rejected', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      await expect(
        pool.query(
          `INSERT INTO customer_receivable_payment_application
             (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "paymentId", "customerReceivableId", "amountMinor", "currencyCode", "currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,50,'AED',2)`,
          [uid(), TENANT, OTHER_COMPANY, b, CCA, paymentId, openingReceivable],
        ),
      ).rejects.toThrow(/violates foreign key|does not exist|scope does not match/);
    });

    it('D28.5: wrong branch rejected', async () => {
      const b1 = await freshBranch();
      const b2 = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b1);
      const paymentId = await freshCustomerReceiptPayment(100, b1);
      await expect(
        insertApplication(paymentId, openingReceivable, 50, { branchId: b2 }),
      ).rejects.toThrow(/scope does not match|violates foreign key/);
    });

    it('D28.6: wrong customer account rejected — the Payment is attributed to a DIFFERENT customer than the target receivable', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b, CCA);
      const { id: attemptId } = await insertAttempt({
        customerCompanyAccountId: OTHER_CCA,
        branchId: b,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100, branchId: b });
      await expect(
        insertApplication(paymentId, openingReceivable, 50, { branchId: b }),
      ).rejects.toThrow(
        /does not match payment.*attributed customer account|customerCompanyAccountId does not match/,
      );
    });

    it('D28.7: currency mismatch (application vs receivable) rejected', async () => {
      // the company's own currency-company FK pins every Payment to AED
      // (its `defaultCurrency`) — so the mismatch this proves is the NEW
      // table's own trigger check against a VALID AED receivable/Payment
      // pair, by asserting a mismatched currency directly on the insert.
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b); // AED
      const paymentId = await freshCustomerReceiptPayment(100, b); // AED
      await expect(
        insertApplication(paymentId, openingReceivable, 50, { branchId: b, currencyCode: 'SAR' }),
      ).rejects.toThrow(/currency does not match|violates foreign key/);
    });

    it('D28.8: exponent mismatch rejected (currency/exponent pair not in the currency table)', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      await expect(
        pool.query(
          `INSERT INTO customer_receivable_payment_application
             (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "paymentId", "customerReceivableId", "amountMinor", "currencyCode", "currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,50,'AED',3)`,
          [uid(), TENANT, COMPANY, b, CCA, paymentId, openingReceivable],
        ),
      ).rejects.toThrow(/currency does not match|violates foreign key/);
    });

    it('D28.9: UPDATE is unconditionally rejected (append-only)', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      const id = await insertApplication(paymentId, openingReceivable, 50, { branchId: b });
      await expect(
        pool.query(
          `UPDATE customer_receivable_payment_application SET "amountMinor" = 60 WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/append-only — UPDATE is never permitted/);
    });

    it('D28.10: DELETE is unconditionally rejected (append-only)', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      const id = await insertApplication(paymentId, openingReceivable, 50, { branchId: b });
      await expect(
        pool.query(`DELETE FROM customer_receivable_payment_application WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only — DELETE is never permitted/);
    });

    it('D28.11: a duplicate CustomerAccountEntry(OPENING_RECEIVABLE_PAYMENT_APPLIED) for the SAME application row is rejected', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      const applicationId = await insertApplication(paymentId, openingReceivable, 50, {
        branchId: b,
      });
      await pool.query(
        `INSERT INTO customer_account_entry (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "entryKind", "customerReceivablePaymentApplicationId")
         VALUES ($1,$2,$3,$4,$5,'OPENING_RECEIVABLE_PAYMENT_APPLIED',$6)`,
        [uid(), TENANT, COMPANY, b, CCA, applicationId],
      );
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "entryKind", "customerReceivablePaymentApplicationId")
           VALUES ($1,$2,$3,$4,$5,'OPENING_RECEIVABLE_PAYMENT_APPLIED',$6)`,
          [uid(), TENANT, COMPANY, b, CCA, applicationId],
        ),
      ).rejects.toThrow(/duplicate key|unique constraint/);
    });

    it('D28.16: exact boundary — a single application of exactly the full openingAmountMinor (100) succeeds', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      await expect(
        insertApplication(paymentId, openingReceivable, 100, { branchId: b }),
      ).resolves.toBeDefined();
      // a further application of even 1 must now fail — the receivable is exhausted.
      const paymentId2 = await freshCustomerReceiptPayment(100, b);
      await expect(
        insertApplication(paymentId2, openingReceivable, 1, { branchId: b }),
      ).rejects.toThrow(/coverage would exceed openingAmountMinor/);
    });
  });

  // ═══════════════════════ D5/D6/D28 — concurrency hard gates ════════════════
  describe('concurrency hard gates (D5/D6/D28.12-15)', () => {
    it('D28.12: Payment=100 — Invoice PaymentAllocation 60 vs Opening application 60 -> exactly one succeeds', async () => {
      const b = await freshBranch();
      const { invoiceId } = await freshOrderInvoice({ branchId: b, totalAmountMinor: 1000 });
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, paymentId, invoiceId],
          ),
          c2.query(
            ...toArgs(
              insertApplicationSql(uid(), paymentId, openingReceivable, 60, { branchId: b }),
            ),
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('D28.13: Payment=100 — Opening application 60 vs Advance funding 60 -> exactly one succeeds', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(100, b);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            ...toArgs(
              insertApplicationSql(uid(), paymentId, openingReceivable, 60, { branchId: b }),
            ),
          ),
          c2.query(
            `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, CCA, paymentId],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('D28.14: Opening AR=100 — Payment application 60 vs CustomerAdvanceApplication 60 -> exactly one succeeds', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentId = await freshCustomerReceiptPayment(60, b);
      const advancePaymentId = await freshCustomerReceiptPayment(60, b);
      const advanceId = uid();
      await pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,60,'AED',2)`,
        [advanceId, TENANT, COMPANY, b, CCA, advancePaymentId],
      );
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            ...toArgs(
              insertApplicationSql(uid(), paymentId, openingReceivable, 60, { branchId: b }),
            ),
          ),
          c2.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, advanceId, openingReceivable],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('D28.15: Opening AR=100 — two DIFFERENT Payments each applying 60 concurrently -> exactly one succeeds', async () => {
      const b = await freshBranch();
      const openingReceivable = await insertOpeningReceivable(100, b);
      const paymentA = await freshCustomerReceiptPayment(60, b);
      const paymentB = await freshCustomerReceiptPayment(60, b);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            ...toArgs(
              insertApplicationSql(uid(), paymentA, openingReceivable, 60, { branchId: b }),
            ),
          ),
          c2.query(
            ...toArgs(
              insertApplicationSql(uid(), paymentB, openingReceivable, 60, { branchId: b }),
            ),
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM("amountMinor"),0)::int AS n FROM customer_receivable_payment_application WHERE "customerReceivableId" = $1`,
          [openingReceivable],
        );
        expect(rows[0].n).toBeLessThanOrEqual(100);
      } finally {
        c1.release();
        c2.release();
      }
    });
  });
});

/** pg's typed `.query(text, values)` and the object-shape SQL builder helpers
 *  above need converting to a plain args tuple for `Pool`/`PoolClient` calls. */
function toArgs(q: { text: string; values: unknown[] }): [string, unknown[]] {
  return [q.text, q.values];
}
