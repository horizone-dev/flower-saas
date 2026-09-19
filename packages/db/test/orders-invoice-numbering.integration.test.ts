import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.3 CHECKPOINT A (Orders + Invoice + Numbering) — the `order` /
 * `order_line` / `invoice` / `document_number_counter` schema, proven against
 * real Postgres via raw SQL: RLS enable+force+policy, every closed-vocabulary
 * CHECK, the discount/tax-snapshot shape CHECKs, the composite tenant/company/
 * branch/product/variant-safe FKs, numbering uniqueness + NULL coexistence,
 * and the explicit non-scope confirmations (no partitioning, no
 * `invoice_line`, no Payment/AR/Inventory table).
 *
 * Checkpoint A ships schema/RLS/FK/CHECK structure ONLY — no service, no
 * controller, no trigger-based cross-row immutability backstop (see the
 * migration SQL header comment: those four triggers are MANDATORY FOR
 * CHECKPOINT C). Nothing here exercises a repository/service/controller.
 *
 * Uses the plain Testcontainers superuser connection (bypasses RLS as the
 * table owner, exactly like `customer-schema.integration.test.ts`'s own
 * fixture) — RLS itself is verified separately below.
 */
const TENANT = '5e5e5e5e-5e5e-75e5-85e5-5e5e5e5e5e5e';
const OTHER_TENANT = '6f6f6f6f-6f6f-76f6-86f6-6f6f6f6f6f6f';
const COMPANY = '7a7a7a7a-7a7a-77a7-87a7-7a7a7a7a7a7a';
const COMPANY_2 = '8b8b8b8b-8b8b-78b8-88b8-8b8b8b8b8b8b'; // same tenant, different company
const OTHER_TENANT_COMPANY = '9c9c9c9c-9c9c-79c9-89c9-9c9c9c9c9c9c';
const BRANCH = '1d1d1d1d-1d1d-71d1-81d1-1d1d1d1d1d1d';
const BRANCH_2 = '2e2e2e2e-2e2e-72e2-82e2-2e2e2e2e2e2e'; // under COMPANY_2
const POS_TERMINAL = '3f3f3f3f-3f3f-73f3-83f3-3f3f3f3f3f3f'; // under BRANCH
const POS_TERMINAL_OTHER_BRANCH = '4a4a4a4a-4a4a-74a4-84a4-4a4a4a4a4a4a'; // under BRANCH_2
const CUSTOMER = '5b5b5b5b-5b5b-75b5-85b5-5b5b5b5b5b5b';
const OTHER_TENANT_CUSTOMER = '6c6c6c6c-6c6c-76c6-86c6-6c6c6c6c6c6c';
const CATEGORY = '7d7d7d7d-7d7d-77d7-87d7-7d7d7d7d7d7d';
const PRODUCT = '8e8e8e8e-8e8e-78e8-88e8-8e8e8e8e8e8e';
const VARIANT = '9f9f9f9f-9f9f-79f9-89f9-9f9f9f9f9f9f';
const PRODUCT_2 = '1a2a3a4a-1a2a-71a2-81a2-1a2a3a4a5a6a';
const VARIANT_2 = '2b3b4b5b-2b3b-72b3-82b3-2b3b4b5b6b7b';

describe('packages/db — Task 3b.3 Checkpoint A orders/invoice/numbering schema', () => {
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
       VALUES ($1, 'ord-3b3', 'ord-3b3', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'ord-3b3-other', 'ord-3b3-other', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
      [OTHER_TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'د.إ', 'UAE Dirham', 'درهم إماراتي') ON CONFLICT (code) DO NOTHING`,
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
      `INSERT INTO pos_terminal (id, "tenantId", "companyId", "branchId", code, name, "updatedAt")
       VALUES ($1, $2, $3, $4, 'POS-1', 'POS 1', now())`,
      [POS_TERMINAL, TENANT, COMPANY, BRANCH],
    );
    await pool.query(
      `INSERT INTO pos_terminal (id, "tenantId", "companyId", "branchId", code, name, "updatedAt")
       VALUES ($1, $2, $3, $4, 'POS-2', 'POS 2', now())`,
      [POS_TERMINAL_OTHER_BRANCH, TENANT, COMPANY_2, BRANCH_2],
    );
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Test Customer', now())`,
      [CUSTOMER, TENANT],
    );
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Other Tenant Customer', now())`,
      [OTHER_TENANT_CUSTOMER, OTHER_TENANT],
    );
    await pool.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt")
       VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    for (const [productId, variantId, slug] of [
      [PRODUCT, VARIANT, 'rose-bouquet'],
      [PRODUCT_2, VARIANT_2, 'lily-bouquet'],
    ] as const) {
      await pool.query(
        `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
         VALUES ($1, $2, $3, $4, 'Test Product', 'STOCKED', now())`,
        [productId, TENANT, CATEGORY, slug],
      );
      await pool.query(
        `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt")
         VALUES ($1, $2, $3, 'Test Variant', now())`,
        [variantId, TENANT, productId],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  interface TestOrder {
    id: string;
    tenantId: string;
    companyId: string;
    originBranchId: string;
    fulfillingBranchId: string;
    posTerminalId?: string | null;
    customerId?: string | null;
    kind: string;
    status: string;
    currencyCode: string;
    currencyExponent: number;
    documentDiscountMode?: string;
    documentDiscountBps?: number | null;
    documentDiscountAmountMinor?: number;
    orderNumber?: string | null;
    commercialSnapshotFingerprint?: string;
    createdByUserId?: string | null;
    actingUserId?: string | null;
  }

  interface TestLine {
    id: string;
    tenantId: string;
    companyId: string;
    orderId: string;
    linePosition: number;
    productId: string;
    variantId: string;
    quantity: string;
    unitPriceAmountMinor: bigint;
    unitPriceCurrencyCode: string;
    unitPriceCurrencyExponent: number;
    discountMode?: string;
    discountBps?: number | null;
    discountAmountMinor?: bigint;
    priceTaxMode?: string | null;
    roundingScope?: string | null;
    roundingMode?: string | null;
    lineTaxAmountMinor?: bigint | null;
    taxCategoryKey?: string | null;
    rateBps?: number | null;
    effectiveFrom?: Date | null;
    resolutionSource: string;
    selectedUomCode: string;
    uomDisplayLabelSnapshot: string;
    baseUomCode: string;
    conversionNumerator: bigint;
    conversionDenominator: bigint;
    productNameEnSnapshot: string;
    variantNameEnSnapshot: string;
  }

  function baseOrder(overrides: Partial<TestOrder> = {}): TestOrder {
    return {
      id: crypto.randomUUID(),
      tenantId: TENANT,
      companyId: COMPANY,
      originBranchId: BRANCH,
      fulfillingBranchId: BRANCH,
      kind: 'WALK_IN',
      status: 'DRAFT',
      currencyCode: 'AED',
      currencyExponent: 2,
      commercialSnapshotFingerprint: 'fp-' + crypto.randomUUID(),
      ...overrides,
    };
  }

  async function insertOrder(o: TestOrder): Promise<void> {
    await pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "posTerminalId",
          "customerId", kind, status, "currencyCode", "currencyExponent", "orderNumber",
          "commercialSnapshotFingerprint", "createdByUserId", "actingUserId", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
      [
        o.id,
        o.tenantId,
        o.companyId,
        o.originBranchId,
        o.fulfillingBranchId,
        o.posTerminalId ?? null,
        o.customerId ?? null,
        o.kind,
        o.status,
        o.currencyCode,
        o.currencyExponent,
        o.orderNumber ?? null,
        o.commercialSnapshotFingerprint,
        o.createdByUserId ?? null,
        o.actingUserId ?? null,
      ],
    );
  }

  async function insertMinimalOrder(): Promise<string> {
    const o = baseOrder();
    await insertOrder(o);
    return o.id;
  }

  function baseLine(orderId: string, overrides: Partial<TestLine> = {}): TestLine {
    return {
      id: crypto.randomUUID(),
      tenantId: TENANT,
      companyId: COMPANY,
      orderId,
      linePosition: 1,
      productId: PRODUCT,
      variantId: VARIANT,
      quantity: '1.0000',
      unitPriceAmountMinor: 1000n,
      unitPriceCurrencyCode: 'AED',
      unitPriceCurrencyExponent: 2,
      resolutionSource: 'NONE',
      selectedUomCode: 'PIECE',
      uomDisplayLabelSnapshot: 'Piece',
      baseUomCode: 'PIECE',
      conversionNumerator: 1n,
      conversionDenominator: 1n,
      productNameEnSnapshot: 'Test Product',
      variantNameEnSnapshot: 'Test Variant',
      ...overrides,
    };
  }

  async function insertLine(l: TestLine): Promise<pg.QueryResult> {
    return pool.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "discountMode", "discountBps", "discountAmountMinor",
          "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "taxCategoryKey", "rateBps", "effectiveFrom",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot",
          "variantNameEnSnapshot", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29, now())`,
      [
        l.id,
        l.tenantId,
        l.companyId,
        l.orderId,
        l.linePosition,
        l.productId,
        l.variantId,
        l.quantity,
        l.unitPriceAmountMinor,
        l.unitPriceCurrencyCode,
        l.unitPriceCurrencyExponent,
        l.discountMode ?? 'NONE',
        l.discountBps ?? null,
        l.discountAmountMinor ?? 0n,
        l.priceTaxMode ?? null,
        l.roundingScope ?? null,
        l.roundingMode ?? null,
        l.lineTaxAmountMinor ?? null,
        l.taxCategoryKey ?? null,
        l.rateBps ?? null,
        l.effectiveFrom ?? null,
        l.resolutionSource,
        l.selectedUomCode,
        l.uomDisplayLabelSnapshot,
        l.baseUomCode,
        l.conversionNumerator,
        l.conversionDenominator,
        l.productNameEnSnapshot,
        l.variantNameEnSnapshot,
      ],
    );
  }

  // ── RLS ─────────────────────────────────────────────────────────────────
  it('RLS: order / order_line / invoice / document_number_counter all have ENABLE + FORCE + a tenant-isolation policy', async () => {
    const { rows } = await pool.query<{
      relname: string;
      rls: boolean;
      force: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
         FROM pg_class c WHERE c.relname = ANY($1)`,
      [['order', 'order_line', 'invoice', 'document_number_counter']],
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.rls, `${r.relname}: RLS not enabled`).toBe(true);
      expect(r.force, `${r.relname}: RLS not FORCEd`).toBe(true);
      expect(Number(r.policies), `${r.relname}: no policy`).toBeGreaterThanOrEqual(1);
    }
  });

  it('cross-tenant DB rejection: order is invisible to a session scoped to a different tenant', async () => {
    const orderId = await insertMinimalOrder();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
      await client.query('SET LOCAL ROLE flower_app');
      const { rows } = await client.query('SELECT id FROM "order" WHERE id = $1', [orderId]);
      expect(rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── Checkpoint D final-closure §3 — completing the RLS mutation proof.
  //    The above test already proves ENABLE+FORCE+policy exist on all 4
  //    tables and proves cross-tenant SELECT invisibility for `order`. The
  //    tests below close the remaining gaps: SELECT for the other 3 tables,
  //    and UPDATE/INSERT/DELETE for all 4 — never weakening FORCE RLS or
  //    using a test-only policy bypass (still the plain `flower_app` role +
  //    `SET LOCAL app.tenant_id`, exactly like the existing test above). ───
  it('cross-tenant DB rejection: order_line / invoice / document_number_counter are also invisible to a session scoped to a different tenant (SELECT)', async () => {
    const orderId = await insertMinimalOrder();
    // `insertMinimalInvoice` inserts its own complete order_line internally
    // (a separate manual `insertLine` here would leave a SECOND, incomplete
    // line on the same order, tripping the tax-completeness trigger).
    const invoiceId = await insertMinimalInvoice(orderId);
    // a FRESH, dedicated company for this test's counter row — every fixed
    // COMPANY/COMPANY_2 constant is already load-bearing for another test's
    // exact counter value elsewhere in this file.
    const rlsCompanyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES ($1,$2,'RLS Test Co','AED','Asia/Dubai',now())`,
      [rlsCompanyId, TENANT],
    );
    await pool.query(
      `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
       VALUES ($1,$2,'ORDER',777)`,
      [TENANT, rlsCompanyId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
      await client.query('SET LOCAL ROLE flower_app');
      const lineRows = await client.query(`SELECT id FROM order_line WHERE "orderId" = $1`, [
        orderId,
      ]);
      expect(lineRows.rows).toHaveLength(0);
      const invRows = await client.query(`SELECT id FROM invoice WHERE id = $1`, [invoiceId]);
      expect(invRows.rows).toHaveLength(0);
      const counterRows = await client.query(
        `SELECT "nextNumber" FROM document_number_counter
          WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = 'ORDER'`,
        [TENANT, rlsCompanyId],
      );
      expect(counterRows.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('cross-tenant DB rejection: a foreign-tenant session cannot UPDATE or DELETE order/order_line/invoice/document_number_counter rows (zero rows affected, never an exception)', async () => {
    const orderId = await insertMinimalOrder(); // stays DRAFT — no freeze-trigger interference
    const line = baseLine(orderId);
    await insertLine(line);
    const lineId = line.id;
    const invoiceOrderId = await insertMinimalOrder();
    const invoiceId = await insertMinimalInvoice(invoiceOrderId);
    // a FRESH, dedicated company for this test's counter row — see the
    // sibling SELECT test above for why a fixed constant is unsafe here.
    const rlsCompanyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt")
       VALUES ($1,$2,'RLS Test Co 2','AED','Asia/Dubai',now())`,
      [rlsCompanyId, TENANT],
    );
    await pool.query(
      `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
       VALUES ($1,$2,'INVOICE',888)`,
      [TENANT, rlsCompanyId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
      await client.query('SET LOCAL ROLE flower_app');

      const orderUpd = await client.query(
        `UPDATE "order" SET "documentDiscountReason"='x' WHERE id=$1`,
        [orderId],
      );
      expect(orderUpd.rowCount).toBe(0);
      const orderDel = await client.query(`DELETE FROM "order" WHERE id=$1`, [orderId]);
      expect(orderDel.rowCount).toBe(0);

      if (lineId) {
        const lineUpd = await client.query(`UPDATE order_line SET quantity='2.0000' WHERE id=$1`, [
          lineId,
        ]);
        expect(lineUpd.rowCount).toBe(0);
        const lineDel = await client.query(`DELETE FROM order_line WHERE id=$1`, [lineId]);
        expect(lineDel.rowCount).toBe(0);
      }

      // invoice has no legal UPDATE even in-tenant (immutability trigger) —
      // RLS must eliminate the row BEFORE that trigger ever gets a row to
      // act on, so this must be a clean zero-rows no-op, not an exception.
      const invUpd = await client.query(
        `UPDATE invoice SET "invoicePaymentStatus"='PAID' WHERE id=$1`,
        [invoiceId],
      );
      expect(invUpd.rowCount).toBe(0);
      const invDel = await client.query(`DELETE FROM invoice WHERE id=$1`, [invoiceId]);
      expect(invDel.rowCount).toBe(0);

      const counterUpd = await client.query(
        `UPDATE document_number_counter SET "nextNumber" = "nextNumber" + 1
          WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = 'INVOICE'`,
        [TENANT, rlsCompanyId],
      );
      expect(counterUpd.rowCount).toBe(0);
      const counterDel = await client.query(
        `DELETE FROM document_number_counter
          WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = 'INVOICE'`,
        [TENANT, rlsCompanyId],
      );
      expect(counterDel.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('cross-tenant DB rejection: a foreign-tenant session cannot INSERT a row claiming the other tenant’s id (order/order_line/invoice/document_number_counter)', async () => {
    const orderId = await insertMinimalOrder();
    const client = await pool.connect();
    // each attempt runs under its OWN savepoint — Postgres aborts the whole
    // enclosing transaction after any statement error, so without a savepoint
    // per attempt, every assertion after the first would fail with
    // "current transaction is aborted" rather than exercising RLS again.
    async function expectRejectedInsert(sql: string, params: unknown[]): Promise<void> {
      await client.query('SAVEPOINT sp');
      await expect(client.query(sql, params)).rejects.toThrow(
        /row-level security|foreign key|violates/i,
      );
      await client.query('ROLLBACK TO SAVEPOINT sp');
    }
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
      await client.query('SET LOCAL ROLE flower_app');

      await expectRejectedInsert(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","commercialSnapshotFingerprint","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$3,'WALK_IN','DRAFT','AED',2,'fp-cross-tenant-insert',now())`,
        [TENANT, COMPANY, BRANCH],
      );

      await expectRejectedInsert(
        `INSERT INTO order_line
             (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
              "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
              "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
              "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,99,$4,$5,'1.0000',1000,'AED',2,'NONE','piece','Piece','piece',1,1,'x','x',now())`,
        [TENANT, COMPANY, orderId, PRODUCT, VARIANT],
      );

      // NOTE: this can be rejected via either path — the RLS policy itself,
      // OR the invoice BEFORE-INSERT trigger's own defense-in-depth check
      // (its internal `SELECT ... FROM "order"` also runs AS the invoking
      // role, so RLS hides the Tenant-A order from it too, and it correctly
      // raises "referenced order does not exist"). Both are valid,
      // deterministic rejections — this test only proves SOME fail-closed
      // path exists, not which one.
      await client.query('SAVEPOINT sp');
      await expect(
        client.query(
          `INSERT INTO invoice
             (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate","currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor","taxTotalAmountMinor","totalAmountMinor")
           VALUES (uuidv7(),$1,$2,$3,$4,'INV-CROSS-TENANT',now(),CURRENT_DATE,'AED',2,1000,0,0,1000)`,
          [TENANT, COMPANY, BRANCH, orderId],
        ),
      ).rejects.toThrow(/row-level security|foreign key|violates|does not exist/i);
      await client.query('ROLLBACK TO SAVEPOINT sp');

      await expectRejectedInsert(
        `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
           VALUES ($1,$2,'ORDER',1)`,
        [TENANT, COMPANY],
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('no-tenant-context: a session with no app.tenant_id set sees zero rows (fail-closed, never falls back to "all tenants")', async () => {
    await insertMinimalOrder();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // deliberately no SET LOCAL app.tenant_id at all.
      await client.query('SET LOCAL ROLE flower_app');
      const { rows } = await client.query(`SELECT id FROM "order"`);
      expect(rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── Checkpoint D RLS INSERT gap closure — isolating the INSERT `WITH
  //    CHECK` policy itself, distinct from FK/CHECK/unique/trigger failures.
  //    PostgreSQL's own referential-integrity (FK) machinery BYPASSES row
  //    security entirely (documented behaviour — RI checks always run with
  //    full visibility to preserve data integrity), so a candidate row whose
  //    FK targets are real, existing rows will pass FK validation regardless
  //    of the acting session's RLS-visible tenant. That isolates `WITH
  //    CHECK` as the ONLY thing that can still reject such a row. ──────────
  describe('RLS INSERT WITH CHECK proof (Checkpoint D RLS-insert gap closure)', () => {
    it('order: a genuinely OTHER_TENANT-owned candidate row is rejected specifically by WITH CHECK when inserted under a TENANT session; the identical row is permitted under the matching OTHER_TENANT session (control)', async () => {
      const otherBranchId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'RLS-Proof Other Branch',now())`,
        [otherBranchId, OTHER_TENANT, OTHER_TENANT_COMPANY],
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`); // acting session: TENANT
        await client.query('SET LOCAL ROLE flower_app');

        await client.query('SAVEPOINT sp');
        await expect(
          client.query(
            `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","commercialSnapshotFingerprint","updatedAt")
             VALUES (uuidv7(),$1,$2,$3,$3,'WALK_IN','DRAFT','AED',2,'fp-rls-insert-proof',now())`,
            [OTHER_TENANT, OTHER_TENANT_COMPANY, otherBranchId],
          ),
        ).rejects.toThrow(/row-level security/i);
        await client.query('ROLLBACK TO SAVEPOINT sp');

        // control — the IDENTICAL structurally-valid row, under the session
        // that actually matches its claimed tenant.
        await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
        const ok = await client.query(
          `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","commercialSnapshotFingerprint","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,$3,'WALK_IN','DRAFT','AED',2,'fp-rls-insert-proof-ok',now()) RETURNING id`,
          [OTHER_TENANT, OTHER_TENANT_COMPANY, otherBranchId],
        );
        expect(ok.rows).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK').catch(() => {}); // discards everything, including the control row
        client.release();
      }
    });

    it('order_line: a genuinely OTHER_TENANT-owned candidate row (real order/product/variant parents) is rejected specifically by WITH CHECK under a TENANT session; permitted under the matching session (control)', async () => {
      const otherBranchId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'RLS-Proof Other Branch 2',now())`,
        [otherBranchId, OTHER_TENANT, OTHER_TENANT_COMPANY],
      );
      const otherCategoryId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'rls-proof-flowers','RLS Proof Flowers',now())`,
        [otherCategoryId, OTHER_TENANT],
      );
      const otherProductId = crypto.randomUUID();
      const otherVariantId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy","updatedAt")
         VALUES ($1,$2,$3,'rls-proof-rose','RLS Proof Rose','STOCKED',now())`,
        [otherProductId, OTHER_TENANT, otherCategoryId],
      );
      await pool.query(
        `INSERT INTO variant (id,"tenantId","productId","nameEn","updatedAt") VALUES ($1,$2,$3,'RLS Proof Variant',now())`,
        [otherVariantId, OTHER_TENANT, otherProductId],
      );
      const otherOrderId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","commercialSnapshotFingerprint","updatedAt")
         VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,'fp-rls-proof-parent-order',now())`,
        [otherOrderId, OTHER_TENANT, OTHER_TENANT_COMPANY, otherBranchId],
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
        await client.query('SET LOCAL ROLE flower_app');

        await client.query('SAVEPOINT sp');
        await expect(
          client.query(
            `INSERT INTO order_line
               (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
                "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
                "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
                "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
             VALUES (uuidv7(),$1,$2,$3,1,$4,$5,'1.0000',1000,'AED',2,'NONE','piece','Piece','piece',1,1,'x','x',now())`,
            [OTHER_TENANT, OTHER_TENANT_COMPANY, otherOrderId, otherProductId, otherVariantId],
          ),
        ).rejects.toThrow(/row-level security/i);
        await client.query('ROLLBACK TO SAVEPOINT sp');

        await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
        const ok = await client.query(
          `INSERT INTO order_line
             (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
              "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
              "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
              "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
           VALUES (uuidv7(),$1,$2,$3,1,$4,$5,'1.0000',1000,'AED',2,'NONE','piece','Piece','piece',1,1,'x','x',now())
           RETURNING id`,
          [OTHER_TENANT, OTHER_TENANT_COMPANY, otherOrderId, otherProductId, otherVariantId],
        );
        expect(ok.rows).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('document_number_counter: a genuinely OTHER_TENANT-owned candidate row is rejected specifically by WITH CHECK under a TENANT session; permitted under the matching session (control)', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
        await client.query('SET LOCAL ROLE flower_app');

        await client.query('SAVEPOINT sp');
        await expect(
          client.query(
            `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
             VALUES ($1,$2,'ORDER',1)`,
            [OTHER_TENANT, OTHER_TENANT_COMPANY],
          ),
        ).rejects.toThrow(/row-level security/i);
        await client.query('ROLLBACK TO SAVEPOINT sp');

        await client.query(`SET LOCAL app.tenant_id = '${OTHER_TENANT}'`);
        const ok = await client.query(
          `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
           VALUES ($1,$2,'ORDER',1) RETURNING "tenantId"`,
          [OTHER_TENANT, OTHER_TENANT_COMPANY],
        );
        expect(ok.rows).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it("invoice: a candidate row is rejected specifically by WITH CHECK — using a real, session-visible order so the tax-completeness trigger's own internal (RLS-scoped) lookup passes structurally and cannot mask the RLS proof", async () => {
      // Using a genuinely OTHER_TENANT-owned order here (as for the other 3
      // tables) would NOT isolate WITH CHECK: `fn_check_invoice_tax_completeness`
      // (BEFORE INSERT) does its OWN `SELECT ... FROM "order"`, which runs AS
      // the invoking role and IS subject to RLS (unlike a declarative FK) —
      // under a TENANT session it would find nothing for an OTHER_TENANT
      // order and raise its own "referenced order does not exist" instead of
      // ever reaching WITH CHECK. So here only the `tenantId` column is
      // flipped to OTHER_TENANT; every other column is exactly what a
      // genuinely valid invoice for this real, TENANT-visible order would
      // contain — isolating WITH CHECK as the one and only reason the first
      // attempt is rejected.
      const orderId = await insertMinimalOrder(); // TENANT / COMPANY / BRANCH
      await insertLine(
        baseLine(orderId, {
          priceTaxMode: 'EXCLUSIVE',
          roundingScope: 'LINE',
          roundingMode: 'HALF_UP',
          lineTaxAmountMinor: 0n,
        }),
      );
      await confirmOrderForInvoice(orderId); // -> CONFIRMED + orderNumber, still TENANT/COMPANY/BRANCH

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`); // the SAME tenant that owns the order
        await client.query('SET LOCAL ROLE flower_app');

        await client.query('SAVEPOINT sp');
        await expect(
          client.query(
            `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate","currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor","taxTotalAmountMinor","totalAmountMinor")
             VALUES (uuidv7(),$1,$2,$3,$4,'INV-RLS-PROOF',now(),CURRENT_DATE,'AED',2,1000,0,0,1000)`,
            [OTHER_TENANT, COMPANY, BRANCH, orderId],
          ),
        ).rejects.toThrow(/row-level security/i);
        await client.query('ROLLBACK TO SAVEPOINT sp');

        // control — the identical row, tenantId corrected to match the
        // session that actually owns this order.
        const ok = await client.query(
          `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate","currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor","taxTotalAmountMinor","totalAmountMinor")
           VALUES (uuidv7(),$1,$2,$3,$4,'INV-RLS-PROOF-OK',now(),CURRENT_DATE,'AED',2,1000,0,0,1000) RETURNING id`,
          [TENANT, COMPANY, BRANCH, orderId],
        );
        expect(ok.rows).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  // ── closed vocabularies (CHECK, never a native Postgres ENUM) ────────────
  it('order.kind CHECK accepts the exact 7-value DOMAIN-MODEL.md vocabulary and rejects an invalid value', async () => {
    for (const kind of [
      'WALK_IN',
      'PICKUP',
      'DELIVERY',
      'SCHEDULED',
      'EVENT',
      'SUBSCRIPTION_INSTANCE',
      'QUOTATION',
    ]) {
      await expect(insertOrder(baseOrder({ kind }))).resolves.toBeUndefined();
    }
    await expect(insertOrder(baseOrder({ kind: 'BOGUS' }))).rejects.toThrow(
      /order_kind_chk|violates check constraint/i,
    );
  });

  it('order.status CHECK accepts the exact frozen 16-value vocabulary and rejects an invalid value', async () => {
    for (const status of [
      'DRAFT',
      'HELD',
      'PLACED',
      'CONFIRMED',
      'IN_PRODUCTION',
      'READY',
      'OUT_FOR_DELIVERY',
      'AWAITING_PICKUP',
      'COMPLETED',
      'DELIVERED',
      'REJECTED',
      'CANCELLED',
      'PAYMENT_FAILED',
      'REFUNDED',
      'DELIVERY_FAILED',
      'RESCHEDULED',
    ]) {
      await expect(insertOrder(baseOrder({ status }))).resolves.toBeUndefined();
    }
    await expect(insertOrder(baseOrder({ status: 'BOGUS' }))).rejects.toThrow(
      /order_status_chk|violates check constraint/i,
    );
  });

  it('multiple DRAFT/HELD orders coexist with orderNumber NULL (no partial-uniqueness conflict)', async () => {
    await expect(insertOrder(baseOrder({ status: 'DRAFT' }))).resolves.toBeUndefined();
    await expect(insertOrder(baseOrder({ status: 'HELD' }))).resolves.toBeUndefined();
    await expect(insertOrder(baseOrder({ status: 'DRAFT' }))).resolves.toBeUndefined();
  });

  it('order-number uniqueness: two orders in the same company cannot share a non-null orderNumber', async () => {
    await insertOrder(baseOrder({ orderNumber: 'ORD-000001' }));
    await expect(insertOrder(baseOrder({ orderNumber: 'ORD-000001' }))).rejects.toThrow(
      /order_tenantId_companyId_orderNumber_key|duplicate key/i,
    );
  });

  // ── discount shape (order-level + line-level, identical invariant) ───────
  it('order document-discount shape CHECK enforces the exact per-mode invariant', async () => {
    await expect(
      insertOrder(
        baseOrder({
          documentDiscountMode: 'NONE',
          documentDiscountBps: null,
          documentDiscountAmountMinor: 0,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      pool.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor","commercialSnapshotFingerprint","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'WALK_IN','DRAFT','AED',2,'NONE',NULL,500,'fp-shape-1',now())`,
        [crypto.randomUUID(), TENANT, COMPANY, BRANCH, BRANCH],
      ),
    ).rejects.toThrow(/order_document_discount_shape_chk|violates check constraint/i);
    await expect(
      pool.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor","commercialSnapshotFingerprint","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'WALK_IN','DRAFT','AED',2,'PERCENT_BPS',NULL,0,'fp-shape-2',now())`,
        [crypto.randomUUID(), TENANT, COMPANY, BRANCH, BRANCH],
      ),
    ).rejects.toThrow(/order_document_discount_shape_chk|violates check constraint/i);
    await expect(
      pool.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor","commercialSnapshotFingerprint","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'WALK_IN','DRAFT','AED',2,'PERCENT_BPS',10001,0,'fp-shape-3',now())`,
        [crypto.randomUUID(), TENANT, COMPANY, BRANCH, BRANCH],
      ),
    ).rejects.toThrow(/order_document_discount_shape_chk|violates check constraint/i);
    await expect(
      pool.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor","commercialSnapshotFingerprint","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'WALK_IN','DRAFT','AED',2,'PERCENT_BPS',500,25,'fp-shape-4',now())`,
        [crypto.randomUUID(), TENANT, COMPANY, BRANCH, BRANCH],
      ),
    ).resolves.toBeTruthy();
  });

  it('order_line discount shape CHECK enforces the identical per-mode invariant', async () => {
    const orderId = await insertMinimalOrder();
    await expect(insertLine(baseLine(orderId))).resolves.toBeTruthy();
    await expect(
      insertLine(
        baseLine(orderId, {
          id: crypto.randomUUID(),
          linePosition: 2,
          discountMode: 'AMOUNT',
          discountBps: 100,
        }),
      ),
    ).rejects.toThrow(/order_line_discount_shape_chk|violates check constraint/i);
    await expect(
      insertLine(
        baseLine(orderId, {
          id: crypto.randomUUID(),
          linePosition: 2,
          discountMode: 'PERCENT_BPS',
          discountBps: 500,
          discountAmountMinor: 50n,
        }),
      ),
    ).resolves.toBeTruthy();
  });

  // ── reserved Task 3b.4 tax-snapshot columns — all-or-nothing ─────────────
  it('order_line reserved tax-snapshot columns (priceTaxMode/roundingScope/roundingMode/lineTaxAmountMinor) are all-NULL or all-present', async () => {
    const orderId = await insertMinimalOrder();
    await expect(insertLine(baseLine(orderId))).resolves.toBeTruthy(); // all-NULL, default
    await expect(
      insertLine(
        baseLine(orderId, { id: crypto.randomUUID(), linePosition: 2, priceTaxMode: 'EXCLUSIVE' }),
      ),
    ).rejects.toThrow(/order_line_tax_snapshot_shape_chk|violates check constraint/i);
    await expect(
      insertLine(
        baseLine(orderId, {
          id: crypto.randomUUID(),
          linePosition: 2,
          priceTaxMode: 'EXCLUSIVE',
          roundingScope: 'LINE',
          roundingMode: 'HALF_UP',
          lineTaxAmountMinor: 50n,
        }),
      ),
    ).resolves.toBeTruthy();
  });

  // ── linePosition (Checkpoint C final-hardening §1) ───────────────────────
  it('duplicate linePosition within the same order is rejected structurally', async () => {
    const orderId = await insertMinimalOrder();
    await expect(insertLine(baseLine(orderId, { linePosition: 1 }))).resolves.toBeTruthy();
    await expect(
      insertLine(baseLine(orderId, { id: crypto.randomUUID(), linePosition: 1 })),
    ).rejects.toThrow(/order_line_tenantId_companyId_orderId_linePosition_key|duplicate key/i);
    // a DIFFERENT position for the same order succeeds — proves the
    // uniqueness is scoped to (tenantId, companyId, orderId), not global.
    await expect(
      insertLine(baseLine(orderId, { id: crypto.randomUUID(), linePosition: 2 })),
    ).resolves.toBeTruthy();
  });

  it('order_line.linePosition must be strictly positive', async () => {
    const orderId = await insertMinimalOrder();
    await expect(insertLine(baseLine(orderId, { linePosition: 0 }))).rejects.toThrow(
      /order_line_line_position_positive_chk|violates check constraint/i,
    );
  });

  it('order_line.quantity must be strictly positive', async () => {
    const orderId = await insertMinimalOrder();
    await expect(insertLine(baseLine(orderId, { quantity: '0.0000' }))).rejects.toThrow(
      /order_line_quantity_positive_chk|violates check constraint/i,
    );
  });

  // ── tax-reference snapshot — the 3 legitimate TaxResolutionResult shapes ──
  it('order_line.resolutionSource CHECK accepts VARIANT/PRODUCT/NONE and rejects an invalid value', async () => {
    const orderId = await insertMinimalOrder();
    let pos = 1;
    for (const resolutionSource of ['VARIANT', 'PRODUCT', 'NONE']) {
      await expect(
        insertLine(
          baseLine(orderId, {
            id: crypto.randomUUID(),
            linePosition: pos++,
            resolutionSource,
            taxCategoryKey: resolutionSource === 'NONE' ? null : 'STANDARD',
          }),
        ),
      ).resolves.toBeTruthy();
    }
    await expect(
      insertLine(
        baseLine(orderId, {
          id: crypto.randomUUID(),
          linePosition: pos,
          resolutionSource: 'BOGUS',
        }),
      ),
    ).rejects.toThrow(/order_line_resolution_source_chk|violates check constraint/i);
  });

  it('tax-reference shape 1 (NO_CATEGORY_ASSIGNED): resolutionSource=NONE with taxCategoryKey/rateBps/effectiveFrom all NULL is accepted', async () => {
    const orderId = await insertMinimalOrder();
    await expect(
      insertLine(
        baseLine(orderId, {
          resolutionSource: 'NONE',
          taxCategoryKey: null,
          rateBps: null,
          effectiveFrom: null,
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('tax-reference shape 2 (REGIME_NONE / NO_RATE_FOR_CATEGORY): a resolved category with no rate is accepted', async () => {
    const orderId = await insertMinimalOrder();
    await expect(
      insertLine(
        baseLine(orderId, {
          resolutionSource: 'VARIANT',
          taxCategoryKey: 'STANDARD',
          rateBps: null,
          effectiveFrom: null,
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('tax-reference shape 3 (fully resolved): category + rate + date all present, including a real configured 0% rate, is accepted', async () => {
    const orderId = await insertMinimalOrder();
    await expect(
      insertLine(
        baseLine(orderId, {
          resolutionSource: 'PRODUCT',
          taxCategoryKey: 'ZERO_RATED',
          rateBps: 0,
          effectiveFrom: new Date('2026-01-01'),
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('tax-reference: resolutionSource=NONE with a non-NULL taxCategoryKey is rejected (source/category consistency)', async () => {
    const orderId = await insertMinimalOrder();
    await expect(
      insertLine(baseLine(orderId, { resolutionSource: 'NONE', taxCategoryKey: 'STANDARD' })),
    ).rejects.toThrow(/order_line_tax_category_source_consistency_chk|violates check constraint/i);
  });

  it('tax-reference: a non-NULL taxCategoryKey with resolutionSource=NONE is rejected the other way too (rateBps present, taxCategoryKey null)', async () => {
    const orderId = await insertMinimalOrder();
    await expect(
      insertLine(
        baseLine(orderId, {
          resolutionSource: 'VARIANT',
          taxCategoryKey: null,
          rateBps: 500,
          effectiveFrom: new Date('2026-01-01'),
        }),
      ),
    ).rejects.toThrow(/order_line_tax_rate_implies_category_chk|violates check constraint/i);
  });

  it('tax-reference: rateBps and effectiveFrom must travel together (one NULL, the other set, is rejected)', async () => {
    const orderId = await insertMinimalOrder();
    await expect(
      insertLine(
        baseLine(orderId, {
          resolutionSource: 'VARIANT',
          taxCategoryKey: 'STANDARD',
          rateBps: 500,
          effectiveFrom: null,
        }),
      ),
    ).rejects.toThrow(/order_line_tax_rate_date_pair_chk|violates check constraint/i);
    await expect(
      insertLine(
        baseLine(orderId, {
          resolutionSource: 'VARIANT',
          taxCategoryKey: 'STANDARD',
          rateBps: null,
          effectiveFrom: new Date('2026-01-01'),
        }),
      ),
    ).rejects.toThrow(/order_line_tax_rate_date_pair_chk|violates check constraint/i);
  });

  // ── commercialSnapshotFingerprint — NOT NULL from creation onward ────────
  it('order.commercialSnapshotFingerprint is NOT NULL — an order cannot be created without one', async () => {
    await expect(
      pool.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'WALK_IN','DRAFT','AED',2,now())`,
        [crypto.randomUUID(), TENANT, COMPANY, BRANCH, BRANCH],
      ),
    ).rejects.toThrow(/null value in column "commercialSnapshotFingerprint"|not-null constraint/i);
  });

  it('a DRAFT order with zero lines still has a non-null commercialSnapshotFingerprint', async () => {
    const orderId = await insertMinimalOrder();
    const { rows } = await pool.query<{ commercialSnapshotFingerprint: string | null }>(
      `SELECT "commercialSnapshotFingerprint" FROM "order" WHERE id = $1`,
      [orderId],
    );
    expect(rows[0]!.commercialSnapshotFingerprint).not.toBeNull();
  });

  // ── branch-scoped index (index-review hardening pass) ────────────────────
  it('a branch-scoped (tenantId, companyId, originBranchId, status) index exists on order', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'order' AND indexname = $1`,
      ['order_tenantId_companyId_originBranchId_status_idx'],
    );
    expect(rows).toHaveLength(1);
  });

  // ── invoice ───────────────────────────────────────────────────────────────
  /**
   * Checkpoint C final-hardening (§3) — the widened invoice-insert backstop
   * requires the referenced order to already be `CONFIRMED` with a non-null
   * `orderNumber` (never merely DRAFT), matching what the real
   * `InvoiceIssuanceRepository` primitive always does before it ever inserts
   * an Invoice. Performs the ONE legal `fn_enforce_order_commercial_freeze`
   * transition (`DRAFT -> CONFIRMED`, `version + 1`, every other commercial
   * field unchanged) directly via raw SQL. Idempotent per order — a second
   * call against an already-CONFIRMED order is a no-op (needed because
   * `insertMinimalInvoice` is deliberately called twice against the SAME
   * order in the "one Invoice per Order" test below).
   */
  async function confirmOrderForInvoice(orderId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string; orderNumber: string | null }>(
      `SELECT status, "orderNumber" FROM "order" WHERE id = $1`,
      [orderId],
    );
    if (rows[0]!.status === 'CONFIRMED' && rows[0]!.orderNumber) return rows[0]!.orderNumber;
    const orderNumber = `ORD-${crypto.randomUUID().slice(0, 6)}`;
    await pool.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1
        WHERE id = $1`,
      [orderId, orderNumber],
    );
    return orderNumber;
  }

  async function insertMinimalInvoice(
    orderId: string,
    overrides: { invoiceNumber?: string; invoicePaymentStatus?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    // Checkpoint C's tax-completeness trigger requires >=1 order_line with a
    // complete finalized tax snapshot before any invoice INSERT can succeed.
    const { rows: posRows } = await pool.query<{ next: number }>(
      `SELECT COALESCE(MAX("linePosition"), 0) + 1 AS next FROM order_line WHERE "orderId" = $1`,
      [orderId],
    );
    await insertLine(
      baseLine(orderId, {
        id: crypto.randomUUID(),
        linePosition: posRows[0]!.next,
        priceTaxMode: 'EXCLUSIVE',
        roundingScope: 'LINE',
        roundingMode: 'HALF_UP',
        lineTaxAmountMinor: 0n,
      }),
    );
    await confirmOrderForInvoice(orderId);
    await pool.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor",
          "invoicePaymentStatus")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 1000, 0, 0, 1000, $7)`,
      [
        id,
        TENANT,
        COMPANY,
        BRANCH,
        orderId,
        overrides.invoiceNumber ?? `INV-${id.slice(0, 6)}`,
        overrides.invoicePaymentStatus ?? 'UNPAID',
      ],
    );
    return id;
  }

  it('invoice.invoicePaymentStatus CHECK accepts the ADR-0019 vocabulary and rejects an invalid value', async () => {
    for (const status of [
      'UNPAID',
      'PARTIAL',
      'PAID',
      'SETTLED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'CANCELLED',
      'VOID',
    ]) {
      const orderId = await insertMinimalOrder();
      await expect(
        insertMinimalInvoice(orderId, { invoicePaymentStatus: status }),
      ).resolves.toBeTruthy();
    }
    const orderId = await insertMinimalOrder();
    await insertLine(
      baseLine(orderId, {
        priceTaxMode: 'EXCLUSIVE',
        roundingScope: 'LINE',
        roundingMode: 'HALF_UP',
        lineTaxAmountMinor: 0n,
      }),
    );
    await confirmOrderForInvoice(orderId);
    await expect(
      pool.query(
        `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate","currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor","taxTotalAmountMinor","totalAmountMinor","invoicePaymentStatus")
         VALUES ($1,$2,$3,$4,$5,'INV-BOGUS', now(), CURRENT_DATE, 'AED', 2, 1000, 0, 0, 1000, 'BOGUS')`,
        [crypto.randomUUID(), TENANT, COMPANY, BRANCH, orderId],
      ),
    ).rejects.toThrow(/invoice_payment_status_chk|violates check constraint/i);
  });

  it('invoice: one Invoice per Order (unique orderId) — a second Invoice for the same Order is rejected', async () => {
    const orderId = await insertMinimalOrder();
    await insertMinimalInvoice(orderId);
    await expect(insertMinimalInvoice(orderId)).rejects.toThrow(
      /invoice_orderId_key|duplicate key/i,
    );
  });

  it('invoice-number uniqueness: two invoices in the same company cannot share an invoiceNumber', async () => {
    const orderA = await insertMinimalOrder();
    const orderB = await insertMinimalOrder();
    await insertMinimalInvoice(orderA, { invoiceNumber: 'INV-000001' });
    await expect(insertMinimalInvoice(orderB, { invoiceNumber: 'INV-000001' })).rejects.toThrow(
      /invoice_tenantId_companyId_invoiceNumber_key|duplicate key/i,
    );
  });

  it('invoice totals CHECK rejects a negative total', async () => {
    const orderId = await insertMinimalOrder();
    await insertLine(
      baseLine(orderId, {
        priceTaxMode: 'EXCLUSIVE',
        roundingScope: 'LINE',
        roundingMode: 'HALF_UP',
        lineTaxAmountMinor: 0n,
      }),
    );
    await confirmOrderForInvoice(orderId);
    await expect(
      pool.query(
        `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate","currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor","taxTotalAmountMinor","totalAmountMinor")
         VALUES ($1,$2,$3,$4,$5,'INV-NEG', now(), CURRENT_DATE, 'AED', 2, 1000, 0, 0, -1)`,
        [crypto.randomUUID(), TENANT, COMPANY, BRANCH, orderId],
      ),
    ).rejects.toThrow(/invoice_totals_nonneg_chk|violates check constraint/i);
  });

  // ── invoice DB backstop — the widened structural shape check (Checkpoint C
  //    final-hardening §3) — every condition checked individually, plus one
  //    valid direct structural shape proving the trigger accepts a correct
  //    finalized document. ────────────────────────────────────────────────
  describe('invoice insert DB backstop (Checkpoint C final-hardening §3)', () => {
    async function insertLineFor(orderId: string): Promise<void> {
      await insertLine(
        baseLine(orderId, {
          priceTaxMode: 'EXCLUSIVE',
          roundingScope: 'LINE',
          roundingMode: 'HALF_UP',
          lineTaxAmountMinor: 0n,
        }),
      );
    }
    function rawInsertInvoice(overrides: {
      orderId: string;
      branchId?: string;
      currencyCode?: string;
      currencyExponent?: number;
    }): Promise<pg.QueryResult> {
      return pool.query(
        `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate","currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor","taxTotalAmountMinor","totalAmountMinor")
         VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, $7, $8, 1000, 0, 0, 1000)`,
        [
          crypto.randomUUID(),
          TENANT,
          COMPANY,
          overrides.branchId ?? BRANCH,
          overrides.orderId,
          `INV-${crypto.randomUUID().slice(0, 6)}`,
          overrides.currencyCode ?? 'AED',
          overrides.currencyExponent ?? 2,
        ],
      );
    }

    it('a DRAFT order (never confirmed) is rejected', async () => {
      const orderId = await insertMinimalOrder(); // DRAFT, orderNumber NULL
      await insertLineFor(orderId);
      await expect(rawInsertInvoice({ orderId })).rejects.toThrow(/is not CONFIRMED|violates/i);
    });

    it('an order without orderNumber is rejected even if (hypothetically) not DRAFT', async () => {
      const orderId = await insertMinimalOrder();
      await insertLineFor(orderId);
      // CONFIRMED but orderNumber still NULL — a shape the real issuance
      // primitive never produces (it always sets both together), but the DB
      // backstop must still fail closed against this raw-SQL-only shape.
      await pool.query(
        `UPDATE "order" SET status = 'CONFIRMED', version = version + 1 WHERE id = $1`,
        [orderId],
      );
      await expect(rawInsertInvoice({ orderId })).rejects.toThrow(
        /has no orderNumber assigned|violates/i,
      );
    });

    it('a branchId that does not equal the order originBranchId is rejected', async () => {
      const orderId = await insertMinimalOrder();
      await insertLineFor(orderId);
      await confirmOrderForInvoice(orderId);
      await expect(rawInsertInvoice({ orderId, branchId: BRANCH_2 })).rejects.toThrow(
        /branchId must equal order|violates/i,
      );
    });

    it('a currencyCode that does not equal the order currencyCode is rejected', async () => {
      const orderId = await insertMinimalOrder();
      await insertLineFor(orderId);
      await confirmOrderForInvoice(orderId);
      await expect(
        rawInsertInvoice({ orderId, currencyCode: 'USD', currencyExponent: 2 }),
      ).rejects.toThrow(/currencyCode must equal order|violates foreign key|violates/i);
    });

    it('a currencyExponent that does not equal the order currencyExponent is rejected', async () => {
      const orderId = await insertMinimalOrder();
      await insertLineFor(orderId);
      await confirmOrderForInvoice(orderId);
      await expect(rawInsertInvoice({ orderId, currencyExponent: 3 })).rejects.toThrow(
        /currencyExponent must equal order|violates foreign key|violates/i,
      );
    });

    it('an order with zero order_line rows is rejected', async () => {
      const orderId = await insertMinimalOrder();
      await confirmOrderForInvoice(orderId);
      await expect(rawInsertInvoice({ orderId })).rejects.toThrow(
        /has zero order_line rows|violates/i,
      );
    });

    it('an order whose line has an incomplete mandatory tax snapshot is rejected', async () => {
      const orderId = await insertMinimalOrder();
      await insertLine(baseLine(orderId)); // all-NULL tax snapshot, default
      await confirmOrderForInvoice(orderId);
      await expect(rawInsertInvoice({ orderId })).rejects.toThrow(
        /incomplete mandatory tax snapshot|violates/i,
      );
    });

    it('a fully correct finalized shape is accepted', async () => {
      const orderId = await insertMinimalOrder();
      await insertLineFor(orderId);
      await confirmOrderForInvoice(orderId);
      await expect(rawInsertInvoice({ orderId })).resolves.toBeTruthy();
    });
  });

  // ── user-attribution write-once immutability (Checkpoint C final-hardening
  //    §2, owner correction) — createdByUserId/actingUserId must never be
  //    overwritten, in ANY status, via raw SQL. ────────────────────────────
  describe('order attribution immutability (Checkpoint C final-hardening §2)', () => {
    it('a DRAFT order rejects a createdByUserId change', async () => {
      const o = baseOrder({ createdByUserId: CUSTOMER });
      await insertOrder(o);
      await expect(
        pool.query(`UPDATE "order" SET "createdByUserId" = $2 WHERE id = $1`, [
          o.id,
          OTHER_TENANT_CUSTOMER,
        ]),
      ).rejects.toThrow(/createdByUserId is original attribution|violates/i);
    });

    it('a DRAFT order rejects an actingUserId change', async () => {
      const o = baseOrder({ actingUserId: CUSTOMER });
      await insertOrder(o);
      await expect(
        pool.query(`UPDATE "order" SET "actingUserId" = $2 WHERE id = $1`, [
          o.id,
          OTHER_TENANT_CUSTOMER,
        ]),
      ).rejects.toThrow(/actingUserId is original attribution|violates/i);
    });

    it('a CONFIRMED (issued) order rejects a createdByUserId change', async () => {
      const o = baseOrder({ createdByUserId: CUSTOMER });
      await insertOrder(o);
      await insertLine(baseLine(o.id));
      await confirmOrderForInvoice(o.id);
      await expect(
        pool.query(`UPDATE "order" SET "createdByUserId" = $2 WHERE id = $1`, [
          o.id,
          OTHER_TENANT_CUSTOMER,
        ]),
      ).rejects.toThrow(/createdByUserId is original attribution|violates/i);
    });

    it('a CONFIRMED (issued) order rejects an actingUserId change', async () => {
      const o = baseOrder({ actingUserId: CUSTOMER });
      await insertOrder(o);
      await insertLine(baseLine(o.id));
      await confirmOrderForInvoice(o.id);
      await expect(
        pool.query(`UPDATE "order" SET "actingUserId" = $2 WHERE id = $1`, [
          o.id,
          OTHER_TENANT_CUSTOMER,
        ]),
      ).rejects.toThrow(/actingUserId is original attribution|violates/i);
    });

    it('a same-value UPDATE of createdByUserId/actingUserId is harmless (no semantic change)', async () => {
      const o = baseOrder({ createdByUserId: CUSTOMER, actingUserId: CUSTOMER });
      await insertOrder(o);
      await expect(
        pool.query(
          `UPDATE "order" SET "createdByUserId" = "createdByUserId", "actingUserId" = "actingUserId"
             WHERE id = $1`,
          [o.id],
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ── document_number_counter ──────────────────────────────────────────────
  it('document_number_counter.documentType CHECK accepts ORDER/INVOICE and rejects an invalid value; independent per-type counters', async () => {
    await pool.query(
      `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
       VALUES ($1,$2,'ORDER',5)`,
      [TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
       VALUES ($1,$2,'INVOICE',5)`,
      [TENANT, COMPANY],
    );
    await expect(
      pool.query(
        `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
         VALUES ($1,$2,'CREDIT_NOTE',1)`,
        [TENANT, COMPANY_2],
      ),
    ).rejects.toThrow(/document_number_counter_document_type_chk|violates check constraint/i);

    const orderRow = await pool.query(
      `UPDATE document_number_counter SET "nextNumber" = "nextNumber" + 1
         WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = 'ORDER'
       RETURNING "nextNumber" - 1 AS allocated`,
      [TENANT, COMPANY],
    );
    const invoiceRow = await pool.query(
      `SELECT "nextNumber" FROM document_number_counter
        WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = 'INVOICE'`,
      [TENANT, COMPANY],
    );
    expect(Number(orderRow.rows[0].allocated)).toBe(5);
    expect(Number(invoiceRow.rows[0].nextNumber)).toBe(5); // untouched — independent counters
  });

  it('document_number_counter.nextNumber must stay >= 1', async () => {
    await expect(
      pool.query(
        `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
         VALUES ($1,$2,'ORDER',0)`,
        [TENANT, COMPANY_2],
      ),
    ).rejects.toThrow(
      /document_number_counter_next_number_positive_chk|violates check constraint/i,
    );
  });

  it('numbering counter increment is rollback-safe (a rolled-back transaction consumes no number)', async () => {
    await pool.query(
      `INSERT INTO document_number_counter ("tenantId","companyId","documentType","nextNumber")
       VALUES ($1,$2,'ORDER',100) ON CONFLICT DO NOTHING`,
      [TENANT, COMPANY_2],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE document_number_counter SET "nextNumber" = "nextNumber" + 1
           WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = 'ORDER'`,
        [TENANT, COMPANY_2],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      `SELECT "nextNumber" FROM document_number_counter
        WHERE "tenantId" = $1 AND "companyId" = $2 AND "documentType" = 'ORDER'`,
      [TENANT, COMPANY_2],
    );
    expect(Number(rows[0].nextNumber)).toBe(100); // unchanged — the increment rolled back
  });

  // ── structural Company/Branch/POS/Customer/Product/Variant integrity ────
  it('an order cannot reference a company from a different tenant (composite FK)', async () => {
    await expect(insertOrder(baseOrder({ companyId: OTHER_TENANT_COMPANY }))).rejects.toThrow(
      /order_company_tenant_fkey|violates foreign key/i,
    );
  });

  it('an order cannot reference a branch from a different company as originBranch/fulfillingBranch (composite FK)', async () => {
    await expect(insertOrder(baseOrder({ originBranchId: BRANCH_2 }))).rejects.toThrow(
      /order_origin_branch_tenant_company_fkey|violates foreign key/i,
    );
    await expect(insertOrder(baseOrder({ fulfillingBranchId: BRANCH_2 }))).rejects.toThrow(
      /order_fulfilling_branch_tenant_company_fkey|violates foreign key/i,
    );
  });

  it('an order cannot attribute a POS terminal from a different branch than its origin branch (composite FK)', async () => {
    await expect(
      insertOrder(baseOrder({ posTerminalId: POS_TERMINAL_OTHER_BRANCH })),
    ).rejects.toThrow(/order_pos_tenant_company_branch_fkey|violates foreign key/i);
    await expect(insertOrder(baseOrder({ posTerminalId: POS_TERMINAL }))).resolves.toBeUndefined();
  });

  it('an order cannot reference a customer from a different tenant (composite FK)', async () => {
    await expect(insertOrder(baseOrder({ customerId: OTHER_TENANT_CUSTOMER }))).rejects.toThrow(
      /order_customer_tenant_fkey|violates foreign key/i,
    );
    await expect(insertOrder(baseOrder({ customerId: CUSTOMER }))).resolves.toBeUndefined();
  });

  it("an order currencyCode must match the company's current defaultCurrency (composite FK)", async () => {
    await expect(
      insertOrder(baseOrder({ currencyCode: 'KWD', currencyExponent: 3 })),
    ).rejects.toThrow(/order_currency_company_fkey|violates foreign key/i);
  });

  it('an order currencyCode/currencyExponent pair must be authoritative (composite FK to currency)', async () => {
    await expect(
      insertOrder(baseOrder({ currencyExponent: 3 })), // AED is exponent 2, not 3
    ).rejects.toThrow(/order_currency_exponent_fkey|violates foreign key/i);
  });

  it('an order_line cannot reference a product from a different tenant (composite FK)', async () => {
    const orderId = await insertMinimalOrder();
    // OTHER_TENANT has no product rows at all — any productId under this
    // tenant's order fails the tenant-safe composite FK.
    await expect(insertLine(baseLine(orderId, { productId: crypto.randomUUID() }))).rejects.toThrow(
      /order_line_product_tenant_fkey|violates foreign key/i,
    );
  });

  it('an order_line cannot claim productId=A while variantId belongs to productId=B (same-product composite FK)', async () => {
    const orderId = await insertMinimalOrder();
    await expect(
      insertLine(baseLine(orderId, { productId: PRODUCT, variantId: VARIANT_2 })),
    ).rejects.toThrow(/order_line_variant_same_product_fkey|violates foreign key/i);
    await expect(
      insertLine(baseLine(orderId, { productId: PRODUCT_2, variantId: VARIANT_2 })),
    ).resolves.toBeTruthy();
  });

  // ── explicit non-scope confirmations ─────────────────────────────────────
  it('order / order_line are plain (non-partitioned) tables — partitioning is deferred, not implemented', async () => {
    const { rows } = await pool.query<{ relname: string; relkind: string }>(
      `SELECT relname, relkind FROM pg_class WHERE relname = ANY($1)`,
      [['order', 'order_line', 'invoice']],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(
        r.relkind,
        `${r.relname} should be an ordinary table ('r'), not partitioned ('p')`,
      ).toBe('r');
    }
  });

  it('no invoice_line table exists', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'invoice_line'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('no Payment/AR/Advance/Inventory table exists', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name = ANY($1)`,
      [
        [
          'payment',
          'payment_attempt',
          'payment_allocation',
          'payment_method_config',
          'ar_transaction',
          'advance_transaction',
          'settlement',
          'cancellation',
          'refund',
          'credit_note',
          'inventory_movement',
          'branch_inventory_balance',
          'stock_reservation',
        ],
      ],
    );
    expect(rows).toHaveLength(0);
  });

  // ── permissions ───────────────────────────────────────────────────────────
  it('permission_registry has exactly orders:view/manage/cancel registered', async () => {
    const { rows } = await pool.query<{ key: string }>(
      `SELECT key FROM permission_registry WHERE key LIKE 'orders:%' ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual(['orders:cancel', 'orders:manage', 'orders:view']);
  });

  it('owner-frozen role-default matrix: exact per-role orders:* grants, idempotent, no other role touched', async () => {
    const roleTenant = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'ord-3b3-roles', 'ord-3b3-roles', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
      [roleTenant],
    );
    const roleIds: Record<string, string> = {};
    for (const [key, isSystem] of [
      ['owner', true],
      ['admin', true],
      ['manager', true],
      ['cashier', true],
      ['sales', true],
      ['supervisor', true], // isSystem but NOT in the frozen orders:* matrix
      ['custom_role', false], // tenant-created, never touched by any backfill
    ] as const) {
      const r = await pool.query(
        `INSERT INTO role (id, "tenantId", key, name, "isSystem", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $2, $3, now()) RETURNING id`,
        [roleTenant, key, isSystem],
      );
      roleIds[key] = r.rows[0].id;
    }

    // re-run the exact backfill statements from
    // `20260920130000_orders_permissions/migration.sql`, mirroring the
    // established precedent (`migration.test.ts`'s customer-permissions
    // backfill regression) — migrate deploy already ran in beforeAll before
    // any tenant/role existed, so the migration's own INSERT had zero rows to
    // act on; re-running it here against freshly seeded roles exercises the
    // identical SQL.
    const backfill = `
      ALTER TABLE "role"            NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "role_permission" NO FORCE ROW LEVEL SECURITY;
      INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
      SELECT uuidv7(), r."tenantId", r."id", k.key
        FROM "role" r CROSS JOIN (VALUES ('orders:view'), ('orders:manage')) AS k(key)
       WHERE r."isSystem" = true AND r."key" IN ('owner', 'admin', 'manager', 'cashier', 'sales')
      ON CONFLICT ("roleId", "permissionKey") DO NOTHING;
      INSERT INTO "role_permission" ("id", "tenantId", "roleId", "permissionKey")
      SELECT uuidv7(), r."tenantId", r."id", 'orders:cancel'
        FROM "role" r
       WHERE r."isSystem" = true AND r."key" IN ('owner', 'admin', 'manager')
      ON CONFLICT ("roleId", "permissionKey") DO NOTHING;
      ALTER TABLE "role"            FORCE ROW LEVEL SECURITY;
      ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;`;
    await pool.query(backfill);
    await pool.query(backfill); // twice — must not create duplicates (idempotent)

    const perms = async (roleId: string): Promise<string[]> =>
      (
        await pool.query<{ permissionKey: string }>(
          `SELECT "permissionKey" FROM "role_permission" WHERE "roleId" = $1 AND "permissionKey" LIKE 'orders:%' ORDER BY "permissionKey"`,
          [roleId],
        )
      ).rows.map((r) => r.permissionKey);

    expect(await perms(roleIds['owner']!)).toEqual([
      'orders:cancel',
      'orders:manage',
      'orders:view',
    ]);
    expect(await perms(roleIds['admin']!)).toEqual([
      'orders:cancel',
      'orders:manage',
      'orders:view',
    ]);
    expect(await perms(roleIds['manager']!)).toEqual([
      'orders:cancel',
      'orders:manage',
      'orders:view',
    ]);
    expect(await perms(roleIds['cashier']!)).toEqual(['orders:manage', 'orders:view']);
    expect(await perms(roleIds['sales']!)).toEqual(['orders:manage', 'orders:view']);
    expect(await perms(roleIds['supervisor']!)).toEqual([]);
    expect(await perms(roleIds['custom_role']!)).toEqual([]);
  });
});
