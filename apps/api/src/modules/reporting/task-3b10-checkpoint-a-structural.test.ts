import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRIAL_BALANCE_SQL } from './trial-balance.sql.js';

/**
 * Task 3b.10 Checkpoint A — structural pins: reporting foundation + Trial Balance.
 *
 * These pin the owner rulings (OD-1 … OD-8 and the frozen semantics A–D) so that the foundation
 * cannot drift into a controller, a permission, a migration, a rollup table, a branch/POS
 * dimension, a source-kind filter, pagination or any later checkpoint's report without a
 * failing test. Each pin is sensitivity-tested (a deliberate violation must turn it red).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..'); // apps/api/src
const DIR = HERE; // apps/api/src/modules/reporting
const read = (abs: string): string => readFileSync(abs, 'utf8');
const sha = (abs: string): string =>
  createHash('sha256').update(read(abs).replace(/\r\n/g, '\n')).digest('hex');
const rel = (abs: string): string => relative(ROOT, abs).replace(/\\/g, '/');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
/** code with comments AND string / template literals blanked (for token-level scans) */
function bareCode(src: string): string {
  return stripComments(src).replace(
    /'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"/g,
    "''",
  );
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}
const isTest = (abs: string): boolean => /\.(test|spec)\.ts$/.test(abs);

/** the CLOSED set of files Checkpoint A owns inside the reporting module */
/** the files Checkpoint A owns (its production files are additionally hash-frozen by the Checkpoint B pins) */
const A_FILES = [
  'report-date-range.test.ts',
  'report-date-range.ts',
  'report-money.test.ts',
  'report-money.ts',
  'reporting.repository.ts',
  'task-3b10-checkpoint-a-structural.test.ts',
  'trial-balance.integration.test.ts',
  'trial-balance.query-plan.integration.test.ts',
  'trial-balance.repository.ts',
  'trial-balance.service.ts',
  'trial-balance.sql.ts',
  'trial-balance.test.ts',
  'trial-balance.ts',
];
/** the files Checkpoint B (the Sales Financial Report) owns — the module is a CLOSED set of A + B */
const B_FILES = [
  'sales-financial-report.dense-window.integration.test.ts',
  'sales-financial-report.integration.test.ts',
  'sales-financial-report.query-plan.integration.test.ts',
  'sales-financial-report.repository.ts',
  'sales-financial-report.service.ts',
  'sales-financial-report.sql.ts',
  'sales-financial-report.test.ts',
  'sales-financial-report.ts',
  // Checkpoint B corrections — the line-discount authority and the Sales 90-day period cap
  'sales-invoice-line-set-proof.test.ts',
  'sales-invoice-line-set-proof.ts',
  'sales-report-range.test.ts',
  'sales-report-range.ts',
  'task-3b10-checkpoint-b-structural.test.ts',
];
/** the files Checkpoint C (Tender Totals) owns — the module is a CLOSED set of A + B + C */
const C_FILES = [
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
/** the files Checkpoint D (Receivables current state) owns — the module is a CLOSED set of A + B + C + D */
const D_FILES = [
  'receivables-report.integration.test.ts',
  'receivables-report.query-plan.integration.test.ts',
  'receivables-report.repository.ts',
  'receivables-report.service.ts',
  'receivables-report.sql.ts',
  'receivables-report.test.ts',
  'receivables-report.ts',
  'task-3b10-checkpoint-d-structural.test.ts',
];
/** the files Checkpoint E (Customer Advances + Unapplied Receipts current state) owns — the module is a CLOSED set of A + B + C + D + E */
const E_FILES = [
  'customer-liabilities-report.integration.test.ts',
  'customer-liabilities-report.query-plan.integration.test.ts',
  'customer-liabilities-report.repository.ts',
  'customer-liabilities-report.service.ts',
  'customer-liabilities-report.sql.ts',
  'customer-liabilities-report.test.ts',
  'customer-liabilities-report.ts',
  'task-3b10-checkpoint-e-structural.test.ts',
];
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
const OWNED = [...A_FILES, ...B_FILES, ...C_FILES, ...D_FILES, ...E_FILES, ...F_OWNED].sort();
/** Checkpoint A's own production files — the vocabulary pins that name a LATER checkpoint's report apply to these */
const A_PRODUCTION_NAMES = A_FILES.filter((n) => !/\.test\.ts$/.test(n));
/** EVERY file in the module, whatever its extension (a `.bak` / `.out` artifact must be seen too) */
const ALL_FILES = walk(DIR);
const FILES = ALL_FILES.filter((f) => f.endsWith('.ts'));
const PRODUCTION = FILES.filter((f) => !isTest(f));
const prod = (name: string): string => stripComments(read(join(DIR, name)));
/** the executable SQL text, comment-free by construction (it is the runtime string) */
const SQL = TRIAL_BALANCE_SQL;

// ═══════════════════════════════════════════════════════════════════════════════
describe('A — scope: exactly the Checkpoint A files exist; nothing of a later checkpoint', () => {
  it('the reporting module is a CLOSED set of files (no Sales / Tender / AR / Advances report, no other artifact)', () => {
    expect(ALL_FILES.map((f) => f.slice(DIR.length + 1).replace(/\\/g, '/')).sort()).toEqual(OWNED);
  });

  it('no controller, no Nest module, no public route and no decorator wiring exists for reporting', () => {
    for (const f of PRODUCTION.filter((x) => notF(x.slice(DIR.length + 1)))) {
      expect(f, rel(f)).not.toMatch(/\.(controller|module|guard|interceptor|dto)\.ts$/);
      expect(stripComments(read(f)), rel(f)).not.toMatch(
        /@Controller\b|@Module\b|@Get\(|@Post\(|@Put\(|@Patch\(|@Delete\(|@UseGuards\b|@RequirePermission\b|@ScopedParam\b|@Public\b|@Idempotent\b/,
      );
    }
  });

  it('nothing outside the reporting module references it: no module registration, no import', () => {
    const outside = walk(SRC)
      .filter((f) => f.endsWith('.ts') && !f.startsWith(DIR))
      .filter((f) => !/task-3b10-/.test(f))
      // the six amended 3b.9 pins name `modules/reporting/` on purpose: they permit ONLY the read-only
      // module and still forbid a controller / module in it
      .filter((f) => !/task-3b9-checkpoint-[a-f]-structural\.test\.ts$/.test(f));
    for (const f of outside) {
      expect(withoutFRegistration(read(f)), rel(f)).not.toMatch(
        /modules\/reporting\/|TrialBalanceRepository|TrialBalanceService|ReportingModule|ReportingRepository/,
      );
    }
    expect(withoutFRegistration(read(join(SRC, 'app.module.ts')))).not.toMatch(
      /reporting|Reporting/,
    );
  });

  it('no /reports route anywhere in the API', () => {
    for (const f of walk(SRC).filter(
      (x) => x.endsWith('.controller.ts') && !(x.startsWith(DIR) && !notF(x.slice(DIR.length + 1))),
    )) {
      expect(read(f), rel(f)).not.toMatch(/@Controller\([^)]*reports?\b/i);
      expect(read(f), rel(f)).not.toMatch(/['"`]reports?\//i);
    }
  });

  it('no Task 3b.11 / tagging work anywhere in the reporting code; Checkpoint A itself carries no later report vocabulary', () => {
    for (const f of PRODUCTION) {
      expect(read(f), rel(f)).not.toMatch(/3b\.11|phase-3-complete/i);
    }
    // (Checkpoint B legitimately adds the Sales report — its own pins guard that surface — so the
    // "no Sales / credit-note / refund / tender vocabulary" scan covers Checkpoint A's own files)
    for (const name of A_PRODUCTION_NAMES) {
      expect(prod(name), name).not.toMatch(
        /tender[_ -]?totals?|receivables?[_ -]?report|advances?[_ -]?report|sales[_ -]?report|SalesFinancial|CreditNote|credit_note|\brefund\b/i,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('A — OD-1: no new permission, no migration, no schema change', () => {
  const migrations = join(ROOT, 'packages/db/prisma/migrations');
  const migrationDirs = (): string[] => readdirSync(migrations).filter((n) => !n.endsWith('.toml'));

  it('there is NO migration 50: exactly 49 migrations, the last is the frozen Task 3b.8 one', () => {
    const all = migrationDirs().sort();
    expect(all).toHaveLength(49);
    expect(all[all.length - 1]).toBe('20261010120000_phase_3b8_currency_and_release_integrity');
  });

  it('schema.prisma and the migration lock are byte-unchanged (no reporting table, no index, no column)', () => {
    expect(sha(join(ROOT, 'packages/db/prisma/schema.prisma'))).toBe(
      '15ef99cee245e0cc64166ab6a5156767b4795a0a7b763435207514945ea37459',
    );
    expect(sha(join(migrations, 'migration_lock.toml'))).toBe(
      '99836963713b4f5b269ad49af0ed3d7b0b2e336115c2f92dc9ac683d139d0900',
    );
  });

  it('the permission registry and the default role templates are byte-unchanged — no grant was added or changed', () => {
    expect(sha(join(ROOT, 'packages/permissions/src/index.ts'))).toBe(
      '20f66e4258f62899b67471a4f0e64fe84f8098a2dffe9a4b6575734729ed4c42',
    );
    expect(sha(join(SRC, 'modules/platform/system-roles.ts'))).toBe(
      '977d2e6bd6e215b70d034ce6b6def9e3ff97eb282555541c271ce278028d14f0',
    );
  });

  it('no reports:view / reporting:view / financial_reports:view is registered or granted anywhere (migrations, seed, role templates)', () => {
    const FORBIDDEN =
      /['"`](?:reports:view|reports:tenant|reporting:view|financial_reports:view)['"`]/;
    for (const dir of migrationDirs()) {
      expect(read(join(migrations, dir, 'migration.sql')), dir).not.toMatch(FORBIDDEN);
    }
    expect(read(join(ROOT, 'packages/db/prisma/seed.ts'))).not.toMatch(FORBIDDEN);
    expect(read(join(SRC, 'modules/platform/system-roles.ts'))).not.toMatch(FORBIDDEN);
    for (const f of PRODUCTION) expect(read(f), rel(f)).not.toMatch(FORBIDDEN);
  });

  it('the accounting primitives Checkpoint A reads are untouched (posting engine, periods, accounts, company config, posting date, controller)', () => {
    const A = 'apps/api/src/modules/accounting/';
    const frozen: Record<string, string> = {
      'posting-engine.service.ts':
        '16ce70384a3522177f4038c79aadea563526c92ea5166ceddb3f222d8de4cbc0',
      'accounting-period.repository.ts':
        '76af83b834d9a9ad4c3d0a8e16f04c767af213ba01157cc1fb99fc10e714e99b',
      'account.repository.ts': 'f507314ba83ebfe44883e145ff88f96fe14394bd9dec1b9544063e60d3750b36',
      'company-financial-config.repository.ts':
        '941eecaff314812b27c442acaf4c22f11e6bf3711c2ac57914cfaba1e8787ea7',
      'posting-date.ts': '144f856b83bea35be60bb037789259c445cae6ee00e93de109199edf64c707f4',
      'accounting.controller.ts':
        '21a3010a5d3131504bd0fdc2032c61056921611413e7879c9a7863943bcd07e3',
    };
    for (const [file, hash] of Object.entries(frozen)) {
      expect(sha(join(ROOT, A, file)), file).toBe(hash);
    }
  });

  it('no reporting / rollup / summary table exists: no `rpt_` object in the schema or any migration, no DDL in the reporting code', () => {
    expect(read(join(ROOT, 'packages/db/prisma/schema.prisma'))).not.toMatch(
      /\brpt_|Rollup|rollup/,
    );
    for (const dir of migrationDirs()) {
      expect(read(join(migrations, dir, 'migration.sql')), dir).not.toMatch(/\brpt_[a-z_]+/i);
    }
    for (const f of PRODUCTION) {
      expect(stripComments(read(f)), rel(f)).not.toMatch(
        /CREATE\s+(?:TABLE|INDEX|VIEW|MATERIALIZED)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|REFRESH\s+MATERIALIZED/i,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('A — the Trial Balance statement: one read statement over the complete sealed GL', () => {
  it('is ONE read statement: a single top-level WITH … SELECT, no semicolon, no mutation keyword, no lock', () => {
    expect(SQL.trim().startsWith('WITH')).toBe(true);
    expect(SQL).not.toContain(';');
    expect(SQL).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|COPY|CALL|LOCK)\b/i,
    );
    expect(SQL).not.toMatch(/\bFOR\s+(?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i);
  });

  it('the repository runs exactly one report statement per call, only inside the read-only scoped transaction', () => {
    const repo = prod('trial-balance.repository.ts');
    expect((repo.match(/\$queryRaw(?:Unsafe)?\s*[<(]/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(
      /\$executeRaw|\$transaction|\.create\(|\.update\(|\.delete\(|\.upsert\(/,
    );
    expect(repo).toMatch(/this\.readScoped\(/);
    expect(repo).not.toMatch(/this\.scoped\(/);
    const base = prod('reporting.repository.ts');
    expect(base).toMatch(/SET LOCAL transaction_read_only = on/);
    expect((base.match(/\$executeRawUnsafe\(/g) ?? []).length).toBe(1);
  });

  it('reads ONLY journal_entry, journal_line, account (+ the one company row) — no source document', () => {
    const tables = [...SQL.matchAll(/\b(?:FROM|JOIN)\s+"([a-z_]+)"/gi)].map((m) => m[1]);
    expect([...new Set(tables)].sort()).toEqual([
      'account',
      'company',
      'journal_entry',
      'journal_line',
    ]);
    expect(SQL).not.toMatch(
      /"(?:invoice|order|order_line|payment|payment_allocation|customer_receivable|customer_advance|credit_note|refund|cancellation_charge|settlement_batch|customer_account_entry)"/,
    );
  });

  it('includes ALL sealed GL: there is NO sourceKind (or source id) predicate anywhere in the statement or the pure algorithm', () => {
    expect(SQL).not.toMatch(/sourceKind|sourceId|source_kind|source_id/i);
    for (const f of ['trial-balance.ts', 'trial-balance.repository.ts']) {
      expect(prod(f), f).not.toMatch(
        /sourceKind|sourceId|source_kind|walk_in_sale|invoice_ar|credit_note/,
      );
    }
  });

  it('counts SEALED entries only', () => {
    expect(SQL).toMatch(/je\."sealedAt" IS NOT NULL/);
  });

  it('postingDate is the ONLY period authority: opening < from, period >= from, excluded > to — and no document date is read', () => {
    // EXACT occurrence counts (a debit AND a credit column each for opening and for period), so a
    // boundary changed in only one of them cannot hide behind the other
    const count = (re: RegExp): number => (SQL.match(re) ?? []).length;
    expect(count(/je\."postingDate"\s*<\s*\$3::date/g)).toBe(2); // opening debit + credit
    expect(count(/je\."postingDate"\s*>=\s*\$3::date/g)).toBe(2); // period debit + credit
    expect(count(/je\."postingDate"\s*<=\s*\$4::date/g)).toBe(1); // the upper bound
    expect(count(/je\."postingDate"/g)).toBe(5); // and nothing else touches postingDate
    expect(SQL).not.toMatch(/je\."postingDate"\s*(?:<=\s*\$3|>\s*\$3|<\s*\$4|>=?\s*\$4)/);
    expect(SQL).not.toMatch(/invoiceDate|issuedAt|createdAt|accountingDate|occurredAt|updatedAt/);
    expect(SQL).not.toMatch(
      /AT TIME ZONE|timezone\(|::timestamp|now\(\)|current_date|CURRENT_TIMESTAMP/i,
    );
  });

  it('carries EXPLICIT tenant + company predicates on every table it touches (never RLS alone)', () => {
    for (const alias of ['je', 'jl', 'a']) {
      expect(SQL, `${alias}.tenantId`).toMatch(
        new RegExp(`${alias}\\."tenantId"\\s*=\\s*\\$1::uuid`),
      );
      expect(SQL, `${alias}.companyId`).toMatch(
        new RegExp(`${alias}\\."companyId"\\s*=\\s*\\$2::uuid`),
      );
    }
    expect(SQL).toMatch(/c\."tenantId" = \$1::uuid/);
    expect(SQL).toMatch(/c\."id" = \$2::uuid/);
  });

  it('has NO branch, POS-terminal, customer or shift dimension (company GL only) and no byBranch in the report', () => {
    expect(SQL).not.toMatch(/branch|posTerminal|customer|shift|register/i);
    for (const f of [
      'trial-balance.ts',
      'trial-balance.repository.ts',
      'trial-balance.service.ts',
    ]) {
      expect(prod(f), f).not.toMatch(/branch|posTerminal|byBranch|customer|shift/i);
    }
  });

  it('has NO pagination: no cursor, limit, offset, page — in the SQL, the repository, the service or the report type', () => {
    expect(SQL).not.toMatch(/\bLIMIT\b|\bOFFSET\b|\bFETCH\b|cursor|keyset/i);
    for (const f of [
      'trial-balance.ts',
      'trial-balance.repository.ts',
      'trial-balance.service.ts',
    ]) {
      expect(prod(f), f).not.toMatch(
        /\bcursor\b|\blimit\b|\boffset\b|nextCursor|\bpage(?:Size|Token)?\b|hasMore/i,
      );
    }
    expect(read(join(DIR, 'trial-balance.integration.test.ts'))).toContain(
      'there is no cursor, limit or page in the request or the response',
    );
  });

  it('orders deterministically: account code, then immutable key, then id — byte-wise collation', () => {
    expect(SQL).toMatch(
      /ORDER BY a\."displayCode" COLLATE "C" ASC NULLS LAST,\s*a\."key" COLLATE "C" ASC NULLS LAST,\s*a\."id" ASC NULLS LAST/,
    );
  });

  it('every aggregate leaves the database as TEXT (exact), never a number', () => {
    for (const col of [
      'openingDebit',
      'openingCredit',
      'periodDebit',
      'periodCredit',
      'currencyMismatch',
    ]) {
      expect(SQL, col).toMatch(new RegExp(`agg\\."${col}"::text\\s+AS "${col}"`));
    }
    expect(SQL).not.toMatch(
      /::(?:float|double|real|numeric\(|decimal|money)|\bROUND\(|\bTRUNC\(|\bCEIL|\bFLOOR/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('A — OD-2 / OD-4 / OD-7 / OD-8: date authority, no consolidation, no aging, no POS dimension', () => {
  it('the civil-date contract REUSES the repository primitive (isFiscalDate) and never builds a Date or a timezone conversion', () => {
    const src = prod('report-date-range.ts');
    expect(src).toMatch(/import \{ isFiscalDate \} from '@flower\/shared-types'/);
    for (const f of PRODUCTION) {
      expect(stripComments(read(f)), rel(f)).not.toMatch(
        /new Date\(|Date\.parse|Date\.UTC|Intl\.DateTimeFormat|toISOString|getTime\(|toLocale|moment|dayjs|luxon/,
      );
    }
    expect(src).toMatch(/INVALID_DATE_RANGE/);
    expect(src).toMatch(/'INVALID_DATE'/);
  });

  it('a single company currency: the company is the authority, the exponent comes from the frozen money registry — no FX, no consolidation', () => {
    expect(prod('report-money.ts')).toMatch(
      /import \{ currencyExponent, isKnownCurrency \} from '@flower\/money'/,
    );
    for (const f of PRODUCTION) {
      const code = stripComments(read(f));
      expect(code, rel(f)).not.toMatch(
        /fxRate|fx_rate|exchangeRate|exchange_rate|convertCurrency|currencyConversion|toCurrency|consolidat/i,
      );
      expect(code, rel(f)).not.toMatch(/['"](?:AED|SAR|QAR|KWD|BHD|OMR|USD|EUR)['"]/);
    }
    // the report is ONE company's — there is no tenant-wide / multi-company input
    expect(prod('trial-balance.repository.ts')).not.toMatch(
      /companyIds|allCompanies|tenantWide|companyScope/,
    );
  });

  it('no AR aging and no POS-terminal dimension in the reporting code', () => {
    for (const f of PRODUCTION) {
      const code = stripComments(read(f));
      expect(code, rel(f)).not.toMatch(/ageDays|aging|ageing|bucket|overdue|dueDate/i);
      expect(code, rel(f)).not.toMatch(/posTerminal|pos_terminal|terminalId/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('A — money is exact: no float, no rounding, no Number, decimal-string wire', () => {
  it('no binary-float arithmetic, literal or conversion in the reporting production code', () => {
    for (const f of PRODUCTION) {
      const code = bareCode(read(f));
      expect(code, rel(f)).not.toMatch(
        /\bparseFloat\b|\.toFixed\s*\(|\bMath\.|\bNumber\s*\(|\bNumber\.parse|\bparseInt\s*\(/,
      );
      expect(code, rel(f)).not.toMatch(/(?<![\w.])\d+\.\d+(?![\w.])/);
      // (an integer currency EXPONENT is a `number`; a MONEY amount never is)
      expect(code, rel(f)).not.toMatch(
        /\w*(?:Minor|[Aa]mount|[Bb]alance|[Tt]otal)\w*\??\s*:\s*number\b/,
      );
    }
  });

  it('every money figure on the wire is typed as a decimal STRING; the wire form is value.toString()', () => {
    const tb = prod('trial-balance.ts');
    const typed = [...tb.matchAll(/readonly (\w*Minor):\s*([A-Za-z]+);/g)];
    expect(typed.length).toBeGreaterThan(10);
    for (const m of typed) {
      // the raw aggregate carries exact `bigint`; every wire row / total carries a decimal `string`
      expect(['string', 'bigint'], m[1]).toContain(m[2]);
    }
    expect(typed.filter((m) => m[2] === 'string').length).toBeGreaterThanOrEqual(12);
    expect(prod('report-money.ts')).toMatch(/return value\.toString\(\);/);
    expect(prod('report-money.ts')).toMatch(/INTEGER_TEXT_RE = \/\^-\?\\d\+\$\//);
    expect(prod('trial-balance.repository.ts')).toMatch(/parseMinorUnitsText\(/);
  });

  it('no profit terminology (CLAUDE.md rule 21): nothing is labelled profit / margin', () => {
    for (const f of PRODUCTION) {
      expect(read(f), rel(f)).not.toMatch(/\bprofit|\bmargin\b|\bearnings\b|P&L|\bPnL\b/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('A — read-only, side-effect-free, no later domain', () => {
  it('no audit, outbox, realtime, idempotency, event or clock in the reporting code', () => {
    for (const f of PRODUCTION) {
      const code = stripComments(read(f));
      expect(code, rel(f)).not.toMatch(
        /AuditWriter|audit\.record|OutboxWriter|\.enqueue\(|realtime|Idempotent|IdempotencyKey|Idempotency-Key|emit\(|publish\(|SystemClock|Clock\b|setTimeout|setInterval/,
      );
      expect(code, rel(f)).not.toMatch(
        /from '\.\.\/\.\.\/common\/(?:audit|idempotency|clock|redis)/,
      );
    }
  });

  it('no businessType branching, no inventory / BOM, no X/Z report, no provider execution', () => {
    for (const f of PRODUCTION) {
      const code = stripComments(read(f));
      expect(code, rel(f)).not.toMatch(/businessType|business_type|BusinessType|templateKey/i);
      expect(code, rel(f)).not.toMatch(
        /inventory|\bBOM\b|bill_of_materials|\bstock\b|\bCOGS\b|recipe|production/i,
      );
      expect(code, rel(f)).not.toMatch(
        /x[_-]?report|z[_-]?report|cash[_-]?register|register[_-]?session|\bshift\b|z_number/i,
      );
      // (the Nest module's own `providers:` metadata key is not a payment provider)
      expect(code.replace(/\bproviders:/g, ''), rel(f)).not.toMatch(
        /PaymentProvider|ProviderConfig|webhook|provider/i,
      );
    }
  });

  it('the fail-closed contract is named in code: not-configured, currency-mismatch, unbalanced', () => {
    const all = PRODUCTION.map((f) => stripComments(read(f))).join('\n');
    for (const code of [
      'REPORT_COMPANY_NOT_CONFIGURED',
      'REPORT_CURRENCY_MISMATCH',
      'REPORT_TRIAL_BALANCE_UNBALANCED',
    ]) {
      expect(all, code).toContain(code);
    }
    // the invariant is enforced on all three control-total pairs
    const tb = prod('trial-balance.ts');
    expect(tb).toMatch(/t\.openingDebit !== t\.openingCredit/);
    expect(tb).toMatch(/t\.periodDebit !== t\.periodCredit/);
    expect(tb).toMatch(/t\.closingDebit !== t\.closingCredit/);
  });

  it('no scratch / temporary / mutation artifact is left in the module', () => {
    for (const f of ALL_FILES) {
      expect(f.slice(DIR.length + 1), f).not.toMatch(
        /\.(bak|orig|tmp|rej|swp|out|log)$|~$|\.mutant|\.scratch|mutate-|pin-sensitivity/i,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('A — documentation records the owner rulings', () => {
  const planPath = join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md');
  const logPath = join(ROOT, 'docs/decisions/DECISION-LOG.md');

  it('the Task 3b.10 plan exists and records OD-1 … OD-8 and the four frozen semantic groups', () => {
    expect(existsSync(planPath)).toBe(true);
    const plan = read(planPath);
    for (const id of ['OD-1', 'OD-2', 'OD-3', 'OD-4', 'OD-5', 'OD-6', 'OD-7', 'OD-8']) {
      expect(plan, id).toContain(id);
    }
    expect(plan).toMatch(/sourceKind-independent/);
    expect(plan).toMatch(/CURRENT snapshot only/);
    expect(plan).toMatch(/no `byBranch`/);
    expect(plan).toMatch(/ALL of/);
    expect(plan).toMatch(/never netted/);
  });

  it('the plan records the measured query-plan decision (no migration 50, no period cap for the Trial Balance, a non-production benchmark) and has no unfilled placeholder', () => {
    const plan = read(planPath);
    expect(plan).not.toMatch(/<<[A-Z]+>>/);
    expect(plan).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(plan).toMatch(/No migration 50 and no\s+index change is required/);
    expect(plan).toMatch(/none is recommended for the Trial Balance/);
    expect(plan).toMatch(/journal_entry_tenantId_companyId_postingDate_idx/);
  });

  it('the decision log carries the two 3b.10 rows exactly once each', () => {
    const log = read(logPath);
    for (const id of ['3b.10-OD', '3b.10-TB']) {
      expect(
        log.split('\n').filter((l) => l.startsWith(`| **${id}**`)),
        id,
      ).toHaveLength(1);
    }
  });

  it('RB-1 and HG3b-SALE-LATENCY are still recorded OPEN in the Task 3b.10 plan (neither is touched by reporting)', () => {
    const plan = read(planPath);
    expect(plan).toMatch(/RB-1/);
    expect(plan).toMatch(/HG3b-SALE-LATENCY/);
    expect(plan).not.toMatch(/RB-1[^\n]*(?:resolved|closed)\b/i);
    expect(plan).not.toMatch(/HG3b-SALE-LATENCY[^\n]*(?:resolved|closed)\b/i);
  });
});
