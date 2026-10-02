import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import {
  attempt,
  Fixtures,
  fingerprint,
  integrityCases,
  type Case,
  type Outcome,
  type Run,
} from './helpers/integrity-fixtures.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 3b.8 hard-gate DB-integrity closure — migration 49 (owner decision "APPROVE MIGRATION 49").
 *
 *   O-1  the nine 3b.8 tables were never currency-bound at the database. Every earlier money table carries two
 *        composite FKs (company default currency + the currency/exponent authority); the 3b.8 tables carry
 *        neither, and no 3b.8 trigger compared refund / attempt / application / reservation / credit note /
 *        credit-note line / cancellation charge to the Payment, advance, refund, attempt, invoice, order or
 *        Company they belong to. PHASE-3B-PLAN §A.8 / D3b-15: ONE company accounting currency, no FX, a
 *        mismatch fails safely.
 *   O-2A a CreditNoteCoverageRelease was never compared (tenant / company / branch) to the CreditNote or the
 *        CustomerAdvance it joins.
 *   O-2B nothing bound a CREDIT_NOTE advance's customer account to the customer of the cancelled
 *        invoice's order.
 *
 * Every case is RAW SQL on the privileged connection (so RLS can never be what refuses it). The shared case
 * matrix (`helpers/integrity-fixtures.ts`) is also run across a real 48 -> 49 upgrade by the sibling suite.
 *
 *   LEGIT  — a legitimate frozen flow: accepted;
 *   KEEP   — refused by a pre-existing guard (migration 49 must leave it exactly as it is);
 *   DEFECT — refused ONLY by a rule migration 49 adds (written RED first).
 *
 * Every refused case is also proven to leave NO trace anywhere: the fingerprint of EVERY table (rows,
 * projections, journals, audit rows) is identical before and after the refused unit of work.
 */
describe('packages/db — migration 49: currency authority + release scope + customer attribution (O-1, O-2)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let fx: Fixtures;
  const cases = integrityCases(() => fx);
  const byKind = (kind: Case['kind']): [string, Case][] =>
    cases.filter((c) => c.kind === kind).map((c) => [c.key, c]);

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
    fx = new Fixtures(pool);
    await fx.baseFixture();
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('the matrix is well formed: unique keys, every KEEP / DEFECT case names its expected refusal', () => {
    expect(new Set(cases.map((c) => c.key)).size).toBe(cases.length);
    for (const c of cases) {
      if (c.kind !== 'LEGIT') expect(c.expect, c.key).toBeInstanceOf(RegExp);
    }
    expect(byKind('LEGIT')).toHaveLength(13);
    expect(byKind('KEEP')).toHaveLength(13);
    expect(byKind('DEFECT')).toHaveLength(47);
  });

  /** a unit of work that can be committed is COMMITTED for real; a lone statement that can never commit on
   *  its own (a RefundAttempt without its reservations) is judged on the statement itself (rolled back) */
  const run1 = (run: Run, c: Case): Promise<Outcome> =>
    attempt(pool, run, c.immediate !== false, c.immediate ?? true);

  it.each(byKind('LEGIT'))('%s', async (_key, c) => {
    const run = await c.build();
    const outcome = await run1(run, c);
    expect(outcome, 'a legitimate frozen flow must be ACCEPTED').toEqual({
      accepted: true,
      message: '',
    });
  });

  it.each(byKind('KEEP'))('%s', async (_key, c) => {
    const run = await c.build();
    const before = await fingerprint(pool);
    const outcome = await run1(run, c);
    expect(outcome.accepted, 'a pre-existing guard must keep refusing').toBe(false);
    expect(outcome.message).toMatch(c.expect!);
    expect(await fingerprint(pool), 'a refused unit of work leaves no trace in ANY table').toEqual(
      before,
    );
  });

  it.each(byKind('DEFECT'))('%s', async (_key, c) => {
    const run = await c.build();
    const before = await fingerprint(pool);
    const outcome = await run1(run, c);
    expect(
      outcome.accepted ? 'NOT REFUSED - the raw unit of work was ACCEPTED' : outcome.message,
    ).toMatch(c.expect!);
    expect(await fingerprint(pool), 'a refused unit of work leaves no trace in ANY table').toEqual(
      before,
    );
  });
});
