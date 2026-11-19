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
 * OWNER WEB CUSTOMER CREDIT MANAGEMENT — the FROZEN customer credit PATCH, the customer account read and the FROZEN current-receivables report, exactly as
 * Owner Web drives them, against real PostgreSQL + Redis and the real Nest app (real routes, real role grants, real RLS, real GL). NO migration, NO
 * contract change. The point of this suite is the COMPOSITION the Owner Web screens rely on: set credit → the till honours it → the report shows the debt.
 *
 * The sale world's unit price is 1000 minor, no VAT: a credit sale of N units owes 1000·N.
 */

describe('Owner Web customer credit management (frozen customer + receivables contracts, real API)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let b0: string;
  let b1: string;
  let cashier: string;
  let manager: string;
  let admin: string;
  let ownerNoStepUp: string;
  let ownerBranchB0: string; // all companies but only branch 0 (a branch-restricted reader)
  let foreignOwner: string; // an owner of ANOTHER tenant

  const acct = (companyId: string, customerId: string): string =>
    `/companies/${companyId}/customers/${customerId}/account`;
  const rows = async (sql: string, p: unknown[] = []): Promise<Record<string, unknown>[]> =>
    (await w.pool.query(sql, p)).rows as Record<string, unknown>[];
  const errCode = (r: { body: unknown }): string | undefined =>
    (r.body as { error?: { code?: string } })?.error?.code;

  /** the frozen credit PATCH (`w.req` has no PATCH verb, so this goes straight through the same app) */
  async function patchCredit(
    token: string,
    customerId: string,
    body: Record<string, unknown>,
    version: number | string | null,
    companyId = w.a.companyId,
  ) {
    const res = await w.h.app.inject({
      method: 'PATCH',
      url: `/v1${acct(companyId, customerId)}/credit`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(version === null ? {} : { 'if-match': `"${version}"` }),
      },
      payload: body,
    });
    let json: unknown;
    try {
      json = res.json();
    } catch {
      json = res.payload;
    }
    return { status: res.statusCode, body: json };
  }
  const account = async (customerId: string, token = w.ownerToken) =>
    (await w.req('GET', acct(w.a.companyId, customerId), token)).body as {
      id: string;
      creditEnabled: boolean;
      creditLimitMinor: string | null;
      creditLimitCurrencyCode: string | null;
      version: number;
    };
  const summary = async (customerId: string, token = w.ownerToken, branch = b0) =>
    (
      await w.req(
        'GET',
        `/companies/${w.a.companyId}/branches/${branch}/customers/${customerId}/account/summary`,
        token,
      )
    ).body as {
      branchFinancials: { receivableOutstandingMinor: string; openReceivableCount: number };
      credit: {
        scope: string;
        creditEnabled: boolean;
        creditLimitMinor: string | null;
        creditExposureMinor: string;
        availableCreditMinor: string | null;
      };
    };
  const report = (token: string, q = '', branch?: string) =>
    w.req(
      'GET',
      `/companies/${w.a.companyId}${branch ? `/branches/${branch}` : ''}/reports/receivables${q}`,
      token,
    );
  const auditCount = async (customerId: string): Promise<number> => {
    const accountId = (await account(customerId)).id;
    return Number(
      (
        await rows(
          `SELECT count(*)::int AS n FROM audit_log WHERE action = 'customer.credit_config_updated' AND "resourceId" = $1`,
          [accountId],
        )
      )[0]!['n'],
    );
  };
  const invoiceCount = async (customerId: string): Promise<number> =>
    Number(
      (
        await rows(
          `SELECT count(*)::int AS n FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE o."customerId" = $1`,
          [customerId],
        )
      )[0]!['n'],
    );

  /** a customer created the way Owner Web creates one (the real create route), credit OFF as the server defaults it */
  async function newCustomer(): Promise<string> {
    const r = await w.req(
      'POST',
      `/companies/${w.a.companyId}/customers`,
      w.ownerToken,
      { displayName: `Credit ${randomUUID().slice(0, 6)}` },
      { 'idempotency-key': `cust-${randomUUID()}` },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as { id: string }).id;
  }
  const creditSale = (customerId: string, qty: number) =>
    w.sale({ co: w.a, branch: b0, token: cashier, customerId, credit: true, quantity: qty });

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 2);
    b0 = w.a.branches[0]!;
    b1 = w.a.branches[1]!;
    const s0 = { companyScope: [w.a.companyId], branchScope: [b0] };
    cashier = await mintTenantToken(w.h, w.a.tenantId, rolePerms('cashier'), s0);
    manager = await mintTenantToken(w.h, w.a.tenantId, rolePerms('manager'), {
      ...s0,
      stepUp: true,
    });
    admin = await mintTenantToken(w.h, w.a.tenantId, rolePerms('admin'), { stepUp: true });
    ownerNoStepUp = await mintTenantToken(w.h, w.a.tenantId, rolePerms('owner'));
    ownerBranchB0 = await mintTenantToken(w.h, w.a.tenantId, rolePerms('owner'), {
      companyScope: [w.a.companyId],
      branchScope: [b0],
      stepUp: true,
    });
    foreignOwner = await mintTenantToken(w.h, w.b.tenantId, rolePerms('owner'), { stepUp: true });
  }, 240_000);

  afterAll(async () => {
    await w?.h.close();
    await w?.pool.end();
    await stack?.stop();
  });

  it('a new customer has credit OFF: a credit sale is refused and nothing is invoiced', async () => {
    const c = await newCustomer();
    const a = await account(c);
    expect(a.creditEnabled).toBe(false);
    expect(a.creditLimitMinor).toBeNull();
    const before = await invoiceCount(c);
    const sale = await creditSale(c, 1);
    expect(sale.ok).toBe(false);
    expect(await invoiceCount(c)).toBe(before);
  });

  it('the owner enables credit with a limit: version advances, the till honours the limit, the account shows exposure and available credit', async () => {
    const c = await newCustomer();
    const v0 = (await account(c)).version;
    const r = await patchCredit(
      w.ownerToken,
      c,
      { creditEnabled: true, creditLimitMinor: '2500' },
      v0,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await account(c);
    expect(after.creditEnabled).toBe(true);
    expect(after.creditLimitMinor).toBe('2500');
    expect(after.creditLimitCurrencyCode).toBe('AED'); // the company's currency — the client never sends one
    expect(after.version).toBe(v0 + 1);
    expect(await auditCount(c)).toBe(1);

    // two units on credit fit inside 25.00; the exposure and the available credit are the SERVER's figures
    expect((await creditSale(c, 2)).ok).toBe(true);
    const s = await summary(c);
    expect(s.credit.scope).toBe('COMPANY');
    expect(s.credit.creditExposureMinor).toBe('2000');
    expect(s.credit.availableCreditMinor).toBe('500');
    expect(s.branchFinancials.receivableOutstandingMinor).toBe('2000');

    // a third unit would take the exposure to 3000 > 2500: refused, nothing invoiced
    const n = await invoiceCount(c);
    const over = await creditSale(c, 1);
    expect(over.ok).toBe(false);
    expect(await invoiceCount(c)).toBe(n);

    // raising the limit is a normal PATCH at the NEW version, and the same sale now passes
    const up = await patchCredit(
      w.ownerToken,
      c,
      { creditEnabled: true, creditLimitMinor: '5000' },
      after.version,
    );
    expect(up.status).toBe(200);
    expect((await creditSale(c, 1)).ok).toBe(true);
    expect((await summary(c)).credit.creditExposureMinor).toBe('3000');
  });

  it('switching credit OFF keeps the stored limit and the existing debt; new credit sales are refused', async () => {
    const c = await newCustomer();
    let v = (await account(c)).version;
    expect(
      (await patchCredit(w.ownerToken, c, { creditEnabled: true, creditLimitMinor: '9000' }, v))
        .status,
    ).toBe(200);
    expect((await creditSale(c, 1)).ok).toBe(true);
    v = (await account(c)).version;
    const off = await patchCredit(w.ownerToken, c, { creditEnabled: false }, v);
    expect(off.status).toBe(200);
    const a = await account(c);
    expect(a.creditEnabled).toBe(false);
    expect(a.creditLimitMinor).toBe('9000'); // retained — there is no clear verb
    expect((await summary(c)).branchFinancials.receivableOutstandingMinor).toBe('1000'); // the debt is untouched
    expect((await creditSale(c, 1)).ok).toBe(false);
  });

  it('a STALE version conflicts (409) and changes nothing; replaying a successful PATCH is also a conflict, never a second application', async () => {
    const c = await newCustomer();
    const v0 = (await account(c)).version;
    const first = await patchCredit(
      w.ownerToken,
      c,
      { creditEnabled: true, creditLimitMinor: '1000' },
      v0,
    );
    expect(first.status).toBe(200);
    const audits = await auditCount(c);
    const replay = await patchCredit(
      w.ownerToken,
      c,
      { creditEnabled: true, creditLimitMinor: '7777' },
      v0,
    );
    expect(replay.status).toBe(409);
    expect(errCode(replay)).toBe('CUSTOMER_CREDIT_VERSION_CONFLICT');
    const a = await account(c);
    expect(a.creditLimitMinor).toBe('1000');
    expect(a.version).toBe(v0 + 1);
    expect(await auditCount(c)).toBe(audits);
  });

  it('refuses a request with no If-Match, and any body that is not exactly the frozen shape', async () => {
    const c = await newCustomer();
    const v = (await account(c)).version;
    expect(
      (await patchCredit(w.ownerToken, c, { creditEnabled: true }, null)).status,
    ).toBeGreaterThanOrEqual(400);
    for (const bad of [
      { creditEnabled: true, creditLimitMinor: '12.50' }, // not a digit string
      { creditEnabled: true, creditLimitMinor: '-5' },
      { creditEnabled: true, creditLimitMinor: null }, // no clear verb
      { creditEnabled: true, creditLimitMinor: 1000 }, // a JSON number
      { creditEnabled: true, creditLimitMinor: '1000', creditLimitCurrencyExponent: 5 }, // a client-supplied currency field
      { creditLimitMinor: '1000' }, // creditEnabled missing
    ]) {
      const r = await patchCredit(w.ownerToken, c, bad, v);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const zero = await patchCredit(
      w.ownerToken,
      c,
      { creditEnabled: true, creditLimitMinor: '0' },
      v,
    );
    expect(zero.status).toBe(422);
    const a = await account(c);
    expect(a.version).toBe(v); // nothing changed, nothing audited
    expect(await auditCount(c)).toBe(0);
  });

  it('exact server permissions: only customers:credit:manage may change credit; manager and cashier are refused; the owner needs a fresh step-up', async () => {
    const c = await newCustomer();
    const v = (await account(c)).version;
    const body = { creditEnabled: true, creditLimitMinor: '100000' };
    for (const [name, token] of [
      ['manager', manager],
      ['cashier', cashier],
    ] as const) {
      const r = await patchCredit(token, c, body, v);
      expect([403, 404], name).toContain(r.status);
    }
    const noStep = await patchCredit(ownerNoStepUp, c, body, v);
    expect(noStep.status).toBe(403);
    expect(errCode(noStep)).toBe('STEP_UP_REQUIRED');
    const a = await account(c);
    expect(a.creditEnabled).toBe(false);
    expect(a.version).toBe(v);
    expect(await auditCount(c)).toBe(0);
    // an admin (credit:manage, no override) with a fresh step-up can
    expect((await patchCredit(admin, c, body, v)).status).toBe(200);
    expect(await auditCount(c)).toBe(1);
  });

  it('the credit-limit OVERRIDE authority stays separate: managing credit never lets a manager-level sale exceed a limit (unchanged by this screen)', async () => {
    const c = await newCustomer();
    const v = (await account(c)).version;
    expect(
      (await patchCredit(w.ownerToken, c, { creditEnabled: true, creditLimitMinor: '1000' }, v))
        .status,
    ).toBe(200);
    expect((await creditSale(c, 1)).ok).toBe(true); // exactly the limit
    const n = await invoiceCount(c);
    expect((await creditSale(c, 1)).ok).toBe(false); // a cashier cannot go over
    expect(await invoiceCount(c)).toBe(n);
  });

  it('receivables report: the company view lists the customer with the SAME outstanding as the account, reconciles with the GL, and matches the database', async () => {
    const c = await newCustomer();
    const v = (await account(c)).version;
    await patchCredit(w.ownerToken, c, { creditEnabled: true, creditLimitMinor: '50000' }, v);
    expect((await creditSale(c, 3)).ok).toBe(true);

    const r = await report(w.ownerToken, `?customerId=${c}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const body = r.body as {
      currencyCode: string;
      outstandingMinor: string;
      reconciliation: { reconciled: boolean };
      byBranch: { branchId: string; outstandingMinor: string }[];
      customers: {
        rows: { customerId: string; outstandingMinor: string; receivableCount: number }[];
      };
    };
    expect(body.customers.rows).toHaveLength(1);
    expect(body.customers.rows[0]!.customerId).toBe(c);
    expect(body.customers.rows[0]!.outstandingMinor).toBe('3000');
    expect(body.customers.rows[0]!.outstandingMinor).toBe(
      (await summary(c)).branchFinancials.receivableOutstandingMinor,
    );
    expect(body.reconciliation.reconciled).toBe(true);
    expect(body.byBranch.find((b) => b.branchId === b0)!.outstandingMinor).toBe('3000');
    const db = await rows(
      `SELECT coalesce(sum(i."totalAmountMinor"),0)::text AS invoiced, count(*)::int AS n FROM invoice i JOIN "order" o ON o.id = i."orderId" WHERE o."customerId" = $1`,
      [c],
    );
    expect(db[0]!['invoiced']).toBe('3000');
    expect(db[0]!['n']).toBe(1);

    // the whole company: contains this customer with the same figure, and its total reconciles
    const all = await report(w.ownerToken, '?limit=200');
    expect(all.status).toBe(200);
    const allBody = all.body as {
      reconciliation: { reconciled: boolean };
      customers: { rows: { customerId: string; outstandingMinor: string }[] };
    };
    expect(allBody.reconciliation.reconciled).toBe(true);
    expect(allBody.customers.rows.find((x) => x.customerId === c)?.outstandingMinor).toBe('3000');
  });

  it('report scope: a branch-restricted reader cannot read the company-wide view but can read their own branch; another branch is refused', async () => {
    const company = await report(ownerBranchB0);
    expect([403, 404]).toContain(company.status);
    const own = await report(ownerBranchB0, '', b0);
    expect(own.status).toBe(200);
    const other = await report(ownerBranchB0, '', b1);
    expect([403, 404]).toContain(other.status);
  });

  it('cross-tenant isolation: another tenant’s owner can neither read this company’s credit, change it, nor see its receivables', async () => {
    const c = await newCustomer();
    const v = (await account(c)).version;
    expect(
      (await patchCredit(w.ownerToken, c, { creditEnabled: true, creditLimitMinor: '4000' }, v))
        .status,
    ).toBe(200);
    const v1 = (await account(c)).version;

    const read = await w.req('GET', acct(w.a.companyId, c), foreignOwner);
    expect([403, 404]).toContain(read.status);
    const write = await patchCredit(foreignOwner, c, { creditEnabled: false }, v1);
    expect([403, 404]).toContain(write.status);
    const rep = await report(foreignOwner);
    expect([403, 404]).toContain(rep.status);
    const repBranch = await report(foreignOwner, '', b0);
    expect([403, 404]).toContain(repBranch.status);

    const a = await account(c);
    expect(a.creditEnabled).toBe(true);
    expect(a.creditLimitMinor).toBe('4000');
    expect(a.version).toBe(v1);
  });

  it('a customer of ANOTHER company in the same tenant is invisible through this company’s credit route (non-disclosing)', async () => {
    const c = await newCustomer(); // associated with company A only
    const v = (await account(c)).version;
    const r = await patchCredit(
      w.ownerToken,
      c,
      { creditEnabled: true, creditLimitMinor: '100' },
      v,
      w.a2.companyId,
    );
    expect([403, 404]).toContain(r.status);
    const read = await w.req('GET', acct(w.a2.companyId, c), w.ownerToken);
    expect([403, 404]).toContain(read.status);
    expect((await account(c)).version).toBe(v);
  });
});
