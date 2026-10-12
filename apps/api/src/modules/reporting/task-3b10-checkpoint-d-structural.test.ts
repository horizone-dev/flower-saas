import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// White-box structural pin: it reads the frozen chart-of-accounts REFERENCE DATA constant (no Prisma client,
// no query) to prove the AR account key exists — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
import { RECEIVABLE_SOURCE_TYPES } from '../receivables/receivable-balance.js';
import { parseReportDateRange } from './report-date-range.js';
import { SALES_REPORT_MAX_DAYS, SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';
import { TENDER_REPORT_MAX_MOVEMENTS } from './tender-totals-report.sql.js';
import {
  buildCustomerRows,
  buildReceivablesBlocks,
  RECEIVABLES_REPORT_DEFAULT_LIMIT,
  RECEIVABLES_REPORT_MAX_LIMIT,
} from './receivables-report.js';
import {
  AR_ACCOUNT_KEY,
  AR_JOURNAL_KINDS,
  AR_SOURCE_TYPES,
  RECEIVABLES_REPORT_MAX_RECEIVABLES,
  RECEIVABLES_REPORT_SQL as SQL,
} from './receivables-report.sql.js';

/**
 * Task 3b.10 Checkpoint D — structural pins: the Receivables CURRENT-STATE report.
 *
 * They pin the owner rulings of the Checkpoint D instruction so the report cannot drift into a controller, a permission,
 * a migration, a historical / dated / aged report, a customer-PII read, a Payment / Refund / Advance-creation /
 * Settlement figure, a CreditNote-excess subtraction, a whole-AR-account control, a multi-statement read, a float or a
 * later checkpoint's report without a failing test. Every pin is sensitivity-tested (a deliberate violation must turn it red).
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

/** Checkpoint D's production files — a CLOSED set of four */
const D_PRODUCTION = [
  'receivables-report.ts',
  'receivables-report.sql.ts',
  'receivables-report.repository.ts',
  'receivables-report.service.ts',
];
const D_TESTS = [
  'receivables-report.integration.test.ts',
  'receivables-report.query-plan.integration.test.ts',
  'receivables-report.test.ts',
  'task-3b10-checkpoint-d-structural.test.ts',
];
const PURE = 'receivables-report.ts';
const SQLF = 'receivables-report.sql.ts';
const REPO = 'receivables-report.repository.ts';
const SVC = 'receivables-report.service.ts';
const dProd = (name: string): string => stripComments(read(join(DIR, name)));
const dBare = (name: string): string => bareCode(read(join(DIR, name)));
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

describe('D — Checkpoints A, B and C are FROZEN: their production files are byte-unchanged', () => {
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
    // Checkpoint B (Sales Financial Report)
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
    // Checkpoint C (Tender Totals, with its density guard)
    'tender-totals-report.ts': 'f417a47b1180bfb9d0d2753a7cfc9a307d38989cdd24baaad47b886d54a0e3a2',
    'tender-totals-report.sql.ts':
      'c6c5fe43bad3817580f2a375d8845792e72a5870ea3c96e31b9da44ee855d374',
    'tender-totals-report.repository.ts':
      '4b5c3a4faf84920d57962e93ff287c8d61c06a54c3398cd372ebca5fe3fc22fb',
    'tender-totals-report.service.ts':
      'b582883f7489db78bd29e26ab09ccda9a2dc5086b296e009902a665178be95fe',
  };
  for (const [file, hash] of Object.entries(FROZEN)) {
    it(`${file} is byte-identical to its frozen state`, () => {
      expect(sha(join(DIR, file))).toBe(hash);
    });
  }

  it('the frozen report rules are unchanged: Sales 90 inclusive days AND 25 000 documents; Tender NO calendar cap and 100 000 movements; Trial Balance uncapped', () => {
    expect(SALES_REPORT_MAX_DAYS).toBe(90n);
    expect(SALES_REPORT_MAX_DOCUMENTS).toBe(25_000);
    expect(TENDER_REPORT_MAX_MOVEMENTS).toBe(100_000);
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
describe('D — scope: only the Receivables current-state report; nothing of Advances, a controller or Task 3b.11', () => {
  it('the Checkpoint D production surface is EXACTLY the four receivables files; its tests are the four listed', () => {
    const names = walk(DIR).map((f) => f.slice(DIR.length + 1).replace(/\\/g, '/'));
    expect(
      names.filter((n) => n.startsWith('receivables-') && !isTest(n) && notF(n)).sort(),
    ).toEqual([...D_PRODUCTION].sort());
    expect(
      names
        .filter(notF)
        .filter((n) => /receivable/i.test(n) || n === 'task-3b10-checkpoint-d-structural.test.ts')
        .sort(),
    ).toEqual([...D_PRODUCTION.filter(() => true), ...D_TESTS].sort());
  });

  it('no controller, no Nest module, no public route, no guard, no decorator wiring', () => {
    for (const n of D_PRODUCTION) {
      expect(n).not.toMatch(/\.(controller|module|guard|interceptor|dto)\.ts$/);
      expect(dBare(n), n).not.toMatch(
        /@Controller|@Get|@Post|@Patch|@Put|@Delete|@UseGuards|@RequirePermission|@Public|@NoStepUp|@ScopedParam|@Idempotent|@Module\(/,
      );
    }
    expect(dProd(REPO)).toMatch(/@Injectable\(\)/);
    expect(dProd(SVC)).toMatch(/@Injectable\(\)/);
  });

  it('nothing outside the reporting module references the Receivables report: no module registration, no import', () => {
    const outside = walk(SRC).filter(
      (f) => !f.startsWith(DIR) && f.endsWith('.ts') && !f.includes('/node_modules/'),
    );
    for (const f of outside) {
      expect(read(f), rel(f)).not.toMatch(
        /receivables-report|ReceivablesReport(?:Repository|Service)\b/,
      );
    }
    expect(read(join(SRC, 'app.module.ts'))).not.toMatch(/ReceivablesReport|receivables-report/);
  });

  it('NO Advances implementation: no advances report file, no Advance balance / unapplied-receipt vocabulary in the Receivables code', () => {
    const names = walk(DIR).map((f) => f.slice(DIR.length + 1));
    expect(names.filter((n) => /advance/i.test(n))).toEqual([]);
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(
        /advances?[_ -]?report|computeAdvanceBalance|bookedRemaining|advanceBalance|availableMinor|unapplied[_ -]?receipts?|LIABILITY\.UNAPPLIED_RECEIPTS|LIABILITY\.CUSTOMER_ADVANCES|reservedMinor/i,
      );
    }
  });

  it('no migration 50, no schema change, no permission change, no role-template change, no new permission key', () => {
    const migrations = join(ROOT, 'packages/db/prisma/migrations');
    const dirs = readdirSync(migrations).filter((n) => !n.endsWith('.toml'));
    expect(dirs).toHaveLength(49);
    expect(dirs.sort()[dirs.length - 1]).toBe(
      '20261010120000_phase_3b8_currency_and_release_integrity',
    );
    expect(sha(join(ROOT, 'packages/db/prisma/schema.prisma'))).toBe(
      '15ef99cee245e0cc64166ab6a5156767b4795a0a7b763435207514945ea37459',
    );
    expect(sha(join(ROOT, 'packages/permissions/src/index.ts'))).toBe(
      '20f66e4258f62899b67471a4f0e64fe84f8098a2dffe9a4b6575734729ed4c42',
    );
    expect(sha(join(SRC, 'modules/platform/system-roles.ts'))).toBe(
      '977d2e6bd6e215b70d034ce6b6def9e3ff97eb282555541c271ce278028d14f0',
    );
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(/['"`]\w+:[a-z_]+(?::[a-z_]+)?['"`]\s*[,)\]]/);
    }
  });

  it('no Task 3b.11 / tagging work, no X / Z report, no shift, no inventory / BOM, no POS dimension', () => {
    for (const n of D_PRODUCTION) {
      expect(read(join(DIR, n)), n).not.toMatch(/3b\.11|phase-3-complete/i);
      expect(dBare(n), n).not.toMatch(
        /posTerminal|pos_terminal|terminalId|zReport|xReport|shift|inventory|bom\b/i,
      );
    }
    expect(SQL).not.toMatch(/posTerminal|pos_terminal|"shift"|"inventory/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — the exact frozen sources: receivable source types, AR journal kinds and producers (discovered, never assumed)', () => {
  it('the frozen receivable source-type set is EXACTLY INVOICE | OPENING | CANCELLATION_CHARGE: the helper tuple, the SQL constants and the database CHECK agree', () => {
    expect([...RECEIVABLE_SOURCE_TYPES]).toEqual(['INVOICE', 'OPENING', 'CANCELLATION_CHARGE']);
    expect(Object.values(AR_SOURCE_TYPES).sort()).toEqual([...RECEIVABLE_SOURCE_TYPES].sort());
    const check = read(
      join(
        ROOT,
        'packages/db/prisma/migrations/20261005120000_phase_3b8_credit_refund_core/migration.sql',
      ),
    );
    expect(check).toMatch(
      /"customer_receivable_source_type_chk"[\s\S]{0,200}CHECK \("sourceType" IN \('INVOICE', 'OPENING', 'CANCELLATION_CHARGE'\)\)/,
    );
    // the pure module imports the frozen tuple — it never retypes a source type
    expect(dProd(PURE)).toMatch(/RECEIVABLE_SOURCE_TYPES/);
    expect(dBare(PURE)).not.toMatch(/INVOICE|OPENING|CANCELLATION_CHARGE/);
    // …including as a string literal (the bare-code view blanks strings, so a retyped tuple needs its own check)
    expect(dProd(PURE)).not.toMatch(/['"`](?:INVOICE|OPENING|CANCELLATION_CHARGE)['"`]/);
  });

  it('every AR journal kind literal is EXACTLY the literal its producer posts, on the AR side the producer posts it', () => {
    const producers: [string, string, 'debit' | 'credit'][] = [
      ['invoice_ar', 'receivables/customer-invoice-ar.repository.ts', 'debit'],
      ['opening_receivable', 'receivables/opening-balance.repository.ts', 'debit'],
      ['cancellation_charge', 'orders/cancellation-charge.repository.ts', 'debit'],
      ['payment_allocation', 'receivables/customer-receipt-effects.repository.ts', 'credit'],
      [
        'opening_receivable_payment_application',
        'receivables/customer-receipt-effects.repository.ts',
        'credit',
      ],
      [
        'cancellation_charge_payment_application',
        'receivables/customer-receipt-effects.repository.ts',
        'credit',
      ],
      [
        'customer_advance_application',
        'receivables/customer-advance-application.repository.ts',
        'credit',
      ],
      ['credit_note', 'orders/credit-note.repository.ts', 'credit'],
    ];
    expect(Object.values(AR_JOURNAL_KINDS).sort()).toEqual(producers.map((p) => p[0]).sort());
    for (const [kind, file, side] of producers) {
      const src = modules(file);
      expect(src, `${kind} literal in ${file}`).toContain(`'${kind}'`);
      expect(src, `${file} AR ${side}`).toMatch(
        new RegExp(`accountKey: 'ASSET\\.ACCOUNTS_RECEIVABLE',\\s*direction: '${side}'`),
      );
    }
    // AR INCREASES are a debit (an invoice, an opening receivable, a cancellation charge) — never the reverse
    for (const f of [
      'receivables/customer-invoice-ar.repository.ts',
      'receivables/opening-balance.repository.ts',
      'orders/cancellation-charge.repository.ts',
    ]) {
      expect(modules(f), f).not.toMatch(
        /accountKey: 'ASSET\.ACCOUNTS_RECEIVABLE',\s*direction: 'credit'/,
      );
    }
  });

  it('the AR-touching producers are a CLOSED set — a new producer of an AR line, or of any journal, fails here until its AR effect is reviewed', () => {
    const arFiles = walk(join(SRC, 'modules'))
      .filter((f) => f.endsWith('.ts') && !isTest(f))
      .filter((f) => /ASSET\.ACCOUNTS_RECEIVABLE/.test(read(f)))
      .map((f) => relative(join(SRC, 'modules'), f).replace(/\\/g, '/'))
      .sort();
    expect(arFiles).toEqual(
      [
        'orders/cancellation-charge.repository.ts',
        'orders/credit-note.repository.ts',
        'receivables/customer-advance-application.repository.ts',
        'receivables/customer-invoice-ar.repository.ts',
        'receivables/customer-receipt-effects.repository.ts',
        'receivables/opening-balance.repository.ts',
        'reporting/receivables-report.sql.ts',
      ].sort(),
    );
    const posters = walk(join(SRC, 'modules'))
      .filter((f) => f.endsWith('.ts') && !isTest(f))
      .filter((f) => /\bpostJournal\(/.test(stripComments(read(f))))
      .map((f) => relative(join(SRC, 'modules'), f).replace(/\\/g, '/'))
      .filter((f) => f !== 'accounting/posting-engine.service.ts')
      .sort();
    expect(posters).toEqual(
      [
        'orders/cancellation-charge.repository.ts',
        'orders/credit-note.repository.ts',
        'receivables/customer-advance-application.repository.ts',
        'receivables/customer-invoice-ar.repository.ts',
        'receivables/customer-receipt-effects.repository.ts',
        'receivables/opening-balance.repository.ts',
        'receivables/payment-advance-conversion.repository.ts',
        'receivables/refund-attempt-reservation.repository.ts',
        'receivables/refund-execution.repository.ts',
        'sales/walk-in-sale-journal.repository.ts',
        'settlements/settlement-finalization.repository.ts',
      ].sort(),
    );
  });

  it('the journals that never touch AR are not in the control: walk-in sale, customer receipt, advance conversion / opening advance, refund, settlement', () => {
    const kinds = Object.values(AR_JOURNAL_KINDS) as string[];
    for (const excluded of [
      'walk_in_sale',
      'customer_receipt_payment',
      'customer_advance',
      'opening_advance',
      'refund',
      'SETTLEMENT_BATCH',
      'manual_adjustment',
    ]) {
      expect(kinds, excluded).not.toContain(excluded);
      expect(dProd(SQLF), excluded).not.toContain(`'${excluded}'`);
    }
    expect(kinds).toHaveLength(8);
  });

  it('the AR account key is the frozen chart-of-accounts key', () => {
    expect(AR_ACCOUNT_KEY).toBe('ASSET.ACCOUNTS_RECEIVABLE');
    expect(ACCOUNTING_REFERENCE_ACCOUNTS.some((a) => a.key === AR_ACCOUNT_KEY)).toBe(true);
    expect((SQL.match(/a(?:a)?\."key" = 'ASSET\.ACCOUNTS_RECEIVABLE'/g) ?? []).length).toBe(2);
    expect(SQL).not.toMatch(/LIKE|ILIKE|~\s*'/); // never a pattern match on an account
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — balance semantics: the frozen computeReceivableBalance, each source counted once', () => {
  it('the equation is the frozen helper’s — the pure module CALLS it and never writes the formula; the SQL only sums its components', () => {
    const pure = dProd(PURE);
    expect(pure).toMatch(
      /import \{[^}]*computeReceivableBalance[^}]*\} from '\.\.\/receivables\/receivable-balance\.js'/,
    );
    expect((pure.match(/computeReceivableBalance\(/g) ?? []).length).toBe(1);
    // no second copy of original − paid − paid − credited in the pure module
    expect(pure).not.toMatch(
      /original\s*-\s*\w*paid|principal\w*\s*-\s*\w*paid|paidByPayment\w*\s*-\s*\w*paidByAdvance/i,
    );
    // the helper's own contract (its doc) is the equation the pins rely on
    expect(modules('receivables/receivable-balance.ts')).toMatch(
      /outstanding = principal − paidByPayment − paidByAdvance − credited/,
    );
    // an over-covered receivable fails closed in the report even though the helper tolerates it
    expect(pure).toMatch(/outstandingMinor < 0n/);
  });

  it('the SQL components mirror the frozen loader by source type: INVOICE → PaymentAllocation, the others → the receivable payment application, advance applications for all, CreditNote only on INVOICE', () => {
    const loader = modules('receivables/receivable-balance.repository.ts');
    for (const needle of [
      'SUM(pa."amountMinor") FROM "payment_allocation" pa WHERE pa."invoiceId" = cr."invoiceId"',
      'SUM(crpa."amountMinor") FROM "customer_receivable_payment_application" crpa WHERE crpa."customerReceivableId" = cr."id"',
      'SUM(caa."amountMinor") FROM "customer_advance_application" caa WHERE caa."customerReceivableId" = cr."id"',
      'SUM(cn."arReductionMinor") FROM "credit_note" cn WHERE cn."invoiceId" = cr."invoiceId"',
    ]) {
      expect(loader).toContain(needle);
    }
    expect(SQL).toMatch(/JOIN rcv r ON r\."inv" = pa\."invoiceId" AND r\."st" = 'INVOICE'/);
    expect(SQL).toMatch(
      /JOIN rcv r ON r\."rid" = crpa\."customerReceivableId" AND r\."st" <> 'INVOICE'/,
    );
    expect(SQL).toMatch(/JOIN rcv r ON r\."rid" = caa\."customerReceivableId"\n/);
    expect(SQL).toMatch(/JOIN rcv r ON r\."inv" = cn\."invoiceId" AND r\."st" = 'INVOICE'/);
    expect(SQL).toMatch(/WHEN 'INVOICE' THEN i\."totalAmountMinor"/);
    expect(SQL).toMatch(/WHEN 'OPENING' THEN cr\."openingAmountMinor"/);
    expect(SQL).toMatch(/WHEN 'CANCELLATION_CHARGE' THEN cc\."totalAmountMinor"/);
    expect(SQL).toMatch(
      /r\."principal" - COALESCE\(g\."pay", 0\) - COALESCE\(g\."adv", 0\) - COALESCE\(g\."crd", 0\) AS "outstanding"/,
    );
  });

  it('the statement reads EXACTLY these tables — never a Payment, Refund, CustomerAdvance, Settlement, order, customer (PII) or CreditNote line', () => {
    const refs = [...SQL.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((m) => m[1]!);
    expect([...new Set(refs)].sort()).toEqual(
      [
        'account',
        'branch',
        'cancellation_charge',
        'company',
        'credit_note',
        'customer_advance_application',
        'customer_company_account',
        'customer_receivable',
        'customer_receivable_payment_application',
        'invoice',
        'journal_entry',
        'journal_line',
        'payment_allocation',
      ].sort(),
    );
    for (const forbidden of [
      'payment',
      'refund',
      'customer_advance',
      'customer',
      'order',
      'order_line',
      'credit_note_line',
      'credit_note_coverage_release',
      'customer_account_entry',
      'settlement_application',
      'settlement_batch',
      'payment_attempt',
      'refund_attempt',
    ]) {
      expect(SQL, forbidden).not.toMatch(new RegExp(`(?:FROM|JOIN)\\s+"${forbidden}"`));
    }
  });

  it('each application source is read ONCE as a source of AR reduction: PaymentAllocation once, AdvanceApplication once, the receivable payment application once, CreditNote AR reduction once', () => {
    const inApp = SQL.slice(SQL.indexOf('app AS MATERIALIZED ('), SQL.indexOf('agg AS ('));
    expect((inApp.match(/FROM "payment_allocation" pa/g) ?? []).length).toBe(1);
    expect((inApp.match(/FROM "customer_advance_application" caa/g) ?? []).length).toBe(1);
    expect((inApp.match(/FROM "customer_receivable_payment_application" crpa/g) ?? []).length).toBe(
      1,
    );
    expect((inApp.match(/FROM "credit_note" cn/g) ?? []).length).toBe(1);
    // the only other readers are integrity counters, never an amount
    expect((SQL.match(/"payment_allocation"/g) ?? []).length).toBe(1);
    expect((SQL.match(/"customer_advance_application"/g) ?? []).length).toBe(1);
    expect((SQL.match(/"customer_receivable_payment_application"/g) ?? []).length).toBe(2);
    expect((SQL.match(/FROM "credit_note"/g) ?? []).length).toBe(2);
    // the amounts that move AR: the allocation, advance-application and receivable-payment-application amount, and ONLY the AR reduction
    expect(inApp).toMatch(/pa\."amountMinor" AS "amt"/);
    expect(inApp).toMatch(/crpa\."amountMinor"/);
    expect(inApp).toMatch(/caa\."amountMinor"/);
    expect(inApp).toMatch(/cn\."arReductionMinor"/);
  });

  it('a CreditNote’s EXCESS advance is never subtracted again and never receivable: no advanceExcess, no CreditNote total, no CustomerAdvance read anywhere', () => {
    expect(SQL).not.toMatch(
      /advanceExcessMinor|cn\."totalAmountMinor"|cnx\."totalAmountMinor"|subtotalAmountMinor|taxTotalAmountMinor/,
    );
    expect((SQL.match(/cn\."arReductionMinor"/g) ?? []).length).toBe(2); // the amount and its > 0 guard
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(/advanceExcess|CREDIT_NOTE|coverageRelease/);
    }
  });

  it('a Payment RECEIPT is not an AR reduction, an Advance CREATION is not, a Refund is not, a settlement is not: none of their tables or journal kinds is read', () => {
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(
        /customer_receipt_payment|customer_advance'|opening_advance|'refund'|SETTLEMENT_BATCH|settlement|\bRefund\b|walk_in_sale/,
      );
    }
    expect(SQL).not.toMatch(/"payment"\s|"refund"|settlement|"customer_advance"\s/);
  });

  it('zero-outstanding receivables stay in every total and in the customer rows: there is NO open-only filter', () => {
    expect(SQL).not.toMatch(/"outstanding"\s*>\s*0|"outstanding"\s*<>\s*0|outstanding\s*!=\s*0/);
    const rc = SQL.slice(SQL.indexOf('rc AS ('), SQL.indexOf('cells AS ('));
    expect(rc).not.toMatch(/\bWHERE\b/);
    const pg = SQL.slice(SQL.indexOf('pg AS ('), SQL.indexOf('pgn AS ('));
    expect(pg).not.toMatch(/outstanding/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — a CURRENT snapshot only: no period, no historical asOf input, no aging, no customer PII', () => {
  it('there is NO date input: no from / to / asOf / date parameter, no shared date contract, no date column anywhere in the statement', () => {
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(
        /report-date-range|parseReportDateRange|isFiscalDate|inclusiveCivilDays|sales-report-range|ReportDateRange/,
      );
      // no date-shaped input anywhere in any production file (not only in the two public signatures)
      expect(dBare(n), n).not.toMatch(/\binput\.(?:from|to|asOf|date|period|at)\b/);
      expect(dBare(n), n).not.toMatch(/\b(?:from|to|date|period)\s*\??:\s*(?:string|Date)\b/);
    }
    const inputs = [
      ...dProd(REPO).matchAll(
        /(?:getBranchReportScoped|getCompanyReportScoped|private async read)\(input: \{([^}]*)\}/g,
      ),
      ...dProd(SVC).matchAll(/(?:branchReport|companyReport)\(input: \{([^}]*)\}/g),
    ].map((m) => m[1]!);
    expect(inputs.length).toBeGreaterThanOrEqual(5);
    for (const body of inputs)
      expect(body).not.toMatch(/\b(?:from|to|asOf|date|at|period)\b\s*\??:/);
    expect(SQL).not.toMatch(
      /postingDate|invoiceDate|createdAt|updatedAt|accountingDate|openingEffectiveDate|issuedAt|"date"|BETWEEN/i,
    );
  });

  it('asOf is derived by the DATABASE in the same statement (statement_timestamp, ISO-8601 UTC) — never the application clock, never an input', () => {
    expect((SQL.match(/statement_timestamp\(\)/g) ?? []).length).toBe(1);
    expect(SQL).toMatch(
      /'asOf', to_char\(statement_timestamp\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/,
    );
    expect(SQL).not.toMatch(
      /\bnow\(\)|CURRENT_DATE|CURRENT_TIMESTAMP|clock_timestamp|transaction_timestamp|random\(\)/i,
    );
    for (const n of D_PRODUCTION) {
      expect(dBare(n), n).not.toMatch(/new Date\(|Date\.now|Clock\b|SystemClock|performance\.now/);
    }
    // the only asOf the repository emits is the one the statement returned, validated against the database format
    const repo = dProd(REPO);
    expect(repo).toMatch(/asOf: assertAsOf\(json\.asOf\)/);
    expect((repo.match(/asOf/g) ?? []).length).toBe(3); // the header type, its assertion, the JSON member
  });

  it('NO aging: no ageDays, no aging / due-date / overdue / bucket anything in the Receivables code', () => {
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(
        /ageDays|\bage\b|aging|ageing|due[_ -]?date|dueDate|overdue|bucket|daysBetween|dayDiff|past[_ -]?due/i,
      );
    }
    expect(SQL).not.toMatch(/age\(|interval|date_part|extract\s*\(/i);
  });

  it('NO customer PII is read or returned: the customer table, name, phone, e-mail and address never appear; the customer is reached through customer_company_account.customerId only', () => {
    expect(SQL).not.toMatch(
      /"customer"\s|displayName|phoneE164|emailNormalized|address|"note"|openingNote|customerDisplayNameSnapshot/i,
    );
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(
        /displayName|phone|e-?mail|address|customerName|openingNote|DisplayNameSnapshot/i,
      );
    }
    expect(SQL).toMatch(/x\."customerId" AS "cust"/);
    // a row of the page is financial identifiers only
    const row = buildCustomerRows([
      {
        customerId: 'c',
        sourceType: 'INVOICE',
        count: 1,
        original: 1n,
        paidByPayment: 0n,
        paidByAdvance: 0n,
        credited: 0n,
      },
    ])[0]!;
    expect(Object.keys(row).sort()).toEqual([
      'creditedMinor',
      'customerId',
      'originalMinor',
      'outstandingMinor',
      'paidByAdvanceMinor',
      'paidByPaymentMinor',
      'receivableCount',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — ONE statement, ONE read-only snapshot; explicit tenant / company / branch predicates; no branch RLS dependency', () => {
  it('the repository runs exactly one raw statement through the database-enforced read-only scoped transaction', () => {
    const repo = dProd(REPO);
    expect((repo.match(/\$queryRawUnsafe/g) ?? []).length).toBe(1);
    expect((repo.match(/readScoped\(/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(
      /\$executeRaw|\$queryRaw(?!Unsafe)|\.scoped\(|runScoped|\$transaction/,
    );
    expect(repo).toMatch(/extends ReportingRepository/);
  });

  it('no loop or fan-out issues SQL (no N+1, no per-customer query, no summary / page / GL triple)', () => {
    for (const n of [REPO, SVC]) {
      const code = dBare(n);
      expect(code, n).not.toMatch(
        /Promise\.all|for await|\.map\(async|\.forEach\(async|setTimeout|setInterval/,
      );
      expect(code, n).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*await/);
      expect(code, n).not.toMatch(/while\s*\([^)]*\)\s*\{[^}]*await/);
    }
    expect((dProd(SVC).match(/this\.repo\./g) ?? []).length).toBe(2); // one call per route
    expect(dProd(REPO)).not.toMatch(/COUNT\(/);
    expect((dProd(REPO).match(/this\.read\(/g) ?? []).length).toBe(2);
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

  it('carries EXPLICIT tenant + company predicates on EVERY table it touches — never RLS or the branch GUC', () => {
    // EVERY table reference carries its OWN predicate: per alias, the number of `alias."tenantId" = $1` (and
    // `alias."companyId" = $2`) predicates equals the number of references — one removed anywhere is caught
    const refs = [...SQL.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"\s+([a-z0-9]+)/g)];
    expect(refs.length).toBe(21); // 19 + the density gate's two (customer_receivable cg, customer_company_account xg)
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
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(/app\.branch_id|app\.tenant_id|current_setting|set_config/i);
    }
  });

  it('the branch scope is the receivable’s OWN branch ($3), explicit — and NULL for the company report; the customer scope reaches totals, rows AND the GL control', () => {
    expect((SQL.match(/\$3::uuid IS NULL OR cr\."branchId" = \$3::uuid/g) ?? []).length).toBe(1);
    expect(SQL).toMatch(/b\."id" = \$3::uuid/);
    expect((SQL.match(/\$4::uuid IS NULL OR x\."customerId" = \$4::uuid/g) ?? []).length).toBe(1);
    expect(SQL).toMatch(/sc\."customerId" = \$4::uuid/);
    // the filters scope `rcv`, from which every figure, the page AND the facts of the GL control descend
    const afterRcv = SQL.slice(SQL.indexOf('app AS MATERIALIZED ('));
    expect(afterRcv).not.toMatch(/cr\."branchId" = \$3/);
    expect(SQL.slice(0, SQL.indexOf('app AS MATERIALIZED ('))).toMatch(
      /cr\."branchId" = \$3::uuid/,
    );
    // an unattributable journal can only be judged on the UNFILTERED report: those scans are guarded by both filters being NULL
    const jh = SQL.slice(
      SQL.indexOf('jh AS MATERIALIZED ('),
      SQL.indexOf('jall AS MATERIALIZED ('),
    );
    expect(jh).toMatch(/\$3::uuid IS NULL\s+AND \$4::uuid IS NULL/);
    // the reconciliation join has TWO mutually exclusive branches: the unfiltered FULL JOIN (facts × every authoritative
    // AR line — where an unattributable line shows up as line-only) and the filtered fact-driven LEFT JOINs
    const jx = SQL.slice(SQL.indexOf('jx AS MATERIALIZED ('), SQL.indexOf('rcc AS ('));
    expect(jx).toMatch(/FULL JOIN jall y ON/);
    expect(jx).toMatch(/WHERE \$3::uuid IS NULL\s+AND \$4::uuid IS NULL/);
    expect(jx).toMatch(/WHERE \(\$3::uuid IS NOT NULL OR \$4::uuid IS NOT NULL\)/);
    expect((jx.match(/FULL JOIN/g) ?? []).length).toBe(1);
  });

  it('the AR control reads only SEALED journals of the eight authoritative kinds, every journal read carries a kind predicate, and the GL is judged against the FACTS of the same scope', () => {
    expect((SQL.match(/"sealedAt" IS NOT NULL/g) ?? []).length).toBe(2);
    expect((SQL.match(/je\."sourceKind" IN \(/g) ?? []).length).toBe(1);
    expect((SQL.match(/je\."sourceKind" = f\."kind"/g) ?? []).length).toBe(1);
    const list = [...SQL.matchAll(/je\."sourceKind" IN \(([^)]*)\)/g)];
    expect(
      list[0]![1]!
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort(),
    ).toEqual(Object.values(AR_JOURNAL_KINDS).sort());
    // the facts: every receivable + every application — and nothing else
    const fact = SQL.slice(
      SQL.indexOf('fact AS MATERIALIZED ('),
      SQL.indexOf('jall AS MATERIALIZED ('),
    );
    expect((fact.match(/FROM rcv r/g) ?? []).length).toBe(1);
    expect((fact.match(/FROM app a/g) ?? []).length).toBe(1);
    // a whole-AR-account balance is never the control: an AR line is only ever reached through a kind-constrained journal
    expect(SQL).not.toMatch(/SUM\([a-z]+\."debitMinor" - /);
  });

  it('the reconciliation is exactly { sourceOutstandingMinor, glAccountsReceivableMinor, differenceMinor, reconciled } and a difference fails the report closed with the GL sign debit − credit', () => {
    const b = buildReceivablesBlocks([], 0n);
    expect(Object.keys(b.reconciliation).sort()).toEqual([
      'differenceMinor',
      'glAccountsReceivableMinor',
      'reconciled',
      'sourceOutstandingMinor',
    ]);
    const pure = dProd(PURE);
    expect(pure).toMatch(/total\.outstanding - glNetMinor/);
    expect(pure).toMatch(
      /const difference = total\.outstanding - glNetMinor;\s*if \(difference !== 0n\) \{\s*throw new DomainError\(\s*'REPORT_RECEIVABLES_GL_MISMATCH'/,
    );
    expect(dProd(REPO)).toMatch(
      /parseMinorUnitsText\(g\.debitMinor, 'debitMinor'\) -\s*parseMinorUnitsText\(g\.creditMinor, 'creditMinor'\)/,
    );
    // the GL figure never leaves a failed control behind: nothing returns before the blocks (and so the control) are built
    expect(dProd(REPO)).not.toMatch(/reconciled:\s*false/);
  });

  it('the integrity gate: the currency error first (409), then every named check (500) — non-disclosing', () => {
    const repo = dProd(REPO);
    expect(repo).toMatch(/'REPORT_CURRENCY_MISMATCH'/);
    expect(repo).toMatch(/'REPORT_RECEIVABLES_SOURCE_INTEGRITY'/);
    const currency = repo.indexOf("'REPORT_CURRENCY_MISMATCH'");
    const integrity = repo.indexOf("'REPORT_RECEIVABLES_SOURCE_INTEGRITY'");
    expect(currency).toBeGreaterThan(-1);
    expect(currency).toBeLessThan(integrity);
    // each guard is exactly the condition that throws its own code — and the code is named once per throw site
    expect(repo).toMatch(
      /if \(i\.currencyMismatchDocuments > 0\) \{\s*throw new DomainError\(\s*'REPORT_CURRENCY_MISMATCH'/,
    );
    expect(repo).toMatch(
      /if \(broken\.length > 0\) \{\s*throw new DomainError\(\s*'REPORT_RECEIVABLES_SOURCE_INTEGRITY'/,
    );
    expect(repo).toMatch(
      /if \(rows\.length > limit\) \{\s*throw new DomainError\(\s*'REPORT_RECEIVABLES_SOURCE_INTEGRITY'/,
    );
    expect((repo.match(/'REPORT_RECEIVABLES_SOURCE_INTEGRITY'/g) ?? []).length).toBe(2);
    expect((repo.match(/'REPORT_CURRENCY_MISMATCH'/g) ?? []).length).toBe(1);
    for (const check of [
      'unknownSourceTypes',
      'unresolvedPrincipals',
      'overCoveredReceivables',
      'sourceBranchMismatches',
      'applicationBranchMismatches',
      'paymentApplicationsOnInvoiceReceivables',
      'missingJournals',
      'journalShapeMismatches',
      'journalBranchMismatches',
      'orphanJournals',
      'creditNotesWithoutReceivable',
    ]) {
      expect(repo, check).toContain(`['${check}', i.${check}]`);
      expect(SQL, check).toContain(`AS "${check}"`);
    }
    expect(repo).toMatch(/resolveCompanyReportAuthority\(json\.company\)/);
    expect(repo).toMatch(/assertSourceIntegrity\(json\)/);
    // the company / branch / customer 404 comes BEFORE the authority and every check
    expect(repo.indexOf("throw new NotFoundError('company')")).toBeLessThan(
      repo.indexOf('resolveCompanyReportAuthority(json.company)'),
    );
    expect(repo.indexOf("throw new NotFoundError('customer')")).toBeLessThan(
      repo.indexOf('assertSourceIntegrity(json)'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — pagination reuses the customer-account read model’s convention; the page is keyset-ordered and never changes the summary', () => {
  it('the default 50, the max 200 and the INVALID_LIMIT / INVALID_CURSOR codes are EXACTLY the shared read-model convention (module-private there — pinned equal, never drifting)', () => {
    const shared = modules('receivables/customer-account-read.repository.ts');
    expect(shared).toMatch(
      new RegExp(`const DEFAULT_LIST_LIMIT = ${RECEIVABLES_REPORT_DEFAULT_LIMIT};`),
    );
    expect(shared).toMatch(new RegExp(`const MAX_LIST_LIMIT = ${RECEIVABLES_REPORT_MAX_LIMIT};`));
    expect(RECEIVABLES_REPORT_DEFAULT_LIMIT).toBe(50);
    expect(RECEIVABLES_REPORT_MAX_LIMIT).toBe(200);
    expect(shared).toMatch(/'INVALID_LIMIT', 'limit must be a positive integer', 400/);
    expect(shared).toMatch(/'INVALID_CURSOR', `\$\{field\} is not a valid cursor`, 400/);
    expect(shared).toMatch(/return Math\.min\(limit, MAX_LIST_LIMIT\)/);
    const pure = dProd(PURE);
    expect(pure).toMatch(/'INVALID_LIMIT', 'limit must be a positive integer', 400/);
    expect(pure).toMatch(/'INVALID_CURSOR', 'cursor is not a valid cursor', 400/);
    expect(pure).toMatch(
      /limit > RECEIVABLES_REPORT_MAX_LIMIT \? RECEIVABLES_REPORT_MAX_LIMIT : limit/,
    );
    // the constants are defined ONCE and never repeated as a literal elsewhere in production
    for (const n of D_PRODUCTION.filter((x) => x !== PURE)) {
      expect(dProd(n), n).not.toMatch(/\b50\b|\b200\b/);
    }
  });

  it('the page is a deterministic keyset on customerId (limit + 1 lookahead, row_number cut), ordered ascending, never aging-based', () => {
    expect(SQL).toMatch(/\(\$5::uuid IS NULL OR r\."cust" > \$5::uuid\)/);
    expect(SQL).toMatch(/ORDER BY r\."cust"\n\s+LIMIT \(\$6::int \+ 1\)/);
    expect(SQL).toMatch(/p\."rn" <= \$6::int/);
    expect(SQL).toMatch(/'hasMore', EXISTS \(SELECT 1 FROM pgn p WHERE p\."rn" > \$6::int\)/);
    const repo = dProd(REPO);
    expect(repo).toMatch(
      /nextCursor: json\.hasMore && rows\.length > 0 \? rows\[rows\.length - 1\]!\.customerId : null/,
    );
    expect(SQL).not.toMatch(/ORDER BY r\."(?:outstanding|principal|pay|adv)"/);
  });

  it('the summary, byBranch and the GL control are the WHOLE scope: they are built from `cells` / `jl`, never from the page', () => {
    const cells = SQL.slice(SQL.indexOf('cells AS ('), SQL.indexOf('pg AS ('));
    expect(cells).not.toMatch(/pgn|\$5|\$6/);
    expect(SQL).toMatch(/FROM cells x\), '\[\]'::json\)/);
    const repo = dProd(REPO);
    expect(repo).toMatch(
      /buildReceivablesBlocks\(\[\.\.\.cells\.values\(\)\]\.flat\(\), glTotal\)/,
    );
    expect(repo).not.toMatch(/customerCells[\s\S]{0,80}buildReceivablesBlocks/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — exact money: integer minor units, no float, no FX, no rounding; no audit / outbox / realtime', () => {
  it('no floating point, no Number() conversion, no Math, no rounding, no FX in the Receivables code', () => {
    for (const n of D_PRODUCTION) {
      const code = dBare(n);
      expect(code, n).not.toMatch(
        /parseFloat|\bNumber\(|toFixed|toPrecision|Math\.(?:round|floor|ceil|trunc)|Decimal|BigNumber/,
      );
      expect(dProd(n), n).not.toMatch(/\b\d+\.\d+\b/);
      expect(dProd(n), n).not.toMatch(/\bfx\b|exchange[_ ]?rate|convertCurrency/i);
    }
    expect(SQL).not.toMatch(/::numeric|::float|::double|ROUND\(|CEIL\(|FLOOR\(|real\b|numeric\(/i);
  });

  it('every money aggregate leaves the database as TEXT and is parsed strictly; counts are JSON integers', () => {
    for (const k of ['orig', 'pay', 'adv', 'crd']) {
      // once in the company cells and once in the customer cells — each member is text on its own
      expect((SQL.match(new RegExp(`x\\."${k}"::text`, 'g')) ?? []).length, k).toBe(2);
    }
    expect(SQL).toMatch(/'debitMinor', g\."d"::text/);
    expect(SQL).toMatch(/'creditMinor', g\."c"::text/);
    expect(SQL).toMatch(/'debitMinor', c\."orphanD"::text, 'creditMinor', c\."orphanC"::text/);
    const repo = dProd(REPO);
    for (const label of [
      'originalMinor',
      'paidByPaymentMinor',
      'paidByAdvanceMinor',
      'creditedMinor',
      'debitMinor',
      'creditMinor',
    ]) {
      expect(repo).toContain(`parseMinorUnitsText(`);
      expect(repo).toContain(`'${label}'`);
    }
    expect(repo).not.toMatch(/BigInt\(\w+\.\w+Minor\)/);
  });

  it('no audit, no outbox, no realtime, no idempotency, no clock, no random: a report is a pure function of the committed ledger', () => {
    for (const n of D_PRODUCTION) {
      expect(dBare(n), n).not.toMatch(
        /AuditWriter|OutboxWriter|Idempotent|RealtimeGateway|publishRealtime|IdempotencyKey|new Date\(|Date\.now|Math\.random|randomUUID/,
      );
    }
    expect(SQL).not.toMatch(/\bnow\(\)|CURRENT_DATE|CURRENT_TIMESTAMP|random\(\)/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — the report shape and labels', () => {
  it('the blocks are note / figures / bySourceType / reconciliation — and no sales, receipts, revenue, profit, settled or aging field', () => {
    const b = buildReceivablesBlocks([], 0n);
    expect(Object.keys(b).sort()).toEqual(
      [
        'bySourceType',
        'creditedMinor',
        'note',
        'originalMinor',
        'outstandingMinor',
        'paidByAdvanceMinor',
        'paidByPaymentMinor',
        'reconciliation',
        'receivableCount',
      ].sort(),
    );
    expect(b.bySourceType.map((r) => r.sourceType)).toEqual([...RECEIVABLE_SOURCE_TYPES]);
    for (const row of b.bySourceType) {
      expect(Object.keys(row).sort()).toEqual([
        'creditedMinor',
        'originalMinor',
        'outstandingMinor',
        'paidByAdvanceMinor',
        'paidByPaymentMinor',
        'receivableCount',
        'sourceType',
      ]);
    }
    expect(JSON.stringify(b)).not.toMatch(
      /"(?:sales|revenue|profit|settled|receiptTotal|netSales|ageDays)\w*"/i,
    );
    // the note denies every figure it must not be mistaken for
    expect(b.note).toMatch(/not sales, not receipts, not revenue and not settled money/);
    expect(b.note).toMatch(/not a historical figure/);
  });

  it('the header is companyId / currency / exponent / timezone / asOf / customerId — and the branch route adds only branchId, the company route only byBranch', () => {
    const repo = dProd(REPO);
    const header = repo.slice(
      repo.indexOf('interface ReportHeader'),
      repo.indexOf('/** The per-customer page'),
    );
    for (const key of [
      'companyId',
      'currencyCode',
      'currencyExponent',
      'accountingTimezone',
      'asOf',
      'customerId',
    ]) {
      expect(header, key).toMatch(new RegExp(`readonly ${key}:`));
    }
    expect(repo).toMatch(
      /interface ReceivablesBranchReport extends ReportHeader, ReceivablesBlocks \{\s*readonly branchId: string;\s*readonly customers: ReceivablesCustomerPage;/,
    );
    expect(repo).toMatch(
      /interface ReceivablesCompanyReport extends ReportHeader, ReceivablesBlocks \{\s*readonly byBranch: readonly ReceivablesBranchRow\[\];\s*readonly customers: ReceivablesCustomerPage;/,
    );
  });

  it('the company control is the whole authoritative AR: every branch’s journals plus, only on the unfiltered report, an unattributable journal — and byBranch rows are built from their own branch', () => {
    const repo = dProd(REPO);
    expect(repo).toMatch(
      /let glTotal = orphanNet;\s*for \(const v of gl\.values\(\)\) glTotal \+= v;/,
    );
    expect(repo).toMatch(
      /\.\.\.buildReceivablesBlocks\(branchCells, gl\.get\(branchId\) \?\? 0n\)/,
    );
    expect(repo).toMatch(
      /buildReceivablesBlocks\(\s*cells\.get\(input\.branchId\) \?\? \[\],\s*gl\.get\(input\.branchId\) \?\? 0n,?\s*\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — the integration suite, the volume gate and the unit suite pin their own contracts', () => {
  const it_ = (): string => read(join(DIR, 'receivables-report.integration.test.ts'));
  const qp = (): string => read(join(DIR, 'receivables-report.query-plan.integration.test.ts'));

  it('the integration suite builds every receivable through the frozen flows and compares with a model oracle folded by the FROZEN helper', () => {
    const src = it_();
    for (const route of [
      '/complete-sale',
      '/receipts',
      '/opening-balance',
      '/advances/from-payment',
      '/applications',
      '/cancel',
    ]) {
      expect(src, route).toContain(route);
    }
    expect(src).toMatch(/import \{[^}]*\bcomputeReceivableBalance\b[^}]*\} from/);
    expect(src).toMatch(/\bcomputeReceivableBalance\(\{/);
    expect(src).toMatch(/async function loadModel/);
    expect(src).toMatch(/async function glOracle/);
    expect(src).toMatch(/cancellationCharge: \{ requestedAmountMinor: '800'/);
    // the raw fixtures are the malformed ones only: no receivable of the clean world is written directly
    expect((src.match(/INSERT INTO customer_receivable\b/g) ?? []).length).toBe(0);
    expect((src.match(/INSERT INTO invoice\b/g) ?? []).length).toBe(0);
  });

  it('the volume gate EXPLAINs (ANALYZE, BUFFERS) the REAL statement over generated ledgers up to 100 000 receivables and records the benchmark disclaimer', () => {
    const src = qp();
    expect(src).toMatch(/EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
    expect(src).toMatch(/buildReceivablesReportQuery/);
    expect(src).toMatch(/RECEIVABLES_VOLUME_RECEIVABLES/);
    expect(src).toMatch(
      /const DISCLAIMER = 'Local test-container benchmark; not production capacity\.';/,
    );
    expect(src).toMatch(/disclaimer: DISCLAIMER/);
    expect(src).toMatch(/computeReceivableBalance/);
    expect(src).toMatch(/seq-scanned once per outer row/);
    expect(src).toMatch(/is scanned once per outer row/);
  });

  it('the unit suite proves the arithmetic differentially against the frozen helper', () => {
    const src = read(join(DIR, 'receivables-report.test.ts'));
    expect(src).toMatch(/DIFFERENTIALLY equal to the frozen computeReceivableBalance/);
    expect(src).toMatch(/computeReceivableBalance/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('D — the density guard (owner ruling RD-1): at most 100 000 receivables per EVALUATED scope, decided inside the same statement', () => {
  const GATE = /\(SELECT gt\."n" FROM gate gt\) <= 100000/g;
  /** the statement split into its stages (CTEs); the last stage also holds the final SELECT */
  const stages = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const part of SQL.replace(/^\s*WITH /, '').split(
      /\n(?=[a-z_0-9]+ AS (?:MATERIALIZED )?\()/,
    )) {
      const m = /^([a-z_0-9]+) AS /.exec(part.trimStart());
      if (m) out.set(m[1]!, part);
    }
    return out;
  };
  const gates = (text: string): number => (text.match(GATE) ?? []).length;

  it('the limit is ONE constant, 100 000 — defined once, built into the statement, the repository default; no other production file repeats the literal', () => {
    expect(RECEIVABLES_REPORT_MAX_RECEIVABLES).toBe(100_000);
    const sqlSrc = dProd(SQLF);
    expect((sqlSrc.match(/RECEIVABLES_REPORT_MAX_RECEIVABLES = 100_000;/g) ?? []).length).toBe(1);
    expect((sqlSrc.match(/100_000|100000|100 000/g) ?? []).length).toBe(1);
    for (const n of [PURE, REPO, SVC]) {
      expect(dBare(n), n).not.toMatch(/100_000|100000|100 000|100001/);
    }
    expect(sqlSrc).toMatch(
      /export const RECEIVABLES_REPORT_SQL = receivablesReportSql\(RECEIVABLES_REPORT_MAX_RECEIVABLES\);/,
    );
    expect(dProd(REPO)).toMatch(
      /protected readonly maxReceivables: number = RECEIVABLES_REPORT_MAX_RECEIVABLES;/,
    );
    expect(dProd(REPO)).toMatch(/maxReceivables: this\.maxReceivables,/);
    // the compiled statement: the gate reads limit + 1 once; every gate comparison uses the limit itself
    expect((SQL.match(/LIMIT 100001\b/g) ?? []).length).toBe(1);
    expect((SQL.match(/<= 100000\b/g) ?? []).length).toBe(11);
  });

  it('the gate is the FIRST stage of the SAME statement: an early-stopped count of at most limit + 1 receivables — never a COUNT query before the report', () => {
    const b = stages();
    const names = [...b.keys()];
    expect(names.slice(0, 5)).toEqual(['co', 'scope_branch', 'scope_customer', 'gate', 'rcv']);
    const gate = b.get('gate')!;
    expect(gate).toMatch(/^gate AS MATERIALIZED \(/);
    expect(gate).toMatch(/SELECT COUNT\(\*\) AS "n"/);
    expect((gate.match(/LIMIT 100001/g) ?? []).length).toBe(1);
    expect((SQL.match(/gate AS MATERIALIZED \(/g) ?? []).length).toBe(1);
    expect(SQL).toMatch(/'candidateReceivables', \(SELECT gt\."n" FROM gate gt\)/);
    // one statement: no second query and no COUNT anywhere in the production TypeScript
    expect((dProd(REPO).match(/\$queryRawUnsafe/g) ?? []).length).toBe(1);
    expect((dProd(REPO).match(/readScoped\(/g) ?? []).length).toBe(1);
    for (const n of [PURE, REPO, SVC]) expect(dProd(n), n).not.toMatch(/COUNT\(|\.count\(/);
    expect(dProd(SVC)).not.toMatch(/candidateReceivables/);
  });

  it('the gate counts EXACTLY the evaluated scope — tenant, company, the requested branch, the customer filter — the same predicates as `rcv`, and nothing else', () => {
    const gate = stages().get('gate')!;
    expect(gate).toMatch(/FROM "customer_receivable" cg/);
    expect(gate).toMatch(
      /JOIN "customer_company_account" xg\s+ON xg\."id" = cg\."customerCompanyAccountId" AND xg\."tenantId" = \$1::uuid AND xg\."companyId" = \$2::uuid/,
    );
    expect(gate).toMatch(/cg\."tenantId" = \$1::uuid/);
    expect(gate).toMatch(/cg\."companyId" = \$2::uuid/);
    expect(gate).toMatch(/\(\$3::uuid IS NULL OR cg\."branchId" = \$3::uuid\)/);
    expect(gate).toMatch(/\(\$4::uuid IS NULL OR xg\."customerId" = \$4::uuid\)/);
    // never the page, the cursor, a date, an age, or a company-wide shortcut for a branch / customer request
    expect(gate).not.toMatch(
      /\$5|\$6|postingDate|createdAt|invoiceDate|"date"|ageDays|BETWEEN|interval/i,
    );
    expect(gate).not.toMatch(/"invoice"|"payment_allocation"|"credit_note"|"journal_entry"/);
    // `rcv` applies the very same four predicates
    const rcv = stages().get('rcv')!;
    expect(rcv).toContain('cr."tenantId" = $1::uuid');
    expect(rcv).toContain('cr."companyId" = $2::uuid');
    expect(rcv).toContain('($3::uuid IS NULL OR cr."branchId" = $3::uuid)');
    expect(rcv).toContain('($4::uuid IS NULL OR x."customerId" = $4::uuid)');
  });

  it('every stage that reads a base table is a scope probe, the gate itself, or carries the gate — and no stage downstream reads a base table', () => {
    const b = stages();
    const reads = (t: string): string[] =>
      [...t.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(
      [...b.entries()]
        .filter(([, t]) => reads(t).length > 0)
        .map(([n]) => n)
        .sort(),
    ).toEqual([
      'app',
      'co',
      'gate',
      'ic',
      'jall',
      'jh',
      'jx',
      'rcv',
      'scope_branch',
      'scope_customer',
    ]);
    const expected: Record<string, number> = { rcv: 1, app: 4, jh: 1, jall: 1, jx: 2, ic: 2 };
    for (const [name, n] of Object.entries(expected)) {
      expect(gates(b.get(name)!), `${name} carries the gate ${n}×`).toBe(n);
    }
    expect(gates(SQL)).toBe(11);
    // the light stages never carry it: a 404 and the currency must stay answerable
    for (const name of ['co', 'scope_branch', 'scope_customer', 'gate']) {
      expect(b.get(name)!, name).not.toMatch(/FROM gate gt/);
    }
    // EVERY leg is gated, not just one of them
    const legsOf = (name: string): string[] => b.get(name)!.split('UNION ALL');
    expect(legsOf('app')).toHaveLength(4);
    expect(legsOf('jx')).toHaveLength(2);
    for (const leg of [...legsOf('app'), ...legsOf('jx')]) expect(gates(leg)).toBe(1);
    const ic = b.get('ic')!;
    expect(ic).toMatch(
      /crx\."companyId" = \$2::uuid\s+AND \(SELECT gt\."n" FROM gate gt\) <= 100000\) AS "paymentApplicationsOnInvoiceReceivables"/,
    );
    expect(ic).toMatch(
      /AND \$4::uuid IS NULL\s+AND \(SELECT gt\."n" FROM gate gt\) <= 100000\s+AND \(\$3::uuid IS NULL OR cnx\."branchId" = \$3::uuid\)/,
    );
  });

  it('the rejection is REPORT_RESULT_TOO_LARGE (422) with the limit and `narrow_scope` only — never the actual count, a sibling, a customer, an id or a figure', () => {
    const repo = dProd(REPO);
    expect((repo.match(/'REPORT_RESULT_TOO_LARGE'/g) ?? []).length).toBe(1);
    const at = repo.indexOf("'REPORT_RESULT_TOO_LARGE'");
    const guard = repo.slice(
      repo.lastIndexOf('if (json.candidateReceivables', at),
      repo.indexOf('const authority', at),
    );
    expect(guard).toMatch(/^if \(json\.candidateReceivables > this\.maxReceivables\) \{/);
    expect(guard).toMatch(/422,/);
    expect(guard).toMatch(/\{ field: 'maxReceivables', issue: String\(this\.maxReceivables\) \}/);
    expect(guard).toMatch(/\{ field: 'action', issue: 'narrow_scope' \}/);
    // the count is read ONCE — for the comparison — and is in neither the message nor the details
    expect((repo.match(/candidateReceivables/g) ?? []).length).toBe(1);
    const call = guard.slice(guard.indexOf('throw new DomainError('));
    expect(call).not.toMatch(/candidate|json|branchId|customerId|companyId|Minor|count/i);
    expect(call).not.toMatch(/narrow_date_range|date range/);
  });

  it('order of checks: company 404 → branch 404 → customer 404 → DENSITY → authority → integrity (the rejection precedes every financial analysis)', () => {
    const repo = dProd(REPO);
    const order = [
      "throw new NotFoundError('company')",
      "throw new NotFoundError('branch')",
      "throw new NotFoundError('customer')",
      'json.candidateReceivables > this.maxReceivables',
      'resolveCompanyReportAuthority(json.company)',
      'assertSourceIntegrity(json)',
    ].map((s) => repo.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('NO calendar / date cap and no aging came with the guard — only the receivable count', () => {
    for (const n of D_PRODUCTION) {
      expect(dProd(n), n).not.toMatch(
        /REPORT_RANGE_TOO_LARGE|MAX_DAYS|maxDays|narrow_date_range|inclusiveCivilDays|SALES_REPORT_MAX|TENDER_REPORT_MAX/,
      );
    }
    expect(SQL).not.toMatch(/interval|date_trunc|CURRENT_DATE|BETWEEN/i);
  });

  it('the integration and volume suites pin the guard’s own contracts: the three scopes, the boundary, the non-disclosure, the heavy-stage skip and the 100 001 proof', () => {
    const it_ = read(join(DIR, 'receivables-report.integration.test.ts'));
    for (const t of [
      'company scope: exactly the limit is accepted',
      'branch scope is SCOPE-LOCAL: sibling branches never contribute',
      'customer-filtered scope is SCOPE-LOCAL',
      'the page size never decides the guard',
      'the rejection is generic and non-disclosing',
      'a rejected report is ONE statement in ONE read-only transaction and writes nothing',
      'the over-limit answer PRECEDES the integrity analysis',
    ]) {
      expect(it_, t).toContain(t);
    }
    expect(it_).toMatch(/protected override readonly maxReceivables: number = n;/);
    const qp = read(join(DIR, 'receivables-report.query-plan.integration.test.ts'));
    expect(qp).toMatch(/RD-1 density gate \(EXPLAIN\): above the limit NO heavy relation executes/);
    expect(qp).toMatch(
      /RD-1 at 100 000: ONE accepted final report at exactly the limit, then 100 001/,
    );
    expect(qp).toMatch(/heavyExecuted\(shut\)/);
    expect(qp).toMatch(/expect\(acceptedMs\)\.toBeLessThan\(LOCAL_GATE_MS\)/);
    expect(qp).toMatch(/expect\(nTarget\)\.toBe\(100_000\)/);
    expect(qp).toMatch(/\{ field: 'maxReceivables', issue: '100000' \}/);
  });
});

// ═════════════════════════════════════════════════════════════════
describe('D — documentation: the plan and the decision log record Checkpoint D', () => {
  const plan = (): string => read(join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md'));
  const log = (): string => read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
  const section = (): string => {
    const p = plan();
    const at = p.indexOf('## 13. Checkpoint D — Receivables current state');
    expect(at, 'the plan has a §13 Checkpoint D').toBeGreaterThan(0);
    return p.slice(at);
  };

  it('the checkpoint table marks D built and verified with RD-1 ruled and implemented, and the public wiring (F) and final gates (G) stay proposed', () => {
    const rowD = plan()
      .split('\n')
      .filter((l) => /^\| D\s+\|/.test(l));
    expect(rowD).toHaveLength(1);
    expect(rowD[0]).toMatch(
      /Receivables current state \(Advances are NOT part of this checkpoint\)/,
    );
    expect(rowD[0]).toMatch(
      /RD-1 RULED and IMPLEMENTED \(at most 100 000 receivables per evaluated scope\)/,
    );
    expect(rowD[0]).not.toMatch(/proposed, not started/);
    // Checkpoint E (Customer Advances + Unapplied Receipts) was inserted after D and shifted the two proposed rows:
    // the public HTTP wiring is now F and the final hard gates G — both still proposed
    // (Checkpoint F — the public wiring — has since been implemented: only the final gates G stay proposed)
    for (const letter of ['G']) {
      const row = plan()
        .split('\n')
        .filter((l) => new RegExp(`^\\| ${letter}\\s+\\|`).test(l));
      expect(row, letter).toHaveLength(1);
      expect(row[0], letter).toMatch(/local verification run [(]2026-10-10[)].*NOT frozen/);
    }
    const rowF = plan()
      .split('\n')
      .filter((l) => /^\| F\s+\|/.test(l));
    expect(rowF[0]).toMatch(/Public HTTP wiring/);
  });

  it('§13 records the frozen semantics: current snapshot (no date input), no aging, the frozen helper, the AR reduction only, no Advances', () => {
    const s = section();
    expect(s).toMatch(/\*\*no date input of any kind\*\*|\*\*no date input of any kind\*\* —/);
    expect(s).toMatch(/\*\*Current snapshot only\.\*\*/);
    expect(s).toMatch(/`asOf` is \*\*derived by the database in the same statement\*\*/);
    expect(s).toMatch(/\*\*No aging\.\*\*/);
    expect(s).toMatch(/exactly the frozen `computeReceivableBalance`\*\*/);
    expect(s).toMatch(/`arReductionMinor`/);
    expect(s).toMatch(/never subtracted again and is never receivable/);
    expect(s).toMatch(/\*\*Zero and fully-satisfied receivables stay\.\*\*/);
    expect(s).toMatch(/\*\*No customer PII\.\*\*/);
    expect(s).toMatch(/\*\*No Advances implementation exists\*\*/);
    expect(s).toMatch(/default 50, maximum 200/);
    expect(s).toMatch(/never the page/);
  });

  it('§13 records the GL control: the eight authoritative kinds (never the whole account), one FULL OUTER JOIN, the error codes', () => {
    const s = section();
    expect(s).toMatch(/never reads the whole `ASSET\.ACCOUNTS_RECEIVABLE` account/);
    expect(s).toMatch(/exactly these eight source kinds/);
    for (const kind of Object.values(AR_JOURNAL_KINDS)) {
      expect(s, kind).toContain(`\`${kind}\``);
    }
    expect(s).toMatch(/single `FULL OUTER JOIN` on `\(sourceKind, sourceId\)`/);
    expect(s).toMatch(
      /\*\*A filtered report scopes the totals, the rows and the GL control in the same snapshot\*\*/,
    );
    // the GL-mismatch code is named in two places (the semantics and the stated boundary): each is pinned on its own
    expect(s).toMatch(/a source-versus-GL difference is `REPORT_RECEIVABLES_GL_MISMATCH` \(500\)/);
    expect(s).toMatch(/3\. \*\*`REPORT_RECEIVABLES_GL_MISMATCH` \(500\) is defence in depth\.\*\*/);
    for (const code of [
      'REPORT_CURRENCY_MISMATCH',
      'REPORT_RECEIVABLES_SOURCE_INTEGRITY',
      'REPORT_COMPANY_NOT_CONFIGURED',
      'INVALID_LIMIT',
      'INVALID_CURSOR',
    ]) {
      expect(s, code).toContain(code);
    }
  });

  it('§13 records the measured volume table (2 000 / 10 000 / 50 000 / 100 000), the disclaimer and the delivery-time performance decision (RD-1 open then, ruled since)', () => {
    const s = section();
    expect(s).toMatch(
      /Every figure equals an independent oracle at every size\. \*\*Local test-container benchmark; not production capacity\.\*\*/,
    );
    expect(s).toMatch(
      /\|\s*\*\*100 000\*\*\s*\|\s*25 000\s*\|\s*382 229 \/ 448 687\s*\|\s*\*\*8 044 \/ 9 764 ms\*\*/,
    );
    expect(s).toMatch(
      /\|\s*50 000\s*\|\s*12 500\s*\|\s*191 121 \/ 224 346\s*\|\s*4 180 \/ 4 365 ms/,
    );
    expect(s).toMatch(/\|\s*10 000\s*\|\s*2 500\s*\|\s*38 227 \/ 44 875\s*\|\s*621 \/ 652 ms/);
    expect(s).toMatch(/\|\s*2 000\s*\|\s*500\s*\|\s*7 647 \/ 8 979\s*\|\s*142 \/ 198 ms/);
    expect(s).toMatch(
      /\*\*At delivery no cap, no density guard, no index and no migration was added\.\*\*/,
    );
    expect(s).toMatch(/\*\*49 % of the ≈ 20 s scoped-transaction timeout\*\*/);
    expect(s).toMatch(/\*\*Owner decision RD-1 was OPEN at delivery \(RULED and IMPLEMENTED/);
    expect(s).toMatch(
      /≈ 200 000 receivables \(a projection from two measurements, not a measurement\)/,
    );
    expect(s).toMatch(/the STOP rule of the instruction did not fire/);
  });

  it('§13 records the migration decision (none) and leaves the Checkpoint C JIT observation a residual with no database-wide setting changed', () => {
    const s = section();
    expect(s).toMatch(/### Migration \/ index decision\s+\*\*None\.\*\*/);
    expect(s).toMatch(/Migrations remain 49/);
    expect(s).toMatch(
      /The PostgreSQL \/ JIT observation of Checkpoint C stays a residual for the final \/ representative-environment verification and no database-wide JIT setting was touched/,
    );
    expect(s).toMatch(/### Stated boundaries \(residuals, not hidden\)/);
    expect(s).toMatch(/An unattributable orphan journal fails only the unfiltered company report/);
  });

  it('the plan has no unfilled placeholder, records the Checkpoint D verification, and the earlier checkpoints’ own text still stands', () => {
    expect(plan()).not.toMatch(/@@/);
    // C's closing sentence is frozen documentation; D appends a section and never edits it
    expect(plan()).toMatch(/Checkpoint D and Task 3b\.11 not started\./);
    expect(plan()).toMatch(/^## 12\. Checkpoint C — Tender Totals$/m);
    expect(plan()).toMatch(
      /^### Density closure — Tender Totals v1: at most 100 000 logical tender movements per company window$/m,
    );
    // the verification of THIS checkpoint: the suites, the pin sensitivity, the mutation result and the regression
    const v = section().slice(section().indexOf('### Verification (Checkpoint D)'));
    expect(v).toMatch(/^### Verification \(Checkpoint D\)/);
    expect(v).toMatch(/`receivables-report\.test\.ts` — \*\*10\*\* tests/);
    expect(v).toMatch(/`receivables-report\.integration\.test\.ts` — \*\*42\*\* tests/);
    expect(v).toMatch(/`receivables-report\.query-plan\.integration\.test\.ts` — \*\*8\*\* tests/);
    expect(v).toMatch(/`task-3b10-checkpoint-d-structural\.test\.ts` — \*\*67\*\* pins/);
    expect(v).toMatch(/\*\*Pin sensitivity: 223 deliberate violations\*\*/);
    expect(v).toMatch(/\*\*76 caught, 4 equivalent\.\*\*/);
    expect(v).toMatch(/\*\*nine were real test gaps and are closed\*\*/);
    expect(v).toMatch(/\*\*Targeted regression: 12 groups green, 3 672 tests\*\*/);
    expect(v).toMatch(/migrations remain 49 \(no migration 50\)/);
    expect(v).toMatch(/Checkpoint E and Task 3b\.11 not started\./);
  });

  it('the decision log has exactly one 3b.10-RD row recording the semantics, the measurement and RD-1 (now superseded by 3b.10-RG), and every earlier 3b.10 row is untouched', () => {
    const rd = log()
      .split('\n')
      .filter((l) => l.startsWith('| **3b.10-RD**'));
    expect(rd).toHaveLength(1);
    expect(rd[0]).toMatch(/Current snapshot only:\*\*/);
    expect(rd[0]).toMatch(/`asOf` is the \*\*database\*\* instant/);
    expect(rd[0]).toMatch(/\*\*No aging:\*\*/);
    expect(rd[0]).toMatch(/The balance is the frozen `computeReceivableBalance`\*\*/);
    expect(rd[0]).toMatch(/`credit_note\.arReductionMinor` \*\*only\*\*/);
    expect(rd[0]).toMatch(/only the eight authoritative AR-changing journal kinds/);
    expect(rd[0]).toMatch(/ONE `FULL OUTER JOIN`/);
    expect(rd[0]).toMatch(
      /scopes the totals, the rows \*\*and the GL control\*\* in the same snapshot/,
    );
    expect(rd[0]).toMatch(/\*\*8\.0 s p50 \/ 9\.8 s worst\*\*/);
    expect(rd[0]).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(rd[0]).toMatch(/At delivery no cap, density guard, index or migration was added/);
    expect(rd[0]).toMatch(
      /\*\*RD-1 \(was OPEN; RULED and IMPLEMENTED 2026-10-06 — see `3b\.10-RG`\):\*\*/,
    );
    expect(rd[0]).toMatch(/\*\*RD-1 SUPERSEDED by `3b\.10-RG` \(2026-10-06\)\*\*/);
    expect(rd[0]).toMatch(/No migration 50 \(migrations remain 49\)/);
    expect(rd[0]).toMatch(/no Advances implementation/);
    expect(rd[0]).toMatch(/no database-wide JIT setting was changed/);
    for (const id of [
      '3b.10-OD',
      '3b.10-TB',
      '3b.10-SR',
      '3b.10-CC',
      '3b.10-DG',
      '3b.10-TT',
      '3b.10-TD',
    ]) {
      expect(
        log()
          .split('\n')
          .filter((l) => l.startsWith(`| **${id}**`)),
        id,
      ).toHaveLength(1);
    }
  });

  it('the plan and the decision log record the RD-1 density closure: the rule, the evaluated scope, the same-statement gate, the measurements, the preserved history', () => {
    const p = plan();
    expect(
      (
        p.match(
          /^### Density closure — Receivables v1: at most 100 000 receivables per evaluated scope$/gm,
        ) ?? []
      ).length,
    ).toBe(1);
    const c = p.slice(p.indexOf('### Density closure — Receivables v1'));
    expect(c).toMatch(/`RECEIVABLES_REPORT_MAX_RECEIVABLES = 100 000`/);
    expect(c).toMatch(/\*\*no calendar cap, no historical `asOf` and no aging\*\*/);
    expect(c).toMatch(/sibling branches never contribute/);
    expect(c).toMatch(
      /the \*\*customer-filtered\*\* report counts the customer's receivables after the company \/ branch scope/,
    );
    expect(c).toMatch(/`REPORT_RESULT_TOO_LARGE`, HTTP 422/);
    expect(c).toMatch(/details `maxReceivables: 100000` and `action: narrow_scope`/);
    expect(c).toMatch(/\*\*The over-limit rejection therefore precedes the integrity analysis\*\*/);
    expect(c).toMatch(/\*\*The design — the same statement, no COUNT-then-report\.\*\*/);
    expect(c).toMatch(/eleven gate predicates in all/);
    expect(c).toMatch(/\*\*8 457 ms\*\* full service \(a first identical run: 9 104 ms\)/);
    expect(c).toMatch(/\*\*601 \/ 645 \/ 767 ms\*\*/);
    expect(c).toMatch(/\| rejected payload\s+\| 697 bytes/);
    expect(c).toMatch(
      /\*\*`invoice`, `cancellation_charge`, `payment_allocation`, `customer_receivable_payment_application`, `customer_advance_application`, `credit_note`, `journal_entry`, `journal_line` and `account` are all "never executed"\*\*/,
    );
    expect(c).toMatch(/\*\*eight planner alternatives\*\*/);
    expect(c).toMatch(/\*\*Historical evidence preserved\.\*\*/);
    expect(c).toMatch(/and it is a \*\*local operational safety bound, not a production SLA\*\*/);
    expect(c).toMatch(/\*\*Local test-container benchmark; not production capacity\.\*\*/);
    expect(c).toMatch(/\*\*Migration \/ index decision\.\*\* \*\*None\.\*\*/);
    // the closure's own verification: the suites, the pin sensitivity, the mutation result and the regression
    const gv = p.slice(p.indexOf('### Verification (Checkpoint D — density closure)'));
    expect(gv).toMatch(/^### Verification \(Checkpoint D — density closure\)/);
    expect(gv).toMatch(/`receivables-report\.test\.ts` — \*\*10\*\* tests, unchanged/);
    expect(gv).toMatch(
      /`receivables-report\.integration\.test\.ts` — \*\*53\*\* tests \(42 \+ \*\*11\*\* density tests\)/,
    );
    expect(gv).toMatch(
      /`receivables-report\.query-plan\.integration\.test\.ts` — \*\*10\*\* tests \(8 \+ \*\*2\*\*\)/,
    );
    expect(gv).toMatch(/`task-3b10-checkpoint-d-structural\.test\.ts` — \*\*76\*\* pins/);
    expect(gv).toMatch(/\*\*Pin sensitivity: 85 deliberate violations\*\*/);
    expect(gv).toMatch(/\*\*27 caught, 0 survive\*\*/);
    expect(gv).toMatch(/\*\*7 by the structural pins alone\*\*/);
    expect(gv).toMatch(/\*\*Fast targeted regression: 7 groups green, 1 486 tests\*\*/);
    expect(gv).toMatch(/migrations remain 49 \(no migration 50\)/);
    expect(gv).toMatch(/Checkpoint E and Task 3b\.11 not started\./);
    // the delivery evidence the closure preserves is still in §13
    expect(p).toMatch(/\*\*8 044 \/ 9 764 ms\*\*/);
    expect(p).toMatch(
      /≈ 200 000 receivables \(a projection from two measurements, not a measurement\)/,
    );
    const rg = log()
      .split('\n')
      .filter((l) => l.startsWith('| **3b.10-RG**'));
    expect(rg).toHaveLength(1);
    expect(rg[0]).toMatch(
      /`RECEIVABLES_REPORT_MAX_RECEIVABLES = 100 000` CustomerReceivable records in the evaluated scope/,
    );
    expect(rg[0]).toMatch(/\*\*no aging, no calendar cap, no historical `asOf`\*\*/);
    expect(rg[0]).toMatch(/sibling branches never contribute/);
    expect(rg[0]).toMatch(
      /`REPORT_RESULT_TOO_LARGE`, 422 \(reused\), details `maxReceivables: 100000` and `action: narrow_scope`/,
    );
    expect(rg[0]).toMatch(
      /\*\*never the actual count, a sibling branch, another customer, an id or a figure\*\*/,
    );
    expect(rg[0]).toMatch(/the SAME single statement \(no COUNT-then-report\)/);
    expect(rg[0]).toMatch(/eleven One-Time Filters/);
    expect(rg[0]).toMatch(/\*\*8\.46 s\*\* full service \(a first identical run 9\.10 s\)/);
    expect(rg[0]).toMatch(/\*\*100 001 rejected in 601 \/ 645 \/ 767 ms\*\*/);
    expect(rg[0]).toMatch(/Local test-container benchmark; not production capacity/);
    expect(rg[0]).toMatch(/not a production SLA/);
    expect(rg[0]).toMatch(/closes RD-1 of `3b\.10-RD`/);
    expect(rg[0]).toMatch(/No migration 50 \(migrations remain 49\)/);
    expect(rg[0]).toMatch(/Checkpoints E–F and Task 3b\.11 not started/);
  });
});
