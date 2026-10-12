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
import { TENDER_METHODS } from '../payments/tender.js';
import {
  TenderTotalsReportRepository,
  type TenderTotalsBranchReport,
  type TenderTotalsCompanyReport,
} from './tender-totals-report.repository.js';
import {
  buildTenderTotalsReportQuery,
  type TenderTotalsReportJson,
} from './tender-totals-report.sql.js';

/**
 * Task 3b.10 Checkpoint C — the TENDER TOTALS query-plan / volume gate (owner §16–§17).
 *
 * Tender Totals is PERIOD-ONLY and returns a handful of aggregate rows whatever the period, so the question is
 * whether a longer period — or a dense one, or a sparse branch inside a dense company — costs proportionally
 * more and whether the joins into the source documents stay on their primary keys / indexes. The REAL statement
 * (`buildTenderTotalsReportQuery`, the exact text the repository runs) is EXPLAINed (ANALYZE, BUFFERS) through the
 * real RLS role on a disposable chronological multi-branch ledger that also holds the other journal kinds a real
 * ledger carries (invoice / payment-allocation / settlement entries) plus other companies and another tenant.
 *
 * Size is configurable so the same file is both a fast CI guard and a one-off measurement:
 *   TENDER_VOLUME_EVENTS     receipt / sale / refund EVENTS of the TARGET company     (default 12 000)
 *   TENDER_DAYS              days of history they span                                 (default 1 095 ≈ 3 years)
 *   TENDER_BRANCHES          branches of the target company                            (default 4)
 *   TENDER_NOISE_MULTIPLIER  other companies' events as a multiple                     (default 0.5)
 *   TENDER_DENSE_SHARE       the share of all events packed into ONE day               (default 0.10)
 *   TENDER_PLAN_METRICS_FILE when set, plans / timings are written there as JSON
 *
 * Assertions are about CORRECTNESS (the report equals an independent oracle at volume) and PATHOLOGY (no nested
 * loop that seq-scans a document table once per outer row, no CTE re-scanned once per outer row) — NOT wall-clock
 * speed. Timings are observations of a LOCAL TEST CONTAINER, not a production SLA:
 * "Local test-container benchmark; not production capacity."
 */
const EVENTS = Number(process.env['TENDER_VOLUME_EVENTS'] ?? 12_000);
const DAYS = Number(process.env['TENDER_DAYS'] ?? 1_095);
const BRANCHES = Number(process.env['TENDER_BRANCHES'] ?? 4);
const NOISE = Number(process.env['TENDER_NOISE_MULTIPLIER'] ?? 0.5);
const DENSE_SHARE = Number(process.env['TENDER_DENSE_SHARE'] ?? 0.1);
const METRICS_FILE = process.env['TENDER_PLAN_METRICS_FILE'];
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

describe('Tender Totals — query-plan / volume gate (task 3b.10 Checkpoint C)', () => {
  let stack: TestStack;
  let db: DbService;
  let prisma: PrismaClient;
  let repo: TenderTotalsReportRepository;
  let admin: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };

  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const company = randomUUID();
  const branchIds = Array.from({ length: BRANCHES }, () => randomUUID());
  /** the SPARSE branch: ~1 % of the target company's events while the other branches share the rest */
  const sparseBranch = branchIds[BRANCHES - 1]!;
  const metrics: Record<string, unknown> = {};
  const dayAt = (n: number): Promise<string> =>
    admin
      .query(`SELECT (DATE '${START}' + $1::int)::text AS d`, [n])
      .then((r) => r.rows[0]!['d'] as string);
  const DENSE_INDEX = Math.floor(DAYS / 2);

  async function seedCompany(args: {
    tenantId: string;
    companyId: string;
    branches: string[];
    events: number;
    sparse: string | null;
    dense: boolean;
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
      ['ASSET.BANK', 'ASSET', '1100', 'Bank'],
      ['ASSET.PAYMENT_CLEARING', 'ASSET', '1200', 'Clearing'],
      ['ASSET.ACCOUNTS_RECEIVABLE', 'ASSET', '1300', 'AR'],
      ['LIABILITY.TAX_PAYABLE', 'LIABILITY', '2100', 'Tax'],
      ['LIABILITY.UNAPPLIED_RECEIPTS', 'LIABILITY', '2200', 'Unapplied'],
      ['LIABILITY.CUSTOMER_ADVANCES', 'LIABILITY', '2300', 'Advances'],
      ['REVENUE.SALES', 'REVENUE', '4000', 'Sales'],
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

    // the branches other than the sparse one carry the bulk
    const dense = args.branches.filter((b) => b !== args.sparse);
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      await admin.query(`DROP TABLE IF EXISTS tg`);
      // chronological events (production data is inserted in date order). event kind by gs % 5:
      //   0,1,2  customer Payment + receipt journal (+ allocation + allocation journal for 0,1)
      //   3,4    anonymous sale: invoice + order + ONE walk_in_sale journal + 1 Payment (even) or 2 Payments (odd)
      // every 33rd customer receipt is refunded (a Refund + its refund journal), every 40th refund is provider-finalised
      await admin.query(
        `CREATE TEMP TABLE tg AS
           SELECT gs AS i, gen_random_uuid() AS pay_id, gen_random_uuid() AS pay2_id, gen_random_uuid() AS entry_id,
                  gen_random_uuid() AS inv_id, gen_random_uuid() AS order_id, gen_random_uuid() AS alloc_id,
                  gen_random_uuid() AS alloc_entry, gen_random_uuid() AS rf_id, gen_random_uuid() AS rf_entry,
                  CASE WHEN $5::boolean AND gs % $8::int = 0 THEN (DATE '${START}' + $6::int)
                       ELSE (DATE '${START}' + (((gs - 1)::bigint * $2::bigint) / $1::bigint)::int) END AS d,
                  (1000 + (gs % 977))::bigint AS amt,
                  CASE WHEN $7::uuid IS NOT NULL AND gs % 100 = 7 THEN $7::uuid
                       ELSE ($3::uuid[])[1 + (gs % $4::int)] END AS branch_id,
                  (ARRAY['CASH','CARD_TERMINAL','BANK_TRANSFER','ONLINE_GATEWAY','OTHER_MANUAL'])[1 + ((gs / 5) % 5)] AS method,
                  (ARRAY['CASH','CARD_TERMINAL','BANK_TRANSFER','OTHER_MANUAL','OTHER_MANUAL'])[1 + ((gs / 5) % 5)] AS amethod,
                  gs % 5 AS kind
             FROM generate_series(1, $1::int) gs`,
        [
          args.events,
          DAYS,
          dense,
          dense.length,
          args.dense,
          DENSE_INDEX,
          args.sparse,
          Math.max(1, Math.round(1 / DENSE_SHARE)),
        ],
      );
      // ── customer receipts: Payment + receipt journal ──
      await admin.query(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey","amountMinor","currencyCode","currencyExponent")
         SELECT g.pay_id, $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), g.method,
                CASE WHEN g.method = 'ONLINE_GATEWAY' THEN 'tap' END, g.amt, 'AED', 2 FROM tg g WHERE g.kind IN (0,1,2)`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT g.entry_id, $1::uuid, $2::uuid, $3::uuid, g.d, 'customer_receipt_payment', g.pay_id::text, 'AED', 'fp', now()
           FROM tg g WHERE g.kind IN (0,1,2)`,
        [args.tenantId, args.companyId, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.entry_id, v.account_id, g.branch_id, v.dr, v.cr
           FROM tg g CROSS JOIN LATERAL (VALUES
             (CASE g.method WHEN 'CASH' THEN $3::uuid WHEN 'BANK_TRANSFER' THEN $4::uuid ELSE $5::uuid END, g.amt, 0::bigint),
             ($6::uuid, 0::bigint, g.amt)) AS v(account_id, dr, cr)
          WHERE g.kind IN (0,1,2)`,
        [
          args.tenantId,
          args.companyId,
          acct['ASSET.CASH_ON_HAND'],
          acct['ASSET.BANK'],
          acct['ASSET.PAYMENT_CLEARING'],
          acct['LIABILITY.UNAPPLIED_RECEIPTS'],
        ],
      );
      // ── allocations of 2 / 3 of the customer receipts (+ the allocation journal — never a receipt) ──
      await admin.query(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         SELECT g.alloc_id, $1::uuid, $2::uuid, g.branch_id, g.pay_id, gen_random_uuid(), g.amt, 'AED', 2 FROM tg g WHERE g.kind IN (0,1)`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT g.alloc_entry, $1::uuid, $2::uuid, $3::uuid, g.d, 'payment_allocation', g.alloc_id::text, 'AED', 'fp', now()
           FROM tg g WHERE g.kind IN (0,1)`,
        [args.tenantId, args.companyId, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.alloc_entry, v.account_id, g.branch_id, v.dr, v.cr
           FROM tg g CROSS JOIN LATERAL (VALUES
             ($3::uuid, g.amt, 0::bigint), ($4::uuid, 0::bigint, g.amt)) AS v(account_id, dr, cr)
          WHERE g.kind IN (0,1)`,
        [
          args.tenantId,
          args.companyId,
          acct['LIABILITY.UNAPPLIED_RECEIPTS'],
          acct['ASSET.ACCOUNTS_RECEIVABLE'],
        ],
      );
      // ── anonymous sales: order + invoice + 1 or 2 Payments (+ allocations) + ONE walk_in_sale journal ──
      await admin.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent",
                              "documentDiscountMode","documentDiscountAmountMinor","orderNumber","commercialSnapshotFingerprint",
                              "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
         SELECT g.order_id, $1::uuid, $2::uuid, g.branch_id, g.branch_id, 'WALK_IN', 'CONFIRMED', 'AED', 2,
                'NONE', 0, 'ORD-' || g.i, repeat('0', 64), 2, 'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', now()
           FROM tg g WHERE g.kind IN (3,4)`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
                              "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
                              "taxTotalAmountMinor","totalAmountMinor","invoicePaymentStatus")
         SELECT g.inv_id, $1::uuid, $2::uuid, g.branch_id, g.order_id, 'INV-' || g.i, g.d::timestamptz, g.d,
                'AED', 2, g.amt * 2, 0, 0, g.amt * 2, 'SETTLED'
           FROM tg g WHERE g.kind IN (3,4)`,
        [args.tenantId, args.companyId],
      );
      // payment #1 (every anonymous sale) and payment #2 (odd events only: a Multi Payment of two tenders)
      for (const [col, filter, method, amount] of [
        ['pay_id', 'g.kind IN (3,4)', 'g.amethod', 'g.amt'],
        ['pay2_id', 'g.kind IN (3,4) AND g.i % 2 = 1', `'CASH'`, 'g.amt'],
      ] as const) {
        // the invoice total is 2 × amt: a one-payment sale pays 2 × amt, a Multi Payment pays amt + amt
        await admin.query(
          `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
           SELECT g.${col}, $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), ${method},
                  ${col === 'pay_id' ? 'CASE WHEN g.i % 2 = 1 THEN g.amt ELSE g.amt * 2 END' : amount}, 'AED', 2
             FROM tg g WHERE ${filter}`,
          [args.tenantId, args.companyId],
        );
        await admin.query(
          `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.branch_id, g.${col}, g.inv_id,
                  ${col === 'pay_id' ? 'CASE WHEN g.i % 2 = 1 THEN g.amt ELSE g.amt * 2 END' : amount}, 'AED', 2
             FROM tg g WHERE ${filter}`,
          [args.tenantId, args.companyId],
        );
      }
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT g.entry_id, $1::uuid, $2::uuid, $3::uuid, g.d, 'walk_in_sale', g.inv_id::text, 'AED', 'fp', now()
           FROM tg g WHERE g.kind IN (3,4)`,
        [args.tenantId, args.companyId, periodId],
      );
      // lines: odd events = Dr <method account> amt + Dr CASH amt (aggregated per account); even = Dr <method account> 2 × amt;
      // Cr REVENUE (the whole total — tax kept out for brevity)
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.entry_id, v.account_id, g.branch_id, v.dr, v.cr
           FROM tg g CROSS JOIN LATERAL (VALUES
             (CASE g.amethod WHEN 'CASH' THEN $3::uuid WHEN 'BANK_TRANSFER' THEN $4::uuid ELSE $5::uuid END,
              CASE WHEN g.i % 2 = 1 AND g.amethod <> 'CASH' THEN g.amt ELSE g.amt * 2 END, 0::bigint),
             (CASE WHEN g.i % 2 = 1 AND g.amethod <> 'CASH' THEN $3::uuid END, g.amt, 0::bigint),
             ($6::uuid, 0::bigint, g.amt * 2)) AS v(account_id, dr, cr)
          WHERE g.kind IN (3,4) AND v.account_id IS NOT NULL`,
        [
          args.tenantId,
          args.companyId,
          acct['ASSET.CASH_ON_HAND'],
          acct['ASSET.BANK'],
          acct['ASSET.PAYMENT_CLEARING'],
          acct['REVENUE.SALES'],
        ],
      );
      // ── refunds of every 33rd customer receipt; every 40th refund is provider-finalised (credits clearing) ──
      await admin.query(`DROP TABLE IF EXISTS tr`);
      await admin.query(
        `CREATE TEMP TABLE tr AS
           SELECT g.*, (g.i % 40 = 0) AS provider,
                  CASE WHEN g.i % 2 = 0 THEN 'CASH' ELSE 'BANK_TRANSFER' END AS rmethod
             FROM tg g WHERE g.kind IN (0,1,2) AND g.i % 33 = 0`,
      );
      await admin.query(
        `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","sourceRefundAttemptId","amountMinor","currencyCode",
                             "currencyExponent",method,"reasonCode","accountingDate")
         SELECT r.rf_id, $1::uuid, $2::uuid, r.branch_id, r.pay_id, CASE WHEN r.provider THEN gen_random_uuid() END, r.amt / 2, 'AED', 2,
                CASE WHEN r.provider THEN 'ONLINE_GATEWAY' ELSE r.rmethod END, 'CUSTOMER_REQUEST', r.d + 1
           FROM tr r`,
        [args.tenantId, args.companyId],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT r.rf_entry, $1::uuid, $2::uuid, $3::uuid, r.d + 1, 'refund', r.rf_id::text, 'AED', 'fp', now() FROM tr r`,
        [args.tenantId, args.companyId, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, r.rf_entry, v.account_id, r.branch_id, v.dr, v.cr
           FROM tr r CROSS JOIN LATERAL (VALUES
             ($6::uuid, r.amt / 2, 0::bigint),
             (CASE WHEN r.provider THEN $5::uuid WHEN r.rmethod = 'CASH' THEN $3::uuid ELSE $4::uuid END, 0::bigint, r.amt / 2)) AS v(account_id, dr, cr)`,
        [
          args.tenantId,
          args.companyId,
          acct['ASSET.CASH_ON_HAND'],
          acct['ASSET.BANK'],
          acct['ASSET.PAYMENT_CLEARING'],
          acct['LIABILITY.CUSTOMER_ADVANCES'],
        ],
      );
      // ── the OTHER kinds a real ledger carries between the tender ones (the sel filter must skip them) ──
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, g.d, (ARRAY['invoice_ar','credit_note','customer_advance','SETTLEMENT_BATCH'])[1 + (g.i % 4)],
                gen_random_uuid()::text, 'AED', 'fp', now()
           FROM tg g WHERE g.i % 2 = 0`,
        [args.tenantId, args.companyId, periodId],
      );
      await admin.query(`DROP TABLE tg; DROP TABLE tr`);
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();
    repo = new TenderTotalsReportRepository(db);
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    admin = { query: (sql, params) => c.query(sql, params as unknown[]), end: () => c.end() };

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await admin.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `tv-plan-${planId.slice(0, 8)}`,
    ]);
    await admin.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const t of [tenant, otherTenant]) {
      await admin.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [t, `tv-${t.slice(0, 8)}`, planVersionId],
      );
    }
    await admin.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel","defaultTimezone","updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN','Asia/Dubai',now()) ON CONFLICT (code) DO NOTHING`,
    );
    const noise = Math.max(1, Math.floor((EVENTS * NOISE) / 3));
    await seedCompany({
      tenantId: tenant,
      companyId: company,
      branches: branchIds,
      events: EVENTS,
      sparse: sparseBranch,
      dense: true,
    });
    for (const [t, branches] of [
      [tenant, [randomUUID(), randomUUID()]],
      [otherTenant, [randomUUID(), randomUUID()]],
      [otherTenant, [randomUUID()]],
    ] as const) {
      await seedCompany({
        tenantId: t,
        companyId: randomUUID(),
        branches: [...branches],
        events: noise,
        sparse: null,
        dense: false,
      });
    }
    await admin.query(
      'VACUUM (ANALYZE) payment, payment_allocation, refund, invoice, "order", journal_entry, journal_line, account, customer_receivable',
    );
    const counts = await admin.query(
      `SELECT (SELECT count(*) FROM payment)::text AS payments, (SELECT count(*) FROM payment_allocation)::text AS allocations,
              (SELECT count(*) FROM refund)::text AS refunds, (SELECT count(*) FROM invoice)::text AS invoices,
              (SELECT count(*) FROM journal_entry)::text AS entries, (SELECT count(*) FROM journal_line)::text AS lines,
              (SELECT count(*) FROM payment WHERE "companyId" = $1)::text AS target_payments,
              (SELECT count(*) FROM refund WHERE "companyId" = $1)::text AS target_refunds,
              (SELECT count(*) FROM journal_entry WHERE "companyId" = $1)::text AS target_entries`,
      [company],
    );
    metrics['dataset'] = {
      targetEvents: EVENTS,
      branches: BRANCHES,
      sparseBranchShare: '≈1 % of the target events',
      denseDayShare: `${(DENSE_SHARE * 100).toFixed(0)} % of the target events on ONE day`,
      historyDays: DAYS,
      noiseMultiplier: NOISE,
      totals: counts.rows[0],
      note: 'disposable chronological dataset; 3/5 customer receipts (2/3 of them allocated), 2/5 anonymous sales (half a Multi Payment of two tenders); one refund per 33 customer receipts (one in 40 provider-finalised); invoice / credit-note / advance / settlement journals interleaved',
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

  type AnyReport = TenderTotalsCompanyReport | TenderTotalsBranchReport;
  const runReport = (from: string, to: string, branchId: string | null): Promise<AnyReport> =>
    inTenant<AnyReport>(() =>
      branchId === null
        ? repo.getCompanyReportScoped({ companyId: company, from, to })
        : repo.getBranchReportScoped({ companyId: company, branchId, from, to }),
    );

  async function runStatement(
    from: string,
    to: string,
    branchId: string | null,
    maxMovements?: number,
  ) {
    const q = buildTenderTotalsReportQuery({
      tenantId: tenant,
      companyId: company,
      from,
      to,
      branchId,
      ...(maxMovements === undefined ? {} : { maxMovements }),
    });
    const t0 = performance.now();
    const rows = await runScoped(
      prisma,
      { tenantId: tenant },
      (tx) => tx.$queryRawUnsafe<{ report: string }[]>(q.text, ...q.values),
      {
        timeout: 1_700_000,
        maxWait: 60_000,
      },
    );
    const fetchMs = performance.now() - t0;
    const raw = rows[0]!.report;
    return { json: JSON.parse(raw) as TenderTotalsReportJson, payloadBytes: raw.length, fetchMs };
  }

  async function explain(
    from: string,
    to: string,
    branchId: string | null,
    maxMovements?: number,
    settings: readonly string[] = [],
  ): Promise<ExplainDoc> {
    const q = buildTenderTotalsReportQuery({
      tenantId: tenant,
      companyId: company,
      from,
      to,
      branchId,
      ...(maxMovements === undefined ? {} : { maxMovements }),
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
      { timeout: 1_700_000, maxWait: 60_000 },
    );
    return rows[0]!['QUERY PLAN'][0]!;
  }

  /** an independent oracle: per-branch / method sums straight from the document tables, a different SQL path */
  async function oracle(from: string, to: string, branchId: string | null) {
    const filter = (col: string): string => (branchId === null ? '' : `AND ${col} = '${branchId}'`);
    const cust = await admin.query(
      `SELECT p.method AS m, count(*)::text AS n, sum(p."amountMinor")::text AS total
         FROM payment p JOIN journal_entry je ON je."tenantId" = p."tenantId" AND je."companyId" = p."companyId"
          AND je."sourceKind" = 'customer_receipt_payment' AND je."sourceId" = p.id::text AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE p."companyId" = $1 ${filter('p."branchId"')} GROUP BY p.method`,
      [company, from, to],
    );
    const anon = await admin.query(
      `SELECT p.method AS m, count(*)::text AS n, sum(p."amountMinor")::text AS total
         FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id
         JOIN journal_entry je ON je."tenantId" = p."tenantId" AND je."companyId" = p."companyId"
          AND je."sourceKind" = 'walk_in_sale' AND je."sourceId" = pa."invoiceId"::text AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE p."companyId" = $1 ${filter('p."branchId"')} GROUP BY p.method`,
      [company, from, to],
    );
    const rf = await admin.query(
      `SELECT r.method AS m, count(*)::text AS n, sum(r."amountMinor")::text AS total
         FROM refund r JOIN journal_entry je ON je."tenantId" = r."tenantId" AND je."companyId" = r."companyId"
          AND je."sourceKind" = 'refund' AND je."sourceId" = r.id::text AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE r."companyId" = $1 ${filter('r."branchId"')} GROUP BY r.method`,
      [company, from, to],
    );
    const fold = (...sets: Record<string, unknown>[][]) => {
      const out = new Map<string, { n: number; total: bigint }>();
      for (const set of sets)
        for (const r of set) {
          const cur = out.get(r['m'] as string) ?? { n: 0, total: 0n };
          out.set(r['m'] as string, {
            n: cur.n + Number(r['n']),
            total: cur.total + BigInt(r['total'] as string),
          });
        }
      return out;
    };
    return { receipts: fold(cust.rows, anon.rows), refunds: fold(rf.rows) };
  }

  const figuresOfReport = (r: AnyReport) => ({
    receipts: new Map(
      r.receipts.byMethod.map((m) => [
        m.method,
        { n: m.receiptCount, total: BigInt(m.receiptTotalMinor) },
      ]),
    ),
    refunds: new Map(
      r.refunds.byMethod.map((m) => [
        m.method,
        { n: m.refundCount, total: BigInt(m.refundTotalMinor) },
      ]),
    ),
  });
  const nonZero = (m: Map<string, { n: number; total: bigint }>) =>
    [...m.entries()].filter(([, v]) => v.n > 0).sort(([a], [b]) => (a < b ? -1 : 1));

  interface Scenario {
    name: string;
    from: () => Promise<string>;
    to: () => Promise<string>;
    branch?: string;
  }
  const last = DAYS - 1;
  const scenarios: Scenario[] = [
    { name: 'short: last single day', from: () => dayAt(last), to: () => dayAt(last) },
    { name: 'short: last 7 days', from: () => dayAt(last - 6), to: () => dayAt(last) },
    {
      name: 'short: 30 days mid-history',
      from: () => dayAt(Math.floor(DAYS / 4)),
      to: () => dayAt(Math.floor(DAYS / 4) + 29),
    },
    { name: '90-day-like: last 90 days', from: () => dayAt(last - 89), to: () => dayAt(last) },
    {
      name: '1-year-like: last 365 days',
      from: () => dayAt(Math.max(0, last - 364)),
      to: () => dayAt(last),
    },
    { name: 'long: full history', from: () => dayAt(0), to: () => dayAt(last) },
    {
      name: 'dense: the single day holding the dense share',
      from: () => dayAt(DENSE_INDEX),
      to: () => dayAt(DENSE_INDEX),
    },
    {
      name: 'dense: that day ± 3 days',
      from: () => dayAt(DENSE_INDEX - 3),
      to: () => dayAt(DENSE_INDEX + 3),
    },
    {
      name: 'branch (busy): last 90 days',
      from: () => dayAt(last - 89),
      to: () => dayAt(last),
      branch: branchIds[0]!,
    },
    {
      name: 'branch (busy): full history',
      from: () => dayAt(0),
      to: () => dayAt(last),
      branch: branchIds[0]!,
    },
    {
      name: 'sparse branch within the dense company: full history',
      from: () => dayAt(0),
      to: () => dayAt(last),
      branch: sparseBranch,
    },
    {
      name: 'sparse branch within the dense company: the dense day',
      from: () => dayAt(DENSE_INDEX),
      to: () => dayAt(DENSE_INDEX),
      branch: sparseBranch,
    },
  ];

  for (const s of scenarios) {
    it(`${s.name}: the report equals an independent oracle, reconciles, and the plan is not pathological`, async () => {
      const from = await s.from();
      const to = await s.to();
      const branchId = s.branch ?? null;

      await explain(from, to, branchId); // warm
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

      const st = await runStatement(from, to, branchId);
      const days = Number(
        (await admin.query(`SELECT ($2::date - $1::date + 1)::int AS n`, [from, to])).rows[0]!['n'],
      );

      // ── correctness at volume: the SERVICE-path report equals the oracle, and reconciles ──
      const o = await oracle(from, to, branchId);
      const t0 = performance.now();
      const report = await runReport(from, to, branchId);
      const wallColdMs = performance.now() - t0;
      const t1 = performance.now();
      await runReport(from, to, branchId);
      const wallWarmMs = performance.now() - t1;
      const f = figuresOfReport(report);
      expect(nonZero(f.receipts)).toEqual(nonZero(o.receipts));
      expect(nonZero(f.refunds)).toEqual(nonZero(o.refunds));
      expect(report.reconciliation.reconciled).toBe(true);
      expect(report.receipts.byMethod.map((m) => m.method)).toEqual([...TENDER_METHODS]);
      if (branchId === null) {
        const byBranch = (report as TenderTotalsCompanyReport).byBranch;
        expect(byBranch.length).toBeLessThanOrEqual(BRANCHES);
        expect(byBranch.reduce((n, b) => n + b.receipts.receiptCount, 0)).toBe(
          report.receipts.receiptCount,
        );
        expect(byBranch.reduce((n, b) => n + b.refunds.refundCount, 0)).toBe(
          report.refunds.refundCount,
        );
      }
      const receiptRows = [...o.receipts.values()].reduce((n, v) => n + v.n, 0);
      const refundRows = [...o.refunds.values()].reduce((n, v) => n + v.n, 0);
      // how many journals the period itself holds (the four anchored kinds) and how many journal rows the plan READ
      const windowJournals = Number(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM journal_entry
              WHERE "companyId" = $1 AND "sealedAt" IS NOT NULL AND "postingDate" BETWEEN $2::date AND $3::date
                AND "sourceKind" IN ('customer_receipt_payment','walk_in_sale','refund','payment_allocation')`,
            [company, from, to],
          )
        ).rows[0]!['n'],
      );
      const journalRowsRead = nodes
        .filter((n) => n['Relation Name'] === 'journal_entry')
        .reduce((n, x) => n + (x['Actual Rows'] ?? 0) * (x['Actual Loops'] ?? 1), 0);

      (metrics['scenarios'] as unknown[] | undefined) ??= [];
      (metrics['scenarios'] as unknown[]).push({
        scenario: s.name,
        from,
        to,
        branchSlice: branchId !== null,
        calendarDays: days,
        receiptRows,
        refundRows,
        windowJournals,
        journalEntryRowsRead: journalRowsRead,
        statementFetchMs: Math.round(st.fetchMs),
        payloadBytes: st.payloadBytes,
        planningTimeMs: doc['Planning Time'],
        explainExecutionTimeMs: doc['Execution Time'],
        serviceWallColdMs: Math.round(wallColdMs),
        serviceWallWarmMs: Math.round(wallWarmMs),
        nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
        joinTypes: [...new Set(nodes.map((n) => n['Join Type']).filter((x): x is string => !!x))],
        indexesUsed: indexes,
        usesPostingDateIndex: indexes.includes('journal_entry_tenantId_companyId_postingDate_idx'),
        journalEntryAccess: access('journal_entry'),
        paymentAccess: access('payment'),
        paymentAllocationAccess: access('payment_allocation'),
        refundAccess: access('refund'),
        invoiceAccess: access('invoice'),
        journalLineAccess: access('journal_line'),
        parallelWorkers: Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0)),
        sharedHitBlocks: doc.Plan['Shared Hit Blocks'],
        sharedReadBlocks: doc.Plan['Shared Read Blocks'],
      });
      if (s.name === 'long: full history') metrics['planFullHistory'] = doc.Plan;

      // ── not pathological: no nested loop seq-scans a document table once PER OUTER ROW ──
      const maxProcesses = 1 + Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0));
      const DOC_TABLES = [
        'payment',
        'payment_allocation',
        'refund',
        'invoice',
        'order',
        'journal_line',
        'journal_entry',
        'customer_receivable',
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
      // …and no materialised CTE is re-scanned once per OUTER ROW (a nested loop over a `CTE Scan` is O(n²))
      for (const n of nodes) {
        if (n['Node Type'] !== 'CTE Scan') continue;
        expect(
          (n['Actual Loops'] ?? 1) <= Math.max(50, BRANCHES * 4) || (n['Actual Rows'] ?? 0) <= 1,
          `CTE ${n['CTE Name']} is scanned once per outer row (${n['Actual Loops']} loops)`,
        ).toBe(true);
      }
      // the statement is anchored on the sealed journals of the period
      expect(rel('journal_entry').length).toBeGreaterThan(0);
      // PERIOD-BOUNDED: the journal rows the plan reads are proportional to the journals the PERIOD holds — never to the
      // company's whole history (an integrity probe planned as a hash join over every receipt journal ever posted would
      // make a one-day report cost as much as the full history). Single-process plans only (a parallel node reports
      // per-worker rows).
      if (maxProcesses === 1) {
        expect(
          journalRowsRead,
          `the plan read ${journalRowsRead} journal rows for a period that holds ${windowJournals}`,
        ).toBeLessThanOrEqual(3 * windowJournals + 500);
        // …and the unique SOURCE index is probed only for the (rare) remainder the period cannot prove itself — never
        // once per Payment of the window (the shape that added ~250 000 probes to a 3-year report)
        const sourceProbes = nodes
          .filter(
            (n) => n['Index Name'] === 'journal_entry_tenantId_companyId_sourceKind_sourceId_key',
          )
          .reduce((n, x) => n + (x['Actual Loops'] ?? 1), 0);
        expect(
          sourceProbes,
          `the plan probed the source index ${sourceProbes} times for a period that holds ${windowJournals} journals`,
        ).toBeLessThanOrEqual(Math.ceil(windowJournals / 10) + 5);
      }
      // the documents are reached by their primary keys: a payment / refund / invoice is NEVER seq-scanned once per journal row
      for (const t of ['payment', 'refund', 'invoice']) {
        for (const n of rel(t)) {
          expect(
            n['Node Type'] !== 'Seq Scan' || (n['Actual Loops'] ?? 1) <= maxProcesses,
            `${t} is seq-scanned ${n['Actual Loops']} times`,
          ).toBe(true);
        }
      }
    }, 1_700_000);
  }

  describe('the density gate (owner ruling TT-1) on the REAL statement — a CI-size proof of what the dense 100 000 gate measures', () => {
    const HEAVY = [
      'payment',
      'refund',
      'invoice',
      'order',
      'journal_line',
      'account',
      'customer_receivable',
    ];
    const ran = (n: PlanNode): boolean => (n['Actual Loops'] ?? 0) > 0;
    const movementsOf = async (from: string, to: string, branchId: string | null) => {
      const o = await oracle(from, to, branchId);
      return [...o.receipts.values(), ...o.refunds.values()].reduce((n, x) => n + x.n, 0);
    };

    it('the gate figure IS the logical movement count — the independent oracle’s Payments + Refunds — on the company and on a branch (company window)', async () => {
      const from = await dayAt(0);
      const to = await dayAt(last);
      const movements = await movementsOf(from, to, null);
      expect(movements).toBeGreaterThan(1_000);
      // generous limit: the gate counts the WHOLE window exactly (every journal, plus each sale's extra Payments)
      const company_ = await runStatement(from, to, null, movements + 10);
      expect(company_.json.candidateMovements).toBe(movements);
      // a branch is judged on the COMPANY window: the very same figure, whatever the branch holds
      const branch_ = await runStatement(from, to, branchIds[0]!, movements + 10);
      expect(branch_.json.candidateMovements).toBe(movements);
      const sparse_ = await runStatement(from, to, sparseBranch, movements + 10);
      expect(sparse_.json.candidateMovements).toBe(movements);
      expect(await movementsOf(from, to, sparseBranch)).toBeLessThan(movements / 10);
    });

    it('ONE movement below the window: NO heavy stage executes — no Payment, Refund, invoice, order, GL line, account or integrity probe is read — under the company and the branch statements', async () => {
      const from = await dayAt(0);
      const to = await dayAt(last);
      const movements = await movementsOf(from, to, null);
      for (const branchId of [null, branchIds[0]!, sparseBranch]) {
        const doc = await explain(from, to, branchId, movements - 1);
        const nodes = flatten(doc.Plan);
        for (const r of HEAVY) {
          const scans = nodes.filter((n) => n['Relation Name'] === r);
          expect(
            scans.some(ran),
            `${r} must never execute above the limit (branch ${branchId ?? 'company'})`,
          ).toBe(false);
        }
        expect(
          nodes
            .filter(
              (n) => n['Index Name'] === 'journal_entry_tenantId_companyId_sourceKind_sourceId_key',
            )
            .some(ran),
          'the source-index probes must not run',
        ).toBe(false);
        // the only journal_entry scan that ran is the gate's: the sealed window journals, never an integrity probe
        const journals = nodes.filter((n) => n['Relation Name'] === 'journal_entry' && ran(n));
        expect(journals.length).toBe(1);
        // the gate's one allocation read is index-driven, never a seq scan
        for (const n of nodes.filter(
          (x) => x['Relation Name'] === 'payment_allocation' && ran(x),
        )) {
          expect(n['Node Type']).not.toBe('Seq Scan');
        }
        const st = await runStatement(from, to, branchId, movements - 1);
        expect(st.json.candidateMovements).toBeGreaterThan(movements - 1);
        expect(st.json.receipts).toEqual([]);
        expect(st.json.refunds).toEqual([]);
        expect(st.json.gl).toEqual([]);
      }
    }, 1_700_000);

    it('the short-circuit does NOT depend on the planner’s join choice: under every forced alternative, one movement below the window no heavy relation is read and no integrity probe runs — each of the seven stages carries its own gate', async () => {
      const from = await dayAt(0);
      const to = await dayAt(last);
      const movements = await movementsOf(from, to, null);
      const variants: (readonly string[])[] = [
        ['enable_hashjoin = off'],
        ['enable_mergejoin = off'],
        ['enable_nestloop = off'],
        ['enable_hashjoin = off', 'enable_nestloop = off'],
        ['enable_mergejoin = off', 'enable_nestloop = off'],
        ['enable_seqscan = off'],
        ['enable_bitmapscan = off'],
        ['max_parallel_workers_per_gather = 0'],
        [
          'max_parallel_workers_per_gather = 4',
          'parallel_setup_cost = 0',
          'parallel_tuple_cost = 0',
        ],
        ['enable_material = off'],
      ];
      for (const settings of variants) {
        const doc = await explain(from, to, null, movements - 1, settings);
        const nodes = flatten(doc.Plan);
        const reached = HEAVY.filter((r) =>
          nodes.filter((n) => n['Relation Name'] === r).some(ran),
        );
        expect(reached, `planner variant [${settings.join(', ')}]`).toEqual([]);
        expect(
          nodes
            .filter(
              (n) => n['Index Name'] === 'journal_entry_tenantId_companyId_sourceKind_sourceId_key',
            )
            .some(ran),
          `planner variant [${settings.join(', ')}] must not probe the source index`,
        ).toBe(false);
      }
    }, 1_700_000);

    it('AT the window’s movements the gate is open: every heavy relation executes and the figures equal the oracle', async () => {
      const from = await dayAt(0);
      const to = await dayAt(last);
      const movements = await movementsOf(from, to, null);
      const doc = await explain(from, to, null, movements);
      const nodes = flatten(doc.Plan);
      for (const r of ['payment', 'refund', 'journal_line', 'account']) {
        expect(
          nodes.filter((n) => n['Relation Name'] === r).some(ran),
          `${r} executes at the limit`,
        ).toBe(true);
      }
      const st = await runStatement(from, to, null, movements);
      expect(st.json.candidateMovements).toBe(movements);
      expect(st.json.receipts.length + st.json.refunds.length).toBeGreaterThan(0);
    }, 1_700_000);
  });

  it('a narrow window is served by the postingDate index (the anchor), not a full scan of the ledger', async () => {
    const narrow = (
      metrics['scenarios'] as { scenario: string; usesPostingDateIndex: boolean }[]
    ).filter((x) => x.scenario === 'short: last single day' || x.scenario === 'short: last 7 days');
    expect(narrow.length).toBe(2);
    expect(narrow.every((x) => x.usesPostingDateIndex)).toBe(true);
  });

  it('the cost grows with the movements in the window — not with the history behind it (a 7-day window vs the full history)', async () => {
    const sc = metrics['scenarios'] as {
      scenario: string;
      explainExecutionTimeMs: number;
      receiptRows: number;
    }[];
    const seven = sc.find((x) => x.scenario === 'short: last 7 days')!;
    const full = sc.find((x) => x.scenario === 'long: full history')!;
    expect(full.receiptRows).toBeGreaterThan(seven.receiptRows);
    // a 7-day window must not cost anywhere near the full history (the index anchor, not a ledger scan)
    expect(seven.explainExecutionTimeMs).toBeLessThan(full.explainExecutionTimeMs);
  });
});
