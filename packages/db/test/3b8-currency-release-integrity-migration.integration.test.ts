import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import {
  addMigration,
  diff,
  makeWorkDir,
  MIGRATIONS_DIR,
  migrationNames,
  migRows,
  prisma,
  removeWorkDirs,
  sha256,
  snapshot,
  type Row,
  type SchemaSnapshot,
} from './helpers/migration-harness.js';
import {
  applicationStmt,
  attempt,
  attemptStmt,
  chargeStmt,
  CRED,
  eventStmt,
  Fixtures,
  fingerprint,
  integrityCases,
  refundStmt,
  reservationStmt,
  S0,
  uid,
  AED,
  type Case,
  type Outcome,
  type Run,
} from './helpers/integrity-fixtures.js';

const CURRENCY_RELEASE = '20261010120000_phase_3b8_currency_and_release_integrity';

/** sha256 of migrations 44 / 45 / 46 / 47 / 48, recorded BEFORE migration 49 was written — all five are
 *  FROZEN: a recorded migration is never edited, so these never change */
const FROZEN_HASHES: Record<string, string> = {
  '20261005120000_phase_3b8_credit_refund_core':
    'f708a91c26886cd81da87c1b38a4c7680f701aa67f264af8bdb69c1d63fc319b',
  '20261006120000_phase_3b8_cancellation_charge_permission':
    'c3c6da7efb324a49730f8b91bb70d86df8282abf95eedf975cdd51fe00d9dceb',
  '20261007120000_phase_3b8_integration_closure':
    'f633235761bbb8065362000075c44e6fbb11ad342ca459cba7a7fc7d81134516',
  '20261008120000_phase_3b8_credit_note_advance_release_provenance':
    '36e843ca4aa45e2ce3c7668e3faa3aeeb5f7ba4d3b743fb907306c6525db618f',
  '20261009120000_phase_3b8_refund_scope_integrity':
    '2ec98886a91bdc29d1baaab0917edeb2b527f2766f07020e9c9d21d1253794e1',
};

/** the ONLY schema objects migration 49 may touch — eight CREATE OR REPLACE bodies, nothing else */
const REPLACED_FUNCTIONS = [
  'fn_check_cancellation_charge_provenance()',
  'fn_check_credit_note_coverage_release_integrity()',
  'fn_check_credit_note_invoice_capacity()',
  'fn_check_credit_note_line_capacity()',
  'fn_check_customer_advance_refund_application_integrity()',
  'fn_check_refund_attempt_reservation_integrity()',
  'fn_check_refund_attempt_scope_and_capacity()',
  'fn_check_refund_scope_and_capacity()',
];
/** how many RAISE EXCEPTION messages each had under migration 48 (the latest definition of each) */
const RAISES_BEFORE: Record<string, number> = {
  'fn_check_refund_scope_and_capacity()': 5,
  'fn_check_refund_attempt_scope_and_capacity()': 6,
  'fn_check_customer_advance_refund_application_integrity()': 7,
  'fn_check_refund_attempt_reservation_integrity()': 9,
  'fn_check_credit_note_coverage_release_integrity()': 29,
  'fn_check_credit_note_invoice_capacity()': 1,
  'fn_check_credit_note_line_capacity()': 11,
  'fn_check_cancellation_charge_provenance()': 3,
};

/** the legacy defect rows the 48 schema ACCEPTED — they must survive the upgrade untouched (a trigger is not
 *  retroactive: no row is validated, rewritten or deleted) */
const LEGACY_DEFECT_KEYS = [
  "DEFECT O-2B same tenant/company/branch, but the advance belongs to ANOTHER customer's account",
  'DEFECT O-1 credit note over an invoice of another currency code',
  'DEFECT O-2A release stamped with a branch-foreign scope over a main-scope credit note and advance',
];

/**
 * Task 3b.8 final hard-gate DB-integrity closure — MIGRATION 49
 * (`20261010120000_phase_3b8_currency_and_release_integrity`) proven as a real UPGRADE.
 *
 * Migration 49 CREATE OR REPLACEs eight integrity functions (currency authority O-1, coverage-release scope and
 * customer attribution O-2) — no table, column, index, constraint, trigger, policy, grant, kind or money field.
 * This suite proves, with the REAL `prisma migrate deploy` against real Postgres:
 *
 *   1. migrations 1..48 are applied first, DATA is seeded under that exact schema (every refund-side and
 *      cancellation-side table, a nested credit-note chain, AND three LEGACY defect rows the 48 schema accepted),
 *      a full-database fingerprint and the schema are captured ("before") and the behaviour matrix is run;
 *   2. migration 49 is applied by a second `migrate deploy` (an UPGRADE of a populated database): exactly ONE
 *      migration is applied; the 48 earlier `_prisma_migrations` rows are bit-for-bit untouched; migrations 44-48
 *      still hash to the values recorded before this pass;
 *   3. the schema diff 48 -> 49 is EXACTLY eight function bodies — no trigger, table, column, index, constraint,
 *      policy, grant, RLS flag or view moves — and every OLD line and RAISE message of each function is still
 *      there, in order (the new checks are inserted, never edited in);
 *   4. every row that existed before — legacy defect rows included — survives byte-for-byte;
 *   5. the SAME cases run before and after: every legitimate frozen flow (CASH / BANK / provider refunds,
 *      reconciliation, nested provenance of every kind) is accepted both times, every pre-existing guard
 *      refuses with the same message, and every defect flips from ACCEPTED (48) to REFUSED (49);
 *   6. a refused case, committed for real, leaves NO trace — the fingerprint of EVERY table (rows, projections,
 *      journals, audit rows) is identical before and after;
 *   7. a SECOND deploy is a no-op and a FRESH database from the same 49 migrations has a schema identical to the
 *      upgraded one.
 */
describe('packages/db — migration 49 (3b.8 currency + release integrity): a real 48 -> 49 upgrade', () => {
  const names = migrationNames();
  const before49 = names.filter((n) => n < CURRENCY_RELEASE);
  const upTo49 = names.filter((n) => n <= CURRENCY_RELEASE);

  let upgradeC: StartedPostgreSqlContainer;
  let freshC: StartedPostgreSqlContainer;
  let upgradeUrl = '';
  let freshUrl = '';
  let pool: pg.Pool;
  let freshPool: pg.Pool;
  let upgradeDir = '';
  let freshDir = '';
  let fx: Fixtures;
  const cases = integrityCases(() => fx);

  let snap48: SchemaSnapshot;
  let snap49: SchemaSnapshot;
  let snapFresh: SchemaSnapshot;
  let migRows48: Row[] = [];
  let migRows49: Row[] = [];
  let migRowsAfterSecond: Row[] = [];
  let data48: Record<string, string> = {};
  let dataAfterUpgrade: Record<string, string> = {};
  let legacyBefore: Record<string, string> = {};
  let legacyAfter: Record<string, string> = {};
  let outcomes48: Record<string, Outcome> = {};
  let outcomes49: Record<string, Outcome> = {};
  let committedDefects: Record<string, Outcome> = {};
  let dataBeforeCommit: Record<string, string> = {};
  let dataAfterCommit: Record<string, string> = {};
  const keysByKind: Record<Case['kind'], string[]> = { LEGIT: [], KEEP: [], DEFECT: [] };
  const caseOf = new Map(cases.map((c) => [c.key, c]));
  let upgradeStdout = '';
  let secondDeployStdout = '';
  let statusStdout = '';

  interface Built {
    key: string;
    run: Run;
    commitable: boolean;
    immediate: boolean;
  }
  async function buildAll(list: Case[]): Promise<Built[]> {
    const built: Built[] = [];
    for (const c of list) {
      built.push({
        key: c.key,
        run: await c.build(),
        commitable: c.immediate !== false,
        immediate: c.immediate ?? true,
      });
    }
    return built;
  }
  async function runAll(built: Built[], commit: boolean): Promise<Record<string, Outcome>> {
    const out: Record<string, Outcome> = {};
    for (const b of built) {
      out[b.key] = await attempt(pool, b.run, commit && b.commitable, b.immediate);
    }
    return out;
  }

  /** a unit of work committed for real (throws when it is refused) */
  async function commitTx(run: Run): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await run(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** REAL historical rows in every refund-side / cancellation-side table, committed under the 48 schema */
  async function seedHistory(): Promise<void> {
    // BANK + CASH refunds with their applications
    for (const [method, amount] of [
      ['BANK_TRANSFER', 250],
      ['CASH', 200],
    ] as const) {
      const adv = await fx.cnAdvance(600);
      await commitTx(async (c) => {
        const refundId = uid();
        await refundStmt(c, refundId, S0, adv.paymentId, amount, method);
        await applicationStmt(c, S0, adv.advanceId, refundId, amount);
      });
    }
    // a nested chain (advance -> invoice -> cancel -> advance), then a refund of the second-generation advance
    const a1 = await fx.cnAdvance(1000);
    const b = await fx.invoiceCoveredBy(a1.advanceId, 1000, 2000);
    const second = await fx.issueCreditNote({
      invoiceId: b.invoiceId,
      lineId: b.lineId,
      total: 2000,
      arReduction: 1000,
      advanceExcess: 1000,
      release: {
        sourceKind: 'ADVANCE_APPLICATION',
        applicationId: b.applicationId,
        paymentId: a1.paymentId,
      },
    });
    await commitTx(async (c) => {
      const refundId = uid();
      await refundStmt(c, refundId, S0, a1.paymentId, 400, 'CASH');
      await applicationStmt(c, S0, second.advanceId!, refundId, 400);
    });
    // a PENDING provider attempt + reservation, a SUCCEEDED conversion, a FAILED attempt
    const pending = await fx.cnAdvance(400);
    await commitTx(async (c) => {
      const attemptId = uid();
      await attemptStmt(c, attemptId, S0, pending.paymentId, CRED, 400);
      await reservationStmt(c, S0, attemptId, pending.releaseId, pending.advanceId, 400);
    });
    const done = await fx.cnAdvance(300);
    const doneAttempt = uid();
    await commitTx(async (c) => {
      await attemptStmt(c, doneAttempt, S0, done.paymentId, CRED, 300);
      await reservationStmt(c, S0, doneAttempt, done.releaseId, done.advanceId, 300);
    });
    await commitTx(async (c) => {
      const refundId = uid();
      await c.query(`SELECT id FROM refund_attempt WHERE id = $1 FOR UPDATE`, [doneAttempt]);
      await refundStmt(c, refundId, S0, done.paymentId, 300, 'ONLINE_GATEWAY', doneAttempt);
      await applicationStmt(c, S0, done.advanceId, refundId, 300);
      await c.query(
        `UPDATE refund_attempt SET state = 'SUCCEEDED', "resultingRefundId" = $2 WHERE id = $1`,
        [doneAttempt, refundId],
      );
    });
    const failed = await fx.cnAdvance(250);
    const failedAttempt = uid();
    await commitTx(async (c) => {
      await attemptStmt(c, failedAttempt, S0, failed.paymentId, CRED, 250);
      await reservationStmt(c, S0, failedAttempt, failed.releaseId, failed.advanceId, 250);
    });
    await pool.query(`UPDATE refund_attempt SET state = 'FAILED' WHERE id = $1`, [failedAttempt]);
    // events in every status, a cancellation charge
    for (const terminal of [null, 'PROCESSED', 'EXCEPTION'] as const) {
      const id = uid();
      await commitTx(async (c) => {
        await eventStmt(c, id, S0, CRED);
      });
      if (terminal) {
        await pool.query(`UPDATE provider_refund_event SET status = $2 WHERE id = $1`, [
          id,
          terminal,
        ]);
      }
    }
    const orderId = await fx.chargeOrder();
    await commitTx(async (c) => {
      await chargeStmt(c, orderId, AED);
    });
  }

  /** LEGACY defect rows: the 48 schema ACCEPTS these (that is the defect); committed, they must survive the
   *  upgrade untouched */
  async function seedLegacyDefects(): Promise<void> {
    for (const key of LEGACY_DEFECT_KEYS) {
      const c = caseOf.get(key);
      if (!c) throw new Error(`unknown legacy case ${key}`);
      const outcome = await attempt(pool, await c.build(), true, c.immediate ?? true);
      if (!outcome.accepted) {
        throw new Error(
          `the 48 schema was expected to ACCEPT the legacy defect "${key}": ${outcome.message}`,
        );
      }
    }
  }

  const legacyFingerprint = async (): Promise<Record<string, string>> => {
    // the three legacy defects, re-read by their defining facts
    const one = async (label: string, sql: string): Promise<[string, string]> => {
      const r = await pool.query<{ h: string }>(
        `SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM (${sql}) x`,
      );
      return [label, r.rows[0]!.h];
    };
    return Object.fromEntries([
      await one(
        'wrong-customer release',
        `SELECT r.* FROM credit_note_coverage_release r
           JOIN customer_advance a ON a.id = r."customerAdvanceId"
           JOIN credit_note cn ON cn.id = r."creditNoteId"
           JOIN invoice i ON i.id = cn."invoiceId"
           JOIN "order" o ON o.id = i."orderId"
           JOIN customer_company_account cca ON cca.id = a."customerCompanyAccountId"
          WHERE cca."customerId" IS DISTINCT FROM o."customerId"`,
      ),
      await one(`USD credit note`, `SELECT * FROM credit_note WHERE "currencyCode" <> 'AED'`),
      await one(
        'foreign-branch release',
        `SELECT r.* FROM credit_note_coverage_release r JOIN credit_note cn ON cn.id = r."creditNoteId"
          WHERE r."branchId" <> cn."branchId"`,
      ),
    ]);
  };

  beforeAll(async () => {
    expect(before49, 'the 48 migrations that precede migration 49').toHaveLength(48);
    expect(names).toContain(CURRENCY_RELEASE);

    [upgradeC, freshC] = await Promise.all([
      new PostgreSqlContainer('postgres:17')
        .withDatabase('flower')
        .withUsername('flower')
        .withPassword('flower_test')
        .start(),
      new PostgreSqlContainer('postgres:17')
        .withDatabase('flower')
        .withUsername('flower')
        .withPassword('flower_test')
        .start(),
    ]);
    upgradeUrl = upgradeC.getConnectionUri();
    freshUrl = freshC.getConnectionUri();
    pool = new pg.Pool({ connectionString: upgradeUrl });
    freshPool = new pg.Pool({ connectionString: freshUrl });
    fx = new Fixtures(pool);

    // ── A: the UPGRADE database — migrations 1..48 first ───────────────────────────────────
    upgradeDir = makeWorkDir('mig48', before49);
    prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    await fx.baseFixture();

    // data created UNDER MIGRATION 48's schema: real committed rows everywhere + three LEGACY defects
    await seedHistory();
    await seedLegacyDefects();
    legacyBefore = await legacyFingerprint();

    // every case's fixtures are committed too, and the behaviour matrix is run against the 48 schema
    const legit = await buildAll(cases.filter((c) => c.kind === 'LEGIT'));
    const keep = await buildAll(cases.filter((c) => c.kind === 'KEEP'));
    const defect = await buildAll(cases.filter((c) => c.kind === 'DEFECT'));
    keysByKind.LEGIT = legit.map((b) => b.key);
    keysByKind.KEEP = keep.map((b) => b.key);
    keysByKind.DEFECT = defect.map((b) => b.key);
    outcomes48 = {
      ...(await runAll(legit, false)),
      ...(await runAll(keep, false)),
      ...(await runAll(defect, false)),
    };
    migRows48 = await migRows(pool);
    snap48 = await snapshot(pool);
    data48 = await fingerprint(pool);

    // ── migration 49 applied on top — a real UPGRADE of the populated DB ─────────────────────
    addMigration(upgradeDir, CURRENCY_RELEASE);
    upgradeStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRows49 = await migRows(pool);
    snap49 = await snapshot(pool);
    dataAfterUpgrade = await fingerprint(pool);
    legacyAfter = await legacyFingerprint();

    // the SAME inputs, after the upgrade
    outcomes49 = {
      ...(await runAll(legit, false)),
      ...(await runAll(keep, false)),
      ...(await runAll(defect, false)),
    };
    // every defect COMMITTED for real: refused, and not one partial row anywhere in the database
    dataBeforeCommit = await fingerprint(pool);
    committedDefects = await runAll(defect, true);
    dataAfterCommit = await fingerprint(pool);

    // ── second deploy: must be a no-op ──────────────────────────────────────────────────────
    secondDeployStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRowsAfterSecond = await migRows(pool);
    statusStdout = prisma(['migrate', 'status'], upgradeDir, upgradeUrl);

    // ── B: a FRESH database from the same 49 migrations ──────────────────────────────────────
    freshDir = makeWorkDir('fresh49', upTo49);
    prisma(['migrate', 'deploy'], freshDir, freshUrl);
    snapFresh = await snapshot(freshPool);
  }, 1_500_000);

  afterAll(async () => {
    await pool?.end();
    await freshPool?.end();
    await upgradeC?.stop();
    await freshC?.stop();
    removeWorkDirs([upgradeDir, freshDir]);
  }, 120_000);

  const expectedOf = (k: string): RegExp => caseOf.get(k)!.expect!;

  // ══════ 1. bookkeeping: exactly ONE migration applied, the 48 before it untouched ══════
  it('applies exactly ONE migration on top of 48 — migration 49 — and no other', () => {
    const applying = [...upgradeStdout.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]);
    expect(applying).toEqual([CURRENCY_RELEASE]);
    expect(migRows48).toHaveLength(48);
    expect(migRows49).toHaveLength(49);
  });

  it('the 48 earlier _prisma_migrations rows are bit-for-bit untouched by the upgrade (id, checksum, timestamps, steps, logs)', () => {
    const earlier = migRows49.filter((r) => r['migration_name'] !== CURRENCY_RELEASE);
    expect(earlier).toEqual(migRows48);
  });

  it('migration 49 is recorded finished, with the checksum of its own file', () => {
    const row = migRows49.find((r) => r['migration_name'] === CURRENCY_RELEASE)!;
    expect(row['finished_at']).not.toBeNull();
    expect(row['rolled_back_at']).toBeNull();
    expect(row['applied_steps_count']).toBe(1);
    expect(row['checksum']).toBe(
      sha256(path.join(MIGRATIONS_DIR, CURRENCY_RELEASE, 'migration.sql')),
    );
  });

  it('every recorded checksum equals the checksum of the migration file on disk (no recorded migration was edited)', () => {
    for (const r of migRows49) {
      const file = path.join(MIGRATIONS_DIR, String(r['migration_name']), 'migration.sql');
      expect(r['checksum'], String(r['migration_name'])).toBe(sha256(file));
    }
  });

  it('migrations 44, 45, 46, 47 and 48 still hash to the values recorded BEFORE migration 49 was written (all five are frozen)', () => {
    for (const [name, hash] of Object.entries(FROZEN_HASHES)) {
      expect(sha256(path.join(MIGRATIONS_DIR, name, 'migration.sql')), name).toBe(hash);
      expect(migRows49.find((r) => r['migration_name'] === name)!['checksum'], name).toBe(hash);
    }
  });

  // ══════ 2. the schema diff 48 -> 49 is EXACTLY eight function bodies ══════
  it('replaces exactly EIGHT function bodies (CREATE OR REPLACE — none added, none dropped)', () => {
    const d = diff(snap48.functions, snap49.functions, (r) => String(r['fn']));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([...REPLACED_FUNCTIONS].sort());
  });

  it('redesigns NO trigger, trigger binding, table, column, index, CHECK / FK / UNIQUE, policy, grant, RLS flag or view — so no new table, column, index, money field, route, permission or kind', () => {
    const key =
      (...f: string[]) =>
      (r: Row) =>
        f.map((k) => String(r[k])).join('.');
    for (const [label, before, after, k] of [
      ['columns', snap48.columns, snap49.columns, key('table_name', 'column_name')],
      ['constraints', snap48.constraints, snap49.constraints, key('tbl', 'conname')],
      ['indexes', snap48.indexes, snap49.indexes, key('tablename', 'indexname')],
      ['triggers', snap48.triggers, snap49.triggers, key('tbl', 'tgname')],
      ['policies', snap48.policies, snap49.policies, key('tablename', 'policyname')],
      ['tables', snap48.tables, snap49.tables, key('relname')],
      ['views', snap48.views, snap49.views, key('viewname')],
    ] as const) {
      expect(diff(before, after, k), label).toEqual({ added: [], removed: [], changed: [] });
    }
  });

  it('keeps EVERY old line and EVERY pre-existing rejection message of the eight functions, in order — the new checks are inserted, never edited in', () => {
    const def = (s: SchemaSnapshot, fn: string): string =>
      String(s.functions.find((r) => r['fn'] === fn)!['def']);
    const raised = (src: string): string[] =>
      [...src.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'/g)].map((m) => m[1]!);
    const linesOf = (src: string): string[] =>
      src
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l);
    for (const fn of REPLACED_FUNCTIONS) {
      const before = def(snap48, fn);
      const after = def(snap49, fn);
      const bMsgs = raised(before);
      const aMsgs = raised(after);
      expect(bMsgs, fn).toHaveLength(RAISES_BEFORE[fn]!);
      for (const m of bMsgs) expect(aMsgs, `${fn}: ${m}`).toContain(m);
      expect(aMsgs.length, fn).toBeGreaterThan(bMsgs.length);
      // every old LINE, in order (the function header line differs only by CREATE OR REPLACE which both share)
      const al = linesOf(after);
      let i = 0;
      const lost: string[] = [];
      for (const l of linesOf(before)) {
        const at = al.indexOf(l, i);
        if (at < 0) lost.push(l);
        else i = at + 1;
      }
      expect(lost, `${fn}: old lines lost or reordered`).toEqual([]);
    }
  });

  // ══════ 3. historical data survives ══════
  it('every row created under migration 48 — legacy defect rows included — survives the upgrade byte-for-byte (a fingerprint of EVERY table is identical before and after)', () => {
    expect(Object.keys(data48).length).toBeGreaterThan(80);
    expect(dataAfterUpgrade).toEqual(data48);
    for (const t of [
      'credit_note',
      'credit_note_line',
      'credit_note_coverage_release',
      'cancellation_charge',
      'refund',
      'refund_attempt',
      'refund_attempt_entitlement_reservation',
      'customer_advance_refund_application',
      'provider_refund_event',
      'customer_advance',
      'payment',
    ]) {
      expect(Number(data48[t]!.split(':')[0]), `${t} is populated`).toBeGreaterThan(0);
    }
  });

  it('the three LEGACY defect rows the 48 schema accepted (a wrong-customer release, a non-company-currency credit note, a foreign-branch release) are still there, unchanged and unvalidated — a trigger is not retroactive and the upgrade did not fail on them', () => {
    expect(legacyAfter).toEqual(legacyBefore);
    const emptyMd5 = 'd41d8cd98f00b204e9800998ecf8427e';
    for (const [label, hash] of Object.entries(legacyBefore)) {
      expect(hash, `${label} exists`).not.toBe(emptyMd5);
    }
  });

  // ══════ 4. behaviour: legitimate flows and existing guards IDENTICAL; every defect flips ══════
  it('every LEGITIMATE frozen flow behaves IDENTICALLY before and after: CASH / BANK / provider refunds, SUCCEEDED / FAILED reconciliation, the inbox lifecycle, credit notes, and nested CREDIT_NOTE provenance (payment chain, depth 2, opening chain, payment-advance chain) — all accepted both times', () => {
    expect(keysByKind.LEGIT).toHaveLength(13);
    const problems: string[] = [];
    for (const k of keysByKind.LEGIT) {
      if (!outcomes48[k]!.accepted) problems.push(`${k} @48: ${outcomes48[k]!.message}`);
      if (!outcomes49[k]!.accepted) problems.push(`${k} @49: ${outcomes49[k]!.message}`);
    }
    expect(problems).toEqual([]);
  });

  it('every PRE-EXISTING guard refuses identically before and after (same message): credential scope, attempt scope, release pair, funding-release currency, migration-47 provenance rules', () => {
    expect(keysByKind.KEEP).toHaveLength(13);
    const problems: string[] = [];
    for (const k of keysByKind.KEEP) {
      if (outcomes48[k]!.accepted) problems.push(`${k} @48 should be refused`);
      else if (!expectedOf(k).test(outcomes48[k]!.message)) {
        problems.push(`${k} @48 refused for the wrong reason: ${outcomes48[k]!.message}`);
      }
      if (JSON.stringify(outcomes49[k]) !== JSON.stringify(outcomes48[k])) {
        problems.push(
          `${k}: the refusal CHANGED: ${outcomes48[k]!.message} -> ${outcomes49[k]!.message}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('every DEFECT case is ACCEPTED by the 48 schema and REFUSED by the 49 schema with the precise reason (the intended delta flips exactly as designed)', () => {
    expect(keysByKind.DEFECT).toHaveLength(47);
    const problems: string[] = [];
    for (const k of keysByKind.DEFECT) {
      if (!outcomes48[k]!.accepted) {
        problems.push(`${k} @48 should be ACCEPTED (the defect) but: ${outcomes48[k]!.message}`);
      }
      if (outcomes49[k]!.accepted) problems.push(`${k} @49 should be REFUSED but was accepted`);
      else if (!expectedOf(k).test(outcomes49[k]!.message)) {
        problems.push(`${k} @49 refused for the WRONG reason: ${outcomes49[k]!.message}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a refused defect COMMITTED for real is refused again and leaves NO trace — a fingerprint of EVERY table (rows, projections, journals, audit) is identical before and after the whole batch', () => {
    const problems: string[] = [];
    for (const k of keysByKind.DEFECT) {
      if (committedDefects[k]!.accepted) problems.push(`${k} was ACCEPTED when committed for real`);
      else if (!expectedOf(k).test(committedDefects[k]!.message)) {
        problems.push(`${k} refused for the WRONG reason: ${committedDefects[k]!.message}`);
      }
    }
    expect(problems).toEqual([]);
    expect(dataAfterCommit).toEqual(dataBeforeCommit);
  });

  it('the matrix totals (reported): 13 legitimate flows accepted before AND after, 13 pre-existing guards identical, 47 defects flipped accepted -> refused', () => {
    const accepted = (o: Record<string, Outcome>, keys: string[]): number =>
      keys.filter((k) => o[k]!.accepted).length;
    const refused = (o: Record<string, Outcome>, keys: string[]): number =>
      keys.length - accepted(o, keys);
    expect({
      legit: [accepted(outcomes48, keysByKind.LEGIT), accepted(outcomes49, keysByKind.LEGIT)],
      keep: [refused(outcomes48, keysByKind.KEEP), refused(outcomes49, keysByKind.KEEP)],
      defect: [
        accepted(outcomes48, keysByKind.DEFECT),
        refused(outcomes49, keysByKind.DEFECT),
        refused(committedDefects, keysByKind.DEFECT),
      ],
    }).toEqual({ legit: [13, 13], keep: [13, 13], defect: [47, 47, 47] });
  });

  // ══════ 5. idempotence and equivalence ══════
  it('a SECOND deploy is a no-op: nothing applied, every _prisma_migrations row unchanged, status up to date', () => {
    expect(secondDeployStdout).toMatch(/No pending migrations to apply/);
    expect(migRowsAfterSecond).toEqual(migRows49);
    expect(statusStdout).toMatch(/Database schema is up to date/);
  });

  it('a FRESH database built from the same 49 migrations has a schema IDENTICAL to the upgraded one', () => {
    for (const k of [
      'columns',
      'constraints',
      'indexes',
      'triggers',
      'functions',
      'policies',
      'tables',
      'views',
    ] as const) {
      expect(snapFresh[k], k).toEqual(snap49[k]);
    }
  });

  it('the fresh 49-migration database recorded all 49 migrations as finished', async () => {
    const rows = await migRows(freshPool);
    expect(rows).toHaveLength(49);
    for (const r of rows) {
      expect(r['finished_at'], String(r['migration_name'])).not.toBeNull();
      expect(r['rolled_back_at'], String(r['migration_name'])).toBeNull();
    }
  });

  it('the Prisma schema validates (prisma validate)', () => {
    const out = prisma(['validate'], upgradeDir, upgradeUrl);
    expect(out).toMatch(/is valid/);
  });
});
