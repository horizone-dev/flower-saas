import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildReport } from './driver-core.js';
import { runBenchmark, type DriverConfig, type DriverIo } from './sale-driver.js';
import { DEFAULT_MAX_DOCUMENTS, preflight } from './safeguards.js';

/**
 * Staging sale-latency benchmark — command line. Usage (Node 24, no build step):
 *
 *   ALLOW_FINANCIAL_WRITES=yes BASE_URL=https://bench.example.com CONFIRM_TARGET_HOST=bench.example.com TOKEN=… COMPANY_ID=… BRANCH_ID=… \
 *   PRODUCT_ID=… VARIANT_ID=… RATE=3 DURATION_S=600 WARMUP_S=300 node apps/api/dist/staging-benchmark/cli.js
 *   (after `pnpm --filter @flower/api build`; add DRY_RUN=yes first — it prints the plan and sends NOTHING)
 *
 * It CREATES REAL orders, invoices, payments and journal entries in BASE_URL. `safeguards.ts` refuses to start unless
 * ALLOW_FINANCIAL_WRITES=yes, the URL is https (or localhost), CONFIRM_TARGET_HOST equals the target's host name, and the run stays under
 * MAX_DOCUMENTS (default 20 000) sales. Output is ONE JSON document on stdout: the raw run summary and the PROVISIONAL evaluation
 * (never a release verdict). Exit code 0 = the run completed (whatever the figures), 2 = refused / misconfiguration.
 */
const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};

function main(): Promise<void> {
  const baseUrl = need('BASE_URL').replace(/\/+$/, '');
  const check = preflight({
    allowFinancialWrites: env['ALLOW_FINANCIAL_WRITES'],
    baseUrl,
    confirmTargetHost: env['CONFIRM_TARGET_HOST'],
    ratePerSecond: Number(env['RATE'] ?? '3'),
    durationS: Number(env['DURATION_S'] ?? '600'),
    warmupS: Number(env['WARMUP_S'] ?? '300'),
    maxDocuments: Number(env['MAX_DOCUMENTS'] ?? String(DEFAULT_MAX_DOCUMENTS)),
  });
  if (!check.ok) {
    process.stderr.write(`refused: ${check.reason}\n`);
    process.exitCode = 2;
    return Promise.resolve();
  }
  if (env['DRY_RUN'] === 'yes') {
    process.stdout.write(
      JSON.stringify(
        {
          dryRun: true,
          sentNothing: true,
          target: baseUrl,
          host: check.host,
          plannedSales: check.plannedSales,
          warmupSales: check.warmupSales,
        },
        null,
        2,
      ) + '\n',
    );
    return Promise.resolve();
  }
  const config: DriverConfig = {
    baseUrl,
    token: need('TOKEN'),
    companyId: need('COMPANY_ID'),
    branchId: need('BRANCH_ID'),
    productId: need('PRODUCT_ID'),
    variantId: need('VARIANT_ID'),
    uomCode: env['UOM_CODE'] ?? 'piece',
    quantity: env['QUANTITY'] ?? '1',
    ratePerSecond: Number(env['RATE'] ?? '3'),
    durationMs: Number(env['DURATION_S'] ?? '600') * 1000,
    warmupMs: Number(env['WARMUP_S'] ?? '300') * 1000,
    maxInFlight: Number(env['MAX_IN_FLIGHT'] ?? '200'),
    reportReaders: Number(env['REPORT_READERS'] ?? '0'),
    reportPaths: (env['REPORT_PATHS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    readerIntervalMs: Number(env['READER_INTERVAL_MS'] ?? '250'),
  };
  const io: DriverIo = {
    fetch: (url, init) => fetch(url, init),
    now: () => performance.now(),
    sleep: (ms) => sleep(ms).then(() => undefined),
    uuid: () => randomUUID(),
  };
  return runBenchmark(config, io).then((run) => {
    process.stdout.write(
      JSON.stringify(
        { target: baseUrl, config: { ...config, token: '[redacted]' }, report: buildReport(run) },
        null,
        2,
      ) + '\n',
    );
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`benchmark aborted: ${e instanceof Error ? e.message : 'error'}\n`);
  process.exitCode = 2;
});
