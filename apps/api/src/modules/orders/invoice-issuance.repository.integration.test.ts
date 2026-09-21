import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising the internal issuance primitive's
// caller-transaction participation contract directly (task 3b.3 Checkpoint C)
// — not production module code. Mirrors `posting-engine.integration.test.ts`'s
// exact no-HTTP, no-Redis, direct-construction pattern.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import { InvoiceIssuanceRepository } from './invoice-issuance.repository.js';
import { computeCommercialSnapshotFingerprintV2 } from './commercial-snapshot.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';

// Task 3b.4 Checkpoint C — every Order this fixture writes directly via raw
// SQL is a V2-shaped Order (the current create-path default); a fixed,
// arbitrary-but-valid fiscal policy, identical across every fixture Order
// here since NONE of these tests exercise policy resolution itself.
const TEST_POLICY = {
  taxPriceMode: 'TAX_EXCLUSIVE',
  taxRoundingScope: 'LINE',
  taxRoundingMode: 'HALF_UP',
} as const;

describe('InvoiceIssuanceRepository.issueFinalInvoice (task 3b.3 Checkpoint C, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let issuance: InvoiceIssuanceRepository;
  let client: pg.Client;

  const tenantId = randomUUID();
  let companyId = '';
  let company2Id = ''; // second company, same tenant — counter independence
  let branchId = '';
  let branch2Id = '';
  let productId = '';
  let variantId = '';
  let customerId = '';

  function fakeClockAt(iso: string): SystemClock {
    return { now: () => new Date(iso) } as unknown as SystemClock;
  }

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runScoped(prisma, { tenantId }, fn);
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    client = new pg.Client({ connectionString: stack.postgres.url });
    await client.connect();

    const dummyDb = {} as unknown as DbService;
    issuance = new InvoiceIssuanceRepository(
      new AuditWriter(dummyDb),
      fakeClockAt('2026-06-15T10:00:00Z'),
    );

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await client.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `inv-issuance-plan-${planId.slice(0, 8)}`,
    ]);
    await client.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    await client.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
      [tenantId, `inv-issuance-${tenantId.slice(0, 8)}`, planVersionId],
    );
    await client.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
       VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT (code) DO NOTHING`,
    );
    companyId = randomUUID();
    company2Id = randomUUID();
    for (const id of [companyId, company2Id]) {
      await client.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
         VALUES ($1,$2,'Test Co','AE','AED','Asia/Dubai',now())`,
        [id, tenantId],
      );
    }
    branchId = randomUUID();
    branch2Id = randomUUID();
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main',now())`,
      [branchId, tenantId, companyId],
    );
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Co2 Branch',now())`,
      [branch2Id, tenantId, company2Id],
    );
    const categoryId = randomUUID();
    await client.query(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'flowers','Flowers',now())`,
      [categoryId, tenantId],
    );
    productId = randomUUID();
    await client.query(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy",status,"updatedAt")
       VALUES ($1,$2,$3,'rose','Rose','STOCKED','ACTIVE',now())`,
      [productId, tenantId, categoryId],
    );
    variantId = randomUUID();
    await client.query(
      `INSERT INTO variant (id,"tenantId","productId","nameEn",status,"baseUomCode","updatedAt")
       VALUES ($1,$2,$3,'Rose','ACTIVE','piece',now())`,
      [variantId, tenantId, productId],
    );
    customerId = randomUUID();
    await client.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Jane Doe',now())`,
      [customerId, tenantId],
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  // Checkpoint C final-integrity pass (§2) — `issueFinalInvoice` now
  // recomputes the authoritative fingerprint from the LOCKED persisted Order
  // + OrderLine rows via the SAME shared `computeCommercialSnapshotFingerprint`
  // builder, so a fixture's stored `commercialSnapshotFingerprint` must be the
  // REAL fingerprint of the row shape it inserts — never an arbitrary literal.
  function fingerprintFor(opts: { co: string; br: string; customerId: string | null }): string {
    return computeCommercialSnapshotFingerprintV2(
      {
        tenantId,
        companyId: opts.co,
        originBranchId: opts.br,
        fulfillingBranchId: opts.br,
        customerId: opts.customerId,
        kind: 'WALK_IN',
        currencyCode: 'AED',
        lines: [
          {
            productId,
            variantId,
            quantity: '1.0000',
            selectedUomCode: 'piece',
            baseUomCode: 'piece',
            conversionNumerator: '1',
            conversionDenominator: '1',
            unitPriceAmountMinor: '1000',
            unitPriceCurrencyCode: 'AED',
            unitPriceCurrencyExponent: 2,
            discountMode: 'NONE',
            discountBps: null,
            discountAmountMinor: '0',
            taxCategoryKey: null,
            rateBps: null,
            effectiveFrom: null,
            resolutionSource: 'NONE',
          },
        ],
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      },
      TEST_POLICY,
    );
  }

  async function mkOrder(
    opts: { companyId?: string; branchId?: string; customerId?: string | null } = {},
  ): Promise<{ orderId: string; lineId: string; fingerprint: string }> {
    const co = opts.companyId ?? companyId;
    const br = opts.branchId ?? branchId;
    const orderId = randomUUID();
    const customerId = opts.customerId ?? null;
    const fingerprint = fingerprintFor({ co, br, customerId });
    await client.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
          "currencyCode","currencyExponent","commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode",
          "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,$7,$8,$9,now())`,
      [
        orderId,
        tenantId,
        co,
        br,
        customerId,
        fingerprint,
        TEST_POLICY.taxPriceMode,
        TEST_POLICY.taxRoundingScope,
        TEST_POLICY.taxRoundingMode,
      ],
    );
    const lineId = randomUUID();
    await client.query(
      `INSERT INTO order_line
         (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
          "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
          "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
          "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',1000,'AED',2,'NONE','piece','Piece','piece',1,1,'Rose','Rose',now())`,
      [lineId, tenantId, co, orderId, productId, variantId],
    );
    return { orderId, lineId, fingerprint };
  }

  function finalizedInput(
    orderId: string,
    lineId: string,
    fingerprint: string,
    overrides: Partial<{
      companyId: string;
      branchId: string;
      expectedVersion: number;
      lineTaxAmountMinor: bigint;
      taxTotalAmountMinor: bigint;
      totalAmountMinor: bigint;
    }> = {},
  ) {
    return {
      tenantId,
      companyId: overrides.companyId ?? companyId,
      branchId: overrides.branchId ?? branchId,
      orderId,
      expectedVersion: overrides.expectedVersion ?? 1,
      commercialSnapshotFingerprint: fingerprint,
      lines: [
        {
          orderLineId: lineId,
          priceTaxMode: TEST_POLICY.taxPriceMode,
          roundingScope: TEST_POLICY.taxRoundingScope,
          roundingMode: TEST_POLICY.taxRoundingMode,
          lineTaxAmountMinor: overrides.lineTaxAmountMinor ?? 0n,
        },
      ],
      totals: {
        subtotalAmountMinor: 1000n,
        documentDiscountAmountMinor: 0n,
        taxTotalAmountMinor: overrides.taxTotalAmountMinor ?? overrides.lineTaxAmountMinor ?? 0n,
        totalAmountMinor:
          overrides.totalAmountMinor ??
          1000n + (overrides.taxTotalAmountMinor ?? overrides.lineTaxAmountMinor ?? 0n),
        currencyCode: 'AED',
        currencyExponent: 2,
      },
    };
  }

  it('DRAFT issues successfully with a fully finalized zero-tax snapshot; version+1; fingerprint unchanged; number formats', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
    );
    expect(result.orderNumber).toMatch(/^ORD-\d{6}$/);
    expect(result.invoiceNumber).toMatch(/^INV-\d{6}$/);

    const orderRow = (
      await client.query(
        `SELECT status, version, "commercialSnapshotFingerprint", "orderNumber" FROM "order" WHERE id=$1`,
        [orderId],
      )
    ).rows[0];
    expect(orderRow.status).toBe('CONFIRMED');
    expect(orderRow.version).toBe(2);
    expect(orderRow.commercialSnapshotFingerprint).toBe(fingerprint);
    expect(orderRow.orderNumber).toBe(result.orderNumber);
  });

  it('HELD is rejected', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    await client.query(`UPDATE "order" SET status='HELD' WHERE id=$1`, [orderId]);
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_INVALID_STATE_TRANSITION' });
  });

  it('a stale expectedVersion is rejected', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          finalizedInput(orderId, lineId, fingerprint, { expectedVersion: 99 }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_VERSION_CONFLICT' });
  });

  it('a fingerprint mismatch is rejected', async () => {
    const { orderId, lineId } = await mkOrder();
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, 'wrong-fingerprint')),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
  });

  it('an incomplete/null finalized tax snapshot is rejected; a genuine zero amount is accepted', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    const input = finalizedInput(orderId, lineId, fingerprint);
    // @ts-expect-error deliberately corrupting one mandatory field for the test
    input.lines[0]!.roundingMode = null;
    await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
      code: 'ORDER_LINE_TAX_SNAPSHOT_INCOMPLETE',
    });

    const { orderId: o2, lineId: l2, fingerprint: fp2 } = await mkOrder();
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(o2, l2, fp2, { lineTaxAmountMinor: 0n })),
      ),
    ).resolves.toBeTruthy();
  });

  it('a non-zero tax amount is also accepted, and totals must be structurally consistent', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        finalizedInput(orderId, lineId, fingerprint, {
          lineTaxAmountMinor: 50n,
          taxTotalAmountMinor: 50n,
          totalAmountMinor: 1050n,
        }),
      ),
    );
    expect(result.invoiceNumber).toMatch(/^INV-\d{6}$/);

    const { orderId: badOrder, lineId: badLine, fingerprint: badFp } = await mkOrder();
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          finalizedInput(badOrder, badLine, badFp, {
            lineTaxAmountMinor: 50n,
            taxTotalAmountMinor: 999n, // does not match sum of line tax
            totalAmountMinor: 1999n,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_FINALIZED_TOTALS_INVALID' });
  });

  it('duplicate issuance on the same Order is rejected — one Order, one Invoice', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
    );
    // after the first issuance the order is CONFIRMED (not DRAFT) — rejected
    // for that reason, which is itself the correct "cannot re-issue" outcome.
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(
          tx,
          finalizedInput(orderId, lineId, fingerprint, { expectedVersion: 2 }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_INVALID_STATE_TRANSITION' });
    const invCount = await client.query(
      `SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`,
      [orderId],
    );
    expect(invCount.rows[0].n).toBe(1);
  });

  it('Invoice.branchId is derived from Order.originBranchId; customerDisplayNameSnapshot is server-derived (null when anonymous)', async () => {
    const anon = await mkOrder();
    const rAnon = await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, finalizedInput(anon.orderId, anon.lineId, anon.fingerprint)),
    );
    const invAnon = (
      await client.query(
        `SELECT "branchId", "customerDisplayNameSnapshot" FROM invoice WHERE id=$1`,
        [rAnon.invoiceId],
      )
    ).rows[0];
    expect(invAnon.branchId).toBe(branchId);
    expect(invAnon.customerDisplayNameSnapshot).toBeNull();

    const withCust = await mkOrder({ customerId });
    const rCust = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        finalizedInput(withCust.orderId, withCust.lineId, withCust.fingerprint),
      ),
    );
    const invCust = (
      await client.query(`SELECT "customerDisplayNameSnapshot" FROM invoice WHERE id=$1`, [
        rCust.invoiceId,
      ])
    ).rows[0];
    expect(invCust.customerDisplayNameSnapshot).toBe('Jane Doe');
  });

  // ── numbering concurrency/rollback ────────────────────────────────────────
  it('rollback gaplessness: a forced rollback after allocation is reused by the next successful issuance', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    await expect(
      runScoped(prisma, { tenantId }, async (tx) => {
        await issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint));
        throw new Error('forced rollback after allocation');
      }),
    ).rejects.toThrow('forced rollback');

    const orderAfterRollback = (
      await client.query(`SELECT status, "orderNumber" FROM "order" WHERE id=$1`, [orderId])
    ).rows[0];
    expect(orderAfterRollback.status).toBe('DRAFT');
    expect(orderAfterRollback.orderNumber).toBeNull();
    const invCount = await client.query(
      `SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`,
      [orderId],
    );
    expect(invCount.rows[0].n).toBe(0);
    // D13 audit atomicity — the audit write happens inside the SAME
    // transaction as the domain write; a forced rollback must leave NO
    // audit row, not merely no Order/Invoice mutation.
    const auditAfterRollback = await client.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE "resourceId"=$1 AND action IN ('order.confirmed','invoice.issued')`,
      [orderId],
    );
    expect(auditAfterRollback.rows[0].n).toBe(0);

    // the SAME order, re-issued, must succeed and reuse the burned number
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
    );
    expect(result.orderNumber).toMatch(/^ORD-\d{6}$/);
    // and the successful issuance DOES commit exactly one audit row per action.
    const auditAfterSuccess = await client.query<{ action: string; after: unknown }>(
      `SELECT action, after FROM audit_log WHERE "resourceId" = ANY($1) AND action IN ('order.confirmed','invoice.issued')`,
      [[orderId, result.invoiceId]],
    );
    expect(auditAfterSuccess.rows).toHaveLength(2);
    // bounded audit metadata — never PII/secrets/payment fields.
    for (const row of auditAfterSuccess.rows) {
      const payload = JSON.stringify(row.after ?? {});
      expect(payload).not.toMatch(/phone|email|card|secret|pan\b/i);
    }
  });

  it('failed precondition validation consumes no number', async () => {
    const before = await client.query(
      `SELECT "nextNumber" FROM document_number_counter WHERE "tenantId"=$1 AND "companyId"=$2 AND "documentType"='ORDER'`,
      [tenantId, companyId],
    );
    const { orderId, lineId } = await mkOrder();
    await expect(
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, 'deliberately-wrong')),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
    const after = await client.query(
      `SELECT "nextNumber" FROM document_number_counter WHERE "tenantId"=$1 AND "companyId"=$2 AND "documentType"='ORDER'`,
      [tenantId, companyId],
    );
    expect(after.rows[0]?.nextNumber ?? null).toEqual(before.rows[0]?.nextNumber ?? null);
  });

  it('same-company parallel issuance of different Orders yields unique sequential Order/Invoice numbers', async () => {
    const a = await mkOrder();
    const b = await mkOrder();
    const [ra, rb] = await Promise.all([
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(a.orderId, a.lineId, a.fingerprint)),
      ),
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(b.orderId, b.lineId, b.fingerprint)),
      ),
    ]);
    expect(ra.orderNumber).not.toBe(rb.orderNumber);
    expect(ra.invoiceNumber).not.toBe(rb.invoiceNumber);
  });

  it('two issuance attempts on the SAME Order under real concurrency: exactly one succeeds', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    const results = await Promise.allSettled([
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
      ),
      asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const invCount = await client.query(
      `SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`,
      [orderId],
    );
    expect(invCount.rows[0].n).toBe(1);
  });

  it('different Companies: counter scopes are independent (each starts its own ORD-000001-style sequence)', async () => {
    const inCo2 = await mkOrder({ companyId: company2Id, branchId: branch2Id });
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(
        tx,
        finalizedInput(inCo2.orderId, inCo2.lineId, inCo2.fingerprint, {
          companyId: company2Id,
          branchId: branch2Id,
        }),
      ),
    );
    // company2 has never issued before -> its first number is 000001,
    // independent of however far company1's counter has advanced above.
    expect(result.orderNumber).toBe('ORD-000001');
    expect(result.invoiceNumber).toBe('INV-000001');
  });

  // ── DB-level immutability ─────────────────────────────────────────────────
  it('Invoice UPDATE and DELETE are unconditionally blocked at the DB', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    const result = await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
    );
    await expect(
      client.query(`UPDATE invoice SET "invoicePaymentStatus"='PAID' WHERE id=$1`, [
        result.invoiceId,
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      client.query(`DELETE FROM invoice WHERE id=$1`, [result.invoiceId]),
    ).rejects.toThrow(/immutable/i);
  });

  it('issued OrderLine UPDATE/DELETE are blocked at the DB; a DRAFT line remains editable', async () => {
    const draft = await mkOrder();
    await expect(
      client.query(`UPDATE order_line SET quantity='2.0000' WHERE id=$1`, [draft.lineId]),
    ).resolves.toBeTruthy();

    const { orderId, lineId, fingerprint } = await mkOrder();
    await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
    );
    await expect(
      client.query(`UPDATE order_line SET quantity='9.0000' WHERE id=$1`, [lineId]),
    ).rejects.toThrow(/immutable/i);
    await expect(client.query(`DELETE FROM order_line WHERE id=$1`, [lineId])).rejects.toThrow(
      /immutable/i,
    );
  });

  it('issued Order commercial-field mutation is blocked; orderNumber cannot be reassigned or cleared; operational status/version remain changeable', async () => {
    const { orderId, lineId, fingerprint } = await mkOrder();
    await asTenant((tx) =>
      issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
    );

    await expect(
      client.query(`UPDATE "order" SET "customerId"=$2 WHERE id=$1`, [orderId, customerId]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      client.query(`UPDATE "order" SET "currencyCode"='KWD' WHERE id=$1`, [orderId]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      client.query(`UPDATE "order" SET "orderNumber"='ORD-999999' WHERE id=$1`, [orderId]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      client.query(`UPDATE "order" SET "orderNumber"=NULL WHERE id=$1`, [orderId]),
    ).rejects.toThrow(/frozen/i);
    // D9 (Checkpoint D hard-gate) — additional individual frozen fields.
    await expect(
      client.query(`UPDATE "order" SET kind='PICKUP' WHERE id=$1`, [orderId]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      client.query(`UPDATE "order" SET "documentDiscountReason"='x' WHERE id=$1`, [orderId]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      client.query(`UPDATE "order" SET "originBranchId"=$2 WHERE id=$1`, [orderId, branch2Id]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      client.query(`UPDATE "order" SET "commercialSnapshotFingerprint"='tampered' WHERE id=$1`, [
        orderId,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      client.query(`UPDATE "order" SET "createdByUserId"=$2 WHERE id=$1`, [orderId, customerId]),
    ).rejects.toThrow(/original attribution/i);
    await expect(
      client.query(`UPDATE "order" SET "actingUserId"=$2 WHERE id=$1`, [orderId, customerId]),
    ).rejects.toThrow(/original attribution/i);

    // allowed future operational path — status/version alone, everything
    // else held byte-identical — must NOT be globally sealed.
    await expect(
      client.query(`UPDATE "order" SET status='COMPLETED', version=version+1 WHERE id=$1`, [
        orderId,
      ]),
    ).resolves.toBeTruthy();
  });

  // ── Checkpoint D final-closure §1 — an issued Order must never regress to
  //    a pre-issuance status, but forward operational progression (a future
  //    phase) must remain possible; this is NOT a global status seal. ──────
  describe('issued Order status can never regress to a pre-issuance state (Checkpoint D final-closure §1)', () => {
    async function mkIssuedOrder(): Promise<string> {
      const { orderId, lineId, fingerprint } = await mkOrder();
      await asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
      );
      return orderId;
    }

    it('A. CONFIRMED -> DRAFT is blocked', async () => {
      const orderId = await mkIssuedOrder();
      await expect(
        client.query(`UPDATE "order" SET status='DRAFT', version=version+1 WHERE id=$1`, [orderId]),
      ).rejects.toThrow(/can never regress/i);
    });

    it('B. CONFIRMED -> HELD is blocked', async () => {
      const orderId = await mkIssuedOrder();
      await expect(
        client.query(`UPDATE "order" SET status='HELD', version=version+1 WHERE id=$1`, [orderId]),
      ).rejects.toThrow(/can never regress/i);
    });

    it('C. CONFIRMED -> PLACED is blocked', async () => {
      const orderId = await mkIssuedOrder();
      await expect(
        client.query(`UPDATE "order" SET status='PLACED', version=version+1 WHERE id=$1`, [
          orderId,
        ]),
      ).rejects.toThrow(/can never regress/i);
    });

    it('D. CONFIRMED -> a legitimate forward operational state remains allowed', async () => {
      const orderId = await mkIssuedOrder();
      await expect(
        client.query(`UPDATE "order" SET status='IN_PRODUCTION', version=version+1 WHERE id=$1`, [
          orderId,
        ]),
      ).resolves.toBeTruthy();
      // and a further forward transition from there also remains legal.
      await expect(
        client.query(`UPDATE "order" SET status='READY', version=version+1 WHERE id=$1`, [orderId]),
      ).resolves.toBeTruthy();
    });

    it('E. a version/updatedAt-only operational mutation (no status change) remains allowed', async () => {
      const orderId = await mkIssuedOrder();
      await expect(
        client.query(`UPDATE "order" SET version=version+1 WHERE id=$1`, [orderId]),
      ).resolves.toBeTruthy();
    });

    it("F. issuance's own DRAFT -> CONFIRMED transition remains unaffected by the regression guard", async () => {
      const { orderId, lineId, fingerprint } = await mkOrder();
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
      );
      expect(result.orderNumber).toMatch(/^ORD-\d{6}$/);
      const row = (await client.query(`SELECT status FROM "order" WHERE id=$1`, [orderId])).rows[0];
      expect(row.status).toBe('CONFIRMED');
    });
  });

  it('no PostingEngine/payment/AR/inventory effect from any issuance in this suite', async () => {
    const je = await client.query(`SELECT count(*)::int AS n FROM journal_entry`);
    expect(je.rows[0].n).toBe(0);
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)`,
      [
        [
          'payment',
          'payment_attempt',
          'ar_transaction',
          'advance_transaction',
          'inventory_movement',
        ],
      ],
    );
    expect(tables.rows).toHaveLength(0);
  });

  // ── authoritative fingerprint recomputation at issuance (Checkpoint C
  //    final-integrity pass §2) — comparing the caller-supplied fingerprint
  //    against the Order's OWN stored column is not enough; the primitive
  //    must reconstruct the canonical snapshot from the LOCKED persisted
  //    Order + OrderLine rows and require it to match BOTH. ────────────────
  describe('authoritative fingerprint recomputation at issuance (Checkpoint C final-integrity pass §2)', () => {
    async function orderCounterNext(): Promise<bigint | null> {
      const r = await client.query(
        `SELECT "nextNumber" FROM document_number_counter WHERE "tenantId"=$1 AND "companyId"=$2 AND "documentType"='ORDER'`,
        [tenantId, companyId],
      );
      return (r.rows[0]?.nextNumber as bigint | undefined) ?? null;
    }

    async function expectNoSideEffect(orderId: string, before: bigint | null): Promise<void> {
      expect(await orderCounterNext()).toEqual(before);
      const inv = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`, [
        orderId,
      ]);
      expect(inv.rows[0].n).toBe(0);
      const o = await client.query(`SELECT status, "orderNumber" FROM "order" WHERE id=$1`, [
        orderId,
      ]);
      expect(o.rows[0].status).toBe('DRAFT');
      expect(o.rows[0].orderNumber).toBeNull();
    }

    function lineSnapshot(quantity: string) {
      return {
        productId,
        variantId,
        quantity,
        selectedUomCode: 'piece',
        baseUomCode: 'piece',
        conversionNumerator: '1',
        conversionDenominator: '1',
        unitPriceAmountMinor: '1000',
        unitPriceCurrencyCode: 'AED',
        unitPriceCurrencyExponent: 2,
        discountMode: 'NONE',
        discountBps: null,
        discountAmountMinor: '0',
        taxCategoryKey: null,
        rateBps: null,
        effectiveFrom: null,
        resolutionSource: 'NONE',
      };
    }

    async function mkTwoLineOrder(): Promise<{
      orderId: string;
      line1Id: string;
      line2Id: string;
      fingerprint: string;
    }> {
      const orderId = randomUUID();
      const line1Id = randomUUID();
      const line2Id = randomUUID();
      const fingerprint = computeCommercialSnapshotFingerprintV2(
        {
          tenantId,
          companyId,
          originBranchId: branchId,
          fulfillingBranchId: branchId,
          customerId: null,
          kind: 'WALK_IN',
          currencyCode: 'AED',
          lines: [lineSnapshot('1.0000'), lineSnapshot('2.0000')],
          documentDiscountMode: 'NONE',
          documentDiscountBps: null,
          documentDiscountAmountMinor: '0',
          documentDiscountReason: null,
        },
        TEST_POLICY,
      );
      await client.query(
        `INSERT INTO "order"
           (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
            "currencyCode","currencyExponent","commercialSnapshotFingerprint",
            "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode",
            "updatedAt")
         VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,2,$6,$7,$8,now())`,
        [
          orderId,
          tenantId,
          companyId,
          branchId,
          fingerprint,
          TEST_POLICY.taxPriceMode,
          TEST_POLICY.taxRoundingScope,
          TEST_POLICY.taxRoundingMode,
        ],
      );
      for (const [id, pos, qty] of [
        [line1Id, 1, '1.0000'],
        [line2Id, 2, '2.0000'],
      ] as const) {
        await client.query(
          `INSERT INTO order_line
             (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
              "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
              "resolutionSource","selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
              "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1000,'AED',2,'NONE','piece','Piece','piece',1,1,'Rose','Rose',now())`,
          [id, tenantId, companyId, orderId, pos, productId, variantId, qty],
        );
      }
      return { orderId, line1Id, line2Id, fingerprint };
    }

    it('A. a normal untouched Order issues successfully (control case)', async () => {
      const { orderId, lineId, fingerprint } = await mkOrder();
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
      );
      expect(result.invoiceNumber).toMatch(/^INV-\d{6}$/);
    });

    it('B. a raw-SQL change to a pre-issue OrderLine commercial field without updating the fingerprint is rejected, with zero side effect', async () => {
      const before = await orderCounterNext();
      const { orderId, lineId, fingerprint } = await mkOrder();
      await client.query(`UPDATE order_line SET "unitPriceAmountMinor"=9999 WHERE id=$1`, [lineId]);
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
      await expectNoSideEffect(orderId, before);
    });

    it('C. a raw-SQL linePosition swap without updating the fingerprint is rejected, with zero side effect', async () => {
      const before = await orderCounterNext();
      const { orderId, line1Id, line2Id, fingerprint } = await mkTwoLineOrder();
      // swap positions via a temp value — the unique index forbids a direct swap
      await client.query(`UPDATE order_line SET "linePosition"=3 WHERE id=$1`, [line1Id]);
      await client.query(`UPDATE order_line SET "linePosition"=1 WHERE id=$1`, [line2Id]);
      await client.query(`UPDATE order_line SET "linePosition"=2 WHERE id=$1`, [line1Id]);
      const input = {
        tenantId,
        companyId,
        branchId,
        orderId,
        expectedVersion: 1,
        commercialSnapshotFingerprint: fingerprint,
        lines: [
          {
            orderLineId: line1Id,
            priceTaxMode: TEST_POLICY.taxPriceMode,
            roundingScope: TEST_POLICY.taxRoundingScope,
            roundingMode: TEST_POLICY.taxRoundingMode,
            lineTaxAmountMinor: 0n,
          },
          {
            orderLineId: line2Id,
            priceTaxMode: TEST_POLICY.taxPriceMode,
            roundingScope: TEST_POLICY.taxRoundingScope,
            roundingMode: TEST_POLICY.taxRoundingMode,
            lineTaxAmountMinor: 0n,
          },
        ],
        totals: {
          subtotalAmountMinor: 3000n,
          documentDiscountAmountMinor: 0n,
          taxTotalAmountMinor: 0n,
          totalAmountMinor: 3000n,
          currencyCode: 'AED',
          currencyExponent: 2,
        },
      };
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_FINGERPRINT_MISMATCH',
      });
      await expectNoSideEffect(orderId, before);
    });

    it('D. a raw-SQL change to an Order-level fingerprinted field without updating the fingerprint is rejected, with zero side effect', async () => {
      const before = await orderCounterNext();
      const { orderId, lineId, fingerprint } = await mkOrder();
      await client.query(`UPDATE "order" SET "customerId"=$2 WHERE id=$1`, [orderId, customerId]);
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
      await expectNoSideEffect(orderId, before);
    });

    it('E. a stale caller-supplied expected fingerprint is rejected even though the order itself is untouched, with zero side effect', async () => {
      const before = await orderCounterNext();
      const { orderId, lineId } = await mkOrder();
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(
            tx,
            finalizedInput(orderId, lineId, 'stale-caller-fingerprint'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
      await expectNoSideEffect(orderId, before);
    });

    // ── D5 (Checkpoint D hard-gate) — the FULL per-field tamper matrix over
    //    every field the shared canonical builder actually hashes. Never
    //    invents a fingerprint field; each raw-SQL mutation stays CHECK-valid
    //    (a consistent discount/tax shape) so the ONLY reason issuance can
    //    fail is the fingerprint mismatch itself. ─────────────────────────
    const lineTamperCases: [string, string][] = [
      ['line quantity', `UPDATE order_line SET quantity='2.0000' WHERE id=$1`],
      [
        'line discount snapshot',
        `UPDATE order_line SET "discountMode"='AMOUNT', "discountBps"=NULL, "discountAmountMinor"=100 WHERE id=$1`,
      ],
      [
        'selected/base UOM',
        `UPDATE order_line SET "selectedUomCode"='dozenX', "baseUomCode"='dozenX' WHERE id=$1`,
      ],
      [
        'conversion numerator/denominator',
        `UPDATE order_line SET "conversionNumerator"=2, "conversionDenominator"=1 WHERE id=$1`,
      ],
      [
        'tax-reference fields (taxCategoryKey/resolutionSource)',
        `UPDATE order_line SET "resolutionSource"='VARIANT', "taxCategoryKey"='STANDARD' WHERE id=$1`,
      ],
    ];
    it.each(lineTamperCases)(
      'F. a raw-SQL tamper of %s without updating the fingerprint is rejected, with zero side effect',
      async (_label, sql) => {
        const before = await orderCounterNext();
        const { orderId, lineId, fingerprint } = await mkOrder();
        await client.query(sql, [lineId]);
        await expect(
          asTenant((tx) =>
            issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
          ),
        ).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
        await expectNoSideEffect(orderId, before);
      },
    );

    it('G. a raw-SQL tamper of an Order-level document-discount field without updating the fingerprint is rejected, with zero side effect', async () => {
      const before = await orderCounterNext();
      const { orderId, lineId, fingerprint } = await mkOrder();
      await client.query(`UPDATE "order" SET "documentDiscountReason"='tampered' WHERE id=$1`, [
        orderId,
      ]);
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
      await expectNoSideEffect(orderId, before);
    });

    it('H. tampering fields EXCLUDED from the fingerprint contract (descriptive/SKU/UOM-label snapshot) never causes a false mismatch', async () => {
      const { orderId, lineId, fingerprint } = await mkOrder();
      await client.query(
        `UPDATE order_line SET "productNameEnSnapshot"='Changed', "variantNameEnSnapshot"='Changed',
           "skuSnapshot"='CHANGED-SKU', "uomDisplayLabelSnapshot"='Changed Label' WHERE id=$1`,
        [lineId],
      );
      const result = await asTenant((tx) =>
        issuance.issueFinalInvoice(tx, finalizedInput(orderId, lineId, fingerprint)),
      );
      expect(result.invoiceNumber).toMatch(/^INV-\d{6}$/);
    });
  });

  // ── D3.D (Checkpoint D hard-gate) — many concurrent DIFFERENT Orders in the
  //    SAME company under real concurrency: unique, monotonic, gapless. ─────
  it('same-company parallel issuance of MANY different Orders yields unique, monotonic, gapless Order numbers', async () => {
    const before = await client.query<{ nextNumber: string }>(
      `SELECT "nextNumber"::text FROM document_number_counter WHERE "tenantId"=$1 AND "companyId"=$2 AND "documentType"='ORDER'`,
      [tenantId, companyId],
    );
    const beforeNext = BigInt(before.rows[0]?.nextNumber ?? '1');
    const orders = await Promise.all(Array.from({ length: 5 }, () => mkOrder()));
    const results = await Promise.all(
      orders.map((o) =>
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, finalizedInput(o.orderId, o.lineId, o.fingerprint)),
        ),
      ),
    );
    const numbers = results.map((r) => Number(r.orderNumber.replace('ORD-', '')));
    expect(new Set(numbers).size).toBe(5); // all unique
    numbers.sort((a, b) => a - b);
    const expectedStart = Number(beforeNext);
    expect(numbers).toEqual(
      Array.from({ length: 5 }, (_, i) => expectedStart + i), // strictly consecutive — no gap
    );
  });
});
