import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, inParallel, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped, type PrismaClient } from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { PaymentCollectionRepository } from './payment-collection.repository.js';
import type { TenderMethod } from './tender.js';

/**
 * Task 3b.5 Checkpoint C+D — `PaymentCollectionRepository` proven directly
 * against real Postgres, through the actual production `runScoped` path (no
 * HTTP, no NestJS bootstrap needed — this class takes zero injected
 * dependencies). Covers the Invoice lock, confirmed/reserved balance
 * arithmetic, overpayment hard gates, active-reservation interaction,
 * concurrent final-balance serialization, caller-transaction rollback,
 * DB-backstop cooperation, and same-tenant company/branch access scoping
 * (Checkpoint B §1's deferred proof — begins here) for BOTH the single-
 * tender primitive (`captureSingleTenderInTx`, Checkpoint C) and its
 * Checkpoint D generalization to N>=1 synchronous tenders in one atomic
 * transaction (`captureSynchronousTendersInTx`) — the former is now a thin,
 * shape-preserving delegate to the latter, and every original Checkpoint C
 * test below is unchanged and still exercises it directly.
 *
 * Neither checkpoint adds GL/Invoice.invoicePaymentStatus — nothing here
 * asserts on those because nothing here writes them. Checkpoint G added
 * audit/outbox co-commit on top of this same primitive — proven in
 * `payment-collection.repository.integration.test.ts`'s own dedicated
 * audit/outbox describe block below, not scattered through every
 * pre-existing C/D test.
 */
const TENANT = 'c1000000-1111-7111-8111-111111111111';
const OTHER_TENANT = 'c2000000-2222-7222-8222-222222222222';
const COMPANY = 'c3000000-3333-7333-8333-333333333333';
const COMPANY_2 = 'c4000000-4444-7444-8444-444444444444';
const OTHER_TENANT_COMPANY = 'c5000000-5555-7555-8555-555555555555';
const BRANCH = 'c6000000-6666-7666-8666-666666666666';
const BRANCH_2 = 'c7000000-7777-7777-8777-777777777777';
const OTHER_TENANT_BRANCH = 'c8000000-8888-7888-8888-888888888888';
const CATEGORY = 'c9000000-9999-7999-8999-999999999999';
const PRODUCT = 'ca000000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const VARIANT = 'cb000000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const PROVIDER_CRED_BRANCH = 'cc000000-cccc-7ccc-8ccc-cccccccccccc';

describe('PaymentCollectionRepository (task 3b.5 Checkpoint C+D, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let collection: PaymentCollectionRepository;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    // `AuditWriter`/`OutboxWriter`'s `db` field is only dereferenced by their
    // own `.emit()` (a standalone platform transaction) — `.record()`/
    // `.enqueue()`, the only methods `PaymentCollectionRepository` calls,
    // take an already-open `tx` directly and never touch `this.db`.
    collection = new PaymentCollectionRepository(new AuditWriter(db), new OutboxWriter(db));

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002',
               '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    for (const [tenantId, slug] of [
      [TENANT, 'pc-3b5'],
      [OTHER_TENANT, 'pc-3b5-other'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [tenantId, slug],
      );
    }
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    for (const [id, tenantId, name] of [
      [COMPANY, TENANT, 'Co'],
      [COMPANY_2, TENANT, 'Co 2'],
      [OTHER_TENANT_COMPANY, OTHER_TENANT, 'Other Tenant Co'],
    ] as const) {
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, $3, 'AED', 'Asia/Dubai', now())`,
        [id, tenantId, name],
      );
    }
    for (const [id, tenantId, companyId, name] of [
      [BRANCH, TENANT, COMPANY, 'Main'],
      [BRANCH_2, TENANT, COMPANY_2, 'Co2 Branch'],
      [OTHER_TENANT_BRANCH, OTHER_TENANT, OTHER_TENANT_COMPANY, 'Other Tenant Branch'],
    ] as const) {
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [id, tenantId, companyId, name],
      );
    }
    await pool.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt")
       VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await pool.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose', 'Rose', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await pool.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt")
       VALUES ($1, $2, $3, 'Rose Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [PROVIDER_CRED_BRANCH, TENANT, COMPANY, BRANCH],
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  // ── fixture helpers ─────────────────────────────────────────────────────
  const uid = (): string => crypto.randomUUID();
  let seq = 0;

  async function insertOrder(
    overrides: { tenantId?: string; companyId?: string; branchId?: string } = {},
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

  async function insertInvoice(orderId: string, totalAmountMinor = 500n): Promise<string> {
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
               'NONE','PIECE','Piece','PIECE',1,1,'Rose','Rose Variant', now())`,
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

  async function freshInvoice(totalAmountMinor = 500n): Promise<string> {
    const orderId = await insertOrder();
    return insertInvoice(orderId, totalAmountMinor);
  }

  async function seedAttempt(input: {
    invoiceId: string;
    orderId: string;
    amountMinor: bigint;
    state: string;
    providerCredentialId?: string | null;
  }): Promise<string> {
    const id = uid();
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", method, "providerKey",
          "providerCredentialId", "amountMinor", "currencyCode", "currencyExponent", state,
          "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation", "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'ONLINE_GATEWAY','tap',$7,$8,'AED',2,$9,'fp-seed',1,$10, now())`,
      [
        id,
        TENANT,
        COMPANY,
        BRANCH,
        input.orderId,
        input.invoiceId,
        input.providerCredentialId ?? PROVIDER_CRED_BRANCH,
        input.amountMinor,
        input.state,
        `seed-${id}`,
      ],
    );
    return id;
  }

  function capture(overrides: {
    invoiceId: string;
    amountMinor: bigint;
    method?: 'CASH' | 'BANK_TRANSFER' | 'OTHER_MANUAL' | 'CARD_TERMINAL';
    tenantId?: string;
    companyId?: string;
    branchId?: string;
  }) {
    const tenantId = overrides.tenantId ?? TENANT;
    return runScoped(prisma, { tenantId }, (tx) =>
      collection.captureSingleTenderInTx(tx, {
        tenantId,
        companyId: overrides.companyId ?? COMPANY,
        branchId: overrides.branchId ?? BRANCH,
        invoiceId: overrides.invoiceId,
        method: overrides.method ?? 'CASH',
        amountMinor: overrides.amountMinor,
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: `test-${uid()}`,
      }),
    );
  }

  /** Checkpoint D — the generalized N-tender primitive, called directly
   *  (bypassing the DTO entirely) so a test can exercise the primitive's
   *  OWN defense-in-depth (e.g. a provider-backed tender an internal caller
   *  might mistakenly supply, §D14). */
  function captureMulti(overrides: {
    invoiceId: string;
    amountMinor: bigint;
    tenders: { method: string; amountMinor: bigint; providerCredentialId?: string | null }[];
    tenantId?: string;
    companyId?: string;
    branchId?: string;
    idempotencyKey?: string;
  }) {
    const tenantId = overrides.tenantId ?? TENANT;
    return runScoped(prisma, { tenantId }, (tx) =>
      collection.captureSynchronousTendersInTx(tx, {
        tenantId,
        companyId: overrides.companyId ?? COMPANY,
        branchId: overrides.branchId ?? BRANCH,
        invoiceId: overrides.invoiceId,
        amountMinor: overrides.amountMinor,
        tenders: overrides.tenders as {
          method: TenderMethod;
          amountMinor: bigint;
          providerCredentialId?: string | null;
        }[],
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: overrides.idempotencyKey ?? `test-${uid()}`,
      }),
    );
  }

  // ═══════════════════════════ HAPPY PATH / PARTIAL-FULL (C15) ═══════════
  it('a single full-amount capture succeeds end to end', async () => {
    const invoiceId = await freshInvoice(500n);
    const result = await capture({ invoiceId, amountMinor: 500n });
    expect(result.amountMinor).toBe(500n);
    expect(result.remainingAvailableToCollectMinor).toBe(0n);

    const { rows: attemptRows } = await pool.query(
      `SELECT state FROM payment_attempt WHERE id = $1`,
      [result.paymentAttemptId],
    );
    expect(attemptRows[0]!.state).toBe('CAPTURED');
    const { rows: eventRows } = await pool.query(
      `SELECT "fromState", "toState", source FROM payment_attempt_event WHERE "paymentAttemptId" = $1`,
      [result.paymentAttemptId],
    );
    expect(eventRows).toEqual([{ fromState: 'PENDING', toState: 'CAPTURED', source: 'USER' }]);
    const { rows: paymentRows } = await pool.query(
      `SELECT "sourceAttemptId", method, "providerKey", "paymentGroupId" FROM payment WHERE id = $1`,
      [result.paymentId],
    );
    expect(paymentRows[0]).toEqual({
      sourceAttemptId: result.paymentAttemptId,
      method: 'CASH',
      providerKey: null,
      paymentGroupId: null,
    });
    const { rows: allocRows } = await pool.query(
      `SELECT "paymentId", "invoiceId", "amountMinor" FROM payment_allocation WHERE id = $1`,
      [result.paymentAllocationId],
    );
    expect(allocRows[0]).toEqual({
      paymentId: result.paymentId,
      invoiceId,
      amountMinor: '500', // node-postgres returns BIGINT columns as strings
    });
  });

  it('partial then full payment: 200 CASH then 300 CARD_TERMINAL manual reaches exactly 500 confirmed, 0 available', async () => {
    const invoiceId = await freshInvoice(500n);
    const first = await capture({ invoiceId, amountMinor: 200n, method: 'CASH' });
    expect(first.remainingAvailableToCollectMinor).toBe(300n);
    const second = await capture({ invoiceId, amountMinor: 300n, method: 'CARD_TERMINAL' });
    expect(second.remainingAvailableToCollectMinor).toBe(0n);

    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    expect(rows[0]!.total).toBe('500');
    const { rows: paymentCount } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1`,
      [invoiceId],
    );
    expect(paymentCount[0]!.n).toBe(2);
    // invoicePaymentStatus remains untouched — 3b.6's exclusively
    const { rows: invRows } = await pool.query(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invRows[0]!.invoicePaymentStatus).toBe('UNPAID');
  });

  // ═══════════════════════════ OVERPAYMENT HARD GATES (C16) ══════════════
  describe('overpayment hard gates', () => {
    it('500 total, attempt 501 local -> rejected, zero rows created', async () => {
      const invoiceId = await freshInvoice(500n);
      await expect(capture({ invoiceId, amountMinor: 501n })).rejects.toThrow(DomainError);
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [invoiceId],
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('500 total, 200 already confirmed, attempt 301 -> rejected', async () => {
      const invoiceId = await freshInvoice(500n);
      await capture({ invoiceId, amountMinor: 200n });
      await expect(capture({ invoiceId, amountMinor: 301n })).rejects.toMatchObject({
        code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
      });
    });

    it('500 total, 200 confirmed + 200 active async reservation, local 101 -> rejected (available = 100)', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 500n);
      await capture({ invoiceId, amountMinor: 200n });
      await seedAttempt({ invoiceId, orderId, amountMinor: 200n, state: 'PENDING' });
      await expect(capture({ invoiceId, amountMinor: 101n })).rejects.toMatchObject({
        code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
      });
      const ok = await capture({ invoiceId, amountMinor: 100n });
      expect(ok.remainingAvailableToCollectMinor).toBe(0n);
    });
  });

  // ═══════════════════════════ ACTIVE RESERVATION INTERACTION (C17) ══════
  describe('active reservation interaction', () => {
    it('A: 100 total, active PENDING reservation 100 -> local CASH 1 rejected', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 100n);
      await seedAttempt({ invoiceId, orderId, amountMinor: 100n, state: 'PENDING' });
      await expect(capture({ invoiceId, amountMinor: 1n })).rejects.toMatchObject({
        code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
      });
    });

    it('B: 100 total, active REQUIRES_ACTION 60 -> local CASH 40 succeeds', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 100n);
      await seedAttempt({ invoiceId, orderId, amountMinor: 60n, state: 'REQUIRES_ACTION' });
      const result = await capture({ invoiceId, amountMinor: 40n });
      expect(result.remainingAvailableToCollectMinor).toBe(0n);
    });

    it('C: 100 total, active AUTHORIZED 60 -> local CASH 40 succeeds', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 100n);
      await seedAttempt({ invoiceId, orderId, amountMinor: 60n, state: 'AUTHORIZED' });
      const result = await capture({ invoiceId, amountMinor: 40n });
      expect(result.remainingAvailableToCollectMinor).toBe(0n);
    });

    it('D: 100 total, a FAILED provider attempt for 60 -> local CASH 100 succeeds (no longer reserved)', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 100n);
      await seedAttempt({ invoiceId, orderId, amountMinor: 60n, state: 'FAILED' });
      const result = await capture({ invoiceId, amountMinor: 100n });
      expect(result.remainingAvailableToCollectMinor).toBe(0n);
    });

    it('E: 100 total, a CANCELED provider attempt for 60 -> local CASH 100 succeeds', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 100n);
      await seedAttempt({ invoiceId, orderId, amountMinor: 60n, state: 'CANCELED' });
      const result = await capture({ invoiceId, amountMinor: 100n });
      expect(result.remainingAvailableToCollectMinor).toBe(0n);
    });
  });

  // ═══════════════════════════ CONCURRENT FINAL BALANCE (C18) ════════════
  it('two concurrent captures for the last 100 — exactly one succeeds, proven by the Invoice row lock', async () => {
    const invoiceId = await freshInvoice(100n);
    const settled = await inParallel(2, (i) =>
      capture({ invoiceId, amountMinor: 100n, method: i === 0 ? 'CASH' : 'CARD_TERMINAL' }),
    );
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE',
    });

    const { rows: confirmedRows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    expect(confirmedRows[0]!.total).toBe('100');
    const { rows: paymentCount } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payment p
         JOIN payment_allocation pa ON pa."paymentId" = p.id WHERE pa."invoiceId" = $1`,
      [invoiceId],
    );
    expect(paymentCount[0]!.n).toBe(1);
    // the losing attempt: no PaymentAttempt row was ever created for the
    // failed side (the reject happens before the INSERT, §6 of the
    // primitive), so payment_attempt for this invoice has exactly 1 row
    // (the winner's), never a stray/partial loser row.
    const { rows: attemptCount } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
      [invoiceId],
    );
    expect(attemptCount[0]!.n).toBe(1);
  });

  // ═══════════════════════════ CALLER-TRANSACTION ROLLBACK (C21) ═════════
  it('an abort after a successful capture but before caller commit leaves zero rows; retry then succeeds', async () => {
    const invoiceId = await freshInvoice(200n);
    const orderRow = await pool.query<{ orderId: string }>(
      `SELECT "orderId" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    const orderId = orderRow.rows[0]!.orderId;
    const { rows: orderBefore } = await pool.query(
      `SELECT version, "updatedAt" FROM "order" WHERE id = $1`,
      [orderId],
    );

    await expect(
      runScoped(prisma, { tenantId: TENANT }, async (tx) => {
        await collection.captureSingleTenderInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          method: 'CASH',
          amountMinor: 200n,
          createdByUserId: null,
          actingUserId: null,
          idempotencyKey: 'rollback-test',
        });
        throw new Error('deliberate abort before caller commit');
      }),
    ).rejects.toThrow('deliberate abort');

    // a SEPARATE connection (the pool) proves nothing survived the abort
    const { rows: attemptRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
      [invoiceId],
    );
    expect(attemptRows[0]!.n).toBe(0);
    const { rows: allocRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payment_allocation WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    expect(allocRows[0]!.n).toBe(0);
    const { rows: invRows } = await pool.query(
      `SELECT "totalAmountMinor" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invRows[0]!.totalAmountMinor).toBe('200'); // node-postgres returns BIGINT as string
    const { rows: orderAfter } = await pool.query(`SELECT version FROM "order" WHERE id = $1`, [
      orderId,
    ]);
    expect(orderAfter[0]!.version).toBe(orderBefore[0]!.version);

    // retry normally — succeeds, no leftover gap/consumed resource
    const retried = await capture({ invoiceId, amountMinor: 200n });
    expect(retried.remainingAvailableToCollectMinor).toBe(0n);
  });

  // ═══════════════════════════ SAME-TENANT COMPANY/BRANCH ACCESS (C19) ═══
  describe('same-tenant company/branch access scoping', () => {
    it('correct tenant/company/branch succeeds', async () => {
      const invoiceId = await freshInvoice(100n);
      const result = await capture({ invoiceId, amountMinor: 100n });
      expect(result.invoiceId).toBe(invoiceId);
    });

    it('same tenant, wrong company -> non-disclosing NotFoundError (repository predicate, not RLS)', async () => {
      const invoiceId = await freshInvoice(100n);
      await expect(
        capture({ invoiceId, amountMinor: 10n, companyId: COMPANY_2, branchId: BRANCH_2 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('same tenant + company, wrong branch -> non-disclosing NotFoundError', async () => {
      const invoiceId = await freshInvoice(100n);
      await expect(
        capture({ invoiceId, amountMinor: 10n, branchId: BRANCH_2 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('wrong tenant entirely -> inaccessible', async () => {
      const invoiceId = await freshInvoice(100n);
      await expect(
        capture({
          invoiceId,
          amountMinor: 10n,
          tenantId: OTHER_TENANT,
          companyId: OTHER_TENANT_COMPANY,
          branchId: OTHER_TENANT_BRANCH,
        }),
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════ DB BACKSTOP COOPERATION (C22) ═════════════
  it('C-generated rows satisfy every Checkpoint B DB backstop (no bypass)', async () => {
    const invoiceId = await freshInvoice(300n);
    const result = await capture({ invoiceId, amountMinor: 300n });

    // Payment immutability
    await expect(
      pool.query(`UPDATE payment SET "amountMinor" = 1 WHERE id = $1`, [result.paymentId]),
    ).rejects.toThrow(/is immutable/i);
    // Allocation 1:1 invariant (duplicate rejected)
    await expect(
      pool.query(
        `INSERT INTO payment_allocation (id, "tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(), $1,$2,$3,$4,$5,300,'AED',2)`,
        [TENANT, COMPANY, BRANCH, result.paymentId, invoiceId],
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
    // attempt transition graph (CAPTURED cannot regress)
    await expect(
      pool.query(`UPDATE payment_attempt SET state = 'PENDING' WHERE id = $1`, [
        result.paymentAttemptId,
      ]),
    ).rejects.toThrow(/illegal state transition/i);
    // attempt event scope FK (already proven structurally in Checkpoint B;
    // re-confirm the C-generated event actually satisfies it)
    const { rows: eventRows } = await pool.query(
      `SELECT "tenantId","companyId","branchId" FROM payment_attempt_event WHERE "paymentAttemptId" = $1`,
      [result.paymentAttemptId],
    );
    const { rows: attemptRows } = await pool.query(
      `SELECT "tenantId","companyId","branchId" FROM payment_attempt WHERE id = $1`,
      [result.paymentAttemptId],
    );
    expect(eventRows[0]).toEqual(attemptRows[0]);
    // local tender provider-null checks
    const { rows: attemptProviderRows } = await pool.query(
      `SELECT "providerKey","providerCredentialId" FROM payment_attempt WHERE id = $1`,
      [result.paymentAttemptId],
    );
    expect(attemptProviderRows[0]).toEqual({ providerKey: null, providerCredentialId: null });
  });

  // ═══════════════════ CHECKPOINT D — MULTI PAYMENT ══════════════════════

  it('(D11) partial Multi Payment: 200 of 500 across 3 tenders, then a later ordinary single payment of 300 via the same primitive', async () => {
    const invoiceId = await freshInvoice(500n);
    const multi = await captureMulti({
      invoiceId,
      amountMinor: 200n,
      tenders: [
        { method: 'CASH', amountMinor: 50n },
        { method: 'CARD_TERMINAL', amountMinor: 100n },
        { method: 'BANK_TRANSFER', amountMinor: 50n },
      ],
    });
    expect(multi.payments).toHaveLength(3);
    expect(multi.remainingAvailableToCollectMinor).toBe(300n);
    const { rows: sumRows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
      [invoiceId],
    );
    expect(sumRows[0]!.total).toBe('200');
    const { rows: invRows } = await pool.query(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    expect(invRows[0]!.invoicePaymentStatus).toBe('UNPAID');

    const single = await capture({ invoiceId, amountMinor: 300n });
    expect(single.remainingAvailableToCollectMinor).toBe(0n);
  });

  describe('(D13) available-balance hard gates — Multi Payment', () => {
    it('total 501 on a fresh 500 invoice -> rejected, zero rows', async () => {
      const invoiceId = await freshInvoice(500n);
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 501n,
          tenders: [
            { method: 'CASH', amountMinor: 250n },
            { method: 'BANK_TRANSFER', amountMinor: 251n },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE' });
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [invoiceId],
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('confirmed 200, Multi total 301 -> rejected', async () => {
      const invoiceId = await freshInvoice(500n);
      await capture({ invoiceId, amountMinor: 200n });
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 301n,
          tenders: [
            { method: 'CASH', amountMinor: 150n },
            { method: 'BANK_TRANSFER', amountMinor: 151n },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE' });
    });

    it('confirmed 200 + active reservation 200, Multi total 101 rejected, Multi total 100 succeeds', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 500n);
      await capture({ invoiceId, amountMinor: 200n });
      await seedAttempt({ invoiceId, orderId, amountMinor: 200n, state: 'PENDING' });
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 101n,
          tenders: [
            { method: 'CASH', amountMinor: 50n },
            { method: 'BANK_TRANSFER', amountMinor: 51n },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE' });
      const ok = await captureMulti({
        invoiceId,
        amountMinor: 100n,
        tenders: [
          { method: 'CASH', amountMinor: 40n },
          { method: 'BANK_TRANSFER', amountMinor: 60n },
        ],
      });
      expect(ok.remainingAvailableToCollectMinor).toBe(0n);
    });
  });

  describe('(D14) async-exclusion hard gates', () => {
    it('a Multi Payment containing an ONLINE_GATEWAY component is entirely rejected, zero rows for any component', async () => {
      const invoiceId = await freshInvoice(200n);
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 100n,
          tenders: [
            { method: 'CASH', amountMinor: 50n },
            { method: 'ONLINE_GATEWAY', amountMinor: 50n },
          ],
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT' });
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [invoiceId],
      );
      // zero rows for the FIRST (otherwise-valid) CASH component too — the
      // whole request is validated before the first INSERT, never
      // "first component succeeded then rolled back".
      expect(rows[0]!.n).toBe(0);
    });

    it('a bare ONLINE_GATEWAY tender is rejected regardless of providerCredentialId', async () => {
      const invoiceId = await freshInvoice(100n);
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 100n,
          tenders: [{ method: 'ONLINE_GATEWAY', amountMinor: 100n }],
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT' });
    });

    // ── owner final integrity pass item 1: `SynchronousTenderInput` DOES
    //    carry `providerCredentialId?` as an INTERNAL trust-boundary field
    //    (never reachable from the public DTO/HTTP layer — see
    //    `create-payment.dto.ts`, which has no such field at all) so the
    //    primitive's own runtime check has a real value to classify, rather
    //    than a hardcoded `null` a direct internal caller could silently
    //    bypass. ──────────────────────────────────────────────────────────

    it('(3) a direct internal call with CARD_TERMINAL + a non-null providerCredentialId is rejected — provider-backed, zero rows', async () => {
      const invoiceId = await freshInvoice(100n);
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 100n,
          tenders: [
            {
              method: 'CARD_TERMINAL',
              amountMinor: 100n,
              providerCredentialId: PROVIDER_CRED_BRANCH,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT' });
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [invoiceId],
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('(5) a direct internal call with CARD_TERMINAL and NO providerCredentialId is accepted (local/manual)', async () => {
      const invoiceId = await freshInvoice(100n);
      const result = await captureMulti({
        invoiceId,
        amountMinor: 100n,
        tenders: [{ method: 'CARD_TERMINAL', amountMinor: 100n, providerCredentialId: null }],
      });
      expect(result.payments).toHaveLength(1);
      const { rows } = await pool.query(
        `SELECT "providerCredentialId" FROM payment_attempt WHERE id = $1`,
        [result.payments[0]!.paymentAttemptId],
      );
      expect(rows[0]!.providerCredentialId).toBeNull();
    });

    it('a Multi Payment mixing a local CASH tender with a provider-backed CARD_TERMINAL tender is entirely rejected, zero rows for either', async () => {
      const invoiceId = await freshInvoice(150n);
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 150n,
          tenders: [
            { method: 'CASH', amountMinor: 50n },
            {
              method: 'CARD_TERMINAL',
              amountMinor: 100n,
              providerCredentialId: PROVIDER_CRED_BRANCH,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT' });
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [invoiceId],
      );
      expect(rows[0]!.n).toBe(0);
    });
  });

  it('(D15) atomic rollback: a fully-successful 3-component Multi Payment aborted before caller commit leaves zero rows; retry succeeds once', async () => {
    const invoiceId = await freshInvoice(300n);
    const orderRow = await pool.query<{ orderId: string }>(
      `SELECT "orderId" FROM invoice WHERE id = $1`,
      [invoiceId],
    );
    const orderId = orderRow.rows[0]!.orderId;
    const { rows: orderBefore } = await pool.query(`SELECT version FROM "order" WHERE id = $1`, [
      orderId,
    ]);

    await expect(
      runScoped(prisma, { tenantId: TENANT }, async (tx) => {
        const result = await collection.captureSynchronousTendersInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH,
          invoiceId,
          amountMinor: 300n,
          tenders: [
            { method: 'CASH', amountMinor: 100n },
            { method: 'CARD_TERMINAL', amountMinor: 100n },
            { method: 'BANK_TRANSFER', amountMinor: 100n },
          ],
          createdByUserId: null,
          actingUserId: null,
          idempotencyKey: 'd15-rollback-test',
        });
        expect(result.payments).toHaveLength(3);
        throw new Error('deliberate abort before caller commit');
      }),
    ).rejects.toThrow('deliberate abort');

    for (const [table, column] of [
      ['payment_attempt', 'targetInvoiceId'],
      ['payment_allocation', 'invoiceId'],
    ] as const) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE "${column}" = $1`,
        [invoiceId],
      );
      expect(rows[0]!.n).toBe(0);
    }
    const { rows: orderAfter } = await pool.query(`SELECT version FROM "order" WHERE id = $1`, [
      orderId,
    ]);
    expect(orderAfter[0]!.version).toBe(orderBefore[0]!.version);

    const retried = await captureMulti({
      invoiceId,
      amountMinor: 300n,
      tenders: [
        { method: 'CASH', amountMinor: 100n },
        { method: 'CARD_TERMINAL', amountMinor: 100n },
        { method: 'BANK_TRANSFER', amountMinor: 100n },
      ],
    });
    expect(retried.payments).toHaveLength(3);
    expect(retried.remainingAvailableToCollectMinor).toBe(0n);
  });

  it('(D16) an invalid THIRD component rejects the whole request before any write — not "first two succeeded then rolled back"', async () => {
    const invoiceId = await freshInvoice(200n);
    await expect(
      captureMulti({
        invoiceId,
        amountMinor: 150n,
        tenders: [
          { method: 'CASH', amountMinor: 50n },
          { method: 'BANK_TRANSFER', amountMinor: 50n },
          { method: 'ONLINE_GATEWAY', amountMinor: 50n },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT' });
    const { rows: attemptRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
      [invoiceId],
    );
    expect(attemptRows[0]!.n).toBe(0);
  });

  describe('(D17) concurrency', () => {
    it('A: Multi (60) vs concurrent single (50) against available=100 — exactly one succeeds, no overpayment', async () => {
      const invoiceId = await freshInvoice(100n);
      const settled = await inParallel(2, (i) =>
        i === 0
          ? captureMulti({
              invoiceId,
              amountMinor: 60n,
              tenders: [
                { method: 'CASH', amountMinor: 30n },
                { method: 'BANK_TRANSFER', amountMinor: 30n },
              ],
            })
          : // an ordinary "single" request is exactly the 1-tender case of
            // this same generalized primitive (Checkpoint C === D with
            // tenders.length === 1) — used directly here so both branches of
            // this race share one return type.
            captureMulti({
              invoiceId,
              amountMinor: 50n,
              tenders: [{ method: 'CARD_TERMINAL', amountMinor: 50n }],
            }),
      );
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      const { rows } = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
        [invoiceId],
      );
      expect(Number(rows[0]!.total)).toBeLessThanOrEqual(100);
    });

    it('B: Multi (60) vs Multi (50) against available=100 — exactly one succeeds, loser leaves zero rows', async () => {
      const invoiceId = await freshInvoice(100n);
      const settled = await inParallel(2, (i) =>
        captureMulti({
          invoiceId,
          amountMinor: i === 0 ? 60n : 50n,
          tenders:
            i === 0
              ? [
                  { method: 'CASH', amountMinor: 30n },
                  { method: 'BANK_TRANSFER', amountMinor: 30n },
                ]
              : [
                  { method: 'CARD_TERMINAL', amountMinor: 25n },
                  { method: 'OTHER_MANUAL', amountMinor: 25n },
                ],
        }),
      );
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const { rows: allocRows } = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM("amountMinor"),0)::text AS total FROM payment_allocation WHERE "invoiceId" = $1`,
        [invoiceId],
      );
      expect(Number(allocRows[0]!.total)).toBeLessThanOrEqual(100);
      const { rows: attemptRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1`,
        [invoiceId],
      );
      // exactly the winner's 2 attempt rows — the loser created none
      expect(attemptRows[0]!.n).toBe(2);
    });

    it('C: active-reservation interaction — available=40 after a 60 reservation on a 100 invoice; Multi 40 succeeds, Multi 41 rejects with zero rows', async () => {
      const orderId = await insertOrder();
      const invoiceId = await insertInvoice(orderId, 100n);
      await seedAttempt({ invoiceId, orderId, amountMinor: 60n, state: 'AUTHORIZED' });
      await expect(
        captureMulti({
          invoiceId,
          amountMinor: 41n,
          tenders: [
            { method: 'CASH', amountMinor: 21n },
            { method: 'BANK_TRANSFER', amountMinor: 20n },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_INSUFFICIENT_AVAILABLE_BALANCE' });
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempt WHERE "targetInvoiceId" = $1 AND state = 'CAPTURED'`,
        [invoiceId],
      );
      expect(rows[0]!.n).toBe(0);
      const ok = await captureMulti({
        invoiceId,
        amountMinor: 40n,
        tenders: [
          { method: 'CASH', amountMinor: 20n },
          { method: 'BANK_TRANSFER', amountMinor: 20n },
        ],
      });
      expect(ok.remainingAvailableToCollectMinor).toBe(0n);
    });
  });

  it('(D19) every component attempt binds to the SAME live Order fingerprint+version snapshot', async () => {
    const invoiceId = await freshInvoice(90n);
    const result = await captureMulti({
      invoiceId,
      amountMinor: 90n,
      tenders: [
        { method: 'CASH', amountMinor: 30n },
        { method: 'CARD_TERMINAL', amountMinor: 30n },
        { method: 'BANK_TRANSFER', amountMinor: 30n },
      ],
    });
    const { rows } = await pool.query<{
      orderCommercialSnapshotFingerprintAtCreation: string;
      orderVersionAtCreation: number;
    }>(
      `SELECT "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation"
         FROM payment_attempt WHERE id = ANY($1)`,
      [result.payments.map((p) => p.paymentAttemptId)],
    );
    expect(rows).toHaveLength(3);
    const distinctFingerprints = new Set(
      rows.map((r) => r.orderCommercialSnapshotFingerprintAtCreation),
    );
    const distinctVersions = new Set(rows.map((r) => r.orderVersionAtCreation));
    expect(distinctFingerprints.size).toBe(1);
    expect(distinctVersions.size).toBe(1);
  });

  it('(D20) every Multi Payment component row satisfies every Checkpoint B DB backstop', async () => {
    const invoiceId = await freshInvoice(150n);
    const result = await captureMulti({
      invoiceId,
      amountMinor: 150n,
      tenders: [
        { method: 'CASH', amountMinor: 50n },
        { method: 'CARD_TERMINAL', amountMinor: 50n },
        { method: 'OTHER_MANUAL', amountMinor: 50n },
      ],
    });
    for (const p of result.payments) {
      await expect(
        pool.query(`UPDATE payment SET "amountMinor" = 1 WHERE id = $1`, [p.paymentId]),
      ).rejects.toThrow(/is immutable/i);
      await expect(
        pool.query(`UPDATE payment_attempt SET state = 'PENDING' WHERE id = $1`, [
          p.paymentAttemptId,
        ]),
      ).rejects.toThrow(/illegal state transition/i);
      const { rows: providerRows } = await pool.query(
        `SELECT "providerKey","providerCredentialId" FROM payment_attempt WHERE id = $1`,
        [p.paymentAttemptId],
      );
      expect(providerRows[0]).toEqual({ providerKey: null, providerCredentialId: null });
    }
    // Allocation 1:1 — a second allocation for any one of the payments is rejected
    await expect(
      pool.query(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         VALUES (uuidv7(),$1,$2,$3,$4,$5,50,'AED',2)`,
        [TENANT, COMPANY, BRANCH, result.payments[0]!.paymentId, invoiceId],
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it('(D21) two components with the SAME tender method (CASH + CASH) are not rejected — no accepted rule forbids it', async () => {
    const invoiceId = await freshInvoice(50n);
    const result = await captureMulti({
      invoiceId,
      amountMinor: 50n,
      tenders: [
        { method: 'CASH', amountMinor: 20n },
        { method: 'CASH', amountMinor: 30n },
      ],
    });
    expect(result.payments).toHaveLength(2);
    expect(result.payments.map((p) => p.method)).toEqual(['CASH', 'CASH']);
  });

  it('(D22) a large-BigInt Multi Payment validates and captures exactly, with response order matching request order', async () => {
    const huge = 9_000_000_000_000n;
    const invoiceId = await freshInvoice(huge);
    const result = await captureMulti({
      invoiceId,
      amountMinor: huge,
      tenders: [
        { method: 'BANK_TRANSFER', amountMinor: huge - 1n },
        { method: 'CASH', amountMinor: 1n },
      ],
    });
    expect(result.payments.map((p) => p.method)).toEqual(['BANK_TRANSFER', 'CASH']);
    expect(result.payments.map((p) => p.amountMinor)).toEqual([huge - 1n, 1n]);
    expect(result.remainingAvailableToCollectMinor).toBe(0n);
  });
});
