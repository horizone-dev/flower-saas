import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// White-box integration test exercising the Posting Engine's caller-transaction
// participation contract directly (docs/phase-3/PHASE-3B-PLAN.md §J/§13) — not
// production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { createPrismaClient, runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import { AccountRepository } from './account.repository.js';
import { AccountingPeriodRepository } from './accounting-period.repository.js';
import { CompanyFinancialConfigRepository } from './company-financial-config.repository.js';
import { PostingEngineService } from './posting-engine.service.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { DbService } from '../../common/data/index.js';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.1 — Posting Engine end-to-end against real Postgres. Exercises the
 * sealed-journal idempotency/fingerprint/period/currency-lock contract
 * described in docs/phase-3/PHASE-3B-PLAN.md §J. `AuditWriter` is constructed
 * with a stub `DbService` — `record()` never touches it (only `emit()` does).
 */
describe('PostingEngineService (task 3b.1, integration)', () => {
  let stack: TestStack;
  let prisma: PrismaClient;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let engine: PostingEngineService;

  const tenantId = randomUUID();
  let companyId = '';
  let periodId = '';

  function fakeClockAt(iso: string): SystemClock {
    return { now: () => new Date(iso) } as unknown as SystemClock;
  }

  function asTenant<T>(fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return runScoped(prisma, { tenantId }, fn);
  }

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    prisma = createPrismaClient({ connectionString: stack.postgres.url });

    const dummyDb = {} as unknown as DbService;
    accounts = new AccountRepository(dummyDb, new AuditWriter(dummyDb));
    periods = new AccountingPeriodRepository(dummyDb, new AuditWriter(dummyDb));
    const companyConfig = new CompanyFinancialConfigRepository(
      dummyDb,
      new AuditWriter(dummyDb),
      accounts,
    );
    const audit = new AuditWriter(dummyDb);
    engine = new PostingEngineService(
      companyConfig,
      periods,
      audit,
      fakeClockAt('2026-06-15T10:00:00Z'),
    );

    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      const planId = randomUUID();
      const planVersionId = randomUUID();
      await c.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
        planId,
        `posting-engine-test-plan-${planId.slice(0, 8)}`,
      ]);
      await c.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
         VALUES ($1, $2, 1, 'PUBLISHED', now())`,
        [planVersionId, planId],
      );
      await c.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [tenantId, `posting-engine-test-${tenantId.slice(0, 8)}`, planVersionId],
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
      companyId = randomUUID();
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", "accountingTimezone", status, "updatedAt")
         VALUES ($1, $2, 'Test Co', 'AE', 'AED', 'Asia/Dubai', 'ACTIVE', now())`,
        [companyId, tenantId],
      );
    } finally {
      await c.end();
    }

    await asTenant((tx) => accounts.ensureDefaultAccounts(tx, { tenantId, companyId }));
    const period = await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId,
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2026-06-30T00:00:00Z'),
      }),
    );
    periodId = period.id;
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await stack?.stop();
  });

  const balancedLines = () => [
    { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit' as const, amountMinor: 1000n },
    { accountKey: 'REVENUE.SALES', direction: 'credit' as const, amountMinor: 1000n },
  ];

  it('posts a valid balanced 2-line journal, sealed, correct postingDate/currency, one audit row', async () => {
    const sourceId = randomUUID();
    const result = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT',
        sourceId,
        lines: balancedLines(),
      }),
    );
    expect(result.created).toBe(true);

    const entry = await asTenant((tx) =>
      tx.journalEntry.findUniqueOrThrow({
        where: { id: result.journalEntryId },
        include: { lines: true },
      }),
    );
    expect(entry.sealedAt).not.toBeNull();
    expect(entry.currencyCode).toBe('AED');
    expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2026-06-15');
    expect(entry.accountingPeriodId).toBe(periodId);
    expect(entry.lines).toHaveLength(2);

    const auditRows = await asTenant((tx) =>
      tx.auditLog.findMany({
        where: { action: 'accounting.journal_posted', resourceId: result.journalEntryId },
      }),
    );
    expect(auditRows).toHaveLength(1);
  });

  it('is idempotent for the same source with the same content — no duplicate rows/audit', async () => {
    const sourceId = randomUUID();
    const first = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT',
        sourceId,
        lines: balancedLines(),
      }),
    );
    const second = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT',
        sourceId,
        lines: balancedLines(),
      }),
    );
    expect(second.created).toBe(false);
    expect(second.journalEntryId).toBe(first.journalEntryId);

    const lines = await asTenant((tx) =>
      tx.journalLine.findMany({ where: { journalEntryId: first.journalEntryId } }),
    );
    expect(lines).toHaveLength(2);
    const auditRows = await asTenant((tx) =>
      tx.auditLog.findMany({
        where: { action: 'accounting.journal_posted', resourceId: first.journalEntryId },
      }),
    );
    expect(auditRows).toHaveLength(1);
  });

  it('rejects a repost of the same source with different content', async () => {
    const sourceId = randomUUID();
    await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT',
        sourceId,
        lines: balancedLines(),
      }),
    );
    await expect(
      asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TEST_EVENT',
          sourceId,
          lines: [
            { accountKey: 'ASSET.CASH_ON_HAND', direction: 'debit' as const, amountMinor: 2000n },
            { accountKey: 'REVENUE.SALES', direction: 'credit' as const, amountMinor: 2000n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'JOURNAL_SOURCE_CONFLICT' });
  });

  it('rejects an unknown account key', async () => {
    await expect(
      asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TEST_EVENT',
          sourceId: randomUUID(),
          lines: [
            { accountKey: 'NOT.A.REAL.KEY', direction: 'debit' as const, amountMinor: 100n },
            { accountKey: 'REVENUE.SALES', direction: 'credit' as const, amountMinor: 100n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_KEY_UNKNOWN' });
  });

  it('fails closed when the company has no accountingTimezone/defaultCurrency configured', async () => {
    const bareCompanyId = randomUUID();
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", status, "updatedAt")
         VALUES ($1, $2, 'Bare Co', 'AE', 'ACTIVE', now())`,
        [bareCompanyId, tenantId],
      );
    } finally {
      await c.end();
    }
    await expect(
      asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: bareCompanyId,
          sourceKind: 'TEST_EVENT',
          sourceId: randomUUID(),
          lines: balancedLines(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_CURRENCY_NOT_CONFIGURED' });
  });

  it('fails closed with NO_OPEN_ACCOUNTING_PERIOD when no matching period exists', async () => {
    const outOfRangeClock = {
      now: () => new Date('2099-01-01T00:00:00Z'),
    } as unknown as SystemClock;
    const dummyDb = {} as unknown as DbService;
    const outOfRangeEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(dummyDb, new AuditWriter(dummyDb), accounts),
      periods,
      new AuditWriter(dummyDb),
      outOfRangeClock,
    );
    await expect(
      asTenant((tx) =>
        outOfRangeEngine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TEST_EVENT',
          sourceId: randomUUID(),
          lines: balancedLines(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NO_OPEN_ACCOUNTING_PERIOD' });
  });

  it('fails closed with ACCOUNTING_PERIOD_CLOSED when posting against a closed period', async () => {
    const closedCompanyId = randomUUID();
    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", "accountingTimezone", status, "updatedAt")
         VALUES ($1, $2, 'Closed Co', 'AE', 'AED', 'Asia/Dubai', 'ACTIVE', now())`,
        [closedCompanyId, tenantId],
      );
    } finally {
      await c.end();
    }
    await asTenant((tx) =>
      accounts.ensureDefaultAccounts(tx, { tenantId, companyId: closedCompanyId }),
    );
    const closedPeriod = await asTenant((tx) =>
      periods.create(tx, {
        tenantId,
        companyId: closedCompanyId,
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2026-06-30T00:00:00Z'),
      }),
    );
    await asTenant((tx) =>
      periods.close(tx, {
        tenantId,
        companyId: closedCompanyId,
        id: closedPeriod.id,
        expectedVersion: closedPeriod.version,
        closedByUserId: null,
      }),
    );

    await expect(
      asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId: closedCompanyId,
          sourceKind: 'TEST_EVENT',
          sourceId: randomUUID(),
          lines: balancedLines(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSED' });
  });

  it('reverses a journal fully — new independently-sealed entry, swapped lines, reversalOfJournalEntryId set', async () => {
    const original = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT',
        sourceId: randomUUID(),
        lines: balancedLines(),
      }),
    );
    const reversal = await asTenant((tx) =>
      engine.reverseJournal(tx, {
        tenantId,
        companyId,
        originalJournalEntryId: original.journalEntryId,
        sourceKind: 'TEST_EVENT_REVERSAL',
        sourceId: randomUUID(),
      }),
    );
    expect(reversal.created).toBe(true);

    const reversalEntry = await asTenant((tx) =>
      tx.journalEntry.findUniqueOrThrow({
        where: { id: reversal.journalEntryId },
        include: { lines: true },
      }),
    );
    expect(reversalEntry.reversalOfJournalEntryId).toBe(original.journalEntryId);
    expect(reversalEntry.sealedAt).not.toBeNull();
    const totalDebit = reversalEntry.lines.reduce((s, l) => s + l.debitMinor, 0n);
    expect(totalDebit).toBe(1000n);
    // original was debit CASH / credit SALES; reversal must swap: credit CASH / debit SALES
    const cashLine = reversalEntry.lines.find((l) => l.creditMinor > 0n);
    expect(cashLine).toBeDefined();

    const auditRows = await asTenant((tx) =>
      tx.auditLog.findMany({
        where: { action: 'accounting.journal_reversed', resourceId: reversal.journalEntryId },
      }),
    );
    expect(auditRows).toHaveLength(1);
  });

  it('rejects a second full reversal of the same original journal', async () => {
    const original = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT',
        sourceId: randomUUID(),
        lines: balancedLines(),
      }),
    );
    await asTenant((tx) =>
      engine.reverseJournal(tx, {
        tenantId,
        companyId,
        originalJournalEntryId: original.journalEntryId,
        sourceKind: 'TEST_EVENT_REVERSAL',
        sourceId: randomUUID(),
      }),
    );
    await expect(
      asTenant((tx) =>
        engine.reverseJournal(tx, {
          tenantId,
          companyId,
          originalJournalEntryId: original.journalEntryId,
          sourceKind: 'TEST_EVENT_REVERSAL',
          sourceId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'JOURNAL_ALREADY_REVERSED' });
  });

  it('participates in the caller transaction — rolling back the outer transaction rolls back the journal', async () => {
    const sourceId = randomUUID();
    let journalEntryId = '';
    await expect(
      asTenant(async (tx) => {
        const result = await engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TEST_ROLLBACK',
          sourceId,
          lines: balancedLines(),
        });
        journalEntryId = result.journalEntryId;
        throw new DomainError('TEST_FORCED_ROLLBACK', 'forced rollback', 500);
      }),
    ).rejects.toMatchObject({ code: 'TEST_FORCED_ROLLBACK' });

    const rows = await asTenant((tx) =>
      tx.journalEntry.findMany({ where: { id: journalEntryId } }),
    );
    expect(rows).toHaveLength(0);
  });
});
