import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_NOTICE,
  PROVISIONAL_THRESHOLDS,
  buildReport,
  openLoopSchedule,
  percentile,
  summarize,
  type RunResult,
  type SaleOutcome,
} from './driver-core.js';
import { runBenchmark, runOneSale, type DriverConfig, type DriverIo } from './sale-driver.js';
import { preflight } from './safeguards.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('percentile / summarize (nearest rank)', () => {
  it('matches hand-computed values', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect([
      percentile(s, 50),
      percentile(s, 95),
      percentile(s, 99),
      percentile(s, 100),
      percentile(s, 0),
    ]).toEqual([50, 95, 99, 100, 1]);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
    const sum = summarize([30, 10, 20, 40]);
    expect([sum.count, sum.minMs, sum.maxMs, sum.p50Ms, sum.meanMs]).toEqual([4, 10, 40, 20, 25]);
    expect(summarize([]).count).toBe(0);
  });
});

describe('openLoopSchedule — arrivals are clock-driven, not completion-driven', () => {
  it('3/s for 2 s = 6 evenly spaced arrivals; zero or negative inputs schedule nothing', () => {
    const s = openLoopSchedule(3, 2000);
    expect(s).toHaveLength(6);
    expect(s).toEqual([0, 333, 667, 1000, 1333, 1667]);
    expect(openLoopSchedule(0, 1000)).toEqual([]);
    expect(openLoopSchedule(5, 0)).toEqual([]);
    expect(openLoopSchedule(-1, 1000)).toEqual([]);
    expect(openLoopSchedule(100, 10_000)).toHaveLength(1000);
  });
});

describe('buildReport — PROVISIONAL evaluation, never a release verdict', () => {
  const ok = (endToEndMs: number): SaleOutcome => ({
    endToEndMs,
    createMs: 1,
    totalsMs: 1,
    completeMs: endToEndMs - 2,
    ok: true,
    status: 200,
    step: 'complete',
  });
  const run = (sales: SaleOutcome[], over: Partial<RunResult> = {}): RunResult => ({
    durationMs: 10_000,
    scheduled: sales.length,
    started: sales.length,
    sales,
    readerLatenciesMs: [],
    readerErrors: 0,
    droppedByCap: 0,
    ...over,
  });

  it('every output carries the provisional notice and states it is not release criteria', () => {
    const r = buildReport(run([ok(100)]));
    expect(r.notice).toBe(PROVISIONAL_NOTICE);
    expect(r.notice).toMatch(/NOT approved release criteria/);
    expect(r.provisionalEvaluation.isReleaseCriteria).toBe(false);
    expect(PROVISIONAL_THRESHOLDS).toEqual({
      p95MaxMs: 1000,
      p99MaxMs: 2000,
      sustainedSalesPerSecondPerCompanyMin: 3,
    });
  });

  it('compares p95, p99 and sustained throughput to the provisional thresholds', () => {
    const fast = buildReport(run(Array.from({ length: 100 }, () => ok(400)))); // 100 sales / 10 s = 10/s
    expect(fast.provisionalEvaluation).toMatchObject({
      p95WithinThreshold: true,
      p99WithinThreshold: true,
      throughputAtOrAboveThreshold: true,
      noErrorsOrDrops: true,
    });
    const slow = buildReport(
      run([
        ...Array.from({ length: 90 }, () => ok(500)),
        ...Array.from({ length: 10 }, () => ok(2500)),
      ]),
    );
    expect(slow.provisionalEvaluation).toMatchObject({
      p95WithinThreshold: false,
      p99WithinThreshold: false,
    });
    const low = buildReport(run(Array.from({ length: 20 }, () => ok(100)))); // 2/s
    expect(low.provisionalEvaluation.throughputAtOrAboveThreshold).toBe(false);
  });

  it('failures and cap drops are reported, never hidden; an empty run passes nothing', () => {
    const bad: SaleOutcome = {
      endToEndMs: 50,
      createMs: 1,
      totalsMs: 0,
      completeMs: 0,
      ok: false,
      status: 422,
      errorCode: 'CREDIT_LIMIT',
      step: 'complete',
    };
    const r = buildReport(run([ok(100), bad, bad], { droppedByCap: 4 }));
    expect(r.failedSales).toBe(2);
    expect(r.errorsByStatusAndCode).toEqual({ 'complete:422:CREDIT_LIMIT': 2 });
    expect(r.droppedByCap).toBe(4);
    expect(r.provisionalEvaluation.noErrorsOrDrops).toBe(false);
    const empty = buildReport(run([]));
    expect(empty.provisionalEvaluation).toMatchObject({
      p95WithinThreshold: false,
      p99WithinThreshold: false,
      throughputAtOrAboveThreshold: false,
    });
  });
});

// ───────────────────────── the driver against a fake HTTP layer ─────────────────────────

const CFG: DriverConfig = {
  baseUrl: 'https://bench.invalid',
  token: 'tok-secret',
  companyId: 'co-1',
  branchId: 'br-1',
  productId: 'prod-1',
  variantId: 'var-1',
  uomCode: 'piece',
  quantity: '2',
  ratePerSecond: 50,
  durationMs: 300,
  warmupMs: 100,
  maxInFlight: 100,
  reportReaders: 0,
  reportPaths: [],
  readerIntervalMs: 10,
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeIo(
  opts: { latencyMs?: number; createStatus?: number; completeStatus?: number } = {},
): { io: DriverIo; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const io: DriverIo = {
    now: () => performance.now(),
    sleep: (ms) => sleep(ms).then(() => undefined),
    uuid: () => `u${++n}`,
    fetch: async (url, init) => {
      calls.push({
        method: init.method,
        url,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      await sleep(opts.latencyMs ?? 2);
      if (init.method === 'POST' && url.endsWith('/orders')) {
        const st = opts.createStatus ?? 201;
        return {
          status: st,
          json: async () =>
            st === 201 ? { order: { id: `ord-${n}`, version: 3 } } : { error: { code: 'BOOM' } },
        };
      }
      if (url.endsWith('/totals'))
        return { status: 200, json: async () => ({ totalAmountMinor: '10500' }) };
      if (url.endsWith('/complete-sale')) {
        const st = opts.completeStatus ?? 200;
        return {
          status: st,
          json: async () => (st === 200 ? { invoice: { id: 'inv' } } : { error: { code: 'NOPE' } }),
        };
      }
      return { status: 200, json: async () => ({}) }; // a report read
    },
  };
  return { io, calls };
}

describe('runOneSale — the real public workflow, in order', () => {
  it('create → totals → complete-sale; PAY_NOW with ONE cash tender equal to the server total; unique idempotency keys; If-Match = order version; the token only in Authorization', async () => {
    const { io, calls } = fakeIo();
    const o = await runOneSale(CFG, io, io.now());
    expect(o).toMatchObject({ ok: true, status: 200, step: 'complete' });
    expect(
      calls.map((c) => `${c.method} ${c.url.replace('https://bench.invalid/v1', '')}`),
    ).toEqual([
      'POST /companies/co-1/branches/br-1/orders',
      'GET /companies/co-1/branches/br-1/orders/ord-2/totals'.replace(
        'ord-2',
        calls[1]!.url.split('/orders/')[1]!.split('/')[0]!,
      ),
      `POST /companies/co-1/branches/br-1/orders/${calls[1]!.url.split('/orders/')[1]!.split('/')[0]}/complete-sale`,
    ]);
    expect(calls[0]!.body).toEqual({
      lines: [{ productId: 'prod-1', variantId: 'var-1', selectedUomCode: 'piece', quantity: '2' }],
    });
    expect(calls[2]!.body).toEqual({
      paymentIntent: 'PAY_NOW',
      tenders: [{ method: 'CASH', amountMinor: '10500' }],
    });
    expect(calls[2]!.headers['if-match']).toBe('3');
    const keys = calls.map((c) => c.headers['idempotency-key']).filter(Boolean);
    expect(new Set(keys).size).toBe(2);
    for (const c of calls) expect(c.headers['authorization']).toBe('Bearer tok-secret');
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('tok-secret');
  });

  it('a failed create stops the sale at that step (no totals, no completion) and reports its code', async () => {
    const { io, calls } = fakeIo({ createStatus: 500 });
    const o = await runOneSale(CFG, io, io.now());
    expect(o).toMatchObject({ ok: false, status: 500, step: 'create', errorCode: 'BOOM' });
    expect(calls).toHaveLength(1);
  });

  it('a rejected completion is reported with its status and code', async () => {
    const { io } = fakeIo({ completeStatus: 422 });
    expect(await runOneSale(CFG, io, io.now())).toMatchObject({
      ok: false,
      status: 422,
      step: 'complete',
      errorCode: 'NOPE',
    });
  });
});

describe('runBenchmark', () => {
  it('open loop: every scheduled arrival becomes a measured sale; the warm-up is discarded', async () => {
    const { io, calls } = fakeIo();
    const r = await runBenchmark(CFG, io);
    expect(r.scheduled).toBe(openLoopSchedule(50, 300).length);
    expect(r.sales).toHaveLength(r.scheduled);
    expect(r.sales.every((s) => s.ok)).toBe(true);
    expect(r.droppedByCap).toBe(0);
    const completes = calls.filter((c) => c.url.endsWith('/complete-sale')).length;
    expect(completes).toBe(openLoopSchedule(50, 100).length + r.scheduled); // warm-up sales happened but are not in `sales`
  });

  it('a saturated target does NOT slow the arrivals: surplus arrivals are DROPPED by the cap and counted', async () => {
    const { io } = fakeIo({ latencyMs: 80 });
    const r = await runBenchmark({ ...CFG, maxInFlight: 1, warmupMs: 0, durationMs: 400 }, io);
    expect(r.droppedByCap).toBeGreaterThan(0);
    expect(r.started + r.droppedByCap).toBe(r.scheduled);
  });

  it('concurrent report readers are measured only in the measured window, and their errors are counted', async () => {
    const { io, calls } = fakeIo();
    const r = await runBenchmark(
      {
        ...CFG,
        reportReaders: 2,
        reportPaths: ['/reports/trial-balance', '/reports/sales'],
        readerIntervalMs: 20,
      },
      io,
    );
    expect(r.readerLatenciesMs.length).toBeGreaterThan(0);
    expect(r.readerErrors).toBe(0);
    expect(calls.some((c) => c.url.endsWith('/reports/trial-balance'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/reports/sales'))).toBe(true);
  });
});

describe('the CLI is safe by construction', () => {
  const cli = readFileSync(join(HERE, 'cli.ts'), 'utf8');
  it('runs the pre-flight BEFORE anything else is read or sent, and never prints the token', () => {
    expect(cli).toMatch(/import \{ DEFAULT_MAX_DOCUMENTS, preflight \} from '\.\/safeguards\.js'/);
    expect(cli.indexOf('preflight({')).toBeGreaterThan(-1);
    // the pre-flight (and the dry-run exit) precede the construction of the driver configuration and of any request
    expect(cli.indexOf('preflight({')).toBeLessThan(cli.indexOf('const config: DriverConfig'));
    expect(cli.indexOf("env['DRY_RUN']")).toBeLessThan(cli.indexOf('const config: DriverConfig'));
    expect(cli).toMatch(/token: '\[redacted\]'/);
    expect(cli).not.toMatch(/console\./);
  });
  it('contains no database access, no credentials and no card data', () => {
    for (const f of ['cli.ts', 'sale-driver.ts', 'driver-core.ts', 'safeguards.ts']) {
      const t = readFileSync(join(HERE, f), 'utf8');
      expect(t, f).not.toMatch(
        /@flower\/db|prisma|pg\b|DATABASE_URL|password|CARD_TERMINAL|\b4\d{15}\b/i,
      );
    }
  });
});

describe('pre-flight safeguards — nothing is sent unless every condition is proven', () => {
  const ok = {
    allowFinancialWrites: 'yes',
    baseUrl: 'https://bench.example.com',
    confirmTargetHost: 'bench.example.com',
    ratePerSecond: 3,
    durationS: 600,
    warmupS: 300,
    maxDocuments: 20_000,
  };
  it('accepts a confirmed https target within the document ceiling and reports the plan', () => {
    expect(preflight(ok)).toEqual({
      ok: true,
      host: 'bench.example.com',
      plannedSales: 1800,
      warmupSales: 900,
    });
  });
  it('refuses without the financial-writes opt-in', () => {
    for (const v of [undefined, '', 'true', 'YES', '1']) {
      const r = preflight({ ...ok, allowFinancialWrites: v });
      expect(r.ok).toBe(false);
    }
  });
  it('refuses a non-https remote target, an invalid URL, and accepts http only for localhost', () => {
    expect(preflight({ ...ok, baseUrl: 'http://bench.example.com' }).ok).toBe(false);
    expect(preflight({ ...ok, baseUrl: 'not a url' }).ok).toBe(false);
    expect(
      preflight({ ...ok, baseUrl: 'http://localhost:3000', confirmTargetHost: 'localhost' }).ok,
    ).toBe(true);
    expect(
      preflight({ ...ok, baseUrl: 'http://127.0.0.1:3000', confirmTargetHost: '127.0.0.1' }).ok,
    ).toBe(true);
  });
  it('requires the typed host confirmation to equal the target host exactly (a pasted production URL cannot slip through)', () => {
    for (const c of [
      undefined,
      '',
      'prod.example.com',
      'bench.example.com.evil.test',
      'BENCH.example.com ',
    ]) {
      const r = preflight({ ...ok, confirmTargetHost: c });
      expect(r.ok, String(c)).toBe(false);
    }
    // a look-alike target whose host the operator did NOT type is refused even though the opt-in is present
    expect(preflight({ ...ok, baseUrl: 'https://api.production.example.com' }).ok).toBe(false);
  });
  it('bounds the number of financial documents a run can create', () => {
    const r = preflight({ ...ok, ratePerSecond: 50 });
    expect(r.ok).toBe(false);
    expect(preflight({ ...ok, ratePerSecond: 50, maxDocuments: 100_000 }).ok).toBe(true);
    // warm-up sales count toward the ceiling too
    expect(
      preflight({ ...ok, ratePerSecond: 10, durationS: 900, warmupS: 1200, maxDocuments: 20_000 })
        .ok,
    ).toBe(false);
  });
  it('rejects non-positive and non-numeric run parameters', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(preflight({ ...ok, ratePerSecond: bad }).ok).toBe(false);
      expect(preflight({ ...ok, durationS: bad }).ok).toBe(false);
      expect(preflight({ ...ok, warmupS: bad }).ok).toBe(false);
      expect(preflight({ ...ok, maxDocuments: bad }).ok).toBe(false);
    }
  });
});
