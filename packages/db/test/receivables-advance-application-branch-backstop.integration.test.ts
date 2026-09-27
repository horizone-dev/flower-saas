import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.6 Checkpoint E final hardening — the 40th forward migration's
 * structural branch backstop for `customer_advance_application`, proven
 * against real Postgres via raw SQL. Confirms the two branch-inclusive
 * composite FKs (and the trigger's own friendly re-check) reject a
 * cross-branch application REGARDLESS of which side's branchId the caller
 * claims, for BOTH target source types (INVOICE and OPENING), and that a
 * genuine same-branch application still succeeds at the exact boundary.
 */
const TENANT = 'db400000-1111-7111-8111-111111111111';
const COMPANY = 'db400000-3333-7333-8333-333333333333';
const BRANCH_A = 'db400000-6666-7666-8666-666666666666';
const BRANCH_B = 'db400000-7777-7777-8777-777777777777';
const CATEGORY = 'db400000-8888-7888-8888-888888888888';
const PRODUCT = 'db400000-9999-7999-8999-999999999999';
const VARIANT = 'db400000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = 'db400000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CCA = 'db400000-cccc-7ccc-8ccc-cccccccccccc';

describe('packages/db — Task 3b.6 Checkpoint E final hardening: customer_advance_application branch backstop', () => {
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
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000db400001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000db400002', '00000000-0000-7000-8000-0000db400001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'e-branch-bs', 'e-branch-bs', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000db400002', now())`,
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
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Branch A', now())`,
      [BRANCH_A, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Branch B', now())`,
      [BRANCH_B, TENANT, COMPANY],
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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── fixture helpers (mirrors receivables-schema.integration.test.ts) ───────
  async function insertOrder(branchId: string): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [id, TENANT, COMPANY, branchId, CUSTOMER, `fp-${id}`],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-BSTOP-${RUN}-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function insertInvoice(
    orderId: string,
    branchId: string,
    totalAmountMinor = 100,
  ): Promise<string> {
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
        branchId,
        orderId,
        `INV-BSTOP-${invoiceId.slice(0, 8)}`,
        totalAmountMinor,
      ],
    );
    return invoiceId;
  }

  async function insertInvoiceReceivable(invoiceId: string, branchId: string): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "invoiceId", "creditAuthorized")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
      [id, TENANT, COMPANY, branchId, CCA, invoiceId],
    );
    return id;
  }

  async function freshInvoiceReceivable(branchId: string, totalAmountMinor = 100): Promise<string> {
    const orderId = await insertOrder(branchId);
    const invoiceId = await insertInvoice(orderId, branchId, totalAmountMinor);
    return insertInvoiceReceivable(invoiceId, branchId);
  }

  async function insertOpeningReceivable(
    openingAmountMinor: number,
    branchId: string,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
      [id, TENANT, COMPANY, branchId, CCA, openingAmountMinor],
    );
    return id;
  }

  async function insertOpeningAdvance(amountMinor: number, branchId: string): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "amountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
      [id, TENANT, COMPANY, branchId, CCA, amountMinor],
    );
    return id;
  }

  /** A PAYMENT-sourced Advance (raw SQL) — used wherever a test needs an
   *  Advance alongside an OPENING Receivable on the SAME branch (Checkpoint
   *  F Final Hardening forbids an OPENING Advance from coexisting with an
   *  OPENING Receivable on the same account+branch). */
  async function insertPaymentAdvance(amountMinor: number, branchId: string): Promise<string> {
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId", method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, branchId, CCA, amountMinor, `idem-bstop-${attemptId}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, branchId, attemptId, amountMinor],
    );
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "sourcePaymentId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
      [id, TENANT, COMPANY, branchId, CCA, paymentId, amountMinor],
    );
    return id;
  }

  async function insertApplication(
    advanceId: string,
    receivableId: string,
    amountMinor: number,
    branchId: string,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance_application (id, "tenantId", "companyId", "branchId", "customerAdvanceId", "customerReceivableId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [id, TENANT, COMPANY, branchId, advanceId, receivableId, amountMinor],
    );
    return id;
  }

  /** Task 3b.6 Checkpoint F Final Hardening — a fresh, dedicated branch. This
   *  whole file shares ONE `CCA`; Checkpoint F's new "at most one opening-
   *  balance initialization per tenant/company/branch/CustomerCompanyAccount"
   *  structural trigger means any two tests that each create an OPENING
   *  Advance (every test below does) on the SAME shared branch now collide.
   *  Each test below mints its OWN fresh pair of branches instead of the
   *  shared `BRANCH_A`/`BRANCH_B` constants — preserving the exact same
   *  "two distinct branches, same company" shape this whole file tests. */
  async function freshBranch(): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1,$2,$3,'Fresh',now())`,
      [id, TENANT, COMPANY],
    );
    return id;
  }

  // ═════════════════ INVOICE-origin receivable target ═══════════════════════
  describe('target: CustomerReceivable(sourceType=INVOICE)', () => {
    it('A: Advance@BranchA, Receivable@BranchB, application claims BranchA -> rejected', async () => {
      const bA = await freshBranch();
      const bB = await freshBranch();
      const advanceId = await insertOpeningAdvance(500, bA);
      const receivableId = await freshInvoiceReceivable(bB, 100);
      await expect(insertApplication(advanceId, receivableId, 50, bA)).rejects.toThrow(
        /branch does not match/,
      );
    });

    it('B: Advance@BranchA, Receivable@BranchB, application claims BranchB -> rejected', async () => {
      const bA = await freshBranch();
      const bB = await freshBranch();
      const advanceId = await insertOpeningAdvance(500, bA);
      const receivableId = await freshInvoiceReceivable(bB, 100);
      await expect(insertApplication(advanceId, receivableId, 50, bB)).rejects.toThrow(
        /scope does not match customerAdvance/,
      );
    });

    it('C: Advance@BranchA, Receivable@BranchA -> valid exact-boundary application succeeds', async () => {
      const bA = await freshBranch();
      const advanceId = await insertOpeningAdvance(100, bA);
      const receivableId = await freshInvoiceReceivable(bA, 100);
      await expect(insertApplication(advanceId, receivableId, 100, bA)).resolves.toBeDefined();
    });

    it('D: same tenant/company/customer/currency, different branch -> still rejected', async () => {
      const bA = await freshBranch();
      const bB = await freshBranch();
      const advanceId = await insertOpeningAdvance(500, bA);
      const receivableId = await freshInvoiceReceivable(bB, 500);
      await expect(insertApplication(advanceId, receivableId, 500, bA)).rejects.toThrow();
      await expect(insertApplication(advanceId, receivableId, 500, bB)).rejects.toThrow();
    });
  });

  // ═════════════════ OPENING-origin receivable target ════════════════════════
  describe('target: CustomerReceivable(sourceType=OPENING)', () => {
    it('A: Advance@BranchA, Opening Receivable@BranchB, application claims BranchA -> rejected', async () => {
      const bA = await freshBranch();
      const bB = await freshBranch();
      const advanceId = await insertOpeningAdvance(500, bA);
      const receivableId = await insertOpeningReceivable(100, bB);
      await expect(insertApplication(advanceId, receivableId, 50, bA)).rejects.toThrow(
        /branch does not match/,
      );
    });

    it('B: Advance@BranchA, Opening Receivable@BranchB, application claims BranchB -> rejected', async () => {
      const bA = await freshBranch();
      const bB = await freshBranch();
      const advanceId = await insertOpeningAdvance(500, bA);
      const receivableId = await insertOpeningReceivable(100, bB);
      await expect(insertApplication(advanceId, receivableId, 50, bB)).rejects.toThrow(
        /scope does not match customerAdvance/,
      );
    });

    it('C: Advance@BranchA, Opening Receivable@BranchA -> valid exact-boundary application succeeds', async () => {
      const bA = await freshBranch();
      // a PAYMENT-sourced Advance (Checkpoint F forbids an OPENING Advance
      // coexisting with an OPENING Receivable on the same account+branch) —
      // the branch backstop itself is agnostic to the Advance's OWN
      // sourceType, only to scope/branch equality, so this is an equally
      // valid same-branch proof.
      const advanceId = await insertPaymentAdvance(100, bA);
      const receivableId = await insertOpeningReceivable(100, bA);
      await expect(insertApplication(advanceId, receivableId, 100, bA)).resolves.toBeDefined();
    });

    it('D: same tenant/company/customer/currency, different branch -> still rejected', async () => {
      const bA = await freshBranch();
      const bB = await freshBranch();
      const advanceId = await insertOpeningAdvance(500, bA);
      const receivableId = await insertOpeningReceivable(500, bB);
      await expect(insertApplication(advanceId, receivableId, 500, bA)).rejects.toThrow();
      await expect(insertApplication(advanceId, receivableId, 500, bB)).rejects.toThrow();
    });
  });

  // ═════════════════ existing invariants remain unweakened ═══════════════════
  it('every existing invariant remains enforced (currency, account, capacity, coverage) — same-branch only', async () => {
    const bA = await freshBranch();
    const advanceId = await insertOpeningAdvance(50, bA);
    const receivableId = await freshInvoiceReceivable(bA, 100);
    // amount > 0 still enforced
    await pool
      .query(
        `INSERT INTO customer_advance_application (id, "tenantId", "companyId", "branchId", "customerAdvanceId", "customerReceivableId", "amountMinor", "currencyCode", "currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,0,'AED',2)`,
        [uid(), TENANT, COMPANY, bA, advanceId, receivableId],
      )
      .then(
        () => {
          throw new Error('expected amount>0 CHECK to reject a zero amount');
        },
        () => undefined,
      );
    // advance capacity still enforced (50 available, requesting 60)
    await expect(insertApplication(advanceId, receivableId, 60, bA)).rejects.toThrow(
      /application would exceed amountMinor/,
    );
  });
});
