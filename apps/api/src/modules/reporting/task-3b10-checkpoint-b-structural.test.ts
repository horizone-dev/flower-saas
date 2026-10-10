import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SALES_ACCOUNT_KEYS,
  SALES_FINANCIAL_REPORT_SQL,
  SALES_SOURCE_KINDS,
} from './sales-financial-report.sql.js';
import { parseReportDateRange } from './report-date-range.js';
import { INVOICE_PAYMENT_STATUSES, PAYMENT_STATUS_NOTE } from './sales-financial-report.js';
import { parseSalesReportRange, SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';

/**
 * Task 3b.10 Checkpoint B — structural pins: the Sales Financial Report.
 *
 * They pin the owner rulings (OD-1 … OD-8 and the Checkpoint B instruction) so the report cannot drift
 * into a controller, a permission, a migration, a refund / advance / payment figure, a document-date
 * period, a gross-plus-contra presentation, a recomputation of tax from a rate, a catalogue join, a
 * multi-statement read or a later checkpoint's report without a failing test. Every pin is
 * sensitivity-tested (a deliberate violation must turn it red).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..');
const DIR = HERE;
const read = (abs: string): string => readFileSync(abs, 'utf8');
const sha = (abs: string): string =>
  createHash('sha256').update(read(abs).replace(/\r\n/g, '\n')).digest('hex');
const rel = (abs: string): string => relative(ROOT, abs).replace(/\\/g, '/');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const bareCode = (src: string): string =>
  stripComments(src).replace(/'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"/g, "''");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

/** Checkpoint B's production files */
const B_PRODUCTION = [
  'sales-financial-report.ts',
  'sales-financial-report.sql.ts',
  'sales-financial-report.repository.ts',
  'sales-financial-report.service.ts',
  // Checkpoint B corrections (owner corrections 1 and 2)
  'sales-invoice-line-set-proof.ts',
  'sales-report-range.ts',
];
const PROOF = 'sales-invoice-line-set-proof.ts';
const RANGE = 'sales-report-range.ts';
const bProd = (name: string): string => stripComments(read(join(DIR, name)));
const SQL = SALES_FINANCIAL_REPORT_SQL;

// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Checkpoint F (the public HTTP wiring) legitimately adds its OWN controllers, the reporting Nest module, a query helper and
 * their tests inside the reporting directory — separate files, never an edit of a frozen A–E production file. The closed-set
 * and "no controller / no module" pins exclude exactly these files (and only these); every other file still has to satisfy
 * every pin unchanged. The one allowed reference in `app.module.ts` is the `ReportingModule` import and registration.
 */
const F_OWNED = [
  'customer-liabilities-report.controller.ts',
  'receivables-report.controller.ts',
  'reporting-query.ts',
  'reporting.controller.integration.test.ts',
  'reporting.module.ts',
  'sales-financial-report.controller.ts',
  'task-3b10-checkpoint-f-structural.test.ts',
  'tender-totals-report.controller.ts',
  'trial-balance.controller.ts',
];
const notF = (name: string): boolean => !F_OWNED.includes(name.replace(/\\/g, '/'));
const withoutFRegistration = (src: string): string =>
  src
    .replace("import { ReportingModule } from './modules/reporting/reporting.module.js';\n", '')
    .replace('    ReportingModule,\n', '');

describe('B — Checkpoint A is FROZEN: its production files are byte-unchanged', () => {
  const FROZEN: Record<string, string> = {
    'report-date-range.ts': 'b2a3859b05638788a75f3d51a9c084a14f5588fc0606799ecae0cf7f87fbd8aa',
    'report-money.ts': '3a125d7f9926a84c5961657fdc007466d6dce41216863eaa034978cca8367bb1',
    'reporting.repository.ts': '012207a0e26e085b08f95e45c7ed3315ea81a8653ac25d9bdff9ba152d279a3c',
    'trial-balance.ts': 'bf82c8c1bd4bd56bc9b5294c257414540eba69f9e3d7544143e4fb4d02c43d3a',
    'trial-balance.sql.ts': 'cf4c267c40881f3e63481ef039abd5f7435877845e49fc38e7eeba04b03e6821',
    'trial-balance.repository.ts':
      '40e1b01900e2a6911411a86e5ef570b9848118e566f43af5b4614e4581061c7b',
    'trial-balance.service.ts': '6fd6cc46c24cdf86b3c07bfdd67923cc15c35f6471accba10274f8473dc2075d',
  };
  for (const [file, hash] of Object.entries(FROZEN)) {
    it(`${file} is byte-identical to its Checkpoint A freeze`, () => {
      expect(sha(join(DIR, file))).toBe(hash);
    });
  }

  it('the Trial Balance still includes ALL sealed GL: no sourceKind filter, no pagination, no branch / POS dimension, no period cap', () => {
    const tb = read(join(DIR, 'trial-balance.sql.ts'));
    const executable = tb.slice(tb.indexOf('export const TRIAL_BALANCE_SQL'));
    expect(executable.slice(0, executable.indexOf('export interface'))).not.toMatch(
      /sourceKind|sourceId|branchId|posTerminal|LIMIT|OFFSET|cursor/i,
    );
    for (const f of [
      'trial-balance.ts',
      'trial-balance.repository.ts',
      'trial-balance.service.ts',
    ]) {
      expect(stripComments(read(join(DIR, f))), f).not.toMatch(
        /sourceKind|byBranch|cursor|\blimit\b|maxDays|MAX_RANGE|rangeCap|maxPeriod/i,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B — scope: only the Sales Financial Report; nothing of Checkpoints C–F', () => {
  it('the production surface is exactly the six Sales files — no controller, module, route or later report', () => {
    const files = walk(DIR)
      .map((f) => f.slice(DIR.length + 1).replace(/\\/g, '/'))
      .filter((n) => n.startsWith('sales-') && !/\.test\.ts$/.test(n) && notF(n))
      .sort();
    expect(files).toEqual([...B_PRODUCTION].sort());
    for (const n of B_PRODUCTION) {
      expect(n).not.toMatch(/\.(controller|module|guard|interceptor|dto)\.ts$/);
      expect(bProd(n), n).not.toMatch(
        /@Controller\b|@Module\b|@Get\(|@Post\(|@UseGuards\b|@RequirePermission\b|@ScopedParam\b|@Public\b|@Idempotent\b/,
      );
    }
  });

  it('no Receivables or Advances implementation exists, and Tender Totals is only Checkpoint C’s closed set (no file, no code vocabulary in the Sales code)', () => {
    const all = walk(DIR)
      .map((f) => f.slice(DIR.length + 1))
      .filter(notF);
    const C_TENDER = [
      'task-3b10-checkpoint-c-structural.test.ts',
      'tender-totals-report.dense-window.integration.test.ts',
      'tender-totals-report.integration.test.ts',
      'tender-totals-report.query-plan.integration.test.ts',
      'tender-totals-report.repository.ts',
      'tender-totals-report.service.ts',
      'tender-totals-report.sql.ts',
      'tender-totals-report.test.ts',
      'tender-totals-report.ts',
    ];
    // Checkpoint D (Receivables current state) legitimately adds ITS closed receivables files; no Advances file exists
    const D_RECEIVABLES_FILES = [
      'receivables-report.integration.test.ts',
      'receivables-report.query-plan.integration.test.ts',
      'receivables-report.repository.ts',
      'receivables-report.service.ts',
      'receivables-report.sql.ts',
      'receivables-report.test.ts',
      'receivables-report.ts',
    ];
    expect(all.filter((n) => /receivable|advance/i.test(n)).sort()).toEqual(
      [...D_RECEIVABLES_FILES].sort(),
    );
    expect(all.filter((n) => /tender/i.test(n)).sort()).toEqual(
      C_TENDER.filter((n) => /tender/i.test(n)).sort(),
    );
    for (const n of B_PRODUCTION) {
      expect(bProd(n), n).not.toMatch(
        /tender[_ -]?totals?|receivables?[_ -]?report|advances?[_ -]?report|customer_advance|\bCustomerAdvance\b|unapplied/i,
      );
    }
  });

  it('nothing outside the reporting module references the Sales report (no module registration, no import)', () => {
    for (const f of walk(SRC).filter((x) => x.endsWith('.ts') && !x.startsWith(DIR))) {
      if (/task-3b10-/.test(f)) continue;
      expect(read(f), rel(f)).not.toMatch(
        /SalesFinancialReport|sales-financial-report|modules\/reporting\/sales/,
      );
    }
    expect(withoutFRegistration(read(join(SRC, 'app.module.ts')))).not.toMatch(
      /reporting|Reporting|SalesFinancial/,
    );
  });

  it('no migration 50, no schema change, no permission change, no role-template change', () => {
    const migrations = join(ROOT, 'packages/db/prisma/migrations');
    const all = readdirSync(migrations)
      .filter((n) => !n.endsWith('.toml'))
      .sort();
    expect(all).toHaveLength(49);
    expect(all[all.length - 1]).toBe('20261010120000_phase_3b8_currency_and_release_integrity');
    expect(sha(join(ROOT, 'packages/db/prisma/schema.prisma'))).toBe(
      '15ef99cee245e0cc64166ab6a5156767b4795a0a7b763435207514945ea37459',
    );
    expect(sha(join(ROOT, 'packages/permissions/src/index.ts'))).toBe(
      '20f66e4258f62899b67471a4f0e64fe84f8098a2dffe9a4b6575734729ed4c42',
    );
    expect(sha(join(SRC, 'modules/platform/system-roles.ts'))).toBe(
      '977d2e6bd6e215b70d034ce6b6def9e3ff97eb282555541c271ce278028d14f0',
    );
    for (const n of B_PRODUCTION) {
      expect(read(join(DIR, n)), n).not.toMatch(
        /['"`](?:reports:view|reports:tenant|reporting:view|financial_reports:view)['"`]/,
      );
    }
  });

  it('no Task 3b.11 / tagging work', () => {
    for (const n of B_PRODUCTION)
      expect(read(join(DIR, n)), n).not.toMatch(/3b\.11|phase-3-complete/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B — the EXACT frozen source kinds and account keys (discovered in the producing code, never assumed)', () => {
  const producer = (path: string): string => read(join(ROOT, path));

  it('the four source kinds are exactly the literals the frozen producers post with', () => {
    expect(SALES_SOURCE_KINDS).toEqual({
      invoiceCustomer: 'invoice_ar',
      invoiceAnonymous: 'walk_in_sale',
      creditNote: 'credit_note',
      cancellationCharge: 'cancellation_charge',
    });
    expect(producer('apps/api/src/modules/receivables/customer-invoice-ar.repository.ts')).toMatch(
      /sourceKind: 'invoice_ar',\s*sourceId: input\.invoiceId/,
    );
    expect(producer('apps/api/src/modules/sales/walk-in-sale-journal.ts')).toMatch(
      /WALK_IN_SALE_SOURCE_KIND = 'walk_in_sale'/,
    );
    // the frozen Task 3b.9 pin lets ONE production file define the `walk_in_sale` literal (the producer's
    // pure builder); the report therefore IMPORTS the producer's exported constant — it can neither drift
    // from the posting side nor repeat the literal
    const sqlModule = bProd('sales-financial-report.sql.ts');
    expect(sqlModule).toMatch(
      /import \{ WALK_IN_SALE_SOURCE_KIND \} from '\.\.\/sales\/walk-in-sale-journal\.js';/,
    );
    expect(sqlModule).toMatch(/invoiceAnonymous: WALK_IN_SALE_SOURCE_KIND,/);
    expect(sqlModule).not.toMatch(/walk_in_sale/);
    expect(producer('apps/api/src/modules/orders/credit-note.repository.ts')).toMatch(
      /sourceKind: 'credit_note',\s*sourceId: creditNote\.id/,
    );
    expect(producer('apps/api/src/modules/orders/cancellation-charge.repository.ts')).toMatch(
      /sourceKind: 'cancellation_charge',\s*sourceId: charge\.id/,
    );
  });

  it('the account keys are exactly the frozen chart-of-accounts keys', () => {
    expect(SALES_ACCOUNT_KEYS).toEqual({
      salesRevenue: 'REVENUE.SALES',
      outputTax: 'LIABILITY.TAX_PAYABLE',
      cancellationChargeRevenue: 'REVENUE.CANCELLATION_CHARGE',
    });
    const coa = read(join(ROOT, 'packages/db/src/accounting-reference-data.ts'));
    for (const key of Object.values(SALES_ACCOUNT_KEYS)) expect(coa).toContain(`'${key}'`);
  });

  it('the report selects ONLY those four kinds — no other kind, no registry, no catch-all', () => {
    expect(SQL).toMatch(
      /je\."sourceKind" IN \('invoice_ar', 'walk_in_sale', 'credit_note', 'cancellation_charge'\)/,
    );
    expect((SQL.match(/je\."sourceKind"\s+(?:IN|=|<>|!=|NOT|LIKE|~)/g) ?? []).length).toBe(1);
    const sources = bProd('sales-financial-report.sql.ts');
    expect(sources).not.toMatch(
      /SOURCE_KIND_REGISTRY|sourceKindRegistry|knownSourceKinds|\bNOT IN\b|<> '/,
    );
    // an unknown kind can never be treated as sales: the code has no default / fallthrough on a kind
    const pure = bProd('sales-financial-report.ts');
    expect(pure).not.toMatch(/default:|\bswitch\s*\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B — the statement: ONE read statement, journal-anchored, sealed, postingDate-authoritative', () => {
  it('is one top-level WITH … SELECT, no semicolon, no mutation keyword, no lock', () => {
    expect(SQL.trim().startsWith('WITH')).toBe(true);
    expect(SQL).not.toContain(';');
    expect(SQL).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|COPY|CALL|LOCK)\b/i,
    );
    expect(SQL).not.toMatch(/\bFOR\s+(?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i);
  });

  it('each report invocation runs exactly ONE statement, through the read-only scoped transaction', () => {
    const repo = bProd('sales-financial-report.repository.ts');
    expect((repo.match(/\$queryRaw(?:Unsafe)?\s*[<(]/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(
      /\$executeRaw|\$transaction|\.create\(|\.update\(|\.delete\(|\.upsert\(|this\.scoped\(/,
    );
    expect(repo).toMatch(/this\.readScoped\(/);
    // both public entry points go through the same single read
    expect((repo.match(/await this\.read\(/g) ?? []).length).toBe(2);
    // …and the repository never loops over SQL (no N+1)
    expect(repo).not.toMatch(/Promise\.all|for\s*\([^)]*\)\s*\{[^}]*await|\.map\(\s*async/);
  });

  it('reads exactly the document tables, their journals and the company / branch rows — and nothing else', () => {
    const tables = [...SQL.matchAll(/\b(?:FROM|JOIN)\s+"([a-z_]+)"/gi)].map((m) => m[1]);
    expect([...new Set(tables)].sort()).toEqual([
      'account',
      'branch',
      'cancellation_charge',
      'company',
      'credit_note',
      'customer_receivable',
      'invoice',
      'journal_entry',
      'journal_line',
      'order',
      'order_line',
    ]);
  });

  it('refund, payment, advance, settlement and catalogue / pricing tables are NEVER read', () => {
    expect(SQL).not.toMatch(
      /"(?:refund|refund_attempt|payment|payment_allocation|payment_attempt|customer_advance|customer_advance_application|customer_account_entry|settlement_batch|settlement_line|settlement_application|variant|product|category|company_variant_price_set|company_variant_uom_price|branch_variant_uom_price|tax_rate|tax_category|country_tax_config)"/,
    );
    expect(SQL).not.toMatch(/refund|advance|settlement/i);
  });

  it('is anchored on SEALED journals: every journal reference is sealed-only', () => {
    expect(SQL).toMatch(/je\."sealedAt" IS NOT NULL/);
    expect(SQL).toMatch(/j2\."sealedAt" IS NOT NULL/);
    expect(SQL).toMatch(/j3\."sealedAt" IS NOT NULL/);
    expect((SQL.match(/FROM "journal_entry"/g) ?? []).length).toBe(3); // sel, j2, j3
  });

  it('period membership is the JOURNAL postingDate ONLY — no document date participates', () => {
    expect((SQL.match(/"postingDate"/g) ?? []).length).toBe(2);
    expect(SQL).toMatch(/je\."postingDate" >= \$3::date/);
    expect(SQL).toMatch(/je\."postingDate" <= \$4::date/);
    expect(SQL).not.toMatch(
      /invoiceDate|issuedAt|accountingDate|createdAt|updatedAt|occurredAt|orderDate|completedAt/,
    );
    expect(SQL).not.toMatch(
      /AT TIME ZONE|timezone\(|::timestamp|now\(\)|current_date|CURRENT_TIMESTAMP/i,
    );
  });

  it('documents are joined by PRIMARY KEY (sourceId → id) and probed through unique indexes — no sourceId scan', () => {
    expect(SQL).toMatch(
      /i\."id" = s\."docId" AND i\."tenantId" = \$1::uuid AND i\."companyId" = \$2::uuid/,
    );
    expect(SQL).toMatch(
      /n\."id" = s\."docId" AND n\."tenantId" = \$1::uuid AND n\."companyId" = \$2::uuid/,
    );
    expect(SQL).toMatch(
      /x\."id" = s\."docId" AND x\."tenantId" = \$1::uuid AND x\."companyId" = \$2::uuid/,
    );
    // a malformed sourceId is an ORPHAN, never a cast error
    expect(SQL).toMatch(/CASE WHEN je\."sourceId" ~ '\^\[0-9a-fA-F\]\{8\}/);
    // the duplicate-journal / credit-note probes go through (tenantId, companyId, sourceKind, sourceId)
    for (const alias of ['j2', 'j3']) {
      expect(SQL).toMatch(
        new RegExp(`${alias}\\."tenantId" = \\$1::uuid AND ${alias}\\."companyId" = \\$2::uuid`),
      );
      expect(SQL).toMatch(new RegExp(`${alias}\\."sourceKind"`));
      expect(SQL).toMatch(new RegExp(`${alias}\\."sourceId" =`));
    }
    expect(SQL).toMatch(/cr\."invoiceId" = d\."docId"/);
  });

  it('carries EXPLICIT tenant + company predicates on EVERY table it touches — never RLS or the branch GUC', () => {
    for (const alias of ['je', 'i', 'n', 'x', 'ol', 'jl', 'a', 'cr', 'j2', 'j3', 'b']) {
      expect(SQL, `${alias}.tenantId`).toMatch(new RegExp(`${alias}\\."tenantId" = \\$1::uuid`));
      expect(SQL, `${alias}.companyId`).toMatch(new RegExp(`${alias}\\."companyId" = \\$2::uuid`));
    }
    expect(SQL).toMatch(/c\."tenantId" = \$1::uuid/);
    expect(SQL).toMatch(/c\."id" = \$2::uuid/);
    expect(SQL).not.toMatch(/app\.branch_id|app\.tenant_id|current_setting|set_config/i);
  });

  it('the branch predicate is the EXPLICIT document branch ($5) — NULL for the company report', () => {
    expect(SQL).toMatch(
      /\(\$5::uuid IS NULL OR COALESCE\(i\."branchId", n\."branchId", x\."branchId"\) = \$5::uuid\)/,
    );
    expect(SQL).toMatch(/b\."id" = \$5::uuid/);
    expect((SQL.match(/\$5::uuid/g) ?? []).length).toBe(4);
    expect(SQL).not.toMatch(/posTerminal|pos_terminal|terminalId/i);
  });

  it('line discounts come from the ISSUED order lines by orderId — only the fingerprint-bound snapshot columns are read, nothing is recomputed from a rate, price or the catalogue', () => {
    expect(SQL).toMatch(/SUM\(ol\."discountAmountMinor"\)/);
    expect(SQL).toMatch(/ol\."orderId" = d\."orderId"/);
    // EXACTLY the columns the commercial fingerprint binds (plus the key / scope predicates) — nothing else
    const olColumns = [
      ...new Set([...SQL.matchAll(/\bol\."([A-Za-z]+)"/g)].map((m) => m[1])),
    ].sort();
    expect(olColumns).toEqual(
      [
        'baseUomCode',
        'companyId',
        'conversionDenominator',
        'conversionNumerator',
        'discountAmountMinor',
        'discountBps',
        'discountMode',
        'effectiveFrom',
        'linePosition',
        'orderId',
        'productId',
        'quantity',
        'rateBps',
        'resolutionSource',
        'selectedUomCode',
        'taxCategoryKey',
        'tenantId',
        'unitPriceAmountMinor',
        'unitPriceCurrencyCode',
        'unitPriceCurrencyExponent',
        'variantId',
      ].sort(),
    );
    // …and the order row: exactly the fingerprint inputs
    const oColumns = [...new Set([...SQL.matchAll(/\bo\."([A-Za-z]+)"/g)].map((m) => m[1]))].sort();
    expect(oColumns).toEqual(
      [
        'commercialSnapshotFingerprint',
        'commercialSnapshotFingerprintVersion',
        'companyId',
        'currencyCode',
        'customerId',
        'documentDiscountAmountMinor',
        'documentDiscountBps',
        'documentDiscountMode',
        'documentDiscountReason',
        'fulfillingBranchId',
        'id',
        'kind',
        'originBranchId',
        'taxPriceMode',
        'taxRoundingMode',
        'taxRoundingScope',
        'tenantId',
      ].sort(),
    );
    // no arithmetic on any order-line / order column: the statement carries the stored snapshot, it never recomputes one
    expect(SQL).not.toMatch(/\b(?:ol|o)\."[A-Za-z]+"(?:::[a-z]+)?\s*[*/+-]|[*/+-]\s*\b(?:ol|o)\."/);
    // the immutability assumption is a DB fact: the issued order's lines cannot be updated or deleted
    const mig = read(
      join(
        ROOT,
        'packages/db/prisma/migrations/20260920120000_orders_invoice_numbering/migration.sql',
      ),
    );
    expect(mig).toMatch(/CREATE FUNCTION fn_enforce_order_line_freeze\(\)/);
    expect(mig).toMatch(/parent order % is issued — order_line is immutable/);
    expect(mig).toMatch(
      /CREATE TRIGGER trg_enforce_order_line_freeze\s+BEFORE UPDATE OR DELETE ON "order_line"/,
    );
    expect(
      sha(
        join(
          ROOT,
          'packages/db/prisma/migrations/20260920120000_orders_invoice_numbering/migration.sql',
        ),
      ),
    ).toBe('c12abcc8c870df9189443f05b71b4d3b8cb57938aef5cce032a13b714c95c3be');
  });

  it('no gross-plus-contra presentation, no tax arithmetic from a rate, no float, no FX, no profit label', () => {
    expect(SQL).not.toMatch(/CONTRA_REVENUE|SALES_DISCOUNT|SETTLEMENT_DISCOUNT/);
    for (const n of B_PRODUCTION) {
      const code = bareCode(read(join(DIR, n)));
      expect(code, n).not.toMatch(/grossSales|contraRevenue|grossPlusContra|\bgross\b/i);
      expect(code, n).not.toMatch(
        n === PROOF
          ? /rate_bps|taxRate|mulRatio|divRound|capAllocate/
          : /rateBps|rate_bps|taxRate|mulRatio|divRound|capAllocate/,
      );
      expect(code, n).not.toMatch(
        /\bparseFloat\b|\.toFixed\s*\(|\bMath\.|\bNumber\s*\(|\bNumber\.parse|\bparseInt\s*\(/,
      );
      expect(code, n).not.toMatch(/(?<![\w.])\d+\.\d+(?![\w.])/);
      expect(code, n).not.toMatch(
        /fxRate|exchangeRate|convertCurrency|currencyConversion|toCurrency/i,
      );
      expect(code, n).not.toMatch(/\bprofit|\bmargin\b|\bearnings\b/i);
      expect(code, n).not.toMatch(/\w*(?:Minor|[Aa]mount|[Tt]otal|[Tt]ax)\w*\??\s*:\s*number\b/);
    }
  });

  it('no pagination on the aggregate Sales report', () => {
    // (the single LIMIT in the statement is the "LIMIT 1" of a LATERAL unique-index probe — a one-row
    // existence lookup per document, not a page of results)
    // …and the density guard's `LIMIT limit + 1` is the bound of the FIRST stage, not a page of results
    const limits = SQL.match(/\bLIMIT\b[^\n]*/g) ?? [];
    expect(limits.length).toBe(3);
    expect(limits.filter((l) => /^LIMIT 1\) (?:dj|rj) ON true$/.test(l)).length).toBe(2);
    expect(limits).toContain(`LIMIT ${SALES_REPORT_MAX_DOCUMENTS + 1}`);
    expect(SQL).not.toMatch(/\bOFFSET\b|\bFETCH\b|cursor|keyset/i);
    for (const n of B_PRODUCTION) {
      // (the statement's own text is checked above; the other files must not even NAME a page / limit)
      if (n === 'sales-financial-report.sql.ts') continue;
      expect(bProd(n), n).not.toMatch(
        /\bcursor\b|\blimit\b|\boffset\b|nextCursor|\bpage(?:Size|Token)?\b|hasMore/i,
      );
    }
    // the module that holds the statement names no page / cursor / offset anywhere
    const sqlModule = bProd('sales-financial-report.sql.ts');
    expect(sqlModule).not.toMatch(
      /\bcursor\b|\boffset\b|nextCursor|\bpage(?:Size|Token)?\b|hasMore/i,
    );
    expect((SQL.match(/\bLIMIT\b/g) ?? []).length).toBe(3);
  });

  it('every money aggregate leaves the database as TEXT (exact); counts are JSON integers', () => {
    for (const col of [
      'invoicedSubtotal',
      'lineDiscount',
      'documentDiscount',
      'outputTax',
      'invoicedTotal',
      'creditNoteTotal',
      'creditNoteTax',
      'cancellationChargeNet',
      'cancellationChargeTax',
      'cancellationChargeTotal',
    ]) {
      expect(SQL, col).toMatch(new RegExp(`br\\."${col}"::text`));
    }
    expect(SQL).not.toMatch(
      /::(?:float|double|real|numeric\(|decimal|money)|\bROUND\(|\bTRUNC\(|\bCEIL|\bFLOOR/i,
    );
    expect(bProd('sales-financial-report.repository.ts')).toMatch(/parseMinorUnitsText\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B — separation: credit ≠ payment, PAID ≠ SETTLED, refund / advance / charge are not sales', () => {
  it('Credit is not a Payment: no tender, no payment method, no CREDIT method in the Sales code', () => {
    for (const n of B_PRODUCTION) {
      expect(bProd(n), n).not.toMatch(
        /\btender|payment_method|paymentMethod|method\s*:\s*'(?:CREDIT|CASH|BANK)/i,
      );
    }
  });

  it('PAID is not SETTLED: the status breakdown is the frozen vocabulary read as STORED — never derived or folded', () => {
    expect([...INVOICE_PAYMENT_STATUSES]).toEqual([
      'UNPAID',
      'PARTIAL',
      'PAID',
      'SETTLED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'CANCELLED',
      'VOID',
    ]);
    // …and it is exactly the DB's closed vocabulary
    const mig = read(
      join(
        ROOT,
        'packages/db/prisma/migrations/20260920120000_orders_invoice_numbering/migration.sql',
      ),
    );
    const chk = mig.slice(
      mig.indexOf('"invoice_payment_status_chk"'),
      mig.indexOf('"invoice_payment_status_chk"') + 260,
    );
    for (const s of INVOICE_PAYMENT_STATUSES) expect(chk).toContain(`'${s}'`);
    // the status is the invoice's stored projection; the report never derives it from payments
    expect(SQL).toMatch(/i\."invoicePaymentStatus" AS "status"/);
    // PAID and SETTLED are never mapped to one another
    const pure = bProd('sales-financial-report.ts');
    expect(pure).not.toMatch(/'PAID'\s*[?:=]|'SETTLED'\s*[?:=]|status\s*===\s*'(?:PAID|SETTLED)'/);
    expect(PAYMENT_STATUS_NOTE).toBe(
      'Payment status is current at report read time; period membership is based on accounting postingDate.',
    );
  });

  it('a CancellationCharge is separate: never added to invoiced sales, credit notes or the net after credit notes', () => {
    const pure = bProd('sales-financial-report.ts');
    // the net-after-credit-notes arithmetic touches ONLY the invoice and credit-note aggregates
    const start = pure.lastIndexOf('netSalesAfterCreditNotes: {');
    const netAfter = pure.slice(start, pure.indexOf('cancellationCharges: {', start));
    expect(netAfter).not.toMatch(/cancellationCharge/);
    expect(netAfter).toMatch(/salesNetExTax - creditNoteNetExTax/);
    expect(netAfter).toMatch(/aggregate\.outputTax - aggregate\.creditNoteTax/);
    expect(netAfter).toMatch(/aggregate\.invoicedTotal - aggregate\.creditNoteTotal/);
    // the charge's own net / tax / total come from the charge row itself
    expect(SQL).toMatch(/x\."netAmountMinor"/);
    expect(SQL).toMatch(/x\."taxAmountMinor"/);
  });

  it('the reconciliation covers ONLY the included source kinds (never every journal that hits a revenue account)', () => {
    const pure = bProd('sales-financial-report.ts');
    expect(pure).toMatch(/INVOICE_KINDS/);
    expect(pure).toMatch(/\[SALES_SOURCE_KINDS\.creditNote\]/);
    expect(pure).toMatch(/\[SALES_SOURCE_KINDS\.cancellationCharge\]/);
    expect(pure).toMatch(/REPORT_SALES_GL_MISMATCH/);
    // each of the six controls pairs ITS OWN kind set with ITS OWN account and side — a swapped kind set,
    // account or direction on any one of them would reconcile the wrong GL lines
    const glNets = [
      ...pure.matchAll(
        /glNet\(\s*gl,\s*(\[?[\w.]+\]?),\s*SALES_ACCOUNT_KEYS\.(\w+),\s*'(credit|debit)',?\s*\)/g,
      ),
    ].map((m) => `${m[1]} | ${m[2]} | ${m[3]}`);
    expect(glNets).toEqual([
      'INVOICE_KINDS | salesRevenue | credit',
      'INVOICE_KINDS | outputTax | credit',
      '[SALES_SOURCE_KINDS.creditNote] | salesRevenue | debit',
      '[SALES_SOURCE_KINDS.creditNote] | outputTax | debit',
      '[SALES_SOURCE_KINDS.cancellationCharge] | cancellationChargeRevenue | credit',
      '[SALES_SOURCE_KINDS.cancellationCharge] | outputTax | credit',
    ]);
    // the GL rows come only from the selected (sel → fdocs) journals
    expect(SQL).toMatch(/FROM fdocs d\s+JOIN "journal_line" jl/);
  });

  it('malformed financial data fails closed with a named, non-disclosing domain error', () => {
    const repo = bProd('sales-financial-report.repository.ts');
    for (const code of ['REPORT_SALES_SOURCE_INTEGRITY', 'REPORT_CURRENCY_MISMATCH']) {
      expect(repo).toContain(code);
    }
    for (const check of [
      'orphanJournals',
      'branchMismatchLines',
      'currencyMismatchDocuments',
      'duplicateRevenueJournals',
      'revenueKindMismatches',
      'creditNotesWithoutRevenueJournal',
    ]) {
      expect(SQL, check).toContain(`AS "${check}"`);
      expect(repo, check).toContain(check);
    }
    expect(repo).toMatch(/resolveCompanyReportAuthority\(/);
  });

  it('read-only and side-effect free: no audit, outbox, realtime, idempotency, clock or event', () => {
    for (const n of B_PRODUCTION) {
      expect(bProd(n), n).not.toMatch(
        /AuditWriter|audit\.record|OutboxWriter|\.enqueue\(|realtime|Idempotent|IdempotencyKey|emit\(|publish\(|SystemClock|Clock\b|setTimeout|setInterval/,
      );
      expect(bProd(n), n).not.toMatch(/businessType|business_type|BusinessType|templateKey/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B correction 1 — the line discount has an IMMUTABLE authority (the order snapshot fingerprint)', () => {
  const proof = (): string => bProd(PROOF);
  const migrations = join(ROOT, 'packages/db/prisma/migrations');

  it('the authority is the order fingerprint: the ONE shared fingerprint function is imported, nothing is hashed locally', () => {
    const src = proof();
    expect(
      [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(),
      'the proof module imports exactly the fingerprint function and the exact text parser',
    ).toEqual(['../orders/commercial-snapshot.js', './report-money.js']);
    expect(src).toMatch(/import \{\s*computeCommercialSnapshotFingerprintByVersion,/);
    expect(src).toMatch(/computeCommercialSnapshotFingerprintByVersion\(\s*integer\(/);
    // the recomputed digest must EQUAL the stored one — and only then does the invoice contribute
    expect(src).toMatch(
      /recomputed !== text\(order\.commercialSnapshotFingerprint\)\) return null;/,
    );
    // no second hashing / canonicalisation implementation
    expect(bareCode(read(join(DIR, PROOF)))).not.toMatch(
      /createHash|node:crypto|\bcanonicalize\b|sha256|\.digest\(|JSON\.stringify|\bcrypto\b/,
    );
    // the invoice's branch is the order's ORIGIN branch (a database-enforced fact of issuance)
    expect(src).toMatch(/order\.originBranchId !== facts\.branchId\) return null/);
  });

  it('the proof is PURE: no database, no clock, no catalogue, no current price, no tax / amount recomputation', () => {
    const code = bareCode(read(join(DIR, PROOF)));
    expect(code).not.toMatch(
      /\bawait\b|\basync\b|\$queryRaw|\btx\b|\bprisma\b|\bnew Date\b|Date\.now|SystemClock|catalog|\bprice\b|mulRatio|divRound|capAllocate|taxRate|rate_bps/i,
    );
    // `rateBps` appears exactly once — as a pass-through column of the hashed snapshot, never as arithmetic
    expect((code.match(/rateBps/g) ?? []).length).toBe(1);
    expect(code).not.toMatch(/rateBps\s*[*/+-]|[*/+-]\s*rateBps/);
  });

  it('the fingerprint is VERIFIED at issuance and FROZEN afterwards — the facts the authority rests on (database + frozen 3b.3 code)', () => {
    const issuance = read(join(SRC, 'modules/orders/invoice-issuance.repository.ts'));
    expect(issuance).toMatch(/computeCommercialSnapshotFingerprintByVersion\(/);
    expect(issuance).toMatch(/recomputedFingerprint !== order\.commercialSnapshotFingerprint/);
    expect(issuance).toMatch(/ORDER_FINGERPRINT_MISMATCH/);
    // the shared function itself is the frozen implementation
    expect(sha(join(SRC, 'modules/orders/commercial-snapshot.ts'))).toBe(
      '908e35d619023eb8c40d8ec9ba3fa2be2ab733e9e78e517a3a33d38229fb3da7',
    );
    const orders = read(join(migrations, '20260920120000_orders_invoice_numbering/migration.sql'));
    // frozen in the one-time issuance transition AND after issuance (two occurrences)
    expect(
      (
        orders.match(
          /NEW\."commercialSnapshotFingerprint" IS NOT DISTINCT FROM OLD\."commercialSnapshotFingerprint"/g,
        ) ?? []
      ).length,
    ).toBe(2);
    expect(orders).toMatch(/commercial fields \(including orderNumber\) are frozen once issued/);
    const fiscal = join(migrations, '20260921120000_sale_tax_fiscal_policy_v1v2/migration.sql');
    expect(read(fiscal)).toMatch(
      /commercialSnapshotFingerprintVersion is immutable after creation/,
    );
    expect(sha(fiscal)).toBe('c96605188405ee71452e3789471892169b36b280673171fdcb2ebe745c32a5cb');
  });

  it('the statement ships the order snapshot and its lines (by linePosition) as the evidence — joined by primary key, tenant + company explicit', () => {
    expect(SQL).toMatch(/'invoiceLineSets', COALESCE/);
    expect(SQL).toMatch(/ORDER BY ol\."linePosition"/);
    expect(SQL).toMatch(
      /o\."id" = d\."orderId" AND o\."tenantId" = \$1::uuid AND o\."companyId" = \$2::uuid/,
    );
    expect(SQL).toMatch(/ORDER BY ils\."invoiceId"/);
  });

  it('NOTHING is returned before the line sets are proven: verify → integrity gate → figures, inside read()', () => {
    const repo = bProd('sales-financial-report.repository.ts');
    const body = repo.slice(
      repo.indexOf('private async read('),
      repo.indexOf('private branchRows('),
    );
    const verify = body.indexOf('verifyInvoiceLineSets(json.invoiceLineSets)');
    const gate = body.indexOf('assertSourceIntegrity(');
    const ret = body.indexOf('return {\n      json,');
    expect(verify).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(verify);
    expect(ret).toBeGreaterThan(gate);
    // both new check names are integrity failures (non-disclosing: a name, never a figure)
    expect(repo).toMatch(/\['invoiceLineSetMismatches', proof\.mismatches\]/);
    expect(repo).toMatch(
      /\['lineDiscountCrossCheckMismatches', lineDiscountCrossCheckMismatches\]/,
    );
    expect(repo).toMatch(/lineDiscountCrossCheckFailures\(parseAggregates\(json\), proof\)/);
    // the statement's own per-branch line discount is cross-checked against the PROVEN lines
    expect(proof()).toMatch(
      /a\.lineDiscount !== \(proof\.lineDiscountByBranch\.get\(a\.branchId\) \?\? 0n\)/,
    );
  });

  it('the line discount is never sourced from unverified or mutable state: no catalogue / price / rate module is imported by any Sales file', () => {
    for (const n of B_PRODUCTION) {
      const imports = [...bProd(n).matchAll(/from '([^']+)'/g)]
        .map((m) => m[1]!)
        .filter((i) => i !== '../catalog/catalog-write.helpers.js');
      for (const i of imports) {
        expect(i, n + ' imports ' + i).not.toMatch(
          /catalog(?!-write)|pricing|price|tax-resolution|localization|uom|variant|product/i,
        );
      }
    }
    // the only reach into the catalogue module is the shared UUID guard the Trial Balance already uses
    expect(bProd('sales-financial-report.repository.ts')).toMatch(
      /import \{ assertUuid \} from '\.\.\/catalog\/catalog-write\.helpers\.js';/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B correction 2 — the Sales period cap: 90 calendar days, both bounds inclusive', () => {
  const range = (): string => bProd(RANGE);

  it('the limit is exactly 90 INCLUSIVE days: `> 90n` on an inclusive count (+ 1n)', () => {
    expect(range()).toMatch(/export const SALES_REPORT_MAX_DAYS = 90n;/);
    expect(range()).toMatch(/inclusiveCivilDays\(range\) > SALES_REPORT_MAX_DAYS/);
    expect(range()).toMatch(/civilDayNumber\(range\.to\) - civilDayNumber\(range\.from\) \+ 1n/);
    expect(range()).toMatch(/'REPORT_RANGE_TOO_LARGE'/);
    expect(parseSalesReportRange({ from: '2026-06-01', to: '2026-08-29' })).toEqual({
      from: '2026-06-01',
      to: '2026-08-29',
    });
    expect(() => parseSalesReportRange({ from: '2026-06-01', to: '2026-08-30' })).toThrow(
      /at most 90 calendar days/,
    );
  });

  it('it is PURE civil arithmetic: no Date, no timezone, no Intl, no Math, no Number, no process environment', () => {
    expect(bareCode(read(join(DIR, RANGE)))).not.toMatch(
      /\bDate\b|getTime|toISOString|\bIntl\b|\bTZ\b|\bMath\b|\bNumber\b|getTimezoneOffset|setHours|process\.env|parseInt|parseFloat/,
    );
  });

  it('it reuses the Checkpoint A strict civil-date parser and never re-parses a date', () => {
    expect(range()).toMatch(
      /import \{ parseReportDateRange, type ReportDateRange \} from '\.\/report-date-range\.js';/,
    );
    expect(range()).toMatch(/const range = parseReportDateRange\(input\);/);
    expect(bareCode(read(join(DIR, RANGE)))).not.toMatch(
      /isFiscalDate|FISCAL_DATE_RE|\.test\(|\.match\(/,
    );
  });

  it('it is enforced BELOW any controller — by the service AND the repository (the only door to the database), never by a controller', () => {
    const svc = bProd('sales-financial-report.service.ts');
    const repo = bProd('sales-financial-report.repository.ts');
    expect((svc.match(/parseSalesReportRange\(/g) ?? []).length).toBe(2);
    expect((repo.match(/parseSalesReportRange\(/g) ?? []).length).toBe(1);
    // …and neither bypasses it with the uncapped Checkpoint A parser
    expect(svc).not.toMatch(/parseReportDateRange/);
    expect(repo).not.toMatch(/parseReportDateRange/);
    // the repository enforces it before the database is touched
    expect(repo.indexOf('parseSalesReportRange(')).toBeLessThan(repo.indexOf('this.readScoped('));
    // no controller / DTO exists anywhere in the module (a controller-level-only rule is impossible)
    expect(
      walk(DIR)
        .map((f) => f.slice(DIR.length + 1))
        .filter(notF)
        .filter((n) => /controller|dto|guard|interceptor|module\.ts$/i.test(n)),
    ).toEqual([]);
  });

  it('the Trial Balance has NO such cap: nothing of it references the Sales range, and its parser still accepts a five-year period', () => {
    for (const f of [
      'trial-balance.ts',
      'trial-balance.sql.ts',
      'trial-balance.repository.ts',
      'trial-balance.service.ts',
      'report-date-range.ts',
      'report-money.ts',
      'reporting.repository.ts',
    ]) {
      expect(read(join(DIR, f)), f).not.toMatch(
        /sales-report-range|SALES_REPORT_MAX_DAYS|REPORT_RANGE_TOO_LARGE|inclusiveCivilDays|parseSalesReportRange|SALES_REPORT_MAX_DOCUMENTS|REPORT_RESULT_TOO_LARGE|candidateDocuments/,
      );
    }
    const five = { from: '2021-01-01', to: '2026-12-31' };
    expect(parseReportDateRange(five)).toEqual(five); // the Checkpoint A (Trial Balance) contract: uncapped
    expect(() => parseSalesReportRange(five)).toThrow(/at most 90 calendar days/); // the Sales one is not
  });

  it('the cap is Sales-specific: Tender Totals carries NO calendar cap and imports none of the Sales rules (its own movement-density guard, owner ruling TT-1, is Checkpoint C’s and is pinned there)', () => {
    expect(range()).not.toMatch(/tender/i);
    for (const n of [
      'tender-totals-report.ts',
      'tender-totals-report.sql.ts',
      'tender-totals-report.repository.ts',
      'tender-totals-report.service.ts',
    ]) {
      expect(read(join(DIR, n)), n).not.toMatch(
        /sales-report-range|SALES_REPORT_MAX_DAYS|SALES_REPORT_MAX_DOCUMENTS|REPORT_RANGE_TOO_LARGE|parseSalesReportRange/,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B density — the v1 document limit: 25 000 financial documents per invocation, ONE statement, a short-circuiting first stage', () => {
  const repoSrc = (): string => bProd('sales-financial-report.repository.ts');
  /** the text of ONE CTE: from its `name AS (` to the next top-level CTE */
  const cte = (name: string, next: string): string => {
    const a = SQL.indexOf(`\n${name} AS (`);
    const b = SQL.indexOf(`\n${next} AS (`, a + 1);
    expect(a, `CTE ${name}`).toBeGreaterThan(-1);
    expect(b, `CTE ${next}`).toBeGreaterThan(a);
    return SQL.slice(a, b);
  };

  it('the limit is ONE authoritative constant, exactly 25 000, defined once and used by the statement and the repository', () => {
    expect(SALES_REPORT_MAX_DOCUMENTS).toBe(25_000);
    expect(bProd(RANGE)).toMatch(/export const SALES_REPORT_MAX_DOCUMENTS = 25_000;/);
    // defined exactly once in the whole module
    for (const n of B_PRODUCTION) {
      if (n === RANGE) continue;
      expect(bProd(n), n).not.toMatch(
        /SALES_REPORT_MAX_DOCUMENTS = |\b25_000\b|\b25000\b|\b25,000\b/,
      );
    }
    expect(bProd('sales-financial-report.sql.ts')).toMatch(
      /import \{ SALES_REPORT_MAX_DOCUMENTS \} from '\.\/sales-report-range\.js';/,
    );
    expect(repoSrc()).toMatch(
      /protected readonly maxDocuments: number = SALES_REPORT_MAX_DOCUMENTS;/,
    );
    expect(repoSrc()).toMatch(/maxDocuments: this\.maxDocuments,/);
    // never scaled, divided or applied per branch
    expect(repoSrc()).not.toMatch(
      /maxDocuments\s*[*/+-]|[*/+-]\s*this\.maxDocuments|branchCount|perBranch/,
    );
  });

  it('the FIRST stage inspects at most limit + 1 candidates: one LIMIT 25001 inside `cand`, the gate `<= 25000` in EXACTLY the four stages that must not run above it', () => {
    expect((SQL.match(/LIMIT 25001/g) ?? []).length).toBe(1);
    // the gate comparison sits in `docs`, in the evidence stage (`ils`), in the GL aggregate (`gl`) and in the
    // branch-mismatch scan of the integrity stage (`ic`) — each is skipped AS A WHOLE above the limit
    expect((SQL.match(/<= 25000\b/g) ?? []).length).toBe(4);
    const GATE = '(SELECT g."n" FROM gate g) <= 25000';
    expect(cte('docs', 'fdocs')).toContain(GATE);
    expect(cte('ils', 'ldb')).toContain(GATE);
    expect(cte('gl', 'ic')).toContain(GATE);
    expect(SQL.slice(SQL.indexOf('\nic AS ('))).toMatch(
      /jl\."branchId" IS DISTINCT FROM d\."branchId" AND \(SELECT g\."n" FROM gate g\) <= 25000/,
    );
    const cand = cte('cand', 'gate');
    expect(cand).toMatch(/LIMIT 25001\n\),$/);
    // the limit is the LAST thing of the stage: the branch predicate is applied BEFORE it (a branch counts only itself)
    expect(
      cand.indexOf(
        'WHERE ($5::uuid IS NULL OR COALESCE(i."branchId", n."branchId", x."branchId") = $5::uuid)',
      ),
    ).toBeGreaterThan(-1);
    expect(cand.indexOf('$5::uuid')).toBeLessThan(cand.indexOf('LIMIT 25001'));
    expect(cte('gate', 'docs')).toMatch(/SELECT COUNT\(\*\) AS "n" FROM cand\n/);
  });

  it('what is counted: the sealed journals of the four document kinds joined to their documents — never journal lines, never a payment / refund / advance / settlement', () => {
    const cand = cte('cand', 'gate');
    expect(cand).toMatch(/FROM sel s/);
    for (const t of ['invoice', 'credit_note', 'cancellation_charge']) {
      expect(cand).toMatch(new RegExp(`LEFT JOIN "${t}"`));
    }
    expect(cand).not.toMatch(/journal_line|"payment|refund|advance|settlement|"order"|order_line/i);
    // the candidate journals are `sel`: exactly the four kinds (pinned elsewhere) — one journal per document
    expect(cte('sel', 'cand')).toMatch(
      /je\."sourceKind" IN \('invoice_ar', 'walk_in_sale', 'credit_note', 'cancellation_charge'\)/,
    );
  });

  it('every HEAVY stage reads the GATED candidates: `cand` is read only by `gate` and `docs`, and `docs` carries the One-Time-Filter comparison', () => {
    expect((SQL.match(/FROM cand\b/g) ?? []).length).toBe(2);
    expect(cte('docs', 'fdocs')).toMatch(
      /SELECT c\.\*\n\s+FROM cand c\n\s+WHERE \(SELECT g\."n" FROM gate g\) <= 25000/,
    );
    // the heavy sources are read through `fdocs` / `docs`, never through `cand` or `sel` directly
    for (const stage of ['ils', 'br', 'st', 'gl', 'ic']) {
      const next = { ils: 'ldb', br: 'st', st: 'gl', gl: 'ic', ic: 'SELECT json_build_object' }[
        stage
      ]!;
      const a = SQL.indexOf(`\n${stage} AS (`);
      const b = SQL.indexOf(stage === 'ic' ? next : `\n${next} AS (`, a + 1);
      const text = SQL.slice(a, b);
      expect(text, `${stage} reads the gated candidates`).not.toMatch(
        /FROM cand\b|FROM sel\b|JOIN cand\b/,
      );
    }
    // the evidence, the fingerprint payload and the source / GL aggregates are all downstream of `fdocs`
    expect(cte('ils', 'ldb')).toMatch(/FROM fdocs d/);
    expect(cte('br', 'st')).toMatch(/FROM fdocs d/);
    expect(cte('gl', 'ic')).toMatch(/FROM fdocs d/);
  });

  it('ONE statement, one snapshot: no second SQL statement, no COUNT query in the repository or the service', () => {
    const repo = repoSrc();
    expect((repo.match(/\$queryRaw/g) ?? []).length).toBe(1);
    expect((repo.match(/\$executeRaw/g) ?? []).length).toBe(0);
    expect(repo).not.toMatch(/\bCOUNT\s*\(|count\(\*\)|SELECT COUNT/i);
    expect(bProd('sales-financial-report.service.ts')).not.toMatch(
      /\bCOUNT\s*\(|count\(\*\)|\$queryRaw/i,
    );
    // the count comes back in the same JSON document
    expect(SQL).toMatch(/'candidateDocuments', \(SELECT g\."n" FROM gate g\)/);
  });

  it('the repository rejects BEFORE it reads anything else: REPORT_RESULT_TOO_LARGE (422) right after the company check', () => {
    const repo = repoSrc();
    const body = repo.slice(
      repo.indexOf('private async read('),
      repo.indexOf('private branchRows('),
    );
    const company = body.indexOf("throw new NotFoundError('company')", body.indexOf('JSON.parse'));
    const guard = body.indexOf('json.candidateDocuments > this.maxDocuments');
    const authority = body.indexOf('resolveCompanyReportAuthority(');
    const verify = body.indexOf('verifyInvoiceLineSets(json.invoiceLineSets)');
    const integrity = body.indexOf('assertSourceIntegrity(');
    expect(company).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(company);
    expect(authority).toBeGreaterThan(guard);
    expect(verify).toBeGreaterThan(guard);
    expect(integrity).toBeGreaterThan(verify);
    expect(body).toMatch(/'REPORT_RESULT_TOO_LARGE',[\s\S]{0,400}422,/);
    // the fingerprint proof of an ACCEPTED report is not bypassable: it is unconditional after the guard
    expect(body.slice(guard, verify)).not.toMatch(/\bif\b[^{]*proof|return\b/);
  });

  it('the Trial Balance has no document limit, no result-size error and no candidate count', () => {
    for (const f of [
      'trial-balance.ts',
      'trial-balance.sql.ts',
      'trial-balance.repository.ts',
      'trial-balance.service.ts',
    ]) {
      expect(read(join(DIR, f)), f).not.toMatch(
        /SALES_REPORT_MAX_DOCUMENTS|REPORT_RESULT_TOO_LARGE|candidateDocuments|maxDocuments/,
      );
    }
  });

  it('the dense gate itself pins its thresholds: exactly 25 000 accepted, one more rejected three times, the <10 s local engineering gate, the short-circuit EXPLAIN', () => {
    const dense = read(join(DIR, 'sales-financial-report.dense-window.integration.test.ts'));
    expect(dense).toMatch(
      /const INVOICES = Number\(process\.env\['SALES_DENSE_INVOICES'\] \?\? SALES_REPORT_MAX_DOCUMENTS\);/,
    );
    expect(dense).toMatch(/toBeLessThan\(10_000\); \/\/ the local engineering gate/);
    expect(dense).toMatch(/for \(let r = 1; r <= 3; r \+= 1\)/);
    expect(dense).toMatch(/REPORT_RESULT_TOO_LARGE/);
    expect(dense).toMatch(/EXPLAIN \(ANALYZE, BUFFERS\) at 25 001/);
    expect(dense).toMatch(/Local test-container benchmark; not production capacity\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('B — documentation records the Sales report and its limits', () => {
  const planPath = join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md');

  it('the plan records Checkpoint B: the source kinds, the period authority, the reconciliation and the measured query-plan decision', () => {
    expect(existsSync(planPath)).toBe(true);
    const plan = read(planPath);
    for (const k of ['invoice_ar', 'walk_in_sale', 'credit_note', 'cancellation_charge']) {
      expect(plan, k).toContain(k);
    }
    expect(plan).toMatch(/## 10\. Checkpoint B/);
    expect(plan).toMatch(/Payment status is current at report read time/);
    expect(plan).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(plan).not.toMatch(/<<[A-Z0-9_]+>>/);
  });

  it('the decision log carries the 3b.10-SR row exactly once', () => {
    const log = read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
    expect(log.split('\n').filter((l) => l.startsWith('| **3b.10-SR**'))).toHaveLength(1);
  });

  it('the plan and the decision log record the density guard: 90 days AND 25 000 documents, the blocked 100k evidence, the 25k timings and the 25 001 short-circuit', () => {
    const plan = read(planPath);
    expect(plan).toMatch(/### Owner closure — the density guard: Sales Financial Report v1 limits/);
    expect(plan).toContain('`SALES_REPORT_MAX_DOCUMENTS = 25_000`');
    expect(plan).toContain('`REPORT_RESULT_TOO_LARGE` (**422**)');
    expect(plan).toMatch(/at most \*\*90 calendar days, both bounds inclusive\*\*/);
    expect(plan).toMatch(/at most \*\*25 000 financial documents\*\*/);
    // what is and is not a document, and the two routes
    expect(plan).toMatch(/Invoice, a CreditNote or a CancellationCharge/);
    expect(plan).toMatch(
      /Payment, a Refund, a CustomerAdvance, a PaymentAttempt and a SettlementApplication/,
    );
    expect(plan).toMatch(/\*\*company route\*\* counts the whole company/);
    expect(plan).toMatch(/\*\*branch route\*\* counts only the requested branch/);
    // the evidence, the measurements and the disclaimer
    expect(plan).toMatch(/100 000 invoices of one company inside one 90-day window/);
    expect(plan).toMatch(/BLOCKED evidence/);
    expect(plan).toMatch(/exactly 25 000 documents/);
    expect(plan).toMatch(/< 10 s local engineering gate/);
    expect(plan).toMatch(/Rejection at 25 001 documents/);
    expect(plan).toMatch(/never executed\*\*; the same under all six planner variants/);
    expect(plan).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(plan).toMatch(/The \*\*Trial Balance remains uncapped\*\*/);
    const log = read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
    expect(log.split('\n').filter((l) => l.startsWith('| **3b.10-DG**'))).toHaveLength(1);
    expect(log).toMatch(
      /`SALES_REPORT_MAX_DOCUMENTS = 25_000`, `REPORT_RESULT_TOO_LARGE`, \*\*422\*\*/,
    );
  });
  it('the plan and the decision log record the line-discount authority contract and the 90-day cap (owner corrections 1 and 2)', () => {
    const plan = read(planPath);
    // correction 1 — the authority, the proof, the failure mode, the absence of a schema gap
    expect(plan).toMatch(/### Immutable discount source — the authority and its integrity proof/);
    expect(plan).toMatch(/commercialSnapshotFingerprint/);
    expect(plan).toMatch(/computeCommercialSnapshotFingerprintByVersion/);
    expect(plan).toMatch(/invoiceLineSetMismatches/);
    expect(plan).toMatch(/lineDiscountCrossCheckMismatches/);
    expect(plan).toMatch(/not a count and not a sum/);
    expect(plan).toMatch(/No schema gap was found; no migration is created/);
    // correction 2 — 90 inclusive civil days, the basis, the scope of the rule
    expect(plan).toMatch(
      /### Owner correction 2 — the Sales period cap is 90 calendar days, inclusive/,
    );
    expect(plan).toMatch(/REPORT_RANGE_TOO_LARGE/);
    expect(plan).toMatch(/\*\*at most 90 calendar days, both bounds inclusive\*\*/);
    expect(plan).toMatch(
      /first-release operational safety limit\*\*, not a production throughput SLA/,
    );
    expect(plan).toMatch(/\*\*Trial Balance remains uncapped\*\*/);
    expect(plan).toMatch(/\*\*Tender Totals cap remains undecided\*\*/);
    // the historical measurement and the superseded recommendation are kept, not rewritten
    expect(plan).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(plan).toMatch(/Recommendation as first delivered \(SUPERSEDED/);
    const log = read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
    expect(log.split('\n').filter((l) => l.startsWith('| **3b.10-CC**'))).toHaveLength(1);
    expect(log).toMatch(
      /Correction 2 — the Sales period cap is 90 calendar days, both bounds inclusive/,
    );
  });
});
