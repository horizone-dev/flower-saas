import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { computeCommercialSnapshotFingerprintV2 } from '../modules/orders/commercial-snapshot.js';

/**
 * Task 3b.10 Checkpoint G — the DENSE SALES FIXTURE of the local load verification: a derivation (a copy, not an edit) of the
 * frozen Checkpoint B dense-window generator. ONE target company issues `invoices` invoices over exactly 90 days across several
 * branches — each with a realistic issued order (2 lines, a line discount on some, a document discount on some), a VALID
 * commercial fingerprint computed independently of the report, a coherent invoice, a sealed balanced sale journal — plus
 * background foreign companies / a foreign tenant. Set-based inside PostgreSQL, bounded batches. Disposable data only.
 *
 * Drift guard: the loading test proves the copy equals the frozen boundary over HTTP (25 000 documents accepted, one more →
 * `422 REPORT_RESULT_TOO_LARGE`, 91 days → `400 REPORT_RANGE_TOO_LARGE`).
 */
export const SALES_START = '2026-06-01';
export const SALES_DAYS = 90;

type Q = Pick<pg.Client, 'query'>;

export async function seedReferenceRows(c: Q, tenants: string[]): Promise<void> {
  const planId = randomUUID();
  const planVersionId = randomUUID();
  await c.query(`INSERT INTO plan (id,key,name,"updatedAt") VALUES ($1,$2,$2,now())`, [
    planId,
    `gs-plan-${planId.slice(0, 8)}`,
  ]);
  await c.query(
    `INSERT INTO plan_version (id,"planId",version,status,"updatedAt") VALUES ($1,$2,1,'PUBLISHED',now())`,
    [planVersionId, planId],
  );
  for (const t of tenants) {
    await c.query(
      `INSERT INTO tenant (id,slug,name,region,status,"planVersionId","updatedAt") VALUES ($1,$2,$2,'AE','ACTIVE',$3,now())`,
      [t, `gs-${t.slice(0, 8)}`, planVersionId],
    );
  }
  await c.query(
    `INSERT INTO currency (code,exponent,symbol,"nameEn","nameAr") VALUES ('AED',2,'AED','x','x') ON CONFLICT (code) DO NOTHING`,
  );
  await c.query(
    `INSERT INTO country (code,"nameEn","nameAr",region,"defaultCurrencyCode","weekendModel","defaultTimezone","updatedAt")
     VALUES ('AE','UAE','x','gcc','AED','SAT_SUN','Asia/Dubai',now()) ON CONFLICT (code) DO NOTHING`,
  );
}

export async function seedSalesCompany(
  c: Q,
  args: {
    tenantId: string;
    companyId: string;
    branches: string[];
    invoices: number;
    /** credit notes + cancellation charges (the TARGET company has none, so its document count is exact) */
    adjustments: boolean;
    batch: number;
    /** the journal source kind of a walk-in sale — named by the calling test, never by this helper */
    walkInKind: string;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO company (id,"tenantId","legalNameEn","countryCode","defaultCurrency","accountingTimezone",status,"updatedAt")
     VALUES ($1,$2,'Dense Co','AE','AED','Asia/Dubai','ACTIVE',now())`,
    [args.companyId, args.tenantId],
  );
  for (const b of args.branches) {
    await c.query(
      `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'B',now())`,
      [b, args.tenantId, args.companyId],
    );
  }
  const acct: Record<string, string> = {};
  for (const [key, category, code, name] of [
    ['ASSET.CASH_ON_HAND', 'ASSET', '1000', 'Cash'],
    ['ASSET.ACCOUNTS_RECEIVABLE', 'ASSET', '1300', 'AR'],
    ['LIABILITY.TAX_PAYABLE', 'LIABILITY', '2100', 'Tax'],
    ['REVENUE.SALES', 'REVENUE', '4000', 'Sales'],
    ['REVENUE.CANCELLATION_CHARGE', 'REVENUE', '4100', 'CC'],
  ] as const) {
    acct[key] = randomUUID();
    await c.query(
      `INSERT INTO account (id,"tenantId","companyId",key,category,"displayCode","displayName","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [acct[key], args.tenantId, args.companyId, key, category, code, name],
    );
  }
  const periodId = randomUUID();
  await c.query(
    `INSERT INTO accounting_period (id,"tenantId","companyId","startDate","endDate",status,"updatedAt")
     VALUES ($1,$2,$3,'2020-01-01','2030-12-31','OPEN',now())`,
    [periodId, args.tenantId, args.companyId],
  );
  await c.query(`SET session_replication_role = 'replica'`);
  try {
    for (let lo = 1; lo <= args.invoices; lo += args.batch) {
      const hi = Math.min(args.invoices, lo + args.batch - 1);
      await seedBatch(c, { ...args, periodId, acct, lo, hi });
    }
  } finally {
    await c.query(`SET session_replication_role = 'origin'`);
  }
}

async function seedBatch(
  c: Q,
  a: {
    tenantId: string;
    companyId: string;
    branches: string[];
    invoices: number;
    adjustments: boolean;
    walkInKind: string;
    periodId: string;
    acct: Record<string, string>;
    lo: number;
    hi: number;
  },
): Promise<void> {
  const T = a.tenantId;
  const C = a.companyId;
  await c.query(`DROP TABLE IF EXISTS sg`);
  // coherent money: lines → subtotal → document discount → 5 % tax → total (TAX_EXCLUSIVE)
  await c.query(
    `CREATE TEMP TABLE sg AS
       SELECT x.*, (x.p1 - x.d1 + x.p2) AS sub,
              (((x.p1 - x.d1 + x.p2) - x.dd) * 5) / 100 AS tax,
              ((x.p1 - x.d1) * 5) / 100 AS t1
         FROM (SELECT gs AS i, gen_random_uuid() AS id, gen_random_uuid() AS order_id, gen_random_uuid() AS entry_id,
                      (DATE '${SALES_START}' + (((gs - 1)::bigint * $2::bigint) / $1::bigint)::int) AS d,
                      ($3::uuid[])[1 + (gs % $4::int)] AS branch_id,
                      CASE WHEN gs % 2 = 0 THEN 'invoice_ar' ELSE $7::text END AS kind,
                      (ARRAY['SETTLED','PAID','UNPAID','PARTIAL','CANCELLED'])[1 + (gs % 5)] AS status,
                      (1000 + (gs % 977))::bigint AS p1,
                      (500 + (gs % 389))::bigint AS p2,
                      (CASE WHEN gs % 5 = 0 THEN 10 ELSE 0 END)::bigint AS d1,
                      (CASE WHEN gs % 7 = 0 THEN 50 ELSE 0 END)::bigint AS dd
                 FROM generate_series($5::int, $6::int) gs) x`,
    [a.invoices, SALES_DAYS, a.branches, a.branches.length, a.lo, a.hi, a.walkInKind],
  );
  await c.query(
    `INSERT INTO "order" (id,"tenantId","companyId","originBranchId","fulfillingBranchId",kind,status,"currencyCode","currencyExponent",
                          "documentDiscountMode","documentDiscountAmountMinor","documentDiscountReason","orderNumber",
                          "commercialSnapshotFingerprint","commercialSnapshotFingerprintVersion","taxPriceMode","taxRoundingScope","taxRoundingMode","updatedAt")
     SELECT g.order_id, $1::uuid, $2::uuid, g.branch_id, g.branch_id, 'WALK_IN', 'CONFIRMED', 'AED', 2,
            CASE WHEN g.dd > 0 THEN 'AMOUNT' ELSE 'NONE' END, g.dd, CASE WHEN g.dd > 0 THEN 'promo' END,
            'ORD-' || g.i, repeat('0', 64), 2, 'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', now()
       FROM sg g`,
    [T, C],
  );
  await c.query(
    `INSERT INTO order_line (id,"tenantId","companyId","orderId","linePosition","productId","variantId",quantity,
                             "unitPriceAmountMinor","unitPriceCurrencyCode","unitPriceCurrencyExponent",
                             "discountMode","discountAmountMinor","taxCategoryKey","rateBps","effectiveFrom","resolutionSource",
                             "priceTaxMode","roundingScope","roundingMode","lineTaxAmountMinor",
                             "selectedUomCode","uomDisplayLabelSnapshot","baseUomCode",
                             "conversionNumerator","conversionDenominator","productNameEnSnapshot","variantNameEnSnapshot","updatedAt")
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.order_id, p.pos, gen_random_uuid(), gen_random_uuid(), 1,
            CASE WHEN p.pos = 1 THEN g.p1 ELSE g.p2 END, 'AED', 2,
            CASE WHEN p.pos = 1 AND g.d1 > 0 THEN 'AMOUNT' ELSE 'NONE' END, CASE WHEN p.pos = 1 THEN g.d1 ELSE 0 END,
            'STANDARD', 500, DATE '2020-01-01', 'VARIANT',
            'TAX_EXCLUSIVE', 'LINE', 'HALF_UP', CASE WHEN p.pos = 1 THEN g.t1 ELSE g.tax - g.t1 END,
            'piece','Piece','piece',1,1,'Rose','Rose',now()
       FROM sg g CROSS JOIN LATERAL (VALUES (1),(2)) AS p(pos)`,
    [T, C],
  );
  await c.query(
    `INSERT INTO invoice (id,"tenantId","companyId","branchId","orderId","invoiceNumber","issuedAt","invoiceDate",
                          "currencyCode","currencyExponent","subtotalAmountMinor","documentDiscountAmountMinor",
                          "taxTotalAmountMinor","totalAmountMinor","invoicePaymentStatus")
     SELECT g.id, $1::uuid, $2::uuid, g.branch_id, g.order_id, 'INV-' || g.i, g.d::timestamptz, g.d,
            'AED', 2, g.sub, g.dd, g.tax, g.sub - g.dd + g.tax, g.status
       FROM sg g`,
    [T, C],
  );
  await c.query(
    `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                "currencyCode","postingFingerprint","sealedAt")
     SELECT g.entry_id, $1::uuid, $2::uuid, $3::uuid, g.d, g.kind, g.id::text, 'AED', 'fp', now() FROM sg g`,
    [T, C, a.periodId],
  );
  await c.query(
    `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.entry_id, v.account_id, g.branch_id, v.dr, v.cr
       FROM sg g CROSS JOIN LATERAL (VALUES
         (CASE WHEN g.kind = 'invoice_ar' THEN $3::uuid ELSE $4::uuid END, g.sub - g.dd + g.tax, 0::bigint),
         ($5::uuid, 0::bigint, g.sub - g.dd),
         ($6::uuid, 0::bigint, g.tax)) AS v(account_id, dr, cr)`,
    [
      T,
      C,
      a.acct['ASSET.ACCOUNTS_RECEIVABLE'],
      a.acct['ASSET.CASH_ON_HAND'],
      a.acct['REVENUE.SALES'],
      a.acct['LIABILITY.TAX_PAYABLE'],
    ],
  );
  // every customer invoice has its receivable (the revenue-kind consistency check probes it)
  await c.query(
    `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, g.branch_id, gen_random_uuid(), 'INVOICE', g.id, true FROM sg g WHERE g.kind = 'invoice_ar'`,
    [T, C],
  );
  // the NON-sales entries a real ledger interleaves (the report's journal selection must skip them)
  await c.query(
    `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                "currencyCode","postingFingerprint","sealedAt")
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, g.d, 'payment_allocation', gen_random_uuid()::text, 'AED', 'fp', now()
       FROM sg g WHERE g.kind = 'invoice_ar'`,
    [T, C, a.periodId],
  );
  if (a.adjustments) {
    await c.query(`DROP TABLE IF EXISTS sc`);
    await c.query(
      `CREATE TEMP TABLE sc AS
       SELECT g.*, gen_random_uuid() AS cn_id, gen_random_uuid() AS cn_entry FROM sg g WHERE g.kind = 'invoice_ar' AND g.i % 10 = 0`,
    );
    await c.query(
      `INSERT INTO credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate",
                              "currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor",
                              "totalAmountMinor","arReductionMinor","advanceExcessMinor")
     SELECT c.cn_id, $1::uuid, $2::uuid, c.branch_id, c.id, 'CN-' || c.i, c.d::timestamptz, c.d, 'AED', 2,
            'CUSTOMER_REQUEST', c.sub - c.dd, c.tax, c.sub - c.dd + c.tax, c.sub - c.dd + c.tax, 0 FROM sc c`,
      [T, C],
    );
    await c.query(
      `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                "currencyCode","postingFingerprint","sealedAt")
     SELECT c.cn_entry, $1::uuid, $2::uuid, $3::uuid, c.d, 'credit_note', c.cn_id::text, 'AED', 'fp', now() FROM sc c`,
      [T, C, a.periodId],
    );
    await c.query(
      `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, c.cn_entry, v.account_id, c.branch_id, v.dr, v.cr
       FROM sc c CROSS JOIN LATERAL (VALUES
         ($4::uuid, c.sub - c.dd, 0::bigint), ($5::uuid, c.tax, 0::bigint), ($3::uuid, 0::bigint, c.sub - c.dd + c.tax)) AS v(account_id, dr, cr)`,
      [
        T,
        C,
        a.acct['ASSET.ACCOUNTS_RECEIVABLE'],
        a.acct['REVENUE.SALES'],
        a.acct['LIABILITY.TAX_PAYABLE'],
      ],
    );
    await c.query(`DROP TABLE IF EXISTS sx`);
    await c.query(
      `CREATE TEMP TABLE sx AS
       SELECT g.i, g.branch_id, g.d, g.order_id, gen_random_uuid() AS cc_id, gen_random_uuid() AS cc_entry
         FROM sg g WHERE g.i % 50 = 0`,
    );
    await c.query(
      `INSERT INTO cancellation_charge (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber","netAmountMinor",
                                      "taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent","taxCategoryKey",
                                      "rateBps","priceTaxMode","roundingMode","reasonCode","accountingDate")
     SELECT x.cc_id, $1::uuid, $2::uuid, x.branch_id, x.order_id, 'CC-' || x.i, 400, 20, 420, 'AED', 2, 'STD3B3', 500,
            'TAX_EXCLUSIVE', 'HALF_UP', 'CUSTOMER_REQUEST', x.d FROM sx x`,
      [T, C],
    );
    await c.query(
      `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                "currencyCode","postingFingerprint","sealedAt")
     SELECT x.cc_entry, $1::uuid, $2::uuid, $3::uuid, x.d, 'cancellation_charge', x.cc_id::text, 'AED', 'fp', now() FROM sx x`,
      [T, C, a.periodId],
    );
    await c.query(
      `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, x.cc_entry, v.account_id, x.branch_id, v.dr, v.cr
       FROM sx x CROSS JOIN LATERAL (VALUES
         ($3::uuid, 420::bigint, 0::bigint), ($4::uuid, 0::bigint, 400::bigint), ($5::uuid, 0::bigint, 20::bigint)) AS v(account_id, dr, cr)`,
      [
        T,
        C,
        a.acct['ASSET.ACCOUNTS_RECEIVABLE'],
        a.acct['REVENUE.CANCELLATION_CHARGE'],
        a.acct['LIABILITY.TAX_PAYABLE'],
      ],
    );
  }
  await c.query(`DROP TABLE IF EXISTS sg, sc, sx`);
}

/**
 * The target company's orders get their REAL commercial fingerprint, computed HERE — independently of the report's own proof —
 * with the production fingerprint function over the rows exactly as stored. Pages by key; runs with the triggers off because the
 * freeze trigger forbids changing a fingerprint.
 */
export async function fingerprintOrders(c: Q, tenantId: string, companyId: string): Promise<void> {
  const PAGE = 5_000;
  let after = '00000000-0000-0000-0000-000000000000';
  await c.query(`SET session_replication_role = 'replica'`);
  try {
    for (;;) {
      const orders = await c.query(
        `SELECT id, "originBranchId" AS origin, "fulfillingBranchId" AS fulfilling,
                "documentDiscountMode" AS ddm, "documentDiscountBps" AS ddb,
                "documentDiscountAmountMinor"::text AS dda, "documentDiscountReason" AS ddr
           FROM "order" WHERE "tenantId" = $1 AND "companyId" = $2 AND id > $3 ORDER BY id LIMIT $4`,
        [tenantId, companyId, after, PAGE],
      );
      if (orders.rows.length === 0) break;
      const ids = orders.rows.map((r) => r['id'] as string);
      const lines = await c.query(
        `SELECT "orderId" AS oid, "productId" AS product, "variantId" AS variant, quantity::text AS quantity,
                "selectedUomCode" AS uom, "baseUomCode" AS base, "conversionNumerator"::text AS cn,
                "conversionDenominator"::text AS cd, "unitPriceAmountMinor"::text AS price,
                "unitPriceCurrencyCode" AS cur, "unitPriceCurrencyExponent" AS expo, "discountMode" AS dmode,
                "discountBps" AS dbps, "discountAmountMinor"::text AS disc, "taxCategoryKey" AS tcat,
                "rateBps" AS rate, to_char("effectiveFrom", 'YYYY-MM-DD') AS eff, "resolutionSource" AS src
           FROM order_line WHERE "orderId" = ANY($1::uuid[]) ORDER BY "orderId", "linePosition"`,
        [ids],
      );
      const byOrder = new Map<string, Record<string, unknown>[]>();
      for (const l of lines.rows) {
        const k = l['oid'] as string;
        (byOrder.get(k) ?? byOrder.set(k, []).get(k)!).push(l);
      }
      const fps = orders.rows.map((o) =>
        computeCommercialSnapshotFingerprintV2(
          {
            tenantId,
            companyId,
            originBranchId: o['origin'] as string,
            fulfillingBranchId: o['fulfilling'] as string,
            customerId: null,
            kind: 'WALK_IN',
            currencyCode: 'AED',
            lines: (byOrder.get(o['id'] as string) ?? []).map((l) => ({
              productId: l['product'] as string,
              variantId: l['variant'] as string,
              quantity: l['quantity'] as string,
              selectedUomCode: l['uom'] as string,
              baseUomCode: l['base'] as string,
              conversionNumerator: l['cn'] as string,
              conversionDenominator: l['cd'] as string,
              unitPriceAmountMinor: l['price'] as string,
              unitPriceCurrencyCode: l['cur'] as string,
              unitPriceCurrencyExponent: l['expo'] as number,
              discountMode: l['dmode'] as string,
              discountBps: l['dbps'] as number | null,
              discountAmountMinor: l['disc'] as string,
              taxCategoryKey: l['tcat'] as string | null,
              rateBps: l['rate'] as number | null,
              effectiveFrom: l['eff'] as string | null,
              resolutionSource: l['src'] as string,
            })),
            documentDiscountMode: o['ddm'] as string,
            documentDiscountBps: o['ddb'] as number | null,
            documentDiscountAmountMinor: o['dda'] as string,
            documentDiscountReason: o['ddr'] as string | null,
          },
          { taxPriceMode: 'TAX_EXCLUSIVE', taxRoundingScope: 'LINE', taxRoundingMode: 'HALF_UP' },
        ),
      );
      await c.query(
        `UPDATE "order" o SET "commercialSnapshotFingerprint" = v.fp
           FROM unnest($1::uuid[], $2::text[]) AS v(id, fp) WHERE o.id = v.id`,
        [ids, fps],
      );
      after = ids[ids.length - 1]!;
    }
  } finally {
    await c.query(`SET session_replication_role = 'origin'`);
  }
}

/** one extra financial document — a CancellationCharge with its sealed journal — inside the window (25 000 + 1) */
export async function addOneExtraDocument(
  c: Q,
  a: { tenantId: string; companyId: string; branchId: string; day: string },
): Promise<void> {
  const accounts = await c.query(`SELECT key, id FROM account WHERE "companyId" = $1`, [
    a.companyId,
  ]);
  const acct = (key: string): string =>
    accounts.rows.find((r) => r['key'] === key)!['id'] as string;
  const order = await c.query(`SELECT id FROM "order" WHERE "companyId" = $1 LIMIT 1`, [
    a.companyId,
  ]);
  const period = await c.query(`SELECT id FROM accounting_period WHERE "companyId" = $1 LIMIT 1`, [
    a.companyId,
  ]);
  const ccId = randomUUID();
  const entryId = randomUUID();
  await c.query(`SET session_replication_role = 'replica'`);
  try {
    await c.query(
      `INSERT INTO cancellation_charge (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber","netAmountMinor",
                                        "taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent","taxCategoryKey",
                                        "rateBps","priceTaxMode","roundingMode","reasonCode","accountingDate")
       VALUES ($1,$2,$3,$4,$5,'CC-EXTRA',400,20,420,'AED',2,'STD3B3',500,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',$6::date)`,
      [ccId, a.tenantId, a.companyId, a.branchId, order.rows[0]!['id'], a.day],
    );
    await c.query(
      `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
                                  "currencyCode","postingFingerprint","sealedAt")
       VALUES ($1,$2,$3,$4,$5::date,'cancellation_charge',$6,'AED','fp',now())`,
      [entryId, a.tenantId, a.companyId, period.rows[0]!['id'], a.day, ccId],
    );
    await c.query(
      `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,420,0), (gen_random_uuid(),$1,$2,$3,$6,$5,0,400), (gen_random_uuid(),$1,$2,$3,$7,$5,0,20)`,
      [
        a.tenantId,
        a.companyId,
        entryId,
        acct('ASSET.ACCOUNTS_RECEIVABLE'),
        a.branchId,
        acct('REVENUE.CANCELLATION_CHARGE'),
        acct('LIABILITY.TAX_PAYABLE'),
      ],
    );
  } finally {
    await c.query(`SET session_replication_role = 'origin'`);
  }
}
