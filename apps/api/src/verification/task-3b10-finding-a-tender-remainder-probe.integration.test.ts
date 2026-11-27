import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { DbService, type BackendConfig } from '@flower/backend';
// White-box measurement test: it generates a disposable dataset and EXPLAINs the real statement —
// not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient } from '@flower/db';
import { buildTenderTotalsReportQuery } from '../modules/reporting/tender-totals-report.sql.js';

/**
 * Tender Totals — the UNPROVEN-REMAINDER probe (`allocatedPaymentsWithoutReceiptJournal`), measured with a
 * NON-EMPTY remainder.
 *
 * Why this file exists. The statement proves "an allocated Payment has a receipt journal" from the in-period
 * journals first; ONLY the rare remainder — a Payment allocated in the window whose receipt journal was posted in
 * an EARLIER period — is probed against the unique source index (see the header of `tender-totals-report.sql.ts`).
 * A per-Payment existence probe over every Payment of the window was measured and rejected: planned as a hash
 * anti-join it read the company's WHOLE receipt history for a one-day report. In the generator of
 * `tender-totals-report.query-plan.integration.test.ts` every allocation journal carries the same date as its
 * receipt journal, so that remainder is EMPTY there and the probe never has anything to do. Here it is not:
 *
 *   HISTORY   60 000 receipt journals in the past (the shape a hash anti-join would read in full)
 *   WINDOW    ONE day holding only K = 40 allocation journals whose Payments' receipt journals are 40+ days old
 *   NEGATIVE  a second company whose 5 allocated Payments have NO receipt journal at all
 *
 * Assertions are about CORRECTNESS (0 anomalies when every receipt exists, exactly 5 when 5 are missing) and
 * PATHOLOGY (the journal rows read and the source-index probes are bounded by the window and its remainder, never by
 * the receipt history). Wall-clock times are observations of a LOCAL TEST CONTAINER, not a production SLA.
 */
const HISTORY = 60_000;
const REMAINDER = 40;
const MISSING = 5;
const DAY = '2026-06-15';
const SOURCE_INDEX = 'journal_entry_tenantId_companyId_sourceKind_sourceId_key';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Workers Launched'?: number;
  Plans?: PlanNode[];
}
interface ExplainDoc {
  Plan: PlanNode;
  'Execution Time': number;
}
const flatten = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => {
  out.push(n);
  for (const c of n.Plans ?? []) flatten(c, out);
  return out;
};

describe('Tender Totals — unproven-remainder probe with a non-empty remainder (Finding A amendment candidate)', () => {
  let stack: TestStack;
  let db: DbService;
  let prisma: PrismaClient;
  let admin: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };

  const tenant = randomUUID();
  const positive = { company: randomUUID(), branch: randomUUID() };
  const negative = { company: randomUUID(), branch: randomUUID() };

  async function seedCompany(
    c: { company: string; branch: string },
    missing: number,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Remainder Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
      [c.company, tenant],
    );
    await admin.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'B',now())`,
      [c.branch, tenant, c.company],
    );
    const periodId = randomUUID();
    await admin.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2020-01-01','2030-12-31','OPEN',now())`,
      [periodId, tenant, c.company],
    );
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      await admin.query(`DROP TABLE IF EXISTS rp`);
      // i = 1..HISTORY are the Payments; the FIRST `REMAINDER` are allocated in the window. Their receipt journals are
      // old (40+ days before the window). For the negative company the first `missing` have NO receipt journal.
      await admin.query(
        `CREATE TEMP TABLE rp AS
           SELECT gs AS i, gen_random_uuid() AS pay_id, gen_random_uuid() AS entry_id,
                  gen_random_uuid() AS alloc_id, gen_random_uuid() AS alloc_entry,
                  (DATE '${DAY}' - 40 - (gs % 1000)) AS d
             FROM generate_series(1, $1::int) gs`,
        [HISTORY],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT r.entry_id, $1::uuid, $2::uuid, $3::uuid, r.d, 'customer_receipt_payment', r.pay_id::text, 'AED', 'fp', now()
           FROM rp r WHERE r.i > $4::int`,
        [tenant, c.company, periodId, missing],
      );
      await admin.query(
        `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
         SELECT r.pay_id, $1::uuid, $2::uuid, $3::uuid, gen_random_uuid(), 'CASH', 1000, 'AED', 2
           FROM rp r WHERE r.i <= $4::int`,
        [tenant, c.company, c.branch, missing === 0 ? REMAINDER : missing],
      );
      await admin.query(
        `INSERT INTO payment_allocation (id,"tenantId","companyId","branchId","paymentId","invoiceId","amountMinor","currencyCode","currencyExponent")
         SELECT r.alloc_id, $1::uuid, $2::uuid, $3::uuid, r.pay_id, gen_random_uuid(), 1000, 'AED', 2
           FROM rp r WHERE r.i <= $4::int`,
        [tenant, c.company, c.branch, missing === 0 ? REMAINDER : missing],
      );
      await admin.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                    "currencyCode","postingFingerprint","sealedAt")
         SELECT r.alloc_entry, $1::uuid, $2::uuid, $3::uuid, DATE '${DAY}', 'payment_allocation', r.alloc_id::text, 'AED', 'fp', now()
           FROM rp r WHERE r.i <= $4::int`,
        [tenant, c.company, periodId, missing === 0 ? REMAINDER : missing],
      );
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    admin = { query: (sql, params) => c.query(sql, params as unknown[]), end: () => c.end() };
    const planId = randomUUID();
    const planVersionId = randomUUID();
    await admin.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
      planId,
      `rp-plan-${planId.slice(0, 8)}`,
    ]);
    await admin.query(
      `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
      [planVersionId, planId],
    );
    await admin.query(
      `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
      [tenant, `rp-${tenant.slice(0, 8)}`, planVersionId],
    );
    await admin.query(
      `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel","defaultTimezone","updatedAt")
       VALUES ('AE','UAE','x','gcc','AED','SAT_SUN','Asia/Dubai',now()) ON CONFLICT (code) DO NOTHING`,
    );
    await seedCompany(positive, 0);
    await seedCompany(negative, MISSING);
    await admin.query('VACUUM (ANALYZE) payment, payment_allocation, journal_entry');
  }, 600_000);

  afterAll(async () => {
    await admin?.end();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  async function measure(c: { company: string; branch: string }) {
    const q = buildTenderTotalsReportQuery({
      tenantId: tenant,
      companyId: c.company,
      from: DAY,
      to: DAY,
      branchId: null,
    });
    const rows = await runScoped(
      prisma,
      { tenantId: tenant },
      (tx) => tx.$queryRawUnsafe<{ report: string }[]>(q.text, ...q.values),
      { timeout: 600_000, maxWait: 60_000 },
    );
    const json = JSON.parse(rows[0]!.report) as {
      candidateMovements: number;
      integrity: Record<string, number>;
    };
    // EXPLAIN twice: the first run warms the cache, the second is judged
    let doc: ExplainDoc | undefined;
    for (let k = 0; k < 2; k++) {
      const plan = await runScoped(
        prisma,
        { tenantId: tenant },
        (tx) =>
          tx.$queryRawUnsafe<{ 'QUERY PLAN': ExplainDoc[] }[]>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`,
            ...q.values,
          ),
        { timeout: 600_000, maxWait: 60_000 },
      );
      doc = plan[0]!['QUERY PLAN'][0]!;
    }
    const nodes = flatten(doc!.Plan);
    const workers = nodes.reduce((n, x) => n + (x['Workers Launched'] ?? 0), 0);
    const journalRowsRead = nodes
      .filter((n) => n['Relation Name'] === 'journal_entry')
      .reduce((n, x) => n + (x['Actual Rows'] ?? 0) * (x['Actual Loops'] ?? 1), 0);
    const sourceProbes = nodes
      .filter((n) => n['Index Name'] === SOURCE_INDEX)
      .reduce((n, x) => n + (x['Actual Loops'] ?? 1), 0);
    const seqScansOfJournal = nodes.filter(
      (n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'journal_entry',
    ).length;
    const summary = {
      company: c === positive ? 'positive' : 'negative',
      candidateMovements: json.candidateMovements,
      allocatedPaymentsWithoutReceiptJournal:
        json.integrity['allocatedPaymentsWithoutReceiptJournal'],
      journalRowsRead,
      sourceProbes,
      seqScansOfJournal,
      workers,
      antiJoins: nodes.filter((n) => /Anti/.test(n['Join Type'] ?? '')).map((n) => n['Join Type']),
      executionMs: Math.round(doc!['Execution Time']),
    };
    console.log(`REMAINDER ${JSON.stringify(summary)}`);
    return { json, journalRowsRead, sourceProbes, workers };
  }

  it('every allocated Payment HAS its (earlier) receipt journal: no anomaly, and the plan reads the window and its remainder — never the receipt history', async () => {
    const m = await measure(positive);
    expect(m.json.integrity['allocatedPaymentsWithoutReceiptJournal']).toBe(0);
    if (m.workers === 0) {
      // the window holds K allocation journals; the remainder is K Payments. A hash anti-join over the receipt journals
      // would read ~HISTORY rows for this one-day report (the rejected shape).
      expect(
        m.journalRowsRead,
        `the plan read ${m.journalRowsRead} journal rows for a window of ${REMAINDER} journals behind a history of ${HISTORY}`,
      ).toBeLessThanOrEqual(3 * REMAINDER + 500);
      expect(
        m.sourceProbes,
        `the plan probed the source index ${m.sourceProbes} times for a remainder of ${REMAINDER}`,
      ).toBeLessThanOrEqual(REMAINDER + 5);
    }
  }, 600_000);

  it(`${MISSING} allocated Payments with NO receipt journal at all are counted exactly (and only those)`, async () => {
    const m = await measure(negative);
    expect(m.json.integrity['allocatedPaymentsWithoutReceiptJournal']).toBe(MISSING);
    if (m.workers === 0) {
      expect(m.journalRowsRead).toBeLessThanOrEqual(3 * MISSING + 500);
      expect(m.sourceProbes).toBeLessThanOrEqual(MISSING + 5);
    }
  }, 600_000);
});
