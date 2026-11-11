import { openLoopSchedule, type RunResult, type SaleOutcome } from './driver-core.js';

/**
 * HG3b-SALE-LATENCY — the staging load DRIVER (injectable I/O so it is unit-testable without a network). It exercises the REAL public
 * HTTP sale workflow of the deployment it is pointed at: create an anonymous order → read the canonical totals → complete the sale
 * (PAY_NOW, one CASH tender equal to the total). It therefore CREATES REAL FINANCIAL DOCUMENTS in the target (orders, invoices,
 * payments, journals) and must only ever be pointed at a dedicated benchmark environment; the CLI refuses to start without an
 * explicit opt-in. It writes nothing to any database directly. Optional concurrent REPORT READERS measure sales latency while
 * reports run (scenario S4 of the spec).
 */
export interface DriverConfig {
  readonly baseUrl: string; // e.g. https://staging.example.com  (no trailing slash)
  readonly token: string; // a bearer access token of a user allowed to create and complete sales in the branch
  readonly companyId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly uomCode: string;
  readonly quantity: string;
  /** sales per second (open loop) */
  readonly ratePerSecond: number;
  readonly durationMs: number;
  readonly warmupMs: number;
  /** a driver-side safety cap on sales in flight; arrivals beyond it are DROPPED and counted, never silently delayed */
  readonly maxInFlight: number;
  /** number of concurrent report readers (0 = sales only) and the GET paths they cycle through (path + query, relative to /v1) */
  readonly reportReaders: number;
  readonly reportPaths: readonly string[];
  readonly readerIntervalMs: number;
}

export interface DriverIo {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    json(): Promise<unknown>;
  }>;
  /** monotonic milliseconds */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** a fresh unique id (for Idempotency-Key) */
  uuid(): string;
}

const api = (c: DriverConfig, path: string): string => `${c.baseUrl}/v1${path}`;
const headers = (c: DriverConfig, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${c.token}`,
  'content-type': 'application/json',
  ...extra,
});
const errCode = (b: unknown): string | undefined =>
  (b as { error?: { code?: string } } | null)?.error?.code;
const safeJson = async (r: { json(): Promise<unknown> }): Promise<unknown> => {
  try {
    return await r.json();
  } catch {
    return null;
  }
};

/** one full sale; `arrivedAt` is the SCHEDULED arrival, so client-side queueing is included in the end-to-end latency */
export async function runOneSale(
  c: DriverConfig,
  io: DriverIo,
  arrivedAt: number,
): Promise<SaleOutcome> {
  const scope = `/companies/${c.companyId}/branches/${c.branchId}`;
  const t0 = io.now();
  const created = await io.fetch(api(c, `${scope}/orders`), {
    method: 'POST',
    headers: headers(c, { 'idempotency-key': `bench-o-${io.uuid()}` }),
    body: JSON.stringify({
      lines: [
        {
          productId: c.productId,
          variantId: c.variantId,
          selectedUomCode: c.uomCode,
          quantity: c.quantity,
        },
      ],
    }),
  });
  const t1 = io.now();
  const createdBody = await safeJson(created);
  const fail = (
    step: SaleOutcome['step'],
    status: number,
    body: unknown,
    mid: number,
  ): SaleOutcome => ({
    endToEndMs: io.now() - arrivedAt,
    createMs: t1 - t0,
    totalsMs: step === 'create' ? 0 : mid,
    completeMs: 0,
    ok: false,
    status,
    errorCode: errCode(body),
    step,
  });
  const order = (createdBody as { order?: { id?: string; version?: number } } | null)?.order;
  if (created.status !== 201 || !order?.id) return fail('create', created.status, createdBody, 0);

  const totals = await io.fetch(api(c, `${scope}/orders/${order.id}/totals`), {
    method: 'GET',
    headers: headers(c),
  });
  const t2 = io.now();
  const totalsBody = await safeJson(totals);
  const total = (totalsBody as { totalAmountMinor?: string } | null)?.totalAmountMinor;
  if (totals.status !== 200 || typeof total !== 'string')
    return fail('totals', totals.status, totalsBody, t2 - t1);

  const done = await io.fetch(api(c, `${scope}/orders/${order.id}/complete-sale`), {
    method: 'POST',
    headers: headers(c, {
      'idempotency-key': `bench-s-${io.uuid()}`,
      'if-match': String(order.version ?? 1),
    }),
    body: JSON.stringify({
      paymentIntent: 'PAY_NOW',
      tenders: [{ method: 'CASH', amountMinor: total }],
    }),
  });
  const t3 = io.now();
  const doneBody = await safeJson(done);
  return {
    endToEndMs: t3 - arrivedAt,
    createMs: t1 - t0,
    totalsMs: t2 - t1,
    completeMs: t3 - t2,
    ok: done.status === 200,
    status: done.status,
    errorCode: done.status === 200 ? undefined : errCode(doneBody),
    step: 'complete',
  };
}

/**
 * The measured run: an OPEN-LOOP schedule of sales at `ratePerSecond` for `durationMs` (after an unmeasured `warmupMs` at the same
 * rate), with `reportReaders` concurrent readers when configured. Returns the raw outcomes for `buildReport`.
 */
export async function runBenchmark(c: DriverConfig, io: DriverIo): Promise<RunResult> {
  // warm-up: same load, discarded
  await runWindow(c, io, c.warmupMs, false);
  return runWindow(c, io, c.durationMs, true);
}

async function runWindow(
  c: DriverConfig,
  io: DriverIo,
  windowMs: number,
  keepReaders: boolean,
): Promise<RunResult> {
  const schedule = openLoopSchedule(c.ratePerSecond, windowMs);
  const sales: SaleOutcome[] = [];
  const readerLatencies: number[] = [];
  let readerErrors = 0;
  let inFlight = 0;
  let dropped = 0;
  let started = 0;
  let stop = false;
  const start = io.now();
  const pending: Promise<void>[] = [];

  const readers: Promise<void>[] = [];
  if (c.reportReaders > 0 && c.reportPaths.length > 0) {
    for (let i = 0; i < c.reportReaders; i++) {
      readers.push(
        (async () => {
          let n = i;
          while (!stop) {
            const path = c.reportPaths[n++ % c.reportPaths.length]!;
            const t = io.now();
            try {
              const r = await io.fetch(api(c, path), { method: 'GET', headers: headers(c) });
              if (keepReaders) {
                if (r.status === 200) readerLatencies.push(io.now() - t);
                else readerErrors++;
              }
            } catch {
              if (keepReaders) readerErrors++;
            }
            await io.sleep(c.readerIntervalMs);
          }
        })(),
      );
    }
  }

  for (const offset of schedule) {
    const wait = start + offset - io.now();
    if (wait > 0) await io.sleep(wait);
    if (inFlight >= c.maxInFlight) {
      dropped++;
      continue;
    }
    inFlight++;
    started++;
    const arrivedAt = start + offset;
    pending.push(
      runOneSale(c, io, arrivedAt)
        .then((o) => {
          if (keepReaders) sales.push(o);
        })
        .catch(() => {
          if (keepReaders)
            sales.push({
              endToEndMs: io.now() - arrivedAt,
              createMs: 0,
              totalsMs: 0,
              completeMs: 0,
              ok: false,
              status: 0,
              errorCode: 'NETWORK_ERROR',
              step: 'create',
            });
        })
        .finally(() => {
          inFlight--;
        }),
    );
  }
  await Promise.all(pending);
  stop = true;
  await Promise.all(readers);
  return {
    durationMs: windowMs,
    scheduled: schedule.length,
    started,
    sales: keepReaders ? sales : [],
    readerLatenciesMs: readerLatencies,
    readerErrors,
    droppedByCap: keepReaders ? dropped : 0,
  };
}
