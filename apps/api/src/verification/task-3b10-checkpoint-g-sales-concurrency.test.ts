import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import pg from 'pg';
import {
  DISCLAIMER,
  HEAVY,
  LevelStats,
  Monitor,
  deadlocks,
  digest,
  pgShmErrors,
  postgresSettings,
  startLoadPostgres,
  writeMetrics,
  type HttpResult,
  type LoadPostgres,
} from './load-support.js';
import { bootApp, mintTenantToken, rolePerms, type AppHandle } from './load-sale-world.js';
import {
  SALES_DAYS,
  SALES_START,
  addOneExtraDocument,
  fingerprintOrders,
  seedReferenceRows,
  seedSalesCompany,
} from './load-sales-fixture.js';

/**
 * Task 3b.10 Checkpoint G — SALES report concurrency at the frozen 25 000-document boundary (OPT-IN: `G_LOAD=1`).
 *
 * A disposable PostgreSQL with a 512 MB `/dev/shm`; one target company with EXACTLY 25 000 invoices over the 90-day window
 * across four branches (a derivation of the frozen generator — see `load-sales-fixture.ts`); the application over real HTTP
 * semantics (real guards, sessions). 1 / 2 / 5 / 10 concurrent callers × 8 repetitions, company and branch routes mixed with
 * denied callers. Then the boundary: 91 days, and 25 001 documents — repeated under concurrent load.
 * Local test-container observations; not production capacity.
 *
 *   G_SALES_DOCS   documents of the target company (default 25 000 = the frozen limit; smaller only for a dry run)
 *   G_REPS         repetitions per level (default 8)
 */
const DOCS = Number(process.env['G_SALES_DOCS'] ?? 25_000);
const LIMIT = 25_000;
const REPS = Math.max(1, Number(process.env['G_REPS'] ?? 8));
const BRANCHES = 4;
const NOISE = 0.15;
const LEVELS = [1, 2, 5, 10];

describe.skipIf(!HEAVY)(
  'Sales report — concurrency at the frozen 25 000-document boundary (task 3b.10 Checkpoint G)',
  () => {
    let pgc: LoadPostgres;
    let redis: TestStack;
    let h: AppHandle;
    let seed: pg.Client;
    let admin: pg.Pool;
    const metrics: Record<string, unknown> = { disclaimer: DISCLAIMER, docs: DOCS, reps: REPS };

    const tenant = randomUUID();
    const otherTenant = randomUUID();
    const company = randomUUID();
    const branches = Array.from({ length: BRANCHES }, () => randomUUID());
    const otherCompanyIds: string[] = [];
    let from = SALES_START;
    let to = SALES_START;
    let to91 = SALES_START;
    const tok: Record<string, string> = {};

    const get = async (token: string | null, url: string): Promise<HttpResult> => {
      const t0 = performance.now();
      const res = await h.app.inject({
        method: 'GET',
        url: `/v1${url}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const ms = performance.now() - t0;
      return { status: res.statusCode, ms, body: res.json() };
    };
    const companyUrl = (a = from, b = to): string =>
      `/companies/${company}/reports/sales?from=${a}&to=${b}`;
    const branchUrl = (i: number, a = from, b = to): string =>
      `/companies/${company}/branches/${branches[i]!}/reports/sales?from=${a}&to=${b}`;
    const codeOf = (r: HttpResult): string | undefined =>
      (r.body as { error?: { code?: string } })?.error?.code;

    beforeAll(async () => {
      pgc = await startLoadPostgres('sales');
      redis = await startTestStack({ services: ['redis'] });
      migrateTestDb(pgc.url);
      seed = new pg.Client({ connectionString: pgc.url });
      await seed.connect();
      admin = new pg.Pool({ connectionString: pgc.url, max: 3 });
      await seedReferenceRows(seed, [tenant, otherTenant]);
      const noise = Math.max(1, Math.floor((DOCS * NOISE) / 3));
      const t0 = performance.now();
      for (const [t, co, bs, n, adj] of [
        [tenant, company, branches, DOCS, false],
        [tenant, randomUUID(), [randomUUID(), randomUUID()], noise, true],
        [otherTenant, randomUUID(), [randomUUID(), randomUUID()], noise, true],
        [otherTenant, randomUUID(), [randomUUID()], noise, true],
      ] as const) {
        if (co !== company) otherCompanyIds.push(co, ...bs);
        await seedSalesCompany(seed, {
          tenantId: t,
          companyId: co,
          branches: [...bs],
          invoices: n,
          adjustments: adj,
          batch: 10_000,
          walkInKind: 'walk_in_sale',
        });
      }
      const seeded = performance.now() - t0;
      const f0 = performance.now();
      await fingerprintOrders(seed, tenant, company);
      await seed.query(
        'VACUUM (ANALYZE) invoice, "order", order_line, journal_entry, journal_line, credit_note, cancellation_charge, customer_receivable, account',
      );
      const day = async (n: number): Promise<string> =>
        (
          (await seed.query(`SELECT (DATE '${SALES_START}' + $1::int)::text AS d`, [n]))
            .rows[0] as { d: string }
        ).d;
      from = await day(0);
      to = await day(SALES_DAYS - 1);
      to91 = await day(SALES_DAYS);
      h = await bootApp({ pg: pgc.url, redis: redis.redis.url });
      tok['owner'] = await mintTenantToken(h, tenant, rolePerms('owner'));
      tok['branchOne'] = await mintTenantToken(h, tenant, rolePerms('manager'), {
        branchScope: [branches[0]!],
      });
      tok['foreign'] = await mintTenantToken(h, otherTenant, rolePerms('owner'));
      const counts = (
        await seed.query(
          `SELECT (SELECT count(*) FROM invoice)::text invoices, (SELECT count(*) FROM journal_entry)::text entries,
                (SELECT count(*) FROM journal_line)::text lines, (SELECT count(*) FROM credit_note)::text credit_notes,
                (SELECT count(*) FROM cancellation_charge)::text charges`,
        )
      ).rows[0];
      metrics['dataset'] = {
        targetInvoices: DOCS,
        branches: BRANCHES,
        window: { from, to, days: SALES_DAYS },
        totals: counts,
        seedSeconds: Math.round(seeded / 1000),
        fingerprintSeconds: Math.round((performance.now() - f0) / 1000),
      };
      metrics['settings'] = await postgresSettings(admin, pgc.name);
    }, 3_600_000);

    afterAll(async () => {
      writeMetrics('sales-concurrency.json', metrics);
      await seed?.end();
      await admin?.end();
      await h?.close();
      await redis?.stop();
      await pgc?.stop();
    });

    let baseCompany = '';
    const baseBranch: string[] = [];
    const sqlBranch: { count: number; total: string }[] = [];

    it('the dataset is exactly the frozen boundary: every invoice of the target company is inside the one 90-day window', async () => {
      const r = await seed.query(
        `SELECT count(*)::int AS n FROM invoice WHERE "companyId" = $1 AND "invoiceDate" BETWEEN $2::date AND $3::date`,
        [company, from, to],
      );
      expect((r.rows[0] as { n: number }).n).toBe(DOCS);
      for (const b of branches) {
        const q = await seed.query(
          `SELECT count(*)::int AS n, coalesce(sum("totalAmountMinor"),0)::text AS t FROM invoice
          WHERE "companyId" = $1 AND "branchId" = $2 AND "invoiceDate" BETWEEN $3::date AND $4::date`,
          [company, b, from, to],
        );
        sqlBranch.push({
          count: (q.rows[0] as { n: number }).n,
          total: (q.rows[0] as { t: string }).t,
        });
      }
      expect(sqlBranch.reduce((s, b) => s + b.count, 0)).toBe(DOCS);
    });

    it('sequential baseline: the company report equals an independent SQL oracle; the branch reports partition it exactly (no double counting, no leakage)', async () => {
      await get(tok['owner']!, companyUrl()); // warm-up
      const runs: number[] = [];
      let res: HttpResult = { status: 0, ms: 0, body: null };
      for (let i = 0; i < 3; i++) {
        res = await get(tok['owner']!, companyUrl());
        runs.push(res.ms);
        expect(res.status).toBe(200);
      }
      const inv = (res.body as { invoices: { invoiceCount: number; invoicedTotalMinor: string } })
        .invoices;
      const oracle = await seed.query(
        `SELECT count(*)::int AS n, coalesce(sum("totalAmountMinor"),0)::text AS t FROM invoice
        WHERE "companyId" = $1 AND "invoiceDate" BETWEEN $2::date AND $3::date`,
        [company, from, to],
      );
      expect(inv.invoiceCount).toBe(DOCS);
      expect(inv.invoicedTotalMinor).toBe((oracle.rows[0] as { t: string }).t);
      baseCompany = digest(res.body);
      let sumCount = 0;
      let sumTotal = 0n;
      for (const [i] of branches.entries()) {
        const b = await get(tok['owner']!, branchUrl(i));
        expect(b.status, `branch ${i}`).toBe(200);
        const bi = b.body as {
          branchId: string;
          invoices: { invoiceCount: number; invoicedTotalMinor: string };
        };
        expect(bi.branchId).toBe(branches[i]);
        expect(bi.invoices.invoiceCount).toBe(sqlBranch[i]!.count);
        expect(bi.invoices.invoicedTotalMinor).toBe(sqlBranch[i]!.total);
        sumCount += bi.invoices.invoiceCount;
        sumTotal += BigInt(bi.invoices.invoicedTotalMinor);
        baseBranch.push(digest(b.body));
        expect(digest(b.body)).not.toBe(baseCompany);
      }
      expect(sumCount).toBe(inv.invoiceCount);
      expect(sumTotal.toString()).toBe(inv.invoicedTotalMinor);
      metrics['sequentialBaselineMs'] = runs.map(Math.round);
    }, 600_000);

    it('CONCURRENCY — 1 / 2 / 5 / 10 callers × repetitions, company and branch routes mixed with denied callers: expected status, identical figures, no leakage, 0 server errors', async () => {
      interface Job {
        key: string;
        token: string;
        url: string;
        want: number;
        base: string | null;
      }
      const jobs: Job[] = [
        { key: 'company', token: 'owner', url: companyUrl(), want: 200, base: baseCompany },
        ...branches.map((_, i): Job => ({
          key: `branch${i}`,
          token: 'owner',
          url: branchUrl(i),
          want: 200,
          base: baseBranch[i]!,
        })),
        {
          key: 'branch0-as-branch0-user',
          token: 'branchOne',
          url: branchUrl(0),
          want: 200,
          base: baseBranch[0]!,
        },
        {
          key: 'company-as-branch0-user',
          token: 'branchOne',
          url: companyUrl(),
          want: 404,
          base: null,
        },
        {
          key: 'company-as-foreign-tenant',
          token: 'foreign',
          url: companyUrl(),
          want: 404,
          base: null,
        },
      ];
      const ping = () => h.db.appClient().$queryRawUnsafe('SELECT 1');
      const monitor = new Monitor({ admin, container: pgc.name, ping });
      const dl0 = await deadlocks(admin);
      const shm0 = await pgShmErrors(pgc.name);
      const rows: Record<string, unknown>[] = [];
      let cursor = 0;
      let stop: string | null = null;
      for (const level of LEVELS) {
        const stats = new LevelStats();
        monitor.start();
        for (let rep = 0; rep < REPS; rep++) {
          const batch = Array.from({ length: level }, () => jobs[cursor++ % jobs.length]!);
          const out = await Promise.all(
            batch.map(async (j) => ({ j, r: await get(tok[j.token]!, j.url) })),
          );
          for (const { j, r } of out) {
            stats.add(r.status, r.ms, r.status >= 400 ? codeOf(r) : undefined);
            if (r.status !== j.want) stats.wrong++;
            else if (j.base && digest(r.body) !== j.base) stats.wrong++;
            const text = JSON.stringify(r.body);
            if (otherCompanyIds.some((id) => text.includes(id))) stats.isolation++;
            if (j.token !== 'owner' && j.want === 200 && !text.includes(branches[0]!))
              stats.isolation++;
          }
          if (monitor.tripped) break;
        }
        const m = await monitor.stop();
        rows.push({ level, reps: REPS, ...stats.summary(), resources: m });
        if (m.tripped) {
          stop = m.tripped;
          break;
        }
        expect(stats.fiveXx, `5xx at c=${level}`).toBe(0);
        expect(stats.wrong, `wrong status/figures at c=${level}`).toBe(0);
        expect(stats.isolation, `isolation faults at c=${level}`).toBe(0);
      }
      metrics['concurrency'] = {
        levels: rows,
        deadlocks: (await deadlocks(admin)) - dl0,
        pg53100: (await pgShmErrors(pgc.name)) - shm0,
        stop,
      };
      expect(stop).toBeNull();
      expect((await deadlocks(admin)) - dl0).toBe(0);
      expect((await pgShmErrors(pgc.name)) - shm0).toBe(0);
    }, 3_600_000);

    it.skipIf(DOCS !== LIMIT)(
      'BOUNDARY — 91 days is refused with the frozen range error; 25 001 company documents → 422 REPORT_RESULT_TOO_LARGE, repeatedly and under concurrent load, while every branch inside its own limit stays eligible',
      async () => {
        // 91 inclusive dates: refused by the frozen range rule before any financial work (company and branch)
        const r91 = await get(tok['owner']!, companyUrl(from, to91));
        expect(r91.status).toBe(400);
        expect(codeOf(r91)).toBe('REPORT_RANGE_TOO_LARGE');
        expect(codeOf(await get(tok['owner']!, branchUrl(0, from, to91)))).toBe(
          'REPORT_RANGE_TOO_LARGE',
        );
        // exactly 25 000 is still accepted (the baseline), then ONE more document
        await addOneExtraDocument(seed, {
          tenantId: tenant,
          companyId: company,
          branchId: branches[0]!,
          day: to,
        });
        const over = await get(tok['owner']!, companyUrl());
        expect(over.status).toBe(422);
        expect(codeOf(over)).toBe('REPORT_RESULT_TOO_LARGE');
        const bases: string[] = [];
        for (const [i] of branches.entries()) {
          const b = await get(tok['owner']!, branchUrl(i));
          expect(b.status, `branch ${i} must remain independently eligible`).toBe(200);
          bases.push(digest(b.body));
        }
        const ping = () => h.db.appClient().$queryRawUnsafe('SELECT 1');
        const monitor = new Monitor({ admin, container: pgc.name, ping });
        const dl0 = await deadlocks(admin);
        const shm0 = await pgShmErrors(pgc.name);
        const rows: Record<string, unknown>[] = [];
        let n = 0;
        for (const level of LEVELS) {
          const stats = new LevelStats();
          monitor.start();
          for (let rep = 0; rep < REPS; rep++) {
            const batch = Array.from({ length: level }, () => n++ % 3);
            const out = await Promise.all(
              batch.map(async (k) => {
                if (k === 0)
                  return {
                    want: 422,
                    r: await get(tok['owner']!, companyUrl()),
                    base: null as string | null,
                  };
                const i = (n + k) % branches.length;
                return { want: 200, r: await get(tok['owner']!, branchUrl(i)), base: bases[i]! };
              }),
            );
            for (const { want, r, base } of out) {
              stats.add(r.status, r.ms, r.status >= 400 ? codeOf(r) : undefined);
              if (r.status !== want) stats.wrong++;
              else if (want === 422 && codeOf(r) !== 'REPORT_RESULT_TOO_LARGE') stats.wrong++;
              else if (base && digest(r.body) !== base) stats.wrong++;
            }
          }
          const m = await monitor.stop();
          rows.push({ level, reps: REPS, ...stats.summary(), resources: m });
          expect(stats.fiveXx).toBe(0);
          expect(stats.wrong).toBe(0);
        }
        metrics['boundary'] = {
          range91: 'REPORT_RANGE_TOO_LARGE (company and branch)',
          over25000: 'REPORT_RESULT_TOO_LARGE (422)',
          levels: rows,
          deadlocks: (await deadlocks(admin)) - dl0,
          pg53100: (await pgShmErrors(pgc.name)) - shm0,
        };
        expect((await deadlocks(admin)) - dl0).toBe(0);
        expect((await pgShmErrors(pgc.name)) - shm0).toBe(0);
      },
      3_600_000,
    );
  },
);
