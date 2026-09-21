import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function migrateDeploy(url: string): void {
  execFileSync(
    'node',
    [path.join(pkgDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
  );
}

/**
 * Task 3b.4 Checkpoint E (§E1/§E2/§E19) — the finalized-OrderLine DB
 * backstops (`order_line_price_tax_mode_chk` / `order_line_rounding_scope_chk`
 * / `order_line_rounding_mode_chk` / `order_line_line_tax_amount_nonneg_chk`,
 * migration `20260922120000_sale_tax_orderline_backstops`), proven against a
 * fresh real-Postgres apply of the FULL migration set (§E19 — a fresh DB
 * apply, both the Checkpoint C and Checkpoint E migrations recorded, a
 * second `migrate deploy` is a clean no-op).
 */
describe('sale-tax orderline backstops (task 3b.4 Checkpoint E)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  const TENANT = randomUUID();
  const COMPANY = randomUUID();
  const BRANCH = randomUUID();
  const PRODUCT = randomUUID();
  const VARIANT = randomUUID();
  const CATEGORY = randomUUID();

  async function mkOrder(): Promise<string> {
    const orderId = randomUUID();
    await pool.query(
      `INSERT INTO "order"
         (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,
          "currencyCode","currencyExponent","commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode",
          "updatedAt")
       VALUES ($1,$2,$3,$4,$4,'WALK_IN','DRAFT','AED',2,$5,2,'TAX_EXCLUSIVE','LINE','HALF_UP',now())`,
      [orderId, TENANT, COMPANY, BRANCH, `fp-${orderId}`],
    );
    return orderId;
  }

  async function mkLine(
    orderId: string,
    finalizedTax: {
      priceTaxMode?: string | null;
      roundingScope?: string | null;
      roundingMode?: string | null;
      lineTaxAmountMinor?: bigint | null;
    } | null,
  ): Promise<string> {
    const lineId = randomUUID();
    const f = finalizedTax ?? {
      priceTaxMode: null,
      roundingScope: null,
      roundingMode: null,
      lineTaxAmountMinor: null,
    };
    await pool.query(
      `INSERT INTO order_line
         (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
          "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
          "resolutionSource","priceTaxMode","roundingScope","roundingMode","lineTaxAmountMinor",
          "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
          "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',1000,'AED',2,'NONE',$7,$8,$9,$10,
               'piece','Piece','piece',1,1,'Rose','Rose',now())`,
      [
        lineId,
        TENANT,
        COMPANY,
        orderId,
        PRODUCT,
        VARIANT,
        f.priceTaxMode ?? null,
        f.roundingScope ?? null,
        f.roundingMode ?? null,
        f.lineTaxAmountMinor ?? null,
      ],
    );
    return lineId;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17')
      .withDatabase('flower')
      .withUsername('flower')
      .withPassword('flower_test')
      .start();
    const url = container.getConnectionUri();
    migrateDeploy(url);
    pool = new pg.Pool({ connectionString: url });

    await pool.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES
       ('00000000-0000-7000-8000-0000005e0001','starter-5e','Starter', now())`,
    );
    await pool.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt") VALUES
       ('00000000-0000-7000-8000-0000005e0002','00000000-0000-7000-8000-0000005e0001',1,'PUBLISHED', now())`,
    );
    await pool.query(
      `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
       VALUES ($1,'e-tenant','e-tenant','AE','ACTIVE','00000000-0000-7000-8000-0000005e0002', now())`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
       VALUES ('AED', 2, 'AED', 'x', 'x') ON CONFLICT (code) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone","updatedAt")
       VALUES ($1,$2,'E Co',NULL,'AED','Asia/Dubai',now())`,
      [COMPANY, TENANT],
    );
    await pool.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'Main',now())`,
      [BRANCH, TENANT, COMPANY],
    );
    await pool.query(
      `INSERT INTO category (id,"tenantId",slug,"nameEn","updatedAt") VALUES ($1,$2,'flowers','Flowers',now())`,
      [CATEGORY, TENANT],
    );
    await pool.query(
      `INSERT INTO product (id,"tenantId","categoryId",slug,"nameEn","fulfilmentStrategy",status,"updatedAt")
       VALUES ($1,$2,$3,'rose','Rose','STOCKED','ACTIVE',now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await pool.query(
      `INSERT INTO variant (id,"tenantId","productId","nameEn",status,"baseUomCode","updatedAt")
       VALUES ($1,$2,$3,'Rose','ACTIVE','piece',now())`,
      [VARIANT, TENANT, PRODUCT],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ── E19 — fresh DB / migration bookkeeping ──────────────────────────────

  it('E19. records both the Checkpoint C and Checkpoint E migrations as applied, on a fresh DB', async () => {
    const { rows } = await pool.query<{ migration_name: string; finished_at: Date | null }>(
      `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`,
    );
    const names = rows.map((r) => r.migration_name);
    expect(names.some((n) => n.endsWith('_sale_tax_fiscal_policy_v1v2'))).toBe(true);
    expect(names.some((n) => n.endsWith('_sale_tax_orderline_backstops'))).toBe(true);
    expect(rows.every((r) => r.finished_at !== null)).toBe(true);
  });

  it('E19. a second `migrate deploy` on the same DB is a clean no-op', () => {
    expect(() => migrateDeploy(container.getConnectionUri())).not.toThrow();
  });

  // ── E2 — DB raw-SQL hard gates ───────────────────────────────────────────

  it('A. all finalized tax fields NULL remains valid pre-issuance', async () => {
    const orderId = await mkOrder();
    await expect(mkLine(orderId, null)).resolves.toBeTruthy();
  });

  it('B. a partial finalized snapshot is rejected by the existing 3b.3 shape CHECK', async () => {
    const orderId = await mkOrder();
    await expect(
      mkLine(orderId, {
        priceTaxMode: 'TAX_EXCLUSIVE',
        roundingScope: 'LINE',
        roundingMode: null,
        lineTaxAmountMinor: 0n,
      }),
    ).rejects.toThrow(/order_line_tax_snapshot_shape_chk/i);
  });

  it('C. an invalid priceTaxMode is rejected', async () => {
    const orderId = await mkOrder();
    await expect(
      mkLine(orderId, {
        priceTaxMode: 'NOT_A_MODE',
        roundingScope: 'LINE',
        roundingMode: 'HALF_UP',
        lineTaxAmountMinor: 0n,
      }),
    ).rejects.toThrow(/order_line_price_tax_mode_chk/i);
  });

  it('D. an invalid roundingScope is rejected', async () => {
    const orderId = await mkOrder();
    await expect(
      mkLine(orderId, {
        priceTaxMode: 'TAX_EXCLUSIVE',
        roundingScope: 'ITEM',
        roundingMode: 'HALF_UP',
        lineTaxAmountMinor: 0n,
      }),
    ).rejects.toThrow(/order_line_rounding_scope_chk/i);
  });

  it('E. an invalid roundingMode is rejected', async () => {
    const orderId = await mkOrder();
    await expect(
      mkLine(orderId, {
        priceTaxMode: 'TAX_EXCLUSIVE',
        roundingScope: 'LINE',
        roundingMode: 'CEIL',
        lineTaxAmountMinor: 0n,
      }),
    ).rejects.toThrow(/order_line_rounding_mode_chk/i);
  });

  it('F. a negative lineTaxAmountMinor is rejected', async () => {
    const orderId = await mkOrder();
    await expect(
      mkLine(orderId, {
        priceTaxMode: 'TAX_EXCLUSIVE',
        roundingScope: 'LINE',
        roundingMode: 'HALF_UP',
        lineTaxAmountMinor: -1n,
      }),
    ).rejects.toThrow(/order_line_line_tax_amount_nonneg_chk/i);
  });

  it('G. a valid full finalized snapshot is structurally accepted', async () => {
    const orderId = await mkOrder();
    await expect(
      mkLine(orderId, {
        priceTaxMode: 'TAX_EXCLUSIVE',
        roundingScope: 'LINE',
        roundingMode: 'HALF_UP',
        lineTaxAmountMinor: 50n,
      }),
    ).resolves.toBeTruthy();
  });

  it('H. post-issuance OrderLine UPDATE/DELETE remains blocked by the existing 3b.3 immutability backstop', async () => {
    const orderId = await mkOrder();
    const lineId = await mkLine(orderId, {
      priceTaxMode: 'TAX_EXCLUSIVE',
      roundingScope: 'LINE',
      roundingMode: 'HALF_UP',
      lineTaxAmountMinor: 50n,
    });
    // the one-time issuance transition trigger requires status
    // DRAFT->CONFIRMED + version+1 alongside orderNumber (§3b.3) — a bare
    // orderNumber-only UPDATE would itself be rejected by that OTHER
    // trigger, not the one this test targets.
    await pool.query(
      `UPDATE "order" SET "orderNumber" = 'ORD-900100', status = 'CONFIRMED', version = version + 1
        WHERE id = $1`,
      [orderId],
    );
    await expect(
      pool.query(`UPDATE order_line SET "lineTaxAmountMinor" = 99 WHERE id = $1`, [lineId]),
    ).rejects.toThrow(/immutable/i);
    await expect(pool.query(`DELETE FROM order_line WHERE id = $1`, [lineId])).rejects.toThrow(
      /immutable/i,
    );
  });

  it('I. Invoice UPDATE/DELETE remains blocked', async () => {
    const orderId = await mkOrder();
    await mkLine(orderId, {
      priceTaxMode: 'TAX_EXCLUSIVE',
      roundingScope: 'LINE',
      roundingMode: 'HALF_UP',
      lineTaxAmountMinor: 50n,
    });
    await pool.query(
      `UPDATE "order" SET "orderNumber" = 'ORD-900101', status = 'CONFIRMED', version = version + 1
        WHERE id = $1`,
      [orderId],
    );
    const invoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoice
         (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
          "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
          "taxTotalAmountMinor","totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,'INV-900101',now(),CURRENT_DATE,'AED',2,1000,0,50,1050)`,
      [invoiceId, TENANT, COMPANY, BRANCH, orderId],
    );
    await expect(
      pool.query(`UPDATE invoice SET "totalAmountMinor" = 1 WHERE id = $1`, [invoiceId]),
    ).rejects.toThrow(/immutable/i);
    await expect(pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId])).rejects.toThrow(
      /immutable/i,
    );
  });
});
