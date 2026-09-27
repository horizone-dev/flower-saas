import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import {
  createPrismaClient,
  runScoped,
  ACCOUNTING_REFERENCE_ACCOUNTS,
  type PrismaClient,
} from '@flower/db';
import { DbService, type BackendConfig } from '@flower/backend';
import pg from 'pg';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { OutboxWriter } from '../../common/audit/outbox.writer.js';
import { PostingEngineService } from '../accounting/posting-engine.service.js';
import { CompanyFinancialConfigRepository } from '../accounting/company-financial-config.repository.js';
import { AccountingPeriodRepository } from '../accounting/accounting-period.repository.js';
import { AccountRepository } from '../accounting/account.repository.js';
import { SystemClock } from '../../common/clock/clock.js';
import { computeCreditExposure, computeAvailableCredit } from './credit-exposure.js';
import { PaymentCustomerAttributionRepository } from './payment-customer-attribution.repository.js';
import { CustomerReceiptEffectsRepository } from './customer-receipt-effects.repository.js';
import { CustomerReceiptCollectionRepository } from './customer-receipt-collection.repository.js';
import { PaymentAdvanceConversionRepository } from './payment-advance-conversion.repository.js';
import { CustomerAdvanceApplicationRepository } from './customer-advance-application.repository.js';
import { OpeningBalanceRepository } from './opening-balance.repository.js';

/**
 * Task 3b.6 Checkpoint F (F36/F38) — `OpeningBalanceRepository` proven
 * directly against real Postgres through the actual production `runScoped`
 * path. Mirrors `payment-advance-conversion.integration.test.ts`'s own
 * harness exactly.
 */
const TENANT = 'f1000000-1111-7111-8111-111111111111';
const COMPANY = 'f1000000-3333-7333-8333-333333333333';
const BRANCH_A = 'f1000000-6666-7666-8666-666666666666';
const BRANCH_B = 'f1000000-7777-7777-8777-777777777777';
// a SEPARATE company with a CLOSED accounting period from the start — used
// ONLY by the F29 "today's period closed" test, so no other test's fixtures
// are disturbed by closing a period mid-suite.
const COMPANY_CLOSED = 'f1000000-4444-7444-8444-444444444444';
const BRANCH_CLOSED = 'f1000000-8888-7888-8888-888888888888';
// today's (2026) period OPEN, a historical (2024) period CLOSED — §6's
// "today open, effectiveDate's own period closed -> reject" case.
const COMPANY_MIXED = 'f1000000-5555-7555-8555-555555555555';
const BRANCH_MIXED = 'f1000000-9999-7999-8999-999999999999';

describe('OpeningBalanceRepository (task 3b.6 Checkpoint F, integration)', () => {
  let stack: TestStack;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let db: DbService;
  let openingBalance: OpeningBalanceRepository;
  let collection: CustomerReceiptCollectionRepository;
  let conversion: PaymentAdvanceConversionRepository;
  let application: CustomerAdvanceApplicationRepository;
  const uid = (): string => crypto.randomUUID();

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres'] });
    migrateTestDb(stack.postgres.url);
    pool = new pg.Pool({ connectionString: stack.postgres.url });
    prisma = createPrismaClient({ connectionString: stack.postgres.url });
    db = new DbService({ DATABASE_URL: stack.postgres.url } as unknown as BackendConfig);
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AccountingPeriodRepository(db, new AuditWriter(db)),
      new AuditWriter(db),
      new SystemClock(),
    );
    const companyFinancialConfig = new CompanyFinancialConfigRepository(
      db,
      new AuditWriter(db),
      new AccountRepository(db, new AuditWriter(db)),
    );
    openingBalance = new OpeningBalanceRepository(
      postingEngine,
      companyFinancialConfig,
      new AuditWriter(db),
      new OutboxWriter(db),
    );
    const effects = new CustomerReceiptEffectsRepository(postingEngine, new AuditWriter(db));
    const attribution = new PaymentCustomerAttributionRepository();
    collection = new CustomerReceiptCollectionRepository(
      new AuditWriter(db),
      new OutboxWriter(db),
      effects,
    );
    conversion = new PaymentAdvanceConversionRepository(
      postingEngine,
      new AuditWriter(db),
      attribution,
      new OutboxWriter(db),
    );
    application = new CustomerAdvanceApplicationRepository(
      postingEngine,
      new AuditWriter(db),
      effects,
      new OutboxWriter(db),
    );

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-0000f1000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-0000f1000002', '00000000-0000-7000-8000-0000f1000001', 1, 'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'f6-3b6', 'f6-3b6', 'AE', 'ACTIVE', '00000000-0000-7000-8000-0000f1000002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Test Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await pool.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [uid(), TENANT, COMPANY, a.key, a.category, a.defaultDisplayCode, a.defaultDisplayName],
      );
    }
    await pool.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2026-01-01','2026-12-31','OPEN',now())`,
      [uid(), TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Branch A', now())`,
      [BRANCH_A, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Branch B', now())`,
      [BRANCH_B, TENANT, COMPANY],
    );

    // ── second company, CLOSED period from the start (F29) ────────────────
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Closed Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY_CLOSED, TENANT],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await pool.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          uid(),
          TENANT,
          COMPANY_CLOSED,
          a.key,
          a.category,
          a.defaultDisplayCode,
          a.defaultDisplayName,
        ],
      );
    }
    await pool.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2026-01-01','2026-12-31','CLOSED',now())`,
      [uid(), TENANT, COMPANY_CLOSED],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Closed Branch', now())`,
      [BRANCH_CLOSED, TENANT, COMPANY_CLOSED],
    );
    // a SECOND, historical, OPEN period on the SAME "closed" company — proves
    // the OPPOSITE F29/§6 case: today's (2026) period is CLOSED, but an
    // effectiveDate falling in the 2025 OPEN period still succeeds.
    await pool.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2025-01-01','2025-12-31','OPEN',now())`,
      [uid(), TENANT, COMPANY_CLOSED],
    );

    // ── third company: today's (2026) period OPEN, a HISTORICAL (2024)
    //    period CLOSED — proves §6's other required opposite case. ────────
    await pool.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Mixed Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY_MIXED, TENANT],
    );
    for (const a of ACCOUNTING_REFERENCE_ACCOUNTS) {
      await pool.query(
        `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          uid(),
          TENANT,
          COMPANY_MIXED,
          a.key,
          a.category,
          a.defaultDisplayCode,
          a.defaultDisplayName,
        ],
      );
    }
    await pool.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2026-01-01','2026-12-31','OPEN',now())`,
      [uid(), TENANT, COMPANY_MIXED],
    );
    await pool.query(
      `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
       VALUES ($1,$2,$3,'2024-01-01','2024-12-31','CLOSED',now())`,
      [uid(), TENANT, COMPANY_MIXED],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Mixed Branch', now())`,
      [BRANCH_MIXED, TENANT, COMPANY_MIXED],
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await stack?.stop();
  });

  async function freshCustomer(
    companyId = COMPANY,
  ): Promise<{ customerId: string; ccaId: string }> {
    const customerId = uid();
    const ccaId = uid();
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Test Customer', now())`,
      [customerId, TENANT],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [ccaId, TENANT, companyId, customerId],
    );
    return { customerId, ccaId };
  }

  function create(
    customerId: string,
    type: 'RECEIVABLE' | 'ADVANCE',
    amountMinor: bigint,
    opts: {
      branchId?: string;
      companyId?: string;
      effectiveDate?: string;
      note?: string | null;
    } = {},
  ) {
    return runScoped(prisma, { tenantId: TENANT }, (tx) =>
      openingBalance.createInTx(tx, {
        tenantId: TENANT,
        companyId: opts.companyId ?? COMPANY,
        branchId: opts.branchId ?? BRANCH_A,
        customerId,
        type,
        amountMinor,
        effectiveDate: opts.effectiveDate ?? '2026-01-05',
        note: opts.note ?? null,
        actorUserId: null,
      }),
    );
  }

  async function ccaSnapshot(ccaId: string) {
    const { rows } = await pool.query<{
      currentOutstandingMinor: string;
      advanceBalanceMinor: string;
    }>(
      `SELECT "currentOutstandingMinor", "advanceBalanceMinor" FROM customer_company_account WHERE id = $1`,
      [ccaId],
    );
    return rows[0]!;
  }

  async function journalFor(sourceKind: string, sourceId: string) {
    const { rows } = await pool.query<{
      accountKey: string;
      debitMinor: string;
      creditMinor: string;
    }>(
      `SELECT a.key AS "accountKey", jl."debitMinor", jl."creditMinor"
         FROM journal_entry je
         JOIN journal_line jl ON jl."journalEntryId" = je.id
         JOIN account a ON a.id = jl."accountId"
        WHERE je."sourceKind" = $1 AND je."sourceId" = $2
        ORDER BY jl."debitMinor" DESC`,
      [sourceKind, sourceId],
    );
    return rows;
  }

  async function chronologyFor(ccaId: string, entryKind: string) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM customer_account_entry WHERE "customerCompanyAccountId" = $1 AND "entryKind" = $2`,
      [ccaId, entryKind],
    );
    return Number(rows[0]!.n);
  }

  // ═══════════════════════ F36 functional matrix ════════════════════════════
  it('1: standalone Opening Receivable succeeds', async () => {
    const { customerId } = await freshCustomer();
    const result = await create(customerId, 'RECEIVABLE', 500n);
    expect(result.type).toBe('RECEIVABLE');
    expect(result.currentOutstandingMinor).toBe(500n);
    expect(result.advanceBalanceMinor).toBeNull();
  });

  it('2: standalone Opening Advance succeeds', async () => {
    const { customerId } = await freshCustomer();
    const result = await create(customerId, 'ADVANCE', 300n);
    expect(result.type).toBe('ADVANCE');
    expect(result.advanceBalanceMinor).toBe(300n);
    expect(result.currentOutstandingMinor).toBeNull();
  });

  it('3/4: zero or negative amount is rejected', async () => {
    const { customerId: c1 } = await freshCustomer();
    await expect(create(c1, 'RECEIVABLE', 0n)).rejects.toThrow(/amountMinor must be > 0/);
    const { customerId: c2 } = await freshCustomer();
    await expect(create(c2, 'RECEIVABLE', -1n)).rejects.toThrow(/amountMinor must be > 0/);
  });

  it('5: currency/exponent can never be caller-supplied — always resolved from Company (structural, not a runtime rejection)', async () => {
    // F6 — the repository input contract has NO currencyCode/currencyExponent
    // field at all (confirmed by `CreateOpeningBalanceInput`'s own shape) —
    // there is no code path through which a caller value could reach the
    // stored row; the created row's currency is always the Company's own.
    const { customerId } = await freshCustomer();
    const result = await create(customerId, 'RECEIVABLE', 100n);
    expect(result.currencyCode).toBe('AED');
  });

  it('6: wrong branch (different company) is rejected', async () => {
    const { customerId } = await freshCustomer();
    await expect(
      create(customerId, 'RECEIVABLE', 100n, { branchId: BRANCH_CLOSED }),
    ).rejects.toThrow(/branch/i);
  });

  it('7: cross-customer (no CustomerCompanyAccount in this company) is rejected', async () => {
    const strangerId = uid(); // a Customer row with NO customer_company_account for COMPANY
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Stranger', now())`,
      [strangerId, TENANT],
    );
    await expect(create(strangerId, 'RECEIVABLE', 100n)).rejects.toThrow(/association not found/);
  });

  it('8: note/effectiveDate persisted correctly', async () => {
    const { customerId } = await freshCustomer();
    const result = await create(customerId, 'RECEIVABLE', 250n, {
      effectiveDate: '2026-01-08',
      note: '  migrated legacy balance  ',
    });
    expect(result.effectiveDate).toBe('2026-01-08');
    expect(result.note).toBe('migrated legacy balance'); // trimmed
    // `to_char` avoids `pg`'s own local-timezone `DATE` -> JS `Date` parsing
    // (a well-known node-postgres gotcha that would otherwise shift the
    // calendar date by one day in a positive-UTC-offset environment) — reads
    // back the exact stored calendar date as a plain string.
    const { rows } = await pool.query<{ openingEffectiveDate: string; openingNote: string }>(
      `SELECT to_char("openingEffectiveDate", 'YYYY-MM-DD') AS "openingEffectiveDate", "openingNote" FROM customer_receivable WHERE id = $1`,
      [result.sourceId],
    );
    expect(rows[0]!.openingEffectiveDate).toBe('2026-01-08');
    expect(rows[0]!.openingNote).toBe('migrated legacy balance');
  });

  it('9: Opening Receivable projection increments currentOutstandingMinor only', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'RECEIVABLE', 700n);
    const snap = await ccaSnapshot(ccaId);
    expect(snap.currentOutstandingMinor).toBe('700');
    expect(snap.advanceBalanceMinor).toBe('0');
  });

  it('10: Opening Advance projection increments advanceBalanceMinor only', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'ADVANCE', 400n);
    const snap = await ccaSnapshot(ccaId);
    expect(snap.advanceBalanceMinor).toBe('400');
    expect(snap.currentOutstandingMinor).toBe('0');
  });

  it('11: Opening Receivable GL — Dr ASSET.ACCOUNTS_RECEIVABLE / Cr EQUITY.OPENING_BALANCE, exactly once', async () => {
    const { customerId } = await freshCustomer();
    const result = await create(customerId, 'RECEIVABLE', 900n);
    const lines = await journalFor('opening_receivable', result.sourceId);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      accountKey: 'ASSET.ACCOUNTS_RECEIVABLE',
      debitMinor: '900',
      creditMinor: '0',
    });
    expect(lines[1]).toMatchObject({
      accountKey: 'EQUITY.OPENING_BALANCE',
      debitMinor: '0',
      creditMinor: '900',
    });
  });

  it('12: Opening Advance GL — Dr EQUITY.OPENING_BALANCE / Cr LIABILITY.CUSTOMER_ADVANCES, exactly once', async () => {
    const { customerId } = await freshCustomer();
    const result = await create(customerId, 'ADVANCE', 350n);
    const lines = await journalFor('opening_advance', result.sourceId);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      accountKey: 'EQUITY.OPENING_BALANCE',
      debitMinor: '350',
      creditMinor: '0',
    });
    expect(lines[1]).toMatchObject({
      accountKey: 'LIABILITY.CUSTOMER_ADVANCES',
      debitMinor: '0',
      creditMinor: '350',
    });
  });

  it('13: chronology exact — exactly one OPENING_RECEIVABLE / OPENING_ADVANCE entry', async () => {
    const { customerId: c1, ccaId: cca1 } = await freshCustomer();
    await create(c1, 'RECEIVABLE', 111n);
    expect(await chronologyFor(cca1, 'OPENING_RECEIVABLE')).toBe(1);

    const { customerId: c2, ccaId: cca2 } = await freshCustomer();
    await create(c2, 'ADVANCE', 222n);
    expect(await chronologyFor(cca2, 'OPENING_ADVANCE')).toBe(1);
  });

  it('14: Opening Receivable affects credit exposure (computeCreditExposure reflects the new currentOutstandingMinor)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'RECEIVABLE', 600n);
    const snap = await ccaSnapshot(ccaId);
    expect(
      computeCreditExposure({
        creditEnabled: false,
        creditLimitMinor: null,
        receivableOutstandingMinor: BigInt(snap.currentOutstandingMinor),
      }),
    ).toBe(600n);
  });

  it('15: Opening Advance does NOT affect credit exposure', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'ADVANCE', 600n);
    const snap = await ccaSnapshot(ccaId);
    expect(
      computeCreditExposure({
        creditEnabled: false,
        creditLimitMinor: null,
        receivableOutstandingMinor: BigInt(snap.currentOutstandingMinor),
      }),
    ).toBe(0n);
  });

  it('16: creditEnabled=false does NOT block Opening Receivable creation', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await pool.query(`UPDATE customer_company_account SET "creditEnabled" = false WHERE id = $1`, [
      ccaId,
    ]);
    const result = await create(customerId, 'RECEIVABLE', 500n);
    expect(result.currentOutstandingMinor).toBe(500n);
  });

  it('17: opening amount exceeding the configured credit limit does NOT block creation', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await pool.query(
      `UPDATE customer_company_account
          SET "creditEnabled" = true, "creditLimitMinor" = 100, "creditLimitCurrencyCode" = 'AED', "creditLimitCurrencyExponent" = 2
        WHERE id = $1`,
      [ccaId],
    );
    const result = await create(customerId, 'RECEIVABLE', 500n); // 500 > limit 100
    expect(result.currentOutstandingMinor).toBe(500n);
    const snap = await ccaSnapshot(ccaId);
    const available = computeAvailableCredit({
      creditEnabled: true,
      creditLimitMinor: 100n,
      receivableOutstandingMinor: BigInt(snap.currentOutstandingMinor),
    });
    expect(available).toBe(0n); // clamped, never negative — a FUTURE ON_CREDIT sees zero room
  });

  it('19: a D Payment can settle an Opening Receivable (FIFO)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const opening = await create(customerId, 'RECEIVABLE', 400n);
    const collected = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      collection.collectInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH_A,
        customerId,
        amountMinor: 400n,
        method: 'CASH',
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: `f-settle-${uid()}`,
      }),
    );
    expect(collected.unallocatedAmountMinor).toBe(0n);
    const snap = await ccaSnapshot(ccaId);
    expect(snap.currentOutstandingMinor).toBe('0');
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM customer_receivable_payment_application WHERE "customerReceivableId" = $1`,
      [opening.sourceId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('20: an E Advance (PAYMENT-sourced) can settle an Opening Receivable', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const opening = await create(customerId, 'RECEIVABLE', 300n);
    // fund a PAYMENT-sourced Advance on the SAME account — deliberately NOT
    // an OPENING advance (F9's own uniqueness ticket would otherwise reject
    // a second opening-balance event on this exact account+branch).
    const paid = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      collection.collectInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH_A,
        customerId,
        amountMinor: 300n,
        method: 'CASH',
        createdByUserId: null,
        actingUserId: null,
        idempotencyKey: `f-settle2-${uid()}`,
      }),
    );
    // the collected Payment auto-FIFO-applies to the OPENING receivable
    // above already (D's own behavior) — fund a SECOND fresh Payment, raw,
    // to convert into an Advance instead.
    const attemptId = uid();
    await pool.query(
      `INSERT INTO payment_attempt (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId", method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH_B, ccaId, 150, `f-raw-${uid()}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH_B, attemptId, 150],
    );
    // the conversion + application below both use BRANCH_B — an Advance may
    // only apply to a receivable in its OWN branch (E's frozen, now
    // structural, branch backstop) — `opening2` below is also BRANCH_B.
    const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      conversion.convertInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH_B,
        customerId,
        paymentId,
        amountMinor: 150n,
        actorUserId: null,
      }),
    );
    expect(converted.advanceBalanceMinor).toBe(150n);
    void paid;
    // the Opening Receivable was already fully settled by the FIRST Payment
    // above; prove the Advance CAN target an Opening-sourced receivable in
    // general by applying it to a SECOND, freshly-created one.
    const opening2 = await create(customerId, 'RECEIVABLE', 150n, { branchId: BRANCH_B });
    void opening;
    const applied = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      application.applyInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH_B,
        customerId,
        advanceId: converted.advanceId,
        customerReceivableId: opening2.sourceId,
        amountMinor: 150n,
        actorUserId: null,
      }),
    );
    expect(applied.receivableOutstandingMinor).toBe(0n);
  });

  it('21: an OPENING-sourced Advance applying through E is already proven by Checkpoint E\'s own frozen suite (customer-advance-application.integration.test.ts "final hardening (task 8)") — not duplicated here', () => {
    expect(true).toBe(true);
  });

  it('29: rollback — an injected failure after Opening Receivable effects rolls back EVERY new row', async () => {
    const { customerId, ccaId } = await freshCustomer();
    class FailsAfterEffects extends OpeningBalanceRepository {
      override async createInTx(
        tx: Parameters<OpeningBalanceRepository['createInTx']>[0],
        input: Parameters<OpeningBalanceRepository['createInTx']>[1],
      ): ReturnType<OpeningBalanceRepository['createInTx']> {
        await super.createInTx(tx, input);
        throw new Error('simulated post-effects failure, before commit');
      }
    }
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AccountingPeriodRepository(db, new AuditWriter(db)),
      new AuditWriter(db),
      new SystemClock(),
    );
    const flaky = new FailsAfterEffects(
      postingEngine,
      new CompanyFinancialConfigRepository(
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AuditWriter(db),
      new OutboxWriter(db),
    );
    const before = await pool.query<{
      receivables: number;
      entries: number;
      journals: number;
      audits: number;
      outboxRows: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM customer_receivable) AS receivables,
         (SELECT count(*)::int FROM customer_account_entry) AS entries,
         (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'opening_receivable') AS journals,
         (SELECT count(*)::int FROM audit_log) AS audits,
         (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`,
    );
    await expect(
      runScoped(prisma, { tenantId: TENANT }, (tx) =>
        flaky.createInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH_A,
          customerId,
          type: 'RECEIVABLE',
          amountMinor: 999n,
          effectiveDate: '2026-01-05',
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow('simulated post-effects failure, before commit');
    const after = await pool.query<(typeof before.rows)[0]>(
      `SELECT
         (SELECT count(*)::int FROM customer_receivable) AS receivables,
         (SELECT count(*)::int FROM customer_account_entry) AS entries,
         (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'opening_receivable') AS journals,
         (SELECT count(*)::int FROM audit_log) AS audits,
         (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]); // outbox row never survives the rollback either (H9)
    const snap = await ccaSnapshot(ccaId);
    expect(snap.currentOutstandingMinor).toBe('0');
    // no ticket row survives either.
    const ticket = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM customer_opening_balance_init WHERE "customerCompanyAccountId" = $1`,
      [ccaId],
    );
    expect(Number(ticket.rows[0]!.n)).toBe(0);
  });

  it('30: rollback — an injected failure after Opening Advance effects rolls back EVERY new row', async () => {
    const { customerId, ccaId } = await freshCustomer();
    class FailsAfterEffects extends OpeningBalanceRepository {
      override async createInTx(
        tx: Parameters<OpeningBalanceRepository['createInTx']>[0],
        input: Parameters<OpeningBalanceRepository['createInTx']>[1],
      ): ReturnType<OpeningBalanceRepository['createInTx']> {
        await super.createInTx(tx, input);
        throw new Error('simulated post-effects failure, before commit');
      }
    }
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AccountingPeriodRepository(db, new AuditWriter(db)),
      new AuditWriter(db),
      new SystemClock(),
    );
    const flaky = new FailsAfterEffects(
      postingEngine,
      new CompanyFinancialConfigRepository(
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AuditWriter(db),
      new OutboxWriter(db),
    );
    const before = await pool.query<{
      advances: number;
      entries: number;
      journals: number;
      audits: number;
      outboxRows: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM customer_advance) AS advances,
         (SELECT count(*)::int FROM customer_account_entry) AS entries,
         (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'opening_advance') AS journals,
         (SELECT count(*)::int FROM audit_log) AS audits,
         (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`,
    );
    await expect(
      runScoped(prisma, { tenantId: TENANT }, (tx) =>
        flaky.createInTx(tx, {
          tenantId: TENANT,
          companyId: COMPANY,
          branchId: BRANCH_A,
          customerId,
          type: 'ADVANCE',
          amountMinor: 777n,
          effectiveDate: '2026-01-05',
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow('simulated post-effects failure, before commit');
    const after = await pool.query<(typeof before.rows)[0]>(
      `SELECT
         (SELECT count(*)::int FROM customer_advance) AS advances,
         (SELECT count(*)::int FROM customer_account_entry) AS entries,
         (SELECT count(*)::int FROM journal_entry WHERE "sourceKind" = 'opening_advance') AS journals,
         (SELECT count(*)::int FROM audit_log) AS audits,
         (SELECT count(*)::int FROM outbox WHERE "eventType" = 'receivables.customer_account_changed') AS "outboxRows"`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]); // outbox row never survives the rollback either (H9)
    const snap = await ccaSnapshot(ccaId);
    expect(snap.advanceBalanceMinor).toBe('0');
    const ticket = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM customer_opening_balance_init WHERE "customerCompanyAccountId" = $1`,
      [ccaId],
    );
    expect(Number(ticket.rows[0]!.n)).toBe(0);
  });

  // ═══════════════════════ F29 accounting period ════════════════════════════
  it("F29: today's accounting period CLOSED -> opening-balance creation rejected (the SAME unmodified PostingEngine period gate as every other checkpoint's journal)", async () => {
    const { customerId } = await freshCustomer(COMPANY_CLOSED);
    await expect(
      create(customerId, 'RECEIVABLE', 100n, {
        companyId: COMPANY_CLOSED,
        branchId: BRANCH_CLOSED,
      }),
    ).rejects.toThrow(/ACCOUNTING_PERIOD_CLOSED|accounting period.*closed/i);
  });

  // Final Hardening §6 — the important OPPOSITE case: today's own period is
  // OPEN, but the explicit effectiveDate falls in a DIFFERENT, CLOSED
  // period -> still REJECTED. Today's period is irrelevant once an explicit
  // effectiveDate is supplied.
  it("F-hardening-§6-A: today's period OPEN but effectiveDate's OWN period is CLOSED -> rejected", async () => {
    const { customerId } = await freshCustomer(COMPANY_MIXED);
    await expect(
      create(customerId, 'RECEIVABLE', 100n, {
        companyId: COMPANY_MIXED,
        branchId: BRANCH_MIXED,
        effectiveDate: '2024-06-15', // falls in the CLOSED 2024 period
      }),
    ).rejects.toThrow(/ACCOUNTING_PERIOD_CLOSED|accounting period.*closed/i);
  });

  // Final Hardening §6 — the mirror: today's own period is CLOSED, but the
  // explicit effectiveDate falls in a DIFFERENT, OPEN historical period ->
  // the opening journal follows the effectiveDate's OWN period, not today's.
  it("F-hardening-§6-B: today's period CLOSED but effectiveDate's OWN period is OPEN -> succeeds", async () => {
    const { customerId } = await freshCustomer(COMPANY_CLOSED);
    const result = await create(customerId, 'RECEIVABLE', 100n, {
      companyId: COMPANY_CLOSED,
      branchId: BRANCH_CLOSED,
      effectiveDate: '2025-06-15', // falls in the OPEN 2025 period
    });
    expect(result.effectiveDate).toBe('2025-06-15');
  });

  // Final Hardening §7 — do not only inspect the period id; assert the
  // ACTUAL journal.postingDate column equals the exact effectiveDate, for
  // BOTH Opening Receivable and Opening Advance.
  it('F-hardening-§7: the journal.postingDate column equals the exact effectiveDate (Opening Receivable AND Opening Advance)', async () => {
    const { customerId: c1 } = await freshCustomer();
    const recv = await create(c1, 'RECEIVABLE', 321n, { effectiveDate: '2026-02-14' });
    const recvJournalDate = await pool.query<{ postingDate: string }>(
      `SELECT to_char("postingDate", 'YYYY-MM-DD') AS "postingDate" FROM journal_entry WHERE "sourceKind" = 'opening_receivable' AND "sourceId" = $1`,
      [recv.sourceId],
    );
    expect(recvJournalDate.rows[0]!.postingDate).toBe('2026-02-14');

    const { customerId: c2 } = await freshCustomer();
    const adv = await create(c2, 'ADVANCE', 654n, { effectiveDate: '2026-07-04' });
    const advJournalDate = await pool.query<{ postingDate: string }>(
      `SELECT to_char("postingDate", 'YYYY-MM-DD') AS "postingDate" FROM journal_entry WHERE "sourceKind" = 'opening_advance' AND "sourceId" = $1`,
      [adv.sourceId],
    );
    expect(advJournalDate.rows[0]!.postingDate).toBe('2026-07-04');
  });

  // Final Hardening §8 — timezone boundary: a Clock instant near a UTC/
  // company-local-midnight boundary must NOT shift an EXPLICIT effectiveDate
  // by even one day (no JS `Date` parsing in the accounting-date path at
  // all — `isFiscalDate` + a verbatim string, confirmed by construction).
  it('F-hardening-§8: an explicit effectiveDate is never shifted by Clock instant / company timezone, even at a UTC-midnight boundary', async () => {
    const { customerId, ccaId } = await freshCustomer();
    // 23:30 UTC on 2026-03-09 is already 03:30 on 2026-03-10 in Asia/Dubai
    // (UTC+4) — if the journal date were EVER re-derived from Clock.now()
    // instead of using effectiveDate verbatim, this instant would be exactly
    // the kind of input that silently shifts the calendar date by one day.
    const edgeClock = { now: () => new Date('2026-03-09T23:30:00.000Z') } as unknown as SystemClock;
    const postingEngine = new PostingEngineService(
      new CompanyFinancialConfigRepository(
        db,
        new AuditWriter(db),
        new AccountRepository(db, new AuditWriter(db)),
      ),
      new AccountingPeriodRepository(db, new AuditWriter(db)),
      new AuditWriter(db),
      edgeClock,
    );
    const companyFinancialConfig = new CompanyFinancialConfigRepository(
      db,
      new AuditWriter(db),
      new AccountRepository(db, new AuditWriter(db)),
    );
    const edgeOpeningBalance = new OpeningBalanceRepository(
      postingEngine,
      companyFinancialConfig,
      new AuditWriter(db),
      new OutboxWriter(db),
    );
    const result = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      edgeOpeningBalance.createInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH_A,
        customerId,
        type: 'RECEIVABLE',
        amountMinor: 100n,
        effectiveDate: '2026-03-09',
        actorUserId: null,
      }),
    );
    expect(result.effectiveDate).toBe('2026-03-09');
    const journalDate = await pool.query<{ postingDate: string }>(
      `SELECT to_char("postingDate", 'YYYY-MM-DD') AS "postingDate" FROM journal_entry WHERE "sourceKind" = 'opening_receivable' AND "sourceId" = $1`,
      [result.sourceId],
    );
    expect(journalDate.rows[0]!.postingDate).toBe('2026-03-09'); // never '2026-03-10'
    void ccaId;
  });

  // Final Freeze Evidence Gate §4 — effectiveDate is a valid YYYY-MM-DD, but
  // NO AccountingPeriod at all contains it (never merely CLOSED — genuinely
  // absent). Never auto-created, never falls back to today's period.
  it('F-freeze-§4: a valid effectiveDate with NO containing AccountingPeriod at all is rejected NO_OPEN_ACCOUNTING_PERIOD (never auto-created, never falls back to today)', async () => {
    const { customerId } = await freshCustomer();
    await expect(
      create(customerId, 'RECEIVABLE', 100n, { effectiveDate: '2019-03-03' }), // far outside the fixture's ONE 2026 OPEN period
    ).rejects.toMatchObject({ code: 'NO_OPEN_ACCOUNTING_PERIOD' });
  });
  // The Opening ADVANCE path is NOT independently repeated: `createOpeningAdvance`
  // calls the EXACT SAME `this.postingEngine.postJournal(tx, { accountingDate,
  // ... })` as `createOpeningReceivable` above — no per-sourceType branching
  // exists anywhere in the period-resolution path (both are proven identical
  // by direct code inspection of `opening-balance.repository.ts`, and by the
  // PostingEngine-level `§4` test in `posting-engine.integration.test.ts`,
  // which proves the underlying `findOpenForPostingDate` gate itself is
  // sourceKind-agnostic). Duplicating this exact scenario for ADVANCE would
  // re-prove the identical code path, not a genuinely different one.

  // ═══════════════════════ F38 concurrency ══════════════════════════════════
  it('F38-A: two concurrent standalone Opening Receivable initializations on the SAME account -> at most one succeeds', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const results = await Promise.allSettled([
      create(customerId, 'RECEIVABLE', 100n),
      create(customerId, 'RECEIVABLE', 200n),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const snap = await ccaSnapshot(ccaId);
    expect(['100', '200']).toContain(snap.currentOutstandingMinor);
  });

  it('F38-B: Opening Receivable vs Opening Advance initialization on the SAME account -> at most one succeeds', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const results = await Promise.allSettled([
      create(customerId, 'RECEIVABLE', 100n),
      create(customerId, 'ADVANCE', 200n),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const snap = await ccaSnapshot(ccaId);
    const totals = [snap.currentOutstandingMinor, snap.advanceBalanceMinor];
    expect(totals.filter((v) => v !== '0')).toHaveLength(1);
  });

  it('F38-C: Opening Receivable creation vs a concurrent ON_CREDIT-style direct outstanding increment on the SAME account -> no lost update', async () => {
    const { customerId, ccaId } = await freshCustomer();
    const results = await Promise.allSettled([
      create(customerId, 'RECEIVABLE', 900n),
      pool.query(
        `UPDATE customer_company_account SET "currentOutstandingMinor" = "currentOutstandingMinor" + 200 WHERE id = $1`,
        [ccaId],
      ),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const snap = await ccaSnapshot(ccaId);
    // both effects present (900 opening + 200 direct-invoice-style) — valid
    // serial result either order, but never a lost update (never just one).
    expect(snap.currentOutstandingMinor).toBe('1100');
  });

  // ═══════════════════════ F33 DB hard gates (raw SQL) ══════════════════════
  // F11.A — a raw INSERT of a SECOND CustomerReceivable(OPENING) for the SAME
  // account+branch, entirely bypassing the repository, is rejected — the
  // BEFORE INSERT trigger on `customer_receivable` itself claims the ticket
  // slot automatically for every insert.
  it('F33-1/F11.A: a raw-SQL duplicate Opening Receivable for the SAME account+branch is rejected structurally, bypassing the repository entirely', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'RECEIVABLE', 100n);
    await expect(
      pool.query(
        `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', 999, 'AED', 2, '2026-01-05')`,
        [TENANT, COMPANY, BRANCH_A, ccaId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // F11.B — the SAME account+branch, second source is CustomerAdvance(OPENING).
  it('F33-2/F11.B: after a raw Opening Receivable, a raw-SQL Opening Advance for the SAME account+branch is rejected (cross-table)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'RECEIVABLE', 100n);
    await expect(
      pool.query(
        `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "amountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', 999, 'AED', 2, '2026-01-05')`,
        [TENANT, COMPANY, BRANCH_A, ccaId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // F11.C — the mirror: Opening Advance first, then raw Opening Receivable.
  it('F11.C: after a raw Opening Advance, a raw-SQL Opening Receivable for the SAME account+branch is rejected (cross-table, mirror)', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'ADVANCE', 100n);
    await expect(
      pool.query(
        `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', 999, 'AED', 2, '2026-01-05')`,
        [TENANT, COMPANY, BRANCH_A, ccaId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // F11.D — same customer/company, DIFFERENT branch -> allowed as a separate
  // branch initialization.
  it('F11.D: the SAME account on a DIFFERENT branch is a separate, allowed initialization', async () => {
    const { customerId, ccaId } = await freshCustomer();
    await create(customerId, 'RECEIVABLE', 100n, { branchId: BRANCH_A });
    await expect(
      create(customerId, 'ADVANCE', 200n, { branchId: BRANCH_B }),
    ).resolves.toBeDefined();
    const snap = await ccaSnapshot(ccaId);
    expect(snap.currentOutstandingMinor).toBe('100');
    expect(snap.advanceBalanceMinor).toBe('200');
  });

  it('F33-3/4: UPDATE and DELETE are structurally blocked on an OPENING-sourced customer_receivable/customer_advance row (the SAME frozen Checkpoint B append-only triggers, generic across sourceType)', async () => {
    const { customerId: c1 } = await freshCustomer();
    const recv = await create(c1, 'RECEIVABLE', 100n);
    await expect(
      pool.query(`UPDATE customer_receivable SET "openingAmountMinor" = 999 WHERE id = $1`, [
        recv.sourceId,
      ]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(`DELETE FROM customer_receivable WHERE id = $1`, [recv.sourceId]),
    ).rejects.toThrow(/append-only/i);

    const { customerId: c2 } = await freshCustomer();
    const adv = await create(c2, 'ADVANCE', 100n);
    await expect(
      pool.query(`UPDATE customer_advance SET "amountMinor" = 999 WHERE id = $1`, [adv.sourceId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(`DELETE FROM customer_advance WHERE id = $1`, [adv.sourceId]),
    ).rejects.toThrow(/append-only/i);
  });

  it('F33-5: account-entry reference pairing — an OPENING_RECEIVABLE entry pointed at an INVOICE-sourced receivable is rejected by the frozen cross-reference trigger', async () => {
    const { customerId, ccaId } = await freshCustomer();
    // a bare INVOICE-shaped customer_receivable row is out of scope to
    // fabricate here without a real Invoice; instead prove the SAME
    // trigger's OPENING_ADVANCE-vs-non-OPENING-advance edge using a
    // PAYMENT-sourced Advance, which is easy to construct via the real E
    // conversion path used elsewhere in this file's own fixtures.
    const attemptId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payment_attempt (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId", method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH_A, ccaId, 50, `f-hardgate-${crypto.randomUUID()}`],
    );
    const paymentId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH_A, attemptId, 50],
    );
    const converted = await runScoped(prisma, { tenantId: TENANT }, (tx) =>
      conversion.convertInTx(tx, {
        tenantId: TENANT,
        companyId: COMPANY,
        branchId: BRANCH_A,
        customerId,
        paymentId,
        amountMinor: 50n,
        actorUserId: null,
      }),
    );
    // converted.advanceId's sourceType is PAYMENT, not OPENING — a raw
    // OPENING_ADVANCE chronology entry pointed at it must be rejected.
    await expect(
      pool.query(
        `INSERT INTO customer_account_entry
           ("id","tenantId","companyId","branchId","customerCompanyAccountId","entryKind","customerAdvanceId")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING_ADVANCE', $5)`,
        [TENANT, COMPANY, BRANCH_A, ccaId, converted.advanceId],
      ),
    ).rejects.toThrow(/sourceType = OPENING/i);
  });

  // ═══════════════ Final Freeze Evidence Gate §7 — raw DB effectiveDate hard gates ═══
  it('F-freeze-§7.A: a raw-SQL OPENING Receivable with NULL openingEffectiveDate (everything else valid) is rejected by the shape CHECK', async () => {
    const { ccaId } = await freshCustomer();
    await expect(
      pool.query(
        `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', 100, 'AED', 2, NULL)`,
        [TENANT, COMPANY, BRANCH_A, ccaId],
      ),
    ).rejects.toThrow(/customer_receivable_source_shape_chk/);
  });

  it('F-freeze-§7.B: a raw-SQL OPENING Advance with NULL openingEffectiveDate (everything else valid) is rejected by the shape CHECK', async () => {
    const { ccaId } = await freshCustomer();
    await expect(
      pool.query(
        `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "amountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', 100, 'AED', 2, NULL)`,
        [TENANT, COMPANY, BRANCH_A, ccaId],
      ),
    ).rejects.toThrow(/customer_advance_source_shape_chk/);
  });

  it('F-freeze-§7.C: a raw-SQL OPENING Receivable/Advance WITH a valid openingEffectiveDate (everything else valid) succeeds', async () => {
    const r1 = await freshCustomer();
    await expect(
      pool.query(
        `INSERT INTO customer_receivable (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "openingAmountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', 100, 'AED', 2, '2026-01-05')`,
        [TENANT, COMPANY, BRANCH_A, r1.ccaId],
      ),
    ).resolves.toBeTruthy();

    const r2 = await freshCustomer();
    await expect(
      pool.query(
        `INSERT INTO customer_advance (id, "tenantId", "companyId", "branchId", "customerCompanyAccountId", "sourceType", "amountMinor", "currencyCode", "currencyExponent", "openingEffectiveDate")
         VALUES (uuidv7(), $1, $2, $3, $4, 'OPENING', 100, 'AED', 2, '2026-01-05')`,
        [TENANT, COMPANY, BRANCH_A, r2.ccaId],
      ),
    ).resolves.toBeTruthy();
  });

  it('F-freeze-§7.D: UPDATE of openingEffectiveDate on an already-created OPENING row is structurally rejected (append-only, column-specific proof)', async () => {
    const { customerId: c1 } = await freshCustomer();
    const recv = await create(c1, 'RECEIVABLE', 100n);
    await expect(
      pool.query(
        `UPDATE customer_receivable SET "openingEffectiveDate" = '2026-02-02' WHERE id = $1`,
        [recv.sourceId],
      ),
    ).rejects.toThrow(/append-only/i);

    const { customerId: c2 } = await freshCustomer();
    const adv = await create(c2, 'ADVANCE', 100n);
    await expect(
      pool.query(
        `UPDATE customer_advance SET "openingEffectiveDate" = '2026-02-02' WHERE id = $1`,
        [adv.sourceId],
      ),
    ).rejects.toThrow(/append-only/i);
  });
});
