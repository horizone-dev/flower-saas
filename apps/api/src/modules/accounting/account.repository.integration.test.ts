import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising the repository's tx-taking methods
// directly against a real Postgres — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped, ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import { AccountRepository } from './account.repository.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';

/**
 * Task 3b.1 — `AccountRepository.ensureDefaultAccounts` (existing-company CoA
 * bootstrap). Exercises the repository directly against a real Postgres, the
 * same layer the future Accounting Setup service/controller will call into
 * unchanged (no HTTP surface exists yet — Checkpoint C).
 */
describe('AccountRepository.ensureDefaultAccounts (task 3b.1, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let repo: AccountRepository;

  const tenantId = randomUUID();
  let companyId = '';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);

    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    repo = new AccountRepository(
      {} as unknown as DbService,
      new AuditWriter({} as unknown as DbService),
    );

    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const planId = randomUUID();
      const planVersionId = randomUUID();
      await c.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
        planId,
        `accounting-test-plan-${planId.slice(0, 8)}`,
      ]);
      await c.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
         VALUES ($1, $2, 1, 'PUBLISHED', now())`,
        [planVersionId, planId],
      );
      await c.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [tenantId, `accounting-test-${tenantId.slice(0, 8)}`, planVersionId],
      );
      await c.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x')
         ON CONFLICT (code) DO NOTHING`,
      );
      await c.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
         VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', now())
         ON CONFLICT (code) DO NOTHING`,
      );
      companyId = randomUUID();
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", status, "updatedAt")
         VALUES ($1, $2, 'Test Co', 'AE', 'AED', 'ACTIVE', now())`,
        [companyId, tenantId],
      );
    } finally {
      await c.end();
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await stack?.stop();
  });

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runScoped(prisma, { tenantId }, fn);
  }

  it('inserts all 14 reference accounts on the first call', async () => {
    const { insertedCount } = await asTenant((tx) =>
      repo.ensureDefaultAccounts(tx, { tenantId, companyId }),
    );
    expect(insertedCount).toBe(14);

    const rows = await asTenant((tx) =>
      tx.account.findMany({ where: { tenantId, companyId }, orderBy: { key: 'asc' } }),
    );
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((r) => r.key))).toEqual(
      new Set(ACCOUNTING_REFERENCE_ACCOUNTS.map((a) => a.key)),
    );
  });

  it('is idempotent — a second call inserts zero rows and creates no duplicates', async () => {
    const { insertedCount } = await asTenant((tx) =>
      repo.ensureDefaultAccounts(tx, { tenantId, companyId }),
    );
    expect(insertedCount).toBe(0);

    const rows = await asTenant((tx) => tx.account.findMany({ where: { tenantId, companyId } }));
    expect(rows).toHaveLength(14);
  });

  it("never overwrites an existing account's displayCode/displayName customization", async () => {
    const customCompanyId = randomUUID();
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", status, "updatedAt")
         VALUES ($1, $2, 'Custom Co', 'AE', 'AED', 'ACTIVE', now())`,
        [customCompanyId, tenantId],
      );
    } finally {
      await c.end();
    }

    // pre-insert one customized account row before bootstrap ever runs
    await asTenant((tx) =>
      tx.account.create({
        data: {
          tenantId,
          companyId: customCompanyId,
          key: 'ASSET.CASH_ON_HAND',
          category: 'ASSET',
          displayCode: 'CUSTOM-1000',
          displayName: 'Till Cash (customized)',
        },
      }),
    );

    const { insertedCount } = await asTenant((tx) =>
      repo.ensureDefaultAccounts(tx, { tenantId, companyId: customCompanyId }),
    );
    expect(insertedCount).toBe(13); // the 13 missing keys — not the pre-existing one

    const rows = await asTenant((tx) =>
      tx.account.findMany({ where: { tenantId, companyId: customCompanyId } }),
    );
    expect(rows).toHaveLength(14);
    const cash = rows.find((r) => r.key === 'ASSET.CASH_ON_HAND');
    expect(cash?.displayCode).toBe('CUSTOM-1000');
    expect(cash?.displayName).toBe('Till Cash (customized)');
  });

  describe('updateDisplay', () => {
    it('updates displayCode/displayName and rejects a stale expectedUpdatedAt', async () => {
      const rows = await asTenant((tx) => tx.account.findMany({ where: { tenantId, companyId } }));
      const target = rows.find((r) => r.key === 'ASSET.BANK')!;
      const updated = await asTenant((tx) =>
        repo.updateDisplay(tx, {
          tenantId,
          companyId,
          id: target.id,
          displayCode: 'BANK-01',
          expectedUpdatedAt: target.updatedAt,
        }),
      );
      expect(updated.displayCode).toBe('BANK-01');

      await expect(
        asTenant((tx) =>
          repo.updateDisplay(tx, {
            tenantId,
            companyId,
            id: target.id,
            displayName: 'stale attempt',
            expectedUpdatedAt: target.updatedAt, // stale — already updated above
          }),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_VERSION_CONFLICT' });
    });

    it('rejects renaming displayCode to one already used by another account in the same company', async () => {
      const rows = await asTenant((tx) => tx.account.findMany({ where: { tenantId, companyId } }));
      const [a, b] = rows.filter((r) => r.key !== 'ASSET.BANK');
      await expect(
        asTenant((tx) =>
          repo.updateDisplay(tx, {
            tenantId,
            companyId,
            id: b!.id,
            displayCode: a!.displayCode,
            expectedUpdatedAt: b!.updatedAt,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_DISPLAY_CODE_CONFLICT' });
    });
  });
});
