import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { canonicalize } from '../../common/idempotency/canonical-hash.js';
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

  // ═══════ Task 3b.6 Checkpoint F Final Freeze Evidence Gate (§1/§2) ═════════
  // `accountingDate` now participates in the posting fingerprint — additive,
  // never touching the OMITTED-accountingDate fingerprint shape's own
  // stability (it always passes the SAME constant `null`, proven by every
  // pre-existing idempotency/conflict test above still passing unchanged).
  it('§2.A: same sourceKind/sourceId + SAME explicit accountingDate + same lines -> idempotent replay, no duplicate', async () => {
    const sourceId = randomUUID();
    const first = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT_DATED',
        sourceId,
        lines: balancedLines(),
        accountingDate: '2026-06-10',
      }),
    );
    expect(first.created).toBe(true);
    const second = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT_DATED',
        sourceId,
        lines: balancedLines(),
        accountingDate: '2026-06-10',
      }),
    );
    expect(second.created).toBe(false);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    const entry = await asTenant((tx) =>
      tx.journalEntry.findUniqueOrThrow({ where: { id: first.journalEntryId } }),
    );
    expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2026-06-10');
  });

  it('§2.B: same sourceKind/sourceId + DIFFERENT explicit accountingDate -> JOURNAL_SOURCE_CONFLICT, NOT a silent replay', async () => {
    const sourceId = randomUUID();
    const first = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT_DATED2',
        sourceId,
        lines: balancedLines(),
        accountingDate: '2026-06-05',
      }),
    );
    expect(first.created).toBe(true);
    await expect(
      asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TEST_EVENT_DATED2',
          sourceId,
          lines: balancedLines(), // SAME lines — only the date differs
          accountingDate: '2026-06-20',
        }),
      ),
    ).rejects.toMatchObject({ code: 'JOURNAL_SOURCE_CONFLICT' });
    // the FIRST journal's own postingDate is untouched by the rejected retry.
    const entry = await asTenant((tx) =>
      tx.journalEntry.findUniqueOrThrow({ where: { id: first.journalEntryId } }),
    );
    expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2026-06-05');
  });

  it('§3: OMITTED accountingDate — postingDate is still derived from Clock.now()+accountingTimezone at a UTC-midnight boundary (separate from the explicit-date case)', async () => {
    // 2026-06-14T21:15:00Z is already 2026-06-15 01:15 in Asia/Dubai (+4) —
    // the company-local CIVIL date the omitted-date path must still derive.
    const boundaryClock = {
      now: () => new Date('2026-06-14T21:15:00Z'),
    } as unknown as SystemClock;
    const dummyDb = {} as unknown as DbService;
    const boundaryEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(dummyDb, new AuditWriter(dummyDb), accounts),
      periods,
      new AuditWriter(dummyDb),
      boundaryClock,
    );
    const result = await asTenant((tx) =>
      boundaryEngine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT_TZ_OMITTED',
        sourceId: randomUUID(),
        lines: balancedLines(),
      }),
    );
    const entry = await asTenant((tx) =>
      tx.journalEntry.findUniqueOrThrow({ where: { id: result.journalEntryId } }),
    );
    // company-local (Asia/Dubai) civil date, NOT the UTC calendar date
    // (2026-06-14) — proves the OMITTED path is completely unchanged by F.
    expect(entry.postingDate.toISOString().slice(0, 10)).toBe('2026-06-15');
  });

  it('§4: explicit accountingDate with NO containing AccountingPeriod at all -> NO_OPEN_ACCOUNTING_PERIOD (never auto-created, never falls back to today)', async () => {
    await expect(
      asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TEST_EVENT_NO_PERIOD',
          sourceId: randomUUID(),
          lines: balancedLines(),
          accountingDate: '2019-03-03', // far outside the fixture's ONE 2026-06 period
        }),
      ),
    ).rejects.toMatchObject({ code: 'NO_OPEN_ACCOUNTING_PERIOD' });
  });

  // ═══════ Checkpoint F ABSOLUTE FINAL FREEZE GATE (§1/§4/§5/§6) ═════════════
  /**
   * Independently reconstructs the PRE-F canonical fingerprint shape — a hand
   * copy of what `computePostingFingerprint`'s canonical object literal looked
   * like BEFORE `accountingDate` existed as a field at all (no key, not even
   * `null`). Deliberately does NOT import or call the current
   * `computePostingFingerprint`/`PostingFingerprintInput` — using the function
   * under test to build the "historical" row would only prove the new code is
   * self-consistent, not that it is compatible with fingerprints that predate
   * it.
   */
  function legacyFingerprint(input: {
    companyId: string;
    sourceKind: string;
    sourceId: string;
    currencyCode: string;
    lines: { accountKey: string; direction: 'debit' | 'credit'; amountMinor: bigint }[];
    branchId: string | null;
    posTerminalId: string | null;
  }): string {
    const sortedLines = [...input.lines]
      .sort(
        (a, b) =>
          a.accountKey.localeCompare(b.accountKey) || a.direction.localeCompare(b.direction),
      )
      .map((l) => ({
        accountKey: l.accountKey,
        direction: l.direction,
        amountMinor: l.amountMinor.toString(),
      }));
    const canonical = JSON.stringify(
      canonicalize({
        companyId: input.companyId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        currencyCode: input.currencyCode,
        lines: sortedLines,
        branchId: input.branchId,
        posTerminalId: input.posTerminalId,
      }),
    );
    return createHash('sha256').update(canonical).digest('hex');
  }

  async function accountIdsForKeys(keys: string[]): Promise<Map<string, string>> {
    const rows = await asTenant((tx) =>
      tx.account.findMany({
        where: { tenantId, companyId, key: { in: keys } },
        select: { id: true, key: true },
      }),
    );
    return new Map(rows.map((r) => [r.key, r.id]));
  }

  it('§4-legacy: a genuine PRE-F journal (fingerprint computed WITHOUT any accountingDate key) replays idempotently when the modern engine posts the same source omitting accountingDate — no JOURNAL_SOURCE_CONFLICT, no second row, no fingerprint rewrite required', async () => {
    const sourceId = randomUUID();
    const lines = balancedLines();
    const ids = await accountIdsForKeys(lines.map((l) => l.accountKey));
    const legacyFp = legacyFingerprint({
      companyId,
      sourceKind: 'TEST_EVENT_PRE_F',
      sourceId,
      currencyCode: 'AED',
      lines,
      branchId: null,
      posTerminalId: null,
    });

    // Simulate a journal that was posted and sealed BEFORE `accountingDate`
    // ever existed — a raw INSERT using the hand-built legacy fingerprint,
    // mirroring exactly what `insertAndSeal` itself writes.
    const legacyJournalId = await asTenant(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "journal_entry"
          ("tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
           "currencyCode","postingFingerprint")
        VALUES
          (${tenantId}::uuid, ${companyId}::uuid, ${periodId}::uuid, '2026-06-15'::date,
           'TEST_EVENT_PRE_F', ${sourceId}, 'AED', ${legacyFp})
        RETURNING "id"`;
      const id = inserted[0]!.id;
      for (const l of lines) {
        await tx.journalLine.create({
          data: {
            tenantId,
            companyId,
            journalEntryId: id,
            accountId: ids.get(l.accountKey)!,
            branchId: null,
            posTerminalId: null,
            debitMinor: l.direction === 'debit' ? l.amountMinor : 0n,
            creditMinor: l.direction === 'credit' ? l.amountMinor : 0n,
          },
        });
      }
      await tx.$executeRaw`UPDATE "journal_entry" SET "sealedAt" = now() WHERE "id" = ${id}::uuid`;
      return id;
    });

    // The modern engine, called by a legacy-shaped caller (accountingDate
    // omitted entirely — every pre-F call site), must recognize this as the
    // SAME content and replay idempotently.
    const replay = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT_PRE_F',
        sourceId,
        lines,
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.journalEntryId).toBe(legacyJournalId);

    const rows = await asTenant((tx) =>
      tx.journalEntry.findMany({
        where: { tenantId, companyId, sourceKind: 'TEST_EVENT_PRE_F', sourceId },
      }),
    );
    expect(rows).toHaveLength(1); // no second row was ever created
    expect(rows[0]!.postingFingerprint).toBe(legacyFp); // never rewritten
  });

  it('§5: a legacy omitted-date journal vs a later post of the SAME source WITH an explicit accountingDate -> JOURNAL_SOURCE_CONFLICT (semantically different requests, never a silent replay)', async () => {
    const sourceId = randomUUID();
    const first = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT_LEGACY_VS_EXPLICIT',
        sourceId,
        lines: balancedLines(),
        // accountingDate omitted — this call's canonical shape has NO
        // accountingDate key, exactly like every pre-F caller.
      }),
    );
    expect(first.created).toBe(true);

    await expect(
      asTenant((tx) =>
        engine.postJournal(tx, {
          tenantId,
          companyId,
          sourceKind: 'TEST_EVENT_LEGACY_VS_EXPLICIT',
          sourceId,
          lines: balancedLines(), // SAME lines
          accountingDate: '2026-06-12', // but NOW explicitly supplied
        }),
      ),
    ).rejects.toMatchObject({ code: 'JOURNAL_SOURCE_CONFLICT' });
  });

  it('§6: reverseJournal — a genuine PRE-F reversal fingerprint (no accountingDate key) still replays idempotently for the SAME reversal sourceKind/sourceId', async () => {
    const original = await asTenant((tx) =>
      engine.postJournal(tx, {
        tenantId,
        companyId,
        sourceKind: 'TEST_EVENT_FOR_LEGACY_REVERSAL',
        sourceId: randomUUID(),
        lines: balancedLines(),
      }),
    );
    const reversalSourceId = randomUUID();
    // reverseJournal's inverse lines swap direction relative to the original
    // (debit CASH/credit SALES -> credit CASH/debit SALES).
    const inverseLines = [
      { accountKey: 'ASSET.CASH_ON_HAND', direction: 'credit' as const, amountMinor: 1000n },
      { accountKey: 'REVENUE.SALES', direction: 'debit' as const, amountMinor: 1000n },
    ];
    const ids = await accountIdsForKeys(inverseLines.map((l) => l.accountKey));
    const legacyReversalFp = legacyFingerprint({
      companyId,
      sourceKind: 'TEST_EVENT_FOR_LEGACY_REVERSAL_REVERSAL',
      sourceId: reversalSourceId,
      currencyCode: 'AED',
      lines: inverseLines,
      branchId: null,
      posTerminalId: null,
    });

    const legacyReversalJournalId = await asTenant(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "journal_entry"
          ("tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
           "currencyCode","postingFingerprint","reversalOfJournalEntryId")
        VALUES
          (${tenantId}::uuid, ${companyId}::uuid, ${periodId}::uuid, '2026-06-15'::date,
           'TEST_EVENT_FOR_LEGACY_REVERSAL_REVERSAL', ${reversalSourceId}, 'AED',
           ${legacyReversalFp}, ${original.journalEntryId}::uuid)
        RETURNING "id"`;
      const id = inserted[0]!.id;
      for (const l of inverseLines) {
        await tx.journalLine.create({
          data: {
            tenantId,
            companyId,
            journalEntryId: id,
            accountId: ids.get(l.accountKey)!,
            branchId: null,
            posTerminalId: null,
            debitMinor: l.direction === 'debit' ? l.amountMinor : 0n,
            creditMinor: l.direction === 'credit' ? l.amountMinor : 0n,
          },
        });
      }
      await tx.$executeRaw`UPDATE "journal_entry" SET "sealedAt" = now() WHERE "id" = ${id}::uuid`;
      return id;
    });

    const replay = await asTenant((tx) =>
      engine.reverseJournal(tx, {
        tenantId,
        companyId,
        originalJournalEntryId: original.journalEntryId,
        sourceKind: 'TEST_EVENT_FOR_LEGACY_REVERSAL_REVERSAL',
        sourceId: reversalSourceId,
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.journalEntryId).toBe(legacyReversalJournalId);

    const rows = await asTenant((tx) =>
      tx.journalEntry.findMany({
        where: {
          tenantId,
          companyId,
          sourceKind: 'TEST_EVENT_FOR_LEGACY_REVERSAL_REVERSAL',
          sourceId: reversalSourceId,
        },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.postingFingerprint).toBe(legacyReversalFp);
  });
});
