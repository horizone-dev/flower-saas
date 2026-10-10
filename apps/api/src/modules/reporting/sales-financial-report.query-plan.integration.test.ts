import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { DbService, type BackendConfig } from '@flower/backend';
// White-box measurement test: it generates a disposable dataset and EXPLAINs the real statement —
// not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient } from '@flower/db';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import {
  SalesFinancialReportRepository,
  type SalesFinancialBranchReport,
  type SalesFinancialCompanyReport,
} from './sales-financial-report.repository.js';
import {
  buildSalesFinancialReportQuery,
  type SalesFinancialReportJson,
} from './sales-financial-report.sql.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import { verifyInvoiceLineSets } from './sales-invoice-line-set-proof.js';
import { SALES_REPORT_MAX_DAYS } from './sales-report-range.js';

/**
 * Task 3b.10 Checkpoint B — the SALES FINANCIAL REPORT query-plan / volume gate (owner ruling OD-3).
 *
 * Unlike the Trial Balance this report is PERIOD-ONLY: it is anchored on the sealed journals of the four
 * frozen financial source kinds inside `[from, to]`, so the question is whether a longer period costs
 * proportionally more (a cap would then help) and whether the joins into the source documents stay on
 * their primary keys / indexes. The REAL statement (`buildSalesFinancialReportQuery`, the exact text the
 * repository runs) is EXPLAINed (ANALYZE, BUFFERS) through the real RLS role on a disposable
 * chronological multi-branch ledger that also holds the non-sales entries a real ledger carries (payment
 * allocations) plus other companies and another tenant.
 *
 * Size is configurable so the same file is both a fast CI guard and a one-off measurement:
 *   SALES_VOLUME_INVOICES   invoices of the TARGET company            (default 12 000)
 *   SALES_DAYS              days of history they span                 (default 1 095 ≈ 3 years)
 *   SALES_BRANCHES          branches of the target company            (default 4)
 *   SALES_NOISE_MULTIPLIER  other companies' invoices as a multiple   (default 0.5)
 *   SALES_PLAN_METRICS_FILE when set, plans / timings are written there as JSON
 *
 * Assertions are about CORRECTNESS (the report equals an independent oracle at volume) and PATHOLOGY (no
 * nested loop that seq-scans a document table once per outer row) — NOT wall-clock speed. Timings are
 * observations of a LOCAL TEST CONTAINER, not a production SLA.
 */
const INVOICES = Number(process.env['SALES_VOLUME_INVOICES'] ?? 12_000);
const DAYS = Number(process.env['SALES_DAYS'] ?? 1_095);
const BRANCHES = Number(process.env['SALES_BRANCHES'] ?? 4);
const NOISE = Number(process.env['SALES_NOISE_MULTIPLIER'] ?? 0.5);
const METRICS_FILE = process.env['SALES_PLAN_METRICS_FILE'];
const START = '2023-01-01';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'CTE Name'?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Workers Launched'?: number;
  Plans?: PlanNode[];
}
interface ExplainDoc {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
}
const flatten = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) flatten(c, out);
  return out;
};

describe('Sales Financial Report — query-plan / volume gate (task 3b.10 Checkpoint B)', () => {
  let stack: TestStack;
  let db: DbService;
  let prisma: PrismaClient;
  let repo: SalesFinancialReportRepository;
  let admin: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };

  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const company = randomUUID();
  const branchIds = Array.from({ length: BRANCHES }, () => randomUUID());
  const metrics: Record<string, unknown> = {};
  const dayAt = (n: number): Promise<string> =>
    admin
      .query(`SELECT (DATE '${START}' + $1::int)::text AS d`, [n])
      .then((r) => r.rows[0]!['d'] as string);

  async function seedCompany(args: {
    tenantId: string;
    companyId: string;
    branches: string[];
    invoices: number;
  }): Promise<void> {
    await admin.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Volume Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
      [args.companyId, args.tenantId],
    );
    for (const b of args.branches) {
      await admin.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'B',now())`,
        [b, args.tenantId, args.companyId],
      );
    }
    const acct: Record<string, string> = {};
    for (const [key, category, code, name] of [
      ['ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash'],
      ['ASSET.ACCOUNTS_RECEIVABLE', 'ASSET', '1300', 'AR'],
      ['LIABILITY.TAX_PAYABLE', 'LIABILITY', '2100', 'Tax'],
      ['REVENUE.SALES', 'REVENUE', '4000', 'Sales'],
      ['REVENUE.CANCELLATION_CHARGE', 'REVENUE', '4100', 'CC'],
    ] as const) {
      acct[key] = randomUUID();
      await admin.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [acct[key], args.tenantId, args.companyId, key, category, code, name],
      );
    }
    const periodId = randomUUID();
    await admin.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'${START}','2030-12-31','OPEN',now())`,
      [periodId, args.tenantId, args.companyId],
    );

    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      await admin.query(`DROP TABLE IF EXISTS sg`);
      // chronological documents (production data is inserted in date order); even i = customer (invoice_ar)
      await admin.query(
        `CREATE TEMP TABLE sg AS
           SELECT gs AS i, gen_random_uuid() AS id, gen_random_uuid() AS order_id, gen_random_uuid() AS entry_id,
                  (DATE '${START}' + (((gs - 1)::bigint * $2::bigint) / $1::bigint)::int) AS d,
                  (1000 + (gs % 977))::bigint AS base,
                  ((1000 + (gs % 977)) / 20)::bigint AS tax,
                  ($3::uuid[])[1 + (gs % $4::int)] AS branch_id,
                  CASE WHEN gs % 2 = 0 THEN 'invoice_ar' ELSE 'walk_in_sale' END AS kind,
                  (ARRAY['SETTLED','PAID','UNPAID','PARTIAL','CANCELLED'])[1 + (gs % 5)] AS status
             FROM generate_series(1, $1::int) gs`,
        [args.invoices, DAYS, args.branches, args.branches.length],
      );
      await admin.query(
        `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
                              "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
                              "taxTotalAmountMinor","totalAmountMinor","invoicePaymentStatus")
         SELECT g.id, $1::uuid, $2::uuid, g.branch_id, g.order_id, 'INV-' || g.i, g.d::timestamptz, g.d,
                'AED', 2, g.base, CASE WHEN g.i % 7 = 0 THEN 50 ELSE 0 END, g.tax, g.base + g.tax, g.status
           FROM sg g`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent",
                              "documentDiscountMode","documentDiscountAmountMinor","orderNumber","commercialSnapshotFingerprint",
                              "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
         SELECT g.order_id, $1::uuid, $2::uuid, g.branch_id, g.branch_id, 'WALK_IN', 'CONFIRMED', 'AED', 2,
                'NONE', 0, 'ORD-' || g.i, repeat('0', 64), 2, 'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', now()
           FROM sg g`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO order_line (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
                                 "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
                                 "discountMode","discountAmountMinor","resolutionSource",
                                 "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
                                 "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.order_id, p.pos, gen_random_uuid(), gen_random_uuid(), 1,
                g.base, 'AED', 2, CASE WHEN p.pos = 1 AND g.i % 5 = 0 THEN 'AMOUNT' ELSE 'NONE' END,
                CASE WHEN p.pos = 1 AND g.i % 5 = 0 THEN 10 ELSE 0 END, 'NONE',
                'piece','Piece','piece',1,1,'Rose','Rose',now()
           FROM sg g CROSS JOIN LATERAL (VALUES (1),(2)) AS p(pos)`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT g.entry_id, $1::uuid, $2::uuid, $3::uuid, g.d, g.kind, g.id::text, 'AED', 'fp', now() FROM sg g`,
        [args.tenantId, args.companyId, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.entry_id, v.account_id, g.branch_id, v.dr, v.cr
           FROM sg g CROSS JOIN LATERAL (VALUES
             (CASE WHEN g.kind = 'invoice_ar' THEN $3::uuid ELSE $4::uuid END, g.base + g.tax, 0::bigint),
             ($5::uuid, 0::bigint, g.base),
             ($6::uuid, 0::bigint, g.tax)) AS v(account_id, dr, cr)`,
        [
          args.tenantId,
          args.companyId,
          acct['ASSET.ACCOUNTS_RECEIVABLE'],
          acct['ASSET.CASH_ON_HAND'],
          acct['REVENUE.SALES'],
          acct['LIABILITY.TAX_PAYABLE'],
        ],
      );
      // every customer invoice has its receivable (the revenue-kind consistency check probes it)
      await admin.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), 'INVOICE', g.id, true FROM sg g WHERE g.kind = 'invoice_ar'`,
        [args.tenantId, args.companyId],
      );
      // the NON-sales entries a real ledger carries between the sales ones (the sel filter must skip them)
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, g.d, 'payment_allocation', gen_random_uuid()::text, 'AED', 'fp', now()
           FROM sg g WHERE g.kind = 'invoice_ar'`,
        [args.tenantId, args.companyId, periodId],
      );
      // credit notes (5 %) with their journal; cancellation charges (2 %) with theirs
      await admin.query(`DROP TABLE IF EXISTS sc`);
      await admin.query(
        `CREATE TEMP TABLE sc AS
           SELECT g.*, gen_random_uuid() AS cn_id, gen_random_uuid() AS cn_entry FROM sg g WHERE g.kind = 'invoice_ar' AND g.i % 10 = 0`,
      );
      await admin.query(
        `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate",
                                  "currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor",
                                  "totalAmountMinor","arReductionMinor","advanceExcessMinor")
         SELECT c.cn_id, $1::uuid, $2::uuid, c.branch_id, c.id, 'CN-' || c.i, c.d::timestamptz, c.d + 1, 'AED', 2,
                'CUSTOMER_REQUEST', c.base, c.tax, c.base + c.tax, c.base + c.tax, 0 FROM sc c`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT c.cn_entry, $1::uuid, $2::uuid, $3::uuid, c.d + 1, 'credit_note', c.cn_id::text, 'AED', 'fp', now() FROM sc c`,
        [args.tenantId, args.companyId, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, c.cn_entry, v.account_id, c.branch_id, v.dr, v.cr
           FROM sc c CROSS JOIN LATERAL (VALUES
             ($4::uuid, c.base, 0::bigint), ($5::uuid, c.tax, 0::bigint), ($3::uuid, 0::bigint, c.base + c.tax)) AS v(account_id, dr, cr)`,
        [
          args.tenantId,
          args.companyId,
          acct['ASSET.ACCOUNTS_RECEIVABLE'],
          acct['REVENUE.SALES'],
          acct['LIABILITY.TAX_PAYABLE'],
        ],
      );
      await admin.query(`DROP TABLE IF EXISTS sx`);
      await admin.query(
        `CREATE TEMP TABLE sx AS
           SELECT g.i, g.branch_id, g.d, g.order_id, gen_random_uuid() AS cc_id, gen_random_uuid() AS cc_entry
             FROM sg g WHERE g.i % 50 = 0`,
      );
      await admin.query(
        `INSERT INTO cancellation_charge (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber","netAmountMinor",
                                          "taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent","taxCategoryKey",
                                          "rateBps","priceTaxMode","roundingMode","reasonCode","accountingDate")
         SELECT x.cc_id, $1::uuid, $2::uuid, x.branch_id, x.order_id, 'CC-' || x.i, 400, 20, 420, 'AED', 2, 'STD3B3', 500,
                'TAX_EXCLUSIVE', 'HALF_UP', 'CUSTOMER_REQUEST', x.d FROM sx x`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT x.cc_entry, $1::uuid, $2::uuid, $3::uuid, x.d, 'cancellation_charge', x.cc_id::text, 'AED', 'fp', now() FROM sx x`,
        [args.tenantId, args.companyId, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, x.cc_entry, v.account_id, x.branch_id, v.dr, v.cr
           FROM sx x CROSS JOIN LATERAL (VALUES
             ($3::uuid, 420::bigint, 0::bigint), ($4::uuid, 0::bigint, 400::bigint), ($5::uuid, 0::bigint, 20::bigint)) AS v(account_id, dr, cr)`,
        [
          args.tenantId,
          args.companyId,
          acct['ASSET.ACCOUNTS_RECEIVABLE'],
          acct['REVENUE.CANCELLATION_CHARGE'],
          acct['LIABILITY.TAX_PAYABLE'],
        ],
      );
      await admin.query(`DROP TABLE sg; DROP TABLE sc; DROP TABLE sx`);
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  /**
   * The target company's orders get their REAL commercial fingerprint, computed HERE — independently of the
   * report's own proof — with the production fingerprint function over the rows exactly as stored, so the
   * report's line-set proof runs end to end on volume data and must pass. (Noise companies keep placeholders;
   * they are never reported.) Run with the triggers off: the freeze trigger forbids changing a fingerprint.
   */
  async function fingerprintOrders(tenantId: string, companyId: string): Promise<void> {
    const BATCH = 5_000;
    let after = '00000000-0000-0000-0000-000000000000';
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      for (;;) {
        const orders = await admin.query(
          `SELECT id, "originBranchId" AS origin, "fulfillingBranchId" AS fulfilling FROM "order"
            WHERE "tenantId" = $1 AND "companyId" = $2 AND id > $3 ORDER BY id LIMIT $4`,
          [tenantId, companyId, after, BATCH],
        );
        if (orders.rows.length === 0) break;
        const ids = orders.rows.map((r) => r['id'] as string);
        const lines = await admin.query(
          `SELECT "orderId" AS oid, "productId" AS product, "variantId" AS variant, quantity::text AS quantity,
                  "selectedUomCode" AS uom, "baseUomCode" AS base, "conversionNumerator"::text AS cn,
                  "conversionDenominator"::text AS cd, "unitPriceAmountMinor"::text AS price,
                  "unitPriceCurrencyCode" AS cur, "unitPriceCurrencyExponent" AS expo, "discountMode" AS dmode,
                  "discountBps" AS dbps, "discountAmountMinor"::text AS disc, "taxCategoryKey" AS tcat,
                  "rateBps" AS rate, to_char("effectiveFrom", 'YYYY-MM-DD') AS eff, "resolutionSource" AS src
             FROM order_line WHERE "orderId" = ANY($1::uuid[]) ORDER BY "orderId", "linePosition"`,
          [ids],
        );
        const byOrder = new Map<string, Record<string, unknown>[]>();
        for (const l of lines.rows) {
          const k = l['oid'] as string;
          (byOrder.get(k) ?? byOrder.set(k, []).get(k)!).push(l);
        }
        const fps = orders.rows.map((o) =>
          computeCommercialSnapshotFingerprintV2(
            {
              tenantId,
              companyId,
              originBranchId: o['origin'] as string,
              fulfillingBranchId: o['fulfilling'] as string,
              customerId: null,
              kind: 'WALK_IN',
              currencyCode: 'AED',
              lines: (byOrder.get(o['id'] as string) ?? []).map((l) => ({
                productId: l['product'] as string,
                variantId: l['variant'] as string,
                quantity: l['quantity'] as string,
                selectedUomCode: l['uom'] as string,
                baseUomCode: l['base'] as string,
                conversionNumerator: l['cn'] as string,
                conversionDenominator: l['cd'] as string,
                unitPriceAmountMinor: l['price'] as string,
                unitPriceCurrencyCode: l['cur'] as string,
                unitPriceCurrencyExponent: l['expo'] as number,
                discountMode: l['dmode'] as string,
                discountBps: l['dbps'] as number | null,
                discountAmountMinor: l['disc'] as string,
                taxCategoryKey: l['tcat'] as string | null,
                rateBps: l['rate'] as number | null,
                effectiveFrom: l['eff'] as string | null,
                resolutionSource: l['src'] as string,
              })),
              documentDiscountMode: 'NONE',
              documentDiscountBps: null,
              documentDiscountAmountMinor: '0',
              documentDiscountReason: null,
            },
            { taxPriceMode: 'TAX_EXCLUSIVE', taxRoundingScope: 'LINE', taxRoundingMode: 'HALF_UP' },
          ),
        );
        await admin.query(
          `UPDATE "order" o SET "commercialSnapshotFingerprint" = v.fp
             FROM unnest($1::uuid[], $2::text[]) AS v(id, fp) WHERE o.id = v.id`,
          [ids, fps],
        );
        after = ids[ids.length - 1]!;
      }
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();
    repo = new SalesFinancialReportRepository(db);
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    admin = { query: (sql, params) => c.query(sql, params as unknown[]), end: () => c.end() };

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await admin.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `sv-plan-${planId.slice(0, 8)}`,
    ]);
    await admin.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const t of [tenant, otherTenant]) {
      await admin.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [t, `sv-${t.slice(0, 8)}`, planVersionId],
      );
    }
    await admin.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel","defaultTimezone","updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN','Asia/Dubai',now()) ON CONFLICT (code) DO NOTHING`,
    );
    const noise = Math.max(1, Math.floor((INVOICES * NOISE) / 3));
    for (const [t, co, branches, invoices] of [
      [tenant, company, branchIds, INVOICES],
      [tenant, randomUUID(), [randomUUID(), randomUUID()], noise],
      [otherTenant, randomUUID(), [randomUUID(), randomUUID()], noise],
      [otherTenant, randomUUID(), [randomUUID()], noise],
    ] as const) {
      await seedCompany({ tenantId: t, companyId: co, branches: [...branches], invoices });
    }
    await fingerprintOrders(tenant, company);
    await admin.query(
      'VACUUM (ANALYZE) invoice, "order", order_line, journal_entry, journal_line, credit_note, cancellation_charge, customer_receivable, account',
    );
    const counts = await admin.query(
      `SELECT (SELECT count(*) FROM invoice)::text AS invoices, (SELECT count(*) FROM journal_entry)::text AS entries,
              (SELECT count(*) FROM journal_line)::text AS lines, (SELECT count(*) FROM order_line)::text AS order_lines,
              (SELECT count(*) FROM credit_note)::text AS credit_notes, (SELECT count(*) FROM cancellation_charge)::text AS charges`,
    );
    metrics['dataset'] = {
      targetInvoices: INVOICES,
      branches: BRANCHES,
      historyDays: DAYS,
      noiseMultiplier: NOISE,
      totals: counts.rows[0],
      targetShareOfInvoices: `${((INVOICES / Number(counts.rows[0]!['invoices'])) * 100).toFixed(1)}%`,
      note: 'disposable chronological dataset; ~half customer (invoice_ar) / half anonymous (walk_in_sale); 10% of customer invoices have a credit note, 2% of invoices a cancellation charge; non-sales payment_allocation entries interleaved',
    };
  }, 1_800_000);

  afterAll(async () => {
    if (METRICS_FILE) writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
    await admin?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId: tenant }), fn);

  type AnyReport = SalesFinancialCompanyReport | SalesFinancialBranchReport;
  const runReport = (from: string, to: string, branchId: string | null): Promise<AnyReport> =>
    inTenant<AnyReport>(() =>
      branchId === null
        ? repo.getCompanyReportScoped({ companyId: company, from, to })
        : repo.getBranchReportScoped({ companyId: company, branchId, from, to }),
    );

  /** the raw statement, run exactly as the repository runs it (no cap, no proof) — for the over-cap measurements */
  async function runStatement(from: string, to: string, branchId: string | null) {
    const q = buildSalesFinancialReportQuery({
      tenantId: tenant,
      companyId: company,
      from,
      to,
      branchId,
    });
    const t0 = performance.now();
    const rows = await runScoped(
      prisma,
      { tenantId: tenant },
      (tx) => tx.$queryRawUnsafe<{ report: string }[]>(q.text, ...q.values),
      { timeout: 1_700_000, maxWait: 60_000 },
    );
    const fetchMs = performance.now() - t0;
    const raw = rows[0]!.report;
    const t1 = performance.now();
    const json = JSON.parse(raw) as SalesFinancialReportJson;
    return { json, payloadBytes: raw.length, fetchMs, parseMs: performance.now() - t1 };
  }

  interface Figures {
    invoiceCount: number;
    total: bigint;
    tax: bigint;
    sub: bigint;
    dd: bigint;
    ld: bigint;
    cnCount: number;
    cnTotal: bigint;
    cnTax: bigint;
    ccCount: number;
    ccNet: bigint;
  }
  const figuresOfStatement = (j: SalesFinancialReportJson): Figures => {
    const sumOf = (pick: (b: SalesFinancialReportJson['branches'][number]) => string): bigint =>
      j.branches.reduce((n, b) => n + BigInt(pick(b)), 0n);
    return {
      invoiceCount: j.branches.reduce((n, b) => n + b.invoiceCount, 0),
      total: sumOf((b) => b.invoicedTotalMinor),
      tax: sumOf((b) => b.outputTaxMinor),
      sub: sumOf((b) => b.invoicedSubtotalMinor),
      dd: sumOf((b) => b.documentDiscountMinor),
      ld: sumOf((b) => b.lineDiscountMinor),
      cnCount: j.branches.reduce((n, b) => n + b.creditNoteCount, 0),
      cnTotal: sumOf((b) => b.creditNoteTotalMinor),
      cnTax: sumOf((b) => b.creditNoteTaxMinor),
      ccCount: j.branches.reduce((n, b) => n + b.cancellationChargeCount, 0),
      ccNet: sumOf((b) => b.cancellationChargeNetMinor),
    };
  };
  const figuresOfReport = (r: AnyReport): Figures => ({
    invoiceCount: r.invoices.invoiceCount,
    total: BigInt(r.invoices.invoicedTotalMinor),
    tax: BigInt(r.invoices.outputTaxMinor),
    sub: BigInt(r.invoices.invoicedSubtotalMinor),
    dd: BigInt(r.invoices.documentDiscountMinor),
    ld: BigInt(r.invoices.lineDiscountMinor),
    cnCount: r.creditNotes.creditNoteCount,
    cnTotal: BigInt(r.creditNotes.creditNoteTotalMinor),
    cnTax: BigInt(r.creditNotes.creditNoteTaxMinor),
    ccCount: r.cancellationCharges.cancellationChargeCount,
    ccNet: BigInt(r.cancellationCharges.cancellationChargeNetExTaxMinor),
  });

  async function explain(from: string, to: string, branchId: string | null): Promise<ExplainDoc> {
    const q = buildSalesFinancialReportQuery({
      tenantId: tenant,
      companyId: company,
      from,
      to,
      branchId,
    });
    const rows = await runScoped(
      prisma,
      { tenantId: tenant },
      (tx) =>
        tx.$queryRawUnsafe<{ 'QUERY PLAN': ExplainDoc[] }[]>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`,
          ...q.values,
        ),
      { timeout: 1_700_000, maxWait: 60_000 },
    );
    return rows[0]!['QUERY PLAN'][0]!;
  }

  /** an independent oracle: per-branch sums straight from the document tables, a different SQL path */
  async function oracle(from: string, to: string, branchId: string | null) {
    const filter = branchId === null ? '' : `AND x."branchId" = '${branchId}'`;
    const inv = await admin.query(
      `SELECT x."branchId" AS b, count(*)::text AS n, sum(x."totalAmountMinor")::text AS total, sum(x."taxTotalAmountMinor")::text AS tax,
              sum(x."subtotalAmountMinor")::text AS sub, sum(x."documentDiscountAmountMinor")::text AS dd,
              sum((SELECT COALESCE(SUM(ol."discountAmountMinor"),0) FROM order_line ol WHERE ol."tenantId" = x."tenantId" AND ol."companyId" = x."companyId" AND ol."orderId" = x."orderId"))::text AS ld
         FROM invoice x
         JOIN journal_entry je ON je."tenantId" = x."tenantId" AND je."companyId" = x."companyId" AND je."sourceId" = x.id::text
          AND je."sourceKind" IN ('invoice_ar','walk_in_sale') AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE x."companyId" = $1 ${filter} GROUP BY x."branchId"`,
      [company, from, to],
    );
    const cn = await admin.query(
      `SELECT x."branchId" AS b, count(*)::text AS n, sum(x."totalAmountMinor")::text AS total, sum(x."taxTotalAmountMinor")::text AS tax
         FROM credit_note x
         JOIN journal_entry je ON je."tenantId" = x."tenantId" AND je."companyId" = x."companyId" AND je."sourceId" = x.id::text
          AND je."sourceKind" = 'credit_note' AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE x."companyId" = $1 ${filter} GROUP BY x."branchId"`,
      [company, from, to],
    );
    const cc = await admin.query(
      `SELECT x."branchId" AS b, count(*)::text AS n, sum(x."netAmountMinor")::text AS net, sum(x."taxAmountMinor")::text AS tax
         FROM cancellation_charge x
         JOIN journal_entry je ON je."tenantId" = x."tenantId" AND je."companyId" = x."companyId" AND je."sourceId" = x.id::text
          AND je."sourceKind" = 'cancellation_charge' AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE x."companyId" = $1 ${filter} GROUP BY x."branchId"`,
      [company, from, to],
    );
    return { inv: inv.rows, cn: cn.rows, cc: cc.rows };
  }

  interface Scenario {
    name: string;
    from: () => Promise<string>;
    to: () => Promise<string>;
    branch?: boolean;
  }
  const last = DAYS - 1;
  const scenarios: Scenario[] = [
    { name: 'short: last 7 days', from: () => dayAt(last - 6), to: () => dayAt(last) },
    { name: 'short: last single day', from: () => dayAt(last), to: () => dayAt(last) },
    { name: 'medium: last 90 days', from: () => dayAt(last - 89), to: () => dayAt(last) },
    {
      name: 'year: last 365 days',
      from: () => dayAt(Math.max(0, last - 364)),
      to: () => dayAt(last),
    },
    { name: 'long: full history', from: () => dayAt(0), to: () => dayAt(last) },
    {
      name: 'mid-history 30 days',
      from: () => dayAt(Math.floor(DAYS / 2)),
      to: () => dayAt(Math.floor(DAYS / 2) + 29),
    },
    {
      name: 'branch slice: last 90 days',
      from: () => dayAt(last - 89),
      to: () => dayAt(last),
      branch: true,
    },
    {
      name: 'branch slice: full history',
      from: () => dayAt(0),
      to: () => dayAt(last),
      branch: true,
    },
  ];

  for (const s of scenarios) {
    it(`${s.name}: the report equals an independent oracle, reconciles, and the plan is not pathological`, async () => {
      const from = await s.from();
      const to = await s.to();
      const branchId = s.branch ? branchIds[1]! : null;

      await explain(from, to, branchId);
      const doc = await explain(from, to, branchId);
      const nodes = flatten(doc.Plan);
      const indexes = [
        ...new Set(nodes.map((n) => n['Index Name']).filter((x): x is string => !!x)),
      ];
      const rel = (name: string) => nodes.filter((n) => n['Relation Name'] === name);
      const access = (name: string) =>
        rel(name).map((n) => ({
          nodeType: n['Node Type'],
          actualRows: n['Actual Rows'],
          loops: n['Actual Loops'],
        }));

      // ── the STATEMENT itself, for EVERY window (the historical measurement is preserved) ──
      const days = Number(
        (await admin.query(`SELECT ($2::date - $1::date + 1)::int AS n`, [from, to])).rows[0]!['n'],
      );
      const capped = BigInt(days) > SALES_REPORT_MAX_DAYS;
      const st = await runStatement(from, to, branchId);

      // ── correctness at volume: the statement's figures equal an independent oracle ──
      const o = await oracle(from, to, branchId);
      const sum = (rows: Record<string, unknown>[], k: string): bigint =>
        rows.reduce((n, r) => n + BigInt(r[k] as string), 0n);
      const count = (rows: Record<string, unknown>[]): number =>
        rows.reduce((n, r) => n + Number(r['n']), 0);
      const expected: Figures = {
        invoiceCount: count(o.inv),
        total: sum(o.inv, 'total'),
        tax: sum(o.inv, 'tax'),
        sub: sum(o.inv, 'sub'),
        dd: sum(o.inv, 'dd'),
        ld: sum(o.inv, 'ld'),
        cnCount: count(o.cn),
        cnTotal: sum(o.cn, 'total'),
        cnTax: sum(o.cn, 'tax'),
        ccCount: count(o.cc),
        ccNet: sum(o.cc, 'net'),
      };
      expect(figuresOfStatement(st.json)).toEqual(expected);

      // ── the SERVICE PATH: refused beyond the cap, and — inside it — equal to the oracle with the proof passing ──
      let wallColdMs: number | null = null;
      let wallWarmMs: number | null = null;
      let proofMs: number | null = null;
      if (capped) {
        // the 90-day cap holds at volume: the repository refuses the period before it touches the database
        await expect(runReport(from, to, branchId)).rejects.toMatchObject({
          code: 'REPORT_RANGE_TOO_LARGE',
        });
      } else {
        const t0 = performance.now();
        const report = await runReport(from, to, branchId);
        wallColdMs = performance.now() - t0;
        const t1 = performance.now();
        await runReport(from, to, branchId);
        wallWarmMs = performance.now() - t1;
        expect(figuresOfReport(report)).toEqual(expected);
        expect(report.reconciliation.reconciled).toBe(true);
        // the line-set proof on VOLUME data: every order carries its real fingerprint, so every invoice proves itself
        const p0 = performance.now();
        const proof = verifyInvoiceLineSets(st.json.invoiceLineSets);
        proofMs = performance.now() - p0;
        expect(proof.mismatches).toBe(0);
        expect(st.json.invoiceLineSets.length).toBe(expected.invoiceCount);
        if (branchId === null) {
          const byBranch = (report as SalesFinancialCompanyReport).byBranch;
          expect(byBranch.length).toBeLessThanOrEqual(BRANCHES);
          expect(byBranch.reduce((n, b) => n + b.invoices.invoiceCount, 0)).toBe(
            report.invoices.invoiceCount,
          );
        }
      }
      const docsInWindow = expected.invoiceCount + expected.cnCount + expected.ccCount;
      // the full plan tree of the cap-sized window, for offline analysis of where the time goes
      if (s.name === 'medium: last 90 days') metrics['plan90Days'] = doc.Plan;

      (metrics['scenarios'] as unknown[] | undefined) ??= [];
      (metrics['scenarios'] as unknown[]).push({
        scenario: s.name,
        from,
        to,
        branchSlice: branchId !== null,
        sourceDocumentsInWindow: docsInWindow,
        calendarDays: days,
        beyondTheSales90DayCap: capped,
        repositoryRefusesIt: capped,
        statementFetchMs: Math.round(st.fetchMs),
        jsonParseMs: Math.round(st.parseMs),
        lineSetProofMs: proofMs === null ? null : Math.round(proofMs),
        payloadBytes: st.payloadBytes,
        invoiceLineSetsShipped: st.json.invoiceLineSets.length,
        planningTimeMs: doc['Planning Time'],
        explainExecutionTimeMs: doc['Execution Time'],
        serviceWallColdMs: wallColdMs === null ? null : Math.round(wallColdMs),
        serviceWallWarmMs: wallWarmMs === null ? null : Math.round(wallWarmMs),
        nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
        joinTypes: [...new Set(nodes.map((n) => n['Join Type']).filter((x): x is string => !!x))],
        indexesUsed: indexes,
        usesPostingDateIndex: indexes.includes('journal_entry_tenantId_companyId_postingDate_idx'),
        journalEntryAccess: access('journal_entry'),
        invoiceAccess: access('invoice'),
        orderAccess: access('order'),
        creditNoteAccess: access('credit_note'),
        orderLineAccess: access('order_line'),
        journalLineAccess: access('journal_line'),
        customerReceivableAccess: access('customer_receivable'),
        parallelWorkers: Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0)),
        sharedHitBlocks: doc.Plan['Shared Hit Blocks'],
        sharedReadBlocks: doc.Plan['Shared Read Blocks'],
      });

      // ── not pathological: no nested loop seq-scans a document table once PER OUTER ROW ──
      // (a parallel Seq Scan legitimately reports one "loop" per worker process, so allow for those)
      const maxProcesses = 1 + Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0));
      const DOC_TABLES = [
        'invoice',
        'credit_note',
        'cancellation_charge',
        'order',
        'order_line',
        'journal_line',
        'customer_receivable',
        'journal_entry',
      ];
      for (const n of nodes) {
        if (n['Node Type'] !== 'Nested Loop') continue;
        const inner = (n.Plans ?? [])[1];
        if (!inner) continue;
        for (const x of flatten(inner)) {
          const bad =
            x['Node Type'] === 'Seq Scan' &&
            DOC_TABLES.includes(x['Relation Name'] ?? '') &&
            (x['Actual Loops'] ?? 1) > maxProcesses;
          expect(bad, `a nested loop seq-scans ${x['Relation Name']} per outer row`).toBe(false);
        }
      }
      // …and no materialised CTE is re-scanned once per OUTER ROW: a nested loop over a `CTE Scan` is O(n²)
      // (a correlated per-BRANCH lookup legitimately loops a handful of times, a per-INVOICE one loops n times;
      // re-scanning a CTE of at most ONE row — the company row — per row is free)
      for (const n of nodes) {
        if (n['Node Type'] !== 'CTE Scan') continue;
        expect(
          (n['Actual Loops'] ?? 1) <= Math.max(50, BRANCHES * 4) || (n['Actual Rows'] ?? 0) <= 1,
          `CTE ${n['CTE Name']} is scanned once per outer row (${n['Actual Loops']} loops)`,
        ).toBe(true);
      }
      // the statement is anchored on the sealed journals of the period
      expect(rel('journal_entry').length).toBeGreaterThan(0);
    }, 1_700_000);
  }

  it('a narrow window is served by the postingDate index (the anchor), not a full scan of the ledger', async () => {
    // only meaningful when the window is a small fraction of the table; the 7-day / single-day scenarios are
    const narrow = (
      metrics['scenarios'] as { scenario: string; usesPostingDateIndex: boolean }[]
    ).filter((x) => x.scenario === 'short: last single day' || x.scenario === 'short: last 7 days');
    expect(narrow.length).toBe(2);
    expect(narrow.every((x) => x.usesPostingDateIndex)).toBe(true);
  });
});
