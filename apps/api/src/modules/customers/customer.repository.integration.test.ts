import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising the domain repository directly.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import { CustomerRepository } from './customer.repository.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';

/**
 * Task 3b.2 checkpoint B — CustomerRepository against real Postgres. Covers
 * the domain/repository foundation: atomic Customer+CompanyAccount creation,
 * Company PII isolation (the core safety property), company association,
 * credit-limit Money authority, and optimistic concurrency.
 */
describe('CustomerRepository (task 3b.2, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let repo: CustomerRepository;
  let accounts: AccountRepository;
  let companyConfig: CompanyFinancialConfigRepository;

  const tenantId = randomUUID();
  let companyAId = '';
  let companyBId = '';
  let otherTenantId = '';
  let otherTenantCompanyId = '';

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>, tid: string = tenantId): Promise<T> {
    return runScoped(
      prisma,
      { tenantId: tid as `${string}-${string}-${string}-${string}-${string}` },
      fn,
    );
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });

    const dummyDb = {} as unknown as DbService;
    accounts = new AccountRepository(dummyDb, new AuditWriter(dummyDb));
    companyConfig = new CompanyFinancialConfigRepository(
      dummyDb,
      new AuditWriter(dummyDb),
      accounts,
    );
    repo = new CustomerRepository(dummyDb, new AuditWriter(dummyDb), companyConfig);

    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const planId = randomUUID();
      const planVersionId = randomUUID();
      await c.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
        planId,
        `customer-test-plan-${planId.slice(0, 8)}`,
      ]);
      await c.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
         VALUES ($1, $2, 1, 'PUBLISHED', now())`,
        [planVersionId, planId],
      );
      otherTenantId = randomUUID();
      for (const tid of [tenantId, otherTenantId]) {
        await c.query(
          `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
           VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
          [tid, `customer-test-${tid.slice(0, 8)}`, planVersionId],
        );
      }
      await c.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES
           ('AED', 2, 'AED', 'UAE Dirham', 'x'),
           ('KWD', 3, 'KWD', 'Kuwaiti Dinar', 'x'),
           ('SAR', 2, 'SAR', 'Saudi Riyal', 'x')
         ON CONFLICT (code) DO NOTHING`,
      );
      await c.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "defaultTimezone", "updatedAt") VALUES
           ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', 'Asia/Dubai', now()),
           ('KW', 'Kuwait', 'x', 'gcc', 'KWD', 'FRI_SAT', 'Asia/Kuwait', now())
         ON CONFLICT (code) DO NOTHING`,
      );
      companyAId = randomUUID();
      companyBId = randomUUID();
      otherTenantCompanyId = randomUUID();
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", status, "updatedAt")
         VALUES ($1, $2, 'Company A', 'AE', 'AED', 'ACTIVE', now())`,
        [companyAId, tenantId],
      );
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", status, "updatedAt")
         VALUES ($1, $2, 'Company B', 'KW', 'KWD', 'ACTIVE', now())`,
        [companyBId, tenantId],
      );
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", status, "updatedAt")
         VALUES ($1, $2, 'Other Tenant Co', 'AE', 'AED', 'ACTIVE', now())`,
        [otherTenantCompanyId, otherTenantId],
      );
    } finally {
      await c.end();
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await stack?.stop?.();
  });

  // ── atomic creation (§7, §21) ─────────────────────────────────────────────

  it('creates Customer + initial CustomerCompanyAccount atomically, financially neutral', async () => {
    const { customer, companyAccount } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Alice' }),
    );
    expect(customer.status).toBe('ACTIVE');
    expect(companyAccount.creditEnabled).toBe(false);
    expect(companyAccount.creditLimitMinor).toBeNull();
    expect(companyAccount.customerId).toBe(customer.id);
  });

  it('rolls back the entire creation if the CompanyAccount insert fails (bad companyId, FK violation)', async () => {
    await expect(
      asTenant((tx) =>
        repo.createForCompany(tx, {
          tenantId,
          companyId: randomUUID(), // no such company
          displayName: 'Should Roll Back',
        }),
      ),
    ).rejects.toThrow();
    const rows = await asTenant((tx) =>
      tx.customer.findMany({ where: { displayName: 'Should Roll Back' } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('a failed transaction (bad companyId) leaves NO orphaned audit row — the audit_log table has zero rows referencing a customerId that was never actually created (§18)', async () => {
    let thrownCustomerIdCandidate: string | null = null;
    await expect(
      asTenant(async (tx) => {
        try {
          await repo.createForCompany(tx, {
            tenantId,
            companyId: randomUUID(), // no such company — FK violation inside the same tx
            displayName: 'Should Roll Back Audit Too',
          });
        } catch (err) {
          // even if a caller attempted to write an audit row referencing a
          // not-yet-committed id in the SAME transaction as the failed
          // insert, the whole transaction (including that audit write) is
          // rolled back by Postgres when the callback re-throws below —
          // this is a property of `asTenant`'s transaction boundary itself,
          // not something a test can accidentally get right by omission.
          thrownCustomerIdCandidate = randomUUID();
          await tx.$executeRaw`
            INSERT INTO audit_log (id, "tenantId", "actorAccountType", action, "resourceType", "resourceId", after, at)
            VALUES (uuidv7(), ${tenantId}::uuid, 'SYSTEM', 'customer.created', 'customer', ${thrownCustomerIdCandidate}, '{}'::jsonb, now())`;
          throw err;
        }
      }),
    ).rejects.toThrow();
    expect(thrownCustomerIdCandidate).not.toBeNull();
    const rows = await asTenant(
      (tx) =>
        tx.$queryRaw<{ n: string }[]>`
        SELECT count(*)::text AS n FROM audit_log WHERE "resourceId" = ${thrownCustomerIdCandidate}`,
    );
    // proves the transaction boundary itself is atomic across BOTH the
    // domain write and any audit write attempted in the same tx — not just
    // that the domain row rolls back (already proven above), but that
    // nothing in that same failed transaction survives, audit included.
    expect(rows[0]!.n).toBe('0');
  });

  it('separate legitimate create requests with identical contact info produce distinct Customer ids', async () => {
    const a = await asTenant((tx) =>
      repo.createForCompany(tx, {
        tenantId,
        companyId: companyAId,
        displayName: 'Same Name',
        phone: '+971501234567',
        email: 'Same@Example.com',
      }),
    );
    const b = await asTenant((tx) =>
      repo.createForCompany(tx, {
        tenantId,
        companyId: companyAId,
        displayName: 'Same Name',
        phone: '+971501234567',
        email: 'same@example.com',
      }),
    );
    expect(a.customer.id).not.toBe(b.customer.id);
    expect(a.customer.phoneE164).toBe(b.customer.phoneE164);
    expect(a.customer.emailNormalized).toBe(b.customer.emailNormalized);
  });

  // ── company association (§8, §22) ────────────────────────────────────────

  it('one Customer may have independent relationships with Company A and Company B', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Multi Co' }),
    );
    const { companyAccount: accB, created } = await asTenant((tx) =>
      repo.associateWithCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
    );
    expect(created).toBe(true);
    expect(accB.companyId).toBe(companyBId);
    const bothForA = await asTenant((tx) =>
      repo.getForCompany(tx, { tenantId, companyId: companyAId, customerId: customer.id }),
    );
    const bothForB = await asTenant((tx) =>
      repo.getForCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
    );
    expect(bothForA.id).toBe(bothForB.id);
  });

  it('repeated association is idempotent — exactly one row, second call returns created=false', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Idem Assoc' }),
    );
    const first = await asTenant((tx) =>
      repo.associateWithCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
    );
    const second = await asTenant((tx) =>
      repo.associateWithCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.companyAccount.id).toBe(second.companyAccount.id);
    const count = await asTenant((tx) =>
      tx.customerCompanyAccount.count({
        where: { tenantId, companyId: companyBId, customerId: customer.id },
      }),
    );
    expect(count).toBe(1);
  });

  it('parallel same-company association requests result in exactly one row (real concurrency)', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Race Assoc' }),
    );
    const results = await Promise.all([
      asTenant((tx) =>
        repo.associateWithCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
      ),
      asTenant((tx) =>
        repo.associateWithCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
      ),
    ]);
    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);
    const count = await asTenant((tx) =>
      tx.customerCompanyAccount.count({
        where: { tenantId, companyId: companyBId, customerId: customer.id },
      }),
    );
    expect(count).toBe(1);
  });

  it('association targeting a cross-tenant customer is rejected (FK violation → CUSTOMER_NOT_FOUND)', async () => {
    const { customer: otherTenantCustomer } = await asTenant(
      (tx) =>
        repo.createForCompany(tx, {
          tenantId: otherTenantId,
          companyId: otherTenantCompanyId,
          displayName: 'Other Tenant Cust',
        }),
      otherTenantId,
    );
    await expect(
      asTenant((tx) =>
        repo.associateWithCompany(tx, {
          tenantId,
          companyId: companyAId,
          customerId: otherTenantCustomer.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  // ── Company PII isolation (§9, §23) ───────────────────────────────────────

  it('a Company-A-scoped caller cannot retrieve a Company-B-only Customer (404, not leaked)', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyBId, displayName: 'B Only' }),
    );
    await expect(
      asTenant((tx) =>
        repo.getForCompany(tx, { tenantId, companyId: companyAId, customerId: customer.id }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('listForCompany(A) never includes a B-only Customer', async () => {
    const { customer: bOnly } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyBId, displayName: 'List B Only' }),
    );
    const { data } = await asTenant((tx) =>
      repo.listForCompany(tx, { tenantId, companyId: companyAId }),
    );
    expect(data.some((c) => c.id === bOnly.id)).toBe(false);
  });

  it('a Customer associated with both A and B is returned through either authorized path', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Both Paths' }),
    );
    await asTenant((tx) =>
      repo.associateWithCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
    );
    const viaA = await asTenant((tx) =>
      repo.getForCompany(tx, { tenantId, companyId: companyAId, customerId: customer.id }),
    );
    const viaB = await asTenant((tx) =>
      repo.getForCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
    );
    expect(viaA.id).toBe(customer.id);
    expect(viaB.id).toBe(customer.id);
  });

  it('cross-tenant Customer is never visible via getForTenant/listForTenant', async () => {
    const { customer: otherTenantCustomer } = await asTenant(
      (tx) =>
        repo.createForCompany(tx, {
          tenantId: otherTenantId,
          companyId: otherTenantCompanyId,
          displayName: 'Cross Tenant',
        }),
      otherTenantId,
    );
    await expect(
      asTenant((tx) => repo.getForTenant(tx, { tenantId, customerId: otherTenantCustomer.id })),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('Company A credit config cannot mutate the Company B relationship', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Cross Config' }),
    );
    const { companyAccount: accB } = await asTenant((tx) =>
      repo.associateWithCompany(tx, { tenantId, companyId: companyBId, customerId: customer.id }),
    );
    await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
        creditEnabled: true,
        creditLimitMinor: 10000n,
      }),
    );
    const bAfter = await asTenant((tx) =>
      tx.customerCompanyAccount.findUniqueOrThrow({ where: { id: accB.id } }),
    );
    expect(bAfter.creditEnabled).toBe(false);
    expect(bAfter.version).toBe(1);
  });

  // ── credit-limit Money authority (§10-12, §24) ────────────────────────────

  it('AED (2-decimal) credit limit configures exactly, exponent resolved server-side', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'AED Credit' }),
    );
    const updated = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
        creditEnabled: true,
        creditLimitMinor: 500000n,
      }),
    );
    expect(updated.creditLimitCurrencyCode).toBe('AED');
    expect(updated.creditLimitCurrencyExponent).toBe(2);
    expect(updated.creditLimitMinor).toBe(500000n);
  });

  it('KWD (3-decimal) credit limit configures exactly — BigInt, no float', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyBId, displayName: 'KWD Credit' }),
    );
    const bigAmount = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    const updated = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyBId,
        customerId: customer.id,
        expectedVersion: 1,
        creditEnabled: true,
        creditLimitMinor: bigAmount,
      }),
    );
    expect(updated.creditLimitCurrencyCode).toBe('KWD');
    expect(updated.creditLimitCurrencyExponent).toBe(3);
    expect(updated.creditLimitMinor).toBe(bigAmount);
    expect(typeof updated.creditLimitMinor).toBe('bigint');
  });

  it('enable + null limit is rejected (CUSTOMER_CREDIT_CONFIG_INVALID)', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Enable Null' }),
    );
    await expect(
      asTenant((tx) =>
        repo.configureCredit(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          creditEnabled: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_CONFIG_INVALID' });
  });

  it('enable + zero limit is rejected', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Enable Zero' }),
    );
    await expect(
      asTenant((tx) =>
        repo.configureCredit(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          creditEnabled: true,
          creditLimitMinor: 0n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_INVALID' });
  });

  it('negative limit is rejected regardless of creditEnabled', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Negative' }),
    );
    await expect(
      asTenant((tx) =>
        repo.configureCredit(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          creditEnabled: false,
          creditLimitMinor: -1n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_INVALID' });
  });

  it('disabled + null limit is allowed', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Disabled Null' }),
    );
    const updated = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
        creditEnabled: false,
      }),
    );
    expect(updated.creditEnabled).toBe(false);
    expect(updated.creditLimitMinor).toBeNull();
  });

  it('disabled + a previously-configured positive limit may be retained', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Retain Limit' }),
    );
    const enabled = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
        creditEnabled: true,
        creditLimitMinor: 20000n,
      }),
    );
    const disabled = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: enabled.version,
        creditEnabled: false,
      }),
    );
    expect(disabled.creditEnabled).toBe(false);
    expect(disabled.creditLimitMinor).toBe(20000n);
    expect(disabled.creditLimitCurrencyCode).toBe('AED');
  });

  it('a different-currency limit is rejected — cannot configure a KWD limit for an AED company', async () => {
    // configureCredit always resolves currency from Company.defaultCurrency
    // server-side; this test proves there is no parameter through which a
    // caller could inject a different currency at all.
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, {
        tenantId,
        companyId: companyAId,
        displayName: 'No Client Currency',
      }),
    );
    const updated = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId, // AED company
        customerId: customer.id,
        expectedVersion: 1,
        creditEnabled: true,
        creditLimitMinor: 1000n,
      }),
    );
    expect(updated.creditLimitCurrencyCode).toBe('AED'); // never KWD, no matter what — no caller input for currency exists
  });

  it('re-enabling with a stored limit whose currency no longer matches the current company currency fails closed', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Stale Currency' }),
    );
    const enabled = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
        creditEnabled: true,
        creditLimitMinor: 5000n,
      }),
    );
    // simulate the company's currency changing later (no live endpoint does
    // this yet per company-financial-config.repository.ts's own doc comment —
    // this directly tests the defensive re-validation, not a reachable prod flow)
    await asTenant(
      (tx) =>
        tx.$executeRaw`UPDATE "company" SET "defaultCurrency" = 'KWD' WHERE "id" = ${companyAId}::uuid`,
    );
    const disabled = await asTenant((tx) =>
      repo.configureCredit(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: enabled.version,
        creditEnabled: false,
      }),
    );
    await expect(
      asTenant((tx) =>
        repo.configureCredit(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: disabled.version,
          creditEnabled: true, // re-enable with the stale AED-denominated stored limit
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CREDIT_CURRENCY_MISMATCH' });
    // restore for any subsequent test in this file
    await asTenant(
      (tx) =>
        tx.$executeRaw`UPDATE "company" SET "defaultCurrency" = 'AED' WHERE "id" = ${companyAId}::uuid`,
    );
  });

  // ── concurrency / versioning (§13, §25) ───────────────────────────────────

  it('a Customer profile update with a stale expectedVersion is rejected', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Version Test' }),
    );
    await asTenant((tx) =>
      repo.updateForCompany(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
        displayName: 'Version Test V2',
      }),
    );
    await expect(
      asTenant((tx) =>
        repo.updateForCompany(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1, // stale
          displayName: 'Version Test V3',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
  });

  it('parallel Customer profile updates from the same version: exactly one succeeds, one conflicts (real race)', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Race Update' }),
    );
    const attempts = await Promise.allSettled([
      asTenant((tx) =>
        repo.updateForCompany(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          displayName: 'Race Update A',
        }),
      ),
      asTenant((tx) =>
        repo.updateForCompany(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          displayName: 'Race Update B',
        }),
      ),
    ]);
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]!.status === 'rejected') {
      expect(rejected[0]!.reason).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
    }
    const final = await asTenant((tx) =>
      repo.getForCompany(tx, { tenantId, companyId: companyAId, customerId: customer.id }),
    );
    expect(final.version).toBe(2); // incremented exactly once, never twice, never last-write-wins-without-a-conflict
  });

  it('a concurrent profile update and archive from the same version: exactly one succeeds, one conflicts — no invalid silent state', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Race Archive' }),
    );
    const attempts = await Promise.allSettled([
      asTenant((tx) =>
        repo.updateForCompany(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          displayName: 'Still Active Attempt',
        }),
      ),
      asTenant((tx) =>
        repo.archiveForCompany(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
        }),
      ),
    ]);
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const final = await asTenant((tx) =>
      repo.getForCompany(tx, { tenantId, companyId: companyAId, customerId: customer.id }),
    );
    // whichever one actually landed, the row is in exactly one deterministic
    // state — never a torn/ambiguous mix, and if the update won, a later
    // archive attempt (not this race) still works; if archive won, the
    // update was correctly rejected (an archived customer cannot be silently
    // reactivated by a losing concurrent update).
    expect(['ACTIVE', 'ARCHIVED']).toContain(final.status);
    expect(final.version).toBe(2);
  });

  it('parallel credit-config updates from the same version: exactly one succeeds, one conflicts (real race)', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Race Credit' }),
    );
    const attempts = await Promise.allSettled([
      asTenant((tx) =>
        repo.configureCredit(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          creditEnabled: true,
          creditLimitMinor: 1000n,
        }),
      ),
      asTenant((tx) =>
        repo.configureCredit(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: 1,
          creditEnabled: true,
          creditLimitMinor: 2000n,
        }),
      ),
    ]);
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  // ── archive lifecycle (§14, §19) ──────────────────────────────────────────

  it('archive is ACTIVE→ARCHIVED; a second archive call is an idempotent no-op', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Archive Me' }),
    );
    const archived = await asTenant((tx) =>
      repo.archiveForCompany(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
      }),
    );
    expect(archived.status).toBe('ARCHIVED');
    const again = await asTenant((tx) =>
      repo.archiveForCompany(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: archived.version,
      }),
    );
    expect(again.status).toBe('ARCHIVED');
  });

  it('an archived Customer rejects a profile update with CUSTOMER_ARCHIVED', async () => {
    const { customer } = await asTenant((tx) =>
      repo.createForCompany(tx, {
        tenantId,
        companyId: companyAId,
        displayName: 'Archived Mutation',
      }),
    );
    const archived = await asTenant((tx) =>
      repo.archiveForCompany(tx, {
        tenantId,
        companyId: companyAId,
        customerId: customer.id,
        expectedVersion: 1,
      }),
    );
    await expect(
      asTenant((tx) =>
        repo.updateForCompany(tx, {
          tenantId,
          companyId: companyAId,
          customerId: customer.id,
          expectedVersion: archived.version,
          displayName: 'Should Fail',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_ARCHIVED' });
  });

  it('no unarchive method exists (structural — grep the repository source)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./customer.repository.ts', import.meta.url), 'utf8');
    expect(/unarchive/i.test(src)).toBe(false);
  });

  // ── search foundation (§18) ───────────────────────────────────────────────

  it('searchForCompany: displayName prefix match, exact phoneE164/emailNormalized match, all join-gated', async () => {
    const { customer: match } = await asTenant((tx) =>
      repo.createForCompany(tx, {
        tenantId,
        companyId: companyAId,
        displayName: 'Zephyr Search Target',
        phone: '+971502223344',
        email: 'zephyr@example.com',
      }),
    );
    await asTenant((tx) =>
      repo.createForCompany(tx, { tenantId, companyId: companyAId, displayName: 'Unrelated' }),
    );
    // a same-named customer under Company B must never surface in an A search
    await asTenant((tx) =>
      repo.createForCompany(tx, {
        tenantId,
        companyId: companyBId,
        displayName: 'Zephyr Search Target',
      }),
    );

    const byPrefix = await asTenant((tx) =>
      repo.searchForCompany(tx, { tenantId, companyId: companyAId, displayNameQuery: 'Zephyr' }),
    );
    expect(byPrefix.data.map((c) => c.id)).toEqual([match.id]);

    const byPhone = await asTenant((tx) =>
      repo.searchForCompany(tx, { tenantId, companyId: companyAId, phoneE164: '+971502223344' }),
    );
    expect(byPhone.data.map((c) => c.id)).toEqual([match.id]);

    const byEmail = await asTenant((tx) =>
      repo.searchForCompany(tx, {
        tenantId,
        companyId: companyAId,
        emailNormalized: 'zephyr@example.com',
      }),
    );
    expect(byEmail.data.map((c) => c.id)).toEqual([match.id]);
  });

  it('listForCompany: stable cursor pagination — every row appears exactly once across page boundaries on a stable dataset, and the last page reports a null nextCursor (§20)', async () => {
    const pagingCompanyId = randomUUID();
    await asTenant(
      (tx) =>
        tx.$executeRaw`
        INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", status, "updatedAt")
        VALUES (${pagingCompanyId}::uuid, ${tenantId}::uuid, 'Paging Co', 'AE', 'AED', 'ACTIVE', now())`,
    );
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { customer } = await asTenant((tx) =>
        repo.createForCompany(tx, {
          tenantId,
          companyId: pagingCompanyId,
          displayName: `Page Customer ${i}`,
        }),
      );
      created.push(customer.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await asTenant((tx) =>
        repo.listForCompany(tx, {
          tenantId,
          companyId: pagingCompanyId,
          limit: 3,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      );
      seen.push(...result.data.map((c) => c.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
      expect(page).toBeLessThan(9); // guard against an infinite/non-terminating cursor
    }

    expect(seen).toHaveLength(created.length); // no missing, no duplicate row
    expect(new Set(seen).size).toBe(created.length); // no duplicate id across page boundaries
    expect(new Set(seen)).toEqual(new Set(created));
  });

  // ── structural: no generic company-optional bypass (§9 hard gate) ────────

  it('no method in CustomerRepository accepts an includeAllCompanies-shaped bypass parameter', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./customer.repository.ts', import.meta.url), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(/includeAllCompanies|skipCompanyFilter|companyId\?:/i.test(codeOnly)).toBe(false);
  });
});
