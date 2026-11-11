import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import {
  createSaleWorld,
  mintTenantToken,
  rolePerms,
  type Co,
  type SaleWorld,
} from '../../verification/load-sale-world.js';
import { SystemClock } from '../../common/clock/clock.js';
import { AnonymousCreditNoteSummaryRepository } from './anonymous-credit-note-summary.repository.js';
import type { AnonymousCreditNoteSummary as S } from './anonymous-credit-note-summary.js';

/**
 * Phase 3B closure — F-1 / F-2: the anonymous credit-note SUMMARY, end to end through the public HTTP routes (full application, real guards,
 * real role grants) on real PostgreSQL. Expectations come from the SALES' OWN invoices and from the general ledger (trial balance), never from
 * the summary's own code. Money world: 5 % STANDARD VAT, AED 33.33 per piece.
 */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v as Json;
const str = (v: unknown): string => String(v);
const UNIT = 3333n;

describe('anonymous credit-note summary — F-1 / F-2 (real PostgreSQL, full HTTP stack)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let admin: pg.Pool;
  let co: Co;
  let b0 = '';
  let b1 = '';
  let manager = '';
  let cashier = '';
  let viewOnly = '';
  let b1Only = '';
  let counter = 0;
  let D = ''; // the civil posting date of this world's sales
  const key = (p: string): string => `${p}-${++counter}-${randomUUID().slice(0, 8)}`;
  const rows = async <T extends Json = Json>(sql: string, p: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, p)).rows as T[];
  const day = (d: number): string =>
    new Date(Date.parse(D) + d * 86_400_000).toISOString().slice(0, 10);
  const big = (v: string): bigint => BigInt(v);

  interface Sale {
    invoiceId: string;
    orderId: string;
    lineIds: string[];
    tax: bigint;
    total: bigint;
    branch: string;
  }
  async function sell(o: {
    branch: string;
    qty: number;
    split?: (t: bigint) => { method: string; amountMinor: bigint }[];
  }): Promise<Sale> {
    const base = `/companies/${co.companyId}/branches/${o.branch}`;
    const created = await w.req(
      'POST',
      `${base}/orders`,
      w.ownerToken,
      {
        lines: [
          {
            productId: w.productId,
            variantId: w.variantId,
            selectedUomCode: 'piece',
            quantity: String(o.qty),
          },
        ],
      },
      { 'idempotency-key': key('order') },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = obj(obj(created.body)['order']) as { id: string; version: number };
    const prev = await w.req('GET', `${base}/orders/${order.id}/totals`, w.ownerToken);
    const total = BigInt(str(obj(prev.body)['totalAmountMinor']));
    const tenders = (o.split ?? ((t) => [{ method: 'CASH', amountMinor: t }]))(total);
    const done = await w.req(
      'POST',
      `${base}/orders/${order.id}/complete-sale`,
      w.ownerToken,
      {
        paymentIntent: 'PAY_NOW',
        tenders: tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor.toString() })),
      },
      { 'if-match': String(order.version), 'idempotency-key': key('sale') },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const inv = obj(obj(done.body)['invoice']);
    const lineIds = (
      await rows<{ id: string }>(
        `SELECT id FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"`,
        [order.id],
      )
    ).map((r) => r.id);
    return {
      invoiceId: str(inv['id']),
      orderId: order.id,
      lineIds,
      tax: BigInt(str(inv['taxTotalAmountMinor'])),
      total: BigInt(str(inv['totalAmountMinor'])),
      branch: o.branch,
    };
  }
  const noteBase = (s: Sale): string => `/companies/${co.companyId}/branches/${s.branch}`;
  async function issue(s: Sale, qty: number, refunds: { method: string; amountMinor: bigint }[]) {
    const r = await w.req(
      'POST',
      `${noteBase(s)}/invoices/${s.invoiceId}/anonymous-credit-notes`,
      manager,
      {
        reasonCode: 'CUSTOMER_REQUEST',
        lines: s.lineIds.map((id) => ({ orderLineId: id, quantity: String(qty) })),
        refunds: refunds.map((x) => ({ method: x.method, amountMinor: x.amountMinor.toString() })),
      },
      { 'idempotency-key': key('cn') },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return obj(r.body);
  }
  const act = (s: Sale, noteId: string, refundId: string, a: 'execute' | 'fail', body: Json = {}) =>
    w.req(
      'POST',
      `${noteBase(s)}/anonymous-credit-notes/${noteId}/refunds/${refundId}/${a}`,
      manager,
      body,
      {
        'idempotency-key': key(a),
      },
    );
  const refundOf = (note: Json, method: string): Json =>
    (note['refunds'] as Json[]).find((r) => r['method'] === method)!;

  /** the summary of a branch (or the company) for [from, to] */
  async function sum(branch: string | null, from = D, to = D, token = w.ownerToken): Promise<S> {
    const url =
      branch === null
        ? `/companies/${co.companyId}/anonymous-credit-note-summary?from=${from}&to=${to}`
        : `/companies/${co.companyId}/branches/${branch}/anonymous-credit-note-summary?from=${from}&to=${to}`;
    const r = await w.req('GET', url, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as S;
  }
  const d = (after: string, before: string): bigint => big(after) - big(before);

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    admin = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 3);
    co = w.a;
    [b0, b1] = [co.branches[0]!, co.branches[1]!];
    expect(b1).toBeTruthy();

    await admin.query(`
      INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STANDARD','Standard','x') ON CONFLICT (key) DO NOTHING;
      INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom") VALUES ('AE','STANDARD',500,'2020-01-01');`);
    const prod = await w.req('GET', `/catalog/products/${w.productId}`, w.ownerToken);
    const setTax = await w.req(
      'PUT',
      `/catalog/products/${w.productId}/tax-category`,
      w.ownerToken,
      { taxCategoryKey: 'STANDARD' },
      { 'if-match': `"${str(obj(prod.body)['version'])}"` },
    );
    expect(setTax.status, JSON.stringify(setTax.body)).toBe(200);
    const cur = await w.req(
      'GET',
      `/catalog/companies/${co.companyId}/variants/${w.variantId}/prices`,
      w.ownerToken,
    );
    const put = await w.req(
      'PUT',
      `/catalog/companies/${co.companyId}/variants/${w.variantId}/prices`,
      w.ownerToken,
      {
        prices: [
          {
            uomCode: 'piece',
            sell: { amountMinor: UNIT.toString(), currency: 'AED', exponent: 2 },
          },
        ],
      },
      { 'if-match': `"${str(obj(cur.body)['version'])}"` },
    );
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    manager = await mintTenantToken(w.h, co.tenantId, rolePerms('manager'), { stepUp: true });
    cashier = await mintTenantToken(w.h, co.tenantId, rolePerms('cashier'), { stepUp: true });
    viewOnly = await mintTenantToken(
      w.h,
      co.tenantId,
      [...rolePerms('cashier'), 'credit_notes:view'],
      { stepUp: true },
    );
    b1Only = await mintTenantToken(w.h, co.tenantId, rolePerms('manager'), {
      stepUp: true,
      branchScope: [b1],
    });

    // the world's posting date, from a first (uncredited) sale
    const first = await sell({ branch: b0, qty: 1 });
    D = str(
      (
        await rows(
          `SELECT to_char("postingDate",'YYYY-MM-DD') AS d FROM journal_entry WHERE "sourceId" = $1`,
          [first.invoiceId],
        )
      )[0]!['d'],
    );
  }, 600_000);

  afterAll(async () => {
    await w?.h.app.close();
    await w?.pool?.end();
    await admin?.end();
    await stack?.stop();
  });

  // ═══════════════════════════ full refund ═══════════════════════════
  it("FULL cash refund: pending → executed; every figure moves exactly by the sale's own invoice (VAT included), the ledger reconciles at each step", async () => {
    const before = await sum(b0);
    const s = await sell({ branch: b0, qty: 2 });
    const note = await issue(s, 2, [{ method: 'CASH', amountMinor: s.total }]);
    const mid = await sum(b0);
    expect(mid.creditNotes.count - before.creditNotes.count).toBe(1);
    expect(d(mid.creditNotes.creditedTotalMinor, before.creditNotes.creditedTotalMinor)).toBe(
      s.total,
    );
    expect(d(mid.creditNotes.creditedTaxMinor, before.creditNotes.creditedTaxMinor)).toBe(s.tax);
    expect(d(mid.creditNotes.creditedNetExTaxMinor, before.creditNotes.creditedNetExTaxMinor)).toBe(
      s.total - s.tax,
    );
    expect(s.tax).toBeGreaterThan(0n); // the VAT is real, not a zero that passes by accident
    expect(
      mid.refundsOfNotesIssuedInPeriod.issued.count -
        before.refundsOfNotesIssuedInPeriod.issued.count,
    ).toBe(1);
    expect(
      mid.refundsOfNotesIssuedInPeriod.pending.count -
        before.refundsOfNotesIssuedInPeriod.pending.count,
    ).toBe(1);
    expect(mid.refundsExecutedInPeriod.totalMinor).toBe(before.refundsExecutedInPeriod.totalMinor); // nothing executed yet
    expect(mid.reconciliation.reconciled, JSON.stringify(mid.reconciliation)).toBe(true);

    const ex = await act(s, str(note['id']), str(refundOf(note, 'CASH')['id']), 'execute');
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    const after = await sum(b0);
    expect(after.refundsOfNotesIssuedInPeriod.pending.count).toBe(
      before.refundsOfNotesIssuedInPeriod.pending.count,
    );
    expect(
      after.refundsOfNotesIssuedInPeriod.executed.count -
        before.refundsOfNotesIssuedInPeriod.executed.count,
    ).toBe(1);
    expect(
      d(after.refundsExecutedInPeriod.totalMinor, before.refundsExecutedInPeriod.totalMinor),
    ).toBe(s.total);
    const cash = (x: S) =>
      x.adjustmentsToFrozenReports.tender.byMethod.find((m) => m.method === 'CASH')!;
    expect(d(cash(after).executedRefundsMinor, cash(before).executedRefundsMinor)).toBe(s.total);
    expect(after.reconciliation.reconciled, JSON.stringify(after.reconciliation)).toBe(true);
    expect(after.reconciliation.paymentClearingAtPeriodEnd.reconciled).toBe(true);
    // money is exact decimal text, the currency and exponent are the company's
    expect(after.currencyCode).toBe('AED');
    expect(after.currencyExponent).toBe(2);
    for (const v of [
      after.creditNotes.creditedTotalMinor,
      after.refundsExecutedInPeriod.totalMinor,
    ])
      expect(v).toMatch(/^-?\d+$/);
  });

  // ═══════════════════════════ partial refunds, VAT exact, failed, pending ═══════════════════════════
  it('PARTIAL refunds 1 + 1 + final 1 of 3: the credited total AND the VAT sum EXACTLY to the invoice; executed / pending / failed are told apart and the unallocated credit is exact', async () => {
    const before = await sum(b0);
    const s = await sell({ branch: b0, qty: 3 });
    // the oracle is the FROZEN floor rule, computed here from the sale's own line (price × quantity, no discount) and its invoice tax:
    // a partial credit takes floor(component × qC / qO) of the gross and of the tax; the credit that exhausts the line takes the exact
    // remainder. (The API refuses a refund total that is not the credit total, so a wrong oracle would fail loudly at issue.)
    const gross = UNIT * 3n;
    const partial = gross / 3n + s.tax / 3n; // 1 of 3, floored component by component
    const t1 = partial;
    const t2 = partial;
    const t3 = s.total - t1 - t2; // the final credit: exact remainder of gross and of tax
    expect(gross + s.tax).toBe(s.total); // tax-exclusive pricing
    const n1 = await issue(s, 1, [{ method: 'CASH', amountMinor: t1 }]);
    const n2 = await issue(s, 1, [{ method: 'CASH', amountMinor: t2 }]);
    const n3 = await issue(s, 1, [{ method: 'CASH', amountMinor: t3 }]);
    expect(
      BigInt(str(n1['totalAmountMinor'])) +
        BigInt(str(n2['totalAmountMinor'])) +
        BigInt(str(n3['totalAmountMinor'])),
    ).toBe(s.total);

    // first executed, second left PENDING, third FAILED (and not replaced)
    expect((await act(s, str(n1['id']), str(refundOf(n1, 'CASH')['id']), 'execute')).status).toBe(
      200,
    );
    expect(
      (
        await act(s, str(n3['id']), str(refundOf(n3, 'CASH')['id']), 'fail', {
          reasonCode: 'CASH_UNAVAILABLE',
        })
      ).status,
    ).toBe(200);

    const after = await sum(b0);
    expect(after.creditNotes.count - before.creditNotes.count).toBe(3);
    // VAT and total: exactly the invoice, no dust, nothing over-credited
    expect(d(after.creditNotes.creditedTotalMinor, before.creditNotes.creditedTotalMinor)).toBe(
      s.total,
    );
    expect(d(after.creditNotes.creditedTaxMinor, before.creditNotes.creditedTaxMinor)).toBe(s.tax);
    const r = (x: S) => x.refundsOfNotesIssuedInPeriod;
    expect(r(after).issued.count - r(before).issued.count).toBe(3);
    expect(r(after).executed.count - r(before).executed.count).toBe(1);
    expect(r(after).pending.count - r(before).pending.count).toBe(1);
    expect(r(after).failed.count - r(before).failed.count).toBe(1);
    expect(d(r(after).executed.totalMinor, r(before).executed.totalMinor)).toBe(t1);
    expect(d(r(after).pending.totalMinor, r(before).pending.totalMinor)).toBe(t2);
    expect(d(r(after).failed.totalMinor, r(before).failed.totalMinor)).toBe(t3);
    // the credit still owed = exactly the failed, unreplaced line
    expect(d(r(after).unallocatedMinor, r(before).unallocatedMinor)).toBe(t3);
    // only the executed line is a cash-out of the period
    expect(
      d(after.refundsExecutedInPeriod.totalMinor, before.refundsExecutedInPeriod.totalMinor),
    ).toBe(t1);
    // the pending line shows in the ageing of today
    const age0 = (x: S) => x.pendingRefunds.ageingNow.find((b) => b.bucket === '0-1 days')!;
    expect(age0(after).count - age0(before).count).toBe(1);
    expect(d(age0(after).totalMinor, age0(before).totalMinor)).toBe(t2);
    expect(after.reconciliation.reconciled, JSON.stringify(after.reconciliation)).toBe(true);
  });

  // ═══════════════════════════ mixed tenders ═══════════════════════════
  it('MIXED tenders (cash + manual card) on branch 1: cash executed, card pending then attested — by-method figures are exact and a manual card posts nothing', async () => {
    const before = await sum(b1);
    const CARD = 1000n;
    const s = await sell({
      branch: b1,
      qty: 3,
      split: (t) => [
        { method: 'CASH', amountMinor: t - CARD },
        { method: 'CARD_TERMINAL', amountMinor: CARD },
      ],
    });
    const note = await issue(s, 3, [
      { method: 'CASH', amountMinor: s.total - CARD },
      { method: 'CARD_TERMINAL', amountMinor: CARD },
    ]);
    expect(
      (await act(s, str(note['id']), str(refundOf(note, 'CASH')['id']), 'execute')).status,
    ).toBe(200);
    const mid = await sum(b1);
    const m = (x: S, method: string) =>
      x.refundsOfNotesIssuedInPeriod.byMethod.find((b) => b.method === method)!;
    expect(m(mid, 'CASH').executed.count - m(before, 'CASH').executed.count).toBe(1);
    expect(m(mid, 'CARD_TERMINAL').pending.count - m(before, 'CARD_TERMINAL').pending.count).toBe(
      1,
    );
    expect(
      d(m(mid, 'CARD_TERMINAL').pending.totalMinor, m(before, 'CARD_TERMINAL').pending.totalMinor),
    ).toBe(CARD);
    expect(
      d(mid.refundsExecutedInPeriod.totalMinor, before.refundsExecutedInPeriod.totalMinor),
    ).toBe(s.total - CARD); // card not yet
    expect(mid.reconciliation.reconciled, JSON.stringify(mid.reconciliation)).toBe(true);

    const journalsBefore = (
      await rows(`SELECT 1 FROM journal_entry WHERE "sourceKind" LIKE 'anonymous_credit_note%'`)
    ).length;
    expect(
      (await act(s, str(note['id']), str(refundOf(note, 'CARD_TERMINAL')['id']), 'execute')).status,
    ).toBe(200);
    expect(
      (await rows(`SELECT 1 FROM journal_entry WHERE "sourceKind" LIKE 'anonymous_credit_note%'`))
        .length,
    ).toBe(journalsBefore); // nothing posted
    const after = await sum(b1);
    // the manual card attestation IS a tender movement of the period (company-timezone civil date), but it is not in the ledger
    expect(
      d(after.refundsExecutedInPeriod.totalMinor, before.refundsExecutedInPeriod.totalMinor),
    ).toBe(s.total);
    const card = (x: S) =>
      x.adjustmentsToFrozenReports.tender.byMethod.find((b) => b.method === 'CARD_TERMINAL')!;
    expect(d(card(after).executedRefundsMinor, card(before).executedRefundsMinor)).toBe(CARD);
    expect(after.reconciliation.reconciled, JSON.stringify(after.reconciliation)).toBe(true);
    expect(after.reconciliation.paymentClearingAtPeriodEnd.reconciled).toBe(true);
  });

  // ═══════════════════════════ reporting windows ═══════════════════════════
  it('WINDOWS: both bounds inclusive; an earlier or later window holds no credit notes of today; the cut-off view counts unresolved refunds up to the end of ANY window', async () => {
    const today = await sum(null);
    expect(today.creditNotes.count).toBeGreaterThan(0);
    for (const [f, t] of [
      [day(-10), day(-1)], // before
      [day(1), day(5)], // after
    ] as const) {
      const x = await sum(null, f, t);
      expect(x.creditNotes.count, `${f}..${t}`).toBe(0);
      expect(x.creditNotes.creditedTotalMinor).toBe('0');
      expect(x.refundsExecutedInPeriod.count).toBe(0);
      expect(x.reconciliation.reconciled, `${f}..${t}: ${JSON.stringify(x.reconciliation)}`).toBe(
        true,
      );
    }
    // a window that ENDS before today: nothing is in flight yet; a window that ends AFTER today: every still-PENDING line is in flight
    const pendingNow = Number(
      (
        await rows(
          `SELECT count(*)::int AS n FROM anonymous_credit_note_refund WHERE status = 'PENDING' AND "companyId" = $1`,
          [co.companyId],
        )
      )[0]!['n'],
    );
    expect(pendingNow).toBeGreaterThan(0);
    expect((await sum(null, day(-10), day(-1))).pendingRefunds.atPeriodEnd.count).toBe(0);
    expect((await sum(null, day(1), day(5))).pendingRefunds.atPeriodEnd.count).toBe(pendingNow);
    expect((await sum(null, D, D)).pendingRefunds.atPeriodEnd.count).toBe(pendingNow);
    // inclusive single-day boundaries: [D, D] holds today, [D+1, D+1] does not
    expect((await sum(null, D, D)).creditNotes.count).toBe(today.creditNotes.count);
    expect((await sum(null, day(1), day(1))).creditNotes.count).toBe(0);
    // the cumulative PAYMENT_CLEARING tie-out holds at the end of every one of these windows
    for (const t of [day(-1), D, day(3)]) {
      const x = await sum(null, day(-1), t);
      expect(x.reconciliation.paymentClearingAtPeriodEnd.reconciled, t).toBe(true);
    }
  });

  // ═══════════════════════════ company vs branch, isolation, authority ═══════════════════════════
  it('SCOPES: the company is exactly the sum of its branches; a branch never sees a sibling; another tenant, a foreign company and a branch-restricted caller are refused without disclosure', async () => {
    const [c, a, b] = [await sum(null), await sum(b0), await sum(b1)];
    expect(a.creditNotes.count).toBeGreaterThan(0);
    expect(b.creditNotes.count).toBeGreaterThan(0);
    expect(c.creditNotes.count).toBe(a.creditNotes.count + b.creditNotes.count);
    for (const f of ['creditedTotalMinor', 'creditedTaxMinor', 'creditedNetExTaxMinor'] as const)
      expect(big(c.creditNotes[f])).toBe(big(a.creditNotes[f]) + big(b.creditNotes[f]));
    expect(big(c.refundsExecutedInPeriod.totalMinor)).toBe(
      big(a.refundsExecutedInPeriod.totalMinor) + big(b.refundsExecutedInPeriod.totalMinor),
    );
    expect(c.scope).toEqual({ level: 'COMPANY', branchId: null });
    expect(a.scope).toEqual({ level: 'BRANCH', branchId: b0 });
    // a branch figure is the branch's own: the oracle is the database
    const oracle = async (branch: string): Promise<bigint> =>
      BigInt(
        str(
          (
            await rows(
              `SELECT COALESCE(sum("totalAmountMinor"),0)::text AS t FROM anonymous_credit_note WHERE "branchId" = $1`,
              [branch],
            )
          )[0]!['t'],
        ),
      );
    expect(big(a.creditNotes.creditedTotalMinor)).toBe(await oracle(b0));
    expect(big(b.creditNotes.creditedTotalMinor)).toBe(await oracle(b1));

    const q = `from=${D}&to=${D}`;
    const get = (url: string, token: string) => w.req('GET', url, token);
    // authority: cashier refused; view-only reads the branch; a branch-restricted caller reads ITS branch but not the company aggregate nor a sibling
    expect(
      (
        await get(
          `/companies/${co.companyId}/branches/${b0}/anonymous-credit-note-summary?${q}`,
          cashier,
        )
      ).status,
    ).toBe(403);
    expect(
      (await get(`/companies/${co.companyId}/anonymous-credit-note-summary?${q}`, cashier)).status,
    ).toBe(403);
    expect(
      (
        await get(
          `/companies/${co.companyId}/branches/${b0}/anonymous-credit-note-summary?${q}`,
          viewOnly,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await get(
          `/companies/${co.companyId}/branches/${b1}/anonymous-credit-note-summary?${q}`,
          b1Only,
        )
      ).status,
    ).toBe(200);
    expect(
      (await get(`/companies/${co.companyId}/anonymous-credit-note-summary?${q}`, b1Only)).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (
        await get(
          `/companies/${co.companyId}/branches/${b0}/anonymous-credit-note-summary?${q}`,
          b1Only,
        )
      ).status,
    ).toBe(404);
    expect(
      (await get(`/companies/${co.companyId}/anonymous-credit-note-summary?${q}`, '')).status,
    ).toBe(401);
    // another tenant and a company-restricted caller: non-disclosing 404
    const foreign = await mintTenantToken(w.h, w.b.tenantId, rolePerms('manager'), {
      stepUp: true,
    });
    expect(
      (await get(`/companies/${co.companyId}/anonymous-credit-note-summary?${q}`, foreign)).status,
    ).toBe(404);
    expect(
      (
        await get(
          `/companies/${co.companyId}/branches/${b0}/anonymous-credit-note-summary?${q}`,
          foreign,
        )
      ).status,
    ).toBe(404);
    const otherCompanyOnly = await mintTenantToken(w.h, co.tenantId, rolePerms('manager'), {
      stepUp: true,
      companyScope: [w.a2.companyId],
    });
    expect(
      (await get(`/companies/${co.companyId}/anonymous-credit-note-summary?${q}`, otherCompanyOnly))
        .status,
    ).toBe(404);
    // the sibling company of the same tenant never sees this company's credits
    const sib = await get(
      `/companies/${w.a2.companyId}/anonymous-credit-note-summary?${q}`,
      w.ownerToken,
    );
    if (sib.status === 200) expect(obj(obj(sib.body)['creditNotes'])['count']).toBe(0);
    else expect([404, 409]).toContain(sib.status);
  });

  // ═══════════════════════════ input contract ═══════════════════════════
  it('INPUT: strict civil dates, a 90-day cap, exact query keys, a density limit — each with its named, non-disclosing error', async () => {
    const url = (qs: string) => `/companies/${co.companyId}/anonymous-credit-note-summary${qs}`;
    const code = async (qs: string): Promise<[number, string]> => {
      const r = await w.req('GET', url(qs), w.ownerToken);
      return [r.status, str(obj(obj(r.body)['error'])['code'])];
    };
    expect(await code('')).toEqual([400, 'INVALID_DATE']);
    expect(await code(`?from=${D}`)).toEqual([400, 'INVALID_DATE']);
    expect(await code(`?from=${D}T00:00:00Z&to=${D}`)).toEqual([400, 'INVALID_DATE']);
    expect(await code(`?from=2026-02-30&to=${D}`)).toEqual([400, 'INVALID_DATE']);
    expect(await code(`?from=${day(1)}&to=${D}`)).toEqual([400, 'INVALID_DATE_RANGE']);
    expect(await code(`?from=${day(-90)}&to=${D}`)).toEqual([400, 'REPORT_RANGE_TOO_LARGE']); // 91 inclusive days
    expect((await w.req('GET', url(`?from=${day(-89)}&to=${D}`), w.ownerToken)).status).toBe(200); // exactly 90 inclusive days
    expect(await code(`?from=${D}&to=${D}&branchId=${b0}`)).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(`?from=${D}&to=${D}&limit=5`)).toEqual([400, 'VALIDATION_FAILED']);
    // density: above the limit the summary is rejected, never truncated
    const repo = w.h.app.get(AnonymousCreditNoteSummaryRepository) as unknown as {
      maxNotes: number;
    };
    const saved = repo.maxNotes;
    repo.maxNotes = 1;
    try {
      const r = await w.req('GET', url(`?from=${D}&to=${D}`), w.ownerToken);
      expect([r.status, str(obj(obj(r.body)['error'])['code'])]).toEqual([
        422,
        'REPORT_RESULT_TOO_LARGE',
      ]);
      expect(JSON.stringify(r.body)).not.toMatch(/\b\d{4,}\b.*credit notes/); // the actual count is not disclosed
    } finally {
      repo.maxNotes = saved;
    }
  });

  // ═══════════════════════════ BEFORE / AFTER against the general ledger ═══════════════════════════
  it('BEFORE / AFTER vs the GENERAL LEDGER: the frozen reports alone disagree with the ledger by exactly the anonymous credits; frozen − adjustments equals the ledger; the frozen figures themselves are unchanged', async () => {
    const q = `from=${D}&to=${D}`;
    const get = async (p: string) => {
      const r = await w.req('GET', `/companies/${co.companyId}${p}`, w.ownerToken);
      expect(r.status, `${p}: ${JSON.stringify(r.body)}`).toBe(200);
      return obj(r.body);
    };
    const [tb, sales, tender, summary] = [
      await get(`/reports/trial-balance?${q}`),
      await get(`/reports/sales?${q}`),
      await get(`/reports/tender-totals?${q}`),
      await sum(null),
    ];
    const gl = (k: string): { net: bigint } => {
      const a = (tb['accounts'] as Json[]).find((x) => x['accountKey'] === k);
      return { net: a ? big(str(a['closingDebitMinor'])) - big(str(a['closingCreditMinor'])) : 0n };
    };
    // GL view (credit-positive for revenue / tax, debit-positive for cash)
    const glRevenue = -gl('REVENUE.SALES').net;
    const glTax = -gl('LIABILITY.TAX_PAYABLE').net;
    const glCash = gl('ASSET.CASH_ON_HAND').net;
    const frozenNet = big(
      str(obj(sales['netSalesAfterCreditNotes'])['netSalesAfterCreditNotesExTaxMinor']),
    );
    const frozenTax = big(
      str(obj(sales['netSalesAfterCreditNotes'])['netSalesAfterCreditNotesTaxMinor']),
    );
    const frozenCash = big(
      str(
        (obj(tender['netTenderMovement'])['byMethod'] as Json[]).find(
          (m) => m['method'] === 'CASH',
        )!['netMovementMinor'],
      ),
    );
    const adj = summary.adjustmentsToFrozenReports;
    const credited = {
      net: big(adj.sales.netSalesExTaxMinor),
      tax: big(adj.sales.outputTaxMinor),
      cash: big(adj.tender.byMethod.find((m) => m.method === 'CASH')!.executedRefundsMinor),
    };
    expect(credited.net).toBeGreaterThan(0n);
    expect(credited.cash).toBeGreaterThan(0n);

    // the frozen figures are the SALES' own — preserved exactly (oracle: the invoices of the company)
    const inv = (
      await rows<{ sub: string; tax: string }>(
        `SELECT COALESCE(sum("totalAmountMinor" - "taxTotalAmountMinor"),0)::text AS sub, COALESCE(sum("taxTotalAmountMinor"),0)::text AS tax FROM invoice WHERE "companyId" = $1`,
        [co.companyId],
      )
    )[0]!;
    expect(frozenNet).toBe(big(inv.sub));
    expect(frozenTax).toBe(big(inv.tax));

    // BEFORE: the frozen reports alone vs the ledger — they disagree by exactly the anonymous credits
    expect(frozenNet - glRevenue).toBe(credited.net);
    expect(frozenTax - glTax).toBe(credited.tax);
    expect(frozenCash - glCash).toBe(credited.cash);
    // AFTER: frozen − the summary's adjustments == the ledger (no double counting, nothing missed)
    expect(frozenNet - credited.net).toBe(glRevenue);
    expect(frozenTax - credited.tax).toBe(glTax);
    expect(frozenCash - credited.cash).toBe(glCash);
    // and the frozen reports' own "reconciled" never claimed otherwise about THEIR sources
    expect(obj(sales['reconciliation'])['reconciled']).toBe(true);
    expect(obj(tender['reconciliation'])['reconciled']).toBe(true);
    // the summary itself reconciles to the ledger
    expect(summary.reconciliation.reconciled, JSON.stringify(summary.reconciliation)).toBe(true);
    // the measured before / after table, written straight to stdout (recorded in the closure evidence); `console` is lint-banned
    process.stdout.write(
      `### GLCMP ${JSON.stringify({
        period: `${D}..${D}`,
        netSalesExTax: {
          frozenReport: frozenNet.toString(),
          glRevenueSales: glRevenue.toString(),
          differenceBefore: (frozenNet - glRevenue).toString(),
          anonymousAdjustment: credited.net.toString(),
          differenceAfter: (frozenNet - credited.net - glRevenue).toString(),
        },
        outputTax: {
          frozenReport: frozenTax.toString(),
          glTaxPayable: glTax.toString(),
          differenceBefore: (frozenTax - glTax).toString(),
          anonymousAdjustment: credited.tax.toString(),
          differenceAfter: (frozenTax - credited.tax - glTax).toString(),
        },
        cashNetMovement: {
          frozenReport: frozenCash.toString(),
          glCashOnHand: glCash.toString(),
          differenceBefore: (frozenCash - glCash).toString(),
          anonymousAdjustment: credited.cash.toString(),
          differenceAfter: (frozenCash - credited.cash - glCash).toString(),
        },
      })}\n`,
    );
  });

  // ═══════════════════════════ other journal kinds never leak in ═══════════════════════════
  it('ISOLATION FROM OTHER JOURNALS: a manual journal of another kind on an account no anonymous journal may touch, on the same day and branch, changes NOTHING in the summary (it reads exactly its two source kinds)', async () => {
    const before = await sum(b0);
    expect(before.reconciliation.ledger.unexpectedAccounts).toEqual([]);
    const je = randomUUID();
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
         VALUES ($1,$2,$3,(SELECT id FROM accounting_period WHERE "companyId" = $3 AND status = 'OPEN' ORDER BY "startDate" DESC LIMIT 1),$4::date,
                 'manual_adjustment',$5,'AED',$6)`,
        [je, co.tenantId, co.companyId, D, randomUUID(), `fp-${je}`],
      );
      for (const [k, dr, cr] of [
        ['EXPENSE.PAYMENT_PROCESSING_FEE', 500, 0],
        ['ASSET.BANK', 0, 500],
      ] as const) {
        await c.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
           VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
          [co.tenantId, co.companyId, je, k, b0, dr, cr],
        );
      }
      await c.query(`UPDATE journal_entry SET "sealedAt" = now() WHERE id = $1`, [je]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const after = await sum(b0);
    expect(after.reconciliation.reconciled, JSON.stringify(after.reconciliation)).toBe(true);
    expect(after.reconciliation.ledger).toEqual(before.reconciliation.ledger);
    expect(after.reconciliation.ledger.unexpectedAccounts).toEqual([]);
    expect(after.reconciliation.integrity).toEqual(before.reconciliation.integrity);
    expect(after.reconciliation.paymentClearingAtPeriodEnd).toEqual(
      before.reconciliation.paymentClearingAtPeriodEnd,
    );
  });

  // ═══════════════════════════ cut-off (F-8): issued in one period, attested in a later one ═══════════════════════════
  it('CUT-OFF: a refund issued on day D and attested on D+2 is IN FLIGHT at the end of D and EXECUTED in the period of D+2 — every lens, and the cumulative clearing tie-out, agree with the ledger on both sides of the boundary', async () => {
    const s = await sell({ branch: b0, qty: 1 });
    const note = await issue(s, 1, [{ method: 'CASH', amountMinor: s.total }]);
    const noteId = str(note['id']);
    const refundId = str(refundOf(note, 'CASH')['id']);
    const atD = await sum(b0, D, D);
    const atD2 = await sum(b0, day(2), day(2));

    // advance the application's accounting clock by two days for the attestation (the same clock object every service uses)
    const clock = w.h.app.get(SystemClock) as unknown as { now: () => Date };
    const real = clock.now;
    clock.now = () => new Date(real().getTime() + 2 * 86_400_000);
    try {
      const ex = await act(s, noteId, refundId, 'execute');
      expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    } finally {
      clock.now = real;
    }
    const execPosting = str(
      (
        await rows(
          `SELECT to_char("postingDate",'YYYY-MM-DD') AS d FROM journal_entry WHERE "sourceKind" = 'anonymous_credit_note_refund' AND "sourceId" = $1`,
          [refundId],
        )
      )[0]!['d'],
    );
    expect(execPosting).toBe(day(2)); // the execution journal belongs to the attestation day, not the sale day

    const endD = await sum(b0, D, D);
    const onD2 = await sum(b0, day(2), day(2));
    // window [D, D]: the note is issued here; the refund is NOT a cash-out of D; it is still unresolved at the END of D
    expect(endD.creditNotes.count - atD.creditNotes.count).toBe(0); // (already counted when issued, before the delta window)
    expect(d(endD.refundsExecutedInPeriod.totalMinor, atD.refundsExecutedInPeriod.totalMinor)).toBe(
      0n,
    );
    expect(endD.pendingRefunds.atPeriodEnd.count - atD.pendingRefunds.atPeriodEnd.count).toBe(0); // unresolved at end of D, before AND after the later attestation
    expect(endD.pendingRefunds.atPeriodEnd.count).toBeGreaterThan(0);
    // …but the COHORT lens (current status of the notes issued in D) now shows it executed
    expect(
      endD.refundsOfNotesIssuedInPeriod.executed.count -
        atD.refundsOfNotesIssuedInPeriod.executed.count,
    ).toBe(1);
    expect(
      endD.refundsOfNotesIssuedInPeriod.pending.count -
        atD.refundsOfNotesIssuedInPeriod.pending.count,
    ).toBe(-1);
    // the ledger of D has the issuance only; the cumulative clearing at the end of D carries the whole in-flight refund — reconciled
    expect(endD.reconciliation.reconciled, JSON.stringify(endD.reconciliation)).toBe(true);
    expect(endD.reconciliation.paymentClearingAtPeriodEnd.reconciled).toBe(true);
    // window [D+2, D+2]: no credit note is issued, the cash-out IS here, nothing of it is in flight at the end of D+2
    expect(onD2.creditNotes.count).toBe(0);
    expect(
      d(onD2.refundsExecutedInPeriod.totalMinor, atD2.refundsExecutedInPeriod.totalMinor),
    ).toBe(s.total);
    expect(onD2.pendingRefunds.atPeriodEnd.count).toBeLessThan(
      endD.pendingRefunds.atPeriodEnd.count,
    );
    expect(onD2.reconciliation.reconciled, JSON.stringify(onD2.reconciliation)).toBe(true);
    expect(onD2.reconciliation.paymentClearingAtPeriodEnd.reconciled).toBe(true);
    // a window that spans both days sees both events once
    const both = await sum(b0, D, day(2));
    expect(both.reconciliation.reconciled, JSON.stringify(both.reconciliation)).toBe(true);
    expect(
      big(both.refundsExecutedInPeriod.totalMinor) - big(endD.refundsExecutedInPeriod.totalMinor),
    ).toBe(s.total);
  });

  // ═══════════════════════════ reconciliation must FAIL when the ledger disagrees (must be LAST) ═══════════════════════════
  it('RECONCILIATION FAILS LOUDLY: an executed cash refund with no journal (a superuser bypass) makes the summary NOT reconciled — only for the affected branch, company and scope', async () => {
    const s = await sell({ branch: b1, qty: 1 });
    const note = await issue(s, 1, [{ method: 'CASH', amountMinor: s.total }]);
    const refundId = str(refundOf(note, 'CASH')['id']);
    expect((await sum(b1)).reconciliation.reconciled).toBe(true);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(
        `UPDATE anonymous_credit_note_refund SET status = 'EXECUTED', "resolvedAt" = now(), "resolvedByUserId" = gen_random_uuid() WHERE id = $1`,
        [refundId],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const bad = await sum(b1);
    expect(bad.reconciliation.reconciled).toBe(false);
    expect(bad.reconciliation.integrity.executedCashBankWithoutJournal).toEqual({
      count: 1,
      totalMinor: s.total.toString(),
    });
    expect((await sum(null)).reconciliation.reconciled).toBe(false); // the company aggregate cannot report success
    expect((await sum(b0)).reconciliation.reconciled).toBe(true); // a sibling branch is not contaminated

    // a PHANTOM execution journal — a balanced, sealed Dr CLEARING / Cr CASH for a refund that does not exist — is detected as an orphan
    // and as a ledger disagreement, in the branch whose lines it touches and nowhere else
    const phantom = randomUUID();
    const je = randomUUID();
    const pc = await admin.connect();
    try {
      await pc.query('BEGIN');
      await pc.query(
        `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
         VALUES ($1,$2,$3,(SELECT id FROM accounting_period WHERE "companyId" = $3 AND status = 'OPEN' ORDER BY "startDate" DESC LIMIT 1),$4::date,
                 'anonymous_credit_note_refund',$5,'AED',$6)`,
        [je, co.tenantId, co.companyId, D, phantom, `fp-${je}`],
      );
      for (const [k, dr, cr] of [
        ['ASSET.PAYMENT_CLEARING', 777, 0],
        ['ASSET.CASH_ON_HAND', 0, 777],
      ] as const) {
        await pc.query(
          `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
           VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
          [co.tenantId, co.companyId, je, k, b0, dr, cr],
        );
      }
      await pc.query(`UPDATE journal_entry SET "sealedAt" = now() WHERE id = $1`, [je]);
      await pc.query('COMMIT');
    } finally {
      pc.release();
    }
    const orphaned = await sum(b0);
    expect(orphaned.reconciliation.reconciled).toBe(false);
    expect(orphaned.reconciliation.integrity.journalsWithoutSource).toBe(1);
    expect(orphaned.reconciliation.ledger.paymentClearingExecution.reconciled).toBe(false); // the ledger moved 777 that no document explains
    expect(orphaned.reconciliation.ledger.paymentClearingExecution.differenceMinor).toBe('-777');
    expect(orphaned.reconciliation.ledger.cashOnHandPaidOut.differenceMinor).toBe('-777');
    expect((await sum(b1)).reconciliation.integrity.journalsWithoutSource).toBe(0);
  });
});
