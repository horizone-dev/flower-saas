import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising the repository's tx-taking methods and
// real concurrent-transaction locking directly (two raw connections/transactions
// coordinated to prove the FOR SHARE/FOR UPDATE race, docs/phase-3/
// PHASE-3B-PLAN.md §J) — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import pg from 'pg';
import { AccountRepository } from './account.repository.js';
import { AccountingPeriodRepository } from './accounting-period.repository.js';
import { CompanyFinancialConfigRepository } from './company-financial-config.repository.js';
import { PostingEngineService } from './posting-engine.service.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';
import type { SystemClock } from '../../common/clock/clock.js';

/**
 * Task 3b.1 — `AccountingPeriodRepository` against real Postgres: basic
 * create/close semantics, the exclusion-constraint overlap guard (regression
 * coverage for a Prisma-7/`@prisma/adapter-pg` error-shape bug found and fixed
 * in this checkpoint — unrecognised driver errors surface as `P2039` with the
 * real SQLSTATE nested at `meta.driverAdapterError.cause.originalCode`, not a
 * bare SQLSTATE on `err.code`), and the period-close-vs-posting concurrency
 * race described in docs/phase-3/PHASE-3B-PLAN.md §J (two real DB connections,
 * proving the `FOR SHARE`/`FOR UPDATE` interaction resolves deterministically
 * in both lock-acquisition orders).
 */
describe('AccountingPeriodRepository (task 3b.1, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;

  const tenantId = randomUUID();
  let companyId = '';

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runScoped(prisma, { tenantId }, fn);
  }

  async function mkCompany(): Promise<string> {
    const id = randomUUID();
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", "accountingTimezone", status, "updatedAt")
         VALUES ($1, $2, 'x', 'AE', 'AED', 'Asia/Dubai', 'ACTIVE', now())`,
        [id, tenantId],
      );
    } finally {
      await c.end();
    }
    await asTenant((tx) => accounts.ensureDefaultAccounts(tx, { tenantId, companyId: id }));
    return id;
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    const dummyDb = {} as unknown as DbService;
    accounts = new AccountRepository(dummyDb, new AuditWriter(dummyDb));
    periods = new AccountingPeriodRepository(dummyDb, new AuditWriter(dummyDb));

    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const planId = randomUUID();
      const planVersionId = randomUUID();
      await c.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
        planId,
        `period-test-plan-${planId.slice(0, 8)}`,
      ]);
      await c.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
         VALUES ($1, $2, 1, 'PUBLISHED', now())`,
        [planVersionId, planId],
      );
      await c.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [tenantId, `period-test-${tenantId.slice(0, 8)}`, planVersionId],
      );
      await c.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x') ON CONFLICT (code) DO NOTHING`,
      );
      await c.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "defaultTimezone", "updatedAt")
         VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', 'Asia/Dubai', now())
         ON CONFLICT (code) DO NOTHING`,
      );
    } finally {
      await c.end();
    }
    companyId = await mkCompany();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await stack?.stop();
  });

  it('creates a period', async () => {
    const p = await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId,
        startDate: new Date('2030-01-01'),
        endDate: new Date('2030-01-31'),
      }),
    );
    expect(p.status).toBe('OPEN');
    expect(p.version).toBe(1);
  });

  it('rejects an overlapping period with ACCOUNTING_PERIOD_OVERLAP (DB exclusion constraint)', async () => {
    await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId,
        startDate: new Date('2030-03-01'),
        endDate: new Date('2030-03-31'),
      }),
    );
    await expect(
      asTenant((tx) =>
        periods.create(tx, {
          tenantId,
          companyId,
          startDate: new Date('2030-03-15'),
          endDate: new Date('2030-04-15'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_OVERLAP' });
  });

  it('rejects startDate > endDate with a friendly VALIDATION_FAILED before hitting the DB', async () => {
    await expect(
      asTenant((tx) =>
        periods.create(tx, {
          tenantId,
          companyId,
          startDate: new Date('2030-06-30'),
          endDate: new Date('2030-06-01'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('closes an OPEN period; a retry with the same expectedVersion is an idempotent success', async () => {
    const p = await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId,
        startDate: new Date('2030-05-01'),
        endDate: new Date('2030-05-31'),
      }),
    );
    const closed = await asTenant((tx) =>
      periods.close(tx, {
        tenantId,
        companyId,
        id: p.id,
        expectedVersion: p.version,
        closedByUserId: null,
      }),
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.version).toBe(2);

    // idempotent retry — same expectedVersion as the ORIGINAL request, not a hard error
    const retried = await asTenant((tx) =>
      periods.close(tx, {
        tenantId,
        companyId,
        id: p.id,
        expectedVersion: p.version,
        closedByUserId: null,
      }),
    );
    expect(retried.status).toBe('CLOSED');
    expect(retried.version).toBe(2);
  });

  it('rejects a genuine version conflict on an OPEN period', async () => {
    const p = await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId,
        startDate: new Date('2030-07-01'),
        endDate: new Date('2030-07-31'),
      }),
    );
    await expect(
      asTenant((tx) =>
        periods.close(tx, {
          tenantId,
          companyId,
          id: p.id,
          expectedVersion: p.version + 5,
          closedByUserId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_VERSION_CONFLICT' });
  });

  describe('period-close-vs-posting concurrency (§J)', () => {
    function engineAt(iso: string): PostingEngineService {
      const fakeClock = { now: () => new Date(iso) } as unknown as SystemClock;
      const dummyDb = {} as unknown as DbService;
      return new PostingEngineService(
        new CompanyFinancialConfigRepository(dummyDb, new AuditWriter(dummyDb), accounts),
        periods,
        new AuditWriter(dummyDb),
        fakeClock,
      );
    }
    const balancedLines = () => [
      { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit' as const, amountMinor: 500n },
      { accountKey: 'REVENUE.SALES', direction: 'credit' as const, amountMinor: 500n },
    ];

    it('posting acquires FOR SHARE first — a concurrent close blocks, then posting succeeds', async () => {
      const raceCompanyId = await mkCompany();
      const period = await asTenant((tx) =>
        periods.create(tx, {
          tenantId,
          companyId: raceCompanyId,
          startDate: new Date('2030-08-01'),
          endDate: new Date('2030-08-31'),
        }),
      );
      const engine = engineAt('2030-08-15T10:00:00Z');

      // Hold the posting's own interactive transaction open past its
      // `findOpenForPostingDate` FOR SHARE lock acquisition, using a manual
      // barrier so the close attempt starts only once the lock is held.
      let releasePostingLock: () => void = () => {};
      const lockHeld = new Promise<void>((resolve) => {
        releasePostingLock = resolve;
      });
      let lockAcquired: () => void = () => {};
      const lockAcquiredPromise = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });

      const postingPromise = asTenant(async (tx) => {
        const result = await engine.postJournal(tx, {
          tenantId,
          companyId: raceCompanyId,
          sourceKind: 'RACE_A',
          sourceId: randomUUID(),
          lines: balancedLines(),
        });
        lockAcquired(); // the FOR SHARE lock inside findOpenForPostingDate has already
        // been taken and released back to statement scope by the time postJournal
        // returns within this same still-open interactive transaction's snapshot;
        // signal the close attempt to proceed, then hold this transaction open.
        await lockHeld;
        return result;
      });

      await lockAcquiredPromise;
      const closeClient = new pg.Client({ connectionString: stack.postgres.url });
      await closeClient.connect();
      let closeBlockedThenProceeded: boolean;
      try {
        await closeClient.query('BEGIN');
        const closeStart = Date.now();
        // FOR UPDATE conflicts with posting's held FOR SHARE — this blocks
        // until posting's interactive transaction commits or rolls back.
        const closeLockPromise = closeClient.query(
          `SELECT * FROM "accounting_period" WHERE id = $1 FOR UPDATE`,
          [period.id],
        );
        // give the close attempt time to actually start and block before releasing
        await new Promise((r) => setTimeout(r, 400));
        releasePostingLock();
        const result = await postingPromise;
        expect(result.created).toBe(true);

        await closeLockPromise;
        closeBlockedThenProceeded = Date.now() - closeStart >= 150;
        await closeClient.query(
          `UPDATE "accounting_period" SET status = 'CLOSED', "closedAt" = now(), version = version + 1 WHERE id = $1`,
          [period.id],
        );
        await closeClient.query('COMMIT');
      } finally {
        await closeClient.query('ROLLBACK').catch(() => undefined);
        await closeClient.end();
      }
      expect(closeBlockedThenProceeded).toBe(true);

      const finalPeriod = await asTenant((tx) =>
        tx.accountingPeriod.findUniqueOrThrow({ where: { id: period.id } }),
      );
      // close only proceeded (and committed) AFTER posting's transaction ended
      expect(finalPeriod.status).toBe('CLOSED');
    });

    it('close acquires FOR UPDATE first — a concurrent posting blocks, then fails ACCOUNTING_PERIOD_CLOSED', async () => {
      const raceCompanyId = await mkCompany();
      const period = await asTenant((tx) =>
        periods.create(tx, {
          tenantId,
          companyId: raceCompanyId,
          startDate: new Date('2030-09-01'),
          endDate: new Date('2030-09-30'),
        }),
      );
      const engine = engineAt('2030-09-15T10:00:00Z');

      const holder = new pg.Client({ connectionString: stack.postgres.url });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT * FROM "accounting_period" WHERE id = $1 FOR UPDATE`, [
          period.id,
        ]);

        const postingAttempt = asTenant((tx) =>
          engine.postJournal(tx, {
            tenantId,
            companyId: raceCompanyId,
            sourceKind: 'RACE_B',
            sourceId: randomUUID(),
            lines: balancedLines(),
          }),
        );

        // give the posting attempt time to block on the held FOR UPDATE lock
        await new Promise((r) => setTimeout(r, 600));
        await holder.query(
          `UPDATE "accounting_period" SET status = 'CLOSED', "closedAt" = now(), version = version + 1 WHERE id = $1`,
          [period.id],
        );
        await holder.query('COMMIT');

        await expect(postingAttempt).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSED' });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    });
  });
});
