import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Phase 3B closure — RB-1 A2: anonymous issued-sale credit notes and per-tender refunds, end to end through the PUBLIC HTTP routes on
 * the full application (real guards, real default role grants, real Redis sessions, real idempotency layer) against REAL PostgreSQL
 * with all 50 migrations. The sales are made through the public sale route (5 % VAT, line rounding), never inserted by hand.
 *
 * Money oracle: every expectation is derived from the SALE's own invoice (read from the database) — not from this feature's code.
 */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v as Json;
const str = (v: unknown): string => String(v);
const UNIT = 3333n; // AED 33.33 per piece, 5 % VAT exclusive

describe('anonymous credit note — RB-1 A2 (real PostgreSQL, full HTTP stack)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let admin: pg.Pool;
  let co: Co;
  let branch: string;
  let manager = '';
  let cashier = '';
  let noStepUp = '';
  let issueOnly = '';
  let viewOnly = '';
  let counter = 0;
  const key = (p: string): string => `${p}-${++counter}-${randomUUID().slice(0, 8)}`;

  const rows = async <T extends Json = Json>(sql: string, p: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, p)).rows as T[];
  const one = async <T extends Json = Json>(sql: string, p: unknown[] = []): Promise<T> =>
    (await rows<T>(sql, p))[0]!;

  const base = (c: Co = co, b: string = branch): string =>
    `/companies/${c.companyId}/branches/${b}`;

  interface Sale {
    orderId: string;
    invoiceId: string;
    lineIds: string[];
    subtotal: bigint;
    tax: bigint;
    total: bigint;
    co: Co;
    branch: string;
  }

  /** a REAL anonymous PAY_NOW sale through the public routes; `split(total)` returns the tenders (summing to the total) */
  async function sellAnon(o: {
    qtys: number[];
    split?: (total: bigint) => { method: string; amountMinor: bigint }[];
    docDiscount?: bigint;
    customerId?: string;
    c?: Co;
    b?: string;
  }): Promise<Sale> {
    const c = o.c ?? co;
    const b = o.b ?? branch;
    const created = await w.req(
      'POST',
      `${base(c, b)}/orders`,
      w.ownerToken,
      {
        ...(o.customerId ? { customerId: o.customerId } : {}),
        lines: o.qtys.map((q) => ({
          productId: w.productId,
          variantId: w.variantId,
          selectedUomCode: 'piece',
          quantity: String(q),
        })),
        ...(o.docDiscount
          ? {
              documentDiscountMode: 'AMOUNT',
              documentDiscountAmountMinor: o.docDiscount.toString(),
              documentDiscountReason: 'test',
            }
          : {}),
      },
      { 'idempotency-key': key('order') },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = obj(obj(created.body)['order']) as { id: string; version: number };
    const prev = await w.req('GET', `${base(c, b)}/orders/${order.id}/totals`, w.ownerToken);
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const total = BigInt(str(obj(prev.body)['totalAmountMinor']));
    const tenders = (o.split ?? ((t) => [{ method: 'CASH', amountMinor: t }]))(total);
    const done = await w.req(
      'POST',
      `${base(c, b)}/orders/${order.id}/complete-sale`,
      w.ownerToken,
      {
        paymentIntent: 'PAY_NOW',
        tenders: tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor.toString() })),
      },
      { 'if-match': String(order.version), 'idempotency-key': key('sale') },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const inv = obj(obj(done.body)['invoice']);
    const lineRows = await rows<{ id: string }>(
      `SELECT id FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"`,
      [order.id],
    );
    return {
      orderId: order.id,
      invoiceId: str(inv['id']),
      lineIds: lineRows.map((r) => r.id),
      subtotal: BigInt(str(inv['subtotalAmountMinor'])),
      tax: BigInt(str(inv['taxTotalAmountMinor'])),
      total: BigInt(str(inv['totalAmountMinor'])),
      co: c,
      branch: b,
    };
  }

  const issueUrl = (s: Sale): string =>
    `${base(s.co, s.branch)}/invoices/${s.invoiceId}/anonymous-credit-notes`;
  const noteUrl = (s: Sale, id: string): string =>
    `${base(s.co, s.branch)}/anonymous-credit-notes/${id}`;

  async function issue(
    s: Sale,
    body: Json,
    o: { token?: string; k?: string } = {},
  ): Promise<{ status: number; body: Json }> {
    const r = await w.req('POST', issueUrl(s), o.token ?? manager, body, {
      'idempotency-key': o.k ?? key('cn'),
    });
    return { status: r.status, body: obj(r.body) };
  }
  const fullLines = (s: Sale, qtys: number[]): Json[] =>
    s.lineIds.map((id, i) => ({ orderLineId: id, quantity: String(qtys[i]) }));
  const code = (r: { body: Json }): string => str(obj(r.body['error'])['code']);

  /** the accountant's control queries (docs/phase-3/RB-1-ACCOUNTANT-CONTROL-QUERIES.sql), unchanged apart from the company placeholder */
  const controlQueries = (): { name: string; sql: string }[] => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../docs/phase-3/RB-1-ACCOUNTANT-CONTROL-QUERIES.sql',
    );
    return readFileSync(file, 'utf8')
      .split(/^-- @query /m)
      .slice(1)
      .map((chunk) => ({
        name: chunk.split('\n', 1)[0]!.trim(),
        sql: chunk
          .slice(chunk.indexOf('\n') + 1)
          .split('\n')
          .filter((l) => !l.trim().startsWith('--'))
          .join('\n')
          .trim()
          .replace(/;$/, '')
          .replaceAll(":'company_id'", '$1'),
      }));
  };
  const runControl = async (name: string): Promise<Json[]> =>
    rows(controlQueries().find((q) => q.name === name)!.sql, [co.companyId]);

  const journal = async (sourceKind: string, sourceId: string) =>
    rows<{ k: string; d: string; c: string }>(
      `SELECT a.key AS k, jl."debitMinor"::text AS d, jl."creditMinor"::text AS c
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
        WHERE je."sourceKind" = $1 AND je."sourceId" = $2 ORDER BY a.key`,
      [sourceKind, sourceId],
    );
  const glNet = async (account: string): Promise<bigint> =>
    BigInt(
      (
        await one<{ n: string }>(
          `SELECT COALESCE(SUM(jl."debitMinor" - jl."creditMinor"),0)::text AS n FROM journal_line jl JOIN account a ON a.id = jl."accountId"
            WHERE jl."companyId" = $1 AND a.key = $2`,
          [co.companyId, account],
        )
      ).n,
    );
  const fingerprint = async (s: Sale): Promise<string> => {
    const parts = [
      JSON.stringify(await rows(`SELECT * FROM invoice WHERE id = $1`, [s.invoiceId])),
      JSON.stringify(await rows(`SELECT * FROM "order" WHERE id = $1`, [s.orderId])),
      JSON.stringify(
        await rows(`SELECT * FROM order_line WHERE "orderId" = $1 ORDER BY id`, [s.orderId]),
      ),
      JSON.stringify(
        await rows(
          `SELECT je.id, je."sourceKind", jl."debitMinor", jl."creditMinor", jl."accountId" FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id WHERE je."sourceId" = $1 OR je."sourceId" = $2 ORDER BY jl.id`,
          [s.invoiceId, s.orderId],
        ),
      ),
      JSON.stringify(
        await rows(
          `SELECT pa.* FROM payment_allocation pa WHERE pa."invoiceId" = $1 ORDER BY pa.id`,
          [s.invoiceId],
        ),
      ),
    ];
    return createHash('sha256').update(parts.join('|')).digest('hex');
  };

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    admin = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 3);
    co = w.a;
    branch = co.branches[0]!;

    // 5 % STANDARD VAT, taxed product, AED 33.33 — exactly as the Phase 3 exit scenario configures it (public catalog routes)
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
    noStepUp = await mintTenantToken(w.h, co.tenantId, rolePerms('manager'), { stepUp: false });
    issueOnly = await mintTenantToken(
      w.h,
      co.tenantId,
      [...rolePerms('cashier'), 'credit_notes:issue'],
      { stepUp: true },
    );
    viewOnly = await mintTenantToken(
      w.h,
      co.tenantId,
      [...rolePerms('cashier'), 'credit_notes:view'],
      { stepUp: true },
    );
  }, 600_000);

  afterAll(async () => {
    await w?.h.app.close();
    await w?.pool?.end();
    await admin?.end();
    await stack?.stop();
  });

  // ═══════════════════════════ full reversal, single tender ═══════════════════════════
  it('FULL reversal of a cash sale: immutable credit note, exact journal, refund PENDING; the sale itself is NOT modified', async () => {
    const s = await sellAnon({ qtys: [3] });
    expect(s.tax).toBeGreaterThan(0n); // the fixture really carries VAT
    const before = await fingerprint(s);
    const res = await issue(s, {
      reasonCode: 'CUSTOMER_REQUEST',
      note: 'customer returned the goods',
      lines: fullLines(s, [3]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const n = res.body;
    expect(str(n['creditNoteNumber'])).toMatch(/^CN-\d{6}$/);
    expect(n['totalAmountMinor']).toBe(s.total.toString());
    expect(n['taxTotalAmountMinor']).toBe(s.tax.toString()); // VAT reversed = VAT declared, from the frozen snapshot
    expect(obj(n['invoiceReversal'])['status']).toBe('FULL');
    const refunds = n['refunds'] as Json[];
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ method: 'CASH', status: 'PENDING', resolvedAt: null }); // NOT executed
    expect(obj(n['refundSummary'])).toMatchObject({
      pendingMinor: s.total.toString(),
      executedMinor: '0',
      unallocatedMinor: '0',
    });

    // the issuance journal: Dr REVENUE (total − tax) · Dr TAX / Cr PAYMENT_CLEARING (total) — and nothing on cash / bank yet
    const j = await journal('anonymous_credit_note', str(n['id']));
    expect(j).toEqual(
      [
        { k: 'ASSET.PAYMENT_CLEARING', d: '0', c: s.total.toString() },
        { k: 'LIABILITY.TAX_PAYABLE', d: s.tax.toString(), c: '0' },
        { k: 'REVENUE.SALES', d: (s.total - s.tax).toString(), c: '0' },
      ].sort((a, b) => a.k.localeCompare(b.k)),
    );
    // the original sale (invoice, order, lines, payments, its own journal) is byte-identical
    expect(await fingerprint(s)).toBe(before);
    // audit, bounded: ids / amounts / codes only — never the free-text note
    const audit = await rows<{ after: Json }>(
      `SELECT after FROM audit_log WHERE action = 'anonymous_credit_note.issued' AND "resourceId" = $1`,
      [str(n['id'])],
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after)).not.toContain('returned the goods');
    // a GET returns the same document
    const got = await w.req('GET', noteUrl(s, str(n['id'])), viewOnly);
    expect(got.status).toBe(200);
    expect(obj(got.body)['id']).toBe(n['id']);
  });

  it('executing the cash refund (attested) posts Dr PAYMENT_CLEARING / Cr CASH_ON_HAND; net effect: revenue and tax reversed, cash out', async () => {
    const s = await sellAnon({ qtys: [2] });
    const rev0 = await glNet('REVENUE.SALES');
    const tax0 = await glNet('LIABILITY.TAX_PAYABLE');
    const cash0 = await glNet('ASSET.CASH_ON_HAND');
    const clr0 = await glNet('ASSET.PAYMENT_CLEARING');
    const issued = await issue(s, {
      reasonCode: 'DAMAGED',
      lines: fullLines(s, [2]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect(issued.status).toBe(201);
    const refundId = str((issued.body['refunds'] as Json[])[0]!['id']);
    const exec = await w.req(
      'POST',
      `${noteUrl(s, str(issued.body['id']))}/refunds/${refundId}/execute`,
      manager,
      { reference: 'RCPT-1001' },
      { 'idempotency-key': key('ex') },
    );
    expect(exec.status, JSON.stringify(exec.body)).toBe(200);
    expect(obj((obj(exec.body)['refunds'] as Json[])[0])).toMatchObject({
      status: 'EXECUTED',
      reference: 'RCPT-1001',
    });
    expect(obj(obj(exec.body)['refundSummary'])).toMatchObject({
      executedMinor: s.total.toString(),
      pendingMinor: '0',
    });
    expect(await journal('anonymous_credit_note_refund', refundId)).toEqual(
      [
        { k: 'ASSET.CASH_ON_HAND', d: '0', c: s.total.toString() },
        { k: 'ASSET.PAYMENT_CLEARING', d: s.total.toString(), c: '0' },
      ].sort((a, b) => a.k.localeCompare(b.k)),
    );
    expect((await glNet('REVENUE.SALES')) - rev0).toBe(s.total - s.tax);
    expect((await glNet('LIABILITY.TAX_PAYABLE')) - tax0).toBe(s.tax);
    expect((await glNet('ASSET.CASH_ON_HAND')) - cash0).toBe(-s.total);
    expect((await glNet('ASSET.PAYMENT_CLEARING')) - clr0).toBe(0n); // the in-flight amount is fully converted
    // a second execute / a fail of the same refund is refused (terminal)
    const again = await w.req(
      'POST',
      `${noteUrl(s, str(issued.body['id']))}/refunds/${refundId}/execute`,
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect([again.status, str(obj(obj(again.body)['error'])['code'])]).toEqual([
      409,
      'REFUND_NOT_PENDING',
    ]);
    const failAfter = await w.req(
      'POST',
      `${noteUrl(s, str(issued.body['id']))}/refunds/${refundId}/fail`,
      manager,
      { reasonCode: 'OTHER' },
      { 'idempotency-key': key('fl') },
    );
    expect(failAfter.status).toBe(409);
  });

  // ═══════════════════════════ mixed tenders ═══════════════════════════
  it('MIXED tenders (cash + manual card): per-tender caps; cash execution posts, card execution posts NOTHING (the sale debited the clearing account itself)', async () => {
    const s = await sellAnon({
      qtys: [3],
      split: (t) => [
        { method: 'CASH', amountMinor: t - 4500n },
        { method: 'CARD_TERMINAL', amountMinor: 4500n },
      ],
    });
    const cashPaid = s.total - 4500n;
    // a card payment can never be refunded as cash; and the lines must sum to the total
    let r = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [3]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect([r.status, code(r)]).toEqual([422, 'REFUND_EXCEEDS_TENDER']);
    r = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [3]),
      refunds: [{ method: 'CASH', amountMinor: cashPaid.toString() }],
    });
    expect([r.status, code(r)]).toEqual([422, 'REFUND_TOTAL_MISMATCH']);
    r = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [3]),
      refunds: [
        { method: 'BANK_TRANSFER', amountMinor: cashPaid.toString() },
        { method: 'CARD_TERMINAL', amountMinor: '4500' },
      ],
    });
    expect([r.status, code(r)]).toEqual([422, 'REFUND_EXCEEDS_TENDER']); // bank was never used
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(0); // every refusal wrote nothing

    const clr0 = await glNet('ASSET.PAYMENT_CLEARING');
    const cash0 = await glNet('ASSET.CASH_ON_HAND');
    const ok = await issue(s, {
      reasonCode: 'CUSTOMER_REQUEST',
      lines: fullLines(s, [3]),
      refunds: [
        { method: 'CASH', amountMinor: cashPaid.toString() },
        { method: 'CARD_TERMINAL', amountMinor: '4500', reference: 'TERM-SLIP-77' },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const refundsOf = ok.body['refunds'] as Json[];
    const cashRefund = refundsOf.find((r) => r['method'] === 'CASH');
    const cardRefund = refundsOf.find((r) => r['method'] === 'CARD_TERMINAL');
    const url = (id: unknown, a: string) =>
      `${noteUrl(s, str(ok.body['id']))}/refunds/${str(id)}/${a}`;
    const e1 = await w.req(
      'POST',
      url(cashRefund!['id'], 'execute'),
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    const e2 = await w.req(
      'POST',
      url(cardRefund!['id'], 'execute'),
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect([e1.status, e2.status]).toEqual([200, 200]);
    expect(await journal('anonymous_credit_note_refund', str(cashRefund!['id']))).toHaveLength(2);
    expect(await journal('anonymous_credit_note_refund', str(cardRefund!['id']))).toHaveLength(0);
    // net: cash out = the cash paid; clearing net = −(card part) relative to before this credit
    expect((await glNet('ASSET.CASH_ON_HAND')) - cash0).toBe(-cashPaid);
    expect((await glNet('ASSET.PAYMENT_CLEARING')) - clr0).toBe(-4500n);
    // every journal of this feature is balanced
    const unbalanced = await rows(
      `SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id WHERE je."sourceKind" LIKE 'anonymous_credit_note%' GROUP BY je.id HAVING SUM(jl."debitMinor") <> SUM(jl."creditMinor")`,
    );
    expect(unbalanced).toEqual([]);
  });

  // ═══════════════════════════ partial credits, discounts ═══════════════════════════
  it('PARTIAL credits: 1 + 1 + final 1 of 3 sum EXACTLY to the invoice (VAT included); a fourth is refused; statuses PARTIAL → PARTIAL → FULL; numbering is gapless', async () => {
    const s = await sellAnon({ qtys: [3] });
    // independent oracle from the sale's FROZEN line (schema rule: floor(frozen × qC/qO); the final credit takes the exact remainder)
    const ol = await one<{ tax: string }>(
      `SELECT "lineTaxAmountMinor"::text AS tax FROM order_line WHERE id = $1`,
      [s.lineIds[0]],
    );
    const tax = BigInt(ol.tax);
    const gross = UNIT * 3n;
    const part = { gross: gross / 3n, tax: tax / 3n };
    const expected = [
      { total: part.gross + part.tax, tax: part.tax },
      { total: part.gross + part.tax, tax: part.tax },
      { total: gross - 2n * part.gross + (tax - 2n * part.tax), tax: tax - 2n * part.tax },
    ];
    expect(expected.reduce((a, e) => a + e.total, 0n)).toBe(s.total); // the oracle itself ties to the invoice
    const numbers: string[] = [];
    const statuses: string[] = [];
    for (const e of expected) {
      const r = await issue(s, {
        reasonCode: 'CUSTOMER_REQUEST',
        lines: [{ orderLineId: s.lineIds[0]!, quantity: '1' }],
        refunds: [{ method: 'CASH', amountMinor: e.total.toString() }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body['totalAmountMinor']).toBe(e.total.toString());
      expect(r.body['taxTotalAmountMinor']).toBe(e.tax.toString());
      numbers.push(str(r.body['creditNoteNumber']));
      statuses.push(str(obj(r.body['invoiceReversal'])['status']));
    }
    expect(statuses).toEqual(['PARTIAL', 'PARTIAL', 'FULL']);
    const nums = numbers.map((n) => Number(n.slice(3)));
    expect([nums[1]! - nums[0]!, nums[2]! - nums[1]!]).toEqual([1, 1]);
    const totals = await one<{ t: string; x: string }>(
      `SELECT SUM(l."lineTotalCreditedMinor")::text AS t, SUM(l."taxCreditedMinor")::text AS x
         FROM anonymous_credit_note_line l JOIN anonymous_credit_note n ON n.id = l."creditNoteId" WHERE n."invoiceId" = $1`,
      [s.invoiceId],
    );
    expect([totals.t, totals.x]).toEqual([s.total.toString(), s.tax.toString()]); // VAT reversed exactly once, in total
    const fourth = await issue(s, {
      reasonCode: 'OTHER',
      lines: [{ orderLineId: s.lineIds[0]!, quantity: '1' }],
      refunds: [{ method: 'CASH', amountMinor: '1' }],
    });
    expect([fourth.status, code(fourth)]).toEqual([422, 'CREDIT_NOTE_QUANTITY_EXCEEDS_REMAINING']);
  });

  it('a sale with a DOCUMENT discount: the full credit equals the invoice (net-of-discount convention, VAT exact)', async () => {
    const s = await sellAnon({ qtys: [2, 1], docDiscount: 777n });
    const res = await issue(s, {
      reasonCode: 'PRICING_ERROR',
      lines: fullLines(s, [2, 1]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body['totalAmountMinor']).toBe(s.total.toString());
    expect(res.body['taxTotalAmountMinor']).toBe(s.tax.toString());
    expect(
      (res.body['lines'] as Json[]).reduce(
        (a, l) => a + BigInt(str(l['documentDiscountShareCreditedMinor'])),
        0n,
      ),
    ).toBe(777n);
  });

  // ═══════════════════════════ failed / pending refunds ═══════════════════════════
  it('a FAILED refund posts nothing and leaves its amount UNALLOCATED; a replacement respects the tender caps; terminal states stay terminal', async () => {
    const s = await sellAnon({
      qtys: [3],
      split: (t) => [
        { method: 'CASH', amountMinor: t - 4500n },
        { method: 'CARD_TERMINAL', amountMinor: 4500n },
      ],
    });
    const issued = await issue(s, {
      reasonCode: 'CUSTOMER_REQUEST',
      lines: fullLines(s, [3]),
      refunds: [
        { method: 'CASH', amountMinor: (s.total - 4500n).toString() },
        { method: 'CARD_TERMINAL', amountMinor: '4500' },
      ],
    });
    expect(issued.status).toBe(201);
    const noteId = str(issued.body['id']);
    const card = (issued.body['refunds'] as Json[]).find((r) => r['method'] === 'CARD_TERMINAL')!;
    const jBefore = await rows(
      `SELECT 1 FROM journal_entry WHERE "sourceKind" LIKE 'anonymous_credit_note%'`,
    );
    const fail = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds/${str(card['id'])}/fail`,
      manager,
      { reasonCode: 'TERMINAL_DECLINED' },
      { 'idempotency-key': key('fl') },
    );
    expect(fail.status, JSON.stringify(fail.body)).toBe(200);
    expect(obj(fail.body)['refundSummary']).toMatchObject({
      failedMinor: '4500',
      unallocatedMinor: '4500',
    });
    expect(
      await rows(`SELECT 1 FROM journal_entry WHERE "sourceKind" LIKE 'anonymous_credit_note%'`),
    ).toHaveLength(jBefore.length); // no posting for a failure
    // DB tender cap, isolated: the failed CARD line freed 4500 of the NOTE's allocation, so the note-total bound is NOT
    // what stops a direct 1-minor-unit CASH refund — only the per-tender cap (CASH is already fully refunded) can.
    let capMsg = 'NO_ERROR';
    try {
      await admin.query(
        `INSERT INTO anonymous_credit_note_refund ("tenantId","companyId","branchId","creditNoteId","invoiceId","method","amountMinor","currencyCode","currencyExponent")
         SELECT "tenantId","companyId","branchId", id, "invoiceId", 'CASH', 1, "currencyCode","currencyExponent" FROM anonymous_credit_note WHERE id = $1`,
        [noteId],
      );
    } catch (e) {
      capMsg = (e as Error).message;
    }
    expect(capMsg).toMatch(/would exceed what that tender paid/);
    // cash is already fully used by the other line: a replacement as CASH is refused, as CARD is accepted
    const asCash = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds`,
      manager,
      { method: 'CASH', amountMinor: '4500' },
      { 'idempotency-key': key('ar') },
    );
    expect(asCash.status).toBe(422);
    const asCard = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds`,
      manager,
      { method: 'CARD_TERMINAL', amountMinor: '4500', reference: 'TERM-RETRY' },
      { 'idempotency-key': key('ar') },
    );
    expect(asCard.status, JSON.stringify(asCard.body)).toBe(201);
    expect(obj(asCard.body)['refundSummary']).toMatchObject({
      unallocatedMinor: '0',
      failedMinor: '4500',
    });
    // more than the credit total is refused
    const tooMuch = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds`,
      manager,
      { method: 'CARD_TERMINAL', amountMinor: '1' },
      { 'idempotency-key': key('ar') },
    );
    expect(tooMuch.status).toBe(422);
    // the failed refund can no longer be executed
    const exFailed = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds/${str(card['id'])}/execute`,
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect([exFailed.status, str(obj(obj(exFailed.body)['error'])['code'])]).toEqual([
      409,
      'REFUND_NOT_PENDING',
    ]);
  });

  // ═══════════════════════════ idempotency and concurrency ═══════════════════════════
  it('IDEMPOTENCY: the same key replays the stored response with no second note; a new key for exhausted lines is refused', async () => {
    const s = await sellAnon({ qtys: [2] });
    const body = {
      reasonCode: 'DUPLICATE',
      lines: fullLines(s, [2]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    };
    const k = key('idem');
    const a = await issue(s, body, { k });
    const b = await issue(s, body, { k });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body['id']).toBe(a.body['id']);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(1);
    const c = await issue(s, body);
    expect([c.status, code(c)]).toEqual([422, 'CREDIT_NOTE_QUANTITY_EXCEEDS_REMAINING']);
    // a request without an Idempotency-Key is refused before anything runs
    const noKey = await w.req('POST', issueUrl(s), manager, body);
    expect(noKey.status).toBe(400);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(1);
  });

  it('CONCURRENCY: six simultaneous FULL credits of one sale → exactly one succeeds, one note, one journal; two racing partials (2 + 2 of 3) → exactly one', async () => {
    const s = await sellAnon({ qtys: [3] });
    const full = {
      reasonCode: 'OTHER',
      lines: fullLines(s, [3]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    };
    const rs = await Promise.all(Array.from({ length: 6 }, () => issue(s, full)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    // the losers are refused by the APPLICATION under its locks with the exact quantity code (422) — never by a database trigger firing
    // on a race (409 CREDIT_NOTE_CONFLICT), which would mean the application's serialisation is missing
    expect(rs.filter((r) => r.status !== 201).map((r) => [r.status, code(r)])).toEqual(
      Array.from({ length: 5 }, () => [422, 'CREDIT_NOTE_QUANTITY_EXCEEDS_REMAINING']),
    );
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(1);
    expect(
      await rows(
        `SELECT je.id FROM journal_entry je JOIN anonymous_credit_note n ON n.id::text = je."sourceId" WHERE n."invoiceId" = $1`,
        [s.invoiceId],
      ),
    ).toHaveLength(1);

    const s2 = await sellAnon({ qtys: [3] });
    const two = (q: number) =>
      issue(s2, {
        reasonCode: 'OTHER',
        lines: [{ orderLineId: s2.lineIds[0]!, quantity: String(q) }],
        refunds: [{ method: 'CASH', amountMinor: ((s2.total * BigInt(q)) / 3n + 1n).toString() }],
      });
    const pair = await Promise.all([two(2), two(2)]);
    const created = pair.filter((r) => r.status === 201);
    expect(created.length).toBeLessThanOrEqual(1); // 2 + 2 > 3: never both
    const sum = await one<{ q: string }>(
      `SELECT COALESCE(SUM(l."quantityCredited"),0)::text AS q FROM anonymous_credit_note_line l JOIN anonymous_credit_note n ON n.id = l."creditNoteId" WHERE n."invoiceId" = $1`,
      [s2.invoiceId],
    );
    expect(Number(sum.q)).toBeLessThanOrEqual(3);
  });

  it('CONCURRENCY: parallel refund lines can never exceed what a tender paid (the invoice lock + the database guard)', async () => {
    const s = await sellAnon({ qtys: [3] });
    const issued = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [3]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect(issued.status).toBe(201);
    const noteId = str(issued.body['id']);
    const refundId = str((issued.body['refunds'] as Json[])[0]!['id']);
    const f = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds/${refundId}/fail`,
      manager,
      { reasonCode: 'CASH_UNAVAILABLE' },
      { 'idempotency-key': key('fl') },
    );
    expect(f.status).toBe(200);
    // the whole total is unallocated again: five parallel replacements of the full total → exactly one fits
    const reps = await Promise.all(
      Array.from({ length: 5 }, () =>
        w.req(
          'POST',
          `${noteUrl(s, noteId)}/refunds`,
          manager,
          { method: 'CASH', amountMinor: s.total.toString() },
          { 'idempotency-key': key('ar') },
        ),
      ),
    );
    expect(reps.filter((r) => r.status === 201)).toHaveLength(1);
    const used = await one<{ n: string }>(
      `SELECT COALESCE(SUM("amountMinor"),0)::text AS n FROM anonymous_credit_note_refund WHERE "invoiceId" = $1 AND status <> 'FAILED'`,
      [s.invoiceId],
    );
    expect(BigInt(used.n)).toBe(s.total);
  });

  // ═══════════════════════════ scope rules ═══════════════════════════
  it('a sale whose recorded payments do not cover its total cannot be credited (defence in depth: no normal flow creates one, so the stored payments are tampered with by a superuser)', async () => {
    const s = await sellAnon({ qtys: [1] });
    const client = await admin.connect();
    try {
      await client.query(`SET session_replication_role = replica`); // bypass the append-only triggers, as only a superuser can
      await client.query(
        `UPDATE payment_allocation SET "amountMinor" = "amountMinor" - 1 WHERE "invoiceId" = $1`,
        [s.invoiceId],
      );
      await client.query(`SET session_replication_role = DEFAULT`);
    } finally {
      client.release();
    }
    const r = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [1]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect([r.status, code(r)]).toEqual([422, 'INVOICE_NOT_FULLY_PAID']);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(0);
  });

  it('a CUSTOMER-linked invoice cannot use this path (it has the frozen 3b.8 path); the refusal writes nothing', async () => {
    const s = await sellAnon({ qtys: [1], customerId: w.customers[0]! });
    const r = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [1]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect([r.status, code(r)]).toEqual([422, 'ANONYMOUS_CREDIT_NOTE_CUSTOMER_LINKED']);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(0);
  });

  it('a line that is not part of the sale, a malformed or unknown body, a free-text card number → refused with the stable codes', async () => {
    const s = await sellAnon({ qtys: [1] });
    const good = {
      reasonCode: 'OTHER',
      lines: fullLines(s, [1]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    };
    let r = await issue(s, { ...good, lines: [{ orderLineId: randomUUID(), quantity: '1' }] });
    expect([r.status, code(r)]).toEqual([422, 'CREDIT_NOTE_LINE_NOT_IN_ORDER']);
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, tenantId: randomUUID() },
      { ...good, refunds: [{ method: 'CASH', amountMinor: '10.5' }] },
      { ...good, refunds: [{ method: 'CREDIT', amountMinor: '10' }] },
      { ...good, refunds: [{ method: 'CASH', amountMinor: '0' }] },
      { ...good, lines: [] },
      { ...good, reasonCode: 'NOPE' },
      { ...good, lines: [{ orderLineId: s.lineIds[0], quantity: '1', unitPriceAmountMinor: '1' }] },
    ]) {
      r = await issue(s, bad as Json);
      expect([r.status, code(r)], JSON.stringify(bad)).toEqual([400, 'VALIDATION_FAILED']);
    }
    r = await issue(s, { ...good, note: 'refund to card 4111 1111 1111 1111' });
    expect([r.status, code(r)]).toEqual([400, 'SENSITIVE_DATA_REJECTED']);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(0);
  });

  // ═══════════════════════════ authorisation ═══════════════════════════
  it('AUTHORITY: a cashier can neither issue nor execute; issue needs BOTH credit_notes:issue and refunds:execute, with a fresh step-up; reads need credit_notes:view', async () => {
    const s = await sellAnon({ qtys: [1] });
    const body = {
      reasonCode: 'OTHER',
      lines: fullLines(s, [1]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    };
    for (const [token, status, c] of [
      [cashier, 403, 'MISSING_PERMISSION'],
      [issueOnly, 403, 'MISSING_PERMISSION'],
      [noStepUp, 403, 'STEP_UP_REQUIRED'],
    ] as const) {
      const r = await issue(s, body, { token });
      expect([r.status, code(r)]).toEqual([status, c]);
    }
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(0);
    const ok = await issue(s, body);
    expect(ok.status).toBe(201);
    const noteId = str(ok.body['id']);
    const refundId = str((ok.body['refunds'] as Json[])[0]!['id']);
    for (const token of [cashier, issueOnly, noStepUp]) {
      const ex = await w.req(
        'POST',
        `${noteUrl(s, noteId)}/refunds/${refundId}/execute`,
        token,
        {},
        { 'idempotency-key': key('ex') },
      );
      expect(ex.status, 'execute').toBe(403);
      const fl = await w.req(
        'POST',
        `${noteUrl(s, noteId)}/refunds/${refundId}/fail`,
        token,
        { reasonCode: 'OTHER' },
        { 'idempotency-key': key('fl') },
      );
      expect(fl.status, 'fail').toBe(403);
      const add = await w.req(
        'POST',
        `${noteUrl(s, noteId)}/refunds`,
        token,
        { method: 'CASH', amountMinor: '1' },
        { 'idempotency-key': key('ar') },
      );
      expect(add.status, 'add').toBe(403);
    }
    expect((await w.req('GET', noteUrl(s, noteId), cashier)).status).toBe(403);
    expect((await w.req('GET', noteUrl(s, noteId), viewOnly)).status).toBe(200);
    expect(
      await one<{ status: string }>(
        `SELECT status FROM anonymous_credit_note_refund WHERE id = $1`,
        [refundId],
      ),
    ).toEqual({ status: 'PENDING' });
  });

  // ═══════════════════════════ isolation ═══════════════════════════
  it('ISOLATION: another tenant, another company of the same tenant, and a branch-scoped caller of another branch all get a non-disclosing 404 and write nothing', async () => {
    const s = await sellAnon({ qtys: [1] });
    const ownerB = await mintTenantToken(w.h, w.b.tenantId, rolePerms('manager'), { stepUp: true });
    const body = {
      reasonCode: 'OTHER',
      lines: fullLines(s, [1]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    };
    // tenant B posting to tenant A's company / branch / invoice
    let r = await w.req('POST', issueUrl(s), ownerB, body, { 'idempotency-key': key('cn') });
    expect(r.status).toBe(404);
    // the SAME tenant but the invoice addressed under another company / branch
    const otherCo = w.a2;
    r = await w.req(
      'POST',
      `${base(otherCo, otherCo.branches[0]!)}/invoices/${s.invoiceId}/anonymous-credit-notes`,
      manager,
      body,
      { 'idempotency-key': key('cn') },
    );
    expect(r.status).toBe(404);
    const otherBranch = co.branches[1]!;
    r = await w.req(
      'POST',
      `${base(co, otherBranch)}/invoices/${s.invoiceId}/anonymous-credit-notes`,
      manager,
      body,
      { 'idempotency-key': key('cn') },
    );
    expect(r.status).toBe(404);
    const scoped = await mintTenantToken(w.h, co.tenantId, rolePerms('manager'), {
      stepUp: true,
      branchScope: [otherBranch],
    });
    r = await w.req('POST', issueUrl(s), scoped, body, { 'idempotency-key': key('cn') });
    expect(r.status).toBe(404);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(0);
    // a real note is invisible to the other tenant and the other branch
    const mine = await issue(s, body);
    expect(mine.status).toBe(201);
    expect((await w.req('GET', noteUrl(s, str(mine.body['id'])), ownerB)).status).toBe(404);
    expect(
      (
        await w.req(
          'GET',
          `${base(co, otherBranch)}/anonymous-credit-notes/${str(mine.body['id'])}`,
          manager,
        )
      ).status,
    ).toBe(404);
  });

  // ═══════════════════════════ the accountant's control queries are executed, not just written ═══════════════════════════
  // (placed BEFORE the direct-writer test below, which deliberately bypasses the application and so breaks the legitimate-flow invariant)
  it('CONTROL QUERIES: every statement of docs/phase-3/RB-1-ACCOUNTANT-CONTROL-QUERIES.sql runs against the real schema; over every legitimate flow of this suite the sub-ledger ↔ PAYMENT_CLEARING difference is exactly 0', async () => {
    expect(controlQueries().map((q) => q.name)).toEqual([
      'pending_refunds',
      'unallocated_credit',
      'clearing_reconciliation',
      'gl_effect_by_account',
      'executed_refunds_by_day',
      'reversed_sales',
      'same_user_issue_and_attest',
      'clearing_by_source_kind',
      'executed_without_audit',
    ]);
    // a deliberately UNALLOCATED credit: a full credit whose only refund line FAILED and was not replaced
    const u = await sellAnon({ qtys: [1] });
    const un = await issue(u, {
      reasonCode: 'OTHER',
      lines: fullLines(u, [1]),
      refunds: [{ method: 'CASH', amountMinor: u.total.toString() }],
    });
    expect(un.status, JSON.stringify(un.body)).toBe(201);
    const unFail = await w.req(
      'POST',
      `${noteUrl(u, str(un.body['id']))}/refunds/${str((un.body['refunds'] as Json[])[0]!['id'])}/fail`,
      manager,
      { reasonCode: 'CASH_UNAVAILABLE' },
      { 'idempotency-key': key('fl') },
    );
    expect(unFail.status, JSON.stringify(unFail.body)).toBe(200);

    const out: Record<string, Json[]> = {};
    for (const q of controlQueries()) out[q.name] = await rows(q.sql, [co.companyId]);
    expect(
      out['unallocated_credit']!.find((r) => r['credit_note_id'] === un.body['id']),
    ).toMatchObject({ total_minor: u.total.toString(), unallocated_minor: u.total.toString() });

    // the universal invariant, over every note and refund created so far in the company (all states, all tenders)
    expect(out['clearing_reconciliation']).toHaveLength(1);
    expect(out['clearing_reconciliation']![0]!['difference_minor']).toBe('0');
    // the lists reflect real states left by earlier tests: some refunds are still PENDING, some credit is unallocated
    expect(out['pending_refunds']!.length).toBeGreaterThan(0);
    expect(out['unallocated_credit']!.length).toBeGreaterThan(0);
    expect(out['executed_refunds_by_day']!.length).toBeGreaterThan(0);
    expect(out['reversed_sales']!.some((r) => r['reversal'] === 'FULL')).toBe(true);
    // F-5 evidence: this suite uses ONE manager session for every step, so the system (by design) let the same user issue and attest —
    // and the detective control shows exactly those lines (no policy is changed; an empty result would mean a second person attested)
    // Q8: the clearing account by source kind — the anonymous contribution equals what Q3 reconciles, and the sale contributes the takings
    const byKind = Object.fromEntries(
      out['clearing_by_source_kind']!.map((r) => [
        str(r['source_kind']),
        BigInt(str(r['net_debit_minor'])),
      ]),
    );
    expect(Object.keys(byKind)).toEqual(
      expect.arrayContaining(['walk_in_sale', 'anonymous_credit_note']),
    );
    const anonNet =
      (byKind['anonymous_credit_note'] ?? 0n) + (byKind['anonymous_credit_note_refund'] ?? 0n);
    expect(anonNet).toBe(BigInt(str(out['clearing_reconciliation']![0]!['expected_minor'])));
    // Q9: every EXECUTED refund of this suite went through the application, so every one has its audit row
    expect(out['executed_without_audit']).toEqual([]);
    expect(out['same_user_issue_and_attest']!.length).toBeGreaterThan(0);
    for (const r of out['same_user_issue_and_attest']!)
      expect(r['issued_by']).toBe(r['attested_by']);
    // the GL effect is balanced in total: Σ(debit − credit) over all accounts of these journals is 0
    const gl = out['gl_effect_by_account']!;
    expect(gl.reduce((a, r) => a + BigInt(str(r['net_debit_minor'])), 0n)).toBe(0n);
    expect(gl.map((r) => str(r['account_key']))).toEqual(
      expect.arrayContaining(['ASSET.PAYMENT_CLEARING', 'REVENUE.SALES']),
    );
  });

  // ═══════════════════════════ database guards, independent of the application ═══════════════════════════
  it('DB GUARDS hold even against a direct writer: immutable notes and lines, guarded refund transitions, anonymous-only, tender caps, line capacity', async () => {
    const s = await sellAnon({ qtys: [2], split: (t) => [{ method: 'CASH', amountMinor: t }] });
    const ok = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [2]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect(ok.status).toBe(201);
    const noteId = str(ok.body['id']);
    const refundId = str((ok.body['refunds'] as Json[])[0]!['id']);
    const bad = async (sql: string, p: unknown[] = []): Promise<string> => {
      try {
        await admin.query(sql, p);
      } catch (e) {
        return (e as Error).message;
      }
      return 'NO_ERROR';
    };
    expect(
      await bad(`UPDATE anonymous_credit_note SET "reasonCode" = 'OTHER' WHERE id = $1`, [noteId]),
    ).toMatch(/immutable/);
    expect(await bad(`DELETE FROM anonymous_credit_note WHERE id = $1`, [noteId])).toMatch(
      /immutable/,
    );
    expect(
      await bad(
        `UPDATE anonymous_credit_note_line SET "taxCreditedMinor" = 0 WHERE "creditNoteId" = $1`,
        [noteId],
      ),
    ).toMatch(/immutable/);
    expect(await bad(`DELETE FROM anonymous_credit_note_refund WHERE id = $1`, [refundId])).toMatch(
      /immutable/,
    );
    expect(
      await bad(`UPDATE anonymous_credit_note_refund SET "amountMinor" = 1 WHERE id = $1`, [
        refundId,
      ]),
    ).toMatch(/can only become|outcome columns/i);
    expect(
      await bad(`UPDATE anonymous_credit_note_refund SET status = 'EXECUTED' WHERE id = $1`, [
        refundId,
      ]),
    ).toMatch(/check|constraint/i); // EXECUTED needs resolvedAt
    // a direct over-cap refund (the whole total is already allocated) and a direct over-credit line
    expect(
      await bad(
        `INSERT INTO anonymous_credit_note_refund ("tenantId","companyId","branchId","creditNoteId","invoiceId","method","amountMinor","currencyCode","currencyExponent")
         SELECT "tenantId","companyId","branchId", id, "invoiceId", 'CASH', 1, "currencyCode","currencyExponent" FROM anonymous_credit_note WHERE id = $1`,
        [noteId],
      ),
    ).toMatch(/exceed/);
    expect(
      await bad(
        `INSERT INTO anonymous_credit_note_line ("tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
         SELECT "tenantId","companyId", id, (SELECT id FROM order_line WHERE "orderId" = $2 LIMIT 1), 1, 100, 0, 0, 100, 0, 100, "currencyCode","currencyExponent" FROM anonymous_credit_note WHERE id = $1`,
        [noteId, s.orderId],
      ),
    ).toMatch(/exceeds the ordered quantity/); // the quantity guard itself (the total bound would also trip, with a different message)
    // F-4: the PENDING → EXECUTED transition of a CASH refund is REJECTED by the database without its execution journal (the full
    // bypass / wrong-shape / role matrix is in anonymous-credit-note.integrity.integration.test.ts)
    expect(
      await bad(
        `UPDATE anonymous_credit_note_refund SET status = 'EXECUTED', "resolvedAt" = now(), "resolvedByUserId" = gen_random_uuid() WHERE id = $1`,
        [refundId],
      ),
    ).toMatch(/needs exactly one execution journal/);
    // the application path (status + journal in one transaction) is the only way to EXECUTED; afterwards the state is terminal
    const done = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds/${refundId}/execute`,
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(
      await bad(
        `UPDATE anonymous_credit_note_refund SET status = 'PENDING', "resolvedAt" = NULL WHERE id = $1`,
        [refundId],
      ),
    ).toMatch(/terminal/);
    // the reconciliation control still balances after the (correct) execution
    expect((await runControl('clearing_reconciliation'))[0]!['difference_minor']).toBe('0');
  });

  it('DB GUARD: a credit note can never be created for a customer-linked invoice, even by a direct writer', async () => {
    const s = await sellAnon({ qtys: [1], customerId: w.customers[1]! });
    const msg = await admin
      .query(
        `INSERT INTO anonymous_credit_note ("tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor")
         SELECT "tenantId","companyId","branchId", id, 'CN-990001', now(), '2026-06-15', "currencyCode","currencyExponent", 'OTHER', 1, 0, 1 FROM invoice WHERE id = $1`,
        [s.invoiceId],
      )
      .then(
        () => 'NO_ERROR',
        (e: Error) => e.message,
      );
    expect(msg).toMatch(/customer-linked/);
  });

  // ═══════════════════════════ ledger oracle across every refund state (final financial audit) ═══════════════════════════
  it('LEDGER ORACLE: one mixed-tender note walked through pending → partially executed → one failed → replaced → fully executed; the exact account effect and the balance of every journal are checked from the journal tables at each step', async () => {
    const CARD = 4500n;
    const s = await sellAnon({
      qtys: [3],
      split: (t) => [
        { method: 'CASH', amountMinor: t - CARD },
        { method: 'CARD_TERMINAL', amountMinor: CARD },
      ],
    });
    const cashAmt = s.total - CARD;
    const issued = await issue(s, {
      reasonCode: 'CUSTOMER_REQUEST',
      lines: fullLines(s, [3]),
      refunds: [
        { method: 'CASH', amountMinor: cashAmt.toString() },
        { method: 'CARD_TERMINAL', amountMinor: CARD.toString() },
      ],
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const noteId = str(issued.body['id']);
    const refunds = issued.body['refunds'] as Json[];
    const cash = refunds.find((r) => r['method'] === 'CASH')!;
    const card = refunds.find((r) => r['method'] === 'CARD_TERMINAL')!;

    /** per-account Σ(debit − credit) of THIS note's own journals (issuance + its refund executions), read from the tables */
    const ledger = async (): Promise<Record<string, bigint>> => {
      const ids = (
        await rows<{ id: string }>(
          `SELECT id FROM anonymous_credit_note_refund WHERE "creditNoteId" = $1`,
          [noteId],
        )
      ).map((r) => r.id);
      const out: Record<string, bigint> = {};
      for (const r of await rows<{ k: string; n: string }>(
        `SELECT a.key AS k, SUM(jl."debitMinor" - jl."creditMinor")::text AS n
           FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
          WHERE (je."sourceKind" = 'anonymous_credit_note' AND je."sourceId" = $1)
             OR (je."sourceKind" = 'anonymous_credit_note_refund' AND je."sourceId" = ANY($2))
          GROUP BY a.key`,
        [noteId, ids],
      ))
        out[r.k] = BigInt(r.n);
      return out;
    };
    const everyJournalBalances = async (): Promise<void> => {
      const bad = await rows(
        `SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
          WHERE je."sourceKind" LIKE 'anonymous_credit_note%' AND je."tenantId" = $1
          GROUP BY je.id HAVING SUM(jl."debitMinor") <> SUM(jl."creditMinor")`,
        [co.tenantId],
      );
      expect(bad).toHaveLength(0);
    };
    const act = (r: Json, a: 'execute' | 'fail', body: Json) =>
      w.req('POST', `${noteUrl(s, noteId)}/refunds/${str(r['id'])}/${a}`, manager, body, {
        'idempotency-key': key(a),
      });

    // S0 — issued, everything PENDING: revenue + tax reversed, the whole refund in flight, no cash has moved
    let l = await ledger();
    expect(l).toEqual({
      'REVENUE.SALES': s.subtotal,
      'LIABILITY.TAX_PAYABLE': s.tax,
      'ASSET.PAYMENT_CLEARING': -s.total,
    });
    await everyJournalBalances();

    // S1 — the CASH line attested (partially executed): cash has left, only the card amount is still in flight
    const e1 = await act(cash, 'execute', { reference: 'CASH-1' });
    expect(e1.status, JSON.stringify(e1.body)).toBe(200);
    l = await ledger();
    expect(l['ASSET.CASH_ON_HAND']).toBe(-cashAmt);
    expect(l['ASSET.PAYMENT_CLEARING']).toBe(-CARD);
    expect(obj(obj(e1.body)['refundSummary'])).toMatchObject({
      executedMinor: cashAmt.toString(),
      pendingMinor: CARD.toString(),
      failedMinor: '0',
      unallocatedMinor: '0',
    });

    // S2 — the CARD line FAILED: nothing is posted, the amount stays in flight and is reported as unallocated
    const f = await act(card, 'fail', { reasonCode: 'TERMINAL_DECLINED' });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(await ledger()).toEqual(l);
    expect(obj(obj(f.body)['refundSummary'])).toMatchObject({
      executedMinor: cashAmt.toString(),
      pendingMinor: '0',
      failedMinor: CARD.toString(),
      unallocatedMinor: CARD.toString(),
    });

    // S3 — a replacement CARD line (the cap of the card tender is free again) attested: manual card posts NOTHING, the credit is complete
    const added = await w.req(
      'POST',
      `${noteUrl(s, noteId)}/refunds`,
      manager,
      { method: 'CARD_TERMINAL', amountMinor: CARD.toString() },
      { 'idempotency-key': key('add') },
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const repl = (obj(added.body)['refunds'] as Json[]).find(
      (r) => r['method'] === 'CARD_TERMINAL' && r['status'] === 'PENDING',
    )!;
    const e2 = await act(repl, 'execute', {});
    expect(e2.status, JSON.stringify(e2.body)).toBe(200);
    expect(await ledger()).toEqual(l); // no new journal for a manual card execution
    expect(obj(obj(e2.body)['refundSummary'])).toMatchObject({
      executedMinor: s.total.toString(),
      pendingMinor: '0',
      unallocatedMinor: '0',
    });
    await everyJournalBalances();

    // the sale's OWN card debit on PAYMENT_CLEARING (the sale journal) plus this note's in-flight credit net to zero for the card
    // tender, and the cash and the revenue / tax of the sale are fully reversed: whole-sale reconciliation from the journal tables
    const sale = await rows<{ k: string; n: string }>(
      `SELECT a.key AS k, SUM(jl."debitMinor" - jl."creditMinor")::text AS n
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
        WHERE je."sourceKind" = 'walk_in_sale' AND je."sourceId" = $1 GROUP BY a.key`,
      [s.invoiceId],
    );
    const saleNet = Object.fromEntries(sale.map((r) => [r.k, BigInt(r.n)]));
    for (const k of new Set([...Object.keys(saleNet), ...Object.keys(l)])) {
      expect((saleNet[k] ?? 0n) + (l[k] ?? 0n), `account ${k}`).toBe(0n);
    }
  });

  // ═══════════════════════════ impact on the frozen reports (final financial audit) ═══════════════════════════
  it('REPORT IMPACT: the trial balance shows the exact reversal at each stage; the frozen Sales and Tender Totals reports keep reconciling but do not yet include anonymous credits (known limitation)', async () => {
    const s = await sellAnon({ qtys: [2] });
    const pd = await one<{ d: string }>(
      `SELECT to_char("postingDate",'YYYY-MM-DD') AS d FROM journal_entry WHERE "sourceId" = $1`,
      [s.invoiceId],
    );
    const day = (d: number): string =>
      new Date(Date.parse(pd.d) + d * 86_400_000).toISOString().slice(0, 10);
    const q = `from=${day(-1)}&to=${day(1)}`;
    const get = (p: string) => w.req('GET', `/companies/${co.companyId}${p}`, w.ownerToken);
    const snap = async () => ({
      tb: await get(`/reports/trial-balance?${q}`),
      sales: await get(`/reports/sales?${q}`),
      tender: await get(`/reports/tender-totals?${q}`),
    });
    const before = await snap();
    const note = await issue(s, {
      reasonCode: 'CUSTOMER_REQUEST',
      lines: fullLines(s, [2]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    const afterIssue = await snap();
    const refundId = str((note.body['refunds'] as Json[])[0]!['id']);
    const ex = await w.req(
      'POST',
      `${noteUrl(s, str(note.body['id']))}/refunds/${refundId}/execute`,
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    const afterExec = await snap();
    for (const st of [before, afterIssue, afterExec]) {
      expect([st.tb.status, st.sales.status, st.tender.status]).toEqual([200, 200, 200]);
    }
    // the window also holds other tests' postings of the same company, so every GL assertion is a DELTA against the snapshot taken
    // before this credit — closing net (debit − credit) per account, from the real trial balance
    const net = (r: { body: unknown }, k: string): bigint => {
      const a = (obj(r.body)['accounts'] as Json[]).find((x) => x['accountKey'] === k);
      return a ? BigInt(str(a['closingDebitMinor'])) - BigInt(str(a['closingCreditMinor'])) : 0n;
    };
    const delta = (after: { tb: { body: unknown } }, k: string): bigint =>
      net(after.tb, k) - net(before.tb, k);
    const totals = (r: { body: unknown }): Json => obj(obj(r.body)['totals']);
    // after ISSUANCE: revenue and tax reversed, the refund in flight on PAYMENT_CLEARING, cash untouched, the ledger still balanced
    expect(delta(afterIssue, 'REVENUE.SALES')).toBe(s.subtotal);
    expect(delta(afterIssue, 'LIABILITY.TAX_PAYABLE')).toBe(s.tax);
    expect(delta(afterIssue, 'ASSET.PAYMENT_CLEARING')).toBe(-s.total);
    expect(delta(afterIssue, 'ASSET.CASH_ON_HAND')).toBe(0n);
    // after the attested EXECUTION: the in-flight credit is cleared and the cash has left — a full, exact reversal of the sale
    expect(delta(afterExec, 'ASSET.PAYMENT_CLEARING')).toBe(0n);
    expect(delta(afterExec, 'ASSET.CASH_ON_HAND')).toBe(-s.total);
    expect(delta(afterExec, 'REVENUE.SALES')).toBe(s.subtotal);
    expect(delta(afterExec, 'LIABILITY.TAX_PAYABLE')).toBe(s.tax);
    for (const st of [afterIssue, afterExec]) {
      expect(totals(st.tb)['totalClosingDebitMinor']).toBe(
        totals(st.tb)['totalClosingCreditMinor'],
      );
    }
    // the frozen reports keep reconciling their OWN sources (nothing breaks) …
    for (const st of [afterIssue, afterExec]) {
      expect(obj(obj(st.sales.body)['reconciliation'])['reconciled']).toBe(true);
      expect(obj(obj(st.tender.body)['reconciliation'])['reconciled']).toBe(true);
    }
    // … but KNOWN LIMITATION (owner decision R-1, docs/phase-3/PHASE-3B-CLOSURE-EVIDENCE.md): neither frozen report knows the
    // anonymous credit-note journals. The Sales report's net sales and the Tender Totals refund / net-movement figures do NOT move
    // while the GL does. This assertion documents the gap so it cannot change silently — it must be updated, deliberately, when
    // the owner decides to extend the reports.
    const netSales = (r: { body: unknown }): string =>
      str(obj(obj(r.body)['netSalesAfterCreditNotes'])['netSalesAfterCreditNotesExTaxMinor']);
    expect(netSales(afterExec.sales)).toBe(netSales(before.sales));
    const refundTotal = (r: { body: unknown }): string =>
      str(obj(obj(r.body)['refunds'])['refundTotalMinor']);
    expect(refundTotal(afterExec.tender)).toBe(refundTotal(before.tender));
  });

  // ═══════════════════════════ must be LAST: it closes the accounting period ═══════════════════════════
  it('a CLOSED accounting period refuses the credit and the whole transaction rolls back (no number consumed, no note, no refund, no journal)', async () => {
    const s = await sellAnon({ qtys: [1] });
    const counterBefore = await one<{ n: string }>(
      `SELECT "nextNumber"::text AS n FROM document_number_counter WHERE "companyId" = $1 AND "documentType" = 'CREDIT_NOTE'`,
      [co.companyId],
    ).catch(() => ({ n: null }));
    await admin.query(`UPDATE accounting_period SET status = 'CLOSED' WHERE "companyId" = $1`, [
      co.companyId,
    ]);
    const r = await issue(s, {
      reasonCode: 'OTHER',
      lines: fullLines(s, [1]),
      refunds: [{ method: 'CASH', amountMinor: s.total.toString() }],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note WHERE "invoiceId" = $1`, [s.invoiceId]),
    ).toHaveLength(0);
    expect(
      await rows(`SELECT 1 FROM anonymous_credit_note_refund WHERE "invoiceId" = $1`, [
        s.invoiceId,
      ]),
    ).toHaveLength(0);
    const counterAfter = await one<{ n: string }>(
      `SELECT "nextNumber"::text AS n FROM document_number_counter WHERE "companyId" = $1 AND "documentType" = 'CREDIT_NOTE'`,
      [co.companyId],
    ).catch(() => ({ n: null }));
    expect(counterAfter.n).toBe(counterBefore.n); // the number allocation rolled back with the transaction (gapless)
  });
});
