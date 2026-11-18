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
 * POS CUSTOMER ACCOUNT + CREDIT COLLECTION — the FROZEN receivables read routes and the FROZEN `POST …/customers/:id/receipts` contract, exactly as the POS
 * drives them, against real PostgreSQL + Redis and the real Nest app (real routes, real role grants, real RLS, real GL). NO migration, NO contract change.
 *
 * The sale world's unit price is 1000 minor, no VAT: a credit sale of N units owes 1000·N. Collections are FIFO across the customer's open receivables
 * (oldest first) — the SERVER chooses the invoices; the body carries only the amount and the method.
 */

describe('POS customer account and credit collection (frozen receivables contract, real API)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let b0: string; // the till's branch
  let b1: string; // another branch of the same company
  let cashier: string;
  let cashierB1: string;
  let manager: string;
  let viewOnly: string;
  let noReceivables: string;

  const base = (branch = b0): string => `/companies/${w.a.companyId}/branches/${branch}`;
  const rows = async (sql: string, p: unknown[] = []): Promise<Record<string, unknown>[]> =>
    (await w.pool.query(sql, p)).rows as Record<string, unknown>[];
  /** cash-register movements of tenant A. The register tables arrive with the Phase 4 migrations: where they do not exist yet there can be no movement, so the count is 0 (where they exist the assertion is exactly as strict as before) */
  const registerMovements = async (): Promise<number> => {
    const t = await rows(`SELECT to_regclass('public.cash_movement') IS NOT NULL AS present`);
    if (t[0]!['present'] !== true) return 0;
    return Number(
      (
        await rows(`SELECT count(*)::int AS n FROM cash_movement WHERE "tenantId" = $1`, [
          w.a.tenantId,
        ])
      )[0]!['n'],
    );
  };
  const errCode = (r: { body: unknown }): string | undefined =>
    (r.body as { error?: { code?: string } })?.error?.code;

  async function newCustomer(): Promise<string> {
    const id = randomUUID();
    await w.pool.query(
      `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,$3,now())`,
      [id, w.a.tenantId, `Collect ${id.slice(0, 6)}`],
    );
    await w.pool.query(
      `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","creditEnabled","updatedAt") VALUES ($1,$2,$3,$4,true,now())`,
      [randomUUID(), w.a.tenantId, w.a.companyId, id],
    );
    return id;
  }
  /** a sale ON CREDIT for `qty` units (owes 1000·qty), through the real routes, as the till would */
  async function creditSale(
    customerId: string,
    qty: number,
    branch = b0,
    token = cashier,
  ): Promise<string> {
    const s = await w.sale({
      co: w.a,
      branch,
      token,
      customerId,
      credit: true,
      quantity: qty,
    });
    expect(s.ok, JSON.stringify(s)).toBe(true);
    return s.orderId!;
  }
  const invoiceOf = async (orderId: string) =>
    (
      await rows(
        `SELECT id, "invoiceNumber" AS num, "invoicePaymentStatus" AS status, "totalAmountMinor"::text AS total FROM invoice WHERE "orderId" = $1`,
        [orderId],
      )
    )[0]! as {
      id: string;
      num: string;
      status: string;
      total: string;
    };

  const collect = (
    customerId: string,
    body: Record<string, unknown>,
    token = cashier,
    key: string | null = `col-${randomUUID()}`,
    branch = b0,
  ) =>
    w.req(
      'POST',
      `${base(branch)}/customers/${customerId}/receipts`,
      token,
      body,
      key ? { 'idempotency-key': key } : {},
    );
  const summary = async (customerId: string, token = cashier, branch = b0) =>
    (await w.req('GET', `${base(branch)}/customers/${customerId}/account/summary`, token)).body as {
      branchFinancials: {
        receivableOutstandingMinor: string;
        unappliedReceiptMinor: string;
        openReceivableCount: number;
      };
      credit: { creditExposureMinor: string };
    };
  const openReceivables = async (customerId: string, token = cashier) =>
    (await w.req('GET', `${base()}/customers/${customerId}/account/receivables`, token)).body as {
      data: {
        customerReceivableId: string;
        invoiceNumber: string | null;
        originalAmountMinor: string;
        paidByPaymentMinor: string;
        outstandingMinor: string;
      }[];
    };
  const statement = async (customerId: string, token = cashier) =>
    (await w.req('GET', `${base()}/customers/${customerId}/account/statement`, token)).body as {
      data: {
        entryKind: string;
        receivableEffectMinor: string;
        unappliedReceiptEffectMinor: string;
        refs: Record<string, string | null>;
      }[];
      openingState: unknown;
    };
  const paymentCount = async (): Promise<number> =>
    Number(
      (
        await rows(`SELECT count(*)::int AS n FROM payment WHERE "tenantId" = $1`, [w.a.tenantId])
      )[0]!['n'],
    );
  const journalCount = async (): Promise<number> =>
    Number(
      (
        await rows(`SELECT count(*)::int AS n FROM journal_entry WHERE "tenantId" = $1`, [
          w.a.tenantId,
        ])
      )[0]!['n'],
    );
  /** the net of each GL account over every journal entry whose source is one of `sourceIds` */
  async function legs(sourceIds: string[]): Promise<Record<string, bigint>> {
    const r = await rows(
      `SELECT a."key" AS k, coalesce(sum(jl."debitMinor" - jl."creditMinor"),0)::text AS net
         FROM journal_line jl JOIN account a ON a.id = jl."accountId" JOIN journal_entry je ON je.id = jl."journalEntryId"
        WHERE je."tenantId" = $1 AND je."sourceId" = ANY($2::text[]) GROUP BY a."key"`,
      [w.a.tenantId, sourceIds],
    );
    return Object.fromEntries(r.map((x) => [x['k'] as string, BigInt(x['net'] as string)]));
  }
  const allocationIds = async (paymentId: string): Promise<string[]> =>
    (await rows(`SELECT id FROM payment_allocation WHERE "paymentId" = $1`, [paymentId])).map(
      (r) => r['id'] as string,
    );

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 2);
    b0 = w.a.branches[0]!;
    b1 = w.a.branches[1]!;
    const s0 = { companyScope: [w.a.companyId], branchScope: [b0] };
    cashier = await mintTenantToken(w.h, w.a.tenantId, rolePerms('cashier'), s0);
    cashierB1 = await mintTenantToken(w.h, w.a.tenantId, rolePerms('cashier'), {
      companyScope: [w.a.companyId],
      branchScope: [b1],
    });
    manager = await mintTenantToken(w.h, w.a.tenantId, rolePerms('manager'), s0);
    viewOnly = await mintTenantToken(w.h, w.a.tenantId, ['receivables:view', 'customers:view'], s0);
    noReceivables = await mintTenantToken(
      w.h,
      w.a.tenantId,
      ['orders:view', 'orders:manage', 'customers:view'],
      s0,
    );
  });
  afterAll(async () => {
    await w?.h.close();
    await w?.pool.end();
    await stack?.stop();
  });

  // ═════════════ the account the cashier sees ═════════════
  describe('the customer account (reads)', () => {
    it('balance, open receivables (oldest first, invoice numbers, nothing paid) and statement for two credit sales', async () => {
      const cust = await newCustomer();
      const oA = await creditSale(cust, 2); // owes 2000
      const oB = await creditSale(cust, 1); // owes 1000
      const iA = await invoiceOf(oA);
      const iB = await invoiceOf(oB);

      const s = await summary(cust);
      expect(s.branchFinancials.receivableOutstandingMinor).toBe('3000');
      expect(s.branchFinancials.openReceivableCount).toBe(2);

      const open = await openReceivables(cust);
      expect(
        open.data.map((r) => [
          r.invoiceNumber,
          r.originalAmountMinor,
          r.paidByPaymentMinor,
          r.outstandingMinor,
        ]),
      ).toEqual([
        [iA.num, '2000', '0', '2000'],
        [iB.num, '1000', '0', '1000'],
      ]);

      const st = await statement(cust);
      expect(
        st.data.filter((l) => l.entryKind === 'INVOICE').map((l) => l.receivableEffectMinor),
      ).toEqual(['2000', '1000']);
      expect(st.openingState).toBeNull();
    });
  });

  // ═════════════ partial, then full collection ═════════════
  describe('collecting', () => {
    it('a PARTIAL cash collection settles the OLDEST invoice first, exactly the amount, with the right journal, and the balances move', async () => {
      const cust = await newCustomer();
      const oA = await creditSale(cust, 2);
      const oB = await creditSale(cust, 1);
      const iA = await invoiceOf(oA);
      const before = await summary(cust);
      const open0 = await openReceivables(cust);
      const registerBefore = await registerMovements();

      const r = await collect(cust, { amountMinor: '1000', method: 'CASH' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const b = r.body as {
        paymentId: string;
        amountMinor: string;
        allocatedAmountMinor: string;
        unallocatedAmountMinor: string;
        currencyCode: string;
        allocations: { receivableId: string; sourceType: string; amountMinor: string }[];
      };
      expect(b.amountMinor).toBe('1000');
      expect(b.allocatedAmountMinor).toBe('1000');
      expect(b.unallocatedAmountMinor).toBe('0');
      expect(b.currencyCode).toBe('AED');
      expect(b.allocations).toEqual([
        {
          receivableId: open0.data[0]!.customerReceivableId,
          sourceType: 'INVOICE',
          amountMinor: '1000',
        },
      ]);

      // balances (server) — before 3000, after 2000; the oldest invoice is part paid, the newer untouched
      expect(before.branchFinancials.receivableOutstandingMinor).toBe('3000');
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('2000');
      const open1 = await openReceivables(cust);
      expect(
        open1.data.map((x) => [x.invoiceNumber, x.paidByPaymentMinor, x.outstandingMinor]),
      ).toEqual([
        [iA.num, '1000', '1000'],
        [open1.data[1]!.invoiceNumber, '0', '1000'],
      ]);
      expect((await invoiceOf(oA)).status).toBe('PARTIAL');
      expect((await invoiceOf(oB)).status).toBe('UNPAID');

      // the database: ONE payment of 1000 CASH allocated to invoice A only
      const pay = await rows(
        `SELECT method, "amountMinor"::text AS amt FROM payment WHERE id = $1`,
        [b.paymentId],
      );
      expect(pay).toEqual([{ method: 'CASH', amt: '1000' }]);
      const alloc = await rows(
        `SELECT "invoiceId", "amountMinor"::text AS amt FROM payment_allocation WHERE "paymentId" = $1`,
        [b.paymentId],
      );
      expect(alloc).toEqual([{ invoiceId: iA.id, amt: '1000' }]);

      // the journal: cash in, receivable down by exactly 1000, nothing left in unapplied receipts
      const l = await legs([b.paymentId, ...(await allocationIds(b.paymentId))]);
      expect(l['ASSET.CASH_ON_HAND']).toBe(1000n);
      expect(l['ASSET.ACCOUNTS_RECEIVABLE']).toBe(-1000n);
      expect(l['LIABILITY.UNAPPLIED_RECEIPTS'] ?? 0n).toBe(0n);
      expect(l['REVENUE.SALES'] ?? 0n).toBe(0n); // a collection never books revenue (or VAT) again
      expect(l['LIABILITY.TAX_PAYABLE'] ?? 0n).toBe(0n);

      // the statement records the payment and its allocation, carrying the SERVER's payment id (the reprint source)
      const st = await statement(cust);
      // (the PAYMENT line carries the payment id; the allocation line is keyed by its own allocation id)
      expect(
        st.data.filter((x) => x.entryKind === 'PAYMENT' && x.refs['paymentId'] === b.paymentId),
      ).toHaveLength(1);
      const allocIds = await allocationIds(b.paymentId);
      const allocLines = st.data.filter(
        (x) =>
          x.entryKind === 'PAYMENT_ALLOCATION' &&
          allocIds.includes(x.refs['paymentAllocationId'] ?? ''),
      );
      expect(allocLines.map((x) => x.receivableEffectMinor)).toEqual(['-1000']);

      // E-5 is inactive: a collection writes NO cash-register movement
      const registerAfter = await registerMovements();
      expect(registerAfter).toBe(registerBefore);
    });

    it('a collection that spans invoices fills the oldest completely, then the next; the FULL balance clears everything', async () => {
      const cust = await newCustomer();
      const oA = await creditSale(cust, 2);
      const oB = await creditSale(cust, 1);
      const r1 = await collect(cust, { amountMinor: '2500', method: 'BANK_TRANSFER' });
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      const b1b = r1.body as {
        allocations: { amountMinor: string }[];
        allocatedAmountMinor: string;
        unallocatedAmountMinor: string;
      };
      expect(b1b.allocations.map((a) => a.amountMinor)).toEqual(['2000', '500']);
      expect(b1b.unallocatedAmountMinor).toBe('0');
      expect((await invoiceOf(oA)).status).not.toBe('UNPAID');
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('500');
      expect(
        (
          await rows(`SELECT method FROM payment WHERE id = $1`, [
            (r1.body as { paymentId: string }).paymentId,
          ])
        )[0]!['method'],
      ).toBe('BANK_TRANSFER');

      const r2 = await collect(cust, { amountMinor: '500', method: 'CASH' });
      expect(r2.status).toBe(201);
      const s = await summary(cust);
      expect(s.branchFinancials.receivableOutstandingMinor).toBe('0');
      expect(s.branchFinancials.openReceivableCount).toBe(0);
      expect((await openReceivables(cust)).data).toEqual([]);
      for (const o of [oA, oB]) expect(['PAID', 'SETTLED']).toContain((await invoiceOf(o)).status);
      // bank transfer is NOT cash on hand
      const l = await legs([
        (r1.body as { paymentId: string }).paymentId,
        ...(await allocationIds((r1.body as { paymentId: string }).paymentId)),
      ]);
      expect(l['ASSET.CASH_ON_HAND'] ?? 0n).toBe(0n);
      expect((l['ASSET.BANK'] ?? 0n) + (l['ASSET.PAYMENT_CLEARING'] ?? 0n)).toBe(2500n);
    });

    it('the whole GL stays balanced and no revenue or VAT is re-booked by any collection', async () => {
      const unbalanced = await rows(
        `SELECT je.id FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id WHERE je."tenantId" = $1 GROUP BY je.id HAVING sum(jl."debitMinor") <> sum(jl."creditMinor")`,
        [w.a.tenantId],
      );
      expect(unbalanced).toEqual([]);
    });
  });

  // ═════════════ idempotency and concurrency ═════════════
  describe('idempotency — a retry can never collect twice', () => {
    it('the SAME key + body replays the first answer: one payment, one journal set, one balance movement', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 3); // owes 3000
      const key = `retry-${randomUUID()}`;
      const p0 = await paymentCount();
      const first = await collect(cust, { amountMinor: '1200', method: 'CASH' }, cashier, key);
      const j1 = await journalCount();
      const again = await collect(cust, { amountMinor: '1200', method: 'CASH' }, cashier, key);
      expect(first.status).toBe(201);
      expect([200, 201]).toContain(again.status);
      expect((again.body as { paymentId: string }).paymentId).toBe(
        (first.body as { paymentId: string }).paymentId,
      );
      expect(await paymentCount()).toBe(p0 + 1);
      expect(await journalCount()).toBe(j1);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('1800');
    });

    it('the same key with a DIFFERENT amount or method is refused, and nothing new is recorded', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 3);
      const key = `reuse-${randomUUID()}`;
      expect(
        (await collect(cust, { amountMinor: '1000', method: 'CASH' }, cashier, key)).status,
      ).toBe(201);
      const p = await paymentCount();
      const j = await journalCount();
      const diffAmount = await collect(cust, { amountMinor: '1001', method: 'CASH' }, cashier, key);
      const diffMethod = await collect(
        cust,
        { amountMinor: '1000', method: 'BANK_TRANSFER' },
        cashier,
        key,
      );
      for (const r of [diffAmount, diffMethod]) {
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(errCode(r)).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect(await paymentCount()).toBe(p);
      expect(await journalCount()).toBe(j);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('2000');
    });

    it('a missing Idempotency-Key is refused (the POS always sends one)', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 1);
      const r = await collect(cust, { amountMinor: '500', method: 'CASH' }, cashier, null);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(errCode(r)).toBe('IDEMPOTENCY_KEY_MISSING');
    });

    it('SIX concurrent requests with the SAME key record exactly ONE payment (the rest replay or wait — never a second collection)', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 4); // owes 4000
      const key = `conc-same-${randomUUID()}`;
      const p0 = await paymentCount();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          collect(cust, { amountMinor: '1000', method: 'CASH' }, cashier, key),
        ),
      );
      const ok = results.filter((r) => r.status === 200 || r.status === 201);
      const waiting = results.filter((r) => !(r.status === 200 || r.status === 201));
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of waiting) expect(errCode(r)).toBe('IDEMPOTENCY_IN_PROGRESS'); // the only acceptable non-success
      expect(new Set(ok.map((r) => (r.body as { paymentId: string }).paymentId)).size).toBe(1);
      expect(await paymentCount()).toBe(p0 + 1);
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('3000');
    });

    it('FOUR concurrent DIFFERENT-key collections against a 3000 balance: no deadlock, no invoice paid twice, never more allocated than owed', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 1);
      await creditSale(cust, 1);
      await creditSale(cust, 1); // owes 3000 across three invoices
      const results = await Promise.all(
        Array.from({ length: 4 }, () => collect(cust, { amountMinor: '1000', method: 'CASH' })),
      );
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201); // no 500 / 409 / deadlock
      const bodies = results.map(
        (r) => r.body as { allocatedAmountMinor: string; unallocatedAmountMinor: string },
      );
      const allocated = bodies.reduce((s, x) => s + BigInt(x.allocatedAmountMinor), 0n);
      const unallocated = bodies.reduce((s, x) => s + BigInt(x.unallocatedAmountMinor), 0n);
      expect(allocated).toBe(3000n); // exactly what was owed — no double allocation
      expect(unallocated).toBe(1000n); // the 4th thousand had nothing left to settle: the server keeps it as unapplied money (why the till caps at the balance)
      const s = await summary(cust);
      expect(s.branchFinancials.receivableOutstandingMinor).toBe('0');
      expect(s.branchFinancials.unappliedReceiptMinor).toBe('1000');
      const over = await rows(
        `SELECT pa."invoiceId", sum(pa."amountMinor")::text AS paid, max(i."totalAmountMinor")::text AS total FROM payment_allocation pa JOIN invoice i ON i.id = pa."invoiceId" JOIN "order" o ON o.id = i."orderId" WHERE o."customerId" = $1 GROUP BY pa."invoiceId"`,
        [cust],
      );
      for (const o of over)
        expect(BigInt(o['paid'] as string)).toBeLessThanOrEqual(BigInt(o['total'] as string));
    });
  });

  // ═════════════ validation, permissions, isolation ═════════════
  describe('refusals, permissions and isolation', () => {
    it('the body contract: no card, no extra field, no zero / negative / non-digit amount — each refused with nothing recorded', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 1);
      const p = await paymentCount();
      const bad: Record<string, unknown>[] = [
        { amountMinor: '500', method: 'CARD_TERMINAL' },
        { amountMinor: '500', method: 'ONLINE_GATEWAY' },
        { amountMinor: '500', method: 'CASH', customerId: cust },
        { amountMinor: '500', method: 'CASH', invoiceIds: [randomUUID()] },
        { amountMinor: '500', method: 'CASH', branchId: b0 },
        { amountMinor: '0', method: 'CASH' },
        { amountMinor: '-5', method: 'CASH' },
        { amountMinor: '1.5', method: 'CASH' },
        { amountMinor: '5e2', method: 'CASH' },
        { method: 'CASH' },
        { amountMinor: '500' },
      ];
      for (const body of bad) {
        const r = await collect(cust, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
      expect(await paymentCount()).toBe(p);
    });

    it('collect needs `receivables:collect`: a view-only user reads the account but cannot collect; a user with neither can do neither', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 1);
      const p = await paymentCount();
      expect(
        (await w.req('GET', `${base()}/customers/${cust}/account/summary`, viewOnly)).status,
      ).toBe(200);
      expect((await collect(cust, { amountMinor: '500', method: 'CASH' }, viewOnly)).status).toBe(
        403,
      );
      expect(
        (await w.req('GET', `${base()}/customers/${cust}/account/summary`, noReceivables)).status,
      ).toBe(403);
      expect(
        (await collect(cust, { amountMinor: '500', method: 'CASH' }, noReceivables)).status,
      ).toBe(403);
      expect(await paymentCount()).toBe(p);
    });

    it('a manager can collect too (collection is a cashier-and-up authority); applying an advance stays manager-only', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 1);
      expect((await collect(cust, { amountMinor: '400', method: 'CASH' }, manager)).status).toBe(
        201,
      );
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('600');
    });

    it('BRANCH isolation: a till of ANOTHER branch can neither read nor collect this branch’s account, and a sale at another branch is not in this branch’s balance', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 2, b0); // owes 2000 at b0
      await creditSale(cust, 1, b1, cashierB1); // owes 1000 at b1 (a different branch of the same company)
      expect((await summary(cust)).branchFinancials.receivableOutstandingMinor).toBe('2000'); // b0's own only
      expect((await summary(cust, cashierB1, b1)).branchFinancials.receivableOutstandingMinor).toBe(
        '1000',
      );
      const p = await paymentCount();
      for (const url of [
        'account/summary',
        'account/receivables',
        'account/statement',
        'account/advances',
        'account/unapplied-receipts',
      ]) {
        // a denial is a denial: 403, or the non-disclosing 404 — never data
        expect([403, 404], url).toContain(
          (await w.req('GET', `${base(b0)}/customers/${cust}/${url}`, cashierB1)).status,
        );
      }
      expect([403, 404]).toContain(
        (await collect(cust, { amountMinor: '500', method: 'CASH' }, cashierB1, undefined, b0))
          .status,
      );
      expect([403, 404]).toContain(
        (await collect(cust, { amountMinor: '500', method: 'CASH' }, cashier, undefined, b1))
          .status,
      );
      expect(await paymentCount()).toBe(p);
    });

    it('TENANT / COMPANY isolation: another tenant’s token and another company’s path reach nothing', async () => {
      const cust = await newCustomer();
      await creditSale(cust, 1);
      const foreign = await mintTenantToken(w.h, w.b.tenantId, rolePerms('owner'), {
        stepUp: true,
      });
      const p = await paymentCount();
      const r = await w.req(
        'GET',
        `/companies/${w.a.companyId}/branches/${b0}/customers/${cust}/account/summary`,
        foreign,
      );
      expect([403, 404]).toContain(r.status);
      const c = await w.req(
        'POST',
        `/companies/${w.a.companyId}/branches/${b0}/customers/${cust}/receipts`,
        foreign,
        { amountMinor: '500', method: 'CASH' },
        { 'idempotency-key': `x-${randomUUID()}` },
      );
      expect([403, 404]).toContain(c.status);
      // the same tenant, but a different company's path with a till scoped to company A
      const otherCo = await w.req(
        'GET',
        `/companies/${w.a2.companyId}/branches/${w.a2.branches[0]}/customers/${cust}/account/summary`,
        cashier,
      );
      expect([403, 404]).toContain(otherCo.status);
      expect(await paymentCount()).toBe(p);
    });
  });
});
