import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.1 (CoA + Posting Engine + Accounting Periods) — the sealed-journal DB
 * backstop, proven against real Postgres via raw SQL (a "bad-faith caller"
 * bypassing the future Posting Engine service entirely). Proves the exact A-L
 * proof table from the Task 3b.1 read-only scope review: an unbalanced,
 * under-lined, unsealed, or post-commit-mutated journal is a DB-level
 * impossibility, not merely an application/service convention.
 *
 * Uses the plain Testcontainers superuser connection (bypasses RLS as the
 * table owner, exactly like `migration.test.ts`'s own fixture seeding) — RLS
 * itself is verified separately below; this file's focus is the sealed-journal
 * trigger set, exercised with raw SQL so the triggers alone (not any
 * application-layer discipline) are what's under test.
 */
const TENANT = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const COMPANY = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
const PERIOD = 'a0a0a0a0-a0a0-7a0a-8a0a-a0a0a0a0a0a0';
const ACCOUNT_CASH = 'b0b0b0b0-b0b0-7b0b-8b0b-b0b0b0b0b0b0';
const ACCOUNT_SALES = 'c0c0c0c0-c0c0-7c0c-8c0c-c0c0c0c0c0c0';

describe('packages/db — Task 3b.1 sealed-journal DB backstop', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let seq = 0;
  const nextSource = (): string => `TEST_SOURCE_${++seq}`;

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
       VALUES ($1, 'acct-3b1', 'acct-3b1', 'AE', 'ACTIVE',
               '00000000-0000-7000-8000-000000000002', now())`,
      [TENANT],
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
      `INSERT INTO accounting_period (id, "tenantId", "companyId", "startDate", "endDate", status, "updatedAt")
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 'OPEN', now())`,
      [PERIOD, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
       VALUES ($1, $2, $3, 'ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash on Hand', now())`,
      [ACCOUNT_CASH, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
       VALUES ($1, $2, $3, 'REVENUE.SALES', 'REVENUE', '4000', 'Sales Revenue', now())`,
      [ACCOUNT_SALES, TENANT, COMPANY],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  /** Runs `fn` inside one transaction on a dedicated client; resolves the
   *  client's outcome (committed id, or the rejection) without leaking the
   *  connection back to the pool in a half-open transaction state. */
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

  async function insertUnsealedEntry(c: pg.PoolClient, sourceId: string): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO journal_entry
         (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
          "sourceKind", "sourceId", "currencyCode", "postingFingerprint")
       VALUES (uuidv7(), $1, $2, $3, '2026-06-01', 'TEST', $4, 'AED', 'fp')
       RETURNING id`,
      [TENANT, COMPANY, PERIOD, sourceId],
    );
    return rows[0]!.id;
  }

  async function insertLine(
    c: pg.PoolClient,
    journalEntryId: string,
    accountId: string,
    debitMinor: number,
    creditMinor: number,
  ): Promise<void> {
    await c.query(
      `INSERT INTO journal_line
         (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6)`,
      [TENANT, COMPANY, journalEntryId, accountId, debitMinor, creditMinor],
    );
  }

  async function sealEntry(c: pg.PoolClient, journalEntryId: string): Promise<void> {
    await c.query(`UPDATE journal_entry SET "sealedAt" = now() WHERE id = $1`, [journalEntryId]);
  }

  // ── A ────────────────────────────────────────────────────────────────────
  it('A. a zero-line journal cannot commit', async () => {
    const result = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await sealEntry(c, id);
      return id;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/at least 2 lines/i);
  });

  // ── B ────────────────────────────────────────────────────────────────────
  it('B. a one-line journal cannot commit', async () => {
    const result = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await sealEntry(c, id);
      return id;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/at least 2 lines/i);
  });

  // ── C ────────────────────────────────────────────────────────────────────
  it('C. 2+ unbalanced lines cannot commit', async () => {
    const result = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 60);
      await sealEntry(c, id);
      return id;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/unbalanced/i);
  });

  // ── D ────────────────────────────────────────────────────────────────────
  it('D. a zero-value line is rejected at INSERT by the per-line CHECK (defense-in-depth for the entry-level total>0 backstop)', async () => {
    const result = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 0, 0);
      return id;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/journal_line_exactly_one_side/i);
  });

  // ── E ────────────────────────────────────────────────────────────────────
  it('E. balanced, non-zero 2+ lines + seal commits successfully', async () => {
    const result = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      await sealEntry(c, id);
      return id;
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { rows } = await pool.query(`SELECT "sealedAt" FROM journal_entry WHERE id = $1`, [
        result.value,
      ]);
      expect(rows[0]?.sealedAt).not.toBeNull();
    }
  });

  // ── F ────────────────────────────────────────────────────────────────────
  it('F. an unsealed journal left at transaction end cannot commit, even though every immediate check passed', async () => {
    const result = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      // deliberately never seal
      return id;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/left unsealed at commit/i);
  });

  // ── G ────────────────────────────────────────────────────────────────────
  it('G. inserting a line into an already-committed sealed journal, in a NEW transaction, is rejected', async () => {
    const committed = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      await sealEntry(c, id);
      return id;
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const result = await inTransaction(async (c) => {
      await insertLine(c, committed.value, ACCOUNT_CASH, 5, 0);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/already sealed/i);
  });

  // ── H ────────────────────────────────────────────────────────────────────
  it('H. UPDATE on an existing posted line is rejected', async () => {
    const committed = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      await sealEntry(c, id);
      return id;
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const result = await inTransaction(async (c) => {
      await c.query(`UPDATE journal_line SET "debitMinor" = 999 WHERE "journalEntryId" = $1`, [
        committed.value,
      ]);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/append-only.*UPDATE/is);
  });

  // ── I ────────────────────────────────────────────────────────────────────
  it('I. DELETE on an existing posted line is rejected', async () => {
    const committed = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      await sealEntry(c, id);
      return id;
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const result = await inTransaction(async (c) => {
      await c.query(`DELETE FROM journal_line WHERE "journalEntryId" = $1`, [committed.value]);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/append-only.*DELETE/is);
  });

  // ── J ────────────────────────────────────────────────────────────────────
  it('J. UPDATE on an already-sealed journal_entry (any further change) is rejected', async () => {
    const committed = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      await sealEntry(c, id);
      return id;
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const result = await inTransaction(async (c) => {
      await c.query(`UPDATE journal_entry SET description = 'tampered' WHERE id = $1`, [
        committed.value,
      ]);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/append-only/i);
  });

  // ── K ────────────────────────────────────────────────────────────────────
  it('K. DELETE on a journal_entry (sealed or not) is rejected', async () => {
    const committed = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      await sealEntry(c, id);
      return id;
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const result = await inTransaction(async (c) => {
      await c.query(`DELETE FROM journal_entry WHERE id = $1`, [committed.value]);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/append-only.*DELETE/is);
  });

  // ── L ────────────────────────────────────────────────────────────────────
  it('L. a full reversal — a new, independently-sealed journal referencing the original — commits fine', async () => {
    const original = await inTransaction(async (c) => {
      const id = await insertUnsealedEntry(c, nextSource());
      await insertLine(c, id, ACCOUNT_CASH, 100, 0);
      await insertLine(c, id, ACCOUNT_SALES, 0, 100);
      await sealEntry(c, id);
      return id;
    });
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const reversal = await inTransaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO journal_entry
           (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
            "sourceKind", "sourceId", "currencyCode", "postingFingerprint",
            "reversalOfJournalEntryId")
         VALUES (uuidv7(), $1, $2, $3, '2026-06-02', 'TEST_REVERSAL', $4, 'AED', 'fp-rev', $5)
         RETURNING id`,
        [TENANT, COMPANY, PERIOD, nextSource(), original.value],
      );
      const id = rows[0]!.id;
      // exact opposite debit/credit lines
      await insertLine(c, id, ACCOUNT_CASH, 0, 100);
      await insertLine(c, id, ACCOUNT_SALES, 100, 0);
      await sealEntry(c, id);
      return id;
    });
    expect(reversal.ok).toBe(true);

    // a second reversal of the SAME original is rejected (nullable-unique)
    const secondReversal = await inTransaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO journal_entry
           (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
            "sourceKind", "sourceId", "currencyCode", "postingFingerprint",
            "reversalOfJournalEntryId")
         VALUES (uuidv7(), $1, $2, $3, '2026-06-03', 'TEST_REVERSAL', $4, 'AED', 'fp-rev2', $5)
         RETURNING id`,
        [TENANT, COMPANY, PERIOD, nextSource(), original.value],
      );
      const id = rows[0]!.id;
      await insertLine(c, id, ACCOUNT_CASH, 0, 100);
      await insertLine(c, id, ACCOUNT_SALES, 100, 0);
      await sealEntry(c, id);
      return id;
    });
    expect(secondReversal.ok).toBe(false);
    if (!secondReversal.ok) {
      expect(secondReversal.error.message).toMatch(
        /journal_entry_reversalOfJournalEntryId_key|duplicate key/i,
      );
    }
  });

  // ── supporting structural proofs (Task 3b.1 review §5/§6/§E/§F/§G) ────────
  describe('structural integrity + exclusion constraint', () => {
    it('the accounting_period non-overlap exclusion constraint rejects an overlapping period for the same company', async () => {
      await expect(
        pool.query(
          `INSERT INTO accounting_period (id, "tenantId", "companyId", "startDate", "endDate", "updatedAt")
           VALUES (uuidv7(), $1, $2, '2026-06-01', '2026-06-30', now())`,
          [TENANT, COMPANY],
        ),
      ).rejects.toThrow(/accounting_period_no_overlap|exclusion/i);
    });

    it('a journal_line cannot reference an account from a different company (composite FK)', async () => {
      const otherCompany = 'd0d0d0d0-d0d0-7d0d-8d0d-d0d0d0d0d0d0';
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, 'Other Co', 'AED', 'Asia/Dubai', now()) ON CONFLICT (id) DO NOTHING`,
        [otherCompany, TENANT],
      );
      const otherAccount = 'e1e1e1e1-e1e1-7e1e-8e1e-e1e1e1e1e1e1';
      await pool.query(
        `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
         VALUES ($1, $2, $3, 'ASSET.BANK', 'ASSET', '1100', 'Bank', now()) ON CONFLICT (id) DO NOTHING`,
        [otherAccount, TENANT, otherCompany],
      );
      const result = await inTransaction(async (c) => {
        const id = await insertUnsealedEntry(c, nextSource());
        await insertLine(c, id, otherAccount, 100, 0); // wrong company
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(
          /journal_line_account_tenant_company_fkey|violates foreign key/i,
        );
      }
    });

    it('RLS: account / accounting_period / journal_entry / journal_line all have ENABLE + FORCE + a tenant-isolation policy', async () => {
      const { rows } = await pool.query<{
        relname: string;
        rls: boolean;
        force: boolean;
        policies: number;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.relname = ANY($1)`,
        [['account', 'accounting_period', 'journal_entry', 'journal_line']],
      );
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        expect(r.rls, `${r.relname}: RLS not enabled`).toBe(true);
        expect(r.force, `${r.relname}: RLS not FORCEd`).toBe(true);
        expect(Number(r.policies), `${r.relname}: no policy`).toBeGreaterThanOrEqual(1);
      }
    });

    it('btree_gist is installed', async () => {
      const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
      expect(ext.rowCount).toBe(1);
    });

    it('a journal_line cannot reference a journal_entry from a different company (composite FK)', async () => {
      const otherCompany = 'd0d0d0d0-d0d0-7d0d-8d0d-d0d0d0d0d0d0';
      const otherPeriod = 'a1a1a1a1-a1a1-7a1a-8a1a-a1a1a1a1a1a1';
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, 'Other Co', 'AED', 'Asia/Dubai', now()) ON CONFLICT (id) DO NOTHING`,
        [otherCompany, TENANT],
      );
      await pool.query(
        `INSERT INTO accounting_period (id, "tenantId", "companyId", "startDate", "endDate", status, "updatedAt")
         VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 'OPEN', now()) ON CONFLICT (id) DO NOTHING`,
        [otherPeriod, TENANT, otherCompany],
      );
      const otherAccountCash = 'e2e2e2e2-e2e2-7e2e-8e2e-e2e2e2e2e2e2';
      await pool.query(
        `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
         VALUES ($1, $2, $3, 'ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash on Hand', now())
         ON CONFLICT (id) DO NOTHING`,
        [otherAccountCash, TENANT, otherCompany],
      );
      // The parent entry must still be UNSEALED when the bad cross-company
      // line insert is attempted, in the SAME transaction — otherwise the
      // seal-append-only guard (trigger 4) would reject the insert first,
      // masking the composite-FK check this test specifically targets.
      const result = await inTransaction(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO journal_entry
             (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
              "sourceKind", "sourceId", "currencyCode", "postingFingerprint")
           VALUES (uuidv7(), $1, $2, $3, '2026-06-01', 'TEST', $4, 'AED', 'fp-other')
           RETURNING id`,
          [TENANT, otherCompany, otherPeriod, nextSource()],
        );
        const otherEntryId = rows[0]!.id;
        // a line claiming COMPANY's tenant/company but the OTHER company's
        // (still-unsealed) journalEntryId
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, 100, 0)`,
          [TENANT, COMPANY, otherEntryId, ACCOUNT_CASH],
        );
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(
          /journal_line_journal_entry_tenant_company_fkey|violates foreign key/i,
        );
      }
    });

    it("a reversal's reversalOfJournalEntryId cannot reference an entry from a different company (composite FK)", async () => {
      const otherCompany = 'd0d0d0d0-d0d0-7d0d-8d0d-d0d0d0d0d0d0'; // same as above test, already provisioned
      const otherPeriod = 'a1a1a1a1-a1a1-7a1a-8a1a-a1a1a1a1a1a1';
      const otherAccountCash = 'e2e2e2e2-e2e2-7e2e-8e2e-e2e2e2e2e2e2'; // provisioned above
      const otherEntry = await inTransaction(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO journal_entry
             (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
              "sourceKind", "sourceId", "currencyCode", "postingFingerprint")
           VALUES (uuidv7(), $1, $2, $3, '2026-06-01', 'TEST', $4, 'AED', 'fp-other-2')
           RETURNING id`,
          [TENANT, otherCompany, otherPeriod, nextSource()],
        );
        const id = rows[0]!.id;
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, 50, 0)`,
          [TENANT, otherCompany, id, otherAccountCash],
        );
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, 0, 50)`,
          [TENANT, otherCompany, id, otherAccountCash],
        );
        await sealEntry(c, id);
        return id;
      });
      expect(otherEntry.ok).toBe(true);
      if (!otherEntry.ok) return;
      const otherEntryId = otherEntry.value;
      await expect(
        pool.query(
          `INSERT INTO journal_entry
             (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
              "sourceKind", "sourceId", "currencyCode", "postingFingerprint",
              "reversalOfJournalEntryId")
           VALUES (uuidv7(), $1, $2, $3, '2026-06-02', 'TEST_REVERSAL', $4, 'AED', 'fp-rev-x', $5)`,
          [TENANT, COMPANY, PERIOD, nextSource(), otherEntryId],
        ),
      ).rejects.toThrow(/journal_entry_reversal_tenant_company_fkey|violates foreign key/i);
    });

    it('a journal_entry cannot reference itself as its own reversal (CHECK, self-reference blocked)', async () => {
      const selfId = 'f0f0f0f0-f0f0-7f0f-8f0f-f0f0f0f0f0f0';
      await expect(
        pool.query(
          `INSERT INTO journal_entry
             (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
              "sourceKind", "sourceId", "currencyCode", "postingFingerprint",
              "reversalOfJournalEntryId")
           VALUES ($1, $2, $3, $4, '2026-06-01', 'TEST_SELF', $5, 'AED', 'fp-self', $1)`,
          [selfId, TENANT, COMPANY, PERIOD, nextSource()],
        ),
      ).rejects.toThrow(/journal_entry_no_self_reversal|violates check constraint/i);
    });

    it("a journal_line's branchId must belong to the same tenant+company (composite FK)", async () => {
      const wrongCompany = 'd0d0d0d0-d0d0-7d0d-8d0d-d0d0d0d0d0d0'; // provisioned above
      const wrongBranch = 'b1b1b1b1-b1b1-7b1b-8b1b-b1b1b1b1b1b1';
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
         VALUES ($1, $2, $3, 'Wrong Branch', now()) ON CONFLICT (id) DO NOTHING`,
        [wrongBranch, TENANT, wrongCompany],
      );
      const result = await inTransaction(async (c) => {
        const id = await insertUnsealedEntry(c, nextSource());
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "branchId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, $5, 100, 0)`,
          [TENANT, COMPANY, id, ACCOUNT_CASH, wrongBranch],
        );
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(
          /journal_line_branch_tenant_company_fkey|violates foreign key/i,
        );
      }
    });

    it("a journal_line's posTerminalId must belong to the same tenant+company+branch (composite FK) — POS is attribution, not GL isolation", async () => {
      const branch = 'b2b2b2b2-b2b2-7b2b-8b2b-b2b2b2b2b2b2';
      const otherBranch = 'b3b3b3b3-b3b3-7b3b-8b3b-b3b3b3b3b3b3';
      const posOnOtherBranch = 'c1c1c1c1-c1c1-7c1c-8c1c-c1c1c1c1c1c1';
      await pool.query(
        `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt")
         VALUES ($1, $2, $3, 'Branch A', now()), ($4, $2, $3, 'Branch B', now())
         ON CONFLICT (id) DO NOTHING`,
        [branch, TENANT, COMPANY, otherBranch],
      );
      await pool.query(
        `INSERT INTO pos_terminal (id, "tenantId", "companyId", "branchId", code, name, "updatedAt")
         VALUES ($1, $2, $3, $4, 'POS-OTHER-BRANCH', 'POS Other Branch', now())
         ON CONFLICT (id) DO NOTHING`,
        [posOnOtherBranch, TENANT, COMPANY, otherBranch],
      );
      // valid branch, but the POS terminal actually belongs to a DIFFERENT branch
      const result = await inTransaction(async (c) => {
        const id = await insertUnsealedEntry(c, nextSource());
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "branchId", "posTerminalId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, 100, 0)`,
          [TENANT, COMPANY, id, ACCOUNT_CASH, branch, posOnOtherBranch],
        );
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(
          /journal_line_pos_tenant_company_branch_fkey|violates foreign key/i,
        );
      }
    });

    it('a journal_line cannot carry a posTerminalId without a branchId (CHECK)', async () => {
      const branch = 'b2b2b2b2-b2b2-7b2b-8b2b-b2b2b2b2b2b2'; // provisioned above
      const pos = 'c2c2c2c2-c2c2-7c2c-8c2c-c2c2c2c2c2c2';
      await pool.query(
        `INSERT INTO pos_terminal (id, "tenantId", "companyId", "branchId", code, name, "updatedAt")
         VALUES ($1, $2, $3, $4, 'POS-VALID', 'POS Valid', now()) ON CONFLICT (id) DO NOTHING`,
        [pos, TENANT, COMPANY, branch],
      );
      const result = await inTransaction(async (c) => {
        const id = await insertUnsealedEntry(c, nextSource());
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "posTerminalId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, $5, 100, 0)`,
          [TENANT, COMPANY, id, ACCOUNT_CASH, pos],
        );
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(
          /journal_line_pos_requires_branch|violates check constraint/i,
        );
      }
    });

    it('BigInt exactness — a debitMinor value too large for a JS number round-trips losslessly', async () => {
      const large = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2 — would lose precision as a JS number
      const result = await inTransaction(async (c) => {
        const id = await insertUnsealedEntry(c, nextSource());
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, $5, 0)`,
          [TENANT, COMPANY, id, ACCOUNT_CASH, large.toString()],
        );
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, 0, $5)`,
          [TENANT, COMPANY, id, ACCOUNT_SALES, large.toString()],
        );
        await sealEntry(c, id);
        return id;
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { rows } = await pool.query<{ debitMinor: string }>(
        `SELECT "debitMinor" FROM journal_line WHERE "journalEntryId" = $1 AND "debitMinor" > 0`,
        [result.value],
      );
      expect(BigInt(rows[0]!.debitMinor)).toBe(large);
    });

    it('3-decimal currency (KWD) minor units are stored and read back exactly, with no rounding', async () => {
      await pool.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('KWD', 3, 'د.ك', 'Kuwaiti Dinar', 'دينار كويتي') ON CONFLICT (code) DO NOTHING`,
      );
      const kwdCompany = 'd2d2d2d2-d2d2-7d2d-8d2d-d2d2d2d2d2d2';
      const kwdPeriod = 'a2a2a2a2-a2a2-7a2a-8a2a-a2a2a2a2a2a2';
      const kwdCash = 'b4b4b4b4-b4b4-7b4b-8b4b-b4b4b4b4b4b4';
      const kwdSales = 'b5b5b5b5-b5b5-7b5b-8b5b-b5b5b5b5b5b5';
      await pool.query(
        `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
         VALUES ($1, $2, 'KWD Co', 'KWD', 'Asia/Kuwait', now()) ON CONFLICT (id) DO NOTHING`,
        [kwdCompany, TENANT],
      );
      await pool.query(
        `INSERT INTO accounting_period (id, "tenantId", "companyId", "startDate", "endDate", status, "updatedAt")
         VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 'OPEN', now()) ON CONFLICT (id) DO NOTHING`,
        [kwdPeriod, TENANT, kwdCompany],
      );
      await pool.query(
        `INSERT INTO account (id, "tenantId", "companyId", key, category, "displayCode", "displayName", "updatedAt")
         VALUES ($1, $2, $3, 'ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash on Hand', now()),
                ($4, $2, $3, 'REVENUE.SALES', 'REVENUE', '4000', 'Sales Revenue', now())
         ON CONFLICT (id) DO NOTHING`,
        [kwdCash, TENANT, kwdCompany, kwdSales],
      );
      // 1.234 KWD = 1234 fils (3-decimal minor units)
      const result = await inTransaction(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO journal_entry
             (id, "tenantId", "companyId", "accountingPeriodId", "postingDate",
              "sourceKind", "sourceId", "currencyCode", "postingFingerprint")
           VALUES (uuidv7(), $1, $2, $3, '2026-06-01', 'TEST_KWD', $4, 'KWD', 'fp-kwd')
           RETURNING id`,
          [TENANT, kwdCompany, kwdPeriod, nextSource()],
        );
        const id = rows[0]!.id;
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, 1234, 0)`,
          [TENANT, kwdCompany, id, kwdCash],
        );
        await c.query(
          `INSERT INTO journal_line
             (id, "tenantId", "companyId", "journalEntryId", "accountId", "debitMinor", "creditMinor")
           VALUES (uuidv7(), $1, $2, $3, $4, 0, 1234)`,
          [TENANT, kwdCompany, id, kwdSales],
        );
        await sealEntry(c, id);
        return id;
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { rows } = await pool.query<{ debitMinor: string; creditMinor: string }>(
        `SELECT "debitMinor", "creditMinor" FROM journal_line WHERE "journalEntryId" = $1`,
        [result.value],
      );
      expect(
        rows.map((r) => BigInt(r.debitMinor) + BigInt(r.creditMinor)).every((n) => n === 1234n),
      ).toBe(true);
    });
  });

  describe('sealed-journal trigger edge cases (Task 3b.1 review §3/§B)', () => {
    it('a seal-transition UPDATE that ALSO changes another column is rejected (only sealedAt may change)', async () => {
      const result = await inTransaction(async (c) => {
        const id = await insertUnsealedEntry(c, nextSource());
        await insertLine(c, id, ACCOUNT_CASH, 100, 0);
        await insertLine(c, id, ACCOUNT_SALES, 0, 100);
        // attempt to seal AND smuggle a description change in the same UPDATE
        await c.query(
          `UPDATE journal_entry SET "sealedAt" = now(), description = 'smuggled' WHERE id = $1`,
          [id],
        );
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/append-only|unsealed -> sealed|not permitted/i);
      }
    });

    it('the deferred balance/seal check re-reads the CURRENT row at commit time, not the stale INSERT-time NEW snapshot', async () => {
      // If the trigger incorrectly trusted the INSERT-time NEW.sealedAt (always
      // NULL at insert time, since sealing always happens via a later UPDATE),
      // it would ALWAYS reject every journal — including this genuinely valid
      // one — because NEW.sealedAt-at-insert-time is unconditionally null.
      // Proving this commits confirms the trigger re-selects the row's current
      // state rather than trusting its insert-time argument.
      const result = await inTransaction(async (c) => {
        const id = await insertUnsealedEntry(c, nextSource());
        await insertLine(c, id, ACCOUNT_CASH, 250, 0);
        await insertLine(c, id, ACCOUNT_SALES, 0, 250);
        await sealEntry(c, id); // the ONLY thing that ever makes sealedAt non-null
        return id;
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const { rows } = await pool.query<{ sealedAt: Date }>(
          `SELECT "sealedAt" FROM journal_entry WHERE id = $1`,
          [result.value],
        );
        expect(rows[0]!.sealedAt).not.toBeNull();
      }
    });
  });

  // ── hardening round 2, fix 2 — account.key/category DB-level immutability ──
  describe('account.key / account.category DB-level immutability (hardening review round 2)', () => {
    it('UPDATE account SET key = ... is rejected', async () => {
      const result = await inTransaction(async (c) => {
        await c.query(`UPDATE account SET "key" = 'ASSET.SOMETHING_ELSE' WHERE id = $1`, [
          ACCOUNT_CASH,
        ]);
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/immutable after creation/i);
      }
    });

    it('UPDATE account SET category = ... is rejected', async () => {
      const result = await inTransaction(async (c) => {
        await c.query(`UPDATE account SET "category" = 'LIABILITY' WHERE id = $1`, [ACCOUNT_CASH]);
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/immutable after creation/i);
      }
    });

    it('UPDATE account SET displayCode = ... (only) succeeds', async () => {
      const result = await inTransaction(async (c) => {
        await c.query(
          `UPDATE account SET "displayCode" = '1001', "updatedAt" = now() WHERE id = $1`,
          [ACCOUNT_CASH],
        );
      });
      expect(result.ok).toBe(true);
      const { rows } = await pool.query<{ displayCode: string; key: string }>(
        `SELECT "displayCode", "key" FROM account WHERE id = $1`,
        [ACCOUNT_CASH],
      );
      expect(rows[0]!.displayCode).toBe('1001');
      expect(rows[0]!.key).toBe('ASSET.CASH_ON_HAND');
      // restore for any later test relying on the original displayCode
      await pool.query(
        `UPDATE account SET "displayCode" = '1000', "updatedAt" = now() WHERE id = $1`,
        [ACCOUNT_CASH],
      );
    });

    it('UPDATE account SET displayName = ... (only) succeeds', async () => {
      const result = await inTransaction(async (c) => {
        await c.query(
          `UPDATE account SET "displayName" = 'Petty Cash', "updatedAt" = now() WHERE id = $1`,
          [ACCOUNT_CASH],
        );
      });
      expect(result.ok).toBe(true);
      const { rows } = await pool.query<{ displayName: string; category: string }>(
        `SELECT "displayName", "category" FROM account WHERE id = $1`,
        [ACCOUNT_CASH],
      );
      expect(rows[0]!.displayName).toBe('Petty Cash');
      expect(rows[0]!.category).toBe('ASSET');
      // restore
      await pool.query(
        `UPDATE account SET "displayName" = 'Cash on Hand', "updatedAt" = now() WHERE id = $1`,
        [ACCOUNT_CASH],
      );
    });

    it('a combined update that re-sends the SAME key/category (unchanged) alongside a display edit succeeds — the trigger checks for an actual value CHANGE, not mere presence in the SET clause', async () => {
      const result = await inTransaction(async (c) => {
        await c.query(
          `UPDATE account
              SET "key" = "key", "category" = "category",
                  "displayCode" = '1000', "displayName" = 'Cash on Hand', "updatedAt" = now()
            WHERE id = $1`,
          [ACCOUNT_CASH],
        );
      });
      expect(result.ok).toBe(true);
    });
  });
});

// ── hardening round 2, fix 1 — country.defaultTimezone production-safe backfill ──
describe('packages/db — Task 3b.1 hardening: country.defaultTimezone migration backfill', () => {
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
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'د.إ', 'UAE Dirham', 'درهم إماراتي') ON CONFLICT (code) DO NOTHING`,
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // The migration's own UPDATE statements, extracted verbatim from
  // `20260917120000_accounting_hardening/migration.sql`, run here against a
  // country table state that mimics production: rows that already exist
  // (however they got there — NOT this migration's concern) with
  // `defaultTimezone` still NULL, exactly the state every pre-3b.1 `country`
  // row is in. This is the correct way to test a data-only migration whose
  // effect depends on rows that a DIFFERENT process is responsible for
  // creating (country reference-data bootstrap is a pre-existing, disclosed,
  // out-of-scope gap — this migration only fixes the timezone COLUMN
  // deterministically for whichever of these six rows already exist).
  async function runBackfill(): Promise<void> {
    await pool.query(
      `UPDATE "country" SET "defaultTimezone" = 'Asia/Dubai'   WHERE "code" = 'AE' AND "defaultTimezone" IS NULL`,
    );
    await pool.query(
      `UPDATE "country" SET "defaultTimezone" = 'Asia/Riyadh'  WHERE "code" = 'SA' AND "defaultTimezone" IS NULL`,
    );
    await pool.query(
      `UPDATE "country" SET "defaultTimezone" = 'Asia/Qatar'   WHERE "code" = 'QA' AND "defaultTimezone" IS NULL`,
    );
    await pool.query(
      `UPDATE "country" SET "defaultTimezone" = 'Asia/Kuwait'  WHERE "code" = 'KW' AND "defaultTimezone" IS NULL`,
    );
    await pool.query(
      `UPDATE "country" SET "defaultTimezone" = 'Asia/Bahrain' WHERE "code" = 'BH' AND "defaultTimezone" IS NULL`,
    );
    await pool.query(
      `UPDATE "country" SET "defaultTimezone" = 'Asia/Muscat'  WHERE "code" = 'OM' AND "defaultTimezone" IS NULL`,
    );
  }

  async function insertCountry(code: string, defaultTimezone: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", active, "defaultTimezone", "updatedAt")
       VALUES ($1, $1, $1, 'gcc', 'AED', 'SAT_SUN', true, $2, now())
       ON CONFLICT (code) DO NOTHING`,
      [code, defaultTimezone],
    );
  }

  it('the six approved GCC rows receive exactly the approved defaultTimezone values', async () => {
    for (const code of ['AE', 'SA', 'QA', 'KW', 'BH', 'OM']) await insertCountry(code, null);
    await runBackfill();

    const expected: Record<string, string> = {
      AE: 'Asia/Dubai',
      SA: 'Asia/Riyadh',
      QA: 'Asia/Qatar',
      KW: 'Asia/Kuwait',
      BH: 'Asia/Bahrain',
      OM: 'Asia/Muscat',
    };
    const { rows } = await pool.query<{ code: string; defaultTimezone: string }>(
      `SELECT code, "defaultTimezone" FROM country WHERE code = ANY($1)`,
      [Object.keys(expected)],
    );
    for (const row of rows) expect(row.defaultTimezone).toBe(expected[row.code]);
    expect(rows).toHaveLength(6);
  });

  it('no unrelated country row is touched by the backfill', async () => {
    await insertCountry('US', null);
    await runBackfill();
    const { rows } = await pool.query<{ defaultTimezone: string | null }>(
      `SELECT "defaultTimezone" FROM country WHERE code = 'US'`,
    );
    expect(rows[0]!.defaultTimezone).toBeNull();
  });

  it('the backfill is idempotent and non-destructive of an already-set value (never overwrites)', async () => {
    // simulate a row that already carries a value from some other path
    // (e.g. a future country-bootstrap process) BEFORE this migration runs —
    // the IS NULL guard must never clobber it.
    await insertCountry('KW', 'Asia/Kuwait'); // no-op if already inserted above with NULL
    await pool.query(`UPDATE country SET "defaultTimezone" = 'Custom/Value' WHERE code = 'KW'`);
    await runBackfill();
    const { rows: first } = await pool.query<{ defaultTimezone: string }>(
      `SELECT "defaultTimezone" FROM country WHERE code = 'KW'`,
    );
    expect(first[0]!.defaultTimezone).toBe('Custom/Value');

    // re-running the backfill again (idempotency) must not error and must not
    // change any of the six approved rows that are already correctly set.
    await runBackfill();
    const { rows: second } = await pool.query<{ code: string; defaultTimezone: string }>(
      `SELECT code, "defaultTimezone" FROM country WHERE code = ANY($1)`,
      [['AE', 'SA', 'QA', 'BH', 'OM']],
    );
    const expected: Record<string, string> = {
      AE: 'Asia/Dubai',
      SA: 'Asia/Riyadh',
      QA: 'Asia/Qatar',
      BH: 'Asia/Bahrain',
      OM: 'Asia/Muscat',
    };
    for (const row of second) expect(row.defaultTimezone).toBe(expected[row.code]);
  });
});
