import { randomUUID } from 'node:crypto';
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
import { computePaymentConsumption } from '../receivables/payment-consumption.js';
import { computeAdvanceBalance } from '../receivables/receivable-balance.js';
import { CustomerLiabilitiesReportRepository } from './customer-liabilities-report.repository.js';
import { CustomerLiabilitiesReportService } from './customer-liabilities-report.service.js';
import {
  buildCustomerLiabilitiesReportQuery,
  CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS,
} from './customer-liabilities-report.sql.js';

/**
 * Task 3b.10 Checkpoint E — CUSTOMER LIABILITIES CURRENT STATE: query-plan / volume gate.
 *
 * The report has no date window, so the measured axis is the CURRENT LEDGER SCALE: the number of customer-attributable
 * Payments (`LIABILITIES_VOLUME_PAYMENTS`, default 2 000 — the CI size; 10 000 / 50 000 / 100 000 for the recorded runs) and
 * the Advances around them. One company (5 branches, one sparse at 1 %), ~ N/4 customers, a realistic mixture generated
 * set-based — 14 % INVOICE_COLLECTION Payments (an order + invoice each) and 86 % CUSTOMER_RECEIPT; ten receipt classes
 * (fully unapplied, partially allocated, fully allocated in two allocations, half / fully converted to an Advance, applied to
 * an OPENING receivable, allocated + converted); PAYMENT-origin Advances from those conversions plus OPENING (N / 10) and
 * CREDIT_NOTE (N / 8) ones; applications on every origin; actual refunds, PENDING and FAILED reservations on CreditNote
 * Advances — with a sealed journal per source fact on its own liability account, a second company of the same tenant (15 %)
 * and another tenant (5 %). Every figure of the real statement is compared with a MODEL ORACLE: each advance and each
 * Payment folded with the FROZEN `computeAdvanceBalance` / `computePaymentConsumption` in plain TypeScript.
 *
 *   LIABILITIES_VOLUME_PAYMENTS      the customer Payments of the target company (default 2 000)
 *   LIABILITIES_VOLUME_ROOTS         (EL-1 density closure) build EXACTLY this many liability roots — customer-attributable
 *                                    Payments + CustomerAdvances — in the target company (100 000 runs the accepted-limit and
 *                                    100 001-rejection test); it replaces LIABILITIES_VOLUME_PAYMENTS
 *   LIABILITIES_VOLUME_RUNS          measured runs after the warm-up (default 3)
 *   LIABILITIES_VOLUME_METRICS_FILE  when set, every observation is written there as JSON
 *
 * Every figure is an observation of a LOCAL TEST CONTAINER: "Local test-container benchmark; not production capacity."
 */
const ROOTS = Number(process.env['LIABILITIES_VOLUME_ROOTS'] ?? 0);
/** the Payments of classes 6 / 7 / 9 (a conversion to an Advance) among 1..p — the PAYMENT-origin advances the generator makes */
const convertedPayments = (p: number): number =>
  Math.floor(p / 10) * 3 + [0, 0, 0, 0, 0, 0, 1, 2, 2, 3][p % 10]!;
const N =
  ROOTS > 0
    ? Math.round(ROOTS / 1.525)
    : Number(process.env['LIABILITIES_VOLUME_PAYMENTS'] ?? 2_000);
/** the OPENING advances: N / 10 — or, for an exact-roots run, whatever makes Payments + Advances exactly ROOTS */
const OPENINGS =
  ROOTS > 0 ? ROOTS - N - convertedPayments(N) - Math.floor(N / 8) : Math.floor(N / 10);
const RUNS = Math.max(3, Number(process.env['LIABILITIES_VOLUME_RUNS'] ?? 3));
const METRICS_FILE = process.env['LIABILITIES_VOLUME_METRICS_FILE'];
const BRANCHES = 5; // four busy, one sparse (the last, ≈ 1 %)
const DISCLAIMER = 'Local test-container benchmark; not production capacity.';
const LOCAL_GATE_MS = 12_000; // the local engineering gate against the ≈ 20 s scoped-transaction timeout (NOT an SLA)
const FULL_PAGE = 200;
const ADV_ACCOUNT = 'LIABILITY.CUSTOMER_ADVANCES';
const UNAPPLIED_ACCOUNT = 'LIABILITY.UNAPPLIED_RECEIPTS';
const ADV_KINDS = [
  'customer_advance',
  'opening_advance',
  'credit_note',
  'customer_advance_application',
  'refund',
];
const UNAPPLIED_KINDS = [
  'customer_receipt_payment',
  'payment_allocation',
  'opening_receivable_payment_application',
  'cancellation_charge_payment_application',
  'customer_advance',
];

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
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

describe(
  'Customer liabilities — query-plan / volume gate (task 3b.10 Checkpoint E)',
  {
    timeout: 3_600_000, // a 100 000-payment run is minutes: every test inherits the long timeout
  },
  () => {
    let stack: TestStack;
    let db: DbService;
    let prisma: PrismaClient;
    let repo: CountingRepository;
    let service: CustomerLiabilitiesReportService;
    let admin: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };

    const tenant = randomUUID();
    const otherTenant = randomUUID();
    const company = randomUUID();
    const branchIds = Array.from({ length: BRANCHES }, () => randomUUID());
    const sparseBranch = branchIds[BRANCHES - 1]!;
    const metrics: Record<string, unknown> = { disclaimer: DISCLAIMER, payments: N };

    /** counts every raw statement issued inside the read callback (the "no N+1 / one snapshot" evidence) */
    class CountingRepository extends CustomerLiabilitiesReportRepository {
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
    /** one company's liabilities, set-based (md5-derived ids, triggers off — the application path is exercised by the integration suite) */
    async function seedCompany(args: {
      tenantId: string;
      companyId: string;
      branches: string[];
      sparse: string | null;
      payments: number;
      openings?: number;
      ns: string;
      noise: boolean;
    }): Promise<{ payments: number; advances: number; customers: number }> {
      const T = args.tenantId;
      const C = args.companyId;
      const M = Math.max(4, Math.floor(args.payments / 4));
      await admin.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
         VALUES ($1,$2,'Liabilities Volume Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
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
      const id = (kind: string, ...parts: string[]): string =>
        `md5('${args.ns}:${kind}:' || ${parts.join(" || ':' || ")})::uuid`;
      const branchPick = (iExpr: string): string =>
        `CASE WHEN $4::uuid IS NOT NULL AND ${iExpr} % 100 = 99 THEN $4::uuid
              WHEN ${iExpr} % 100 < 35 THEN ($2::uuid[])[1]
              WHEN ${iExpr} % 100 < 65 THEN ($2::uuid[])[2]
              WHEN ${iExpr} % 100 < 85 THEN ($2::uuid[])[3]
              ELSE ($2::uuid[])[LEAST($3::int, 4)] END`;

      await admin.query(`SET session_replication_role = 'replica'`);
      try {
        for (const t of ['pv', 'av', 'jf']) await admin.query(`DROP TABLE IF EXISTS ${t}`);
        // the Payments: purpose (14 % invoice collection), branch 35/30/20/14/1 %, customer spread, amount, receipt class
        await admin.query(
          `CREATE TEMP TABLE pv AS
           SELECT g.i, g.branch, g.cust, g.ic, g.amt, g.cls,
                  CASE g.cls WHEN 3 THEN g.amt * 40 / 100 WHEN 4 THEN g.amt * 40 / 100 WHEN 5 THEN g.amt * 60 / 100
                             WHEN 9 THEN g.amt * 30 / 100 ELSE 0::bigint END AS a1,
                  CASE g.cls WHEN 5 THEN g.amt - g.amt * 60 / 100 ELSE 0::bigint END AS a2,
                  CASE g.cls WHEN 8 THEN g.amt * 50 / 100 ELSE 0::bigint END AS crp,
                  CASE g.cls WHEN 6 THEN g.amt * 50 / 100 WHEN 7 THEN g.amt WHEN 9 THEN g.amt * 30 / 100 ELSE 0::bigint END AS conv
             FROM (SELECT i, ${branchPick('i')} AS branch, 1 + ((i::bigint * 7919) % $5::int) AS cust, (i % 7 = 0) AS ic,
                          (1000 + ((i * 37) % 90000))::bigint AS amt, i % 10 AS cls
                     FROM generate_series(1, $1::int) i) g`,
          [args.payments, busy, busy.length, args.sparse, M],
        );
        // the Advances: PAYMENT-origin (the conversions) + OPENING (N / 10) + CREDIT_NOTE (N / 8)
        await admin.query(
          `CREATE TEMP TABLE av AS
           SELECT s.kind, s.j, s.branch, s.cust, s.amt, s.spid,
                  CASE WHEN s.j % 3 < 2 THEN CASE s.kind WHEN 'P' THEN s.amt * 30 / 100 WHEN 'O' THEN s.amt * 20 / 100 ELSE s.amt * 10 / 100 END ELSE 0::bigint END AS app1,
                  CASE WHEN s.kind = 'C' AND s.j % 5 = 0 THEN s.amt * 15 / 100 ELSE 0::bigint END AS refd,
                  CASE WHEN s.kind = 'C' AND s.j % 11 = 0 THEN s.amt * 10 / 100 ELSE 0::bigint END AS rsv,
                  CASE WHEN s.kind = 'C' AND s.j % 17 = 0 THEN s.amt * 5 / 100 ELSE 0::bigint END AS fail
             FROM (
               SELECT 'P'::text AS kind, p.i AS j, p.branch, p.cust, p.conv AS amt, ${id('pay', 'p.i::text')} AS spid FROM pv p WHERE p.conv > 0
               UNION ALL
               SELECT 'O', j, ${branchPick('j')}, 1 + ((j::bigint * 104729) % $5::int), (500 + ((j * 53) % 20000))::bigint, NULL::uuid
                 FROM generate_series(1, $6::int) j
               UNION ALL
               SELECT 'C', j, ${branchPick('j')}, 1 + ((j::bigint * 15485863) % $5::int), (2000 + ((j * 61) % 30000))::bigint, NULL::uuid
                 FROM generate_series(1, ($1::int / 8)) j
             ) s`,
          [
            args.payments,
            busy,
            busy.length,
            args.sparse,
            M,
            args.openings ?? Math.floor(args.payments / 10),
          ],
        );
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
        // the 14 % invoice-collection Payments: an order (customer-linked) + an invoice each
        await admin.query(
          `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId","customerId",kind,status,
                              "currencyCode","currencyExponent","documentDiscountMode","documentDiscountBps","documentDiscountAmountMinor",
                              "documentDiscountReason","commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion",
                              "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
           SELECT ${id('ord', 'p.i::text')}, $1::uuid, $2::uuid, p.branch, p.branch, ${id('cust', 'p.cust::text')}, 'WALK_IN', 'DRAFT',
                  'AED', 2, 'NONE', NULL, 0, NULL, 'fp', 2, 'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', now()
             FROM pv p WHERE p.ic`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
                              "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
                              "taxTotalAmountMinor","totalAmountMinor")
           SELECT ${id('inv', 'p.i::text')}, $1::uuid, $2::uuid, p.branch, ${id('ord', 'p.i::text')}, 'INV-' || p.i, now(), DATE '2026-06-10',
                  'AED', 2, p.amt, 0, 0, p.amt
             FROM pv p WHERE p.ic`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO payment_attempt (id,"tenantId","companyId","branchId","receiptPurpose","orderId","targetInvoiceId",
                                      "customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,
                                      "orderCommercialSnapshotFingerprintAtCreation","orderVersionAtCreation","idempotencyKey","updatedAt")
           SELECT ${id('att', 'p.i::text')}, $1::uuid, $2::uuid, p.branch,
                  CASE WHEN p.ic THEN 'INVOICE_COLLECTION' ELSE 'CUSTOMER_RECEIPT' END,
                  CASE WHEN p.ic THEN ${id('ord', 'p.i::text')} END, CASE WHEN p.ic THEN ${id('inv', 'p.i::text')} END,
                  CASE WHEN p.ic THEN NULL ELSE ${id('cca', 'p.cust::text')} END,
                  'CASH', p.amt, 'AED', 2, 'CAPTURED',
                  CASE WHEN p.ic THEN 'fp' END, CASE WHEN p.ic THEN 1 END, 'idem-${args.ns}-' || p.i, now()
             FROM pv p`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
           SELECT ${id('pay', 'p.i::text')}, $1::uuid, $2::uuid, p.branch, ${id('att', 'p.i::text')}, 'CASH', p.amt, 'AED', 2 FROM pv p`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
           SELECT ${id('pa', 'p.i::text', 's.k::text')}, $1::uuid, $2::uuid, p.branch, ${id('pay', 'p.i::text')},
                  ${id('inv', 'p.i::text')}, s.amt, 'AED', 2
             FROM pv p CROSS JOIN LATERAL (VALUES (0, p.a1), (1, p.a2)) AS s(k, amt)
            WHERE s.amt > 0`,
          [T, C],
        );
        // class 8: a receivable application — the Payment is applied to an OPENING receivable of its customer
        await admin.query(
          `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType",
                                          "invoiceId","cancellationChargeId","creditAuthorized","openingAmountMinor",
                                          "currencyCode","currencyExponent","openingEffectiveDate")
           SELECT ${id('rcv', 'p.i::text')}, $1::uuid, $2::uuid, p.branch, ${id('cca', 'p.cust::text')}, 'OPENING',
                  NULL, NULL, NULL, p.amt, 'AED', 2, DATE '2026-05-15'
             FROM pv p WHERE p.crp > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO customer_receivable_payment_application (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId",
                                                              "customerReceivableId","amountMinor","currencyCode","currencyExponent")
           SELECT ${id('crpa', 'p.i::text')}, $1::uuid, $2::uuid, p.branch, ${id('cca', 'p.cust::text')},
                  ${id('pay', 'p.i::text')}, ${id('rcv', 'p.i::text')}, p.crp, 'AED', 2
             FROM pv p WHERE p.crp > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId",
                                       "amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
           SELECT ${id('adv', 'a.kind', 'a.j::text')}, $1::uuid, $2::uuid, a.branch, ${id('cca', 'a.cust::text')},
                  CASE a.kind WHEN 'P' THEN 'PAYMENT' WHEN 'O' THEN 'OPENING' ELSE 'CREDIT_NOTE' END,
                  CASE WHEN a.kind = 'P' THEN a.spid END, a.amt, 'AED', 2, CASE WHEN a.kind = 'O' THEN DATE '2026-05-20' END
             FROM av a`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId",
                                                   "amountMinor","currencyCode","currencyExponent")
           SELECT ${id('caa', 'a.kind', 'a.j::text')}, $1::uuid, $2::uuid, a.branch, ${id('adv', 'a.kind', 'a.j::text')},
                  ${id('rcvx', 'a.kind', 'a.j::text')}, a.app1, 'AED', 2
             FROM av a WHERE a.app1 > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId",
                                                          "amountMinor","currencyCode","currencyExponent")
           SELECT ${id('cra', 'a.j::text')}, $1::uuid, $2::uuid, a.branch, ${id('adv', 'a.kind', 'a.j::text')},
                  ${id('refund', 'a.j::text')}, a.refd, 'AED', 2
             FROM av a WHERE a.refd > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO credit_note_coverage_release (id,"tenantId","companyId","branchId","creditNoteId","sourceKind",
                                                   "sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId",
                                                   "releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
           SELECT ${id('rel', 'a.j::text')}, $1::uuid, $2::uuid, a.branch, ${id('cn', 'a.j::text')}, 'PAYMENT_ALLOCATION',
                  ${id('relpa', 'a.j::text')}, NULL, ${id('relpay', 'a.j::text')}, a.amt, 'AED', 2, ${id('adv', 'a.kind', 'a.j::text')}
             FROM av a WHERE a.kind = 'C'`,
          [T, C],
        );
        // PENDING reservations (counted) and FAILED ones (a row, never a reservation) on CreditNote Advances
        await admin.query(
          `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode",
                                     "currencyExponent","providerCredentialId","providerKey",state,"idempotencyKey","updatedAt")
           SELECT ${id('ratt', 'a.j::text', 's.st')}, $1::uuid, $2::uuid, a.branch, ${id('relpay', 'a.j::text')}, s.amt, 'AED', 2,
                  ${id('cred', 'a.j::text')}, 'tap', s.st, 'ridem-${args.ns}-' || a.j || '-' || s.st, now()
             FROM av a CROSS JOIN LATERAL (VALUES ('PENDING', a.rsv), ('FAILED', a.fail)) AS s(st, amt)
            WHERE a.kind = 'C' AND s.amt > 0`,
          [T, C],
        );
        await admin.query(
          `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId",
                                                             "creditNoteCoverageReleaseId","customerAdvanceId","amountMinor",
                                                             "currencyCode","currencyExponent")
           SELECT ${id('rsv', 'a.j::text', 's.st')}, $1::uuid, $2::uuid, a.branch, ${id('ratt', 'a.j::text', 's.st')},
                  ${id('rel', 'a.j::text')}, ${id('adv', 'a.kind', 'a.j::text')}, s.amt, 'AED', 2
             FROM av a CROSS JOIN LATERAL (VALUES ('PENDING', a.rsv), ('FAILED', a.fail)) AS s(st, amt)
            WHERE a.kind = 'C' AND s.amt > 0`,
          [T, C],
        );
        // the sealed journal of EVERY source fact (two lines each: debit account / credit account)
        const U = acct['LIABILITY.UNAPPLIED_RECEIPTS']!;
        const V = acct['LIABILITY.CUSTOMER_ADVANCES']!;
        const AR = acct['ASSET.ACCOUNTS_RECEIVABLE']!;
        const CASH = acct['ASSET.CASH_ON_HAND']!;
        const EQ = acct['EQUITY.OPENING_BALANCE']!;
        const REV = acct['REVENUE.SALES']!;
        await admin.query(
          `CREATE TEMP TABLE jf AS
           SELECT ${id('je', "'r'", 'p.i::text')} AS jid, 'customer_receipt_payment'::text AS kind, ${id('pay', 'p.i::text')}::text AS sid,
                  p.branch, p.amt, $1::uuid AS dra, $2::uuid AS cra
             FROM pv p
           UNION ALL
           SELECT ${id('je', "'pa'", 'p.i::text', 's.k::text')}, 'payment_allocation', ${id('pa', 'p.i::text', 's.k::text')}::text, p.branch, s.amt, $3::uuid, $4::uuid
             FROM pv p CROSS JOIN LATERAL (VALUES (0, p.a1), (1, p.a2)) AS s(k, amt) WHERE s.amt > 0
           UNION ALL
           SELECT ${id('je', "'crpa'", 'p.i::text')}, 'opening_receivable_payment_application', ${id('crpa', 'p.i::text')}::text, p.branch, p.crp, $3::uuid, $4::uuid
             FROM pv p WHERE p.crp > 0
           UNION ALL
           SELECT ${id('je', "'conv'", 'a.j::text')}, 'customer_advance', ${id('adv', 'a.kind', 'a.j::text')}::text, a.branch, a.amt, $3::uuid, $5::uuid
             FROM av a WHERE a.kind = 'P'
           UNION ALL
           SELECT ${id('je', "'open'", 'a.j::text')}, 'opening_advance', ${id('adv', 'a.kind', 'a.j::text')}::text, a.branch, a.amt, $6::uuid, $5::uuid
             FROM av a WHERE a.kind = 'O'
           UNION ALL
           SELECT ${id('je', "'cn'", 'a.j::text')}, 'credit_note', ${id('cn', 'a.j::text')}::text, a.branch, a.amt, $7::uuid, $5::uuid
             FROM av a WHERE a.kind = 'C'
           UNION ALL
           SELECT ${id('je', "'caa'", 'a.kind', 'a.j::text')}, 'customer_advance_application', ${id('caa', 'a.kind', 'a.j::text')}::text, a.branch, a.app1, $5::uuid, $4::uuid
             FROM av a WHERE a.app1 > 0
           UNION ALL
           SELECT ${id('je', "'ref'", 'a.j::text')}, 'refund', ${id('refund', 'a.j::text')}::text, a.branch, a.refd, $5::uuid, $8::uuid
             FROM av a WHERE a.refd > 0`,
          [CASH, U, U, AR, V, EQ, REV, CASH],
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
                    (j.dra, j.amt, 0::bigint),
                    (j.cra, 0::bigint, j.amt)
                  ) AS v(account_id, dr, cr)`,
          [T, C],
        );
        if (args.noise) {
          // journals of OTHER kinds hitting the liability accounts (a manual one must never be part of a control)
          const manualEntry = randomUUID();
          await admin.query(
            `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint","sealedAt")
             VALUES ($1,$2,$3,$4,DATE '2026-06-10','manual_adjustment',$5,'AED','fp',now())`,
            [manualEntry, T, C, periodId, randomUUID()],
          );
          for (const [accountId, dr, cr] of [
            [V, 0, 777],
            [U, 333, 0],
            [EQ, 444, 0],
          ] as const) {
            await admin.query(
              `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
               VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
              [T, C, manualEntry, accountId, args.branches[0], dr, cr],
            );
          }
        }
      } finally {
        await admin.query(`SET session_replication_role = 'origin'`);
      }
      const adv = await admin.query(
        `SELECT count(*)::text AS n FROM customer_advance WHERE "companyId" = $1`,
        [C],
      );
      return { payments: args.payments, advances: Number(adv.rows[0]!['n']), customers: M };
    }

    // ── the model oracle: every advance and Payment folded with the FROZEN helpers ─────────────────────
    interface ModelAdvance {
      branchId: string;
      customerId: string;
      sourceType: string;
      principal: bigint;
      applied: bigint;
      refunded: bigint;
      reserved: bigint;
    }
    interface ModelPayment {
      branchId: string;
      customerId: string;
      original: bigint;
      allocated: bigint;
      receivableApplied: bigint;
      converted: bigint;
    }
    const sums = async (sql: string): Promise<Map<string, bigint>> =>
      new Map(
        ((await admin.query(sql, [company])).rows as { k: string; s: string }[]).map((r) => [
          r.k,
          BigInt(r.s),
        ]),
      );
    async function loadModel(
      companyId: string,
    ): Promise<{ advances: ModelAdvance[]; payments: ModelPayment[] }> {
      void companyId;
      const accounts = (
        await admin.query(
          `SELECT id, "customerId" FROM customer_company_account WHERE "companyId" = $1`,
          [company],
        )
      ).rows as { id: string; customerId: string }[];
      const customerOfAccount = new Map(accounts.map((a) => [a.id, a.customerId]));
      const accountOfCustomer = new Map(accounts.map((a) => [a.customerId, a.id]));
      const advRows = (
        await admin.query(
          `SELECT id, "branchId", "sourceType", "amountMinor"::text AS amt, "customerCompanyAccountId" AS cca
             FROM customer_advance WHERE "companyId" = $1`,
          [company],
        )
      ).rows as { id: string; branchId: string; sourceType: string; amt: string; cca: string }[];
      const applied = await sums(
        `SELECT "customerAdvanceId"::text AS k, SUM("amountMinor")::text AS s FROM customer_advance_application WHERE "companyId" = $1 GROUP BY 1`,
      );
      const refunded = await sums(
        `SELECT "customerAdvanceId"::text AS k, SUM("amountMinor")::text AS s FROM customer_advance_refund_application WHERE "companyId" = $1 GROUP BY 1`,
      );
      const reserved = await sums(
        `SELECT rr."customerAdvanceId"::text AS k, SUM(rr."amountMinor")::text AS s
           FROM refund_attempt_entitlement_reservation rr JOIN refund_attempt ra ON ra.id = rr."refundAttemptId"
          WHERE rr."companyId" = $1 AND ra.state = 'PENDING' GROUP BY 1`,
      );
      const advances = advRows.map((a) => ({
        branchId: a.branchId,
        customerId: customerOfAccount.get(a.cca)!,
        sourceType: a.sourceType,
        principal: BigInt(a.amt),
        applied: applied.get(a.id) ?? 0n,
        refunded: refunded.get(a.id) ?? 0n,
        reserved: reserved.get(a.id) ?? 0n,
      }));
      const orderCustomer = new Map(
        (
          (
            await admin.query(
              `SELECT i.id, o."customerId" FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE i."companyId" = $1`,
              [company],
            )
          ).rows as { id: string; customerId: string | null }[]
        ).map((r) => [r.id, r.customerId]),
      );
      const payRows = (
        await admin.query(
          `SELECT p.id, p."branchId", p."amountMinor"::text AS amt, pa."receiptPurpose" AS purpose,
                  pa."customerCompanyAccountId" AS cca, pa."targetInvoiceId" AS inv
             FROM payment p JOIN payment_attempt pa ON pa.id = p."sourceAttemptId" WHERE p."companyId" = $1`,
          [company],
        )
      ).rows as {
        id: string;
        branchId: string;
        amt: string;
        purpose: string;
        cca: string | null;
        inv: string | null;
      }[];
      const allocated = await sums(
        `SELECT "paymentId"::text AS k, SUM("amountMinor")::text AS s FROM payment_allocation WHERE "companyId" = $1 GROUP BY 1`,
      );
      const receivableApplied = await sums(
        `SELECT "paymentId"::text AS k, SUM("amountMinor")::text AS s FROM customer_receivable_payment_application WHERE "companyId" = $1 GROUP BY 1`,
      );
      const converted = await sums(
        `SELECT "sourcePaymentId"::text AS k, SUM("amountMinor")::text AS s FROM customer_advance WHERE "companyId" = $1 AND "sourcePaymentId" IS NOT NULL GROUP BY 1`,
      );
      const payments: ModelPayment[] = [];
      for (const p of payRows) {
        let customerId: string | null;
        if (p.purpose === 'CUSTOMER_RECEIPT') {
          customerId = p.cca === null ? null : (customerOfAccount.get(p.cca) ?? null);
        } else {
          const oc = p.inv === null ? null : (orderCustomer.get(p.inv) ?? null);
          customerId = oc !== null && accountOfCustomer.has(oc) ? oc : null;
        }
        if (customerId === null) continue;
        payments.push({
          branchId: p.branchId,
          customerId,
          original: BigInt(p.amt),
          allocated: allocated.get(p.id) ?? 0n,
          receivableApplied: receivableApplied.get(p.id) ?? 0n,
          converted: converted.get(p.id) ?? 0n,
        });
      }
      return { advances, payments };
    }
    const advFigures = (rows: ModelAdvance[]) => {
      let principal = 0n;
      let applied = 0n;
      let refunded = 0n;
      let reserved = 0n;
      let book = 0n;
      let available = 0n;
      for (const a of rows) {
        const f = computeAdvanceBalance({
          principalMinor: a.principal,
          appliedMinor: a.applied,
          refundedMinor: a.refunded,
          reservedMinor: a.reserved,
        });
        principal += f.principalMinor;
        applied += f.appliedMinor;
        refunded += f.refundedMinor;
        reserved += f.reservedMinor;
        book += f.bookedRemainingMinor;
        available += f.availableMinor;
      }
      return {
        advanceCount: rows.length,
        originalAdvanceMinor: principal.toString(),
        appliedMinor: applied.toString(),
        actuallyRefundedMinor: refunded.toString(),
        bookLiabilityMinor: book.toString(),
        pendingRefundReservationMinor: reserved.toString(),
        availableMinor: available.toString(),
      };
    };
    const unFigures = (rows: ModelPayment[]) => {
      let original = 0n;
      let allocated = 0n;
      let receivableApplied = 0n;
      let converted = 0n;
      let unapplied = 0n;
      let withUnapplied = 0;
      for (const p of rows) {
        const remaining = computePaymentConsumption({
          paymentAmountMinor: p.original,
          allocatedToInvoicesMinor: p.allocated + p.receivableApplied,
          convertedToAdvanceMinor: p.converted,
        }).remainingMinor;
        original += p.original;
        allocated += p.allocated;
        receivableApplied += p.receivableApplied;
        converted += p.converted;
        unapplied += remaining;
        if (remaining > 0n) withUnapplied += 1;
      }
      return {
        paymentCount: rows.length,
        paymentCountWithUnapplied: withUnapplied,
        originalReceiptMinor: original.toString(),
        paymentAllocationMinor: allocated.toString(),
        receivablePaymentApplicationMinor: receivableApplied.toString(),
        allocatedToReceivablesMinor: (allocated + receivableApplied).toString(),
        convertedToAdvanceMinor: converted.toString(),
        unappliedReceiptMinor: unapplied.toString(),
      };
    };
    const glNet = async (
      accountKey: string,
      kinds: string[],
      branchId: string | null,
    ): Promise<bigint> =>
      BigInt(
        (
          await admin.query(
            `SELECT COALESCE(SUM(l."creditMinor" - l."debitMinor"), 0)::text AS s
               FROM journal_entry je JOIN journal_line l ON l."journalEntryId" = je.id JOIN account a ON a.id = l."accountId"
              WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key = $2 AND je."sourceKind" = ANY($3::text[])
                AND ($4::uuid IS NULL OR l."branchId" = $4)`,
            [company, accountKey, kinds, branchId],
          )
        ).rows[0]!['s'] as string,
      );
    type Blocks = {
      advances: ReturnType<typeof advFigures> & {
        bySourceType: readonly ({ sourceType: string } & ReturnType<typeof advFigures>)[];
      };
      unappliedReceipts: ReturnType<typeof unFigures>;
    };
    const expectedBlocks = async (
      model: { advances: ModelAdvance[]; payments: ModelPayment[] },
      branchId: string | null,
      customerId: string | null,
    ) => {
      const advs = model.advances.filter(
        (a) =>
          (branchId === null || a.branchId === branchId) &&
          (customerId === null || a.customerId === customerId),
      );
      const pays = model.payments.filter(
        (p) =>
          (branchId === null || p.branchId === branchId) &&
          (customerId === null || p.customerId === customerId),
      );
      return {
        advances: {
          ...advFigures(advs),
          bySourceType: ['PAYMENT', 'OPENING', 'CREDIT_NOTE'].map((t) => ({
            sourceType: t,
            ...advFigures(advs.filter((a) => a.sourceType === t)),
          })),
        },
        unappliedReceipts: unFigures(pays),
      };
    };
    const sourceBlocksOf = (r: {
      advances: Blocks['advances'] & { reconciliation: unknown };
      unappliedReceipts: Blocks['unappliedReceipts'] & { reconciliation: unknown };
    }) => {
      const { reconciliation: _a, ...advances } = r.advances;
      const { reconciliation: _u, ...unappliedReceipts } = r.unappliedReceipts;
      void _a;
      void _u;
      return { advances, unappliedReceipts };
    };

    // ── runners ────────────────────────────────────────────────────────────────────────────────────
    async function runStatement(
      branchId: string | null,
      customerId: string | null,
      cursor: string | null,
      limit: number,
    ) {
      const q = buildCustomerLiabilitiesReportQuery({
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
    ): Promise<ExplainDoc> {
      const q = buildCustomerLiabilitiesReportQuery({
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
        (tx) =>
          tx.$queryRawUnsafe<{ 'QUERY PLAN': ExplainDoc[] }[]>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`,
            ...q.values,
          ),
        { timeout: 1_700_000, maxWait: 60_000 },
      );
      return rows[0]!['QUERY PLAN'][0]!;
    }
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

    let model: { advances: ModelAdvance[]; payments: ModelPayment[] } = {
      advances: [],
      payments: [],
    };
    let customersSorted: string[] = [];

    beforeAll(async () => {
      stack = await startTestStack({ services: ['postgres'] });
      migrateTestDb(stack.postgres.url);
      db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
      prisma = db.appClient();
      repo = new CountingRepository(db);
      service = new CustomerLiabilitiesReportService(repo);
      const pg = await import('pg');
      const c = new pg.default.Client({ connectionString: stack.postgres.url });
      await c.connect();
      admin = { query: (sql, params) => c.query(sql, params as unknown[]), end: () => c.end() };
      metrics['memoryBeforeSeeding'] = memory();

      const planId = randomUUID();
      const planVersionId = randomUUID();
      await admin.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
        planId,
        `lv-plan-${planId.slice(0, 8)}`,
      ]);
      await admin.query(
        `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
        [planVersionId, planId],
      );
      for (const t of [tenant, otherTenant]) {
        await admin.query(
          `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
          [t, `lv-${t.slice(0, 8)}`, planVersionId],
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
        payments: N,
        openings: OPENINGS,
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
        payments: Math.max(40, Math.floor(N * 0.15)),
        ns: 'sibling',
        noise: false,
      });
      const b3 = Array.from({ length: BRANCHES }, () => randomUUID());
      await seedCompany({
        tenantId: otherTenant,
        companyId: randomUUID(),
        branches: b3,
        sparse: b3[BRANCHES - 1]!,
        payments: Math.max(40, Math.floor(N * 0.05)),
        ns: 'foreign',
        noise: false,
      });
      metrics['memoryAfterSeeding'] = memory();
      await admin.query(
        `VACUUM (ANALYZE) customer_advance, customer_advance_application, customer_advance_refund_application, refund_attempt,
                         refund_attempt_entitlement_reservation, credit_note_coverage_release, payment, payment_attempt,
                         payment_allocation, customer_receivable_payment_application, customer_receivable, customer_company_account,
                         invoice, "order", journal_entry, journal_line, account`,
      );
      model = await loadModel(company);
      customersSorted = [
        ...new Set([
          ...model.advances.map((a) => a.customerId),
          ...model.payments.map((p) => p.customerId),
        ]),
      ].sort();
      const card = await admin.query(
        `SELECT (SELECT count(*) FROM payment)::text AS payments,
                (SELECT count(*) FROM payment WHERE "companyId" = $1)::text AS target_payments,
                (SELECT count(*) FROM customer_advance)::text AS advances,
                (SELECT count(*) FROM customer_advance WHERE "companyId" = $1)::text AS target_advances,
                (SELECT count(*) FROM customer_advance_application)::text AS applications,
                (SELECT count(*) FROM customer_advance_refund_application)::text AS refund_applications,
                (SELECT count(*) FROM refund_attempt_entitlement_reservation)::text AS reservations,
                (SELECT count(*) FROM payment_allocation)::text AS allocations,
                (SELECT count(*) FROM customer_receivable_payment_application)::text AS receivable_applications,
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
      const keep = process.env['LIABILITIES_VOLUME_KEEP'] === '1';
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
    it('the dataset: every scenario class is present — three advance origins, applications, refunds, PENDING and FAILED reservations, every receipt class — over 5 branches, with other companies and tenants interleaved', () => {
      expect(model.payments.length).toBe(N);
      if (ROOTS > 0) expect(model.payments.length + model.advances.length).toBe(ROOTS);
      for (const t of ['PAYMENT', 'OPENING', 'CREDIT_NOTE']) {
        expect(model.advances.filter((a) => a.sourceType === t).length, t).toBeGreaterThan(0);
      }
      expect(model.advances.some((a) => a.applied > 0n)).toBe(true);
      expect(model.advances.some((a) => a.refunded > 0n)).toBe(true);
      expect(model.advances.some((a) => a.reserved > 0n)).toBe(true);
      expect(
        model.payments.some(
          (p) => p.original - p.allocated - p.receivableApplied - p.converted > 0n,
        ),
      ).toBe(true);
      expect(model.payments.some((p) => p.allocated > 0n)).toBe(true);
      expect(model.payments.some((p) => p.receivableApplied > 0n)).toBe(true);
      expect(model.payments.some((p) => p.converted > 0n)).toBe(true);
      expect(
        model.payments.some(
          (p) => p.original - p.allocated - p.receivableApplied - p.converted === 0n,
        ),
      ).toBe(true);
      expect(new Set(model.payments.map((p) => p.branchId)).size).toBe(BRANCHES);
      const sparse = model.payments.filter((p) => p.branchId === sparseBranch).length;
      expect(sparse).toBeLessThan(N / 20);
      expect(customersSorted.length).toBeGreaterThan(N / 8);
      metrics['shape'] = {
        advances: model.advances.length,
        sparseBranchPayments: sparse,
        customers: customersSorted.length,
        pendingReservations: model.advances.filter((a) => a.reserved > 0n).length,
      };
    });

    it('the company report equals the model oracle: both blocks, byBranch, BOTH GL controls — and ONE statement in ONE transaction', async () => {
      repo.statements = 0;
      repo.transactions = 0;
      const r = await companyReport({ limit: FULL_PAGE });
      expect([repo.statements, repo.transactions]).toEqual([1, 1]);
      expect(sourceBlocksOf(r)).toEqual(await expectedBlocks(model, null, null));
      const glAdv = await glNet(ADV_ACCOUNT, ADV_KINDS, null);
      const glUn = await glNet(UNAPPLIED_ACCOUNT, UNAPPLIED_KINDS, null);
      expect(r.advances.reconciliation).toEqual({
        sourceBookLiabilityMinor: r.advances.bookLiabilityMinor,
        glCustomerAdvancesLiabilityMinor: glAdv.toString(),
        differenceMinor: '0',
        reconciled: true,
      });
      expect(r.unappliedReceipts.reconciliation).toEqual({
        sourceUnappliedMinor: r.unappliedReceipts.unappliedReceiptMinor,
        glUnappliedReceiptsLiabilityMinor: glUn.toString(),
        differenceMinor: '0',
        reconciled: true,
      });
      expect(r.advances.bookLiabilityMinor).toBe(glAdv.toString());
      expect(r.unappliedReceipts.unappliedReceiptMinor).toBe(glUn.toString());
      // the manual journal on both accounts is excluded: the whole accounts carry more than the authoritative sources
      const all = await admin.query(
        `SELECT a.key, COALESCE(SUM(jl."creditMinor" - jl."debitMinor"), 0)::text AS s
           FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
          WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND a.key IN ($2, $3) GROUP BY a.key`,
        [company, ADV_ACCOUNT, UNAPPLIED_ACCOUNT],
      );
      const byKey = Object.fromEntries(
        all.rows.map((x) => [x['key'] as string, BigInt(x['s'] as string)]),
      );
      expect(byKey[ADV_ACCOUNT]).toBe(glAdv + 777n);
      expect(byKey[UNAPPLIED_ACCOUNT]).toBe(glUn - 333n);
      // byBranch: the exact per-branch figures, and company = Σ byBranch
      const branches = [
        ...new Set([
          ...model.advances.map((a) => a.branchId),
          ...model.payments.map((p) => p.branchId),
        ]),
      ].sort();
      expect(r.byBranch.map((b) => b.branchId)).toEqual(branches);
      for (const b of r.byBranch) {
        expect(sourceBlocksOf(b)).toEqual(await expectedBlocks(model, b.branchId, null));
      }
      expect(
        r.byBranch.reduce((n, b) => n + BigInt(b.advances.bookLiabilityMinor), 0n).toString(),
      ).toBe(r.advances.bookLiabilityMinor);
      expect(
        r.byBranch
          .reduce((n, b) => n + BigInt(b.unappliedReceipts.unappliedReceiptMinor), 0n)
          .toString(),
      ).toBe(r.unappliedReceipts.unappliedReceiptMinor);
    });

    it('per-customer pages: the first page, a DEEP cursor page and the last page equal the oracle; every page ≤ the limit; the cursor chains to null', async () => {
      const total = customersSorted.length;
      const first = await companyReport({ limit: 50 });
      expect(first.customers.rows.map((x) => x.customerId)).toEqual(customersSorted.slice(0, 50));
      expect(first.customers.nextCursor).toBe(customersSorted[49]);
      const deepIndex = Math.floor(total / 2);
      const deep = await companyReport({ cursor: customersSorted[deepIndex]!, limit: 50 });
      expect(deep.customers.rows.map((x) => x.customerId)).toEqual(
        customersSorted.slice(deepIndex + 1, deepIndex + 51),
      );
      const lastStart = total - 30;
      const last = await companyReport({ cursor: customersSorted[lastStart - 1]!, limit: 50 });
      expect(last.customers.rows.map((x) => x.customerId)).toEqual(
        customersSorted.slice(lastStart),
      );
      expect(last.customers.nextCursor).toBeNull();
      for (const page of [first, deep, last]) {
        expect(sourceBlocksOf(page)).toEqual(await expectedBlocks(model, null, null)); // the summary is the whole scope
        for (const row of page.customers.rows) {
          expect(row.advances).toEqual(
            advFigures(model.advances.filter((a) => a.customerId === row.customerId)),
          );
          expect(row.unappliedReceipts).toEqual(
            unFigures(model.payments.filter((p) => p.customerId === row.customerId)),
          );
        }
      }
    });

    it('a dense branch, the SPARSE branch of the dense company and a single-customer filter equal the oracle', async () => {
      for (const branchId of [branchIds[0]!, sparseBranch]) {
        const r = await branchReport(branchId, { limit: FULL_PAGE });
        expect(sourceBlocksOf(r)).toEqual(await expectedBlocks(model, branchId, null));
        expect(
          r.advances.reconciliation.reconciled && r.unappliedReceipts.reconciliation.reconciled,
        ).toBe(true);
      }
      const custId = customersSorted[Math.floor(customersSorted.length / 3)]!;
      const one = await companyReport({ customerId: custId });
      expect(sourceBlocksOf(one)).toEqual(await expectedBlocks(model, null, custId));
      expect(one.customers.rows.map((x) => x.customerId)).toEqual([custId]);
    });

    // ═══════════════════════════ 2. measured runs ═══════════════════════════
    it('MEASURED: company (summaries + both controls + first page), a deep page, a dense branch, the sparse branch and a customer filter — warm-up, then repeated full-service runs; memory observed', async () => {
      const total = customersSorted.length;
      const deepCursor = customersSorted[Math.floor(total / 2)]!;
      const oneCustomer = customersSorted[Math.floor(total / 3)]!;
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
        [
          'oneCustomer',
          () => companyReport({ customerId: oneCustomer }),
          () => runStatement(null, oneCustomer, null, FULL_PAGE),
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

    it('cost scales with the rows of the SCOPE: per-payment cost of the branches (35 / 30 / 20 / 14 / 1 %) and of the company stays within a small factor — no O(n²)', async () => {
      const scopes: [string, string | null, number][] = branchIds.map((b, k) => [
        `branch${k}`,
        b,
        model.payments.filter((p) => p.branchId === b).length +
          model.advances.filter((a) => a.branchId === b).length,
      ]);
      scopes.push(['company', null, model.payments.length + model.advances.length]);
      const out: { scope: string; rows: number; sqlMs: number; microsPerRow: number }[] = [];
      for (const [name, branchId, rows] of scopes) {
        await runStatement(branchId, null, null, FULL_PAGE); // warm-up
        const sqlMs = median([
          (await runStatement(branchId, null, null, FULL_PAGE)).sqlMs,
          (await runStatement(branchId, null, null, FULL_PAGE)).sqlMs,
          (await runStatement(branchId, null, null, FULL_PAGE)).sqlMs,
        ]);
        out.push({
          scope: name,
          rows,
          sqlMs: Math.round(sqlMs),
          microsPerRow: Math.round((sqlMs * 1000) / Math.max(1, rows)),
        });
      }
      metrics['scopeScaling'] = out;
      // the five biggest scopes: per-row cost within a small factor of the company's own
      const company_ = out.find((o) => o.scope === 'company')!;
      for (const o of out.filter((x) => x.rows >= N / 10 && x.scope !== 'company')) {
        expect(o.microsPerRow, `${o.scope} per-row cost vs the company`).toBeLessThan(
          company_.microsPerRow * 8 + 400,
        );
      }
    }, 3_600_000);

    // ═══════════════════════════ 3. EXPLAIN ═══════════════════════════
    it('EXPLAIN (ANALYZE, BUFFERS): the company statement reads every source table a small constant number of times — no nested loop seq-scans per outer row, no CTE re-scan per outer row', async () => {
      const doc = await explain(null, null, null, FULL_PAGE);
      const nodes = flatten(doc.Plan);
      const access: Record<
        string,
        { nodeType: string; rows: number | undefined; loops: number | undefined }[]
      > = {};
      for (const n of nodes) {
        const rel = n['Relation Name'];
        if (rel === undefined || !executed(n)) continue;
        (access[rel] ??= []).push({
          nodeType: n['Node Type'],
          rows: n['Actual Rows'],
          loops: n['Actual Loops'],
        });
      }
      for (const n of nodes) {
        // the chart of accounts of ONE company is a few dozen rows: seq-scanning that reference table per outer row is
        // O(rows × 30) and the planner is right to do it — every OTHER table must never be
        if (n['Node Type'] !== 'Seq Scan' || n['Relation Name'] === 'account') continue;
        expect(
          n['Actual Loops'] ?? 1,
          `${n['Relation Name']} seq-scanned per outer row`,
        ).toBeLessThanOrEqual(Math.max(4, BRANCHES));
      }
      for (const [rel, scans] of Object.entries(access)) {
        if (rel === 'account') continue;
        // 4 for the report's own stages + at most 2 for the density gate's early-stopped root legs (EL-1)
        expect(scans.length, `${rel} is read a small constant number of times`).toBeLessThanOrEqual(
          6,
        );
      }
      metrics['explainCompany'] = {
        explainExecutionTimeMs: Math.round(doc['Execution Time']),
        planningTimeMs: doc['Planning Time'],
        jit: doc.JIT ? { Functions: doc.JIT['Functions'], Options: doc.JIT['Options'] } : 'no JIT',
        tableAccess: access,
        nodeTypes: [...new Set(nodes.map((n) => n['Node Type']))],
        joinTypes: [
          ...new Set(nodes.map((n) => n['Join Type']).filter((j): j is string => j !== undefined)),
        ],
      };
    }, 3_600_000);

    it('EXPLAIN (ANALYZE, BUFFERS): a dense branch, the sparse branch and a customer filter', async () => {
      const oneCustomer = customersSorted[Math.floor(customersSorted.length / 3)]!;
      const out: Record<string, unknown> = {};
      for (const [name, branchId, customerId] of [
        ['denseBranch', branchIds[0]!, null],
        ['sparseBranch', sparseBranch, null],
        ['oneCustomer', null, oneCustomer],
      ] as const) {
        const doc = await explain(branchId, customerId, null, FULL_PAGE);
        const nodes = flatten(doc.Plan);
        for (const n of nodes) {
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

    // ═══════════════════════════ EL-1 — the density guard: the gate skips every heavy stage ═══════════════════════════
    /** the relations ONLY the heavy path reads (the gate reads the root tables itself): none may execute for a rejected scope */
    const HEAVY_RELATIONS = [
      'customer_advance_application',
      'customer_advance_refund_application',
      'refund_attempt_entitlement_reservation',
      'refund_attempt',
      'payment_allocation',
      'customer_receivable_payment_application',
      'customer_receivable',
      'credit_note_coverage_release',
      'journal_entry',
      'journal_line',
      'account',
    ];
    /** how often each ROOT relation is read by the gate alone — the heavy `adv` / `pay` / `pconv` stages read them again */
    const GATE_ROOT_READS: Record<string, number> = {
      customer_advance: 1,
      payment: 2,
      payment_attempt: 2,
      invoice: 1,
      order: 1,
    };
    /** another density limit (only the tests ask for one; production uses CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS) */
    async function explainGate(
      branchId: string | null,
      customerId: string | null,
      maxRoots: number,
      settings: readonly string[] = [],
    ): Promise<ExplainDoc> {
      const q = buildCustomerLiabilitiesReportQuery({
        tenantId: tenant,
        companyId: company,
        branchId,
        customerId,
        cursor: null,
        limit: FULL_PAGE,
        maxRoots,
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
    /** how many plan nodes read each ROOT relation (executed ones only) */
    const rootReads = (doc: ExplainDoc): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const n of flatten(doc.Plan)) {
        const rel = n['Relation Name'];
        if (rel !== undefined && rel in GATE_ROOT_READS && executed(n))
          out[rel] = (out[rel] ?? 0) + 1;
      }
      return out;
    };

    it('EL-1 density gate (EXPLAIN): above the limit NO heavy relation executes and the root relations are read by the gate ALONE — under every planner alternative, for the company, a branch and a customer scope; at the limit the heavy path runs', async () => {
      const perCustomer = new Map<string, number>();
      for (const m of [...model.payments, ...model.advances])
        perCustomer.set(m.customerId, (perCustomer.get(m.customerId) ?? 0) + 1);
      const [bigCustomer, bigCount] = [...perCustomer.entries()].sort((a, b) => b[1] - a[1])[0]!;
      expect(bigCount).toBeGreaterThan(1);
      const branchSize =
        model.payments.filter((m) => m.branchId === branchIds[0]).length +
        model.advances.filter((m) => m.branchId === branchIds[0]).length;
      const total = model.payments.length + model.advances.length;
      const scopes: [string, string | null, string | null, number][] = [
        ['company', null, null, total],
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
        // a company / dense-branch scope: the open plan reads the advances and the Payments again in its heavy stages. (A
        // one-customer scope can be so small that a hash join with an empty build side never executes its probe side.)
        if (customerId === null) {
          const openReads = rootReads(open);
          expect(
            openReads['customer_advance'],
            `${name}: the open plan re-reads the advances`,
          ).toBeGreaterThan(GATE_ROOT_READS['customer_advance']!);
          expect(
            openReads['payment'],
            `${name}: the open plan re-reads the Payments`,
          ).toBeGreaterThan(GATE_ROOT_READS['payment']!);
        }
        for (const settings of alternatives) {
          const shut = await explainGate(branchId, customerId, size - 1, settings);
          const label = `${name} [${settings.join(', ') || 'default planner'}]`;
          expect(
            heavyExecuted(shut),
            `${label}: a heavy relation executed above the limit`,
          ).toEqual([]);
          // the root relations are read by the gate's own legs and by nothing else (the heavy adv / pay / pconv stages are shut)
          const reads = rootReads(shut);
          for (const [rel, legs] of Object.entries(GATE_ROOT_READS)) {
            expect(
              reads[rel] ?? 0,
              `${label}: ${rel} is read only by the gate`,
            ).toBeLessThanOrEqual(legs);
          }
          expect(
            reads['customer_advance'] ?? 0,
            `${label}: the gate reads the advances`,
          ).toBeGreaterThan(0);
          expect(reads['payment'] ?? 0, `${label}: the gate reads the Payments`).toBeGreaterThan(0);
          // no executed seq scan loops per outer row: no N+1, no O(n²)
          for (const n of flatten(shut.Plan)) {
            if (n['Node Type'] !== 'Seq Scan' || !executed(n)) continue;
            expect(
              n['Actual Loops'] ?? 1,
              `${label}: ${n['Relation Name']} seq-scanned per outer row`,
            ).toBeLessThanOrEqual(Math.max(4, BRANCHES));
          }
        }
        out[name] = {
          size,
          acceptedExplainMs: Math.round(open['Execution Time']),
          rejectedExplainMs: Math.round(
            (await explainGate(branchId, customerId, size - 1))['Execution Time'],
          ),
        };
      }
      // the root candidate stage STOPS at limit + 1: far above the limit its Limit node returns exactly 11 rows
      for (const settings of alternatives) {
        const shut = await explainGate(null, null, 10, settings);
        expect(heavyExecuted(shut), `limit 10 [${settings.join(', ') || 'default'}]`).toEqual([]);
        const limits = flatten(shut.Plan).filter((n) => n['Node Type'] === 'Limit' && executed(n));
        expect(
          limits.some((n) => n['Actual Rows'] === 11),
          `limit 10 [${settings.join(', ') || 'default'}]: the root candidate scan stops at limit + 1`,
        ).toBe(true);
      }
      metrics['gateExplainCiSize'] = out;
    }, 3_600_000);

    it.skipIf(ROOTS !== 100_000)(
      'EL-1 at 100 000 roots: ONE accepted final report at exactly the limit, then 100 001 roots — rejected three times, one statement, no heavy stage, no count disclosed, a branch and a customer of the rejected company still accepted',
      async () => {
        // ── exactly 100 000 liability roots in the target company ──
        const roots = async (): Promise<number> =>
          Number(
            (
              await admin.query(
                `SELECT ((SELECT count(*) FROM customer_advance WHERE "companyId" = $1)
                       + (SELECT count(*) FROM payment WHERE "companyId" = $1))::text AS n`,
                [company],
              )
            ).rows[0]!['n'],
          );
        expect(await roots()).toBe(100_000);
        expect(model.payments.length + model.advances.length).toBe(100_000);
        metrics['elRoots'] = {
          payments: model.payments.length,
          advances: model.advances.length,
          byOrigin: Object.fromEntries(
            ['PAYMENT', 'OPENING', 'CREDIT_NOTE'].map((t) => [
              t,
              model.advances.filter((a) => a.sourceType === t).length,
            ]),
          ),
          branches: BRANCHES,
        };

        // ── ONE accepted report at exactly the limit (the gate must not regress the accepted path) ──
        const a0 = performance.now();
        const accepted = await companyReport({ limit: FULL_PAGE });
        const acceptedMs = Math.round(performance.now() - a0);
        metrics['gateAccepted100k'] = { fullServiceMs: acceptedMs, memory: memory() };
        expect(accepted.advances.advanceCount + accepted.unappliedReceipts.paymentCount).toBe(
          100_000,
        );
        expect(sourceBlocksOf(accepted)).toEqual(await expectedBlocks(model, null, null));
        expect(accepted.advances.reconciliation.reconciled).toBe(true);
        expect(accepted.unappliedReceipts.reconciliation.reconciled).toBe(true);
        expect(acceptedMs).toBeLessThan(LOCAL_GATE_MS); // the local engineering gate — NOT a production SLA

        // ── ONE root more: a raw CREDIT_NOTE-origin advance (copied from an existing one) — 100 001 ──
        await admin.query(`SET session_replication_role = 'replica'`);
        const extra = (
          await admin.query(
            `INSERT INTO customer_advance
             SELECT (jsonb_populate_record(NULL::customer_advance, to_jsonb(t) || jsonb_build_object('id', uuidv7()::text))).*
               FROM customer_advance t WHERE t."companyId" = $1 AND t."sourceType" = 'CREDIT_NOTE' LIMIT 1
             RETURNING id, "branchId" AS b, "customerCompanyAccountId" AS cca`,
            [company],
          )
        ).rows[0]!;
        await admin.query(`SET session_replication_role = 'origin'`);
        try {
          expect(await roots()).toBe(100_001);
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
            expect(err, 'the 100 001-root company report is rejected').toBeInstanceOf(DomainError);
            const e = err as DomainError;
            expect([e.code, e.status]).toEqual(['REPORT_RESULT_TOO_LARGE', 422]);
            expect(e.details).toEqual([
              { field: 'maxRoots', issue: '100000' },
              { field: 'action', issue: 'narrow_scope' },
            ]);
            expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/100001|100 001/);
            expect([repo.statements, repo.transactions]).toEqual([1, 1]);
          }
          // a branch of the same company is still judged on its OWN roots (≪ 100 000). The extra root is a raw row with no
          // journal, so the branch / customer that holds it would (rightly) fail its integrity check: judge others
          const otherBranch = branchIds.find(
            (b) => b !== (extra['b'] as string) && b !== sparseBranch,
          )!;
          const denseBranch = await branchReport(otherBranch, { limit: FULL_PAGE });
          const denseRoots =
            denseBranch.advances.advanceCount + denseBranch.unappliedReceipts.paymentCount;
          expect(denseRoots).toBeLessThan(100_000);
          const extraCustomer = (
            await admin.query(
              `SELECT "customerId" AS c FROM customer_company_account WHERE id = $1`,
              [extra['cca']],
            )
          ).rows[0]!['c'] as string;
          const otherCustomer = customersSorted.find((c) => c !== extraCustomer)!;
          const oneCustomer = await companyReport({ customerId: otherCustomer, limit: FULL_PAGE });
          expect(
            oneCustomer.advances.advanceCount + oneCustomer.unappliedReceipts.paymentCount,
          ).toBeLessThan(100_000);
          // the rejected statement: a tiny payload and NO heavy relation executed (EXPLAIN ANALYZE, BUFFERS)
          const q = buildCustomerLiabilitiesReportQuery({
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
          const doc = await explainGate(null, null, CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS);
          expect(heavyExecuted(doc)).toEqual([]);
          const reads = rootReads(doc);
          for (const [rel, legs] of Object.entries(GATE_ROOT_READS)) {
            expect(reads[rel] ?? 0, `${rel} is read only by the gate`).toBeLessThanOrEqual(legs);
          }
          const nodes = flatten(doc.Plan);
          const limits = nodes.filter((n) => n['Node Type'] === 'Limit' && executed(n));
          expect(limits.some((n) => (n['Actual Rows'] ?? 0) <= 100_001)).toBe(true);
          metrics['gateRejected100001'] = {
            fullServiceMs: times,
            p50: median(times),
            branchInsideRejectedCompany: { roots: denseRoots },
            customerInsideRejectedCompany: {
              roots: oneCustomer.advances.advanceCount + oneCustomer.unappliedReceipts.paymentCount,
            },
            explainExecutionTimeMs: Math.round(doc['Execution Time']),
            planningTimeMs: doc['Planning Time'],
            payloadBytes: payload[0]!.report.length,
            jit: doc.JIT
              ? { Functions: doc.JIT['Functions'], Options: doc.JIT['Options'] }
              : 'no JIT',
            heavyRelationsExecuted: heavyExecuted(doc),
            rootRelationReads: reads,
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
          await admin.query(`DELETE FROM customer_advance WHERE id = $1`, [extra['id']]);
          await admin.query(`SET session_replication_role = 'origin'`);
        }
      },
      3_600_000,
    );
  },
);
