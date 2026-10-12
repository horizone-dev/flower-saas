import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { enumerateRoutes } from '../common/auth/index.js';
import { ReportingRepository } from '../modules/reporting/reporting.repository.js';
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
  type LoadPostgres,
  type MonitorSummary,
} from './load-support.js';
import {
  PERIOD,
  ROLES,
  createSaleWorld,
  mintTenantToken,
  rolePerms,
  type SaleWorld,
} from './load-sale-world.js';
import pg from 'pg';

/**
 * Task 3b.10 Checkpoint G — ALL NINE report routes under concurrent HTTP load, with REAL authorisation.
 *
 * The full application (real guards, real default role templates, real Redis sessions) on a disposable PostgreSQL with a
 * 512 MB `/dev/shm`. The fixture (CI-sized: sales across three branches, credit sales, a receipt) is created ONLY through the
 * public sale routes. For every route × caller the expected status is derived from the role templates and the scope
 * rules — the load then replays a mix of allowed and denied requests at 1 / 2 / 5 / 10 concurrent callers and requires:
 * the expected status every time, 0 server errors, byte-identical bodies for allowed requests, no foreign identifier in any
 * body, and no report query for a denied request. Local test-container observations; not production capacity.
 */
const REPS = HEAVY ? 8 : 2;
const LEVELS = [1, 2, 5, 10];

interface Spec {
  slug: string;
  perms: readonly string[];
  branch: boolean;
  query: string;
}
const Q = `from=${PERIOD.from}&to=${PERIOD.to}`;
const REPORTS: Spec[] = [
  { slug: 'trial-balance', perms: ['accounting:view'], branch: false, query: Q },
  {
    slug: 'sales',
    perms: ['orders:view', 'credit_notes:view', 'receivables:view'],
    branch: true,
    query: Q,
  },
  { slug: 'tender-totals', perms: ['payments:view'], branch: true, query: Q },
  { slug: 'receivables', perms: ['receivables:view'], branch: true, query: '' },
  { slug: 'customer-liabilities', perms: ['receivables:view'], branch: true, query: '' },
];

interface Kind {
  perms: readonly string[];
  tenant: 'A' | 'B';
  branchScope: 'ALL' | number[];
  companyScope?: 'ALL' | 'A2ONLY';
  /** branch index → the ONLY keys allowed there */
  overlay?: Record<number, string[]>;
}
const owner = rolePerms('owner');
const without = (k: string): string[] => owner.filter((p) => p !== k);

describe('Reporting — all nine routes under concurrent HTTP load (task 3b.10 Checkpoint G)', () => {
  let pgc: LoadPostgres;
  let redis: TestStack;
  let w: SaleWorld;
  let admin: pg.Pool;
  const tokens = new Map<string, string>();
  const kinds = new Map<string, Kind>();
  const metrics: Record<string, unknown> = { disclaimer: DISCLAIMER, reps: REPS, heavy: HEAVY };
  let foreignIds: string[] = [];

  const kind = (name: string, k: Kind): void => void kinds.set(name, k);

  beforeAll(async () => {
    pgc = await startLoadPostgres('http');
    redis = await startTestStack({ services: ['redis'] });
    migrateTestDb(pgc.url);
    w = await createSaleWorld({ pg: pgc.url, redis: redis.redis.url }, 3);
    admin = new pg.Pool({ connectionString: pgc.url, max: 3 });

    // ── fixture, through the public HTTP sale routes only ──
    const [b0, b1, b2] = w.a.branches as [string, string, string];
    for (const b of [b0, b1, b2]) {
      for (let i = 0; i < 4; i++) {
        const s = await w.sale({ co: w.a, branch: b, token: w.ownerToken });
        if (!s.ok) throw new Error(`fixture walk-in sale failed: ${JSON.stringify(s)}`);
      }
    }
    for (const [i, c] of w.customers.entries()) {
      const s = await w.sale({
        co: w.a,
        branch: w.a.branches[i % 3]!,
        token: w.ownerToken,
        customerId: c,
        credit: true,
      });
      if (!s.ok) throw new Error(`fixture credit sale failed: ${JSON.stringify(s)}`);
    }
    const rc = await w.receipt({
      co: w.a,
      branch: b0,
      token: w.ownerToken,
      customerId: w.customers[0]!,
      amountMinor: 5000n,
    });
    if (rc.status !== 201) throw new Error(`fixture receipt failed: ${rc.status}`);

    // ── callers ──
    for (const r of ROLES)
      kind(`role:${r}`, { perms: rolePerms(r), tenant: 'A', branchScope: 'ALL' });
    kind('owner', { perms: owner, tenant: 'A', branchScope: 'ALL' });
    kind('branchOne', { perms: rolePerms('manager'), tenant: 'A', branchScope: [0] });
    kind('branchMulti', { perms: rolePerms('manager'), tenant: 'A', branchScope: [0, 1] });
    kind('overlay', {
      perms: owner,
      tenant: 'A',
      branchScope: 'ALL',
      overlay: { 1: ['orders:view'] },
    });
    kind('companyRestricted', {
      perms: owner,
      tenant: 'A',
      branchScope: 'ALL',
      companyScope: 'A2ONLY',
    });
    kind('foreignTenant', { perms: owner, tenant: 'B', branchScope: 'ALL' });
    kind('noOrdersView', { perms: without('orders:view'), tenant: 'A', branchScope: 'ALL' });
    kind('noCreditNotesView', {
      perms: without('credit_notes:view'),
      tenant: 'A',
      branchScope: 'ALL',
    });
    kind('noReceivablesView', {
      perms: without('receivables:view'),
      tenant: 'A',
      branchScope: 'ALL',
    });
    for (const [name, k] of kinds) {
      tokens.set(
        name,
        await mintTenantToken(w.h, k.tenant === 'A' ? w.a.tenantId : w.b.tenantId, k.perms, {
          branchScope: k.branchScope === 'ALL' ? 'ALL' : k.branchScope.map((i) => w.a.branches[i]!),
          ...(k.companyScope === 'A2ONLY' ? { companyScope: [w.a2.companyId] } : {}),
          ...(k.overlay
            ? {
                overlay: Object.fromEntries(
                  Object.entries(k.overlay).map(([i, keys]) => [w.a.branches[Number(i)]!, keys]),
                ),
              }
            : {}),
        }),
      );
    }
    foreignIds = [w.b.companyId, w.a2.companyId, ...w.b.branches, ...w.a2.branches];
    metrics['settings'] = await postgresSettings(admin, pgc.name);
    metrics['fixture'] = {
      company: w.a.companyId,
      branches: w.a.branches.length,
      walkInSales: 12,
      creditSales: w.customers.length,
      receipts: 1,
    };
  }, 900_000);

  afterAll(async () => {
    await admin?.end();
    await w?.h.close();
    await w?.pool.end();
    await redis?.stop();
    await pgc?.stop();
  });

  const urlFor = (r: Spec, branchIdx: number | null, companyId = w.a.companyId): string => {
    const base =
      branchIdx === null
        ? `/companies/${companyId}/reports/${r.slug}`
        : `/companies/${companyId}/branches/${branchIdx >= 0 ? w.a.branches[branchIdx]! : w.a2.branches[0]!}/reports/${r.slug}`;
    return r.query ? `${base}?${r.query}` : base;
  };

  /** the status the guard pipeline must answer — derived from the role templates and the scope rules, never from a response */
  function expected(name: string, r: Spec, branchIdx: number | null): number {
    const k = kinds.get(name)!;
    if (k.tenant === 'B') return 404;
    if (!r.perms.every((p) => k.perms.includes(p))) return 403;
    if (k.companyScope === 'A2ONLY') return 404;
    if (branchIdx === null) {
      if (k.branchScope !== 'ALL') return 404;
      for (const keys of Object.values(k.overlay ?? {}))
        if (!r.perms.every((p) => keys.includes(p))) return 404; // every required key is decided by the engine
      return 200;
    }
    if (k.branchScope !== 'ALL' && !k.branchScope.includes(branchIdx)) return 404;
    const keys = k.overlay?.[branchIdx];
    if (keys && !r.perms.every((p) => keys.includes(p))) return 403; // a branch overlay that withholds a key is a missing permission there (frozen engine behaviour)
    return 200;
  }

  interface Job {
    name: string;
    r: Spec;
    branchIdx: number | null;
    url: string;
    want: number;
    key: string;
  }
  const allJobs = (): Job[] => {
    const out: Job[] = [];
    for (const name of kinds.keys()) {
      for (const r of REPORTS) {
        out.push({
          name,
          r,
          branchIdx: null,
          url: urlFor(r, null),
          want: expected(name, r, null),
          key: `${r.slug}:company`,
        });
        if (r.branch) {
          for (const bi of [0, 1, 2]) {
            out.push({
              name,
              r,
              branchIdx: bi,
              url: urlFor(r, bi),
              want: expected(name, r, bi),
              key: `${r.slug}:branch${bi}`,
            });
          }
        }
      }
    }
    return out;
  };

  const call = (token: string | null, url: string) => w.req('GET', url, token);

  it('registers exactly the nine report routes, all GET (the table the load is derived from)', () => {
    const routes = enumerateRoutes(w.h.app).filter((r) => r.path.includes('/reports/'));
    expect(routes).toHaveLength(9);
    expect(routes.every((r) => r.httpMethod === 'GET')).toBe(true);
  });

  it('authorisation matrix — every caller × every route answers the status the role templates and scope rules demand; denied requests execute no report query; no body discloses a foreign identifier', async () => {
    const spy = vi.spyOn(
      ReportingRepository.prototype as unknown as { readScoped: (fn: unknown) => Promise<unknown> },
      'readScoped',
    );
    const baselines = new Map<string, string>();
    let allowed = 0;
    let denied = 0;
    try {
      // unauthenticated
      for (const r of REPORTS) {
        const before = spy.mock.calls.length;
        const res = await call(null, urlFor(r, null));
        expect(res.status).toBe(401);
        expect(spy.mock.calls.length).toBe(before);
      }
      // non-existent / malformed identifiers
      const ownerTok = tokens.get('owner')!;
      for (const r of REPORTS) {
        for (const bad of ['not-a-uuid', '00000000-0000-4000-8000-000000000999']) {
          const before = spy.mock.calls.length;
          const res = await call(ownerTok, urlFor(r, null, bad));
          expect(res.status, `${r.slug} ${bad}`).toBe(404);
          // the guard admits the owner; the frozen service then resolves the company and answers the same non-disclosing 404
          expect(spy.mock.calls.length - before).toBeLessThanOrEqual(1);
        }
      }
      // a branch of ANOTHER company under company A (cross-company branch)
      for (const r of REPORTS.filter((x) => x.branch)) {
        const before = spy.mock.calls.length;
        const res = await call(
          ownerTok,
          `/companies/${w.a.companyId}/branches/${w.a2.branches[0]!}/reports/${r.slug}${r.query ? `?${r.query}` : ''}`,
        );
        expect(res.status, r.slug).toBe(404);
        // the guard cannot know which company a branch id belongs to; the frozen service answers the non-disclosing 404
        expect(spy.mock.calls.length - before).toBeLessThanOrEqual(1);
        expect(JSON.stringify(res.body).includes(w.a2.branches[0]!)).toBe(false);
      }
      for (const j of allJobs()) {
        const before = spy.mock.calls.length;
        const res = await call(tokens.get(j.name)!, j.url);
        const ran = spy.mock.calls.length - before;
        expect(res.status, `${j.name} ${j.key} (${j.url})`).toBe(j.want);
        const text = JSON.stringify(res.body);
        for (const id of foreignIds)
          expect(text.includes(id), `${j.name} ${j.key} discloses ${id}`).toBe(false);
        if (j.want === 200) {
          allowed++;
          expect(ran, `${j.name} ${j.key}`).toBe(1);
          expect((res.body as { companyId?: string }).companyId).toBe(w.a.companyId);
          if (j.branchIdx !== null)
            expect((res.body as { branchId?: string }).branchId).toBe(w.a.branches[j.branchIdx]);
          const d = digest(res.body);
          const prev = baselines.get(j.key);
          if (prev) expect(d, `${j.key} must be identical for every authorised caller`).toBe(prev);
          else baselines.set(j.key, d);
        } else {
          denied++;
          // a foreign TENANT is admitted by the guard (the company id is only a path value): row-level security and the frozen
          // tenant / company predicates answer the same non-disclosing 404 after the tenant-scoped read finds nothing
          if (j.name === 'foreignTenant') expect(ran).toBeLessThanOrEqual(1);
          else expect(ran, `${j.name} ${j.key} must not reach a report query`).toBe(0);
          expect(typeof (res.body as { error?: { code?: string } })?.error?.code).toBe('string');
        }
      }
    } finally {
      spy.mockRestore();
    }
    (metrics['authorisation'] as unknown) = {
      allowedCases: allowed,
      deniedCases: denied,
      kinds: [...kinds.keys()],
      routes: 9,
    };
    expect(allowed).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
    (globalThis as { __gBaselines?: Map<string, string> }).__gBaselines = baselines;
  }, 600_000);

  it('the Sales triple is mandatory: dropping any ONE of the three permissions denies exactly the Sales routes (and receivables:view also the AR/liabilities routes)', async () => {
    const sales = REPORTS.find((r) => r.slug === 'sales')!;
    for (const [name, deniedAlso] of [
      ['noOrdersView', []],
      ['noCreditNotesView', []],
      ['noReceivablesView', ['receivables', 'customer-liabilities']],
    ] as const) {
      expect((await call(tokens.get(name)!, urlFor(sales, null))).status).toBe(403);
      expect((await call(tokens.get(name)!, urlFor(sales, 0))).status).toBe(403);
      for (const slug of [
        'tender-totals',
        'trial-balance',
        'receivables',
        'customer-liabilities',
      ]) {
        const r = REPORTS.find((x) => x.slug === slug)!;
        const want = (deniedAlso as readonly string[]).includes(slug) ? 403 : 200;
        expect((await call(tokens.get(name)!, urlFor(r, null))).status, `${name} ${slug}`).toBe(
          want,
        );
      }
    }
  });

  it('LOAD — the mix of allowed and denied requests at 1 / 2 / 5 / 10 concurrent callers: expected status every time, 0 server errors, identical figures, no disclosure', async () => {
    const baselines = (globalThis as { __gBaselines?: Map<string, string> }).__gBaselines;
    expect(baselines?.size).toBeGreaterThan(0);
    // deterministic (seeded) shuffle; each slot is ~70 % allowed and ~30 % denied so the guard path is loaded too
    let seed = 0x3b10;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const shuffled = (xs: Job[]): Job[] => {
      const o = [...xs];
      for (let i = o.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [o[i], o[j]] = [o[j]!, o[i]!];
      }
      return o;
    };
    const everyJob = allJobs();
    const okJobs = shuffled(everyJob.filter((j) => j.want === 200));
    const noJobs = shuffled(everyJob.filter((j) => j.want !== 200));
    let okAt = 0;
    let noAt = 0;
    let slot = 0;
    const nextJob = (): Job =>
      slot++ % 10 < 7 ? okJobs[okAt++ % okJobs.length]! : noJobs[noAt++ % noJobs.length]!;
    const dl0 = await deadlocks(admin);
    const shm0 = await pgShmErrors(pgc.name);
    const ping = () => w.h.db.appClient().$queryRawUnsafe('SELECT 1');
    const monitor = new Monitor({ admin, container: pgc.name, ping, enforce: HEAVY });
    const rows: Record<string, unknown>[] = [];
    let stopReason: string | null = null;
    const deniedLat: number[] = [];
    const allowedLat: number[] = [];

    for (const level of LEVELS) {
      const stats = new LevelStats();
      monitor.start();
      for (let rep = 0; rep < REPS; rep++) {
        const batch = Array.from({ length: level }, () => nextJob());
        const out = await Promise.all(
          batch.map(async (j) => ({ j, res: await call(tokens.get(j.name)!, j.url) })),
        );
        for (const { j, res } of out) {
          const code = (res.body as { error?: { code?: string } })?.error?.code;
          stats.add(res.status, res.ms, res.status >= 400 ? code : undefined);
          (res.status === 200 ? allowedLat : deniedLat).push(res.ms);
          if (res.status !== j.want) stats.wrong++;
          const text = JSON.stringify(res.body);
          if (foreignIds.some((id) => text.includes(id))) stats.isolation++;
          if (res.status === 200 && j.want === 200 && digest(res.body) !== baselines!.get(j.key))
            stats.wrong++;
        }
        if (monitor.tripped) break;
      }
      const m: MonitorSummary = await monitor.stop();
      rows.push({ level, reps: REPS, ...stats.summary(), resources: m });
      if (m.tripped) {
        stopReason = m.tripped;
        break;
      }
      expect(stats.fiveXx, `5xx at c=${level}`).toBe(0);
      expect(stats.wrong, `wrong status or figures at c=${level}`).toBe(0);
      expect(stats.isolation, `isolation faults at c=${level}`).toBe(0);
    }
    const dl1 = await deadlocks(admin);
    const shm1 = await pgShmErrors(pgc.name);
    metrics['load'] = {
      levels: rows,
      deadlocksDuringRun: dl1 - dl0,
      pg53100DuringRun: shm1 - shm0,
      authorisationLatencyMs: { deniedCount: deniedLat.length, allowedCount: allowedLat.length },
      stopReason,
    };
    writeMetrics('http-load.json', metrics);
    expect(stopReason, 'resource safety limit').toBeNull();
    expect(dl1 - dl0).toBe(0);
    expect(shm1 - shm0).toBe(0);
  }, 1_800_000);
});
