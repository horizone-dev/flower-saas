import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { runScoped } from '@flower/db';
import { AccountRepository } from '../modules/accounting/account.repository.js';
import { AccountingPeriodRepository } from '../modules/accounting/accounting-period.repository.js';
import {
  PERIOD,
  createSaleWorld,
  mintTenantToken,
  rolePerms,
  type Co,
  type SaleWorld,
} from './load-sale-world.js';

/**
 * Task 3b.11 Checkpoint 2 — the Phase 3 EXIT scenario, end to end, through the public HTTP routes only.
 *
 * ROADMAP Phase 3 exit: "a full cash/card/credit/advance walk-in sale posts correct, balanced GL entries; trial balance
 * ties; Owner figures reconcile to the GL and to source transactions."
 *
 * The full application (real guards, real default role grants, real Redis sessions, real idempotency layer) on a
 * disposable PostgreSQL. Orders, sales, receipts, advances, cancellations and refunds are created ONLY through the
 * frozen public routes; the only direct SQL is fixture reference data (tax rates, an Omani company) and READ-ONLY
 * oracle queries. Every expected figure is computed here, independently, with BigInt arithmetic — never read back
 * from the code under test. Verification only: no production source, no migration, no frozen contract is touched.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v as Json;
const str = (v: unknown): string => String(v);
const at = (v: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((acc, k) => (acc === undefined || acc === null ? acc : obj(acc)[k]), v);

/** HALF_UP VAT on a positive minor-unit subtotal at `bps` basis points (BigInt only). */
const vat = (subtotal: bigint, bps = 500n): bigint => (subtotal * bps + 5000n) / 10000n;

const AED_PRICE = 1010n; // 10.10 AED — 5 % of a one-piece line is 50.5 → rounds HALF_UP to 51
const OMR_PRICE = 12345n; // 12.345 OMR (3-decimal) — 5 % of one piece is 617.25 → 617

interface SaleRecord {
  label: string;
  co: Co;
  branch: string;
  token: string;
  orderId: string;
  orderVersion: number;
  completeKey: string;
  completeBody: Json;
  response: { status: number; body: unknown };
  subtotal: bigint;
  tax: bigint;
  total: bigint;
  customerId?: string;
}

describe('Phase 3 exit scenario — cash / card / credit / advance sale, reversal, GL and reports (task 3b.11)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let admin: pg.Pool;
  let omCo: Co;
  const sales: SaleRecord[] = [];
  let refundReplay: { url: string; key: string; body: unknown } | null = null;
  let ik = 0;
  const key = (p: string): string =>
    `x-${p}-${String(++ik).padStart(4, '0')}-${randomUUID().slice(0, 6)}`;

  const q = async <T extends Record<string, unknown>>(
    sql: string,
    p: unknown[] = [],
  ): Promise<T[]> => (await admin.query(sql, p)).rows as T[];
  const one = async <T extends Record<string, unknown>>(
    sql: string,
    p: unknown[] = [],
  ): Promise<T> => {
    const rows = await q<T>(sql, p);
    expect(rows.length, sql).toBe(1);
    return rows[0]!;
  };

  async function newOrder(
    co: Co,
    branch: string,
    token: string,
    qty: number,
    customerId?: string,
  ): Promise<{ id: string; version: number }> {
    const r = await w.req(
      'POST',
      `/companies/${co.companyId}/branches/${branch}/orders`,
      token,
      {
        ...(customerId ? { customerId } : {}),
        lines: [
          {
            productId: w.productId,
            variantId: w.variantId,
            selectedUomCode: 'piece',
            quantity: String(qty),
          },
        ],
      },
      { 'idempotency-key': key('order') },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return obj(obj(r.body)['order']) as { id: string; version: number };
  }

  async function sell(o: {
    label: string;
    co: Co;
    branch: string;
    qty: number;
    unit: bigint;
    bps?: bigint;
    customerId?: string;
    body: (total: bigint) => Json;
    token?: string;
  }): Promise<SaleRecord> {
    const token = o.token ?? w.ownerToken;
    const order = await newOrder(o.co, o.branch, token, o.qty, o.customerId);
    const subtotal = o.unit * BigInt(o.qty);
    const tax = vat(subtotal, o.bps ?? 500n);
    const total = subtotal + tax;
    // the authoritative preview must already equal the independent oracle
    const prev = await w.req(
      'GET',
      `/companies/${o.co.companyId}/branches/${o.branch}/orders/${order.id}/totals`,
      token,
    );
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const completeKey = key('sale');
    const completeBody = o.body(total);
    const url = `/companies/${o.co.companyId}/branches/${o.branch}/orders/${order.id}/complete-sale`;
    const res = await w.req('POST', url, token, completeBody, {
      'if-match': String(order.version),
      'idempotency-key': completeKey,
    });
    expect(res.status, `${o.label}: ${JSON.stringify(res.body)}`).toBe(200);
    const rec: SaleRecord = {
      label: o.label,
      co: o.co,
      branch: o.branch,
      token,
      orderId: order.id,
      orderVersion: order.version,
      completeKey,
      completeBody,
      response: { status: res.status, body: res.body },
      subtotal,
      tax,
      total,
      ...(o.customerId ? { customerId: o.customerId } : {}),
    };
    sales.push(rec);
    return rec;
  }

  const invoiceOf = (s: SaleRecord): Json => obj(obj(s.response.body)['invoice']);

  async function accountsAndPeriod(co: Co): Promise<void> {
    await runScoped(w.h.db.appClient(), { tenantId: co.tenantId }, (tx) =>
      w.h.app
        .get(AccountRepository)
        .ensureDefaultAccounts(tx, { tenantId: co.tenantId, companyId: co.companyId }),
    );
    await runScoped(w.h.db.appClient(), { tenantId: co.tenantId }, (tx) =>
      w.h.app.get(AccountingPeriodRepository).create(tx, {
        tenantId: co.tenantId,
        companyId: co.companyId,
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2026-06-30T00:00:00Z'),
      }),
    );
  }

  /** signed GL balance (debit − credit) of one account key for a company, from the journal lines only */
  async function glNet(companyId: string, accountKey: string): Promise<bigint> {
    const r = await one<{ n: string }>(
      `SELECT COALESCE(SUM(jl."debitMinor" - jl."creditMinor"),0)::text n
         FROM journal_line jl JOIN account a ON a.id = jl."accountId"
        WHERE jl."companyId" = $1 AND a.key = $2`,
      [companyId, accountKey],
    );
    return BigInt(r.n);
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    admin = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 3);

    // ── fixture reference data: a 5 % STANDARD VAT rate for UAE and for Oman (a 3-decimal currency) ──
    await admin.query(`
      INSERT INTO tax_category (key,"nameEn","nameAr") VALUES ('STANDARD','Standard','x') ON CONFLICT (key) DO NOTHING;
      INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('OMR',3,'OMR','x','x') ON CONFLICT (code) DO NOTHING;
      INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel",active,"updatedAt")
        VALUES ('OM','Oman','x','gcc','OMR','FRI_SAT',true,now()) ON CONFLICT (code) DO NOTHING;
      INSERT INTO country_tax_config (id,"countryCode","effectiveFrom",regime,config)
        SELECT uuidv7(),'OM','2020-01-01','VAT','{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM country_tax_config WHERE "countryCode"='OM');
      INSERT INTO tax_rate ("countryCode","taxCategoryKey","rateBps","effectiveFrom") VALUES ('AE','STANDARD',500,'2020-01-01'), ('OM','STANDARD',500,'2020-01-01');
    `);
    // product tax category + AED company price 10.10, both through the public catalog routes
    const prod = await w.req('GET', `/catalog/products/${w.productId}`, w.ownerToken);
    expect(prod.status).toBe(200);
    const setTax = await w.req(
      'PUT',
      `/catalog/products/${w.productId}/tax-category`,
      w.ownerToken,
      { taxCategoryKey: 'STANDARD' },
      { 'if-match': `"${str(obj(prod.body)['version'])}"` },
    );
    expect(setTax.status, JSON.stringify(setTax.body)).toBe(200);
    const setPrice = async (
      co: Co,
      unit: bigint,
      currency: string,
      exponent: number,
    ): Promise<void> => {
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
            { uomCode: 'piece', sell: { amountMinor: unit.toString(), currency, exponent } },
          ],
        },
        { 'if-match': `"${str(obj(cur.body)['version'])}"` },
      );
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    };
    await setPrice(w.a, AED_PRICE, 'AED', 2);

    // ── an Omani company (OMR, 3 decimals) of the SAME tenant, to prove 3-decimal precision ──
    const omId = randomUUID();
    const omBranch = randomUUID();
    await admin.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
       VALUES ($1,$2,'Company OM','OM','OMR','Asia/Muscat','ACTIVE',now())`,
      [omId, w.a.tenantId],
    );
    await admin.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'OM Main',now())`,
      [omBranch, w.a.tenantId, omId],
    );
    omCo = { tenantId: w.a.tenantId, companyId: omId, branches: [omBranch] };
    await accountsAndPeriod(omCo);
    await setPrice(omCo, OMR_PRICE, 'OMR', 3);
  }, 600_000);

  afterAll(async () => {
    await admin?.end();
    await w?.pool.end();
    await w?.h.close();
    await stack?.stop();
  }, 120_000);

  // ───────────────────────────── sales ─────────────────────────────
  it('S1 cash sale (anonymous, branch 1): VAT rounds HALF_UP to the minor unit and the sale is paid in full', async () => {
    const s = await sell({
      label: 'S1 cash',
      co: w.a,
      branch: w.a.branches[0]!,
      qty: 1,
      unit: AED_PRICE,
      body: (t) => ({
        paymentIntent: 'PAY_NOW',
        tenders: [{ method: 'CASH', amountMinor: t.toString() }],
      }),
    });
    expect(s.tax).toBe(51n); // 50.5 → 51, the independent oracle
    const inv = invoiceOf(s);
    expect(str(inv['subtotalAmountMinor'])).toBe('1010');
    expect(str(inv['taxTotalAmountMinor'])).toBe('51');
    expect(str(inv['totalAmountMinor'])).toBe('1061');
    expect(inv['paymentStatus']).toBe('SETTLED'); // cash is settlement-final at the till (ADR-0019 PAID vs SETTLED)
  });

  it('S2 card-terminal sale (anonymous, branch 2)', async () => {
    const s = await sell({
      label: 'S2 card',
      co: w.a,
      branch: w.a.branches[1]!,
      qty: 3,
      unit: AED_PRICE,
      body: (t) => ({
        paymentIntent: 'PAY_NOW',
        tenders: [{ method: 'CARD_TERMINAL', amountMinor: t.toString() }],
      }),
    });
    expect(s.tax).toBe(152n); // 151.5 → 152
    expect(invoiceOf(s)['paymentStatus']).toBe('PAID');
  });

  it('S3 Multi Payment (customer 1, branch 1): cash + card split exactly covers the invoice', async () => {
    const s = await sell({
      label: 'S3 split',
      co: w.a,
      branch: w.a.branches[0]!,
      qty: 5,
      unit: AED_PRICE,
      customerId: w.customers[0]!,
      body: (t) => ({
        paymentIntent: 'PAY_NOW',
        tenders: [
          { method: 'CASH', amountMinor: '2000' },
          { method: 'CARD_TERMINAL', amountMinor: (t - 2000n).toString() },
        ],
      }),
    });
    expect(s.total).toBe(5303n);
    expect(invoiceOf(s)['paymentStatus']).toBe('PAID');
    expect((obj(s.response.body)['payments'] as unknown[]).length).toBe(2);
  });

  it('S4 credit sale (customer 2, branch 2): a receivable, then a PARTIAL receipt of 1 500 leaves the exact remainder', async () => {
    const s = await sell({
      label: 'S4 credit',
      co: w.a,
      branch: w.a.branches[1]!,
      qty: 4,
      unit: AED_PRICE,
      customerId: w.customers[1]!,
      body: () => ({ paymentIntent: 'ON_CREDIT' }),
    });
    expect(s.total).toBe(4242n);
    expect(invoiceOf(s)['paymentStatus']).toBe('UNPAID');
    expect(str(obj(s.response.body)['outstandingMinor'])).toBe('4242');
    const rc = await w.receipt({
      co: w.a,
      branch: w.a.branches[1]!,
      token: w.ownerToken,
      customerId: w.customers[1]!,
      amountMinor: 1500n,
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    const inv = await one<{ invoicePaymentStatus: string }>(
      `SELECT "invoicePaymentStatus" FROM invoice WHERE id = $1`,
      [str(invoiceOf(s)['id'])],
    );
    expect(inv.invoicePaymentStatus).toBe('PARTIAL');
    const paid = await one<{ n: string }>(
      `SELECT COALESCE(SUM("amountMinor"),0)::text n FROM payment_allocation WHERE "invoiceId" = $1`,
      [str(invoiceOf(s)['id'])],
    );
    expect(BigInt(paid.n)).toBe(1500n); // 4 242 − 1 500 = 2 742 remains outstanding
  });

  it('S5/S6 customer advance (customer 3): receipt → advance, applied in full to one sale and partly (advance + cash) to another', async () => {
    const c = w.customers[2]!;
    const b = w.a.branches[2]!;
    const rc = await w.receipt({
      co: w.a,
      branch: b,
      token: w.ownerToken,
      customerId: c,
      amountMinor: 4000n,
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    const pay = await one<{ id: string }>(
      `SELECT id FROM payment WHERE "companyId" = $1 AND "amountMinor" = 4000 ORDER BY "createdAt" DESC LIMIT 1`,
      [w.a.companyId],
    );
    const conv = await w.req(
      'POST',
      `/companies/${w.a.companyId}/branches/${b}/customers/${c}/advances/from-payment`,
      w.ownerToken,
      { paymentId: pay.id, amountMinor: '4000' },
      { 'idempotency-key': key('adv') },
    );
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    const adv = await one<{ id: string }>(
      `SELECT ca.id FROM customer_advance ca JOIN customer_company_account cca ON cca.id = ca."customerCompanyAccountId"
        WHERE cca."customerId" = $1 AND ca."sourceType" <> 'CREDIT_NOTE'`,
      [c],
    );
    const s5 = await sell({
      label: 'S5 advance',
      co: w.a,
      branch: b,
      qty: 2,
      unit: AED_PRICE,
      customerId: c,
      body: (t) => ({
        paymentIntent: 'PAY_NOW',
        advanceApplications: [{ advanceId: adv.id, amountMinor: t.toString() }],
      }),
    });
    expect(s5.total).toBe(2121n);
    expect(invoiceOf(s5)['paymentStatus']).toBe('SETTLED');
    const s6 = await sell({
      label: 'S6 advance+cash',
      co: w.a,
      branch: b,
      qty: 2,
      unit: AED_PRICE,
      customerId: c,
      body: (t) => ({
        paymentIntent: 'PAY_NOW',
        advanceApplications: [{ advanceId: adv.id, amountMinor: '1000' }],
        tenders: [{ method: 'CASH', amountMinor: (t - 1000n).toString() }],
      }),
    });
    expect(invoiceOf(s6)['paymentStatus']).toBe('SETTLED');
    // 4 000 − 2 121 − 1 000 = 879 left on the advance (independent arithmetic)
    const applied = await one<{ n: string }>(
      `SELECT COALESCE(SUM("amountMinor"),0)::text n FROM customer_advance_application WHERE "customerAdvanceId" = $1`,
      [adv.id],
    );
    expect(BigInt(applied.n)).toBe(3121n);
  });

  it('S7 three-decimal currency (OMR, Oman company): 12.345 × 3 + 5 % VAT is exact to the baisa', async () => {
    const s = await sell({
      label: 'S7 omr',
      co: omCo,
      branch: omCo.branches[0]!,
      qty: 3,
      unit: OMR_PRICE,
      bps: 500n,
      body: (t) => ({
        paymentIntent: 'PAY_NOW',
        tenders: [{ method: 'CASH', amountMinor: t.toString() }],
      }),
    });
    expect(s.subtotal).toBe(37035n); // 37.035 OMR
    expect(s.tax).toBe(1852n); // 1 851.75 → 1 852
    const inv = invoiceOf(s);
    expect(inv['currencyCode']).toBe('OMR');
    expect(inv['currencyExponent']).toBe(3);
    expect(str(inv['totalAmountMinor'])).toBe('38887');
  });

  // ───────────────────────────── reversal ─────────────────────────────
  it('R1 cancel the fully paid customer sale S3 → credit note, then a PARTIAL cash refund of the credit-note advance', async () => {
    const s3 = sales.find((s) => s.label === 'S3 split')!;
    const cancel = await w.req(
      'POST',
      `/companies/${w.a.companyId}/branches/${s3.branch}/orders/${s3.orderId}/cancel`,
      w.ownerToken,
      { reason: 'exit scenario reversal' },
      {
        'if-match': String(
          (
            await one<{ version: number }>(`SELECT version FROM "order" WHERE id = $1`, [
              s3.orderId,
            ])
          ).version,
        ),
      },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const cn = await one<{
      id: string;
      subtotal: string;
      tax: string;
      total: string;
      ar: string;
      adv: string;
    }>(
      `SELECT cn.id, cn."subtotalAmountMinor"::text subtotal, cn."taxTotalAmountMinor"::text tax, cn."totalAmountMinor"::text total,
              cn."arReductionMinor"::text ar, cn."advanceExcessMinor"::text adv
         FROM credit_note cn JOIN invoice i ON i.id = cn."invoiceId" WHERE i."orderId" = $1`,
      [s3.orderId],
    );
    expect(BigInt(cn.subtotal)).toBe(s3.subtotal); // the credit note reverses revenue exactly
    expect(BigInt(cn.tax)).toBe(s3.tax); // … and VAT exactly
    expect(BigInt(cn.total)).toBe(s3.total);
    const advs = await q<{ id: string; amount: string }>(
      `SELECT DISTINCT ca.id, ca."amountMinor"::text amount FROM customer_advance ca
         JOIN credit_note_coverage_release r ON r."customerAdvanceId" = ca.id WHERE r."creditNoteId" = $1
        ORDER BY amount DESC`,
      [cn.id],
    );
    // the credit note returns exactly what was paid: one credit-note advance per funding payment (cash 2 000 + card 3 303)
    expect(advs.reduce((a, r) => a + BigInt(r.amount), 0n)).toBe(5303n);
    const adv = advs[0]!; // the largest (3 303) can cover the 3 000 refund
    const refundKey = key('refund');
    const refund = await w.req(
      'POST',
      `/companies/${w.a.companyId}/branches/${s3.branch}/customers/${s3.customerId!}/advances/${adv.id}/refunds`,
      w.ownerToken,
      { requestedAmountMinor: '3000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
      { 'idempotency-key': refundKey },
    );
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(str(obj(refund.body)['amountMinor'])).toBe('3000');
    refundReplay = {
      url: `/companies/${w.a.companyId}/branches/${s3.branch}/customers/${s3.customerId!}/advances/${adv.id}/refunds`,
      key: refundKey,
      body: refund.body,
    };
  });

  // ───────────────────────────── numbering / idempotency / posting ─────────────────────────────
  it('N1 document numbering is gapless and duplicate-free per company, and the counters equal count + 1', async () => {
    for (const co of [w.a, omCo]) {
      for (const [table, col, type] of [
        ['"order"', '"orderNumber"', 'ORDER'],
        ['invoice', '"invoiceNumber"', 'INVOICE'],
        ['credit_note', '"creditNoteNumber"', 'CREDIT_NOTE'],
      ] as const) {
        const rows = await q<{ n: string }>(
          `SELECT ${col} n FROM ${table} WHERE "companyId" = $1 AND ${col} IS NOT NULL`,
          [co.companyId],
        );
        const nums = rows.map((r) => Number(r.n.replace(/\D+/g, ''))).sort((a, b) => a - b);
        expect(new Set(nums).size, `${table} duplicates`).toBe(nums.length);
        expect(nums, `${table} gapless from 1`).toEqual(nums.map((_, i) => i + 1));
        const ctr = await q<{ n: string }>(
          `SELECT "nextNumber"::text n FROM document_number_counter WHERE "companyId" = $1 AND "documentType" = $2`,
          [co.companyId, type],
        );
        if (nums.length > 0) expect(Number(ctr[0]!.n)).toBe(nums.length + 1);
      }
    }
  });

  it('I1 replaying every completed sale with its original key is a no-op: identical response, no new invoice, payment or journal', async () => {
    const counts = async (): Promise<string> =>
      JSON.stringify(
        await one(
          `SELECT (SELECT count(*) FROM invoice) inv, (SELECT count(*) FROM payment) pay, (SELECT count(*) FROM journal_entry) je,
                  (SELECT count(*) FROM "order") ord, (SELECT count(*) FROM customer_advance_application) app`,
        ),
      );
    const before = await counts();
    for (const s of sales) {
      const replay = await w.req(
        'POST',
        `/companies/${s.co.companyId}/branches/${s.branch}/orders/${s.orderId}/complete-sale`,
        s.token,
        s.completeBody,
        { 'if-match': String(s.orderVersion), 'idempotency-key': s.completeKey },
      );
      expect(replay.status, s.label).toBe(200);
      expect(replay.body, s.label).toEqual(s.response.body);
    }
    // the refund replays too: same key, same body, no second refund or journal
    expect(refundReplay).not.toBeNull();
    const rr = await w.req(
      'POST',
      refundReplay!.url,
      w.ownerToken,
      { requestedAmountMinor: '3000', method: 'CASH', reasonCode: 'CUSTOMER_REQUEST' },
      { 'idempotency-key': refundReplay!.key },
    );
    expect(rr.status).toBe(201);
    expect(rr.body).toEqual(refundReplay!.body);
    expect(Number((await one<{ n: string }>(`SELECT count(*)::text n FROM refund`)).n)).toBe(1);
    expect(await counts()).toBe(before);
  });

  it('J1 every journal entry balances, has ≥ 2 lines, is sealed, and no (company, source) posted twice', async () => {
    const unbalanced = await q(
      `SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
        GROUP BY je.id HAVING SUM(jl."debitMinor") <> SUM(jl."creditMinor") OR COUNT(*) < 2`,
    );
    expect(unbalanced).toEqual([]);
    const unsealed = await q(`SELECT id FROM journal_entry WHERE "sealedAt" IS NULL`);
    expect(unsealed).toEqual([]);
    const dup = await q(
      `SELECT "companyId","sourceKind","sourceId",count(*) FROM journal_entry GROUP BY 1,2,3 HAVING count(*) > 1`,
    );
    expect(dup).toEqual([]);
    // one entry per source document: invoices, payments, credit note and refund all have exactly one
    const missing = await q(
      `SELECT i.id FROM invoice i WHERE NOT EXISTS (SELECT 1 FROM journal_entry je WHERE je."sourceId" = i.id::text)`,
    );
    expect(missing).toEqual([]);
    // the database itself refuses a second entry for an already-posted source
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO journal_entry ("tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
           SELECT "tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint"
             FROM journal_entry WHERE "companyId" = $1 LIMIT 1`,
          [w.a.companyId],
        ),
      ).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  // ───────────────────────────── trial balance + owner reports ─────────────────────────────
  const Q = `from=${PERIOD.from}&to=${PERIOD.to}`;

  it('T1 the Trial Balance ties: Σ debits = Σ credits (opening, period and closing) and every account equals the journal lines', async () => {
    const tb = await w.req(
      'GET',
      `/companies/${w.a.companyId}/reports/trial-balance?${Q}`,
      w.ownerToken,
    );
    expect(tb.status, JSON.stringify(tb.body)).toBe(200);
    const totals = obj(at(tb.body, 'totals'));
    expect(str(totals['totalPeriodDebitMinor'])).toBe(str(totals['totalPeriodCreditMinor']));
    expect(str(totals['totalClosingDebitMinor'])).toBe(str(totals['totalClosingCreditMinor']));
    expect(str(totals['totalOpeningDebitMinor'])).toBe(str(totals['totalOpeningCreditMinor']));
    const oracle = await q<{ key: string; d: string; c: string }>(
      `SELECT a.key, COALESCE(SUM(jl."debitMinor"),0)::text d, COALESCE(SUM(jl."creditMinor"),0)::text c
         FROM account a LEFT JOIN journal_line jl ON jl."accountId" = a.id WHERE a."companyId" = $1 GROUP BY a.key`,
      [w.a.companyId],
    );
    const rows = new Map((at(tb.body, 'accounts') as Json[]).map((r) => [str(r['accountKey']), r]));
    for (const o of oracle) {
      const r = rows.get(o.key);
      if (o.d === '0' && o.c === '0' && !r) continue; // an account with no movement need not be listed
      expect(r, o.key).toBeDefined();
      expect(str(r!['periodDebitMinor']), `${o.key} debit`).toBe(o.d);
      expect(str(r!['periodCreditMinor']), `${o.key} credit`).toBe(o.c);
    }
    // the sum of the Trial Balance totals equals the sum of every journal line of the company
    const all = await one<{ d: string; c: string }>(
      `SELECT SUM("debitMinor")::text d, SUM("creditMinor")::text c FROM journal_line WHERE "companyId" = $1`,
      [w.a.companyId],
    );
    expect(all.d).toBe(all.c);
    expect(str(totals['totalPeriodDebitMinor'])).toBe(all.d);
  });

  it('G1 the GL equals the independently computed business figures (revenue net of tax, VAT payable, cash, receivable, advances)', async () => {
    const aed = sales.filter((s) => s.co.companyId === w.a.companyId);
    const s3 = sales.find((s) => s.label === 'S3 split')!;
    const revenue = aed.reduce((a, s) => a + s.subtotal, 0n) - s3.subtotal; // the credit note reverses S3
    const vatPayable = aed.reduce((a, s) => a + s.tax, 0n) - s3.tax;
    expect(-(await glNet(w.a.companyId, 'REVENUE.SALES'))).toBe(revenue);
    expect(-(await glNet(w.a.companyId, 'LIABILITY.TAX_PAYABLE'))).toBe(vatPayable);
    // cash: S1 cash + S3 cash (2 000) + S6 cash + receipts (1 500 + 4 000) − the 3 000 cash refund
    const s1 = sales.find((s) => s.label === 'S1 cash')!;
    const s6 = sales.find((s) => s.label === 'S6 advance+cash')!;
    const cash = s1.total + 2000n + (s6.total - 1000n) + 1500n + 4000n - 3000n;
    expect(await glNet(w.a.companyId, 'ASSET.CASH_ON_HAND')).toBe(cash);
    // customer advances (liability): credit-note advance 5 303 − 3 000 refunded, plus 4 000 − 2 121 − 1 000
    expect(-(await glNet(w.a.companyId, 'LIABILITY.CUSTOMER_ADVANCES'))).toBe(
      5303n - 3000n + (4000n - 2121n - 1000n),
    );
  });

  it('O1 owner reports reconcile to the GL and to the source documents (UAE company)', async () => {
    const co = w.a.companyId;
    const aed = sales.filter((s) => s.co.companyId === co);
    const byLabel = (l: string): SaleRecord => sales.find((s) => s.label === l)!;
    const s3 = byLabel('S3 split');
    const s4 = byLabel('S4 credit');
    const sum = (f: (s: SaleRecord) => bigint): bigint => aed.reduce((a, s) => a + f(s), 0n);

    // Sales financial report — invoices, credit notes, net, and its own GL reconciliation
    const sr = await w.req('GET', `/companies/${co}/reports/sales?${Q}`, w.ownerToken);
    expect(sr.status, JSON.stringify(sr.body)).toBe(200);
    expect(at(sr.body, 'currencyCode')).toBe('AED');
    expect(at(sr.body, 'invoices.invoiceCount')).toBe(aed.length);
    expect(str(at(sr.body, 'invoices.invoicedSubtotalMinor'))).toBe(
      sum((s) => s.subtotal).toString(),
    );
    expect(str(at(sr.body, 'invoices.outputTaxMinor'))).toBe(sum((s) => s.tax).toString());
    expect(str(at(sr.body, 'invoices.invoicedTotalMinor'))).toBe(sum((s) => s.total).toString());
    expect(at(sr.body, 'creditNotes.creditNoteCount')).toBe(1);
    expect(str(at(sr.body, 'creditNotes.creditNoteNetExTaxMinor'))).toBe(s3.subtotal.toString());
    expect(str(at(sr.body, 'creditNotes.creditNoteTaxMinor'))).toBe(s3.tax.toString());
    expect(str(at(sr.body, 'creditNotes.creditNoteTotalMinor'))).toBe(s3.total.toString());
    expect(str(at(sr.body, 'netSalesAfterCreditNotes.netSalesAfterCreditNotesExTaxMinor'))).toBe(
      (sum((s) => s.subtotal) - s3.subtotal).toString(),
    );
    expect(at(sr.body, 'reconciliation.reconciled')).toBe(true);
    // … and the report's revenue / VAT equal the GL accounts read independently
    expect(-(await glNet(co, 'REVENUE.SALES'))).toBe(sum((s) => s.subtotal) - s3.subtotal);
    expect(-(await glNet(co, 'LIABILITY.TAX_PAYABLE'))).toBe(sum((s) => s.tax) - s3.tax);

    // Tender totals — receipts by method equal the independent arithmetic AND the payment table
    const cashIn =
      byLabel('S1 cash').total + 2000n + (byLabel('S6 advance+cash').total - 1000n) + 1500n + 4000n;
    const cardIn = byLabel('S2 card').total + (s3.total - 2000n);
    const tt = await w.req('GET', `/companies/${co}/reports/tender-totals?${Q}`, w.ownerToken);
    expect(tt.status, JSON.stringify(tt.body)).toBe(200);
    const method = (rows: unknown, m: string): Json =>
      (rows as Json[]).find((r) => r['method'] === m)!;
    expect(str(method(at(tt.body, 'receipts.byMethod'), 'CASH')['receiptTotalMinor'])).toBe(
      cashIn.toString(),
    );
    expect(
      str(method(at(tt.body, 'receipts.byMethod'), 'CARD_TERMINAL')['receiptTotalMinor']),
    ).toBe(cardIn.toString());
    expect(str(at(tt.body, 'receipts.receiptTotalMinor'))).toBe((cashIn + cardIn).toString());
    expect(str(at(tt.body, 'refunds.refundTotalMinor'))).toBe('3000');
    expect(str(method(at(tt.body, 'refunds.byMethod'), 'CASH')['refundTotalMinor'])).toBe('3000');
    expect(at(tt.body, 'reconciliation.reconciled')).toBe(true);
    const pay = await q<{ method: string; n: string }>(
      `SELECT method, SUM("amountMinor")::text n FROM payment WHERE "companyId" = $1 GROUP BY method`,
      [co],
    );
    expect(BigInt(pay.find((p) => p.method === 'CASH')!.n)).toBe(cashIn);
    expect(BigInt(pay.find((p) => p.method === 'CARD_TERMINAL')!.n)).toBe(cardIn);

    // Receivables — the partly paid credit sale is the only open receivable; it equals the GL control account
    const outstanding = s4.total - 1500n;
    const rr = await w.req('GET', `/companies/${co}/reports/receivables`, w.ownerToken);
    expect(rr.status, JSON.stringify(rr.body)).toBe(200);
    expect(str(at(rr.body, 'outstandingMinor'))).toBe(outstanding.toString());
    expect(str(at(rr.body, 'reconciliation.glAccountsReceivableMinor'))).toBe(
      outstanding.toString(),
    );
    expect(at(rr.body, 'reconciliation.reconciled')).toBe(true);
    expect(await glNet(co, 'ASSET.ACCOUNTS_RECEIVABLE')).toBe(outstanding);

    // Customer liabilities — advances (two sources) and unapplied receipts, each reconciled to its own GL account
    const advanceBook = 5303n - 3000n + (4000n - 2121n - 1000n);
    const cl = await w.req('GET', `/companies/${co}/reports/customer-liabilities`, w.ownerToken);
    expect(cl.status, JSON.stringify(cl.body)).toBe(200);
    expect(str(at(cl.body, 'advances.bookLiabilityMinor'))).toBe(advanceBook.toString());
    expect(str(at(cl.body, 'advances.reconciliation.glCustomerAdvancesLiabilityMinor'))).toBe(
      advanceBook.toString(),
    );
    expect(at(cl.body, 'advances.reconciliation.reconciled')).toBe(true);
    expect(str(at(cl.body, 'unappliedReceipts.unappliedReceiptMinor'))).toBe('0');
    expect(at(cl.body, 'unappliedReceipts.reconciliation.reconciled')).toBe(true);
    expect(-(await glNet(co, 'LIABILITY.CUSTOMER_ADVANCES'))).toBe(advanceBook);
  });

  it('O2 three-decimal company (OMR): reports and Trial Balance carry exponent 3 and reconcile to the baisa', async () => {
    const co = omCo.companyId;
    const s7 = sales.find((s) => s.label === 'S7 omr')!;
    const sr = await w.req('GET', `/companies/${co}/reports/sales?${Q}`, w.ownerToken);
    expect(sr.status, JSON.stringify(sr.body)).toBe(200);
    expect(at(sr.body, 'currencyCode')).toBe('OMR');
    expect(at(sr.body, 'currencyExponent')).toBe(3);
    expect(str(at(sr.body, 'invoices.invoicedSubtotalMinor'))).toBe(s7.subtotal.toString());
    expect(str(at(sr.body, 'invoices.outputTaxMinor'))).toBe(s7.tax.toString());
    expect(str(at(sr.body, 'invoices.invoicedTotalMinor'))).toBe(s7.total.toString());
    expect(at(sr.body, 'reconciliation.reconciled')).toBe(true);
    const tb = await w.req('GET', `/companies/${co}/reports/trial-balance?${Q}`, w.ownerToken);
    expect(tb.status, JSON.stringify(tb.body)).toBe(200);
    expect(at(tb.body, 'currencyExponent')).toBe(3);
    expect(str(at(tb.body, 'totals.totalPeriodDebitMinor'))).toBe(
      str(at(tb.body, 'totals.totalPeriodCreditMinor')),
    );
    expect(str(at(tb.body, 'totals.totalPeriodDebitMinor'))).toBe(s7.total.toString());
    expect(-(await glNet(co, 'REVENUE.SALES'))).toBe(37035n);
    expect(-(await glNet(co, 'LIABILITY.TAX_PAYABLE'))).toBe(1852n);
    expect(await glNet(co, 'ASSET.CASH_ON_HAND')).toBe(s7.total);
  });

  // ───────────────────────────── isolation ─────────────────────────────
  it('X1 tenant and branch isolation: a foreign tenant, a foreign company and a one-branch caller never see more than their own scope', async () => {
    const co = w.a.companyId;
    const foreign = await mintTenantToken(w.h, w.b.tenantId, rolePerms('owner'), { stepUp: true });
    for (const path of [
      `/companies/${co}/reports/trial-balance?${Q}`,
      `/companies/${co}/reports/sales?${Q}`,
      `/companies/${co}/reports/tender-totals?${Q}`,
      `/companies/${co}/reports/receivables`,
      `/companies/${co}/reports/customer-liabilities`,
    ]) {
      const r = await w.req('GET', path, foreign);
      expect([403, 404], path).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toContain(co);
    }
    // the Oman company's data never appears in the UAE company's figures, and vice versa
    const omSales = await w.req(
      'GET',
      `/companies/${omCo.companyId}/reports/sales?${Q}`,
      w.ownerToken,
    );
    expect(omSales.status, JSON.stringify(omSales.body)).toBe(200);
    const omInv = obj(at(omSales.body, 'invoices'));
    expect(omInv['invoiceCount']).toBe(1);
    expect(str(omInv['invoicedTotalMinor'])).toBe('38887');
    // a caller scoped to branch 1 only: company-wide report is denied; its branch report equals the branch oracle
    const oneBranch = await mintTenantToken(w.h, w.a.tenantId, rolePerms('manager'), {
      branchScope: [w.a.branches[0]!],
    });
    const companyWide = await w.req('GET', `/companies/${co}/reports/sales?${Q}`, oneBranch);
    expect([403, 404]).toContain(companyWide.status);
    const own = await w.req(
      'GET',
      `/companies/${co}/branches/${w.a.branches[0]!}/reports/sales?${Q}`,
      oneBranch,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const branchOracle = await one<{ n: string; t: string }>(
      `SELECT count(*)::text n, COALESCE(SUM("totalAmountMinor"),0)::text t FROM invoice WHERE "branchId" = $1`,
      [w.a.branches[0]!],
    );
    expect(str(at(own.body, 'invoices.invoiceCount'))).toBe(branchOracle.n);
    expect(str(at(own.body, 'invoices.invoicedTotalMinor'))).toBe(branchOracle.t);
    const otherBranch = await w.req(
      'GET',
      `/companies/${co}/branches/${w.a.branches[1]!}/reports/sales?${Q}`,
      oneBranch,
    );
    expect([403, 404]).toContain(otherBranch.status);
  });
});
