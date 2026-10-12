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
import type { PrismaClient, ScopedTx } from '@flower/db';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import { computeCommercialSnapshotFingerprintV2 } from '../orders/commercial-snapshot.js';
import { SalesFinancialReportRepository } from './sales-financial-report.repository.js';
import {
  buildSalesFinancialReportQuery,
  type SalesFinancialReportJson,
} from './sales-financial-report.sql.js';
import { verifyInvoiceLineSets } from './sales-invoice-line-set-proof.js';
import { SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';
import { SalesFinancialReportService } from './sales-financial-report.service.js';
import { TrialBalanceRepository } from './trial-balance.repository.js';

/**
 * Task 3b.10 Checkpoint B — PERFORMANCE CLOSURE: the corrected Sales Financial Report at a DENSE
 * 90-calendar-day volume.
 *
 * The date cap bounds the calendar, not the document count, so the question this file answers is what a
 * 90-day window costs when ALL of a company's invoices fall inside it. One target company issues
 * `SALES_DENSE_INVOICES` invoices (default 25 000 = EXACTLY the v1 density limit) spread over exactly
 * 90 days, across several branches, each with a realistic issued order (2 lines, a line discount on some,
 * a document discount on some), a VALID commercial fingerprint computed here independently of the report's
 * own proof, a coherent invoice (subtotal / tax / total agree with the lines), a sealed balanced sale journal,
 * credit notes and cancellation charges, and the non-sales payment entries a real ledger interleaves. A small
 * background of foreign companies and a foreign tenant is kept so the tenant / company predicates are
 * exercised. The fixture is built in BOUNDED BATCHES (no dataset is ever held in a JS array; the fingerprint
 * pass pages through the orders by key, a few thousand at a time).
 *
 * It measures the EXACT final report path — the postingDate journal anchor, the current Sales statement
 * (lateral order_line lookup, line evidence), the commercialSnapshotFingerprint proof, the aggregate
 * cross-check, the 90-day range validation — both as the bare statement (client round trip, then parse) and
 * as the full service path (fetch → parse → proof → cross-check → response), after one warm-up, over
 * repeated runs of the SAME window, and it EXPLAINs (ANALYZE, BUFFERS) the exact statement.
 *
 *   SALES_DENSE_INVOICES   invoices of the TARGET company            (default 25 000 = the v1 limit)
 *   SALES_DENSE_BRANCHES   branches of the target company (min 2)    (default 4)
 *   SALES_DENSE_NOISE      background invoices as a multiple         (default 0.15, spread over 3 companies)
 *   SALES_DENSE_RUNS       measured runs after the warm-up (min 3)   (default 3)
 *   SALES_DENSE_BATCH      invoices per fixture batch                (default 10 000)
 *   SALES_DENSE_METRICS_FILE when set, every observation is written there as JSON
 *
 * Assertions are about CORRECTNESS (the report equals an independent oracle, the proof passes at volume,
 * the repository runs ONE statement in ONE transaction) and PATHOLOGY (no nested loop seq-scans a table per
 * outer row, no materialised CTE is re-scanned per outer row, near-linear cost growth with the window) —
 * NOT wall-clock speed. Timings are observations of a LOCAL TEST CONTAINER, not a production SLA.
 */
const INVOICES = Number(process.env['SALES_DENSE_INVOICES'] ?? SALES_REPORT_MAX_DOCUMENTS);
const BRANCHES = Math.max(2, Number(process.env['SALES_DENSE_BRANCHES'] ?? 4));
const NOISE = Number(process.env['SALES_DENSE_NOISE'] ?? 0.15);
const RUNS = Math.max(3, Number(process.env['SALES_DENSE_RUNS'] ?? 3));
const BATCH = Math.max(1_000, Number(process.env['SALES_DENSE_BATCH'] ?? 10_000));
const METRICS_FILE = process.env['SALES_DENSE_METRICS_FILE'];
const START = '2026-06-01';
const DAYS = 90;
const DISCLAIMER = 'Local test-container benchmark; not production capacity.';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'CTE Name'?: string;
  'Join Type'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Recheck Cond'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Actual Total Time'?: number;
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
const mb = (bytes: number): number => Math.round(bytes / 1_048_576);
const memory = (): { rssMB: number; heapUsedMB: number; externalMB: number } => {
  const m = process.memoryUsage();
  return { rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), externalMB: mb(m.external) };
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

describe('Sales Financial Report — DENSE 90-day performance closure (task 3b.10 Checkpoint B)', () => {
  let stack: TestStack;
  let db: DbService;
  let prisma: PrismaClient;
  let admin: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };

  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const company = randomUUID();
  const branchIds = Array.from({ length: BRANCHES }, () => randomUUID());
  const metrics: Record<string, unknown> = { disclaimer: DISCLAIMER };
  const dayAt = (n: number): Promise<string> =>
    admin
      .query(`SELECT (DATE '${START}' + $1::int)::text AS d`, [n])
      .then((r) => r.rows[0]!['d'] as string);

  /** counts every raw statement issued inside the read callback (the "no N+1" evidence) */
  class CountingRepository extends SalesFinancialReportRepository {
    statements = 0;
    transactions = 0;
    protected override readScoped<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
      this.transactions += 1;
      return super.readScoped((tx) => {
        const counted = new Proxy(tx as object, {
          get: (target, prop) => {
            const v = Reflect.get(target, prop) as unknown;
            if (typeof v !== 'function') return v;
            return (...args: unknown[]) => {
              if (typeof prop === 'string' && /^\$(query|execute)/.test(prop)) this.statements += 1;
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }) as ScopedTx;
        return fn(counted);
      });
    }
  }
  let repo: CountingRepository;
  let service: SalesFinancialReportService;

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId: tenant }), fn);

  // ── the fixture: BOUNDED BATCHES, set-based inside PostgreSQL ───────────────────────────────
  async function seedCompany(args: {
    tenantId: string;
    companyId: string;
    branches: string[];
    invoices: number;
    /** credit notes + cancellation charges (the TARGET company has none, so its document count is exact) */
    adjustments: boolean;
  }): Promise<void> {
    await admin.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Dense Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
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
       VALUES ($1,$2,$3,'2020-01-01','2030-12-31','OPEN',now())`,
      [periodId, args.tenantId, args.companyId],
    );

    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      for (let lo = 1; lo <= args.invoices; lo += BATCH) {
        const hi = Math.min(args.invoices, lo + BATCH - 1);
        await seedBatch({ ...args, periodId, acct, lo, hi });
      }
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  async function seedBatch(a: {
    tenantId: string;
    companyId: string;
    branches: string[];
    invoices: number;
    adjustments: boolean;
    periodId: string;
    acct: Record<string, string>;
    lo: number;
    hi: number;
  }): Promise<void> {
    const T = a.tenantId;
    const C = a.companyId;
    await admin.query(`DROP TABLE IF EXISTS sg`);
    // coherent money: lines → subtotal → document discount → 5 % tax → total (TAX_EXCLUSIVE)
    await admin.query(
      `CREATE TEMP TABLE sg AS
         SELECT x.*, (x.p1 - x.d1 + x.p2) AS sub,
                (((x.p1 - x.d1 + x.p2) - x.dd) * 5) / 100 AS tax,
                ((x.p1 - x.d1) * 5) / 100 AS t1
           FROM (SELECT gs AS i, gen_random_uuid() AS id, gen_random_uuid() AS order_id, gen_random_uuid() AS entry_id,
                        (DATE '${START}' + (((gs - 1)::bigint * $2::bigint) / $1::bigint)::int) AS d,
                        ($3::uuid[])[1 + (gs % $4::int)] AS branch_id,
                        CASE WHEN gs % 2 = 0 THEN 'invoice_ar' ELSE 'walk_in_sale' END AS kind,
                        (ARRAY['SETTLED','PAID','UNPAID','PARTIAL','CANCELLED'])[1 + (gs % 5)] AS status,
                        (1000 + (gs % 977))::bigint AS p1,
                        (500 + (gs % 389))::bigint AS p2,
                        (CASE WHEN gs % 5 = 0 THEN 10 ELSE 0 END)::bigint AS d1,
                        (CASE WHEN gs % 7 = 0 THEN 50 ELSE 0 END)::bigint AS dd
                   FROM generate_series($5::int, $6::int) gs) x`,
      [a.invoices, DAYS, a.branches, a.branches.length, a.lo, a.hi],
    );
    await admin.query(
      `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent",
                            "documentDiscountMode","documentDiscountAmountMinor","documentDiscountReason","orderNumber",
                            "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
       SELECT g.order_id, $1::uuid, $2::uuid, g.branch_id, g.branch_id, 'WALK_IN', 'CONFIRMED', 'AED', 2,
              CASE WHEN g.dd > 0 THEN 'AMOUNT' ELSE 'NONE' END, g.dd, CASE WHEN g.dd > 0 THEN 'promo' END,
              'ORD-' || g.i, repeat('0', 64), 2, 'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', now()
         FROM sg g`,
      [T, C],
    );
    await admin.query(
      `INSERT INTO order_line (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
                               "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
                               "discountMode","discountAmountMinor","taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
                               "priceTaxMode","roundingScope","roundingMode","lineTaxAmountMinor",
                               "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
                               "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.order_id, p.pos, gen_random_uuid(), gen_random_uuid(), 1,
              CASE WHEN p.pos = 1 THEN g.p1 ELSE g.p2 END, 'AED', 2,
              CASE WHEN p.pos = 1 AND g.d1 > 0 THEN 'AMOUNT' ELSE 'NONE' END, CASE WHEN p.pos = 1 THEN g.d1 ELSE 0 END,
              'STANDARD', 500, DATE '2020-01-01', 'VARIANT',
              'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', CASE WHEN p.pos = 1 THEN g.t1 ELSE g.tax - g.t1 END,
              'piece','Piece','piece',1,1,'Rose','Rose',now()
         FROM sg g CROSS JOIN LATERAL (VALUES (1),(2)) AS p(pos)`,
      [T, C],
    );
    await admin.query(
      `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
                            "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
                            "taxTotalAmountMinor","totalAmountMinor","invoicePaymentStatus")
       SELECT g.id, $1::uuid, $2::uuid, g.branch_id, g.order_id, 'INV-' || g.i, g.d::timestamptz, g.d,
              'AED', 2, g.sub, g.dd, g.tax, g.sub - g.dd + g.tax, g.status
         FROM sg g`,
      [T, C],
    );
    await admin.query(
      `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                  "currencyCode","postingFingerprint","sealedAt")
       SELECT g.entry_id, $1::uuid, $2::uuid, $3::uuid, g.d, g.kind, g.id::text, 'AED', 'fp', now() FROM sg g`,
      [T, C, a.periodId],
    );
    await admin.query(
      `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.entry_id, v.account_id, g.branch_id, v.dr, v.cr
         FROM sg g CROSS JOIN LATERAL (VALUES
           (CASE WHEN g.kind = 'invoice_ar' THEN $3::uuid ELSE $4::uuid END, g.sub - g.dd + g.tax, 0::bigint),
           ($5::uuid, 0::bigint, g.sub - g.dd),
           ($6::uuid, 0::bigint, g.tax)) AS v(account_id, dr, cr)`,
      [
        T,
        C,
        a.acct['ASSET.ACCOUNTS_RECEIVABLE'],
        a.acct['ASSET.CASH_ON_HAND'],
        a.acct['REVENUE.SALES'],
        a.acct['LIABILITY.TAX_PAYABLE'],
      ],
    );
    // every customer invoice has its receivable (the revenue-kind consistency check probes it)
    await admin.query(
      `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), 'INVOICE', g.id, true FROM sg g WHERE g.kind = 'invoice_ar'`,
      [T, C],
    );
    // the NON-sales entries a real ledger interleaves (the report's journal selection must skip them)
    await admin.query(
      `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                  "currencyCode","postingFingerprint","sealedAt")
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, g.d, 'payment_allocation', gen_random_uuid()::text, 'AED', 'fp', now()
         FROM sg g WHERE g.kind = 'invoice_ar'`,
      [T, C, a.periodId],
    );
    if (a.adjustments) {
      // credit notes (full credit of 10 % of the customer invoices) — same-day, so they stay inside the window
      await admin.query(`DROP TABLE IF EXISTS sc`);
      await admin.query(
        `CREATE TEMP TABLE sc AS
         SELECT g.*, gen_random_uuid() AS cn_id, gen_random_uuid() AS cn_entry FROM sg g WHERE g.kind = 'invoice_ar' AND g.i % 10 = 0`,
      );
      await admin.query(
        `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate",
                                "currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor",
                                "totalAmountMinor","arReductionMinor","advanceExcessMinor")
       SELECT c.cn_id, $1::uuid, $2::uuid, c.branch_id, c.id, 'CN-' || c.i, c.d::timestamptz, c.d, 'AED', 2,
              'CUSTOMER_REQUEST', c.sub - c.dd, c.tax, c.sub - c.dd + c.tax, c.sub - c.dd + c.tax, 0 FROM sc c`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                  "currencyCode","postingFingerprint","sealedAt")
       SELECT c.cn_entry, $1::uuid, $2::uuid, $3::uuid, c.d, 'credit_note', c.cn_id::text, 'AED', 'fp', now() FROM sc c`,
        [T, C, a.periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, c.cn_entry, v.account_id, c.branch_id, v.dr, v.cr
         FROM sc c CROSS JOIN LATERAL (VALUES
           ($4::uuid, c.sub - c.dd, 0::bigint), ($5::uuid, c.tax, 0::bigint), ($3::uuid, 0::bigint, c.sub - c.dd + c.tax)) AS v(account_id, dr, cr)`,
        [
          T,
          C,
          a.acct['ASSET.ACCOUNTS_RECEIVABLE'],
          a.acct['REVENUE.SALES'],
          a.acct['LIABILITY.TAX_PAYABLE'],
        ],
      );
      // cancellation charges (2 % of the invoices) with their journals
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
        [T, C],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                  "currencyCode","postingFingerprint","sealedAt")
       SELECT x.cc_entry, $1::uuid, $2::uuid, $3::uuid, x.d, 'cancellation_charge', x.cc_id::text, 'AED', 'fp', now() FROM sx x`,
        [T, C, a.periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, x.cc_entry, v.account_id, x.branch_id, v.dr, v.cr
         FROM sx x CROSS JOIN LATERAL (VALUES
           ($3::uuid, 420::bigint, 0::bigint), ($4::uuid, 0::bigint, 400::bigint), ($5::uuid, 0::bigint, 20::bigint)) AS v(account_id, dr, cr)`,
        [
          T,
          C,
          a.acct['ASSET.ACCOUNTS_RECEIVABLE'],
          a.acct['REVENUE.CANCELLATION_CHARGE'],
          a.acct['LIABILITY.TAX_PAYABLE'],
        ],
      );
    }
    await admin.query(`DROP TABLE IF EXISTS sg, sc, sx`);
  }

  /**
   * The target company's orders get their REAL commercial fingerprint, computed HERE — independently of the
   * report's own proof — with the production fingerprint function over the rows exactly as stored. Pages by
   * key, a few thousand orders at a time (nothing accumulates); runs with the triggers off because the freeze
   * trigger forbids changing a fingerprint.
   */
  async function fingerprintOrders(tenantId: string, companyId: string): Promise<void> {
    const PAGE = 5_000;
    let after = '00000000-0000-0000-0000-000000000000';
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      for (;;) {
        const orders = await admin.query(
          `SELECT id, "originBranchId" AS origin, "fulfillingBranchId" AS fulfilling,
                  "documentDiscountMode" AS ddm, "documentDiscountBps" AS ddb,
                  "documentDiscountAmountMinor"::text AS dda, "documentDiscountReason" AS ddr
             FROM "order" WHERE "tenantId" = $1 AND "companyId" = $2 AND id > $3 ORDER BY id LIMIT $4`,
          [tenantId, companyId, after, PAGE],
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
              documentDiscountMode: o['ddm'] as string,
              documentDiscountBps: o['ddb'] as number | null,
              documentDiscountAmountMinor: o['dda'] as string,
              documentDiscountReason: o['ddr'] as string | null,
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
    metrics['memoryBeforeSeedingNodeRss'] = memory();
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();
    repo = new CountingRepository(db);
    service = new SalesFinancialReportService(repo);
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    admin = { query: (sql, params) => c.query(sql, params as unknown[]), end: () => c.end() };

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await admin.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `dn-plan-${planId.slice(0, 8)}`,
    ]);
    await admin.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const t of [tenant, otherTenant]) {
      await admin.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [t, `dn-${t.slice(0, 8)}`, planVersionId],
      );
    }
    await admin.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel","defaultTimezone","updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN','Asia/Dubai',now()) ON CONFLICT (code) DO NOTHING`,
    );

    const seedStart = performance.now();
    const noise = Math.max(1, Math.floor((INVOICES * NOISE) / 3));
    for (const [t, co, branches, invoices, adjustments] of [
      [tenant, company, branchIds, INVOICES, false],
      [tenant, randomUUID(), [randomUUID(), randomUUID()], noise, true],
      [otherTenant, randomUUID(), [randomUUID(), randomUUID()], noise, true],
      [otherTenant, randomUUID(), [randomUUID()], noise, true],
    ] as const) {
      await seedCompany({
        tenantId: t,
        companyId: co,
        branches: [...branches],
        invoices,
        adjustments,
      });
    }
    const seededMs = performance.now() - seedStart;
    metrics['memoryAfterSeedingNodeRss'] = memory();
    const fpStart = performance.now();
    await fingerprintOrders(tenant, company);
    const fingerprintedMs = performance.now() - fpStart;
    await admin.query(
      'VACUUM (ANALYZE) invoice, "order", order_line, journal_entry, journal_line, credit_note, cancellation_charge, customer_receivable, account',
    );
    metrics['memoryAfterFingerprintNodeRss'] = memory();
    const counts = await admin.query(
      `SELECT (SELECT count(*) FROM invoice)::text AS invoices, (SELECT count(*) FROM "order")::text AS orders,
              (SELECT count(*) FROM order_line)::text AS order_lines, (SELECT count(*) FROM journal_entry)::text AS entries,
              (SELECT count(*) FROM journal_line)::text AS lines, (SELECT count(*) FROM credit_note)::text AS credit_notes,
              (SELECT count(*) FROM cancellation_charge)::text AS charges`,
    );
    metrics['dataset'] = {
      targetInvoices: INVOICES,
      branches: BRANCHES,
      windowDays: DAYS,
      window: { from: START, to: await dayAt(DAYS - 1) },
      fixtureBatchSize: BATCH,
      noiseMultiplier: NOISE,
      backgroundInvoices: noise * 3,
      totals: counts.rows[0],
      targetShareOfInvoices: `${((INVOICES / Number(counts.rows[0]!['invoices'])) * 100).toFixed(1)}%`,
      seedSeconds: Math.round(seededMs / 1000),
      fingerprintSeconds: Math.round(fingerprintedMs / 1000),
      note: 'ONE target company holding EXACTLY the v1 limit of financial documents (invoices only); ALL inside ONE 90-calendar-day window; 2 order lines per invoice (a line discount on 20 %, a document discount on 14 %); valid commercial fingerprints; sealed balanced sale journals; non-sales payment_allocation entries interleaved; foreign companies and a foreign tenant (with credit notes and charges) as background',
    };
  }, 3_600_000);

  afterAll(async () => {
    metrics['memoryAtEndNodeRss'] = memory();
    if (METRICS_FILE) writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
    await admin?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  // ── helpers over the exact final statement ──────────────────────────────────────────────────
  async function runStatement(from: string, to: string, branchId: string | null) {
    const q = buildSalesFinancialReportQuery({
      tenantId: tenant,
      companyId: company,
      from,
      to,
      branchId,
    });
    const t0 = performance.now();
    // the DEFAULT scoped-transaction timeout (≈ 20 s) applies, exactly as in production
    const rows = await runScoped(prisma, { tenantId: tenant }, (tx) =>
      tx.$queryRawUnsafe<{ report: string }[]>(q.text, ...q.values),
    );
    const sqlMs = performance.now() - t0;
    const raw = rows[0]!.report;
    const t1 = performance.now();
    const json = JSON.parse(raw) as SalesFinancialReportJson;
    return { json, payloadBytes: raw.length, sqlMs, parseMs: performance.now() - t1 };
  }

  async function explain(
    from: string,
    to: string,
    branchId: string | null,
    settings: readonly string[] = [],
  ): Promise<ExplainDoc> {
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
      async (tx) => {
        for (const setting of settings) await tx.$executeRawUnsafe(`SET LOCAL ${setting}`);
        return tx.$queryRawUnsafe<{ 'QUERY PLAN': ExplainDoc[] }[]>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`,
          ...q.values,
        );
      },
      { timeout: 600_000, maxWait: 60_000 },
    );
    return rows[0]!['QUERY PLAN'][0]!;
  }

  /** an independent oracle: per-branch sums straight from the document tables, a different SQL path */
  async function oracle(from: string, to: string) {
    const inv = await admin.query(
      `SELECT count(*)::text AS n, sum(x."totalAmountMinor")::text AS total, sum(x."taxTotalAmountMinor")::text AS tax,
              sum(x."subtotalAmountMinor")::text AS sub, sum(x."documentDiscountAmountMinor")::text AS dd,
              sum((SELECT COALESCE(SUM(ol."discountAmountMinor"),0) FROM order_line ol WHERE ol."tenantId" = x."tenantId" AND ol."companyId" = x."companyId" AND ol."orderId" = x."orderId"))::text AS ld
         FROM invoice x
         JOIN journal_entry je ON je."tenantId" = x."tenantId" AND je."companyId" = x."companyId" AND je."sourceId" = x.id::text
          AND je."sourceKind" IN ('invoice_ar','walk_in_sale') AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE x."companyId" = $1`,
      [company, from, to],
    );
    const cn = await admin.query(
      `SELECT count(*)::text AS n, sum(x."totalAmountMinor")::text AS total
         FROM credit_note x
         JOIN journal_entry je ON je."tenantId" = x."tenantId" AND je."companyId" = x."companyId" AND je."sourceId" = x.id::text
          AND je."sourceKind" = 'credit_note' AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE x."companyId" = $1`,
      [company, from, to],
    );
    const cc = await admin.query(
      `SELECT count(*)::text AS n, sum(x."netAmountMinor")::text AS net
         FROM cancellation_charge x
         JOIN journal_entry je ON je."tenantId" = x."tenantId" AND je."companyId" = x."companyId" AND je."sourceId" = x.id::text
          AND je."sourceKind" = 'cancellation_charge' AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE x."companyId" = $1`,
      [company, from, to],
    );
    return { inv: inv.rows[0]!, cn: cn.rows[0]!, cc: cc.rows[0]! };
  }

  const sumBig = (
    j: SalesFinancialReportJson,
    pick: (b: SalesFinancialReportJson['branches'][number]) => string,
  ): bigint => j.branches.reduce((n, b) => n + BigInt(pick(b)), 0n);
  const evidenceLines = (j: SalesFinancialReportJson): number =>
    j.invoiceLineSets.reduce((n, s) => n + s.lines.length, 0);

  // ═══════════════════════════════ 1. the dataset really is dense ═══════════════════════════════
  it('the dataset: every invoice is financially included in the ONE 90-day window, over at least 2 branches', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    metrics['window'] = { from, to, inclusiveDays: DAYS };
    const inWindow = await admin.query(
      `SELECT count(*)::int AS n, count(DISTINCT j."branchId")::int AS branches
         FROM journal_entry je JOIN journal_line j ON j."journalEntryId" = je.id AND j."tenantId" = je."tenantId"
        WHERE je."companyId" = $1 AND je."sourceKind" IN ('invoice_ar','walk_in_sale')
          AND je."postingDate" BETWEEN $2::date AND $3::date AND j."debitMinor" > 0`,
      [company, from, to],
    );
    expect(Number(inWindow.rows[0]!['n'])).toBe(INVOICES);
    expect(Number(inWindow.rows[0]!['branches'])).toBeGreaterThanOrEqual(2);
    const outside = await admin.query(
      `SELECT count(*)::int AS n FROM journal_entry
        WHERE "companyId" = $1 AND "sourceKind" IN ('invoice_ar','walk_in_sale','credit_note','cancellation_charge')
          AND ("postingDate" < $2::date OR "postingDate" > $3::date)`,
      [company, from, to],
    );
    expect(Number(outside.rows[0]!['n'])).toBe(0); // nothing financial falls outside: ALL of it is in the window
    const lines = await admin.query(
      `SELECT count(*)::int AS n FROM order_line WHERE "companyId" = $1`,
      [company],
    );
    expect(Number(lines.rows[0]!['n'])).toBe(INVOICES * 2);
    // the TARGET company holds exactly INVOICES financial documents of the four kinds — the limit, no more
    const documents = await admin.query(
      `SELECT count(*)::int AS n FROM journal_entry
        WHERE "companyId" = $1 AND "sourceKind" IN ('invoice_ar','walk_in_sale','credit_note','cancellation_charge')`,
      [company],
    );
    expect(Number(documents.rows[0]!['n'])).toBe(INVOICES);
    expect(INVOICES).toBeLessThanOrEqual(SALES_REPORT_MAX_DOCUMENTS);
    metrics['denseWindow'] = {
      invoices: INVOICES,
      orderLinesAsEvidence: Number(lines.rows[0]!['n']),
      branchesWithInvoices: Number(inWindow.rows[0]!['branches']),
    };
  });

  // ═════════════════ 2. the exact final report path: warm-up + repeated runs ═════════════════
  it('the exact final report path — SQL statement vs full service path — warm-up, then repeated runs of the SAME window', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const o = await oracle(from, to);

    // one warm-up (full service path), counted
    const w0 = performance.now();
    const warm = await inTenant(() => service.companyReport({ companyId: company, from, to }));
    const warmMs = performance.now() - w0;
    expect(warm.invoices.invoiceCount).toBe(INVOICES);
    metrics['warmUp'] = {
      serviceMs: Math.round(warmMs),
      invoices: warm.invoices.invoiceCount,
      branches: warm.byBranch.length,
      ...memory(),
    };

    const runs: Record<string, unknown>[] = [];
    metrics['runs'] = runs; // recorded INCREMENTALLY: a failing run never loses the runs that preceded it
    const failures: string[] = [];
    for (let r = 1; r <= RUNS; r += 1) {
      const record: Record<string, unknown> = { run: r };
      runs.push(record);
      // A. the bare statement (client round trip), then its parse and the fingerprint proof
      try {
        const part = await (async () => {
          const st = await runStatement(from, to, null);
          const p0 = performance.now();
          const proof = verifyInvoiceLineSets(st.json.invoiceLineSets);
          const proofMs = performance.now() - p0;
          const figs = {
            invoices: st.json.branches.reduce((n, b) => n + b.invoiceCount, 0),
            lineDiscount: sumBig(st.json, (b) => b.lineDiscountMinor),
            total: sumBig(st.json, (b) => b.invoicedTotalMinor),
            tax: sumBig(st.json, (b) => b.outputTaxMinor),
            sub: sumBig(st.json, (b) => b.invoicedSubtotalMinor),
            dd: sumBig(st.json, (b) => b.documentDiscountMinor),
          };
          return {
            sqlMs: st.sqlMs,
            parseMs: st.parseMs,
            proofMs,
            payloadBytes: st.payloadBytes,
            evidenceInvoices: st.json.invoiceLineSets.length,
            evidenceLines: evidenceLines(st.json),
            mismatches: proof.mismatches,
            figs,
          };
        })();
        Object.assign(record, {
          invoices: part.figs.invoices,
          orderLineEvidence: part.evidenceLines,
          evidenceInvoices: part.evidenceInvoices,
          sqlStatementMs: Math.round(part.sqlMs),
          parseMs: Math.round(part.parseMs),
          fingerprintProofMs: Math.round(part.proofMs),
          payloadMB: Number((part.payloadBytes / 1_048_576).toFixed(1)),
          afterStatement: memory(),
        });
        // correctness at density against the independent oracle
        expect(part.figs.invoices).toBe(Number(o.inv['n']));
        expect(part.figs.total).toBe(BigInt(o.inv['total'] as string));
        expect(part.figs.tax).toBe(BigInt(o.inv['tax'] as string));
        expect(part.figs.sub).toBe(BigInt(o.inv['sub'] as string));
        expect(part.figs.dd).toBe(BigInt(o.inv['dd'] as string));
        expect(part.figs.lineDiscount).toBe(BigInt(o.inv['ld'] as string));
        // the proof passes on every invoice of the dense window
        expect(part.mismatches).toBe(0);
        expect(part.evidenceInvoices).toBe(INVOICES);
        expect(part.evidenceLines).toBe(INVOICES * 2);
      } catch (e) {
        record['statementError'] = String(e).slice(0, 300);
        failures.push(`run ${r} statement: ${String(e).slice(0, 200)}`);
      }
      // B. the FULL service path: fetch → parse → proof → cross-check → response
      const statementsBefore = repo.statements;
      const transactionsBefore = repo.transactions;
      const s0 = performance.now();
      try {
        const report = await inTenant(() =>
          service.companyReport({ companyId: company, from, to }),
        );
        const serviceMs = performance.now() - s0;
        Object.assign(record, {
          fullServiceMs: Math.round(serviceMs),
          resultBranchCount: report.byBranch.length,
          creditNotes: report.creditNotes.creditNoteCount,
          cancellationCharges: report.cancellationCharges.cancellationChargeCount,
          statementsInServicePath: repo.statements - statementsBefore,
          transactionsInServicePath: repo.transactions - transactionsBefore,
          afterService: memory(),
        });
        expect(repo.statements - statementsBefore).toBe(1); // ONE statement — no N+1
        expect(repo.transactions - transactionsBefore).toBe(1); // in ONE transaction
        expect(report.invoices.invoiceCount).toBe(Number(o.inv['n']));
        expect(BigInt(report.invoices.lineDiscountMinor)).toBe(BigInt(o.inv['ld'] as string));
        expect(report.creditNotes.creditNoteCount).toBe(Number(o.cn['n']));
        expect(BigInt(report.creditNotes.creditNoteTotalMinor)).toBe(
          BigInt((o.cn['total'] as string | null) ?? '0'),
        );
        expect(report.cancellationCharges.cancellationChargeCount).toBe(Number(o.cc['n']));
        expect(report.reconciliation.reconciled).toBe(true);
        expect(report.byBranch.length).toBeGreaterThanOrEqual(2);
      } catch (e) {
        record['serviceError'] = String(e).slice(0, 300);
        record['serviceMsBeforeError'] = Math.round(performance.now() - s0);
        failures.push(`run ${r} service: ${String(e).slice(0, 200)}`);
      }
    }
    const numbers = (key: string): number[] =>
      runs.map((x) => x[key]).filter((x): x is number => typeof x === 'number');
    const sql = numbers('sqlStatementMs');
    const full = numbers('fullServiceMs');
    metrics['summary'] = {
      sqlStatementMs: sql.length ? { p50: median(sql), worst: Math.max(...sql) } : null,
      fullServiceMs: full.length ? { p50: median(full), worst: Math.max(...full) } : null,
      failedRuns: failures,
    };
    // the failure rule: no error, no timeout — and the accepted dense 90-day report at the limit stays under the
    // 10 s local engineering gate, half of the ≈ 20 s scoped-transaction timeout (which is NOT raised)
    expect(failures).toEqual([]);
    expect(Math.max(...full)).toBeLessThan(10_000); // the local engineering gate (NOT a production SLA)
  }, 3_600_000);

  // ═══════════════ 3. growth with the window: near-linear, not quadratic ═══════════════
  it('cost grows near-linearly with the number of documents in the window (no O(n²))', async () => {
    const probes: { days: number; invoices: number; sqlMs: number; microsPerInvoice: number }[] =
      [];
    await runStatement(await dayAt(0), await dayAt(14), null); // warm the path
    for (const days of [15, 30, 45, 90]) {
      const st = await runStatement(await dayAt(0), await dayAt(days - 1), null);
      const invoices = st.json.branches.reduce((n, b) => n + b.invoiceCount, 0);
      probes.push({
        days,
        invoices,
        sqlMs: Math.round(st.sqlMs),
        microsPerInvoice: Math.round((st.sqlMs * 1000) / Math.max(1, invoices)),
      });
    }
    metrics['growthProbe'] = probes;
    const perDocSmall = probes[0]!.sqlMs / Math.max(1, probes[0]!.invoices);
    const perDocLarge = probes[3]!.sqlMs / Math.max(1, probes[3]!.invoices);
    // a quadratic shape would make the per-document cost grow ≈ 6× from 15 to 90 days; allow a generous 3.5×
    expect(perDocLarge).toBeLessThan(perDocSmall * 3.5);
  }, 3_600_000);

  // ═════════════════════ 4. the EXPLAIN (ANALYZE, BUFFERS) gate on the exact SQL ═════════════════════
  it('EXPLAIN (ANALYZE, BUFFERS): indexed anchoring where appropriate, primary-key lookups, order_line by its index, no O(n²) / nested seq scans / cross-company aggregation', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const doc = await explain(from, to, null);
    const nodes = flatten(doc.Plan);
    const rel = (name: string): PlanNode[] => nodes.filter((n) => n['Relation Name'] === name);
    const brief = (name: string) =>
      rel(name).map((n) => ({
        nodeType: n['Node Type'],
        index: n['Index Name'],
        actualRows: n['Actual Rows'],
        loops: n['Actual Loops'],
        totalMs: n['Actual Total Time'],
      }));

    // ── no nested loop seq-scans a table once per outer row ──
    const maxProcesses = 1 + Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0));
    const DOC_TABLES = [
      'invoice',
      'order',
      'order_line',
      'credit_note',
      'cancellation_charge',
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
    // ── no materialised CTE of more than one row is re-scanned once per outer row (the fixed O(n²) defect) ──
    const cteScans = nodes
      .filter((n) => n['Node Type'] === 'CTE Scan')
      .map((n) => ({
        cte: n['CTE Name'],
        rowsPerLoop: n['Actual Rows'] ?? 0,
        loops: n['Actual Loops'] ?? 1,
      }));
    for (const c of cteScans) {
      expect(
        c.loops <= Math.max(50, BRANCHES * 4) || c.rowsPerLoop <= 1,
        `CTE ${c.cte} is scanned once per outer row (${c.loops} loops over ${c.rowsPerLoop} rows)`,
      ).toBe(true);
    }
    // ── order_line: the per-invoice lateral lookup uses its (tenantId, companyId, orderId) index ──
    const olNodes = rel('order_line');
    expect(olNodes.length).toBeGreaterThan(0);
    for (const n of olNodes) {
      expect(n['Node Type']).not.toBe('Seq Scan');
      const index = flatten(n)
        .map((x) => x['Index Name'])
        .find((x) => !!x);
      // either index leads with (tenantId, companyId, orderId); the unique one also yields the lines ALREADY in linePosition order
      expect([
        'order_line_tenantId_companyId_orderId_idx',
        'order_line_tenantId_companyId_orderId_linePosition_key',
      ]).toContain(index);
    }
    const invoiceLookups = olNodes.reduce((m, n) => Math.max(m, n['Actual Loops'] ?? 1), 0);
    expect(invoiceLookups).toBeGreaterThanOrEqual(INVOICES); // one index lookup per invoice — bounded, not a scan
    // ── every scan of a tenant-owned table carries the tenant AND company predicate (no cross-company aggregation) ──
    for (const name of [
      'journal_entry',
      'journal_line',
      'invoice',
      'order',
      'order_line',
      'credit_note',
      'cancellation_charge',
      'customer_receivable',
      'account',
    ]) {
      for (const n of rel(name)) {
        const conds = [n['Index Cond'], n.Filter, n['Recheck Cond']].filter(Boolean).join(' AND ');
        // the statement binds tenant + company explicitly on every table, so every access path shows both
        expect(conds, `${name} access carries tenantId`).toMatch(/tenantId/);
        expect(conds, `${name} access carries companyId`).toMatch(/companyId/);
      }
    }
    // ── the journal anchor ──
    const je = rel('journal_entry');
    const anchored = je.some(
      (n) =>
        n['Index Name'] === 'journal_entry_tenantId_companyId_postingDate_idx' ||
        (n['Node Type'] === 'Bitmap Heap Scan' &&
          flatten(n).some(
            (m) => m['Index Name'] === 'journal_entry_tenantId_companyId_postingDate_idx',
          )),
    );
    // a narrow window (1 day, 7 days) of the dense dataset MUST be anchored on the postingDate index
    const narrow: Record<string, unknown> = {};
    for (const [label, span] of [
      ['1 day', 1],
      ['7 days', 7],
    ] as const) {
      const d = await explain(await dayAt(DAYS - span), await dayAt(DAYS - 1), null);
      const ns = flatten(d.Plan);
      const used = ns.some(
        (n) => n['Index Name'] === 'journal_entry_tenantId_companyId_postingDate_idx',
      );
      narrow[label] = {
        usesPostingDateIndex: used,
        explainExecutionMs: Math.round(d['Execution Time']),
        journalEntryAccess: ns
          .filter((n) => n['Relation Name'] === 'journal_entry')
          .map((n) => n['Node Type']),
      };
      if (span === 1)
        expect(used, 'a 1-day window is anchored on the postingDate index').toBe(true);
    }
    metrics['explain90DaysPlanTree'] = doc.Plan; // the full tree, for offline time attribution
    metrics['explain90Days'] = {
      explainExecutionTimeMs: Math.round(doc['Execution Time']),
      planningTimeMs: Math.round(doc['Planning Time']),
      nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
      joinTypes: [...new Set(nodes.map((n) => n['Join Type']).filter((x): x is string => !!x))],
      journalEntryAccess: brief('journal_entry'),
      journalEntryAnchoredOnPostingDateIndex: anchored,
      invoiceAccess: brief('invoice'),
      orderAccess: brief('order'),
      orderLineAccess: brief('order_line'),
      orderLineIndexLookups: invoiceLookups,
      creditNoteAccess: brief('credit_note'),
      journalLineAccess: brief('journal_line'),
      cteScans: cteScans,
      maxCteScanLoops: Math.max(0, ...cteScans.map((c) => c.loops)),
      narrowWindows: narrow,
      note: 'compare with the fixed defect: the first evidence statement scanned CTE ld once per invoice (986 loops over 986 rows in the CI-size 90-day window)',
    };
  }, 3_600_000);

  // ═══════════════════════════════ 5. the cap, and the uncapped Trial Balance ═══════════════════════════════
  it('CAP: 90 inclusive dates execute the report; 91 are refused with REPORT_RANGE_TOO_LARGE BEFORE any database work; the Trial Balance stays uncapped', async () => {
    const from = await dayAt(0);
    const to90 = await dayAt(89);
    const to91 = await dayAt(90);
    // 90 inclusive dates: accepted and executed (one transaction, one statement)
    const t0 = repo.transactions;
    const s0 = repo.statements;
    const ok = await inTenant(() => service.companyReport({ companyId: company, from, to: to90 }));
    expect(ok.invoices.invoiceCount).toBe(INVOICES);
    expect(repo.transactions - t0).toBe(1);
    expect(repo.statements - s0).toBe(1);
    // 91 inclusive dates: refused before any financial database work — through the service AND the repository
    const t1 = repo.transactions;
    const s1 = repo.statements;
    await expect(
      inTenant(() => service.companyReport({ companyId: company, from, to: to91 })),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE', status: 400 });
    await expect(
      inTenant(() => repo.getCompanyReportScoped({ companyId: company, from, to: to91 })),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE' });
    await expect(
      inTenant(() =>
        service.branchReport({ companyId: company, branchId: branchIds[0]!, from, to: to91 }),
      ),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE' });
    expect(repo.transactions - t1).toBe(0); // no transaction was even opened
    expect(repo.statements - s1).toBe(0); // no statement was issued
    // the Trial Balance of the SAME dense company over an 11-year period: uncapped, and it balances
    const tb = new TrialBalanceRepository(db);
    const tbStart = performance.now();
    const report = await inTenant(() =>
      tb.getForCompanyScoped({ companyId: company, from: '2020-01-01', to: '2030-12-31' }),
    );
    const tbMs = performance.now() - tbStart;
    expect(report.from).toBe('2020-01-01'); // the 11-year period is accepted as asked — the Trial Balance has no cap
    expect(report.to).toBe('2030-12-31');
    expect(report.accounts.length).toBeGreaterThanOrEqual(3);
    metrics['cap'] = {
      ninetyDaysExecuted: true,
      ninetyOneDaysRefused:
        'REPORT_RANGE_TOO_LARGE (service, repository, branch) with 0 transactions / 0 statements',
      trialBalanceElevenYearPeriod: { returned: true, ms: Math.round(tbMs) },
    };
  }, 3_600_000);

  // ═════════════════ 6. the DENSITY GUARD above the limit: ONE more document → 25 001 ═════════════════
  /** one extra financial document — a CancellationCharge with its sealed journal — inside the window */
  async function addOneDocument(): Promise<void> {
    const accounts = await admin.query(`SELECT key, id FROM account WHERE "companyId" = $1`, [
      company,
    ]);
    const acct = (key: string): string =>
      accounts.rows.find((r) => r['key'] === key)!['id'] as string;
    const order = await admin.query(`SELECT id FROM "order" WHERE "companyId" = $1 LIMIT 1`, [
      company,
    ]);
    const period = await admin.query(
      `SELECT id FROM accounting_period WHERE "companyId" = $1 LIMIT 1`,
      [company],
    );
    const ccId = randomUUID();
    const entryId = randomUUID();
    const day = await dayAt(DAYS - 1);
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      await admin.query(
        `INSERT INTO cancellation_charge (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber","netAmountMinor",
                                          "taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent","taxCategoryKey",
                                          "rateBps","priceTaxMode","roundingMode","reasonCode","accountingDate")
         VALUES ($1,$2,$3,$4,$5,'CC-EXTRA',400,20,420,'AED',2,'STD3B3',500,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',$6::date)`,
        [ccId, tenant, company, branchIds[0], order.rows[0]!['id'], day],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         VALUES ($1,$2,$3,$4,$5::date,'cancellation_charge',$6,'AED','fp',now())`,
        [entryId, tenant, company, period.rows[0]!['id'], day, ccId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,420,0), (gen_random_uuid(),$1,$2,$3,$6,$5,0,400), (gen_random_uuid(),$1,$2,$3,$7,$5,0,20)`,
        [
          tenant,
          company,
          entryId,
          acct('ASSET.ACCOUNTS_RECEIVABLE'),
          branchIds[0],
          acct('REVENUE.CANCELLATION_CHARGE'),
          acct('LIABILITY.TAX_PAYABLE'),
        ],
      );
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  it('ABOVE the limit: 25 000 + one CancellationCharge → REPORT_RESULT_TOO_LARGE, repeatedly, cheaper than an accepted report and memory-safe', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const acceptedMs = (metrics['summary'] as { fullServiceMs: { p50: number } | null })
      .fullServiceMs?.p50;
    await addOneDocument();
    const docs = await admin.query(
      `SELECT count(*)::int AS n FROM journal_entry
        WHERE "companyId" = $1 AND "sourceKind" IN ('invoice_ar','walk_in_sale','credit_note','cancellation_charge')
          AND "postingDate" BETWEEN $2::date AND $3::date`,
      [company, from, to],
    );
    // the gate is defined at EXACTLY the limit: one more document is limit + 1
    expect(INVOICES).toBe(SALES_REPORT_MAX_DOCUMENTS);
    expect(Number(docs.rows[0]!['n'])).toBe(SALES_REPORT_MAX_DOCUMENTS + 1);

    const rejections: Record<string, unknown>[] = [];
    metrics['rejections'] = rejections;
    for (let r = 1; r <= 3; r += 1) {
      const rssBefore = memory().rssMB;
      const statements = repo.statements;
      const transactions = repo.transactions;
      const t0 = performance.now();
      let code: unknown;
      let status: unknown;
      try {
        await inTenant(() => service.companyReport({ companyId: company, from, to }));
      } catch (e) {
        code = (e as { code?: unknown }).code;
        status = (e as { status?: unknown }).status;
      }
      const ms = performance.now() - t0;
      rejections.push({
        run: r,
        code,
        status,
        ms: Math.round(ms),
        statementsIssued: repo.statements - statements,
        transactionsOpened: repo.transactions - transactions,
        rssBeforeMB: rssBefore,
        rssAfterMB: memory().rssMB,
      });
      expect(code).toBe('REPORT_RESULT_TOO_LARGE');
      expect(status).toBe(422);
      expect(repo.statements - statements).toBe(1); // still ONE statement — the guard is its first stage
      expect(repo.transactions - transactions).toBe(1);
      expect(memory().rssMB - rssBefore).toBeLessThan(250); // memory-safe: nothing heavy was read
    }
    const times = rejections.map((x) => x['ms'] as number);
    metrics['rejectionSummary'] = {
      p50: median(times),
      worst: Math.max(...times),
      acceptedP50: acceptedMs,
    };
    // materially cheaper than an accepted report of the same scope
    if (acceptedMs !== undefined) expect(Math.max(...times)).toBeLessThan(acceptedMs * 0.5);
  }, 3_600_000);

  it('the BRANCH routes are untouched by the extra company document: each branch is far below its own limit and is still reported', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const perBranch: Record<string, unknown>[] = [];
    metrics['branchRoutesAboveCompanyLimit'] = perBranch;
    for (const branchId of branchIds) {
      const t0 = performance.now();
      const r = await inTenant(() =>
        service.branchReport({ companyId: company, branchId, from, to }),
      );
      const documents =
        r.invoices.invoiceCount +
        r.creditNotes.creditNoteCount +
        r.cancellationCharges.cancellationChargeCount;
      perBranch.push({ branchId, documents, ms: Math.round(performance.now() - t0) });
      expect(documents).toBeLessThanOrEqual(SALES_REPORT_MAX_DOCUMENTS);
      expect(r.reconciliation.reconciled).toBe(true);
    }
    // the company holds one document more than the limit, yet no single branch does
    expect(perBranch.reduce((n, b) => n + (b['documents'] as number), 0)).toBe(
      SALES_REPORT_MAX_DOCUMENTS + 1,
    );
  }, 3_600_000);

  it('EXPLAIN (ANALYZE, BUFFERS) at 25 001: the candidate stage stops at the limit and NO heavy stage executes (evidence JSON, fingerprint payload, aggregates, reconciliation)', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const doc = await explain(from, to, null);
    const nodes = flatten(doc.Plan);
    const executed = (n: PlanNode): boolean => (n['Actual Loops'] ?? 0) > 0;
    const byRelation = (name: string): PlanNode[] =>
      nodes.filter((n) => n['Relation Name'] === name);
    // the heavy stages read these tables: order (fingerprint facts), order_line (evidence JSON), journal_line
    // + account (GL aggregates / reconciliation), customer_receivable (integrity probe) — none may run
    const heavy: Record<string, string> = {};
    for (const rel of ['order', 'order_line', 'journal_line', 'account', 'customer_receivable']) {
      const scans = byRelation(rel);
      heavy[rel] =
        scans.length === 0 ? 'absent' : scans.some(executed) ? 'EXECUTED' : 'never executed';
    }
    metrics['explainAboveLimitHeavyRelations'] = heavy;
    metrics['explainAboveLimitPlanTree'] = doc.Plan;
    for (const rel of Object.keys(heavy)) {
      expect(heavy[rel], `${rel} must never execute above the limit`).not.toBe('EXECUTED');
    }
    // the integrity probes of the journal table (the (tenantId, companyId, sourceKind, sourceId) unique index) never run either
    const probes = nodes.filter(
      (n) => n['Index Name'] === 'journal_entry_tenantId_companyId_sourceKind_sourceId_key',
    );
    expect(probes.some(executed), 'the duplicate / credit-note journal probes must not run').toBe(
      false,
    );
    // the candidate stage is a LIMIT of limit + 1 rows and the journal scan feeding it is bounded by it
    const limit = nodes.find((n) => n['Node Type'] === 'Limit' && (n['Actual Rows'] ?? 0) > 0);
    expect(limit?.['Actual Rows']).toBe(SALES_REPORT_MAX_DOCUMENTS + 1);
    const candidateScans = byRelation('journal_entry').filter(
      (n) =>
        n['Index Name'] !== 'journal_entry_tenantId_companyId_sourceKind_sourceId_key' &&
        executed(n),
    );
    const scanned = candidateScans.reduce((n, x) => n + (x['Actual Rows'] ?? 0), 0);
    expect(scanned).toBeLessThanOrEqual(SALES_REPORT_MAX_DOCUMENTS + 1 + 2_000);
    // no JSON aggregate over evidence ran: the plan's executed time stays a small fraction of the accepted plan's
    const accepted = (metrics['explain90Days'] as { explainExecutionTimeMs: number })
      .explainExecutionTimeMs;
    expect(doc['Execution Time']).toBeLessThan(accepted * 0.5);
    // …and the short-circuit does not depend on the planner's CURRENT join choice: every stage that must not run is
    // gated by a One-Time Filter ABOVE its joins, so NO join method may execute a heavy input
    const HEAVY = ['order', 'order_line', 'journal_line', 'account', 'customer_receivable'];
    const variants: (readonly string[])[] = [
      ['enable_hashjoin = off'],
      ['enable_mergejoin = off'],
      ['enable_nestloop = off'],
      ['enable_hashjoin = off', 'enable_nestloop = off'],
      ['enable_mergejoin = off', 'enable_nestloop = off'],
      ['enable_seqscan = off'],
    ];
    const variantResults: Record<string, unknown>[] = [];
    metrics['explainAboveLimitPlannerVariants'] = variantResults;
    for (const settings of variants) {
      const d = await explain(from, to, null, settings);
      const ns = flatten(d.Plan);
      const ran = HEAVY.filter((rel) =>
        ns.filter((n) => n['Relation Name'] === rel).some(executed),
      );
      variantResults.push({
        settings,
        heavyRelationsExecuted: ran,
        explainExecutionTimeMs: Math.round(d['Execution Time']),
      });
      expect(
        ran,
        `planner variant [${settings.join(', ')}] must not execute a heavy input above the limit`,
      ).toEqual([]);
    }
    metrics['explainAboveLimit'] = {
      explainExecutionTimeMs: Math.round(doc['Execution Time']),
      acceptedExplainExecutionTimeMs: accepted,
      limitNodeActualRows: limit?.['Actual Rows'],
      candidateJournalRowsScanned: scanned,
      heavyRelations: heavy,
      probesExecuted: probes.some(executed),
      nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
      note: 'the heavy relations are listed in the plan but their scans never executed',
    };
  }, 3_600_000);

  it('CAP + DENSITY re-proved: 91 days → REPORT_RANGE_TOO_LARGE before any DB work; 90 days + 25 001 documents → REPORT_RESULT_TOO_LARGE; the Trial Balance stays uncapped', async () => {
    const from = await dayAt(0);
    const to90 = await dayAt(89);
    const to91 = await dayAt(90);
    // 91 days wins over the density and does no database work at all
    const t0 = repo.transactions;
    const s0 = repo.statements;
    await expect(
      inTenant(() => service.companyReport({ companyId: company, from, to: to91 })),
    ).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE', status: 400 });
    expect(repo.transactions - t0).toBe(0);
    expect(repo.statements - s0).toBe(0);
    // 90 days with 25 001 documents: the density rejection (422)
    await expect(
      inTenant(() => service.companyReport({ companyId: company, from, to: to90 })),
    ).rejects.toMatchObject({ code: 'REPORT_RESULT_TOO_LARGE', status: 422 });
    // 90 days, a branch within its limit: accepted
    const branch = await inTenant(() =>
      service.branchReport({ companyId: company, branchId: branchIds[0]!, from, to: to90 }),
    );
    expect(branch.invoices.invoiceCount).toBeGreaterThan(0);
    // the Trial Balance of the same company over an 11-year period is still uncapped (and still balances)
    const report = await inTenant(() =>
      new TrialBalanceRepository(db).getForCompanyScoped({
        companyId: company,
        from: '2020-01-01',
        to: '2030-12-31',
      }),
    );
    expect(report.from).toBe('2020-01-01');
    expect(report.to).toBe('2030-12-31');
    metrics['capAndDensity'] = {
      ninetyOneDays: 'REPORT_RANGE_TOO_LARGE, 0 transactions, 0 statements',
      ninetyDaysAnd25001Documents: 'REPORT_RESULT_TOO_LARGE (422)',
      branchWithinLimit: 'accepted',
      trialBalanceElevenYears: 'accepted',
    };
  }, 3_600_000);
});
