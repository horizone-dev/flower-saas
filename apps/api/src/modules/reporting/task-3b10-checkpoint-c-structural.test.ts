import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// White-box structural pin: it reads the frozen chart-of-accounts REFERENCE DATA constant (no Prisma client,
// no query) to prove the account keys exist — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
import { TENDER_METHODS } from '../payments/tender.js';
import { resolveReceiptAccountKeyForTender } from '../payments/tender-account-mapping.js';
import { WALK_IN_SALE_SOURCE_KIND } from '../sales/walk-in-sale-journal.js';
import { parseReportDateRange } from './report-date-range.js';
import { SALES_REPORT_MAX_DAYS, SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';
import {
  LOCAL_REFUND_ACCOUNT_BY_METHOD,
  TENDER_ACCOUNT_KEYS,
  TENDER_REPORT_MAX_MOVEMENTS,
  TENDER_SOURCE_KINDS,
  TENDER_TOTALS_REPORT_SQL as SQL,
} from './tender-totals-report.sql.js';
import { TENDER_NET_NOTE, buildTenderTotalsBlocks } from './tender-totals-report.js';

/**
 * Task 3b.10 Checkpoint C — structural pins: Tender Totals.
 *
 * They pin the owner rulings of the Checkpoint C instruction so the report cannot drift into a controller, a
 * permission, a migration, a PaymentAttempt / CustomerAdvance / CreditNote / settlement read, a document-date
 * period, a Sales rule (the 90-day cap / the document limit), a multi-statement read, a float, a CREDIT method,
 * a POS dimension or a later checkpoint's report without a failing test. Every pin is sensitivity-tested (a
 * deliberate violation must turn it red).
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
const isTest = (abs: string): boolean => /\.(test|spec)\.ts$/.test(abs);

/** Checkpoint C's production files — a CLOSED set of four */
const C_PRODUCTION = [
  'tender-totals-report.ts',
  'tender-totals-report.sql.ts',
  'tender-totals-report.repository.ts',
  'tender-totals-report.service.ts',
];
const C_TESTS = [
  'task-3b10-checkpoint-c-structural.test.ts',
  'tender-totals-report.dense-window.integration.test.ts',
  'tender-totals-report.integration.test.ts',
  'tender-totals-report.query-plan.integration.test.ts',
  'tender-totals-report.test.ts',
];
const PURE = 'tender-totals-report.ts';
const SQLF = 'tender-totals-report.sql.ts';
const REPO = 'tender-totals-report.repository.ts';
const SVC = 'tender-totals-report.service.ts';
const cProd = (name: string): string => stripComments(read(join(DIR, name)));
const cBare = (name: string): string => bareCode(read(join(DIR, name)));
const modules = (name: string): string => read(join(SRC, 'modules', name));

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

describe('C — Checkpoints A and B are FROZEN: their production files are byte-unchanged', () => {
  const FROZEN: Record<string, string> = {
    // Checkpoint A (reporting foundation + Trial Balance)
    'report-date-range.ts': 'b2a3859b05638788a75f3d51a9c084a14f5588fc0606799ecae0cf7f87fbd8aa',
    'report-money.ts': '3a125d7f9926a84c5961657fdc007466d6dce41216863eaa034978cca8367bb1',
    'reporting.repository.ts': '012207a0e26e085b08f95e45c7ed3315ea81a8653ac25d9bdff9ba152d279a3c',
    'trial-balance.ts': 'bf82c8c1bd4bd56bc9b5294c257414540eba69f9e3d7544143e4fb4d02c43d3a',
    'trial-balance.sql.ts': 'cf4c267c40881f3e63481ef039abd5f7435877845e49fc38e7eeba04b03e6821',
    'trial-balance.repository.ts':
      '40e1b01900e2a6911411a86e5ef570b9848118e566f43af5b4614e4581061c7b',
    'trial-balance.service.ts': '6fd6cc46c24cdf86b3c07bfdd67923cc15c35f6471accba10274f8473dc2075d',
    // Checkpoint B (Sales Financial Report, the line-discount authority, the 90-day cap, the density guard)
    'sales-financial-report.ts': '724ded058d15b40d93c5382d980b2db6b4837ceb456217a62a57029f422c8422',
    'sales-financial-report.sql.ts':
      'de4618891eab1d7c34a48bd873164730226b087f6694221611d99f9cf77e9528',
    'sales-financial-report.repository.ts':
      'd26efb618d8c1cd16b80abbf6e10bf9c90a197f3a724318fdad852df04c7520e',
    'sales-financial-report.service.ts':
      '33d2c722b7ff855edb59462edaad8033ac56d1c8fb56475bcb193167f2a89bc5',
    'sales-invoice-line-set-proof.ts':
      'f8301ec53c69a8c8eb244864c50295a93b67c584f83fb53706ef9b2c84dae635',
    'sales-report-range.ts': 'dd66505d1050eb9b77a656bed50cef421561dcb99a251d91adc63d97e3fa6f63',
  };
  for (const [file, hash] of Object.entries(FROZEN)) {
    it(`${file} is byte-identical to its frozen state`, () => {
      expect(sha(join(DIR, file))).toBe(hash);
    });
  }

  it('the Sales rules are unchanged and are still the Sales report’s alone: 90 inclusive days, 25 000 documents', () => {
    expect(SALES_REPORT_MAX_DAYS).toBe(90n);
    expect(SALES_REPORT_MAX_DOCUMENTS).toBe(25_000);
  });

  it('the Trial Balance is still uncapped and carries no sourceKind filter (Tender work never touched it)', () => {
    const tb = read(join(DIR, 'trial-balance.sql.ts'));
    const executable = tb.slice(tb.indexOf('export const TRIAL_BALANCE_SQL'));
    expect(executable.slice(0, executable.indexOf('export interface'))).not.toMatch(
      /sourceKind|sourceId|LIMIT|OFFSET|cursor/i,
    );
    expect(parseReportDateRange({ from: '2021-01-01', to: '2026-12-31' })).toEqual({
      from: '2021-01-01',
      to: '2026-12-31',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — scope: only Tender Totals; nothing of Receivables, Advances or Task 3b.11', () => {
  it('the Checkpoint C production surface is EXACTLY the four tender files; its tests are the five listed', () => {
    const names = walk(DIR).map((f) => f.slice(DIR.length + 1).replace(/\\/g, '/'));
    expect(names.filter((n) => n.startsWith('tender-') && !isTest(n) && notF(n)).sort()).toEqual(
      [...C_PRODUCTION].sort(),
    );
    expect(
      names
        .filter(notF)
        .filter((n) => /tender/i.test(n) || n === 'task-3b10-checkpoint-c-structural.test.ts')
        .sort(),
    ).toEqual([...C_PRODUCTION, ...C_TESTS].sort());
  });

  it('no controller, no Nest module, no public route, no guard, no decorator wiring', () => {
    for (const n of C_PRODUCTION) {
      expect(n).not.toMatch(/\.(controller|module|guard|interceptor|dto)\.ts$/);
      expect(cProd(n), n).not.toMatch(
        /@Controller\b|@Module\b|@Get\(|@Post\(|@Put\(|@Patch\(|@Delete\(|@UseGuards\b|@RequirePermission\b|@ScopedParam\b|@Public\b|@Idempotent\b|@NoStepUp\b/,
      );
    }
  });

  it('nothing outside the reporting module references Tender Totals: no module registration, no import', () => {
    for (const f of walk(SRC).filter((x) => x.endsWith('.ts') && !x.startsWith(DIR))) {
      if (/task-3b10-/.test(f)) continue;
      expect(read(f), rel(f)).not.toMatch(
        /TenderTotals|tender-totals-report|modules\/reporting\/tender/,
      );
    }
    expect(withoutFRegistration(read(join(SRC, 'app.module.ts')))).not.toMatch(
      /reporting|Reporting|TenderTotals/,
    );
  });

  it('no Receivables report, no Advances report, no aging, no balance: nothing of the later checkpoints (file or vocabulary)', () => {
    const all = walk(DIR)
      .map((f) => f.slice(DIR.length + 1))
      .filter(notF);
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
    for (const n of C_PRODUCTION) {
      expect(cBare(n), n).not.toMatch(
        /receivables?[_ -]?report|advances?[_ -]?report|aging|aged|AgedReceivable|outstanding|ar_balance|advanceBalance/i,
      );
    }
  });

  it('no migration 50, no schema change, no permission change, no role-template change, no new permission key', () => {
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
    for (const n of C_PRODUCTION) {
      expect(read(join(DIR, n)), n).not.toMatch(
        /['"`](?:reports:view|reports:tenant|reporting:view|financial_reports:view|tender:view)['"`]/,
      );
    }
  });

  it('no Task 3b.11 / tagging work, no X / Z report, no shift, no inventory / BOM, no POS dimension', () => {
    for (const n of C_PRODUCTION) {
      expect(read(join(DIR, n)), n).not.toMatch(/3b\.11|phase-3-complete/i);
      expect(cBare(n), n).not.toMatch(
        /z[_-]?report|x[_-]?report|\bshift\b|cashSession|cash_session|inventory|\bbom\b|\bstock\b|posTerminal|pos_terminal|terminalId/i,
      );
    }
    expect(SQL).not.toMatch(/posTerminal|pos_terminal|terminalId|inventory|bom|shift|z_report/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — the exact frozen sources: Payment and Refund rows, their exact journal kinds and accounts', () => {
  const effects = (): string => modules('receivables/customer-receipt-effects.repository.ts');
  const refundExec = (): string => modules('receivables/refund-execution.repository.ts');
  const refundProvider = (): string =>
    modules('receivables/refund-attempt-reservation.repository.ts');

  it('the four source-kind literals are EXACTLY the producers’ literals', () => {
    expect(TENDER_SOURCE_KINDS).toEqual({
      customerReceipt: 'customer_receipt_payment',
      walkInSale: 'walk_in_sale',
      refund: 'refund',
      paymentAllocation: 'payment_allocation',
    });
    expect(effects()).toMatch(/sourceKind: 'customer_receipt_payment'/);
    expect(effects()).toMatch(/sourceKind: 'payment_allocation'/);
    expect(refundExec()).toMatch(/sourceKind: 'refund'/);
    expect(refundProvider()).toMatch(/sourceKind: 'refund'/);
    expect(TENDER_SOURCE_KINDS.walkInSale).toBe(WALK_IN_SALE_SOURCE_KIND);
  });

  it('walk_in_sale is IMPORTED from its producer, never repeated as a literal in the Tender code', () => {
    const sql = read(join(DIR, SQLF));
    expect(sql).toMatch(
      /import \{ WALK_IN_SALE_SOURCE_KIND \} from '\.\.\/sales\/walk-in-sale-journal\.js';/,
    );
    expect(sql).toMatch(/walkInSale: WALK_IN_SALE_SOURCE_KIND,/);
    for (const n of C_PRODUCTION) expect(cProd(n), n).not.toMatch(/'walk_in_sale'/);
  });

  it('there is NO other producer of these journals: exactly one customer-receipt producer file, exactly two refund producers', () => {
    const producers = (literal: RegExp): string[] =>
      walk(SRC)
        .filter((f) => f.endsWith('.ts') && !isTest(f) && !f.startsWith(DIR))
        .filter((f) => literal.test(stripComments(read(f))))
        .map(rel)
        .sort();
    expect(producers(/sourceKind:\s*'customer_receipt_payment'/)).toEqual([
      'apps/api/src/modules/receivables/customer-receipt-effects.repository.ts',
    ]);
    expect(producers(/sourceKind:\s*'refund'/)).toEqual([
      'apps/api/src/modules/receivables/refund-attempt-reservation.repository.ts',
      'apps/api/src/modules/receivables/refund-execution.repository.ts',
    ]);
  });

  it('the account keys are exactly the frozen chart-of-accounts keys', () => {
    expect(TENDER_ACCOUNT_KEYS).toEqual({
      cashOnHand: 'ASSET.CASH_ON_HAND',
      bank: 'ASSET.BANK',
      paymentClearing: 'ASSET.PAYMENT_CLEARING',
      unappliedReceipts: 'LIABILITY.UNAPPLIED_RECEIPTS',
      customerAdvances: 'LIABILITY.CUSTOMER_ADVANCES',
    });
    const chart = ACCOUNTING_REFERENCE_ACCOUNTS.map((a) => a.key);
    for (const key of Object.values(TENDER_ACCOUNT_KEYS)) expect(chart).toContain(key);
  });

  it('the receipt tender → account mapping is the PRODUCTION mapping (imported, never repeated); the refund one mirrors its producer', () => {
    const sql = read(join(DIR, SQLF));
    expect(sql).toMatch(
      /import \{ resolveReceiptAccountKeyForTender \} from '\.\.\/payments\/tender-account-mapping\.js';/,
    );
    expect(sql).toMatch(/resolveReceiptAccountKeyForTender\(m\)/);
    // the three accounts the mapping produces are exactly the cash / bank / clearing keys
    expect(new Set(TENDER_METHODS.map((m) => resolveReceiptAccountKeyForTender(m)))).toEqual(
      new Set([
        TENDER_ACCOUNT_KEYS.cashOnHand,
        TENDER_ACCOUNT_KEYS.bank,
        TENDER_ACCOUNT_KEYS.paymentClearing,
      ]),
    );
    // refunds: local CASH / BANK_TRANSFER exactly as `refund-execution.repository.ts`; provider-finalised → clearing
    expect(LOCAL_REFUND_ACCOUNT_BY_METHOD).toEqual({
      CASH: 'ASSET.CASH_ON_HAND',
      BANK_TRANSFER: 'ASSET.BANK',
    });
    expect(refundExec()).toMatch(/CASH: 'ASSET\.CASH_ON_HAND',\s*BANK_TRANSFER: 'ASSET\.BANK',/);
    expect(refundProvider()).toMatch(
      /accountKey: 'ASSET\.PAYMENT_CLEARING',\s*direction: 'credit'/,
    );
    expect(refundExec()).toMatch(
      /accountKey: 'LIABILITY\.CUSTOMER_ADVANCES',\s*direction: 'debit'/,
    );
    expect(refundProvider()).toMatch(
      /accountKey: 'LIABILITY\.CUSTOMER_ADVANCES',\s*direction: 'debit'/,
    );
    expect(effects()).toMatch(/LIABILITY\.UNAPPLIED_RECEIPTS/);
  });

  it('the method set is EXACTLY the five frozen TenderMethod values and CREDIT is never a tender', () => {
    expect([...TENDER_METHODS]).toEqual([
      'CASH',
      'CARD_TERMINAL',
      'BANK_TRANSFER',
      'ONLINE_GATEWAY',
      'OTHER_MANUAL',
    ]);
    for (const n of C_PRODUCTION) {
      expect(cProd(n), n).not.toMatch(/['"`]CREDIT['"`]|\bCREDIT_METHOD\b/);
    }
    const pure = cProd(PURE);
    expect(pure).toMatch(/import \{[^}]*TENDER_METHODS[^}]*\} from '\.\.\/payments\/tender\.js';/);
    expect(pure).toMatch(/TENDER_METHODS\.map\(/);
  });

  it('no method literal is hard-coded in the pure code, the repository or the service; the SQL builder names only CASH / BANK_TRANSFER (the local refund map)', () => {
    for (const n of [PURE, REPO, SVC]) {
      expect(cProd(n), n).not.toMatch(
        /'(?:CASH|CARD_TERMINAL|BANK_TRANSFER|ONLINE_GATEWAY|OTHER_MANUAL)'/,
      );
    }
    // the SQL builder names methods only as the KEYS of the local refund map (no quoted literal anywhere)
    const sql = cProd(SQLF);
    expect(
      [...sql.matchAll(/'(CASH|CARD_TERMINAL|BANK_TRANSFER|ONLINE_GATEWAY|OTHER_MANUAL)'/g)].length,
    ).toBe(0);
    expect(Object.keys(LOCAL_REFUND_ACCOUNT_BY_METHOD).sort()).toEqual(['BANK_TRANSFER', 'CASH']);
    const mapSource = sql.slice(sql.indexOf('export const LOCAL_REFUND_ACCOUNT_BY_METHOD'));
    const named = [
      ...new Set(
        [
          ...mapSource
            .slice(0, mapSource.indexOf('});'))
            .matchAll(/\b(CASH|CARD_TERMINAL|BANK_TRANSFER|ONLINE_GATEWAY|OTHER_MANUAL)\s*:/g),
        ].map((m) => m[1]),
      ),
    ].sort();
    expect(named).toEqual(['BANK_TRANSFER', 'CASH']);
  });

  it('the statement reads EXACTLY these tables — never a PaymentAttempt, RefundAttempt, CustomerAdvance, CreditNote, settlement or charge table', () => {
    const tables = [
      ...new Set([...SQL.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((m) => m[1])),
    ].sort();
    expect(tables).toEqual([
      'account',
      'branch',
      'company',
      'customer_receivable',
      'invoice',
      'journal_entry',
      'journal_line',
      'order',
      'payment',
      'payment_allocation',
      'refund',
    ]);
    // no such table is named anywhere (as a quoted identifier — the account KEY LIABILITY.CUSTOMER_ADVANCES is not a table)
    expect(SQL).not.toMatch(
      /"(?:payment_attempt|refund_attempt|customer_advance|customer_advance_application|credit_note|cancellation_charge|settlement_[a-z_]+|provider_[a-z_]+|customer_account_entry|customer_company_account|refund_attempt_entitlement_reservation)"/,
    );
  });

  it('the receipt source is the Payment row and the refund source the Refund row: each joined by PRIMARY KEY from its journal sourceId', () => {
    expect(SQL).toMatch(/LEFT JOIN "payment" p\s+ON p\."id" = s\."docId"/);
    expect(SQL).toMatch(/LEFT JOIN "refund" r\s+ON r\."id" = s\."docId"/);
    expect(SQL).toMatch(/LEFT JOIN "invoice" i\s+ON i\."id" = s\."docId"/);
    // an anonymous Payment is reached ONLY through its PaymentAllocation to the journal's invoice
    expect(SQL).toMatch(/pa\."invoiceId" = w\."docId"/);
    expect(SQL).toMatch(/p\."id" = pa\."paymentId"/);
  });

  it('a PaymentAllocation / CustomerAdvance / CreditNote / RefundAttempt is never a second receipt or a refund: allocation journals are selected ONLY as an integrity detector', () => {
    // `al` reads the allocation journals; `alu` (its in-period-unproven remainder) feeds ONLY the
    // allocatedPaymentsWithoutReceiptJournal counter
    const rcpt = SQL.slice(SQL.indexOf('rcpt AS ('), SQL.indexOf('rfnd AS ('));
    expect(rcpt).not.toMatch(/\bal\b|\balu\b|payment_allocation_journal|paymentAllocation/);
    expect(rcpt).toMatch(/FROM cr c/);
    expect(rcpt).toMatch(/FROM wp w/);
    const refunds = SQL.slice(SQL.indexOf('rfnd AS ('), SQL.indexOf('gl AS ('));
    expect(refunds).toMatch(/FROM rf r/);
    expect(refunds).not.toMatch(/\bal\b|\balu\b|credit|advance/i);
    expect((SQL.match(/FROM al a\b/g) ?? []).length).toBe(1); // only `alu` reads `al`
    expect((SQL.match(/FROM alu u/g) ?? []).length).toBe(1); // only the one counter reads `alu`
    expect(SQL).toMatch(/alu AS MATERIALIZED \(/);
  });

  it('the two cross-journal integrity checks are PERIOD-BOUNDED: set joins over the in-period journals, a per-row probe only for the unproven remainder (never a probe per Payment of the window)', () => {
    // the anonymous-Payment-with-receipt-journal check is a JOIN of the walk-in Payments to the in-period receipt journals
    expect(SQL).toMatch(
      /FROM wp w\s+JOIN cr c ON c\."paymentId" = w\."paymentId"\) AS "anonymousPaymentsWithReceiptJournal"/,
    );
    // the allocation check anti-joins the in-period receipts, THEN probes the unique source index with LIMIT 1
    expect(SQL).toMatch(
      /WHERE NOT EXISTS \(SELECT 1 FROM cr c WHERE c\."paymentId" = a\."paymentId"\)/,
    );
    expect(SQL).toMatch(/FROM alu u\s+LEFT JOIN LATERAL \(/);
    expect(SQL).toMatch(/LIMIT 1\) rj2 ON true/);
    // no EXISTS probe against journal_entry anywhere (the measured hash-anti-join / 250 000-probe shapes)
    expect(SQL).not.toMatch(/EXISTS \(SELECT 1 FROM "journal_entry"/);
    expect((SQL.match(/FROM "journal_entry"/g) ?? []).length).toBe(3); // the density candidates + the anchor + the one remainder probe
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — period authority, seal, scope predicates', () => {
  it('a movement is in the period iff its SEALED journal’s postingDate is — exactly one inclusive date pair, nothing else decides', () => {
    // the anchor and the density candidate stage carry the SAME inclusive pair — nothing else decides
    expect((SQL.match(/je\."postingDate" >= \$3::date/g) ?? []).length).toBe(2);
    expect((SQL.match(/je\."postingDate" <= \$4::date/g) ?? []).length).toBe(2);
    expect((SQL.match(/postingDate/g) ?? []).length).toBe(4);
    expect(SQL).not.toMatch(
      /createdAt|updatedAt|accountingDate|invoiceDate|issuedAt|settlementDate|finalizedAt|"date"/i,
    );
  });

  it('only SEALED journals are authoritative: the density candidates, the anchor and the remainder existence probe demand sealedAt IS NOT NULL', () => {
    expect((SQL.match(/"sealedAt" IS NOT NULL/g) ?? []).length).toBe(3);
    const sel = SQL.slice(SQL.indexOf('sel AS ('), SQL.indexOf('cr AS ('));
    expect(sel).toMatch(/je\."sealedAt" IS NOT NULL/);
    expect(sel).toMatch(/FROM "journal_entry" je/);
  });

  it('the anchor selects EXACTLY the four journal kinds — no other kind, no kind exclusion, no default', () => {
    const sel = SQL.slice(SQL.indexOf('sel AS ('), SQL.indexOf('cr AS ('));
    const list = [...sel.matchAll(/je\."sourceKind" IN \(([^)]*)\)/g)];
    expect(list).toHaveLength(1);
    expect(
      list[0]![1]!
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort(),
    ).toEqual(['customer_receipt_payment', 'payment_allocation', 'refund', 'walk_in_sale']);
    expect(sel).not.toMatch(/NOT IN|<>|!=/);
  });

  it('a malformed sourceId is an orphan, never a cast error: the uuid cast is guarded by the regex', () => {
    expect(SQL).toMatch(/CASE WHEN je\."sourceId" ~ '\^\[0-9a-fA-F\]\{8\}/);
    expect((SQL.match(/::uuid END AS "docId"/g) ?? []).length).toBe(2); // the anchor + the density candidates
  });

  it('carries EXPLICIT tenant + company predicates on EVERY table it touches — never RLS or the branch GUC', () => {
    // EVERY table reference carries its OWN predicate: per alias, the number of `alias."tenantId" = $1` (and
    // `alias."companyId" = $2`) predicates equals the number of references — one removed anywhere is caught, even when
    // another reference of the same alias (the same table in another stage) still carries it
    const refs = [...SQL.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"\s+([a-z0-9]+)/g)];
    expect(refs.length).toBe(18);
    const byAlias = new Map<string, { table: string; n: number }>();
    for (const [, table, alias] of refs) {
      const cur = byAlias.get(alias!) ?? { table: table!, n: 0 };
      expect(cur.table, `alias ${alias} names two different tables`).toBe(table);
      byAlias.set(alias!, { table: table!, n: cur.n + 1 });
    }
    const count = (re: RegExp): number => (SQL.match(re) ?? []).length;
    for (const [alias, { table, n }] of byAlias) {
      expect(
        count(new RegExp(`(?<![A-Za-z0-9_])${alias}\\."tenantId" = \\$1::uuid`, 'g')),
        `${table} ${alias}.tenantId`,
      ).toBe(n);
      if (table === 'company') {
        expect(count(/(?<![A-Za-z0-9_])c\."id" = \$2::uuid/g)).toBe(n);
      } else {
        expect(
          count(new RegExp(`(?<![A-Za-z0-9_])${alias}\\."companyId" = \\$2::uuid`, 'g')),
          `${table} ${alias}.companyId`,
        ).toBe(n);
      }
    }
    expect(SQL).not.toMatch(/app\.branch_id|app\.tenant_id|current_setting|set_config/i);
    for (const n of C_PRODUCTION) {
      expect(cProd(n), n).not.toMatch(/app\.branch_id|app\.tenant_id|current_setting|set_config/i);
    }
  });

  it('the branch predicate is the EXPLICIT document branch ($5) in each of the four anchors — NULL for the company report', () => {
    for (const alias of ['p', 'i', 'r']) {
      expect(SQL).toMatch(
        new RegExp(`\\(\\$5::uuid IS NULL OR ${alias}\\."branchId" = \\$5::uuid\\)`),
      );
    }
    expect((SQL.match(/\(\$5::uuid IS NULL OR p\."branchId" = \$5::uuid\)/g) ?? []).length).toBe(2); // cr + al
    expect(SQL).toMatch(/b\."id" = \$5::uuid/);
    expect((SQL.match(/\$5::uuid/g) ?? []).length).toBe(10);
  });

  it('the period is validated by the shared Checkpoint A contract only — NO calendar cap, no Sales rule, no pagination (the one bound is the movement-density guard)', () => {
    expect(cProd(REPO)).toMatch(/parseReportDateRange\(\{ from: input\.from, to: input\.to \}\)/);
    expect((cProd(SVC).match(/parseReportDateRange\(input\)/g) ?? []).length).toBe(2); // both routes
    for (const n of C_PRODUCTION) {
      expect(read(join(DIR, n)), n).not.toMatch(
        /sales-report-range|SALES_REPORT_MAX_DAYS|SALES_REPORT_MAX_DOCUMENTS|REPORT_RANGE_TOO_LARGE|parseSalesReportRange|candidateDocuments|maxDocuments|maxDays|rangeCap/,
      );
    }
    // exactly two LIMITs: the density candidate bound (limit + 1) and the `LIMIT 1` existence probe of the unproven
    // remainder — never a page of the report
    expect((SQL.match(/\bLIMIT\b/g) ?? []).length).toBe(2);
    expect(SQL).toMatch(/LIMIT 1\) rj2 ON true/);
    expect(SQL).toMatch(
      new RegExp(`\\n   LIMIT ${TENDER_REPORT_MAX_MOVEMENTS + 1}\\n\\),\\ngate AS`),
    );
    expect(
      SQL.replace(/LIMIT 1\) rj2 ON true/, '').replace(
        new RegExp(`LIMIT ${TENDER_REPORT_MAX_MOVEMENTS + 1}`),
        '',
      ),
    ).not.toMatch(/\bLIMIT\b|\bOFFSET\b|\bFETCH\b|cursor/i);
    const five = { from: '2021-01-01', to: '2026-12-31' };
    expect(parseReportDateRange(five)).toEqual(five);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — ONE statement, ONE read-only snapshot; no writes; no N+1', () => {
  it('the repository runs exactly one raw statement through the database-enforced read-only scoped transaction', () => {
    const repo = cProd(REPO);
    expect((repo.match(/\$queryRawUnsafe/g) ?? []).length).toBe(1);
    expect((repo.match(/readScoped\(/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(
      /\$executeRaw|\$queryRaw(?!Unsafe)|\.scoped\(|runScoped|\$transaction/,
    );
    expect(repo).toMatch(/extends ReportingRepository/);
  });

  it('no loop or fan-out issues SQL (no N+1, no per-payment query, no COUNT + report pair)', () => {
    for (const n of [REPO, SVC]) {
      const code = cBare(n);
      expect(code, n).not.toMatch(
        /Promise\.all|for await|\.map\(async|\.forEach\(async|setTimeout|setInterval/,
      );
      expect(code, n).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*await/);
      expect(code, n).not.toMatch(/while\s*\([^)]*\)\s*\{[^}]*await/);
    }
    expect((cProd(SVC).match(/this\.repo\./g) ?? []).length).toBe(2); // one call per route
    expect(cProd(REPO)).not.toMatch(/COUNT\(/);
  });

  it('the statement is ONE read-only SELECT: no semicolon, no lock, no write, no DDL', () => {
    expect(SQL.trim().startsWith('WITH')).toBe(true);
    expect(SQL).not.toMatch(/;/);
    expect(SQL).not.toMatch(/FOR\s+(?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)/i);
    expect(SQL).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|TRUNCATE|ALTER|GRANT|REVOKE|COPY|VACUUM)\b/,
    );
    expect(SQL).toMatch(/\)::text AS "report"\s*$/);
  });

  it('no audit, no outbox, no realtime, no idempotency, no clock, no random: a report is a pure function of the committed ledger', () => {
    for (const n of C_PRODUCTION) {
      expect(cBare(n), n).not.toMatch(
        /AuditWriter|OutboxWriter|Idempotent|RealtimeGateway|publishRealtime|IdempotencyKey|new Date\(|Date\.now|Math\.random|randomUUID/,
      );
    }
    expect(cProd(SQLF)).not.toMatch(/now\(\)|CURRENT_DATE|CURRENT_TIMESTAMP|random\(\)/i);
    expect(SQL).not.toMatch(/now\(\)|CURRENT_DATE|CURRENT_TIMESTAMP|random\(\)/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — the density guard (owner ruling TT-1): one constant, logical movements, one statement, company window, non-disclosing', () => {
  const stageSql = (name: string, next: string): string =>
    SQL.slice(SQL.indexOf(`\n${name} AS`), SQL.indexOf(`\n${next} AS`));
  const GATE = (): string => SQL.slice(SQL.indexOf('\ncand AS ('), SQL.indexOf('\nsel AS ('));
  const NO_CAP = new RegExp(`<= ${TENDER_REPORT_MAX_MOVEMENTS}\\b`);
  const NO_CAP_ALL = new RegExp(NO_CAP.source, 'g');

  it('exactly ONE authoritative constant: TENDER_REPORT_MAX_MOVEMENTS = 100 000, defined once and never repeated as a literal in any production file', () => {
    expect(TENDER_REPORT_MAX_MOVEMENTS).toBe(100_000);
    expect(
      C_PRODUCTION.filter((n) =>
        /export const TENDER_REPORT_MAX_MOVEMENTS = 100_000;/.test(cProd(n)),
      ),
    ).toEqual([SQLF]);
    for (const n of C_PRODUCTION) {
      expect((cProd(n).match(/\b100_?000\b|\b100_?001\b/g) ?? []).length, n).toBe(
        n === SQLF ? 1 : 0,
      );
    }
    // the repository and the statement builder consume the one constant
    expect(cProd(REPO)).toMatch(/maxMovements: number = TENDER_REPORT_MAX_MOVEMENTS/);
    expect(cProd(SQLF)).toMatch(/tenderTotalsReportSql\(TENDER_REPORT_MAX_MOVEMENTS\)/);
    // the Sales limits are a different, unchanged rule: no Sales constant leaks into the Tender code
    for (const n of C_PRODUCTION) {
      expect(cProd(n), n).not.toMatch(/SALES_REPORT_MAX|25_?000\b|\b90n?\b/);
    }
  });

  it('a movement is ONE logical Payment or ONE actual Refund — the candidate stage reads exactly the three movement journal kinds, never the allocation / settlement journals', () => {
    const list = [...GATE().matchAll(/je\."sourceKind" IN \(([^)]*)\)/g)];
    expect(list).toHaveLength(1);
    expect(
      list[0]![1]!
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort(),
    ).toEqual(['customer_receipt_payment', 'refund', 'walk_in_sale']);
    expect(GATE()).not.toMatch(/payment_allocation'|NOT IN|<>|!=/);
    // every candidate is a SEALED journal of the COMPANY window — the same inclusive pair as the anchor, no branch
    expect(GATE()).toMatch(/je\."sealedAt" IS NOT NULL/);
    expect(GATE()).toMatch(/je\."postingDate" >= \$3::date/);
    expect(GATE()).toMatch(/je\."postingDate" <= \$4::date/);
  });

  it('no journal-count substitution: a walk-in journal is worth ITS Payments (N distinct Payments of a Multi Payment = N), a journal worth at least one', () => {
    const gate = SQL.slice(SQL.indexOf('\ngate AS ('), SQL.indexOf('\nsel AS ('));
    // the base: every candidate journal is at least one movement (so more than the limit of journals is always over it)
    expect(gate).toMatch(/\(SELECT COUNT\(\*\) FROM cand\)/);
    // the extra: the DISTINCT Payments of each walk-in invoice beyond its first, summed
    expect(gate).toMatch(/SUM\(x\."payments" - 1\)/);
    expect(gate).toMatch(/COUNT\(DISTINCT pa0\."paymentId"\) AS "payments"/);
    expect(gate).toMatch(/GROUP BY pa0\."invoiceId"\) x\s+WHERE x\."payments" > 1/);
    expect(gate).toMatch(
      new RegExp(
        `pa0\\."invoiceId" = ANY \\(ARRAY\\(SELECT c\\."docId" FROM cand c WHERE c\\."kind" = '${TENDER_SOURCE_KINDS.walkInSale}'\\)\\)`,
      ),
    );
    // walk_in_sale is the imported producer literal, never typed here
    expect(cProd(SQLF)).toMatch(/\$\{TENDER_SOURCE_KINDS\.walkInSale\}/);
  });

  it('a PaymentAttempt, RefundAttempt, CreditNote, CustomerAdvance, PaymentAllocation, settlement or invoice row is never a movement: the gate reads only journal_entry and (to count a sale’s Payments) payment_allocation', () => {
    const tables = [...GATE().matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((m) => m[1]!);
    expect([...new Set(tables)].sort()).toEqual(['journal_entry', 'payment_allocation']);
    expect(GATE()).not.toMatch(
      /payment_attempt|refund_attempt|credit_note|customer_advance|settlement|"invoice"|"order"|"payment"|"refund"/,
    );
    // payment_allocation is read ONLY through the walk-in invoice ids of the candidates — it adds Payments, never rows
    expect((GATE().match(/"payment_allocation"/g) ?? []).length).toBe(1);
    expect(GATE()).toMatch(/GROUP BY pa0\."invoiceId"/);
  });

  it('the guard is the FIRST stage of the SAME statement: EVERY heavy stage carries the gate predicate (a One-Time Filter above its joins), the counter is read from the same JSON — no second COUNT query', () => {
    const gateOpen = '(SELECT g."n" FROM gate g) <= 100000';
    expect(SQL).toContain(`AND ${gateOpen}`);
    const stages: [string, string][] = [
      ['sel', 'cr'],
      ['cr', 'wj'],
      ['wj', 'wp'],
      ['wp', 'rf'],
      ['rf', 'al'],
      ['al', 'alu'],
      ['jl2', 'rcpt'],
    ];
    for (const [name, next] of stages) {
      expect(stageSql(name, next), `stage ${name} carries the gate`).toMatch(NO_CAP);
    }
    // every other occurrence of the predicate is accounted for: exactly these seven stages
    expect((SQL.match(NO_CAP_ALL) ?? []).length).toBe(stages.length);
    // the candidate stage is bounded to limit + 1 journals and runs before every heavy stage
    expect(SQL.indexOf('\ncand AS (')).toBeLessThan(SQL.indexOf('\nsel AS ('));
    expect(SQL.indexOf('\ngate AS (')).toBeLessThan(SQL.indexOf('\nsel AS ('));
    expect(SQL).toMatch(/'candidateMovements', \(SELECT g\."n" FROM gate g\)/);
    // ONE statement: one raw query, the figure read from its own JSON, never a COUNT of its own
    const repo = cProd(REPO);
    expect((repo.match(/\$queryRawUnsafe/g) ?? []).length).toBe(1);
    expect((repo.match(/json\.candidateMovements/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(/COUNT\(|\.count\(|\$executeRaw/i);
  });

  it('the branch route is judged on the COMPANY window: no branch predicate in the gate, the same limit, the branch 404 first, the rejection BEFORE the authority and every integrity check', () => {
    expect(GATE()).not.toMatch(/\$5|branchId/);
    const repo = cProd(REPO);
    // both routes call the one private read() with the one limit
    expect((repo.match(/this\.read\(/g) ?? []).length).toBe(2);
    expect((repo.match(/maxMovements: this\.maxMovements/g) ?? []).length).toBe(1);
    const at = (needle: string): number => repo.indexOf(needle);
    const order = [
      "throw new NotFoundError('company')",
      "throw new NotFoundError('branch')",
      "'REPORT_RESULT_TOO_LARGE'",
      'resolveCompanyReportAuthority(json.company)',
      'assertSourceIntegrity(json)',
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the branch 404 is judged inside read() (not after it) so a branch error never follows a density rejection
    expect(repo).not.toMatch(
      /getBranchReportScoped[\s\S]{0,400}NotFoundError\('branch'\)\s*;?\s*const aggregate/,
    );
  });

  it('the over-limit error is generic and non-disclosing: REPORT_RESULT_TOO_LARGE, 422, only the limit and the action — never the actual count, a sibling branch, an id or a figure', () => {
    const repo = cProd(REPO);
    const start = repo.indexOf("'REPORT_RESULT_TOO_LARGE'");
    const block = repo.slice(
      repo.lastIndexOf('throw new DomainError(', start),
      repo.indexOf(');', start) + 2,
    );
    expect(block).toMatch(/422,/);
    expect(block).toContain('this.maxMovements');
    expect(block).toMatch(/field: 'maxMovements', issue: String\(this\.maxMovements\)/);
    expect(block).toMatch(/field: 'action', issue: 'narrow_date_range'/);
    // the message is a fixed sentence plus the LIMIT — its only interpolation — and nothing else of the request or the
    // result is reachable from the error: the arguments outside that sentence name no count, row, branch, company or total
    expect([...block.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1])).toEqual(['this.maxMovements']);
    expect(block.replace(/`[^`]*`/, '')).not.toMatch(
      /candidateMovements|json\b|input\b|branch|companyId|tenantId|count|rows|journal|aggregate|total/i,
    );
    expect(block.match(/`[^`]*`/)![0]).not.toMatch(/candidate|branch|sibling|company\b|\bid\b/i);
    expect((block.match(/field:/g) ?? []).length).toBe(2);
    // nothing else in the Tender code can raise it, and it is raised exactly once
    for (const n of C_PRODUCTION.filter((x) => x !== REPO)) {
      expect(cProd(n), n).not.toMatch(/REPORT_RESULT_TOO_LARGE/);
    }
    expect((repo.match(/REPORT_RESULT_TOO_LARGE/g) ?? []).length).toBe(1);
    // the limit rejection returns before any result is parsed into a figure
    expect(repo.indexOf("'REPORT_RESULT_TOO_LARGE'")).toBeLessThan(
      repo.indexOf('assertSourceIntegrity(json)'),
    );
  });

  it('no Tender calendar cap, and the Sales rules stay the Sales report’s alone', () => {
    for (const n of C_PRODUCTION) {
      expect(read(join(DIR, n)), n).not.toMatch(
        /REPORT_RANGE_TOO_LARGE|SALES_REPORT_MAX_DAYS|maxDays|rangeCap|parseSalesReportRange/,
      );
    }
    expect(SALES_REPORT_MAX_DAYS).toBe(90n);
    expect(SALES_REPORT_MAX_DOCUMENTS).toBe(25_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — exact money: integer minor units, no float, no FX, no rounding', () => {
  it('no floating point, no Number() conversion, no Math, no rounding, no FX in the Tender code', () => {
    for (const n of C_PRODUCTION) {
      expect(cBare(n), n).not.toMatch(
        /parseFloat|\bNumber\(|\.toFixed|\bMath\.|\bfloat\b|\bdouble\b|\bdecimal\b|toLocaleString|\bfxRate|exchange|\bconvert/i,
      );
      expect(stripComments(read(join(DIR, n))), n).not.toMatch(/\b\d+\.\d+\b/);
    }
    expect(SQL).not.toMatch(
      /::numeric|::float|::double|::real|::money|ROUND\(|CEIL\(|FLOOR\(|\bnumeric\b/i,
    );
  });

  it('every money aggregate leaves the database as TEXT and is parsed strictly; counts are JSON integers', () => {
    // each money column is cast to text exactly where it leaves the statement (receipt total, refund total, GL debit, GL credit)
    expect((SQL.match(/x\."total"::text/g) ?? []).length).toBe(2); // the receipts rows and the refunds rows
    expect((SQL.match(/g\."debit"::text/g) ?? []).length).toBe(1);
    expect((SQL.match(/g\."credit"::text/g) ?? []).length).toBe(1);
    // …and each is parsed strictly, one parse per column
    const repo = cProd(REPO);
    expect(repo).toMatch(/parseMinorUnitsText\(r\.totalMinor, 'receipt totalMinor'\)/);
    expect(repo).toMatch(/parseMinorUnitsText\(r\.totalMinor, 'refund totalMinor'\)/);
    expect(repo).toMatch(/parseMinorUnitsText\(g\.debitMinor, 'debitMinor'\)/);
    expect(repo).toMatch(/parseMinorUnitsText\(g\.creditMinor, 'creditMinor'\)/);
    expect((repo.match(/parseMinorUnitsText\(/g) ?? []).length).toBe(4);
    expect(repo).not.toMatch(/\bBigInt\(/);
    for (const n of C_PRODUCTION) {
      expect(cProd(n), n).not.toMatch(/Minor\??:\s*number\b/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — the report shape, labels and controls', () => {
  const empty = buildTenderTotalsBlocks({ branchId: 'b', receipts: [], refunds: [] }, []);

  it('the result is receipts / refunds / netTenderMovement / reconciliation — and no revenue, profit, sales, balance or settlement field', () => {
    expect(Object.keys(empty)).toEqual([
      'receipts',
      'refunds',
      'netTenderMovement',
      'reconciliation',
    ]);
    expect(Object.keys(empty.receipts)).toEqual(['receiptCount', 'receiptTotalMinor', 'byMethod']);
    expect(Object.keys(empty.refunds)).toEqual(['refundCount', 'refundTotalMinor', 'byMethod']);
    expect(Object.keys(empty.netTenderMovement)).toEqual(['note', 'netMovementMinor', 'byMethod']);
    expect(Object.keys(empty.receipts.byMethod[0]!)).toEqual([
      'method',
      'receiptCount',
      'receiptTotalMinor',
    ]);
    expect(Object.keys(empty.refunds.byMethod[0]!)).toEqual([
      'method',
      'refundCount',
      'refundTotalMinor',
    ]);
    expect(Object.keys(empty.reconciliation.receipts)).toEqual([
      'cashOnHand',
      'bank',
      'paymentClearing',
      'unappliedReceipts',
    ]);
    expect(Object.keys(empty.reconciliation.refunds)).toEqual([
      'cashOnHand',
      'bank',
      'paymentClearing',
      'customerAdvances',
    ]);
    const keys: string[] = [];
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          visit(x);
        }
      }
    };
    visit(empty);
    for (const k of keys) {
      expect(k, k).not.toMatch(
        /revenue|profit|sales|balance|settled|settlement|payable|margin|income/i,
      );
    }
  });

  it('the net movement is receipts − refunds and carries its limiting label; the label denies revenue / net sales / profit / settlement', () => {
    expect(TENDER_NET_NOTE).toBe(
      'Tender movement only: recorded receipts minus actual refunds, by accounting postingDate. It is not revenue, not net sales, not a financial result of any kind and not settled money.',
    );
    expect(cProd(PURE)).toMatch(/minorUnitsToWire\(receiptTotal - refundTotal\)/);
    expect(cProd(PURE)).toMatch(
      /receiptByMethod\.get\(method\)!\.total - refundByMethod\.get\(method\)!\.total/,
    );
  });

  it('each control reads ONLY its own journal kinds: receipts → customer receipt + walk-in debit; unapplied → customer receipt credit; refunds → refund credit / advances debit', () => {
    const pure = cProd(PURE);
    expect(pure).toMatch(
      /const RECEIPT_KINDS: readonly string\[\] = \[\s*TENDER_SOURCE_KINDS\.customerReceipt,\s*TENDER_SOURCE_KINDS\.walkInSale,\s*\];/,
    );
    expect(pure).toMatch(
      /const REFUND_KINDS: readonly string\[\] = \[TENDER_SOURCE_KINDS\.refund\];/,
    );
    expect(pure).toMatch(
      /const CUSTOMER_RECEIPT_KINDS: readonly string\[\] = \[TENDER_SOURCE_KINDS\.customerReceipt\];/,
    );
    expect(pure).toMatch(/glNet\(gl, RECEIPT_KINDS, accountKey, 'debit'\)/);
    expect(pure).toMatch(/glNet\(gl, REFUND_KINDS, accountKey, 'credit'\)/);
    expect(pure).toMatch(
      /glNet\(gl, CUSTOMER_RECEIPT_KINDS, TENDER_ACCOUNT_KEYS\.unappliedReceipts, 'credit'\)/,
    );
    expect(pure).toMatch(
      /glNet\(gl, REFUND_KINDS, TENDER_ACCOUNT_KEYS\.customerAdvances, 'debit'\)/,
    );
    // the receipts per account are grouped from the frozen mapping — never a hard-coded method list
    expect(pure).toMatch(/resolveReceiptAccountKeyForTender\(m\) === accountKey/);
  });

  it('the integrity gate: the currency error first (409), then every named check (500), then the controls — non-disclosing', () => {
    const repo = cProd(REPO);
    expect(repo).toMatch(/'REPORT_CURRENCY_MISMATCH'/);
    expect(repo).toMatch(/'REPORT_TENDER_SOURCE_INTEGRITY'/);
    expect(cProd(PURE)).toMatch(/'REPORT_TENDER_GL_MISMATCH'/);
    for (const check of [
      'orphanReceiptJournals',
      'orphanWalkInJournals',
      'orphanRefundJournals',
      'branchMismatchLines',
      'receiptJournalMismatches',
      'refundJournalMismatches',
      'refundUnmappedMethods',
      'walkInTenderMismatches',
      'walkInOnCustomerInvoices',
      'walkInPaymentAllocationFanout',
      'walkInPaymentBranchMismatches',
      'anonymousPaymentsWithReceiptJournal',
      'allocatedPaymentsWithoutReceiptJournal',
    ]) {
      expect(repo, check).toMatch(new RegExp(`\\['${check}', i\\.${check}\\]`));
      expect(SQL, check).toMatch(new RegExp(`AS "${check}"`));
    }
    expect(repo).not.toMatch(/\$\{[^}]*(?:sourceId|paymentId|refundId|invoiceId)[^}]*\}/);
  });

  it('Multi Payment is the only term: no "Mixed Payment" anywhere in the Tender code or tests', () => {
    for (const n of [
      ...C_PRODUCTION,
      ...C_TESTS.filter((t) => t !== 'task-3b10-checkpoint-c-structural.test.ts'),
    ]) {
      expect(read(join(DIR, n)), n).not.toMatch(/mixed[ _-]?payment/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — the plan gate, the integration suite and the unit suite pin their own contracts', () => {
  const qp = (): string => read(join(DIR, 'tender-totals-report.query-plan.integration.test.ts'));
  const it_ = (): string => read(join(DIR, 'tender-totals-report.integration.test.ts'));

  it('the volume gate EXPLAINs (ANALYZE, BUFFERS) the REAL statement and asserts oracle equality, the postingDate anchor, no per-row seq scan and no CTE re-scan', () => {
    expect(qp()).toMatch(/EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
    expect(qp()).toMatch(/buildTenderTotalsReportQuery/);
    expect(qp()).toMatch(/journal_entry_tenantId_companyId_postingDate_idx/);
    expect(qp()).toMatch(/a nested loop seq-scans \$\{x\['Relation Name'\]\} per outer row/);
    expect(qp()).toMatch(/is scanned once per outer row/);
    expect(qp()).toMatch(/Local test-container benchmark; not production capacity\./);
    for (const scenario of [
      'short: last single day',
      '90-day-like: last 90 days',
      '1-year-like: last 365 days',
      'long: full history',
      'dense: the single day holding the dense share',
      'sparse branch within the dense company: full history',
    ]) {
      expect(qp(), scenario).toContain(scenario);
    }
  });

  it('the integration suite builds every Payment and Refund through the frozen flows and compares with a model oracle', () => {
    const src = it_();
    for (const route of ['/complete-sale', '/receipts', '/payments`', '/refunds`', '/cancel']) {
      expect(src, route).toContain(route);
    }
    expect(src).toMatch(/reserveProviderRefundAttemptInTx/);
    expect(src).toMatch(/applyProviderRefundAttemptResultInTx/);
    expect(src).toMatch(/PaymentWebhookRepository/);
    expect(src).toMatch(/convertInTx/);
    expect(src).toMatch(/async function loadModel/);
    expect(src).toMatch(/async function glOracle/);
    // the only direct Payment inserts are the raw provider fixture (no real adapter exists)
    expect((src.match(/INSERT INTO payment \(/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('C — documentation: the plan and the decision log record the Checkpoint C contracts', () => {
  const plan = (): string => read(join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md'));
  const log = (): string => read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));

  it('the plan has its Checkpoint C section, the status row and the frozen contracts table (Payment / Refund → journal, with cardinality)', () => {
    expect(plan()).toMatch(/^## 12\. Checkpoint C — Tender Totals$/m);
    const row = plan()
      .split('\n')
      .find((l) => l.startsWith('| C   |'))!;
    expect(row).toMatch(/built, verified \(internal only/);
    expect(row).toMatch(/TT-1/);
    expect(plan()).toMatch(
      /### The frozen contracts — discovered in the producing code, not assumed/,
    );
    expect(plan()).toMatch(/\*\*1 Payment → 1 journal\*\*/);
    expect(plan()).toMatch(/\*\*N Payments \(a Multi Payment\) → 1 journal\*\*/);
    expect(plan()).toMatch(/\*\*1 Refund → 1 journal\*\*/);
    expect(plan()).toMatch(
      /exactly one producer file of `customer_receipt_payment` and exactly two of `refund`/,
    );
  });

  it('the plan records the semantics: receipt once, method set, refund, net label, period authority, controls, Multi Payment', () => {
    expect(plan()).toMatch(/\*\*Receipt = a `Payment` row, once\.\*\*/);
    expect(plan()).toMatch(/\*\*Refund = a `Refund` row\*\*/);
    expect(plan()).toMatch(/exactly the five frozen `TenderMethod` values/);
    expect(plan()).toMatch(/the term "Mixed Payment" is not used/);
    expect(plan()).toMatch(
      /Tender movement only … not revenue, not net sales, not a financial result of any kind and not settled money/,
    );
    expect(plan()).toMatch(/\*\*Period authority\*\* = the SEALED journal's `postingDate` only/);
    expect(plan()).toMatch(/\*\*GL controls\*\* \(eight, at the narrowest truthful grouping/);
    expect(plan()).toMatch(/\*\*ONE statement, ONE database-enforced read-only snapshot\*\*/);
  });

  it('the plan records the measured range / volume evidence, the defect it caught and the owner ruling TT-1 (approved and implemented)', () => {
    expect(plan()).toMatch(
      /### Range \/ volume decision — measured on its own, not borrowed from Sales/,
    );
    expect(plan()).toMatch(/\*\*250 000 events\*\* of one company/);
    expect(plan()).toMatch(/\*\*300 000 Payments\*\*/);
    // the disclaimer sits in the 250 000-event evidence ITSELF (Checkpoint B's section and the density closure carry the
    // same sentence for their own figures, so the slice is bounded to this evidence)
    const evidence = plan().slice(
      plan().indexOf('### Range / volume decision'),
      plan().indexOf('**A defect the volume run caught'),
    );
    expect(evidence).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(plan()).toMatch(/\*\*A defect the volume run caught, and its two-step fix/);
    expect(plan()).toMatch(/14 412 journal rows read for a period holding 12 journals/);
    expect(plan()).toMatch(/27\.8 s against the 20 s scoped-transaction timeout/);
    expect(plan()).toMatch(/\*\*Owner ruling TT-1 — APPROVED and IMPLEMENTED \(2026-10-06\)/);
    expect(plan()).not.toMatch(/Decision for the owner — TT-1, recommended and NOT implemented/);
    expect(plan()).not.toMatch(/rejecting above \*\*150 000\*\*/);
    expect(plan()).toMatch(/\*\*no calendar cap\*\*/);
    expect(plan()).toMatch(
      /at most \*\*100 000 logical tender movements per company-window evaluation\*\*/,
    );
    expect(plan()).toMatch(
      /The Trial Balance stays uncapped and the Sales rules stay exactly as frozen/,
    );
  });

  it('the plan records the density closure: the rule and its unit, the company window for the branch route, the non-disclosing answer, the single-statement design, the JIT defect, the measurements and the residual risks', () => {
    const d = plan().slice(plan().indexOf('### Density closure'));
    expect(d).toMatch(
      /^### Density closure — Tender Totals v1: at most 100 000 logical tender movements per company window/,
    );
    expect(d).toMatch(/`TENDER_REPORT_MAX_MOVEMENTS = 100 000` — the one authoritative constant/);
    expect(d).toMatch(
      /\*\*A movement is exactly one successfully recorded `Payment` or one actual final `Refund`\.\*\*/,
    );
    expect(d).toMatch(/The N Payments of a Multi Payment are N movements/);
    expect(d).toMatch(/\*\*Why this restriction exists\.\*\*/);
    expect(d).toMatch(/\*\*The company window, for the branch route too\.\*\*/);
    expect(d).toMatch(/\*\*sparse-company limitation\*\*/);
    expect(d).toMatch(/details `maxMovements: 100000` and `action: narrow_date_range`/);
    expect(d).toMatch(/It never reveals the actual count/);
    expect(d).toMatch(/company 404 → branch 404/);
    expect(d).toMatch(
      /\*\*The over-limit rejection therefore precedes the full integrity analysis\*\*/,
    );
    expect(d).toMatch(/\*\*The design — the same statement, no COUNT-then-report\.\*\*/);
    expect(d).toMatch(/\*\*A defect the performance gate caught, and its fix/);
    expect(d).toMatch(/jit_inline_above_cost/);
    expect(d).toMatch(/accepted worst \*\*15\.6 s\*\*/);
    expect(d).toMatch(/\*\*Measured at the limit\*\*/);
    expect(d).toMatch(/\*\*exactly 100 000 movements in only 88 000 journals\*\*/);
    expect(d).toMatch(/\*\*6 980 \/ 6 899 \/ 6 819 ms\*\*/);
    expect(d).toMatch(/\*\*100 001 → `REPORT_RESULT_TOO_LARGE` \(422\)\*\*/);
    expect(d).toMatch(/\*\*EXPLAIN \(ANALYZE, BUFFERS\)\.\*\*/);
    expect(d).toMatch(/never executed/);
    expect(d).toMatch(/\*\*Residual risks \(stated\)\.\*\*/);
    expect(d).toMatch(/Local test-container benchmark; not production capacity\./);
    // the rule is frozen as v1: the unchanged neighbours
    expect(plan()).toMatch(
      /Sales rules stay exactly as frozen \(90 inclusive days AND 25 000 documents/,
    );
  });

  it('the plan records the density-closure verification: the suites, the pins, the sensitivity, the mutation result and the regression', () => {
    const v = plan().slice(plan().indexOf('### Verification (Checkpoint C — density closure)'));
    expect(v).toMatch(/^### Verification \(Checkpoint C — density closure\)/);
    expect(v).toMatch(/`tender-totals-report\.integration\.test\.ts` — \*\*105\*\* tests/);
    expect(v).toMatch(
      /`tender-totals-report\.query-plan\.integration\.test\.ts` — \*\*18\*\* tests/,
    );
    expect(v).toMatch(
      /`tender-totals-report\.dense-window\.integration\.test\.ts` — \*\*11\*\* tests/,
    );
    expect(v).toMatch(/`task-3b10-checkpoint-c-structural\.test\.ts` — \*\*68\*\* pins/);
    expect(v).toMatch(/\*\*Pin sensitivity: 248 deliberate violations\*\*/);
    expect(v).toMatch(/\*\*104 caught, 9 equivalent\.\*\*/);
    expect(v).toMatch(/\*\*Targeted regression: 12 groups green, 3 545 tests\*\*/);
    expect(v).toMatch(/migrations remain 49 \(no migration 50\)/);
    expect(v).toMatch(/Checkpoint D and Task 3b\.11 not started/);
  });

  it('the plan records the migration decision (none) and the stated boundaries', () => {
    expect(plan()).toMatch(/### Migration \/ index decision/);
    expect(plan()).toMatch(/\*\*None\.\*\* No schema gap and no index is required/);
    expect(plan()).toMatch(/### Stated boundaries \(residuals, not hidden\)/);
    expect(plan()).toMatch(
      /A document with no journal at all is not provable by a journal-anchored period report/,
    );
    expect(plan()).toMatch(/An orphan journal is unattributable to a branch/);
  });

  it('the plan records the Checkpoint C verification: the suites, the pin sensitivity, the mutation result and the regression', () => {
    const v = plan().slice(plan().indexOf('### Verification (Checkpoint C)'));
    expect(v).toMatch(/^### Verification \(Checkpoint C\)/);
    expect(v).toMatch(/`tender-totals-report\.test\.ts` — \*\*19\*\* tests/);
    expect(v).toMatch(/`tender-totals-report\.integration\.test\.ts` — \*\*94\*\* tests/);
    expect(v).toMatch(
      /`tender-totals-report\.query-plan\.integration\.test\.ts` — \*\*14\*\* tests at CI size/,
    );
    expect(v).toMatch(/`task-3b10-checkpoint-c-structural\.test\.ts` — \*\*58\*\* pins/);
    expect(v).toMatch(/\*\*Pin sensitivity: 166 deliberate violations/);
    expect(v).toMatch(/\*\*83 caught, 4 equivalent\.\*\*/);
    expect(v).toMatch(/\*\*Targeted regression: 12 groups green, 3 509 tests\*\*/);
    expect(v).toMatch(/Merge PAID \/ SETTLED" is not applicable/);
    expect(v).toMatch(/no commit, no push, no PR; Task 3b\.11 not started/);
  });

  it('the decision log has exactly one 3b.10-TT row (TT-1 SUPERSEDED, no longer OPEN) and exactly one 3b.10-TD row freezing the Tender v1 density rule; the frozen A / B rows are untouched', () => {
    const rows = log()
      .split('\n')
      .filter((l) => l.startsWith('| **3b.10-TT**'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/TT-1 \(OPEN, owner decision\)/);
    expect(rows[0]).not.toMatch(/above \*\*150 000\*\*/);
    expect(rows[0]).toMatch(
      /TT-1 \(was OPEN; RULED and IMPLEMENTED 2026-10-06 — see `3b\.10-TD`\)/,
    );
    expect(rows[0]).toMatch(/TT-1 SUPERSEDED by `3b\.10-TD` \(2026-10-06\)/);
    expect(rows[0]).toMatch(/RECORDED 2026-10-05 \(Checkpoint C/);
    const td = log()
      .split('\n')
      .filter((l) => l.startsWith('| **3b.10-TD**'));
    expect(td).toHaveLength(1);
    expect(td[0]).toMatch(/\*\*no calendar-day cap\*\*/);
    expect(td[0]).toMatch(
      /`TENDER_REPORT_MAX_MOVEMENTS = 100 000` logical tender movements per company-window evaluation/,
    );
    expect(td[0]).toMatch(/Branch requests are judged on the COMPANY window/);
    expect(td[0]).toMatch(
      /`REPORT_RESULT_TOO_LARGE`, 422, details `maxMovements: 100000` and `action: narrow_date_range`/,
    );
    expect(td[0]).toMatch(/never the actual count, a sibling branch, an id or a figure/);
    expect(td[0]).toMatch(/accepted worst \*\*6\.98 s\*\*/);
    expect(td[0]).toMatch(/\*\*100 001 rejected in 1\.85–2\.05 s\*\*/);
    expect(td[0]).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(td[0]).toMatch(/No migration 50 \(migrations remain 49\)/);
    expect(td[0]).toMatch(/superseded by|supersedes TT-1 OPEN of `3b\.10-TT`/);
    for (const id of ['3b.10-OD', '3b.10-TB', '3b.10-SR', '3b.10-CC', '3b.10-DG']) {
      expect(
        log()
          .split('\n')
          .filter((l) => l.startsWith(`| **${id}**`)),
      ).toHaveLength(1);
    }
  });
});
