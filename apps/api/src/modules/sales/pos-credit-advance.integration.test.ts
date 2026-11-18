import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import {
  createSaleWorld,
  mintTenantToken,
  rolePerms,
  type SaleWorld,
} from '../../verification/load-sale-world.js';

/**
 * POS CUSTOMER CREDIT + ADVANCE PAYMENTS — the FROZEN `complete-sale` contract, exactly as the POS checkout dialog drives it, against real
 * PostgreSQL + Redis and the real Nest app (real routes, real role grants from SYSTEM_ROLE_TEMPLATES, real RLS, real GL).
 *
 * The request bodies below are the ones `planCustomerPayment` (apps/pos-pwa/src/lib/credit-plan.ts) builds — same keys, same canonical advance
 * order, minor-unit strings. (apps/api cannot import the POS package, so the true client → planner → server chain is the Playwright journey
 * `apps/pos-pwa/e2e/credit-advance.spec.ts`.) NO migration, NO frozen-contract change: this only exercises what already exists.
 *
 * Money in the sale world: unit price 1000 minor × 2 = 2000 AED minor, no tax.
 */

const TOTAL = 2_000n;

describe('POS customer credit and advance payments (frozen complete-sale contract, real API)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let branch: string;
  let cashier: string;
  let manager: string;
  let owner: string;
  // a customer per scenario so balances never bleed between tests
  let c: string[];

  const base = (): string => `/companies/${w.a.companyId}/branches/${branch}`;
  const rows = async (sql: string, p: unknown[] = []): Promise<Record<string, unknown>[]> =>
    (await w.pool.query(sql, p)).rows as Record<string, unknown>[];

  async function newCustomer(
    opts: { creditEnabled?: boolean; limit?: bigint } = {},
  ): Promise<string> {
    const customerId = randomUUID();
    await w.pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,$3,now())`,
      [customerId, w.a.tenantId, `POS credit ${customerId.slice(0, 6)}`],
    );
    await w.pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","creditEnabled","creditLimitMinor","creditLimitCurrencyCode","creditLimitCurrencyExponent","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [
        randomUUID(),
        w.a.tenantId,
        w.a.companyId,
        customerId,
        opts.creditEnabled ?? true,
        opts.limit === undefined ? null : opts.limit.toString(),
        opts.limit === undefined ? null : 'AED',
        opts.limit === undefined ? null : 2,
      ],
    );
    return customerId;
  }

  /** the POS's order step: a draft order for the customer (or anonymous) */
  async function draft(customerId: string | null, token = cashier, qty = 2) {
    const r = await w.req(
      'POST',
      `${base()}/orders`,
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
      { 'idempotency-key': `ord-${randomUUID()}` },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as { order: { id: string; version: number } }).order;
  }

  /** the POS's pay step; `If-Match` is the quoted order version, as the ApiClient sends it */
  function complete(
    order: { id: string; version: number },
    body: Record<string, unknown>,
    token = cashier,
    key = `sale-${randomUUID()}`,
  ) {
    return w.req('POST', `${base()}/orders/${order.id}/complete-sale`, token, body, {
      'if-match': `"${order.version}"`,
      'idempotency-key': key,
    });
  }

  const summary = async (customerId: string, token = cashier) =>
    (await w.req('GET', `${base()}/customers/${customerId}/account/summary`, token)).body as {
      branchFinancials: {
        receivableOutstandingMinor: string;
        advanceAvailableMinor: string;
        openReceivableCount: number;
        openAdvanceCount: number;
      };
      credit: {
        creditEnabled: boolean;
        creditLimitMinor: string | null;
        availableCreditMinor: string | null;
      };
    };
  const advancesOf = async (customerId: string, token = cashier) =>
    (await w.req('GET', `${base()}/customers/${customerId}/account/advances`, token)).body as {
      data: {
        customerAdvanceId: string;
        availableAmountMinor: string;
        originalAmountMinor: string;
      }[];
      nextCursor: string | null;
    };

  /** a customer advance made the real way: a cash receipt with nothing to settle, then an explicit conversion to an advance (manager authority) */
  async function giveAdvance(customerId: string, amount: bigint): Promise<string> {
    const rec = await w.req(
      'POST',
      `${base()}/customers/${customerId}/receipts`,
      manager,
      { amountMinor: amount.toString(), method: 'CASH' },
      { 'idempotency-key': `rcpt-${randomUUID()}` },
    );
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const conv = await w.req(
      'POST',
      `${base()}/customers/${customerId}/advances/from-payment`,
      manager,
      { paymentId: (rec.body as { paymentId: string }).paymentId, amountMinor: amount.toString() },
      { 'idempotency-key': `conv-${randomUUID()}` },
    );
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    return (conv.body as { advanceId: string }).advanceId;
  }

  const errCode = (r: { body: unknown }): string | undefined =>
    (r.body as { error?: { code?: string } })?.error?.code;
  const invoiceCount = async (orderId: string): Promise<number> =>
    Number(
      (await rows(`SELECT count(*)::int AS n FROM invoice WHERE "orderId" = $1`, [orderId]))[0]![
        'n'
      ],
    );

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 2);
    branch = w.a.branches[0]!;
    const scope = { companyScope: [w.a.companyId], branchScope: [branch] };
    cashier = await mintTenantToken(w.h, w.a.tenantId, rolePerms('cashier'), scope);
    manager = await mintTenantToken(w.h, w.a.tenantId, rolePerms('manager'), scope);
    owner = w.ownerToken; // step-up session, all scope
    c = [];
    for (let i = 0; i < 12; i++) c.push(await newCustomer());
  });
  afterAll(async () => {
    await w?.h.close();
    await w?.pool.end();
    await stack?.stop();
  });

  // ═══════════════ ON CREDIT ═══════════════
  describe('sell on credit', () => {
    it('a cashier sells the whole order ON_CREDIT: the customer owes the total, no tender, invoice unpaid, balance visible', async () => {
      const cust = c[0]!;
      const before = await summary(cust);
      expect(before.branchFinancials.receivableOutstandingMinor).toBe('0');
      const order = await draft(cust);
      const r = await complete(order, { paymentIntent: 'ON_CREDIT', tenders: [] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = r.body as {
        paymentIntent: string;
        outstandingMinor: string;
        payments: unknown[];
        advanceApplications: unknown[];
        customerReceivableId: string | null;
        invoice: { totalAmountMinor: string; paymentStatus: string };
      };
      expect(b.paymentIntent).toBe('ON_CREDIT');
      expect(b.invoice.totalAmountMinor).toBe(TOTAL.toString());
      expect(b.outstandingMinor).toBe(TOTAL.toString());
      expect(b.payments).toEqual([]);
      expect(b.advanceApplications).toEqual([]);
      expect(b.customerReceivableId).not.toBeNull();
      expect(b.invoice.paymentStatus).not.toBe('PAID');
      const after = await summary(cust);
      expect(after.branchFinancials.receivableOutstandingMinor).toBe('2000');
      expect(after.branchFinancials.openReceivableCount).toBe(1);
    });

    it('a deposit now and the rest on credit: the receivable is the remainder, the deposit is a real cash payment', async () => {
      const cust = c[1]!;
      const order = await draft(cust);
      const r = await complete(order, {
        paymentIntent: 'ON_CREDIT',
        tenders: [{ method: 'CASH', amountMinor: '500' }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = r.body as {
        outstandingMinor: string;
        payments: { method: string; amountMinor: string }[];
      };
      expect(b.outstandingMinor).toBe('1500');
      expect(b.payments.map((p) => [p.method, p.amountMinor])).toEqual([['CASH', '500']]);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('1500');
    });

    it('the GL stays balanced and the credit sale is a receivable, never cash: one invoice, receivable = total − deposit', async () => {
      const cust = c[2]!;
      const order = await draft(cust);
      const r = await complete(order, {
        paymentIntent: 'ON_CREDIT',
        tenders: [{ method: 'CASH', amountMinor: '700' }],
      });
      expect(r.status).toBe(200);
      expect(await invoiceCount(order.id)).toBe(1);
      const unbalanced = await rows(
        `SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id
          WHERE je."tenantId" = $1 GROUP BY je.id
         HAVING sum(jl."debitMinor") <> sum(jl."creditMinor")`,
        [w.a.tenantId],
      );
      expect(unbalanced).toEqual([]);
    });
  });

  // ═══════════════ REFUSALS ═══════════════
  describe('refusals — the server decides', () => {
    it('ON_CREDIT with no customer on the order is refused and nothing is recorded', async () => {
      const order = await draft(null);
      const r = await complete(order, { paymentIntent: 'ON_CREDIT', tenders: [] });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(errCode(r)).toBeTruthy();
      expect(await invoiceCount(order.id)).toBe(0);
    });

    it('credit not enabled for the customer: CUSTOMER_CREDIT_DISABLED, no invoice', async () => {
      const cust = await newCustomer({ creditEnabled: false });
      const order = await draft(cust);
      const r = await complete(order, { paymentIntent: 'ON_CREDIT', tenders: [] });
      expect(errCode(r)).toBe('CUSTOMER_CREDIT_DISABLED');
      expect(await invoiceCount(order.id)).toBe(0);
    });

    it('over the credit limit: CUSTOMER_CREDIT_LIMIT_EXCEEDED for a cashier; a reason alone authorises nothing', async () => {
      const cust = await newCustomer({ limit: 1_000n });
      const order = await draft(cust);
      const refused = await complete(order, { paymentIntent: 'ON_CREDIT', tenders: [] });
      expect(errCode(refused)).toBe('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
      const withReason = await complete(order, {
        paymentIntent: 'ON_CREDIT',
        tenders: [],
        creditLimitExceptionReason: 'regular customer',
      });
      // the cashier cannot grant an exception (owner permission + step-up): a reason is only a reason
      expect(withReason.status).toBeGreaterThanOrEqual(400);
      expect(['CREDIT_OVERRIDE_DENIED', 'FORBIDDEN', 'STEP_UP_REQUIRED']).toContain(
        errCode(withReason),
      );
      expect(await invoiceCount(order.id)).toBe(0);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('0');
    });

    it('an owner with step-up CAN grant the exception for the same sale, with a reason (and it is audited)', async () => {
      const cust = await newCustomer({ limit: 1_000n });
      const order = await draft(cust);
      const r = await complete(
        order,
        {
          paymentIntent: 'ON_CREDIT',
          tenders: [],
          creditLimitExceptionReason: 'wedding order, approved by owner',
        },
        owner,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('2000');
      const audit = await rows(
        `SELECT count(*)::int AS n FROM audit_log WHERE "tenantId" = $1 AND action = 'credit_limit.override_used'`,
        [w.a.tenantId],
      );
      expect(Number(audit[0]!['n'])).toBeGreaterThanOrEqual(1);
    });

    it('an advance + deposit that cover the whole total cannot also go ON_CREDIT: SALE_ON_CREDIT_FULLY_COVERED', async () => {
      const cust = c[3]!;
      const adv = await giveAdvance(cust, 5_000n);
      const order = await draft(cust);
      const r = await complete(
        order,
        {
          paymentIntent: 'ON_CREDIT',
          tenders: [],
          advanceApplications: [{ advanceId: adv, amountMinor: '2000' }],
        },
        manager,
      );
      expect(errCode(r)).toBe('SALE_ON_CREDIT_FULLY_COVERED');
      expect(await invoiceCount(order.id)).toBe(0);
      // nothing was spent
      expect((await advancesOf(cust)).data[0]!.availableAmountMinor).toBe('5000');
    });

    it('unknown / foreign fields are refused (the strict DTO): the POS can never smuggle scope or a customer', async () => {
      const order = await draft(c[4]!);
      for (const extra of [
        { customerId: c[5]! },
        { tenantId: w.a.tenantId },
        { branchId: branch },
        { creditOverride: true },
      ]) {
        const r = await complete(order, { paymentIntent: 'ON_CREDIT', tenders: [], ...extra });
        expect(r.status).toBe(400);
      }
      expect(await invoiceCount(order.id)).toBe(0);
    });
  });

  // ═══════════════ ADVANCES ═══════════════
  describe('advances', () => {
    it('the cashier can SEE the customer’s advance (receivables:view) — the POS shows it', async () => {
      const cust = c[6]!;
      const adv = await giveAdvance(cust, 3_000n);
      const s = await summary(cust, cashier);
      expect(s.branchFinancials.advanceAvailableMinor).toBe('3000');
      expect(s.branchFinancials.openAdvanceCount).toBe(1);
      const list = await advancesOf(cust, cashier);
      expect(list.data.map((a) => [a.customerAdvanceId, a.availableAmountMinor])).toEqual([
        [adv, '3000'],
      ]);
    });

    it('applying an advance is NOT a cashier authority: 403, nothing spent, no invoice (a manager must apply it)', async () => {
      const cust = c[6]!;
      const adv = (await advancesOf(cust)).data[0]!.customerAdvanceId;
      const order = await draft(cust);
      const r = await complete(order, {
        paymentIntent: 'PAY_NOW',
        tenders: [{ method: 'CASH', amountMinor: '1500' }],
        advanceApplications: [{ advanceId: adv, amountMinor: '500' }],
      });
      expect(r.status).toBe(403);
      expect(await invoiceCount(order.id)).toBe(0);
      expect((await summary(cust)).branchFinancials.advanceAvailableMinor).toBe('3000');
    });

    it('a manager spends part of the advance + cash for the rest: PAY_NOW, the advance balance drops by exactly what was applied', async () => {
      const cust = c[6]!;
      const adv = (await advancesOf(cust)).data[0]!.customerAdvanceId;
      const order = await draft(cust, manager);
      const r = await complete(
        order,
        {
          paymentIntent: 'PAY_NOW',
          tenders: [{ method: 'CASH', amountMinor: '500' }],
          advanceApplications: [{ advanceId: adv, amountMinor: '1500' }],
        },
        manager,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = r.body as {
        outstandingMinor: string;
        invoice: { paymentStatus: string };
        advanceApplications: { advanceId: string; amountMinor: string }[];
        payments: { amountMinor: string }[];
      };
      expect(b.outstandingMinor).toBe('0');
      expect(b.invoice.paymentStatus).toBe('SETTLED'); // fully paid and settled (the POS receipt shows this as PAID)
      expect(b.advanceApplications.map((a) => [a.advanceId, a.amountMinor])).toEqual([
        [adv, '1500'],
      ]);
      expect(b.payments.map((p) => p.amountMinor)).toEqual(['500']);
      const s = await summary(cust);
      expect(s.branchFinancials.advanceAvailableMinor).toBe('1500');
      expect(s.branchFinancials.receivableOutstandingMinor).toBe('0');
    });

    it('an advance that covers the WHOLE sale: an advance-only PAY_NOW with no tender', async () => {
      const cust = c[7]!;
      const adv = await giveAdvance(cust, 2_500n);
      const order = await draft(cust, manager);
      const r = await complete(
        order,
        {
          paymentIntent: 'PAY_NOW',
          tenders: [],
          advanceApplications: [{ advanceId: adv, amountMinor: '2000' }],
        },
        manager,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((r.body as { payments: unknown[] }).payments).toEqual([]);
      expect((await summary(cust)).branchFinancials.advanceAvailableMinor).toBe('500');
    });

    it('advance + deposit + the rest ON_CREDIT: the three parts add up exactly to the total', async () => {
      const cust = c[8]!;
      const adv = await giveAdvance(cust, 600n);
      const order = await draft(cust, manager);
      const r = await complete(
        order,
        {
          paymentIntent: 'ON_CREDIT',
          tenders: [{ method: 'CASH', amountMinor: '400' }],
          advanceApplications: [{ advanceId: adv, amountMinor: '600' }],
        },
        manager,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const b = r.body as { outstandingMinor: string };
      expect(b.outstandingMinor).toBe('1000'); // 2000 − 600 advance − 400 cash
      const s = await summary(cust);
      expect(s.branchFinancials.receivableOutstandingMinor).toBe('1000');
      expect(s.branchFinancials.advanceAvailableMinor).toBe('0');
    });

    it('more than the advance holds, a repeated advance, and an advance on an anonymous order are all refused with nothing spent', async () => {
      const cust = c[9]!;
      const adv = await giveAdvance(cust, 800n);
      const o1 = await draft(cust, manager);
      const over = await complete(
        o1,
        {
          paymentIntent: 'PAY_NOW',
          tenders: [{ method: 'CASH', amountMinor: '1100' }],
          advanceApplications: [{ advanceId: adv, amountMinor: '900' }],
        },
        manager,
      );
      expect(over.status).toBeGreaterThanOrEqual(400);
      const dup = await complete(
        o1,
        {
          paymentIntent: 'PAY_NOW',
          tenders: [{ method: 'CASH', amountMinor: '1000' }],
          advanceApplications: [
            { advanceId: adv, amountMinor: '500' },
            { advanceId: adv, amountMinor: '500' },
          ],
        },
        manager,
      );
      expect(errCode(dup)).toBe('SALE_DUPLICATE_ADVANCE');
      const anon = await draft(null, manager);
      const onAnon = await complete(
        anon,
        {
          paymentIntent: 'PAY_NOW',
          tenders: [{ method: 'CASH', amountMinor: '1500' }],
          advanceApplications: [{ advanceId: adv, amountMinor: '500' }],
        },
        manager,
      );
      expect(onAnon.status).toBeGreaterThanOrEqual(400);
      expect(await invoiceCount(o1.id)).toBe(0);
      expect(await invoiceCount(anon.id)).toBe(0);
      expect((await advancesOf(cust)).data[0]!.availableAmountMinor).toBe('800');
    });
  });

  // ═══════════════ IDEMPOTENCY ═══════════════
  describe('idempotency — a retry can never sell twice', () => {
    it('the SAME request + key replays the first answer: one invoice, one receivable, one balance', async () => {
      const cust = c[10]!;
      const order = await draft(cust);
      const key = `retry-${randomUUID()}`;
      const body = {
        paymentIntent: 'ON_CREDIT',
        tenders: [{ method: 'CASH', amountMinor: '300' }],
      };
      const first = await complete(order, body, cashier, key);
      const second = await complete(order, body, cashier, key);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((second.body as { invoice: { id: string } }).invoice.id).toBe(
        (first.body as { invoice: { id: string } }).invoice.id,
      );
      expect(await invoiceCount(order.id)).toBe(1);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('1700');
      expect((await summary(cust)).branchFinancials.openReceivableCount).toBe(1);
    });

    it('the same key with a DIFFERENT body is refused (a changed payment needs a new key — the POS keys the exact payment)', async () => {
      const cust = c[11]!;
      const order = await draft(cust);
      const key = `reuse-${randomUUID()}`;
      const a = await complete(
        order,
        { paymentIntent: 'ON_CREDIT', tenders: [{ method: 'CASH', amountMinor: '300' }] },
        cashier,
        key,
      );
      expect(a.status).toBe(200);
      const b = await complete(
        order,
        { paymentIntent: 'ON_CREDIT', tenders: [{ method: 'CASH', amountMinor: '400' }] },
        cashier,
        key,
      );
      expect(b.status).toBeGreaterThanOrEqual(400);
      expect(await invoiceCount(order.id)).toBe(1);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('1700');
    });

    it('an advance sale replayed with the same key spends the advance ONCE', async () => {
      const cust = await newCustomer();
      const adv = await giveAdvance(cust, 1_000n);
      const order = await draft(cust, manager);
      const key = `adv-retry-${randomUUID()}`;
      const body = {
        paymentIntent: 'PAY_NOW',
        tenders: [{ method: 'CASH', amountMinor: '1000' }],
        advanceApplications: [{ advanceId: adv, amountMinor: '1000' }],
      };
      const first = await complete(order, body, manager, key);
      const second = await complete(order, body, manager, key);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(second.status).toBe(200);
      expect((await summary(cust)).branchFinancials.advanceAvailableMinor).toBe('0');
      expect(await invoiceCount(order.id)).toBe(1);
    });
  });
});
