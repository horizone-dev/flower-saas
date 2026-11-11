/**
 * HG3b-SALE-LATENCY — pure core of the STAGING load driver (docs/phase-3/HG3B-SALE-LATENCY-ENVIRONMENT-SPEC.md §8). No I/O, no clock, no
 * randomness: percentile maths, the open-loop arrival schedule and the report. The thresholds below are the owner's PROVISIONAL
 * evaluation thresholds for this batch — they are NOT approved release criteria and the report says so on every output.
 */

/** provisional evaluation thresholds (owner instruction 2026-11-11) — NOT approved release criteria */
export const PROVISIONAL_THRESHOLDS = Object.freeze({
  p95MaxMs: 1000,
  p99MaxMs: 2000,
  sustainedSalesPerSecondPerCompanyMin: 3,
});

export const PROVISIONAL_NOTICE =
  'PROVISIONAL evaluation thresholds only (p95 <= 1000 ms, p99 <= 2000 ms, >= 3 sustained sales/s/company). They are NOT approved release criteria and a result from a non-representative environment is NOT staging capacity.';

/** nearest-rank percentile of an ASCENDING-sorted array; NaN for an empty array */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 100) return sortedAsc[sortedAsc.length - 1]!;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1]!;
}

export interface LatencySummary {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

export function summarize(latenciesMs: readonly number[]): LatencySummary {
  const s = [...latenciesMs].sort((a, b) => a - b);
  const n = s.length;
  return {
    count: n,
    minMs: n ? s[0]! : Number.NaN,
    p50Ms: percentile(s, 50),
    p95Ms: percentile(s, 95),
    p99Ms: percentile(s, 99),
    maxMs: n ? s[n - 1]! : Number.NaN,
    meanMs: n ? s.reduce((a, b) => a + b, 0) / n : Number.NaN,
  };
}

/**
 * OPEN-LOOP arrival offsets (ms from the start): one arrival every `1000 / ratePerSecond` ms for `durationMs`. Arrivals are scheduled
 * by the clock, NOT by completions, so a slow server cannot hide its latency by slowing the load ("coordinated omission").
 */
export function openLoopSchedule(ratePerSecond: number, durationMs: number): number[] {
  if (!(ratePerSecond > 0) || !(durationMs > 0)) return [];
  const interval = 1000 / ratePerSecond;
  const out: number[] = [];
  for (let i = 0; i * interval < durationMs; i++) out.push(Math.round(i * interval));
  return out;
}

export interface SaleOutcome {
  /** ms from the scheduled arrival to the completed sale (includes any client-side queueing) */
  readonly endToEndMs: number;
  readonly createMs: number;
  readonly totalsMs: number;
  readonly completeMs: number;
  readonly ok: boolean;
  readonly status: number;
  readonly errorCode?: string | undefined;
  readonly step: 'create' | 'totals' | 'complete';
}

export interface RunResult {
  readonly durationMs: number;
  readonly scheduled: number;
  readonly started: number;
  readonly sales: readonly SaleOutcome[];
  readonly readerLatenciesMs: readonly number[];
  readonly readerErrors: number;
  /** arrivals dropped because the in-flight cap was reached (a driver-side saturation signal, reported, never hidden) */
  readonly droppedByCap: number;
}

export interface Report {
  readonly notice: string;
  readonly thresholds: typeof PROVISIONAL_THRESHOLDS;
  readonly scheduledSales: number;
  readonly completedSales: number;
  readonly failedSales: number;
  readonly droppedByCap: number;
  readonly achievedSalesPerSecond: number;
  readonly endToEnd: LatencySummary;
  readonly create: LatencySummary;
  readonly totals: LatencySummary;
  readonly complete: LatencySummary;
  readonly readers: LatencySummary & { readonly errors: number };
  readonly errorsByStatusAndCode: Readonly<Record<string, number>>;
  /** provisional comparison — informational, never a release verdict */
  readonly provisionalEvaluation: {
    readonly p95WithinThreshold: boolean;
    readonly p99WithinThreshold: boolean;
    readonly throughputAtOrAboveThreshold: boolean;
    readonly noErrorsOrDrops: boolean;
    readonly isReleaseCriteria: false;
  };
}

export function buildReport(r: RunResult): Report {
  const ok = r.sales.filter((s) => s.ok);
  const failed = r.sales.filter((s) => !s.ok);
  const errors: Record<string, number> = {};
  for (const f of failed) {
    const k = `${f.step}:${f.status}:${f.errorCode ?? 'NO_CODE'}`;
    errors[k] = (errors[k] ?? 0) + 1;
  }
  const seconds = r.durationMs / 1000;
  const endToEnd = summarize(ok.map((s) => s.endToEndMs));
  const achieved = seconds > 0 ? ok.length / seconds : 0;
  return {
    notice: PROVISIONAL_NOTICE,
    thresholds: PROVISIONAL_THRESHOLDS,
    scheduledSales: r.scheduled,
    completedSales: ok.length,
    failedSales: failed.length,
    droppedByCap: r.droppedByCap,
    achievedSalesPerSecond: Math.round(achieved * 1000) / 1000,
    endToEnd,
    create: summarize(ok.map((s) => s.createMs)),
    totals: summarize(ok.map((s) => s.totalsMs)),
    complete: summarize(ok.map((s) => s.completeMs)),
    readers: { ...summarize(r.readerLatenciesMs), errors: r.readerErrors },
    errorsByStatusAndCode: errors,
    provisionalEvaluation: {
      p95WithinThreshold: ok.length > 0 && endToEnd.p95Ms <= PROVISIONAL_THRESHOLDS.p95MaxMs,
      p99WithinThreshold: ok.length > 0 && endToEnd.p99Ms <= PROVISIONAL_THRESHOLDS.p99MaxMs,
      throughputAtOrAboveThreshold:
        achieved >= PROVISIONAL_THRESHOLDS.sustainedSalesPerSecondPerCompanyMin,
      noErrorsOrDrops: failed.length === 0 && r.droppedByCap === 0,
      isReleaseCriteria: false,
    },
  };
}
