import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '../src/index.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.7 Checkpoint B — the provider-settlement-reconciliation schema,
 * proven against real Postgres via raw SQL: `settlement_batch` /
 * `settlement_line` / `settlement_application` (schema + composite FKs +
 * CHECK constraints), the provider-credential branch-scope trigger, the
 * settlement-payment-capacity backstop, the settlement-application
 * integrity + eligibility trigger, append-only / FINALIZED-immutability
 * triggers, the deferred FINALIZED-completeness constraint trigger (A-N),
 * RLS, and the additive `EXPENSE.PAYMENT_PROCESSING_FEE` reference account
 * + existing-company backfill (migration
 * `20261003120000_settlement_core_schema`).
 *
 * Checkpoint B ships schema/RLS/FK/CHECK/trigger structure ONLY — no HTTP
 * API / CSV ingestion / matching service / finalization service / Invoice
 * SETTLED projection. Every row is inserted by raw SQL, exactly like
 * `receivables-schema.integration.test.ts` / `accounting-schema.integration.test.ts`
 * before it. The concurrent-allocation-race PROTOCOL itself (discovery #1 /
 * lock / discovery #2 / retry) is Checkpoint D service-layer orchestration —
 * out of scope here; this file proves only the DB-level primitive that
 * protocol depends on (the settlement-payment-capacity lock-then-validate
 * function, and that `customer_advance`'s own existing capacity trigger
 * already locks its parent FOR UPDATE, unchanged).
 */
const TENANT = 'aaaaaaaa-7111-7111-8111-111111111111';
const OTHER_TENANT = 'bbbbbbbb-7222-7222-8222-222222222222';
const COMPANY = 'cccccccc-7333-7333-8333-333333333333';
const OTHER_COMPANY = 'eeeeeeee-7555-7555-8555-555555555555';
const BRANCH = 'ffffffff-7666-7666-8666-666666666666';
const BRANCH_2 = '11111111-7777-7777-8777-777777777777'; // same company as BRANCH
const PERIOD = '22222222-7888-7888-8888-888888888888';
const ACCOUNT_BANK = '33333333-7999-7999-8999-999999999999';
const ACCOUNT_FEE = '44444444-7aaa-7aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_CLEARING = '55555555-7bbb-7bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_CASH = '66666666-7ccc-7ccc-8ccc-cccccccccccc'; // an "other account" for negative tests
const CRED_BRANCH = '77777777-7ddd-7ddd-8ddd-dddddddddddd';
const CRED_BRANCH_2 = '88888888-7eee-7eee-8eee-eeeeeeeeeeee';
const CRED_WRONG_COMPANY = '99999999-7fff-7fff-8fff-ffffffffffff';
const CRED_BRANCH_ALT = 'a0a0a0a0-7000-7000-8000-a0a0a0a0a0a0'; // second, DIFFERENT credential, SAME branch as CRED_BRANCH

describe('packages/db — Task 3b.7 Checkpoint B settlement schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  const uid = (): string => crypto.randomUUID();

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
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT, 'settle-3b7'],
      [OTHER_TENANT, 'settle-3b7-other'],
    ] as const) {
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [id, slug],
      );
    }
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
       VALUES ($1, $2, 'Other Co (same tenant)', 'AED', 'Asia/Dubai', now())`,
      [OTHER_COMPANY, TENANT],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Main Branch', now())`,
      [BRANCH, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Second Branch', now())`,
      [BRANCH_2, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO accounting_period (id, "tenantId", "companyId", "startDate", "endDate", status, "updatedAt")
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 'OPEN', now())`,
      [PERIOD, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
       VALUES ($1, $2, $3, 'ASSET.BANK', 'ASSET', '1100', 'Bank', now())`,
      [ACCOUNT_BANK, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
       VALUES ($1, $2, $3, 'EXPENSE.PAYMENT_PROCESSING_FEE', 'EXPENSE', '5100', 'Payment Processing Fee', now())`,
      [ACCOUNT_FEE, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
       VALUES ($1, $2, $3, 'ASSET.PAYMENT_CLEARING', 'ASSET', '1200', 'Payment Clearing', now())`,
      [ACCOUNT_CLEARING, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
       VALUES ($1, $2, $3, 'ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash on Hand', now())`,
      [ACCOUNT_CASH, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [CRED_BRANCH, TENANT, COMPANY, BRANCH],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [CRED_BRANCH_2, TENANT, COMPANY, BRANCH_2],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [CRED_WRONG_COMPANY, TENANT, OTHER_COMPANY, BRANCH],
    );
    await pool.query(
      `INSERT INTO provider_credential
         (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
       VALUES ($1, $2, $3, $4, 'checkout', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
      [CRED_BRANCH_ALT, TENANT, COMPANY, BRANCH],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── fixture helpers ─────────────────────────────────────────────────────
  async function inTransaction<T>(
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const value = await fn(c);
      await c.query('COMMIT');
      return { ok: true, value };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      return { ok: false, error: err as Error };
    } finally {
      c.release();
    }
  }

  interface AttemptOverrides {
    companyId?: string;
    branchId?: string;
    providerCredentialId?: string | null;
    providerKey?: string;
    amountMinor?: number;
    currencyCode?: string;
    currencyExponent?: number;
  }

  /** A provider-backed (ONLINE_GATEWAY), CAPTURED PaymentAttempt -> Payment pair. */
  async function insertProviderPayment(overrides: AttemptOverrides = {}): Promise<string> {
    const attemptId = uid();
    const companyId = overrides.companyId ?? COMPANY;
    const branchId = overrides.branchId ?? BRANCH;
    const credentialId =
      overrides.providerCredentialId === undefined ? CRED_BRANCH : overrides.providerCredentialId;
    const providerKey = overrides.providerKey ?? 'tap';
    const ccaId = uid();
    const customerId = uid();
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Cust', now())`,
      [customerId, TENANT],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [ccaId, TENANT, companyId, customerId],
    );
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "providerKey", "providerCredentialId", "amountMinor", "currencyCode",
          "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'ONLINE_GATEWAY',$6,$7,$8,$9,$10,'CAPTURED',$11, now())`,
      [
        attemptId,
        TENANT,
        companyId,
        branchId,
        ccaId,
        providerKey,
        credentialId,
        overrides.amountMinor ?? 1000,
        overrides.currencyCode ?? 'AED',
        overrides.currencyExponent ?? 2,
        `idem-${attemptId}`,
      ],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment
         (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "providerKey",
          "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'ONLINE_GATEWAY',$6,$7,$8,$9)`,
      [
        paymentId,
        TENANT,
        companyId,
        branchId,
        attemptId,
        providerKey,
        overrides.amountMinor ?? 1000,
        overrides.currencyCode ?? 'AED',
        overrides.currencyExponent ?? 2,
      ],
    );
    return paymentId;
  }

  /** A non-provider-backed (CASH) Payment — never settlement-eligible. */
  async function insertCashPayment(amountMinor = 1000): Promise<string> {
    const attemptId = uid();
    const ccaId = uid();
    const customerId = uid();
    await pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Cust', now())`,
      [customerId, TENANT],
    );
    await pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [ccaId, TENANT, COMPANY, customerId],
    );
    await pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'CASH',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, ccaId, amountMinor, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CASH',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId, amountMinor],
    );
    return paymentId;
  }

  interface BatchOverrides {
    id?: string;
    tenantId?: string;
    companyId?: string;
    branchId?: string;
    providerCredentialId?: string;
    externalSettlementId?: string;
    gross?: number;
    fee?: number;
    net?: number;
    currencyCode?: string;
    currencyExponent?: number;
    state?: string;
  }

  async function insertBatch(overrides: BatchOverrides = {}): Promise<string> {
    const id = overrides.id ?? uid();
    const gross = overrides.gross ?? 1000;
    const fee = overrides.fee ?? 30;
    const net = overrides.net ?? gross - fee;
    await pool.query(
      `INSERT INTO settlement_batch
         (id, "tenantId", "companyId", "branchId", "providerCredentialId", "externalSettlementId",
          "providerSettlementDate", "grossSettlementMinor", "providerFeeMinor", "netBankMinor",
          "currencyCode", "currencyExponent", state)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',$7,$8,$9,$10,$11,$12)`,
      [
        id,
        overrides.tenantId ?? TENANT,
        overrides.companyId ?? COMPANY,
        overrides.branchId ?? BRANCH,
        overrides.providerCredentialId ?? CRED_BRANCH,
        overrides.externalSettlementId ?? `ext-${id}`,
        gross,
        fee,
        net,
        overrides.currencyCode ?? 'AED',
        overrides.currencyExponent ?? 2,
        overrides.state ?? 'DRAFT',
      ],
    );
    return id;
  }

  interface LineOverrides {
    id?: string;
    batchId: string;
    tenantId?: string;
    companyId?: string;
    branchId?: string;
    externalLineId?: string | null;
    amountMinor?: number;
    currencyCode?: string;
    currencyExponent?: number;
    matchedPaymentId?: string | null;
  }

  async function insertLine(o: LineOverrides): Promise<string> {
    const id = o.id ?? uid();
    await pool.query(
      `INSERT INTO settlement_line
         (id, "tenantId", "companyId", "branchId", "batchId", "externalLineId", "amountMinor",
          "currencyCode", "currencyExponent", "matchedPaymentId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        o.tenantId ?? TENANT,
        o.companyId ?? COMPANY,
        o.branchId ?? BRANCH,
        o.batchId,
        o.externalLineId === undefined ? null : o.externalLineId,
        o.amountMinor ?? 1000,
        o.currencyCode ?? 'AED',
        o.currencyExponent ?? 2,
        o.matchedPaymentId === undefined ? null : o.matchedPaymentId,
      ],
    );
    return id;
  }

  interface ApplicationOverrides {
    id?: string;
    batchId: string;
    lineId: string;
    paymentId: string;
    tenantId?: string;
    companyId?: string;
    branchId?: string;
    amountMinor?: number;
    currencyCode?: string;
    currencyExponent?: number;
  }

  async function insertApplication(
    o: ApplicationOverrides,
    client: pg.Pool | pg.PoolClient = pool,
  ): Promise<string> {
    const id = o.id ?? uid();
    await client.query(
      `INSERT INTO settlement_application
         (id, "tenantId", "companyId", "branchId", "batchId", "lineId", "paymentId", "amountMinor",
          "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        o.tenantId ?? TENANT,
        o.companyId ?? COMPANY,
        o.branchId ?? BRANCH,
        o.batchId,
        o.lineId,
        o.paymentId,
        o.amountMinor ?? 1000,
        o.currencyCode ?? 'AED',
        o.currencyExponent ?? 2,
      ],
    );
    return id;
  }

  async function insertJournalEntry(
    c: pg.PoolClient,
    overrides: {
      sourceId: string;
      sourceKind?: string;
      postingDate?: string;
      currencyCode?: string;
    } = { sourceId: '' },
  ): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO journal_entry
         (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
          "sourceKind", "sourceId", "currencyCode", "postingFingerprint")
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7, 'fp')
       RETURNING id`,
      [
        TENANT,
        COMPANY,
        PERIOD,
        overrides.postingDate ?? '2026-06-01',
        overrides.sourceKind ?? 'SETTLEMENT_BATCH',
        overrides.sourceId,
        overrides.currencyCode ?? 'AED',
      ],
    );
    return rows[0]!.id;
  }

  async function insertJournalLine(
    c: pg.PoolClient,
    journalEntryId: string,
    accountId: string,
    debitMinor: number,
    creditMinor: number,
    branchId: string | null = BRANCH,
  ): Promise<void> {
    await c.query(
      `INSERT INTO journal_line
         (id, "tenantId", "companyId", "journalEntryId", "accountId", "branchId", "debitMinor", "creditMinor")
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7)`,
      [TENANT, COMPANY, journalEntryId, accountId, branchId, debitMinor, creditMinor],
    );
  }

  async function sealEntry(c: pg.PoolClient, journalEntryId: string): Promise<void> {
    await c.query(`UPDATE journal_entry SET "sealedAt" = now() WHERE id = $1`, [journalEntryId]);
  }

  /**
   * Builds + seals a fully correct settlement journal for a given batch, in
   * the SAME transaction as the caller. Does NOT itself flip batch.state or
   * attach journalEntryId — the caller combines that into ONE atomic UPDATE
   * together with the DRAFT->FINALIZED transition (see `finalizeInTx`):
   * a batch's own FINALIZED-immutability trigger permits journalEntryId to
   * be set ONLY as part of the single legal DRAFT->FINALIZED transition
   * update, exactly mirroring `fn_enforce_journal_entry_seal_transition`'s
   * "the one legal transition" pattern — a SEPARATE, later UPDATE (with
   * OLD.state already FINALIZED) is correctly rejected.
   */
  async function postCorrectSettlementJournal(
    c: pg.PoolClient,
    batchId: string,
    gross: number,
    fee: number,
    net: number,
  ): Promise<string> {
    const je = await insertJournalEntry(c, { sourceId: batchId });
    if (net > 0) await insertJournalLine(c, je, ACCOUNT_BANK, net, 0);
    if (fee > 0) await insertJournalLine(c, je, ACCOUNT_FEE, fee, 0);
    await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, gross);
    await sealEntry(c, je);
    return je;
  }

  /** A valid DRAFT batch (1 matched line, 1 eligible payment) ready to finalize. */
  async function buildFinalizableBatch(
    gross = 1000,
    fee = 30,
  ): Promise<{ batchId: string; lineId: string; paymentId: string }> {
    const paymentId = await insertProviderPayment({ amountMinor: gross });
    const batchId = await insertBatch({ gross, fee, net: gross - fee });
    const lineId = await insertLine({ batchId, amountMinor: gross, matchedPaymentId: paymentId });
    return { batchId, lineId, paymentId };
  }

  async function getBatchVersion(batchId: string): Promise<number> {
    const { rows } = await pool.query<{ version: number }>(
      `SELECT version FROM settlement_batch WHERE id = $1`,
      [batchId],
    );
    return rows[0]!.version;
  }

  /**
   * The one legal DRAFT->FINALIZED transition: sets state/journalEntryId/
   * finalizedAt/version together, gated on (id, state='DRAFT',
   * version=expectedVersion) — the repo's actual optimistic-concurrency
   * predicate shape (matches AccountingPeriod/ProviderCredential's own
   * `WHERE id=... AND version=...` convention). Returns the updated row via
   * RETURNING so a stale-version no-match (0 rows) is distinguishable from a
   * thrown exception.
   */
  async function atomicFinalize(
    c: pg.PoolClient,
    batchId: string,
    journalEntryId: string,
    expectedVersion: number,
  ): Promise<{ rowCount: number }> {
    const res = await c.query(
      `UPDATE settlement_batch
         SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1
       WHERE id = $1 AND state = 'DRAFT' AND version = $3
       RETURNING id`,
      [batchId, journalEntryId, expectedVersion],
    );
    return { rowCount: res.rowCount ?? 0 };
  }

  /** Creates a fresh single-line DRAFT batch for an EXISTING payment and fully finalizes it in one transaction. */
  async function createAndFinalizeBatchForPayment(
    paymentId: string,
    amountMinor: number,
  ): Promise<{ ok: boolean; batchId: string }> {
    const batchId = await insertBatch({ gross: amountMinor, fee: 0, net: amountMinor });
    const lineId = await insertLine({ batchId, amountMinor, matchedPaymentId: paymentId });
    const r = await inTransaction(async (c) => {
      await insertApplication({ batchId, lineId, paymentId, amountMinor }, c);
      const je = await postCorrectSettlementJournal(c, batchId, amountMinor, 0, amountMinor);
      return atomicFinalize(c, batchId, je, 1);
    });
    return { ok: r.ok, batchId };
  }

  async function finalizeInTx(
    batchId: string,
    lineId: string,
    paymentId: string,
    gross: number,
    fee: number,
    net: number,
    expectedVersion = 1,
  ): Promise<{ ok: true; value: { rowCount: number } } | { ok: false; error: Error }> {
    return inTransaction(async (c) => {
      await insertApplication({ batchId, lineId, paymentId, amountMinor: gross }, c);
      const je = await postCorrectSettlementJournal(c, batchId, gross, fee, net);
      // ONE atomic UPDATE combines the DRAFT->FINALIZED transition with
      // attaching journalEntryId/finalizedAt/version — see
      // postCorrectSettlementJournal's doc comment for why these must not be
      // two separate UPDATEs.
      return atomicFinalize(c, batchId, je, expectedVersion);
    });
  }

  // ═══════════════════════ structural / hard-gate tests ══════════════════════
  describe('settlement_batch structural + hard gates', () => {
    it('a valid DRAFT batch inserts cleanly', async () => {
      const id = await insertBatch();
      const { rows } = await pool.query(
        `SELECT state, version FROM settlement_batch WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ state: 'DRAFT', version: 1 });
    });

    it('gross must be positive', async () => {
      await expect(insertBatch({ gross: 0, fee: 0, net: 0 })).rejects.toThrow(
        /settlement_batch_gross_positive_chk/,
      );
    });

    it('gross must equal net + fee', async () => {
      await expect(insertBatch({ gross: 1000, fee: 30, net: 900 })).rejects.toThrow(
        /settlement_batch_gross_eq_net_plus_fee_chk/,
      );
    });

    it('providerFeeMinor must be non-negative', async () => {
      await expect(insertBatch({ gross: 1000, fee: -10, net: 1010 })).rejects.toThrow(
        /settlement_batch_fee_nonneg_chk/,
      );
    });

    it('externalSettlementId must be non-empty', async () => {
      await expect(insertBatch({ externalSettlementId: '  ' })).rejects.toThrow(
        /settlement_batch_external_id_nonempty_chk/,
      );
    });

    it('state is restricted to DRAFT|FINALIZED', async () => {
      await expect(insertBatch({ state: 'BOGUS' })).rejects.toThrow(
        /settlement_batch_state_chk|settlement_batch_finalized_at_state_chk/,
      );
    });

    it('(providerCredentialId, externalSettlementId) is unique', async () => {
      const extId = `dup-${uid()}`;
      await insertBatch({ externalSettlementId: extId, providerCredentialId: CRED_BRANCH });
      await expect(
        insertBatch({ externalSettlementId: extId, providerCredentialId: CRED_BRANCH }),
      ).rejects.toThrow(/settlement_batch_providerCredentialId_externalSettlementId_key/);
      // same externalSettlementId under a DIFFERENT credential is fine
      await expect(
        insertBatch({
          externalSettlementId: extId,
          providerCredentialId: CRED_BRANCH_2,
          branchId: BRANCH_2,
        }),
      ).resolves.toBeTruthy();
    });

    it('a tenant-mismatched providerCredentialId is rejected', async () => {
      await expect(
        insertBatch({ tenantId: OTHER_TENANT, providerCredentialId: CRED_BRANCH }),
      ).rejects.toThrow(/fkey|does not exist|belongs to a different tenant/);
    });

    it('a company-only (non-branch-scoped) providerCredentialId is rejected', async () => {
      const companyOnlyCred = uid();
      await pool.query(
        `INSERT INTO provider_credential
           (id, "tenantId", "companyId", "branchId", provider, mode, "secretCiphertext", "secretNonce", "dekWrapped", "updatedAt")
         VALUES ($1, $2, $3, NULL, 'tap', 'TEST', '\\x00', '\\x00', '\\x00', now())`,
        [companyOnlyCred, TENANT, COMPANY],
      );
      await expect(insertBatch({ providerCredentialId: companyOnlyCred })).rejects.toThrow(
        /must be branch-scoped for settlement/,
      );
    });

    it('a wrong-company providerCredentialId is rejected', async () => {
      await expect(insertBatch({ providerCredentialId: CRED_WRONG_COMPANY })).rejects.toThrow(
        /is scoped to a different company/,
      );
    });

    it('a wrong-branch providerCredentialId is rejected (credential scoped to BRANCH_2, batch says BRANCH)', async () => {
      await expect(
        insertBatch({ branchId: BRANCH, providerCredentialId: CRED_BRANCH_2 }),
      ).rejects.toThrow(/is scoped to a different branch/);
    });
  });

  describe('settlement_line structural + hard gates', () => {
    it('amountMinor must be positive', async () => {
      const batchId = await insertBatch();
      await expect(insertLine({ batchId, amountMinor: 0 })).rejects.toThrow(
        /settlement_line_amount_positive_chk/,
      );
    });

    it('lineKind is restricted to SETTLEMENT', async () => {
      const batchId = await insertBatch();
      const id = uid();
      await expect(
        pool.query(
          `INSERT INTO settlement_line (id, "tenantId", "companyId", "branchId", "batchId", "amountMinor", "currencyCode", "currencyExponent", "lineKind")
           VALUES ($1,$2,$3,$4,$5,$6,'AED',2,'BOGUS')`,
          [id, TENANT, COMPANY, BRANCH, batchId, 100],
        ),
      ).rejects.toThrow(/settlement_line_kind_chk/);
    });

    it('line currency must equal the parent batch currency', async () => {
      const batchId = await insertBatch({ currencyCode: 'AED', currencyExponent: 2 });
      await pool.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('KWD', 3, 'د.ك', 'Kuwaiti Dinar', 'دينار كويتي') ON CONFLICT (code) DO NOTHING`,
      );
      await expect(
        insertLine({ batchId, currencyCode: 'KWD', currencyExponent: 3 }),
      ).rejects.toThrow(/currency does not match batch/);
    });

    it('line scope must equal the parent batch scope', async () => {
      const batchId = await insertBatch({ branchId: BRANCH });
      await expect(insertLine({ batchId, branchId: BRANCH_2 })).rejects.toThrow(
        /scope does not match batch|fkey/,
      );
    });

    it('a line cannot be inserted into an already-FINALIZED batch', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch();
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      await expect(insertLine({ batchId, amountMinor: 500 })).rejects.toThrow(/already FINALIZED/);
    });

    it('same externalLineId in the SAME batch is rejected; in a DIFFERENT batch it succeeds', async () => {
      const batchA = await insertBatch();
      const batchB = await insertBatch();
      const extId = `line-${uid()}`;
      await insertLine({ batchId: batchA, externalLineId: extId });
      await expect(insertLine({ batchId: batchA, externalLineId: extId })).rejects.toThrow(
        /settlement_line_batchId_externalLineId_key/,
      );
      await expect(insertLine({ batchId: batchB, externalLineId: extId })).resolves.toBeTruthy();
    });

    it('multiple NULL externalLineId rows in the same batch never collide', async () => {
      const batchId = await insertBatch();
      await insertLine({ batchId, externalLineId: null });
      await expect(insertLine({ batchId, externalLineId: null })).resolves.toBeTruthy();
    });
  });

  describe('settlement_application integrity + eligibility + capacity', () => {
    it('happy path: a matched line + eligible payment produces a valid application (committed only via a same-tx finalize)', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      const { rows } = await pool.query(
        `SELECT id FROM settlement_application WHERE "batchId" = $1`,
        [batchId],
      );
      expect(rows).toHaveLength(1);
    });

    it('lineId is UNIQUE — at most one Application per Line (rejected immediately, inside the same finalize transaction, before commit is ever attempted)', async () => {
      // payment has 2x the line's amount in capacity headroom, so a second
      // Application against the SAME line+payment+amount passes every integrity/
      // capacity check and is rejected ONLY by the lineId UNIQUE constraint —
      // an IMMEDIATE (non-deferred) constraint, so it fires on the second
      // INSERT statement itself, never depending on whether the batch is
      // ever finalized.
      const payment = await insertProviderPayment({ amountMinor: 2000 });
      const batchId = await insertBatch({ gross: 1000, fee: 30, net: 970 });
      const lineId = await insertLine({ batchId, amountMinor: 1000, matchedPaymentId: payment });
      const r = await inTransaction(async (c) => {
        await insertApplication({ batchId, lineId, paymentId: payment, amountMinor: 1000 }, c);
        await insertApplication({ batchId, lineId, paymentId: payment, amountMinor: 1000 }, c);
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/settlement_application_lineId_key/);
    });

    it('an Application in the wrong batch (vs. its Line) is rejected', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const batchA = await insertBatch({ gross: 1000, fee: 0, net: 1000 });
      const batchB = await insertBatch({ gross: 1000, fee: 0, net: 1000 });
      const lineId = await insertLine({
        batchId: batchA,
        amountMinor: 1000,
        matchedPaymentId: payment,
      });
      await expect(
        insertApplication({ batchId: batchB, lineId, paymentId: payment, amountMinor: 1000 }),
      ).rejects.toThrow(/batchId does not match line/);
    });

    it('an unmatched line (matchedPaymentId NULL) cannot receive an Application', async () => {
      const batchId = await insertBatch();
      const lineId = await insertLine({ batchId, matchedPaymentId: null });
      const payment = await insertProviderPayment();
      await expect(insertApplication({ batchId, lineId, paymentId: payment })).rejects.toThrow(
        /has no matchedPaymentId/,
      );
    });

    it('an Application paymentId that disagrees with the Line rejects', async () => {
      const paymentA = await insertProviderPayment({ amountMinor: 1000 });
      const paymentB = await insertProviderPayment({ amountMinor: 1000 });
      const batchId = await insertBatch({ gross: 1000, fee: 0, net: 1000 });
      const lineId = await insertLine({ batchId, amountMinor: 1000, matchedPaymentId: paymentA });
      await expect(
        insertApplication({ batchId, lineId, paymentId: paymentB, amountMinor: 1000 }),
      ).rejects.toThrow(/does not match line .* matchedPaymentId/);
    });

    it('an Application amount that disagrees with the Line rejects', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const batchId = await insertBatch({ gross: 1000, fee: 0, net: 1000 });
      const lineId = await insertLine({ batchId, amountMinor: 1000, matchedPaymentId: payment });
      await expect(
        insertApplication({ batchId, lineId, paymentId: payment, amountMinor: 500 }),
      ).rejects.toThrow(/money does not match line/);
    });

    it('a CASH payment is never settlement-eligible', async () => {
      const payment = await insertCashPayment(1000);
      const batchId = await insertBatch({ gross: 1000, fee: 0, net: 1000 });
      const lineId = await insertLine({ batchId, amountMinor: 1000, matchedPaymentId: payment });
      await expect(
        insertApplication({ batchId, lineId, paymentId: payment, amountMinor: 1000 }),
      ).rejects.toThrow(/is not provider-backed/);
    });

    it('a payment funded under a DIFFERENT credential than the batch is rejected (same providerKey insufficient)', async () => {
      // both CRED_BRANCH_ALT (payment's funding credential) and CRED_BRANCH (batch's
      // credential) are scoped to the SAME branch — only the credential identity differs.
      const payment = await insertProviderPayment({
        providerCredentialId: CRED_BRANCH_ALT,
        providerKey: 'checkout',
      });
      const batchId = await insertBatch({
        providerCredentialId: CRED_BRANCH,
        gross: 1000,
        fee: 0,
        net: 1000,
      });
      const lineId = await insertLine({ batchId, amountMinor: 1000, matchedPaymentId: payment });
      await expect(
        insertApplication({ batchId, lineId, paymentId: payment, amountMinor: 1000 }),
      ).rejects.toThrow(/funding providerCredentialId does not match batch/);
    });

    it('settlement over-capacity is rejected; exact remaining capacity succeeds; partial settlement across 2 FINALIZED batches succeeds', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });

      const first = await createAndFinalizeBatchForPayment(payment, 600);
      expect(first.ok).toBe(true);

      // a second, never-finalized batch attempting to settle 500 more
      // (600 already committed + 500 proposed = 1100 > 1000) must reject
      // AT INSERT TIME — capacity counts the already-COMMITTED (and
      // therefore, by the deferred parent-finality gate, necessarily
      // FINALIZED) Application from `first`.
      const batchOver = await insertBatch({ gross: 500, fee: 0, net: 500 });
      const lineOver = await insertLine({
        batchId: batchOver,
        amountMinor: 500,
        matchedPaymentId: payment,
      });
      await expect(
        insertApplication({
          batchId: batchOver,
          lineId: lineOver,
          paymentId: payment,
          amountMinor: 500,
        }),
      ).rejects.toThrow(/settlement consumption would exceed amountMinor/);

      // exactly the remaining 400 succeeds — partial settlement across 2 FINALIZED batches
      const second = await createAndFinalizeBatchForPayment(payment, 400);
      expect(second.ok).toBe(true);
    });
  });

  // ═══════════════════════ FINALIZED completeness (A-O) ══════════════════════
  describe('deferred FINALIZED-completeness constraint trigger', () => {
    it('A. a direct INSERT with state=FINALIZED and no lines/applications/journal cannot commit', async () => {
      const r = await inTransaction(async (c) => {
        const id = uid();
        await c.query(
          `INSERT INTO settlement_batch
             (id, "tenantId", "companyId", "branchId", "providerCredentialId", "externalSettlementId",
              "providerSettlementDate", "grossSettlementMinor", "providerFeeMinor", "netBankMinor",
              "currencyCode", "currencyExponent", state)
           VALUES ($1,$2,$3,$4,$5,$6,'2026-06-01',1000,30,970,'AED',2,'FINALIZED')`,
          [id, TENANT, COMPANY, BRANCH, CRED_BRANCH, `ext-${id}`],
        );
        return id;
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.message).toMatch(
          /unmatched|line count|journalEntryId|SUM\(line|settlement_batch_finalized_at_state_chk/,
        );
      }
    });

    it('B. DRAFT->FINALIZED with zero lines cannot commit', async () => {
      const batchId = await insertBatch();
      const r = await inTransaction(async (c) => {
        await c.query(`UPDATE settlement_batch SET state = 'FINALIZED' WHERE id = $1`, [batchId]);
      });
      expect(r.ok).toBe(false);
    });

    it('C. one Line missing its Application cannot commit', async () => {
      const payment = await insertProviderPayment({ amountMinor: 1000 });
      const batchId = await insertBatch({ gross: 1000, fee: 0, net: 1000 });
      await insertLine({ batchId, amountMinor: 1000, matchedPaymentId: payment });
      const r = await inTransaction(async (c) => {
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/line count .* application count/);
    });

    it('D. journalEntryId NULL at FINALIZE cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/journalEntryId is NULL/);
    });

    it('E. an unrelated journalEntryId (belongs to a different source) cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const unrelatedJe = await insertJournalEntry(c, { sourceId: uid(), sourceKind: 'OTHER' });
        await insertJournalLine(c, unrelatedJe, ACCOUNT_BANK, 970, 0);
        await insertJournalLine(c, unrelatedJe, ACCOUNT_CLEARING, 0, 970);
        await sealEntry(c, unrelatedJe);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, unrelatedJe],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/does not resolve to a JournalEntry/);
    });

    it('F. wrong sourceKind/sourceId on the linked journal cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, {
          sourceId: 'not-the-batch-id',
          sourceKind: 'SETTLEMENT_BATCH',
        });
        await insertJournalLine(c, je, ACCOUNT_BANK, 970, 0);
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 970);
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/does not resolve to a JournalEntry/);
    });

    it('G. wrong postingDate on the linked journal cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId, postingDate: '2026-06-02' });
        await insertJournalLine(c, je, ACCOUNT_BANK, 970, 0);
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 970);
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/postingDate/);
    });

    it('H. wrong currency on the linked journal cannot commit', async () => {
      await pool.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr") VALUES ('USD', 2, '$', 'US Dollar', 'دولار أمريكي') ON CONFLICT (code) DO NOTHING`,
      );
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId, currencyCode: 'USD' });
        await insertJournalLine(c, je, ACCOUNT_BANK, 970, 0);
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 970);
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/currencyCode/);
    });

    it('I. wrong branch dimension on a settlement journal line cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId });
        await insertJournalLine(c, je, ACCOUNT_BANK, 970, 0, BRANCH_2); // wrong branch
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 970, BRANCH);
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/branchId=/);
    });

    it('J. an unrelated fourth account line on the journal cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId });
        await insertJournalLine(c, je, ACCOUNT_BANK, 970, 0);
        await insertJournalLine(c, je, ACCOUNT_FEE, 30, 0);
        await insertJournalLine(c, je, ACCOUNT_CASH, 0, 30); // unrelated 4th account
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 970);
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/other than Bank\/Fee\/Clearing/);
    });

    it('K. Bank debit != net cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId });
        await insertJournalLine(c, je, ACCOUNT_BANK, 900, 0); // should be 970
        await insertJournalLine(c, je, ACCOUNT_FEE, 30, 0);
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 930);
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
    });

    it('L. Fee debit != fee cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId });
        await insertJournalLine(c, je, ACCOUNT_BANK, 970, 0);
        await insertJournalLine(c, je, ACCOUNT_FEE, 20, 0); // should be 30
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 990);
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
    });

    it('M. Clearing credit != gross cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId });
        await insertJournalLine(c, je, ACCOUNT_BANK, 970, 0);
        await insertJournalLine(c, je, ACCOUNT_FEE, 30, 0);
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 0, 900); // should be 1000
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
    });

    it('N. wrong debit/credit direction on a settlement account cannot commit', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId });
        await insertJournalLine(c, je, ACCOUNT_BANK, 0, 970); // credit instead of debit
        await insertJournalLine(c, je, ACCOUNT_FEE, 30, 0);
        await insertJournalLine(c, je, ACCOUNT_CLEARING, 970, 30); // wrong direction too
        await sealEntry(c, je);
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        await c.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "journalEntryId" = $2, "finalizedAt" = now(), version = version + 1 WHERE id = $1 AND state = 'DRAFT' AND version = 1`,
          [batchId, je],
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/wrong debit\/credit direction|exactly_one_side/);
    });

    it('O. a complete valid final shape commits', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      const { rows } = await pool.query(
        `SELECT state, "journalEntryId" FROM settlement_batch WHERE id = $1`,
        [batchId],
      );
      expect(rows[0]!.state).toBe('FINALIZED');
      expect(rows[0]!.journalEntryId).not.toBeNull();
    });
  });

  // ═════ Checkpoint B final correction — Application/Batch two-phase state
  // gate + atomic final transition (mandatory test matrix A-J) ═════════════
  describe('Application/Batch two-phase state gate + atomic final transition', () => {
    it('A. an Application inserted into a DRAFT batch, committed WITHOUT finalizing it, is rejected — no Application survives', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await inTransaction(async (c) => {
        await insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }, c);
        // deliberately never finalize
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/was left DRAFT at commit/);
      const { rows } = await pool.query(
        `SELECT id FROM settlement_application WHERE "batchId" = $1`,
        [batchId],
      );
      expect(rows).toHaveLength(0);
    });

    it('B. an Application inserted while DRAFT, then the correct atomic final transition in the SAME transaction, succeeds', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
    });

    it('C. an Application inserted directly against an already-FINALIZED batch (even reusing its own already-applied line) is rejected immediately, before ever reaching the lineId-unique constraint', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      await expect(
        insertApplication({ batchId, lineId, paymentId, amountMinor: 1000 }),
      ).rejects.toThrow(/is not DRAFT/);
    });

    it('D. two Applications in the SAME finalize transaction against Payment=100 (60+60) — the second is rejected before an over-settled commit can exist', async () => {
      const payment = await insertProviderPayment({ amountMinor: 100 });
      const batchId = await insertBatch({ gross: 120, fee: 0, net: 120 });
      const lineA = await insertLine({ batchId, amountMinor: 60, matchedPaymentId: payment });
      const lineB = await insertLine({ batchId, amountMinor: 60, matchedPaymentId: payment });
      const r = await inTransaction(async (c) => {
        await insertApplication({ batchId, lineId: lineA, paymentId: payment, amountMinor: 60 }, c);
        await insertApplication({ batchId, lineId: lineB, paymentId: payment, amountMinor: 60 }, c);
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/settlement consumption would exceed amountMinor/);
      const { rows } = await pool.query(
        `SELECT id FROM settlement_application WHERE "batchId" = $1`,
        [batchId],
      );
      expect(rows).toHaveLength(0);
    });

    it('E. two concurrent finalize transactions against the SAME Payment=100 (60+60) — exactly one succeeds, no over-settlement, no write skew', async () => {
      const payment = await insertProviderPayment({ amountMinor: 100 });
      const batchA = await insertBatch({ gross: 60, fee: 0, net: 60 });
      const lineA = await insertLine({
        batchId: batchA,
        amountMinor: 60,
        matchedPaymentId: payment,
      });
      const batchB = await insertBatch({ gross: 60, fee: 0, net: 60 });
      const lineB = await insertLine({
        batchId: batchB,
        amountMinor: 60,
        matchedPaymentId: payment,
      });

      const [ra, rb] = await Promise.all([
        inTransaction(async (c) => {
          await insertApplication(
            { batchId: batchA, lineId: lineA, paymentId: payment, amountMinor: 60 },
            c,
          );
          const je = await postCorrectSettlementJournal(c, batchA, 60, 0, 60);
          return atomicFinalize(c, batchA, je, 1);
        }),
        inTransaction(async (c) => {
          await insertApplication(
            { batchId: batchB, lineId: lineB, paymentId: payment, amountMinor: 60 },
            c,
          );
          const je = await postCorrectSettlementJournal(c, batchB, 60, 0, 60);
          return atomicFinalize(c, batchB, je, 1);
        }),
      ]);
      const results = [ra, rb];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
      const { rows } = await pool.query<{ total: number }>(
        `SELECT COALESCE(SUM("amountMinor"), 0)::int AS total FROM settlement_application WHERE "paymentId" = $1`,
        [payment],
      );
      expect(rows[0]!.total).toBeLessThanOrEqual(100);
    });

    it('F. the atomic transition sets state/journalEntryId/finalizedAt/version together in ONE update', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const beforeVersion = await getBatchVersion(batchId);
      expect(beforeVersion).toBe(1);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970, beforeVersion);
      expect(r.ok).toBe(true);
      const { rows } = await pool.query(
        `SELECT state, "journalEntryId", "finalizedAt", version FROM settlement_batch WHERE id = $1`,
        [batchId],
      );
      expect(rows[0]!.state).toBe('FINALIZED');
      expect(rows[0]!.journalEntryId).not.toBeNull();
      expect(rows[0]!.finalizedAt).not.toBeNull();
      expect(rows[0]!.version).toBe(2);
    });

    it('G. a DRAFT batch with finalizedAt populated is rejected (CHECK)', async () => {
      const batchId = await insertBatch();
      await expect(
        pool.query(`UPDATE settlement_batch SET "finalizedAt" = now() WHERE id = $1`, [batchId]),
      ).rejects.toThrow(/settlement_batch_finalized_at_state_chk/);
    });

    it('H. a FINALIZED batch with finalizedAt NULL is rejected (CHECK)', async () => {
      const batchId = await insertBatch();
      await expect(
        pool.query(
          `UPDATE settlement_batch SET state = 'FINALIZED', "finalizedAt" = NULL WHERE id = $1`,
          [batchId],
        ),
      ).rejects.toThrow(/settlement_batch_finalized_at_state_chk/);
    });

    it('I. a stale expectedVersion finalize attempt commits zero financial effects', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970, 99);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/was left DRAFT at commit/);
      const { rows: batchRows } = await pool.query(
        `SELECT state, version FROM settlement_batch WHERE id = $1`,
        [batchId],
      );
      expect(batchRows[0]).toEqual({ state: 'DRAFT', version: 1 });
      const { rows: appRows } = await pool.query(
        `SELECT id FROM settlement_application WHERE "batchId" = $1`,
        [batchId],
      );
      expect(appRows).toHaveLength(0);
      // Checkpoint B has no audit/outbox table of its own (Checkpoint D scope);
      // the Journal is the only other side-effect a stale finalize could leak.
      const { rows: jeRows } = await pool.query(
        `SELECT id FROM journal_entry WHERE "sourceId" = $1`,
        [batchId],
      );
      expect(jeRows).toHaveLength(0);
    });

    it('J. any UPDATE after finalization — including a bare version bump — is rejected by the existing immutability trigger', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      await expect(
        pool.query(`UPDATE settlement_batch SET version = version + 1 WHERE id = $1`, [batchId]),
      ).rejects.toThrow(/is FINALIZED/);
    });
  });

  // ═══════════════════════ zero-leg accounting shape ══════════════════════════
  describe('zero-leg accounting shape (gross = net + fee, conditional line count)', () => {
    it('Case 1: gross=100 net=97 fee=3 -> exactly 3 journal lines', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(100, 3);
      const r = await finalizeInTx(batchId, lineId, paymentId, 100, 3, 97);
      expect(r.ok).toBe(true);
      const { rows } = await pool.query(
        `SELECT "journalEntryId" FROM settlement_batch WHERE id = $1`,
        [batchId],
      );
      const { rows: lines } = await pool.query(
        `SELECT "accountId", "debitMinor", "creditMinor" FROM journal_line WHERE "journalEntryId" = $1`,
        [rows[0]!.journalEntryId],
      );
      expect(lines).toHaveLength(3);
    });

    it('Case 2: gross=100 net=100 fee=0 -> exactly 2 lines, no Fee line', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(100, 0);
      const r = await finalizeInTx(batchId, lineId, paymentId, 100, 0, 100);
      expect(r.ok).toBe(true);
      const { rows } = await pool.query(
        `SELECT "journalEntryId" FROM settlement_batch WHERE id = $1`,
        [batchId],
      );
      const { rows: lines } = await pool.query(
        `SELECT "accountId" FROM journal_line WHERE "journalEntryId" = $1`,
        [rows[0]!.journalEntryId],
      );
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.accountId)).not.toContain(ACCOUNT_FEE);
    });

    it('Case 3: gross=100 net=0 fee=100 -> exactly 2 lines, no Bank line', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(100, 100);
      const r = await finalizeInTx(batchId, lineId, paymentId, 100, 100, 0);
      expect(r.ok).toBe(true);
      const { rows } = await pool.query(
        `SELECT "journalEntryId" FROM settlement_batch WHERE id = $1`,
        [batchId],
      );
      const { rows: lines } = await pool.query(
        `SELECT "accountId" FROM journal_line WHERE "journalEntryId" = $1`,
        [rows[0]!.journalEntryId],
      );
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.accountId)).not.toContain(ACCOUNT_BANK);
    });

    it('a zero-valued synthetic journal line is rejected by the pre-existing accounting invariant', async () => {
      const { batchId } = await buildFinalizableBatch(100, 0);
      const r = await inTransaction(async (c) => {
        const je = await insertJournalEntry(c, { sourceId: batchId });
        await insertJournalLine(c, je, ACCOUNT_BANK, 0, 0); // both sides zero
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/journal_line_exactly_one_side/);
    });
  });

  // ═══════════════════════ immutability ═══════════════════════════════════════
  describe('immutability after FINALIZED', () => {
    it('a FINALIZED batch rejects a change to any identity/financial/linkage field', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      await expect(
        pool.query(`UPDATE settlement_batch SET "grossSettlementMinor" = 2000 WHERE id = $1`, [
          batchId,
        ]),
      ).rejects.toThrow(/is FINALIZED/);
      await expect(
        pool.query(`UPDATE settlement_batch SET "journalEntryId" = NULL WHERE id = $1`, [batchId]),
      ).rejects.toThrow(/is FINALIZED/);
    });

    it('FINALIZED -> DRAFT is rejected (terminal state)', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      await expect(
        pool.query(`UPDATE settlement_batch SET state = 'DRAFT' WHERE id = $1`, [batchId]),
      ).rejects.toThrow(/is FINALIZED/);
    });

    it('a Line under a FINALIZED batch cannot be UPDATEd or DELETEd', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 30);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 30, 970);
      expect(r.ok).toBe(true);
      await expect(
        pool.query(`UPDATE settlement_line SET "amountMinor" = 1 WHERE id = $1`, [lineId]),
      ).rejects.toThrow(/is FINALIZED/);
      await expect(
        pool.query(`DELETE FROM settlement_line WHERE id = $1`, [lineId]),
      ).rejects.toThrow(/is FINALIZED/);
    });

    it('a Line under a DRAFT batch MAY be updated (matching/unmatching)', async () => {
      const batchId = await insertBatch();
      const lineId = await insertLine({ batchId, matchedPaymentId: null });
      const payment = await insertProviderPayment();
      await expect(
        pool.query(`UPDATE settlement_line SET "matchedPaymentId" = $2 WHERE id = $1`, [
          lineId,
          payment,
        ]),
      ).resolves.toBeTruthy();
    });

    it('settlement_application is unconditionally append-only', async () => {
      const { batchId, lineId, paymentId } = await buildFinalizableBatch(1000, 0);
      const r = await finalizeInTx(batchId, lineId, paymentId, 1000, 0, 1000);
      expect(r.ok).toBe(true);
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM settlement_application WHERE "batchId" = $1`,
        [batchId],
      );
      const appId = rows[0]!.id;
      await expect(
        pool.query(`UPDATE settlement_application SET "amountMinor" = 500 WHERE id = $1`, [appId]),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(`DELETE FROM settlement_application WHERE id = $1`, [appId]),
      ).rejects.toThrow(/append-only/);
    });
  });

  // ═══════════════════════ RLS / cross-tenant isolation ═══════════════════════
  describe('RLS', () => {
    async function asTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('SET ROLE flower_app');
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
        return await fn(c);
      } finally {
        await c.query('RESET ROLE').catch(() => {});
        c.release();
      }
    }

    it('settlement_batch/line/application are ENABLE+FORCE RLS with a tenant policy', async () => {
      for (const table of ['settlement_batch', 'settlement_line', 'settlement_application']) {
        const { rows } = await pool.query(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
          [table],
        );
        expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }
    });

    it('a batch is invisible under the wrong tenant GUC via flower_app', async () => {
      const batchId = await insertBatch();
      const visible = await asTenant(TENANT, (c) =>
        c.query(`SELECT id FROM settlement_batch WHERE id = $1`, [batchId]),
      );
      expect(visible.rows).toHaveLength(1);
      const invisible = await asTenant(OTHER_TENANT, (c) =>
        c.query(`SELECT id FROM settlement_batch WHERE id = $1`, [batchId]),
      );
      expect(invisible.rows).toHaveLength(0);
    });
  });

  // ═══════════════════════ EXPENSE.PAYMENT_PROCESSING_FEE reference account ══
  describe('EXPENSE.PAYMENT_PROCESSING_FEE reference account (task 3b.7 Checkpoint B)', () => {
    it('ACCOUNTING_REFERENCE_ACCOUNTS has exactly 16 rows including the new fee account', () => {
      expect(ACCOUNTING_REFERENCE_ACCOUNTS).toHaveLength(16);
      const fee = ACCOUNTING_REFERENCE_ACCOUNTS.find(
        (a) => a.key === 'EXPENSE.PAYMENT_PROCESSING_FEE',
      );
      expect(fee).toEqual({
        key: 'EXPENSE.PAYMENT_PROCESSING_FEE',
        category: 'EXPENSE',
        defaultDisplayCode: '5100',
        defaultDisplayName: 'Payment Processing Fee',
      });
    });

    it('the migration backfills EXPENSE.PAYMENT_PROCESSING_FEE for a pre-existing company, idempotently', async () => {
      const preexistingTenant = uid();
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt") VALUES ($1,'settle-bf','settle-bf','AE','ACTIVE','00000000-0000-7000-8000-000000000002', now())`,
        [preexistingTenant],
      );
      const preexistingCompany = uid();
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "updatedAt") VALUES ($1,$2,'Pre-existing Co','AED', now())`,
        [preexistingCompany, preexistingTenant],
      );
      // re-run the migration's exact backfill statement
      const backfill = `
        ALTER TABLE "account" NO FORCE ROW LEVEL SECURITY;
        INSERT INTO "account" ("id", "tenantId", "companyId", "key", "category", "displayCode", "displayName", "updatedAt")
        SELECT uuidv7(), c."tenantId", c."id", 'EXPENSE.PAYMENT_PROCESSING_FEE', 'EXPENSE', '5100', 'Payment Processing Fee', now()
          FROM "company" c WHERE c."id" = '${preexistingCompany}'
        ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING;
        ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
      `;
      await pool.query(backfill);
      const first = await pool.query(
        `SELECT key, category, "displayCode", "displayName" FROM account WHERE "companyId" = $1 AND key = 'EXPENSE.PAYMENT_PROCESSING_FEE'`,
        [preexistingCompany],
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]).toEqual({
        key: 'EXPENSE.PAYMENT_PROCESSING_FEE',
        category: 'EXPENSE',
        displayCode: '5100',
        displayName: 'Payment Processing Fee',
      });
      // second run — no duplicate
      await pool.query(backfill);
      const second = await pool.query(
        `SELECT key FROM account WHERE "companyId" = $1 AND key = 'EXPENSE.PAYMENT_PROCESSING_FEE'`,
        [preexistingCompany],
      );
      expect(second.rows).toHaveLength(1);
    });
  });

  // ═══════════════════════ CustomerAdvance existing lock precedent (item 23) ══
  describe('CustomerAdvance existing capacity lock (verify-only, no modification)', () => {
    it('fn_lock_and_validate_advance_capacity already exists and locks customer_advance FOR UPDATE', async () => {
      const { rows } = await pool.query(
        `SELECT prosrc FROM pg_proc WHERE proname = 'fn_lock_and_validate_advance_capacity'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.prosrc).toMatch(/FOR UPDATE/);
    });
  });
});
