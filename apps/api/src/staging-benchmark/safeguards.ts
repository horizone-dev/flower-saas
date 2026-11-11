/**
 * HG3b-SALE-LATENCY — pre-flight SAFEGUARDS of the staging load driver, pure and unit-tested. The driver creates REAL financial documents
 * (orders, invoices, payments, journals) in whatever it is pointed at, so before a single request is sent it must be provable that:
 *   1. the operator opted in to financial writes (`ALLOW_FINANCIAL_WRITES=yes`);
 *   2. the target is https (or localhost);
 *   3. the operator TYPED the target's host name (`CONFIRM_TARGET_HOST`) and it equals the host of `BASE_URL` — a mistyped or pasted
 *      production URL cannot be benchmarked by accident;
 *   4. the run cannot create more than `MAX_DOCUMENTS` sales (default 20 000) unless that ceiling is raised deliberately;
 *   5. a `DRY_RUN=yes` prints the plan and sends NOTHING.
 */
export interface PreflightInput {
  readonly allowFinancialWrites: string | undefined;
  readonly baseUrl: string;
  readonly confirmTargetHost: string | undefined;
  readonly ratePerSecond: number;
  readonly durationS: number;
  readonly warmupS: number;
  readonly maxDocuments: number;
}

export type Preflight =
  | {
      readonly ok: true;
      readonly host: string;
      readonly plannedSales: number;
      readonly warmupSales: number;
    }
  | { readonly ok: false; readonly reason: string };

export const DEFAULT_MAX_DOCUMENTS = 20_000;

export function preflight(i: PreflightInput): Preflight {
  if (i.allowFinancialWrites !== 'yes')
    return {
      ok: false,
      reason:
        'this driver creates REAL financial documents; set ALLOW_FINANCIAL_WRITES=yes to confirm the target is a dedicated benchmark environment',
    };
  let url: URL;
  try {
    url = new URL(i.baseUrl);
  } catch {
    return { ok: false, reason: 'BASE_URL is not a valid URL' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    return { ok: false, reason: 'BASE_URL must be https (or http only for localhost)' };
  if (i.confirmTargetHost !== url.hostname)
    return {
      ok: false,
      reason: `CONFIRM_TARGET_HOST must be set to exactly the target host name (${url.hostname}) to prove the target is the intended benchmark environment`,
    };
  for (const [n, v] of [
    ['RATE', i.ratePerSecond],
    ['DURATION_S', i.durationS],
    ['WARMUP_S', i.warmupS],
    ['MAX_DOCUMENTS', i.maxDocuments],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0)
      return { ok: false, reason: `${n} must be a positive number` };
  }
  const plannedSales = Math.floor(i.ratePerSecond * i.durationS);
  const warmupSales = Math.floor(i.ratePerSecond * i.warmupS);
  if (plannedSales + warmupSales > i.maxDocuments)
    return {
      ok: false,
      reason: `the run would create up to ${plannedSales + warmupSales} sales, above MAX_DOCUMENTS=${i.maxDocuments}; lower RATE / DURATION_S / WARMUP_S or raise MAX_DOCUMENTS deliberately`,
    };
  return { ok: true, host: url.hostname, plannedSales, warmupSales };
}
