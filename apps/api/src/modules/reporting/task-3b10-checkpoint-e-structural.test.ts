import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// White-box structural pin: it reads the frozen chart-of-accounts REFERENCE DATA constant (no Prisma client,
// no query) to prove the two liability account keys exist — not production module code.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
import { parseReportDateRange } from './report-date-range.js';
import { RECEIVABLES_REPORT_MAX_RECEIVABLES } from './receivables-report.sql.js';
import { SALES_REPORT_MAX_DAYS, SALES_REPORT_MAX_DOCUMENTS } from './sales-report-range.js';
import { TENDER_REPORT_MAX_MOVEMENTS } from './tender-totals-report.sql.js';
import {
  ADVANCE_SOURCE_TYPES,
  buildCustomerLiabilityRows,
  buildLiabilityBlocks,
  LIABILITIES_REPORT_DEFAULT_LIMIT,
  LIABILITIES_REPORT_MAX_LIMIT,
} from './customer-liabilities-report.js';
import {
  ADVANCE_JOURNAL_KINDS,
  CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS,
  CUSTOMER_LIABILITIES_REPORT_SQL as SQL,
  LIABILITY_ACCOUNT_KEYS,
  UNAPPLIED_JOURNAL_KINDS,
} from './customer-liabilities-report.sql.js';

/**
 * Task 3b.10 Checkpoint E — structural pins: the CUSTOMER ADVANCES + UNAPPLIED RECEIPTS current-state report.
 *
 * They pin the owner rulings of the Checkpoint E instruction so the report cannot drift into a controller, a permission, a
 * migration, a historical / dated / aged report, a customer-PII read, a netting of the two liabilities, a reservation that
 * moves the book liability or the GL, a CreditNote excess in the Unapplied figure, a Settlement aggregation, a
 * multi-statement read, a float or a later checkpoint's work without a failing test. Every pin is sensitivity-tested (a
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

/** Checkpoint E's production files — a CLOSED set of four */
const E_PRODUCTION = [
  'customer-liabilities-report.ts',
  'customer-liabilities-report.sql.ts',
  'customer-liabilities-report.repository.ts',
  'customer-liabilities-report.service.ts',
];
const E_TESTS = [
  'customer-liabilities-report.integration.test.ts',
  'customer-liabilities-report.query-plan.integration.test.ts',
  'customer-liabilities-report.test.ts',
  'task-3b10-checkpoint-e-structural.test.ts',
];
const PURE = 'customer-liabilities-report.ts';
const REPO = 'customer-liabilities-report.repository.ts';
const SVC = 'customer-liabilities-report.service.ts';
const SQLF = 'customer-liabilities-report.sql.ts';
const eProd = (name: string): string => stripComments(read(join(DIR, name)));
const eBare = (name: string): string => bareCode(read(join(DIR, name)));
const modules = (name: string): string => read(join(SRC, 'modules', name));

const ADV = LIABILITY_ACCOUNT_KEYS.advances;
const UNAPPLIED = LIABILITY_ACCOUNT_KEYS.unapplied;

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

describe('E — Checkpoints A, B, C and D are FROZEN: their production files are byte-unchanged', () => {
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
    // Checkpoint D (Receivables current state, with its RD-1 density guard)
    'receivables-report.ts': '924599ad8bea2a4773cd2803088c7ffa99ccddd93cd18d7755efca36869021cd',
    'receivables-report.sql.ts': 'fd60ac46536edf3c8404c7b4956d6b0e28ffb48943337c6bdf2381f5c8bc5d32',
    'receivables-report.repository.ts':
      '704183552f5c53927bff2d4545344ddf710a627b6a29d53e3c15b5e5c3f933be',
    'receivables-report.service.ts':
      '9c8ffb69c3b4cca1de017ec0c7ae15dae024c693dcbdb78707a62d2b9f1111b8',
  };
  for (const [file, hash] of Object.entries(FROZEN)) {
    it(`${file} is byte-identical to its frozen state`, () => {
      expect(sha(join(DIR, file))).toBe(hash);
    });
  }

  it('the frozen report rules are unchanged: Sales 90 days AND 25 000 documents; Tender no cap and 100 000 movements; Receivables 100 000 per scope; Trial Balance uncapped; the Advances / Unapplied guard is its OWN constant', () => {
    expect(SALES_REPORT_MAX_DAYS).toBe(90n);
    expect(SALES_REPORT_MAX_DOCUMENTS).toBe(25_000);
    expect(TENDER_REPORT_MAX_MOVEMENTS).toBe(100_000);
    expect(RECEIVABLES_REPORT_MAX_RECEIVABLES).toBe(100_000);
    const tb = read(join(DIR, 'trial-balance.sql.ts'));
    const executable = tb.slice(tb.indexOf('export const TRIAL_BALANCE_SQL'));
    expect(executable.slice(0, executable.indexOf('export interface'))).not.toMatch(
      /sourceKind|sourceId|LIMIT|OFFSET|cursor/i,
    );
    expect(parseReportDateRange({ from: '2021-01-01', to: '2026-12-31' })).toEqual({
      from: '2021-01-01',
      to: '2026-12-31',
    });
    // Checkpoint E's guard (EL-1) is its OWN: none of the other reports' limits or vocabulary is applied here
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(
        /REPORT_RANGE_TOO_LARGE|MAX_RECEIVABLES|MAX_MOVEMENTS|MAX_DOCUMENTS|MAX_DAYS|maxReceivables|maxMovements|candidateReceivables/,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — scope: only the customer-liabilities current-state report; no controller, no migration, nothing of Task 3b.11', () => {
  it('the Checkpoint E production surface is EXACTLY the four customer-liabilities files; its tests are the four listed', () => {
    const names = walk(DIR).map((f) => f.slice(DIR.length + 1).replace(/\\/g, '/'));
    expect(
      names.filter((n) => n.startsWith('customer-liabilities-') && !isTest(n) && notF(n)).sort(),
    ).toEqual([...E_PRODUCTION].sort());
    expect(
      names
        .filter(notF)
        .filter(
          (n) =>
            /customer-liabilities/.test(n) || n === 'task-3b10-checkpoint-e-structural.test.ts',
        )
        .sort(),
    ).toEqual([...E_PRODUCTION, ...E_TESTS].sort());
  });

  it('no controller, no Nest module, no public route, no guard, no decorator wiring', () => {
    for (const n of E_PRODUCTION) {
      expect(n).not.toMatch(/\.(controller|module|guard|interceptor|dto)\.ts$/);
      expect(eBare(n), n).not.toMatch(
        /@Controller|@Get|@Post|@Patch|@Put|@Delete|@UseGuards|@RequirePermission|@Public|@NoStepUp|@ScopedParam|@Idempotent|@Module\(/,
      );
    }
    expect(eProd(REPO)).toMatch(/@Injectable\(\)/);
    expect(eProd(SVC)).toMatch(/@Injectable\(\)/);
  });

  it('nothing outside the reporting module references the liabilities report: no module registration, no import', () => {
    const outside = walk(SRC).filter(
      (f) => !f.startsWith(DIR) && f.endsWith('.ts') && !f.includes('/node_modules/'),
    );
    for (const f of outside) {
      expect(read(f), rel(f)).not.toMatch(
        /customer-liabilities-report|CustomerLiabilitiesReport(?:Repository|Service)\b/,
      );
    }
    expect(read(join(SRC, 'app.module.ts'))).not.toMatch(
      /CustomerLiabilities|customer-liabilities-report/,
    );
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
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(/['"`]\w+:[a-z_]+(?::[a-z_]+)?['"`]\s*[,;)\]]/);
    }
  });

  it('no Task 3b.11 / tagging work, no X / Z report, no shift, no inventory / BOM, no POS dimension, no Settlement aggregation', () => {
    for (const n of E_PRODUCTION) {
      expect(read(join(DIR, n)), n).not.toMatch(/3b\.11|phase-3-complete/i);
      expect(eBare(n), n).not.toMatch(
        /posTerminal|pos_terminal|terminalId|zReport|xReport|shift|inventory|bom\b/i,
      );
    }
    expect(SQL).not.toMatch(/posTerminal|pos_terminal|"shift"|"inventory/i);
    // a settlement is neither a receipt consumption nor an Advance movement: no table, no kind, no word
    expect(SQL).not.toMatch(/settlement|SETTLEMENT/i);
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(/settlement|SettlementApplication|SETTLEMENT_BATCH/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the exact frozen sources: advance origins, journal kinds per liability account and their producers (discovered, never assumed)', () => {
  it('the frozen advance source-type set is EXACTLY PAYMENT | OPENING | CREDIT_NOTE: the tuple and the database CHECK agree, and each literal is defined once', () => {
    expect([...ADVANCE_SOURCE_TYPES]).toEqual(['PAYMENT', 'OPENING', 'CREDIT_NOTE']);
    const check = read(
      join(
        ROOT,
        'packages/db/prisma/migrations/20261005120000_phase_3b8_credit_refund_core/migration.sql',
      ),
    );
    expect(check).toMatch(
      /"customer_advance_source_type_chk"\s+CHECK \("sourceType" IN \('PAYMENT', 'OPENING', 'CREDIT_NOTE'\)\)/,
    );
    const pure = eProd(PURE);
    for (const t of ['PAYMENT', 'OPENING', 'CREDIT_NOTE']) {
      expect((pure.match(new RegExp(`'${t}'`, 'g')) ?? []).length, t).toBe(1);
    }
    expect(SQL).toMatch(/a\."st" NOT IN \('PAYMENT', 'OPENING', 'CREDIT_NOTE'\)/);
  });

  it('every journal kind literal is EXACTLY the literal its producer posts, on the liability account and the side the producer posts it', () => {
    const producers: [string, string, string, 'debit' | 'credit'][] = [
      ['customer_advance', 'receivables/payment-advance-conversion.repository.ts', ADV, 'credit'],
      [
        'customer_advance',
        'receivables/payment-advance-conversion.repository.ts',
        UNAPPLIED,
        'debit',
      ],
      ['opening_advance', 'receivables/opening-balance.repository.ts', ADV, 'credit'],
      ['credit_note', 'orders/credit-note.repository.ts', ADV, 'credit'],
      [
        'customer_advance_application',
        'receivables/customer-advance-application.repository.ts',
        ADV,
        'debit',
      ],
      ['refund', 'receivables/refund-execution.repository.ts', ADV, 'debit'],
      ['refund', 'receivables/refund-attempt-reservation.repository.ts', ADV, 'debit'],
      [
        'customer_receipt_payment',
        'receivables/customer-receipt-effects.repository.ts',
        UNAPPLIED,
        'credit',
      ],
      [
        'payment_allocation',
        'receivables/customer-receipt-effects.repository.ts',
        UNAPPLIED,
        'debit',
      ],
      [
        'opening_receivable_payment_application',
        'receivables/customer-receipt-effects.repository.ts',
        UNAPPLIED,
        'debit',
      ],
      [
        'cancellation_charge_payment_application',
        'receivables/customer-receipt-effects.repository.ts',
        UNAPPLIED,
        'debit',
      ],
    ];
    for (const [kind, file, account, side] of producers) {
      const src = modules(file);
      // the literal must be the producer's own `sourceKind:` value — the same string also appears as a resourceType
      expect(src, `${kind} sourceKind in ${file}`).toMatch(
        new RegExp(`sourceKind:[^;{}]*?'${kind}'`),
      );
      const escaped = account.replace(/\./g, '\\.');
      // either the literal `direction` follows the account key, or (credit-note) `direction` and `amountMinor` do
      expect(src, `${file} ${account} ${side}`).toMatch(
        new RegExp(`accountKey: '${escaped}',\\s*direction: '${side}'`),
      );
    }
    // the SQL's kind lists are exactly the producers' kinds, per account
    expect(Object.values(ADVANCE_JOURNAL_KINDS).sort()).toEqual(
      [
        'credit_note',
        'customer_advance',
        'customer_advance_application',
        'opening_advance',
        'refund',
      ].sort(),
    );
    expect(Object.values(UNAPPLIED_JOURNAL_KINDS).sort()).toEqual(
      [
        'cancellation_charge_payment_application',
        'customer_advance',
        'customer_receipt_payment',
        'opening_receivable_payment_application',
        'payment_allocation',
      ].sort(),
    );
    // the liability INCREASES are credits (an advance is funded, a receipt is booked) — never the reverse
    for (const [file, account] of [
      ['receivables/payment-advance-conversion.repository.ts', ADV],
      ['receivables/opening-balance.repository.ts', ADV],
      ['receivables/customer-receipt-effects.repository.ts', UNAPPLIED],
    ] as const) {
      const escaped = account.replace(/\./g, '\\.');
      const src = modules(file);
      const credits = (
        src.match(new RegExp(`accountKey: '${escaped}',\\s*direction: 'credit'`, 'g')) ?? []
      ).length;
      expect(credits, `${file} credits ${account}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the producers of the two liability accounts are a CLOSED set — a new producer of a line on either account fails here until its liability effect is reviewed', () => {
    const files = walk(join(SRC, 'modules'))
      .filter((f) => f.endsWith('.ts') && !isTest(f))
      .filter((f) => /LIABILITY\.(?:CUSTOMER_ADVANCES|UNAPPLIED_RECEIPTS)/.test(read(f)))
      .map((f) => relative(join(SRC, 'modules'), f).replace(/\\/g, '/'))
      .sort();
    expect(files).toEqual(
      [
        'orders/credit-note.repository.ts',
        'payments/tender-account-mapping.ts',
        'receivables/customer-advance-application.repository.ts',
        'receivables/customer-receipt-effects.repository.ts',
        'receivables/opening-balance.repository.ts',
        'receivables/payment-advance-conversion.repository.ts',
        'receivables/refund-attempt-reservation.repository.ts',
        'receivables/refund-execution.repository.ts',
        'reporting/customer-liabilities-report.sql.ts',
        'reporting/customer-liabilities-report.ts',
        'reporting/tender-totals-report.sql.ts',
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

  it('the journals that touch neither liability are not in a control, and no kind is shared except the ONE conversion journal that moves a liability from one account to the other', () => {
    const adv = Object.values(ADVANCE_JOURNAL_KINDS) as string[];
    const un = Object.values(UNAPPLIED_JOURNAL_KINDS) as string[];
    for (const excluded of [
      'walk_in_sale',
      'invoice_ar',
      'SETTLEMENT_BATCH',
      'manual_adjustment',
    ]) {
      expect(adv, excluded).not.toContain(excluded);
      expect(un, excluded).not.toContain(excluded);
      expect(SQL, excluded).not.toContain(`'${excluded}'`);
    }
    expect(adv.filter((k) => un.includes(k))).toEqual(['customer_advance']);
    // a Refund only ever reduces the advances; a receipt only ever feeds the unapplied liability
    expect(un).not.toContain('refund');
    expect(adv).not.toContain('customer_receipt_payment');
    expect(adv).toHaveLength(5);
    expect(un).toHaveLength(5);
  });

  it('the two account keys are the frozen chart-of-accounts keys, each named once per control and never pattern-matched', () => {
    expect(ADV).toBe('LIABILITY.CUSTOMER_ADVANCES');
    expect(UNAPPLIED).toBe('LIABILITY.UNAPPLIED_RECEIPTS');
    for (const key of [ADV, UNAPPLIED]) {
      expect(
        ACCOUNTING_REFERENCE_ACCOUNTS.some((a) => a.key === key),
        key,
      ).toBe(true);
    }
    // the advances key is also the `jall` control tag (CASE … THEN 'A' ELSE 'U'); the unapplied key is that CASE's ELSE
    expect((SQL.match(/LIABILITY\.CUSTOMER_ADVANCES/g) ?? []).length).toBe(4);
    expect((SQL.match(/LIABILITY\.UNAPPLIED_RECEIPTS/g) ?? []).length).toBe(3);
    expect(SQL).not.toMatch(/LIKE|ILIKE|~\s*'/); // never a pattern match on an account
    // no other account is read
    expect(SQL).not.toMatch(
      /ASSET\.|REVENUE\.|EQUITY\.|LIABILITY\.(?!CUSTOMER_ADVANCES|UNAPPLIED_RECEIPTS)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — advance semantics: the frozen computeAdvanceBalance — book vs reservation vs available, each source counted once', () => {
  it('the equation is the frozen helper’s — the pure module CALLS it and never writes the formula; the SQL only sums its components', () => {
    const pure = eProd(PURE);
    expect(pure).toMatch(
      /import \{ computeAdvanceBalance \} from '\.\.\/receivables\/receivable-balance\.js'/,
    );
    expect((pure.match(/computeAdvanceBalance\(/g) ?? []).length).toBe(1);
    expect(pure).not.toMatch(/principal\w*\s*-\s*\w*applied|applied\w*\s*-\s*\w*refunded/i);
    // the helper's own contract (its doc) is the equation the pins rely on
    const helper = modules('receivables/receivable-balance.ts');
    expect(helper).toMatch(/bookedRemaining = principal − applied − refunded/);
    expect(helper).toMatch(/available\s+= principal − consumed/);
    expect(helper).toMatch(
      /consumed\s+= Σ application \+ Σ refund application \+ Σ PENDING reservation/,
    );
    // an over-consumed advance fails closed in the report even though the helper tolerates it
    expect(pure).toMatch(/bookedRemainingMinor < 0n \|\| balance\.availableMinor < 0n/);
  });

  it('the SQL components mirror the frozen formulas of the refund repositories: applications, ACTUAL refund applications, PENDING reservations only', () => {
    for (const f of [
      'receivables/refund-execution.repository.ts',
      'receivables/refund-attempt-reservation.repository.ts',
    ]) {
      const src = modules(f);
      expect(src, f).toContain('FROM "customer_advance_application" WHERE "customerAdvanceId"');
      expect(src, f).toContain(
        'FROM "customer_advance_refund_application" WHERE "customerAdvanceId"',
      );
      expect(src, f).toContain(`ra."state" = 'PENDING'`);
    }
    expect(SQL).toMatch(
      /FROM "customer_advance_application" caa\s+JOIN adv a ON a\."aid" = caa\."customerAdvanceId"/,
    );
    expect(SQL).toMatch(
      /FROM "customer_advance_refund_application" cra\s+JOIN adv a ON a\."aid" = cra\."customerAdvanceId"/,
    );
    expect(SQL).toMatch(/FROM "refund_attempt_entitlement_reservation" rr/);
    expect((SQL.match(/ra\."state" = 'PENDING'/g) ?? []).length).toBe(1);
    expect(SQL).not.toMatch(/ra\."state"\s*(?:<>|!=|IN)|'SUCCEEDED'|'FAILED'/);
  });

  it('a pending reservation reduces AVAILABLE only: the book liability excludes it, the available figure includes it, and no GL fact is built from a reservation', () => {
    const advr = SQL.slice(SQL.indexOf('advr AS ('), SQL.indexOf('acells AS ('));
    expect(advr).toMatch(/a\."amt" - COALESCE\(ap\."s", 0\) - COALESCE\(rp\."s", 0\) AS "book"/);
    expect(advr).toMatch(
      /a\."amt" - COALESCE\(ap\."s", 0\) - COALESCE\(rp\."s", 0\) - COALESCE\(rs\."s", 0\) AS "avail"/,
    );
    // the facts of the Advance control are the creation, the applications and the actual refunds — never `rsv` / `rsv_s`
    const fact = SQL.slice(
      SQL.indexOf('fact AS MATERIALIZED ('),
      SQL.indexOf('jh AS MATERIALIZED ('),
    );
    expect(fact).not.toMatch(/\brsv\b|rsv_s|"reserved"|refund_attempt/);
    // the GL control compares the BOOK liability: the pure module judges `book − GL`, never `available − GL`
    const pure = eProd(PURE);
    expect(pure).toMatch(/const advanceDifference = advTotal\.book - glAdvancesNetMinor;/);
    expect(pure).not.toMatch(/advTotal\.available - gl|available - glAdvances/);
  });

  it('only an ACTUAL, final refund reduces the book: the refund application; the Refund and RefundAttempt tables only gate a reservation; a FAILED / SUCCEEDED attempt reserves nothing', () => {
    expect(SQL).not.toMatch(/(?:FROM|JOIN)\s+"refund"/);
    expect((SQL.match(/"refund_attempt"/g) ?? []).length).toBe(1);
    expect((SQL.match(/"customer_advance_refund_application"/g) ?? []).length).toBe(1);
    // one refund fact per Refund (its applications grouped), on the DEBIT side of the advances account
    expect(SQL).toMatch(
      /SELECT 'A', 'refund', r\."refundId"::text, r\."branch", SUM\(r\."amt"\), 'D'\s+FROM rapp r\s+GROUP BY r\."refundId", r\."branch"/,
    );
  });

  it('an AdvanceApplication is counted ONCE, as an advance reduction (a debit fact of the advances control) — never as a receipt consumption', () => {
    expect((SQL.match(/"customer_advance_application"/g) ?? []).length).toBe(1);
    expect(SQL).toMatch(
      /SELECT 'A', 'customer_advance_application', p\."id"::text, p\."branch", p\."amt", 'D' FROM aapp p/,
    );
    // none of the unapplied stages reads it
    const unapplied = SQL.slice(SQL.indexOf('pay AS MATERIALIZED ('), SQL.indexOf('pg AS ('));
    expect(unapplied).not.toMatch(/customer_advance_application|caa\b|aapp/);
  });

  it('a CreditNote EXCESS is an Advance and ONLY an Advance: reached through its coverage release, summed once per CreditNote, never read from the CreditNote or the receipt', () => {
    expect(SQL).not.toMatch(
      /advanceExcessMinor|arReductionMinor|totalAmountMinor|subtotalAmountMinor|taxTotalAmountMinor/,
    );
    expect(SQL).not.toMatch(/(?:FROM|JOIN)\s+"credit_note"\s/);
    expect(SQL).toMatch(
      /SELECT 'A', 'credit_note', rel\."creditNoteId"::text, a\."branch", SUM\(a\."amt"\), 'C'/,
    );
    const unapplied = SQL.slice(SQL.indexOf('pay AS MATERIALIZED ('), SQL.indexOf('pg AS ('));
    expect(unapplied).not.toMatch(/credit_note|CREDIT_NOTE|coverage_release/);
    // the origin set is closed: a CreditNote advance is a source type, not a separate figure
    expect(eProd(PURE)).not.toMatch(/advanceExcess|creditNoteExcess/i);
  });

  it('Advance creation is not a receipt: an opening / CreditNote / payment-derived Advance adds no Payment, and the Payment → Advance relation is exactly `sourcePaymentId`', () => {
    expect((SQL.match(/"sourcePaymentId"/g) ?? []).length).toBe(2); // the advance's own column + the conversion read
    expect(SQL).toMatch(/ca\."sourcePaymentId" AS "spid"/);
    expect(SQL).toMatch(/JOIN pay p ON p\."pid" = cv\."sourcePaymentId"/);
    expect(SQL).toMatch(/WHERE a\."st" = 'PAYMENT' AND p\."pid" IS NULL/);
    // the same relation the DB capacity trigger and the frozen read model use
    const trigger = read(
      join(
        ROOT,
        'packages/db/prisma/migrations/20260930120000_receivables_opening_receivable_payment_application/migration.sql',
      ),
    );
    expect(trigger).toContain(
      `SELECT SUM("amountMinor") FROM "customer_advance" WHERE "sourcePaymentId" = p_payment_id`,
    );
    expect(modules('receivables/customer-account-read.repository.ts')).toContain(
      `FROM "customer_advance" x WHERE x."sourcePaymentId" = p."id"`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — unapplied-receipt semantics: the frozen 3-term Payment capacity, the receipt counted once', () => {
  it('the equation is the frozen helper’s and the database’s: the pure module CALLS computePaymentConsumption with both draws on receivables in its first term', () => {
    const pure = eProd(PURE);
    expect(pure).toMatch(
      /import \{ computePaymentConsumption \} from '\.\.\/receivables\/payment-consumption\.js'/,
    );
    expect((pure.match(/computePaymentConsumption\(/g) ?? []).length).toBe(1);
    expect(pure).toMatch(/allocatedToInvoicesMinor: cell\.allocated \+ cell\.receivableApplied,/);
    expect(pure).toMatch(/convertedToAdvanceMinor: cell\.converted,/);
    expect(pure).not.toMatch(/original\s*-\s*\w*alloc|amount\s*-\s*\w*allocated/i);
    // the SQL sums the three draws of a Payment and the capacity trigger sums the same three
    expect(SQL).toMatch(
      /p\."amt" - COALESCE\(al\."s", 0\) - COALESCE\(rp\."s", 0\) - COALESCE\(cv\."s", 0\) AS "unapplied"/,
    );
    const trigger = read(
      join(
        ROOT,
        'packages/db/prisma/migrations/20260930120000_receivables_opening_receivable_payment_application/migration.sql',
      ),
    );
    expect(trigger).toMatch(/FROM "payment_allocation" WHERE "paymentId" = p_payment_id/);
    expect(trigger).toMatch(
      /FROM "customer_receivable_payment_application" WHERE "paymentId" = p_payment_id/,
    );
    // an over-consumed Payment fails closed
    expect(SQL).toMatch(/COUNT\(\*\) FILTER \(WHERE r\."unapplied" < 0\) AS "over"/);
  });

  it('the attribution is the frozen one: CUSTOMER_RECEIPT through the attempt’s own account, INVOICE_COLLECTION through the invoice’s order customer; a walk-in is in neither liability', () => {
    const attribution = modules('receivables/payment-customer-attribution.repository.ts');
    expect(attribution).toContain(`pa."receiptPurpose"               AS "receiptPurpose"`);
    expect(attribution).toMatch(/row\.receiptPurpose === 'CUSTOMER_RECEIPT'/);
    const pay = SQL.slice(
      SQL.indexOf('pay AS MATERIALIZED ('),
      SQL.indexOf('palloc AS MATERIALIZED ('),
    );
    expect((pay.match(/pa\."receiptPurpose" = 'CUSTOMER_RECEIPT'/g) ?? []).length).toBe(1);
    expect((pay.match(/pa\."receiptPurpose" = 'INVOICE_COLLECTION'/g) ?? []).length).toBe(1);
    expect(pay).toMatch(
      /pa\."customerCompanyAccountId" AND x\."tenantId"|ON x\."id" = pa\."customerCompanyAccountId"/,
    );
    expect(pay).toMatch(/JOIN "invoice" i/);
    expect(pay).toMatch(/JOIN "order" o/);
    // the order's customer joins the company account (an INNER join: a walk-in order has no customer)
    expect(pay).toMatch(/x\."customerId" = o\."customerId"/);
    expect((pay.match(/UNION ALL/g) ?? []).length).toBe(1);
  });

  it('a Payment RECEIPT is counted ONCE: one `pay` row and one receipt fact per Payment, never again for an application, a conversion or a refund', () => {
    expect((SQL.match(/FROM "payment" p\s/g) ?? []).length).toBe(2); // the two attribution legs — a Payment matches exactly one
    expect((SQL.match(/"payment_attempt"/g) ?? []).length).toBe(4); // two attribution legs + the gate's two
    expect(SQL).toMatch(
      /SELECT 'U', 'customer_receipt_payment', p\."pid"::text, p\."branch", p\."amt", 'C' FROM pay p/,
    );
    expect((SQL.match(/'customer_receipt_payment'/g) ?? []).length).toBe(3); // the fact + the all-kinds list + the unapplied list
    // the receipt amount is read from `payment.amountMinor` and nowhere else
    expect((SQL.match(/p\."amountMinor" AS "amt"/g) ?? []).length).toBe(2);
  });

  it('PaymentAllocation and the receivable application only REDUCE the unapplied figure: one debit fact each, grouped per Payment', () => {
    expect(SQL).toMatch(/FROM "payment_allocation" al\s+JOIN pay p ON p\."pid" = al\."paymentId"/);
    expect(SQL).toMatch(
      /FROM "customer_receivable_payment_application" rp\s+JOIN pay p ON p\."pid" = rp\."paymentId"/,
    );
    expect(SQL).toMatch(
      /SELECT 'U', 'payment_allocation', x\."id"::text, x\."branch", x\."amt", 'D' FROM palloc x/,
    );
    expect(SQL).toMatch(
      /palloc_s AS \(SELECT x\."pid" AS "pid", SUM\(x\."amt"\) AS "s" FROM palloc x GROUP BY x\."pid"\)/,
    );
    expect((SQL.match(/"payment_allocation"/g) ?? []).length).toBe(1);
    expect((SQL.match(/"customer_receivable_payment_application"/g) ?? []).length).toBe(1);
  });

  it('a Payment → Advance conversion moves the liability ONCE: ONE journal, a debit fact of the unapplied control and a credit fact of the advances control, and no second receipt', () => {
    expect(SQL).toMatch(
      /SELECT 'U', 'customer_advance', v\."id"::text, v\."branch", v\."amt", 'D' FROM pconv v/,
    );
    expect(SQL).toMatch(
      /CASE a\."st" WHEN 'PAYMENT' THEN 'customer_advance' WHEN 'OPENING' THEN 'opening_advance' END AS "kind"/,
    );
    // only a PAYMENT-origin advance is a conversion; an OPENING / CREDIT_NOTE one never debits the unapplied account
    const pconv = SQL.slice(SQL.indexOf('pconv AS MATERIALIZED ('), SQL.indexOf('palloc_s AS ('));
    expect(pconv).toMatch(/JOIN pay p ON p\."pid" = cv\."sourcePaymentId"/);
    expect(pconv).not.toMatch(/OPENING|CREDIT_NOTE/);
    const conversion = modules('receivables/payment-advance-conversion.repository.ts');
    expect(conversion).toMatch(
      /accountKey: 'LIABILITY\.UNAPPLIED_RECEIPTS',\s*direction: 'debit'[\s\S]*accountKey: 'LIABILITY\.CUSTOMER_ADVANCES',\s*direction: 'credit'/,
    );
  });

  it('a Refund, a CreditNote and a settlement are never a receipt consumption: no Refund / CreditNote / settlement relation is read by any unapplied stage', () => {
    const unapplied = SQL.slice(SQL.indexOf('pay AS MATERIALIZED ('), SQL.indexOf('pg AS ('));
    expect(unapplied).not.toMatch(
      /"refund|refund_attempt|credit_note|settlement|customer_advance_refund_application|"customer_advance_application"/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the TWO controls: each reconciles on its own account and they are NEVER netted', () => {
  it('each control has its own GL net, its own difference and its own failure name; the two are never summed, averaged or compared with one another', () => {
    const pure = eProd(PURE);
    expect(pure).toMatch(/const advanceDifference = advTotal\.book - glAdvancesNetMinor;/);
    expect(pure).toMatch(/const unappliedDifference = unTotal\.unapplied - glUnappliedNetMinor;/);
    expect(pure).toMatch(/\['customerAdvances'\]/);
    expect(pure).toMatch(/\['unappliedReceipts'\]/);
    expect(pure).toMatch(/advanceDifference !== 0n/);
    expect(pure).toMatch(/unappliedDifference !== 0n/);
    // no expression combines the two differences, the two nets or the two books
    expect(pure).not.toMatch(
      /advanceDifference\s*[+\-*]\s*unappliedDifference|unappliedDifference\s*[+\-*]\s*advanceDifference|glAdvancesNetMinor\s*[+-]\s*glUnappliedNetMinor|glUnappliedNetMinor\s*[+-]\s*glAdvancesNetMinor|advTotal\.book\s*[+-]\s*unTotal\.unapplied|unTotal\.unapplied\s*[+-]\s*advTotal\.book/,
    );
    expect(pure).toMatch(/REPORT_LIABILITIES_GL_MISMATCH/);
    // the repository builds two nets per scope, keyed by control — never one combined figure
    const repo = eProd(REPO);
    expect(repo).toMatch(/gl\.get\(`A\|\$\{branchId\}`\)/);
    expect(repo).toMatch(/gl\.get\(`U\|\$\{branchId\}`\)/);
    expect(repo).toMatch(/glAdvances \+= net/);
    expect(repo).toMatch(/glUnapplied \+= net/);
    expect(repo).not.toMatch(/glAdvances\s*[+-]\s*glUnapplied|glUnapplied\s*[+-]\s*glAdvances/);
  });

  it('every fact and every line carries its control: the join is on (control, sourceKind, sourceId) and the filtered leg reads only the control’s own account', () => {
    expect(SQL).toMatch(
      /FULL JOIN jall y ON y\."acct" = f\."acct" AND y\."kind" = f\."kind" AND y\."sid" = f\."sid"/,
    );
    expect(SQL).toMatch(
      /CASE a\."key" WHEN 'LIABILITY\.CUSTOMER_ADVANCES' THEN 'A' ELSE 'U' END AS "acct"/,
    );
    expect(SQL).toMatch(
      /aa\."key" = CASE f\."acct" WHEN 'A' THEN 'LIABILITY\.CUSTOMER_ADVANCES' ELSE 'LIABILITY\.UNAPPLIED_RECEIPTS' END/,
    );
    // the kind lists are applied PER ACCOUNT: an advances-account line is only read from an advances kind, and vice versa
    expect(SQL).toMatch(
      /\(a\."key" = 'LIABILITY\.CUSTOMER_ADVANCES' AND h\."kind" IN \('customer_advance', 'opening_advance', 'credit_note', 'customer_advance_application', 'refund'\)\)/,
    );
    expect(SQL).toMatch(
      /\(a\."key" = 'LIABILITY\.UNAPPLIED_RECEIPTS' AND h\."kind" IN \('customer_receipt_payment', 'payment_allocation', 'opening_receivable_payment_application', 'cancellation_charge_payment_application', 'customer_advance'\)\)/,
    );
    // a per-control tag on every fact, and only those two tags
    const fact = SQL.slice(
      SQL.indexOf('fact AS MATERIALIZED ('),
      SQL.indexOf('jh AS MATERIALIZED ('),
    );
    // advances: creation (PAYMENT / OPENING) · CreditNote excess · application · refund; unapplied: receipt · allocation ·
    // receivable application · conversion
    expect((fact.match(/SELECT 'A'/g) ?? []).length).toBe(4);
    expect((fact.match(/SELECT 'U'/g) ?? []).length).toBe(4);
    expect(fact).not.toMatch(/SELECT '[^AU]'/);
  });

  it('the controls read only SEALED journals of the authoritative kinds, and the GL is judged against the FACTS of the same scope', () => {
    expect((SQL.match(/"sealedAt" IS NOT NULL/g) ?? []).length).toBe(2);
    expect((SQL.match(/je\."sourceKind" IN \(/g) ?? []).length).toBe(1);
    expect((SQL.match(/je\."sourceKind" = f\."kind"/g) ?? []).length).toBe(1);
    const list = [...SQL.matchAll(/je\."sourceKind" IN \(([^)]*)\)/g)];
    expect(
      list[0]![1]!
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort(),
    ).toEqual(
      [
        ...new Set([
          ...Object.values(ADVANCE_JOURNAL_KINDS),
          ...Object.values(UNAPPLIED_JOURNAL_KINDS),
        ]),
      ].sort(),
    );
    // a whole-account balance is never the control: a line is only ever reached through a kind-constrained journal
    expect(SQL).not.toMatch(/SUM\([a-z]+\."debitMinor" - /);
    // an unattributable journal can only be judged on the UNFILTERED report: those scans are guarded by both filters being NULL
    const jh = SQL.slice(
      SQL.indexOf('jh AS MATERIALIZED ('),
      SQL.indexOf('jall AS MATERIALIZED ('),
    );
    expect(jh).toMatch(/\$3::uuid IS NULL\s+AND \$4::uuid IS NULL/);
    const jx = SQL.slice(SQL.indexOf('jx AS MATERIALIZED ('), SQL.indexOf('fcount AS ('));
    expect(jx).toMatch(/WHERE \$3::uuid IS NULL\s+AND \$4::uuid IS NULL/);
    expect(jx).toMatch(/WHERE \(\$3::uuid IS NOT NULL OR \$4::uuid IS NOT NULL\)/);
    expect((jx.match(/FULL JOIN/g) ?? []).length).toBe(1);
  });

  it('the reconciliation of each control is exactly { source…, gl…, differenceMinor, reconciled } and a difference fails the report closed with the liability sign credit − debit', () => {
    const b = buildLiabilityBlocks([], [], 0n, 0n);
    expect(Object.keys(b.advances.reconciliation).sort()).toEqual([
      'differenceMinor',
      'glCustomerAdvancesLiabilityMinor',
      'reconciled',
      'sourceBookLiabilityMinor',
    ]);
    expect(Object.keys(b.unappliedReceipts.reconciliation).sort()).toEqual([
      'differenceMinor',
      'glUnappliedReceiptsLiabilityMinor',
      'reconciled',
      'sourceUnappliedMinor',
    ]);
    expect(Object.keys(b).sort()).toEqual(['advances', 'note', 'unappliedReceipts']);
    expect(eProd(REPO)).toMatch(
      /parseMinorUnitsText\(g\.creditMinor, 'creditMinor'\) -\s*parseMinorUnitsText\(g\.debitMinor, 'debitMinor'\)/,
    );
    const purePin = eProd(PURE);
    expect(purePin).not.toMatch(/reconciled:\s*false/);
    expect((purePin.match(/reconciled: true,/g) ?? []).length).toBe(2);
    expect(purePin).toMatch(/differenceMinor: minorUnitsToWire\(advanceDifference\),/);
    expect(purePin).toMatch(/differenceMinor: minorUnitsToWire\(unappliedDifference\),/);
  });

  it('the integrity gate: the currency error first (409), then every named check (500), per control — non-disclosing', () => {
    const repo = eProd(REPO);
    expect(repo).toMatch(/'REPORT_CURRENCY_MISMATCH'/);
    expect(repo).toMatch(/'REPORT_LIABILITIES_SOURCE_INTEGRITY'/);
    const currency = repo.indexOf("'REPORT_CURRENCY_MISMATCH'");
    const integrity = repo.indexOf("'REPORT_LIABILITIES_SOURCE_INTEGRITY'");
    expect(currency).toBeGreaterThan(-1);
    expect(currency).toBeLessThan(integrity);
    expect(repo).toMatch(
      /if \(i\.currencyMismatchDocuments > 0\) \{\s*throw new DomainError\(\s*'REPORT_CURRENCY_MISMATCH'/,
    );
    expect(repo).toMatch(/'REPORT_CURRENCY_MISMATCH',\s*"[^"]*",\s*409,/);
    expect(repo).toMatch(
      /if \(broken\.length > 0\) \{\s*throw new DomainError\(\s*'REPORT_LIABILITIES_SOURCE_INTEGRITY'/,
    );
    expect(repo).toMatch(/'REPORT_LIABILITIES_SOURCE_INTEGRITY',\s*`[^`]*`,\s*500,/);
    for (const check of [
      'advanceUnknownSourceTypes',
      'advanceOverConsumed',
      'advanceReservationBeyondAvailable',
      'advanceApplicationBranchMismatches',
      'advanceRefundApplicationBranchMismatches',
      'advanceReservationBranchMismatches',
      'paymentAdvancesWithoutPayment',
      'creditNoteAdvancesWithoutRelease',
      'paymentOverConsumed',
      'allocationBranchMismatches',
      'receivablePaymentApplicationBranchMismatches',
      'paymentAdvanceBranchMismatches',
      'advanceMissingJournals',
      'advanceJournalShapeMismatches',
      'advanceJournalBranchMismatches',
      'advanceOrphanJournals',
      'unappliedMissingJournals',
      'unappliedJournalShapeMismatches',
      'unappliedJournalBranchMismatches',
      'unappliedOrphanJournals',
    ]) {
      expect(repo, check).toMatch(new RegExp(`\\[\\s*'${check}',\\s*i\\.${check},?\\s*\\]`));
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
    expect((repo.match(/'REPORT_LIABILITIES_SOURCE_INTEGRITY'/g) ?? []).length).toBe(2);
    expect((repo.match(/'REPORT_CURRENCY_MISMATCH'/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the statement reads EXACTLY these tables, with explicit tenant / company predicates on every one', () => {
  it('the table set is closed — never a Refund, a CreditNote, a settlement, the customer (PII) or an order line', () => {
    const refs = [...SQL.matchAll(/(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((m) => m[1]!);
    expect([...new Set(refs)].sort()).toEqual(
      [
        'account',
        'branch',
        'company',
        'credit_note_coverage_release',
        'customer_advance',
        'customer_advance_application',
        'customer_advance_refund_application',
        'customer_company_account',
        'customer_receivable',
        'customer_receivable_payment_application',
        'invoice',
        'journal_entry',
        'journal_line',
        'order',
        'payment',
        'payment_allocation',
        'payment_attempt',
        'refund_attempt',
        'refund_attempt_entitlement_reservation',
      ].sort(),
    );
    for (const forbidden of [
      'customer',
      'refund',
      'credit_note',
      'credit_note_line',
      'order_line',
      'customer_account_entry',
      'settlement_application',
      'settlement_batch',
      'settlement_line',
      'cancellation_charge',
      'payment_group',
    ]) {
      expect(SQL, forbidden).not.toMatch(new RegExp(`(?:FROM|JOIN)\\s+"${forbidden}"`));
    }
  });

  it('carries EXPLICIT tenant + company predicates on EVERY table it touches — never RLS or the branch GUC', () => {
    // EVERY table reference carries its OWN predicate: per alias, the number of `alias."tenantId" = $1` (and
    // `alias."companyId" = $2`) predicates equals the number of references — one removed anywhere is caught
    // (the optional `\(` covers the parenthesised `LEFT JOIN ("journal_line" ll JOIN "account" aa …)` of the filtered GL leg)
    const refs = [...SQL.matchAll(/(?:FROM|JOIN)\s+\(?"([a-z_]+)"\s+([a-z0-9]+)/g)];
    expect(refs.length).toBe(39); // 29 + the density gate's ten
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
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(/app\.branch_id|app\.tenant_id|current_setting|set_config/i);
    }
  });

  it('the branch scope is the source document’s OWN branch ($3), explicit — and NULL for the company report; the customer scope reaches totals, rows AND both GL controls', () => {
    // advances: their own branch; payments: their own branch; each through the same two predicates
    expect((SQL.match(/\$3::uuid IS NULL OR ca\."branchId" = \$3::uuid/g) ?? []).length).toBe(1);
    expect((SQL.match(/\$3::uuid IS NULL OR p\."branchId" = \$3::uuid/g) ?? []).length).toBe(2);
    expect(SQL).toMatch(/b\."id" = \$3::uuid/);
    expect((SQL.match(/\$4::uuid IS NULL OR x\."customerId" = \$4::uuid/g) ?? []).length).toBe(3);
    expect(SQL).toMatch(/sc\."customerId" = \$4::uuid/);
    // the filters scope `adv` and `pay`, from which every figure, the page AND the facts of both controls descend
    const afterPay = SQL.slice(SQL.indexOf('palloc AS MATERIALIZED ('));
    expect(afterPay).not.toMatch(/ca\."branchId" = \$3|p\."branchId" = \$3/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — a CURRENT snapshot only: no period, no historical asOf input, no aging, no customer PII', () => {
  it('there is NO date input: no from / to / asOf / date parameter, no shared date contract, no date column anywhere in the statement', () => {
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(
        /report-date-range|parseReportDateRange|isFiscalDate|inclusiveCivilDays|sales-report-range|ReportDateRange/,
      );
      expect(eBare(n), n).not.toMatch(/\binput\.(?:from|to|asOf|date|period|at)\b/);
      expect(eBare(n), n).not.toMatch(/\b(?:from|to|date|period)\s*\??:\s*(?:string|Date)\b/);
    }
    const inputs = [
      ...eProd(REPO).matchAll(
        /(?:getBranchReportScoped|getCompanyReportScoped|private async read)\(input: \{([^}]*)\}/g,
      ),
      ...eProd(SVC).matchAll(/(?:branchReport|companyReport)\(input: \{([^}]*)\}/g),
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
    for (const n of E_PRODUCTION) {
      expect(eBare(n), n).not.toMatch(/new Date\(|Date\.now|Clock\b|SystemClock|performance\.now/);
    }
    const repo = eProd(REPO);
    expect(repo).toMatch(/asOf: assertAsOf\(json\.asOf\)/);
    expect((repo.match(/asOf/g) ?? []).length).toBe(3); // the header type, its assertion, the JSON member
  });

  it('NO aging: no ageDays, no aging / due-date / overdue / bucket anything in the liabilities code', () => {
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(
        /ageDays|\bage\b|aging|ageing|due[_ -]?date|dueDate|overdue|bucket|daysBetween|dayDiff|past[_ -]?due/i,
      );
    }
    expect(SQL).not.toMatch(/age\(|interval|date_part|extract\s*\(/i);
  });

  it('NO customer PII is read or returned: the customer table, name, phone, e-mail and address never appear; the customer is reached through customer_company_account.customerId only', () => {
    expect(SQL).not.toMatch(
      /"customer"\s|displayName|phoneE164|emailNormalized|address|"note"|openingNote|customerDisplayNameSnapshot/i,
    );
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(
        /displayName|phone|e-?mail|address|customerName|openingNote|DisplayNameSnapshot/i,
      );
    }
    expect((SQL.match(/x\."customerId" AS "cust"/g) ?? []).length).toBe(2);
    // a row of the page is financial identifiers only — and carries no GL figure
    const row = buildCustomerLiabilityRows(
      [
        {
          customerId: 'c',
          sourceType: 'PAYMENT',
          count: 1,
          principal: 1n,
          applied: 0n,
          refunded: 0n,
          reserved: 0n,
        },
      ],
      [],
    )[0]!;
    expect(Object.keys(row).sort()).toEqual(['advances', 'customerId', 'unappliedReceipts']);
    expect(Object.keys(row.advances).sort()).toEqual([
      'actuallyRefundedMinor',
      'advanceCount',
      'appliedMinor',
      'availableMinor',
      'bookLiabilityMinor',
      'originalAdvanceMinor',
      'pendingRefundReservationMinor',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — ONE statement, ONE read-only snapshot; no N+1; pagination by the shared convention; exact money', () => {
  it('the repository runs exactly one raw statement through the database-enforced read-only scoped transaction', () => {
    const repo = eProd(REPO);
    expect((repo.match(/\$queryRawUnsafe/g) ?? []).length).toBe(1);
    expect((repo.match(/readScoped\(/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(
      /\$executeRaw|\$queryRaw(?!Unsafe)|\.scoped\(|runScoped|\$transaction/,
    );
    expect(repo).toMatch(/extends ReportingRepository/);
  });

  it('no loop or fan-out issues SQL (no N+1, no per-customer query, no summary / page / GL triple), and no COUNT query anywhere', () => {
    for (const n of [REPO, SVC]) {
      const code = eBare(n);
      expect(code, n).not.toMatch(
        /Promise\.all|for await|\.map\(async|\.forEach\(async|setTimeout|setInterval/,
      );
      expect(code, n).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*await/);
      expect(code, n).not.toMatch(/while\s*\([^)]*\)\s*\{[^}]*await/);
    }
    expect((eProd(SVC).match(/this\.repo\./g) ?? []).length).toBe(2); // one call per route
    for (const n of [PURE, REPO, SVC]) expect(eProd(n), n).not.toMatch(/COUNT\(|\.count\(/);
    expect((eProd(REPO).match(/this\.read\(/g) ?? []).length).toBe(2);
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

  it('the default 50, the max 200 and the INVALID_LIMIT / INVALID_CURSOR codes are EXACTLY the shared read-model convention (module-private there — pinned equal, never drifting)', () => {
    const shared = modules('receivables/customer-account-read.repository.ts');
    expect(shared).toMatch(
      new RegExp(`const DEFAULT_LIST_LIMIT = ${LIABILITIES_REPORT_DEFAULT_LIMIT};`),
    );
    expect(shared).toMatch(new RegExp(`const MAX_LIST_LIMIT = ${LIABILITIES_REPORT_MAX_LIMIT};`));
    expect(LIABILITIES_REPORT_DEFAULT_LIMIT).toBe(50);
    expect(LIABILITIES_REPORT_MAX_LIMIT).toBe(200);
    expect(shared).toContain('INVALID_LIMIT');
    expect(shared).toContain('INVALID_CURSOR');
    const pure = eProd(PURE);
    expect(pure).toMatch(/'INVALID_LIMIT', 'limit must be a positive integer', 400/);
    expect(pure).toMatch(/'INVALID_CURSOR', 'cursor is not a valid cursor', 400/);
    expect(pure).toMatch(
      /limit > LIABILITIES_REPORT_MAX_LIMIT \? LIABILITIES_REPORT_MAX_LIMIT : limit/,
    );
  });

  it('the page is a deterministic keyset on customerId (limit + 1 lookahead, row_number cut), ordered ascending; the summaries and both controls are the WHOLE scope, never the page', () => {
    const pg = SQL.slice(SQL.indexOf('pg AS ('), SQL.indexOf('acust AS ('));
    expect(pg).toMatch(/\(\$5::uuid IS NULL OR u\."cust" > \$5::uuid\)/);
    expect(pg).toMatch(/ORDER BY u\."cust"/);
    expect(pg).toMatch(/LIMIT \(\$6::int \+ 1\)/);
    expect(pg).toMatch(/row_number\(\) OVER \(ORDER BY p\."cust"\)/);
    expect(SQL).toMatch(/p\."rn" <= \$6::int/);
    expect(SQL).toMatch(/'hasMore', EXISTS \(SELECT 1 FROM pgn p WHERE p\."rn" > \$6::int\)/);
    // the cells (summary, byBranch) are aggregated from the WHOLE of advr / payr, not from the page
    const acells = SQL.slice(SQL.indexOf('acells AS ('), SQL.indexOf('pay AS MATERIALIZED ('));
    expect(acells).not.toMatch(/pgn|\$5|\$6/);
    const pcells = SQL.slice(SQL.indexOf('pcells AS ('), SQL.indexOf('pg AS ('));
    expect(pcells).not.toMatch(/pgn|\$5|\$6/);
    expect(eProd(REPO)).toMatch(
      /nextCursor: json\.hasMore && rows\.length > 0 \? rows\[rows\.length - 1\]!\.customerId : null/,
    );
    // a page holding more customers than its limit is a defect, never a silently longer page
    expect(eProd(REPO)).toMatch(
      /if \(rows\.length > limit\) \{\s*throw new DomainError\(\s*'REPORT_LIABILITIES_SOURCE_INTEGRITY'/,
    );
  });

  it('no floating point, no Number() conversion, no Math, no rounding, no FX in the liabilities code', () => {
    for (const n of E_PRODUCTION) {
      const code = eBare(n);
      expect(code, n).not.toMatch(
        /\bMath\.|\bNumber\(|parseFloat|parseInt|toFixed|toPrecision|Decimal\b/,
      );
      // (case-sensitive on purpose: `convertedToAdvanceMinor` is the frozen Payment → Advance figure, not a currency conversion)
      expect(code, n).not.toMatch(
        /\bfx\b|\bFx[A-Z]|exchange|Exchange|\bconvert[A-Z]|\brate[A-Z]|currencyRate/,
      );
    }
    expect(SQL).not.toMatch(/::numeric|::float|::double|ROUND\(|CEIL\(|FLOOR\(|real\b|numeric\(/i);
  });

  it('every money aggregate leaves the database as TEXT and is parsed strictly; counts are JSON integers', () => {
    // `orig` is read by all four cell sets (advance + unapplied, per branch + per customer); the others by their own two
    expect((SQL.match(/x\."orig"::text/g) ?? []).length).toBe(4);
    for (const k of ['applied', 'refunded', 'reserved']) {
      expect((SQL.match(new RegExp(`x\\."${k}"::text`, 'g')) ?? []).length, k).toBe(2);
    }
    for (const k of ['alloc', 'rapp', 'conv']) {
      expect((SQL.match(new RegExp(`x\\."${k}"::text`, 'g')) ?? []).length, k).toBe(2);
    }
    expect(SQL).toMatch(/'debitMinor', g\."d"::text, 'creditMinor', g\."c"::text/);
    const repo = eProd(REPO);
    for (const label of [
      'originalMinor',
      'appliedMinor',
      'refundedMinor',
      'reservedMinor',
      'allocatedMinor',
      'receivableAppliedMinor',
      'convertedMinor',
      'debitMinor',
      'creditMinor',
    ]) {
      expect(repo).toContain(`'${label}'`);
    }
    expect(repo).toContain('parseMinorUnitsText(');
    expect(repo).not.toMatch(/BigInt\(\w+\.\w+Minor\)/);
  });

  it('no audit, no outbox, no realtime, no idempotency, no clock, no random: a report is a pure function of the committed ledger', () => {
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(
        /AuditWriter|OutboxWriter|audit\.record|outbox|realtime|Idempotency|idempotency-key|randomUUID|Math\.random/i,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the report shape and labels', () => {
  it('the blocks are note / advances / unappliedReceipts — and no sales, receipts-as-revenue, revenue, profit or settled field; the two liabilities are never merged into one figure', () => {
    const b = buildLiabilityBlocks([], [], 0n, 0n);
    const text = JSON.stringify(b);
    expect(text).not.toMatch(
      /"(?:sales|revenue|profit|margin|settled|total|net|combined|liabilit(?:y|ies)Minor)\w*"/i,
    );
    expect(Object.keys(b.advances).sort()).toEqual(
      [
        'actuallyRefundedMinor',
        'advanceCount',
        'appliedMinor',
        'availableMinor',
        'bookLiabilityMinor',
        'bySourceType',
        'originalAdvanceMinor',
        'pendingRefundReservationMinor',
        'reconciliation',
      ].sort(),
    );
    expect(Object.keys(b.unappliedReceipts).sort()).toEqual(
      [
        'allocatedToReceivablesMinor',
        'convertedToAdvanceMinor',
        'originalReceiptMinor',
        'paymentAllocationMinor',
        'paymentCount',
        'paymentCountWithUnapplied',
        'receivablePaymentApplicationMinor',
        'reconciliation',
        'unappliedReceiptMinor',
      ].sort(),
    );
    expect(b.note).toMatch(/never netted/);
    expect(b.note).toMatch(/not a historical figure/);
  });

  it('the header is companyId / currency / exponent / timezone / asOf / customerId — and the branch route adds only branchId, the company route only byBranch', () => {
    const repo = eProd(REPO);
    // (comments are stripped from `repo`, so the slices are cut at the next declaration)
    const header = repo.slice(
      repo.indexOf('interface ReportHeader'),
      repo.indexOf('export interface LiabilitiesCustomerPage'),
    );
    for (const f of [
      'companyId',
      'currencyCode',
      'currencyExponent',
      'accountingTimezone',
      'asOf',
      'customerId',
    ]) {
      expect(header, f).toContain(`readonly ${f}:`);
    }
    expect((header.match(/readonly \w+:/g) ?? []).length).toBe(6);
    const branch = repo.slice(
      repo.indexOf('export interface LiabilitiesBranchReport'),
      repo.indexOf('export interface LiabilitiesCompanyReport'),
    );
    expect(branch).toMatch(
      /readonly branchId: string;\s*readonly customers: LiabilitiesCustomerPage;/,
    );
    expect((branch.match(/readonly \w+:/g) ?? []).length).toBe(2);
    const company = repo.slice(
      repo.indexOf('export interface LiabilitiesCompanyReport'),
      repo.indexOf('@Injectable()'),
    );
    expect(company).toMatch(
      /readonly byBranch: readonly LiabilitiesBranchRow\[\];\s*readonly customers: LiabilitiesCustomerPage;/,
    );
    expect((company.match(/readonly \w+:/g) ?? []).length).toBe(2);
  });

  it('the company control is the whole authoritative liability: every branch’s journals plus, only on the unfiltered report, an unattributable journal — and byBranch rows are built from their own branch', () => {
    const repo = eProd(REPO);
    expect(repo).toMatch(/let glAdvances = orphanNet\(json\.glOrphan\.advances\);/);
    expect(repo).toMatch(/let glUnapplied = orphanNet\(json\.glOrphan\.unapplied\);/);
    expect(repo).toMatch(/\.\.\.branchBlocks\(cells, gl, branchId\)/);
    expect(SQL).toMatch(/'glOrphan', json_build_object\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the integration suite, the volume gate and the unit suite pin their own contracts', () => {
  const it_ = (): string => read(join(DIR, 'customer-liabilities-report.integration.test.ts'));
  const qp = (): string =>
    read(join(DIR, 'customer-liabilities-report.query-plan.integration.test.ts'));

  it('the integration suite builds every advance and receipt through the frozen flows and compares with a model oracle folded by the FROZEN helpers', () => {
    const src = it_();
    for (const route of [
      '/complete-sale',
      '/receipts',
      '/opening-balance',
      '/advances/from-payment',
      '/applications',
      '/cancel',
      '/refunds',
    ]) {
      // a whole path segment — never the prefix of a different route
      expect(src, route).toMatch(new RegExp(`${route}['"\`/?]`));
    }
    expect(src).toMatch(/= computeAdvanceBalance\(\{/);
    expect(src).toMatch(/= computePaymentConsumption\(\{/);
    expect(src).toMatch(/async function loadModel/);
    expect(src).toMatch(/async function glNet\b/);
    expect(src).toMatch(/async function glNetScoped/);
    expect(src).toMatch(/reserveProviderRefundAttemptInTx/);
    expect(src).toMatch(/applyProviderRefundAttemptResultInTx/);
    // the raw fixtures are the malformed ones and the one provider-backed Payment only
    expect((src.match(/INSERT INTO customer_advance\b/g) ?? []).length).toBe(0);
    expect((src.match(/INSERT INTO customer_receivable\b/g) ?? []).length).toBe(0);
  });

  it('the integration suite proves each owner rule by name: separate controls, the conversion once, the application, the actual refund, pending vs failed, the CreditNote excess, concurrency ×3, cross-netting', () => {
    const src = it_();
    for (const title of [
      'the representative matrix, AED',
      'KWD (3 decimals)',
      'the pending reservation reduces AVAILABLE only',
      'an ACTUAL refund reduces the book liability and available once',
      'the CreditNote EXCESS is an Advance and ONLY an Advance',
      'an Advance application reduces the book liability AND available together',
      'a Payment → Advance conversion moves the liability ONCE',
      'a final Refund from an Advance reduces book and available once',
      'Unapplied semantics, every class',
      'a manual / unrelated journal that hits either liability account is NOT part of a control',
      'concurrent CustomerAdvanceApplications',
      'concurrent Payment → Advance conversions',
      'concurrent final Refunds',
      'advance / unapplied CROSS-NETTING is impossible',
      'a pending reservation beyond the available balance fails closed',
      'a same-tenant foreign-company or foreign-tenant row of every source table never contributes',
    ]) {
      expect(src, title).toContain(title);
    }
  });

  it('the volume gate EXPLAINs (ANALYZE, BUFFERS) the REAL statement over generated ledgers and records the benchmark disclaimer', () => {
    const src = qp();
    expect(src).toMatch(/EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
    expect(src).toMatch(/buildCustomerLiabilitiesReportQuery/);
    expect(src).toMatch(/LIABILITIES_VOLUME_PAYMENTS/);
    expect(src).toMatch(
      /const DISCLAIMER = 'Local test-container benchmark; not production capacity\.';/,
    );
    expect(src).toMatch(/disclaimer: DISCLAIMER/);
    expect(src).toMatch(/= computeAdvanceBalance\(\{/);
    expect(src).toMatch(/= computePaymentConsumption\(\{/);
    expect(src).toMatch(/expect\(worst\)\.toBeLessThan\(LOCAL_GATE_MS\)/);
  });

  it('the unit suite proves the arithmetic differentially against the frozen helpers and the independence of the two controls', () => {
    const src = read(join(DIR, 'customer-liabilities-report.test.ts'));
    expect(src).toMatch(/DIFFERENTIALLY equal to the frozen computeAdvanceBalance/);
    expect(src).toMatch(/differential vs computePaymentConsumption/);
    expect(src).toMatch(/the two controls are INDEPENDENT/);
    expect(src).toMatch(/offsetting differences/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — documentation: the plan (§14) and the decision log record the frozen rulings, the measured decision and the evidence', () => {
  const plan = (): string => read(join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md'));
  const log = (): string => read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
  const section = (): string => {
    const p = plan();
    const at = p.indexOf(
      '## 14. Checkpoint E — Customer Advances + Unapplied Receipts current state',
    );
    expect(at, 'the plan has a §14 Checkpoint E').toBeGreaterThan(0);
    return p.slice(at);
  };
  const subsection = (title: string): string => {
    const s = section();
    const at = s.indexOf(`### ${title}`);
    expect(at, `§14 has "### ${title}"`).toBeGreaterThan(0);
    const next = s.indexOf('\n### ', at + 4);
    return s.slice(at, next === -1 ? undefined : next);
  };
  const row = (id: string): string[] =>
    log()
      .split('\n')
      .filter((l) => l.startsWith(`| **${id}**`));

  it('the checkpoint table marks E built and verified with EL-1 open, D untouched, and the public wiring (F) and final gates (G) proposed', () => {
    const rows = (letter: string): string[] =>
      plan()
        .split('\n')
        .filter((l) => new RegExp(`^\\| ${letter}\\s+\\|`).test(l));
    expect(rows('E')).toHaveLength(1);
    expect(rows('E')[0]).toMatch(/Customer Advances \+ Unapplied Receipts current state/);
    expect(rows('E')[0]).toMatch(/two liabilities, never netted/);
    expect(rows('E')[0]).toMatch(/built, verified \(internal only, see §14\)/);
    expect(rows('E')[0]).toMatch(
      /EL-1 RULED and IMPLEMENTED \(at most 100 000 Payment \+ CustomerAdvance roots per evaluated scope\)/,
    );
    expect(rows('E')[0]).not.toMatch(/proposed, not started/);
    expect(rows('D')[0]).toMatch(/Advances are NOT part of this checkpoint/);
    expect(rows('F')[0]).toMatch(/Public HTTP wiring/);
    // (Checkpoint F has since been implemented and FROZEN — OWNER APPROVED; G stays proposed)
    expect(rows('F')[0]).toMatch(/FROZEN — OWNER APPROVED \(2026-10-10\)/);
    expect(rows('G')[0]).toMatch(/Final hard gates/);
    expect(rows('G')[0]).toMatch(/local verification run [(]2026-10-10[)].*NOT frozen/);
  });

  it('§14 states the scope: internal only, no controller / route / permission / migration, the letter shift, A–D frozen', () => {
    const s = section();
    expect(s).toMatch(
      /Internal repository \/ service only: \*\*no controller, no route, no permission, no migration\*\*/,
    );
    expect(s).toMatch(/the public HTTP wiring is now \*\*F\*\* and the final hard gates \*\*G\*\*/);
    expect(s).toMatch(/Checkpoints A, B, C and D are frozen/);
    expect(s).toMatch(/twenty-one production files/);
    expect(s).toMatch(/the public API checkpoint and Task 3b\.11 not started/);
    expect(s).toMatch(/migrations remain 49 \(no migration 50\)/);
  });

  it('§14 records the frozen semantics: two liabilities never netted, current snapshot (no date input), database asOf, no aging, no PII, one statement, the shared pagination convention', () => {
    const s = section();
    expect(s).toMatch(/\*\*never netted, never summed, never compared with one another\*\*/);
    expect(s).toMatch(/the report carries no combined `total`/);
    expect(s).toMatch(/\*\*No date input of any kind\*\*/);
    expect(s).toMatch(/`asOf` is \*\*derived by the database in the same statement\*\*/);
    expect(s).toMatch(/\*\*No aging, no customer PII\.\*\*/);
    expect(s).toMatch(/\*\*One statement, one snapshot\.\*\*/);
    expect(s).toMatch(/default \*\*50\*\*, maximum \*\*200\*\* clamped/);
    expect(s).toMatch(/are \*\*pinned equal\*\*, not imported/);
    expect(s).toMatch(
      /The summaries, `byBranch` and both GL controls are the \*\*whole scope\*\*, never the page/,
    );
  });

  it('§14 records the exact Advance semantics: the frozen helper, book vs reservation vs available, PENDING only, the CreditNote excess an Advance only', () => {
    const s = subsection(
      'Customer Advances — the frozen contract, discovered in the producing code, not assumed',
    );
    expect(s).toMatch(/exactly `PAYMENT`[\s\S]*`OPENING`[\s\S]*`CREDIT_NOTE`/);
    expect(s).toMatch(/\*\*The balance is exactly the frozen `computeAdvanceBalance`\*\*/);
    expect(s).toMatch(
      /`original − applied − actuallyRefunded` — \*\*the figure the GL control judges\*\*/,
    );
    expect(s).toMatch(
      /Σ `refund_attempt_entitlement_reservation` of attempts in state \*\*PENDING\*\* only/,
    );
    expect(s).toMatch(
      /`bookLiability − pendingRefundReservation` — what may be applied or refunded \*\*now\*\*/,
    );
    expect(s).toMatch(/\*\*A pending reservation reduces `availableMinor` only\.\*\*/);
    expect(s).toMatch(/not in the book liability and not in any GL fact/);
    expect(s).toMatch(/a \*\*FAILED\*\* attempt reserves nothing/);
    expect(s).toMatch(/a \*\*SUCCEEDED\*\* attempt has become an actual refund application/);
    expect(s).toMatch(/A CreditNote's excess is an Advance \*\*and only an Advance\*\*/);
    for (const figure of [
      'originalAdvanceMinor',
      'appliedMinor',
      'actuallyRefundedMinor',
      'bookLiabilityMinor',
      'pendingRefundReservationMinor',
      'availableMinor',
    ]) {
      expect(s, figure).toContain(`\`${figure}\``);
    }
  });

  it('§14 records the exact Unapplied semantics and the conversion: the frozen capacity formula, a receipt counted once, an application never a receipt consumption, the conversion moving the liability once', () => {
    const s = subsection('Unapplied Receipts — the frozen contract');
    expect(s).toMatch(/\*\*A receipt is counted once\*\*/);
    expect(s).toMatch(
      /exactly the frozen `computePaymentConsumption`\*\* with both draws on receivables in its first term/,
    );
    expect(s).toMatch(
      /`unappliedReceiptMinor = original receipt − allocated to invoices − applied to receivables \(opening \/ cancellation charge\) − converted to an Advance`/,
    );
    expect(s).toMatch(/A `CustomerAdvanceApplication` is \*\*not\*\* a receipt consumption/);
    expect(s).toMatch(/\*\*Payment → Advance conversion moves the liability once\.\*\*/);
    expect(s).toMatch(/`customer_advance\.sourcePaymentId`/);
    expect(s).toMatch(
      /\*\*Dr `LIABILITY\.UNAPPLIED_RECEIPTS` \/ Cr `LIABILITY\.CUSTOMER_ADVANCES`\*\*/,
    );
    expect(s).toMatch(/a walk-in sale has no customer account and is in neither liability/);
    for (const figure of [
      'paymentCount',
      'paymentCountWithUnapplied',
      'originalReceiptMinor',
      'paymentAllocationMinor',
      'receivablePaymentApplicationMinor',
      'allocatedToReceivablesMinor',
      'convertedToAdvanceMinor',
      'unappliedReceiptMinor',
    ]) {
      expect(s, figure).toContain(`\`${figure}\``);
    }
  });

  it('§14 records the two GL controls: every kind of each control (equal to the SQL constants), the shared conversion kind, the sign, the independence, the join shape', () => {
    const s = subsection('The two GL controls — only the authoritative journals of each account');
    // each control's table row names ALL of its own kinds (the shared `customer_advance` must be in BOTH rows)
    const controlRow = (account: string): string => {
      const rows = s.split('\n').filter((l) => l.includes(`| \`${account}\``));
      expect(rows, account).toHaveLength(1);
      return rows[0]!;
    };
    for (const kind of Object.values(ADVANCE_JOURNAL_KINDS)) {
      expect(controlRow(ADV), `${kind} in the advances row`).toContain(`\`${kind}\``);
    }
    for (const kind of Object.values(UNAPPLIED_JOURNAL_KINDS)) {
      expect(controlRow(UNAPPLIED), `${kind} in the unapplied row`).toContain(`\`${kind}\``);
    }
    expect(s).toContain('`LIABILITY.CUSTOMER_ADVANCES`');
    expect(s).toContain('`LIABILITY.UNAPPLIED_RECEIPTS`');
    expect(s).toMatch(/`customer_advance` is the \*\*one\*\* kind on both controls/);
    expect(s).toMatch(/Neither control reads a whole account/);
    expect(s).toMatch(/closed set\*\* pinned by a scan of the code base/);
    expect(s).toMatch(/a single `FULL OUTER JOIN` on `\(control, sourceKind, sourceId\)`/);
    expect(s).toMatch(/GL sign \*\*credit − debit\*\* \(a liability\)/);
    expect(s).toMatch(
      /\*\*A filtered report scopes the totals, the rows and both GL controls in the same snapshot\.\*\*/,
    );
    expect(s).toMatch(/\*\*The two controls are judged independently:\*\*/);
    expect(s).toMatch(
      /an Advance difference of \+X and an Unapplied difference of −X can never net to a pass/,
    );
    expect(s).toMatch(/`REPORT_LIABILITIES_GL_MISMATCH`, 500, naming only the control\(s\)/);
  });

  it('§14 names every integrity check of the repository and the three error codes', () => {
    const s = subsection('Scope, currency and integrity');
    const repo = eProd(REPO);
    const checks = [...repo.matchAll(/\[\s*'([A-Za-z]+)',\s*i\.\1,?\s*\]/g)].map((m) => m[1]!);
    expect(checks).toHaveLength(20);
    for (const check of checks) {
      // the per-control journal checks are named once, as a family: `…MissingJournals` etc.
      const family =
        /^(?:advance|unapplied)(MissingJournals|JournalShapeMismatches|JournalBranchMismatches|OrphanJournals)$/.exec(
          check,
        );
      if (family === null) expect(s, check).toContain(`\`${check}\``);
      else expect(s, check).toContain(`\`…${family[1]}\``);
    }
    expect(s).toMatch(/twenty checks/);
    expect(s).toContain('`REPORT_CURRENCY_MISMATCH` (409) comes first');
    expect(s).toContain('`REPORT_LIABILITIES_SOURCE_INTEGRITY` (500, check names only');
    expect(s).toMatch(
      /Every one of the 29 table references carries its own tenant and company predicate/,
    );
    expect(s).toMatch(/AED \(2 decimals\) and KWD \(3 decimals\) are both proven/);
  });

  it('§14 records the measured performance decision exactly: the figures, the disclaimer, the STOP rule, no guard, EL-1 open and recommended, the projection labelled as such', () => {
    const v = subsection(
      'Query-plan / volume decision — measured, nothing capped before measuring',
    );
    expect(v).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(v).toMatch(/\*\*6 867 \/ 6 933 ms\*\*/);
    expect(v).toMatch(/527 \/ 537 ms/);
    expect(v).toMatch(/2 644 \/ 2 933 ms/);
    expect(v).toMatch(/3 347 \/ 3 681 ms/);
    expect(v).toMatch(/652 \/ 789 ms/);
    expect(v).toMatch(/125 \/ 159 ms/);
    expect(v).toMatch(/7 642 ms/);
    expect(v).toMatch(/expressions only \(896 fn\)/);
    expect(v).toMatch(/31 \/ 40 \/ 43 µs/);
    expect(v).toMatch(/\*\*2\.6× for the doubling to 100 000\*\*/);
    expect(v).toMatch(/Node RSS 127 MB after seeding → ≤ 191 MB/);
    expect(v).toMatch(
      /\*\*At delivery no cap, no density guard, no index and no migration was added\.\*\*/,
    );
    expect(v).toMatch(
      /\*\*58 % of the 12 s local engineering gate and 35 % of the ≈ 20 s scoped-transaction timeout\*\*/,
    );
    expect(v).toMatch(/so the STOP rule of the instruction did not fire/);
    expect(v).toMatch(/\*\*Owner decision EL-1 was OPEN at delivery \(RULED and IMPLEMENTED/);
    expect(v).toMatch(
      /\(≈ 330 000 logical rows; a projection from two measurements, not a measurement\)/,
    );
    expect(v).toMatch(/It was \*\*not implemented at delivery\*\*/);
    expect(v).toMatch(/Every figure equals an independent oracle at every size\./);
  });

  it('§14 records the migration decision: none', () => {
    const m = subsection('Migration / index decision');
    expect(m).toMatch(/\*\*None\.\*\* No schema gap and no index is required/);
    expect(m).toMatch(/Migrations remain 49/);
    expect(m).toMatch(/no database-wide JIT setting was touched/);
  });

  it('§14 states the boundaries it does not hide', () => {
    const b = subsection('Stated boundaries (residuals, not hidden)');
    expect(b).toMatch(/An unattributable orphan journal fails only the unfiltered company report/);
    expect(b).toMatch(/Each control reads only its own authoritative kinds/);
    expect(b).toMatch(/`REPORT_LIABILITIES_GL_MISMATCH` \(500\) is defence in depth/);
    expect(b).toMatch(
      /The reservation exists only for CREDIT_NOTE-origin Advances refunded through a provider/,
    );
    expect(b).toMatch(/Walk-in Payments are in neither liability/);
    expect(b).toMatch(
      /\*\*A scope above 100 000 liability roots is rejected, not paged \(EL-1\)\*\*/,
    );
  });

  it('§14 records its verification exactly and leaves no unfilled placeholder', () => {
    const v = subsection('Verification (Checkpoint E)');
    expect(plan()).not.toMatch(/@@[A-Z0-9]+@@/);
    expect(plan()).not.toMatch(/TBD-[A-Z]+/);
    expect(v).toMatch(/`customer-liabilities-report\.test\.ts` — \*\*11\*\* tests/);
    expect(v).toMatch(/`customer-liabilities-report\.integration\.test\.ts` — \*\*43\*\* tests/);
    expect(v).toMatch(
      /`customer-liabilities-report\.query-plan\.integration\.test\.ts` — \*\*8\*\* tests/,
    );
    expect(v).toMatch(
      /\*\*6 advances, original 13 450, applied 3 250, refunded 1 600, book 8 600, pending reservation 500, available 8 100\*\*/,
    );
    expect(v).toMatch(
      /\*\*9 Payments \(3 with an unapplied remainder\), original 20 950, allocated 8 400, applied to receivables 700, converted 6 250, unapplied 5 600\*\*/,
    );
    expect(v).toMatch(
      /\*\*concurrent\*\* Advance applications, \*\*concurrent\*\* conversions and \*\*concurrent\*\* final Refunds/,
    );
    expect(v).toMatch(/\*\*wrong branch attribution of every one of the eight attributions\*\*/);
    expect(v).toMatch(/\*\*a CreditNote Advance without its coverage release\*\*/);
    expect(v).toMatch(/`task-3b10-checkpoint-e-structural\.test\.ts` — \*\*84\*\* pins/);
    expect(v).toMatch(
      /\*\*Pin sensitivity: 393 deliberate violations — every one turned a pin RED\*\*/,
    );
    expect(v).toMatch(/The first full run found \*\*9\*\* that stayed green/);
    expect(v).toMatch(/That run was stopped once by its background time limit after 287 results/);
    expect(v).toMatch(
      /\*\*77 mutants\*\* of the statement, the pure code and the repository: \*\*77 caught\*\*/,
    );
    expect(v).toMatch(
      /13 by the unit suite, 53 by the real-document suite and \*\*11 by the structural pins alone\*\*/,
    );
    expect(v).toMatch(
      /\*\*both were real test gaps and are closed\*\* by two new integration tests/,
    );
    expect(v).toMatch(/\*\*Caught by the pins alone \(11, and why\):\*\*/);
    expect(v).toMatch(/\*\*Fast targeted regression: 7 groups green, 1 560 tests\*\*/);
    expect(v).toMatch(/reporting E with the A–D pins 385/);
    expect(v).toMatch(/receivables 387/);
    expect(v).toMatch(/accounting 68/);
    expect(v).toMatch(/CreditNote \/ refund \/ advance 273/);
    expect(v).toMatch(/isolation probes 21/);
    expect(v).toMatch(/database liability integrity 376/);
    expect(v).toMatch(/money 50/);
    expect(v).toMatch(/ESLint `--max-warnings 0` clean on the reporting module/);
    expect(v).toMatch(
      /Checkpoints A–D frozen\.\*\* The twenty-one A–D production files keep their pinned SHA-256 hashes/,
    );
    expect(v).toMatch(
      /migrations remain 49 \(no migration 50\); nothing is registered in any Nest module; no commit, no push, no PR; the public API checkpoint and Task 3b\.11 not started/,
    );
  });

  it('the decision log has ONE 3b.10-CL row: the rulings, the measured decision, EL-1 open, no migration; every earlier 3b.10 row is untouched and unique', () => {
    expect(row('3b.10-CL')).toHaveLength(1);
    const r = row('3b.10-CL')[0]!;
    expect(r).toMatch(
      /Checkpoint E — Customer Advances \+ Unapplied Receipts current-state report: recorded implementation decisions/,
    );
    expect(r).toMatch(/\*\*Two liabilities, never netted:\*\*/);
    expect(r).toMatch(
      /an Advance difference of \+X and an Unapplied difference of −X can never net to a pass/,
    );
    expect(r).toMatch(/\*\*Current snapshot only:\*\* no date input of any kind/);
    expect(r).toMatch(
      /\*\*book liability = original − applied \(CustomerAdvanceApplication\) − actually refunded \(CustomerAdvanceRefundApplication\)\*\*/,
    );
    expect(r).toMatch(
      /\*\*pending refund reservation = Σ reservations of PENDING refund attempts only\*\*/,
    );
    expect(r).toMatch(/\*\*available = book − pending reservation\*\*/);
    expect(r).toMatch(/\*\*A pending reservation reduces available only\*\*/);
    expect(r).toMatch(/\*\*only an actual, final refund reduces the book liability\*\*/);
    expect(r).toMatch(/exactly `PAYMENT`, `OPENING` and `CREDIT_NOTE` \(the database CHECK\)/);
    expect(r).toMatch(/an Advance \*\*and only an Advance\*\*/);
    expect(r).toMatch(
      /\*\*unapplied = receipt − allocated to invoices − applied to receivables − converted to an Advance\*\*/,
    );
    expect(r).toMatch(
      /\*\*Dr `LIABILITY\.UNAPPLIED_RECEIPTS` \/ Cr `LIABILITY\.CUSTOMER_ADVANCES`\*\*/,
    );
    expect(r).toMatch(/\*\*Separate GL controls\*\*/);
    expect(r).toMatch(/\*\*0\.54 s at 10 000, 2\.9 s at 50 000, 6\.9 s worst at 100 000\*\*/);
    expect(r).toMatch(/local test container; not production capacity/);
    expect(r).toMatch(/\*\*No cap, density guard, index or migration was added at delivery\*\*/);
    expect(r).toMatch(/\*\*EL-1 \(OPEN at delivery, RULED and IMPLEMENTED/);
    expect(r).toMatch(/\*\*Migration decision:\*\* none/);
    expect(r).toMatch(/\*\*EL-1 SUPERSEDED by `3b\.10-CG` \(2026-10-10\)\*\*/);
    expect(r).toMatch(/twenty-one production files hash-pinned/);
    expect(r).toMatch(/The public API checkpoint and Task 3b\.11 not started/);
    for (const id of [
      '3b.10-OD',
      '3b.10-TB',
      '3b.10-SR',
      '3b.10-CC',
      '3b.10-DG',
      '3b.10-TT',
      '3b.10-TD',
      '3b.10-RD',
      '3b.10-RG',
    ]) {
      expect(row(id), id).toHaveLength(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — the density guard (owner ruling EL-1): at most 100 000 Payment + CustomerAdvance roots per EVALUATED scope', () => {
  const GATE_OPEN = '(SELECT gt."n" FROM gate gt) <= 100000';
  /** every CTE of the statement, in order, with its text (the final SELECT is the stage `final`) */
  const stages = (): { name: string; text: string }[] => {
    const marks = [...SQL.matchAll(/(?:^|\n)(?:WITH )?([a-z_0-9]+) AS (?:MATERIALIZED )?\(/g)];
    const out: { name: string; text: string }[] = [];
    marks.forEach((m, i) => {
      const end =
        i + 1 < marks.length ? marks[i + 1]!.index! : SQL.indexOf('\nSELECT json_build_object(');
      out.push({ name: m[1]!, text: SQL.slice(m.index!, end) });
    });
    out.push({ name: 'final', text: SQL.slice(SQL.indexOf('\nSELECT json_build_object(')) });
    return out;
  };
  const stage = (name: string): string => {
    const s = stages().find((x) => x.name === name);
    expect(s, `stage ${name}`).toBeDefined();
    return s!.text;
  };
  const gateLegs = (): string[] => stage('gate').split('UNION ALL');
  const baseTables = (text: string): string[] =>
    [...text.matchAll(/(?:FROM|JOIN)\s+\(?"([a-z_]+)"/g)].map((m) => m[1]!);
  /** the scope predicates of a stage text, with the table aliases removed (so a gate leg compares with its heavy stage) */
  const scopePredicates = (text: string): string[] =>
    [
      ...new Set(
        [...text.matchAll(/(?:AND|WHERE|ON)\s+\(?([^\n]*\$[1-4]::uuid[^\n]*)/g)].map((m) =>
          m[1]!
            .replace(/\b[a-z][a-z0-9]*\."/g, '"')
            .replace(/\s+/g, ' ')
            .replace(/\)$/, '')
            .trim(),
        ),
      ),
    ].sort();

  it('ONE authoritative constant: 100 000, defined once, the production repository default, never repeated as a literal', () => {
    expect(CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS).toBe(100_000);
    expect(eProd(SQLF)).toMatch(/export const CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS = 100_000;/);
    for (const n of E_PRODUCTION) {
      const literals = (eProd(n).match(/100_?000/g) ?? []).length;
      expect(literals, `${n}: the limit literal`).toBe(n === SQLF ? 1 : 0);
    }
    const repo = eProd(REPO);
    expect(repo).toMatch(
      /protected readonly maxRoots: number = CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS;/,
    );
    expect((repo.match(/CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS/g) ?? []).length).toBe(2); // the import and the default
    expect(repo).toMatch(/maxRoots: this\.maxRoots,/);
    const sql = eProd(SQLF);
    expect(sql).toMatch(
      /export const CUSTOMER_LIABILITIES_REPORT_SQL = customerLiabilitiesReportSql\(\s*CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS,?\s*\);/,
    );
    expect(sql).toMatch(/readonly maxRoots\?: number;/);
    expect(sql).toMatch(/Number\.isSafeInteger\(maxRoots\) \|\| maxRoots < 0/);
    // an independent constant of every other report's limit
    expect(CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS).toBe(RECEIVABLES_REPORT_MAX_RECEIVABLES);
    expect(eProd(SQLF)).not.toMatch(/RECEIVABLES_REPORT|TENDER_REPORT|SALES_REPORT/);
  });

  it('the root definition is EXACTLY a customer-attributable Payment or a CustomerAdvance — three legs, one row per record, never a journal row', () => {
    const legs = gateLegs();
    expect(legs).toHaveLength(3);
    expect(baseTables(legs[0]!).sort()).toEqual(['customer_advance', 'customer_company_account']);
    expect(baseTables(legs[1]!).sort()).toEqual([
      'customer_company_account',
      'payment',
      'payment_attempt',
    ]);
    expect(baseTables(legs[2]!).sort()).toEqual([
      'customer_company_account',
      'invoice',
      'order',
      'payment',
      'payment_attempt',
    ]);
    expect(legs[1]).toMatch(/pag\."receiptPurpose" = 'CUSTOMER_RECEIPT'/);
    expect(legs[2]).toMatch(/qag\."receiptPurpose" = 'INVOICE_COLLECTION'/);
    // each leg yields ONE row per root: no DISTINCT / GROUP BY / aggregate — a Payment-derived Advance is two roots
    const gate = stage('gate');
    expect(gate).not.toMatch(/DISTINCT|GROUP BY|ORDER BY|SUM\(|HAVING/);
    expect((gate.match(/SELECT 1\b/g) ?? []).length).toBe(4); // the three leaves and the early-stopped limit's own
    expect(gate).toMatch(/COUNT\(\*\) AS "n"/);
    // the dependent facts are NEVER roots: none of their relations is in the gate
    for (const dependent of [
      'payment_allocation',
      'customer_receivable_payment_application',
      'customer_receivable',
      'customer_advance_application',
      'customer_advance_refund_application',
      'refund',
      'refund_attempt',
      'refund_attempt_entitlement_reservation',
      'credit_note',
      'credit_note_coverage_release',
      'settlement_application',
      'settlement_batch',
      'settlement_line',
      'journal_entry',
      'journal_line',
      'account',
    ]) {
      expect(baseTables(gate), `the gate reads ${dependent}`).not.toContain(dependent);
    }
    // the roots are counted in the SOURCE records, never the journals
    expect(gate).not.toMatch(/journal|sourceKind|sourceId/);
  });

  it('the WALK-IN Payment is no root: every Payment leg joins the customer account with an INNER join, and the invoice-collection leg reaches it only through the order customer', () => {
    const gate = stage('gate');
    expect(gate).not.toMatch(
      /LEFT JOIN|RIGHT JOIN|FULL JOIN|COALESCE|IS NULL OR og|"customerId" IS NULL/,
    );
    const legs = gateLegs();
    expect(legs[1]).toMatch(
      /JOIN "customer_company_account" xpg\s+ON xpg\."id" = pag\."customerCompanyAccountId"/,
    );
    expect(legs[2]).toMatch(/xqg\."customerId" = og\."customerId"/);
    // exactly the attribution of the Unapplied-Receipts universe (`pay`): the gate's Payment legs equal `pay`'s, alias-free
    const payLegs = stage('pay').split('UNION ALL');
    expect(payLegs).toHaveLength(2);
    expect(scopePredicates(legs[1]!)).toEqual(scopePredicates(payLegs[0]!));
    expect(scopePredicates(legs[2]!)).toEqual(scopePredicates(payLegs[1]!));
    expect(baseTables(legs[1]!).sort()).toEqual(baseTables(payLegs[0]!).sort());
    expect(baseTables(legs[2]!).sort()).toEqual(baseTables(payLegs[1]!).sort());
  });

  it('the scope is the EVALUATED one — company, branch ($3, the root’s OWN branch) and customer ($4) — with exactly the predicates the report stages apply', () => {
    const legs = gateLegs();
    expect(scopePredicates(legs[0]!)).toEqual(scopePredicates(stage('adv')));
    for (const [leg, alias, cust] of [
      [legs[0]!, 'cg', 'xg'],
      [legs[1]!, 'pg', 'xpg'],
      [legs[2]!, 'qg', 'xqg'],
    ] as const) {
      expect(leg).toContain(`($3::uuid IS NULL OR ${alias}."branchId" = $3::uuid)`);
      expect(leg).toContain(`($4::uuid IS NULL OR ${cust}."customerId" = $4::uuid)`);
      expect(leg).toContain(`${alias}."tenantId" = $1::uuid`);
      expect(leg).toContain(`${alias}."companyId" = $2::uuid`);
    }
    // never a sibling branch, never another customer, never a date
    expect(stage('gate')).not.toMatch(/\$[56]::|createdAt|postingDate|interval|BETWEEN|"date"/i);
  });

  it('the gate is the FIRST stage of the SAME statement: after the scope lookups, before every heavy stage; one early-stopped LIMIT limit + 1', () => {
    const names = stages().map((s) => s.name);
    expect(names.slice(0, 5)).toEqual(['co', 'scope_branch', 'scope_customer', 'gate', 'adv']);
    expect(SQL.match(/LIMIT 100001/g) ?? []).toHaveLength(1);
    expect(stage('gate')).toMatch(/LIMIT 100001\s+\) gs/);
    expect(SQL.match(/gate AS MATERIALIZED \(/g) ?? []).toHaveLength(1);
    // one statement, one COUNT: the repository never runs a counting query of its own
    expect(eProd(REPO)).not.toMatch(/COUNT\(|\.count\(/);
    expect((SQL.match(/'candidateRoots', \(SELECT gt\."n" FROM gate gt\),/g) ?? []).length).toBe(1);
    expect(eProd(SQLF)).toMatch(
      /const gateOpen = `\(SELECT gt\."n" FROM gate gt\) <= \$\{maxRoots\}`;/,
    );
    expect((eProd(SQLF).match(/const gateOpen/g) ?? []).length).toBe(1);
  });

  it('EVERY heavy stage carries the gate (a One-Time Filter): the base-table stages are a CLOSED set and each names the gate — so none executes above the limit', () => {
    const readsBaseTable = stages()
      .filter((s) => baseTables(s.text).length > 0)
      .map((s) => s.name);
    expect(readsBaseTable).toEqual([
      'co',
      'scope_branch',
      'scope_customer',
      'gate',
      'adv',
      'aapp',
      'rapp',
      'rsv',
      'pay',
      'palloc',
      'pcrpa',
      'pconv',
      'fact',
      'jh',
      'jall',
      'jx',
      'ic',
    ]);
    const legsOf: Record<string, number> = {
      adv: 1,
      aapp: 1,
      rapp: 1,
      rsv: 1,
      pay: 2,
      palloc: 1,
      pcrpa: 1,
      pconv: 1,
      fact: 1,
      jh: 1,
      jall: 1,
      jx: 2,
      ic: 1,
    };
    for (const [name, legs] of Object.entries(legsOf)) {
      expect(
        (stage(name).match(/\(SELECT gt\."n" FROM gate gt\) <= 100000/g) ?? []).length,
        name,
      ).toBe(legs);
    }
    // the lightweight stages (lookups and the gate itself) carry none — a 404 is never a density answer
    for (const name of ['co', 'scope_branch', 'scope_customer', 'gate']) {
      expect(stage(name), name).not.toContain(GATE_OPEN);
    }
    expect((SQL.match(/\(SELECT gt\."n" FROM gate gt\) <= 100000/g) ?? []).length).toBe(15);
    // everything else derives from the gated stages
    for (const s of stages()) {
      if (['co', 'scope_branch', 'scope_customer', 'gate', 'final'].includes(s.name)) continue;
      if (name_in(legsOf, s.name)) continue;
      expect(baseTables(s.text), `${s.name} reads no base table`).toEqual([]);
    }
  });

  it('the rejection is generic and non-disclosing, REPORT_RESULT_TOO_LARGE 422, and comes after the 404s and before the authority and every integrity check', () => {
    const repo = eProd(REPO);
    expect(repo).toMatch(
      /if \(json\.candidateRoots > this\.maxRoots\) \{\s*throw new DomainError\(\s*'REPORT_RESULT_TOO_LARGE',/,
    );
    expect(repo).toMatch(
      /422,\s*\[\s*\{ field: 'maxRoots', issue: String\(this\.maxRoots\) \},\s*\{ field: 'action', issue: 'narrow_scope' \},\s*\],/,
    );
    // the actual count is read once — to compare — and never written into the answer
    expect((repo.match(/candidateRoots/g) ?? []).length).toBe(1);
    expect(repo).not.toMatch(
      /String\(json\.candidateRoots\)|\$\{json\.candidateRoots\}|candidateRoots\s*\+/,
    );
    const message = repo.slice(repo.indexOf("'REPORT_RESULT_TOO_LARGE',"), repo.indexOf('422,'));
    expect(message).not.toMatch(/json\.|branch \$|customer \$|\$\{input|\$\{customerId|\$\{branch/);
    // the order of checks: the three 404s → density → authority → integrity
    const at = (s: string): number => repo.indexOf(s);
    expect(at("throw new NotFoundError('company')")).toBeLessThan(
      at("throw new NotFoundError('branch')"),
    );
    expect(at("throw new NotFoundError('branch')")).toBeLessThan(
      at("throw new NotFoundError('customer')"),
    );
    expect(at("throw new NotFoundError('customer')")).toBeLessThan(
      at('json.candidateRoots > this.maxRoots'),
    );
    expect(at('json.candidateRoots > this.maxRoots')).toBeLessThan(
      at('resolveCompanyReportAuthority(json.company)'),
    );
    expect(at('json.candidateRoots > this.maxRoots')).toBeLessThan(
      at('assertSourceIntegrity(json)'),
    );
    expect((repo.match(/'REPORT_RESULT_TOO_LARGE'/g) ?? []).length).toBe(1);
  });

  it('NO calendar cap and no other guard vocabulary: the density unit is the root, never a date range', () => {
    for (const n of E_PRODUCTION) {
      expect(eProd(n), n).not.toMatch(
        /MAX_DAYS|MAX_DOCUMENTS|MAX_MOVEMENTS|MAX_RECEIVABLES|maxDays|maxDocuments|maxMovements|maxReceivables|candidateReceivables|candidateMovements|candidateDocuments|REPORT_RANGE_TOO_LARGE/,
      );
    }
    expect(stage('gate')).not.toMatch(/Date|date|day|period/);
  });

  it('the suites pin the guard’s contract: the scope-local tests, the root definition, the EXPLAIN gate and the exact 100 000 / 100 001 run', () => {
    const it_ = read(join(DIR, 'customer-liabilities-report.integration.test.ts'));
    for (const title of [
      'the density guard (owner ruling EL-1)',
      'company scope: exactly the limit is accepted',
      'branch scope is SCOPE-LOCAL',
      'customer-filtered scope is SCOPE-LOCAL',
      'the page size never decides the guard',
      'the rejection is generic and non-disclosing',
      'are still plain 404s',
      'an empty scope is within every limit',
      'is ONE statement in ONE read-only transaction and writes nothing',
      'the over-limit answer PRECEDES the integrity analysis',
      'the ROOT DEFINITION: a Payment is +1, a CustomerAdvance +1, a Payment-derived Advance +2 in all, a walk-in Payment 0 and EVERY dependent fact +0',
      'a RefundAttempt reservation and a SettlementApplication are +0',
    ]) {
      expect(it_, title).toContain(title);
    }
    expect(it_).toMatch(/protected override readonly maxRoots: number = n;/);
    expect(it_).toMatch(/async function rootsOf\(/);
    expect(it_).toMatch(/const oracleRoots = async/);
    const qp = read(join(DIR, 'customer-liabilities-report.query-plan.integration.test.ts'));
    expect(qp).toMatch(/LIABILITIES_VOLUME_ROOTS/);
    expect(qp).toMatch(/EL-1 density gate \(EXPLAIN\)/);
    expect(qp).toMatch(/it\.skipIf\(ROOTS !== 100_000\)/);
    expect(qp).toMatch(/expect\(await roots\(\)\)\.toBe\(100_000\);/);
    expect(qp).toMatch(/expect\(await roots\(\)\)\.toBe\(100_001\);/);
    expect(qp).toMatch(/expect\(acceptedMs\)\.toBeLessThan\(LOCAL_GATE_MS\);/);
    expect(qp).toMatch(/expect\(median\(times\)\)\.toBeLessThan\(acceptedMs \/ 2\);/);
    expect(qp).toMatch(/maxRoots/);
    for (const setting of [
      'enable_hashjoin = off',
      'enable_nestloop = off',
      'enable_seqscan = off',
      'jit = off',
    ]) {
      expect(qp, setting).toContain(setting);
    }
    // the guard never alters the frozen semantic suites' expectations: the unit suite is untouched by it
    expect(read(join(DIR, 'customer-liabilities-report.test.ts'))).not.toMatch(
      /maxRoots|candidateRoots/,
    );
  });
});

/** is `name` a key of the map? (a tiny helper kept outside the describe so the closed-set test reads linearly) */
function name_in(map: Record<string, number>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — documentation of the density closure (EL-1)', () => {
  const plan = (): string => read(join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md'));
  const log = (): string => read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
  const closure = (title: string): string => {
    const p = plan();
    const at = p.indexOf(`### ${title}`);
    expect(at, title).toBeGreaterThan(0);
    const next = p.indexOf('\n### ', at + 4);
    return p.slice(at, next === -1 ? undefined : next);
  };

  it('§14 "Density closure" records the frozen rule: the constant, the root definition, the scope-local limits, the error contract and the same-statement gate', () => {
    const c = closure(
      'Density closure — Customer Liabilities v1: at most 100 000 Payment + CustomerAdvance roots per evaluated scope',
    );
    expect(c).toMatch(/Owner ruling \*\*EL-1\*\* \(2026-10-10\), implemented/);
    expect(c).toContain('`CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS = 100 000`');
    expect(c).toMatch(/\*\*no date \/ calendar cap\*\*/);
    expect(c).toMatch(/\*\*local operational safety bound, not a production SLA\.\*\*/);
    expect(c).toMatch(/exactly \*\*one customer-attributable `payment`\*\*/);
    expect(c).toMatch(/a walk-in Payment is \*\*no root\*\*/);
    expect(c).toMatch(/60 000 Payments \+ 40 000 Advances is allowed; 60 001 \+ 40 000 is not/);
    expect(c).toMatch(/A Payment-derived CustomerAdvance is \*\*two roots\*\*/);
    expect(c).toMatch(
      /\*\*Never roots:\*\* a PaymentAllocation, a receivable payment application, a CustomerAdvanceApplication, a CustomerAdvanceRefundApplication, a Refund, a RefundAttempt/,
    );
    expect(c).toMatch(/a CreditNote, a SettlementApplication — and never a journal row/);
    expect(c).toMatch(/\*\*Scope-local:\*\*/);
    expect(c).toMatch(/sibling branches never contribute/);
    expect(c).toMatch(/\*\*Error contract:\*\* `REPORT_RESULT_TOO_LARGE`, 422/);
    expect(c).toMatch(/details `maxRoots: 100000` and `action: narrow_scope`/);
    expect(c).toMatch(
      /\*\*never the actual count, a sibling branch, a customer, an id or a figure\*\*/,
    );
    expect(c).toMatch(
      /\*\*Same-statement gate:\*\* the first stage of the SAME statement, never a COUNT-then-report/,
    );
    expect(c).toMatch(/\*\*at most limit \+ 1\*\* roots/);
    expect(c).toMatch(/\*\*Fifteen\*\* One-Time Filter gate predicates/);
    expect(c).toMatch(/\*\*closed set\*\* \(a pin\)/);
  });

  it('§14 "Density closure" records the measurements exactly and the benchmark disclaimer', () => {
    const c = closure(
      'Density closure — Customer Liabilities v1: at most 100 000 Payment + CustomerAdvance roots per evaluated scope',
    );
    expect(c).toMatch(/Local test-container benchmark; not production capacity\./);
    expect(c).toMatch(/\*\*exactly 100 000 roots\*\*/);
    expect(c).toMatch(/65 574 customer Payments/);
    expect(c).toMatch(/34 426 Advances \(PAYMENT 19 671, OPENING 6 559, CREDIT_NOTE 8 196\)/);
    expect(c).toMatch(/\*\*6 227 ms\*\*/);
    expect(c).toMatch(/\*\*1 878 \/ 1 646 \/ 1 379 ms\*\*/);
    expect(c).toMatch(/payload 1 230 bytes/);
    expect(c).toMatch(/1 691 ms; \*\*no heavy relation executed\*\*/);
    expect(c).toMatch(/accepted \(30 019 roots\)/);
    expect(c).toMatch(/accepted \(6 roots\)/);
    expect(c).toMatch(/eight planner alternatives/);
    expect(c).toMatch(/stop at exactly 11 rows/);
    expect(c).toMatch(/is 6, not 4/);
    expect(c).toMatch(/\*\*No migration, no index and no timeout change\.\*\*/);
    expect(c).toMatch(/Historical evidence kept/);
  });

  it('the closure verification section records its evidence and leaves nothing unfilled', () => {
    const v = closure('Verification (Checkpoint E — density closure)');
    expect(v).not.toMatch(/TBD-[A-Z]+/);
    expect(v).toMatch(/\*\*56\*\* tests \(43 \+ \*\*13\*\* density tests\)/);
    expect(v).toMatch(/\*\*10\*\* tests \(8 \+ \*\*2\*\*\)/);
    expect(v).toMatch(
      /\*\*39 mutants of the guard, 39 caught\*\* — 29 by the real-document tests, 6 by the EXPLAIN gate test and 4 by the pins alone/,
    );
    expect(v).toMatch(/A first run of this suite was invalid/);
    expect(v).toMatch(/\*\*97\*\* pins \(84 \+ \*\*13\*\*\)/);
    expect(v).toMatch(/\*\*Fast targeted regression: 7 groups green, 1 587 tests\*\*/);
    expect(v).toMatch(/reporting E with the A–D pins 412/);
    expect(v).toMatch(/receivables 387, accounting 68, CreditNote \/ refund \/ advance 273/);
    expect(v).toMatch(/isolation probes 21, database liability integrity 376, money 50/);
    expect(v).toMatch(/migrations remain 49 \(no migration 50\)/);
    expect(v).toMatch(/the public API checkpoint and Task 3b\.11 not started/);
  });

  it('the decision log has ONE 3b.10-CG row: the frozen rule, the roots, the scope-local limits, the contract, the measurement; 3b.10-CL is superseded, never rewritten', () => {
    const rows = log()
      .split('\n')
      .filter((l) => l.startsWith('| **3b.10-CG**'));
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatch(/Customer Liabilities density closure \(owner ruling EL-1\)/);
    expect(r).toMatch(/\*\*no date or calendar cap\*\*/);
    expect(r).toContain('`CUSTOMER_LIABILITIES_REPORT_MAX_ROOTS = 100 000`');
    expect(r).toMatch(
      /\*\*A root is exactly one customer-attributable Payment or one CustomerAdvance\*\*/,
    );
    expect(r).toMatch(/a Payment-derived Advance is \*\*two\*\* roots/);
    expect(r).toMatch(/a walk-in Payment is no root/);
    expect(r).toMatch(/a SettlementApplication and a journal row are \*\*never\*\* roots/);
    expect(r).toMatch(/\*\*sibling branches never contribute\*\*/);
    expect(r).toMatch(/`maxRoots: 100000` and `action: narrow_scope`/);
    expect(r).toMatch(/fifteen One-Time Filters/);
    expect(r).toMatch(/\*\*6\.2 s\*\*/);
    expect(r).toMatch(/\*\*100 001 roots rejected in 1\.9 \/ 1\.6 \/ 1\.4 s\*\*/);
    expect(r).toMatch(/not production capacity/);
    expect(r).toMatch(/\*\*local operational safety bound, not a production SLA\.\*\*/);
    expect(r).toMatch(/No migration 50 \(migrations remain 49\)/);
    expect(r).toMatch(/twenty-one production files hash-pinned/);
    expect(
      log()
        .split('\n')
        .filter((l) => l.startsWith('| **3b.10-CL**')),
    ).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('E — FROZEN, OWNER APPROVED (2026-10-10): the four production files are byte-locked and the freeze is recorded', () => {
  const FROZEN_E: Record<string, string> = {
    'customer-liabilities-report.ts':
      'df7fe5829ae86ed0fc621f24d3ade77da30e7a371b15f0e022a45b6e95706361',
    'customer-liabilities-report.sql.ts':
      'f11bf273ad7b74727835c6691a8cdcd05cfcbdb5c762a4b7b241c3d70fac57ab',
    'customer-liabilities-report.repository.ts':
      '19ee7bda4b78ba54270cd8112dc4f51bdf83d7b3a997e972f5236edd3d59efa3',
    'customer-liabilities-report.service.ts':
      '94a1632547e2f585ebd816b56323933891583936d0a8d8b0e57ae96efed552ee',
  };
  for (const [file, hash] of Object.entries(FROZEN_E)) {
    it(`${file} is byte-identical to its frozen state`, () => {
      expect(sha(join(DIR, file))).toBe(hash);
    });
  }

  it('the plan and the decision log record Checkpoint E as FROZEN — OWNER APPROVED, with F and G still not started', () => {
    const plan = read(join(ROOT, 'docs/phase-3/TASK-3B10-PLAN.md'));
    const rows = (letter: string): string[] =>
      plan.split('\n').filter((l) => new RegExp(`^\\| ${letter}\\s+\\|`).test(l));
    expect(rows('E')[0]).toMatch(/density closure FROZEN — OWNER APPROVED \(2026-10-10\)/);
    // (at the freeze F was "proposed, not started"; it has since been implemented and FROZEN — see §15)
    expect(rows('F')[0]).toMatch(/FROZEN — OWNER APPROVED \(2026-10-10\)/);
    expect(rows('G')[0]).toMatch(/local verification run [(]2026-10-10[)].*NOT frozen/);
    const at = plan.indexOf('### Freeze — Checkpoint E: FROZEN — OWNER APPROVED (2026-10-10)');
    expect(at).toBeGreaterThan(0);
    const f = plan.slice(at);
    expect(f).toMatch(
      /Checkpoint F \(Public HTTP wiring\) and Checkpoint G \(final hard gates\) are NOT STARTED/,
    );
    expect(f).toMatch(/Checkpoints A–D stay frozen with their twenty-one pinned hashes/);
    for (const hash of Object.values(FROZEN_E)) {
      expect(f).toContain(`${hash.slice(0, 8)}…${hash.slice(-4)}`);
    }
    const row = read(join(ROOT, 'docs/decisions/DECISION-LOG.md'))
      .split('\n')
      .filter((l) => l.startsWith('| **3b.10-FZ**'));
    expect(row).toHaveLength(1);
    expect(row[0]).toMatch(/FROZEN, OWNER APPROVED \(2026-10-10\)/);
    expect(row[0]).toMatch(
      /Checkpoint F \(public HTTP wiring\) and Checkpoint G \(final gates\) are \*\*NOT STARTED\*\*/,
    );
  });
});
