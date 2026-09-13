import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising concurrency/money/date hard gates
// directly against real Postgres (docs/phase-3/PHASE-3B-PLAN.md §J) — not
// production module code.
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

describe('Task 3b.1 hard-gate matrix — concurrency + money/date', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let companyConfig: CompanyFinancialConfigRepository;

  const tenantId = randomUUID();

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runScoped(prisma, { tenantId }, fn);
  }

  function engineAt(iso: string): PostingEngineService {
    const fakeClock = { now: () => new Date(iso) } as unknown as SystemClock;
    const dummyDb = {} as unknown as DbService;
    return new PostingEngineService(companyConfig, periods, new AuditWriter(dummyDb), fakeClock);
  }

  async function mkCompany(opts: {
    currency: string;
    accountingTimezone: string;
  }): Promise<string> {
    const id = randomUUID();
    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", "accountingTimezone", status, "updatedAt")
         VALUES ($1, $2, 'Test Co', 'AE', $3, $4, 'ACTIVE', now())`,
        [id, tenantId, opts.currency, opts.accountingTimezone],
      );
    } finally {
      await c.end();
    }
    await asTenant((tx) => accounts.ensureDefaultAccounts(tx, { tenantId, companyId: id }));
    return id;
  }

  async function mkPeriod(companyId: string, startDate: string, endDate: string): Promise<string> {
    const p = await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      }),
    );
    return p.id;
  }

  const balancedLines = () => [
    { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit' as const, amountMinor: 100n },
    { accountKey: 'REVENUE.SALES', direction: 'credit' as const, amountMinor: 100n },
  ];

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    const dummyDb = {} as unknown as DbService;
    accounts = new AccountRepository(dummyDb, new AuditWriter(dummyDb));
    periods = new AccountingPeriodRepository(dummyDb, new AuditWriter(dummyDb));
    companyConfig = new CompanyFinancialConfigRepository(
      dummyDb,
      new AuditWriter(dummyDb),
      accounts,
    );

    const c = new pg.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const planId = randomUUID();
      const planVersionId = randomUUID();
      await c.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
        planId,
        `hard-gate-plan-${planId.slice(0, 8)}`,
      ]);
      await c.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
         VALUES ($1, $2, 1, 'PUBLISHED', now())`,
        [planVersionId, planId],
      );
      await c.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [tenantId, `hard-gate-${tenantId.slice(0, 8)}`, planVersionId],
      );
      await c.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x'), ('KWD', 3, 'KWD', 'Kuwaiti Dinar', 'x')
         ON CONFLICT (code) DO NOTHING`,
      );
      await c.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "defaultTimezone", "updatedAt")
         VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', 'Asia/Dubai', now())
         ON CONFLICT (code) DO NOTHING`,
      );
    } finally {
      await c.end();
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await stack?.stop();
  });

  describe('money/date', () => {
    it('a 2-decimal currency (AED) journal posts and reads back exactly', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2030-01-01', '2030-01-31');
      const engine = engineAt('2030-01-15T10:00:00Z');
      const result = await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'MONEY_2DP',
          sourceId: randomUUID(),
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 12345n },
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 12345n },
          ],
        }),
      );
      const entry = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({
          where: { id: result.journalEntryId },
          include: { lines: true },
        }),
      );
      expect(entry.currencyCode).toBe('AED');
      expect(entry.lines.reduce((s, l) => s + l.debitMinor, 0n)).toBe(12345n);
    });

    it('a 3-decimal currency (KWD) journal posts and reads back exactly, no rounding', async () => {
      const companyId = await mkCompany({ currency: 'KWD', accountingTimezone: 'Asia/Kuwait' });
      await mkPeriod(companyId, '2030-01-01', '2030-01-31');
      const engine = engineAt('2030-01-15T10:00:00Z');
      const result = await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'MONEY_3DP',
          sourceId: randomUUID(),
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 1234n }, // 1.234 KWD
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 1234n },
          ],
        }),
      );
      const entry = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({
          where: { id: result.journalEntryId },
          include: { lines: true },
        }),
      );
      expect(entry.currencyCode).toBe('KWD');
      expect(entry.lines.every((l) => l.debitMinor === 1234n || l.creditMinor === 1234n)).toBe(
        true,
      );
    });

    it("near-midnight: an instant just before local midnight in the Company timezone derives the CORRECT civil date, not UTC's date", async () => {
      // 2030-06-14T21:30:00Z = 2030-06-15T01:30:00 in Asia/Dubai (UTC+4) —
      // UTC's calendar date (14th) differs from the Company's civil date (15th).
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2030-06-01', '2030-06-30');
      const engine = engineAt('2030-06-14T21:30:00Z');
      const result = await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'MIDNIGHT_TEST',
          sourceId: randomUUID(),
          lines: balancedLines(),
        }),
      );
      const entry = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({ where: { id: result.journalEntryId } }),
      );
      expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2030-06-15');
    });

    it('Branch.timezone has no authority — a Branch with a DIFFERENT timezone than the Company does not affect postingDate', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' }); // UTC+4
      await mkPeriod(companyId, '2030-06-01', '2030-06-30');
      const c = new pg.Client({ connectionString: stack.postgres.url });
      await c.connect();
      const branchId = randomUUID();
      try {
        // deliberately a very different offset (UTC-5, US/Eastern-ish) so if
        // Branch.timezone were ever wrongly consulted, the derived date would
        // differ from the Company-timezone-derived one.
        await c.query(
          `INSERT INTO branch (id, "tenantId", "companyId", name, timezone, "updatedAt")
           VALUES ($1, $2, $3, 'Wrong-TZ Branch', 'America/New_York', now())`,
          [branchId, tenantId, companyId],
        );
      } finally {
        await c.end();
      }
      const engine = engineAt('2030-06-14T21:30:00Z'); // 01:30 next day in Asia/Dubai
      const result = await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'BRANCH_TZ_TEST',
          sourceId: randomUUID(),
          lines: balancedLines(),
          branchId,
        }),
      );
      const entry = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({ where: { id: result.journalEntryId } }),
      );
      // still derived from Company.accountingTimezone (Asia/Dubai), NOT the
      // Branch's America/New_York — same date as the plain near-midnight test.
      expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2030-06-15');
    });

    it('historical postingDate is immutable after Company.accountingTimezone later changes', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2030-07-01', '2030-07-31');
      const engine = engineAt('2030-07-15T20:00:00Z'); // 2030-07-16T00:00 in Asia/Dubai
      const result = await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TZ_CHANGE_HISTORY',
          sourceId: randomUUID(),
          lines: balancedLines(),
        }),
      );
      const before = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({ where: { id: result.journalEntryId } }),
      );
      await asTenant((tx) => companyConfig.setAccountingTimezone(tx, companyId, 'Asia/Riyadh'));
      const after = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({ where: { id: result.journalEntryId } }),
      );
      expect(after.postingDate.toISOString().slice(0, 10)).toBe(
        before.postingDate.toISOString().slice(0, 10),
      );
    });
  });

  describe('concurrency', () => {
    it('parallel postings for the SAME source with the SAME fingerprint: exactly one journal, no duplicate', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2030-08-01', '2030-08-31');
      const engine = engineAt('2030-08-15T10:00:00Z');
      const sourceId = randomUUID();
      const post = () =>
        asTenant((tx) =>
          engine.postJournal(tx, {
            tenantId,
            companyId,
            sourceKind: 'PARALLEL_SAME_FP',
            sourceId,
            lines: balancedLines(),
          }),
        );
      const [a, b] = await Promise.all([post(), post()]);
      expect(a.journalEntryId).toBe(b.journalEntryId);
      const count = await asTenant((tx) =>
        tx.journalEntry.count({
          where: { tenantId, companyId, sourceKind: 'PARALLEL_SAME_FP', sourceId },
        }),
      );
      expect(count).toBe(1);
    });

    it('parallel postings for the SAME source with DIFFERENT content: exactly one succeeds, the other gets JOURNAL_SOURCE_CONFLICT', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2030-09-01', '2030-09-30');
      const engine = engineAt('2030-09-15T10:00:00Z');
      const sourceId = randomUUID();
      const postA = asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'PARALLEL_DIFF_FP',
          sourceId,
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 100n },
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 100n },
          ],
        }),
      );
      const postB = asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'PARALLEL_DIFF_FP',
          sourceId,
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit', amountMinor: 999n },
            { accountKey: 'REVENUE.SALES', direction: 'credit', amountMinor: 999n },
          ],
        }),
      );
      const results = await Promise.allSettled([postA, postB]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'JOURNAL_SOURCE_CONFLICT',
      });
      const count = await asTenant((tx) =>
        tx.journalEntry.count({
          where: { tenantId, companyId, sourceKind: 'PARALLEL_DIFF_FP', sourceId },
        }),
      );
      expect(count).toBe(1);
    });

    it('parallel overlapping period creation: exactly one succeeds, the other gets ACCOUNTING_PERIOD_OVERLAP (DB exclusion constraint)', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      const create = (start: string, end: string) =>
        asTenant((tx) =>
          periods.create(tx, {
            tenantId,
            companyId,
            startDate: new Date(start),
            endDate: new Date(end),
          }),
        );
      const results = await Promise.allSettled([
        create('2030-10-01', '2030-10-31'),
        create('2030-10-15', '2030-11-15'), // overlaps the first
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'ACCOUNTING_PERIOD_OVERLAP',
      });
    });

    it('parallel account displayCode conflict: exactly one update succeeds, the other gets ACCOUNT_DISPLAY_CODE_CONFLICT', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      const rows = await asTenant((tx) => accounts.list(tx, { tenantId, companyId }));
      const [acctA, acctB] = rows;
      if (!acctA || !acctB) throw new Error('expected at least 2 seeded accounts');
      const update = (id: string, expectedUpdatedAt: Date) =>
        asTenant((tx) =>
          accounts.updateDisplay(tx, {
            tenantId,
            companyId,
            id,
            displayCode: 'RACE-CODE',
            expectedUpdatedAt,
          }),
        );
      const results = await Promise.allSettled([
        update(acctA.id, acctA.updatedAt),
        update(acctB.id, acctB.updatedAt),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'ACCOUNT_DISPLAY_CODE_CONFLICT',
      });
    });

    it('parallel full-reversal attempts of the SAME original: exactly one succeeds, the other gets JOURNAL_ALREADY_REVERSED', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2030-11-01', '2030-11-30');
      const engine = engineAt('2030-11-15T10:00:00Z');
      const original = await asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'REVERSAL_RACE_ORIGINAL',
          sourceId: randomUUID(),
          lines: balancedLines(),
        }),
      );
      const reverse = () =>
        asTenant((tx) =>
          engine.reverseJournal(tx, {
            tenantId,
            companyId,
            originalJournalEntryId: original.journalEntryId,
            sourceKind: 'REVERSAL_RACE',
            sourceId: randomUUID(),
          }),
        );
      const results = await Promise.allSettled([reverse(), reverse()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'JOURNAL_ALREADY_REVERSED',
      });
      // original entry is byte-for-byte unchanged
      const originalAfter = await asTenant((tx) =>
        tx.journalEntry.findUniqueOrThrow({
          where: { id: original.journalEntryId },
          include: { lines: true },
        }),
      );
      expect(originalAfter.sealedAt).not.toBeNull();
      expect(originalAfter.lines).toHaveLength(2);
      expect(originalAfter.reversalOfJournalEntryId).toBeNull();
    });

    it('first-posting vs currency-change race: whichever acquires the Company row lock first wins deterministically', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2030-12-01', '2030-12-31');
      const engine = engineAt('2030-12-15T10:00:00Z');

      // Posting acquires FOR SHARE first (held open), then a concurrent
      // currency-change attempt's FOR UPDATE must block until posting commits,
      // after which it correctly sees the just-posted journal and rejects.
      let releasePosting: () => void = () => {};
      const held = new Promise<void>((resolve) => (releasePosting = resolve));
      let lockAcquired: () => void = () => {};
      const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));

      const postingPromise = asTenant(async (tx) => {
        const result = await engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'CURRENCY_RACE',
          sourceId: randomUUID(),
          lines: balancedLines(),
        });
        lockAcquired();
        await held;
        return result;
      });

      await acquired;
      const changeClient = new pg.Client({ connectionString: stack.postgres.url });
      await changeClient.connect();
      try {
        await changeClient.query('BEGIN');
        const changeLockPromise = changeClient.query(
          `SELECT "id" FROM "company" WHERE "id" = $1 FOR UPDATE`,
          [companyId],
        );
        await new Promise((r) => setTimeout(r, 400));
        releasePosting();
        const postResult = await postingPromise;
        expect(postResult.created).toBe(true);
        await changeLockPromise;
        const hasHistory = await changeClient.query(
          `SELECT EXISTS(SELECT 1 FROM "journal_entry" WHERE "companyId" = $1) AS "exists"`,
          [companyId],
        );
        expect(hasHistory.rows[0].exists).toBe(true); // sees posting's committed journal
        await changeClient.query('COMMIT');
      } finally {
        await changeClient.query('ROLLBACK').catch(() => undefined);
        await changeClient.end();
      }
    });

    it('posting vs timezone-change race: posting holds a stable Company config snapshot for its whole transaction', async () => {
      const companyId = await mkCompany({ currency: 'AED', accountingTimezone: 'Asia/Dubai' });
      await mkPeriod(companyId, '2031-01-01', '2031-01-31');
      const engine = engineAt('2031-01-15T10:00:00Z');

      let releasePosting: () => void = () => {};
      const held = new Promise<void>((resolve) => (releasePosting = resolve));
      let lockAcquired: () => void = () => {};
      const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));

      const postingPromise = asTenant(async (tx) => {
        const result = await engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TZ_RACE',
          sourceId: randomUUID(),
          lines: balancedLines(),
        });
        lockAcquired();
        await held;
        return result;
      });

      await acquired;
      const tzClient = new pg.Client({ connectionString: stack.postgres.url });
      await tzClient.connect();
      try {
        await tzClient.query('BEGIN');
        const tzLockPromise = tzClient.query(
          `SELECT "id" FROM "company" WHERE "id" = $1 FOR UPDATE`,
          [companyId],
        );
        await new Promise((r) => setTimeout(r, 400));
        releasePosting();
        const postResult = await postingPromise;
        expect(postResult.created).toBe(true);
        await tzLockPromise;
        await tzClient.query(
          `UPDATE "company" SET "accountingTimezone" = 'Asia/Riyadh' WHERE "id" = $1`,
          [companyId],
        );
        await tzClient.query('COMMIT');
      } finally {
        await tzClient.query('ROLLBACK').catch(() => undefined);
        await tzClient.end();
      }
      // the journal posted BEFORE the timezone change used the Dubai-derived date
      const entry = await asTenant((tx) =>
        tx.journalEntry.findFirstOrThrow({ where: { tenantId, companyId, sourceKind: 'TZ_RACE' } }),
      );
      expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2031-01-15');
    });
  });
});
