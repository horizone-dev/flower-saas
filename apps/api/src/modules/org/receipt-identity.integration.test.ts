import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import {
  createSaleWorld,
  mintTenantToken,
  rolePerms,
  type SaleWorld,
} from '../../verification/load-sale-world.js';

/**
 * F-3 — the SELLER IDENTITY a cashier prints on a VAT receipt (legal name, TRN, registered address, branch name), read with the EXISTING
 * `orders:view` authority and the cashier's own company + branch scope. Real PostgreSQL + Redis, real HTTP routes, real RLS.
 * Proves: the cashier can read it; it carries ONLY the allow-listed non-secret fields; branch / company / tenant isolation; a role without
 * `orders:view` is refused; an unauthenticated caller is refused.
 */
describe('F-3 — cashier-readable seller identity for receipts', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let cashier = '';
  const url = (companyId: string, branchId: string): string =>
    `/companies/${companyId}/branches/${branchId}/receipt-identity`;

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 3);
    await w.pool.query(
      `UPDATE company SET trn = $2, "registeredAddress" = $3, "legalNameAr" = $4, "crNumber" = 'CR-SECRET-LOOKING-123' WHERE id = $1`,
      [w.a.companyId, '100123456700003', 'Shop 4, Rose Street, Dubai', 'متجر الورد'],
    );
    await w.pool.query(
      `UPDATE company SET trn = '999999999999999', "registeredAddress" = 'TENANT B SECRET ADDRESS' WHERE id = $1`,
      [w.b.companyId],
    );
    cashier = await mintTenantToken(w.h, w.a.tenantId, rolePerms('cashier'), {
      companyScope: [w.a.companyId],
      branchScope: [w.a.branches[0]!],
    });
  }, 300_000);

  afterAll(async () => {
    await w?.h.close();
    await w?.pool.end();
    await stack?.stop();
  });

  it('a cashier reads the seller identity of their own company and branch (with the TRN and address)', async () => {
    const r = await w.req('GET', url(w.a.companyId, w.a.branches[0]!), cashier);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      companyId: w.a.companyId,
      branchId: w.a.branches[0],
      legalNameEn: expect.any(String),
      legalNameAr: 'متجر الورد',
      trn: '100123456700003',
      registeredAddress: 'Shop 4, Rose Street, Dubai',
      countryCode: 'AE',
      currency: 'AED',
      branchName: expect.any(String),
    });
  });

  it('carries ONLY the allow-listed fields — no CR number, fiscal config, credentials or tenant internals', async () => {
    const r = await w.req('GET', url(w.a.companyId, w.a.branches[0]!), cashier);
    expect(Object.keys(r.body as object).sort()).toEqual(
      [
        'branchId',
        'branchName',
        'companyId',
        'countryCode',
        'currency',
        'legalNameAr',
        'legalNameEn',
        'registeredAddress',
        'trn',
      ].sort(),
    );
    expect(JSON.stringify(r.body)).not.toMatch(/CR-SECRET|fiscalConfig|credential|secret/i);
  });

  it('a sibling branch outside the cashier’s scope is refused', async () => {
    const r = await w.req('GET', url(w.a.companyId, w.a.branches[1]!), cashier);
    expect([403, 404]).toContain(r.status); // out of scope is refused (the scope guard may hide existence as 404)
    expect(JSON.stringify(r.body)).not.toMatch(/100123456700003/);
  });

  it('another company of the SAME tenant is refused', async () => {
    const r = await w.req('GET', url(w.a2.companyId, w.a2.branches[0]!), cashier);
    expect([403, 404]).toContain(r.status);
    expect(JSON.stringify(r.body)).not.toMatch(/100123456700003/);
  });

  it('a foreign TENANT’s company is never readable, and its TRN / address never leak', async () => {
    const r = await w.req('GET', url(w.b.companyId, w.b.branches[0]!), cashier);
    expect([403, 404]).toContain(r.status);
    expect(JSON.stringify(r.body)).not.toMatch(/999999999999999|TENANT B SECRET/);
    // even an all-scope owner of tenant A cannot read tenant B's company: RLS hides it
    const ownerA = await mintTenantToken(w.h, w.a.tenantId, rolePerms('owner'));
    const o = await w.req('GET', url(w.b.companyId, w.b.branches[0]!), ownerA);
    expect([403, 404]).toContain(o.status);
    expect(JSON.stringify(o.body)).not.toMatch(/999999999999999|TENANT B SECRET/);
  });

  it('a branch that does not belong to the company is not found', async () => {
    const owner = await mintTenantToken(w.h, w.a.tenantId, rolePerms('owner'));
    const r = await w.req('GET', url(w.a.companyId, w.a2.branches[0]!), owner);
    expect([403, 404]).toContain(r.status);
  });

  it('a role without orders:view is refused (the identity read adds no new authority)', async () => {
    const accountant = await mintTenantToken(w.h, w.a.tenantId, rolePerms('accountant'), {
      companyScope: [w.a.companyId],
      branchScope: [w.a.branches[0]!],
    });
    const r = await w.req('GET', url(w.a.companyId, w.a.branches[0]!), accountant);
    expect(r.status).toBe(403);
  });

  it('an unauthenticated caller is refused', async () => {
    const r = await w.req('GET', url(w.a.companyId, w.a.branches[0]!), null);
    expect(r.status).toBe(401);
  });

  it('a malformed id is a validation error, never a database error', async () => {
    const r = await w.req(
      'GET',
      `/companies/not-a-uuid/branches/${w.a.branches[0]}/receipt-identity`,
      cashier,
    );
    expect([400, 403, 404]).toContain(r.status);
  });
});
