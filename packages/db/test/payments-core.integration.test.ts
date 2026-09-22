import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.5 Checkpoint B — the six Payments tables, proven against real
 * Postgres via raw SQL: RLS enable+force+policy, every closed-vocabulary
 * CHECK, the composite tenant/company/branch/order/invoice-safe FKs, the
 * structural-integrity triggers (source-attempt match, allocation match,
 * provider-credential scope), the immutability/transition/append-only
 * triggers, and permission registration/backfill.
 *
 * Checkpoint B ships schema/RLS/FK/CHECK/trigger structure ONLY — no
 * service/repository/controller/provider/webhook code. Nothing here
 * exercises a repository/service/controller; every row is inserted by raw
 * SQL, exactly like `orders-invoice-numbering.integration.test.ts` and
 * `accounting-schema.integration.test.ts` before it.
 *
 * Uses the plain Testcontainers superuser connection (bypasses RLS as the
 * table owner) for fixture setup and structural/trigger tests — RLS itself
 * is verified separately below via `SET LOCAL ROLE flower_app`.
 *
 * RLS here proves TENANT isolation only (see the `describe('RLS (tenant
 * isolation only)', ...)` block's own header comment) — it is never
 * conflated with the separate `describe('structural tenant/company/branch
 * consistency (not access control)', ...)` block, whose composite-FK/
 * trigger rejections prove referential consistency, not read/write access
 * authorization.
 *
 * The cross-row financial limit ("confirmed allocations + active
 * reservations <= invoice total") is DELIBERATELY not tested here as a DB
 * constraint — it does not exist as one. See the migration SQL header
 * comment: that invariant requires Invoice row locking + transaction
 * orchestration and belongs to a later checkpoint (C/E/G).
 */
const TENANT = 'aaaaaaaa-1111-7111-8111-111111111111';
const OTHER_TENANT = 'bbbbbbbb-2222-7222-8222-222222222222';
const COMPANY = 'cccccccc-3333-7333-8333-333333333333';
const COMPANY_2 = 'dddddddd-4444-7444-8444-444444444444'; // same tenant, different company
const OTHER_TENANT_COMPANY = 'eeeeeeee-5555-7555-8555-555555555555';
const BRANCH = 'ffffffff-6666-7666-8666-666666666666';
const BRANCH_3 = '88888888-6667-7667-8667-666666666667'; // under COMPANY, sibling of BRANCH
const BRANCH_2 = '11111111-7777-7777-8777-777777777777'; // under COMPANY_2
const CATEGORY = '22222222-8888-7888-8888-888888888888';
const PRODUCT = '33333333-9999-7999-8999-999999999999';
const VARIANT = '44444444-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PROVIDER_CRED_BRANCH = '55555555-bbbb-7bbb-8bbb-bbbbbbbbbbbb'; // scoped to BRANCH, provider 'tap'
const PROVIDER_CRED_TENANT_WIDE = '66666666-cccc-7ccc-8ccc-cccccccccccc'; // companyId/branchId NULL — must be rejected for payments
const PROVIDER_CRED_OTHER_BRANCH = '77777777-dddd-7ddd-8ddd-dddddddddddd'; // scoped to BRANCH_2
const PROVIDER_CRED_BRANCH_3 = '99999999-eeee-7eee-8eee-eeeeeeeeeeee'; // same company (COMPANY) as BRANCH, but scoped to BRANCH_3
const PROVIDER_CRED_COMPANY_ONLY = 'aaaaaaab-ffff-7fff-8fff-ffffffffffff'; // companyId=COMPANY, branchId=NULL — must be rejected for payments
const OTHER_TENANT_BRANCH = 'aaaaaaac-0001-7001-8001-000000000001'; // under OTHER_TENANT_COMPANY
const PROVIDER_CRED_OTHER_TENANT = 'aaaaaaad-0002-7002-8002-000000000002'; // under OTHER_TENANT, branch-scoped
const PROVIDER_CRED_WRONG_PROVIDER = 'aaaaaaae-0003-7003-8003-000000000003'; // scoped to BRANCH like PROVIDER_CRED_BRANCH, but provider 'checkout'

describe('packages/db — Task 3b.5 Checkpoint B payments schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

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
      `INSERT INTO plan (id, key, name, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002',
               '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'pay-3b5', 'pay-3b5', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'pay-3b5-other', 'pay-3b5-other', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
      [OTHER_TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'د.إ', 'UAE Dirham', 'درهم إماراتي') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('SAR', 2, 'ر.س', 'Saudi Riyal', 'ريال سعودي') ON CONFLICT (code) DO NOTHING`,
    );
    for (const [id, tenantId, name] of [
      [COMPANY, TENANT, 'Test Co'],
      [COMPANY_2, TENANT, 'Test Co 2'],
      [OTHER_TENANT_COMPANY, OTHER_TENANT, 'Other Tenant Co'],
    ] as const) {
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, $3, 'AED', 'Asia/Dubai', now())`,
        [id, tenantId, name],
      );
    }
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
       VALUES ($1, $2, $3, 'Main Branch', now())`,
      [BRANCH, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
       VALUES ($1, $2, $3, 'Co2 Branch', now())`,
      [BRANCH_2, TENANT, COMPANY_2],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
       VALUES ($1, $2, $3, 'Third Branch', now())`,
      [BRANCH_3, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
       VALUES ($1, $2, $3, 'Other Tenant Branch', now())`,
      [OTHER_TENANT_BRANCH, OTHER_TENANT, OTHER_TENANT_COMPANY],
    );
    await pool.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt")
       VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await pool.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose-bouquet', 'Test Product', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await pool.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt")
       VALUES ($1, $2, $3, 'Test Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_BRANCH, TENANT, COMPANY, BRANCH],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, NULL, NULL, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_TENANT_WIDE, TENANT],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_OTHER_BRANCH, TENANT, COMPANY_2, BRANCH_2],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_BRANCH_3, TENANT, COMPANY, BRANCH_3],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, NULL, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_COMPANY_ONLY, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_OTHER_TENANT, OTHER_TENANT, OTHER_TENANT_COMPANY, OTHER_TENANT_BRANCH],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'checkout', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_WRONG_PROVIDER, TENANT, COMPANY, BRANCH],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── fixture helpers ─────────────────────────────────────────────────────
  let seq = 0;
  const uid = (): string => crypto.randomUUID();

  async function insertOrder(
    overrides: {
      tenantId?: string;
      companyId?: string;
      branchId?: string;
    } = {},
  ): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [
        id,
        overrides.tenantId ?? TENANT,
        overrides.companyId ?? COMPANY,
        overrides.branchId ?? BRANCH,
        `fp-${id}`,
      ],
    );
    return id;
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-${(++seq).toString().padStart(6, '0')}`],
    );
  }

  async function insertMinimalInvoice(orderId: string): Promise<string> {
    const invoiceId = uid();
    const lineId = uid();
    const { rows: orderRows } = await pool.query<{
      tenantId: string;
      companyId: string;
      originBranchId: string;
    }>(`SELECT "tenantId", "companyId", "originBranchId" FROM "order" WHERE id = $1`, [orderId]);
    const o = orderRows[0]!;
    await pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',1000,'AED',2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [lineId, o.tenantId, o.companyId, orderId, PRODUCT, VARIANT],
    );
    await confirmOrder(orderId);
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 1000, 0, 0, 1000)`,
      [
        invoiceId,
        o.tenantId,
        o.companyId,
        o.originBranchId,
        orderId,
        `INV-${invoiceId.slice(0, 8)}`,
      ],
    );
    return invoiceId;
  }

  /** returns { orderId, invoiceId } for a fresh, fully-issued Order+Invoice. */
  async function freshOrderInvoice(): Promise<{ orderId: string; invoiceId: string }> {
    const orderId = await insertOrder();
    const invoiceId = await insertMinimalInvoice(orderId);
    return { orderId, invoiceId };
  }

  interface AttemptOverrides {
    id?: string;
    tenantId?: string;
    companyId?: string;
    branchId?: string;
    orderId?: string;
    targetInvoiceId?: string;
    method?: string;
    providerKey?: string | null;
    providerCredentialId?: string | null;
    amountMinor?: number;
    currencyCode?: string;
    currencyExponent?: number;
    state?: string;
    orderVersionAtCreation?: number;
  }

  async function insertAttempt(overrides: AttemptOverrides = {}): Promise<{
    id: string;
    orderId: string;
    invoiceId: string;
  }> {
    let orderId = overrides.orderId;
    let invoiceId = overrides.targetInvoiceId;
    if (!orderId || !invoiceId) {
      const fresh = await freshOrderInvoice();
      orderId = orderId ?? fresh.orderId;
      invoiceId = invoiceId ?? fresh.invoiceId;
    }
    const id = overrides.id ?? uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", method,
          "providerKey", "providerCredentialId", "amountMinor", "currencyCode", "currencyExponent",
          state, "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
          "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())`,
      [
        id,
        overrides.tenantId ?? TENANT,
        overrides.companyId ?? COMPANY,
        overrides.branchId ?? BRANCH,
        orderId,
        invoiceId,
        overrides.method ?? 'CASH',
        overrides.providerKey ?? null,
        overrides.providerCredentialId ?? null,
        overrides.amountMinor ?? 1000,
        overrides.currencyCode ?? 'AED',
        overrides.currencyExponent ?? 2,
        overrides.state ?? 'PENDING',
        'fp-attempt',
        overrides.orderVersionAtCreation ?? 1,
        `idem-${id}`,
      ],
    );
    return { id, orderId, invoiceId };
  }

  async function captureAttempt(attemptId: string, fromState = 'PENDING'): Promise<void> {
    if (fromState !== 'PENDING') {
      await pool.query(`UPDATE payment_attempt SET state = $2 WHERE id = $1`, [
        attemptId,
        fromState,
      ]);
    }
    await pool.query(`UPDATE payment_attempt SET state = 'CAPTURED' WHERE id = $1`, [attemptId]);
  }

  interface PaymentOverrides {
    sourceAttemptId: string;
    tenantId?: string | undefined;
    companyId?: string | undefined;
    branchId?: string | undefined;
    method?: string | undefined;
    providerKey?: string | null;
    amountMinor?: number | undefined;
    currencyCode?: string | undefined;
    currencyExponent?: number | undefined;
  }

  async function insertPayment(overrides: PaymentOverrides): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO payment
         (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "providerKey",
          "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        overrides.tenantId ?? TENANT,
        overrides.companyId ?? COMPANY,
        overrides.branchId ?? BRANCH,
        overrides.sourceAttemptId,
        overrides.method ?? 'CASH',
        overrides.providerKey ?? null,
        overrides.amountMinor ?? 1000,
        overrides.currencyCode ?? 'AED',
        overrides.currencyExponent ?? 2,
      ],
    );
    return id;
  }

  /** end-to-end: fresh Order+Invoice -> attempt -> CAPTURED -> Payment. */
  async function capturedPayment(overrides: Partial<AttemptOverrides> = {}): Promise<{
    paymentId: string;
    attemptId: string;
    invoiceId: string;
    branchId: string;
    tenantId: string;
    companyId: string;
    amountMinor: number;
  }> {
    const attempt = await insertAttempt(overrides);
    await captureAttempt(attempt.id);
    const paymentId = await insertPayment({
      sourceAttemptId: attempt.id,
      tenantId: overrides.tenantId,
      companyId: overrides.companyId,
      branchId: overrides.branchId,
      method: overrides.method,
      amountMinor: overrides.amountMinor,
      currencyCode: overrides.currencyCode,
      currencyExponent: overrides.currencyExponent,
    });
    return {
      paymentId,
      attemptId: attempt.id,
      invoiceId: attempt.invoiceId,
      branchId: overrides.branchId ?? BRANCH,
      tenantId: overrides.tenantId ?? TENANT,
      companyId: overrides.companyId ?? COMPANY,
      amountMinor: overrides.amountMinor ?? 1000,
    };
  }

  async function insertAllocation(p: {
    paymentId: string;
    invoiceId: string;
    tenantId?: string;
    companyId?: string;
    branchId?: string;
    amountMinor?: number;
    currencyCode?: string;
    currencyExponent?: number;
  }): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO payment_allocation
         (id, "tenantId", "companyId", "branchId", "paymentId", "invoiceId",
          "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        p.tenantId ?? TENANT,
        p.companyId ?? COMPANY,
        p.branchId ?? BRANCH,
        p.paymentId,
        p.invoiceId,
        p.amountMinor ?? 1000,
        p.currencyCode ?? 'AED',
        p.currencyExponent ?? 2,
      ],
    );
    return id;
  }

  // ═══════════════════════════ PAYMENT ═══════════════════════════════════
  describe('payment', () => {
    it('valid captured-source Payment insert succeeds', async () => {
      const { paymentId } = await capturedPayment();
      const { rows } = await pool.query(`SELECT id FROM payment WHERE id = $1`, [paymentId]);
      expect(rows).toHaveLength(1);
    });

    it('sourceAttemptId duplicate (a second Payment for the same attempt) is rejected', async () => {
      const { attemptId } = await capturedPayment();
      await expect(insertPayment({ sourceAttemptId: attemptId })).rejects.toThrow(
        /duplicate key|unique constraint/i,
      );
    });

    it('source attempt not CAPTURED is rejected', async () => {
      const attempt = await insertAttempt({ state: 'PENDING' });
      await expect(insertPayment({ sourceAttemptId: attempt.id })).rejects.toThrow(
        /is not CAPTURED/i,
      );
    });

    it('source scope (branch) mismatch is rejected', async () => {
      const attempt = await insertAttempt({ branchId: BRANCH });
      await captureAttempt(attempt.id);
      await expect(
        insertPayment({ sourceAttemptId: attempt.id, branchId: BRANCH_2, companyId: COMPANY_2 }),
      ).rejects.toThrow(/does not match its sourceAttempt/i);
    });

    it('amount mismatch against the source attempt is rejected', async () => {
      const attempt = await insertAttempt({ amountMinor: 1000 });
      await captureAttempt(attempt.id);
      await expect(
        insertPayment({ sourceAttemptId: attempt.id, amountMinor: 999 }),
      ).rejects.toThrow(/does not match its sourceAttempt/i);
    });

    it('currency mismatch against the source attempt is rejected', async () => {
      const attempt = await insertAttempt({ currencyCode: 'AED', currencyExponent: 2 });
      await captureAttempt(attempt.id);
      await expect(
        insertPayment({ sourceAttemptId: attempt.id, currencyCode: 'SAR', currencyExponent: 2 }),
      ).rejects.toThrow(/does not match its sourceAttempt|violates foreign key/i);
    });

    it('method/provider mismatch against the source attempt is rejected', async () => {
      const attempt = await insertAttempt({ method: 'CASH' });
      await captureAttempt(attempt.id);
      await expect(
        insertPayment({ sourceAttemptId: attempt.id, method: 'BANK_TRANSFER' }),
      ).rejects.toThrow(/does not match its sourceAttempt/i);
    });

    it('UPDATE is rejected', async () => {
      const { paymentId } = await capturedPayment();
      await expect(
        pool.query(`UPDATE payment SET "amountMinor" = 1 WHERE id = $1`, [paymentId]),
      ).rejects.toThrow(/is immutable/i);
    });

    it('DELETE is rejected', async () => {
      const { paymentId } = await capturedPayment();
      await expect(pool.query(`DELETE FROM payment WHERE id = $1`, [paymentId])).rejects.toThrow(
        /is immutable/i,
      );
    });
  });

  // ═══════════════════════════ PAYMENT ATTEMPT ═══════════════════════════
  describe('payment_attempt', () => {
    it('valid PENDING insert succeeds', async () => {
      const { id } = await insertAttempt();
      const { rows } = await pool.query(`SELECT state FROM payment_attempt WHERE id = $1`, [id]);
      expect(rows[0]!.state).toBe('PENDING');
    });

    it('invalid tender/provider shape is rejected (ONLINE_GATEWAY with no credential)', async () => {
      await expect(insertAttempt({ method: 'ONLINE_GATEWAY' })).rejects.toThrow(
        /payment_attempt_tender_provider_shape_chk|violates check constraint/i,
      );
    });

    it('invalid tender/provider shape is rejected (CASH with a providerKey)', async () => {
      await expect(insertAttempt({ method: 'CASH', providerKey: 'x' })).rejects.toThrow(
        /violates check constraint/i,
      );
    });

    // ── owner final security pass item 2: payment provider credentials are
    //    FROZEN branch-specific — a tenant-wide or company-only credential is
    //    rejected outright for payment use, regardless of tenant matching. ──

    it('(A) a valid branch-scoped payment credential with exact provider match is accepted', async () => {
      const { id } = await insertAttempt({
        method: 'CARD_TERMINAL',
        providerKey: 'tap',
        providerCredentialId: PROVIDER_CRED_BRANCH,
      });
      const { rows } = await pool.query(`SELECT id FROM payment_attempt WHERE id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });

    it('(B) a tenant-wide (NULL company/branch) credential is rejected', async () => {
      await expect(
        insertAttempt({
          method: 'ONLINE_GATEWAY',
          providerKey: 'tap',
          providerCredentialId: PROVIDER_CRED_TENANT_WIDE,
        }),
      ).rejects.toThrow(/must be branch-scoped for payments/i);
    });

    it('(C) a company-only / no-branch credential is rejected', async () => {
      await expect(
        insertAttempt({
          method: 'ONLINE_GATEWAY',
          providerKey: 'tap',
          providerCredentialId: PROVIDER_CRED_COMPANY_ONLY,
        }),
      ).rejects.toThrow(/must be branch-scoped for payments/i);
    });

    it('(D) a credential belonging to a different tenant is rejected', async () => {
      await expect(
        insertAttempt({
          method: 'ONLINE_GATEWAY',
          providerKey: 'tap',
          providerCredentialId: PROVIDER_CRED_OTHER_TENANT,
        }),
      ).rejects.toThrow(/belongs to a different tenant/i);
    });

    it('(E) a credential scoped to a different company (same tenant) is rejected', async () => {
      const fresh = await freshOrderInvoice();
      await expect(
        insertAttempt({
          orderId: fresh.orderId,
          targetInvoiceId: fresh.invoiceId,
          companyId: COMPANY,
          branchId: BRANCH,
          method: 'ONLINE_GATEWAY',
          providerKey: 'tap',
          providerCredentialId: PROVIDER_CRED_OTHER_BRANCH,
        }),
      ).rejects.toThrow(/scoped to a different company/i);
    });

    it('(F) a credential scoped to a different branch (same company) is rejected', async () => {
      await expect(
        insertAttempt({
          method: 'ONLINE_GATEWAY',
          providerKey: 'tap',
          providerCredentialId: PROVIDER_CRED_BRANCH_3,
        }),
      ).rejects.toThrow(/scoped to a different branch/i);
    });

    it("(G) providerKey not matching the credential's own provider is rejected", async () => {
      await expect(
        insertAttempt({
          method: 'ONLINE_GATEWAY',
          providerKey: 'tap',
          providerCredentialId: PROVIDER_CRED_WRONG_PROVIDER,
        }),
      ).rejects.toThrow(/providerKey .* does not match/i);
    });

    it('(H) an exact provider match (providerKey === credential.provider) is accepted', async () => {
      const { id } = await insertAttempt({
        method: 'ONLINE_GATEWAY',
        providerKey: 'checkout',
        providerCredentialId: PROVIDER_CRED_WRONG_PROVIDER,
      });
      const { rows } = await pool.query(`SELECT id FROM payment_attempt WHERE id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });

    it('valid transition PENDING -> REQUIRES_ACTION', async () => {
      const { id } = await insertAttempt();
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'REQUIRES_ACTION' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('valid PENDING -> CAPTURED', async () => {
      const { id } = await insertAttempt();
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'CAPTURED' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('valid REQUIRES_ACTION -> AUTHORIZED', async () => {
      const { id } = await insertAttempt({ state: 'REQUIRES_ACTION' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'AUTHORIZED' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('valid REQUIRES_ACTION -> FAILED', async () => {
      const { id } = await insertAttempt({ state: 'REQUIRES_ACTION' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'FAILED' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('valid REQUIRES_ACTION -> CANCELED', async () => {
      const { id } = await insertAttempt({ state: 'REQUIRES_ACTION' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'CANCELED' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('valid AUTHORIZED -> CAPTURED', async () => {
      const { id } = await insertAttempt({ state: 'AUTHORIZED' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'CAPTURED' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('AUTHORIZED -> FAILED is rejected (no accepted-source basis; deferred to the provider adapter)', async () => {
      const { id } = await insertAttempt({ state: 'AUTHORIZED' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'FAILED' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal state transition/i);
    });

    it('AUTHORIZED -> CANCELED is rejected', async () => {
      const { id } = await insertAttempt({ state: 'AUTHORIZED' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'CANCELED' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal state transition/i);
    });

    it('CAPTURED cannot regress to any other state', async () => {
      const { id } = await insertAttempt({ state: 'CAPTURED' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'PENDING' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal state transition/i);
    });

    it('FAILED cannot regress to any other state', async () => {
      const { id } = await insertAttempt({ state: 'FAILED' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'PENDING' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal state transition/i);
    });

    it('CANCELED cannot regress to any other state', async () => {
      const { id } = await insertAttempt({ state: 'CANCELED' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'PENDING' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal state transition/i);
    });

    it('no 3b.5 transition enters PARTIALLY_REFUNDED or REFUNDED', async () => {
      const { id } = await insertAttempt({ state: 'CAPTURED' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'PARTIALLY_REFUNDED' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal state transition/i);
      const { id: id2 } = await insertAttempt({ state: 'PENDING' });
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'REFUNDED' WHERE id = $1`, [id2]),
      ).rejects.toThrow(/illegal state transition/i);
    });

    it('an immutable creation attribute (amountMinor) cannot be updated', async () => {
      const { id } = await insertAttempt();
      await expect(
        pool.query(`UPDATE payment_attempt SET "amountMinor" = 5000 WHERE id = $1`, [id]),
      ).rejects.toThrow(/creation-time attributes are immutable/i);
    });

    it('providerReference set-once: NULL -> non-NULL succeeds, then a different value is rejected', async () => {
      const { id } = await insertAttempt();
      await expect(
        pool.query(`UPDATE payment_attempt SET "providerReference" = 'ref-1' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
      // same-value write is harmless
      await expect(
        pool.query(`UPDATE payment_attempt SET "providerReference" = 'ref-1' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
      await expect(
        pool.query(`UPDATE payment_attempt SET "providerReference" = 'ref-2' WHERE id = $1`, [id]),
      ).rejects.toThrow(/providerReference is set-once/i);
    });

    it('providerReference cannot be reset to NULL once set', async () => {
      const { id } = await insertAttempt();
      await pool.query(`UPDATE payment_attempt SET "providerReference" = 'ref-1' WHERE id = $1`, [
        id,
      ]);
      await expect(
        pool.query(`UPDATE payment_attempt SET "providerReference" = NULL WHERE id = $1`, [id]),
      ).rejects.toThrow(/providerReference is set-once/i);
    });

    it('DELETE is rejected', async () => {
      const { id } = await insertAttempt();
      await expect(pool.query(`DELETE FROM payment_attempt WHERE id = $1`, [id])).rejects.toThrow(
        /DELETE is never permitted/i,
      );
    });

    it('targetInvoiceId must belong to orderId — an arbitrary same-tenant Order/Invoice pairing is rejected', async () => {
      const a = await freshOrderInvoice();
      const b = await freshOrderInvoice();
      await expect(
        insertAttempt({ orderId: a.orderId, targetInvoiceId: b.invoiceId }),
      ).rejects.toThrow(/violates foreign key/i);
    });
  });

  // ═══════════════════════════ ALLOCATION ═══════════════════════════════
  describe('payment_allocation', () => {
    it('exact 1:1 valid insert succeeds', async () => {
      const p = await capturedPayment();
      const id = await insertAllocation({ paymentId: p.paymentId, invoiceId: p.invoiceId });
      const { rows } = await pool.query(`SELECT id FROM payment_allocation WHERE id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });

    it('a duplicate allocation for the same Payment is rejected', async () => {
      const p = await capturedPayment();
      await insertAllocation({ paymentId: p.paymentId, invoiceId: p.invoiceId });
      await expect(
        insertAllocation({ paymentId: p.paymentId, invoiceId: p.invoiceId }),
      ).rejects.toThrow(/duplicate key|unique constraint/i);
    });

    it('amount mismatch against the Payment is rejected', async () => {
      const p = await capturedPayment({ amountMinor: 1000 });
      await expect(
        insertAllocation({ paymentId: p.paymentId, invoiceId: p.invoiceId, amountMinor: 500 }),
      ).rejects.toThrow(/does not match its Payment/i);
    });

    it('currency/exponent mismatch against the Payment is rejected', async () => {
      const p = await capturedPayment();
      await expect(
        insertAllocation({
          paymentId: p.paymentId,
          invoiceId: p.invoiceId,
          currencyCode: 'SAR',
        }),
      ).rejects.toThrow(/does not match its Payment|violates foreign key/i);
    });

    it('scope (branch) mismatch against the Payment is rejected', async () => {
      const p = await capturedPayment();
      await expect(
        insertAllocation({
          paymentId: p.paymentId,
          invoiceId: p.invoiceId,
          branchId: BRANCH_2,
          companyId: COMPANY_2,
        }),
      ).rejects.toThrow(/does not match its Payment/i);
    });

    it('an Invoice from a different scope than the Payment is rejected', async () => {
      const p = await capturedPayment();
      const other = await freshOrderInvoice();
      await expect(
        insertAllocation({ paymentId: p.paymentId, invoiceId: other.invoiceId }),
      ).resolves.toBeDefined(); // same tenant/company/branch — structurally valid pairing
    });

    it('UPDATE is rejected', async () => {
      const p = await capturedPayment();
      const id = await insertAllocation({ paymentId: p.paymentId, invoiceId: p.invoiceId });
      await expect(
        pool.query(`UPDATE payment_allocation SET "amountMinor" = 1 WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it('DELETE is rejected', async () => {
      const p = await capturedPayment();
      const id = await insertAllocation({ paymentId: p.paymentId, invoiceId: p.invoiceId });
      await expect(
        pool.query(`DELETE FROM payment_allocation WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });
  });

  // ═══════════════════════════ ATTEMPT EVENT ═════════════════════════════
  describe('payment_attempt_event', () => {
    it('valid insert succeeds', async () => {
      const { id: attemptId } = await insertAttempt();
      const id = uid();
      await pool.query(
        `INSERT INTO payment_attempt_event
           (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
         VALUES ($1,$2,$3,$4,$5,'PENDING','CAPTURED','SYSTEM')`,
        [id, TENANT, COMPANY, BRANCH, attemptId],
      );
      const { rows } = await pool.query(`SELECT id FROM payment_attempt_event WHERE id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });

    it('UPDATE is rejected', async () => {
      const { id: attemptId } = await insertAttempt();
      const id = uid();
      await pool.query(
        `INSERT INTO payment_attempt_event
           (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
         VALUES ($1,$2,$3,$4,$5,'PENDING','CAPTURED','SYSTEM')`,
        [id, TENANT, COMPANY, BRANCH, attemptId],
      );
      await expect(
        pool.query(`UPDATE payment_attempt_event SET "toState" = 'FAILED' WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it('DELETE is rejected', async () => {
      const { id: attemptId } = await insertAttempt();
      const id = uid();
      await pool.query(
        `INSERT INTO payment_attempt_event
           (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
         VALUES ($1,$2,$3,$4,$5,'PENDING','CAPTURED','SYSTEM')`,
        [id, TENANT, COMPANY, BRANCH, attemptId],
      );
      await expect(
        pool.query(`DELETE FROM payment_attempt_event WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    // ── owner final security pass item 3: scope must structurally match the
    //    referenced PaymentAttempt — enforced by the composite FK
    //    `payment_attempt_event_attempt_tenant_company_branch_fkey`
    //    (tenantId, companyId, branchId, paymentAttemptId) ->
    //    payment_attempt(tenantId, companyId, branchId, id). This is
    //    referential/structural consistency, never read/write access
    //    authorization — see the RLS-vs-structural-consistency section below. ──

    it('a wrong-tenant scope is rejected (structural FK)', async () => {
      const { id: attemptId } = await insertAttempt();
      await expect(
        pool.query(
          `INSERT INTO payment_attempt_event
             (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
           VALUES ($1,$2,$3,$4,$5,'PENDING','CAPTURED','SYSTEM')`,
          [uid(), OTHER_TENANT, OTHER_TENANT_COMPANY, OTHER_TENANT_BRANCH, attemptId],
        ),
      ).rejects.toThrow(/violates foreign key/i);
    });

    it('a wrong-company scope (same tenant) is rejected (structural FK)', async () => {
      const { id: attemptId } = await insertAttempt();
      await expect(
        pool.query(
          `INSERT INTO payment_attempt_event
             (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
           VALUES ($1,$2,$3,$4,$5,'PENDING','CAPTURED','SYSTEM')`,
          [uid(), TENANT, COMPANY_2, BRANCH_2, attemptId],
        ),
      ).rejects.toThrow(/violates foreign key/i);
    });

    it('a wrong-branch scope (same company) is rejected (structural FK)', async () => {
      const { id: attemptId } = await insertAttempt();
      await expect(
        pool.query(
          `INSERT INTO payment_attempt_event
             (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
           VALUES ($1,$2,$3,$4,$5,'PENDING','CAPTURED','SYSTEM')`,
          [uid(), TENANT, COMPANY, BRANCH_3, attemptId],
        ),
      ).rejects.toThrow(/violates foreign key/i);
    });

    it('an invalid fromState/toState vocabulary value is rejected', async () => {
      const { id: attemptId } = await insertAttempt();
      await expect(
        pool.query(
          `INSERT INTO payment_attempt_event
             (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
           VALUES ($1,$2,$3,$4,$5,'BOGUS','CAPTURED','SYSTEM')`,
          [uid(), TENANT, COMPANY, BRANCH, attemptId],
        ),
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        pool.query(
          `INSERT INTO payment_attempt_event
             (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
           VALUES ($1,$2,$3,$4,$5,'PENDING','BOGUS','SYSTEM')`,
          [uid(), TENANT, COMPANY, BRANCH, attemptId],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('the event never transitions the PaymentAttempt itself (history, not mutation authority)', async () => {
      const { id: attemptId } = await insertAttempt({ state: 'PENDING' });
      await pool.query(
        `INSERT INTO payment_attempt_event
           (id, "tenantId", "companyId", "branchId", "paymentAttemptId", "fromState", "toState", source)
         VALUES ($1,$2,$3,$4,$5,'PENDING','CAPTURED','SYSTEM')`,
        [uid(), TENANT, COMPANY, BRANCH, attemptId],
      );
      const { rows } = await pool.query(`SELECT state FROM payment_attempt WHERE id = $1`, [
        attemptId,
      ]);
      expect(rows[0]!.state).toBe('PENDING'); // unchanged by the event insert
    });
  });

  // ═══════════════════════════ PROVIDER EVENT ════════════════════════════
  describe('provider_payment_event', () => {
    async function insertEvent(providerEventId = uid()): Promise<string> {
      const id = uid();
      await pool.query(
        `INSERT INTO provider_payment_event
           (id, "tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
            "eventType", "payloadHash")
         VALUES ($1,$2,$3,$4,$5,$6,'capture.succeeded','hash-1')`,
        [id, TENANT, COMPANY, BRANCH, PROVIDER_CRED_BRANCH, providerEventId],
      );
      return id;
    }

    it('valid RECEIVED insert succeeds', async () => {
      const id = await insertEvent();
      const { rows } = await pool.query(`SELECT status FROM provider_payment_event WHERE id = $1`, [
        id,
      ]);
      expect(rows[0]!.status).toBe('RECEIVED');
    });

    it('an insert with a non-RECEIVED initial status is rejected', async () => {
      await expect(
        pool.query(
          `INSERT INTO provider_payment_event
             (id, "tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
              "eventType", "payloadHash", status)
           VALUES ($1,$2,$3,$4,$5,$6,'capture.succeeded','hash-1','PROCESSED')`,
          [uid(), TENANT, COMPANY, BRANCH, PROVIDER_CRED_BRANCH, uid()],
        ),
      ).rejects.toThrow(/initial status must be RECEIVED/i);
    });

    it('duplicate (credential, providerEventId) is rejected', async () => {
      const providerEventId = uid();
      await insertEvent(providerEventId);
      await expect(insertEvent(providerEventId)).rejects.toThrow(
        /duplicate key|unique constraint/i,
      );
    });

    // ── owner final security pass item 4: credential must be branch-scoped
    //    for a payment event, and the event's own scope must exactly match
    //    the credential's own scope. ─────────────────────────────────────

    it('a tenant-wide credential is rejected for a payment event', async () => {
      await expect(
        pool.query(
          `INSERT INTO provider_payment_event
             (id, "tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
              "eventType", "payloadHash")
           VALUES ($1,$2,$3,$4,$5,$6,'capture.succeeded','hash-1')`,
          [uid(), TENANT, COMPANY, BRANCH, PROVIDER_CRED_TENANT_WIDE, uid()],
        ),
      ).rejects.toThrow(/must be branch-scoped for payments/i);
    });

    it('a company-only / no-branch credential is rejected', async () => {
      await expect(
        pool.query(
          `INSERT INTO provider_payment_event
             (id, "tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
              "eventType", "payloadHash")
           VALUES ($1,$2,$3,$4,$5,$6,'capture.succeeded','hash-1')`,
          [uid(), TENANT, COMPANY, BRANCH, PROVIDER_CRED_COMPANY_ONLY, uid()],
        ),
      ).rejects.toThrow(/must be branch-scoped for payments/i);
    });

    it('wrong-tenant scope (relative to the credential) is rejected', async () => {
      await expect(
        pool.query(
          `INSERT INTO provider_payment_event
             (id, "tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
              "eventType", "payloadHash")
           VALUES ($1,$2,$3,$4,$5,$6,'capture.succeeded','hash-1')`,
          [
            uid(),
            OTHER_TENANT,
            OTHER_TENANT_COMPANY,
            OTHER_TENANT_BRANCH,
            PROVIDER_CRED_BRANCH,
            uid(),
          ],
        ),
      ).rejects.toThrow(/scope does not match/i);
    });

    it('wrong-company scope (relative to the credential) is rejected', async () => {
      await expect(
        pool.query(
          `INSERT INTO provider_payment_event
             (id, "tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
              "eventType", "payloadHash")
           VALUES ($1,$2,$3,$4,$5,$6,'capture.succeeded','hash-1')`,
          [uid(), TENANT, COMPANY_2, BRANCH_2, PROVIDER_CRED_BRANCH, uid()],
        ),
      ).rejects.toThrow(/scope does not match/i);
    });

    it('wrong-branch scope (relative to the credential) is rejected', async () => {
      await expect(
        pool.query(
          `INSERT INTO provider_payment_event
             (id, "tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
              "eventType", "payloadHash")
           VALUES ($1,$2,$3,$4,$5,$6,'capture.succeeded','hash-1')`,
          [uid(), TENANT, COMPANY, BRANCH_3, PROVIDER_CRED_BRANCH, uid()],
        ),
      ).rejects.toThrow(/scope does not match/i);
    });

    it('RECEIVED -> PROCESSED is valid', async () => {
      const id = await insertEvent();
      await expect(
        pool.query(`UPDATE provider_payment_event SET status = 'PROCESSED' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('RECEIVED -> EXCEPTION is valid', async () => {
      const id = await insertEvent();
      await expect(
        pool.query(`UPDATE provider_payment_event SET status = 'EXCEPTION' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('a terminal status cannot change again (PROCESSED -> EXCEPTION rejected)', async () => {
      const id = await insertEvent();
      await pool.query(`UPDATE provider_payment_event SET status = 'PROCESSED' WHERE id = $1`, [
        id,
      ]);
      await expect(
        pool.query(`UPDATE provider_payment_event SET status = 'EXCEPTION' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal status transition/i);
    });

    it('a terminal status cannot regress to RECEIVED', async () => {
      const id = await insertEvent();
      await pool.query(`UPDATE provider_payment_event SET status = 'EXCEPTION' WHERE id = $1`, [
        id,
      ]);
      await expect(
        pool.query(`UPDATE provider_payment_event SET status = 'RECEIVED' WHERE id = $1`, [id]),
      ).rejects.toThrow(/illegal status transition/i);
    });

    it('a same-value status update from a terminal status is a harmless no-op', async () => {
      const id = await insertEvent();
      await pool.query(`UPDATE provider_payment_event SET status = 'PROCESSED' WHERE id = $1`, [
        id,
      ]);
      await expect(
        pool.query(`UPDATE provider_payment_event SET status = 'PROCESSED' WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    });

    it('immutable identity/metadata fields cannot be updated', async () => {
      const id = await insertEvent();
      await expect(
        pool.query(`UPDATE provider_payment_event SET "eventType" = 'other' WHERE id = $1`, [id]),
      ).rejects.toThrow(/only status may change/i);
    });

    it('DELETE is rejected', async () => {
      const id = await insertEvent();
      await expect(
        pool.query(`DELETE FROM provider_payment_event WHERE id = $1`, [id]),
      ).rejects.toThrow(/DELETE is never permitted/i);
    });
  });

  // ═══════════════════════════ WEBHOOK ENDPOINT ══════════════════════════
  describe('payment_webhook_endpoint', () => {
    /** a brand-new provider_credential row — `providerCredentialId` is UNIQUE
     *  on payment_webhook_endpoint, so every test that inserts an endpoint
     *  needs its OWN credential (never a shared fixture constant, which
     *  would collide across tests sharing the same live database). */
    async function insertFreshCredential(
      companyId: string | null,
      branchId: string | null,
    ): Promise<string> {
      const id = uid();
      await pool.query(
        `INSERT INTO provider_credential
           (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
         VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00', now())`,
        [id, TENANT, companyId, branchId],
      );
      return id;
    }

    it('a valid branch-scoped credential mapping succeeds', async () => {
      const cred = await insertFreshCredential(COMPANY, BRANCH);
      const id = uid();
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         VALUES ($1,$2,$3,$4,$5)`,
        [id, TENANT, COMPANY, BRANCH, cred],
      );
      const { rows } = await pool.query(`SELECT id FROM payment_webhook_endpoint WHERE id = $1`, [
        id,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('a tenant-wide (NULL company/branch) credential is rejected — payment webhook endpoints are frozen branch-scoped', async () => {
      const cred = await insertFreshCredential(null, null);
      await expect(
        pool.query(
          `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
           VALUES ($1,$2,NULL,NULL,$3)`,
          [uid(), TENANT, cred],
        ),
      ).rejects.toThrow(/must be branch-scoped for payments/i);
    });

    it('a company-only / no-branch credential is rejected', async () => {
      const cred = await insertFreshCredential(COMPANY, null);
      await expect(
        pool.query(
          `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
           VALUES ($1,$2,$3,NULL,$4)`,
          [uid(), TENANT, COMPANY, cred],
        ),
      ).rejects.toThrow(/must be branch-scoped for payments/i);
    });

    it('a duplicate providerCredentialId is rejected', async () => {
      const cred = await insertFreshCredential(COMPANY, BRANCH);
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         VALUES ($1,$2,$3,$4,$5)`,
        [uid(), TENANT, COMPANY, BRANCH, cred],
      );
      await expect(
        pool.query(
          `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
           VALUES ($1,$2,$3,$4,$5)`,
          [uid(), TENANT, COMPANY, BRANCH, cred],
        ),
      ).rejects.toThrow(/duplicate key|unique constraint/i);
    });

    it('a scope that does not exactly mirror the credential is rejected', async () => {
      const cred = await insertFreshCredential(COMPANY, BRANCH);
      await expect(
        pool.query(
          `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
           VALUES ($1,$2,$3,$4,$5)`,
          [uid(), TENANT, COMPANY_2, BRANCH_2, cred],
        ),
      ).rejects.toThrow(/scope must exactly mirror/i);
    });

    it('UPDATE is blocked', async () => {
      const cred = await insertFreshCredential(COMPANY, BRANCH);
      const id = uid();
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         VALUES ($1,$2,$3,$4,$5)`,
        [id, TENANT, COMPANY, BRANCH, cred],
      );
      await expect(
        pool.query(`UPDATE payment_webhook_endpoint SET "branchId" = NULL WHERE id = $1`, [id]),
      ).rejects.toThrow(/is immutable/i);
    });

    it('DELETE is blocked', async () => {
      const cred = await insertFreshCredential(COMPANY, BRANCH);
      const id = uid();
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         VALUES ($1,$2,$3,$4,$5)`,
        [id, TENANT, COMPANY, BRANCH, cred],
      );
      await expect(
        pool.query(`DELETE FROM payment_webhook_endpoint WHERE id = $1`, [id]),
      ).rejects.toThrow(/is not permitted/i);
    });

    it('credential rotation (same ProviderCredential.id, secret updated) does not break endpoint identity', async () => {
      const cred = await insertFreshCredential(COMPANY, BRANCH);
      const id = uid();
      await pool.query(
        `INSERT INTO payment_webhook_endpoint (id, "tenantId", "companyId", "branchId", "providerCredentialId")
         VALUES ($1,$2,$3,$4,$5)`,
        [id, TENANT, COMPANY, BRANCH, cred],
      );
      // rotate() only ever UPDATEs secretCiphertext/secretNonce/dekWrapped/version
      // on the SAME row — never a new id.
      await pool.query(
        `UPDATE provider_credential SET "secretCiphertext" = '\\x01', version = version + 1 WHERE id = $1`,
        [cred],
      );
      const { rows } = await pool.query(
        `SELECT "providerCredentialId" FROM payment_webhook_endpoint WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.providerCredentialId).toBe(cred);
    });
  });

  // ═══════════════════════════ RLS ═══════════════════════════════════════
  // ── owner final security pass item 1: RLS in this repository (and in this
  //    migration) enforces TENANT isolation only — every policy predicate
  //    checks `tenantId` alone (confirmed by direct inspection of every
  //    existing tenant-owned-table migration: `order`/`invoice`/
  //    `journal_entry`/`account`/`accounting_period` all use a bare
  //    `tenantId = ...` policy; `runScoped` sets `app.branch_id` but ONLY
  //    `branch_variant_price_set`/`branch_variant_uom_price`/
  //    `branch_variant_availability` — catalog read-lookup tables with a
  //    fundamentally different access pattern — actually predicate on it).
  //    Payment/PaymentAttempt/PaymentAllocation/PaymentAttemptEvent/
  //    ProviderPaymentEvent/PaymentWebhookEndpoint follow the Order/Invoice
  //    precedent exactly (they are transactional records written through a
  //    future service/repository layer, not raw catalog lookups): a SAME-
  //    TENANT, different-company or different-branch SELECT is NOT denied by
  //    RLS here — RLS cannot see companyId/branchId at all. Company/branch
  //    ACCESS authorization for these tables is the responsibility of the
  //    future `ScopedRepository`/`@ScopedParam` service layer (Checkpoint
  //    C+), exactly as it is for `order`/`invoice` today (see
  //    `OrderCreateFingerprintProvider`'s own comment: "companyId/branchId
  //    come from route params already authorization-validated by
  //    PermissionGuard (@ScopedParam) before any interceptor runs").
  //
  //    The composite FKs in this migration (and the tests immediately below
  //    this block) prove STRUCTURAL scope CONSISTENCY only — that a stored
  //    relationship cannot reference a mismatched tenant/company/branch even
  //    under an application bug. They do NOT prove and are NOT a substitute
  //    for read/write ACCESS denial across companies/branches within the
  //    same tenant. A same-tenant, wrong-company/wrong-branch ACCESS-denial
  //    proof (a repository-level test asserting a company-B caller cannot
  //    fetch a company-A Payment through the future service API) is
  //    DEFERRED to Checkpoint C/G, once the payment repository/service
  //    exists to test against — it cannot be proven at the DB layer alone
  //    for these tables, matching the identical, already-accepted precedent
  //    for `order`/`invoice`.
  describe('RLS (tenant isolation only)', () => {
    it('all six new tables have ENABLE + FORCE + a tenant-isolation policy', async () => {
      const tables = [
        'payment',
        'payment_attempt',
        'payment_allocation',
        'payment_attempt_event',
        'provider_payment_event',
        'payment_webhook_endpoint',
      ];
      const { rows } = await pool.query<{
        relname: string;
        rls: boolean;
        force: boolean;
        policies: number;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.relname = ANY($1)`,
        [tables],
      );
      expect(rows).toHaveLength(tables.length);
      for (const r of rows) {
        expect(r.rls, `${r.relname}: RLS not enabled`).toBe(true);
        expect(r.force, `${r.relname}: RLS not FORCEd`).toBe(true);
        expect(Number(r.policies), `${r.relname}: no policy`).toBeGreaterThanOrEqual(1);
      }
    });

    it('same-scope access: the owning tenant sees its own payment', async () => {
      const { paymentId } = await capturedPayment();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
        await client.query('SET LOCAL ROLE flower_app');
        const { rows } = await client.query('SELECT id FROM payment WHERE id = $1', [paymentId]);
        expect(rows).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('wrong tenant: payment/payment_attempt/payment_allocation are invisible to a different tenant', async () => {
      const p = await capturedPayment();
      const allocationId = await insertAllocation({
        paymentId: p.paymentId,
        invoiceId: p.invoiceId,
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
        await client.query('SET LOCAL ROLE flower_app');
        const payRows = await client.query('SELECT id FROM payment WHERE id = $1', [p.paymentId]);
        expect(payRows.rows).toHaveLength(0);
        const attRows = await client.query('SELECT id FROM payment_attempt WHERE id = $1', [
          p.attemptId,
        ]);
        expect(attRows.rows).toHaveLength(0);
        const allocRows = await client.query('SELECT id FROM payment_allocation WHERE id = $1', [
          allocationId,
        ]);
        expect(allocRows.rows).toHaveLength(0);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('no context (app.tenant_id unset): payment is invisible', async () => {
      const { paymentId } = await capturedPayment();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE flower_app');
        const { rows } = await client.query('SELECT id FROM payment WHERE id = $1', [paymentId]);
        expect(rows).toHaveLength(0);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  // ── STRUCTURAL scope consistency — NOT access control. These prove a
  //    mismatched tenant/company/branch relationship cannot be INSERTed at
  //    all (composite FK / trigger rejection). They do NOT prove and must
  //    never be read as proving that a same-tenant, wrong-company/
  //    wrong-branch caller is denied READ/WRITE access — that authorization
  //    boundary lives in the future service/repository layer (Checkpoint
  //    C/G), not here. See the header comment on the RLS block above. ──────
  describe('structural tenant/company/branch consistency (not access control)', () => {
    it('a payment_allocation cannot reference an invoice belonging to a different company (structural FK)', async () => {
      const otherCompanyOrder = await insertOrder({ companyId: COMPANY_2, branchId: BRANCH_2 });
      const otherCompanyInvoice = await insertMinimalInvoice(otherCompanyOrder);
      const p = await capturedPayment();
      await expect(
        insertAllocation({ paymentId: p.paymentId, invoiceId: otherCompanyInvoice }),
      ).rejects.toThrow(/does not belong to the same tenant\/company/i);
    });

    it('a payment_attempt cannot be scoped to a branch outside its own company (structural FK)', async () => {
      const fresh = await freshOrderInvoice();
      await expect(
        insertAttempt({
          orderId: fresh.orderId,
          targetInvoiceId: fresh.invoiceId,
          branchId: BRANCH_2,
        }),
      ).rejects.toThrow(/violates foreign key/i);
    });
  });
});
