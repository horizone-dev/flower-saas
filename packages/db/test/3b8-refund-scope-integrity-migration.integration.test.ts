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
const SCOPE_INTEGRITY = '20261009120000_phase_3b8_refund_scope_integrity';

/** sha256 of migrations 44 / 45 / 46 / 47, recorded BEFORE migration 48 was written — all four are
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
};

/** the ONLY schema objects migration 48 may touch */
const NEW_FUNCTIONS = [
  'fn_check_provider_refund_event_credential_scope()',
  'fn_enforce_provider_refund_event_initial_status()',
  'fn_enforce_provider_refund_event_no_delete()',
];
const REPLACED_FUNCTIONS = [
  'fn_check_customer_advance_refund_application_integrity()',
  'fn_check_refund_attempt_reservation_integrity()',
  'fn_check_refund_attempt_scope_and_capacity()',
  'fn_check_refund_scope_and_capacity()',
];
const NEW_TRIGGERS = [
  'provider_refund_event.trg_check_provider_refund_event_credential_scope',
  'provider_refund_event.trg_enforce_provider_refund_event_initial_status',
  'provider_refund_event.trg_enforce_provider_refund_event_no_delete',
];

/**
 * Task 3b.8 hard-gate DB integrity closure — MIGRATION 48
 * (`20261009120000_phase_3b8_refund_scope_integrity`) proven as a real UPGRADE.
 *
 * The adversarial hard gate found four database-level defects on the refund side of the 3b.8 schema
 * (D-B1 provider_refund_event DELETE, D-B2 terminal INSERT, D-B3 credential scope, D-B4 refund / application /
 * attempt / reservation scope + provenance). Migration 48 closes them with three new trigger functions + triggers
 * on provider_refund_event and four CREATE OR REPLACE function bodies — nothing else. This suite proves, with the
 * REAL `prisma migrate deploy` against real Postgres:
 *
 *   1. migrations 1..47 are applied first, DATA is seeded under that exact schema, a full-database data fingerprint
 *      and the schema are captured ("before") and a behaviour matrix is run;
 *   2. migration 48 is applied by a second `migrate deploy` (an UPGRADE of a populated database): exactly ONE
 *      migration is applied; the 47 earlier `_prisma_migrations` rows are bit-for-bit untouched; migrations 44-47
 *      still hash to the values recorded before this pass;
 *   3. the schema diff 47 -> 48 is EXACTLY three functions + three triggers added and four function bodies
 *      replaced — no table / column / index / constraint / policy / grant / view moves;
 *   4. every row that existed before survives byte-for-byte (a fingerprint of EVERY table);
 *   5. every legitimate flow (local CASH / BANK refund, provider attempt + reservation, SUCCEEDED / FAILED
 *      reconciliation, the inbox lifecycle, advance capacity) behaves IDENTICALLY before and after, every
 *      pre-existing guard still refuses with the same message, and every defect case flips from ACCEPTED (47) to
 *      REFUSED (48);
 *   6. a refused case, committed for real, leaves NO partial row anywhere in the database;
 *   7. a SECOND deploy is a no-op and a FRESH database built from the same 48 migrations has a schema identical to
 *      the upgraded one.
 *
 * The working directories are throwaway copies of the real migration files (the originals are never written).
 */

const TENANT = 'b1000000-8111-7111-8111-111111111111';
const OTHER_TENANT = 'b2000000-8222-7222-8222-222222222222';
const COMPANY = 'b3000000-8333-7333-8333-333333333333';
const BRANCH = 'b6000000-8666-7666-8666-666666666666';
const CATEGORY = 'b8000000-8888-7888-8888-888888888888';
const PRODUCT = 'b9000000-8999-7999-8999-999999999999';
const VARIANT = 'ba000000-8aaa-7aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = 'bb000000-8bbb-7bbb-8bbb-bbbbbbbbbbbb';
const CCA = 'bc000000-8ccc-7ccc-8ccc-cccccccccccc';
const CRED = 'bd000000-8ddd-7ddd-8ddd-dddddddddddd';

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

/** a throwaway Prisma working dir in the OS temp dir (never inside the repo): a minimal config (same
 *  schema/migrations layout and DATABASE_URL datasource as the package's own `prisma7.config.ts`), the schema,
 *  and COPIES of the given migrations */
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

/** a fingerprint (row count + md5 of the sorted row texts) of EVERY table except the migration ledger */
async function fingerprint(p: pg.Pool): Promise<Record<string, string>> {
  const tables = (
    await p.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
    )
  ).rows.map((r) => r.tablename);
  const out: Record<string, string> = {};
  for (const t of tables) {
    const r = await p.query<{ n: string; h: string }>(
      `SELECT count(*)::text AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`,
    );
    out[t] = `${r.rows[0]!.n}:${r.rows[0]!.h}`;
  }
  return out;
}

/** ids / dates in a DB error vary per run — keep the SHAPE of the message only */
const normalize = (msg: string): string =>
  msg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');

interface Outcome {
  accepted: boolean;
  message: string;
}

type Kind = 'branch' | 'company' | 'tenant';
const KINDS: readonly Kind[] = ['branch', 'company', 'tenant'];

interface Scope {
  tenantId: string;
  companyId: string;
  branchId: string;
}
interface Foreign extends Scope {
  ccaId: string;
  credId: string;
}
const S0: Scope = { tenantId: TENANT, companyId: COMPANY, branchId: BRANCH };

type Run = (c: pg.PoolClient) => Promise<void>;
interface Case {
  key: string;
  /** seeds whatever the case needs (committed) and returns the statements to attempt */
  build: () => Promise<Run>;
  /** false for a single statement that can never be committed on its own (a RefundAttempt without its
   *  reservations is always refused by the DEFERRED completeness trigger): "accepted" then means the
   *  STATEMENT itself was accepted, without forcing the deferred triggers. Default true. */
  immediate?: boolean;
}

describe('packages/db — migration 48 (3b.8 hard-gate DB integrity closure): a real 47 -> 48 upgrade', () => {
  const names = migrationNames();
  const before48 = names.filter((n) => n < SCOPE_INTEGRITY);
  const upTo48 = names.filter((n) => n <= SCOPE_INTEGRITY);

  let upgradeC: StartedPostgreSqlContainer;
  let freshC: StartedPostgreSqlContainer;
  let upgradeUrl = '';
  let freshUrl = '';
  let pool: pg.Pool;
  let freshPool: pg.Pool;
  let upgradeDir = '';
  let freshDir = '';

  let snap47: SchemaSnapshot;
  let snap48: SchemaSnapshot;
  let snapFresh: SchemaSnapshot;
  let migRows47: Row[] = [];
  let migRows48: Row[] = [];
  let migRowsAfterSecond: Row[] = [];
  let data47: Record<string, string> = {};
  let dataAfterUpgrade: Record<string, string> = {};
  let outcomes47: Record<string, Outcome> = {};
  let outcomes48: Record<string, Outcome> = {};
  let committedDefects: Record<string, Outcome> = {};
  let dataBeforeCommit: Record<string, string> = {};
  let dataAfterCommit: Record<string, string> = {};
  const caseKeys: { legit: string[]; keep: string[]; defect: string[] } = {
    legit: [],
    keep: [],
    defect: [],
  };
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
  const RUN = uid().slice(0, 8);

  async function baseFixture(p: pg.Pool): Promise<void> {
    await p.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await p.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT, 'mig48'],
      [OTHER_TENANT, 'mig48-other'],
    ] as const) {
      await p.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [id, slug],
      );
    }
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
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Mig Customer', now())`,
      [CUSTOMER, TENANT],
    );
    await p.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [CCA, TENANT, COMPANY, CUSTOMER],
    );
    await p.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt") VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await p.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose-bouquet', 'Test Product', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await p.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt") VALUES ($1, $2, $3, 'Test Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
    await insertCredential(p, CRED, S0);
  }

  async function insertCredential(
    p: pg.Pool,
    id: string,
    scope: { tenantId: string; companyId: string | null; branchId: string | null },
  ): Promise<void> {
    await p.query(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
      [id, scope.tenantId, scope.companyId, scope.branchId],
    );
  }

  /** order + one line (qty 1, unit price = total, no tax / discount) + confirmed + invoice */
  async function simpleInvoice(
    p: pg.Pool,
    totalMinor: number,
    customerId: string = CUSTOMER,
  ): Promise<{ orderId: string; lineId: string; invoiceId: string }> {
    const orderId = uid();
    await p.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "documentDiscountAmountMinor", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,now())`,
      [orderId, TENANT, COMPANY, BRANCH, customerId, `fp-${orderId}`],
    );
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
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT, totalMinor],
    );
    await p.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-${RUN}-${(++seq).toString().padStart(6, '0')}`],
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
  }

  async function paymentWithAllocation(
    p: pg.Pool,
    invoiceId: string,
    amountMinor: number,
  ): Promise<{ paymentId: string; allocationId: string }> {
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
  }

  interface ReleaseSpec {
    sourceKind: 'PAYMENT_ALLOCATION' | 'ADVANCE_APPLICATION' | 'OPENING_ADVANCE';
    allocationId?: string | null;
    applicationId?: string | null;
    paymentId?: string | null;
  }

  /** a credit note over a `simpleInvoice` that funds ONE CREDIT_NOTE advance through ONE release */
  async function issueCreditNote(
    p: pg.Pool,
    a: {
      invoiceId: string;
      lineId: string;
      total: number;
      arReduction: number;
      advanceExcess: number;
      release: ReleaseSpec;
    },
  ): Promise<{ advanceId: string; releaseId: string }> {
    const cnId = uid();
    const advanceId = uid();
    const releaseId = uid();
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO credit_note
           (id, "tenantId", "companyId", "branchId", "invoiceId", "creditNoteNumber", "issuedAt",
            "accountingDate", "currencyCode", "currencyExponent", "reasonCode",
            "subtotalAmountMinor", "taxTotalAmountMinor", "totalAmountMinor",
            "arReductionMinor", "advanceExcessMinor")
         VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, 'CUSTOMER_REQUEST', $7,0,$7,$8,$9)`,
        [
          cnId,
          TENANT,
          COMPANY,
          BRANCH,
          a.invoiceId,
          `CN-${cnId.slice(0, 8)}`,
          a.total,
          a.arReduction,
          a.advanceExcess,
        ],
      );
      await c.query(
        `INSERT INTO credit_note_line
           (id, "tenantId", "companyId", "creditNoteId", "orderLineId", "quantityCredited",
            "grossCreditedMinor", "discountCreditedMinor", "documentDiscountShareCreditedMinor",
            "netAfterDocumentDiscountCreditedMinor", "taxCreditedMinor", "lineTotalCreditedMinor",
            "currencyCode", "currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'1.0000',$6,0,0,$6,0,$6,'AED',2)`,
        [uid(), TENANT, COMPANY, cnId, a.lineId, a.total],
      );
      await c.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
        [advanceId, TENANT, COMPANY, BRANCH, CCA, a.advanceExcess],
      );
      await c.query(
        `INSERT INTO credit_note_coverage_release
           (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AED',2,$11)`,
        [
          releaseId,
          TENANT,
          COMPANY,
          BRANCH,
          cnId,
          a.release.sourceKind,
          a.release.allocationId ?? null,
          a.release.applicationId ?? null,
          a.release.paymentId ?? null,
          a.advanceExcess,
          advanceId,
        ],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return { advanceId, releaseId };
  }

  /** a fresh CREDIT_NOTE advance of `amount`, funded by its own Payment (release provenance = that Payment) */
  async function cnAdvance(
    p: pg.Pool,
    amount: number,
  ): Promise<{ paymentId: string; advanceId: string; releaseId: string }> {
    const { lineId, invoiceId } = await simpleInvoice(p, amount);
    const { paymentId, allocationId } = await paymentWithAllocation(p, invoiceId, amount);
    const { advanceId, releaseId } = await issueCreditNote(p, {
      invoiceId,
      lineId,
      total: amount,
      arReduction: 0,
      advanceExcess: amount,
      release: { sourceKind: 'PAYMENT_ALLOCATION', allocationId, paymentId },
    });
    return { paymentId, advanceId, releaseId };
  }

  async function freshAccount(p: pg.Pool): Promise<{ ccaId: string; customerId: string }> {
    const customerId = uid();
    await p.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Fresh Customer', now())`,
      [customerId, TENANT],
    );
    const ccaId = uid();
    await p.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [ccaId, TENANT, COMPANY, customerId],
    );
    return { ccaId, customerId };
  }

  /** a fresh customer + a CAPTURED invoice-less CUSTOMER_RECEIPT Payment attributed to that customer's account */
  async function receiptPayment(
    p: pg.Pool,
    amount: number,
  ): Promise<{ ccaId: string; paymentId: string }> {
    const { ccaId } = await freshAccount(p);
    const attemptId = uid();
    await p.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'BANK_TRANSFER',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, ccaId, amount, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await p.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId, amount],
    );
    return { ccaId, paymentId };
  }

  /** a scope in another BRANCH / COMPANY / TENANT with its own account and branch-scoped credential */
  const foreignMemo = new Map<Kind, Foreign>();
  async function foreignScope(p: pg.Pool, kind: Kind): Promise<Foreign> {
    const known = foreignMemo.get(kind);
    if (known) return known;
    let scope: Scope;
    let ccaId = CCA;
    if (kind === 'branch') {
      scope = { tenantId: TENANT, companyId: COMPANY, branchId: uid() };
      await p.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'sibling',now())`,
        [scope.branchId, scope.tenantId, scope.companyId],
      );
    } else {
      const tenantId = kind === 'tenant' ? OTHER_TENANT : TENANT;
      scope = { tenantId, companyId: uid(), branchId: uid() };
      await p.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt") VALUES ($1,$2,'Foreign Co','AED','Asia/Dubai',now())`,
        [scope.companyId, tenantId],
      );
      await p.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'foreign',now())`,
        [scope.branchId, tenantId, scope.companyId],
      );
      let customerId = CUSTOMER;
      if (kind === 'tenant') {
        customerId = uid();
        await p.query(
          `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Foreign Customer',now())`,
          [customerId, tenantId],
        );
      }
      ccaId = uid();
      await p.query(
        `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [ccaId, tenantId, scope.companyId, customerId],
      );
    }
    const credId = uid();
    await insertCredential(p, credId, scope);
    const f: Foreign = { ...scope, ccaId, credId };
    foreignMemo.set(kind, f);
    return f;
  }

  async function foreignPayment(p: pg.Pool, f: Foreign, amount = 1000): Promise<string> {
    const attemptId = uid();
    await p.query(
      `INSERT INTO payment_attempt
         (id,"tenantId","companyId","branchId","receiptPurpose","customerCompanyAccountId",method,"amountMinor","currencyCode","currencyExponent",state,"idempotencyKey","updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'BANK_TRANSFER',$6,'AED',2,'CAPTURED',$7,now())`,
      [attemptId, f.tenantId, f.companyId, f.branchId, f.ccaId, amount, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await p.query(
      `INSERT INTO payment (id,"tenantId","companyId","branchId","sourceAttemptId",method,"amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
      [paymentId, f.tenantId, f.companyId, f.branchId, attemptId, amount],
    );
    return paymentId;
  }

  async function foreignAdvance(p: pg.Pool, f: Foreign, amount = 500): Promise<string> {
    const paymentId = await foreignPayment(p, f, 1000);
    const advanceId = uid();
    await p.query(
      `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,$7,'AED',2)`,
      [advanceId, f.tenantId, f.companyId, f.branchId, f.ccaId, paymentId, amount],
    );
    return advanceId;
  }

  // statement builders (explicit scope) --------------------------------------------------------------
  const refundStmt = (
    c: pg.PoolClient,
    id: string,
    scope: Scope,
    paymentId: string,
    amount: number,
    method = 'BANK_TRANSFER',
    attemptId: string | null = null,
  ) =>
    c.query(
      `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","sourceRefundAttemptId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2,$8,'CUSTOMER_REQUEST',CURRENT_DATE)`,
      [id, scope.tenantId, scope.companyId, scope.branchId, paymentId, attemptId, amount, method],
    );
  const applicationStmt = (
    c: pg.PoolClient,
    scope: Scope,
    advanceId: string,
    refundId: string,
    amount: number,
  ) =>
    c.query(
      `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [uid(), scope.tenantId, scope.companyId, scope.branchId, advanceId, refundId, amount],
    );
  const attemptStmt = (
    c: pg.PoolClient,
    id: string,
    scope: Scope,
    paymentId: string,
    credId: string,
    amount: number,
  ) =>
    c.query(
      `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'AED',2,$7,'tap',$8,now())`,
      [
        id,
        scope.tenantId,
        scope.companyId,
        scope.branchId,
        paymentId,
        amount,
        credId,
        `idem-${id}`,
      ],
    );
  const reservationStmt = (
    c: pg.PoolClient,
    scope: Scope,
    attemptId: string,
    releaseId: string,
    advanceId: string,
    amount: number,
  ) =>
    c.query(
      `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AED',2)`,
      [
        uid(),
        scope.tenantId,
        scope.companyId,
        scope.branchId,
        attemptId,
        releaseId,
        advanceId,
        amount,
      ],
    );
  const EVENT_SQL = `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","status","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-m48',$7,now())`;
  const eventStmt = (
    c: pg.PoolClient,
    id: string,
    scope: Scope,
    credId: string,
    status = 'RECEIVED',
    providerEventId: string = `evt-${id}`,
  ) =>
    c.query(EVENT_SQL, [
      id,
      scope.tenantId,
      scope.companyId,
      scope.branchId,
      credId,
      providerEventId,
      status,
    ]);
  const forge = async (c: pg.PoolClient, sql: string, params: unknown[]): Promise<void> => {
    await c.query(`SET LOCAL session_replication_role = replica`);
    await c.query(sql, params);
    await c.query(`SET LOCAL session_replication_role = origin`);
  };

  /** attempt = run the statements in ONE transaction, force every deferred completeness trigger to run
   *  (SET CONSTRAINTS ALL IMMEDIATE), and either COMMIT or ROLLBACK. accepted = nothing raised. */
  async function attempt(
    p: pg.Pool,
    run: Run,
    commit: boolean,
    immediate = true,
  ): Promise<Outcome> {
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      await run(c);
      if (immediate) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return { accepted: true, message: '' };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      return { accepted: false, message: normalize(e instanceof Error ? e.message : String(e)) };
    } finally {
      c.release();
    }
  }

  // ── the behaviour matrix ─────────────────────────────────────────────────────────────────────────
  function legitCases(p: pg.Pool): Case[] {
    return [
      ...(['BANK_TRANSFER', 'CASH'] as const).map((method): Case => ({
        key: `LEGIT local ${method} refund + application`,
        build: async () => {
          const adv = await cnAdvance(p, 500);
          return async (c) => {
            const refundId = uid();
            await refundStmt(c, refundId, S0, adv.paymentId, 200, method);
            await applicationStmt(c, S0, adv.advanceId, refundId, 200);
          };
        },
      })),
      {
        key: 'LEGIT provider attempt + reservation (same scope)',
        build: async () => {
          const adv = await cnAdvance(p, 400);
          return async (c) => {
            const attemptId = uid();
            await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
            await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
          };
        },
      },
      {
        key: 'LEGIT conversion of a PENDING attempt to a SUCCEEDED refund',
        build: async () => {
          const adv = await cnAdvance(p, 400);
          const attemptId = uid();
          const c = await p.connect();
          try {
            await c.query('BEGIN');
            await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
            await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
            await c.query('COMMIT');
          } finally {
            c.release();
          }
          return async (cc) => {
            const refundId = uid();
            await cc.query(`SELECT id FROM refund_attempt WHERE id = $1 FOR UPDATE`, [attemptId]);
            await refundStmt(cc, refundId, S0, adv.paymentId, 400, 'ONLINE_GATEWAY', attemptId);
            await applicationStmt(cc, S0, adv.advanceId, refundId, 400);
            await cc.query(
              `UPDATE refund_attempt SET state = 'SUCCEEDED', "resultingRefundId" = $2 WHERE id = $1`,
              [attemptId, refundId],
            );
          };
        },
      },
      {
        key: 'LEGIT a PENDING attempt can FAIL',
        build: async () => {
          const adv = await cnAdvance(p, 250);
          const attemptId = uid();
          const c = await p.connect();
          try {
            await c.query('BEGIN');
            await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 250);
            await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 250);
            await c.query('COMMIT');
          } finally {
            c.release();
          }
          return async (cc) => {
            await cc.query(`UPDATE refund_attempt SET state = 'FAILED' WHERE id = $1`, [attemptId]);
          };
        },
      },
      {
        key: 'LEGIT event lifecycle: insert RECEIVED, inbox dedup, RECEIVED -> PROCESSED',
        build: async () => async (c) => {
          const id = uid();
          const providerEventId = `evt-life-${id}`;
          await eventStmt(c, id, S0, CRED, 'RECEIVED', providerEventId);
          const dup = await c.query(
            `INSERT INTO provider_refund_event ("tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
             VALUES ($1,$2,$3,$4,$5,'refund.succeeded','hash-m48',now())
             ON CONFLICT ("providerCredentialId","providerEventId") DO NOTHING RETURNING id`,
            [TENANT, COMPANY, BRANCH, CRED, providerEventId],
          );
          if (dup.rowCount !== 0) throw new Error('the inbox dedup inserted a duplicate');
          await c.query(`UPDATE provider_refund_event SET status = 'PROCESSED' WHERE id = $1`, [
            id,
          ]);
        },
      },
      {
        key: 'LEGIT PAYMENT-sourced advance consumed by a refund of its own Payment',
        build: async () => {
          const r = await receiptPayment(p, 1000);
          const advanceId = uid();
          await p.query(
            `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
             VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,500,'AED',2)`,
            [advanceId, TENANT, COMPANY, BRANCH, r.ccaId, r.paymentId],
          );
          return async (c) => {
            const refundId = uid();
            await refundStmt(c, refundId, S0, r.paymentId, 200, 'CASH');
            await applicationStmt(c, S0, advanceId, refundId, 200);
          };
        },
      },
    ];
  }

  function keepCases(p: pg.Pool): Case[] {
    const cases: Case[] = [];
    for (const kind of KINDS) {
      cases.push({
        key: `KEEP attempt over a ${kind}-foreign credential`,
        build: async () => {
          const f = await foreignScope(p, kind);
          const r = await receiptPayment(p, 1000);
          return async (c) => {
            await attemptStmt(c, uid(), S0, r.paymentId, f.credId, 400);
          };
        },
      });
      cases.push({
        key: `KEEP reservation stamped with a ${kind}-foreign scope`,
        build: async () => {
          const f = await foreignScope(p, kind);
          const adv = await cnAdvance(p, 400);
          return async (c) => {
            const attemptId = uid();
            await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
            await reservationStmt(c, f, attemptId, adv.releaseId, adv.advanceId, 400);
          };
        },
      });
      cases.push({
        key: `KEEP ${kind}-foreign refund whose application claims the advance's scope`,
        build: async () => {
          const f = await foreignScope(p, kind);
          const adv = await cnAdvance(p, 300);
          const fp = await foreignPayment(p, f);
          return async (c) => {
            const refundId = uid();
            await refundStmt(c, refundId, f, fp, 300);
            await applicationStmt(c, S0, adv.advanceId, refundId, 300);
          };
        },
      });
    }
    cases.push({
      key: 'KEEP attempt over a tenant-wide credential',
      build: async () => {
        const wide = uid();
        await insertCredential(p, wide, { tenantId: TENANT, companyId: null, branchId: null });
        const r = await receiptPayment(p, 1000);
        return async (c) => {
          await attemptStmt(c, uid(), S0, r.paymentId, wide, 400);
        };
      },
    });
    cases.push({
      key: 'KEEP no cross-advance reservation',
      build: async () => {
        const a1 = await cnAdvance(p, 400);
        const a2 = await cnAdvance(p, 400);
        return async (c) => {
          const attemptId = uid();
          await attemptStmt(c, attemptId, S0, a1.paymentId, CRED, 400);
          await reservationStmt(c, S0, attemptId, a1.releaseId, a2.advanceId, 400);
        };
      },
    });
    cases.push({
      key: 'KEEP reservation release provenance differs from the attempt Payment',
      build: async () => {
        const a1 = await cnAdvance(p, 400);
        const a2 = await cnAdvance(p, 400);
        return async (c) => {
          const attemptId = uid();
          await attemptStmt(c, attemptId, S0, a2.paymentId, CRED, 400);
          await reservationStmt(c, S0, attemptId, a1.releaseId, a1.advanceId, 400);
        };
      },
    });
    cases.push({
      key: 'KEEP refund application over the advance capacity',
      build: async () => {
        const adv = await cnAdvance(p, 100);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 100);
          await applicationStmt(c, S0, adv.advanceId, refundId, 100);
          const second = uid();
          await refundStmt(c, second, S0, adv.paymentId, 1);
          await applicationStmt(c, S0, adv.advanceId, second, 1);
        };
      },
    });
    return cases;
  }

  function defectCases(p: pg.Pool): Case[] {
    const cases: Case[] = [];
    // ── D-B1 / D-B2 / D-B3 provider_refund_event ──
    cases.push({
      key: 'DEFECT event DELETE',
      build: async () => {
        const id = uid();
        await p.query(EVENT_SQL, [id, TENANT, COMPANY, BRANCH, CRED, `evt-del-${id}`, 'RECEIVED']);
        return async (c) => {
          await c.query(`DELETE FROM provider_refund_event WHERE id = $1`, [id]);
        };
      },
    });
    for (const status of ['PROCESSED', 'EXCEPTION']) {
      cases.push({
        key: `DEFECT event inserted already ${status}`,
        build: async () => async (c) => {
          await eventStmt(c, uid(), S0, CRED, status);
        },
      });
    }
    for (const kind of KINDS) {
      cases.push({
        key: `DEFECT event over a ${kind}-foreign credential`,
        build: async () => {
          const f = await foreignScope(p, kind);
          return async (c) => {
            await eventStmt(c, uid(), S0, f.credId);
          };
        },
      });
      cases.push({
        key: `DEFECT event stamped ${kind}-foreign over this credential`,
        build: async () => {
          const f = await foreignScope(p, kind);
          return async (c) => {
            await eventStmt(c, uid(), f, CRED);
          };
        },
      });
    }
    for (const [label, company] of [
      ['tenant-wide', null],
      ['company-only', COMPANY],
    ] as const) {
      cases.push({
        key: `DEFECT event over a ${label} credential`,
        build: async () => {
          const wide = uid();
          await insertCredential(p, wide, { tenantId: TENANT, companyId: company, branchId: null });
          return async (c) => {
            await eventStmt(c, uid(), S0, wide);
          };
        },
      });
    }
    // ── D-B4 refund -> source Payment ──
    for (const kind of KINDS) {
      cases.push({
        key: `DEFECT refund over a ${kind}-foreign source Payment`,
        build: async () => {
          const f = await foreignScope(p, kind);
          const fp = await foreignPayment(p, f);
          const adv = await cnAdvance(p, 300);
          return async (c) => {
            const refundId = uid();
            await refundStmt(c, refundId, S0, fp, 300);
            await applicationStmt(c, S0, adv.advanceId, refundId, 300);
          };
        },
      });
    }
    // ── D-B4 application -> advance ──
    for (const kind of KINDS) {
      cases.push({
        key: `DEFECT application consuming a ${kind}-foreign advance`,
        build: async () => {
          const f = await foreignScope(p, kind);
          const advanceId = await foreignAdvance(p, f);
          const r = await receiptPayment(p, 1000);
          return async (c) => {
            const refundId = uid();
            await refundStmt(c, refundId, S0, r.paymentId, 300);
            await applicationStmt(c, S0, advanceId, refundId, 300);
          };
        },
      });
      cases.push({
        key: `DEFECT application claiming the ${kind}-foreign refund's scope over a main-scope advance`,
        build: async () => {
          const f = await foreignScope(p, kind);
          const adv = await cnAdvance(p, 300);
          const fp = await foreignPayment(p, f);
          return async (c) => {
            const refundId = uid();
            await refundStmt(c, refundId, f, fp, 300);
            await applicationStmt(c, f, adv.advanceId, refundId, 300);
          };
        },
      });
    }
    cases.push({
      key: 'DEFECT application provenance: refund of another Payment',
      build: async () => {
        const adv = await cnAdvance(p, 300);
        const other = await receiptPayment(p, 1000);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, other.paymentId, 300);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300);
        };
      },
    });
    cases.push({
      key: 'DEFECT application provenance: OPENING advance',
      build: async () => {
        const { ccaId } = await freshAccount(p);
        const advanceId = uid();
        await p.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
           VALUES ($1,$2,$3,$4,$5,'OPENING',300,'AED',2,'2026-01-05')`,
          [advanceId, TENANT, COMPANY, BRANCH, ccaId],
        );
        const r = await receiptPayment(p, 1000);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, r.paymentId, 300);
          await applicationStmt(c, S0, advanceId, refundId, 300);
        };
      },
    });
    cases.push({
      key: 'DEFECT application provenance: CREDIT_NOTE advance of an OPENING chain',
      build: async () => {
        const { ccaId, customerId } = await freshAccount(p);
        const inv = await simpleInvoice(p, 2000, customerId);
        const openingAdvanceId = uid();
        await p.query(
          `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
           VALUES ($1,$2,$3,$4,$5,'OPENING',1000,'AED',2,'2026-01-05')`,
          [openingAdvanceId, TENANT, COMPANY, BRANCH, ccaId],
        );
        const receivableId = uid();
        await p.query(
          `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
           VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
          [receivableId, TENANT, COMPANY, BRANCH, ccaId, inv.invoiceId],
        );
        const applicationId = uid();
        await p.query(
          `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
           VALUES ($1,$2,$3,$4,$5,$6,1000,'AED',2)`,
          [applicationId, TENANT, COMPANY, BRANCH, openingAdvanceId, receivableId],
        );
        const funded = await issueCreditNote(p, {
          invoiceId: inv.invoiceId,
          lineId: inv.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: { sourceKind: 'OPENING_ADVANCE', applicationId, paymentId: null },
        });
        const r = await receiptPayment(p, 1000);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, r.paymentId, 500);
          await applicationStmt(c, S0, funded.advanceId, refundId, 500);
        };
      },
    });
    cases.push({
      key: 'DEFECT application over an advance whose customer account is in another company',
      build: async () => {
        const f = await foreignScope(p, 'company');
        const adv = await cnAdvance(p, 300);
        return async (c) => {
          await forge(
            c,
            `UPDATE customer_advance SET "customerCompanyAccountId" = $2 WHERE id = $1`,
            [adv.advanceId, f.ccaId],
          );
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 300);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300);
        };
      },
    });
    // ── D-B4 refund_attempt ──
    for (const kind of KINDS) {
      // a lone attempt can never COMMIT (its reservations are required by a deferred trigger at both
      // versions), so these two are judged on the INSERT statement itself
      cases.push({
        key: `DEFECT attempt over a ${kind}-foreign source Payment`,
        immediate: false,
        build: async () => {
          const f = await foreignScope(p, kind);
          const fp = await foreignPayment(p, f);
          return async (c) => {
            await attemptStmt(c, uid(), S0, fp, CRED, 400);
          };
        },
      });
      cases.push({
        key: `DEFECT attempt stamped ${kind}-foreign (own credential) over a main-scope Payment`,
        immediate: false,
        build: async () => {
          const f = await foreignScope(p, kind);
          const r = await receiptPayment(p, 1000);
          return async (c) => {
            await attemptStmt(c, uid(), f, r.paymentId, f.credId, 400);
          };
        },
      });
    }
    // ── D-B4 reservation ──
    for (const kind of KINDS) {
      cases.push({
        key: `DEFECT reservation over an advance forged into a ${kind}-foreign scope`,
        build: async () => {
          const f = await foreignScope(p, kind);
          const adv = await cnAdvance(p, 400);
          const column = { branch: '"branchId"', company: '"companyId"', tenant: '"tenantId"' }[
            kind
          ];
          const value = { branch: f.branchId, company: f.companyId, tenant: f.tenantId }[kind];
          return async (c) => {
            await forge(c, `UPDATE customer_advance SET ${column} = $2 WHERE id = $1`, [
              adv.advanceId,
              value,
            ]);
            const attemptId = uid();
            await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
            await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
          };
        },
      });
    }
    cases.push({
      key: 'DEFECT reservation over an advance whose customer account is in another company',
      build: async () => {
        const f = await foreignScope(p, 'company');
        const adv = await cnAdvance(p, 400);
        return async (c) => {
          await forge(
            c,
            `UPDATE customer_advance SET "customerCompanyAccountId" = $2 WHERE id = $1`,
            [adv.advanceId, f.ccaId],
          );
          const attemptId = uid();
          await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
          await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
        };
      },
    });
    return cases;
  }

  interface Built {
    key: string;
    run: Run;
    immediate: boolean;
  }
  async function buildAll(cases: Case[]): Promise<Built[]> {
    const built: Built[] = [];
    for (const k of cases) {
      built.push({ key: k.key, run: await k.build(), immediate: k.immediate ?? true });
    }
    return built;
  }
  async function runAll(
    p: pg.Pool,
    built: Built[],
    commit: boolean,
  ): Promise<Record<string, Outcome>> {
    const out: Record<string, Outcome> = {};
    for (const b of built) out[b.key] = await attempt(p, b.run, commit, b.immediate);
    return out;
  }

  /** a unit of work committed for real (throws when it is refused) */
  async function commitTx(p: pg.Pool, run: Run): Promise<void> {
    const c = await p.connect();
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

  /** REAL historical rows of every refund-side table, committed under the 47-migration schema — the data
   *  the upgrade must carry over byte-for-byte */
  async function seedHistory(p: pg.Pool): Promise<void> {
    // a BANK refund and a CASH refund, each with its application
    for (const [method, amount] of [
      ['BANK_TRANSFER', 250],
      ['CASH', 200],
    ] as const) {
      const adv = await cnAdvance(p, 600);
      await commitTx(p, async (c) => {
        const refundId = uid();
        await refundStmt(c, refundId, S0, adv.paymentId, amount, method);
        await applicationStmt(c, S0, adv.advanceId, refundId, amount);
      });
    }
    // a PENDING provider attempt with its reservation
    const pending = await cnAdvance(p, 400);
    await commitTx(p, async (c) => {
      const attemptId = uid();
      await attemptStmt(c, attemptId, S0, pending.paymentId, CRED, 400);
      await reservationStmt(c, S0, attemptId, pending.releaseId, pending.advanceId, 400);
    });
    // a SUCCEEDED conversion (attempt + reservation, then refund + application + the state change)
    const done = await cnAdvance(p, 300);
    const doneAttempt = uid();
    await commitTx(p, async (c) => {
      await attemptStmt(c, doneAttempt, S0, done.paymentId, CRED, 300);
      await reservationStmt(c, S0, doneAttempt, done.releaseId, done.advanceId, 300);
    });
    await commitTx(p, async (c) => {
      const refundId = uid();
      await c.query(`SELECT id FROM refund_attempt WHERE id = $1 FOR UPDATE`, [doneAttempt]);
      await refundStmt(c, refundId, S0, done.paymentId, 300, 'ONLINE_GATEWAY', doneAttempt);
      await applicationStmt(c, S0, done.advanceId, refundId, 300);
      await c.query(
        `UPDATE refund_attempt SET state = 'SUCCEEDED', "resultingRefundId" = $2 WHERE id = $1`,
        [doneAttempt, refundId],
      );
    });
    // a FAILED attempt (its reservation stays as evidence)
    const failed = await cnAdvance(p, 250);
    const failedAttempt = uid();
    await commitTx(p, async (c) => {
      await attemptStmt(c, failedAttempt, S0, failed.paymentId, CRED, 250);
      await reservationStmt(c, S0, failedAttempt, failed.releaseId, failed.advanceId, 250);
    });
    await p.query(`UPDATE refund_attempt SET state = 'FAILED' WHERE id = $1`, [failedAttempt]);
    // events in every status (RECEIVED, PROCESSED, EXCEPTION)
    for (const terminal of [null, 'PROCESSED', 'EXCEPTION'] as const) {
      const id = uid();
      await commitTx(p, async (c) => {
        await eventStmt(c, id, S0, CRED);
      });
      if (terminal) {
        await p.query(`UPDATE provider_refund_event SET status = $2 WHERE id = $1`, [id, terminal]);
      }
    }
  }

  beforeAll(async () => {
    expect(before48, 'the 47 migrations that precede migration 48').toHaveLength(47);
    expect(names).toContain(SCOPE_INTEGRITY);

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

    // ── A: the UPGRADE database — migrations 1..47 first ───────────────────────────────────
    upgradeDir = makeWorkDir('mig47', before48);
    prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    await baseFixture(pool);

    // historical data created UNDER MIGRATION 47's schema: real committed rows in every refund-side table,
    // every case's fixtures (committed) — and the behaviour matrix is run against the 47 schema (each
    // attempt rolled back)
    await seedHistory(pool);
    const legit = await buildAll(legitCases(pool));
    const keep = await buildAll(keepCases(pool));
    const defect = await buildAll(defectCases(pool));
    caseKeys.legit = legit.map((b) => b.key);
    caseKeys.keep = keep.map((b) => b.key);
    caseKeys.defect = defect.map((b) => b.key);
    outcomes47 = {
      ...(await runAll(pool, legit, false)),
      ...(await runAll(pool, keep, false)),
      ...(await runAll(pool, defect, false)),
    };
    migRows47 = await migRows(pool);
    snap47 = await snapshot(pool);
    data47 = await fingerprint(pool);

    // ── migration 48 applied on top — a real UPGRADE of the populated DB ─────────────────────
    addMigration(upgradeDir, SCOPE_INTEGRITY);
    upgradeStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRows48 = await migRows(pool);
    snap48 = await snapshot(pool);
    dataAfterUpgrade = await fingerprint(pool);

    // the SAME inputs, after the upgrade
    outcomes48 = {
      ...(await runAll(pool, legit, false)),
      ...(await runAll(pool, keep, false)),
      ...(await runAll(pool, defect, false)),
    };
    // every defect case COMMITTED for real: refused, and not one partial row anywhere in the database
    dataBeforeCommit = await fingerprint(pool);
    committedDefects = await runAll(pool, defect, true);
    dataAfterCommit = await fingerprint(pool);

    // ── second deploy: must be a no-op ──────────────────────────────────────────────────────
    secondDeployStdout = prisma(['migrate', 'deploy'], upgradeDir, upgradeUrl);
    migRowsAfterSecond = await migRows(pool);
    statusStdout = prisma(['migrate', 'status'], upgradeDir, upgradeUrl);

    // ── B: a FRESH database from the same 48 migrations ──────────────────────────────────────
    freshDir = makeWorkDir('fresh48', upTo48);
    prisma(['migrate', 'deploy'], freshDir, freshUrl);
    snapFresh = await snapshot(freshPool);
  }, 1_200_000);

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

  // ══════ 1. bookkeeping: exactly ONE migration applied, the 47 before it untouched ══════
  it('applies exactly ONE migration on top of 47 — migration 48 — and no other', () => {
    const applying = [...upgradeStdout.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]);
    expect(applying).toEqual([SCOPE_INTEGRITY]);
    expect(migRows47).toHaveLength(47);
    expect(migRows48).toHaveLength(48);
  });

  it('the 47 earlier _prisma_migrations rows are bit-for-bit untouched by the upgrade (id, checksum, timestamps, steps, logs)', () => {
    const earlier = migRows48.filter((r) => r['migration_name'] !== SCOPE_INTEGRITY);
    expect(earlier).toEqual(migRows47);
  });

  it('migration 48 is recorded finished, with the checksum of its own file', () => {
    const row = migRows48.find((r) => r['migration_name'] === SCOPE_INTEGRITY)!;
    expect(row['finished_at']).not.toBeNull();
    expect(row['rolled_back_at']).toBeNull();
    expect(row['applied_steps_count']).toBe(1);
    expect(row['checksum']).toBe(
      sha256(path.join(MIGRATIONS_DIR, SCOPE_INTEGRITY, 'migration.sql')),
    );
  });

  it('every recorded checksum equals the checksum of the migration file on disk (no recorded migration was edited)', () => {
    for (const r of migRows48) {
      const file = path.join(MIGRATIONS_DIR, String(r['migration_name']), 'migration.sql');
      expect(r['checksum'], String(r['migration_name'])).toBe(sha256(file));
    }
  });

  it('migrations 44, 45, 46 and 47 still hash to the values recorded BEFORE migration 48 was written (all four are frozen)', () => {
    for (const [name, hash] of Object.entries(FROZEN_HASHES)) {
      expect(sha256(path.join(MIGRATIONS_DIR, name, 'migration.sql')), name).toBe(hash);
      expect(migRows48.find((r) => r['migration_name'] === name)!['checksum'], name).toBe(hash);
    }
  });

  // ══════ 2. the schema diff 47 -> 48 is EXACTLY the intended functions and triggers ══════
  it('adds exactly THREE functions, replaces exactly FOUR function bodies and drops none', () => {
    const d = diff(snap47.functions, snap48.functions, (r) => String(r['fn']));
    expect(d.added).toEqual([...NEW_FUNCTIONS].sort());
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([...REPLACED_FUNCTIONS].sort());
  });

  it('adds exactly THREE triggers (all on provider_refund_event) and touches no existing trigger binding', () => {
    const d = diff(
      snap47.triggers,
      snap48.triggers,
      (r) => `${String(r['tbl'])}.${String(r['tgname'])}`,
    );
    expect(d.added).toEqual([...NEW_TRIGGERS].sort());
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    for (const name of NEW_TRIGGERS) {
      const row = snap48.triggers.find(
        (r) => `${String(r['tbl'])}.${String(r['tgname'])}` === name,
      )!;
      expect(row['enabled'], name).toBe('O');
    }
  });

  it('redesigns NO table, column, index, CHECK / FK / UNIQUE, policy, grant, RLS flag or view — so no new table, column, index, money field, route or permission', () => {
    const key =
      (...f: string[]) =>
      (r: Row) =>
        f.map((k) => String(r[k])).join('.');
    for (const [label, before, after, k] of [
      ['columns', snap47.columns, snap48.columns, key('table_name', 'column_name')],
      ['constraints', snap47.constraints, snap48.constraints, key('tbl', 'conname')],
      ['indexes', snap47.indexes, snap48.indexes, key('tablename', 'indexname')],
      ['policies', snap47.policies, snap48.policies, key('tablename', 'policyname')],
      ['tables', snap47.tables, snap48.tables, key('relname')],
      ['views', snap47.views, snap48.views, key('viewname')],
    ] as const) {
      expect(diff(before, after, k), label).toEqual({ added: [], removed: [], changed: [] });
    }
  });

  it('keeps EVERY pre-existing rejection message of the four replaced functions verbatim, and adds the new rules', () => {
    const def = (s: SchemaSnapshot, fn: string): string =>
      String(s.functions.find((r) => r['fn'] === fn)!['def']);
    const raised = (src: string): string[] =>
      [...src.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'/g)].map((m) => m[1]!);
    const expectedBefore: Record<string, number> = {
      'fn_check_refund_scope_and_capacity()': 3,
      'fn_check_refund_attempt_scope_and_capacity()': 4,
      'fn_check_customer_advance_refund_application_integrity()': 2,
      'fn_check_refund_attempt_reservation_integrity()': 6,
    };
    for (const fn of REPLACED_FUNCTIONS) {
      const before = raised(def(snap47, fn));
      const after = def(snap48, fn);
      expect(before, fn).toHaveLength(expectedBefore[fn]!);
      for (const message of before) expect(after, `${fn}: ${message}`).toContain(message);
      expect(raised(after).length, fn).toBeGreaterThan(before.length);
    }
    // the capacity functions the four triggers call are NOT replaced
    for (const fn of [
      'fn_lock_and_validate_payment_refund_capacity(p_payment_id uuid, p_proposed_amount bigint, p_excluding_refund_attempt_id uuid)',
      'fn_lock_and_validate_advance_capacity(p_advance_id uuid, p_proposed_amount bigint, p_excluding_refund_attempt_id uuid)',
    ]) {
      expect(def(snap48, fn), fn).toBe(def(snap47, fn));
    }
  });

  // ══════ 3. historical data survives ══════
  it('every row created under migration 47 survives the upgrade byte-for-byte — a fingerprint of EVERY table is identical before and after', () => {
    expect(Object.keys(data47).length).toBeGreaterThan(80);
    expect(dataAfterUpgrade).toEqual(data47);
    // …and the data is genuinely populated, not vacuously equal
    for (const t of [
      'refund',
      'refund_attempt',
      'refund_attempt_entitlement_reservation',
      'customer_advance_refund_application',
      'provider_refund_event',
      'credit_note_coverage_release',
      'customer_advance',
      'payment',
    ]) {
      expect(Number(data47[t]!.split(':')[0]), t).toBeGreaterThan(0);
    }
  });

  // ══════ 4. behaviour: legitimate flows and existing guards IDENTICAL; every defect flips ══════
  it('every LEGITIMATE flow behaves IDENTICALLY before and after: local CASH / BANK refund, provider attempt + reservation, SUCCEEDED / FAILED reconciliation, the inbox lifecycle, PAYMENT-advance refund — all accepted both times', () => {
    expect(caseKeys.legit).toHaveLength(7);
    for (const k of caseKeys.legit) {
      expect(outcomes47[k], `${k} @47`).toEqual({ accepted: true, message: '' });
      expect(outcomes48[k], `${k} @48`).toEqual({ accepted: true, message: '' });
    }
  });

  it('every PRE-EXISTING guard refuses identically before and after (same message): credential scope, attempt scope, release pair / provenance, refund-side scope, advance capacity', () => {
    expect(caseKeys.keep).toHaveLength(13);
    for (const k of caseKeys.keep) {
      expect(outcomes47[k]!.accepted, `${k} @47`).toBe(false);
      expect(outcomes48[k], `${k} @48`).toEqual(outcomes47[k]);
    }
    expect(outcomes48['KEEP refund application over the advance capacity']!.message).toMatch(
      /would exceed amountMinor/,
    );
  });

  const EXPECTED_DEFECT_MESSAGE: [RegExp, RegExp][] = [
    [/^DEFECT event DELETE$/, /DELETE is never permitted/],
    [/^DEFECT event inserted already /, /initial status must be RECEIVED/],
    [/^DEFECT event over a (branch|company|tenant)-foreign credential$/, /scope does not match/],
    [/^DEFECT event stamped /, /scope does not match/],
    [/^DEFECT event over a (tenant-wide|company-only) credential$/, /must be branch-scoped/],
    [/^DEFECT refund over /, /scope does not match sourcePayment/],
    [/^DEFECT application consuming /, /scope does not match customerAdvance/],
    [/^DEFECT application claiming /, /scope does not match customerAdvance/],
    [
      /^DEFECT application provenance: refund of another Payment$/,
      /underlying Payment provenance does not equal refund/,
    ],
    [/^DEFECT application provenance: OPENING advance$/, /has no underlying Payment provenance/],
    [
      /^DEFECT application provenance: CREDIT_NOTE advance of an OPENING chain$/,
      /has no underlying Payment provenance/,
    ],
    [
      /^DEFECT application over an advance whose customer account/,
      /customer account .* is not in this tenant\/company/,
    ],
    [/^DEFECT attempt /, /scope does not match sourcePayment/],
    [/^DEFECT reservation over an advance forged/, /scope does not match customerAdvance/],
    [
      /^DEFECT reservation over an advance whose customer account/,
      /customer account .* is not in this tenant\/company/,
    ],
  ];
  const expectedMessage = (k: string): RegExp => {
    const hit = EXPECTED_DEFECT_MESSAGE.find(([re]) => re.test(k));
    if (!hit) throw new Error(`no expected message registered for ${k}`);
    return hit[1];
  };

  it('every DEFECT case is ACCEPTED by the 47 schema and REFUSED by the 48 schema with the precise reason (the intended delta flips exactly as designed)', () => {
    expect(caseKeys.defect).toHaveLength(34);
    const problems: string[] = [];
    for (const k of caseKeys.defect) {
      if (!outcomes47[k]!.accepted) {
        problems.push(`${k} @47 should be ACCEPTED (the defect) but: ${outcomes47[k]!.message}`);
      }
      if (outcomes48[k]!.accepted) {
        problems.push(`${k} @48 should be REFUSED but was accepted`);
      } else if (!expectedMessage(k).test(outcomes48[k]!.message)) {
        problems.push(`${k} @48 refused for the WRONG reason: ${outcomes48[k]!.message}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a refused defect COMMITTED for real is refused again and leaves NO partial row — a fingerprint of EVERY table is identical before and after the whole batch', () => {
    const problems: string[] = [];
    for (const k of caseKeys.defect) {
      if (committedDefects[k]!.accepted) {
        problems.push(`${k} was ACCEPTED when committed for real`);
      } else if (!expectedMessage(k).test(committedDefects[k]!.message)) {
        problems.push(`${k} refused for the WRONG reason: ${committedDefects[k]!.message}`);
      }
    }
    expect(problems).toEqual([]);
    expect(dataAfterCommit).toEqual(dataBeforeCommit);
  });

  it('the matrix totals (reported): legitimate accepted before AND after, pre-existing guards identical, defects flipped accepted -> refused', () => {
    const accepted = (o: Record<string, Outcome>, keys: string[]): number =>
      keys.filter((k) => o[k]!.accepted).length;
    const totals = {
      legit: {
        cases: caseKeys.legit.length,
        accepted47: accepted(outcomes47, caseKeys.legit),
        accepted48: accepted(outcomes48, caseKeys.legit),
      },
      keep: {
        cases: caseKeys.keep.length,
        refused47: caseKeys.keep.length - accepted(outcomes47, caseKeys.keep),
        refused48: caseKeys.keep.length - accepted(outcomes48, caseKeys.keep),
      },
      defect: {
        cases: caseKeys.defect.length,
        accepted47: accepted(outcomes47, caseKeys.defect),
        refused48: caseKeys.defect.length - accepted(outcomes48, caseKeys.defect),
        refusedWhenCommitted: caseKeys.defect.length - accepted(committedDefects, caseKeys.defect),
      },
    };
    expect(totals).toEqual({
      legit: { cases: 7, accepted47: 7, accepted48: 7 },
      keep: { cases: 13, refused47: 13, refused48: 13 },
      defect: { cases: 34, accepted47: 34, refused48: 34, refusedWhenCommitted: 34 },
    });
  });

  // ══════ 5. idempotence and equivalence ══════
  it('a SECOND deploy is a no-op: nothing applied, every _prisma_migrations row unchanged, status up to date', () => {
    expect(secondDeployStdout).toMatch(/No pending migrations to apply/);
    expect(migRowsAfterSecond).toEqual(migRows48);
    expect(statusStdout).toMatch(/Database schema is up to date/);
  });

  it('a FRESH database built from the same 48 migrations has a schema IDENTICAL to the upgraded one', () => {
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
      expect(snapFresh[k], k).toEqual(snap48[k]);
    }
  });

  it('the fresh 48-migration database recorded all 48 migrations as finished', async () => {
    const rows = await migRows(freshPool);
    expect(rows).toHaveLength(48);
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
