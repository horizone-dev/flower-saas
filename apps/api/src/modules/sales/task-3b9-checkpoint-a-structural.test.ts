import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS } from '@flower/permissions';
import * as permissionsModule from '@flower/permissions';
import { computeCanonicalTotals } from '../orders/canonical-totals.js';
import { planSale } from './sale-plan.js';
import { buildWalkInSaleJournal } from './walk-in-sale-journal.js';

/**
 * Task 3b.9 Checkpoint A (A6) — structural pins.
 *
 * Checkpoint A is the PURE foundation: it must contain no provider call, no
 * inventory call, no DB write from the totals computation, no business-type
 * branching, no float money arithmetic, no migration 50, no Task 3b.10, no
 * anonymous cancellation / refund workaround and no new permission. These tests
 * read the real source (comments stripped) and the real import closure, so they
 * cannot be satisfied by wording.
 *
 * A few pins are deliberately Checkpoint-A-scoped ("no controller / module yet"):
 * the checkpoint that legitimately adds that surface replaces the pin in the same
 * change (each is marked `[CHECKPOINT-A SCOPE]`).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const SRC = resolve(HERE, '../..'); // apps/api/src
const read = (abs: string): string => readFileSync(abs, 'utf8');

/** the four production files Checkpoint A adds */
const A_FILES = {
  canonicalTotals: join(SRC, 'modules/orders/canonical-totals.ts'),
  salePlan: join(SRC, 'modules/sales/sale-plan.ts'),
  walkInJournal: join(SRC, 'modules/sales/walk-in-sale-journal.ts'),
  invoiceSummary: join(SRC, 'modules/orders/order-invoice-summary.ts'),
} as const;
/** the three that must be pure over BigInt (the summary additionally maps a DATE) */
const PURE_MONEY_FILES = ['canonicalTotals', 'salePlan', 'walkInJournal'] as const;

/** drop comments, then string / template contents — what is left is executable code */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
function codeOnly(src: string): string {
  return stripComments(src)
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
function specifiersOf(abs: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(read(abs)).matchAll(IMPORT_RE)) out.push(m[1]!);
  return out;
}
/** every relative file reachable from `entry`, plus every bare package it (transitively) imports */
function importClosure(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (abs: string): void => {
    if (files.has(abs)) return;
    files.add(abs);
    for (const spec of specifiersOf(abs)) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(abs), spec).replace(/\.js$/, '.ts');
        if (!existsSync(target)) throw new Error(`unresolved import ${spec} from ${abs}`);
        visit(target);
      } else {
        bare.add(spec);
      }
    }
  };
  visit(entry);
  return { files, bare };
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
const productionFiles = (dir: string): string[] =>
  walk(dir).filter((f) => f.endsWith('.ts') && !isTest(f));

describe('A6 — the Checkpoint A files are pure: no provider, no DB, no framework', () => {
  for (const [name, abs] of Object.entries(A_FILES)) {
    it(`${name}: its whole import closure reaches only @flower/money and @flower/uom`, () => {
      const { bare } = importClosure(abs);
      const allowed = new Set(['@flower/money', '@flower/uom']);
      expect([...bare].filter((b) => !allowed.has(b))).toEqual([]);
    });
  }

  it('no Checkpoint A file reaches a payment-provider port / registry, an HTTP client, Prisma, Nest or the DB package', () => {
    for (const abs of Object.values(A_FILES)) {
      const { files, bare } = importClosure(abs);
      for (const f of files) {
        expect(f, `closure of ${relative(SRC, abs)}`).not.toMatch(
          /payment-provider|provider-config|webhook|payment-attempt|refund/,
        );
      }
      for (const b of bare)
        expect(b).not.toMatch(/prisma|nestjs|@flower\/db|axios|undici|node-fetch|^pg$/);
    }
  });

  it('no provider call in code: no fetch, and none of the PaymentProvider port methods', () => {
    for (const abs of Object.values(A_FILES)) {
      const code = codeOnly(read(abs));
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(
        /\.(createIntent|authorize|capture|refund|getStatus|verifyWebhook)\s*\(/,
      );
    }
  });

  it('no inventory call: no stock / reservation / availability / inventory movement', () => {
    for (const abs of Object.values(A_FILES)) {
      expect(codeOnly(read(abs))).not.toMatch(
        /inventory|\bstock\b|reservation|availability|branch_inventory|movement/i,
      );
    }
  });

  it('the totals computation performs no DB write and no side effect: no transaction, query, create / update, number allocation, journal, audit, outbox, clock', () => {
    const code = codeOnly(read(A_FILES.canonicalTotals));
    expect(code).not.toMatch(
      /\btx\b|\$queryRaw|\$executeRaw|\.create\(|\.update\(|\.delete\(|\.upsert\(/,
    );
    expect(code).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR UPDATE/i);
    expect(code).not.toMatch(
      /postJournal|PostingEngine|AuditWriter|OutboxWriter|\baudit\b|\boutbox\b/,
    );
    expect(code).not.toMatch(/allocateNumber|document_number_counter|nextNumber/);
    expect(code).not.toMatch(/\bDate\b|Clock|Date\.now|new Date|Math\.random|process\.env/);
  });

  describe('runtime: with the clock and randomness poisoned, every pure function still returns', () => {
    afterEach(() => vi.restoreAllMocks());
    it('computeCanonicalTotals / planSale / buildWalkInSaleJournal never touch time or randomness', () => {
      vi.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('clock read');
      });
      vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('random read');
      });
      const totals = computeCanonicalTotals(
        {
          currencyCode: 'AED',
          currencyExponent: 2,
          documentDiscountAmountMinor: 0n,
          taxPriceMode: 'TAX_EXCLUSIVE',
          taxRoundingScope: 'LINE',
          taxRoundingMode: 'HALF_UP',
        },
        [
          {
            id: 'l1',
            linePosition: 1,
            quantity: '1.0000',
            unitPriceAmountMinor: 1000n,
            unitPriceCurrencyCode: 'AED',
            discountAmountMinor: 0n,
            rateBps: 500,
          },
        ],
      );
      expect(totals.totals.totalAmountMinor).toBe(1050n);
      const plan = planSale({
        intent: 'PAY_NOW',
        customerId: null,
        total: { amountMinor: 1050n, currencyCode: 'AED', currencyExponent: 2 },
        tenders: [{ method: 'CASH', amountMinor: 1050n, currencyCode: 'AED', currencyExponent: 2 }],
        advances: [],
      });
      const journal = buildWalkInSaleJournal({
        invoiceId: 'inv-1',
        customerId: null,
        currencyCode: 'AED',
        currencyExponent: 2,
        totalAmountMinor: plan.totalAmountMinor,
        taxTotalAmountMinor: totals.totals.taxTotalAmountMinor,
        tenders: plan.tenders,
      });
      expect(journal.totalDebitMinor).toBe(1050n);
    });
  });
});

describe('A6 — one canonical computation: no duplicated tax / discount formula', () => {
  const prod = productionFiles(SRC);
  const importersOf = (symbol: string): string[] =>
    prod
      .filter((f) => !/modules\/orders\/(tax-arithmetic|document-discount-allocation)\.ts$/.test(f))
      .filter((f) => new RegExp(`import[^;]*\\b${symbol}\\b[^;]*from`).test(stripComments(read(f))))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'));

  it('only canonical-totals.ts imports the line-tax and document-tax-reconciliation primitives', () => {
    expect(importersOf('exactLineTax')).toEqual(['modules/orders/canonical-totals.ts']);
    expect(importersOf('reconcileDocumentTax')).toEqual(['modules/orders/canonical-totals.ts']);
  });

  it('TaxFinalizationService holds no tax arithmetic of its own and calls the shared computation exactly once', () => {
    const src = read(join(SRC, 'modules/orders/tax-finalization.service.ts'));
    const code = codeOnly(src);
    const imports = specifiersOf(join(SRC, 'modules/orders/tax-finalization.service.ts'));
    expect(imports).toContain('./canonical-totals.js');
    expect(imports).not.toContain('./tax-arithmetic.js');
    expect(imports).not.toContain('./document-discount-allocation.js');
    expect(imports).not.toContain('@flower/money');
    expect(imports).not.toContain('@flower/uom');
    expect(code).not.toMatch(
      /exactLineTax|roundExact|reconcileDocumentTax|allocateDocumentDiscount|mulRatio|Money\b|Quantity\b/,
    );
    expect(code.match(/computeCanonicalTotals\s*\(/g)).toHaveLength(1);
  });

  it('the preview wire shape lives beside the computation it serialises (one module, one formula)', () => {
    const code = read(A_FILES.canonicalTotals);
    expect(code).toMatch(/export function computeCanonicalTotals/);
    expect(code).toMatch(/export function toOrderTotalsPreview/);
  });
});

describe('A6 — no business-type branching in the generic sale path', () => {
  it('no Checkpoint A file, and nothing under modules/sales, references a business type', () => {
    const files = [...Object.values(A_FILES), ...productionFiles(join(SRC, 'modules/sales'))];
    for (const abs of files) {
      expect(read(abs), relative(SRC, abs)).not.toMatch(/businessType|business_type|BusinessType/);
    }
  });
});

describe('A6 — no float money arithmetic', () => {
  for (const key of PURE_MONEY_FILES) {
    it(`${key}: no Number() / parseFloat / parseInt / toFixed / Math.* / decimal literal in executable code`, () => {
      const code = codeOnly(read(A_FILES[key]));
      expect(code).not.toMatch(/\bNumber\s*\(/);
      expect(code).not.toMatch(/\bparseFloat\b|\bparseInt\b|\.toFixed\s*\(|\bMath\./);
      expect(code).not.toMatch(/(?<![\w.])\d+\.\d+(?![\w.])/); // 0.5, 1.25 …
    });
  }
  it('the invoice summary does no arithmetic at all (it only formats a BigInt and a DATE)', () => {
    const code = codeOnly(read(A_FILES.invoiceSummary));
    expect(code).not.toMatch(/\bparseFloat\b|\.toFixed\s*\(|\bMath\./);
    expect(code).not.toMatch(/[^=!<>]\s[+\-*/]\s[^=]/); // no binary arithmetic operator between operands
  });
});

describe('A6 — no migration 50, no Task 3b.10, no route / module yet', () => {
  const migrationsDir = join(ROOT, 'packages/db/prisma/migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((n) => /^\d{14}_/.test(n))
    .sort();

  it('the migration chain still ends at the frozen 49th migration and no migration is a Task 3b.9 one', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(49);
    expect(migrations[48]).toBe('20261010120000_phase_3b8_currency_and_release_integrity');
    expect(
      migrations.filter((n) => /3b_?9|walk_?in_?sale|atomic_?sale|complete_?sale/i.test(n)),
    ).toEqual([]);
  });

  it('no Task 3b.10 artifact: no reporting / trial-balance code and no /reports route', () => {
    // Task 3b.10 (approved after the 3b.9 merge) owns `modules/reporting/`; this 3b.9 pin keeps guarding
    // everything else — no reporting / trial-balance artifact OUTSIDE that read-only module.
    const files = productionFiles(SRC);
    expect(
      files.filter(
        (f) =>
          !/^modules\/reporting\//.test(relative(SRC, f).replace(/\\/g, '/')) &&
          /reporting|trial-?balance|3b-?10/i.test(relative(SRC, f)),
      ),
    ).toEqual([]);
    for (const f of files.filter((x) => x.endsWith('.controller.ts'))) {
      expect(read(f), relative(SRC, f)).not.toMatch(/@Controller\([^)]*reports?\b/i);
    }
  });

  it("[CHECKPOINT-A SCOPE, advanced by E] the sale's HTTP surface is exactly SalesController + SalesModule, registered once; the Order controller itself learned no sale route", () => {
    const salesFiles = walk(join(SRC, 'modules/sales'));
    expect(
      salesFiles
        .filter((f) => /\.controller\.ts$|\.module\.ts$/.test(f))
        .map((f) => f.replace(/\\/g, '/').split('/').pop())
        .sort(),
    ).toEqual(['sales.controller.ts', 'sales.module.ts']);
    const orderController = read(join(SRC, 'modules/orders/order.controller.ts'));
    expect(orderController).not.toMatch(/complete-sale|\/totals|'totals'/);
    // registered in the root module exactly once (the import + the imports[] entry)
    expect(read(join(SRC, 'app.module.ts')).match(/\bSalesModule\b/g)).toHaveLength(2);
  });
});

describe('A6 — no anonymous cancellation / refund workaround (OD-8, release blocker RB-1)', () => {
  it('nothing under modules/sales references a credit note, refund, cancellation or void', () => {
    for (const abs of productionFiles(join(SRC, 'modules/sales'))) {
      // (`void` is also TypeScript's return type — pin the accounting concept, i.e. a
      // voided / void-sale identifier, not the keyword)
      expect(codeOnly(read(abs)), relative(SRC, abs)).not.toMatch(
        /credit_?note|refund|cancel|voided|void_?sale|\bvoid[A-Z_]/i,
      );
    }
  });

  it('Task 3b.8 is NOT reopened: a walk-in invoiced order is still refused post-invoice cancellation', () => {
    const repo = read(join(SRC, 'modules/orders/order.repository.ts'));
    expect(repo).toMatch(
      /a walk-in \(no customer\) invoiced order cannot be cancelled — credit note issuance requires a customer-linked order/,
    );
    expect(repo).toMatch(/if \(!currentOrder\.customerId\) \{/);
  });

  it('the credit-note primitive still requires a customer account (its signature is unchanged)', () => {
    const cn = read(join(SRC, 'modules/orders/credit-note.repository.ts'));
    expect(cn).toMatch(/customerCompanyAccountId: string;/);
  });
});

describe('A6 — no new permission', () => {
  it('the registry has no sale / completion / totals key and no per-task 3b.9 permission export', () => {
    const keys = [...ALL_PERMISSIONS] as string[];
    expect(keys.filter((k) => /^sales?:|^orders:(complete|totals|sale)/.test(k))).toEqual([]);
    expect(Object.keys(permissionsModule).filter((n) => /3B_9|3b9|SALES?_/i.test(n))).toEqual([]);
  });

  it('every permission-shaped literal in the Checkpoint A code is an already-registered key (there are none to add)', () => {
    const registered = new Set<string>(ALL_PERMISSIONS as readonly string[]);
    for (const abs of Object.values(A_FILES)) {
      const literals = [...stripComments(read(abs)).matchAll(/'([a-z_]+(?::[a-z_]+)+)'/g)].map(
        (m) => m[1]!,
      );
      for (const lit of literals)
        expect(registered.has(lit), `${relative(SRC, abs)}: ${lit}`).toBe(true);
    }
  });
});

describe('A6 — one authoritative net-of-discount revenue convention (OD-3, decision 3b.9-ACC)', () => {
  const invoiceAr = read(join(SRC, 'modules/receivables/customer-invoice-ar.repository.ts'));
  const creditNote = read(join(SRC, 'modules/orders/credit-note.repository.ts'));
  const walkIn = read(A_FILES.walkInJournal);

  it('invoice_ar, the credit-note journal and the walk-in journal all book REVENUE.SALES as total − tax', () => {
    expect(invoiceAr).toMatch(
      /revenueAmountMinor = input\.totalAmountMinor - input\.taxTotalAmountMinor/,
    );
    expect(creditNote).toMatch(/revenueAmountMinor = totalAmountMinor - taxTotalAmountMinor/);
    expect(walkIn).toMatch(/revenueMinor = input\.totalAmountMinor - input\.taxTotalAmountMinor/);
  });

  it('none of the three posts to a sale-time discount (contra-revenue) account', () => {
    for (const src of [invoiceAr, creditNote, walkIn]) {
      expect(codeOnly(src)).not.toMatch(/SALES_DISCOUNT|CONTRA_REVENUE/);
    }
  });

  it('the decision is recorded: DECISION-LOG row 3b.9-ACC, and CLAUDE.md rule 20 points at it', () => {
    const log = read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
    expect(log).toMatch(/\*\*3b\.9-ACC\*\*/);
    expect(log).toMatch(/net of sale-time discounts/);
    expect(log).toMatch(/amends ZF-7/);
    const claude = read(join(ROOT, 'CLAUDE.md'));
    const rule20 = claude.slice(claude.indexOf('\n20. '), claude.indexOf('\n21. '));
    expect(rule20).toMatch(/3b\.9-ACC/);
    expect(rule20).toMatch(/net-of-discount/);
  });
});

describe('A6 — the plans for the later checkpoints cannot silently disappear', () => {
  const plan = read(join(ROOT, 'docs/phase-3/TASK-3B9-PLAN.md'));

  it('every composition risk has an id, a checkpoint that must prove it and a required proof', () => {
    for (const id of ['CR-1', 'CR-2', 'CR-3', 'CR-4', 'CR-5', 'CR-6', 'CR-7']) {
      const row = plan.split('\n').find((l) => l.startsWith(`| ${id} `));
      expect(row, id).toBeTruthy();
      expect(row!.split('|').length).toBeGreaterThanOrEqual(6);
      expect(row, id).toMatch(/\|\s*(C|D|C, D)\s*\|/);
    }
    expect(plan).toMatch(
      /issuance.*synchronous capture.*ONE caller transaction|ONE caller transaction/i,
    );
    expect(plan).toMatch(/counter serialization/i);
    expect(plan).toMatch(/cancellation vs finalization race/i);
  });

  it('the release blocker RB-1 is recorded in the plan, the Phase 3B plan and the decision log — not hidden', () => {
    const phase3b = read(join(ROOT, 'docs/phase-3/PHASE-3B-PLAN.md'));
    const log = read(join(ROOT, 'docs/decisions/DECISION-LOG.md'));
    for (const doc of [plan, phase3b, log]) expect(doc).toMatch(/RB-1/);
    expect(plan).toMatch(
      /Anonymous issued-sale void \/ refund resolution must be designed and completed/,
    );
    expect(phase3b).toMatch(/## L\. Release blockers/);
  });

  it('every owner ruling OD-1 … OD-13 and the no-migration decision are recorded', () => {
    for (let n = 1; n <= 13; n += 1) {
      // String.raw keeps the backslashes (a plain template literal would turn `\|` into `|`,
      // making the pattern match the empty string and the check vacuous)
      expect(plan, `OD-${n}`).toMatch(new RegExp(String.raw`\| OD-${n}\s`));
    }
    expect(plan).toMatch(/no migration 50/i);
  });
});
