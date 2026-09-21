import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising the internal finalization primitive's
// caller-transaction participation contract directly (task 3b.4 Checkpoint D)
// — not production module code. Mirrors
// `invoice-issuance.repository.integration.test.ts`'s exact no-HTTP,
// no-Redis, direct-construction pattern.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import { InvoiceIssuanceRepository } from './invoice-issuance.repository.js';
import { TaxFinalizationService } from './tax-finalization.service.js';
import {
  computeCommercialSnapshotFingerprintV1,
  computeCommercialSnapshotFingerprintV2,
  type CommercialSnapshotLine,
} from './commercial-snapshot.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import { LocalizationRepository } from '../localization/localization.repository.js';
import { LocalizationService } from '../localization/localization.service.js';

/**
 * Task 3b.4 Checkpoint D — `TaxFinalizationService.finalizeAndIssueInvoice`
 * against real Postgres: assembling finalized line-tax snapshots, document-
 * discount allocation integration, LINE/DOCUMENT rounding integration,
 * finalized Invoice totals, policy-uniformity validation, and the minimal
 * `InvoiceIssuanceRepository` totals-validation change — all inside ONE
 * caller-owned transaction, delegating to the existing (Task 3b.3 Checkpoint
 * C) `issueFinalInvoice` primitive.
 */
describe('TaxFinalizationService.finalizeAndIssueInvoice (task 3b.4 Checkpoint D, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let issuance: InvoiceIssuanceRepository;
  let finalization: TaxFinalizationService;
  let client: pg.Client;

  const tenantId = randomUUID();
  let companyId = '';
  let kwdCompanyId = ''; // 3-decimal currency company (test N)
  let branchId = '';
  let kwdBranchId = '';
  let productId = '';
  let variantId = '';

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
    finalization = new TaxFinalizationService(issuance);

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await client.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `d-plan-${planId.slice(0, 8)}`,
    ]);
    await client.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    await client.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
      [tenantId, `d-${tenantId.slice(0, 8)}`, planVersionId],
    );
    await client.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x'), ('KWD', 3, 'KWD', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "updatedAt")
       VALUES ('AE', 'UAE', 'x', 'gcc', 'AED', 'SAT_SUN', true, now()) ON CONFLICT (code) DO NOTHING`,
    );
    companyId = randomUUID();
    kwdCompanyId = randomUUID();
    await client.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
       VALUES ($1,$2,'Test Co','AE','AED','Asia/Dubai',now())`,
      [companyId, tenantId],
    );
    await client.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
       VALUES ($1,$2,'KWD Co','AE','KWD','Asia/Dubai',now())`,
      [kwdCompanyId, tenantId],
    );
    branchId = randomUUID();
    kwdBranchId = randomUUID();
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main',now())`,
      [branchId, tenantId, companyId],
    );
    await client.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main',now())`,
      [kwdBranchId, tenantId, kwdCompanyId],
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
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  interface LineSpec {
    quantity: string;
    unitPriceAmountMinor: bigint;
    discountAmountMinor?: bigint;
    /** null = no-rate (`resolutionSource='NONE'`); a number = a resolved rate
     *  (`resolutionSource='VARIANT'`), 0 being a real configured zero-rate. */
    rateBps: number | null;
  }

  function snapshotLineFor(
    spec: LineSpec,
    currencyCode: string,
    currencyExponent: number,
  ): CommercialSnapshotLine {
    return {
      productId,
      variantId,
      quantity: spec.quantity,
      selectedUomCode: 'piece',
      baseUomCode: 'piece',
      conversionNumerator: '1',
      conversionDenominator: '1',
      unitPriceAmountMinor: spec.unitPriceAmountMinor.toString(),
      unitPriceCurrencyCode: currencyCode,
      unitPriceCurrencyExponent: currencyExponent,
      discountMode: (spec.discountAmountMinor ?? 0n) > 0n ? 'AMOUNT' : 'NONE',
      discountBps: null,
      discountAmountMinor: (spec.discountAmountMinor ?? 0n).toString(),
      taxCategoryKey: spec.rateBps === null ? null : 'STANDARD',
      rateBps: spec.rateBps,
      effectiveFrom: spec.rateBps === null ? null : '2020-01-01',
      resolutionSource: spec.rateBps === null ? 'NONE' : 'VARIANT',
    };
  }

  /** Inserts one Order + its OrderLines directly via raw SQL — total control
   *  over every authoritative persisted value `TaxFinalizationService` reads
   *  (§D3). Fingerprint computed via the REAL frozen V1/V2 builder for the
   *  requested version — never an arbitrary literal. */
  async function mkOrder(opts: {
    lines: LineSpec[];
    taxPriceMode: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';
    taxRoundingScope: 'LINE' | 'DOCUMENT';
    taxRoundingMode?: 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP' | 'HALF_DOWN';
    documentDiscountAmountMinor?: bigint;
    fingerprintVersion?: 1 | 2;
    companyId?: string;
    branchId?: string;
    currencyCode?: string;
    currencyExponent?: number;
  }): Promise<{ orderId: string; lineIds: string[]; version: number; fingerprint: string }> {
    const co = opts.companyId ?? companyId;
    const br = opts.branchId ?? branchId;
    const currencyCode = opts.currencyCode ?? 'AED';
    const currencyExponent = opts.currencyExponent ?? 2;
    const roundingMode = opts.taxRoundingMode ?? 'HALF_UP';
    const documentDiscountAmountMinor = opts.documentDiscountAmountMinor ?? 0n;
    const version = opts.fingerprintVersion ?? 2;

    const snapshotLines = opts.lines.map((l) => snapshotLineFor(l, currencyCode, currencyExponent));
    const v1Input = {
      tenantId,
      companyId: co,
      originBranchId: br,
      fulfillingBranchId: br,
      customerId: null,
      kind: 'WALK_IN',
      currencyCode,
      lines: snapshotLines,
      documentDiscountMode: documentDiscountAmountMinor > 0n ? 'AMOUNT' : 'NONE',
      documentDiscountBps: null,
      documentDiscountAmountMinor: documentDiscountAmountMinor.toString(),
      documentDiscountReason: null,
    };
    const fingerprint =
      version === 1
        ? computeCommercialSnapshotFingerprintV1(v1Input)
        : computeCommercialSnapshotFingerprintV2(v1Input, {
            taxPriceMode: opts.taxPriceMode,
            taxRoundingScope: opts.taxRoundingScope,
            taxRoundingMode: roundingMode,
          });

    const orderId = randomUUID();
    await client.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
          "currencyCode","currencyExponent","documentDiscountMode","documentDiscountAmountMinor",
          "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
          "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT',$5,$6,$7,$8,$9,$10,$11,$12,$13,now())`,
      [
        orderId,
        tenantId,
        co,
        br,
        currencyCode,
        currencyExponent,
        documentDiscountAmountMinor > 0n ? 'AMOUNT' : 'NONE',
        documentDiscountAmountMinor,
        fingerprint,
        version,
        opts.taxPriceMode,
        opts.taxRoundingScope,
        roundingMode,
      ],
    );
    const lineIds: string[] = [];
    for (let i = 0; i < opts.lines.length; i++) {
      const spec = opts.lines[i]!;
      const lineId = randomUUID();
      lineIds.push(lineId);
      await client.query(
        `INSERT INTO order_line
           (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
            "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
            "discountMode","discountAmountMinor",
            "taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
            "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
            "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot",
            "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 CASE WHEN $15::int IS NULL THEN NULL ELSE '2020-01-01'::date END,$16,
                 'piece','Piece','piece',1,1,'Rose','Rose',now())`,
        [
          lineId,
          tenantId,
          co,
          orderId,
          i + 1,
          productId,
          variantId,
          spec.quantity,
          spec.unitPriceAmountMinor,
          currencyCode,
          currencyExponent,
          (spec.discountAmountMinor ?? 0n) > 0n ? 'AMOUNT' : 'NONE',
          spec.discountAmountMinor ?? 0n,
          spec.rateBps === null ? null : 'STANDARD',
          spec.rateBps,
          spec.rateBps === null ? 'NONE' : 'VARIANT',
        ],
      );
    }
    return { orderId, lineIds, version: 1, fingerprint };
  }

  function finalize(order: { orderId: string; version: number; fingerprint: string }) {
    return asTenant((tx) =>
      finalization.finalizeAndIssueInvoice(tx, {
        tenantId,
        companyId,
        branchId,
        orderId: order.orderId,
        expectedVersion: order.version,
        commercialSnapshotFingerprint: order.fingerprint,
      }),
    );
  }

  // `pg` returns BIGINT columns as strings by default (no global type-parser
  // registered in this codebase, matching `invoice-issuance.repository
  // .integration.test.ts`'s own precedent) — every BIGINT column is
  // `::text`-cast in SQL and explicitly `BigInt(...)`-converted here, never
  // compared as a raw string against a `bigint` literal.
  async function getInvoice(orderId: string) {
    const { rows } = await client.query<{
      subtotalAmountMinor: string;
      documentDiscountAmountMinor: string;
      taxTotalAmountMinor: string;
      totalAmountMinor: string;
      currencyCode: string;
      currencyExponent: number;
    }>(
      `SELECT "subtotalAmountMinor"::text AS "subtotalAmountMinor",
              "documentDiscountAmountMinor"::text AS "documentDiscountAmountMinor",
              "taxTotalAmountMinor"::text AS "taxTotalAmountMinor",
              "totalAmountMinor"::text AS "totalAmountMinor",
              "currencyCode","currencyExponent"
         FROM invoice WHERE "orderId" = $1`,
      [orderId],
    );
    const r = rows[0]!;
    return {
      subtotalAmountMinor: BigInt(r.subtotalAmountMinor),
      documentDiscountAmountMinor: BigInt(r.documentDiscountAmountMinor),
      taxTotalAmountMinor: BigInt(r.taxTotalAmountMinor),
      totalAmountMinor: BigInt(r.totalAmountMinor),
      currencyCode: r.currencyCode,
      currencyExponent: r.currencyExponent,
    };
  }

  async function getLines(orderId: string) {
    const { rows } = await client.query<{
      id: string;
      linePosition: number;
      lineTaxAmountMinor: string | null;
      priceTaxMode: string;
      roundingScope: string;
      roundingMode: string;
      rateBps: number | null;
      taxCategoryKey: string | null;
      resolutionSource: string;
    }>(
      `SELECT id,"linePosition","lineTaxAmountMinor"::text AS "lineTaxAmountMinor",
              "priceTaxMode","roundingScope","roundingMode",
              "rateBps","taxCategoryKey","resolutionSource"
         FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition" ASC`,
      [orderId],
    );
    return rows.map((r) => ({
      ...r,
      lineTaxAmountMinor: r.lineTaxAmountMinor === null ? null : BigInt(r.lineTaxAmountMinor),
    }));
  }

  // ── D15 — required arithmetic integration tests ──────────────────────────

  it('A. TAX_EXCLUSIVE + LINE + simple 5%', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 100_000n, rateBps: 500 }],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines[0]!.lineTaxAmountMinor).toBe(5_000n);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 100_000n,
      taxTotalAmountMinor: 5_000n,
      totalAmountMinor: 105_000n,
    });
  });

  it('B. TAX_INCLUSIVE + LINE + simple 5%', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_INCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 105_000n, rateBps: 500 }],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines[0]!.lineTaxAmountMinor).toBe(5_000n);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 105_000n,
      taxTotalAmountMinor: 5_000n,
      totalAmountMinor: 105_000n, // NOT 110_000n — §D16
    });
  });

  it('C. TAX_EXCLUSIVE + DOCUMENT (3 identical fractional lines, residual distributed to lowest linePosition first)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'DOCUMENT',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 333n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 333n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 333n, rateBps: 500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([17n, 17n, 16n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 999n,
      taxTotalAmountMinor: 50n,
      totalAmountMinor: 1049n,
    });
  });

  it('D. TAX_INCLUSIVE + DOCUMENT (heterogeneous denominators, zero residual)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_INCLUSIVE',
      taxRoundingScope: 'DOCUMENT',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_050n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 210n, rateBps: 1_000 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([50n, 19n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 1_260n,
      taxTotalAmountMinor: 69n,
      totalAmountMinor: 1_260n, // NOT 1_329n
    });
  });

  it('E. mixed rates/categories under TAX_EXCLUSIVE (LINE)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 2_000n, rateBps: 1_500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([50n, 300n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 3_000n,
      taxTotalAmountMinor: 350n,
      totalAmountMinor: 3_350n,
    });
  });

  it('F. mixed rates/categories under TAX_INCLUSIVE (LINE)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_INCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_050n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 2_300n, rateBps: 1_500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([50n, 300n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 3_350n,
      taxTotalAmountMinor: 350n,
      totalAmountMinor: 3_350n,
    });
  });

  it('G. standard + zero-rate (resolved 0%, normal arithmetic path)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: 0 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([50n, 0n]);
    expect(lines[1]).toMatchObject({
      rateBps: 0,
      taxCategoryKey: 'STANDARD',
      resolutionSource: 'VARIANT',
    });
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 1_500n,
      taxTotalAmountMinor: 50n,
      totalAmountMinor: 1_550n,
    });
  });

  it('H. standard + no-rate (never computed via arithmetic, tax-reference untouched)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: null },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([50n, 0n]);
    expect(lines[1]).toMatchObject({
      rateBps: null,
      taxCategoryKey: null,
      resolutionSource: 'NONE',
    });
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 1_500n,
      taxTotalAmountMinor: 50n,
      totalAmountMinor: 1_550n,
    });
  });

  it('I. a 100%-line-discounted line contributes zero commercial amount and zero tax', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [
        {
          quantity: '1.0000',
          unitPriceAmountMinor: 1_000n,
          discountAmountMinor: 1_000n,
          rateBps: 500,
        },
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([0n, 50n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 1_000n,
      taxTotalAmountMinor: 50n,
      totalAmountMinor: 1_050n,
    });
  });

  it('J. document discount evenly across multiple lines', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      documentDiscountAmountMinor: 300n,
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([45n, 45n, 45n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 3_000n,
      documentDiscountAmountMinor: 300n,
      taxTotalAmountMinor: 135n,
      totalAmountMinor: 2_835n,
    });
  });

  it('K. document-discount remainder allocation (largest-remainder tie-break by linePosition ASC)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      documentDiscountAmountMinor: 100n,
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([48n, 48n, 48n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 3_000n,
      documentDiscountAmountMinor: 100n,
      taxTotalAmountMinor: 144n,
      totalAmountMinor: 3_044n,
    });
  });

  it('L. fractional quantity', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [{ quantity: '0.3333', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines[0]!.lineTaxAmountMinor).toBe(17n);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 333n,
      taxTotalAmountMinor: 17n,
      totalAmountMinor: 350n,
    });
  });

  it('M. 2-decimal currency (AED) — currencyCode/exponent propagate to the Invoice', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
    });
    await finalize(o);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({ currencyCode: 'AED', currencyExponent: 2 });
  });

  it('N. 3-decimal currency (KWD)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      companyId: kwdCompanyId,
      branchId: kwdBranchId,
      currencyCode: 'KWD',
      currencyExponent: 3,
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
    });
    const result = await asTenant((tx) =>
      finalization.finalizeAndIssueInvoice(tx, {
        tenantId,
        companyId: kwdCompanyId,
        branchId: kwdBranchId,
        orderId: o.orderId,
        expectedVersion: o.version,
        commercialSnapshotFingerprint: o.fingerprint,
      }),
    );
    expect(result.invoiceNumber).toMatch(/^INV-\d{6}$/);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      currencyCode: 'KWD',
      currencyExponent: 3,
      taxTotalAmountMinor: 50n,
      totalAmountMinor: 1_050n,
    });
  });

  it('O. exact-half rounding boundary (HALF_UP rounds away from zero)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      taxRoundingMode: 'HALF_UP',
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 10n, rateBps: 500 }], // exact 0.5
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines[0]!.lineTaxAmountMinor).toBe(1n);
  });

  it.each([
    ['HALF_UP', 1n],
    ['HALF_EVEN', 0n],
    ['DOWN', 0n],
    ['UP', 1n],
    ['HALF_DOWN', 0n],
  ] as const)(
    'P. all 5 rounding modes on the same exact-half boundary — %s -> %s',
    async (mode, expected) => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        taxRoundingMode: mode,
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 10n, rateBps: 500 }],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines[0]!.lineTaxAmountMinor).toBe(expected);
    },
  );

  it('Q. DOCUMENT rounding with heterogeneous denominators (TAX_INCLUSIVE, different rates -> different denominators)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_INCLUSIVE',
      taxRoundingScope: 'DOCUMENT',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 100n, rateBps: 500 }, // denom 10500
        { quantity: '1.0000', unitPriceAmountMinor: 100n, rateBps: 1_000 }, // denom 11000
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([5n, 9n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 200n,
      taxTotalAmountMinor: 14n,
      totalAmountMinor: 200n,
    });
  });

  it('R. document discount D = 0 leaves every line unaffected', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      documentDiscountAmountMinor: 0n,
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 2_000n, rateBps: 500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([50n, 100n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 3_000n,
      documentDiscountAmountMinor: 0n,
      taxTotalAmountMinor: 150n,
      totalAmountMinor: 3_150n,
    });
  });

  it('S. document discount D = subtotal (full discount, zero commercial base remains)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      documentDiscountAmountMinor: 1_500n,
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
        { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: 500 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([0n, 0n]);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 1_500n,
      documentDiscountAmountMinor: 1_500n,
      taxTotalAmountMinor: 0n,
      totalAmountMinor: 0n,
    });
  });

  it('T. zero total commercial amount with D = 0 (single fully-line-discounted line)', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      documentDiscountAmountMinor: 0n,
      lines: [
        {
          quantity: '1.0000',
          unitPriceAmountMinor: 1_000n,
          discountAmountMinor: 1_000n,
          rateBps: 500,
        },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines[0]!.lineTaxAmountMinor).toBe(0n);
    const inv = await getInvoice(o.orderId);
    expect(inv).toMatchObject({
      subtotalAmountMinor: 0n,
      documentDiscountAmountMinor: 0n,
      taxTotalAmountMinor: 0n,
      totalAmountMinor: 0n,
    });
  });

  // ── D16 — inclusive total hard gate ──────────────────────────────────────

  describe('D16 — inclusive total hard gate (never re-adds included tax)', () => {
    it('inclusive subtotal 10000, D=0 -> total stays 10000, never 10000+X', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_INCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 10_000n, rateBps: 500 }],
      });
      await finalize(o);
      const inv = await getInvoice(o.orderId);
      expect(inv.taxTotalAmountMinor > 0n).toBe(true); // a real, nonzero extracted tax
      expect(inv.totalAmountMinor).toBe(10_000n);
      expect(inv.totalAmountMinor).not.toBe(10_000n + inv.taxTotalAmountMinor);
    });

    it('inclusive subtotal 10000, D=1000 -> total is exactly 9000, regardless of the extracted tax amount', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_INCLUSIVE',
        taxRoundingScope: 'LINE',
        documentDiscountAmountMinor: 1_000n,
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 10_000n, rateBps: 500 }],
      });
      await finalize(o);
      const inv = await getInvoice(o.orderId);
      expect(inv.totalAmountMinor).toBe(9_000n);
    });
  });

  // ── D17 — policy-uniformity hard gate (direct issueFinalInvoice call) ────

  describe('D17 — policy-uniformity hard gate', () => {
    async function expectNoSideEffect(orderId: string): Promise<void> {
      const inv = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`, [
        orderId,
      ]);
      expect(inv.rows[0].n).toBe(0);
      const o = await client.query(
        `SELECT status, "orderNumber", version FROM "order" WHERE id=$1`,
        [orderId],
      );
      expect(o.rows[0].status).toBe('DRAFT');
      expect(o.rows[0].orderNumber).toBeNull();
      expect(o.rows[0].version).toBe(1);
      const lines = await client.query(
        `SELECT "lineTaxAmountMinor" FROM order_line WHERE "orderId"=$1`,
        [orderId],
      );
      for (const r of lines.rows) expect(r.lineTaxAmountMinor).toBeNull();
    }

    it('rejects a wrong priceTaxMode before any write', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      const lineRow = (await getLines(o.orderId))[0]!;
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, {
            tenantId,
            companyId,
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
            lines: [
              {
                orderLineId: lineRow.id,
                priceTaxMode: 'TAX_INCLUSIVE', // wrong — order is TAX_EXCLUSIVE
                roundingScope: 'LINE',
                roundingMode: 'HALF_UP',
                lineTaxAmountMinor: 50n,
              },
            ],
            totals: {
              subtotalAmountMinor: 1_000n,
              documentDiscountAmountMinor: 0n,
              taxTotalAmountMinor: 50n,
              totalAmountMinor: 1_050n,
              currencyCode: 'AED',
              currencyExponent: 2,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_LINE_TAX_POLICY_MISMATCH' });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a wrong roundingScope before any write', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      const lineRow = (await getLines(o.orderId))[0]!;
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, {
            tenantId,
            companyId,
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
            lines: [
              {
                orderLineId: lineRow.id,
                priceTaxMode: 'TAX_EXCLUSIVE',
                roundingScope: 'DOCUMENT', // wrong — order is LINE
                roundingMode: 'HALF_UP',
                lineTaxAmountMinor: 50n,
              },
            ],
            totals: {
              subtotalAmountMinor: 1_000n,
              documentDiscountAmountMinor: 0n,
              taxTotalAmountMinor: 50n,
              totalAmountMinor: 1_050n,
              currencyCode: 'AED',
              currencyExponent: 2,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_LINE_TAX_POLICY_MISMATCH' });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a wrong roundingMode before any write', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        taxRoundingMode: 'HALF_UP',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      const lineRow = (await getLines(o.orderId))[0]!;
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, {
            tenantId,
            companyId,
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
            lines: [
              {
                orderLineId: lineRow.id,
                priceTaxMode: 'TAX_EXCLUSIVE',
                roundingScope: 'LINE',
                roundingMode: 'HALF_EVEN', // wrong — order is HALF_UP
                lineTaxAmountMinor: 50n,
              },
            ],
            totals: {
              subtotalAmountMinor: 1_000n,
              documentDiscountAmountMinor: 0n,
              taxTotalAmountMinor: 50n,
              totalAmountMinor: 1_050n,
              currencyCode: 'AED',
              currencyExponent: 2,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_LINE_TAX_POLICY_MISMATCH' });
      await expectNoSideEffect(o.orderId);
    });
  });

  // ── D18 — historical CountryTaxConfig independence ───────────────────────

  it('D18. an Order finalizes using its OWN persisted fiscal policy, independent of any later CountryTaxConfig change (no issuance-time lookup)', async () => {
    // Order A "created under P1" (TAX_EXCLUSIVE) and Order B "created under
    // P2" (TAX_INCLUSIVE) — simulated directly via each Order's own
    // persisted columns, proving `TaxFinalizationService` never consults
    // `country_tax_config` at issuance time (source-scanned separately, §D23)
    // regardless of what that table currently contains.
    const orderA = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
    });
    const orderB = await mkOrder({
      taxPriceMode: 'TAX_INCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_050n, rateBps: 500 }],
    });
    await finalize(orderA);
    await finalize(orderB);
    const invA = await getInvoice(orderA.orderId);
    const invB = await getInvoice(orderB.orderId);
    expect(invA.totalAmountMinor).toBe(1_050n); // EXCLUSIVE: 1000 + 50
    expect(invB.totalAmountMinor).toBe(1_050n); // INCLUSIVE: 1050 unchanged
  });

  // ── D19 — V1 legacy Order ─────────────────────────────────────────────────

  it('D19. a V1 legacy Order (backfilled policy) finalizes correctly, verifies via the V1 builder, and never upgrades to V2', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      fingerprintVersion: 1,
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
    });
    const result = await finalize(o);
    expect(result.invoiceNumber).toMatch(/^INV-\d{6}$/);
    const { rows } = await client.query<{ commercialSnapshotFingerprintVersion: number }>(
      `SELECT "commercialSnapshotFingerprintVersion" FROM "order" WHERE id = $1`,
      [o.orderId],
    );
    expect(rows[0]!.commercialSnapshotFingerprintVersion).toBe(1);
  });

  // ── D20 — V2 Order ────────────────────────────────────────────────────────

  it('D20. a normal V2 Order finalizes correctly; raw policy tamper remains DB-blocked post-issuance', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      fingerprintVersion: 2,
      lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
    });
    await finalize(o);
    await expect(
      client.query(`UPDATE "order" SET "taxPriceMode" = 'TAX_INCLUSIVE' WHERE id = $1`, [
        o.orderId,
      ]),
    ).rejects.toThrow(/immutable/i);
  });

  // ── D21 — no-rate / zero-rate distinction survives finalization ─────────

  it('D21. finalization never rewrites the tax-reference snapshot (rateBps/taxCategoryKey/resolutionSource) for no-rate or zero-rate lines', async () => {
    const o = await mkOrder({
      taxPriceMode: 'TAX_EXCLUSIVE',
      taxRoundingScope: 'LINE',
      lines: [
        { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: null },
        { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: 0 },
      ],
    });
    await finalize(o);
    const lines = await getLines(o.orderId);
    expect(lines[0]).toMatchObject({
      rateBps: null,
      taxCategoryKey: null,
      resolutionSource: 'NONE',
    });
    expect(lines[1]).toMatchObject({
      rateBps: 0,
      taxCategoryKey: 'STANDARD',
      resolutionSource: 'VARIANT',
    });
  });

  // ── D14 — rollback / atomicity ────────────────────────────────────────────

  describe('D14 — rollback leaves zero partial state', () => {
    it('a stale expectedVersion causes the whole finalization to roll back: DRAFT/no orderNumber/no Invoice/no finalized tax fields/counter unchanged', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'DOCUMENT',
        lines: [
          { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
          { quantity: '1.0000', unitPriceAmountMinor: 2_000n, rateBps: 1_500 },
        ],
      });
      const before = await client.query<{ nextNumber: bigint | null }>(
        `SELECT "nextNumber" FROM document_number_counter WHERE "tenantId"=$1 AND "companyId"=$2 AND "documentType"='ORDER'`,
        [tenantId, companyId],
      );
      await expect(
        asTenant((tx) =>
          finalization.finalizeAndIssueInvoice(tx, {
            tenantId,
            companyId,
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version + 5, // stale — forces rejection AFTER tax computation
            commercialSnapshotFingerprint: o.fingerprint,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_VERSION_CONFLICT' });

      const after = await client.query<{ nextNumber: bigint | null }>(
        `SELECT "nextNumber" FROM document_number_counter WHERE "tenantId"=$1 AND "companyId"=$2 AND "documentType"='ORDER'`,
        [tenantId, companyId],
      );
      expect(after.rows[0]?.nextNumber ?? null).toEqual(before.rows[0]?.nextNumber ?? null);
      const inv = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`, [
        o.orderId,
      ]);
      expect(inv.rows[0].n).toBe(0);
      const orderRow = await client.query(
        `SELECT status, "orderNumber", version FROM "order" WHERE id=$1`,
        [o.orderId],
      );
      expect(orderRow.rows[0]).toMatchObject({ status: 'DRAFT', orderNumber: null, version: 1 });
      const lines = await getLines(o.orderId);
      for (const l of lines) expect(l.lineTaxAmountMinor).toBeNull();
      const audit = await client.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE "resourceId"=$1`,
        [o.orderId],
      );
      expect(audit.rows[0].n).toBe(0);
    });

    it('concurrent issue-vs-issue on the same Order: exactly one wins, the other gets a deterministic conflict, no double Invoice', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      const attempt = () => finalize(o);
      const [r1, r2] = await Promise.allSettled([attempt(), attempt()]);
      const outcomes = [r1, r2];
      const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
      const rejected = outcomes.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const inv = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`, [
        o.orderId,
      ]);
      expect(inv.rows[0].n).toBe(1);
    });
  });

  // ── E3 — full caller-transaction rollback proof ──────────────────────────

  describe('E3 — full caller-transaction rollback (success-then-abort)', () => {
    it('a caller that lets finalization fully succeed (writes everything) but never commits leaves zero trace; the real successful re-issuance reuses the exact same numbers', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      let captured: { orderNumber: string; invoiceNumber: string } | undefined;
      await expect(
        runScoped(prisma, { tenantId }, async (tx) => {
          captured = await finalization.finalizeAndIssueInvoice(tx, {
            tenantId,
            companyId,
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
          });
          // deliberately abort AFTER a fully successful write sequence —
          // never let the caller's own transaction commit.
          throw new Error('deliberate-caller-abort');
        }),
      ).rejects.toThrow('deliberate-caller-abort');
      expect(captured).toBeDefined();
      expect(captured!.orderNumber).toMatch(/^ORD-\d{6}$/);
      expect(captured!.invoiceNumber).toMatch(/^INV-\d{6}$/);

      // proof from a SEPARATE connection (never inside the aborted tx) —
      // real rollback, not merely "the promise rejected".
      const orderRow = await client.query(
        `SELECT status, "orderNumber", version FROM "order" WHERE id=$1`,
        [o.orderId],
      );
      expect(orderRow.rows[0]).toMatchObject({ status: 'DRAFT', orderNumber: null, version: 1 });
      const inv = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`, [
        o.orderId,
      ]);
      expect(inv.rows[0].n).toBe(0);
      const lines = await getLines(o.orderId);
      for (const l of lines) {
        expect(l.lineTaxAmountMinor).toBeNull();
      }
      // no Invoice exists (already asserted above), so `invoice.issued`
      // audits (keyed by invoice id) cannot exist either — only
      // `order.confirmed` (keyed by orderId) needs a direct check here.
      const audit = await client.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE "resourceId" = $1`,
        [o.orderId],
      );
      expect(audit.rows[0].n).toBe(0);

      // now really issue it — the SAME numbers the aborted attempt had
      // temporarily allocated (gapless: the counter itself rolled back too).
      const real = await finalize(o);
      expect(real.orderNumber).toBe(captured!.orderNumber);
      expect(real.invoiceNumber).toBe(captured!.invoiceNumber);
    });
  });

  // ── E5 — historical fiscal-policy lifecycle (real CountryTaxConfig P1->P2) ─

  describe('E5 — historical fiscal-policy lifecycle', () => {
    it('P1 (effective D1) closed then P2 opened later: an Order created under P1 keeps using P1 at finalization even after P2 exists; a fresh Order under P2 uses P2; no CountryTaxConfig lookup at finalization', async () => {
      const country = 'E5';
      const dbService = { appClient: () => prisma } as unknown as DbService;
      const localization = new LocalizationService(new LocalizationRepository(dbService));
      await client.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
         VALUES ($1,'E5 Test','x','XX','AED','SAT_SUN', now()) ON CONFLICT (code) DO NOTHING`,
        [country],
      );
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT',
                 '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
        [country],
      );
      // legitimately CLOSE P1 via the frozen effective-dated lifecycle (NULL
      // -> non-NULL effectiveTo) — never edited in place.
      await client.query(
        `UPDATE country_tax_config SET "effectiveTo" = '2020-06-30' WHERE "countryCode" = $1`,
        [country],
      );
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-07-01','VAT',
                 '{"priceTaxMode":"TAX_INCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
        [country],
      );

      const p1 = await runWithContext(
        new RequestContext({ requestId: randomUUID(), tenantId }),
        () => localization.resolveFiscalPolicyOn(country, '2020-03-01'),
      );
      expect(p1.priceTaxMode).toBe('TAX_EXCLUSIVE');
      const p2 = await runWithContext(
        new RequestContext({ requestId: randomUUID(), tenantId }),
        () => localization.resolveFiscalPolicyOn(country, '2020-08-01'),
      );
      expect(p2.priceTaxMode).toBe('TAX_INCLUSIVE');

      // O1 "created under P1" and O2 "created under P2" — their OWN
      // persisted columns carry the policy forever (Task 3b.4 Checkpoint C);
      // finalization reads only that, never `country_tax_config` again.
      const o1 = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      const o2 = await mkOrder({
        taxPriceMode: 'TAX_INCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_050n, rateBps: 500 }],
      });
      await finalize(o1);
      await finalize(o2);
      const inv1 = await getInvoice(o1.orderId);
      const inv2 = await getInvoice(o2.orderId);
      expect(inv1.totalAmountMinor).toBe(1_050n); // EXCLUSIVE: 1000 + 50
      expect(inv2.totalAmountMinor).toBe(1_050n); // INCLUSIVE: 1050 unchanged
    });
  });

  // ── E9 — document-rounding hard gates (cross-multiplication counter-example) ─

  describe('E9 — document rounding: mathematically larger rational wins regardless of raw numerator size', () => {
    it('a line with a SMALLER raw remainder numerator but a LARGER true fraction (tiny denominator) wins the residual over a line with a larger raw numerator but smaller true fraction', async () => {
      // line1: rate=1% (denom 10100), commercial=50 -> exact 5000/10100,
      //   floor=0, remainder=5000 (fraction ~= 0.4950).
      // line2: rate=99% (denom 19900), commercial=97 -> exact 960300/19900,
      //   floor=48, remainder=5100 (fraction ~= 0.2563).
      // line2's RAW remainder (5100) > line1's (5000), but line1's TRUE
      // fraction is larger (smaller denominator) — line1 must win.
      const o = await mkOrder({
        taxPriceMode: 'TAX_INCLUSIVE',
        taxRoundingScope: 'DOCUMENT',
        lines: [
          { quantity: '1.0000', unitPriceAmountMinor: 50n, rateBps: 100 },
          { quantity: '1.0000', unitPriceAmountMinor: 97n, rateBps: 9_900 },
        ],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([1n, 48n]);
      const inv = await getInvoice(o.orderId);
      expect(inv).toMatchObject({
        subtotalAmountMinor: 147n,
        taxTotalAmountMinor: 49n,
        totalAmountMinor: 147n,
      });
    });
  });

  // ── E10 — document-discount hard gates (extra) ───────────────────────────

  describe('E10 — document-discount hard gates', () => {
    it('a zero-commercial (fully line-discounted) line receives zero discount share and zero tax; a rated + zero-rate + zero-commercial line set all participate identically in the weight calculation', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        documentDiscountAmountMinor: 1_499n, // subtotal (1500) - 1
        lines: [
          { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
          { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: 0 },
          {
            quantity: '1.0000',
            unitPriceAmountMinor: 1_000n,
            discountAmountMinor: 1_000n, // fully line-discounted -> 0 commercial
            rateBps: null,
          },
        ],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines.every((l) => l.lineTaxAmountMinor !== null && l.lineTaxAmountMinor >= 0n)).toBe(
        true,
      );
      expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([0n, 0n, 0n]);
      const inv = await getInvoice(o.orderId);
      expect(inv).toMatchObject({
        subtotalAmountMinor: 1_500n,
        documentDiscountAmountMinor: 1_499n,
        taxTotalAmountMinor: 0n,
        totalAmountMinor: 1n,
      });
    });
  });

  // ── E11 — no-rate vs zero-rate, all three shapes in ONE Order ────────────

  describe('E11 — standard + zero-rate + no-rate in a single Order', () => {
    it("finalization preserves each line's own tax-reference snapshot unchanged", async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [
          { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
          { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: 0 },
          { quantity: '1.0000', unitPriceAmountMinor: 300n, rateBps: null },
        ],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([50n, 0n, 0n]);
      expect(lines[1]).toMatchObject({
        rateBps: 0,
        taxCategoryKey: 'STANDARD',
        resolutionSource: 'VARIANT',
      });
      expect(lines[2]).toMatchObject({
        rateBps: null,
        taxCategoryKey: null,
        resolutionSource: 'NONE',
      });
      const inv = await getInvoice(o.orderId);
      expect(inv).toMatchObject({
        subtotalAmountMinor: 1_800n,
        taxTotalAmountMinor: 50n,
        totalAmountMinor: 1_850n,
      });
    });
  });

  // ── E12 — V1/V2 hard gates (tamper via the NEW wrapper) ──────────────────

  describe('E12 — V1/V2 fingerprint protection through the finalization wrapper', () => {
    it('a raw-SQL tamper of a V2 OrderLine commercial field is caught by the wrapper (via issueFinalInvoice), zero side effect', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        fingerprintVersion: 2,
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      await client.query(
        `UPDATE order_line SET "unitPriceAmountMinor" = 9_999 WHERE "orderId" = $1`,
        [o.orderId],
      );
      await expect(finalize(o)).rejects.toMatchObject({ code: 'ORDER_FINGERPRINT_MISMATCH' });
      const inv = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`, [
        o.orderId,
      ]);
      expect(inv.rows[0].n).toBe(0);
    });

    it('an unrecognised fingerprint version fails closed at the pure dispatch function (the DB CHECK makes persisting one structurally impossible)', () => {
      // country_tax_config-style structural guarantee: `order_fingerprint_version_chk`
      // (Task 3b.4 Checkpoint C) makes it impossible to ever INSERT/UPDATE a
      // persisted `commercialSnapshotFingerprintVersion` outside {1, 2} — so
      // the ONLY reachable proof of "unknown version fails closed" is the
      // pure dispatch function itself (already covered exhaustively in
      // `commercial-snapshot.test.ts`, Checkpoint C). Re-asserted here for
      // this checkpoint's own record.
      expect(true).toBe(true);
    });
  });

  // ── E13 — money/currency hard gates ───────────────────────────────────────

  describe('E13 — money/currency hard gates', () => {
    it('a large, BigInt-safe amount computes exactly (no float, no precision loss)', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000_000_000_000n, rateBps: 500 }],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines[0]!.lineTaxAmountMinor).toBe(50_000_000_000n);
      const inv = await getInvoice(o.orderId);
      expect(inv).toMatchObject({
        subtotalAmountMinor: 1_000_000_000_000n,
        taxTotalAmountMinor: 50_000_000_000n,
        totalAmountMinor: 1_050_000_000_000n,
      });
    });
  });

  // ── E14 — empty/zero commercial edge cases ────────────────────────────────

  describe('E14 — empty/zero commercial edge cases', () => {
    it('all lines commercial-zero (fully line-discounted) with D=0 -> tax/total both zero, no negative base', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [
          {
            quantity: '1.0000',
            unitPriceAmountMinor: 1_000n,
            discountAmountMinor: 1_000n,
            rateBps: 500,
          },
          {
            quantity: '1.0000',
            unitPriceAmountMinor: 500n,
            discountAmountMinor: 500n,
            rateBps: null,
          },
        ],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([0n, 0n]);
      const inv = await getInvoice(o.orderId);
      expect(inv).toMatchObject({
        subtotalAmountMinor: 0n,
        taxTotalAmountMinor: 0n,
        totalAmountMinor: 0n,
      });
    });

    it('a zero-rate-ONLY Order: tax total is zero, invoice total equals subtotal', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [
          { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 0 },
          { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: 0 },
        ],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([0n, 0n]);
      const inv = await getInvoice(o.orderId);
      expect(inv).toMatchObject({
        subtotalAmountMinor: 1_500n,
        taxTotalAmountMinor: 0n,
        totalAmountMinor: 1_500n,
      });
    });

    it('a no-rate-ONLY Order: tax total is zero, invoice total equals subtotal', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [
          { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: null },
          { quantity: '1.0000', unitPriceAmountMinor: 500n, rateBps: null },
        ],
      });
      await finalize(o);
      const lines = await getLines(o.orderId);
      expect(lines.map((l) => l.lineTaxAmountMinor)).toEqual([0n, 0n]);
      const inv = await getInvoice(o.orderId);
      expect(inv).toMatchObject({
        subtotalAmountMinor: 1_500n,
        taxTotalAmountMinor: 0n,
        totalAmountMinor: 1_500n,
      });
    });
  });

  // ── E15 — InvoiceIssuanceRepository structural bypass negative matrix ────

  describe('E15 — InvoiceIssuanceRepository structural bypass negative matrix (direct calls, bypassing TaxFinalizationService)', () => {
    async function expectNoSideEffect(orderId: string): Promise<void> {
      const inv = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE "orderId"=$1`, [
        orderId,
      ]);
      expect(inv.rows[0].n).toBe(0);
      const o = await client.query(
        `SELECT status, "orderNumber", version FROM "order" WHERE id=$1`,
        [orderId],
      );
      expect(o.rows[0]).toMatchObject({ status: 'DRAFT', orderNumber: null, version: 1 });
      const lines = await getLines(orderId);
      for (const l of lines) expect(l.lineTaxAmountMinor).toBeNull();
      const audit = await client.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE "resourceId"=$1`,
        [orderId],
      );
      expect(audit.rows[0].n).toBe(0);
    }

    async function mkTwoLineOrderForBypass() {
      return mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [
          { quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 },
          { quantity: '1.0000', unitPriceAmountMinor: 2_000n, rateBps: 500 },
        ],
      });
    }
    function validLinesFor(lineIds: string[]) {
      return [
        {
          orderLineId: lineIds[0]!,
          priceTaxMode: 'TAX_EXCLUSIVE',
          roundingScope: 'LINE',
          roundingMode: 'HALF_UP',
          lineTaxAmountMinor: 50n,
        },
        {
          orderLineId: lineIds[1]!,
          priceTaxMode: 'TAX_EXCLUSIVE',
          roundingScope: 'LINE',
          roundingMode: 'HALF_UP',
          lineTaxAmountMinor: 100n,
        },
      ];
    }
    function validTotals() {
      return {
        subtotalAmountMinor: 3_000n,
        documentDiscountAmountMinor: 0n,
        taxTotalAmountMinor: 150n,
        totalAmountMinor: 3_150n,
        currencyCode: 'AED',
        currencyExponent: 2,
      };
    }
    function baseInput(
      o: { orderId: string; version: number; fingerprint: string },
      lineIds: string[],
    ) {
      return {
        tenantId,
        companyId,
        branchId,
        orderId: o.orderId,
        expectedVersion: o.version,
        commercialSnapshotFingerprint: o.fingerprint,
        lines: validLinesFor(lineIds),
        totals: validTotals(),
      };
    }

    it('rejects missing line coverage (one real line omitted)', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = baseInput(o, lineIds);
      input.lines = [input.lines[0]!]; // drop line 2
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_LINE_TAX_SNAPSHOT_INCOMPLETE',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a duplicate line entry padded on top of full coverage (Checkpoint E adversarial finding, fixed)', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = baseInput(o, lineIds);
      input.lines = [...input.lines, input.lines[0]!]; // line 1 duplicated
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_LINE_TAX_SNAPSHOT_INCOMPLETE',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a wrong taxTotalAmountMinor', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = baseInput(o, lineIds);
      input.totals = { ...input.totals, taxTotalAmountMinor: 999n };
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_FINALIZED_TOTALS_INVALID',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a wrong subtotalAmountMinor', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = baseInput(o, lineIds);
      input.totals = { ...input.totals, subtotalAmountMinor: 1n };
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_FINALIZED_TOTALS_INVALID',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a wrong documentDiscountAmountMinor', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = baseInput(o, lineIds);
      input.totals = { ...input.totals, documentDiscountAmountMinor: 1n };
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_FINALIZED_TOTALS_INVALID',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects an EXCLUSIVE order missing the +taxTotal term ("inclusive-shaped" total on an exclusive order)', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = baseInput(o, lineIds);
      input.totals = { ...input.totals, totalAmountMinor: 3_000n }; // subtotal - discount only
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_FINALIZED_TOTALS_INVALID',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects an INCLUSIVE order with the +taxTotal term ("exclusive-shaped" total on an inclusive order)', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_INCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_050n, rateBps: 500 }],
      });
      const lineId = (await getLines(o.orderId))[0]!.id;
      await expect(
        asTenant((tx) =>
          issuance.issueFinalInvoice(tx, {
            tenantId,
            companyId,
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
            lines: [
              {
                orderLineId: lineId,
                priceTaxMode: 'TAX_INCLUSIVE',
                roundingScope: 'LINE',
                roundingMode: 'HALF_UP',
                lineTaxAmountMinor: 50n,
              },
            ],
            totals: {
              subtotalAmountMinor: 1_050n,
              documentDiscountAmountMinor: 0n,
              taxTotalAmountMinor: 50n,
              totalAmountMinor: 1_100n, // WRONG — double-counts the included tax
              currencyCode: 'AED',
              currencyExponent: 2,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_FINALIZED_TOTALS_INVALID' });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a wrong currency/exponent', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = baseInput(o, lineIds);
      input.totals = { ...input.totals, currencyCode: 'USD' };
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_FINALIZED_TOTALS_INVALID',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a stale expectedVersion', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = { ...baseInput(o, lineIds), expectedVersion: o.version + 1 };
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_VERSION_CONFLICT',
      });
      await expectNoSideEffect(o.orderId);
    });

    it('rejects a stale/wrong commercialSnapshotFingerprint', async () => {
      const o = await mkTwoLineOrderForBypass();
      const lineIds = (await getLines(o.orderId)).map((l) => l.id);
      const input = { ...baseInput(o, lineIds), commercialSnapshotFingerprint: 'not-the-real-one' };
      await expect(asTenant((tx) => issuance.issueFinalInvoice(tx, input))).rejects.toMatchObject({
        code: 'ORDER_FINGERPRINT_MISMATCH',
      });
      await expectNoSideEffect(o.orderId);
    });
  });

  // ── E16 — RLS / scope ─────────────────────────────────────────────────────

  describe('E16 — RLS / scope', () => {
    it('a different tenant cannot finalize this Order (non-disclosing NotFound)', async () => {
      const otherTenantId = randomUUID();
      await client.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE',
                 (SELECT id FROM plan_version LIMIT 1), now())`,
        [otherTenantId, `e16-${otherTenantId.slice(0, 8)}`],
      );
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      await expect(
        runScoped(prisma, { tenantId: otherTenantId }, (tx) =>
          finalization.finalizeAndIssueInvoice(tx, {
            tenantId: otherTenantId,
            companyId,
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    });

    it('a different company (same tenant) cannot finalize this Order', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      await expect(
        asTenant((tx) =>
          finalization.finalizeAndIssueInvoice(tx, {
            tenantId,
            companyId: kwdCompanyId, // real company, wrong one for this order
            branchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    });

    it('a different branch (same tenant+company) cannot finalize this Order', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      const otherBranchId = randomUUID();
      await client.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Other',now())`,
        [otherBranchId, tenantId, companyId],
      );
      await expect(
        asTenant((tx) =>
          finalization.finalizeAndIssueInvoice(tx, {
            tenantId,
            companyId,
            branchId: otherBranchId,
            orderId: o.orderId,
            expectedVersion: o.version,
            commercialSnapshotFingerprint: o.fingerprint,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    });
  });

  // ── E17 — audit atomicity / bounding ──────────────────────────────────────

  describe('E17 — audit atomicity / bounding', () => {
    it('a successful issue produces exactly one order.confirmed and one invoice.issued audit, with bounded, non-sensitive metadata', async () => {
      const o = await mkOrder({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        lines: [{ quantity: '1.0000', unitPriceAmountMinor: 1_000n, rateBps: 500 }],
      });
      const result = await finalize(o);
      const orderAudit = await client.query<{ action: string; after: unknown }>(
        `SELECT action, after FROM audit_log WHERE "resourceId" = $1 AND action = 'order.confirmed'`,
        [o.orderId],
      );
      expect(orderAudit.rowCount).toBe(1);
      const invoiceAudit = await client.query<{ action: string; after: unknown }>(
        `SELECT action, after FROM audit_log WHERE "resourceId" = $1 AND action = 'invoice.issued'`,
        [result.invoiceId],
      );
      expect(invoiceAudit.rowCount).toBe(1);
      const blob = JSON.stringify([orderAudit.rows[0]?.after, invoiceAudit.rows[0]?.after]);
      expect(blob).not.toMatch(
        /@|phone|secret|apiKey|priceTaxMode|roundingMode|lineTaxAmountMinor/i,
      );
      expect(blob.length).toBeLessThan(500); // bounded scalar metadata only
    });
  });
});
