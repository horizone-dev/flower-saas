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
  max,
  pct,
  pgShmErrors,
  postgresSettings,
  startLoadPostgres,
  writeMetrics,
  type HttpResult,
  type LoadPostgres,
  type MonitorSummary,
} from './load-support.js';
import { PERIOD, createSaleWorld, type SaleWorld } from './load-sale-world.js';

/**
 * Task 3b.10 Checkpoint G — BOUNDED MIXED READ / WRITE LOAD (OPT-IN: `G_LOAD=1`).
 *
 * Reporting reads run alongside REAL sales: every writer creates an order and completes the sale ONLY through the public HTTP
 * routes (`POST …/orders`, `POST …/orders/:id/complete-sale`, with `Idempotency-Key`s — a fraction of them deliberately
 * replayed), so the existing transaction, payment, journal and audit logic runs untouched. Three phases of `G_PHASE_SECONDS`
 * (default 60): writes only · reads only (1 / 2 / 5 / 10 readers, a quarter of the phase each) · mixed (the same readers
 * with the writers running). At most two writers per company.
 *
 * Concurrent writes legitimately change what a report sees, so live reports are NOT compared with one fixed baseline: each
 * result must be internally consistent (the frozen one-statement snapshot — no 409 integrity failure, the Trial Balance control
 * totals equal, no failed reconciliation flag), and after the writers stop a final sequential read is reconciled with the
 * source rows and the sealed journals. This is NOT a sale-latency certification: `HG3b-SALE-LATENCY` stays open.
 * Local test-container observations; not production capacity.
 *
 *   G_PHASE_SECONDS   seconds per phase (default 60; a smaller value only for a dry run)
 */
const PHASE_S = Math.max(4, Number(process.env['G_PHASE_SECONDS'] ?? 60));
const LEVELS = [1, 2, 5, 10];
const WRITERS = 2;

const Q = `from=${PERIOD.from}&to=${PERIOD.to}`;
const READS = [
  { slug: 'trial-balance', query: Q },
  { slug: 'sales', query: Q },
  { slug: 'tender-totals', query: Q },
  { slug: 'receivables', query: '' },
] as const;

describe.skipIf(!HEAVY)(
  'Mixed read / write load — reports alongside real sales (task 3b.10 Checkpoint G)',
  () => {
    let pgc: LoadPostgres;
    let redis: TestStack;
    let w: SaleWorld;
    let admin: pg.Pool;
    const metrics: Record<string, unknown> = {
      disclaimer: DISCLAIMER,
      phaseSeconds: PHASE_S,
      writers: WRITERS,
    };

    // committed-write ledger of the run (what the system acknowledged)
    const acknowledged = { walkIn: [] as string[], credit: [] as string[], receipts: 0 };
    let writerSeq = 0;
    let stopWriters = false;
    const writerErrors = new Map<string, number>();
    const replay = { attempted: 0, identical: 0, mismatched: 0 };
    const fiveXxSeen: string[] = [];

    beforeAll(async () => {
      pgc = await startLoadPostgres('mixed');
      redis = await startTestStack({ services: ['redis'] });
      migrateTestDb(pgc.url);
      w = await createSaleWorld({ pg: pgc.url, redis: redis.redis.url }, 3);
      admin = new pg.Pool({ connectionString: pgc.url, max: 3 });
      metrics['settings'] = await postgresSettings(admin, pgc.name);
      // a small preloaded history so every report has data from the first request (through the public routes)
      for (let i = 0; i < 12; i++) {
        const s = await w.sale({ co: w.a, branch: w.a.branches[i % 3]!, token: w.ownerToken });
        if (!s.ok) throw new Error(`preload failed ${JSON.stringify(s)}`);
        acknowledged.walkIn.push(s.orderId!);
      }
      for (const [i, c] of w.customers.entries()) {
        const s = await w.sale({
          co: w.a,
          branch: w.a.branches[i % 3]!,
          token: w.ownerToken,
          customerId: c,
          credit: true,
        });
        if (!s.ok) throw new Error(`preload credit failed ${JSON.stringify(s)}`);
        acknowledged.credit.push(s.orderId!);
      }
      const rc = await w.receipt({
        co: w.a,
        branch: w.a.branches[0]!,
        token: w.ownerToken,
        customerId: w.customers[0]!,
        amountMinor: 5000n,
      });
      if (rc.status !== 201) throw new Error(`preload receipt failed ${rc.status}`);
      acknowledged.receipts++;
    }, 900_000);

    afterAll(async () => {
      stopWriters = true;
      writeMetrics('mixed-load.json', metrics);
      await admin?.end();
      await w?.h.close();
      await w?.pool.end();
      await redis?.stop();
      await pgc?.stop();
    });

    // ── writers: the real sale workflow over HTTP ──────────────────────────────────────────────
    const writeLat: number[] = [];
    const noteErr = (code: string): void =>
      void writerErrors.set(code, (writerErrors.get(code) ?? 0) + 1);

    async function oneSale(i: number): Promise<void> {
      const branch = w.a.branches[i % 3]!;
      const credit = i % 4 === 3;
      const customerId = credit ? w.customers[i % w.customers.length]! : undefined;
      const run = `mx-${i}-${randomUUID().slice(0, 8)}`;
      const t0 = performance.now();
      const body = {
        ...(customerId ? { customerId } : {}),
        lines: [
          {
            productId: w.productId,
            variantId: w.variantId,
            selectedUomCode: 'piece',
            quantity: '2',
          },
        ],
      };
      const created = await w.req(
        'POST',
        `/companies/${w.a.companyId}/branches/${branch}/orders`,
        w.ownerToken,
        body,
        { 'idempotency-key': `${run}-c` },
      );
      if (created.status >= 500) fiveXxSeen.push(`create ${created.status}`);
      if (created.status !== 201)
        return noteErr(
          `create:${created.status}:${(created.body as { error?: { code?: string } })?.error?.code ?? ''}`,
        );
      const order = (created.body as { order: { id: string; version: number } }).order;
      const total = w.unitPrice * 2n;
      const payload = credit
        ? { paymentIntent: 'ON_CREDIT' }
        : {
            paymentIntent: 'PAY_NOW',
            tenders: [{ method: 'CASH', amountMinor: total.toString() }],
          };
      const headers = { 'if-match': String(order.version), 'idempotency-key': `${run}-s` };
      const done = await w.req(
        'POST',
        `/companies/${w.a.companyId}/branches/${branch}/orders/${order.id}/complete-sale`,
        w.ownerToken,
        payload,
        headers,
      );
      writeLat.push(performance.now() - t0);
      if (done.status >= 500) fiveXxSeen.push(`complete ${done.status}`);
      if (done.status !== 200)
        return noteErr(
          `complete:${done.status}:${(done.body as { error?: { code?: string } })?.error?.code ?? ''}`,
        );
      (credit ? acknowledged.credit : acknowledged.walkIn).push(order.id);
      // every 7th sale: an intentional retry with the SAME keys — it must replay, never create or post again
      if (i % 7 === 0) {
        replay.attempted++;
        const c2 = await w.req(
          'POST',
          `/companies/${w.a.companyId}/branches/${branch}/orders`,
          w.ownerToken,
          body,
          { 'idempotency-key': `${run}-c` },
        );
        const d2 = await w.req(
          'POST',
          `/companies/${w.a.companyId}/branches/${branch}/orders/${order.id}/complete-sale`,
          w.ownerToken,
          payload,
          headers,
        );
        const sameOrder =
          c2.status === 201 && (c2.body as { order?: { id?: string } })?.order?.id === order.id;
        const sameSale = d2.status === 200 && digest(d2.body) === digest(done.body);
        if (sameOrder && sameSale) replay.identical++;
        else replay.mismatched++;
      }
    }
    const startWriters = (n: number): Promise<void>[] =>
      Array.from({ length: n }, async () => {
        while (!stopWriters) await oneSale(writerSeq++);
      });

    // ── readers ───────────────────────────────────────────────────────────────────────────────
    interface ReadOutcome {
      res: HttpResult;
      slug: string;
      consistent: boolean;
    }
    const sumBig = (xs: unknown[], key: string): bigint =>
      xs.reduce<bigint>((s, x) => s + BigInt((x as Record<string, string>)[key] ?? '0'), 0n);
    /** the response is internally consistent: the frozen snapshot — control totals equal, no failed reconciliation flag */
    function consistent(slug: string, res: HttpResult): boolean {
      if (res.status !== 200) return false;
      const text = JSON.stringify(res.body);
      if (/"reconciled":false/.test(text)) return false;
      if (slug === 'trial-balance') {
        const accounts = (res.body as { accounts: unknown[] }).accounts;
        return (
          sumBig(accounts, 'openingDebitMinor') === sumBig(accounts, 'openingCreditMinor') &&
          sumBig(accounts, 'periodDebitMinor') === sumBig(accounts, 'periodCreditMinor') &&
          sumBig(accounts, 'closingDebitMinor') === sumBig(accounts, 'closingCreditMinor')
        );
      }
      return true;
    }
    async function readOnce(i: number): Promise<ReadOutcome> {
      const r = READS[i % READS.length]!;
      const res = await w.req(
        'GET',
        `/companies/${w.a.companyId}/reports/${r.slug}${r.query ? `?${r.query}` : ''}`,
        w.ownerToken,
      );
      if (res.status >= 500) fiveXxSeen.push(`read ${r.slug} ${res.status}`);
      return { res, slug: r.slug, consistent: consistent(r.slug, res) };
    }

    interface PhaseRow {
      level: number | null;
      seconds: number;
      reads: Record<string, unknown> | null;
      perReport: Record<string, { n: number; p50: number; p95: number; max: number }>;
      writes: {
        ok: number;
        failed: number;
        perSecond: number;
        latencyMs: { p50: number; p95: number; p99: number; max: number };
      } | null;
      resources: MonitorSummary;
    }

    async function runWindow(o: {
      seconds: number;
      readers: number;
      writers: boolean;
    }): Promise<PhaseRow> {
      const ping = () => w.h.db.appClient().$queryRawUnsafe('SELECT 1');
      const monitor = new Monitor({ admin, container: pgc.name, ping });
      const stats = new LevelStats();
      const per = new Map<string, number[]>();
      let incons = 0;
      const lat0 = writeLat.length;
      const okBefore = acknowledged.walkIn.length + acknowledged.credit.length;
      const errBefore = [...writerErrors.values()].reduce((a, b) => a + b, 0);
      const end = performance.now() + o.seconds * 1000;
      stopWriters = !o.writers;
      monitor.start();
      const writers = o.writers ? startWriters(WRITERS) : [];
      const readers = Array.from({ length: o.readers }, async (_x, k) => {
        let i = k;
        while (performance.now() < end && !monitor.tripped) {
          const out = await readOnce(i++);
          stats.add(
            out.res.status,
            out.res.ms,
            out.res.status >= 400
              ? (out.res.body as { error?: { code?: string } })?.error?.code
              : undefined,
          );
          (per.get(out.slug) ?? per.set(out.slug, []).get(out.slug)!).push(out.res.ms);
          if (!out.consistent) {
            incons++;
            stats.wrong++;
          }
        }
      });
      if (o.writers) {
        while (performance.now() < end && !monitor.tripped)
          await new Promise((r) => setTimeout(r, 200));
        stopWriters = true;
      }
      await Promise.all([...readers, ...writers]);
      const resources = await monitor.stop();
      const wl = writeLat.slice(lat0);
      const okNow = acknowledged.walkIn.length + acknowledged.credit.length - okBefore;
      const errNow = [...writerErrors.values()].reduce((a, b) => a + b, 0) - errBefore;
      void incons;
      return {
        level: o.readers || null,
        seconds: o.seconds,
        reads: o.readers ? stats.summary() : null,
        perReport: Object.fromEntries(
          [...per].map(([k, v]) => [
            k,
            { n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: max(v) },
          ]),
        ),
        writes: o.writers
          ? {
              ok: okNow,
              failed: errNow,
              perSecond: Number((okNow / o.seconds).toFixed(2)),
              latencyMs: { p50: pct(wl, 50), p95: pct(wl, 95), p99: pct(wl, 99), max: max(wl) },
            }
          : null,
        resources,
      };
    }

    // ── ledger invariants (SQL on the authoritative rows) ──────────────────────────────────────
    async function invariants(label: string): Promise<Record<string, unknown>> {
      const co = w.a.companyId;
      const one = async (sql: string, p: unknown[] = [co]): Promise<number> =>
        ((await admin.query(sql, p)).rows[0] as { n: number }).n;
      const unbalanced = await one(
        `SELECT count(*)::int n FROM (SELECT "journalEntryId" FROM journal_line WHERE "companyId" = $1 GROUP BY 1 HAVING sum("debitMinor") <> sum("creditMinor")) x`,
      );
      const duplicatePostings = await one(
        `SELECT count(*)::int n FROM (SELECT "sourceKind","sourceId" FROM journal_entry WHERE "companyId" = $1 GROUP BY 1,2 HAVING count(*) > 1) x`,
      );
      const allOrders = [...acknowledged.walkIn, ...acknowledged.credit];
      const invoices = await one(
        `SELECT count(*)::int n FROM invoice WHERE "companyId" = $1 AND "orderId" = ANY($2::uuid[])`,
        [co, allOrders],
      );
      const duplicateInvoices = await one(
        `SELECT count(*)::int n FROM (SELECT "orderId" FROM invoice WHERE "companyId" = $1 GROUP BY 1 HAVING count(*) > 1) x`,
      );
      const tbl = (
        await admin.query(
          `SELECT coalesce(sum("debitMinor"),0)::text d, coalesce(sum("creditMinor"),0)::text c FROM journal_line WHERE "companyId" = $1`,
          [co],
        )
      ).rows[0] as { d: string; c: string };
      const nonSealed = await one(
        `SELECT count(*)::int n FROM journal_entry WHERE "companyId" = $1 AND "sealedAt" IS NULL`,
      );
      const out = {
        label,
        acknowledgedSales: allOrders.length,
        invoicesForAcknowledgedSales: invoices,
        lostCommittedWrites: allOrders.length - invoices,
        duplicateInvoices,
        unbalancedJournals: unbalanced,
        duplicateJournalPostings: duplicatePostings,
        unsealedJournals: nonSealed,
        ledgerDebits: tbl.d,
        ledgerCredits: tbl.c,
      };
      expect(unbalanced, `${label}: unbalanced journals`).toBe(0);
      expect(duplicatePostings, `${label}: duplicate journal postings`).toBe(0);
      expect(duplicateInvoices, `${label}: duplicate invoices`).toBe(0);
      expect(invoices, `${label}: lost committed writes`).toBe(allOrders.length);
      expect(tbl.d, `${label}: ledger debits = credits`).toBe(tbl.c);
      expect(nonSealed).toBe(0);
      return out;
    }

    const phases: Record<string, PhaseRow[]> = {};
    const inv: Record<string, unknown>[] = [];
    const dl0Holder = { v: 0, shm: 0 };

    it('PHASE 1 — writes only: the real sale workflow, two writers; every acknowledged sale is committed exactly once', async () => {
      dl0Holder.v = await deadlocks(admin);
      dl0Holder.shm = await pgShmErrors(pgc.name);
      const row = await runWindow({ seconds: PHASE_S, readers: 0, writers: true });
      phases['writesOnly'] = [row];
      expect(row.writes!.ok).toBeGreaterThan(0);
      expect(fiveXxSeen, 'server errors').toEqual([]);
      expect(row.resources.tripped).toBeNull();
      inv.push(await invariants('after phase 1'));
    }, 1_800_000);

    it('PHASE 2 — reads only at 1 / 2 / 5 / 10 readers (Trial Balance · Sales · Tender Totals · Receivables)', async () => {
      const per = Math.max(2, Math.floor(PHASE_S / LEVELS.length));
      phases['readsOnly'] = [];
      for (const level of LEVELS) {
        const row = await runWindow({ seconds: per, readers: level, writers: false });
        phases['readsOnly']!.push(row);
        const r = row.reads as { fiveXx: number; wrongFigures: number };
        expect(r.fiveXx, `5xx at c=${level}`).toBe(0);
        expect(r.wrongFigures, `inconsistent report at c=${level}`).toBe(0);
        expect(row.resources.tripped).toBeNull();
      }
    }, 1_800_000);

    it('PHASE 3 — mixed: the same readers while the two writers run; every report stays internally consistent, no server error, no deadlock, no lost or duplicated write', async () => {
      const per = Math.max(2, Math.floor(PHASE_S / LEVELS.length));
      phases['mixed'] = [];
      for (const level of LEVELS) {
        const row = await runWindow({ seconds: per, readers: level, writers: true });
        phases['mixed']!.push(row);
        const r = row.reads as { fiveXx: number; wrongFigures: number };
        expect(r.fiveXx, `5xx at c=${level}`).toBe(0);
        expect(r.wrongFigures, `inconsistent report at c=${level}`).toBe(0);
        expect(row.resources.tripped).toBeNull();
        inv.push(await invariants(`after mixed c=${level}`));
      }
      expect(fiveXxSeen, 'server errors').toEqual([]);
      expect(replay.mismatched, 'a replayed Idempotency-Key must return the stored result').toBe(0);
    }, 1_800_000);

    it('FINAL — after the writers stop: a sequential read of every report reconciles with the source rows and the sealed journals', async () => {
      stopWriters = true;
      await new Promise((r) => setTimeout(r, 2000));
      const co = w.a.companyId;
      const sql = async (s: string, p: unknown[] = [co]) =>
        (await admin.query(s, p)).rows[0] as Record<string, string>;
      // Sales ↔ invoices
      const sales = await w.req('GET', `/companies/${co}/reports/sales?${Q}`, w.ownerToken);
      expect(sales.status).toBe(200);
      const invs = await sql(
        `SELECT count(*)::text n, coalesce(sum("totalAmountMinor"),0)::text t FROM invoice WHERE "companyId" = $1`,
      );
      const sInv = (
        sales.body as { invoices: { invoiceCount: number; invoicedTotalMinor: string } }
      ).invoices;
      expect(String(sInv.invoiceCount)).toBe(invs['n']);
      expect(sInv.invoicedTotalMinor).toBe(invs['t']);
      // Trial Balance ↔ ledger
      const tb = await w.req('GET', `/companies/${co}/reports/trial-balance?${Q}`, w.ownerToken);
      expect(tb.status).toBe(200);
      expect(consistent('trial-balance', tb)).toBe(true);
      // each account's closing balance (debit side minus credit side) equals the net of its sealed journal lines
      const net = new Map(
        (
          await admin.query(
            `SELECT l."accountId" AS id, (sum(l."debitMinor") - sum(l."creditMinor"))::text AS n
               FROM journal_line l JOIN journal_entry e ON e.id = l."journalEntryId"
              WHERE l."companyId" = $1 AND e."sealedAt" IS NOT NULL GROUP BY 1`,
            [co],
          )
        ).rows.map((r) => [r.id as string, r.n as string]),
      );
      const accounts = (tb.body as { accounts: Record<string, string>[] }).accounts;
      for (const a of accounts) {
        const closing = BigInt(a['closingDebitMinor']!) - BigInt(a['closingCreditMinor']!);
        expect(closing.toString(), `account ${a['accountKey']}`).toBe(
          net.get(a['accountId']!) ?? '0',
        );
      }
      expect(net.size).toBeGreaterThan(0);
      // Tender Totals ↔ payments
      const tender = await w.req(
        'GET',
        `/companies/${co}/reports/tender-totals?${Q}`,
        w.ownerToken,
      );
      expect(tender.status).toBe(200);
      const pays = await sql(
        `SELECT count(*)::text n, coalesce(sum("amountMinor"),0)::text t FROM payment WHERE "companyId" = $1`,
      );
      const rec = (tender.body as { receipts: { receiptCount: number; receiptTotalMinor: string } })
        .receipts;
      expect(String(rec.receiptCount)).toBe(pays['n']);
      expect(rec.receiptTotalMinor).toBe(pays['t']);
      // Receivables and Customer Liabilities: their own frozen GL controls must reconcile
      for (const slug of ['receivables', 'customer-liabilities']) {
        const r = await w.req('GET', `/companies/${co}/reports/${slug}`, w.ownerToken);
        expect(r.status, slug).toBe(200);
        expect(/"reconciled":false/.test(JSON.stringify(r.body)), `${slug} reconciliation`).toBe(
          false,
        );
      }
      inv.push(await invariants('final'));
      const dl = (await deadlocks(admin)) - dl0Holder.v;
      const shm = (await pgShmErrors(pgc.name)) - dl0Holder.shm;
      metrics['phases'] = phases;
      metrics['invariants'] = inv;
      metrics['idempotencyReplays'] = replay;
      metrics['writerErrors'] = Object.fromEntries(writerErrors);
      metrics['acknowledged'] = {
        walkInSales: acknowledged.walkIn.length,
        creditSales: acknowledged.credit.length,
        receipts: acknowledged.receipts,
      };
      metrics['deadlocks'] = dl;
      metrics['pg53100'] = shm;
      const wo = phases['writesOnly']![0]!.writes!;
      const mixedW = phases['mixed']!.map((p) => p.writes!);
      metrics['writeComparison'] = {
        writesOnly: wo,
        mixedByReaderLevel: mixedW.map((x, i) => ({
          readers: LEVELS[i],
          ...x,
          p95VsWritesOnly: Number((x.latencyMs.p95 / wo.latencyMs.p95).toFixed(2)),
        })),
      };
      expect(dl).toBe(0);
      expect(shm).toBe(0);
      expect(fiveXxSeen).toEqual([]);
      expect(
        [...writerErrors.values()].reduce((a, b) => a + b, 0),
        `writer errors ${JSON.stringify([...writerErrors])}`,
      ).toBe(0);
    }, 600_000);
  },
);
