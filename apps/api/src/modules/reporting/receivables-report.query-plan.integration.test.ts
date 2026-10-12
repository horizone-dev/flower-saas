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
import { DomainError } from '../../common/errors/domain-error.js';
import {
  computeReceivableBalance,
  RECEIVABLE_SOURCE_TYPES,
} from '../receivables/receivable-balance.js';
import { ReceivablesReportRepository } from './receivables-report.repository.js';
import { ReceivablesReportService } from './receivables-report.service.js';
import {
  buildReceivablesReportQuery,
  RECEIVABLES_REPORT_MAX_RECEIVABLES,
} from './receivables-report.sql.js';

/**
 * Task 3b.10 Checkpoint D — RECEIVABLES CURRENT STATE: query-plan / volume gate.
 *
 * The report has no date window, so the measured axis is the CURRENT LEDGER SCALE: the number of receivables. One company
 * (5 branches, one sparse at 1 %), `RECEIVABLES_VOLUME_RECEIVABLES` receivables (default 2 000 — the CI size; 10 000 /
 * 50 000 / 100 000 for the recorded runs), ~ N/4 customers, a realistic source mixture generated set-based — 60 % INVOICE,
 * 20 % OPENING, 20 % CANCELLATION_CHARGE; zero to three payment applications, zero to two advance applications, a
 * CreditNote AR reduction on some invoices, every 13th receivable fully paid (zero outstanding) — with a sealed journal per
 * AR fact, journals of other kinds interleaved, a second company of the same tenant (15 %) and another tenant (5 %).
 * Every figure of the real statement is compared with a MODEL ORACLE: each receivable folded with the FROZEN
 * `computeReceivableBalance` in plain TypeScript.
 *
 *   RECEIVABLES_VOLUME_RECEIVABLES   the receivables of the target company (default 2 000)
 *   RECEIVABLES_VOLUME_RUNS          measured runs after the warm-up (default 3)
 *   RECEIVABLES_VOLUME_METRICS_FILE  when set, every observation is written there as JSON
 *
 * Every figure is an observation of a LOCAL TEST CONTAINER: "Local test-container benchmark; not production capacity."
 */
const N = Number(process.env['RECEIVABLES_VOLUME_RECEIVABLES'] ?? 2_000);
const RUNS = Math.max(3, Number(process.env['RECEIVABLES_VOLUME_RUNS'] ?? 3));
const METRICS_FILE = process.env['RECEIVABLES_VOLUME_METRICS_FILE'];
const BRANCHES = 5; // four busy, one sparse (the last, ≈ 1 %)
const DISCLAIMER = 'Local test-container benchmark; not production capacity.';
const LOCAL_GATE_MS = 12_000; // the local engineering gate against the ≈ 20 s scoped-transaction timeout (NOT an SLA)
const FULL_PAGE = 200;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'CTE Name'?: string;
  'Index Name'?: string;
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
const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
const memory = () => {
  const m = process.memoryUsage();
  return { nodeRssMB: mb(m.rss), nodeHeapUsedMB: mb(m.heapUsed), hostFreeMB: mb(freemem()) };
};
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

describe(
  'Receivables current state — query-plan / volume gate (task 3b.10 Checkpoint D)',
  {
    timeout: 3_600_000, // a 100 000-receivable run is minutes: every test inherits the long timeout
  },
  () => {
    let stack: TestStack;
    let db: DbService;
    let prisma: PrismaClient;
    let repo: CountingRepository;
    let service: ReceivablesReportService;
    let admin: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };

    const tenant = randomUUID();
    const otherTenant = randomUUID();
    const company = randomUUID();
    const branchIds = Array.from({ length: BRANCHES }, () => randomUUID());
    const sparseBranch = branchIds[BRANCHES - 1]!;
    const metrics: Record<string, unknown> = { disclaimer: DISCLAIMER, receivables: N };

    /** counts every raw statement issued inside the read callback (the "no N+1 / one snapshot" evidence) */
    class CountingRepository extends ReceivablesReportRepository {
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
                if (typeof prop === 'string' && /^\$(query|execute)/.test(prop))
                  this.statements += 1;
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
    /** one company's receivables, set-based (md5-derived ids, triggers off — the application path is exercised by the integration suite) */
    async function seedCompany(args: {
      tenantId: string;
      companyId: string;
      branches: string[];
      sparse: string | null;
      receivables: number;
      ns: string;
      noise: boolean;
    }): Promise<{ receivableCount: number; customers: number }> {
      const T = args.tenantId;
      const C = args.companyId;
      const M = Math.max(4, Math.floor(args.receivables / 4));
      await admin.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Receivables Volume Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
        [C, T],
      );
      for (const b of args.branches) {
        await admin.query(
          `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'B',now())`,
          [b, T, C],
        );
      }
      const acct: Record<string, string> = {};
      for (const [key, category, code, name] of [
        ['ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash'],
        ['ASSET.ACCOUNTS_RECEIVABLE', 'ASSET', '1300', 'AR'],
        ['LIABILITY.UNAPPLIED_RECEIPTS', 'LIABILITY', '2200', 'Unapplied'],
        ['LIABILITY.CUSTOMER_ADVANCES', 'LIABILITY', '2300', 'Advances'],
        ['EQUITY.OPENING_BALANCE', 'EQUITY', '3000', 'Opening'],
        ['REVENUE.SALES', 'REVENUE', '4000', 'Sales'],
        ['REVENUE.CANCELLATION_CHARGE', 'REVENUE', '4100', 'CancelFee'],
      ] as const) {
        acct[key] = randomUUID();
        await admin.query(
          `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
          [acct[key], T, C, key, category, code, name],
        );
      }
      const periodId = randomUUID();
      await admin.query(
        `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2020-01-01','2040-12-31','OPEN',now())`,
        [periodId, T, C],
      );
      const busy = args.branches.filter((b) => b !== args.sparse);

      await admin.query(`SET session_replication_role = 'replica'`);
      try {
        await admin.query(`DROP TABLE IF EXISTS rv`);
        await admin.query(`DROP TABLE IF EXISTS jf`);
        // the receivables: source type 60/20/20, branch 35/30/20/14/1 %, customer spread, amounts, applications
        await admin.query(
          `CREATE TEMP TABLE rv AS
           SELECT s.i, s.st, s.branch, s.cust, s.principal, s.full,
                  s.p0, s.p1, s.p2, s.v0, s.v1,
                  CASE WHEN s.st <> 'INVOICE' OR s.full THEN 0::bigint
                       WHEN s.i % 7 = 0 THEN s.principal - (s.p0 + s.p1 + s.p2) - (s.v0 + s.v1)
                       WHEN s.i % 11 = 0 THEN s.principal * 10 / 100
                       ELSE 0::bigint END AS crd
             FROM (
               SELECT g.i, g.st, g.branch, g.cust, g.principal, g.full,
                      CASE WHEN 0 < g.npay THEN CASE WHEN g.full THEN g.principal ELSE g.principal * (10 + ((g.i + 0) % 10)) / 100 END ELSE 0::bigint END AS p0,
                      CASE WHEN 1 < g.npay THEN g.principal * (10 + ((g.i + 1) % 10)) / 100 ELSE 0::bigint END AS p1,
                      CASE WHEN 2 < g.npay THEN g.principal * (10 + ((g.i + 2) % 10)) / 100 ELSE 0::bigint END AS p2,
                      CASE WHEN 0 < g.nadv THEN g.principal * (5 + ((g.i + 0) % 5)) / 100 ELSE 0::bigint END AS v0,
                      CASE WHEN 1 < g.nadv THEN g.principal * (5 + ((g.i + 1) % 5)) / 100 ELSE 0::bigint END AS v1
                 FROM (
                   SELECT i,
                          CASE WHEN i % 10 < 6 THEN 'INVOICE' WHEN i % 10 < 8 THEN 'OPENING' ELSE 'CANCELLATION_CHARGE' END AS st,
                          CASE WHEN $4::uuid IS NOT NULL AND i % 100 = 99 THEN $4::uuid
                               WHEN i % 100 < 35 THEN ($2::uuid[])[1]
                               WHEN i % 100 < 65 THEN ($2::uuid[])[2]
                               WHEN i % 100 < 85 THEN ($2::uuid[])[3]
                               ELSE ($2::uuid[])[LEAST($3::int, 4)] END AS branch,
                          1 + ((i * 7919) % $5::int) AS cust,
                          (1000 + ((i * 37) % 90000))::bigint AS principal,
                          (i % 13 = 0) AS full,
                          CASE WHEN i % 13 = 0 THEN 1 WHEN i % 10 < 6 THEN i % 4 ELSE i % 3 END AS npay,
                          CASE WHEN i % 13 = 0 THEN 0 ELSE (i / 4) % 3 END AS nadv
                     FROM generate_series(1, $1::int) i) g) s`,
          [args.receivables, busy, busy.length, args.sparse, M],
        );
        const id = (kind: string, ...parts: string[]): string =>
          `md5('${args.ns}:${kind}:' || ${parts.join(" || ':' || ")})::uuid`;
        await admin.query(
          `INSERT INTO customer (id,"tenantId","displayName","updatedAt")
         SELECT ${id('cust', 'j::text')}, $1::uuid, 'V ' || j, now() FROM generate_series(1, $2::int) j`,
          [T, M],
        );
        await admin.query(
          `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt")
         SELECT ${id('cca', 'j::text')}, $1::uuid, $2::uuid, ${id('cust', 'j::text')}, now() FROM generate_series(1, $3::int) j`,
          [T, C, M],
        );
        await admin.query(
          `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
                              "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
                              "taxTotalAmountMinor","totalAmountMinor")
         SELECT ${id('inv', 'r.i::text')}, $1::uuid, $2::uuid, r.branch, ${id('ord', 'r.i::text')}, 'INV-' || r.i, now(), DATE '2026-06-10',
                'AED', 2, r.principal, 0, 0, r.principal
           FROM rv r WHERE r.st = 'INVOICE'`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO cancellation_charge (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
                                          "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
                                          "priceTaxMode","roundingMode","reasonCode","accountingDate")
         SELECT ${id('chg', 'r.i::text')}, $1::uuid, $2::uuid, r.branch, ${id('cord', 'r.i::text')}, 'CC-' || r.i,
                r.principal, 0, r.principal, 'AED', 2, 'TAX_EXCLUSIVE', 'HALF_UP', 'CUSTOMER_REQUEST', DATE '2026-06-10'
           FROM rv r WHERE r.st = 'CANCELLATION_CHARGE'`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType",
                                          "invoiceId","cancellationChargeId","creditAuthorized","openingAmountMinor",
                                          "currencyCode","currencyExponent","openingEffectiveDate")
         SELECT ${id('rcv', 'r.i::text')}, $1::uuid, $2::uuid, r.branch, ${id('cca', 'r.cust::text')}, r.st,
                CASE WHEN r.st = 'INVOICE' THEN ${id('inv', 'r.i::text')} END,
                CASE WHEN r.st = 'CANCELLATION_CHARGE' THEN ${id('chg', 'r.i::text')} END,
                CASE WHEN r.st = 'INVOICE' THEN true END,
                CASE WHEN r.st = 'OPENING' THEN r.principal END,
                CASE WHEN r.st = 'OPENING' THEN 'AED' END, CASE WHEN r.st = 'OPENING' THEN 2 END,
                CASE WHEN r.st = 'OPENING' THEN DATE '2026-05-15' END
           FROM rv r`,
          [T, C],
        );
        // payment-side applications: PaymentAllocation (INVOICE) / CustomerReceivablePaymentApplication (the others)
        await admin.query(
          `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         SELECT ${id('pa', 'r.i::text', 's.k::text')}, $1::uuid, $2::uuid, r.branch, ${id('pay', 'r.i::text', 's.k::text')},
                ${id('inv', 'r.i::text')}, s.amt, 'AED', 2
           FROM rv r CROSS JOIN LATERAL (VALUES (0, r.p0), (1, r.p1), (2, r.p2)) AS s(k, amt)
          WHERE r.st = 'INVOICE' AND s.amt > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO customer_receivable_payment_application (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId",
                                                              "customerReceivableId","amountMinor","currencyCode","currencyExponent")
         SELECT ${id('crpa', 'r.i::text', 's.k::text')}, $1::uuid, $2::uuid, r.branch, ${id('cca', 'r.cust::text')},
                ${id('pay', 'r.i::text', 's.k::text')}, ${id('rcv', 'r.i::text')}, s.amt, 'AED', 2
           FROM rv r CROSS JOIN LATERAL (VALUES (0, r.p0), (1, r.p1), (2, r.p2)) AS s(k, amt)
          WHERE r.st <> 'INVOICE' AND s.amt > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId",
                                                   "amountMinor","currencyCode","currencyExponent")
         SELECT ${id('caa', 'r.i::text', 's.k::text')}, $1::uuid, $2::uuid, r.branch, ${id('adv', 'r.i::text', 's.k::text')},
                ${id('rcv', 'r.i::text')}, s.amt, 'AED', 2
           FROM rv r CROSS JOIN LATERAL (VALUES (0, r.v0), (1, r.v1)) AS s(k, amt)
          WHERE s.amt > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate",
                                  "currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor",
                                  "totalAmountMinor","arReductionMinor","advanceExcessMinor")
         SELECT ${id('cn', 'r.i::text')}, $1::uuid, $2::uuid, r.branch, ${id('inv', 'r.i::text')}, 'CN-' || r.i, now(), DATE '2026-06-10',
                'AED', 2, 'OTHER', r.crd, 0, r.crd, r.crd, 0
           FROM rv r WHERE r.st = 'INVOICE' AND r.crd > 0`,
          [T, C],
        );
        // the sealed journal of EVERY AR fact: kind, sourceId, branch, amount, side, the counter account
        const A = acct['ASSET.ACCOUNTS_RECEIVABLE']!;
        await admin.query(
          `CREATE TEMP TABLE jf AS
           SELECT ${id('je', "'invoice_ar'", 'r.i::text')} AS jid, 'invoice_ar'::text AS kind, ${id('inv', 'r.i::text')}::text AS sid,
                  r.branch, r.principal AS amt, 'D'::text AS side, $1::uuid AS other
             FROM rv r WHERE r.st = 'INVOICE'
           UNION ALL
           SELECT ${id('je', "'opening_receivable'", 'r.i::text')}, 'opening_receivable', ${id('rcv', 'r.i::text')}::text,
                  r.branch, r.principal, 'D', $2::uuid FROM rv r WHERE r.st = 'OPENING'
           UNION ALL
           SELECT ${id('je', "'cancellation_charge'", 'r.i::text')}, 'cancellation_charge', ${id('chg', 'r.i::text')}::text,
                  r.branch, r.principal, 'D', $3::uuid FROM rv r WHERE r.st = 'CANCELLATION_CHARGE'
           UNION ALL
           SELECT ${id('je', "'pa'", 'r.i::text', 's.k::text')}, 'payment_allocation', ${id('pa', 'r.i::text', 's.k::text')}::text,
                  r.branch, s.amt, 'C', $4::uuid
             FROM rv r CROSS JOIN LATERAL (VALUES (0, r.p0), (1, r.p1), (2, r.p2)) AS s(k, amt)
            WHERE r.st = 'INVOICE' AND s.amt > 0
           UNION ALL
           SELECT ${id('je', "'crpa'", 'r.i::text', 's.k::text')},
                  CASE r.st WHEN 'OPENING' THEN 'opening_receivable_payment_application' ELSE 'cancellation_charge_payment_application' END,
                  ${id('crpa', 'r.i::text', 's.k::text')}::text, r.branch, s.amt, 'C', $4::uuid
             FROM rv r CROSS JOIN LATERAL (VALUES (0, r.p0), (1, r.p1), (2, r.p2)) AS s(k, amt)
            WHERE r.st <> 'INVOICE' AND s.amt > 0
           UNION ALL
           SELECT ${id('je', "'caa'", 'r.i::text', 's.k::text')}, 'customer_advance_application', ${id('caa', 'r.i::text', 's.k::text')}::text,
                  r.branch, s.amt, 'C', $5::uuid
             FROM rv r CROSS JOIN LATERAL (VALUES (0, r.v0), (1, r.v1)) AS s(k, amt) WHERE s.amt > 0
           UNION ALL
           SELECT ${id('je', "'cn'", 'r.i::text')}, 'credit_note', ${id('cn', 'r.i::text')}::text, r.branch, r.crd, 'C', $1::uuid
             FROM rv r WHERE r.st = 'INVOICE' AND r.crd > 0`,
          [
            acct['REVENUE.SALES'],
            acct['EQUITY.OPENING_BALANCE'],
            acct['REVENUE.CANCELLATION_CHARGE'],
            acct['LIABILITY.UNAPPLIED_RECEIPTS'],
            acct['LIABILITY.CUSTOMER_ADVANCES'],
          ],
        );
        await admin.query(
          `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
         SELECT j.jid, $1::uuid, $2::uuid, $3::uuid, DATE '2026-06-10', j.kind, j.sid, 'AED', 'fp', now() FROM jf j`,
          [T, C, periodId],
        );
        await admin.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, j.jid, v.account_id, j.branch, v.dr, v.cr
           FROM jf j CROSS JOIN LATERAL (VALUES
                  ($3::uuid, CASE WHEN j.side = 'D' THEN j.amt ELSE 0::bigint END, CASE WHEN j.side = 'C' THEN j.amt ELSE 0::bigint END),
                  (j.other, CASE WHEN j.side = 'C' THEN j.amt ELSE 0::bigint END, CASE WHEN j.side = 'D' THEN j.amt ELSE 0::bigint END)
                ) AS v(account_id, dr, cr)`,
          [T, C, A],
        );
        if (args.noise) {
          // journals of OTHER kinds that never touch AR (receipts of unrelated Payments), and ONE manual AR journal that
          // must never be part of the control
          const K = Math.floor(args.receivables / 2);
          await admin.query(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, DATE '2026-06-10', 'customer_receipt_payment', gen_random_uuid()::text, 'AED', 'fp', now()
             FROM generate_series(1, $4::int)`,
            [T, C, periodId, K],
          );
          const manualEntry = randomUUID();
          await admin.query(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
           VALUES ($1,$2,$3,$4,DATE '2026-06-10','manual_adjustment',$5,'AED','fp',now())`,
            [manualEntry, T, C, periodId, randomUUID()],
          );
          for (const [key, dr, cr] of [
            ['ASSET.ACCOUNTS_RECEIVABLE', 777, 0],
            ['REVENUE.SALES', 0, 777],
          ] as const) {
            await admin.query(
              `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
             VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
              [T, C, manualEntry, acct[key], args.branches[0], dr, cr],
            );
          }
        }
      } finally {
        await admin.query(`SET session_replication_role = 'origin'`);
      }
      return { receivableCount: args.receivables, customers: M };
    }

    // ── the model oracle: every receivable folded with the FROZEN helper ─────────────────────────────
    interface ModelReceivable {
      branchId: string;
      customerId: string;
      sourceType: string;
      original: bigint;
      paidByPayment: bigint;
      paidByAdvance: bigint;
      credited: bigint;
      outstanding: bigint;
    }
    async function loadModel(companyId: string): Promise<ModelReceivable[]> {
      const receivables = (
        await admin.query(
          `SELECT cr.id, cr."branchId", cr."sourceType", cr."invoiceId", cr."cancellationChargeId",
                cr."openingAmountMinor"::text AS opening, x."customerId"
           FROM customer_receivable cr JOIN customer_company_account x ON x.id = cr."customerCompanyAccountId"
          WHERE cr."companyId" = $1`,
          [companyId],
        )
      ).rows as {
        id: string;
        branchId: string;
        sourceType: string;
        invoiceId: string | null;
        cancellationChargeId: string | null;
        opening: string | null;
        customerId: string;
      }[];
      const sumBy = async (sql: string): Promise<Map<string, bigint>> =>
        new Map(
          ((await admin.query(sql, [companyId])).rows as { k: string; s: string }[]).map((r) => [
            r.k,
            BigInt(r.s),
          ]),
        );
      const inv = await sumBy(
        `SELECT i.id::text AS k, i."totalAmountMinor"::text AS s FROM invoice i WHERE i."companyId" = $1`,
      );
      const chg = await sumBy(
        `SELECT c.id::text AS k, c."totalAmountMinor"::text AS s FROM cancellation_charge c WHERE c."companyId" = $1`,
      );
      const pa = await sumBy(
        `SELECT x."invoiceId"::text AS k, SUM(x."amountMinor")::text AS s FROM payment_allocation x WHERE x."companyId" = $1 GROUP BY x."invoiceId"`,
      );
      const crpa = await sumBy(
        `SELECT x."customerReceivableId"::text AS k, SUM(x."amountMinor")::text AS s FROM customer_receivable_payment_application x WHERE x."companyId" = $1 GROUP BY x."customerReceivableId"`,
      );
      const caa = await sumBy(
        `SELECT x."customerReceivableId"::text AS k, SUM(x."amountMinor")::text AS s FROM customer_advance_application x WHERE x."companyId" = $1 GROUP BY x."customerReceivableId"`,
      );
      const cn = await sumBy(
        `SELECT x."invoiceId"::text AS k, SUM(x."arReductionMinor")::text AS s FROM credit_note x WHERE x."companyId" = $1 GROUP BY x."invoiceId"`,
      );
      return receivables.map((r) => {
        const principal =
          r.sourceType === 'INVOICE'
            ? inv.get(r.invoiceId!)!
            : r.sourceType === 'OPENING'
              ? BigInt(r.opening!)
              : chg.get(r.cancellationChargeId!)!;
        const b = computeReceivableBalance({
          sourceType: r.sourceType,
          principalMinor: principal,
          paidByPaymentMinor:
            r.sourceType === 'INVOICE' ? (pa.get(r.invoiceId!) ?? 0n) : (crpa.get(r.id) ?? 0n),
          paidByAdvanceMinor: caa.get(r.id) ?? 0n,
          creditedMinor: r.sourceType === 'INVOICE' ? (cn.get(r.invoiceId!) ?? 0n) : 0n,
        });
        return {
          branchId: r.branchId,
          customerId: r.customerId,
          sourceType: r.sourceType,
          original: b.originalMinor,
          paidByPayment: b.paidByPaymentMinor,
          paidByAdvance: b.paidByAdvanceMinor,
          credited: b.creditedMinor,
          outstanding: b.outstandingMinor,
        };
      });
    }
    const figures = (rows: ModelReceivable[]) => {
      const sum = (f: (r: ModelReceivable) => bigint): string =>
        rows.reduce((n, r) => n + f(r), 0n).toString();
      return {
        receivableCount: rows.length,
        originalMinor: sum((r) => r.original),
        paidByPaymentMinor: sum((r) => r.paidByPayment),
        paidByAdvanceMinor: sum((r) => r.paidByAdvance),
        creditedMinor: sum((r) => r.credited),
        outstandingMinor: sum((r) => r.outstanding),
      };
    };
    const pick = (r: {
      receivableCount: number;
      originalMinor: string;
      paidByPaymentMinor: string;
      paidByAdvanceMinor: string;
      creditedMinor: string;
      outstandingMinor: string;
    }) => ({
      receivableCount: r.receivableCount,
      originalMinor: r.originalMinor,
      paidByPaymentMinor: r.paidByPaymentMinor,
      paidByAdvanceMinor: r.paidByAdvanceMinor,
      creditedMinor: r.creditedMinor,
      outstandingMinor: r.outstandingMinor,
    });
    const blocksExpected = (rows: ModelReceivable[]) => ({
      ...figures(rows),
      bySourceType: RECEIVABLE_SOURCE_TYPES.map((t) => ({
        sourceType: t,
        ...figures(rows.filter((r) => r.sourceType === t)),
      })),
    });
    const blocksOf = (r: {
      receivableCount: number;
      originalMinor: string;
      paidByPaymentMinor: string;
      paidByAdvanceMinor: string;
      creditedMinor: string;
      outstandingMinor: string;
      bySourceType: readonly {
        sourceType: string;
        receivableCount: number;
        originalMinor: string;
        paidByPaymentMinor: string;
        paidByAdvanceMinor: string;
        creditedMinor: string;
        outstandingMinor: string;
      }[];
    }) => ({
      ...pick(r),
      bySourceType: r.bySourceType.map((s) => ({ sourceType: s.sourceType, ...pick(s) })),
    });

    // ── runners ────────────────────────────────────────────────────────────────────────────────────
    async function runStatement(
      branchId: string | null,
      customerId: string | null,
      cursor: string | null,
      limit: number,
    ) {
      const q = buildReceivablesReportQuery({
        tenantId: tenant,
        companyId: company,
        branchId,
        customerId,
        cursor,
        limit,
      });
      const t0 = performance.now();
      const rows = await runScoped(
        prisma,
        { tenantId: tenant },
        (tx) => tx.$queryRawUnsafe<{ report: string }[]>(q.text, ...q.values),
        { timeout: 1_700_000, maxWait: 60_000 },
      );
      return { sqlMs: performance.now() - t0, payloadBytes: rows[0]!.report.length };
    }
    async function explain(
      branchId: string | null,
      customerId: string | null,
      cursor: string | null,
      limit: number,
      settings: readonly string[] = [],
    ): Promise<ExplainDoc> {
      const q = buildReceivablesReportQuery({
        tenantId: tenant,
        companyId: company,
        branchId,
        customerId,
        cursor,
        limit,
      });
      const rows = await runScoped(
        prisma,
        { tenantId: tenant },
        async (tx) => {
          for (const s of settings) await tx.$executeRawUnsafe(`SET LOCAL ${s}`);
          return tx.$queryRawUnsafe<{ 'QUERY PLAN': ExplainDoc[] }[]>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`,
            ...q.values,
          );
        },
        { timeout: 1_700_000, maxWait: 60_000 },
      );
      return rows[0]!['QUERY PLAN'][0]!;
    }
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

    let model: ModelReceivable[] = [];
    let customersSorted: string[] = [];

    beforeAll(async () => {
      stack = await startTestStack({ services: ['postgres'] });
      migrateTestDb(stack.postgres.url);
      db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
      prisma = db.appClient();
      repo = new CountingRepository(db);
      service = new ReceivablesReportService(repo);
      const pg = await import('pg');
      const c = new pg.default.Client({ connectionString: stack.postgres.url });
      await c.connect();
      admin = { query: (sql, params) => c.query(sql, params as unknown[]), end: () => c.end() };
      metrics['memoryBeforeSeeding'] = memory();

      const planId = randomUUID();
      const planVersionId = randomUUID();
      await admin.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
        planId,
        `rv-plan-${planId.slice(0, 8)}`,
      ]);
      await admin.query(
        `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
        [planVersionId, planId],
      );
      for (const t of [tenant, otherTenant]) {
        await admin.query(
          `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
          [t, `rv-${t.slice(0, 8)}`, planVersionId],
        );
      }
      await admin.query(
        `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
      );
      await admin.query(
        `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel","defaultTimezone","updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN','Asia/Dubai',now()) ON CONFLICT (code) DO NOTHING`,
      );
      const target = await seedCompany({
        tenantId: tenant,
        companyId: company,
        branches: branchIds,
        sparse: sparseBranch,
        receivables: N,
        ns: 'target',
        noise: true,
      });
      metrics['target'] = target;
      // a second company of the same tenant (15 %) and another tenant (5 %) — never part of the target's figures
      const b2 = Array.from({ length: BRANCHES }, () => randomUUID());
      await seedCompany({
        tenantId: tenant,
        companyId: randomUUID(),
        branches: b2,
        sparse: b2[BRANCHES - 1]!,
        receivables: Math.max(40, Math.floor(N * 0.15)),
        ns: 'sibling',
        noise: false,
      });
      const b3 = Array.from({ length: BRANCHES }, () => randomUUID());
      await seedCompany({
        tenantId: otherTenant,
        companyId: randomUUID(),
        branches: b3,
        sparse: b3[BRANCHES - 1]!,
        receivables: Math.max(40, Math.floor(N * 0.05)),
        ns: 'foreign',
        noise: false,
      });
      metrics['memoryAfterSeeding'] = memory();
      await admin.query(
        `VACUUM (ANALYZE) customer_receivable, customer_company_account, invoice, cancellation_charge, payment_allocation,
                         customer_receivable_payment_application, customer_advance_application, credit_note,
                         journal_entry, journal_line, account`,
      );
      model = await loadModel(company);
      customersSorted = [...new Set(model.map((m) => m.customerId))].sort();
      const card = await admin.query(
        `SELECT (SELECT count(*) FROM customer_receivable)::text AS receivables,
              (SELECT count(*) FROM customer_receivable WHERE "companyId" = $1)::text AS target_receivables,
              (SELECT count(*) FROM payment_allocation)::text AS allocations,
              (SELECT count(*) FROM customer_receivable_payment_application)::text AS receivable_payment_applications,
              (SELECT count(*) FROM customer_advance_application)::text AS advance_applications,
              (SELECT count(*) FROM credit_note)::text AS credit_notes,
              (SELECT count(*) FROM invoice)::text AS invoices,
              (SELECT count(*) FROM cancellation_charge)::text AS charges,
              (SELECT count(*) FROM journal_entry)::text AS journals,
              (SELECT count(*) FROM journal_line)::text AS lines,
              (SELECT count(*) FROM journal_entry WHERE "companyId" = $1)::text AS target_journals`,
        [company],
      );
      metrics['cardinalities'] = card.rows[0];
      metrics['customers'] = customersSorted.length;
    }, 3_600_000);

    afterAll(async () => {
      metrics['memoryAtEnd'] = memory();
      // a diagnostic switch for the engineer who measures: keep the disposable container alive (with
      // TESTCONTAINERS_RYUK_DISABLED=true) so the statement can be EXPLAINed interactively
      const keep = process.env['RECEIVABLES_VOLUME_KEEP'] === '1';
      if (keep) {
        metrics['kept'] = { url: stack?.postgres.url, tenant, company, branchIds, sparseBranch };
      }
      if (METRICS_FILE) writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
      await admin?.end();
      await prisma?.$disconnect();
      if (!keep) await stack?.stop();
    });

    const companyReport = (extra: { customerId?: string; cursor?: string; limit?: number } = {}) =>
      inTenant(() => service.companyReport({ companyId: company, ...extra }));
    const branchReport = (
      branchId: string,
      extra: { customerId?: string; cursor?: string; limit?: number } = {},
    ) => inTenant(() => service.branchReport({ companyId: company, branchId, ...extra }));

    // ═══════════════════════════ 1. correctness at volume ═══════════════════════════
    it('the dataset: every scenario class is present — three source types, zero / partial / full payment, advance applications, CreditNote reductions, zero-outstanding — over 5 branches, with other companies and tenants interleaved', () => {
      expect(model.length).toBe(N);
      for (const t of RECEIVABLE_SOURCE_TYPES) {
        expect(model.filter((m) => m.sourceType === t).length, t).toBeGreaterThan(0);
      }
      expect(
        model.some((m) => m.paidByPayment === 0n && m.paidByAdvance === 0n && m.credited === 0n),
      ).toBe(true);
      expect(model.some((m) => m.paidByPayment > 0n && m.outstanding > 0n)).toBe(true); // partial
      expect(
        model.some((m) => m.outstanding === 0n && m.credited === 0n && m.paidByPayment > 0n),
      ).toBe(true); // full
      expect(model.some((m) => m.paidByAdvance > 0n)).toBe(true);
      expect(model.some((m) => m.credited > 0n)).toBe(true);
      expect(model.some((m) => m.outstanding === 0n && m.credited > 0n)).toBe(true); // a full CreditNote reduction
      expect(new Set(model.map((m) => m.branchId)).size).toBe(BRANCHES);
      const sparse = model.filter((m) => m.branchId === sparseBranch).length;
      expect(sparse).toBeLessThan(N / 20);
      expect(customersSorted.length).toBeGreaterThan(N / 8);
      metrics['shape'] = {
        sparseBranchReceivables: sparse,
        zeroOutstanding: model.filter((m) => m.outstanding === 0n).length,
        customers: customersSorted.length,
      };
    });

    it('the company report equals the model oracle: summary, source types, byBranch, GL control — and ONE statement in ONE transaction', async () => {
      repo.statements = 0;
      repo.transactions = 0;
      const r = await companyReport({ limit: FULL_PAGE });
      expect([repo.statements, repo.transactions]).toEqual([1, 1]);
      expect(blocksOf(r)).toEqual(blocksExpected(model));
      expect(r.reconciliation.reconciled).toBe(true);
      expect(r.reconciliation.differenceMinor).toBe('0');
      const gl = await admin.query(
        `SELECT COALESCE(SUM(jl."debitMinor" - jl."creditMinor"), 0)::text AS s
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = 'ASSET.ACCOUNTS_RECEIVABLE'
          AND je."sourceKind" <> 'manual_adjustment'`,
        [company],
      );
      expect(r.reconciliation.glAccountsReceivableMinor).toBe(gl.rows[0]!['s']);
      expect(r.reconciliation.sourceOutstandingMinor).toBe(figures(model).outstandingMinor);
      // the manual AR journal is excluded: the whole AR account carries 777 more
      const all = await admin.query(
        `SELECT COALESCE(SUM(jl."debitMinor" - jl."creditMinor"), 0)::text AS s
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = 'ASSET.ACCOUNTS_RECEIVABLE'`,
        [company],
      );
      expect(BigInt(all.rows[0]!['s'] as string)).toBe(
        BigInt(r.reconciliation.glAccountsReceivableMinor) + 777n,
      );
      // byBranch: the exact per-branch figures, and company = Σ byBranch
      const branches = [...new Set(model.map((m) => m.branchId))].sort();
      expect(r.byBranch.map((b) => b.branchId)).toEqual(branches);
      for (const b of r.byBranch) {
        expect(blocksOf(b)).toEqual(blocksExpected(model.filter((m) => m.branchId === b.branchId)));
        expect(b.reconciliation.reconciled).toBe(true);
      }
      expect(r.byBranch.reduce((n, b) => n + BigInt(b.outstandingMinor), 0n).toString()).toBe(
        r.outstandingMinor,
      );
      expect(r.byBranch.reduce((n, b) => n + b.receivableCount, 0)).toBe(r.receivableCount);
    });

    it('per-customer pages: the first page, a DEEP cursor page and the last page equal the oracle; every page ≤ the limit; the cursor chains to null', async () => {
      const rowsExpected = (ids: string[]) =>
        ids.map((id) => ({ customerId: id, ...figures(model.filter((m) => m.customerId === id)) }));
      const first = await companyReport({ limit: FULL_PAGE });
      expect(first.customers.rows.map((r) => r.customerId)).toEqual(
        customersSorted.slice(0, FULL_PAGE),
      );
      expect(first.customers.rows.map((r) => ({ customerId: r.customerId, ...pick(r) }))).toEqual(
        rowsExpected(customersSorted.slice(0, FULL_PAGE)),
      );
      const total = customersSorted.length;
      expect(first.customers.nextCursor).toBe(
        total > FULL_PAGE ? customersSorted[FULL_PAGE - 1] : null,
      );
      // a deep page (the middle) and the last page
      const mid = Math.floor(total / 2);
      const deep = await companyReport({ cursor: customersSorted[mid]!, limit: FULL_PAGE });
      expect(deep.customers.rows.map((r) => r.customerId)).toEqual(
        customersSorted.slice(mid + 1, mid + 1 + FULL_PAGE),
      );
      expect(deep.customers.rows.map((r) => ({ customerId: r.customerId, ...pick(r) }))).toEqual(
        rowsExpected(customersSorted.slice(mid + 1, mid + 1 + FULL_PAGE)),
      );
      const lastCursor = customersSorted[Math.max(0, total - 3)]!;
      const last = await companyReport({ cursor: lastCursor, limit: FULL_PAGE });
      expect(last.customers.rows.map((r) => r.customerId)).toEqual(
        customersSorted.slice(Math.max(0, total - 2)),
      );
      expect(last.customers.nextCursor).toBeNull();
      // the whole-scope summary is the same on every page (never the page's own total)
      expect(blocksOf(deep)).toEqual(blocksOf(first));
      expect(deep.reconciliation).toEqual(first.reconciliation);
      // at CI size the chain is walked completely
      if (total <= 4 * FULL_PAGE) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
          const p = await companyReport({ limit: FULL_PAGE, ...(cursor ? { cursor } : {}) });
          seen.push(...p.customers.rows.map((r) => r.customerId));
          if (p.customers.nextCursor === null) break;
          cursor = p.customers.nextCursor;
        }
        expect(seen).toEqual(customersSorted);
      }
    });

    it('a dense branch, the SPARSE branch of the dense company and a single-customer filter equal the oracle', async () => {
      const dense = branchIds[0]!;
      const rd = await branchReport(dense, { limit: FULL_PAGE });
      expect(blocksOf(rd)).toEqual(blocksExpected(model.filter((m) => m.branchId === dense)));
      expect(rd.reconciliation.reconciled).toBe(true);
      const rs = await branchReport(sparseBranch, { limit: FULL_PAGE });
      expect(blocksOf(rs)).toEqual(
        blocksExpected(model.filter((m) => m.branchId === sparseBranch)),
      );
      expect(rs.receivableCount).toBeLessThan(rd.receivableCount / 10);
      const someone = customersSorted[Math.floor(customersSorted.length / 3)]!;
      const rc = await companyReport({ customerId: someone });
      expect(blocksOf(rc)).toEqual(blocksExpected(model.filter((m) => m.customerId === someone)));
      expect(rc.customers.rows).toHaveLength(1);
      expect(rc.reconciliation.reconciled).toBe(true);
    });

    // ═══════════════════════════ 2. performance ═══════════════════════════
    it('MEASURED: company (summary + control + first page), a deep page, a dense branch and the sparse branch — warm-up, then repeated full-service runs; memory observed', async () => {
      const total = customersSorted.length;
      const deepCursor = customersSorted[Math.floor(total / 2)]!;
      const scenarios: [
        string,
        () => Promise<unknown>,
        () => Promise<{ sqlMs: number; payloadBytes: number }>,
      ][] = [
        [
          'company',
          () => companyReport({ limit: FULL_PAGE }),
          () => runStatement(null, null, null, FULL_PAGE),
        ],
        [
          'companyDeepPage',
          () => companyReport({ cursor: deepCursor, limit: FULL_PAGE }),
          () => runStatement(null, null, deepCursor, FULL_PAGE),
        ],
        [
          'denseBranch',
          () => branchReport(branchIds[0]!, { limit: FULL_PAGE }),
          () => runStatement(branchIds[0]!, null, null, FULL_PAGE),
        ],
        [
          'sparseBranch',
          () => branchReport(sparseBranch, { limit: FULL_PAGE }),
          () => runStatement(sparseBranch, null, null, FULL_PAGE),
        ],
      ];
      const out: Record<string, unknown> = {};
      let worst = 0;
      for (const [name, service_, sql_] of scenarios) {
        const t0 = performance.now();
        await service_(); // warm-up
        const warm = Math.round(performance.now() - t0);
        const runs: {
          fullServiceMs: number;
          sqlStatementMs: number;
          payloadKB: number;
          rss: number;
          container: string[];
        }[] = [];
        for (let k = 0; k < RUNS; k++) {
          const s0 = performance.now();
          await service_();
          const fullServiceMs = Math.round(performance.now() - s0);
          const sql = await sql_();
          runs.push({
            fullServiceMs,
            sqlStatementMs: Math.round(sql.sqlMs),
            payloadKB: Math.round((sql.payloadBytes / 1024) * 10) / 10,
            rss: memory().nodeRssMB,
            container: k === RUNS - 1 ? containerMemory() : [],
          });
        }
        const full = runs.map((r) => r.fullServiceMs);
        out[name] = {
          warmUpMs: warm,
          runs,
          p50: median(full),
          worst: Math.max(...full),
          memory: memory(),
        };
        worst = Math.max(worst, ...full);
        metrics['measured'] = out;
      }
      metrics['worstFullServiceMs'] = worst;
      // the LOCAL engineering gate (NOT a production SLA): every scope well inside the ≈ 20 s scoped-transaction timeout
      expect(worst).toBeLessThan(LOCAL_GATE_MS);
    }, 3_600_000);

    it('cost scales with the receivables of the SCOPE: per-receivable cost of the branches (35 / 30 / 20 / 14 / 1 %) and of the company stays within a small factor — no O(n²)', async () => {
      const scopes: [string, string | null, number][] = branchIds.map((b, i) => [
        `branch${i}`,
        b,
        model.filter((m) => m.branchId === b).length,
      ]);
      scopes.push(['company', null, model.length]);
      const out: {
        scope: string;
        receivables: number;
        sqlMs: number;
        microsPerReceivable: number;
      }[] = [];
      for (const [name, b, n] of scopes) {
        await runStatement(b, null, null, FULL_PAGE); // warm
        const ms = median([
          (await runStatement(b, null, null, FULL_PAGE)).sqlMs,
          (await runStatement(b, null, null, FULL_PAGE)).sqlMs,
          (await runStatement(b, null, null, FULL_PAGE)).sqlMs,
        ]);
        out.push({
          scope: name,
          receivables: n,
          sqlMs: Math.round(ms),
          microsPerReceivable: Math.round((ms * 1000) / Math.max(1, n)),
        });
      }
      metrics['scopeScaling'] = out;
      const company = out.find((o) => o.scope === 'company')!;
      const dense = out.find((o) => o.scope === 'branch0')!;
      // a sub-linear fixed cost dominates tiny scopes, so the bound compares the two LARGE scopes only
      expect(company.sqlMs).toBeLessThan(
        dense.sqlMs * (company.receivables / dense.receivables) * 3 + 2_000,
      );
    }, 3_600_000);

    // ═══════════════════════════ 3. the plan ═══════════════════════════
    it('EXPLAIN (ANALYZE, BUFFERS): the company statement reads every source table a small constant number of times — no nested loop seq-scans per outer row, no CTE re-scan per row, journals matched by hash join or index probes', async () => {
      const doc = await explain(null, null, null, FULL_PAGE);
      metrics['explainCompanyPlanTree'] = doc.Plan;
      metrics['explainCompanyJit'] = doc.JIT ?? 'no JIT';
      const nodes = flatten(doc.Plan);
      const rel = (name: string) => nodes.filter((n) => n['Relation Name'] === name);
      const access = (name: string) =>
        rel(name).map((n) => ({
          nodeType: n['Node Type'],
          index: n['Index Name'],
          rows: n['Actual Rows'],
          loops: n['Actual Loops'],
        }));
      // no seq scan (of any table) is executed per outer row
      for (const n of nodes) {
        // the chart of accounts of ONE company is a few dozen rows: seq-scanning that reference table per outer row is
        // O(rows × 30) and the planner is right to do it — every OTHER table must never be
        if (n['Node Type'] !== 'Seq Scan' || n['Relation Name'] === 'account') continue;
        expect(
          n['Actual Loops'] ?? 1,
          `${n['Relation Name']} seq-scanned once per outer row`,
        ).toBeLessThanOrEqual(Math.max(4, BRANCHES));
      }
      // no materialised CTE is re-scanned once per OUTER ROW (a nested loop over a CTE Scan is O(n²))
      for (const n of nodes) {
        if (n['Node Type'] !== 'CTE Scan') continue;
        expect(
          (n['Actual Loops'] ?? 1) <= Math.max(50, BRANCHES * 4) || (n['Actual Rows'] ?? 0) <= 1,
          `CTE ${n['CTE Name']} is scanned once per outer row (${n['Actual Loops']} loops)`,
        ).toBe(true);
      }
      // the customer PII table is never read
      expect(rel('customer')).toEqual([]);
      expect(rel('payment')).toEqual([]);
      expect(rel('refund')).toEqual([]);
      const sourceTables = [
        'customer_receivable',
        'customer_company_account',
        'invoice',
        'cancellation_charge',
        'payment_allocation',
        'customer_receivable_payment_application',
        'customer_advance_application',
        'credit_note',
        'journal_entry',
        'journal_line',
        'account',
      ];
      metrics['explainCompany'] = {
        explainExecutionTimeMs: Math.round(doc['Execution Time']),
        planningTimeMs: doc['Planning Time'],
        parallelWorkers: Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0)),
        nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
        joinTypes: [...new Set(nodes.map((n) => n['Join Type']).filter((x): x is string => !!x))],
        tableAccess: Object.fromEntries(sourceTables.map((t) => [t, access(t)])),
      };
    }, 3_600_000);

    it('EXPLAIN (ANALYZE, BUFFERS): a dense branch, the sparse branch and a customer filter', async () => {
      const out: Record<string, unknown> = {};
      for (const [name, b, c] of [
        ['denseBranch', branchIds[0]!, null],
        ['sparseBranch', sparseBranch, null],
        ['oneCustomer', null, customersSorted[Math.floor(customersSorted.length / 3)]!],
      ] as const) {
        const doc = await explain(b, c, null, FULL_PAGE);
        const nodes = flatten(doc.Plan);
        for (const n of nodes) {
          // the chart of accounts of ONE company is a few dozen rows: seq-scanning that reference table per outer row is
          // O(rows × 30) and the planner is right to do it — every OTHER table must never be
          if (n['Node Type'] !== 'Seq Scan' || n['Relation Name'] === 'account') continue;
          expect(
            n['Actual Loops'] ?? 1,
            `${name}: ${n['Relation Name']} seq-scanned per outer row`,
          ).toBeLessThanOrEqual(Math.max(4, BRANCHES));
        }
        out[name] = {
          explainExecutionTimeMs: Math.round(doc['Execution Time']),
          jit: doc.JIT
            ? { Functions: doc.JIT['Functions'], Options: doc.JIT['Options'] }
            : 'no JIT',
          journalEntryAccess: nodes
            .filter((n) => n['Relation Name'] === 'journal_entry' && executed(n))
            .map((n) => ({
              nodeType: n['Node Type'],
              index: n['Index Name'],
              rows: n['Actual Rows'],
              loops: n['Actual Loops'],
            })),
          nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
        };
      }
      metrics['explainScopes'] = out;
    }, 3_600_000);

    // ═══════════════════════════ RD-1 — the density guard: the gate skips every heavy stage ═══════════════════════════
    /** the relations the heavy path reads: none may execute for a rejected scope */
    const HEAVY_RELATIONS = [
      'payment_allocation',
      'customer_receivable_payment_application',
      'customer_advance_application',
      'credit_note',
      'journal_entry',
      'journal_line',
      'account',
      'invoice',
      'cancellation_charge',
    ];
    /** another density limit (only the tests ask for one; production uses RECEIVABLES_REPORT_MAX_RECEIVABLES) */
    async function explainGate(
      branchId: string | null,
      customerId: string | null,
      maxReceivables: number,
      settings: readonly string[] = [],
    ): Promise<ExplainDoc> {
      const q = buildReceivablesReportQuery({
        tenantId: tenant,
        companyId: company,
        branchId,
        customerId,
        cursor: null,
        limit: FULL_PAGE,
        maxReceivables,
      });
      const rows = await runScoped(
        prisma,
        { tenantId: tenant },
        async (tx) => {
          for (const s of settings) await tx.$executeRawUnsafe(`SET LOCAL ${s}`);
          return tx.$queryRawUnsafe<{ 'QUERY PLAN': ExplainDoc[] }[]>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`,
            ...q.values,
          );
        },
        { timeout: 1_700_000, maxWait: 60_000 },
      );
      return rows[0]!['QUERY PLAN'][0]!;
    }
    const heavyExecuted = (doc: ExplainDoc): string[] =>
      flatten(doc.Plan)
        .filter(
          (n) =>
            n['Relation Name'] !== undefined &&
            HEAVY_RELATIONS.includes(n['Relation Name']) &&
            executed(n),
        )
        .map((n) => `${n['Relation Name']} (${n['Node Type']}, loops ${n['Actual Loops']})`);

    it('RD-1 density gate (EXPLAIN): above the limit NO heavy relation executes — under every planner alternative, for the company, a branch and a customer scope; at the limit the heavy path runs', async () => {
      const perCustomer = new Map<string, number>();
      for (const m of model)
        perCustomer.set(m.customerId, (perCustomer.get(m.customerId) ?? 0) + 1);
      const [bigCustomer, bigCount] = [...perCustomer.entries()].sort((a, b) => b[1] - a[1])[0]!;
      expect(bigCount).toBeGreaterThan(1);
      const branchSize = model.filter((m) => m.branchId === branchIds[0]).length;
      const scopes: [string, string | null, string | null, number][] = [
        ['company', null, null, N],
        ['dense branch', branchIds[0]!, null, branchSize],
        ['one customer', null, bigCustomer, bigCount],
      ];
      const alternatives: readonly string[][] = [
        [],
        ['enable_hashjoin = off'],
        ['enable_mergejoin = off'],
        ['enable_nestloop = off'],
        ['enable_seqscan = off'],
        ['enable_bitmapscan = off'],
        ['max_parallel_workers_per_gather = 0'],
        ['jit = off'],
      ];
      const out: Record<string, unknown> = {};
      for (const [name, branchId, customerId, size] of scopes) {
        // exactly the scope size: accepted — the heavy path RUNS (the gate is open; proves the test can see execution)
        const open = await explainGate(branchId, customerId, size);
        expect(
          heavyExecuted(open).length,
          `${name}: the gate at the limit is open`,
        ).toBeGreaterThan(0);
        for (const settings of alternatives) {
          const shut = await explainGate(branchId, customerId, size - 1, settings);
          expect(
            heavyExecuted(shut),
            `${name} [${settings.join(', ') || 'default planner'}]: a heavy relation executed above the limit`,
          ).toEqual([]);
          // the only receivable read above the limit is the gate's early-stopped scan: at most limit + 1 rows
          const gateScan = flatten(shut.Plan).filter(
            (n) => n['Relation Name'] === 'customer_receivable' && executed(n),
          );
          expect(gateScan.length, `${name}: the gate reads customer_receivable`).toBeGreaterThan(0);
        }
        out[name] = {
          size,
          acceptedExplainMs: Math.round(open['Execution Time']),
          rejectedExplainMs: Math.round(
            (await explainGate(branchId, customerId, size - 1))['Execution Time'],
          ),
        };
      }
      metrics['gateExplainCiSize'] = out;
    }, 3_600_000);

    it.skipIf(N !== 100_000)(
      'RD-1 at 100 000: ONE accepted final report at exactly the limit, then 100 001 receivables — rejected three times, one statement, no heavy stage, no count disclosed',
      async () => {
        const nTarget = Number(
          (
            await admin.query(
              `SELECT count(*)::text AS n FROM customer_receivable WHERE "companyId" = $1`,
              [company],
            )
          ).rows[0]!['n'],
        );
        expect(nTarget).toBe(100_000);

        // ── ONE accepted report at exactly the limit (the gate must not regress the accepted path) ──
        const a0 = performance.now();
        const accepted = await companyReport({ limit: FULL_PAGE });
        const acceptedMs = Math.round(performance.now() - a0);
        metrics['gateAccepted100k'] = { fullServiceMs: acceptedMs, memory: memory() };
        expect(accepted.receivableCount).toBe(100_000);
        expect(blocksOf(accepted)).toEqual(blocksExpected(model));
        expect(accepted.reconciliation.reconciled).toBe(true);
        expect(acceptedMs).toBeLessThan(LOCAL_GATE_MS); // the local engineering gate — NOT a production SLA

        // ── ONE receivable more: 100 001 ──
        await admin.query(`SET session_replication_role = 'replica'`);
        const extra = (
          await admin.query(
            `INSERT INTO customer_receivable
             SELECT (jsonb_populate_record(NULL::customer_receivable, to_jsonb(t) || jsonb_build_object('id', uuidv7()::text))).*
               FROM customer_receivable t WHERE t."companyId" = $1 AND t."sourceType" = 'OPENING' LIMIT 1
             RETURNING id`,
            [company],
          )
        ).rows[0]!['id'] as string;
        await admin.query(`SET session_replication_role = 'origin'`);
        try {
          const times: number[] = [];
          for (let k = 0; k < 3; k++) {
            repo.statements = 0;
            repo.transactions = 0;
            const r0 = performance.now();
            let err: unknown;
            try {
              await companyReport({ limit: FULL_PAGE });
            } catch (e) {
              err = e;
            }
            times.push(Math.round(performance.now() - r0));
            expect(err, 'the 100 001-receivable company report is rejected').toBeInstanceOf(
              DomainError,
            );
            const e = err as DomainError;
            expect([e.code, e.status]).toEqual(['REPORT_RESULT_TOO_LARGE', 422]);
            expect(e.details).toEqual([
              { field: 'maxReceivables', issue: '100000' },
              { field: 'action', issue: 'narrow_scope' },
            ]);
            expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/100001|100 001/);
            expect([repo.statements, repo.transactions]).toEqual([1, 1]);
          }
          metrics['gateRejected100001'] = { fullServiceMs: times, p50: median(times) };
          // a branch of the same company is still judged on its OWN receivables (≪ 100 000). The extra receivable is a raw row
          // with no journal, so the branch that holds it would (rightly) fail its integrity check: judge another branch
          const extraBranch = (
            await admin.query(`SELECT "branchId" AS b FROM customer_receivable WHERE id = $1`, [
              extra,
            ])
          ).rows[0]!['b'] as string;
          const otherBranch = branchIds.find((b) => b !== extraBranch && b !== sparseBranch)!;
          const denseBranch = await branchReport(otherBranch, { limit: FULL_PAGE });
          expect(denseBranch.receivableCount).toBeLessThan(100_000);
          // the rejected statement: a tiny payload and NO heavy relation executed (EXPLAIN ANALYZE, BUFFERS)
          const q = buildReceivablesReportQuery({
            tenantId: tenant,
            companyId: company,
            branchId: null,
            customerId: null,
            cursor: null,
            limit: FULL_PAGE,
          });
          const payload = await runScoped(
            prisma,
            { tenantId: tenant },
            (tx) => tx.$queryRawUnsafe<{ report: string }[]>(q.text, ...q.values),
            { timeout: 1_700_000, maxWait: 60_000 },
          );
          expect(payload[0]!.report.length).toBeLessThan(4_096);
          const doc = await explainGate(null, null, RECEIVABLES_REPORT_MAX_RECEIVABLES);
          expect(heavyExecuted(doc)).toEqual([]);
          const nodes = flatten(doc.Plan);
          const gate = nodes.filter(
            (n) => n['Relation Name'] === 'customer_receivable' && executed(n),
          );
          expect(gate.length).toBeGreaterThan(0);
          metrics['gateRejected100001'] = {
            fullServiceMs: times,
            p50: median(times),
            branchInsideRejectedCompany: { receivables: denseBranch.receivableCount },
            explainExecutionTimeMs: Math.round(doc['Execution Time']),
            planningTimeMs: doc['Planning Time'],
            payloadBytes: payload[0]!.report.length,
            jit: doc.JIT
              ? { Functions: doc.JIT['Functions'], Options: doc.JIT['Options'] }
              : 'no JIT',
            heavyRelationsExecuted: heavyExecuted(doc),
            executedRelations: [
              ...new Set(
                nodes
                  .filter((n) => n['Relation Name'] !== undefined && executed(n))
                  .map((n) => n['Relation Name']),
              ),
            ],
            neverExecutedRelations: [
              ...new Set(
                nodes
                  .filter((n) => n['Relation Name'] !== undefined && !executed(n))
                  .map((n) => n['Relation Name']),
              ),
            ],
            nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
          };
          // materially cheaper than the accepted report of the same company
          expect(median(times)).toBeLessThan(acceptedMs / 2);
        } finally {
          await admin.query(`SET session_replication_role = 'replica'`);
          await admin.query(`DELETE FROM customer_receivable WHERE id = $1`, [extra]);
          await admin.query(`SET session_replication_role = 'origin'`);
        }
      },
      3_600_000,
    );
  },
);
