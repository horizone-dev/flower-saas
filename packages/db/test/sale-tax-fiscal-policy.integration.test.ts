import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(pkgDir, 'prisma', 'migrations');
const NEW_MIGRATION = '20260921120000_sale_tax_fiscal_policy_v1v2';

/** `prisma migrate deploy` against the real, full migrations folder —
 *  mirrors every other `packages/db/test/*.integration.test.ts` fixture. */
function migrateDeploy(url: string): void {
  execFileSync(
    'node',
    [path.join(pkgDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
  );
}

function migrationFoldersInOrder(): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Executes every migration.sql in chronological order via the simple-query
 *  protocol (each file is one implicit transaction — a failure anywhere in a
 *  file rolls back that ENTIRE file's DDL, including any earlier `ADD COLUMN`
 *  in the same batch — real, documented Postgres transactional-DDL behavior).
 *  `exclude` skips named migration folders — used to replay every migration
 *  EXCEPT Checkpoint C's, simulating the exact pre-3b.4 schema state. */
async function replayMigrations(
  client: pg.Client,
  exclude: Set<string> = new Set(),
): Promise<void> {
  for (const name of migrationFoldersInOrder()) {
    if (exclude.has(name)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
    await client.query(sql);
  }
}

function newMigrationSql(): string {
  return fs.readFileSync(path.join(migrationsDir, NEW_MIGRATION, 'migration.sql'), 'utf8');
}

// pure, independent reimplementation of the frozen V1 canonical-hash
// contract (mirrors `commercial-snapshot.test.ts`'s own independent
// computation) — used to prove a legacy Order's stored fingerprint remains
// byte-identical and still verifiable after Checkpoint C's migration.
function canonicalizeIndependent(value: unknown, depth = 0): unknown {
  if (depth > 40) return '[depth-limited]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => canonicalizeIndependent(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalizeIndependent(v, depth + 1);
  }
  return out;
}
function v1FingerprintIndependent(input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeIndependent(input)))
    .digest('hex');
}

/**
 * Task 3b.4 Checkpoint C — the safe-legacy-migration proof set (§C16).
 * Two Postgres containers (raw Testcontainers + `prisma migrate deploy`,
 * mirroring `orders-invoice-numbering.integration.test.ts`'s own fixture —
 * `packages/db` has no `@flower/testing` dependency):
 *
 *   1. "fresh DB" — the REAL `prisma migrate deploy` against the full,
 *      unmodified migrations folder (proves A/B: a fresh DB with zero
 *      existing Orders applies cleanly), plus D (a new post-migration Order
 *      is V2 with a resolved policy) and J (a second `migrate deploy` is a
 *      clean no-op) and the raw-SQL DB immutability proofs (§C18).
 *
 *   2. "legacy backfill" — every migration EXCEPT Checkpoint C's replayed
 *      via raw SQL (simulating the exact pre-3b.4 schema), a legacy V1
 *      Order inserted directly, then Checkpoint C's migration.sql executed
 *      directly and observed to either succeed (C) or fail closed (E/F/G) —
 *      a FAILED attempt is a no-op (transactional DDL rolls back the whole
 *      file), so the SAME container safely runs every failure scenario in
 *      sequence, with the one succeeding scenario run LAST (H/I).
 */
describe('sale-tax-fiscal-policy migration (task 3b.4 Checkpoint C)', () => {
  describe('fresh DB — clean apply, new-Order shape, idempotent redeploy (A/B/D/J), raw DB immutability (C18)', () => {
    let container: StartedPostgreSqlContainer;
    let pool: pg.Pool;

    const TENANT = 'aaaaaaaa-1111-7aaa-8aaa-aaaaaaaaaaaa';
    const COMPANY = 'bbbbbbbb-1111-7bbb-8bbb-bbbbbbbbbbbb';
    const BRANCH = 'cccccccc-1111-7ccc-8ccc-cccccccccccc';

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17')
        .withDatabase('flower')
        .withUsername('flower')
        .withPassword('flower_test')
        .start();
      const url = container.getConnectionUri();
      migrateDeploy(url); // A: fresh DB, full migration set, applies cleanly
      pool = new pg.Pool({ connectionString: url });

      await pool.query(
        `INSERT INTO plan (id, key, name, "updatedAt") VALUES
         ('00000000-0000-7000-8000-0000005a0001','starter-5a','Starter', now())`,
      );
      await pool.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES
         ('00000000-0000-7000-8000-0000005a0002','00000000-0000-7000-8000-0000005a0001',1,'PUBLISHED', now())`,
      );
      await pool.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1,'fp-fresh','fp-fresh','AE','ACTIVE','00000000-0000-7000-8000-0000005a0002', now())`,
        [TENANT],
      );
      await pool.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
         VALUES ('AE','UAE','x','gcc','AED','SAT_SUN', now()) ON CONFLICT (code) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ('AE','2020-01-01','VAT',
                 '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
      );
      await pool.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
         VALUES ($1,$2,'Fresh Co','AE','AED','Asia/Dubai', now())`,
        [COMPANY, TENANT],
      );
      await pool.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main', now())`,
        [BRANCH, TENANT, COMPANY],
      );
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    it('A/B. records the new migration as applied, on a fresh DB with zero pre-existing Orders', async () => {
      const { rows } = await pool.query<{ migration_name: string; finished_at: Date | null }>(
        `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`,
      );
      expect(rows.some((r) => r.migration_name === NEW_MIGRATION)).toBe(true);
      expect(rows.every((r) => r.finished_at !== null)).toBe(true);
      const orderCount = await pool.query(`SELECT COUNT(*)::int AS n FROM "order"`);
      expect(orderCount.rows[0].n).toBe(0);
    });

    it('D. a new post-migration Order is V2, with its resolved policy persisted and the DEFAULT applied when the version column is omitted', async () => {
      const orderId = 'dddddddd-1111-7ddd-8ddd-dddddddddddd';
      await pool.query(
        `INSERT INTO "order"
           (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
            "currencyCode","currencyExponent","commercialSnapshotFingerprint",
            "taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
         VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,'fp-fresh-v2',
                 'TAX_EXCLUSIVE','LINE','HALF_UP', now())`,
        [orderId, TENANT, COMPANY, BRANCH],
      );
      const { rows } = await pool.query<{
        commercialSnapshotFingerprintVersion: number;
        taxPriceMode: string;
        taxRoundingScope: string;
        taxRoundingMode: string;
      }>(
        `SELECT "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode"
           FROM "order" WHERE id = $1`,
        [orderId],
      );
      // omitted at INSERT time -> DB DEFAULT 2 applies (§C13 step 8) —
      // real application code ALSO sets it explicitly (belt+braces).
      expect(rows[0]?.commercialSnapshotFingerprintVersion).toBe(2);
      expect(rows[0]).toMatchObject({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        taxRoundingMode: 'HALF_UP',
      });
    });

    it('J. a second `migrate deploy` on the same DB is a clean no-op', () => {
      expect(() => migrateDeploy(container.getConnectionUri())).not.toThrow();
    });

    describe('raw DB immutability (§C18)', () => {
      async function mkOrder(status: string): Promise<string> {
        const orderId = randomUUID();
        await pool.query(
          `INSERT INTO "order"
             (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
              "currencyCode","currencyExponent","commercialSnapshotFingerprint",
              "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode",
              "orderNumber","updatedAt")
           VALUES ($1,$2,$3,$4,$4,'WALK_IN',$5,'AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',
                   $7,now())`,
          [
            orderId,
            TENANT,
            COMPANY,
            BRANCH,
            status,
            `fp-immut-${orderId}`,
            status === 'CONFIRMED' ? `ORD-${orderId.slice(0, 6)}` : null,
          ],
        );
        return orderId;
      }

      it.each(['DRAFT', 'HELD', 'CONFIRMED'])(
        '%s: taxPriceMode / taxRoundingScope / taxRoundingMode / fingerprintVersion changes are all rejected',
        async (status) => {
          const orderId = await mkOrder(status);
          await expect(
            pool.query(`UPDATE "order" SET "taxPriceMode" = 'TAX_INCLUSIVE' WHERE id = $1`, [
              orderId,
            ]),
          ).rejects.toThrow(/immutable/i);
          await expect(
            pool.query(`UPDATE "order" SET "taxRoundingScope" = 'DOCUMENT' WHERE id = $1`, [
              orderId,
            ]),
          ).rejects.toThrow(/immutable/i);
          await expect(
            pool.query(`UPDATE "order" SET "taxRoundingMode" = 'HALF_EVEN' WHERE id = $1`, [
              orderId,
            ]),
          ).rejects.toThrow(/immutable/i);
          await expect(
            pool.query(
              `UPDATE "order" SET "commercialSnapshotFingerprintVersion" = 1 WHERE id = $1`,
              [orderId],
            ),
          ).rejects.toThrow(/immutable/i);
        },
      );

      it('same-value updates to the 4 creation attributes are harmless (no-op, not rejected)', async () => {
        const orderId = await mkOrder('DRAFT');
        await expect(
          pool.query(
            `UPDATE "order" SET "taxPriceMode" = 'TAX_EXCLUSIVE', "taxRoundingScope" = 'LINE',
                                 "taxRoundingMode" = 'HALF_UP', "commercialSnapshotFingerprintVersion" = 2
              WHERE id = $1`,
            [orderId],
          ),
        ).resolves.toBeTruthy();
      });

      it('country_tax_config: INSERT new row and opening-row close (NULL -> date) are allowed', async () => {
        await pool.query(
          `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
           VALUES ('AE','2019-01-01','VAT',
                   '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)
           RETURNING id`,
        );
        const row = (
          await pool.query<{ id: string }>(
            `SELECT id FROM country_tax_config WHERE "countryCode"='AE' AND "effectiveFrom"='2019-01-01'`,
          )
        ).rows[0]!;
        await expect(
          pool.query(`UPDATE country_tax_config SET "effectiveTo" = '2019-12-31' WHERE id = $1`, [
            row.id,
          ]),
        ).resolves.toBeTruthy();
      });

      // §3 (Checkpoint C final-integrity pass) — a genuine C defect found on
      // inspection: no prior migration ever protected `country_tax_config`
      // against an inverted effective interval. `country_tax_config_effective_range_chk`
      // closes it — structural only, never a current-date/business-time rule.
      it('country_tax_config: an inverted effective interval (effectiveTo < effectiveFrom) is rejected by country_tax_config_effective_range_chk', async () => {
        await expect(
          pool.query(
            `INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo",regime,config)
             VALUES ('AE','2022-01-01','2021-12-31','VAT',
                     '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
          ),
        ).rejects.toThrow(/country_tax_config_effective_range_chk/i);
      });

      it('country_tax_config: an open row (effectiveTo IS NULL) and an equal effectiveFrom/effectiveTo (single-day) row both remain valid', async () => {
        await expect(
          pool.query(
            `INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo",regime,config)
             VALUES ('AE','2023-01-01',NULL,'VAT',
                     '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
          ),
        ).resolves.toBeTruthy();
        await expect(
          pool.query(
            `INSERT INTO country_tax_config ("countryCode","effectiveFrom","effectiveTo",regime,config)
             VALUES ('AE','2023-06-01','2023-06-01','VAT',
                     '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
          ),
        ).resolves.toBeTruthy();
      });

      it('country_tax_config: config/country/effectiveFrom/regime rewrite, reopen, re-date, and DELETE are all blocked', async () => {
        const row = (
          await pool.query<{ id: string }>(
            `SELECT id FROM country_tax_config WHERE "countryCode"='AE' AND "effectiveFrom"='2020-01-01'`,
          )
        ).rows[0]!;
        await expect(
          pool.query(
            `UPDATE country_tax_config SET config = '{"priceTaxMode":"TAX_INCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb WHERE id = $1`,
            [row.id],
          ),
        ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query(`UPDATE country_tax_config SET "effectiveFrom" = '2020-06-01' WHERE id = $1`, [
            row.id,
          ]),
        ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query(`UPDATE country_tax_config SET regime = 'NONE' WHERE id = $1`, [row.id]),
        ).rejects.toThrow(/immutable/i);
        // close the 2019 row, then prove it can never be reopened or re-dated
        const closedRow = (
          await pool.query<{ id: string }>(
            `SELECT id FROM country_tax_config WHERE "countryCode"='AE' AND "effectiveFrom"='2019-01-01'`,
          )
        ).rows[0]!;
        await expect(
          pool.query(`UPDATE country_tax_config SET "effectiveTo" = NULL WHERE id = $1`, [
            closedRow.id,
          ]),
        ).rejects.toThrow(/can never be changed/i);
        await expect(
          pool.query(`UPDATE country_tax_config SET "effectiveTo" = '2019-06-30' WHERE id = $1`, [
            closedRow.id,
          ]),
        ).rejects.toThrow(/can never be changed/i);
        await expect(
          pool.query(`DELETE FROM country_tax_config WHERE id = $1`, [row.id]),
        ).rejects.toThrow(/immutable/i);
      });
    });
  });

  describe('legacy backfill — replayed pre-3b.4 schema + direct migration execution (C/E/F/G/H/I)', () => {
    let container: StartedPostgreSqlContainer;
    let client: pg.Client;

    const TENANT = '11111111-2222-7111-8111-111111111111';

    /** One isolated company + branch (its own country code) + one legacy V1
     *  Order, created-at pinned to a known instant so its civil date is
     *  exact. Every scenario gets its OWN company/branch/country — total
     *  isolation, no cross-scenario interference even though a FAILED
     *  migration attempt leaves all of this fixture data in place (only the
     *  migration's own DDL/backfill rolls back, per Postgres transactional
     *  DDL — this fixture data is inserted OUTSIDE that transaction). */
    async function mkLegacyCompanyAndOrder(opts: {
      countryCode: string;
      accountingTimezone: string;
      createdAt: string; // TIMESTAMPTZ literal
    }): Promise<{ companyId: string; branchId: string; orderId: string; fingerprint: string }> {
      const companyId = randomUUID();
      const branchId = randomUUID();
      const orderId = randomUUID();
      await client.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
      );
      await client.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
         VALUES ($1,$1,'x','gcc','AED','SAT_SUN', now()) ON CONFLICT (code) DO NOTHING`,
        [opts.countryCode],
      );
      await client.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
         VALUES ($1,$2,'Legacy Co',$3,'AED',$4, now())`,
        [companyId, TENANT, opts.countryCode, opts.accountingTimezone],
      );
      await client.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main', now())`,
        [branchId, TENANT, companyId],
      );
      // the FROZEN V1 fingerprint of an empty-lines DRAFT — exactly the
      // pre-3b.4 shape, computed independently (never via the app's own code).
      const fingerprint = v1FingerprintIndependent({
        tenantId: TENANT,
        companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId: null,
        kind: 'WALK_IN',
        currencyCode: 'AED',
        lines: [],
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      });
      await client.query(
        `INSERT INTO "order"
           (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
            "currencyCode","currencyExponent","commercialSnapshotFingerprint","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,$6::timestamptz,$6::timestamptz)`,
        [orderId, TENANT, companyId, branchId, fingerprint, opts.createdAt],
      );
      return { companyId, branchId, orderId, fingerprint };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17')
        .withDatabase('flower')
        .withUsername('flower')
        .withPassword('flower_test')
        .start();
      client = new pg.Client({ connectionString: container.getConnectionUri() });
      await client.connect();
      await replayMigrations(client, new Set([NEW_MIGRATION]));

      await client.query(
        `INSERT INTO plan (id, key, name, "updatedAt") VALUES
         ('00000000-0000-7000-8000-0000005b0001','starter-5b','Starter', now())`,
      );
      await client.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES
         ('00000000-0000-7000-8000-0000005b0002','00000000-0000-7000-8000-0000005b0001',1,'PUBLISHED', now())`,
      );
      await client.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1,'fp-legacy','fp-legacy','AE','ACTIVE','00000000-0000-7000-8000-0000005b0002', now())`,
        [TENANT],
      );
    }, 180_000);

    afterAll(async () => {
      await client?.end();
      await container?.stop();
    });

    // NOTE: each "expect the migration to fail" scenario below DELETES its
    // own `order` row immediately after asserting the rejection. This is
    // safe (no re-use of a blocked DELETE path) because the migration attempt
    // itself rolled back entirely — `country_tax_config`'s immutable-DELETE
    // trigger (created only by that migration's OWN, never-committed DDL)
    // does not exist yet in this replayed pre-3b.4 schema. Cleanup is
    // required so the NEXT scenario's "every Order must resolve" check does
    // not also see THIS scenario's still-unresolved legacy Order.

    it('E. malformed config (missing key) -> migration fails, no default applied', async () => {
      const country = 'M1';
      const { orderId } = await mkLegacyCompanyAndOrder({
        countryCode: country,
        accountingTimezone: 'Asia/Dubai',
        createdAt: '2026-01-15T10:00:00Z',
      });
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT','{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE"}'::jsonb)`,
        [country],
      );
      await expect(client.query(newMigrationSql())).rejects.toThrow(/could not be resolved/i);
      await client.query(`DELETE FROM "order" WHERE id = $1`, [orderId]);
    });

    it('E. malformed config (unknown extra key) -> migration fails', async () => {
      const country = 'M2';
      const { orderId } = await mkLegacyCompanyAndOrder({
        countryCode: country,
        accountingTimezone: 'Asia/Dubai',
        createdAt: '2026-01-15T10:00:00Z',
      });
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT',
                 '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP","extra":true}'::jsonb)`,
        [country],
      );
      await expect(client.query(newMigrationSql())).rejects.toThrow(/could not be resolved/i);
      await client.query(`DELETE FROM "order" WHERE id = $1`, [orderId]);
    });

    it('E. malformed config (wrong JSON type) -> migration fails', async () => {
      const country = 'M3';
      const { orderId } = await mkLegacyCompanyAndOrder({
        countryCode: country,
        accountingTimezone: 'Asia/Dubai',
        createdAt: '2026-01-15T10:00:00Z',
      });
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT',
                 '{"priceTaxMode":1,"roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
        [country],
      );
      await expect(client.query(newMigrationSql())).rejects.toThrow(/could not be resolved/i);
      await client.query(`DELETE FROM "order" WHERE id = $1`, [orderId]);
    });

    it('E. malformed config (unknown enum value) -> migration fails', async () => {
      const country = 'M4';
      const { orderId } = await mkLegacyCompanyAndOrder({
        countryCode: country,
        accountingTimezone: 'Asia/Dubai',
        createdAt: '2026-01-15T10:00:00Z',
      });
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT',
                 '{"priceTaxMode":"TAX_ZERO","roundingScope":"LINE","roundingMode":"HALF_UP"}'::jsonb)`,
        [country],
      );
      await expect(client.query(newMigrationSql())).rejects.toThrow(/could not be resolved/i);
      await client.query(`DELETE FROM "order" WHERE id = $1`, [orderId]);
    });

    it('F. zero effective config -> migration fails for the legacy Order', async () => {
      const country = 'F1';
      const { orderId } = await mkLegacyCompanyAndOrder({
        countryCode: country,
        accountingTimezone: 'Asia/Dubai',
        createdAt: '2026-01-15T10:00:00Z',
      });
      // deliberately NO country_tax_config row at all for this country.
      await expect(client.query(newMigrationSql())).rejects.toThrow(/could not be resolved/i);
      await client.query(`DELETE FROM "order" WHERE id = $1`, [orderId]);
    });

    it('G. overlapping / ambiguous effective configs -> migration fails, never picks one', async () => {
      const country = 'G1';
      const { orderId } = await mkLegacyCompanyAndOrder({
        countryCode: country,
        accountingTimezone: 'Asia/Dubai',
        createdAt: '2026-01-15T10:00:00Z',
      });
      const VALID =
        '{"priceTaxMode":"TAX_EXCLUSIVE","roundingScope":"LINE","roundingMode":"HALF_UP"}';
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT',$2::jsonb), ($1,'2021-01-01','VAT',$2::jsonb)`,
        [country, VALID],
      );
      await expect(client.query(newMigrationSql())).rejects.toThrow(/could not be resolved/i);
      await client.query(`DELETE FROM "order" WHERE id = $1`, [orderId]);
    });

    it('H. the migration never blanket-defaults to TAX_EXCLUSIVE/LINE/HALF_UP for an unresolved Order', async () => {
      // every failing scenario above rolled back completely (transactional
      // DDL) — prove the columns still don't exist at all in this schema.
      // This is the strongest possible proof of "no default was silently
      // applied": if a default had leaked through a partially-committed
      // statement, the column would exist here.
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'order' AND column_name = 'taxPriceMode'`,
      );
      expect(cols.rowCount).toBe(0);
    });

    it('C/I. exactly one historically-effective config -> backfills correctly; fingerprint version becomes 1; stored fingerprint bytes unchanged; the immutability trigger does not self-block the backfill', async () => {
      const country = 'C1';
      const { companyId, branchId, orderId, fingerprint } = await mkLegacyCompanyAndOrder({
        countryCode: country,
        accountingTimezone: 'Asia/Dubai',
        createdAt: '2026-01-15T10:00:00Z', // civil date in Asia/Dubai: 2026-01-15
      });
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT',
                 '{"priceTaxMode":"TAX_INCLUSIVE","roundingScope":"DOCUMENT","roundingMode":"HALF_EVEN"}'::jsonb)`,
        [country],
      );

      // this is the LAST scenario in this container — it commits for real,
      // proving both C (successful backfill) and I (the creation-attribute
      // immutability trigger, created in the SAME script AFTER the backfill,
      // does not self-block it — if it did, this statement itself would throw).
      await expect(client.query(newMigrationSql())).resolves.toBeTruthy();

      const { rows } = await client.query<{
        taxPriceMode: string;
        taxRoundingScope: string;
        taxRoundingMode: string;
        commercialSnapshotFingerprintVersion: number;
        commercialSnapshotFingerprint: string;
      }>(
        `SELECT "taxPriceMode","taxRoundingScope","taxRoundingMode",
                "commercialSnapshotFingerprintVersion","commercialSnapshotFingerprint"
           FROM "order" WHERE id = $1`,
        [orderId],
      );
      expect(rows[0]).toMatchObject({
        taxPriceMode: 'TAX_INCLUSIVE',
        taxRoundingScope: 'DOCUMENT',
        taxRoundingMode: 'HALF_EVEN',
        commercialSnapshotFingerprintVersion: 1,
        commercialSnapshotFingerprint: fingerprint, // byte-identical — never rewritten
      });

      // the legacy Order remains fingerprint-valid under V1 — recomputing via
      // the FROZEN V1 shape (no fiscal-policy fields) still matches.
      const recomputed = v1FingerprintIndependent({
        tenantId: TENANT,
        companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId: null,
        kind: 'WALK_IN',
        currencyCode: 'AED',
        lines: [],
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      });
      expect(recomputed).toBe(fingerprint);

      // the immutability trigger IS now active — proven by attempting (and
      // failing) a change, immediately after the successful backfill.
      await expect(
        client.query(`UPDATE "order" SET "taxPriceMode" = 'TAX_EXCLUSIVE' WHERE id = $1`, [
          orderId,
        ]),
      ).rejects.toThrow(/immutable/i);
    });
  });

  // §2 (Checkpoint C final-integrity pass) — the migration's strict 3-key
  // shape check (`array_agg(k ORDER BY k) = ARRAY['priceTaxMode',
  // 'roundingMode', 'roundingScope']`) MUST NOT depend on unspecified
  // `jsonb_object_keys` iteration order: it already carries an explicit
  // `ORDER BY k` on the aggregated key array (see the migration SQL, STEP 3),
  // making the comparison order-independent by construction. This is a
  // SEPARATE container (a successful full-migration run permanently adds the
  // columns, so it cannot share a container with another successful run) —
  // its ONLY difference from the C/I success scenario above is the SOURCE
  // JSON TEXT key order the config is written in.
  describe('migration JSON keyset validation is order-independent', () => {
    let container: StartedPostgreSqlContainer;
    let client: pg.Client;
    const TENANT = '33333333-4444-7333-8333-333333333333';
    const COUNTRY = 'K1';

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17')
        .withDatabase('flower')
        .withUsername('flower')
        .withPassword('flower_test')
        .start();
      client = new pg.Client({ connectionString: container.getConnectionUri() });
      await client.connect();
      await replayMigrations(client, new Set([NEW_MIGRATION]));

      await client.query(
        `INSERT INTO plan (id, key, name, "updatedAt") VALUES
         ('00000000-0000-7000-8000-0000005c0001','starter-5c','Starter', now())`,
      );
      await client.query(
        `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES
         ('00000000-0000-7000-8000-0000005c0002','00000000-0000-7000-8000-0000005c0001',1,'PUBLISHED', now())`,
      );
      await client.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1,'fp-keyorder','fp-keyorder','AE','ACTIVE','00000000-0000-7000-8000-0000005c0002', now())`,
        [TENANT],
      );
    }, 180_000);

    afterAll(async () => {
      await client?.end();
      await container?.stop();
    });

    it('accepts the SAME 3 keys written in a non-alphabetical, non-canonical source order', async () => {
      const companyId = randomUUID();
      const branchId = randomUUID();
      const orderId = randomUUID();
      await client.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
      );
      await client.query(
        `INSERT INTO country (code, "nameEn", "nameAr", region, "defaultCurrencyCode", "weekendModel", "updatedAt")
         VALUES ($1,$1,'x','gcc','AED','SAT_SUN', now()) ON CONFLICT (code) DO NOTHING`,
        [COUNTRY],
      );
      await client.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
         VALUES ($1,$2,'Key-order Co',$3,'AED','Asia/Dubai', now())`,
        [companyId, TENANT, COUNTRY],
      );
      await client.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main', now())`,
        [branchId, TENANT, companyId],
      );
      const fingerprint = v1FingerprintIndependent({
        tenantId: TENANT,
        companyId,
        originBranchId: branchId,
        fulfillingBranchId: branchId,
        customerId: null,
        kind: 'WALK_IN',
        currencyCode: 'AED',
        lines: [],
        documentDiscountMode: 'NONE',
        documentDiscountBps: null,
        documentDiscountAmountMinor: '0',
        documentDiscountReason: null,
      });
      await client.query(
        `INSERT INTO "order"
           (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
            "currencyCode","currencyExponent","commercialSnapshotFingerprint","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,'2026-01-15T10:00:00Z'::timestamptz,'2026-01-15T10:00:00Z'::timestamptz)`,
        [orderId, TENANT, companyId, branchId, fingerprint],
      );
      // the exact 3 required keys, written in reverse-alphabetical /
      // non-canonical source order — `roundingMode` first, `priceTaxMode`
      // last — the OPPOSITE of the sorted comparison array's order.
      await client.query(
        `INSERT INTO country_tax_config ("countryCode","effectiveFrom",regime,config)
         VALUES ($1,'2020-01-01','VAT',
                 '{"roundingMode":"HALF_UP","roundingScope":"LINE","priceTaxMode":"TAX_EXCLUSIVE"}'::jsonb)`,
        [COUNTRY],
      );

      await expect(client.query(newMigrationSql())).resolves.toBeTruthy();

      const { rows } = await client.query<{
        taxPriceMode: string;
        taxRoundingScope: string;
        taxRoundingMode: string;
      }>(`SELECT "taxPriceMode","taxRoundingScope","taxRoundingMode" FROM "order" WHERE id = $1`, [
        orderId,
      ]);
      expect(rows[0]).toEqual({
        taxPriceMode: 'TAX_EXCLUSIVE',
        taxRoundingScope: 'LINE',
        taxRoundingMode: 'HALF_UP',
      });
    });
  });
});
