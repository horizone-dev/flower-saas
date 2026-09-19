import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.2 (CRM / Customer Core) — the `customer` / `customer_company_account`
 * schema, proven against real Postgres via raw SQL: RLS enable+force+policy,
 * the Money-snapshot all-or-nothing CHECK, the positive-credit-limit CHECK,
 * the `status` CHECK, and the composite tenant-safe FKs (an association
 * cannot reference a customer/company from a different tenant).
 *
 * Uses the plain Testcontainers superuser connection (bypasses RLS as the
 * table owner, exactly like `accounting-schema.integration.test.ts`'s own
 * fixture) — RLS itself is verified separately below.
 */
const TENANT = '1a1a1a1a-1a1a-71a1-81a1-1a1a1a1a1a1a';
const OTHER_TENANT = '2b2b2b2b-2b2b-72b2-82b2-2b2b2b2b2b2b';
const COMPANY = '3c3c3c3c-3c3c-73c3-83c3-3c3c3c3c3c3c';
const OTHER_TENANT_COMPANY = '4d4d4d4d-4d4d-74d4-84d4-4d4d4d4d4d4d';

describe('packages/db — Task 3b.2 customer core schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    const url = container.getConnectionUri();
    execFileSync(
      'node',
      [path.join(pkgDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    pool = new pg.Pool({ connectionString: url });

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002',
               '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'cust-3b2', 'cust-3b2', 'AE', 'ACTIVE',
               '00000000-0000-7000-8000-000000000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'cust-3b2-other', 'cust-3b2-other', 'AE', 'ACTIVE',
               '00000000-0000-7000-8000-000000000002', now())`,
      [OTHER_TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'د.إ', 'UAE Dirham', 'درهم إماراتي') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Test Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Other Tenant Co', 'AED', 'Asia/Dubai', now())`,
      [OTHER_TENANT_COMPANY, OTHER_TENANT],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function insertCustomer(overrides: { id: string; tenantId?: string }): Promise<void> {
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Test Customer', now())`,
      [overrides.id, overrides.tenantId ?? TENANT],
    );
  }

  it('RLS: customer / customer_company_account both have ENABLE + FORCE + a tenant-isolation policy', async () => {
    const { rows } = await pool.query<{
      relname: string;
      rls: boolean;
      force: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
         FROM pg_class c WHERE c.relname = ANY($1)`,
      [['customer', 'customer_company_account']],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.rls, `${r.relname}: RLS not enabled`).toBe(true);
      expect(r.force, `${r.relname}: RLS not FORCEd`).toBe(true);
      expect(Number(r.policies), `${r.relname}: no policy`).toBeGreaterThanOrEqual(1);
    }
  });

  it('customer.status CHECK rejects an invalid value', async () => {
    await expect(
      pool.query(
        `INSERT INTO customer (id, "tenantId", "displayName", status, "updatedAt")
         VALUES (gen_random_uuid(), $1, 'Bad Status', 'DELETED', now())`,
        [TENANT],
      ),
    ).rejects.toThrow(/customer_status_chk|violates check constraint/i);
  });

  it('customer.status accepts ACTIVE and ARCHIVED', async () => {
    for (const status of ['ACTIVE', 'ARCHIVED']) {
      const id = crypto.randomUUID();
      await expect(
        pool.query(
          `INSERT INTO customer (id, "tenantId", "displayName", status, "updatedAt")
           VALUES ($1, $2, 'OK Status', $3, now())`,
          [id, TENANT, status],
        ),
      ).resolves.toBeTruthy();
    }
  });

  it('customer_company_account: Money-snapshot all-or-nothing CHECK rejects a partial set', async () => {
    const customerId = crypto.randomUUID();
    await insertCustomer({ id: customerId });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditLimitMinor", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 10000, now())`,
        [TENANT, COMPANY, customerId],
      ),
    ).rejects.toThrow(/credit_limit_money_shape_chk|violates check constraint/i);
  });

  it('customer_company_account: Money-snapshot accepts all-null and all-present', async () => {
    const customerAllNull = crypto.randomUUID();
    await insertCustomer({ id: customerAllNull });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [TENANT, COMPANY, customerAllNull],
      ),
    ).resolves.toBeTruthy();

    const customerAllPresent = crypto.randomUUID();
    await insertCustomer({ id: customerAllPresent });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled",
            "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, 500000, 'AED', 2, now())`,
        [TENANT, COMPANY, customerAllPresent],
      ),
    ).resolves.toBeTruthy();
  });

  it('customer_company_account: creditLimitMinor > 0 CHECK rejects zero and negative, accepts positive and NULL', async () => {
    const zeroCustomer = crypto.randomUUID();
    await insertCustomer({ id: zeroCustomer });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId",
            "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 0, 'AED', 2, now())`,
        [TENANT, COMPANY, zeroCustomer],
      ),
    ).rejects.toThrow(/credit_limit_positive_chk|violates check constraint/i);

    const negativeCustomer = crypto.randomUUID();
    await insertCustomer({ id: negativeCustomer });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId",
            "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, -100, 'AED', 2, now())`,
        [TENANT, COMPANY, negativeCustomer],
      ),
    ).rejects.toThrow(/credit_limit_positive_chk|violates check constraint/i);
  });

  it('customer_company_account: UNIQUE(tenantId, companyId, customerId) prevents a duplicate association', async () => {
    const customerId = crypto.randomUUID();
    await insertCustomer({ id: customerId });
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [TENANT, COMPANY, customerId],
    );
    await expect(
      pool.query(
        `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [TENANT, COMPANY, customerId],
      ),
    ).rejects.toThrow(/customer_company_account_tenantId_companyId_customerId_key|duplicate key/i);
  });

  it('a customer_company_account cannot reference a customer from a different tenant (composite FK)', async () => {
    const otherTenantCustomer = crypto.randomUUID();
    await insertCustomer({ id: otherTenantCustomer, tenantId: OTHER_TENANT });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [TENANT, COMPANY, otherTenantCustomer], // wrong tenant for this customer
      ),
    ).rejects.toThrow(/customer_company_account_customer_tenant_fkey|violates foreign key/i);
  });

  it('a customer_company_account cannot reference a company from a different tenant (composite FK)', async () => {
    const customerId = crypto.randomUUID();
    await insertCustomer({ id: customerId });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [TENANT, OTHER_TENANT_COMPANY, customerId], // wrong tenant for this company
      ),
    ).rejects.toThrow(/customer_company_account_company_tenant_fkey|violates foreign key/i);
  });

  it('creditEnabled=false is allowed with no stored limit, and with a valid retained positive limit', async () => {
    const disabledNoLimit = crypto.randomUUID();
    await insertCustomer({ id: disabledNoLimit });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, false, now())`,
        [TENANT, COMPANY, disabledNoLimit],
      ),
    ).resolves.toBeTruthy();

    const disabledRetainedLimit = crypto.randomUUID();
    await insertCustomer({ id: disabledRetainedLimit });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled",
            "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, false, 500000, 'AED', 2, now())`,
        [TENANT, COMPANY, disabledRetainedLimit],
      ),
    ).resolves.toBeTruthy();
  });

  it('creditEnabled=true requires a configured credit-limit Money snapshot (new CHECK) — accepts a valid complete limit, rejects all-NULL', async () => {
    const enabledComplete = crypto.randomUUID();
    await insertCustomer({ id: enabledComplete });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled",
            "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, 250000, 'AED', 2, now())`,
        [TENANT, COMPANY, enabledComplete],
      ),
    ).resolves.toBeTruthy();

    const enabledNoLimit = crypto.randomUUID();
    await insertCustomer({ id: enabledNoLimit });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, now())`,
        [TENANT, COMPANY, enabledNoLimit],
      ),
    ).rejects.toThrow(/credit_enabled_requires_limit_chk|violates check constraint/i);
  });

  it('creditEnabled=true with partial Money is rejected (by the pre-existing money-shape CHECK)', async () => {
    const customerId = crypto.randomUUID();
    await insertCustomer({ id: customerId });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled", "creditLimitMinor", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, 100000, now())`,
        [TENANT, COMPANY, customerId],
      ),
    ).rejects.toThrow(/credit_limit_money_shape_chk|violates check constraint/i);
  });

  it('creditEnabled=true with a zero or negative limit is rejected (by the pre-existing positive CHECK)', async () => {
    const zeroCustomer = crypto.randomUUID();
    await insertCustomer({ id: zeroCustomer });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled",
            "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, 0, 'AED', 2, now())`,
        [TENANT, COMPANY, zeroCustomer],
      ),
    ).rejects.toThrow(/credit_limit_positive_chk|violates check constraint/i);

    const negativeCustomer = crypto.randomUUID();
    await insertCustomer({ id: negativeCustomer });
    await expect(
      pool.query(
        `INSERT INTO customer_company_account
           (id, "tenantId", "companyId", "customerId", "creditEnabled",
            "creditLimitMinor", "creditLimitCurrencyCode", "creditLimitCurrencyExponent", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, -100, 'AED', 2, now())`,
        [TENANT, COMPANY, negativeCustomer],
      ),
    ).rejects.toThrow(/credit_limit_positive_chk|violates check constraint/i);
  });
});
