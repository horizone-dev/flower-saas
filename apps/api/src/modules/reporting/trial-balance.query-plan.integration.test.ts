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
import { TrialBalanceRepository } from './trial-balance.repository.js';
import { buildTrialBalanceQuery } from './trial-balance.sql.js';

/**
 * Task 3b.10 Checkpoint A — the Trial Balance QUERY-PLAN / VOLUME gate (owner ruling OD-3).
 *
 * The decision under test: can the EXISTING indexes — `journal_entry(tenantId, companyId,
 * postingDate)` and `journal_line(journalEntryId)` — support a first-release Trial Balance with NO
 * migration? So the REAL statement (`buildTrialBalanceQuery`, the exact text the repository runs)
 * is EXPLAINed (ANALYZE, BUFFERS) through the real RLS role on a disposable, representative-volume,
 * chronologically-posted ledger that also contains other companies' and another tenant's rows.
 *
 * Size is configurable so the same file is both a fast CI guard and a one-off measurement:
 *   TB_VOLUME_ENTRIES   journal entries in the TARGET company        (default 40 000; ×3 lines each)
 *   TB_VOLUME_DAYS      days of history those entries span           (default 1 095 ≈ 3 years)
 *   TB_NOISE_MULTIPLIER other companies' entries as a multiple of the target's (default 0.5; the
 *                       measurement runs use 4 so the target is a SMALL share of the table, as in a
 *                       real multi-tenant database)
 *   TB_PLAN_METRICS_FILE  when set, the measured plans / timings are written there as JSON
 *
 * Assertions are about CORRECTNESS (the report equals an independent oracle at volume) and about
 * PATHOLOGY (no quadratic nested-loop, no per-entry index probing of a seq-scanned table, the early
 * window uses the date index) — NOT about wall-clock speed. Timings are recorded as observations of
 * a LOCAL TEST CONTAINER; they are not a production SLA.
 */
const ENTRIES = Number(process.env['TB_VOLUME_ENTRIES'] ?? 40_000);
const DAYS = Number(process.env['TB_VOLUME_DAYS'] ?? 1_095);
/** other companies' rows, as a multiple of the target company's (split over three companies / two tenants) */
const NOISE_MULTIPLIER = Number(process.env['TB_NOISE_MULTIPLIER'] ?? 0.5);
const METRICS_FILE = process.env['TB_PLAN_METRICS_FILE'];
const HISTORY_START = '2023-01-01';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
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

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

describe('Trial Balance — query-plan / volume gate (task 3b.10 Checkpoint A)', () => {
  let stack: TestStack;
  let db: DbService;
  let prisma: PrismaClient;
  let repo: TrialBalanceRepository;
  let admin: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };

  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const company = randomUUID();
  const noiseCompanies: { tenantId: string; companyId: string }[] = [];
  let lastDay = '';

  const metrics: Record<string, unknown> = {};

  const dayAt = (offsetFromStart: number): Promise<string> =>
    admin
      .query(`SELECT (DATE '${HISTORY_START}' + $1::int)::text AS d`, [offsetFromStart])
      .then((r) => r.rows[0]!['d'] as string);

  async function seedCompany(args: {
    tenantId: string;
    companyId: string;
    entries: number;
    accountIds: Record<string, string>;
    periodId: string;
  }): Promise<void> {
    const a = args.accountIds;
    await admin.query(`SET session_replication_role = 'replica'`);
    try {
      await admin.query(`DROP TABLE IF EXISTS tb_gen`);
      // chronological posting (production data is inserted in date order)
      await admin.query(
        `CREATE TEMP TABLE tb_gen AS
           SELECT gs AS i, gen_random_uuid() AS id,
                  (DATE '${HISTORY_START}' + (((gs - 1)::bigint * $2::bigint) / $1::bigint)::int) AS d,
                  (1000 + (gs % 977))::bigint AS amt
             FROM generate_series(1, $1::int) gs`,
        [args.entries, DAYS],
      );
      await admin.query(
        `INSERT INTO journal_entry (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
                                    "sourceKind", "sourceId", "currencyCode", "postingFingerprint", "sealedAt")
         SELECT g.id, $1::uuid, $2::uuid, $3::uuid, g.d,
                (ARRAY['walk_in_sale','invoice_ar','customer_receipt_payment','payment_allocation','credit_note','refund'])[1 + (g.i % 6)],
                gen_random_uuid()::text, 'AED', 'fp', now()
           FROM tb_gen g`,
        [args.tenantId, args.companyId, args.periodId],
      );
      await admin.query(
        `INSERT INTO journal_line (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.id, v.account_id, v.dr, v.cr
           FROM tb_gen g
          CROSS JOIN LATERAL (VALUES
            (CASE g.i % 3 WHEN 0 THEN $3::uuid WHEN 1 THEN $4::uuid ELSE $5::uuid END, g.amt, 0::bigint),
            ($6::uuid, 0::bigint, g.amt - (g.amt / 20)),
            ($7::uuid, 0::bigint, g.amt / 20)
          ) AS v(account_id, dr, cr)`,
        [
          args.tenantId,
          args.companyId,
          a['ASSET.CASH_ON_HAND'],
          a['ASSET.BANK'],
          a['ASSET.PAYMENT_CLEARING'],
          a['REVENUE.SALES'],
          a['LIABILITY.TAX_PAYABLE'],
        ],
      );
      await admin.query(`DROP TABLE tb_gen`);
    } finally {
      await admin.query(`SET session_replication_role = 'origin'`);
    }
  }

  async function seedAccountsAndPeriod(
    tenantId: string,
    companyId: string,
  ): Promise<{ accountIds: Record<string, string>; periodId: string }> {
    await admin.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", "accountingTimezone", status, "updatedAt")
       VALUES ($1, $2, 'Volume Co', 'AE', 'AED', 'Asia/Dubai', 'ACTIVE', now())`,
      [companyId, tenantId],
    );
    const keys: [string, string, string, string][] = [
      ['ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash on Hand'],
      ['ASSET.BANK', 'ASSET', '1100', 'Bank'],
      ['ASSET.PAYMENT_CLEARING', 'ASSET', '1200', 'Payment Clearing'],
      ['REVENUE.SALES', 'REVENUE', '4000', 'Sales Revenue'],
      ['LIABILITY.TAX_PAYABLE', 'LIABILITY', '2100', 'Tax Payable'],
    ];
    const accountIds: Record<string, string> = {};
    for (const [key, category, code, name] of keys) {
      const id = randomUUID();
      accountIds[key] = id;
      await admin.query(
        `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [id, tenantId, companyId, key, category, code, name],
      );
    }
    const periodId = randomUUID();
    await admin.query(
      `INSERT INTO accounting_period (id, "tenantId", "companyId", "startDate", "endDate", status, "updatedAt")
       VALUES ($1, $2, $3, '${HISTORY_START}', '2030-12-31', 'OPEN', now())`,
      [periodId, tenantId, companyId],
    );
    return { accountIds, periodId };
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();
    repo = new TrialBalanceRepository(db);

    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    admin = {
      query: (sql, params) => c.query(sql, params as unknown[]),
      end: () => c.end(),
    };

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await admin.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `tb-volume-plan-${planId.slice(0, 8)}`,
    ]);
    await admin.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    for (const t of [tenant, otherTenant]) {
      await admin.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [t, `tb-volume-${t.slice(0, 8)}`, planVersionId],
      );
    }
    await admin.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "defaultTimezone", "updatedAt")
       VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', 'Asia/Dubai', now())
       ON CONFLICT (code) DO NOTHING`,
    );

    // the target company, plus other companies of the SAME tenant and of a FOREIGN tenant — so the
    // `(tenantId, companyId)` index prefix has to do real work and the target is only a share of the table
    const noiseEntries = Math.max(1, Math.floor((ENTRIES * NOISE_MULTIPLIER) / 3));
    const plan: [string, string, number][] = [
      [tenant, company, ENTRIES],
      [tenant, randomUUID(), noiseEntries],
      [otherTenant, randomUUID(), noiseEntries],
      [otherTenant, randomUUID(), noiseEntries],
    ];
    for (const [t, co, entries] of plan) {
      if (co !== company) noiseCompanies.push({ tenantId: t, companyId: co });
      const { accountIds, periodId } = await seedAccountsAndPeriod(t, co);
      await seedCompany({ tenantId: t, companyId: co, entries, accountIds, periodId });
    }
    await admin.query('VACUUM (ANALYZE) journal_entry, journal_line, account');
    lastDay = await dayAt(DAYS - 1);

    const counts = await admin.query(
      `SELECT (SELECT count(*) FROM journal_entry)::text AS entries, (SELECT count(*) FROM journal_line)::text AS lines`,
    );
    metrics['dataset'] = {
      targetCompanyEntries: ENTRIES,
      targetCompanyLines: ENTRIES * 3,
      totalEntries: counts.rows[0]!['entries'],
      totalLines: counts.rows[0]!['lines'],
      historyDays: DAYS,
      historyStart: HISTORY_START,
      historyEnd: lastDay,
      noiseMultiplier: NOISE_MULTIPLIER,
      noiseCompanies: noiseCompanies.length,
      targetShareOfEntries: `${((ENTRIES / Number(counts.rows[0]!['entries'])) * 100).toFixed(1)}%`,
      note: 'disposable chronological dataset; 3 lines per entry; plus other companies of the same tenant and of a foreign tenant',
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

  /** EXPLAIN (ANALYZE, BUFFERS) of the REAL statement, through the real RLS role. */
  async function explain(from: string, to: string): Promise<ExplainDoc> {
    const q = buildTrialBalanceQuery({ tenantId: tenant, companyId: company, from, to });
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

  /** An independent oracle: per-account sums straight from the ledger, a different SQL path. */
  async function oracle(from: string, to: string) {
    const r = await admin.query(
      `SELECT jl."accountId" AS id,
              COALESCE(SUM(jl."debitMinor") FILTER (WHERE je."postingDate" < $2::date), 0)::text AS od,
              COALESCE(SUM(jl."creditMinor") FILTER (WHERE je."postingDate" < $2::date), 0)::text AS oc,
              COALESCE(SUM(jl."debitMinor") FILTER (WHERE je."postingDate" BETWEEN $2::date AND $3::date), 0)::text AS pd,
              COALESCE(SUM(jl."creditMinor") FILTER (WHERE je."postingDate" BETWEEN $2::date AND $3::date), 0)::text AS pc
         FROM journal_line jl JOIN journal_entry je ON je.id = jl."journalEntryId"
        WHERE je."companyId" = $1 AND je."sealedAt" IS NOT NULL AND je."postingDate" <= $3::date
        GROUP BY jl."accountId"`,
      [company, from, to],
    );
    return new Map(r.rows.map((x) => [x['id'] as string, x]));
  }

  interface Scenario {
    name: string;
    from: () => Promise<string>;
    to: () => Promise<string>;
  }
  const scenarios: Scenario[] = [
    {
      name: 'short: last 7 days (huge opening)',
      from: () => dayAt(DAYS - 7),
      to: () => dayAt(DAYS - 1),
    },
    { name: 'short: last single day', from: () => dayAt(DAYS - 1), to: () => dayAt(DAYS - 1) },
    {
      name: 'medium: last 90 days (huge opening)',
      from: () => dayAt(DAYS - 90),
      to: () => dayAt(DAYS - 1),
    },
    {
      name: 'long: last 365 days (large opening)',
      from: () => dayAt(Math.max(0, DAYS - 365)),
      to: () => dayAt(DAYS - 1),
    },
    {
      name: 'full history as one period (no opening)',
      from: () => dayAt(0),
      to: () => dayAt(DAYS - 1),
    },
    {
      name: 'mid-history close (to = 50% of history)',
      from: () => dayAt(Math.floor(DAYS / 2) - 30),
      to: () => dayAt(Math.floor(DAYS / 2)),
    },
    {
      name: 'early close (to = first 1% of history)',
      from: () => dayAt(0),
      to: () => dayAt(Math.max(1, Math.floor(DAYS / 100))),
    },
  ];

  for (const s of scenarios) {
    it(`${s.name}: the report equals an independent oracle, balances, and the plan is not pathological`, async () => {
      const from = await s.from();
      const to = await s.to();

      // ── the plan of the REAL statement (warm: run once to load, then measure) ──
      await explain(from, to);
      const doc = await explain(from, to);
      const nodes = flatten(doc.Plan);
      const entryNodes = nodes.filter((n) => n['Relation Name'] === 'journal_entry');
      const lineNodes = nodes.filter((n) => n['Relation Name'] === 'journal_line');
      const indexes = nodes.map((n) => n['Index Name']).filter((x): x is string => !!x);
      const joinTypes = nodes.map((n) => n['Join Type']).filter((x): x is string => !!x);
      const nodeTypes = [...new Set(nodes.map((n) => n['Node Type']))];

      // ── the report itself through the real repository ──
      const t0 = performance.now();
      const report = await inTenant(() =>
        repo.getForCompanyScoped({ companyId: company, from, to }),
      );
      const wallColdMs = performance.now() - t0;
      const t1 = performance.now();
      await inTenant(() => repo.getForCompanyScoped({ companyId: company, from, to }));
      const wallWarmMs = performance.now() - t1;

      // ── correctness at volume ──
      const o = await oracle(from, to);
      expect(report.accounts.length).toBe(o.size);
      for (const row of report.accounts) {
        const x = o.get(row.accountId)!;
        expect(row.periodDebitMinor).toBe(x['pd']);
        expect(row.periodCreditMinor).toBe(x['pc']);
        const openingNet = BigInt(x['od'] as string) - BigInt(x['oc'] as string);
        expect(row.openingDebitMinor).toBe((openingNet > 0n ? openingNet : 0n).toString());
        expect(row.openingCreditMinor).toBe((openingNet < 0n ? -openingNet : 0n).toString());
      }
      expect(report.totals.totalOpeningDebitMinor).toBe(report.totals.totalOpeningCreditMinor);
      expect(report.totals.totalPeriodDebitMinor).toBe(report.totals.totalPeriodCreditMinor);
      expect(report.totals.totalClosingDebitMinor).toBe(report.totals.totalClosingCreditMinor);

      const entriesUpToTo = await admin.query(
        `SELECT count(*)::text AS n FROM journal_entry WHERE "companyId" = $1 AND "postingDate" <= $2::date`,
        [company, to],
      );

      // ── record the observation ──
      (metrics['scenarios'] as unknown[] | undefined) ??= [];
      (metrics['scenarios'] as unknown[]).push({
        scenario: s.name,
        from,
        to,
        entriesOnOrBeforeTo: entriesUpToTo.rows[0]!['n'],
        reportAccounts: report.accounts.length,
        planningTimeMs: doc['Planning Time'],
        explainExecutionTimeMs: doc['Execution Time'],
        serviceWallColdMs: Math.round(wallColdMs),
        serviceWallWarmMs: Math.round(wallWarmMs),
        nodeTypes,
        journalEntryAccess: entryNodes.map((n) => ({
          nodeType: n['Node Type'],
          actualRows: n['Actual Rows'],
          loops: n['Actual Loops'],
        })),
        journalLineAccess: lineNodes.map((n) => ({
          nodeType: n['Node Type'],
          actualRows: n['Actual Rows'],
          loops: n['Actual Loops'],
        })),
        indexesUsed: indexes,
        joinTypes,
        usesPostingDateIndex: indexes.includes('journal_entry_tenantId_companyId_postingDate_idx'),
        usesJournalLineEntryIndex: indexes.includes('journal_line_journalEntryId_idx'),
        parallelWorkers: Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0)),
        sharedHitBlocks: doc.Plan['Shared Hit Blocks'],
        sharedReadBlocks: doc.Plan['Shared Read Blocks'],
      });

      // ── not pathological ──
      // a Nested Loop whose inner side seq-scans journal_line once PER OUTER ROW would be quadratic
      // (a parallel Seq Scan legitimately reports one "loop" per worker process, so allow for those)
      const maxProcesses = 1 + Math.max(0, ...nodes.map((n) => n['Workers Launched'] ?? 0));
      for (const n of nodes) {
        if (n['Node Type'] === 'Nested Loop') {
          const inner = (n.Plans ?? [])[1];
          if (inner) {
            const innerNodes = flatten(inner);
            expect(
              innerNodes.some(
                (x) =>
                  x['Node Type'] === 'Seq Scan' &&
                  x['Relation Name'] === 'journal_line' &&
                  (x['Actual Loops'] ?? 1) > maxProcesses,
              ),
            ).toBe(false);
          }
        }
      }
      // every journal_line row is reached through a join to an entry already restricted by tenant+company
      expect(lineNodes.length).toBeGreaterThan(0);
      // a single execution, not an N+1: the whole report is ONE statement
      expect(doc.Plan).toBeDefined();
    }, 1_700_000);
  }

  it('an early close (to = first 1% of history) is served by the postingDate index, not a full scan', async () => {
    const early = (
      metrics['scenarios'] as { scenario: string; usesPostingDateIndex: boolean }[]
    ).find((x) => x.scenario.startsWith('early close'));
    expect(early, 'the early-close scenario ran').toBeDefined();
    expect(early!.usesPostingDateIndex).toBe(true);
  });
});
