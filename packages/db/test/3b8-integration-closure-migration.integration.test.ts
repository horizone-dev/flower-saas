import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(pkgDir, 'prisma', 'migrations');
const PRISMA_CLI = path.join(pkgDir, 'node_modules/prisma/build/index.js');
const CLOSURE = '20261007120000_phase_3b8_integration_closure';

/**
 * Task 3b.8 Integration Closure — MIGRATION 46
 * (`20261007120000_phase_3b8_integration_closure`) proven as a real UPGRADE.
 *
 * The migration only CREATE OR REPLACEs four DB functions and replaces two CHECK
 * constraints (the `customer_account_entry` kind vocabulary + its exactly-one-
 * reference rule) — it redesigns no table, column, index, trigger, policy or money
 * representation. This suite proves that with the REAL `prisma migrate deploy`
 * tooling against real Postgres:
 *
 *   1. migrations 1..45 are applied first, DATA is seeded under that exact schema,
 *      and the schema + behaviour are captured ("before");
 *   2. migration 46 is applied on top by a second `migrate deploy` (an UPGRADE of a
 *      populated database, not a fresh install) — exactly ONE migration is applied,
 *      the 45 earlier `_prisma_migrations` rows are bit-for-bit untouched;
 *   3. the schema diff 45 -> 46 is EXACTLY the two CHECKs + the four functions —
 *      nothing else (no table/column/index/trigger/policy/grant/view difference);
 *   4. every pre-existing historical row survives and still satisfies the widened
 *      constraints (they were added VALIDATED);
 *   5. INVOICE- and OPENING-receivable behaviour is IDENTICAL before and after (same
 *      accept/reject outcome and message), while the intended deltas — a payment
 *      applied to a CANCELLATION_CHARGE receivable, the NULL-principal capacity
 *      hole, a CreditNote's AR reduction in invoice coverage, the new chronology
 *      kind — change exactly as designed;
 *   6. a SECOND deploy is a no-op; a FRESH database built from the same 46
 *      migrations has a schema identical to the upgraded one.
 *
 * The working directories are throwaway copies of the real migration files (the
 * originals are never written).
 */

const TENANT = 'a1000000-8111-7111-8111-111111111111';
const COMPANY = 'a3000000-8333-7333-8333-333333333333';
const BRANCH = 'a6000000-8666-7666-8666-666666666666';
const CATEGORY = 'a2000000-8888-7888-8888-888888888888';
const PRODUCT = 'a3300000-8999-7999-8999-999999999999';
const VARIANT = 'a4000000-8aaa-7aaa-8aaa-aaaaaaaaaaaa';

const uid = (): string => crypto.randomUUID();
const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function migrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** a throwaway Prisma working dir in the OS temp dir (never inside the repo): a minimal
 *  config (same schema/migrations layout and DATABASE_URL datasource as the package's own
 *  `prisma7.config.ts`), the schema, and COPIES of the given migrations */
function makeWorkDir(prefix: string, names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flower-${prefix}-`));
  fs.writeFileSync(
    path.join(dir, 'prisma7.config.ts'),
    [
      'export default {',
      "  schema: 'prisma/schema.prisma',",
      "  migrations: { path: 'prisma/migrations' },",
      "  datasource: { url: process.env['DATABASE_URL'] },",
      '};',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(dir, 'prisma', 'migrations'), { recursive: true });
  fs.copyFileSync(
    path.join(pkgDir, 'prisma', 'schema.prisma'),
    path.join(dir, 'prisma', 'schema.prisma'),
  );
  fs.copyFileSync(
    path.join(MIGRATIONS_DIR, 'migration_lock.toml'),
    path.join(dir, 'prisma', 'migrations', 'migration_lock.toml'),
  );
  for (const n of names) addMigration(dir, n);
  return dir;
}

function addMigration(dir: string, name: string): void {
  fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dir, 'prisma', 'migrations', name), {
    recursive: true,
  });
}

function prisma(args: string[], cwd: string, url: string): string {
  return execFileSync('node', [PRISMA_CLI, ...args], {
    cwd,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
}

interface Row {
  [k: string]: unknown;
}

interface SchemaSnapshot {
  columns: Row[];
  constraints: Row[];
  indexes: Row[];
  triggers: Row[];
  functions: Row[];
  policies: Row[];
  tables: Row[];
  views: Row[];
}

async function snapshot(pool: pg.Pool): Promise<SchemaSnapshot> {
  const rows = async (text: string): Promise<Row[]> => (await pool.query(text)).rows as Row[];
  return {
    columns: await rows(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
             character_maximum_length, numeric_precision, numeric_scale, ordinal_position
        FROM information_schema.columns WHERE table_schema = 'public'
       ORDER BY table_name, column_name`),
    constraints: await rows(`
      SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype::text AS contype,
             pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' ORDER BY 1, 2`),
    indexes: await rows(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' ORDER BY 1, 2`),
    triggers: await rows(`
      SELECT c.relname AS tbl, t.tgname, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1, 2`),
    functions: await rows(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
             pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' ORDER BY 1`),
    policies: await rows(`
      SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
        FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`),
    tables: await rows(`
      SELECT c.relname, c.relkind::text AS relkind, c.relrowsecurity, c.relforcerowsecurity,
             c.relacl::text AS acl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') ORDER BY 1`),
    views: await rows(
      `SELECT viewname, definition FROM pg_views WHERE schemaname = 'public' ORDER BY 1`,
    ),
  };
}

/** keys whose row differs / exists on only one side, by a caller-chosen key */
function diff(
  before: Row[],
  after: Row[],
  key: (r: Row) => string,
): { added: string[]; removed: string[]; changed: string[] } {
  const b = new Map(before.map((r) => [key(r), JSON.stringify(r)]));
  const a = new Map(after.map((r) => [key(r), JSON.stringify(r)]));
  return {
    added: [...a.keys()].filter((k) => !b.has(k)).sort(),
    removed: [...b.keys()].filter((k) => !a.has(k)).sort(),
    changed: [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort(),
  };
}

/** ids / dates in a DB error vary per run — keep the SHAPE of the message only */
const normalize = (msg: string): string =>
  msg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');

interface Outcome {
  accepted: boolean;
  message: string;
}
const attempt = async (fn: () => Promise<unknown>): Promise<Outcome> => {
  try {
    await fn();
    return { accepted: true, message: '' };
  } catch (e) {
    return { accepted: false, message: normalize(e instanceof Error ? e.message : String(e)) };
  }
};

describe('packages/db — migration 46 (3b.8 integration closure): a real 45 -> 46 upgrade', () => {
  const names = migrationNames();
  const before46 = names.filter((n) => n < CLOSURE);
  const upTo46 = names.filter((n) => n <= CLOSURE);

  let upgradeC: StartedPostgreSqlContainer;
  let freshC: StartedPostgreSqlContainer;
  let upgradeUrl = '';
  let freshUrl = '';
  let pool: pg.Pool;
  let freshPool: pg.Pool;
  let upgradeDir = '';
  let freshDir = '';

  let snap45: SchemaSnapshot;
  let snap46: SchemaSnapshot;
  let snapFresh: SchemaSnapshot;
  let migRows45: Row[] = [];
  let migRows46: Row[] = [];
  let historical45: Row[] = [];
  let outcomes45: Record<string, Outcome> = {};
  let outcomes46: Record<string, Outcome> = {};
  let upgradeStdout = '';
  let secondDeployStdout = '';
  let statusStdout = '';
  let migRowsAfterSecond: Row[] = [];

  const migRows = async (p: pg.Pool): Promise<Row[]> =>
    (
      await p.query(
        `SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
           FROM _prisma_migrations ORDER BY migration_name`,
      )
    ).rows as Row[];

  // ── fixtures (raw SQL, like every schema test in this package) ────────────
  let seq = 0;
  async function baseFixture(p: pg.Pool): Promise<void> {
    await p.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await p.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    await p.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1, 'mig46', 'mig46', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
      [TENANT],
    );
    await p.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'UAE Dirham', 'AED') ON CONFLICT (code) DO NOTHING`,
    );
    await p.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Mig Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    await p.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Main', now())`,
      [BRANCH, TENANT, COMPANY],
    );
    await p.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt") VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await p.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose', 'Rose', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await p.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt") VALUES ($1, $2, $3, 'V', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
  }

  /** every fixture factory is bound to ONE pool so the SAME scenarios can be replayed on the
   *  database at migration 45 and again at migration 46 */
  function fixtures(p: pg.Pool) {
    const freshAccount = async (): Promise<{ ccaId: string; customerId: string }> => {
      const customerId = uid();
      await p.query(
        `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'C', now())`,
        [customerId, TENANT],
      );
      const ccaId = uid();
      await p.query(
        `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [ccaId, TENANT, COMPANY, customerId],
      );
      return { ccaId, customerId };
    };

    const orderOf = async (customerId: string | null): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO "order"
           (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
            "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
            "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
            "taxRoundingMode", "documentDiscountAmountMinor", "updatedAt")
         VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,now())`,
        [id, TENANT, COMPANY, BRANCH, customerId, `fp-${id}`],
      );
      return id;
    };

    /** order + ONE tax-free line (qty 1, unit price = total) + invoice of `totalMinor` */
    const invoiceOf = async (
      totalMinor: number,
      customerId: string | null,
    ): Promise<{ orderId: string; lineId: string; invoiceId: string }> => {
      const orderId = await orderOf(customerId);
      const lineId = uid();
      await p.query(
        `INSERT INTO order_line
           (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
            "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
            "discountMode", "discountAmountMinor", "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
            "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
            "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
            "updatedAt")
         VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'NONE',0,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
                 'NONE','PIECE','Piece','PIECE',1,1,'Rose','V', now())`,
        [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT, totalMinor],
      );
      await p.query(
        `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
        [orderId, `ORD-46-${(++seq).toString().padStart(6, '0')}`],
      );
      const invoiceId = uid();
      await p.query(
        `INSERT INTO invoice
           (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
            "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
            "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
         VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, $7, 0, 0, $7)`,
        [invoiceId, TENANT, COMPANY, BRANCH, orderId, `INV-${invoiceId.slice(0, 8)}`, totalMinor],
      );
      return { orderId, lineId, invoiceId };
    };

    const invoiceReceivable = async (ccaId: string, invoiceId: string): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
         VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
        [id, TENANT, COMPANY, BRANCH, ccaId, invoiceId],
      );
      return id;
    };

    const openingReceivable = async (ccaId: string, amountMinor: number): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","openingAmountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
        [id, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
      );
      return id;
    };

    const chargeReceivable = async (ccaId: string, customerId: string, totalMinor: number) => {
      const orderId = await orderOf(customerId);
      const chargeId = uid();
      await p.query(
        `INSERT INTO cancellation_charge
           (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
            "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
            "priceTaxMode","roundingMode","reasonCode","accountingDate")
         VALUES ($1,$2,$3,$4,$5,$6,$7,5,$8,'AED',2,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
        [
          chargeId,
          TENANT,
          COMPANY,
          BRANCH,
          orderId,
          `CC-${chargeId.slice(0, 8)}`,
          totalMinor - 5,
          totalMinor,
        ],
      );
      const id = uid();
      await p.query(
        `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","cancellationChargeId")
         VALUES ($1,$2,$3,$4,$5,'CANCELLATION_CHARGE',$6)`,
        [id, TENANT, COMPANY, BRANCH, ccaId, chargeId],
      );
      return id;
    };

    /** a captured CUSTOMER_RECEIPT Payment attributed to the account */
    const receiptPayment = async (ccaId: string, amountMinor: number): Promise<string> => {
      const attemptId = uid();
      await p.query(
        `INSERT INTO payment_attempt
           (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
            method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
         VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'BANK_TRANSFER',$6,'AED',2,'CAPTURED',$7, now())`,
        [attemptId, TENANT, COMPANY, BRANCH, ccaId, amountMinor, `idem-${attemptId}`],
      );
      const paymentId = uid();
      await p.query(
        `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
        [paymentId, TENANT, COMPANY, BRANCH, attemptId, amountMinor],
      );
      return paymentId;
    };

    const paymentApplication = async (
      ccaId: string,
      paymentId: string,
      receivableId: string,
      amountMinor: number,
    ): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO customer_receivable_payment_application
           (id,"tenantId","companyId","branchId","customerCompanyAccountId","paymentId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AED',2)`,
        [id, TENANT, COMPANY, BRANCH, ccaId, paymentId, receivableId, amountMinor],
      );
      return id;
    };

    /** an invoice-collection Payment + its allocation to `invoiceId` */
    const allocation = async (
      invoiceId: string,
      amountMinor: number,
    ): Promise<{ paymentId: string; allocationId: string }> => {
      const attemptId = uid();
      await p.query(
        `INSERT INTO payment_attempt
           (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "receiptPurpose",
            method, "amountMinor", "currencyCode", "currencyExponent", state,
            "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
            "idempotencyKey", "updatedAt")
         VALUES ($1,$2,$3,$4, (SELECT "orderId" FROM invoice WHERE id=$5), $5,'INVOICE_COLLECTION',
                 'BANK_TRANSFER',$6,'AED',2,'CAPTURED','fp',1,$7, now())`,
        [attemptId, TENANT, COMPANY, BRANCH, invoiceId, amountMinor, `idem-${attemptId}`],
      );
      const paymentId = uid();
      await p.query(
        `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
        [paymentId, TENANT, COMPANY, BRANCH, attemptId, amountMinor],
      );
      const allocationId = uid();
      await p.query(
        `INSERT INTO payment_allocation (id, "tenantId", "companyId", "branchId", "paymentId", "invoiceId", "amountMinor", "currencyCode", "currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
        [allocationId, TENANT, COMPANY, BRANCH, paymentId, invoiceId, amountMinor],
      );
      return { paymentId, allocationId };
    };

    /** a CREDIT_NOTE-sourced advance of `advanceMinor` + an application of `appliedMinor` to the receivable */
    const advanceApplication = async (
      ccaId: string,
      receivableId: string,
      advanceMinor: number,
      appliedMinor: number,
    ): Promise<{ advanceId: string; applicationId: string }> => {
      const advanceId = uid();
      await p.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
        [advanceId, TENANT, COMPANY, BRANCH, ccaId, advanceMinor],
      );
      const applicationId = uid();
      await p.query(
        `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
        [applicationId, TENANT, COMPANY, BRANCH, advanceId, receivableId, appliedMinor],
      );
      return { advanceId, applicationId };
    };

    /** a FULL pure-AR-reduction CreditNote (header + ONE line in ONE transaction — the
     *  completeness triggers are deferred) */
    const creditNoteFull = async (
      invoiceId: string,
      lineId: string,
      totalMinor: number,
    ): Promise<void> => {
      const cnId = uid();
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO credit_note
             (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate",
              "currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor",
              "totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',$7,0,$7,$7,0)`,
          [cnId, TENANT, COMPANY, BRANCH, invoiceId, `CN-${cnId.slice(0, 8)}`, totalMinor],
        );
        await c.query(
          `INSERT INTO credit_note_line
             (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor",
              "discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor",
              "taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'1.0000',$6,0,0,$6,0,$6,'AED',2)`,
          [uid(), TENANT, COMPANY, cnId, lineId, totalMinor],
        );
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
    };

    const entry = (
      ccaId: string,
      kind: string,
      refColumn: string,
      refValue: string,
    ): Promise<unknown> =>
      p.query(
        `INSERT INTO customer_account_entry (id,"tenantId","companyId","branchId","customerCompanyAccountId","entryKind","${refColumn}")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uid(), TENANT, COMPANY, BRANCH, ccaId, kind, refValue],
      );

    return {
      freshAccount,
      invoiceOf,
      invoiceReceivable,
      openingReceivable,
      chargeReceivable,
      receiptPayment,
      paymentApplication,
      allocation,
      advanceApplication,
      creditNoteFull,
      entry,
    };
  }

  /** the behaviour matrix, replayed verbatim at migration 45 and at migration 46 */
  async function runMatrix(p: pg.Pool): Promise<Record<string, Outcome>> {
    const f = fixtures(p);
    const out: Record<string, Outcome> = {};

    // ── PRESERVED: OPENING receivable payment applications ─────────────────
    {
      const { ccaId } = await f.freshAccount();
      const rec = await f.openingReceivable(ccaId, 1000);
      const pay = await f.receiptPayment(ccaId, 2000);
      out['P1 opening: payment application within capacity'] = await attempt(() =>
        f.paymentApplication(ccaId, pay, rec, 600),
      );
      out['P2 opening: payment application beyond capacity'] = await attempt(() =>
        f.paymentApplication(ccaId, pay, rec, 401),
      );
      out['P3 opening: exact remainder'] = await attempt(() =>
        f.paymentApplication(ccaId, pay, rec, 400),
      );
      out['P3b opening: one more after the ceiling'] = await attempt(() =>
        f.paymentApplication(ccaId, pay, rec, 1),
      );
    }
    // ── PRESERVED: an INVOICE receivable is never a payment-application target ──
    {
      const { ccaId, customerId } = await f.freshAccount();
      const { invoiceId } = await f.invoiceOf(1000, customerId);
      const rec = await f.invoiceReceivable(ccaId, invoiceId);
      const pay = await f.receiptPayment(ccaId, 500);
      out['P4 invoice receivable: payment application'] = await attempt(() =>
        f.paymentApplication(ccaId, pay, rec, 100),
      );
    }
    // ── PRESERVED: invoice allocation coverage ─────────────────────────────
    {
      const { invoiceId } = await f.invoiceOf(2000, null);
      out['P5 invoice: allocation up to the total'] = await attempt(() =>
        f.allocation(invoiceId, 2000),
      );
      out['P5b invoice: allocation beyond the total'] = await attempt(() =>
        f.allocation(invoiceId, 1),
      );
    }
    // ── PRESERVED: an advance application counts toward invoice coverage ──────
    {
      const { ccaId, customerId } = await f.freshAccount();
      const { invoiceId } = await f.invoiceOf(2000, customerId);
      const rec = await f.invoiceReceivable(ccaId, invoiceId);
      out['P6 invoice: advance application 1500'] = await attempt(() =>
        f.advanceApplication(ccaId, rec, 1500, 1500),
      );
      out['P6b invoice: allocation beyond (total - advance)'] = await attempt(() =>
        f.allocation(invoiceId, 501),
      );
      out['P6c invoice: allocation of exactly (total - advance)'] = await attempt(() =>
        f.allocation(invoiceId, 500),
      );
    }

    // ── INTENDED DELTAS ───────────────────────────────────────────────────────
    {
      const { ccaId, customerId } = await f.freshAccount();
      const rec = await f.chargeReceivable(ccaId, customerId, 105);
      const pay = await f.receiptPayment(ccaId, 105);
      out['D1 charge receivable: payment application'] = await attempt(() =>
        f.paymentApplication(ccaId, pay, rec, 100),
      );
    }
    {
      const { ccaId, customerId } = await f.freshAccount();
      const rec = await f.chargeReceivable(ccaId, customerId, 105);
      out['D2 charge receivable: advance application beyond the total'] = await attempt(() =>
        f.advanceApplication(ccaId, rec, 106, 106),
      );
    }
    {
      const { lineId, invoiceId } = await f.invoiceOf(2000, null);
      await f.creditNoteFull(invoiceId, lineId, 2000);
      out['D3 credit-noted invoice: allocation'] = await attempt(() =>
        f.allocation(invoiceId, 500),
      );
    }
    {
      // the new chronology kind recorded against an OPENING-receivable application
      const { ccaId } = await f.freshAccount();
      const rec = await f.openingReceivable(ccaId, 100);
      const pay = await f.receiptPayment(ccaId, 100);
      const app = await f.paymentApplication(ccaId, pay, rec, 100);
      out['D4 new kind on an OPENING application'] = await attempt(() =>
        f.entry(
          ccaId,
          'CANCELLATION_CHARGE_PAYMENT_APPLIED',
          'customerReceivablePaymentApplicationId',
          app,
        ),
      );
      out['D4b legacy kind on an OPENING application'] = await attempt(() =>
        f.entry(
          ccaId,
          'OPENING_RECEIVABLE_PAYMENT_APPLIED',
          'customerReceivablePaymentApplicationId',
          app,
        ),
      );
      out['D4c unlisted kind'] = await attempt(() =>
        f.entry(ccaId, 'WRITE_OFF', 'customerReceivablePaymentApplicationId', app),
      );
    }
    return out;
  }

  beforeAll(async () => {
    expect(before46, 'the 45 migrations that precede migration 46').toHaveLength(45);
    expect(names).toContain(CLOSURE);

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

    // ── A: the UPGRADE database — migrations 1..45 first ───────────────────
    upgradeDir = makeWorkDir('mig45', before46);
    prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    await baseFixture(pool);
    migRows45 = await migRows(pool);
    snap45 = await snapshot(pool);

    // data created UNDER MIGRATION 45's schema — it must survive the upgrade untouched
    {
      const f = fixtures(pool);
      const { ccaId, customerId } = await f.freshAccount();
      const opening = await f.openingReceivable(ccaId, 1000);
      const pay = await f.receiptPayment(ccaId, 1000);
      const openingApp = await f.paymentApplication(ccaId, pay, opening, 700);
      await f.entry(ccaId, 'OPENING_RECEIVABLE', 'customerReceivableId', opening);
      await f.entry(
        ccaId,
        'OPENING_RECEIVABLE_PAYMENT_APPLIED',
        'customerReceivablePaymentApplicationId',
        openingApp,
      );
      await f.entry(ccaId, 'PAYMENT', 'paymentId', pay);
      const { invoiceId } = await f.invoiceOf(2000, customerId);
      const invRec = await f.invoiceReceivable(ccaId, invoiceId);
      await f.entry(ccaId, 'INVOICE', 'customerReceivableId', invRec);
      const alloc = await f.allocation(invoiceId, 800);
      await f.entry(ccaId, 'PAYMENT_ALLOCATION', 'paymentAllocationId', alloc.allocationId);
      const adv = await f.advanceApplication(ccaId, invRec, 500, 500);
      await f.entry(ccaId, 'ADVANCE_APPLIED', 'customerAdvanceApplicationId', adv.applicationId);
    }
    historical45 = (await pool.query(`SELECT * FROM customer_account_entry ORDER BY id`))
      .rows as Row[];
    outcomes45 = await runMatrix(pool);

    // ── migration 46 applied on top — a real UPGRADE of the populated DB ──────
    addMigration(upgradeDir, CLOSURE);
    upgradeStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRows46 = await migRows(pool);
    snap46 = await snapshot(pool);
    outcomes46 = await runMatrix(pool);

    // ── second deploy: must be a no-op ────────────────────────────────────────
    secondDeployStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRowsAfterSecond = await migRows(pool);
    statusStdout = prisma(['migrate', 'status'], upgradeDir, upgradeUrl);

    // ── B: a FRESH database from the same 46 migrations ───────────────────────
    freshDir = makeWorkDir('fresh46', upTo46);
    prisma(['migrate', 'deploy'], freshDir, freshUrl);
    snapFresh = await snapshot(freshPool);
  }, 900_000);

  afterAll(async () => {
    await pool?.end();
    await freshPool?.end();
    await upgradeC?.stop();
    await freshC?.stop();
    for (const d of [upgradeDir, freshDir]) {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  }, 120_000);

  // ══════ 1. bookkeeping: exactly ONE migration applied, the 45 before it untouched ══════
  it('applies exactly ONE migration on top of 45 — migration 46 — and no other', () => {
    const applying = [...upgradeStdout.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]);
    expect(applying).toEqual([CLOSURE]);
    expect(migRows45).toHaveLength(45);
    expect(migRows46).toHaveLength(46);
  });

  it('the 45 earlier _prisma_migrations rows are bit-for-bit untouched by the upgrade (id, checksum, timestamps, steps, logs)', () => {
    const earlier = migRows46.filter((r) => r['migration_name'] !== CLOSURE);
    expect(earlier).toEqual(migRows45);
  });

  it('migration 46 is recorded finished, with the checksum of its own file', () => {
    const row = migRows46.find((r) => r['migration_name'] === CLOSURE)!;
    expect(row['finished_at']).not.toBeNull();
    expect(row['rolled_back_at']).toBeNull();
    expect(row['applied_steps_count']).toBe(1);
    expect(row['checksum']).toBe(sha256(path.join(MIGRATIONS_DIR, CLOSURE, 'migration.sql')));
  });

  it('every recorded checksum equals the checksum of the migration file on disk (no recorded migration was edited)', () => {
    for (const r of migRows46) {
      const file = path.join(MIGRATIONS_DIR, String(r['migration_name']), 'migration.sql');
      expect(r['checksum'], String(r['migration_name'])).toBe(sha256(file));
    }
  });

  // ══════ 2. the schema diff 45 -> 46 is EXACTLY the 2 CHECKs + the 4 functions ══════
  it('changes exactly two CHECK constraints and nothing else among constraints', () => {
    const d = diff(snap45.constraints, snap46.constraints, (r) => `${r['tbl']}.${r['conname']}`);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([
      'customer_account_entry.customer_account_entry_kind_chk',
      'customer_account_entry.customer_account_entry_reference_xor_chk',
    ]);
  });

  it('replaces exactly four functions (CREATE OR REPLACE — none added, none dropped)', () => {
    const d = diff(snap45.functions, snap46.functions, (r) => String(r['fn']));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([
      'fn_check_customer_account_entry_source_type()',
      'fn_check_customer_receivable_payment_application_integrity()',
      'fn_lock_and_validate_invoice_coverage(p_invoice_id uuid, p_proposed_amount bigint)',
      'fn_lock_and_validate_opening_receivable_coverage(p_receivable_id uuid, p_proposed_amount bigint)',
    ]);
  });

  it('redesigns NO table, column, index, trigger, policy, grant, RLS flag or view (and so no money representation)', () => {
    const key =
      (...f: string[]) =>
      (r: Row) =>
        f.map((k) => String(r[k])).join('.');
    for (const [label, before, after, k] of [
      ['columns', snap45.columns, snap46.columns, key('table_name', 'column_name')],
      ['indexes', snap45.indexes, snap46.indexes, key('tablename', 'indexname')],
      ['triggers', snap45.triggers, snap46.triggers, key('tbl', 'tgname')],
      ['policies', snap45.policies, snap46.policies, key('tablename', 'policyname')],
      ['tables', snap45.tables, snap46.tables, key('relname')],
      ['views', snap45.views, snap46.views, key('viewname')],
    ] as const) {
      expect(diff(before, after, k), label).toEqual({ added: [], removed: [], changed: [] });
    }
  });

  it('the widened kind CHECK keeps all 11 earlier kinds and adds exactly CANCELLATION_CHARGE_PAYMENT_APPLIED', () => {
    const def = (s: SchemaSnapshot): string =>
      String(s.constraints.find((r) => r['conname'] === 'customer_account_entry_kind_chk')!['def']);
    const kinds = (s: string): string[] => [...s.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    const b = kinds(def(snap45));
    const a = kinds(def(snap46));
    expect(b).toHaveLength(11);
    expect(a).toEqual([...b, 'CANCELLATION_CHARGE_PAYMENT_APPLIED'].sort());
  });

  // ══════ 3. historical data survives and satisfies the widened constraints ══════
  it('every row created under migration 45 survives the upgrade byte-for-byte (the new CHECKs were added VALIDATED against them)', async () => {
    expect(historical45).toHaveLength(6);
    const after = (
      await pool.query(`SELECT * FROM customer_account_entry WHERE id = ANY($1) ORDER BY id`, [
        historical45.map((r) => r['id']),
      ])
    ).rows as Row[];
    expect(after).toEqual(historical45);
    const validated = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('customer_account_entry_kind_chk','customer_account_entry_reference_xor_chk')`,
    );
    for (const r of validated.rows) expect(r.convalidated, r.conname).toBe(true);
  });

  // ══════ 4. behaviour: INVOICE + OPENING preserved; the designed deltas change as designed ══════
  it('INVOICE and OPENING behaviour is IDENTICAL before and after (same accept/reject, same message)', () => {
    const preserved = Object.keys(outcomes45).filter((k) => k.startsWith('P'));
    expect(preserved.length).toBeGreaterThanOrEqual(9);
    // Every decision is identical, and so is every message EXCEPT the two rejection texts that
    // gained one field each. These are the ONLY textual differences, stated exactly (applying
    // the inverse edit to the migration-46 message must reproduce the migration-45 message):
    //  - an INVOICE target of a payment application: the target rule is now "OPENING or
    //    CANCELLATION_CHARGE", so the explanation gains " and is not CANCELLATION_CHARGE-sourced";
    //  - an invoice coverage rejection gains the `credited by CreditNote=N` field (N = 0 here).
    const dropCharge = (m: string): string =>
      m.replace(' and is not CANCELLATION_CHARGE-sourced', '');
    const dropZeroCredit = (m: string): string => m.replace(', credited by CreditNote=0', '');
    const textDelta: Record<string, (m46: string) => string> = {
      'P4 invoice receivable: payment application': dropCharge,
      'P5b invoice: allocation beyond the total': dropZeroCredit,
      'P6b invoice: allocation beyond (total - advance)': dropZeroCredit,
    };
    for (const k of preserved) {
      const o46 = outcomes46[k]!;
      const normalized = {
        accepted: o46.accepted,
        message: (textDelta[k] ?? ((m) => m))(o46.message),
      };
      expect(normalized, k).toEqual(outcomes45[k]);
    }
    // the deltas listed above really occurred (no stale entries)
    for (const k of Object.keys(textDelta)) {
      expect(outcomes46[k]!.message, k).not.toEqual(outcomes45[k]!.message);
    }
    // and the preserved behaviour is the intended one, not merely "the same"
    expect(outcomes46['P1 opening: payment application within capacity']!.accepted).toBe(true);
    expect(outcomes46['P2 opening: payment application beyond capacity']!.message).toMatch(
      /\(OPENING\) coverage would exceed openingAmountMinor/,
    );
    expect(outcomes46['P3 opening: exact remainder']!.accepted).toBe(true);
    expect(outcomes46['P3b opening: one more after the ceiling']!.accepted).toBe(false);
    expect(outcomes46['P4 invoice receivable: payment application']!.message).toMatch(
      /is not OPENING-sourced/,
    );
    expect(outcomes46['P5 invoice: allocation up to the total']!.accepted).toBe(true);
    expect(outcomes46['P5b invoice: allocation beyond the total']!.message).toMatch(
      /coverage would exceed totalAmountMinor/,
    );
    expect(outcomes46['P6 invoice: advance application 1500']!.accepted).toBe(true);
    expect(outcomes46['P6b invoice: allocation beyond (total - advance)']!.message).toMatch(
      /coverage would exceed totalAmountMinor/,
    );
    expect(outcomes46['P6c invoice: allocation of exactly (total - advance)']!.accepted).toBe(true);
  });

  it('the INTENDED deltas change exactly as designed (charge receivable settlement, NULL-principal hole, CreditNote-aware invoice coverage, the new chronology kind)', () => {
    // D1 — a payment applied to a CANCELLATION_CHARGE receivable
    expect(outcomes45['D1 charge receivable: payment application']!.message).toMatch(
      /is not OPENING-sourced/,
    );
    expect(outcomes46['D1 charge receivable: payment application']!.accepted).toBe(true);
    // D2 — the silent NULL-principal hole (`covered + proposed > NULL` is never true)
    expect(outcomes45['D2 charge receivable: advance application beyond the total']!.accepted).toBe(
      true,
    );
    expect(
      outcomes46['D2 charge receivable: advance application beyond the total']!.message,
    ).toMatch(/CANCELLATION_CHARGE.*coverage would exceed/);
    // D3 — a CreditNote's AR reduction is part of invoice coverage
    expect(outcomes45['D3 credit-noted invoice: allocation']!.accepted).toBe(true);
    expect(outcomes46['D3 credit-noted invoice: allocation']!.message).toMatch(
      /coverage would exceed totalAmountMinor .*credited by CreditNote=2000/,
    );
    // D4 — the chronology vocabulary: closed before, widened (still closed) after
    expect(outcomes45['D4 new kind on an OPENING application']!.message).toMatch(
      /customer_account_entry_kind_chk/,
    );
    expect(outcomes46['D4 new kind on an OPENING application']!.message).toMatch(
      /CANCELLATION_CHARGE_PAYMENT_APPLIED requires .*CANCELLATION_CHARGE/,
    );
    expect(outcomes45['D4b legacy kind on an OPENING application']!.accepted).toBe(true);
    expect(outcomes46['D4b legacy kind on an OPENING application']!.accepted).toBe(true);
    expect(outcomes45['D4c unlisted kind']!.message).toMatch(/customer_account_entry_kind_chk/);
    expect(outcomes46['D4c unlisted kind']!.message).toMatch(/customer_account_entry_kind_chk/);
  });

  // ══════ 5. idempotence + upgrade == fresh ══════
  it('a SECOND deploy is a no-op: nothing applied, every _prisma_migrations row unchanged, status up to date', () => {
    expect(secondDeployStdout).toMatch(/No pending migrations to apply/);
    expect(secondDeployStdout).not.toMatch(/Applying migration/);
    expect(migRowsAfterSecond).toEqual(migRows46);
    expect(statusStdout).toMatch(/Database schema is up to date/);
  });

  it('a FRESH database built from the same 46 migrations has a schema IDENTICAL to the upgraded one', () => {
    const upgraded: SchemaSnapshot = snap46;
    for (const part of [
      'columns',
      'constraints',
      'indexes',
      'triggers',
      'functions',
      'policies',
      'tables',
      'views',
    ] as const) {
      expect(snapFresh[part], part).toEqual(upgraded[part]);
    }
    const names46 = upTo46;
    expect(names46).toHaveLength(46);
  });

  it('the fresh 46-migration database recorded all 46 migrations as finished', async () => {
    const rows = await migRows(freshPool);
    expect(rows).toHaveLength(46);
    expect(rows.every((r) => r['finished_at'] !== null && r['rolled_back_at'] === null)).toBe(true);
  });

  it('the Prisma schema validates (prisma validate)', () => {
    const out = prisma(['validate'], pkgDir, upgradeUrl);
    expect(out).toMatch(/is valid/);
  });
});
