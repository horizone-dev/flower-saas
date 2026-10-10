import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { DbService, type BackendConfig } from '@flower/backend';
// White-box measurement test: it generates a disposable dataset and EXPLAINs the real statement — not production
// module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import { TENDER_METHODS } from '../payments/tender.js';
import { TenderTotalsReportRepository } from './tender-totals-report.repository.js';
import { TenderTotalsReportService } from './tender-totals-report.service.js';
import {
  buildTenderTotalsReportQuery,
  TENDER_REPORT_MAX_MOVEMENTS,
  type TenderTotalsReportJson,
} from './tender-totals-report.sql.js';
import { TrialBalanceRepository } from './trial-balance.repository.js';

/**
 * Task 3b.10 Checkpoint C — TENDER DENSITY-GUARD CLOSURE (owner ruling TT-1): the exact 100 000-movement acceptance
 * dataset, the 100 001 rejection, and the EXPLAIN hard gate.
 *
 * ONE company, 4 branches (one sparse), exactly `TENDER_REPORT_MAX_MOVEMENTS` LOGICAL tender movements in ONE window —
 * a realistic mixture generated set-based, with noise (other companies, another tenant, journals of every other kind, a
 * payment_allocation journal for two thirds of the customer receipts):
 *
 *   48 000 customer Payments            (CASH / BANK_TRANSFER / manual CARD_TERMINAL / OTHER_MANUAL / ONLINE_GATEWAY)
 *   20 000 anonymous single-tender sales (1 Payment each)
 *   12 000 anonymous Multi Payment sales (2 Payments each = 24 000 movements, but ONE walk_in_sale journal each)
 *    8 000 actual Refunds                (local CASH / BANK_TRANSFER, one in forty provider-finalised)
 *   ───────
 *  100 000 movements — in only 88 000 journals: the unit of the limit is the LOGICAL movement, never the journal.
 *
 * Every figure is an observation of a LOCAL TEST CONTAINER, not a production SLA:
 * "Local test-container benchmark; not production capacity."
 *
 *   TENDER_DENSE_MOVEMENTS   the target movements (a multiple of 100; default = the limit)
 *   TENDER_DENSE_BRANCHES    branches of the target company (default 4)
 *   TENDER_DENSE_NOISE       other companies' events as a multiple of the target's (default 0.15)
 *   TENDER_DENSE_RUNS        accepted measured runs after the warm-up (default 3, at least 3)
 *   TENDER_DENSE_METRICS_FILE when set, every observation is written there as JSON
 *   TENDER_DENSE_PG_JIT      DIAGNOSTIC ONLY — `off` repeats the measurement with the database's `jit` setting off, to
 *                            ATTRIBUTE time to JIT compilation. The gate is judged against PostgreSQL's own default
 *                            (`jit = on`); the observed setting is recorded in the metrics as `pgJitSetting`.
 */
const MOVEMENTS = Number(process.env['TENDER_DENSE_MOVEMENTS'] ?? TENDER_REPORT_MAX_MOVEMENTS);
const BRANCHES = Math.max(2, Number(process.env['TENDER_DENSE_BRANCHES'] ?? 4));
const NOISE = Number(process.env['TENDER_DENSE_NOISE'] ?? 0.15);
const RUNS = Math.max(3, Number(process.env['TENDER_DENSE_RUNS'] ?? 3));
const METRICS_FILE = process.env['TENDER_DENSE_METRICS_FILE'];
const START = '2025-07-01';
const DAYS = 365;
const EVENTS_PER_100_MOVEMENTS = 80; // 48 customer + 20 single + 12 Multi events carry 100 movements with the 8 refunds
const LOCAL_GATE_MS = 12_000; // the local engineering gate against the ≈ 20 s scoped-transaction timeout (NOT an SLA)
const DISCLAIMER = 'Local test-container benchmark; not production capacity.';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'CTE Name'?: string;
  'Join Type'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Workers Launched'?: number;
  Plans?: PlanNode[];
}
interface ExplainDoc {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
  JIT?: Record<string, unknown>;
}
const flatten = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) flatten(c, out);
  return out;
};
const executed = (n: PlanNode): boolean => (n['Actual Loops'] ?? 0) > 0;
const mb = (bytes: number): number => Math.round(bytes / 1_048_576);
const memory = (): { nodeRssMB: number; nodeHeapUsedMB: number; hostFreeMB: number } => {
  const m = process.memoryUsage();
  return { nodeRssMB: mb(m.rss), nodeHeapUsedMB: mb(m.heapUsed), hostFreeMB: mb(freemem()) };
};
/** the PostgreSQL container's memory (a local observation; `docker stats` may be unavailable) */
const containerMemory = (): string[] => {
  try {
    return execSync(
      'docker stats --no-stream --format "{{.Name}} {{.MemUsage}} cpu={{.CPUPerc}}"',
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    )
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !/ryuk/i.test(l));
  } catch {
    return ['docker stats unavailable'];
  }
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

describe('Tender Totals — DENSE 100 000-movement closure (task 3b.10 Checkpoint C, owner ruling TT-1)', () => {
  let stack: TestStack;
  let db: DbService;
  let prisma: PrismaClient;
  let repo: CountingRepository;
  let service: TenderTotalsReportService;
  let admin: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };

  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const company = randomUUID();
  const branchIds = Array.from({ length: BRANCHES }, () => randomUUID());
  const sparseBranch = branchIds[BRANCHES - 1]!;
  const metrics: Record<string, unknown> = { disclaimer: DISCLAIMER };
  const dayAt = (n: number): Promise<string> =>
    admin
      .query(`SELECT (DATE '${START}' + $1::int)::text AS d`, [n])
      .then((r) => r.rows[0]!['d'] as string);

  /** counts every raw statement issued inside the read callback (the "no N+1 / no second COUNT" evidence) */
  class CountingRepository extends TenderTotalsReportRepository {
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
        });
        return fn(counted as ScopedTx);
      });
    }
  }

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId: tenant }), fn);

  // ── the dataset ────────────────────────────────────────────────────────────────────────────────
  async function seedCompany(args: {
    tenantId: string;
    companyId: string;
    branches: string[];
    sparse: string | null;
    events: number;
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
      ['ASSET.BANK', 'ASSET', '1100', 'Bank'],
      ['ASSET.PAYMENT_CLEARING', 'ASSET', '1200', 'Clearing'],
      ['ASSET.ACCOUNTS_RECEIVABLE', 'ASSET', '1300', 'AR'],
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
       VALUES ($1,$2,$3,'2020-01-01','2040-12-31','OPEN',now())`,
      [periodId, args.tenantId, args.companyId],
    );
    const busy = args.branches.filter((b) => b !== args.sparse);
    const T = args.tenantId;
    const C = args.companyId;
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      await admin.query(`DROP TABLE IF EXISTS tg`);
      // events in date order. position in an 80-event block: 0..47 customer Payment · 48..67 anonymous single-tender sale ·
      // 68..79 anonymous Multi Payment sale (2 Payments). every 6th customer Payment is refunded (one refund in forty
      // provider-finalised). Movements per block: 48 + 20 + 2 × 12 + 8 = 100.
      await admin.query(
        `CREATE TEMP TABLE tg AS
           SELECT gs AS i,
                  gen_random_uuid() AS pay_id, gen_random_uuid() AS pay2_id, gen_random_uuid() AS entry_id,
                  gen_random_uuid() AS inv_id, gen_random_uuid() AS order_id, gen_random_uuid() AS alloc_id,
                  gen_random_uuid() AS alloc_entry, gen_random_uuid() AS rf_id, gen_random_uuid() AS rf_entry,
                  (DATE '${START}' + (((gs - 1)::bigint * ${DAYS}::bigint) / $1::bigint)::int) AS d,
                  (1000 + (gs % 977))::bigint AS amt,
                  CASE WHEN $4::uuid IS NOT NULL AND gs % 100 = 7 THEN $4::uuid
                       ELSE ($2::uuid[])[1 + (gs % $3::int)] END AS branch_id,
                  (ARRAY['CASH','CARD_TERMINAL','BANK_TRANSFER','ONLINE_GATEWAY','OTHER_MANUAL'])[1 + ((gs / 5) % 5)] AS method,
                  (ARRAY['CASH','CARD_TERMINAL','BANK_TRANSFER','OTHER_MANUAL','OTHER_MANUAL'])[1 + ((gs / 5) % 5)] AS amethod,
                  CASE WHEN (gs - 1) % 80 < 48 THEN 0 WHEN (gs - 1) % 80 < 68 THEN 1 ELSE 2 END AS kind,
                  CASE WHEN (gs - 1) % 80 < 48 THEN ((gs - 1) / 80) * 48 + (gs - 1) % 80 + 1 END AS cseq
             FROM generate_series(1, $1::int) gs`,
        [args.events, busy, busy.length, args.sparse],
      );
      const acctFor = `CASE g.method WHEN 'CASH' THEN $3::uuid WHEN 'BANK_TRANSFER' THEN $4::uuid ELSE $5::uuid END`;
      // ── customer Payments (+ the receipt journal) ──
      await admin.query(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"providerKey","amountMinor","currencyCode","currencyExponent")
         SELECT g.pay_id, $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), g.method,
                CASE WHEN g.method = 'ONLINE_GATEWAY' THEN 'tap' END, g.amt, 'AED', 2 FROM tg g WHERE g.kind = 0`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
         SELECT g.entry_id, $1::uuid, $2::uuid, $3::uuid, g.d, 'customer_receipt_payment', g.pay_id::text, 'AED', 'fp', now() FROM tg g WHERE g.kind = 0`,
        [T, C, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.entry_id, v.account_id, g.branch_id, v.dr, v.cr
           FROM tg g CROSS JOIN LATERAL (VALUES (${acctFor}, g.amt, 0::bigint), ($6::uuid, 0::bigint, g.amt)) AS v(account_id, dr, cr)
          WHERE g.kind = 0`,
        [
          T,
          C,
          acct['ASSET.CASH_ON_HAND'],
          acct['ASSET.BANK'],
          acct['ASSET.PAYMENT_CLEARING'],
          acct['LIABILITY.UNAPPLIED_RECEIPTS'],
        ],
      );
      // two thirds of them are allocated (+ the payment_allocation journal — NOT a movement)
      await admin.query(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         SELECT g.alloc_id, $1::uuid, $2::uuid, g.branch_id, g.pay_id, gen_random_uuid(), g.amt, 'AED', 2 FROM tg g WHERE g.kind = 0 AND g.cseq % 3 <> 0`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
         SELECT g.alloc_entry, $1::uuid, $2::uuid, $3::uuid, g.d, 'payment_allocation', g.alloc_id::text, 'AED', 'fp', now() FROM tg g WHERE g.kind = 0 AND g.cseq % 3 <> 0`,
        [T, C, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.alloc_entry, v.account_id, g.branch_id, v.dr, v.cr
           FROM tg g CROSS JOIN LATERAL (VALUES ($3::uuid, g.amt, 0::bigint), ($4::uuid, 0::bigint, g.amt)) AS v(account_id, dr, cr)
          WHERE g.kind = 0 AND g.cseq % 3 <> 0`,
        [T, C, acct['LIABILITY.UNAPPLIED_RECEIPTS'], acct['ASSET.ACCOUNTS_RECEIVABLE']],
      );
      // ── anonymous sales: order + invoice + 1 (kind 1) or 2 (kind 2) Payments + ONE walk_in_sale journal ──
      await admin.query(
        `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent",
                              "documentDiscountMode","documentDiscountAmountMinor","orderNumber","commercialSnapshotFingerprint",
                              "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
         SELECT g.order_id, $1::uuid, $2::uuid, g.branch_id, g.branch_id, 'WALK_IN', 'CONFIRMED', 'AED', 2,
                'NONE', 0, 'ORD-' || g.i, repeat('0', 64), 2, 'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', now()
           FROM tg g WHERE g.kind IN (1,2)`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
                              "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
                              "taxTotalAmountMinor","totalAmountMinor","invoicePaymentStatus")
         SELECT g.inv_id, $1::uuid, $2::uuid, g.branch_id, g.order_id, 'INV-' || g.i, g.d::timestamptz, g.d,
                'AED', 2, g.amt * 2, 0, 0, g.amt * 2, 'SETTLED'
           FROM tg g WHERE g.kind IN (1,2)`,
        [T, C],
      );
      // payment #1 (every anonymous sale: the whole total for a single-tender sale, half for a Multi Payment) …
      await admin.query(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
         SELECT g.pay_id, $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), g.amethod,
                CASE WHEN g.kind = 2 THEN g.amt ELSE g.amt * 2 END, 'AED', 2 FROM tg g WHERE g.kind IN (1,2)`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.branch_id, g.pay_id, g.inv_id,
                CASE WHEN g.kind = 2 THEN g.amt ELSE g.amt * 2 END, 'AED', 2 FROM tg g WHERE g.kind IN (1,2)`,
        [T, C],
      );
      // … and payment #2 (a Multi Payment's second tender, CASH)
      await admin.query(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
         SELECT g.pay2_id, $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), 'CASH', g.amt, 'AED', 2 FROM tg g WHERE g.kind = 2`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.branch_id, g.pay2_id, g.inv_id, g.amt, 'AED', 2 FROM tg g WHERE g.kind = 2`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
         SELECT g.entry_id, $1::uuid, $2::uuid, $3::uuid, g.d, 'walk_in_sale', g.inv_id::text, 'AED', 'fp', now() FROM tg g WHERE g.kind IN (1,2)`,
        [T, C, periodId],
      );
      // the debit lines aggregate same-account tenders; the credit is the whole total in revenue (tax omitted for brevity)
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.entry_id, v.account_id, g.branch_id, v.dr, v.cr
           FROM tg g CROSS JOIN LATERAL (VALUES
             (CASE g.amethod WHEN 'CASH' THEN $3::uuid WHEN 'BANK_TRANSFER' THEN $4::uuid ELSE $5::uuid END,
              CASE WHEN g.kind = 2 AND g.amethod <> 'CASH' THEN g.amt ELSE g.amt * 2 END, 0::bigint),
             (CASE WHEN g.kind = 2 AND g.amethod <> 'CASH' THEN $3::uuid END, g.amt, 0::bigint),
             ($6::uuid, 0::bigint, g.amt * 2)) AS v(account_id, dr, cr)
          WHERE g.kind IN (1,2) AND v.account_id IS NOT NULL`,
        [
          T,
          C,
          acct['ASSET.CASH_ON_HAND'],
          acct['ASSET.BANK'],
          acct['ASSET.PAYMENT_CLEARING'],
          acct['REVENUE.SALES'],
        ],
      );
      // ── refunds of every 6th customer Payment (alternating CASH / BANK_TRANSFER; one in forty provider-finalised) ──
      await admin.query(`DROP TABLE IF EXISTS tr`);
      await admin.query(
        `CREATE TEMP TABLE tr AS
           SELECT g.*, (g.cseq / 6) % 40 = 0 AS provider, CASE WHEN (g.cseq / 6) % 2 = 0 THEN 'CASH' ELSE 'BANK_TRANSFER' END AS rmethod
             FROM tg g WHERE g.kind = 0 AND g.cseq % 6 = 0`,
      );
      await admin.query(
        `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","sourceRefundAttemptId","amountMinor","currencyCode",
                             "currencyExponent",method,"reasonCode","accountingDate")
         SELECT r.rf_id, $1::uuid, $2::uuid, r.branch_id, r.pay_id, CASE WHEN r.provider THEN gen_random_uuid() END, r.amt / 2, 'AED', 2,
                CASE WHEN r.provider THEN 'ONLINE_GATEWAY' ELSE r.rmethod END, 'CUSTOMER_REQUEST', r.d
           FROM tr r`,
        [T, C],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
         SELECT r.rf_entry, $1::uuid, $2::uuid, $3::uuid, r.d, 'refund', r.rf_id::text, 'AED', 'fp', now() FROM tr r`,
        [T, C, periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, r.rf_entry, v.account_id, r.branch_id, v.dr, v.cr
           FROM tr r CROSS JOIN LATERAL (VALUES
             ($6::uuid, r.amt / 2, 0::bigint),
             (CASE WHEN r.provider THEN $5::uuid WHEN r.rmethod = 'CASH' THEN $3::uuid ELSE $4::uuid END, 0::bigint, r.amt / 2)) AS v(account_id, dr, cr)`,
        [
          T,
          C,
          acct['ASSET.CASH_ON_HAND'],
          acct['ASSET.BANK'],
          acct['ASSET.PAYMENT_CLEARING'],
          acct['LIABILITY.CUSTOMER_ADVANCES'],
        ],
      );
      // ── journals of EVERY OTHER kind between the movements: never a movement ──
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, g.d,
                (ARRAY['invoice_ar','credit_note','customer_advance','SETTLEMENT_BATCH'])[1 + (g.i % 4)], gen_random_uuid()::text, 'AED', 'fp', now()
           FROM tg g`,
        [T, C, periodId],
      );
      await admin.query(`DROP TABLE tg; DROP TABLE tr`);
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  /** ONE more valid movement (a customer Payment + its sealed receipt journal) inside the window of the target company */
  async function addOneMovement(): Promise<void> {
    const periodId = (
      await admin.query(`SELECT id FROM accounting_period WHERE "companyId" = $1`, [company])
    ).rows[0]!['id'] as string;
    const accountId = async (key: string): Promise<string> =>
      (
        await admin.query(`SELECT id FROM account WHERE "companyId" = $1 AND key = $2`, [
          company,
          key,
        ])
      ).rows[0]!['id'] as string;
    const payId = randomUUID();
    const entryId = randomUUID();
    const d = await dayAt(10);
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      await admin.query(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,gen_random_uuid(),'CASH',1234,'AED',2)`,
        [payId, tenant, company, branchIds[0]],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
         VALUES ($1,$2,$3,$4,$5,'customer_receipt_payment',$6,'AED','fp',now())`,
        [entryId, tenant, company, periodId, d, payId],
      );
      for (const [key, dr, cr] of [
        ['ASSET.CASH_ON_HAND', 1234, 0],
        ['LIABILITY.UNAPPLIED_RECEIPTS', 0, 1234],
      ] as const) {
        await admin.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
          [tenant, company, entryId, await accountId(key), branchIds[0], dr, cr],
        );
      }
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  beforeAll(async () => {
    expect(MOVEMENTS % 100).toBe(0);
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();
    repo = new CountingRepository(db);
    service = new TenderTotalsReportService(repo);
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    admin = { query: (sql, params) => c.query(sql, params as unknown[]), end: () => c.end() };
    metrics['memoryBeforeSeeding'] = memory();
    if (process.env['TENDER_DENSE_PG_JIT'] === 'off') {
      await admin.query(
        `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $$`,
      );
    }

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await admin.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `td-plan-${planId.slice(0, 8)}`,
    ]);
    await admin.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    for (const t of [tenant, otherTenant]) {
      await admin.query(
        `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
        [t, `td-${t.slice(0, 8)}`, planVersionId],
      );
    }
    await admin.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel","defaultTimezone","updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN','Asia/Dubai',now()) ON CONFLICT (code) DO NOTHING`,
    );
    const events = (MOVEMENTS / 100) * EVENTS_PER_100_MOVEMENTS;
    const noiseEvents = Math.max(80, Math.floor((events * NOISE) / 80) * 80);
    await seedCompany({
      tenantId: tenant,
      companyId: company,
      branches: branchIds,
      sparse: sparseBranch,
      events,
    });
    for (const [t, branches] of [
      [tenant, [randomUUID(), randomUUID()]],
      [otherTenant, [randomUUID(), randomUUID()]],
    ] as const) {
      await seedCompany({
        tenantId: t,
        companyId: randomUUID(),
        branches: [...branches],
        sparse: null,
        events: noiseEvents,
      });
    }
    metrics['memoryAfterSeeding'] = memory();
    metrics['pgJitSetting'] = (await prisma.$queryRawUnsafe<{ jit: string }[]>('SHOW jit'))[0]?.jit;
    await admin.query(
      'VACUUM (ANALYZE) payment, payment_allocation, refund, invoice, "order", journal_entry, journal_line, account, customer_receivable',
    );
    const totals = await admin.query(
      `SELECT (SELECT count(*) FROM payment)::text AS payments, (SELECT count(*) FROM refund)::text AS refunds,
              (SELECT count(*) FROM journal_entry)::text AS entries, (SELECT count(*) FROM journal_line)::text AS lines,
              (SELECT count(*) FROM payment WHERE "companyId" = $1)::text AS target_payments,
              (SELECT count(*) FROM refund WHERE "companyId" = $1)::text AS target_refunds,
              (SELECT count(*) FROM journal_entry WHERE "companyId" = $1)::text AS target_entries,
              (SELECT count(*) FROM journal_entry WHERE "companyId" = $1 AND "sourceKind" IN ('customer_receipt_payment','walk_in_sale','refund'))::text AS target_movement_journals`,
      [company],
    );
    metrics['dataset'] = {
      targetMovements: MOVEMENTS,
      limit: TENDER_REPORT_MAX_MOVEMENTS,
      branches: BRANCHES,
      sparseBranchShare: '≈1 % of the events',
      window: `${START} + ${DAYS} days`,
      noiseEvents,
      totals: totals.rows[0],
      shape:
        '48 % customer Payments, 20 % single-tender anonymous sales, 24 % (12 000 sales × 2) Multi Payment Payments, 8 % Refunds; payment_allocation / invoice / credit-note / advance / settlement journals interleaved',
    };
  }, 3_600_000);

  afterAll(async () => {
    metrics['memoryAtEnd'] = memory();
    if (process.env['TENDER_DENSE_KEEP'] === '1') {
      metrics['keptPostgresUrl'] = stack?.postgres.url;
      metrics['company'] = company;
      metrics['tenant'] = tenant;
    }
    if (METRICS_FILE) writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
    await admin?.end();
    await prisma?.$disconnect();
    // a diagnostic switch for the engineer who measures: keep the disposable container alive (with
    // TESTCONTAINERS_RYUK_DISABLED=true) so the statement can be EXPLAINed interactively
    if (process.env['TENDER_DENSE_KEEP'] !== '1') await stack?.stop();
  });

  // ── helpers over the exact final statement ──────────────────────────────────────────────────
  async function runStatement(
    from: string,
    to: string,
    branchId: string | null,
    maxMovements?: number,
  ): Promise<{ json: TenderTotalsReportJson; payloadBytes: number; sqlMs: number }> {
    const q = buildTenderTotalsReportQuery({
      tenantId: tenant,
      companyId: company,
      from,
      to,
      branchId,
      ...(maxMovements === undefined ? {} : { maxMovements }),
    });
    const t0 = performance.now();
    // the DEFAULT scoped-transaction timeout (≈ 20 s) applies, exactly as in production
    const rows = await runScoped(prisma, { tenantId: tenant }, (tx) =>
      tx.$queryRawUnsafe<{ report: string }[]>(q.text, ...q.values),
    );
    const sqlMs = performance.now() - t0;
    const raw = rows[0]!.report;
    return { json: JSON.parse(raw) as TenderTotalsReportJson, payloadBytes: raw.length, sqlMs };
  }

  async function explain(
    from: string,
    to: string,
    branchId: string | null,
    settings: readonly string[] = [],
    maxMovements?: number,
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
      { timeout: 900_000, maxWait: 60_000 },
    );
    return rows[0]!['QUERY PLAN'][0]!;
  }

  /** the LOGICAL movements of a window and their per-method figures — an independent oracle (a different SQL path) */
  async function oracle(from: string, to: string, branchId: string | null = null) {
    const f = (col: string): string => (branchId === null ? '' : `AND ${col} = '${branchId}'`);
    const cust = await admin.query(
      `SELECT p.method AS m, count(*)::text AS n, sum(p."amountMinor")::text AS total
         FROM payment p JOIN journal_entry je ON je."tenantId" = p."tenantId" AND je."companyId" = p."companyId"
          AND je."sourceKind" = 'customer_receipt_payment' AND je."sourceId" = p.id::text AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE p."companyId" = $1 ${f('p."branchId"')} GROUP BY p.method`,
      [company, from, to],
    );
    const anon = await admin.query(
      `SELECT p.method AS m, count(*)::text AS n, sum(p."amountMinor")::text AS total
         FROM payment p JOIN payment_allocation pa ON pa."paymentId" = p.id
         JOIN journal_entry je ON je."tenantId" = p."tenantId" AND je."companyId" = p."companyId"
          AND je."sourceKind" = 'walk_in_sale' AND je."sourceId" = pa."invoiceId"::text AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE p."companyId" = $1 ${f('p."branchId"')} GROUP BY p.method`,
      [company, from, to],
    );
    const rf = await admin.query(
      `SELECT r.method AS m, count(*)::text AS n, sum(r."amountMinor")::text AS total
         FROM refund r JOIN journal_entry je ON je."tenantId" = r."tenantId" AND je."companyId" = r."companyId"
          AND je."sourceKind" = 'refund' AND je."sourceId" = r.id::text AND je."postingDate" BETWEEN $2::date AND $3::date
        WHERE r."companyId" = $1 ${f('r."branchId"')} GROUP BY r.method`,
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
    const receipts = fold(cust.rows, anon.rows);
    const refunds = fold(rf.rows);
    const count = (m: Map<string, { n: number }>): number =>
      [...m.values()].reduce((n, v) => n + v.n, 0);
    return {
      receipts,
      refunds,
      receiptCount: count(receipts),
      refundCount: count(refunds),
      movements: count(receipts) + count(refunds),
    };
  }
  const figuresOf = (r: {
    receipts: {
      byMethod: readonly { method: string; receiptCount: number; receiptTotalMinor: string }[];
    };
    refunds: {
      byMethod: readonly { method: string; refundCount: number; refundTotalMinor: string }[];
    };
  }) => ({
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
  const TOO_LARGE = { code: 'REPORT_RESULT_TOO_LARGE', status: 422 };

  // ═══════════════════════════════ 1. the dataset really holds EXACTLY the limit ═══════════════════════════════
  it('the dataset: EXACTLY 100 000 logical movements in ONE window — in only 88 000 journals (a walk_in_sale journal books N Payments), over at least 2 branches', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const o = await oracle(from, to);
    const journals = await admin.query(
      `SELECT "sourceKind" AS k, count(*)::int AS n FROM journal_entry
        WHERE "companyId" = $1 AND "postingDate" BETWEEN $2::date AND $3::date GROUP BY "sourceKind" ORDER BY 1`,
      [company, from, to],
    );
    const by = Object.fromEntries(journals.rows.map((r) => [r['k'] as string, r['n'] as number]));
    metrics['window'] = { from, to, inclusiveDays: DAYS };
    metrics['denseWindow'] = {
      movements: o.movements,
      receiptMovements: o.receiptCount,
      refundMovements: o.refundCount,
      journalsByKind: by,
    };
    expect(o.movements).toBe(MOVEMENTS);
    expect(o.refundCount).toBe((MOVEMENTS / 100) * 8);
    // the LOGICAL unit: 12 000 walk_in_sale journals book 24 000 Payments
    const movementJournals =
      (by['customer_receipt_payment'] ?? 0) + (by['walk_in_sale'] ?? 0) + (by['refund'] ?? 0);
    expect(movementJournals).toBe((MOVEMENTS / 100) * 88);
    expect(o.movements).toBeGreaterThan(movementJournals);
    // noise that is NOT a movement exists in the same window
    for (const kind of [
      'payment_allocation',
      'invoice_ar',
      'credit_note',
      'customer_advance',
      'SETTLEMENT_BATCH',
    ]) {
      expect(by[kind] ?? 0, kind).toBeGreaterThan(0);
    }
    const perBranch = await admin.query(
      `SELECT p."branchId" AS b, count(*)::int AS n FROM payment p WHERE p."companyId" = $1 GROUP BY 1`,
      [company],
    );
    expect(perBranch.rows.length).toBeGreaterThanOrEqual(2);
    for (const m of TENDER_METHODS) expect(o.receipts.get(m)?.n ?? 0, m).toBeGreaterThan(0);
  }, 900_000);

  // ═══════════════════════════════ 2. EXACTLY the limit is accepted — timed ═══════════════════════════════
  it('ACCEPTED at exactly 100 000: warm-up, then repeated full-service runs — correct, ONE statement, and under the 12 s local engineering gate', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const o = await oracle(from, to);

    const w0 = performance.now();
    const warm = await inTenant(() => service.companyReport({ companyId: company, from, to }));
    metrics['warmUp'] = {
      serviceMs: Math.round(performance.now() - w0),
      receipts: warm.receipts.receiptCount,
      refunds: warm.refunds.refundCount,
      branches: warm.byBranch.length,
      ...memory(),
      container: containerMemory(),
    };
    expect(warm.receipts.receiptCount + warm.refunds.refundCount).toBe(MOVEMENTS);

    const runs: Record<string, unknown>[] = [];
    metrics['runs'] = runs; // recorded INCREMENTALLY: a failing run never loses the runs that preceded it
    const failures: string[] = [];
    for (let r = 1; r <= RUNS; r += 1) {
      const record: Record<string, unknown> = { run: r };
      runs.push(record);
      const st = await runStatement(from, to, null);
      record['sqlStatementMs'] = Math.round(st.sqlMs);
      record['payloadKB'] = Number((st.payloadBytes / 1024).toFixed(1));
      record['candidateMovements'] = st.json.candidateMovements;
      expect(st.json.candidateMovements).toBe(MOVEMENTS); // the gate counted EXACTLY the limit
      const statementsBefore = repo.statements;
      const transactionsBefore = repo.transactions;
      const s0 = performance.now();
      try {
        const report = await inTenant(() =>
          service.companyReport({ companyId: company, from, to }),
        );
        record['fullServiceMs'] = Math.round(performance.now() - s0);
        record['statementsInServicePath'] = repo.statements - statementsBefore;
        record['transactionsInServicePath'] = repo.transactions - transactionsBefore;
        Object.assign(record, memory(), { container: containerMemory() });
        expect(repo.statements - statementsBefore).toBe(1); // ONE statement — no second COUNT, no N+1
        expect(repo.transactions - transactionsBefore).toBe(1);
        const f = figuresOf(report);
        expect(nonZero(f.receipts)).toEqual(nonZero(o.receipts));
        expect(nonZero(f.refunds)).toEqual(nonZero(o.refunds));
        expect(report.receipts.receiptCount).toBe(o.receiptCount);
        expect(report.refunds.refundCount).toBe(o.refundCount);
        expect(report.reconciliation.reconciled).toBe(true);
        expect(report.byBranch.length).toBeGreaterThanOrEqual(2);
      } catch (e) {
        record['serviceError'] = String(e).slice(0, 300);
        record['serviceMsBeforeError'] = Math.round(performance.now() - s0);
        failures.push(`run ${r}: ${String(e).slice(0, 200)}`);
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
      localGateMs: LOCAL_GATE_MS,
    };
    expect(failures).toEqual([]);
    expect(Math.max(...full)).toBeLessThan(LOCAL_GATE_MS); // the local engineering gate (NOT a production SLA)
  }, 3_600_000);

  it('the BRANCH routes at exactly 100 000 company movements are ACCEPTED: each branch is reported from its own movements (the company window is within the limit)', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const perBranch: Record<string, unknown>[] = [];
    metrics['branchRoutesAtLimit'] = perBranch;
    let sum = 0;
    for (const branchId of branchIds) {
      const o = await oracle(from, to, branchId);
      const t0 = performance.now();
      const r = await inTenant(() =>
        service.branchReport({ companyId: company, branchId, from, to }),
      );
      const ms = Math.round(performance.now() - t0);
      perBranch.push({ branchId, movements: o.movements, ms });
      sum += o.movements;
      expect(r.receipts.receiptCount).toBe(o.receiptCount);
      expect(r.refunds.refundCount).toBe(o.refundCount);
      expect(r.reconciliation.reconciled).toBe(true);
      expect(ms).toBeLessThan(LOCAL_GATE_MS);
    }
    expect(sum).toBe(MOVEMENTS);
    // the sparse branch holds a tiny share yet its report needs the whole company window (stated limitation)
    const sparse = perBranch.find((b) => b['branchId'] === sparseBranch)!;
    expect(sparse['movements'] as number).toBeLessThan(MOVEMENTS * 0.05);
  }, 3_600_000);

  it('NO calendar cap: an 11-year civil-date range over the same ≤ 100 000-movement company is ACCEPTED and reports the same figures; the Trial Balance stays uncapped', async () => {
    const o = await oracle(await dayAt(0), await dayAt(DAYS - 1));
    const t0 = performance.now();
    const long = await inTenant(() =>
      service.companyReport({ companyId: company, from: '2020-01-01', to: '2030-12-31' }),
    );
    metrics['longRange'] = {
      from: '2020-01-01',
      to: '2030-12-31',
      ms: Math.round(performance.now() - t0),
    };
    expect(long.receipts.receiptCount + long.refunds.refundCount).toBe(MOVEMENTS);
    expect(nonZero(figuresOf(long).receipts)).toEqual(nonZero(o.receipts));
    const tb = await inTenant(() =>
      new TrialBalanceRepository(db).getForCompanyScoped({
        companyId: company,
        from: '2020-01-01',
        to: '2030-12-31',
      }),
    );
    expect(tb.from).toBe('2020-01-01');
  }, 3_600_000);

  // ═══════════════════════════════ 3. growth: near-linear, not quadratic ═══════════════════════════════
  it('cost grows near-linearly with the movements in the window (no O(n²)): the per-movement cost of the whole window is within 3× that of a quarter of it', async () => {
    const probes: { days: number; movements: number; sqlMs: number; microsPerMovement: number }[] =
      [];
    await runStatement(await dayAt(0), await dayAt(14), null); // warm the path
    for (const days of [91, 182, 273, DAYS]) {
      const from = await dayAt(0);
      const to = await dayAt(days - 1);
      const st = await runStatement(from, to, null);
      const o = await oracle(from, to);
      probes.push({
        days,
        movements: o.movements,
        sqlMs: Math.round(st.sqlMs),
        microsPerMovement: Math.round((st.sqlMs * 1000) / o.movements),
      });
    }
    metrics['growthProbe'] = probes;
    const quarter = probes[0]!;
    const whole = probes[probes.length - 1]!;
    expect(whole.movements).toBeGreaterThan(quarter.movements * 3);
    expect(whole.microsPerMovement).toBeLessThan(quarter.microsPerMovement * 3);
  }, 3_600_000);

  // ═══════════════════════════════ 4. the accepted plan (EXPLAIN ANALYZE, BUFFERS) ═══════════════════════════════
  it('EXPLAIN (ANALYZE, BUFFERS) at exactly 100 000: the gate counts the limit, the full path runs, journals are read once per stage, no O(n²) / nested seq scans / per-movement application N+1 / history-wide anti-join', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const doc = await explain(from, to, null);
    const nodes = flatten(doc.Plan);
    const rel = (name: string): PlanNode[] => nodes.filter((n) => n['Relation Name'] === name);
    const maxProcesses = 1 + Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0));
    // the heavy path DID run (the request was accepted)
    for (const r of ['payment', 'journal_line', 'account', 'refund', 'invoice']) {
      expect(rel(r).some(executed), `${r} runs for an accepted report`).toBe(true);
    }
    // no nested loop seq-scans a document table once per outer row
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
    // no materialised CTE is re-scanned once per OUTER ROW (a nested loop over a CTE Scan is O(n²))
    for (const n of nodes) {
      if (n['Node Type'] !== 'CTE Scan') continue;
      expect(
        (n['Actual Loops'] ?? 1) <= Math.max(50, BRANCHES * 4) || (n['Actual Rows'] ?? 0) <= 1,
        `CTE ${n['CTE Name']} is scanned once per outer row (${n['Actual Loops']} loops)`,
      ).toBe(true);
    }
    // the unique source index is probed only for the unproven remainder — never once per movement
    const sourceProbes = nodes
      .filter((n) => n['Index Name'] === 'journal_entry_tenantId_companyId_sourceKind_sourceId_key')
      .reduce((n, x) => n + (x['Actual Loops'] ?? 1), 0);
    expect(sourceProbes).toBeLessThanOrEqual(Math.ceil(MOVEMENTS / 10) + 5);
    // the gate's allocation read: ONE index-driven scan of the candidates' walk-in invoices (no per-journal probe, no seq scan)
    const gateAllocationScans = nodes.filter(
      (n) => n['Index Name'] === 'payment_allocation_invoiceId_idx',
    );
    expect(gateAllocationScans.length).toBeGreaterThan(0);
    for (const n of gateAllocationScans) expect(n['Actual Loops'] ?? 0).toBeLessThanOrEqual(1);
    // the candidate stage's LIMIT is the Limit node that returned the most rows (the other is the LIMIT 1 existence probe)
    const limitNode = nodes
      .filter((n) => n['Node Type'] === 'Limit')
      .sort((a, b) => (b['Actual Rows'] ?? 0) - (a['Actual Rows'] ?? 0))[0];
    metrics['explainAccepted'] = {
      explainExecutionTimeMs: Math.round(doc['Execution Time']),
      planningTimeMs: doc['Planning Time'],
      parallelWorkers: Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0)),
      nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
      joinTypes: [...new Set(nodes.map((n) => n['Join Type']).filter((x): x is string => !!x))],
      candidateLimitNodeActualRows: limitNode?.['Actual Rows'],
      journalEntryAccess: rel('journal_entry').map((n) => ({
        nodeType: n['Node Type'],
        index: n['Index Name'],
        rows: n['Actual Rows'],
        loops: n['Actual Loops'],
      })),
      sourceIndexProbes: sourceProbes,
      gateAllocationIndexScans: gateAllocationScans.map((n) => ({
        index: n['Index Name'],
        rows: n['Actual Rows'],
        loops: n['Actual Loops'],
      })),
      paymentAccess: rel('payment').map((n) => ({
        nodeType: n['Node Type'],
        rows: n['Actual Rows'],
        loops: n['Actual Loops'],
      })),
      paymentAllocationAccess: rel('payment_allocation').map((n) => ({
        nodeType: n['Node Type'],
        index: n['Index Name'],
        rows: n['Actual Rows'],
        loops: n['Actual Loops'],
      })),
    };
    metrics['explainAcceptedPlanTree'] = doc.Plan;
    metrics['explainAcceptedJit'] = doc.JIT ?? 'no JIT';
    // the gate's candidate scan saw EVERY movement journal (88 000 < the 100 001-row bound): it did not truncate an accepted report
    expect(limitNode?.['Actual Rows'] ?? 0).toBeLessThan(TENDER_REPORT_MAX_MOVEMENTS + 1);
  }, 3_600_000);

  // ═══════════════════════════════ 5. ONE MORE movement: 100 001 ═══════════════════════════════
  async function rejectionRuns(label: string, from: string, to: string, branchId: string | null) {
    const out: Record<string, unknown>[] = [];
    metrics[label] = out;
    for (let r = 1; r <= 3; r += 1) {
      const rssBefore = memory().nodeRssMB;
      const statements = repo.statements;
      const transactions = repo.transactions;
      const t0 = performance.now();
      let error:
        { code?: unknown; status?: unknown; message?: string; details?: unknown } | undefined;
      try {
        await inTenant<unknown>(() =>
          branchId === null
            ? service.companyReport({ companyId: company, from, to })
            : service.branchReport({ companyId: company, branchId, from, to }),
        );
      } catch (e) {
        error = e as typeof error;
      }
      const ms = Math.round(performance.now() - t0);
      out.push({
        run: r,
        code: error?.code,
        status: error?.status,
        ms,
        statementsIssued: repo.statements - statements,
        transactionsOpened: repo.transactions - transactions,
        rssBeforeMB: rssBefore,
        rssAfterMB: memory().nodeRssMB,
      });
      expect(error).toMatchObject(TOO_LARGE);
      expect(repo.statements - statements).toBe(1); // still ONE statement — the guard is its first stage
      expect(repo.transactions - transactions).toBe(1);
      expect(memory().nodeRssMB - rssBefore).toBeLessThan(250); // memory-safe: nothing heavy was read
    }
    return out;
  }

  it('ABOVE the limit: 100 000 + ONE valid movement → REPORT_RESULT_TOO_LARGE (422) three times, materially cheaper than the accepted report, memory-safe', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const acceptedP50 = (metrics['summary'] as { fullServiceMs: { p50: number } | null })
      .fullServiceMs?.p50;
    await addOneMovement();
    const o = await oracle(from, to);
    expect(o.movements).toBe(TENDER_REPORT_MAX_MOVEMENTS + 1); // EXACTLY limit + 1
    const rejections = await rejectionRuns('rejections', from, to, null);
    const times = rejections.map((x) => x['ms'] as number);
    metrics['rejectionSummary'] = { p50: median(times), worst: Math.max(...times), acceptedP50 };
    metrics['rejectionContainer'] = containerMemory();
    // materially cheaper than an accepted report of the same scope
    if (acceptedP50 !== undefined) expect(Math.max(...times)).toBeLessThan(acceptedP50 * 0.5);
  }, 3_600_000);

  it('the BRANCH routes ABOVE the company limit are REJECTED even though every branch holds far fewer movements — and the error discloses nothing of the siblings', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const errors: { message: string; details: unknown }[] = [];
    const perBranch: Record<string, unknown>[] = [];
    metrics['branchRoutesAboveCompanyLimit'] = perBranch;
    for (const branchId of branchIds) {
      const own = await oracle(from, to, branchId);
      expect(own.movements).toBeLessThan(TENDER_REPORT_MAX_MOVEMENTS); // far below the limit on its own
      const t0 = performance.now();
      let error:
        { code?: unknown; status?: unknown; message: string; details?: unknown } | undefined;
      try {
        await inTenant(() => service.branchReport({ companyId: company, branchId, from, to }));
      } catch (e) {
        error = e as typeof error;
      }
      perBranch.push({
        branchId,
        ownMovements: own.movements,
        rejectedMs: Math.round(performance.now() - t0),
      });
      expect(error).toMatchObject(TOO_LARGE);
      errors.push({ message: error!.message, details: error!.details });
      const wire = JSON.stringify({ message: error!.message, details: error!.details });
      expect(wire).not.toContain(String(own.movements));
      expect(wire).not.toContain(String(TENDER_REPORT_MAX_MOVEMENTS + 1));
      for (const id of branchIds) expect(wire).not.toContain(id);
      expect(wire).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    // the company route answers with the SAME words: nothing branch-specific is revealed
    let companyError: { message: string; details: unknown } | undefined;
    try {
      await inTenant(() => service.companyReport({ companyId: company, from, to }));
    } catch (e) {
      companyError = e as typeof companyError;
    }
    expect(companyError).toMatchObject(TOO_LARGE);
    for (const e of errors) {
      expect(e).toEqual({ message: companyError!.message, details: companyError!.details });
    }
    expect(errors[0]!.details).toEqual([
      { field: 'maxMovements', issue: String(TENDER_REPORT_MAX_MOVEMENTS) },
      { field: 'action', issue: 'narrow_date_range' },
    ]);
    // a narrower window of the SAME company (≤ the limit) is accepted again — the instruction the error gives works
    const narrowTo = await dayAt(DAYS - 200);
    const narrow = await inTenant(() =>
      service.branchReport({ companyId: company, branchId: branchIds[0]!, from, to: narrowTo }),
    );
    expect(narrow.reconciliation.reconciled).toBe(true);
  }, 3_600_000);

  // ═══════════════════════════════ 6. the rejected plan: the gate short-circuits ═══════════════════════════════
  it('EXPLAIN (ANALYZE, BUFFERS) at 100 001: NO heavy stage executes — payments, refunds, invoices, orders, GL lines, accounts and every integrity probe never run — and the cost is a fraction of the accepted plan', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const doc = await explain(from, to, null);
    // recorded BEFORE the assertions so a failing run never loses the evidence
    metrics['explainRejectedPlanTree'] = doc.Plan;
    metrics['explainRejectedJit'] = doc.JIT ?? 'no JIT';
    metrics['explainRejectedExecutionMs'] = Math.round(doc['Execution Time']);
    const nodes = flatten(doc.Plan);
    const rel = (name: string): PlanNode[] => nodes.filter((n) => n['Relation Name'] === name);
    const HEAVY = [
      'payment',
      'refund',
      'invoice',
      'order',
      'journal_line',
      'account',
      'customer_receivable',
    ];
    const heavy: Record<string, string> = {};
    for (const r of HEAVY) {
      const scans = rel(r);
      heavy[r] =
        scans.length === 0 ? 'absent' : scans.some(executed) ? 'EXECUTED' : 'never executed';
      expect(heavy[r], `${r} must never execute above the limit`).not.toBe('EXECUTED');
    }
    // the integrity probes of the journal table never run either; the ONLY journal_entry scan that executes is the gate's
    const probes = nodes.filter(
      (n) => n['Index Name'] === 'journal_entry_tenantId_companyId_sourceKind_sourceId_key',
    );
    expect(probes.some(executed), 'the source-index probes must not run').toBe(false);
    const journalScans = rel('journal_entry').filter(executed);
    const journalRows = journalScans.reduce(
      (n, x) => n + (x['Actual Rows'] ?? 0) * (x['Actual Loops'] ?? 1),
      0,
    );
    expect(journalRows).toBeLessThanOrEqual(TENDER_REPORT_MAX_MOVEMENTS + 1 + 2_000);
    // the gate's ONE allocation access: a single index-driven read of the candidates' walk-in invoices (the extra Payments
    // of a Multi Payment) — never a seq scan, never a second loop, never beyond the candidates
    const allocation = nodes.filter(
      (n) =>
        (n['Relation Name'] === 'payment_allocation' ||
          String(n['Index Name'] ?? '').startsWith('payment_allocation_')) &&
        executed(n),
    );
    expect(allocation.length, 'the gate reads the candidates’ allocations').toBeGreaterThan(0);
    for (const n of allocation) {
      expect(n['Node Type'], 'the only payment_allocation access above the limit').not.toBe(
        'Seq Scan',
      );
      if (n['Index Name'] !== undefined)
        expect(n['Index Name']).toBe('payment_allocation_invoiceId_idx');
      expect(n['Actual Loops'] ?? 0).toBeLessThanOrEqual(1);
      expect(n['Actual Rows'] ?? 0).toBeLessThanOrEqual(TENDER_REPORT_MAX_MOVEMENTS + 1);
    }
    const accepted = (metrics['explainAccepted'] as { explainExecutionTimeMs: number })
      .explainExecutionTimeMs;
    expect(doc['Execution Time']).toBeLessThan(accepted * 0.5);
    metrics['explainRejected'] = {
      explainExecutionTimeMs: Math.round(doc['Execution Time']),
      acceptedExplainExecutionTimeMs: accepted,
      heavyRelations: heavy,
      journalRowsScanned: journalRows,
      candidateAllocationRowsRead: allocation.reduce((n, x) => n + (x['Actual Rows'] ?? 0), 0),
      sourceIndexProbesExecuted: probes.some(executed),
      nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
      note: 'the heavy relations are listed in the plan but their scans never executed',
    };
    metrics['explainRejectedPlanTree'] = doc.Plan;
  }, 3_600_000);

  it("the short-circuit does NOT depend on the planner's current join choice: under forced alternatives no heavy input executes above the limit", async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const HEAVY = [
      'payment',
      'refund',
      'invoice',
      'order',
      'journal_line',
      'account',
      'customer_receivable',
    ];
    const variants: (readonly string[])[] = [
      ['enable_hashjoin = off'],
      ['enable_mergejoin = off'],
      ['enable_nestloop = off'],
      ['enable_hashjoin = off', 'enable_nestloop = off'],
      ['enable_mergejoin = off', 'enable_nestloop = off'],
      ['enable_seqscan = off'],
      ['enable_bitmapscan = off'],
      ['max_parallel_workers_per_gather = 0'],
      ['max_parallel_workers_per_gather = 4', 'parallel_setup_cost = 0', 'parallel_tuple_cost = 0'],
      ['enable_material = off'],
    ];
    const results: Record<string, unknown>[] = [];
    metrics['explainRejectedPlannerVariants'] = results;
    for (const settings of variants) {
      const d = await explain(from, to, null, settings);
      const ns = flatten(d.Plan);
      const ran = HEAVY.filter((r) => ns.filter((n) => n['Relation Name'] === r).some(executed));
      const probes = ns
        .filter(
          (n) => n['Index Name'] === 'journal_entry_tenantId_companyId_sourceKind_sourceId_key',
        )
        .some(executed);
      const allocSeq = ns
        .filter((n) => n['Relation Name'] === 'payment_allocation' && n['Node Type'] === 'Seq Scan')
        .some(executed);
      results.push({
        settings,
        heavyRelationsExecuted: ran,
        sourceProbesExecuted: probes,
        allocationSeqScanExecuted: allocSeq,
        explainExecutionTimeMs: Math.round(d['Execution Time']),
      });
      expect(
        ran,
        `planner variant [${settings.join(', ')}] must not execute a heavy input above the limit`,
      ).toEqual([]);
      expect(
        probes,
        `planner variant [${settings.join(', ')}] must not probe the source index`,
      ).toBe(false);
    }
  }, 3_600_000);

  it('the candidate LIMIT really bounds the scan: with the limit at 50 000 the gate stops at 50 001 candidate journals of the same 88 001 and NO heavy stage runs', async () => {
    const from = await dayAt(0);
    const to = await dayAt(DAYS - 1);
    const LOWER = 50_000;
    const doc = await explain(from, to, null, [], LOWER);
    const nodes = flatten(doc.Plan);
    const limit = nodes
      .filter((n) => n['Node Type'] === 'Limit')
      .sort((a, b) => (b['Actual Rows'] ?? 0) - (a['Actual Rows'] ?? 0))[0];
    expect(limit?.['Actual Rows']).toBe(LOWER + 1);
    const rel = (name: string): PlanNode[] => nodes.filter((n) => n['Relation Name'] === name);
    const scanned = rel('journal_entry')
      .filter(executed)
      .reduce((n, x) => n + (x['Actual Rows'] ?? 0) * (x['Actual Loops'] ?? 1), 0);
    expect(scanned).toBeLessThanOrEqual(LOWER + 1 + 2_000);
    for (const r of ['payment', 'refund', 'invoice', 'order', 'journal_line', 'account']) {
      expect(rel(r).some(executed), `${r} must never execute`).toBe(false);
    }
    const st = await runStatement(from, to, null, LOWER);
    expect(st.json.candidateMovements).toBeGreaterThan(LOWER);
    expect(st.json.candidateMovements).toBeLessThan(MOVEMENTS); // it stopped long before counting every movement
    metrics['explainBoundedScan'] = {
      limit: LOWER,
      limitNodeActualRows: limit?.['Actual Rows'],
      journalRowsScanned: scanned,
      explainExecutionTimeMs: Math.round(doc['Execution Time']),
      candidateMovementsCounted: st.json.candidateMovements,
    };
  }, 3_600_000);
});
