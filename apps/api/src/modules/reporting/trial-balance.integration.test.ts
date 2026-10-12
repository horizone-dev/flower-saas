import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { DbService, type BackendConfig } from '@flower/backend';
// White-box integration test: it seeds fixtures and reads the ledger directly — not production
// module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { runScoped } from '@flower/db';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { PrismaClient, ScopedTx } from '@flower/db';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { SystemClock } from '../../common/clock/clock.js';
import { RequestContext, runWithContext } from '../../common/context/index.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { ReportingRepository } from './reporting.repository.js';
import { TrialBalanceRepository, type TrialBalanceReport } from './trial-balance.repository.js';
import { TrialBalanceService } from './trial-balance.service.js';

/**
 * Task 3b.10 Checkpoint A — the Trial Balance against REAL PostgreSQL, through the real
 * posting engine, the real RLS role (`flower_app`) and the real scoped-transaction path.
 *
 * Every scenario owns a FRESH company (its own CoA + its own open period) so no test can
 * influence another's ledger.
 */
describe('Trial Balance — task 3b.10 Checkpoint A (integration)', () => {
  let stack: TestStack;
  let db: DbService;
  let prisma: PrismaClient;
  let accounts: AccountRepository;
  let periods: AccountingPeriodRepository;
  let engine: PostingEngineService;
  let repo: TrialBalanceRepository;
  let service: TrialBalanceService;
  let adminQuery: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  let closeAdmin: () => Promise<void>;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let clockNow = new Date('2026-06-15T10:00:00Z');
  const clock = { now: () => clockNow } as unknown as SystemClock;

  const asTenant = <T>(tenantId: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T> =>
    runScoped(prisma, { tenantId }, fn);

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    runWithContext(new RequestContext({ requestId: randomUUID(), tenantId }), fn);

  async function newCompany(opts: {
    tenantId: string;
    currency?: string | null;
    timezone?: string | null;
    countryCode?: string;
    withCoA?: boolean;
    withPeriod?: boolean;
  }): Promise<string> {
    const companyId = randomUUID();
    const currency = opts.currency === undefined ? 'AED' : opts.currency;
    const tz = opts.timezone === undefined ? 'Asia/Dubai' : opts.timezone;
    await adminQuery(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "countryCode", "defaultCurrency", "accountingTimezone", status, "updatedAt")
       VALUES ($1, $2, 'Report Test Co', $3, $4, $5, 'ACTIVE', now())`,
      [companyId, opts.tenantId, opts.countryCode ?? 'AE', currency, tz],
    );
    if (opts.withCoA !== false) {
      await asTenant(opts.tenantId, (tx) =>
        accounts.ensureDefaultAccounts(tx, { tenantId: opts.tenantId, companyId }),
      );
    }
    if (opts.withPeriod !== false) {
      await asTenant(opts.tenantId, (tx) =>
        periods.create(tx, {
          tenantId: opts.tenantId,
          companyId,
          startDate: new Date('2026-01-01T00:00:00Z'),
          endDate: new Date('2026-12-31T00:00:00Z'),
        }),
      );
    }
    return companyId;
  }

  /** Fixture helper: run `fn` with triggers + FKs off (the corrupted-ledger fixtures only), always restoring. */
  async function withTriggersOff(fn: () => Promise<void>): Promise<void> {
    await adminQuery(`SET session_replication_role = 'replica'`);
    try {
      await fn();
    } finally {
      await adminQuery(`SET session_replication_role = 'origin'`);
    }
  }

  /**
   * Fixture only. The application path can never commit an unsealed, foreign-currency or unbalanced
   * entry (a deferred DB trigger rejects it), so a corrupted ledger is written directly, with
   * triggers off, to prove the report's fail-closed / sealed-only behaviour.
   */
  async function insertRawEntry(args: {
    tenantId: string;
    companyId: string;
    sourceKind: string;
    postingDate: string;
    currencyCode: string;
    sealed: boolean;
    lines: { accountKey: string; debit: number; credit: number }[];
  }): Promise<string> {
    const period = await adminQuery(`SELECT id FROM accounting_period WHERE "companyId" = $1`, [
      args.companyId,
    ]);
    const accountRows = await adminQuery(`SELECT id, key FROM account WHERE "companyId" = $1`, [
      args.companyId,
    ]);
    const entryId = randomUUID();
    await withTriggersOff(async () => {
      await adminQuery(
        `INSERT INTO journal_entry (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
                                    "sourceKind", "sourceId", "currencyCode", "postingFingerprint", "sealedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fp', ${args.sealed ? 'now()' : 'NULL'})`,
        [
          entryId,
          args.tenantId,
          args.companyId,
          period.rows[0]!['id'],
          args.postingDate,
          args.sourceKind,
          randomUUID(),
          args.currencyCode,
        ],
      );
      for (const l of args.lines) {
        const account = accountRows.rows.find((a) => a['key'] === l.accountKey);
        if (!account) throw new Error(`fixture: no account ${l.accountKey}`);
        await adminQuery(
          `INSERT INTO journal_line (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), args.tenantId, args.companyId, entryId, account['id'], l.debit, l.credit],
        );
      }
    });
    return entryId;
  }

  async function post(args: {
    tenantId: string;
    companyId: string;
    sourceKind?: string;
    sourceId?: string;
    accountingDate?: string;
    lines: { accountKey: string; direction: 'debit' | 'credit'; amountMinor: bigint }[];
  }): Promise<string> {
    const res = await asTenant(args.tenantId, (tx) =>
      engine.postJournal(tx, {
        tenantId: args.tenantId,
        companyId: args.companyId,
        sourceKind: args.sourceKind ?? 'TB_TEST',
        sourceId: args.sourceId ?? randomUUID(),
        ...(args.accountingDate !== undefined ? { accountingDate: args.accountingDate } : {}),
        lines: args.lines,
      }),
    );
    return res.journalEntryId;
  }

  /** `Dr debitKey / Cr creditKey` for `amount`, on a civil date. */
  const entry = (
    tenantId: string,
    companyId: string,
    accountingDate: string,
    debitKey: string,
    creditKey: string,
    amount: bigint,
    sourceKind?: string,
  ) =>
    post({
      tenantId,
      companyId,
      accountingDate,
      ...(sourceKind !== undefined ? { sourceKind } : {}),
      lines: [
        { accountKey: debitKey, direction: 'debit', amountMinor: amount },
        { accountKey: creditKey, direction: 'credit', amountMinor: amount },
      ],
    });

  const tb = (
    tenantId: string,
    companyId: string,
    from: string,
    to: string,
  ): Promise<TrialBalanceReport> => inTenant(tenantId, () => service.get({ companyId, from, to }));

  const row = (r: TrialBalanceReport, key: string) => {
    const found = r.accounts.find((a) => a.accountKey === key);
    if (!found) throw new Error(`account ${key} is not in the trial balance`);
    return found;
  };

  const CASH = 'ASSET.CASH_ON_HAND';
  const ADV = 'LIABILITY.CUSTOMER_ADVANCES';
  const REV = 'REVENUE.SALES';
  const FEE = 'EXPENSE.PAYMENT_PROCESSING_FEE';
  const TAX = 'LIABILITY.TAX_PAYABLE';

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    prisma = db.appClient();

    const dummyDb = {} as unknown as DbService;
    accounts = new AccountRepository(dummyDb, new AuditWriter(dummyDb));
    periods = new AccountingPeriodRepository(dummyDb, new AuditWriter(dummyDb));
    const companyConfig = new CompanyFinancialConfigRepository(
      dummyDb,
      new AuditWriter(dummyDb),
      accounts,
    );
    engine = new PostingEngineService(companyConfig, periods, new AuditWriter(dummyDb), clock);
    repo = new TrialBalanceRepository(db);
    service = new TrialBalanceService(repo);

    const pg = await import('pg');
    const c = new pg.default.Client({ connectionString: stack.postgres.url });
    await c.connect();
    adminQuery = (sql, params) => c.query(sql, params as unknown[]);
    closeAdmin = () => c.end();

    const planId = randomUUID();
    const planVersionId = randomUUID();
    await c.query(`INSERT INTO plan (id, key, name, "updatedAt") VALUES ($1, $2, $2, now())`, [
      planId,
      `tb-test-plan-${planId.slice(0, 8)}`,
    ]);
    await c.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ($1, $2, 1, 'PUBLISHED', now())`,
      [planVersionId, planId],
    );
    for (const t of [tenantA, tenantB]) {
      await c.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', $3, now())`,
        [t, `tb-test-${t.slice(0, 8)}`, planVersionId],
      );
    }
    await c.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'x'), ('KWD', 3, 'KWD', 'Kuwaiti Dinar', 'x')
       ON CONFLICT (code) DO NOTHING`,
    );
    await c.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "defaultTimezone", "updatedAt")
       VALUES ('AE', 'United Arab Emirates', 'x', 'gcc', 'AED', 'SAT_SUN', 'Asia/Dubai', now()),
              ('KW', 'Kuwait', 'x', 'gcc', 'KWD', 'FRI_SAT', 'Asia/Kuwait', now())
       ON CONFLICT (code) DO NOTHING`,
    );
  }, 180_000);

  afterAll(async () => {
    await closeAdmin?.();
    await prisma?.$disconnect();
    await stack?.stop();
  });

  // ───────────────────────── the date matrix (OD-2) ─────────────────────────
  describe('postingDate is the period authority — opening / period / closing', () => {
    let co: string;
    beforeAll(async () => {
      co = await newCompany({ tenantId: tenantA });
      // D0 before `from`, D1 on `from`, D2 between, D3 on `to`, D4 after `to`
      await entry(tenantA, co, '2026-05-31', CASH, ADV, 1000n, 'TB_OPENING');
      await entry(tenantA, co, '2026-06-01', CASH, REV, 300n);
      await entry(tenantA, co, '2026-06-15', FEE, CASH, 200n);
      await entry(tenantA, co, '2026-06-30', CASH, REV, 50n);
      await entry(tenantA, co, '2026-07-01', CASH, REV, 999n);
    });

    it('opening is everything before `from`; the period is `from`..`to` INCLUSIVE; later postings are excluded', async () => {
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      // asset debit balance, multi-line account
      expect(row(r, CASH)).toMatchObject({
        openingDebitMinor: '1000',
        openingCreditMinor: '0',
        periodDebitMinor: '350', // 300 on `from` + 50 on `to`
        periodCreditMinor: '200',
        closingDebitMinor: '1150',
        closingCreditMinor: '0',
      });
      // liability credit balance — opening only
      expect(row(r, ADV)).toMatchObject({
        openingCreditMinor: '1000',
        periodDebitMinor: '0',
        periodCreditMinor: '0',
        closingCreditMinor: '1000',
        closingDebitMinor: '0',
      });
      // revenue credit balance — the 07-01 posting is NOT in
      expect(row(r, REV)).toMatchObject({
        openingCreditMinor: '0',
        periodCreditMinor: '350',
        closingCreditMinor: '350',
      });
      // expense debit balance
      expect(row(r, FEE)).toMatchObject({
        periodDebitMinor: '200',
        closingDebitMinor: '200',
        closingCreditMinor: '0',
      });
      expect(r.totals).toEqual({
        totalOpeningDebitMinor: '1000',
        totalOpeningCreditMinor: '1000',
        totalPeriodDebitMinor: '550',
        totalPeriodCreditMinor: '550',
        totalClosingDebitMinor: '1350', // CASH 1150 + FEE 200
        totalClosingCreditMinor: '1350', // ADV 1000 + REV 350
      });
      expect(r.accounts.map((a) => a.accountKey).sort()).toEqual([ADV, CASH, FEE, REV].sort());
    });

    it('a posting dated exactly `from` is period, not opening', async () => {
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-01');
      expect(row(r, REV)).toMatchObject({ openingCreditMinor: '0', periodCreditMinor: '300' });
      // 06-15 / 06-30 / 07-01 are all after `to`
      expect(row(r, CASH)).toMatchObject({ openingDebitMinor: '1000', periodDebitMinor: '300' });
      expect(r.accounts.some((a) => a.accountKey === FEE)).toBe(false);
    });

    it('a posting dated exactly `to` is period', async () => {
      const r = await tb(tenantA, co, '2026-06-30', '2026-06-30');
      expect(row(r, REV)).toMatchObject({ openingCreditMinor: '300', periodCreditMinor: '50' });
    });

    it('a posting dated the day before `from` is opening only', async () => {
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-01');
      expect(row(r, ADV)).toMatchObject({ openingCreditMinor: '1000', periodCreditMinor: '0' });
    });

    it('a posting the day after `to` is excluded from every column', async () => {
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      // 999 (07-01) would make revenue 1349; it is excluded
      expect(row(r, REV).closingCreditMinor).toBe('350');
      const after = await tb(tenantA, co, '2026-07-01', '2026-07-01');
      expect(row(after, REV)).toMatchObject({
        openingCreditMinor: '350',
        periodCreditMinor: '999',
      });
    });

    it('a window entirely before the first posting returns no accounts, zero totals, full metadata', async () => {
      const r = await tb(tenantA, co, '2026-01-01', '2026-01-31');
      expect(r.accounts).toEqual([]);
      expect(r.totals).toEqual({
        totalOpeningDebitMinor: '0',
        totalOpeningCreditMinor: '0',
        totalPeriodDebitMinor: '0',
        totalPeriodCreditMinor: '0',
        totalClosingDebitMinor: '0',
        totalClosingCreditMinor: '0',
      });
      expect(r).toMatchObject({
        companyId: co,
        currencyCode: 'AED',
        currencyExponent: 2,
        accountingTimezone: 'Asia/Dubai',
        from: '2026-01-01',
        to: '2026-01-31',
      });
    });

    it('an account with activity only AFTER `to` is not listed', async () => {
      const r = await tb(tenantA, co, '2026-05-01', '2026-05-30');
      expect(r.accounts).toEqual([]);
    });

    it('an account whose lines net to zero inside the window is still listed (it has activity)', async () => {
      const zero = await newCompany({ tenantId: tenantA });
      await entry(tenantA, zero, '2026-06-02', CASH, REV, 70n);
      await entry(tenantA, zero, '2026-06-03', REV, CASH, 70n);
      const r = await tb(tenantA, zero, '2026-06-01', '2026-06-30');
      expect(row(r, REV)).toMatchObject({
        periodDebitMinor: '70',
        periodCreditMinor: '70',
        closingDebitMinor: '0',
        closingCreditMinor: '0',
      });
    });

    it('an account that reverses sign across the period lands on the other side', async () => {
      const rev = await newCompany({ tenantId: tenantA });
      await entry(tenantA, rev, '2026-05-10', CASH, ADV, 500n); // CASH 500 Dr opening
      await entry(tenantA, rev, '2026-06-10', ADV, CASH, 800n); // CASH → 300 Cr; ADV → 300 Dr
      const r = await tb(tenantA, rev, '2026-06-01', '2026-06-30');
      expect(row(r, CASH)).toMatchObject({
        openingDebitMinor: '500',
        openingCreditMinor: '0',
        closingDebitMinor: '0',
        closingCreditMinor: '300',
      });
      expect(row(r, ADV)).toMatchObject({
        openingCreditMinor: '500',
        closingDebitMinor: '300',
        closingCreditMinor: '0',
      });
      expect(r.totals.totalClosingDebitMinor).toBe(r.totals.totalClosingCreditMinor);
    });

    it('is deterministic: the same request returns the same report, byte for byte', async () => {
      const a = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      const b = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  // ─────────────── the company accounting timezone + the UTC straddle ───────────────
  describe('civil dates under GCC timezones — no UTC / client-local conversion', () => {
    afterAll(() => {
      clockNow = new Date('2026-06-15T10:00:00Z');
    });

    it('Dubai (UTC+4): an instant that is still 03-31 in UTC posts on 04-01, and the report follows the stored posting date', async () => {
      const co = await newCompany({ tenantId: tenantA, timezone: 'Asia/Dubai' });
      // 21:30Z on 03-31 = 01:30 on 04-01 in Dubai
      clockNow = new Date('2026-03-31T21:30:00Z');
      await post({
        tenantId: tenantA,
        companyId: co,
        lines: [
          { accountKey: CASH, direction: 'debit', amountMinor: 100n },
          { accountKey: REV, direction: 'credit', amountMinor: 100n },
        ],
      });
      // 19:59:59Z on 03-31 = 23:59:59 on 03-31 in Dubai
      clockNow = new Date('2026-03-31T19:59:59Z');
      await post({
        tenantId: tenantA,
        companyId: co,
        lines: [
          { accountKey: CASH, direction: 'debit', amountMinor: 7n },
          { accountKey: REV, direction: 'credit', amountMinor: 7n },
        ],
      });
      const dates = await adminQuery(
        `SELECT "postingDate"::text AS d, (SELECT SUM("debitMinor") FROM journal_line jl WHERE jl."journalEntryId" = je.id)::text AS amt
           FROM journal_entry je WHERE je."companyId" = $1 ORDER BY je."postingDate"`,
        [co],
      );
      expect(dates.rows).toEqual([
        { d: '2026-03-31', amt: '7' },
        { d: '2026-04-01', amt: '100' },
      ]);
      // the civil window 03-31..03-31 holds ONLY the 23:59:59 posting, though both instants are 03-31 in UTC
      const mar31 = await tb(tenantA, co, '2026-03-31', '2026-03-31');
      expect(row(mar31, REV).periodCreditMinor).toBe('7');
      const apr01 = await tb(tenantA, co, '2026-04-01', '2026-04-01');
      expect(row(apr01, REV)).toMatchObject({ openingCreditMinor: '7', periodCreditMinor: '100' });
    });

    it('the SAME instant is a different civil date in Dubai (UTC+4) and Kuwait (UTC+3), and each company reports its own', async () => {
      const dubai = await newCompany({ tenantId: tenantA, timezone: 'Asia/Dubai' });
      const kuwait = await newCompany({
        tenantId: tenantA,
        currency: 'KWD',
        timezone: 'Asia/Kuwait',
        countryCode: 'KW',
      });
      clockNow = new Date('2026-03-31T20:30:00Z'); // Dubai 00:30 on 04-01 · Kuwait 23:30 on 03-31
      for (const co of [dubai, kuwait]) {
        await post({
          tenantId: tenantA,
          companyId: co,
          lines: [
            { accountKey: CASH, direction: 'debit', amountMinor: 1n },
            { accountKey: REV, direction: 'credit', amountMinor: 1n },
          ],
        });
      }
      const dubaiApr = await tb(tenantA, dubai, '2026-04-01', '2026-04-01');
      const kuwaitApr = await tb(tenantA, kuwait, '2026-04-01', '2026-04-01');
      expect(dubaiApr.accounts.length).toBe(2);
      expect(kuwaitApr.accounts.length).toBe(2);
      expect(row(dubaiApr, REV).periodCreditMinor).toBe('1');
      expect(row(kuwaitApr, REV).periodCreditMinor).toBe('0'); // it is on 03-31 in Kuwait
      expect(row(kuwaitApr, REV).openingCreditMinor).toBe('1');
      expect(dubaiApr.accountingTimezone).toBe('Asia/Dubai');
      expect(kuwaitApr.accountingTimezone).toBe('Asia/Kuwait');
    });
  });

  // ───────────── a document's own date never controls period membership ─────────────
  describe('a document date that differs from the postingDate', () => {
    it('the report follows journal_entry.postingDate only — the invoice date is irrelevant', async () => {
      const co = await newCompany({ tenantId: tenantA });
      const invoiceId = randomUUID();
      // a document dated 05-20 whose ledger entry posted on 06-02 (its FKs are irrelevant here — the
      // report never reads it — so the row is written with FKs off)
      await withTriggersOff(async () => {
        await adminQuery(
          `INSERT INTO invoice (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber",
                                "issuedAt", "invoiceDate", "currencyCode", "currencyExponent",
                                "subtotalAmountMinor", "documentDiscountAmountMinor",
                                "taxTotalAmountMinor", "totalAmountMinor")
           VALUES ($1, $2, $3, $4, $5, 'INV-DOC-DATE', '2026-05-20T08:00:00Z', '2026-05-20',
                   'AED', 2, 1000, 0, 0, 1000)`,
          [invoiceId, tenantA, co, randomUUID(), randomUUID()],
        );
      });
      const doc = await adminQuery(`SELECT "invoiceDate"::text AS d FROM invoice WHERE id = $1`, [
        invoiceId,
      ]);
      expect(doc.rows[0]).toEqual({ d: '2026-05-20' });

      await post({
        tenantId: tenantA,
        companyId: co,
        sourceKind: 'invoice_ar',
        sourceId: invoiceId,
        accountingDate: '2026-06-02',
        lines: [
          { accountKey: 'ASSET.ACCOUNTS_RECEIVABLE', direction: 'debit', amountMinor: 1000n },
          { accountKey: REV, direction: 'credit', amountMinor: 1000n },
        ],
      });

      // the document date 05-20 does NOT pull the entry into a window around 05-20
      const onDocDate = await tb(tenantA, co, '2026-05-20', '2026-05-20');
      expect(onDocDate.accounts).toEqual([]);
      // the posting date 06-02 does
      const onPosting = await tb(tenantA, co, '2026-06-02', '2026-06-02');
      expect(row(onPosting, REV).periodCreditMinor).toBe('1000');
      // and as opening, only for windows starting after the POSTING date
      const after = await tb(tenantA, co, '2026-06-03', '2026-06-30');
      expect(row(after, REV)).toMatchObject({ openingCreditMinor: '1000', periodCreditMinor: '0' });
    });
  });

  // ────────────────── the complete GL: sourceKind independence ──────────────────
  describe('the Trial Balance is the complete sealed GL — independent of sourceKind', () => {
    it('a sealed journal with a synthetic, never-registered sourceKind is included and the totals stay balanced', async () => {
      const co = await newCompany({ tenantId: tenantA });
      await entry(tenantA, co, '2026-06-05', CASH, REV, 400n, 'walk_in_sale'); // a known kind
      await entry(
        tenantA,
        co,
        '2026-06-06',
        CASH,
        ADV,
        25n,
        'ZZ_UNKNOWN_KIND_THAT_NO_REPORT_KNOWS',
      ); // free text
      await entry(tenantA, co, '2026-06-07', FEE, CASH, 5n, 'SETTLEMENT_BATCH'); // upper-case legacy style
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      expect(row(r, ADV).periodCreditMinor).toBe('25'); // only the unknown-kind entry touches ADV
      expect(row(r, CASH).periodDebitMinor).toBe('425');
      expect(row(r, CASH).periodCreditMinor).toBe('5');
      expect(r.totals.totalPeriodDebitMinor).toBe('430');
      expect(r.totals.totalPeriodCreditMinor).toBe('430');
      expect(r.totals.totalClosingDebitMinor).toBe(r.totals.totalClosingCreditMinor);
    });
  });

  // ───────────────────────────── sealed entries only ─────────────────────────────
  describe('SEALED entries only', () => {
    it('an unsealed entry is invisible to the report — even one that would unbalance it', async () => {
      const co = await newCompany({ tenantId: tenantA });
      await entry(tenantA, co, '2026-06-05', CASH, REV, 100n);

      // a ONE-SIDED unsealed entry: if the report counted it the totals would not balance
      const entryId = await insertRawEntry({
        tenantId: tenantA,
        companyId: co,
        sourceKind: 'TB_UNSEALED',
        postingDate: '2026-06-06',
        currencyCode: 'AED',
        sealed: false,
        lines: [{ accountKey: CASH, debit: 777, credit: 0 }],
      });

      const present = await adminQuery(
        `SELECT count(*)::int AS n FROM journal_entry WHERE id = $1 AND "sealedAt" IS NULL`,
        [entryId],
      );
      expect(present.rows[0]!['n']).toBe(1); // the unsealed row really is committed

      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      expect(row(r, CASH).periodDebitMinor).toBe('100'); // not 877
      expect(r.totals.totalPeriodDebitMinor).toBe('100');
      expect(r.totals.totalPeriodCreditMinor).toBe('100');
    });
  });

  // ───────────────────────── account / ordering matrix ─────────────────────────
  describe('accounts', () => {
    it('lists multiple accounts in the deterministic CoA order (account code, then key, then id)', async () => {
      const co = await newCompany({ tenantId: tenantA });
      // post into accounts in an order unrelated to their codes
      await entry(tenantA, co, '2026-06-02', 'REVENUE.CANCELLATION_CHARGE', CASH, 10n);
      await entry(tenantA, co, '2026-06-03', 'ASSET.ACCOUNTS_RECEIVABLE', TAX, 11n);
      await entry(tenantA, co, '2026-06-04', 'ASSET.BANK', REV, 12n);
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      const codes = r.accounts.map((a) => a.displayCode);
      expect(codes).toEqual([...codes].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
      // and equals what the CoA itself says
      const coa = await adminQuery(
        `SELECT key FROM account WHERE "companyId" = $1 AND key = ANY($2::text[]) ORDER BY "displayCode" COLLATE "C"`,
        [
          co,
          [
            'REVENUE.CANCELLATION_CHARGE',
            CASH,
            'ASSET.ACCOUNTS_RECEIVABLE',
            TAX,
            'ASSET.BANK',
            REV,
          ],
        ],
      );
      expect(r.accounts.map((a) => a.accountKey)).toEqual(coa.rows.map((x) => x['key']));
      expect(r.accounts.length).toBe(6);
    });

    it('a company with an empty ledger returns one clean empty report (not a 404)', async () => {
      const co = await newCompany({ tenantId: tenantA });
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      expect(r.accounts).toEqual([]);
      expect(r.totals.totalClosingDebitMinor).toBe('0');
    });

    it('returns EVERY active account — there is no cursor, limit or page in the request or the response', async () => {
      const co = await newCompany({ tenantId: tenantA });
      const keys = [
        'ASSET.CASH_ON_HAND',
        'ASSET.BANK',
        'ASSET.PAYMENT_CLEARING',
        'ASSET.ACCOUNTS_RECEIVABLE',
        'LIABILITY.CUSTOMER_ADVANCES',
        'LIABILITY.UNAPPLIED_RECEIPTS',
        'LIABILITY.TAX_PAYABLE',
        'LIABILITY.REFUND_PAYABLE',
        'EQUITY.RETAINED_EARNINGS',
        'REVENUE.SALES',
        'REVENUE.CANCELLATION_CHARGE',
        'EXPENSE.RECEIVABLE_WRITE_OFF',
      ];
      // chain them: each entry debits key[i], credits key[i+1] (all distinct accounts, all balanced)
      for (let i = 0; i < keys.length - 1; i += 1) {
        await entry(tenantA, co, '2026-06-10', keys[i]!, keys[i + 1]!, BigInt(i + 1));
      }
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      expect(r.accounts.length).toBe(keys.length);
      expect(Object.keys(r).sort()).toEqual(
        [
          'accountingTimezone',
          'accounts',
          'companyId',
          'currencyCode',
          'currencyExponent',
          'from',
          'to',
          'totals',
        ].sort(),
      );
    });
  });

  // ─────────────────────── 2-decimal and 3-decimal currencies ───────────────────────
  describe('integer minor units under 2- and 3-decimal companies', () => {
    it('AED (exponent 2): exact figures, exponent 2, exact sums beyond 2^53', async () => {
      const co = await newCompany({ tenantId: tenantA, currency: 'AED' });
      const big = 6_000_000_000_000_000n; // two of these exceed Number.MAX_SAFE_INTEGER (9.007e15)
      await entry(tenantA, co, '2026-06-02', CASH, REV, big);
      await entry(tenantA, co, '2026-06-03', CASH, REV, big);
      await entry(tenantA, co, '2026-06-04', CASH, REV, 1n);
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      expect(r.currencyCode).toBe('AED');
      expect(r.currencyExponent).toBe(2);
      expect(row(r, CASH).periodDebitMinor).toBe('12000000000000001'); // exact — a float would round
      expect(row(r, REV).closingCreditMinor).toBe('12000000000000001');
      expect(r.totals.totalPeriodDebitMinor).toBe('12000000000000001');
      expect(r.totals.totalPeriodCreditMinor).toBe('12000000000000001');
    });

    it('KWD (exponent 3): the 3-decimal minor unit is carried unchanged — no scaling, no rounding', async () => {
      const co = await newCompany({
        tenantId: tenantA,
        currency: 'KWD',
        timezone: 'Asia/Kuwait',
        countryCode: 'KW',
      });
      await entry(tenantA, co, '2026-05-10', CASH, ADV, 1_234_567n); // KWD 1,234.567
      await entry(tenantA, co, '2026-06-10', CASH, REV, 999n); // KWD 0.999
      await entry(tenantA, co, '2026-06-11', FEE, CASH, 1n); // KWD 0.001
      const r = await tb(tenantA, co, '2026-06-01', '2026-06-30');
      expect(r.currencyCode).toBe('KWD');
      expect(r.currencyExponent).toBe(3);
      expect(row(r, CASH)).toMatchObject({
        openingDebitMinor: '1234567',
        periodDebitMinor: '999',
        periodCreditMinor: '1',
        closingDebitMinor: '1235565',
      });
      expect(r.totals.totalClosingDebitMinor).toBe('1235566');
      expect(r.totals.totalClosingCreditMinor).toBe('1235566');
    });
  });

  // ─────────────────── fail-closed: company authority + ledger integrity ───────────────────
  describe('fails closed', () => {
    const reject = async (p: Promise<unknown>): Promise<DomainError> => {
      try {
        await p;
      } catch (e) {
        if (e instanceof DomainError) return e;
        throw e;
      }
      throw new Error('expected a DomainError');
    };

    it('a company with no accounting currency → 409 REPORT_COMPANY_NOT_CONFIGURED', async () => {
      const co = await newCompany({
        tenantId: tenantA,
        currency: null,
        withCoA: false,
        withPeriod: false,
      });
      const err = await reject(tb(tenantA, co, '2026-06-01', '2026-06-30'));
      expect(err).toMatchObject({ code: 'REPORT_COMPANY_NOT_CONFIGURED', status: 409 });
    });

    it('a company with no accounting timezone → 409 REPORT_COMPANY_NOT_CONFIGURED', async () => {
      const co = await newCompany({
        tenantId: tenantA,
        timezone: null,
        withCoA: false,
        withPeriod: false,
      });
      const err = await reject(tb(tenantA, co, '2026-06-01', '2026-06-30'));
      expect(err).toMatchObject({ code: 'REPORT_COMPANY_NOT_CONFIGURED', status: 409 });
    });

    it('a sealed entry in another currency (mixed currency) → 409 REPORT_CURRENCY_MISMATCH; nothing is converted or summed', async () => {
      const co = await newCompany({ tenantId: tenantA });
      await entry(tenantA, co, '2026-06-05', CASH, REV, 100n);
      await insertRawEntry({
        tenantId: tenantA,
        companyId: co,
        sourceKind: 'TB_FOREIGN_CURRENCY',
        postingDate: '2026-06-06',
        currencyCode: 'KWD',
        sealed: true,
        lines: [
          { accountKey: CASH, debit: 50, credit: 0 },
          { accountKey: REV, debit: 0, credit: 50 },
        ],
      });

      const err = await reject(tb(tenantA, co, '2026-06-01', '2026-06-30'));
      expect(err).toMatchObject({ code: 'REPORT_CURRENCY_MISMATCH', status: 409 });
      // a window that does not include the foreign entry is unaffected
      const clean = await tb(tenantA, co, '2026-06-01', '2026-06-05');
      expect(row(clean, CASH).periodDebitMinor).toBe('100');
    });

    it('an unbalanced sealed ledger → 500 REPORT_TRIAL_BALANCE_UNBALANCED, no figures', async () => {
      const co = await newCompany({ tenantId: tenantA });
      await entry(tenantA, co, '2026-06-05', CASH, REV, 100n);
      await insertRawEntry({
        tenantId: tenantA,
        companyId: co,
        sourceKind: 'TB_CORRUPT',
        postingDate: '2026-06-06',
        currencyCode: 'AED',
        sealed: true,
        lines: [
          { accountKey: CASH, debit: 100, credit: 0 },
          { accountKey: REV, debit: 0, credit: 90 },
        ],
      });

      const err = await reject(tb(tenantA, co, '2026-06-01', '2026-06-30'));
      expect(err).toMatchObject({ code: 'REPORT_TRIAL_BALANCE_UNBALANCED', status: 500 });
    });

    it('invalid input never reaches the database: INVALID_DATE / INVALID_DATE_RANGE / VALIDATION_FAILED', async () => {
      const co = await newCompany({ tenantId: tenantA });
      expect(
        await reject(
          inTenant(tenantA, () =>
            service.get({ companyId: co, from: '2026-06-01T00:00:00Z', to: '2026-06-30' }),
          ),
        ),
      ).toMatchObject({ code: 'INVALID_DATE', status: 400 });
      expect(await reject(tb(tenantA, co, '2026-06-30', '2026-06-01'))).toMatchObject({
        code: 'INVALID_DATE_RANGE',
      });
      expect(
        await reject(
          inTenant(tenantA, () =>
            service.get({ companyId: co, from: undefined, to: '2026-06-30' }),
          ),
        ),
      ).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  // ───────────────────────────── isolation ─────────────────────────────
  describe('tenant / company isolation', () => {
    it('the valid company is served; another company of the SAME tenant sees only its own ledger; a FOREIGN-tenant company is a plain 404', async () => {
      const a1 = await newCompany({ tenantId: tenantA });
      const a2 = await newCompany({ tenantId: tenantA });
      const b1 = await newCompany({ tenantId: tenantB });
      await entry(tenantA, a1, '2026-06-05', CASH, REV, 111n);
      await entry(tenantA, a2, '2026-06-05', CASH, REV, 222n);
      await entry(tenantB, b1, '2026-06-05', CASH, REV, 333n);

      // valid company
      const own = await tb(tenantA, a1, '2026-06-01', '2026-06-30');
      expect(row(own, CASH).periodDebitMinor).toBe('111');
      // wrong company (same tenant): it is its OWN data, never a blend
      const sibling = await tb(tenantA, a2, '2026-06-01', '2026-06-30');
      expect(row(sibling, CASH).periodDebitMinor).toBe('222');
      expect(sibling.companyId).toBe(a2);
      // cross tenant: A asks for B's company, B asks for A's company → indistinguishable from "no such company"
      for (const [tenant, company] of [
        [tenantA, b1],
        [tenantB, a1],
        [tenantA, randomUUID()],
      ] as const) {
        let err: unknown;
        try {
          await tb(tenant, company, '2026-06-01', '2026-06-30');
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as NotFoundError).status).toBe(404);
        // non-disclosing: the message names nothing about the other tenant
        expect((err as NotFoundError).message).toBe('company not found');
      }
      // tenant B's own company is fine
      const bOwn = await tb(tenantB, b1, '2026-06-01', '2026-06-30');
      expect(row(bOwn, CASH).periodDebitMinor).toBe('333');
    });

    it('a malformed company id is rejected before any query; no tenant context fails closed', async () => {
      await expect(
        inTenant(tenantA, () =>
          service.get({ companyId: 'not-a-uuid', from: '2026-06-01', to: '2026-06-30' }),
        ),
      ).rejects.toBeInstanceOf(DomainError);
      await expect(
        service.get({ companyId: randomUUID(), from: '2026-06-01', to: '2026-06-30' }),
      ).rejects.toThrow();
    });

    it('a report mutates nothing: the transaction is database-enforced READ ONLY, and the ledger is unchanged by reads', async () => {
      class WriteProbe extends ReportingRepository {
        constructor(d: DbService) {
          super(d);
        }
        tryWrite(companyId: string) {
          return this.readScoped((tx) =>
            tx.$executeRawUnsafe(
              `UPDATE company SET "legalNameEn" = 'tampered' WHERE id = '${companyId}'`,
            ),
          );
        }
      }
      const co = await newCompany({ tenantId: tenantA });
      await entry(tenantA, co, '2026-06-05', CASH, REV, 5n);
      const before = await adminQuery(
        `SELECT (SELECT count(*) FROM journal_entry)::int AS e, (SELECT count(*) FROM journal_line)::int AS l,
                (SELECT count(*) FROM audit_log)::int AS a, (SELECT count(*) FROM outbox)::int AS o`,
      );
      await expect(inTenant(tenantA, () => new WriteProbe(db).tryWrite(co))).rejects.toThrow(
        /read-only transaction/i,
      );
      await tb(tenantA, co, '2026-06-01', '2026-06-30');
      const after = await adminQuery(
        `SELECT (SELECT count(*) FROM journal_entry)::int AS e, (SELECT count(*) FROM journal_line)::int AS l,
                (SELECT count(*) FROM audit_log)::int AS a, (SELECT count(*) FROM outbox)::int AS o`,
      );
      expect(after.rows[0]).toEqual(before.rows[0]); // no audit row, no outbox row, no ledger row
      const name = await adminQuery(`SELECT "legalNameEn" AS n FROM company WHERE id = $1`, [co]);
      expect(name.rows[0]!['n']).toBe('Report Test Co');
    });
  });
});
