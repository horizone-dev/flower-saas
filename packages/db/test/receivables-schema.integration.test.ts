import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '../src/index.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.6 Checkpoint B — the receivables/credit/advances schema, proven
 * against real Postgres via raw SQL: the `payment_attempt` target evolution
 * (B3/B4), `payment_allocation` fan-out + branch backstop + the concurrency-
 * safe payment-capacity/invoice-coverage backstops (B5/B6/B7/B14), the four
 * new append-only tables (`customer_receivable`/`customer_advance`/
 * `customer_advance_application`/`customer_account_entry`, B8-B11),
 * `customer_company_account` projections (B12), the narrowed Invoice
 * immutability trigger (B13), RLS (B16), the `EQUITY.OPENING_BALANCE`
 * reference account (B17), and permission registration/backfill (B18).
 *
 * Checkpoint B ships schema/RLS/FK/CHECK/trigger structure ONLY — no
 * service/repository/controller/PostingEngine/audit/outbox/realtime code.
 * Nothing here exercises a repository/service/controller; every row is
 * inserted by raw SQL, exactly like `payments-core.integration.test.ts` and
 * `orders-invoice-numbering.integration.test.ts` before it.
 *
 * Uses the plain Testcontainers superuser connection (bypasses RLS as the
 * table owner) for fixture setup and structural/trigger tests — RLS itself
 * is verified separately via `SET ROLE flower_app`.
 */
const TENANT = 'aaaaaaaa-1111-7111-8111-111111111111';
const OTHER_TENANT = 'bbbbbbbb-2222-7222-8222-222222222222';
const COMPANY = 'cccccccc-3333-7333-8333-333333333333';
const BRANCH = 'ffffffff-6666-7666-8666-666666666666';
const BRANCH_2 = '11111111-7777-7777-8777-777777777777'; // same company as BRANCH
const CATEGORY = '22222222-8888-7888-8888-888888888888';
const PRODUCT = '33333333-9999-7999-8999-999999999999';
const VARIANT = '44444444-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = '55555555-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CCA = '66666666-cccc-7ccc-8ccc-cccccccccccc'; // customer_company_account
const OTHER_TENANT_CCA_TENANT = 'dddddddd-4444-7444-8444-444444444444';

describe('packages/db — Task 3b.6 Checkpoint B receivables schema', () => {
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
      [TENANT, 'recv-3b6'],
      [OTHER_TENANT, 'recv-3b6-other'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [id, slug],
      );
    }
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
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── fixture helpers (mirrors payments-core.integration.test.ts) ────────────
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
      [orderId, `ORD-${RUN}-${(++seq).toString().padStart(6, '0')}`],
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
        `INV-${invoiceId.slice(0, 8)}`,
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
    id?: string;
    branchId?: string;
    orderId?: string | null;
    targetInvoiceId?: string | null;
    receiptPurpose?: 'INVOICE_COLLECTION' | 'CUSTOMER_RECEIPT';
    customerCompanyAccountId?: string | null;
    amountMinor?: number;
    state?: string;
  }

  /** INVOICE_COLLECTION by default — mirrors payments-core.integration.test.ts. */
  async function insertAttempt(overrides: AttemptOverrides = {}): Promise<{
    id: string;
    orderId: string | null;
    invoiceId: string | null;
  }> {
    const purpose = overrides.receiptPurpose ?? 'INVOICE_COLLECTION';
    let orderId = overrides.orderId;
    let invoiceId = overrides.targetInvoiceId;
    if (purpose === 'INVOICE_COLLECTION' && (orderId === undefined || invoiceId === undefined)) {
      const fresh = await freshOrderInvoice(
        overrides.branchId !== undefined ? { branchId: overrides.branchId } : {},
      );
      orderId = orderId ?? fresh.orderId;
      invoiceId = invoiceId ?? fresh.invoiceId;
    }
    const id = overrides.id ?? uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "receiptPurpose",
          "customerCompanyAccountId", method, "amountMinor", "currencyCode", "currencyExponent",
          state, "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
          "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CASH',$9,'AED',2,$10,$11,$12,$13, now())`,
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
        overrides.state ?? 'CAPTURED',
        purpose === 'INVOICE_COLLECTION' ? 'fp-attempt' : null,
        purpose === 'INVOICE_COLLECTION' ? 1 : null,
        `idem-${id}`,
      ],
    );
    return { id, orderId: orderId ?? null, invoiceId: invoiceId ?? null };
  }

  async function insertPayment(
    sourceAttemptId: string,
    overrides: { amountMinor?: number; branchId?: string } = {},
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2)`,
      [
        id,
        TENANT,
        COMPANY,
        overrides.branchId ?? BRANCH,
        sourceAttemptId,
        overrides.amountMinor ?? 1000,
      ],
    );
    return id;
  }

  async function insertAllocation(
    paymentId: string,
    invoiceId: string,
    amountMinor: number,
    branchId = BRANCH,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO payment_allocation (id, "tenantId", "companyId", "branchId", "paymentId", "invoiceId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [id, TENANT, COMPANY, branchId, paymentId, invoiceId, amountMinor],
    );
    return id;
  }

  async function insertOpeningReceivable(
    openingAmountMinor: number,
    branchId = BRANCH,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
      [id, TENANT, COMPANY, branchId, CCA, openingAmountMinor],
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

  /** Task 3b.6 Checkpoint F Final Hardening — a fresh, dedicated branch. This
   *  whole describe block's tests share ONE `CCA` (module-level constant);
   *  Checkpoint F's new "at most one opening-balance initialization per
   *  tenant/company/branch/CustomerCompanyAccount" structural trigger means
   *  any two tests that each create an OPENING row on the SAME shared
   *  `CCA`+`BRANCH` now collide. Tests that create an OPENING row use a
   *  freshly minted branch (this helper) purely for that isolation — it is
   *  NOT testing anything about branch scope itself. */
  async function freshBranch(): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1,$2,$3,'Fresh',now())`,
      [id, TENANT, COMPANY],
    );
    return id;
  }

  /** A PAYMENT-sourced Advance (raw SQL, no app-layer conversion primitive
   *  exists at Checkpoint B) — used wherever a test needs an Advance
   *  alongside an OPENING Receivable on the SAME account+branch (Checkpoint
   *  F's new rule forbids an OPENING Advance from coexisting with an OPENING
   *  Receivable on the same account+branch). */
  async function insertPaymentAdvance(amountMinor: number, branchId = BRANCH): Promise<string> {
    const { id: attemptId } = await insertAttempt({
      receiptPurpose: 'CUSTOMER_RECEIPT',
      orderId: null,
      targetInvoiceId: null,
      customerCompanyAccountId: CCA,
      amountMinor,
      branchId,
    });
    const paymentId = await insertPayment(attemptId, { amountMinor, branchId });
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "sourcePaymentId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
      [id, TENANT, COMPANY, branchId, CCA, paymentId, amountMinor],
    );
    return id;
  }

  async function insertOpeningAdvance(amountMinor: number, branchId = BRANCH): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "amountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
       VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
      [id, TENANT, COMPANY, branchId, CCA, amountMinor],
    );
    return id;
  }

  async function insertApplication(
    advanceId: string,
    receivableId: string,
    amountMinor: number,
    branchId = BRANCH,
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO customer_advance_application (id, "tenantId", "companyId", "branchId", "customerAdvanceId", "customerReceivableId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [id, TENANT, COMPANY, branchId, advanceId, receivableId, amountMinor],
    );
    return id;
  }

  // ═══════════════════════ B3/B4 — PaymentAttempt target evolution ══════════
  describe('PaymentAttempt target evolution (B3/B4)', () => {
    it('HG1: an existing-shape (INVOICE_COLLECTION) row backfills/defaults deterministically', async () => {
      const { id } = await insertAttempt();
      const { rows } = await pool.query<{
        receiptPurpose: string;
        customerCompanyAccountId: string | null;
      }>(`SELECT "receiptPurpose", "customerCompanyAccountId" FROM payment_attempt WHERE id = $1`, [
        id,
      ]);
      expect(rows[0]).toEqual({
        receiptPurpose: 'INVOICE_COLLECTION',
        customerCompanyAccountId: null,
      });
    });

    it('HG2: a valid invoice-targeted (INVOICE_COLLECTION) attempt still works end-to-end', async () => {
      const { orderId, invoiceId } = await freshOrderInvoice();
      const { id } = await insertAttempt({ orderId, targetInvoiceId: invoiceId });
      await expect(
        pool.query(
          `SELECT 1 FROM payment_attempt WHERE id = $1 AND "receiptPurpose" = 'INVOICE_COLLECTION'`,
          [id],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it('HG3: a valid CUSTOMER_RECEIPT attempt shape works', async () => {
      await expect(
        insertAttempt({ receiptPurpose: 'CUSTOMER_RECEIPT', customerCompanyAccountId: CCA }),
      ).resolves.toBeTruthy();
    });

    it('HG4: a mixed/invalid XOR target is rejected', async () => {
      const { orderId, invoiceId } = await freshOrderInvoice();
      await expect(
        insertAttempt({
          receiptPurpose: 'CUSTOMER_RECEIPT',
          customerCompanyAccountId: CCA,
          orderId,
          targetInvoiceId: invoiceId,
        }),
      ).rejects.toThrow(/payment_attempt_receipt_purpose_shape_chk/);
      await expect(
        insertAttempt({
          receiptPurpose: 'INVOICE_COLLECTION',
          orderId: null,
          targetInvoiceId: null,
        }),
      ).rejects.toThrow(/payment_attempt_receipt_purpose_shape_chk/);
    });

    it('HG5: a CUSTOMER_RECEIPT attempt referencing a wrong-tenant/company account is rejected', async () => {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, 'recv-wrong-scope', 'x', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())
         ON CONFLICT (id) DO NOTHING`,
        [OTHER_TENANT_CCA_TENANT],
      );
      const otherCompany = uid();
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "updatedAt") VALUES ($1,$2,'Other',NULL, now())`,
        [otherCompany, OTHER_TENANT_CCA_TENANT],
      );
      const otherCustomer = uid();
      await pool.query(
        `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1,$2,'Other Cust', now())`,
        [otherCustomer, OTHER_TENANT_CCA_TENANT],
      );
      const wrongScopeCca = uid();
      await pool.query(
        `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt") VALUES ($1,$2,$3,$4, now())`,
        [wrongScopeCca, OTHER_TENANT_CCA_TENANT, otherCompany, otherCustomer],
      );
      await expect(
        insertAttempt({
          receiptPurpose: 'CUSTOMER_RECEIPT',
          customerCompanyAccountId: wrongScopeCca,
        }),
      ).rejects.toThrow(/violates foreign key|customer_company_account_tenant_company_fkey/);
    });
  });

  // ═══════════════════════ B5/B6/B7 — allocation fan-out + branch + capacity ═
  describe('PaymentAllocation fan-out + branch backstop + capacity (B5/B6/B7)', () => {
    it('HG6: same-tenant/same-company but wrong-branch Invoice allocation is rejected structurally', async () => {
      const { orderId, invoiceId } = await freshOrderInvoice({ branchId: BRANCH }); // invoice on BRANCH
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        branchId: BRANCH_2,
        amountMinor: 500,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 500, branchId: BRANCH_2 });
      await expect(insertAllocation(paymentId, invoiceId, 100, BRANCH_2)).rejects.toThrow(
        /branchId does not match invoice|violates foreign key/,
      );
    });

    it('HG7: one Payment supports multiple PaymentAllocation rows (fan-out)', async () => {
      const { orderId: o1, invoiceId: inv1 } = await freshOrderInvoice({ totalAmountMinor: 1000 });
      const { invoiceId: inv2 } = await freshOrderInvoice({ totalAmountMinor: 1000 });
      const { id: attemptId } = await insertAttempt({
        orderId: o1,
        targetInvoiceId: inv1,
        amountMinor: 150,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 150 });
      await expect(insertAllocation(paymentId, inv1, 50)).resolves.toBeTruthy();
      await expect(insertAllocation(paymentId, inv2, 100)).resolves.toBeTruthy();
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM payment_allocation WHERE "paymentId" = $1`,
        [paymentId],
      );
      expect(rows[0].n).toBe(2);
    });

    it('HG8: aggregate allocations cannot exceed the Payment amount', async () => {
      const { orderId, invoiceId } = await freshOrderInvoice({ totalAmountMinor: 1000 });
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100 });
      await expect(insertAllocation(paymentId, invoiceId, 60)).resolves.toBeTruthy();
      await expect(insertAllocation(paymentId, invoiceId, 41)).rejects.toThrow(
        /consumption would exceed amountMinor/,
      );
      await expect(insertAllocation(paymentId, invoiceId, 40)).resolves.toBeTruthy(); // boundary: exactly 100
    });

    it('HG9: allocation-vs-allocation concurrency — Payment=100, concurrent 60+60 -> exactly one succeeds', async () => {
      const { orderId: o1, invoiceId: inv1 } = await freshOrderInvoice({ totalAmountMinor: 1000 });
      const { invoiceId: inv2 } = await freshOrderInvoice({ totalAmountMinor: 1000 });
      const { id: attemptId } = await insertAttempt({
        orderId: o1,
        targetInvoiceId: inv1,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100 });
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, BRANCH, paymentId, inv1],
          ),
          c2.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, BRANCH, paymentId, inv2],
          ),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM("amountMinor"),0)::int AS n FROM payment_allocation WHERE "paymentId" = $1`,
          [paymentId],
        );
        expect(rows[0].n).toBeLessThanOrEqual(100);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('HG10: allocation-vs-Advance concurrency — Payment=100, concurrent allocation 60 + advance 60 -> exactly one succeeds', async () => {
      const { orderId, invoiceId } = await freshOrderInvoice({ totalAmountMinor: 1000 });
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100 });
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, BRANCH, paymentId, invoiceId],
          ),
          c2.query(
            `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, BRANCH, CCA, paymentId],
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

  // ═══════════════════════ B9 — CustomerAdvance ═══════════════════════════════
  describe('CustomerAdvance (B9)', () => {
    it('HG11: a Payment-funded Advance with wrong scope/currency/branch is rejected', async () => {
      const { orderId, invoiceId } = await freshOrderInvoice({ totalAmountMinor: 1000 });
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        amountMinor: 200,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 200 });
      // wrong branch on the advance row itself
      await expect(
        pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,50,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH_2, CCA, paymentId],
        ),
      ).rejects.toThrow(/does not match its sourcePayment|violates foreign key/);
      // wrong currency
      await expect(
        pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,50,'SAR',2)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA, paymentId],
        ),
      ).rejects.toThrow(/does not match its sourcePayment|violates foreign key|currency/);
    });

    it('HG12: an OPENING advance must have a NULL sourcePaymentId', async () => {
      const { orderId, invoiceId } = await freshOrderInvoice();
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100 });
      await expect(
        pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,'OPENING',$6,50,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA, paymentId],
        ),
      ).rejects.toThrow(/customer_advance_source_shape_chk/);
    });

    it('HG13: a PAYMENT-sourced advance must have a NON-NULL sourcePaymentId', async () => {
      // rejected by the BEFORE INSERT trigger's own existence check first (it
      // fires before CHECK constraints are validated at heap-insert time) —
      // `customer_advance_source_shape_chk` is the same invariant's backstop
      // for any insertion path that bypasses the trigger's own lookup.
      await expect(
        pool.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,'PAYMENT',50,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA],
        ),
      ).rejects.toThrow(
        /referenced sourcePaymentId <NULL> does not exist|customer_advance_source_shape_chk/,
      );
    });
  });

  // ═══════════════════════ B10/B14 — CustomerAdvanceApplication ══════════════
  describe('CustomerAdvanceApplication (B10/B14)', () => {
    it('HG14: application cannot exceed the Advance principal', async () => {
      const b = await freshBranch();
      const advanceId = await insertPaymentAdvance(100, b);
      const receivableId = await insertOpeningReceivable(1000, b);
      await expect(insertApplication(advanceId, receivableId, 60, b)).resolves.toBeTruthy();
      await expect(insertApplication(advanceId, receivableId, 41, b)).rejects.toThrow(
        /application would exceed amountMinor/,
      );
      await expect(insertApplication(advanceId, receivableId, 40, b)).resolves.toBeTruthy(); // boundary
    });

    it('HG15: concurrent applications cannot double-spend — Advance=100, concurrent 60+60 -> exactly one succeeds', async () => {
      const b = await freshBranch();
      const advanceId = await insertPaymentAdvance(100, b);
      const r1 = await insertOpeningReceivable(1000, b);
      const { invoiceId } = await freshOrderInvoice({ branchId: b, totalAmountMinor: 1000 });
      const r2 = await insertInvoiceReceivable(invoiceId, b);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, advanceId, r1],
          ),
          c2.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, advanceId, r2],
          ),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('HG16: application with wrong company/customer/currency is rejected', async () => {
      const b = await freshBranch();
      const advanceId = await insertPaymentAdvance(500, b);
      const receivableId = await insertOpeningReceivable(500, b);
      // wrong currency
      await expect(
        pool.query(
          `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,50,'SAR',2)`,
          [uid(), TENANT, COMPANY, b, advanceId, receivableId],
        ),
      ).rejects.toThrow(/currency does not match customerAdvance/);
      // different customer account -> different receivable's account mismatch
      const otherCustomer = uid();
      await pool.query(
        `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1,$2,'Other', now())`,
        [otherCustomer, TENANT],
      );
      const otherCca = uid();
      await pool.query(
        `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt") VALUES ($1,$2,$3,$4, now())`,
        [otherCca, TENANT, COMPANY, otherCustomer],
      );
      const otherReceivable = uid();
      await pool.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate") VALUES ($1,$2,$3,$4,$5,'OPENING',500,'AED',2,'2026-01-05')`,
        [otherReceivable, TENANT, COMPANY, b, otherCca],
      );
      await expect(
        pool.query(
          `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,50,'AED',2)`,
          [uid(), TENANT, COMPANY, b, advanceId, otherReceivable],
        ),
      ).rejects.toThrow(/account does not match/);
    });
  });

  // ═══════════════════════ B14 — coverage backstops ══════════════════════════
  describe('Invoice / opening-receivable over-coverage backstops (B14)', () => {
    it('HG17: combined PaymentAllocation + CustomerAdvanceApplication coverage cannot exceed Invoice total', async () => {
      const b = await freshBranch();
      const { orderId, invoiceId } = await freshOrderInvoice({
        branchId: b,
        totalAmountMinor: 100,
      });
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        branchId: b,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100, branchId: b });
      await expect(insertAllocation(paymentId, invoiceId, 60, b)).resolves.toBeTruthy();
      const receivableId = await insertInvoiceReceivable(invoiceId, b);
      const advanceId = await insertOpeningAdvance(100, b);
      await expect(insertApplication(advanceId, receivableId, 41, b)).rejects.toThrow(
        /coverage would exceed totalAmountMinor/,
      );
      await expect(insertApplication(advanceId, receivableId, 40, b)).resolves.toBeTruthy(); // boundary: 60+40=100
    });

    it('HG18: OPENING receivable coverage cannot exceed its opening principal', async () => {
      const b = await freshBranch();
      const receivableId = await insertOpeningReceivable(100, b);
      const advanceId = await insertPaymentAdvance(1000, b);
      await expect(insertApplication(advanceId, receivableId, 60, b)).resolves.toBeTruthy();
      await expect(insertApplication(advanceId, receivableId, 41, b)).rejects.toThrow(
        /OPENING\) coverage would exceed openingAmountMinor/,
      );
      await expect(insertApplication(advanceId, receivableId, 40, b)).resolves.toBeTruthy(); // boundary
    });

    // Hardening-pass gate (item 7): HG9 above deliberately reused the SAME
    // Payment for both concurrent allocations, so its rejection is ambiguous
    // — it could be the Invoice lock OR the Payment-capacity lock doing the
    // serializing. This test uses TWO DIFFERENT, independently-fully-capacity
    // Payments against the SAME Invoice, so Payment-capacity locking cannot
    // possibly be what blocks the second insert — only the Invoice row lock
    // itself (`fn_lock_and_validate_invoice_coverage`) can be responsible.
    it('HG17b: different-Payments, same-Invoice coverage race — Invoice=100, concurrent 60 (PaymentA) + 60 (PaymentB) -> exactly one succeeds', async () => {
      // Invoice X is the one under test. PaymentA/PaymentB are each collected
      // against their OWN, unrelated Order/Invoice (a PaymentAttempt's
      // targetInvoiceId must belong to its own orderId — the FK backstop
      // proven in HG2) and then fanned out (B5) to allocate against Invoice X
      // — a legitimate, independent-funding-source shape.
      const { invoiceId } = await freshOrderInvoice({ totalAmountMinor: 100 }); // Invoice X
      const { orderId: orderA, invoiceId: invoiceA } = await freshOrderInvoice({
        totalAmountMinor: 100,
      });
      const { id: attemptA } = await insertAttempt({
        orderId: orderA,
        targetInvoiceId: invoiceA,
        amountMinor: 100,
      });
      const paymentA = await insertPayment(attemptA, { amountMinor: 100 });
      const { orderId: orderB, invoiceId: invoiceB } = await freshOrderInvoice({
        totalAmountMinor: 100,
      });
      const { id: attemptB } = await insertAttempt({
        orderId: orderB,
        targetInvoiceId: invoiceB,
        amountMinor: 100,
      });
      const paymentB = await insertPayment(attemptB, { amountMinor: 100 });
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, BRANCH, paymentA, invoiceId],
          ),
          c2.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, BRANCH, paymentB, invoiceId],
          ),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM("amountMinor"),0)::int AS n FROM payment_allocation WHERE "invoiceId" = $1`,
          [invoiceId],
        );
        expect(rows[0].n).toBeLessThanOrEqual(100);
      } finally {
        c1.release();
        c2.release();
      }
    });

    // Hardening-pass gate (item 8): PaymentAllocation and
    // CustomerAdvanceApplication draw from entirely independent funding
    // sources (a Payment vs. an Advance) — neither the Payment-capacity lock
    // nor the Advance-capacity lock can serialize this race. Only the shared
    // Invoice row lock (both paths call `fn_lock_and_validate_invoice_coverage`
    // against the SAME invoice id) can be what protects combined coverage.
    it('HG17c: PaymentAllocation-vs-CustomerAdvanceApplication same-Invoice race -> exactly one succeeds', async () => {
      const b = await freshBranch();
      const { orderId, invoiceId } = await freshOrderInvoice({
        branchId: b,
        totalAmountMinor: 100,
      });
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        branchId: b,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100, branchId: b });
      const receivableId = await insertInvoiceReceivable(invoiceId, b);
      const advanceId = await insertOpeningAdvance(100, b);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, paymentId, invoiceId],
          ),
          c2.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, advanceId, receivableId],
          ),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const { rows: allocRows } = await pool.query(
          `SELECT COALESCE(SUM("amountMinor"),0)::int AS n FROM payment_allocation WHERE "invoiceId" = $1`,
          [invoiceId],
        );
        const { rows: appRows } = await pool.query(
          `SELECT COALESCE(SUM("amountMinor"),0)::int AS n FROM customer_advance_application WHERE "customerReceivableId" = $1`,
          [receivableId],
        );
        expect(allocRows[0].n + appRows[0].n).toBeLessThanOrEqual(100);
      } finally {
        c1.release();
        c2.release();
      }
    });

    // Hardening-pass gate (item 9): HG15 above used the SAME receivable
    // target ambiguity check for Advance capacity (same Advance, two
    // DIFFERENT receivables). This is the mirror case: the SAME Opening
    // Receivable, applications funded from TWO DIFFERENT Advances — the
    // Advance-capacity lock (on either Advance individually) cannot
    // serialize this; only the receivable's own coverage lock
    // (`fn_lock_and_validate_opening_receivable_coverage`) can.
    it('HG18b: two different Advances applying to the SAME Opening Receivable concurrently -> exactly one succeeds', async () => {
      const b = await freshBranch();
      const receivableId = await insertOpeningReceivable(100, b);
      const advanceA = await insertPaymentAdvance(60, b);
      const advanceB = await insertPaymentAdvance(60, b);
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.allSettled([
          c1.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, advanceA, receivableId],
          ),
          c2.query(
            `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent") VALUES ($1,$2,$3,$4,$5,$6,60,'AED',2)`,
            [uid(), TENANT, COMPANY, b, advanceB, receivableId],
          ),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM("amountMinor"),0)::int AS n FROM customer_advance_application WHERE "customerReceivableId" = $1`,
          [receivableId],
        );
        expect(rows[0].n).toBeLessThanOrEqual(100);
      } finally {
        c1.release();
        c2.release();
      }
    });
  });

  // ═══════════════════════ B8 — CustomerReceivable shape ═════════════════════
  describe('CustomerReceivable shape (B8)', () => {
    it('HG19: an INVOICE-sourced receivable with a valid shape is accepted', async () => {
      const { invoiceId } = await freshOrderInvoice();
      await expect(insertInvoiceReceivable(invoiceId)).resolves.toBeTruthy();
    });

    it('HG20: an OPENING-sourced receivable with a valid shape is accepted', async () => {
      const b = await freshBranch();
      await expect(insertOpeningReceivable(750, b)).resolves.toBeTruthy();
    });

    it('HG21: an invalid mixed source shape is rejected', async () => {
      const { invoiceId } = await freshOrderInvoice();
      await expect(
        pool.query(
          `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized","openingAmountMinor") VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true,100)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA, invoiceId],
        ),
      ).rejects.toThrow(/customer_receivable_source_shape_chk/);
      await expect(
        pool.query(
          `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor") VALUES ($1,$2,$3,$4,$5,'OPENING',100)`,
          [uid(), TENANT, COMPANY, BRANCH, CCA],
        ),
      ).rejects.toThrow(/customer_receivable_source_shape_chk/);
    });

    it('a walk-in Invoice (no customer on its Order) can never get a CustomerReceivable', async () => {
      const { invoiceId } = await freshOrderInvoice({ customerId: null });
      await expect(insertInvoiceReceivable(invoiceId)).rejects.toThrow(/walk-in/);
    });
  });

  // ═══════════════════════ append-only — B8-B11 ══════════════════════════════
  describe('append-only — UPDATE/DELETE unconditionally blocked (B8-B11)', () => {
    it('HG22/HG23: customer_receivable rejects UPDATE and DELETE', async () => {
      const b = await freshBranch();
      const id = await insertOpeningReceivable(100, b);
      await expect(
        pool.query(`UPDATE customer_receivable SET "openingAmountMinor" = 1 WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(`DELETE FROM customer_receivable WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
    });

    it('HG22/HG23: customer_advance rejects UPDATE and DELETE', async () => {
      const b = await freshBranch();
      const id = await insertOpeningAdvance(100, b);
      await expect(
        pool.query(`UPDATE customer_advance SET "amountMinor" = 1 WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await expect(pool.query(`DELETE FROM customer_advance WHERE id = $1`, [id])).rejects.toThrow(
        /append-only/,
      );
    });

    it('HG22/HG23: customer_advance_application rejects UPDATE and DELETE', async () => {
      const b = await freshBranch();
      const advanceId = await insertPaymentAdvance(100, b);
      const receivableId = await insertOpeningReceivable(100, b);
      const id = await insertApplication(advanceId, receivableId, 10, b);
      await expect(
        pool.query(`UPDATE customer_advance_application SET "amountMinor" = 1 WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(`DELETE FROM customer_advance_application WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
    });

    it('HG22/HG23: customer_account_entry rejects UPDATE and DELETE', async () => {
      const b = await freshBranch();
      const receivableId = await insertOpeningReceivable(100, b);
      const id = uid();
      await pool.query(
        `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivableId") VALUES ($1,$2,$3,$4,$5,'OPENING_RECEIVABLE',$6)`,
        [id, TENANT, COMPANY, b, CCA, receivableId],
      );
      await expect(
        pool.query(`UPDATE customer_account_entry SET "entryKind" = 'PAYMENT' WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(`DELETE FROM customer_account_entry WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
    });
  });

  // ═══════════════════════ B11 — CustomerAccountEntry ════════════════════════
  describe('CustomerAccountEntry XOR + cross-sourceType (B11)', () => {
    it('HG24: exactly one reference column may be populated', async () => {
      const b = await freshBranch();
      const receivableId = await insertOpeningReceivable(100, b);
      const { orderId, invoiceId } = await freshOrderInvoice({ branchId: b });
      const { id: attemptId } = await insertAttempt({
        orderId,
        targetInvoiceId: invoiceId,
        branchId: b,
        amountMinor: 100,
      });
      const paymentId = await insertPayment(attemptId, { amountMinor: 100, branchId: b });
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivableId","paymentId") VALUES ($1,$2,$3,$4,$5,'OPENING_RECEIVABLE',$6,$7)`,
          [uid(), TENANT, COMPANY, b, CCA, receivableId, paymentId],
        ),
      ).rejects.toThrow(/customer_account_entry_reference_xor_chk/);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind") VALUES ($1,$2,$3,$4,$5,'PAYMENT')`,
          [uid(), TENANT, COMPANY, b, CCA],
        ),
      ).rejects.toThrow(/customer_account_entry_reference_xor_chk/);
    });

    it("HG25: entryKind must match the referenced row's own sourceType", async () => {
      const b1 = await freshBranch();
      const openingReceivableId = await insertOpeningReceivable(100, b1);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivableId") VALUES ($1,$2,$3,$4,$5,'INVOICE',$6)`,
          [uid(), TENANT, COMPANY, b1, CCA, openingReceivableId],
        ),
      ).rejects.toThrow(/entryKind INVOICE requires customerReceivable.*sourceType = INVOICE/);

      const b2 = await freshBranch();
      const openingAdvanceId = await insertOpeningAdvance(100, b2);
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerAdvanceId") VALUES ($1,$2,$3,$4,$5,'ADVANCE',$6)`,
          [uid(), TENANT, COMPANY, b2, CCA, openingAdvanceId],
        ),
      ).rejects.toThrow(/entryKind ADVANCE requires customerAdvance.*sourceType = PAYMENT/);
    });

    it('HG26: at most one chronology entry may exist per authoritative source row', async () => {
      const b = await freshBranch();
      const receivableId = await insertOpeningReceivable(100, b);
      await pool.query(
        `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivableId") VALUES ($1,$2,$3,$4,$5,'OPENING_RECEIVABLE',$6)`,
        [uid(), TENANT, COMPANY, b, CCA, receivableId],
      );
      await expect(
        pool.query(
          `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerReceivableId") VALUES ($1,$2,$3,$4,$5,'OPENING_RECEIVABLE',$6)`,
          [uid(), TENANT, COMPANY, b, CCA, receivableId],
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  // ═══════════════════════ B12 — CustomerCompanyAccount projections ══════════
  describe('CustomerCompanyAccount projections (B12)', () => {
    it('HG27: a negative projection value is rejected', async () => {
      await expect(
        pool.query(
          `UPDATE customer_company_account SET "currentOutstandingMinor" = -1 WHERE id = $1`,
          [CCA],
        ),
      ).rejects.toThrow(/customer_company_account_outstanding_nonneg_chk/);
      await expect(
        pool.query(`UPDATE customer_company_account SET "advanceBalanceMinor" = -1 WHERE id = $1`, [
          CCA,
        ]),
      ).rejects.toThrow(/customer_company_account_advance_balance_nonneg_chk/);
    });

    it('existing rows backfill to exactly zero', async () => {
      const { rows } = await pool.query(
        `SELECT "currentOutstandingMinor"::text AS o, "advanceBalanceMinor"::text AS a FROM customer_company_account WHERE id = $1`,
        [CCA],
      );
      expect(rows[0]).toEqual({ o: '0', a: '0' });
    });
  });

  // ═══════════════════════ B13 — Invoice payment-status immutability ════════
  describe('Invoice invoicePaymentStatus immutability (B13)', () => {
    it('HG28: an invoicePaymentStatus-only UPDATE succeeds', async () => {
      const { invoiceId } = await freshOrderInvoice();
      await expect(
        pool.query(`UPDATE invoice SET "invoicePaymentStatus" = 'PARTIAL' WHERE id = $1`, [
          invoiceId,
        ]),
      ).resolves.toBeTruthy();
    });

    it('HG29: invoicePaymentStatus + another field together is rejected', async () => {
      const { invoiceId } = await freshOrderInvoice();
      await expect(
        pool.query(
          `UPDATE invoice SET "invoicePaymentStatus" = 'PAID', "totalAmountMinor" = 1 WHERE id = $1`,
          [invoiceId],
        ),
      ).rejects.toThrow(/only invoicePaymentStatus may change/);
    });

    it('HG30: any other single Invoice field alone is rejected', async () => {
      const { invoiceId } = await freshOrderInvoice();
      await expect(
        pool.query(`UPDATE invoice SET "totalAmountMinor" = 1 WHERE id = $1`, [invoiceId]),
      ).rejects.toThrow(/only invoicePaymentStatus may change/);
    });

    it('HG31: Invoice DELETE remains unconditionally blocked', async () => {
      const { invoiceId } = await freshOrderInvoice();
      await expect(pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId])).rejects.toThrow(
        /immutable/,
      );
    });
  });

  // ═══════════════════════ B16 — RLS ══════════════════════════════════════════
  describe('RLS — cross-tenant isolation (B16)', () => {
    const TABLES = [
      'customer_receivable',
      'customer_advance',
      'customer_advance_application',
      'customer_account_entry',
    ];

    it('HG32: every new table has RLS ENABLE + FORCE + a policy', async () => {
      const { rows } = await pool.query<{
        relname: string;
        rls: boolean;
        force: boolean;
        policies: number;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.relname = ANY($1)`,
        [TABLES],
      );
      expect(rows).toHaveLength(TABLES.length);
      for (const r of rows) {
        expect(r.rls, `${r.relname} RLS`).toBe(true);
        expect(r.force, `${r.relname} FORCE`).toBe(true);
        expect(Number(r.policies), `${r.relname} policy`).toBeGreaterThanOrEqual(1);
      }
    });

    it('HG32: another tenant sees zero rows on every new table; own tenant sees its own rows', async () => {
      const b = await freshBranch();
      await insertOpeningReceivable(100, b); // ensure at least one row exists for TENANT
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE flower_app`);
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [OTHER_TENANT]);
        for (const t of TABLES) {
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM "${t}"`);
          expect(rows[0].n, `${t} cross-tenant leak`).toBe(0);
        }
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM customer_receivable`);
        expect(rows[0].n).toBeGreaterThan(0);
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
    });
  });

  // ═════ Checkpoint F ABSOLUTE FINAL FREEZE GATE §11 — ticket write-surface ═══
  describe('customer_opening_balance_init write surface (flower_app must never write it directly)', () => {
    it('HG36.A/B/C/D: flower_app cannot INSERT/UPDATE/DELETE/SELECT the ticket table directly, but the SAME app role successfully claims it through a real OPENING insert (SECURITY DEFINER auto-claim trigger)', async () => {
      const b = await freshBranch();
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE flower_app`);
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);

        // A — direct INSERT denied
        await expect(
          c.query(
            `INSERT INTO customer_opening_balance_init (id,"tenantId","companyId","branchId","customerCompanyAccountId","openingType")
             VALUES (uuidv7(),$1,$2,$3,$4,'RECEIVABLE')`,
            [TENANT, COMPANY, b, CCA],
          ),
        ).rejects.toThrow(/permission denied/i);

        // B — direct UPDATE denied (a no-op WHERE is fine; the grant check
        // happens before any row is matched)
        await expect(
          c.query(`UPDATE customer_opening_balance_init SET "openingType"='ADVANCE' WHERE false`),
        ).rejects.toThrow(/permission denied/i);

        // C — direct DELETE denied
        await expect(
          c.query(`DELETE FROM customer_opening_balance_init WHERE false`),
        ).rejects.toThrow(/permission denied/i);

        // D — direct SELECT denied (no application code anywhere reads this
        // table; the grant was fully revoked, not merely write-restricted)
        await expect(c.query(`SELECT count(*) FROM customer_opening_balance_init`)).rejects.toThrow(
          /permission denied/i,
        );

        // E — but a real OPENING insert (the ONLY legitimate path) still
        // succeeds as the SAME flower_app role, because the auto-claim
        // trigger runs SECURITY DEFINER as its owner, not as the invoker.
        await expect(
          c.query(
            `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
             VALUES (uuidv7(),$1,$2,$3,$4,'OPENING',500,'AED',2,'2026-01-05')`,
            [TENANT, COMPANY, b, CCA],
          ),
        ).resolves.toBeTruthy();
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }

      // F — verified as the (superuser) test pool: the ticket really was
      // claimed by the trigger despite flower_app having zero direct grants.
      const { rows } = await pool.query(
        `SELECT "openingType" FROM customer_opening_balance_init WHERE "branchId" = $1`,
        [b],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].openingType).toBe('RECEIVABLE');
    });

    it('HG37: the SAME SECURITY DEFINER auto-claim path also works for an OPENING Advance as flower_app', async () => {
      const b = await freshBranch();
      const c = await pool.connect();
      try {
        await c.query(`SET ROLE flower_app`);
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
        await expect(
          c.query(
            `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
             VALUES (uuidv7(),$1,$2,$3,$4,'OPENING',300,'AED',2,'2026-01-05')`,
            [TENANT, COMPANY, b, CCA],
          ),
        ).resolves.toBeTruthy();
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
      const { rows } = await pool.query(
        `SELECT "openingType" FROM customer_opening_balance_init WHERE "branchId" = $1`,
        [b],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].openingType).toBe('ADVANCE');
    });
  });

  // ═══════════════════════ B17 — EQUITY.OPENING_BALANCE ═══════════════════════
  describe('EQUITY.OPENING_BALANCE reference account (B17)', () => {
    it('HG34/HG35: ACCOUNTING_REFERENCE_ACCOUNTS has exactly 15 rows, 14 unchanged + 1 new EQUITY.OPENING_BALANCE', async () => {
      expect(ACCOUNTING_REFERENCE_ACCOUNTS).toHaveLength(15);
      const openingBalance = ACCOUNTING_REFERENCE_ACCOUNTS.find(
        (a) => a.key === 'EQUITY.OPENING_BALANCE',
      );
      expect(openingBalance).toEqual({
        key: 'EQUITY.OPENING_BALANCE',
        category: 'EQUITY',
        defaultDisplayCode: '3100',
        defaultDisplayName: 'Opening Balance Equity',
      });
      // every pre-existing key/category/code is untouched
      const priorKeys: Array<[string, string, string]> = [
        ['ASSET.CASH_ON_HAND', 'ASSET', '1000'],
        ['ASSET.BANK', 'ASSET', '1100'],
        ['ASSET.PAYMENT_CLEARING', 'ASSET', '1200'],
        ['ASSET.ACCOUNTS_RECEIVABLE', 'ASSET', '1300'],
        ['LIABILITY.CUSTOMER_ADVANCES', 'LIABILITY', '2000'],
        ['LIABILITY.UNAPPLIED_RECEIPTS', 'LIABILITY', '2050'],
        ['LIABILITY.TAX_PAYABLE', 'LIABILITY', '2100'],
        ['LIABILITY.REFUND_PAYABLE', 'LIABILITY', '2200'],
        ['EQUITY.RETAINED_EARNINGS', 'EQUITY', '3000'],
        ['REVENUE.SALES', 'REVENUE', '4000'],
        ['REVENUE.CANCELLATION_CHARGE', 'REVENUE', '4100'],
        ['CONTRA_REVENUE.SALES_DISCOUNT', 'CONTRA_REVENUE', '4900'],
        ['CONTRA_REVENUE.SETTLEMENT_DISCOUNT', 'CONTRA_REVENUE', '4910'],
        ['EXPENSE.RECEIVABLE_WRITE_OFF', 'EXPENSE', '5000'],
      ];
      for (const [key, category, code] of priorKeys) {
        const row = ACCOUNTING_REFERENCE_ACCOUNTS.find((a) => a.key === key);
        expect(row, `${key} missing`).toBeTruthy();
        expect(row!.category).toBe(category);
        expect(row!.defaultDisplayCode).toBe(code);
      }
    });

    it('HG34: the backfill migration seeds EQUITY.OPENING_BALANCE for a pre-existing company, idempotently', async () => {
      const preexistingTenant = uid();
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt") VALUES ($1,'recv-bf','recv-bf','AE','ACTIVE','00000000-0000-7000-8000-000000000002', now())`,
        [preexistingTenant],
      );
      const preexistingCompany = uid();
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "updatedAt") VALUES ($1,$2,'Pre-existing Co','AED', now())`,
        [preexistingCompany, preexistingTenant],
      );
      // re-run the migration's exact backfill statement (`20260928130000_receivables_opening_balance_account/migration.sql`)
      const backfill = `
        ALTER TABLE "account" NO FORCE ROW LEVEL SECURITY;
        INSERT INTO "account" ("id", "tenantId", "companyId", "key", "category", "displayCode", "displayName", "updatedAt")
        SELECT uuidv7(), c."tenantId", c."id", 'EQUITY.OPENING_BALANCE', 'EQUITY', '3100', 'Opening Balance Equity', now()
          FROM "company" c WHERE c."id" = '${preexistingCompany}'
        ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING;
        ALTER TABLE "account" FORCE ROW LEVEL SECURITY;`;
      await pool.query(backfill);
      await pool.query(backfill); // twice — must not create duplicates
      const { rows } = await pool.query(
        `SELECT "category", "displayCode", "displayName" FROM account WHERE "companyId" = $1 AND "key" = 'EQUITY.OPENING_BALANCE'`,
        [preexistingCompany],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        category: 'EQUITY',
        displayCode: '3100',
        displayName: 'Opening Balance Equity',
      });
    });
  });

  // ═══════════════════════ B18 — permissions ═════════════════════════════════
  describe('receivables permissions role backfill (B18)', () => {
    it('HG33: owner/admin get all 4 keys, manager gets 3 (no opening_balance:manage), cashier/sales get 2, other roles get none, backfill is idempotent', async () => {
      const T = uid();
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1,'recv-perm-bf','recv-perm-bf','AE','ACTIVE','00000000-0000-7000-8000-000000000002', now())`,
        [T],
      );
      const roleIds: Record<string, string> = {};
      for (const key of ['owner', 'admin', 'manager', 'cashier', 'sales', 'supervisor']) {
        const r = await pool.query(
          `INSERT INTO role (id,"tenantId",key,name,"isSystem","updatedAt") VALUES (uuidv7(),$1,$2,$2,true, now()) RETURNING id`,
          [T, key],
        );
        roleIds[key] = r.rows[0].id;
      }
      const backfill = `
        ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;
        INSERT INTO "role_permission" ("id","tenantId","roleId","permissionKey")
        SELECT uuidv7(), r."tenantId", r."id", k.key
          FROM "role" r CROSS JOIN (VALUES ('receivables:view'), ('receivables:collect')) AS k(key)
         WHERE r."isSystem" = true AND r."key" IN ('owner', 'admin', 'manager', 'cashier', 'sales') AND r."tenantId" = '${T}'
        ON CONFLICT ("roleId","permissionKey") DO NOTHING;
        INSERT INTO "role_permission" ("id","tenantId","roleId","permissionKey")
        SELECT uuidv7(), r."tenantId", r."id", 'receivables:advance:apply'
          FROM "role" r WHERE r."isSystem" = true AND r."key" IN ('owner', 'admin', 'manager') AND r."tenantId" = '${T}'
        ON CONFLICT ("roleId","permissionKey") DO NOTHING;
        INSERT INTO "role_permission" ("id","tenantId","roleId","permissionKey")
        SELECT uuidv7(), r."tenantId", r."id", 'receivables:opening_balance:manage'
          FROM "role" r WHERE r."isSystem" = true AND r."key" IN ('owner', 'admin') AND r."tenantId" = '${T}'
        ON CONFLICT ("roleId","permissionKey") DO NOTHING;
        ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
        ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;`;
      await pool.query(backfill);
      await pool.query(backfill); // twice — must not create duplicates

      const perms = async (roleId: string): Promise<string[]> =>
        (
          await pool.query<{ permissionKey: string }>(
            `SELECT "permissionKey" FROM "role_permission" WHERE "roleId" = $1 ORDER BY "permissionKey"`,
            [roleId],
          )
        ).rows.map((r) => r.permissionKey);

      expect(await perms(roleIds['owner']!)).toEqual([
        'receivables:advance:apply',
        'receivables:collect',
        'receivables:opening_balance:manage',
        'receivables:view',
      ]);
      expect(await perms(roleIds['admin']!)).toEqual([
        'receivables:advance:apply',
        'receivables:collect',
        'receivables:opening_balance:manage',
        'receivables:view',
      ]);
      expect(await perms(roleIds['manager']!)).toEqual([
        'receivables:advance:apply',
        'receivables:collect',
        'receivables:view',
      ]);
      expect(await perms(roleIds['cashier']!)).toEqual(['receivables:collect', 'receivables:view']);
      expect(await perms(roleIds['sales']!)).toEqual(['receivables:collect', 'receivables:view']);
      expect(await perms(roleIds['supervisor']!)).toEqual([]);
    });

    it('the 4 receivables:* keys are registered in permission_registry exactly once each', async () => {
      const { rows } = await pool.query<{ key: string; groupKey: string }>(
        `SELECT "key", "groupKey" FROM permission_registry WHERE "key" LIKE 'receivables:%' ORDER BY "key"`,
      );
      expect(rows.map((r) => r.key)).toEqual([
        'receivables:advance:apply',
        'receivables:collect',
        'receivables:opening_balance:manage',
        'receivables:view',
      ]);
      for (const r of rows) expect(r.groupKey).toBe('receivables');
    });
  });
});
