import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { createSaleWorld, type SaleWorld } from '../verification/load-sale-world.js';
import { buildReport } from './driver-core.js';
import { runBenchmark, type DriverConfig, type DriverIo } from './sale-driver.js';

/**
 * HG3b-SALE-LATENCY — COMPATIBILITY of the staging load driver with the REAL API. The unit tests use a fake transport and therefore
 * cannot prove the driver speaks the real protocol. This test runs the REAL `runBenchmark` with the REAL `fetch` over a REAL socket
 * against the REAL application (all guards, real Redis, real PostgreSQL, 50 migrations), then runs the runbook's post-run correctness
 * checks (spec §8 step 6) as SQL against the database.
 *
 * It proves the REQUEST SEQUENCE AND CONTRACT are correct. It measures NOTHING about performance and its figures are meaningless
 * (a developer machine, a few sales) — the report it builds is discarded.
 */
describe('staging load driver — compatibility with the real API (NOT a performance measurement)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let admin: pg.Pool;
  let baseUrl = '';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    admin = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 3);
    await w.h.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = (await w.h.app.getUrl()).replace('[::1]', '127.0.0.1');
  }, 600_000);

  afterAll(async () => {
    await w?.h.app.close();
    await w?.pool?.end();
    await admin?.end();
    await stack?.stop();
  });

  it('a short real run completes every scheduled sale with 200; each is one invoice, one payment, one balanced sale journal; invoice numbers are gapless; reports read concurrently answer 200', async () => {
    const config: DriverConfig = {
      baseUrl,
      token: w.ownerToken,
      companyId: w.a.companyId,
      branchId: w.a.branches[0]!,
      productId: w.productId,
      variantId: w.variantId,
      uomCode: 'piece',
      quantity: '1',
      ratePerSecond: 4,
      durationMs: 3_000,
      warmupMs: 1_000,
      maxInFlight: 50,
      reportReaders: 1,
      reportPaths: [
        `/companies/${w.a.companyId}/reports/trial-balance?from=2020-01-01&to=2020-01-31`,
      ],
      readerIntervalMs: 200,
    };
    const io: DriverIo = {
      fetch: (url, init) => fetch(url, init),
      now: () => performance.now(),
      sleep: (ms) => sleep(ms).then(() => undefined),
      uuid: () => randomUUID(),
    };
    const run = await runBenchmark(config, io);
    const report = buildReport(run);

    // the protocol worked end to end: nothing failed, nothing was dropped, every scheduled arrival became a completed sale
    expect(report.errorsByStatusAndCode).toEqual({});
    expect(report.failedSales).toBe(0);
    expect(report.droppedByCap).toBe(0);
    expect(report.completedSales).toBe(report.scheduledSales);
    expect(report.completedSales).toBeGreaterThan(0);
    expect(report.provisionalEvaluation.isReleaseCriteria).toBe(false);
    expect(report.readers.errors).toBe(0);

    // the runbook's post-run correctness checks (spec §8 step 6), as SQL — warm-up sales are real too, so count ALL of the company's
    const co = w.a.companyId;
    const q = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
      (await admin.query(sql, [co])).rows as T[];
    const invoices = await q<{ n: string }>(
      `SELECT count(*)::text n FROM invoice WHERE "companyId" = $1`,
    );
    expect(Number(invoices[0]!.n)).toBeGreaterThanOrEqual(report.completedSales);
    // 1. invoice numbers gapless per company
    const gap = await q<{ ok: boolean }>(
      `SELECT (max(x) - min(x) + 1 = count(*)) AS ok
         FROM (SELECT regexp_replace("invoiceNumber", '\\D', '', 'g')::bigint AS x FROM invoice WHERE "companyId" = $1) s`,
    );
    expect(gap[0]!.ok).toBe(true);
    // 2. exactly one walk_in_sale journal per issued invoice
    const missingOrDup = await q(
      `SELECT i.id FROM invoice i
         LEFT JOIN journal_entry je ON je."sourceKind" = 'walk_in_sale' AND je."sourceId" = i.id::text
        WHERE i."companyId" = $1 GROUP BY i.id HAVING count(je.id) <> 1`,
    );
    expect(missingOrDup).toHaveLength(0);
    // 3. every journal balanced
    const unbalanced = await q(
      `SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
        WHERE je."companyId" = $1 GROUP BY je.id HAVING sum(jl."debitMinor") <> sum(jl."creditMinor")`,
    );
    expect(unbalanced).toHaveLength(0);
    // 4. no duplicate sale: exactly one payment allocation per invoice (every key was unique, every sale paid once)
    const dupPay = await q(
      `SELECT i.id FROM invoice i LEFT JOIN payment_allocation pa ON pa."invoiceId" = i.id
        WHERE i."companyId" = $1 GROUP BY i.id HAVING count(pa.id) <> 1`,
    );
    expect(dupPay).toHaveLength(0);
  }, 120_000);
});
