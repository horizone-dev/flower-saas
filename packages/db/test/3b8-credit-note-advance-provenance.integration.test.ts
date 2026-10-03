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
const PROVENANCE = '20261008120000_phase_3b8_credit_note_advance_release_provenance';
const FUNCTION = 'fn_check_credit_note_coverage_release_integrity()';

/** sha256 of migrations 44 / 45 / 46, recorded BEFORE migration 47 was written — all three are
 *  FROZEN: a recorded migration is never edited, so these never change */
const FROZEN_HASHES: Record<string, string> = {
  '20261005120000_phase_3b8_credit_refund_core':
    'f708a91c26886cd81da87c1b38a4c7680f701aa67f264af8bdb69c1d63fc319b',
  '20261006120000_phase_3b8_cancellation_charge_permission':
    'c3c6da7efb324a49730f8b91bb70d86df8282abf95eedf975cdd51fe00d9dceb',
  '20261007120000_phase_3b8_integration_closure':
    'f633235761bbb8065362000075c44e6fbb11ad342ca459cba7a7fc7d81134516',
};

/**
 * Task 3b.8 F3 — MIGRATION 47 (`20261008120000_phase_3b8_credit_note_advance_release_provenance`)
 * proven as a real UPGRADE.
 *
 * Cancelling an invoice whose coverage includes an application of a CREDIT_NOTE-sourced advance must
 * release that coverage again. The release table's frozen shape already represents it (ADVANCE_APPLICATION
 * with the ULTIMATE sourcePaymentId, or OPENING_ADVANCE with none); only the BEFORE INSERT trigger body
 * refused it. Migration 47 CREATE OR REPLACEs that ONE function — no table, column, index, CHECK, kind,
 * money field, policy or grant. This suite proves, with the REAL `prisma migrate deploy` against real
 * Postgres:
 *
 *   1. migrations 1..46 are applied first, DATA is seeded under that exact schema (first-generation
 *      releases of every kind) and the schema + behaviour are captured ("before");
 *   2. migration 47 is applied on top by a second `migrate deploy` (an UPGRADE of a populated database):
 *      exactly ONE migration is applied; the 46 earlier `_prisma_migrations` rows are bit-for-bit
 *      untouched; migrations 44 / 45 / 46 still hash to the values recorded before this pass;
 *   3. the schema diff 46 -> 47 is EXACTLY one function body — nothing else; every pre-existing rejection
 *      message of that function is still present;
 *   4. every pre-existing row survives byte-for-byte;
 *   5. behaviour for PAYMENT-sourced and OPENING-sourced advances and for PAYMENT_ALLOCATION is IDENTICAL
 *      before and after (same accept/reject, same message) while the intended delta — a CREDIT_NOTE-sourced
 *      underlying advance whose ultimate provenance is carried forward — flips from rejected to accepted;
 *   6. every invalid provenance is rejected (NULL / wrong / invented Payment, wrong kind for the chain,
 *      an unrelated or original allocation as false provenance, a missing funding release, malformed
 *      lineage) and a rejected release leaves NO partial row;
 *   7. a SECOND deploy is a no-op; a FRESH database built from the same 47 migrations has a schema
 *      identical to the upgraded one.
 *
 * The working directories are throwaway copies of the real migration files (the originals are never
 * written).
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

interface ReleaseSpec {
  sourceKind: 'PAYMENT_ALLOCATION' | 'ADVANCE_APPLICATION' | 'OPENING_ADVANCE';
  allocationId?: string | null;
  applicationId?: string | null;
  paymentId?: string | null;
}

interface IssueInput {
  ccaId: string;
  invoiceId: string;
  lineId: string;
  total: number;
  arReduction: number;
  advanceExcess: number;
  release: ReleaseSpec;
}

interface Issued {
  creditNoteId: string;
  advanceId: string;
  releaseId: string;
}

interface Attempt {
  outcome: Outcome;
  issued?: Issued;
  /** rows that exist after a REJECTED attempt but did not before it (must always be none) */
  partialRows: Record<string, number>;
}

const COUNTED = [
  'credit_note',
  'credit_note_line',
  'credit_note_coverage_release',
  'customer_advance',
] as const;

/** every table whose rows must survive the upgrade byte-for-byte */
const HISTORICAL = [
  'credit_note',
  'credit_note_line',
  'credit_note_coverage_release',
  'customer_advance',
  'customer_advance_application',
  'customer_receivable',
  'payment',
  'payment_allocation',
] as const;

async function rowCounts(p: pg.Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) {
    out[t] = Number((await p.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}

describe('packages/db — migration 47 (3b.8 F3): a real 46 -> 47 upgrade', () => {
  const names = migrationNames();
  const before47 = names.filter((n) => n < PROVENANCE);
  const upTo47 = names.filter((n) => n <= PROVENANCE);

  let upgradeC: StartedPostgreSqlContainer;
  let freshC: StartedPostgreSqlContainer;
  let upgradeUrl = '';
  let freshUrl = '';
  let pool: pg.Pool;
  let freshPool: pg.Pool;
  let upgradeDir = '';
  let freshDir = '';

  let snap46: SchemaSnapshot;
  let snap47: SchemaSnapshot;
  let snapFresh: SchemaSnapshot;
  let migRows46: Row[] = [];
  let migRows47: Row[] = [];
  let migRowsAfterSecond: Row[] = [];
  const historical46: Record<string, Row[]> = {};
  const historicalAfter: Record<string, Row[]> = {};
  let shared46: Record<string, Attempt> = {};
  let shared47: Record<string, Attempt> = {};
  let only47: Record<string, Attempt> = {};
  let facts47: Record<string, unknown> = {};
  let upgradeStdout = '';
  let secondDeployStdout = '';
  let statusStdout = '';

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
       VALUES ($1, 'mig47', 'mig47', 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
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
   *  database at migration 46 and again at migration 47 */
  function world(p: pg.Pool) {
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
        [orderId, `ORD-47-${(++seq).toString().padStart(6, '0')}`],
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

    const paymentAdvance = async (
      ccaId: string,
      paymentId: string,
      amountMinor: number,
    ): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
        [id, TENANT, COMPANY, BRANCH, ccaId, paymentId, amountMinor],
      );
      return id;
    };

    const openingAdvance = async (ccaId: string, amountMinor: number): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',$6,'AED',2,'2026-01-05')`,
        [id, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
      );
      return id;
    };

    /** a CREDIT_NOTE-sourced advance that NO release funded (raw-seeded orphan: malformed lineage) */
    const orphanCreditNoteAdvance = async (ccaId: string, amountMinor: number): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
        [id, TENANT, COMPANY, BRANCH, ccaId, amountMinor],
      );
      return id;
    };

    const apply = async (
      advanceId: string,
      receivableId: string,
      amountMinor: number,
    ): Promise<string> => {
      const id = uid();
      await p.query(
        `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
        [id, TENANT, COMPANY, BRANCH, advanceId, receivableId, amountMinor],
      );
      return id;
    };

    /** a FULL CreditNote (header + ONE line + the funded CREDIT_NOTE advance + ONE release) in ONE
     *  transaction (the completeness triggers are deferred to COMMIT). Throws on any rejection.
     *  With `within`, the statements run inside the CALLER's open transaction (no BEGIN / COMMIT /
     *  ROLLBACK here) — used to craft states the table CHECKs make unreachable, then roll them back. */
    const issue = async (a: IssueInput, within?: pg.PoolClient): Promise<Issued> => {
      const creditNoteId = uid();
      const advanceId = uid();
      const releaseId = uid();
      const c = within ?? (await p.connect());
      try {
        if (!within) await c.query('BEGIN');
        await c.query(
          `INSERT INTO credit_note
             (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate",
              "currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor",
              "totalAmountMinor","arReductionMinor","advanceExcessMinor")
           VALUES ($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,'AED',2,'CUSTOMER_REQUEST',$7,0,$7,$8,$9)`,
          [
            creditNoteId,
            TENANT,
            COMPANY,
            BRANCH,
            a.invoiceId,
            `CN-${creditNoteId.slice(0, 8)}`,
            a.total,
            a.arReduction,
            a.advanceExcess,
          ],
        );
        await c.query(
          `INSERT INTO credit_note_line
             (id,"tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor",
              "discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor",
              "taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'1.0000',$6,0,0,$6,0,$6,'AED',2)`,
          [uid(), TENANT, COMPANY, creditNoteId, a.lineId, a.total],
        );
        await c.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
          [advanceId, TENANT, COMPANY, BRANCH, a.ccaId, a.advanceExcess],
        );
        await c.query(
          `INSERT INTO credit_note_coverage_release
             (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId",
              "sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent",
              "customerAdvanceId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AED',2,$11)`,
          [
            releaseId,
            TENANT,
            COMPANY,
            BRANCH,
            creditNoteId,
            a.release.sourceKind,
            a.release.allocationId ?? null,
            a.release.applicationId ?? null,
            a.release.paymentId ?? null,
            a.advanceExcess,
            advanceId,
          ],
        );
        if (!within) await c.query('COMMIT');
        return { creditNoteId, advanceId, releaseId };
      } catch (err) {
        if (!within) await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        if (!within) c.release();
      }
    };

    /** one release attempt; a REJECTED one must leave no partial row anywhere */
    const tryIssue = async (a: IssueInput): Promise<Attempt> => {
      const before = await rowCounts(p);
      try {
        const issued = await issue(a);
        return { outcome: { accepted: true, message: '' }, issued, partialRows: {} };
      } catch (e) {
        const after = await rowCounts(p);
        const partialRows: Record<string, number> = {};
        for (const t of COUNTED)
          if (after[t] !== before[t]) partialRows[t] = after[t]! - before[t]!;
        return {
          outcome: {
            accepted: false,
            message: normalize(e instanceof Error ? e.message : String(e)),
          },
          partialRows,
        };
      }
    };

    // ── scenarios: an invoice B (2000) with 1000 of coverage by ONE application / allocation ──
    /** a PAYMENT-sourced advance (1000, from Payment P) applied (1000) to invoice B */
    const paymentAdvanceCase = async () => {
      const { ccaId, customerId } = await freshAccount();
      const paymentId = await receiptPayment(ccaId, 1000);
      const otherPaymentId = await receiptPayment(ccaId, 500);
      const advanceId = await paymentAdvance(ccaId, paymentId, 1000);
      const b = await invoiceOf(2000, customerId);
      const receivableId = await invoiceReceivable(ccaId, b.invoiceId);
      const applicationId = await apply(advanceId, receivableId, 1000);
      return { ccaId, paymentId, otherPaymentId, applicationId, ...b };
    };

    /** an OPENING advance (1000) applied (1000) to invoice B */
    const openingAdvanceCase = async () => {
      const { ccaId, customerId } = await freshAccount();
      const otherPaymentId = await receiptPayment(ccaId, 500);
      const advanceId = await openingAdvance(ccaId, 1000);
      const b = await invoiceOf(2000, customerId);
      const receivableId = await invoiceReceivable(ccaId, b.invoiceId);
      const applicationId = await apply(advanceId, receivableId, 1000);
      return { ccaId, otherPaymentId, applicationId, ...b };
    };

    /** invoice B (2000) with a Payment allocation of 1000, plus an UNRELATED invoice X's allocation */
    const allocationCase = async () => {
      const { ccaId, customerId } = await freshAccount();
      const b = await invoiceOf(2000, customerId);
      const alloc = await allocation(b.invoiceId, 1000);
      const x = await invoiceOf(2000, customerId);
      const foreign = await allocation(x.invoiceId, 1000);
      const otherPaymentId = await receiptPayment(ccaId, 500);
      return {
        ccaId,
        paymentId: alloc.paymentId,
        allocationId: alloc.allocationId,
        foreignAllocationId: foreign.allocationId,
        foreignPaymentId: foreign.paymentId,
        otherPaymentId,
        ...b,
      };
    };

    /** FIRST generation (valid under the 46 schema): invoice A paid 1000 by Payment P, cancelled ->
     *  CN advance A' (1000) released from P's allocation; then invoice B covered 1000 by A'. */
    const nestedPaymentCase = async () => {
      const { ccaId, customerId } = await freshAccount();
      const a = await invoiceOf(2000, customerId);
      const alloc = await allocation(a.invoiceId, 1000);
      const first = await issue({
        ccaId,
        invoiceId: a.invoiceId,
        lineId: a.lineId,
        total: 2000,
        arReduction: 1000,
        advanceExcess: 1000,
        release: {
          sourceKind: 'PAYMENT_ALLOCATION',
          allocationId: alloc.allocationId,
          paymentId: alloc.paymentId,
        },
      });
      const otherPaymentId = await receiptPayment(ccaId, 500);
      const b = await invoiceOf(2000, customerId);
      const receivableId = await invoiceReceivable(ccaId, b.invoiceId);
      const applicationId = await apply(first.advanceId, receivableId, 1000);
      return {
        ccaId,
        customerId,
        ultimatePaymentId: alloc.paymentId,
        originalAllocationId: alloc.allocationId,
        fundingAdvanceId: first.advanceId,
        fundingReleaseId: first.releaseId,
        otherPaymentId,
        applicationId,
        ...b,
      };
    };

    /** FIRST generation (valid under the 46 schema): an OPENING advance 1000 applied to invoice A,
     *  A cancelled -> CN advance A' (OPENING_ADVANCE release, no Payment); invoice B covered by A'. */
    const nestedOpeningCase = async () => {
      const { ccaId, customerId } = await freshAccount();
      const openingId = await openingAdvance(ccaId, 1000);
      const a = await invoiceOf(2000, customerId);
      const recvA = await invoiceReceivable(ccaId, a.invoiceId);
      const appA = await apply(openingId, recvA, 1000);
      const first = await issue({
        ccaId,
        invoiceId: a.invoiceId,
        lineId: a.lineId,
        total: 2000,
        arReduction: 1000,
        advanceExcess: 1000,
        release: { sourceKind: 'OPENING_ADVANCE', applicationId: appA, paymentId: null },
      });
      const otherPaymentId = await receiptPayment(ccaId, 500);
      const b = await invoiceOf(2000, customerId);
      const receivableId = await invoiceReceivable(ccaId, b.invoiceId);
      const applicationId = await apply(first.advanceId, receivableId, 1000);
      return {
        ccaId,
        customerId,
        fundingAdvanceId: first.advanceId,
        fundingReleaseId: first.releaseId,
        otherPaymentId,
        applicationId,
        ...b,
      };
    };

    /** a CREDIT_NOTE advance with NO funding release, applied (1000) to invoice B */
    const orphanCase = async () => {
      const { ccaId, customerId } = await freshAccount();
      const otherPaymentId = await receiptPayment(ccaId, 500);
      const advanceId = await orphanCreditNoteAdvance(ccaId, 1000);
      const b = await invoiceOf(2000, customerId);
      const receivableId = await invoiceReceivable(ccaId, b.invoiceId);
      const applicationId = await apply(advanceId, receivableId, 1000);
      return { ccaId, otherPaymentId, applicationId, ...b };
    };

    /** the INVOICE-B side of every release attempt: 1000 covered, so a 1000 AR reduction + 1000 released */
    const cnB = (c: { ccaId: string; invoiceId: string; lineId: string }, release: ReleaseSpec) =>
      ({
        ccaId: c.ccaId,
        invoiceId: c.invoiceId,
        lineId: c.lineId,
        total: 2000,
        arReduction: 1000,
        advanceExcess: 1000,
        release,
      }) satisfies IssueInput;

    const rowsOf = async (table: string, ids: string[]): Promise<Row[]> =>
      (await p.query(`SELECT * FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]))
        .rows as Row[];

    return {
      freshAccount,
      invoiceOf,
      invoiceReceivable,
      receiptPayment,
      allocation,
      apply,
      issue,
      tryIssue,
      paymentAdvanceCase,
      openingAdvanceCase,
      allocationCase,
      nestedPaymentCase,
      nestedOpeningCase,
      orphanCase,
      cnB,
      rowsOf,
    };
  }

  /** the behaviour matrix common to BOTH schemas, replayed verbatim at migration 46 and at 47 */
  async function sharedMatrix(p: pg.Pool): Promise<Record<string, Attempt>> {
    const w = world(p);
    const out: Record<string, Attempt> = {};

    // ── PRESERVED: a PAYMENT-sourced underlying advance ───────────────────────────────────────
    {
      const c = await w.paymentAdvanceCase();
      const rel = (paymentId: string | null) =>
        w.cnB(c, { sourceKind: 'ADVANCE_APPLICATION', applicationId: c.applicationId, paymentId });
      out['P2 payment advance: ADVANCE_APPLICATION with a WRONG payment'] = await w.tryIssue(
        rel(c.otherPaymentId),
      );
      out['P3 payment advance: ADVANCE_APPLICATION with a NULL payment'] = await w.tryIssue(
        rel(null),
      );
      out['P4 payment advance: OPENING_ADVANCE kind'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: null,
        }),
      );
      out['P11 payment advance: a release larger than the application'] = await w.tryIssue({
        ...rel(c.paymentId),
        arReduction: 500,
        advanceExcess: 1500,
      });
      out['P1 payment advance: ADVANCE_APPLICATION with its own payment'] = await w.tryIssue(
        rel(c.paymentId),
      );
    }
    // ── PRESERVED: an OPENING-sourced underlying advance ──────────────────────────────────────
    {
      const c = await w.openingAdvanceCase();
      out['P6 opening advance: OPENING_ADVANCE with a payment'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: c.otherPaymentId,
        }),
      );
      out['P7 opening advance: ADVANCE_APPLICATION kind'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: c.applicationId,
          paymentId: c.otherPaymentId,
        }),
      );
      out['P5 opening advance: OPENING_ADVANCE with no payment'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: null,
        }),
      );
    }
    // ── PRESERVED: a direct PAYMENT_ALLOCATION source ─────────────────────────────────────────
    {
      const c = await w.allocationCase();
      out['P9 allocation: a WRONG payment'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'PAYMENT_ALLOCATION',
          allocationId: c.allocationId,
          paymentId: c.otherPaymentId,
        }),
      );
      out["P10 allocation: ANOTHER invoice's allocation as false provenance"] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'PAYMENT_ALLOCATION',
          allocationId: c.foreignAllocationId,
          paymentId: c.foreignPaymentId,
        }),
      );
      out['P8 allocation: its own allocation and payment'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'PAYMENT_ALLOCATION',
          allocationId: c.allocationId,
          paymentId: c.paymentId,
        }),
      );
    }

    // ── INTENDED DELTA: the underlying advance is CREDIT_NOTE-sourced (funded by an earlier release) ──
    {
      const c = await w.nestedPaymentCase();
      const watched = {
        releases: await w.rowsOf('credit_note_coverage_release', [c.fundingReleaseId]),
        advances: await w.rowsOf('customer_advance', [c.fundingAdvanceId]),
        applications: await w.rowsOf('customer_advance_application', [c.applicationId]),
        allocations: await w.rowsOf('payment_allocation', [c.originalAllocationId]),
      };
      const attempt = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: c.applicationId,
          paymentId: c.ultimatePaymentId,
        }),
      );
      out['D1 nested payment chain: ADVANCE_APPLICATION with the ULTIMATE payment'] = attempt;
      if (attempt.issued) {
        facts47['D1'] = {
          c,
          issued: attempt.issued,
          // the historical facts the nested release is built on are untouched by it
          unchanged:
            JSON.stringify(watched) ===
            JSON.stringify({
              releases: await w.rowsOf('credit_note_coverage_release', [c.fundingReleaseId]),
              advances: await w.rowsOf('customer_advance', [c.fundingAdvanceId]),
              applications: await w.rowsOf('customer_advance_application', [c.applicationId]),
              allocations: await w.rowsOf('payment_allocation', [c.originalAllocationId]),
            }),
        };
      }
    }
    {
      const c = await w.nestedOpeningCase();
      out['D2 nested opening chain: OPENING_ADVANCE with no payment'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: null,
        }),
      );
    }
    return out;
  }

  /** migration-47-only matrix: invalid provenance on a CREDIT_NOTE-sourced underlying advance, and a
   *  depth-2 chain (no unbounded recursion: only the DIRECT funding release is read) */
  async function matrix47(p: pg.Pool): Promise<Record<string, Attempt>> {
    const w = world(p);
    const out: Record<string, Attempt> = {};

    // ── invalid provenance on a PAYMENT-traced nested chain ───────────────────────────────────
    {
      const c = await w.nestedPaymentCase();
      const app = (paymentId: string | null) =>
        w.cnB(c, { sourceKind: 'ADVANCE_APPLICATION', applicationId: c.applicationId, paymentId });
      out['I1 payment chain: NULL sourcePaymentId'] = await w.tryIssue(app(null));
      out['I2 payment chain: a WRONG (real) Payment id'] = await w.tryIssue(app(c.otherPaymentId));
      out['I3 payment chain: an INVENTED Payment id'] = await w.tryIssue(app(uid()));
      out['I4 payment chain: OPENING_ADVANCE kind'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: null,
        }),
      );
      out['I7 payment chain: the ORIGINAL allocation of invoice A as a shortcut'] =
        await w.tryIssue(
          w.cnB(c, {
            sourceKind: 'PAYMENT_ALLOCATION',
            allocationId: c.originalAllocationId,
            paymentId: c.ultimatePaymentId,
          }),
        );
    }
    // ── invalid provenance on an OPENING-traced nested chain ──────────────────────────────────
    {
      const c = await w.nestedOpeningCase();
      out['I5 opening chain: ADVANCE_APPLICATION kind with a (real) payment'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: c.applicationId,
          paymentId: c.otherPaymentId,
        }),
      );
      out['I6 opening chain: OPENING_ADVANCE with a payment'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: c.otherPaymentId,
        }),
      );
    }
    // ── malformed lineage: a CREDIT_NOTE advance that no release funded ───────────────────────
    {
      const c = await w.orphanCase();
      out['I8 orphan CREDIT_NOTE advance: ADVANCE_APPLICATION'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: c.applicationId,
          paymentId: c.otherPaymentId,
        }),
      );
      out['I9 orphan CREDIT_NOTE advance: OPENING_ADVANCE'] = await w.tryIssue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: null,
        }),
      );
    }
    // ── depth 2, payment-traced: A -> A' -> A'' -> A''' ───────────────────────────────────────
    {
      const c = await w.nestedPaymentCase();
      const second = await w.issue(
        w.cnB(c, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: c.applicationId,
          paymentId: c.ultimatePaymentId,
        }),
      );
      // invoice C covered by A'' (itself a CREDIT_NOTE advance of a CREDIT_NOTE advance)
      const cc = await w.invoiceOf(2000, c.customerId);
      const recvC = await w.invoiceReceivable(c.ccaId, cc.invoiceId);
      const appC = await w.apply(second.advanceId, recvC, 1000);
      const target = { ccaId: c.ccaId, invoiceId: cc.invoiceId, lineId: cc.lineId };
      out['I10 depth-2 payment chain: a WRONG payment'] = await w.tryIssue(
        w.cnB(target, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: appC,
          paymentId: c.otherPaymentId,
        }),
      );
      out['I11 depth-2 payment chain: the payment of the FIRST generation only is not a shortcut'] =
        await w.tryIssue(
          w.cnB(target, {
            sourceKind: 'PAYMENT_ALLOCATION',
            allocationId: c.originalAllocationId,
            paymentId: c.ultimatePaymentId,
          }),
        );
      const third = await w.tryIssue(
        w.cnB(target, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: appC,
          paymentId: c.ultimatePaymentId,
        }),
      );
      out['D3 depth-2 payment chain: the SAME ultimate payment carried forward'] = third;
      facts47['D3'] = { c, second, third: third.issued };
    }
    // ── depth 2, opening-traced ───────────────────────────────────────────────────────────────
    {
      const c = await w.nestedOpeningCase();
      const second = await w.issue(
        w.cnB(c, {
          sourceKind: 'OPENING_ADVANCE',
          applicationId: c.applicationId,
          paymentId: null,
        }),
      );
      const cc = await w.invoiceOf(2000, c.customerId);
      const recvC = await w.invoiceReceivable(c.ccaId, cc.invoiceId);
      const appC = await w.apply(second.advanceId, recvC, 1000);
      const target = { ccaId: c.ccaId, invoiceId: cc.invoiceId, lineId: cc.lineId };
      out['I12 depth-2 opening chain: ADVANCE_APPLICATION kind with a payment'] = await w.tryIssue(
        w.cnB(target, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: appC,
          paymentId: c.otherPaymentId,
        }),
      );
      out['D4 depth-2 opening chain: OPENING_ADVANCE with no payment'] = await w.tryIssue(
        w.cnB(target, { sourceKind: 'OPENING_ADVANCE', applicationId: appC, paymentId: null }),
      );
    }
    return out;
  }

  beforeAll(async () => {
    expect(before47, 'the 46 migrations that precede migration 47').toHaveLength(46);
    expect(names).toContain(PROVENANCE);

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

    // ── A: the UPGRADE database — migrations 1..46 first ───────────────────────────────────
    upgradeDir = makeWorkDir('mig46', before47);
    prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    await baseFixture(pool);
    migRows46 = await migRows(pool);
    snap46 = await snapshot(pool);

    // data created UNDER MIGRATION 46's schema (every first-generation release kind is inside the
    // shared matrix) — it must survive the upgrade untouched
    shared46 = await sharedMatrix(pool);
    for (const t of HISTORICAL) {
      historical46[t] = (await pool.query(`SELECT * FROM ${t} ORDER BY id`)).rows as Row[];
    }
    facts47 = {}; // D1's facts from the 46 run (it is rejected there, so none are recorded anyway)

    // ── migration 47 applied on top — a real UPGRADE of the populated DB ─────────────────────
    addMigration(upgradeDir, PROVENANCE);
    upgradeStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRows47 = await migRows(pool);
    snap47 = await snapshot(pool);
    for (const t of HISTORICAL) {
      const ids = historical46[t]!.map((r) => r['id']);
      historicalAfter[t] = (
        await pool.query(`SELECT * FROM ${t} WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids])
      ).rows as Row[];
    }
    shared47 = await sharedMatrix(pool);
    only47 = await matrix47(pool);

    // ── second deploy: must be a no-op ──────────────────────────────────────────────────────
    secondDeployStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRowsAfterSecond = await migRows(pool);
    statusStdout = prisma(['migrate', 'status'], upgradeDir, upgradeUrl);

    // ── B: a FRESH database from the same 47 migrations ──────────────────────────────────────
    freshDir = makeWorkDir('fresh47', upTo47);
    prisma(['migrate', 'deploy'], freshDir, freshUrl);
    snapFresh = await snapshot(freshPool);
  }, 900_000);

  afterAll(async () => {
    await pool?.end();
    await freshPool?.end();
    await upgradeC?.stop();
    await freshC?.stop();
    for (const d of [upgradeDir, freshDir]) {
      try {
        if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch {
        // best-effort: a Windows handle on a throwaway Prisma work dir must never fail the suite
      }
    }
  }, 120_000);

  const messageOf = (a: Attempt | undefined): string => a?.outcome.message ?? '<no attempt>';

  // ══════ 1. bookkeeping: exactly ONE migration applied, the 46 before it untouched ══════
  it('applies exactly ONE migration on top of 46 — migration 47 — and no other', () => {
    const applying = [...upgradeStdout.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]);
    expect(applying).toEqual([PROVENANCE]);
    expect(migRows46).toHaveLength(46);
    expect(migRows47).toHaveLength(47);
  });

  it('the 46 earlier _prisma_migrations rows are bit-for-bit untouched by the upgrade (id, checksum, timestamps, steps, logs)', () => {
    const earlier = migRows47.filter((r) => r['migration_name'] !== PROVENANCE);
    expect(earlier).toEqual(migRows46);
  });

  it('migration 47 is recorded finished, with the checksum of its own file', () => {
    const row = migRows47.find((r) => r['migration_name'] === PROVENANCE)!;
    expect(row['finished_at']).not.toBeNull();
    expect(row['rolled_back_at']).toBeNull();
    expect(row['applied_steps_count']).toBe(1);
    expect(row['checksum']).toBe(sha256(path.join(MIGRATIONS_DIR, PROVENANCE, 'migration.sql')));
  });

  it('every recorded checksum equals the checksum of the migration file on disk (no recorded migration was edited)', () => {
    for (const r of migRows47) {
      const file = path.join(MIGRATIONS_DIR, String(r['migration_name']), 'migration.sql');
      expect(r['checksum'], String(r['migration_name'])).toBe(sha256(file));
    }
  });

  it('migrations 44, 45 and 46 still hash to the values recorded BEFORE migration 47 was written (all three are frozen)', () => {
    for (const [name, hash] of Object.entries(FROZEN_HASHES)) {
      expect(sha256(path.join(MIGRATIONS_DIR, name, 'migration.sql')), name).toBe(hash);
      expect(migRows47.find((r) => r['migration_name'] === name)!['checksum'], name).toBe(hash);
    }
  });

  // ══════ 2. the schema diff 46 -> 47 is EXACTLY one function body ══════
  it('replaces exactly ONE function (CREATE OR REPLACE — none added, none dropped): the release-integrity trigger function', () => {
    const d = diff(snap46.functions, snap47.functions, (r) => String(r['fn']));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([FUNCTION]);
  });

  it('redesigns NO table, column, index, CHECK / FK / UNIQUE, trigger binding, policy, grant, RLS flag or view — so no new kind, provenance column, money field or permission', () => {
    const key =
      (...f: string[]) =>
      (r: Row) =>
        f.map((k) => String(r[k])).join('.');
    for (const [label, before, after, k] of [
      ['columns', snap46.columns, snap47.columns, key('table_name', 'column_name')],
      ['constraints', snap46.constraints, snap47.constraints, key('tbl', 'conname')],
      ['indexes', snap46.indexes, snap47.indexes, key('tablename', 'indexname')],
      ['triggers', snap46.triggers, snap47.triggers, key('tbl', 'tgname')],
      ['policies', snap46.policies, snap47.policies, key('tablename', 'policyname')],
      ['tables', snap46.tables, snap47.tables, key('relname')],
      ['views', snap46.views, snap47.views, key('viewname')],
    ] as const) {
      expect(diff(before, after, k), label).toEqual({ added: [], removed: [], changed: [] });
    }
  });

  it('keeps EVERY pre-existing rejection message of the function verbatim, and adds the CREDIT_NOTE-provenance rule', () => {
    const def = (s: SchemaSnapshot): string =>
      String(s.functions.find((r) => r['fn'] === FUNCTION)!['def']);
    const raised = (src: string): string[] =>
      [...src.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'/g)].map((m) => m[1]!);
    const before = raised(def(snap46));
    const after = def(snap47);
    expect(before).toHaveLength(21); // every RAISE EXCEPTION of the migration-44/46 function
    for (const message of before) expect(after, message).toContain(message);
    expect(after).toContain("underlying_source_type = 'CREDIT_NOTE'");
    expect(raised(after).length).toBeGreaterThan(before.length);
  });

  // ══════ 3. historical data survives ══════
  it('every row created under migration 46 (releases of every first-generation kind included) survives the upgrade byte-for-byte', () => {
    // P1 + P5 + P8 (one accepted release per first-generation kind) + the two first-generation
    // releases the nested chains are built on
    expect(historical46['credit_note_coverage_release']).toHaveLength(5);
    for (const t of HISTORICAL) {
      expect(historicalAfter[t], t).toEqual(historical46[t]);
    }
  });

  // ══════ 4. behaviour: PAYMENT / OPENING / PAYMENT_ALLOCATION preserved; the designed delta flips ══════
  it('PAYMENT-sourced, OPENING-sourced and PAYMENT_ALLOCATION behaviour is IDENTICAL before and after (same accept/reject, same message)', () => {
    const preserved = Object.keys(shared46).filter((k) => k.startsWith('P'));
    expect(preserved).toHaveLength(11);
    for (const k of preserved) {
      expect(shared47[k]!.outcome, k).toEqual(shared46[k]!.outcome);
    }
    // and the preserved behaviour is the intended one, not merely "the same"
    for (const k of [
      'P1 payment advance: ADVANCE_APPLICATION with its own payment',
      'P5 opening advance: OPENING_ADVANCE with no payment',
      'P8 allocation: its own allocation and payment',
    ]) {
      expect(shared47[k]!.outcome.accepted, k).toBe(true);
    }
    expect(
      messageOf(shared47['P2 payment advance: ADVANCE_APPLICATION with a WRONG payment']),
    ).toMatch(
      /sourcePaymentId does not match the underlying PAYMENT-sourced customer_advance's own sourcePaymentId/,
    );
    expect(
      messageOf(shared47['P3 payment advance: ADVANCE_APPLICATION with a NULL payment']),
    ).toMatch(
      /sourcePaymentId does not match the underlying PAYMENT-sourced customer_advance's own sourcePaymentId/,
    );
    expect(messageOf(shared47['P4 payment advance: OPENING_ADVANCE kind'])).toMatch(
      /sourceKind=OPENING_ADVANCE requires the underlying customer_advance to be sourceType=OPENING \(got PAYMENT\)/,
    );
    expect(messageOf(shared47['P6 opening advance: OPENING_ADVANCE with a payment'])).toMatch(
      /sourcePaymentId must be NULL — underlying customer_advance is OPENING-sourced/,
    );
    expect(messageOf(shared47['P7 opening advance: ADVANCE_APPLICATION kind'])).toMatch(
      /sourceKind=ADVANCE_APPLICATION requires the underlying customer_advance to be sourceType=PAYMENT \(got OPENING\)/,
    );
    expect(messageOf(shared47['P9 allocation: a WRONG payment'])).toMatch(
      /sourcePaymentId does not match payment_allocation <id>'s own paymentId/,
    );
    expect(
      messageOf(shared47["P10 allocation: ANOTHER invoice's allocation as false provenance"]),
    ).toMatch(
      /payment_allocation <id>'s own invoiceId does not match credit_note <id>'s own invoiceId/,
    );
    expect(
      messageOf(shared47['P11 payment advance: a release larger than the application']),
    ).toMatch(
      /cumulative release 1500 exceeds customer_advance_application <id>'s own amountMinor 1000/,
    );
  });

  it('the INTENDED delta flips exactly as designed: a nested release of a CREDIT_NOTE-sourced advance is REJECTED under 46 and ACCEPTED under 47', () => {
    for (const k of [
      'D1 nested payment chain: ADVANCE_APPLICATION with the ULTIMATE payment',
      'D2 nested opening chain: OPENING_ADVANCE with no payment',
    ]) {
      expect(shared46[k]!.outcome.accepted, `${k} @46`).toBe(false);
      expect(shared47[k]!.outcome, `${k} @47`).toEqual({ accepted: true, message: '' });
    }
    expect(
      messageOf(shared46['D1 nested payment chain: ADVANCE_APPLICATION with the ULTIMATE payment']),
    ).toMatch(
      /sourceKind=ADVANCE_APPLICATION requires the underlying customer_advance to be sourceType=PAYMENT \(got CREDIT_NOTE\)/,
    );
    expect(messageOf(shared46['D2 nested opening chain: OPENING_ADVANCE with no payment'])).toMatch(
      /sourceKind=OPENING_ADVANCE requires the underlying customer_advance to be sourceType=OPENING \(got CREDIT_NOTE\)/,
    );
  });

  it('an accepted nested release persists the ULTIMATE provenance exactly — one release, one new CREDIT_NOTE advance (1:1), the consumed funding rows untouched', async () => {
    const d1 = facts47['D1'] as {
      c: {
        ultimatePaymentId: string;
        applicationId: string;
        fundingAdvanceId: string;
        fundingReleaseId: string;
      };
      issued: Issued;
      unchanged: boolean;
    };
    expect(d1, 'D1 was accepted under 47').toBeDefined();
    const release = (
      await pool.query(`SELECT * FROM credit_note_coverage_release WHERE id = $1`, [
        d1.issued.releaseId,
      ])
    ).rows[0];
    expect(release).toMatchObject({
      sourceKind: 'ADVANCE_APPLICATION',
      sourcePaymentId: d1.c.ultimatePaymentId, // carried forward from the funding release
      sourcePaymentAllocationId: null,
      sourceAdvanceApplicationId: d1.c.applicationId,
      customerAdvanceId: d1.issued.advanceId,
      creditNoteId: d1.issued.creditNoteId,
    });
    expect(String(release.releasedAmountMinor)).toBe('1000');
    // the new advance is a plain CREDIT_NOTE advance of exactly the released amount — no Payment of its own
    const advance = (
      await pool.query(`SELECT * FROM customer_advance WHERE id = $1`, [d1.issued.advanceId])
    ).rows[0];
    expect(advance).toMatchObject({ sourceType: 'CREDIT_NOTE', sourcePaymentId: null });
    expect(String(advance.amountMinor)).toBe('1000');
    // exactly ONE funding release per CREDIT_NOTE advance — the consumed one still has exactly one
    for (const id of [d1.c.fundingAdvanceId, d1.issued.advanceId]) {
      const n = await pool.query(
        `SELECT count(*)::int AS n FROM credit_note_coverage_release WHERE "customerAdvanceId" = $1`,
        [id],
      );
      expect(n.rows[0].n, id).toBe(1);
    }
    // the historical facts the release is built on (funding release, its advance, the application,
    // the original allocation) are exactly as they were
    expect(d1.unchanged).toBe(true);
  });

  // ══════ 5. invalid provenance is rejected, and nothing partial survives ══════
  it('every invalid provenance is REJECTED with a precise reason', () => {
    const expectRejected = (key: string, reason: RegExp): void => {
      const a = only47[key];
      expect(a, key).toBeDefined();
      expect(a!.outcome.accepted, key).toBe(false);
      expect(a!.outcome.message, key).toMatch(reason);
    };
    const ultimate =
      /sourcePaymentId does not match the ultimate Payment provenance carried by the funding release of the underlying CREDIT_NOTE customer_advance/;
    expectRejected('I1 payment chain: NULL sourcePaymentId', ultimate);
    expectRejected('I2 payment chain: a WRONG (real) Payment id', ultimate);
    expectRejected('I3 payment chain: an INVENTED Payment id', ultimate);
    expectRejected(
      'I4 payment chain: OPENING_ADVANCE kind',
      /sourceKind=OPENING_ADVANCE requires the underlying CREDIT_NOTE customer_advance <id> to be ultimately funded from an OPENING advance \(it is Payment-traced\)/,
    );
    expectRejected(
      'I5 opening chain: ADVANCE_APPLICATION kind with a (real) payment',
      /sourceKind=ADVANCE_APPLICATION requires a Payment-traced provenance, but the underlying CREDIT_NOTE customer_advance <id> was ultimately funded from an OPENING advance \(use OPENING_ADVANCE\)/,
    );
    expectRejected(
      'I6 opening chain: OPENING_ADVANCE with a payment',
      /sourcePaymentId must be NULL — the underlying CREDIT_NOTE customer_advance is ultimately OPENING-funded/,
    );
    expectRejected(
      'I7 payment chain: the ORIGINAL allocation of invoice A as a shortcut',
      /payment_allocation <id>'s own invoiceId does not match credit_note <id>'s own invoiceId/,
    );
    const orphan =
      /underlying CREDIT_NOTE customer_advance <id> has 0 funding credit_note_coverage_release rows \(expected exactly 1\) — its provenance cannot be derived/;
    expectRejected('I8 orphan CREDIT_NOTE advance: ADVANCE_APPLICATION', orphan);
    expectRejected('I9 orphan CREDIT_NOTE advance: OPENING_ADVANCE', orphan);
    expectRejected('I10 depth-2 payment chain: a WRONG payment', ultimate);
    expectRejected(
      'I11 depth-2 payment chain: the payment of the FIRST generation only is not a shortcut',
      /payment_allocation <id>'s own invoiceId does not match credit_note <id>'s own invoiceId/,
    );
    expectRejected(
      'I12 depth-2 opening chain: ADVANCE_APPLICATION kind with a payment',
      /sourceKind=ADVANCE_APPLICATION requires a Payment-traced provenance/,
    );
  });

  it('a rejected release leaves NO partial row — no credit note, line, release or advance — in ANY attempt, before or after the migration', () => {
    const all: [string, Attempt][] = [
      ...Object.entries(shared46).map(([k, a]) => [`@46 ${k}`, a] as [string, Attempt]),
      ...Object.entries(shared47).map(([k, a]) => [`@47 ${k}`, a] as [string, Attempt]),
      ...Object.entries(only47).map(([k, a]) => [`@47 ${k}`, a] as [string, Attempt]),
    ];
    const rejected = all.filter(([, a]) => !a.outcome.accepted);
    expect(rejected.length).toBeGreaterThanOrEqual(30);
    for (const [k, a] of rejected) expect(a.partialRows, k).toEqual({});
  });

  it('a depth-2 chain is accepted and carries the SAME ultimate payment forward unchanged (only the direct funding release is read — no unbounded recursion, no flattening)', async () => {
    expect(
      only47['D3 depth-2 payment chain: the SAME ultimate payment carried forward']!.outcome,
    ).toEqual({
      accepted: true,
      message: '',
    });
    expect(only47['D4 depth-2 opening chain: OPENING_ADVANCE with no payment']!.outcome).toEqual({
      accepted: true,
      message: '',
    });
    const d3 = facts47['D3'] as {
      c: { ultimatePaymentId: string; fundingReleaseId: string };
      second: Issued;
      third: Issued;
    };
    const releases = (
      await pool.query(
        `SELECT id, "sourceKind", "sourcePaymentId" FROM credit_note_coverage_release WHERE id = ANY($1::uuid[]) ORDER BY "createdAt", id`,
        [[d3.c.fundingReleaseId, d3.second.releaseId, d3.third.releaseId]],
      )
    ).rows;
    expect(releases.map((r) => r.sourceKind)).toEqual([
      'PAYMENT_ALLOCATION',
      'ADVANCE_APPLICATION',
      'ADVANCE_APPLICATION',
    ]);
    // generation 1, 2 and 3 all reference the ONE ultimate Payment
    expect(new Set(releases.map((r) => r.sourcePaymentId))).toEqual(
      new Set([d3.c.ultimatePaymentId]),
    );
    expect(new Set([d3.second.advanceId, d3.third.advanceId]).size).toBe(2);
  });

  it('fails closed on an INCONSISTENT funding release — states the table CHECKs make unreachable are crafted inside a ROLLED-BACK transaction, so nothing persists', async () => {
    const w = world(pool);
    const checks = async (): Promise<number> =>
      Number(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM pg_constraint
              WHERE conrelid = 'credit_note_coverage_release'::regclass AND contype = 'c'`,
          )
        ).rows[0].n,
      );
    const noUpdateTrigger = async (): Promise<string> =>
      String(
        (
          await pool.query(
            `SELECT tgenabled::text AS e FROM pg_trigger
              WHERE tgname = 'trg_enforce_credit_note_coverage_release_no_update'`,
          )
        ).rows[0].e,
      );
    const checksBefore = await checks();
    expect(checksBefore).toBeGreaterThan(0);
    const triggerBefore = await noUpdateTrigger();

    /** in ONE transaction: drop the table's CHECKs, switch off ONLY the immutability trigger, corrupt the
     *  funding release, then try the nested release — and ALWAYS roll everything back */
    const craft = async (
      corrupt: string,
      params: unknown[],
      attemptInput: IssueInput,
    ): Promise<Outcome> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `ALTER TABLE credit_note_coverage_release DISABLE TRIGGER trg_enforce_credit_note_coverage_release_no_update`,
        );
        await client.query(`DO $$
          DECLARE c record;
          BEGIN
            FOR c IN SELECT conname FROM pg_constraint
                      WHERE conrelid = 'credit_note_coverage_release'::regclass AND contype = 'c'
            LOOP
              EXECUTE format('ALTER TABLE credit_note_coverage_release DROP CONSTRAINT %I', c.conname);
            END LOOP;
          END $$`);
        await client.query(corrupt, params);
        try {
          await w.issue(attemptInput, client);
          return { accepted: true, message: '' };
        } catch (e) {
          return {
            accepted: false,
            message: normalize(e instanceof Error ? e.message : String(e)),
          };
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };

    const pay = await w.nestedPaymentCase();
    const open = await w.nestedOpeningCase();
    const pay2 = await w.nestedPaymentCase();
    const fundingBefore = JSON.stringify([
      await w.rowsOf('credit_note_coverage_release', [
        pay.fundingReleaseId,
        open.fundingReleaseId,
        pay2.fundingReleaseId,
      ]),
    ]);

    // a payment-traced funding release WITHOUT its Payment
    const withoutPayment = await craft(
      `UPDATE credit_note_coverage_release SET "sourcePaymentId" = NULL WHERE id = $1`,
      [pay.fundingReleaseId],
      w.cnB(pay, {
        sourceKind: 'ADVANCE_APPLICATION',
        applicationId: pay.applicationId,
        paymentId: pay.ultimatePaymentId,
      }),
    );
    expect(withoutPayment.accepted).toBe(false);
    expect(withoutPayment.message).toMatch(
      /the funding release of underlying CREDIT_NOTE customer_advance <id> is inconsistent \(PAYMENT_ALLOCATION without a sourcePaymentId\)/,
    );

    // an OPENING_ADVANCE funding release WITH a Payment
    const openingWithPayment = await craft(
      `UPDATE credit_note_coverage_release SET "sourcePaymentId" = $2 WHERE id = $1`,
      [open.fundingReleaseId, open.otherPaymentId],
      w.cnB(open, {
        sourceKind: 'OPENING_ADVANCE',
        applicationId: open.applicationId,
        paymentId: null,
      }),
    );
    expect(openingWithPayment.accepted).toBe(false);
    expect(openingWithPayment.message).toMatch(
      /the funding release of underlying CREDIT_NOTE customer_advance <id> is inconsistent \(OPENING_ADVANCE with a sourcePaymentId\)/,
    );

    // a funding release of an unrecognized kind
    const unrecognized = await craft(
      `UPDATE credit_note_coverage_release SET "sourceKind" = 'SOMETHING_ELSE' WHERE id = $1`,
      [pay2.fundingReleaseId],
      w.cnB(pay2, {
        sourceKind: 'ADVANCE_APPLICATION',
        applicationId: pay2.applicationId,
        paymentId: pay2.ultimatePaymentId,
      }),
    );
    expect(unrecognized.accepted).toBe(false);
    expect(unrecognized.message).toMatch(
      /the funding release of underlying CREDIT_NOTE customer_advance <id> has an unrecognized sourceKind \(SOMETHING_ELSE\)/,
    );

    // the rolled-back transactions left NOTHING behind: funding rows, CHECKs and the trigger as they were
    expect(
      JSON.stringify([
        await w.rowsOf('credit_note_coverage_release', [
          pay.fundingReleaseId,
          open.fundingReleaseId,
          pay2.fundingReleaseId,
        ]),
      ]),
    ).toBe(fundingBefore);
    expect(await checks()).toBe(checksBefore);
    expect(await noUpdateTrigger()).toBe(triggerBefore);
    // and an honest nested release over those very chains is still accepted
    await expect(
      w.issue(
        w.cnB(pay, {
          sourceKind: 'ADVANCE_APPLICATION',
          applicationId: pay.applicationId,
          paymentId: pay.ultimatePaymentId,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('no double cash-out across a nested chain: however many generations carried the value, refunds against the ONE original Payment never exceed its amount (the unchanged capacity backstops)', async () => {
    const d3 = facts47['D3'] as {
      c: { ultimatePaymentId: string; fundingAdvanceId: string };
      second: Issued;
      third: Issued;
    };
    const refund = async (advanceId: string, amountMinor: number): Promise<Outcome> => {
      const refundId = uid();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
           VALUES ($1,$2,$3,$4,$5,$6,'AED',2,'BANK_TRANSFER','CUSTOMER_REQUEST',CURRENT_DATE)`,
          [refundId, TENANT, COMPANY, BRANCH, d3.c.ultimatePaymentId, amountMinor],
        );
        await client.query(
          `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
          [uid(), TENANT, COMPANY, BRANCH, advanceId, refundId, amountMinor],
        );
        await client.query('COMMIT');
        return { accepted: true, message: '' };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        return { accepted: false, message: normalize(e instanceof Error ? e.message : String(e)) };
      } finally {
        client.release();
      }
    };

    // the first two generations were fully drawn by their (immutable) applications: nothing left to cash out
    for (const consumed of [d3.c.fundingAdvanceId, d3.second.advanceId]) {
      const r = await refund(consumed, 1);
      expect(r.accepted, consumed).toBe(false);
      expect(r.message).toMatch(
        /customer_advance <id>: application would exceed amountMinor \(principal=1000, already applied=1000, proposed=1\)/,
      );
    }
    // the open generation funds exactly its amount, against the original Payment …
    expect(await refund(d3.third.advanceId, 1000)).toEqual({ accepted: true, message: '' });
    // … and after that not one more minor unit — from ANY generation
    for (const advanceId of [d3.c.fundingAdvanceId, d3.second.advanceId, d3.third.advanceId]) {
      const r = await refund(advanceId, 1);
      expect(r.accepted, advanceId).toBe(false);
    }
    expect((await refund(d3.third.advanceId, 1)).message).toMatch(
      /payment <id>: refund consumption would exceed amountMinor \(payment=1000, already consumed=1000, proposed=1\)/,
    );
    const total = await pool.query(
      `SELECT COALESCE(SUM("amountMinor"), 0)::text AS t FROM refund WHERE "sourcePaymentId" = $1`,
      [d3.c.ultimatePaymentId],
    );
    expect(total.rows[0].t).toBe('1000');
  });

  // ══════ 6. idempotence + upgrade == fresh ══════
  it('a SECOND deploy is a no-op: nothing applied, every _prisma_migrations row unchanged, status up to date', () => {
    expect(secondDeployStdout).toMatch(/No pending migrations to apply/);
    expect(secondDeployStdout).not.toMatch(/Applying migration/);
    expect(migRowsAfterSecond).toEqual(migRows47);
    expect(statusStdout).toMatch(/Database schema is up to date/);
  });

  it('a FRESH database built from the same 47 migrations has a schema IDENTICAL to the upgraded one', () => {
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
      expect(snapFresh[part], part).toEqual(snap47[part]);
    }
    expect(upTo47).toHaveLength(47);
  });

  it('the fresh 47-migration database recorded all 47 migrations as finished', async () => {
    const rows = await migRows(freshPool);
    expect(rows).toHaveLength(47);
    expect(rows.every((r) => r['finished_at'] !== null && r['rolled_back_at'] === null)).toBe(true);
  });

  it('the Prisma schema validates (prisma validate)', () => {
    const out = prisma(['validate'], pkgDir, upgradeUrl);
    expect(out).toMatch(/is valid/);
  });
});
